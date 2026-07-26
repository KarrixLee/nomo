import { describe, expect, test } from "bun:test";
import {
  CodexAppServerClient,
  CodexRpcTransport,
  CodexRpcTransportHandlers,
  CodexUserInputRequest,
  CodexUserInputResolution,
} from "./codex-app-server-client";

class FakeTransport implements CodexRpcTransport {
  handlers: CodexRpcTransportHandlers | undefined;
  sent: object[] = [];
  sendError: Error | undefined;

  async open(handlers: CodexRpcTransportHandlers): Promise<void> { this.handlers = handlers; }
  async send(message: object): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push(message);
  }
  async close(): Promise<void> {}
  receive(message: unknown): void { this.handlers?.onMessage(message); }
  disconnect(error?: unknown): void { this.handlers?.onClose(error); }
}

interface Harness {
  client: CodexAppServerClient;
  transports: FakeTransport[];
  requests: CodexUserInputRequest[];
  resolutions: Array<[CodexUserInputRequest, CodexUserInputResolution]>;
  errors: Error[];
  timers: Array<() => void>;
}

function harness(): Harness {
  const transports: FakeTransport[] = [];
  const requests: CodexUserInputRequest[] = [];
  const resolutions: Array<[CodexUserInputRequest, CodexUserInputResolution]> = [];
  const errors: Error[] = [];
  const timers: Array<() => void> = [];
  const client = new CodexAppServerClient({
    transportFactory: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    clientVersion: "1.4.0-test",
    now: () => 1234,
    setTimer: (callback) => { timers.push(callback); return callback; },
    clearTimer: (token) => {
      const index = timers.indexOf(token as () => void);
      if (index >= 0) timers.splice(index, 1);
    },
    onUserInputRequest: (request) => requests.push(request),
    onUserInputResolved: (request, resolution) => resolutions.push([request, resolution]),
    onError: (error) => errors.push(error),
  });
  return { client, transports, requests, resolutions, errors, timers };
}

async function initialize(h: Harness, index = 0): Promise<void> {
  const started = h.client.start();
  await Promise.resolve();
  const transport = h.transports[index];
  expect(transport.sent[0]).toEqual({
    method: "initialize",
    id: 1 + index,
    params: {
      clientInfo: { name: "nomo", title: "Nomo Remote Input", version: "1.4.0-test" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    },
  });
  transport.receive({ id: 1 + index, result: { userAgent: "codex" } });
  expect(await started).toBe(true);
  expect(transport.sent[1]).toEqual({ method: "initialized" });
  expect(h.client.state).toBe("ready");
}

function requestParams() {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    questions: [{
      id: "scope",
      header: "Scope",
      question: "How much should I change?",
      isOther: false,
      isSecret: false,
      options: [
        { label: "Fast", description: "Smallest change" },
        { label: "Thorough", description: "Include hardening" },
      ],
    }],
    autoResolutionMs: null,
  };
}

