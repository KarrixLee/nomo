import { describe, expect, test } from "bun:test";
import {
  CodexAppServerState,
  CodexLoadedThreadListResult,
  CodexThreadResumeResult,
  CodexThreadStatus,
  CodexUserInputAnswerResult,
  CodexUserInputAnswers,
  CodexUserInputInterruptResult,
  CodexUserInputRequest,
  CodexUserInputRequestIdentity,
} from "./codex-app-server-client";
import {
  CodexRemoteInputBridge,
  CodexRemoteInputBridgeCallbacks,
} from "./codex-remote-input-bridge";
import { CodexRemoteInputHandle, CodexRemoteInputResult } from "./codex-remote-input";
import { Config } from "./shared";

const config = {
  url: "https://relay.test",
  pairingId: "pair-1",
  pcSecret: "pc-secret",
  appSecret: "app-secret",
  e2eKey: "e2e-key",
} as Config;

const request: CodexUserInputRequest = {
  identity: {
    connectionEpoch: 2,
    requestId: 41,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
  },
  questions: [{
    id: "choice",
    header: "Choose",
    question: "Which path?",
    isOther: false,
    isSecret: false,
    options: [{ label: "A", description: "First" }],
  }],
  autoResolutionMs: null,
  receivedAtMs: 1,
};

class FakeClient {
  state: CodexAppServerState = "stopped";
  /** Requests the real client hands back through onUserInputResolved while DISCONNECTING (stop()). */
  resolveOnStop: CodexUserInputRequest[] = [];
  pages: CodexLoadedThreadListResult[] = [];
  resumed: string[] = [];
  answers: { identity: CodexUserInputRequestIdentity; answers: CodexUserInputAnswers }[] = [];
  interrupts: CodexUserInputRequestIdentity[] = [];
  threadStatus: CodexThreadStatus = { type: "idle" };
  threadStatusError: Error | undefined;

