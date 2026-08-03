import { describe, expect, test } from "bun:test";
import { decryptBlob, encryptBlob } from "./crypto";
import { codexAnswersFromPhone, startCodexRemoteInput } from "./codex-remote-input";
import type { CodexRemoteInputDeps } from "./codex-remote-input";
import { createLanAnswerStore, LAN_ANSWER_TTL_MS } from "./lan-listener";
import type { LanAnswerStore } from "./lan-listener";
import type { CodexUserInputRequest } from "./codex-app-server-client";
import {
  buildPermissionQuestions, capPermissionWireText, PERMISSION_QUESTION_LABEL_MAX,
} from "./permission";
import type { Config, SessionRecord } from "./shared";

const key = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
const config: Config = {
  url: "https://relay.example",
  pairingId: "pair-1",
  pcSecret: "pc-secret",
  e2eKey: key,
  machineName: "Studio",
};
const record: SessionRecord = {
  pid: 123,
  machine: "Studio",
  label: "api-status",
  ts: 1_000,
  agent: "codex",
  title: "Plan remote input",
  model: "gpt-5.6-sol",
  turnStartedAt: 900,
  sessionStartedAt: 800_000,
};

function request(over: Partial<CodexUserInputRequest> = {}): CodexUserInputRequest {
  return {
    identity: {
      connectionEpoch: 1,
      requestId: "rpc-7",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
    },
    questions: [{
      id: "scope",
      header: "Scope",
      question: "How much should I change?",
      isOther: false,
      isSecret: false,
      options: [
        { label: "Fast", description: "Smallest safe change" },
        { label: "Thorough", description: "Include hardening" },
      ],
    }],
    autoResolutionMs: null,
    receivedAtMs: 1_000,
    ...over,
  };
}

describe("codexAnswersFromPhone", () => {
  test("maps positional phone labels to Codex question ids", () => {
    expect(codexAnswersFromPhone(request(), ["Thorough"]))
      .toEqual({ scope: ["Thorough"] });
  });

  test("re-expands a capped display label only when the original is unambiguous", () => {
    const label = "A".repeat(80);
    const req = request({ questions: [{ ...request().questions[0], options: [{ label, description: "" }] }] });
    expect(codexAnswersFromPhone(req, [`${"A".repeat(59)}…`])).toEqual({ scope: [label] });

    const ambiguous = request({ questions: [{
      ...request().questions[0],
      options: [
        { label: `${"A".repeat(70)}1`, description: "" },
        { label: `${"A".repeat(70)}2`, description: "" },
      ],
    }] });
    expect(codexAnswersFromPhone(ambiguous, [`${"A".repeat(59)}…`])).toBeUndefined();
  });

  test("round-trips an astral label through the exact phone-frame cap", () => {
    const label = "😀".repeat(80);
    const shown = buildPermissionQuestions({
      questions: [{ question: "Emoji?", options: [{ label }] }],
    })[0].o[0];
    const req = request({
      questions: [{ ...request().questions[0], options: [{ label, description: "" }] }],
    });

    expect(shown).toBe(`${"😀".repeat(59)}…`);
    expect(codexAnswersFromPhone(req, [shown])).toEqual({ scope: [label] });
  });

  test("rejects a collision with the actual displayed astral label", () => {
    const label = `x${"😀".repeat(80)}`;
    const shown = capPermissionWireText(label, PERMISSION_QUESTION_LABEL_MAX);
    const req = request({ questions: [{
      ...request().questions[0],
      options: [{ label, description: "" }, { label: shown, description: "" }],
    }] });

    expect(codexAnswersFromPhone(req, [shown])).toBeUndefined();
  });

  test("rejects partial, forged, or unrenderable answers", () => {
    expect(codexAnswersFromPhone(request(), [])).toBeUndefined();
    expect(codexAnswersFromPhone(request(), ["Other"])).toBeUndefined();
    expect(codexAnswersFromPhone(request(), [""])).toBeUndefined();
  });
});

