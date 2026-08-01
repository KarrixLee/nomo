// codex-remote-input-bridge — lifecycle coordinator between the shared Codex app-server process
// and Nomo's blind remote-decision relay.

import {
  CodexAppServerClient,
  CodexAppServerState,
  CodexLoadedThreadListResult,
  CodexThreadResumeResult,
  CodexThreadStatus,
  CodexUserInputAnswerResult,
  CodexUserInputAnswers,
  CodexUserInputInterruptResult,
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
  readThreadStatus(threadId: string): Promise<CodexThreadStatus>;
  answerUserInput(identity: CodexUserInputRequestIdentity, answers: CodexUserInputAnswers): Promise<CodexUserInputAnswerResult>;
  interruptUserInput(identity: CodexUserInputRequestIdentity): Promise<CodexUserInputInterruptResult>;
}

/** The only distinction the watchdog needs. Unknown means there is no authoritative dismissal proof. */
export type CodexThreadWaitState = "waitingOnUserInput" | "notWaitingOnUserInput" | "unavailable";

export interface CodexRemoteInputBridgeCallbacks {
  onUserInputRequest(request: CodexUserInputRequest): void;
  onUserInputResolved(request: CodexUserInputRequest, resolution: CodexUserInputResolution): void;
  onStateChange(state: CodexAppServerState): void;
}

export interface CodexRemoteInputBridgeOptions {
  createClient?: (callbacks: CodexRemoteInputBridgeCallbacks) => BridgeClient;
  startRemoteInputFn?: (request: CodexUserInputRequest, deps: CodexRemoteInputDeps) => CodexRemoteInputHandle;
  /** Diagnostic seam for the app-server client and every detached relay task. Never fatal. */
  onError?: (error: Error) => void;
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
  private readonly onError: CodexRemoteInputBridgeOptions["onError"];
  private readonly subscribedThreads = new Set<string>();
  private readonly handles = new Map<string, CodexRemoteInputHandle>();
  /** In-flight `resolvedElsewhere()` retirements (each POST /cc/decision/resolve). Tracked so stop() can
   *  await them: the disconnect inside client.stop() routes every pending request through onResolved,
   *  which starts a retirement fire-and-forget — abandoning those POSTs on process exit leaves the phone
   *  showing live Answer/Deny cards for dead prompts. */
  private readonly pendingRetirements = new Set<Promise<void>>();
  private refreshPromise: Promise<void> | undefined;
  private stopping = false;

  constructor(private readonly config: Config, options: CodexRemoteInputBridgeOptions = {}) {
    this.startRemoteInputFn = options.startRemoteInputFn ?? startCodexRemoteInput;
    this.onError = options.onError;
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
      onError: (error) => this.reportError(error),
    });
  }

  private reportError(error: unknown, fallback = "Codex remote input bridge error"): void {
    try {
      this.onError?.(error instanceof Error ? error : new Error(`${fallback}: ${String(error)}`));
    } catch { /* a broken reporter must not break the bridge */ }
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

  /** Query only an already-pending Plan-picker thread. The watchdog may use explicit waiting as
   * confirmation, but client-side TUI pickers report daemon idle both before and after dismissal, so
   * `notWaitingOnUserInput` is never itself an exit signal. Errors fail open to unavailable. */
  async readThreadWaitState(threadId: string): Promise<CodexThreadWaitState> {
    if (this.client.state !== "ready" || this.stopping) return "unavailable";
    try {
      const status = await this.client.readThreadStatus(threadId);
      if (status.type === "idle") return "notWaitingOnUserInput";
      if (status.type === "active") {
        return status.activeFlags.includes("waitingOnUserInput")
          ? "waitingOnUserInput"
          : "notWaitingOnUserInput";
      }
      return "unavailable";
    } catch {
      return "unavailable";
    }
  }

  /** Start one handle's retirement and REMEMBER the promise, so stop() can wait for the POST that tells
   *  the worker the card is dead. `resolvedElsewhere()` is idempotent (it memoizes its own promise), so
   *  retiring a handle onResolved already retired is a free no-op. */
  private retire(handle: CodexRemoteInputHandle, fallback: string): void {
    const retirement = handle.resolvedElsewhere().catch((error: unknown) => this.reportError(error, fallback));
    this.pendingRetirements.add(retirement);
    retirement.then(() => { this.pendingRetirements.delete(retirement); }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    // SNAPSHOT FIRST. client.stop() disconnects, and the disconnect routes every pending request through
    // onResolved, which DELETES the handle and starts its retirement — so a snapshot taken afterwards is
    // empty and `Promise.allSettled([])` resolved instantly, abandoning the in-flight resolve POSTs the
    // moment the process exited. Retiring from the pre-stop snapshot AND awaiting `pendingRetirements`
    // (which onResolved feeds through the same helper) covers both orderings.
    const handles = [...this.handles.values()];
    await this.client.stop();
    for (const handle of this.handles.values()) handles.push(handle); // anything started during stop()
    this.handles.clear();
    for (const handle of new Set(handles)) this.retire(handle, "Failed to retire a Codex phone card");
    await Promise.allSettled([...this.pendingRetirements]);
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
      interruptAppServer: () => this.client.interruptUserInput(request.identity),
      onError: (error) => this.reportError(error),
    });
    this.handles.set(key, handle);
    // This chain is detached, so it must be terminally handled: `.finally()` returns a NEW promise that
    // rejects whenever the completion rejects, and voiding that is an unhandled rejection — fatal for
    // the watchdog process under Node >= 15.
    handle.completion.then(
      () => undefined,
      (error: unknown) => this.reportError(error, "Codex remote input failed"),
    ).then(() => {
      if (this.handles.get(key) === handle) this.handles.delete(key);
    }).catch(() => undefined);
  }

  private onResolved(request: CodexUserInputRequest, resolution: CodexUserInputResolution): void {
    const key = requestKey(request);
    const handle = this.handles.get(key);
    if (!handle) return;
    this.handles.delete(key);
    // A response/interrupt sent by this bridge is the acknowledgement for our own phone action. Every
    // other resolution means Desktop, another interrupt, or a disconnect won; retire the phone card.
    if (resolution !== "response-sent" && resolution !== "interrupt-sent") {
      this.retire(handle, "Failed to retire a Codex phone card");
    }
  }

  private onStateChange(state: CodexAppServerState): void {
    if (state === "ready") {
      this.subscribedThreads.clear();
      this.refreshSubscriptions().catch((error: unknown) =>
        this.reportError(error, "Failed to refresh Codex thread subscriptions"));
    } else if (state === "disconnected" || state === "stopped") {
      this.subscribedThreads.clear();
    }
  }
}
