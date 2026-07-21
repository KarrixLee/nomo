// permission — the Claude Code PermissionRequest hold: answer a permission prompt from the phone.
//
// Wired into hooks.json as the PermissionRequest handler (dist/cc-permission.mjs). When a session is
// on the phone's Live Activity and remote approvals are enabled, the terminal dialog is held here
// while the phone decides; otherwise it falls straight through to the normal terminal dialog.
//
// CONTRACT — this module DELIBERATELY breaks the plugin's "2s, never block" rule that every other
// entry keeps (see hook.ts:12-14 and cc-watchdog.ts's header). Each individual fetch still has a 2s
// ceiling, but the TOTAL wait is unbounded: the hook polls until the phone answers, the request is
// expired/superseded server-side, sustained downlink failure trips the give-up cap, or the process is
// killed (Esc at the terminal). Fail-open is absolute — any network error, timeout, non-200, decrypt
// failure, or unpaired/misconfigured state exits 0 with NOTHING on stdout, so the terminal dialog
// appears and Claude is never blocked on our infrastructure. The ONLY thing ever written to stdout is
// a single PermissionRequest decision line on a genuine phone answer.
//
// PORTABILITY: runs unmodified under bun AND node >= 18 — no `Bun.*` APIs. build.ts bundles this into
// dist/cc-permission.mjs.

