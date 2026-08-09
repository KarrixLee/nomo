import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptBlob, encryptBlob } from "../core/crypto";
import { createLanAnswerStore } from "../core/lan-listener";
import type { DecisionHold, PlanPickerTraceDecision, SessionRecord } from "../core/shared";
import { GONE_STRIKE_LIMIT, readGoneStrikes, recordGoneStrike, resetGoneStrikes, tracePlanPickerDecision } from "../core/shared";
import {
  acceptLanAnswer, acceptLanCommand, enqueueDrainCommands, LAN_ANSWER_ECHO_DELAY_MS, LAN_COMMAND_ID_PREFIX,
  buildDoneEnvelope, buildEndEnvelope, buildHeartbeatEnvelope, buildNeedsAttentionEnvelope, buildProvisionalBlob,
  buildProvisionalEnvelope, buildProvisionalRecord, buildStartEnvelope, buildTitleRepairEnvelope, classifySession,
  claudeTailPendingApproval, codexLastTurnEvent, codexTailPendingApproval, correctIdleClaude, correctInterrupt,
  CODEX_TUI_SESSION_START_SKEW_MS, correlateCodexTuiPid, resolveCodexTuiOwner,
  COMMAND_FUTURE_SKEW_MS, COMMAND_TTL_MS, commandIsFresh,
  codexBridgeIsDown, correctPendingApproval, correctPendingDone, correctPlanPickerVerification, correctResolvedPlanPicker, createBridgeSupervisor, discoverLiveSessions, drainCommands, effectiveDoneAttempts, extractCommands, goneStrikeShouldTeardown,
  enforceWatchdogOwnership, hasInterruptMarker, IDLE_GRACE_MS, isClaudeIdleReapEligible, isRetireEligible, isRightfulWatchdogOwner, lastTurnLine, PAIRING_TTL_MS, pendingDoneRetryWrite,
  pendingDoneSettleWrite, pendingPairingExpired, planPickerPendingExpired, PLAN_PICKER_PENDING_MAX_MS, pruneStaleDecisionHolds,
  PLAN_PICKER_RECENT_DONE_MS, PLAN_PICKER_VERIFY_MAX_MS, RETIRE_AFTER_MS,
  buildWorkingEnvelope, postOutcomeForStatus, provisionalsCoveredByReal, reconcileProvisionalsSweep, recordMovedSince, resetCommandState, resetDoneAttemptMemory, retireDoneStale,
  setCodexBridgeDown, shouldHeartbeat, shouldIdleProvisionalCheck,
  heartbeatKind, isWaitingSession,
  shouldInterruptCheck, shouldPendingApprovalCheck, shouldPendingDoneCheck, shouldPlanPickerVerificationCheck, shouldRepairTitle, tailShowsInterrupt, titleRepairedRecord,
  watchdogEventHeaders, WAITING_HEARTBEAT_AFTER_MS, withDeadline,
} from "./cc-watchdog";
import type { CommandPayload, DrainCommandsDeps, PostOutcome, RecordEntry } from "./cc-watchdog";
import { resolveOnRelay } from "../core/codex-remote-input";
import { CODEX_PROXY_STDOUT_ENDED } from "../core/codex-proxy-transport";
import { STATE_HOLD_MAX_AGE_MS } from "../core/session-state";
import { claudeAdapter, codexAdapter } from "../core/adapter";
import type { AgentAdapter, DiscoveredSession } from "../core/adapter";
import type { Config, PendingConfig } from "../core/shared";

const KEY = new Uint8Array(32).fill(9);

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  pid: 4242, machine: "mac", label: "proj", ts: 1_000_000, ...over,
});

// The corrective-done retry bound is now ALSO held in module-global memory (so a persistently-failing
// record write can't unbound it — see effectiveDoneAttempts). That state is per-process, exactly as it is
// in the real daemon, so each test starts from a fresh daemon's view of the world.
beforeEach(() => { resetDoneAttemptMemory(); });

describe("per-sweep watchdog pidfile ownership", () => {
  test("a non-owner self-exits at the sweep gate and cleans up its bridge/proxy children", () => {
    let childCleanups = 0;
    expect(enforceWatchdogOwnership(
      () => { childCleanups++; },
      { pid: 111, version: "1.4.4", readPidfile: () => "222 1.4.4" },
    )).toBe(false);
    expect(childCleanups).toBe(1);
  });

  test("an own-pid version mismatch self-exits (a newer build has superseded this daemon)", () => {
    let childCleanups = 0;
    expect(enforceWatchdogOwnership(
      () => { childCleanups++; },
      { pid: 111, version: "1.4.4", readPidfile: () => "111 1.4.5" },
    )).toBe(false);
    expect(childCleanups).toBe(1);
  });

  test("the rightful pid + version owner keeps running and leaves children intact", () => {
    let childCleanups = 0;
    const deps = { pid: 111, version: "1.4.4", readPidfile: () => "111 1.4.4" };
    expect(isRightfulWatchdogOwner(deps)).toBe(true);
    expect(enforceWatchdogOwnership(() => { childCleanups++; }, deps)).toBe(true);
    expect(childCleanups).toBe(0);
  });
});

describe("classifySession", () => {
  const alive = () => true;
  const dead = () => false;

  test("a live pid within the window → keep", () => {
    expect(classifySession(rec(), rec().ts, alive)).toBe("keep");
  });

  test("a dead pid within the window → end (its op:end gets POSTed)", () => {
    expect(classifySession(rec(), rec().ts, dead)).toBe("end");
  });

  test("a malformed / unparsable record → delete", () => {
    expect(classifySession(null, rec().ts, dead)).toBe("delete");
    expect(classifySession({ machine: "m", label: "l", ts: 1 } as unknown as SessionRecord, 1, dead)).toBe("delete");
    expect(classifySession({ pid: Number.NaN, machine: "m", label: "l", ts: 1 } as SessionRecord, 1, dead)).toBe("delete");
  });

  test("a stale (>24h) VALID file → stale (POST a terminal end, then delete), regardless of liveness", () => {
    const now = rec().ts + 86_400_000 + 1;
    expect(classifySession(rec(), now, dead)).toBe("stale");
    expect(classifySession(rec(), now, alive)).toBe("stale");
  });

  test("a record with no timestamp → delete (un-ageable, nothing to POST)", () => {
    expect(classifySession({ pid: 4242, machine: "m", label: "l" } as unknown as SessionRecord, 1, dead)).toBe("delete");
  });

  test("the decision is driven purely by the injected predicate (no real process probed)", () => {
    const seen: number[] = [];
    classifySession(rec({ pid: 777 }), rec().ts, (p) => { seen.push(p); return false; });
    expect(seen).toEqual([777]);
  });

  test("a correlated Codex row is owned by tuiPid, not its immortal app-server pid", () => {
    const row = rec({ agent: "codex", pid: 937, tuiPid: 64799 });
    expect(classifySession(row, row.ts, (pid) => pid === 937)).toBe("end");
    expect(classifySession(row, row.ts, (pid) => pid === 64799)).toBe("keep");
  });

  test("a retired-owner marker stays only while its TUI lives, then deletes without another end", () => {
    const marker = rec({ agent: "codex", pid: 64799, tuiPid: 64799, retiredAt: 2_000_000 });
    expect(classifySession(marker, marker.ts + 90_000_000, (pid) => pid === 64799)).toBe("keep");
    expect(classifySession(marker, marker.ts + 90_000_000, () => false)).toBe("delete");
  });
});

describe("isClaudeIdleReapEligible (a resumed Claude session gone silent past the reap grace)", () => {
  const REAP_MS = 1_800_000; // must mirror CLAUDE_IDLE_REAP_MS in cc-watchdog.ts
  const now = 100_000_000;

  test("a working Claude session idle ≥30 min → eligible; just under → not", () => {
    expect(isClaudeIdleReapEligible(rec({ lastEvent: "working", ts: now - REAP_MS }), now)).toBe(true);
    expect(isClaudeIdleReapEligible(rec({ lastEvent: "working", ts: now - REAP_MS + 1 }), now)).toBe(false);
  });

  test("a resumed session (lastEvent sessionStart) idle past the grace → eligible", () => {
    expect(isClaudeIdleReapEligible(rec({ lastEvent: "sessionStart", ts: now - REAP_MS }), now)).toBe(true);
  });

  test("needsAttention and done are NEVER reaped (a permission wait can sit >30 min; done is finished)", () => {
    expect(isClaudeIdleReapEligible(rec({ lastEvent: "needsAttention", ts: now - REAP_MS * 10 }), now)).toBe(false);
    expect(isClaudeIdleReapEligible(rec({ lastEvent: "done", ts: now - REAP_MS * 10 }), now)).toBe(false);
  });

  test("codex sessions and provisional rows are left to their own machinery", () => {
    expect(isClaudeIdleReapEligible(rec({ agent: "codex", lastEvent: "working", ts: now - REAP_MS * 5 }), now)).toBe(false);
    expect(isClaudeIdleReapEligible(rec({ provisional: true, lastEvent: "working", ts: now - REAP_MS * 5 }), now)).toBe(false);
  });

  test("the heartbeat and the reaper AGREE — a reap-eligible session is never heartbeated back to working", () => {
    const idle = rec({ lastEvent: "working", ts: now - REAP_MS });
    // quiet + alive + never-heartbeated + uncorrected would normally heartbeat, but the reap guard wins.
    expect(shouldHeartbeat(idle, now, undefined, false)).toBe(false);
    // A shorter (5–30 min) silence is still heartbeated — that window is a legit long tool run.
    expect(shouldHeartbeat(rec({ lastEvent: "working", ts: now - 600_000 }), now, undefined, false)).toBe(true);
  });

  test("idle reap: a FRESH transcript mtime vetoes eligibility (turn still alive)", () => {
    const now = 10_000_000_000;
    const rec = { pid: 1, machine: "m", label: "l", ts: now - 2_000_000, lastEvent: "working",
                  transcript: "/tmp/t.jsonl" } as SessionRecord; // 33 min event-idle
    // transcript written 3 min ago → alive → NOT eligible
    expect(isClaudeIdleReapEligible(rec, now, () => now - 180_000)).toBe(false);
  });

  test("idle reap: a STALE transcript mtime does not rescue (both silent past the window)", () => {
    const now = 10_000_000_000;
    const rec = { pid: 1, machine: "m", label: "l", ts: now - 2_000_000, lastEvent: "working",
                  transcript: "/tmp/t.jsonl" } as SessionRecord;
    expect(isClaudeIdleReapEligible(rec, now, () => now - 3_600_000)).toBe(true); // 60 min old
  });

  test("idle reap: missing transcript path / unreadable stat behaves exactly as before (eligible)", () => {
    const now = 10_000_000_000;
    const noPath = { pid: 1, machine: "m", label: "l", ts: now - 2_000_000, lastEvent: "working" } as SessionRecord;
    expect(isClaudeIdleReapEligible(noPath, now, () => { throw new Error("must not be called"); })).toBe(true);
    const withPath = { ...noPath, transcript: "/tmp/t.jsonl" } as SessionRecord;
    expect(isClaudeIdleReapEligible(withPath, now, () => undefined)).toBe(true); // stat failed
  });
});

// The idle-CLAUDE reap must make DURABLE progress even when its corrective done can't reach the worker —
// the live failure mode (2026-07-20): seven resumed-but-never-prompted Claude sessions (lastEvent
// "sessionStart", pid alive, transcript's last real turn DAYS old) sat unreaped because every corrective
// done POST failed to deliver and the OLD reap returned "uncorrected" with NO write-back, leaving the record
// frozen at "sessionStart" forever — so isRetireEligible (needs op/lastEvent "done") NEVER fired and the row
// never retired. The fix gives the reap the interrupt net's doneAttempts discipline: bounded retry, then a
// LOCAL done-pin that advances the record to the terminal state RETIRE keys on.
describe("correctIdleClaude (resumed-idle reap — bounded retry + local done-pin so RETIRE can fire offline)", () => {
  const R_MS = 1_800_000; // CLAUDE_IDLE_REAP_MS
  const NOW = 9_000_000;
  // A resumed-but-never-prompted Claude session: SessionStart fired at resume, then silence past the grace.
  // Idle 2 h — well past BOTH the 30-min reap grace AND the 1-h retire horizon (the real records were ~9 h).
  const resumed = (over: Partial<SessionRecord> = {}): SessionRecord =>
    rec({ lastEvent: "sessionStart", op: "start", sentDone: false, blob: "B", title: "Investigate x", ts: NOW - 4 * R_MS, ...over });

  test("eligible + delivered → posts ONE done, pins the record done, verdict 'corrected' (counter cleared)", async () => {
    const posts: object[] = [];
    const writes: SessionRecord[] = [];
    const v = await correctIdleClaude(cfg(), "/tmp/s.json", "s", resumed(), NOW, {
      post: async (b) => { posts.push(b); return "delivered" as PostOutcome; },
      writeRecord: async (_p, r) => { writes.push(r); },
      now: () => 4242,
    });
    expect(v).toBe("corrected");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ op: "done", ts: 4242 });
    expect(writes[0]).toMatchObject({ lastEvent: "done", op: "done", sentDone: true });
    expect(writes[0].doneAttempts).toBeUndefined();
  });

  test("Codex idle reap requires a correlated live TUI and exact-rollout proof that no turn is active", async () => {
    const posts: object[] = [];
    const writes: SessionRecord[] = [];
    const record = resumed({ agent: "codex", pid: 937, transcript: "/tmp/rollout.jsonl" });
    const v = await correctIdleClaude(cfg(), "/tmp/s.json", "s", record, NOW, {
      locateTuiPid: async () => 64799,
      pidAlive: (pid) => pid === 64799,
      codexTurnActive: async (pid, transcript) => {
        expect(pid).toBe(64799);
        expect(transcript).toBe("/tmp/rollout.jsonl");
        return false;
      },
      post: async (body) => { posts.push(body); return "delivered" as PostOutcome; },
      writeRecord: async (_path, next) => { writes.push(next); },
      now: () => 4242,
    });
    expect(v).toBe("corrected");
    expect(posts).toHaveLength(1);
    expect(writes.at(-1)).toMatchObject({ agent: "codex", tuiPid: 64799, lastEvent: "done", op: "done" });
  });

  test("Codex idle reap fails open when the rollout says active or no TUI can be correlated", async () => {
    const record = resumed({ agent: "codex", pid: 937, transcript: "/tmp/rollout.jsonl" });
    let posts = 0;
    expect(await correctIdleClaude(cfg(), "/tmp/s.json", "s", record, NOW, {
      locateTuiPid: async () => 64799,
      pidAlive: () => true,
      codexTurnActive: async () => true,
      post: async () => { posts++; return "delivered" as PostOutcome; },
    })).toBe("uncorrected");
    expect(await correctIdleClaude(cfg(), "/tmp/s.json", "s", record, NOW, {
      locateTuiPid: async () => undefined,
      post: async () => { posts++; return "delivered" as PostOutcome; },
    })).toBe("uncorrected");
    expect(posts).toBe(0);
  });

  test("a transiently FAILING done POST persists a bounded doneAttempts counter (verdict 'pending', record stays retryable)", async () => {
    const writes: SessionRecord[] = [];
    const v = await correctIdleClaude(cfg(), "/tmp/s.json", "s", resumed(), NOW, {
      post: async () => "failed" as PostOutcome,
      writeRecord: async (_p, r) => { writes.push(r); },
    });
    expect(v).toBe("pending"); // reap OWNS the session (caller skips the heartbeat) but nothing delivered
    expect(writes[0]).toMatchObject({ lastEvent: "sessionStart", doneAttempts: 1 }); // bumped; still eligible to retry
    expect(isClaudeIdleReapEligible(writes[0], NOW)).toBe(true);
  });

  test("the retry is BOUNDED — past the cap it stops POSTing and pins the record done locally, so RETIRE can then fire", async () => {
    let posts = 0;
    let last: SessionRecord = resumed();
    for (let i = 0; i < 20; i++) {
      const v = await correctIdleClaude(cfg(), "/tmp/s.json", "s", last, NOW, {
        post: async () => { posts++; return "failed" as PostOutcome; },
        writeRecord: async (_p, r) => { last = r; },
      });
      expect(v).toBe("pending");
      if (last.lastEvent === "done") break; // capped → pinned done locally, ending the every-5-s re-POST spin
    }
    expect(posts).toBeLessThanOrEqual(6);              // bounded, NOT one-failed-POST-per-sweep forever
    expect(last).toMatchObject({ lastEvent: "done", op: "done", sentDone: true });
    // THE point of the fix: the locally-pinned done is the terminal state the retire net keys on, so a
    // worker-unreachable resumed session still retires (record deleted, cap slot freed) instead of sticking.
    expect(isRetireEligible(last, NOW)).toBe(true);
    expect(isClaudeIdleReapEligible(last, NOW)).toBe(false); // done is no longer reap-eligible → no double-work
  });

  test("a revoke bubbles up so the loop can tear the pairing down", async () => {
    const v = await correctIdleClaude(cfg(), "/tmp/s.json", "s", resumed(), NOW, {
      post: async () => "revoked" as PostOutcome, writeRecord: async () => {},
    });
    expect(v).toBe("revoked");
  });

  test("not eligible (needsAttention, or a fresh session) → uncorrected, nothing posted", async () => {
    let posted = false;
    const seams = { post: async () => { posted = true; return "delivered" as PostOutcome; }, writeRecord: async () => {} };
    expect(await correctIdleClaude(cfg(), "/tmp/s.json", "s", resumed({ lastEvent: "needsAttention" }), NOW, seams)).toBe("uncorrected");
    expect(await correctIdleClaude(cfg(), "/tmp/s.json", "s", resumed({ ts: NOW - 60_000 }), NOW, seams)).toBe("uncorrected"); // only 1 min idle
    expect(posted).toBe(false);
  });

  test("a healthy worker still reaps in ONE window — a resumed session delivers on the first attempt (no retry tax)", async () => {
    let posts = 0;
    let last: SessionRecord = resumed();
    const v = await correctIdleClaude(cfg(), "/tmp/s.json", "s", last, NOW, {
      post: async () => { posts++; return "delivered" as PostOutcome; },
      writeRecord: async (_p, r) => { last = r; },
    });
    expect(v).toBe("corrected");
    expect(posts).toBe(1);
    expect(isRetireEligible(last, NOW)).toBe(true); // done + hours-idle → retires next sweep, chain complete
  });
});

// The hook writes the session record BEFORE it POSTs, so a Stop whose POST non-2xx'd / timed out / threw
// left sentDone:true on disk while the worker still held the previous op:"update" — and because EVERY other
// net gates itself off on a done record, nothing ever repaired it (live incident 2026-07-26: local record
// done at 05:59:13, worker KV still op:"update" from 05:58:36, phone stuck "running" ~13 h). The hook now
// stamps `donePending` pessimistically; this net is what settles the debt.
describe("correctPendingDone (re-POST a done whose delivery was never confirmed)", () => {
  const NOW = 9_000_000;
  // A Stop-written record whose POST never landed: terminal done state on disk, debt marker set.
  const owed = (over: Partial<SessionRecord> = {}): SessionRecord =>
    rec({ lastEvent: "done", op: "done", sentDone: true, donePending: true, blob: "B", title: "Ship the fix",
          ts: NOW - 60_000, ...over });

  test("delivered → posts ONE done, clears the marker, pins the record settled", async () => {
    const posts: object[] = [];
    const writes: SessionRecord[] = [];
    const v = await correctPendingDone(cfg(), "/tmp/s.json", "s", owed(), NOW, {
      post: async (b) => { posts.push(b); return "delivered" as PostOutcome; },
      writeRecord: async (_p, r) => { writes.push(r); },
      now: () => 4242,
    });
    expect(v).toBe("corrected");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ op: "done", ts: 4242 });
    expect(writes[0]).toMatchObject({ lastEvent: "done", op: "done", sentDone: true });
    expect(writes[0].donePending).toBeUndefined(); // debt settled → the gate closes
    expect(writes[0].doneAttempts).toBeUndefined();
    // The debt is gone from the on-disk shape too (JSON.stringify drops the undefined key).
    expect(JSON.parse(JSON.stringify(writes[0]))).not.toHaveProperty("donePending");
  });

  test("the re-POSTed blob carries the record's cached title and a FROZEN `at` (the real done time)", async () => {
    const posts: Record<string, unknown>[] = [];
    await correctPendingDone(cfg(), "/tmp/s.json", "s", owed(), NOW, {
      post: async (b) => { posts.push(b as Record<string, unknown>); return "delivered" as PostOutcome; },
      writeRecord: async () => {},
    });
    const blob = await decryptBlob(KEY, posts[0].blob as string) as Record<string, unknown>;
    expect(blob).toMatchObject({ status: "done", title: "Ship the fix", machine: "mac", label: "proj" });
    // Frozen at the Stop's own write time — a done re-sent minutes later must not look freshly finished.
    expect(blob.at).toBe(Math.floor((NOW - 60_000) / 1000));
  });

  test("no debt marker → uncorrected, nothing posted (a normally-delivered done is untouched)", async () => {
    let posted = false;
    const seams = { post: async () => { posted = true; return "delivered" as PostOutcome; }, writeRecord: async () => {} };
    expect(await correctPendingDone(cfg(), "/tmp/s.json", "s", owed({ donePending: undefined }), NOW, seams)).toBe("uncorrected");
    expect(await correctPendingDone(cfg(), "/tmp/s.json", "s", rec({ lastEvent: "working", op: "update" }), NOW, seams)).toBe("uncorrected");
    expect(posted).toBe(false);
  });

  test("a transiently FAILING re-POST keeps the debt and bumps a bounded counter (verdict 'pending')", async () => {
    const writes: SessionRecord[] = [];
    const v = await correctPendingDone(cfg(), "/tmp/s.json", "s", owed(), NOW, {
      post: async () => "failed" as PostOutcome,
      writeRecord: async (_p, r) => { writes.push(r); },
    });
    expect(v).toBe("pending"); // this net OWNS the session (the rest stand down), nothing delivered
    expect(writes[0]).toMatchObject({ donePending: true, doneAttempts: 1 }); // still owed → retried next sweep
    expect(shouldPendingDoneCheck(writes[0])).toBe(true);
  });

  test("the retry is BOUNDED — past the cap it stops POSTing and drops the debt so RETIRE can fire", async () => {
    let posts = 0;
    let last: SessionRecord = owed();
    for (let i = 0; i < 20; i++) {
      const v = await correctPendingDone(cfg(), "/tmp/s.json", "s", last, NOW, {
        post: async () => { posts++; return "failed" as PostOutcome; },
        writeRecord: async (_p, r) => { last = r; },
      });
      expect(v).toBe("pending");
      if (last.donePending !== true) break; // capped → debt dropped, ending the every-5-s re-POST spin
    }
    expect(posts).toBeLessThanOrEqual(6); // bounded, NOT one failed POST per sweep forever
    expect(last).toMatchObject({ lastEvent: "done", op: "done", sentDone: true });
    expect(shouldPendingDoneCheck(last)).toBe(false);
    // The capped record is the terminal state the retire net keys on, so the row still resolves offline.
    expect(isRetireEligible({ ...last, ts: NOW - 7_200_000 }, NOW)).toBe(true);
  });

  // "Did this done ever reach the worker?" must be answerable from the log alone — a settled record on
  // disk says nothing about delivery, and the retire net later deletes the row entirely.
  test("every attempt leaves a delivery breadcrumb, including the silent cap", async () => {
    const traces: Record<string, unknown>[] = [];
    const trace = (e: object) => { traces.push(e as Record<string, unknown>); };
    let last: SessionRecord = owed();
    for (let i = 0; i < 20; i++) {
      await correctPendingDone(cfg(), "/tmp/s.json", "s", last, NOW, {
        post: async () => "failed" as PostOutcome, writeRecord: async (_p, r) => { last = r; }, trace,
      });
      if (last.donePending !== true) break;
    }
    expect(traces[0]).toMatchObject({
      event: "pending-done", sessionId: "s", outcome: "failed", delivered: false, attempts: 0,
    });
    // The cap is the ONLY path that stops POSTing without ever delivering — it must not be silent.
    expect(traces.at(-1)).toMatchObject({ event: "pending-done", outcome: "capped", delivered: false });

    traces.length = 0;
    await correctPendingDone(cfg(), "/tmp/s.json", "s2", owed(), NOW, {
      post: async () => "delivered" as PostOutcome, writeRecord: async () => {}, trace,
    });
    expect(traces).toEqual([expect.objectContaining({
      event: "pending-done", sessionId: "s2", outcome: "delivered", delivered: true,
    })]);
  });

  test("a revoke bubbles up so the loop can tear the pairing down", async () => {
    const v = await correctPendingDone(cfg(), "/tmp/s.json", "s", owed(), NOW, {
      post: async () => "revoked" as PostOutcome, writeRecord: async () => {},
    });
    expect(v).toBe("revoked");
  });

  test("a codex-written debt is re-POSTed with the codex blob identity (agent-agnostic net)", async () => {
    const posts: Record<string, unknown>[] = [];
    await correctPendingDone(cfg(), "/tmp/s.json", "s", owed({ agent: "codex" }), NOW, {
      post: async (b) => { posts.push(b as Record<string, unknown>); return "delivered" as PostOutcome; },
      writeRecord: async () => {},
    });
    expect(await decryptBlob(KEY, posts[0].blob as string)).toMatchObject({ agent: "codex" });
  });
});

describe("shouldPendingDoneCheck (gate: only an unconfirmed done, never a provisional row)", () => {
  test("the marker alone opens the gate", () => {
    expect(shouldPendingDoneCheck(rec({ donePending: true, op: "done", lastEvent: "done" }))).toBe(true);
    expect(shouldPendingDoneCheck(rec({ op: "done", lastEvent: "done" }))).toBe(false);
    expect(shouldPendingDoneCheck(rec({ donePending: false, op: "done" }))).toBe(false);
  });

  test("provisional discovery rows are excluded (their done is posted BEFORE the record is written)", () => {
    expect(shouldPendingDoneCheck(rec({ donePending: true, provisional: true }))).toBe(false);
  });

  test("the other nets keep their hands off a done record, so the three can never fight", () => {
    const owed = rec({ lastEvent: "done", op: "done", sentDone: true, donePending: true, transcript: "/tmp/t.jsonl" });
    expect(shouldInterruptCheck(owed, owed.ts)).toBe(false);
    expect(shouldPendingApprovalCheck(owed, codexAdapter)).toBe(false);
    expect(isClaudeIdleReapEligible(owed, owed.ts + 10_000_000, () => undefined)).toBe(false);
    expect(shouldHeartbeat(owed, owed.ts + 10_000_000, undefined, false)).toBe(false);
  });
});

// The reap is only REACHED when the pending-approval backstop doesn't misread the resumed transcript's tail
// as a live block. A cmux `claude --resume` writes METADATA rows (permission-mode / last-prompt / mode) after
// the last REAL turn (which is days old) — those carry no tool_use/tool_result, so the classifier must read
// "not pending", leaving the session free to be reaped. Fixture: structurally-equivalent synthetic rows (NO
// private transcript content).
describe("claudeTailPendingApproval on a cmux-resume tail (metadata rows after an old, non-blocking turn)", () => {
  test("resumed-but-never-prompted tail (old assistant text + cmux metadata rows) → NOT pending → reap not blocked", () => {
    const tail = [
      JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "All done — the fix is in." }] } }),
      JSON.stringify({ type: "attachment" }),
      JSON.stringify({ type: "system", subtype: "resume" }),
      JSON.stringify({ type: "ai-title", title: "Investigate x" }),
      JSON.stringify({ type: "last-prompt" }),
      JSON.stringify({ type: "mode" }),
      JSON.stringify({ type: "permission-mode", mode: "auto" }),
    ].join("\n");
    expect(claudeTailPendingApproval(tail)).toBe(false);
  });

  test("a genuine trailing AskUserQuestion with no answer is STILL caught (the gate isn't broken by the fixture)", () => {
    const tail = [
      JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_ask1", name: "AskUserQuestion", input: {} }] } }),
      JSON.stringify({ type: "permission-mode", mode: "auto" }), // trailing cmux noise must not resolve the block
    ].join("\n");
    expect(claudeTailPendingApproval(tail)).toBe(true);
  });
});