describe("CodexAppServerClient", () => {
  test("initializes, lists threads, and resumes a selected thread", async () => {
    const h = harness();
    await initialize(h);
    const transport = h.transports[0];

    const listed = h.client.listThreads({ limit: 5 });
    await Promise.resolve();
    expect(transport.sent[2]).toEqual({ method: "thread/list", id: 2, params: { limit: 5 } });
    transport.receive({ id: 2, result: { data: [{ id: "thread-1", preview: "Plan" }], nextCursor: null } });
    expect(await listed).toEqual({ data: [{ id: "thread-1", preview: "Plan" }], nextCursor: null });

    const resumed = h.client.resumeThread("thread-1", { excludeTurns: true });
    await Promise.resolve();
    expect(transport.sent[3]).toEqual({
      method: "thread/resume", id: 3, params: { excludeTurns: true, threadId: "thread-1" },
    });
    transport.receive({ id: 3, result: { thread: { id: "thread-1", status: { type: "active" } } } });
    expect((await resumed).thread.id).toBe("thread-1");
  });

  test("lists only threads loaded in the shared app-server process", async () => {
    const h = harness();
    await initialize(h);
    const transport = h.transports[0];

    const loaded = h.client.listLoadedThreads({ limit: 10 });
    await Promise.resolve();
    expect(transport.sent[2]).toEqual({ method: "thread/loaded/list", id: 2, params: { limit: 10 } });
    transport.receive({ id: 2, result: { data: ["thread-live-1", "thread-live-2"], nextCursor: null } });
    expect(await loaded).toEqual({ data: ["thread-live-1", "thread-live-2"], nextCursor: null });
  });

  test("emits a typed request and answers the same server request id", async () => {
    const h = harness();
    await initialize(h);
    const transport = h.transports[0];
    transport.receive({ method: "item/tool/requestUserInput", id: "rpc-9", params: requestParams() });

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toEqual({
      identity: {
        connectionEpoch: 1,
        requestId: "rpc-9",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
      },
      questions: requestParams().questions,
      autoResolutionMs: null,
      receivedAtMs: 1234,
    });

    expect(await h.client.answerUserInput(h.requests[0].identity, { scope: ["Thorough"] })).toBe("sent");
    expect(transport.sent[2]).toEqual({
      id: "rpc-9",
      result: { answers: { scope: { answers: ["Thorough"] } } },
    });
    expect(await h.client.answerUserInput(h.requests[0].identity, { scope: ["Fast"] })).toBe("already-sent");

    transport.receive({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "rpc-9" },
    });
    expect(h.resolutions).toEqual([[h.requests[0], "response-sent"]]);
    expect(await h.client.answerUserInput(h.requests[0].identity, { scope: ["Fast"] })).toBe("stale");
  });

  test("rejects incomplete, unknown, or forged option answers without writing to transport", async () => {
    const h = harness();
    await initialize(h);
    const transport = h.transports[0];
    transport.receive({ method: "item/tool/requestUserInput", id: 90, params: requestParams() });
    const identity = h.requests[0].identity;

    expect(await h.client.answerUserInput(identity, {})).toBe("invalid");
    expect(await h.client.answerUserInput(identity, { unknown: ["Fast"] })).toBe("invalid");
    expect(await h.client.answerUserInput(identity, { scope: ["Faster"] })).toBe("invalid");
    expect(transport.sent).toHaveLength(2);
  });

  test("server cleanup before an answer marks the request stale", async () => {
    const h = harness();
    await initialize(h);
    const transport = h.transports[0];
    transport.receive({ method: "item/tool/requestUserInput", id: 8, params: requestParams() });
    transport.receive({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 8 } });

    expect(h.resolutions).toEqual([[h.requests[0], "server-cleared"]]);
    expect(await h.client.answerUserInput(h.requests[0].identity, { scope: ["Fast"] })).toBe("stale");
  });

  test("disconnect clears requests and reconnect uses a new identity epoch", async () => {
    const h = harness();
    await initialize(h);
    const first = h.transports[0];
    first.receive({ method: "item/tool/requestUserInput", id: 4, params: requestParams() });
    const oldIdentity = h.requests[0].identity;
    first.disconnect();

    expect(h.client.state).toBe("disconnected");
    expect(h.resolutions).toEqual([[h.requests[0], "connection-lost"]]);
    expect(await h.client.answerUserInput(oldIdentity, { scope: ["Fast"] })).toBe("stale");

    // Run the scheduled retry. Initialization uses the next client request id.
    const reconnect = h.timers[0];
    reconnect();
    await Promise.resolve();
    const second = h.transports[1];
    expect(second.sent[0]).toMatchObject({ method: "initialize", id: 2 });
    second.receive({ id: 2, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.client.state).toBe("ready");

    second.receive({ method: "item/tool/requestUserInput", id: 4, params: requestParams() });
    expect(h.requests[1].identity).toMatchObject({ connectionEpoch: 2, requestId: 4 });
    expect(await h.client.answerUserInput(oldIdentity, { scope: ["Fast"] })).toBe("stale");
    expect(await h.client.answerUserInput(h.requests[1].identity, { scope: ["Fast"] })).toBe("sent");
  });

  test("mismatched resolution cannot clear a live request", async () => {
    const h = harness();
    await initialize(h);
    const transport = h.transports[0];
    transport.receive({ method: "item/tool/requestUserInput", id: 11, params: requestParams() });
    transport.receive({ method: "serverRequest/resolved", params: { threadId: "other", requestId: 11 } });
    expect(h.errors.at(-1)?.message).toBe("serverRequest/resolved identity mismatch");
    expect(await h.client.answerUserInput(h.requests[0].identity, { scope: ["Fast"] })).toBe("sent");
  });

  test("malformed and duplicate requests are ignored", async () => {
    const h = harness();
    await initialize(h);
    const transport = h.transports[0];
    transport.receive({ method: "item/tool/requestUserInput", id: 2, params: { ...requestParams(), questions: [] } });
    expect(h.requests).toHaveLength(0);
    transport.receive({ method: "item/tool/requestUserInput", id: 2, params: requestParams() });
    transport.receive({ method: "item/tool/requestUserInput", id: 2, params: requestParams() });
    expect(h.requests).toHaveLength(1);
    expect(h.errors.map((error) => error.message)).toEqual([
      "Invalid item/tool/requestUserInput payload",
      "Duplicate app-server request id",
    ]);
  });
});
