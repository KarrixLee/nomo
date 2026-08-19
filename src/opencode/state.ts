/** OpenCode session-state reducer + the one POST helper the resident plugin needs.
 *
 *  WHY A REDUCER AND NOT THE HOOK PIPELINE: OpenCode has no hooks. It loads ONE resident plugin
 *  inside its own server process and feeds it a fire-and-forget event firehose (see plugin.ts). So
 *  there is no `hook_event_name` to plan an op from, no transcript to scan, and no one-shot process
 *  whose exit means "the turn is over" — the lifecycle has to be *remembered* between events. That
 *  memory is `OcState`, and it is deliberately a plain object of plain Maps so the whole state machine
 *  is testable without a server, a socket, or a paired config.
 *
 *  SWITCH ON STRINGS, NEVER ON THE PUBLISHED TYPE. `@opencode-ai/plugin` types the `event` hook with
 *  the v1 SDK `Event` union while the runtime delivers v2 names (`session.status`, `permission.asked`,
 *  …). The published union is stale; exhaustiveness checks against it are actively misleading. The SSE
 *  frames also carry no `event:` line, so the JSON `type` field is the ONLY discriminator. Everything
 *  here reads `unknown` and narrows by hand.
 */

import {
  atomicWrite, CCOp, CCStatus, Config, LAST_SEND_PATH, localApprovalsState, PLUGIN_VERSION,
} from "../core/shared";

/** One frame to send: already planned (op/prio/status), already carrying the display fields this
 *  session has accumulated. plugin.ts turns it into a blob + envelope + record; the reducer never
 *  touches the network or the disk so the state machine stays a pure unit under test. */
export interface OcFrame {
  sessionId: string;
  op: CCOp;
  prio: 0 | 1;
  status: CCStatus;
  /** Sub-status line: a `retry`'s message, else `"Planning"` while the plan agent holds the session. */
  detail?: string;
  title?: string;
  model?: string;
  /** The session's todo list rendered as markdown, for the blob's `plan` key. */
  plan?: string;
  /** Epoch MS — the session's start, matching the envelope's `startedAt` unit. */
  startedAt: number;
  /** Epoch SECONDS — the current turn's anchor, matching the blob's `turnStartedAt` unit. */
  turnStartedAt?: number;
}

export interface OcSessionState {
  startedAt: number;
  title?: string;
  model?: string;
  /** Whether the last frame we planned was a working one — the turn-anchor edge detector. */
  working: boolean;
  turnStartedAt?: number;
  /** The last `session.status`-derived frame we planned, for the identical-frame skip. */
  lastStatusFrame?: string;
  /** The last `todo.updated` list, already rendered to markdown. */
  plan?: string;
  /** The session's current agent (`"plan"` / `"build"` / a user-defined primary). */
  agent?: string;
  /** Whether `agent` came from an assistant message. Once it has, a `session.*` event may never
   *  overwrite it: `session.updated.agent` goes STALE after a `plan_exit` build switch (it keeps
   *  saying `plan` until the next user prompt, because plan_exit bypasses `setAgentModel`), while the
   *  assistant message is right every turn. Session events are a first-frame SEED, nothing more. */
  agentFromMessage?: boolean;
}

export interface OcState {
  sessions: Map<string, OcSessionState>;
  /** Session ids known to have a `parentID` — subagent (`task`) fan-out. Their lifecycle events are
   *  dropped, or one fan-out paints N island rows for what the user sees as one session. */
  children: Set<string>;
}

export function newOcState(): OcState {
  return { sessions: new Map(), children: new Set() };
}

/** OpenCode's own default title (`session.ts`: `"New session - " + new Date().toISOString()`, and
 *  `"Child session - "` for subagents). It is set at CREATE and replaced by the LLM-generated one
 *  after the first real user message, so accepting it would paint an ISO timestamp on the island for
 *  the first ~10s of every session and leave it there forever for a session that never gets a title. */
export function isDefaultOcTitle(title: string): boolean {
  return /^(New|Child) session - /.test(title);
}

/** Per-item content cap. Measured over 99 real historical lists (`opencode.db`): median 4 items, max
 *  11, longest single `content` 117 chars, and the whole compact-JSON list maxed at 972 chars — so this
 *  never fires in practice. It is here so ONE pathological item cannot eat the entire 1800-char plan
 *  budget: `appendFittedPlan` truncates the TAIL, so an unbounded first line would hide every item
 *  after it rather than the list simply ending early. */
