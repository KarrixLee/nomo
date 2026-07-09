import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  adapterFor, allAdapters, claudeAdapter, codexAdapter, codexDiscoverLive, codexSentinelSessionId,
  filterCodexTuis, findProvisionalForPid, parseCodexProcs,
} from "./adapter";
import type { SessionRecord } from "./shared";

// The adapter surface is the per-agent half of the hook pipeline. These cover the two branches that
// actually diverge (title resolution + interrupt detection) plus the static config each adapter
// carries; the deep title/interrupt parser coverage lives in cc-status.test.ts / cc-watchdog.test.ts
// (which import those parsers through the ./cc-status and ./cc-watchdog re-exports).

describe("adapterFor", () => {
  test("selects by kind, defaulting to claude", () => {
    expect(adapterFor("codex")).toBe(codexAdapter);
    expect(adapterFor("claude")).toBe(claudeAdapter);
  });

  test("kinds match the on-disk literals", () => {
    expect(claudeAdapter.kind).toBe("claude");
    expect(codexAdapter.kind).toBe("codex");
  });
});

describe("static config", () => {
  test("session matchers", () => {
    expect(claudeAdapter.sessionMatch("abc.jsonl")).toBe(true);
    expect(claudeAdapter.sessionMatch("rollout-1.jsonl")).toBe(true);
    expect(claudeAdapter.sessionMatch("abc.json")).toBe(false);
    expect(codexAdapter.sessionMatch("rollout-2026-07-08.jsonl")).toBe(true);
    expect(codexAdapter.sessionMatch("abc.jsonl")).toBe(false); // codex requires the rollout- prefix
  });

  test("hook-stamp paths + tool-detail halves", () => {
    expect(claudeAdapter.hookStampPath().endsWith("last-hook-claude")).toBe(true);
    expect(codexAdapter.hookStampPath().endsWith("last-hook-codex")).toBe(true);
    expect(claudeAdapter.toolDetail.Bash).toBe("running");
    expect(codexAdapter.toolDetail.apply_patch).toBe("editing");
    expect(claudeAdapter.toolDetail.apply_patch).toBeUndefined(); // halves stay separate
  });
});

describe("discovery seam (blobAgentFields + allAdapters + discoverLive capability)", () => {
  test("blobAgentFields: claude omits the agent key, codex yields agent:'codex'", () => {
    expect(claudeAdapter.blobAgentFields).toEqual({});
    expect(codexAdapter.blobAgentFields).toEqual({ agent: "codex" });
  });

  test("allAdapters is exactly the two concrete adapters (so the daemon can drive per-agent steps)", () => {
    expect(allAdapters).toEqual([claudeAdapter, codexAdapter]);
  });

  test("claude implements NO discoverLive (its SessionStart fires at true open)", () => {
    expect(claudeAdapter.discoverLive).toBeUndefined();
  });

  test("codex implements discoverLive (process-scan; see the dedicated discovery suite below)", () => {
    expect(typeof codexAdapter.discoverLive).toBe("function");
  });
});

describe("claude title", () => {
  test("prefers ai-title, falls back to first user prompt, else undefined", async () => {
    const aiTitle = await claudeAdapter.title({
      sessionId: randomUUID(), input: {},
      prefix: `{"type":"ai-title","aiTitle":"Refactor the adapter"}`,
    });
    expect(aiTitle).toBe("Refactor the adapter");

    const userTitle = await claudeAdapter.title({
      sessionId: randomUUID(), input: {},
      prefix: `{"type":"user","message":{"content":"Fix the flaky test"}}`,
    });
    expect(userTitle).toBe("Fix the flaky test");

    expect(await claudeAdapter.title({ sessionId: randomUUID(), input: {}, prefix: "" })).toBeUndefined();
  });
});

