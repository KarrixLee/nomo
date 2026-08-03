// session-state — the Mac's DISPLAY-STATE machine (LAN status v2, NOM-47 phase A).
//
// WHAT IT IS: one pure function, `computeSessionState`, that takes every input this machine holds about
// ONE session and returns the single state the phone should render — not an event, not a frame, a state.
// It is the whole of v2's thesis: the Mac owns strictly more information than the worker (record + hold
// marker + holder-pid liveness + session-pid liveness + CC's own session file + the watchdog's own
// pre-delivery correctives), so the Mac decides, and the LAN feed ships complete snapshots of that
// decision. Nothing downstream arbitrates, because there is nothing left to order.
//
// WHY IT IS ITS OWN MODULE rather than more of lan-frames.ts: lan-frames is the FEED — a directory
// watcher, a waiter list, a counter, a retire grace. This is the RULE, and the rule has to be readable
// and exhaustively testable without any of that machinery. The watchdog's own nets are the second
// consumer (phase C feeds their pre-delivery conclusions in through `correctives`), and a pure module is
// what lets both call it without one importing the other's IO.
//
// PURE: no filesystem, no clock, no process probes. Every liveness fact arrives as a boolean the caller
// already established, so a test states the world instead of building one.
//
// THE `why` CODE is not decoration. Every returned state names the input that decided it, and that name
// rides the wire (`why`) into the phone's debug line. A user staring at a wrong row learns WHICH input
// was wrong, which is the diagnostic v1 never had — `lan:s64 43.4s · w:held 1m` told you the counter and
// the decay, i.e. two numbers about the transport and nothing about the status.

import { adapterFor } from "./adapter";
import { appendFittedPlanAndDebug, formatPlanPickerDebug } from "./shared";
import type { AgentKind, CCStatus, DecisionHold, SessionRecord } from "./shared";

/** The 24 h abandonment cap — cc-watchdog's SESSION_STALE_MS, mirrored (an entry module must not be
 *  imported from core/). Past it the sweep retires the record; rank 1 calls the session ended at the
 *  same moment so the phone never sees a live row the sweep has given up on. */
export const SESSION_STATE_STALE_MS = 86_400_000;

/** The hard ceiling on a hold marker. Identical to lan-frames' LAN_HOLD_MAX_AGE_MS and kept here so the
 *  rule module has no import from the feed module; the feed re-exports the name it always exported.
 *  10 min mirrors the worker's decision-poll key TTL (DECPOLL_TTL_SECONDS) — the same "no hook can still
 *  be polling for this" bound expressed server-side. */
export const STATE_HOLD_MAX_AGE_MS = 600_000;

// --- CC's own session file (~/.claude/sessions/<pid>.json) --------------------------------------
//
// Verified present on CC 2.1.220. A real row off this machine, verbatim:
//
//   {"pid":4391,"sessionId":"996bca26-…","cwd":"/Users/karrix/api-status","startedAt":1785615095362,
//    "procStart":"Sat Aug  1 20:11:34 2026","version":"2.1.220","peerProtocol":1,"kind":"interactive",
//    "entrypoint":"cli","name":"api-status-53","nameSource":"derived","status":"idle",
//    "updatedAt":1785673169315,"statusUpdatedAt":1785673169315}
//
// TREAT AS UNDOCUMENTED AND UNVERSIONED. Every rule below degrades to today's behaviour when the input
// is absent or unusable, and there is NO rule for which this file is the sole evidence: it can only
// (a) hold back a `done`, (b) advance a stale `working` to `done`, or (c) supply a fallback title. It
// never creates a row, never overrides a live hold, and never contributes to rank 1 or 2.
//
// CONSUMED BY PER-FIELD SHAPE CHECKS, NOT A `version` ALLOW-LIST (the spec's open question 1, decided).
// Pinning a major would lose the feature on every CC release until someone re-tested it, and a plugin
// that silently drops a feature on a routine `claude` upgrade is worse than one whose per-field gates
// degrade a field at a time. Each field below is checked for the exact shape it is used at; anything
// else reads as absent, which is always "no opinion", never a default.

