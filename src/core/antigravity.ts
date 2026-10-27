// antigravity — the Google Antigravity (desktop app/IDE + `agy` CLI) hook → Nomo frame producer.
// READ-ONLY v1, Cursor's twin (core/cursor.ts): the same shared seal/record/POST pieces, none of
// hook.ts's Claude-shaped planning.
//
// THE CONTRACT WITH ANTIGRAVITY: observe only — with ONE exception, the phone's Stop. Antigravity's hook
// output CAN steer it (Stop `decision:"continue"`, PostInvocation `terminationBehavior`), so this process
// writes to stdout exactly once ever: ANTIGRAVITY_TERMINATE, on a PostInvocation that consumed a phone
// interrupt flag. Every other `{}` is printed by plugin/scripts/antigravity-hook.sh (first, for every
// event but PostInvocation; for PostInvocation it captures our output and prints `{}` unless it is
// exactly the terminate line). It always exits 0 and swallows every error. (PreToolUse — phone
// approvals — is a separate hook: core/antigravity-approval.ts.)
//
// PHONE STOP (verified agy 1.4.8): the watchdog stamps `<sessions>/<conversationId>.agy-interrupt` (the
// shared hook-flag seam, adapter.interrupt). PostInvocation — after EVERY model call — returning
// {"terminationBehavior":"terminate"} ends the turn there; we consume the flag and report the row done
// at once (Antigravity's own Stop follows and is a no-op on a done row). Signals are never used: SIGINT
// makes `agy` EXIT. A held phone approval / a routed tool call is denied by antigravity-approval.
//
// THE EVENTS (docs: antigravity.google/docs/hooks). None of them names itself on stdin — there is no
// `hookEventName` field — so the installer passes the event as argv[2].
//   - PreInvocation / PostInvocation fire around EACH MODEL CALL, many per turn — NOT per turn.
//     So PreInvocation starts a turn only on a row that is not already working; PostInvocation is a
//     keep-alive, never "done" (that would flicker the phone done/working between model calls).
//   - Stop fires when the execution loop terminates — the end of a turn → done.
//   - A user interrupt can skip PostInvocation and, possibly, Stop: the turn then ends with NO event.
//     The watchdog's idle reap (30 min, vetoed while the transcript is still being written — see
//     isClaudeIdleReapEligible) is what settles such a row.
//
// PRIVACY: the blob/record are built from an allow-listed object, never the payload. `toolCall.args`
// (file contents, commands) is never read.

import { readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { basename } from "node:path";
import { antigravityChatTitle, antigravityFirstPrompt, antigravityModel } from "./adapter";
import { CURSOR_UNKNOWN_OWNER_PID } from "./cursor";
import { buildEnvelope, markDoneDeliveredAt, OpPlan, trackSessionAt } from "./hook";
import {
  atomicWrite, clearInterruptFlagAt, Config, ensureWatchdog, interruptFlagSetAt, folderIdentity, lastHookPath, loadConfig, pidAlive, pidAncestors,
  pidCommand, readRecord, SESSIONS_DIR, SessionRecord, traceSession,
} from "./shared";
import { postOcEvent } from "../opencode/state";

/** What an Antigravity event MEANS to a status row. */
export type AntigravityEventKind = "start" | "turn" | "beat" | "stop";

const EVENT_KINDS: Record<string, AntigravityEventKind> = {
  SessionStart: "start",
  PreInvocation: "turn",
  PostInvocation: "beat",
  PostToolUse: "beat",
  Stop: "stop",
};

/** The status events the installer registers — exactly EVENT_KINDS (PreToolUse is antigravity-approval's). */
export const ANTIGRAVITY_EVENTS = Object.keys(EVENT_KINDS);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** The event, from argv (authoritative) or — for a hand-run or an older install — the payload's shape.
 *  A shape that could be either side of a model call (invocationNum) reads as a keep-alive: it can
 *  never create a row or end a turn by guesswork. */
export function antigravityEventKind(argName: string | undefined, input: Record<string, unknown>): AntigravityEventKind | undefined {
  if (argName) return EVENT_KINDS[argName];
  if ("terminationReason" in input || "executionNum" in input || "fullyIdle" in input) return "stop";
  if ("toolCall" in input || "invocationNum" in input) return "beat";
  return undefined;
}

/** conversationId becomes a FILENAME under the sessions dir — matched against a conservative shape. */
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
export function antigravitySessionId(input: Record<string, unknown>): string | undefined {
  const v = input.conversationId;
  return typeof v === "string" && SAFE_ID.test(v) ? v : undefined;
}

/** First workspace as a filesystem path (a `file://` URI is decoded; anything else non-absolute is
 *  dropped rather than guessed at). */
export function antigravityCwd(input: Record<string, unknown>): string | undefined {
  const first = Array.isArray(input.workspacePaths) ? str(input.workspacePaths[0]) : undefined;
  if (!first) return undefined;
  if (first.startsWith("file://")) {
    try { return decodeURIComponent(new URL(first).pathname); } catch { return undefined; }
  }
  return first.startsWith("/") ? first : undefined;
}

/** The process that OWNS the conversation, out of the hook's ancestor chain (nearest first): the
 *  nearest `agy` CLI, else the OUTERMOST Antigravity app main executable, else undefined (the caller
 *  records CURSOR_UNKNOWN_OWNER_PID — pid 1, never reaped as dead; the idle nets finish the row).
 *  Matched on the executable, never an argument. Pure. */
export function antigravityOwnerPid(chain: { pid: number; command: string | undefined }[]): number | undefined {
  const exe = (c: string) => c.trimStart().split(/\s/, 1)[0] ?? "";
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const cli = chain.find((p) => p.command !== undefined && base(exe(p.command)) === "agy");
  if (cli) return cli.pid;
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i]!.command;
    if (c !== undefined && (/^\/(?:(?! \/).)*\/Antigravity\.app\/Contents\/MacOS\/Antigravity(?:\s|$)/.test(c) ||
      base(exe(c)) === "antigravity")) return chain[i]!.pid;
  }
  return undefined;
}

