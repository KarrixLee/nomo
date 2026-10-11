// Tests for the Cursor producer (core/cursor.ts): payload reading, the state mapping, and one
// end-to-end pass per mapped event through runCursorHook against a temp sessions dir with the POST
// captured. Nothing here touches the network, the real ~/.cursor, or the real ~/.config/cc-status.

import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { adapterFor, cursorAdapter } from "./adapter";
import { b64url, decryptBlob } from "./crypto";
import {
  CURSOR_KEEPALIVE_MS, CURSOR_UNKNOWN_OWNER_PID, CursorHookDeps, cursorEventKind, cursorOwnerPid,
  cursorSessionIds, isCursorInvocation, planCursor, runCursorHook,
} from "./cursor";
import { Config, pidAlive, readRecord, SessionRecord } from "./shared";
import { classifySession, isClaudeIdleReapEligible } from "../entries/cc-watchdog";
import { parseAudience, statusCmd } from "../entries/status-cmd";

const KEY = new Uint8Array(32).fill(7);
const CONFIG: Config = { url: "https://example.invalid", pairingId: "pairing-1", pcSecret: "secret", e2eKey: KEY };
const EMAIL = "someone@example.com";
const CONV = "8f2c1d7e-0000-4000-8000-000000000001";
const GEN1 = "gen-0001";
const GEN2 = "gen-0002";

/** The fields every Cursor hook payload carries (docs: "common input fields"), including the personal
 *  one that must never leave this machine. */
const common = (event: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  conversation_id: CONV,
  generation_id: GEN1,
  model: "cursor-grok-4.6-high-fast",
  hook_event_name: event,
  cursor_version: "2026.08.11-e8db854",
  workspace_roots: ["/tmp/nomo-cursor-fixture/api"],
  user_email: EMAIL,
  transcript_path: null,
  ...extra,
});

/** One fixture per mapped event, in the documented shape. */
const FIXTURES = {
  sessionStart: common("sessionStart", { session_id: CONV, is_background_agent: false, composer_mode: "agent" }),
  beforeSubmitPrompt: common("beforeSubmitPrompt", { prompt: "Fix the flaky retry test", attachments: [] }),
  postToolUse: common("postToolUse", { tool_name: "Shell", tool_input: { command: "bun test" }, tool_output: "{}", tool_use_id: "t1", cwd: "/tmp/nomo-cursor-fixture/api", duration: 12 }),
  postToolUseFailure: common("postToolUseFailure", { tool_name: "Shell", tool_input: {}, tool_use_id: "t2", error_message: "boom", failure_type: "error", is_interrupt: false }),
  afterShellExecution: common("afterShellExecution", { command: "bun test", output: "ok", duration: 9 }),
  afterFileEdit: common("afterFileEdit", { file_path: "/tmp/nomo-cursor-fixture/api/a.ts", edits: [] }),
  stop: common("stop", { status: "completed", loop_count: 0 }),
  sessionEnd: common("sessionEnd", { session_id: CONV, reason: "user_close", duration_ms: 1000, is_background_agent: false, final_status: "completed" }),
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Harness {
  sessionsDir: string;
  root: string;
  posts: Record<string, unknown>[];
  traces: object[];
  clock: { now: number };
  fire: (payload: Record<string, unknown> | string, over?: Partial<CursorHookDeps>) => Promise<void>;
  record: (id?: string) => Promise<SessionRecord | null>;
  lastBlob: () => Promise<Record<string, unknown>>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "nomo-cursor-"));
  dirs.push(root);
  const sessionsDir = join(root, "sessions");
  const posts: Record<string, unknown>[] = [];
  const traces: object[] = [];
  // Anchored on the REAL clock: the record's `ts` and the ignore markers' mtimes are stamped by the
  // filesystem helpers, so a made-up epoch would read every one of them as years stale.
  const clock = { now: Date.now() };
  const deps: CursorHookDeps = {
    config: CONFIG,
    sessionsDir,
    ignoredDir: join(root, "ignored"),
    stampPath: join(root, "last-hook-cursor"),
    now: () => clock.now,
    env: {},
    ownerPid: () => process.pid, // a pid that is certainly alive
    post: async (_config, envelope) => { posts.push(envelope); return true; },
    ensureWatchdog: () => {},
    trace: (event) => { traces.push(event); },
  };
  return {
    sessionsDir, root, posts, traces, clock,
    fire: (payload, over = {}) =>
      runCursorHook(typeof payload === "string" ? payload : JSON.stringify(payload), { ...deps, ...over }),
    record: (id = CONV) => readRecord(id, sessionsDir),
    lastBlob: async () => await decryptBlob(KEY, posts.at(-1)!.blob as string) as Record<string, unknown>,
  };
}

