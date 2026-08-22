/** OpenCode approvals — the purple hand, on two channels.
 *
 *  OpenCode blocks on a human in two distinct ways, and OpenCode itself models them as peer states
 *  ("awaiting permission" / "awaiting answer"):
 *
 *    permission.asked  {id, sessionID, permission, patterns, metadata, tool}
 *      → POST /permission/{id}/reply  {"reply":"once"|"always"|"reject"}
 *    question.asked    {id, sessionID, questions[], tool}
 *      → POST /question/{id}/reply    {"answers":[["Red"]]}     (option LABELS, verbatim)
 *      → POST /question/{id}/reject   (no body)                 — NEVER /session/{id}/abort
 *
 *  All three go out over `input.client`, NEVER over `input.serverUrl` — see `ocPost`, which is where
 *  the whole reason lives. `serverUrl` is a fabricated `http://localhost:4096` whenever OpenCode has no
 *  TCP listener, which is every TUI session, which is nearly every session.
 *
 *  To the PHONE they are both one thing: a decisionPending frame with Allow/Deny (or an option list).
 *  The decision transport — the /v1/cc/decision POST, the hold, the 3 s poll, the LAN loopback, the
 *  gone-strike caps, the on-disk hold marker, the fail-open posture — is already 100 % agent-blind, so
 *  this module builds a synthesized hook stdin, hands it to `runPermissionHook` whole, and translates
 *  the ONE decision line it emits back into an OpenCode HTTP call. There is no parallel hold machine
 *  here, and there must never be one.
 *
 *  ── THE LANDMINE ──────────────────────────────────────────────────────────────────────────────────
 *  `runPermissionHook`'s DEFAULT trace sink (permission.ts's defaultTrace) installs PROCESS-WIDE
 *  SIGTERM/SIGINT/SIGHUP/uncaughtException/unhandledRejection handlers that call `process.exit(0)`.
 *  That is correct for a short-lived hook process. We are running INSIDE OPENCODE'S SERVER PROCESS: it
 *  would hijack the user's Ctrl-C and kill their editor on any unhandled rejection anywhere in
 *  OpenCode. `trace` is therefore ALWAYS injected (ocTrace below) — never defaulted, not once, not in
 *  a test. `approvals.test.ts` asserts the process listener counts are unchanged across a full hold.
 *  For the same reason `readInput` (which would consume the server's stdin), `emit` (stdout) and
 *  `delegate` (which would call runHook, which reads stdin) are injected too.
 */

import { appendFileSync, statSync, truncateSync } from "node:fs";
import type { AgentKind, Config } from "../core/shared";
import { PLUGIN_VERSION } from "../core/shared";
import { OPENCODE_QUESTION_TOOL, runPermissionHook, TRACE_PATH } from "../core/permission";
import type { PermissionHookDeps } from "../core/permission";

/** One pending human decision, normalized across the two channels. */
export interface OcDecisionRequest {
  kind: "permission" | "question";
  /** `per_…` / `que_…` — from `properties.id` on the ASKED event (it is `properties.requestID` on the
   *  replied/rejected ones; see ocResolvedRequestId). */
  id: string;
  sessionID: string;
  /** The tool name the phone's card layout keys off: `OPENCODE_QUESTION_TOOL` for a question, and a
   *  Claude-side tool name for a permission (see PERMISSION_TOOL). */
  toolName: string;
  toolInput: Record<string, unknown>;
  /** OpenCode's own `questions` array, kept verbatim so the answers round-trip can re-find each
   *  question's original option labels. Questions only. */
  questions?: unknown[];
}

