// Tests for phone replies to Antigravity (core/antigravity-inbox.ts, its hook side in core/antigravity.ts,
// the wrapper's synchronous paths, and the watchdog command gates). Temp dirs only — never the real
// ~/.config/cc-status or ~/.gemini.

import { cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_REPLY_NUDGE, antigravitySurface, cancelReply, enqueueReply, handleReplyCommand, hasQueuedReplies,
  readReceipts, receiptOf, REPLY_RECEIPTS_MAX, REPLY_TEXT_MAX_CHARS, replyMessageId, replyRoute, replyText,
  takeReplies,
} from "./antigravity-inbox";
import { ANTIGRAVITY_INTERRUPT_SUFFIX, runAntigravityHook } from "./antigravity";
import { decryptBlob, encryptBlob } from "./crypto";
import { Config, SessionRecord, writeInterruptFlagAt } from "./shared";
import { classifySession, drainCommands, resetCommandState } from "../entries/cc-watchdog";
import { createProcessHygiene, isolatedTestEnv } from "../test/process-hygiene";

const { spawnTestProcess } = createProcessHygiene();
const PLUGIN = join(import.meta.dir, "../../plugin");
const KEY = new Uint8Array(32).fill(7);
const CONFIG: Config = { url: "https://example.invalid", pairingId: "pairing-1", pcSecret: "secret", e2eKey: KEY };
const CONV = "c0ffee00-0000-4000-8000-000000000002";
const NOW = 1_800_000_000_000;
const CLI_TRANSCRIPT = `/Users/x/.gemini/antigravity-cli/brain/${CONV}/.system_generated/logs/transcript_full.jsonl`;
const APP_TRANSCRIPT = `/Users/x/.gemini/antigravity/brain/${CONV}/.system_generated/logs/transcript_full.jsonl`;

const tmps: string[] = [];
afterEach(async () => { await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
beforeEach(() => { resetCommandState(); });
async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), "nomo-agy-reply-")));
  tmps.push(d);
  return d;
}
const rec = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({ op: "update", lastEvent: "working", ts: NOW, agent: "antigravity", pid: 4242, cwd: "/w/proj", transcript: CLI_TRANSCRIPT, ...over }) as SessionRecord;
const done = (over: Partial<SessionRecord> = {}) => rec({ op: "done", lastEvent: "done", ...over });

describe("message validation", () => {
  test("text: non-blank, ≤ 4000 chars, newlines ok, other control chars refused", () => {
    expect(replyText("also say BANANA")).toBe("also say BANANA");
    expect(replyText("line 1\nline 2")).toBe("line 1\nline 2");
    expect(replyText("x".repeat(REPLY_TEXT_MAX_CHARS))).toHaveLength(4000);
    for (const bad of ["", "   \n", "x".repeat(4001), "a\tb", "a\rb", "a\u0000b", "a\u001bb", "a\u007fb", 5, null]) {
      expect(replyText(bad)).toBeUndefined();
    }
  });
  test("mid: 8–64 url-safe chars, never a dot or slash", () => {
    expect(replyMessageId("AbC_-1234567")).toBe("AbC_-1234567");
    for (const bad of ["short", "has.dot12345", "../../etc/x", "a".repeat(65), 7]) expect(replyMessageId(bad)).toBeUndefined();
  });
  test("surface from the transcript path", () => {
    expect(antigravitySurface(CLI_TRANSCRIPT)).toBe("cli");
    expect(antigravitySurface(APP_TRANSCRIPT)).toBe("app");
    expect(antigravitySurface("/tmp/x")).toBeUndefined();
  });
});