describe("reading a Cursor payload", () => {
  test("every registered event maps to a kind; unknown events map to nothing", () => {
    expect(cursorEventKind(FIXTURES.sessionStart)).toBe("start");
    expect(cursorEventKind(FIXTURES.beforeSubmitPrompt)).toBe("prompt");
    expect(cursorEventKind(FIXTURES.postToolUse)).toBe("tool");
    expect(cursorEventKind(FIXTURES.postToolUseFailure)).toBe("tool");
    expect(cursorEventKind(FIXTURES.afterShellExecution)).toBe("tool");
    expect(cursorEventKind(FIXTURES.afterFileEdit)).toBe("tool");
    expect(cursorEventKind(FIXTURES.stop)).toBe("stop");
    expect(cursorEventKind(FIXTURES.sessionEnd)).toBe("end");
    // Permission-class and Tab events are not ours to interpret, even if something registers them.
    expect(cursorEventKind(common("preToolUse", { tool_name: "Shell" }))).toBeUndefined();
    expect(cursorEventKind(common("beforeTabFileRead"))).toBeUndefined();
  });

  test("a missing hook_event_name falls back to the payload's shape", () => {
    const bare = (extra: Record<string, unknown>) => ({ conversation_id: CONV, ...extra });
    expect(cursorEventKind(bare({ hookEventName: "stop" }))).toBe("stop");
    expect(cursorEventKind(bare({ prompt: "hi" }))).toBe("prompt");
    expect(cursorEventKind(bare({ reason: "window_close" }))).toBe("end");
    expect(cursorEventKind(bare({ tool_name: "Read" }))).toBe("tool");
    expect(cursorEventKind(bare({ status: "aborted" }))).toBe("stop");
    expect(cursorEventKind(bare({}))).toBeUndefined();
  });

  test("ids are read tolerantly, in order, and never trusted as a path", () => {
    expect(cursorSessionIds({ session_id: "a", sessionId: "b", conversation_id: "c", conversationId: "d" })).toEqual(["a", "b", "c", "d"]);
    expect(cursorSessionIds({ conversationId: "only" })).toEqual(["only"]);
    expect(cursorSessionIds({ session_id: CONV, conversation_id: CONV })).toEqual([CONV]);
    expect(cursorSessionIds({ session_id: "../../etc/passwd", conversation_id: "ok-1" })).toEqual(["ok-1"]);
    expect(cursorSessionIds({ session_id: ".hidden", conversation_id: 7 })).toEqual([]);
  });

  test("the Cursor sanity check reads the payload or the env, nothing else", () => {
    expect(isCursorInvocation({ cursor_version: "1.0" }, {})).toBe(true);
    expect(isCursorInvocation({}, { CURSOR_VERSION: "1.0" })).toBe(true);
    expect(isCursorInvocation({ hook_event_name: "Stop", session_id: "x" }, {})).toBe(false);
  });
});