/** The process that RAN the hook — antigravity-hook.sh exports its own $PPID as NOMO_HOOK_PPID before
 *  run.sh adds layers. Verified 2026-10: under `agy` it IS the agy process; under the desktop app it is
 *  a helper that dies when the app quits. Either way its death means the conversation's host is gone,
 *  which is exactly what the watchdog's dead-owner `end` keys on. Undefined when absent, malformed,
 *  pid ≤ 1, or not alive. */
export function antigravityHookParent(env: Record<string, string | undefined>, alive: (pid: number) => boolean = pidAlive): number | undefined {
  const raw = env.NOMO_HOOK_PPID;
  if (!raw || !/^[0-9]{1,10}$/.test(raw)) return undefined;
  const pid = Number(raw);
  return pid > 1 && alive(pid) ? pid : undefined;
}

/** Owner: the hook's own parent (above); else — a hand run, or an install whose wrapper predates the
 *  env var — the ancestor walk, which agrees with it for the CLI (the nearest agy). */
function resolveOwnerPid(): number | undefined {
  const parent = antigravityHookParent(process.env);
  if (parent !== undefined) return parent;
  const pids = [process.ppid, ...pidAncestors(process.ppid)];
  return antigravityOwnerPid(pids.map((pid) => ({ pid, command: pidCommand(pid) })));
}

/** The PostInvocation reply that ends the turn after the current model call. */
export const ANTIGRAVITY_TERMINATE = '{"terminationBehavior":"terminate"}';
/** What a tool denied because of the phone's Stop tells the agent. */
export const ANTIGRAVITY_STOP_REASON = "Stopped from phone";
/** A Stop not acted on within this long is dropped, so a flag a crashed session left can never end a
 *  much later turn (the flag is also cleared by Stop and by the next turn's first PreInvocation). An hour,
 *  like Claude Code's: the next PostInvocation only comes after the running tool finishes, and a Stop
 *  pressed during a long build must not be dropped silently. */
export const ANTIGRAVITY_INTERRUPT_MAX_AGE_MS = 60 * 60_000;
/** Antigravity's own flag name, so the wrapper's glob never matches Claude Code's `.interrupt` flags
 *  (which would make every PostInvocation wait). Mirrored by antigravityAdapter.interruptFlagSuffix. */
export const ANTIGRAVITY_INTERRUPT_SUFFIX = ".agy-interrupt";

/** Has the phone asked to stop this conversation's turn (a fresh flag)? Never throws. */
export function antigravityStopRequested(sessionsDir: string, sessionId: string, now: number): Promise<boolean> {
  return interruptFlagSetAt(sessionsDir, sessionId, now, ANTIGRAVITY_INTERRUPT_MAX_AGE_MS, ANTIGRAVITY_INTERRUPT_SUFFIX);
}

const clearStop = (sessionsDir: string, sessionId: string) =>
  clearInterruptFlagAt(sessionsDir, sessionId, ANTIGRAVITY_INTERRUPT_SUFFIX);

