import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  adapterFor, allAdapters, claudeAdapter, claudeSessionModel, claudeSessionTitle, codexAdapter, codexChildSessionGhost,
  codexConfigModel, codexDiscoverLive, codexInternalSessionGhost, codexModelFromRollout,
  CODEX_ROLLOUT_IDLE_SILENCE_MS,
  codexNewestRolloutForCwd, codexPidTurnActive, codexRolloutExistsForSession, codexSentinelSessionId, codexSessionModel,
  codexTailPendingApproval, codexTurnActiveFromTail, filterCodexTuis, findProvisionalForPid,
  firstAssistantModel, firstUserPrompt, lastAssistantModel, parseCodexProcs, rolloutMetaCwd,
  rolloutPathFromLsof, sessionTitle, TrackedSessionLite,
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

  test("turn-state probe capability: codex implements pidTurnActive, claude omits it", () => {
    expect(typeof codexAdapter.pidTurnActive).toBe("function");
    expect(claudeAdapter.pidTurnActive).toBeUndefined();
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

  test("claudeSessionTitle: the FRESHEST ai-title from the transcript TAIL wins; the head is the fallback", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: j } = await import("node:path");
    const dir = await mkdtemp(j(tmpdir(), "cc-title-"));
    try {
      // Long-transcript shape (the 3.7 MB repro): the head window saw only the opening turns — NO
      // ai-title — while the ai-title lines CC appended later sit at the tail; the LAST one wins.
      const path = j(dir, "t.jsonl");
      await writeFile(path, [
        `{"type":"assistant","message":{"content":[{"type":"text","text":"${"x".repeat(200)}"}]}}`,
        `{"type":"ai-title","aiTitle":"Old topic"}`,
        `{"type":"ai-title","aiTitle":"Fix the reconcile orphan"}`,
      ].join("\n"));
      const headOnly = `{"type":"user","message":{"content":"first ask"}}`;
      // The tail's freshest ai-title beats the head's first-user-prompt fallback.
      expect(await claudeSessionTitle(headOnly, path)).toBe("Fix the reconcile orphan");
      // Missing/unreadable transcript → the head prefix answers (ai-title, else first prompt).
      expect(await claudeSessionTitle(headOnly, j(dir, "missing.jsonl"))).toBe("first ask");
      expect(await claudeSessionTitle("", j(dir, "missing.jsonl"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the adapter reads the tail through the seam: a tail-only ai-title beats the head's fallback", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: j } = await import("node:path");
    const dir = await mkdtemp(j(tmpdir(), "cc-title-seam-"));
    try {
      const path = j(dir, "t.jsonl");
      await writeFile(path, `{"type":"ai-title","aiTitle":"Tail title"}`);
      expect(await claudeAdapter.title({
        sessionId: randomUUID(), input: {}, transcriptPath: path,
        prefix: `{"type":"user","message":{"content":"head fallback"}}`,
      })).toBe("Tail title");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("UserPromptSubmit prompt fallback: a giant unparseable head line yields no transcript title, the hook input's prompt does", async () => {
    // The other real-world failure: the FIRST user line alone exceeded the head window (a 510 KB line
    // embedding a system-reminder), so the prefix is a byte-sliced fragment JSON.parse rejects and
    // every transcript scanner comes up empty at turn 1 — but the hook input carries the prompt.
    const slicedHead = `{"type":"user","message":{"content":"${"y".repeat(500)}`; // cut mid-line
    expect(await claudeAdapter.title({
      sessionId: randomUUID(), prefix: slicedHead, transcriptPath: "",
      input: { hook_event_name: "UserPromptSubmit", prompt: "**Fix** the `title` bug" },
    })).toBe("Fix the title bug"); // cleaned exactly like the transcript first-prompt fallback
  });

  test("the prompt fallback runs the SAME cleaning gauntlet as the transcript scanner (noise rejected)", async () => {
    const ctx = (input: Record<string, unknown>) => ({ sessionId: randomUUID(), prefix: "", transcriptPath: "", input });
    // A reminder-only prompt reduces to "" and is rejected — never a phantom title.
    expect(await claudeAdapter.title(ctx({
      hook_event_name: "UserPromptSubmit", prompt: "<system-reminder>injected context</system-reminder>",
    }))).toBeUndefined();
    // The local-command caveat wrapper is not a prompt.
    expect(await claudeAdapter.title(ctx({
      hook_event_name: "UserPromptSubmit", prompt: "Caveat: The messages below were generated…",
    }))).toBeUndefined();
    // No prompt fallback outside UserPromptSubmit (mirrors the codex adapter's gate).
    expect(await claudeAdapter.title(ctx({ hook_event_name: "PreToolUse", prompt: "ignored" }))).toBeUndefined();
    // A real prompt with an APPENDED reminder keeps its visible text.
    expect(await claudeAdapter.title(ctx({
      hook_event_name: "UserPromptSubmit", prompt: "Fix the bug<system-reminder>noise</system-reminder>",
    }))).toBe("Fix the bug");
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

// --- session model resolution (v0.8.5 — the blob's OPTIONAL `model` field) ---------------------
//
// The wire contract with the app (build 54): JSON key `model`, a raw model id string (e.g.
// "claude-fable-5", "gpt-5-codex"), OMITTED entirely when unknown — never required, never "".

describe("claude session model (assistant message.model — last wins; subagent noise excluded)", () => {
  const asst = (model: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: "assistant", message: { model, content: [] }, ...extra });

  test("lastAssistantModel: the LAST assistant line wins (tracks a mid-session /model switch)", () => {
    const t = [asst("claude-opus-4-5"), asst("claude-fable-5")].join("\n");
    expect(lastAssistantModel(t)).toBe("claude-fable-5");
  });

  test("a Task subagent invocation's tool_use input `model` is NOT the session model", () => {
    // The assistant line PROPOSING a Task carries message.model (the session model) AND a tool_use
    // whose input has "model":"opus" — parsing message.model (not substring-matching the line) is
    // what keeps the subagent's model out.
    const taskLine = JSON.stringify({
      type: "assistant",
      message: { model: "claude-fable-5", content: [{ type: "tool_use", name: "Task", input: { model: "opus", prompt: "go" } }] },
    });
    expect(lastAssistantModel(taskLine)).toBe("claude-fable-5");
    // A NON-assistant line that happens to carry a `model` field is skipped entirely.
    expect(lastAssistantModel(`{"type":"progress","model":"opus"}`)).toBeUndefined();
  });

  test("sidechain (Task subagent) assistant turns and synthetic error rows are skipped", () => {
    const t = [asst("claude-fable-5"), asst("claude-haiku-4-5", { isSidechain: true }), asst("<synthetic>")].join("\n");
    expect(lastAssistantModel(t)).toBe("claude-fable-5");
  });

  test("firstAssistantModel: the FIRST assistant line (the session-opening model in the head prefix)", () => {
    const t = [`{"type":"user","message":{"content":"hi"}}`, asst("claude-opus-4-5"), asst("claude-fable-5")].join("\n");
    expect(firstAssistantModel(t)).toBe("claude-opus-4-5");
  });

  test("undefined when no assistant line carries a model — never an empty string", () => {
    expect(lastAssistantModel(`{"type":"user","message":{"content":"hi"}}`)).toBeUndefined();
    expect(lastAssistantModel(asst(""))).toBeUndefined();
    expect(lastAssistantModel("not json\n")).toBeUndefined();
    expect(firstAssistantModel("")).toBeUndefined();
  });

  test("claudeSessionModel: the bounded TAIL read wins (the /model-switch case); the head prefix is the fallback; else undefined", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: j } = await import("node:path");
    const dir = await mkdtemp(j(tmpdir(), "cc-model-"));
    try {
      const path = j(dir, "t.jsonl");
      await writeFile(path, [asst("claude-opus-4-5"), asst("claude-fable-5")].join("\n"));
      // The prefix (head) still says opus, but the transcript tail's last assistant line says fable —
      // the tail wins, so a mid-session /model switch reaches the phone.
      expect(await claudeSessionModel(asst("claude-opus-4-5"), path)).toBe("claude-fable-5");
      // Missing/unreadable transcript → the already-read head prefix answers (frozen at session start).
      expect(await claudeSessionModel(asst("claude-opus-4-5"), j(dir, "missing.jsonl"))).toBe("claude-opus-4-5");
      // Nothing anywhere → undefined (the blob then omits the key).
      expect(await claudeSessionModel("", j(dir, "missing.jsonl"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the claude adapter exposes the seam (hook stdin has no model field — the transcript answers)", async () => {
    expect(typeof claudeAdapter.model).toBe("function");
    expect(await claudeAdapter.model!({
      sessionId: randomUUID(), prefix: asst("claude-fable-5"), input: {}, transcriptPath: "",
    })).toBe("claude-fable-5");
  });
});

describe("codex session model (input.model → rollout turn_context → config.toml default)", () => {
  const turnCtx = (model: string): string =>
    JSON.stringify({ timestamp: "t", type: "turn_context", payload: { cwd: "/x", model } });

  test("PRIMARY: the hook payload's own top-level `model` beats every fallback; whitespace-only is ignored", async () => {
    // Even with a rollout prefix saying gpt-5, the per-turn hook field is the exact source.
    expect(await codexSessionModel({ model: "gpt-5-codex" }, turnCtx("gpt-5"), "", "/nonexistent-codex-home")).toBe("gpt-5-codex");
    expect(await codexSessionModel({ model: "   " }, "", "", "/nonexistent-codex-home")).toBeUndefined();
  });

  test("codexModelFromRollout: the LAST turn_context wins; noise and byte-sliced fragments are skipped", () => {
    const rollout = [
      `{"type":"session_meta","payload":{"cwd":"/x"}}`,
      turnCtx("gpt-5"),
      `{"type":"event_msg","payload":{"type":"task_started"}}`,
      turnCtx("gpt-5-codex"),
      `{"type":"event_msg","payload":{"type":"token_count"}}`,
      `ontext","payload":{"model":"sliced-turn_context"`, // byte-sliced fragment → fails JSON.parse → skipped
    ].join("\n");
    expect(codexModelFromRollout(rollout)).toBe("gpt-5-codex");
    expect(codexModelFromRollout("")).toBeUndefined();
    expect(codexModelFromRollout(turnCtx(" "))).toBeUndefined(); // whitespace model → not a model id
  });

  test("FALLBACK: the rollout answers when the hook payload carries no model (tail first, then prefix)", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: j } = await import("node:path");
    const dir = await mkdtemp(j(tmpdir(), "codex-model-"));
    try {
      const path = j(dir, "rollout-t.jsonl");
      await writeFile(path, [turnCtx("gpt-5"), turnCtx("gpt-5-codex")].join("\n"));
      expect(await codexSessionModel({}, "", path, j(dir, "no-home"))).toBe("gpt-5-codex");
      // Tail file missing → the already-read head prefix answers.
      expect(await codexSessionModel({}, turnCtx("gpt-5"), j(dir, "missing.jsonl"), j(dir, "no-home"))).toBe("gpt-5");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("codexConfigModel: top-level `model` assignment only (tables skipped); both TOML string forms; never ''", () => {
    expect(codexConfigModel('model = "gpt-5-codex"\n\n[table]\nmodel = "nope"\n')).toBe("gpt-5-codex");
    expect(codexConfigModel("model = 'gpt-5'\n")).toBe("gpt-5"); // literal (single-quoted) string
    expect(codexConfigModel('model = "gpt-5-codex" # the default\n')).toBe("gpt-5-codex"); // trailing comment
    expect(codexConfigModel('[profile.x]\nmodel = "nope"\n')).toBeUndefined(); // table keys are NOT the default
    expect(codexConfigModel('model = ""\n')).toBeUndefined();
    expect(codexConfigModel("model = 42\n")).toBeUndefined(); // present but not a string → unusable
    expect(codexConfigModel("")).toBeUndefined();
  });

  test("LAST RESORT: $CODEX_HOME/config.toml's default; undefined when even that is absent", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: j } = await import("node:path");
    const home = await mkdtemp(j(tmpdir(), "codex-home-"));
    try {
      await writeFile(j(home, "config.toml"), 'model = "gpt-5.1-codex-max"\n');
      expect(await codexSessionModel({}, "", "", home)).toBe("gpt-5.1-codex-max");
      expect(await codexSessionModel({}, "", "", "/nonexistent-codex-home")).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("the codex adapter exposes the seam (payload model, like the real per-turn hooks)", async () => {
    expect(typeof codexAdapter.model).toBe("function");
    expect(await codexAdapter.model!({
      sessionId: randomUUID(), prefix: "", input: { model: "gpt-5-codex" }, transcriptPath: "",
    })).toBe("gpt-5-codex");
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
  test("surfaces each new TUI as a sentinel session titled/labelled by its cwd basename, with its idle verdict", async () => {
    const cwds: Record<number, string> = { 16029: "/Users/karrix/api-status/nomo", 33198: "/Users/karrix/WidgetAnimation" };
    const discovered = await codexDiscoverLive([], {
      ps: async () => PS_FIXTURE,
      cwdOf: async (pid) => cwds[pid],
      turnActive: async (pid) => pid === 16029, // 16029 has a turn in flight; 33198 sits idle
    });
    expect(discovered).toEqual([
      { pid: 16029, sessionId: "codex-pid-16029", title: "nomo", label: "nomo", idle: false },
      { pid: 33198, sessionId: "codex-pid-33198", title: "WidgetAnimation", label: "WidgetAnimation", idle: true },
    ]);
  });

  test("excludes pids already covered by a known record (real or provisional)", async () => {
    const known: SessionRecord[] = [{ pid: 16029, machine: "m", label: "l", ts: 1 }];
    const discovered = await codexDiscoverLive(known, { ps: async () => PS_FIXTURE, cwdOf: async () => "/tmp/proj", turnActive: async () => false });
    expect(discovered.map((d) => d.pid)).toEqual([33198]);
  });

  test("an unknown cwd falls back to the 'session' label (like buildBlob)", async () => {
    const discovered = await codexDiscoverLive([], { ps: async () => "42 ttys001  codex", cwdOf: async () => undefined, turnActive: async () => false });
    expect(discovered[0]).toEqual({ pid: 42, sessionId: "codex-pid-42", title: "session", label: "session", idle: true });
  });

  test("a turn-probe THROW yields idle (the bug-safe default — never a stuck-'Running' ghost)", async () => {
    const discovered = await codexDiscoverLive([], {
      ps: async () => "42 ttys001  codex", cwdOf: async () => "/x/proj",
      turnActive: async () => { throw new Error("lsof boom"); },
    });
    expect(discovered[0]).toMatchObject({ pid: 42, idle: true });
  });

  test("a `ps` failure yields no discoveries (best-effort)", async () => {
    expect(await codexDiscoverLive([], { ps: async () => { throw new Error("no ps"); }, cwdOf: async () => "/x" })).toEqual([]);
  });
});

// --- codex idle-vs-in-flight turn classification (the v0.8.4 idle-TUI fix) --------------------
//
// Fixture lines mirror REAL rollout shapes (the same serde forms codexLastTurnEvent's suite uses):
// event_msg turn boundaries + response_item/token_count noise. The classifier must call an idle REPL
// idle (task_complete/turn_aborted last, or a fresh session_meta-only rollout) and only call a TUI
// "working" when a turn is genuinely open (task_started last, or boundary-less-but-actively-writing).

const evt = (type: string): string => JSON.stringify({ timestamp: "2026-07-10T02:00:00Z", type: "event_msg", payload: { type } });
const item = (type: string): string => JSON.stringify({ timestamp: "2026-07-10T02:00:00Z", type: "response_item", payload: { type } });
const meta = (): string => JSON.stringify({ timestamp: "2026-07-10T02:00:00Z", type: "session_meta", payload: { id: "s" } });

describe("codexTurnActiveFromTail (idle vs in-flight decision matrix)", () => {
  test("task_started last boundary → a turn is open (working), even with trailing noise", () => {
    expect(codexTurnActiveFromTail(evt("task_started"), 0)).toBe(true);
    // token_count / agent_message / response_item noise AFTER the boundary must not flip the verdict.
    const tail = [evt("task_started"), item("reasoning"), evt("token_count"), evt("agent_message")].join("\n");
    expect(codexTurnActiveFromTail(tail, 0)).toBe(true);
  });

  test("a long-silent rollout whose last boundary is STILL task_started stays working (long tool run)", () => {
    // Silence alone must not override an explicit open boundary — a 10-min build inside one exec is
    // write-quiet but genuinely in flight (the same reasoning as the interrupt net's WORKING_STALE_MS).
    expect(codexTurnActiveFromTail(evt("task_started"), CODEX_ROLLOUT_IDLE_SILENCE_MS * 10)).toBe(true);
  });

  test("task_complete / turn_aborted last boundary → idle, regardless of recency", () => {
    for (const boundary of ["task_complete", "turn_aborted"]) {
      const tail = [evt("task_started"), item("function_call_output"), evt(boundary), evt("token_count")].join("\n");
      expect(codexTurnActiveFromTail(tail, 0)).toBe(false); // freshly finished → already idle
      expect(codexTurnActiveFromTail(tail, CODEX_ROLLOUT_IDLE_SILENCE_MS * 10)).toBe(false);
    }
  });

  test("a fresh rollout (session_meta only — no turn ever ran) → idle even when just written", () => {
    expect(codexTurnActiveFromTail(meta(), 0)).toBe(false);
    expect(codexTurnActiveFromTail("", 0)).toBe(false); // empty/unflushed tail → idle
  });

  test("no boundary but RECENT turn traffic → working (mid-turn; task_started scrolled past the tail)", () => {
    const tail = [item("reasoning"), evt("agent_message"), item("function_call")].join("\n");
    expect(codexTurnActiveFromTail(tail, CODEX_ROLLOUT_IDLE_SILENCE_MS - 1)).toBe(true);
  });

  test("no boundary and traffic gone SILENT past the threshold → idle", () => {
    const tail = [item("reasoning"), evt("agent_message")].join("\n");
    expect(codexTurnActiveFromTail(tail, CODEX_ROLLOUT_IDLE_SILENCE_MS)).toBe(false);
  });

  test("tolerates a byte-sliced first line (readSuffix can cut mid-JSON), like the other tail scanners", () => {
    const sliced = `d","payload":{"type":"task_started"}}\n${evt("task_complete")}`;
    expect(codexTurnActiveFromTail(sliced, 0)).toBe(false); // the sliced fragment is skipped, not parsed
  });
});

describe("rolloutPathFromLsof (pin the pid's open rollout — the codex TUI holds it open)", () => {
  // Mirrors real `lsof -a -p <pid> -Fn` output observed live (p/fcwd/f45/n field lines).
  const LSOF_FIXTURE = [
    "p91986",
    "fcwd",
    "n/Users/karrix/api-status",
    "f45",
    "n/Users/karrix/.codex/sessions/2026/07/10/rollout-2026-07-10T02-00-46-019f480a.jsonl",
  ].join("\n");

  test("returns the open rollout-*.jsonl path; the cwd n-line is not mistaken for it", () => {
    expect(rolloutPathFromLsof(LSOF_FIXTURE)).toBe("/Users/karrix/.codex/sessions/2026/07/10/rollout-2026-07-10T02-00-46-019f480a.jsonl");
  });

  test("no rollout fd listed → undefined (an ordinary process, or lsof noise only)", () => {
    expect(rolloutPathFromLsof("p123\nfcwd\nn/Users/x/proj\nf3\nn/dev/null")).toBeUndefined();
    expect(rolloutPathFromLsof("")).toBeUndefined();
  });
});

describe("rolloutMetaCwd (session_meta head parser for the cwd+recency fallback)", () => {
  const metaLine = JSON.stringify({
    timestamp: "2026-07-10T02:00:46Z", type: "session_meta",
    payload: { id: "019f480a", cwd: "/Users/karrix/api-status", originator: "codex_cli_rs" },
  });

  test("reads payload.cwd from the head's session_meta line", () => {
    expect(rolloutMetaCwd(metaLine)).toBe("/Users/karrix/api-status");
    expect(rolloutMetaCwd(`${metaLine}\n${evt("task_started")}`)).toBe("/Users/karrix/api-status");
  });

  test("no parseable session_meta (empty / corrupt / other types) → undefined", () => {
    expect(rolloutMetaCwd("")).toBeUndefined();
    expect(rolloutMetaCwd(evt("task_complete"))).toBeUndefined();
    expect(rolloutMetaCwd(`{"type":"session_meta","payload":{"cwd":`)).toBeUndefined(); // byte-sliced
  });
});

describe("codexNewestRolloutForCwd (mtime-recency fallback under sessions/YYYY/MM/DD)", () => {
  const metaFor = (cwd: string): string =>
    `${JSON.stringify({ timestamp: "2026-07-10T02:00:00Z", type: "session_meta", payload: { id: "x", cwd } })}\n`;

  test("returns the most recently WRITTEN rollout whose session_meta cwd matches; undefined when none does", async () => {
    const { mkdtemp, mkdir, writeFile, utimes, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: j } = await import("node:path");
    const home = await mkdtemp(j(tmpdir(), "codex-home-"));
    try {
      const day = j(home, "sessions", "2026", "07", "10");
      await mkdir(day, { recursive: true });
      // Older rollout in the RIGHT cwd, newer rollout in the WRONG cwd, newest in the right cwd again —
      // mtime recency (not filename order) must pick the newest right-cwd one.
      const oldRight = j(day, "rollout-2026-07-10T01-00-00-aaa.jsonl");
      const newWrong = j(day, "rollout-2026-07-10T02-00-00-bbb.jsonl");
      const newRight = j(day, "rollout-2026-07-10T03-00-00-ccc.jsonl");
      await writeFile(oldRight, metaFor("/x/proj"));
      await writeFile(newWrong, metaFor("/elsewhere"));
      await writeFile(newRight, metaFor("/x/proj"));
      await utimes(oldRight, new Date(1000), new Date(1000));
      await utimes(newWrong, new Date(3000), new Date(3000));
      await utimes(newRight, new Date(2000), new Date(2000));
      expect(await codexNewestRolloutForCwd("/x/proj", home)).toBe(newRight);
      expect(await codexNewestRolloutForCwd("/never/seen", home)).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a missing sessions tree → undefined (best-effort)", async () => {
    expect(await codexNewestRolloutForCwd("/x", "/nonexistent/codex-home")).toBeUndefined();
  });
});

describe("codexPidTurnActive (probe pipeline with injected rollout/cwd/tail/mtime)", () => {
  test("no locatable rollout (fd closed AND no cwd match) → idle (can't prove a turn is open)", async () => {
    expect(await codexPidTurnActive(42, {
      rolloutOf: async () => undefined, cwdOf: async () => undefined,
    })).toBe(false);
    expect(await codexPidTurnActive(42, {
      rolloutOf: async () => undefined, cwdOf: async () => "/x/proj", rolloutForCwd: async () => undefined,
    })).toBe(false);
  });

  test("classifies from the located rollout's tail + write-silence", async () => {
    const deps = (tail: string, mtime: number) => ({
      rolloutOf: async () => "/r/rollout-x.jsonl",
      readTail: async () => tail,
      mtimeOf: async () => mtime,
      now: () => 100_000,
    });
    expect(await codexPidTurnActive(42, deps(evt("task_started"), 99_000))).toBe(true);
    expect(await codexPidTurnActive(42, deps(evt("task_complete"), 99_000))).toBe(false);
    expect(await codexPidTurnActive(42, deps(meta(), 99_000))).toBe(false); // fresh promptless TUI → idle
  });

  test("falls back to the cwd+recency locator when the fd match yields nothing (codex closes the fd while idle)", async () => {
    const asked: string[] = [];
    const active = await codexPidTurnActive(42, {
      rolloutOf: async () => undefined,
      cwdOf: async () => "/x/proj",
      rolloutForCwd: async (cwd) => { asked.push(cwd); return "/r/rollout-y.jsonl"; },
      readTail: async () => evt("task_started"),
      mtimeOf: async () => 99_000,
      now: () => 100_000,
    });
    expect(asked).toEqual(["/x/proj"]);
    expect(active).toBe(true);
  });

  test("an unreadable rollout (raced deletion / zstd compaction) → idle, never a throw", async () => {
    expect(await codexPidTurnActive(42, {
      rolloutOf: async () => "/r/rollout-x.jsonl",
      readTail: async () => { throw new Error("ENOENT"); },
    })).toBe(false);
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

// --- Bug A′ regression: ChatGPT.app app-server TOP-LEVEL internal jobs -------------------------
//
// The child-session net above misses ChatGPT.app's top-level internal jobs. Observed 2026-07-10:
// session 019f4a6a-88ad-7ed3-8f0a-cdfcc32ff98f, titled from ChatGPT's OWN internal prompt ("Overview
// Generate 0 to 3 hyperpersonalized suggestions for what this user can…"), model gpt-5.4, EMPTY
// transcript string, NO rollout under ~/.codex/sessions/ — and a pid that owned no other tracked
// session, so codexChildSessionGhost let it straight through to a phantom phone row. That prompt
// text is documented here as EVIDENCE only; the classifier keys on the structural signal (no
// transcript content + no transcript file + no rollout for the id), never on prompt matching.

describe("codexInternalSessionGhost (top-level app-server internal jobs must not become phone rows)", () => {
  const ghostId = "019f4a6a-88ad-7ed3-8f0a-cdfcc32ff98f";

  test("the observed ghost: empty transcript, no transcript path, no rollout → skipped", async () => {
    expect(await codexInternalSessionGhost(ghostId, "", "", { rolloutExists: async () => false })).toBe(true);
    // whitespace-only prefix is still "no rollout content"
    expect(await codexInternalSessionGhost(ghostId, "  \n ", "", { rolloutExists: async () => false })).toBe(true);
  });

  test("a legit brand-new TUI session (rollout file already on disk) is mirrored", async () => {
    expect(await codexInternalSessionGhost("real-id", "", "", { rolloutExists: async () => true })).toBe(false);
  });

  test("rollout CONTENT in the prefix mirrors immediately — neither fs probe is consulted", async () => {
    let statted = false, scanned = false;
    expect(await codexInternalSessionGhost("real-id", '{"timestamp":"2026-07-10T00:00:00Z","type":"session_meta"}', "/some/rollout.jsonl", {
      statOf: async () => { statted = true; return {}; },
      rolloutExists: async () => { scanned = true; return false; },
    })).toBe(false);
    expect(statted).toBe(false);
    expect(scanned).toBe(false);
  });

  test("an existing transcript_path (file created, content not flushed yet) mirrors without the scan", async () => {
    let scanned = false;
    expect(await codexInternalSessionGhost("real-id", "", "/rollout/on/disk.jsonl", {
      statOf: async () => ({}),
      rolloutExists: async () => { scanned = true; return false; },
    })).toBe(false);
    expect(scanned).toBe(false);
  });

  test("a transcript_path with NO file behind it falls through to the rollout scan", async () => {
    expect(await codexInternalSessionGhost(ghostId, "", "/gone/rollout.jsonl", {
      statOf: async () => { throw new Error("ENOENT"); },
      rolloutExists: async () => false,
    })).toBe(true);
    expect(await codexInternalSessionGhost("real-id", "", "/gone/rollout.jsonl", {
      statOf: async () => { throw new Error("ENOENT"); },
      rolloutExists: async () => true,
    })).toBe(false);
  });

  test("DEFER, not verdict: the same session mirrors on its next hook once the rollout appears", async () => {
    let rolloutOnDisk = false; // hook 1 races the first flush → no rollout yet → first frame deferred
    const deps = { rolloutExists: async () => rolloutOnDisk };
    expect(await codexInternalSessionGhost("racy-id", "", "", deps)).toBe(true);
    rolloutOnDisk = true;      // hook 2 (same turn, moments later): the rollout is on disk now
    expect(await codexInternalSessionGhost("racy-id", "", "", deps)).toBe(false);
  });

  test("a throwing locator is NO evidence → defer (self-heals; never throws out)", async () => {
    expect(await codexInternalSessionGhost("x", "", "", {
      rolloutExists: async () => { throw new Error("boom"); },
    })).toBe(true);
  });

  test("codexAdapter implements the seam; claudeAdapter omits it", () => {
    expect(typeof codexAdapter.isInternalSessionGhost).toBe("function");
    expect(claudeAdapter.isInternalSessionGhost).toBeUndefined();
  });
});

describe("codexRolloutExistsForSession (filename-only scan under sessions/YYYY/MM/DD)", () => {
  test("finds a rollout whose filename carries the session id; misses unknown ids", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: j } = await import("node:path");
    const home = await mkdtemp(j(tmpdir(), "codex-home-"));
    try {
      const day = j(home, "sessions", "2026", "07", "10");
      await mkdir(day, { recursive: true });
      const sid = "019f4a6a-1111-7ed3-8f0a-abcabcabcabc";
      await writeFile(j(day, `rollout-2026-07-10T01-00-00-${sid}.jsonl`), ""); // filename is the evidence — content unread
      expect(await codexRolloutExistsForSession(sid, home)).toBe(true);
      // the observed ghost id has no rollout anywhere → no evidence
      expect(await codexRolloutExistsForSession("019f4a6a-88ad-7ed3-8f0a-cdfcc32ff98f", home)).toBe(false);
      // a non-rollout file carrying the id does not count
      await writeFile(j(day, "notes-019f4a6a-2222.txt"), "");
      expect(await codexRolloutExistsForSession("019f4a6a-2222", home)).toBe(false);
      // an empty id can never match (defensive — the hook gates on a non-empty session_id anyway)
      expect(await codexRolloutExistsForSession("", home)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a missing sessions tree → false (no rollout evidence, best-effort)", async () => {
    expect(await codexRolloutExistsForSession("x", "/nonexistent/codex-home")).toBe(false);
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
