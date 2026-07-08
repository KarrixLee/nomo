// cc-watchdog — reaps Claude Code sessions whose terminal was force-killed (v2: pairing + E2E).
//
// The cc-status hook fires a SessionEnd on a clean exit, but closing a terminal kills `claude`
// with no hook at all — so the phone's Live Activity would keep showing that session "working"
// until the Worker's 30-min staleness eviction. This detached poller closes the gap in seconds:
// the hook records each session's `claude` pid (process.ppid) in ~/.config/cc-status/sessions/, and
// this process checks liveness with kill(pid,0) every few seconds, POSTing an op:end for any dead
// one. All corrective POSTs use the SAME v2 blind envelope + per-pairing headers as the hook.
//
// Contract — identical posture to cc-status.ts: NOTHING on stdout, swallow every error, never
// linger. Auto-exits when no sessions remain (the hook re-spawns it), single-instance via
// ~/.config/cc-status/watchdog.pid. PORTABLE: no `Bun.*` — file IO via node:fs/promises helpers.

import { readdir, readFile, unlink } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { encryptBlob } from "../core/crypto";
import { adapterFor } from "../core/adapter";
import {
  AgentKind, atomicWrite, CC_DIR, Config, completePendingPairing, GONE_STRIKE_LIMIT, loadConfig, loadPendingConfig,
  PairPollResult, PendingConfig, pidAlive, readSuffix, recordGoneStrike, removeRevokedConfig, resetGoneStrikes,
  SessionRecord, SESSIONS_DIR, WATCHDOG_PID_PATH,
} from "../core/shared";

// The transcript-tail interrupt PARSERS live in the agent adapters now (the two detections are
// structurally different). Re-export them so existing importers/tests that reference "./cc-watchdog"
// keep resolving lastTurnLine / hasInterruptMarker / codexLastTurnEvent.
export { codexLastTurnEvent, hasInterruptMarker, lastTurnLine } from "../core/adapter";

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
    ...(agent === "codex" ? { agent: "codex" as const } : {}),
    ...(typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {}),
  });
  return { v: 2, sessionId, op: "done", prio: 0, ts: now, blob, ...startedAtField(record) };
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
        if (shouldHeartbeat(record, now, heartbeatAt.get(sessionId), corrected === "corrected")) {
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
  try {
    while (true) {
      const config = await loadConfig(); // reload each cycle: a mid-pairing config may complete under us
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
      if (remaining === 0) return; // no sessions and no pending pairing → quit; the hook re-spawns us
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
