// park — NOM-90: a Claude Code window whose session was handed off to the cloud stays open but PARKED.
//
// A prompt typed in the stale window would fork the transcript (a sibling branch the box never sees,
// later silently dropped), so while a marker exists the UserPromptSubmit hook blocks every prompt except
// Nomo's own commands (`/nomo-cc:…`). Any other slash command or skill runs a real turn, so it is blocked
// too; built-ins (/exit, /resume) never reach the hook. Everything here is local file I/O and FAILS OPEN:
// a broken marker must never brick a session. Escape hatches: /nomo-cc:handoff cancel, /nomo-cc:reset.
// A background task's `<task-notification>` re-entry goes through UserPromptSubmit too, so it is gated.
// ponytail: a turn that starts with no UserPromptSubmit at all (if Claude Code has one) is not gated;
// --back's divergence check catches what it writes (cloud-back.ts macDiverged).
//
// Marker: <CC_DIR>/parked/<session_id>, 0600 JSON. States:
//   moving  — /nomo-cc:handoff armed; the helper moves the session once this turn ends (turnEndedAt).
//   cloud   — the move succeeded.
//   landing — /nomo-cc:back from this very window pulled the box copy and staged it next to the
//             transcript; the next Stop/StopFailure/SessionEnd installs it (installing mid-turn would let
//             the rest of the back turn append lines chained to the replaced conversation; installing on
//             a SessionStart would swap the file under a session that already loaded it). A prompt
//             while landing means the back turn was interrupted: blocked, and a rerun of back finishes.
//   back    — installed; plain prompts stay blocked with the /resume reminder (a prompt before /resume
//             would chain onto the stale in-memory conversation and land in the box transcript; the
//             background back's own re-entry is one of them) until a /resume (SessionStart "resume"),
//             the window's SessionEnd, or its pid dying clears it.
//   elsewhere — brought back from ANOTHER session while this window was still open (pid): only that
//             window is blocked (by process ancestry; the new window resumes the same id), until it ends.

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CC_DIR, pidAlive, pidAncestors } from "./shared";

export const PARK_DIR = `${CC_DIR}/parked`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Park {
  state: "moving" | "cloud" | "landing" | "back" | "elsewhere";
  since: number;
  /** The parked window's `claude` pid (moving/cloud/elsewhere). */
  pid?: number;
  /** The last Stop/StopFailure/SessionEnd (moving: the arming turn's, stamped once) and the last turn
   *  opened since parking (only /nomo-cc: commands get through): together they say "this window is idle". */
  turnEndedAt?: number;
  turnStartedAt?: number;
  /** landing: the staged box transcript and where it goes. */
  staged?: string;
  target?: string;
  /** landing/back: the id to /resume (a fork lands under a new one). */
  resume?: string;
}

const file = (dir: string, id: string): string | undefined => (UUID_RE.test(id) ? join(dir, id) : undefined);

export function readPark(id: string, dir = PARK_DIR): Park | undefined {
  const f = file(dir, id);
  if (!f) return undefined;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; }
}

export function writePark(id: string, p: Omit<Park, "since"> & { since?: number }, dir = PARK_DIR): void {
  const f = file(dir, id);
  if (!f) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ since: Date.now(), ...p }) + "\n", { mode: 0o600 });
  renameSync(tmp, f);
}

export function clearPark(id: string, dir = PARK_DIR): void {
  const f = file(dir, id);
  if (f) try { unlinkSync(f); } catch { /* gone */ }
}

export const reasonFor = (p: Park, id: string): string => {
  switch (p.state) {
    case "moving": return "Moving to the cloud after this turn…";
    case "cloud": return "This session is in the cloud — /nomo-cc:back to bring it home, or /nomo-cc:handoff cancel to unpark here";
    case "landing": return "Bringing back was interrupted — run /nomo-cc:back again";
    case "back": return `Back. Type /resume ${p.resume ?? id} to continue here.`;
    case "elsewhere": return "This session was brought back in another window — close this one (/exit)";
  }
};

/** Install a staged box transcript (landing → back). A failed install unparks: the box copy is still in
 *  the back's backup folder, and a stuck marker would block the window for good. */
function land(id: string, p: Park, dir: string): Park | undefined {
  try { if (p.staged && p.target) renameSync(p.staged, p.target); } catch { clearPark(id, dir); return undefined; }
  const back: Park = { state: "back", since: Date.now(), resume: p.resume, ...(p.pid ? { pid: p.pid } : {}) };
  writePark(id, back, dir);
  return back;
}