/** What to send back to OpenCode. `body` absent = a bodyless POST (the question reject route). */
export interface OcReply {
  /** Route-relative, NO leading slash — `ocPost` adds one for the client transport and resolves it
   *  against `serverUrl` (a URL ending in "/") for the fallback. */
  path: string;
  body?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** OpenCode permission name → the tool name (and tool_input shape) the phone's card already knows how
 *  to render. `buildPermissionSummary` / `buildPermissionDetail` are tool-name switches, so this is
 *  the whole difference between a card that says "example.com" and one that says "webfetch".
 *
 *  KNOWN GAP: OpenCode's other permission names (`grep`, `glob`, `skill`, `task`, `external_directory`,
 *  `doom_loop`, an MCP tool id) fall through to the bare name with no detail line — their useful text
 *  lives in `patterns`, and the shared summary switch has no generic arm to put it in. Adding one would
 *  change what an unknown Claude/Codex MCP tool renders as, which is not this feature's business. */
const PERMISSION_TOOL: Record<string, { name: string; input: (props: OcPermissionProps) => Record<string, unknown> }> = {
  // OpenCode's `metadata:{command}` is Codex's `shell` tool_input exactly; `patterns` is the same
  // command when metadata is missing.
  bash: { name: "shell", input: (p) => ({ command: asString(p.metadata.command) ?? p.patterns.join(" ") }) },
  edit: { name: "Edit", input: (p) => ({ file_path: asString(p.metadata.filepath) ?? p.patterns[0] }) },
  read: { name: "Read", input: (p) => ({ file_path: asString(p.metadata.uri) ?? p.patterns[0] }) },
  webfetch: { name: "WebFetch", input: (p) => ({ url: asString(p.metadata.url) ?? p.patterns[0] }) },
  websearch: { name: "WebSearch", input: (p) => ({ query: asString(p.metadata.query) ?? p.patterns[0] }) },
};

interface OcPermissionProps {
  metadata: Record<string, unknown>;
  patterns: string[];
}

/** Normalize a `permission.asked` / `question.asked` event into one pending decision, or null for
 *  every other event. Reads `unknown` and narrows by hand — the published `Event` union is stale and
 *  the SSE frames carry no `event:` line, so the JSON `type` field is the only discriminator. */
export function ocDecisionRequest(event: unknown): OcDecisionRequest | null {
  const e = asRecord(event);
  const type = asString(e?.type);
  const properties = asRecord(e?.properties);
  if (!type || !properties) return null;
  const id = asString(properties.id);
  const sessionID = asString(properties.sessionID);
  if (!id || !sessionID) return null;

  if (type === "permission.asked") {
    const permission = asString(properties.permission) ?? "permission";
    const patterns = Array.isArray(properties.patterns)
      ? properties.patterns.filter((p): p is string => typeof p === "string")
      : [];
    const metadata = asRecord(properties.metadata) ?? {};
    const mapped = PERMISSION_TOOL[permission];
    return {
      kind: "permission",
      id,
      sessionID,
      toolName: mapped?.name ?? permission,
      toolInput: mapped ? mapped.input({ metadata, patterns }) : {},
    };
  }

  if (type === "question.asked") {
    const questions = Array.isArray(properties.questions) ? properties.questions : [];
    if (questions.length === 0) return null; // nothing to render, nothing to answer
    // PINNED CROSS-REPO CONTRACT — the tool name is the LITERAL string `question`, OpenCode's own
    // spelling. iOS keys its question matrix off exactly this (`CCEnvelopeCrypto.opencodeToolName`), so
    // a prettified label, `question.asked`, or the question text itself would drop the card back to the
    // ordinary Allow/Deny matrix: no answer options, and no turn-ending Dismiss warning.
    //
    // OpenCode's QuestionInfo is {question, options:[{label, description}]} — field for field what
    // `usableQuestions` / `answerLine` parse — so the plugin side needs no shape translation either;
    // permission.ts's `isAnswerTool` simply names this spelling alongside Claude's.
    return {
      kind: "question", id, sessionID, toolName: OPENCODE_QUESTION_TOOL, toolInput: { questions }, questions,
    };
  }

  return null;
}

/** The id a `permission.replied` / `question.replied` / `question.rejected` retires. FIELD-NAME TRAP:
 *  it is `properties.requestID` on all three, and `properties.id` on the asked events. */
