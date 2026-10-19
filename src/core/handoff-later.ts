// handoff-later — NOM-76: `/nomo-cc:handoff` from INSIDE the Claude Code session being moved.
//
// Copying the transcript right away would cut it mid-turn (the Bash tool_use running this has no result
// yet), and the Mac copy would keep growing (a later --back then forks) and keep running next to the
// box's. So the command only does a fast local preflight (no box contact) and starts a DETACHED helper
// that waits for this session's `claude` process to exit, then runs the normal handoff for that one
// session id. One helper at a time (handoff-pending.json); `cancel` kills it while it is still waiting.
//
// Box pairing shows a QR, which a detached helper must not do: a box not recorded as paired to the
// target worker (cloud.json `pairedTo`, written by handoff.ts on every pairing it sees succeed) is
// refused up front with the terminal command instead.

import { appendFileSync, closeSync, fstatSync, linkSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { CC_DIR } from "./shared";

export const PENDING_PATH = `${CC_DIR}/handoff-pending.json`;
export const LATER_LOG = `${CC_DIR}/handoff.log`;
/** Give up if the Mac session is still open after this long. */
export const LATER_CAP_MS = 30 * 60_000;
const POLL_MS = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Pending {
  helperPid: number;
  session: string;
  claudePid: number;
  state: "waiting" | "handing-off";
  startedAt: number;
}

/** This session and its `claude` process. The id: Claude Code's `${CLAUDE_SESSION_ID}` command
 *  substitution, else the CLAUDE_CODE_SESSION_ID it exports to the Bash tool, else the Nomo session
 *  record whose `claude` pid is one of our ancestors. The pid: CLAUDE_PID, else that record's pid, and
 *  only ever an ANCESTOR of this process (never some other session's claude). */
export function resolveSession(o: {
  substituted?: string;
  env: Record<string, string | undefined>;
  ancestors: number[];
  records: { id: string; pid: number }[];
}): { session?: string; claudePid?: number } {
  const ids = [o.substituted, o.env.CLAUDE_CODE_SESSION_ID].map((s) => s?.trim());
  const byPid = o.records.find((r) => o.ancestors.includes(r.pid));
  const session = ids.find((s): s is string => !!s && UUID_RE.test(s)) ?? byPid?.id;
  const envPid = Number(o.env.CLAUDE_PID);
  const recPid = o.records.find((r) => r.id === session)?.pid;
  const claudePid = [envPid, recPid].find((p): p is number => typeof p === "number" && o.ancestors.includes(p));
  return { session, claudePid };
}

/** The session's live context in tokens: the last real assistant turn's usage (input + cache read + cache
 *  creation = what was actually sent); a /compact boundary after it gives its postTokens (else the bytes
 *  after it / 4); with neither, transcript bytes / 4. `jsonl` may be just the file's tail (TAIL_BYTES). */
export function contextTokens(jsonl: string, fileBytes: number): number {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"') && !lines[i].includes("compact_boundary")) continue;
    try {
      const row = JSON.parse(lines[i]);
      if (row?.type === "system" && row.subtype === "compact_boundary") {
        const post = row.compactMetadata?.postTokens;
        return typeof post === "number" && post > 0 ? post : Math.round(lines.slice(i + 1).join("\n").length / 4);
      }
      if (row?.type !== "assistant" || row.isSidechain) continue;
      const u = row.message?.usage ?? {};
      const n = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (n > 0) return n; // a synthetic/error row reports zeros
    } catch { /* torn line */ }
  }
  return Math.round(fileBytes / 4);
}

/** How much of a transcript's end contextTokens reads (a 1M-token one is tens of MB). */
export const TAIL_BYTES = 4 * 1024 * 1024;

/** contextTokens over the last TAIL_BYTES of a transcript file. */
export function contextTokensOf(path: string): number {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size, len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return contextTokens(buf.toString("utf8"), size);
  } finally {
    closeSync(fd);
  }
}

/** One heads-up line for a big session (never blocks the move), or undefined. No prices: they change. */
export function sizeWarning(tokens: number): string | undefined {
  const k = `~${Math.round(tokens / 1000)}k tokens`;
  if (tokens > 900_000) return `Heads-up: this session is very large (${k}). It may exceed the cloud model's context window, and the first cloud turn resends all of it at API price. Run /compact first.`;
  if (tokens > 200_000) return `Heads-up: this session is large (${k}). The first cloud turn resends all of it at API price (no cache on the box yet). Run /compact first to make it cheaper.`;
  return undefined;
}

/** True unless cloud.json records the user's box as paired to `worker`. */
export function needsPairing(cloud: { sandboxId?: string; pairedTo?: string }, worker: string): boolean {
  return !cloud.sandboxId || cloud.pairedTo !== `${cloud.sandboxId} ${worker}`;
}

export interface PendingDeps {
  path: string;
  /** The pid is alive AND is a handoff helper (a reused pid is not). */
  isHelper: (pid: number) => boolean;
}

export function readPending(path: string): Pending | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/** The pending handoff whose helper still runs. A dead helper's file is dropped, but only if it still
 *  holds that same dead helper: a concurrent claim may have just replaced it. */
export function livePending(d: PendingDeps): Pending | undefined {
  const p = readPending(d.path);
  if (p && d.isHelper(p.helperPid)) return p;
  if (p && readPending(d.path)?.helperPid === p.helperPid) try { unlinkSync(d.path); } catch { /* raced */ }
  return undefined;
}

/** Single-flight claim: link a complete temp file into place (exclusive and never half-written), after
 *  clearing a dead helper's. False when a live helper (or a concurrent claim) already holds it. */
