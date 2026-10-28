// Tests for the Cursor producer (core/cursor.ts): payload reading, the state mapping, and one
// end-to-end pass per mapped event through runCursorHook against a temp sessions dir with the POST
// captured. Nothing here touches the network, the real ~/.cursor, or the real ~/.config/cc-status.

import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { adapterFor, cursorAdapter, cursorChatTitle, cursorHostInvocation, CURSOR_TITLE_REPAIR_MS } from "./adapter";
import { b64url, decryptBlob } from "./crypto";
import {
  CURSOR_KEEPALIVE_MS, CURSOR_OWNER_RETRY_MS, CURSOR_UNKNOWN_OWNER_PID, CursorHookDeps, cursorEventKind, cursorOwnerPid,
  cursorSessionIds, isCursorInvocation, planCursor, runCursorHook,
} from "./cursor";
import { Config, pidAlive, readRecord, SessionRecord } from "./shared";
import { classifySession, correctIdleClaude, isClaudeIdleReapEligible, repairTitle, shouldRepairTitle } from "../entries/cc-watchdog";
import { parseAudience, statusCmd } from "../entries/status-cmd";
import { createProcessHygiene, isolatedTestEnv } from "../test/process-hygiene";

const { spawnTestProcess } = createProcessHygiene();
const ENTRY = join(import.meta.dir, "../entries/cursor-status.ts");

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
    chatTitle: () => undefined, // never the developer's real Cursor database
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

  test("ids are read tolerantly, conversation id first, and never trusted as a path", () => {
    // conversation_id rides EVERY event; session_id only sessionStart/sessionEnd — so the former keys rows.
    expect(cursorSessionIds({ session_id: "a", sessionId: "b", conversation_id: "c", conversationId: "d" })).toEqual(["c", "d", "a", "b"]);
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

  test("it is the SAME predicate the Claude entries stand down on — no payload is claimed by neither", () => {
    // If the two disagreed, a payload could make the Claude entry exit ("this is Cursor") AND the
    // Cursor entry exit ("this is not Cursor"), and the session would be reported by nobody.
    const inputs: Record<string, unknown>[] = [
      {}, { cursor_version: "1.0" }, { cursor_version: "" }, { cursor_version: null }, { cursor_version: 7 },
      { hook_event_name: "Stop" },
    ];
    const envs: Record<string, string | undefined>[] = [{}, { CURSOR_VERSION: "1.0" }, { CURSOR_VERSION: "" }, { CURSOR_VERSION: undefined }];
    for (const input of inputs) for (const env of envs) {
      expect(isCursorInvocation(input, env)).toBe(cursorHostInvocation(input, env));
    }
    expect(isCursorInvocation({ cursor_version: "" }, {})).toBe(true);
    expect(isCursorInvocation({}, { CURSOR_VERSION: "" })).toBe(true);
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
  test("only the EXECUTABLE counts — a Cursor-looking argument does not make a process the owner", () => {
    for (const command of [
      "vim /Users/k/dev/cursor",
      "node /Users/k/cursor --x",
      "tail -f /var/log/cursor-agent",
      "/usr/bin/vim /Applications/Cursor.app/Contents/MacOS/Cursor",
      "node /Users/k/.local/share/cursor-agent/versions/1.2.3/index.js",
      "/bin/zsh -c cursor-agent",
    ]) expect(cursorOwnerPid([sh, { pid: 50, command }])).toBeUndefined();
    // …while the real things, with arguments and in a path with a space, still do.
    expect(cursorOwnerPid([sh, { pid: 51, command: "/Users/John Doe/Applications/Cursor.app/Contents/MacOS/Cursor --no-sandbox" }])).toBe(51);
    expect(cursorOwnerPid([sh, { pid: 52, command: "/usr/local/bin/cursor-agent --resume abc" }])).toBe(52);
    expect(cursorOwnerPid([sh, { pid: 53, command: "/opt/cursor/cursor --type=x" }])).toBe(53);
  });
  test("an executable named `agent` is the CLI only when it resolves under a cursor-agent directory", () => {
    const chain = [sh, { pid: 60, command: "/Users/x/.local/bin/agent chat" }];
    expect(cursorOwnerPid(chain)).toBeUndefined();
    expect(cursorOwnerPid(chain, () => "/Users/x/.local/share/cursor-agent/versions/1.2.3/cursor-agent")).toBe(60);
    expect(cursorOwnerPid(chain, () => "/opt/some-other/agent")).toBeUndefined();
    expect(cursorOwnerPid([sh, { pid: 61, command: "vim agent" }], () => "/x/cursor-agent/agent")).toBeUndefined();
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

  test("after a stop, no tool event re-arms the row — only a prompt starts a turn", () => {
    const done = rec({ op: "done", lastEvent: "done", sentDone: true, turnId: GEN1, stoppedGeneration: GEN1 });
    expect(planCursor("tool", { generation_id: GEN1 }, done, NOW)).toBeNull(); // late event of the stopped turn
    expect(planCursor("tool", {}, done, NOW)).toBeNull();
    // A generation no prompt created (a subagent, a straggler from an older turn): nothing would ever
    // retract the working state it raised, so it is dropped too.
    expect(planCursor("tool", { generation_id: GEN2 }, done, NOW)).toBeNull();
    expect(planCursor("tool", { generation_id: GEN2 }, { ...done, stoppedGeneration: "" }, NOW)).toBeNull();
    expect(planCursor("prompt", { generation_id: GEN2 }, done, NOW)).toMatchObject({ op: "update", status: "working", generation: GEN2 });
  });

  test("a row the watchdog finished mid-turn (no stop seen) re-arms on that turn's next tool event", () => {
    // The idle reap pins done but the turn never stopped: `stoppedGeneration` is absent.
    const reaped = rec({ op: "done", lastEvent: "done", sentDone: true, turnId: GEN1 });
    expect(planCursor("tool", { generation_id: GEN1 }, reaped, NOW))
      .toEqual({ op: "update", prio: 0, status: "working", turnStartedAt: 111, generation: GEN1 });
    expect(planCursor("tool", {}, reaped, NOW)).toMatchObject({ op: "update", status: "working", generation: GEN1 });
    // …but not on a generation the prompt did not stamp.
    expect(planCursor("tool", { generation_id: GEN2 }, reaped, NOW)).toBeNull();
    // Its real stop, when it does arrive, is recorded (so the stragglers after it are dropped).
    expect(planCursor("stop", { generation_id: GEN1 }, reaped, NOW)).toMatchObject({ op: "done", stoppedGeneration: GEN1 });
  });

  test("a keep-alive never overwrites the prompt-stamped generation", () => {
    const working = rec({ ts: NOW - CURSOR_KEEPALIVE_MS, turnId: GEN1 });
    expect(planCursor("tool", { generation_id: GEN2 }, working, NOW)).toMatchObject({ op: "update", status: "working", generation: GEN1 });
  });

  test("a stale stop for the previous generation does not finish the new turn; a bare stop still does", () => {
    const working = rec({ turnId: GEN2 });
    expect(planCursor("stop", { generation_id: GEN1, status: "completed" }, working, NOW)).toBeNull();
    expect(planCursor("stop", { generation_id: GEN2 }, working, NOW)).toMatchObject({ op: "done", generation: GEN2, stoppedGeneration: GEN2 });
    expect(planCursor("stop", { status: "completed" }, working, NOW)).toMatchObject({ op: "done", generation: GEN2, stoppedGeneration: GEN2 });
    // A row whose prompt carried no generation cannot tell a stale stop from its own: it ends.
    expect(planCursor("stop", { generation_id: GEN1 }, rec({ turnId: undefined }), NOW)).toMatchObject({ op: "done", stoppedGeneration: GEN1 });
    expect(planCursor("stop", {}, rec({ turnId: undefined }), NOW)).toMatchObject({ op: "done", stoppedGeneration: "" });
  });

  test("stop is done whatever its status, and never needsAttention", () => {
    for (const status of ["completed", "aborted", "error"]) {
      const plan = planCursor("stop", { generation_id: GEN1, status }, rec(), NOW);
      expect(plan).toMatchObject({ op: "done", prio: 0, status: "done" });
    }
    const done = rec({ op: "done", lastEvent: "done", sentDone: true, stoppedGeneration: GEN1 });
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

  test("generations: stragglers and stale stops never move a row; only the prompt's own stop ends it", async () => {
    const h = await harness();
    await h.fire(FIXTURES.beforeSubmitPrompt);
    await h.fire(FIXTURES.stop);
    expect(await h.record()).toMatchObject({ op: "done", turnId: GEN1, stoppedGeneration: GEN1 });
    const settled = h.posts.length;
    h.clock.now += CURSOR_KEEPALIVE_MS;
    await h.fire(FIXTURES.postToolUse);                                   // late, same generation
    await h.fire(common("postToolUse", { tool_name: "Task", generation_id: "gen-subagent" })); // foreign generation
    expect(h.posts).toHaveLength(settled);
    expect(await h.record()).toMatchObject({ op: "done", turnId: GEN1, stoppedGeneration: GEN1 });

    // The user sends a new message mid-run: prompt(g2), then the OLD turn's stop arrives.
    await h.fire(common("beforeSubmitPrompt", { prompt: "next", generation_id: GEN2 }));
    const working = await h.record();
    expect(working).toMatchObject({ lastEvent: "working", turnId: GEN2 });
    expect(working!.stoppedGeneration).toBeUndefined();
    await h.fire(common("stop", { status: "aborted", generation_id: GEN1 }));
    expect(await h.record()).toMatchObject({ lastEvent: "working", turnId: GEN2 });
    expect(h.posts.at(-1)).toMatchObject({ op: "update" });
    // A foreign-generation keep-alive leaves the prompt's generation in place…
    h.clock.now += CURSOR_KEEPALIVE_MS;
    await h.fire(common("postToolUse", { tool_name: "Task", generation_id: "gen-subagent" }));
    expect(await h.record()).toMatchObject({ lastEvent: "working", turnId: GEN2 });
    // …so the turn's own stop still ends it.
    await h.fire(common("stop", { status: "completed", generation_id: GEN2 }));
    expect(await h.record()).toMatchObject({ op: "done", turnId: GEN2, stoppedGeneration: GEN2 });
  });

  test("a turn the watchdog idle-reaped re-arms on its next tool event, and then stops normally", async () => {
    const h = await harness();
    await h.fire(FIXTURES.beforeSubmitPrompt);
    const before = (await h.record())!;
    // The REAL reap, 30 quiet minutes later, with only its POST replaced.
    const path = join(h.sessionsDir, `${CONV}.json`);
    expect(await correctIdleClaude(CONFIG, path, CONV, before, before.ts + 1_800_000, { post: async () => "delivered" })).toBe("corrected");
    expect(await h.record()).toMatchObject({ op: "done", lastEvent: "done", turnId: GEN1 });

    h.clock.now += 1_800_000;
    await h.fire(FIXTURES.postToolUse);
    expect(h.posts.at(-1)).toMatchObject({ op: "update" });
    expect(await h.record()).toMatchObject({ lastEvent: "working", turnId: GEN1 });
    await h.fire(FIXTURES.stop);
    expect(await h.record()).toMatchObject({ op: "done", stoppedGeneration: GEN1 });
    // The watchdog's later rewrites spread the record, so the marker survives them.
    const after = (await h.record())!;
    expect({ ...after, doneAttempts: undefined }.stoppedGeneration).toBe(GEN1);
  });

  test("a prompt carrying BOTH ids keys the row by conversation_id, so conversation-only events land", async () => {
    const h = await harness();
    await h.fire({ ...FIXTURES.beforeSubmitPrompt, session_id: "session-only-id" });
    expect(h.posts.at(-1)).toMatchObject({ sessionId: CONV, op: "start" });
    expect(await h.record("session-only-id")).toBeNull();
    await h.fire(FIXTURES.stop); // conversation_id only
    expect(h.posts.at(-1)).toMatchObject({ sessionId: CONV, op: "done" });
    await h.fire({ ...FIXTURES.sessionEnd, session_id: "session-only-id" });
    expect(h.posts.at(-1)).toMatchObject({ sessionId: CONV, op: "end" });
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

  test("an unknown owner falls back to the always-alive pid; a prompt retries it, but not on every prompt", async () => {
    const h = await harness();
    let walks = 0;
    const unknown = () => { walks++; return undefined; };
    await h.fire(FIXTURES.beforeSubmitPrompt, { ownerPid: unknown });
    expect((await h.record())!.pid).toBe(CURSOR_UNKNOWN_OWNER_PID);
    expect(walks).toBe(1);
    // Inside the retry interval the slow ancestor walk is NOT repeated — by prompts or by anything else.
    h.clock.now += 60_000;
    await h.fire(common("beforeSubmitPrompt", { generation_id: GEN2, prompt: "again" }), { ownerPid: unknown });
    await h.fire(FIXTURES.postToolUse, { ownerPid: unknown });
    await h.fire(common("stop", { generation_id: GEN2 }), { ownerPid: unknown });
    expect(walks).toBe(1);
    expect((await h.record())!.pid).toBe(CURSOR_UNKNOWN_OWNER_PID);
    // Past it, a prompt looks again: a dead pid is still unknown…
    h.clock.now += CURSOR_OWNER_RETRY_MS;
    await h.fire(common("beforeSubmitPrompt", { generation_id: "gen-3", prompt: "again" }), { ownerPid: () => 999_999_999 });
    expect((await h.record())!.pid).toBe(CURSOR_UNKNOWN_OWNER_PID);
    // …and a live one is adopted.
    h.clock.now += CURSOR_OWNER_RETRY_MS;
    await h.fire(common("beforeSubmitPrompt", { generation_id: "gen-4", prompt: "again" }));
    expect((await h.record())!.pid).toBe(process.pid);
    expect((await h.record())!.ownerCheckedAt).toBeUndefined();
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
    // None of those reached the POST (the harness's default `post` records every attempt) or the disk.
    expect(h.posts).toHaveLength(0);
    expect(await h.record()).toBeNull();
    expect(await readdir(h.sessionsDir).catch(() => [])).toEqual([]);

    // A THROWING POST is swallowed too — and the row is recorded before it is attempted.
    let attempts = 0;
    await h.fire(FIXTURES.beforeSubmitPrompt, { post: async () => { attempts++; throw new Error("network down"); } });
    expect(attempts).toBe(1);
    expect(await h.record()).toMatchObject({ agent: "cursor", op: "start", lastEvent: "sessionStart", turnId: GEN1 });
    // A failed done stays owed for the watchdog.
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

describe("the real entry (src/entries/cursor-status.ts), spawned", () => {
  // The contract with Cursor is about the PROCESS: nothing on stdout (anything there is read as a
  // decision), nothing on stderr, exit 0 — whatever arrives on stdin. Only a spawn can see that.
  async function spawnEntry(home: string, stdin: string): Promise<{ code: number; out: string; err: string }> {
    const proc = spawnTestProcess({
      cmd: ["bun", ENTRY],
      env: isolatedTestEnv(home),
      stdin: Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  }
  const GARBAGE = ["", "{not json", "[1,2]", "null", "\u0000\u0001", JSON.stringify({ hook_event_name: "stop" })];

  test("unpaired: silent and exit 0 for every registered event and for garbage", async () => {
    const home = await mkdtemp(join(tmpdir(), "nomo-cursor-entry-"));
    dirs.push(home);
    for (const stdin of [...Object.values(FIXTURES).map((f) => JSON.stringify(f)), ...GARBAGE]) {
      expect(await spawnEntry(home, stdin)).toEqual({ code: 0, out: "", err: "" });
    }
  }, 60_000);

  test("paired: still silent while it really records and POSTs; and silent when the relay is down", async () => {
    const home = await mkdtemp(join(tmpdir(), "nomo-cursor-entry-"));
    dirs.push(home);
    const seen: string[] = [];
    const relay = Bun.serve({
      port: 0,
      fetch: async (req) => { seen.push(((await req.json()) as { op: string }).op); return new Response("{}"); },
    });
    const cc = join(home, ".config", "cc-status");
    await mkdir(cc, { recursive: true });
    const writeConfig = (url: string) => writeFile(join(cc, "config.json"),
      JSON.stringify({ url, pairingId: "a".repeat(32), pcSecret: "s", e2eKeyB64: b64url(KEY) }));
    try {
      await writeConfig(`http://127.0.0.1:${relay.port}`);
      for (const f of Object.values(FIXTURES)) {
        expect(await spawnEntry(home, JSON.stringify(f))).toEqual({ code: 0, out: "", err: "" });
      }
      expect(seen).toEqual(["start", "done", "end"]); // tool events fell inside the keep-alive window
      for (const stdin of GARBAGE) expect(await spawnEntry(home, stdin)).toEqual({ code: 0, out: "", err: "" });
    } finally {
      relay.stop(true);
    }
    // Relay gone (connection refused): the prompt hook is as quiet as ever, and the row is on disk.
    expect(await spawnEntry(home, JSON.stringify(FIXTURES.beforeSubmitPrompt))).toEqual({ code: 0, out: "", err: "" });
    expect(await readRecord(CONV, join(cc, "sessions"))).toMatchObject({ agent: "cursor", lastEvent: "sessionStart" });
  }, 60_000);
});

describe("the build", () => {
  test("build.ts lists cursor-status.ts as an entrypoint, and the entry file exists", async () => {
    // Read as text: build.ts builds on import. This pins the ENTRYPOINTS row — without it the
    // installer's hook command points at a bundle no build ever produces — and needs no plugin/dist.
    const build = await readFile(join(import.meta.dir, "../../build.ts"), "utf8");
    const list = build.slice(build.indexOf("const ENTRYPOINTS = ["), build.indexOf('].map((f) => join(HERE, "src", "entries", f))'));
    expect(list.length).toBeGreaterThan(0);
    const entries = [...list.matchAll(/^\s*"([^"]+\.ts)",/gm)].map((m) => m[1]);
    expect(entries).toContain("cursor-status.ts");
    expect(entries).toContain("cc-status.ts"); // the parse itself is sound
    expect(await Bun.file(ENTRY).exists()).toBe(true);
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
    // Bounded like the title: the payload is not ours, and the model rides every sealed blob.
    expect(await cursorAdapter.model!({ ...ctx, input: { model: "m".repeat(500) } })).toBe("m".repeat(80));
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

describe("Cursor's own chat title", () => {
  /** A state.vscdb with Cursor's real table shape, built by the same system sqlite3 the lookup uses. */
  async function fixtureDb(rows: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "nomo-cursor-db-"));
    dirs.push(root);
    const db = join(root, "state.vscdb");
    const q = (v: string) => `'${v.replaceAll("'", "''")}'`;
    execFileSync("sqlite3", [db, [
      "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
      ...Object.entries(rows).map(([id, value]) => `INSERT INTO cursorDiskKV VALUES (${q(`composerData:${id}`)}, ${q(value)});`),
    ].join("\n")]);
    return db;
  }

  test("reads `name` by exact conversation id — and nothing else from the record", async () => {
    const db = await fixtureDb({
      [CONV]: JSON.stringify({ composerId: CONV, name: "  Flaky retry\ntest fix ", user_email: EMAIL, text: "secret chat body" }),
      long: JSON.stringify({ name: "word ".repeat(60) }),
    });
    expect(cursorChatTitle(CONV, db)).toBe("Flaky retry test fix");
    expect(cursorChatTitle("long", db)!.length).toBeLessThanOrEqual(81); // the cap every generated title gets
  });

  test("the user's sqlite rc (`.headers on`, `.mode box`) cannot reach the title", async () => {
    const db = await fixtureDb({ [CONV]: JSON.stringify({ name: "Flaky retry test fix" }) });
    // Both places the CLI looks: ~/.sqliterc and $XDG_CONFIG_HOME/sqlite3/sqliterc (macOS resolves ~
    // from the passwd entry, not $HOME, so the XDG one is what actually redirects it there).
    const home = join(db, "..", "home");
    await mkdir(join(home, "sqlite3"), { recursive: true });
    const rc = ".headers on\n.mode box\n";
    await writeFile(join(home, ".sqliterc"), rc);
    await writeFile(join(home, "sqlite3", "sqliterc"), rc);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home };
    // The fixture is real: the same child environment, without the lookup's flags, IS reshaped.
    expect(execFileSync("sqlite3", ["-readonly", db, "select 1"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env }).trim()).not.toBe("1");
    expect(cursorChatTitle(CONV, db, env)).toBe("Flaky retry test fix");
  });

  test("absent, blank, non-string, malformed, hostile id, missing database → undefined (and nothing is created)", async () => {
    const db = await fixtureDb({
      unnamed: JSON.stringify({ composerId: "unnamed" }),
      blank: JSON.stringify({ name: "   " }),
      numeric: JSON.stringify({ name: 42 }),
      object: JSON.stringify({ name: { text: "x" } }),
      broken: "{ not json",
    });
    for (const id of ["unnamed", "blank", "numeric", "object", "broken", "no-such-chat", "x' or '1'='1", ""]) {
      expect(cursorChatTitle(id, db)).toBeUndefined();
    }
    const missing = join(db, "..", "nope.vscdb");
    expect(cursorChatTitle(CONV, missing)).toBeUndefined();
    expect(await readdir(join(db, ".."))).toEqual(["state.vscdb"]); // -readonly never creates a file
    await writeFile(missing, "this is not a database");
    expect(cursorChatTitle(CONV, missing)).toBeUndefined();
  });

  test("the hook: never looked up on a prompt; a keep-alive and the stop carry it; a later prompt keeps it", async () => {
    const h = await harness();
    const asked: string[] = [];
    let name: string | undefined;
    const chatTitle = (id: string) => { asked.push(id); return name; };

    await h.fire(FIXTURES.beforeSubmitPrompt, { chatTitle });
    expect(asked).toEqual([]); // Cursor waits on this hook
    expect(await h.lastBlob()).toMatchObject({ title: "Fix the flaky retry test" });

    h.clock.now += 1000;
    await h.fire(FIXTURES.postToolUse, { chatTitle }); // inside the keep-alive window: no send, no read
    expect(asked).toEqual([]);

    h.clock.now += CURSOR_KEEPALIVE_MS;
    await h.fire(FIXTURES.afterFileEdit, { chatTitle }); // no name yet → the first prompt stands
    expect(asked).toEqual([CONV]);
    expect(await h.lastBlob()).toMatchObject({ status: "working", title: "Fix the flaky retry test" });

    name = "Flaky retry test fix";
    await h.fire(FIXTURES.stop, { chatTitle });
    expect(await h.lastBlob()).toMatchObject({ status: "done", title: "Flaky retry test fix" });
    expect((await h.record())!.title).toBe("Flaky retry test fix");

    name = undefined; // unreadable from here on: the title already learned is kept, not regressed
    await h.fire(common("beforeSubmitPrompt", { prompt: "And another thing", generation_id: GEN2 }), { chatTitle });
    await h.fire(common("stop", { status: "completed", generation_id: GEN2 }), { chatTitle });
    expect(await h.lastBlob()).toMatchObject({ status: "done", title: "Flaky retry test fix" });
    expect(JSON.stringify(h.posts) + JSON.stringify(await h.record())).not.toContain(EMAIL);
  });

  test("the watchdog: a name that lands after the stop → ONE title frame; unchanged or absent → none", async () => {
    const h = await harness();
    await h.fire(FIXTURES.beforeSubmitPrompt);
    await h.fire(FIXTURES.stop);
    const path = join(h.sessionsDir, `${CONV}.json`);
    const sent: Record<string, unknown>[] = [];
    const post = async (body: object) => { sent.push(body as Record<string, unknown>); return "delivered" as const; };
    const sweep = async (name: string | undefined) => repairTitle(CONFIG, path, CONV, (await h.record())!, { post, resolve: () => name });

    expect(await sweep(undefined)).toBe("uncorrected"); // no name yet (or the CLI: never one)
    expect(await sweep("Fix the flaky retry test")).toBe("uncorrected"); // same as the record's
    expect(sent).toHaveLength(0);

    expect(await sweep("Flaky retry test fix")).toBe("corrected");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionId: CONV, op: "done", prio: 0 }); // the row's state is untouched
    expect(await decryptBlob(KEY, sent[0]!.blob as string)).toMatchObject({ status: "done", title: "Flaky retry test fix", agent: "cursor" });
    expect((await h.record())!.title).toBe("Flaky retry test fix");

    expect(await sweep("Flaky retry test fix")).toBe("uncorrected"); // the next sweep finds nothing new
    expect(sent).toHaveLength(1);
  });

  test("the watchdog: a record a hook moved is never answered with the sweep's stale snapshot", async () => {
    const h = await harness();
    await h.fire(FIXTURES.beforeSubmitPrompt);
    await h.fire(FIXTURES.stop);
    const path = join(h.sessionsDir, `${CONV}.json`);
    const snapshot = (await h.record())!;
    const sent: object[] = [];
    // A new prompt lands DURING the POST: the frame is already out, but the working record stays.
    const racing = async (body: object) => { sent.push(body); await h.fire(FIXTURES.beforeSubmitPrompt); return "delivered" as const; };
    await repairTitle(CONFIG, path, CONV, snapshot, { post: racing, resolve: () => "Flaky retry test fix" });
    expect(sent).toHaveLength(1);
    const moved = (await h.record())!;
    expect(moved).toMatchObject({ lastEvent: "working" });
    expect(moved.title).not.toBe("Flaky retry test fix");
    expect(moved.blob).not.toBe((sent[0] as { blob: string }).blob);

    // Moved BEFORE the POST (the sweep's snapshot is still the done one): no frame at all.
    const post = async (body: object) => { sent.push(body); return "delivered" as const; };
    expect(await repairTitle(CONFIG, path, CONV, snapshot, { post, resolve: () => "Flaky retry test fix" })).toBe("uncorrected");
    expect(sent).toHaveLength(1);
    expect(await h.record()).toEqual(moved);
  });

  test("the watchdog only looks at a row that finished moments ago", () => {
    const now = 100_000_000_000;
    const rec = (over: Partial<SessionRecord>): SessionRecord => ({
      pid: 1, machine: "m", label: "l", ts: now - 1000, transcript: "", lastEvent: "done", sentDone: true,
      op: "done", prio: 0, agent: "cursor", title: "first prompt", ...over,
    } as SessionRecord);
    expect(shouldRepairTitle(rec({}), now)).toBe(true);
    expect(shouldRepairTitle(rec({ lastEvent: "working", op: "update" }), now)).toBe(false); // the hook's frames carry it
    expect(shouldRepairTitle(rec({ ts: now - CURSOR_TITLE_REPAIR_MS }), now)).toBe(false);
  });
});
