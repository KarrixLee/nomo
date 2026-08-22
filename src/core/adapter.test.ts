import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  adapterFor, allAdapters, claudeAdapter, claudeClearPredecessor, claudeDesktopInvocation, claudeForkResumePredecessor, claudeHeadlessInvocation, claudeLocateTuiPid, claudeSessionModel, claudeSessionTitle,
  claudeTailPendingApproval, codexAdapter, codexChildSessionGhost, codexDesktopAppPid, codexDesktopOriginator, codexLocateTuiPid, codexTuiCandidates,
  codexConfigModel, codexDiscoverLive, codexInternalSessionGhost, codexModelFromRollout,
  CODEX_ROLLOUT_IDLE_SILENCE_MS,
  codexNewestRolloutForCwd, codexPidPlanPickerEvidence, codexPidPlanPickerState, codexPidTurnActive, codexPlanPickerStateFromTail, codexProposedPlanMarkdown, codexRolloutExistsForSession, codexSentinelSessionId, codexSessionModel,
  codexRolloutCreationEvidence, codexSessionCreationSuppression, codexTailPendingApproval, codexTailPendingAttentionKind, codexTailPendingUserInputDetail, codexTurnActiveFromTail, filterCodexTuis, findProvisionalForPid,
  firstAssistantModel, firstUserPrompt, lastAssistantModel, parseCodexProcs, rolloutMetaCwd,
  opencodeAdapter,
  requestUserInputDetail, rolloutPathFromLsof, sessionTitle, TrackedSessionLite,
} from "./adapter";
import type { LocateTuiReason } from "./adapter";
import { folderKeyFromCwd } from "./shared";
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

  // THE REBRAND BUG (2026-08-19, observed live): a 2.0.2 watchdog picked up a failed `done` retry for
  // an `agent:"opencode"` record, adapterFor fell through to claude, claude's blobAgentFields is `{}`,
  // and the agent key vanished from the rebuilt blob — the island flipped OpenCode → Claude Code. An
  // agent this build does not understand must ride through a rebuild untouched.
  describe("an UNKNOWN agent kind is passed through, never coerced to claude", () => {
    test("blobAgentFields carries the raw literal back out", () => {
      expect(adapterFor("opencode")).toBe(opencodeAdapter);
      const future = adapterFor("some-future-agent");
      expect(future).not.toBe(claudeAdapter);
      expect(future.kind).toBe("some-future-agent");
      expect(future.blobAgentFields).toEqual({ agent: "some-future-agent" });
    });

    test("every optional seam is absent, and the inert ones cannot match a real agent's files", () => {
      const future = adapterFor("some-future-agent");
      for (const seam of [
        "model", "tailShowsPendingApproval", "tailPendingAttentionDetail", "tailPendingAttentionKind",
        "completedTurnWaitState", "completedTurnWaitEvidence", "isChildSessionGhost",
        "isInternalSessionGhost", "sessionCreationSuppression", "forkResumePredecessor",
        "clearPredecessor", "isHeadlessInvocation", "isDesktopInvocation", "discoverLive",
        "pidTurnActive", "locateTuiPid",
      ]) expect(future[seam as keyof typeof future]).toBeUndefined();
      expect(future.sessionMatch("abc.jsonl")).toBe(false);
      expect(future.detectInterrupt("anything")).toBe(false);
      // The untrusted literal never reaches a path (a record could name anything at all).
      expect(adapterFor("../../etc/passwd").hookStampPath()).not.toContain("..");
      // …and it is never registered, so no sweep or health row ever calls into it.
      expect(allAdapters.some((a) => a.kind === "some-future-agent")).toBe(false);
    });

    test("a MISSING or empty agent is corrupt, not unknown — the claude default is unchanged", () => {
      expect(adapterFor("")).toBe(claudeAdapter);
      expect(adapterFor(undefined as unknown as string)).toBe(claudeAdapter);
    });
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
      startedAtOf: async (pid) => pid === 16029 ? 1_000 : 2_000,
      turnActive: async (pid) => pid === 16029, // 16029 has a turn in flight; 33198 sits idle
    });
    // `folderKey` is DERIVED here rather than written out: it is the digest of the same cwd the label
    // comes from, and pinning a literal would just be a second implementation of the hash. That the two
    // halves agree on one path is the whole invariant (see shared.ts folderIdentity).
    expect(discovered).toEqual([
      { pid: 16029, sessionId: "codex-pid-16029", title: "nomo", label: "nomo", idle: false, folderKey: folderKeyFromCwd(cwds[16029]), cwd: cwds[16029], startedAt: 1_000 },
      { pid: 33198, sessionId: "codex-pid-33198", title: "WidgetAnimation", label: "WidgetAnimation", idle: true, folderKey: folderKeyFromCwd(cwds[33198]), cwd: cwds[33198], startedAt: 2_000 },
    ]);
  });

  test("excludes pids already covered by a known record (real or provisional)", async () => {
    const known: SessionRecord[] = [{ pid: 16029, machine: "m", label: "l", ts: 1 }];
    const discovered = await codexDiscoverLive(known, { ps: async () => PS_FIXTURE, cwdOf: async () => "/tmp/proj", startedAtOf: async () => undefined, turnActive: async () => false });
    expect(discovered.map((d) => d.pid)).toEqual([33198]);
  });

  test("a retired-owner marker keeps discovery from recreating its still-open TUI", async () => {
    const known = [{
      pid: 16029, tuiPid: 16029, retiredAt: 123,
      machine: "m", label: "proj", ts: 100, agent: "codex",
    } as SessionRecord];
    const discovered = await codexDiscoverLive(known, {
      ps: async () => PS_FIXTURE,
      cwdOf: async () => "/tmp/proj",
      startedAtOf: async () => 100,
      turnActive: async () => false,
    });
    expect(discovered.map((d) => d.pid)).not.toContain(16029);
  });

  test("a retired-owner marker fails open for an unverifiable or PID-reused TUI", async () => {
    const known = [{
      pid: 16029, tuiPid: 16029, retiredAt: 123,
      machine: "m", label: "proj", ts: 100, agent: "codex",
    } as SessionRecord];
    for (const startedAt of [undefined, 124]) {
      const discovered = await codexDiscoverLive(known, {
        ps: async () => "16029 ttys017  codex",
        cwdOf: async () => "/tmp/proj",
        startedAtOf: async () => startedAt,
        turnActive: async () => false,
      });
      expect(discovered.map((d) => d.pid)).toEqual([16029]);
    }
  });

  test("an unknown cwd falls back to the 'session' label (like buildBlob)", async () => {
    const discovered = await codexDiscoverLive([], { ps: async () => "42 ttys001  codex", cwdOf: async () => undefined, startedAtOf: async () => undefined, turnActive: async () => false });
    expect(discovered[0]).toEqual({ pid: 42, sessionId: "codex-pid-42", title: "session", label: "session", idle: true });
  });

  test("a turn-probe THROW yields idle (the bug-safe default — never a stuck-'Running' ghost)", async () => {
    const discovered = await codexDiscoverLive([], {
      ps: async () => "42 ttys001  codex", cwdOf: async () => "/x/proj",
      startedAtOf: async () => undefined,
      turnActive: async () => { throw new Error("lsof boom"); },
    });
    expect(discovered[0]).toMatchObject({ pid: 42, idle: true });
  });

  test("a `ps` failure yields no discoveries (best-effort)", async () => {
    expect(await codexDiscoverLive([], { ps: async () => { throw new Error("no ps"); }, cwdOf: async () => "/x", startedAtOf: async () => undefined })).toEqual([]);
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

describe("codex plan-picker classifier (completed Plan turn, TUI still waiting)", () => {
  const real0146Tail = readFileSync(join(import.meta.dir, "fixtures", "codex-0.146-plan-picker-5s-flush-tail.jsonl"), "utf8").trim();
  const proposedPlan = (text = "Ship the narrow fix."): string => JSON.stringify({
    timestamp: "2026-07-29T07:27:21Z",
    type: "response_item",
    payload: {
      type: "message", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: `<proposed_plan>\n${text}\n</proposed_plan>` }],
    },
  });
  const normalAnswer = (): string => JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] },
  });

  test("exact proposed-plan final + task_complete is pending; normal completion is unaffected", () => {
    expect(codexPlanPickerStateFromTail([evt("task_started"), proposedPlan(), evt("task_complete")].join("\n"))).toBe("pending");
    expect(codexPlanPickerStateFromTail([evt("task_started"), normalAnswer(), evt("task_complete")].join("\n"))).toBe("none");
    // Merely mentioning/tag-opening a plan is insufficient: require the complete Plan-mode wrapper.
    expect(codexPlanPickerStateFromTail([evt("task_started"), proposedPlan("x").replace("</proposed_plan>", ""), evt("task_complete")].join("\n"))).toBe("none");
  });

  test("extracts only inner markdown and returns it with the same pending evidence read", async () => {
    expect(codexProposedPlanMarkdown("<proposed_plan>\n# Ship\n\nDo it.\n</proposed_plan>"))
      .toBe("# Ship\n\nDo it.");
    const tail = [evt("task_started"), proposedPlan("# Ship\n\nDo it."), evt("task_complete")].join("\n");
    expect(await codexPidPlanPickerEvidence(42, {
      isAlive: () => true,
      rolloutOf: async () => "/r/rollout.jsonl",
      readTail: async () => tail,
    })).toEqual({ state: "pending", plan: "# Ship\n\nDo it." });
  });

  test("0.146.0 live 5.1s gap: hook classifies durable wrapper as incomplete without sleeping", async () => {
    const rows = real0146Tail.split("\n");
    const beforeTaskComplete = rows.slice(0, -1).join("\n");
    expect(codexPlanPickerStateFromTail(beforeTaskComplete)).toBe("none");
    expect(codexPlanPickerStateFromTail(real0146Tail)).toBe("pending");
    expect(await codexPidPlanPickerState(937, {
      isAlive: () => true,
      rolloutOf: async () => "/r/019faef9.jsonl",
      readTail: async () => beforeTaskComplete,
    })).toBe("incomplete");
    expect(await codexPidPlanPickerState(937, {
      isAlive: () => true,
      rolloutOf: async () => "/r/019faef9.jsonl",
      readTail: async () => real0146Tail,
    })).toBe("pending");
  });

  test("incomplete remains exact-wrapper-only; ordinary finals stay none", async () => {
    expect(await codexPidPlanPickerState(42, {
      isAlive: () => true,
      rolloutOf: async () => "/r/rollout.jsonl",
      readTail: async () => normalAnswer(),
    })).toBe("none");
    expect(await codexPidPlanPickerState(42, {
      isAlive: () => true,
      rolloutOf: async () => "/r/rollout.jsonl",
      readTail: async () => proposedPlan("x").replace("</proposed_plan>", ""),
    })).toBe("none");
  });

  test("a later task_started or user_message explicitly resolves the pending picker", () => {
    const pending = [evt("task_started"), proposedPlan(), evt("task_complete")];
    expect(codexPlanPickerStateFromTail([...pending, evt("task_started")].join("\n"))).toBe("resolved");
    expect(codexPlanPickerStateFromTail([...pending, evt("user_message")].join("\n"))).toBe("resolved");
  });

  test("resolved evidence drops the plan with the picker state", async () => {
    const tail = [evt("task_started"), proposedPlan("Private plan"), evt("task_complete"), evt("user_message")].join("\n");
    expect(await codexPidPlanPickerEvidence(42, {
      isAlive: () => true,
      rolloutOf: async () => "/r/rollout.jsonl",
      readTail: async () => tail,
    })).toEqual({ state: "resolved" });
  });

  test("pid probe requires process liveness and returns exited before reading a rollout", async () => {
    let read = false;
    expect(await codexPidPlanPickerState(42, {
      isAlive: () => false,
      rolloutOf: async () => { read = true; return "/r/rollout.jsonl"; },
      readTail: async () => [proposedPlan(), evt("task_complete")].join("\n"),
    })).toBe("exited");
    expect(read).toBe(false);
  });

  test("live pid + located rollout returns pending; unreadable evidence stays unknown", async () => {
    expect(await codexPidPlanPickerState(42, {
      isAlive: () => true,
      rolloutOf: async () => "/r/rollout.jsonl",
      readTail: async () => [proposedPlan(), evt("task_complete")].join("\n"),
    })).toBe("pending");
    expect(await codexPidPlanPickerState(42, {
      isAlive: () => true,
      rolloutOf: async () => "/r/rollout.jsonl",
      readTail: async () => { throw new Error("ENOENT"); },
    })).toBe("unknown");
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

  test("both agents offer the capability (codex backstops a dropped PermissionRequest; claude a dropped PreToolUse)", () => {
    expect(typeof codexAdapter.tailShowsPendingApproval).toBe("function");
    expect(typeof claudeAdapter.tailShowsPendingApproval).toBe("function");
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

  test("a persisted request_user_input call is pending until its function_call_output arrives", () => {
    const args = JSON.stringify({ questions: [{ id: "scope", header: "Scope", question: "Which API should we keep?" }] });
    const request = item("function_call", { name: "request_user_input", call_id: "q1", arguments: args });
    expect(codexTailPendingApproval([ev("task_started"), request].join("\n"))).toBe(true);
    expect(codexTailPendingAttentionKind([ev("task_started"), request].join("\n"))).toBe("userInput");
    expect(codexTailPendingUserInputDetail([ev("task_started"), request].join("\n")))
      .toBe("Scope: Which API should we keep?");
    expect(codexTailPendingApproval([
      ev("task_started"),
      request,
      item("function_call_output", { call_id: "q1", output: '{"answers":{}}' }),
    ].join("\n"))).toBe(false);
    expect(codexTailPendingUserInputDetail([
      request,
      item("function_call_output", { call_id: "q1", output: '{"answers":{}}' }),
    ].join("\n"))).toBeUndefined();
    expect(codexTailPendingAttentionKind([
      request,
      item("function_call_output", { call_id: "q1", output: '{"answers":{}}' }),
    ].join("\n"))).toBeUndefined();
  });

  test("request_user_input preview is tolerant, whitespace-cleaned, and bounded", () => {
    expect(requestUserInputDetail({ questions: [{ header: "  Scope ", question: " Keep   the API? " }] }))
      .toBe("Scope: Keep the API?");
    expect(requestUserInputDetail(JSON.stringify({ questions: [{ header: "", question: "Use SQLite?" }] })))
      .toBe("Use SQLite?");
    expect(requestUserInputDetail({ questions: [{ header: "Scope", question: "Scope: Keep it?" }] }))
      .toBe("Scope: Keep it?");
    expect(requestUserInputDetail({ questions: [{ header: "Long", question: "x".repeat(300) }] })?.length)
      .toBe(240);
    const emojiBoundary = requestUserInputDetail({ questions: [{ question: `${"x".repeat(238)}😀tail` }] });
    expect(emojiBoundary).toBe(`${"x".repeat(238)}😀…`);
    expect(emojiBoundary).not.toContain("\ud83d…");
    expect(requestUserInputDetail("not-json")).toBeUndefined();
    expect(requestUserInputDetail({ questions: [] })).toBeUndefined();
  });

  test("ordinary pending function calls are not mistaken for user input", () => {
    expect(codexTailPendingApproval(item("function_call", { name: "shell", call_id: "c1" }))).toBe(false);
    expect(codexTailPendingApproval(item("function_call", { name: "apply_patch", call_id: "c2" }))).toBe(false);
    expect(codexTailPendingAttentionKind(item("function_call", { name: "shell", call_id: "c1" }))).toBeUndefined();
    expect(codexTailPendingAttentionKind(ev("exec_approval_request", { call_id: "c1" }))).toBeUndefined();
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
    const args = JSON.stringify({ questions: [{ header: "Mode", question: "Fast or safe?" }] });
    expect(codexAdapter.tailPendingAttentionDetail!(item("function_call", {
      name: "request_user_input", arguments: args,
    }))).toBe("Mode: Fast or safe?");
    expect(codexAdapter.tailPendingAttentionKind!(item("function_call", {
      name: "request_user_input", arguments: "not-json",
    }))).toBe("userInput");
  });
});

// --- claude pending-approval detection (dropped PreToolUse backstop) --------------------------
//
// On Claude a user-blocking tool (AskUserQuestion / ExitPlanMode) surfaces needsAttention via the
// PreToolUse hook (hook.ts planOp). If that hook is dropped, the watchdog backstops it by scanning the
// transcript tail: "pending" = the LAST assistant turn issues a user-blocking tool_use with no later
// tool_result answering it. A merely long-running tool (Bash) has a tool_use with no result too, so the
// name gate is what keeps it from false-flagging.
describe("claudeTailPendingApproval (dropped-PreToolUse backstop classifier) + adapter capability", () => {
  const asstTool = (name: string, id: string) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] } });
  const asstText = (text: string) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  const toolResult = (id: string) =>
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

  test("a blocked AskUserQuestion / ExitPlanMode with no answer → pending (true)", () => {
    expect(claudeTailPendingApproval(asstTool("AskUserQuestion", "toolu_1"))).toBe(true);
    expect(claudeTailPendingApproval(asstTool("ExitPlanMode", "toolu_p"))).toBe(true);
    // text alongside the tool_use in the same assistant turn is fine
    expect(claudeTailPendingApproval(JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "which?" }, { type: "tool_use", id: "toolu_2", name: "AskUserQuestion", input: {} }] },
    }))).toBe(true);
  });

  test("an ANSWERED question (tool_result follows) → not pending (false)", () => {
    expect(claudeTailPendingApproval([asstTool("AskUserQuestion", "toolu_1"), toolResult("toolu_1")].join("\n"))).toBe(false);
    // and once Claude has moved on to a plain-text turn after the answer → still not pending
    expect(claudeTailPendingApproval([asstTool("AskUserQuestion", "toolu_1"), toolResult("toolu_1"), asstText("thanks")].join("\n"))).toBe(false);
  });

  test("an ordinary pending tool_use (long-running Bash, no result) → NOT pending (false)", () => {
    expect(claudeTailPendingApproval(asstTool("Bash", "toolu_b"))).toBe(false);
    expect(claudeTailPendingApproval(asstTool("Task", "toolu_t"))).toBe(false);
  });

  test("a NEW question after an earlier answered one → pending again (true)", () => {
    expect(claudeTailPendingApproval([
      asstTool("AskUserQuestion", "toolu_1"), toolResult("toolu_1"),
      asstTool("AskUserQuestion", "toolu_2"),
    ].join("\n"))).toBe(true);
  });

  test("sidechain (subagent) rows are ignored — not the session's own block state", () => {
    const sideAsk = JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "AskUserQuestion", input: {} }] } });
    expect(claudeTailPendingApproval(sideAsk)).toBe(false);
  });

  test("malformed / empty / byte-sliced tail → false (tolerated, never throws)", () => {
    expect(claudeTailPendingApproval("")).toBe(false);
    expect(claudeTailPendingApproval("not json at all")).toBe(false);
    // a byte-sliced leading fragment is skipped; the intact trailing blocked question still counts
    expect(claudeTailPendingApproval(['{"type":"assist', asstTool("AskUserQuestion", "toolu_9")].join("\n"))).toBe(true);
  });

  test("claudeAdapter.tailShowsPendingApproval delegates to the classifier", () => {
    expect(claudeAdapter.tailShowsPendingApproval!(asstTool("AskUserQuestion", "x"))).toBe(true);
    expect(claudeAdapter.tailShowsPendingApproval!(asstTool("Bash", "y"))).toBe(false);
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
  const promptInput = { hook_event_name: "UserPromptSubmit", prompt: "real ask" };
  const userMessage = JSON.stringify({
    timestamp: "2026-07-10T00:00:01Z",
    type: "event_msg",
    payload: { type: "user_message", message: "real ask" },
  });

  test("the observed ghost: empty transcript, no transcript path, no rollout → skipped", async () => {
    expect(await codexInternalSessionGhost(ghostId, "", "", { rolloutExists: async () => false })).toBe(true);
    // whitespace-only prefix is still "no rollout content"
    expect(await codexInternalSessionGhost(ghostId, "  \n ", "", { rolloutExists: async () => false })).toBe(true);
  });

  test("a legit first prompt with a rollout file already on disk is mirrored", async () => {
    expect(await codexInternalSessionGhost("real-id", "", "", { rolloutExists: async () => true }, promptInput)).toBe(false);
  });

  test("rollout user_message content mirrors immediately — neither fs probe is consulted", async () => {
    let statted = false, scanned = false;
    expect(await codexInternalSessionGhost("real-id", userMessage, "/some/rollout.jsonl", {
      statOf: async () => { statted = true; return {}; },
      rolloutExists: async () => { scanned = true; return false; },
    })).toBe(false);
    expect(statted).toBe(false);
    expect(scanned).toBe(false);
  });

  test("a first prompt plus existing transcript_path mirrors without the scan", async () => {
    let scanned = false;
    expect(await codexInternalSessionGhost("real-id", "", "/rollout/on/disk.jsonl", {
      statOf: async () => ({}),
      rolloutExists: async () => { scanned = true; return false; },
    }, promptInput)).toBe(false);
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
    }, promptInput)).toBe(false);
  });

  test("DEFER, not verdict: the same session mirrors on its next hook once the rollout appears", async () => {
    let rolloutOnDisk = false; // hook 1 races the first flush → no rollout yet → first frame deferred
    const deps = { rolloutExists: async () => rolloutOnDisk };
    expect(await codexInternalSessionGhost("racy-id", "", "", deps, promptInput)).toBe(true);
    rolloutOnDisk = true;      // hook 2 (same turn, moments later): the rollout is on disk now
    expect(await codexInternalSessionGhost("racy-id", "", "", deps, promptInput)).toBe(false);
  });

  test("a throwing locator is NO evidence → defer (self-heals; never throws out)", async () => {
    expect(await codexInternalSessionGhost("x", "", "", {
      rolloutExists: async () => { throw new Error("boom"); },
    })).toBe(true);
  });

  test("codexAdapter implements the seam; claudeAdapter omits it", () => {
    expect(typeof codexAdapter.isInternalSessionGhost).toBe("function");
    expect(typeof codexAdapter.sessionCreationSuppression).toBe("function");
    expect(claudeAdapter.isInternalSessionGhost).toBeUndefined();
    expect(claudeAdapter.sessionCreationSuppression).toBeUndefined();
  });
});