describe("shouldRepairTitle (heal a permanent blank codex title)", () => {
  test("a codex session with no/empty title → repair; with a title → skip (idempotent)", () => {
    expect(shouldRepairTitle(rec({ agent: "codex" }))).toBe(true);
    expect(shouldRepairTitle(rec({ agent: "codex", title: "" }))).toBe(true);
    expect(shouldRepairTitle(rec({ agent: "codex", title: "Fix the bug" }))).toBe(false);
  });

  test("claude sessions and provisional rows are never title-repaired here", () => {
    expect(shouldRepairTitle(rec({ title: "" }))).toBe(false); // claude (no agent) → not this net's job
    expect(shouldRepairTitle(rec({ agent: "codex", provisional: true }))).toBe(false);
  });
});

describe("buildTitleRepairEnvelope (re-POST current state with only the title fixed)", () => {
  test("preserves the session's op/prio/status and fixes the title in the rebuilt blob", async () => {
    const record = rec({ agent: "codex", lastEvent: "working", op: "update", prio: 0, model: "gpt-5-codex" });
    const env = await buildTitleRepairEnvelope("sess-9", record, "Refactor the parser", 4242, KEY, "codex") as {
      v: number; op: string; prio: number; ts: number; blob: string;
    };
    expect(env).toMatchObject({ v: 2, sessionId: "sess-9", op: "update", prio: 0, ts: 4242 });
    const blob = await decryptBlob(KEY, env.blob) as Record<string, unknown>;
    expect(blob.status).toBe("working"); // status UNCHANGED — only the title is repaired
    expect(blob.title).toBe("Refactor the parser");
    expect(blob.agent).toBe("codex");
    expect(blob.model).toBe("gpt-5-codex");
  });

  test("a needsAttention record keeps its prio-1 needsAttention state on the repair frame", async () => {
    const record = rec({ agent: "codex", lastEvent: "needsAttention", op: "update", prio: 1 });
    const env = await buildTitleRepairEnvelope("sess-10", record, "Approve the patch?", 7, KEY, "codex") as {
      prio: number; blob: string;
    };
    expect(env.prio).toBe(1);
    const blob = await decryptBlob(KEY, env.blob) as Record<string, unknown>;
    expect(blob.status).toBe("needsAttention");
  });
});

describe("titleRepairedRecord (the delivered-repair record rewrite)", () => {
  test("caches the title + blob AND restamps the sealing pairingId (a legacy/stale stamp is replaced)", () => {
    const legacy = rec({ agent: "codex", pairingId: "old-pairing" });
    const next = titleRepairedRecord(legacy, "Refactor the parser", "NEWBLOB", "current-pairing");
    expect(next).toMatchObject({ title: "Refactor the parser", blob: "NEWBLOB", pairingId: "current-pairing" });
    // A record with NO stamp at all (older plugin) gets one too — the repair sealed under the current key.
    expect(titleRepairedRecord(rec({ agent: "codex" }), "t", "B", "current-pairing").pairingId).toBe("current-pairing");
  });

  test("the rewritten record passes the heartbeat's key-rotation guard (the very reason for the restamp)", () => {
    // Without the restamp, a legacy record's stale pairingId made buildHeartbeatEnvelope yield null
    // forever — the freshly-repaired title would never be re-armed by a heartbeat.
    const stale = rec({ agent: "codex", op: "update", prio: 0, pairingId: "old-pairing" });
    expect(buildHeartbeatEnvelope("s", stale, 99, "current-pairing")).toBeNull(); // the pre-fix dead end
    const repaired = titleRepairedRecord(stale, "Refactor the parser", "NEWBLOB", "current-pairing");
    expect(buildHeartbeatEnvelope("s", repaired, 99, "current-pairing")).toMatchObject({ blob: "NEWBLOB" });
  });
});

describe("buildEndEnvelope (reap → v2 op:end, no blob)", () => {
  test("is a v2 end envelope carrying no blob (the worker reuses the last stored one)", () => {
    expect(buildEndEnvelope("sess-1", 1234)).toEqual({ v: 2, sessionId: "sess-1", op: "end", prio: 0, ts: 1234 });
  });
  test("satisfies parseCCEnvelope's non-blob contract (v/op/prio/ts)", () => {
    const e = buildEndEnvelope("sess-1", 1_700_000_000_000) as Record<string, unknown>;
    expect(e.v).toBe(2);
    expect(typeof e.sessionId).toBe("string");
    expect(e.op).toBe("end");
    expect([0, 1]).toContain(e.prio);
    expect(Number.isFinite(e.ts) && (e.ts as number) > 0).toBe(true);
    expect(e).not.toHaveProperty("blob");
  });
  test("carries the record's cached start when given one; omits it for the recordless call", () => {
    expect(buildEndEnvelope("s", 1234, rec({ sessionStartedAt: 700 }))).toMatchObject({ startedAt: 700 });
    expect(buildEndEnvelope("s", 1234, rec())).not.toHaveProperty("startedAt");
    expect(buildEndEnvelope("s", 1234)).not.toHaveProperty("startedAt");
  });
});

describe("buildDoneEnvelope (interrupt corrective → v2 op:done + encrypted blob)", () => {
  test("is a v2 done envelope whose blob decrypts to a done status carrying the record's machine/label", async () => {
    const e = await buildDoneEnvelope("sess-9", rec({ machine: "Mac", label: "api-status" }), 1_700_000_000_000, KEY) as Record<string, unknown>;
    expect(e).toMatchObject({ v: 2, sessionId: "sess-9", op: "done", prio: 0, ts: 1_700_000_000_000 });
    expect(await decryptBlob(KEY, e.blob as string)).toEqual({ status: "done", title: "", machine: "Mac", label: "api-status" });
  });
  test("coerces a corrupt-but-parsed record's missing machine/label to empty strings", async () => {
    const bad = { pid: 1, ts: 1 } as unknown as SessionRecord;
    const e = await buildDoneEnvelope("s", bad, 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, e.blob as string)).toMatchObject({ machine: "", label: "" });
  });
  test("codex (agent arg) restamps the blob's agent:'codex'; claude (default) omits it", async () => {
    const codexEnv = await buildDoneEnvelope("s", rec({ machine: "Mac", label: "proj" }), 5, KEY, "codex") as Record<string, unknown>;
    expect(await decryptBlob(KEY, codexEnv.blob as string)).toMatchObject({ status: "done", agent: "codex" });
    const claudeEnv = await buildDoneEnvelope("s", rec(), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, claudeEnv.blob as string)).not.toHaveProperty("agent");
  });
  test("preserves the record's cached turnStartedAt in the rebuilt blob ('done in Xm' stays per-turn); omits when absent", async () => {
    // The corrective done rebuilds its blob from scratch, so the turn anchor the prompt's hook cached
    // must be restamped — else the island's frozen done label would regress to session-length math.
    const withTurn = await buildDoneEnvelope("s", rec({ turnStartedAt: 1_751_900_000 }), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, withTurn.blob as string)).toMatchObject({ status: "done", turnStartedAt: 1_751_900_000 });
    expect(withTurn).not.toHaveProperty("turnStartedAt"); // blob-only — never on the clear envelope
    const withoutTurn = await buildDoneEnvelope("s", rec(), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, withoutTurn.blob as string)).not.toHaveProperty("turnStartedAt");
  });
  test("preserves the record's cached model in the rebuilt blob (v0.8.5 badge survives a corrective done); omits when absent", async () => {
    // The corrective done rebuilds its blob from scratch, so the model the hook cached (like title)
    // must be restamped — else the phone's model badge would vanish on the corrective frame.
    const withModel = await buildDoneEnvelope("s", rec({ model: "claude-fable-5" }), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, withModel.blob as string)).toMatchObject({ status: "done", model: "claude-fable-5" });
    expect(withModel).not.toHaveProperty("model"); // blob-only — never on the clear envelope
    const without = await buildDoneEnvelope("s", rec(), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, without.blob as string)).not.toHaveProperty("model"); // omitted, never ""
  });
  test("stamps the passed `at` (epoch seconds) into the blob; omits it when absent (v1.1.6)", async () => {
    // The interrupt/idle-provisional correctives pass the OBSERVED now; the idle-CLAUDE reap passes a
    // FROZEN floor(record.ts/1000) so an hours-idle resumed session ages out (see correctIdleClaude).
    const withAt = await buildDoneEnvelope("s", rec({ machine: "Mac", label: "proj" }), 5, KEY, "claude", 1_751_900_000) as Record<string, unknown>;
    expect(await decryptBlob(KEY, withAt.blob as string)).toMatchObject({ status: "done", at: 1_751_900_000 });
    expect(withAt).not.toHaveProperty("at"); // blob-only — never on the clear envelope
    const withoutAt = await buildDoneEnvelope("s", rec(), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, withoutAt.blob as string)).not.toHaveProperty("at");
  });
  test("the idle-CLAUDE reap freezes `at` at the record's last real event (floor(record.ts/1000)), NOT now", async () => {
    // The value the reap passes: a session resumed hours ago (record.ts) must age out, so `at` is frozen
    // at record.ts/1000, never the watchdog's decision time. This asserts the exact contract the reap uses.
    const record = rec({ lastEvent: "sessionStart", ts: 1_784_463_341_864, machine: "Mac", label: "api-status" });
    const reapAt = Math.floor(record.ts / 1000); // what correctIdleClaude passes
    const now = 1_784_490_874_000; // the watchdog's decision time, ~7.6 h LATER
    const e = await buildDoneEnvelope("resumed", record, now, KEY, "claude", reapAt) as Record<string, unknown>;
    expect(e).toMatchObject({ op: "done", ts: now }); // envelope ts is now so the worker accepts it
    const blob = await decryptBlob(KEY, e.blob as string) as Record<string, unknown>;
    expect(blob.at).toBe(1_784_463_341); // frozen at the resume, ~7.6 h before `now` — the phone ages it out
    expect(blob.at).not.toBe(Math.floor(now / 1000));
  });
});

// --- live-session discovery seam (provisional builders + the generic discovery step) ---------
//
// The daemon surfaces a live TUI the hooks can't see yet as a PROVISIONAL op:start + record. These
// cover the pure builders and the generic step's orchestration (adapter-driven, POST-gated persist).

const cfg = (): Config => ({ url: "https://w.test", pairingId: "p", pcSecret: "s", e2eKey: KEY });
const disc = (over: Partial<DiscoveredSession> = {}): DiscoveredSession =>
  ({ pid: 5150, sessionId: "codex-pid-5150", title: "api-status", label: "api-status", ...over });

describe("buildStartEnvelope (provisional op:start — same v2 shape the hook POSTs)", () => {
  test("is a v2 op:start carrying the blob", () => {
    expect(buildStartEnvelope("codex-pid-5150", "BLOB", 1234))
      .toEqual({ v: 2, sessionId: "codex-pid-5150", op: "start", prio: 0, ts: 1234, blob: "BLOB" });
  });
  test("satisfies parseCCEnvelope's start contract (sentinel sessionId is a plain string, ≤128 chars)", () => {
    const e = buildStartEnvelope("codex-pid-5150", "BLOB", 1_700_000_000_000) as Record<string, unknown>;
    expect(e.v).toBe(2);
    expect((e.sessionId as string).length).toBeLessThanOrEqual(128);
    expect(e.op).toBe("start");
    expect(e.blob).toBe("BLOB");
  });
});

describe("buildProvisionalEnvelope (op keyed on the TUI's turn state — the idle-TUI fix)", () => {
  test("in flight (idle:false) → op:start, byte-identical to buildStartEnvelope", () => {
    expect(buildProvisionalEnvelope("codex-pid-5150", "BLOB", 1234, false))
      .toEqual(buildStartEnvelope("codex-pid-5150", "BLOB", 1234));
  });
  test("idle → op:done (the same op/prio a real Stop posts — done-is-terminal, never re-arms)", () => {
    expect(buildProvisionalEnvelope("codex-pid-5150", "BLOB", 1234, true))
      .toEqual({ v: 2, sessionId: "codex-pid-5150", op: "done", prio: 0, ts: 1234, blob: "BLOB" });
  });
});

describe("buildProvisionalBlob (mirrors buildBlob's SessionStart shape)", () => {
  test("codex: decrypts to working + title/machine/label + agent:'codex', no detail/turnStartedAt", async () => {
    const blob = await buildProvisionalBlob(disc(), "Mac", { agent: "codex" }, KEY);
    expect(await decryptBlob(KEY, blob)).toMatchObject({ status: "working", title: "api-status", machine: "Mac", label: "api-status", agent: "codex", dbg: expect.any(String) });
  });
  test("an IDLE discovery decrypts to status 'done' — an idle REPL is never advertised 'Running'", async () => {
    const blob = await buildProvisionalBlob(disc({ idle: true }), "Mac", { agent: "codex" }, KEY);
    expect(await decryptBlob(KEY, blob)).toMatchObject({ status: "done", title: "api-status", machine: "Mac", label: "api-status", agent: "codex", dbg: expect.any(String) });
  });
  test("empty title coerces to '' (like buildBlob's title ?? '')", async () => {
    const blob = await buildProvisionalBlob(disc({ title: undefined }), "Mac", { agent: "codex" }, KEY);
    expect(await decryptBlob(KEY, blob)).toMatchObject({ title: "" });
  });
  test("claude-style (empty agent fields) omits the agent key", async () => {
    const blob = await buildProvisionalBlob(disc(), "Mac", {}, KEY);
    expect(await decryptBlob(KEY, blob)).not.toHaveProperty("agent");
  });
  test("omits `model` — unknown at process-scan discovery; the first real hook self-corrects it", async () => {
    const blob = await buildProvisionalBlob(disc(), "Mac", { agent: "codex" }, KEY);
    expect(await decryptBlob(KEY, blob)).not.toHaveProperty("model");
  });
});

describe("buildProvisionalRecord (flagged provisional, reap/reconcile-ready)", () => {
  test("carries pid + provisional:true + a fresh-start bookkeeping, and codex agent via blobAgentFields", () => {
    const r = buildProvisionalRecord(disc(), "Mac", "BLOB", { agent: "codex" }, 4242);
    expect(r).toEqual({
      pid: 5150, machine: "Mac", label: "api-status", ts: 4242,
      lastEvent: "sessionStart", op: "start", prio: 0, blob: "BLOB", provisional: true, agent: "codex",
      title: "api-status", // cached like trackSession's — a corrective done must never regress to title:""
      dbg: expect.any(String),
    });
  });
  test("an IDLE discovery is recorded as a posted done (op/lastEvent done + sentDone) so no net re-arms it", () => {
    const r = buildProvisionalRecord(disc({ idle: true }), "Mac", "BLOB", { agent: "codex" }, 4242, undefined, true);
    expect(r).toMatchObject({ lastEvent: "done", op: "done", sentDone: true, provisional: true, title: "api-status" });
    // The done bookkeeping is exactly what the other nets key off: no heartbeat, no idle re-check.
    expect(shouldHeartbeat(r, r.ts + 10_000_000, undefined, false)).toBe(false);
    expect(shouldIdleProvisionalCheck(r, codexAdapter)).toBe(false);
  });
  test("a title-less discovery omits the cached title (never stores title:'')", () => {
    expect(buildProvisionalRecord(disc({ title: undefined }), "Mac", "BLOB", { agent: "codex" }, 1)).not.toHaveProperty("title");
  });
  test("retains exact cwd + process birth only as local TUI-correlation evidence", () => {
    expect(buildProvisionalRecord(
      disc({ cwd: "/Users/me/project", startedAt: 1234 }), "Mac", "BLOB", { agent: "codex" }, 4242,
    )).toMatchObject({ tuiCwd: "/Users/me/project", tuiStartedAt: 1234 });
  });
  test("claude-style omits the agent field (empty blobAgentFields)", () => {
    expect(buildProvisionalRecord(disc(), "Mac", "BLOB", {}, 1)).not.toHaveProperty("agent");
  });
});

// --- branch (the folder's LIVE git branch) in the daemon's rebuilt frames ------------------------
//
// This daemon has no cwd of its own — it rebuilds blobs from the record. `label`/`folderKey` are
// RESTAMPED from the record's pins; `branch` is RE-READ from the pinned paths, because it is live
// state: a `git checkout` between the last hook and this corrective must reach the phone.
describe("branch in the watchdog's rebuilt blobs", () => {
  const roots: string[] = [];
  /** A real temp checkout, plus the record fields a session pinned to it would carry. */
  const repo = async (head: string): Promise<{ cwd: string; gitDir: string }> => {
    const cwd = await mkdtemp(join(tmpdir(), "nomo-wd-branch-"));
    roots.push(cwd);
    const gitDir = join(cwd, ".git");
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, "HEAD"), `ref: refs/heads/${head}\n`);
    return { cwd, gitDir };
  };
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  test("all four correctives put `branch` immediately after folderKey", async () => {
    const { cwd, gitDir } = await repo("feat/hybrid-lan");
    const r = rec({ cwd, gitDir, folderKey: "0123456789ab", turnStartedAt: 111, model: "claude-fable-5", title: "t" });
    const blobOf = async (env: object) => (await decryptBlob(KEY, (env as { blob: string }).blob)) as Record<string, unknown>;
    const frames = [
      await blobOf(await buildDoneEnvelope("s", r, 5_000, KEY, "claude", 5)),
      await blobOf(await buildNeedsAttentionEnvelope("s", r, 5_000, KEY, "claude", 5)),
      await blobOf(await buildWorkingEnvelope("s", r, 5_000, KEY, "claude")),
      await blobOf(await buildTitleRepairEnvelope("s", r, "fixed", 5_000, KEY, "claude", 5)),
    ];
    for (const blob of frames) {
      expect(blob.branch).toBe("feat/hybrid-lan");
      expect(Object.keys(blob).slice(-2)).toEqual(["folderKey", "branch"]);
      expect(JSON.stringify(blob)).not.toContain(cwd); // the path itself never rides
    }
  });

  test("a record with no pinned cwd (written before the pin existed) simply OMITS the key", async () => {
    const r = rec({ folderKey: "0123456789ab", title: "t" });
    const env = await buildDoneEnvelope("s", r, 5_000, KEY, "claude", 5);
    const blob = await decryptBlob(KEY, (env as { blob: string }).blob) as Record<string, unknown>;
    expect(blob).not.toHaveProperty("branch");
    expect(Object.keys(blob).at(-1)).toBe("folderKey");
  });

  test("RE-READ, not restamped: a checkout since the last hook shows up in the next corrective", async () => {
    const { cwd, gitDir } = await repo("main");
    const r = rec({ cwd, gitDir, title: "t" });
    const first = await decryptBlob(KEY, (await buildDoneEnvelope("s", r, 5_000, KEY, "claude", 5) as { blob: string }).blob) as Record<string, unknown>;
    expect(first.branch).toBe("main");
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/release/2.0\n");
    const second = await decryptBlob(KEY, (await buildDoneEnvelope("s", r, 6_000, KEY, "claude", 6) as { blob: string }).blob) as Record<string, unknown>;
    expect(second.branch).toBe("release/2.0");
  });

  test("the provisional pair: the blob carries the branch, the record pins the paths it came from", async () => {
    const { cwd, gitDir } = await repo("dev");
    const d = disc({ cwd });
    const blob = await decryptBlob(KEY, await buildProvisionalBlob(d, "Mac", {}, KEY, 5)) as Record<string, unknown>;
    expect(blob.branch).toBe("dev");
    expect(Object.keys(blob).at(-1)).toBe("branch"); // after `at`/`folderKey`, both absent for this fixture
    // The record pins cwd + the resolved git dir, so every later corrective rebuilt from it re-reads
    // HEAD directly instead of walking the tree again.
    const r = buildProvisionalRecord(d, "Mac", "BLOB", {}, 4242);
    expect(r).toMatchObject({ cwd, gitDir });
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/feat/hybrid-lan\n");
    const corrective = await decryptBlob(KEY, (await buildDoneEnvelope("s", r, 6_000, KEY, "claude", 6) as { blob: string }).blob) as Record<string, unknown>;
    expect(corrective.branch).toBe("feat/hybrid-lan");
    // A discovery whose cwd could not be read pins nothing and emits nothing.
    expect(buildProvisionalRecord(disc(), "Mac", "BLOB", {}, 1)).not.toHaveProperty("cwd");
    expect(await decryptBlob(KEY, await buildProvisionalBlob(disc(), "Mac", {}, KEY, 5))).not.toHaveProperty("branch");
  });
});

describe("shouldIdleProvisionalCheck (gate: provisional codex rows only, once per episode)", () => {
  const prov = (over: Partial<SessionRecord> = {}): SessionRecord =>
    rec({ provisional: true, agent: "codex", lastEvent: "sessionStart", op: "start", ...over });

  test("a provisional codex row still marked working/start IS checked", () => {
    expect(shouldIdleProvisionalCheck(prov(), codexAdapter)).toBe(true);
  });
  test("claude adapter (no pidTurnActive probe) → never", () => {
    expect(shouldIdleProvisionalCheck(prov({ agent: undefined }), claudeAdapter)).toBe(false);
  });
  test("a REAL (non-provisional) record → never (hooks own its lifecycle)", () => {
    expect(shouldIdleProvisionalCheck(prov({ provisional: undefined }), codexAdapter)).toBe(false);
    expect(shouldIdleProvisionalCheck(prov({ provisional: false }), codexAdapter)).toBe(false);
  });
  test("already done (op or lastEvent) → never re-checked (one corrective per episode)", () => {
    expect(shouldIdleProvisionalCheck(prov({ op: "done" }), codexAdapter)).toBe(false);
    expect(shouldIdleProvisionalCheck(prov({ lastEvent: "done" }), codexAdapter)).toBe(false);
  });
  test("an unprobeable pid → never", () => {
    expect(shouldIdleProvisionalCheck(prov({ pid: Number.NaN }), codexAdapter)).toBe(false);
    expect(shouldIdleProvisionalCheck(prov({ pid: undefined as unknown as number }), codexAdapter)).toBe(false);
  });
});

describe("discoverLiveSessions (generic adapter-driven step)", () => {
  // A fake adapter that returns one discovery — only kind/blobAgentFields/discoverLive are read.
  const fakeAdapter = (discovered: DiscoveredSession[]): AgentAdapter =>
    ({ kind: "codex", blobAgentFields: { agent: "codex" }, discoverLive: async () => discovered } as unknown as AgentAdapter);
  const claudeLike = (): AgentAdapter => ({ kind: "claude", blobAgentFields: {} } as unknown as AgentAdapter);

  test("delivered POST → persists a provisional record for the discovered session", async () => {
    const posts: object[] = [];
    const writes: { id: string; rec: SessionRecord }[] = [];
    await discoverLiveSessions(cfg(), {
      adapters: [fakeAdapter([disc()])],
      post: async (b) => { posts.push(b); return "delivered" as PostOutcome; },
      readRecords: async () => [],
      writeRecord: async (id, rec) => { writes.push({ id, rec }); },
      now: () => 999,
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ v: 2, sessionId: "codex-pid-5150", op: "start", ts: 999 });
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe("codex-pid-5150");
    expect(writes[0].rec).toMatchObject({ pid: 5150, provisional: true, agent: "codex" });
  });

  test("an IDLE discovery is POSTed as op:done and recorded as done (never a hook-less 'working' ghost)", async () => {
    const posts: object[] = [];
    const writes: { id: string; rec: SessionRecord }[] = [];
    await discoverLiveSessions(cfg(), {
      adapters: [fakeAdapter([disc({ idle: true })])],
      post: async (b) => { posts.push(b); return "delivered" as PostOutcome; },
      readRecords: async () => [],
      writeRecord: async (id, rec) => { writes.push({ id, rec }); },
      now: () => 999,
    });
    expect(posts[0]).toMatchObject({ v: 2, sessionId: "codex-pid-5150", op: "done", prio: 0, ts: 999 });
    expect(await decryptBlob(KEY, (posts[0] as { blob: string }).blob)).toMatchObject({ status: "done" });
    expect(writes[0].rec).toMatchObject({ op: "done", lastEvent: "done", sentDone: true, provisional: true });
  });

  test("a NON-delivered POST persists NOTHING (retried next sweep — pid stays unknown)", async () => {
    const writes: unknown[] = [];
    await discoverLiveSessions(cfg(), {
      adapters: [fakeAdapter([disc()])],
      post: async () => "failed" as PostOutcome,
      readRecords: async () => [],
      writeRecord: async (id, rec) => { writes.push({ id, rec }); },
    });
    expect(writes).toHaveLength(0);
  });

  test("an adapter WITHOUT discoverLive (claude) is skipped entirely — no POST", async () => {
    let posted = false;
    await discoverLiveSessions(cfg(), {
      adapters: [claudeLike()],
      post: async () => { posted = true; return "delivered" as PostOutcome; },
      readRecords: async () => [],
      writeRecord: async () => {},
    });
    expect(posted).toBe(false);
  });

  test("passes the known records to the adapter so it can exclude already-tracked pids", async () => {
    const known: SessionRecord[] = [rec({ pid: 5150 })];
    let seen: SessionRecord[] | null = null;
    const adapter = { kind: "codex", blobAgentFields: { agent: "codex" },
      discoverLive: async (k: SessionRecord[]) => { seen = k; return []; } } as unknown as AgentAdapter;
    await discoverLiveSessions(cfg(), { adapters: [adapter], readRecords: async () => known, post: async () => "delivered" as PostOutcome, writeRecord: async () => {} });
    expect(seen).toBe(known);
  });

  test("a discoverLive throw never derails the step (best-effort)", async () => {
    const bad = { kind: "codex", blobAgentFields: { agent: "codex" }, discoverLive: async () => { throw new Error("scan boom"); } } as unknown as AgentAdapter;
    await expect(discoverLiveSessions(cfg(), { adapters: [bad], readRecords: async () => [], post: async () => "delivered" as PostOutcome, writeRecord: async () => {} })).resolves.toBeUndefined();
  });
});

describe("IDLE_GRACE_MS (linger between sessions so discovery keeps running)", () => {
  test("is 30 minutes", () => {
    expect(IDLE_GRACE_MS).toBe(1_800_000);
  });
});

describe("provisionalsCoveredByReal (sweep reconcile backstop matcher)", () => {
  const entry = (sessionId: string, over: Partial<SessionRecord>): RecordEntry => ({ sessionId, rec: rec(over) });

  test("a provisional whose pid a REAL codex record now holds is returned for reconcile", () => {
    const entries = [
      entry("codex-pid-100", { pid: 100, provisional: true, agent: "codex" }),
      entry("real-a", { pid: 100, agent: "codex" }),
      entry("codex-pid-200", { pid: 200, provisional: true, agent: "codex" }), // no real record yet
    ];
    expect(provisionalsCoveredByReal(entries)).toEqual(["codex-pid-100"]);
  });

  test("no real record covering the pid → nothing to reconcile (still discovering)", () => {
    expect(provisionalsCoveredByReal([entry("codex-pid-200", { pid: 200, provisional: true, agent: "codex" })])).toEqual([]);
  });

  test("only a REAL (non-provisional) CODEX record counts as coverage", () => {
    // A claude record (no agent) or another provisional at the same pid must NOT trigger a reconcile.
    const entries = [
      entry("codex-pid-100", { pid: 100, provisional: true, agent: "codex" }),
      entry("real-claude", { pid: 100 }),                      // claude → not codex coverage
      entry("codex-pid-100-dup", { pid: 100, provisional: true, agent: "codex" }), // another provisional
    ];
    expect(provisionalsCoveredByReal(entries)).toEqual([]);
  });
});

describe("reconcileProvisionalsSweep (ends + deletes a covered provisional)", () => {
  const covered = (): RecordEntry[] => [
    { sessionId: "codex-pid-100", rec: rec({ pid: 100, provisional: true, agent: "codex" }) },
    { sessionId: "real-a", rec: rec({ pid: 100, agent: "codex" }) },
  ];

  test("POSTs an op:end for the sentinel and deletes it on a delivered POST", async () => {
    const posts: object[] = [];
    const deletes: string[] = [];
    await reconcileProvisionalsSweep(cfg(), {
      readEntries: async () => covered(),
      post: async (b) => { posts.push(b); return "delivered" as PostOutcome; },
      deleteRecord: async (id) => { deletes.push(id); },
      now: () => 42,
    });
    expect(posts).toEqual([{ v: 2, sessionId: "codex-pid-100", op: "end", prio: 0, ts: 42 }]);
    expect(deletes).toEqual(["codex-pid-100"]);
  });

  test("a failed end POST keeps the provisional for the next sweep (no delete)", async () => {
    const deletes: string[] = [];
    await reconcileProvisionalsSweep(cfg(), {
      readEntries: async () => covered(),
      post: async () => "failed" as PostOutcome,
      deleteRecord: async (id) => { deletes.push(id); },
    });
    expect(deletes).toEqual([]);
  });
});

