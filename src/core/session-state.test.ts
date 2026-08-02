import { describe, expect, test } from "bun:test";
import {
  buildStatePlaintext,
  ccOpinion,
  computeSessionState,
  parseCcProcStart,
  parseCcSessionFile,
  stateHoldLive,
  CC_IDLE_DONE_GRACE_MS,
  CC_PROC_START_TOLERANCE_MS,
  CC_STATUS_MAX_AGE_MS,
  SESSION_STATE_STALE_MS,
  STATE_HOLD_MAX_AGE_MS,
} from "./session-state";
import type { CcSessionFile, SessionState, SessionStateInput } from "./session-state";
import { BLOB_FIT_CHARS, sealedBlobChars } from "./shared";
import type { DecisionHold, SessionRecord } from "./shared";

// -------------------------------------------------------------------------------------------------
// THE FIXTURES ARE REAL. Every CC-file value below was copied off this machine on 2026-08-02 (CC
// 2.1.220), because every gate this file tests is a trap that was FOUND in that data rather than
// imagined. The UTC/local `procStart` split in particular is not a hypothetical: it is two renderings
// of one process, observed side by side.
// -------------------------------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const PAIRING = "pairing-abc";
const SESSION = "996bca26-c381-4cf3-acb8-314eb3e8c0a8";

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  pid: 4391, machine: "mac-mini", label: "api-status", ts: NOW,
  op: "update", prio: 0, blob: "sealed-blob", pairingId: PAIRING, ...over,
});

const hold = (over: Partial<DecisionHold> = {}): DecisionHold =>
  ({ blob: "sealed-decision-pending", at: NOW - 6_000, pid: 5555, ...over });

/** The default world: a live pid, no hold, no CC file, current pairing. */
const state = (over: Partial<SessionStateInput> = {}): SessionState | null => computeSessionState({
  sessionId: SESSION, record: rec(), pairingId: PAIRING, pidAlive: true, now: NOW, ...over,
});

// --- CC's own session file ------------------------------------------------------------------------

/** VERBATIM `~/.claude/sessions/4391.json`, 2026-08-02, CC 2.1.220. */
const CC_RAW = '{"pid":4391,"sessionId":"996bca26-c381-4cf3-acb8-314eb3e8c0a8","cwd":"/Users/karrix/api-status",'
  + '"startedAt":1785615095362,"procStart":"Sat Aug  1 20:11:34 2026","version":"2.1.220","peerProtocol":1,'
  + '"kind":"interactive","entrypoint":"cli","name":"api-status-53","nameSource":"derived","status":"idle",'
  + '"updatedAt":1785673169315,"statusUpdatedAt":1785673169315}';

/** What `ps -o lstart= -p 4391` printed for the SAME process at the same moment, on a TZ +08 machine:
 *  `"Sun  2 Aug 04:11:34 2026"`. Parsed the way the probe parses it (local), that is this instant. */
const PS_PROBE = Date.UTC(2026, 7, 1, 20, 11, 34);

const cc = (over: Partial<CcSessionFile> = {}): CcSessionFile => ({
  pid: 4391, sessionId: SESSION, startedAt: NOW - 3_600_000, procStart: "Sat Aug  1 20:11:34 2026",
  entrypoint: "cli", name: "api-status-53", nameSource: "derived",
  status: "idle", statusUpdatedAt: NOW - 1_000, ...over,
});

/** The world with a usable CC file: the probe agrees with the file's own claimed start. */
const withCc = (file: Partial<CcSessionFile>, over: Partial<SessionStateInput> = {}): SessionState | null =>
  state({ cc: cc(file), ccProcStartedAt: (file.startedAt ?? NOW - 3_600_000), ...over });

// REALISTIC CLOCKS for the corroboration tests. Every rule that consults CC needs its status write to be
// LATER than the record's own — which in the field means the record is a little old and CC just wrote.
// Expressing that as a FUTURE statusUpdatedAt would be rejected outright by the freshness gate (and
// rightly: CC and this daemon share one wall clock), so the record is aged instead.
const RECORD_AT = NOW - 30_000;
const CC_AT = NOW - 1_000;
const older = (over: Partial<SessionRecord> = {}): SessionRecord => rec({ ts: RECORD_AT, ...over });

