// hook — the SHARED hook implementation for BOTH the Claude Code and Codex CLI bridges (v2:
// pairing + E2E). This module has NO top-level entry (no `import.meta.main` block) on purpose: the
// two thin entry files — cc-status.ts (Claude) and codex-status.ts (Codex) — each import runHook from
// here and call it with their own AgentKind. Keeping the entry OUT of this module is what lets both
// bundles include it without double-firing the other agent's entry (Bun's bundler collapses every
// entrypoint into one file and rewrites each `import.meta.main` to the SAME runtime check, so an
// entry block in an IMPORTED entrypoint would run too — hence the strict "entries never import
// entries" split; codex-status.ts imports THIS, not cc-status.ts).
//
// Reads the hook JSON from stdin, plans a v2 envelope (op + prio + an E2E-encrypted blob), and POSTs
// it to the Worker, which is a BLIND relay: it never sees plaintext. Contract with the agent: NOTHING
// on stdout, exit 0 no matter what, give up after 2 seconds — a dead network must never stall or
// derail a session. cc-status.ts re-exports this module's whole surface, so existing importers/tests
// that reference "./cc-status" are unaffected.
//
// PORTABILITY: runs unmodified under bun AND node >= 18. No `Bun.*` APIs — stdin is read via the
// async-iterable process.stdin, file IO via node:fs/promises (shared helpers). build.ts bundles
// this (inlined into each entry) to a .mjs.

import { readdir, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename } from "node:path";
import { encryptBlob } from "./crypto";
import {
  adapterFor, claudeToolDetail, codexToolDetail, findProvisionalForPid, requestUserInputDetail,
  SessionCreationSuppression, TrackedSessionLite,
} from "./adapter";
import {
  AgentKind, appendFittedPlanAndDebug, atomicWrite, CCOp, CCStatus, codexCompanionBrokerEvidence, Config, decisionHoldFileName, ensureWatchdog, formatPlanPickerDebug, fullTextForRecord, GONE_STRIKE_LIMIT,
  LAST_SEND_PATH, lastHookPath, loadConfig, loadPendingConfig, localApprovalsState, PENDING_STASH_PATH, PendingEventStash, pidAncestors, pidCommand, PLUGIN_VERSION, readPrefix,
  readRecord, recordGoneStrike, removeRevokedConfig, resetGoneStrikes, SessionOrigin, SessionRecord, SESSIONS_DIR, tracePlanPickerDecision, traceSession,
} from "./shared";

export { SESSION_TRACE_PATH } from "./shared";

// Re-export the per-agent title/interrupt/tool-detail surface so existing importers (and cc-status's
// `export *`, which many tests import through) keep seeing sessionTitle / codexIndexTitle / etc.
export * from "./adapter";

/** The plan for one hook event: the v2 op + delivery prio (APNs mechanics) and the semantic status
 *  that will ride INSIDE the encrypted blob (invisible to the worker). Null → the hook is ignored. */
export interface OpPlan {
  op: CCOp;
  prio: 0 | 1;
  status: CCStatus;
}

/// Tool → semantic sub-status key. The two agents' halves live in their adapters (claudeToolDetail /
/// codexToolDetail — see adapter.ts for the per-key rationale); they merge with ZERO key collisions,
/// so this single merged lookup covers whichever agent fired the hook. Unknown tools (e.g. MCP) get
/// no detail rather than a wrong guess — the phone then just shows "Working".
const TOOL_DETAIL: Record<string, string> = { ...claudeToolDetail, ...codexToolDetail };

// ---- session provenance + operational trace -------------------------------------------------

/** Build the local record provenance from hook stdin plus the exact process command that invoked this
 *  hook. Exported so non-hook record creators (the Codex notify backstop) can use the same shape. */
export function sessionOrigin(
  input: Record<string, unknown>, ppid: number = process.ppid, command: string | undefined = pidCommand(ppid),
): SessionOrigin {
  const stringField = (key: string): string | undefined =>
    typeof input[key] === "string" && (input[key] as string).length > 0 ? input[key] as string : undefined;
  return {
    hook_event_name: stringField("hook_event_name") ?? "",
    ...(stringField("source") ? { source: stringField("source") } : {}),
    ...(stringField("agent_id") ? { agent_id: stringField("agent_id") } : {}),
    ...(stringField("agent_type") ? { agent_type: stringField("agent_type") } : {}),
    ...(stringField("cwd") ? { cwd: stringField("cwd") } : {}),
    ppid,
    ...(typeof command === "string" && command.length > 0 ? { ppid_command: command } : {}),
  };
}

/** The working sub-status for a tool hook: the tool's label before it runs, "thinking" after. A Codex
 *  Plan question carries its encrypted first-question preview instead of a generic tool label. */
export function detailForHook(hookName: string, toolName?: string, toolInput?: unknown): string | undefined {
  if (hookName === "PreToolUse" && toolName === "request_user_input") {
    return requestUserInputDetail(toolInput);
  }
  if (hookName === "PreToolUse") return toolName ? TOOL_DETAIL[toolName] : undefined;
  if (hookName === "PostToolUse") return "thinking";
  return undefined;
}

/// Notification fires for BOTH a real permission prompt and the ~60s idle "Claude is waiting
/// for your input" nudge. Only the permission case actually needs the user — the idle nudge must
/// not flip a finished/working session to "needs help". Mirrors the reference app's `isPerm` gate.
export function isPermissionNotification(i: Record<string, unknown>): boolean {
  const type = typeof i.notification_type === "string" ? i.notification_type : "";
  const msg = (typeof i.message === "string" ? i.message : "").toLowerCase();
  return type === "permission_prompt" || msg.includes("permission") || msg.includes("approve") || msg.includes("allow");
}

/// Tools that block on the USER (not on the machine): Claude presents them and then WAITS for a human
/// answer/approval before it can continue — AskUserQuestion/request_user_input park on a
/// multiple-choice question, while ExitPlanMode parks on plan approval. A PreToolUse for any of them
/// is the EARLIEST signal the session is
/// blocked on the user, so planOp maps it to the SAME op/prio/status a PermissionRequest sends
/// (update / prio 1 / needsAttention) instead of a generic working update — the phone alerts the instant
/// agent parks, not ~5 min later when an idle notification or stale timeout fires. The matching
/// PostToolUse (user answered) falls through to the normal working path. Mirrored by each adapter's
/// watchdog backstop for the case where this very PreToolUse hook is dropped.
const USER_BLOCKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "request_user_input"]);