/** Delete Antigravity stop flags past their age (any conversation): a stale one would keep every
 *  PostInvocation on the wrapper's slow path for good. Run on that slow path only. Never throws. */
export async function pruneStaleAntigravityStops(sessionsDir: string, now: number): Promise<void> {
  let names: string[] = [];
  try { names = await readdir(sessionsDir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith(ANTIGRAVITY_INTERRUPT_SUFFIX)) continue;
    const id = name.slice(0, -ANTIGRAVITY_INTERRUPT_SUFFIX.length);
    if (!(await antigravityStopRequested(sessionsDir, id, now))) await clearStop(sessionsDir, id);
  }
}

/** Keep-alive throttle: inside this window a still-working row is not re-sent (PreInvocation,
 *  PostInvocation and PostToolUse all fire many times per turn). */
export const ANTIGRAVITY_KEEPALIVE_MS = 15_000;

export interface AntigravityPlan extends OpPlan {
  /** Epoch SECONDS — re-stamped when a turn opens, else the record's cached anchor. */
  turnStartedAt?: number;
}

/** The state mapping, pure:
 *
 *    PreInvocation, no row               → start · working (only this event creates a row)
 *    PreInvocation, row done             → update · working, new turn anchor
 *    PreInvocation / PostInvocation /
 *      PostToolUse, row working          → update · working, at most once per ANTIGRAVITY_KEEPALIVE_MS
 *    PostInvocation / PostToolUse, done  → nothing (a straggler; the next PreInvocation re-arms)
 *    Stop                                → done (fullyIdle or not — the turn is over either way)
 *    SessionStart, anything else         → nothing (stamp only: opening a chat is not a turn) */
export function planAntigravity(
  kind: AntigravityEventKind, record: SessionRecord | null, now: number,
): AntigravityPlan | null {
  const nowSec = Math.floor(now / 1000);
  if (!record) return kind === "turn" ? { op: "start", prio: 0, status: "working", turnStartedAt: nowSec } : null;
  const cachedTurn = typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt)
    ? record.turnStartedAt : undefined;
  const isDone = record.op === "done" || record.lastEvent === "done";
  switch (kind) {
    case "turn":
    case "beat":
      if (isDone) return kind === "turn" ? { op: "update", prio: 0, status: "working", turnStartedAt: nowSec } : null;
      if (typeof record.ts === "number" && now - record.ts < ANTIGRAVITY_KEEPALIVE_MS) return null;
      return { op: "update", prio: 0, status: "working", turnStartedAt: cachedTurn };
    case "stop":
      // A second Stop for a turn already reported done (and delivered) adds nothing.
      if (isDone && record.donePending !== true) return null;
      return { op: "done", prio: 0, status: "done", turnStartedAt: cachedTurn };
    default:
      return null;
  }
}

/** Seams for the tests — every default is the production value. */
export interface AntigravityHookDeps {
  config?: Config | null;
  sessionsDir?: string;
  stampPath?: string;
  now?: () => number;
  ownerPid?: () => number | undefined;
  chatTitle?: (sessionId: string, transcriptPath?: string) => string | undefined;
  firstPrompt?: (transcriptPath: string | undefined) => Promise<string | undefined>;
  post?: (config: Config, envelope: Record<string, unknown>) => Promise<boolean>;
  ensureWatchdog?: () => void;
  trace?: (event: object) => void;
  /** Writes the terminate line (awaited, flushed). Default: stdout. */
  emit?: (line: string) => Promise<void>;
  /** Is anyone reading our stdout? False for the wrapper's DETACHED runs (stdout is /dev/null): those
   *  must never consume a stop flag that a later, foreground PostInvocation has to act on. Default true. */
  canTerminate?: boolean;
}

function emitStdout(line: string): Promise<void> {
  return new Promise<void>((resolve) => {
    process.stdout.on("error", () => resolve()); // reader gone (EPIPE) — nothing to do about it
    try { process.stdout.write(`${line}\n`, () => resolve()); } catch { resolve(); }
  });
}