describe("CC session file — parsing", () => {
  test("parses a REAL CC 2.1.220 row field for field", () => {
    expect(parseCcSessionFile(CC_RAW)).toEqual({
      pid: 4391,
      sessionId: SESSION,
      cwd: "/Users/karrix/api-status",
      startedAt: 1_785_615_095_362,
      procStart: "Sat Aug  1 20:11:34 2026",
      version: "2.1.220",
      kind: "interactive",
      entrypoint: "cli",
      name: "api-status-53",
      nameSource: "derived",
      status: "idle",
      updatedAt: 1_785_673_169_315,
      statusUpdatedAt: 1_785_673_169_315,
    });
  });

  test("NO version allow-list: an unrecognised CC version still parses, field by field", () => {
    // The values call (spec open question 1, decided): pinning a major would silently lose the feature on
    // every `claude` upgrade until someone re-tested, which is a worse failure than a per-field degrade.
    const future = parseCcSessionFile(CC_RAW.replace('"2.1.220"', '"9.9.9-canary"'));
    expect(future?.version).toBe("9.9.9-canary");
    expect(future?.status).toBe("idle");
    // …and a row with NO version at all is equally fine.
    expect(parseCcSessionFile('{"pid":1,"sessionId":"s","status":"busy","statusUpdatedAt":2}')?.status).toBe("busy");
  });

  test("per-field shape checks degrade silently: a wrong type drops that field, never the file", () => {
    const bent = parseCcSessionFile(
      '{"pid":4391,"sessionId":"' + SESSION + '","status":7,"statusUpdatedAt":"soon","name":null,"startedAt":true}',
    );
    expect(bent).not.toBeNull();
    expect(bent).not.toHaveProperty("status");
    expect(bent).not.toHaveProperty("statusUpdatedAt");
    expect(bent).not.toHaveProperty("name");
    expect(bent).not.toHaveProperty("startedAt");
    expect(bent!.pid).toBe(4391);
  });

  test("the two JOIN KEYS are the only fields whose absence voids the whole file", () => {
    expect(parseCcSessionFile('{"sessionId":"s","status":"idle"}')).toBeNull();   // no pid
    expect(parseCcSessionFile('{"pid":1,"status":"idle"}')).toBeNull();           // no sessionId
    expect(parseCcSessionFile('{"pid":"1","sessionId":"s"}')).toBeNull();         // pid of the wrong type
    expect(parseCcSessionFile("not json")).toBeNull();
    expect(parseCcSessionFile("[]")).toBeNull();
    expect(parseCcSessionFile("null")).toBeNull();
  });
});

describe("CC session file — TRAP 1: procStart is UTC where ps is LOCAL", () => {
  test("parseCcProcStart reads the file's rendering as UTC, never as local time", () => {
    // TZ-independent by construction: the assertion is against Date.UTC, so a parser that used
    // Date.parse (which reads a bare date string as LOCAL) fails on every machine that is not on UTC.
    expect(parseCcProcStart("Sat Aug  1 20:11:34 2026")).toBe(Date.UTC(2026, 7, 1, 20, 11, 34));
    expect(parseCcProcStart("Wed Jul 29 11:35:12 2026")).toBe(Date.UTC(2026, 6, 29, 11, 35, 12));
    expect(parseCcProcStart("Tue Jul 28 07:14:39 2026")).toBe(Date.UTC(2026, 6, 28, 7, 14, 39));
  });

  test("the two renderings of ONE process do not string-compare — which is why nothing here does", () => {
    // Observed side by side for pid 4391 on a TZ +08 machine. Same process, same instant.
    const fromCcFile = "Sat Aug  1 20:11:34 2026";
    const fromPs = "Sun  2 Aug 04:11:34 2026";
    expect(fromCcFile).not.toBe(fromPs);
    // Parsed to epoch on both sides, they are the same instant — which is the ONLY comparison allowed.
    expect(parseCcProcStart(fromCcFile)).toBe(PS_PROBE);
  });

  test("the join accepts the real file against the real ps probe, and rejects a recycled pid", () => {
    const file = parseCcSessionFile(CC_RAW)!;
    const at = 1_785_673_169_315 + 1_000; // just after the file's own statusUpdatedAt
    // startedAt (1785615095362 = 20:11:35.362Z) sits 1.362 s past the probe (20:11:34Z) — CC writes the
    // file about a second after the fork, which is exactly what the tolerance is sized for.
    expect(ccOpinion(file, { pid: 4391, sessionId: SESSION, procStartedAt: PS_PROBE }, at))
      .toMatchObject({ status: "idle", name: "api-status-53" });
    // A pid whose number was recycled by a later process: same pid, same session id on the stale file,
    // but a start time that is nowhere near. Refused.
    expect(ccOpinion(file, { pid: 4391, sessionId: SESSION, procStartedAt: PS_PROBE + 3_600_000 }, at)).toBeNull();
    // …and the boundary of the tolerance itself.
    const claimed = 1_785_615_095_362;
    expect(ccOpinion(file, { pid: 4391, sessionId: SESSION, procStartedAt: claimed + CC_PROC_START_TOLERANCE_MS }, at))
      .not.toBeNull();
    expect(ccOpinion(file, { pid: 4391, sessionId: SESSION, procStartedAt: claimed + CC_PROC_START_TOLERANCE_MS + 1 }, at))
      .toBeNull();
  });

  test("with no startedAt the join falls back to procStart — still parsed to epoch, never compared as text", () => {
    const file = cc({ startedAt: undefined, procStart: "Sat Aug  1 20:11:34 2026", statusUpdatedAt: NOW });
    expect(ccOpinion(file, { pid: 4391, sessionId: SESSION, procStartedAt: PS_PROBE }, NOW))
      .toMatchObject({ status: "idle" });
    // A `procStart` in a rendering we do not recognise is NOT evidence — it is not guessed at.
    expect(ccOpinion(cc({ startedAt: undefined, procStart: "2026-08-01T20:11:34Z" }),
                     { pid: 4391, sessionId: SESSION, procStartedAt: PS_PROBE }, NOW)).toBeNull();
    expect(parseCcProcStart("Sat Feb 31 10:00:00 2026")).toBeUndefined();  // a date that rolled over
    expect(parseCcProcStart("Sat Xyz  1 20:11:34 2026")).toBeUndefined();
    expect(parseCcProcStart(undefined)).toBeUndefined();
  });

  test("no probe means no opinion: we cannot verify the join, so we do not trust the file", () => {
    expect(ccOpinion(cc({}), { pid: 4391, sessionId: SESSION, procStartedAt: undefined }, NOW)).toBeNull();
  });
});