export function ocResolvedRequestId(event: unknown): string | null {
  const e = asRecord(event);
  const type = asString(e?.type);
  if (type !== "permission.replied" && type !== "question.replied" && type !== "question.rejected") return null;
  return asString(asRecord(e?.properties)?.requestID) ?? null;
}

/** Rebuild OpenCode's `answers: string[][]` from the answers map CC's decision line carries.
 *
 *  The map is keyed by the ORIGINAL question text and valued by an ORIGINAL option label (multi-select
 *  arrives as the ", "-joined form — see answerLine/resolveAnswer). OpenCode wants one inner array per
 *  question, IN ORDER, holding the labels VERBATIM (not indices); an empty inner array is a legal
 *  "Unanswered". Iterating OpenCode's OWN questions array — not the map — is what keeps the positions
 *  right when `usableQuestions` skipped an entry (no text, or no usable option).
 *
 *  The whole value is tried as ONE label first, exactly like resolveAnswer: an option label may itself
 *  contain ", ", and splitting it would send OpenCode two labels that never existed. */
export function ocAnswers(questions: unknown[], map: Record<string, unknown>): string[][] {
  return questions.map((raw) => {
    const question = asRecord(raw);
    const text = asString(question?.question);
    const picked = text === undefined ? undefined : asString(map[text]);
    if (picked === undefined) return [];
    const labels = (Array.isArray(question?.options) ? question.options : [])
      .map((o) => asString(asRecord(o)?.label))
      .filter((l): l is string => l !== undefined);
    if (labels.includes(picked)) return [picked];
    const pieces = picked.split(", ").filter((p) => labels.includes(p));
    return pieces.length > 0 ? pieces : [picked];
  });
}

/** Translate the ONE decision line `runPermissionHook` emitted into the OpenCode call it means.
 *
 *  | phone answer                          | permission channel | question channel        |
 *  |---------------------------------------|--------------------|-------------------------|
 *  | Deny (`behavior:"deny"`)              | reply `reject`     | `/reject` (no body)     |
 *  | Allow (bare `behavior:"allow"`)       | reply `once`       | (never emitted — held)  |
 *  | Always allow (+`updatedPermissions`)  | reply `always`     | (never emitted — held)  |
 *  | Answer (`updatedInput.answers`)       | (never emitted)    | reply `{answers:[[…]]}` |
 *
 *  Null for "the hook emitted nothing" — the released / expired / fail-open exits, which mean the user
 *  answers at the Mac. We must NOT invent a reply for those: the TUI dialog is still up and OpenCode's
 *  own request stays pending, which is exactly the intended degraded mode.
 *
 *  A deny MESSAGE is deliberately dropped. OpenCode's reply schema accepts one, but a `message` turns
 *  the tool's `RejectedError` into a `CorrectedError`, which its own TUI buckets differently — and the
 *  common case is the frozen "Denied from phone" placeholder rather than anything the user typed. */
export function ocReplyFor(request: OcDecisionRequest, line: string | undefined): OcReply | null {
  if (line === undefined) return null;
  let decision: Record<string, unknown> | undefined;
  try {
    const parsed = asRecord(JSON.parse(line));
    decision = asRecord(asRecord(parsed?.hookSpecificOutput)?.decision);
  } catch { return null; } // a line we cannot parse is a line we must not act on
  if (!decision) return null;

  if (request.kind === "question") {
    if (decision.behavior === "deny") return { path: `question/${request.id}/reject` };
    const answers = asRecord(asRecord(decision.updatedInput)?.answers);
    if (decision.behavior === "allow" && answers) {
      return { path: `question/${request.id}/reply`, body: { answers: ocAnswers(request.questions ?? [], answers) } };
    }
    return null; // a bare allow on a question never reaches here (emitDecision releases it) — belt and braces
  }

  if (decision.behavior === "deny") return { path: `permission/${request.id}/reply`, body: { reply: "reject" } };
  if (decision.behavior !== "allow") return null;
  // `updatedPermissions` is the always-allow marker: allowAlwaysLine adds it, allowLine never does.
  const always = Array.isArray(decision.updatedPermissions) && decision.updatedPermissions.length > 0;
  return { path: `permission/${request.id}/reply`, body: { reply: always ? "always" : "once" } };
}