describe("inbox: write / consume / cancel", () => {
  test("queue → take delivers in order once, with receipts; a second take gets nothing", async () => {
    const dir = await tmp();
    await enqueueReply(dir, CONV, { mid: "mid-bbbbbbbb", text: "second", ts: 2 });
    await enqueueReply(dir, CONV, { mid: "mid-aaaaaaaa", text: "first", ts: 1 });
    await enqueueReply(dir, "other-conv", { mid: "mid-cccccccc", text: "not ours", ts: 0 });
    expect(await receiptOf(dir, CONV, "mid-aaaaaaaa")).toBe("q");
    expect((await takeReplies(dir, CONV)).map((r) => r.text)).toEqual(["first", "second"]);
    expect(await takeReplies(dir, CONV)).toEqual([]);
    expect(await readReceipts(dir, CONV)).toEqual({ "mid-bbbbbbbb": "d", "mid-aaaaaaaa": "d" });
    expect(await hasQueuedReplies(dir, "other-conv")).toBe(true);
    // the files are 0600
    const names = await readdir(dir);
    expect(names.some((n) => n.endsWith(".tmp") || n.endsWith(".take"))).toBe(false);
  });
  test("cancel before delivery wins and the message is never taken; after delivery it is too late", async () => {
    const dir = await tmp();
    await enqueueReply(dir, CONV, { mid: "mid-aaaaaaaa", text: "nope", ts: 1 });
    expect(await cancelReply(dir, CONV, "mid-aaaaaaaa")).toBe(true);
    expect(await takeReplies(dir, CONV)).toEqual([]);
    expect(await receiptOf(dir, CONV, "mid-aaaaaaaa")).toBe("c");
    await enqueueReply(dir, CONV, { mid: "mid-bbbbbbbb", text: "yes", ts: 2 });
    await takeReplies(dir, CONV);
    expect(await cancelReply(dir, CONV, "mid-bbbbbbbb")).toBe(false);
    expect(await receiptOf(dir, CONV, "mid-bbbbbbbb")).toBe("d");
  });
  test("racing takes and cancels: every message ends up delivered XOR cancelled, exactly once", async () => {
    const dir = await tmp();
    const mids = Array.from({ length: 20 }, (_, i) => `mid-${String(i).padStart(8, "0")}`);
    for (const [i, mid] of mids.entries()) await enqueueReply(dir, CONV, { mid, text: `m${i}`, ts: i });
    const [a, b, ...cancels] = await Promise.all([
      takeReplies(dir, CONV), takeReplies(dir, CONV), ...mids.map((m) => cancelReply(dir, CONV, m)),
    ]);
    const taken = [...(a as { mid: string }[]), ...(b as { mid: string }[])].map((r) => r.mid);
    expect(new Set(taken).size).toBe(taken.length); // never twice
    for (const [i, mid] of mids.entries()) expect(taken.includes(mid)).toBe(!cancels[i]);
  });
  test("receipts are capped to the newest REPLY_RECEIPTS_MAX", async () => {
    const dir = await tmp();
    for (let i = 0; i < REPLY_RECEIPTS_MAX + 4; i++) {
      await enqueueReply(dir, CONV, { mid: `mid-${String(i).padStart(8, "0")}`, text: "x", ts: i });
      await Bun.sleep(2);
    }
    const r = await readReceipts(dir, CONV);
    expect(Object.keys(r)).toHaveLength(REPLY_RECEIPTS_MAX);
    expect(r["mid-00000000"]).toBeUndefined();
  });
});

