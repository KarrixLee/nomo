// handoff-later — NOM-76: `/nomo-cc:handoff` from INSIDE the Claude Code session being moved.
//
// Copying the transcript right away would cut it mid-turn (the Bash tool_use running this has no result
// yet), and the Mac copy would keep growing (a later --back then forks) and keep running next to the
// box's. So the command only does a fast local preflight (no box contact), parks the window (core/park.ts:
// plain prompts are blocked from here on) and starts a DETACHED helper that waits for this turn to end
// (the park marker's turnEndedAt, stamped by the Stop hook) or the `claude` process to exit, then runs the
// normal handoff for that one session id. One helper at a time (handoff-pending.json); `cancel` kills it while it is still waiting.
//
// Box pairing shows a QR, which a detached helper must not do: a box not recorded as paired to the
// target worker (cloud.json `pairedTo`, written by handoff.ts on every pairing it sees succeed) is
// refused up front with the terminal command instead.

import { appendFileSync, closeSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, readSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { claudeDesktopInvocation, claudeHeadlessInvocation } from "./adapter";
import { clearPark, type MoveWhy, readPark, stamp, writePark } from "./park";
import { isSecretName } from "./readiness";
import { textHasSecret } from "./transcript-scan";
import { CC_DIR } from "./shared";
export { boxPaired, needsPairing } from "./shared";

export const PENDING_PATH = `${CC_DIR}/handoff-pending.json`;
export const LATER_LOG = `${CC_DIR}/handoff.log`;
/** Give up if this turn has not ended (nor the session quit) after this long. */
export const LATER_CAP_MS = 30 * 60_000;
const POLL_MS = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Pending {
  helperPid: number;
  session: string;
  claudePid: number;
  state: "waiting" | "handing-off";
  startedAt: number;
  /** The first message for the box session (`--then`); absent = quiet. User text: this 0600 file and
   *  the handoff's env only, never argv or the log. */
  message?: string;
  /** NOM-103: the user typed `anyway`, so a post-turn rescan that finds secrets does not stop the move. */
  anyway?: true;
}

export const DEFAULT_THEN = "You're now running on the cloud box. Continue the task you were working on before the handoff. If it was already finished, say so and wait.";
export const LATER_USAGE = "Usage: /nomo-cc:handoff (move this session; it continues on its own), /nomo-cc:handoff then <message>, /nomo-cc:handoff quiet, /nomo-cc:handoff cancel, /nomo-cc:handoff status (prefix `anyway` to move a conversation that looks like it holds secrets)";

/** NOM-103: the Cloud-check lines for a transcript that looks like it holds secrets (`summary` from
 *  transcript-scan secretSummary). Not confirmed: nothing starts, and only the user may type `anyway`. */
export function transcriptSecretWarning(summary: string, confirmed: boolean): string {
  const head = `The conversation contains what look like ${summary}. They would travel to the cloud box with the transcript.`;
  return confirmed
    ? `Cloud check: ${head} Moving anyway, as you confirmed.`
    : `Cloud check: ${head}\nNothing was started. To move it anyway, run /nomo-cc:handoff anyway (or: anyway quiet, anyway then <message>).`;
}

// ---------------------------------------------------------------------------------- NOM-106 manifest
// The /nomo-cc:handoff turn has the session's own model write `{note, env}` to manifestPath(session): a
// short "where I was / next step" and the env var NAMES the project needs. Setup commands never come from
// it (readiness.ts setupSteps derives them from lockfiles). Anything off → the whole file is ignored.

export const MANIFEST_MAX_BYTES = 4096;
export const MANIFEST_MAX_AGE_MS = 10 * 60_000;
export const NOTE_MAX = 300;
export const ENV_MAX = 20;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const ENV_NAME_MAX = 64;
// An absolute (`/a/b`, `C:\`) or home-relative (`~/`, `~user/`, `$HOME`) path, at the start or after a
// space/quote/bracket. Relative paths (`src/x.ts`) and URLs (`https://…/…`) are fine.
const PATHISH = /(?:^|[\s"'`(\[<=,])(?:~[\w.-]*(?:\/|\s|$)|\$\{?HOME\b|\/[^\s/]+\/|[A-Za-z]:[\\/])/;

// A path character, and what may follow a path: sentence punctuation, then a delimiter or the end.
const PATH_CH = String.raw`[^\s"'\`()\[\]<>,;]`;
const PATH_END = String.raw`(?=[.!?:]*(?:[\s"'\`()\[\]<>,;]|$))`;

/** The project's own absolute paths in a note, rewritten relative to `cwd` (where the box session runs:
 *  the repo is recreated there at the same absolute path). `root` is the git toplevel, else cwd. Models
 *  name the project by its absolute path all the time, and that alone used to drop the whole manifest.
 *  Only paths under root change, so anything outside the project (or home-relative) is still PATHISH. */
export function relativizeNote(note: string, root: string, cwd: string): string {
  const r = root.replace(/\/+$/, "");
  if (!r.startsWith("/") || r.length < 2) return note;
  const esc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(String.raw`(?<![^\s"'\`(\[<=,])${esc}(?:/${PATH_CH}*)?${PATH_END}`, "g");
  return note.replace(re, (p) => {
    const abs = resolve(p); // `/root/../x` escapes the project: left as is, so PATHISH rejects it
    return abs === r || abs.startsWith(`${r}/`) ? relative(cwd, abs) || "the project folder" : p;
  });
}

export interface Manifest { note?: string; env: string[] }
export type ManifestResult = { manifest: Manifest } | { invalid: string };

export const manifestPath = (session: string): string => `${CC_DIR}/handoff-manifest-${session}.json`;

/** Strict check of a manifest file's text. Never echoes any of it in a reason. `base` (the session's
 *  project root and cwd) lets the note name project paths absolutely: they are made relative first. */
export function validateManifest(text: string, base?: { root: string; cwd: string }): ManifestResult {
  if (Buffer.byteLength(text) > MANIFEST_MAX_BYTES) return { invalid: "over 4 KB" };
  if (textHasSecret(text)) return { invalid: "looks like it holds a secret" };
  let v: any;
  try { v = JSON.parse(text); } catch { return { invalid: "not JSON" }; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { invalid: "not a JSON object" };
  if (Object.keys(v).some((k) => k !== "note" && k !== "env")) return { invalid: "fields other than note and env" };
  const m: Manifest = { env: [] };
  if (v.note !== undefined) {
    if (typeof v.note !== "string") return { invalid: "note is not text" };
    const note: string = base ? relativizeNote(v.note.trim(), base.root, base.cwd) : v.note.trim();
    if (note.length > NOTE_MAX) return { invalid: `note over ${NOTE_MAX} characters` };
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(note)) return { invalid: "note has control characters or line breaks" };
    if (PATHISH.test(note)) return { invalid: "note names an absolute or home path" };
    if (note.split(/[\s"'`(),;:[\]<>]+/).some((w) => isSecretName(w.replace(/[.!?]+$/, "").split("/").pop()!))) return { invalid: "note names a secret file" };
    if (note) m.note = note;
  }
  if (v.env !== undefined) {
    if (!Array.isArray(v.env) || v.env.length > ENV_MAX) return { invalid: `env is not a list of at most ${ENV_MAX} names` };
    if (v.env.some((n: unknown) => typeof n !== "string" || n.length > ENV_NAME_MAX || !ENV_NAME.test(n))) return { invalid: "env has something that isn't an UPPER_CASE variable name" };
    m.env = [...new Set<string>(v.env)];
  }
  return { manifest: m };
}

/** Read, then delete (always: it is single-use), this session's manifest. undefined when there is none. */
export function takeManifest(path: string, now = Date.now(), base?: { root: string; cwd: string }): ManifestResult | undefined {
  let st;
  try { st = lstatSync(path); } catch { return undefined; }
  try {
    if (!st.isFile()) return { invalid: "not a regular file" };
    if (st.size > MANIFEST_MAX_BYTES) return { invalid: "over 4 KB" };
    if (now - st.mtimeMs > MANIFEST_MAX_AGE_MS) return { invalid: "stale, from an earlier handoff" };
    return validateManifest(readFileSync(path, "utf8"), base);
  } catch { return { invalid: "unreadable" }; } finally { rmSync(path, { force: true }); }
}

export interface Setup { install: string[]; compose: string[] }

/** The default first message with the manifest folded in: install steps and compose files (detected,
 *  never the model's), env NAMES, the note. No promise of approval prompts: in auto mode there are none. */
export function manifestMessage(m: Manifest, setup: Setup): string {
  if (!m.note && !m.env.length && !setup.install.length && !setup.compose.length) return DEFAULT_THEN;
  const parts = ["You're now running on the cloud box."];
  if (m.note) parts.push(`Where I was: ${m.note}`);
  if (setup.install.length) parts.push(`First run these setup steps: ${setup.install.map((c) => `\`${c}\``).join(", ")} (one at a time; if one fails, say why and go on).`);
  if (setup.compose.length) parts.push(`Services this project uses (not started; start them only if the task needs it): ${setup.compose.join(", ")}.`);
  if (m.env.length) parts.push(`The project needs these environment variables, whose values were not sent: ${m.env.join(", ")}. Never guess values; tell me which are missing when the work needs them.`);
  parts.push("Then continue the task you were working on before the handoff. If it was already finished, say so and wait.");
  return parts.join(" ");
}

/** The one line printed next to the Cloud check. */
export function manifestLine(r: ManifestResult, setup: Setup): string {
  if ("invalid" in r) return `Handoff manifest ignored (${r.invalid}); the box gets the usual first message.`;
  const m = r.manifest;
  return `Handoff manifest: setup ${setup.install.length ? setup.install.join(" · ") : "none detected"}` +
    `${setup.compose.length ? `; services listed, not started: ${setup.compose.join(", ")}` : ""}` +
    `; env names ${m.env.length ? m.env.join(", ") : "none"} (values never sent)${m.note ? `; note: "${m.note}"` : ""}.`;
}

/** `/nomo-cc:handoff`'s argument (cancel/status are routed by the command itself): empty → DEFAULT_THEN,
 *  `then <text>` → text, `quiet` → no message. Anything else (a typo, a bare `then`) → undefined: usage. */
export function parseLaterArg(raw: string): { message?: string; anyway?: true } | undefined {
  let s = raw.replace(/\r\n?/g, "\n").trim();
  // NOM-103: a leading `anyway` is the user's confirm to move a transcript that looks like it holds secrets.
  const anyway = /^anyway(?:\s|$)/i.test(s) ? { anyway: true as const } : {};
  if (anyway.anyway) s = s.slice(6).trim();
  if (!s) return { message: DEFAULT_THEN, ...anyway };
  if (/^quiet$/i.test(s)) return { ...anyway };
  const text = /^then(?:\s+([\s\S]*))?$/i.exec(s)?.[1]?.trim();
  return text ? { message: text, ...anyway } : undefined;
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


/** Sessions one box runs at once (NOM-92). Measured on a Pro box (4 vCPU, 8 GB): idle CC ≈ 250 MB.
 *  ponytail: one cap for every size; per-size caps when boxes come in more than one size. */
export const BOX_MAX_SESSIONS = 4;

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

/** `/nomo-cc:handoff cancel`: stop a waiting helper; with nothing waiting, unpark `session` (this window)
 *  if it is parked: the escape hatch for a box that is gone or a --back that keeps failing. */
export function cancelPending(d: PendingDeps & { kill: (pid: number) => void; log?: string; parkDir?: string; session?: string }): string {
  const p = livePending(d);
  if (!p) {
    if (d.parkDir && d.session && readPark(d.session, d.parkDir)) {
      clearPark(d.session, d.parkDir);
      return "Unparked; the box copy is untouched. This window is yours again (a later /nomo-cc:back keeps both copies).";
    }
    return "No handoff is waiting. Nothing to cancel.";
  }
  if (p.state === "handing-off") return `Too late to cancel: session ${p.session} is already moving to the cloud. Bring it back with /nomo-cc:back.`;
  d.kill(p.helperPid);
  try { unlinkSync(d.path); } catch { /* gone */ }
  if (d.parkDir) clearPark(p.session, d.parkDir);
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

type CloudLike = { active?: string[]; current?: string; sessions?: Record<string, unknown> };
/** Positive proof a handoff ran: cloud.json lists `session` active (pre-2.3.29: `current`) with a snapshot that changed during
 *  the run (the shim and run.sh exit 0 having run nothing). A re-handoff of the same session always
 *  changes it: the transcript grew by at least this command's own turn. */
export function handoffLanded(before: CloudLike, after: CloudLike, session: string): boolean {
  const snap = after.sessions?.[session];
  return (after.active ?? (after.current ? [after.current] : [])).includes(session) && snap !== undefined && JSON.stringify(snap) !== JSON.stringify(before.sessions?.[session]);
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
  /** The park marker folder (core/park.ts): turn-end trigger in, cloud/cleared out. Omitted = no park. */
  parkDir?: string;
  /** This session's outcome (park.ts writeMoveResult): true moved, false failed. */
  result?: (ok: boolean, why?: MoveWhy) => void;
  /** NOM-103: rescan what the handoff will upload (transcript-scan secretSummary), right before it runs:
   *  the rest of the turn may have printed a secret after the command's own scan. */
  rescan?: () => string | undefined;
}

/** The detached helper: wait for this turn to end or the Mac session to exit (capped), then hand it off. Its last log line
 *  starts DONE: or FAILED: (what `/nomo-cc:handoff status` shows once the helper is gone). */
export async function waitThenHandoff(p: Pending, d: WaitDeps): Promise<number> {
  const self = d.selfPid ?? process.pid;
  const release = (): void => {
    if (readPending(d.pending)?.helperPid === self) try { unlinkSync(d.pending); } catch { /* gone */ }
  };
  const unpark = (): void => { if (d.parkDir) try { clearPark(p.session, d.parkDir); } catch { /* fail open */ } };
  const turnEnded = (): boolean => !!d.parkDir && !!readPark(p.session, d.parkDir)?.turnEndedAt;
  const end = d.now() + (d.capMs ?? LATER_CAP_MS);
  d.log(`Waiting for this turn to end (or Claude Code, pid ${p.claudePid}, to quit), then moving session ${p.session}.`);
  let ended = false;
  while (d.alive(p.claudePid) && !(ended = turnEnded())) {
    if (d.now() >= end) {
      release();
      unpark();
      d.result?.(false, "other");
      d.log(`FAILED: the turn was still running after ${Math.round((d.capMs ?? LATER_CAP_MS) / 60_000)} min; nothing was moved. Run /nomo-cc:handoff again.`);
      d.notify("Handoff gave up: the turn did not end in time. Nothing was moved.");
      return 1;
    }
    await d.sleep(POLL_MS);
  }
  // ponytail: one poll's settle for the lines Claude Code writes right after Stop (turn_duration…); they
  // are meta, so a late one only lands on the Mac copy, where --back ignores it (transcriptAction).
  if (ended) await d.sleep(POLL_MS);
  const found = p.anyway ? undefined : d.rescan?.();
  if (found) {
    release();
    unpark();
    d.result?.(false, "transcriptSecret");
    d.log(`FAILED: the conversation contains what look like ${found}. They would travel to the cloud box with the transcript, so nothing was moved. To move it anyway, run /nomo-cc:handoff anyway.`);
    d.notify("Handoff stopped: the conversation looks like it holds secrets. Nothing was moved.");
    return 1;
  }
  try { writeFileSync(d.pending, JSON.stringify({ ...p, state: "handing-off" }) + "\n", { mode: 0o600 }); } catch { /* status only */ }
  d.log(`${ended ? "The turn ended" : "Claude Code closed"}. Handing off session ${p.session}…`);
  const before = d.readCloud();
  let code: number, why: string | undefined;
  try { code = await d.runHandoff(); } catch (e) { why = e instanceof Error ? e.message : String(e); code = 1; }
  if (code === 0 && !handoffLanded(before, d.readCloud(), p.session)) { why = NOTHING_RAN_MSG; code = 1; }
  release();
  if (code === 0) {
    if (d.parkDir) try { writePark(p.session, { state: "cloud", pid: p.claudePid }, d.parkDir); } catch { /* the gate fails open */ }
    d.result?.(true);
    d.log(`DONE: session ${p.session} is running in the cloud.`);
    d.notify("Your session is now running in the cloud.");
  } else {
    unpark();
    d.result?.(false, code === EXIT_BOX_GONE ? "gone" : code === EXIT_BOX_FULL ? "cap" : "other");
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
      ? `Waiting for this turn to end, then moving session ${p.session}. Log: ${d.log}`
      : `Moving session ${p.session} to the cloud now. Log: ${d.log}`;
  }
  let last = "";
  try { last = readFileSync(d.log, "utf8").trimEnd().split("\n").pop() ?? ""; } catch { /* no log */ }
  return last ? `No handoff waiting. Last: ${last}\nLog: ${d.log}` : "No handoff waiting.";
}

// --- NOM-94: the phone's "Move to cloud" (`--later --phone --session <uuid>`, run by the watchdog) -------

/** What phoneMoveCheck needs, injected. The watchdog is no ancestor of the session's `claude`, so the
 *  pid comes from the session record and is checked to be a live `claude` instead. */
export interface PhoneMoveFacts {
  record: { pid?: number; cwd?: string; agent?: string; provisional?: boolean } | null;
  /** A pid's argv (ps), undefined when it is not running. */
  command: (pid: number) => string | undefined;
  ancestorsOf: (pid: number) => number[];
  parked: boolean;
  active: boolean;
  needsPairing: boolean;
  transcriptExists: (cwd: string) => boolean;
  /** Git-tracked files under cwd's repo whose name looks like a secret ([] outside git); undefined
   *  when git failed (readiness.ts trackedSecretFiles). */
  trackedSecrets: (cwd: string) => string[] | undefined;
  /** NOM-103: transcript-scan secretSummary of what the move would upload, undefined when clean. */
  transcriptSecrets: (cwd: string) => string | undefined;
}

/** Every gate a phone-started move passes before anything is written. Either the session's claude pid
 *  and cwd, or why not (one line, for the log). */
export function phoneMoveCheck(f: PhoneMoveFacts): { claudePid: number; cwd: string } | { refuse: string; why: MoveWhy } {
  const r = f.record;
  if (!r) return { refuse: "no Nomo record for this session", why: "other" };
  if ((r.agent ?? "claude") !== "claude" || r.provisional === true) return { refuse: "only a Claude Code session can move to the cloud", why: "other" };
  const pid = r.pid, cmd = typeof pid === "number" && pid > 1 ? f.command(pid) : undefined;
  if (!pid || !cmd) return { refuse: "its Claude Code process is not running", why: "other" };
  const up = f.ancestorsOf(pid).map((p) => f.command(p));
  // ponytail: no CLAUDE_CODE_ENTRYPOINT here (another process's env); the argv anchors decide desktop.
  // Before the name check: the desktop binary's path has a space in it.
  if (claudeHeadlessInvocation(cmd, up) || claudeDesktopInvocation(cmd, up)) return { refuse: "a headless or desktop-app session can't move to the cloud", why: "other" };
  if (basename(cmd.trim().split(/\s+/)[0]) !== "claude") return { refuse: "its Claude Code process is not running", why: "other" };
  if (f.parked) return { refuse: "it is already moving, in the cloud, or parked", why: "other" };
  if (f.active) return { refuse: "it is already running in the cloud", why: "other" };
  if (f.needsPairing) return { refuse: "the cloud box needs a one-time pairing; run /nomo-cc:handoff in that session first", why: "notPaired" };
  // NOM-112: no cap check here. cloud.json `active` lists sessions not brought back yet (stopped, finished,
  // failed), not running ones, and only the box sees its tmux; an asleep box runs none. The box's flock'd
  // admit (handoff admitScript) counts live sessions and refuses with EXIT_BOX_FULL → why "cap".
  if (!r.cwd || !f.transcriptExists(r.cwd)) return { refuse: "its transcript was not found", why: "other" };
  const inTranscript = f.transcriptSecrets(r.cwd);
  if (inTranscript) return { refuse: `the conversation contains what look like ${inTranscript}, which would travel with the transcript; move it from the terminal (/nomo-cc:handoff anyway) if that is fine`, why: "transcriptSecret" };
  const secrets = f.trackedSecrets(r.cwd);
  if (!secrets) return { refuse: "git could not list the project's tracked files", why: "other" };
  if (secrets.length) return { refuse: `${secrets.slice(0, 3).join(", ")} looks like a secret and is tracked in git, so it would travel; move it from the terminal (/nomo-cc:handoff) if that is fine`, why: "secret" };
  return { claudePid: pid, cwd: r.cwd };
}

/** The exit code of a handoff that found the user's box gone (NOM-99), so the helper can say why. */
export const EXIT_BOX_GONE = 3;
/** The exit code of a handoff the box refused at admission: BOX_MAX_SESSIONS already running (NOM-112). */
export const EXIT_BOX_FULL = 4;

/** How long the phone path waits after writing the "moving" marker before reading the session state. */
export const PHONE_SETTLE_MS = 2000;

/** The phone path's race-safe arming, AFTER the "moving" marker is written: a Stop from here on stamps
 *  turnEndedAt itself (park.ts); one that fired before the marker existed is caught by re-reading the
 *  record after a settle, twice. Idle both times (done / opened, never prompted) → stamp turnEndedAt now so the helper
 *  moves at once; working or needs-attention → leave it for that turn's Stop. True = stamped. */
export async function settleThenStamp(session: string, d: {
  readRecord: () => Promise<{ op?: string; lastEvent?: string; awaitingPrompt?: boolean } | null>;
  sleep: (ms: number) => Promise<void>;
  parkDir?: string;
  settleMs?: number;
}): Promise<boolean> {
  for (let i = 0; i < 2; i++) { // idle at two reads (~2 s and ~4 s), not one
    await d.sleep(d.settleMs ?? PHONE_SETTLE_MS);
    const r = await d.readRecord();
    if (!r || !(r.op === "done" || r.lastEvent === "done" || r.awaitingPrompt === true)) return false;
  }
  const p = readPark(session, d.parkDir);
  if (p?.state !== "moving") return false;
  if (!p.turnEndedAt) stamp(session, { turnEndedAt: Date.now() }, d.parkDir);
  return true;
}
