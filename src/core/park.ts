// park — NOM-90: a Claude Code window whose session was handed off to the cloud stays open but PARKED.
//
// A prompt typed in the stale window would fork the transcript (a sibling branch the box never sees,
// later silently dropped), so while a marker exists the UserPromptSubmit hook blocks every plain prompt.
// Slash commands pass (/nomo-cc:back, /nomo-cc:handoff cancel); built-ins (/exit, /resume) never reach
// the hook. Everything here is local file I/O and FAILS OPEN: a broken marker must never brick a session.
//
// Marker: <CC_DIR>/parked/<session_id>, 0600 JSON. States:
//   moving  — /nomo-cc:handoff armed; the helper moves the session once this turn ends (turnEndedAt).
//   cloud   — the move succeeded.
//   landing — /nomo-cc:back from this very window pulled the box copy and staged it next to the
//             transcript; the next turn end installs it (installing mid-turn would let the rest of the
//             back turn append lines chained to the replaced conversation).
//   back    — installed; the next plain prompt is blocked ONCE with the /resume reminder (a prompt before
//             /resume would chain onto the stale in-memory conversation), and a /resume clears it.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CC_DIR } from "./shared";

export const PARK_DIR = `${CC_DIR}/parked`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Park {
  state: "moving" | "cloud" | "landing" | "back";
  since: number;
  /** moving: the Stop that ended the arming turn. */
  turnEndedAt?: number;
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
    case "moving": return "Moving to the cloud after this turn… (/nomo-cc:handoff cancel to stop)";
    case "cloud": return "This session is in the cloud — /nomo-cc:back to bring it home";
    case "landing": return `Coming back from the cloud… type /resume ${p.resume ?? id} once it says Back.`;
    case "back": return `Back. Type /resume ${p.resume ?? id} to continue here.`;
  }
};

/** Install a staged box transcript (landing → back). A failed install unparks: the box copy is still in
 *  the back's backup folder, and a stuck marker would block the window for good. */
function land(id: string, p: Park, dir: string): Park | undefined {
  try { if (p.staged && p.target) renameSync(p.staged, p.target); } catch { clearPark(id, dir); return undefined; }
  const back: Park = { state: "back", since: Date.now(), resume: p.resume };
  writePark(id, back, dir);
  return back;
}

/** A "moving" marker outlives its helper only if the helper was killed; it gives up by itself at 30 min. */
export const MOVING_STALE_MS = 35 * 60_000;

/** Called first thing by the Claude hook. Returns the stdout line that blocks the prompt, or undefined.
 *  Also drives the turn-end transitions. Never throws. */
export function parkHook(input: Record<string, unknown>, dir = PARK_DIR): string | undefined {
  try {
    const id = input.session_id, event = input.hook_event_name;
    if (typeof id !== "string") return undefined;
    let p = readPark(id, dir);
    if (p?.state === "moving" && Date.now() - p.since > MOVING_STALE_MS) { clearPark(id, dir); return undefined; }
    if (!p) return undefined;
    if (event === "UserPromptSubmit") {
      if (typeof input.prompt === "string" && input.prompt.trimStart().startsWith("/")) return undefined;
      if (p.state === "back") clearPark(id, dir); // one reminder, then the window is the user's again
      return JSON.stringify({ decision: "block", reason: reasonFor(p, id) });
    }
    const turnEnd = event === "Stop" || event === "StopFailure" || event === "SessionEnd";
    if (p.state === "moving" && turnEnd && !p.turnEndedAt) writePark(id, { ...p, turnEndedAt: Date.now() }, dir);
    if (p.state === "landing" && (turnEnd || event === "SessionStart")) p = land(id, p, dir);
    if (p?.state === "back" && event === "SessionStart" && input.source === "resume") clearPark(id, dir);
  } catch { /* fail open */ }
  return undefined;
}
