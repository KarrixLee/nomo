// cc-watchdog — the SHARED, AGENT-AGNOSTIC liveness/discovery daemon for the coding-CLI status
// pipeline (the "cc" prefix names that pipeline, NOT Claude specifically — it drives Claude Code AND
// Codex sessions; file/identifier/dist names are FROZEN, so the prefix stays).
//
// ALL per-agent behavior comes from the adapters (../core/adapter): which transcript-interrupt marker
// to scan for, what `agent` field a blob carries, and which live sessions a process-scan can discover
// ahead of the hooks. The daemon itself never branches on `agent === …`.
//
// Two gaps it closes:
//   1. REAP — the hook fires a SessionEnd on a clean exit, but force-closing a terminal kills the
//      agent with no hook at all, so the phone's Live Activity would show that session "working" until
//      the Worker's one-hour staleness eviction. The hook records each session's TUI pid (process.ppid)
//      in ~/.config/cc-status/sessions/; this process checks liveness with kill(pid,0) every few
//      seconds and POSTs an op:end for any dead one.
//   2. DISCOVER — Codex fires NO hook at session OPEN (its SessionStart fires only at the FIRST prompt,
//      openai/codex#15269), so a freshly-opened Codex TUI is invisible to the phone for 30 s+. Each
//      sweep asks every adapter to discover live sessions the hooks can't see yet
//      (adapter.discoverLive) and POSTs a PROVISIONAL row for each — op:start/"working" only when a
//      turn is genuinely in flight, op:done/"done" for an idle REPL at its prompt (the v0.8.4 idle-TUI
//      fix; a hook-less working row would otherwise show "Running" forever) — reconciled away once the
//      real hook fires. Claude implements no discovery (its SessionStart fires at true open).
//
// All corrective/discovery POSTs use the SAME v2 blind envelope + per-pairing headers as the hook.
//
// Contract — identical posture to cc-status.ts: NOTHING on stdout, swallow every error, never linger
// needlessly. Single-instance via ~/.config/cc-status/watchdog.pid. It used to auto-exit the instant
// zero sessions remained; it now lingers IDLE_GRACE_MS between sessions so discovery can surface the
// NEXT freshly-opened Codex TUI instantly instead of waiting for a hook to re-spawn it.
// PORTABLE: no `Bun.*` — file IO via node:fs/promises helpers.

import { readdir, readFile, unlink } from "node:fs/promises";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import { decryptBlob, encryptBlob } from "../core/crypto";
import { adapterFor, AgentAdapter, allAdapters, codexAdapter, codexTurnActiveFromTail, CodexPlanPickerEvidence, DiscoveredSession } from "../core/adapter";
import type { LocateTuiReason } from "../core/adapter";
import { focusTerminalForPid } from "../core/terminal-focus";
import type { FocusContext, FocusResult } from "../core/terminal-focus";
import { CodexRemoteInputBridge } from "../core/codex-remote-input-bridge";
import type { CodexThreadWaitState } from "../core/codex-remote-input-bridge";
import { createLanHintPublisher, createLanListener, lanAnswerStore } from "../core/lan-listener";
import type { LanAnswerDelivery, LanAnswerStore, LanCommand, LanListener } from "../core/lan-listener";
import { lanRunningUnderTest } from "../core/lan-wire";
import { stateHoldLive } from "../core/session-state";
import { resolveOnRelay } from "../core/codex-remote-input";
import type { DecisionHold, PlanPickerTraceDecision } from "../core/shared";
import {
  AgentKind, appendCodexBridgeMarker, appendFittedPlanAndDebug, atomicWrite, CC_DIR, CCOp, CCStatus, codexAppServerSocketAvailable, Config, completePendingPairing, formatPlanPickerDebug, formatWatchdogPidfile,
  startCodexAppServerDaemon,
  GONE_STRIKE_LIMIT, loadConfig, loadPendingConfig, localApprovalsState,
  PAIR_HTML_FILE, PairPollResult, parseWatchdogPidfile, PendingConfig, pidAlive, PLUGIN_VERSION, readDecisionHoldAt, readPrefix, readSuffix, recordGoneStrike, removeRevokedConfig,
  resetGoneStrikes, SessionRecord, SESSIONS_DIR, traceSession, tracePlanPickerDecision, watchdogBuildDiffers,
  watchdogBuildStamp, watchdogHolderIsLive, WATCHDOG_PID_PATH,
} from "../core/shared";
import { rememberBounded } from "../core/bounded-set";

// The transcript-tail interrupt PARSERS live in the agent adapters now (the two detections are
// structurally different). Re-export them so existing importers/tests that reference "./cc-watchdog"
// keep resolving lastTurnLine / hasInterruptMarker / codexLastTurnEvent.
export { claudeTailPendingApproval, codexLastTurnEvent, codexTailPendingApproval, hasInterruptMarker, lastTurnLine } from "../core/adapter";

/** Poll cadence. Short enough that a closed terminal clears in seconds; cheap enough that an
 *  idle-but-nonempty sessions dir costs almost nothing per tick. */
const POLL_MS = 5000;
/** The QR's pending-pairing lifetime — matches the worker's 10-minute pending KV TTL. Past this, a
 *  still-pending config can never complete, so the self-heal must stop (else an unreachable worker +
 *  a lingering pending config = this detached process polling every 5 s until the machine reboots). */
export const PAIRING_TTL_MS = 600_000;
/** A session file older than this is abandoned — its POST has been retried and kept failing, or
 *  the machine slept through the death. Delete it without POSTing, which caps retries so a
 *  permanently-failing POST can't loop forever. Matches the server's own plausibility window. */
const SESSION_STALE_MS = 86_400_000; // 24h
/** How long the daemon lingers with ZERO session records before exiting. It used to quit the instant
 *  the sessions dir emptied (the hook re-spawns it on the next event). But discovery must keep running
 *  BETWEEN sessions so a freshly-opened Codex TUI is surfaced the moment it appears — not only after a
 *  hook happens to re-spawn us. 30 min sits well above a short gap between turns/sessions yet still lets
 *  a truly idle machine's detached poller retire instead of polling forever. */
export const IDLE_GRACE_MS = 1_800_000; // 30 min

// --- PID-gated staleness heartbeat ----------------------------------------------------------
//
// Three HEALTHY situations fire zero Claude Code hooks for long stretches: a subagent/Task tool
// call running 30+ min (one PreToolUse at its start, then silence), a long tool-less generation,
// and waiting on the user's permission answer. The island's server-side stale-date (600 s) is
// re-armed only by an inbound push, and a push only happens on an inbound event — so a genuinely-
// alive-but-silent session would show "Disconnected?" and eventually be evicted. This heartbeat
// closes that gap from the ONE side that knows the process is alive: the PID check. It re-sends the
// session's LAST blob verbatim (under its last op/prio), so a heartbeat never flips the state.

/** How long a session must go event-quiet before the watchdog heartbeats it. WHY 5 min: it sits
 *  far above a normally-active session's ≤15 s hook cadence (so we never heartbeat a session the
 *  hooks are already keeping fresh) yet well inside the island's 600 s stale-date — two heartbeats
 *  land before it would evict. It doubles as the per-session throttle window. */
const HEARTBEAT_AFTER_MS = 300_000; // 5 min

/** Per-session last-heartbeat epoch-ms (in-memory; see the original design note — a heartbeat-eligible
 *  session is by definition alive, so the process persists across the sweeps that could heartbeat it,
 *  and the throttle never needs to survive a restart). */
const heartbeatAt = new Map<string, number>();

// --- Corrective-done retry bound (memory-backed, so a failing DISK can't unbound it) -----------
//
// The three corrective-done nets (interrupt / idle-Claude reap / undelivered-done) bound their retries
// with `record.doneAttempts`, which is PERSISTED inside a try/catch: if the record rewrite itself keeps
// failing (full disk, read-only home, a clobbered sessions dir), the counter never advances and the net
// re-POSTs a doomed done every 5 s FOREVER — the exact "cap retries so a permanently-failing POST can't
// spin" discipline the persisted counter was meant to enforce. This in-memory mirror (same shape as
// heartbeatAt) is consulted ALONGSIDE the persisted value — the bound is max(disk, memory) — so it holds
// regardless of disk state. Cleared whenever a net settles/clears the counter or the record goes away.

/** Per-session corrective-done attempt count for THIS watchdog process. */
const doneAttemptsMem = new Map<string, number>();

/** The attempt count a net must bound against: the higher of the persisted counter and this process's
 *  in-memory mirror, so a record rewrite that never lands can't reset the bound to zero every sweep. */
export function effectiveDoneAttempts(record: SessionRecord, sessionId: string): number {
  const persisted = typeof record.doneAttempts === "number" && Number.isFinite(record.doneAttempts) ? record.doneAttempts : 0;
  return Math.max(persisted, doneAttemptsMem.get(sessionId) ?? 0);
}

/** Remember this session's new attempt count (called with the value just persisted, so memory and disk
 *  agree when the write lands and memory WINS when it doesn't). */
export function noteDoneAttempt(sessionId: string, attempts: number): void {
  doneAttemptsMem.set(sessionId, attempts);
}

/** Drop a session's in-memory attempt count — on a delivered/settled corrective (the persisted counter
 *  is cleared in the same breath) or when the record is removed. */
export function clearDoneAttempts(sessionId: string): void {
  doneAttemptsMem.delete(sessionId);
}

/** Test-only reset of the module-global retry memory (mirrors what a fresh daemon starts with). */
export function resetDoneAttemptMemory(): void {
  doneAttemptsMem.clear();
}

// --- Stale-snapshot guard (never write back a record the world moved past) ---------------------
//
// Every net receives the record SNAPSHOT the sweep read at the top of its iteration, then awaits a POST
// (up to 2 s) before rewriting the file. A real hook can land in that window — a user prompt flipping the
// session to `working`, a Stop, a SessionEnd delete — and a blind `{...snapshot, …}` rewrite would
// RESURRECT the pre-POST state, stamping a live session back to `done` and silencing every self-heal net
// that gates itself off on a done record. hook.ts's markDoneDelivered already documents the rule for the
// other side of this race: RE-READ immediately before writing and clear only the marker. These helpers
// are that rule, made pure and testable.

/** Read a session record straight from disk, or null when absent/unreadable/corrupt. */
async function readRecordAt(path: string): Promise<SessionRecord | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SessionRecord;
  } catch {
    return null;
  }
}

/** Has the on-disk record MOVED since the snapshot the sweep read? Keyed on the three fields a real
 *  hook always rewrites: the event clock and the two state fields. Pure. */
export function recordMovedSince(snapshot: SessionRecord, fresh: SessionRecord): boolean {
  return fresh.ts !== snapshot.ts || fresh.lastEvent !== snapshot.lastEvent || fresh.op !== snapshot.op;
}

/** Is this record in a terminal done state? (The state every corrective-done net pins.) */
function isDoneState(record: SessionRecord): boolean {
  return record.op === "done" || record.lastEvent === "done";
}

/** What correctPendingDone should WRITE after a delivered (or capped) done, given the freshly re-read
 *  record. Pure — the whole stale-snapshot matrix is unit-testable:
 *   - re-read unavailable (null: absent/unreadable) → the `settled` snapshot rewrite, i.e. EXACTLY the
 *     pre-guard behavior. The guard can only ever REDUCE clobber, never add a new failure mode.
 *   - unchanged → `settled` (pin the terminal done + drop the debt, as before).
 *   - moved and no longer done (a user prompt landed mid-POST) → null: write NOTHING. Stamping the
 *     snapshot back would flip a live `working` session to `done` and self-silence every net.
 *   - moved but still done → clear ONLY the debt marker on the FRESH record (never the snapshot), and
 *     only when it still carries one. */
export function pendingDoneSettleWrite(
  snapshot: SessionRecord, fresh: SessionRecord | null, settled: SessionRecord,
): SessionRecord | null {
  if (fresh === null) return settled;
  if (!recordMovedSince(snapshot, fresh)) return settled;
  if (!isDoneState(fresh)) return null;
  if (fresh.donePending !== true) return null;
  return { ...fresh, donePending: undefined, doneAttempts: undefined };
}

/** What correctPendingDone should WRITE after a transiently-FAILED re-POST: the bumped retry counter,
 *  applied to whichever record is current. Same stale-snapshot rules as pendingDoneSettleWrite — a
 *  session that moved on to `working` gets nothing written (the in-memory mirror still bounds the
 *  retry). Pure. */
export function pendingDoneRetryWrite(
  snapshot: SessionRecord, fresh: SessionRecord | null, attempts: number,
): SessionRecord | null {
  if (fresh === null) return { ...snapshot, doneAttempts: attempts };
  if (!recordMovedSince(snapshot, fresh)) return { ...fresh, doneAttempts: attempts };
  if (!isDoneState(fresh)) return null;
  return { ...fresh, doneAttempts: attempts };
}

export type SessionVerdict = "keep" | "end" | "stale" | "delete";

/** Pure per-file decision. `end` → the process is gone: POST an op:end, then delete. `stale` → a VALID
 *  record aged past the 24 h cap: POST a best-effort terminal end (so the phone row resolves instead of
 *  silently vanishing), then delete regardless. `delete` → malformed / un-ageable (no pid, no ts): just
 *  remove it, nothing to POST. `keep` → still alive: leave it for next sweep. Staleness is checked before
 *  liveness so an abandoned file is always retired. Liveness is an injected predicate, so this stays pure
 *  and testable without touching real processes. */
export function classifySession(record: SessionRecord | null, now: number, isAlive: (pid: number) => boolean): SessionVerdict {
  if (!record || typeof record.pid !== "number" || !Number.isFinite(record.pid)) return "delete";
  if (typeof record.ts !== "number") return "delete"; // no timestamp → can't age it → nothing to POST
  // A retired Codex marker is not a session and must never age into another op:end. It exists solely
  // to reserve the exact interactive owner from discovery; keep it while that TUI lives, then quietly
  // delete it. A real hook rebuilds the record whole and drops retiredAt, reviving normally.
  if (record.agent === "codex" && typeof record.retiredAt === "number" && Number.isFinite(record.retiredAt)) {
    if (typeof record.tuiPid !== "number" || !Number.isFinite(record.tuiPid)) return "delete";
    return isAlive(record.tuiPid) ? "keep" : "delete";
  }
  if (now - record.ts > SESSION_STALE_MS) return "stale"; // abandoned (24 h): POST a terminal end, then delete
  // A precision-correlated Codex TUI owns the session. Its app-server pid can live for the lifetime of
  // the app and is no evidence that this particular terminal still exists.
  const ownerPid = record.agent === "codex" && typeof record.tuiPid === "number" && Number.isFinite(record.tuiPid)
    ? record.tuiPid : record.pid;
  return isAlive(ownerPid) ? "keep" : "end";
}

/** Retirement-grade Codex ownership. The general focus locator may use a lone machine-wide TUI or cwd
 * match as a convenience; neither alone is enough to suppress discovery or declare a working row idle.
 * Accept direct pid/sentinel ownership, or the strict cwd + process/session-birth correlation below. */
async function locateCodexOwnedTui(sessionId: string, record: SessionRecord): Promise<number | undefined> {
  // First spend the same exact evidence the LAN parity path persists: direct hook/discovery ownership,
  // a cached correlation, or the strict daemon↔provisional cwd/start join.
  const resolved = resolveCodexTuiOwner(record, await readAllRecords(), pidAlive);
  if (resolved !== undefined) return resolved;
  const locate = adapterFor("codex").locateTuiPid;
  if (!locate) return undefined;
  let reason: LocateTuiReason | undefined;
  const pid = await locate({ sessionId, record }, { note: (value) => { reason = value; } });
  return reason === "record-pid" || reason === "sentinel-pid" ? pid : undefined;
}

/** The session's cached true start (epoch ms) as an envelope fragment, or nothing when unknown — so
 *  every watchdog POST carries `startedAt` exactly like the hook's, and the worker keeps timing the
 *  island from the real session birth. Omitted for a pre-fix record with no cached start. */
function startedAtField(record: SessionRecord): { startedAt?: number } {
  return typeof record.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt)
    ? { startedAt: record.sessionStartedAt } : {};
}

/** The reap envelope for a dead-pid session: a v2 op:end with NO blob. The worker reuses the last
 *  stored blob for the final frame, so nothing here needs machine/label/title. Carries the record's
 *  cached start when known (`record` omitted at the pure-reap call sites that have no record). The
 *  optional `at` (epoch SECONDS) rides the clear wire envelope for the idle-done RETIRE path, which
 *  passes the FROZEN real-last-event time (record.ts/1000, consistent with 5aa1214's frozen blob `at`)
 *  so the end frame ages by real activity rather than the retirement clock; OMITTED (byte-identical to
 *  before) for the dead-pid / stale / reconcile callers that pass no `at`. */
export function buildEndEnvelope(sessionId: string, now: number, record?: SessionRecord, at?: number): object {
  return {
    v: 2, sessionId, op: "end", prio: 0, ts: now,
    ...(record ? startedAtField(record) : {}),
    ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
  };
}

/** The interrupt-corrective envelope: a v2 op:done carrying a freshly-encrypted blob with status
 *  "done" and the record's machine/label (coerced to "" if a corrupt record dropped them). title is
 *  the record's cached last non-empty title (the hook stamps it on every emit) — the watchdog has no
 *  fresh transcript to scan, and re-pushing title:"" made the phone regress to the folder-name label;
 *  "" only when no title was ever resolved. `agent`
 *  (defaulted to claude so the existing call sites/tests are byte-identical) restamps the blob's
 *  optional `agent:"codex"` key so a corrective done matches what the hook would have sent. The
 *  record's cached `turnStartedAt` (epoch seconds, stamped by the turn's UserPromptSubmit) is
 *  likewise restamped into the rebuilt blob — omitted when unknown — so the island's frozen
 *  "done in Xm" keeps measuring the TURN, exactly as a hook-built done blob would. */
export async function buildDoneEnvelope(sessionId: string, record: SessionRecord, now: number, e2eKey: Uint8Array, agent: AgentKind = "claude", at?: number, dbg?: string): Promise<object> {
  const base = {
    status: "done",
    title: typeof record.title === "string" ? record.title : "",
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    // Per-agent blob identity comes from the adapter (no inline `agent === …` branch in the daemon).
    ...adapterFor(agent).blobAgentFields,
    ...(typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {}),
    // The record's cached model id (v0.8.5, cached like title) — restamped so the rebuilt blob keeps
    // the phone's model badge; OMITTED when the record has none (the app then hides the badge).
    ...(typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {}),
    // `at` (epoch SECONDS, the phone's honest sort/age key — see hook.ts buildBlob), appended LAST.
    // Interrupt/idle-provisional correctives pass the OBSERVED now (the done happened just now); the
    // idle-CLAUDE reap passes a FROZEN record.ts so a session idle for hours ages out immediately
    // instead of looking freshly finished. OMITTED when the caller has no honest time.
    ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
  };
  const debug = appendCodexBridgeMarker(
    agent === "codex" ? dbg ?? formatPlanPickerDebug({ event: "done", classifier: "done", marker: "0", by: "wd" }) : undefined,
    codexBridgeIsDown(),
  );
  const blob = await encryptBlob(e2eKey, appendFittedPlanAndDebug(base, undefined, debug));
  return { v: 2, sessionId, op: "done", prio: 0, ts: now, blob, ...startedAtField(record) };
}

/** The pending-approval corrective envelope: a v2 op:update / prio 1 carrying a freshly-encrypted blob
 *  with status "needsAttention" — the SAME op/prio/status a real PermissionRequest hook would send (see
 *  hook.ts planOp: PermissionRequest → {op:update, prio:1, status:needsAttention}). title is the
 *  record's cached last non-empty title (see buildDoneEnvelope — a rebuilt title:"" regressed the
 *  phone to the folder-name label), machine/
 *  label come from the record (coerced to "" if a corrupt record dropped them), `agent` restamps the
 *  blob's optional agent:"codex" via the adapter seam, and the record's cached `turnStartedAt` is
 *  restamped so the island timer keeps measuring the same turn — exactly as buildDoneEnvelope does.
 *  A recovered Codex request_user_input additionally carries clear `attentionKind:"userInput"`; plain
 *  permission approvals omit it so the server can end an older decision episode without cross-talk. */
export async function buildNeedsAttentionEnvelope(
  sessionId: string, record: SessionRecord, now: number, e2eKey: Uint8Array,
  agent: AgentKind = "claude", at?: number, detail?: string, attentionKind?: "userInput", proposedPlan?: string,
  dbg?: string,
): Promise<object> {
  const base = {
    status: "needsAttention",
    title: typeof record.title === "string" ? record.title : "",
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    // A dropped Codex request_user_input hook is recoverable from its persisted function-call
    // arguments; carry the same encrypted first-question preview the direct PreToolUse path sends.
    // Placed AFTER `label` so this producer's key order matches hook.ts buildBlob's byte shape — two
    // producers of the same needsAttention frame must not emit divergent orders.
    ...(typeof detail === "string" && detail.length > 0 ? { detail } : {}),
    // Per-agent blob identity comes from the adapter (no inline `agent === …` branch in the daemon).
    ...adapterFor(agent).blobAgentFields,
    ...(typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {}),
    // The record's cached model id, restamped exactly as buildDoneEnvelope does (omitted when absent).
    ...(typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {}),
    // `at` (epoch SECONDS) remains after model. The optional Plan-picker `plan` is appended LAST below,
    // preserving the existing order and omitted for ordinary permissions/questions.
    ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
  };
  const debug = appendCodexBridgeMarker(
    agent === "codex" ? dbg ?? formatPlanPickerDebug({ event: "attention", classifier: "pending", marker: "0", by: "wd" }) : undefined,
    codexBridgeIsDown(),
  );
  const blob = await encryptBlob(e2eKey, appendFittedPlanAndDebug(base, proposedPlan, debug));
  return {
    v: 2, sessionId, op: "update", prio: 1, ts: now,
    // Clear and optional: only a recovered Codex request_user_input gets this discriminator. Ordinary
    // permission correctives (and every Claude event) retain the legacy envelope byte shape.
    ...(agent === "codex" && attentionKind === "userInput" ? { attentionKind } : {}),
    blob,
    ...startedAtField(record),
  };
}

/** A plan-picker answer is real user progress, so its watchdog corrective is a fresh working update
 *  (not a verbatim heartbeat). It intentionally carries no attentionKind: op:update/prio:0 closes the
 *  attention episode and returns the session to its ordinary in-flight state. */
export async function buildWorkingEnvelope(
  sessionId: string, record: SessionRecord, now: number, e2eKey: Uint8Array, agent: AgentKind = "claude", dbg?: string,
): Promise<Record<string, unknown>> {
  const base = {
    status: "working",
    title: typeof record.title === "string" ? record.title : "",
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    ...adapterFor(agent).blobAgentFields,
    ...(typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {}),
    ...(typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {}),
    at: Math.floor(now / 1000),
  };
  const debug = appendCodexBridgeMarker(
    agent === "codex" ? dbg ?? formatPlanPickerDebug({ event: "working", classifier: "resolved", marker: "0", by: "wd" }) : undefined,
    codexBridgeIsDown(),
  );
  const blob = await encryptBlob(e2eKey, appendFittedPlanAndDebug(base, undefined, debug));
  return { v: 2, sessionId, op: "update", prio: 0, ts: now, blob, ...startedAtField(record) };
}

/** Side-effect seams for resolving a hookless completed-turn wait. */
export interface PlanPickerResolutionDeps {
  state?: () => Promise<"pending" | "incomplete" | "resolved" | "none" | "exited" | "unknown">;
  threadWaitState?: () => Promise<CodexThreadWaitState>;
  post?: (body: object) => Promise<PostOutcome>;
  writeRecord?: (path: string, rec: SessionRecord) => Promise<void>;
  readRecord?: (path: string) => Promise<SessionRecord | null>;
  now?: () => number;
  trace?: (decision: PlanPickerTraceDecision) => void;
  /** Sweep-only snapshot of real-TTY provisional rows. Unit callers omit it, keeping pure tests away
   *  from the user's live sessions dir. Missing/ambiguous evidence means no stamp and TTL fallback. */
  tuiCandidates?: () => Promise<SessionRecord[]>;
  pidAlive?: (pid: number) => boolean;
}

type PlanPickerCorrection = "corrected" | "pending" | "uncorrected" | "revoked";

function markerAge(record: SessionRecord, now: number): string {
  const since = typeof record.planPickerPendingSince === "number" && Number.isFinite(record.planPickerPendingSince)
    ? record.planPickerPendingSince : record.ts;
  return typeof since === "number" && Number.isFinite(since)
    ? `${Math.max(0, Math.floor((now - since) / 60_000))}m` : "-";
}

function tracePicker(
  sessionId: string,
  deps: { trace?: (decision: PlanPickerTraceDecision) => void },
  decision: PlanPickerTraceDecision,
): void {
  if (deps.trace) {
    deps.trace(decision);
    return;
  }
  // Pure unit calls run inside `bun test` with production HOME still visible; never pollute the user's
  // live trace. Spawned hook/watchdog entry tests have their own argv + isolated HOME and still trace.
  if (process.argv.some((arg) => arg === "test" || arg.endsWith(".test.ts"))) return;
  tracePlanPickerDecision(sessionId, decision);
}

