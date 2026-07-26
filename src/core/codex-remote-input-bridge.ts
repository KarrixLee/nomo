// codex-remote-input-bridge — lifecycle coordinator between the shared Codex app-server process
// and Nomo's blind remote-decision relay.

import {
  CodexAppServerClient,
  CodexAppServerState,
  CodexLoadedThreadListResult,
  CodexThreadResumeResult,
  CodexUserInputAnswerResult,
  CodexUserInputAnswers,
  CodexUserInputRequest,
  CodexUserInputRequestIdentity,
  CodexUserInputResolution,
} from "./codex-app-server-client";
import { CodexProxyTransport } from "./codex-proxy-transport";
import {
  CodexRemoteInputDeps,
  CodexRemoteInputHandle,
  startCodexRemoteInput,
} from "./codex-remote-input";
import { Config, PLUGIN_VERSION } from "./shared";

const LOADED_PAGE_SIZE = 100;
const RECONNECT_DELAY_MS = 5_000;

interface BridgeClient {
  readonly state: CodexAppServerState;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  listLoadedThreads(params?: { cursor?: string | null; limit?: number | null }): Promise<CodexLoadedThreadListResult>;
  resumeThread(threadId: string): Promise<CodexThreadResumeResult>;
  answerUserInput(identity: CodexUserInputRequestIdentity, answers: CodexUserInputAnswers): Promise<CodexUserInputAnswerResult>;
}

export interface CodexRemoteInputBridgeCallbacks {
  onUserInputRequest(request: CodexUserInputRequest): void;
  onUserInputResolved(request: CodexUserInputRequest, resolution: CodexUserInputResolution): void;
  onStateChange(state: CodexAppServerState): void;
}

export interface CodexRemoteInputBridgeOptions {
  createClient?: (callbacks: CodexRemoteInputBridgeCallbacks) => BridgeClient;
  startRemoteInputFn?: (request: CodexUserInputRequest, deps: CodexRemoteInputDeps) => CodexRemoteInputHandle;
}

function requestKey(request: CodexUserInputRequest): string {
  const identity = request.identity;
  return JSON.stringify([
    identity.connectionEpoch,
    typeof identity.requestId,
    identity.requestId,
    identity.threadId,
    identity.turnId,
    identity.itemId,
  ]);
}

/**
 * One bridge is scoped to one pairing config. It is intentionally silent and fail-open: without a
 * shared Codex app-server daemon/socket, normal hooks and status mirroring continue unchanged and no
 * actionable phone picker is emitted.
 */
export class CodexRemoteInputBridge {
  private readonly client: BridgeClient;
  private readonly startRemoteInputFn: NonNullable<CodexRemoteInputBridgeOptions["startRemoteInputFn"]>;
  private readonly subscribedThreads = new Set<string>();
  private readonly handles = new Map<string, CodexRemoteInputHandle>();
  private refreshPromise: Promise<void> | undefined;
  private stopping = false;

  constructor(private readonly config: Config, options: CodexRemoteInputBridgeOptions = {}) {
    this.startRemoteInputFn = options.startRemoteInputFn ?? startCodexRemoteInput;
    const callbacks: CodexRemoteInputBridgeCallbacks = {
      onUserInputRequest: (request) => this.onRequest(request),
      onUserInputResolved: (request, resolution) => this.onResolved(request, resolution),
      onStateChange: (state) => this.onStateChange(state),
    };
    this.client = options.createClient?.(callbacks) ?? new CodexAppServerClient({
      transportFactory: () => new CodexProxyTransport(),
      clientVersion: PLUGIN_VERSION,
      reconnectDelayMs: RECONNECT_DELAY_MS,
      ...callbacks,
    });
  }

  /** Start the app-server connection. False means unavailable now; the client retries quietly. */
  async start(): Promise<boolean> {
    this.stopping = false;
    const connected = await this.client.start();
    if (connected) await this.refreshSubscriptions();
    return connected;
  }

  /** Discover and subscribe only threads loaded in this app-server process, never old history. */
  refreshSubscriptions(): Promise<void> {
    if (this.client.state !== "ready" || this.stopping) return Promise.resolve();
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshLoadedThreads().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.client.stop();
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.allSettled(handles.map((handle) => handle.resolvedElsewhere()));
    this.subscribedThreads.clear();
  }

  private async refreshLoadedThreads(): Promise<void> {
    let cursor: string | null = null;
    do {
      if (this.client.state !== "ready" || this.stopping) return;
      let page: CodexLoadedThreadListResult;
      try {
        page = await this.client.listLoadedThreads({ cursor, limit: LOADED_PAGE_SIZE });
      } catch {
        return;
      }
      for (const threadId of page.data) {
        if (this.client.state !== "ready" || this.stopping) return;
        if (this.subscribedThreads.has(threadId)) continue;
        try {
          await this.client.resumeThread(threadId);
          this.subscribedThreads.add(threadId);
        } catch {
          // A thread can unload between list and resume. The next watchdog sweep can try again.
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  private onRequest(request: CodexUserInputRequest): void {
    if (this.stopping) return;
    const key = requestKey(request);
    if (this.handles.has(key)) return;
    const handle = this.startRemoteInputFn(request, {
      config: this.config,
      answerAppServer: (answers) => this.client.answerUserInput(request.identity, answers),
    });
    this.handles.set(key, handle);
    void handle.completion.finally(() => {
      if (this.handles.get(key) === handle) this.handles.delete(key);
    });
  }

  private onResolved(request: CodexUserInputRequest, resolution: CodexUserInputResolution): void {
    const key = requestKey(request);
    const handle = this.handles.get(key);
    if (!handle) return;
    this.handles.delete(key);
    // A response-sent resolution is the acknowledgement for our own phone answer. Every other
    // resolution means Desktop, an interrupt, or a disconnect won; retire the phone card.
    if (resolution !== "response-sent") void handle.resolvedElsewhere();
  }

  private onStateChange(state: CodexAppServerState): void {
    if (state === "ready") {
      this.subscribedThreads.clear();
      void this.refreshSubscriptions();
    } else if (state === "disconnected" || state === "stopped") {
      this.subscribedThreads.clear();
    }
  }
}