/** The file's fields, as far as we consume them. Every one optional except the two JOIN KEYS. */
export interface CcSessionFile {
  /** The `claude` process. Must equal both the filename's `<pid>` and the nomo record's `pid`. */
  pid: number;
  /** CC's own session id. Must equal the nomo session id. */
  sessionId: string;
  cwd?: string;
  /** Epoch ms, ≈ process birth + 1 s (verified: procStart 20:11:34, startedAt …095362 = 20:11:35.362). */
  startedAt?: number;
  /** UTC-RENDERED process birth. See parseCcProcStart — NEVER string-compare this against `ps`. */
  procStart?: string;
  version?: string;
  kind?: string;
  /** `"cli"` on interactive rows, `"sdk-cli"` on the rows that carry no `status` at all. */
  entrypoint?: string;
  /** CC's derived session name — the rank-4 fallback label. */
  name?: string;
  nameSource?: string;
  /** `"busy"` | `"idle"`, and ABSENT on sdk-cli rows. Absence means no opinion, never idle. */
  status?: string;
  updatedAt?: number;
  /** When `status` was last written. Verified to go DAYS stale on a live pid — see CC_STATUS_MAX_AGE_MS. */
  statusUpdatedAt?: number;
}

/** How old CC's `status` may be before we stop believing it. VERIFIED TRAP: a live pid whose last status
 *  write was three days old — the file is not a heartbeat, it is written when the status CHANGES, and a
 *  session parked at a prompt stops changing. 10 min is comfortably past any real tool call while being
 *  far short of "this process has been sitting here since yesterday". */
export const CC_STATUS_MAX_AGE_MS = 600_000;

/** How far ahead of our clock a `statusUpdatedAt` may sit before it reads as unusable. CC and this
 *  daemon share a wall clock, so anything meaningfully in the future is a corrupt/foreign write. */
const CC_STATUS_FUTURE_SKEW_MS = 5_000;

/** How far the file's claimed process start may sit from the probed one and still be the SAME process.
 *  Both ends round: `procStart` and `ps -o lstart=` are whole seconds, and `startedAt` is written about
 *  a second after the fork. 5 s absorbs both roundings while staying far below the gap that a RECYCLED
 *  pid (a different process, minutes or hours later) would show. */
export const CC_PROC_START_TOLERANCE_MS = 5_000;

/** How far past the record's own `ts` CC's idle must sit before it may advance a `working` row to
 *  `done`. It guards the one race that matters: a CC status write landing microseconds before a hook's
 *  record write describing the work that just started. 3 s is one reconcile pass' worth of slack, and it
 *  replaces the interrupt net's 20 s WORKING_STALE_MS wait — the whole point is being seconds earlier. */
export const CC_IDLE_DONE_GRACE_MS = 3_000;

/** Month abbreviations in the order `procStart` renders them (C locale, which is what CC emits). */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parse CC's `procStart` — `"Sat Aug  1 20:11:34 2026"` — to epoch ms, interpreting it as **UTC**.
 *
 *  THE TRAP, field-verified on this machine (TZ +08) with a live pid:
 *
 *      ~/.claude/sessions/4391.json   procStart  "Sat Aug  1 20:11:34 2026"
 *      ps -o lstart= -p 4391                     "Sun  2 Aug 04:11:34 2026"
 *
 *  Same process. CC renders UTC; every macOS tool renders local. A string compare fails on every machine
 *  that is not on UTC, and `Date.parse` on the CC string is WORSE than useless because it silently reads
 *  it as local time and yields an epoch 8 h off — which then "matches" nothing and quietly disables the
 *  feature, or worse, matches a genuinely different process. So this parses the components explicitly
 *  and assembles them with Date.UTC. Never Date.parse, never a string compare.
 *
 *  Undefined for anything that is not exactly this shape — an unrecognised rendering is no evidence. */
export function parseCcProcStart(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(value);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return undefined;
  const day = Number(m[2]);
  const utc = Date.UTC(Number(m[6]), month, day, Number(m[3]), Number(m[4]), Number(m[5]));
  if (!Number.isFinite(utc)) return undefined;
  // Reject a day that rolled over (e.g. "Feb 31" → Mar 3): a nonsense date is not evidence.
  return new Date(utc).getUTCDate() === day ? utc : undefined;
}

/** Shape-check one `~/.claude/sessions/<pid>.json`. PER-FIELD, silent degrade: a field of the wrong
 *  type is simply not carried, and the two join keys are the only ones whose absence voids the file
 *  (without them there is nothing to join, so there is nothing to trust). No `version` gate — see the
 *  section header. Never throws. */
