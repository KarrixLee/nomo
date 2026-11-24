/** OpenCode 2.x → the 1.x event shapes the reducer (state.ts) and approvals (approvals.ts) already speak.
 *
 *  WHY A TRANSLATOR AND NOT A SECOND REDUCER. OpenCode 2.x rewrote the plugin API (the `event` hook is
 *  gone; events arrive from `ctx.event.subscribe` shaped `{type, data, location}`) and renamed most of the
 *  lifecycle, but the PHONE must not notice: an OpenCode 2.x session has to produce exactly the records
 *  and envelopes a 1.x one does. So every 2.x event is rewritten into the 1.x event(s) it means and fed
 *  through the very same `server()` hooks — one state machine, one hold pipeline, two front doors.
 *
 *  Verified against `anomalyco/opencode` v2.4.1 source (packages/schema/src/session-event.ts,
 *  permission.ts, form.ts; packages/core/src/session/execution.ts, permission.ts):
 *
 *  | 2.x                                        | 1.x it becomes                                        |
 *  |--------------------------------------------|-------------------------------------------------------|
 *  | session.created {sessionID,parentID,…}     | session.created {info:{id,parentID,title,agent,time}} |
 *  |   (+ model)                                | + message.updated (assistant, model only)             |
 *  | session.renamed {title}                    | session.updated {info:{title}}                        |
 *  | session.agent.selected {agent}             | session.updated {info:{agent}} (a seed, like 1.x)     |
 *  | session.step.started {agent, model}        | message.updated (assistant) + session.status busy     |
 *  | session.execution.started                  | session.status busy                                   |
 *  | session.execution.succeeded/failed/interr. | session.status idle                                   |
 *  | session.retry.scheduled                    | session.status retry                                  |
 *  | session.deleted                            | session.deleted                                       |
 *  | session.tool.success/failed {id}           | message.part.updated (tool completed/error)           |
 *  |   (todowrite: metadata.todos)              | + todo.updated                                        |
 *  | permission.asked {action,resources,source} | permission.asked {permission,patterns,tool}           |
 *  | permission.replied                         | permission.replied (same fields)                      |
 *  | form.created / replied / cancelled         | question.asked / question.replied / question.rejected |
 *
 *  2.x never publishes `session.status` / `session.idle` (the schema still declares them; nothing in
 *  core emits them), so turn start/end come from `session.execution.*`.
 */

