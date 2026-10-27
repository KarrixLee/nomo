// antigravity-inbox — phone → Antigravity REPLIES (NOM-96 v2): the per-conversation queue a phone
// message waits in until an Antigravity hook can hand it to the agent, plus the receipts the phone reads
// back.
//
// THE PATH: the phone seals a `send-message` command ({sessionId, mid, text}) and sends it on BOTH legs
// (LAN + the blind relay). cc-watchdog's drainCommands authenticates it with every other command's gates
// (decrypt, shape, allow-list, 120 s freshness, nonce replay, known session, batch dedup) and hands it to
// handleReplyCommand below, which either
//   - QUEUES it (a turn is running, or an `agy` TUI is open and idle) as one file per message,
//     `<conv>.<mid>.agy-inbox` (0600). The next PreInvocation hook — Antigravity's hook before EVERY model
//     call — consumes every queued file and answers {"injectSteps":[{"userMessage":…}]}, so the message
//     reaches the agent as a real user message at its next step (verified agy 1.4.8). A message that lands
//     during the turn's last step is caught by the Stop hook instead: it answers
//     {"decision":"continue","reason":…}, the agent goes on, and the very next PreInvocation injects it.
//   - RESUMES the conversation (an idle `agy` CLI conversation whose process is gone): a detached
//     `agy --conversation <id> --print=<text>` in the session's workspace. Its own hooks report the turn.
//   - REJECTS it (an idle Antigravity desktop-app conversation: nothing on this Mac can pick it up).
// RACE-SAFETY: every message is its own file, so writers never read-modify-write a shared queue. Taking
// and cancelling both start with an atomic rename of the message file — exactly one of them wins.
//
// RECEIPTS: `<conv>.<mid>.agy-reply` holds one letter — q queued · d delivered · r resumed (sent as the
// resume prompt) · c cancelled · x refused. The newest REPLY_RECEIPTS_MAX ride in the session blob as an
// append-last `replies` map, which is how the phone's bubble moves from "Sending…" to "Delivered". The
// phone keeps re-sending a message (same mid, fresh nonce) until it sees a receipt for it, and a
// receipt-holding mid is never queued twice, so a lost relay copy or a double delivery is harmless.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { atomicWrite, pidAlive, SessionRecord } from "./shared";

export const ANTIGRAVITY_INBOX_SUFFIX = ".agy-inbox";
export const ANTIGRAVITY_RECEIPT_SUFFIX = ".agy-reply";
/** Marks a Stop that already asked the agent to continue for queued messages (the loop guard). */
export const ANTIGRAVITY_NUDGE_SUFFIX = ".agy-nudge";
/** The phone caps a message at this; anything longer is refused, never truncated. */
export const REPLY_TEXT_MAX_CHARS = 4000;
/** Receipts kept per conversation (and carried in its blob). */
export const REPLY_RECEIPTS_MAX = 16;
/** A message nobody consumed in a day (the conversation was abandoned) is dropped. */
export const REPLY_INBOX_MAX_AGE_MS = 24 * 60 * 60_000;
/** Within this long of a Stop's continue, another Stop does NOT continue again (no endless loop if the
 *  PreInvocation that should consume the inbox keeps failing). */
export const REPLY_NUDGE_WINDOW_MS = 60_000;
/** What the agent is told when a Stop continues for a queued message (the message itself follows as a
 *  real user message on the next model call). */
export const ANTIGRAVITY_REPLY_NUDGE = "The user just sent a new message from their phone. It follows as the next user message.";

export type ReplyReceipt = "q" | "d" | "r" | "c" | "x";
export interface QueuedReply { mid: string; text: string; ts: number }

const MID = /^[A-Za-z0-9_-]{8,64}$/;
/** The phone's message id: base64url-ish, no dots (it is spliced into a filename after the conversation id). */
export function replyMessageId(v: unknown): string | undefined {
  return typeof v === "string" && MID.test(v) ? v : undefined;
}

/** A message the agent may receive: non-blank, ≤ REPLY_TEXT_MAX_CHARS, no control characters but `\n`. */
export function replyText(v: unknown): string | undefined {
  if (typeof v !== "string" || v.trim().length === 0 || v.length > REPLY_TEXT_MAX_CHARS) return undefined;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0009\u000B-\u001F\u007F]/.test(v) ? undefined : v;
}