// --- idle-done retire (free the worker cap slot a long-idle done row still occupies) --------
//
// v1.1.6 froze the reap's blob `at` so an idle done row AGES OUT of the phone's display, but the worker
// row it left behind still counts against maxSessionsPerPairing. The retire net finishes the job: a
// Claude done session idle >1 h (pid alive) gets a blob-less op:end carrying the FROZEN real-last-event
// `at`, and its local record is deleted — freeing the cap slot. Never touches working/needsAttention
// (they keep heartbeating), never codex (discovery would re-surface it).
describe("isRetireEligible (a DONE session past the 1 h real-event horizon)", () => {
  const RETIRE_MS = RETIRE_AFTER_MS; // derived, not mirrored — see the born-expired guard test below
  const now = 100_000_000;

  // REGRESSION GUARD (born-expired trap). RETIRE_AFTER_MS and PLAN_PICKER_PENDING_MAX_MS were both
  // independently written as exactly 1 h. settlePendingPlanPickerDone settles a pending picker AT its
  // TTL, so the resulting done was already past the retire horizon the instant it was written: the next
  // sweep (~47 s later in the field incident) posted a blob-less op:end and the worker hard-deleted the
  // row. The retire horizon must stay STRICTLY ABOVE the picker TTL so no settle can be born expired.
  test("the retire horizon sits strictly above the plan-picker hard TTL (no born-expired settle)", () => {
    expect(RETIRE_AFTER_MS).toBeGreaterThan(PLAN_PICKER_PENDING_MAX_MS);
    expect(RETIRE_AFTER_MS - PLAN_PICKER_PENDING_MAX_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });

  test("a done Claude session idle ≥1 h → eligible; just under → not", () => {
    expect(isRetireEligible(rec({ op: "done", lastEvent: "done", ts: now - RETIRE_MS }), now)).toBe(true);
    expect(isRetireEligible(rec({ op: "done", lastEvent: "done", ts: now - RETIRE_MS + 1 }), now)).toBe(false);
  });

  test("done via lastEvent alone (op absent) still counts", () => {
    expect(isRetireEligible(rec({ lastEvent: "done", ts: now - RETIRE_MS }), now)).toBe(true);
  });

  test("working and needsAttention are NEVER retired, no matter how long idle", () => {
    expect(isRetireEligible(rec({ lastEvent: "working", op: "update", ts: now - RETIRE_MS * 10 }), now)).toBe(false);
    expect(isRetireEligible(rec({ lastEvent: "needsAttention", op: "update", prio: 1, ts: now - RETIRE_MS * 10 }), now)).toBe(false);
  });

  test("Codex real and provisional done rows retire; a local retired-owner marker cannot retire twice", () => {
    expect(isRetireEligible(rec({ agent: "codex", op: "done", lastEvent: "done", ts: now - RETIRE_MS * 5 }), now)).toBe(true);
    expect(isRetireEligible(rec({ agent: "codex", provisional: true, op: "done", lastEvent: "done", ts: now - RETIRE_MS * 5 }), now)).toBe(true);
    expect(isRetireEligible(rec({ agent: "codex", op: "done", lastEvent: "done", ts: now - RETIRE_MS * 5, retiredAt: now }), now)).toBe(false);
  });

  test("non-Codex provisional rows remain outside the retire net", () => {
    expect(isRetireEligible(rec({ provisional: true, op: "done", lastEvent: "done", ts: now - RETIRE_MS * 5 }), now)).toBe(false);
  });

  test("a record with no real-event timestamp is un-ageable → not retired", () => {
    expect(isRetireEligible({ pid: 1, machine: "m", label: "l", op: "done", lastEvent: "done" } as unknown as SessionRecord, now)).toBe(false);
  });

  test("retirement fires FAR before the 24 h stale cap — the two never contend", () => {
    // done + 1 h → retired; the same record is nowhere near the 24 h staleness window.
    const doneOldish = rec({ op: "done", lastEvent: "done", ts: now - RETIRE_MS });
    expect(isRetireEligible(doneOldish, now)).toBe(true);
    expect(now - doneOldish.ts).toBeLessThan(86_400_000);
  });
});

describe("retireDoneStale (blob-less op:end with frozen `at` + record delete)", () => {
  const NOW = 100_000_000;
  const RETIRE_MS = RETIRE_AFTER_MS;
  const done = (over: Partial<SessionRecord> = {}): SessionRecord =>
    rec({ op: "done", lastEvent: "done", sentDone: true, blob: "DONEBLOB", ts: NOW - RETIRE_MS, ...over });

  test("done + 1 h → POSTs op:end carrying the FROZEN `at`, then deletes the record", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const deletes: string[] = [];
    const record = done();
    const v = await retireDoneStale(cfg(), "/tmp/s.json", "s", record, NOW, {
      post: async (b) => { posts.push(b as Record<string, unknown>); return "delivered" as PostOutcome; },
      deleteRecord: async (p) => { deletes.push(p); },
    });
    expect(v).toBe("retired");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ v: 2, sessionId: "s", op: "end", prio: 0 });
    expect(posts[0].at).toBe(Math.floor(record.ts / 1000)); // FROZEN real-last-event, not NOW
    expect(posts[0].at).not.toBe(Math.floor(NOW / 1000));
    expect(deletes).toEqual(["/tmp/s.json"]);
  });

  // Retirement deletes the row on BOTH sides, so without a breadcrumb a vanished session is
  // indistinguishable from one that was never sent — which is what made the born-expired plan-picker
  // incident invisible in the trace.
  test("every post-eligibility exit leaves one retire breadcrumb (age + owner + outcome)", async () => {
    const traces: Record<string, unknown>[] = [];
    const trace = (e: object) => { traces.push(e as Record<string, unknown>); };
    const record = done();
    expect(await retireDoneStale(cfg(), "/tmp/s.json", "s", record, NOW, {
      post: async () => "delivered" as PostOutcome, deleteRecord: async () => {}, trace,
    })).toBe("retired");
    expect(traces[0]).toMatchObject({
      event: "retire", reason: "idle-done", sessionId: "s", recordTs: record.ts,
      ageMs: RETIRE_MS, outcome: "retired",
    });

    // an undelivered end still retires locally…
    expect(await retireDoneStale(cfg(), "/tmp/s.json", "s", done(), NOW, {
      post: async () => "failed" as PostOutcome, deleteRecord: async () => {}, trace,
    })).toBe("retired-offline");
    expect(traces[1]).toMatchObject({ event: "retire", outcome: "retired-offline" });

    // …a Codex row that keeps its live TUI records the owner pid it left behind…
    expect(await retireDoneStale(cfg(), "/tmp/s.json", "s", done({ agent: "codex", tuiPid: 5150 }), NOW, {
      post: async () => "delivered" as PostOutcome, writeRecord: async () => {}, pidAlive: () => true, trace,
    })).toBe("retired");
    expect(traces[2]).toMatchObject({ event: "retire", outcome: "retired", tuiPid: 5150 });

    // …and a session the user woke mid-sweep says so instead of vanishing silently.
    expect(await retireDoneStale(cfg(), "/tmp/s.json", "s", done(), NOW, {
      post: async () => { throw new Error("must not post a woken session"); },
      readRecord: async () => rec({ lastEvent: "working", op: "update", ts: NOW }), trace,
    })).toBe("skip");
    expect(traces[3]).toMatchObject({ event: "retire", outcome: "skip-woken" });

    // The not-eligible early return stays SILENT (it is every kept session on every sweep).
    expect(await retireDoneStale(cfg(), "/tmp/s.json", "s", done({ ts: NOW }), NOW, { trace })).toBe("skip");
    expect(traces).toHaveLength(4);
  });

  test("done + 59 min → NOT eligible: no POST, no delete (the heartbeat keeps it)", async () => {
    let posted = false;
    let deleted = false;
    const v = await retireDoneStale(cfg(), "/tmp/s.json", "s", done({ ts: NOW - RETIRE_MS + 60_000 }), NOW, {
      post: async () => { posted = true; return "delivered" as PostOutcome; },
      deleteRecord: async () => { deleted = true; },
    });
    expect(v).toBe("skip");
    expect(posted).toBe(false);
    expect(deleted).toBe(false);
  });

  test("a transiently-FAILED end still deletes the record (best-effort; worker eviction backstops)", async () => {
    const deletes: string[] = [];
    const v = await retireDoneStale(cfg(), "/tmp/s.json", "s", done(), NOW, {
      post: async () => "failed" as PostOutcome,
      deleteRecord: async (p) => { deletes.push(p); },
    });
    expect(v).toBe("retired-offline"); // deleted, but not counted as a delivered proof-of-life
    expect(deletes).toEqual(["/tmp/s.json"]);
  });

  test("a Codex done row becomes a local owner marker so discovery cannot recreate its live TUI", async () => {
    const posts: object[] = [];
    const writes: SessionRecord[] = [];
    const deletes: string[] = [];
    const record = done({ agent: "codex", pid: 937, tuiPid: undefined });
    const v = await retireDoneStale(cfg(), "/tmp/s.json", "s", record, NOW, {
      post: async (body) => { posts.push(body); return "delivered" as PostOutcome; },
      locateTuiPid: async () => 64799,
      pidAlive: (pid) => pid === 64799,
      writeRecord: async (_path, next) => { writes.push(next); },
      deleteRecord: async (path) => { deletes.push(path); },
    });
    expect(v).toBe("retired");
    expect(posts).toHaveLength(1);
    expect(deletes).toEqual([]);
    expect(writes).toEqual([expect.objectContaining({
      agent: "codex", pid: 64799, tuiPid: 64799, retiredAt: NOW,
    })]);
    expect(writes[0].blob).toBeUndefined();
    expect(writes[0].op).toBeUndefined();
  });

  test("a headless/unowned Codex done row deletes normally because discovery has no TUI to recreate", async () => {
    const deletes: string[] = [];
    const v = await retireDoneStale(cfg(), "/tmp/s.json", "s", done({ agent: "codex", pid: 937 }), NOW, {
      post: async () => "delivered" as PostOutcome,
      locateTuiPid: async () => undefined,
      deleteRecord: async (path) => { deletes.push(path); },
    });
    expect(v).toBe("retired");
    expect(deletes).toEqual(["/tmp/s.json"]);
  });

  test("a 404 (revoked) bails WITHOUT deleting — the record is left for the loop's teardown", async () => {
    let deleted = false;
    const v = await retireDoneStale(cfg(), "/tmp/s.json", "s", done(), NOW, {
      post: async () => "revoked" as PostOutcome,
      deleteRecord: async () => { deleted = true; },
    });
    expect(v).toBe("revoked");
    expect(deleted).toBe(false);
  });

  test("a working Claude session idle 2 h is NEVER retired (retire only ever touches done rows)", async () => {
    let posted = false;
    let deleted = false;
    const working = rec({ lastEvent: "working", op: "update", blob: "WORK", ts: NOW - RETIRE_MS * 2 });
    const v = await retireDoneStale(cfg(), "/tmp/s.json", "s", working, NOW, {
      post: async () => { posted = true; return "delivered" as PostOutcome; },
      deleteRecord: async () => { deleted = true; },
    });
    expect(v).toBe("skip");
    expect(posted).toBe(false);
    expect(deleted).toBe(false);
    // A working session in the heartbeat window (past 5 min, under the 30 min reap) keeps heartbeating —
    // retire never intervenes for a working row (past 30 min the v1.1.6 reap, not retire, owns its fate).
    expect(shouldHeartbeat(rec({ lastEvent: "working", op: "update", blob: "WORK", ts: NOW - 600_000 }), NOW, undefined, false)).toBe(true);
  });

  test("a needsAttention session idle 2 h is kept (an unanswered prompt must keep heartbeating)", async () => {
    let posted = false;
    const attn = rec({ lastEvent: "needsAttention", op: "update", prio: 1, blob: "ATTN", ts: NOW - RETIRE_MS * 2 });
    const v = await retireDoneStale(cfg(), "/tmp/s.json", "s", attn, NOW, {
      post: async () => { posted = true; return "delivered" as PostOutcome; },
      deleteRecord: async () => {},
    });
    expect(v).toBe("skip");
    expect(posted).toBe(false);
    expect(shouldHeartbeat(attn, NOW, undefined, false)).toBe(true); // still heartbeated
  });
});

// --- codex interrupt detection (turn_aborted marker) ----------------------------------------
//
// Codex has no user/assistant transcript lines; its rollout persists a `event_msg` with payload.type
// "turn_aborted" on Esc/abort (EventMsg::TurnAborted). The net finds the LAST turn-lifecycle boundary
// (task_started / task_complete / turn_aborted) and corrects only when it is turn_aborted.
describe("codexLastTurnEvent + tailShowsInterrupt (agent-parametrized marker)", () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type, ...extra } });

  test("returns the LAST turn boundary, skipping non-boundary event_msg noise", () => {
    const tail = [ev("task_started"), ev("agent_message", { message: "working" }), ev("turn_aborted", { reason: "interrupted" })].join("\n");
    expect(codexLastTurnEvent(tail)).toBe("turn_aborted");
  });
  test("a later task_started (a resumed/fresh turn after an abort) means NOT aborted", () => {
    const tail = [ev("turn_aborted"), ev("user_message", { message: "again" }), ev("task_started")].join("\n");
    expect(codexLastTurnEvent(tail)).toBe("task_started");
  });
  test("null when no turn boundary is present / empty / bad json", () => {
    expect(codexLastTurnEvent(ev("agent_message", { message: "x" }))).toBeNull();
    expect(codexLastTurnEvent("")).toBeNull();
    expect(codexLastTurnEvent("not json at all")).toBeNull();
  });
  test("tailShowsInterrupt: codex keys on turn_aborted, claude keys on the interrupt marker", () => {
    expect(tailShowsInterrupt(ev("turn_aborted"), "codex")).toBe(true);
    expect(tailShowsInterrupt(ev("task_complete"), "codex")).toBe(false);
    expect(tailShowsInterrupt([ev("turn_aborted"), ev("task_started")].join("\n"), "codex")).toBe(false);
    // Claude path is unchanged: its assistant line carrying the marker still triggers.
    const claudeTail = asstTurn("[Request interrupted by user]");
    expect(tailShowsInterrupt(claudeTail, "claude")).toBe(true);
    expect(tailShowsInterrupt(asstTurn("still working"), "claude")).toBe(false);
    // Cross-agent guard: a codex tail read with the claude marker (no user/assistant line) → false.
    expect(tailShowsInterrupt(ev("turn_aborted"), "claude")).toBe(false);
  });
});

describe("buildHeartbeatEnvelope (re-send the stored blob to re-arm staleness)", () => {
  test("re-sends the record's stored blob under its stored op/prio with a fresh ts", () => {
    const r = rec({ op: "update", prio: 0, blob: "STOREDBLOB" });
    expect(buildHeartbeatEnvelope("s", r, 1_700_000_000_000))
      .toEqual({ v: 2, sessionId: "s", op: "update", prio: 0, ts: 1_700_000_000_000, blob: "STOREDBLOB" });
  });
  test("preserves a done op/prio1 faithfully (never flips the session's state)", () => {
    const r = rec({ op: "done", prio: 1, blob: "B" });
    expect(buildHeartbeatEnvelope("s", r, 5)).toMatchObject({ op: "done", prio: 1, blob: "B" });
  });
  test("null when the record has no stored blob (a pre-v2 record) — nothing to heartbeat", () => {
    expect(buildHeartbeatEnvelope("s", rec(), 5)).toBeNull();
    expect(buildHeartbeatEnvelope("s", rec({ blob: "" }), 5)).toBeNull();
  });
  test("threads the record's cached start onto the heartbeat/done envelopes (worker keeps session-birth timing)", async () => {
    expect(buildHeartbeatEnvelope("s", rec({ op: "update", blob: "B", sessionStartedAt: 700 }), 5)).toMatchObject({ startedAt: 700 });
    const done = await buildDoneEnvelope("s", rec({ machine: "m", label: "l", sessionStartedAt: 700 }), 5, KEY) as Record<string, unknown>;
    expect(done).toMatchObject({ startedAt: 700 });
    // Absent on a pre-fix record with no cached start.
    expect(buildHeartbeatEnvelope("s", rec({ op: "update", blob: "B" }), 5)).not.toHaveProperty("startedAt");
  });
  test("re-sends the stored blob VERBATIM, so a sealed `at` stays FROZEN across every heartbeat (v1.1.6)", async () => {
    // The freeze mechanism: the hook seals `at` (the real event time) into the blob; the heartbeat re-sends
    // that exact string, so the worker's lastEventAt churns on the fresh envelope ts but the phone reads the
    // UNCHANGED `at` and ages the row from the real event — never from the heartbeat's clock.
    const sealed = await import("../core/crypto").then((m) =>
      m.encryptBlob(KEY, { status: "working", title: "t", machine: "m", label: "proj", at: 1_751_900_000 }));
    const r = rec({ op: "update", prio: 0, blob: sealed });
    const beatA = buildHeartbeatEnvelope("s", r, 5_000) as { blob: string };
    const beatB = buildHeartbeatEnvelope("s", r, 9_999_999) as { blob: string };
    expect(beatA.blob).toBe(sealed); // byte-identical — not re-encrypted
    expect(beatB.blob).toBe(sealed); // and still identical on a much-later heartbeat
    expect(await decryptBlob(KEY, beatB.blob)).toMatchObject({ at: 1_751_900_000 }); // `at` frozen despite ts churn
  });
});

// --- the transcript "interrupted by user" recovery net --------------------------------------

const irec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  pid: 4242, machine: "mac", label: "proj", ts: 1_000_000, transcript: "/tmp/t.jsonl",
  lastEvent: "working", ...over,
});

