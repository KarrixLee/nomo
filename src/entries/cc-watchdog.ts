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
import { readFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import { encryptBlob } from "../core/crypto";
import { adapterFor, AgentAdapter, allAdapters, codexAdapter, DiscoveredSession } from "../core/adapter";
import {
  AgentKind, atomicWrite, CC_DIR, CCOp, CCStatus, Config, completePendingPairing, GONE_STRIKE_LIMIT, loadConfig, loadPendingConfig,
  PAIR_HTML_FILE, PairPollResult, PendingConfig, pidAlive, PLUGIN_VERSION, readPrefix, readSuffix, recordGoneStrike, removeRevokedConfig,
  resetGoneStrikes, SessionRecord, SESSIONS_DIR, WATCHDOG_PID_PATH,
} from "../core/shared";

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
  if (now - record.ts > SESSION_STALE_MS) return "stale"; // abandoned (24 h): POST a terminal end, then delete
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
 *  the record's cached last non-empty title (the hook stamps it on every emit) — the watchdog has no
 *  fresh transcript to scan, and re-pushing title:"" made the phone regress to the folder-name label;
 *  "" only when no title was ever resolved. `agent`
 *  (defaulted to claude so the existing call sites/tests are byte-identical) restamps the blob's
 *  optional `agent:"codex"` key so a corrective done matches what the hook would have sent. The
 *  record's cached `turnStartedAt` (epoch seconds, stamped by the turn's UserPromptSubmit) is
 *  likewise restamped into the rebuilt blob — omitted when unknown — so the island's frozen
 *  "done in Xm" keeps measuring the TURN, exactly as a hook-built done blob would. */
export async function buildDoneEnvelope(sessionId: string, record: SessionRecord, now: number, e2eKey: Uint8Array, agent: AgentKind = "claude"): Promise<object> {
  const blob = await encryptBlob(e2eKey, {
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
  });
  return { v: 2, sessionId, op: "done", prio: 0, ts: now, blob, ...startedAtField(record) };
}

/** The pending-approval corrective envelope: a v2 op:update / prio 1 carrying a freshly-encrypted blob
 *  with status "needsAttention" — the SAME op/prio/status a real PermissionRequest hook would send (see
 *  hook.ts planOp: PermissionRequest → {op:update, prio:1, status:needsAttention}). title is the
 *  record's cached last non-empty title (see buildDoneEnvelope — a rebuilt title:"" regressed the
 *  phone to the folder-name label), machine/
 *  label come from the record (coerced to "" if a corrupt record dropped them), `agent` restamps the
 *  blob's optional agent:"codex" via the adapter seam, and the record's cached `turnStartedAt` is
 *  restamped so the island timer keeps measuring the same turn — exactly as buildDoneEnvelope does. */