const fileFor = (dir: string, conv: string, mid: string, suffix: string) => join(dir, `${conv}.${mid}${suffix}`);

/** The mids of `conv`'s files with `suffix` (names that do not parse exactly are not ours). */
async function midsOf(dir: string, conv: string, suffix: string): Promise<string[]> {
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  const out: string[] = [];
  for (const n of names) {
    if (!n.startsWith(`${conv}.`) || !n.endsWith(suffix)) continue;
    const mid = n.slice(conv.length + 1, -suffix.length);
    if (MID.test(mid)) out.push(mid);
  }
  return out;
}

export async function writeReceipt(dir: string, conv: string, mid: string, state: ReplyReceipt): Promise<void> {
  await atomicWrite(fileFor(dir, conv, mid, ANTIGRAVITY_RECEIPT_SUFFIX), state, 0o600).catch(() => {});
}

export async function receiptOf(dir: string, conv: string, mid: string): Promise<ReplyReceipt | undefined> {
  try {
    const s = (await readFile(fileFor(dir, conv, mid, ANTIGRAVITY_RECEIPT_SUFFIX), "utf8")).trim();
    return /^[qdrcx]$/.test(s) ? (s as ReplyReceipt) : undefined;
  } catch { return undefined; }
}

/** The newest REPLY_RECEIPTS_MAX receipts of a conversation as {mid: state}, oldest first; older ones are
 *  deleted. Never throws. */
export async function readReceipts(dir: string, conv: string): Promise<Record<string, ReplyReceipt>> {
  const rows: { mid: string; at: number }[] = [];
  for (const mid of await midsOf(dir, conv, ANTIGRAVITY_RECEIPT_SUFFIX)) {
    try { rows.push({ mid, at: (await stat(fileFor(dir, conv, mid, ANTIGRAVITY_RECEIPT_SUFFIX))).mtimeMs }); } catch { /* raced */ }
  }
  rows.sort((a, b) => a.at - b.at);
  for (const old of rows.splice(0, Math.max(0, rows.length - REPLY_RECEIPTS_MAX))) {
    await unlink(fileFor(dir, conv, old.mid, ANTIGRAVITY_RECEIPT_SUFFIX)).catch(() => {});
  }
  const out: Record<string, ReplyReceipt> = {};
  for (const r of rows) {
    const s = await receiptOf(dir, conv, r.mid);
    if (s) out[r.mid] = s;
  }
  return out;
}

/** Queue one message: the receipt first (so a consumer can never deliver a message the phone has not
 *  been told is queued), then the message file. */
export async function enqueueReply(dir: string, conv: string, reply: QueuedReply): Promise<void> {
  await writeReceipt(dir, conv, reply.mid, "q");
  await atomicWrite(fileFor(dir, conv, reply.mid, ANTIGRAVITY_INBOX_SUFFIX), JSON.stringify(reply), 0o600);
}

export async function hasQueuedReplies(dir: string, conv: string): Promise<boolean> {
  return (await midsOf(dir, conv, ANTIGRAVITY_INBOX_SUFFIX)).length > 0;
}

/** Take every queued message of `conv` (rename-claimed, so a racing take or cancel can never get the same
 *  one), stamp each `state`, and return them oldest first. Never throws. */
export async function takeReplies(dir: string, conv: string, state: ReplyReceipt = "d"): Promise<QueuedReply[]> {
  const out: QueuedReply[] = [];
  for (const mid of await midsOf(dir, conv, ANTIGRAVITY_INBOX_SUFFIX)) {
    const path = fileFor(dir, conv, mid, ANTIGRAVITY_INBOX_SUFFIX);
    const claimed = `${path}.${process.pid}.take`;
    try { await rename(path, claimed); } catch { continue; } // cancelled or taken by someone else
    try {
      const r = JSON.parse(await readFile(claimed, "utf8")) as Partial<QueuedReply>;
      const text = replyText(r.text);
      if (text) {
        out.push({ mid, text, ts: typeof r.ts === "number" ? r.ts : 0 });
        await writeReceipt(dir, conv, mid, state);
      }
    } catch { /* unreadable → dropped */ }
    await unlink(claimed).catch(() => {});
  }
  return out.sort((a, b) => a.ts - b.ts || a.mid.localeCompare(b.mid));
}