describe("routing a send-message", () => {
  const alive = (pids: number[]) => (p: number) => pids.includes(p);
  test("running turn → queue; idle desktop app → reject; idle open agy TUI → queue; idle CLI, process gone → resume", () => {
    expect(replyRoute(rec(), false, alive([]))).toBe("queue");
    expect(replyRoute(done({ transcript: APP_TRANSCRIPT }), false, alive([4242]))).toBe("reject");
    expect(replyRoute(done(), false, alive([4242]))).toBe("queue");
    expect(replyRoute(done(), false, alive([]))).toBe("resume");
    expect(replyRoute(done(), true, alive([]))).toBe("queue"); // our own resume is still running
    expect(replyRoute(done({ transcript: "/elsewhere" }), false, alive([]))).toBe("reject");
    expect(replyRoute(done({ cwd: undefined }), false, alive([]))).toBe("reject");
  });

  test("handleReplyCommand: resume once, then queue behind the running resume; dupes and cancels", async () => {
    const dir = await tmp();
    const spawned: [string, string, string][] = [];
    let resumeAlive = true;
    const deps = {
      sessionsDir: dir, now: NOW,
      pidAlive: (p: number) => p === 777 && resumeAlive,
      resume: (c: string, cwd: string, t: string) => { spawned.push([c, cwd, t]); return 777; },
    };
    expect(await handleReplyCommand("send-message", CONV, done(), { mid: "mid-aaaaaaaa", text: "write the notes" }, deps)).toBe("reply-resumed");
    expect(spawned).toEqual([[CONV, "/w/proj", "write the notes"]]);
    expect(await receiptOf(dir, CONV, "mid-aaaaaaaa")).toBe("r");
    expect(await handleReplyCommand("send-message", CONV, done(), { mid: "mid-aaaaaaaa", text: "write the notes" }, deps)).toBe("reply-duplicate");
    expect(await handleReplyCommand("send-message", CONV, done(), { mid: "mid-bbbbbbbb", text: "and push" }, deps)).toBe("reply-queued");
    expect(spawned).toHaveLength(1); // never a second agy on the conversation
    expect(await handleReplyCommand("cancel-message", CONV, done(), { mid: "mid-bbbbbbbb" }, deps)).toBe("reply-cancelled");
    expect(await handleReplyCommand("cancel-message", CONV, done(), { mid: "mid-bbbbbbbb" }, deps)).toBe("reply-too-late");
    // resume finished; a message left queued by the previous agy rides along with the next resume
    resumeAlive = false;
    await enqueueReply(dir, CONV, { mid: "mid-cccccccc", text: "left over", ts: 1 });
    expect(await handleReplyCommand("send-message", CONV, done(), { mid: "mid-dddddddd", text: "new" }, deps)).toBe("reply-resumed");
    expect(spawned[1]![2]).toBe("left over\n\nnew");
    expect(await readReceipts(dir, CONV)).toMatchObject({ "mid-cccccccc": "r", "mid-dddddddd": "r" });
  });

  test("an idle desktop-app session is refused; a failed spawn falls back to queued; bad input is malformed", async () => {
    const dir = await tmp();
    const deps = { sessionsDir: dir, now: NOW, pidAlive: () => false, resume: () => undefined };
    expect(await handleReplyCommand("send-message", CONV, done({ transcript: APP_TRANSCRIPT }), { mid: "mid-aaaaaaaa", text: "hi" }, deps)).toBe("reply-rejected");
    expect(await receiptOf(dir, CONV, "mid-aaaaaaaa")).toBe("x");
    expect(await handleReplyCommand("send-message", CONV, done(), { mid: "mid-bbbbbbbb", text: "hi" }, deps)).toBe("reply-queued");
    expect(await hasQueuedReplies(dir, CONV)).toBe(true);
    expect(await handleReplyCommand("send-message", CONV, rec(), { mid: "bad", text: "hi" }, deps)).toBe("malformed");
    expect(await handleReplyCommand("send-message", CONV, rec(), { mid: "mid-cccccccc", text: "a\u0007" }, deps)).toBe("malformed");
  });
});