describe("the owner pid", () => {
  const sh = { pid: 30, command: "/bin/sh -c '/x/run.sh'" };
  test("CLI: the nearest cursor-agent process, in either argv layout", () => {
    expect(cursorOwnerPid([sh, { pid: 20, command: "cursor-agent" }, { pid: 10, command: "-zsh" }])).toBe(20);
    expect(cursorOwnerPid([sh, { pid: 21, command: "/Users/x/.local/share/cursor-agent/versions/2026.08.11/node /Users/x/.local/share/cursor-agent/versions/2026.08.11/index.js" }])).toBe(21);
  });
  test("desktop: the OUTERMOST Cursor process, not a helper", () => {
    expect(cursorOwnerPid([
      sh,
      { pid: 40, command: "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin) --type=utility" },
      { pid: 41, command: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
    ])).toBe(41);
  });
  test("a CLI run inside Cursor's own terminal is owned by the CLI", () => {
    expect(cursorOwnerPid([sh, { pid: 20, command: "cursor-agent" }, { pid: 41, command: "/Applications/Cursor.app/Contents/MacOS/Cursor" }])).toBe(20);
  });
  test("no Cursor process in the chain → undefined, never the hook's shell", () => {
    expect(cursorOwnerPid([sh, { pid: 10, command: "-zsh" }, { pid: 9, command: undefined }])).toBeUndefined();
    expect(cursorOwnerPid([])).toBeUndefined();
  });
});

describe("planCursor — the state mapping", () => {
  const NOW = 1_800_000_000_000;
  const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    pid: 1, machine: "m", label: "api", ts: NOW - 60_000, transcript: "", lastEvent: "working",
    sentDone: false, op: "update", prio: 0, agent: "cursor", turnStartedAt: 111, turnId: GEN1, ...over,
  } as SessionRecord);

  test("only a prompt creates a row", () => {
    expect(planCursor("prompt", FIXTURES.beforeSubmitPrompt, null, NOW)).toMatchObject({ op: "start", status: "working", generation: GEN1 });
    for (const kind of ["start", "tool", "stop", "end"] as const) {
      expect(planCursor(kind, FIXTURES.postToolUse, null, NOW)).toBeNull();
    }
  });

  test("a prompt on an existing row is a working update with a fresh turn anchor", () => {
    expect(planCursor("prompt", { generation_id: GEN2 }, rec({ op: "done", lastEvent: "done", sentDone: true }), NOW))
      .toEqual({ op: "update", prio: 0, status: "working", turnStartedAt: NOW / 1000, generation: GEN2 });
  });

  test("tool events keep a working row alive, throttled", () => {
    expect(planCursor("tool", FIXTURES.postToolUse, rec({ ts: NOW - 1000 }), NOW)).toBeNull();
    expect(planCursor("tool", FIXTURES.postToolUse, rec({ ts: NOW - CURSOR_KEEPALIVE_MS }), NOW))
      .toEqual({ op: "update", prio: 0, status: "working", turnStartedAt: 111, generation: GEN1 });
  });

  test("a late tool event from the turn that already stopped does not re-arm the row", () => {
    const done = rec({ op: "done", lastEvent: "done", sentDone: true, turnId: GEN1 });
    expect(planCursor("tool", { generation_id: GEN1 }, done, NOW)).toBeNull();
    expect(planCursor("tool", {}, done, NOW)).toBeNull();
    // A different generation is a new turn (e.g. a followup that fired no prompt hook).
    expect(planCursor("tool", { generation_id: GEN2 }, done, NOW)).toMatchObject({ op: "update", status: "working", generation: GEN2 });
  });

  test("stop is done whatever its status, and never needsAttention", () => {
    for (const status of ["completed", "aborted", "error"]) {
      const plan = planCursor("stop", { generation_id: GEN1, status }, rec(), NOW);
      expect(plan).toMatchObject({ op: "done", prio: 0, status: "done" });
    }
    const done = rec({ op: "done", lastEvent: "done", sentDone: true });
    expect(planCursor("stop", { generation_id: GEN1 }, done, NOW)).toBeNull(); // duplicate
    expect(planCursor("stop", { generation_id: GEN1 }, { ...done, donePending: true }, NOW)).toMatchObject({ op: "done" }); // still owed
  });

  test("sessionEnd ends; sessionStart does nothing", () => {
    expect(planCursor("end", FIXTURES.sessionEnd, rec(), NOW)).toMatchObject({ op: "end", status: "done" });
    expect(planCursor("start", FIXTURES.sessionStart, rec(), NOW)).toBeNull();
  });

  test("no plan is ever a decision-pending or attention state", () => {
    const records = [null, rec(), rec({ op: "done", lastEvent: "done", sentDone: true })];
    for (const kind of ["start", "prompt", "tool", "stop", "end"] as const) {
      for (const r of records) {
        const plan = planCursor(kind, { generation_id: GEN2 }, r, NOW);
        if (plan) { expect(plan.prio).toBe(0); expect(plan.status).not.toBe("needsAttention"); }
      }
    }
  });
});

