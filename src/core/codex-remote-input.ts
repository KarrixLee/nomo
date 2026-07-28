// codex-remote-input — bridge one app-server request_user_input request through Nomo's existing
// blind remote-decision relay. The app-server transport owns request identity; this module owns the
// E2E question frame, phone poll, answer validation, and "resolved elsewhere" cleanup.

import { hostname } from "node:os";
import { decryptBlob, encryptBlob } from "./crypto";
import { requestUserInputDetail } from "./adapter";
import {
  BLOB_FIT_CHARS, buildPermissionQuestions, buildPermissionSummary, capPermissionWireText,
  fitPermissionDetail, PERMISSION_QUESTION_LABEL_MAX,
} from "./permission";
import {
  Config, localApprovalsState, PLUGIN_VERSION, readRecord, SessionRecord,
} from "./shared";
import type {
  CodexUserInputAnswers, CodexUserInputAnswerResult, CodexUserInputInterruptResult,
  CodexUserInputRequest,
} from "./codex-app-server-client";

const POST_TIMEOUT_MS = 15_000;
const POST_MAX_ATTEMPTS = 2;
const POST_RETRY_PAUSE_MS = 1_000;
const POLL_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_CONSECUTIVE_MISSES = 100;
const ANSWER_MAX = 500;
const QUESTION_DESCRIPTION_MAX = 160;

export type CodexRemoteInputResult =
  | "answered"
  | "denied"
  | "not-held"
  | "unsupported"
  | "expired"
  | "superseded"
  | "resolved-elsewhere"
  | "transport-error";

export interface CodexRemoteInputDeps {
  config: Config;
  answerAppServer: (answers: CodexUserInputAnswers) => Promise<CodexUserInputAnswerResult>;
  interruptAppServer: () => Promise<CodexUserInputInterruptResult>;
  fetchFn?: typeof fetch;
  readRecordFn?: (sessionId: string) => Promise<SessionRecord | null>;
  randomUUID?: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  localApprovalsStateFn?: () => Promise<"on" | "off">;
}

export interface CodexRemoteInputHandle {
  /** Opaque Nomo relay request id; deliberately distinct from app-server's connection-scoped id. */
  requestId: string;
  completion: Promise<CodexRemoteInputResult>;
  /** Retire the phone card after Desktop answers, the turn ends, or app-server clears the request. */
  resolvedElsewhere(): Promise<void>;
}

interface PhoneAnswer {
  requestId?: unknown;
  decision?: unknown;
  answers?: unknown;
}

/** Map the phone's positional display labels back to Codex's original question ids and labels. */
export function codexAnswersFromPhone(
  request: CodexUserInputRequest,
  positional: unknown,
): CodexUserInputAnswers | undefined {
  if (!Array.isArray(positional) || positional.length !== request.questions.length) return undefined;
  const mapped: Record<string, string[]> = {};
  for (let index = 0; index < request.questions.length; index += 1) {
    const question = request.questions[index];
    const raw = positional[index];
    if (typeof raw !== "string") return undefined;
    const answer = raw.trim();
    if (answer.length === 0 || answer.length > ANSWER_MAX || !question.options?.length) return undefined;
    // The phone may echo the compact 60-character display label. Re-expand only when it identifies
    // exactly one original option; a collision is ambiguous and must fall back to the Mac picker.
    const hits = question.options
      .map((option) => option.label)
      .filter((label) =>
        label === answer || capPermissionWireText(label, PERMISSION_QUESTION_LABEL_MAX) === answer
      );
    const unique = Array.from(new Set(hits));
    if (unique.length !== 1) return undefined;
    mapped[question.id] = [unique[0]];
  }
  return mapped;
}