/// The LOCAL op planner (the worker is now blind — lifecycle semantics live here). Maps a hook to a
/// v2 op, its delivery prio, and the semantic status carried in the blob:
///   SessionStart                                → start,  prio 0, working
///   UserPromptSubmit / PostToolUse              → update, prio 0, working
///   PreToolUse (ordinary tool)                  → update, prio 0, working
///   PreToolUse (AskUserQuestion / ExitPlanMode) → update, prio 1, needsAttention  (blocked on the user)
///   Notification (permission only) / PermissionRequest → update, prio 1, needsAttention
///   Stop                                        → done,   prio 0, done
///   SessionEnd                                  → end,    prio 0, done
/// Re-arm: a SessionStart AFTER an op:done was sent for this session (sentDone) restarts as a fresh
/// `update`/working — the session already exists in the worker, so it's an update, not a new start.
/// The update-mapped hooks are already `update`, so they naturally re-arm (and clear sentDone) too.
export function planOp(hookName: string, input: Record<string, unknown>, sentDone: boolean): OpPlan | null {
  switch (hookName) {
    case "SessionStart":
      return sentDone
        ? { op: "update", prio: 0, status: "working" }
        : { op: "start", prio: 0, status: "working" };
    case "PreToolUse": {
      // A PreToolUse for a user-blocking tool is an INSTANT needsAttention (same op/prio/status a
      // PermissionRequest sends); every other tool is a normal working update. The status flows through
      // buildBlob's `plan.status` exactly like the PermissionRequest path — no divergent blob.
      const tool = typeof input.tool_name === "string" ? input.tool_name : "";
      return USER_BLOCKING_TOOLS.has(tool)
        ? { op: "update", prio: 1, status: "needsAttention" }
        : { op: "update", prio: 0, status: "working" };
    }
    case "UserPromptSubmit":
    case "PostToolUse":
      return { op: "update", prio: 0, status: "working" };
    case "Notification":
      // Drop the idle-waiting Notification so it can't masquerade as "needs help".
      if (!isPermissionNotification(input)) return null;
      return { op: "update", prio: 1, status: "needsAttention" };
    case "PermissionRequest":
      return { op: "update", prio: 1, status: "needsAttention" };
    case "Stop":
      return { op: "done", prio: 0, status: "done" };
    case "SessionEnd":
      return { op: "end", prio: 0, status: "done" };
    default:
      return null;
  }
}

/** How much of the transcript head to scan (title scanners + start-time extractor share this one
 *  bounded read). Both the first user message and CC's first ai-title sit in the opening lines; 128 KB
 *  covers hundreds of JSONL rows without reading the whole (multi-MB, ever-growing) file. */
const TITLE_SCAN_BYTES = 128 * 1024;

