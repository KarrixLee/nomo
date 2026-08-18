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
  /** Sub-status line (only a `retry`'s message today). */
  detail?: string;
  title?: string;
  model?: string;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `provider/model` — OpenCode's own spelling for a model reference (`Provider.parseModel` splits on
 *  the first `/`), and the string the user picked in the TUI. Read from the newest ASSISTANT
 *  `message.updated`, never from `session.model`: those columns exist on 1.18.15 but are entirely
 *  unpopulated (322 rows, 0 models) — that write is a dev-branch addition. */
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
 *  | `session.updated`              | (title only, no frame)                                   |
 *  | `message.updated` (assistant)  | (model only, no frame)                                   |
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
      state.sessions.set(sessionId, created);
      return frame(sessionId, created, "start", "working", now);
    }

    case "session.updated": {
      if (!entry) return null; // a session we never saw start — the plugin loaded mid-flight
      applyTitle(entry, info);
      return null; // the next status/idle frame carries the new title
    }

    case "message.updated": {
      if (!entry || !info) return null;
      const model = ocModelFromMessage(info);
      if (model) entry.model = model;
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
      // shows. The key spans everything that can change the RENDERED frame (title/model included), so
      // a title landing mid-turn still gets through on the very next busy.
      const key = JSON.stringify([planned.status, planned.detail, planned.title, planned.model]);
      if (live.lastStatusFrame === key) return null;
      live.lastStatusFrame = key;
      return planned;
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

/** Adopt a session first seen mid-flight (the plugin loaded into a server that already had sessions,
 *  or `session.created` predated us). Its first frame is an `update`, not a `start`. */
function adopt(state: OcState, sessionId: string, now: number): OcSessionState {
  const entry: OcSessionState = { startedAt: now, working: false };
  state.sessions.set(sessionId, entry);
  return entry;
}

function applyTitle(entry: OcSessionState, info: Record<string, unknown> | undefined): void {
  const title = asString(info?.title);
  if (title && !isDefaultOcTitle(title)) entry.title = title;
}

function frame(
  sessionId: string, entry: OcSessionState, op: CCOp, status: CCStatus, now: number, detail?: string,
): OcFrame {
  // The turn anchor (epoch SECONDS, the blob's unit) is stamped on the EDGE into working, so the
  // island's turn clock counts this turn and not the session. A session sitting idle for an hour and
  // then prompted must show 0s, not 1h.
  if (status === "working" && op !== "start") {
    if (!entry.working || entry.turnStartedAt === undefined) entry.turnStartedAt = Math.floor(now / 1000);
    entry.working = true;
  }
  return {
    sessionId,
    op,
    prio: 0,
    status,
    ...(detail ? { detail } : {}),
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.model ? { model: entry.model } : {}),
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