export function parseCcSessionFile(raw: string): CcSessionFile | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const f = parsed as Record<string, unknown>;
  if (typeof f.pid !== "number" || !Number.isFinite(f.pid)) return null;
  if (typeof f.sessionId !== "string" || f.sessionId.length === 0) return null;
  const str = (key: string): string | undefined =>
    typeof f[key] === "string" && (f[key] as string).length > 0 ? (f[key] as string) : undefined;
  const num = (key: string): number | undefined =>
    typeof f[key] === "number" && Number.isFinite(f[key] as number) ? (f[key] as number) : undefined;
  return {
    pid: f.pid,
    sessionId: f.sessionId,
    ...(str("cwd") ? { cwd: str("cwd") } : {}),
    ...(num("startedAt") !== undefined ? { startedAt: num("startedAt") } : {}),
    ...(str("procStart") ? { procStart: str("procStart") } : {}),
    ...(str("version") ? { version: str("version") } : {}),
    ...(str("kind") ? { kind: str("kind") } : {}),
    ...(str("entrypoint") ? { entrypoint: str("entrypoint") } : {}),
    ...(str("name") ? { name: str("name") } : {}),
    ...(str("nameSource") ? { nameSource: str("nameSource") } : {}),
    ...(str("status") ? { status: str("status") } : {}),
    ...(num("updatedAt") !== undefined ? { updatedAt: num("updatedAt") } : {}),
    ...(num("statusUpdatedAt") !== undefined ? { statusUpdatedAt: num("statusUpdatedAt") } : {}),
  };
}

/** What CC has to say about one session right now, once every gate has passed. */
export interface CcOpinion {
  status: "busy" | "idle";
  statusUpdatedAt: number;
  /** CC's derived session name, when it has one — the rank-4 fallback label. */
  name?: string;
}

/** The join + freshness gates, all four of them, in one place.
 *
 *  1. BOTH JOIN KEYS. The filename's `<pid>` (which the caller resolved the file by) must equal
 *     `record.pid`, and `file.sessionId` must equal the nomo session id. Either mismatch ⇒ ignore the
 *     file ENTIRELY — not "ignore this field", the whole file, because a mismatch means we are looking
 *     at some other session's state.
 *  2. PROCESS-START MATCH, parsed to epoch. `procStartedAt` is the caller's once-per-pid cached probe
 *     (`ps -o lstart=`, LOCAL rendering, Date.parse-able). We compare it to the file's `startedAt` when
 *     present, else to parseCcProcStart(file.procStart) — never to the raw string. A probe the caller
 *     could not take ⇒ no opinion: we cannot verify, so we do not trust. That is a silent degrade to
 *     exactly today's behaviour, which is the contract for every rule here.
 *  3. `status` MAY BE ABSENT (verified on an `entrypoint:"sdk-cli"` row). Absence — and any value other
 *     than the two literals — means NO OPINION. Never idle.
 *  4. `statusUpdatedAt` GOES STALE ON LIVE PROCESSES (verified: three days). Past CC_STATUS_MAX_AGE_MS,
 *     or implausibly future-dated, the status is not evidence about now.
 *
 *  Returns null the moment any gate fails. Pure. */
export function ccOpinion(
  file: CcSessionFile | null | undefined,
  join: { pid: number | undefined; sessionId: string; procStartedAt?: number },
  now: number,
): CcOpinion | null {
  if (!file) return null;
  // 1 — both join keys.
  if (typeof join.pid !== "number" || !Number.isFinite(join.pid) || file.pid !== join.pid) return null;
  if (file.sessionId !== join.sessionId) return null;
  // 2 — process-start match, parsed to epoch on both sides.
  const probed = join.procStartedAt;
  if (typeof probed !== "number" || !Number.isFinite(probed)) return null;
  const claimed = typeof file.startedAt === "number" && Number.isFinite(file.startedAt)
    ? file.startedAt
    : parseCcProcStart(file.procStart);
  if (typeof claimed !== "number") return null;
  if (Math.abs(claimed - probed) > CC_PROC_START_TOLERANCE_MS) return null;
  // 3 — status present and one of the two literals.
  if (file.status !== "busy" && file.status !== "idle") return null;
  // 4 — status freshness.
  const at = file.statusUpdatedAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (now - at >= CC_STATUS_MAX_AGE_MS) return null;
  if (at - now > CC_STATUS_FUTURE_SKEW_MS) return null;
  return {
    status: file.status,
    statusUpdatedAt: at,
    ...(file.name && file.nameSource === "derived" ? { name: file.name } : {}),
  };
}