describe("hook side: PreInvocation injects, Stop continues, a phone Stop wins", () => {
  async function harness() {
    const dir = await tmp();
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const posts: Record<string, unknown>[] = [];
    const printed: string[] = [];
    let clock = NOW;
    const deps = {
      config: CONFIG, sessionsDir, stampPath: join(dir, "stamp"), now: () => clock,
      ownerPid: () => undefined, chatTitle: () => "T", ensureWatchdog: () => {}, trace: () => {},
      post: async (_c: Config, e: Record<string, unknown>) => { posts.push(e); return true; },
      emit: async (line: string) => { printed.push(line); },
    };
    const fire = (event: string, extra: Record<string, unknown> = {}, over: object = {}) =>
      runAntigravityHook(JSON.stringify({ conversationId: CONV, workspacePaths: ["/w/proj"], transcriptPath: CLI_TRANSCRIPT, ...extra }), event, { ...deps, ...over });
    const lastBlob = async () => (await decryptBlob(KEY, posts.at(-1)!.blob as string)) as Record<string, unknown>;
    return { sessionsDir, posts, printed, fire, lastBlob, tick: (ms: number) => { clock += ms; }, now: () => clock };
  }

  test("a queued message is injected at the next PreInvocation and the phone gets 'd' at once (no throttle)", async () => {
    const h = await harness();
    await h.fire("PreInvocation", { invocationNum: 0 });
    expect(await h.lastBlob()).toMatchObject({ surface: "cli" });
    const n = h.posts.length;
    await enqueueReply(h.sessionsDir, CONV, { mid: "mid-aaaaaaaa", text: "also say \"BANANA\"", ts: 1 });
    await enqueueReply(h.sessionsDir, CONV, { mid: "mid-bbbbbbbb", text: "and then stop", ts: 2 });
    h.tick(1000); // well inside the keep-alive throttle
    await h.fire("PreInvocation", { invocationNum: 1 });
    expect(h.printed).toEqual([JSON.stringify({ injectSteps: [{ userMessage: "also say \"BANANA\"" }, { userMessage: "and then stop" }] })]);
    expect(h.posts.length).toBe(n + 1);
    expect(await h.lastBlob()).toMatchObject({ status: "working", replies: { "mid-aaaaaaaa": "d", "mid-bbbbbbbb": "d" } });
  });

  test("a DETACHED run (stdout not read) never consumes a message", async () => {
    const h = await harness();
    await enqueueReply(h.sessionsDir, CONV, { mid: "mid-aaaaaaaa", text: "x", ts: 1 });
    await h.fire("PreInvocation", {}, { canTerminate: false });
    expect(h.printed).toEqual([]);
    expect(await hasQueuedReplies(h.sessionsDir, CONV)).toBe(true);
  });

  test("Stop with a message pending → continue (row stays working), once per window; next PreInvocation injects", async () => {
    const h = await harness();
    await h.fire("PreInvocation", { invocationNum: 0 });
    await enqueueReply(h.sessionsDir, CONV, { mid: "mid-aaaaaaaa", text: "one more thing", ts: 1 });
    await h.fire("Stop", { fullyIdle: true });
    expect(h.printed).toEqual([JSON.stringify({ decision: "continue", reason: ANTIGRAVITY_REPLY_NUDGE })]);
    expect(await hasQueuedReplies(h.sessionsDir, CONV)).toBe(true);
    expect(h.posts.every((p) => p.op !== "done")).toBe(true);
    // loop guard: a second Stop inside the window (the inject failed) does NOT continue again → done
    await h.fire("Stop", { fullyIdle: true });
    expect(h.printed).toHaveLength(1);
    expect(await h.lastBlob()).toMatchObject({ status: "done" });
    // normal case: the PreInvocation after a continue injects it and clears the guard
    await h.fire("PreInvocation", { invocationNum: 1 });
    expect(h.printed.at(-1)).toBe(JSON.stringify({ injectSteps: [{ userMessage: "one more thing" }] }));
  });

  test("a phone Stop beats a reply: no inject into a dying turn, no continue; the message waits", async () => {
    const h = await harness();
    await h.fire("PreInvocation", { invocationNum: 0 });
    await enqueueReply(h.sessionsDir, CONV, { mid: "mid-aaaaaaaa", text: "x", ts: 1 });
    await writeInterruptFlagAt(h.sessionsDir, CONV, h.now(), ANTIGRAVITY_INTERRUPT_SUFFIX);
    await h.fire("PreInvocation", { invocationNum: 1 });
    expect(h.printed).toEqual([]);
    await h.fire("PostInvocation", { invocationNum: 1 });
    expect(h.printed).toEqual(['{"terminationBehavior":"terminate"}']);
    await h.fire("Stop", { terminationReason: "terminated" });
    expect(h.printed).toHaveLength(1); // no continue
    expect(await hasQueuedReplies(h.sessionsDir, CONV)).toBe(true);
    expect(await receiptOf(h.sessionsDir, CONV, "mid-aaaaaaaa")).toBe("q");
    // Stop's own check: a fresh flag at Stop time also blocks the continue
    await writeInterruptFlagAt(h.sessionsDir, CONV, h.now(), ANTIGRAVITY_INTERRUPT_SUFFIX);
    await h.fire("Stop", {});
    expect(h.printed).toHaveLength(1);
    // the next turn (user types at the Mac) takes it
    await h.fire("PreInvocation", { invocationNum: 0 });
    expect(h.printed.at(-1)).toBe(JSON.stringify({ injectSteps: [{ userMessage: "x" }] }));
  });
});

