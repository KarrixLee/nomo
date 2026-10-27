// antigravity — the Google Antigravity (desktop app/IDE + `agy` CLI) hook → Nomo frame producer.
// READ-ONLY v1, Cursor's twin (core/cursor.ts): the same shared seal/record/POST pieces, none of
// hook.ts's Claude-shaped planning.
//
// THE CONTRACT WITH ANTIGRAVITY: observe only. Antigravity's hook output CAN steer it (Stop
// `decision:"continue"`, PostInvocation `terminationBehavior`), so this process never writes to stdout
// at all — the `{}` every handler must return is printed by plugin/scripts/antigravity-hook.sh, the
// command hooks.json actually runs, before it even starts this bundle. It is registered on no
// PreToolUse (the one event that can block a tool), always exits 0 and swallows every error.
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

import { hostname } from "node:os";
import { antigravityChatTitle, antigravityModel } from "./adapter";
import { CURSOR_UNKNOWN_OWNER_PID } from "./cursor";
import { buildEnvelope, markDoneDeliveredAt, OpPlan, trackSessionAt } from "./hook";
import {
  atomicWrite, Config, ensureWatchdog, folderIdentity, lastHookPath, loadConfig, pidAlive, pidAncestors,
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

/** The events the installer registers — exactly EVENT_KINDS. Never PreToolUse. */
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

function resolveOwnerPid(): number | undefined {
  const pids = [process.ppid, ...pidAncestors(process.ppid)];
  return antigravityOwnerPid(pids.map((pid) => ({ pid, command: pidCommand(pid) })));
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
  chatTitle?: (sessionId: string) => string | undefined;
  post?: (config: Config, envelope: Record<string, unknown>) => Promise<boolean>;
  ensureWatchdog?: () => void;
  trace?: (event: object) => void;
}

/** One hook invocation, start to finish. Never throws, never prints. */
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

    const kind = antigravityEventKind(eventName, input);
    if (!kind || kind === "start") return;

    const config = deps.config !== undefined ? deps.config : await loadConfig();
    if (!config) return; // not paired → inert

    const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
    const record = await readRecord(sessionId, sessionsDir);
    if (record && record.agent !== "antigravity") return; // another agent's row is not ours to rewrite

    const plan = planAntigravity(kind, record, now);
    if (!plan) return;

    const machine = config.machineName ?? hostname().replace(/\.local$/, "");
    const cwd = antigravityCwd(input);
    const folder = folderIdentity(cwd, record);
    // Antigravity's own conversation title (≤ 300 ms, read-only), else what the row already had. No
    // event carries the user's prompt, so there is no first-prompt fallback; untitled rows show the folder.
    const title = (deps.chatTitle ?? antigravityChatTitle)(sessionId) ?? record?.title;
    const model = antigravityModel(input) ?? record?.model;
    const startedAt = typeof record?.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt)
      ? record.sessionStartedAt : now;
    const transcript = str(input.transcriptPath) ?? record?.transcript ?? "";

    // The owner is looked up once, when the row is created; every later event reuses it.
    // ponytail: no retry for an unknown owner (Cursor retries every 10 min) — add if the spike shows
    // the app's hook ancestry reaches the main executable only sometimes.
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