/** One hook invocation, start to finish. Never throws; prints only ANTIGRAVITY_TERMINATE (see header). */
export async function runAntigravityHook(raw: string, eventName: string | undefined, deps: AntigravityHookDeps = {}): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const input = parsed as Record<string, unknown>;
    const sessionId = antigravitySessionId(input);
    if (!sessionId) return;

    const now = (deps.now ?? Date.now)();
    // Liveness stamp before every gate below (pairing included) — status-cmd reads it.
    await atomicWrite(deps.stampPath ?? lastHookPath("antigravity"), String(now)).catch(() => {});

    let kind = antigravityEventKind(eventName, input);
    if (!kind || kind === "start") return;

    const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
    if (eventName === "PostInvocation" && deps.canTerminate !== false) await pruneStaleAntigravityStops(sessionsDir, now);
    // PHONE STOP, before pairing and the network: consume the flag, end the turn, report it done.
    if (eventName === "PostInvocation" && deps.canTerminate !== false
      && await antigravityStopRequested(sessionsDir, sessionId, now)) {
      await clearStop(sessionsDir, sessionId);
      await (deps.emit ?? emitStdout)(ANTIGRAVITY_TERMINATE);
      (deps.trace ?? traceSession)({ event: "interrupt", sessionId, agent: "antigravity", result: "terminated" });
      kind = "stop";
    } else if (kind === "stop") {
      await clearStop(sessionsDir, sessionId); // the turn ended on its own: the stop is moot
    }

    const config = deps.config !== undefined ? deps.config : await loadConfig();
    if (!config) return; // not paired → inert

    const record = await readRecord(sessionId, sessionsDir);
    if (record && record.agent !== "antigravity") return; // another agent's row is not ours to rewrite
    // A new turn (first model call over a finished row) must never be stopped by the last one's flag.
    if (kind === "turn" && record && (record.op === "done" || record.lastEvent === "done")) {
      await clearStop(sessionsDir, sessionId);
    }

    const plan = planAntigravity(kind, record, now);
    if (!plan) return;

    const machine = config.machineName ?? hostname().replace(/\.local$/, "");
    const cwd = antigravityCwd(input);
    const folder = folderIdentity(cwd, record);
    const transcript = str(input.transcriptPath) ?? record?.transcript ?? "";
    // Antigravity's own conversation title (≤ 300 ms, read-only; it exists only once the first turn
    // completes), else what the row already had, else the first prompt off the transcript's first line,
    // else the workspace folder's name. A row still titled with the folder keeps looking for the prompt.
    const folderName = cwd ? basename(cwd) || undefined : undefined;
    const kept = record?.title && record.title !== folderName ? record.title : undefined;
    const title = (deps.chatTitle ?? antigravityChatTitle)(sessionId, transcript || undefined) ?? kept
      ?? await (deps.firstPrompt ?? antigravityFirstPrompt)(transcript || undefined) ?? record?.title ?? folderName;
    const model = antigravityModel(input) ?? record?.model;
    const startedAt = typeof record?.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt)
      ? record.sessionStartedAt : now;

    // The owner is looked up once, when the row is created; every later event reuses it.
    // ponytail: no retry for an unknown owner (Cursor retries every 10 min) — the hook parent is
    // always known through the wrapper, so pid 1 only follows a hand run.
    let pid = record?.pid;
    if (typeof pid !== "number") {
      pid = (deps.ownerPid ?? resolveOwnerPid)() ?? CURSOR_UNKNOWN_OWNER_PID;
      if (pid !== CURSOR_UNKNOWN_OWNER_PID && !pidAlive(pid)) pid = CURSOR_UNKNOWN_OWNER_PID;
    }

    const envelope = await buildEnvelope(
      { session_id: sessionId, ...(cwd ? { cwd } : {}) }, machine, now, title, config.e2eKey, false,
      "antigravity", startedAt, plan.turnStartedAt, folder, model,
      { op: plan.op, prio: plan.prio, status: plan.status },
    );
    if (!envelope) return;

    const origin = record?.origin ?? { hook_event_name: eventName ?? kind, ...(cwd ? { cwd } : {}), ppid: process.ppid };
    await trackSessionAt(
      sessionsDir, sessionId, plan.op, plan.prio, plan.status, envelope.blob as string | undefined,
      machine, folder, transcript, "antigravity", startedAt, plan.turnStartedAt, undefined, title,
      config.pairingId, model, false, pid, origin,
    );
    if (!record) (deps.trace ?? traceSession)({ event: "create", sessionId, agent: "antigravity", hook_event_name: origin.hook_event_name, origin });
    (deps.ensureWatchdog ?? ensureWatchdog)();

    const delivered = await (deps.post ?? postOcEvent)(config, envelope);
    if (delivered && plan.op === "done") await markDoneDeliveredAt(sessionsDir, sessionId);
  } catch {
    // Silence is the contract — nothing may surface into an Antigravity session.
  }
}