describe("runCursorHook — one event at a time", () => {
  test("a full turn: prompt → tool → stop → sessionEnd", async () => {
    const h = await harness();
    await h.fire(FIXTURES.sessionStart);
    expect(h.posts).toHaveLength(0); // sessionStart only stamps
    expect(await h.record()).toBeNull();
    expect(Number(await readFile(join(h.root, "last-hook-cursor"), "utf8"))).toBe(h.clock.now);

    await h.fire(FIXTURES.beforeSubmitPrompt);
    expect(h.posts.at(-1)).toMatchObject({ v: 2, sessionId: CONV, op: "start", prio: 0 });
    expect(await h.lastBlob()).toMatchObject({
      status: "working", title: "Fix the flaky retry test", label: "api", agent: "cursor",
      model: "cursor-grok-4.6-high-fast", machine: expect.any(String),
    });
    expect(await h.record()).toMatchObject({ agent: "cursor", pid: process.pid, title: "Fix the flaky retry test", turnId: GEN1, lastEvent: "sessionStart" });

    h.clock.now += 1000;
    await h.fire(FIXTURES.postToolUse);
    await h.fire(FIXTURES.afterShellExecution);
    expect(h.posts).toHaveLength(1); // inside the keep-alive window: no POST, no delay

    h.clock.now += CURSOR_KEEPALIVE_MS;
    await h.fire(FIXTURES.afterFileEdit);
    expect(h.posts.at(-1)).toMatchObject({ op: "update", prio: 0 });
    expect(await h.lastBlob()).toMatchObject({ status: "working" });

    await h.fire(FIXTURES.stop);
    expect(h.posts.at(-1)).toMatchObject({ op: "done", prio: 0 });
    expect(await h.lastBlob()).toMatchObject({ status: "done", title: "Fix the flaky retry test" });
    const done = await h.record();
    expect(done).toMatchObject({ op: "done", sentDone: true });
    expect(done!.donePending).toBeUndefined(); // delivered → the debt is cleared

    await h.fire(FIXTURES.postToolUseFailure); // a straggler from the finished turn
    expect(h.posts.at(-1)).toMatchObject({ op: "done" });

    await h.fire(FIXTURES.sessionEnd);
    expect(h.posts.at(-1)).toMatchObject({ op: "end" });
    expect(await h.record()).toBeNull();
    expect(h.posts.every((p) => p.attentionKind === undefined)).toBe(true);
  });

  test("the title stays the FIRST prompt; the model follows the latest payload", async () => {
    const h = await harness();
    await h.fire(FIXTURES.beforeSubmitPrompt);
    await h.fire(common("beforeSubmitPrompt", { prompt: "Now rename the helper", generation_id: GEN2, model: "claude-fable-5" }));
    expect(await h.lastBlob()).toMatchObject({ title: "Fix the flaky retry test", model: "claude-fable-5", status: "working" });
    expect(h.posts.at(-1)).toMatchObject({ op: "update" });
  });

  test("field-name variants: camelCase ids, no hook_event_name, CURSOR_VERSION only in the env", async () => {
    const h = await harness();
    const env = { CURSOR_VERSION: "2026.08.11" };
    await h.fire({ conversationId: "variant-1", generationId: GEN1, prompt: "Hello there Cursor", model_id: "gpt-x", workspace_roots: ["/tmp/v/app"], user_email: EMAIL }, { env });
    expect(h.posts.at(-1)).toMatchObject({ sessionId: "variant-1", op: "start" });
    expect(await h.lastBlob()).toMatchObject({ title: "Hello there Cursor", model: "gpt-x", label: "app" });
    await h.fire({ sessionId: "variant-1", status: "completed", user_email: EMAIL }, { env });
    expect(h.posts.at(-1)).toMatchObject({ sessionId: "variant-1", op: "done" });
  });

  test("sessionEnd lands on the tracked row even when session_id differs from conversation_id", async () => {
    const h = await harness();
    await h.fire(FIXTURES.beforeSubmitPrompt);
    await h.fire({ ...FIXTURES.sessionEnd, session_id: "a-different-session-id" });
    expect(h.posts.at(-1)).toMatchObject({ sessionId: CONV, op: "end" });
    expect(await h.record()).toBeNull();
  });

  test("/clear: a new conversation id with no sessionStart becomes its own row", async () => {
    const h = await harness();
    await h.fire(FIXTURES.beforeSubmitPrompt);
    await h.fire(FIXTURES.stop);
    const next = "8f2c1d7e-0000-4000-8000-000000000002";
    await h.fire(common("beforeSubmitPrompt", { conversation_id: next, generation_id: GEN2, prompt: "Something new entirely" }));
    expect(h.posts.at(-1)).toMatchObject({ sessionId: next, op: "start" });
    expect(await h.lastBlob()).toMatchObject({ title: "Something new entirely" });
    expect(await h.record(next)).toMatchObject({ agent: "cursor" });
    expect(await h.record(CONV)).toMatchObject({ op: "done" }); // the old chat is left finished, not touched
  });

  test("background agents are ignored — including their later events that do not carry the flag", async () => {
    const h = await harness();
    await h.fire({ ...FIXTURES.sessionStart, is_background_agent: true });
    await h.fire(FIXTURES.beforeSubmitPrompt);
    await h.fire(FIXTURES.stop);
    expect(h.posts).toHaveLength(0);
    expect(await h.record()).toBeNull();
    // …and a foreground chat next to it is unaffected.
    await h.fire(common("beforeSubmitPrompt", { conversation_id: "foreground-1", prompt: "A normal request" }));
    expect(h.posts).toHaveLength(1);
  });

  test("events for a session no prompt created never mint a row", async () => {
    const h = await harness();
    for (const f of [FIXTURES.postToolUse, FIXTURES.afterFileEdit, FIXTURES.stop, FIXTURES.sessionEnd]) await h.fire(f);
    expect(h.posts).toHaveLength(0);
    expect(await readdir(h.sessionsDir).catch(() => [])).toEqual([]);
  });

  test("an unknown owner falls back to the always-alive pid, and a prompt retries it", async () => {
    const h = await harness();
    await h.fire(FIXTURES.beforeSubmitPrompt, { ownerPid: () => undefined });
    expect((await h.record())!.pid).toBe(CURSOR_UNKNOWN_OWNER_PID);
    await h.fire(common("beforeSubmitPrompt", { generation_id: GEN2, prompt: "again" }), { ownerPid: () => 999_999_999 }); // dead pid → still unknown
    expect((await h.record())!.pid).toBe(CURSOR_UNKNOWN_OWNER_PID);
    await h.fire(common("beforeSubmitPrompt", { generation_id: "gen-3", prompt: "again" }));
    expect((await h.record())!.pid).toBe(process.pid);
  });

  test("user_email never reaches a frame, a record, a trace or the stamp", async () => {
    const h = await harness();
    for (const f of Object.values(FIXTURES)) {
      h.clock.now += CURSOR_KEEPALIVE_MS;
      await h.fire({ ...f, user_email: EMAIL });
      const record = await readFile(join(h.sessionsDir, `${CONV}.json`), "utf8").catch(() => "");
      expect(record).not.toContain(EMAIL);
      expect(record).not.toContain("user_email");
    }
    expect(h.posts.length).toBeGreaterThanOrEqual(4);
    for (const post of h.posts) {
      expect(JSON.stringify(post)).not.toContain(EMAIL);
      const plain = JSON.stringify(await decryptBlob(KEY, post.blob as string));
      expect(plain).not.toContain(EMAIL);
      expect(plain).not.toContain("user_email");
    }
    expect(JSON.stringify(h.traces)).not.toContain(EMAIL);
    expect(h.traces.length).toBeGreaterThan(0);
    for (const name of await readdir(h.root, { recursive: true })) {
      const text = await readFile(join(h.root, name), "utf8").catch(() => "");
      expect(text).not.toContain(EMAIL);
    }
  });

  test("silent on garbage, on a non-Cursor payload, and when unpaired", async () => {
    const h = await harness();
    await h.fire("");
    await h.fire("{not json");
    await h.fire("[1,2]");
    await h.fire({ hook_event_name: "beforeSubmitPrompt", conversation_id: CONV, prompt: "no cursor_version here" });
    await h.fire(FIXTURES.beforeSubmitPrompt, { config: null });
    await h.fire(FIXTURES.beforeSubmitPrompt, { post: async () => { throw new Error("network down"); } });
    expect(h.posts).toHaveLength(0);
    // The throwing POST still left the row recorded; a failed done stays owed for the watchdog.
    await h.fire(FIXTURES.stop, { post: async () => false });
    expect(await h.record()).toMatchObject({ op: "done", donePending: true });
  });

  test("a record another agent wrote under the same id is left alone", async () => {
    const h = await harness();
    await h.fire(FIXTURES.beforeSubmitPrompt);
    const path = join(h.sessionsDir, `${CONV}.json`);
    const foreign = JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), agent: "codex" });
    await Bun.write(path, foreign);
    await h.fire(FIXTURES.stop);
    expect(h.posts).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe(foreign);
  });
});

