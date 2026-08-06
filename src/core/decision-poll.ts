// decision-poll — the timing and give-up rules for talking to the worker's blind decision relay
// (`POST /v1/cc/decision`, `GET /v1/cc/decision/:id`), shared by every hold that speaks it.
//
// WHY IT IS ITS OWN MODULE: three call sites now drive the SAME route with the SAME pairing
// credentials — the blocked Claude permission hook (permission.ts), the in-watchdog Codex
// request_user_input relay (codex-remote-input.ts), and the LAN listener's answer echo, which retires a
// record the other two may still be polling. They MUST agree on the cadence and on what counts as
// giving up: a poll interval that drifts apart wastes the shared per-pairing poll budget, and a
// give-up rule that drifts apart means one channel abandons a request the other is still holding open.
// These constants lived verbatim in two files before; this is their single home.
//
// Everything here is PURE — constants plus one IO-free latency estimator (createPollBudget), no imports,
// no clock of its own — so a short-lived hook can pull it in without dragging any transport machinery
// along.
//
// WHAT IS DELIBERATELY *NOT* HERE: the FIRST-CONTACT POST ceiling. The two callers block different
// things and so bound it differently on purpose — permission.ts freezes the user's terminal dialog
// behind it (POST_FIRST_CONTACT_TIMEOUT_MS, 6 s) while codex-remote-input runs detached inside the
// watchdog and can afford the full round trip (POST_TIMEOUT_MS, 15 s). Those two are NOT duplicates;
// each stays documented where its blocking cost is paid. The first-contact ceiling for the poll GETs
// IS here (POLL_FIRST_CONTACT_TIMEOUT_MS) — both callers pay it on the same fetch, the first one.

/** How often a granted hold re-reads its decision record (ms). Callers add their own jitter. Also the
 *  cadence the LAN loopback poller re-checks the ABSENCE of lan.json at, so a watchdog that comes up
 *  mid-hold is discovered within one worker cycle. */
export const POLL_INTERVAL_MS = 3_000;
/** The widest jitter a caller may add to POLL_INTERVAL_MS. Declared here — not left implicit in the
 *  permission hook's `Math.random() * 500` — because it is a term in the cadence-vs-expiry arithmetic
 *  below, and an arithmetic bound may not depend on a magic number hiding in another file. */
export const POLL_JITTER_MAX_MS = 500;
/** FLOOR for the STEADY-STATE poll GETs, and the value a healthy network keeps forever. The permission
 *  hook's "every fetch is bounded" contract survives on both channels; only the TOTAL wait is unbounded.
 *
 *  v1.6.6 made this a FIXED 2 s on the reasoning that "by the time a hold is polling in steady state the
 *  connection to the worker has already been established once". THAT PREMISE IS FALSE on the network this
 *  whole family of constants exists for. Field trace, 2026-08-04: a hold posted fine, seq 1 SUCCEEDED in
 *  3306 ms on the new 4 s first-contact budget, and then seq 2/3/4/5 — every one of them on this 2 s
 *  ceiling — timed out. Through the user's fake-IP tunnel a pooled connection is not guaranteed to
 *  survive the 3 s gap between polls, so each GET can pay connect + TLS again; a ceiling BELOW the
 *  round trip the very same process just measured cannot ever be met, and the hold dies (or the row
 *  reverts) before the user can answer, on BOTH channels.
 *
 *  So this is now the FLOOR of an adaptive budget (createPollBudget below), not the budget itself. */
export const POLL_TIMEOUT_MS = 2_000;
/** Hard CEILING of the adaptive budget. NOT a taste call — it is bounded by the WORKER: a pending
 *  decision record is expired after WORKER_DECISION_STALE_MS of poll silence, so a budget generous
 *  enough that two consecutive polls could span that window would expire the very hold it is keeping
 *  alive. See the arithmetic on WORKER_DECISION_STALE_MS; 8 s leaves >10 s of margin on the
 *  conservative bound while still covering ~2.4× the worst round trip the field trace ever measured. */
export const POLL_TIMEOUT_CEILING_MS = 8_000;
/** Headroom multiplier: budget ≈ K × the round trip recently OBSERVED on this very route. A request that
 *  takes more than 3× the latency its own process just measured is genuinely stalled, not merely slow —
 *  below that, timing out only throws away a round trip that was about to complete. (2× has no room for
 *  ordinary variance; 4×+ buys nothing the ceiling would not clamp away anyway.) */
export const POLL_BUDGET_LATENCY_FACTOR = 3;
/** Bounded observation window. Five samples ≈ 15–25 s of polling — about ONE worker-expiry window — so
 *  the estimate always describes the network as it is now, and an episode of slowness can never outlive
 *  its own relevance. Odd, so the median is a real sample; five, so the median survives up to two
 *  simultaneous outliers. */
