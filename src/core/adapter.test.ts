import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  adapterFor, allAdapters, claudeAdapter, codexAdapter, codexChildSessionGhost, codexDiscoverLive,
  codexSentinelSessionId, codexTailPendingApproval, filterCodexTuis, findProvisionalForPid,
  firstUserPrompt, parseCodexProcs, sessionTitle, TrackedSessionLite,
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

// --- codex pending-approval detection (dropped PermissionRequest backstop) -------------------
//
// Codex surfaces a tool/patch approval via an EventMsg the plugin's PermissionRequest hook turns into
// needsAttention; Codex has NO Notification event and silently drops hooks (openai/codex#16430), so the
// watchdog backstops it by scanning the rollout tail. "Pending" = the tail's first decisive marker
// (from the end) is an approval REQUEST (exec_approval_request / apply_patch_approval_request) with no
// resolution (tool result / turn progress) after it. NOTE: these request events are transient/not
// persisted at rust-v0.142.5, so the classifier's inputs here are documented-shape fixtures.
describe("codexTailPendingApproval (backstop classifier) + adapter capability", () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type, ...extra } });
  const item = (type: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ timestamp: "t", type: "response_item", payload: { type, ...extra } });

  test("only codex offers the capability; claude omits it (reliable hook channels)", () => {
    expect(typeof codexAdapter.tailShowsPendingApproval).toBe("function");
    expect(claudeAdapter.tailShowsPendingApproval).toBeUndefined();
  });

  test("a trailing exec/apply_patch approval request with only noise after it → pending (true)", () => {
    expect(codexTailPendingApproval([
      ev("task_started"),
      item("function_call", { name: "shell" }),
      ev("exec_approval_request", { call_id: "c1", command: ["rm", "-rf", "x"] }),
    ].join("\n"))).toBe(true);
    // apply_patch variant
    expect(codexTailPendingApproval([
      item("function_call", { name: "apply_patch" }),
      ev("apply_patch_approval_request", { call_id: "c2" }),
    ].join("\n"))).toBe(true);
    // token_count / agent_message after the request is NOT a resolution — still pending
    expect(codexTailPendingApproval([
      ev("exec_approval_request", { call_id: "c1" }),
      ev("token_count"),
      ev("agent_message", { message: "thinking" }),
    ].join("\n"))).toBe(true);
  });

  test("a request FOLLOWED by a resolution → not pending (false)", () => {
    // tool result landed (approved & ran, or denied)
    expect(codexTailPendingApproval([ev("exec_approval_request", { call_id: "c1" }), item("function_call_output", { call_id: "c1" })].join("\n"))).toBe(false);
    expect(codexTailPendingApproval([ev("exec_approval_request"), item("custom_tool_call_output")].join("\n"))).toBe(false);
    // tool finished / turn ended / new turn / user moved on
    expect(codexTailPendingApproval([ev("exec_approval_request"), ev("exec_command_end", { call_id: "c1" })].join("\n"))).toBe(false);
    expect(codexTailPendingApproval([ev("apply_patch_approval_request"), ev("patch_apply_end")].join("\n"))).toBe(false);
    expect(codexTailPendingApproval([ev("exec_approval_request"), ev("task_complete")].join("\n"))).toBe(false);
    expect(codexTailPendingApproval([ev("exec_approval_request"), ev("turn_aborted")].join("\n"))).toBe(false);
    expect(codexTailPendingApproval([ev("exec_approval_request"), ev("task_started")].join("\n"))).toBe(false);
    expect(codexTailPendingApproval([ev("exec_approval_request"), ev("user_message", { message: "go on" })].join("\n"))).toBe(false);
  });

  test("a SECOND request after an earlier resolved one is still pending (last decisive wins)", () => {
    expect(codexTailPendingApproval([
      ev("exec_approval_request", { call_id: "c1" }),
      item("function_call_output", { call_id: "c1" }),
      item("function_call", { name: "shell" }),
      ev("exec_approval_request", { call_id: "c2" }),
    ].join("\n"))).toBe(true);
  });

  test("no approval events at all (auto-approved rollout) → false", () => {
    expect(codexTailPendingApproval([
      ev("task_started"),
      item("function_call", { name: "shell" }),
      item("function_call_output", { call_id: "c1" }),
      ev("task_complete"),
    ].join("\n"))).toBe(false);
  });

  test("malformed / empty / byte-sliced tail → false (tolerated, never throws)", () => {
    expect(codexTailPendingApproval("")).toBe(false);
    expect(codexTailPendingApproval("not json at all")).toBe(false);
    // a byte-sliced leading fragment is skipped; the intact trailing request still counts
    expect(codexTailPendingApproval(['pe":"exec_approval_re', ev("exec_approval_request")].join("\n"))).toBe(true);
    // a byte-sliced TRAILING fragment fails JSON.parse and is skipped, exposing the resolution beneath
    expect(codexTailPendingApproval([ev("exec_approval_request"), item("function_call_output"), '{"type":"event_'].join("\n"))).toBe(false);
  });

  test("codexAdapter.tailShowsPendingApproval delegates to the classifier", () => {
    expect(codexAdapter.tailShowsPendingApproval!(ev("exec_approval_request"))).toBe(true);
    expect(codexAdapter.tailShowsPendingApproval!(ev("task_complete"))).toBe(false);
  });
});