/** Persist the terminal state before posting it. This makes a watchdog replacement between disk and
 *  wire harmless: `donePending` retries a missed POST, while a delivered POST can never leave the
 *  local record frozen at the older working/attention state. */
async function settlePendingPlanPickerDone(
  config: Config, path: string, sessionId: string, snapshot: SessionRecord, now: number,
  deps: Pick<PlanPickerResolutionDeps, "post" | "writeRecord" | "readRecord" | "trace">,
  cause: "settle" | "exit" = "settle",
): Promise<PlanPickerCorrection> {
  const readCurrent = deps.readRecord ?? readRecordAt;
  const writeRecord = deps.writeRecord
    ?? ((p: string, rec: SessionRecord) => atomicWrite(p, JSON.stringify(rec), 0o600));
  const fresh = await readCurrent(path);
  if (!fresh || recordMovedSince(snapshot, fresh) || fresh.turnId !== snapshot.turnId ||
      fresh.pendingPlanPicker !== snapshot.pendingPlanPicker ||
      fresh.planPickerVerificationPending !== snapshot.planPickerVerificationPending) {
    tracePicker(sessionId, deps, {
      source: "watchdog", classifier: "settle-stale", marker: "kept", settle: "blocked",
    });
    return "uncorrected";
  }
  const at = typeof snapshot.ts === "number" && Number.isFinite(snapshot.ts)
    ? Math.floor(snapshot.ts / 1000) : undefined;
  const ttlFired = planPickerPendingExpired(snapshot, now);
  const dbg = formatPlanPickerDebug({
    event: cause === "exit" ? "exit" : ttlFired ? "ttl" : "settle", classifier: "done", marker: "s",
    ttl: ttlFired ? "fire" : markerAge(snapshot, now), by: "wd",
  });
  const envelope = await buildDoneEnvelope(sessionId, snapshot, now, config.e2eKey, "codex", at, dbg) as Record<string, unknown>;
  const next: SessionRecord = {
    ...fresh,
    lastEvent: "done",
    sentDone: true,
    donePending: true,
    op: "done",
    prio: 0,
    blob: envelope.blob as string,
    pairingId: config.pairingId,
    pendingPlanPicker: undefined,
    planPickerVerificationPending: undefined,
    planPickerPendingSince: undefined,
    planPickerSettled: true,
    doneAttempts: undefined,
    dbg,
  };
  await writeRecord(path, next);
  let outcome: PostOutcome;
  try {
    outcome = await (deps.post ?? ((body: object) => postEvent(config, body)))(envelope);
  } catch {
    tracePicker(sessionId, deps, {
      source: "watchdog", classifier: cause === "exit" ? "tui-exit" : "done", marker: "settled", ttlFired,
      settle: "done", correctionPosted: false, doneBy: "watchdog",
    });
    return "pending"; // disk already owns this terminal transition; donePending retries it
  }
  tracePicker(sessionId, deps, {
    source: "watchdog", classifier: cause === "exit" ? "tui-exit" : "done", marker: "settled", ttlFired,
    settle: "done", correctionPosted: outcome === "delivered", doneBy: "watchdog",
  });
  if (outcome === "revoked") return "revoked";
  if (outcome !== "delivered") return "pending";
  // Clear only our own delivery debt. A prompt that raced the POST owns its newer record.
  try {
    const after = await readCurrent(path);
    if (after?.donePending === true && after.blob === next.blob && after.op === "done") {
      await writeRecord(path, { ...after, donePending: undefined });
    }
  } catch { /* a redundant next-sweep POST is safe */ }
  return "corrected";
}

/** Maximum permitted distance between the real-TTY process birth and rollout/session birth. The
 * pair normally lands within seconds. A resume, an old idle TUI, missing ps data, or two nearby TUIs
 * deliberately fails correlation and leaves the hard TTL as the only terminal backstop. */
export const CODEX_TUI_SESSION_START_SKEW_MS = 30_000;
const CODEX_TUI_SESSION_START_FUTURE_SLOP_MS = 2_000;

/** Precision-biased daemon-session → real-TTY correlation. All evidence is mandatory: this must be a
 * standalone-daemon hook record, both sides need an exact cwd and finite birth time, the birth times
 * must be close, the candidate must still be alive, and exactly ONE candidate may qualify. */
export function correlateCodexTuiPid(
  record: SessionRecord, candidates: SessionRecord[], alive: (pid: number) => boolean = pidAlive,
): number | undefined {
  if (record.agent !== "codex" || record.provisional === true) return undefined;
  const cwd = record.origin?.cwd;
  const owner = record.origin?.ppid_command;
  const startedAt = record.sessionStartedAt;
  if (typeof cwd !== "string" || cwd.length === 0 ||
      typeof owner !== "string" || !owner.includes("/standalone/") || !/(?:^|\/)codex app-server(?:\s|$)/.test(owner) ||
      typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined;
  const matches = candidates.filter((candidate) =>
    candidate.provisional === true && candidate.agent === "codex" &&
    candidate.tuiCwd === cwd &&
    typeof candidate.pid === "number" && Number.isFinite(candidate.pid) &&
    typeof candidate.tuiStartedAt === "number" && Number.isFinite(candidate.tuiStartedAt) &&
    startedAt - candidate.tuiStartedAt >= -CODEX_TUI_SESSION_START_FUTURE_SLOP_MS &&
    startedAt - candidate.tuiStartedAt <= CODEX_TUI_SESSION_START_SKEW_MS &&
    alive(candidate.pid));
  return matches.length === 1 ? matches[0].pid : undefined;
}

/** Resolve only retirement-grade Codex ownership. Cached precision correlation wins; provisional rows
 * and direct CLI hook parents own themselves. Daemon-fronted records must pass the strict cwd + process/
 * session-birth join above, so a headless app-server job cannot borrow an unrelated lone TUI. */
export function resolveCodexTuiOwner(
  record: SessionRecord, candidates: SessionRecord[], alive: (pid: number) => boolean = pidAlive,
): number | undefined {
  if (record.agent !== "codex") return undefined;
  if (typeof record.tuiPid === "number" && Number.isFinite(record.tuiPid) && alive(record.tuiPid)) {
    return record.tuiPid;
  }
  if (record.provisional === true && typeof record.pid === "number" && Number.isFinite(record.pid) && alive(record.pid)) {
    return record.pid;
  }
  const command = record.origin?.ppid_command;
  if (typeof command === "string") {
    const tokens = command.trim().split(/\s+/);
    if (basename(tokens[0] ?? "") === "codex" && tokens[1] !== "app-server" &&
        !tokens.slice(1).includes("exec") && typeof record.pid === "number" && alive(record.pid)) {
      return record.pid;
    }
  }
  return correlateCodexTuiPid(record, candidates, alive);
}

/** Clear ONLY a needsAttention episode that the Stop/notify path explicitly marked as a Plan picker,
 * and ONLY after the adapter sees later task_started/user_message evidence in the rollout. Unknown /
 * unreadable state leaves the row pending; a confidently stamped TUI death settles it immediately,
 * while an unstamped daemon-fronted row retains the hard-TTL backstop. */
export async function correctResolvedPlanPicker(
  config: Config, path: string, sessionId: string, record: SessionRecord, deps: PlanPickerResolutionDeps = {},
): Promise<PlanPickerCorrection> {
  try {
    if (record.pendingPlanPicker !== true) return "uncorrected";
    const now = (deps.now ?? Date.now)();
    // The absolute cap wins before every classifier/query path, including an exact pending signature
    // and an unavailable daemon. No marker can be kept alive by a perpetually-valid rollout.
    if (planPickerPendingExpired(record, now)) {
      return await settlePendingPlanPickerDone(config, path, sessionId, record, now, deps);
    }
    let snapshot = record;
    let tuiPid = typeof snapshot.tuiPid === "number" && Number.isFinite(snapshot.tuiPid)
      ? snapshot.tuiPid : undefined;
    if (tuiPid === undefined && deps.tuiCandidates) {
      const correlated = correlateCodexTuiPid(snapshot, await deps.tuiCandidates(), deps.pidAlive ?? pidAlive);
      if (correlated !== undefined) {
        const readCurrent = deps.readRecord ?? readRecordAt;
        const fresh = await readCurrent(path);
        if (fresh && !recordMovedSince(snapshot, fresh) && fresh.turnId === snapshot.turnId &&
            fresh.pendingPlanPicker === true) {
          snapshot = { ...fresh, tuiPid: correlated };
          await (deps.writeRecord
            ?? ((p: string, rec: SessionRecord) => atomicWrite(p, JSON.stringify(rec), 0o600)))(path, snapshot);
          tuiPid = correlated;
        }
      }
    }
    // This PID is trusted only because the correlation above was unique and evidence-complete. Its
    // continued life always wins (never dismiss a live picker); its death resolves in this sweep.
    if (tuiPid !== undefined && !(deps.pidAlive ?? pidAlive)(tuiPid)) {
      return await settlePendingPlanPickerDone(config, path, sessionId, snapshot, now, deps, "exit");
    }
    const agent: AgentKind = snapshot.agent === "codex" ? "codex" : "claude";
    const adapter = adapterFor(agent);
    if (!adapter.completedTurnWaitState) return "uncorrected";
    const state = await (deps.state ?? (() => adapter.completedTurnWaitState!({
      pid: snapshot.pid,
      transcriptPath: typeof snapshot.transcript === "string" ? snapshot.transcript : undefined,
    })))();
    if (state === "pending") {
      const threadState = deps.threadWaitState ? await deps.threadWaitState() : "unavailable";
      // The picker is pure client-side TUI state: thread/read reports daemon idle both while it is
      // visibly open and after ESC. Therefore only waiting=true is useful confirmation; idle and
      // unavailable are ignored. ESC may remain stuck until the one-hour hard TTL, an accepted cost
      // of restoring the durable rollout-signature semantics without false dismissal.
      const daemonIdle = threadState === "notWaitingOnUserInput";
      tracePicker(sessionId, deps, {
        source: "watchdog", classifier: state, marker: "kept",
        daemonQuery: threadState,
        daemonIgnored: threadState !== "waitingOnUserInput",
        settle: daemonIdle ? "blocked" : "none",
      });
      return "uncorrected";
    }
    if (state !== "resolved") {
      tracePicker(sessionId, deps, { source: "watchdog", classifier: state, marker: "kept" });
      return "uncorrected";
    }
    const dbg = formatPlanPickerDebug({
      event: "resolve", classifier: state, marker: "0", ttl: markerAge(record, now), by: "wd",
    });
    const envelope = await buildWorkingEnvelope(sessionId, snapshot, now, config.e2eKey, agent, dbg);
    const next: SessionRecord = {
      ...snapshot,
      ts: now,
      lastEvent: "working",
      sentDone: false,
      op: "update",
      prio: 0,
      blob: envelope.blob as string,
      pairingId: config.pairingId,
      pendingPlanPicker: undefined,
      planPickerPendingSince: undefined,
      planPickerSettled: undefined,
      dbg,
    };
    // Persist first so a process replacement cannot reproduce the phone/local divergence from F12.
    await (deps.writeRecord ?? ((p: string, rec: SessionRecord) => atomicWrite(p, JSON.stringify(rec), 0o600)))(path, next);
    let outcome: PostOutcome;
    try {
      outcome = await (deps.post ?? ((body: object) => postEvent(config, body)))(envelope);
    } catch {
      tracePicker(sessionId, deps, {
        source: "watchdog", classifier: state, marker: "cleared", correctionPosted: false,
      });
      return "pending"; // the durable working correction owns this sweep
    }
    tracePicker(sessionId, deps, {
      source: "watchdog", classifier: state, marker: "cleared", correctionPosted: outcome === "delivered",
    });
    if (outcome === "revoked") return "revoked";
    if (outcome !== "delivered") return "pending";
    return "corrected";
  } catch {
    return "uncorrected";
  }
}

// --- Plan-picker completion verification ------------------------------------------------------
//
// Codex persists the exact final <proposed_plan> wrapper before task_complete, with an observed flush
// gap that is not bounded tightly enough for a short-lived Stop hook. Stop/notify therefore leave a
// local verification marker and keep the wire state working. This long-lived daemon owns the eventual
// decision. A short recent-done backstop also repairs records written by older builds / killed hooks.

/** A marker must not defer a genuinely ambiguous completion forever. Five sweeps gives rollout I/O
 *  ample time to settle; past this, anything short of the complete picker proof fails closed to done. */
export const PLAN_PICKER_VERIFY_MAX_MS = 30_000;
/** Absolute safety bound for either durable Plan-picker marker. A fully confirmed rollout signature
 *  can otherwise remain valid forever after ESC because dismissal is intentionally absent from JSONL.
 *  One hour preserves long deliberation while guaranteeing that no pending marker is immortal. */
export const PLAN_PICKER_PENDING_MAX_MS = 60 * 60_000;
/** Migration/self-heal window for a plain done a killed hook left behind. Exact full picker proof +
 *  live pid + no later progress is still required. Bounded so old done rows are never reconsidered
 *  indefinitely. */
export const PLAN_PICKER_RECENT_DONE_MS = 30 * 60_000;

/** Pure gate for marked completions and the narrowly bounded old-build done backstop. */
export function shouldPlanPickerVerificationCheck(record: SessionRecord, now: number): boolean {
  if (record.agent !== "codex" || record.provisional === true) return false;
  if (typeof record.transcript !== "string" || record.transcript.length === 0) return false;
  if (record.planPickerVerificationPending === true) return true;
  // CONVERGENCE LATCH. `planPickerSettled` is written by exactly one place — settlePendingPlanPickerDone
  // — and therefore means "this watchdog has already adjudicated this picker episode as terminal",
  // with the whole picture (TTL fired, or a correlated TUI proven dead). The backstop below re-opens a
  // done from *rollout evidence alone*, and the rollout signature is durable forever: Codex never
  // writes picker dismissal to JSONL. So without this gate the two correctives are exact inverses and
  // neither ever wins — measured 2026-08-02 as 738 posted corrections over 48min (~7.3s per flip),
  // every one of them a prio-1 ⇄ done Live Activity push against the ~40/6min ActivityKit budget.
  // The latch is released only by genuine NEW evidence: correctResolvedPlanPicker clears it when the
  // rollout shows real progress, and every hook write rebuilds the record without it, so a later turn
  // opening a real picker is unaffected.
  if (record.planPickerSettled === true) return false;
  if (record.op !== "done" || record.lastEvent !== "done" || record.sentDone !== true) return false;
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return false;
  const age = now - record.ts;
  return age >= 0 && age <= PLAN_PICKER_RECENT_DONE_MS;
}

/** Hard marker TTL, anchored explicitly when available and falling back to `ts` for v1.4.7 records. */
export function planPickerPendingExpired(record: SessionRecord, now: number): boolean {
  if (record.planPickerVerificationPending !== true && record.pendingPlanPicker !== true) return false;
  const since = typeof record.planPickerPendingSince === "number" && Number.isFinite(record.planPickerPendingSince)
    ? record.planPickerPendingSince
    : typeof record.ts === "number" && Number.isFinite(record.ts)
      ? record.ts
      : -Infinity;
  return now - since >= PLAN_PICKER_PENDING_MAX_MS;
}

export interface PlanPickerVerificationDeps {
  state?: () => Promise<"pending" | "incomplete" | "resolved" | "none" | "exited" | "unknown">;
  evidence?: () => Promise<CodexPlanPickerEvidence>;
  post?: (body: object) => Promise<PostOutcome>;
  writeRecord?: (path: string, rec: SessionRecord) => Promise<void>;
  readRecord?: (path: string) => Promise<SessionRecord | null>;
  threadWaitState?: () => Promise<CodexThreadWaitState>;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
  trace?: (decision: PlanPickerTraceDecision) => void;
}

/** Watchdog-owned settlement for a possibly completed Plan turn.
 *   pending    → exact wrapper + task_complete + live pid: post needsAttention and pin picker marker.
 *   resolved  → later task_started/user_message: clear only a provisional verification marker.
 *   incomplete/none/unknown → keep a fresh marker; after the cap, confirm done.
 *   exited     → leave it to the normal dead-pid op:end path.
 * A recent done (including a v1.4.8 settled record) is correction-only: anything except exact pending
 * with a live pid is left untouched. */
export async function correctPlanPickerVerification(
  config: Config, path: string, sessionId: string, record: SessionRecord,
  deps: PlanPickerVerificationDeps = {},
): Promise<"corrected" | "pending" | "uncorrected" | "revoked"> {
  try {
    const now = (deps.now ?? Date.now)();
    if (!shouldPlanPickerVerificationCheck(record, now)) return "uncorrected";
    const recentDoneBackstop = record.planPickerVerificationPending !== true;
    // Re-opening a done demands proof the session can still be showing a picker. For a daemon-fronted
    // Codex row `record.pid` is the app-server — alive for every session on the machine, so it proves
    // nothing. When the precision-biased correlation has stamped a real TTY, that is the process that
    // owns the picker; correctResolvedPlanPicker already treats its death as decisive enough to settle,
    // so it must also be decisive enough to refuse a resurrection.
    const ownerPid = typeof record.tuiPid === "number" && Number.isFinite(record.tuiPid)
      ? record.tuiPid : record.pid;
    if (recentDoneBackstop && !(deps.pidAlive ?? pidAlive)(ownerPid)) {
      tracePicker(sessionId, deps, {
        source: "watchdog", classifier: "dead-pid", marker: record.planPickerSettled === true ? "settled" : "none",
      });
      return "uncorrected";
    }
    const readCurrent = deps.readRecord ?? readRecordAt;
    const writeRecord = deps.writeRecord
      ?? ((p: string, rec: SessionRecord) => atomicWrite(p, JSON.stringify(rec), 0o600));
    const post = deps.post ?? ((body: object) => postEvent(config, body));
    const freshUnchanged = async (): Promise<SessionRecord | null> => {
      const fresh = await readCurrent(path);
      if (!fresh || recordMovedSince(record, fresh)) return null;
      if (fresh.turnId !== record.turnId) return null;
      if (fresh.planPickerVerificationPending !== record.planPickerVerificationPending) return null;
      if (fresh.planPickerSettled !== record.planPickerSettled) return null;
      return fresh;
    };

    // This check deliberately precedes rollout evidence and daemon IO. Even a permanently exact
    // pending signature or a wedged query cannot keep the durable marker beyond the sanity TTL.
    if (record.planPickerVerificationPending === true && planPickerPendingExpired(record, now)) {
      return await settlePendingPlanPickerDone(config, path, sessionId, record, now, deps);
    }

    const evidence = deps.evidence
      ? await deps.evidence()
      : deps.state
        ? { state: await deps.state() }
        : await codexAdapter.completedTurnWaitEvidence!({
          pid: record.pid,
          transcriptPath: record.transcript,
        });
    const state = evidence.state;

    if (state === "exited") {
      tracePicker(sessionId, deps, {
        source: "watchdog", classifier: state, marker: record.planPickerSettled === true ? "settled" : "kept",
      });
      return "uncorrected";
    }
    if (state === "resolved") {
      if (record.planPickerVerificationPending !== true) {
        tracePicker(sessionId, deps, {
          source: "watchdog", classifier: state, marker: record.planPickerSettled === true ? "settled" : "none",
        });
        return "uncorrected";
      }
      const fresh = await freshUnchanged();
      if (!fresh) {
        tracePicker(sessionId, deps, {
          source: "watchdog", classifier: "resolved-stale", marker: "kept", settle: "blocked",
        });
        return "uncorrected";
      }
      await writeRecord(path, {
        ...fresh,
        planPickerVerificationPending: undefined,
        planPickerPendingSince: undefined,
      });
      tracePicker(sessionId, deps, {
        source: "watchdog", classifier: state, marker: "cleared",
      });
      return "pending"; // locally settled; own this sweep so its stale snapshot is not heartbeated
    }

    if (state === "pending") {
      const threadState = deps.threadWaitState ? await deps.threadWaitState() : "unavailable";
      // Only explicit waiting confirms the picker; daemon idle is structurally ambiguous for the TUI
      // and is ignored exactly like unavailable. The durable rollout proof + hard TTL own the state.
      const daemonIgnored = threadState !== "waitingOnUserInput";
      // Re-read BEFORE posting: a user prompt/Stop could have replaced the sweep snapshot while the
      // rollout probe ran. Never send stale attention for a record that has already moved on.
      const fresh = await freshUnchanged();
      if (!fresh) {
        tracePicker(sessionId, deps, {
          source: "watchdog", classifier: "pending-stale", marker: "kept",
          daemonQuery: threadState, daemonIgnored, settle: "blocked",
        });
        return "uncorrected";
      }
      const dbg = formatPlanPickerDebug({
        event: recentDoneBackstop ? "recorrect" : "verify",
        classifier: state,
        marker: "p",
        daemon: threadState === "waitingOnUserInput" ? "wait" : threadState === "notWaitingOnUserInput" ? "idle" : "na",
        daemonDisposition: daemonIgnored ? "ign" : "keep",
        ttl: markerAge(record, now),
        by: "wd",
      });
      const envelope = await buildNeedsAttentionEnvelope(
        sessionId, record, now, config.e2eKey, "codex", Math.floor(now / 1000), undefined, "userInput", evidence.plan, dbg,
      ) as Record<string, unknown>;
      // Durable first: if the watchdog is replaced after the POST, the successor sees the same prio-1
      // picker state instead of the old prio-0 verification marker.
      await writeRecord(path, {
        ...fresh,
        ts: now,
        lastEvent: "needsAttention",
        sentDone: false,
        op: "update",
        prio: 1,
        blob: envelope.blob as string,
        pairingId: config.pairingId,
        pendingPlanPicker: true,
        planPickerVerificationPending: undefined,
        planPickerPendingSince: now,
        planPickerSettled: undefined,
        donePending: undefined,
        doneAttempts: undefined,
        dbg,
      });
      let outcome: PostOutcome;
      try {
        outcome = await post(envelope);
      } catch {
        tracePicker(sessionId, deps, {
          source: "watchdog", classifier: state, marker: "set-pending",
          daemonQuery: threadState, daemonIgnored, settle: threadState === "notWaitingOnUserInput" ? "blocked" : "none",
          correctionPosted: false,
        });
        return "pending"; // the durable prio-1 state owns this sweep and is retryable
      }
      tracePicker(sessionId, deps, {
        source: "watchdog", classifier: state, marker: "set-pending",
        daemonQuery: threadState, daemonIgnored, settle: threadState === "notWaitingOnUserInput" ? "blocked" : "none",
        correctionPosted: outcome === "delivered",
      });
      if (outcome === "revoked") return "revoked";
      if (outcome !== "delivered") return "pending";
      return "corrected";
    }

    // An old-build plain done is correction-only. No complete proof means no resurrection.
    if (record.planPickerVerificationPending !== true) {
      tracePicker(sessionId, deps, {
        source: "watchdog", classifier: state, marker: record.planPickerSettled === true ? "settled" : "none",
      });
      return "uncorrected";
    }
    const age = typeof record.ts === "number" && Number.isFinite(record.ts) ? now - record.ts : Infinity;
    if (age < PLAN_PICKER_VERIFY_MAX_MS) {
      tracePicker(sessionId, deps, { source: "watchdog", classifier: state, marker: "kept" });
      return "pending";
    }

    // The marked candidate never became a full picker signature within the cap. Fail closed to done,
    // preserving the original event time in the blob so this delayed confirmation does not look fresh.
    return await settlePendingPlanPickerDone(config, path, sessionId, record, now, deps);
  } catch {
    return "uncorrected";
  }
}

/** The staleness-heartbeat envelope: re-send the record's stored blob verbatim under its stored
 *  op/prio with a fresh ts, so the worker re-pushes the SAME content-state and re-arms its stale-date
 *  without any state change. Null when the record carries no blob (a pre-v2 record) — nothing to
 *  re-send, so the session simply isn't heartbeated.
 *
 *  KEY-ROTATION GUARD: the stored blob is sealed under the E2E key of the pairing that was live when
 *  the hook wrote the record. A re-pair rotates pairing + key but leaves session records on disk, and
 *  a verbatim re-send would then push frames the phone can NEVER decrypt ("Encrypted session ·
 *  Running" forever — observed 2026-07-10 after a re-pair). When `currentPairingId` is given, the
 *  record must carry the SAME pairingId to be heartbeated; a mismatch or a pre-fix record with no
 *  stamp yields null (the next real hook re-seals + restamps, restoring heartbeats). */
export function buildHeartbeatEnvelope(sessionId: string, record: SessionRecord, now: number, currentPairingId?: string): object | null {
  if (typeof record.blob !== "string" || record.blob.length === 0) return null;
  if (currentPairingId !== undefined && record.pairingId !== currentPairingId) return null;
  return { v: 2, sessionId, op: record.op ?? "update", prio: record.prio ?? 0, ts: now, blob: record.blob, ...startedAtField(record) };
}

/** The outcome of one POST to /cc/event, from the watchdog's point of view:
 *  - delivered → a 2xx: the event landed; the caller may delete/rewrite the session file.
 *  - revoked   → a 404 or 410: the pairing record is GONE server-side for THIS POST. requirePCAuth
 *                returns 404 {error:"not found"} for an unknown pairing, and handlePairRevoke deletes
 *                the record (see server/src/pairing.ts); a 410 is the dormant-GC "gone once" signal the
 *                worker sends before it 404s. A SINGLE gone response can still be a transient/racing
 *                delete (worker redeploy, KV eventual-consistency), so the run() loop does NOT tear the
 *                config down on the first one — it counts it against the shared gone-strike streak
 *                (recordGoneStrike) and only tears down at GONE_STRIKE_LIMIT, exactly like the hook.
 *  - failed    → anything else — a 401 (ambiguous: a missing header or a mismatched secret, NOT the
 *                documented revoke result), a 429/5xx, or a network error / timeout. All transient;
 *                the caller must NOT delete a healthy config on these, only retry next sweep. */
export type PostOutcome = "delivered" | "revoked" | "failed";

/** Map an HTTP status to a PostOutcome. Pure, so the 404-vs-everything-else keying that decides
 *  whether we tear down the local pairing is unit-testable without a socket. 2xx → delivered, the
 *  server's revoked/unknown-pairing 404 → revoked, every other status → failed (transient). */
export function postOutcomeForStatus(status: number): PostOutcome {
  if (status >= 200 && status < 300) return "delivered";
  if (status === 404 || status === 410) return "revoked"; // pairing gone server-side (404 deleted / 410 dormant-GC'd)
  return "failed";
}

/** The header set for a WATCHDOG /cc/event POST. Pure (the approvals value is passed in), so the
 *  one header that differs from every other POSTer's is unit-testable without touching fetch.
 *
 *  `x-cc-role: "watchdog"` is what gates piggybacked command delivery (see the command-intake
 *  section): the worker attaches `commands` ONLY to requests carrying it, and consumes each command
 *  as it answers. It must therefore be sent by the one caller that READS the response body — this
 *  one. hook.ts, codex-notify.ts, reset.ts and shared.ts's pending-pairing flush all POST the same
 *  route and all discard the body, so if they claimed this role they would consume-and-drop the
 *  user's queued command. DO NOT add this header anywhere else. Literal-matched by the worker, same
 *  posture as x-cc-approvals's "on"/"off". */
export function watchdogEventHeaders(config: Config, approvals: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-cc-pairing": config.pairingId,
    "x-cc-auth": config.pcSecret,
    "x-cc-version": PLUGIN_VERSION,
    // This computer's local remote-approvals pause (`nomo-cc permission off`) — same plaintext
    // report every /cc/event POSTer sends; the worker literal-matches "on"/"off".
    "x-cc-approvals": approvals,
    // Only this POSTer drains the command queue (see the doc comment above).
    "x-cc-role": "watchdog",
  };
}