describe("CC session file — TRAP 2: both join keys, or the file is ignored entirely", () => {
  test("a filename pid that is not the record's pid ignores the WHOLE file", () => {
    expect(ccOpinion(cc({}), { pid: 4392, sessionId: SESSION, procStartedAt: NOW - 3_600_000 }, NOW)).toBeNull();
    expect(ccOpinion(cc({}), { pid: undefined, sessionId: SESSION, procStartedAt: NOW - 3_600_000 }, NOW)).toBeNull();
  });

  test("a sessionId that is not ours ignores the WHOLE file — pid reuse cannot fake a UUID", () => {
    expect(ccOpinion(cc({}), { pid: 4391, sessionId: "some-other-session", procStartedAt: NOW - 3_600_000 }, NOW))
      .toBeNull();
  });
});

describe("CC session file — TRAP 3: `status` may be absent (verified on an sdk-cli row)", () => {
  test("absence is NO OPINION, never idle", () => {
    // A real sdk-cli row carries pid/sessionId/procStart/entrypoint and simply has no `status` key.
    const sdk = cc({ entrypoint: "sdk-cli", status: undefined, statusUpdatedAt: undefined });
    expect(ccOpinion(sdk, { pid: 4391, sessionId: SESSION, procStartedAt: NOW - 3_600_000 }, NOW)).toBeNull();
    // …and the row keeps behaving exactly as it does with no CC file at all.
    expect(withCc({ entrypoint: "sdk-cli", status: undefined, statusUpdatedAt: undefined },
                  { record: rec({ op: "done" }) })).toMatchObject({ state: "done", why: "done" });
  });

  test("a status value that is neither literal is no opinion either", () => {
    expect(ccOpinion(cc({ status: "thinking" }), { pid: 4391, sessionId: SESSION, procStartedAt: NOW - 3_600_000 }, NOW))
      .toBeNull();
    expect(ccOpinion(cc({ status: "" }), { pid: 4391, sessionId: SESSION, procStartedAt: NOW - 3_600_000 }, NOW))
      .toBeNull();
  });
});

