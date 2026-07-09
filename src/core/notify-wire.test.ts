import { describe, expect, test } from "bun:test";
import { isNomoNotifyChain, parseNotifyFromToml, replaceNotifyInToml, unwrapNotify, wireNotifyArray } from "./notify-wire";

// notify-wire is the Bug-D fix: pairing used to instruct the agent to hand-edit config.toml, which
// re-wrapped an already-wrapped notify on every re-pair. These pin the idempotent unwrap→wrap cycle,
// including the EXACT triple-nested value observed in the wild on 2026-07-10.

const ROOT = "/Users/karrix/api-status/nomo/plugin";
const CHAIN = `${ROOT}/scripts/notify-chain.sh`;
const MJS = `${ROOT}/dist/codex-notify.mjs`;
const SKY = "/Users/karrix/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";

describe("isNomoNotifyChain", () => {
  test("keys on the chain script basename", () => {
    expect(isNomoNotifyChain([CHAIN, MJS])).toBe(true);
    expect(isNomoNotifyChain(["/other/notify-chain.sh"])).toBe(true);
    expect(isNomoNotifyChain([SKY, "turn-ended"])).toBe(false);
    expect(isNomoNotifyChain([])).toBe(false);
  });
});

describe("unwrapNotify", () => {
  test("non-nomo notify passes through unchanged", () => {
    expect(unwrapNotify([SKY, "turn-ended"])).toEqual([SKY, "turn-ended"]);
  });

  test("a nomo-only chain wraps nothing", () => {
    expect(unwrapNotify([CHAIN, MJS])).toBeNull();
  });

  test("a single nomo wrap yields the original", () => {
    expect(unwrapNotify([CHAIN, MJS, "--", SKY, "turn-ended"])).toEqual([SKY, "turn-ended"]);
  });

  test("nomo-in-nomo double wrap collapses to the original", () => {
    expect(unwrapNotify([CHAIN, MJS, "--", CHAIN, MJS, "--", SKY, "turn-ended"])).toEqual([SKY, "turn-ended"]);
  });

  test("a host command whose --previous-notify re-embeds nomo drops the re-entry", () => {
    const embedded = JSON.stringify([CHAIN, MJS, "--", SKY, "turn-ended"]);
    expect(unwrapNotify([SKY, "turn-ended", "--previous-notify", embedded])).toEqual([SKY, "turn-ended"]);
  });

  test("a --previous-notify that unwraps to a DIFFERENT command is preserved, unwrapped", () => {
    const embedded = JSON.stringify([CHAIN, MJS, "--", "/usr/local/bin/other-notify", "arg"]);
    expect(unwrapNotify([SKY, "turn-ended", "--previous-notify", embedded]))
      .toEqual([SKY, "turn-ended", "--previous-notify", JSON.stringify(["/usr/local/bin/other-notify", "arg"])]);
  });

  test("a non-nomo --previous-notify is left alone", () => {
    const embedded = JSON.stringify(["/usr/bin/say", "done"]);
    expect(unwrapNotify([SKY, "turn-ended", "--previous-notify", embedded]))
      .toEqual([SKY, "turn-ended", "--previous-notify", embedded]);
  });

  test("an unparseable nomo-referencing --previous-notify is dropped, not kept broken", () => {
    expect(unwrapNotify([SKY, "turn-ended", "--previous-notify", "[notify-chain.sh oops"]))
      .toEqual([SKY, "turn-ended"]);
  });

  test("THE observed triple nest (nomo → Sky --previous-notify(nomo → Sky --previous-notify(old-nomo → Sky)))", () => {
    const innermostNomo = JSON.stringify([
      "/Users/karrix/.codex/.tmp/marketplaces/nomo/plugin/scripts/notify-chain.sh",
      "/Users/karrix/.codex/.tmp/marketplaces/nomo/plugin/dist/codex-notify.mjs",
      "--", SKY, "turn-ended",
    ]);
    const middle = JSON.stringify([CHAIN, MJS, "--", SKY, "turn-ended", "--previous-notify", innermostNomo]);
    const observed = [CHAIN, MJS, "--", SKY, "turn-ended", "--previous-notify", middle];
    expect(unwrapNotify(observed)).toEqual([SKY, "turn-ended"]);
  });
});

