// Tests for the Devin producer (core/devin.ts): classification, the state mapping, the owner pick, and
// end-to-end passes through runDevinHook against a temp sessions dir with the POST captured. Nothing
// here touches the network, the real ~/.local/share/devin, or the real Nomo state dir.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { decryptBlob } from "./crypto";
import { CURSOR_KEEPALIVE_MS } from "./cursor";
import { DevinHookDeps, devinEventKind, devinOwnerPid, planDevin, runDevinHook } from "./devin";
import { Config, readRecord, SessionRecord } from "./shared";

const KEY = new Uint8Array(32).fill(7);
const CONFIG: Config = { url: "https://example.invalid", pairingId: "pairing-1", pcSecret: "secret", e2eKey: KEY };
const NOW = 1_800_000_000_000;
const SID = "brawny-shirt";

const rec = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({ pid: 1, machine: "m", label: "l", ts: NOW - 60_000, lastEvent: "working", op: "update", prio: 0, agent: "devin", ...over }) as SessionRecord;

/** Devin's payloads, in the shape the 2026-11-07 spike logged (no cwd, no transcript_path). */
const ev = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
  ({ hook_event_name, session_id: SID, prompt_id: "p1", ...extra });

describe("devinEventKind", () => {
  test("maps the registered events; PreToolUse only for ask_user_question", () => {
    expect(devinEventKind(ev("UserPromptSubmit", { prompt: "x" }))).toBe("prompt");
    expect(devinEventKind(ev("PostToolUse", { tool_name: "exec" }))).toBe("tool");
    expect(devinEventKind(ev("PermissionRequest", { tool_name: "write" }))).toBe("permission");
    expect(devinEventKind(ev("Stop"))).toBe("stop");
    expect(devinEventKind(ev("SessionEnd", { reason: "other" }))).toBe("end");
    expect(devinEventKind({ hook_event_name: "PreToolUse", tool_name: "exec" })).toBeUndefined();
    expect(devinEventKind({ hook_event_name: "PreToolUse", tool_name: "ask_user_question" })).toBe("ask");
    expect(devinEventKind(ev("SessionStart"))).toBeUndefined();
    expect(devinEventKind({})).toBeUndefined();
  });
});

describe("planDevin", () => {
  test("only a prompt creates a row", () => {
    expect(planDevin("tool", {}, null, NOW)).toBeNull();
    expect(planDevin("stop", {}, null, NOW)).toBeNull();
    expect(planDevin("permission", {}, null, NOW)).toBeNull();
    expect(planDevin("prompt", { prompt_id: "p1" }, null, NOW)).toMatchObject({ op: "start", status: "working", promptId: "p1", turnStartedAt: NOW / 1000 });
  });
  test("PostToolUse is a 15 s keep-alive on a working row, immediate on a needs-attention row", () => {
    expect(planDevin("tool", {}, rec({ lastEvent: "working", ts: NOW - 5_000 }), NOW)).toBeNull();
    expect(planDevin("tool", {}, rec({ lastEvent: "working", ts: NOW - CURSOR_KEEPALIVE_MS }), NOW)).toMatchObject({ status: "working" });
    expect(planDevin("tool", {}, rec({ lastEvent: "needsAttention", ts: NOW - 1_000 }), NOW)).toMatchObject({ status: "working", prio: 0 });
  });
  test("a tool event after Stop re-arms only for the same prompt_id (a Stop hook kept the turn going)", () => {
    const done = rec({ op: "done", lastEvent: "done", turnId: "p1" });
    expect(planDevin("tool", { prompt_id: "p1" }, done, NOW)).toMatchObject({ status: "working", promptId: "p1" });
    expect(planDevin("tool", { prompt_id: "p0" }, done, NOW)).toBeNull();
    expect(planDevin("tool", {}, done, NOW)).toBeNull();
  });
  test("ask / permission → needsAttention prio 1; Stop → done; SessionEnd → end", () => {
    const working = rec({ turnId: "p1" });
    expect(planDevin("ask", { prompt_id: "p1" }, working, NOW)).toMatchObject({ op: "update", prio: 1, status: "needsAttention" });
    expect(planDevin("permission", { prompt_id: "p1" }, working, NOW)).toMatchObject({ op: "update", prio: 1, status: "needsAttention" });
    expect(planDevin("stop", {}, working, NOW)).toMatchObject({ op: "done", status: "done", promptId: "p1" });
    expect(planDevin("end", {}, working, NOW)).toMatchObject({ op: "end" });
    // a second Stop on a delivered done adds nothing; an undelivered one retries
    expect(planDevin("stop", {}, rec({ op: "done", lastEvent: "done" }), NOW)).toBeNull();
    expect(planDevin("stop", {}, rec({ op: "done", lastEvent: "done", donePending: true }), NOW)).toMatchObject({ op: "done" });
    // a new prompt opens a new turn
    expect(planDevin("prompt", { prompt_id: "p2" }, rec({ op: "done", lastEvent: "done", turnId: "p1" }), NOW)).toMatchObject({ op: "update", status: "working", promptId: "p2" });
  });
});

