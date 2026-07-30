// codex-app-server-client — transport-agnostic lifecycle for Codex app-server remote input.
//
// The app-server control socket speaks websocket frames (normally reached through
// `codex app-server proxy`). Framing is deliberately kept OUT of this module: the bridge entrypoint
// supplies a CodexRpcTransport, while this file owns the security-sensitive part of the contract —
// initialization, subscription, exact request identity, one response per request, stale-request
// rejection, and fail-open disconnect handling.

export type CodexRequestId = string | number;

export interface CodexUserInputOption {
  label: string;
  description: string;
}

export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexUserInputOption[] | null;
}

/** Identity is connection-scoped because app-server request ids may be reused after reconnect. */
export interface CodexUserInputRequestIdentity {
  connectionEpoch: number;
  requestId: CodexRequestId;
  threadId: string;
  turnId: string;
  itemId: string;
}

export interface CodexUserInputRequest {
  identity: CodexUserInputRequestIdentity;
  questions: CodexUserInputQuestion[];
  autoResolutionMs: number | null;
  receivedAtMs: number;
}

export type CodexUserInputAnswers = Record<string, readonly string[]>;

export type CodexUserInputAnswerResult =
  | "sent"
  | "stale"
  | "already-sent"
  | "invalid"
  | "transport-error";

export type CodexUserInputInterruptResult = Exclude<CodexUserInputAnswerResult, "invalid">;

export type CodexUserInputResolution =
  /** This client sent a response and app-server subsequently closed the request. */
  | "response-sent"
  /** This client interrupted the owning turn and app-server subsequently closed the request. */
  | "interrupt-sent"
  /** App-server cleared the request before this client answered (Mac answer, interrupt, or cleanup). */
  | "server-cleared"
  /** The connection disappeared. The request must not be replayed on a later connection. */
  | "connection-lost";

export type CodexAppServerState = "stopped" | "connecting" | "ready" | "disconnected";

export interface CodexRpcTransportHandlers {
  onMessage(message: unknown): void;
  onClose(error?: unknown): void;
}

/**
 * One connected app-server byte/message stream. Implementations may wrap websocket-over-stdio,
 * a direct websocket, or an in-memory test transport. Messages are already decoded JSON values.
 */
export interface CodexRpcTransport {
  open(handlers: CodexRpcTransportHandlers): Promise<void>;
  send(message: object): Promise<void>;
  close(): Promise<void> | void;
}

export type CodexRpcTransportFactory = () => CodexRpcTransport;

export interface CodexThreadSummary {
  id: string;
  [key: string]: unknown;
}

