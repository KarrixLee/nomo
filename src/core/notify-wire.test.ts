import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  isNomoNotifyChain, nomoNotifyProgram, parseNotifyFromToml, repairNotifyWiring, replaceNotifyInToml,
  tomlMayNeedNotifyRepair, unwrapNotify, wireNotifyArray,
} from "./notify-wire";

// notify-wire is the Bug-D fix: pairing used to instruct the agent to hand-edit config.toml, which
// re-wrapped an already-wrapped notify on every re-pair. These pin the idempotent unwrap→wrap cycle,
// including the EXACT triple-nested value observed in the wild on 2026-07-10.

const ROOT = "/Users/karrix/api-status/nomo/plugin";
// The LEGACY (≤1.7.8) wrapper: two paths inside the version-pinned plugin root. Still exercised
// everywhere below, because every existing user's config.toml is in exactly this shape.
const CHAIN = `${ROOT}/scripts/notify-chain.sh`;
const MJS = `${ROOT}/dist/codex-notify.mjs`;
// The STABLE (≥1.7.9) wrapper: the shim, which no version bump can move.
const HOME = "/Users/karrix";
const PROGRAM = nomoNotifyProgram(HOME);
const ENTRY = "codex-notify";
const SKY = "/Users/karrix/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";

describe("isNomoNotifyChain", () => {
  test("keys on the chain script basename", () => {
    expect(isNomoNotifyChain([CHAIN, MJS])).toBe(true);
    expect(isNomoNotifyChain(["/other/notify-chain.sh"])).toBe(true);
    expect(isNomoNotifyChain([SKY, "turn-ended"])).toBe(false);
    expect(isNomoNotifyChain([])).toBe(false);
  });

  test("recognises the STABLE shim form too (or repairs would nest, not replace)", () => {
    expect(isNomoNotifyChain([PROGRAM, ENTRY])).toBe(true);
    expect(isNomoNotifyChain([PROGRAM, ENTRY, "--", SKY, "turn-ended"])).toBe(true);
    // The shim without our entry name is somebody else's business.
    expect(isNomoNotifyChain([PROGRAM, "cc-status"])).toBe(false);
    expect(isNomoNotifyChain([PROGRAM])).toBe(false);
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

describe("wireNotifyArray (idempotent, and version-stable)", () => {
  // THE BUG THIS PINS (v1.7.9): the value used to be two paths inside the version-pinned plugin root,
  // baked into a config.toml nothing ever rewrites — so the backstop died at the first plugin update
  // and stayed dead. Nothing it emits may contain the plugin root any more.
  test("NO VERSION-PINNED SEGMENT: the value names only the stable shim", () => {
    for (const value of [
      wireNotifyArray(undefined, PROGRAM),
      wireNotifyArray([SKY, "turn-ended"], PROGRAM),
      wireNotifyArray([CHAIN, MJS, "--", SKY, "turn-ended"], PROGRAM),
    ]) {
      expect(value.join(" ")).not.toContain("/plugin/");
      expect(value.join(" ")).not.toContain("notify-chain.sh");
      expect(value.join(" ")).not.toContain(".mjs");
      expect(value.join(" ")).not.toContain("plugins/cache");
      expect(value[0]).toBe(PROGRAM);
      expect(value[1]).toBe(ENTRY);
    }
  });

  test("no existing notify → nomo-only chain", () => {
    expect(wireNotifyArray(undefined, PROGRAM)).toEqual([PROGRAM, ENTRY]);
    expect(wireNotifyArray([], PROGRAM)).toEqual([PROGRAM, ENTRY]);
  });

  test("wraps a plain original once", () => {
    expect(wireNotifyArray([SKY, "turn-ended"], PROGRAM)).toEqual([PROGRAM, ENTRY, "--", SKY, "turn-ended"]);
  });

  test("IDEMPOTENT: wiring its own output changes nothing", () => {
    const once = wireNotifyArray([SKY, "turn-ended"], PROGRAM);
    expect(wireNotifyArray(once, PROGRAM)).toEqual(once);
    const nomoOnly = wireNotifyArray(undefined, PROGRAM);
    expect(wireNotifyArray(nomoOnly, PROGRAM)).toEqual(nomoOnly);
  });

  test("a LEGACY versioned wrapping is re-pointed in place, preserving the original (no nesting)", () => {
    expect(wireNotifyArray([CHAIN, MJS, "--", SKY, "turn-ended"], PROGRAM))
      .toEqual([PROGRAM, ENTRY, "--", SKY, "turn-ended"]);
    // …and a legacy nomo-ONLY wrapping collapses to a stable nomo-only wrapping.
    expect(wireNotifyArray([CHAIN, MJS], PROGRAM)).toEqual([PROGRAM, ENTRY]);
  });

  test("re-pairing under a DIFFERENT home refreshes the program path in place", () => {
    const other = wireNotifyArray([SKY, "turn-ended"], nomoNotifyProgram("/Users/someone-else"));
    expect(wireNotifyArray(other, PROGRAM)).toEqual([PROGRAM, ENTRY, "--", SKY, "turn-ended"]);
  });

  test("collapses the observed triple nest to one clean wrap", () => {
    const innermostNomo = JSON.stringify([
      "/Users/karrix/.codex/.tmp/marketplaces/nomo/plugin/scripts/notify-chain.sh",
      "/Users/karrix/.codex/.tmp/marketplaces/nomo/plugin/dist/codex-notify.mjs",
      "--", SKY, "turn-ended",
    ]);
    const middle = JSON.stringify([CHAIN, MJS, "--", SKY, "turn-ended", "--previous-notify", innermostNomo]);
    const observed = [CHAIN, MJS, "--", SKY, "turn-ended", "--previous-notify", middle];
    expect(wireNotifyArray(observed, PROGRAM)).toEqual([PROGRAM, ENTRY, "--", SKY, "turn-ended"]);
  });

  test("a STABLE chain re-embedded under a host's --previous-notify still unwraps", () => {
    const embedded = JSON.stringify([PROGRAM, ENTRY, "--", SKY, "turn-ended"]);
    expect(wireNotifyArray([SKY, "turn-ended", "--previous-notify", embedded], PROGRAM))
      .toEqual([PROGRAM, ENTRY, "--", SKY, "turn-ended"]);
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SELF-REPAIR (repairNotifyWiring) — the half of the v1.7.9 fix that reaches users who never re-pair.
// These drive real files in a throwaway home, because the contract is as much about WHAT IS NOT
// WRITTEN (backups, byte-identity, unrelated keys) as about the value itself.

describe("repairNotifyWiring", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** A throwaway home + a config.toml with realistic surrounding keys, tables and comments. */
  async function scratch(notifyLine: string | null): Promise<{ home: string; tomlPath: string; program: string }> {
    const home = await mkdtemp(join(tmpdir(), "nomo-notify-"));
    dirs.push(home);
    const tomlPath = join(home, "config.toml");
    const body = [
      "# Codex config",
      'model = "gpt-5.4-codex"',
      'model_reasoning_effort = "high"',
      ...(notifyLine === null ? [] : [notifyLine]),
      "",
      "[tui]",
      "notifications = true",
      "",
      "[mcp_servers.example]",
      'command = "npx"',
      "",
    ].join("\n");
    await writeFile(tomlPath, body);
    return { home, tomlPath, program: nomoNotifyProgram(home) };
  }

  const notifyLine = (arr: readonly string[]): string => `notify = ${JSON.stringify(arr)}`;
  const readNotify = async (p: string): Promise<string[] | null> =>
    parseNotifyFromToml(await readFile(p, "utf8")).value;

  test("a config wired to a now-deleted VERSIONED path is rewritten to the stable form", async () => {
    // Exactly what every ≤1.7.8 Codex user has, with a plugin root that no longer exists.
    const dead = "/Users/x/.codex/plugins/cache/nomo/nomo/1.7.7/scripts/notify-chain.sh";
    const deadMjs = "/Users/x/.codex/plugins/cache/nomo/nomo/1.7.7/dist/codex-notify.mjs";
    const { tomlPath, home, program } = await scratch(notifyLine([dead, deadMjs]));

    expect(await repairNotifyWiring({ tomlPath, home })).toBe("repaired");
    expect(await readNotify(tomlPath)).toEqual([program, "codex-notify"]);
    const after = await readFile(tomlPath, "utf8");
    expect(after).not.toContain("plugins/cache");
    // Unrelated keys, tables and comments survive.
    expect(after).toContain("# Codex config");
    expect(after).toContain('model_reasoning_effort = "high"');
    expect(after).toContain("[mcp_servers.example]");
    expect(after).toContain("notifications = true");
  });

  test("a 0600 config.toml (may hold MCP keys) keeps 0600 after the repair rewrite", async () => {
    const dead = "/Users/x/.codex/plugins/cache/nomo/nomo/1.7.7/scripts/notify-chain.sh";
    const deadMjs = "/Users/x/.codex/plugins/cache/nomo/nomo/1.7.7/dist/codex-notify.mjs";
    const { tomlPath, home } = await scratch(notifyLine([dead, deadMjs]));
    await chmod(tomlPath, 0o600);

    expect(await repairNotifyWiring({ tomlPath, home })).toBe("repaired");
    // The rewritten config and the backup both keep the private mode — atomicWrite's rename would have
    // dropped it to 0644 without an explicit mode arg.
    expect((await stat(tomlPath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${tomlPath}.bak-nomo`)).mode & 0o777).toBe(0o600);
  });

  test("a non-nomo previous-notify payload survives VERBATIM through the repair", async () => {
    const dead = "/Users/x/.codex/plugins/cache/nomo/nomo/1.7.7/scripts/notify-chain.sh";
    const deadMjs = "/Users/x/.codex/plugins/cache/nomo/nomo/1.7.7/dist/codex-notify.mjs";
    const { tomlPath, home, program } = await scratch(notifyLine([dead, deadMjs, "--", SKY, "turn-ended"]));

    expect(await repairNotifyWiring({ tomlPath, home })).toBe("repaired");
    expect(await readNotify(tomlPath)).toEqual([program, "codex-notify", "--", SKY, "turn-ended"]);
  });

  test("THE SHAPE ON THE DEV MACHINE: nomo re-embedded under a host's --previous-notify", async () => {
    // The computer-use client makes ITSELF the outer program and re-embeds the previous notify as an
    // escaped JSON string. The nomo layer in there is the version-pinned one that has to go.
    const embedded = JSON.stringify([CHAIN, MJS, "--", SKY, "turn-ended"]);
    const { tomlPath, home, program } = await scratch(notifyLine([SKY, "turn-ended", "--previous-notify", embedded]));

    expect(await repairNotifyWiring({ tomlPath, home })).toBe("repaired");
    // Nomo goes back to the outside, still chaining the host command — the same collapse a re-pair does.
    expect(await readNotify(tomlPath)).toEqual([program, "codex-notify", "--", SKY, "turn-ended"]);
  });

  test("ALREADY CORRECT: byte-identical file, no write, no backup", async () => {
    const home = await mkdtemp(join(tmpdir(), "nomo-notify-"));
    dirs.push(home);
    const tomlPath = join(home, "config.toml");
    const program = nomoNotifyProgram(home);
    const body = `model = "gpt"\n${notifyLine([program, "codex-notify", "--", SKY, "turn-ended"])}\n`;
    await writeFile(tomlPath, body);
    const before = await stat(tomlPath);
    await new Promise((r) => setTimeout(r, 20));

    expect(await repairNotifyWiring({ tomlPath, home })).toBe("unchanged");
    expect(await readFile(tomlPath, "utf8")).toBe(body);
    expect((await stat(tomlPath)).mtimeMs).toBe(before.mtimeMs);   // not rewritten at all
    await expect(stat(`${tomlPath}.bak-nomo`)).rejects.toThrow();  // and nothing to back up
  });

  test("IDEMPOTENT: a second and third pass after a repair change nothing", async () => {
    const dead = "/Users/x/.codex/plugins/cache/nomo/nomo/1.7.7/scripts/notify-chain.sh";
    const { tomlPath, home } = await scratch(notifyLine([dead, `${dead}.mjs`, "--", SKY, "turn-ended"]));
    expect(await repairNotifyWiring({ tomlPath, home })).toBe("repaired");
    const repaired = await readFile(tomlPath, "utf8");
    const mtime = (await stat(tomlPath)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));

    expect(await repairNotifyWiring({ tomlPath, home })).toBe("unchanged");
    expect(await repairNotifyWiring({ tomlPath, home })).toBe("unchanged");
    expect(await readFile(tomlPath, "utf8")).toBe(repaired);
    expect((await stat(tomlPath)).mtimeMs).toBe(mtime);
  });

  test("the pre-change file is BACKED UP to config.toml.bak-nomo, once and only once", async () => {
    const dead = "/Users/x/.codex/plugins/cache/nomo/nomo/1.7.7/scripts/notify-chain.sh";
    const { tomlPath, home } = await scratch(notifyLine([dead, `${dead}.mjs`]));
    const original = await readFile(tomlPath, "utf8");

    expect(await repairNotifyWiring({ tomlPath, home })).toBe("repaired");
    expect(await readFile(`${tomlPath}.bak-nomo`, "utf8")).toBe(original);

    // A LATER repair (home moved) must not overwrite the first backup — that one is the original.
    const elsewhere = await mkdtemp(join(tmpdir(), "nomo-notify-"));
    dirs.push(elsewhere);
    expect(await repairNotifyWiring({ tomlPath, home: elsewhere })).toBe("repaired");
    expect(await readFile(`${tomlPath}.bak-nomo`, "utf8")).toBe(original);
    expect(await readNotify(tomlPath)).toEqual([nomoNotifyProgram(elsewhere), "codex-notify"]);
  });

  test("REFUSES a notify nomo did not author — repair is not wiring", async () => {
    // A hook-shim.sh mention with no codex-notify entry: not our notify, and pairing never happened.
    const { tomlPath, home } = await scratch(notifyLine(["/opt/some-tool/hook-shim.sh", "--flag"]));
    const before = await readFile(tomlPath, "utf8");
    expect(await repairNotifyWiring({ tomlPath, home })).toBe("refused");
    expect(await readFile(tomlPath, "utf8")).toBe(before);
  });

  test("REFUSES an unparseable notify rather than corrupting it", async () => {
    const home = await mkdtemp(join(tmpdir(), "nomo-notify-"));
    dirs.push(home);
    const tomlPath = join(home, "config.toml");
    const body = 'notify = [\n  "/old/scripts/notify-chain.sh",\n  "/old/dist/codex-notify.mjs",\n]\n';
    await writeFile(tomlPath, body);
    expect(await repairNotifyWiring({ tomlPath, home })).toBe("refused");
    expect(await readFile(tomlPath, "utf8")).toBe(body);
  });

  test("no notify at all, and no config.toml at all, are both silent no-ops", async () => {
    const { tomlPath, home } = await scratch(null);
    const before = await readFile(tomlPath, "utf8");
    expect(await repairNotifyWiring({ tomlPath, home })).toBe("unchanged");
    expect(await readFile(tomlPath, "utf8")).toBe(before);
    expect(await repairNotifyWiring({ tomlPath: join(home, "nope.toml"), home })).toBe("unchanged");
  });

  test("THE CHEAP GATE short-circuits before any parse, and never fights another installer", () => {
    const program = nomoNotifyProgram("/Users/karrix");
    expect(tomlMayNeedNotifyRepair("", program)).toBe(false);
    expect(tomlMayNeedNotifyRepair('model = "gpt"\nnotify = ["/usr/bin/say", "hi"]\n', program)).toBe(false);
    expect(tomlMayNeedNotifyRepair(`notify = ["${CHAIN}"]`, program)).toBe(true);          // legacy
    expect(tomlMayNeedNotifyRepair(`notify = ["${program}","codex-notify"]`, program)).toBe(false);
    expect(tomlMayNeedNotifyRepair('notify = ["/other/home/.config/cc-status/hook-shim.sh","codex-notify"]', program)).toBe(true);
    // An ALREADY-STABLE nomo re-embedded by a host that escapes its slashes must NOT read as stale:
    // that would hoist it back out on every single session start, forever. These are the RAW bytes
    // such a line has on disk — a JSON array inside a TOML basic string, so every "/" arrives as "\\/"
    // (the exact double escaping the computer-use client writes; see config.toml on the dev machine).
    const escaped = 'notify = ["/opt/host", "turn-ended", "--previous-notify", '
      + '"[\\"\\\\/Users\\\\/karrix\\\\/.config\\\\/cc-status\\\\/hook-shim.sh\\",\\"codex-notify\\"]"]';
    expect(escaped).toContain("\\\\/Users");
    expect(tomlMayNeedNotifyRepair(escaped, program)).toBe(false);
  });
});