/** Same-window --back has staged the box copy. --back runs as a BACKGROUND Bash, so its turn usually
 *  ended long ago: if the window is idle (a turn end newer than both this run's start and the last turn
 *  opened) or gone, install now; otherwise leave it "landing" for the running turn's Stop. True =
 *  installed (state "back"). runStartedAt -1 (a phone-started back, no window turn behind it) makes
 *  idle simply "no open turn". ponytail: a /nomo-cc: command typed between the check and the rename races
 *  it (ms); a per-window lock if that ever shows up. */
export function stageLanding(id: string, l: { staged: string; target: string; resume: string }, runStartedAt: number,
  dir = PARK_DIR, alive: (pid: number) => boolean = pidAlive): boolean {
  const cur = readPark(id, dir);
  const p: Park = { ...cur, ...l, state: "landing", since: Date.now() };
  writePark(id, p, dir);
  const ended = cur?.turnEndedAt ?? 0;
  const idle = ended > runStartedAt && ended >= (cur?.turnStartedAt ?? 0);
  const gone = typeof cur?.pid === "number" && !alive(cur.pid);
  return (idle || gone) && land(id, p, dir)?.state === "back";
}

/** A "moving" marker outlives its helper only if the helper was killed; it gives up by itself at 30 min. */
export const MOVING_STALE_MS = 35 * 60_000;

export const NOMO_COMMAND = "/nomo-cc:";

/** Merge stamp fields into the CURRENT marker (re-read, so a state written meanwhile, e.g. "landing" by
 *  --back, is never downgraded by a hook holding an older copy). */
export function stamp(id: string, fields: Partial<Park>, dir = PARK_DIR): void {
  const cur = readPark(id, dir);
  if (cur) writePark(id, { ...cur, ...fields }, dir);
}

/** A turn ended with no Stop hook (Esc fires none; the watchdog's interrupt net saw it): a "moving"
 *  marker gets its turnEndedAt so the helper proceeds instead of waiting out its 30 min cap. */
export function endMovingTurn(id: string, dir = PARK_DIR): void {
  try {
    const p = readPark(id, dir);
    if (p?.state === "moving" && !p.turnEndedAt) stamp(id, { turnEndedAt: Date.now() }, dir);
  } catch { /* fail open */ }
}

/** Is this hook running under the window `pid`? (ps walk: only for the rare "elsewhere" marker.) */
const underPid = (pid: number | undefined): boolean => typeof pid === "number" && pidAncestors(process.pid).includes(pid);

/** Called first thing by the Claude hook. Returns the stdout line that blocks the prompt, or undefined.
 *  Also drives the turn-end transitions. Never throws. */
export function parkHook(input: Record<string, unknown>, dir = PARK_DIR): string | undefined {
  try {
    const id = input.session_id, event = input.hook_event_name;
    if (typeof id !== "string") return undefined;
    let p = readPark(id, dir);
    if (p?.state === "moving" && Date.now() - p.since > MOVING_STALE_MS) { clearPark(id, dir); return undefined; }
    if (!p) return undefined;
    if (p.state === "elsewhere") {
      if (!(typeof p.pid === "number" && pidAlive(p.pid))) { clearPark(id, dir); return undefined; }
      if (!underPid(p.pid)) return undefined; // the window it came back to
      if (event === "SessionEnd") { clearPark(id, dir); return undefined; }
    }
    if (p.state === "back" && typeof p.pid === "number" && !pidAlive(p.pid)) { clearPark(id, dir); return undefined; }
    if (event === "UserPromptSubmit") {
      if (typeof input.prompt === "string" && input.prompt.trimStart().startsWith(NOMO_COMMAND)) {
        if (p.state !== "moving") stamp(id, { turnStartedAt: Date.now() }, dir);
        return undefined;
      }
      return JSON.stringify({ decision: "block", reason: reasonFor(p, id) });
    }
    const turnEnd = event === "Stop" || event === "StopFailure" || event === "SessionEnd";
    if (p.state === "moving" && turnEnd && !p.turnEndedAt) stamp(id, { turnEndedAt: Date.now() }, dir);
    if (p.state === "landing" && turnEnd) p = land(id, p, dir);
    else if (p.state === "back" && event === "SessionEnd") { clearPark(id, dir); return undefined; }
    else if (p.state !== "moving" && turnEnd) stamp(id, { turnEndedAt: Date.now() }, dir);
    if (p?.state === "back" && event === "SessionStart" && input.source === "resume") clearPark(id, dir);
  } catch { /* fail open */ }
  return undefined;
}

// --- NOM-93: the phone's "Bring back" -------------------------------------------------------------

/** Is `id` in cloud.json `active` (pre-2.3.29 files: `current`)? A plain read: every cloud.json writer
 *  (handoff's updateCloudAt) renames a complete tmp file into place, so a reader never sees a torn one;
 *  the lock only serializes writers, and taking it here could stall the watchdog for its 15 s wait. */