/** Withdraw a message that has not been delivered yet. True = cancelled (it will never reach the agent);
 *  false = already taken (its receipt says what happened). */
export async function cancelReply(dir: string, conv: string, mid: string): Promise<boolean> {
  const path = fileFor(dir, conv, mid, ANTIGRAVITY_INBOX_SUFFIX);
  const claimed = `${path}.${process.pid}.cancel`;
  try { await rename(path, claimed); } catch { return false; }
  await unlink(claimed).catch(() => {});
  await writeReceipt(dir, conv, mid, "c");
  return true;
}

/** Drop messages (and receipts / nudge marks) older than REPLY_INBOX_MAX_AGE_MS, any conversation, so an
 *  abandoned one cannot keep every PreInvocation on the hook wrapper's synchronous path. Never throws. */
export async function pruneStaleReplies(dir: string, now: number = Date.now()): Promise<void> {
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return; }
  for (const n of names) {
    if (![ANTIGRAVITY_INBOX_SUFFIX, ANTIGRAVITY_RECEIPT_SUFFIX, ANTIGRAVITY_NUDGE_SUFFIX, ANTIGRAVITY_RESUME_SUFFIX].some((x) => n.endsWith(x))) continue;
    try { if (now - (await stat(join(dir, n))).mtimeMs > REPLY_INBOX_MAX_AGE_MS) await unlink(join(dir, n)); } catch { /* raced */ }
  }
}

/** Did a Stop of this conversation ask the agent to continue within REPLY_NUDGE_WINDOW_MS? */
export async function nudgedRecently(dir: string, conv: string, now: number): Promise<boolean> {
  try { return now - Number(await readFile(join(dir, `${conv}${ANTIGRAVITY_NUDGE_SUFFIX}`), "utf8")) < REPLY_NUDGE_WINDOW_MS; } catch { return false; }
}
export const markNudged = (dir: string, conv: string, now: number) =>
  atomicWrite(join(dir, `${conv}${ANTIGRAVITY_NUDGE_SUFFIX}`), String(now), 0o600).catch(() => {});
export const clearNudge = (dir: string, conv: string) => unlink(join(dir, `${conv}${ANTIGRAVITY_NUDGE_SUFFIX}`)).catch(() => {});

/** Which Antigravity surface a conversation lives in, from its transcript / artifact path: the `agy` CLI
 *  writes under ~/.gemini/antigravity-cli/brain/, the desktop app under ~/.gemini/antigravity/brain/.
 *  Matched as a path segment (the hook may run with a different HOME than Antigravity itself). */
export function antigravitySurface(path: unknown): "cli" | "app" | undefined {
  if (typeof path !== "string") return undefined;
  if (path.includes("/.gemini/antigravity-cli/brain/")) return "cli";
  if (path.includes("/.gemini/antigravity/brain/")) return "app";
  return undefined;
}

/** What a send-message for a session in this state does. Pure.
 *    a turn is running                          → queue (next PreInvocation / Stop delivers it)
 *    a resume Nomo started is still running      → queue (its next step takes it)
 *    idle desktop-app conversation               → reject (only the Mac can continue it)
 *    idle, its process still alive (open agy TUI) → queue (never a second agy on one conversation)
 *    idle `agy` CLI conversation, process gone    → resume headless
 *    anything else (unknown surface, no cwd)      → reject */
export function replyRoute(
  record: SessionRecord, resumeAlive: boolean, alive: (pid: number) => boolean,
): "queue" | "resume" | "reject" {
  const done = record.op === "done" || record.lastEvent === "done";
  if (!done || resumeAlive) return "queue";
  const surface = antigravitySurface(record.transcript);
  if (surface === "app") return "reject";
  const pid = record.pid;
  if (typeof pid === "number" && pid > 1 && alive(pid)) return "queue";
  const cwd = record.cwd ?? record.origin?.cwd;
  return surface === "cli" && typeof cwd === "string" && cwd.startsWith("/") ? "resume" : "reject";
}