const row = (o: unknown) => JSON.stringify(o);
const userTurn = (text: string) => row({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const asstTurn = (text: string) => row({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

describe("lastTurnLine", () => {
  test("returns the LAST user/assistant line, skipping trailing bookkeeping lines", () => {
    const t = [
      userTurn("first prompt"),
      asstTurn("[Request interrupted by user]"),
      row({ type: "system", subtype: "post_interrupt" }),
      row({ type: "summary", summary: "did stuff" }),
    ].join("\n");
    expect(lastTurnLine(t)).toBe(asstTurn("[Request interrupted by user]"));
  });

  test("tolerates a truncated first line (byte-sliced tail) — it just fails JSON.parse and is skipped", () => {
    const truncated = '_id":"abc","type":"assistant","message":{"content":"tail"}}';
    const t = [truncated, userTurn("the real last turn")].join("\n");
    expect(lastTurnLine(t)).toBe(userTurn("the real last turn"));
  });

  test("returns the last turn even when a trailing line is a truncated/partial write", () => {
    const t = [userTurn("done turn"), '{"type":"assist'].join("\n");
    expect(lastTurnLine(t)).toBe(userTurn("done turn"));
  });

  test("null when no user/assistant line is present", () => {
    expect(lastTurnLine(row({ type: "system", x: 1 }))).toBeNull();
    expect(lastTurnLine("")).toBeNull();
    expect(lastTurnLine("not json at all")).toBeNull();
  });
});

describe("hasInterruptMarker", () => {
  test("true when the raw line carries the interrupt marker", () => {
    expect(hasInterruptMarker(userTurn("[Request interrupted by user]"))).toBe(true);
    expect(hasInterruptMarker(userTurn("[Request interrupted by user for tool use]"))).toBe(true);
  });
  test("false for an ordinary turn line", () => {
    expect(hasInterruptMarker(userTurn("please refactor this"))).toBe(false);
    expect(hasInterruptMarker(asstTurn("Sure, working on it."))).toBe(false);
  });
});

describe("shouldInterruptCheck (gate matrix)", () => {
  const now = 2_000_000;
  test("needsAttention → check (every sweep, no ts-age gate)", () => {
    expect(shouldInterruptCheck(irec({ lastEvent: "needsAttention", ts: now }), now)).toBe(true);
  });
  test("working but fresh (≤20s) → skip", () => {
    expect(shouldInterruptCheck(irec({ lastEvent: "working", ts: now - 19_000 }), now)).toBe(false);
    expect(shouldInterruptCheck(irec({ lastEvent: "working", ts: now - 20_000 }), now)).toBe(false);
  });
  test("working and stale (>20s) → check", () => {
    expect(shouldInterruptCheck(irec({ lastEvent: "working", ts: now - 20_001 }), now)).toBe(true);
  });
  test("done / sessionStart → skip", () => {
    expect(shouldInterruptCheck(irec({ lastEvent: "done", ts: now - 60_000 }), now)).toBe(false);
    expect(shouldInterruptCheck(irec({ lastEvent: "sessionStart", ts: now - 60_000 }), now)).toBe(false);
  });
  test("missing / empty transcript → skip even when it would otherwise check", () => {
    expect(shouldInterruptCheck(irec({ lastEvent: "needsAttention", transcript: "" }), now)).toBe(false);
    expect(shouldInterruptCheck({ ...irec({ lastEvent: "needsAttention" }), transcript: undefined } as unknown as SessionRecord, now)).toBe(false);
  });
});

// --- self-heal wall-clock deadline ----------------------------------------------------------

describe("pendingPairingExpired (bounds the watchdog self-heal so an unreachable worker can't poll forever)", () => {
  const pending = (over: Partial<PendingConfig> = {}): PendingConfig => ({
    url: "https://w.test", pairingId: "p", pcSecret: "s", qrSecret: new Uint8Array(16), ...over,
  });

  test("createdAt + TTL is the deadline when the pending config carries a createdAt", () => {
    const created = 1_000_000;
    expect(pendingPairingExpired(pending({ createdAt: created }), created + PAIRING_TTL_MS - 1, Number.POSITIVE_INFINITY)).toBe(false);
    expect(pendingPairingExpired(pending({ createdAt: created }), created + PAIRING_TTL_MS, Number.POSITIVE_INFINITY)).toBe(true);
  });

  test("a pending config without createdAt (older hook) falls back to the process-local deadline", () => {
    expect(pendingPairingExpired(pending(), 999, 1000)).toBe(false);
    expect(pendingPairingExpired(pending(), 1000, 1000)).toBe(true);
  });

  test("PAIRING_TTL_MS matches the worker's 10-minute pending TTL", () => {
    expect(PAIRING_TTL_MS).toBe(600_000);
  });
});

// --- phone-initiated revoke: definitive-vs-transient HTTP keying ----------------------------
//
// When the phone forgets a pairing, the server deletes the record, so requirePCAuth 404s every PC
// event (server/src/pairing.ts). The watchdog keys ONLY on that 404 to tear down the local config;
// a 401 (ambiguous), a 429/5xx, or a network error must stay transient so a healthy config is never
// deleted on a blip. postOutcomeForStatus is that decision, isolated and pure.

describe("postOutcomeForStatus (the definitive-revoke HTTP keying)", () => {
  test("2xx → delivered (the event landed)", () => {
    expect(postOutcomeForStatus(200)).toBe("delivered");
    expect(postOutcomeForStatus(201)).toBe("delivered");
    expect(postOutcomeForStatus(204)).toBe("delivered");
  });

  test("404 → revoked (the pairing record is gone server-side — requirePCAuth's not-found)", () => {
    expect(postOutcomeForStatus(404)).toBe("revoked");
  });

  test("410 → revoked (the worker's dormant-GC 'gone once' signal, before it 404s)", () => {
    expect(postOutcomeForStatus(410)).toBe("revoked");
  });

  test("401 is NOT revoked — it is ambiguous (missing header / mismatched secret), so it stays transient", () => {
    expect(postOutcomeForStatus(401)).toBe("failed");
  });

  test("429 / 5xx are transient failures (never delete a healthy config)", () => {
    expect(postOutcomeForStatus(429)).toBe("failed");
    expect(postOutcomeForStatus(500)).toBe("failed");
    expect(postOutcomeForStatus(502)).toBe("failed");
    expect(postOutcomeForStatus(503)).toBe("failed");
  });

  test("400 (bad event) is a transient failure, not a revoke", () => {
    expect(postOutcomeForStatus(400)).toBe("failed");
  });
});

// --- PID-gated staleness heartbeat ----------------------------------------------------------

const HEARTBEAT_AFTER_MS = 300_000; // must mirror the constant in cc-watchdog.ts

describe("shouldHeartbeat (decision matrix)", () => {
  const now = 5_000_000;
  const quiet = () => rec({ ts: now - HEARTBEAT_AFTER_MS }); // event-quiet exactly at the threshold

  test("quiet + alive + never-heartbeated + uncorrected → heartbeat", () => {
    expect(shouldHeartbeat(quiet(), now, undefined, false)).toBe(true);
    expect(shouldHeartbeat(rec({ ts: now - HEARTBEAT_AFTER_MS - 1 }), now, undefined, false)).toBe(true);
  });

  test("recently active (quiet < 5 min) → no heartbeat (hooks are already keeping it fresh)", () => {
    expect(shouldHeartbeat(rec({ ts: now - (HEARTBEAT_AFTER_MS - 1) }), now, undefined, false)).toBe(false);
    expect(shouldHeartbeat(rec({ ts: now - 15_000 }), now, undefined, false)).toBe(false);
  });

  test("throttled: a heartbeat within the last 5 min blocks another, then re-arms", () => {
    expect(shouldHeartbeat(quiet(), now, now - 1_000, false)).toBe(false);
    expect(shouldHeartbeat(quiet(), now, now - HEARTBEAT_AFTER_MS, false)).toBe(true);
  });

  test("failed POST leaves the throttle unset, so quietness stays true and it retries next sweep", () => {
    expect(shouldHeartbeat(quiet(), now, undefined, false)).toBe(true);
    expect(shouldHeartbeat(rec({ ts: now - HEARTBEAT_AFTER_MS }), now + 5_000, undefined, false)).toBe(true);
  });

  test("the interrupt net just corrected this session → no heartbeat (it is effectively done)", () => {
    expect(shouldHeartbeat(quiet(), now, undefined, true)).toBe(false);
  });

  test("a record with a non-numeric ts is never heartbeated", () => {
    expect(shouldHeartbeat({ ...quiet(), ts: undefined } as unknown as SessionRecord, now, undefined, false)).toBe(false);
  });

  test("dead-pid sessions never reach the heartbeat branch (they route to `end`, not `keep`)", () => {
    expect(classifySession(quiet(), now, () => false)).toBe("end");
    expect(classifySession(quiet(), now, () => true)).toBe("keep");
  });

  test("record.op === 'done' → never heartbeated, even quiet/never-heartbeated/uncorrected (mirrors shouldInterruptCheck's done skip)", () => {
    expect(shouldHeartbeat(rec({ op: "done", ts: now - HEARTBEAT_AFTER_MS }), now, undefined, false)).toBe(false);
    expect(shouldHeartbeat(rec({ op: "done", ts: now - HEARTBEAT_AFTER_MS - 1 }), now, undefined, false)).toBe(false);
  });

  test("a working/update op under the SAME conditions is still heartbeated (done is the only op gated out)", () => {
    expect(shouldHeartbeat(rec({ op: "update", ts: now - HEARTBEAT_AFTER_MS }), now, undefined, false)).toBe(true);
    expect(shouldHeartbeat(rec({ ts: now - HEARTBEAT_AFTER_MS }), now, undefined, false)).toBe(true); // no op field at all (pre-v2 record)
  });
});

// --- watchdog gone-strike gate (a single transient 404 must NOT nuke a healthy pairing) ----------
//
// FINDING 1 fix: the watchdog used to map ONE 404/410 → immediate removeRevokedConfig(), which defeated
// the hook's 2-strike transient-404 guard — a single transient 404 (worker redeploy / KV eventual-
// consistency) on the watchdog's /cc/event POST would nuke a healthy pairing's credential config.
// Now the watchdog counts against the SAME shared gone-strike counter and only tears down at
// GONE_STRIKE_LIMIT. goneStrikeShouldTeardown is that decision, exercised here against a temp counter.
describe("watchdog gone-strike gate (shared 2-strike teardown, not single-strike)", () => {
  async function tmpStrikes(): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "cc-wd-strike-"));
    const path = join(dir, "gone-strikes");
    return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }
  async function exists(p: string): Promise<boolean> {
    try { await stat(p); return true; } catch { return false; }
  }

  test("a single watchdog 404 does NOT tear down, and increments the shared counter (retryable)", async () => {
    const { path, cleanup } = await tmpStrikes();
    try {
      // GONE_STRIKE_LIMIT is 2, so the first strike is below the teardown threshold.
      expect(await goneStrikeShouldTeardown(path)).toBe(false);
      expect(await readGoneStrikes(path)).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("a second consecutive watchdog gone response DOES tear down (reaches GONE_STRIKE_LIMIT)", async () => {
    const { path, cleanup } = await tmpStrikes();
    try {
      expect(await goneStrikeShouldTeardown(path)).toBe(false); // strike 1
      expect(await goneStrikeShouldTeardown(path)).toBe(true);   // strike 2 → teardown
      expect(await readGoneStrikes(path)).toBe(GONE_STRIKE_LIMIT);
    } finally {
      await cleanup();
    }
  });

  test("a delivered sweep between two watchdog gones resets the streak → no false teardown", async () => {
    const { path, cleanup } = await tmpStrikes();
    try {
      expect(await goneStrikeShouldTeardown(path)).toBe(false); // strike 1
      await resetGoneStrikes(path);                              // a delivered POST cleared it
      expect(await exists(path)).toBe(false);
      expect(await goneStrikeShouldTeardown(path)).toBe(false); // strike 1 again — NOT 2
    } finally {
      await cleanup();
    }
  });

  test("hook and watchdog share ONE streak: a hook strike then a watchdog strike tears down at 2 combined", async () => {
    const { path, cleanup } = await tmpStrikes();
    try {
      // The hook's POST path records a gone strike (recordGoneStrike) …
      expect(await recordGoneStrike(path)).toBe(1);
      // … and the watchdog's next gone response, counting the SAME file, hits the limit and tears down.
      // This is the designed semantic: both POST to the same /cc/event for the same pairing, so a
      // genuine revoke 404s BOTH — combining their strikes reaches teardown faster while a lone
      // transient blip from either never does.
      expect(await goneStrikeShouldTeardown(path)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

// --- the pending-approval backstop (dropped Codex PermissionRequest #16430) ------------------
//
// On Codex, needsAttention hangs off ONE thread: the PermissionRequest hook. Codex has no Notification
// event and drops hooks silently, so the watchdog scans the rollout tail for a pending approval and
// re-raises needsAttention. buildNeedsAttentionEnvelope must match the REAL PermissionRequest wire path
// (hook.ts planOp: PermissionRequest → op:update / prio:1 / status:needsAttention). shouldPendingApproval-
// Check is the once-per-episode + skip-claude/done/no-transcript gate.

describe("buildNeedsAttentionEnvelope (dropped-hook corrective → same envelope PermissionRequest sends)", () => {
  test("is a v2 op:update / prio 1 whose blob decrypts to needsAttention with the record's machine/label", async () => {
    const e = await buildNeedsAttentionEnvelope("sess-7", rec({ machine: "Mac", label: "api-status" }), 1_700_000_000_000, KEY) as Record<string, unknown>;
    // op/prio/status EXACTLY mirror hook.ts planOp("PermissionRequest") + buildBlob.
    expect(e).toMatchObject({ v: 2, sessionId: "sess-7", op: "update", prio: 1, ts: 1_700_000_000_000 });
    expect(await decryptBlob(KEY, e.blob as string)).toEqual({ status: "needsAttention", title: "", machine: "Mac", label: "api-status" });
  });
  test("coerces a corrupt-but-parsed record's missing machine/label to empty strings", async () => {
    const bad = { pid: 1, ts: 1 } as unknown as SessionRecord;
    const e = await buildNeedsAttentionEnvelope("s", bad, 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, e.blob as string)).toMatchObject({ status: "needsAttention", machine: "", label: "" });
  });
  test("codex (agent arg) restamps the blob's agent:'codex'; claude (default) omits it", async () => {
    const codexEnv = await buildNeedsAttentionEnvelope("s", rec({ machine: "Mac", label: "proj" }), 5, KEY, "codex") as Record<string, unknown>;
    expect(await decryptBlob(KEY, codexEnv.blob as string)).toMatchObject({ status: "needsAttention", agent: "codex" });
    const claudeEnv = await buildNeedsAttentionEnvelope("s", rec(), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, claudeEnv.blob as string)).not.toHaveProperty("agent");
  });
  test("preserves the record's cached turnStartedAt + startedAt (island timer keeps the same turn)", async () => {
    const e = await buildNeedsAttentionEnvelope("s", rec({ turnStartedAt: 1_751_900_000, sessionStartedAt: 700 }), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, e.blob as string)).toMatchObject({ status: "needsAttention", turnStartedAt: 1_751_900_000 });
    expect(e).toMatchObject({ startedAt: 700 });          // clear envelope carries the session start
    expect(e).not.toHaveProperty("turnStartedAt");        // turn anchor is blob-only
    const bare = await buildNeedsAttentionEnvelope("s", rec(), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, bare.blob as string)).not.toHaveProperty("turnStartedAt");
    expect(bare).not.toHaveProperty("startedAt");
  });
  test("preserves the record's cached model in the rebuilt blob (like buildDoneEnvelope); omits when absent", async () => {
    const withModel = await buildNeedsAttentionEnvelope("s", rec({ model: "gpt-5-codex" }), 5, KEY, "codex") as Record<string, unknown>;
    expect(await decryptBlob(KEY, withModel.blob as string)).toMatchObject({ status: "needsAttention", agent: "codex", model: "gpt-5-codex" });
    expect(withModel).not.toHaveProperty("model"); // blob-only — never on the clear envelope
    const without = await buildNeedsAttentionEnvelope("s", rec(), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, without.blob as string)).not.toHaveProperty("model"); // omitted, never ""
  });
  test("carries a recovered request_user_input question as encrypted detail; omits it for plain approvals", async () => {
    const withQuestion = await buildNeedsAttentionEnvelope(
      "s", rec({ machine: "Mac", label: "proj" }), 5, KEY, "codex", 5,
      "Scope: Which API should the plan preserve?", "userInput",
    ) as Record<string, unknown>;
    expect(withQuestion.attentionKind).toBe("userInput");
    expect(await decryptBlob(KEY, withQuestion.blob as string)).toMatchObject({
      status: "needsAttention",
      detail: "Scope: Which API should the plan preserve?",
      agent: "codex",
    });
    const approval = await buildNeedsAttentionEnvelope("s", rec(), 5, KEY, "codex", 5) as Record<string, unknown>;
    expect(approval).not.toHaveProperty("attentionKind");
    expect(await decryptBlob(KEY, approval.blob as string)).not.toHaveProperty("detail");
    const claude = await buildNeedsAttentionEnvelope(
      "s", rec(), 5, KEY, "claude", 5, "Question?", "userInput",
    ) as Record<string, unknown>;
    expect(claude).not.toHaveProperty("attentionKind");
  });

  test("a proven Plan-picker frame carries capped plan markdown; ordinary attention omits it", async () => {
    const pending = await buildNeedsAttentionEnvelope(
      "s", rec({ machine: "Mac", label: "proj" }), 5, KEY, "codex", 5, undefined, "userInput",
      "# Plan\n\n" + "x".repeat(5000),
    ) as Record<string, unknown>;
    const pendingBlob = await decryptBlob(KEY, pending.blob as string);
    expect(pendingBlob.plan).toBeString();
    expect((pendingBlob.plan as string).endsWith("\n…")).toBe(true);
    const ordinary = await buildNeedsAttentionEnvelope(
      "s", rec({ machine: "Mac", label: "proj" }), 5, KEY, "codex", 5, undefined, "userInput",
    ) as Record<string, unknown>;
    expect(await decryptBlob(KEY, ordinary.blob as string)).not.toHaveProperty("plan");
  });
});

describe("shouldPendingApprovalCheck (gate: once-per-episode + skip claude/done/no-transcript)", () => {
  const arec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    pid: 4242, machine: "mac", label: "proj", ts: 1_000_000, transcript: "/tmp/r.jsonl",
    lastEvent: "working", agent: "codex", ...over,
  });

  test("codex + working + transcript + not-attention → check", () => {
    expect(shouldPendingApprovalCheck(arec(), codexAdapter)).toBe(true);
  });
  test("a fresh sessionStart can still block on its first tool → check", () => {
    expect(shouldPendingApprovalCheck(arec({ lastEvent: "sessionStart" }), codexAdapter)).toBe(true);
  });
  test("already needsAttention → skip (dedup: fire ONCE per pending episode, no double-post)", () => {
    expect(shouldPendingApprovalCheck(arec({ lastEvent: "needsAttention" }), codexAdapter)).toBe(false);
  });
  test("a finished (done) session isn't awaiting approval → skip", () => {
    expect(shouldPendingApprovalCheck(arec({ lastEvent: "done" }), codexAdapter)).toBe(false);
    expect(shouldPendingApprovalCheck(arec({ op: "done" }), codexAdapter)).toBe(false);
  });
  test("claude records are now checked too — the adapter backstops a dropped PreToolUse", () => {
    // claudeAdapter gained tailShowsPendingApproval (the dropped-PreToolUse backstop), so a working
    // claude session with a transcript is checkable, exactly like a codex one.
    expect(shouldPendingApprovalCheck(arec({ agent: undefined }), claudeAdapter)).toBe(true);
    // the same gates still apply to claude records: already-attention and done are skipped
    expect(shouldPendingApprovalCheck(arec({ agent: undefined, lastEvent: "needsAttention" }), claudeAdapter)).toBe(false);
    expect(shouldPendingApprovalCheck(arec({ agent: undefined, lastEvent: "done" }), claudeAdapter)).toBe(false);
  });
  test("missing / empty transcript → skip", () => {
    expect(shouldPendingApprovalCheck(arec({ transcript: "" }), codexAdapter)).toBe(false);
    expect(shouldPendingApprovalCheck({ ...arec(), transcript: undefined } as unknown as SessionRecord, codexAdapter)).toBe(false);
  });
});

// The pending-approval net's RESTAMP is the whole point of the net surviving one sweep: without
// `blob: envelope.blob` on the rewritten record, the very next staleness heartbeat re-broadcasts the
// STALE pre-question "working" blob verbatim (buildHeartbeatEnvelope re-sends record.blob byte for byte)
// and the phone row reverts off needsAttention — the exact bug this net exists to prevent. The
// question detail + the clear `attentionKind` discriminator must likewise reach the POSTed envelope, or
// the phone shows a bare "needs attention" with no question and the server can't scope the episode.
describe("correctPendingApproval (corrective POST + record restamp so the heartbeat can't revert it)", () => {
  const NOW = 7_000_000;
  // A codex session mid-turn whose stored blob is the PRE-question "working" frame (what a heartbeat
  // would re-send) — the state a dropped request_user_input hook leaves behind.
  const blocked = (over: Partial<SessionRecord> = {}): SessionRecord =>
    rec({ agent: "codex", lastEvent: "working", op: "update", prio: 0, sentDone: false,
          blob: "STALE-WORKING-BLOB", title: "Migrate the router", transcript: "/tmp/rollout.jsonl", ts: NOW - 1000, ...over });
  // A rollout tail whose last decisive line is a persisted request_user_input call → pending, with a
  // recoverable first question (structurally equivalent to a real rollout; no private content).
  const userInputTail = JSON.stringify({
    type: "response_item",
    payload: {
      type: "function_call", name: "request_user_input",
      arguments: JSON.stringify({ questions: [{ header: "Scope", question: "Which API should the plan preserve?" }] }),
    },
  });
  // A plain pending approval (no request_user_input): no detail, no attentionKind.
  const approvalTail = JSON.stringify({ type: "event_msg", payload: { type: "exec_approval_request" } });

  test("delivered → the REWRITTEN record carries the POSTED envelope's blob (not the stale working one)", async () => {
    const posts: Record<string, unknown>[] = [];
    const writes: SessionRecord[] = [];
    const v = await correctPendingApproval(cfg(), "/tmp/s.json", "s", blocked(), NOW, {
      post: async (b) => { posts.push(b as Record<string, unknown>); return "delivered" as PostOutcome; },
      readTail: async () => userInputTail,
      writeRecord: async (_p, r) => { writes.push(r); },
      now: () => 5_555_000,
    });
    expect(v).toBe("corrected");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ op: "update", prio: 1, ts: 5_555_000 });
    expect(writes).toHaveLength(1);
    // THE restamp: identical bytes to what was posted, and NOT the pre-question working blob.
    expect(writes[0].blob).toBe(posts[0].blob as string);
    expect(writes[0].blob).not.toBe("STALE-WORKING-BLOB");
    expect(writes[0]).toMatchObject({ lastEvent: "needsAttention", op: "update", prio: 1, sentDone: false });
    // And the restamped record heartbeats the CORRECTIVE attention frame, never the stale working one.
    expect(buildHeartbeatEnvelope("s", writes[0], 9)).toMatchObject({ blob: posts[0].blob as string, op: "update", prio: 1 });
  });

  test("the adapter's question detail + attentionKind are threaded into the POSTED envelope", async () => {
    const posts: Record<string, unknown>[] = [];
    await correctPendingApproval(cfg(), "/tmp/s.json", "s", blocked(), NOW, {
      post: async (b) => { posts.push(b as Record<string, unknown>); return "delivered" as PostOutcome; },
      readTail: async () => userInputTail,
      writeRecord: async () => {},
    });
    expect(posts[0].attentionKind).toBe("userInput"); // clear discriminator (server scopes the episode)
    expect(await decryptBlob(KEY, posts[0].blob as string)).toMatchObject({
      status: "needsAttention",
      detail: "Scope: Which API should the plan preserve?", // recovered from the persisted arguments
      title: "Migrate the router",
      agent: "codex",
    });
  });

  test("a plain pending approval posts NO detail and NO attentionKind (legacy envelope shape kept)", async () => {
    const posts: Record<string, unknown>[] = [];
    await correctPendingApproval(cfg(), "/tmp/s.json", "s", blocked(), NOW, {
      post: async (b) => { posts.push(b as Record<string, unknown>); return "delivered" as PostOutcome; },
      readTail: async () => approvalTail,
      writeRecord: async () => {},
    });
    expect(posts[0]).not.toHaveProperty("attentionKind");
    expect(await decryptBlob(KEY, posts[0].blob as string)).not.toHaveProperty("detail");
  });

  test("a FAILED post leaves the record untouched (retry next sweep); a revoke bubbles up", async () => {
    let writes = 0;
    const seams = { readTail: async () => userInputTail, writeRecord: async () => { writes++; } };
    expect(await correctPendingApproval(cfg(), "/tmp/s.json", "s", blocked(), NOW, {
      ...seams, post: async () => "failed" as PostOutcome,
    })).toBe("uncorrected");
    expect(await correctPendingApproval(cfg(), "/tmp/s.json", "s", blocked(), NOW, {
      ...seams, post: async () => "revoked" as PostOutcome,
    })).toBe("revoked");
    expect(writes).toBe(0); // no restamp on a non-2xx → the stale blob stays, the net retries
  });

  test("gate closed / no pending approval / unreadable transcript → nothing posted", async () => {
    let posted = 0;
    const seams = {
      post: async () => { posted++; return "delivered" as PostOutcome; },
      writeRecord: async () => {},
    };
    // already surfaced (dedup gate)
    expect(await correctPendingApproval(cfg(), "/tmp/s.json", "s", blocked({ lastEvent: "needsAttention" }), NOW, {
      ...seams, readTail: async () => userInputTail,
    })).toBe("uncorrected");
    // tail shows a RESOLVED episode
    expect(await correctPendingApproval(cfg(), "/tmp/s.json", "s", blocked(), NOW, {
      ...seams, readTail: async () => JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    })).toBe("uncorrected");
    // transcript missing / cold-compressed
    expect(await correctPendingApproval(cfg(), "/tmp/s.json", "s", blocked(), NOW, {
      ...seams, readTail: async () => { throw new Error("ENOENT"); },
    })).toBe("uncorrected");
    expect(posted).toBe(0);
  });
});

describe("codexTailPendingApproval re-export (parser reachable through ./cc-watchdog)", () => {
  const ev = (type: string) => JSON.stringify({ type: "event_msg", payload: { type } });
  test("a trailing approval request → pending; a resolved one → not", () => {
    expect(codexTailPendingApproval(ev("exec_approval_request"))).toBe(true);
    expect(codexTailPendingApproval([ev("exec_approval_request"), ev("task_complete")].join("\n"))).toBe(false);
  });
});

describe("correctResolvedPlanPicker (Mac answer clears only the marked Plan wait)", () => {
  const blockedPlan = (over: Partial<SessionRecord> = {}): SessionRecord => rec({
    agent: "codex", transcript: "/tmp/rollout.jsonl", lastEvent: "needsAttention",
    op: "update", prio: 1, sentDone: false, pendingPlanPicker: true,
    blob: "PENDING-PLAN", title: "Implement the plan", pairingId: "p", ts: 7_999_000, ...over,
  });

  const daemonSession = (over: Partial<SessionRecord> = {}): SessionRecord => blockedPlan({
    sessionStartedAt: 10_000,
    origin: {
      hook_event_name: "UserPromptSubmit", cwd: "/Users/me/project", ppid: 937,
      ppid_command: "/Users/me/.codex/packages/standalone/current/codex app-server --listen unix://",
    },
    ...over,
  });
  const tui = (pid: number, over: Partial<SessionRecord> = {}): SessionRecord => rec({
    pid, agent: "codex", provisional: true, tuiCwd: "/Users/me/project", tuiStartedAt: 10_005,
    ...over,
  });

  test("correlation requires one live real-TTY provisional with exact cwd and close process/session births", () => {
    const record = daemonSession();
    expect(correlateCodexTuiPid(record, [tui(5150)], () => true)).toBe(5150);
    expect(correlateCodexTuiPid(record, [tui(5150), tui(5151)], () => true)).toBeUndefined();
    expect(correlateCodexTuiPid(record, [tui(5150, { tuiCwd: "/Users/me/other" })], () => true)).toBeUndefined();
    expect(correlateCodexTuiPid(record, [tui(5150, { tuiStartedAt: 10_000 - CODEX_TUI_SESSION_START_SKEW_MS - 1 })], () => true)).toBeUndefined();
    expect(correlateCodexTuiPid(record, [tui(5150, { tuiStartedAt: 12_001 })], () => true)).toBeUndefined();
    expect(correlateCodexTuiPid(record, [tui(5150)], () => false)).toBeUndefined();
    expect(correlateCodexTuiPid(daemonSession({ origin: { ...record.origin!, ppid_command: "/Applications/ChatGPT.app/codex app-server" } }), [tui(5150)], () => true)).toBeUndefined();
  });

  test("retirement ownership accepts exact/cached owners but never borrows an unrelated lone TUI", () => {
    expect(resolveCodexTuiOwner(blockedPlan({ pid: 5150, origin: {
      hook_event_name: "Stop", ppid: 5150, ppid_command: "codex", cwd: "/Users/me/project",
    } }), [], () => true)).toBe(5150);
    expect(resolveCodexTuiOwner(daemonSession({ tuiPid: 5151 }), [], (pid) => pid === 5151)).toBe(5151);
    expect(resolveCodexTuiOwner(daemonSession(), [tui(5150, { tuiCwd: "/Users/me/other" })], () => true)).toBeUndefined();
    expect(resolveCodexTuiOwner(daemonSession(), [tui(5150)], () => true)).toBe(5150);
  });

  test("task_started/user_message resolution → working update and clears provenance marker", async () => {
    const posts: Record<string, unknown>[] = [];
    const writes: SessionRecord[] = [];
    const result = await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", blockedPlan(), {
      state: async () => "resolved",
      post: async (body) => { posts.push(body as Record<string, unknown>); return "delivered"; },
      writeRecord: async (_path, record) => { writes.push(record); },
      now: () => 8_000_000,
    });
    expect(result).toBe("corrected");
    expect(posts[0]).toMatchObject({ op: "update", prio: 0, ts: 8_000_000 });
    expect(posts[0]).not.toHaveProperty("attentionKind");
    const resolvedBlob = await decryptBlob(KEY, posts[0].blob as string);
    expect(resolvedBlob).toMatchObject({ status: "working", agent: "codex" });
    expect(resolvedBlob).not.toHaveProperty("plan");
    expect(writes[0]).toMatchObject({ lastEvent: "working", op: "update", prio: 0, sentDone: false });
    expect(writes[0].pendingPlanPicker).toBeUndefined();
  });

  test("still pending / unknown stays attention; an unmarked genuine attention episode is untouched", async () => {
    let posted = 0;
    const seams = {
      post: async () => { posted++; return "delivered" as PostOutcome; },
      writeRecord: async () => {},
    };
    expect(await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", blockedPlan(), {
      ...seams, state: async () => "pending", threadWaitState: async () => "waitingOnUserInput",
    })).toBe("uncorrected");
    expect(await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", blockedPlan(), {
      ...seams, state: async () => "pending", threadWaitState: async () => "notWaitingOnUserInput",
    })).toBe("uncorrected");
    expect(await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", blockedPlan(), {
      ...seams, state: async () => "unknown",
    })).toBe("uncorrected");
    expect(await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", blockedPlan({ pendingPlanPicker: undefined }), {
      ...seams, state: async () => "resolved",
    })).toBe("uncorrected");
    expect(posted).toBe(0);
  });

  test("unique correlation stamps the TUI pid, while a live TUI never resolves its pending picker", async () => {
    const record = daemonSession();
    let current = record;
    const posts: object[] = [];
    expect(await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", record, {
      tuiCandidates: async () => [tui(5150)],
      pidAlive: () => true,
      readRecord: async () => current,
      writeRecord: async (_path, next) => { current = next; },
      state: async () => "pending",
      threadWaitState: async () => "notWaitingOnUserInput",
      post: async (body) => { posts.push(body); return "delivered"; },
      now: () => 8_000_000,
    })).toBe("uncorrected");
    expect(current.tuiPid).toBe(5150);
    expect(current).toMatchObject({ pendingPlanPicker: true, lastEvent: "needsAttention", prio: 1 });
    expect(posts).toHaveLength(0);
  });

  test("a stamped TUI exit resolves within one sweep and emits ev:exit plus a tui-exit trace", async () => {
    let current = daemonSession({ tuiPid: 5150 });
    const posts: Record<string, unknown>[] = [];
    const traces: PlanPickerTraceDecision[] = [];
    expect(await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", current, {
      pidAlive: () => false,
      readRecord: async () => current,
      writeRecord: async (_path, next) => { current = next; },
      state: async () => { throw new Error("exit must precede rollout classification"); },
      post: async (body) => { posts.push(body as Record<string, unknown>); return "delivered"; },
      trace: (decision) => { traces.push(decision); },
      now: () => 8_000_000,
    })).toBe("corrected");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ op: "done", prio: 0 });
    expect(await decryptBlob(KEY, posts[0].blob as string)).toMatchObject({
      status: "done", agent: "codex", dbg: expect.stringContaining("ev:exit"),
    });
    expect(current).toMatchObject({ lastEvent: "done", op: "done", prio: 0, planPickerSettled: true });
    expect(current.pendingPlanPicker).toBeUndefined();
    expect(traces).toContainEqual(expect.objectContaining({
      source: "watchdog", classifier: "tui-exit", marker: "settled", ttlFired: false,
      settle: "done", correctionPosted: true, doneBy: "watchdog",
    }));
  });

  test("ambiguous TUI correlation keeps attention and still falls back to the hard TTL", async () => {
    let current = daemonSession({ planPickerPendingSince: 7_000_000 });
    const candidates = [tui(5150), tui(5151)];
    const posts: Record<string, unknown>[] = [];
    expect(await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", current, {
      tuiCandidates: async () => candidates,
      pidAlive: () => true,
      readRecord: async () => current,
      writeRecord: async (_path, next) => { current = next; },
      state: async () => "pending",
      threadWaitState: async () => "notWaitingOnUserInput",
      post: async (body) => { posts.push(body as Record<string, unknown>); return "delivered"; },
      now: () => 7_000_001,
    })).toBe("uncorrected");
    expect(current.tuiPid).toBeUndefined();
    expect(posts).toHaveLength(0);

    expect(await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", current, {
      tuiCandidates: async () => candidates,
      pidAlive: () => true,
      readRecord: async () => current,
      writeRecord: async (_path, next) => { current = next; },
      state: async () => { throw new Error("TTL must precede correlation/classification"); },
      post: async (body) => { posts.push(body as Record<string, unknown>); return "delivered"; },
      now: () => 7_000_000 + PLAN_PICKER_PENDING_MAX_MS,
    })).toBe("corrected");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ op: "done", prio: 0 });
  });

  test("process exit follows the existing terminal reap path", async () => {
    const record = blockedPlan();
    expect(classifySession(record, record.ts + 1, () => false)).toBe("end");
    expect(await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", record, {
      state: async () => "exited",
      post: async () => { throw new Error("must not post working"); },
    })).toBe("uncorrected");
  });
});

// --- the born-expired settle (a TTL-settled picker was retired seconds after it settled) ----------
//
// FIELD INCIDENT: a Codex turn ended into the plan-picker verification pending state and sat there until
// the hard TTL (PLAN_PICKER_PENDING_MAX_MS, 1 h) settled it to done. The settle spread the fresh record
// and flipped op/lastEvent, but never re-stamped `ts` — and RETIRE_AFTER_MS was the SAME 1 h — so the
// settled done was ALREADY past the retire horizon the instant it was written. The next sweep (~47 s
// later) posted a blob-less op:end and the worker hard-deleted the row: the done lived seconds, not an
// hour. The fix splits the two clocks — the retention clock (record.ts) restarts at the settle, the
// DISPLAY clock (the blob's `at`) stays frozen at the original event time.
describe("a TTL-settled plan picker starts a FRESH retention clock (born-expired regression)", () => {
  const PENDED_AT = 50_000_000;                                    // the real event time (turn end)
  const SETTLED_AT = PENDED_AT + PLAN_PICKER_PENDING_MAX_MS;       // the hard TTL fires exactly here
  const SWEEP_AFTER_MS = 50_000;                                   // the incident's next sweep, ~47 s later

  const pending = (over: Partial<SessionRecord> = {}): SessionRecord => rec({
    agent: "codex", transcript: "/tmp/rollout.jsonl", lastEvent: "needsAttention",
    op: "update", prio: 1, sentDone: false, pendingPlanPicker: true,
    blob: "PENDING-PLAN", title: "Implement the plan", pairingId: "p",
    ts: PENDED_AT, planPickerPendingSince: PENDED_AT, ...over,
  });

  /** Drive the real TTL settle through the public net and hand back the settled record + the posts. */
  const settleAtTtl = async () => {
    let current = pending();
    const posts: Record<string, unknown>[] = [];
    expect(await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", current, {
      state: async () => { throw new Error("TTL must precede rollout classification"); },
      readRecord: async () => current,
      writeRecord: async (_path, next) => { current = next; },
      post: async (body) => { posts.push(body as Record<string, unknown>); return "delivered"; },
      now: () => SETTLED_AT,
    })).toBe("corrected");
    expect(posts[0]).toMatchObject({ op: "done", prio: 0 });
    return { settled: current, posts };
  };

  test("the settled done re-stamps ts and SURVIVES the next sweep (the exact incident)", async () => {
    const { settled } = await settleAtTtl();
    expect(settled).toMatchObject({ op: "done", lastEvent: "done", planPickerSettled: true });
    expect(settled.ts).toBe(SETTLED_AT);
    expect(isRetireEligible(settled, SETTLED_AT)).toBe(false);
    expect(isRetireEligible(settled, SETTLED_AT + SWEEP_AFTER_MS)).toBe(false);
    // The pre-fix row's age on that same sweep had ALREADY met the old 1 h horizon (both constants were
    // 1 h and ts was never re-stamped) — which is exactly why it was retired 47 s after settling…
    expect((SETTLED_AT + SWEEP_AFTER_MS) - PENDED_AT).toBeGreaterThan(PLAN_PICKER_PENDING_MAX_MS);
    // …and the two fixes are now independent: even an un-re-stamped record is saved by the F2 margin.
    expect(isRetireEligible({ ...settled, ts: PENDED_AT }, SETTLED_AT + SWEEP_AFTER_MS)).toBe(false);
  });

  test("it becomes retire-eligible only a full RETIRE_AFTER_MS past the SETTLE", async () => {
    const { settled } = await settleAtTtl();
    expect(isRetireEligible(settled, SETTLED_AT + RETIRE_AFTER_MS - 1)).toBe(false);
    expect(isRetireEligible(settled, SETTLED_AT + RETIRE_AFTER_MS)).toBe(true);
  });

  test("the blob's `at` stays FROZEN at the original event time (honest display age)", async () => {
    const { posts } = await settleAtTtl();
    const blob = await decryptBlob(KEY, posts[0].blob as string) as Record<string, unknown>;
    expect(blob.status).toBe("done");
    expect(blob.at).toBe(Math.floor(PENDED_AT / 1000));       // the turn really ended an hour ago…
    expect(blob.at).not.toBe(Math.floor(SETTLED_AT / 1000));  // …the retention re-stamp never reaches it
  });
});