/// The session's TRUE start (epoch ms), read from the transcript head — the SAME bounded prefix the
/// title scanners read, so it adds no second file read. One scan covers BOTH agents because they share
/// a line shape here: the first parseable JSONL line that carries a top-level string `timestamp`
/// (ISO-8601) is the session's first real entry.
///   - Claude's transcript OPENS with meta lines (last-prompt / mode / permission-mode) that have NO
///     timestamp; its first real entry (SessionStart / a user turn) does — verified against a live
///     `~/.claude/projects/*/*.jsonl` (e.g. `"timestamp":"2026-07-07T16:14:10.165Z"`).
///   - Codex's first rollout line is `{"timestamp":"…Z","type":"session_meta","payload":{…}}` — the
///     top-level timestamp — verified against `~/.codex/sessions/2026/.../rollout-*.jsonl`.
/// Scanning top-down and returning the FIRST valid timestamp yields the earliest entry in the head.
/// Malformed / missing / not-yet-flushed → undefined (the worker then keeps its first-seen fallback).
export function transcriptStartMs(prefix: string): number | undefined {
  for (const line of prefix.split("\n")) {
    if (!line.includes("\"timestamp\"")) continue; // cheap pre-filter — skip the timestamp-less meta rows
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; } // a byte-sliced final line / non-JSON → skip
    if (typeof row !== "object" || row === null) continue;
    const ts = (row as Record<string, unknown>).timestamp;
    if (typeof ts !== "string") continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/** The plaintext content of the encrypted blob: the semantic status, the optional tool detail, the
 *  display fields (title/machine/label), and the optional per-turn anchor. This is ALL the worker
 *  never sees. Shape must match the Swift `CCBlobPlaintext` the phone/widget decode.
 *
 *  `pinnedLabel` — the session's FIRST-SEEN label (from its record) — wins over the event's cwd when
 *  given: a mid-session `cd` changes input.cwd on every later hook, and re-deriving the label per event
 *  silently renamed the phone row / island folder chip (observed live: "api-status" → "server" after a
 *  `cd server`). Absent/empty → first event (or a recordless caller): derive from cwd as before. */
export function buildBlob(input: Record<string, unknown>, machine: string, title: string | undefined, plan: OpPlan, agent: AgentKind = "claude", turnStartedAt?: number, pinnedLabel?: string, model?: string, at?: number, proposedPlan?: string, dbgOverride?: string): {
  status: CCStatus; detail?: string; title: string; machine: string; label: string; agent?: AgentKind; turnStartedAt?: number; model?: string; at?: number; plan?: string; dbg?: string;
} {
  const label = typeof pinnedLabel === "string" && pinnedLabel.length > 0
    ? pinnedLabel
    : typeof input.cwd === "string" && input.cwd.length > 0 ? basename(input.cwd) : "session";
  const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const detail = detailForHook(
    hookName,
    typeof input.tool_name === "string" ? input.tool_name : undefined,
    input.tool_input,
  );
  // The `agent` key is OMITTED for claude (byte-identical to the pre-codex blob so old Swift builds and
  // the existing snapshots are unaffected) and the literal "codex" for a codex session. `turnStartedAt`
  // (epoch SECONDS — the current turn's start, see runHook) is likewise OMITTED when unknown, so a blob
  // from a session with no prompt seen yet stays byte-identical to a pre-0.3.5 one. `model` (v0.8.5 —
  // the session's raw model id, e.g. "claude-fable-5" / "gpt-5-codex", resolved by the adapter's
  // optional model seam) follows the same rule: OMITTED entirely when unknown, never an empty string;
  // the phone hides its badge when the key is absent.
  //
  // `at` (v1.1.6 — epoch SECONDS, the SAME unit as `turnStartedAt`, NOT the envelope's ms `ts`) freezes
  // the REAL activity time of the hook event this blob reports. It is the phone's honest sort/age key:
  // the worker stamps EVERY inbound frame (including the watchdog's 5-min staleness heartbeats, which
  // re-send this blob VERBATIM) into its `lastEventAt`, so an idle-open TUI that only ever gets
  // heartbeated looked eternally fresh and never aged out. Because the heartbeat re-sends this blob byte
  // for byte, `at` stays pinned at the last REAL event and the phone can age the row correctly.
  // PINNED CROSS-REPO CONTRACT: key `at`, epoch seconds. It remains after `model`; the OPTIONAL Plan
  // picker `plan` key is appended after EVERY existing key and omitted everywhere except a proven
  // pending picker. The optional `dbg` follows `plan` LAST and is the first budget sacrifice.
  const base = {
    status: plan.status, title: title ?? "", machine, label,
    ...(detail ? { detail } : {}),
    ...(agent === "codex" ? { agent: "codex" as const } : {}),
    ...(typeof turnStartedAt === "number" && Number.isFinite(turnStartedAt) ? { turnStartedAt } : {}),
    ...(typeof model === "string" && model.length > 0 ? { model } : {}),
    ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
  };
  const dbg = agent === "codex"
    ? dbgOverride ?? formatPlanPickerDebug({
      event: hookName || "event",
      classifier: plan.status === "needsAttention" ? "attn" : plan.status === "working" ? "work" : "done",
      by: "h",
    })
    : undefined;
  return appendFittedPlanAndDebug(base, proposedPlan, dbg);
}

/** The wire envelope for one hook event: the blind v2 shape
 *  `{v:2, sessionId, op, prio, ts, attentionKind?, blob?}`.
 *  A genuine hook SessionEnd carries a fresh E2E-encrypted `done` blob so the worker can retain a
 *  truthful terminal history row. Internal reaper/reset end envelopes remain blob-less and therefore
 *  keep their hard-delete meaning. Null when the hook is ignored (unknown/dropped) or has no session id. `sentDone`
 *  drives the re-arm (a start after a done becomes an update). The clear `attentionKind` is deliberately
 *  narrow and backward-compatible: ONLY Codex's request_user_input carries `"userInput"`, allowing the
 *  worker to distinguish a Plan question from an ordinary permission decision without reading `blob`. */
export async function buildEnvelope(
  input: unknown, machine: string, now: number, title: string | undefined, e2eKey: Uint8Array, sentDone: boolean,
  agent: AgentKind = "claude", startedAt?: number, turnStartedAt?: number, pinnedLabel?: string, model?: string,
  planOverride?: OpPlan, attentionKindOverride?: "userInput", proposedPlan?: string, dbg?: string,
  /** APPEND-LAST tee (NOM-44 phase 4). Called with the blob PLAINTEXT this envelope is about to seal,
   *  so the caller can compare the FITTED `plan` against the full one it passed in and persist the
   *  unabridged copy on the session record for the LAN `read` op. Purely observational — it runs before
   *  the seal, never mutates, and a throw is swallowed: a diagnostic tee must not break an envelope. */
  onBlobPlaintext?: (plain: ReturnType<typeof buildBlob>) => void,
): Promise<Record<string, unknown> | null> {
  if (typeof input !== "object" || input === null) return null;
  const i = input as Record<string, unknown>;
  if (typeof i.session_id !== "string" || i.session_id.length === 0) return null;
  const hookName = typeof i.hook_event_name === "string" ? i.hook_event_name : "";
  const plan = planOverride ?? planOp(hookName, i, sentDone);
  if (!plan) return null;
  // startedAt (epoch ms, matching `ts`'s unit) rides on EVERY op — including end, whose final frame the
  // worker times too. OMITTED when unknown so the wire stays byte-identical to an old plugin's post.
  const base: Record<string, unknown> = { v: 2, sessionId: i.session_id, op: plan.op, prio: plan.prio, ts: now };
  if (typeof startedAt === "number" && Number.isFinite(startedAt)) base.startedAt = startedAt;
  // turnStartedAt, model, and `at` ride INSIDE the encrypted blob only. `attentionKind` below is the one
  // intentional optional clear discriminator; absent events retain the byte-compatible legacy shape.
  // `at` is the real event time (`now`) in epoch SECONDS — the phone's honest sort/age key, frozen here
  // and re-sent verbatim by every watchdog heartbeat so an idle-but-heartbeated session ages out.
  const at = Math.floor(now / 1000);
  const plaintext = buildBlob(i, machine, title, plan, agent, turnStartedAt, pinnedLabel, model, at, proposedPlan, dbg);
  try { onBlobPlaintext?.(plaintext); } catch { /* a tee must never break an envelope */ }
  const blob = await encryptBlob(e2eKey, plaintext);
  const attentionKind = attentionKindOverride ?? (
    agent === "codex" && hookName === "PreToolUse" && i.tool_name === "request_user_input"
      ? "userInput" as const
      : undefined
  );
  return { ...base, ...(attentionKind ? { attentionKind } : {}), blob };
}

/** The pending-pairing stash for THIS hook, or null when there's nothing to stash. Built from the same
 *  planOp + buildBlob the paired path uses, but WITHOUT the e2eKey (still unknown mid-pairing) — the
 *  plaintext blob is stashed and encrypted later, at flush, by completePendingPairing. sentDone is
 *  fixed false: no session record is tracked while pairing, so there is no done to re-arm from. An
 *  op:end is skipped even though a paired SessionEnd carries a terminal blob: a session that ended
 *  before pairing completed must not materialize as a history-only row on first connection. */
export function buildPendingStash(
  input: Record<string, unknown>, machine: string, title: string | undefined, now: number, pid: number = process.ppid,
  agent: AgentKind = "claude", model?: string,
): PendingEventStash | null {
  if (typeof input.session_id !== "string" || input.session_id.length === 0) return null;
  const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const plan = planOp(hookName, input, false);
  if (!plan || plan.op === "end") return null;
  // Record the session's `claude`/`codex` process (process.ppid — the same notion trackSession/the
  // watchdog use) so the flush can drop the stash if that terminal was closed while pairing was still
  // pending (its later hooks no-op'd, so no watchdog was ever attached) instead of resurrecting a ghost.
  // The agent rides inside the stashed plaintext blob (via buildBlob), so it survives the flush.
  // turnStartedAt is stamped ONLY when the stashed hook ITSELF is the turn opener (UserPromptSubmit):
  // mid-pairing there is no session record to read a cached anchor from, so any other hook's turn
  // start is genuinely unknown and the blob omits it (the widget falls back to `startedAt`).
  const turnStartedAt = hookName === "UserPromptSubmit" ? Math.floor(now / 1000) : undefined;
  // `model` rides inside the stashed plaintext blob (like `agent`), so the flush's first pairing
  // frame carries it and the flush-written session record can cache it. `at` (epoch seconds of the
  // stashing hook's real event) rides the same way, so the first flushed frame carries an honest
  // activity time for the phone to age by.
  const at = Math.floor(now / 1000);
  return { sessionId: input.session_id, op: plan.op, prio: plan.prio, blob: buildBlob(input, machine, title, plan, agent, turnStartedAt, undefined, model, at), stashedAt: now, pid };
}

/** Stash THIS hook's plaintext event next to config.json (owner-only, like config.json) so the pairing
 *  completer can flush it the instant it derives the key. Called from main() only while mid-pairing.
 *  Best-effort: a missed stash just leaves the phone waiting for the next hook, as it does today. */
export async function stashPendingEvent(
  input: Record<string, unknown>, machine: string, title: string | undefined, now: number,
  stashPath = PENDING_STASH_PATH, pid: number = process.ppid, agent: AgentKind = "claude", model?: string,
): Promise<void> {
  try {
    const stash = buildPendingStash(input, machine, title, now, pid, agent, model);
    if (!stash) return;
    await atomicWrite(stashPath, JSON.stringify(stash), 0o600);
  } catch {
    // best-effort — never surface into a Claude Code session
  }
}

/** Per-session liveness bookkeeping. Record the session's `claude` process (process.ppid) so a
 *  detached watchdog can notice a force-killed terminal that fires no SessionEnd hook; on op:end,
 *  delete the record instead (nothing to reap). Persists the op/prio/blob so the watchdog can re-send
 *  a staleness heartbeat verbatim, and `sentDone` so the next hook re-arms correctly. Best-effort. */
export async function trackSessionAt(
  sessionsDir: string,
  sessionId: string, op: CCOp, prio: 0 | 1, status: CCStatus, blob: string | undefined,
  machine: string, label: string, transcript: string, agent: AgentKind = "claude", sessionStartedAt?: number,
  turnStartedAt?: number, turnId?: string, title?: string, pairingId?: string, model?: string,
  pendingPlanPicker: boolean = false, pid: number = process.ppid, origin?: SessionOrigin,
  planPickerVerificationPending: boolean = false, dbg?: string, attentionKind?: "userInput",
  planFull?: string,
): Promise<void> {
  try {
    const path = `${sessionsDir}/${sessionId}.json`;
    if (op === "end") {
      await unlink(path).catch(() => {}); // clean exit → no watchdog reaping needed
      // A hold marker cannot outlive its session. Normally the holding hook's own `finally` retires it,
      // but that never runs on a SIGKILL (or the SIGTERM a closed terminal sends), and the feed's
      // liveness/TTL guards only make such a marker INERT — they do not remove the file. This is the
      // chokepoint where "the session is over" is known, so nothing of it is left behind.
      await unlink(`${sessionsDir}/${decisionHoldFileName(sessionId)}`).catch(() => {});
      return;
    }
    // lastEvent is the watchdog interrupt-net's gate key: a fresh `start` is a quiet "sessionStart",
    // otherwise the semantic status (working / needsAttention / done). `agent` (omitted for claude)
    // tells the watchdog which interrupt marker to scan the transcript tail for.
    const recordedAt = Date.now();
    const record: SessionRecord = {
      pid,
      machine,
      label,
      ts: recordedAt,
      transcript,
      lastEvent: op === "start" ? "sessionStart" : status,
      sentDone: op === "done",
      // The done's delivery ACK marker, stamped PESSIMISTICALLY. This record is written BEFORE the POST
      // is attempted (see the call site), so `sentDone` alone claimed the done had landed even when the
      // POST then non-2xx'd / timed out / threw — the worker kept the previous op:"update" and the phone
      // showed the session running forever, with every watchdog self-heal net gated off on exactly that
      // done state. Assuming NOT-delivered until proven otherwise is what makes a THROWN fetch (which
      // skips all post-POST bookkeeping) still leave the debt on disk; markDoneDelivered clears it on a
      // confirmed 2xx and the watchdog's correctPendingDone re-POSTs whatever is left over.
      ...(op === "done" ? { donePending: true } : {}),
      op,
      prio,
      ...(blob ? { blob } : {}),
      ...(agent === "codex" ? { agent } : {}),
      // Cache the parsed start so the next hook and the watchdog re-send it without re-reading the
      // transcript (and so it survives the transcript later going away). Omitted when unknown.
      ...(typeof sessionStartedAt === "number" && Number.isFinite(sessionStartedAt) ? { sessionStartedAt } : {}),
      // Cache the turn anchor (epoch SECONDS, stamped by UserPromptSubmit) the same way, so the turn's
      // later hooks and the watchdog's corrective done thread the SAME value into their blobs.
      ...(typeof turnStartedAt === "number" && Number.isFinite(turnStartedAt) ? { turnStartedAt } : {}),
      // Bind this record to its Codex turn (the hook input's `turn_id`) so the notify backstop can tell
      // a stale turn-N notify from the live turn N+1. Claude has no turn_id → omitted (guard inert).
      ...(typeof turnId === "string" && turnId.length > 0 ? { turnId } : {}),
      // The last NON-EMPTY display title (callers thread `title ?? previousRecord.title`). The
      // watchdog's corrective done/needsAttention envelopes rebuild their blobs from this record, and
      // without a cached title they'd re-push title:"" — the phone then falls back to the folder-name
      // label. Omitted when no title has ever resolved.
      ...(typeof title === "string" && title.length > 0 ? { title } : {}),
      // The last NON-EMPTY model id (callers thread `model ?? previousRecord.model`, like title), so
      // the watchdog's rebuilt done/needsAttention blobs keep the phone's model badge instead of
      // dropping it. Omitted when no model has ever resolved.
      ...(typeof model === "string" && model.length > 0 ? { model } : {}),
      // The pairing this record's `blob` was SEALED under. A re-pair rotates the key; the watchdog's
      // staleness heartbeat re-sends `blob` verbatim, so it must only do that while the pairing that
      // sealed it is still the live one — otherwise the phone renders an undecryptable ghost forever.
      ...(typeof pairingId === "string" && pairingId.length > 0 ? { pairingId } : {}),
      ...(pendingPlanPicker ? { pendingPlanPicker: true } : {}),
      ...(planPickerVerificationPending ? { planPickerVerificationPending: true } : {}),
      ...(pendingPlanPicker || planPickerVerificationPending ? { planPickerPendingSince: recordedAt } : {}),
      ...(typeof dbg === "string" && dbg.length > 0 ? { dbg } : {}),
      ...(origin ? { origin } : {}),
      // APPENDED LAST (NOM-44 phase 3, mirroring how model/pairingId were added): the clear
      // `attentionKind` discriminator this event POSTed. It rides the worker envelope already; the LAN
      // frames feed rebuilds its frames from THIS record, so without the cache a Codex
      // `request_user_input` would reach the phone over LAN looking like a plain approval. Written
      // through on every event (so a later working/done event drops it — the record is rebuilt whole
      // here, never patched) and OMITTED when the event has none, keeping every existing record's bytes
      // byte-identical.
      ...(attentionKind ? { attentionKind } : {}),
      // APPENDED LAST (NOM-44 phase 4). The UNABRIDGED plan markdown, present ONLY when the blob's
      // `plan` key had to be cut (or dropped) to fit the worker's 3072-char sealed ceiling — the caller
      // passes fullTextForRecord(proposedPlan, <the fitted plan buildBlob produced>), which is undefined
      // whenever the whole thing already rode. Written through like every field here (the record is
      // rebuilt whole, never patched), so the next event of this session drops it automatically.
      ...(typeof planFull === "string" && planFull.length > 0 ? { planFull } : {}),
    };
    // Owner-only (0600): the record carries hostname, cwd basename, the session pid, and the ABSOLUTE
    // transcript path — never group/world readable, matching config.json / the pending stash.
    await atomicWrite(path, JSON.stringify(record), 0o600);
  } catch {
    // Bookkeeping is best-effort; on failure the server's one-hour eviction is still the backstop.
  }
}

/** Production wrapper for the fixed on-disk sessions root. Tests that exercise write/read glue use
 *  trackSessionAt with a temp directory so a live production watchdog can never observe their rows. */
export async function trackSession(
  sessionId: string, op: CCOp, prio: 0 | 1, status: CCStatus, blob: string | undefined,
  machine: string, label: string, transcript: string, agent: AgentKind = "claude", sessionStartedAt?: number,
  turnStartedAt?: number, turnId?: string, title?: string, pairingId?: string, model?: string,
  pendingPlanPicker: boolean = false, pid: number = process.ppid, origin?: SessionOrigin,
  planPickerVerificationPending: boolean = false, dbg?: string, attentionKind?: "userInput",
  planFull?: string,
): Promise<void> {
  return trackSessionAt(
    SESSIONS_DIR,
    sessionId, op, prio, status, blob, machine, label, transcript, agent, sessionStartedAt,
    turnStartedAt, turnId, title, pairingId, model, pendingPlanPicker, pid, origin,
    planPickerVerificationPending, dbg, attentionKind, planFull,
  );
}

/** Clear the done-delivery debt trackSession stamped: called ONLY after an op:done POST came back 2xx,
 *  so the watchdog's correctPendingDone net has nothing to re-send. Read-modify-write rather than a
 *  blind rewrite: the POST took up to 2 s, and a concurrent sweep may have touched the record in that
 *  window — we must clear only the marker, never resurrect the pre-POST snapshot. `donePending:
 *  undefined` drops the key on stringify (the same idiom the watchdog's doneAttempts clears use).
 *  Best-effort: a failed clear only costs one redundant re-POST that the worker dedupes. */
export async function markDoneDeliveredAt(sessionsDir: string, sessionId: string): Promise<void> {
  try {
    const record = await readRecord(sessionId, sessionsDir);
    if (!record || record.donePending !== true) return; // already clear (or the record is gone) → nothing owed
    await atomicWrite(`${sessionsDir}/${sessionId}.json`, JSON.stringify({ ...record, donePending: undefined }), 0o600);
  } catch {
    // Bookkeeping is best-effort, exactly like trackSession's own write.
  }
}

export async function markDoneDelivered(sessionId: string): Promise<void> {
  return markDoneDeliveredAt(SESSIONS_DIR, sessionId);
}

/** Reconcile a provisional discovery (see cc-watchdog's discovery step): a real hook has now fired for
 *  this codex TUI, so end + delete any PROVISIONAL session the watchdog surfaced ahead of it. Matches by
 *  pid — the hook's process.ppid is the codex TUI process, which is the provisional's pid (with an
 *  ancestor-walk fallback; see findProvisionalForPid). POSTs an op:end for the sentinel sessionId (the
 *  worker reuses the last blob for the final frame) and deletes the provisional record ONLY on a 2xx —
 *  the watchdog's "delivered gates deletion" discipline (see postOutcomeForStatus there). A failed/
 *  timed-out POST leaves the file on disk because it is the ONLY retry handle: the worker still holds
 *  the ghost row, and both retry paths — the next codex hook landing here and the watchdog's
 *  reconcileProvisionalsSweep (~5s) — match provisionals BY THEIR FILE. Unlinking unconditionally
 *  orphaned the row for hours on a single dropped POST (observed live: codex-pid-40738). Best-effort
 *  otherwise. REMOVABLE with the discovery feature once openai/codex#15269 ships. */
async function reconcileProvisional(config: Config, hookPid: number): Promise<void> {
  try {
    const files = await readdir(SESSIONS_DIR).catch(() => [] as string[]);
    const provisionals: { sessionId: string; pid: number }[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let r: SessionRecord;
      try { r = JSON.parse(await readFile(`${SESSIONS_DIR}/${f}`, "utf8")) as SessionRecord; } catch { continue; }
      if (r.provisional === true && typeof r.pid === "number") provisionals.push({ sessionId: basename(f, ".json"), pid: r.pid });
    }
    if (provisionals.length === 0) return;
    const sentinel = findProvisionalForPid(provisionals, hookPid, pidAncestors);
    if (!sentinel) return;
    let delivered = false;
    try {
      const res = await fetch(`${config.url}/v1/cc/event`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret, "x-cc-version": PLUGIN_VERSION, "x-cc-approvals": await localApprovalsState() },
        body: JSON.stringify({ v: 2, sessionId: sentinel, op: "end", prio: 0, ts: Date.now() }),
        signal: AbortSignal.timeout(2000),
      });
      delivered = res.ok; // 2xx only — a 401/5xx did NOT retire the worker's row
    } catch { /* network failure / timeout → keep the file so the retry paths above can re-send */ }
    if (delivered) await unlink(`${SESSIONS_DIR}/${sentinel}.json`).catch(() => {});
  } catch {
    // best-effort — never surface into a session
  }
}