// --- Bug A regression: ChatGPT.app app-server child-session ghosts ---------------------------

describe("codexChildSessionGhost (app-server child sessions must not become phone rows)", () => {
  const real: TrackedSessionLite = { sessionId: "019f480f-6b91-real", pid: 81879, agent: "codex" };

  test("the observed ghost: new id, empty transcript, pid shared with a tracked real codex session", () => {
    expect(codexChildSessionGhost("019f480f-9a05-child", "", 81879, [real])).toBe(true);
    // whitespace-only prefix is still "no rollout content"
    expect(codexChildSessionGhost("019f480f-9a05-child", "  \n ", 81879, [real])).toBe(true);
  });

  test("a REAL first app-server session (has rollout content) is never skipped", () => {
    expect(codexChildSessionGhost("019f480f-6b91-real2", '{"timestamp":"2026-07-10T00:00:00Z","type":"session_meta"}', 81879, [real])).toBe(false);
  });

  test("no other session on this pid → not a ghost (first session of a fresh process)", () => {
    expect(codexChildSessionGhost("new-id", "", 4242, [real])).toBe(false);
    expect(codexChildSessionGhost("new-id", "", 4242, [])).toBe(false);
  });

  test("a PROVISIONAL record on the same pid does NOT suppress the genuine first hook", () => {
    const prov: TrackedSessionLite = { sessionId: "codex-pid-81879", pid: 81879, provisional: true, agent: "codex" };
    expect(codexChildSessionGhost("real-first", "", 81879, [prov])).toBe(false);
  });

  test("a claude record on the same pid does not count (agent must be codex)", () => {
    const claude: TrackedSessionLite = { sessionId: "cc", pid: 81879 };
    expect(codexChildSessionGhost("new-id", "", 81879, [claude])).toBe(false);
  });

  test("the session's OWN id in the tracked list does not make it a ghost", () => {
    const self: TrackedSessionLite = { sessionId: "same-id", pid: 81879, agent: "codex" };
    expect(codexChildSessionGhost("same-id", "", 81879, [self])).toBe(false);
  });

  test("codexAdapter implements the seam; claudeAdapter omits it", () => {
    expect(codexAdapter.isChildSessionGhost!({ sessionId: "x", prefix: "", hookPid: 81879, tracked: [real] })).toBe(true);
    expect(claudeAdapter.isChildSessionGhost).toBeUndefined();
  });
});

// --- Bug C regression: firstUserPrompt must skip local-command noise --------------------------

describe("firstUserPrompt (skips command noise / caveat / system-reminder rows)", () => {
  const user = (content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });

  test("caveat wrapper + command rows are skipped; the first REAL prompt wins", () => {
    const transcript = [
      user("Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages.", { isMeta: true }),
      user("<command-name>/clear</command-name>"),
      user("<local-command-stdout>lots of stdout</local-command-stdout>"),
      user("fix the island timer"),
    ].join("\n");
    expect(firstUserPrompt(transcript)).toBe("fix the island timer");
  });

  test("a caveat row WITHOUT isMeta is still skipped (belt and suspenders)", () => {
    const transcript = [
      user("Caveat: The messages below were generated by the user while running local commands."),
      user("real ask"),
    ].join("\n");
    expect(firstUserPrompt(transcript)).toBe("real ask");
  });

  test("isMeta rows are skipped even when their text looks like a prompt", () => {
    const transcript = [user("not the real ask", { isMeta: true }), user("the real ask")].join("\n");
    expect(firstUserPrompt(transcript)).toBe("the real ask");
  });

  test("a system-reminder-ONLY message is skipped; an embedded reminder is stripped from a real prompt", () => {
    const reminderOnly = user("<system-reminder>you have mail</system-reminder>");
    const promptWithReminder = user("do the thing <system-reminder>context blah</system-reminder>");
    expect(firstUserPrompt([reminderOnly, promptWithReminder].join("\n"))).toBe("do the thing");
  });

  test("mid-string command noise is skipped", () => {
    const noise = user("output was: <local-command-stdout>zzz</local-command-stdout>");
    expect(firstUserPrompt([noise, user("hello world")].join("\n"))).toBe("hello world");
  });

  test("all-noise transcript yields undefined (title falls back), not a noise title", () => {
    const transcript = [
      user("Caveat: The messages below were generated by the user while running local commands."),
      user("<command-name>/model</command-name>"),
    ].join("\n");
    expect(firstUserPrompt(transcript)).toBeUndefined();
    expect(sessionTitle(transcript)).toBeUndefined();
  });

  test("sessionTitle still prefers ai-title over the prompt fallback", () => {
    const transcript = [
      user("Caveat: The messages below were generated by the user while running local commands."),
      JSON.stringify({ type: "ai-title", aiTitle: "Island timer fix" }),
      user("fix the island timer"),
    ].join("\n");
    expect(sessionTitle(transcript)).toBe("Island timer fix");
  });
});