describe("correctPlanPickerVerification (watchdog owns flush settlement)", () => {
  const NOW = 9_000_000;
  const verifying = (over: Partial<SessionRecord> = {}): SessionRecord => rec({
    agent: "codex", transcript: "/tmp/019fb1fc.jsonl", lastEvent: "working",
    op: "update", prio: 0, sentDone: false, planPickerVerificationPending: true,
    blob: "WORKING", title: "Validate the live picker", pairingId: "p", ts: NOW - 5_000,
    ...over,
  });

  test("hook killed after its marker write → watchdog posts prio-1 attention and pins picker provenance", async () => {
    const record = verifying(); // no hook POST/re-read is needed after this durable snapshot
    const posts: Record<string, unknown>[] = [];
    const writes: SessionRecord[] = [];
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", record, {
      evidence: async () => ({ state: "pending", plan: "# Durable plan\n\nShip it." }),
      threadWaitState: async () => "waitingOnUserInput",
      readRecord: async () => record,
      post: async (body) => { posts.push(body as Record<string, unknown>); return "delivered"; },
      writeRecord: async (_path, next) => { writes.push(next); },
      now: () => NOW,
    })).toBe("corrected");
    expect(posts[0]).toMatchObject({ op: "update", prio: 1, attentionKind: "userInput" });
    expect(await decryptBlob(KEY, posts[0].blob as string)).toMatchObject({
      status: "needsAttention", agent: "codex", plan: "# Durable plan\n\nShip it.",
    });
    expect(writes[0]).toMatchObject({
      lastEvent: "needsAttention", op: "update", prio: 1, sentDone: false, pendingPlanPicker: true,
    });
    expect(writes[0].planPickerVerificationPending).toBeUndefined();
    expect(writes[0].planPickerPendingSince).toBe(NOW);
  });

  test("daemon idle is ignored and an exact pending rollout stays durable needsAttention", async () => {
    const record = verifying({ planPickerPendingSince: NOW - 5_000 });
    const posts: Record<string, unknown>[] = [];
    const writes: SessionRecord[] = [];
    let current = record;
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", record, {
      evidence: async () => ({ state: "pending", plan: "# Plan" }),
      threadWaitState: async () => "notWaitingOnUserInput",
      readRecord: async () => current,
      writeRecord: async (_path, next) => { current = next; writes.push(next); },
      post: async (body) => { posts.push(body as Record<string, unknown>); return "delivered"; },
      now: () => NOW,
    })).toBe("corrected");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ op: "update", prio: 1, attentionKind: "userInput" });
    expect(writes[0]).toMatchObject({
      lastEvent: "needsAttention", op: "update", prio: 1, sentDone: false,
      pendingPlanPicker: true,
    });
    expect(writes[0].planPickerVerificationPending).toBeUndefined();
    expect(writes[0].planPickerSettled).toBeUndefined();
    expect(writes[0].planPickerPendingSince).toBe(NOW);
    expect((await decryptBlob(KEY, posts[0].blob as string)).dbg).toContain("dq:idle(ign)");
  });

  test("daemon unavailable sustains the picker initially, but the hard TTL still resolves it", async () => {
    const fresh = verifying({ planPickerPendingSince: NOW - PLAN_PICKER_PENDING_MAX_MS + 1 });
    const firstPosts: Record<string, unknown>[] = [];
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", fresh, {
      state: async () => "pending",
      threadWaitState: async () => "unavailable",
      readRecord: async () => fresh,
      writeRecord: async () => {},
      post: async (body) => { firstPosts.push(body as Record<string, unknown>); return "delivered"; },
      now: () => NOW,
    })).toBe("corrected");
    expect(firstPosts[0]).toMatchObject({ op: "update", prio: 1, attentionKind: "userInput" });

    const expired = verifying({ planPickerPendingSince: NOW - PLAN_PICKER_PENDING_MAX_MS });
    let queried = 0;
    const terminalPosts: Record<string, unknown>[] = [];
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", expired, {
      state: async () => "pending",
      threadWaitState: async () => { queried++; throw new Error("proxy unavailable"); },
      readRecord: async () => expired,
      writeRecord: async () => {},
      post: async (body) => { terminalPosts.push(body as Record<string, unknown>); return "delivered"; },
      now: () => NOW,
    })).toBe("corrected");
    expect(queried).toBe(0); // TTL precedes every query/failure path
    expect(terminalPosts[0]).toMatchObject({ op: "done", prio: 0 });
  });

  test("both picker markers expire at the hard TTL, including exact-pending/waiting paths", async () => {
    const verify = verifying({ planPickerPendingSince: NOW - PLAN_PICKER_PENDING_MAX_MS });
    const attention = verifying({
      planPickerVerificationPending: undefined,
      pendingPlanPicker: true,
      lastEvent: "needsAttention",
      prio: 1,
      planPickerPendingSince: NOW - PLAN_PICKER_PENDING_MAX_MS,
    });
    expect(planPickerPendingExpired(verify, NOW)).toBe(true);
    expect(planPickerPendingExpired(attention, NOW)).toBe(true);
    expect(planPickerPendingExpired({
      ...verify,
      planPickerPendingSince: NOW - PLAN_PICKER_PENDING_MAX_MS + 1,
    }, NOW)).toBe(false);

    const terminal: Record<string, unknown>[] = [];
    expect(await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", attention, {
      state: async () => "pending",
      threadWaitState: async () => "waitingOnUserInput",
      readRecord: async () => attention,
      writeRecord: async () => {},
      post: async (body) => { terminal.push(body as Record<string, unknown>); return "delivered"; },
      now: () => NOW,
    })).toBe("corrected");
    expect(terminal[0]).toMatchObject({ op: "done", prio: 0 });
  });

  test("notify-chain absent: the Stop marker alone survives an incomplete sweep and corrects later", async () => {
    const record = verifying();
    let posted = 0;
    expect(shouldPlanPickerVerificationCheck(record, NOW)).toBe(true);
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", record, {
      state: async () => "incomplete",
      post: async () => { posted++; return "delivered"; },
      readRecord: async () => record,
      now: () => NOW,
    })).toBe("pending");
    expect(posted).toBe(0);
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", record, {
      state: async () => "pending",
      post: async () => { posted++; return "delivered"; },
      readRecord: async () => record,
      writeRecord: async () => {},
      now: () => NOW + 5_000,
    })).toBe("corrected");
    expect(posted).toBe(1);
  });

  test("the prio-1 transition is durable before POST and a thrown POST stays owned for retry", async () => {
    const record = verifying();
    const order: string[] = [];
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", record, {
      state: async () => "pending",
      threadWaitState: async () => "waitingOnUserInput",
      readRecord: async () => record,
      writeRecord: async () => { order.push("write"); },
      post: async () => { order.push("post"); throw new Error("offline"); },
      now: () => NOW,
    })).toBe("pending");
    expect(order).toEqual(["write", "post"]);
  });

  test("genuine done is never resurrected: resolved/none/exited and old done rows are untouched", async () => {
    const recentDone = verifying({
      planPickerVerificationPending: undefined,
      lastEvent: "done", op: "done", prio: 0, sentDone: true, ts: NOW - 1_000,
    });
    let posted = 0;
    for (const state of ["resolved", "none", "exited"] as const) {
      expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", recentDone, {
        state: async () => state,
        pidAlive: () => true,
        post: async () => { posted++; return "delivered"; },
        readRecord: async () => recentDone,
        now: () => NOW,
      })).toBe("uncorrected");
    }
    const oldDone = { ...recentDone, ts: NOW - PLAN_PICKER_RECENT_DONE_MS - 1 };
    let classified = 0;
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", oldDone, {
      state: async () => { classified++; return "pending"; },
      post: async () => { posted++; return "delivered"; },
      now: () => NOW,
    })).toBe("uncorrected");
    expect({ posted, classified }).toEqual({ posted: 0, classified: 0 });
  });

  test("an unadjudicated done is re-corrected only with full proof + live pid + recent window", async () => {
    // A hook killed between its done write and its picker marker leaves a PLAIN done: no adjudicator
    // ever ruled on it, so rollout proof may still re-open it. A done carrying `planPickerSettled`
    // is the opposite case and is latched shut below.
    const plainDone = verifying({
      planPickerVerificationPending: undefined,
      lastEvent: "done", op: "done", prio: 0, sentDone: true, ts: NOW - 1_000,
    });
    let current = plainDone;
    const posts: Record<string, unknown>[] = [];
    expect(shouldPlanPickerVerificationCheck(plainDone, NOW)).toBe(true);
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", plainDone, {
      evidence: async () => ({ state: "pending", plan: "# Still open" }),
      threadWaitState: async () => "notWaitingOnUserInput",
      pidAlive: () => true,
      readRecord: async () => current,
      writeRecord: async (_path, next) => { current = next; },
      post: async (body) => { posts.push(body as Record<string, unknown>); return "delivered"; },
      now: () => NOW,
    })).toBe("corrected");
    expect(posts[0]).toMatchObject({ op: "update", prio: 1, attentionKind: "userInput" });
    expect(current).toMatchObject({ lastEvent: "needsAttention", pendingPlanPicker: true, prio: 1 });
    expect(current.planPickerSettled).toBeUndefined();

    // Same full proof, same live pid, same window — but the watchdog already settled this episode.
    const settled = { ...plainDone, planPickerSettled: true };
    let classified = 0;
    expect(shouldPlanPickerVerificationCheck(settled, NOW)).toBe(false);
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", settled, {
      evidence: async () => { classified++; return { state: "pending", plan: "# Still open" }; },
      pidAlive: () => true,
      post: async () => { throw new Error("a settled picker must never be re-opened"); },
      now: () => NOW,
    })).toBe("uncorrected");
    expect(classified).toBe(0);
  });

  test("an unadjudicated done is not re-corrected outside the window, with a dead pid, or after later progress", async () => {
    const plainDone = verifying({
      planPickerVerificationPending: undefined,
      lastEvent: "done", op: "done", prio: 0, sentDone: true, ts: NOW - 1_000,
    });
    let posts = 0;
    let classified = 0;
    const outside = { ...plainDone, ts: NOW - PLAN_PICKER_RECENT_DONE_MS - 1 };
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", outside, {
      evidence: async () => { classified++; return { state: "pending", plan: "# stale" }; },
      pidAlive: () => true,
      post: async () => { posts++; return "delivered"; },
      now: () => NOW,
    })).toBe("uncorrected");
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", plainDone, {
      evidence: async () => { classified++; return { state: "pending", plan: "# dead" }; },
      pidAlive: () => false,
      post: async () => { posts++; return "delivered"; },
      now: () => NOW,
    })).toBe("uncorrected");
    // A daemon-fronted row: the app-server pid lives forever, so only the correlated TTY is evidence.
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", { ...plainDone, pid: 937, tuiPid: 64_799 }, {
      evidence: async () => { classified++; return { state: "pending", plan: "# dead tui" }; },
      pidAlive: (pid) => pid === 937,
      post: async () => { posts++; return "delivered"; },
      now: () => NOW,
    })).toBe("uncorrected");
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", plainDone, {
      evidence: async () => { classified++; return { state: "resolved" }; },
      pidAlive: () => true,
      post: async () => { posts++; return "delivered"; },
      now: () => NOW,
    })).toBe("uncorrected");
    expect({ posts, classified }).toEqual({ posts: 0, classified: 1 });
  });

  test("a settled picker never re-opens: the two correctives converge instead of flapping", async () => {
    // The production loop measured 2026-08-02: two daemon-fronted Codex sessions alternating
    // set-pending ⇄ tui-exit every ~7.3s for 48 minutes (738 posted corrections). Each flip is a real
    // prio-1 ⇄ done transition, i.e. one priority-10 Live Activity push, which alone burned the
    // ActivityKit budget. The rollout's picker signature is durable (dismissal is never written to
    // JSONL) so it classifies "pending" forever, and `record.pid` is the app-server DAEMON — always
    // alive — so the recent-done backstop's liveness gate re-opened every settlement.
    let current: SessionRecord = rec({
      agent: "codex", transcript: "/tmp/019fb9a2.jsonl", lastEvent: "needsAttention",
      op: "update", prio: 1, sentDone: false, pendingPlanPicker: true, planPickerPendingSince: NOW,
      blob: "ATTENTION", title: "Plan?", pairingId: "p", ts: NOW, pid: 937, tuiPid: 64799,
    });
    const posts: Record<string, unknown>[] = [];
    const deps = (now: number) => ({
      state: async () => "pending" as const,
      evidence: async () => ({ state: "pending" as const, plan: "# Still open" }),
      threadWaitState: async () => "notWaitingOnUserInput" as const,
      pidAlive: (pid: number) => pid === 937, // the daemon lives on; the TUI (64799) has exited
      readRecord: async () => current,
      writeRecord: async (_p: string, next: SessionRecord) => { current = next; },
      post: async (body: object) => { posts.push(body as Record<string, unknown>); return "delivered" as const; },
      now: () => now,
    });
    for (let sweep = 0; sweep < 6; sweep++) {
      const at = NOW + sweep * 7_300;
      await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", current, deps(at));
      await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", current, deps(at + 1_000));
    }
    // One terminal transition total. The dead TUI is decisive, and the settlement it wrote is a latch.
    expect(posts.map((p) => p.op)).toEqual(["done"]);
    expect(current).toMatchObject({ op: "done", lastEvent: "done", planPickerSettled: true });
    expect(current.pendingPlanPicker).toBeUndefined();
  });

  test("decision trace covers open, daemon-idle ignored, blocked settlement, and eventual TTL done", async () => {
    const dir = await mkdtemp(join(tmpdir(), "picker-trace-"));
    const tracePath = join(dir, "session-trace.log");
    const trace = (decision: PlanPickerTraceDecision) => tracePlanPickerDecision("s", decision, tracePath);
    let current = verifying();
    await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", current, {
      evidence: async () => ({ state: "pending", plan: "# Trace me" }),
      threadWaitState: async () => "notWaitingOnUserInput",
      readRecord: async () => current,
      writeRecord: async (_path, next) => { current = next; },
      post: async () => "delivered",
      now: () => NOW,
      trace,
    });
    expect(current.pendingPlanPicker).toBe(true);
    await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", current, {
      state: async () => "pending",
      threadWaitState: async () => "notWaitingOnUserInput",
      trace,
      now: () => NOW + 5_000,
    });
    current = { ...current, planPickerPendingSince: NOW - PLAN_PICKER_PENDING_MAX_MS };
    await correctResolvedPlanPicker(cfg(), "/tmp/s.json", "s", current, {
      state: async () => { throw new Error("TTL must precede classifier"); },
      readRecord: async () => current,
      writeRecord: async (_path, next) => { current = next; },
      post: async () => "delivered",
      trace,
      now: () => NOW,
    });
    const traces = (await readFile(tracePath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(traces).toContainEqual(expect.objectContaining({
      classifier: "pending", marker: "set-pending", daemonQuery: "notWaitingOnUserInput",
      daemonIgnored: true, settle: "blocked", correctionPosted: true,
    }));
    expect(traces).toContainEqual(expect.objectContaining({
      classifier: "pending", marker: "kept", daemonIgnored: true, settle: "blocked",
    }));
    expect(traces).toContainEqual(expect.objectContaining({
      classifier: "done", marker: "settled", ttlFired: true, settle: "done",
      correctionPosted: true, doneBy: "watchdog",
    }));
    await rm(dir, { recursive: true, force: true });
  });

  test("marked ambiguity past the verification cap fails closed to a delivered done", async () => {
    const record = verifying({ ts: NOW - PLAN_PICKER_VERIFY_MAX_MS });
    const posts: Record<string, unknown>[] = [];
    const writes: SessionRecord[] = [];
    expect(await correctPlanPickerVerification(cfg(), "/tmp/s.json", "s", record, {
      state: async () => "unknown",
      readRecord: async () => record,
      post: async (body) => { posts.push(body as Record<string, unknown>); return "delivered"; },
      writeRecord: async (_path, next) => { writes.push(next); },
      now: () => NOW,
    })).toBe("corrected");
    expect(posts[0]).toMatchObject({ op: "done", prio: 0 });
    expect(await decryptBlob(KEY, posts[0].blob as string)).toMatchObject({ status: "done", agent: "codex" });
    expect(writes[0]).toMatchObject({ lastEvent: "done", op: "done", prio: 0, sentDone: true });
    expect(writes[0].planPickerVerificationPending).toBeUndefined();
  });
});

// --- Bug B/C regressions: heartbeat key-rotation guard + corrective-envelope title reuse -------

describe("buildHeartbeatEnvelope key-rotation guard (stale blobs must never outlive a re-pair)", () => {
  test("record sealed under the CURRENT pairing → heartbeat as before", () => {
    const r = rec({ op: "update", prio: 0, blob: "B", pairingId: "pair-live" });
    expect(buildHeartbeatEnvelope("s", r, 5, "pair-live")).toMatchObject({ blob: "B", op: "update" });
  });

  test("record sealed under a ROTATED-AWAY pairing → null (no undecryptable ghost frames)", () => {
    const r = rec({ op: "update", prio: 0, blob: "B", pairingId: "pair-old" });
    expect(buildHeartbeatEnvelope("s", r, 5, "pair-new")).toBeNull();
  });

  test("pre-fix record with NO pairingId stamp → null when the guard is armed (unknown key = unsafe)", () => {
    const r = rec({ op: "update", prio: 0, blob: "B" });
    expect(buildHeartbeatEnvelope("s", r, 5, "pair-live")).toBeNull();
  });

  test("guard unarmed (no currentPairingId given) keeps the historical behavior", () => {
    const r = rec({ op: "update", prio: 0, blob: "B" });
    expect(buildHeartbeatEnvelope("s", r, 5)).toMatchObject({ blob: "B" });
  });
});

describe("corrective envelopes reuse the record's cached title (no more folder-name regressions)", () => {
  test("buildDoneEnvelope threads record.title into the rebuilt blob", async () => {
    const e = await buildDoneEnvelope("s", rec({ machine: "Mac", label: "api-status", title: "Fix the island timer" }), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, e.blob as string)).toMatchObject({ status: "done", title: "Fix the island timer" });
  });

  test("buildNeedsAttentionEnvelope threads record.title into the rebuilt blob", async () => {
    const e = await buildNeedsAttentionEnvelope("s", rec({ machine: "Mac", label: "api-status", title: "Fix the island timer" }), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, e.blob as string)).toMatchObject({ status: "needsAttention", title: "Fix the island timer" });
  });

  test("no cached title → the historical empty title (never a crash / undefined)", async () => {
    const e = await buildDoneEnvelope("s", rec(), 5, KEY) as Record<string, unknown>;
    expect(await decryptBlob(KEY, e.blob as string)).toMatchObject({ title: "" });
  });
});

describe("buildProvisionalRecord stamps the sealing pairing", () => {
  const d: DiscoveredSession = { pid: 7, sessionId: "codex-pid-7", title: "proj", label: "proj" };

  test("pairingId rides on the record so the heartbeat guard can prove the blob decryptable", () => {
    const r = buildProvisionalRecord(d, "Mac", "BLOB", { agent: "codex" }, 99, "pair-live");
    expect(r.pairingId).toBe("pair-live");
    expect(buildHeartbeatEnvelope("codex-pid-7", r, 100, "pair-live")).toMatchObject({ blob: "BLOB" });
  });

  test("omitted when unknown (historical shape preserved)", () => {
    expect(buildProvisionalRecord(d, "Mac", "BLOB", {}, 99)).not.toHaveProperty("pairingId");
  });
});

// --- interrupt-net settle: the done pin sticks + bounded retry (no forever-flap) --------------
//
// Live bug: after Esc interrupts a needsAttention session, correctInterrupt POSTed a corrective done but
// pinned lastEvent:"done" ONLY as a side effect of a DELIVERED post, and the heartbeat had no signal
// agreeing with that decision. So a transiently-failing done POST left the record on needsAttention:
// correctInterrupt re-fired its done EVERY 5-s sweep (unbounded), AND the 5-min heartbeat re-sent the
// stale needsAttention blob — flapping the phone between done and attention indefinitely. The fix:
//   * delivered done → pin done + CLEAR the retry counter (gate + heartbeat both close),
//   * failed done    → verdict "pending" + a BOUNDED doneAttempts counter that (a) caps the retry and
//                      (b) makes shouldHeartbeat hold off (the interrupt net owns the session),
//   * past the cap   → pin done LOCALLY so the every-sweep flap ends (the worker's eviction resolves it).

describe("correctInterrupt (settle an interrupted session — the done pin sticks, retry is bounded)", () => {
  const interruptTail = asstTurn("[Request interrupted by user]");
  const attn = (over: Partial<SessionRecord> = {}): SessionRecord =>
    irec({ lastEvent: "needsAttention", op: "update", prio: 1, blob: "ATTN", transcript: "/tmp/t.jsonl", ...over });
  const NOW = 9_000_000;

  test("interrupt detected + delivered → posts ONE done, pins the record done, verdict 'corrected'", async () => {
    const posts: object[] = [];
    const writes: SessionRecord[] = [];
    const v = await correctInterrupt(cfg(), "/tmp/s.json", "s", attn(), NOW, {
      post: async (b) => { posts.push(b); return "delivered" as PostOutcome; },
      readTail: async () => interruptTail,
      writeRecord: async (_p, r) => { writes.push(r); },
      now: () => 4242,
    });
    expect(v).toBe("corrected");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ op: "done", ts: 4242 });
    expect(writes[0]).toMatchObject({ lastEvent: "done", op: "done", sentDone: true });
    expect(writes[0].doneAttempts).toBeUndefined(); // a delivered done CLEARS any retry counter (JSON drops it)
  });

  test("the pinned done record CLOSES the gate — a subsequent sweep posts NOTHING", async () => {
    const pinned = attn({ lastEvent: "done", op: "done", sentDone: true });
    expect(shouldInterruptCheck(pinned, NOW)).toBe(false); // gate short-circuits before any POST
    let posted = false;
    const v = await correctInterrupt(cfg(), "/tmp/s.json", "s", pinned, NOW, {
      post: async () => { posted = true; return "delivered" as PostOutcome; },
      readTail: async () => interruptTail,
      writeRecord: async () => {},
    });
    expect(v).toBe("uncorrected");
    expect(posted).toBe(false);
  });

  test("a transiently FAILING done POST persists a bounded doneAttempts counter (verdict 'pending')", async () => {
    const writes: SessionRecord[] = [];
    const v = await correctInterrupt(cfg(), "/tmp/s.json", "s", attn(), NOW, {
      post: async () => "failed" as PostOutcome,
      readTail: async () => interruptTail,
      writeRecord: async (_p, r) => { writes.push(r); },
    });
    expect(v).toBe("pending"); // interrupt handled (the caller skips the heartbeat) but NOT delivered
    expect(writes[0]).toMatchObject({ lastEvent: "needsAttention", doneAttempts: 1 }); // bumped; gate stays open to retry
  });

  test("the retry is BOUNDED — past the cap it stops POSTing and pins the record done locally", async () => {
    let posts = 0;
    let last: SessionRecord = attn();
    // Drive the net repeatedly, threading the persisted record back in (as the sweep re-reads it each pass).
    for (let i = 0; i < 20; i++) {
      const v = await correctInterrupt(cfg(), "/tmp/s.json", "s", last, NOW, {
        post: async () => { posts++; return "failed" as PostOutcome; },
        readTail: async () => interruptTail,
        writeRecord: async (_p, r) => { last = r; },
      });
      expect(v).toBe("pending");
      if (last.lastEvent === "done") break; // capped → the record was pinned done locally, ending the flap
    }
    expect(posts).toBeLessThanOrEqual(6);              // bounded, not one-failed-POST-per-sweep forever
    expect(last).toMatchObject({ lastEvent: "done", op: "done" });
  });

  test("a revoke bubbles up so the loop can tear the pairing down", async () => {
    const v = await correctInterrupt(cfg(), "/tmp/s.json", "s", attn(), NOW, {
      post: async () => "revoked" as PostOutcome, readTail: async () => interruptTail, writeRecord: async () => {},
    });
    expect(v).toBe("revoked");
  });

  test("no interrupt in the tail → uncorrected, nothing posted (a genuine pending approval is untouched)", async () => {
    let posted = false;
    const v = await correctInterrupt(cfg(), "/tmp/s.json", "s", attn(), NOW, {
      post: async () => { posted = true; return "delivered" as PostOutcome; },
      readTail: async () => asstTurn("still thinking"), writeRecord: async () => {},
    });
    expect(v).toBe("uncorrected");
    expect(posted).toBe(false);
  });
});

// --- the live-decision-hold gate on the op:"done" correctives ---------------------------------
//
// P0, 2026-08-09. While a Claude permission approval is HELD (the blocking hook is polling for the
// phone's Allow/Deny), the watchdog's correctives POSTed `op:"done"` for that very session. The worker
// stores the done over the sealed `decisionPending` blob, and because `permissionRequestId` rides INSIDE
// that blob the phone then computes `isHeld == false` and renders the yellow needsAttention hand — which
// by design only NOTIFIES. Only the violet card offers Allow/Deny, so the approval became unanswerable
// from the phone. Log-proven: `op:"done", sentDone:true` stamped 12.0 s into a hold that was still
// polling. The correctives read the RECORD, and a record mid-hold is indistinguishable from an abandoned
// needsAttention — the `.hold` marker beside it is the missing fact, and `stateHoldLive` (the LAN state
// feed's own predicate) is the gate.
//
// The gate must be exactly as robust as that predicate: a marker whose HOLDER PID IS GONE — the leak a
// SIGTERMed hook leaves, three of them observed on the reporter's disk — must suppress NOTHING, or a P0
// would have been traded for a permanently un-settleable row.