describe("CC session file — TRAP 4: statusUpdatedAt goes stale on LIVE processes", () => {
  test("a live pid whose last status write was three days ago is not evidence about now", () => {
    // Verified in the field: `~/.claude/sessions/23718.json` on a running pid, statusUpdatedAt 3 days old.
    const threeDays = cc({ status: "idle", statusUpdatedAt: NOW - 3 * 86_400_000 });
    expect(ccOpinion(threeDays, { pid: 4391, sessionId: SESSION, procStartedAt: NOW - 3_600_000 }, NOW)).toBeNull();
    // The boundary itself.
    const edge = { pid: 4391, sessionId: SESSION, procStartedAt: NOW - 3_600_000 };
    expect(ccOpinion(cc({ statusUpdatedAt: NOW - CC_STATUS_MAX_AGE_MS + 1 }), edge, NOW)).not.toBeNull();
    expect(ccOpinion(cc({ statusUpdatedAt: NOW - CC_STATUS_MAX_AGE_MS }), edge, NOW)).toBeNull();
    // An implausibly future-dated write is equally unusable.
    expect(ccOpinion(cc({ statusUpdatedAt: NOW + 60_000 }), edge, NOW)).toBeNull();
    expect(ccOpinion(cc({ statusUpdatedAt: undefined }), edge, NOW)).toBeNull();
  });
});

describe("computeSessionState — the ranking table", () => {
  test("RANK 1 · ended · why:end — a delivered op:end", () => {
    expect(state({ record: rec({ op: "end" }) }))
      .toMatchObject({ state: "ended", terminal: true, why: "end", blob: { kind: "sealed", value: "sealed-blob" } });
  });

  test("RANK 1 · ended · why:end — the watchdog's own PRE-DELIVERY corrective", () => {
    // The asymmetry v2 exists to spend: the worker learns this only after a successful POST.
    expect(state({ correctives: { ended: true } })).toMatchObject({ state: "ended", terminal: true, why: "end" });
  });

  test("RANK 1 · ended · why:stale — the record aged past the 24 h abandonment cap", () => {
    expect(state({ record: rec({ ts: NOW - SESSION_STATE_STALE_MS - 1 }) }))
      .toMatchObject({ state: "ended", terminal: true, why: "stale" });
    expect(state({ record: rec({ ts: NOW - SESSION_STATE_STALE_MS }) })).toMatchObject({ state: "working" });
  });

  test("RANK 1 · ended · why:reap — the session's pid is gone", () => {
    expect(state({ pidAlive: false })).toMatchObject({ state: "ended", terminal: true, why: "reap" });
  });

  test("RANK 1 · ended · why:reap — the record itself is gone, and the caller re-serves its last blob", () => {
    expect(computeSessionState({ sessionId: SESSION, record: null, pairingId: PAIRING, pidAlive: false, now: NOW }))
      .toEqual({ state: "ended", terminal: true, ts: NOW, why: "reap", blob: { kind: "last" }, agent: "claude" });
  });

  test("RANK 2 · decisionPending · why:hold — the card's blob is the HOLD's blob, verbatim", () => {
    expect(state({ record: rec({ prio: 1 }), hold: hold(), holdPidAlive: true })).toEqual({
      state: "decisionPending", terminal: false, ts: NOW, why: "hold",
      blob: { kind: "sealed", value: "sealed-decision-pending" }, agent: "claude",
    });
  });

  test("RANK 3 · done · why:done — the record's own terminal state", () => {
    expect(state({ record: rec({ op: "done" }) })).toMatchObject({ state: "done", terminal: false, why: "done" });
    expect(state({ record: rec({ op: "update", lastEvent: "done" }) })).toMatchObject({ state: "done", why: "done" });
    expect(state({ correctives: { done: true } })).toMatchObject({ state: "done", why: "done" });
  });

  test("RANK 4 · needsAttention · why:attn — prio 1 with no live hold", () => {
    expect(state({ record: rec({ prio: 1 }) }))
      .toMatchObject({ state: "needsAttention", why: "attn", blob: { kind: "sealed", value: "sealed-blob" } });
  });

  test("RANK 5 · working · why:work — anything else with a live pid", () => {
    expect(state()).toEqual({
      state: "working", terminal: false, ts: NOW, why: "work",
      blob: { kind: "sealed", value: "sealed-blob" }, agent: "claude",
    });
  });

  test("the rungs are ordered: each higher input beats the ones below it", () => {
    // A record carrying EVERY lower-rung signal at once, walked down one rung at a time.
    const loaded = rec({ op: "end", prio: 1 });
    expect(state({ record: loaded, hold: hold(), holdPidAlive: true })).toMatchObject({ why: "end" });
    expect(state({ record: rec({ op: "done", prio: 1 }), hold: hold(), holdPidAlive: true }))
      .toMatchObject({ why: "done" });
    expect(state({ record: rec({ prio: 1 }), hold: hold(), holdPidAlive: true })).toMatchObject({ why: "hold" });
    expect(state({ record: rec({ prio: 1 }) })).toMatchObject({ why: "attn" });
    expect(state({ record: rec({ prio: 0 }) })).toMatchObject({ why: "work" });
  });

  test("startedAt and agent ride along, and `why` never exceeds 16 characters", () => {
    const s = state({ record: rec({ agent: "codex", sessionStartedAt: 1_700_000_000_000 }) })!;
    expect(s.agent).toBe("codex");
    expect(s.startedAt).toBe(1_700_000_000_000);
    for (const why of ["reap", "stale", "end", "hold", "attn", "done", "done+cc", "done/cx", "work", "work+cc", "work/cx"]) {
      expect(why.length).toBeLessThanOrEqual(16);
    }
  });
});