export function cloudActive(id: string, path = `${CC_DIR}/cloud.json`): boolean {
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    return (Array.isArray(c.active) ? c.active : [c.current]).includes(id);
  } catch { return false; }
}

/** A phone-started `--back` for one session, as the watchdog tracks it (in memory). */
export interface BackRun { running: boolean; code?: number | null }

/** The blob's `cloud` key: what the phone shows for a parked session. Undefined → no key.
 *  "move-failed" (NOM-94, appended): a phone-started move-to-cloud did not happen; no marker is left. */
export type CloudState = "moving" | "cloud" | "returning" | "failed" | "back" | "move-failed";
export function cloudState(p: Park | undefined, run?: BackRun, locked = false, moveFailed = false): CloudState | undefined {
  switch (p?.state) {
    case "moving": return "moving";
    case "landing": return "returning";
    case "back": return "back";
    case "cloud": return run?.running || locked ? "returning" : run && run.code !== 0 ? "failed" : "cloud";
  }
  return !p && moveFailed ? "move-failed" : undefined;
}

/** A parked session the phone may act on keeps the command long-poll up. */
export const parkWantsCommands = (p: Park | undefined): boolean =>
  p?.state === "moving" || p?.state === "cloud" || p?.state === "landing";

/** The `parked` flag on an event body (a blind boolean, like op): set while the session has a park
 *  marker in cloud/landing/back (never moving or elsewhere), so the worker keeps the row but out of the
 *  island. Omitted otherwise. */
export function withParked<T extends object>(body: T, dir = PARK_DIR): T | (T & { parked: true }) {
  const id = (body as { sessionId?: unknown }).sessionId;
  const s = typeof id === "string" ? readPark(id, dir)?.state : undefined;
  // Never "moving": that window's last turn is still running here and must stay on the island.
  return s === "cloud" || s === "landing" || s === "back" ? { ...body, parked: true } : body;
}

/** One --back per session, whoever starts it (phone, /nomo-cc:back, CLI): an O_EXCL lockfile holding
 *  the runner's pid; a dead pid's lock is taken over. ponytail: two takers of the same STALE lock can
 *  race the unlink (both need a crashed runner first); a reader that catches the file between create
 *  and write sees no pid and treats it as stale. */
export const BACK_LOCK_DIR = `${CC_DIR}/cloud-back`;
const backLockFile = (id: string, dir: string): string => join(dir, `${id.slice(0, 12)}.lock`);
export function backLockHolder(id: string, dir = BACK_LOCK_DIR, alive: (pid: number) => boolean = pidAlive): number | undefined {
  try {
    const pid = Number(readFileSync(backLockFile(id, dir), "utf8"));
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
  } catch { return undefined; }
}
export function takeBackLock(id: string, dir = BACK_LOCK_DIR, alive: (pid: number) => boolean = pidAlive): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try { writeFileSync(backLockFile(id, dir), String(process.pid), { flag: "wx", mode: 0o600 }); return true; } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
    if (backLockHolder(id, dir, alive) !== undefined) return false;
    try { unlinkSync(backLockFile(id, dir)); } catch { /* raced */ }
  }
  return false;
}
export function releaseBackLock(id: string, dir = BACK_LOCK_DIR): void {
  try { if (readFileSync(backLockFile(id, dir), "utf8") === String(process.pid)) unlinkSync(backLockFile(id, dir)); } catch { /* gone */ }
}

/** NOM-94: the /nomo-cc:handoff helper's outcome for ONE session (cloud-back/<id12>.move: "DONE" or
 *  "FAILED"), so the watchdog never reads another session's run off the shared handoff.log. A cancel
 *  writes nothing: it is a clean unpark. */
export const moveResultFile = (id: string, dir = BACK_LOCK_DIR): string => join(dir, `${id.slice(0, 12)}.move`);
export function writeMoveResult(id: string, ok: boolean, dir = BACK_LOCK_DIR): void {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(moveResultFile(id, dir), ok ? "DONE\n" : "FAILED\n", { mode: 0o600 }); } catch { /* status only */ }
}
/** "failed" when the result file says FAILED and was written at or after `since` (epoch ms). */
export function readMoveResult(id: string, since: number, dir = BACK_LOCK_DIR): "failed" | "done" | undefined {
  try {
    const f = moveResultFile(id, dir);
    if (statSync(f).mtimeMs < since) return undefined;
    return readFileSync(f, "utf8").startsWith("FAILED") ? "failed" : "done";
  } catch { return undefined; }
}