// ---- the reply transport --------------------------------------------------------------------

/** The generated SDK's low-level request seam, hanging off every `OpencodeClient` as `_client`. */
type HeyApiPost = (o: { url: string; body?: unknown }) => Promise<{ response?: { status?: number } }>;

/** Resolve the ONE way to POST a reply to OpenCode, or undefined when there is no route at all.
 *
 *  `input.client` FIRST, ALWAYS — `input.serverUrl` IS A LIE IN THE TUI. The TUI runs its server
 *  in-process with no TCP listener (`cli/cmd/tui.ts` mounts it at "http://opencode.internal" over a
 *  worker fetch), so `Server.url` is undefined and OpenCode's own getter hands us
 *  `http://localhost:4096` — a plausible URL with nothing bound to it. A plain fetch there THROWS, and
 *  that is exactly how every phone answer was lost on the primary (TUI) configuration: the trace shows
 *  `oc-replied … status:0 error:"Error"`. It only ever worked under `opencode serve`/`--port`, the one
 *  shape where `Server.url` is real. `client` is correct in BOTH worlds: with no listener OpenCode
 *  constructs it with a `fetch` that calls the in-process app handler directly, and it also carries the
 *  `ServerAuth` basic-auth header (OPENCODE_SERVER_PASSWORD) that a raw fetch has never sent.
 *
 *  VERIFIED LIVE on 1.18.15: the typed client has NO `permission` or `question` namespace — the only
 *  permission method on it is `postSessionIdPermissionsPermissionId`, a stale `/session/{id}/
 *  permissions/{permissionID}` route that is not what `permission.asked` is answered on. The supported
 *  seam is therefore the hey-api client under `_client`, whose `.post({url, body})` is literally what
 *  every generated namespace method calls; it defaults to a JSON body serializer, drops the
 *  Content-Type when there is no body (the /reject route), and does NOT throw on a non-2xx — the real
 *  status is on `.response`.
 *
 *  The fallback is STRUCTURAL, not a retry: taken only when that seam is missing (an SDK reshape),
 *  never because a client POST failed. Re-firing a failed reply at the bogus localhost:4096 would just
 *  swap one lost answer for a lost answer plus a double-reply risk. */
export type OcPoster = ((reply: OcReply) => Promise<{ via: OcVia; status: number }>) & { via: OcVia };
export type OcVia = "client" | "url";

export function ocPost(
  client: unknown, serverUrl: string | undefined, fetchFn: typeof fetch = fetch,
): OcPoster | undefined {
  const post = (client as { _client?: { post?: HeyApiPost } } | null | undefined)?._client?.post;
  if (typeof post === "function") {
    // `via` is on the FUNCTION too so a caller tracing a THROW can name the transport honestly
    // instead of re-guessing it from `client` (present ≠ used — the seam may be missing).
    return Object.assign(async (reply: OcReply) => {
      const res = await post({
        url: `/${reply.path}`,
        ...(reply.body === undefined ? {} : { body: reply.body }),
      });
      const status = res?.response?.status;
      // No Response object at all means the transport never completed; make that a throw so the
      // caller traces it as status 0 + error rather than as a silent success.
      if (typeof status !== "number") throw new Error("opencode client returned no response");
      return { via: "client" as const, status };
    }, { via: "client" as const });
  }
  if (!serverUrl) return undefined;
  return Object.assign(async (reply: OcReply) => {
    const res = await fetchFn(new URL(reply.path, serverUrl), {
      method: "POST",
      ...(reply.body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reply.body),
      }),
      signal: AbortSignal.timeout(2000),
    });
    return { via: "url" as const, status: res.status };
  }, { via: "url" as const });
}

