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
 *  | session.execution.succeeded/failed/interr. | session.status idle (+ nomo.outcome failed/interr.)   |
 *  | session.retry.scheduled {at, error}        | session.status retry (+ nomo.retryAt/retryReason)     |
 *  | session.compaction.started                 | session.status busy (+ nomo.phase "compacting")       |
 *  | session.deleted                            | session.deleted                                       |
 *  | session.tool.success/failed {id}           | message.part.updated (tool completed/error)           |
 *  |   (todowrite: metadata.todos)              | + todo.updated                                        |
 *  | permission.asked {action,resources,source} | permission.asked {permission,patterns,tool}           |
 *  | permission.replied                         | permission.replied (same fields)                      |
 *  | form.created / replied / cancelled         | question.asked / question.replied / question.rejected |
 *
 *  `nomo` is a 2.x-only hint bag the reducer reads for the honest-state blob keys (state.ts OcHints);
 *  no 1.x event carries it.
 *
 *  2.x never publishes `session.status` / `session.idle` (the schema still declares them; nothing in
 *  core emits them), so turn start/end come from `session.execution.*`.
 */

import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { CC_DIR, parseWatchdogPidfile, pidAlive, PLUGIN_VERSION, watchdogVersionOutranks } from "../core/shared";

/** A SessionError (`{type, message}`) as a short, single-line reason for the sealed `outcomeReason`:
 *  the message (else the type), control characters folded to spaces, capped at 160 characters. */
export function ocErrorReason(error: unknown): string | undefined {
  const e = asRecord(error);
  const raw = asString(e?.message) ?? asString(e?.type);
  if (!raw) return undefined;
  const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length <= 160 ? clean : `${clean.slice(0, 159)}…`;
}

/** Every 2.x type the translator reads — the subscription filter, so OpenCode never encodes the rest. */
export const OC_V2_EVENT_TYPES = [
  "session.created", "session.renamed", "session.agent.selected", "session.step.started",
  "session.execution.started", "session.execution.succeeded", "session.execution.failed",
  "session.execution.interrupted", "session.retry.scheduled", "session.deleted",
  "session.tool.success", "session.tool.failed",
  "permission.asked", "permission.replied",
  "form.created", "form.replied", "form.cancelled",
  "session.compaction.started",
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
      return sessionID ? [v1("session.status", { sessionID, status: { type: "idle" } })] : [];
    case "session.execution.failed":
    case "session.execution.interrupted": {
      if (!sessionID) return [];
      const reason = type === "session.execution.failed" ? ocErrorReason(d.error) : undefined;
      return [v1("session.status", {
        sessionID, status: { type: "idle" },
        nomo: { outcome: type === "session.execution.failed" ? "failed" : "interrupted", ...(reason ? { reason } : {}) },
      })];
    }
    case "session.retry.scheduled": {
      if (!sessionID) return [];
      // `at` is the next attempt in epoch MS (core/session/runner/retry.ts: scheduled + delay).
      const at = Number(d.at);
      const error = asRecord(d.error);
      const rateLimited = error?.status === 429 || /rate.?limit|too.?many.?requests/i.test(asString(error?.type) ?? "");
      return [v1("session.status", {
        sessionID, status: { type: "retry" },
        nomo: {
          ...(Number.isFinite(at) && at > 0 ? { retryAt: Math.ceil(at / 1000) } : {}),
          ...(rateLimited ? { retryReason: "rateLimited" } : {}),
        },
      })];
    }
    case "session.compaction.started":
      // Always inside an execution (auto: mid-step; manual: drained by the runner), so the idle that
      // ends it follows. Cleared by the next step's plain busy, never by compaction.ended — a busy
      // planned from that could land after the idle and reopen a finished row.
      return sessionID ? [v1("session.status", { sessionID, status: { type: "busy" }, nomo: { phase: "compacting" } })] : [];
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
        // DELIBERATELY EMPTY, so `permissionGrant` stays "" and an OLDER app offers no "Always allow":
        // its OpenCode label promises "(until OpenCode restarts)", but 2.x `reply("always")` writes the
        // request's `save` patterns to the project's SQLite `permission` table (core/src/permission.ts),
        // where they survive restarts. The real grant rides as `save` → the card's append-last
        // `permissionProjectGrant`, which only a 2.5.3+ app reads ("saved for this project"). Always
        // `save` (possibly []) on 2.x: its presence is what marks the request as 2.x (approvals.ts).
        always: [],
        save: Array.isArray(d.save) ? d.save.filter((p): p is string => typeof p === "string") : [],
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
 *  An `always` goes through as `always` (2.5.3): only an app that read `permissionProjectGrant` — and
 *  so said "saved for this project" — offers it on 2.x. A reject's `message` (a deny NOTE) is passed on;
 *  OpenCode hands it to the model as a CorrectedError and the model continues. */
export function ocV2Client(
  reply: (input: { sessionID: string; requestID: string; decision: string; message?: string }) => Promise<unknown>,
  sessionOf: (requestID: string) => string | undefined,
): { _client: { post: (o: { url: string; body?: unknown }) => Promise<{ response: { status: number } }> } } {
  return {
    _client: {
      post: async ({ url, body }) => {
        const requestID = /^\/permission\/([^/]+)\/reply$/.exec(url)?.[1];
        const sessionID = requestID === undefined ? undefined : sessionOf(requestID);
        const decision = asString(asRecord(body)?.reply);
        const message = asString(asRecord(body)?.message);
        if (requestID === undefined || sessionID === undefined || decision === undefined) return { response: { status: 404 } };
        await reply({ sessionID, requestID, decision, ...(decision === "reject" && message ? { message } : {}) });
        return { response: { status: 204 } };
      },
    },
  };
}

/** NOM-214: how many OpenCode WINDOWS are attached to this server, from `lsof -nP -a -p <own pid> -iTCP
 *  -FnT` (field output: `n<name>` then `TST=<state>` per socket). A window — the TUI, the web UI, the
 *  desktop app on the shared service — holds an SSE stream (`/api/event`) open into the server's
 *  listener for as long as it is open, so the connections whose LOCAL end is a listening port are the
 *  windows; outbound ones (the provider's :443) are not. Undefined — "can't tell", never zero — when
 *  there is no listener at all (or no output: lsof missing or failed).
 *
 *  OpenCode 2.x has no presence signal of its own (verified on v2.4.1: no client/detach event, the event
 *  feed's subscriber set is private, `session.viewed` is a read receipt), so the socket table is it. */
export function ocClientCount(lsofFields: string): number | undefined {
  const sockets: { name: string; state?: string }[] = [];
  for (const line of lsofFields.split("\n")) {
    if (line.startsWith("n")) sockets.push({ name: line.slice(1) });
    else if (line.startsWith("TST=") && sockets.length > 0) sockets[sockets.length - 1].state = line.slice(4);
  }
  const port = (address: string) => address.slice(address.lastIndexOf(":") + 1);
  const listening = new Set(sockets.filter((s) => s.state === "LISTEN").map((s) => port(s.name)));
  if (listening.size === 0) return undefined;
  return sockets.filter((s) => s.state === "ESTABLISHED" && listening.has(port(s.name.split("->")[0]))).length;
}

/** NOM-214: while a row is parked on a prompt only a window can answer (`pending`), poll how many
 *  windows are attached (`count`) and `close` those rows once NONE has been for two polls in a row —
 *  one windowless poll can be a TUI reconnecting its stream. Unknown (undefined) never closes anything.
 *  At the default 10 s, a closed window settles its row in 10–20 s. Returns `stop`. */
export function ocWatchClients(o: {
  count: () => Promise<number | undefined>;
  pending: () => boolean;
  close: () => void;
  intervalMs?: number;
}): () => void {
  let misses = 0;
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    if (!o.pending()) { misses = 0; return; }
    polling = true;
    void o.count().then((n) => {
      misses = n === 0 ? misses + 1 : 0;
      if (misses >= 2) { misses = 0; o.close(); }
    }).catch(() => { misses = 0; }).finally(() => { polling = false; }); // never throws into OpenCode
  }, o.intervalMs ?? 10_000);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/** The CHEAP half of the idle watchdog guard (2.5.3): is the live daemon one that can serve this
 *  plugin's commands — this version or a newer one? One small pidfile read and a `kill(pid, 0)`: no
 *  `ps` fork, no bundle hash. Anything else (no daemon, a dead pid, an OLDER version) → false, and the
 *  caller runs the full ensureWatchdog, which verifies identity and evicts the older one. Pure but for `alive`. */
