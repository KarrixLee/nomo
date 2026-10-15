// cursor — the Cursor (desktop app + `cursor-agent` CLI) hook → Nomo frame producer. READ-ONLY v1.
//
// WHY THIS IS NOT runHook("cursor"). Cursor's hooks are camelCase events with their own payload
// (`conversation_id`, `generation_id`, `workspace_roots`, …), not the Claude-shaped names planOp maps,
// and three of its rules have no Claude equivalent: only a PROMPT may create a row, the title is
// Cursor's own chat name (the FIRST prompt until that exists), and the owning pid is not the hook's parent. So this is a small producer of its own —
// the same shape as the OpenCode plugin's `send` — that reuses the shared seal/record/POST pieces
// (buildEnvelope, trackSession, postOcEvent, ensureWatchdog) and touches nothing in hook.ts.
//
// THE CONTRACT WITH CURSOR: observe only. This process never writes to stdout (so it can never return
// a permission decision, a `continue:false`, or a followup), always exits 0, and swallows every error.
// It is registered on NO tool/shell/MCP/file permission event (preToolUse / beforeShellExecution / …)
// — Cursor blocks those on malformed output, and the after-events carry everything a status row needs.
// `beforeSubmitPrompt` IS an event whose hook output can block a prompt (`continue: false`); it is
// registered because only a prompt may create a row, and the no-stdout rule is what keeps it inert.
//
// WHAT IT COSTS. Cursor waits for the prompt hook, and this process AWAITS its POST (2 s timeout), so
// an unreachable relay adds up to ~2 s to a prompt submission — and to a `stop`. A chat's first
// prompt also pays the owner lookup (one `ps` per ancestor; retried at most every
// CURSOR_OWNER_RETRY_MS while no owner is found). Tool events inside CURSOR_KEEPALIVE_MS do neither.
// The chat-name lookup (cursorChatTitle: ~15 ms, 300 ms ceiling) is never on the prompt path.
// The POST is not detached, deliberately: nothing outlives `process.exit` in the entry, so a detached
// send would need a second process per event, and a `done` needs the POST's answer to settle its
// delivery marker (markDoneDeliveredAt). The Claude and Codex hooks await theirs the same way.
//
// PRIVACY: Cursor's payloads carry `user_email`. Nothing here reads it, and the blob/record/trace are
// built from a fresh allow-listed object rather than the payload, so a new personal field upstream
// cannot leak by default either.

