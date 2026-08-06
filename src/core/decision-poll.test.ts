import { describe, expect, test } from "bun:test";
import {
  createPollBudget, MAX_CONSECUTIVE_MISSES, POLL_BUDGET_LATENCY_FACTOR,
  POLL_FIRST_CONTACT_TIMEOUT_MS, POLL_INTERVAL_MS, POLL_JITTER_MAX_MS, POLL_LATENCY_SAMPLES,
  POLL_TIMEOUT_CEILING_MS, POLL_TIMEOUT_MS, WORKER_DECISION_STALE_MS,
} from "./decision-poll";

/** The field trace's first-contact round trip through the user's tunnel (2026-08-04): the ONE poll that
 *  completed, at 3306 ms, before four consecutive 2 s steady-state GETs all timed out. */
const TUNNEL_MS = 3_306;
/** A healthy warm round trip, measured against api.nomo.gg from this Mac under both bun and node. */
const HEALTHY_MS = 87;

const feed = (budget: { observe: (ms: number) => void }, ms: number, times: number): void => {
  for (let i = 0; i < times; i += 1) budget.observe(ms);
};

describe("createPollBudget — the adaptive steady-state poll ceiling", () => {
  test("with nothing measured yet it IS v1.6.6: the first-contact floor, then the steady-state floor", () => {
    const budget = createPollBudget();
    expect(budget.next(0)).toBe(POLL_FIRST_CONTACT_TIMEOUT_MS); // the did-it-land probe
    expect(budget.next(1)).toBe(POLL_FIRST_CONTACT_TIMEOUT_MS); // a fresh hold's first GET
    expect(budget.next(2)).toBe(POLL_TIMEOUT_MS);
    expect(budget.next(97)).toBe(POLL_TIMEOUT_MS);
  });

  test("a FAST network keeps the snappy 2 s — the adaptive path costs a healthy Mac nothing", () => {
    const budget = createPollBudget();
    feed(budget, HEALTHY_MS, POLL_LATENCY_SAMPLES);
    expect(budget.next(2)).toBe(POLL_TIMEOUT_MS);
    // …and the first-contact floor is a FLOOR, never lowered by a fast reading.
    expect(budget.next(1)).toBe(POLL_FIRST_CONTACT_TIMEOUT_MS);
  });

  test("the field tunnel: ONE measured 3306 ms round trip sizes every later poll to a budget it can meet", () => {
    const budget = createPollBudget();
    budget.observe(TUNNEL_MS);                                  // seq 1 succeeded — the natural probe
    expect(budget.next(2)).toBe(POLL_TIMEOUT_CEILING_MS);        // 3 × 3306 = 9918 → clamped
    expect(budget.next(2)).toBeGreaterThan(TUNNEL_MS);           // the whole point: it can be met
  });

  test("adapts UP proportionally in the middle of the range", () => {
    const budget = createPollBudget();
    feed(budget, 900, POLL_LATENCY_SAMPLES);
    expect(budget.next(2)).toBe(900 * POLL_BUDGET_LATENCY_FACTOR); // 2700 — between the floor and ceiling
  });

  test("clamped at BOTH ends — a 1 ms LAN and a 60 s tarpit both land inside [floor, ceiling]", () => {
    const fast = createPollBudget();
    feed(fast, 1, POLL_LATENCY_SAMPLES);
    expect(fast.next(2)).toBe(POLL_TIMEOUT_MS);

    const tarpit = createPollBudget();
    feed(tarpit, 60_000, POLL_LATENCY_SAMPLES);
    expect(tarpit.next(2)).toBe(POLL_TIMEOUT_CEILING_MS);
    expect(tarpit.next(1)).toBe(POLL_TIMEOUT_CEILING_MS);        // the ceiling outranks the first-contact floor
  });

  test("a SINGLE slow outlier does not pin the budget high", () => {
    const budget = createPollBudget();
    feed(budget, HEALTHY_MS, POLL_LATENCY_SAMPLES);
    budget.observe(9_000);                                       // one GC pause / one wifi hiccup
    expect(budget.next(2)).toBe(POLL_TIMEOUT_MS);                // the window's median shrugs it off
    budget.observe(9_000);                                       // …two is still not a trend
    expect(budget.next(2)).toBe(POLL_TIMEOUT_MS);
    budget.observe(9_000);                                       // three of five IS one
    expect(budget.next(2)).toBe(POLL_TIMEOUT_CEILING_MS);
  });

  test("and it comes back DOWN — a recovered network is not stuck paying the tunnel's ceiling", () => {
    const budget = createPollBudget();
    feed(budget, TUNNEL_MS, POLL_LATENCY_SAMPLES);
    expect(budget.next(2)).toBe(POLL_TIMEOUT_CEILING_MS);
    feed(budget, HEALTHY_MS, POLL_LATENCY_SAMPLES);              // the window is BOUNDED: the stall ages out
    expect(budget.next(2)).toBe(POLL_TIMEOUT_MS);
  });

  test("garbage measurements are ignored, never trusted into the estimate", () => {
    const budget = createPollBudget();
    feed(budget, HEALTHY_MS, POLL_LATENCY_SAMPLES);
    budget.observe(-1);                     // a backwards clock step (NTP)
    budget.observe(Number.NaN);
    budget.observe(Number.POSITIVE_INFINITY);
    expect(budget.next(2)).toBe(POLL_TIMEOUT_MS);
  });
});

