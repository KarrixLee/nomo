// lan-frames — the Mac→phone status feed behind the LAN listener's `frames` op (NOM-44 phase 3).
//
// WHAT IT IS: an in-memory, per-pairing map of "the latest state of every live session", stamped with a
// single monotonic counter, plus the long-poll waiters the phone parks on. While the app is foregrounded
// with a live LAN link it holds a `{op:"frames", sinceSeq, waitMs}` request open here, so a session
// change reaches the UI in ~100 ms instead of on the next 3 s worker poll. The worker path is untouched
// and stays canonical — this feed adds nothing to it and removes nothing from it.
//
// A STATE-SYNC MODEL, NOT AN EVENT LOG. Each change OVERWRITES its session's entry and takes the next
// counter value; a response carries at most one frame per session (its latest). That is what makes a
// burst — three tool events inside a debounce window — cost the phone one frame instead of three, and it
// is why nothing here is ever queued or replayed: there is no history to fall behind.
//
// THE COUNTER AND THE MAP ARE IN-MEMORY, deliberately. They are rebuilt from the on-disk session store
// whenever this process starts, so a watchdog restart restarts the counter at 0 — which is precisely why
// a phone holding a stale HIGH `sinceSeq` must be answered with the FULL current map (see `since`), and
// why every response carries the listener instance id (`lid`): the phone resets its cursor when it
// changes. Nothing is silently missed in either direction.
//
// THE DATA FEED (the one real design choice here — see createLanFrameStore's header for why): fs.watch
// on the session-store directory, debounced, with the watchdog's existing ~5 s sweep as the reconciling
// fallback. The hook processes that author these records are SEPARATE, short-lived processes with no IPC
// to the daemon, so the on-disk store is the only shared surface between them.
//
// PRIVACY: `blob` is copied VERBATIM out of the record. It is sealed under the pairing e2eKey and is
// never opened here — this module is exactly as blind as the worker. Only the phone can read it.
//
// LAN STATUS v2 (NOM-47 phase A) adds a SECOND feed beside that one, in this same store: op `state`
// serves the Mac's COMPUTED DISPLAY STATE (core/session-state.ts) as complete current-state snapshots
// rather than an event replay, so nothing on the phone has to order or arbitrate anything. The two feeds
// share one directory read, one liveness probe per pid, one debounce and one reconcile chain, and they
// keep SEPARATE maps, cursors and waiter lists — v1 must stay byte-identical for as long as an old app
// build can be pointed at a fresh plugin, which is indefinitely.
//
// THE ONE THING v2 CHANGES ABOUT BLINDNESS: the store now holds the pairing e2eKey, and seals the
// plaintexts the MAC ITSELF AUTHORS — the states no hook-written blob describes (a `done` record CC says
// is still busy, a `working` record CC says finished). Hook-authored ciphertext still rides verbatim and
// is never opened. This is not a weakening: blindness was always a property of the WORKER, a relay in the
// middle; this daemon is one of the two ENDPOINTS and has held that key since pairing. Nothing new
// crosses the worker, because nothing here crosses the worker at all.
//
// PHASE 4 (`readFull`) is the ONE deliberate exception, and it never crosses the worker: the unabridged
// plan / permission detail the hook teed onto the record is plaintext, and it is served plaintext into
// the listener's K_lan OUTER seal. That is still E2E between this Mac and the paired phone — the content
// simply rides one seal instead of two, because there is no blind relay in the middle to be blind.

import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { encryptBlob } from "./crypto";
import { LAN_SESSION_ID_RE, lanRunningUnderTest } from "./lan-wire";
import type { LanReadWhat } from "./lan-wire";
import { computeSessionState, parseCcSessionFile } from "./session-state";
import type { CcSessionFile, SessionState } from "./session-state";
import { DECISION_HOLD_SUFFIX, decisionHoldFileName, pidAlive, recordFullTextIsComplete, SESSIONS_DIR } from "./shared";
import type { AgentKind, CCOp, DecisionHold, SessionRecord } from "./shared";

const execFileP = promisify(execFile);

/** How long a session that has RETIRED (record deleted, pid dead, aged out) keeps serving its final
 *  terminal frame before it drops out of the map entirely. The frame itself is delivered once, the
 *  instant retirement is observed; the grace exists so a phone that reconnects (or long-polls with an
 *  older cursor) a moment later still learns the session ended instead of seeing it silently vanish —
 *  the "no silent destructive UI" rule, applied to the wire. */
export const LAN_FRAME_RETIRE_GRACE_MS = 60_000;
/** Debounce on the fs.watch feed. Long enough that a hook's write burst (record rewrite + the watchdog's
 *  own rewrite of the same file) collapses into ONE reload, short enough to stay far under the sub-second
 *  target. */
const LAN_FRAMES_WATCH_DEBOUNCE_MS = 100;
/** Concurrent long-poll waiters. One foregrounded phone holds exactly one; the cap bounds what a K_lan
 *  holder (or a phone that reconnects without draining its old sockets) can pin, and the OLDEST waiter is
 *  dropped with an immediate empty response rather than refused — a dropped waiter simply re-arms. */
export const LAN_FRAMES_WAITERS_MAX = 4;
/** The 24 h abandonment cap, mirroring cc-watchdog's own SESSION_STALE_MS (not exported from an entry
 *  module — core must not import from entries/). Past it the watchdog retires the record; the feed calls
 *  the session terminal at the same moment so the phone never sees a live row the sweep has given up on. */
export const LAN_FRAME_SESSION_STALE_MS = 86_400_000;
/** The hard ceiling on a hold marker (see shared.ts's DecisionHold header). It is the SECOND of two
 *  independent releases — the holder-pid liveness probe is the fast one — and exists only for the case
 *  where a killed hook's pid was recycled by an unrelated process. 10 min mirrors the worker's own
 *  decision-poll key TTL (DECPOLL_TTL_SECONDS, server/src/decision.ts), which is the same "no hook can
 *  still be polling for this" bound expressed server-side. */
export const LAN_HOLD_MAX_AGE_MS = 600_000;

/** Per-response ceiling on `state`'s `sessions` array, sized to the WORKER's own per-pairing session cap
 *  so a LAN response can never describe more sessions than the channel it is standing in for. When the
 *  map is somehow larger, the MOST RECENTLY ACTIVE 20 are served: the overflow simply stays worker-driven
 *  on the phone (an unowned row), which is a safe degradation rather than a wrong one. */