describe("live-decision-hold gate: no op:done corrective may land while an approval is held", () => {
  const NOW = 9_000_000;
  const HOLDER = 51_515;
  const liveHold = (over: Partial<DecisionHold> = {}): DecisionHold =>
    ({ blob: "SEALED-CARD", at: NOW - 12_000, pid: HOLDER, ...over }); // 12.0 s in, exactly as reported
  /** The gate's two seams, wired to a hold whose holder is ALIVE. */
  const held = { readDecisionHoldFn: async () => liveHold(), holdPidAliveFn: (p: number) => p === HOLDER };
  /** A LEAKED marker: same file, but the hook that owned it is gone. */
  const stale = { readDecisionHoldFn: async () => liveHold(), holdPidAliveFn: () => false };
  /** The hold answered/released — the marker is gone from disk. */
  const cleared = { readDecisionHoldFn: async () => null, holdPidAliveFn: () => true };

  describe("correctInterrupt (the prime producer: a needsAttention record + an interrupt marker)", () => {
    const interruptTail = asstTurn("[Request interrupted by user]");
    const attn = (over: Partial<SessionRecord> = {}): SessionRecord =>
      irec({ lastEvent: "needsAttention", op: "update", prio: 1, blob: "ATTN", transcript: "/tmp/t.jsonl", ...over });
    const seams = (extra: object) => ({
      readTail: async () => interruptTail,
      ...extra,
    });

    test("a LIVE hold suppresses the corrective done entirely — nothing POSTed, nothing written", async () => {
      const posts: object[] = [];
      const writes: SessionRecord[] = [];
      const traces: object[] = [];
      const v = await correctInterrupt(cfg(), "/tmp/s.json", "s", attn(), NOW, seams({
        post: async (b: object) => { posts.push(b); return "delivered" as PostOutcome; },
        writeRecord: async (_p: string, r: SessionRecord) => { writes.push(r); },
        trace: (e: object) => { traces.push(e); },
        ...held,
      }));
      expect(posts).toEqual([]);           // THE BUG: this was one op:"done" over the user's open card
      expect(writes).toEqual([]);          // and no local done-pin either — the session is NOT settled
      expect(v).toBe("uncorrected");       // the heartbeat/other nets carry on exactly as for any parked row
      expect(traces).toContainEqual({ event: "interrupt", sessionId: "s", outcome: "held", delivered: false, held: true });
    });

    test("a STALE hold (holder pid gone) does NOT suppress it — the leak can never wedge a session", async () => {
      const posts: object[] = [];
      const writes: SessionRecord[] = [];
      const v = await correctInterrupt(cfg(), "/tmp/s.json", "s", attn(), NOW, seams({
        post: async (b: object) => { posts.push(b); return "delivered" as PostOutcome; },
        writeRecord: async (_p: string, r: SessionRecord) => { writes.push(r); },
        ...stale,
      }));
      expect(v).toBe("corrected");
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ op: "done" });
      expect(writes[0]).toMatchObject({ lastEvent: "done", op: "done", sentDone: true });
    });

    test("a hold past the TTL with a live holder does not suppress it either (same ceiling as the feed)", async () => {
      const posts: object[] = [];
      const v = await correctInterrupt(cfg(), "/tmp/s.json", "s", attn(), NOW, seams({
        post: async (b: object) => { posts.push(b); return "delivered" as PostOutcome; },
        writeRecord: async () => {},
        readDecisionHoldFn: async () => liveHold({ at: NOW - STATE_HOLD_MAX_AGE_MS - 1 }),
        holdPidAliveFn: () => true,
      }));
      expect(v).toBe("corrected");
      expect(posts).toHaveLength(1);
    });

    test("once the hold CLEARS the deferred corrective fires on the next sweep (suppression wrote nothing)", async () => {
      const record = attn();
      const posts: object[] = [];
      // Sweep 1: held → deferred, and crucially no counter/pin was persisted…
      const first = await correctInterrupt(cfg(), "/tmp/s.json", "s", record, NOW, seams({
        post: async (b: object) => { posts.push(b); return "delivered" as PostOutcome; },
        writeRecord: async () => { throw new Error("must not write while held"); },
        ...held,
      }));
      expect(first).toBe("uncorrected");
      expect(record).toMatchObject({ lastEvent: "needsAttention", op: "update" }); // …the record is untouched
      expect(effectiveDoneAttempts(record, "s")).toBe(0);                          // …and no attempt was burnt
      // Sweep 2: the user answered, the hook released its marker → the same record settles normally.
      const writes: SessionRecord[] = [];
      const second = await correctInterrupt(cfg(), "/tmp/s.json", "s", record, NOW + 5_000, seams({
        post: async (b: object) => { posts.push(b); return "delivered" as PostOutcome; },
        writeRecord: async (_p: string, r: SessionRecord) => { writes.push(r); },
        ...cleared,
      }));
      expect(second).toBe("corrected");
      expect(posts).toHaveLength(1);
      expect(writes[0]).toMatchObject({ lastEvent: "done", op: "done" });
    });

    test("the done-pin no longer carries the needsAttention prio:1 forward (a done frame is prio 0)", async () => {
      const writes: SessionRecord[] = [];
      await correctInterrupt(cfg(), "/tmp/s.json", "s", attn(), NOW, seams({
        post: async () => "delivered" as PostOutcome,
        writeRecord: async (_p: string, r: SessionRecord) => { writes.push(r); },
        ...cleared,
      }));
      // `{...record, op:"done"}` used to leave prio:1 on a terminal record, and lanFrameContent then
      // shipped a contradictory op:"done"/prio:1 LAN frame (and re-attached the episode's attentionKind).
      expect(writes[0].prio).toBe(0);
    });

    test("the local done-pin at the retry cap is gated too (the cap must not settle a held session)", async () => {
      const writes: SessionRecord[] = [];
      let last = attn({ doneAttempts: 5 }); // already at INTERRUPT_DONE_MAX_ATTEMPTS
      const v = await correctInterrupt(cfg(), "/tmp/s.json", "s", last, NOW, seams({
        post: async () => "failed" as PostOutcome,
        writeRecord: async (_p: string, r: SessionRecord) => { writes.push(r); last = r; },
        ...held,
      }));
      expect(v).toBe("uncorrected");
      expect(writes).toEqual([]); // the cap's LOCAL pin is a done too — it would strand the card offline
    });
  });

  describe("correctPendingDone (the undelivered-done debt must not be paid over an open card)", () => {
    const owed = (over: Partial<SessionRecord> = {}): SessionRecord =>
      rec({ lastEvent: "done", op: "done", sentDone: true, donePending: true, blob: "B", ts: NOW - 30_000, ...over });

    test("a LIVE hold defers the re-POST and OWNS the sweep (so the retire net stands down too)", async () => {
      const posts: object[] = [];
      const writes: SessionRecord[] = [];
      const v = await correctPendingDone(cfg(), "/tmp/s.json", "s", owed(), NOW, {
        post: async (b) => { posts.push(b); return "delivered" as PostOutcome; },
        writeRecord: async (_p, r) => { writes.push(r); },
        ...held,
      });
      expect(posts).toEqual([]);
      expect(writes).toEqual([]);
      // "pending", NOT "uncorrected": pending makes this net the session's owner for the sweep, which is
      // what holds retireDoneStale off — a retire would DELETE the row under the open prompt instead.
      expect(v).toBe("pending");
    });

    test("the debt survives the deferral: donePending is still set, so a later sweep pays it", async () => {
      const record = owed();
      await correctPendingDone(cfg(), "/tmp/s.json", "s", record, NOW, {
        post: async () => "delivered" as PostOutcome, writeRecord: async () => {}, ...held,
      });
      expect(record.donePending).toBe(true);
      expect(shouldPendingDoneCheck(record)).toBe(true);
      const posts: object[] = [];
      const v = await correctPendingDone(cfg(), "/tmp/s.json", "s", record, NOW + 5_000, {
        post: async (b) => { posts.push(b); return "delivered" as PostOutcome; },
        writeRecord: async () => {}, readRecord: async () => record, ...cleared,
      });
      expect(v).toBe("corrected");
      expect(posts).toHaveLength(1);
    });

    test("a STALE hold does NOT defer it — the debt is still settled", async () => {
      const posts: object[] = [];
      const v = await correctPendingDone(cfg(), "/tmp/s.json", "s", owed(), NOW, {
        post: async (b) => { posts.push(b); return "delivered" as PostOutcome; },
        writeRecord: async () => {}, readRecord: async () => owed(), ...stale,
      });
      expect(v).toBe("corrected");
      expect(posts).toHaveLength(1);
    });
  });

  describe("correctIdleClaude (a session with an open card is not idle, whatever its clocks say)", () => {
    const R_MS = 1_800_000; // CLAUDE_IDLE_REAP_MS
    // Reap-eligible by the clock, and mid-hold: reachable when CC's permission Notification hook (which
    // would have written needsAttention) was dropped, so the record still reads a long-silent `working`.
    const idle = (over: Partial<SessionRecord> = {}): SessionRecord =>
      rec({ lastEvent: "working", op: "update", blob: "B", ts: NOW - 4 * R_MS, ...over });

    test("a LIVE hold suppresses the reap's done", async () => {
      const posts: object[] = [];
      const writes: SessionRecord[] = [];
      const v = await correctIdleClaude(cfg(), "/tmp/s.json", "s", idle(), NOW, {
        post: async (b) => { posts.push(b); return "delivered" as PostOutcome; },
        writeRecord: async (_p, r) => { writes.push(r); },
        ...held,
      });
      expect(posts).toEqual([]);
      expect(writes).toEqual([]);
      expect(v).toBe("uncorrected");
    });

    test("a STALE hold does NOT suppress it (a 30-min-idle session still reaps)", async () => {
      const posts: object[] = [];
      const v = await correctIdleClaude(cfg(), "/tmp/s.json", "s", idle(), NOW, {
        post: async (b) => { posts.push(b); return "delivered" as PostOutcome; },
        writeRecord: async () => {},
        ...stale,
      });
      expect(v).toBe("corrected");
      expect(posts).toHaveLength(1);
    });
  });

  // The housekeeping half of the same fix: markers leak because clearDecisionHold runs from the hook's
  // `finally`, which a SIGTERM/SIGKILL never reaches. Three orphans (dead holder pids, one four days old)
  // were sitting in the reporter's sessions dir when the P0 was filed.
  describe("pruneStaleDecisionHolds (the SIGTERM leak: retire markers nobody can own)", () => {
    const holdFor = (pid: number): DecisionHold => ({ blob: "CARD", at: NOW, pid });

    test("a DEAD holder's marker is removed; a LIVE holder's is left strictly alone", async () => {
      const removed: string[] = [];
      const count = await pruneStaleDecisionHolds(
        ["live.hold", "dead.hold", "live.json", "dead.json", "codex-pid-1.json", "x.input-fallback"],
        {
          readHold: async (id) => holdFor(id === "live" ? 900 : 901),
          isAlive: (pid) => pid === 900,
          removeHold: async (id) => { removed.push(id); },
        },
      );
      expect(removed).toEqual(["dead"]); // ONLY the orphan; and no `.json` record was ever touched
      expect(count).toBe(1);
    });

    test("a marker past its TTL whose holder is ALIVE is kept (the readers already ignore it)", async () => {
      const removed: string[] = [];
      await pruneStaleDecisionHolds(["ancient.hold"], {
        readHold: async () => ({ blob: "CARD", at: NOW - STATE_HOLD_MAX_AGE_MS * 10, pid: 900 }),
        isAlive: () => true,
        removeHold: async (id) => { removed.push(id); },
      });
      expect(removed).toEqual([]); // unlinking a file a live hook still compare-and-clears buys nothing
    });

    test("corrupt / pid-less markers are removed, and a THROWING liveness probe removes nothing", async () => {
      const removed: string[] = [];
      await pruneStaleDecisionHolds(["corrupt.hold", "pidless.hold"], {
        readHold: async (id) => (id === "corrupt" ? null : { blob: "CARD", at: NOW } as DecisionHold),
        isAlive: () => false,
        removeHold: async (id) => { removed.push(id); },
      });
      expect(removed).toEqual(["corrupt", "pidless"]);

      const kept: string[] = [];
      await pruneStaleDecisionHolds(["unknown.hold"], {
        readHold: async () => holdFor(900),
        isAlive: () => { throw new Error("ps unavailable"); },
        removeHold: async (id) => { kept.push(id); },
      });
      expect(kept).toEqual([]); // an unanswerable probe must never delete a card the user may be holding
    });
  });
});

describe("shouldHeartbeat holds off while the interrupt net owns the record (the anti-flap guard)", () => {
  const now = 5_000_000;

  test("a needsAttention record the interrupt net is retrying (doneAttempts>0) is NOT heartbeated", () => {
    // Without this the 5-min heartbeat re-sent the stale needsAttention blob, flapping the phone between
    // done (interrupt net) and needsAttention (heartbeat) for as long as the done POST kept failing.
    const retrying = rec({ lastEvent: "needsAttention", op: "update", ts: now - HEARTBEAT_AFTER_MS, blob: "ATTN", doneAttempts: 1 });
    expect(shouldHeartbeat(retrying, now, undefined, false)).toBe(false);
    // A GENUINE pending approval (no interrupt seen, no counter) is still heartbeated to keep the island alive.
    const genuine = rec({ lastEvent: "needsAttention", op: "update", ts: now - HEARTBEAT_AFTER_MS, blob: "ATTN" });
    expect(shouldHeartbeat(genuine, now, undefined, false)).toBe(true);
  });
});

// --- v1.4.4 review fixes ---------------------------------------------------------------------

// The bridge used to be constructed for ANY pairing, so a Claude-only machine spawned `codex app-server
// proxy` on every cycle forever. Construction/start is now gated on a cheap presence probe (the
// app-server control socket) that is RE-RUN every sweep, so the daemon can appear or disappear under a
// long-lived watchdog without a restart.
describe("createBridgeSupervisor (presence gate: no Codex daemon → no bridge, no spawn)", () => {
  /** A fake bridge that records the calls the supervisor makes. */
  const fakeBridge = () => {
    const calls: string[] = [];
    return {
      calls,
      bridge: {
        start: async () => { calls.push("start"); return true; },
        stop: async () => { calls.push("stop"); },
        refreshSubscriptions: async () => { calls.push("refresh"); },
      },
    };
  };
  /** Collects the detached work so a test can await it deterministically. */
  const collector = () => {
    const pending: Promise<unknown>[] = [];
    return {
      detach: (work: () => Promise<unknown>) => { pending.push(Promise.resolve().then(work).catch(() => {})); },
      settle: () => Promise.all(pending),
    };
  };

  test("probe false (Claude-only machine) → the bridge is NEVER constructed", async () => {
    let created = 0;
    const s = createBridgeSupervisor({ probe: async () => false, create: () => { created++; throw new Error("unreachable"); } });
    await s.sync(cfg());
    await s.sync(cfg());
    await s.sync(cfg());
    expect(created).toBe(0);
    expect(s.active).toBe(false);
  });

  test("a daemon that appears LATER gets the bridge without restarting the watchdog", async () => {
    const f = fakeBridge();
    const c = collector();
    let available = false;
    const s = createBridgeSupervisor({ probe: async () => available, create: () => f.bridge, detach: c.detach });
    await s.sync(cfg());
    expect(f.calls).toEqual([]); // no daemon yet → nothing constructed
    available = true;            // user starts codex
    await s.sync(cfg());
    await c.settle();
    expect(f.calls).toEqual(["start"]);
    expect(s.active).toBe(true);
  });

  test("a daemon that GOES AWAY stops the bridge (and it is re-started when it returns)", async () => {
    const f = fakeBridge();
    const c = collector();
    let available = true;
    const s = createBridgeSupervisor({ probe: async () => available, create: () => f.bridge, detach: c.detach });
    await s.sync(cfg());
    available = false;
    await s.sync(cfg());
    await c.settle();
    expect(f.calls).toEqual(["start", "stop"]);
    expect(s.active).toBe(false);
    available = true;
    await s.sync(cfg());
    await c.settle();
    expect(f.calls).toEqual(["start", "stop", "start"]);
  });

  test("pending-picker status queries use the active bridge only while the daemon socket is available", async () => {
    const f = fakeBridge();
    const c = collector();
    let available = true;
    let reads = 0;
    const bridge = {
      ...f.bridge,
      readThreadWaitState: async (threadId: string) => {
        reads++;
        expect(threadId).toBe("thread-plan");
        return "waitingOnUserInput" as const;
      },
    };
    const s = createBridgeSupervisor({
      probe: async () => available,
      create: () => bridge,
      detach: c.detach,
    });
    await s.sync(cfg());
    await c.settle();
    expect(await s.threadWaitState("thread-plan")).toBe("waitingOnUserInput");
    available = false;
    expect(await s.threadWaitState("thread-plan")).toBe("unavailable");
    expect(reads).toBe(1);
  });


  test("a parked client (it gave up reconnecting) is RE-ARMED on the next sweep", async () => {
    const f = fakeBridge();
    const c = collector();
    let sink: ((e: Error) => void) | undefined;
    const s = createBridgeSupervisor({
      probe: async () => true,
      create: (_cfg, opts) => { sink = opts.onError; return f.bridge; },
      detach: c.detach,
      now: () => 1_000,
    });
    await s.sync(cfg());
    await s.sync(cfg());
    await c.settle();
    expect(f.calls).toEqual(["start", "refresh"]); // healthy steady state
    // The app-server client parks itself after N failed reconnects and stays off until start() is called.
    sink!(new Error("Codex app-server reconnect gave up after 10 consecutive failures"));
    await s.sync(cfg());
    await c.settle();
    expect(f.calls).toEqual(["start", "refresh", "start"]); // re-armed, not just refreshed
    await s.sync(cfg());
    await c.settle();
    expect(f.calls).toEqual(["start", "refresh", "start", "refresh"]); // …and back to steady state
  });

  test("re-arms periodically as a backstop for parked states we can't observe", async () => {
    const f = fakeBridge();
    const c = collector();
    let clock = 1_000;
    const s = createBridgeSupervisor({ probe: async () => true, create: () => f.bridge, detach: c.detach, now: () => clock });
    await s.sync(cfg());
    clock += 60_000;            // 1 min later
    await s.sync(cfg());
    await c.settle();
    expect(f.calls).toEqual(["start", "refresh"]);
    clock += 600_000;           // past the re-arm interval
    await s.sync(cfg());
    await c.settle();
    expect(f.calls).toEqual(["start", "refresh", "start"]);
  });

  test("errors are passed through to the caller's sink (the daemon itself stays silent)", async () => {
    const f = fakeBridge();
    const seen: string[] = [];
    let sink: ((e: Error) => void) | undefined;
    const s = createBridgeSupervisor({
      probe: async () => true,
      create: (_cfg, opts) => { sink = opts.onError; return f.bridge; },
      detach: () => {},
      onError: (e) => { seen.push(e.message); },
    });
    await s.sync(cfg());
    sink!(new Error("transport closed"));
    expect(seen).toEqual(["transport closed"]);
  });

  test("steady state refreshes subscriptions; a pairing change tears down and rebuilds", async () => {
    const built: Array<ReturnType<typeof fakeBridge>> = [];
    const c = collector();
    const s = createBridgeSupervisor({
      probe: async () => true,
      create: () => { const f = fakeBridge(); built.push(f); return f.bridge; },
      detach: c.detach,
    });
    await s.sync(cfg());
    await s.sync(cfg());
    await c.settle();
    expect(built).toHaveLength(1);
    expect(built[0].calls).toEqual(["start", "refresh"]);
    await s.sync({ ...cfg(), pairingId: "p2" });
    await c.settle();
    expect(built).toHaveLength(2);
    expect(built[0].calls).toEqual(["start", "refresh", "stop"]); // the old pairing's bridge is stopped
    expect(built[1].calls).toEqual(["start"]);
  });

  test("unpaired (config null) tears the bridge down", async () => {
    const f = fakeBridge();
    const c = collector();
    const s = createBridgeSupervisor({ probe: async () => true, create: () => f.bridge, detach: c.detach });
    await s.sync(cfg());
    await s.sync(null);
    await c.settle();
    expect(f.calls).toEqual(["start", "stop"]);
    expect(s.active).toBe(false);
  });

  test("a probe that THROWS is treated as 'no daemon' — the sweep never sees the error", async () => {
    let created = 0;
    const s = createBridgeSupervisor({ probe: async () => { throw new Error("stat exploded"); }, create: () => { created++; throw new Error("x"); } });
    await s.sync(cfg());
    expect(created).toBe(0);
  });

  // The regression this closes: the user's Codex app-server daemon died at 22:14 and NOTHING said so.
  // The presence gate correctly refused to build a bridge — and since the bridge is the ONLY path by
  // which a phone can answer a Codex TUI question, every question for the next day degraded into an
  // attention row that could be looked at but never answered.
  test("socket PRESENT → no start attempt at all (the bridge just builds, as before)", async () => {
    const f = fakeBridge();
    const c = collector();
    let starts = 0;
    const s = createBridgeSupervisor({
      probe: async () => true, create: () => f.bridge, detach: c.detach,
      startDaemon: async () => { starts += 1; return true; },
    });
    await s.sync(cfg());
    await s.sync(cfg());
    await c.settle();
    expect(starts).toBe(0);
    expect(s.daemonDown).toBe(false);
    expect(f.calls).toEqual(["start", "refresh"]);
  });

  test("socket ABSENT → EXACTLY ONE bounded start attempt per cooldown, not one per sweep", async () => {
    const c = collector();
    let clock = 1_000_000;
    let starts = 0;
    const s = createBridgeSupervisor({
      probe: async () => false, create: () => { throw new Error("unreachable"); }, detach: c.detach,
      now: () => clock, startDaemon: async () => { starts += 1; return false; },
    });
    await s.sync(cfg());          // t0 → the one attempt
    clock += 5_000; await s.sync(cfg()); // next sweep
    clock += 5_000; await s.sync(cfg()); // …and the next
    clock += 280_000; await s.sync(cfg()); // still inside the 5-minute cooldown
    await c.settle();
    expect(starts).toBe(1);
    clock += 20_000;              // cooldown expired (290 s + 20 s > 300 s)
    await s.sync(cfg());
    await c.settle();
    expect(starts).toBe(2);
  });

  test("the start attempt is DETACHED and never-throwing — a hung/exploding `codex` costs the sweep nothing", async () => {
    const traced: object[] = [];
    const s = createBridgeSupervisor({
      probe: async () => false,
      create: () => { throw new Error("unreachable"); },
      // No `detach` injected: the production fire-and-forget path must swallow this rejection itself.
      startDaemon: () => Promise.reject(new Error("codex: command not found")),
      diagnose: async () => "absent",
      trace: (event) => traced.push(event),
    });
    const raced = await Promise.race([
      s.sync(cfg()).then(() => "synced"),
      new Promise((r) => setTimeout(() => r("timeout"), 250)),
    ]);
    expect(raced).toBe("synced");
    await new Promise((r) => setTimeout(r, 10)); // let the detached rejection land
    expect(traced).toEqual([
      { event: "codex-daemon-start", outcome: "attempt" },
      {
        event: "codex-bridge-down", cause: "socket-unavailable", socket: "absent",
        impact: "codex request_user_input cannot be answered from the phone",
        recovery: "codex app-server daemon start, at most once per 5min; helps the NEXT codex session, never a running TUI",
      },
    ]);
    expect(s.daemonDown).toBe(true);
  });

  test("a start that SUCCEEDS builds the bridge on the NEXT sync (the probe stays the only authority)", async () => {
    const f = fakeBridge();
    const c = collector();
    let socket = false;
    const s = createBridgeSupervisor({
      probe: async () => socket, create: () => f.bridge, detach: c.detach,
      startDaemon: async () => { socket = true; return true; },
    });
    await s.sync(cfg());
    await c.settle();
    expect(f.calls).toEqual([]);      // the sync that noticed does NOT retro-build a bridge
    expect(s.daemonDown).toBe(true);
    await s.sync(cfg());
    await c.settle();
    expect(f.calls).toEqual(["start"]);
    expect(s.daemonDown).toBe(false); // …and the breadcrumb clears itself
  });

  // THE OTHER HALF of the 2026-08-09 outage. The probe said "socket present" (it was a stat, and the dead
  // daemon had left its socket file behind), so the supervisor happily built a bridge — and `codex
  // app-server proxy` died on the spot, reporting "stdout ended" 240 times between 13:47 and 18:36. Every
  // one of those was traced and NONE of them was interpreted: no breadcrumb, no restart, no diagnosis.
  test("`proxy stdout ended` from the bridge IS a dead daemon: breadcrumb + ONE restart + ONE trace line", async () => {
    const f = fakeBridge();
    const c = collector();
    const traced: object[] = [];
    let starts = 0;
    let sink: ((e: Error) => void) | undefined;
    const s = createBridgeSupervisor({
      // The pessimal case on purpose: a probe that keeps insisting the daemon is fine (a stale socket, or
      // a future regression back to a stat). The bridge's own error must be enough on its own.
      probe: async () => true,
      create: (_cfg, opts) => { sink = opts.onError; return f.bridge; },
      detach: c.detach,
      diagnose: async () => "stale",
      startDaemon: async () => { starts += 1; return false; },
      trace: (event) => traced.push(event),
      now: () => 1_000_000,
    });
    await s.sync(cfg());
    await c.settle();
    expect(s.daemonDown).toBe(false); // nothing has gone wrong yet

    sink!(new Error(CODEX_PROXY_STDOUT_ENDED));
    await c.settle();
    expect(s.daemonDown).toBe(true); // → run() stamps `cxbridge:down` on this very cycle's Codex frames
    expect(starts).toBe(1);
    expect(traced).toEqual([
      { event: "codex-daemon-start", outcome: "attempt" },
      {
        event: "codex-bridge-down", cause: "proxy-stdout-ended", socket: "stale",
        impact: "codex request_user_input cannot be answered from the phone",
        recovery: "codex app-server daemon start, at most once per 5min; helps the NEXT codex session, never a running TUI",
      },
    ]);

    // 239 more of the same error: still ONE restart, and still ONE diagnosis line. That is the whole
    // difference between tonight's trace and a legible one.
    for (let i = 0; i < 239; i++) sink!(new Error(CODEX_PROXY_STDOUT_ENDED));
    await c.settle();
    expect(starts).toBe(1);
    expect(traced.filter((e) => (e as { event: string }).event === "codex-bridge-down")).toHaveLength(1);
  });

  test("an ordinary bridge error is NOT read as a dead daemon (no restart, no breadcrumb)", async () => {
    const f = fakeBridge();
    const c = collector();
    let starts = 0;
    let sink: ((e: Error) => void) | undefined;
    const s = createBridgeSupervisor({
      probe: async () => true,
      create: (_cfg, opts) => { sink = opts.onError; return f.bridge; },
      detach: c.detach,
      startDaemon: async () => { starts += 1; return true; },
    });
    await s.sync(cfg());
    sink!(new Error("Codex app-server rejected the answer"));
    sink!(new Error("Invalid Codex app-server websocket data"));
    await c.settle();
    expect(starts).toBe(0);
    expect(s.daemonDown).toBe(false);
  });

  test("the two down signals SHARE one cooldown — they can never add up to a restart storm", async () => {
    const f = fakeBridge();
    const c = collector();
    let clock = 1_000_000;
    let available = true;
    let starts = 0;
    let sink: ((e: Error) => void) | undefined;
    const s = createBridgeSupervisor({
      probe: async () => available,
      create: (_cfg, opts) => { sink = opts.onError; return f.bridge; },
      detach: c.detach,
      diagnose: async () => "stale",
      startDaemon: async () => { starts += 1; return false; },
      now: () => clock,
    });
    await s.sync(cfg());
    sink!(new Error(CODEX_PROXY_STDOUT_ENDED)); // signal 1 → the one attempt
    await c.settle();
    expect(starts).toBe(1);                     // the error alone armed the restart
    available = false;                          // and now the probe agrees
    clock += 5_000; await s.sync(cfg());        // signal 2, same cooldown window
    clock += 5_000; await s.sync(cfg());
    sink!(new Error(CODEX_PROXY_STDOUT_ENDED));
    await c.settle();
    expect(starts).toBe(1);
    clock += 300_000;                           // cooldown expired
    await s.sync(cfg());
    await c.settle();
    expect(starts).toBe(2);                     // one per cooldown, no matter how many signals arrive
  });

  test("a daemon that comes BACK clears the outage, and a later one gets its own diagnosis line", async () => {
    const f = fakeBridge();
    const c = collector();
    const traced: object[] = [];
    let available = false;
    const s = createBridgeSupervisor({
      probe: async () => available, create: () => f.bridge, detach: c.detach,
      diagnose: async () => "absent", startDaemon: async () => false,
      trace: (event) => traced.push(event), now: () => 1_000_000,
    });
    await s.sync(cfg());
    await c.settle();
    available = true;
    await s.sync(cfg());        // recovered
    await c.settle();
    expect(s.daemonDown).toBe(false);
    available = false;
    await s.sync(cfg());        // a NEW outage
    await c.settle();
    expect(traced.filter((e) => (e as { event: string }).event === "codex-bridge-down")).toHaveLength(2);
  });

  test("unpaired never attempts a start (no config, no Codex row to be honest to)", async () => {
    let starts = 0;
    const s = createBridgeSupervisor({
      probe: async () => false, create: () => { throw new Error("unreachable"); },
      startDaemon: async () => { starts += 1; return true; },
    });
    await s.sync(null);
    expect(starts).toBe(0);
    expect(s.daemonDown).toBe(false);
  });
});

