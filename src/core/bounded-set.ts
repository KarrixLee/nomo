// bounded-set — the replay/dedupe primitive the command path is built on.
//
// THREE bounded string sets guard this machine against acting on the same phone intent twice, and they
// had grown two byte-identical private copies of the same eviction helper: the watchdog's
// `seenCommandNonces` and `executedCommandIds` (the INNER, e2eKey-sealed ids that arrive on the worker
// leg) and the LAN listener's OUTER-envelope nonce set. One home, so a change to the eviction rule
// cannot land on one channel and miss the other.
//
// SHARING THE HELPER IS NOT SHARING THE SETS, and that distinction is load-bearing: keeping the outer
// and inner sets separate is precisely what stops a flood of junk LAN envelopes from evicting a real
// command's inner nonce and reopening the cross-channel replay window (see LAN_SEEN_NONCES_MAX).
//
// WHY ITS OWN MODULE rather than shared.ts: shared.ts is bundled into all ten entrypoints, and eight of
// them — pair, unpair, reset, status-cmd, the status hooks — never dedupe anything. Both real consumers
// land in exactly one artifact (dist/cc-watchdog.mjs), so a leaf module keeps this out of the bundles
// that have no use for it. Same reasoning that gave lan-wire.ts its own file.

/** Add to a bounded insertion-ordered set, evicting oldest-first once full. Insertion order is what
 *  makes the eviction FIFO; `Set` guarantees it. Pure. */
export function rememberBounded(set: Set<string>, value: string, max: number): void {
  set.add(value);
  while (set.size > max) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}
