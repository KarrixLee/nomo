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
// PHASE 4 (`readFull`) is the ONE deliberate exception, and it never crosses the worker: the unabridged
// plan / permission detail the hook teed onto the record is plaintext, and it is served plaintext into
// the listener's K_lan OUTER seal. That is still E2E between this Mac and the paired phone — the content
// simply rides one seal instead of two, because there is no blind relay in the middle to be blind.

import { watch } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { LAN_SESSION_ID_RE, lanRunningUnderTest } from "./lan-wire";
import type { LanReadWhat } from "./lan-wire";
import { pidAlive, recordFullTextIsComplete, SESSIONS_DIR } from "./shared";
import type { AgentKind, CCOp, SessionRecord } from "./shared";

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
export function lanFrameContent(record: SessionRecord, pairingId: string | undefined): LanFrameContent | null {
  if (typeof record.blob !== "string" || record.blob.length === 0) return null;
  if (pairingId === undefined || record.pairingId !== pairingId) return null;
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return null;
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
  /** Point the feed at the CURRENT pairing. A rotation voids every cached frame (they are sealed under
   *  the old key), so the map is cleared and rebuilt. */
  setPairing(pairingId: string | undefined): void;
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

interface Waiter {
  resolve: () => void;
  timer?: ReturnType<typeof setTimeout>;
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

  /** Insertion-ordered by construction (Map) — only the seq ordering is load-bearing, but a stable
   *  iteration order keeps responses deterministic for a given state. */
  const entries = new Map<string, StoreEntry>();
  /** Insertion-ordered (Set) so the waiter cap can evict the OLDEST. */
  const waiters = new Set<Waiter>();
  let counter = 0;
  let pairingId: string | undefined;
  let stopped = false;
  let watcher: LanFramesWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
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
    try { waiter.resolve(); } catch { /* a broken waiter must not break the feed */ }
  };

  /** Wake EVERY waiter: each recomputes its own slice from its own cursor, so one broadcast is correct
   *  no matter what each was waiting for. */
  const wake = (): void => {
    for (const waiter of [...waiters]) drop(waiter);
  };

  /** Stamp a session's new state, unless it is byte-identical to what the map already holds. Returns
   *  whether anything changed (the caller wakes the waiters ONCE per reconcile pass, not per session). */
  const stamp = (sessionId: string, content: LanFrameContent, retiredAt?: number): boolean => {
    const sig = `${retiredAt === undefined ? "live" : "term"}|${JSON.stringify(content)}`;
    const prev = entries.get(sessionId);
    if (prev && prev.sig === sig && (prev.retiredAt === undefined) === (retiredAt === undefined)) return false;
    counter += 1;
    entries.set(sessionId, {
      frame: { seq: counter, sessionId, ...content },
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
    const seen = new Set<string>();
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const sessionId = basename(file, ".json");
      // Marked seen BEFORE the read: the file EXISTS, so this session is not "gone" even if this pass
      // catches it half-written (atomicWrite renames, but a foreign writer or a truncated file could).
      seen.add(sessionId);
      if (entries.get(sessionId)?.retiredAt !== undefined) continue; // already had its last word
      let record: SessionRecord | null = null;
      try {
        record = JSON.parse(await readFile(`${sessionsDir}/${file}`, "utf8")) as SessionRecord;
      } catch {
        continue; // unreadable/corrupt → leave whatever we already serve; the next pass re-reads it
      }
      const content = lanFrameContent(record, pairingId);
      if (!content) continue; // nothing renderable (no blob / other pairing / un-orderable)
      changed = lanFrameSessionLive(record, at, isAlive)
        ? stamp(sessionId, content) || changed
        : stamp(sessionId, terminalContent({ seq: 0, sessionId, ...content }, at), at) || changed;
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
    if (changed) wake();
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
      let settle!: () => void;
      const promise = new Promise<void>((resolve) => { settle = resolve; });
      const waiter: Waiter = { resolve: settle };
      waiters.add(waiter);
      // Cap: the OLDEST hold is answered (empty) rather than refused, so a phone that leaked a socket
      // re-arms cleanly instead of accumulating dead holds on this daemon.
      while (waiters.size > maxWaiters) {
        const oldest = waiters.values().next();
        if (oldest.done || oldest.value === waiter) break;
        drop(oldest.value);
      }
      const timer = setTimeout(() => drop(waiter), waitMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      waiter.timer = timer;
      await promise;
      return store.since(sinceSeq);
    },
    setPairing(next: string | undefined): void {
      if (next === pairingId) return;
      pairingId = next;
      // Every cached frame was sealed under the OLD pairing key; none of them can be rendered by the
      // phone that holds the new one. Drop them all and let the next reconcile rebuild — the counter
      // deliberately keeps climbing, so the rebuild reaches the phone as ordinary new frames.
      entries.clear();
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
      if (stopped || watcher || !sessionsDir) return;
      watcher = watchDir(sessionsDir, () => {
        if (stopped) return;
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          void store.reconcile();
        }, debounceMs);
        (debounce as unknown as { unref?: () => void }).unref?.();
      });
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
      // No held response may outlive the listener: every waiter resolves so its handler can answer (on a
      // socket that is being destroyed anyway) instead of hanging until the client's own timeout.
      wake();
    },
    size(): number {
      return entries.size;
    },
  };
  return store;
}