// The breadcrumb half of the same regression: while the socket is gone, every Codex frame the sweep
// seals says so in its `dbg` tail, so the phone's diagnostics toggle names the cause instead of showing
// a question that silently cannot be answered.
describe("cxbridge:down breadcrumb (Codex frames only, and only while the socket is missing)", () => {
  const rec = (): SessionRecord => ({ pid: 1, machine: "m", label: "l", ts: 1, blob: "" });
  const key = new Uint8Array(32).fill(7);
  const dbgOf = async (blob: string): Promise<string | undefined> =>
    ((await decryptBlob(key, blob)) as { dbg?: string }).dbg;

  afterEach(() => setCodexBridgeDown(false));

  test("a Codex attention frame carries the marker LAST while down, and loses it once the socket returns", async () => {
    setCodexBridgeDown(true);
    const down = await buildNeedsAttentionEnvelope("s1", rec(), 1_000, key, "codex") as { blob: string };
    const marked = await dbgOf(down.blob);
    expect(marked).toContain("ev:attention");
    expect(marked?.endsWith(" cxbridge:down")).toBe(true);

    setCodexBridgeDown(false);
    const up = await buildNeedsAttentionEnvelope("s1", rec(), 1_000, key, "codex") as { blob: string };
    expect(await dbgOf(up.blob)).not.toContain("cxbridge:down");
  });

  test("done / working / provisional Codex frames carry it too — a row is diagnosable in any state", async () => {
    setCodexBridgeDown(true);
    const done = await buildDoneEnvelope("s1", rec(), 1_000, key, "codex") as { blob: string };
    const working = await buildWorkingEnvelope("s1", rec(), 1_000, key, "codex");
    const provisional = await buildProvisionalBlob(
      { sessionId: "s1", pid: 2, label: "l", title: "t" } as never, "m", { agent: "codex" }, key,
    );
    expect(await dbgOf(done.blob)).toContain("cxbridge:down");
    expect(await dbgOf(working.blob as string)).toContain("cxbridge:down");
    expect(await dbgOf(provisional)).toContain("cxbridge:down");
  });

  test("NOTHING is added to a Claude session (its dbg stays absent entirely)", async () => {
    setCodexBridgeDown(true);
    expect(codexBridgeIsDown()).toBe(true);
    const done = await buildDoneEnvelope("s1", rec(), 1_000, key, "claude") as { blob: string };
    const attention = await buildNeedsAttentionEnvelope("s1", rec(), 1_000, key, "claude") as { blob: string };
    expect(await dbgOf(done.blob)).toBeUndefined();
    expect(await dbgOf(attention.blob)).toBeUndefined();
  });

  test("the marker is added at most once, and a CACHED dbg loses it once the socket is back", async () => {
    setCodexBridgeDown(true);
    const marked = "1.0.0 ev:x cls:y cxbridge:down";
    const once = await buildDoneEnvelope("s1", rec(), 1_000, key, "codex", 1, marked) as { blob: string };
    expect((await dbgOf(once.blob) ?? "").match(/cxbridge:down/g)).toHaveLength(1);
    // The title repair rebuilds from `record.dbg`, so a marker stamped during an outage must not ride
    // forward once the daemon is back.
    setCodexBridgeDown(false);
    const repaired = await buildTitleRepairEnvelope("s1", { ...rec(), dbg: marked }, "t", 1_000, key, "codex");
    expect(await dbgOf(repaired.blob)).toBe("1.0.0 ev:x cls:y");
  });
});

// The deadlock this closes: `await bridge.start()` on a wedged `codex app-server proxy` child (spawned,
// never writes, never exits) froze EVERY self-heal net while the pidfile stayed claimed.
describe("bridge work is DECOUPLED from the sweep cadence (a wedged Codex child can't freeze the loop)", () => {
  test("sync() returns even when start() never settles", async () => {
    const never = new Promise<boolean>(() => {}); // a wedged proxy child: no data, no exit, no rejection
    const s = createBridgeSupervisor({
      probe: async () => true,
      create: () => ({ start: () => never, stop: async () => {}, refreshSubscriptions: () => never as unknown as Promise<void> }),
    });
    // If sync() awaited the bridge, this race would resolve "timeout" (and the real loop would hang).
    const raced = await Promise.race([
      s.sync(cfg()).then(() => "synced"),
      new Promise((r) => setTimeout(() => r("timeout"), 250)),
    ]);
    expect(raced).toBe("synced");
    // …and the NEXT cycle (refreshSubscriptions, equally wedged) is just as non-blocking.
    const raced2 = await Promise.race([
      s.sync(cfg()).then(() => "synced"),
      new Promise((r) => setTimeout(() => r("timeout"), 250)),
    ]);
    expect(raced2).toBe("synced");
  });

  test("a REJECTING start is swallowed by the default detach (no unhandled rejection)", async () => {
    const s = createBridgeSupervisor({
      probe: async () => true,
      create: () => ({ start: async () => { throw new Error("proxy died"); }, stop: async () => {}, refreshSubscriptions: async () => {} }),
    });
    await s.sync(cfg());
    await new Promise((r) => setTimeout(r, 10)); // let the detached rejection land
    expect(s.active).toBe(true); // the supervisor keeps the handle; the client owns its own retry/backoff
  });

  test("withDeadline resolves undefined instead of waiting on a promise that never settles", async () => {
    expect(await withDeadline(new Promise<string>(() => {}), 20)).toBeUndefined();
    expect(await withDeadline(Promise.resolve("done"), 1000)).toBe("done");
  });
});

// A record snapshot read at the top of a sweep is STALE by the time a 2 s POST returns. Writing the
// snapshot back stamped `done` over a session the user had just woken up — which then silenced every
// self-heal net (they all gate off a done record).
describe("stale-snapshot guard (a prompt landing mid-POST must never be clobbered back to done)", () => {
  const NOW = 9_000_000;
  const owed = (over: Partial<SessionRecord> = {}): SessionRecord =>
    rec({ lastEvent: "done", op: "done", sentDone: true, donePending: true, blob: "B", ts: NOW - 60_000, ...over });

  test("recordMovedSince keys on ts / lastEvent / op", () => {
    const snap = owed();
    expect(recordMovedSince(snap, { ...snap })).toBe(false);
    expect(recordMovedSince(snap, { ...snap, ts: snap.ts + 1 })).toBe(true);
    expect(recordMovedSince(snap, { ...snap, lastEvent: "working" })).toBe(true);
    expect(recordMovedSince(snap, { ...snap, op: "update" })).toBe(true);
    expect(recordMovedSince(snap, { ...snap, blob: "other" })).toBe(false); // a re-seal is not a state move
  });

  test("pendingDoneSettleWrite: unchanged → settled; moved-to-working → NOTHING; moved-but-done → marker only", () => {
    const snap = owed();
    const settled: SessionRecord = { ...snap, lastEvent: "done", sentDone: true, op: "done", donePending: undefined, doneAttempts: undefined };
    expect(pendingDoneSettleWrite(snap, { ...snap }, settled)).toBe(settled);
    expect(pendingDoneSettleWrite(snap, null, settled)).toBe(settled); // unreadable → pre-guard behavior
    expect(pendingDoneSettleWrite(snap, { ...snap, ts: NOW, lastEvent: "working", op: "update", donePending: undefined }, settled)).toBeNull();
    const moved = pendingDoneSettleWrite(snap, { ...snap, ts: NOW, title: "newer" }, settled);
    expect(moved).toMatchObject({ ts: NOW, title: "newer" }); // the FRESH record survives…
    expect(moved!.donePending).toBeUndefined();               // …minus the debt marker
  });

  test("correctPendingDone: a record that flipped to WORKING during the POST is not stamped done", async () => {
    const writes: SessionRecord[] = [];
    // The hook's UserPromptSubmit landed while our done was in flight.
    const woken = rec({ lastEvent: "working", op: "update", ts: NOW, blob: "W", sentDone: false });
    const v = await correctPendingDone(cfg(), "/tmp/s.json", "s", owed(), NOW, {
      post: async () => "delivered" as PostOutcome,
      readRecord: async () => woken,
      writeRecord: async (_p, r) => { writes.push(r); },
    });
    expect(v).toBe("corrected");  // the done DID deliver — the pairing is alive
    expect(writes).toEqual([]);   // …but nothing was written back: the live session keeps its working state
    // Proof of the bug this closes: had the snapshot been written back, the session would have been
    // silenced (every net gates off a done record) while the phone showed it running.
    expect(shouldHeartbeat(woken, NOW + HEARTBEAT_AFTER_MS, undefined, false)).toBe(true);
  });

  test("correctPendingDone: a record that moved but is STILL done keeps the fresh state, minus the debt", async () => {
    const writes: SessionRecord[] = [];
    const fresher = { ...owed(), ts: NOW, title: "renamed" };
    await correctPendingDone(cfg(), "/tmp/s.json", "s", owed(), NOW, {
      post: async () => "delivered" as PostOutcome,
      readRecord: async () => fresher,
      writeRecord: async (_p, r) => { writes.push(r); },
    });
    expect(writes[0]).toMatchObject({ ts: NOW, title: "renamed", lastEvent: "done" });
    expect(writes[0].donePending).toBeUndefined();
    expect(shouldPendingDoneCheck(writes[0])).toBe(false); // the debt really is settled
  });

  test("correctPendingDone: an unchanged record still settles exactly as before (no behavior drift)", async () => {
    const writes: SessionRecord[] = [];
    const snap = owed();
    const v = await correctPendingDone(cfg(), "/tmp/s.json", "s", snap, NOW, {
      post: async () => "delivered" as PostOutcome,
      readRecord: async () => ({ ...snap }),
      writeRecord: async (_p, r) => { writes.push(r); },
    });
    expect(v).toBe("corrected");
    expect(writes[0]).toMatchObject({ lastEvent: "done", op: "done", sentDone: true });
    expect(writes[0].donePending).toBeUndefined();
  });

  test("pendingDoneRetryWrite: the counter bump follows the same rules", () => {
    const snap = owed();
    expect(pendingDoneRetryWrite(snap, null, 3)).toMatchObject({ doneAttempts: 3, donePending: true });
    expect(pendingDoneRetryWrite(snap, { ...snap }, 3)).toMatchObject({ doneAttempts: 3 });
    expect(pendingDoneRetryWrite(snap, { ...snap, ts: NOW, lastEvent: "working", op: "update" }, 3)).toBeNull();
  });

  test("correctPendingDone: a FAILED re-POST on a woken record writes no counter (but still bounds the retry)", async () => {
    const writes: SessionRecord[] = [];
    const woken = rec({ lastEvent: "working", op: "update", ts: NOW });
    const seams = {
      post: async () => "failed" as PostOutcome,
      readRecord: async () => woken,
      writeRecord: async (_p: string, r: SessionRecord) => { writes.push(r); },
    };
    for (let i = 0; i < 3; i++) await correctPendingDone(cfg(), "/tmp/s.json", "s", owed(), NOW, seams);
    expect(writes).toEqual([]); // the woken record is never stamped with our stale counter
    // …yet the retry is still bounded: the in-memory mirror counted all three attempts.
    expect(effectiveDoneAttempts(owed(), "s")).toBe(3);
  });
});

// Same shape at the 1 h horizon: retire POSTed a blob-less end and DELETED the record from a snapshot
// taken before the sweep's earlier awaits — so a session woken mid-sweep lost its reap/heartbeat handle.
describe("retireDoneStale re-reads before it deletes (a woken session is never retired out from under itself)", () => {
  const NOW = 100_000_000;
  const RETIRE_MS = RETIRE_AFTER_MS;
  const done = (over: Partial<SessionRecord> = {}): SessionRecord =>
    rec({ op: "done", lastEvent: "done", sentDone: true, blob: "DONEBLOB", ts: NOW - RETIRE_MS, ...over });

  test("a record that moved BEFORE the end-POST → skip: no POST, no delete", async () => {
    let posted = false;
    let deleted = false;
    const v = await retireDoneStale(cfg(), "/tmp/s.json", "s", done(), NOW, {
      post: async () => { posted = true; return "delivered" as PostOutcome; },
      deleteRecord: async () => { deleted = true; },
      readRecord: async () => rec({ lastEvent: "working", op: "update", ts: NOW }),
    });
    expect(v).toBe("skip");
    expect(posted).toBe(false);
    expect(deleted).toBe(false);
  });

  test("a record that moves DURING the end-POST → the record survives (the delete is skipped)", async () => {
    let reads = 0;
    let deleted = false;
    const v = await retireDoneStale(cfg(), "/tmp/s.json", "s", done(), NOW, {
      post: async () => "delivered" as PostOutcome,
      deleteRecord: async () => { deleted = true; },
      // 1st read (pre-POST): unchanged. 2nd read (pre-delete): the user's prompt landed.
      readRecord: async () => (++reads === 1 ? done() : rec({ lastEvent: "working", op: "update", ts: NOW })),
    });
    expect(reads).toBe(2);
    expect(v).toBe("skip");
    expect(deleted).toBe(false);
  });

  test("an unchanged record still retires exactly as before (POST + delete)", async () => {
    const deletes: string[] = [];
    const v = await retireDoneStale(cfg(), "/tmp/s.json", "s", done(), NOW, {
      post: async () => "delivered" as PostOutcome,
      deleteRecord: async (p) => { deletes.push(p); },
      readRecord: async () => done(),
    });
    expect(v).toBe("retired");
    expect(deletes).toEqual(["/tmp/s.json"]);
  });

  test("an unreadable re-read keeps the pre-guard behavior (retire is best-effort, never blocked)", async () => {
    const deletes: string[] = [];
    const v = await retireDoneStale(cfg(), "/tmp/s.json", "s", done(), NOW, {
      post: async () => "delivered" as PostOutcome,
      deleteRecord: async (p) => { deletes.push(p); },
      readRecord: async () => { throw new Error("EIO"); },
    });
    expect(v).toBe("retired");
    expect(deletes).toEqual(["/tmp/s.json"]);
  });
});

// The persisted doneAttempts counter is written inside a try/catch, so a disk that keeps failing left the
// bound at zero forever — one doomed done POST every 5 s, indefinitely.
describe("corrective-done retries stay bounded even when EVERY record write fails", () => {
  const NOW = 9_000_000;
  const interruptTail = asstTurn("[Request interrupted by user]");

  test("correctInterrupt: a never-persisting counter still hits the cap (memory-backed bound)", async () => {
    let posts = 0;
    const snapshot = irec({ lastEvent: "needsAttention", op: "update", prio: 1, blob: "ATTN", transcript: "/tmp/t.jsonl" });
    for (let i = 0; i < 20; i++) {
      // The same UNCHANGED snapshot every sweep — exactly what a failing rewrite leaves on disk.
      await correctInterrupt(cfg(), "/tmp/s.json", "wedged", snapshot, NOW, {
        post: async () => { posts++; return "failed" as PostOutcome; },
        readTail: async () => interruptTail,
        writeRecord: async () => { throw new Error("ENOSPC"); },
      });
    }
    expect(posts).toBeLessThanOrEqual(6); // bounded by memory, NOT one POST per sweep forever
  });

  test("correctIdleClaude: same bound (the reap can't spin on a read-only home either)", async () => {
    let posts = 0;
    const idle = rec({ lastEvent: "sessionStart", ts: NOW - 3_600_000, blob: "W" });
    for (let i = 0; i < 20; i++) {
      await correctIdleClaude(cfg(), "/tmp/s.json", "wedged-idle", idle, NOW, {
        post: async () => { posts++; return "failed" as PostOutcome; },
        writeRecord: async () => { throw new Error("EROFS"); },
      });
    }
    expect(posts).toBeLessThanOrEqual(6);
  });

  test("correctPendingDone: same bound", async () => {
    let posts = 0;
    const owed = rec({ lastEvent: "done", op: "done", sentDone: true, donePending: true, blob: "B", ts: NOW - 60_000 });
    for (let i = 0; i < 20; i++) {
      await correctPendingDone(cfg(), "/tmp/s.json", "wedged-done", owed, NOW, {
        post: async () => { posts++; return "failed" as PostOutcome; },
        readRecord: async () => null,
        writeRecord: async () => { throw new Error("EIO"); },
      });
    }
    expect(posts).toBeLessThanOrEqual(6);
  });

  test("a delivered corrective clears the memory, so the NEXT episode gets a full retry budget", async () => {
    const snapshot = irec({ lastEvent: "needsAttention", op: "update", prio: 1, blob: "ATTN", transcript: "/tmp/t.jsonl" });
    const seams = (outcome: PostOutcome) => ({
      post: async () => outcome,
      readTail: async () => interruptTail,
      writeRecord: async () => { throw new Error("ENOSPC"); },
    });
    for (let i = 0; i < 3; i++) await correctInterrupt(cfg(), "/tmp/s.json", "s2", snapshot, NOW, seams("failed"));
    expect(effectiveDoneAttempts(snapshot, "s2")).toBe(3);
    await correctInterrupt(cfg(), "/tmp/s.json", "s2", snapshot, NOW, seams("delivered"));
    expect(effectiveDoneAttempts(snapshot, "s2")).toBe(0);
  });

  test("effectiveDoneAttempts takes the HIGHER of the persisted counter and the in-memory mirror", () => {
    expect(effectiveDoneAttempts(rec({ doneAttempts: 4 }), "fresh")).toBe(4);
    expect(effectiveDoneAttempts(rec(), "fresh")).toBe(0);
  });
});

// The reconcile matcher used to hardcode `agent === "codex"` as "discovery-capable". Keying it on the
// adapter registry's discoverLive keeps the daemon's no-inline-agent-branch discipline and lets a future
// discovery-capable agent reconcile without touching this file.
describe("provisionalsCoveredByReal is keyed on adapter.discoverLive, not a hardcoded agent", () => {
  const entry = (sessionId: string, r: Partial<SessionRecord>): RecordEntry => ({ sessionId, rec: rec(r) });

  test("the default registry behaves exactly as the codex-hardcoded version did", () => {
    const entries = [
      entry("codex-pid-77", { pid: 77, provisional: true, agent: "codex" }),
      entry("real", { pid: 77, agent: "codex" }),
      entry("claude-prov", { pid: 88, provisional: true }),
      entry("claude-real", { pid: 88 }), // claude has no discoverLive → never covers a provisional
    ];
    expect(provisionalsCoveredByReal(entries)).toEqual(["codex-pid-77"]);
  });

  test("a hypothetical discovery-capable CLAUDE adapter would reconcile claude provisionals too", () => {
    const discoveringClaude: AgentAdapter = { ...claudeAdapter, discoverLive: async () => [] };
    const entries = [entry("claude-prov", { pid: 88, provisional: true }), entry("claude-real", { pid: 88 })];
    expect(provisionalsCoveredByReal(entries, [claudeAdapter, codexAdapter])).toEqual([]);
    expect(provisionalsCoveredByReal(entries, [discoveringClaude, codexAdapter])).toEqual(["claude-prov"]);
  });

  test("reconcileProvisionalsSweep threads the registry through", async () => {
    const posts: object[] = [];
    const deletes: string[] = [];
    const entries = [entry("claude-prov", { pid: 88, provisional: true }), entry("claude-real", { pid: 88 })];
    await reconcileProvisionalsSweep(cfg(), {
      readEntries: async () => entries,
      post: async (b) => { posts.push(b); return "delivered" as PostOutcome; },
      deleteRecord: async (id) => { deletes.push(id); },
      adapters: [{ ...claudeAdapter, discoverLive: async () => [] }],
    });
    expect(deletes).toEqual(["claude-prov"]);
    expect(posts[0]).toMatchObject({ op: "end", sessionId: "claude-prov" });
  });
});

// --- phone → Mac commands (E2E-sealed, piggybacked on the /cc/event response) ------------------
//
// The worker relays an OPAQUE {id, blob} and can neither read nor forge the payload, so extractCommands
// is a pure shape check and ALL the semantics — allow-list, freshness, replay, de-duplication — are
// enforced in drainCommands after the GCM tag authenticates the blob. These tests seal with the repo's
// own crypto helpers (never a mock) so they prove interop with the phone's envelope.

describe("extractCommands (the /cc/event response's OPTIONAL commands key)", () => {
  test("accepts a well-formed sealed entry", () => {
    expect(extractCommands({ ok: true, commands: [{ id: "c1", blob: "SEALED" }] }))
      .toEqual([{ id: "c1", blob: "SEALED" }]);
  });

  test("the wire is OPAQUE — nothing semantic is read here, and clear fields are never trusted", () => {
    // A worker that helpfully (or maliciously) adds clear fields gets them ignored entirely: only
    // id + blob survive, so nothing downstream can key on unauthenticated data.
    expect(extractCommands({ commands: [{ id: "c1", blob: "SEALED", kind: "focus-terminal", sessionId: "spoofed" }] }))
      .toEqual([{ id: "c1", blob: "SEALED" }]);
  });

  test("the key is OMITTED when nothing is queued — the overwhelmingly common response", () => {
    expect(extractCommands({ ok: true })).toEqual([]);
    expect(extractCommands({ ok: true, commands: null })).toEqual([]);
    expect(extractCommands({ ok: true, commands: "focus" })).toEqual([]);
    expect(extractCommands(undefined)).toEqual([]);
    expect(extractCommands("not json at all")).toEqual([]);
    expect(extractCommands(null)).toEqual([]);
  });

  test("malformed entries are dropped individually, never fatally", () => {
    expect(extractCommands({
      commands: [
        null,
        "c1",
        { blob: "SEALED" },              // no id
        { id: "", blob: "SEALED" },      // empty id
        { id: 7, blob: "SEALED" },       // non-string id
        { id: "c1" },                    // no blob
        { id: "c2", blob: "" },          // empty blob
        { id: "c3", blob: 9 },           // non-string blob
        { id: "c4", blob: "SEALED" },    // the only good one
      ],
    })).toEqual([{ id: "c4", blob: "SEALED" }]);
  });

  test("caps at 8 per response (a buggy/compromised worker can't hand us an unbounded work list)", () => {
    const commands = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, blob: "SEALED" }));
    expect(extractCommands({ commands })).toHaveLength(8);
    expect(extractCommands({ commands })[7].id).toBe("c7");
  });
});