import { access, unlink } from "node:fs/promises";
import { appendFileSync, statSync, truncateSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import { runHook, buildBlob, OpPlan } from "./hook";
import { AgentKind, atomicWrite, CC_DIR, Config, loadConfig, PLUGIN_VERSION, readRecord, SessionRecord } from "./shared";
import { decryptBlob, encryptBlob } from "./crypto";

/** Local escape-hatch flag: when this file exists, the hook skips the hold entirely and behaves as a
 *  plain fire-and-forget attention event (instant terminal dialog). Toggled by `cc-permission off|on`. */
export const NO_HOLD_PATH = `${CC_DIR}/no-hold`;

/** How often to poll for the phone's answer while holding (ms). Small jitter is added per cycle. */
const POLL_INTERVAL_MS = 3_000;
/** Per-fetch ceiling for the poll GETs — the "2s" half of the contract survives; only the TOTAL wait
 *  is unbounded. */
const FETCH_TIMEOUT_MS = 2_000;
/** The initial decision POST is DELIBERATELY allowed to block (the 2s reflex is wrong here): the
 *  worker's decision route can legitimately take a few seconds (cold isolate, an APNs push on the
 *  request path, network variance), and a 2s ceiling starved every real hold into a fail-open exit
 *  before anyone could poll. Give ONLY this POST a generous deadline. */
const POST_TIMEOUT_MS = 15_000;
/** One retry of the initial POST on a timeout/network error (never on a non-ok HTTP status — that is a
 *  real answer). The retry re-POSTs the SAME requestId + blobs: the worker's supersede no-ops on an
 *  identical id and putDecision idempotently re-stores the pending record, so a re-POST after a first
 *  attempt that actually reached the worker is safe. */
const POST_MAX_ATTEMPTS = 2;
/** Pause before the single POST retry. */
const POST_RETRY_PAUSE_MS = 1_000;
/** A fresh session's FIRST permission prompt can fire BEFORE the phone app's ~3s poll has added the
 *  session to the worker's island shown-list, so the very first decision POST correctly comes back
 *  {hold:false} (session not shown yet) and the prompt falls open — even though the session lands in
 *  the shown set a second or two later. When the first POST says hold:false, wait this long and re-ask
 *  ONCE: a hold:false POST stores NO server record, so the re-POST is a fresh gate evaluation that now
 *  sees the shown session. Injectable via the sleep dep. */
const HOLD_RETRY_DELAY_MS = 4_000;
/** The auto-add race is only possible while a session is YOUNG: the app adds a session to the island
 *  within a second or two of its first hook, so only a session whose local SessionRecord is this fresh
 *  (or which has no record yet — brand-new, not even tracked) can still be mid-add when its first
 *  permission prompt fires. Older, established sessions that come back {hold:false} are genuinely not on
 *  the phone, so they must NOT pay the HOLD_RETRY_DELAY_MS tax on every prompt — they fall open at once. */
const FRESH_SESSION_MS = 60_000;
/** Give-up cap: this many consecutive polls without a 2xx (~5 min of sustained failure) → the worker
 *  is unreachable → exit silently (fail open, terminal dialog after Esc/retry). A successful poll —
 *  including a plain {status:"pending"} — resets the counter, so a healthy hold is unbounded. */
const MAX_CONSECUTIVE_MISSES = 100;

/** Serialize ONE PermissionRequest decision for the given agent's stdout contract. Both agents carry
 *  the identical `hookSpecificOutput` object; the ONLY difference is the transport envelope: Codex
 *  (0.144.1, verified in the Task 8 spike) requires a leading `"continue": true` wrapping the object,
 *  Claude Code consumes the bare object. `continue` is emitted FIRST, so the codex line matches the
 *  competitor-proven byte shape; and for claude the wrapper is absent, keeping every line BYTE-IDENTICAL
 *  to the pre-1.1 plugin (a plain allow / deny-without-message is indistinguishable on the wire). This
 *  single helper is the ENTIRE agent seam for the decision lines — every builder below routes through it. */
function decisionLine(agent: AgentKind, hookSpecificOutput: object): string {
  return JSON.stringify(agent === "codex" ? { continue: true, hookSpecificOutput } : { hookSpecificOutput });
}

/** The frozen inner objects (agent-agnostic). ALLOW_HSO / the no-message DENY_HSO stay the pre-1.1 shape;
 *  decisionLine("claude", …) reproduces the old ALLOW_LINE / DENY_LINE byte-for-byte. */
const ALLOW_HSO = { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } as const;
const DENY_HSO = { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Denied from phone" } } as const;
/** Cap the phone's custom deny message so a runaway string can't bloat the stdout line the agent parses. */
const DENY_MESSAGE_MAX = 500;

/** Plain allow. */
function allowLine(agent: AgentKind): string {
  return decisionLine(agent, ALLOW_HSO);
}

/** Deny with the phone's custom message; an absent/empty/whitespace-only message degrades to the frozen
 *  no-message DENY line (so a plain "Deny" tap stays byte-identical to the old wire for claude). */
function denyLine(agent: AgentKind, message?: unknown): string {
  const m = typeof message === "string" ? message.trim().slice(0, DENY_MESSAGE_MAX) : "";
  if (m.length === 0) return decisionLine(agent, DENY_HSO);
  return decisionLine(agent, { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: m } });
}

/** Allow + a session-scoped always-allow rule. CC's own `permission_suggestions` (already narrowly
 *  scoped — e.g. `Bash(bun test:*)`) are applied VERBATIM when present; otherwise a whole-tool session
 *  rule. `destination: "session"` ONLY — an over-broad grant dies with the session, never persisted to
 *  disk. Requires CC ≥ 2.0.54 (the `updatedPermissions` key); older CC ignores the extra key and
 *  degrades to a plain allow (safe: the tool still runs, just no rule is remembered). */
function allowAlwaysLine(agent: AgentKind, toolName: string, suggestions: unknown): string {
  const updatedPermissions = Array.isArray(suggestions) && suggestions.length > 0
    ? suggestions
    : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
  return decisionLine(agent, { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedPermissions } });
}

// ---- operational trace ---------------------------------------------------------------------
//
// The hold hook is a long-lived, silent process: when the terminal (or Claude Code) kills it, the
// fail-open contract means it dies with NOTHING on stdout and no log — which makes a hold that never
// polls impossible to diagnose from the outside (the worker just sees a POST and then silence). This
// append-only trace is the one exception: a single-line JSON event stream at TRACE_PATH recording the
// hook's lifecycle (stdin, POST, hold decision, every poll begin/end, the answer, and — crucially —
// the terminating signal). It never writes to stdout and every append is best-effort (a trace error is
// swallowed), so it cannot break the fail-open posture. A killed-by-SIGKILL hold leaves a trace that
// simply ENDS with no `exit-event` line: that silence is itself the diagnostic signature.