// --- LAN listener handle (NOM-44 phase 1) ------------------------------------------------------
//
// The listener is a same-network fast path for phone→Mac commands; the worker channel below stays
// canonical and completely unchanged. Two module-level handles because two very different call sites
// need it: postEvent (to piggyback the sealed host hint) and the signal handlers (to stop the socket).

/** The running loop's listener, published so postEvent can read its address and the SIGTERM/SIGINT
 *  handler can close the socket. Undefined outside a live run(). */
let activeLanListener: LanListener | undefined;

/** Publishes the sealed LAN host hint on the POSTs the daemon already makes (see lan-listener). It is
 *  a module singleton for the same reason the buffers above are: postEvent has no place to hang state. */
const lanHintPublisher = createLanHintPublisher({ address: () => activeLanListener?.address() ?? null });

/** POST a v2 envelope to the Worker with the per-pairing auth headers. `delivered` ONLY on a 2xx:
 *  a 401/500 is a FAILURE, not success — otherwise a bad secret or a Worker error would count as
 *  delivered and the caller would delete/rewrite the session file, losing the session. A 404 is
 *  `revoked` (the definitive pairing-is-gone signal, keyed on the server's own not-found response).
 *  Any network error / timeout is a transient `failed`. Best-effort: never throws across its boundary. */
async function postEvent(config: Config, body: object): Promise<PostOutcome> {
  try {
    // The LAN listener's sealed host hint rides along on the POSTs this daemon already makes — no new
    // request is ever issued for discovery, and `take` returns undefined unless the hint actually
    // changed or its 5-minute refresh came due (so the overwhelming majority of POSTs are untouched).
    const lanHint = await lanHintPublisher.take(config);
    const payload = lanHint ? { ...body, lanHint } : body;
    const res = await fetch(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: watchdogEventHeaders(config, await localApprovalsState()),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    });
    const outcome = postOutcomeForStatus(res.status);
    // A 2xx MAY piggyback queued phone→Mac commands (see the command-intake section below). The
    // worker consumes them as it answers, so this response is the ONLY time we will ever see them —
    // buffer them here and let the sweep loop execute them off the POST path. Best-effort: a
    // non-JSON body (captive portal, edge interposition, truncated read) must degrade to a plain
    // delivered, never throw out of a POST that already succeeded.
    if (outcome === "delivered") {
      try { bufferCommands(extractCommands(await res.json())); } catch { /* not JSON → no commands */ }
    }
    return outcome;
  } catch {
    return "failed";
  }
}

// --- Command intake (phone → Mac, piggybacked on the /cc/event response) -----------------------
//
// The phone can ask this computer to DO something — today only "focus the terminal this session is
// running in". There is no inbound channel to a laptop behind NAT, and adding a poll would cost a
// request every few seconds forever, so commands ride back on the response to the POSTs the watchdog
// already makes — and ONLY to those, gated on the x-cc-role header (see watchdogEventHeaders):
//
//   {"ok":true, …, "commands":[{"id":"<opaque>","blob":"<sealed>"}]}
//
// The key is OMITTED when nothing is queued, and the worker CONSUMES each command as it delivers it,
// so every command is seen exactly once and there is nothing to re-request.
//
// E2E-SEALED, same invariant as every other phone→Mac payload (decision answers are an opaque
// answerBlob the hold decrypts with config.e2eKey; see permission.ts). The worker relays an OPAQUE id
// and blob: no kind, no sessionId, no timestamp in the clear. `blob` is the SAME envelope as every
// other blob in this codebase — standard padded base64 of AES-256-GCM iv(12) + ct + tag(16), sealed
// by the phone under the pairing e2eKey — so decryptBlob is exactly the right reader and GCM's tag
// check is what makes a forged or tampered command unexecutable. Sealed plaintext:
//
//   {"kind":"focus-terminal","sessionId":"<id>","ts":<epoch ms>,"nonce":"<random>"}
//
// Because the relay is BLIND, three responsibilities that would normally sit server-side moved here:
// the kind allow-list, freshness, and de-duplication (both replay across batches and collapsing two
// rapid taps within one batch). postEvent buffers what it parses (its PostOutcome signature is
// depended on by a dozen injected `post:` deps and stays exactly as it was); the sweep loop drains
// the buffer once per tick, so neither decryption nor a slow osascript ever sits on the POST path.

/** One command exactly as it arrives on the wire: an opaque id plus the sealed payload. Nothing here
 *  is trustworthy until the blob decrypts. */
export interface SealedCommand {
  id: string;
  blob: string;
}

/** The authenticated command, after decryption. Every field is phone-authored and tag-protected. */
export interface CommandPayload {
  kind: string;
  sessionId: string;
  /** Epoch-ms the PHONE sealed it — authenticated, unlike any server-supplied time. */
  ts: number;
  /** Per-command random string; the replay bound (a compromised worker can re-deliver an old blob
   *  under a fresh id, so the id set alone cannot stop replay). */
  nonce: string;
}

/** The kinds this plugin will act on. The allow-list lives HERE, not on the worker, because the
 *  plugin is now the ONLY party that can read the blob — a blind relay cannot filter what it can't
 *  see. Anything else decrypts fine and is then rejected as bad-kind. */
const COMMAND_KINDS_ALLOWED = new Set(["focus-terminal"]);

/** Cap on commands accepted from ONE response. A compromised/buggy worker must not be able to hand
 *  this daemon an unbounded work list; 8 is far above the real ceiling (a user taps one row). */
const COMMANDS_PER_RESPONSE_MAX = 8;
/** Cap on the pending buffer, in case several POSTs in one tick each carry commands. */
const COMMAND_BUFFER_MAX = 32;
/** How many executed command ids to remember, so a duplicate DELIVERY can't re-focus a window under
 *  the user's hands. Bounded: this is a long-lived process. */
const EXECUTED_COMMAND_IDS_MAX = 64;
/** How many seen nonces to remember. The nonce is the real replay bound (ids are worker-chosen and
 *  therefore forgeable), and it only works if a nonce cannot be EVICTED while its blob is still fresh
 *  enough to re-execute — otherwise a flood of junk commands would push the real one out and reopen
 *  the replay window. So this is sized against the maximum intake inside one TTL: at most
 *  COMMANDS_PER_RESPONSE_MAX (8) per POST and at most a POST every POLL_MS (5 s) plus the sweep's own
 *  correctives, i.e. well under 250 commands per 120 s. 512 leaves a 2x margin over that ceiling. */
const SEEN_NONCES_MAX = 512;
/** How old a SEALED ts may be before the command is refused — the worker's queue TTL. A command the
 *  user tapped two minutes ago is stale intent: they have moved on, and executing it would yank a
 *  window unexpectedly. This is also what bounds replay together with the nonce set. */
export const COMMAND_TTL_MS = 120_000;
/** How far into the future a SEALED ts may sit before it is refused. Phone, worker and Mac clocks
 *  drift independently (NTP skew, a laptop waking from sleep with a stale clock), and 30 s is
 *  comfortably above real-world skew while staying well inside the 120 s TTL — so the accept window
 *  is never wider than the TTL it is meant to enforce. */
export const COMMAND_FUTURE_SKEW_MS = 30_000;

/** Commands buffered out of POST responses, awaiting the next drain (still sealed). */
const commandBuffer: SealedCommand[] = [];
/** Command ids already handled by THIS daemon (insertion-ordered, evicted oldest-first). */
const executedCommandIds = new Set<string>();
/** Sealed nonces already seen by THIS daemon — the cross-batch replay bound. */
const seenCommandNonces = new Set<string>();

/** Parse the OPTIONAL `commands` key of a /cc/event response body. The wire entries are now OPAQUE,
 *  so this is a pure shape check: a non-empty string `id` and a non-empty string `blob`. Everything
 *  semantic (kind, session, freshness) is unknowable until the blob is decrypted and is validated in
 *  drainCommands. Tolerates a missing / non-array key, caps the result, and NEVER throws — a
 *  malformed body must degrade to "no commands", exactly like an unparseable one. Pure. */
export function extractCommands(body: unknown): SealedCommand[] {
  try {
    if (typeof body !== "object" || body === null) return [];
    const raw = (body as Record<string, unknown>).commands;
    if (!Array.isArray(raw)) return []; // absent (the normal case) or the wrong shape
    const out: SealedCommand[] = [];
    for (const entry of raw) {
      if (out.length >= COMMANDS_PER_RESPONSE_MAX) break;
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string" || e.id.length === 0) continue;
      if (typeof e.blob !== "string" || e.blob.length === 0) continue;
      out.push({ id: e.id, blob: e.blob });
    }
    return out;
  } catch {
    return [];
  }
}

/** Shape-check a DECRYPTED command payload. Only a phone bug can produce a malformed one (the worker
 *  cannot forge a valid tag), so this is a distinct outcome from a decrypt failure. Pure. */
export function parseCommandPayload(plain: unknown): CommandPayload | undefined {
  if (typeof plain !== "object" || plain === null) return undefined;
  const p = plain as Record<string, unknown>;
  if (typeof p.kind !== "string" || p.kind.length === 0) return undefined;
  if (typeof p.sessionId !== "string" || p.sessionId.length === 0) return undefined;
  if (typeof p.ts !== "number" || !Number.isFinite(p.ts)) return undefined;
  if (typeof p.nonce !== "string" || p.nonce.length === 0) return undefined;
  return { kind: p.kind, sessionId: p.sessionId, ts: p.ts, nonce: p.nonce };
}

/** Is this authenticated command still live? False when the tap is older than the queue TTL (stale
 *  intent — the user has moved on) or sits implausibly far in the future (clock skew beyond the
 *  margin). Keyed on the SEALED ts only; a server-supplied time is not authenticated. Pure. */
export function commandIsFresh(ts: number, now: number): boolean {
  if (ts > now + COMMAND_FUTURE_SKEW_MS) return false;
  return now - ts <= COMMAND_TTL_MS;
}

/** Queue parsed commands for the next drain (bounded). Best-effort, never throws. */
function bufferCommands(commands: SealedCommand[]): void {
  for (const c of commands) {
    if (commandBuffer.length >= COMMAND_BUFFER_MAX) return;
    commandBuffer.push(c);
  }
}

/** Test-only reset of the module-global command state (what a fresh daemon starts with). */
export function resetCommandState(): void {
  commandBuffer.length = 0;
  executedCommandIds.clear();
  seenCommandNonces.clear();
}

/** What a command ended up doing — the ONLY debugging channel a user has for this feature, so every
 *  command produces exactly one line whatever happens. The first six are REJECTIONS that happen
 *  before anything is executed (see drainCommands' validation order); the rest describe the focus
 *  attempt itself. */
export type FocusTraceResult =
  | "decrypt-failed"    // the blob did not decrypt/authenticate under this pairing's key
  | "malformed"         // it decrypted, but the sealed JSON isn't a command (a phone bug)
  | "bad-kind"          // authentic, but not a kind this plugin acts on
  | "stale"             // the sealed tap is older than the queue TTL, or implausibly future-dated
  | "replay"            // this sealed nonce has already been seen by this daemon
  | "duplicate"         // repeated command id, or a second tap for the same target in one batch
  | "unknown-session"   // the sealed sessionId names no session on this machine
  | "focused"           // a window (or at least the owning app) came forward
  | "no-candidate"      // no live TUI process could be identified for it
  | "ambiguous"         // several equally-plausible TUIs — deliberately no guess
  | "osascript-failed"  // AppleScript refused (TCC denial / timeout / app error)
  | "unsupported";      // not macOS, unknown terminal app, or an agent with no locate seam

/** Best-effort trace with the same argv guard tracePicker uses: pure unit calls run inside `bun test`
 *  with the production HOME visible and must never pollute the user's live trace. */
function traceFocus(deps: { trace?: (event: object) => void }, event: object): void {
  if (deps.trace) {
    try { deps.trace(event); } catch { /* diagnostics only */ }
    return;
  }
  if (process.argv.some((arg) => arg === "test" || arg.endsWith(".test.ts"))) return;
  traceSession(event);
}

/** Injectable seams for the drain, so the whole path is testable with no filesystem and no osascript.
 *  Decryption is deliberately NOT a seam: tests seal real blobs with the repo's own crypto helpers,
 *  so they prove interop with the phone's envelope rather than a mock's. */
export interface DrainCommandsDeps {
  /** Take (and clear) the pending sealed commands. Defaults to draining the module buffer. */
  take?: () => SealedCommand[];
  /** Every session record on disk, id + record. Defaults to the sweep's own reader. */
  readRecords?: () => Promise<RecordEntry[]>;
  /** Raise the window for a located pid. The record context lets terminal-focus correlate a herdr
   *  daemon-owned pty to its pane. Defaults to the real macOS focus path. */
  focus?: (pid: number, context: FocusContext) => Promise<FocusResult>;
  /** The adapter registry the per-session locate dispatches through (same seam
   *  discoverLiveSessions / reconcileProvisionalsSweep expose), so a test can supply a locator
   *  without spawning a real `ps`. Defaults to the real registry. */
  adapters?: AgentAdapter[];
  /** Exact live-hold seam behind Open on Mac's TUI-picker release. Test defaults never read the
   *  developer's real session directory. */
  readDecisionHoldFn?: (sessionId: string) => Promise<DecisionHold | null>;
  holdPidAliveFn?: (pid: number) => boolean;
  answerStore?: LanAnswerStore;
  resolveDecisionFn?: typeof resolveOnRelay;
  now?: () => number;
  trace?: (event: object) => void;
}

/** After a successful focus, release ONLY the specialized TUI request_user_input PreToolUse hold.
 *
 * A local Codex TUI has no app-server connection on which the watchdog can submit Op::UserInputAnswer,
 * so the phone must never be shown answer choices it cannot deliver. The special hold is identified by
 * its encrypted release-only card (Codex + request_user_input + NO permissionQuestions), and it must
 * still satisfy the same owner-pid and 10-minute TTL gate as the LAN state feed. The synthetic allow is
 * handed to the existing answer store; the hook emits updatedInput and Codex then opens its native picker.
 * The relay resolve is merely the split-brain cleanup/fail-open backstop and never gates local delivery. */
async function releaseFocusedTuiUserInputHold(
  config: Config, sessionId: string, now: number, deps: DrainCommandsDeps,
): Promise<boolean> {
  const readHold = deps.readDecisionHoldFn ?? (
    lanRunningUnderTest() ? async () => null : (id: string) => readDecisionHoldAt(SESSIONS_DIR, id)
  );
  const hold = await readHold(sessionId);
  const alive = hold && typeof hold.pid === "number"
    ? (deps.holdPidAliveFn ?? pidAlive)(hold.pid)
    : false;
  if (!stateHoldLive(hold, alive, now)) return false;

  let card: Record<string, unknown>;
  try {
    const plain = await decryptBlob(config.e2eKey, hold!.blob);
    if (typeof plain !== "object" || plain === null) return false;
    card = plain as Record<string, unknown>;
  } catch {
    return false;
  }
  const requestId = card.permissionRequestId;
  if (
    card.status !== "decisionPending"
    || card.agent !== "codex"
    || card.permissionToolName !== "request_user_input"
    || typeof requestId !== "string" || requestId.length === 0
    || Object.prototype.hasOwnProperty.call(card, "permissionQuestions")
  ) return false;

  const answerBlob = await encryptBlob(config.e2eKey, {
    requestId, decision: "allow", ts: Math.floor(now / 1000),
  });
  const stored = (deps.answerStore ?? lanAnswerStore).put(requestId, answerBlob, now);
  if (stored !== "stored") return false;
  try {
    void Promise.resolve((deps.resolveDecisionFn ?? resolveOnRelay)(config, requestId)).catch(() => {});
  } catch { /* local delivery already succeeded; relay cleanup is best-effort */ }
  return true;
}

/** Decrypt, VALIDATE, then execute every buffered command; returns how many actually focused
 *  something. Nothing is acted on until the blob authenticates, because the relay is blind and a
 *  compromised worker must not be able to author a control message this daemon obeys.
 *
 *  Validation order (cheapest / most-decisive first, and NOTHING runs before the tag check):
 *    1. repeated command id            -> duplicate       (free; a re-delivery of the same envelope)
 *    2. decryptBlob(config.e2eKey)     -> decrypt-failed  (GCM's tag catches forgery AND tampering)
 *    3. sealed JSON shape              -> malformed       (only a phone bug can reach this)
 *    4. kind in the plugin allow-list  -> bad-kind
 *    5. freshness of the SEALED ts     -> stale           (authenticated time; never the server's)
 *    6. nonce not seen before          -> replay          (then recorded, so the next copy is caught)
 *    7. sessionId is tracked locally   -> unknown-session
 *    8. first (kind, sessionId) in this batch -> duplicate (two rapid taps raise the window once)
 *  and only then the agent's locate seam + the focus itself.
 *
 *  The id set alone cannot stop replay — ids are worker-chosen, so an old blob can be re-delivered
 *  under a fresh one; the sealed nonce plus the 120 s freshness window are what bound it together.
 *  Batch collapsing lives here for the same reason the allow-list does: a blind relay cannot dedupe
 *  what it cannot read.
 *
 *  For an executable focus-terminal command: find the session record, pick its adapter via the same
 *  recordAgent/adapterFor dispatch every other net uses, and ask the adapter's optional locate seam
 *  WHICH live process is that session's interactive TUI. Undefined — no candidate, or several equally
 *  plausible ones — is a deliberate NO-OP: focusing the wrong window is worse than doing nothing.
 *  Every outcome is traced. The whole drain is wrapped: a command must never derail the sweep. */
export async function drainCommands(config: Config, deps: DrainCommandsDeps = {}): Promise<number> {
  try {
    const pending = (deps.take ?? (() => commandBuffer.splice(0, commandBuffer.length)))();
    if (pending.length === 0) return 0;
    const readRecords = deps.readRecords ?? readAllRecordEntries;
    const focus = deps.focus ?? ((pid: number, context: FocusContext) => focusTerminalForPid(pid, { context }));
    const now = (deps.now ?? Date.now)();
    let entries: RecordEntry[] | null = null;
    let focused = 0;
    /** (kind, sessionId) pairs already acted on IN THIS BATCH — the worker can no longer collapse
     *  two rapid taps for us, because it cannot see what they target. */
    const batchTargets = new Set<string>();
    for (const cmd of pending) {
      const base: Record<string, unknown> = { event: "focus-terminal", id: cmd.id };
      try {
        // 1. Same envelope delivered twice.
        if (executedCommandIds.has(cmd.id)) {
          traceFocus(deps, { ...base, result: "duplicate" as FocusTraceResult, why: "id" });
          continue;
        }
        // BEFORE the work: a throw mid-focus must not re-run this command on the next tick.
        rememberBounded(executedCommandIds, cmd.id, EXECUTED_COMMAND_IDS_MAX);

        // 2. The tag check. A worker that forges or edits a blob cannot produce a valid one.
        let plain: unknown;
        try {
          plain = await decryptBlob(config.e2eKey, cmd.blob);
        } catch {
          traceFocus(deps, { ...base, result: "decrypt-failed" as FocusTraceResult });
          continue;
        }
        // 3. Authentic, but is it a command?
        const payload = parseCommandPayload(plain);
        if (!payload) {
          traceFocus(deps, { ...base, result: "malformed" as FocusTraceResult });
          continue;
        }
        base.sessionId = payload.sessionId;
        base.kind = payload.kind;
        // 4. The plugin-side allow-list (the blind relay cannot filter what it cannot read).
        if (!COMMAND_KINDS_ALLOWED.has(payload.kind)) {
          traceFocus(deps, { ...base, result: "bad-kind" as FocusTraceResult });
          continue;
        }
        // 5. Stale intent, on the AUTHENTICATED clock.
        if (!commandIsFresh(payload.ts, now)) {
          traceFocus(deps, { ...base, result: "stale" as FocusTraceResult, age: now - payload.ts });
          continue;
        }
        // 6. Replay of an older sealed command under a fresh id.
        if (seenCommandNonces.has(payload.nonce)) {
          traceFocus(deps, { ...base, result: "replay" as FocusTraceResult });
          continue;
        }
        rememberBounded(seenCommandNonces, payload.nonce, SEEN_NONCES_MAX);
        // 7. A command may only ever name a session THIS machine tracks. The phone seals
        // CCSessionBrief.sessionId verbatim, and BOTH halves of the id-form question check out
        // (verified 2026-07-31, belt and braces):
        //   (a) a PROVISIONAL Codex discovery row is persisted under the very sentinel id the phone
        //       received — discoverLiveSessions writes buildProvisionalRecord to
        //       <SESSIONS_DIR>/<d.sessionId>.json, where d.sessionId is codexSentinelSessionId(pid),
        //       i.e. "codex-pid-<n>" — so a command naming the sentinel resolves here, it does not
        //       fall through to unknown-session;
        //   (b) a provisional row can never be in the state the phone's button is offered for anyway:
        //       buildProvisionalRecord only ever writes lastEvent sessionStart/done (op start/done,
        //       prio 0), and no net can flip one to needsAttention — correctPendingApproval requires a
        //       non-empty `transcript` (a provisional has none), shouldPlanPickerVerificationCheck
        //       excludes `provisional === true` outright, and correctResolvedPlanPicker needs a
        //       pendingPlanPicker marker a provisional never carries.
        // So the sentinel is accepted if it ever arrives, and it realistically never will.
        if (entries === null) entries = await readRecords(); // one dir read per drain, not per command
        const entry = entries.find((e) => e.sessionId === payload.sessionId);
        if (!entry) {
          traceFocus(deps, { ...base, result: "unknown-session" as FocusTraceResult });
          continue;
        }
        // 8. Two taps for the same target in one batch raise the window once.
        const target = `${payload.kind}|${payload.sessionId}`;
        if (batchTargets.has(target)) {
          traceFocus(deps, { ...base, result: "duplicate" as FocusTraceResult, why: "batch" });
          continue;
        }
        batchTargets.add(target);

        const agent = recordAgent(entry.rec);
        const adapter = deps.adapters
          ? deps.adapters.find((a) => a.kind === agent) ?? adapterFor(agent)
          : adapterFor(agent);
        if (!adapter.locateTuiPid) {
          traceFocus(deps, { ...base, agent, result: "unsupported" as FocusTraceResult });
          continue;
        }
        let reason: LocateTuiReason | undefined;
        const pid = await adapter.locateTuiPid(
          { sessionId: payload.sessionId, record: entry.rec },
          { note: (r) => { reason = r; } },
        );
        if (typeof pid !== "number" || !Number.isFinite(pid)) {
          const result: FocusTraceResult = reason === "ambiguous" ? "ambiguous" : "no-candidate";
          traceFocus(deps, { ...base, agent, result, reason: reason ?? "no-candidate" });
          continue;
        }
        const outcome = await focus(pid, { agent, record: entry.rec });
        if (outcome.ok) {
          focused += 1;
          const releasedTuiInput = await releaseFocusedTuiUserInputHold(
            config, payload.sessionId, now, deps,
          ).catch(() => false);
          traceFocus(deps, {
            ...base, agent, pid, result: "focused" as FocusTraceResult, via: outcome.via,
            reason: outcome.reason ?? reason, ...(releasedTuiInput ? { releasedTuiInput: true } : {}),
          });
          continue;
        }
        const result: FocusTraceResult = outcome.reason === "herdr-ambiguous"
          ? "ambiguous"
          : outcome.reason === "osascript-failed"
          ? "osascript-failed"
          : outcome.reason === "unsupported" ? "unsupported" : "no-candidate";
        const focusReason = outcome.reason === "herdr-cli-failed" || outcome.reason === "herdr-ambiguous"
          ? outcome.reason
          : reason;
        traceFocus(deps, { ...base, agent, pid, result, why: outcome.reason, reason: focusReason });
      } catch {
        traceFocus(deps, { ...base, result: "no-candidate" as FocusTraceResult, why: "error" });
      }
    }
    return focused;
  } catch {
    return 0; // a command must never derail the sweep
  }
}