// --- the state machine ---------------------------------------------------------------------------

/** The five display states, highest rank first. `ended` is the only terminal one. */
export type SessionDisplayState = "ended" | "decisionPending" | "done" | "needsAttention" | "working";

/** The input that decided the state, as it rides the wire (`why`, ≤16 chars, diagnostic only).
 *
 *  - `reap`    the session's pid is gone (or the record was)
 *  - `stale`   the record aged past the 24 h abandonment cap
 *  - `end`     a delivered `op:end`, or the watchdog's own pre-delivery end corrective
 *  - `hold`    a LIVE `.hold` marker — holder pid alive, inside the TTL
 *  - `attn`    the record's own `prio:1`
 *  - `done`    the record's own terminal state
 *  - `work`    everything else with a live pid
 *  - `+cc`     CC's session file contributed: it held a `done` back, or advanced a stale `working`
 *  - `/cx`     CODEX: there is no CC-equivalent for this agent, so this rung is record-only fidelity.
 *              Made VISIBLE deliberately (the spec's open question 2, decided): Claude rows get v2
 *              fidelity and Codex rows keep v1 fidelity, and the user can read which is which rather
 *              than being told a uniform story the Codex half cannot back up. */
export type SessionStateWhy =
  | "reap" | "stale" | "end" | "hold" | "attn"
  | "done" | "done+cc" | "done/cx"
  | "work" | "work+cc" | "work/cx";

/** Where the card's ciphertext comes from. The feed seals only what the MAC AUTHORED; everything the
 *  hooks already sealed rides verbatim, which is the literal content of "1:1 with the hooks" — a
 *  re-derived working blob would lose the hook's `detail` ("Editing lan-frames.ts") and every permission
 *  field, and the row would go vaguer on exactly the events the user cares most about. */
export type SessionStateBlob =
  /** An existing ciphertext (the record's blob, or the hold's card) — passed through untouched. */
  | { kind: "sealed"; value: string }
  /** A plaintext the MAC authored because no existing blob describes the state we computed. The feed
   *  seals it under the pairing e2eKey. Already fitted to BLOB_FIT_CHARS by buildStatePlaintext. */
  | { kind: "plain"; value: Record<string, unknown> }
  /** "Re-serve whatever you last served for this session." The record is gone, so there is no blob to
   *  read — but the phone must still learn the row ended rather than watch it vanish. */
  | { kind: "last" };

/** One session's computed display state. `ts` is when this state was last OBSERVED — it is for display
 *  and the island's `lastTs`, and it is explicitly NOT an ordering guard: nothing compares two of them
 *  to decide what to believe. */
export interface SessionState {
  state: SessionDisplayState;
  terminal: boolean;
  ts: number;
  why: SessionStateWhy;
  blob: SessionStateBlob;
  agent: AgentKind;
  startedAt?: number;
  /** The CLEAR discriminator that says this attention episode is a QUESTION ("the model is asking YOU
   *  something" — Codex's `request_user_input`) rather than a plain permission approval. It rides the
   *  envelope, not the blob, on both the worker wire and v1's `frames`, and the phone's answer flows key
   *  on it — so v2 carries it too rather than making the phone infer it from blob contents.
   *
   *  Present ONLY while the computed state is one the user can actually answer (`decisionPending` /
   *  `needsAttention`). v1 gates it on `prio === 1` for exactly this reason: the watchdog's nets rewrite
   *  records by spreading `...record`, so the marker outlives its episode and would otherwise relabel a
   *  done or working row with a previous question's discriminator. */
  attentionKind?: "userInput";
}

/** What the watchdog's nets have concluded about this session THIS sweep, before delivery. The worker
 *  learns these only after a successful POST; the Mac holds them now, which is the asymmetry v2 exists
 *  to spend. Phase A leaves the feed passing none of them (the sweep is not wired in yet) — the rule is
 *  specified and tested here so phase C is a call-site change, not a redesign. */
export interface SessionCorrectives {
  /** The sweep has decided this session is over (reap/stale/interrupt-end), POST not yet confirmed. */
  ended?: boolean;
  /** The sweep has decided this session's turn finished (a corrective op:done is queued). */
  done?: boolean;
}