/** Every tracked session's ghost-check projection (id + pid + provisional + agent), read best-effort
 *  from SESSIONS_DIR. Feeds AgentAdapter.isChildSessionGhost — the codex app-server child-session
 *  guard needs to know whether some OTHER real session already owns this hook's pid. */
async function readTrackedSessions(): Promise<TrackedSessionLite[]> {
  const files = await readdir(SESSIONS_DIR).catch(() => [] as string[]);
  const out: TrackedSessionLite[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(await readFile(`${SESSIONS_DIR}/${f}`, "utf8")) as SessionRecord;
      out.push({ sessionId: basename(f, ".json"), pid: r.pid, provisional: r.provisional, agent: r.agent, ts: r.ts });
    } catch { /* half-written / corrupt → skip */ }
  }
  return out;
}

/** Explicit lineage retirement for Claude `/clear`: post the predecessor's blob-less op:end and
 *  unlink its local record because Claude never emits SessionEnd for that id. The unlink is deliberate
 *  even on a failed POST: leaving a same-live-pid record makes the watchdog believe the predecessor is
 *  healthy forever, while the worker's bounded eviction remains the network-failure backstop. */
async function retireLineageSession(
  config: Config,
  sessionId: string,
  agent: AgentKind,
  input: Record<string, unknown>,
  reason: string,
): Promise<void> {
  let delivered = false;
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
      body: JSON.stringify({ v: 2, sessionId, op: "end", prio: 0, ts: Date.now() }),
      signal: AbortSignal.timeout(2000),
    });
    delivered = res.ok;
  } catch { /* best-effort; local unlink + worker eviction are the fallback */ }
  await unlink(`${SESSIONS_DIR}/${sessionId}.json`).catch(() => {});
  traceSession({
    event: "retire",
    sessionId,
    agent,
    hook_event_name: input.hook_event_name,
    source: input.source,
    reason,
    delivered,
  });
}