// --- LAN command intake (phone → Mac, direct, same network) ------------------------------------
//
// The SECOND delivery channel for the exact same sealed commands. The phone dispatches both legs in
// parallel with the SAME ciphertext, so whichever arrives first wins and the loser is dropped by the
// inner-nonce replay check in drainCommands (step 6) — which is why nothing here re-validates the blob:
// a second dedupe on command content would only be a second thing to get wrong.
//
// CONCURRENCY (verified against drainCommands above, 2026-08-01): the drain is already interleave-safe.
// It takes its work with a synchronous `commandBuffer.splice(...)`, so two drains can never be handed
// the same entry; and BOTH of its check-then-remember pairs (`executedCommandIds.has` → rememberBounded,
// `seenCommandNonces.has` → rememberBounded) are synchronous with no await between the test and the
// insert, so even two copies of one command racing through separate drains resolve to exactly one
// executor and one "replay". The latch below therefore is not a correctness patch — it is a simplicity
// guarantee: with the immediate LAN drain added there are now TWO callers, and serializing them keeps
// the (already fine) reasoning about focus side effects trivially true rather than subtle.

/** Serializes every drainCommands call — the sweep's once-per-tick one and the LAN listener's
 *  immediate one — onto a single chain. Always resolves (drainCommands swallows everything). */
let drainChain: Promise<unknown> = Promise.resolve();

/** Queue a drain behind any in-flight one. Returns the number of commands that focused something. */
export function enqueueDrainCommands(config: Config, deps: DrainCommandsDeps = {}): Promise<number> {
  const run = (): Promise<number> => drainCommands(config, deps);
  const next = drainChain.then(run, run);
  drainChain = next.catch(() => {});
  return next;
}

/** Prefix stamped on the command id of a LAN-delivered command, so the trace line says which channel
 *  delivered it. The id is only ever used for the delivered-twice check (`executedCommandIds`); the
 *  REPLAY bound is the sealed inner nonce, which is identical on both legs — that is precisely what
 *  makes racing the two channels a no-op instead of a double focus. */
export const LAN_COMMAND_ID_PREFIX = "lan:";

/** The listener's command sink. Buffers the still-sealed blob exactly like extractCommands does for the
 *  worker leg, then kicks an IMMEDIATE drain — that one call is the whole latency win (a command no
 *  longer waits for the next 5 s sweep, let alone the next worker round trip).
 *
 *  The returned promise is for TESTS ONLY. The listener wires this in as `onCommand` (a void-returning
 *  sink) and deliberately does NOT await it: the HTTP response must go back the instant the blob is
 *  queued, never after an osascript window raise. It resolves rather than rejects in every case. */
export function acceptLanCommand(command: LanCommand, deps: DrainCommandsDeps = {}): Promise<number> {
  try {
    if (commandBuffer.length >= COMMAND_BUFFER_MAX) return Promise.resolve(0); // the worker leg's bound
    commandBuffer.push({ id: `${LAN_COMMAND_ID_PREFIX}${command.nonce}`, blob: command.blob });
    return enqueueDrainCommands(command.config, deps).catch(() => 0);
  } catch {
    return Promise.resolve(0); // a malformed sink call must never surface anywhere
  }
}

// --- LAN answer intake (phone → Mac, direct, same network) -------------------------------------
//
// The listener has ALREADY stored the sealed answer by the time this runs (the store is what the Claude
// hook's loopback poll and the in-process Codex relay read), so this sink has exactly one job: the
// SPLIT-BRAIN BACKSTOP. The phone dispatches its answer down both legs in parallel; if its worker leg
// failed while its LAN leg succeeded, the worker still holds a `pending` decision record and the island
// keeps showing live Allow/Deny buttons for a prompt that is already answered. Echoing the existing
// blob-free /v1/cc/decision/resolve retires it.
//
// THREE properties this must keep, all of them non-negotiable:
//  - OFF THE REQUEST PATH: the listener calls this and returns immediately; the phone's sealed {"ok":true}
//    never waits for a worker round trip (resolveOnRelay's own ceiling is 15 s).
//  - NEVER THROWS: it runs from an HTTP handler's stack. resolveOnRelay swallows everything; the extra
//    try/catch here covers a synchronous throw before the promise even exists.
//  - NEVER A GONE STRIKE: a 404/410 here means "that record is already gone", which is the NORMAL case
//    when the phone's own worker leg won the race. The gone-strike ladder is a /cc/event (worker
//    AUTHORITY) signal only — structurally so, since this path never calls recordGoneStrike.
//
// The echo can only ever retire a record that is STILL PENDING (the worker gives a phone answer
// precedence over this transition and returns its terminal state untouched), so it cannot destroy an
// answer a hold is mid-poll for. The one degraded case the design accepts: the phone's worker leg AND
// the hold's loopback poll both fail while this echo succeeds — the prompt then falls open to the
// terminal dialog, which is the fail-open outcome, never a misapplied decision.

/** The listener's answer sink. Fire-and-forget: the returned promise is for TESTS ONLY (the listener
 *  wires this in as a void-returning `onAnswer`) and always resolves. */
export function acceptLanAnswer(
  answer: LanAnswerDelivery,
  deps: {
    resolveFn?: (config: Config, requestId: string) => Promise<void>;
    trace?: (event: object) => void;
  } = {},
): Promise<void> {
  try {
    const resolve = deps.resolveFn ?? ((config: Config, requestId: string) => resolveOnRelay(config, requestId, fetch));
    return resolve(answer.config, answer.requestId).catch(() => {
      // Best-effort by design: if this echo ALSO fails, the worker's own ~30 s poll-liveness sweep
      // expires the record. Traced, never surfaced — the daemon's contract is silence.
      traceFocus(deps, { event: "lan", result: "echo-failed", requestId: answer.requestId });
    });
  } catch {
    return Promise.resolve(); // a malformed sink call must never surface anywhere
  }
}

// --- Live session discovery (surfacing a session before its first hook) -----------------------
//
// Codex fires no hook at session OPEN (openai/codex#15269), so the daemon asks every adapter to
// discover live TUIs the hooks can't see yet (adapter.discoverLive; Claude implements none) and POSTs
// a PROVISIONAL row for each — an op:start mirroring the blob a real SessionStart would send when a
// turn is in flight, an op:done "idle" row otherwise (see buildProvisionalBlob/Envelope) — plus a
// provisional session record so the reap/reconcile machinery can retire it. Claude's discoverLive is
// absent, so this whole step no-ops for Claude.

/** The friendly machine name for a POST (config override, else the OS hostname), matching the hook. */
function machineName(config: Config): string {
  return config.machineName ?? hostname().replace(/\.local$/, "");
}

/** A session record plus its id (the filename stem). */
export interface RecordEntry { sessionId: string; rec: SessionRecord }

/** Every session record currently on disk, id + record (provisional and real). Feeds discovery's
 *  known-pid exclusion and the reconcile backstop. Corrupt/half-written files are skipped. */
async function readAllRecordEntries(): Promise<RecordEntry[]> {
  try {
    const files = await readdir(SESSIONS_DIR);
    const out: RecordEntry[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try { out.push({ sessionId: basename(f, ".json"), rec: JSON.parse(await readFile(`${SESSIONS_DIR}/${f}`, "utf8")) as SessionRecord }); } catch { /* skip */ }
    }
    return out;
  } catch {
    return []; // no sessions dir yet
  }
}

/** Just the records, for discovery's known-pid exclusion. */
async function readAllRecords(): Promise<SessionRecord[]> {
  return (await readAllRecordEntries()).map((e) => e.rec);
}

/** The provisional blob for a discovered session — byte-shaped exactly like buildBlob's output for a
 *  SessionStart (title/machine/label, the adapter's `agent` field; no detail, no turnStartedAt — and
 *  no `model`: unknown at process-scan discovery, and the first real hook's blob self-corrects it —
 *  because a freshly-opened TUI has neither a tool nor a prompt yet). status mirrors the TUI's REAL turn state:
 *  "working" only when a turn is genuinely open, "done" for an idle REPL sitting at its prompt — an
 *  idle TUI advertised as working stuck "Running" on the phone forever (the v0.8.4 idle-TUI fix; see
 *  codexTurnActiveFromTail in adapter.ts). */
export async function buildProvisionalBlob(
  d: DiscoveredSession, machine: string, blobAgentFields: { agent?: AgentKind }, e2eKey: Uint8Array, at?: number,
): Promise<string> {
  // `at` (epoch SECONDS) appended LAST — the OBSERVED discovery time (a process-scan can't know the
  // TUI's real last-activity, so "now" is the honest value). OMITTED when the caller has none.
  const base = {
    status: d.idle === true ? "done" : "working", title: d.title ?? "", machine, label: d.label, ...blobAgentFields,
    ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
  };
  const dbg = appendCodexBridgeMarker(blobAgentFields.agent === "codex" ? formatPlanPickerDebug({
    event: "discover", classifier: d.idle === true ? "done" : "work", marker: "0", by: "wd",
  }) : undefined, codexBridgeIsDown());
  return encryptBlob(e2eKey, appendFittedPlanAndDebug(base, undefined, dbg));
}

/** The provisional envelope. An in-flight TUI mirrors a real SessionStart (op:start); an IDLE one is
 *  advertised as an already-finished row (op:done — the same op/prio a real Stop posts, so the worker's
 *  done-is-terminal semantics apply and the row never re-arms the island). Both carry the blob. */
export function buildProvisionalEnvelope(sessionId: string, blob: string, now: number, idle: boolean): object {
  return { v: 2, sessionId, op: idle ? "done" : "start", prio: 0, ts: now, blob };
}

/** The provisional op:start envelope — the same v2 shape the hook POSTs for a real SessionStart.
 *  (The in-flight arm of buildProvisionalEnvelope; kept for existing callers/tests.) */
export function buildStartEnvelope(sessionId: string, blob: string, now: number): object {
  return buildProvisionalEnvelope(sessionId, blob, now, false);
}

/** The provisional session record the discovery step persists (0600) so the daemon can reap it on pid
 *  death and the hook (or the sweep backstop) can reconcile it away. `provisional:true` is what marks
 *  it; `pid` is the discovered TUI process; agent rides via the adapter's blobAgentFields (omitted for
 *  claude), keeping this free of an inline `agent === …` branch. For an in-flight TUI, lastEvent/op
 *  mirror trackSession's fresh-start bookkeeping so a heartbeat/reap treats it like any other start;
 *  for an IDLE one they mirror a posted done (op:"done" + sentDone) so the interrupt/heartbeat/idle
 *  nets all treat it as finished — exactly what was advertised. The discovery title (cwd basename) is
 *  cached like trackSession's, so a later corrective done never regresses to title:"" (v0.8.3 rule). */
export function buildProvisionalRecord(
  d: DiscoveredSession, machine: string, blob: string, blobAgentFields: { agent?: AgentKind }, now: number,
  pairingId?: string, idle = false,
): SessionRecord {
  return {
    pid: d.pid,
    machine,
    label: d.label,
    ts: now,
    lastEvent: idle ? "done" : "sessionStart",
    op: idle ? "done" : "start",
    ...(idle ? { sentDone: true } : {}),
    prio: 0,
    blob,
    provisional: true,
    ...(typeof d.cwd === "string" && d.cwd.length > 0 ? { tuiCwd: d.cwd } : {}),
    ...(typeof d.startedAt === "number" && Number.isFinite(d.startedAt) ? { tuiStartedAt: d.startedAt } : {}),
    ...(typeof d.title === "string" && d.title.length > 0 ? { title: d.title } : {}),
    ...blobAgentFields,
    ...(blobAgentFields.agent === "codex" ? { dbg: appendCodexBridgeMarker(formatPlanPickerDebug({
      event: "discover", classifier: idle ? "done" : "work", marker: "0", by: "wd",
    }), codexBridgeIsDown()) } : {}),
    // Stamp the pairing this blob was sealed under so the heartbeat's key-rotation guard can prove
    // the blob is still decryptable (see buildHeartbeatEnvelope). Omitted only when unknown.
    ...(typeof pairingId === "string" && pairingId.length > 0 ? { pairingId } : {}),
  };
}

/** Injectable side-effect seams for the discovery step, so it's testable without real fs/network. */
export interface DiscoverDeps {
  adapters?: AgentAdapter[];
  post?: (body: object) => Promise<PostOutcome>;
  readRecords?: () => Promise<SessionRecord[]>;
  writeRecord?: (sessionId: string, rec: SessionRecord) => Promise<void>;
  now?: () => number;
}

/** One discovery pass: for every adapter that implements discoverLive, surface the live TUIs the hooks
 *  can't see yet as PROVISIONAL sessions. Each new one is POSTed per its turn state — op:start
 *  ("working") for an in-flight turn, op:done ("done") for an idle REPL (see buildProvisionalEnvelope);
 *  only on a delivered POST do we persist the provisional record (so a failed POST simply retries next
 *  sweep — the pid is still not "known"). Best-effort throughout: a discoverLive throw or a POST failure
 *  never derails the sweep. No-ops entirely when no adapter implements discoverLive (Claude) or no TUI
 *  is found. */
export async function discoverLiveSessions(config: Config, deps: DiscoverDeps = {}): Promise<void> {
  const adapters = deps.adapters ?? allAdapters;
  const post = deps.post ?? ((body: object) => postEvent(config, body));
  const readRecords = deps.readRecords ?? readAllRecords;
  const writeRecord = deps.writeRecord
    ?? ((sessionId: string, rec: SessionRecord) => atomicWrite(`${SESSIONS_DIR}/${sessionId}.json`, JSON.stringify(rec), 0o600));
  const now = deps.now ?? Date.now;
  const machine = machineName(config);
  const known = await readRecords();
  for (const adapter of adapters) {
    if (!adapter.discoverLive) continue;
    let discovered: DiscoveredSession[];
    try {
      discovered = await adapter.discoverLive(known);
    } catch {
      continue; // a scan failure must never derail the sweep
    }
    for (const d of discovered) {
      const ts = now();
      const idle = d.idle === true;
      const blob = await buildProvisionalBlob(d, machine, adapter.blobAgentFields, config.e2eKey, Math.floor(ts / 1000));
      const outcome = await post(buildProvisionalEnvelope(d.sessionId, blob, ts, idle));
      if (outcome !== "delivered") continue; // failed/revoked → retry next sweep, don't persist a ghost
      await writeRecord(d.sessionId, buildProvisionalRecord(d, machine, blob, adapter.blobAgentFields, ts, config.pairingId, idle));
    }
  }
}

/** The agent a record belongs to (absent → claude, the historical default). */
function recordAgent(record: SessionRecord): AgentKind {
  return record.agent === "codex" ? "codex" : "claude";
}

/** The sentinel ids of PROVISIONAL records whose pid is now also held by a REAL (non-provisional) record
 *  of a DISCOVERY-CAPABLE agent — i.e. the real hook fired but the hook's own reconcile didn't run
 *  (unpaired at hook time, or a race). Equality on pid: a real record's pid and its provisional's pid are
 *  the same TUI process.
 *
 *  "Discovery-capable" is read off the adapter registry (adapter.discoverLive present) rather than
 *  hardcoding `agent === "codex"` — provisionals only EXIST for agents that implement discoverLive, so
 *  keying on the same seam means a future discovery-capable agent reconciles for free and the daemon keeps
 *  its no-inline-agent-branch discipline. Today only codex implements it, so the set is identical. Pure;
 *  the registry is injectable for tests. */
export function provisionalsCoveredByReal(entries: RecordEntry[], adapters: AgentAdapter[] = allAdapters): string[] {
  const discoveryCapable = new Set(adapters.filter((a) => typeof a.discoverLive === "function").map((a) => a.kind));
  const realPids = new Set(
    entries
      .filter((e) => e.rec.provisional !== true && discoveryCapable.has(recordAgent(e.rec)) && typeof e.rec.pid === "number")
      .map((e) => e.rec.pid),
  );
  return entries
    .filter((e) => e.rec.provisional === true && typeof e.rec.pid === "number" && realPids.has(e.rec.pid))
    .map((e) => e.sessionId);
}

/** Injectable seams for the sweep-side provisional reconcile, so it's testable without fs/network. */
export interface SweepReconcileDeps {
  post?: (body: object) => Promise<PostOutcome>;
  readEntries?: () => Promise<RecordEntry[]>;
  deleteRecord?: (sessionId: string) => Promise<void>;
  /** The adapter registry that decides which agents are discovery-capable (see provisionalsCoveredByReal). */
  adapters?: AgentAdapter[];
  now?: () => number;
}

/** BACKSTOP for the hook's own reconcile: end + delete any provisional whose codex TUI now has a real
 *  session record. Covers the case where the hook couldn't reconcile (it was unpaired when it fired, or
 *  raced the discovery write). POSTs an op:end (worker reuses the last blob) and deletes the provisional
 *  only on a delivered POST — a failed POST leaves it for the next sweep. Best-effort. */
export async function reconcileProvisionalsSweep(config: Config, deps: SweepReconcileDeps = {}): Promise<void> {
  const post = deps.post ?? ((body: object) => postEvent(config, body));
  const readEntries = deps.readEntries ?? readAllRecordEntries;
  const deleteRecord = deps.deleteRecord ?? ((sessionId: string) => unlink(`${SESSIONS_DIR}/${sessionId}.json`).catch(() => {}));
  const now = deps.now ?? Date.now;
  const entries = await readEntries();
  for (const sessionId of provisionalsCoveredByReal(entries, deps.adapters ?? allAdapters)) {
    const outcome = await post(buildEndEnvelope(sessionId, now()));
    if (outcome === "delivered") await deleteRecord(sessionId);
  }
}

// --- Transcript interrupt recovery net -------------------------------------------------------
//
// An Esc-interrupt or a denied permission fires NO hook (on either agent), so the phone sticks on
// "needs you"/"working" with no corrective event ever POSTed. This watchdog tails the session
// transcript and asks the session's adapter (record.agent, absent → claude) whether its last turn
// was aborted; if so it POSTs a corrective op:done (the worker's done-is-terminal semantics finish
// the session and drop repeats). The two agents' detections are structurally different and live in
// the adapters (adapter.detectInterrupt) — see adapter.ts.

/** How much of the transcript tail to read. The interrupt marker rides the last turn line, so the
 *  final few KB always suffice; a byte-sliced first line just fails JSON.parse and is skipped. */
const INTERRUPT_TAIL_BYTES = 8 * 1024;
/** A `working` session refreshes its ts via hooks every ≤15 s; silence past this means either a
 *  long tool run or an interrupt — the transcript check disambiguates. */
const WORKING_STALE_MS = 20_000;
/** Bound on the interrupt net's corrective-done RETRIES. Once the interrupt is confirmed, a delivered
 *  done settles the session; a failed done bumps record.doneAttempts and retries next sweep. After this
 *  many consecutive FAILED deliveries the pairing is unreachable for this event, so the net stops the
 *  every-5-s re-POST loop and pins the record done LOCALLY (the worker's own one-hour eviction resolves
 *  the phone). 5 sweeps ≈ 25 s of retry covers a normal transient blip without looping forever — the
 *  same "cap retries so a permanently-failing POST can't spin" discipline as the 24 h staleness rule. */
const INTERRUPT_DONE_MAX_ATTEMPTS = 5;

/** Whether the transcript tail shows the last turn was interrupted, for the given agent — a thin
 *  wrapper over the session adapter's detectInterrupt (the two agents' detections differ; see
 *  adapter.ts). Kept exported so the per-agent detection stays unit-testable through "./cc-watchdog". */
export function tailShowsInterrupt(tail: string, agent: AgentKind): boolean {
  return adapterFor(agent).detectInterrupt(tail);
}

/** Gate: should this sweep even open the transcript for a still-ALIVE session? Only when the last
 *  POSTed status was `needsAttention` (checked every sweep — a pending question can be abandoned at
 *  any moment) or `working` gone silent past WORKING_STALE_MS. done/sessionStart are quiet states the
 *  net must not touch, and an empty/absent transcript path is unreadable so it's skipped. */
export function shouldInterruptCheck(record: SessionRecord, now: number): boolean {
  if (typeof record.transcript !== "string" || record.transcript.length === 0) return false;
  if (record.lastEvent === "needsAttention") return true;
  if (record.lastEvent === "working") {
    return typeof record.ts === "number" && now - record.ts > WORKING_STALE_MS;
  }
  return false;
}

/** Injectable side-effect seams for the interrupt net, so its settle/retry logic is testable without
 *  real fs/network. `now` clocks the corrective done's envelope ts + the record rewrite. */
export interface InterruptDeps {
  post?: (body: object) => Promise<PostOutcome>;
  readTail?: (path: string, bytes: number) => Promise<string>;
  writeRecord?: (path: string, rec: SessionRecord) => Promise<void>;
  now?: () => number;
}

/** The interrupt recovery net for one still-alive session. Gated by shouldInterruptCheck, then it tails
 *  the transcript and, if the last real turn line reads "interrupted by user", the session is DECIDED
 *  done — the only remaining question is delivery. It POSTs a corrective op:done and settles the record
 *  so the net can neither re-fire forever nor let the heartbeat re-raise the stale needsAttention blob:
 *   - delivered → pin lastEvent:"done" + sentDone (and CLEAR doneAttempts) so the gate skips it, the
 *                 heartbeat gates off (op:"done"), and the next hook re-arms from a done.
 *   - failed    → BOUNDED retry: bump record.doneAttempts and keep the record for next sweep. While
 *                 doneAttempts > 0 the heartbeat holds off (shouldHeartbeat), so the interrupt net owns
 *                 the session's fate instead of fighting a heartbeat that re-sends needsAttention. Past
 *                 INTERRUPT_DONE_MAX_ATTEMPTS consecutive failures the pairing is unreachable for this
 *                 event, so it stops POSTing and pins the record done LOCALLY (worker eviction resolves
 *                 the phone) — ending the every-sweep flap.
 *  Returns:
 *   - "corrected"   → it delivered a done this sweep → a 2xx landed; the caller counts it delivered and
 *                     must NOT also heartbeat the session.
 *   - "pending"     → the interrupt is confirmed but the done did NOT deliver (retrying, or the retry cap
 *                     was hit and the record was settled locally): NOT delivered, but the caller must
 *                     still skip the heartbeat (the interrupt net owns this session).
 *   - "uncorrected" → nothing to do (gate closed, no interrupt, or the transcript is unreadable).
 *   - "revoked"     → the POST 404'd: the pairing is gone server-side → the caller tears down. */
