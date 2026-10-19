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

import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

/** The pending handoff whose helper still runs; a dead helper's file is dropped. */
export function livePending(d: PendingDeps): Pending | undefined {
  const p = readPending(d.path);
  if (p && d.isHelper(p.helperPid)) return p;
  if (existsSync(d.path)) try { unlinkSync(d.path); } catch { /* raced */ }
  return undefined;
}

/** Single-flight claim: create the file exclusively, after clearing a dead helper's. False when a live
 *  helper (or a concurrent claim) already holds it. */
export function claimPending(d: PendingDeps, p: Pending): boolean {
  if (livePending(d)) return false;
  try {
    writeFileSync(d.path, JSON.stringify(p) + "\n", { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
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

export interface WaitDeps {
  pending: string;
  alive: (pid: number) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The normal handoff for this session; resolves to its exit code. */
  runHandoff: () => Promise<number>;
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
  let code: number;
  try { code = await d.runHandoff(); } catch (e) { d.log(String(e)); code = 1; }
  release();
  if (code === 0) {
    d.log(`DONE: session ${p.session} is running in the cloud.`);
    d.notify("Your session is now running in the cloud.");
  } else {
    d.log(`FAILED: the handoff exited ${code}; see the lines above. Your session is still on this Mac.`);
    d.notify("Handoff failed. Your session is still on this Mac. Check /nomo-cc:handoff status.");
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