export const LAN_STATE_SESSIONS_MAX = 20;

/** Where CC keeps its own per-process session files. Undocumented and unversioned — see session-state.ts. */
export const CC_SESSIONS_DIR = `${process.env.HOME}/.claude/sessions`;

/** THE CAPABILITY LATCH. If no tracked session's CC file carries a usable `status` for this many
 *  CONSECUTIVE passes, stop reading the directory entirely: a CC that stopped writing the field (a
 *  schema change, an sdk-cli-only workload, a directory that is not there) must cost one readdir, not
 *  one readFile per session per sweep forever. Re-armed the moment a pid we have never probed shows up,
 *  so a user who happened to run five sdk-cli sweeps does not lose the feature until the next restart. */
export const CC_CAPABILITY_LATCH_SWEEPS = 5;

/** One session's computed DISPLAY STATE, as the `state` op serves it (LAN status v2).
 *
 *  This is a whole statement about NOW, not an event: there is no `op`, no `prio` and no ordering
 *  contract. `terminal` carries the op's only load-bearing distinction (the island already derives prio
 *  from the rendered status), and `ts` is when the state was last observed — for display and the
 *  island's `lastTs`, never for deciding what to believe. `why` names the input that decided it. */
export interface LanSessionState {
  sessionId: string;
  ts: number;
  terminal: boolean;
  /** The e2eKey-sealed CCBlobPlaintext. Either a ciphertext the hook already authored (passed through
   *  verbatim — that is what "1:1 with the hooks" means) or one this store sealed from a plaintext the
   *  Mac authored because no existing blob described the state it computed. */
  blob: string;
  agent?: AgentKind;
  startedAt?: number;
  /** The CLEAR question discriminator (`"userInput"` — a Codex `request_user_input`), carried here for
   *  the same reason it rides the v1 `frames` envelope and the worker's: it is the established field the
   *  phone's answer flows key on, and it is not derivable from the sealed blob. Present only while the
   *  state is one the user can answer (`decisionPending` / `needsAttention`). */
  attentionKind?: "userInput";
  /** Diagnostic only, ≤16 chars. Never parsed for meaning by anything that decides what to render. */
  why?: string;
}

/** A `state` response body. `complete` says "this is the WHOLE current map for this pairing", which is
 *  the ONLY thing that may seed the phone's per-row LAN-ownership set. On `complete:false`, absence is
 *  still never evidence. */
export interface LanStateSlice {
  seq: number;
  /** The Mac's snapshot instant, epoch ms — the freshness anchor for the whole response. */
  at: number;
  complete: boolean;
  sessions: LanSessionState[];
}

/** One session's latest state, as the phone receives it. `blob` is the record's e2eKey-sealed
 *  CCBlobPlaintext, verbatim; everything else is the clear envelope the worker path would have carried
 *  for the same event, so the phone's ingest can be the same code on both channels. */
export interface LanFrame {
  seq: number;
  sessionId: string;
  op: CCOp;
  prio: 0 | 1;
  ts: number;
  blob: string;
  agent?: AgentKind;
  attentionKind?: "userInput";
}

/** A `frames` response body: the phone's next cursor, and everything that changed past its old one. */
export interface LanFramesSlice {
  seq: number;
  frames: LanFrame[];
}

/** One unabridged field, as the `read` op serves it (phase 4). `complete` is false only when the
 *  256 KB record-side cap clipped the stored copy — the phone says so out loud rather than pretending
 *  the text ended there. NOT sealed under the pairing key: unlike `blob`, this content rides inside the
 *  K_lan OUTER seal and nothing else, which is E2E between this Mac and the phone already. */
export interface LanFullRead {
  content: string;
  complete: boolean;
}

/** A frame's content — everything except the counter stamp. Built with a FIXED key order so
 *  JSON.stringify of it is a stable change signature (see `stamp`). */
type LanFrameContent = Omit<LanFrame, "seq" | "sessionId">;

/** Is this session still one the WATCHDOG considers alive? Mirrors classifySession's keep/end/stale
 *  decision exactly (un-ageable → not live, 24 h-abandoned → not live, dead pid → not live), so the feed
 *  and the sweep can never disagree about who is running. Pure apart from the injected liveness probe. */
export function lanFrameSessionLive(record: SessionRecord, now: number, isAlive: (pid: number) => boolean): boolean {
  if (typeof record.pid !== "number" || !Number.isFinite(record.pid)) return false;
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return false;
  if (now - record.ts > LAN_FRAME_SESSION_STALE_MS) return false;
  return isAlive(record.pid);
}

/** The renderable content of a session record, or null when there is nothing honest to send:
 *
 *  - NO BLOB → null. A frame's whole payload is the sealed blob; a record written before the blob was
 *    stored (or a pre-v2 record) has nothing for the phone to render.
 *  - PAIRING MISMATCH → null. The blob is sealed under `record.pairingId`; after a re-pair the current
 *    key cannot open it, and shipping it anyway is exactly the "Encrypted session forever" bug the
 *    heartbeat's own guard (buildHeartbeatEnvelope) exists to prevent. A record with no pairingId is
 *    UNKNOWN, never assumed — same rule.
 *  - NO ts → null. `ts` is the phone's per-session ordering guard; a frame without one cannot be ordered.
 *
 *  op/prio mirror the heartbeat envelope's defaults (`record.op ?? "update"`, `record.prio ?? 0`) so a
 *  LAN frame and the worker frame for the same record describe the same event. `attentionKind` rides
 *  ONLY on a prio-1 frame: it marks a LIVE question, and a record rewritten into a done/working state by
 *  a watchdog net that spreads `...record` could otherwise carry a previous episode's marker forward. */