export async function correctInterrupt(
  config: Config, path: string, sessionId: string, record: SessionRecord, now: number, deps: InterruptDeps = {},
): Promise<"corrected" | "pending" | "uncorrected" | "revoked"> {
  const post = deps.post ?? ((body: object) => postEvent(config, body));
  const readTail = deps.readTail ?? ((p: string, bytes: number) => readSuffix(p, bytes));
  const writeRecord = deps.writeRecord
    // Owner-only (0600), same as the hook's trackSession — the record holds hostname, cwd basename, the
    // session pid, and the absolute transcript path; a rewrite must not widen its permissions.
    ?? ((p: string, rec: SessionRecord) => atomicWrite(p, JSON.stringify(rec), 0o600));
  const clock = deps.now ?? Date.now;
  try {
    if (!shouldInterruptCheck(record, now)) return "uncorrected";
    let tail: string;
    try {
      tail = await readTail(record.transcript as string, INTERRUPT_TAIL_BYTES);
    } catch {
      // Transcript missing / unreadable → nothing to check. For codex this also covers a cold rollout
      // that was compressed to `.jsonl.zst` (the plain path is deleted): readSuffix's stat() ENOENTs,
      // we land here, and the session is simply left for its dead-pid reap / staleness eviction.
      return "uncorrected";
    }
    const agent: AgentKind = record.agent === "codex" ? "codex" : "claude";
    if (!tailShowsInterrupt(tail, agent)) return "uncorrected"; // live turn or no interrupt → leave it
    // The interrupt is CONFIRMED from here — the session is decided done regardless of this POST's fate.
    // Bounded against disk AND this process's memory, so a record rewrite that keeps failing (full disk /
    // read-only home) can't reset the counter to zero every sweep and re-POST a doomed done forever.
    const attempts = effectiveDoneAttempts(record, sessionId);
    // Retry exhausted: stop the every-sweep re-POST and pin done LOCALLY so the gate closes and the
    // heartbeat can never re-raise needsAttention. We can't deliver, so the worker's own eviction is the
    // backstop. "pending": interrupt handled (caller skips the heartbeat), not delivered.
    if (attempts >= INTERRUPT_DONE_MAX_ATTEMPTS) {
      try {
        await writeRecord(path, { ...record, lastEvent: "done", sentDone: true, op: "done", doneAttempts: undefined });
        clearDoneAttempts(sessionId); // pinned done ON DISK → the gate closes; the bound has done its job
      } catch {
        // The pin didn't land, so the gate stays OPEN and this net will be asked again next sweep. KEEP
        // the in-memory count: clearing it here would restart the whole retry cycle every cap, which is
        // exactly the unbounded re-POST spin the memory mirror exists to stop.
      }
      return "pending";
    }
    // The interrupt was just detected, so the corrective done's `at` is the OBSERVED now (epoch seconds).
    const doneNow = clock();
    const outcome = await post(await buildDoneEnvelope(sessionId, record, doneNow, config.e2eKey, agent, Math.floor(doneNow / 1000)));
    if (outcome === "revoked") return "revoked"; // pairing gone → bubble up so the loop can tear down
    if (outcome === "delivered") {
      // 2xx: pin the session done and CLEAR the retry counter so the gate skips it and the next hook re-arms.
      try { await writeRecord(path, { ...record, lastEvent: "done", sentDone: true, op: "done", doneAttempts: undefined }); } catch {
        // Rewrite failed — worst case the net re-POSTs a done next sweep, which the worker drops.
      }
      clearDoneAttempts(sessionId);
      return "corrected";
    }
    // Transient failure: persist the incremented attempt counter so the retry is BOUNDED and — because
    // doneAttempts > 0 — the heartbeat holds off (shouldHeartbeat) instead of re-raising needsAttention.
    noteDoneAttempt(sessionId, attempts + 1); // memory-backed bound: holds even if the write below fails
    try { await writeRecord(path, { ...record, doneAttempts: attempts + 1 }); } catch {
      // Counter write failed — next sweep re-detects the interrupt and retries from the same attempt.
    }
    return "pending";
  } catch {
    return "uncorrected";
  }
}

// --- Pending-user-action recovery net (dropped Codex blocking-hook backstop) ------------------
//
// On Codex, needsAttention comes from PermissionRequest for approvals and PreToolUse for the
// request_user_input choice UI. Codex has no upstream Notification event and is known to silently drop
// lifecycle hooks (openai/codex#16430); when either hook drops, the phone never learns the session is
// blocked. This net asks the session's adapter whether the rollout tail shows pending user action and,
// if so, POSTs the same needsAttention envelope as the direct hook path. See adapter.ts
// codexTailPendingApproval for the classifier and its rollout-persistence caveat.

/** Gate: should this sweep open the transcript to look for a pending approval on a still-ALIVE session?
 *  Only when the session's adapter offers the classifier (codex; claude yields false), the transcript
 *  is readable, and the session is NOT already in a state where a pending approval is meaningless or
 *  already-surfaced: skip when lastEvent is already `needsAttention` (dedup — fire ONCE per pending
 *  episode; the flip below closes the gate) and when the session is `done` (a finished session isn't
 *  awaiting approval). A fresh `sessionStart` or `working` session CAN block on its first/next tool, so
 *  those stay checkable. Pure so the whole matrix is unit-testable. */
export function shouldPendingApprovalCheck(record: SessionRecord, adapter: AgentAdapter): boolean {
  if (!adapter.tailShowsPendingApproval) return false; // agent has no classifier (claude) → never
  if (typeof record.transcript !== "string" || record.transcript.length === 0) return false;
  if (record.lastEvent === "needsAttention") return false; // already surfaced → dedup
  if (record.lastEvent === "done" || record.op === "done") return false; // finished → not awaiting approval
  return true;
}

/** Injectable side-effect seams for the pending-approval net, so its POST/restamp discipline is testable
 *  without real fs/network — mirrors InterruptDeps / IdleReapDeps. `now` clocks the corrective
 *  needsAttention envelope's ts + its `at`. */
export interface PendingApprovalDeps {
  post?: (body: object) => Promise<PostOutcome>;
  readTail?: (path: string, bytes: number) => Promise<string>;
  writeRecord?: (path: string, rec: SessionRecord) => Promise<void>;
  now?: () => number;
}

/** The pending-approval recovery net for one still-alive session. Gated by shouldPendingApprovalCheck,
 *  then it tails the rollout and, if the tail shows a pending approval, POSTs a corrective op:update /
 *  needsAttention (the same envelope a real PermissionRequest hook produces). On a 2xx it rewrites the
 *  session file with lastEvent:"needsAttention" so this net fires ONCE per pending episode (the gate now
 *  skips it) and the interrupt-recovery net picks the session up (shouldInterruptCheck keys on
 *  needsAttention, so an Esc/deny that follows still gets a corrective done). A non-2xx / network
 *  failure leaves the file untouched for the next sweep. SCOPE: this net only OPENS the blocked state —
 *  it deliberately does NOT synthesize a `working` update when the pending approval later resolves; the
 *  next real hook (or the notify `done` backstop) is what clears needsAttention. Returns:
 *   - "corrected"   → it POSTed a needsAttention this sweep → the caller must NOT also heartbeat it.
 *   - "uncorrected" → nothing to do (gate closed, no pending approval, or a transient failed POST).
 *   - "revoked"     → the POST 404'd: the pairing is gone server-side → the caller tears down. */
export async function correctPendingApproval(
  config: Config, path: string, sessionId: string, record: SessionRecord, now: number, deps: PendingApprovalDeps = {},
): Promise<"corrected" | "uncorrected" | "revoked"> {
  const post = deps.post ?? ((body: object) => postEvent(config, body));
  const readTail = deps.readTail ?? ((p: string, bytes: number) => readSuffix(p, bytes));
  const writeRecord = deps.writeRecord
    // Owner-only (0600), like the hook's trackSession / the interrupt net's rewrite — the record holds
    // hostname, cwd basename, the session pid, and the absolute transcript path.
    ?? ((p: string, rec: SessionRecord) => atomicWrite(p, JSON.stringify(rec), 0o600));
  const clock = deps.now ?? Date.now;
  try {
    const agent: AgentKind = record.agent === "codex" ? "codex" : "claude";
    const adapter = adapterFor(agent);
    if (!shouldPendingApprovalCheck(record, adapter)) return "uncorrected";
    let tail: string;
    try {
      tail = await readTail(record.transcript as string, INTERRUPT_TAIL_BYTES);
    } catch {
      return "uncorrected"; // transcript missing / cold-compressed → nothing to check
    }
    if (!adapter.tailShowsPendingApproval!(tail)) return "uncorrected"; // no pending approval → leave it
    const detail = adapter.tailPendingAttentionDetail?.(tail);
    const attentionKind = adapter.tailPendingAttentionKind?.(tail);
    // Just-detected block → `at` is the OBSERVED now (epoch seconds).
    const attnNow = clock();
    const envelope = await buildNeedsAttentionEnvelope(
      sessionId, record, attnNow, config.e2eKey, agent, Math.floor(attnNow / 1000), detail, attentionKind,
    ) as Record<string, unknown>;
    const outcome = await post(envelope);
    if (outcome === "revoked") return "revoked"; // pairing gone → bubble up so the loop can tear down
    if (outcome !== "delivered") return "uncorrected"; // failed POST → keep the file, retry next sweep
    // 2xx: pin the session needsAttention so this net fires once per episode and the interrupt-net
    // watches it. sentDone:false so a later re-arm behaves like a live session, not a re-armed done.
    try {
      const next: SessionRecord = {
        ...record,
        lastEvent: "needsAttention",
        op: "update",
        prio: 1,
        sentDone: false,
        // Heartbeats must repeat the corrective attention frame, not the stale pre-question working blob.
        ...(typeof envelope.blob === "string" ? { blob: envelope.blob } : {}),
        // Write the clear discriminator THROUGH to the record (append-last field, NOM-44 phase 3) so the
        // LAN frames feed labels this recovered episode exactly as the POSTed envelope does. Written
        // unconditionally — `undefined` DROPS the key on stringify (the doneAttempts-clear idiom), which
        // is what keeps a plain approval from inheriting a previous question's marker through the spread.
        attentionKind,
      };
      await writeRecord(path, next);
    } catch {
      // Rewrite failed — worst case the net re-POSTs a needsAttention next sweep, which the worker drops.
    }
    return "corrected";
  } catch {
    return "uncorrected";
  }
}

// --- Idle-provisional corrective (a discovery "working" row whose TUI went idle) --------------
//
// A provisional row is hook-less by definition — no Stop will EVER arrive for it — so one advertised
// as "working" while its TUI sits idle at the prompt stays "Running" on the phone indefinitely
// (user-confirmed live repro: an idle `codex` TUI open since 2 AM, its real session stolen by a
// ChatGPT-desktop resume, stuck Running all night as `codex-pid-91986`). Discovery now classifies at
// surface time (see buildProvisionalBlob), and THIS net keeps the verdict honest on later sweeps: a
// provisional still marked working whose TUI no longer has a turn in flight gets ONE corrective
// op:done (cached title — never title:"", the v0.8.3 rule) and its record pinned done so the net
// can't re-fire. Deliberately ONE-WAY (working → done, never back): when the idle TUI later gets a
// real prompt, the REAL hooks fire with the real session id and the reconcile machinery retires the
// provisional — a done→working flip here would race those hooks and resurrect the ghost.

/** Gate: should this sweep probe a still-ALIVE session's TUI for idleness? Only PROVISIONAL records
 *  (hook-fed sessions own their lifecycle — the interrupt/notify nets cover them) of an agent whose
 *  adapter offers the turn-state probe (codex; claude never), not already done (fire ONCE per
 *  provisional — the corrective's rewrite closes the gate), with a probeable pid. Pure. */
export function shouldIdleProvisionalCheck(record: SessionRecord, adapter: AgentAdapter): boolean {
  if (!adapter.pidTurnActive) return false; // agent has no turn-state probe (claude) → never
  if (record.provisional !== true) return false; // real sessions are the hooks'/other nets' business
  if (record.op === "done" || record.lastEvent === "done") return false; // already advertised idle
  if (typeof record.pid !== "number" || !Number.isFinite(record.pid)) return false;
  return true;
}

/** The idle-provisional corrective for one still-alive session. Gated by shouldIdleProvisionalCheck,
 *  then it probes the TUI's rollout tail (adapter.pidTurnActive): a turn genuinely in flight leaves the
 *  working row alone; an idle TUI gets a corrective op:done rebuilt from the record's cached
 *  title/machine/label (buildDoneEnvelope — same envelope the interrupt net posts). On a 2xx the record
 *  is pinned done (lastEvent/op done + sentDone) so this fires once and the heartbeat/interrupt nets
 *  treat it as finished. A transient failure leaves the file untouched for the next sweep. Returns the
 *  same verdict triple as the other nets ("corrected" → the caller must not also heartbeat it). */
async function correctIdleProvisional(config: Config, path: string, sessionId: string, record: SessionRecord): Promise<"corrected" | "uncorrected" | "revoked"> {
  try {
    const agent: AgentKind = record.agent === "codex" ? "codex" : "claude";
    const adapter = adapterFor(agent);
    if (!shouldIdleProvisionalCheck(record, adapter)) return "uncorrected";
    let active = false;
    try { active = await adapter.pidTurnActive!(record.pid); } catch { /* idle-biased, like discovery */ }
    if (active) return "uncorrected"; // a turn is open → the working row is honest → leave it
    // TUI just went idle → the done's `at` is the OBSERVED now (epoch seconds).
    const idleNow = Date.now();
    const outcome = await postEvent(config, await buildDoneEnvelope(sessionId, record, idleNow, config.e2eKey, agent, Math.floor(idleNow / 1000)));
    if (outcome === "revoked") return "revoked"; // pairing gone → bubble up so the loop can tear down
    if (outcome !== "delivered") return "uncorrected"; // failed POST → keep the file, retry next sweep
    // 2xx: pin the provisional done so the gate closes and the heartbeat can never re-arm "working".
    try {
      const next: SessionRecord = { ...record, lastEvent: "done", sentDone: true, op: "done" };
      // Owner-only (0600), same as every other record rewrite in this file.
      await atomicWrite(path, JSON.stringify(next), 0o600);
    } catch {
      // Rewrite failed — worst case the net re-POSTs a done next sweep, which the worker drops.
    }
    return "corrected";
  } catch {
    return "uncorrected";
  }
}

// --- Idle-session reap (a resumed session left alive-but-silent, no Stop ever coming) ----------
//
// Claude Desktop resumes an old session with `claude --resume <id> --replay-user-messages` and keeps the
// process RESIDENT while idle: its SessionStart fires (re-arming the session to "working"), no turn
// follows, and NO Stop ever comes. The dead-pid reaper can't help — the pid is alive — and the PID-gated
// heartbeat below deliberately defeats the worker's one-hour eviction, so the phone would show that session
// "working" FOREVER. This net closes the gap from the one side that knows the turn is over: event-silence.
// When a tracked CLAUDE session has gone event-idle past a generous grace with its pid still alive, it
// gets ONE corrective op:done (the SAME envelope the interrupt net posts) and its record is pinned done —
// re-arming on the session's next real hook exactly like the interrupt net's done.
//
// This covers the resumed-but-never-prompted case verbatim: `claude --resume` (Claude Desktop, or a
// cmux/tmux resume) fires SessionStart — record.lastEvent:"sessionStart" — then zero turns, so record.ts is
// pinned at the resume and nothing ever advances it (heartbeats never rewrite ts). isClaudeIdleReapEligible
// keys on BOTH "working" and "sessionStart", so 30 min after the resume this net reaps it. CRITICALLY the
// reap's done blob freezes `at` at record.ts (the real resume time, hours old) rather than "now", so the
// phone ages the row out instead of showing a freshly-finished session forever (live repro 2026-07-19: a
// cmux-resumed session sat "working/fresh" 7+ h — the worker's lastEventAt only ever saw heartbeat POSTs,
// never a real event, so without a frozen blob `at` the row could never age). IDLE-biased, like the
// codex-side defaults documented in adapter.ts: reaping a session that turns out still-live merely costs
// one frame — its next real hook re-arms it to working — whereas never reaping sticks forever.

/** How long a CLAUDE session may sit event-idle (no REAL hook since record.ts — a heartbeat never rewrites
 *  it) while its pid is alive before the watchdog reaps it with a corrective done. 30 min sits FAR above
 *  any legitimate mid-turn hook gap: tool hooks fire constantly during real work and even a single long
 *  Bash maxes ~10 min, so a 30-min silence means the turn is genuinely over (a resumed-but-idle session,
 *  or a long-finished one whose Stop was dropped). Deliberately ≫ HEARTBEAT_AFTER_MS (5 min): the 5–30 min
 *  window is still heartbeated "working" (a legitimate long tool run / subagent / permission wait), and
 *  only past 30 min does the reap take over. */
const CLAUDE_IDLE_REAP_MS = 1_800_000; // 30 min

/** Bound on the idle-reap's corrective-done RETRIES — the SAME discipline the interrupt net enforces
 *  (INTERRUPT_DONE_MAX_ATTEMPTS). Once a session is reap-DECIDED (idle past the grace) the only question is
 *  delivery: a delivered done settles it; a FAILED done bumps record.doneAttempts and retries next sweep.
 *  After this many consecutive FAILED deliveries the pairing is unreachable for this event, so the reap
 *  stops the every-5-s re-POST loop and pins the record done LOCALLY — advancing it to the terminal state
 *  the RETIRE net keys on (isRetireEligible needs op/lastEvent "done"), so a resumed-idle session whose reap
 *  can't reach the worker still frees its cap slot + retires (record deleted, even OFFLINE) instead of
 *  re-POSTing a doomed done forever with the record frozen at "sessionStart" and RETIRE never firing. 5
 *  sweeps ≈ 25 s absorbs a transient blip without looping — same bound/rationale as INTERRUPT_DONE_MAX_ATTEMPTS. */
const CLAUDE_IDLE_REAP_MAX_ATTEMPTS = 5;

/** Whether a KEPT (alive) session is an idle CLAUDE session past the reap threshold — the shared predicate
 *  the reap net and the heartbeat guard BOTH key on, so the two always agree (a session the reaper wants to
 *  finish is never simultaneously heartbeated back to "working"). True iff: it's a Claude session (codex has
 *  its own discovery / idle-provisional + notify-backstop machinery, so it's left to those), not a
 *  provisional discovery row, its last REAL event was a plain `working` update or a bare `sessionStart` (a
 *  resumed session that fired SessionStart then nothing — never `needsAttention`, which can legitimately sit
 *  >30 min awaiting a permission answer, nor `done`, already finished), and record.ts is older than
 *  CLAUDE_IDLE_REAP_MS. Pure so the whole matrix is unit-testable. */
/** Default transcript-mtime reader for the reap guard: epoch-ms mtime, undefined on any error. */
function transcriptMtimeMsDefault(path: string): number | undefined {
  try { return statSync(path).mtimeMs; } catch { return undefined; }
}

export function isClaudeIdleReapEligible(
  record: SessionRecord, now: number,
  transcriptMtimeMs: (path: string) => number | undefined = transcriptMtimeMsDefault,
): boolean {
  if (record.agent === "codex") return false;
  if (record.provisional === true) return false;
  return idleReapAgeEligible(record, now, transcriptMtimeMs);
}

/** Shared clock/transcript half of idle reaping. Agent ownership stays outside: Claude's process is
 * authoritative directly; Codex must first correlate a real TUI and prove the exact rollout idle. */
function idleReapAgeEligible(
  record: SessionRecord, now: number,
  transcriptMtimeMs: (path: string) => number | undefined = transcriptMtimeMsDefault,
): boolean {
  if (record.lastEvent !== "working" && record.lastEvent !== "sessionStart") return false;
  if (typeof record.ts !== "number") return false;
  if (now - record.ts < CLAUDE_IDLE_REAP_MS) return false;
  // Transcript-liveness veto: record.ts only advances on real hooks, but CC streams the turn into the
  // session JSONL continuously — a transcript written within the reap window means the turn is alive
  // (long tool run / subagent fan-out), so reaping it "done" would be a lie. Any stat failure falls
  // back to the pre-guard behavior (eligible): the guard can only reduce false reaps, never add them.
  if (typeof record.transcript === "string" && record.transcript.length > 0) {
    try {
      const m = transcriptMtimeMs(record.transcript);
      if (typeof m === "number" && Number.isFinite(m) && now - m < CLAUDE_IDLE_REAP_MS) return false;
    } catch { /* eligible — same as before the guard */ }
  }
  return true;
}

/** Injectable side-effect seams for the idle-session reap, so its settle/retry logic is testable without
 *  real fs/network — mirrors InterruptDeps. Codex's extra seams enforce its TUI + exact-rollout proof. */
export interface IdleReapDeps {
  post?: (body: object) => Promise<PostOutcome>;
  writeRecord?: (path: string, rec: SessionRecord) => Promise<void>;
  locateTuiPid?: (sessionId: string, record: SessionRecord) => Promise<number | undefined>;
  pidAlive?: (pid: number) => boolean;
  codexTurnActive?: (pid: number, transcriptPath: string) => Promise<boolean>;
  now?: () => number;
}

/** The idle reap for one still-alive session. Claude retains isClaudeIdleReapEligible's historical
 *  event/transcript clock. Codex additionally requires a correlated live TUI and a readable exact rollout
 *  proving the turn is idle. Once gated — exactly like the interrupt net (correctInterrupt) — the session
 *  is DECIDED done and the only remaining question is
 *  delivery. It POSTs a corrective op:done (buildDoneEnvelope, the SAME envelope the interrupt net posts,
 *  with `at` FROZEN at record.ts so an hours-idle resumed session ages out rather than looking freshly
 *  finished) and settles the record so the reap can neither re-fire forever nor let the heartbeat re-raise
 *  "working":
 *   - delivered → pin lastEvent:"done" + sentDone + op:"done" (and CLEAR doneAttempts) so the gate closes,
 *                 the heartbeat gates off, and the next hook re-arms from a done.
 *   - failed    → BOUNDED retry: bump record.doneAttempts and keep the record for next sweep (doneAttempts>0
 *                 also holds the heartbeat off — shouldHeartbeat). Past CLAUDE_IDLE_REAP_MAX_ATTEMPTS the
 *                 pairing is unreachable for THIS event, so it stops POSTing and pins the record done
 *                 LOCALLY — advancing it to the terminal state RETIRE keys on (isRetireEligible), so the
 *                 slot frees + the row retires even OFFLINE instead of re-POSTing a doomed done forever with
 *                 the record stuck at "sessionStart" (the live-observed failure mode). The worker's own
 *                 eviction resolves the phone. A resumed-but-idle session (SessionStart then silence) whose
 *                 reap can't reach the worker now falls all the way through reap → retire on its own.
 *  On the next real hook the pinned sentDone re-arms the session to working, just like the interrupt
 *  net's done. Returns:
 *   - "corrected"   → it delivered a done this sweep (2xx) → the caller counts it delivered and must NOT
 *                     also heartbeat the session.
 *   - "pending"     → reap-decided but the done did NOT deliver (bounded-retrying, or the cap was hit and the
 *                     record was pinned done locally): NOT delivered, but the caller must still skip the
 *                     heartbeat (the reap owns this session this sweep).
 *   - "uncorrected" → not eligible.
 *   - "revoked"     → the POST 404'd: the pairing is gone server-side → the caller tears down. */
export async function correctIdleClaude(
  config: Config, path: string, sessionId: string, record: SessionRecord, now: number, deps: IdleReapDeps = {},
): Promise<"corrected" | "pending" | "uncorrected" | "revoked"> {
  const post = deps.post ?? ((body: object) => postEvent(config, body));
  const writeRecord = deps.writeRecord
    // Owner-only (0600), same as the hook's trackSession / the interrupt net's rewrite.
    ?? ((p: string, rec: SessionRecord) => atomicWrite(p, JSON.stringify(rec), 0o600));
  const clock = deps.now ?? Date.now;
  try {
    const agent: AgentKind = record.agent === "codex" ? "codex" : "claude";
    if (agent === "codex") {
      // Sound Codex equivalent: clock silence alone is insufficient because record.pid may be the
      // immortal app-server and a legitimate long turn can be hook-quiet. Require all three pieces:
      // age + stale rollout mtime, an exact rollout path, and a conservatively correlated LIVE TUI
      // whose exact rollout says no turn is active. Any missing/throwing evidence fails open to tracking.
      if (record.provisional === true || !idleReapAgeEligible(record, now) ||
          typeof record.transcript !== "string" || record.transcript.length === 0) return "uncorrected";
      let tuiPid = typeof record.tuiPid === "number" && Number.isFinite(record.tuiPid)
        ? record.tuiPid : undefined;
      if (tuiPid === undefined) {
        const locate = deps.locateTuiPid ?? locateCodexOwnedTui;
        try { tuiPid = await locate(sessionId, record); } catch { return "uncorrected"; }
      }
      if (typeof tuiPid !== "number" || !Number.isFinite(tuiPid) || !(deps.pidAlive ?? pidAlive)(tuiPid)) {
        return "uncorrected";
      }
      const transcript = record.transcript;
      const active = deps.codexTurnActive
        ?? (async (_pid: number, path: string) => {
          // Stricter than discovery's deliberately idle-biased probe: retirement may not translate an
          // unreadable rollout into "idle". Read the exact hook-owned path here and let either IO/stat
          // failure throw into the fail-open catch below.
          const tail = await readSuffix(path, 8 * 1024);
          return codexTurnActiveFromTail(tail, Date.now() - statSync(path).mtimeMs);
        });
      try {
        if (await active(tuiPid, transcript)) return "uncorrected";
      } catch {
        return "uncorrected";
      }
      record = { ...record, tuiPid };
    } else if (!isClaudeIdleReapEligible(record, now)) {
      return "uncorrected";
    }
    // Bounded against disk AND memory (see effectiveDoneAttempts) — a persistently-failing record write
    // must not reset the reap's retry budget to zero on every sweep.
    const attempts = effectiveDoneAttempts(record, sessionId);
    // Retry exhausted: stop the every-sweep re-POST and pin done LOCALLY so the record reaches the terminal
    // state RETIRE keys on — the resumed-idle session then retires (record deleted, slot freed) even with the
    // worker unreachable, instead of spinning a doomed done forever. "pending": reap handled, not delivered.
    if (attempts >= CLAUDE_IDLE_REAP_MAX_ATTEMPTS) {
      try {
        await writeRecord(path, { ...record, lastEvent: "done", sentDone: true, op: "done", doneAttempts: undefined });
        clearDoneAttempts(sessionId); // pinned done ON DISK → the gate closes; the bound has done its job
      } catch {
        // Pin didn't land → keep the in-memory count, or the cap would restart the retry cycle forever
        // (see the identical note in correctInterrupt).
      }
      return "pending";
    }
    // The corrective carries the record's agent shape. Codex reaches here only after the stricter
    // TUI+rollout proof above; Claude keeps its historical clock/transcript behavior.
    // The done blob's `at` is FROZEN at the record's last REAL event (record.ts, epoch seconds) — NOT
    // now: this session has been idle for hours (a resumed-but-never-prompted TUI, or a long-finished
    // one whose Stop dropped), so stamping "now" would make the phone show a freshly-finished row that
    // never ages out — the very "eternally fresh" bug this reap exists to kill. record.ts is guaranteed
    // a finite number by isClaudeIdleReapEligible. (envelope `ts` stays now so the worker accepts the frame.)
    const doneNow = clock();
    const outcome = await post(await buildDoneEnvelope(sessionId, record, doneNow, config.e2eKey, agent, Math.floor(record.ts / 1000)));
    if (outcome === "revoked") return "revoked"; // pairing gone → bubble up so the loop can tear down
    if (outcome === "delivered") {
      // 2xx: pin the session done and CLEAR the retry counter so the gate closes, the heartbeat can never
      // re-arm "working", and the next real hook re-arms from a done exactly as the interrupt net's rewrite does.
      try { await writeRecord(path, { ...record, lastEvent: "done", sentDone: true, op: "done", doneAttempts: undefined }); } catch {
        // Rewrite failed — worst case the net re-POSTs a done next sweep, which the worker drops.
      }
      clearDoneAttempts(sessionId);
      return "corrected";
    }
    // Transient failure: persist the incremented attempt counter so the retry is BOUNDED and — because
    // doneAttempts > 0 — the heartbeat holds off (shouldHeartbeat), exactly like the interrupt net.
    noteDoneAttempt(sessionId, attempts + 1); // memory-backed bound: holds even if the write below fails
    try { await writeRecord(path, { ...record, doneAttempts: attempts + 1 }); } catch {
      // Counter write failed — next sweep re-detects idle and retries from the same attempt.
    }
    return "pending";
  } catch {
    return "uncorrected";
  }
}