// ---- the operational trace ------------------------------------------------------------------

/** Same append-only single-line JSON log the Claude/Codex holds write (the debug-session-state skill
 *  reads it), MINUS the process-wide signal handlers — see this module's header. Deliberately a small
 *  duplication of permission.ts's private appender rather than a new export there: the whole point is
 *  that this sink installs NOTHING on `process`, and the safest way to guarantee that is to not be able
 *  to. Rotate-once matches defaultTrace, so an OpenCode-only machine (whose hooks never run and would
 *  therefore never rotate) cannot grow the log without bound. */
const TRACE_MAX_BYTES = 256 * 1024;
let rotated = false;
export function ocTrace(event: object): void {
  try {
    if (!rotated) {
      rotated = true;
      try { if (statSync(TRACE_PATH).size > TRACE_MAX_BYTES) truncateSync(TRACE_PATH, 0); } catch { /* absent */ }
    }
    appendFileSync(
      TRACE_PATH,
      `${JSON.stringify({ ts: Date.now(), pid: process.pid, agent: "opencode", ...event })}\n`,
      { mode: 0o600 },
    );
  } catch { /* tracing is best-effort — never let it break the hold */ }
}

// ---- running one hold -----------------------------------------------------------------------

export interface OcApprovalOptions {
  config: Config;
  /** `input.client` — OpenCode's own `OpencodeClient`. THE reply transport; see `ocPost`. */
  client?: unknown;
  /** `input.serverUrl` stringified — a URL ending in "/", e.g. "http://127.0.0.1:4396/". Only used
   *  when `client` carries no request seam, and NOT trustworthy on its own: under the TUI it is a
   *  fabricated `http://localhost:4096` with nothing listening (see `ocPost`). */
  serverUrl?: string;
  /** The plugin instance's pinned directory, for the blob's folder identity. */
  cwd?: string;
  /** The decision id the phone answers against. Generated by the CALLER so it can retire this hold
   *  later (see ocResolveOnRelay) — `runPermissionHook` would otherwise mint one we never see. */
  requestId: string;
  /** The local `no-hold` escape hatch's fallback. MUST be supplied: the default inside
   *  `runPermissionHook` calls `runHook`, which reads `process.stdin` — inside OpenCode's server that
   *  is a permanent hang. */
  delegate: () => Promise<void>;
  fetchFn?: typeof fetch;
  trace?: (event: object) => void;
  runHold?: (deps: PermissionHookDeps, agent: AgentKind) => Promise<void>;
  /** TEST SEAM ONLY. The local no-hold escape-hatch flag, so a test can drive the hold arm without
   *  depending on whether the developer running it has paused approvals on their own machine. */
  noHoldPath?: string;
}

/** Hold ONE OpenCode decision on the phone, then reply to OpenCode with the answer.
 *
 *  Never throws and never blocks the event firehose: the caller starts this detached (a permission hold
 *  is unbounded by design — the phone owns the dialog) and OpenCode's own TUI dialog stays up the whole
 *  time, so an unanswered hold degrades to "answer at your Mac" rather than wedging anything. */