  constructor(readonly callbacks: CodexRemoteInputBridgeCallbacks) {}
  async start(): Promise<boolean> { this.state = "ready"; this.callbacks.onStateChange("ready"); return true; }
  async stop(): Promise<void> {
    for (const request of this.resolveOnStop) this.callbacks.onUserInputResolved(request, "connection-lost");
    this.state = "stopped";
    this.callbacks.onStateChange("stopped");
  }
  async listLoadedThreads(): Promise<CodexLoadedThreadListResult> {
    return this.pages.shift() ?? { data: [], nextCursor: null };
  }
  async resumeThread(threadId: string): Promise<CodexThreadResumeResult> {
    this.resumed.push(threadId);
    return { thread: { id: threadId } };
  }
  async readThreadStatus(): Promise<CodexThreadStatus> {
    if (this.threadStatusError) throw this.threadStatusError;
    return this.threadStatus;
  }
  async answerUserInput(
    identity: CodexUserInputRequestIdentity,
    answers: CodexUserInputAnswers,
  ): Promise<CodexUserInputAnswerResult> {
    this.answers.push({ identity, answers });
    return "sent";
  }
  async interruptUserInput(
    identity: CodexUserInputRequestIdentity,
  ): Promise<CodexUserInputInterruptResult> {
    this.interrupts.push(identity);
    return "sent";
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** `retirement` models the in-flight POST /cc/decision/resolve: until it settles, the phone still shows
 *  a live card. `resolved` counts retirement STARTS, `retired` counts COMPLETIONS. */
function harness(options: { retirement?: () => Promise<void> } = {}) {
  let client!: FakeClient;
  const errors: Error[] = [];
  const handles: {
    request: CodexUserInputRequest;
    completion: ReturnType<typeof deferred<CodexRemoteInputResult>>;
    resolved: number;
    retired: number;
    answer: (answers: CodexUserInputAnswers) => Promise<CodexUserInputAnswerResult>;
    interrupt: () => Promise<CodexUserInputInterruptResult>;
  }[] = [];
  const bridge = new CodexRemoteInputBridge(config, {
    onError: (error) => errors.push(error),
    createClient: (callbacks) => (client = new FakeClient(callbacks)),
    startRemoteInputFn: (incoming, deps): CodexRemoteInputHandle => {
      const completion = deferred<CodexRemoteInputResult>();
      const item = {
        request: incoming,
        completion,
        resolved: 0,
        retired: 0,
        answer: deps.answerAppServer,
        interrupt: deps.interruptAppServer,
      };
      handles.push(item);
      // Memoized exactly like the real handle, so a double retirement is one POST.
      let retirement: Promise<void> | undefined;
      return {
        requestId: `relay-${handles.length}`,
        completion: completion.promise,
        resolvedElsewhere() {
          if (retirement) return retirement;
          item.resolved += 1;
          retirement = (async () => {
            await options.retirement?.();
            item.retired += 1;
            completion.resolve("resolved-elsewhere");
          })();
          return retirement;
        },
      };
    },
  });
  return { bridge, client: () => client, handles, errors };
}

describe("CodexRemoteInputBridge", () => {
  test("maps 0.146.0 waiting, idle/composer, and query failure without guessing", async () => {
    const h = harness();
    await h.bridge.start();
    h.client().threadStatus = { type: "active", activeFlags: ["waitingOnUserInput"] };
    expect(await h.bridge.readThreadWaitState("thread-1")).toBe("waitingOnUserInput");
    h.client().threadStatus = { type: "idle" };
    expect(await h.bridge.readThreadWaitState("thread-1")).toBe("notWaitingOnUserInput");
    h.client().threadStatus = { type: "active", activeFlags: ["waitingOnApproval"] };
    expect(await h.bridge.readThreadWaitState("thread-1")).toBe("notWaitingOnUserInput");
    h.client().threadStatusError = new Error("thread/read unavailable");
    expect(await h.bridge.readThreadWaitState("thread-1")).toBe("unavailable");
    await h.bridge.stop();
  });

  test("subscribes every loaded page once and picks up newly loaded threads", async () => {
    const h = harness();
    h.client().pages.push(
      { data: ["thread-1", "thread-2"], nextCursor: "next" },
      { data: ["thread-3"], nextCursor: null },
    );
    await h.bridge.start();
    expect(h.client().resumed).toEqual(["thread-1", "thread-2", "thread-3"]);

    h.client().pages.push({ data: ["thread-2", "thread-4"], nextCursor: null });
    await h.bridge.refreshSubscriptions();
    expect(h.client().resumed).toEqual(["thread-1", "thread-2", "thread-3", "thread-4"]);
    await h.bridge.stop();
  });

  test("starts one relay request and answers the exact app-server identity", async () => {
    const h = harness();
    await h.bridge.start();
    h.client().callbacks.onUserInputRequest(request);
    h.client().callbacks.onUserInputRequest(request);
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0].request).toEqual(request);

    await h.handles[0].answer({ choice: ["A"] });
    expect(h.client().answers).toEqual([{ identity: request.identity, answers: { choice: ["A"] } }]);
    await h.handles[0].interrupt();
    expect(h.client().interrupts).toEqual([request.identity]);
    h.client().callbacks.onUserInputResolved(request, "response-sent");
    expect(h.handles[0].resolved).toBe(0);
    h.handles[0].completion.resolve("answered");
    await h.bridge.stop();
  });

  test("Desktop resolution and disconnect retire the matching phone card", async () => {
    const h = harness();
    await h.bridge.start();
    h.client().callbacks.onUserInputRequest(request);
    h.client().callbacks.onUserInputResolved(request, "server-cleared");
    await Promise.resolve();
    expect(h.handles[0].resolved).toBe(1);

    const replay = { ...request, identity: { ...request.identity, connectionEpoch: 3 } };
    h.client().callbacks.onUserInputRequest(replay);
    h.client().callbacks.onUserInputResolved(replay, "connection-lost");
    await Promise.resolve();
    expect(h.handles[1].resolved).toBe(1);
    await h.bridge.stop();
  });

  test("a rejected relay completion is reported and never escapes as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const capture = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", capture);
    try {
      const h = harness();
      await h.bridge.start();
      h.client().callbacks.onUserInputRequest(request);
      h.handles[0].completion.reject(new Error("relay task blew up"));
      // Let the microtask queue drain twice; an unhandled rejection is reported on the next tick.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(h.errors.map((error) => error.message)).toEqual(["relay task blew up"]);
      expect(unhandled).toEqual([]);
      // The handle is still evicted, so the same request id can start a fresh relay task.
      h.client().callbacks.onUserInputRequest(request);
      expect(h.handles).toHaveLength(2);
      await h.bridge.stop();
    } finally {
      process.off("unhandledRejection", capture);
    }
  });

  // stop() used to snapshot the handle map AFTER client.stop(), but the disconnect routes every pending
  // request through onUserInputResolved, which deletes the handle and fires its retirement
  // fire-and-forget — so the snapshot was empty, `Promise.allSettled([])` resolved instantly, and the
  // in-flight POST /cc/decision/resolve calls died with the process. The phone then kept live
  // Answer/Deny cards for dead prompts. Both orderings (retired BY the disconnect, and still-open at
  // stop time) must be awaited.
  test("stop() waits for every retirement POST — including the ones the disconnect started", async () => {
    // One INDEPENDENT gate per retirement, so the test can prove which POSTs stop() actually awaits.
    const gates: Array<() => void> = [];
    const h = harness({ retirement: () => new Promise<void>((resolve) => { gates.push(resolve); }) });
    const settle = (): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    await h.bridge.start();
    const second = { ...request, identity: { ...request.identity, itemId: "item-2" } };
    h.client().callbacks.onUserInputRequest(request);
    h.client().callbacks.onUserInputRequest(second);
    expect(h.handles).toHaveLength(2);
    h.client().resolveOnStop.push(second); // the disconnect resolves this one from inside client.stop()

    let stopped = false;
    const stopping = h.bridge.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false);                                   // still waiting on the resolve POSTs
    expect(h.handles.map((item) => item.resolved)).toEqual([1, 1]); // both retirements STARTED, once each
    expect(gates).toHaveLength(2);                                 // gates[0] = the disconnect's, gates[1] = the still-open handle's

    // Releasing ONLY the handle stop() itself retired is not enough: the disconnect's retirement — the
    // one the old snapshot-after-stop() ordering abandoned — must be awaited too.
    gates[1]();
    await settle();
    expect(stopped).toBe(false);
    expect(h.handles.map((item) => item.retired)).toEqual([1, 0]);

    gates[0]();
    await stopping;
    expect(stopped).toBe(true);
    expect(h.handles.map((item) => item.retired)).toEqual([1, 1]); // both COMPLETED before stop() resolved
  });

  test("does not retire the relay as resolved elsewhere after its own turn interrupt", async () => {
    const h = harness();
    await h.bridge.start();
    h.client().callbacks.onUserInputRequest(request);
    h.client().callbacks.onUserInputResolved(request, "interrupt-sent");
    await Promise.resolve();
    expect(h.handles[0].resolved).toBe(0);
    h.handles[0].completion.resolve("denied");
    await h.bridge.stop();
  });
});
