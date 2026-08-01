// permission — the Claude Code PermissionRequest hold: answer a permission prompt from the phone.
//
// Wired into hooks.json as the PermissionRequest handler (dist/cc-permission.mjs). When a session is
// on the phone's Live Activity and remote approvals are enabled, the terminal dialog is held here
// while the phone decides; otherwise it falls straight through to the normal terminal dialog.
//
// CONTRACT — this module DELIBERATELY breaks the plugin's "2s, never block" rule that every other
// entry keeps (see hook.ts:12-14 and cc-watchdog.ts's header). Every poll fetch still has a 2s ceiling
// and the one blocking POST has a 4s one (so a dead network costs ~6s BEFORE the dialog, never the ~33s
// the old 15s×2 ceiling cost — see POST_FIRST_CONTACT_TIMEOUT_MS), but the TOTAL wait ONCE A HOLD IS
// GRANTED is unbounded: the hook polls until the phone answers, the request is
// expired/superseded server-side, sustained downlink failure trips the give-up cap, or the process is
// killed (Esc at the terminal). Fail-open is absolute — any network error, timeout, non-200, decrypt
// failure, or unpaired/misconfigured state exits 0 with NOTHING on stdout, so the terminal dialog
// appears and Claude is never blocked on our infrastructure. The ONLY thing ever written to stdout is
// a single PermissionRequest decision line on a genuine phone answer.
//
// PORTABILITY: runs unmodified under bun AND node >= 18 — no `Bun.*` APIs. build.ts bundles this into
// dist/cc-permission.mjs.

import { readFile, realpath, unlink } from "node:fs/promises";
import { appendFileSync, statSync, truncateSync } from "node:fs";
import { hostname } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { runHook, buildBlob, OpPlan } from "./hook";
import {
  AgentKind, atomicWrite, BLOB_FIT_CHARS, CC_DIR, clearDecisionHold, codexHome, Config, DecisionHold, flagExists,
  fullTextForRecord, loadConfig, NO_HOLD_PATH,
  PLUGIN_VERSION, readPrefix, readRecord, readSuffix, sealedBlobChars, SessionRecord, stampPermissionDetailFull,
  writeDecisionHold,
} from "./shared";
import { b64url, decryptBlob, deriveLanKey, encryptBlob } from "./crypto";
// The relay's timing/give-up rules, shared verbatim with the Codex relay (codex-remote-input.ts) that
// polls the SAME route with the same credentials. See decision-poll.ts for what is deliberately NOT
// shared — the first-contact POST ceiling, which each caller bounds by what IT blocks.
import {
  DEFINITIVE_POLL_STATUSES, MAX_CONSECUTIVE_MISSES, MAX_DEFINITIVE_POLL_FAILURES, POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS, POST_MAX_ATTEMPTS, POST_RETRY_PAUSE_MS,
} from "./decision-poll";
// The PURE wire contract only — deliberately NOT "./lan-listener": this hook is a short-lived process
// spawned on every permission prompt and must not bundle (or load node:http for) an HTTP server it can
// never start. See lan-wire.ts's header.
import {
  LAN_ENVELOPE_VERSION, LAN_PATH, LAN_STATE_PATH, lanRunningUnderTest, parseLanState,
} from "./lan-wire";

/** Local escape-hatch flag: when this file exists, the hook skips the hold entirely and behaves as a
 *  plain fire-and-forget attention event (instant terminal dialog). Toggled by `cc-permission off|on`.
 *  DEFINED IN shared.ts (every /cc/event POSTer reports it as the `x-cc-approvals` header, and a
 *  shared.ts → permission.ts import would be a cycle); re-exported here, where it is toggled, so
 *  existing importers are unaffected. */
export { BLOB_FIT_CHARS, NO_HOLD_PATH, sealedBlobChars };

/** FIRST-CONTACT ceiling for the decision POST — the ONE fetch the terminal dialog waits behind before
 *  it is either held (phone card up) or released (normal dialog). It is deliberately LONGER than the
 *  poll's 2s (the worker's decision route can take a moment: cold isolate, KV reads, the gate checks)
 *  and deliberately MUCH SHORTER than the 15s it used to be.
 *
 *  WHY IT SHRANK: at 15s × POST_MAX_ATTEMPTS + POST_RETRY_PAUSE_MS + the 2s did-it-land probe, a
 *  captive portal / hung proxy / half-open TCP froze the terminal for ~33s on EVERY permission prompt
 *  (~50s on the fresh-session re-ask path) — a hostile failure mode for a hook whose whole contract is
 *  "never block on our infrastructure". A worker that is reachable at all answers this route in well
 *  under a second; a stall past a few seconds means the network is gone, and the only useful thing to do
 *  with that answer is fail open NOW.
 *
 *  WORST-CASE PRE-DIALOG BLOCK, stalled network: POST_FIRST_CONTACT_TIMEOUT_MS (4s) + POLL_TIMEOUT_MS
 *  (2s did-it-land probe) ≈ 6s, because a TIMEOUT is never retried (see POST_MAX_ATTEMPTS). A network
 *  that fails FAST (connection refused, DNS NXDOMAIN) costs ~0 + POST_RETRY_PAUSE_MS + ~0 + 2s ≈ 3s.
 *  Both stay under the ~10s bar. The fresh-session re-ask (HOLD_RETRY_DELAY_MS + one more short POST)
 *  rides on top of that, but ONLY on the path where the worker already ANSWERED — i.e. it is reachable,
 *  so it is never the dead-network case. Once a hold IS granted the wait becomes unbounded ON PURPOSE
 *  (the phone owns the dialog) and every fetch from there on is a 2s poll GET. */
const POST_FIRST_CONTACT_TIMEOUT_MS = 4_000;
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
/** How many times the SAME terminal `answered` record may be re-read with a decision verb we do not
 *  recognize before the hold is released. An answered record is TERMINAL server-side (a re-answer 409s
 *  and the same blob is served for the record's whole 24h TTL), so a verb we can never understand would
 *  otherwise be re-read until the hook's 86400 s timeout — a frozen terminal and ~26k doomed GETs. A
 *  small bound keeps genuine forward-compat polling (a record still `pending`, or a DIFFERENT answer
 *  landing) while making the stuck case fail open in seconds. */
const MAX_UNKNOWN_ANSWER_READS = 3;

/** Codex maps both a manual reviewer and "Approve for me" to hook `permission_mode:"default"`.
 *  The effective reviewer/policy lives only in the current rollout's `turn_context`, so inspect a
 *  bounded tail of that exact task before deciding whether Nomo should intercept the prompt. */
const CODEX_POLICY_TAIL_BYTES = 8 * 1024 * 1024;
const CODEX_ROLLOUT_HEAD_BYTES = 1024 * 1024;

export interface CodexTurnPolicy {
  approvalPolicy?: unknown;
  approvalsReviewer?: string;
  sandboxType?: string;
  permissionProfileType?: string;
}

/** Parse the LAST turn_context for this exact turn. A newer context from another turn must not leak
 *  across the boundary, while a duplicate for the same turn (for example after compaction) wins. */
export function codexTurnPolicyFromRollout(text: string, turnId: string): CodexTurnPolicy | null {
  if (turnId.length === 0) return null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes("turn_context") || !line.includes(turnId)) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    if (record.type !== "turn_context") continue;
    const payload = record.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const context = payload as Record<string, unknown>;
    if (context.turn_id !== turnId) continue;
    const sandbox = typeof context.sandbox_policy === "object" && context.sandbox_policy !== null
      ? context.sandbox_policy as Record<string, unknown>
      : undefined;
    const profile = typeof context.permission_profile === "object" && context.permission_profile !== null
      ? context.permission_profile as Record<string, unknown>
      : undefined;
    return {
      approvalPolicy: context.approval_policy,
      approvalsReviewer: typeof context.approvals_reviewer === "string" ? context.approvals_reviewer : undefined,
      sandboxType: typeof sandbox?.type === "string" ? sandbox.type : undefined,
      permissionProfileType: typeof profile?.type === "string" ? profile.type : undefined,
    };
  }
  return null;
}

/** Session id from the rollout's first session_meta row, used to ensure hook input cannot point this
 *  local reader at a different task's rollout. */
export function codexRolloutSessionId(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (!line.includes("session_meta")) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    if (record.type !== "session_meta") continue;
    const id = (record.payload as Record<string, unknown> | undefined)?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }
  return undefined;
}

/** Read only a real rollout beneath this Codex home's sessions directory. Best-effort: an old Codex
 *  build, a missing path, or an unreadable/truncated file yields null and preserves manual routing. */
export async function loadCodexTurnPolicy(
  transcriptPath: string, turnId: string, sessionId: string, home: string = codexHome(),
): Promise<CodexTurnPolicy | null> {
  if (!transcriptPath || !turnId || !sessionId || !basename(transcriptPath).match(/^rollout-.*\.jsonl$/)) return null;
  try {
    const sessionsRoot = await realpath(resolve(home, "sessions"));
    const rollout = await realpath(transcriptPath);
    const rel = relative(sessionsRoot, rollout);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    const head = await readPrefix(rollout, CODEX_ROLLOUT_HEAD_BYTES);
    if (codexRolloutSessionId(head) !== sessionId) return null;
    return codexTurnPolicyFromRollout(await readSuffix(rollout, CODEX_POLICY_TAIL_BYTES), turnId);
  } catch {
    return null;
  }
}