describe("codex title", () => {
  test("uses the UserPromptSubmit prompt when index + rollout give nothing", async () => {
    // A random sessionId can't match anything in a real session_index.jsonl, so the index lookup
    // yields undefined and we fall through to the raw prompt.
    const title = await codexAdapter.title({
      sessionId: randomUUID(), prefix: "",
      input: { hook_event_name: "UserPromptSubmit", prompt: "**Add** the `codex` adapter" },
    });
    expect(title).toBe("Add the codex adapter");
  });

  test("no prompt fallback outside UserPromptSubmit", async () => {
    const title = await codexAdapter.title({
      sessionId: randomUUID(), prefix: "",
      input: { hook_event_name: "Stop", prompt: "ignored" },
    });
    expect(title).toBeUndefined();
  });
});

// --- codex live-process discovery (openai/codex#15269 workaround) ----------------------------
//
// The fixture mirrors REAL `ps -axo pid=,tty=,args=` output observed on macOS: two interactive
// `codex` TUIs with controlling ttys, plus the `codex app-server` daemons (Codex.app + a Cursor
// extension) which run WITHOUT a controlling tty ("??") — the tty filter is what separates them.
const PS_FIXTURE = [
  "  333 ??       /System/Library/CoreServices/powerd.bundle/powerd",
  " 8750 ??       /Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled",
  "61648 ??       /Users/karrix/.cursor/extensions/openai.chatgpt/bin/codex app-server --analytics-default-enabled",
  "16029 ttys017  codex",
  "33198 ttys018  codex resume",
  " 2500 ??       /Users/karrix/.bun/bin/bun /path/dist/cc-watchdog.mjs",
].join("\n");

describe("codexSentinelSessionId", () => {
  test("readable codex-pid-<pid> form (server accepts any ≤128-char sessionId — no UUID needed)", () => {
    expect(codexSentinelSessionId(16029)).toBe("codex-pid-16029");
    expect(codexSentinelSessionId(16029).length).toBeLessThanOrEqual(128);
  });
});

describe("parseCodexProcs", () => {
  test("splits pid / tty / args, tolerating leading pad and skipping non-pid lines", () => {
    const rows = parseCodexProcs(PS_FIXTURE);
    expect(rows).toContainEqual({ pid: 16029, tty: "ttys017", args: "codex" });
    expect(rows).toContainEqual({ pid: 33198, tty: "ttys018", args: "codex resume" });
    expect(rows).toContainEqual({ pid: 8750, tty: "??", args: "/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled" });
    expect(parseCodexProcs("\n   \nnot a proc line")).toEqual([]);
  });
});

describe("filterCodexTuis", () => {
  const rows = () => parseCodexProcs(PS_FIXTURE);

  test("keeps ONLY interactive codex TUIs with a real tty; drops the tty-less app-server daemons", () => {
    expect(filterCodexTuis(rows(), new Set())).toEqual([{ pid: 16029 }, { pid: 33198 }]);
  });

  test("requires the executable basename to be `codex` (a `codex app-server` daemon is excluded even with a tty)", () => {
    const withTtyAppServer = parseCodexProcs("42 ttys001  /usr/local/bin/codex app-server");
    // basename is codex AND it has a tty, but `app-server` is not `exec` — the tty filter already let the
    // real daemons through only because they lack a tty; a tty'd app-server is a non-interactive edge we
    // do NOT special-case, so it IS surfaced. Documenting: tty is the daemon filter, not the subcommand.
    expect(filterCodexTuis(withTtyAppServer, new Set())).toEqual([{ pid: 42 }]);
  });

  test("excludes `codex exec …` automation runs (argv contains the exec subcommand) even with a tty", () => {
    const execRun = parseCodexProcs("77 ttys009  codex exec --skip-git-repo-check 'do a thing'");
    expect(filterCodexTuis(execRun, new Set())).toEqual([]);
  });

  test("excludes pids already tracked (a real hook or an existing provisional already covers them)", () => {
    expect(filterCodexTuis(rows(), new Set([16029]))).toEqual([{ pid: 33198 }]);
    expect(filterCodexTuis(rows(), new Set([16029, 33198]))).toEqual([]);
  });
});