function renderableToolInput(request: CodexUserInputRequest): Record<string, unknown> | undefined {
  if (request.questions.length < 1 || request.questions.length > 3) return undefined;
  // Secret/free-form-only questions never leave the Mac. `isOther` may coexist with ordinary choices;
  // Nomo exposes only those explicit labels and leaves free-form "Other" to Codex Desktop.
  if (request.questions.some((question) => {
    if (question.isSecret || !question.options?.length) return true;
    const labels = question.options.map((option) => option.label);
    // The picker must round-trip exactly. Reject whitespace-normalizing labels, duplicates, and capped
    // display collisions BEFORE the relay can let the phone terminally answer an ambiguous choice.
    if (labels.some((label) => label !== label.trim() || label.length > ANSWER_MAX)) return true;
    if (new Set(labels).size !== labels.length) return true;
    return new Set(labels.map((label) =>
      capPermissionWireText(label, PERMISSION_QUESTION_LABEL_MAX)
    )).size !== labels.length;
  })) return undefined;
  return {
    questions: request.questions.map((question) => ({
      question: question.question,
      header: question.header,
      multiSelect: false,
      options: question.options!.map((option) => ({ ...option })),
    })),
  };
}

function baseBlob(
  request: CodexUserInputRequest,
  record: SessionRecord,
  config: Config,
  now: number,
): Record<string, unknown> {
  const preview = requestUserInputDetail({ questions: request.questions });
  return {
    status: "needsAttention",
    title: typeof record.title === "string" ? record.title : "",
    machine: config.machineName ?? (typeof record.machine === "string" && record.machine.length > 0
      ? record.machine : hostname().replace(/\.local$/, "")),
    label: typeof record.label === "string" && record.label.length > 0 ? record.label : "session",
    ...(preview ? { detail: preview } : {}),
    agent: "codex",
    ...(typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt)
      ? { turnStartedAt: record.turnStartedAt } : {}),
    ...(typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {}),
    at: Math.floor(now / 1000),
  };
}

function abortableSleep(ms: number, signal: AbortSignal, sleep: (ms: number) => Promise<void>): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    sleep(ms).then(finish, finish);
  });
}