// --- Undelivered-done reconcile (the Stop landed on disk but never on the worker) --------------
//
// The hook writes the session record BEFORE it POSTs (a force-killed terminal must still leave a
// reapable file), and the whole hook body is wrapped in a blanket catch — so a Stop whose POST came
// back non-2xx, hit the 2 s AbortSignal timeout, or threw left `sentDone:true` on disk while the worker
// still held the previous op:"update". Nothing repaired that, and it is uniquely un-self-healing:
// EVERY other net in this file gates itself OFF on a done record (shouldPendingApprovalCheck,
// shouldIdleProvisionalCheck, isClaudeIdleReapEligible, shouldHeartbeat), so the local "done" belief
// silenced the very machinery that would have noticed. Live incident 2026-07-26: a session's local
// record read sentDone/op "done" at 05:59:13 while the worker's KV row still read op:"update" from
// 05:58:36 — the phone showed it running for ~13 h, and a hand-replayed done envelope cleared it
// instantly. The hook now stamps `donePending` pessimistically and clears it only on a confirmed 2xx
// (see hook.ts markDoneDelivered), leaving this net one job: settle whatever debt is still on disk.
//
// SCOPE — done ONLY. An op:"end" DELETES the record (trackSession), so a failed end has no local retry
// handle at all; the dead-pid reap, the 24 h stale path, and the worker's own eviction remain its
// backstops. Agent-agnostic: the debt is created identically by the Claude hook, the Codex hook, and
// the codex-notify backstop, and buildDoneEnvelope restamps the record's agent either way.

/** Bound on the undelivered-done re-POST — the SAME discipline as INTERRUPT_DONE_MAX_ATTEMPTS /
 *  CLAUDE_IDLE_REAP_MAX_ATTEMPTS, sharing their `doneAttempts` counter (the three nets can never own the
 *  same record at once: this one requires a done state, the other two exclude it). 5 sweeps ≈ 25 s
 *  absorbs the transient blip that caused the miss in the first place; past that the pairing is
 *  unreachable for this event, so the debt is dropped and the record pinned settled rather than
 *  re-POSTing a doomed done every 5 s forever. */
const PENDING_DONE_MAX_ATTEMPTS = 5;

/** Gate: does this record owe the worker a done? Only the pessimistic marker matters — the record is
 *  already in its terminal done state, so there is no status to re-derive and nothing to disambiguate
 *  from a transcript. Provisional discovery rows are excluded: their op:done is POSTed by discovery
 *  BEFORE the record is written (delivered gates the write), so they never carry the marker, and
 *  re-POSTing for one would fight the reconcile machinery. Pure. */
export function shouldPendingDoneCheck(record: SessionRecord): boolean {
  if (record.donePending !== true) return false;
  if (record.provisional === true) return false;
  return true;
}

/** Injectable seams for the undelivered-done net, mirroring IdleReapDeps. `now` clocks the re-POSTed
 *  envelope's ts (its blob `at` stays FROZEN at the record's real done time — see below). */
export interface PendingDoneDeps {
  post?: (body: object) => Promise<PostOutcome>;
  writeRecord?: (path: string, rec: SessionRecord) => Promise<void>;
  /** Re-reads the record from disk immediately before a write, so a hook that landed DURING the POST is
   *  never clobbered back to the pre-POST snapshot (see pendingDoneSettleWrite). Defaults to a real read;
   *  null (absent/unreadable) falls back to the pre-guard snapshot write. */
  readRecord?: (path: string) => Promise<SessionRecord | null>;
  now?: () => number;
}

/** The undelivered-done reconcile for one tracked session. Gated by shouldPendingDoneCheck; the session
 *  is already DECIDED done (a real Stop hook produced it), so the only question — as in correctInterrupt
 *  and correctIdleClaude — is delivery:
 *   - delivered → clear `donePending` (and `doneAttempts`) and pin the record settled done, so the gate
 *                 closes and the next real hook re-arms from a done exactly as before.
 *   - failed    → BOUNDED retry: bump doneAttempts, keep the marker, retry next sweep.
 *   - capped    → stop POSTing and clear the marker anyway, pinning the record settled: an unreachable
 *                 worker must not leave this spinning, and a cleared marker also un-blocks the retire
 *                 net (isRetireEligible) so the row still resolves offline. The worker's own eviction is
 *                 the phone's backstop, exactly as at the other two nets' caps.
 *  The re-POSTed blob's `at` is FROZEN at record.ts (the real event time, epoch seconds) — the done
 *  happened when the Stop hook fired, possibly many sweeps ago, so stamping "now" would make the phone
 *  show a freshly-finished row that never ages out (the same rule the idle reap follows).
 *  Returns the interrupt net's verdict quadruple: "corrected" (delivered a done this sweep) /
 *  "pending" (owns the session, nothing delivered) / "uncorrected" (no debt) / "revoked". */
export async function correctPendingDone(
  config: Config, path: string, sessionId: string, record: SessionRecord, now: number, deps: PendingDoneDeps = {},
): Promise<"corrected" | "pending" | "uncorrected" | "revoked"> {
  const post = deps.post ?? ((body: object) => postEvent(config, body));
  const writeRecord = deps.writeRecord
    // Owner-only (0600), same as the hook's trackSession / every other record rewrite in this file.
    ?? ((p: string, rec: SessionRecord) => atomicWrite(p, JSON.stringify(rec), 0o600));
  const reread = deps.readRecord ?? readRecordAt;
  // Never throws: an unreadable/absent record reads as null, which the guards treat as "no evidence"
  // and fall back to the pre-guard snapshot write.
  const freshRecord = async (): Promise<SessionRecord | null> => {
    try { return await reread(path); } catch { return null; }
  };
  const clock = deps.now ?? Date.now;
  try {
    if (!shouldPendingDoneCheck(record)) return "uncorrected";
    const agent: AgentKind = record.agent === "codex" ? "codex" : "claude";
    // The settled record: the debt dropped and the terminal done state pinned (the hook already wrote
    // these, but a watchdog rewrite between then and now could have moved them — pin explicitly). It is
    // only ever written after the stale-snapshot guard proves the record hasn't moved under us.
    const settled: SessionRecord = {
      ...record, lastEvent: "done", sentDone: true, op: "done", donePending: undefined, doneAttempts: undefined,
    };
    // Bound against disk AND memory, so a record rewrite that never lands can't unbound the retry.
    const attempts = effectiveDoneAttempts(record, sessionId);
    if (attempts >= PENDING_DONE_MAX_ATTEMPTS) {
      const write = pendingDoneSettleWrite(record, await freshRecord(), settled);
      if (!write) {
        clearDoneAttempts(sessionId); // the record moved on (a live session owns it now) → stop counting
        return "pending";
      }
      try {
        await writeRecord(path, write);
        clearDoneAttempts(sessionId); // the debt is dropped ON DISK → the gate closes
      } catch {
        // Settle didn't land → keep the in-memory count so the cap holds (see correctInterrupt's note).
      }
      return "pending";
    }
    // record.ts is the Stop's own write time; a corrupt record with no numeric ts simply omits `at`
    // (the phone then falls back to its own receipt time, as it does for every pre-`at` frame).
    const at = typeof record.ts === "number" && Number.isFinite(record.ts) ? Math.floor(record.ts / 1000) : undefined;
    const outcome = await post(await buildDoneEnvelope(sessionId, record, clock(), config.e2eKey, agent, at));
    if (outcome === "revoked") return "revoked"; // pairing gone → bubble up so the loop can tear down
    if (outcome === "delivered") {
      // RE-READ before writing: the POST above took up to 2 s, and a user prompt landing in that window
      // already flipped this record to `working`. Stamping the pre-POST snapshot back would resurrect
      // `done` on a live session and silence every net that gates off a done record (see
      // pendingDoneSettleWrite for the full matrix).
      const write = pendingDoneSettleWrite(record, await freshRecord(), settled);
      if (write) {
        try { await writeRecord(path, write); } catch {
          // Rewrite failed — worst case we re-POST the same done next sweep, which the worker drops.
        }
      }
      clearDoneAttempts(sessionId);
      return "corrected";
    }
    const retry = pendingDoneRetryWrite(record, await freshRecord(), attempts + 1);
    noteDoneAttempt(sessionId, attempts + 1); // memory-backed bound: holds even if the write below fails
    if (retry) {
      try { await writeRecord(path, retry); } catch {
        // Counter write failed — next sweep retries from the same attempt (still bounded by the cap).
      }
    }
    return "pending";
  } catch {
    return "uncorrected";
  }
}

// --- Idle-done retire (free the worker cap slot a long-idle done row still occupies) -----------
//
// v1.1.6 froze the reap's blob `at` so a resumed-but-idle session AGES OUT of the phone's
// display — but that is only a phone-side VISUAL filter. The worker session row the reap left behind
// (an op:done) still counts against the per-pairing session cap (maxSessionsPerPairing): enough
// idle-open TUIs and NEW sessions can no longer appear. The frozen `at` never freed that slot. This
// net closes the last gap: a session that is genuinely DONE (the idle-reaped done, or a normal
// Stop) whose last REAL event is over an hour old — pid still alive, so the dead-pid reaper never
// touches it — is RETIRED: a blob-less op:end (the worker DELETES the row, unlike a passively-evicting
// op:done) carrying the FROZEN real-last-event `at`. Claude and headless Codex records are deleted;
// an interactive Codex TUI leaves a blob-less local owner marker so discovery cannot recreate it.
// Either way the cap slot is freed and the row is gone from the phone.
//
// Revival is intact by construction: trackSession rebuilds a record whole on the next genuine hook,
// dropping any owner marker and recreating the worker row. Retirement is never a one-way door. Working /
// needsAttention are NEVER retired merely for age (a silent 2-h build,
// an unanswered permission prompt): isRetireEligible requires a terminal done state, so those keep
// heartbeating exactly as before.

/** How long a DONE session may sit event-idle (its last REAL event = record.ts — a heartbeat never
 *  rewrites it) before the watchdog retires it with a blob-less op:end. WHY 1 h: it matches the phone's
 *  own display-age filter (the frozen blob `at` ages a done row
 *  out of view at ~the same horizon), and it sits FAR above both HEARTBEAT_AFTER_MS (5 min) and the
 *  worker's one-hour eviction — so retirement is always a DELIBERATE, settled decision, never racing a
 *  session the hooks are still keeping fresh nor one the worker is about to evict anyway. Deliberately
 *  well below SESSION_STALE_MS (24 h): retirement fires FIRST for done rows, and the 24 h stale cap stays
 *  the backstop for NON-done sessions (e.g. a needsAttention prompt abandoned for a full day). */
const RETIRE_AFTER_MS = 3_600_000; // 1 h

/** Whether a KEPT session is DONE past the retire horizon — the predicate the retire net keys on. True
 *  iff it is a real session or Codex provisional (never a non-Codex provisional / existing owner marker),
 *  is in a terminal done state (op:"done" OR lastEvent:"done" — exactly what the
 *  v1.1.6 idle-reap writes back and what a normal Stop leaves; NEVER working/needsAttention, so a silent
 *  build or an unanswered permission prompt keeps heartbeating), and its last REAL event (record.ts) is
 *  older than RETIRE_AFTER_MS. A record with no numeric ts can't be aged → not retired (classifySession
 *  deletes it via the un-ageable path instead). Pure so the whole matrix is unit-testable. */
export function isRetireEligible(record: SessionRecord, now: number): boolean {
  if (typeof record.retiredAt === "number" && Number.isFinite(record.retiredAt)) return false;
  // Codex provisionals are real visible done rows too. Retirement converts them into an owner marker,
  // which is precisely what prevents discoverLive from recreating them while the idle TUI stays open.
  if (record.provisional === true && record.agent !== "codex") return false;
  if (record.op !== "done" && record.lastEvent !== "done") return false;
  if (typeof record.ts !== "number") return false;
  return now - record.ts >= RETIRE_AFTER_MS;
}

/** Injectable seams for the retire net, so its end-POST + delete/marker write is testable. */
export interface RetireDeps {
  post?: (body: object) => Promise<PostOutcome>;
  deleteRecord?: (path: string) => Promise<void>;
  writeRecord?: (path: string, rec: SessionRecord) => Promise<void>;
  /** Conservative real-TUI locator. Undefined means no discoverable interactive owner, so deletion
   *  cannot start a discovery loop (the common headless/app-server one-shot case). */
  locateTuiPid?: (sessionId: string, record: SessionRecord) => Promise<number | undefined>;
  pidAlive?: (pid: number) => boolean;
  /** Re-reads the record from disk immediately before the end-POST and again before the DELETE, so a
   *  session the user just woke up (a prompt landing mid-sweep) is never retired out from under its own
   *  hooks. Defaults to a real read; null (absent/unreadable) keeps the pre-guard behavior. */
  readRecord?: (path: string) => Promise<SessionRecord | null>;
}

/** The idle-done retire net for one kept session. Gated by isRetireEligible, then it POSTs a
 *  best-effort blob-less op:end carrying the FROZEN real-last-event `at` (record.ts/1000 — so the worker
 *  ages any surfaced end frame by real activity, consistent with 5aa1214). It deletes the local record
 *  unless a live Codex TUI would be rediscovered, in which case it writes an invisible owner marker.
 *  Local retirement is unconditional on delivered vs transient failure; worker eviction backstops a
 *  dropped end. Returns:
 *   - "retired"         → the op:end 2xx'd; record deleted/marked → pairing alive.
 *   - "retired-offline" → the op:end failed; record deleted/marked anyway → NOT delivered.
 *   - "skip"            → not eligible (leave it for the other nets / the heartbeat).
 *   - "revoked"         → the POST 404'd: the pairing is gone server-side → the caller tears down (the
 *                         record is LEFT in place, mirroring the stale path's revoke bail). */
export async function retireDoneStale(
  config: Config, path: string, sessionId: string, record: SessionRecord, now: number, deps: RetireDeps = {},
): Promise<"retired" | "retired-offline" | "skip" | "revoked"> {
  const post = deps.post ?? ((body: object) => postEvent(config, body));
  const deleteRecord = deps.deleteRecord ?? ((p: string) => unlink(p).catch(() => {}));
  const writeRecord = deps.writeRecord
    ?? ((p: string, rec: SessionRecord) => atomicWrite(p, JSON.stringify(rec), 0o600));
  const alive = deps.pidAlive ?? pidAlive;
  const locateTuiPid = deps.locateTuiPid ?? locateCodexOwnedTui;
  const reread = deps.readRecord ?? readRecordAt;
  const freshRecord = async (): Promise<SessionRecord | null> => {
    try { return await reread(path); } catch { return null; }
  };
  try {
    if (!isRetireEligible(record, now)) return "skip";
    let tuiPid: number | undefined;
    if (record.agent === "codex") {
      const cached = typeof record.tuiPid === "number" && Number.isFinite(record.tuiPid)
        ? record.tuiPid : undefined;
      if (cached !== undefined && alive(cached)) tuiPid = cached;
      if (tuiPid === undefined) {
        try {
          const located = await locateTuiPid(sessionId, record);
          if (typeof located === "number" && Number.isFinite(located) && alive(located)) tuiPid = located;
        } catch { /* no trustworthy interactive owner → ordinary delete */ }
      }
    }
    // STALE-SNAPSHOT GUARD (before the POST): `record` is the snapshot the sweep read at the top of this
    // iteration, and the correctives ahead of us already awaited POSTs. If a real hook landed since — the
    // user woke this session up — the row is no longer a settled 1-h-old done, and both the op:end and the
    // record delete would be a lie (deleting the record also orphans the live session: no reap file, no
    // heartbeat). A null re-read (absent/unreadable) keeps the pre-guard behavior.
    const before = await freshRecord();
    if (before && (recordMovedSince(record, before) || !isRetireEligible(before, now))) return "skip";
    // record.ts is guaranteed a number by isRetireEligible → floor it into epoch seconds for the frozen `at`.
    const outcome = await post(buildEndEnvelope(sessionId, now, record, Math.floor(record.ts / 1000)));
    if (outcome === "revoked") return "revoked"; // pairing gone → bubble up; leave the record for teardown
    // …and again immediately before the DELETE: the POST above took up to 2 s, which is plenty for a
    // prompt to land. The end frame we just sent is superseded by that hook's own frame; the RECORD must
    // survive so the woken session keeps its reap/heartbeat handle.
    const after = await freshRecord();
    if (after && recordMovedSince(record, after)) return "skip";
    heartbeatAt.delete(sessionId); // dropping the row → drop its heartbeat-throttle entry (like the sweep's delete)
    clearDoneAttempts(sessionId);
    if (record.agent === "codex" && tuiPid !== undefined) {
      // Durable recreation-loop break: the minimal marker stays in the same known-record set discovery
      // already consults, but has no blob/op/full text so neither worker nor LAN can serve it. A genuine
      // hook rewrites this file whole and revives the session; TUI death makes classifySession delete it.
      await writeRecord(path, {
        pid: tuiPid,
        machine: record.machine,
        label: record.label,
        ts: record.ts,
        agent: "codex",
        tuiPid,
        retiredAt: now,
      });
    } else {
      await deleteRecord(path);
    }
    return outcome === "delivered" ? "retired" : "retired-offline";
  } catch {
    return "skip";
  }
}

// --- Codex title-repair (heal a permanent blank title from a dropped post-SessionStart hook) --
//
// Codex dispatches SessionStart BEFORE the first prompt is recorded to the rollout, and that hook's
// payload carries no prompt — so all three of codexAdapter.title()'s sources (session_index thread_name,
// rollout user_message scan, input.prompt) are empty at SessionStart and the blob ships title:"". Normally
// the next UserPromptSubmit hook corrects it, but Codex silently drops lifecycle hooks (openai/codex#16430),
// so the blank title can become PERMANENT. This net re-runs the codex title resolution on each sweep — by
// sweep time the session_index thread_name is written (~30-40s) and the user_message line is flushed to the
// rollout — and, once a title resolves, caches it on the record and POSTs a corrective blob carrying the
// SAME op/status with only the title fixed. Idempotent: a record that already holds a non-empty title is
// skipped, so this fires at most until the first title lands.

/** How much of the codex rollout HEAD the title-repair fallback scans (the first user_message rides the
 *  opening lines). Matches the hook's TITLE_SCAN_BYTES. */
const TITLE_REPAIR_HEAD_BYTES = 128 * 1024;

/** The semantic status a rebuilt blob should carry for `record` (mirrors hook.ts planOp: a fresh
 *  `sessionStart` shows "working"; otherwise the stored status kind is the lastEvent string). */
function statusFromRecord(record: SessionRecord): CCStatus {
  if (record.lastEvent === "needsAttention") return "needsAttention";
  if (record.lastEvent === "done") return "done";
  return "working"; // "working" or a fresh "sessionStart"
}

/** The title-repair corrective envelope: re-POST the session's CURRENT state (op/prio/status unchanged)
 *  with a freshly-resolved title, rebuilding the encrypted blob from the record's cached machine/label/
 *  model/turn anchor. Used to heal a codex session that shipped title:"" from a SessionStart before the
 *  session_index thread_name existed and then had every later hook dropped. Loses only the transient tool
 *  `detail` sub-status (never cached on the record) — restored by the next real hook. */
export async function buildTitleRepairEnvelope(
  sessionId: string, record: SessionRecord, title: string, now: number, e2eKey: Uint8Array, agent: AgentKind = "codex", at?: number,
): Promise<{ v: 2; sessionId: string; op: CCOp; prio: 0 | 1; ts: number; blob: string; startedAt?: number }> {
  const base = {
    status: statusFromRecord(record),
    title,
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    ...adapterFor(agent).blobAgentFields,
    ...(typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {}),
    ...(typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {}),
    // `at` (epoch SECONDS) appended LAST — the OBSERVED now: this re-POSTs the session's CURRENT state
    // (a fresh frame with the title fixed), so the phone should treat it as live. Omitted when absent.
    ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
  };
  const dbg = appendCodexBridgeMarker(agent === "codex" ? record.dbg ?? formatPlanPickerDebug({
    event: "title", classifier: statusFromRecord(record), marker: record.pendingPlanPicker ? "p" : record.planPickerVerificationPending ? "v" : record.planPickerSettled ? "s" : "0", by: "wd",
  }) : undefined, codexBridgeIsDown());
  const blob = await encryptBlob(e2eKey, appendFittedPlanAndDebug(base, undefined, dbg));
  return { v: 2, sessionId, op: record.op ?? "update", prio: record.prio ?? 0, ts: now, blob, ...startedAtField(record) };
}

/** Gate: should this sweep try to repair a still-tracked session's blank title? Only CODEX sessions (Claude
 *  names its session from the transcript on the very first hook, so a claude blank is a transient read-miss
 *  the next hook fixes, not the structural SessionStart gap), not a provisional discovery row (those carry a
 *  cwd-basename title), whose record holds no non-empty title yet. Pure. */
export function shouldRepairTitle(record: SessionRecord): boolean {
  if (record.agent !== "codex") return false;
  if (record.provisional === true) return false;
  return typeof record.title !== "string" || record.title.length === 0;
}

/** The rewritten record after a delivered title repair: the resolved title, the freshly-sealed blob, AND
 *  the pairing that blob was sealed under. The pairingId restamp is load-bearing: the repair seals under
 *  the CURRENT config.e2eKey, so a legacy record whose pairingId is absent/stale would otherwise hold a
 *  now-decryptable blob that buildHeartbeatEnvelope's key-rotation guard still refuses (pairingId
 *  mismatch → null) — the corrected title would never be heartbeated. Pure so the restamp is testable. */
export function titleRepairedRecord(record: SessionRecord, title: string, blob: string, pairingId: string): SessionRecord {
  return { ...record, title, blob, ...(pairingId.length > 0 ? { pairingId } : {}) };
}

/** The title-repair net for one tracked codex session. Gated by shouldRepairTitle, then it re-runs the
 *  codex title resolver (session_index thread_name → rollout user_message scan — both readable by sweep
 *  time even if every post-SessionStart hook was dropped). If a title resolves it caches the title, the
 *  freshly-sealed blob, AND the sealing pairingId on the record (the heartbeat re-sends record.blob
 *  verbatim, so a stale blank-title blob left in place would let a later heartbeat re-push the very
 *  title:"" we just fixed — and the rewritten record must pass the heartbeat's key-rotation guard, see
 *  titleRepairedRecord) and POSTs the corrective at the session's CURRENT op/status. No title yet (still
 *  pre-thread_name / empty rollout) → nothing to do, retried next sweep. Returns the same verdict triple
 *  as the other nets. */