export const POLL_LATENCY_SAMPLES = 5;
/** The worker's own liveness rule, mirrored (server/src/decision.ts: `DECISION_STALE_MS = 30_000`): a
 *  PENDING record whose hook has not polled inside this window is swept to `expired`. Every poll-timing
 *  constant in this file is ultimately bounded by it. THE ARITHMETIC, at the maximum budget:
 *
 *    one cycle           = CEILING(8 s) + INTERVAL(3 s) + JITTER(≤0.5 s)              = 11.5 s
 *    worst arrival gap   = 2 × CEILING(8 s) + INTERVAL(3 s) + JITTER(≤0.5 s)          = 19.5 s
 *
 *  The second is the one that matters: the worker stamps last-seen when a GET ARRIVES, so the widest gap
 *  it can observe is a poll that lands at the very start of its budget followed by one that lands at the
 *  very end of the next. 19.5 s < 30 s with 10.5 s (35 %) to spare. Pinned by decision-poll.test.ts —
 *  raising POLL_TIMEOUT_CEILING_MS past ~13 s breaks that test, and would silently expire live holds. */
export const WORKER_DECISION_STALE_MS = 30_000;

/** FIRST-CONTACT ceiling for a poll GET — the FIRST GET a process makes on this route, i.e. the
 *  permission hook's did-it-land probe (seq 0) and the first poll of a freshly granted hold (seq 1), and
 *  the Codex relay's first poll.
 *
 *  WHY IT IS BIGGER THAN POLL_TIMEOUT_MS (field report, 2026-08-03): the user's Mac resolves
 *  api.nomo.gg through a tunnel/proxy that hands back a fake IP (28.0.0.19). A HEALTHY request through
 *  it completes in ~590 ms, but the FIRST connection of a process pays the proxy's own DNS + connect +
 *  TLS setup, and when that stalls it stalls for seconds. Six consecutive 2 s GETs all timed out, and
 *  the retry hook's POST + 2 s did-it-land probe timed out too — so the Mac gave up on a hold the phone
 *  was still showing. A steady-state cadence tuned for an established connection is the wrong budget for
 *  the handshake that establishes it.
 *
 *  IT IS NOW A FLOOR, NOT A FIXED CEILING (NOM-45 follow-up). This is the budget for a poll with NOTHING
 *  measured yet, which is exactly what seq 0/1 are. From seq 2 on, createPollBudget sizes the ceiling
 *  from what THIS process's own completed round trips actually cost: a fast Mac drops straight back to
 *  POLL_TIMEOUT_MS, while a tunnel that just answered in 3306 ms gets a budget it can meet instead of
 *  four doomed 2 s GETs. */
export const POLL_FIRST_CONTACT_TIMEOUT_MS = 4_000;

/** A bounded, IO-free estimator of what this process's polls actually cost on this network, and the
 *  per-fetch budget derived from it. One instance per hold; both call sites (permission.ts's hold loop
 *  and codex-remote-input.ts's relay loop) drive it identically. */
export interface PollBudget {
  /** The ceiling for the poll about to start at `seq` (0 = the did-it-land probe, 1 = a fresh hold's
   *  first GET, 2+ = steady state). */
  next(seq: number): number;
  /** Record ONE COMPLETED round trip. Callers feed successes only — a response arrived, ok or not, so the
   *  transport cost is a real measurement. A THROW is deliberately never fed: a timeout is a censored
   *  observation (latency ≥ budget, exact value unknown) and a fast connection refusal measures nothing
   *  at all, so letting either move the estimate would inflate the budget on exactly the network that
   *  produces no evidence — and with it the wall-clock cost of MAX_CONSECUTIVE_MISSES. A hold whose
   *  polls never complete is not one an adaptive ceiling can save anyway: the worker has already expired
   *  the record at 30 s (see WORKER_DECISION_STALE_MS), so the right behaviour there is the unchanged
   *  ~5 min fail-open, not a longer freeze. */
  observe(roundTripMs: number): void;
}

/** budget(seq) = clamp( floor(seq), K × median(last N observed round trips), CEILING ).
 *
 *  MEDIAN, not a mean or an EWMA: a single slow sample — one GC pause, one wifi hiccup, one NTP step —
 *  moves a mean immediately and decays out of an EWMA only over several polls, whereas the median of a
 *  bounded window is unmoved by it BY CONSTRUCTION and still turns over completely within one window
 *  when the slowness is real. Adapting up needs 3 of the last 5 polls to agree; adapting back down needs
 *  the same. Even-length windows take the UPPER middle, which errs toward the slower reading — the safe
 *  direction, since an over-generous ceiling costs nothing on a fast network (it is a ceiling, not a
 *  wait) while an under-generous one costs the user their approval. */