describe("Codex rollout create suppression (subagents + promptless deferral)", () => {
  const sessionMeta = (source: unknown): string => JSON.stringify({
    timestamp: "2026-07-29T00:00:00Z",
    type: "session_meta",
    payload: { id: "s", source },
  });

  test("guardian and any other subagent source variant are permanently suppressed", async () => {
    const guardian = sessionMeta({ subagent: { other: "guardian" } });
    expect(codexRolloutCreationEvidence(guardian)).toEqual({ subagent: true, hasUserMessage: false, headlessExec: false });
    expect(await codexSessionCreationSuppression(
      "guardian", guardian, "/rollout.jsonl",
      { hook_event_name: "SessionStart", parent_thread_id: "parent" },
    )).toMatchObject({ guard: "codex-subagent-rollout" });
    // Even a later prompt cannot promote an internal subagent thread to a visible phone row.
    expect(await codexSessionCreationSuppression(
      "guardian", guardian, "/rollout.jsonl",
      { hook_event_name: "UserPromptSubmit", prompt: "internal review" },
    )).toMatchObject({ guard: "codex-subagent-rollout" });
  });

  test("a promptless app-server rollout is deferred, then the first real hook prompt creates it", async () => {
    const promptless = sessionMeta("vscode");
    expect(await codexSessionCreationSuppression(
      "app-thread", promptless, "/rollout.jsonl", { hook_event_name: "SessionStart" },
    )).toMatchObject({ guard: "codex-promptless-rollout" });
    expect(await codexSessionCreationSuppression(
      "app-thread", promptless, "/rollout.jsonl",
      { hook_event_name: "UserPromptSubmit", prompt: "Fix the real bug" },
    )).toBeNull();
  });

  test("a durable rollout user_message is sufficient even when the current hook has no prompt field", async () => {
    const prefix = [
      sessionMeta("vscode"),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Hello" } }),
    ].join("\n");
    expect(codexRolloutCreationEvidence(prefix)).toEqual({ subagent: false, hasUserMessage: true, headlessExec: false });
    expect(await codexSessionCreationSuppression(
      "real", prefix, "/rollout.jsonl", { hook_event_name: "PreToolUse" },
    )).toBeNull();
  });

  test("codex exec session_meta is authoritative headless evidence even with a real user_message", async () => {
    const prefix = [
      JSON.stringify({ type: "session_meta", payload: {
        id: "exec-1", originator: "codex_exec", source: "exec", thread_source: "user",
      } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "review this" } }),
    ].join("\n");
    expect(codexRolloutCreationEvidence(prefix)).toEqual({
      subagent: false, hasUserMessage: true, headlessExec: true,
    });
    expect(await codexSessionCreationSuppression(
      "exec-1", prefix, "/tmp/rollout.jsonl", { hook_event_name: "UserPromptSubmit", prompt: "review this" },
    )).toEqual({
      guard: "codex-headless-exec",
      reason: "session_meta identifies a non-interactive codex exec run",
    });
  });

  test("ordinary interactive metadata remains admitted (missing exec proof fails open)", async () => {
    const prefix = [
      JSON.stringify({ type: "session_meta", payload: { id: "interactive-1", source: "vscode", originator: "Claude Code" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "real prompt" } }),
    ].join("\n");
    expect(codexRolloutCreationEvidence(prefix)).toEqual({
      subagent: false, hasUserMessage: true, headlessExec: false,
    });
    expect(await codexSessionCreationSuppression(
      "interactive-1", prefix, "/tmp/rollout.jsonl", { hook_event_name: "UserPromptSubmit", prompt: "real prompt" },
    )).toBeNull();
  });
});