describe("devinOwnerPid", () => {
  test("picks the nearest devin executable, never an argument", () => {
    expect(devinOwnerPid([{ pid: 9, command: "/bin/sh -c x" }, { pid: 8, command: "/Users/u/.local/bin/devin acp" }, { pid: 7, command: "/Users/u/.local/bin/devin -p hi" }])).toBe(8);
    expect(devinOwnerPid([{ pid: 9, command: "vim /Users/u/.local/bin/devin" }])).toBeUndefined();
    expect(devinOwnerPid([{ pid: 9, command: "devin" }])).toBe(9);
    expect(devinOwnerPid([{ pid: 9, command: undefined }, { pid: 8, command: "/opt/devinx" }])).toBeUndefined();
  });
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function harness(over: Partial<DevinHookDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), "nomo-devin-"));
  dirs.push(root);
  const sessionsDir = join(root, "sessions");
  const posts: Record<string, unknown>[] = [];
  const clock = { now: Date.now() }; // real clock: the record's ts is stamped by the fs helpers
  let meta: { title?: string; model?: string; cwd?: string } = {};
  const deps: DevinHookDeps = {
    config: CONFIG, sessionsDir, stampPath: join(root, "last-hook-devin"), now: () => clock.now,
    env: { DEVIN_PROJECT_DIR: "/tmp/nomo-devin-fixture/api" },
    ownerPid: () => process.pid, sessionMeta: () => meta,
    post: async (_c, envelope) => { posts.push(envelope); return true; },
    ensureWatchdog: () => {}, trace: () => {}, ...over,
  };
  return {
    sessionsDir, posts, clock, root,
    setMeta: (m: typeof meta) => { meta = m; },
    fire: (payload: Record<string, unknown>, o: Partial<DevinHookDeps> = {}) => runDevinHook(JSON.stringify(payload), { ...deps, ...o }),
    record: () => readRecord(SID, sessionsDir),
    lastBlob: async () => await decryptBlob(KEY, posts.at(-1)!.blob as string) as Record<string, unknown>,
  };
}

describe("runDevinHook", () => {
  test("seals agent:devin with the prompt title, then Devin's own title on Stop", async () => {
    const h = await harness();
    await h.fire(ev("UserPromptSubmit", { prompt: "fix the login bug" }));
    expect(h.posts.at(-1)).toMatchObject({ sessionId: SID, op: "start" });
    expect(await h.lastBlob()).toMatchObject({ agent: "devin", status: "working", title: "fix the login bug", label: "api" });
    expect((await h.lastBlob()).model).toBeUndefined();

    h.clock.now += 20_000;
    h.setMeta({ title: "Fix login bug", model: "swe-2-flash-medium" });
    await h.fire(ev("PostToolUse", { tool_name: "exec", tool_input: { command: "secret-command" } }));
    const tool = await h.lastBlob();
    expect(tool).toMatchObject({ agent: "devin", status: "working", detail: "thinking", title: "Fix login bug", model: "swe-2-flash-medium" });
    expect(JSON.stringify(tool)).not.toContain("secret-command");

    await h.fire(ev("Stop", { stop_hook_active: false, last_assistant_message: "done" }));
    expect(h.posts.at(-1)).toMatchObject({ op: "done" });
    expect(await h.lastBlob()).toMatchObject({ status: "done", title: "Fix login bug", agent: "devin" });
    expect(await h.record()).toMatchObject({ agent: "devin", op: "done", turnId: "p1", pid: process.pid });

    await h.fire(ev("SessionEnd", { reason: "other" }));
    expect(h.posts.at(-1)).toMatchObject({ op: "end" });
    expect(await h.record()).toBeNull();
  });

  test("the paused-approvals delegate (a PermissionRequest payload) posts needsAttention prio 1", async () => {
    const h = await harness();
    await h.fire(ev("UserPromptSubmit", { prompt: "write a file" }));
    await h.fire(ev("PermissionRequest", { tool_name: "write", tool_input: { file_path: "/x", content: "y" } }));
    expect(h.posts.at(-1)).toMatchObject({ op: "update", prio: 1 });
    expect(await h.lastBlob()).toMatchObject({ status: "needsAttention", agent: "devin" });
    // the next tool event clears it at once (no keep-alive wait)
    await h.fire(ev("PostToolUse", { tool_name: "write" }));
    expect(await h.lastBlob()).toMatchObject({ status: "working" });
  });

  test("is inert without DEVIN_PROJECT_DIR, unpaired, with an unsafe id, or on another agent's record", async () => {
    const h = await harness();
    const prompt = ev("UserPromptSubmit", { prompt: "hi" });
    await h.fire(prompt, { env: {} });
    await h.fire(prompt, { config: null });
    await h.fire({ ...prompt, session_id: "../evil" });
    expect(h.posts).toHaveLength(0);
    expect(await readdir(h.sessionsDir).catch(() => [])).toEqual([]);

    const { atomicWrite } = await import("./shared");
    await atomicWrite(join(h.sessionsDir, `${SID}.json`), JSON.stringify(rec({ agent: "cursor" })), 0o600);
    await h.fire(prompt);
    expect(h.posts).toHaveLength(0);
    expect(await h.record()).toMatchObject({ agent: "cursor" });
  });

  test("the prompt path never reads Devin's database", async () => {
    let reads = 0;
    const h = await harness({ sessionMeta: () => { reads++; return {}; } });
    await h.fire(ev("UserPromptSubmit", { prompt: "hi" }));
    await h.fire(ev("UserPromptSubmit", { prompt: "again", prompt_id: "p2" }));
    expect(reads).toBe(0);
  });
});