export interface CodexThreadListResult {
  data: CodexThreadSummary[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
  [key: string]: unknown;
}

export interface CodexLoadedThreadListResult {
  /** Thread ids currently materialized in this shared app-server process. */
  data: string[];
  nextCursor: string | null;
}

export interface CodexThreadResumeResult {
  thread: CodexThreadSummary;
  [key: string]: unknown;
}

/** Exact 0.146.0 v2 thread runtime status shape. Kept narrow so a future protocol drift fails open. */
export type CodexThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput"> };

export interface CodexAppServerClientOptions {
  transportFactory: CodexRpcTransportFactory;
  clientVersion: string;
  clientName?: string;
  clientTitle?: string;
  reconnectDelayMs?: number;
  /** Ceiling for the exponential reconnect backoff. */
  maxReconnectDelayMs?: number;
  /** Consecutive failed connects before the client parks itself in "stopped" until start() runs again. */
  maxReconnectAttempts?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (token: unknown) => void;
  onUserInputRequest?: (request: CodexUserInputRequest) => void;
  onUserInputResolved?: (request: CodexUserInputRequest, resolution: CodexUserInputResolution) => void;
  onStateChange?: (state: CodexAppServerState) => void;
  onError?: (error: Error) => void;
}

interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

interface PendingUserInput {
  request: CodexUserInputRequest;
  responseSent: boolean;
  /** A turn/interrupt was put on the wire. Sticky: the interrupt may have landed even if the reply did not. */
  interruptAttempted: boolean;
  /** app-server acknowledged the turn/interrupt. */
  interruptConfirmed: boolean;
  /** A turn/interrupt is on the wire right now. */
  interruptInFlight: boolean;
  /** Local mirror of app-server's autoResolutionMs deadline. */
  expiryTimer: unknown;
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 300_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const defaultSetTimer = (callback: () => void, delayMs: number): unknown => {
  const token = setTimeout(callback, delayMs);
  // A disconnected background bridge must not keep node alive by itself.
  if (typeof token === "object" && token !== null && "unref" in token) {
    (token as { unref(): void }).unref();
  }
  return token;
};

const defaultClearTimer = (token: unknown): void => clearTimeout(token as ReturnType<typeof setTimeout>);

function rpcIdKey(id: CodexRequestId): string {
  return `${typeof id}:${String(id)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseRequestId(value: unknown): CodexRequestId | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

function parseThreadStatus(value: unknown): CodexThreadStatus | undefined {
  const status = asRecord(value);
  if (!status || typeof status.type !== "string") return undefined;
  if (status.type === "notLoaded" || status.type === "idle" || status.type === "systemError") {
    return { type: status.type };
  }
  if (status.type !== "active" || !Array.isArray(status.activeFlags)) return undefined;
  const activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput"> = [];
  for (const flag of status.activeFlags) {
    if (flag !== "waitingOnApproval" && flag !== "waitingOnUserInput") return undefined;
    activeFlags.push(flag);
  }
  return { type: "active", activeFlags };
}

function parseQuestion(value: unknown): CodexUserInputQuestion | undefined {
  const q = asRecord(value);
  if (!q || typeof q.id !== "string" || q.id.length === 0 ||
      typeof q.header !== "string" || typeof q.question !== "string" || q.question.length === 0 ||
      typeof q.isOther !== "boolean" || typeof q.isSecret !== "boolean") return undefined;

  let options: CodexUserInputOption[] | null = null;
  if (q.options !== null && q.options !== undefined) {
    if (!Array.isArray(q.options)) return undefined;
    options = [];
    for (const raw of q.options) {
      const option = asRecord(raw);
      if (!option || typeof option.label !== "string" || option.label.length === 0 ||
          typeof option.description !== "string") return undefined;
      options.push({ label: option.label, description: option.description });
    }
    if (options.length === 0) return undefined;
  }

  return {
    id: q.id,
    header: q.header,
    question: q.question,
    isOther: q.isOther,
    isSecret: q.isSecret,
    options,
  };
}

function parseUserInputParams(value: unknown): Omit<CodexUserInputRequest, "identity" | "receivedAtMs"> &
  Omit<CodexUserInputRequestIdentity, "connectionEpoch" | "requestId"> | undefined {
  const params = asRecord(value);
  if (!params || typeof params.threadId !== "string" || params.threadId.length === 0 ||
      typeof params.turnId !== "string" || params.turnId.length === 0 ||
      typeof params.itemId !== "string" || params.itemId.length === 0 ||
      !Array.isArray(params.questions) || params.questions.length === 0) return undefined;

  const questions: CodexUserInputQuestion[] = [];
  const ids = new Set<string>();
  for (const raw of params.questions) {
    const question = parseQuestion(raw);
    if (!question || ids.has(question.id)) return undefined;
    ids.add(question.id);
    questions.push(question);
  }

  const autoResolutionMs = params.autoResolutionMs === null || params.autoResolutionMs === undefined
    ? null
    : typeof params.autoResolutionMs === "number" && Number.isFinite(params.autoResolutionMs) && params.autoResolutionMs >= 0
      ? params.autoResolutionMs
      : undefined;
  if (autoResolutionMs === undefined) return undefined;

  return {
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    questions,
    autoResolutionMs,
  };
}

function identitiesEqual(a: CodexUserInputRequestIdentity, b: CodexUserInputRequestIdentity): boolean {
  return a.connectionEpoch === b.connectionEpoch && a.requestId === b.requestId &&
    a.threadId === b.threadId && a.turnId === b.turnId && a.itemId === b.itemId;
}

function validAnswers(request: CodexUserInputRequest, answers: CodexUserInputAnswers): boolean {
  const keys = Object.keys(answers);
  if (keys.length !== request.questions.length) return false;
  const known = new Set(request.questions.map((q) => q.id));
  if (keys.some((key) => !known.has(key))) return false;

  for (const question of request.questions) {
    const selected = answers[question.id];
    if (!Array.isArray(selected) || selected.length === 0 ||
        selected.some((answer) => typeof answer !== "string" || answer.trim().length === 0)) return false;
    // A question which offers an "Other" path may carry free-form text. Otherwise pin every answer
    // to an exact app-server label so a truncated/forged phone value cannot change the selection.
    if (question.options !== null && !question.isOther) {
      const labels = new Set(question.options.map((option) => option.label));
      if (selected.some((answer) => !labels.has(answer))) return false;
    }
  }
  return true;
}

/** A small JSON-RPC peer specialized for app-server request_user_input. */
export class CodexAppServerClient {
  private readonly options: Required<Pick<CodexAppServerClientOptions,
    "clientName" | "clientTitle" | "reconnectDelayMs" | "maxReconnectDelayMs" | "maxReconnectAttempts" |
    "requestTimeoutMs" | "now" | "setTimer" | "clearTimer">> &
    CodexAppServerClientOptions;
  private stateValue: CodexAppServerState = "stopped";
  private shouldRun = false;
  private connectionEpoch = 0;
  private transport: CodexRpcTransport | undefined;
  private reconnectTimer: unknown;
  /** Consecutive failed connects since the last successful handshake (drives the backoff). */
  private reconnectAttempts = 0;
  private nextRpcId = 1;
  private readonly pendingRpc = new Map<string, PendingRpc>();
  private readonly pendingUserInput = new Map<string, PendingUserInput>();
  private connectPromise: Promise<boolean> | undefined;

  constructor(options: CodexAppServerClientOptions) {
    this.options = {
      ...options,
      clientName: options.clientName ?? "nomo",
      clientTitle: options.clientTitle ?? "Nomo Remote Input",
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      maxReconnectAttempts: options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      now: options.now ?? Date.now,
      setTimer: options.setTimer ?? defaultSetTimer,
      clearTimer: options.clearTimer ?? defaultClearTimer,
    };
  }

  get state(): CodexAppServerState { return this.stateValue; }

  /**
   * Start now; a failed attempt returns false and is retried in the background with exponential
   * backoff until stop() — or until the backoff gives up, which parks the client in "stopped" and
   * waits for the next start(). The watchdog re-arms periodically, so giving up is never terminal.
   */
  async start(): Promise<boolean> {
    this.shouldRun = true;
    this.reconnectAttempts = 0;
    return this.connect();
  }

  async stop(): Promise<void> {
    this.shouldRun = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer !== undefined) {
      this.options.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const transport = this.transport;
    this.disconnect(this.connectionEpoch, "connection-lost", false);
    // Invalidate any connect still in flight: its transport is orphaned by the epoch bump and a later
    // start() must never be handed back the dead attempt's promise (which would leave shouldRun=true
    // with no transport and no retry timer).
    this.connectionEpoch += 1;
    this.connectPromise = undefined;
    try { await transport?.close(); } catch { /* already fail-open */ }
    this.setState("stopped");
  }

  async listThreads(params: Record<string, unknown> = {}): Promise<CodexThreadListResult> {
    const result = asRecord(await this.request("thread/list", params));
    if (!result || !Array.isArray(result.data)) throw new Error("Invalid thread/list response");
    const data: CodexThreadSummary[] = [];
    for (const value of result.data) {
      const thread = asRecord(value);
      if (!thread || typeof thread.id !== "string" || thread.id.length === 0) {
        throw new Error("Invalid thread/list thread");
      }
      data.push(thread as CodexThreadSummary);
    }
    return { ...result, data } as CodexThreadListResult;
  }

  /**
   * Discover only live, in-memory threads. The coordinator should resume/subscribe these ids instead
   * of walking historical thread/list results, which would wake old sessions and create false phone
   * rows. Call again with nextCursor until it is null.
   */
  async listLoadedThreads(params: { cursor?: string | null; limit?: number | null } = {}): Promise<CodexLoadedThreadListResult> {
    const result = asRecord(await this.request("thread/loaded/list", params));
    if (!result || !Array.isArray(result.data) || result.data.some((id) => typeof id !== "string" || id.length === 0) ||
        !(result.nextCursor === null || typeof result.nextCursor === "string")) {
      throw new Error("Invalid thread/loaded/list response");
    }
    return { data: [...result.data] as string[], nextCursor: result.nextCursor };
  }

  /** Resume also subscribes this connection to live events for the thread. */
  async resumeThread(threadId: string, params: Record<string, unknown> = {}): Promise<CodexThreadResumeResult> {
    if (threadId.length === 0) throw new Error("threadId is required");
    const result = asRecord(await this.request("thread/resume", { ...params, threadId }));
    const thread = asRecord(result?.thread);
    if (!result || !thread || thread.id !== threadId) throw new Error("Invalid thread/resume response");
    return { ...result, thread: thread as CodexThreadSummary } as CodexThreadResumeResult;
  }

  /** Read the current runtime status without loading turn history. This is the 0.146.0 `thread/read`
   * request; callers treat notLoaded/systemError, protocol drift, and transport errors as unavailable. */
  async readThreadStatus(threadId: string): Promise<CodexThreadStatus> {
    if (threadId.length === 0) throw new Error("threadId is required");
    const result = asRecord(await this.request("thread/read", { threadId, includeTurns: false }));
    const thread = asRecord(result?.thread);
    const status = parseThreadStatus(thread?.status);
    if (!result || !thread || thread.id !== threadId || !status) {
      throw new Error("Invalid thread/read response");
    }
    return status;
  }

  async answerUserInput(
    identity: CodexUserInputRequestIdentity,
    answers: CodexUserInputAnswers,
  ): Promise<CodexUserInputAnswerResult> {
    const key = rpcIdKey(identity.requestId);
    const pending = this.pendingUserInput.get(key);
    if (!pending || !identitiesEqual(pending.request.identity, identity)) return "stale";
    if (pending.responseSent || pending.interruptConfirmed || pending.interruptInFlight) return "already-sent";
    if (!validAnswers(pending.request, answers)) return "invalid";
    if (this.stateValue !== "ready" || identity.connectionEpoch !== this.connectionEpoch || !this.transport) return "stale";

    pending.responseSent = true;
    const wireAnswers: Record<string, { answers: string[] }> = {};
    for (const question of pending.request.questions) {
      wireAnswers[question.id] = { answers: [...answers[question.id]] };
    }
    try {
      await this.transport.send({ id: identity.requestId, result: { answers: wireAnswers } });
      return "sent";
    } catch (error) {
      this.reportError(error, "Failed to answer Codex user input");
      this.disconnect(this.connectionEpoch, "connection-lost", true);
      return "transport-error";
    }
  }

  /** Match the Codex TUI's escape action for request_user_input by interrupting its active turn. */
  async interruptUserInput(
    identity: CodexUserInputRequestIdentity,
  ): Promise<CodexUserInputInterruptResult> {
    const key = rpcIdKey(identity.requestId);
    const pending = this.pendingUserInput.get(key);
    if (!pending || !identitiesEqual(pending.request.identity, identity)) return "stale";
    if (pending.responseSent || pending.interruptConfirmed || pending.interruptInFlight) return "already-sent";
    if (this.stateValue !== "ready" || identity.connectionEpoch !== this.connectionEpoch || !this.transport) {
      return "stale";
    }

    // The TUI does not synthesize a fake answer when the user rejects this prompt. It issues the
    // documented turn/interrupt request, which clears the pending server request and finishes the turn
    // as interrupted. Mark the ATTEMPT before sending so serverRequest/resolved is attributed to us:
    // a timed-out reply does not mean the interrupt failed to land, and reporting such a turn as
    // "server-cleared" would retire a card the user actually denied.
    pending.interruptAttempted = true;
    pending.interruptInFlight = true;
    try {
      await this.request("turn/interrupt", {
        threadId: identity.threadId,
        turnId: identity.turnId,
      });
      pending.interruptInFlight = false;
      pending.interruptConfirmed = true;
      return "sent";
    } catch (error) {
      // Unconfirmed only. `interruptAttempted` stays set (attribution), while a retry stays possible.
      pending.interruptInFlight = false;
      this.reportError(error, "Failed to interrupt Codex user input");
      return "transport-error";
    }
  }

  private connect(): Promise<boolean> {
    if (!this.shouldRun) return Promise.resolve(false);
    if (this.stateValue === "ready") return Promise.resolve(true);
    if (this.connectPromise) return this.connectPromise;
    // Only clear the slot if it still holds THIS attempt: stop() may already have dropped it.
    const attempt: Promise<boolean> = this.connectOnce().finally(() => {
      if (this.connectPromise === attempt) this.connectPromise = undefined;
    });
    this.connectPromise = attempt;
    return attempt;
  }

  private async connectOnce(): Promise<boolean> {
    this.setState("connecting");
    const epoch = ++this.connectionEpoch;
    const transport = this.options.transportFactory();
    this.transport = transport;
    try {
      await transport.open({
        onMessage: (message) => this.onMessage(epoch, message),
        onClose: (error) => {
          if (error !== undefined) this.reportError(error, "Codex app-server transport closed");
          this.disconnect(epoch, "connection-lost", true);
        },
      });
      // A stop()/reconnect that raced this open owns the lifecycle now; this transport is orphaned and
      // must be closed here or its child process outlives us.
      if (epoch !== this.connectionEpoch || this.transport !== transport || !this.shouldRun) {
        await this.abandon(transport);
        return false;
      }
      await this.request("initialize", {
        clientInfo: {
          name: this.options.clientName,
          title: this.options.clientTitle,
          version: this.options.clientVersion,
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, true);
      if (epoch !== this.connectionEpoch || this.transport !== transport || !this.shouldRun) {
        await this.abandon(transport);
        return false;
      }
      await transport.send({ method: "initialized" });
      this.reconnectAttempts = 0; // a completed handshake resets the backoff
      this.setState("ready");
      return true;
    } catch (error) {
      this.reportError(error, "Failed to initialize Codex app-server");
      this.disconnect(epoch, "connection-lost", true);
      try { await transport.close(); } catch { /* already fail-open */ }
      return false;
    }
  }

  private request(method: string, params: Record<string, unknown>, duringInitialize = false): Promise<unknown> {
    if (!this.transport || (!duringInitialize && this.stateValue !== "ready")) {
      return Promise.reject(new Error("Codex app-server is not ready"));
    }
    const id = this.nextRpcId++;
    const key = rpcIdKey(id);
    return new Promise((resolve, reject) => {
      const timer = this.options.setTimer(() => {
        this.pendingRpc.delete(key);
        reject(new Error(`${method} timed out`));
      }, this.options.requestTimeoutMs);
      this.pendingRpc.set(key, { resolve, reject, timer });
      this.transport!.send({ method, id, params }).catch((error) => {
        const pending = this.pendingRpc.get(key);
        if (!pending) return;
        this.pendingRpc.delete(key);
        this.options.clearTimer(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private onMessage(epoch: number, message: unknown): void {
    if (epoch !== this.connectionEpoch) return;
    const envelope = asRecord(message);
    if (!envelope) {
      this.reportError(new Error("Non-object JSON-RPC message"));
      return;
    }

    const id = parseRequestId(envelope.id);
    if (typeof envelope.method === "string") {
      if (envelope.method === "item/tool/requestUserInput" && id !== undefined) {
        this.onUserInputRequest(epoch, id, envelope.params);
      } else if (envelope.method === "serverRequest/resolved" && id === undefined) {
        this.onServerRequestResolved(envelope.params);
      }
      return;
    }
    if (id === undefined) return;

    const key = rpcIdKey(id);
    const pending = this.pendingRpc.get(key);
    if (!pending) return; // a late response after timeout/disconnect
    this.pendingRpc.delete(key);
    this.options.clearTimer(pending.timer);
    const error = asRecord(envelope.error);
    if (error && typeof error.code === "number" && typeof error.message === "string") {
      const rpcError = error as unknown as RpcErrorObject;
      pending.reject(new Error(`Codex RPC ${rpcError.code}: ${rpcError.message}`));
    } else if ("result" in envelope) {
      pending.resolve(envelope.result);
    } else {
      pending.reject(new Error("Malformed Codex RPC response"));
    }
  }

  private onUserInputRequest(epoch: number, id: CodexRequestId, rawParams: unknown): void {
    if (this.stateValue !== "ready") {
      // Fail open, but never silently: a request arriving between initialize and ready is dropped and
      // the phone will never see that prompt.
      this.reportError(new Error("Dropped item/tool/requestUserInput before the connection was ready"));
      return;
    }
    const parsed = parseUserInputParams(rawParams);
    if (!parsed) {
      this.reportError(new Error("Invalid item/tool/requestUserInput payload"));
      return;
    }
    const key = rpcIdKey(id);
    const existing = this.pendingUserInput.get(key);
    if (existing) {
      // app-server reuses numeric request ids. An entry we already answered/interrupted but whose
      // serverRequest/resolved never arrived must not block the id forever — the new request IS the
      // proof the old one closed. Retire it and take the id. A genuinely live duplicate is a protocol
      // violation: report it and keep the live request (dropping it is fail-open).
      if (existing.responseSent || existing.interruptAttempted) {
        this.resolvePending(key, existing,
          existing.responseSent ? "response-sent" : "interrupt-sent");
      } else {
        this.reportError(new Error("Duplicate app-server request id"));
        return;
      }
    }
    const request: CodexUserInputRequest = {
      identity: {
        connectionEpoch: epoch,
        requestId: id,
        threadId: parsed.threadId,
        turnId: parsed.turnId,
        itemId: parsed.itemId,
      },
      questions: parsed.questions,
      autoResolutionMs: parsed.autoResolutionMs,
      receivedAtMs: this.options.now(),
    };
    const entry: PendingUserInput = {
      request,
      responseSent: false,
      interruptAttempted: false,
      interruptConfirmed: false,
      interruptInFlight: false,
      expiryTimer: undefined,
    };
    this.pendingUserInput.set(key, entry);
    this.armAutoResolution(key, entry);
    this.options.onUserInputRequest?.(request);
  }

  /**
   * app-server drops the prompt on its own once autoResolutionMs elapses. Mirror that deadline locally
   * so a phone card can never outlive the prompt it points at (the resolved notification for an
   * auto-resolved request is not guaranteed to reach us).
   */
  private armAutoResolution(key: string, entry: PendingUserInput): void {
    const timeoutMs = entry.request.autoResolutionMs;
    if (timeoutMs === null) return;
    entry.expiryTimer = this.options.setTimer(() => {
      entry.expiryTimer = undefined;
      if (this.pendingUserInput.get(key) !== entry) return;
      this.resolvePending(key, entry, this.attributionOf(entry));
    }, timeoutMs);
  }

  private attributionOf(pending: PendingUserInput): CodexUserInputResolution {
    return pending.responseSent ? "response-sent"
      : pending.interruptAttempted ? "interrupt-sent"
        : "server-cleared";
  }

  /** Remove one pending request, clear its timer, and notify exactly once. */
  private resolvePending(key: string, pending: PendingUserInput, resolution: CodexUserInputResolution): void {
    this.pendingUserInput.delete(key);
    if (pending.expiryTimer !== undefined) {
      this.options.clearTimer(pending.expiryTimer);
      pending.expiryTimer = undefined;
    }
    this.options.onUserInputResolved?.(pending.request, resolution);
  }

  private onServerRequestResolved(rawParams: unknown): void {
    const params = asRecord(rawParams);
    const id = parseRequestId(params?.requestId);
    if (!params || id === undefined || typeof params.threadId !== "string") return;
    const key = rpcIdKey(id);
    const pending = this.pendingUserInput.get(key);
    if (!pending) return;
    if (pending.request.identity.threadId !== params.threadId) {
      // Deliberately keep the live request: a resolution naming another thread is not authoritative
      // over this one, and honouring it would retire a phone card whose prompt is still waiting.
      // The entry is still bounded — autoResolutionMs expiry, a same-id reuse, or disconnect clears it.
      this.reportError(new Error("serverRequest/resolved identity mismatch"));
      return;
    }
    this.resolvePending(key, pending, this.attributionOf(pending));
  }

  /** Close a transport this client no longer owns (raced by stop() or another connect). */
  private async abandon(transport: CodexRpcTransport): Promise<void> {
    if (this.transport === transport) this.transport = undefined;
    try { await transport.close(); } catch { /* already fail-open */ }
  }

  private disconnect(epoch: number, resolution: CodexUserInputResolution, reconnect: boolean): void {
    if (epoch !== this.connectionEpoch) return;
    this.transport = undefined;
    for (const pending of this.pendingRpc.values()) {
      this.options.clearTimer(pending.timer);
      pending.reject(new Error("Codex app-server disconnected"));
    }
    this.pendingRpc.clear();
    const pendingInput = [...this.pendingUserInput.entries()];
    this.pendingUserInput.clear();
    for (const [, pending] of pendingInput) {
      if (pending.expiryTimer !== undefined) {
        this.options.clearTimer(pending.expiryTimer);
        pending.expiryTimer = undefined;
      }
      this.options.onUserInputResolved?.(pending.request, resolution);
    }
    if (this.shouldRun) {
      this.setState("disconnected");
      if (reconnect) this.scheduleReconnect();
    }
  }

  /**
   * Exponential backoff, reset by a successful handshake. Every attempt spawns a fresh `codex` child,
   * so a permanently unavailable app-server must not be retried on a fixed short interval forever.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      // Park in a clean, restartable state: no transport, no timer, shouldRun=false. The watchdog
      // re-arms us by calling start() again on a later sweep.
      this.shouldRun = false;
      this.reportError(new Error(
        `Codex app-server reconnect gave up after ${this.reconnectAttempts} consecutive failures`,
      ));
      this.setState("stopped");
      return;
    }
    const delayMs = Math.min(
      this.options.reconnectDelayMs * 2 ** this.reconnectAttempts,
      this.options.maxReconnectDelayMs,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = this.options.setTimer(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error) => this.reportError(error, "Codex app-server reconnect failed"));
    }, delayMs);
  }

  private setState(state: CodexAppServerState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.options.onStateChange?.(state);
  }

  private reportError(error: unknown, fallback = "Codex app-server client error"): void {
    this.options.onError?.(error instanceof Error ? error : new Error(`${fallback}: ${String(error)}`));
  }
}