// --- Headless/daemon `claude` invocation guard (phantom-row prevention) ------------------------
//
// A `claude` that loads plugins but isn't a human's interactive session (claude-mem's stream-json
// observation runs, or any tool shelling out to headless Claude) fires hooks under a session id that
// never gets a Stop. The classifier fingerprints it from the invoking process's argv + ancestor chain.

/** Run `fn` with `CLAUDE_CODE_ENTRYPOINT` pinned (undefined = unset), then restore it. The adapter
 *  seams read that var from process.env, and `bun test` inherits whatever entrypoint the Claude Code
 *  session running the suite has — so every seam assertion must pin it or it is a coin flip. */
function withEntrypoint<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.CLAUDE_CODE_ENTRYPOINT;
  if (value === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
  else process.env.CLAUDE_CODE_ENTRYPOINT = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = prev;
  }
}

describe("claudeHeadlessInvocation (skip a non-interactive / daemon-spawned claude)", () => {
  test("interactive TUI (a bare `claude`, no ancestors match) → not headless", () => {
    expect(claudeHeadlessInvocation("/usr/local/bin/claude", [])).toBe(false);
    expect(claudeHeadlessInvocation("claude", ["/bin/zsh -l", "/sbin/launchd"])).toBe(false);
  });

  test("headless flags on the invoking claude → headless", () => {
    expect(claudeHeadlessInvocation("claude --output-format stream-json --verbose", [])).toBe(true);
    expect(claudeHeadlessInvocation("claude -p 'summarize this'", [])).toBe(true);
    expect(claudeHeadlessInvocation("claude --print", [])).toBe(true);
  });

  test("a known daemon shape ANYWHERE in the chain (self or ancestor) → headless", () => {
    expect(claudeHeadlessInvocation("claude", ["node /Users/x/.claude-mem/worker-service.js"])).toBe(true);
    expect(claudeHeadlessInvocation("claude-mem run", [])).toBe(true);
    expect(claudeHeadlessInvocation("claude", ["daemon run --origin transient"])).toBe(true);
    expect(claudeHeadlessInvocation("claude", ["bg-pty-host --socket x"])).toBe(true);
    expect(claudeHeadlessInvocation("claude", ["bg-spare"])).toBe(true);
  });

  test("fork/reply replay is headless as a pair; an ordinary interactive fork alone is not", () => {
    expect(claudeHeadlessInvocation("claude --fork-session --resume old.jsonl --reply-on-resume", [])).toBe(true);
    expect(claudeHeadlessInvocation("claude --fork-session --resume old.jsonl", [])).toBe(false);
  });

  test("tokenized flag match — a path merely CONTAINING '-p' can't false-trigger", () => {
    expect(claudeHeadlessInvocation("/opt/my-project/bin/claude", [])).toBe(false);
    expect(claudeHeadlessInvocation("claude --model opus-p", [])).toBe(false);
  });

  test("an unknown invoker (ps failed → undefined) is NOT treated as headless", () => {
    expect(claudeHeadlessInvocation(undefined, [undefined])).toBe(false);
  });

  test("claudeAdapter wires the seam (codex omits it); it walks pid → command via the injected readers", () => {
    expect(typeof claudeAdapter.isHeadlessInvocation).toBe("function");
    expect(codexAdapter.isHeadlessInvocation).toBeUndefined();
    const commands: Record<number, string> = { 100: "claude --output-format stream-json", 200: "node worker-service.js" };
    expect(withEntrypoint("cli", () => claudeAdapter.isHeadlessInvocation!({
      pid: 100, ancestorsOf: () => [200], commandOf: (p) => commands[p],
    }))).toBe(true);
    const interactive: Record<number, string> = { 100: "claude", 200: "/bin/zsh" };
    expect(withEntrypoint("cli", () => claudeAdapter.isHeadlessInvocation!({
      pid: 100, ancestorsOf: () => [200], commandOf: (p) => interactive[p],
    }))).toBe(false);
  });
});