export function ocWatchdogServesUs(
  raw: string | undefined, alive: (pid: number) => boolean = pidAlive, version: string = PLUGIN_VERSION,
): boolean {
  const holder = typeof raw === "string" ? parseWatchdogPidfile(raw) : null;
  return !!holder && alive(holder.pid) && !watchdogVersionOutranks(version, holder.version);
}

/** A real JS runtime for the watchdog (plugin.ts spawnWatchdog — see its landmine note): $NOMO_RUNTIME,
 *  else run.sh's runtime cache, else run.sh's own fast path. */
export function resolveRuntime(env: NodeJS.ProcessEnv = process.env, ccDir: string = CC_DIR): string | undefined {
  const forced = env.NOMO_RUNTIME;
  if (forced && forced.length > 0 && isExecutable(forced)) return forced;
  try {
    const cached = readFileSync(`${ccDir}/runtime`, "utf8").trim();
    // run.sh writes a `NONE:<epoch>` sentinel when it found no runtime at all — that is a negative
    // cache, not a path.
    if (cached.length > 0 && !cached.startsWith("NONE:") && isExecutable(cached)) return cached;
  } catch { /* no cache — the usual case, see below */ }
  // run.sh writes that cache ONLY on its slow login-shell path. When bun/node sits on PATH or in a
  // standard spot (~/.bun/bin — most machines) it never writes one, so stopping at the cache meant this
  // plugin could never start a watchdog (2.5.3 field bug: its eviction killed an older daemon and
  // started nothing). So run.sh's own fast path, in its order: bun then node on PATH (absolute entries
  // only), then its fixed candidates. Fork-free: a few access() calls.
  const dirs = (env.PATH ?? "").split(delimiter).filter((d) => isAbsolute(d));
  for (const name of ["bun", "node"]) {
    for (const d of dirs) if (isExecutable(join(d, name))) return join(d, name);
  }
  const home = env.HOME ?? "";
  for (const candidate of [
    ...(home ? [`${home}/.bun/bin/bun`] : []), "/opt/homebrew/bin/bun", "/usr/local/bin/bun",
    "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node",
  ]) if (isExecutable(candidate)) return candidate;
  return undefined;
}

function isExecutable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}