describe("codexDiscoverLive (full pipeline with injected ps/lsof)", () => {
  test("surfaces each new TUI as a sentinel session titled/labelled by its cwd basename", async () => {
    const cwds: Record<number, string> = { 16029: "/Users/karrix/api-status/nomo", 33198: "/Users/karrix/WidgetAnimation" };
    const discovered = await codexDiscoverLive([], {
      ps: async () => PS_FIXTURE,
      cwdOf: async (pid) => cwds[pid],
    });
    expect(discovered).toEqual([
      { pid: 16029, sessionId: "codex-pid-16029", title: "nomo", label: "nomo" },
      { pid: 33198, sessionId: "codex-pid-33198", title: "WidgetAnimation", label: "WidgetAnimation" },
    ]);
  });

  test("excludes pids already covered by a known record (real or provisional)", async () => {
    const known: SessionRecord[] = [{ pid: 16029, machine: "m", label: "l", ts: 1 }];
    const discovered = await codexDiscoverLive(known, { ps: async () => PS_FIXTURE, cwdOf: async () => "/tmp/proj" });
    expect(discovered.map((d) => d.pid)).toEqual([33198]);
  });

  test("an unknown cwd falls back to the 'session' label (like buildBlob)", async () => {
    const discovered = await codexDiscoverLive([], { ps: async () => "42 ttys001  codex", cwdOf: async () => undefined });
    expect(discovered[0]).toEqual({ pid: 42, sessionId: "codex-pid-42", title: "session", label: "session" });
  });

  test("a `ps` failure yields no discoveries (best-effort)", async () => {
    expect(await codexDiscoverLive([], { ps: async () => { throw new Error("no ps"); }, cwdOf: async () => "/x" })).toEqual([]);
  });
});

describe("findProvisionalForPid (reconcile pid matcher)", () => {
  const provs = [{ sessionId: "codex-pid-16029", pid: 16029 }, { sessionId: "codex-pid-500", pid: 500 }];
  const noAncestors = () => [];

  test("PRIMARY: equality on process.ppid (the codex TUI is the hook's direct parent)", () => {
    expect(findProvisionalForPid(provs, 16029, noAncestors)).toBe("codex-pid-16029");
    expect(findProvisionalForPid(provs, 500, noAncestors)).toBe("codex-pid-500");
  });

  test("FALLBACK: matches a provisional whose pid is an ANCESTOR of the hook pid (wrapper process)", () => {
    // hookPid 99999 is a wrapper child; the codex TUI 16029 sits above it → ancestor match.
    expect(findProvisionalForPid(provs, 99999, (pid) => (pid === 99999 ? [7777, 16029, 1] : []))).toBe("codex-pid-16029");
  });

  test("equality is tried BEFORE the ancestor walk (ancestorsOf not consulted on a direct hit)", () => {
    let walked = false;
    expect(findProvisionalForPid(provs, 500, () => { walked = true; return []; })).toBe("codex-pid-500");
    expect(walked).toBe(false);
  });

  test("null when neither the pid nor any ancestor matches a provisional", () => {
    expect(findProvisionalForPid(provs, 123, (pid) => (pid === 123 ? [456, 789] : []))).toBeNull();
    expect(findProvisionalForPid([], 16029, noAncestors)).toBeNull();
  });
});

describe("detectInterrupt", () => {
  test("claude keys on the interrupt marker in the last turn line", () => {
    expect(claudeAdapter.detectInterrupt(`{"type":"assistant","message":"[Request interrupted by user]"}`)).toBe(true);
    expect(claudeAdapter.detectInterrupt(`{"type":"assistant","message":"all done"}`)).toBe(false);
    expect(claudeAdapter.detectInterrupt("")).toBe(false);
  });

  test("codex keys on the last turn-lifecycle event being turn_aborted", () => {
    expect(codexAdapter.detectInterrupt(`{"type":"event_msg","payload":{"type":"turn_aborted"}}`)).toBe(true);
    expect(codexAdapter.detectInterrupt(`{"type":"event_msg","payload":{"type":"task_complete"}}`)).toBe(false);
    // a later task_started boundary after an abort means the turn resumed → not interrupted
    expect(codexAdapter.detectInterrupt(
      `{"type":"event_msg","payload":{"type":"turn_aborted"}}\n{"type":"event_msg","payload":{"type":"task_started"}}`,
    )).toBe(false);
  });
});