/** The `agy` to resume with: NOMO_AGY_BIN (tests), else the first `agy` on PATH, else ~/.local/bin/agy
 *  (where its installer puts it). */
export function agyBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NOMO_AGY_BIN) return env.NOMO_AGY_BIN;
  for (const d of (env.PATH ?? "").split(delimiter)) if (d && existsSync(join(d, "agy"))) return join(d, "agy");
  return join(env.HOME ?? "", ".local", "bin", "agy");
}

/** Resume a conversation headless, detached from the watchdog. `--print=` (not `-p <text>`) so a
 *  message that starts with "-" can never read as a flag. Returns the child's pid, or undefined. */
export function spawnAgyResume(conv: string, cwd: string, text: string): number | undefined {
  try {
    const child = spawn(agyBinary(), ["--conversation", conv, `--print=${text}`], {
      cwd, detached: true, stdio: "ignore", env: process.env,
    });
    child.on("error", () => {});
    child.unref();
    return child.pid;
  } catch { return undefined; }
}

/** `<conv>.agy-resume` holds the pid of the agy Nomo resumed the conversation in, so a second message
 *  queues behind it instead of starting a second agy on the same conversation — across watchdog restarts
 *  too (the record's own pid only moves at the resumed run's first hook). */
export const ANTIGRAVITY_RESUME_SUFFIX = ".agy-resume";
async function resumePid(dir: string, conv: string): Promise<number | undefined> {
  try { const n = Number(await readFile(join(dir, `${conv}${ANTIGRAVITY_RESUME_SUFFIX}`), "utf8")); return n > 1 ? n : undefined; } catch { return undefined; }
}

export type ReplyCommandResult =
  | "reply-queued" | "reply-resumed" | "reply-rejected" | "reply-duplicate"
  | "reply-cancelled" | "reply-too-late" | "malformed";

export interface ReplyCommandDeps {
  sessionsDir: string;
  now: number;
  pidAlive?: (pid: number) => boolean;
  resume?: (conv: string, cwd: string, text: string) => number | undefined;
}

/** Execute an authenticated send-message / cancel-message for an Antigravity session. Never throws. */
export async function handleReplyCommand(
  kind: "send-message" | "cancel-message", conv: string, record: SessionRecord,
  payload: { mid?: unknown; text?: unknown }, deps: ReplyCommandDeps,
): Promise<ReplyCommandResult> {
  try {
    const dir = deps.sessionsDir;
    const mid = replyMessageId(payload.mid);
    if (!mid) return "malformed";
    if (kind === "cancel-message") return (await cancelReply(dir, conv, mid)) ? "reply-cancelled" : "reply-too-late";
    const text = replyText(payload.text);
    if (!text) return "malformed";
    if (await receiptOf(dir, conv, mid)) return "reply-duplicate"; // a re-send: already handled
    const alive = deps.pidAlive ?? pidAlive;
    const resuming = await resumePid(dir, conv);
    const route = replyRoute(record, resuming !== undefined && alive(resuming), alive);
    if (route === "reject") {
      await writeReceipt(dir, conv, mid, "x");
      return "reply-rejected";
    }
    if (route === "resume") {
      // Anything still queued from before (an agy that quit before its next step) goes along, in order.
      const earlier = await takeReplies(dir, conv, "r");
      const prompt = [...earlier.map((r) => r.text), text].join("\n\n");
      const cwd = (record.cwd ?? record.origin?.cwd)!;
      const pid = (deps.resume ?? spawnAgyResume)(conv, cwd, prompt);
      if (pid !== undefined) {
        await atomicWrite(join(dir, `${conv}${ANTIGRAVITY_RESUME_SUFFIX}`), String(pid), 0o600).catch(() => {});
        await writeReceipt(dir, conv, mid, "r");
        return "reply-resumed";
      }
      // Could not start agy: keep everything queued (the next turn at the Mac takes it).
      for (const r of earlier) await enqueueReply(dir, conv, r);
    }
    await enqueueReply(dir, conv, { mid, text, ts: deps.now });
    return "reply-queued";
  } catch {
    return "malformed";
  }
}