async function resolveOnRelay(config: Config, requestId: string, fetchFn: typeof fetch): Promise<void> {
  try {
    await fetchFn(`${config.url}/v1/cc/decision/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret,
        "x-cc-version": PLUGIN_VERSION,
      },
      body: JSON.stringify({ requestId }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch {
    // Fail open. The worker's poll-liveness sweep expires the card if this best-effort cleanup misses.
  }
}

async function runRemoteInput(
  request: CodexUserInputRequest,
  requestId: string,
  signal: AbortSignal,
  deps: CodexRemoteInputDeps,
  onHoldCreated: (created: boolean) => void,
): Promise<CodexRemoteInputResult> {
  let holdCreated = false;
  try {
    const toolInput = renderableToolInput(request);
    if (!toolInput) return "unsupported";
    const record = await (deps.readRecordFn ?? readRecord)(request.identity.threadId);
    if (!record || (record.agent ?? "claude") !== "codex") return "unsupported";
    if (signal.aborted) return "resolved-elsewhere";

    const questions = buildPermissionQuestions(toolInput).map((question, index) => ({
      ...question,
      // Codex descriptions carry the tradeoff/impact that often makes short labels meaningful. Keep
      // them positionally aligned with `o`; older phones ignore this additive compact key.
      d: request.questions[index].options!.map((option) =>
        capPermissionWireText(option.description, QUESTION_DESCRIPTION_MAX)
      ),
    }));
    if (questions.length !== request.questions.length) return "unsupported";

    const now = (deps.now ?? Date.now)();
    const fallback = baseBlob(request, record, deps.config, now);
    // The encrypted fallback keeps a compact preview for old/status-only clients. The live question
    // frame carries the structured picker instead; repeating the preview wastes the strict push budget.
    const { detail: _fallbackDetail, ...promptBase } = fallback;
    const permissionBase = {
      ...promptBase,
      status: "decisionPending",
      permissionSummary: buildPermissionSummary("AskUserQuestion", toolInput),
      permissionRequestId: requestId,
      permissionToolName: "request_user_input",
    };
    const fitted = fitPermissionDetail(permissionBase, "", BLOB_FIT_CHARS, questions);
    if (!fitted.questions || fitted.questions.length !== request.questions.length) return "unsupported";
    const promptFrame = { ...permissionBase, permissionQuestions: fitted.questions };
    const [blob, fallbackBlob, approvals] = await Promise.all([
      encryptBlob(deps.config.e2eKey, promptFrame),
      encryptBlob(deps.config.e2eKey, fallback),
      (deps.localApprovalsStateFn ?? localApprovalsState)(),
    ]);
    if (signal.aborted) return "resolved-elsewhere";

    const fetchFn = deps.fetchFn ?? fetch;
    const headers = {
      "x-cc-pairing": deps.config.pairingId,
      "x-cc-auth": deps.config.pcSecret,
      "x-cc-version": PLUGIN_VERSION,
    };
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }));
    let response: Response | undefined;
    for (let attempt = 1; attempt <= POST_MAX_ATTEMPTS && !signal.aborted; attempt += 1) {
      try {
        response = await fetchFn(`${deps.config.url}/v1/cc/decision`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers, "x-cc-approvals": approvals },
          body: JSON.stringify({
            v: 2,
            sessionId: request.identity.threadId,
            requestId,
            op: "update",
            prio: 1,
            ts: now,
            attentionKind: "userInput",
            blob,
            fallbackBlob,
            ...(typeof record.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt)
              ? { startedAt: record.sessionStartedAt } : {}),
          }),
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
        break; // every HTTP status is authoritative; only transport failures retry
      } catch {
        if (attempt < POST_MAX_ATTEMPTS && !signal.aborted) {
          await abortableSleep(POST_RETRY_PAUSE_MS, signal, sleep);
        }
      }
    }
    if (signal.aborted) return "resolved-elsewhere";
    if (!response) {
      // Both responses were ambiguous. Retire a same-id hold if either POST committed before its reply
      // was lost; a true no-create returns 404 and costs nothing.
      await resolveOnRelay(deps.config, requestId, fetchFn);
      return "transport-error";
    }
    if (!response.ok) return "transport-error";
    if (((await response.json()) as { hold?: unknown }).hold !== true) return "not-held";
    holdCreated = true;
    onHoldCreated(true);

    let misses = 0;
    while (!signal.aborted) {
      try {
        const response = await fetchFn(`${deps.config.url}/v1/cc/decision/${requestId}`, {
          headers,
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        });
        if (response.ok) {
          misses = 0;
          const data = (await response.json()) as { status?: unknown; answerBlob?: unknown };
          if (data.status === "answered" && typeof data.answerBlob === "string") {
            let answer: PhoneAnswer;
            try { answer = await decryptBlob(deps.config.e2eKey, data.answerBlob) as PhoneAnswer; }
            catch { return "transport-error"; }
            if (answer.requestId !== requestId) return "unsupported";
            if (answer.decision === "deny") {
              const result = await deps.interruptAppServer();
              return result === "sent" || result === "already-sent" ? "denied" : "transport-error";
            }
            if (answer.decision !== "answer") return "unsupported";
            const mapped = codexAnswersFromPhone(request, answer.answers);
            if (!mapped) return "unsupported";
            const result = await deps.answerAppServer(mapped);
            return result === "sent" || result === "already-sent" ? "answered" : "transport-error";
          }
          if (data.status === "expired") return "expired";
          if (data.status === "superseded") return "superseded";
        } else {
          misses += 1;
        }
      } catch {
        misses += 1;
      }
      if (misses >= MAX_CONSECUTIVE_MISSES) return "transport-error";
      await abortableSleep(deps.pollIntervalMs ?? POLL_INTERVAL_MS, signal, sleep);
    }
    return "resolved-elsewhere";
  } finally {
    if (!holdCreated) onHoldCreated(false);
  }
}

/** Start one phone-backed question without blocking the app-server reader loop. */
export function startCodexRemoteInput(
  request: CodexUserInputRequest,
  deps: CodexRemoteInputDeps,
): CodexRemoteInputHandle {
  const requestId = (deps.randomUUID ?? (() => crypto.randomUUID()))();
  const controller = new AbortController();
  const fetchFn = deps.fetchFn ?? fetch;
  let settleHold!: (created: boolean) => void;
  const holdCreated = new Promise<boolean>((resolve) => { settleHold = resolve; });
  let resolvePromise: Promise<void> | undefined;
  const completion = runRemoteInput(request, requestId, controller.signal, deps, settleHold);
  return {
    requestId,
    completion,
    async resolvedElsewhere(): Promise<void> {
      if (resolvePromise) return resolvePromise;
      controller.abort();
      resolvePromise = (async () => {
        if (await holdCreated) await resolveOnRelay(deps.config, requestId, fetchFn);
      })();
      await resolvePromise;
    },
  };
}
