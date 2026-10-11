// cursor — the Cursor (desktop app + `cursor-agent` CLI) hook → Nomo frame producer. READ-ONLY v1.
//
// WHY THIS IS NOT runHook("cursor"). Cursor's hooks are camelCase events with their own payload
// (`conversation_id`, `generation_id`, `workspace_roots`, …), not the Claude-shaped names planOp maps,
// and three of its rules have no Claude equivalent: only a PROMPT may create a row, the title is the
// FIRST prompt, and the owning pid is not the hook's parent. So this is a small producer of its own —
// the same shape as the OpenCode plugin's `send` — that reuses the shared seal/record/POST pieces
// (buildEnvelope, trackSession, postOcEvent, ensureWatchdog) and touches nothing in hook.ts.
//
// THE CONTRACT WITH CURSOR: observe only. This process never writes to stdout (so it can never return
// a permission decision, a `continue:false`, or a followup), always exits 0, and swallows every error.
// It is also registered on NO permission-class event (preToolUse / beforeShellExecution / …) — Cursor
// blocks those on malformed output, and the after-events carry everything a status row needs.
//
// PRIVACY: Cursor's payloads carry `user_email`. Nothing here reads it, and the blob/record/trace are
// built from a fresh allow-listed object rather than the payload, so a new personal field upstream
// cannot leak by default either.

import { hostname } from "node:os";
import { readdir, stat, unlink } from "node:fs/promises";
import { cursorAdapter, cursorModel } from "./adapter";
import { buildEnvelope, markDoneDeliveredAt, OpPlan, trackSessionAt } from "./hook";
import {
  atomicWrite, CC_DIR, Config, ensureWatchdog, folderIdentity, lastHookPath, loadConfig, pidAlive,
  pidAncestors, pidCommand, readRecord, SESSIONS_DIR, SessionRecord, traceSession,
} from "./shared";
import { postOcEvent } from "../opencode/state";

/** What a Cursor hook event MEANS to a status row. `start` is deliberately inert (see planCursor). */
export type CursorEventKind = "start" | "prompt" | "tool" | "stop" | "end";