describe("startCodexRemoteInput", () => {
  test("mirrors a granted Codex question into the local hold marker and settles it on exit", async () => {
    const answerBlob = await encryptBlob(key, {
      requestId: "relay-hold",
      decision: "answer",
      answers: ["Fast"],
    });
    const lifecycle: string[] = [];
    let marker: unknown;
    let settled: Partial<SessionRecord> | undefined;
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: (async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/cc/decision")) return Response.json({ hold: true });
        expect(lifecycle).toEqual(["write"]); // marker precedes the first poll that can deliver an answer
        return Response.json({ status: "answered", answerBlob });
      }) as typeof fetch,
      readRecordFn: async () => record,
      randomUUID: () => "relay-hold",
      now: () => 1_234_567,
      localApprovalsStateFn: async () => "on",
      sleep: async () => {},
      answerAppServer: async () => "sent",
      interruptAppServer: async () => "sent",
      holdPid: 7708,
      writeHoldFn: async (_sessionId, hold) => {
        lifecycle.push("write");
        marker = hold;
      },
      clearHoldFn: async (sessionId, pid, beforeUnlink) => {
        lifecycle.push(`clear:${sessionId}:${pid}`);
        await beforeUnlink?.();
        return true;
      },
      settleHoldRecordFn: async (_sessionId, patch) => {
        lifecycle.push("settle");
        settled = patch;
      },
    });

    expect(await handle.completion).toBe("answered");
    expect(marker).toMatchObject({ at: 1_234_567, pid: 7708 });
    expect((await decryptBlob(key, (marker as { blob: string }).blob) as Record<string, unknown>).status)
      .toBe("decisionPending");
    expect(lifecycle).toEqual(["write", "clear:thread-1:7708", "settle"]);
    expect(settled).toMatchObject({ op: "update", prio: 0, lastEvent: "working", attentionKind: undefined });
    expect((await decryptBlob(key, settled!.blob as string) as Record<string, unknown>).status).toBe("working");
  });

  test("posts an E2E question frame, polls the phone, and answers app-server", async () => {
    const answerBlob = await encryptBlob(key, {
      requestId: "relay-1",
      decision: "answer",
      answers: ["Thorough"],
    });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/v1/cc/decision")) return Response.json({ hold: true });
      return Response.json({ status: "answered", answerBlob });
    };
    const appAnswers: unknown[] = [];
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: fetchFn as typeof fetch,
      readRecordFn: async () => record,
      randomUUID: () => "relay-1",
      now: () => 1_234_567,
      localApprovalsStateFn: async () => "on",
      sleep: async () => {},
      answerAppServer: async (answers) => { appAnswers.push(answers); return "sent"; },
      interruptAppServer: async () => "sent",
    });

    expect(await handle.completion).toBe("answered");
    expect(appAnswers).toEqual([{ scope: ["Thorough"] }]);
    const posted = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(posted).toMatchObject({
      v: 2, sessionId: "thread-1", requestId: "relay-1", op: "update", prio: 1,
      attentionKind: "userInput", startedAt: 800_000,
    });
    const prompt = await decryptBlob(key, posted.blob as string) as Record<string, unknown>;
    expect(prompt).toMatchObject({
      status: "decisionPending",
      agent: "codex",
      permissionRequestId: "relay-1",
      permissionToolName: "request_user_input",
      permissionQuestions: [{
        q: "How much should I change?", h: "Scope", o: ["Fast", "Thorough"],
        d: ["Smallest safe change", "Include hardening"],
      }],
    });
    const fallback = await decryptBlob(key, posted.fallbackBlob as string) as Record<string, unknown>;
    expect(fallback.status).toBe("needsAttention");
    expect(fallback).not.toHaveProperty("permissionQuestions");
  });

  test("description pressure sheds d and still relays a working bare-label picker", async () => {
    const questions = Array.from({ length: 3 }, (_, index) => ({
      ...request().questions[0],
      id: `scope-${index}`,
      header: `Scope ${index}`,
      question: `How much should I change in area ${index}?`,
      options: Array.from({ length: 8 }, (_, option) => ({
        label: `Choice ${option}`,
        description: "d".repeat(300),
      })),
    }));
    const answerBlob = await encryptBlob(key, {
      requestId: "relay-budget", decision: "answer", answers: ["Choice 0", "Choice 0", "Choice 0"],
    });
    let posted: Record<string, unknown> | undefined;
    const appAnswers: unknown[] = [];
    const handle = startCodexRemoteInput(request({ questions }), {
      config,
      fetchFn: (async (input, init) => {
        if (String(input).endsWith("/v1/cc/decision")) {
          posted = JSON.parse(String(init?.body));
          return Response.json({ hold: true });
        }
        return Response.json({ status: "answered", answerBlob });
      }) as typeof fetch,
      readRecordFn: async () => record,
      randomUUID: () => "relay-budget",
      localApprovalsStateFn: async () => "on",
      sleep: async () => {},
      answerAppServer: async (answers) => { appAnswers.push(answers); return "sent"; },
      interruptAppServer: async () => "sent",
    });

    expect(await handle.completion).toBe("answered");
    expect(appAnswers).toEqual([{
      "scope-0": ["Choice 0"], "scope-1": ["Choice 0"], "scope-2": ["Choice 0"],
    }]);
    const prompt = await decryptBlob(key, posted!.blob as string) as Record<string, unknown>;
    const wireQuestions = prompt.permissionQuestions as Array<Record<string, unknown>>;
    expect(wireQuestions).toHaveLength(3);
    expect(wireQuestions.every((question) => !("d" in question))).toBe(true);
    expect(wireQuestions[0].o).toEqual(Array.from({ length: 8 }, (_, index) => `Choice ${index}`));
  });

  test("maps a phone deny to Codex turn interruption instead of forging an answer", async () => {
    const answerBlob = await encryptBlob(key, { requestId: "relay-deny", decision: "deny" });
    let interrupted = 0;
    let answered = 0;
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: (async (input) => String(input).endsWith("/v1/cc/decision")
        ? Response.json({ hold: true })
        : Response.json({ status: "answered", answerBlob })) as typeof fetch,
      readRecordFn: async () => record,
      randomUUID: () => "relay-deny",
      localApprovalsStateFn: async () => "on",
      sleep: async () => {},
      answerAppServer: async () => { answered += 1; return "sent"; },
      interruptAppServer: async () => { interrupted += 1; return "sent"; },
    });

    expect(await handle.completion).toBe("denied");
    expect(interrupted).toBe(1);
    expect(answered).toBe(0);
  });

  test("never sends secret, option-less, or ambiguous-display questions to the relay", async () => {
    for (const questions of [
      [{ ...request().questions[0], isSecret: true }],
      [{ ...request().questions[0], options: null }],
      [{ ...request().questions[0], options: [
        { label: `${"A".repeat(70)}1`, description: "One" },
        { label: `${"A".repeat(70)}2`, description: "Two" },
      ] }],
      (() => {
        const label = `x${"😀".repeat(80)}`;
        const shown = capPermissionWireText(label, PERMISSION_QUESTION_LABEL_MAX);
        return [{ ...request().questions[0], options: [
          { label, description: "Astral" },
          { label: shown, description: "Displayed collision" },
        ] }];
      })(),
      [{ ...request().questions[0], options: [{ label: " Fast ", description: "Padded" }] }],
    ]) {
      let fetched = false;
      const handle = startCodexRemoteInput(request({ questions }), {
        config,
        fetchFn: (async () => { fetched = true; return Response.json({}); }) as typeof fetch,
        readRecordFn: async () => record,
        randomUUID: () => "relay-2",
        answerAppServer: async () => "sent",
        interruptAppServer: async () => "sent",
      });
      expect(await handle.completion).toBe("unsupported");
      expect(fetched).toBe(false);
    }
  });

  test("Desktop resolution aborts polling and idempotently retires the phone card", async () => {
    const calls: string[] = [];
    let releaseSleep: (() => void) | undefined;
    let markPosted!: () => void;
    const posted = new Promise<void>((resolve) => { markPosted = resolve; });
    const fetchFn = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input); calls.push(url);
      if (url.endsWith("/v1/cc/decision")) { markPosted(); return Response.json({ hold: true }); }
      if (url.endsWith("/v1/cc/decision/resolve")) return Response.json({ ok: true, status: "superseded" });
      return Response.json({ status: "pending" });
    };
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: fetchFn as typeof fetch,
      readRecordFn: async () => record,
      randomUUID: () => "relay-3",
      sleep: () => new Promise<void>((resolve) => { releaseSleep = resolve; }),
      answerAppServer: async () => "sent",
      interruptAppServer: async () => "sent",
    });
    // Let the hold creation land, then resolve from the Desktop side.
    await posted;
    for (let index = 0; index < 10 && !releaseSleep; index += 1) await Promise.resolve();
    await handle.resolvedElsewhere();
    releaseSleep?.();
    expect(await handle.completion).toBe("resolved-elsewhere");
    expect(calls.filter((url) => url.endsWith("/v1/cc/decision/resolve"))).toHaveLength(1);
  });

  test("a 200 with a non-JSON body on the hold POST degrades and retires any orphan hold", async () => {
    const calls: string[] = [];
    const errors: Error[] = [];
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: (async (input) => {
        const url = String(input); calls.push(url);
        // An edge/captive portal answers 200 with HTML. Parsing must not throw out of the task.
        if (url.endsWith("/v1/cc/decision")) return new Response("<html>not json</html>", { status: 200 });
        return Response.json({ ok: true });
      }) as typeof fetch,
      readRecordFn: async () => record,
      randomUUID: () => "relay-html",
      localApprovalsStateFn: async () => "on",
      sleep: async () => {},
      answerAppServer: async () => "sent",
      interruptAppServer: async () => "sent",
      onError: (error) => errors.push(error),
    });

    expect(await handle.completion).toBe("transport-error");
    expect(calls.filter((url) => url.endsWith("/v1/cc/decision/resolve"))).toHaveLength(1);
    expect(errors.map((error) => error.message)).toContain("Unparseable relay response to the decision hold POST");
  });

  test("a non-JSON 200 while polling counts as a miss and polling continues", async () => {
    const errors: Error[] = [];
    const answerBlob = await encryptBlob(key, {
      requestId: "relay-poll", decision: "answer", answers: ["Fast"],
    });
    let polls = 0;
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: (async (input) => {
        if (String(input).endsWith("/v1/cc/decision")) return Response.json({ hold: true });
        polls += 1;
        if (polls === 1) return new Response("garbage", { status: 200 });
        return Response.json({ status: "answered", answerBlob });
      }) as typeof fetch,
      readRecordFn: async () => record,
      randomUUID: () => "relay-poll",
      localApprovalsStateFn: async () => "on",
      sleep: async () => {},
      answerAppServer: async () => "sent",
      interruptAppServer: async () => "sent",
      onError: (error) => errors.push(error),
    });

    expect(await handle.completion).toBe("answered");
    expect(polls).toBe(2);
    expect(errors.map((error) => error.message)).toContain("Unparseable relay poll response");
  });

  test("a relay that only ever answers garbage still gives up instead of polling forever", async () => {
    let polls = 0;
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: (async (input) => {
        if (String(input).endsWith("/v1/cc/decision")) return Response.json({ hold: true });
        polls += 1;
        return new Response("garbage", { status: 200 });
      }) as typeof fetch,
      readRecordFn: async () => record,
      randomUUID: () => "relay-garbage",
      localApprovalsStateFn: async () => "on",
      sleep: async () => {},
      answerAppServer: async () => "sent",
      interruptAppServer: async () => "sent",
    });

    expect(await handle.completion).toBe("transport-error");
    expect(polls).toBe(100); // MAX_CONSECUTIVE_MISSES
  });

  test("a throwing dependency degrades instead of rejecting the completion promise", async () => {
    const errors: Error[] = [];
    let fetched = false;
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: (async () => { fetched = true; return Response.json({ hold: true }); }) as typeof fetch,
      readRecordFn: async () => { throw new Error("session store is corrupt"); },
      randomUUID: () => "relay-throw",
      localApprovalsStateFn: async () => "on",
      sleep: async () => {},
      answerAppServer: async () => "sent",
      interruptAppServer: async () => "sent",
      onError: (error) => errors.push(error),
    });

    expect(await handle.completion).toBe("transport-error");
    expect(fetched).toBe(false);
    expect(errors.map((error) => error.message)).toContain("session store is corrupt");
  });

  test("an answer app-server refuses is reported and the relay record is retired", async () => {
    for (const [decision, outcome, blobBody] of [
      ["answer", "stale", { requestId: "relay-stale", decision: "answer", answers: ["Fast"] }],
      ["deny", "transport-error", { requestId: "relay-stale", decision: "deny" }],
    ] as const) {
      const answerBlob = await encryptBlob(key, blobBody);
      const calls: string[] = [];
      const errors: Error[] = [];
      const handle = startCodexRemoteInput(request(), {
        config,
        fetchFn: (async (input) => {
          const url = String(input); calls.push(url);
          if (url.endsWith("/v1/cc/decision")) return Response.json({ hold: true });
          if (url.endsWith("/v1/cc/decision/resolve")) return Response.json({ ok: true });
          return Response.json({ status: "answered", answerBlob });
        }) as typeof fetch,
        readRecordFn: async () => record,
        randomUUID: () => "relay-stale",
        localApprovalsStateFn: async () => "on",
        sleep: async () => {},
        answerAppServer: async () => "stale",
        interruptAppServer: async () => "transport-error",
        onError: (error) => errors.push(error),
      });

      // The worker already marked the request answered; the failure must be visible, not silent.
      expect(await handle.completion).toBe("transport-error");
      expect(calls.filter((url) => url.endsWith("/v1/cc/decision/resolve"))).toHaveLength(1);
      expect(errors.map((error) => error.message))
        .toContain(`Codex ${decision} was not delivered to app-server (${outcome})`);
    }
  });

  // ABORT DURING THE POST. The worker creates the hold (pending decision + shown-set enrollment + violet
  // island push) the moment the POST lands; if the Mac answers while that POST is in flight, the abort
  // must NOT skip retirement — the phone would keep a live Answer/Deny card for a dead prompt until the
  // worker's ~30s sweep. The fetch must also be signed with the caller's signal, or `controller.abort()`
  // cannot cancel it at all and the race window is the whole POST duration.
  test("an abort that lands while the hold POST resolves still retires the created hold", async () => {
    const calls: string[] = [];
    let postSignal: AbortSignal | undefined;
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
    let markPosted!: () => void;
    const posted = new Promise<void>((resolve) => { markPosted = resolve; });
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: (async (input, init) => {
        const url = String(input); calls.push(url);
        if (url.endsWith("/v1/cc/decision")) {
          postSignal = init?.signal ?? undefined;
          markPosted();
          await postGate;                       // the worker commits the hold while Desktop answers
          return Response.json({ hold: true });
        }
        return Response.json({ ok: true });
      }) as typeof fetch,
      readRecordFn: async () => record,
      randomUUID: () => "relay-race",
      localApprovalsStateFn: async () => "on",
      sleep: async () => {},
      answerAppServer: async () => "sent",
      interruptAppServer: async () => "sent",
    });

    await posted;
    const resolving = handle.resolvedElsewhere();  // Desktop wins the race, POST still in flight
    expect(postSignal?.aborted).toBe(true);        // the caller's abort really reaches the fetch
    releasePost();
    await resolving;

    expect(await handle.completion).toBe("resolved-elsewhere");
    expect(calls.filter((url) => url.endsWith("/v1/cc/decision/resolve"))).toHaveLength(1);
  });

  // DEFINITIVE poll statuses — same rule as the permission hook's poll loop. A revoked pairing or a
  // cleared record can never heal, so riding MAX_CONSECUTIVE_MISSES (100 × 3s ≈ 5 min) burns the shared
  // per-pairing poll budget and starves genuinely live holds into 429s.
  for (const status of [401, 403, 404, 410]) {
    test(`a poll answering ${status} twice gives up at once (2 GETs, not the 100-miss cap)`, async () => {
      let polls = 0;
      const handle = startCodexRemoteInput(request(), {
        config,
        fetchFn: (async (input) => {
          if (String(input).endsWith("/v1/cc/decision")) return Response.json({ hold: true });
          polls += 1;
          return new Response("", { status });
        }) as typeof fetch,
        readRecordFn: async () => record,
        randomUUID: () => "relay-definitive",
        localApprovalsStateFn: async () => "on",
        sleep: async () => {},
        answerAppServer: async () => "sent",
        interruptAppServer: async () => "sent",
      });

      expect(await handle.completion).toBe("transport-error");
      expect(polls).toBe(2); // MAX_DEFINITIVE_POLL_FAILURES
    });
  }

  test("a SINGLE definitive status is tolerated — a racing delete/deploy must not kill a live hold", async () => {
    const answerBlob = await encryptBlob(key, {
      requestId: "relay-single", decision: "answer", answers: ["Fast"],
    });
    let polls = 0;
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: (async (input) => {
        if (String(input).endsWith("/v1/cc/decision")) return Response.json({ hold: true });
        polls += 1;
        if (polls === 1 || polls === 3) return new Response("", { status: 404 });
        if (polls === 2) return Response.json({ status: "pending" });   // breaks the strike streak
        return Response.json({ status: "answered", answerBlob });
      }) as typeof fetch,
      readRecordFn: async () => record,
      randomUUID: () => "relay-single",
      localApprovalsStateFn: async () => "on",
      sleep: async () => {},
      answerAppServer: async () => "sent",
      interruptAppServer: async () => "sent",
    });

    expect(await handle.completion).toBe("answered");
    expect(polls).toBe(4);
  });

  test("429/5xx stay TRANSIENT — they ride the miss cap, never the definitive give-up", async () => {
    let polls = 0;
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: (async (input) => {
        if (String(input).endsWith("/v1/cc/decision")) return Response.json({ hold: true });
        polls += 1;
        return new Response("", { status: polls === 1 ? 429 : 500 });
      }) as typeof fetch,
      readRecordFn: async () => record,
      randomUUID: () => "relay-transient",
      localApprovalsStateFn: async () => "on",
      sleep: async () => {},
      answerAppServer: async () => "sent",
      interruptAppServer: async () => "sent",
    });

    expect(await handle.completion).toBe("transport-error");
    expect(polls).toBe(100); // MAX_CONSECUTIVE_MISSES, unchanged
  });

  test("Desktop resolution before hold creation aborts without creating or resolving an orphan", async () => {
    const calls: string[] = [];
    let releaseRecord!: () => void;
    const recordGate = new Promise<void>((resolve) => { releaseRecord = resolve; });
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: (async (input) => { calls.push(String(input)); return Response.json({ hold: true }); }) as typeof fetch,
      readRecordFn: async () => { await recordGate; return record; },
      randomUUID: () => "relay-early",
      answerAppServer: async () => "sent",
      interruptAppServer: async () => "sent",
    });
    const resolving = handle.resolvedElsewhere();
    releaseRecord();
    await resolving;
    expect(await handle.completion).toBe("resolved-elsewhere");
    expect(calls).toEqual([]);
  });
});