export interface SessionStateInput {
  /** The NOMO session id (the record's file basename) — one half of the CC-file join. */
  sessionId: string;
  /** The session record, or null when it was reaped between passes. */
  record: SessionRecord | null;
  /** The CURRENT pairing. A record sealed under any other one is not this phone's to render. */
  pairingId: string | undefined;
  /** The `.hold` marker beside the record, if any. */
  hold?: DecisionHold | null;
  /** Is the SESSION's authoritative owner process alive? Probed by the caller. For a daemon-fronted
   *  Codex record this means its precision-correlated `tuiPid`, when present, rather than the immortal
   *  app-server in `record.pid`; without that correlation the caller deliberately keeps the daemon row
   *  on the explicit-end/24 h path. */
  pidAlive: boolean;
  /** Is the HOLDING HOOK's process alive? Probed by the caller; irrelevant when there is no hold. */
  holdPidAlive?: boolean;
  /** CC's own file for this session's pid, already parsed. Null/absent ⇒ every rule degrades to today. */
  cc?: CcSessionFile | null;
  /** The caller's once-per-pid CACHED process-start probe (epoch ms, `ps -o lstart=`). Absent ⇒ the
   *  CC file cannot be join-verified and contributes nothing. */
  ccProcStartedAt?: number;
  correctives?: SessionCorrectives | null;
  now: number;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const filled = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The blob plaintext the Mac authors when it computes a state the record's own blob does not describe.
 *
 *  KEY ORDER AND CONTENT MIRROR cc-watchdog's buildWorkingEnvelope / buildDoneEnvelope EXACTLY — same
 *  base fields, same adapter-supplied `agent`, same restamped turnStartedAt/model, same `at` in epoch
 *  SECONDS, same appendFittedPlanAndDebug tail. That is not tidiness: those two builders are what the
 *  watchdog POSTs for the SAME corrective through the worker, so a LAN row and a worker row for one
 *  state stay textually identical and a handoff cannot reflow the phone's text (invariant 22). The fit
 *  to BLOB_FIT_CHARS comes along with them, which is why it still applies on a leg with no worker in it. */
export function buildStatePlaintext(
  record: SessionRecord, status: CCStatus, at: number, titleFallback?: string,
): Record<string, unknown> {
  const agent: AgentKind = record.agent === "codex" ? "codex" : "claude";
  const base = {
    status,
    // The record's cached last non-empty title, else CC's derived name, else "". Re-pushing title:""
    // regressed the phone to the folder-name label once already (see buildDoneEnvelope).
    title: filled(record.title) ? record.title : (filled(titleFallback) ? titleFallback : ""),
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    ...adapterFor(agent).blobAgentFields,
    ...(finite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {}),
    ...(filled(record.model) ? { model: record.model } : {}),
    at: Math.floor(at / 1000),
  };
  const dbg = agent === "codex"
    ? formatPlanPickerDebug({
      event: status === "done" ? "done" : "working",
      classifier: status === "done" ? "done" : "resolved",
      marker: "0",
      by: "wd",
    })
    : undefined;
  return appendFittedPlanAndDebug(base, undefined, dbg);
}

/** Is this `.hold` marker LIVE? Marker present with a blob, holder pid alive, inside the TTL.
 *
 *  THE DELIBERATE DIVERGENCE FROM v1 (and from the worker): there is no `suppressible` clause. v1 mirrored
 *  the worker's decision-pending guard, which drops only the `prio:1` restatement and lets a parallel
 *  tool's `PostToolUse` (a `prio:0` write) take the row back mid-hold — which is why a row can go green
 *  while the user is still looking at an Allow/Deny card. The worker CANNOT do better: it sees one event
 *  at a time and has no way to know the holding hook is still blocked. The Mac holds both facts at once,
 *  and the holding hook being alive IS the statement that the prompt is still open. So a live hold
 *  outranks a `prio:0` record write, and only a TERMINAL record state (rank 1, or a `done` record) takes
 *  the card down early — see computeSessionState's evaluation order. */
export function stateHoldLive(
  hold: DecisionHold | null | undefined, holdPidAlive: boolean | undefined, now: number,
): boolean {
  if (!hold || !filled(hold.blob)) return false;
  if (!finite(hold.at)) return false;
  if (now - hold.at > STATE_HOLD_MAX_AGE_MS) return false;
  if (!finite(hold.pid) || holdPidAlive !== true) return false;
  return true;
}

/** THE RANKING. Highest first; each rung names the input that decided it.
 *
 *  | Rank | State            | Condition                                                        | why           |
 *  |------|------------------|------------------------------------------------------------------|---------------|
 *  |  1   | ended            | delivered/decided end, 24 h-abandoned record, or a dead pid       | end/stale/reap|
 *  |  3'  | done             | record terminal, pid alive, and CC does not say busy              | done, done+cc |
 *  |  2   | decisionPending  | a LIVE hold (marker + holder pid alive + inside the TTL)          | hold          |
 *  |  3   | done             | CC says idle past the record's ts + grace on a working row        | done+cc       |
 *  |  4   | needsAttention   | record.prio === 1 and no live hold                                | attn          |
 *  |  5   | working          | anything else with a live pid                                     | work, work+cc |
 *
 *  RANK 3 IS EVALUATED BEFORE RANK 2 and that is not a typo. The spec's ranking table puts
 *  decisionPending above done, and the spec's prose then says "only a TERMINAL record state (rank 1 or 3)
 *  releases the card early" — the two are reconciled by testing the record's own terminal state before
 *  the hold, and everything else after it. A hold whose session has already finished is a card nobody can
 *  answer; a hold whose session is still running is the truth no matter what a parallel tool just wrote.
 *
 *  REFUSALS (null — "nothing honest to say"): no blob, or a blob sealed under another pairing. v1's third
 *  refusal, "no `ts`", is gone with the ordering contract it served: `ts` is now an observation stamp, so
 *  a record without one is stamped `now` rather than dropped.
 *
 *  Pure; never throws. */
export function computeSessionState(input: SessionStateInput): SessionState | null {
  const { sessionId, record, pairingId, hold, pidAlive, holdPidAlive, cc, ccProcStartedAt, correctives, now } = input;

  // --- the record vanished between passes ------------------------------------------------------
  // There is no blob to read, so the caller re-serves the last one it sent. It still must be SAID: a row
  // that silently disappears is the "no silent destructive UI" rule broken on the wire.
  if (record === null) {
    return { state: "ended", terminal: true, ts: now, why: "reap", blob: { kind: "last" }, agent: "claude" };
  }

  // --- refusals ---------------------------------------------------------------------------------
  if (!filled(record.blob)) return null;
  // Sealed under `record.pairingId`; after a re-pair the current key cannot open it, and shipping it
  // anyway is the "Encrypted session forever" bug the heartbeat's own guard exists to prevent. A record
  // with no pairingId is UNKNOWN, never assumed — same rule.
  if (pairingId === undefined || record.pairingId !== pairingId) return null;

  const agent: AgentKind = record.agent === "codex" ? "codex" : "claude";
  const ts = finite(record.ts) ? record.ts : now;
  const startedAt = finite(record.sessionStartedAt) ? { startedAt: record.sessionStartedAt } : {};
  const sealed = { kind: "sealed" as const, value: record.blob };
  // The clear question discriminator, carried ONLY onto the two rungs a user can answer — see
  // SessionState.attentionKind. Mirrors lanFrameContent's `prio === 1` gate in v2's vocabulary.
  const asking = record.attentionKind === "userInput" ? { attentionKind: "userInput" as const } : {};
  const of = (
    state: SessionDisplayState, why: SessionStateWhy, blob: SessionStateBlob, at: number, terminal = false,
  ): SessionState => ({ state, terminal, ts: at, why, blob, agent, ...startedAt });

  // --- rank 1: ended -----------------------------------------------------------------------------
  // Order inside the rung follows classifySession (staleness before liveness, so an abandoned file is
  // always retired) with the two authored ends checked first: they are more specific than either clock.
  if (correctives?.ended === true) return of("ended", "end", sealed, ts, true);
  if (record.op === "end") return of("ended", "end", sealed, ts, true);
  if (finite(record.ts) && now - record.ts > SESSION_STATE_STALE_MS) return of("ended", "stale", sealed, ts, true);
  if (!pidAlive) return of("ended", "reap", sealed, ts, true);

  // --- CC's opinion, gated ------------------------------------------------------------------------
  // NEVER consulted for Codex (no equivalent file exists) nor for a PROVISIONAL row (which has no
  // trustworthy CC-file join). Those stay on the record-only path by construction, and Codex says so
  // on the wire through the `/cx` suffix.
  const ccUsable = agent === "claude" && record.provisional !== true;
  const opinion = ccUsable
    ? ccOpinion(cc, { pid: record.pid, sessionId, procStartedAt: ccProcStartedAt }, now)
    : null;
  const suffix = (base: "done" | "work"): SessionStateWhy =>
    (agent === "codex" ? `${base}/cx` : base) as SessionStateWhy;

  // --- rank 3 (record-terminal), evaluated before the hold ----------------------------------------
  const recordDone = correctives?.done === true || record.op === "done" || record.lastEvent === "done";
  if (recordDone) {
    // CC HOLDS BACK A PREMATURE DONE. A `Stop` fires during a fan-out or a long tool-less generation and
    // the record says done while the agent is still working; CC says busy, and its say-so is NEWER than
    // the record's own write. This is the case the record alone cannot decide, and it is why the file is
    // read at all. Falls through to rank 5 with an AUTHORED working blob — the record's blob says "done"
    // and would render the wrong word.
    const heldBack = opinion?.status === "busy" && opinion.statusUpdatedAt > ts;
    if (!heldBack) {
      // THE BLOB IS AUTHORED, never the record's own — the same rule the CC-driven twin below and rank
      // 5's recordDone case already follow, and for the same one-line reason: THE RECORD'S BLOB CANNOT
      // CARRY A STATE THE RECORD ITSELF DID NOT WRITE. A corrective done is written by the watchdog as
      // `{ ...record, op: "done", lastEvent: "done" }` — the POSTed envelope is rebuilt, but on disk the
      // previous hook's `prio` and `blob` survive, so a done record routinely carries a needsAttention
      // (or working) blob. v1's `frames` never noticed: the LIFECYCLE OP was the phone's authority there
      // (`CCLanFrame.isTerminal` ⇒ the row reads done whatever the blob says). v2 has no such field —
      // `terminal` means "retire this entry", and a done with a live pid is deliberately not that — so a
      // passed-through blob became the rendered status, and the 2026-08-03 field report was a FINISHED
      // session painted needsAttention, outranking a running one for the island (CCPrimaryPick tiers
      // attention above working). Authoring is also what invariant 22 asks for: this is byte-for-byte
      // what the watchdog's own buildDoneEnvelope POSTs for the same corrective.
      //
      // Stamped at `ts` (the record's own), NOT `now`: commitState signs the pre-seal description, so a
      // stamp that moved every sweep would re-seal and wake every long poll on a session that is over.
      return of(
        "done", opinion?.status === "idle" ? "done+cc" : suffix("done"),
        { kind: "plain", value: buildStatePlaintext(record, "done", ts, opinion?.name) }, ts, false,
      );
    }
  }

  // --- rank 2: a live hold ------------------------------------------------------------------------
  // The card's blob is the hold's blob VERBATIM — sealed by the hook with its own `ev:hold` dbg tail,
  // and never re-derived here.
  if (stateHoldLive(hold, holdPidAlive, now)) {
    return {
      state: "decisionPending", terminal: false, ts, why: "hold",
      blob: { kind: "sealed", value: hold!.blob }, agent, ...startedAt, ...asking,
    };
  }

  // --- rank 3 (CC-driven): a missed done, or an Esc-interrupt --------------------------------------
  // CC flips to idle the moment the turn ends or the user interrupts — seconds before the transcript
  // tail scan notices and 17 s before WORKING_STALE_MS would. Strictly bounded (invariant 19): it may
  // only advance a WORKING row. It never touches a prio:1 attention episode (a prompt the user is
  // looking at reads idle to CC, and clearing it would delete the question), and it never creates a row.
  if (
    !recordDone && opinion?.status === "idle" && record.prio !== 1 &&
    record.lastEvent !== "needsAttention" && opinion.statusUpdatedAt > ts + CC_IDLE_DONE_GRACE_MS
  ) {
    return of("done", "done+cc", { kind: "plain", value: buildStatePlaintext(record, "done", opinion.statusUpdatedAt, opinion.name) }, ts, false);
  }

  // --- rank 4: needsAttention ---------------------------------------------------------------------
  if (record.prio === 1) return { ...of("needsAttention", "attn", sealed, ts, false), ...asking };

  // --- rank 5: working ----------------------------------------------------------------------------
  const busy = opinion?.status === "busy" && opinion.statusUpdatedAt > ts;
  return of(
    "working",
    busy ? "work+cc" : suffix("work"),
    // The one case the record's own blob cannot carry: it says done, we computed working.
    recordDone ? { kind: "plain", value: buildStatePlaintext(record, "working", now, opinion?.name) } : sealed,
    ts,
    false,
  );
}