describe("cursorAdapter", () => {
  test("is what adapterFor returns, and stamps agent:cursor into rebuilt blobs", () => {
    expect(adapterFor("cursor")).toBe(cursorAdapter);
    expect(cursorAdapter.blobAgentFields).toEqual({ agent: "cursor" });
    expect(cursorAdapter.detectInterrupt("anything")).toBe(false);
    // No approval / discovery / focus seam exists to be wrong.
    expect(cursorAdapter.tailShowsPendingApproval).toBeUndefined();
    expect(cursorAdapter.discoverLive).toBeUndefined();
    expect(cursorAdapter.locateTuiPid).toBeUndefined();
    expect(cursorAdapter.allowMode).toBeUndefined();
  });

  test("title is the prompt; model prefers `model`, then `model_id`", async () => {
    const ctx = { sessionId: "s", prefix: "", transcriptPath: "" };
    expect(await cursorAdapter.title({ ...ctx, input: { prompt: "Add a retry to the uploader" } })).toBe("Add a retry to the uploader");
    expect(await cursorAdapter.title({ ...ctx, input: { status: "completed" } })).toBeUndefined();
    expect(await cursorAdapter.model!({ ...ctx, input: { model: "a", model_id: "b" } })).toBe("a");
    expect(await cursorAdapter.model!({ ...ctx, input: { model_id: "b" } })).toBe("b");
    expect(await cursorAdapter.model!({ ...ctx, input: { model: "" } })).toBeUndefined();
  });
});

