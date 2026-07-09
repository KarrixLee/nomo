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
//      the Worker's 30-min staleness eviction. The hook records each session's TUI pid (process.ppid)
//      in ~/.config/cc-status/sessions/; this process checks liveness with kill(pid,0) every few
//      seconds and POSTs an op:end for any dead one.
//   2. DISCOVER — Codex fires NO hook at session OPEN (its SessionStart fires only at the FIRST prompt,
//      openai/codex#15269), so a freshly-opened Codex TUI is invisible to the phone for 30 s+. Each
//      sweep asks every adapter to discover live sessions the hooks can't see yet
//      (adapter.discoverLive) and POSTs a PROVISIONAL op:start for each, reconciled away once the real
//      hook fires. Claude implements no discovery (its SessionStart fires at true open).
//
// All corrective/discovery POSTs use the SAME v2 blind envelope + per-pairing headers as the hook.
//
// Contract — identical posture to cc-status.ts: NOTHING on stdout, swallow every error, never linger
// needlessly. Single-instance via ~/.config/cc-status/watchdog.pid. It used to auto-exit the instant
// zero sessions remained; it now lingers IDLE_GRACE_MS between sessions so discovery can surface the
// NEXT freshly-opened Codex TUI instantly instead of waiting for a hook to re-spawn it.
// PORTABLE: no `Bun.*` — file IO via node:fs/promises helpers.

import { readdir, readFile, unlink } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import { encryptBlob } from "../core/crypto";
import { adapterFor, AgentAdapter, allAdapters, DiscoveredSession } from "../core/adapter";
import {
  AgentKind, atomicWrite, CC_DIR, Config, completePendingPairing, GONE_STRIKE_LIMIT, loadConfig, loadPendingConfig,
  PAIR_HTML_FILE, PairPollResult, PendingConfig, pidAlive, readSuffix, recordGoneStrike, removeRevokedConfig,
  resetGoneStrikes, SessionRecord, SESSIONS_DIR, WATCHDOG_PID_PATH,
} from "../core/shared";

// The transcript-tail interrupt PARSERS live in the agent adapters now (the two detections are
// structurally different). Re-export them so existing importers/tests that reference "./cc-watchdog"
// keep resolving lastTurnLine / hasInterruptMarker / codexLastTurnEvent.
export { codexLastTurnEvent, codexTailPendingApproval, hasInterruptMarker, lastTurnLine } from "../core/adapter";

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

export type SessionVerdict = "keep" | "end" | "delete";

/** Pure per-file decision. `end` → the process is gone: POST an op:end, then delete. `delete` →
 *  malformed or stale: just remove it (no POST). `keep` → still alive: leave it for next sweep.
 *  Staleness is checked before liveness so an abandoned file is always cleaned up. Liveness is an
 *  injected predicate, so this stays pure and testable without touching real processes. */