/** Append-only JSON trace of the permission hold lifecycle (one event per line). */
export const TRACE_PATH = `${CC_DIR}/permission-trace.log`;
/** Truncate the trace at startup once it passes this size, so it can never grow unbounded. */
const TRACE_MAX_BYTES = 256 * 1024;

/** Sync single-line append of `{ts, pid, ...event}`. Sync so a buffered write can't be lost when the
 *  process is killed mid-hold. Best-effort: any fs error is swallowed (tracing must never surface). */
function appendTrace(path: string, event: object): void {
  try {
    appendFileSync(path, `${JSON.stringify({ ts: Date.now(), pid: process.pid, ...event })}\n`, { mode: 0o600 });
  } catch { /* tracing is best-effort — never let it break the hook */ }
}

let traceRotated = false;
/** Truncate-once at process startup if the log has grown past the cap (append-only otherwise). */
function rotateTraceOnce(path: string): void {
  if (traceRotated) return;
  traceRotated = true;
  try {
    if (statSync(path).size > TRACE_MAX_BYTES) truncateSync(path, 0);
  } catch { /* missing file or stat error — nothing to rotate */ }
}

let signalHandlersInstalled = false;
/** The production trace sink: rotate-once, then a file appender — and, installed once per process,
 *  the signal/exit/error handlers that capture WHAT terminated the hold. Every handler records its
 *  cause then exits 0 with nothing on stdout, preserving the fail-open contract. SIGKILL cannot be
 *  caught, so a SIGKILLed hold simply leaves the trace with no `exit-event` line — the signature of an
 *  external hard kill. */
function defaultTrace(): (event: object) => void {
  rotateTraceOnce(TRACE_PATH);
  const trace = (event: object): void => appendTrace(TRACE_PATH, event);
  if (!signalHandlersInstalled) {
    signalHandlersInstalled = true;
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.on(sig, () => { trace({ event: "signal", signal: sig }); process.exit(0); });
    }
    process.on("uncaughtException", (e) => { trace({ event: "uncaughtException", error: String(e).slice(0, 200) }); process.exit(0); });
    process.on("unhandledRejection", (e) => { trace({ event: "unhandledRejection", error: String(e).slice(0, 200) }); process.exit(0); });
    process.on("exit", (code) => appendTrace(TRACE_PATH, { event: "exit-event", code }));
  }
  return trace;
}

/** A concise, human-readable one-liner describing what the tool wants to do — shown on the phone's
 *  card next to Allow/Deny. Pure (unit-tested); never throws (a bad URL etc. falls back to the query
 *  or the tool name). */
export function buildPermissionSummary(toolName: string, toolInput: Record<string, unknown>): string {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const truncate = (s: string, n = 80): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
  switch (toolName) {
    case "Bash":
    // Codex shell tools carry the command in the SAME tool_input.command field; the switch keys purely on
    // tool_name (Codex + Claude names never collide) so these are additive, not an agent branch.
    case "shell":
    case "local_shell": {
      const cmd = str(toolInput.command);
      return cmd ? truncate(cmd.split("\n")[0]) : toolName;
    }
    // Codex apply_patch approvals carry a human-readable summary in tool_input.description (there is no
    // single file_path — a patch can touch many files).
    case "apply_patch": {
      const desc = str(toolInput.description);
      return desc ? truncate(desc) : toolName;
    }
    case "Edit":
    case "Write":
    case "Read":
    case "NotebookEdit": {
      const fp = str(toolInput.file_path);
      return fp ? basename(fp) : toolName;
    }
    case "WebFetch":
    case "WebSearch": {
      const url = str(toolInput.url);
      if (url) {
        try { return new URL(url).host; } catch { /* not a URL — fall through to the query */ }
      }
      const query = str(toolInput.query);
      return query ? truncate(query) : toolName;
    }
    // ExitPlanMode fires a PermissionRequest carrying the whole plan in tool_input.plan (verified on CC
    // 2.1.216): the summary is a fixed prompt — the plan markdown itself rides in the detail field.
    case "ExitPlanMode":
      return "Approve Claude's plan";
    default: {
      if (/^mcp__/.test(toolName)) {
        const seg = toolName.split("__").pop();
        return seg && seg.length > 0 ? seg : toolName;
      }
      return toolName;
    }
  }
}

