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

import { unlink } from "node:fs/promises";
import { appendFileSync, statSync, truncateSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import { runHook, buildBlob, OpPlan } from "./hook";
import { AgentKind, atomicWrite, CC_DIR, Config, flagExists, loadConfig, NO_HOLD_PATH, PLUGIN_VERSION, readRecord, SessionRecord } from "./shared";
import { decryptBlob, encryptBlob } from "./crypto";

/** Local escape-hatch flag: when this file exists, the hook skips the hold entirely and behaves as a
 *  plain fire-and-forget attention event (instant terminal dialog). Toggled by `cc-permission off|on`.
 *  DEFINED IN shared.ts (every /cc/event POSTer reports it as the `x-cc-approvals` header, and a
 *  shared.ts → permission.ts import would be a cycle); re-exported here, where it is toggled, so
 *  existing importers are unaffected. */
export { NO_HOLD_PATH };

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
 *  disk. Requires CC ≥ 2.0.54 (the `updatedPermissions` key); older CC ignores the extra key and
 *  degrades to a plain allow (safe: the tool still runs, just no rule is remembered). */
function allowAlwaysLine(agent: AgentKind, toolName: string, toolInput: Record<string, unknown>, suggestions: unknown): string {
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
 *  answers map — a non-question tool, a missing/!array/empty `answers`, entries that resolve to nothing —
 *  must emit NOTHING and RELEASE the hold (silent exit 0 → CC shows the terminal picker). Never a bare
 *  allow, and never a guessed label. */
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
  const map: Record<string, string> = {};
  for (let i = 0; i < questions.length; i += 1) {
    const a = answers[i];
    if (typeof a !== "string") continue;                        // non-string → unanswered
    const raw = a.trim();
    if (raw.length === 0) continue;                             // unanswered → simply absent from the map
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
  if (Object.keys(map).length === 0) return undefined; // nothing mappable → release, never a bare allow
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
    const hits = Array.from(new Set(labels.filter((l) => l === piece || cap(l, QUESTION_LABEL_MAX) === piece)));
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
 *  as possible — q(uestion), h(eader), m(ultiSelect), o(ption labels). Mirrored 1:1 by the phone. */
export interface PermissionQuestion {
  q: string;
  h?: string;
  m?: boolean;
  o: string[];
}

/** Longest question text kept in the blob (display only — the answers map is keyed by the ORIGINAL,
 *  untruncated text, so a capped question can still be answered). */
const QUESTION_TEXT_MAX = 240;
/** Longest option label kept in the blob. */
const QUESTION_LABEL_MAX = 60;

/** Ellipsis-cap shared by the blob builder and the answer re-mapper, so the two can never disagree
 *  about what the phone was actually shown. A capped string is exactly `n` characters long. */
function cap(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** One raw CC question, narrowed. */
type RawQuestion = { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown } | null;

/** A question CC sent that is both SHOWABLE and ANSWERABLE, with its ORIGINAL (untruncated) text and
 *  option labels. */
interface UsableQuestion { text: string; raw: RawQuestion; labels: string[] }

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
    if (Array.isArray(raw?.options)) {
      for (const opt of raw.options) {
        const label = (opt as { label?: unknown } | null)?.label;
        if (typeof label === "string" && label.length > 0) labels.push(label);
      }
    }
    if (labels.length === 0) continue;
    out.push({ text, raw, labels });
  }
  return out;
}

/** The first showable question's raw text, or "" — shared by the summary and the detail builders. */
function firstQuestionText(toolInput: Record<string, unknown>): string {
  return usableQuestions(toolInput)[0]?.text ?? "";
}

/** The AskUserQuestion choice list, compacted for the wire: one entry per question with its text, the
 *  optional short header, the multi-select flag (present only when true), and the option LABELS.
 *  Option `description`s are dropped outright — they are by far the fattest thing in a CC question
 *  payload and the phone's rows show labels only. Returns [] for any tool that isn't a question (no
 *  `questions` array), so the blob field is simply absent for every other tool.
 *
 *  Pure, never throws: an entry with no text or NO usable option (unanswerable — see usableQuestions)
 *  is skipped rather than poisoning the hold. Truncation is display-only — `answerLine` re-maps the
 *  phone's echo back onto the ORIGINAL labels, so a capped label never reaches CC. */
export function buildPermissionQuestions(toolInput: Record<string, unknown>): PermissionQuestion[] {
  return usableQuestions(toolInput).map(({ text, raw, labels }) => ({
    q: cap(text, QUESTION_TEXT_MAX),
    ...(typeof raw?.header === "string" && raw.header.length > 0 ? { h: raw.header } : {}),
    ...(raw?.multiSelect === true ? { m: true } : {}),
    o: labels.map((l) => cap(l, QUESTION_LABEL_MAX)),
  }));
}

/** The worker's hard ceiling on a decision POST's base64 `blob` (MAX_BLOB_CHARS, server/src/cc.ts):
 *  an oversized frame is rejected 400 and the hold never reaches the phone. Sized so the blob plus the
 *  rest of the ActivityKit content-state stays inside APNs' ~4 KB Live Activity budget — raising it is
 *  a worker+APNs decision, NOT a plugin one. FROZEN cross-repo constant. */
const MAX_BLOB_CHARS = 3072;
/** Slack left under the ceiling. The frame-size prediction below is EXACT (AES-GCM ciphertext is the
 *  same length as its plaintext), so this is belt-and-braces against a future blob key landing between
 *  the fit and the seal — it is NOT a licence to overshoot. Every field the fit adds must be MEASURED:
 *  the "…" floor alone costs ~76 sealed chars (permissionDetail + permissionDetailOmitted), more than
 *  this whole margin, which is exactly how over-cap frames used to escape (see the FLOOR GUARD below). */
const BLOB_FIT_MARGIN = 64;
/** The base64-char budget `fitPermissionDetail` fits the whole sealed frame into. */
export const BLOB_FIT_CHARS = MAX_BLOB_CHARS - BLOB_FIT_MARGIN;
/** Sanity bound on the raw detail before fitting — nothing near it could ever fit, and it keeps the
 *  binary search's JSON work bounded on a pathological input. Text dropped here is still COUNTED into
 *  `omitted`, so the phone's "N characters omitted" note stays truthful. */
const MAX_DETAIL_CHARS = 20_000;

/** Exact base64 length of the sealed frame for `plaintextBytes` bytes: `encryptBlob` emits
 *  base64(iv‖ct‖tag) with a 12-byte IV and a 16-byte GCM tag, and GCM ciphertext is byte-for-byte the
 *  length of its plaintext — so the size is a pure function of the JSON's UTF-8 byte length. */
export function sealedBlobChars(plaintextBytes: number): number {
  return Math.ceil((12 + plaintextBytes + 16) / 3) * 4;
}

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
  // first claim on the budget: keep them iff the frame fits with them and NO detail at all. They are
  // all-or-nothing — a partially shown option list would be a lie, and the phone degrades cleanly to
  // the read-only prompt when the field is absent. The candidate frame is measured WITH the worst-case
  // `permissionDetailOmitted`, so keeping the questions stays valid even on the drop-the-detail-entirely
  // branch below (where that key is present and the detail is not).
  const kept = questions.length > 0 && measure("", worstCase, questions) <= maxChars ? questions : [];
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
      emit(allowAlwaysLine(agent, toolName, toolInput, suggestions)); trace({ event: "emit", decision: "allow_always" }); return "emitted";
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
    const base = buildBlob(input, machine, record?.title, plan, agent, record?.turnStartedAt, record?.label, record?.model);
    const permissionBase = {
      ...base, status: "decisionPending", permissionSummary: summary, permissionRequestId: requestId,
      permissionToolName: toolName,
    };
    const fitted = fitPermissionDetail(
      permissionBase, buildPermissionDetail(toolName, toolInput), BLOB_FIT_CHARS,
      buildPermissionQuestions(toolInput),
    );
    const blob = await encryptBlob(config.e2eKey, permissionFrame(permissionBase, fitted.detail, fitted.omitted, fitted.questions));
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
            { requestId?: unknown; decision?: unknown; message?: unknown; answers?: unknown };
          const match = answer.requestId === requestId;
          // A matched, KNOWN decision either emits one line ("emitted") or deliberately emits nothing
          // and lets the hold go ("released" — see THE RELEASE RULE in emitDecision); both are DONE. A
          // requestId MISMATCH is a replay/stale answer (silent, done — unchanged). The ONE keep-polling
          // case is a matched but UNRECOGNIZED decision verb (newer phone, older plugin): we skip the
          // return and fall through to the sleep so a decision we DO understand can still land.
          const outcome: DecisionOutcome = match
            ? emitDecision(agent, answer, toolName, toolInput, suggestions, emit, trace)
            : "released";
          if (outcome !== "keep-polling") {
            trace({ event: "answered", match, outcome });
            trace({ event: "exit", reason: "answered" });
            return; // done — exactly one line emitted, or zero (release / mismatch)
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