export function claimPending(d: PendingDeps, p: Pending): boolean {
  if (livePending(d)) return false;
  const tmp = `${d.path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(p) + "\n", { mode: 0o600 });
    linkSync(tmp, d.path);
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(tmp); } catch { /* gone */ }
  }
}

export function cancelPending(d: PendingDeps & { kill: (pid: number) => void; log?: string }): string {
  const p = livePending(d);
  if (!p) return "No handoff is waiting. Nothing to cancel.";
  if (p.state === "handing-off") return `Too late to cancel: session ${p.session} is already moving to the cloud. Bring it back with /nomo-cc:back.`;
  d.kill(p.helperPid);
  try { unlinkSync(d.path); } catch { /* gone */ }
  if (d.log) try { appendFileSync(d.log, `[${new Date().toISOString()}] CANCELLED: session ${p.session} stays on this Mac.\n`); } catch { /* status only */ }
  return `Cancelled. Session ${p.session} stays on this Mac.`;
}

/** How the helper launches the handoff: its own pinned bundle, else the version-stable hook shim (a plugin
 *  update during the wait deletes the old version folder), else nothing (the caller fails clearly). */
export function handoffArgv(o: { runtime: string; self: string; shim: string; args: string[]; exists: (p: string) => boolean }): string[] | undefined {
  if (o.exists(o.self)) return [o.runtime, o.self, ...o.args];
  if (o.exists(o.shim)) return [o.shim, "handoff", ...o.args];
  return undefined;
}
export const GONE_MSG = "the Nomo plugin was updated or removed while waiting; rerun /nomo-cc:handoff";
export const NOTHING_RAN_MSG = "the handoff exited without moving the session (the Nomo plugin or its runtime was not found); rerun /nomo-cc:handoff";

type CloudLike = { current?: string; sessions?: Record<string, unknown> };
/** Positive proof a handoff ran: cloud.json names `session` current with a snapshot that changed during
 *  the run (the shim and run.sh exit 0 having run nothing). A re-handoff of the same session always
 *  changes it: the transcript grew by at least this command's own turn. */
export function handoffLanded(before: CloudLike, after: CloudLike, session: string): boolean {
  const snap = after.sessions?.[session];
  return after.current === session && snap !== undefined && JSON.stringify(snap) !== JSON.stringify(before.sessions?.[session]);
}

export interface WaitDeps {
  pending: string;
  alive: (pid: number) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The normal handoff for this session; resolves to its exit code. A throw is logged as FAILED: <message>. */
  runHandoff: () => Promise<number>;
  /** cloud.json, read before and after the run for handoffLanded. */
  readCloud: () => CloudLike;
  log: (line: string) => void;
  notify: (text: string) => void;
  capMs?: number;
  selfPid?: number;
}

/** The detached helper: wait for the Mac session to exit (capped), then hand it off. Its last log line
 *  starts DONE: or FAILED: (what `/nomo-cc:handoff status` shows once the helper is gone). */
export async function waitThenHandoff(p: Pending, d: WaitDeps): Promise<number> {
  const self = d.selfPid ?? process.pid;
  const release = (): void => {
    if (readPending(d.pending)?.helperPid === self) try { unlinkSync(d.pending); } catch { /* gone */ }
  };
  const end = d.now() + (d.capMs ?? LATER_CAP_MS);
  d.log(`Waiting for Claude Code (pid ${p.claudePid}) to quit, then moving session ${p.session}.`);
  while (d.alive(p.claudePid)) {
    if (d.now() >= end) {
      release();
      d.log(`FAILED: Claude Code was still open after ${Math.round((d.capMs ?? LATER_CAP_MS) / 60_000)} min; nothing was moved. Run /nomo-cc:handoff again.`);
      d.notify("Handoff gave up: Claude Code was not quit in time. Nothing was moved.");
      return 1;
    }
    await d.sleep(POLL_MS);
  }
  try { writeFileSync(d.pending, JSON.stringify({ ...p, state: "handing-off" }) + "\n", { mode: 0o600 }); } catch { /* status only */ }
  d.log(`Claude Code closed. Handing off session ${p.session}…`);
  const before = d.readCloud();
  let code: number, why: string | undefined;
  try { code = await d.runHandoff(); } catch (e) { why = e instanceof Error ? e.message : String(e); code = 1; }
  if (code === 0 && !handoffLanded(before, d.readCloud(), p.session)) { why = NOTHING_RAN_MSG; code = 1; }
  release();
  if (code === 0) {
    d.log(`DONE: session ${p.session} is running in the cloud.`);
    d.notify("Your session is now running in the cloud.");
  } else {
    d.log(`FAILED: ${why ?? `the handoff exited ${code}; see the lines above`}. Your Mac copy is untouched.`);
    d.notify("Handoff failed. Your Mac copy is untouched. Check /nomo-cc:handoff status.");
  }
  return code;
}

/** `/nomo-cc:handoff status`: the waiting helper, else the log's last line. */
export function laterStatus(d: PendingDeps & { log: string }): string {
  const p = livePending(d);
  if (p) {
    return p.state === "waiting"
      ? `Waiting for Claude Code (pid ${p.claudePid}) to quit, then moving session ${p.session}. Log: ${d.log}`
      : `Moving session ${p.session} to the cloud now. Log: ${d.log}`;
  }
  let last = "";
  try { last = readFileSync(d.log, "utf8").trimEnd().split("\n").pop() ?? ""; } catch { /* no log */ }
  return last ? `No handoff waiting. Last: ${last}\nLog: ${d.log}` : "No handoff waiting.";
}