// --- Claude DESKTOP app sessions must mirror (they are human interactive sessions) --------------
//
// The desktop app runs a bundled `claude` per conversation window, tty-less, with an argv that trips
// BOTH headless branches: `--output-format stream-json` (headless token) and
// `--plugin-dir …/claude-mem/<version>` (a launcher marker matched inside a flag VALUE). It must be
// allow-listed — but its bundled binary ALSO self-forks the `--bg-spare` / `--bg-pty-host` ring under
// the very same ancestry, and those must stay suppressed.

describe("claudeHeadlessInvocation — Claude desktop app (bundled binary under the disclaimer launcher)", () => {
  const bundled = "/Users/karrix/Library/Application Support/Claude/claude-code/2.1.227/claude.app/Contents/MacOS/claude";
  const desktopAncestors = [
    "/Applications/Claude.app/Contents/Helpers/disclaimer /Users/karrix/Library/Application Support/Claude/claude-code/2.1.227/claude.app/Contents/MacOS/claude",
    "/Applications/Claude.app/Contents/MacOS/Claude",
  ];
  /** The live desktop argv (pid 1426), including the claude-mem --plugin-dir that is the whole bug. */
  const desktopArgs = (extra = ""): string =>
    `${bundled} --output-format stream-json --verbose --input-format stream-json --effort high` +
    ` --model claude-opus-4-8 --permission-prompt-tool stdio${extra ? ` ${extra}` : ""}` +
    " --allowedTools mcp__computer-use,mcp__web" +
    " --setting-sources=user,project,local --permission-mode auto --include-partial-messages" +
    " --plugin-dir /Users/karrix/.claude/plugins/cache/thedotmack/claude-mem/13.12.4" +
    " --plugin-dir /Users/karrix/.claude/plugins/cache/karrixlee/nomo/2.0.1" +
    " --thinking-display summarized --replay-user-messages --settings {}";
  /** claude-mem's observer run: PATH claude, not the bundled binary. */
  const observerArgs = "/Users/karrix/.local/bin/claude --output-format stream-json --verbose" +
    " --input-format stream-json --model claude-sonnet-4-6 --permission-prompt-tool stdio" +
    " --permission-mode dontAsk --no-session-persistence";
  const observerAncestors = [
    "/Users/karrix/.bun/bin/bun /Users/karrix/.claude/plugins/cache/thedotmack/claude-mem/13.12.4/scripts/worker-service.cjs --daemon",
  ];

  test("a real desktop session mirrors — first start AND resume", () => {
    expect(claudeHeadlessInvocation(desktopArgs(), desktopAncestors)).toBe(false);
    expect(claudeHeadlessInvocation(
      desktopArgs("--resume=ef0bb7c5-d12e-4763-82a5-0d03999ed407"), desktopAncestors,
    )).toBe(false);
  });

  test("the allow-list is version- and location-agnostic", () => {
    const future = desktopArgs().replace("claude-code/2.1.227/", "claude-code/9.9.999/");
    expect(claudeHeadlessInvocation(future, desktopAncestors)).toBe(false);
    const relocated = desktopAncestors.map((a) => a.replace("/Applications/", "/Users/karrix/Applications/"));
    expect(claudeHeadlessInvocation(desktopArgs(), relocated)).toBe(false);
  });

  test("a user folder whose NAME contains a launcher marker can't re-suppress the desktop", () => {
    expect(claudeHeadlessInvocation(
      desktopArgs(`--add-dir "/Users/karrix/Downloads/some claude-mem folder"`), desktopAncestors,
    )).toBe(false);
  });

  test("the desktop's own detached spare ring stays suppressed (allow-list must not rescue it)", () => {
    expect(claudeHeadlessInvocation(`${bundled} --bg-spare 3`, desktopAncestors)).toBe(true);
    expect(claudeHeadlessInvocation(desktopArgs(), [...desktopAncestors, `${bundled} --bg-pty-host`])).toBe(true);
    expect(claudeHeadlessInvocation(desktopArgs(), [...desktopAncestors, "claude daemon run --origin transient"])).toBe(true);
    expect(claudeHeadlessInvocation(
      `${bundled} --fork-session --resume old.jsonl --reply-on-resume`, desktopAncestors,
    )).toBe(true);
  });

  test("claude-mem's observer stays suppressed even when the desktop app is its ancestor", () => {
    expect(claudeHeadlessInvocation(observerArgs, observerAncestors)).toBe(true);
    expect(claudeHeadlessInvocation(observerArgs, [...observerAncestors, ...desktopAncestors])).toBe(true);
  });

  test("half a match is no match, in either direction", () => {
    expect(claudeHeadlessInvocation(desktopArgs(), ["/bin/zsh -l"])).toBe(true); // bundled, no disclaimer
    expect(claudeHeadlessInvocation(observerArgs, desktopAncestors)).toBe(true); // disclaimer, PATH claude
    expect(claudeDesktopInvocation(desktopArgs(), ["/bin/zsh -l"])).toBe(false);
    expect(claudeDesktopInvocation(observerArgs, desktopAncestors)).toBe(false);
    expect(claudeDesktopInvocation(desktopArgs(), desktopAncestors)).toBe(true);
    expect(claudeDesktopInvocation(undefined, [undefined])).toBe(false);
  });

  test("terminal sessions are untouched", () => {
    expect(claudeHeadlessInvocation("claude", ["/bin/zsh -l", "/opt/homebrew/bin/herdr", "ghostty"])).toBe(false);
    expect(claudeHeadlessInvocation("claude --resume ef0bb7c5-d12e-4763-82a5-0d03999ed407", ["/bin/zsh -l"])).toBe(false);
    expect(claudeHeadlessInvocation("claude -p 'x'", ["/bin/zsh -l"])).toBe(true);
    expect(claudeHeadlessInvocation("claude --print", ["/bin/zsh -l"])).toBe(true);
  });

  test("claudeAdapter wires the desktop seam (codex omits it)", () => {
    expect(codexAdapter.isDesktopInvocation).toBeUndefined();
    const commands: Record<number, string> = { 100: desktopArgs(), 200: desktopAncestors[0]!, 300: desktopAncestors[1]! };
    expect(withEntrypoint(undefined, () => claudeAdapter.isDesktopInvocation!({
      pid: 100, ancestorsOf: () => [200, 300], commandOf: (p) => commands[p],
    }))).toBe(true);
    expect(withEntrypoint("cli", () => claudeAdapter.isDesktopInvocation!({
      pid: 100, ancestorsOf: () => [], commandOf: () => "claude",
    }))).toBe(false);
  });

  // --- CLAUDE_CODE_ENTRYPOINT: the primary signal, the paths demoted to fallback ------------------
  //
  // Claude Code stamps `CLAUDE_CODE_ENTRYPOINT` into the env it spawns hooks with ("claude-desktop"
  // for an app conversation window, "cli" for a terminal one) and children inherit it. It beats argv
  // archaeology on every axis — no version segment, no bundle location, no ancestor walk, and it is
  // the ONLY one of the two that can work on Windows, where the ps-based readers return nothing.

  test("the entrypoint alone identifies the desktop — no path anchors needed (Windows, relocated bundle, future layout)", () => {
    expect(claudeDesktopInvocation("claude", [], "claude-desktop")).toBe(true);
    expect(claudeDesktopInvocation(undefined, [undefined], "claude-desktop")).toBe(true);
    expect(claudeDesktopInvocation(
      "C:\\Users\\k\\AppData\\Local\\Claude\\claude.exe --output-format stream-json", [], "claude-desktop",
    )).toBe(true);
    expect(claudeHeadlessInvocation("claude --output-format stream-json", [], "claude-desktop")).toBe(false);
    expect(withEntrypoint("claude-desktop", () => claudeAdapter.isDesktopInvocation!({
      pid: 100, ancestorsOf: () => [], commandOf: () => "claude",
    }))).toBe(true);
  });

  test("a NON-desktop entrypoint is not a desktop verdict on an ordinary invoker", () => {
    expect(claudeDesktopInvocation("claude", ["/bin/zsh -l"], "cli")).toBe(false);
    expect(claudeHeadlessInvocation(observerArgs, observerAncestors, "cli")).toBe(true);
    expect(claudeHeadlessInvocation("claude -p 'x'", ["/bin/zsh -l"], "cli")).toBe(true);
    expect(claudeHeadlessInvocation("claude", ["/bin/zsh -l"], "cli")).toBe(false);
  });

  test("the path anchors still stand alone when the env var is missing or empty (the deliberate fallback)", () => {
    // claude-status-bar carries the last known entrypoint forward "for the odd event where the env
    // var isn't set" — direct evidence from a shipping project that it is sometimes absent. Without
    // this fallback the suppressed-desktop bug would come back INTERMITTENTLY.
    expect(claudeDesktopInvocation(desktopArgs(), desktopAncestors, undefined)).toBe(true);
    expect(claudeDesktopInvocation(desktopArgs(), desktopAncestors, "")).toBe(true);
    expect(claudeHeadlessInvocation(desktopArgs(), desktopAncestors, undefined)).toBe(false);
    expect(claudeHeadlessInvocation(desktopArgs(), desktopAncestors, "")).toBe(false);
  });

  test("the anchors are a FALLBACK, not a veto: a `cli` entrypoint on the bundled binary is still desktop", () => {
    // A cli entrypoint on the bundled binary under `disclaimer` ancestry does not occur in reality;
    // where both signals somehow disagree, trusting the paths keeps a real conversation window
    // mirroring, which is the conservative failure direction (the bug this whole guard fixes).
    expect(claudeDesktopInvocation(desktopArgs(), desktopAncestors, "cli")).toBe(true);
    expect(claudeHeadlessInvocation(desktopArgs(), desktopAncestors, "cli")).toBe(false);
  });

  test("ORDERING: a desktop entrypoint must NOT rescue the self-forked spare ring", () => {
    // The spare ring is forked BY the desktop binary, so it inherits the desktop entrypoint too.
    // CLAUDE_SELF_DAEMON_MARKERS are checked first and unconditionally for exactly this reason —
    // consulting the entrypoint any earlier would resurrect every one of these phantoms.
    expect(claudeHeadlessInvocation(`${bundled} --bg-spare 3`, desktopAncestors, "claude-desktop")).toBe(true);
    expect(claudeHeadlessInvocation("claude --bg-spare 3", [], "claude-desktop")).toBe(true);
    expect(claudeHeadlessInvocation(desktopArgs(), [...desktopAncestors, `${bundled} --bg-pty-host`], "claude-desktop")).toBe(true);
    expect(claudeHeadlessInvocation(desktopArgs(), [...desktopAncestors, "claude daemon run --origin transient"], "claude-desktop")).toBe(true);
    expect(claudeHeadlessInvocation(
      `${bundled} --fork-session --resume old.jsonl --reply-on-resume`, desktopAncestors, "claude-desktop",
    )).toBe(true);
  });
});

