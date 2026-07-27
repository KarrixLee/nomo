import { describe, expect, test } from "bun:test";
import { decryptBlob, encryptBlob } from "./crypto";
import { codexAnswersFromPhone, startCodexRemoteInput } from "./codex-remote-input";
import type { CodexUserInputRequest } from "./codex-app-server-client";
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

  test("rejects partial, forged, or unrenderable answers", () => {
    expect(codexAnswersFromPhone(request(), [])).toBeUndefined();
    expect(codexAnswersFromPhone(request(), ["Other"])).toBeUndefined();
    expect(codexAnswersFromPhone(request(), [""])).toBeUndefined();
  });
});

describe("startCodexRemoteInput", () => {
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