export async function buildNeedsAttentionEnvelope(sessionId: string, record: SessionRecord, now: number, e2eKey: Uint8Array, agent: AgentKind = "claude"): Promise<object> {
  const blob = await encryptBlob(e2eKey, {
    status: "needsAttention",
    title: typeof record.title === "string" ? record.title : "",
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    // Per-agent blob identity comes from the adapter (no inline `agent === …` branch in the daemon).
    ...adapterFor(agent).blobAgentFields,
    ...(typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {}),
    // The record's cached model id, restamped exactly as buildDoneEnvelope does (omitted when absent).
    ...(typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {}),
  });
  return { v: 2, sessionId, op: "update", prio: 1, ts: now, blob, ...startedAtField(record) };
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
        "x-cc-version": PLUGIN_VERSION,
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
  d: DiscoveredSession, machine: string, blobAgentFields: { agent?: AgentKind }, e2eKey: Uint8Array,
): Promise<string> {
  return encryptBlob(e2eKey, { status: d.idle === true ? "done" : "working", title: d.title ?? "", machine, label: d.label, ...blobAgentFields });
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
    ...(typeof d.title === "string" && d.title.length > 0 ? { title: d.title } : {}),
    ...blobAgentFields,
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
      const blob = await buildProvisionalBlob(d, machine, adapter.blobAgentFields, config.e2eKey);
      const outcome = await post(buildProvisionalEnvelope(d.sessionId, blob, ts, idle));
      if (outcome !== "delivered") continue; // failed/revoked → retry next sweep, don't persist a ghost
      await writeRecord(d.sessionId, buildProvisionalRecord(d, machine, blob, adapter.blobAgentFields, ts, config.pairingId, idle));
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
    const outcome = await postEvent(config, await buildDoneEnvelope(sessionId, record, Date.now(), config.e2eKey, agent));
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

// --- Idle-CLAUDE reap (a resumed session left alive-but-silent, no Stop ever coming) ----------
//
// Claude Desktop resumes an old session with `claude --resume <id> --replay-user-messages` and keeps the
// process RESIDENT while idle: its SessionStart fires (re-arming the session to "working"), no turn
// follows, and NO Stop ever comes. The dead-pid reaper can't help — the pid is alive — and the PID-gated
// heartbeat below deliberately defeats the worker's 30-min eviction, so the phone would show that session
// "working" FOREVER. This net closes the gap from the one side that knows the turn is over: event-silence.
// When a tracked CLAUDE session has gone event-idle past a generous grace with its pid still alive, it
// gets ONE corrective op:done (the SAME envelope the interrupt net posts) and its record is pinned done —
// re-arming on the session's next real hook exactly like the interrupt net's done.

/** How long a CLAUDE session may sit event-idle (no REAL hook since record.ts — a heartbeat never rewrites
 *  it) while its pid is alive before the watchdog reaps it with a corrective done. 30 min sits FAR above
 *  any legitimate mid-turn hook gap: tool hooks fire constantly during real work and even a single long
 *  Bash maxes ~10 min, so a 30-min silence means the turn is genuinely over (a resumed-but-idle session,
 *  or a long-finished one whose Stop was dropped). Deliberately ≫ HEARTBEAT_AFTER_MS (5 min): the 5–30 min
 *  window is still heartbeated "working" (a legitimate long tool run / subagent / permission wait), and
 *  only past 30 min does the reap take over. */
const CLAUDE_IDLE_REAP_MS = 1_800_000; // 30 min

/** Whether a KEPT (alive) session is an idle CLAUDE session past the reap threshold — the shared predicate
 *  the reap net and the heartbeat guard BOTH key on, so the two always agree (a session the reaper wants to
 *  finish is never simultaneously heartbeated back to "working"). True iff: it's a Claude session (codex has
 *  its own discovery / idle-provisional + notify-backstop machinery, so it's left to those), not a
 *  provisional discovery row, its last REAL event was a plain `working` update or a bare `sessionStart` (a
 *  resumed session that fired SessionStart then nothing — never `needsAttention`, which can legitimately sit
 *  >30 min awaiting a permission answer, nor `done`, already finished), and record.ts is older than
 *  CLAUDE_IDLE_REAP_MS. Pure so the whole matrix is unit-testable. */
export function isClaudeIdleReapEligible(record: SessionRecord, now: number): boolean {
  if (record.agent === "codex") return false;
  if (record.provisional === true) return false;
  if (record.lastEvent !== "working" && record.lastEvent !== "sessionStart") return false;
  if (typeof record.ts !== "number") return false;
  return now - record.ts >= CLAUDE_IDLE_REAP_MS;
}

/** The idle-CLAUDE reap for one still-alive session. Gated by isClaudeIdleReapEligible, then it POSTs a
 *  corrective op:done rebuilt from the record's cached title/machine/label (buildDoneEnvelope — the SAME
 *  envelope the interrupt net posts) and pins the record done so this fires once and the heartbeat treats
 *  it as finished. A resumed-but-idle session (SessionStart then silence) falls out through here. On the
 *  next real hook the pinned sentDone re-arms the session to working, just like the interrupt net's done.
 *  Returns the same verdict triple as the other nets ("corrected" → the caller must not also heartbeat it). */
async function correctIdleClaude(config: Config, path: string, sessionId: string, record: SessionRecord, now: number): Promise<"corrected" | "uncorrected" | "revoked"> {
  try {
    if (!isClaudeIdleReapEligible(record, now)) return "uncorrected";
    // Claude-only by the gate above, so the corrective done carries the claude blob shape (no agent key).
    const outcome = await postEvent(config, await buildDoneEnvelope(sessionId, record, Date.now(), config.e2eKey, "claude"));
    if (outcome === "revoked") return "revoked"; // pairing gone → bubble up so the loop can tear down
    if (outcome !== "delivered") return "uncorrected"; // failed POST → keep the file, retry next sweep
    // 2xx: pin the session done so the gate closes and the heartbeat can never re-arm "working"; the next
    // real hook re-arms from a done exactly as the interrupt net's rewrite does.
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
  sessionId: string, record: SessionRecord, title: string, now: number, e2eKey: Uint8Array, agent: AgentKind = "codex",
): Promise<{ v: 2; sessionId: string; op: CCOp; prio: 0 | 1; ts: number; blob: string; startedAt?: number }> {
  const blob = await encryptBlob(e2eKey, {
    status: statusFromRecord(record),
    title,
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    ...adapterFor(agent).blobAgentFields,
    ...(typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {}),
    ...(typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {}),
  });
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
    const envelope = await buildTitleRepairEnvelope(sessionId, record, title, Date.now(), config.e2eKey, "codex");
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
        // Idle-provisional corrective FIRST: a discovery row advertised "working" whose TUI has gone
        // idle gets its one op:done before anything else could heartbeat the stale working blob.
        // Gated to provisional records of a probe-capable agent (codex); everything else no-ops.
        const idleFix = await correctIdleProvisional(config, path, sessionId, record);
        if (idleFix === "revoked") return { revoked: true };
        if (idleFix === "corrected") delivered = true; // it POSTed a done → a 2xx landed
        // Ordering is the guardrail: run the interrupt-recovery net next. If either net corrected the
        // session (POSTed a done), it is effectively done, so we must NOT also heartbeat it — the
        // returned flags carry that. Only a clean, alive, quiet, uncorrected session gets a
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
        // Idle-CLAUDE reap: a resumed-but-idle Claude session (working/sessionStart then ≥30 min of
        // silence, pid still alive, no Stop ever coming) gets ONE corrective done instead of being
        // heartbeated "working" forever. Only if no earlier net already finished the turn this sweep;
        // Claude-only (isClaudeIdleReapEligible gates codex out — it has discovery + the notify backstop).
        let reapedIdle = false;
        if (idleFix !== "corrected" && corrected !== "corrected" && !flaggedAttention) {
          const idleClaude = await correctIdleClaude(config, path, sessionId, record, now);
          if (idleClaude === "revoked") return { revoked: true };
          if (idleClaude === "corrected") { delivered = true; reapedIdle = true; }
        }
        // Codex title-repair: heal a session that shipped title:"" from a SessionStart and then had every
        // later hook dropped (openai/codex#16430) — by sweep time the session_index thread_name / rollout
        // user_message are on disk. Only when nothing else corrected this sweep (a done row with a blank
        // title is fixed on a later sweep, since the record persists); no-ops for claude / titled records.
        let repairedTitle = false;
        if (idleFix !== "corrected" && corrected !== "corrected" && !flaggedAttention && !reapedIdle) {
          const titleFix = await repairTitle(config, path, sessionId, record);
          if (titleFix === "revoked") return { revoked: true };
          if (titleFix === "corrected") { delivered = true; repairedTitle = true; }
        }
        if (shouldHeartbeat(record, now, heartbeatAt.get(sessionId), idleFix === "corrected" || corrected === "corrected" || flaggedAttention || reapedIdle || repairedTitle)) {
          const beat = buildHeartbeatEnvelope(sessionId, record, Date.now(), config.pairingId);
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