import { hostname } from "node:os";
import { realpathSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { cursorAdapter, cursorChatTitle, cursorHostInvocation, cursorModel } from "./adapter";
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

/** Every candidate session id on the payload, de-duplicated, in KEYING order (both spellings of each:
 *  field naming has varied across Cursor versions). More than one can be present AND differ.
 *
 *  `conversation_id` FIRST: Cursor's hooks docs list it as a common field on EVERY event, and
 *  `session_id` only on sessionStart/sessionEnd — so a new row is keyed by the id every later event of
 *  the chat is guaranteed to carry. (Keyed by `session_id`, a prompt carrying both made a row the
 *  conversation-only tool/stop events could never find.) The caller still prefers whichever candidate
 *  is ALREADY tracked, so a sessionEnd that carries only `session_id` lands on a row keyed that way. */
export function cursorSessionIds(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["conversation_id", "conversationId", "session_id", "sessionId"]) {
    const v = input[key];
    if (typeof v === "string" && SAFE_ID.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Sanity check only: is this really Cursor calling? Guards against this bundle being run by some
 *  other host that imported the hooks file — it must not mint Cursor rows from a foreign event.
 *
 *  ONE DEFINITION, adapter.ts's `cursorHostInvocation` (a `cursor_version` payload key or a
 *  `CURSOR_VERSION` env var, PRESENT — even empty): it is the predicate the Claude entries stand DOWN
 *  on. Were this one stricter, a payload could make both entries exit and nobody report the session. */
export function isCursorInvocation(input: Record<string, unknown>, env: Record<string, string | undefined> = process.env): boolean {
  return cursorHostInvocation(input, env);
}

/** The record pid used when no Cursor process could be found in the hook's ancestry. pid 1 is always
 *  alive, so the watchdog's dead-pid reap can never fire on a guess: the row then lives by its hooks
 *  alone and is retired by the idle nets (30-min idle → done, done → retired), exactly like a Claude
 *  session whose terminal the watchdog cannot see.
 *  ponytail: a constant, not a process — `reset` will not clear such a row early. Replace with a real
 *  owner once the desktop app's hook parent is verified live. */
export const CURSOR_UNKNOWN_OWNER_PID = 1;

/** How long an "owner not found" verdict stands before a prompt may look again. The ancestor walk is
 *  a `ps` per ancestor — the slow part of this hook — and the ancestry of a chat that had no Cursor
 *  process in it does not grow one, so re-walking on every prompt bought nothing but latency. */
export const CURSOR_OWNER_RETRY_MS = 600_000;

/** The macOS app's MAIN executable, as the command's own executable (anchored at the start). The path
 *  may contain spaces ("/Users/John Doe/Applications/…"), so it cannot be cut at the first one; what it
 *  may not contain is " /" — the start of a second, absolute-path ARGUMENT, which is what
 *  `vim /Applications/Cursor.app/Contents/MacOS/Cursor` looks like. Helpers ("Cursor Helper (Plugin)")
 *  deliberately do not match: they may not outlive the turn. */
const APP_BUNDLE = /^\/(?:(?! \/).)*\/Cursor\.app\/Contents\/MacOS\/Cursor(?:\s|$)/;
/** The CLI's bundled-node layout, as argv[0]: `…/cursor-agent/versions/<ver>/<binary>`. */
const CLI_BUNDLED = /\/cursor-agent\/versions\/[^/]+\/[^/]+$/;

/** argv[0] of a `ps -o args=` line.
 *  ponytail: cut at the first whitespace, so an executable under a path with a space is not
 *  recognised (the app bundle has its own space-tolerant pattern). The cost is an unknown owner —
 *  CURSOR_UNKNOWN_OWNER_PID and the idle nets — never a wrong one. */
const argv0 = (command: string): string => command.trimStart().split(/\s/, 1)[0] ?? "";
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Is this process the `cursor-agent` CLI? Judged on the EXECUTABLE only — never on an argument, so
 *  `tail -f /var/log/cursor-agent` or `node …/cursor-agent/versions/1/index.js` run by hand is not.
 *  The CLI also installs itself as plain `agent`; that name is far too generic to trust, so it counts
 *  only when it RESOLVES (symlinks followed) into a `cursor-agent` directory. */
function isCliProcess(command: string, resolve: (path: string) => string | undefined): boolean {
  const exe = argv0(command);
  const name = basename(exe);
  if (name === "cursor-agent" || CLI_BUNDLED.test(exe)) return true;
  return name === "agent" && /\/cursor-agent\//.test(resolve(exe) ?? "");
}

/** Is this process the Cursor desktop app itself? The macOS bundle path, or (Linux) an executable
 *  whose own basename is `cursor`/`Cursor`. */
function isAppProcess(command: string): boolean {
  return APP_BUNDLE.test(command) || /^[Cc]ursor$/.test(basename(argv0(command)));
}

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
 *  CLI process and not by the app around it. A match is on the process's EXECUTABLE, never on an
 *  argument (see isCliProcess / isAppProcess). Pure — `resolve` (path → its real path) is injected and
 *  defaults to "cannot tell", which only ever withholds the `agent` alias. */
export function cursorOwnerPid(
  chain: { pid: number; command: string | undefined }[],
  resolve: (path: string) => string | undefined = () => undefined,
): number | undefined {
  const cli = chain.find((p) => p.command !== undefined && isCliProcess(p.command, resolve));
  if (cli) return cli.pid;
  for (let i = chain.length - 1; i >= 0; i--) {
    const command = chain[i]!.command;
    if (command !== undefined && isAppProcess(command)) return chain[i]!.pid;
  }
  return undefined;
}

function resolveOwnerPid(): number | undefined {
  const pids = [process.ppid, ...pidAncestors(process.ppid)];
  return cursorOwnerPid(pids.map((pid) => ({ pid, command: pidCommand(pid) })), (path) => {
    // Only an absolute argv[0] can be resolved: a bare `agent` was found through a PATH we cannot see.
    try { return path.startsWith("/") ? realpathSync(path) : undefined; } catch { return undefined; }
  });
}

/** How long a `working` row is left alone before another tool event re-sends it. A turn fires several
 *  hooks per tool call (postToolUse + afterShellExecution/afterFileEdit); they all say "still working",
 *  so inside this window the hook exits without a POST — which is also what keeps it fast.
 *  ponytail: a fixed window. The phone's "last activity" is at most this stale mid-turn. */
export const CURSOR_KEEPALIVE_MS = 15_000;

export interface CursorPlan extends OpPlan {
  /** Epoch SECONDS (the blob's unit) — re-stamped by whatever opens a turn, else the cached anchor. */
  turnStartedAt?: number;
  /** The turn's `generation_id` (one per user message) as the PROMPT stamped it, parked in the
   *  record's `turnId`. Only a prompt sets a new one; every other plan carries the record's forward. */
  generation?: string;
  /** Set by a `stop` plan only: the generation that stopped ("" when unknown) — see
   *  SessionRecord.stoppedGeneration. */
  stoppedGeneration?: string;
}

/** The state mapping, pure:
 *
 *    beforeSubmitPrompt                 → start (no record yet) / update · working, new turn anchor
 *    tool events, row working           → update · working, at most once per CURSOR_KEEPALIVE_MS
 *    tool events, row done by a stop    → nothing
 *    tool events, row done, NO stop seen→ re-arm, unless the event names a different generation
 *    stop (completed | aborted | error) → done      (an aborted turn is still a finished turn)
 *    stop for another generation        → nothing
 *    sessionEnd                         → end
 *    sessionStart, or anything else     → nothing
 *
 *  ONLY A PROMPT CREATES A ROW. sessionStart is not proof anyone asked anything (the app may open
 *  chats on its own), and a tool/stop event for an id we never saw a prompt for may be a subagent or
 *  an inline edit — each would be a phantom row with nothing left to finish it.
 *
 *  ONLY A PROMPT STARTS A TURN, for the same reason. The record's `turnId` is the generation the
 *  PROMPT stamped and nothing else ever rewrites it; `stoppedGeneration` is present once that turn's
 *  `stop` has been seen. Cursor runs the after-hooks fire-and-forget and runs subagents under
 *  generations of their own, so events arrive late and from generations no prompt of ours opened:
 *
 *   - a tool event on a row a STOP finished is dropped, whatever generation it names. It is either a
 *     straggler of the finished turn or foreign, and re-arming on it would leave the row "working"
 *     with no stop left to retract it. (Cost, accepted: a stop-hook FOLLOWUP that fires no
 *     beforeSubmitPrompt stays "done" on the phone while it runs.)
 *   - a tool event on a row that is done WITHOUT a stop — the watchdog's 30-min idle reap guessed,
 *     mid-turn — re-arms it: the turn is demonstrably still running and its own stop is still to
 *     come. Unless the event names a generation other than the prompt's, which proves nothing about
 *     this turn.
 *   - a keep-alive on a working row never changes the generation, so the turn's own stop still matches.
 *   - a stop naming a generation other than the prompt's is the PREVIOUS turn's, arriving after the
 *     user already sent the next message: ignored. A stop with no generation, or on a row whose prompt
 *     carried none, cannot be told apart from the turn's own and ends it. */
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
  const turn = str(record.turnId);
  const stopSeen = typeof record.stoppedGeneration === "string";
  // The event names a generation, the prompt stamped one, and they differ.
  const foreign = generation !== undefined && turn !== undefined && generation !== turn;
  switch (kind) {
    case "prompt":
      return { op: "update", prio: 0, status: "working", turnStartedAt: nowSec, generation };
    case "tool":
      if (isDone) {
        if (stopSeen || foreign) return null;
        return { op: "update", prio: 0, status: "working", turnStartedAt: cachedTurn, generation: turn };
      }
      if (typeof record.ts === "number" && now - record.ts < CURSOR_KEEPALIVE_MS) return null;
      return { op: "update", prio: 0, status: "working", turnStartedAt: cachedTurn, generation: turn };
    case "stop":
      if (foreign) return null;
      // A second stop for a turn already reported done (and delivered) adds nothing.
      if (isDone && stopSeen && record.donePending !== true) return null;
      return { op: "done", prio: 0, status: "done", turnStartedAt: cachedTurn, generation: turn, stoppedGeneration: generation ?? turn ?? "" };
    case "end":
      return { op: "end", prio: 0, status: "done", turnStartedAt: cachedTurn, generation: turn };
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
  chatTitle?: (sessionId: string) => string | undefined;
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
    // Cursor's own chat name once it exists, looked up only on a frame that is going out anyway — a
    // keep-alive or the stop, never the prompt (Cursor waits on that hook, and a new chat has no name
    // yet). Until then the first prompt, which a later prompt never replaces.
    const title = (kind === "tool" || kind === "stop" ? (deps.chatTitle ?? cursorChatTitle)(sessionId) : undefined)
      ?? record?.title ?? await cursorAdapter.title({ sessionId, prefix: "", input });
    const model = cursorModel(input) ?? record?.model;
    const startedAt = typeof record?.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt)
      ? record.sessionStartedAt : now;
    const transcript = str(input.transcript_path) ?? record?.transcript ?? "";

    // The owner is resolved when the row is created, and retried from a prompt while still unknown —
    // but only once the last "not found" is CURSOR_OWNER_RETRY_MS old (a record that predates the
    // stamp retries once). Every other event reuses the record's pid: the `ps` walk is the slow part
    // of this hook.
    let pid = record?.pid;
    let ownerCheckedAt = typeof record?.ownerCheckedAt === "number" ? record.ownerCheckedAt : undefined;
    const retryDue = pid === CURSOR_UNKNOWN_OWNER_PID && kind === "prompt" &&
      (ownerCheckedAt === undefined || now - ownerCheckedAt >= CURSOR_OWNER_RETRY_MS);
    if (typeof pid !== "number" || retryDue) {
      pid = (deps.ownerPid ?? resolveOwnerPid)() ?? CURSOR_UNKNOWN_OWNER_PID;
      if (pid !== CURSOR_UNKNOWN_OWNER_PID && !pidAlive(pid)) pid = CURSOR_UNKNOWN_OWNER_PID;
      ownerCheckedAt = now;
    }
    if (pid !== CURSOR_UNKNOWN_OWNER_PID) ownerCheckedAt = undefined;

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
    // trackSessionAt rebuilds the record whole and has no slot for Cursor's own keys, so they are
    // patched on right behind it (read-modify-write, like markDoneDeliveredAt). A prompt opens a new
    // turn and so DROPS the stop marker; a stop sets it; everything else carries it forward.
    const stoppedGeneration = plan.stoppedGeneration ?? (kind === "prompt" ? undefined : record?.stoppedGeneration);
    if (plan.op !== "end" && (stoppedGeneration !== undefined || ownerCheckedAt !== undefined)) {
      const written = await readRecord(sessionId, sessionsDir);
      if (written) {
        await atomicWrite(`${sessionsDir}/${sessionId}.json`, JSON.stringify({ ...written, stoppedGeneration, ownerCheckedAt }), 0o600);
      }
    }
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