const EVENT_KINDS: Record<string, CursorEventKind> = {
  sessionStart: "start",
  beforeSubmitPrompt: "prompt",
  postToolUse: "tool",
  postToolUseFailure: "tool",
  afterShellExecution: "tool",
  afterFileEdit: "tool",
  afterMCPExecution: "tool",
  afterAgentThought: "tool",
  afterAgentResponse: "tool",
  stop: "stop",
  sessionEnd: "end",
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Classify one payload. `hook_event_name` has been absent in some Cursor versions, so a missing name
 *  falls back to the payload's own shape; anything unrecognised is ignored (undefined), never guessed
 *  into a state change. */
export function cursorEventKind(input: Record<string, unknown>): CursorEventKind | undefined {
  const name = str(input.hook_event_name) ?? str(input.hookEventName);
  if (name) return EVENT_KINDS[name];
  if (typeof input.prompt === "string") return "prompt";
  if (typeof input.reason === "string") return "end";
  if (typeof input.tool_name === "string") return "tool";
  if (typeof input.status === "string") return "stop";
  return undefined;
}

/** A session id becomes a FILENAME under the sessions dir, and it arrives on stdin — so it is matched
 *  against a conservative shape instead of trusted (no slash, no leading dot, bounded). */
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** Every candidate session id on the payload, in the tolerant read order (field naming has varied
 *  across Cursor versions), de-duplicated. More than one can be present AND differ — `session_id`
 *  rides sessionStart/sessionEnd only, `conversation_id` rides everything — which is why the caller
 *  prefers whichever candidate is already tracked rather than blindly taking the first. */
export function cursorSessionIds(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["session_id", "sessionId", "conversation_id", "conversationId"]) {
    const v = input[key];
    if (typeof v === "string" && SAFE_ID.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Sanity check only: is this really Cursor calling? The payload's `cursor_version`, or the
 *  `CURSOR_VERSION` Cursor sets on every hook process. Guards against this bundle being run by some
 *  other host that imported the hooks file — it must not mint Cursor rows from a foreign event. */
export function isCursorInvocation(input: Record<string, unknown>, env: Record<string, string | undefined> = process.env): boolean {
  return str(input.cursor_version) !== undefined || str(env.CURSOR_VERSION) !== undefined;
}

/** The record pid used when no Cursor process could be found in the hook's ancestry. pid 1 is always
 *  alive, so the watchdog's dead-pid reap can never fire on a guess: the row then lives by its hooks
 *  alone and is retired by the idle nets (30-min idle → done, done → retired), exactly like a Claude
 *  session whose terminal the watchdog cannot see.
 *  ponytail: a constant, not a process — `reset` will not clear such a row early. Replace with a real
 *  owner once the desktop app's hook parent is verified live. */
export const CURSOR_UNKNOWN_OWNER_PID = 1;

const CLI_PROCESS = /(^|[/\s])cursor-agent([/\s]|$)/;
const APP_PROCESS = /\/Cursor\.app\/|(^|\/)[Cc]ursor(\s|$)/;

/** Pick the process that OWNS this session out of the hook's ancestor chain (nearest first).
 *
 *  No pid is in any Cursor payload, and the hook's direct parent may be a throwaway shell — recording
 *  it would have the watchdog end the row five seconds later. So:
 *   1. the NEAREST `cursor-agent` process (CLI; also the bundled `…/cursor-agent/versions/<v>/node
 *      index.js` layout) — it dies with the terminal session, which is exactly the liveness we want;
 *   2. else the OUTERMOST Cursor desktop process — the app itself rather than a per-window or per-hook
 *      helper that might not outlive the turn;
 *   3. else undefined → the caller records CURSOR_UNKNOWN_OWNER_PID.
 *  CLI first, so a `cursor-agent` run inside Cursor's own integrated terminal is still owned by the
 *  CLI process and not by the app around it. Pure. */
export function cursorOwnerPid(chain: { pid: number; command: string | undefined }[]): number | undefined {
  const cli = chain.find((p) => p.command !== undefined && CLI_PROCESS.test(p.command));
  if (cli) return cli.pid;
  for (let i = chain.length - 1; i >= 0; i--) {
    const command = chain[i]!.command;
    if (command !== undefined && APP_PROCESS.test(command)) return chain[i]!.pid;
  }
  return undefined;
}

function resolveOwnerPid(): number | undefined {
  const pids = [process.ppid, ...pidAncestors(process.ppid)];
  return cursorOwnerPid(pids.map((pid) => ({ pid, command: pidCommand(pid) })));
}

/** How long a `working` row is left alone before another tool event re-sends it. A turn fires several
 *  hooks per tool call (postToolUse + afterShellExecution/afterFileEdit); they all say "still working",
 *  so inside this window the hook exits without a POST — which is also what keeps it fast.
 *  ponytail: a fixed window. The phone's "last activity" is at most this stale mid-turn. */
export const CURSOR_KEEPALIVE_MS = 15_000;

export interface CursorPlan extends OpPlan {
  /** Epoch SECONDS (the blob's unit) — re-stamped by whatever opens a turn, else the cached anchor. */
  turnStartedAt?: number;
  /** The `generation_id` this frame belongs to (one per user message), parked in the record's `turnId`. */
  generation?: string;
}

/** The state mapping, pure:
 *
 *    beforeSubmitPrompt                 → start (no record yet) / update · working, new turn anchor
 *    tool events, row working           → update · working, at most once per CURSOR_KEEPALIVE_MS
 *    tool events, row done              → re-arm ONLY for a generation other than the one that stopped
 *    stop (completed | aborted | error) → done      (an aborted turn is still a finished turn)
 *    sessionEnd                         → end
 *    sessionStart, or anything else     → nothing
 *
 *  ONLY A PROMPT CREATES A ROW. sessionStart is not proof anyone asked anything (the app may open
 *  chats on its own), and a tool/stop event for an id we never saw a prompt for may be a subagent or
 *  an inline edit — each would be a phantom row with nothing left to finish it.
 *
 *  THE GENERATION GATE exists because Cursor runs the after-hooks fire-and-forget: a tool hook can
 *  land AFTER its own turn's `stop`, and re-arming on it would leave a finished row "working" with no
 *  stop left to retract it. A different generation is a genuinely new turn (e.g. a stop-hook
 *  followup, which may not fire beforeSubmitPrompt). */
export function planCursor(
  kind: CursorEventKind, input: Record<string, unknown>, record: SessionRecord | null, now: number,
): CursorPlan | null {
  const generation = str(input.generation_id) ?? str(input.generationId);
  const nowSec = Math.floor(now / 1000);
  if (!record) {
    return kind === "prompt" ? { op: "start", prio: 0, status: "working", turnStartedAt: nowSec, generation } : null;
  }
  const cachedTurn = typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt)
    ? record.turnStartedAt : undefined;
  const isDone = record.op === "done" || record.lastEvent === "done";
  switch (kind) {
    case "prompt":
      return { op: "update", prio: 0, status: "working", turnStartedAt: nowSec, generation };
    case "tool":
      if (isDone) {
        if (!generation || generation === record.turnId) return null;
        return { op: "update", prio: 0, status: "working", turnStartedAt: nowSec, generation };
      }
      if (typeof record.ts === "number" && now - record.ts < CURSOR_KEEPALIVE_MS) return null;
      return { op: "update", prio: 0, status: "working", turnStartedAt: cachedTurn, generation: generation ?? record.turnId };
    case "stop":
      // A second stop for a turn already reported done (and delivered) adds nothing.
      if (isDone && record.donePending !== true && (!generation || generation === record.turnId)) return null;
      return { op: "done", prio: 0, status: "done", turnStartedAt: cachedTurn, generation: generation ?? record.turnId };
    case "end":
      return { op: "end", prio: 0, status: "done", turnStartedAt: cachedTurn, generation: record.turnId };
    default:
      return null;
  }
}

/** Where ignored (background-agent) session ids are parked. `is_background_agent` rides sessionStart /
 *  sessionEnd only, and rows are created by the PROMPT hook — which does not carry it — so the verdict
 *  has to outlive the sessionStart process. One empty file per id; pruned after a day. */
export const CURSOR_IGNORED_DIR = `${CC_DIR}/cursor-ignored`;
const IGNORED_TTL_MS = 86_400_000;

async function markIgnored(dir: string, ids: string[], now: number): Promise<void> {
  for (const id of ids) await atomicWrite(`${dir}/${id}`, "", 0o600);
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = `${dir}/${name}`;
    const s = await stat(path).catch(() => null);
    if (s && now - s.mtimeMs > IGNORED_TTL_MS) await unlink(path).catch(() => {});
  }
}

async function isIgnored(dir: string, ids: string[]): Promise<boolean> {
  for (const id of ids) if (await stat(`${dir}/${id}`).then(() => true, () => false)) return true;
  return false;
}

/** Seams for the tests — every default is the production value. */
export interface CursorHookDeps {
  config?: Config | null;
  sessionsDir?: string;
  ignoredDir?: string;
  stampPath?: string;
  now?: () => number;
  env?: Record<string, string | undefined>;
  ownerPid?: () => number | undefined;
  post?: (config: Config, envelope: Record<string, unknown>) => Promise<boolean>;
  ensureWatchdog?: () => void;
  trace?: (event: object) => void;
}

/** One hook invocation, start to finish. Never throws, never prints. */
export async function runCursorHook(raw: string, deps: CursorHookDeps = {}): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const input = parsed as Record<string, unknown>;
    if (!isCursorInvocation(input, deps.env ?? process.env)) return;

    const now = (deps.now ?? Date.now)();
    // Liveness stamp, before every gate below (pairing included) — status-cmd reads it to tell "hooks
    // are firing" from "Cursor never loaded them".
    await atomicWrite(deps.stampPath ?? lastHookPath("cursor"), String(now)).catch(() => {});

    const kind = cursorEventKind(input);
    const ids = cursorSessionIds(input);
    if (!kind || ids.length === 0) return;

    // Cloud/background agents are out of scope. The flag is honoured wherever it appears and remembered
    // for the events of the same session that do not carry it.
    const ignoredDir = deps.ignoredDir ?? CURSOR_IGNORED_DIR;
    if (input.is_background_agent === true) {
      await markIgnored(ignoredDir, ids, now).catch(() => {});
      return;
    }
    if (kind === "start") return; // stamp only — see planCursor

    const config = deps.config !== undefined ? deps.config : await loadConfig();
    if (!config) return; // not paired → inert

    // Re-read the id on EVERY event (the CLI's `/clear` starts a new chat with no sessionStart), and
    // prefer a candidate that is already tracked so sessionEnd's `session_id` and the other events'
    // `conversation_id` land on one row even if a Cursor version makes them differ.
    const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
    let sessionId = ids[0]!;
    let record: SessionRecord | null = null;
    for (const id of ids) {
      const found = await readRecord(id, sessionsDir);
      if (found) { sessionId = id; record = found; break; }
    }
    // A record another agent kind wrote under the same id is not ours to rewrite.
    if (record && record.agent !== "cursor") return;

    const plan = planCursor(kind, input, record, now);
    if (!plan) return;
    if (!record && await isIgnored(ignoredDir, ids)) return;

    const machine = config.machineName ?? hostname().replace(/\.local$/, "");
    const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
    const cwd = str(roots[0]) ?? str(input.cwd);
    const folder = folderIdentity(cwd, record);
    // The FIRST non-empty title wins and is never replaced: it is the first prompt, by decision.
    const title = record?.title ?? await cursorAdapter.title({ sessionId, prefix: "", input });
    const model = cursorModel(input) ?? record?.model;
    const startedAt = typeof record?.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt)
      ? record.sessionStartedAt : now;
    const transcript = str(input.transcript_path) ?? record?.transcript ?? "";

    // The owner is resolved when the row is created, and retried from a prompt while still unknown.
    // Every other event reuses the record's pid: the `ps` walk is the slow part of this hook.
    let pid = record?.pid;
    if (typeof pid !== "number" || (pid === CURSOR_UNKNOWN_OWNER_PID && kind === "prompt")) {
      pid = (deps.ownerPid ?? resolveOwnerPid)() ?? CURSOR_UNKNOWN_OWNER_PID;
      if (pid !== CURSOR_UNKNOWN_OWNER_PID && !pidAlive(pid)) pid = CURSOR_UNKNOWN_OWNER_PID;
    }

    // An allow-listed input, NOT the payload: buildBlob reads only the id and the cwd from it.
    const envelope = await buildEnvelope(
      { session_id: sessionId, ...(cwd ? { cwd } : {}) }, machine, now, title, config.e2eKey, false,
      "cursor", startedAt, plan.turnStartedAt, folder, model,
      { op: plan.op, prio: plan.prio, status: plan.status },
    );
    if (!envelope) return;

    const origin = record?.origin ?? {
      hook_event_name: str(input.hook_event_name) ?? kind,
      ...(cwd ? { cwd } : {}),
      ppid: process.ppid,
    };
    await trackSessionAt(
      sessionsDir, sessionId, plan.op, plan.prio, plan.status, envelope.blob as string | undefined,
      machine, folder, transcript, "cursor", startedAt, plan.turnStartedAt, plan.generation, title,
      config.pairingId, model, false, pid, origin,
    );
    const trace = deps.trace ?? traceSession;
    if (!record) trace({ event: "create", sessionId, agent: "cursor", hook_event_name: origin.hook_event_name, origin });
    else if (plan.op === "end") trace({ event: "retire", sessionId, agent: "cursor", reason: "hook op:end" });
    (deps.ensureWatchdog ?? ensureWatchdog)();

    const delivered = await (deps.post ?? postOcEvent)(config, envelope);
    if (delivered && plan.op === "done") await markDoneDeliveredAt(sessionsDir, sessionId);
  } catch {
    // Silence is the contract — nothing may surface into a Cursor session.
  }
}