describe("Claude fork/clear lineage classifiers", () => {
  const oldId = "11111111-2222-4333-8444-555555555555";
  const newId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  test("fork replay extracts the predecessor transcript id without blanket-matching normal resume/fork", () => {
    expect(claudeForkResumePredecessor(
      `claude --fork-session --resume /Users/x/.claude/projects/p/${oldId}.jsonl --reply-on-resume`,
    )).toBe(oldId);
    expect(claudeForkResumePredecessor(
      `claude --fork-session --resume="/Users/x/a b/${oldId}.jsonl" --reply-on-resume`,
    )).toBe(oldId);
    expect(claudeForkResumePredecessor(`claude --resume ${oldId}`)).toBeUndefined();
    expect(claudeForkResumePredecessor(`claude --fork-session --resume ${oldId}.jsonl`)).toBeUndefined();
  });

  test("a fork re-emission resolves to an already-tracked predecessor instead of a duplicate id", () => {
    const command = `claude --fork-session --resume /tmp/${oldId}.jsonl --reply-on-resume`;
    const predecessor = claudeAdapter.forkResumePredecessor!(command);
    const tracked = new Set([oldId]);
    const effective = predecessor && tracked.has(predecessor) ? predecessor : newId;
    expect(effective).toBe(oldId);
    expect(effective).not.toBe(newId);
  });

  test("clear retires the newest same-pid Claude predecessor only", () => {
    const tracked: TrackedSessionLite[] = [
      { sessionId: oldId, pid: 42, ts: 10 },
      { sessionId: "newer-old", pid: 42, ts: 20 },
      { sessionId: "codex", pid: 42, ts: 30, agent: "codex" },
      { sessionId: "other-pid", pid: 99, ts: 40 },
    ];
    expect(claudeClearPredecessor(newId, 42, tracked)).toBe("newer-old");
    expect(claudeAdapter.clearPredecessor!({ sessionId: newId, hookPid: 42, tracked })).toBe("newer-old");
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

// --- TUI locate (the per-agent half of the phone's "focus this session's terminal") -----------
//
// Precision is the whole point: every ambiguity must return undefined rather than raise SOME window.
// The fixture is the same real `ps` output the discovery tests use — two interactive codex TUIs plus
// the tty-less app-server daemons — and every seam (ps / lsof / ps -o lstart / ps -o tty) is injected.

const locRec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  pid: 999_999, machine: "mac", label: "proj", ts: 1_000_000, agent: "codex", ...over,
});

/** One-codex-TUI process table (for the single-candidate fallback). */
const PS_ONE_TUI = [
  " 8750 ??       /Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled",
  "16029 ttys017  codex",
].join("\n");

describe("codexTuiCandidates (the tty-preserving primitive under filterCodexTuis)", () => {
  test("keeps each survivor's tty, and filterCodexTuis stays the pid-only projection of it", () => {
    expect(codexTuiCandidates(parseCodexProcs(PS_FIXTURE), new Set())).toEqual([
      { pid: 16029, tty: "ttys017" },
      { pid: 33198, tty: "ttys018" },
    ]);
    expect(filterCodexTuis(parseCodexProcs(PS_FIXTURE), new Set())).toEqual([{ pid: 16029 }, { pid: 33198 }]);
  });
});

describe("codexLocateTuiPid (ordered correlation heuristic)", () => {
  const notes: string[] = [];
  const note = (r: LocateTuiReason): void => { notes.push(r); };
  const ps = async (): Promise<string> => PS_FIXTURE;

  test("1. the record's own pid IS a live TUI → that process, nothing else consulted", async () => {
    notes.length = 0;
    let lsofCalls = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 33198 }) },
      { ps, cwdOf: async () => { lsofCalls++; return "/x"; }, note },
    );
    expect(pid).toBe(33198);
    expect(notes).toEqual(["record-pid"]);
    expect(lsofCalls).toBe(0);
  });

  test("2. the codex-pid-<n> discovery sentinel names a live TUI", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "codex-pid-16029", record: locRec({ pid: 42 }) },
      { ps, note },
    );
    expect(pid).toBe(16029);
    expect(notes).toEqual(["sentinel-pid"]);
  });

  test("2b. a sentinel naming a DEAD pid falls through (it is not a candidate)", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "codex-pid-70000", record: locRec({ pid: 42 }) },
      { ps, note },
    );
    expect(pid).toBeUndefined();
    expect(notes).toEqual(["ambiguous"]); // two live TUIs, nothing to correlate on
  });

  test("3. exactly one candidate runs in the record's origin cwd", async () => {
    notes.length = 0;
    const cwds: Record<number, string> = { 16029: "/Users/karrix/api-status/nomo", 33198: "/Users/karrix/WidgetAnimation" };
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 42, origin: { hook_event_name: "SessionStart", ppid: 42, cwd: "/Users/karrix/WidgetAnimation" } }) },
      { ps, cwdOf: async (p) => cwds[p], note },
    );
    expect(pid).toBe(33198);
    expect(notes).toEqual(["cwd-unique"]);
  });

  test("3b. TWO candidates in the same cwd and no session start → ambiguous, no guess", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 42, origin: { hook_event_name: "SessionStart", ppid: 42, cwd: "/repo" } }) },
      { ps, cwdOf: async () => "/repo", note },
    );
    expect(pid).toBeUndefined();
    expect(notes).toEqual(["ambiguous"]);
  });

  test("3c. a cwd that matches NOTHING leaves the subset empty → the whole-machine fallback rules", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 42, origin: { hook_event_name: "SessionStart", ppid: 42, cwd: "/gone" } }) },
      { ps, cwdOf: async () => "/elsewhere", note },
    );
    expect(pid).toBeUndefined(); // two TUIs on the machine → still ambiguous
    expect(notes).toEqual(["ambiguous"]);
  });

  test("4. start-time proximity breaks a cwd tie — STRICTLY closest wins", async () => {
    notes.length = 0;
    const starts: Record<number, number> = { 16029: 1_000_000, 33198: 1_009_000 };
    const pid = await codexLocateTuiPid(
      {
        sessionId: "some-uuid",
        record: locRec({ pid: 42, sessionStartedAt: 1_008_000, origin: { hook_event_name: "SessionStart", ppid: 42, cwd: "/repo" } }),
      },
      { ps, cwdOf: async () => "/repo", startTimeOf: async (p) => starts[p], note },
    );
    expect(pid).toBe(33198);
    expect(notes).toEqual(["start-time"]);
  });

  test("4b. two candidates EQUALLY close → undefined (a coin flip is worse than a no-op)", async () => {
    notes.length = 0;
    const starts: Record<number, number> = { 16029: 900, 33198: 1100 };
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 42, sessionStartedAt: 1000 }) },
      { ps, startTimeOf: async (p) => starts[p], note },
    );
    expect(pid).toBeUndefined();
    expect(notes).toEqual(["ambiguous"]);
  });

  test("4c. no resolvable start times → undefined, never a fallback guess between two TUIs", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 42, sessionStartedAt: 1000 }) },
      { ps, startTimeOf: async () => undefined, note },
    );
    expect(pid).toBeUndefined();
    expect(notes).toEqual(["ambiguous"]);
  });

  test("5. nothing correlates, but the machine has exactly ONE codex TUI → that one", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 42 }) },
      { ps: async () => PS_ONE_TUI, note },
    );
    expect(pid).toBe(16029);
    expect(notes).toEqual(["only-candidate"]);
  });

  test("no live codex TUI at all → undefined", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 42 }) },
      { ps: async () => " 8750 ??       /Applications/Codex.app/Contents/Resources/codex app-server", note },
    );
    expect(pid).toBeUndefined();
    expect(notes).toEqual(["no-candidate"]);
  });

  test("a failing `ps` is evidence-free, never a guess", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 42 }) },
      { ps: async () => { throw new Error("no ps"); }, note },
    );
    expect(pid).toBeUndefined();
    expect(notes).toEqual(["error"]);
  });

  test("a throwing lsof degrades that candidate to 'no cwd', it does not abort the locate", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 42, origin: { hook_event_name: "SessionStart", ppid: 42, cwd: "/repo" } }) },
      {
        ps,
        cwdOf: async (p) => { if (p === 16029) throw new Error("lsof denied"); return "/repo"; },
        note,
      },
    );
    expect(pid).toBe(33198);
    expect(notes).toEqual(["cwd-unique"]);
  });

  test("a throwing note sink can never break a locate", async () => {
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 16029 }) },
      { ps, note: () => { throw new Error("bad sink"); } },
    );
    expect(pid).toBe(16029);
  });
});

