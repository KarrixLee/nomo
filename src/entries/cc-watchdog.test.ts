import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptBlob } from "../core/crypto";
import type { SessionRecord } from "../core/shared";
import { GONE_STRIKE_LIMIT, readGoneStrikes, recordGoneStrike, resetGoneStrikes } from "../core/shared";
import {
  buildDoneEnvelope, buildEndEnvelope, buildHeartbeatEnvelope, buildNeedsAttentionEnvelope, buildProvisionalBlob,
  buildProvisionalEnvelope, buildProvisionalRecord, buildStartEnvelope, classifySession, codexLastTurnEvent,
  codexTailPendingApproval, discoverLiveSessions, goneStrikeShouldTeardown, hasInterruptMarker, IDLE_GRACE_MS,
  lastTurnLine, PAIRING_TTL_MS, pendingPairingExpired, postOutcomeForStatus, provisionalsCoveredByReal,
  reconcileProvisionalsSweep, shouldHeartbeat, shouldIdleProvisionalCheck, shouldInterruptCheck,
  shouldPendingApprovalCheck, tailShowsInterrupt,
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

  test("a stale (>24h) file → delete without POSTing (caps retries), regardless of liveness", () => {
    const now = rec().ts + 86_400_000 + 1;
    expect(classifySession(rec(), now, dead)).toBe("delete");
    expect(classifySession(rec(), now, alive)).toBe("delete");
  });

  test("the decision is driven purely by the injected predicate (no real process probed)", () => {
    const seen: number[] = [];
    classifySession(rec({ pid: 777 }), rec().ts, (p) => { seen.push(p); return false; });
    expect(seen).toEqual([777]);
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