export function lanFrameContent(
  record: SessionRecord, pairingId: string | undefined,
  hold: DecisionHold | null = null, now: number = Date.now(), isAlive: (pid: number) => boolean = pidAlive,
): LanFrameContent | null {
  if (typeof record.blob !== "string" || record.blob.length === 0) return null;
  if (pairingId === undefined || record.pairingId !== pairingId) return null;
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return null;
  // THE HOLD OVERLAY. While a remote-approval hold is live the CARD is this session's true state, and
  // the record's own prio:1 needsAttention is the concurrent restatement the worker drops. Stamped at
  // max(record.ts, hold.at) so it is strictly newer than whatever the phone last accepted on either
  // channel — a card the phone's per-session ordering guard rejected would be no card at all.
  if (lanHoldLive(hold, record, now, isAlive)) {
    return {
      op: "update",
      prio: 1,
      ts: Math.max(record.ts, hold!.at),
      blob: hold!.blob,
      ...(record.agent === "codex" ? { agent: "codex" as AgentKind } : {}),
      ...(record.attentionKind === "userInput" ? { attentionKind: "userInput" as const } : {}),
    };
  }
  const prio: 0 | 1 = record.prio === 1 ? 1 : 0;
  return {
    op: (record.op ?? "update") as CCOp,
    prio,
    ts: record.ts,
    blob: record.blob,
    ...(record.agent === "codex" ? { agent: "codex" as AgentKind } : {}),
    ...(prio === 1 && record.attentionKind === "userInput" ? { attentionKind: "userInput" as const } : {}),
  };
}

/** Should this session's frame be the HOLD's card rather than the record's own state?
 *
 *  The release rules are the exact mirror of the worker's decision-pending guard (server/src/cc.ts):
 *  only a plain prio:1 `update` is outranked. A prio:0 frame written AFTER the hold began is genuine
 *  forward progress — Claude runs tools in PARALLEL, so tool B's PostToolUse lands while tool A is
 *  still blocking — and a done/end ends the row; both must speak, exactly as they do server-side.
 *
 *  Plus the two releases the worker does not need, because ITS record has a TTL and a poll-liveness
 *  sweep while this one is a file a killed hook leaves behind: the holder process must still be alive,
 *  and the marker must be younger than LAN_HOLD_MAX_AGE_MS. Between them a stale marker costs at most
 *  one reconcile pass, never a wedged row. */
export function lanHoldLive(
  hold: DecisionHold | null | undefined, record: SessionRecord, now: number,
  isAlive: (pid: number) => boolean,
): boolean {
  if (!hold || typeof hold.blob !== "string" || hold.blob.length === 0) return false;
  if (typeof hold.at !== "number" || !Number.isFinite(hold.at)) return false;
  if (now - hold.at > LAN_HOLD_MAX_AGE_MS) return false;
  if (typeof hold.pid !== "number" || !Number.isFinite(hold.pid) || !isAlive(hold.pid)) return false;
  const suppressible = (record.op ?? "update") === "update" && record.prio === 1;
  return record.ts <= hold.at || suppressible;
}

export interface LanFrameStoreDeps {
  /** The session store to mirror. Defaults to the real SESSIONS_DIR — except under `bun test`, where it
   *  defaults to NOTHING: a unit test sees the developer's REAL home directory, and neither watching nor
   *  reading their live session records is acceptable. Tests inject a temp dir; the same guard the
   *  listener's trace sink uses (lanRunningUnderTest). A store with no directory is inert. */
  sessionsDir?: string;
  /** Liveness probe, mirroring the sweep's. Injected so tests need no real processes. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  retireGraceMs?: number;
  debounceMs?: number;
  maxWaiters?: number;
  /** Directory watcher factory (test seam). Returning null = "no watcher available" → the sweep-driven
   *  reconcile is the only feed, which is exactly the degraded mode this design already tolerates. */
  watchDir?: (dir: string, onChange: () => void) => LanFramesWatcher | null;
  /** CC's own sessions directory (`~/.claude/sessions`). Same `bun test` guard as `sessionsDir`: a unit
   *  test must never read the developer's live CC state. Undefined ⇒ the CC input is simply absent, and
   *  every rule that consumes it degrades to today's behaviour. */
  ccSessionsDir?: string;
  /** A pid's process start time (epoch ms). Called ONCE PER PID and cached — it is the CC file's
   *  join-verification probe and must never become a per-sweep shell-out. Undefined result ⇒ the file
   *  cannot be verified ⇒ no CC opinion. */
  procStartedAt?: (pid: number) => Promise<number | undefined>;
}

/** The slice of node's FSWatcher this module touches. Declared structurally: the repo ships no
 *  @types/node (see lan-listener's LanServer note). */
export interface LanFramesWatcher {
  close(): void;
  on?(event: string, listener: (arg?: unknown) => void): unknown;
  unref?(): unknown;
}

export interface LanFrameStore {
  /** The current global counter — the cursor a phone echoes back as `sinceSeq`. */
  seq(): number;
  /** Everything stamped after `sinceSeq`, newest state per session, seq ascending. A `sinceSeq` GREATER
   *  than the current counter is a cursor from a previous listener instance and yields the FULL map. */
  since(sinceSeq: number): LanFramesSlice;
  /** `since`, but holding up to `waitMs` when there is nothing new. Resolves early on any change and on
   *  stop(); returns an empty frame list on timeout. */
  wait(sinceSeq: number, waitMs: number): Promise<LanFramesSlice>;
  /** THE v2 FEED (op `state`). Everything the map holds for this pairing whose entry changed after
   *  `sinceSeq`, plus `complete` — which is true whenever the answer IS the whole map (a `sinceSeq` of
   *  0, a cursor from a previous listener instance, or any cursor predating a rebuild) and is the only
   *  thing that may seed the phone's ownership set. */
  states(sinceSeq: number): LanStateSlice;
  /** `states`, but holding up to `waitMs` when there is nothing new. Resolves early on any change and on
   *  stop(). A response that would be `complete` is NEVER held once the map has ever had content: the
   *  phone's link-up handoff waits on exactly that response, and making it wait 25 s would leave every
   *  row worker-driven for the whole hold. */
  waitStates(sinceSeq: number, waitMs: number): Promise<LanStateSlice>;
  /** Point the feed at the CURRENT pairing AND its e2eKey. A rotation voids every cached frame and
   *  state (sealed under the old key), so both maps are cleared and rebuilt.
   *
   *  THE KEY IS NEW IN v2, and it is not a weakening of anything. Blindness was always a property of the
   *  WORKER, which is a relay in the middle; this daemon is one of the two ENDPOINTS and has held
   *  `config.e2eKey` since pairing. Hook-authored blobs still ride verbatim and are never opened here —
   *  the key exists only to SEAL the plaintexts the Mac itself authored. Nothing new crosses the worker,
   *  because nothing here crosses the worker at all. */
  setPairing(pairingId: string | undefined, e2eKey?: Uint8Array): void;
  /** The UNABRIDGED plan / permission detail for ONE session (the `read` op, phase 4), or null when
   *  there is nothing honest to serve.
   *
   *  A FRESH DISK READ, deliberately — not another in-memory map. A read is a rare, explicit user
   *  action (tapping a plan on the phone) where one open+read is invisible, while the payload is up to
   *  256 KB per session: caching it would grow this daemon's heap by the size of every plan every
   *  session ever proposed, for content most sessions never ask for. The frame map stays what it is —
   *  small, hot, blob-only. It lives HERE rather than in the listener because the guards it needs are
   *  this module's: the sessions directory (which the listener does not know) and the pairing (which
   *  lanFrameContent already enforces).
   *
   *  Null — the listener's `not-found` — for: no store directory, a session id outside the charset gate,
   *  an absent/corrupt record, a record from ANOTHER pairing (the same rule lanFrameContent applies, so
   *  a read can never serve what a frame would refuse), a record past the 24 h abandonment cap, or a
   *  record with no such field (the common case: nothing was truncated, so the phone keeps the blob's
   *  own copy). Liveness is deliberately NOT required: a session that just went terminal can still have
   *  the plan the user is looking at pulled. Never throws. */
  readFull(sessionId: string, what: LanReadWhat): Promise<LanFullRead | null>;
  /** Re-read the whole session store and fold every change into the map. Called on the watch feed
   *  (debounced) and once per watchdog sweep as the lossy-watch fallback. Never throws. */
  reconcile(): Promise<void>;
  /** Arm the directory watcher. Idempotent; a failure is silent (the sweep feed still works). */
  start(): void;
  /** Tear down the watcher, the debounce timer, and EVERY waiter (a held response must never outlive
   *  the listener that owns its socket). Idempotent. */
  stop(): void;
  /** Live session count (test/diagnostic seam). */
  size(): number;
}