describe("computeSessionState — attentionKind, the clear question discriminator", () => {
  // It rides the ENVELOPE on the worker wire and on v1 `frames`, and the phone's answer flows key on it,
  // so v2 carries it too rather than making the phone infer "question" from blob contents.
  test("it rides the two rungs the user can actually answer", () => {
    expect(state({ record: rec({ prio: 1, attentionKind: "userInput" }) }))
      .toMatchObject({ state: "needsAttention", why: "attn", attentionKind: "userInput" });
    expect(state({ record: rec({ prio: 1, attentionKind: "userInput" }), hold: hold(), holdPidAlive: true }))
      .toMatchObject({ state: "decisionPending", why: "hold", attentionKind: "userInput" });
    // A held question whose record has NOT been rewritten as prio:1 yet still carries it — v1's hold
    // branch does the same, because the card IS the question.
    expect(state({ record: rec({ prio: 0, attentionKind: "userInput" }), hold: hold(), holdPidAlive: true }))
      .toMatchObject({ state: "decisionPending", attentionKind: "userInput" });
  });

  test("a marker the watchdog's nets carried forward can never relabel a done/working/ended row", () => {
    // Those nets rewrite records by spreading `...record`, so the marker outlives its episode.
    for (const over of [
      { op: "done" as const, prio: 0 as const },
      { prio: 0 as const },
      { op: "end" as const },
    ]) {
      const s = state({ record: rec({ ...over, attentionKind: "userInput" }) })!;
      expect(s).not.toHaveProperty("attentionKind");
    }
    expect(state({ record: rec({ prio: 1, attentionKind: "userInput" }), pidAlive: false }))
      .not.toHaveProperty("attentionKind");
  });

  test("a record with no marker at all simply has none — the key is omitted, never emitted empty", () => {
    expect(state({ record: rec({ prio: 1 }) })).not.toHaveProperty("attentionKind");
    expect(state({ record: rec({ prio: 1, attentionKind: undefined }) })).not.toHaveProperty("attentionKind");
  });
});

describe("computeSessionState — the refusals", () => {
  test("no blob, and another pairing, are the two things there is nothing honest to say about", () => {
    expect(state({ record: rec({ blob: undefined }) })).toBeNull();
    expect(state({ record: rec({ blob: "" }) })).toBeNull();
    expect(state({ record: rec({ pairingId: "pairing-old" }) })).toBeNull();
    expect(state({ record: rec({ pairingId: undefined }) })).toBeNull();
    expect(state({ pairingId: undefined })).toBeNull();
  });

  test("v1's THIRD refusal is gone: a record with no `ts` is stamped `now`, not dropped", () => {
    // `ts` stopped being an ordering contract, so it stopped being a reason to refuse a row.
    expect(state({ record: rec({ ts: undefined as unknown as number }) }))
      .toMatchObject({ state: "working", why: "work", ts: NOW });
  });
});