export function classifySession(record: SessionRecord | null, now: number, isAlive: (pid: number) => boolean): SessionVerdict {
  if (!record || typeof record.pid !== "number" || !Number.isFinite(record.pid)) return "delete";
  if (typeof record.ts !== "number" || now - record.ts > SESSION_STALE_MS) return "delete";
  return isAlive(record.pid) ? "keep" : "end";
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
 *  cached start when known (`record` omitted at the pure-reap call sites that have no record). */
export function buildEndEnvelope(sessionId: string, now: number, record?: SessionRecord): object {
  return { v: 2, sessionId, op: "end", prio: 0, ts: now, ...(record ? startedAtField(record) : {}) };
}

/** The interrupt-corrective envelope: a v2 op:done carrying a freshly-encrypted blob with status
 *  "done" and the record's machine/label (coerced to "" if a corrupt record dropped them). title is
 *  "" — the watchdog has no fresh transcript title, and a done frame doesn't need one. `agent`
 *  (defaulted to claude so the existing call sites/tests are byte-identical) restamps the blob's
 *  optional `agent:"codex"` key so a corrective done matches what the hook would have sent. The
 *  record's cached `turnStartedAt` (epoch seconds, stamped by the turn's UserPromptSubmit) is
 *  likewise restamped into the rebuilt blob — omitted when unknown — so the island's frozen
 *  "done in Xm" keeps measuring the TURN, exactly as a hook-built done blob would. */
export async function buildDoneEnvelope(sessionId: string, record: SessionRecord, now: number, e2eKey: Uint8Array, agent: AgentKind = "claude"): Promise<object> {
  const blob = await encryptBlob(e2eKey, {
    status: "done",
    title: "",
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    // Per-agent blob identity comes from the adapter (no inline `agent === …` branch in the daemon).
    ...adapterFor(agent).blobAgentFields,
    ...(typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {}),
  });
  return { v: 2, sessionId, op: "done", prio: 0, ts: now, blob, ...startedAtField(record) };
}

/** The pending-approval corrective envelope: a v2 op:update / prio 1 carrying a freshly-encrypted blob
 *  with status "needsAttention" — the SAME op/prio/status a real PermissionRequest hook would send (see
 *  hook.ts planOp: PermissionRequest → {op:update, prio:1, status:needsAttention}). title is "" (the
 *  watchdog has no fresh transcript title, and the phone shows the last-known title anyway), machine/
 *  label come from the record (coerced to "" if a corrupt record dropped them), `agent` restamps the
 *  blob's optional agent:"codex" via the adapter seam, and the record's cached `turnStartedAt` is
 *  restamped so the island timer keeps measuring the same turn — exactly as buildDoneEnvelope does. */
export async function buildNeedsAttentionEnvelope(sessionId: string, record: SessionRecord, now: number, e2eKey: Uint8Array, agent: AgentKind = "claude"): Promise<object> {
  const blob = await encryptBlob(e2eKey, {
    status: "needsAttention",
    title: "",
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    // Per-agent blob identity comes from the adapter (no inline `agent === …` branch in the daemon).
    ...adapterFor(agent).blobAgentFields,
    ...(typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {}),
  });
  return { v: 2, sessionId, op: "update", prio: 1, ts: now, blob, ...startedAtField(record) };
}

/** The staleness-heartbeat envelope: re-send the record's stored blob verbatim under its stored
 *  op/prio with a fresh ts, so the worker re-pushes the SAME content-state and re-arms its stale-date
 *  without any state change. Null when the record carries no blob (a pre-v2 record) — nothing to
 *  re-send, so the session simply isn't heartbeated. */
export function buildHeartbeatEnvelope(sessionId: string, record: SessionRecord, now: number): object | null {
  if (typeof record.blob !== "string" || record.blob.length === 0) return null;
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

/** POST a v2 envelope to the Worker with the per-pairing auth headers. `delivered` ONLY on a 2xx:
 *  a 401/500 is a FAILURE, not success — otherwise a bad secret or a Worker error would count as
 *  delivered and the caller would delete/rewrite the session file, losing the session. A 404 is
 *  `revoked` (the definitive pairing-is-gone signal, keyed on the server's own not-found response).
 *  Any network error / timeout is a transient `failed`. Best-effort: never throws across its boundary. */
async function postEvent(config: Config, body: object): Promise<PostOutcome> {
  try {
    const res = await fetch(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    return postOutcomeForStatus(res.status);
  } catch {
    return "failed";
  }
}

// --- Live session discovery (surfacing a session before its first hook) -----------------------
//
// Codex fires no hook at session OPEN (openai/codex#15269), so the daemon asks every adapter to
// discover live TUIs the hooks can't see yet (adapter.discoverLive; Claude implements none) and POSTs
// a PROVISIONAL op:start for each — mirroring the blob a real SessionStart would send — plus a
// provisional session record so the reap/reconcile machinery can retire it. Claude's discoverLive is
// absent, so this whole step no-ops for Claude; Codex's is a stub until the feature commit.

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
 *  SessionStart (status "working", title/machine/label, the adapter's `agent` field; no detail, no
 *  turnStartedAt because a freshly-opened TUI has neither a tool nor a prompt yet). */
export async function buildProvisionalBlob(
  d: DiscoveredSession, machine: string, blobAgentFields: { agent?: AgentKind }, e2eKey: Uint8Array,
): Promise<string> {
  return encryptBlob(e2eKey, { status: "working", title: d.title ?? "", machine, label: d.label, ...blobAgentFields });
}

/** The provisional op:start envelope — the same v2 shape the hook POSTs for a real SessionStart. */
export function buildStartEnvelope(sessionId: string, blob: string, now: number): object {
  return { v: 2, sessionId, op: "start", prio: 0, ts: now, blob };
}

/** The provisional session record the discovery step persists (0600) so the daemon can reap it on pid
 *  death and the hook (or the sweep backstop) can reconcile it away. `provisional:true` is what marks
 *  it; `pid` is the discovered TUI process; agent rides via the adapter's blobAgentFields (omitted for
 *  claude), keeping this free of an inline `agent === …` branch. lastEvent/op mirror trackSession's
 *  fresh-start bookkeeping so a heartbeat/reap treats it like any other start. */
export function buildProvisionalRecord(
  d: DiscoveredSession, machine: string, blob: string, blobAgentFields: { agent?: AgentKind }, now: number,
): SessionRecord {
  return {
    pid: d.pid,
    machine,
    label: d.label,
    ts: now,
    lastEvent: "sessionStart",
    op: "start",
    prio: 0,
    blob,
    provisional: true,
    ...blobAgentFields,
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
 *  can't see yet as PROVISIONAL sessions. Each new one is POSTed as an op:start; only on a delivered
 *  POST do we persist the provisional record (so a failed POST simply retries next sweep — the pid is
 *  still not "known"). Best-effort throughout: a discoverLive throw or a POST failure never derails the
 *  sweep. No-ops entirely when no adapter implements discoverLive (Claude) or none is found (Codex idle). */
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
      const blob = await buildProvisionalBlob(d, machine, adapter.blobAgentFields, config.e2eKey);
      const outcome = await post(buildStartEnvelope(d.sessionId, blob, ts));
      if (outcome !== "delivered") continue; // failed/revoked → retry next sweep, don't persist a ghost
      await writeRecord(d.sessionId, buildProvisionalRecord(d, machine, blob, adapter.blobAgentFields, ts));
    }
  }
}

/** The sentinel ids of PROVISIONAL records whose pid is now also held by a REAL (non-provisional) codex
 *  record — i.e. the real hook fired but the hook's own reconcile didn't run (unpaired at hook time, or
 *  a race). Equality on pid: a real codex record's pid and its provisional's pid are the same codex TUI
 *  process. Pure. */
export function provisionalsCoveredByReal(entries: RecordEntry[]): string[] {
  const realCodexPids = new Set(
    entries
      .filter((e) => e.rec.provisional !== true && e.rec.agent === "codex" && typeof e.rec.pid === "number")
      .map((e) => e.rec.pid),
  );
  return entries
    .filter((e) => e.rec.provisional === true && typeof e.rec.pid === "number" && realCodexPids.has(e.rec.pid))
    .map((e) => e.sessionId);
}

/** Injectable seams for the sweep-side provisional reconcile, so it's testable without fs/network. */
export interface SweepReconcileDeps {
  post?: (body: object) => Promise<PostOutcome>;
  readEntries?: () => Promise<RecordEntry[]>;
  deleteRecord?: (sessionId: string) => Promise<void>;
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
  for (const sessionId of provisionalsCoveredByReal(entries)) {
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

/** The interrupt recovery net for one still-alive session. Gated by shouldInterruptCheck, then it
 *  tails the transcript and, if the last real turn line reads "interrupted by user", POSTs a
 *  corrective op:done. On a 2xx it rewrites the session file with lastEvent:"done" + sentDone:true so
 *  the net can't re-fire and the next hook re-arms correctly. A non-2xx / network failure leaves the
 *  file untouched for the next sweep. Returns:
 *   - "corrected"   → it POSTed a done this sweep → the session is effectively done, so the caller
 *                     must NOT also heartbeat it.
 *   - "uncorrected" → nothing to do (gate closed, no interrupt, or a transient failed POST).
 *   - "revoked"     → the POST 404'd: the pairing is gone server-side → the caller tears down. */
async function correctInterrupt(config: Config, path: string, sessionId: string, record: SessionRecord, now: number): Promise<"corrected" | "uncorrected" | "revoked"> {
  try {
    if (!shouldInterruptCheck(record, now)) return "uncorrected";
    let tail: string;
    try {
      tail = await readSuffix(record.transcript as string, INTERRUPT_TAIL_BYTES);
    } catch {
      // Transcript missing / unreadable → nothing to check. For codex this also covers a cold rollout
      // that was compressed to `.jsonl.zst` (the plain path is deleted): readSuffix's stat() ENOENTs,
      // we land here, and the session is simply left for its dead-pid reap / staleness eviction.
      return "uncorrected";
    }
    const agent: AgentKind = record.agent === "codex" ? "codex" : "claude";
    if (!tailShowsInterrupt(tail, agent)) return "uncorrected"; // live turn or no interrupt → leave it
    const outcome = await postEvent(config, await buildDoneEnvelope(sessionId, record, Date.now(), config.e2eKey, agent));
    if (outcome === "revoked") return "revoked"; // pairing gone → bubble up so the loop can tear down
    if (outcome !== "delivered") return "uncorrected"; // failed POST → keep the file, retry next sweep
    // 2xx: pin the session done so the gate skips it and the next hook re-arms from a done.
    try {
      const next: SessionRecord = { ...record, lastEvent: "done", sentDone: true, op: "done" };
      // Owner-only (0600), same as the hook's trackSession — the record holds hostname, cwd basename,
      // the session pid, and the absolute transcript path; the rewrite must not widen its permissions.
      await atomicWrite(path, JSON.stringify(next), 0o600);
    } catch {
      // Rewrite failed — worst case the net re-POSTs a done next sweep, which the worker drops.
    }
    return "corrected"; // corrected this sweep → caller must skip the heartbeat for this session
  } catch {
    return "uncorrected";
  }
}

// --- Pending-approval recovery net (dropped Codex PermissionRequest backstop) -----------------
//
// On Codex, needsAttention hangs off ONE thread: the plugin's PermissionRequest hook. Codex has no
// upstream Notification event and is known to silently drop lifecycle hooks (openai/codex#16430); when
// that hook drops, the phone never learns the session is blocked on an approval — the notify backstop
// only synthesizes a `done` at TURN END. This net mirrors the interrupt-recovery one: it asks the
// session's adapter (record.agent, absent → claude) whether the rollout tail shows a PENDING approval
// (adapter.tailShowsPendingApproval; Claude implements none) and, if so, POSTs the same needsAttention
// envelope a real PermissionRequest would have. See adapter.ts codexTailPendingApproval for the
// classifier and its rollout-persistence caveat.

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
async function correctPendingApproval(config: Config, path: string, sessionId: string, record: SessionRecord, now: number): Promise<"corrected" | "uncorrected" | "revoked"> {
  try {
    const agent: AgentKind = record.agent === "codex" ? "codex" : "claude";
    const adapter = adapterFor(agent);
    if (!shouldPendingApprovalCheck(record, adapter)) return "uncorrected";
    let tail: string;
    try {
      tail = await readSuffix(record.transcript as string, INTERRUPT_TAIL_BYTES);
    } catch {
      return "uncorrected"; // transcript missing / cold-compressed → nothing to check
    }
    if (!adapter.tailShowsPendingApproval!(tail)) return "uncorrected"; // no pending approval → leave it
    const outcome = await postEvent(config, await buildNeedsAttentionEnvelope(sessionId, record, Date.now(), config.e2eKey, agent));
    if (outcome === "revoked") return "revoked"; // pairing gone → bubble up so the loop can tear down
    if (outcome !== "delivered") return "uncorrected"; // failed POST → keep the file, retry next sweep
    // 2xx: pin the session needsAttention so this net fires once per episode and the interrupt-net
    // watches it. sentDone:false so a later re-arm behaves like a live session, not a re-armed done.
    try {
      const next: SessionRecord = { ...record, lastEvent: "needsAttention", op: "update", prio: 1, sentDone: false };
      // Owner-only (0600), like the hook's trackSession / the interrupt net's rewrite — the record holds
      // hostname, cwd basename, the session pid, and the absolute transcript path.
      await atomicWrite(path, JSON.stringify(next), 0o600);
    } catch {
      // Rewrite failed — worst case the net re-POSTs a needsAttention next sweep, which the worker drops.
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
  if (correctedThisSweep) return false;
  if (typeof record.ts !== "number") return false;
  if (now - record.ts < HEARTBEAT_AFTER_MS) return false; // still inside the hook cadence → skip
  if (lastHeartbeat !== undefined && now - lastHeartbeat < HEARTBEAT_AFTER_MS) return false; // throttled
  return true;
}

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
async function sweep(config: Config | null): Promise<SweepResult> {
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
    if (verdict === "keep") {
      remaining++;
      if (config && record) {
        // Ordering is the guardrail: run the interrupt-recovery net FIRST. If it corrected the turn
        // (POSTed a done), the session is effectively done, so we must NOT also heartbeat it — the
        // returned flag carries that. Only a clean, alive, quiet, uncorrected session gets a
        // heartbeat, which re-sends its last blob to re-arm the island's stale-date.
        const corrected = await correctInterrupt(config, path, sessionId, record, now);
        if (corrected === "revoked") return { revoked: true }; // gone this POST → gated teardown in run()
        if (corrected === "corrected") delivered = true; // it POSTed a done → a 2xx landed
        // Pending-approval backstop: only if the interrupt-net didn't just finish the turn. Re-raises
        // needsAttention when a DROPPED Codex PermissionRequest (openai/codex#16430) left the session
        // silently blocked. Claude's adapter offers no classifier, so this no-ops for Claude records.
        let flaggedAttention = false;
        if (corrected !== "corrected") {
          const attn = await correctPendingApproval(config, path, sessionId, record, now);
          if (attn === "revoked") return { revoked: true };
          if (attn === "corrected") { delivered = true; flaggedAttention = true; }
        }
        if (shouldHeartbeat(record, now, heartbeatAt.get(sessionId), corrected === "corrected" || flaggedAttention)) {
          const beat = buildHeartbeatEnvelope(sessionId, record, Date.now());
          // delivered only: a failed heartbeat mutates NOTHING (not the record, not even the throttle),
          // so quietness stays true and it's retried next sweep. A record with no stored blob yields
          // a null envelope — nothing to send, so it simply isn't heartbeated.
          if (beat) {
            const outcome = await postEvent(config, beat);
            if (outcome === "revoked") return { revoked: true };
            if (outcome === "delivered") { heartbeatAt.set(sessionId, now); delivered = true; }
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
    heartbeatAt.delete(sessionId); // session is being removed → drop its throttle entry
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

/** Claim the single-instance pidfile. Returns false if another *live* watchdog already holds it
 *  (its pid is alive and isn't us), so this instance can exit immediately. */
async function claimSingleInstance(): Promise<boolean> {
  try {
    const holder = Number.parseInt(readFileSync(WATCHDOG_PID_PATH, "utf8").trim(), 10);
    if (Number.isFinite(holder) && holder !== process.pid && pidAlive(holder)) return false;
  } catch {
    // No pidfile (or unreadable) → free to claim.
  }
  await atomicWrite(WATCHDOG_PID_PATH, String(process.pid));
  return true;
}

/** Release the pidfile only if we still own it, so we never stomp a successor's claim. */
function releaseSingleInstance(): void {
  try {
    const holder = Number.parseInt(readFileSync(WATCHDOG_PID_PATH, "utf8").trim(), 10);
    if (holder === process.pid) unlinkSync(WATCHDOG_PID_PATH);
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
  try {
    while (true) {
      const config = await loadConfig(); // reload each cycle: a mid-pairing config may complete under us
      // Discovery + reconcile run BEFORE the sweep (only when paired). Backstop-reconcile first (retire
      // any provisional whose real session already reported), then discover new TUIs — so a just-
      // surfaced provisional is counted in `remaining` this same cycle, keeping the daemon alive
      // naturally while a discovered TUI lives.
      if (config) {
        await reconcileProvisionalsSweep(config);
        await discoverLiveSessions(config);
      }
      const result = await sweep(config);
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
        if (pending) {
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
    releaseSingleInstance(); // auto-quit on empty: drop our pidfile so the next hook re-spawns
  }
}

if (import.meta.main) {
  try {
    await run();
  } catch {
    // Silence is the contract — this process must always die quietly.
  }
  process.exit(0);
}