function codexPassThroughReason(
  policy: CodexTurnPolicy | null,
): "codex-auto-review" | "codex-full-access" | "codex-context-unknown" | undefined {
  // Returning control to Codex is fail-open for Nomo, NOT an approval: Codex's native reviewer/dialog
  // remains authoritative. Hold only when the exact context positively identifies a manual flow.
  if (!policy) return "codex-context-unknown";
  if (policy.approvalPolicy === "never") return "codex-full-access";
  const guardianReviewer = policy.approvalsReviewer === "auto_review" || policy.approvalsReviewer === "guardian_subagent";
  const reviewablePolicy = policy.approvalPolicy === "on-request"
    || policy.approvalPolicy === "granular"
    || (typeof policy.approvalPolicy === "object" && policy.approvalPolicy !== null);
  if (guardianReviewer && reviewablePolicy) return "codex-auto-review";
  // `untrusted` does not use Codex's automatic reviewer even if the configured reviewer says auto.
  if (policy.approvalPolicy === "untrusted" || policy.approvalsReviewer === "user") return undefined;
  return "codex-context-unknown";
}

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
/** The same bound on the phone's ANSWER string (symmetry with DENY_MESSAGE_MAX — a runaway phone string
 *  must never become an unbounded stdout line). Unlike a deny message, a truncated answer is USELESS:
 *  it can no longer re-match an option label, so it takes the silent-release path instead of being sent
 *  in mangled form. 500 is far above any legitimate answer — a 4-option multi-select of 60-char capped
 *  labels is ~250 chars. */
const ANSWER_MAX = 500;

/** What the hook must do with the phone's answer. A boolean cannot express this: "nothing was emitted"
 *  and "keep waiting" are DIFFERENT outcomes, and conflating them is what made a question's bare allow
 *  either a hard deny or an infinite poll. */
type DecisionOutcome =
  /** One decision line went to stdout — the hold is over. */
  | "emitted"
  /** NOTHING was emitted and the hold is over: the hook exits 0 silently, so CC proceeds with its own
   *  flow and shows the terminal picker ("answer at your Mac"). Used whenever a KNOWN verb cannot be
   *  honored for this tool — it can never be converted into a deny on any path. */
  | "released"
  /** An UNRECOGNIZED decision verb (a newer phone against an older plugin): swallow it and wait for one
   *  we understand. The ONLY case that keeps the hold open. */
  | "keep-polling";

/** Plain allow. EXCEPTION — ExitPlanMode (NOM-36): CC ignores a bare {behavior:"allow"} for the
 *  plan-exit approval — deny works (the plan is rejected) but a bare allow is a NO-OP: the plan is
 *  never approved and the session stays in plan mode. The fix echoes the tool's ORIGINAL input back
 *  via `updatedInput` — the same thing the open-vibe-island reference does for EVERY allow
 *  (BridgeServer's `updatedInput ?? payload.toolInput`). The echo is scoped to ExitPlanMode so every
 *  OTHER tool's allow stays BYTE-IDENTICAL to the frozen ALLOW line (decisionLine reproduces the
 *  pre-1.1 wire). The plugin already holds the original tool_input from stdin, so nothing new has to
 *  travel from the phone — the phone still just answers "allow". */
function allowLine(agent: AgentKind, toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === "ExitPlanMode") {
    return decisionLine(agent, { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: toolInput } });
  }
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
 *  disk.
 *
 *  CODEX COMPATIBILITY: Codex currently reserves `updatedPermissions` and rejects the ENTIRE hook
 *  decision when that field is present. A stale phone build may still offer "Always allow" for a Codex
 *  row, so fail safely to the supported plain-allow envelope instead of emitting a decision Codex drops
 *  and then showing a second approval dialog. The phone also keys its current-agent action policy from
 *  the encrypted `agent:"codex"` blob field and hides the unsupported persistent option. */
function allowAlwaysLine(agent: AgentKind, toolName: string, toolInput: Record<string, unknown>, suggestions: unknown): string {
  if (agent === "codex") return allowLine(agent, toolName, toolInput);
  const updatedPermissions = Array.isArray(suggestions) && suggestions.length > 0
    ? suggestions
    : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
  // ExitPlanMode needs the same updatedInput echo as the plain allow (see allowLine / NOM-36) or the
  // approval no-ops. Key order matches the reference: behavior, updatedInput, updatedPermissions.
  const decision = toolName === "ExitPlanMode"
    ? { behavior: "allow", updatedInput: toolInput, updatedPermissions }
    : { behavior: "allow", updatedPermissions };
  return decisionLine(agent, { hookEventName: "PermissionRequest", decision });
}

/** Allow + the phone's ANSWER to an AskUserQuestion, injected through `updatedInput`.
 *
 *  Verified against the shipped Claude Code bundle (v2.1.219, same code in 2.1.214+): the decision path
 *  drops a bare allow for any tool whose `requiresUserInteraction()` is true — AskUserQuestion,
 *  ExitPlanMode and the Cowork role picker — and falls through to the interactive picker. Supplying
 *  `updatedInput` is what makes CC skip its own ask and run the tool with OUR input; AskUserQuestion's
 *  schema declares `answers` ("User answers collected by the permission component"), so the tool body is
 *  then a pass-through. Two load-bearing details: the input is a `strictObject` (only questions/answers/
 *  annotations/metadata, `questions` required) — so the original tool_input is echoed VERBATIM and only
 *  `answers` is added — and the map is keyed by QUESTION TEXT, valued by an option LABEL. Multi-select
 *  needs no special case: CC's schema pre-processes the "A, B" joined form, which is exactly what the
 *  phone sends for a multi-select question.
 *
 *  FAIL-SAFE (the reason this returns `undefined` instead of degrading): on CC's HEADLESS path a bare
 *  {behavior:"allow"} on these tools converts to a hard DENY. So anything we cannot turn into a real
 *  answers map — a non-question tool, a missing/!array/empty `answers`, entries that resolve to nothing,
 *  DUPLICATE question texts, or an answers map that does not cover EVERY question — must emit NOTHING and
 *  RELEASE the hold (silent exit 0 → CC shows the terminal picker). Never a bare allow, never a guessed
 *  label, and never a partial map. */
function answerLine(
  agent: AgentKind,
  toolName: string,
  toolInput: Record<string, unknown>,
  answers: unknown,
): string | undefined {
  if (toolName !== "AskUserQuestion" || !Array.isArray(answers)) return undefined;
  // Zipped against the SAME usable-question list that built `permissionQuestions`, so index i of the
  // phone's array is index i of what the phone was SHOWN — a skipped entry can never shift the mapping.
  // The key is the ORIGINAL, untruncated question text (the blob's copy may be capped).
  const questions = usableQuestions(toolInput);
  if (questions.length === 0) return undefined;
  // DUPLICATE QUESTION TEXT: the map CC consumes is keyed by question text, so two questions carrying the
  // identical string collapse onto ONE key — the later answer overwrites the earlier and one question is
  // silently answered with the other's pick. Nothing on the wire can disambiguate them (the key IS the
  // text), so the payload is unanswerable: release, exactly like an ambiguous option label.
  if (new Set(questions.map((q) => q.text)).size !== questions.length) return undefined;
  const map: Record<string, string> = {};
  for (let i = 0; i < questions.length; i += 1) {
    const a = answers[i];
    // A question left WITHOUT an answer (missing/non-string/blank entry) would make the map PARTIAL. CC's
    // behavior on a partial `answers` map is unverified — the tool body is a pass-through, so a missing
    // key could be read as an empty pick — and guessing wrong tells the user's session something they
    // never said. Same policy as every other unrepresentable answer: release to the terminal picker.
    if (typeof a !== "string") return undefined;
    const raw = a.trim();
    if (raw.length === 0) return undefined;
    // Bound the stdout line — by REFUSING, never by slicing. Truncating at ANSWER_MAX can land exactly
    // on a multi-select ", " boundary such that what SURVIVES is itself a valid but SHORTER real
    // selection (e.g. a 495-char label + ", Yes and more" slices to "<label>, Yes"), which would tell
    // CC the user picked something they never picked. An answer we cannot represent EXACTLY is
    // unanswerable, so release the hold and let the terminal picker handle it — same rule as an
    // unmatchable label below.
    if (raw.length > ANSWER_MAX) return undefined;
    const resolved = resolveAnswer(raw, questions[i].labels);
    // An answer we cannot pin to exactly one REAL option is unanswerable: sending a guess (or the
    // phone's capped echo) would tell CC the user picked something they never picked. Release instead.
    if (resolved === undefined) return undefined;
    map[questions[i].text] = resolved;
  }
  // Every question answered, or nothing goes out (the loop above already released on the first gap; this
  // is the invariant stated as an assertion — an empty map can never be a bare allow either).
  if (Object.keys(map).length !== questions.length) return undefined;
  return decisionLine(agent, {
    hookEventName: "PermissionRequest",
    decision: { behavior: "allow", updatedInput: { ...toolInput, answers: map } },
  });
}