// FIELD REGRESSION: "Open on Mac" was a silent no-op for every session started in the Codex DESKTOP
// app. Its conversation is hosted by a tty-less `codex app-server`, which codexTuiCandidates drops by
// design, so the locate found nothing — and on a machine that also had ONE terminal codex open, step 5
// would have raised THAT window instead, which is worse than nothing.
describe("codexLocateTuiPid — the Codex DESKTOP app (no terminal exists)", () => {
  const notes: LocateTuiReason[] = [];
  const note = (r: LocateTuiReason): void => { notes.push(r); };

  const meta = (originator: string): string =>
    JSON.stringify({ type: "session_meta", payload: { originator, cwd: "/Users/karrix/Documents/Codex/x" } });

  /** The desktop app's live process shape. The renderer helper also lives under ChatGPT.app and also
   *  ends in `/Contents/MacOS/…`, so it pins that only the app's OWN executable path is matched. */
  const PS_DESKTOP = [
    "83329 ??       /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    "83396 ??       /Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server",
    "83409 ??       /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/151.0/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer",
    "16029 ttys017  codex",
  ].join("\n");

  test("a desktop session resolves to the app's own GUI process, not to any helper", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 83396, transcript: "/r.jsonl" }) },
      { ps: async () => PS_DESKTOP, readHead: async () => meta("Codex Desktop"), note },
    );
    expect(pid).toBe(83329);
    expect(notes).toEqual(["desktop-app"]);
  });

  test("the app's older `codex_work_desktop` stamp resolves identically", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 83396, transcript: "/r.jsonl" }) },
      { ps: async () => PS_DESKTOP, readHead: async () => meta("codex_work_desktop"), note },
    );
    expect(pid).toBe(83329);
  });

  test("a desktop session NEVER falls through to a lone terminal TUI (the wrong-window guard)", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 83396, transcript: "/r.jsonl" }) },
      { ps: async () => PS_ONE_TUI, readHead: async () => meta("Codex Desktop"), note },
    );
    expect(pid).toBeUndefined(); // app not running → nothing to raise
    expect(notes).toEqual(["no-candidate"]);
  });

  test("a terminal session's rollout leaves the ordered heuristic exactly as it was", async () => {
    notes.length = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 42, transcript: "/r.jsonl" }) },
      { ps: async () => PS_ONE_TUI, readHead: async () => meta("codex-tui"), note },
    );
    expect(pid).toBe(16029);
    expect(notes).toEqual(["only-candidate"]);
  });

  test("an unreadable or absent rollout is no evidence, not a verdict", async () => {
    notes.length = 0;
    expect(await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 42, transcript: "/gone.jsonl" }) },
      { ps: async () => PS_ONE_TUI, readHead: async () => { throw new Error("ENOENT"); }, note },
    )).toBe(16029);
    expect(await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 42 }) },
      { ps: async () => PS_ONE_TUI, readHead: async () => meta("Codex Desktop"), note },
    )).toBe(16029);
    expect(notes).toEqual(["only-candidate", "only-candidate"]);
  });

  test("an exact pid hit never pays for the rollout read", async () => {
    notes.length = 0;
    let reads = 0;
    const pid = await codexLocateTuiPid(
      { sessionId: "some-uuid", record: locRec({ pid: 16029, transcript: "/r.jsonl" }) },
      { ps: async () => PS_ONE_TUI, readHead: async () => { reads++; return meta("Codex Desktop"); }, note },
    );
    expect(pid).toBe(16029);
    expect(reads).toBe(0);
    expect(notes).toEqual(["record-pid"]);
  });

  test("only a Mac-app front-end counts as desktop — an editor's or an MCP client's does not", () => {
    expect(codexDesktopOriginator(meta("Codex Desktop"))).toBe(true);
    for (const other of ["codex-tui", "codex_exec", "Claude Code", "nomo", ""]) {
      expect(codexDesktopOriginator(meta(other))).toBe(false);
    }
    expect(codexDesktopOriginator("not json at all")).toBe(false);
  });

  test("codexDesktopAppPid refuses to guess between two app processes", () => {
    expect(codexDesktopAppPid(parseCodexProcs(PS_DESKTOP))).toBe(83329);
    expect(codexDesktopAppPid([
      { pid: 1, args: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
      { pid: 2, args: "/Users/x/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
    ])).toBeUndefined();
    expect(codexDesktopAppPid(parseCodexProcs(PS_ONE_TUI))).toBeUndefined();
  });
});