describe("computeSessionState — a LIVE hold outranks a prio:0 record write", () => {
  // THE DELIBERATE DIVERGENCE from the worker (and from v1's clone of it). The worker drops only the
  // prio:1 restatement and lets a parallel tool's PostToolUse take the row back mid-hold, which is why a
  // row can go green while the user is still looking at an Allow/Deny card. The worker cannot do better —
  // it sees one event at a time. The Mac holds both facts at once, and a live holding hook IS the
  // statement that the prompt is still open.
  test("a prio:0 write landing DURING the hold no longer steals the card", () => {
    expect(state({ record: rec({ prio: 0, ts: NOW }), hold: hold({ at: NOW - 6_000 }), holdPidAlive: true }))
      .toMatchObject({ state: "decisionPending", why: "hold" });
  });

  test("only a TERMINAL record state takes the card down early", () => {
    const live = { hold: hold(), holdPidAlive: true };
    expect(state({ record: rec({ op: "done", prio: 0 }), ...live })).toMatchObject({ state: "done", why: "done" });
    expect(state({ record: rec({ op: "end" }), ...live })).toMatchObject({ state: "ended", why: "end" });
    expect(state({ ...live, pidAlive: false })).toMatchObject({ state: "ended", why: "reap" });
  });

  test("the hold's own releases are unchanged: dead holder, TTL, and a marker with nothing in it", () => {
    const held = rec({ prio: 1 });
    expect(state({ record: held, hold: hold(), holdPidAlive: false })).toMatchObject({ why: "attn" });
    expect(state({ record: held, hold: hold({ at: NOW - STATE_HOLD_MAX_AGE_MS - 1 }), holdPidAlive: true }))
      .toMatchObject({ why: "attn" });
    expect(state({ record: held, hold: hold({ blob: "" }), holdPidAlive: true })).toMatchObject({ why: "attn" });
    expect(state({ record: held, hold: null, holdPidAlive: true })).toMatchObject({ why: "attn" });
    expect(state({ record: held, hold: hold({ at: Number.NaN }), holdPidAlive: true })).toMatchObject({ why: "attn" });
    expect(state({ record: held, hold: hold({ pid: undefined as unknown as number }), holdPidAlive: true }))
      .toMatchObject({ why: "attn" });
  });

  test("stateHoldLive is the pure gate behind all of that", () => {
    expect(stateHoldLive(hold(), true, NOW)).toBe(true);
    expect(stateHoldLive(hold(), false, NOW)).toBe(false);
    expect(stateHoldLive(hold(), undefined, NOW)).toBe(false);
    expect(stateHoldLive(null, true, NOW)).toBe(false);
    expect(stateHoldLive(hold({ at: NOW }), true, NOW + STATE_HOLD_MAX_AGE_MS)).toBe(true);
    expect(stateHoldLive(hold({ at: NOW }), true, NOW + STATE_HOLD_MAX_AGE_MS + 1)).toBe(false);
  });
});