export function createPollBudget(): PollBudget {
  const window: number[] = [];
  return {
    next(seq: number): number {
      // FIRST CONTACT keeps its v1.6.6 floor: seq 0/1 are the first fetch this short-lived process makes
      // on this route, and nothing has been measured yet to size them from.
      const floorMs = seq <= 1 ? POLL_FIRST_CONTACT_TIMEOUT_MS : POLL_TIMEOUT_MS;
      if (window.length === 0) return floorMs;
      const sorted = [...window].sort((a, b) => a - b);
      const typical = sorted[Math.floor(sorted.length / 2)] as number;
      return Math.min(POLL_TIMEOUT_CEILING_MS, Math.max(floorMs, Math.ceil(typical * POLL_BUDGET_LATENCY_FACTOR)));
    },
    observe(roundTripMs: number): void {
      // A wall clock can step backwards (NTP) and a caller can hand us a NaN from a stubbed clock; either
      // would poison the window for its whole lifetime, and neither is a measurement.
      if (!Number.isFinite(roundTripMs) || roundTripMs < 0) return;
      window.push(roundTripMs);
      if (window.length > POLL_LATENCY_SAMPLES) window.shift();
    },
  };
}
/** One retry of the initial decision POST — and ONLY after a FAST transport failure (connection
 *  refused, DNS, reset). A TIMEOUT is never retried (a second stall buys no new information and doubles
 *  the freeze) and a non-ok HTTP status is never retried either (that is a real answer). The retry
 *  re-POSTs the SAME requestId + blobs with a FRESH `ts`: the worker's supersede no-ops on an identical
 *  id and putDecision idempotently re-stores the pending record, so a re-POST after an attempt that
 *  actually landed is safe. */
export const POST_MAX_ATTEMPTS = 2;
/** Pause before that single POST retry. */
export const POST_RETRY_PAUSE_MS = 1_000;
/** Give-up CEILING: this many CONSECUTIVE polls without a usable 2xx (~5 min at the interval above)
 *  means the worker is unreachable → stop waiting and fail open. The "~5 min" survives the adaptive
 *  budget on purpose: createPollBudget is fed COMPLETED round trips only, so a network that produces
 *  nothing but timeouts never inflates its own ceiling, and 100 misses stay ~100 × (2 s + 3 s). Any successful poll — including a plain
 *  {status:"pending"} — resets the counter, so a healthy hold is unbounded.
 *
 *  THIS IS A TOLERANCE, NOT A TRIPWIRE, and NOM-45 keeps it that way deliberately. A transport throw is
 *  worth ONE miss and nothing more: it is never a definitive strike (see DEFINITIVE_POLL_STATUSES /
 *  MAX_DEFINITIVE_POLL_FAILURES below, which release in 2), so a tunnel that stalls for 20 s — six, ten,
 *  thirty consecutive timeouts — costs the hold nothing but those misses and RESUMES polling the instant
 *  one GET completes. 100 is the ceiling that keeps fail-open honest: a Mac whose network never comes
 *  back must still hand the user their terminal dialog rather than block forever, and ~5 min is the point
 *  past which "it will be back in a moment" stops being true. The phone learns which of the two happened
 *  from the record's `attentionStalledAt` (see SessionRecord) — a give-up here is a RECONNECTING row,
 *  never a dead yellow hand. */
export const MAX_CONSECUTIVE_MISSES = 100;

/** Poll statuses that are DEFINITIVE, not transient: the pairing is unauthorized/revoked/unknown, so
 *  every remaining poll of this request is guaranteed to fail the same way. Mirrors runHook's gone-strike
 *  set (404/410) plus the auth pair (401/403) — there, a gone response tears the pairing down; here it
 *  only means "stop waiting". Anything else (429, 5xx, an unreadable 200, a transport throw) stays
 *  transient and rides the MAX_CONSECUTIVE_MISSES cap. Riding that cap on a doomed request instead would
 *  burn ~5 min of the shared per-pairing poll budget and starve genuinely live holds into 429s. */
export const DEFINITIVE_POLL_STATUSES = new Set([401, 403, 404, 410]);
/** …and, like the gone strike, a SINGLE definitive response can be a racing delete/deploy, so require
 *  this many CONSECUTIVE ones before releasing. 2 ⇒ ~3 s to the terminal dialog instead of ~5.4 min. */
export const MAX_DEFINITIVE_POLL_FAILURES = 2;