/** Every 2.x type the translator reads — the subscription filter, so OpenCode never encodes the rest. */
export const OC_V2_EVENT_TYPES = [
  "session.created", "session.renamed", "session.agent.selected", "session.step.started",
  "session.execution.started", "session.execution.succeeded", "session.execution.failed",
  "session.execution.interrupted", "session.retry.scheduled", "session.deleted",
  "session.tool.success", "session.tool.failed",
  "permission.asked", "permission.replied",
  "form.created", "form.replied", "form.cancelled",
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const v1 = (type: string, properties: Record<string, unknown>) => ({ type, properties });

/** The 2.x stream is SERVER-wide — the bus is global, and the default background service hosts every
 *  directory with one plugin instance per location — while the 1.x `event` hook was directory-scoped.
 *  Whose is this event?
 *   - "theirs": another directory's (stamped with it, or its session was looked up and found elsewhere);
 *   - "ours":   a session already seen here, or one born here (`session.created` with our location);
 *   - "ask":    a session we have never seen. TRAP (seen live on 2.4.1): `session.execution.*` and
 *               `permission.replied` carry NO location, so "no location" cannot mean "ours" — the caller
 *               looks the session up (`ctx.session.get`), which also recovers its parent and title when
 *               it predates this plugin instance (a continued session, a plugin reload, a subagent).
 *  `known` / `foreign` are the memo; this function maintains `known` for what it can decide alone. */
export function ocV2Scope(
  event: unknown, directory: string | undefined, known: Set<string>, foreign: Set<string>,
): "ours" | "theirs" | "ask" {
  const e = asRecord(event);
  const d = asRecord(e?.data);
  const sessionID = asString(d?.sessionID) ?? asString(asRecord(d?.form)?.sessionID);
  const at = asString(asRecord(e?.location)?.directory);
  const elsewhere = at !== undefined && directory !== undefined && at !== directory;
  if (sessionID === undefined) return elsewhere ? "theirs" : "ours";
  if (elsewhere) { known.delete(sessionID); foreign.add(sessionID); return "theirs"; }
  if (known.has(sessionID)) {
    if (e?.type === "session.deleted") known.delete(sessionID);
    return "ours";
  }
  if (e?.type === "session.created" && at !== undefined) { known.add(sessionID); foreign.delete(sessionID); return "ours"; }
  return foreign.has(sessionID) && at === undefined ? "theirs" : "ask";
}

/** The 1.x `session.created` for a session first met mid-flight, from its `ctx.session.get` record
 *  (`Session.Info`, `time.created` as epoch ms). Its parentID is what keeps a subagent
 *  that predates us off the phone as a row of its own; its title is what a continued session would
 *  otherwise never get (2.x renames once, where 1.x re-sent the title on every `session.updated`).
 *  Like any created session, the next busy opens its row with a `start`. */
export function ocV1Backfill(sessionID: string, info: unknown): unknown[] {
  const i = asRecord(info);
  const created = Number(asRecord(i?.time)?.created);
  const out: unknown[] = [v1("session.created", {
    sessionID,
    info: {
      id: sessionID, parentID: i?.parentID, title: i?.title, agent: i?.agent,
      ...(Number.isFinite(created) && created > 0 ? { time: { created } } : {}),
    },
  })];
  if (asRecord(i?.model)) out.push(assistantMessage(sessionID, i?.model, undefined));
  return out;
}

/** The assistant `message.updated` the 1.x reducer reads the model (and the latched agent) from. */
function assistantMessage(sessionID: string, model: unknown, agent: unknown) {
  const m = asRecord(model);
  return v1("message.updated", {
    sessionID,
    info: { role: "assistant", sessionID, providerID: m?.providerID, modelID: m?.id, agent },
  });
}

/** 2.x permission action → the 1.x permission name the card mapping (approvals.ts PERMISSION_TOOL) and
 *  the grant text key on. `shell` was `bash`. `question` is the question TOOL's own pre-check
 *  (`permission.assert({action:"question"})`, allowed by default) and must never reach the phone as the
 *  literal `question`: that is the pinned question-channel tool name, and a permission card wearing it
 *  would be routed as a question with no questions. */
function v1Permission(action: string | undefined): string {
  if (action === "shell") return "bash";
  if (action === "question") return "question_permission";
  return action ?? "permission";
}

/** Rewrite one 2.x event into the 1.x event(s) it means; [] for anything we do not map. Pure. */
export function ocV1Events(event: unknown): unknown[] {
  const e = asRecord(event);
  const type = asString(e?.type);
  const d = asRecord(e?.data);
  if (!type || !d) return [];
  const sessionID = asString(d.sessionID);

  switch (type) {
    case "session.created": {
      if (!sessionID) return [];
      const created = Number(e?.created);
      const out: unknown[] = [v1("session.created", {
        sessionID,
        info: {
          id: sessionID, parentID: d.parentID, title: d.title, agent: d.agent,
          ...(Number.isFinite(created) && created > 0 ? { time: { created } } : {}),
        },
      })];
      // No agent here on purpose: an assistant message LATCHES the agent (state.ts applyAgent), and a
      // create-time model is not a turn.
      if (asRecord(d.model)) out.push(assistantMessage(sessionID, d.model, undefined));
      return out;
    }
    case "session.renamed":
      return sessionID ? [v1("session.updated", { sessionID, info: { id: sessionID, title: d.title } })] : [];
    case "session.agent.selected":
      return sessionID ? [v1("session.updated", { sessionID, info: { id: sessionID, agent: d.agent } })] : [];
    case "session.step.started":
      // The per-step truth, exactly what 1.x's assistant message was. The busy after it is what clears a
      // `retrying` detail once the retried step actually starts (identical busies are skip-keyed).
      return sessionID
        ? [assistantMessage(sessionID, d.model, d.agent), v1("session.status", { sessionID, status: { type: "busy" } })]
        : [];
    case "session.execution.started":
      return sessionID ? [v1("session.status", { sessionID, status: { type: "busy" } })] : [];
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return sessionID ? [v1("session.status", { sessionID, status: { type: "idle" } })] : [];
    case "session.retry.scheduled":
      return sessionID ? [v1("session.status", { sessionID, status: { type: "retry" } })] : [];
    case "session.deleted":
      return sessionID ? [v1("session.deleted", { sessionID, info: { id: sessionID } })] : [];
    case "session.tool.success":
    case "session.tool.failed": {
      const callID = asString(d.id);
      if (!sessionID || !callID) return [];
      const out: unknown[] = [v1("message.part.updated", {
        sessionID,
        part: {
          type: "tool", sessionID, messageID: d.assistantMessageID, callID,
          state: { status: type === "session.tool.success" ? "completed" : "error" },
        },
      })];
      // `todowrite` has no event of its own in 2.x: its whole list rides the success metadata.
      const todos = asRecord(d.metadata)?.todos;
      if (type === "session.tool.success" && Array.isArray(todos)) out.push(v1("todo.updated", { sessionID, todos }));
      return out;
    }
    case "permission.asked": {
      const id = asString(d.id);
      if (!id || !sessionID) return [];
      const source = asRecord(d.source);
      return [v1("permission.asked", {
        id,
        sessionID,
        permission: v1Permission(asString(d.action)),
        patterns: Array.isArray(d.resources) ? d.resources : [],
        // DELIBERATELY EMPTY, so the card offers NO "Always allow". In 2.x `always` is no longer the
        // in-memory rule the phone's copy promises ("… (until OpenCode restarts)"): core/src/permission.ts
        // `reply` writes the request's `save` patterns to the project's SQLite `permission` table, where
        // they survive restarts. An empty list makes ocGrantText return "" (= a one-time tap only), and
        // the phone hides the button. Restore it once the app's label says "saved for this project".
        always: [],
        metadata: asRecord(d.metadata) ?? {},
        ...(source?.type === "tool" ? { tool: { messageID: source.messageID, callID: source.id } } : {}),
      })];
    }
    case "permission.replied":
      return asString(d.requestID)
        ? [v1("permission.replied", { sessionID, requestID: d.requestID, reply: d.reply })]
        : [];
    case "form.created": {
      // The question tool now asks through a form. The plugin API has no route to answer one (no `form`
      // domain on the 2.x context, and the TUI's server need not listen on any port), so a form is shown
      // as "answer at your Mac" and never held — plugin.ts passes `questionsOnComputer`. The fields stand
      // in for `questions` only so the request is non-empty; nothing renders them.
      const form = asRecord(d.form);
      const id = asString(form?.id);
      const formSession = asString(form?.sessionID);
      const fields = Array.isArray(form?.fields) ? form.fields : [];
      if (!id || !formSession || fields.length === 0) return [];
      const tool = asRecord(asRecord(form?.metadata)?.tool);
      return [v1("question.asked", {
        id,
        sessionID: formSession,
        questions: fields,
        ...(tool ? { tool: { messageID: tool.messageID, callID: tool.id } } : {}),
      })];
    }
    case "form.replied":
      return asString(d.id) ? [v1("question.replied", { sessionID, requestID: d.id })] : [];
    case "form.cancelled":
      return asString(d.id) ? [v1("question.rejected", { sessionID, requestID: d.id })] : [];
    default:
      return [];
  }
}

/** The 2.x reply seam, dressed as the 1.x `OpencodeClient` that approvals.ts's `ocPost` already drives
 *  (`client._client.post({url, body})`), so the hold pipeline stays byte-identical. 2.x removed
 *  `POST /permission/:id/reply`; the reply is `ctx.permission.reply({sessionID, requestID, decision})`,
 *  which needs the session — hence `sessionOf`, fed from `permission.asked`.
 *
 *  An `always` is sent as `once`: the card never offers it on 2.x (see `always: []` above), and if a
 *  stale card sends one anyway it must not write a permanent project rule nobody was told about. */
export function ocV2Client(
  reply: (input: { sessionID: string; requestID: string; decision: string }) => Promise<unknown>,
  sessionOf: (requestID: string) => string | undefined,
): { _client: { post: (o: { url: string; body?: unknown }) => Promise<{ response: { status: number } }> } } {
  return {
    _client: {
      post: async ({ url, body }) => {
        const requestID = /^\/permission\/([^/]+)\/reply$/.exec(url)?.[1];
        const sessionID = requestID === undefined ? undefined : sessionOf(requestID);
        const decision = asString(asRecord(body)?.reply);
        if (requestID === undefined || sessionID === undefined || decision === undefined) return { response: { status: 404 } };
        await reply({ sessionID, requestID, decision: decision === "always" ? "once" : decision });
        return { response: { status: 204 } };
      },
    },
  };
}