// ---- THE HARD CONSTRAINT ------------------------------------------------------------------------
// The worker expires a pending decision record after DECISION_STALE_MS (30 s) of POLL SILENCE
// (server/src/decision.ts). A budget generous enough that two consecutive polls can span more than that
// window would expire the very hold it is trying to keep alive — the adaptive ceiling is bounded by this
// arithmetic, not by taste.
describe("poll cadence vs the worker's 30 s decision-staleness expiry", () => {
  test("the worst-case cycle at the MAXIMUM budget stays comfortably under the expiry", () => {
    // ONE cycle = the poll's own ceiling + the sleep that follows it (interval + jitter).
    const worstCycleMs = POLL_TIMEOUT_CEILING_MS + POLL_INTERVAL_MS + POLL_JITTER_MAX_MS;
    expect(worstCycleMs).toBe(11_500);
    expect(worstCycleMs).toBeLessThanOrEqual(WORKER_DECISION_STALE_MS / 2);

    // …and the CONSERVATIVE bound the worker actually measures: it stamps last-seen when a GET ARRIVES,
    // so the widest gap between two arrivals is one poll that lands at the very START of its budget
    // followed by one that lands at the very END of the next — two full budgets plus the sleep between.
    const worstArrivalGapMs = 2 * POLL_TIMEOUT_CEILING_MS + POLL_INTERVAL_MS + POLL_JITTER_MAX_MS;
    expect(worstArrivalGapMs).toBe(19_500);
    expect(worstArrivalGapMs).toBeLessThan(WORKER_DECISION_STALE_MS);
    expect(WORKER_DECISION_STALE_MS - worstArrivalGapMs).toBeGreaterThanOrEqual(10_000);
  });

  test("no observation sequence can push the budget past the ceiling", () => {
    const budget = createPollBudget();
    for (const ms of [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 0, 5, 86_400_000]) {
      budget.observe(ms);
      for (const seq of [0, 1, 2, 3, MAX_CONSECUTIVE_MISSES]) {
        expect(budget.next(seq)).toBeLessThanOrEqual(POLL_TIMEOUT_CEILING_MS);
        expect(budget.next(seq)).toBeGreaterThanOrEqual(POLL_TIMEOUT_MS);
      }
    }
  });

  test("the mirrored worker constant is the real one", () => {
    // server/src/decision.ts: `const DECISION_STALE_MS = 30_000;`
    expect(WORKER_DECISION_STALE_MS).toBe(30_000);
    expect(POLL_JITTER_MAX_MS).toBe(500);
    expect(POLL_TIMEOUT_CEILING_MS).toBe(8_000);
    expect(POLL_BUDGET_LATENCY_FACTOR).toBe(3);
    expect(POLL_LATENCY_SAMPLES).toBe(5);
  });
});
