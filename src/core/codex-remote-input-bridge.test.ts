import { describe, expect, test } from "bun:test";
import {
  CodexAppServerState,
  CodexLoadedThreadListResult,
  CodexThreadResumeResult,
  CodexUserInputAnswerResult,
  CodexUserInputAnswers,
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
  pages: CodexLoadedThreadListResult[] = [];
  resumed: string[] = [];
  answers: { identity: CodexUserInputRequestIdentity; answers: CodexUserInputAnswers }[] = [];

  constructor(readonly callbacks: CodexRemoteInputBridgeCallbacks) {}
  async start(): Promise<boolean> { this.state = "ready"; this.callbacks.onStateChange("ready"); return true; }
  async stop(): Promise<void> { this.state = "stopped"; this.callbacks.onStateChange("stopped"); }
  async listLoadedThreads(): Promise<CodexLoadedThreadListResult> {
    return this.pages.shift() ?? { data: [], nextCursor: null };
  }
  async resumeThread(threadId: string): Promise<CodexThreadResumeResult> {
    this.resumed.push(threadId);
    return { thread: { id: threadId } };
  }
  async answerUserInput(
    identity: CodexUserInputRequestIdentity,
    answers: CodexUserInputAnswers,
  ): Promise<CodexUserInputAnswerResult> {
    this.answers.push({ identity, answers });
    return "sent";
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  let client!: FakeClient;
  const handles: {
    request: CodexUserInputRequest;
    completion: ReturnType<typeof deferred<CodexRemoteInputResult>>;
    resolved: number;
    answer: (answers: CodexUserInputAnswers) => Promise<CodexUserInputAnswerResult>;
  }[] = [];
  const bridge = new CodexRemoteInputBridge(config, {
    createClient: (callbacks) => (client = new FakeClient(callbacks)),
    startRemoteInputFn: (incoming, deps): CodexRemoteInputHandle => {
      const completion = deferred<CodexRemoteInputResult>();
      const item = { request: incoming, completion, resolved: 0, answer: deps.answerAppServer };
      handles.push(item);
      return {
        requestId: `relay-${handles.length}`,
        completion: completion.promise,
        async resolvedElsewhere() { item.resolved += 1; completion.resolve("resolved-elsewhere"); },
      };
    },
  });
  return { bridge, client: () => client, handles };
}

describe("CodexRemoteInputBridge", () => {
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
});