describe("wireNotifyArray (idempotent)", () => {
  test("no existing notify → nomo-only chain", () => {
    expect(wireNotifyArray(undefined, ROOT)).toEqual([CHAIN, MJS]);
    expect(wireNotifyArray([], ROOT)).toEqual([CHAIN, MJS]);
  });

  test("wraps a plain original once", () => {
    expect(wireNotifyArray([SKY, "turn-ended"], ROOT)).toEqual([CHAIN, MJS, "--", SKY, "turn-ended"]);
  });

  test("IDEMPOTENT: wiring its own output changes nothing", () => {
    const once = wireNotifyArray([SKY, "turn-ended"], ROOT);
    expect(wireNotifyArray(once, ROOT)).toEqual(once);
    const nomoOnly = wireNotifyArray(undefined, ROOT);
    expect(wireNotifyArray(nomoOnly, ROOT)).toEqual(nomoOnly);
  });

  test("re-pairing from a DIFFERENT root refreshes the chain paths in place (no nesting)", () => {
    const oldRootChain = wireNotifyArray([SKY, "turn-ended"], "/Users/karrix/.codex/.tmp/marketplaces/nomo/plugin");
    expect(wireNotifyArray(oldRootChain, ROOT)).toEqual([CHAIN, MJS, "--", SKY, "turn-ended"]);
  });

  test("collapses the observed triple nest to one clean wrap", () => {
    const innermostNomo = JSON.stringify([
      "/Users/karrix/.codex/.tmp/marketplaces/nomo/plugin/scripts/notify-chain.sh",
      "/Users/karrix/.codex/.tmp/marketplaces/nomo/plugin/dist/codex-notify.mjs",
      "--", SKY, "turn-ended",
    ]);
    const middle = JSON.stringify([CHAIN, MJS, "--", SKY, "turn-ended", "--previous-notify", innermostNomo]);
    const observed = [CHAIN, MJS, "--", SKY, "turn-ended", "--previous-notify", middle];
    expect(wireNotifyArray(observed, ROOT)).toEqual([CHAIN, MJS, "--", SKY, "turn-ended"]);
  });
});

describe("parseNotifyFromToml / replaceNotifyInToml", () => {
  test("absent notify", () => {
    expect(parseNotifyFromToml('model = "gpt"\n\n[table]\nx = 1\n')).toEqual({ present: false, value: null });
  });

  test("parses a top-level single-line string array (JSON-compatible TOML escapes included)", () => {
    const toml = `model = "gpt"\nnotify = ["${SKY.replaceAll("\\", "\\\\")}", "turn-ended"]\n\n[table]\n`;
    expect(parseNotifyFromToml(toml)).toEqual({ present: true, value: [SKY, "turn-ended"] });
  });

  test("a notify key inside a table is NOT the top-level notify", () => {
    expect(parseNotifyFromToml('[desktop]\nnotify = ["x"]\n')).toEqual({ present: false, value: null });
  });

  test("present-but-unparseable is flagged so callers refuse to rewrite", () => {
    expect(parseNotifyFromToml("notify = [\n  \"multi\",\n  \"line\",\n]\n")).toEqual({ present: true, value: null });
    expect(parseNotifyFromToml("notify = { a = 1 }\n")).toEqual({ present: true, value: null });
  });

  test("replace rewrites the existing top-level line in place", () => {
    const toml = 'model = "gpt"\nnotify = ["old"]\n\n[table]\nnotify = ["keep-me"]\n';
    const out = replaceNotifyInToml(toml, ["new", "value"]);
    expect(out).toContain('notify = ["new","value"]');
    expect(out).not.toContain('notify = ["old"]');
    expect(out).toContain('notify = ["keep-me"]'); // table-scoped keys untouched
  });

  test("insert lands BEFORE the first table (root keys must precede tables)", () => {
    const out = replaceNotifyInToml('model = "gpt"\n\n[table]\nx = 1\n', ["a"]);
    expect(out.indexOf('notify = ["a"]')).toBeLessThan(out.indexOf("[table]"));
    expect(parseNotifyFromToml(out)).toEqual({ present: true, value: ["a"] });
  });

  test("insert appends when there are no tables (and on an empty file)", () => {
    expect(parseNotifyFromToml(replaceNotifyInToml('model = "gpt"', ["a"]))).toEqual({ present: true, value: ["a"] });
    expect(replaceNotifyInToml("", ["a"])).toBe('notify = ["a"]\n');
  });

  test("round-trip: replace then parse yields the exact array", () => {
    const arr = [CHAIN, MJS, "--", SKY, "turn-ended"];
    expect(parseNotifyFromToml(replaceNotifyInToml("", arr))).toEqual({ present: true, value: arr });
  });
});