describe("antigravity-hook.sh: synchronous only while a reply waits, and only well-formed replies pass", () => {
  async function stubRoot(script: string) {
    const root = join(await tmp(), "plugin");
    await mkdir(join(root, "scripts"), { recursive: true });
    await cp(join(PLUGIN, "scripts", "antigravity-hook.sh"), join(root, "scripts", "antigravity-hook.sh"));
    await writeFile(join(root, "scripts", "run.sh"), `#!/bin/sh\ncat >/dev/null\n${script}\n`, { mode: 0o755 });
    return root;
  }
  async function run(root: string, home: string, event: string) {
    const started = Date.now();
    const proc = spawnTestProcess({
      cmd: [join(root, "scripts", "antigravity-hook.sh"), event], env: isolatedTestEnv(home),
      stdin: new Blob([`{"conversationId":"${CONV}"}`]), stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return { out, ms: Date.now() - started };
  }
  const inject = '{"injectSteps":[{"userMessage":"say \\"hi\\"\\nnow"}]}';
  const cont = `{"decision":"continue","reason":"${ANTIGRAVITY_REPLY_NUDGE}"}`;

  test("no inbox → fast path for PreInvocation/Stop even if the bundle would answer", async () => {
    const home = await tmp();
    const root = await stubRoot(`sleep 2; printf '%s\\n' '${inject}'`);
    for (const ev of ["PreInvocation", "Stop"]) {
      const r = await run(root, home, ev);
      expect(r.out).toBe("{}\n");
      expect(r.ms).toBeLessThan(1000);
    }
  });

  test("inbox present → the exact per-event shape passes; anything else is {}", async () => {
    const home = await tmp();
    const sessions = join(home, ".config", "cc-status", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `${CONV}.mid-aaaaaaaa.agy-inbox`), "{}");
    const cases: [string, string, string][] = [
      ["PreInvocation", `printf '%s\\n' '${inject}'`, `${inject}\n`],
      ["Stop", `printf '%s\\n' '${cont}'`, `${cont}\n`],
      ["PreInvocation", `printf '%s\\n' '${cont}'`, "{}\n"],             // wrong event's shape
      ["Stop", `printf '%s\\n' '${inject}'`, "{}\n"],
      ["PreInvocation", `printf '%s\\n%s\\n' noise '${inject}'`, "{}\n"], // two lines
      ["PreInvocation", "echo garbage", "{}\n"],
      ["PreInvocation", "", "{}\n"],
      ["PreInvocation", "kill -9 $$", "{}\n"],
      ["PostToolUse", `printf '%s\\n' '${inject}'`, "{}\n"],             // never sync for other events
    ];
    for (const [ev, script, want] of cases) expect((await run(await stubRoot(script), home, ev)).out).toBe(want);
  });

  test("the real bundle end to end: queued message → PreInvocation prints injectSteps once", async () => {
    const home = await tmp();
    const sessions = join(home, ".config", "cc-status", "sessions");
    await mkdir(sessions, { recursive: true });
    // paired, so the bundle reaches the reply step (the POST then fails fast against .invalid)
    await writeFile(join(home, ".config", "cc-status", "config.json"), JSON.stringify({
      url: "http://127.0.0.1:9", pairingId: "p", pcSecret: "s", e2eKeyB64: Buffer.from(KEY).toString("base64"),
    }), { mode: 0o600 });
    await enqueueReply(sessions, CONV, { mid: "mid-aaaaaaaa", text: "also BANANA", ts: 1 });
    const r = await run(join(PLUGIN), home, "PreInvocation");
    expect(r.out).toBe(`${JSON.stringify({ injectSteps: [{ userMessage: "also BANANA" }] })}\n`);
    expect(await hasQueuedReplies(sessions, CONV)).toBe(false);
    expect((await run(join(PLUGIN), home, "PreInvocation")).out).toBe("{}\n");
  });
});

describe("watchdog: send-message / cancel-message through drainCommands' gates", () => {
  const seal = async (over: Record<string, unknown>, id = `cmd-${Math.random()}`) => ({
    id, blob: await encryptBlob(KEY, { kind: "send-message", sessionId: CONV, ts: NOW, nonce: `n-${Math.random()}`, mid: "mid-aaaaaaaa", text: "hi", ...over }),
  });
  async function drain(cmds: { id: string; blob: string }[], records: { sessionId: string; rec: SessionRecord }[]) {
    const dir = await tmp();
    const traces: Record<string, unknown>[] = [];
    const published: string[] = [];
    await drainCommands(CONFIG, {
      take: () => cmds, readRecords: async () => records, now: () => NOW, trace: (e) => traces.push(e as Record<string, unknown>),
      replySessionsDir: dir, replyDeps: { pidAlive: () => true, resume: () => undefined },
      publishRepliesFn: async (id) => { published.push(id); },
    });
    return { dir, traces, published };
  }

  test("an authentic send for a running Antigravity row is queued and published", async () => {
    const r = await drain([await seal({})], [{ sessionId: CONV, rec: rec() }]);
    expect(r.traces[0]).toMatchObject({ kind: "send-message", agent: "antigravity", result: "reply-queued", mid: "mid-aaaaaaaa" });
    expect(r.published).toEqual([CONV]);
    expect(await hasQueuedReplies(r.dir, CONV)).toBe(true);
  });

  test("two different messages in one batch are both queued; the same mid twice is a batch duplicate", async () => {
    const r = await drain([
      await seal({ mid: "mid-aaaaaaaa" }), await seal({ mid: "mid-bbbbbbbb", text: "two" }), await seal({ mid: "mid-bbbbbbbb", text: "two" }),
    ], [{ sessionId: CONV, rec: rec() }]);
    expect(r.traces.map((t) => t.result)).toEqual(["reply-queued", "reply-queued", "duplicate"]);
  });

  test("the shared gates still apply: wrong key, stale, unknown session, another agent", async () => {
    const otherKey = new Uint8Array(32).fill(1);
    const r = await drain([
      { id: "x1", blob: await encryptBlob(otherKey, { kind: "send-message", sessionId: CONV, ts: NOW, nonce: "n1", mid: "mid-aaaaaaaa", text: "hi" }) },
      await seal({ ts: NOW - 121_000 }),
      await seal({ sessionId: "nobody" }),
      await seal({ sessionId: "claude-1" }),
      await seal({ kind: "cancel-message", sessionId: "claude-1" }),
    ], [{ sessionId: CONV, rec: rec() }, { sessionId: "claude-1", rec: rec({ agent: "claude" }) }]);
    expect(r.traces.map((t) => t.result)).toEqual(["decrypt-failed", "stale", "unknown-session", "unsupported", "unsupported"]);
    expect(await hasQueuedReplies(r.dir, CONV)).toBe(false);
  });

  test("malformed text / mid never reach the inbox and publish nothing", async () => {
    const r = await drain([await seal({ text: "a\u0000b" }), await seal({ mid: "../x" })], [{ sessionId: CONV, rec: rec() }]);
    expect(r.traces.map((t) => t.result)).toEqual(["malformed", "malformed"]);
    expect(r.published).toEqual([]);
  });

  test("an idle agy CLI row whose process died is KEPT (a reply can resume it); a desktop-app one is not", () => {
    const dead = () => false;
    expect(classifySession(done({ ts: NOW }), NOW, dead)).toBe("keep");
    expect(classifySession(done({ ts: NOW, transcript: APP_TRANSCRIPT }), NOW, dead)).toBe("end");
    expect(classifySession(rec({ ts: NOW }), NOW, dead)).toBe("end"); // a working row whose agy died
  });
});

test("receipts and surface ride the blob only for Antigravity (buildEnvelope extraFields is append-last)", async () => {
  const { buildEnvelope } = await import("./hook");
  const e = await buildEnvelope({ session_id: "s", cwd: "/w" }, "m", NOW, "t", KEY, false, "antigravity", NOW, 1, null, "g",
    { op: "update", prio: 0, status: "working" }, undefined, undefined, undefined, undefined, undefined, { surface: "cli", replies: { "mid-aaaaaaaa": "q" } });
  const plain = await decryptBlob(KEY, e!.blob as string) as Record<string, unknown>;
  expect(Object.keys(plain).slice(-2)).toEqual(["surface", "replies"]);
  const plainOld = await decryptBlob(KEY, (await buildEnvelope({ session_id: "s", cwd: "/w" }, "m", NOW, "t", KEY, false, "antigravity", NOW, 1, null, "g",
    { op: "update", prio: 0, status: "working" }))!.blob as string);
  expect(plainOld).not.toHaveProperty("replies");
});
