// Tests for phone replies to Antigravity (core/antigravity-inbox.ts, its hook side in core/antigravity.ts,
// the wrapper's synchronous paths, and the watchdog command gates). Temp dirs only — never the real
// ~/.config/cc-status or ~/.gemini.

import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  agyBinary, ANTIGRAVITY_REPLY_NUDGE, antigravitySurface, cancelReply, confirmResume, enqueueReply, handleReplyCommand,
  hasQueuedReplies, pruneStaleReplies, readReceipts, receiptOf, REPLY_PHONE_GIVE_UP_MS, REPLY_RECEIPTS_MAX,
  REPLY_TEXT_MAX_CHARS, replyMessageId, replyRoute, replyText, sweepStrandedReplies, takeReplies, writeReceipt,
} from "./antigravity-inbox";
import { ANTIGRAVITY_INTERRUPT_SUFFIX, runAntigravityHook } from "./antigravity";
import { decryptBlob, encryptBlob } from "./crypto";
import { Config, SessionRecord, writeInterruptFlagAt } from "./shared";
import { classifySession, correctIdleClaude, drainCommands, publishReplyReceipts, resetCommandState } from "../entries/cc-watchdog";
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
    // a take writes no receipt: `d` is the hook's to write once the message was handed over
    expect(await readReceipts(dir, CONV)).toEqual({ "mid-bbbbbbbb": "q", "mid-aaaaaaaa": "q" });
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
    expect(await receiptOf(dir, CONV, "mid-bbbbbbbb")).toBe("q"); // the taker writes d next
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
  test("receipts beyond REPLY_RECEIPTS_MAX are evicted only when final AND past the phone's 1 h give-up", async () => {
    const dir = await tmp();
    for (let i = 0; i < REPLY_RECEIPTS_MAX + 4; i++) {
      await enqueueReply(dir, CONV, { mid: `mid-${String(i).padStart(8, "0")}`, text: "x", ts: i });
      if (i !== 1) await writeReceipt(dir, CONV, `mid-${String(i).padStart(8, "0")}`, "d"); // #1 stays q
      await Bun.sleep(2);
    }
    // fresh: the phone may still re-send any of them → nothing evicted
    expect(Object.keys(await readReceipts(dir, CONV))).toHaveLength(REPLY_RECEIPTS_MAX + 4);
    // 2 h later: the oldest final ones go; the still-queued #1 never does
    const r = await readReceipts(dir, CONV, Date.now() + 2 * REPLY_PHONE_GIVE_UP_MS);
    expect(Object.keys(r)).toHaveLength(REPLY_RECEIPTS_MAX + 1);
    expect(r["mid-00000000"]).toBeUndefined();
    expect(r["mid-00000001"]).toBe("q");
  });
  test("an unreadable queued message is refused (x), never silently dropped", async () => {
    const dir = await tmp();
    await writeFile(join(dir, `${CONV}.mid-aaaaaaaa.agy-inbox`), "{not json");
    expect(await takeReplies(dir, CONV)).toEqual([]);
    expect(await receiptOf(dir, CONV, "mid-aaaaaaaa")).toBe("x");
  });
  test("pruneStaleReplies also removes day-old .take / .cancel claims a killed process left", async () => {
    const dir = await tmp();
    const take = join(dir, `${CONV}.mid-aaaaaaaa.agy-inbox.123.take`);
    const cancel = join(dir, `${CONV}.mid-bbbbbbbb.agy-inbox.456.cancel`);
    const other = join(dir, `${CONV}.json`);
    for (const f of [take, cancel, other]) await writeFile(f, "{}");
    await pruneStaleReplies(dir, Date.now() + 2 * 24 * 60 * 60_000);
    expect((await readdir(dir)).sort()).toEqual([`${CONV}.json`]);
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
    expect(await receiptOf(dir, CONV, "mid-aaaaaaaa")).toBe("w"); // waking: no cancel; r once the run is alive
    expect(await handleReplyCommand("cancel-message", CONV, done(), { mid: "mid-aaaaaaaa" }, deps)).toBe("reply-too-late");
    expect(await confirmResume(dir, CONV)).toBe(true);
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
    await confirmResume(dir, CONV);
    expect(await readReceipts(dir, CONV)).toMatchObject({ "mid-cccccccc": "r", "mid-dddddddd": "r" });
  });

  test("the resumed run's first PreInvocation confirms even if it beats the .agy-resume write", async () => {
    const dir = await tmp();
    let atSpawn: string | undefined;
    const deps = {
      sessionsDir: dir, now: NOW, pidAlive: () => false,
      // the child's hook could run the instant it exists: the receipt must already say `w` here
      resume: () => { atSpawn = readFileSync(join(dir, `${CONV}.mid-aaaaaaaa.agy-reply`), "utf8"); return 777; },
    };
    expect(await handleReplyCommand("send-message", CONV, done(), { mid: "mid-aaaaaaaa", text: "hi" }, deps)).toBe("reply-resumed");
    expect(atSpawn).toBe("w");
    await rm(join(dir, `${CONV}.agy-resume`)); // as if the hook ran before the file landed
    expect(await confirmResume(dir, CONV)).toBe(true);
    expect(await receiptOf(dir, CONV, "mid-aaaaaaaa")).toBe("r");
    expect(await confirmResume(dir, CONV)).toBe(false); // r is never touched again
  });

  test("a resumed agy that dies before its first step: its messages go x, never a false 'Resumed'", async () => {
    const dir = await tmp();
    let alive = true;
    const deps = { sessionsDir: dir, now: NOW, pidAlive: (p: number) => p === 777 && alive, resume: () => 777 };
    expect(await handleReplyCommand("send-message", CONV, done(), { mid: "mid-aaaaaaaa", text: "hi" }, deps)).toBe("reply-resumed");
    expect(await sweepStrandedReplies(dir, CONV, done(), deps)).toEqual({ refused: [], resumed: false }); // still starting
    alive = false;
    expect(await sweepStrandedReplies(dir, CONV, done(), deps)).toEqual({ refused: ["mid-aaaaaaaa"], resumed: false });
    expect(await receiptOf(dir, CONV, "mid-aaaaaaaa")).toBe("x");
  });

  test("watchdog sweep: a message stranded behind an owner that has since exited is resumed", async () => {
    const dir = await tmp();
    const spawned: string[] = [];
    let ownerAlive = true;
    const deps = {
      sessionsDir: dir, now: NOW, pidAlive: (p: number) => p === 4242 && ownerAlive,
      resume: (_c: string, _cwd: string, t: string) => { spawned.push(t); return 999; },
    };
    // the open agy TUI is idle → queued behind it
    expect(await handleReplyCommand("send-message", CONV, done(), { mid: "mid-aaaaaaaa", text: "later" }, deps)).toBe("reply-queued");
    expect((await sweepStrandedReplies(dir, CONV, done(), deps)).resumed).toBe(false); // owner still alive
    // a working row (the Stop-vs-done gap) is never resumed either
    ownerAlive = false;
    expect((await sweepStrandedReplies(dir, CONV, rec(), deps)).resumed).toBe(false);
    // owner gone, row done → resumed with the stranded message; a second sweep finds nothing to do
    expect((await sweepStrandedReplies(dir, CONV, done(), deps)).resumed).toBe(true);
    expect(spawned).toEqual(["later"]);
    expect(await hasQueuedReplies(dir, CONV)).toBe(false);
    expect(await receiptOf(dir, CONV, "mid-aaaaaaaa")).toBe("w");
    expect((await sweepStrandedReplies(dir, CONV, done(), deps)).resumed).toBe(false);
    // no inbox at all → nothing spawned
    expect((await sweepStrandedReplies(dir, "other-conv", done(), deps)).resumed).toBe(false);
    expect(spawned).toHaveLength(1);
  });

  test("agyBinary only trusts absolute PATH entries", async () => {
    const dir = await tmp();
    await mkdir(join(dir, "rel"), { recursive: true });
    await writeFile(join(dir, "rel", "agy"), "", { mode: 0o755 });
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(agyBinary({ PATH: "rel", HOME: "/h" })).toBe("/h/.local/bin/agy");
      expect(agyBinary({ PATH: `rel:${join(dir, "rel")}`, HOME: "/h" })).toBe(join(dir, "rel", "agy"));
    } finally { process.chdir(cwd); }
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

  test("a FOREIGN conversation's inbox keeps this one on the fast path", async () => {
    const home = await tmp();
    const sessions = join(home, ".config", "cc-status", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "other.conv-1.mid-aaaaaaaa.agy-inbox"), "{}");
    const root = await stubRoot(`sleep 2; printf '%s\\n' '${inject}'`);
    for (const ev of ["PreInvocation", "Stop"]) {
      const r = await run(root, home, ev);
      expect(r.out).toBe("{}\n");
      expect(r.ms).toBeLessThan(1000);
    }
  });

  test("sync: the wrapper returns at the bundle's FIRST line, not when the bundle exits", async () => {
    const home = await tmp();
    const sessions = join(home, ".config", "cc-status", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `${CONV}.mid-aaaaaaaa.agy-inbox`), "{}");
    let r = await run(await stubRoot(`printf '%s\\n' '${inject}'; sleep 2`), home, "PreInvocation");
    expect(r.out).toBe(`${inject}\n`);
    expect(r.ms).toBeLessThan(1000);
    r = await run(await stubRoot("echo; sleep 2"), home, "Stop"); // "nothing to say" → {} at once
    expect(r.out).toBe("{}\n");
    expect(r.ms).toBeLessThan(1000);
  });

  test("the real bundle answers before its POST finishes (a 3 s worker never delays the hook)", async () => {
    const home = await tmp();
    const sessions = join(home, ".config", "cc-status", "sessions");
    await mkdir(sessions, { recursive: true });
    let posted = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async () => { posted++; await Bun.sleep(3000); return Response.json({ ok: true }); } });
    try {
      await writeFile(join(home, ".config", "cc-status", "config.json"), JSON.stringify({
        url: `http://127.0.0.1:${server.port}`, pairingId: "p", pcSecret: "s", e2eKeyB64: Buffer.from(KEY).toString("base64"),
      }), { mode: 0o600 });
      await enqueueReply(sessions, CONV, { mid: "mid-aaaaaaaa", text: "fast", ts: 1 });
      const r = await run(join(PLUGIN), home, "PreInvocation");
      expect(r.out).toBe(`${JSON.stringify({ injectSteps: [{ userMessage: "fast" }] })}\n`);
      expect(r.ms).toBeLessThan(2000);
      for (let i = 0; i < 100 && (posted === 0 || await receiptOf(sessions, CONV, "mid-aaaaaaaa") !== "d"); i++) await Bun.sleep(20);
      expect(await receiptOf(sessions, CONV, "mid-aaaaaaaa")).toBe("d");
      expect(posted).toBe(1); // the POST still happens, after the answer
    } finally { server.stop(true); }
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
    expect(classifySession(rec({ ts: NOW }), NOW, dead)).toBe("keep"); // a working row whose agy died: settled, not ended
  });

  test("a reply queued while agy ran survives agy exiting mid-turn with no Stop (headless auto-deny)", async () => {
    const dir = await tmp();
    const spawned: string[] = [];
    let ownerAlive = true;
    const pidAlive = (p: number) => p === 4242 && ownerAlive;
    const deps = { sessionsDir: dir, now: NOW, pidAlive, resume: (_c: string, _cwd: string, t: string) => { spawned.push(t); return 999; } };
    // 1. the phone's reply lands while the turn runs → queued
    expect(await handleReplyCommand("send-message", CONV, rec(), { mid: "mid-aaaaaaaa", text: "PINEAPPLE?" }, deps)).toBe("reply-queued");
    // 2. agy auto-denies and exits: no Stop, so the row still reads working with a dead owner
    ownerAlive = false;
    const working = rec({ blob: "B" });
    expect(classifySession(working, NOW, pidAlive)).toBe("keep"); // never op:end (that deletes the record)
    // 3. the idle reap settles it done at once
    const writes: SessionRecord[] = [];
    const v = await correctIdleClaude(CONFIG, join(dir, `${CONV}.json`), CONV, working, NOW, {
      pidAlive, readRecord: async () => working, post: async () => "delivered" as const, writeRecord: async (_p, r) => { writes.push(r); },
      antigravityRunStatus: () => undefined, readDecisionHoldFn: async () => null,
    });
    expect(v).toBe("corrected");
    expect(writes[0]).toMatchObject({ op: "done", lastEvent: "done" });
    expect(await decryptBlob(KEY, writes[0]!.blob as string)).toMatchObject({ status: "done", surface: "cli" }); // the phone can still offer Reply
    // 4. the next sweep resumes the stranded message (w)
    expect((await sweepStrandedReplies(dir, CONV, writes[0]!, deps)).resumed).toBe(true);
    expect(spawned).toEqual(["PINEAPPLE?"]);
    expect(await receiptOf(dir, CONV, "mid-aaaaaaaa")).toBe("w");
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

test("publishReplyReceipts never clobbers a record a hook rewrote while it was sealing", async () => {
  const dir = await tmp();
  const path = join(dir, `${CONV}.json`);
  const blob = await encryptBlob(KEY, { status: "working", title: "t" });
  await writeFile(path, JSON.stringify(rec({ blob, ts: NOW })));
  const posts: unknown[] = [];
  const post = async (_c: Config, e: object) => { posts.push(e); return "ok" as never; };
  // a hook writes a newer frame between the read and the write
  const newer = JSON.stringify(rec({ blob: await encryptBlob(KEY, { status: "done", title: "t" }), ts: NOW + 5 }));
  await publishReplyReceipts(CONFIG, CONV, dir, {
    post, receipts: async () => { await writeFile(path, newer); return { "mid-aaaaaaaa": "d" }; },
  });
  expect(await Bun.file(path).text()).toBe(newer);
  expect(posts).toHaveLength(0);
  // undisturbed → resealed with the receipts
  await publishReplyReceipts(CONFIG, CONV, dir, { post, receipts: async () => ({ "mid-aaaaaaaa": "d" }) });
  const after = JSON.parse(await Bun.file(path).text()) as SessionRecord;
  expect(await decryptBlob(KEY, after.blob as string)).toMatchObject({ status: "done", replies: { "mid-aaaaaaaa": "d" } });
});