async function repairTitle(config: Config, path: string, sessionId: string, record: SessionRecord): Promise<"corrected" | "uncorrected" | "revoked"> {
  try {
    if (!shouldRepairTitle(record)) return "uncorrected";
    let prefix = "";
    if (typeof record.transcript === "string" && record.transcript.length > 0) {
      try { prefix = await readPrefix(record.transcript, TITLE_REPAIR_HEAD_BYTES); } catch { /* rollout gone / unreadable → index-only */ }
    }
    // input:{} — the watchdog has no hook payload, so this reduces to the PRIMARY session_index lookup plus
    // the rollout-prefix fallback (the UserPromptSubmit input.prompt path is inert without an input).
    const title = await codexAdapter.title({ sessionId, prefix, input: {}, transcriptPath: record.transcript });
    if (!title) return "uncorrected"; // still no title (pre-thread_name, empty rollout) → retry next sweep
    // Re-POSTing the CURRENT state with the title fixed → `at` is the OBSERVED now (epoch seconds).
    const repairNow = Date.now();
    const envelope = await buildTitleRepairEnvelope(sessionId, record, title, repairNow, config.e2eKey, "codex", Math.floor(repairNow / 1000));
    const outcome = await postEvent(config, envelope);
    if (outcome === "revoked") return "revoked"; // pairing gone → bubble up so the loop can tear down
    if (outcome !== "delivered") return "uncorrected"; // failed POST → keep the old record, retry next sweep
    try {
      const next = titleRepairedRecord(record, title, envelope.blob, config.pairingId);
      // Owner-only (0600), same as every other record rewrite in this file.
      await atomicWrite(path, JSON.stringify(next), 0o600);
    } catch {
      // Rewrite failed — worst case we re-resolve + re-POST next sweep (the worker dedupes the frame).
    }
    return "corrected";
  } catch {
    return "uncorrected";
  }
}

// --- Heartbeat decision ---------------------------------------------------------------------

/** Should this KEPT (alive) session get a heartbeat this sweep? Pure so every guardrail is unit-
 *  testable without fs/network. True iff ALL hold: the session isn't already `done` (mirrors
 *  shouldInterruptCheck's done/sessionStart skip — a finished session must be left to the worker's
 *  own eviction, not kept alive/re-pinned forever by a repeating heartbeat), the interrupt net did
 *  NOT just correct it, it has been event-quiet ≥ HEARTBEAT_AFTER_MS (record.ts is the last REAL hook
 *  event — a heartbeat never rewrites it), and it isn't throttled (no heartbeat within the last
 *  HEARTBEAT_AFTER_MS). */
export function shouldHeartbeat(record: SessionRecord, now: number, lastHeartbeat: number | undefined, correctedThisSweep: boolean): boolean {
  if (record.op === "done") return false; // finished session → never re-armed by a heartbeat
  // The interrupt net has TAKEN this session (it confirmed an Esc/deny and is bounded-retrying its
  // corrective done): while doneAttempts > 0 the heartbeat must hold off rather than re-send the stale
  // needsAttention blob and fight the interrupt net — the same reaper-vs-heartbeat agreement the idle
  // Claude reap enforces below. Persisted, so the hold-off survives the sweep that failed to deliver.
  if (typeof record.doneAttempts === "number" && record.doneAttempts > 0) return false;
  // Idle-CLAUDE reap-eligible → never heartbeat it back to "working": the reaper and the heartbeat must
  // agree, so even when the reap POST FAILED this sweep (record not yet pinned done) the heartbeat holds
  // off rather than keeping a resumed-but-dead-idle session alive on the phone forever.
  if (isClaudeIdleReapEligible(record, now)) return false;
  if (correctedThisSweep) return false;
  if (typeof record.ts !== "number") return false;
  if (now - record.ts < HEARTBEAT_AFTER_MS) return false; // still inside the hook cadence → skip
  if (lastHeartbeat !== undefined && now - lastHeartbeat < HEARTBEAT_AFTER_MS) return false; // throttled
  return true;
}

// --- Waiting-session fast beat (the command-pickup latency floor) ------------------------------
//
// Commands ride back on the RESPONSE to a watchdog /cc/event POST (see the command-intake section),
// so the worst-case delay between a phone tap and the Mac acting on it is exactly "how long until
// this daemon next POSTs". For the target scenario — a session PARKED on a plan picker / permission
// hold / question, i.e. precisely when a user reaches for "Open on Mac" — that was up to FIVE
// MINUTES, and here is why, from the gates themselves:
//   - shouldPendingApprovalCheck returns false once `lastEvent === "needsAttention"` (fire-once
//     dedup), so the pending-approval net stops POSTing the moment the wait is surfaced;
//   - correctResolvedPlanPicker / correctPlanPickerVerification return "uncorrected" WITHOUT a POST
//     while the picker is genuinely still open (state "pending");
//   - correctInterrupt / correctIdleClaude / repairTitle / retireDoneStale all no-op on a titled,
//     alive, uninterrupted attention row;
//   - discoverLiveSessions skips any pid that is already tracked, and reconcileProvisionalsSweep
//     only ever fires for a provisional that a real record now covers — neither POSTs for this row;
//   - the blocking permission hold itself talks to /v1/cc/decision*, never /cc/event.
// Which leaves the staleness heartbeat, gated on `now - record.ts >= HEARTBEAT_AFTER_MS` (5 min).
//
// The fix is deliberately the smallest one that adds no polling loop: while a session is WAITING, the
// pairing gets one extra verbatim heartbeat every WAITING_HEARTBEAT_AFTER_MS. It reuses the existing
// heartbeat envelope (the record's last blob, unchanged op/prio) so it can never alter state, it
// piggybacks on the sweep that already runs every POLL_MS, and it is throttled on a PAIRING-level
// clock rather than a per-session one — so ten waiting sessions cost exactly what one costs.

/** How long the pairing waits between fast beats while any session is parked on the user. Sized
 *  against the sweep cadence (POLL_MS = 5 s) so the next sweep is eligible, and against the
 *  worker's 300-per-60-s-per-pairing /cc/event limit: because the throttle clock is per-PAIRING,
 *  this adds at most 12 POSTs per minute in total (4 % of the budget) no matter how many sessions
 *  wait. Non-waiting sessions are untouched — they keep the 5-minute cadence exactly. */
export const WAITING_HEARTBEAT_AFTER_MS = 5_000;

/** Is this session parked on the USER — a permission hold, a question, or the Codex plan picker?
 *  Pure, and the only thing the fast beat keys on:
 *    - `lastEvent === "needsAttention"` is what every attention producer writes (hook.ts stamps the
 *      posted status; PermissionRequest maps to needsAttention, and the blocking decisionPending
 *      frame is sealed over that same record state);
 *    - `pendingPlanPicker` is the Codex TUI picker's explicit durable marker;
 *    - `prio === 1` is the wire-level attention marker, which only survives while the episode does
 *      (any later working/done hook rewrites op+prio together).
 *  A terminal row is never "waiting", whatever else it carries. */
export function isWaitingSession(record: SessionRecord): boolean {
  if (record.op === "done" || record.lastEvent === "done") return false;
  return record.lastEvent === "needsAttention" || record.pendingPlanPicker === true || record.prio === 1;
}

/** Should this session provide the pairing's fast beat this sweep? Every guardrail shouldHeartbeat
 *  enforces applies identically (a done row, a net that owns the session this sweep, or an in-flight
 *  corrective-done retry all stand down), plus: the session must be waiting, must have been
 *  event-quiet for at least one interval (so this never doubles up on the hook POST that just opened
 *  the episode), and the PAIRING must not have fast-beaten within the interval. `lastWaitingBeat` is
 *  that pairing-wide clock — passed in, so this stays pure. */
export function shouldWaitingHeartbeat(
  record: SessionRecord, now: number, lastWaitingBeat: number | undefined, correctedThisSweep: boolean,
): boolean {
  if (!isWaitingSession(record)) return false;
  if (typeof record.doneAttempts === "number" && record.doneAttempts > 0) return false;
  if (isClaudeIdleReapEligible(record, now)) return false;
  if (correctedThisSweep) return false;
  if (typeof record.ts !== "number") return false;
  if (now - record.ts < WAITING_HEARTBEAT_AFTER_MS) return false; // the opening hook POST just happened
  if (lastWaitingBeat !== undefined && now - lastWaitingBeat < WAITING_HEARTBEAT_AFTER_MS) return false;
  return true;
}

/** Which heartbeat (if any) this session gets this sweep. The stale beat wins when both apply, so a
 *  waiting session that has ALSO been quiet for five minutes still only sends one POST. Pure — the
 *  whole cadence matrix is unit-testable without fs/network. */
export type HeartbeatKind = "none" | "stale" | "waiting";
export function heartbeatKind(
  record: SessionRecord, now: number, lastHeartbeat: number | undefined,
  lastWaitingBeat: number | undefined, correctedThisSweep: boolean,
): HeartbeatKind {
  if (shouldHeartbeat(record, now, lastHeartbeat, correctedThisSweep)) return "stale";
  if (shouldWaitingHeartbeat(record, now, lastWaitingBeat, correctedThisSweep)) return "waiting";
  return "none";
}

/** The pairing-wide clock behind the waiting fast beat (in-memory, exactly like heartbeatAt: a
 *  waiting session is by definition alive, so the daemon outlives the wait it is throttling). */
let waitingBeatAt: number | undefined;

/** The result of one sweep. `revoked` means a /cc/event POST came back gone (404/410) THIS sweep — NOT
 *  a definitive teardown signal on its own: the loop feeds it through the shared 2-strike gate (a
 *  single transient gone never tears down). Otherwise `remaining` is how many session files are left
 *  (so the loop can auto-exit at zero) and `delivered` is true iff at least one POST landed 2xx this
 *  sweep — proof the pairing is alive, so the loop resets any accumulated gone-strike streak. */
export type SweepResult = { revoked: true } | { revoked: false; remaining: number; delivered: boolean };

/** One pass over the sessions dir. A POST that fails (transient) leaves its file in place for the
 *  next sweep (bounded by the 24 h staleness rule); a dead session with no config is still cleaned up
 *  locally. If any POST comes back `revoked` (server 404 — the pairing was forgotten, most likely
 *  from the phone), the sweep bails immediately with `{revoked:true}` so the loop can delete the stale
 *  config: there's no point beating a dead pairing, and /status must stop reporting "paired". */
interface SweepDeps {
  threadWaitState?: (threadId: string) => Promise<CodexThreadWaitState>;
}

async function sweep(config: Config | null, deps: SweepDeps = {}): Promise<SweepResult> {
  let files: string[];
  try {
    files = await readdir(SESSIONS_DIR);
  } catch {
    return { revoked: false, remaining: 0, delivered: false }; // no sessions dir yet → nothing to reap
  }
  const now = Date.now();
  let remaining = 0;
  // Any 2xx POST this sweep proves the pairing is alive → the loop resets the gone-strike streak, so a
  // real success from EITHER the watchdog or the hook clears a stray transient strike.
  let delivered = false;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = `${SESSIONS_DIR}/${file}`;
    const sessionId = basename(file, ".json");
    let record: SessionRecord | null = null;
    try {
      record = JSON.parse(await readFile(path, "utf8")) as SessionRecord;
    } catch {
      record = null; // unreadable / half-written / corrupt → classified as delete
    }
    const verdict = classifySession(record, now, pidAlive);
    // A live retired-owner marker is bookkeeping, not a session: keep the daemon resident so discovery
    // remains suppressed, but run none of the delivery/corrective/title/heartbeat nets against it. When
    // its TUI dies classifySession returns delete and the ordinary unlink path below removes it silently.
    if (verdict === "keep" && record?.agent === "codex" &&
        typeof record.retiredAt === "number" && Number.isFinite(record.retiredAt)) {
      remaining++;
      continue;
    }
    if (verdict === "keep") {
      // Long-lived Plan verification runs before the done-debt net: a killed/old Stop may have left a
      // donePending record whose terminal state is precisely what still needs classification.
      let planVerificationHandled = false;
      if (config && record) {
        const verification = await correctPlanPickerVerification(config, path, sessionId, record, {
          ...(deps.threadWaitState ? { threadWaitState: () => deps.threadWaitState!(sessionId) } : {}),
        });
        if (verification === "revoked") return { revoked: true };
        if (verification === "corrected") delivered = true;
        planVerificationHandled = verification === "corrected" || verification === "pending";
      }
      if (planVerificationHandled) {
        remaining++;
        continue; // the sweep snapshot is stale after any correction; no competing net may use it
      }
      // Undelivered-done reconcile BEFORE everything else: a record can carry a done the worker never
      // received (the hook's write-before-POST ordering — see correctPendingDone), and until that debt
      // is settled the worker's view of this session is a stale "update", so no other net's decision
      // about it is meaningful. Handling it (delivered, retrying, or capped) makes this net the
      // session's owner for the sweep — retire, the correctives and the heartbeat all stand down, so a
      // just-repaired done gets to be the phone's last word before retirement can drop the row.
      let pendingDoneHandled = false;
      if (config && record) {
        const pendingDone = await correctPendingDone(config, path, sessionId, record, now);
        if (pendingDone === "revoked") return { revoked: true };
        if (pendingDone === "corrected") delivered = true; // its done 2xx'd → the pairing is alive
        pendingDoneHandled = pendingDone === "corrected" || pendingDone === "pending";
      }
      // Idle-done RETIRE next: any terminal row whose last REAL event is >1 h old gets a blob-less
      // op:end. Codex retains only an invisible real-TUI owner marker, preventing discoverLive from
      // undoing the retirement; other rows delete normally. Working / needsAttention never qualify.
      if (config && record && !pendingDoneHandled) {
        const retire = await retireDoneStale(config, path, sessionId, record, now);
        if (retire === "revoked") return { revoked: true };
        if (retire !== "skip") {
          if (retire === "retired") delivered = true; // its op:end 2xx'd → the pairing is alive
          continue; // record deleted or replaced by an invisible owner marker; never heartbeated
        }
      }
      remaining++;
      // `!pendingDoneHandled`: the undelivered-done net took this session this sweep, so nothing below
      // may POST for it (the in-memory `record` is also stale w.r.t. that net's rewrite).
      if (config && record && !pendingDoneHandled) {
        // Idle-provisional corrective FIRST: a discovery row advertised "working" whose TUI has gone
        // idle gets its one op:done before anything else could heartbeat the stale working blob.
        // Gated to provisional records of a probe-capable agent (codex); everything else no-ops.
        const idleFix = await correctIdleProvisional(config, path, sessionId, record);
        if (idleFix === "revoked") return { revoked: true };
        if (idleFix === "corrected") delivered = true; // it POSTed a done → a 2xx landed
        // A Stop/notify-classified Codex Plan picker stays needsAttention until the rollout proves the
        // Mac answered it. Clear that explicit episode before the generic correctives/heartbeat; a
        // failed/unknown probe leaves it untouched and the heartbeat sustains the pending state.
        const planResolution = await correctResolvedPlanPicker(config, path, sessionId, record, {
          ...(deps.threadWaitState ? { threadWaitState: () => deps.threadWaitState!(sessionId) } : {}),
          tuiCandidates: readAllRecords,
        });
        if (planResolution === "revoked") return { revoked: true };
        const resolvedPlan = planResolution === "corrected";
        const planResolutionHandled = resolvedPlan || planResolution === "pending";
        if (resolvedPlan) delivered = true;
        // Ordering is the guardrail: run the interrupt-recovery net next. If either net corrected the
        // session (POSTed a done), it is effectively done, so we must NOT also heartbeat it — the
        // returned flags carry that. Only a clean, alive, quiet, uncorrected session gets a
        // heartbeat, which re-sends its last blob to re-arm the island's stale-date.
        const corrected = planResolutionHandled ? "uncorrected" : await correctInterrupt(config, path, sessionId, record, now);
        if (corrected === "revoked") return { revoked: true }; // gone this POST → gated teardown in run()
        if (corrected === "corrected") delivered = true; // it POSTed a done → a 2xx landed
        // "corrected" OR "pending" both mean the interrupt net has taken ownership of this session this
        // sweep (delivered a done, or is bounded-retrying / just settled it locally): the other nets and
        // the heartbeat must all stand down so they can't re-raise the stale needsAttention state.
        const interruptHandled = corrected === "corrected" || corrected === "pending";
        // Pending-approval backstop: only if the interrupt-net didn't just take the session. Re-raises
        // needsAttention when a DROPPED Codex PermissionRequest (openai/codex#16430) left the session
        // silently blocked. Claude's adapter offers no classifier, so this no-ops for Claude records.
        let flaggedAttention = false;
        if (!planResolutionHandled && !interruptHandled) {
          const attn = await correctPendingApproval(config, path, sessionId, record, now);
          if (attn === "revoked") return { revoked: true };
          if (attn === "corrected") { delivered = true; flaggedAttention = true; }
        }
        // Idle-session reap: Claude keeps its historical event/transcript silence rule. Codex additionally
        // needs a correlated live TUI + readable exact rollout proving no turn is open. Only if no earlier
        // net already finished the turn this sweep.
        let reapedIdle = false;
        if (idleFix !== "corrected" && !planResolutionHandled && !interruptHandled && !flaggedAttention) {
          const idleClaude = await correctIdleClaude(config, path, sessionId, record, now);
          if (idleClaude === "revoked") return { revoked: true };
          // "corrected" (delivered a done) OR "pending" (bounded-retrying / just pinned done locally) both
          // mean the reap OWNS this session this sweep — the title net + the heartbeat must stand down so
          // they can't re-raise or re-arm it; only a delivered done counts toward `delivered`.
          if (idleClaude === "corrected" || idleClaude === "pending") reapedIdle = true;
          if (idleClaude === "corrected") delivered = true;
        }
        // Codex title-repair: heal a session that shipped title:"" from a SessionStart and then had every
        // later hook dropped (openai/codex#16430) — by sweep time the session_index thread_name / rollout
        // user_message are on disk. Only when nothing else corrected this sweep (a done row with a blank
        // title is fixed on a later sweep, since the record persists); no-ops for claude / titled records.
        let repairedTitle = false;
        if (idleFix !== "corrected" && !planResolutionHandled && !interruptHandled && !flaggedAttention && !reapedIdle) {
          const titleFix = await repairTitle(config, path, sessionId, record);
          if (titleFix === "revoked") return { revoked: true };
          if (titleFix === "corrected") { delivered = true; repairedTitle = true; }
        }
        const beatKind = heartbeatKind(
          record, now, heartbeatAt.get(sessionId), waitingBeatAt,
          idleFix === "corrected" || planResolutionHandled || interruptHandled || flaggedAttention || reapedIdle || repairedTitle,
        );
        if (beatKind !== "none") {
          const beat = buildHeartbeatEnvelope(sessionId, record, Date.now(), config.pairingId);
          // delivered only: a failed heartbeat mutates NOTHING (not the record, not even the throttle),
          // so quietness stays true and it's retried next sweep. A record with no stored blob yields
          // a null envelope — nothing to send, so it simply isn't heartbeated.
          if (beat) {
            const outcome = await postEvent(config, beat);
            if (outcome === "revoked") return { revoked: true };
            if (outcome === "delivered") {
              heartbeatAt.set(sessionId, now); // a fast beat IS a heartbeat — it advances both clocks
              if (beatKind === "waiting") waitingBeatAt = now;
              delivered = true;
            }
          }
        }
      }
      continue;
    }
    if (verdict === "end" && config && record) {
      // delivered gates deletion: a 401/500 (bad secret, Worker error) is NOT success, so we keep the
      // file and retry next sweep rather than silently dropping the session. A 404 means the pairing
      // itself is gone → bail and let the loop tear the config down.
      const outcome = await postEvent(config, buildEndEnvelope(sessionId, now, record));
      if (outcome === "revoked") return { revoked: true };
      if (outcome !== "delivered") {
        remaining++;
        continue;
      }
      delivered = true; // the reap POST landed 2xx → the pairing is alive
    }
    if (verdict === "stale" && config && record) {
      // 24 h-abandoned session (its POSTs have kept failing, or the machine slept through the death):
      // POST a best-effort terminal end so the phone's row RESOLVES instead of orphaning until the
      // worker's TTL (never silent-vanish), then fall through to delete REGARDLESS — unlike the dead-pid
      // reap, the staleness cap exists to STOP retrying, so a failed POST here does not keep the file.
      // A revoke still bails the whole sweep so the loop can tear the pairing down.
      const outcome = await postEvent(config, buildEndEnvelope(sessionId, now, record));
      if (outcome === "revoked") return { revoked: true };
      if (outcome === "delivered") delivered = true;
    }
    heartbeatAt.delete(sessionId); // session is being removed → drop its throttle entry
    clearDoneAttempts(sessionId); // …and its corrective-done retry count (a new session must start at 0)
    try {
      await unlink(path);
    } catch {
      // Already gone (raced with another sweep or a SessionEnd hook) — fine.
    }
  }
  return { revoked: false, remaining, delivered };
}

/** Apply one watchdog-observed gone (404/410) sweep against the SHARED strike counter and decide
 *  whether to tear the local pairing down NOW. Mirrors the hook's guard exactly — same counter file,
 *  same GONE_STRIKE_LIMIT — so a single transient gone from the watchdog behaves like a transient
 *  failure (retry next cycle, no teardown) and only a genuine revoke, which 404s every POST, reaches
 *  the limit. Returns true iff the caller should call removeRevokedConfig and exit. Exported so the
 *  strike-gate decision is unit-testable without driving the whole run() loop. Path injectable for
 *  tests. */
export async function goneStrikeShouldTeardown(goneStrikesPath?: string): Promise<boolean> {
  return (await recordGoneStrike(goneStrikesPath)) >= GONE_STRIKE_LIMIT;
}

// --- Codex remote-input bridge supervision (presence-gated, deadline-decoupled) ----------------
//
// The bridge attaches to the SHARED codex app-server through `codex app-server proxy`, and a real
// request_user_input response must return on that same process. Two rules the sweep loop depends on:
//
//   PRESENCE GATE — construct/start it ONLY while a Codex app-server daemon is actually up. Unguarded,
//   a Claude-only user (no codex installed, or codex installed but never run as a daemon) got a fresh
//   `codex` child spawned on every cycle forever. The probe is one stat of the control socket
//   (codexAppServerSocketAvailable), cheap enough to re-run EVERY sweep — so a user who starts the
//   daemon later gets the bridge without restarting the watchdog, and a daemon that goes away stops it.
//
//   DEADLINE — never let the sweep cadence depend on Codex responsiveness. A wedged proxy child (spawned,
//   never writes, never exits) used to freeze the whole loop at `await bridge.start()`: no reap, no
//   heartbeat, no discovery, no gone-strike teardown — with the pidfile still claimed, so nothing could
//   replace us either. Bridge work now runs DETACHED behind a deadline; the loop never awaits it.
//
//   RECOVERY + HONESTY (2026-08-04) — the presence gate is correct but it used to fail SILENTLY, and the
//   thing it silently disables is the ONLY path by which a phone can answer a Codex TUI
//   `request_user_input` (codex-remote-input builds the questions and injects the answer through
//   answerAppServer → client.answerUserInput; there is no hook-shaped substitute — see the deletion note
//   in core/permission). A daemon that died at 22:14 therefore turned every Codex question into an
//   attention row nobody could answer, with nothing anywhere saying why. So absence now does two things:
//     1. TRIES ONCE PER COOLDOWN to bring the daemon back (`codex app-server daemon start`), detached,
//        bounded, non-interactive, every failure traced and none thrown; and
//     2. RAISES A BREADCRUMB (`cxbridge:down` in the Codex `dbg` tail) for as long as the socket is gone.
//   ORDERING TRUTH: starting the daemon does NOT rescue an already-running TUI — a Codex TUI launched
//   with no daemon hosts its conversation in-process and can never retro-attach. The attempt buys the
//   NEXT session, and the breadcrumb's wording promises nothing more.

/** The running loop's bridge teardown, published so the SIGTERM/SIGINT handler can stop the proxy child
 *  through the same path run()'s `finally` uses. Undefined outside a live run(). */
let activeBridgeShutdown: (() => void) | undefined;

/** The running loop's LAN listener teardown, published for the SIGTERM/SIGINT handler for the same
 *  reason activeBridgeShutdown is: default signal handling skips run()'s `finally`, and a leaked
 *  listening socket would keep the successor watchdog from re-binding the persisted port. */
let activeLanShutdown: (() => void) | undefined;

/** How long a detached bridge operation may run before the supervisor stops waiting on it. It is NOT a
 *  cancel (the underlying client owns its own retry/backoff) — it just bounds the supervisor's own
 *  bookkeeping so a wedged child can never pin an in-flight operation forever. */
const BRIDGE_OP_DEADLINE_MS = 15_000;
/** Picker status is advisory; a slow daemon must not stretch the five-second sweep cadence. */
const PLAN_PICKER_STATUS_QUERY_DEADLINE_MS = 2_000;

/** Race a promise against a timer, resolving `undefined` at the deadline. The work keeps running (we
 *  can't cancel a child's IO), but the caller stops waiting. The timer is unref'd where the runtime
 *  supports it so it can never hold the process open. */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

/** How often the supervisor RE-ARMS a live bridge by calling start() again. The app-server client
 *  retries with exponential backoff and, after enough consecutive failures, deliberately PARKS itself in
 *  a clean restartable state ("stopped": no transport, no timer) — by design it then stays off until
 *  someone calls start() again, and that someone is us. The parked state is normally detected exactly
 *  (the client reports its give-up through onError; see GIVE_UP_PATTERN), and this interval is the
 *  BACKSTOP for every state we cannot observe from outside the bridge. 10 min: re-arming is nearly free
 *  (start() on a ready client resolves immediately and just refreshes subscriptions) and it only ever
 *  runs while a Codex daemon socket genuinely exists, so it can never become the old spawn loop. */
const BRIDGE_REARM_MS = 600_000;