/** Fuller context for the phone card (the append-last `permissionDetail` blob field, shown under the
 *  one-line summary). Bash → the full command (ALL lines, unlike the first-line-only summary); the file
 *  tools → the full path; WebFetch/WebSearch → the full url or query; ExitPlanMode → the plan markdown;
 *  else "". Hard 400-char cap — this is the lowest-value blob field, so it truncates first if the sealed
 *  frame ever nears the worker's MAX_BLOB_CHARS ceiling (it doesn't, in practice — see the blob-size
 *  note at the seal site). Pure and never throws. */
export function buildPermissionDetail(toolName: string, toolInput: Record<string, unknown>): string {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const cap = (s: string): string => (s.length <= 400 ? s : `${s.slice(0, 399)}…`);
  switch (toolName) {
    case "Bash": case "shell": case "local_shell": { const c = str(toolInput.command); return c ? cap(c) : ""; }
    case "apply_patch": { const d = str(toolInput.description); return d ? cap(d) : ""; }
    case "Edit": case "Write": case "Read": case "NotebookEdit": {
      const fp = str(toolInput.file_path); return fp ? cap(fp) : "";
    }
    case "WebFetch": { const u = str(toolInput.url); return u ? cap(u) : ""; }
    case "WebSearch": { const q = str(toolInput.query); return q ? cap(q) : ""; }
    case "ExitPlanMode": { const p = str(toolInput.plan); return p ? cap(p) : ""; }
    default: return "";
  }
}

/** Apply the phone's decrypted answer for THIS request to stdout, returning true iff the hook should
 *  KEEP POLLING. The caller has already confirmed answer.requestId === requestId. Every decision this
 *  plugin version understands emits exactly one line and returns false (done); the ONLY keep-polling
 *  case is a decision verb we DON'T recognize (a newer phone talking to an older plugin) — we must never
 *  guess a line, so we swallow it and wait for one we know (fail-safe, symmetric with fail-open). */
function emitDecision(
  agent: AgentKind,
  answer: { decision?: unknown; message?: unknown },
  toolName: string,
  suggestions: unknown,
  emit: (line: string) => void,
  trace: (event: object) => void,
): boolean {
  switch (answer.decision) {
    case "allow":
      emit(allowLine(agent)); trace({ event: "emit", decision: "allow" }); return false;
    case "allow_always":
      emit(allowAlwaysLine(agent, toolName, suggestions)); trace({ event: "emit", decision: "allow_always" }); return false;
    case "deny":
      emit(denyLine(agent, answer.message));
      trace({ event: "emit", decision: "deny", hasMessage: typeof answer.message === "string" && answer.message.trim().length > 0 });
      return false;
    default:
      trace({ event: "answer-unknown-decision" }); return true; // future phone, old plugin — keep polling
  }
}

/** Injectable seams so permission.test.ts drives the state machine with a scripted fetch, an instant
 *  sleep, a deterministic requestId, and a temp flag path — no real stdin/network/timers. Production
 *  uses every default. */
