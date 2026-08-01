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
// Everything here is a PURE constant — no imports, no IO — so a short-lived hook can pull it in without
// dragging any transport machinery along.
//
// WHAT IS DELIBERATELY *NOT* HERE: the FIRST-CONTACT POST ceiling. The two callers block different
// things and so bound it differently on purpose — permission.ts freezes the user's terminal dialog
// behind it (POST_FIRST_CONTACT_TIMEOUT_MS, 4 s) while codex-remote-input runs detached inside the
// watchdog and can afford the full round trip (POST_TIMEOUT_MS, 15 s). Those two are NOT duplicates;
// each stays documented where its blocking cost is paid.

/** How often a granted hold re-reads its decision record (ms). Callers add their own jitter. Also the
 *  cadence the LAN loopback poller re-checks the ABSENCE of lan.json at, so a watchdog that comes up
 *  mid-hold is discovered within one worker cycle. */
export const POLL_INTERVAL_MS = 3_000;
/** Per-fetch ceiling for the poll GETs. The permission hook's "every fetch is bounded at 2 s" contract
 *  survives on both channels; only the TOTAL wait is unbounded. */
export const POLL_TIMEOUT_MS = 2_000;
/** One retry of the initial decision POST — and ONLY after a FAST transport failure (connection
 *  refused, DNS, reset). A TIMEOUT is never retried (a second stall buys no new information and doubles
 *  the freeze) and a non-ok HTTP status is never retried either (that is a real answer). The retry
 *  re-POSTs the SAME requestId + blobs with a FRESH `ts`: the worker's supersede no-ops on an identical
 *  id and putDecision idempotently re-stores the pending record, so a re-POST after an attempt that
 *  actually landed is safe. */
export const POST_MAX_ATTEMPTS = 2;
/** Pause before that single POST retry. */
export const POST_RETRY_PAUSE_MS = 1_000;
/** Give-up cap: this many CONSECUTIVE polls without a usable 2xx (~5 min at the interval above) means
 *  the worker is unreachable → stop waiting and fail open. Any successful poll — including a plain
 *  {status:"pending"} — resets the counter, so a healthy hold is unbounded. */
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
