import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptBlob } from "../core/crypto";
import type { SessionRecord } from "../core/shared";
import { GONE_STRIKE_LIMIT, readGoneStrikes, recordGoneStrike, resetGoneStrikes } from "../core/shared";
import {
  buildDoneEnvelope, buildEndEnvelope, buildHeartbeatEnvelope, buildNeedsAttentionEnvelope, buildProvisionalBlob,
  buildProvisionalEnvelope, buildProvisionalRecord, buildStartEnvelope, buildTitleRepairEnvelope, classifySession,
  claudeTailPendingApproval, codexLastTurnEvent, codexTailPendingApproval, correctIdleClaude, correctInterrupt,
  correctPendingApproval, discoverLiveSessions, goneStrikeShouldTeardown,
  hasInterruptMarker, IDLE_GRACE_MS, isClaudeIdleReapEligible, isRetireEligible, lastTurnLine, PAIRING_TTL_MS, pendingPairingExpired,
  postOutcomeForStatus, provisionalsCoveredByReal, reconcileProvisionalsSweep, retireDoneStale, shouldHeartbeat, shouldIdleProvisionalCheck,
  shouldInterruptCheck, shouldPendingApprovalCheck, shouldRepairTitle, tailShowsInterrupt, titleRepairedRecord,
} from "./cc-watchdog";
import type { PostOutcome, RecordEntry } from "./cc-watchdog";
import { claudeAdapter, codexAdapter } from "../core/adapter";
import type { AgentAdapter, DiscoveredSession } from "../core/adapter";
import type { Config, PendingConfig } from "../core/shared";

const KEY = new Uint8Array(32).fill(9);

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  pid: 4242, machine: "mac", label: "proj", ts: 1_000_000, ...over,
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
    expect(await decryptBlob(KEY, blob)).toEqual({ status: "working", title: "api-status", machine: "Mac", label: "api-status", agent: "codex" });
  });
  test("an IDLE discovery decrypts to status 'done' — an idle REPL is never advertised 'Running'", async () => {
    const blob = await buildProvisionalBlob(disc({ idle: true }), "Mac", { agent: "codex" }, KEY);
    expect(await decryptBlob(KEY, blob)).toEqual({ status: "done", title: "api-status", machine: "Mac", label: "api-status", agent: "codex" });
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
  test("claude-style omits the agent field (empty blobAgentFields)", () => {
    expect(buildProvisionalRecord(disc(), "Mac", "BLOB", {}, 1)).not.toHaveProperty("agent");
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
describe("isRetireEligible (a DONE Claude session past the 1 h retire horizon)", () => {
  const RETIRE_MS = 3_600_000; // must mirror RETIRE_AFTER_MS in cc-watchdog.ts
  const now = 100_000_000;

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

  test("codex and provisional rows are left to their own machinery (discovery would re-surface them)", () => {
    expect(isRetireEligible(rec({ agent: "codex", op: "done", lastEvent: "done", ts: now - RETIRE_MS * 5 }), now)).toBe(false);
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
  const RETIRE_MS = 3_600_000;
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