// --- the LAN channel (NOM-44 phase 2) ----------------------------------------------------------
//
// This relay runs INSIDE the watchdog, which is also the process hosting the LAN listener — so a phone
// answer delivered over the local network is already in this process's memory. It is applied straight
// from the store instead of waiting up to 3 s for the next worker poll tick. The worker poll itself is
// untouched: it keeps its cadence (it is the relay's liveness proof) and every guard it applies to an
// answer — decrypt, requestId match, deny→interrupt, label re-mapping — is the SAME shared code.
describe("startCodexRemoteInput — LAN-delivered answers", () => {
  const NOW = 1_800_000_000_000;

  /** A relay whose worker leg only ever creates the hold and then says "pending" forever, counting the
   *  polls; the LAN store is the only channel that can finish it. */
  function relay(store: LanAnswerStore, over: Partial<CodexRemoteInputDeps> = {}) {
    const polls: number[] = [];
    let sawPoll!: () => void;
    const polled = new Promise<void>((resolve) => { sawPoll = resolve; });
    const appAnswers: unknown[] = [];
    let interrupted = 0;
    const handle = startCodexRemoteInput(request(), {
      config,
      fetchFn: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/v1/cc/decision")) return Response.json({ hold: true });
        polls.push(1);
        sawPoll();
        return Response.json({ status: "pending" });
      }) as typeof fetch,
      readRecordFn: async () => record,
      randomUUID: () => "relay-lan",
      localApprovalsStateFn: async () => "on",
      now: () => NOW,
      answerStore: store,
      sleep: () => new Promise<void>(() => { /* the 3 s tick NEVER fires in these tests */ }),
      answerAppServer: async (answers) => { appAnswers.push(answers); return "sent"; },
      interruptAppServer: async () => { interrupted += 1; return "sent"; },
      ...over,
    });
    return { handle, polls, polled, appAnswers, interrupted: () => interrupted };
  }

  test("an answer already in the store is applied without a single worker poll", async () => {
    const store = createLanAnswerStore();
    store.put("relay-lan", await encryptBlob(key, {
      requestId: "relay-lan", decision: "answer", answers: ["Thorough"],
    }), NOW);
    const { handle, polls, appAnswers } = relay(store);
    expect(await handle.completion).toBe("answered");
    expect(appAnswers).toEqual([{ scope: ["Thorough"] }]);
    expect(polls).toHaveLength(0); // the store is checked FIRST, before the loop ever hits the network
  });

  test("an answer that lands mid-hold wakes the relay instead of waiting for the next tick", async () => {
    const store = createLanAnswerStore();
    // The sleep in this relay never resolves, so ONLY the store's waiter can move the loop on.
    const { handle, polls, polled, appAnswers } = relay(store);
    await polled;
    store.put("relay-lan", await encryptBlob(key, {
      requestId: "relay-lan", decision: "answer", answers: ["Fast"],
    }), NOW);
    expect(await handle.completion).toBe("answered");
    expect(appAnswers).toEqual([{ scope: ["Fast"] }]);
    expect(polls).toHaveLength(1); // one poll happened; the answer did NOT wait for a second
  });

  test("a LAN deny maps to the same Codex interrupt the worker path uses", async () => {
    const store = createLanAnswerStore();
    store.put("relay-lan", await encryptBlob(key, { requestId: "relay-lan", decision: "deny" }), NOW);
    const { handle, interrupted, appAnswers } = relay(store);
    expect(await handle.completion).toBe("denied");
    expect(interrupted()).toBe(1);
    expect(appAnswers).toEqual([]);
  });

  test("the requestId-mismatch guard is preserved on the LAN path (never answers off a stale blob)", async () => {
    const store = createLanAnswerStore();
    store.put("relay-lan", await encryptBlob(key, {
      requestId: "some-other-request", decision: "answer", answers: ["Thorough"],
    }), NOW);
    const { handle, appAnswers, interrupted } = relay(store);
    expect(await handle.completion).toBe("unsupported");
    expect(appAnswers).toEqual([]);
    expect(interrupted()).toBe(0);
  });

  test("an unmappable LAN answer falls back to the Mac picker, exactly as a worker-delivered one does", async () => {
    const store = createLanAnswerStore();
    store.put("relay-lan", await encryptBlob(key, {
      requestId: "relay-lan", decision: "answer", answers: ["Not An Option"],
    }), NOW);
    const { handle, appAnswers } = relay(store);
    expect(await handle.completion).toBe("unsupported");
    expect(appAnswers).toEqual([]);
  });

  test("an EXPIRED store entry is ignored — the relay keeps polling the worker as if nothing arrived", async () => {
    const store = createLanAnswerStore();
    store.put("relay-lan", await encryptBlob(key, {
      requestId: "relay-lan", decision: "answer", answers: ["Thorough"],
    }), NOW - LAN_ANSWER_TTL_MS - 1);
    const { handle, polled, appAnswers } = relay(store);
    await polled;                      // it polled the worker rather than applying the stale answer
    await handle.resolvedElsewhere();  // and unwinds normally
    expect(await handle.completion).toBe("resolved-elsewhere");
    expect(appAnswers).toEqual([]);
  });
});