const TODO_CONTENT_MAX_CHARS = 120;

/** Render a `todo.updated` list as the markdown checklist the phone's read-only plan reader already
 *  knows how to draw. `todo.updated` ALWAYS carries the complete list (OpenCode's `Todo.update` deletes
 *  every row for the session and re-inserts the array), so this is a whole-list render, never a merge —
 *  there is no id field to merge on, identity is array position and nothing more.
 *
 *  Status → mark: `completed` ticks, `in_progress` is bolded (the documented invariant is exactly one),
 *  `cancelled` is struck through, `pending` is a plain empty box. `priority` is deliberately NOT drawn:
 *  the array is already in the model's authored order, and a second ranking next to it is noise.
 *  Returns undefined for an empty/absent list so the blob simply omits `plan`. */
export function ocTodoMarkdown(todos: unknown): string | undefined {
  if (!Array.isArray(todos) || todos.length === 0) return undefined;
  const lines: string[] = [];
  for (const raw of todos) {
    const todo = asRecord(raw);
    const content = asString(todo?.content);
    if (!content) continue;
    const text = Array.from(content).slice(0, TODO_CONTENT_MAX_CHARS).join("");
    switch (todo?.status) {
      case "completed": lines.push(`- [x] ${text}`); break;
      case "in_progress": lines.push(`- [ ] **${text}**`); break;
      case "cancelled": lines.push(`- [ ] ~~${text}~~`); break;
      default: lines.push(`- [ ] ${text}`); break; // `pending`, and any future status we don't know
    }
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `provider/model` — OpenCode's own spelling for a model reference (`Provider.parseModel` splits on
 *  the first `/`), and the string the user picked in the TUI. Read from the newest ASSISTANT
 *  `message.updated`, never from `session.model`: `session.model` IS populated on 1.18.15 (both
 *  `session.created` from the TUI and `session.updated` carry `{id, providerID, variant}` — the 322
 *  model-less rows in `opencode.db` are pre-existing history), but the assistant message is the
 *  per-turn truth and already visited here, so there is nothing to gain by reading two sources. */
export function ocModelFromMessage(info: Record<string, unknown>): string | undefined {
  if (info.role !== "assistant") return undefined;
  const providerID = asString(info.providerID);
  const modelID = asString(info.modelID);
  if (!providerID || !modelID) return undefined;
  return `${providerID}/${modelID}`;
}

/** Normalize `session.status`'s payload. The modern shape is `{type:"idle"|"busy"|"retry", …}`; a
 *  legacy bare string is still handled (the shipping third-party herdr plugin carries the same
 *  tolerance, which is the only evidence either way about older builds). */
function statusType(status: unknown): string | undefined {
  if (typeof status === "string") return status;
  return asString(asRecord(status)?.type);
}

/** Fold one OpenCode event into the state, returning the frame to send (or null for "nothing to do":
 *  an event we don't map, a subagent's, or a `session.status` byte-identical to the last one).
 *
 *  | event                          | op / status                                             |
 *  |--------------------------------|---------------------------------------------------------|
 *  | `session.created` (root only)  | start / working                                          |
 *  | `session.status {busy}`        | update / working — skipped when identical to the last     |
 *  | `session.status {retry}`       | update / working, detail = the retry message              |
 *  | `session.status {idle}`        | (nothing — `session.idle` is the authoritative done)      |
 *  | `session.idle` (root)          | done / done                                              |
 *  | `session.deleted`              | end                                                      |
 *  | `session.updated`              | (title + agent seed only, no frame)                      |
 *  | `message.updated` (assistant)  | (model + agent only, no frame)                           |
 *  | `todo.updated`                 | update / working, `plan` = the whole list as markdown     |
 *
 *  The approval channels (`permission.asked` / `question.asked`) are DELIBERATELY absent: they are not
 *  session-lifecycle frames at all — they open a blocking hold that POSTs its own decision frame on a
 *  different route entirely. See approvals.ts.
 */
export function reduceOcEvent(state: OcState, event: unknown, now: number = Date.now()): OcFrame | null {
  const e = asRecord(event);
  const type = asString(e?.type);
  if (!e || !type) return null;
  const properties = asRecord(e.properties) ?? {};
  const info = asRecord(properties.info);

  // Learn subagent sessions from any SESSION event whose `info` carries both an id and a parentID.
  // Gated to `session.*` on purpose: an assistant `message.updated`'s `info` ALSO has `id` + `parentID`
  // (the previous MESSAGE), and feeding those into the child set would be pure noise at best.
  if (info && type.startsWith("session.")) {
    const id = asString(info.id);
    if (id && asString(info.parentID)) state.children.add(id);
  }

  const sessionId = asString(properties.sessionID) ?? (type.startsWith("session.") ? asString(info?.id) : undefined);
  if (!sessionId || state.children.has(sessionId)) return null;

  const entry = state.sessions.get(sessionId);

  switch (type) {
    case "session.created": {
      const startedAt = Number(asRecord(info?.time)?.created);
      const created: OcSessionState = {
        startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : now,
        working: false,
      };
      applyTitle(created, info);
      applyAgent(created, info, false); // the TUI stamps the agent at create; HTTP `POST /session` sends null
      state.sessions.set(sessionId, created);
      return frame(sessionId, created, "start", "working", now);
    }

    case "session.updated": {
      if (!entry) return null; // a session we never saw start — the plugin loaded mid-flight
      applyTitle(entry, info);
      applyAgent(entry, info, false);
      return null; // the next status/idle frame carries the new title
    }

    case "message.updated": {
      if (!entry || !info) return null;
      const model = ocModelFromMessage(info);
      if (model) entry.model = model;
      if (info.role === "assistant") applyAgent(entry, info, true);
      return null;
    }

    case "session.status": {
      const live = entry ?? adopt(state, sessionId, now);
      const status = statusType(properties.status);
      if (status !== "busy" && status !== "retry") return null; // `idle` is session.idle's job
      const detail = status === "retry" ? asString(asRecord(properties.status)?.message) : undefined;
      const planned = frame(sessionId, live, "update", "working", now, detail);
      // The identical-frame skip. `session.status {busy}` fires several times per turn with the exact
      // same payload; re-POSTing it costs a round trip and a re-seal for a frame the phone already
      // shows. The key spans everything that can change the RENDERED frame (title/model/todos included),
      // so a title or a todo tick landing mid-turn still gets through on the very next busy.
      const key = JSON.stringify([planned.status, planned.detail, planned.title, planned.model, planned.plan]);
      if (live.lastStatusFrame === key) return null;
      live.lastStatusFrame = key;
      return planned;
    }

    // AMBIENT STATE, NOT A PROMPT. A todo list is what the agent is working through, so it rides the
    // ordinary working frame — never `needsAttention`, never an `attentionKind`. The list lands in the
    // blob's `plan` key, which is what makes the phone's existing read-only plan reader light up with
    // no per-agent routing (`showsIslandPlanLink` / `CCPlanLinkKind.forSession` key on data, not agent).
    // A SUBAGENT's todos are dropped by the child filter above — they arrive under the child's own
    // sessionID (the event carries no parentID), so they can never clobber the root row.
    case "todo.updated": {
      if (!entry) return null; // a session we never saw start — nothing to hang the list off
      const plan = ocTodoMarkdown(properties.todos);
      if (plan === entry.plan) return null; // the same list twice — the phone already shows it
      entry.plan = plan;
      return frame(sessionId, entry, "update", "working", now);
    }

    case "session.idle": {
      if (!entry) return null;
      entry.working = false;
      entry.turnStartedAt = undefined;
      entry.lastStatusFrame = undefined; // the next busy must always get through
      return frame(sessionId, entry, "done", "done", now);
    }

    case "session.deleted": {
      if (!entry) return null;
      state.sessions.delete(sessionId);
      return frame(sessionId, entry, "end", "done", now);
    }

    default:
      return null;
  }
}

/** Terminal frames for every still-live session — the `dispose()` path (OpenCode is shutting the
 *  plugin down, so the sessions are going away with it). Drains the map: dispose runs once. */
export function ocEndFrames(state: OcState, now: number = Date.now()): OcFrame[] {
  const frames = [...state.sessions].map(([sessionId, entry]) => frame(sessionId, entry, "end", "done", now));
  state.sessions.clear();
  return frames;
}

/** The plain needs-attention frame for a session that is blocked on the user but whose prompt is NOT
 *  being held on the phone — the local `no-hold` escape hatch. It is the exact shape the Claude/Codex
 *  hooks' `delegate` produces (runHook's PermissionRequest branch: update / prio 1 / needsAttention),
 *  so a paused-approvals OpenCode row looks the same as a paused-approvals Claude one. Null for a
 *  session we never saw start. */
export function ocAttentionFrame(
  state: OcState, sessionId: string, detail: string | undefined, now: number = Date.now(),
): OcFrame | null {
  const entry = state.sessions.get(sessionId);
  if (!entry || state.children.has(sessionId)) return null;
  return frame(sessionId, entry, "update", "needsAttention", now, detail, 1);
}

/** Adopt a session first seen mid-flight (the plugin loaded into a server that already had sessions,
 *  or `session.created` predated us). Its first frame is an `update`, not a `start`. */
function adopt(state: OcState, sessionId: string, now: number): OcSessionState {
  const entry: OcSessionState = { startedAt: now, working: false };
  state.sessions.set(sessionId, entry);
  return entry;
}

/** Record the session's agent. `fromMessage` marks the never-stale assistant-message source, which
 *  latches: after it has spoken, `session.*` is ignored. An absent/null agent (every HTTP
 *  `POST /session`) changes nothing rather than clearing what we already know. */
function applyAgent(
  entry: OcSessionState, info: Record<string, unknown> | undefined, fromMessage: boolean,
): void {
  const agent = asString(info?.agent);
  if (!agent || (entry.agentFromMessage && !fromMessage)) return;
  entry.agent = agent;
  if (fromMessage) entry.agentFromMessage = true;
}

function applyTitle(entry: OcSessionState, info: Record<string, unknown> | undefined): void {
  const title = asString(info?.title);
  if (title && !isDefaultOcTitle(title)) entry.title = title;
}

function frame(
  sessionId: string, entry: OcSessionState, op: CCOp, status: CCStatus, now: number, detail?: string,
  prio: 0 | 1 = 0,
): OcFrame {
  // The turn anchor (epoch SECONDS, the blob's unit) is stamped on the EDGE into working, so the
  // island's turn clock counts this turn and not the session. A session sitting idle for an hour and
  // then prompted must show 0s, not 1h.
  if (status === "working" && op !== "start") {
    if (!entry.working || entry.turnStartedAt === undefined) entry.turnStartedAt = Math.floor(now / 1000);
    entry.working = true;
  }
  // AMBIENT, EXACTLY LIKE TODOS. With `OPENCODE_EXPERIMENTAL_PLAN_MODE` off (the default) a plan turn
  // emits an event stream identical to a build turn — no plan file, no `plan_exit`, no extra events —
  // and the ONLY thing that differs is this string. So it rides the existing free-text detail seam on
  // a working frame: no blob key, no iOS change, no `attentionKind`, no status change. Gated to
  // `working` so a finished row does not claim to still be planning, and yielding to an explicit
  // detail (a `retry` message) — that is a transient the user needs, and the agent is still there on
  // the next busy.
  const sub = detail ?? (status === "working" && entry.agent === "plan" ? "Planning" : undefined);
  return {
    sessionId,
    op,
    prio,
    status,
    ...(sub ? { detail: sub } : {}),
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.plan ? { plan: entry.plan } : {}),
    startedAt: entry.startedAt,
    ...(status === "working" && entry.turnStartedAt !== undefined ? { turnStartedAt: entry.turnStartedAt } : {}),
  };
}

/** POST one envelope to the worker. A deliberate ~30-line duplication of the hook's POST
 *  (`hook.ts`'s runHook tail): `runHook` is stdin/exit-shaped — it reads a hook payload, plans an op
 *  from a hook name and calls process.exit — and cc-watchdog's `postEvent` lives inside an ENTRY, which
 *  a resident plugin must never import (Bun collapses `import.meta.main`, so importing an entry runs
 *  it). Headers are byte-identical to the hook's, including `x-cc-approvals`: it is a per-COMPUTER
 *  toggle, so an OpenCode frame reports whatever Claude/Codex frames report and can never flip it.
 *
 *  Returns whether the worker accepted it — the caller gates `markDoneDelivered` on that, exactly like
 *  the hook does. Non-2xx is NOT triaged here (no gone-strike teardown): the pairing is shared, and the
 *  hooks + watchdog already own that lifecycle. Silence on every failure is the contract. */
export async function postOcEvent(config: Config, envelope: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret,
        "x-cc-version": PLUGIN_VERSION,
        "x-cc-approvals": await localApprovalsState(),
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    await atomicWrite(LAST_SEND_PATH, String(Date.now())).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