/** Read the whole of stdin (the hook JSON) as UTF-8. process.stdin is an async iterable of Buffers
 *  under both bun and node, so this needs no Bun-specific API. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/// The hook body, parametrized by which agent invoked it. Behavior for `claude` is byte-identical to
/// the historical main() (the module entry below calls runHook("claude")); the codex entry
/// (codex-status.ts) calls runHook("codex"). The ONLY agent-dependent branches are (a) the title
/// scanner — codex has no ai-title/user turns, so it reads the rollout's first user_message with a
/// UserPromptSubmit-prompt fallback for the very first prompt (the rollout may not have flushed yet) —
/// and (b) the `agent` key threaded into the blob / stash / session record. Both agents share the
/// same hook_event_name strings, so planOp/prio/op mapping is unchanged. The consecutive-gone strike
// helpers (readGoneStrikes/resetGoneStrikes/recordGoneStrike) live in shared so the watchdog's
// sweep counts against the SAME streak — see the shared-counter note there.
export async function runHook(agent: AgentKind): Promise<void> {
  try {
    const [config, raw] = await Promise.all([loadConfig(), readStdin()]);
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (typeof input.session_id !== "string" || input.session_id.length === 0) return;

    // Codex compat-layer guard: Codex ≥0.142 auto-discovers installed Claude Code plugins as hook
    // sources, so it can invoke cc-status.mjs — the CLAUDE entry (runHook("claude")) — inside a Codex
    // session. Left unguarded, that Codex event masquerades as a Claude session and lands on the wrong
    // tab on the phone. Two independent signals fingerprint a Codex-in-Claude event; EITHER restamps
    // the effective agent to codex for the whole run (blob agent field, session record agent, title
    // scanner):
    //   (a) turn_id — Codex's PER-TURN hook payloads carry a non-empty `turn_id` string; Claude's
    //       never do. This catches every event fired inside a turn.
    //   (b) transcript_path under "/.codex/" — session-scoped Codex events (SessionStart-shaped) carry
    //       NO turn_id (observed in the wild 2026-07-09, flipping Codex sessions onto the Claude tab),
    //       so (a) misses them. But their transcript still points at ~/.codex/sessions/rollout-*.jsonl,
    //       whereas Claude transcripts live under ~/.claude/projects/ — so a "/.codex/" path is a robust
    //       agent fingerprint even when turn_id is absent. Conservative (substring, not a parse): a
    //       "/.claude/" path can never match, so a real Claude run is never wrongly flipped.
    if (agent === "claude" && (
      (typeof input.turn_id === "string" && input.turn_id.length > 0) ||
      (typeof input.transcript_path === "string" && input.transcript_path.includes("/.codex/"))
    )) {
      agent = "codex";
    }
    // Select the per-agent adapter AFTER the restamp guard — this IS the adapter selection, so a
    // Codex-in-Claude event uses the codex adapter (title scanner + tool detail) for the whole run.
    const adapter = adapterFor(agent);

    // Hook-liveness stamp (per RESOLVED agent): rewritten on every invocation, BEFORE the pairing gate,
    // so status-cmd can tell "hooks are firing" from "the agent silently drops them" (Codex #16430/
    // #30835 — activity in the rollout but no stamp). Cheap (one small write; hooks run 8x/turn already)
    // and best-effort — a stamp failure must never derail the rest of the hook.
    await atomicWrite(lastHookPath(agent), String(Date.now())).catch(() => {});

    const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
    // The transcript head, read AT MOST ONCE per hook and shared by BOTH the title scanner and the
    // start-time extractor (so the start-time fix adds no second file read). "" when there's no
    // transcript yet or it's unreadable; the callers tolerate an empty scan.
    let prefixCache: string | undefined;
    const getPrefix = async (): Promise<string> => {
      if (prefixCache !== undefined) return prefixCache;
      prefixCache = "";
      if (transcriptPath.length > 0) {
        try { prefixCache = await readPrefix(transcriptPath, TITLE_SCAN_BYTES); } catch { /* no transcript yet */ }
      }
      return prefixCache;
    };

    // The session name. Read lazily (only the paired or mid-pairing paths need it) so a never-paired
    // machine's hooks stay fully inert. The per-agent resolution chain (codex: session_index
    // thread_name → rollout scan → UserPromptSubmit prompt; claude: freshest ai-title from a bounded
    // transcript TAIL → head ai-title → head first-user-prompt → UserPromptSubmit prompt) lives in
    // the adapter, which reads from the same bounded, memoized prefix the start-time extractor uses;
    // the transcript path rides alongside for the claude tail read (the freshest ai-title on a long
    // transcript sits near EOF, outside the head window — the model seam has the same shape).
    const readTitle = async (): Promise<string | undefined> =>
      adapter.title({ sessionId: input.session_id as string, prefix: await getPrefix(), input, transcriptPath });

    // The session's model id (v0.8.5), resolved by the adapter's OPTIONAL seam next to the title —
    // undefined when the adapter omits the seam or nothing resolves (the blob then omits `model`).
    // The transcript path rides alongside the memoized prefix because the freshest model sits at the
    // transcript TAIL (one bounded readSuffix inside the adapter).
    const readModel = async (): Promise<string | undefined> =>
      adapter.model?.({ sessionId: input.session_id as string, prefix: await getPrefix(), input, transcriptPath });

    // No completed config: normally inert. But if a pairing is PENDING (QR on screen, phone not yet
    // scanned), stash this hook's plaintext event — we have no e2eKey to POST with yet. The pairing
    // completer flushes it the moment it derives the key, so the phone shows the pairing session
    // immediately instead of empty-until-the-next-hook. Unpaired-and-not-pairing → still fully inert.
    if (!config) {
      const pending = await loadPendingConfig();
      if (pending) {
        const machine = pending.machineName ?? hostname().replace(/\.local$/, "");
        await stashPendingEvent(input, machine, await readTitle(), Date.now(), PENDING_STASH_PATH, process.ppid, agent, await readModel());
      }
      return;
    }

    const machine = config.machineName ?? hostname().replace(/\.local$/, "");
    const reportedSessionId = input.session_id as string;
    const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
    const sessionStartSource = typeof input.source === "string" ? input.source : "";
    const hookPid = process.ppid;
    const hookCommand = pidCommand(hookPid);
    let sessionId = reportedSessionId;
    let eventInput = input;
    let reusedForkPredecessor = false;

    // One record read serves the child-ghost guard, the sentDone re-arm, and the cached session
    // start. A cached start (an earlier hook parsed it) wins so we never re-parse and it survives the
    // transcript later vanishing; otherwise parse it from the same head `readTitle` reads (memoized —
    // no second read). Unknown → omitted from the envelope; the worker keeps its first-seen fallback.
    let existingRecord = await readRecord(reportedSessionId);
    // A retired-owner marker is deliberately not a tracked/visible session. Treat it as absent for all
    // creation guards: a genuine interactive hook will rebuild the file whole below, while a headless
    // `codex exec resume <id>` must still be suppressed instead of reviving the marker into a phone row.
    if (existingRecord?.agent === "codex" && typeof existingRecord.retiredAt === "number" &&
        Number.isFinite(existingRecord.retiredAt)) existingRecord = null;
    let trackedCache: TrackedSessionLite[] | undefined;
    const trackedSessions = async (): Promise<TrackedSessionLite[]> => {
      if (trackedCache === undefined) trackedCache = await readTrackedSessions();
      return trackedCache;
    };
    const suppress = (suppression: SessionCreationSuppression, extra: object = {}): void => traceSession({
      event: "suppress",
      sessionId: reportedSessionId,
      agent,
      hook_event_name: hookName,
      ...(sessionStartSource ? { source: sessionStartSource } : {}),
      ...suppression,
      ...extra,
    });

    // Claude's openai-codex companion tasks run a headless Codex app-server under a dedicated broker.
    // They are delegated rescue work, not user-owned Codex sessions, so they must never create phone
    // rows. Unlike title-based filtering, a `codex app-server` owner plus the broker's actual process
    // ancestry is structural proof:
    // its argv contains app-server-broker.mjs and/or a unix://…/<cxc-prefix>/broker.sock. Missing ps
    // data yields no evidence and fails open. This guard intentionally applies to an EXISTING record
    // too: a row minted by an older plugin is retired (op:end + local unlink) on its next event.
    const companionBroker = agent === "codex"
      ? codexCompanionBrokerEvidence(hookPid, pidAncestors, pidCommand)
      : null;
    if (companionBroker) {
      const reason = `broker ancestry proven by ${companionBroker.matchedBy}`;
      if (existingRecord) {
        await retireLineageSession(config, reportedSessionId, agent, input, `codex companion ${reason}`);
      }
      suppress({
        guard: "codex-companion-broker",
        reason,
      }, {
        brokerPid: companionBroker.pid,
        brokerMatch: companionBroker.matchedBy,
      });
      return;
    }

    // `/clear` lineage: Claude mints a new id on the SAME TUI process and never sends SessionEnd for
    // the predecessor. Retire the newest old Claude row before deciding whether the new id is ready
    // to surface. This is adapter-owned pid lineage; the shared pipeline only executes the retirement.
    const clearLineage = !existingRecord && hookName === "SessionStart" &&
      sessionStartSource === "clear" && adapter.clearPredecessor;
    if (clearLineage && adapter.clearPredecessor) {
      const predecessor = adapter.clearPredecessor({
        sessionId: reportedSessionId,
        hookPid,
        tracked: await trackedSessions(),
      });
      if (predecessor) {
        await retireLineageSession(config, predecessor, agent, input, "claude SessionStart source:clear");
        // The cached projection still contains the retired id, but no later guard in this invocation
        // should treat it as live (notably same-pid child logic if adapters evolve).
        trackedCache = trackedCache?.filter((t) => t.sessionId !== predecessor);
      }
    }

    // Claude daemon fork/replay: the command names the old transcript. If that predecessor is already
    // tracked, reuse its row for the replayed SessionStart rather than minting a second id. This is not
    // a blanket fork suppression: a later real UserPromptSubmit under the new id does not take this
    // SessionStart-only alias path and can create the genuinely continued fork normally.
    if (!existingRecord && hookName === "SessionStart" && adapter.forkResumePredecessor) {
      const predecessor = adapter.forkResumePredecessor(hookCommand);
      const predecessorRecord = predecessor ? await readRecord(predecessor) : null;
      if (predecessor && predecessorRecord) {
        sessionId = predecessor;
        eventInput = { ...input, session_id: predecessor };
        existingRecord = predecessorRecord;
        reusedForkPredecessor = true;
        suppress({
          guard: "claude-fork-reemission",
          reason: "daemon fork/resume SessionStart reused the already-tracked predecessor row",
        }, { predecessorSessionId: predecessor, effectiveSessionId: predecessor });
      }
    }

    // Child-session ghost guard (adapter seam; codex-only in practice): the ChatGPT.app
    // `codex app-server` spawns child session ids with NO rollout content that share their pid with
    // the real session — each would otherwise become a brand-new, forever-empty phone row. Only consulted
    // for a NEVER-tracked id, so an already-live session can never be silenced by it.
    if (!existingRecord && adapter.isChildSessionGhost) {
      const tracked = await trackedSessions();
      if (tracked.length > 0 && adapter.isChildSessionGhost({
        sessionId: reportedSessionId, prefix: await getPrefix(), hookPid, tracked,
      })) {
        suppress({
          guard: "codex-child-session",
          reason: "never-tracked empty child id shares a pid with a tracked Codex session",
        });
        return;
      }
    }

    // Detailed adapter-owned create guard. Codex uses it for subagent rollouts, promptless rollouts,
    // and the older no-rollout app-server jobs. Every silent would-have-created return is traced with
    // the exact guard/reason; a later real prompt simply re-enters with no record and creates normally.
    if (!existingRecord && adapter.sessionCreationSuppression) {
      const suppression = await adapter.sessionCreationSuppression({
        sessionId: reportedSessionId,
        prefix: await getPrefix(),
        transcriptPath,
        input,
      });
      if (suppression) {
        suppress(suppression);
        return;
      }
    }

    // Headless/daemon-invocation guard (adapter seam; claude-only in practice): a `claude` that loads
    // plugins but isn't a human's interactive session — claude-mem's `claude --output-format stream-json`
    // observation runs, or any tool shelling out to headless Claude — fires SessionStart/UserPromptSubmit
    // under a fresh session id that never gets a Stop, so left unguarded it mints a phantom "working" row
    // that only the watchdog's 30-min idle reap (or the worker's eviction) ever clears. The invoking
    // process's argv (process.ppid) and its ancestor chain fingerprint it. Only consulted for a NEVER-
    // tracked id, so an already-live interactive session can never be silenced.
    const continuedForkPrompt = hookName === "UserPromptSubmit" &&
      typeof input.prompt === "string" && input.prompt.trim().length > 0 &&
      !!adapter.forkResumePredecessor?.(hookCommand);
    if (!existingRecord && !continuedForkPrompt && adapter.isHeadlessInvocation && adapter.isHeadlessInvocation({
      pid: hookPid, ancestorsOf: pidAncestors, commandOf: pidCommand,
    })) {
      suppress({
        guard: "claude-headless-invocation",
        reason: "invoking process or ancestor matches a non-interactive/daemon discriminator",
      });
      return;
    }

    // Keep the LAST NON-EMPTY title, like model below: a later hook whose bounded reads find nothing
    // (the freshest ai-title outside both windows, a giant unparseable head line, a transcript raced
    // away) must not regress the phone's title to "" — the record's cached title backstops the live
    // blob, not just the watchdog's rebuilt ones.
    const title = (await readTitle()) ?? existingRecord?.title;
    // A clear transition without any title is not yet a useful visible session. The predecessor has
    // already been retired above; defer this new id until its first prompt/title-bearing hook.
    if (!existingRecord && clearLineage && !title) {
      suppress({
        guard: "claude-clear-untitled",
        reason: "clear-lineage SessionStart has no prompt/title yet",
      });
      return;
    }
    // Keep the LAST NON-EMPTY model, like title: a hook whose tail read finds nothing (transcript
    // raced away, no assistant turn in the window) must not drop the badge the previous hook set.
    const model = (await readModel()) ?? existingRecord?.model;
    const sentDone = existingRecord?.sentDone === true;
    const cachedStart = typeof existingRecord?.sessionStartedAt === "number" && Number.isFinite(existingRecord.sessionStartedAt)
      ? existingRecord.sessionStartedAt : undefined;
    const startedAt = cachedStart ?? transcriptStartMs(await getPrefix());
    // The CURRENT TURN's anchor (epoch SECONDS — the blob's unit, unlike the ms everywhere else). A
    // UserPromptSubmit opens a fresh turn — BOTH agents fire it under this exact hook_event_name (codex
    // sends Claude's hook names verbatim; see the codex-payload planOp tests) — so it stamps NOW and the
    // record caches it; every other hook of the turn re-uses the cached value so the island timer keeps
    // one steady anchor. No cache and no prompt yet (session pre-dating 0.3.5 / island enabled mid-turn)
    // → undefined, the blob omits it, and the widget falls back to `startedAt`.
    const cachedTurn = typeof existingRecord?.turnStartedAt === "number" && Number.isFinite(existingRecord.turnStartedAt)
      ? existingRecord.turnStartedAt : undefined;
    // SessionStart is ALSO a turn boundary: a resume/startup/clear opens a fresh turn, so the anchor
    // must re-stamp to NOW. Without this a session resumed after ~40h fires SessionStart BEFORE its
    // first UserPromptSubmit with the record reaped (no cache) → the blob omits turnStartedAt and the
    // widget falls back to `startedAt` (the transcript-head timestamp), flashing "40h" on the island
    // until the prompt hook lands ~5s later. The lone exception is source:"compact" — auto-compaction
    // fires MID-turn, so re-anchoring there would jerk the in-progress timer backward; keep the cache.
    // `source` is read defensively (Claude passes "startup"|"resume"|"clear"|"compact"): absent/unknown
    // stamps fresh, so we fail toward a fresh anchor and never toward the 40h fallback.
    const isTurnOpener = hookName === "UserPromptSubmit"
      || (hookName === "SessionStart" && sessionStartSource !== "compact");
    const turnStartedAt = isTurnOpener ? Math.floor(Date.now() / 1000) : cachedTurn;
    // The Codex turn id (Claude payloads carry none → undefined). Cached on the record so the notify
    // backstop's stale-turn guard can compare it against a delayed notify's payload turn-id.
    const turnId = typeof input.turn_id === "string" && input.turn_id.length > 0 ? input.turn_id : undefined;
    let plan = planOp(hookName, input, sentDone);
    if (!plan) return;
    // Some clients can remain blocked on USER input after the model turn itself completes. The
    // adapter owns that agent-specific proof. Today Codex uses it for the hookless TUI Plan picker:
    // keep the session in the attention queue instead of letting a Stop lie that it is done.
    let pendingPlanPicker = false;
    let planPickerVerificationPending = false;
    let attentionKind: "userInput" | undefined;
    let proposedPlan: string | undefined;
    let pickerClassifier = plan.op === "done" ? "none" : plan.status;
    if (plan.op === "done" && adapter.completedTurnWaitState) {
      const evidence = adapter.completedTurnWaitEvidence
        ? await adapter.completedTurnWaitEvidence({ pid: hookPid, transcriptPath })
        : { state: await adapter.completedTurnWaitState({ pid: hookPid, transcriptPath }) };
      const wait = evidence.state;
      pickerClassifier = wait;
      if (wait === "pending") {
        plan = { op: "update", prio: 1, status: "needsAttention" };
        attentionKind = "userInput";
        pendingPlanPicker = true;
        proposedPlan = evidence.plan;
      } else if (wait === "incomplete") {
        // Do not guess done and do not sleep inside a short-lived hook. Preserve the current working
        // wire state and leave a durable marker for the long-lived watchdog to settle after flush.
        plan = { op: "update", prio: 0, status: "working" };
        planPickerVerificationPending = true;
      }
    }
    // Pin the label to the session's FIRST-SEEN cwd: a mid-session `cd` changes input.cwd on every
    // later hook, and re-deriving the label per event silently renamed the phone row / island folder
    // chip (observed live: "api-status" → "server" after a `cd server`). A session's identity must not
    // follow its shell around, so once the record holds a label it is reused verbatim; only the first
    // event (no record yet) derives it from cwd.
    const label = typeof existingRecord?.label === "string" && existingRecord.label.length > 0
      ? existingRecord.label
      : typeof input.cwd === "string" && input.cwd.length > 0 ? basename(input.cwd) : "session";
    const dbg = agent === "codex" ? formatPlanPickerDebug({
      event: hookName || "event",
      classifier: pickerClassifier,
      marker: pendingPlanPicker ? "p" : planPickerVerificationPending ? "v" : "0",
      ttl: pendingPlanPicker || planPickerVerificationPending ? "0m" : "-",
      by: "h",
    }) : undefined;
    // The UNABRIDGED plan, kept ONLY when the blob's `plan` key had to be cut to fit the worker's sealed
    // ceiling (NOM-44 phase 4). The tee hands back the exact plaintext buildBlob produced, so the
    // comparison is against the real fitted value rather than a re-derivation that could drift.
    let planFull: string | undefined;
    const envelope = await buildEnvelope(eventInput, machine, Date.now(), title, config.e2eKey, sentDone, agent, startedAt, turnStartedAt, label, model, plan, attentionKind, proposedPlan, dbg,
      (plaintext) => { planFull = fullTextForRecord(proposedPlan, plaintext.plan); });
    if (!envelope) return;

    // Record (or, on op:end, remove) this session's file and make sure the liveness watchdog is
    // running before we POST — a force-killed terminal fires no SessionEnd, so this is how the phone
    // learns of a dead session in seconds instead of after the one-hour worker eviction.
    // `title` already carries the last non-empty value (resolved above) so the watchdog's corrective
    // envelopes never regress to title:"" — and the pairing the blob was sealed under is stamped so a
    // heartbeat after a re-pair can't re-send an undecryptable stale blob.
    const createsRecord = !existingRecord && plan.op !== "end";
    const retiresRecord = !!existingRecord && plan.op === "end";
    const origin = existingRecord?.origin ?? sessionOrigin(input, hookPid, hookCommand);
    // A replay alias must not steal liveness ownership from the real predecessor: keep its original
    // session pid/transcript so the short-lived background daemon exiting cannot make the watchdog
    // reap an otherwise-live interactive row.
    const recordPid = reusedForkPredecessor ? existingRecord!.pid : hookPid;
    const recordTranscript = reusedForkPredecessor
      ? (existingRecord!.transcript ?? transcriptPath)
      : transcriptPath;
    await trackSession(sessionId, plan.op, plan.prio, plan.status, envelope.blob as string | undefined, machine, label, recordTranscript, agent, startedAt, turnStartedAt, turnId,
      title, config.pairingId, model, pendingPlanPicker, recordPid, origin, planPickerVerificationPending, dbg,
      // The SAME discriminator this event's envelope carries — READ BACK OFF THE ENVELOPE, not from the
      // local `attentionKind` above. buildEnvelope derives it itself for a Codex PreToolUse
      // `request_user_input` (the local variable is only ever set by the Plan-picker branch), so passing
      // the local one cached NOTHING for the commonest question there is: the worker channel said
      // "question", the LAN feed — which rebuilds its frames from THIS record, not from the POST — said
      // "plain approval", and the same prompt rendered two different cards depending on the transport.
      envelope.attentionKind as "userInput" | undefined,
      // The unabridged plan for the LAN `read` op — undefined unless the blob's copy was truncated.
      planFull);
    const clearedPickerMarker = pendingPlanPicker === false && planPickerVerificationPending === false
      && (existingRecord?.pendingPlanPicker === true || existingRecord?.planPickerVerificationPending === true || existingRecord?.planPickerSettled === true);
    if (agent === "codex" && (hookName === "Stop" || pendingPlanPicker || planPickerVerificationPending || clearedPickerMarker)) {
      tracePlanPickerDecision(sessionId, {
        source: "hook",
        classifier: pickerClassifier,
        marker: pendingPlanPicker ? "set-pending" : planPickerVerificationPending ? "set-verification" : clearedPickerMarker ? "cleared" : "none",
        correctionPosted: false,
        ...(plan.op === "done" ? { doneBy: "hook" as const } : {}),
      });
    }
    if (createsRecord) {
      traceSession({
        event: "create",
        sessionId,
        agent,
        hook_event_name: hookName,
        ...(sessionStartSource ? { source: sessionStartSource } : {}),
        origin,
      });
    } else if (retiresRecord) {
      traceSession({
        event: "retire",
        sessionId,
        agent,
        hook_event_name: hookName,
        ...(sessionStartSource ? { source: sessionStartSource } : {}),
        reason: "hook op:end",
      });
    }
    ensureWatchdog();

    // Reconcile a provisional discovery: Codex fires no hook at session OPEN (openai/codex#15269), so
    // the watchdog may have surfaced this TUI provisionally. Now that a REAL codex hook is reporting,
    // end that provisional so the phone doesn't show both it and the real session. Codex-only (Claude
    // has no discovery). Runs AFTER trackSession has written the real record but BEFORE the real
    // event's POST, so the phone still sees end-provisional → start-real in order — and, with the
    // real record already covering this pid, (a) a discovery sweep racing this hook can't re-surface
    // the same TUI as a fresh provisional in the unlink-to-track window the old pre-track placement
    // left open, and (b) if the end POST fails (the file survives — see reconcileProvisional) the
    // sweep backstop finds the survivor "covered by real" and retries it within a sweep (~5s).
    // REMOVABLE once openai/codex#15269 ships.
    if (agent === "codex") await reconcileProvisional(config, hookPid);

    const res = await fetch(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret,
        "x-cc-version": PLUGIN_VERSION,
        // Whether remote approvals are paused ON THIS COMPUTER (`nomo-cc permission off`), so the phone
        // can stop claiming approvals are on while nothing will ever arrive. Plaintext, never in the
        // blob; the worker literal-matches "on"/"off" — see localApprovalsState's contract note.
        "x-cc-approvals": await localApprovalsState(),
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      // Success marker for Task 2.2's `status` command: the epoch-ms of the last delivered event. A
      // delivered event also breaks any gone streak (the pairing is plainly alive again).
      await atomicWrite(LAST_SEND_PATH, String(Date.now()));
      await resetGoneStrikes();
      // The ONLY place a done's delivery is confirmed. Every other exit from this POST — a non-2xx
      // below, an AbortSignal timeout, a network throw into the outer catch — leaves trackSession's
      // pessimistic `donePending` standing, which is precisely the debt the watchdog then settles.
      if (plan.op === "done") await markDoneDelivered(sessionId);
    } else if (res.status === 404 || res.status === 410) {
      // The pairing is GONE server-side (404 = deleted, 410 = dormant-GC'd once). Without this, a
      // revoked pairing keeps POSTing ~2×/tool-use forever, 404ing on every hook. A single gone
      // response can be a transient/racing delete, so require GONE_STRIKE_LIMIT CONSECUTIVE ones
      // before deleting the credential-bearing config; the watchdog counts against the SAME shared
      // streak and uses the same teardown.
      const strikes = await recordGoneStrike();
      if (strikes >= GONE_STRIKE_LIMIT) {
        await removeRevokedConfig();
        process.stderr.write(`[nomo-cc] pairing gone server-side (HTTP ${res.status}) — removed local pairing; re-pair with \`nomo-cc pair\` to reconnect\n`);
      }
    } else {
      // 401/403/429/5xx — ambiguous / transient. Never tear down; just clear any gone streak so a
      // real revoke later still needs its own two consecutive gone responses.
      await resetGoneStrikes();
    }
  } catch {
    // Silence is the contract — never surface errors into a Claude Code (or Codex) session.
  }
}