/** The client's give-up report ("…reconnect gave up after N consecutive failures"). Matching it lets the
 *  supervisor re-arm on the NEXT sweep instead of waiting out BRIDGE_REARM_MS. Deliberately loose and
 *  non-load-bearing: if the wording ever drifts, the interval above still re-arms. */
const GIVE_UP_PATTERN = /gave up/i;

/** At most ONE `codex app-server daemon start` attempt per this window, counted from the moment the
 *  attempt is launched (not from its outcome), so a slow or wedged start cannot let a second one in.
 *  Five minutes: long enough that a machine with no codex installed spends effectively nothing on this
 *  forever, short enough that a user who fixes their install sees the bridge come back within one coffee
 *  refill. It is NOT a retry budget — there is no cap on total attempts, because the honest recovery for
 *  a daemon that died hours ago is exactly "try again periodically". */
const BRIDGE_DAEMON_START_COOLDOWN_MS = 300_000;

/** Is the Codex app-server control socket missing as of the most recent sweep? Module-level because the
 *  blob builders below are pure functions called from a dozen places and threading a flag through all of
 *  them would be pure noise; run() republishes it from the supervisor once per cycle. Defaults to FALSE
 *  so nothing that never runs a sweep (every unit test of a builder, the LAN read path) can accidentally
 *  stamp the marker. */
let codexBridgeDown = false;

/** Publish the sweep's observation. Exported for tests and for run()'s once-per-cycle republish. */
export function setCodexBridgeDown(down: boolean): void {
  codexBridgeDown = down;
}

/** The current observation, read by the Codex blob builders when they stamp `dbg`. */
export function codexBridgeIsDown(): boolean {
  return codexBridgeDown;
}

/** The slice of CodexRemoteInputBridge the supervisor drives (start/stop/refresh). Declared structurally
 *  so tests can drive the supervisor with a fake and the real class stays untouched. */
export interface RemoteInputBridgeLike {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  refreshSubscriptions(): Promise<void>;
  readThreadWaitState?(threadId: string): Promise<CodexThreadWaitState>;
}

/** Injectable seams for the bridge supervisor. */
export interface BridgeSupervisorDeps {
  /** Is a Codex app-server daemon present right now? Defaults to the control-socket stat. */
  probe?: () => Promise<boolean>;
  /** Builds a bridge for a pairing, wired to the supervisor's error sink. Defaults to the real
   *  CodexRemoteInputBridge. */
  create?: (config: Config, options: { onError: (error: Error) => void }) => RemoteInputBridgeLike;
  /** Runs bridge work OFF the sweep path. Defaults to fire-and-forget behind BRIDGE_OP_DEADLINE_MS with
   *  every rejection swallowed — the daemon's contract is silence, and a bridge failure must never
   *  surface as an unhandled rejection nor stall the loop. Tests inject a collector to await the work. */
  detach?: (work: () => Promise<unknown>) => void;
  /** Diagnostic passthrough for bridge/client errors (the daemon itself reports nothing — silence is the
   *  contract — but the supervisor still inspects them to spot a parked client). */
  onError?: (error: Error) => void;
  /** Best-effort recovery for an ABSENT daemon: `codex app-server daemon start`. Defaults to the real
   *  bounded, non-interactive, never-throwing spawn. Resolves true only when the control socket is
   *  genuinely there afterwards. */
  startDaemon?: () => Promise<boolean>;
  /** Local-only trace sink for the start attempts (never stdout, never the wire). */
  trace?: (event: object) => void;
  now?: () => number;
}

/** Drives the Codex remote-input bridge alongside the sweep loop. `sync` is called once per cycle with
 *  the CURRENT config and returns as soon as the bookkeeping is done — never after the bridge's IO. */
export function createBridgeSupervisor(deps: BridgeSupervisorDeps = {}) {
  const probe = deps.probe ?? (() => codexAppServerSocketAvailable());
  const create = deps.create
    ?? ((config: Config, options: { onError: (error: Error) => void }) =>
      new CodexRemoteInputBridge(config, options) as RemoteInputBridgeLike);
  const detach = deps.detach ?? ((work: () => Promise<unknown>) => {
    void withDeadline(Promise.resolve().then(work), BRIDGE_OP_DEADLINE_MS).catch(() => {});
  });
  const now = deps.now ?? Date.now;
  // Under `bun test` the default is a NO-OP: a unit test that drives an absent socket must never spawn a
  // real `codex` on the developer's machine (same guard, same reason, as the hold-marker writers in
  // core/permission). Tests that exercise the recovery inject `startDaemon`.
  const startDaemon = deps.startDaemon
    ?? (lanRunningUnderTest() ? async () => false : () => startCodexAppServerDaemon());
  const trace = deps.trace ?? ((event: object) => traceSession(event));
  let bridge: RemoteInputBridgeLike | undefined;
  let pairingId: string | undefined;
  let lastStartAt = 0;
  /** The client told us it gave up reconnecting → re-arm on the very next sweep. */
  let parked = false;
  /** Was the control socket missing on the most recent PAIRED sync? Read by run() to publish the
   *  `cxbridge:down` breadcrumb, and reset the moment the socket comes back. */
  let daemonDown = false;
  /** When the last daemon start attempt was LAUNCHED (0 = never). Stamped before the work is detached so
   *  the cooldown holds even while an attempt is still in flight. */
  let lastDaemonStartAt = 0;

  /** The bridge's error sink: watch for the client's give-up so the re-arm is prompt, then pass through. */
  const onError = (error: Error): void => {
    try { if (GIVE_UP_PATTERN.test(error.message)) parked = true; } catch { /* exotic error object */ }
    try { deps.onError?.(error); } catch { /* a broken reporter must not break the supervisor */ }
  };

  /** Drop the current bridge (detached — a wedged child must not stall the caller). */
  const teardown = (): void => {
    const dying = bridge;
    bridge = undefined;
    pairingId = undefined;
    parked = false;
    if (dying) detach(() => dying.stop());
  };

  /** (Re-)arm the connection. start() is idempotent: on a READY client it resolves immediately and just
   *  refreshes subscriptions, so calling it periodically is safe. */
  const arm = (target: RemoteInputBridgeLike): void => {
    lastStartAt = now();
    parked = false;
    detach(() => target.start());
  };

  /** Absent socket → try to bring the daemon back, at most once per BRIDGE_DAEMON_START_COOLDOWN_MS.
   *  DETACHED like every other bridge operation: the sweep must never wait on `codex` starting, and a
   *  binary that hangs must cost this loop nothing. The cooldown stamp is taken BEFORE detaching, so the
   *  five-second sweep cadence cannot fire a second attempt while the first is still running. Every
   *  failure mode is inside startDaemon (which never throws); we only record the decision. */
  const tryStartDaemon = (): void => {
    const at = now();
    if (lastDaemonStartAt !== 0 && at - lastDaemonStartAt < BRIDGE_DAEMON_START_COOLDOWN_MS) return;
    lastDaemonStartAt = at;
    try { trace({ event: "codex-daemon-start", outcome: "attempt" }); } catch { /* tracing is never fatal */ }
    detach(async () => {
      // The result is deliberately NOT acted on here: the next sweep's own socket probe is the single
      // source of truth for "is there a daemon", and a successful start therefore builds the bridge on
      // the very next cycle rather than through a second, racier code path.
      await startDaemon().catch(() => false);
    });
  };

  return {
    /** One cycle of supervision. Unpaired → tear down. Paired but no Codex daemon → tear down (and never
     *  construct one, so a Claude-only machine never spawns `codex` at all). Paired + daemon present →
     *  (re)create on a pairing change, re-arm a parked/stale connection, else refresh subscriptions. All
     *  bridge IO is detached. */
    async sync(config: Config | null): Promise<void> {
      if (!config) {
        teardown();
        daemonDown = false; // unpaired: there is no Codex row to be honest to
        return;
      }
      let available = false;
      try { available = await probe(); } catch { available = false; }
      if (!available) {
        teardown(); // daemon went away (or never existed) → stop the bridge, keep the sweep running
        // …but do NOT stop there: silence here is what made a dead daemon look like a working one for a
        // whole day. Try to bring it back (bounded, cooldown-gated, detached) and raise the breadcrumb
        // meanwhile — the attempt is for the NEXT Codex session, never for a TUI already running.
        daemonDown = true;
        tryStartDaemon();
        return;
      }
      daemonDown = false;
      if (!bridge || pairingId !== config.pairingId) {
        teardown();
        const next = create(config, { onError });
        bridge = next;
        pairingId = config.pairingId;
        arm(next);
        return;
      }
      const current = bridge;
      // A client that gave up reconnecting stays OFF until start() is called again — so re-arm it (the
      // socket probe above just proved a daemon is there to reach), and re-arm periodically anyway to
      // cover the parked states we cannot observe from outside the bridge.
      if (parked || now() - lastStartAt >= BRIDGE_REARM_MS) {
        arm(current);
        return;
      }
      detach(() => current.refreshSubscriptions());
    },
    /** Final teardown for the loop's `finally` / a signal handler. */
    shutdown(): void {
      teardown();
    },
    /** Query only an already-pending picker. Socket absence, bridge startup, protocol drift, and
     *  timeout all fail open to "unavailable"; the hard marker TTL remains authoritative. */
    async threadWaitState(threadId: string): Promise<CodexThreadWaitState> {
      if (!bridge?.readThreadWaitState) return "unavailable";
      let available = false;
      try { available = await probe(); } catch { return "unavailable"; }
      if (!available) return "unavailable";
      try {
        return await withDeadline(
          bridge.readThreadWaitState(threadId),
          PLAN_PICKER_STATUS_QUERY_DEADLINE_MS,
        ) ?? "unavailable";
      } catch {
        return "unavailable";
      }
    },
    /** Whether a bridge is currently constructed (test/diagnostic seam). */
    get active(): boolean {
      return bridge !== undefined;
    },
    /** Was the Codex control socket missing on the last PAIRED sync? run() republishes this to the blob
     *  builders as the `cxbridge:down` breadcrumb. */
    get daemonDown(): boolean {
      return daemonDown;
    },
  };
}

/** Claim the single-instance pidfile. Returns false if another *live* watchdog on the SAME build already
 *  holds it, so this instance can exit immediately.
 *
 *  Two things this refuses to be fooled by (see the pidfile note in core/shared):
 *   - a RECYCLED pid — a reboot-surviving pidfile whose pid now belongs to some unrelated process. Trusting
 *     kill(pid,0) there blocked every future watchdog forever; watchdogHolderIsLive `ps`-verifies the
 *     command line, so a recycled pid reads as STALE and we claim it.
 *   - a live incumbent on a DIFFERENT build — we were spawned by ensureWatchdog precisely because it wants
 *     the new bundle running, and it SIGTERMs the incumbent in the same breath. Backing off there would
 *     leave the old code running (and would re-loop: the next hook SIGTERMs + spawns again), so a
 *     version-mismatched incumbent is taken over. Its own release is ownership-checked, so it can never
 *     stomp our claim on the way out. */
async function claimSingleInstance(): Promise<boolean> {
  // OUR bundle's identity, read once. It is stamped into the pidfile so a later hook can tell that a
  // rebuild happened under an unchanged version (see watchdogBuildStamp) — and it is the same test
  // applied here, so a same-version incumbent running DIFFERENT code is taken over rather than deferred
  // to. Without that, ensureWatchdog would SIGTERM the stale daemon and its replacement would politely
  // back off, leaving the machine with no watchdog at all.
  const build = watchdogBuildStamp();
  try {
    const holder = parseWatchdogPidfile(readFileSync(WATCHDOG_PID_PATH, "utf8"));
    if (holder && holder.pid !== process.pid && watchdogHolderIsLive(holder.pid)
        && holder.version === PLUGIN_VERSION && !watchdogBuildDiffers(holder.build, build)) {
      return false;
    }
  } catch {
    // No pidfile (or unreadable) → free to claim.
  }
  await atomicWrite(WATCHDOG_PID_PATH, formatWatchdogPidfile(process.pid, PLUGIN_VERSION, build));
  return true;
}

export interface WatchdogOwnershipDeps {
  pidPath?: string;
  pid?: number;
  version?: string;
  readPidfile?: () => string;
}

/** Whether this process still owns the exact pidfile claim it started with. Claim-time exclusion is
 *  not enough: a newer build, reset, unpair, or a racing spawn can replace/remove the pidfile while an
 *  old daemon is asleep or stuck in bridge work. Re-check before EVERY sweep so that displaced daemon
 *  notices on its next turn and retires its children instead of continuing as an ownerless zombie. */
export function isRightfulWatchdogOwner(deps: WatchdogOwnershipDeps = {}): boolean {
  try {
    const pidPath = deps.pidPath ?? WATCHDOG_PID_PATH;
    const holder = parseWatchdogPidfile((deps.readPidfile ?? (() => readFileSync(pidPath, "utf8")))());
    return holder?.pid === (deps.pid ?? process.pid) && holder.version === (deps.version ?? PLUGIN_VERSION);
  } catch {
    return false; // missing/unreadable pidfile means nobody may keep sweeping
  }
}

/** Sweep-boundary ownership gate. `shutdown` is the bridge supervisor's teardown path, which stops
 *  its `codex app-server proxy` child (and remains safe to call again from run()'s finally block). */
export function enforceWatchdogOwnership(shutdown: () => void, deps: WatchdogOwnershipDeps = {}): boolean {
  if (isRightfulWatchdogOwner(deps)) return true;
  try { shutdown(); } catch { /* best-effort child cleanup; finally gets another chance */ }
  return false;
}

/** Release the pidfile only if we still own it, so we never stomp a successor's claim. */
function releaseSingleInstance(): void {
  try {
    const holder = parseWatchdogPidfile(readFileSync(WATCHDOG_PID_PATH, "utf8"));
    if (holder && holder.pid === process.pid) unlinkSync(WATCHDOG_PID_PATH);
  } catch {
    // Nothing to release.
  }
}

/** Has this pending pairing outlived the QR's TTL? Uses the stamped createdAt when present (createdAt
 *  + PAIRING_TTL_MS), else falls back to a process-local deadline (this watchdog's spawn time +
 *  PAIRING_TTL_MS) so a pre-createdAt config still gets bounded. Pure so the deadline logic is unit-
 *  testable without a clock or fs. */
export function pendingPairingExpired(pending: PendingConfig, now: number, fallbackDeadline: number): boolean {
  const deadline = typeof pending.createdAt === "number" ? pending.createdAt + PAIRING_TTL_MS : fallbackDeadline;
  return now >= deadline;
}

/** Best-effort delete of a stale pending config on a terminal expiry/gone path, so /status stops
 *  reporting "waiting for phone scan" forever. Tolerates ENOENT. Callers only reach here after
 *  confirming the on-disk config is NOT completed, so a healthy completed config is never deleted. */
async function removePendingConfig(): Promise<void> {
  try {
    await unlink(`${CC_DIR}/config.json`);
  } catch {
    // already gone / raced with a SessionEnd or a re-pair — fine
  }
  // Tear down the sibling pairing PAGE too (it embeds the QR secret + one-time code): on a terminal
  // expiry/gone path the page must not be orphaned next to the now-deleted config. Tolerates ENOENT.
  await unlink(`${CC_DIR}/${PAIR_HTML_FILE}`).catch(() => {});
}

/** One self-heal attempt on a mid-pairing config: if `pair wait` never ran (Ctrl-C, closed terminal)
 *  but the phone claimed, this long-lived process completes the pairing for the PC. One status-check/
 *  complete/ack, silently, with a short (2 s) timeout. Returns:
 *   - "continue" → completed (or transient: pending / network): the config is now valid / retry next
 *                  cycle → keep looping.
 *   - "stop"     → rejected / tampered claim: nothing more to do here, but leave the config in place.
 *   - "cleanup"  → the pending record is gone / was already acked by a concurrent completer AND the
 *                  config did NOT complete under us → genuinely unrecoverable; delete the stale
 *                  pending config and stop instead of spinning on a dead record. */
async function selfHealPairing(pending: PendingConfig): Promise<"continue" | "stop" | "cleanup"> {
  let result: PairPollResult;
  try {
    result = await completePendingPairing(pending, `${CC_DIR}/config.json`, { fetchTimeoutMs: 2000, ackAttempts: 1 });
  } catch {
    return "continue"; // unexpected error → try again next cycle
  }
  if (result.state === "gone" || result.state === "already-completed") {
    // Worker has no claimable record. If a concurrent completer wrote the completed config under us,
    // the pairing succeeded and we simply stop; otherwise it's dead — clean up the pending config.
    return (await loadConfig()) ? "stop" : "cleanup";
  }
  if (result.state === "rejected" || result.state === "tampered") return "stop";
  return "continue"; // completed / pending / network
}

async function run(): Promise<void> {
  if (!(await claimSingleInstance())) return; // another live watchdog owns the beat
  // Process-local fallback deadline for a pending config with no stamped createdAt (older `pair`):
  // bound the self-heal to PAIRING_TTL_MS from THIS watchdog's spawn so an unreachable worker can't
  // keep us polling forever.
  const fallbackDeadline = Date.now() + PAIRING_TTL_MS;
  // Idle-grace clock: the last time a sweep saw ANY session (or we just spawned). While paired we linger
  // up to IDLE_GRACE_MS past this so discovery keeps watching for the next freshly-opened Codex TUI
  // instead of retiring the instant the sessions dir empties (see IDLE_GRACE_MS).
  let lastActiveMs = Date.now();
  const bridges = createBridgeSupervisor();
  activeBridgeShutdown = () => bridges.shutdown();
  // The LAN listener starts only AFTER the single-instance claim: exactly one watchdog per machine may
  // own the socket (and the persisted port in lan.json), and a losing instance returned above without
  // ever reaching here. createLanListener returns immediately — the bind runs off this stack, so a
  // refused/occupied port can never delay the first sweep.
  const lan = createLanListener({
    onCommand: acceptLanCommand,
    // Phase 2: the listener stores the sealed answer itself (the hook's loopback poll and the Codex
    // relay read that store); this sink only fires the worker echo, off the response path.
    onAnswer: (answer) => { void acceptLanAnswer(answer); },
  });
  activeLanListener = lan;
  // ONE stop, reached from all three teardown seams: run()'s `finally`, an ownership loss mid-sweep
  // (both via `shutdown`), and the SIGTERM/SIGINT handler (via activeLanShutdown, which default signal
  // handling reaches without running the `finally`). lan.stop() is idempotent, so overlapping seams are
  // free; the try/catch is here rather than at each seam so no caller can forget it.
  const stopLan = (): void => {
    try { lan.stop(); } catch { /* best-effort socket teardown */ }
  };
  const shutdown = (): void => {
    bridges.shutdown();
    stopLan();
  };
  activeLanShutdown = stopLan;
  try {
    while (true) {
      // A claim can be stolen or removed after startup (upgrade takeover, reset, racing spawn). An
      // ownerless daemon must not touch sessions or retain its proxy/bridge children — or its LAN
      // socket, which a successor needs to re-bind — for another tick.
      if (!enforceWatchdogOwnership(shutdown)) return;
      const config = await loadConfig(); // reload each cycle: a mid-pairing config may complete under us
      // A real Codex request_user_input response must return on the SAME shared app-server process, so
      // the bridge attaches through `codex app-server proxy` — but ONLY while that control socket exists
      // (re-probed every cycle) and never on the sweep's own await path. Fail-open in both directions: no
      // Codex daemon → no bridge and no spawn at all; a wedged proxy child → the sweep keeps its cadence.
      await bridges.sync(config);
      // Publish the socket observation to this cycle's blob builders. While it is down, every Codex frame
      // this sweep seals carries `cxbridge:down` in its `dbg` tail — the phone's diagnostics toggle is
      // then the difference between "my question just sits there" and a nameable cause. It clears itself
      // the moment a daemon is back.
      setCodexBridgeDown(bridges.daemonDown);
      // Re-key the LAN listener from the CURRENT config (a re-pair rotates e2eKey, and K_lan derives
      // from it). Deliberately NOT awaited-on-IO: sync() only swaps a promise and returns, so the LAN
      // channel can never sit on the sweep path — the design's non-negotiable.
      lan.sync(config);
      // Discovery + reconcile run BEFORE the sweep (only when paired). Backstop-reconcile first (retire
      // any provisional whose real session already reported), then discover new TUIs — so a just-
      // surfaced provisional is counted in `remaining` this same cycle, keeping the daemon alive
      // naturally while a discovered TUI lives.
      if (config) {
        await reconcileProvisionalsSweep(config);
        await discoverLiveSessions(config);
      }
      const result = await sweep(config, {
        threadWaitState: (threadId) => bridges.threadWaitState(threadId),
      });
      // Commands the worker piggybacked on THIS cycle's POST responses (discovery/reconcile/sweep).
      // Drained once per tick, off the POST path, so a slow osascript can never delay a status event.
      // Best-effort by construction — drainCommands swallows everything and returns a count.
      if (config) await enqueueDrainCommands(config);
      if (result.revoked) {
        // A /cc/event POST came back gone (404/410) this sweep. Do NOT tear down on the first one — a
        // single gone can be a transient/racing delete (worker redeploy, KV eventual-consistency), and
        // nuking a healthy pairing's credential config on one blip is exactly what the hook's 2-strike
        // guard prevents. Count it against the SAME shared streak and only tear down at the limit; the
        // hook's own successful POSTs (or a later watchdog delivery) reset it. A genuine revoke 404s
        // every POST, so the streak reaches GONE_STRIKE_LIMIT within a couple of cycles either way.
        if (await goneStrikeShouldTeardown()) {
          // Confirmed gone: tear the stale config down so /status stops claiming "paired", then quit —
          // the next hook (if any) starts a fresh, unpaired-inert cycle.
          await removeRevokedConfig();
          return;
        }
        // First strike → treat as transient: retry next cycle instead of tearing down.
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }
      // A delivered POST this sweep proves the pairing is alive → clear any stray gone-strike so two
      // transient blips separated by a success can never accumulate to a false teardown.
      if (result.delivered) await resetGoneStrikes();
      const remaining = result.remaining;
      if (!config) {
        // Unpaired OR mid-pairing. Opportunistically complete a pending pairing (self-heal), then keep
        // looping through the pairing window so a claim that arrives after `wait` died still lands.
        const pending = await loadPendingConfig();
        if (!pending) {
          // Unpaired with NOTHING pending: there is no key to send with and nothing to self-heal, so
          // exit NOW instead of idling. Lingering here is how a pre-rotation daemon kept beating after
          // an unpair/re-pair race (config gone, sends continuing off stale state); the next paired
          // hook re-spawns a fresh watchdog that reads the fresh config.
          return;
        }
        // Past the QR's TTL a still-pending config can never complete → clean it up and stop, so an
        // unreachable worker never leaves this detached poller spinning until reboot.
        if (pendingPairingExpired(pending, Date.now(), fallbackDeadline)) {
          await removePendingConfig();
          return;
        }
        const verdict = await selfHealPairing(pending);
        if (verdict === "stop") return;
        if (verdict === "cleanup") {
          await removePendingConfig();
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }
      const nowMs = Date.now();
      if (remaining > 0) lastActiveMs = nowMs; // a live session resets the idle-grace clock
      if (remaining === 0) {
        // No sessions this sweep. Unpaired (or mid-pairing with no pending) → nothing to discover, so
        // retire immediately as before; the hook re-spawns us. Paired → linger through the idle grace so
        // discovery can surface the next freshly-opened Codex TUI, then retire once truly idle.
        if (!config || nowMs - lastActiveMs >= IDLE_GRACE_MS) return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    shutdown(); // bridge child AND the LAN socket — a retired daemon must leave no listener behind
    activeBridgeShutdown = undefined;
    activeLanShutdown = undefined;
    activeLanListener = undefined;
    releaseSingleInstance(); // auto-quit on empty: drop our pidfile so the next hook re-spawns
  }
}

if (import.meta.main) {
  // BELT-AND-BRACES for the detached bridge work (and anything else that escapes a net's own catch): a
  // stray rejection must never take the daemon down. Node's default is to CRASH on an unhandled
  // rejection — which would kill every self-heal net over a transient Codex socket error — so we swallow
  // it and keep sweeping. Silence is the contract, so there is nothing to print.
  process.on("unhandledRejection", () => { /* keep sweeping */ });
  // Graceful stop. ensureWatchdog SIGTERMs a version-mismatched incumbent so the new build can take over,
  // and default SIGTERM handling would skip run()'s `finally` — leaving the pidfile CLAIMED by a dead pid
  // (a stale lock the successor then has to `ps`-disprove). Release it here, kick the bridge's child off
  // the same shutdown path, and give it a beat before exiting.
  const onTerminate = (): void => {
    try { releaseSingleInstance(); } catch { /* nothing to release */ }
    try { activeBridgeShutdown?.(); } catch { /* best-effort */ }
    try { activeLanShutdown?.(); } catch { /* best-effort */ }
    const exitTimer = setTimeout(() => process.exit(0), 250);
    (exitTimer as unknown as { unref?: () => void }).unref?.();
  };
  process.on("SIGTERM", onTerminate);
  process.on("SIGINT", onTerminate);
  try {
    await run();
  } catch {
    // Silence is the contract — this process must always die quietly.
  }
  process.exit(0);
}