describe("drainCommands (authenticate, validate, then execute)", () => {
  beforeEach(() => { resetCommandState(); });

  const NOW = 1_800_000_000_000;
  const OTHER_KEY = new Uint8Array(32).fill(7); // a key this pairing does NOT hold
  let nonceSeq = 0;

  /** A sealed command exactly as the phone would produce it. */
  const sealed = async (
    over: Partial<CommandPayload> = {}, opts: { id?: string; key?: Uint8Array } = {},
  ): Promise<{ id: string; blob: string }> => ({
    id: opts.id ?? `cmd-${++nonceSeq}`,
    blob: await encryptBlob(opts.key ?? KEY, {
      kind: "focus-terminal", sessionId: "sess-a", ts: NOW, nonce: `n-${++nonceSeq}`, ...over,
    }),
  });

  const entry = (sessionId: string, r: Partial<SessionRecord> = {}): RecordEntry => ({ sessionId, rec: rec(r) });
  /** An adapter registry whose locator is scripted, so no real `ps` is ever spawned. */
  const registry = (locate: (ctx: { sessionId: string; record: SessionRecord }, deps?: { note?: (r: string) => void }) => Promise<number | undefined>): AgentAdapter[] => [
    { ...claudeAdapter, locateTuiPid: locate as AgentAdapter["locateTuiPid"] },
    { ...codexAdapter, locateTuiPid: locate as AgentAdapter["locateTuiPid"] },
  ];

  /** The standard harness: one tracked claude session + one tracked codex session, a scripted locate
   *  that returns the record's pid, and a focus that records what it raised. */
  const harness = (over: Partial<DrainCommandsDeps> = {}) => {
    const focused: number[] = [];
    const traces: Record<string, unknown>[] = [];
    const deps: DrainCommandsDeps = {
      readRecords: async () => [entry("sess-a", { pid: 11 }), entry("sess-b", { pid: 22, agent: "codex" })],
      adapters: registry(async ({ record }) => record.pid),
      focus: async (pid) => { focused.push(pid); return { ok: true, via: "terminal-app" }; },
      now: () => NOW,
      trace: (e) => traces.push(e as Record<string, unknown>),
      ...over,
    };
    return { focused, traces, deps };
  };

  test("HAPPY PATH: a blob sealed under the pairing key decrypts, validates and focuses", async () => {
    const { focused, traces, deps } = harness();
    const cmd = await sealed({ sessionId: "sess-b" });
    expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(1);
    expect(focused).toEqual([22]);
    expect(traces[0]).toMatchObject({
      event: "focus-terminal", id: cmd.id, sessionId: "sess-b", kind: "focus-terminal",
      agent: "codex", pid: 22, result: "focused", via: "terminal-app",
    });
  });

  test("Open on Mac releases only a LIVE TUI request_user_input hold after focus succeeds", async () => {
    const answers = createLanAnswerStore();
    const resolved: string[] = [];
    const hold: DecisionHold = {
      blob: await encryptBlob(KEY, {
        status: "decisionPending", agent: "codex", permissionRequestId: "req-tui",
        permissionToolName: "request_user_input", permissionSummary: "Which deployment?",
      }),
      at: NOW - 1_000,
      pid: 777,
    };
    const { deps } = harness({
      readDecisionHoldFn: async () => hold,
      holdPidAliveFn: () => true,
      answerStore: answers,
      resolveDecisionFn: async (_config: Config, requestId: string) => { resolved.push(requestId); },
    });
    const cmd = await sealed({ sessionId: "sess-b" });
    expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(1);
    const stored = answers.peek("req-tui", NOW);
    expect(stored).toBeDefined();
    expect(await decryptBlob(KEY, stored!.answerBlob)).toEqual({
      requestId: "req-tui", decision: "allow", ts: Math.floor(NOW / 1000),
    });
    expect(resolved).toEqual(["req-tui"]);
  });

  test("focus never releases an ordinary/app-server question card or a dead hold", async () => {
    for (const testCase of [
      {
        name: "app-server",
        alive: true,
        frame: {
          status: "decisionPending", agent: "codex", permissionRequestId: "req-app",
          permissionToolName: "request_user_input", permissionQuestions: [{ q: "Which?", o: ["A", "B"] }],
        },
      },
      {
        name: "dead",
        alive: false,
        frame: {
          status: "decisionPending", agent: "codex", permissionRequestId: "req-dead",
          permissionToolName: "request_user_input",
        },
      },
      {
        name: "stale",
        alive: true,
        at: NOW - 600_001,
        frame: {
          status: "decisionPending", agent: "codex", permissionRequestId: "req-stale",
          permissionToolName: "request_user_input",
        },
      },
    ]) {
      resetCommandState();
      const answers = createLanAnswerStore();
      const resolved: string[] = [];
      const hold: DecisionHold = {
        blob: await encryptBlob(KEY, testCase.frame), at: testCase.at ?? NOW - 1_000, pid: 777,
      };
      const { deps } = harness({
        readDecisionHoldFn: async () => hold,
        holdPidAliveFn: () => testCase.alive,
        answerStore: answers,
        resolveDecisionFn: async (_config: Config, requestId: string) => { resolved.push(requestId); },
      });
      const cmd = await sealed({ sessionId: "sess-b" }, { id: `cmd-${testCase.name}` });
      expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(1);
      expect(answers.size()).toBe(0);
      expect(resolved).toEqual([]);
    }
  });

  test("a failed focus does not release the blocking hook", async () => {
    const answers = createLanAnswerStore();
    const hold: DecisionHold = {
      blob: await encryptBlob(KEY, {
        status: "decisionPending", agent: "codex", permissionRequestId: "req-tui",
        permissionToolName: "request_user_input",
      }),
      at: NOW,
      pid: 777,
    };
    const { deps } = harness({
      focus: async () => ({ ok: false, reason: "osascript-failed" }),
      readDecisionHoldFn: async () => hold,
      holdPidAliveFn: () => true,
      answerStore: answers,
    });
    const cmd = await sealed({ sessionId: "sess-b" });
    expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(0);
    expect(answers.size()).toBe(0);
  });

  test("threads the session record into terminal focus and traces herdr's terminal reason", async () => {
    const seen: Array<{ pid: number; agent: string; title?: string; cwd?: string }> = [];
    const { traces, deps } = harness({
      readRecords: async () => [entry("sess-b", {
        pid: 22, agent: "codex", title: "Review herdr support",
        origin: { hook_event_name: "SessionStart", ppid: 22, cwd: "/repo" },
      })],
      focus: async (pid, context) => {
        seen.push({ pid, agent: context.agent, title: context.record.title, cwd: context.record.origin?.cwd });
        return { ok: true, via: "herdr", reason: "herdr-focused" };
      },
    });
    const cmd = await sealed({ sessionId: "sess-b" });
    expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(1);
    expect(seen).toEqual([{ pid: 22, agent: "codex", title: "Review herdr support", cwd: "/repo" }]);
    expect(traces[0]).toMatchObject({ result: "focused", via: "herdr", reason: "herdr-focused" });
  });

  test("a blob sealed under the WRONG key is refused — this is the whole point of sealing", async () => {
    const { focused, traces, deps } = harness();
    const cmd = await sealed({}, { key: OTHER_KEY });
    expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(0);
    expect(focused).toEqual([]);
    expect(traces.map((t) => t.result)).toEqual(["decrypt-failed"]);
    expect(traces[0].sessionId).toBeUndefined(); // nothing is even READ out of an unauthenticated blob
  });

  test("a TAMPERED ciphertext is refused (GCM's tag catches the edit)", async () => {
    const { focused, traces, deps } = harness();
    const good = await sealed();
    const flipped = good.blob.slice(0, 20) + (good.blob[20] === "A" ? "B" : "A") + good.blob.slice(21);
    expect(await drainCommands(cfg(), { ...deps, take: () => [{ id: good.id, blob: flipped }] })).toBe(0);
    expect(focused).toEqual([]);
    expect(traces.map((t) => t.result)).toEqual(["decrypt-failed"]);
  });

  test("an authentic blob that isn't a command shape is malformed, not executed", async () => {
    const { focused, traces, deps } = harness();
    const noNonce = { id: "c-nn", blob: await encryptBlob(KEY, { kind: "focus-terminal", sessionId: "sess-a", ts: NOW }) };
    const noSession = { id: "c-ns", blob: await encryptBlob(KEY, { kind: "focus-terminal", ts: NOW, nonce: "n" }) };
    expect(await drainCommands(cfg(), { ...deps, take: () => [noNonce, noSession] })).toBe(0);
    expect(focused).toEqual([]);
    expect(traces.map((t) => t.result)).toEqual(["malformed", "malformed"]);
  });

  test("a kind outside the plugin's allow-list is refused (the blind relay can't filter it for us)", async () => {
    const { focused, traces, deps } = harness();
    const cmd = await sealed({ kind: "run-shell-command" });
    expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(0);
    expect(focused).toEqual([]);
    expect(traces[0]).toMatchObject({ result: "bad-kind", kind: "run-shell-command" });
  });

  test("a sessionId this machine doesn't track is refused", async () => {
    const { focused, traces, deps } = harness();
    const cmd = await sealed({ sessionId: "ghost" });
    expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(0);
    expect(focused).toEqual([]);
    expect(traces[0]).toMatchObject({ result: "unknown-session", sessionId: "ghost" });
  });

  test("FRESHNESS: a tap older than the queue TTL is stale intent and is refused", async () => {
    const { focused, traces, deps } = harness();
    const stale = await sealed({ ts: NOW - COMMAND_TTL_MS - 1 });
    const edge = await sealed({ ts: NOW - COMMAND_TTL_MS }); // exactly at the TTL still counts
    expect(await drainCommands(cfg(), { ...deps, take: () => [stale, edge] })).toBe(1);
    expect(focused).toEqual([11]);
    expect(traces.map((t) => t.result)).toEqual(["stale", "focused"]);
  });

  test("FRESHNESS: clock skew is tolerated up to the margin, and refused beyond it", async () => {
    const { focused, traces, deps } = harness();
    const skewed = await sealed({ ts: NOW + COMMAND_FUTURE_SKEW_MS });      // within the margin
    const absurd = await sealed({ ts: NOW + COMMAND_FUTURE_SKEW_MS + 1 });  // beyond it
    expect(await drainCommands(cfg(), { ...deps, take: () => [skewed, absurd] })).toBe(1);
    expect(focused).toEqual([11]);
    expect(traces.map((t) => t.result)).toEqual(["focused", "stale"]);
  });

  // CROSS-SURFACE UNIT GUARD. The two freshness tests above derive their boundaries from
  // COMMAND_TTL_MS / COMMAND_FUTURE_SKEW_MS, so they would still pass if the SCALE were wrong on both
  // sides. The scale is a real cross-surface risk: iOS seals `ts` in epoch MILLISECONDS (the
  // CCCommand seal site), while the sibling CCDecisionAnswer.ts carries its timestamp in SECONDS — so
  // an editor "fixing" that inconsistency in either direction would silently make this daemon reject
  // every command (or, in the other direction, accept arbitrarily old ones). These literals fail loudly
  // the moment either half of the contract changes units.
  test("UNITS: `ts` is epoch MILLISECONDS — the same instant in seconds reads as ~56 years stale", async () => {
    const MS = 1_800_000_000_000;      // 2027-01-15T08:00:00Z, in milliseconds
    const SECONDS = MS / 1000;          // 1_800_000_000 — the SAME instant, in seconds
    const nowMs = MS + 3_000;           // three seconds after the tap

    const { focused, traces, deps } = harness({ now: () => nowMs });
    const inMs = await sealed({ ts: MS });
    const inSeconds = await sealed({ ts: SECONDS });
    expect(await drainCommands(cfg(), { ...deps, take: () => [inMs, inSeconds] })).toBe(1);
    expect(focused).toEqual([11]);
    expect(traces.map((t) => t.result)).toEqual(["focused", "stale"]);

    // …and the pure gate, with no constant in sight on either side of the comparison.
    expect(commandIsFresh(MS, nowMs)).toBe(true);
    expect(commandIsFresh(SECONDS, nowMs)).toBe(false);
    expect(nowMs - SECONDS).toBeGreaterThan(50 * 365 * 24 * 60 * 60 * 1000); // >50 years, unmistakable
  });

  test("REPLAY: the same sealed blob re-delivered under a FRESH id is refused by the nonce", async () => {
    const { focused, traces, deps } = harness();
    const cmd = await sealed();
    expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(1);
    // A compromised worker re-queues the identical blob under a brand-new id: the id set can't help,
    // the nonce set does.
    expect(await drainCommands(cfg(), { ...deps, take: () => [{ id: "fresh-id", blob: cmd.blob }] })).toBe(0);
    expect(focused).toEqual([11]);
    expect(traces.map((t) => t.result)).toEqual(["focused", "replay"]);
  });

  test("a repeated command id never re-focuses (a duplicate delivery of the same envelope)", async () => {
    const { focused, traces, deps } = harness();
    const cmd = await sealed();
    expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(1);
    expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(0);
    expect(focused).toEqual([11]);
    expect(traces.map((t) => t.result)).toEqual(["focused", "duplicate"]);
    expect(traces[1]).toMatchObject({ why: "id" });
  });

  test("BATCH COLLAPSE: two taps for the same target in one drain raise the window ONCE", async () => {
    const { focused, traces, deps } = harness();
    const first = await sealed({ sessionId: "sess-a" });
    const second = await sealed({ sessionId: "sess-a" }); // distinct id AND nonce — only the target matches
    const other = await sealed({ sessionId: "sess-b" });
    expect(await drainCommands(cfg(), { ...deps, take: () => [first, second, other] })).toBe(2);
    expect(focused).toEqual([11, 22]);
    expect(traces.map((t) => t.result)).toEqual(["focused", "duplicate", "focused"]);
    expect(traces[1]).toMatchObject({ why: "batch", sessionId: "sess-a" });
  });

  // The phone seals CCSessionBrief.sessionId verbatim, which for a discovered Codex row is the
  // "codex-pid-<n>" sentinel. Both halves of that contract are pinned here (see the comment on the
  // unknown-session check): (a) the provisional record really is stored under the sentinel, so such a
  // command resolves; (b) a provisional can never reach the state the phone offers the button for.
  test("SESSION-ID FORM: a codex-pid-<n> sentinel resolves, and a provisional is never attention-state", async () => {
    // (a) discovery persists the provisional under the sentinel id itself.
    const written: string[] = [];
    await discoverLiveSessions(cfg(), {
      adapters: [{ ...codexAdapter, discoverLive: async () => [disc({ pid: 16029, sessionId: "codex-pid-16029" })] }],
      post: async () => "delivered" as PostOutcome,
      readRecords: async () => [],
      writeRecord: async (sessionId) => { written.push(sessionId); },
    });
    expect(written).toEqual(["codex-pid-16029"]); // the very id the phone would seal

    const provisional = buildProvisionalRecord(disc({ pid: 16029 }), "mac", "B", { agent: "codex" }, 1_000);
    const { focused, traces, deps } = harness({
      readRecords: async () => [{ sessionId: "codex-pid-16029", rec: provisional }],
    });
    const cmd = await sealed({ sessionId: "codex-pid-16029" });
    expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(1);
    expect(focused).toEqual([16029]);
    expect(traces[0]).toMatchObject({ result: "focused", sessionId: "codex-pid-16029" });

    // (b) …and it could never have been offered: a provisional is start/done, never needsAttention,
    // and the one net that could raise attention refuses it for lack of a transcript.
    for (const idle of [false, true]) {
      const row = buildProvisionalRecord(disc(), "mac", "B", { agent: "codex" }, 1_000, "p", idle);
      expect(row.lastEvent).toBe(idle ? "done" : "sessionStart");
      expect(isWaitingSession(row)).toBe(false);
      expect(shouldPendingApprovalCheck(row, codexAdapter)).toBe(false);
      expect(shouldPlanPickerVerificationCheck(row, 1_000)).toBe(false);
    }
  });

  test("a locate that can't decide (ambiguous / no candidate) focuses NOTHING and says which", async () => {
    const { traces, deps } = harness({
      adapters: registry(async ({ sessionId }, d) => {
        d?.note?.(sessionId === "sess-a" ? "ambiguous" : "no-candidate");
        return undefined;
      }),
      focus: async () => { throw new Error("must never be called"); },
    });
    const a = await sealed({ sessionId: "sess-a" });
    const b = await sealed({ sessionId: "sess-b" });
    expect(await drainCommands(cfg(), { ...deps, take: () => [a, b] })).toBe(0);
    expect(traces.map((t) => t.result)).toEqual(["ambiguous", "no-candidate"]);
  });

  test("an agent with no locate seam is unsupported, not an error", async () => {
    const noLocate: AgentAdapter = { ...claudeAdapter };
    delete noLocate.locateTuiPid;
    const { traces, deps } = harness({ adapters: [noLocate, codexAdapter] });
    const cmd = await sealed({ sessionId: "sess-a" });
    expect(await drainCommands(cfg(), { ...deps, take: () => [cmd] })).toBe(0);
    expect(traces[0]).toMatchObject({ result: "unsupported", agent: "claude" });
  });

  test("a rejected or THROWING focus never throws out of the drain", async () => {
    const traces: Record<string, unknown>[] = [];
    const { deps } = harness({
      trace: (e) => traces.push(e as Record<string, unknown>),
      focus: async () => {
        if (traces.length === 0) throw new Error("osascript exploded");
        return { ok: false, reason: "osascript-failed" };
      },
    });
    const a = await sealed({ sessionId: "sess-a" });
    const b = await sealed({ sessionId: "sess-b" });
    expect(await drainCommands(cfg(), { ...deps, take: () => [a, b] })).toBe(0);
    expect(traces.map((t) => t.result)).toEqual(["no-candidate", "osascript-failed"]);
  });

  test("an empty buffer costs nothing — no record read, no decryption", async () => {
    let reads = 0;
    expect(await drainCommands(cfg(), {
      take: () => [],
      readRecords: async () => { reads++; return []; },
    })).toBe(0);
    expect(reads).toBe(0);
  });

  test("a throwing take() cannot derail the sweep", async () => {
    expect(await drainCommands(cfg(), { take: () => { throw new Error("boom"); } })).toBe(0);
  });
});

// --- the LAN channel's glue into the SAME command chain (NOM-44 phase 1) -----------------------
//
// acceptLanCommand is the listener's sink. It must buffer the blob exactly the way extractCommands does
// for the worker leg and then kick an immediate drain — never re-validate, so the two channels dedupe on
// the one thing that is identical across them: the inner sealed nonce.
describe("acceptLanCommand + enqueueDrainCommands (the LAN leg of command intake)", () => {
  beforeEach(() => { resetCommandState(); });

  const NOW = 1_800_000_000_000;

  const lanBlob = (over: Record<string, unknown> = {}): Promise<string> => encryptBlob(KEY, {
    kind: "focus-terminal", sessionId: "sess-a", ts: NOW, nonce: "lan-nonce-1", ...over,
  });

  const harness = () => {
    const focused: number[] = [];
    const traces: Record<string, unknown>[] = [];
    const deps: DrainCommandsDeps = {
      readRecords: async () => [{ sessionId: "sess-a", rec: rec({ pid: 11 }) }],
      adapters: [{ ...claudeAdapter, locateTuiPid: (async ({ record }) => record.pid) as AgentAdapter["locateTuiPid"] }],
      focus: async (pid) => { focused.push(pid); return { ok: true, via: "terminal-app" }; },
      now: () => NOW,
      trace: (e) => traces.push(e as Record<string, unknown>),
    };
    return { focused, traces, deps };
  };

  test("a LAN command lands in the shared buffer under a lan:-prefixed id and drains through the normal chain", async () => {
    const { focused, traces, deps } = harness();
    // acceptLanCommand pushes into the SAME module buffer the worker leg fills (the drain's default
    // take()), and kicks the drain itself — the whole latency win in one call.
    expect(await acceptLanCommand({ nonce: "outer-1", blob: await lanBlob(), config: cfg() }, deps)).toBe(1);
    expect(focused).toEqual([11]);
    expect(traces[0]).toMatchObject({ id: `${LAN_COMMAND_ID_PREFIX}outer-1`, sessionId: "sess-a", result: "focused" });
  });

  test("the same ciphertext delivered on BOTH channels focuses once — the inner nonce is the bound", async () => {
    const { focused, deps } = harness();
    const blob = await lanBlob();
    // The worker leg delivers the identical ciphertext under a server-minted id and wins the race...
    expect(await drainCommands(cfg(), { ...deps, take: () => extractCommands({ commands: [{ id: "wrk-1", blob }] }) })).toBe(1);
    // ...so the LAN copy, arriving with a different OUTER nonce and a different id, is dropped as a
    // replay of the inner sealed nonce. No second window raise.
    expect(await acceptLanCommand({ nonce: "outer-1", blob, config: cfg() }, deps)).toBe(0);
    expect(focused).toEqual([11]);
  });

  test("the shared COMMAND_BUFFER_MAX bound holds, so a LAN peer cannot grow the queue without limit", async () => {
    const blob = await lanBlob();
    const traces: Record<string, unknown>[] = [];
    // Queue far more than the bound WITHOUT draining (a take that yields nothing leaves the buffer be).
    for (let i = 0; i < 100; i++) {
      await acceptLanCommand({ nonce: `outer-${i}`, blob, config: cfg() }, { take: () => [], now: () => NOW });
    }
    // Now drain for real: every buffered entry produces exactly one trace line, so the count IS the
    // buffer's depth. 32 = COMMAND_BUFFER_MAX.
    await drainCommands(cfg(), { readRecords: async () => [], now: () => NOW, trace: (e) => traces.push(e as Record<string, unknown>) });
    expect(traces.length).toBe(32);
  });

  test("enqueueDrainCommands serializes: three concurrent drains never overlap", async () => {
    // Distinct inner nonces so each drain gets past the replay check and into the (async) record read,
    // which is where an overlap would show up.
    const blobs = await Promise.all([1, 2, 3].map((i) => lanBlob({ nonce: `lan-nonce-${i}` })));
    let queued = 0;
    let active = 0;
    let overlapped = false;
    const deps: DrainCommandsDeps = {
      take: () => [{ id: `c-${queued}`, blob: blobs[queued++] }],
      readRecords: async () => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return [];
      },
      now: () => NOW,
      trace: () => { /* silent */ },
    };
    await Promise.all([
      enqueueDrainCommands(cfg(), deps),
      enqueueDrainCommands(cfg(), deps),
      enqueueDrainCommands(cfg(), deps),
    ]);
    expect(overlapped).toBe(false);
    expect(queued).toBe(3);
  });

  test("a throwing sink call is swallowed — the HTTP response must never depend on the drain", () => {
    expect(() => acceptLanCommand({ nonce: "outer-x", blob: "not-a-blob", config: cfg() })).not.toThrow();
  });
});

// --- the LAN answer sink: the split-brain backstop (NOM-44 phase 2) ---------------------------
//
// By the time this sink runs the listener has ALREADY stored the sealed answer (that store is what the
// Claude hook's loopback poll and the in-process Codex relay read). Its only job is to tell the WORKER
// the request is settled, so the island's Allow/Deny buttons retire even when the phone's own parallel
// worker leg failed. It must never throw, never block the phone's response, and never count as a gone
// strike — the gone ladder is a /cc/event authority signal, and this path never goes near that route.
describe("acceptLanAnswer (the worker echo after a LAN-delivered answer)", () => {
  const delivery = () => ({ requestId: "req-lan-1", answerBlob: "sealed-answer", config: cfg() });

  test("echoes exactly one blob-free POST /v1/cc/decision/resolve with the pairing's PC auth", async () => {
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
    const fetchFn = (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, ...init });
      return new Response(JSON.stringify({ ok: true, status: "superseded" }), { status: 200 });
    }) as unknown as typeof fetch;
    // resolveFn is the seam; the default is the SAME resolveOnRelay the Codex relay uses, so the shape
    // asserted here is the shape that ships.
    await acceptLanAnswer(delivery(), { delayMs: 0, resolveFn: (config, requestId) => resolveOnRelay(config, requestId, fetchFn) });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://w.test/v1/cc/decision/resolve");
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body!)).toEqual({ requestId: "req-lan-1" }); // blob-free: the worker stays blind
    expect(calls[0].headers).toMatchObject({ "x-cc-pairing": "p", "x-cc-auth": "s" });
    // The one route that feeds the gone-strike ladder is /v1/cc/event; this path never touches it.
    expect(calls.every((c) => !c.url.endsWith("/v1/cc/event"))).toBe(true);
  });

  test("a 404/410 (the phone's own worker leg already retired it) is a normal outcome, never a gone strike", async () => {
    // The gone-strike ladder is fed EXCLUSIVELY by the /v1/cc/event POSTers (postEvent + runHook), which
    // is why this is a structural property rather than a counter assertion: the LAN echo issues exactly
    // one request, to the resolve route, and calls nothing else — there is no path from here to
    // recordGoneStrike at all. A definitive status is simply "already retired", the NORMAL race outcome.
    for (const status of [404, 410]) {
      const urls: string[] = [];
      const fetchFn = (async (url: string) => { urls.push(url); return new Response("", { status }); }) as unknown as typeof fetch;
      await acceptLanAnswer(delivery(), { delayMs: 0, resolveFn: (config, requestId) => resolveOnRelay(config, requestId, fetchFn) });
      expect(urls).toEqual(["https://w.test/v1/cc/decision/resolve"]);
    }
  });

  test("a failing echo resolves silently (traced, never thrown) — the worker's 30 s sweep is the backstop", async () => {
    const traces: Array<Record<string, unknown>> = [];
    await acceptLanAnswer(delivery(), {
      delayMs: 0,
      resolveFn: async () => { throw new Error("network gone"); },
      trace: (e) => traces.push(e as Record<string, unknown>),
    });
    expect(traces).toEqual([{ event: "lan", result: "echo-failed", requestId: "req-lan-1" }]);
  });

  test("a synchronously throwing resolver cannot surface into the listener's request handler", () => {
    expect(() => acceptLanAnswer(delivery(), { delayMs: 0, resolveFn: () => { throw new Error("boom"); } })).not.toThrow();
  });

  /** THE ECHO IS A BACKSTOP, NOT THE FIRST WRITER (field 2026-08-05). It used to fire the instant the
   *  answer landed, which on a real LAN is always before the phone's own worker leg can land — so
   *  /v1/cc/decision/resolve stamped `superseded` on the user's OWN answer, the phone's worker leg came
   *  back 409, and the row read "Replaced by a newer request" for a tap that had just succeeded. */
  test("the echo gives the phone's own worker leg a head start before it fires", async () => {
    const order: string[] = [];
    let released!: () => void;
    const waited = new Promise<void>((resolve) => { released = resolve; });
    const echo = acceptLanAnswer(delivery(), {
      sleep: (ms) => { order.push(`slept:${ms}`); return waited; },
      resolveFn: async () => { order.push("resolve"); },
    });
    expect(order).toEqual([`slept:${LAN_ANSWER_ECHO_DELAY_MS}`]); // nothing has been echoed yet
    released();
    await echo;
    expect(order).toEqual([`slept:${LAN_ANSWER_ECHO_DELAY_MS}`, "resolve"]);
  });

  test("the default head start is a real, bounded wait (not zero, not forever)", () => {
    expect(LAN_ANSWER_ECHO_DELAY_MS).toBeGreaterThan(0);
    expect(LAN_ANSWER_ECHO_DELAY_MS).toBeLessThan(30_000); // inside the worker's poll-liveness sweep
  });
});

// --- the watchdog's own header set (x-cc-role gates command delivery) --------------------------
//
// Commands are CONSUMED server-side on delivery, so exactly one POSTer may claim the role: the one
// that reads the response body. hook.ts / codex-notify.ts / reset.ts / shared.ts's pending-pairing
// flush all POST /cc/event and all discard the body — if any of them sent this header they would
// consume-and-drop the user's queued command.
describe("watchdogEventHeaders", () => {
  test("carries the per-pairing auth set plus the watchdog role marker", () => {
    const headers = watchdogEventHeaders(cfg(), "on");
    expect(headers["x-cc-pairing"]).toBe("p");
    expect(headers["x-cc-auth"]).toBe("s");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-cc-approvals"]).toBe("on");
    expect(headers["x-cc-role"]).toBe("watchdog");
    expect(typeof headers["x-cc-version"]).toBe("string");
  });

  test("the approvals value is reported verbatim (the worker literal-matches on/off)", () => {
    expect(watchdogEventHeaders(cfg(), "off")["x-cc-approvals"]).toBe("off");
  });

  test("no OTHER /cc/event POSTer in the tree claims the watchdog role", async () => {
    // A grep-as-test: the role must never spread to a caller that discards the response body.
    const roots = ["src/core/hook.ts", "src/core/shared.ts", "src/core/permission.ts", "src/core/codex-remote-input.ts", "src/entries/reset.ts", "src/entries/codex-notify.ts"];
    for (const file of roots) {
      expect(readFileSync(join(import.meta.dir, "..", "..", file), "utf8")).not.toContain("x-cc-role");
    }
  });
});

// --- waiting-session fast beat (command-pickup latency) ---------------------------------------
//
// Pins BOTH cadences: a parked-on-the-user session makes the pairing POST every
// WAITING_HEARTBEAT_AFTER_MS (so a phone tap is picked up in seconds, not minutes), while every
// other session keeps the untouched 5-minute staleness heartbeat.
describe("isWaitingSession", () => {
  test("every attention marker counts as waiting", () => {
    expect(isWaitingSession(rec({ lastEvent: "needsAttention" }))).toBe(true);
    expect(isWaitingSession(rec({ pendingPlanPicker: true }))).toBe(true);
    expect(isWaitingSession(rec({ prio: 1 }))).toBe(true);
  });

  test("an ordinary working / freshly-started session is NOT waiting (zero extra POSTs for it)", () => {
    expect(isWaitingSession(rec({ lastEvent: "working", prio: 0 }))).toBe(false);
    expect(isWaitingSession(rec({ lastEvent: "sessionStart" }))).toBe(false);
    expect(isWaitingSession(rec({}))).toBe(false);
  });

  test("a terminal row is never waiting, whatever else it still carries", () => {
    expect(isWaitingSession(rec({ op: "done", prio: 1 }))).toBe(false);
    expect(isWaitingSession(rec({ lastEvent: "done", pendingPlanPicker: true }))).toBe(false);
  });
});

describe("heartbeatKind (both cadences at once)", () => {
  const waiting = (over: Partial<SessionRecord> = {}): SessionRecord =>
    rec({ ts: 1_000_000, lastEvent: "needsAttention", op: "update", prio: 1, blob: "B", ...over });

  test("a session parked on the user beats every WAITING_HEARTBEAT_AFTER_MS, not every 5 min", () => {
    const now = 1_000_000 + WAITING_HEARTBEAT_AFTER_MS;
    expect(heartbeatKind(waiting(), now, undefined, undefined, false)).toBe("waiting");
    // …and is then throttled on the PAIRING clock until the next interval elapses.
    expect(heartbeatKind(waiting(), now, undefined, now, false)).toBe("none");
    expect(heartbeatKind(waiting(), now + WAITING_HEARTBEAT_AFTER_MS, undefined, now, false)).toBe("waiting");
  });

  test("the pairing fast-beat clock is closed at 5,000 ms", () => {
    expect(WAITING_HEARTBEAT_AFTER_MS).toBe(5_000);
    const lastBeat = 1_000_000;
    const parked = waiting({ ts: lastBeat - 10_000 });
    expect(heartbeatKind(parked, lastBeat + 4_999, undefined, lastBeat, false)).toBe("none");
    expect(heartbeatKind(parked, lastBeat + 5_000, undefined, lastBeat, false)).toBe("waiting");
  });

  test("ONE pairing-wide clock: a second waiting session does not add POSTs in the same interval", () => {
    const now = 1_000_000 + WAITING_HEARTBEAT_AFTER_MS;
    expect(heartbeatKind(waiting(), now, undefined, undefined, false)).toBe("waiting");
    // the sweep records that beat, so every other waiting session sees it and stands down
    expect(heartbeatKind(waiting({ ts: 900_000 }), now, undefined, now, false)).toBe("none");
  });

  test("a NON-waiting session is completely unaffected — still exactly the 5-minute cadence", () => {
    const working = rec({ ts: 1_000_000, lastEvent: "working", op: "update", prio: 0, blob: "B" });
    expect(heartbeatKind(working, 1_000_000 + WAITING_HEARTBEAT_AFTER_MS, undefined, undefined, false)).toBe("none");
    expect(heartbeatKind(working, 1_000_000 + 299_999, undefined, undefined, false)).toBe("none");
    expect(heartbeatKind(working, 1_000_000 + 300_000, undefined, undefined, false)).toBe("stale");
  });

  test("the stale beat wins when both apply, so a long wait still sends only one POST", () => {
    expect(heartbeatKind(waiting(), 1_000_000 + 300_000, undefined, undefined, false)).toBe("stale");
  });

  test("every shouldHeartbeat guardrail holds for the fast beat too", () => {
    const now = 1_000_000 + WAITING_HEARTBEAT_AFTER_MS;
    expect(heartbeatKind(waiting({ op: "done" }), now, undefined, undefined, false)).toBe("none"); // terminal
    expect(heartbeatKind(waiting({ doneAttempts: 1 }), now, undefined, undefined, false)).toBe("none"); // corrective in flight
    expect(heartbeatKind(waiting(), now, undefined, undefined, true)).toBe("none"); // a net owns it this sweep
    expect(heartbeatKind(waiting({ ts: undefined as unknown as number }), now, undefined, undefined, false)).toBe("none");
  });

  test("aggregate POST budget: the fast beat costs ≤12 /min for the WHOLE pairing (limit is 300/min)", () => {
    // Drive a minute of 5-second sweeps with three waiting sessions and count the beats: at most
    // 12 / 300 = 4% of the pairing's POST budget, and only while at least one session is waiting.
    const sessions = [waiting({ ts: 0 }), waiting({ ts: 0 }), waiting({ ts: 0 })];
    let lastWaitingBeat: number | undefined;
    let beats = 0;
    for (let now = 0; now < 60_000; now += 5_000) {
      for (const s of sessions) {
        if (heartbeatKind(s, now, undefined, lastWaitingBeat, false) === "waiting") {
          beats++;
          lastWaitingBeat = now; // what the sweep does on a delivered fast beat
        }
      }
    }
    expect(beats).toBeLessThanOrEqual(12);
    expect(beats).toBeGreaterThan(0);
  });
});