export async function runOcApproval(request: OcDecisionRequest, o: OcApprovalOptions): Promise<void> {
  const trace = o.trace ?? ocTrace;
  // The synthesized hook stdin. `permission_mode` and `agent_id` are ABSENT on purpose: absent mode is
  // the interactive arm (the hold), and an agent_id would take the subagent pass-through. The Codex
  // reviewer gate is `agent === "codex"` only, so "opencode" never reaches it either.
  const stdin = JSON.stringify({
    session_id: request.sessionID,
    ...(o.cwd ? { cwd: o.cwd } : {}),
    hook_event_name: "PermissionRequest",
    tool_name: request.toolName,
    tool_input: request.toolInput,
  });
  let line: string | undefined;
  try {
    await (o.runHold ?? runPermissionHook)({
      readInput: async () => stdin,
      loadConfigFn: async () => o.config,
      emit: (l) => { line = l; },
      randomUUID: () => o.requestId,
      // EVERY OpenCode hold shares the resident server's pid, so the `.hold` marker's compare-and-clear
      // needs a per-hold discriminator: without one, the first of two concurrent holds in a session to
      // settle passed the pid compare against the SECOND's marker, unlinked it and re-sealed the record
      // to working — taking down a live Allow/Deny card and masking its decisionPending. The decision id
      // is already unique per hold (the caller mints it), so it IS the discriminator. The hook agents
      // pass none and keep the pid-only rule they always had. See DecisionHold.holdId.
      holdId: o.requestId,
      trace,
      fetchFn: o.fetchFn,
      delegate: o.delegate,
      noHoldPath: o.noHoldPath,
    }, "opencode");
  } catch (e) {
    trace({ event: "oc-hold-threw", kind: request.kind, error: (e as { name?: string })?.name ?? "Error" });
    return; // fail open — OpenCode's own dialog is still up
  }
  const reply = ocReplyFor(request, line);
  if (!reply) { trace({ event: "oc-no-reply", kind: request.kind, id: request.id }); return; }
  const post = ocPost(o.client, o.serverUrl, o.fetchFn);
  if (!post) { trace({ event: "oc-replied", kind: request.kind, id: request.id, path: reply.path, status: 0, via: "none", error: "NoTransport" }); return; }
  try {
    const { status } = await post(reply);
    trace({ event: "oc-replied", kind: request.kind, id: request.id, path: reply.path, via: post.via, status });
  } catch (e) {
    // The answer is lost and OpenCode is still blocked — but its own dialog never went away, so the
    // user can still answer at the Mac. Silence is the contract; never surface into the editor.
    // `status:0` is the THREW case and is not a status — an HTTP failure arrives as a real status.
    trace({
      event: "oc-replied", kind: request.kind, id: request.id, path: reply.path, status: 0,
      via: post.via,
      error: (e as { name?: string })?.name ?? "Error",
      message: String((e as { message?: unknown })?.message ?? "").slice(0, 200),
    });
  }
}

/** Retire a hold this process is STILL polling for, because OpenCode resolved its request some other
 *  way. Three things do that, and all three land as an event we already see:
 *
 *   1. the user answered at the Mac (`permission.replied` / `question.replied` / `question.rejected`);
 *   2. THE REJECT CASCADE — `Permission.reply` with `reply:"reject"` fails every OTHER pending
 *      permission in the same session, publishing a `permission.replied {reply:"reject"}` for each;
 *   3. the ALWAYS cascade — `reply:"always"` also resolves every sibling whose patterns the new rule
 *      now covers, again publishing `permission.replied` per sibling.
 *
 *  So the sibling holds are retired by the ordinary replied-event path and need no bespoke cascade
 *  bookkeeping. This POST is the blob-free /v1/cc/decision/resolve transition (the same one
 *  cc-watchdog's LAN backstop echoes): it stamps the worker record `superseded`, the sibling's own poll
 *  loop reads that on its next 3 s tick and exits silently, and the phone's card drops. Best-effort by
 *  contract — the worker's poll-liveness sweep expires the card if this misses.
 *
 *  Deliberately NOT imported from codex-remote-input (which exports the identical call): that module
 *  pulls in the LAN listener's node:http server and the Codex app-server client, neither of which may
 *  ever be bundled into a plugin resident in the user's editor process. Same trade postOcEvent makes. */
export async function ocResolveOnRelay(
  config: Config, requestId: string, fetchFn: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchFn(`${config.url}/v1/cc/decision/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret,
        "x-cc-version": PLUGIN_VERSION,
      },
      body: JSON.stringify({ requestId }),
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* fail open — the worker's liveness sweep expires the card */ }
}