describe("claudeLocateTuiPid (the recorded pid IS the TUI)", () => {
  test("returns the recorded pid when it still holds a real controlling tty", async () => {
    const notes: LocateTuiReason[] = [];
    const pid = await claudeLocateTuiPid(
      { sessionId: "s", record: locRec({ pid: 4242, agent: undefined }) },
      { ttyOf: async () => "ttys004", note: (r) => notes.push(r) },
    );
    expect(pid).toBe(4242);
    expect(notes).toEqual(["record-pid"]);
  });

  test("a tty-less (headless/daemon) or dead pid owns no window → undefined", async () => {
    const notes: LocateTuiReason[] = [];
    const note = (r: LocateTuiReason): void => { notes.push(r); };
    // No herdr anywhere in the ancestry: the pid's own tty IS the only signal, as before. The two
    // seams keep this hermetic — without them the real process table would be walked.
    const plain = { ancestorsOf: (): number[] => [], commandOf: (): undefined => undefined, note };
    expect(await claudeLocateTuiPid({ sessionId: "s", record: locRec({ pid: 4242 }) }, { ...plain, ttyOf: async () => "??" })).toBeUndefined();
    expect(await claudeLocateTuiPid({ sessionId: "s", record: locRec({ pid: 4242 }) }, { ...plain, ttyOf: async () => undefined })).toBeUndefined();
    expect(await claudeLocateTuiPid({ sessionId: "s", record: locRec({ pid: 4242 }) }, { ...plain, ttyOf: async () => { throw new Error("ps"); } })).toBeUndefined();
    expect(notes).toEqual(["no-candidate", "no-candidate", "no-candidate"]);
  });

  // FIELD REGRESSION (2026-08-02), the locate half of the same bug: a session started as a Claude
  // background/forked task records the daemon-hosted `process.ppid`, whose tty is "??". Refusing it
  // here meant terminal-focus never even got the chance to correlate its (open, unique) herdr pane.
  test("a tty-less pid whose pty is owned by the herdr daemon is still the TUI", async () => {
    const notes: LocateTuiReason[] = [];
    const commands: Record<number, string> = {
      9337: "/Users/karrix/.local/share/claude/versions/2.1.220 --session-id 878bc284 --fork-session",
      9108: "/Users/karrix/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host",
      9074: "/Users/karrix/.local/bin/claude daemon run --origin transient",
      76594: "/opt/homebrew/bin/herdr server",
    };
    const pid = await claudeLocateTuiPid(
      { sessionId: "s", record: locRec({ pid: 9337, agent: undefined }) },
      {
        ttyOf: async () => "??",
        ancestorsOf: () => [9108, 9074, 76594],
        commandOf: (p) => commands[p],
        note: (r) => notes.push(r),
      },
    );
    expect(pid).toBe(9337);
    expect(notes).toEqual(["record-pid"]);
  });

  test("a pid that is GONE is never resurrected by a herdr ancestry", async () => {
    // A dead pid reads back no tty at all. `ps` cannot report an ancestry for it either, so the
    // herdr escape hatch must not fire — otherwise a stale record could focus a live pane.
    const notes: LocateTuiReason[] = [];
    const pid = await claudeLocateTuiPid(
      { sessionId: "s", record: locRec({ pid: 9337, agent: undefined }) },
      {
        ttyOf: async () => undefined,
        ancestorsOf: () => [],
        commandOf: () => undefined,
        note: (r) => notes.push(r),
      },
    );
    expect(pid).toBeUndefined();
    expect(notes).toEqual(["no-candidate"]);
  });

  test("a record with no usable pid is a no-op", async () => {
    expect(await claudeLocateTuiPid(
      { sessionId: "s", record: locRec({ pid: Number.NaN }) }, { ttyOf: async () => "ttys004" },
    )).toBeUndefined();
  });

  // FIELD REGRESSION, the second shape of the herdr bug above: a session started in the Claude DESKTOP
  // app records the ppid of a `claude` that runs under the app bundle with tty "??". Refusing it here
  // made "Open on Mac" a silent no-op for every desktop-app session (the watchdog traced
  // result:"no-candidate" and did nothing — it never focused the wrong app, it just never focused).
  // The argv are verbatim off a live desktop session (Claude 1.30096.1 / claude-code 2.1.229).
  const DESKTOP_SESSION_ARGV =
    "/Users/karrix/Library/Application Support/Claude/claude-code/2.1.229/claude.app/Contents/MacOS/claude"
    + " --output-format stream-json --resume=8fc9dfd6-adde-4da4-9afb-e209b4c1947e";
  const DESKTOP_COMMANDS: Record<number, string> = {
    27773: DESKTOP_SESSION_ARGV,
    27772: "/Applications/Claude.app/Contents/Helpers/disclaimer " + DESKTOP_SESSION_ARGV,
    52631: "/Applications/Claude.app/Contents/MacOS/Claude",
  };

  test("a tty-less pid owned by the Claude DESKTOP app is still the TUI", async () => {
    const notes: LocateTuiReason[] = [];
    const pid = await claudeLocateTuiPid(
      { sessionId: "s", record: locRec({ pid: 27773, agent: undefined }) },
      {
        ttyOf: async () => "??",
        ancestorsOf: () => [27772, 52631],
        commandOf: (p) => DESKTOP_COMMANDS[p],
        note: (r) => notes.push(r),
      },
    );
    expect(pid).toBe(27773);
    expect(notes).toEqual(["record-pid"]);
  });

  test("a pid that is GONE is never resurrected by a desktop-app ancestry either", async () => {
    // A dead pid reads back no tty, no ancestry and no argv, so the desktop clause cannot fire — the
    // same property that keeps the herdr escape hatch from focusing a live window for a stale record.
    const notes: LocateTuiReason[] = [];
    expect(await claudeLocateTuiPid(
      { sessionId: "s", record: locRec({ pid: 27773, agent: undefined }) },
      {
        ttyOf: async () => undefined, ancestorsOf: () => [], commandOf: () => undefined,
        note: (r) => notes.push(r),
      },
    )).toBeUndefined();
    expect(notes).toEqual(["no-candidate"]);
  });

  test("a CLI session under Ghostty resolves exactly as before (the tty is still the signal)", async () => {
    const notes: LocateTuiReason[] = [];
    const argv: Record<number, string> = {
      6757: "claude", 6700: "-zsh", 900: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    };
    const pid = await claudeLocateTuiPid(
      { sessionId: "s", record: locRec({ pid: 6757, agent: undefined }) },
      {
        ttyOf: async () => "ttys004", ancestorsOf: () => [6700, 900], commandOf: (p) => argv[p],
        note: (r) => notes.push(r),
      },
    );
    expect(pid).toBe(6757);
    expect(notes).toEqual(["record-pid"]);
  });

  test("the desktop clause is the CLAUDE locator's alone — Codex still needs its own correlation", async () => {
    // Codex sessions must be untouched: a tty-less codex pid under a Claude-desktop-looking ancestry
    // is not rescued, because codexLocateTuiPid never consults the owning app at all.
    expect(await codexLocateTuiPid(
      { sessionId: "codex-uuid", record: locRec({ pid: 27773 }) },
      {
        ps: async () => PS_ONE_TUI,
        ancestorsOf: () => [27772, 52631],
        commandOf: (p) => DESKTOP_COMMANDS[p],
      },
    )).toBe(16029); // the lone real codex TUI, never the desktop-owned pid
  });
});

describe("both adapters expose the locate seam", () => {
  test("claude and codex each wire their locator; the shared daemon dispatches through it", async () => {
    expect(typeof claudeAdapter.locateTuiPid).toBe("function");
    expect(typeof codexAdapter.locateTuiPid).toBe("function");
    expect(await codexAdapter.locateTuiPid!(
      { sessionId: "codex-pid-16029", record: locRec({ pid: 1 }) },
      { ps: async () => PS_ONE_TUI },
    )).toBe(16029);
    expect(await claudeAdapter.locateTuiPid!(
      { sessionId: "s", record: locRec({ pid: 77, agent: undefined }) },
      { ttyOf: async () => "ttys009" },
    )).toBe(77);
  });
});