interface StoreEntry {
  frame: LanFrame;
  /** Change signature — the frame content, key-order-stable. Equal signature ⇒ nothing happened ⇒ NO
   *  counter bump, which is what keeps the 5 s reconcile from waking every long-poll for no reason. */
  sig: string;
  /** Set when the session went terminal; the entry is dropped LAN_FRAME_RETIRE_GRACE_MS later. */
  retiredAt?: number;
}

/** The v2 twin of StoreEntry. Separate map, separate retire clock, SHARED counter and waiter list —
 *  which is what "one store, two ops" means. It is deliberately not folded into StoreEntry: the two
 *  feeds' terminal conditions differ (v2 calls a delivered `op:end` terminal where v1 waits for the
 *  record to vanish), and one shared `retiredAt` would let the v2 rule retire a v1 frame early. The v1
 *  projection must stay byte-identical for as long as an old phone can be pointed at this Mac. */
interface StateEntry {
  seq: number;
  state: LanSessionState;
  /** Change signature, computed BEFORE any sealing — so an unchanged state costs zero AES. */
  sig: string;
  retiredAt?: number;
}

interface Waiter {
  resolve: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** A pid's process start time (epoch ms) via `ps -o lstart= -p <pid>`. LOCAL rendering, which is what
 *  `Date.parse` wants — the CC file's own `procStart` is UTC-rendered and must never be parsed this way
 *  (see session-state's parseCcProcStart). Undefined on any failure. */
/** Are these the same pairing key? Both absent counts as same (an unpaired feed stays unpaired). Plain
 *  byte compare — 32 bytes, once per sweep; nothing here is a secret-comparison timing surface (the
 *  caller already holds both). */
function sameKey(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function defaultProcStartedAt(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileP("ps", ["-o", "lstart=", "-p", String(pid)]);
    const parsed = Date.parse(String(stdout).trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Node's real directory watcher, wrapped so a throw (missing dir, exhausted FS handles) is just
 *  "no watcher". `persistent:false` + unref keep it from ever holding the daemon open. */
function defaultWatchDir(dir: string, onChange: () => void): LanFramesWatcher | null {
  try {
    const watcher = watch(dir, { persistent: false }, () => onChange()) as unknown as LanFramesWatcher;
    try { watcher.on?.("error", () => { /* a dead watcher degrades to the sweep feed */ }); } catch { /* exotic watcher */ }
    try { watcher.unref?.(); } catch { /* runtime without unref */ }
    return watcher;
  } catch {
    return null;
  }
}

/** THE data feed, and why it is what it is.
 *
 *  The records this feed serves are written by HOOK processes — short-lived, one per event, with no IPC
 *  to the watchdog — so the on-disk session store is the only surface the two sides share. Three options
 *  were available:
 *
 *   1. The 5 s sweep alone. Simple, and already running — but a 5 s worst case is SLOWER than the
 *      phone's own 3 s worker poll, so the feature would be pointless. Rejected.
 *   2. An IPC channel from the hooks (a socket/pipe write per event). Fastest, but it adds a failure
 *      mode to the hook's critical path, and a hook that blocks on a wedged daemon delays the user's
 *      agent. Rejected: the hook must stay free of the daemon.
 *   3. fs.watch on the store + the sweep as reconciler. CHOSEN. The write already happens (trackSession
 *      atomicWrite → rename), the watcher sees the rename within milliseconds, and nothing is added to
 *      the hook at all. fs.watch on macOS is documented-lossy (coalesced/dropped events, and it can go
 *      deaf entirely if the directory is replaced), so it is treated as an OPTIMIZATION: the watchdog's
 *      existing per-sweep reconcile re-reads the whole store every ~5 s and repairs anything the watcher
 *      missed. Worst case the feed degrades to option 1 — never to a wrong answer.
 *
 *  Both feeds run the same `reconcile()`; it is idempotent by construction (unchanged content ⇒ no
 *  counter bump), which is what makes the belt-and-braces overlap free. */
export function createLanFrameStore(deps: LanFrameStoreDeps = {}): LanFrameStore {
  const sessionsDir = deps.sessionsDir ?? (lanRunningUnderTest() ? undefined : SESSIONS_DIR);
  const isAlive = deps.isAlive ?? pidAlive;
  const now = deps.now ?? Date.now;
  const retireGraceMs = deps.retireGraceMs ?? LAN_FRAME_RETIRE_GRACE_MS;
  const debounceMs = deps.debounceMs ?? LAN_FRAMES_WATCH_DEBOUNCE_MS;
  const maxWaiters = deps.maxWaiters ?? LAN_FRAMES_WAITERS_MAX;
  const watchDir = deps.watchDir ?? defaultWatchDir;
  const ccSessionsDir = deps.ccSessionsDir ?? (lanRunningUnderTest() ? undefined : CC_SESSIONS_DIR);
  const procStartedAt = deps.procStartedAt ?? defaultProcStartedAt;

  /** Insertion-ordered by construction (Map) — only the seq ordering is load-bearing, but a stable
   *  iteration order keeps responses deterministic for a given state. */
  const entries = new Map<string, StoreEntry>();
  /** The v2 map, fed by the SAME reconcile pass off the SAME directory read. */
  const stateEntries = new Map<string, StateEntry>();
  /** Insertion-ordered (Set) so the waiter cap can evict the OLDEST. One set PER OP: a v2-only change
   *  (CC's status flipping while the record stands still) must not wake a v1 long-poll, which would only
   *  answer it with an empty frame list and cost an old phone a needless round trip. */
  const waiters = new Set<Waiter>();
  const stateWaiters = new Set<Waiter>();
  let counter = 0;
  /** The v2 change counter. DELIBERATELY SEPARATE from v1's: the two ops are separate cursors (a phone
   *  speaks one or the other, never both), and a shared counter would mean a v2-only state change
   *  silently renumbered the v1 projection — which is a wire change to an op whose response shape is
   *  frozen on both sides. One store, two feeds, two cursors, one waiter list. */
  let stateCounter = 0;
  /** Every cursor at or below this must be answered with the WHOLE map: it marks the last point at which
   *  the map was thrown away and rebuilt (a pairing rotation), so anything the phone remembers from
   *  before it is void. A fresh listener starts at 0, which is why a `sinceSeq:0` request is always
   *  `complete` — and why a phone whose stale-high cursor gets coerced to 0 is too. */
  let completeFromSeq = 0;
  let pairingId: string | undefined;
  let e2eKey: Uint8Array | undefined;
  let stopped = false;
  let watcher: LanFramesWatcher | null = null;
  let ccWatcher: LanFramesWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  /** Per-pid process-start probes. Populated once per pid, pruned to the pids still on disk each pass —
   *  the CC file's join verification must never cost a shell-out per sweep. */
  const procStartCache = new Map<number, number | undefined>();
  /** The capability latch (see CC_CAPABILITY_LATCH_SWEEPS), and the pid set that RE-ARMS it. The set is
   *  tracked separately from `procStartCache` because a latched-off feed takes no probes at all, so the
   *  probe cache could never tell us a new session had appeared. */
  const ccSeenPids = new Set<number>();
  let ccMissStreak = 0;
  let ccLatchedOff = false;
  /** Passes are SERIALIZED on one chain: two directory scans must never interleave (they would read a
   *  half-applied view of the same burst), and every caller's returned promise resolves only once a pass
   *  that started AFTER its call has finished — which is what makes `await reconcile()` mean "the map
   *  now reflects the store". Rejections are swallowed here so one bad pass can't poison the chain. */
  let chain: Promise<void> = Promise.resolve();

  const drop = (waiter: Waiter): void => {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    waiters.delete(waiter);
    stateWaiters.delete(waiter);
    try { waiter.resolve(); } catch { /* a broken waiter must not break the feed */ }
  };

  /** Wake EVERY waiter on a feed: each recomputes its own slice from its own cursor, so one broadcast is
   *  correct no matter what each was waiting for. */
  const wake = (set: Set<Waiter>): void => {
    for (const waiter of [...set]) drop(waiter);
  };

  /** Park a caller on one feed's waiter list until it is woken, dropped by the cap, or times out. */
  const park = async (set: Set<Waiter>, waitMs: number): Promise<void> => {
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => { settle = resolve; });
    const waiter: Waiter = { resolve: settle };
    set.add(waiter);
    // Cap: the OLDEST hold is answered (empty) rather than refused, so a phone that leaked a socket
    // re-arms cleanly instead of accumulating dead holds on this daemon.
    while (set.size > maxWaiters) {
      const oldest = set.values().next();
      if (oldest.done || oldest.value === waiter) break;
      drop(oldest.value);
    }
    const timer = setTimeout(() => drop(waiter), waitMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    waiter.timer = timer;
    await promise;
  };

  /** Stamp a session's new state, unless it is byte-identical to what the map already holds. Returns
   *  whether anything changed (the caller wakes the waiters ONCE per reconcile pass, not per session).
   *
   *  PER-SESSION MONOTONIC `ts` — the one adjustment this store makes to what it was handed, and the
   *  reason it exists: the phone's ordering guard drops a non-terminal frame whose stamp is not STRICTLY
   *  above the row it would replace (CCLanFramesMerge.accepts), so a state change reported at a stamp we
   *  have ALREADY reported for this session is a state change the phone throws away — and the row wedges
   *  until some later hook happens to rewrite the record.
   *
   *  That collision is not hypothetical, it is structural, and the hold overlay sits on both edges of
   *  it: the card is stamped max(record.ts, hold.at), so whenever hold.at ≤ record.ts the card AND the
   *  record's own frame carry the identical number. Entering, the card cannot displace the yellow
   *  needsAttention frame the phone already has; leaving, the released record cannot displace the card,
   *  which strands dead Allow/Deny buttons on the row (the worker's copy cannot break the tie either —
   *  it is FLOORED to whole seconds, so it never out-orders a LAN stamp for the same event).
   *
   *  So: content that genuinely CHANGED but did not advance is served one millisecond past the last
   *  stamp we sent. It is an honest claim — this IS a later state than the one we already described —
   *  and it is the whole rule, at the single choke point every frame in this store passes through.
   *  UNCHANGED content still returns false above, so nothing here inflates on a quiet reconcile. */
  const stamp = (sessionId: string, content: LanFrameContent, retiredAt?: number): boolean => {
    // Signed on the content AS GIVEN, never on the adjusted stamp: the signature's job is "is this the
    // same state?", and comparing an already-inflated number would make every pass look different.
    const sig = `${retiredAt === undefined ? "live" : "term"}|${JSON.stringify(content)}`;
    const prev = entries.get(sessionId);
    if (prev && prev.sig === sig && (prev.retiredAt === undefined) === (retiredAt === undefined)) return false;
    counter += 1;
    const ts = prev && content.ts <= prev.frame.ts ? prev.frame.ts + 1 : content.ts;
    entries.set(sessionId, {
      frame: { seq: counter, sessionId, ...content, ts },
      sig,
      ...(retiredAt === undefined ? {} : { retiredAt }),
    });
    return true;
  };

  /** The final frame for a session that has gone away: its last known blob, re-labelled op:"end" at
   *  prio 0 (the same "the row is over" semantics the worker's blob-less op:end carries — on LAN the
   *  blob rides along because there is no worker holding a copy to reuse). */
  const terminalContent = (frame: LanFrame, at: number): LanFrameContent => ({
    op: "end",
    prio: 0,
    ts: at,
    blob: frame.blob,
    ...(frame.agent ? { agent: frame.agent } : {}),
  });

  // --- the v2 snapshot half -----------------------------------------------------------------------

  /** A pid's process start, probed at most ONCE per pid for the life of this store. */
  const startOf = async (pid: number | undefined): Promise<number | undefined> => {
    if (typeof pid !== "number" || !Number.isFinite(pid)) return undefined;
    if (procStartCache.has(pid)) return procStartCache.get(pid);
    let value: number | undefined;
    try { value = await procStartedAt(pid); } catch { value = undefined; }
    procStartCache.set(pid, value);
    return value;
  };

  /** CC's own file for a pid, or null. One readFile per tracked CLAUDE session per pass, and none at all
   *  once the capability latch has tripped. Never throws. */
  const ccFileOf = async (pid: number | undefined): Promise<CcSessionFile | null> => {
    if (!ccSessionsDir || ccLatchedOff) return null;
    if (typeof pid !== "number" || !Number.isFinite(pid)) return null;
    try {
      return parseCcSessionFile(await readFile(`${ccSessionsDir}/${pid}.json`, "utf8"));
    } catch {
      return null;
    }
  };

  /** Commit one computed state, unless it is identical to what the map already holds.
   *
   *  THE SIGNATURE IS TAKEN BEFORE ANY SEALING, which is the whole cost model: a long poll over an
   *  unchanged map does zero AES, and a state change does exactly one. It cannot include the ciphertext
   *  (encryptBlob draws a fresh IV every call, so an identical plaintext would sign differently every
   *  pass); it signs the pre-seal description instead.
   *
   *  Returns whether anything changed. Never throws — a seal that fails simply leaves the session out of
   *  the v2 map, and absence is never evidence on the phone side. */
  const commitState = async (sessionId: string, computed: SessionState, at: number): Promise<boolean> => {
    const prev = stateEntries.get(sessionId);
    const blob = computed.blob;
    // "Reuse what you last served" — the record is gone, so the last blob (and the agent/startedAt that
    // rode with it) is all there is. Nothing to say when we never served one.
    if (blob.kind === "last" && !prev) return false;
    const blobSig = blob.kind === "sealed" ? `s:${blob.value}`
      : blob.kind === "plain" ? `p:${JSON.stringify(blob.value)}`
        : `l:${prev!.state.blob}`;
    const agent = blob.kind === "last" ? prev!.state.agent : (computed.agent === "codex" ? "codex" : undefined);
    const startedAt = blob.kind === "last" ? prev!.state.startedAt : computed.startedAt;
    // Never inherited through a `last` (that is a terminal row, which is nobody's open question).
    const asking = blob.kind === "last" ? undefined : computed.attentionKind;
    const sig = `${computed.terminal ? "term" : "live"}|${computed.ts}|${computed.why}|${agent ?? ""}`
      + `|${startedAt ?? ""}|${asking ?? ""}|${blobSig}`;
    if (prev && prev.sig === sig) return false;

    let sealed: string;
    if (blob.kind === "sealed") {
      sealed = blob.value;
    } else if (blob.kind === "last") {
      sealed = prev!.state.blob;
    } else {
      // The ONE thing this store opens its key for: a plaintext the MAC authored because no hook-written
      // blob describes the state we computed. Without a key there is nothing honest to serve.
      if (!e2eKey) return false;
      try { sealed = await encryptBlob(e2eKey, blob.value); } catch { return false; }
    }

    stateCounter += 1;
    stateEntries.set(sessionId, {
      seq: stateCounter,
      state: {
        sessionId,
        ts: computed.ts,
        terminal: computed.terminal,
        blob: sealed,
        ...(agent ? { agent } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(asking ? { attentionKind: asking } : {}),
        why: computed.why.slice(0, 16),
      },
      sig,
      ...(computed.terminal ? { retiredAt: at } : {}),
    });
    return true;
  };

  const reconcileOnce = async (): Promise<void> => {
    if (!sessionsDir) return;
    const at = now();
    let files: string[] = [];
    try {
      files = await readdir(sessionsDir);
    } catch {
      files = []; // no store yet — every known session reads as gone below, which is the honest answer
    }
    let changed = false;
    let stateChanged = false;
    const seen = new Set<string>();
    // ONE liveness probe per pid per pass, shared by both feeds. `pidAlive` is a `process.kill(pid, 0)`
    // syscall and a pass is a single instant, so asking twice is both wasted work and — worse — a chance
    // for the v1 projection and the v2 state to disagree about the same process inside one pass.
    const aliveCache = new Map<number, boolean>();
    const alive = (pid: number): boolean => {
      const memo = aliveCache.get(pid);
      if (memo !== undefined) return memo;
      const value = isAlive(pid);
      aliveCache.set(pid, value);
      return value;
    };
    // Which sessions have a hold marker beside them, from the listing we already have — so the common
    // case (no hold anywhere) costs ZERO extra reads, and a held session costs exactly one.
    const held = new Set<string>();
    for (const file of files) {
      if (file.endsWith(DECISION_HOLD_SUFFIX)) held.add(file.slice(0, -DECISION_HOLD_SUFFIX.length));
    }
    /** Latch bookkeeping for this pass: did we consult CC at all, did any file answer with a status, and
     *  did a pid we have never probed appear (which re-arms a tripped latch)? */
    let ccConsulted = false;
    let ccAnswered = false;
    let freshPid = false;
    const livePids = new Set<number>();
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const sessionId = basename(file, ".json");
      // Marked seen BEFORE the read: the file EXISTS, so this session is not "gone" even if this pass
      // catches it half-written (atomicWrite renames, but a foreign writer or a truncated file could).
      seen.add(sessionId);
      const v1Retired = entries.get(sessionId)?.retiredAt !== undefined; // already had its last word
      const v2Retired = stateEntries.get(sessionId)?.retiredAt !== undefined;
      if (v1Retired && v2Retired) continue;
      let record: SessionRecord | null = null;
      try {
        record = JSON.parse(await readFile(`${sessionsDir}/${file}`, "utf8")) as SessionRecord;
      } catch {
        continue; // unreadable/corrupt → leave whatever we already serve; the next pass re-reads it
      }
      let hold: DecisionHold | null = null;
      if (held.has(sessionId)) {
        try {
          hold = JSON.parse(await readFile(`${sessionsDir}/${decisionHoldFileName(sessionId)}`, "utf8")) as DecisionHold;
        } catch {
          hold = null; // removed mid-pass / half-written → this pass simply has no hold
        }
      }
      if (typeof record.pid === "number" && Number.isFinite(record.pid)) livePids.add(record.pid);

      // --- v1: the `frames` projection, byte-identical to what it has always served ------------------
      if (!v1Retired) {
        const content = lanFrameContent(record, pairingId, hold, at, alive);
        if (content) {
          changed = lanFrameSessionLive(record, at, alive)
            ? stamp(sessionId, content) || changed
            : stamp(sessionId, terminalContent({ seq: 0, sessionId, ...content }, at), at) || changed;
        }
      }

      // --- v2: the computed display state -----------------------------------------------------------
      if (!v2Retired) {
        // CC is consulted for CLAUDE, non-provisional sessions only: there is no CC-equivalent for Codex,
        // and a provisional row's `pid` is an immortal app-server rather than a session process. Both stay
        // on the record-only path, and say so on the wire through the `/cx` suffix.
        const askCc = record.agent !== "codex" && record.provisional !== true;
        let cc: CcSessionFile | null = null;
        let ccProcStartedAt: number | undefined;
        if (askCc && ccSessionsDir) {
          // Noted whether or not the latch is down — it is what re-arms it, and a latched feed takes no
          // probes at all, so nothing else could tell us a new session has started.
          if (typeof record.pid === "number" && Number.isFinite(record.pid) && !ccSeenPids.has(record.pid)) {
            freshPid = true;
            ccSeenPids.add(record.pid);
          }
          if (!ccLatchedOff) {
            ccConsulted = true;
            cc = await ccFileOf(record.pid);
            if (cc?.status === "busy" || cc?.status === "idle") ccAnswered = true;
            ccProcStartedAt = await startOf(record.pid);
          }
        }
        const computed = computeSessionState({
          sessionId,
          record,
          pairingId,
          hold,
          pidAlive: typeof record.pid === "number" && Number.isFinite(record.pid) ? alive(record.pid) : false,
          holdPidAlive: hold && typeof hold.pid === "number" && Number.isFinite(hold.pid) ? alive(hold.pid) : false,
          cc,
          ccProcStartedAt,
          now: at,
        });
        if (computed) stateChanged = await commitState(sessionId, computed, at) || stateChanged;
      }
    }
    for (const [sessionId, entry] of [...entries]) {
      if (entry.retiredAt === undefined && !seen.has(sessionId)) {
        // The record was deleted (a clean op:end, a reap, a retire) — one final frame, then the grace.
        changed = stamp(sessionId, terminalContent(entry.frame, at), at) || changed;
        continue;
      }
      // Past the grace a terminal session leaves the map. This is NOT a frame: the phone was already
      // told the session ended, and "absence in a LAN response" is never evidence on the phone side.
      if (entry.retiredAt !== undefined && at - entry.retiredAt > retireGraceMs) entries.delete(sessionId);
    }
    for (const [sessionId, entry] of [...stateEntries]) {
      if (entry.retiredAt === undefined && !seen.has(sessionId)) {
        // The record vanished. The state machine's answer for a null record is `ended` / `reap` carrying
        // "re-serve the last blob", which is what keeps a reconnecting phone learning the session ended
        // instead of watching a row disappear.
        const gone = computeSessionState({ sessionId, record: null, pairingId, pidAlive: false, now: at });
        if (gone) stateChanged = await commitState(sessionId, gone, at) || stateChanged;
        continue;
      }
      if (entry.retiredAt !== undefined && at - entry.retiredAt > retireGraceMs) stateEntries.delete(sessionId);
    }
    // The capability latch, and its re-arm. A pass that consulted CC and got no usable status anywhere
    // counts against the streak; a pass that got one — or that saw a pid we have never probed — clears it.
    if (freshPid) {
      ccMissStreak = 0;
      ccLatchedOff = false;
    } else if (ccConsulted) {
      ccMissStreak = ccAnswered ? 0 : ccMissStreak + 1;
      if (ccMissStreak >= CC_CAPABILITY_LATCH_SWEEPS) ccLatchedOff = true;
    }
    // Keep the probe cache to the pids still on disk, so a long-lived daemon does not accumulate one
    // entry per session it has ever seen.
    for (const pid of [...procStartCache.keys()]) {
      if (!livePids.has(pid)) procStartCache.delete(pid);
    }
    for (const pid of [...ccSeenPids]) {
      if (!livePids.has(pid)) ccSeenPids.delete(pid);
    }
    if (changed) wake(waiters);
    if (stateChanged) wake(stateWaiters);
  };

  const store: LanFrameStore = {
    seq(): number {
      return counter;
    },
    since(sinceSeq: number): LanFramesSlice {
      // A cursor ABOVE our counter can only come from a previous listener instance (the counter is
      // in-memory and restarts at 0). Treating it as 0 hands back the full current map, so a phone that
      // missed the lid change still converges instead of silently waiting forever on frames that were
      // stamped with numbers it already believes it has seen.
      const from = !Number.isFinite(sinceSeq) || sinceSeq < 0 || sinceSeq > counter ? 0 : sinceSeq;
      const frames: LanFrame[] = [];
      for (const entry of entries.values()) {
        if (entry.frame.seq > from) frames.push(entry.frame);
      }
      frames.sort((a, b) => a.seq - b.seq);
      return { seq: counter, frames };
    },
    async wait(sinceSeq: number, waitMs: number): Promise<LanFramesSlice> {
      const immediate = store.since(sinceSeq);
      if (stopped || waitMs <= 0 || immediate.frames.length > 0) return immediate;
      await park(waiters, waitMs);
      return store.since(sinceSeq);
    },
    states(sinceSeq: number): LanStateSlice {
      // Same cursor coercion as `since`, and for the same reason — but here it is also what makes a phone
      // that missed a `lid` change get told so: a coerced cursor is a `complete` answer.
      const from = !Number.isFinite(sinceSeq) || sinceSeq < 0 || sinceSeq > stateCounter ? 0 : sinceSeq;
      const complete = from === 0 || from <= completeFromSeq;
      const picked: StateEntry[] = [];
      for (const entry of stateEntries.values()) {
        if (complete || entry.seq > from) picked.push(entry);
      }
      picked.sort((a, b) => a.seq - b.seq);
      // The per-response ceiling. Sized to the worker's own per-pairing cap; the overflow is dropped by
      // LAST ACTIVITY, so what survives is what the user is most likely looking at, and what does not
      // simply stays worker-driven on the phone.
      const capped = picked.length <= LAN_STATE_SESSIONS_MAX
        ? picked
        : [...picked].sort((a, b) => b.state.ts - a.state.ts).slice(0, LAN_STATE_SESSIONS_MAX)
          .sort((a, b) => a.seq - b.seq);
      return { seq: stateCounter, at: now(), complete, sessions: capped.map((entry) => entry.state) };
    },
    async waitStates(sinceSeq: number, waitMs: number): Promise<LanStateSlice> {
      const immediate = store.states(sinceSeq);
      // A `complete` answer is never held once the map has ever carried anything: the phone's link-up
      // handoff is gated on exactly that response (nothing is LAN-owned until one lands), so holding it
      // for 25 s would leave every row worker-driven for the whole poll. `counter > 0` is what keeps that
      // from becoming a busy loop on a Mac with no sessions at all — there the cursor cannot advance, so
      // the request is held like any other.
      if (stopped || waitMs <= 0 || immediate.sessions.length > 0 || (immediate.complete && stateCounter > 0)) {
        return immediate;
      }
      await park(stateWaiters, waitMs);
      return store.states(sinceSeq);
    },
    setPairing(next: string | undefined, key?: Uint8Array): void {
      // The KEY is compared too, not just the id: a re-pair can in principle keep the pairing id while
      // ROTATING the key, and a stale key would seal Mac-authored plaintexts nothing can open. LEARNING a
      // key we did not have is not a rotation, though — every cached blob is the HOOK's, already sealed
      // under the pairing key, so nothing cached is voided by finding out what that key is.
      const rotated = next !== pairingId
        || (e2eKey !== undefined && key !== undefined && !sameKey(e2eKey, key));
      pairingId = next;
      e2eKey = key;
      if (!rotated) return;
      // Every cached frame was sealed under the OLD pairing key; none of them can be rendered by the
      // phone that holds the new one. Drop them all and let the next reconcile rebuild — the counter
      // deliberately keeps climbing, so the rebuild reaches the phone as ordinary new frames.
      entries.clear();
      stateEntries.clear();
      // Everything the phone remembers from before this point is void, so every cursor at or below the
      // current counter must be answered with the whole rebuilt map.
      completeFromSeq = stateCounter;
      void store.reconcile();
    },
    async readFull(sessionId: string, what: LanReadWhat): Promise<LanFullRead | null> {
      try {
        if (!sessionsDir) return null;
        if (!LAN_SESSION_ID_RE.test(sessionId)) return null; // charset gate == path-traversal gate
        let record: SessionRecord;
        try {
          record = JSON.parse(await readFile(`${sessionsDir}/${sessionId}.json`, "utf8")) as SessionRecord;
        } catch {
          return null; // absent / unreadable / corrupt — all "not found" from the phone's side
        }
        // The SAME pairing guard lanFrameContent applies: a record left behind by a previous pairing
        // belongs to a phone that no longer exists here, and its content is not this caller's to read.
        if (pairingId === undefined || record.pairingId !== pairingId) return null;
        if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return null;
        if (now() - record.ts > LAN_FRAME_SESSION_STALE_MS) return null; // expired, like every other read of this store
        const content = what === "plan" ? record.planFull : record.permissionDetailFull;
        if (typeof content !== "string" || content.length === 0) return null;
        return { content, complete: recordFullTextIsComplete(content) };
      } catch {
        return null; // a read is best-effort; the phone falls back to the truncated blob copy
      }
    },
    reconcile(): Promise<void> {
      if (stopped) return Promise.resolve();
      chain = chain.then(async () => {
        if (stopped) return;
        try { await reconcileOnce(); } catch { /* the feed is best-effort; the next pass retries */ }
        // Belt-and-braces re-arm: a watcher that errored out (or a store directory that did not exist
        // at start()) gets another chance on every pass, at the cost of one syscall.
        if (!stopped && !watcher) store.start();
      }).catch(() => { /* one bad pass must never poison the chain, nor surface as an unhandled rejection */ });
      return chain;
    },
    start(): void {
      if (stopped) return;
      const bump = (): void => {
        if (stopped) return;
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          void store.reconcile();
        }, debounceMs);
        (debounce as unknown as { unref?: () => void }).unref?.();
      };
      if (!watcher && sessionsDir) watcher = watchDir(sessionsDir, bump);
      // CC's directory gets its OWN watcher on the SAME debounce: a `status` flip is a state change here
      // even though nothing in our own store moved, and waiting for the 5 s sweep would give the premature
      // -done and missed-done cases a 5 s tail the whole design exists to remove. Lossy exactly like the
      // other one, and reconciled by the same sweep.
      if (!ccWatcher && ccSessionsDir) ccWatcher = watchDir(ccSessionsDir, bump);
    },
    stop(): void {
      stopped = true;
      if (debounce !== undefined) {
        clearTimeout(debounce);
        debounce = undefined;
      }
      const dying = watcher;
      watcher = null;
      try { dying?.close(); } catch { /* already closed */ }
      const dyingCc = ccWatcher;
      ccWatcher = null;
      try { dyingCc?.close(); } catch { /* already closed */ }
      // No held response may outlive the listener: every waiter resolves so its handler can answer (on a
      // socket that is being destroyed anyway) instead of hanging until the client's own timeout.
      wake(waiters);
      wake(stateWaiters);
    },
    size(): number {
      return entries.size;
    },
  };
  return store;
}
