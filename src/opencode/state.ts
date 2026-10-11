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
  /** Sub-status line, always a CLOSED `CCDetailKey` (never free text): `"retrying"` while the provider
   *  is retrying, else `"planning"` while the plan agent holds the session. */
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
  /** Whether the phone may know this row. False only between a `session.created` and the first frame
   *  planned for it — a created-but-never-prompted session (a fork, ACP `session/new`, a bare
   *  `POST /session`) stays here forever, and nothing may be posted about a row that was never opened. */
  announced: boolean;
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

/** One permission/question OpenCode is blocked on a human for. */
export interface OcPrompt {
  /** The session that ASKED — a subagent's own id when a subagent asked. */
  sessionID: string;
  /** The tool call it is blocking, when the asked event named one (`tool:{messageID, callID}`). */
  messageID?: string;
  callID?: string;
  /** A hold has this prompt on the phone as an Allow/Deny card right now (see ocPromptHeld). */
  held?: boolean;
}

export interface OcState {
  sessions: Map<string, OcSessionState>;
  /** Subagent (`task`) session id → its `parentID`. Their lifecycle events are dropped, or one
   *  fan-out paints N island rows for what the user sees as one session — but a subagent blocked on
   *  the user IS the root row's business, and this is how its prompt finds that row. */
  children: Map<string, string>;
  /** OpenCode request id (`per_…` / `que_…`) → the prompt still waiting on the user. READ, never
   *  inferred from the last frame sent: "is this row blocked?" is answered from here every time. */
  prompts: Map<string, OcPrompt>;
}

export function newOcState(): OcState {
  return { sessions: new Map(), children: new Map(), prompts: new Map() };
}

/** The row a session's events belong to: itself, or the top of its subagent chain. */
export function ocRootSession(state: OcState, sessionId: string): string {
  let id = sessionId;
  // Bounded by the map's size, so a parent cycle (never observed) cannot spin the editor's thread.
  for (let hops = state.children.size; hops > 0; hops -= 1) {
    const parent = state.children.get(id);
    if (parent === undefined) break;
    id = parent;
  }
  return id;
}

