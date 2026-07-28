import { describe, expect, test } from "bun:test";
import {
  CodexAppServerClient,
  CodexAppServerClientOptions,
  CodexRpcTransport,
  CodexRpcTransportHandlers,
  CodexUserInputRequest,
  CodexUserInputResolution,
} from "./codex-app-server-client";

class FakeTransport implements CodexRpcTransport {
  handlers: CodexRpcTransportHandlers | undefined;
  sent: object[] = [];
  sendError: Error | undefined;
  openError: Error | undefined;
  /** When set, open() only settles after this promise does. */
  openGate: Promise<void> | undefined;
  closed = 0;

  async open(handlers: CodexRpcTransportHandlers): Promise<void> {
    if (this.openGate) await this.openGate;
    if (this.openError) throw this.openError;
    this.handlers = handlers;
  }
  async send(message: object): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push(message);
  }
  async close(): Promise<void> { this.closed += 1; }
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
  /** Parallel to `timers` (spliced together by clearTimer), so timers[i] was scheduled at delays[i]. */
  delays: number[];
}

interface HarnessOptions extends Partial<CodexAppServerClientOptions> {
  prepare?: (transport: FakeTransport, index: number) => void;
}

function harness(options: HarnessOptions = {}): Harness {
  const { prepare, ...overrides } = options;
  const transports: FakeTransport[] = [];
  const requests: CodexUserInputRequest[] = [];
  const resolutions: Array<[CodexUserInputRequest, CodexUserInputResolution]> = [];
  const errors: Error[] = [];
  const timers: Array<() => void> = [];
  const delays: number[] = [];
  const client = new CodexAppServerClient({
    transportFactory: () => {
      const transport = new FakeTransport();
      prepare?.(transport, transports.length);
      transports.push(transport);
      return transport;
    },
    clientVersion: "1.4.0-test",
    now: () => 1234,
    setTimer: (callback, delayMs) => { timers.push(callback); delays.push(delayMs); return callback; },
    clearTimer: (token) => {
      const index = timers.indexOf(token as () => void);
      if (index >= 0) { timers.splice(index, 1); delays.splice(index, 1); }
    },
    onUserInputRequest: (request) => requests.push(request),
    onUserInputResolved: (request, resolution) => resolutions.push([request, resolution]),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return { client, transports, requests, resolutions, errors, timers, delays };
}

async function flush(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
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

  test("interrupts the exact turn when the user denies a request_user_input prompt", async () => {
    const h = harness();
    await initialize(h);
    const transport = h.transports[0];
    transport.receive({ method: "item/tool/requestUserInput", id: "rpc-deny", params: requestParams() });

    const interrupted = h.client.interruptUserInput(h.requests[0].identity);
    await Promise.resolve();
    expect(transport.sent[2]).toEqual({
      method: "turn/interrupt",
      id: 2,
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    transport.receive({ id: 2, result: {} });
    expect(await interrupted).toBe("sent");
    expect(await h.client.interruptUserInput(h.requests[0].identity)).toBe("already-sent");
    expect(await h.client.answerUserInput(h.requests[0].identity, { scope: ["Fast"] })).toBe("already-sent");

    transport.receive({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "rpc-deny" },
    });
    expect(h.resolutions).toEqual([[h.requests[0], "interrupt-sent"]]);
    expect(await h.client.interruptUserInput(h.requests[0].identity)).toBe("stale");
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

  test("backs off exponentially, caps the delay, and resets after a successful handshake", async () => {
    let failing = true;
    const h = harness({
      reconnectDelayMs: 100,
      maxReconnectDelayMs: 400,
      maxReconnectAttempts: 10,
      prepare: (transport) => { if (failing) transport.openError = new Error("no socket"); },
    });

    expect(await h.client.start()).toBe(false);
    // Every retry spawns a fresh `codex` child, so the delay must grow and then stay capped.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const fire = h.timers[h.timers.length - 1];
      fire();
      await flush();
    }
    expect(h.delays).toEqual([100, 200, 400, 400, 400]);
    expect(h.client.state).toBe("disconnected");

    // A completed handshake resets the ladder back to the base delay.
    failing = false;
    h.timers[h.timers.length - 1]();
    await flush();
    const live = h.transports[h.transports.length - 1];
    live.receive({ id: 1, result: {} });
    await flush();
    expect(h.client.state).toBe("ready");
    live.disconnect();
    expect(h.delays.at(-1)).toBe(100);
  });

  test("gives up after consecutive failures and stays restartable", async () => {
    let failing = true;
    const h = harness({
      reconnectDelayMs: 10,
      maxReconnectAttempts: 3,
      prepare: (transport) => { if (failing) transport.openError = new Error("no socket"); },
    });

    expect(await h.client.start()).toBe(false);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.timers[h.timers.length - 1]();
      await flush();
    }
    expect(h.delays).toEqual([10, 20, 40]);
    expect(h.client.state).toBe("stopped");
    expect(h.errors.at(-1)?.message).toContain("gave up after 3 consecutive failures");
    // Parked, not wedged: no pending retry timer and no orphaned transport.
    expect(h.timers.length).toBe(3); // all three fired; none still armed
    expect(h.transports).toHaveLength(4);

    failing = false;
    const started = h.client.start();
    await flush();
    const live = h.transports[h.transports.length - 1];
    live.receive({ id: 1, result: {} });
    expect(await started).toBe(true);
    expect(h.client.state).toBe("ready");
  });

  test("stop() during an in-flight connect leaves a restartable client", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ prepare: (transport, index) => { if (index === 0) transport.openGate = gate; } });

    const first = h.client.start();
    await flush();
    await h.client.stop();
    expect(h.client.state).toBe("stopped");
    release();
    expect(await first).toBe(false);
    await flush();
    // The abandoned attempt must not leave a live child behind.
    expect(h.transports[0].closed).toBeGreaterThanOrEqual(1);

    const second = h.client.start();
    await flush();
    const live = h.transports[1];
    expect(live.sent[0]).toMatchObject({ method: "initialize" });
    live.receive({ id: (live.sent[0] as { id: number }).id, result: {} });
    expect(await second).toBe(true);
    expect(h.client.state).toBe("ready");
  });

  test("a reused request id is accepted once the previous request was answered", async () => {
    const h = harness();
    await initialize(h);
    const transport = h.transports[0];
    transport.receive({ method: "item/tool/requestUserInput", id: 7, params: requestParams() });
    expect(await h.client.answerUserInput(h.requests[0].identity, { scope: ["Fast"] })).toBe("sent");

    // app-server never sent serverRequest/resolved but reused id 7 for a new prompt. The old entry must
    // not block the id forever; it is retired with our own attribution and the new prompt goes through.
    transport.receive({
      method: "item/tool/requestUserInput",
      id: 7,
      params: { ...requestParams(), turnId: "turn-2", itemId: "item-2" },
    });
    expect(h.resolutions).toEqual([[h.requests[0], "response-sent"]]);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].identity).toMatchObject({ requestId: 7, turnId: "turn-2" });
    expect(await h.client.answerUserInput(h.requests[1].identity, { scope: ["Fast"] })).toBe("sent");
    expect(h.errors).toHaveLength(0);
  });

  test("autoResolutionMs expires the request locally and never leaks its timer", async () => {
    const h = harness();
    await initialize(h);
    const transport = h.transports[0];
    transport.receive({
      method: "item/tool/requestUserInput",
      id: "rpc-auto",
      params: { ...requestParams(), autoResolutionMs: 30_000 },
    });
    expect(h.delays).toEqual([30_000]);

    h.timers[0]();
    // The phone card cannot outlive the prompt: this looks exactly like a server-side clear.
    expect(h.resolutions).toEqual([[h.requests[0], "server-cleared"]]);
    expect(await h.client.answerUserInput(h.requests[0].identity, { scope: ["Fast"] })).toBe("stale");

    // A resolved request clears its expiry timer instead of firing later against a dead entry.
    transport.receive({
      method: "item/tool/requestUserInput",
      id: "rpc-auto-2",
      params: { ...requestParams(), autoResolutionMs: 30_000 },
    });
    expect(h.timers).toHaveLength(2);
    transport.receive({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "rpc-auto-2" },
    });
    expect(h.timers).toHaveLength(1); // only the already-fired one remains recorded
    expect(h.resolutions.at(-1)).toEqual([h.requests[1], "server-cleared"]);

    // …and a disconnect clears any remaining expiry timer too.
    transport.receive({
      method: "item/tool/requestUserInput",
      id: "rpc-auto-3",
      params: { ...requestParams(), autoResolutionMs: 30_000 },
    });
    expect(h.timers).toHaveLength(2);
    transport.disconnect();
    // Only the already-fired first expiry plus the reconnect timer remain recorded: the live request's
    // expiry timer was cleared by the disconnect rather than leaked.
    expect(h.delays).toEqual([30_000, 1_000]);
  });

  test("an unconfirmed interrupt is still attributed to us when the request resolves", async () => {
    const h = harness();
    await initialize(h);
    const transport = h.transports[0];
    transport.receive({ method: "item/tool/requestUserInput", id: 12, params: requestParams() });

    const interrupted = h.client.interruptUserInput(h.requests[0].identity);
    await flush();
    // Time out the turn/interrupt reply: the interrupt may still have landed on app-server.
    const timeout = h.timers[0];
    timeout();
    expect(await interrupted).toBe("transport-error");

    transport.receive({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 12 },
    });
    // Never "server-cleared": the bridge would retire a card the user actually denied.
    expect(h.resolutions).toEqual([[h.requests[0], "interrupt-sent"]]);
  });

  test("a request arriving before the connection is ready is reported, not silently dropped", async () => {
    const h = harness();
    const started = h.client.start();
    await flush();
    const transport = h.transports[0];
    transport.receive({ method: "item/tool/requestUserInput", id: 5, params: requestParams() });
    expect(h.requests).toHaveLength(0);
    expect(h.errors.at(-1)?.message).toContain("before the connection was ready");
    transport.receive({ id: 1, result: {} });
    expect(await started).toBe(true);
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