describe("computeSessionState — what CC's file may and may not do (invariant 19)", () => {
  test("it HOLDS BACK a premature done: record says done, CC says busy and said so LATER", () => {
    // NOM-47 #2 without adding a hook: a Stop fires during a fan-out, the record goes done, and CC — which
    // is watching the actual process — is still busy. The record's own blob says "done", so the Mac has to
    // AUTHOR a working plaintext; serving the record's ciphertext would render the wrong word.
    const s = withCc({ status: "busy", statusUpdatedAt: CC_AT }, { record: older({ op: "done" }) })!;
    expect(s.state).toBe("working");
    expect(s.why).toBe("work+cc");
    expect(s.blob.kind).toBe("plain");
    expect((s.blob as { value: Record<string, unknown> }).value.status).toBe("working");
  });

  test("a busy that is OLDER than the record's own write does not hold anything back", () => {
    expect(withCc({ status: "busy", statusUpdatedAt: NOW - 1 }, { record: rec({ op: "done" }) }))
      .toMatchObject({ state: "done", why: "done" });
  });

  test("a status write dated in the FUTURE is unusable — CC and this daemon share one wall clock", () => {
    expect(withCc({ status: "busy", statusUpdatedAt: NOW + 60_000 }, { record: older({ op: "done" }) }))
      .toMatchObject({ state: "done", why: "done" });
  });

  test("it ADVANCES a stale working to done — the missed-done and Esc-interrupt cases", () => {
    const s = withCc({ status: "idle", statusUpdatedAt: RECORD_AT + CC_IDLE_DONE_GRACE_MS + 1 },
                     { record: older() })!;
    expect(s).toMatchObject({ state: "done", why: "done+cc", terminal: false });
    expect(s.blob.kind).toBe("plain");
    expect((s.blob as { value: Record<string, unknown> }).value.status).toBe("done");
    // Inside the grace it is still working: a CC write landing microseconds before the hook's record
    // write must not delete the work that just started.
    expect(withCc({ status: "idle", statusUpdatedAt: RECORD_AT + CC_IDLE_DONE_GRACE_MS }, { record: older() }))
      .toMatchObject({ state: "working", why: "work" });
  });

  test("it CORROBORATES a record's own done (why gains +cc) without changing the blob", () => {
    const s = withCc({ status: "idle", statusUpdatedAt: CC_AT }, { record: older({ op: "done" }) })!;
    expect(s).toMatchObject({ state: "done", why: "done+cc" });
    expect(s.blob).toEqual({ kind: "sealed", value: "sealed-blob" });
  });

  test("it NEVER creates a row", () => {
    expect(computeSessionState({
      sessionId: SESSION, record: null, pairingId: PAIRING, pidAlive: true,
      cc: cc({ status: "busy", statusUpdatedAt: CC_AT }), ccProcStartedAt: NOW - 3_600_000, now: NOW,
    })).toMatchObject({ state: "ended", why: "reap" });
  });

  test("it NEVER overrides a live hold, and NEVER contributes to rank 1 or 2", () => {
    const live = { hold: hold(), holdPidAlive: true };
    expect(withCc({ status: "busy", statusUpdatedAt: CC_AT }, { record: older({ prio: 1 }), ...live }))
      .toMatchObject({ state: "decisionPending", why: "hold" });
    expect(withCc({ status: "idle", statusUpdatedAt: CC_AT }, { record: older({ prio: 1 }), ...live }))
      .toMatchObject({ state: "decisionPending", why: "hold" });
    // Rank 1 is decided before CC is even consulted.
    expect(withCc({ status: "busy", statusUpdatedAt: CC_AT }, { record: older(), pidAlive: false }))
      .toMatchObject({ state: "ended", why: "reap" });
    expect(withCc({ status: "busy", statusUpdatedAt: CC_AT }, { record: older({ op: "end" }) }))
      .toMatchObject({ state: "ended", why: "end" });
  });

  test("it NEVER clears a needsAttention — a prompt the user is looking at reads `idle` to CC", () => {
    expect(withCc({ status: "idle", statusUpdatedAt: CC_AT }, { record: older({ prio: 1 }) }))
      .toMatchObject({ state: "needsAttention", why: "attn" });
    expect(withCc({ status: "idle", statusUpdatedAt: CC_AT }, { record: older({ lastEvent: "needsAttention" }) }))
      .toMatchObject({ state: "working", why: "work" });
  });

  test("every rule degrades to today's behaviour when the file is absent or unusable", () => {
    const working = older();
    const done = older({ op: "done" });
    for (const over of [
      {},                                                              // no CC input at all
      { cc: null },
      { cc: cc({ statusUpdatedAt: CC_AT }) },                          // no probe ⇒ unverifiable join
      { cc: cc({ status: undefined }), ccProcStartedAt: NOW - 3_600_000 },
      { cc: cc({ statusUpdatedAt: NOW - 3 * 86_400_000 }), ccProcStartedAt: NOW - 3_600_000 },
      { cc: cc({ sessionId: "other", statusUpdatedAt: CC_AT }), ccProcStartedAt: NOW - 3_600_000 },
      { cc: cc({ pid: 9999, statusUpdatedAt: CC_AT }), ccProcStartedAt: NOW - 3_600_000 },
    ] as Partial<SessionStateInput>[]) {
      expect(state({ record: working, ...over })).toMatchObject({ state: "working", why: "work" });
      expect(state({ record: done, ...over })).toMatchObject({ state: "done", why: "done" });
    }
  });

  test("CC's derived name is the fallback title, and only when the record has none", () => {
    const idle = { status: "idle" as const, statusUpdatedAt: RECORD_AT + CC_IDLE_DONE_GRACE_MS + 1 };
    const noTitle = withCc(idle, { record: older({ title: undefined }) })!;
    expect((noTitle.blob as { value: Record<string, unknown> }).value.title).toBe("api-status-53");
    const titled = withCc(idle, { record: older({ title: "Fix the LAN feed" }) })!;
    expect((titled.blob as { value: Record<string, unknown> }).value.title).toBe("Fix the LAN feed");
    // `nameSource` other than "derived" is not a title we may borrow.
    const raw = withCc({ ...idle, nameSource: "user" }, { record: older({ title: undefined }) })!;
    expect((raw.blob as { value: Record<string, unknown> }).value.title).toBe("");
  });
});