function hasPrompt(state: OcState, rootId: string): boolean {
  for (const prompt of state.prompts.values()) if (ocRootSession(state, prompt.sessionID) === rootId) return true;
  return false;
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

/** The BARE model id (`claude-sonnet-4-5`, `gpt-5-codex`) for the blob's `model` key. Read from the
 *  newest ASSISTANT `message.updated`, never from `session.model`: `session.model` IS populated on
 *  1.18.15 (both `session.created` from the TUI and `session.updated` carry `{id, providerID,
 *  variant}` — the 322 model-less rows in `opencode.db` are pre-existing history), but the assistant
 *  message is the per-turn truth and already visited here, so there is nothing to gain by reading two
 *  sources.
 *
 *  THE PROVIDER PREFIX IS DROPPED ON PURPOSE. OpenCode spells a model reference `provider/model`
 *  (`Provider.parseModel` splits on the first `/`), but the phone's badge is a lookup table of BARE
 *  ids — the same strings Claude's transcript and Codex's hook payload already carry — and an
 *  unrecognised key falls through to a prettified raw string, so `anthropic/claude-sonnet-4-5`
 *  rendered as the mangled "Anthropic/claude Sonnet 4.5". `providerID` is still required as a
 *  well-formedness gate (a message with only half the pair is not a model reference). */
export function ocModelFromMessage(info: Record<string, unknown>): string | undefined {
  if (info.role !== "assistant") return undefined;
  const providerID = asString(info.providerID);
  const modelID = asString(info.modelID);
  if (!providerID || !modelID) return undefined;
  return modelID;
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
 *  | `session.created` (root only)  | (seeds startedAt + title + agent only, no frame)          |
 *  | `session.status {busy}`        | update / working — skipped when identical to the last     |
 *  |                                | (start / working when it is a created session's FIRST)    |
 *  | `session.status {retry}`       | the same, detail = the `"retrying"` key                   |
 *  | `session.status {idle}`        | done / done — once per turn, whichever of the two idle    |
 *  | `session.idle` (root)          | signals lands first (see finishTurn)                      |
 *  | `session.deleted`              | end                                                      |
 *  | `session.updated`              | (title + agent seed only, no frame)                      |
 *  | `message.updated` (assistant)  | (model + agent only, no frame)                           |
 *  | `todo.updated`                 | update / working, `plan` = the whole list as markdown     |
 *
 *  A session that has not been ANNOUNCED yet (created, never busy) sends nothing from any row above
 *  but the busy one: no done, no end, no todo frame.
 *
 *  The approval channels (`permission.asked` / `question.asked`) are DELIBERATELY absent: they are not
 *  session-lifecycle frames at all — they open a blocking hold that POSTs its own decision frame on a
 *  different route entirely. See approvals.ts. What this reducer DOES do for them is stay out of the
 *  way: while a prompt is registered (ocPromptAsked) no working frame is planned for its row.
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
    const parentID = asString(info.parentID);
    if (id && parentID && parentID !== id) state.children.set(id, parentID);
  }

  const sessionId = asString(properties.sessionID) ?? (type.startsWith("session.") ? asString(info?.id) : undefined);
  if (!sessionId || state.children.has(sessionId)) return null;

  const entry = state.sessions.get(sessionId);

  switch (type) {
    case "session.created": {
      const startedAt = Number(asRecord(info?.time)?.created);
      const created: OcSessionState = {
        startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : now,
        announced: false,
        working: false,
      };
      applyTitle(created, info);
      applyAgent(created, info, false); // the TUI stamps the agent at create; HTTP `POST /session` sends null
      state.sessions.set(sessionId, created);
      // NO FRAME: CREATED IS NOT WORKING. The TUI and the desktop app create the session lazily at
      // prompt submit, so there a busy follows within ~250 ms — but `Session.fork`, ACP `session/new`
      // and a bare `POST /session` create one with no prompt behind it, and then NO status event ever
      // follows and `session.idle` is never emitted. A working frame sent from here had nothing to
      // retract it (no idle reap, no transcript for the interrupt net, and the heartbeat kept the row
      // fresh), so it sat "working" until the OpenCode process exited. OpenCode has an authoritative
      // busy signal; the row opens on that.
      return null;
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
      const status = statusType(properties.status);
      // THE SAME TURN END AS `session.idle`, which is a deprecated twin of this that a build may stop
      // sending. Checked BEFORE the adopt below: an idle status for a session we never saw must not
      // conjure an `announced` entry for the done to then "finish".
      if (status === "idle") return finishTurn(sessionId, entry, now);
      if (status !== "busy" && status !== "retry") return null;
      const live = entry ?? adopt(state, sessionId, now);
      // A PROMPT IS UP — the row is needsAttention, or a hold's Allow/Deny card. Busy keeps repeating
      // underneath it, and one that differs from the last (a title landed) would paint working straight
      // over a card that is the only way to answer. Whoever resolves the prompt repaints (ocPromptFrame).
      // A never-announced session cannot have a prompt and its `start` is never held back.
      if (live.announced && hasPrompt(state, sessionId)) return null;
      // A FIXED KEY, NEVER THE PROVIDER'S MESSAGE. `detail` is a closed enum on the phone
      // (`CCDetailKey.label`, see `frame` below): an unknown key renders nothing in the widget and
      // raw unlocalized English in the app row, and a provider's retry sentence would additionally
      // eat the 3072-char seal budget the plan/dbg tail is fitted into. "retrying" maps to the
      // localized "Reconnecting…" — a transient the user should read as recovery, not failure.
      const detail = status === "retry" ? "retrying" : undefined;
      // A created session's FIRST frame is the `start` that `session.created` used to send — the worker
      // pushes a start to the island at once, where a first-seen prio-0 update can sit out its 5 s
      // coalescing window. An adopted session is already `announced`, so it stays an `update`.
      const planned = frame(sessionId, live, live.announced ? "update" : "start", "working", now, detail);
      live.announced = true;
      // The identical-frame skip. `session.status {busy}` fires several times per turn with the exact
      // same payload; re-POSTing it costs a round trip and a re-seal for a frame the phone already
      // shows. The key spans everything that can change the RENDERED frame (title/model/todos included),
      // so a title or a todo tick landing mid-turn still gets through on the very next busy.
      //
      // CACHED ON PLAN, RETRACTED ON A FAILED SEND. The key says "the phone already shows this", which
      // is only true once the POST is CONFIRMED — and postOcEvent swallows every failure. So the
      // sender calls ocForgetStatusFrame on a frame it could not deliver; otherwise one dropped POST
      // silenced every byte-identical busy for the rest of the turn (~5 min of frozen island).
      const key = statusKey(planned);
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
      if (!entry.announced) return null; // kept for the first busy, which is what opens the row
      if (hasPrompt(state, sessionId)) return null; // kept for the frame that clears the prompt — see busy
      return frame(sessionId, entry, "update", "working", now);
    }

    case "session.idle":
      return finishTurn(sessionId, entry, now);

    case "session.deleted": {
      if (!entry) return null;
      state.sessions.delete(sessionId);
      return entry.announced ? frame(sessionId, entry, "end", "done", now) : null;
    }

    default:
      return null;
  }
}

/** The turn is over: `session.idle`, or `session.status {idle}` — OpenCode publishes both for one
 *  turn end, so whichever lands second must be a no-op or the phone gets two done notifications. */
function finishTurn(sessionId: string, entry: OcSessionState | undefined, now: number): OcFrame | null {
  // Never announced = never prompted (an abort on a fresh fork): there is no row to finish, and a
  // done here would CREATE one.
  if (!entry?.announced) return null;
  // ALREADY DONE, and nothing has re-opened the row since (a todo frame sets `working` again). The
  // key is retracted on a failed send like any other, which is right: an undelivered done is still
  // owed, and a second idle is the cheapest retry there is.
  if (entry.lastStatusFrame === DONE_KEY && !entry.working) return null;
  entry.working = false;
  entry.lastStatusFrame = DONE_KEY; // never equal to a busy key, so the next busy always gets through
  // Build the done frame BEFORE clearing the anchor: the phone's "done in X" is the turn's END
  // minus `turnStartedAt`, i.e. the frozen version of the count-up that was running. Clearing
  // first shipped a done frame with no anchor, and the phone then falls back to `startedAt` —
  // the SESSION's start — which it only trusts inside a 30-minute plausibility window (that
  // window exists to stop a resumed session flashing its whole age, "40h"). So the timer simply
  // vanished on any session older than half an hour.
  const done = frame(sessionId, entry, "done", "done", now);
  entry.turnStartedAt = undefined;
  return done;
}

const DONE_KEY = "done";

/** Everything that can change a RENDERED working frame — the identical-frame skip's key. */
function statusKey(planned: OcFrame): string {
  return JSON.stringify([planned.status, planned.detail, planned.title, planned.model, planned.plan]);
}

/** Terminal frames for every still-live session — the `dispose()` path (OpenCode is shutting the
 *  plugin down, so the sessions are going away with it). Drains the map: dispose runs once. A session
 *  that was never announced has no row to end and is simply dropped with the rest. */
export function ocEndFrames(state: OcState, now: number = Date.now()): OcFrame[] {
  const frames = [...state.sessions].filter(([, entry]) => entry.announced)
    .map(([sessionId, entry]) => frame(sessionId, entry, "end", "done", now));
  state.sessions.clear();
  return frames;
}

/** Retract the identical-frame skip key for one session, so the very next `session.status {busy}`
 *  is sent even though it is byte-identical to the frame we last PLANNED.
 *
 *  The sender calls this for any frame it could not deliver. The cache means "the phone already shows
 *  this"; a POST that timed out, 4xx'd or threw makes that false, and postOcEvent reports failure by
 *  returning false rather than throwing — so without this retraction one lost POST muted the whole
 *  remainder of a turn (busy repeats identically until a todo/title/model changes), leaving the island
 *  frozen for the ~5 minutes until `session.idle`. No-op for a session we no longer track. */
export function ocForgetStatusFrame(state: OcState, sessionId: string): void {
  const entry = state.sessions.get(sessionId);
  if (entry) entry.lastStatusFrame = undefined;
}

/** The plain needs-attention frame for a session that is blocked on the user but whose prompt is NOT
 *  being held on the phone — the local `no-hold` escape hatch. It is the exact shape the Claude/Codex
 *  hooks' `delegate` produces (runHook's PermissionRequest branch: update / prio 1 / needsAttention),
 *  so a paused-approvals OpenCode row looks the same as a paused-approvals Claude one. Null for a
 *  session we never saw start. It ANNOUNCES the row (the worker takes a first-seen update as
 *  discovery), so the idle that follows is allowed to close it.
 *
 *  A SUBAGENT's prompt lands on its ROOT's row: the child has no row of its own, and OpenCode is
 *  blocked on a human all the same. */
export function ocAttentionFrame(
  state: OcState, sessionId: string, detail: string | undefined, now: number = Date.now(),
): OcFrame | null {
  const rootId = ocRootSession(state, sessionId);
  const entry = state.sessions.get(rootId);
  if (!entry) return null;
  entry.announced = true;
  // The phone no longer shows the last working frame, so the skip key that says it does is void.
  entry.lastStatusFrame = undefined;
  return frame(rootId, entry, "update", "needsAttention", now, detail, 1);
}

/** Record a `permission.asked` / `question.asked` as pending. Reads the raw event because the tool
 *  call it blocks (`tool:{messageID, callID}`) is not part of what a hold needs. */
export function ocPromptAsked(state: OcState, event: unknown): void {
  const properties = asRecord(asRecord(event)?.properties);
  const id = asString(properties?.id);
  const sessionID = asString(properties?.sessionID);
  // A re-delivered ask must not reset a prompt we already track — its `held` flag guards a live card.
  if (!id || !sessionID || state.prompts.has(id)) return;
  const tool = asRecord(properties?.tool);
  const messageID = asString(tool?.messageID);
  const callID = asString(tool?.callID);
  state.prompts.set(id, { sessionID, ...(messageID ? { messageID } : {}), ...(callID ? { callID } : {}) });
}

/** Mark a pending prompt as held on the phone (a hold started) or not (it ended, or was never
 *  granted). While ANY of a row's pending prompts is held, ocPromptFrame paints nothing: the hold's
 *  decisionPending card is the only way to answer from the phone, and both a needsAttention frame (a
 *  subagent asking meanwhile) and a working one (a sibling answered) would replace it. */
export function ocPromptHeld(state: OcState, id: string, held: boolean): void {
  const prompt = state.prompts.get(id);
  if (prompt) prompt.held = held;
}

/** Forget one prompt. Returns the ROOT session whose row may need repainting (ocPromptFrame), or
 *  undefined when we were not tracking it — so two signals for one answer repaint once. */
export function ocPromptResolved(state: OcState, id: string): string | undefined {
  const prompt = state.prompts.get(id);
  if (!prompt) return undefined;
  state.prompts.delete(id);
  return ocRootSession(state, prompt.sessionID);
}

/** The pending prompts an event proves are over WITHOUT a `*.replied` — a lookup, it removes nothing.
 *
 *   - `byTool`: the tool call a prompt was blocking reached `completed`/`error`. A tool cannot finish
 *     while its permission is open, so that request is answered (or was aborted) — per call, so a
 *     parallel sibling's prompt is untouched.
 *   - otherwise: the asking session (or an ancestor of it) went idle or was deleted. Nothing in a
 *     finished turn is still waiting, and OpenCode can retain a request across an abort without ever
 *     publishing a reply for it — without this bound one lost reply would mute the row for good. */
export function ocPromptsEndedBy(state: OcState, event: unknown): { id: string; byTool: boolean }[] {
  const e = asRecord(event);
  const type = asString(e?.type);
  const properties = asRecord(e?.properties);
  if (!type || !properties || state.prompts.size === 0) return [];
  const ended: { id: string; byTool: boolean }[] = [];
  if (type === "message.part.updated") {
    const part = asRecord(properties.part);
    const partStatus = asRecord(part?.state)?.status;
    const callID = asString(part?.callID);
    if (part?.type !== "tool" || !callID || (partStatus !== "completed" && partStatus !== "error")) return [];
    const sessionID = asString(part.sessionID) ?? asString(properties.sessionID);
    const messageID = asString(part.messageID);
    for (const [id, prompt] of state.prompts) {
      if (prompt.sessionID !== sessionID || prompt.callID !== callID) continue;
      if (prompt.messageID && messageID && prompt.messageID !== messageID) continue;
      ended.push({ id, byTool: true });
    }
    return ended;
  }
  const over = type === "session.idle" || type === "session.deleted"
    || (type === "session.status" && statusType(properties.status) === "idle");
  const sessionID = asString(properties.sessionID) ?? asString(asRecord(properties.info)?.id);
  if (!over || !sessionID) return [];
  for (const [id, prompt] of state.prompts) {
    // Walk the asker's own chain rather than comparing roots: a mid-level subagent ending takes its
    // own subagents' prompts with it, and nobody else's.
    for (let at: string | undefined = prompt.sessionID, hops = state.children.size + 1; at !== undefined && hops > 0; hops -= 1) {
      if (at === sessionID) { ended.push({ id, byTool: false }); break; }
      at = state.children.get(at);
    }
  }
  return ended;
}

/** What a session's row should show RIGHT NOW as far as prompts go, read from state rather than
 *  remembered from the last event: needsAttention while any prompt (its own or a subagent's) is
 *  pending, working once none is and the turn is still running, null otherwise (turn over — the done
 *  frame owns the row — a session we never saw, or a row a live hold owns). The caller sends it whenever a prompt appears or
 *  goes away; it is NOT skip-keyed, because every call follows a frame that was not `working`. */
export function ocPromptFrame(state: OcState, sessionId: string, now: number = Date.now()): OcFrame | null {
  const rootId = ocRootSession(state, sessionId);
  for (const prompt of state.prompts.values()) {
    if (prompt.held && ocRootSession(state, prompt.sessionID) === rootId) return null;
  }
  if (hasPrompt(state, rootId)) return ocAttentionFrame(state, rootId, undefined, now);
  const entry = state.sessions.get(rootId);
  if (!entry?.announced || !entry.working) return null;
  const planned = frame(rootId, entry, "update", "working", now);
  entry.lastStatusFrame = statusKey(planned); // the busy OpenCode repeats next is this very frame
  return planned;
}

/** Adopt a session first seen mid-flight (the plugin loaded into a server that already had sessions,
 *  or `session.created` predated us). Its first frame is an `update`, not a `start` — so it is born
 *  `announced`: it predates us, and the phone may well hold its row from an earlier plugin instance. */
function adopt(state: OcState, sessionId: string, now: number): OcSessionState {
  const entry: OcSessionState = { startedAt: now, announced: true, working: false };
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
  // then prompted must show 0s, not 1h. A `start` is stamped too: it is only ever a real busy now.
  if (status === "working") {
    if (!entry.working || entry.turnStartedAt === undefined) entry.turnStartedAt = Math.floor(now / 1000);
    entry.working = true;
  }
  // AMBIENT, EXACTLY LIKE TODOS. With `OPENCODE_EXPERIMENTAL_PLAN_MODE` off (the default) a plan turn
  // emits an event stream identical to a build turn — no plan file, no `plan_exit`, no extra events —
  // and the ONLY thing that differs is this string. So it rides the existing detail seam on a working
  // frame: no blob key, no iOS change, no `attentionKind`, no status change. Gated to `working` so a
  // finished row does not claim to still be planning, and yielding to an explicit detail (the
  // `"retrying"` key) — that is a transient the user needs, and the agent is still there on the next
  // busy.
  //
  // LOWERCASE, and it is a PINNED CROSS-REPO CONTRACT: the phone maps this through
  // `CCDetailKey.label` (Shared/ClaudeCodeActivity.swift), whose keys are all lowercase —
  // editing/running/reading/searching/web/delegating/planning/thinking. An unrecognised key hits
  // `default: nil` and the raw string renders VERBATIM, so a capital "Planning" shipped English to
  // every locale even though 計画中 / 계획 중 / 规划中 / 規劃中 / Planificando are already in the
  // catalog. It fails silently and looks like a missing translation rather than a bad key.
  const sub = detail ?? (status === "working" && entry.agent === "plan" ? "planning" : undefined);
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
    // NOT gated on `working`. The phone renders a finished row's "done in X" as the turn's end minus
    // this anchor — the frozen form of the count-up that was running — so a done frame needs it just
    // as much as a working one. Omitting it there made the phone fall back to `startedAt`, the
    // SESSION's start, which it only trusts inside a 30-minute plausibility window (that window stops
    // a resumed session flashing its whole age), so the timer silently vanished on anything older.
    ...(entry.turnStartedAt !== undefined ? { turnStartedAt: entry.turnStartedAt } : {}),
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