/** Map ONE question's answer string from the phone back onto that question's ORIGINAL option labels.
 *
 *  WHY this exists: the blob carries labels CAPPED at QUESTION_LABEL_MAX, so a long label reaches the
 *  phone with an ellipsis and comes back in that capped form. A label is an IDENTIFIER to CC (`answers`
 *  is validated against the tool's own options), not prose — echoing the capped string would silently
 *  change what the user chose. So every piece is re-matched to the full original and the ORIGINAL is
 *  what goes on the wire.
 *
 *  The whole string is tried as a single label FIRST, so an option label that itself contains a comma
 *  still round-trips; only then is the multi-select "A, B" form split. A piece that matches zero — or
 *  ambiguously more than one — original label makes the whole question unanswerable (`undefined`), which
 *  the caller turns into a silent release rather than a guess. */
function resolveAnswer(answer: string, labels: string[]): string | undefined {
  const matchOne = (piece: string): string | undefined => {
    // Accept the capped wire form AND the untruncated original (a phone that echoes the real label).
    const hits = Array.from(new Set(labels.filter((l) =>
      l === piece || capPermissionWireText(l, PERMISSION_QUESTION_LABEL_MAX) === piece
    )));
    return hits.length === 1 ? hits[0] : undefined;
  };
  const whole = matchOne(answer);
  if (whole !== undefined) return whole;
  const pieces = answer.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (pieces.length === 0) return undefined;
  const mapped: string[] = [];
  for (const piece of pieces) {
    const hit = matchOne(piece);
    if (hit === undefined) return undefined; // one bad piece poisons the whole answer — never partially apply
    mapped.push(hit);
  }
  return mapped.join(", "); // CC's schema pre-processes exactly this joined form for multi-select
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

/** The ONLY thing an error is ever allowed to contribute to the trace: its CLASS and, when present, its
 *  `code` (an errno-style token like "ECONNREFUSED"). NEVER `String(e)` / `e.message` — the messages that
 *  reach this hook quote their INPUT, and this hook's input is the raw hook payload: a `JSON.parse`
 *  SyntaxError embeds the offending JSON (a Bash command with a token in it, a plan, a file path) into
 *  permission-trace.log, a plaintext file on disk. A name plus a code is enough to classify a failure. */
function errorTag(e: unknown): { error: string; code?: string } {
  const name = typeof (e as { name?: unknown })?.name === "string" ? (e as { name: string }).name : typeof e;
  const code = (e as { code?: unknown })?.code;
  return { error: name, ...(typeof code === "string" ? { code } : {}) };
}

/** The reported byte offset of a JSON syntax error, or undefined — DIGITS ONLY, extracted with a regex
 *  that cannot capture any surrounding text. Enough to locate a truncated stdin without logging it. */
function parseErrorPosition(e: unknown): number | undefined {
  const m = typeof (e as { message?: unknown })?.message === "string"
    ? /position (\d+)/.exec((e as { message: string }).message)
    : null;
  return m ? Number(m[1]) : undefined;
}

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
    // Class + code only (errorTag) — never the message: an error that escaped this far can still be a
    // parse/validation error quoting the raw hook payload, and the trace is a plaintext file.
    process.on("uncaughtException", (e) => { trace({ event: "uncaughtException", ...errorTag(e) }); process.exit(0); });
    process.on("unhandledRejection", (e) => { trace({ event: "unhandledRejection", ...errorTag(e) }); process.exit(0); });
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
    // AskUserQuestion holds like any other tool now: the summary is the FIRST question's text (CC sends
    // 1–4; the phone's card leads with it), the option list rides separately in `permissionQuestions`.
    case "AskUserQuestion": {
      const q = str(firstQuestionText(toolInput));
      return q ? truncate(q) : toolName;
    }
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
 *  tools → the full path; WebFetch/WebSearch → the full url or query; ExitPlanMode → the WHOLE plan
 *  markdown; else "". NOT length-capped here (it used to be a flat 400 chars, which silently amputated
 *  every plan-mode plan — NOM-38): the only real ceiling is the sealed frame's, and `fitPermissionDetail`
 *  applies exactly that at the seal site, keeping as much text as the wire can carry and reporting how
 *  much it had to drop. `MAX_DETAIL_CHARS` is only a sanity bound so a pathological tool_input can't make
 *  the fit's JSON work unbounded (its loss is counted too). Pure and never throws. */
export function buildPermissionDetail(toolName: string, toolInput: Record<string, unknown>): string {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  switch (toolName) {
    case "Bash": case "shell": case "local_shell": { const c = str(toolInput.command); return c ?? ""; }
    case "apply_patch": { const d = str(toolInput.description); return d ?? ""; }
    case "Edit": case "Write": case "Read": case "NotebookEdit": {
      const fp = str(toolInput.file_path); return fp ?? "";
    }
    case "WebFetch": { const u = str(toolInput.url); return u ?? ""; }
    case "WebSearch": { const q = str(toolInput.query); return q ?? ""; }
    case "ExitPlanMode": { const p = str(toolInput.plan); return p ?? ""; }
    // AskUserQuestion: DELIBERATELY empty, so the key is OMITTED from the blob. The question text
    // already rides twice — `permissionSummary` (80-char form) and `permissionQuestions[0].q` (240) —
    // and a third full copy competed with the option list for the same 3072-char ceiling, which is what
    // pushed real frames over the worker's cap. CONTRACT the phone must honor: for a question card,
    // render the prompt from `permissionQuestions`, never from `permissionDetail`.
    case "AskUserQuestion": return "";
    default: return "";
  }
}

/** One question as it rides the sealed blob: compact keys to spend as little of the 3072-char ceiling
 *  as possible — q(uestion), h(eader), m(ultiSelect), o(ption labels), and optional d(escriptions).
 *  Mirrored 1:1 by the phone. */
export interface PermissionQuestion {
  q: string;
  h?: string;
  m?: boolean;
  o: string[];
  d?: string[];
}

/** Longest question text kept in the blob (display only — the answers map is keyed by the ORIGINAL,
 *  untruncated text, so a capped question can still be answered). */
const QUESTION_TEXT_MAX = 240;
/** Longest option label kept in the blob. */
export const PERMISSION_QUESTION_LABEL_MAX = 60;
/** Longest option description kept in the blob. */
const QUESTION_DESCRIPTION_MAX = 160;

/** Ellipsis-cap shared by the blob builder and the answer re-mapper, so the two can never disagree
 *  about what the phone was actually shown. Count Unicode code points rather than UTF-16 code units
 *  so an astral character can never be split into an invalid lone surrogate. */
export function capPermissionWireText(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length <= max ? value : `${characters.slice(0, max - 1).join("")}…`;
}

/** One raw CC question, narrowed. */
type RawQuestion = { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown } | null;

/** A question CC sent that is both SHOWABLE and ANSWERABLE, with its ORIGINAL (untruncated) text,
 *  option labels, and positionally aligned descriptions. */
interface UsableQuestion { text: string; raw: RawQuestion; labels: string[]; descriptions: string[] }

/** THE single question filter. `buildPermissionQuestions` (what the phone renders) and `answerLine`
 *  (what the phone's positional answers zip against) both derive from this list, so an entry skipped
 *  here is skipped IDENTICALLY on both ends and can never shift the answers off their questions.
 *
 *  Two invariants, both required for that alignment:
 *  - non-empty question text (CC's schema makes `question` required — defence in depth), and
 *  - at least ONE usable option label. A zero-option question is not answerable, so the phone MUST NOT
 *    render it as an answer row; if it filtered such a row out on its side, its positional `answers`
 *    array would shift onto the WRONG question. Enforcing it here — the side that owns both ends —
 *    makes that class of bug structurally impossible. */
function usableQuestions(toolInput: Record<string, unknown>): UsableQuestion[] {
  const qs = toolInput.questions;
  if (!Array.isArray(qs)) return [];
  const out: UsableQuestion[] = [];
  for (const raw of qs as RawQuestion[]) {
    const text = typeof raw?.question === "string" ? raw.question : "";
    if (text.length === 0) continue;
    const labels: string[] = [];
    const descriptions: string[] = [];
    if (Array.isArray(raw?.options)) {
      for (const opt of raw.options) {
        const label = (opt as { label?: unknown } | null)?.label;
        if (typeof label === "string" && label.length > 0) {
          labels.push(label);
          const description = (opt as { description?: unknown } | null)?.description;
          descriptions.push(typeof description === "string" ? description : "");
        }
      }
    }
    if (labels.length === 0) continue;
    out.push({ text, raw, labels, descriptions });
  }
  return out;
}

/** The first showable question's raw text, or "" — shared by the summary and the detail builders. */
function firstQuestionText(toolInput: Record<string, unknown>): string {
  return usableQuestions(toolInput)[0]?.text ?? "";
}

/** The AskUserQuestion choice list, compacted for the wire: one entry per question with its text, the
 *  optional short header, the multi-select flag (present only when true), option labels, and aligned
 *  option descriptions when at least one is non-empty. Descriptions are capped and remain the first
 *  field shed by `fitPermissionDetail` under wire-budget pressure. Returns [] for any tool that isn't
 *  a question (no `questions` array), so the blob field is simply absent for every other tool.
 *
 *  Pure, never throws: an entry with no text or NO usable option (unanswerable — see usableQuestions)
 *  is skipped rather than poisoning the hold. Truncation is display-only — `answerLine` re-maps the
 *  phone's echo back onto the ORIGINAL labels, so a capped label never reaches CC. */
export function buildPermissionQuestions(toolInput: Record<string, unknown>): PermissionQuestion[] {
  return usableQuestions(toolInput).map(({ text, raw, labels, descriptions }) => {
    const wireDescriptions = descriptions.map((description) =>
      capPermissionWireText(description, QUESTION_DESCRIPTION_MAX)
    );
    return {
      q: capPermissionWireText(text, QUESTION_TEXT_MAX),
      ...(typeof raw?.header === "string" && raw.header.length > 0 ? { h: raw.header } : {}),
      ...(raw?.multiSelect === true ? { m: true } : {}),
      o: labels.map((l) => capPermissionWireText(l, PERMISSION_QUESTION_LABEL_MAX)),
      ...(wireDescriptions.some((description) => description.length > 0) ? { d: wireDescriptions } : {}),
    };
  });
}

/** Sanity bound on the raw detail before fitting — nothing near it could ever fit, and it keeps the
 *  binary search's JSON work bounded on a pathological input. Text dropped here is still COUNTED into
 *  `omitted`, so the phone's "N characters omitted" note stays truthful. */
const MAX_DETAIL_CHARS = 20_000;

/** Fit `detail` into the sealed decisionPending frame: return the longest prefix whose SEALED blob still
 *  fits `maxChars`, plus how many characters had to be dropped (0 = the whole thing rode).
 *
 *  Why a fit instead of a flat cap: an ExitPlanMode plan is the entire plan markdown, and a flat 400-char
 *  cap cut ~90% of a typical one before it ever left the Mac (NOM-38). The real constraint is the sealed
 *  frame's size, which depends on the OTHER blob fields (title/label/model/…), so the budget is computed
 *  against the exact payload we are about to seal rather than guessed.
 *
 *  Honest-truncation contract: when text is dropped the kept prefix ends in "…" (so even an old phone
 *  that ignores the count shows an ellipsis) and `omitted` is the real number of characters lost — the
 *  phone renders it as "N characters omitted" instead of silently amputating the plan.
 *
 *  Pure (unit-tested), never throws. Binary search over code points, so a multi-byte character is never
 *  split in half. Candidates are measured with the WORST-CASE `permissionDetailOmitted` value (the most
 *  digits it could take), so the frame actually emitted can only be smaller than the one measured. */
export function fitPermissionDetail(
  base: Record<string, unknown>,
  detail: string,
  maxChars: number = BLOB_FIT_CHARS,
  questions: PermissionQuestion[] = [],
): { detail: string; omitted: number; questions?: PermissionQuestion[] } {
  const all = Array.from(detail);                                  // code points, not UTF-16 units
  const hardLoss = Math.max(0, all.length - MAX_DETAIL_CHARS);
  const chars = hardLoss > 0 ? all.slice(0, MAX_DETAIL_CHARS) : all;
  const encoder = new TextEncoder();

  const measure = (d: string, omitted: number, qs: PermissionQuestion[]): number =>
    sealedBlobChars(encoder.encode(JSON.stringify(permissionFrame(base, d, omitted, qs))).length);

  const worstCase = all.length; // most digits `permissionDetailOmitted` can ever take

  // The QUESTIONS are the actionable part of a question card (the detail is only context), so they get
  // first claim on the budget. Descriptions are useful but non-actionable and therefore shed FIRST:
  // keep the full questions when they fit with NO detail, otherwise retry the entire label-only picker,
  // otherwise omit the entire picker. A partial question or option list would be a lie, and the phone
  // degrades cleanly to the read-only prompt when the field is absent. Candidates are measured WITH the
  // worst-case `permissionDetailOmitted`, so the chosen variant stays valid even on the
  // drop-the-detail-entirely branch below (where that key is present and the detail is not).
  const bareQuestions = questions.map(({ d: _descriptions, ...question }) => question);
  const kept = questions.length > 0 && measure("", worstCase, questions) <= maxChars
    ? questions
    : bareQuestions.length > 0 && measure("", worstCase, bareQuestions) <= maxChars
    ? bareQuestions
    : [];
  const tail = kept.length > 0 ? { questions: kept } : {};

  const frameChars = (d: string, omitted: number): number => measure(d, omitted, kept);

  if (chars.length === 0) return { detail: "", omitted: 0, ...tail };
  if (hardLoss === 0 && frameChars(detail, 0) <= maxChars) return { detail, omitted: 0, ...tail };

  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (frameChars(`${chars.slice(0, mid).join("")}…`, worstCase) <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  const shortest = `${chars.slice(0, lo).join("")}…`;
  // FLOOR GUARD: the search cannot shrink past `lo === 0`, but the frame it would emit there is NOT
  // free — "…" still drags in the whole `permissionDetail` key plus `permissionDetailOmitted` (~76
  // base64 chars once sealed, MORE than BLOB_FIT_MARGIN). Without this the fit happily returned a frame
  // over the worker's hard MAX_BLOB_CHARS, which is 400'd — the hold then falls open and the phone never
  // sees the card at all. So shed, most-preferred first: the detail WHOLE (the omitted count still tells
  // the phone the truth about what was lost) and then, only if even that count doesn't fit, the count
  // too. After that the frame is exactly the caller's `base` + whatever questions were kept: there is
  // nothing left for the fit to give back, and an over-cap frame from there is the base's own fault.
  if (lo === 0 && frameChars(shortest, worstCase) > maxChars) {
    if (frameChars("", all.length) <= maxChars) return { detail: "", omitted: all.length, ...tail };
    return { detail: "", omitted: 0, ...tail };
  }
  return { detail: shortest, omitted: all.length - lo, ...tail };
}

/** The decisionPending blob's permission tail, in its FROZEN append-last order:
 *  … permissionToolName, permissionDetail (omitted when empty), permissionDetailOmitted (omitted when
 *  nothing was dropped), permissionQuestions (omitted when there are none / it didn't fit). Every
 *  optional key follows the same "absent, never empty/zero" discipline as the rest of the blob, so an
 *  older iOS decoder is byte-unaffected. Shared by the fit's size prediction and the real seal so the
 *  two can never drift. */
function permissionFrame(
  base: Record<string, unknown>,
  detail: string,
  omitted: number,
  questions: PermissionQuestion[] = [],
): Record<string, unknown> {
  return {
    ...base,
    ...(detail.length > 0 ? { permissionDetail: detail } : {}),
    ...(omitted > 0 ? { permissionDetailOmitted: omitted } : {}),
    ...(questions.length > 0 ? { permissionQuestions: questions } : {}),
  };
}

/** Apply the phone's decrypted answer for THIS request to stdout. The caller has already confirmed
 *  answer.requestId === requestId. Returns the DecisionOutcome (see the type): a verb we understand and
 *  can honor emits exactly one line ("emitted"); a verb we understand but CANNOT honor for this tool
 *  emits nothing and lets go of the hold ("released"); only a verb we do not recognize keeps the hold
 *  open ("keep-polling") — we must never guess a line, so we swallow it and wait for one we know.
 *
 *  THE RELEASE RULE. `AskUserQuestion` (like ExitPlanMode and the Cowork role picker) declares
 *  `requiresUserInteraction()`, and CC's decision path DROPS a bare {behavior:"allow"} for those tools:
 *  interactively it falls through to the terminal picker, but on the HEADLESS path that same bare allow
 *  converts to a hard DENY — the user taps Allow and the machine refuses. There is no safe line to emit,
 *  so we emit NOTHING and exit: with no hook output CC just runs its own flow and shows the picker,
 *  which is exactly the "answer at your Mac" outcome, and silence cannot be converted into a deny on
 *  ANY path. Keeping the hold open instead would be worse still — the phone's decision record is
 *  terminal, so the hook would re-read the same unusable answer forever while the phone says "answered". */
function emitDecision(
  agent: AgentKind,
  answer: { decision?: unknown; message?: unknown; answers?: unknown },
  toolName: string,
  toolInput: Record<string, unknown>,
  suggestions: unknown,
  emit: (line: string) => void,
  trace: (event: object) => void,
): DecisionOutcome {
  const isQuestion = toolName === "AskUserQuestion";
  switch (answer.decision) {
    case "allow":
      if (isQuestion) { trace({ event: "release", reason: "bare-allow-on-question" }); return "released"; }
      emit(allowLine(agent, toolName, toolInput)); trace({ event: "emit", decision: "allow" }); return "emitted";
    case "allow_always":
      if (isQuestion) { trace({ event: "release", reason: "bare-allow-on-question" }); return "released"; }
      emit(allowAlwaysLine(agent, toolName, toolInput, suggestions));
      trace({ event: "emit", decision: agent === "codex" ? "allow_always_degraded_to_allow" : "allow_always" });
      return "emitted";
    case "deny":
      emit(denyLine(agent, answer.message));
      trace({ event: "emit", decision: "deny", hasMessage: typeof answer.message === "string" && answer.message.trim().length > 0 });
      return "emitted";
    case "answer": {
      // The phone picked option(s) for an AskUserQuestion. An answer we cannot turn into a REAL answers
      // map — a non-question tool, a missing/!array/empty answers, or a piece that re-matches no option
      // label — emits NOTHING and releases the hold (see THE RELEASE RULE above).
      const line = answerLine(agent, toolName, toolInput, answer.answers);
      if (line === undefined) { trace({ event: "release", reason: "answer-unmappable", tool_name: toolName }); return "released"; }
      emit(line); trace({ event: "emit", decision: "answer" }); return "emitted";
    }
    default:
      trace({ event: "answer-unknown-decision" }); return "keep-polling"; // future phone, old plugin
  }
}

// ---- LAN loopback answer poll (NOM-44 phase 2) ----------------------------------------------
//
// The watchdog's LAN listener can be handed the phone's answer DIRECTLY over the local network
// (op:"answer"), which is ~100 ms instead of the ~5-12 s a worker round trip costs. But this hook is a
// SEPARATE, short-lived process with no IPC to that daemon, so it reads the store the only way it can:
// a loopback HTTP poll of the listener's `answer-poll` op, every ~300 ms.
//
// THE NON-NEGOTIABLE: the 3 s worker poll is the Mac's LIVENESS PROOF (30 s of silence and the worker
// expires the hold), so it is not slowed, skipped, or reordered by any of this. The loopback poller runs
// as its OWN detached ticker and the hold loop merely RACES its unchanged `sleep(interval + jitter())`
// against "an answer arrived" — the sleep still resolves at exactly the same moment it always did.
// Everything else follows from "LAN is additive": a loopback failure is silent (one trace line per hold,
// never per attempt), never counts toward MAX_CONSECUTIVE_MISSES or DEFINITIVE_POLL_STATUSES or a gone
// strike (those are worker-authority signals), and with no lan.json there is no ticker at all.

/** Loopback poll cadence. ~10 ticks inside one worker poll interval. */
const LOOPBACK_POLL_INTERVAL_MS = 300;
/** Per-attempt ceiling. The peer is a socket on this same machine: anything slower than this is a dead
 *  or wedged listener, and waiting longer only delays the next tick. */
const LOOPBACK_FETCH_TIMEOUT_MS = 250;
/** Consecutive loopback failures before this hold stops trying. The watchdog can die mid-hold (that is
 *  the whole robustness case) and the worker poll is still running, so there is nothing to recover. */
const LOOPBACK_MAX_CONSECUTIVE_ERRORS = 5;

export interface LoopbackAnswerPollerDeps {
  fetchFn: typeof fetch;
  now: () => number;
  trace: (event: object) => void;
  /** lan.json (the listener's port). `undefined` disables the poller outright — zero timers, zero HTTP,
   *  byte-identical behavior to the pre-phase-2 hook. */
  statePath?: string;
  /** The ticker's OWN pacing clock — a real unref'd timer by default and deliberately NOT the hook's
   *  injected `sleep`: the hold tests inject an INSTANT sleep for the worker cadence, and sharing it here
   *  would turn this ticker into a hot loop. */
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  /** How often the ABSENCE of lan.json is re-checked. Defaults to the worker poll interval, so a watchdog
   *  that comes up mid-hold is picked up within one worker cycle — and never re-stat'ed per 300 ms tick. */
  discoverIntervalMs?: number;
}

export interface LoopbackAnswerPoller {
  /** Race the caller's OWN, untouched poll sleep against a LAN-delivered answer. Resolves with the
   *  sealed answerBlob when one arrived first, or undefined when the sleep simply finished. */
  wait(sleeping: Promise<void>): Promise<string | undefined>;
  /** Stop the ticker (always call from a `finally` — a hold can return from a dozen places). */
  stop(): void;
}

/** The loopback poller for ONE hold. Derives K_lan itself (the hook has config.e2eKey + pairingId) and
 *  seals every request with a fresh nonce and the current ts, exactly like the phone does. */
export function createLoopbackAnswerPoller(
  config: Config,
  requestId: string,
  deps: LoopbackAnswerPollerDeps,
): LoopbackAnswerPoller {
  const interval = deps.intervalMs ?? LOOPBACK_POLL_INTERVAL_MS;
  const discoverInterval = deps.discoverIntervalMs ?? POLL_INTERVAL_MS;
  const tick = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  }));

  let live = deps.statePath !== undefined;
  let started = false;
  let port: number | undefined;
  let lastDiscoverAt = 0;
  let errors = 0;
  let traced = false;
  let pending: string | undefined;
  /** The one-shot wake. It is never re-armed, because the ticker delivers at most ONE answer per hold
   *  (see the ticker): after that the poller is retired and only the worker poll remains. */
  let wakeResolve: () => void = () => { /* replaced immediately below */ };
  let wake: Promise<void> = new Promise<void>((resolve) => { wakeResolve = resolve; });
  let keyPromise: Promise<Uint8Array> | undefined;

  /** ONE trace line per hold, never per attempt — a dead listener must not spam permission-trace.log. */
  const note = (result: string): void => {
    if (traced) return;
    traced = true;
    try { deps.trace({ event: "lan-poll", result }); } catch { /* diagnostics only */ }
  };

  const key = (): Promise<Uint8Array> => (keyPromise ??= deriveLanKey(config.e2eKey, config.pairingId));

  const readPort = async (): Promise<number | undefined> => {
    if (deps.statePath === undefined) return undefined;
    try {
      return parseLanState(await readFile(deps.statePath, "utf8"))?.port;
    } catch {
      return undefined; // no watchdog / no listener → nothing to poll, silently
    }
  };

  /** ONE loopback poll. Never throws; every failure just increments the strike counter. */
  const attempt = async (): Promise<string | undefined> => {
    try {
      const k = await key();
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const body = JSON.stringify({
        p: await encryptBlob(k, {
          v: LAN_ENVELOPE_VERSION, op: "answer-poll", ts: deps.now(), nonce, payload: { requestId },
        }),
      });
      const res = await deps.fetchFn(`http://127.0.0.1:${port}${LAN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(LOOPBACK_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) { errors += 1; return undefined; }
      const outer = (await res.json()) as { p?: unknown };
      if (typeof outer?.p !== "string") { errors += 1; return undefined; }
      const opened = (await decryptBlob(k, outer.p)) as {
        reqNonce?: unknown; payload?: { status?: unknown; answerBlob?: unknown };
      };
      // The sealed response echoes OUR nonce; anything else is a replayed response and is not an answer.
      if (opened.reqNonce !== nonce) { errors += 1; return undefined; }
      errors = 0; // a well-formed sealed answer-poll reply, pending or not, is a healthy listener
      const payload = opened.payload;
      if (payload?.status === "answered" && typeof payload.answerBlob === "string" && payload.answerBlob.length > 0) {
        return payload.answerBlob;
      }
      return undefined;
    } catch {
      errors += 1;
      return undefined; // timeout, refused socket, undecryptable reply — all silent, all the same
    }
  };

  /** The detached ticker. It is the ONLY thing that touches the network here, and nothing in the hold
   *  loop ever awaits it — that is what keeps the worker cadence provably untouched. */
  const ticker = async (): Promise<void> => {
    while (live) {
      await tick(interval);
      if (!live) return;
      if (port === undefined) {
        const t = deps.now();
        if (lastDiscoverAt !== 0 && t - lastDiscoverAt < discoverInterval) continue;
        lastDiscoverAt = t;
        port = await readPort();
        if (port === undefined) continue; // no listener yet: no HTTP at all, re-check next worker cycle
      }
      const blob = await attempt();
      if (!live) return;
      if (blob !== undefined) {
        // ONE delivery per hold. The consumer either ends the hold with it or (an unrecognized verb) keeps
        // waiting on the WORKER — re-serving the same stored blob every 300 ms would spin the hold loop.
        pending = blob;
        wakeResolve();
        return;
      }
      if (errors >= LOOPBACK_MAX_CONSECUTIVE_ERRORS) {
        note("give-up"); // the worker poll is still running; this hold simply stops trying locally
        live = false;
        return;
      }
    }
  };

  return {
    async wait(sleeping: Promise<void>): Promise<string | undefined> {
      if (!live) { await sleeping; return undefined; }
      if (!started) {
        started = true;
        void ticker().catch(() => { live = false; note("error"); });
      }
      await Promise.race([sleeping, wake]);
      if (pending === undefined) return undefined; // the worker sleep finished first — cadence unchanged
      const blob = pending;
      pending = undefined;
      live = false;
      return blob;
    },
    stop(): void {
      live = false;
      wakeResolve();
    },
  };
}

/** lan.json in production; nothing under `bun test`, where the developer's REAL listener would otherwise
 *  be polled by unit tests (same guard, same reason, as lan-listener's traceLan). Tests that exercise the
 *  loopback path inject `lanStatePath` explicitly. */
function defaultLanStatePath(): string | undefined {
  return lanRunningUnderTest() ? undefined : LAN_STATE_PATH;
}

/** The session-record tee for the unabridged permission detail (NOM-44 phase 4). The real writer in
 *  production; a NO-OP under `bun test`, where a unit test sees the developer's REAL home directory and
 *  must never patch their live session records — the same guard, and the same reason, as
 *  defaultLanStatePath above. Tests that exercise the tee inject `stampDetailFullFn`. */
function defaultStampDetailFull(): (sessionId: string, detailFull: string | undefined) => Promise<void> {
  return lanRunningUnderTest() ? async () => { /* never touch real records from a test */ } : stampPermissionDetailFull;
}

/** The hold-marker writer/clearer, under the SAME test guard and for the same reason as
 *  defaultStampDetailFull: a unit test must never stamp (or, worse, clear) a marker in the developer's
 *  live session store. Tests that exercise the hold inject `writeHoldFn` / `clearHoldFn`. */
function defaultWriteHold(): (sessionId: string, hold: DecisionHold) => Promise<void> {
  return lanRunningUnderTest() ? async () => { /* never touch real records from a test */ } : writeDecisionHold;
}

function defaultClearHold(): (sessionId: string, pid: number) => Promise<void> {
  return lanRunningUnderTest() ? async () => { /* never touch real records from a test */ } : clearDecisionHold;
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
  /** Persists the UNABRIDGED permission detail on the session record for the LAN `read` op (NOM-44
   *  phase 4). Defaults to the real record patcher in production and to a NO-OP under `bun test` — see
   *  defaultStampDetailFull. Called at most once per prompt, and only when the value would change. */
  stampDetailFullFn?: (sessionId: string, detailFull: string | undefined) => Promise<void>;
  /** Stamps / retires the on-disk hold marker the LAN frames feed serves the Allow/Deny card from (see
   *  shared.ts's DecisionHold header). Defaults to the real writers in production and to NO-OPs under
   *  `bun test` — see defaultWriteHold. Called exactly once each per granted hold. */
  writeHoldFn?: (sessionId: string, hold: DecisionHold) => Promise<void>;
  clearHoldFn?: (sessionId: string, pid: number) => Promise<void>;
  /** The pid stamped as the hold's OWNER (defaults to this process). Injected so a test can drive the
   *  compare-and-clear rule without spawning processes. */
  holdPid?: number;
  /** Resolve Codex's effective per-turn approval policy from its rollout. Tests inject this so no
   *  local Codex state is touched; Claude never calls it. */
  loadCodexTurnPolicyFn?: (
    transcriptPath: string, turnId: string, sessionId: string,
  ) => Promise<CodexTurnPolicy | null>;
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
  /** lan.json for the LAN loopback answer poll (NOM-44 phase 2). Defaults to the real path in
   *  production and to NOTHING under `bun test` — see defaultLanStatePath. */
  lanStatePath?: string;
  /** Transport for the loopback poll only. Defaults to `fetchFn`, so a test that scripts the worker also
   *  sees the loopback attempts; a test driving a REAL listener passes the real fetch here. */
  lanFetchFn?: typeof fetch;
  /** The loopback ticker's own pacing clock + cadence (never the hook's `sleep` — see the poller). */
  lanSleep?: (ms: number) => Promise<void>;
  lanIntervalMs?: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
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
  /** The hold's LAN loopback poller, once a hold is granted. Function-scoped ONLY so the `finally` below
   *  can stop its detached ticker no matter which of the loop's many exits fired. */
  let loopback: LoopbackAnswerPoller | undefined;
  /** The session whose on-disk hold marker THIS process owns, once one is stamped — function-scoped for
   *  the same reason as `loopback`: the `finally` clears it from every exit of the poll loop. */
  let heldSessionId: string | undefined;
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

    // Parsed HERE rather than in the outer catch so the failure can be traced WITHOUT its message: a
    // JSON.parse SyntaxError quotes the offending input, and the input here is the raw hook payload
    // (Bash commands, plans, paths — potentially secrets). Class + reported position only.
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      trace({ event: "exit", reason: "bad-stdin", ...errorTag(e), pos: parseErrorPosition(e) });
      return; // unreadable hook input → fail open, silent
    }
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
    // 2. Mode gate: hold ONLY for the interactive dialog modes. Claude reports "default",
    //    "acceptEdits", or "plan"; Codex's producer reports only "default" or "bypassPermissions" because
    //    Codex Plan is a separate collaboration mode, NOT a permission_mode. An absent/non-string mode
    //    preserves older-CC behavior. In "auto" the
    //    PermissionRequest path runs even when NO dialog would show, so the hook can't tell "would
    //    auto-run" from "would prompt" — it must not hold. "dontAsk"/"bypassPermissions" never prompt.
    //    Any unrecognized future value falls open too (fail-open bias).
    const interactiveMode = permissionMode === undefined
      || permissionMode === "default"
      || (agent === "claude" && (permissionMode === "acceptEdits" || permissionMode === "plan"));
    if (!interactiveMode) {
      // Signal-only (no behavior change): if a future Codex starts reporting claude-style dialog modes,
      // the `agent === "claude"` narrowing above would silently stop holding for them. Tag that exit so
      // the trace names the cause instead of reading like an ordinary non-interactive mode.
      const codexDialogMode = agent === "codex" && (permissionMode === "acceptEdits" || permissionMode === "plan");
      trace({ event: "exit", reason: "mode", mode: permissionMode, ...(codexDialogMode ? { codex_dialog_mode: true } : {}) });
      return;
    }
    // 3. Codex reviewer gate: `permission_mode:"default"` is lossy — it covers BOTH manual review and
    //    "Approve for me". The exact turn_context records the effective reviewer after task/profile/UI
    //    overrides. In auto-review, silently return control to Codex BEFORE any Nomo POST so Codex's
    //    built-in reviewer can decide. Full Access normally took the mode gate above, but the rollout
    //    checks make that promise resilient to a producer that reports `default` by mistake.
    if (agent === "codex" && !toolName.startsWith("mcp__")) {
      const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
      const turnId = typeof input.turn_id === "string" ? input.turn_id : "";
      const policy = await (deps.loadCodexTurnPolicyFn ?? loadCodexTurnPolicy)(transcriptPath, turnId, sessionId);
      const reason = codexPassThroughReason(policy);
      if (reason) {
        trace({ event: "exit", reason });
        return;
      }
      trace({ event: "codex-reviewer", disposition: "hold", reason: "manual" });
    } else if (agent === "codex") {
      // MCP apps may override the thread-global reviewer per connector. Codex does not expose that
      // effective reviewer to hooks yet, so the rollout is not authoritative for these tool names.
      trace({ event: "codex-reviewer", disposition: "hold", reason: "mcp-reviewer-unknown" });
    }
    // (There is no longer a question gate here: AskUserQuestion HOLDS like every other tool — its
    // options ride the blob in `permissionQuestions` and the phone's `answer` verb injects the
    // selection through `updatedInput`. CLAUDE-ONLY in practice: Codex has no AskUserQuestion tool.)
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
    // optional blob key), then the OPTIONAL permissionDetailOmitted (absent unless text was dropped),
    // and LAST the OPTIONAL permissionQuestions (AskUserQuestion only — absent for every other tool, and
    // absent for a question whose option list could not fit the frame). permissionToolName lets the
    // phone key card layout off the tool; permissionDetail is the fuller sub-line (and, for
    // ExitPlanMode, the whole plan).
    //
    // BLOB SIZE: the worker rejects a decision POST whose base64 `blob` exceeds MAX_BLOB_CHARS (3072) —
    // enforced server-side, NOT by encryptBlob (which never hard-fails on size). The detail used to carry
    // a flat 400-char cap for this, which silently amputated every plan-mode plan (NOM-38). It now rides
    // UNCAPPED through `fitPermissionDetail`, which sizes the exact frame we are about to seal and keeps
    // the longest prefix that still fits — ~1.7 KB of plan instead of 400 chars — reporting the dropped
    // character count in `permissionDetailOmitted` so the phone can say so out loud instead of cutting
    // silently. If the frame ever needs to shed more, permissionDetail is still the field to shed.
    const record = await (deps.readRecordFn ?? readRecord)(sessionId);
    const machine = config.machineName ?? hostname().replace(/\.local$/, "");
    const plan: OpPlan = { op: "update", prio: 1, status: "needsAttention" };
    // `at` — the REAL event time in epoch SECONDS, computed exactly as runHook/buildEnvelope do
    // (Math.floor(now / 1000), NOT the envelope's ms `ts`). Held frames were the ONLY frames shipping
    // without it since v1.1.6, so a decisionPending row could not be aged/sorted honestly by the phone
    // (and the plugin never emitted the frame the codex E2E vector describes). buildBlob appends it LAST,
    // before the permission tail, so the append-only wire discipline is unchanged.
    const at = Math.floor(now / 1000);
    const base = buildBlob(input, machine, record?.title, plan, agent, record?.turnStartedAt, record?.label, record?.model, at);
    const permissionBase = {
      ...base, status: "decisionPending", permissionSummary: summary, permissionRequestId: requestId,
      permissionToolName: toolName,
    };
    const rawDetail = buildPermissionDetail(toolName, toolInput);
    const fitted = fitPermissionDetail(
      permissionBase, rawDetail, BLOB_FIT_CHARS,
      buildPermissionQuestions(toolInput),
    );
    // NOM-44 phase 4: the fit above is the WORKER's ceiling and stays exactly as it is, but a phone on
    // this network can pull from the Mac directly, where there is none — so tee the UNABRIDGED detail
    // (the whole ExitPlanMode plan, the whole multi-line Bash command) onto the 0600 session record for
    // the LAN listener's `read` op. `fullTextForRecord` returns undefined when nothing was cut, and
    // writing undefined DROPS the key — which is how a prompt that rode whole clears the copy an earlier
    // prompt in this session left behind. Skipped entirely when the record already holds the right value
    // (the overwhelmingly common case: no truncation, no stale copy), so an ordinary prompt pays no IO.
    // Awaited, not fired-and-forgotten: it is one small local write, and the phone must never be able to
    // see the card (POSTed just below) before the content it may ask for is on disk.
    const detailFull = fullTextForRecord(rawDetail, fitted.detail);
    if (record && record.permissionDetailFull !== detailFull) {
      await (deps.stampDetailFullFn ?? defaultStampDetailFull())(sessionId, detailFull);
    }
    const blob = await encryptBlob(config.e2eKey, permissionFrame(permissionBase, fitted.detail, fitted.omitted, fitted.questions));
    const fallbackBlob = await encryptBlob(config.e2eKey, base);

    const pcHeaders = { "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret, "x-cc-version": PLUGIN_VERSION };
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    // The initial POST is the one place this hook is ALLOWED to block, and it is bounded tightly (see
    // POST_FIRST_CONTACT_TIMEOUT_MS for the worst-case pre-dialog arithmetic). One retry, and ONLY after a
    // FAST transport failure — a timeout ends the round at once. A non-ok HTTP status is a real answer and
    // is never retried. `round` (1 = initial, 2 = post-race re-ask) is threaded through the trace alongside
    // `attempt` (the per-round transport retry) so both rounds are legible in the log.
    //
    // FRESH `ts` PER ATTEMPT. Every POST must carry a STRICTLY NEWER timestamp than the last one this hook
    // sent. The hold:false path is not a no-op server-side: the worker stores/pushes the fallback frame,
    // which stamps the session row's `lastTs` with the ts we just sent. Re-POSTing the SAME ts then trips
    // the worker's ordering guard (`env.ts <= existing.lastTs` → drop "stale" → hold:false
    // "stale-session"), so the HOLD_RETRY_DELAY_MS re-ask — the ONE mechanism that recovers a fresh
    // session's first prompt from the island auto-add race — could never succeed. `lastPostTs + 1` also
    // covers a coarse/frozen clock, where two reads inside the retry window can return the same ms.
    let lastPostTs = 0;
    const postDecision = async (
      round: number, maxAttempts: number,
    ): Promise<{ posted: boolean; hold: boolean; reason?: string }> => {
      let hold = false;
      let posted = false;
      let reason: string | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const ts = Math.max((deps.now ?? Date.now)(), lastPostTs + 1);
        lastPostTs = ts;
        try {
          const res = await fetchFn(`${config.url}/v1/cc/decision`, {
            method: "POST",
            headers: { "content-type": "application/json", ...pcHeaders },
            body: JSON.stringify({ v: 2, sessionId, requestId, op: "update", prio: 1, ts, blob, fallbackBlob }),
            signal: AbortSignal.timeout(POST_FIRST_CONTACT_TIMEOUT_MS),
          });
          if (res.ok) {
            // A 200 whose body we cannot read (captive portal, edge interposition) is NOT a transport
            // failure to retry behind another ceiling — it just isn't a hold.
            const body = (await res.json().catch(() => ({}))) as { hold?: unknown; reason?: unknown };
            hold = body.hold === true;
            if (typeof body.reason === "string") reason = body.reason;
          }
          // The worker names the FIRST failing gate in `reason` (stale-session / toggle-off /
          // no-activity). Without it a field trace of a prompt that fell open is unfalsifiable — a
          // re-ask killed by the staleness guard looks exactly like the user having approvals off.
          trace({
            event: "posted", requestId, round, attempt, status: res.status, ts,
            ...(res.ok ? { hold } : {}), ...(reason !== undefined ? { reason } : {}),
          });
          posted = true;
          break; // any HTTP response (ok or not) is a real answer — do not retry
        } catch (e) {
          const name = (e as { name?: string })?.name ?? "Error";
          trace({ event: "posted", requestId, round, attempt, status: 0, ts, error: name });
          // A TIMEOUT means the network is stalled: retrying only doubles the terminal freeze for the
          // same answer. Anything else failed FAST, so one cheap retry is worth it.
          if (name === "TimeoutError") break;
          if (attempt < maxAttempts) { await sleep(POST_RETRY_PAUSE_MS); continue; }
        }
      }
      return { posted, hold, reason };
    };

    // ONE poll GET of this request's decision record. Shared by the post-timeout probe below and the hold
    // loop so both read the record exactly the same way. Returns the parsed body (only on a 2xx) plus the
    // HTTP status (0 = the fetch threw/timed out) — never throws.
    const pollDecision = async (seq: number): Promise<{ data?: { status?: string; answerBlob?: string }; status: number }> => {
      // poll-begin/poll-end straddle the fetch so an abort or kill MID-FETCH is visible: a begin with
      // no matching end means the process died inside the GET (the prime suspect for a hold that
      // never completes its first poll).
      trace({ event: "poll-begin", seq });
      try {
        const res = await fetchFn(`${config.url}/v1/cc/decision/${requestId}`, {
          headers: pcHeaders,
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        });
        if (!res.ok) {
          trace({ event: "poll-end", seq, outcome: "status", status: res.status });
          return { status: res.status };
        }
        const data = (await res.json()) as { status?: string; answerBlob?: string };
        trace({ event: "poll-end", seq, outcome: "ok" });
        return { data, status: res.status };
      } catch (e) { // transient — counted by the caller, kept polling until the cap
        trace({ event: "poll-end", seq, outcome: "error", ...errorTag(e) });
        return { status: 0 };
      }
    };

    let { posted, hold, reason: holdReason } = await postDecision(1, POST_MAX_ATTEMPTS);
    if (!posted) {
      // Both POSTs failed at the TRANSPORT layer — but a client-side timeout says nothing about whether
      // the request LANDED. If the first one did, the worker is holding a real record and the phone is
      // already showing the card: exiting here would fail open on the Mac while the phone still claims it
      // can decide, and a tap would be applied to nothing. So spend ONE cheap GET (seq 0, same 2 s
      // ceiling) asking whether the record exists. A live record ⇒ honor the hold and fall into the normal
      // poll loop; anything else — no record, an error, a terminal status — ⇒ fail open exactly as before.
      const probe = await pollDecision(0);
      const live = probe.data?.status === "pending" || probe.data?.status === "answered";
      if (!live) { trace({ event: "exit", reason: "post-error" }); return; }
      trace({ event: "post-timeout-landed", status: probe.data?.status });
      hold = true;
      holdReason = undefined;
    }
    trace({ event: "hold", hold, ...(holdReason !== undefined ? { reason: holdReason } : {}) });
    if (!hold) {
      // hold:false on the FIRST ask is usually genuine (session not on the phone), but a brand-new
      // session's first prompt can lose a race with the app's island auto-add. Re-ask ONLY when that
      // race is still possible — no local record yet, or the record is younger than FRESH_SESSION_MS;
      // an established session that says hold:false is genuinely off the phone and exits AT ONCE (no 4s
      // tax on every prompt).
      const fresh = !record || (now - record.ts) < FRESH_SESSION_MS;
      if (!fresh) { trace({ event: "exit", reason: "hold-false" }); return; } // established session → instant terminal dialog
      // Wait once, then re-POST the SAME requestId/blobs with a FRESH, strictly-newer `ts` (single
      // attempt, no transport retry): the first POST created no DECISION record, so this is a clean fresh
      // gate evaluation — but it DID stamp the session row, which is exactly why the new ts is load-bearing
      // (see postDecision). hold:true now → the session showed up, fall through to the poll loop; still
      // hold:false (or a transport error) → the genuine fall-open.
      trace({ event: "hold-retry-wait", delayMs: HOLD_RETRY_DELAY_MS });
      await sleep(HOLD_RETRY_DELAY_MS);
      const retry = await postDecision(2, 1);
      if (!retry.posted) { trace({ event: "exit", reason: "hold-false" }); return; } // re-ask failed at transport → fall open
      hold = retry.hold;
      holdReason = retry.reason;
      trace({ event: "hold", hold, ...(holdReason !== undefined ? { reason: holdReason } : {}) });
      if (!hold) { trace({ event: "exit", reason: "hold-false" }); return; } // still not shown → worker applied the attention update → terminal dialog
    }

    // THE HOLD IS REAL — tell the LAN channel. The worker now stores the decisionPending frame and
    // defends it (it drops the plain prio:1 needsAttention CC's `Notification` hook fires seconds from
    // now); the LAN frames feed rebuilds its frames from the SESSION RECORD, which has never carried
    // either half. So stamp the same sealed frame beside the record, where the feed can find it, and
    // let its guards decide when it stops being the truth (see shared.ts's DecisionHold header and
    // lanHoldLive). Without this the phone's LAN row settles on a yellow "needs help" with no
    // Allow/Deny — field report, session bed2e681, 2026-08-02.
    //
    // AWAITED, and BEFORE the poll loop, for the same reason the detail tee is: the phone must never be
    // able to see the card before the local state that describes it is on disk. Best-effort inside.
    await (deps.writeHoldFn ?? defaultWriteHold())(
      sessionId, { blob, at: (deps.now ?? Date.now)(), pid: deps.holdPid ?? process.pid },
    );
    heldSessionId = sessionId;

    // HOLD: poll until the phone answers, the request leaves "pending", sustained failure trips the
    // give-up cap, or we're killed. Each fetch keeps its own 2s ceiling; transient failures are
    // tolerated (keep polling). A decrypt failure or requestId mismatch exits silently (fail open).
    const jitter = deps.jitter ?? (() => Math.floor(Math.random() * 500));
    const interval = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    const emit = deps.emit ?? ((line: string) => process.stdout.write(`${line}\n`));

    /** Apply ONE sealed answer blob to this hold, from EITHER delivery channel — the 3 s worker poll or
     *  the ~300 ms LAN loopback poll. THE single answered-branch body, so the two sources cannot drift:
     *  decrypt → requestId match → emitDecision → THE RELEASE RULE (see emitDecision). "done" means the
     *  hold is over (exactly one line emitted, or deliberately zero); "keep-polling" is only ever an
     *  UNRECOGNIZED decision verb. A decrypt failure throws to the outer catch → silent exit 0 (fail
     *  open), unchanged and identical on both channels. */
    const applyAnswerBlob = async (answerBlob: string, src: "worker" | "lan"): Promise<"done" | "keep-polling"> => {
      const answer = (await decryptBlob(config.e2eKey, answerBlob)) as
        { requestId?: unknown; decision?: unknown; message?: unknown; answers?: unknown };
      const match = answer.requestId === requestId;
      // A matched, KNOWN decision either emits one line ("emitted") or deliberately emits nothing and
      // lets the hold go ("released" — THE RELEASE RULE); both are DONE. A requestId MISMATCH is a
      // replay/stale answer (silent, done). The ONE keep-polling case is a matched but UNRECOGNIZED
      // decision verb (newer phone, older plugin): a decision we DO understand can still land.
      const outcome: DecisionOutcome = match
        ? emitDecision(agent, answer, toolName, toolInput, suggestions, emit, trace)
        : "released";
      if (outcome !== "keep-polling") {
        trace({ event: "answered", match, outcome, src });
        trace({ event: "exit", reason: "answered" });
        return "done";
      }
      return "keep-polling";
    };

    // The LAN fast path, alongside (never instead of) the worker poll below. Inert when there is no
    // lan.json — i.e. no watchdog listener — which is byte-for-byte the pre-phase-2 hook. Held in the
    // function-scope handle so the outer `finally` can stop the ticker from EVERY exit of this loop.
    loopback = createLoopbackAnswerPoller(config, requestId, {
      fetchFn: deps.lanFetchFn ?? fetchFn,
      now: deps.now ?? Date.now,
      trace,
      statePath: deps.lanStatePath ?? defaultLanStatePath(),
      sleep: deps.lanSleep,
      intervalMs: deps.lanIntervalMs,
      discoverIntervalMs: interval,
    });
    let misses = 0;
    let definitiveFailures = 0;
    /** The answerBlob of the last UNRECOGNIZED decision, and how many times in a row it has been read —
     *  the bound that stops a terminal record we cannot understand from freezing the hold forever. */
    let unknownBlob: string | undefined;
    let unknownReads = 0;
    let seq = 0;
    for (;;) {
      seq += 1;
      const { data, status: httpStatus } = await pollDecision(seq);

      if (data) {
        misses = 0;
        definitiveFailures = 0;
        if (data.status === "answered" && typeof data.answerBlob === "string") {
          // The SHARED answered branch (applyAnswerBlob above) — byte-identical handling whether this
          // blob came from the worker poll or the LAN loopback poll. A decrypt failure inside it throws
          // to the outer catch → silent exit 0 (fail open), never a retry.
          if (await applyAnswerBlob(data.answerBlob, "worker") === "done") {
            return; // done — exactly one line emitted, or zero (release / mismatch)
          }
          // UNKNOWN decision verb — keep polling, but BOUNDED. An `answered` record is TERMINAL on the
          // worker (a re-answer 409s and the identical blob is served for the record's 24h TTL), so if the
          // SAME blob keeps coming back the verb will never become one we understand: the forward-compat
          // wait would freeze this terminal for the hook's full 86400 s timeout while issuing ~26k doomed
          // GETs. Count consecutive reads of the same record and release once the bound is hit (fail open
          // — CC shows its own dialog). A DIFFERENT answerBlob resets the count, so a genuine later answer
          // is still honored, and `pending` polls never touch it.
          unknownReads = data.answerBlob === unknownBlob ? unknownReads + 1 : 1;
          unknownBlob = data.answerBlob;
          if (unknownReads >= MAX_UNKNOWN_ANSWER_READS) {
            trace({ event: "release", reason: "unknown-decision-terminal", reads: unknownReads });
            trace({ event: "exit", reason: "unknown-decision" });
            return; // a verb we will never understand on a record that will never change → fail open
          }
        } else if (typeof data.status === "string" && data.status !== "pending") {
          trace({ event: data.status === "expired" ? "expired" : "superseded", status: data.status });
          trace({ event: "exit", reason: data.status });
          return; // expired/superseded/unknown → silent
        }
      } else {
        // DEFINITIVE vs transient. 401/403/404/410 mean this pairing cannot read this record at all
        // (unauthorized / revoked / GC'd), so every one of the remaining ~100 polls would fail identically
        // — a ~5.4 min frozen terminal for an outcome already known. Mirror runHook's gone strike: two
        // CONSECUTIVE definitive responses (a single one can be a racing delete/deploy) release at once.
        // Everything else — 429, 5xx, a transport throw — stays transient and rides the miss cap.
        if (DEFINITIVE_POLL_STATUSES.has(httpStatus)) {
          definitiveFailures += 1;
          if (definitiveFailures >= MAX_DEFINITIVE_POLL_FAILURES) {
            trace({ event: "giveup", reason: "definitive", status: httpStatus, strikes: definitiveFailures });
            trace({ event: "exit", reason: "definitive" });
            return; // unpaired/revoked → fail open immediately, not in 5 minutes
          }
        } else {
          definitiveFailures = 0;
        }
        if (++misses >= MAX_CONSECUTIVE_MISSES) {
          trace({ event: "giveup", misses });
          trace({ event: "exit", reason: "giveup" });
          return; // sustained downlink failure → fail open silently
        }
      }
      // THE WORKER CADENCE IS THIS LINE, UNCHANGED: `sleep(interval + jitter())` is still what paces the
      // loop. The race only lets a LAN-delivered answer cut the wait SHORT — it can never extend it, and
      // the loopback ticker runs on its own stack, so a wedged listener cannot delay the next poll.
      const lanBlob = await loopback.wait(sleep(interval + jitter()));
      if (lanBlob !== undefined) {
        // Same code path as a worker-delivered answer, by construction. An unrecognized verb here does
        // NOT keep the LAN channel open (the poller retires itself after one delivery): the worker poll
        // owns the bounded unknown-answer wait, exactly as before.
        if (await applyAnswerBlob(lanBlob, "lan") === "done") return;
      }
    }
  } catch (e) {
    // Silence + exit 0 is the contract — never surface into a Claude Code session, never block. The
    // error is recorded by CLASS (+ code) only — see errorTag: a thrown message can quote the hook
    // payload it choked on, and this trace is a plaintext file on disk.
    trace({ event: "exit", reason: "exception", ...errorTag(e) });
  } finally {
    // Stop the detached loopback ticker on EVERY exit (emitted, released, give-up, exception). The
    // process is normally about to exit anyway; this is what keeps it from outliving the hold in-process.
    try { loopback?.stop(); } catch { /* best-effort */ }
    // Retire this process's hold marker the same way — answered, released, expired, gave up, threw. It
    // is a compare-and-clear (a parallel tool's LATER hold must survive our exit), and it is NOT the
    // only release: a SIGKILL, or the SIGTERM a closed terminal sends, never reaches a `finally`, so the
    // feed's own holder-liveness and TTL guards are what make a marker impossible to wedge.
    if (heldSessionId !== undefined) {
      try {
        await (deps.clearHoldFn ?? defaultClearHold())(heldSessionId, deps.holdPid ?? process.pid);
      } catch { /* best-effort */ }
    }
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
  print(await flagExists(path)
    ? "Remote approvals: OFF (paused locally) — permission prompts appear in the terminal. Run `on` to resume."
    : "Remote approvals: ON — permission prompts for phone-attached sessions are sent to your phone. Run `off` to pause them here.");
  return 0;
}