describe("the watchdog's idle reap covers Cursor", () => {
  const REAP_MS = 1_800_000; // mirrors CLAUDE_IDLE_REAP_MS
  const now = 100_000_000_000;
  const rec = (over: Partial<SessionRecord>): SessionRecord => ({
    pid: CURSOR_UNKNOWN_OWNER_PID, machine: "m", label: "l", ts: now - REAP_MS, transcript: "",
    lastEvent: "working", sentDone: false, op: "update", prio: 0, agent: "cursor", ...over,
  } as SessionRecord);

  test("a Cursor row whose stop never arrived is finished after 30 quiet minutes — and not before", () => {
    expect(isClaudeIdleReapEligible(rec({}), now)).toBe(true);
    expect(isClaudeIdleReapEligible(rec({ lastEvent: "sessionStart" }), now)).toBe(true);
    expect(isClaudeIdleReapEligible(rec({ ts: now - REAP_MS + 1 }), now)).toBe(false);
    expect(isClaudeIdleReapEligible(rec({ lastEvent: "done", op: "done" }), now)).toBe(false);
  });

  test("a row on the unknown-owner pid is KEPT (never an instant false end), so the reap can reach it", () => {
    // The real liveness predicate, not a stub: pid 1 must read alive on this OS.
    expect(classifySession(rec({ ts: now }), now, pidAlive)).toBe("keep");
    expect(classifySession(rec({ ts: now, pid: 999_999_999 }), now, pidAlive)).toBe("end");
  });
});