export interface PermissionHookDeps {
  fetchFn?: typeof fetch;
  /** Reads the hook JSON from stdin. */
  readInput?: () => Promise<string>;
  loadConfigFn?: () => Promise<Config | null>;
  readRecordFn?: (sessionId: string) => Promise<SessionRecord | null>;
  sleep?: (ms: number) => Promise<void>;
  /** Writes the ONE decision line to stdout. Called only on a genuine phone answer. */
  emit?: (line: string) => void;
  now?: () => number;
  randomUUID?: () => string;
  /** Extra ms added to each poll interval so many concurrent holds don't poll in lockstep. */
  jitter?: () => number;
  noHoldPath?: string;
  /** The no-hold fire-and-forget path (defaults to the normal attention event via runHook). */
  delegate?: () => Promise<void>;
  pollIntervalMs?: number;
  /** Operational trace sink (one JSON event per call). Defaults to the append-only file appender at
   *  TRACE_PATH plus the signal/exit capture handlers; tests pass a collector or a noop so they touch
   *  neither the real filesystem nor global process handlers. */
  trace?: (event: object) => void;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function flagExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** The PermissionRequest hook body. See the module header for the (deliberately) unbounded-wait
 *  contract and the absolute fail-open posture. Never throws across its boundary.
 *
 *  `agent` (positional, defaulting to "claude" — the file's style, matching buildBlob/runHook) is the
 *  ENTIRE per-agent seam: it tags the blob (`agent:"codex"`), picks the no-hold delegate's target, and
 *  selects the decision-line envelope (Codex wraps in `continue:true`). Everything else — the POST/poll
 *  state machine, the gates, fail-open — is agent-agnostic. cc-permission calls it with the default;
 *  codex-permission calls it with "codex". */
export async function runPermissionHook(deps: PermissionHookDeps = {}, agent: AgentKind = "claude"): Promise<void> {
  const noHoldPath = deps.noHoldPath ?? NO_HOLD_PATH;
  const trace = deps.trace ?? defaultTrace();
  try {
    // Escape hatch FIRST (a file stat — no stdin consumed yet): if the user paused remote approvals
    // locally, behave exactly as the old fire-and-forget attention event (instant terminal dialog).
    // Delegating to runHook reuses the entire needs-attention pipeline (POST, tracking, watchdog) and
    // returns silently with exit 0 — it also no-ops cleanly when unpaired, so zero network in that case.
    if (await flagExists(noHoldPath)) {
      await (deps.delegate ?? (() => runHook(agent)))();
      return;
    }

    const [config, raw] = await Promise.all([
      (deps.loadConfigFn ?? loadConfig)(),
      (deps.readInput ?? readStdin)(),
    ]);
    trace({ event: "stdin-read", bytes: raw.length });
    if (!config) { trace({ event: "exit", reason: "unpaired" }); return; } // unpaired → exit 0, zero output, zero network

    const input = JSON.parse(raw) as Record<string, unknown>;
    const sessionId = typeof input.session_id === "string" ? input.session_id : "";
    if (sessionId.length === 0) { trace({ event: "exit", reason: "no-session-id" }); return; }

    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const agentId = typeof input.agent_id === "string" ? input.agent_id : "";
    const permissionMode = typeof input.permission_mode === "string" ? input.permission_mode : undefined;
    trace({ event: "start", session_id: sessionId, tool_name: toolName, permission_mode: permissionMode, agent: agentId.length > 0 });

    // PASS-THROUGH GATES — the hold must never block a non-interactive/auto flow. Both exit 0 with zero
    // output and zero network, so the normal permission flow applies (auto-approval rules still fire; a
    // dialog shows only if it would have anyway).
    //
    // 1. Subagent gate: `agent_id` is present ONLY inside a Task-tool sidechain (the documented way to
    //    tell a subagent call from a main-thread one). Subagent asks are not human-facing here — never hold.
    if (agentId.length > 0) {
      const agentType = typeof input.agent_type === "string" ? input.agent_type : undefined;
      trace({ event: "exit", reason: "subagent", agent_type: agentType });
      return;
    }
    // 2. Mode gate: hold ONLY for the interactive dialog modes — "default", "acceptEdits", "plan" — and
    //    for an absent/non-string mode (older CC versions: preserve prior behavior). In "auto" the
    //    PermissionRequest path runs even when NO dialog would show, so the hook can't tell "would
    //    auto-run" from "would prompt" — it must not hold. "dontAsk"/"bypassPermissions" never prompt.
    //    Any unrecognized future value falls open too (fail-open bias).
    if (permissionMode !== undefined && permissionMode !== "default" && permissionMode !== "acceptEdits" && permissionMode !== "plan") {
      trace({ event: "exit", reason: "mode", mode: permissionMode });
      return;
    }
    // 3. Question gate: CC fires a PermissionRequest for AskUserQuestion too, but a bare Allow/Deny card
    //    is the WRONG surface for a multi-option question (Allow would just re-show the terminal picker).
    //    Until the question-answering wave (option buttons + answer injection) ships, delegate to the
    //    exact fire-and-forget needs-attention path the no-hold flag uses: an attention buzz on the
    //    phone, answer at the Mac. Placed AFTER the mode gate so an auto-mode question never even
    //    delegates (it fell open above). Runs BEFORE any POST/blob build. CLAUDE-ONLY in practice: Codex
    //    has no AskUserQuestion tool, so this never fires for a codex session — the delegate still
    //    threads `agent` for correctness if it ever did.
    if (toolName === "AskUserQuestion") {
      trace({ event: "exit", reason: "question-passthrough" });
      await (deps.delegate ?? (() => runHook(agent)))();
      return;
    }
    const toolInput = typeof input.tool_input === "object" && input.tool_input !== null
      ? (input.tool_input as Record<string, unknown>)
      : {};
    // CC's own narrowly-scoped rule suggestions (present on the PermissionRequest when it has them);
    // passed through VERBATIM by allowAlwaysLine on an always-allow answer. Absent → whole-tool rule.
    const suggestions = input.permission_suggestions;
    const requestId = (deps.randomUUID ?? (() => crypto.randomUUID()))();
    const summary = buildPermissionSummary(toolName, toolInput);
    const now = (deps.now ?? Date.now)();
    const fetchFn = deps.fetchFn ?? fetch;

    // Build the SAME session frame the normal hook would (reuse buildBlob + the record the working
    // hooks already wrote), then seal TWO variants: `blob` carries status "decisionPending" plus the
    // permission fields appended LAST (the iOS decoder's append-only discipline; spread-override keeps
    // `status` in its original key position), and `fallbackBlob` is the untouched plain needsAttention
    // frame the worker stores when it declines the hold — so clients that never opted in never see the
    // new status. The worker is blind and can read neither; it just picks one.
    //
    // Append order is FROZEN: permissionSummary, permissionRequestId, permissionToolName, then the
    // OPTIONAL permissionDetail (omitted when empty — never an empty string, matching every other
    // optional blob key). permissionToolName lets the phone key card layout off the tool; permissionDetail
    // is the fuller sub-line. BLOB SIZE: the worker rejects a decision POST whose base64 `blob` exceeds
    // MAX_BLOB_CHARS (3072) — enforced server-side, NOT here (encryptBlob never hard-fails on size). The
    // detail's hard 400-char cap keeps even a worst-case frame (400-char detail + 80-char summary + a long
    // title) far under that ceiling (~1.2 KB base64; overflow needs ~2.3 KB of plaintext), so no local
    // truncation beyond the cap is needed; if that ever changed, permissionDetail is the field to shed.
    const record = await (deps.readRecordFn ?? readRecord)(sessionId);
    const machine = config.machineName ?? hostname().replace(/\.local$/, "");
    const plan: OpPlan = { op: "update", prio: 1, status: "needsAttention" };
    const base = buildBlob(input, machine, record?.title, plan, agent, record?.turnStartedAt, record?.label, record?.model);
    const detail = buildPermissionDetail(toolName, toolInput);
    const blob = await encryptBlob(config.e2eKey, {
      ...base, status: "decisionPending", permissionSummary: summary, permissionRequestId: requestId,
      permissionToolName: toolName,
      ...(detail.length > 0 ? { permissionDetail: detail } : {}),
    });
    const fallbackBlob = await encryptBlob(config.e2eKey, base);

    const pcHeaders = { "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret, "x-cc-version": PLUGIN_VERSION };
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    // The initial POST is the one place this hook is ALLOWED to block: give it POST_TIMEOUT_MS and one
    // retry on a timeout/network error (a non-ok HTTP status is a real answer — never retried). Any HTTP
    // response ends the loop; only both attempts failing at the transport layer fails open. `round` (1 =
    // initial, 2 = post-race re-ask) is threaded through the trace alongside `attempt` (the per-round
    // transport retry) so both rounds are legible in the log.
    const postDecision = async (round: number, maxAttempts: number): Promise<{ posted: boolean; hold: boolean }> => {
      let hold = false;
      let posted = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const res = await fetchFn(`${config.url}/v1/cc/decision`, {
            method: "POST",
            headers: { "content-type": "application/json", ...pcHeaders },
            body: JSON.stringify({ v: 2, sessionId, requestId, op: "update", prio: 1, ts: now, blob, fallbackBlob }),
            signal: AbortSignal.timeout(POST_TIMEOUT_MS),
          });
          trace({ event: "posted", requestId, round, attempt, status: res.status });
          if (res.ok) hold = ((await res.json()) as { hold?: unknown }).hold === true;
          posted = true;
          break; // any HTTP response (ok or not) is a real answer — do not retry
        } catch (e) {
          trace({ event: "posted", requestId, round, attempt, status: 0, error: (e as { name?: string })?.name ?? "Error" });
          if (attempt < maxAttempts) { await sleep(POST_RETRY_PAUSE_MS); continue; } // retry the timed-out/failed POST once
        }
      }
      return { posted, hold };
    };

    let { posted, hold } = await postDecision(1, POST_MAX_ATTEMPTS);
    if (!posted) { trace({ event: "exit", reason: "post-error" }); return; } // both attempts failed at the transport → fail open
    trace({ event: "hold", hold });
    if (!hold) {
      // hold:false on the FIRST ask is usually genuine (session not on the phone), but a brand-new
      // session's first prompt can lose a race with the app's island auto-add. Re-ask ONLY when that
      // race is still possible — no local record yet, or the record is younger than FRESH_SESSION_MS;
      // an established session that says hold:false is genuinely off the phone and exits AT ONCE (no 4s
      // tax on every prompt).
      const fresh = !record || (now - record.ts) < FRESH_SESSION_MS;
      if (!fresh) { trace({ event: "exit", reason: "hold-false" }); return; } // established session → instant terminal dialog
      // Wait once, then re-POST the SAME requestId/blobs (single attempt, no transport retry): a
      // hold:false POST stored no record, so this is a clean fresh gate evaluation. hold:true now → the
      // session showed up, fall through to the poll loop; still hold:false (or a transport error) → the
      // genuine fall-open.
      trace({ event: "hold-retry-wait", delayMs: HOLD_RETRY_DELAY_MS });
      await sleep(HOLD_RETRY_DELAY_MS);
      const retry = await postDecision(2, 1);
      if (!retry.posted) { trace({ event: "exit", reason: "hold-false" }); return; } // re-ask failed at transport → fall open
      hold = retry.hold;
      trace({ event: "hold", hold });
      if (!hold) { trace({ event: "exit", reason: "hold-false" }); return; } // still not shown → worker applied the attention update → terminal dialog
    }

    // HOLD: poll until the phone answers, the request leaves "pending", sustained failure trips the
    // give-up cap, or we're killed. Each fetch keeps its own 2s ceiling; transient failures are
    // tolerated (keep polling). A decrypt failure or requestId mismatch exits silently (fail open).
    const jitter = deps.jitter ?? (() => Math.floor(Math.random() * 500));
    const interval = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    const emit = deps.emit ?? ((line: string) => process.stdout.write(`${line}\n`));
    let misses = 0;
    let seq = 0;
    for (;;) {
      seq += 1;
      // poll-begin/poll-end straddle the fetch so an abort or kill MID-FETCH is visible: a begin with
      // no matching end means the process died inside the GET (the prime suspect for a hold that
      // never completes its first poll).
      trace({ event: "poll-begin", seq });
      let data: { status?: string; answerBlob?: string } | undefined;
      try {
        const res = await fetchFn(`${config.url}/v1/cc/decision/${requestId}`, {
          headers: pcHeaders,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.ok) {
          data = (await res.json()) as { status?: string; answerBlob?: string };
          trace({ event: "poll-end", seq, outcome: "ok" });
        } else {
          trace({ event: "poll-end", seq, outcome: "status", status: res.status });
        }
      } catch (e) { // transient — counted below, kept polling until the cap
        trace({ event: "poll-end", seq, outcome: "error", error: (e as { name?: string })?.name ?? "Error" });
      }

      if (data) {
        misses = 0;
        if (data.status === "answered" && typeof data.answerBlob === "string") {
          // A decrypt failure here throws to the outer catch → silent exit 0 (fail open), never a retry.
          const answer = (await decryptBlob(config.e2eKey, data.answerBlob)) as
            { requestId?: unknown; decision?: unknown; message?: unknown };
          const match = answer.requestId === requestId;
          // A matched, KNOWN decision emits one line and we're done; a requestId MISMATCH is a
          // replay/stale answer (silent, done — unchanged). The one keep-polling case is a matched but
          // UNRECOGNIZED decision verb (newer phone, older plugin): emitDecision returns true, we skip
          // the return and fall through to the sleep so a decision we DO understand can still land.
          const keepPolling = match && emitDecision(agent, answer, toolName, suggestions, emit, trace);
          if (!keepPolling) {
            trace({ event: "answered", match });
            trace({ event: "exit", reason: "answered" });
            return; // answered (known decision) or mismatch → done, exactly one or zero lines emitted
          }
          // else: unknown decision — keep polling (do NOT return, do NOT treat "answered" as terminal)
        } else if (typeof data.status === "string" && data.status !== "pending") {
          trace({ event: data.status === "expired" ? "expired" : "superseded", status: data.status });
          trace({ event: "exit", reason: data.status });
          return; // expired/superseded/unknown → silent
        }
      } else if (++misses >= MAX_CONSECUTIVE_MISSES) {
        trace({ event: "giveup", misses });
        trace({ event: "exit", reason: "giveup" });
        return; // sustained downlink failure → fail open silently
      }
      await sleep(interval + jitter());
    }
  } catch (e) {
    // Silence + exit 0 is the contract — never surface into a Claude Code session, never block.
    trace({ event: "exit", reason: "exception", error: String(e).slice(0, 200) });
  }
}

// ---- local escape-hatch command (off/on/status) -------------------------------------------

export interface ApprovalsDeps {
  noHoldPath?: string;
  print?: (line: string) => void;
}

/** `cc-permission off|on|status`: toggle/report the local no-hold flag. `off` pauses remote approvals
 *  (creates the flag → prompts stay in the terminal); `on` resumes them (removes the flag); `status`
 *  reports which. Always exits 0. */
export async function approvalsCommand(sub: "off" | "on" | "status", deps: ApprovalsDeps = {}): Promise<number> {
  const path = deps.noHoldPath ?? NO_HOLD_PATH;
  const print = deps.print ?? ((line: string) => console.log(line));
  const exists = async () => {
    try { await access(path); return true; } catch { return false; }
  };
  if (sub === "off") {
    await atomicWrite(path, "", 0o600);
    print("Remote approvals are OFF for this computer — Claude Code permission prompts will appear in the terminal as usual (your phone is not asked).");
    return 0;
  }
  if (sub === "on") {
    await unlink(path).catch(() => {}); // already on / never set — fine
    print("Remote approvals are ON for this computer — when a session is on your phone's Live Activity, its permission prompts are sent to the phone to Allow or Deny.");
    return 0;
  }
  // status
  print(await exists()
    ? "Remote approvals: OFF (paused locally) — permission prompts appear in the terminal. Run `on` to resume."
    : "Remote approvals: ON — permission prompts for phone-attached sessions are sent to your phone. Run `off` to pause them here.");
  return 0;
}