describe("computeSessionState — Codex divergence is VISIBLE, not silent", () => {
  // Spec open question 2, decided: Claude rows get v2 fidelity, Codex rows keep v1 fidelity (there is no
  // CC-equivalent for Codex), and the user can READ which is which instead of being told a uniform story
  // the Codex half cannot back up.
  test("a Codex row's rank-3/5 `why` carries the /cx suffix", () => {
    expect(state({ record: rec({ agent: "codex" }) })).toMatchObject({ state: "working", why: "work/cx" });
    expect(state({ record: rec({ agent: "codex", op: "done" }) })).toMatchObject({ state: "done", why: "done/cx" });
  });

  test("a CC file is never consulted for a Codex row, even when one happens to sit at that pid", () => {
    expect(withCc({ status: "busy", statusUpdatedAt: CC_AT }, { record: older({ agent: "codex", op: "done" }) }))
      .toMatchObject({ state: "done", why: "done/cx" });
    expect(withCc({ status: "idle", statusUpdatedAt: CC_AT }, { record: older({ agent: "codex" }) }))
      .toMatchObject({ state: "working", why: "work/cx" });
  });

  test("a PROVISIONAL row stays record-only: its pid is an immortal app-server, not a session", () => {
    expect(withCc({ status: "busy", statusUpdatedAt: CC_AT }, { record: older({ provisional: true, op: "done" }) }))
      .toMatchObject({ state: "done", why: "done" });
    expect(withCc({ status: "idle", statusUpdatedAt: CC_AT }, { record: older({ provisional: true }) }))
      .toMatchObject({ state: "working", why: "work" });
  });

  test("rank 1, 2 and 4 carry no suffix on either agent — CC never reaches those rungs anyway", () => {
    for (const agent of ["claude", "codex"] as const) {
      expect(state({ record: rec({ agent, op: "end" }) })).toMatchObject({ why: "end" });
      expect(state({ record: rec({ agent }), pidAlive: false })).toMatchObject({ why: "reap" });
      expect(state({ record: rec({ agent, prio: 1 }), hold: hold(), holdPidAlive: true })).toMatchObject({ why: "hold" });
      expect(state({ record: rec({ agent, prio: 1 }) })).toMatchObject({ why: "attn" });
    }
  });
});

describe("buildStatePlaintext — the Mac-authored blob (invariants 22 and 23)", () => {
  /** The 16 CCBlobPlaintext keys, from api-statusTests/ClaudeCodeActivityE2ETests.swift:236. The Mac's
   *  authored blob is a frame source now, so it gets the same key-set guard the phone's local frame has. */
  const BLOB_KEYS = new Set([
    "status", "detail", "title", "machine", "label", "agent", "turnStartedAt", "model",
    "permissionSummary", "permissionRequestId", "at", "permissionToolName", "permissionDetail",
    "permissionDetailOmitted", "permissionQuestions", "plan",
  ]);

  test("every key it emits is one of the 16 the phone renders — nothing invented, nothing stray", () => {
    const full = buildStatePlaintext(
      rec({ title: "Fix the LAN feed", model: "claude-fable-5", turnStartedAt: 1_700_000_000, agent: "codex" }),
      "done", NOW,
    );
    for (const key of Object.keys(full)) expect(BLOB_KEYS.has(key) || key === "dbg").toBe(true);
    expect(full).toMatchObject({
      status: "done", title: "Fix the LAN feed", machine: "mac-mini", label: "api-status",
      agent: "codex", turnStartedAt: 1_700_000_000, model: "claude-fable-5", at: Math.floor(NOW / 1000),
    });
  });

  test("it mirrors buildWorkingEnvelope/buildDoneEnvelope's shape, so a handoff cannot reflow the text", () => {
    // Claude omits `agent` (the historical default) and carries no codex dbg tail; optional keys are
    // OMITTED, never emitted empty — a rebuilt title:"" once regressed the phone to the folder label.
    const claude = buildStatePlaintext(rec({ title: "t" }), "working", NOW);
    expect(Object.keys(claude)).toEqual(["status", "title", "machine", "label", "at"]);
    expect(claude).not.toHaveProperty("model");
    expect(claude).not.toHaveProperty("turnStartedAt");
    // A corrupt record coerces to "" rather than dropping the key.
    const bare = buildStatePlaintext(
      { pid: 1, ts: NOW } as unknown as SessionRecord, "done", NOW,
    );
    expect(bare).toMatchObject({ title: "", machine: "", label: "" });
  });

  test("BLOB_FIT_CHARS still applies on a leg with no worker in it (invariant 22)", () => {
    const bytes = (value: Record<string, unknown>): number => new TextEncoder().encode(JSON.stringify(value)).length;
    const small = buildStatePlaintext(rec({ agent: "codex", title: "short" }), "done", NOW);
    expect(sealedBlobChars(bytes(small))).toBeLessThanOrEqual(BLOB_FIT_CHARS);
    expect(small).toHaveProperty("dbg");   // the codex breadcrumb rides when there is room
    // Under pressure `dbg` is the FIRST sacrifice, exactly as appendFittedPlanAndDebug specifies.
    const crowded = buildStatePlaintext(rec({ agent: "codex", title: "t".repeat(2_100) }), "done", NOW);
    expect(crowded).not.toHaveProperty("dbg");
    expect(sealedBlobChars(bytes(crowded))).toBeLessThanOrEqual(BLOB_FIT_CHARS);
  });
});