describe("status — the Cursor row", () => {
  const MIN = 60_000;
  async function status(opts: { installed?: boolean; stampAgeMs?: number; transcriptAgeMs?: number; audience?: "cursor" | "claude"; sessions?: number }): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), "nomo-cursor-status-"));
    dirs.push(dir);
    const NOW = Date.now();
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ url: "https://example.invalid", pairingId: "a".repeat(32), pcSecret: "s", e2eKeyB64: b64url(new Uint8Array(32)) }));
    const cursorHooksPath = join(dir, "cursor", "hooks.json");
    await mkdir(join(dir, "cursor", "projects", "p", "agent-transcripts", "u"), { recursive: true });
    await mkdir(join(dir, "sessions"), { recursive: true });
    if (opts.installed) {
      await writeFile(cursorHooksPath, JSON.stringify({ version: 1, hooks: { stop: [{ command: "'/r/scripts/run.sh' '/r/dist/cursor-status.mjs'" }] } }));
    }
    if (opts.stampAgeMs !== undefined) await writeFile(join(dir, "lh-cursor"), String(NOW - opts.stampAgeMs));
    if (opts.transcriptAgeMs !== undefined) {
      const p = join(dir, "cursor", "projects", "p", "agent-transcripts", "u", "u.jsonl");
      await writeFile(p, "{}\n");
      const t = (NOW - opts.transcriptAgeMs) / 1000;
      await utimes(p, t, t);
    }
    for (let i = 0; i < (opts.sessions ?? 0); i++) await writeFile(join(dir, "sessions", `c${i}.json`), JSON.stringify({ agent: "cursor" }));
    const lines: string[] = [];
    await statusCmd({
      print: (l) => lines.push(l), audience: opts.audience, configPath,
      lastSendPath: join(dir, "last-send"), sessionsDir: join(dir, "sessions"),
      watchdogPidPath: join(dir, "watchdog.pid"), sessionTracePath: join(dir, "trace.log"),
      codexConfigPath: join(dir, "config.toml"), codexHooksPath: join(dir, "codex-hooks.json"),
      codexSessionsDir: join(dir, "codex-sessions"), claudeProjectsDir: join(dir, "claude-projects"),
      lastHookCodexPath: join(dir, "lh-codex"), lastHookClaudePath: join(dir, "lh-claude"),
      lastHookOpencodePath: join(dir, "lh-opencode"), opencodeStubPaths: [join(dir, "absent.js")],
      cursorHooksPath, cursorProjectsDir: join(dir, "cursor", "projects"), lastHookCursorPath: join(dir, "lh-cursor"),
      noHoldPath: join(dir, "no-hold"), codexAppServerAvailable: async () => false, isAlive: () => false,
      now: () => NOW,
    });
    return lines;
  }

  test("asked from Cursor: leads with Cursor, names /nomo-pair-family commands, says read-only", async () => {
    expect(parseAudience(["cursor"])).toBe("cursor");
    const out = (await status({ audience: "cursor", installed: true, stampAgeMs: MIN, sessions: 2 })).join("\n");
    expect(out).toContain("Cursor — you are here");
    expect(out).toContain("firing");
    expect(out).toContain("2 tracked");
    expect(out).toContain("read-only");
    expect(out).not.toContain("NOT FIRING");
  });

  test("installed, Cursor busy, but no hook has ever run → NOT FIRING with the re-install hint", async () => {
    const lines = await status({ audience: "claude", installed: true, transcriptAgeMs: 2 * MIN });
    const out = lines.join("\n");
    expect(out).toContain("NOT FIRING");
    expect(out).toContain("! Cursor was active");
    expect(out).toContain("bunx nomo-ai --cursor");
    expect(out).toContain("run /nomo-status inside Cursor");
  });

  test("not installed and never seen: another agent's reader is told nothing about Cursor", async () => {
    const out = (await status({ audience: "claude", transcriptAgeMs: 2 * MIN })).join("\n");
    expect(out).not.toContain("Cursor");
  });
});
