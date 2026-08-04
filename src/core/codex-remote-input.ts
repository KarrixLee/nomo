// codex-remote-input — bridge one app-server request_user_input request through Nomo's existing
// blind remote-decision relay. The app-server transport owns request identity; this module owns the
// E2E question frame, phone poll, answer validation, and "resolved elsewhere" cleanup.

import { hostname } from "node:os";
import { decryptBlob, encryptBlob } from "./crypto";
import { requestUserInputDetail } from "./adapter";
import { lanAnswerStore } from "./lan-listener";
import type { LanAnswerStore } from "./lan-listener";
// The relay's timing/give-up rules, shared verbatim with the Claude permission hook (permission.ts),
// which polls the SAME route with the same credentials — see decision-poll.ts.
import {
  createPollBudget, DEFINITIVE_POLL_STATUSES, MAX_CONSECUTIVE_MISSES, MAX_DEFINITIVE_POLL_FAILURES,
  POLL_INTERVAL_MS, POST_MAX_ATTEMPTS, POST_RETRY_PAUSE_MS,
} from "./decision-poll";
import type { PollBudget } from "./decision-poll";
import {
  BLOB_FIT_CHARS, buildPermissionQuestions, buildPermissionSummary, capPermissionWireText,
  fitPermissionDetail, PERMISSION_QUESTION_LABEL_MAX,
} from "./permission";
import {
  clearDecisionHold, Config, DecisionHold, localApprovalsState, PLUGIN_VERSION, readRecord, SessionRecord,
  settleDecisionHoldRecord, writeDecisionHold,
} from "./shared";
import { lanRunningUnderTest } from "./lan-wire";
import type {
  CodexUserInputAnswers, CodexUserInputAnswerResult, CodexUserInputInterruptResult,
  CodexUserInputRequest,
} from "./codex-app-server-client";
import { renderableCodexUserInput } from "./codex-user-input-shape";

/** FIRST-CONTACT ceiling for the decision POST. Deliberately NOT the permission hook's 4 s twin
 *  (POST_FIRST_CONTACT_TIMEOUT_MS): this relay runs detached inside the watchdog and blocks nobody's
 *  terminal, so it can afford to wait out a slow round trip rather than fall back to Desktop. Same
 *  ceiling on the best-effort `resolve` echo below. Every OTHER timing/give-up rule on this route is
 *  shared — see decision-poll.ts. */
const POST_TIMEOUT_MS = 15_000;
const ANSWER_MAX = 500;

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
  /** The LAN listener's in-process answer store (NOM-44 phase 2). This relay runs INSIDE the watchdog,
   *  so a phone answer delivered over the LAN is already in this process's memory: it is applied on the
   *  spot instead of waiting for the next 3 s worker tick. Defaults to the process-wide singleton the
   *  listener writes; tests inject their own. */
  answerStore?: LanAnswerStore;
  /** This relay's own latency estimate for /v1/cc/decision, which sizes every steady-state poll's
   *  ceiling (see createPollBudget). Defaults to a fresh per-request estimator; injected by tests, which
   *  is also the only way to OBSERVE the budget here — unlike the permission hook, the relay has no
   *  trace file to write it to. */
  pollBudget?: PollBudget;
  /** Local `.hold` marker lifecycle for the LAN state feed. This relay lives in the watchdog, so its
   *  owner pid is the watchdog's own pid (unlike permission.ts's short-lived hook process). */
  writeHoldFn?: (sessionId: string, hold: DecisionHold) => Promise<void>;
  clearHoldFn?: (
    sessionId: string, pid: number, beforeUnlink?: () => Promise<void>,
  ) => Promise<boolean>;
  settleHoldRecordFn?: (sessionId: string, patch: Partial<SessionRecord>) => Promise<void>;
  holdPid?: number;
  /** Diagnostic seam. Failures here are never fatal, but they must not be silent either. */
  onError?: (error: Error) => void;
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

/** Unit tests run in the developer's real HOME, so production marker defaults must be inert there.
 *  Injected seams still exercise the full lifecycle. Mirrors permission.ts's guard exactly. */
function defaultWriteHold(): (sessionId: string, hold: DecisionHold) => Promise<void> {
  return lanRunningUnderTest() ? async () => { /* never touch live records from a test */ } : writeDecisionHold;
}

function defaultClearHold(): (
  sessionId: string, pid: number, beforeUnlink?: () => Promise<void>,
) => Promise<boolean> {
  return lanRunningUnderTest()
    ? async (_sessionId: string, _pid: number, beforeUnlink?: () => Promise<void>) => {
      await beforeUnlink?.();
      return true;
    }
    : clearDecisionHold;
}

function defaultSettleHoldRecord(): (sessionId: string, patch: Partial<SessionRecord>) => Promise<void> {
  return lanRunningUnderTest() ? async () => { /* never touch live records from a test */ } : settleDecisionHoldRecord;
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

/** The signal for ONE relay fetch: its own deadline OR the caller's abort, whichever fires first.
 *
 *  Signing a fetch with `AbortSignal.timeout(...)` alone left `controller.abort()` unable to cancel an
 *  in-flight request, so a prompt resolved on the Mac kept its POST/GET running for the whole timeout —
 *  the exact window in which the worker can create a hold nobody is left to retire. `AbortSignal.any`
 *  exists on Node >= 20.3 / Bun; the manual fallback keeps this module runnable on Node 18, where
 *  `AbortSignal.timeout` exists but `.any` does not. */
function requestSignal(ms: number, signal: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === "function") return any.call(AbortSignal, [signal, deadline]);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal.aborted || deadline.aborted) controller.abort();
  else {
    signal.addEventListener("abort", abort, { once: true });
    deadline.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
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

function report(deps: CodexRemoteInputDeps, error: unknown, fallback: string): void {
  try {
    deps.onError?.(error instanceof Error ? error : new Error(`${fallback}: ${String(error)}`));
  } catch { /* a broken reporter must not break the relay */ }
}

async function parseJson<T>(response: Response): Promise<T | undefined> {
  // An HTTP 200 carrying non-JSON (captive portal, edge interposition, truncated body) must degrade to
  // the normal error path, never throw out of the relay task.
  try { return await response.json() as T; } catch { return undefined; }
}

/** POST /v1/cc/decision/resolve — the blob-free, PC-authenticated "this request is settled on the Mac"
 *  transition. EXPORTED because the LAN channel needs the identical request: after the watchdog's
 *  listener stores a LAN-delivered answer it echoes exactly this call, so the worker record retires and
 *  the island's Allow/Deny buttons drop even when the phone's own worker leg never landed. Best-effort
 *  by contract — every failure is swallowed (and, on the LAN path, it is NEVER a gone strike). */
export async function resolveOnRelay(config: Config, requestId: string, fetchFn: typeof fetch = fetch): Promise<void> {
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
  let heldSessionId: string | undefined;
  let resumed = false;
  let settleHeldRecord: (() => Promise<void>) | undefined;
  try {
    const toolInput = renderableCodexUserInput({ questions: request.questions });
    if (!toolInput) return "unsupported";
    const record = await (deps.readRecordFn ?? readRecord)(request.identity.threadId);
    if (!record || (record.agent ?? "claude") !== "codex") return "unsupported";
    if (signal.aborted) return "resolved-elsewhere";

    const questions = buildPermissionQuestions(toolInput);
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
    // A label-only picker is still fully actionable; only fall back to Desktop when even that cannot fit.
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
    // THE HONEST TRANSIENT STATE (NOM-45) — the permission hook's twin, and for the identical reason:
    // when this relay stops because THE WORKER WAS UNREACHABLE, Codex is unblocked at the Mac but the
    // phone keeps the yellow attention row the last successful POST painted, unanswerable and
    // indistinguishable from a real dead end. `attentionStalledAt` + the blob's `reconnecting` key make
    // it read as auto-retrying on both channels. Set ONLY on the two transport-failure exits; a
    // definitive status, an expiry/supersede, an unreadable-but-real reply and a genuine answer all
    // leave the row telling the truth.
    let attentionStalled = false;
    const stalledPatch = async (at: number): Promise<Partial<SessionRecord>> => {
      let stalledBlob = fallbackBlob;
      try {
        stalledBlob = await encryptBlob(deps.config.e2eKey, { ...fallback, reconnecting: Math.floor(at / 1000) });
      } catch { /* the plain attention frame is still honest, just less specific */ }
      return { ts: at, blob: stalledBlob, attentionStalledAt: at };
    };
    /** Stamp the stall on a session this relay never got to hold (the POST itself never landed). A hold
     *  that DID exist rides settleHeldRecord instead, so the marker is written exactly once. */
    const markAttentionStalled = async (): Promise<void> => {
      const at = (deps.now ?? Date.now)();
      try {
        await (deps.settleHoldRecordFn ?? defaultSettleHoldRecord())(
          request.identity.threadId, await stalledPatch(at),
        );
      } catch { /* best-effort, exactly like every other settle */ }
    };

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
          signal: requestSignal(POST_TIMEOUT_MS, signal),
        });
        break; // every HTTP status is authoritative; only transport failures retry
      } catch {
        if (attempt < POST_MAX_ATTEMPTS && !signal.aborted) {
          await abortableSleep(POST_RETRY_PAUSE_MS, signal, sleep);
        }
      }
    }
    // ABORT ORDERING. The `signal.aborted` check DELIBERATELY comes AFTER the response is classified.
    // Checking it here — before `holdCreated` is set — is how a prompt resolved on the Mac while the POST
    // was in flight left a live card on the phone: the worker HAD created the hold (pending decision,
    // shown-set enrollment, violet island push), but `resolvedElsewhere()` only retires when `holdCreated`
    // resolved true, so nothing retired it until the worker's ~30s sweep. Every branch below therefore
    // either retires the hold itself or records that one exists, and only then honors the abort.
    if (!response) {
      // Both responses were ambiguous (including an abort that cancelled the fetch). Retire a same-id hold
      // if either POST committed before its reply was lost; a true no-create returns 404 and costs nothing.
      await resolveOnRelay(deps.config, requestId, fetchFn);
      // An ABORT is a resolution on the Mac, not a lost worker — only a genuine transport failure stalls.
      if (!signal.aborted) await markAttentionStalled();
      return signal.aborted ? "resolved-elsewhere" : "transport-error";
    }
    if (!response.ok) return signal.aborted ? "resolved-elsewhere" : "transport-error";
    const created = await parseJson<{ hold?: unknown }>(response);
    if (!created) {
      // A 200 we cannot parse may still have created the hold. Retire it rather than leave an orphan.
      report(deps, new Error("Unparseable relay response to the decision hold POST"), "Relay POST");
      await resolveOnRelay(deps.config, requestId, fetchFn);
      return signal.aborted ? "resolved-elsewhere" : "transport-error";
    }
    if (created.hold !== true) return signal.aborted ? "resolved-elsewhere" : "not-held";
    // The hold EXISTS on the worker. Publish that fact BEFORE honoring the abort, so an abort that lost
    // the race still retires the card through resolvedElsewhere()'s `await holdCreated` branch.
    holdCreated = true;
    // Worker hold and local LAN marker are one lifecycle. The marker carries the watchdog pid because
    // this relay is in-process; a watchdog crash makes it dead on the next liveness pass, and the normal
    // 10-minute marker TTL remains the pid-reuse backstop. Await the write before exposing the created
    // hold to resolvedElsewhere(), so every exit from that point has a marker it can compare-and-clear.
    const holdPid = deps.holdPid ?? process.pid;
    await (deps.writeHoldFn ?? defaultWriteHold())(
      request.identity.threadId, { blob, at: now, pid: holdPid },
    );
    heldSessionId = request.identity.threadId;
    settleHeldRecord = async (): Promise<void> => {
      const settledAt = (deps.now ?? Date.now)();
      const unblocked = resumed || signal.aborted;
      const patch: Partial<SessionRecord> = unblocked
        ? {
          ts: settledAt, lastEvent: "working", op: "update", prio: 0, sentDone: false,
          attentionKind: undefined,
          // The phone answered (or the Mac did) — contact plainly exists, so no stall may ride forward.
          attentionStalledAt: undefined,
          blob: await encryptBlob(deps.config.e2eKey, {
            ...promptBase, status: "working", at: Math.floor(settledAt / 1000),
          }),
        }
        : attentionStalled
          ? await stalledPatch(settledAt)
          : { ts: settledAt, blob: fallbackBlob, attentionStalledAt: undefined };
      await (deps.settleHoldRecordFn ?? defaultSettleHoldRecord())(request.identity.threadId, patch);
    };
    onHoldCreated(true);
    if (signal.aborted) return "resolved-elsewhere";

    // The relay has already recorded the phone's decision by the time we get here, so an app-server
    // delivery failure must not look like success on the phone: report it and retire the relay record.
    // Residual gap: the phone may have briefly rendered "answered" before its next poll sees the card
    // retired, and Codex still needs a Desktop answer — we deliberately never fabricate one.
    const reportUndelivered = async (action: string, outcome: string): Promise<void> => {
      report(
        deps,
        new Error(`Codex ${action} was not delivered to app-server (${outcome})`),
        "Codex remote input delivery",
      );
      await resolveOnRelay(deps.config, requestId, fetchFn);
    };

    /** Apply ONE sealed phone answer, from EITHER delivery channel — the 3 s worker poll or the LAN
     *  listener's in-process answer store. THE single answered-branch body so the two cannot drift: the
     *  requestId-mismatch guard, the deny→interrupt mapping, and the answer→app-server delivery all
     *  behave identically no matter how the blob arrived. */
    const applyAnswerBlob = async (answerBlob: string): Promise<CodexRemoteInputResult> => {
      // EVERY REJECTION BELOW IS REPORTED. A refused answer releases the hold, which the phone reads as
      // the card simply flipping back to an unanswerable attention row — indistinguishable from a flap
      // and, until 2026-08-05, impossible to diagnose because each of these returns was silent. The
      // messages are deliberately CONTENT-FREE (no question text, no option label, no answer): this
      // lands in a plaintext local trace, and permission.ts's errorTag discipline applies here too.
      const reject = (why: string, result: CodexRemoteInputResult): CodexRemoteInputResult => {
        report(deps, new Error(`Codex phone answer rejected (${why})`), "Codex remote input answer");
        return result;
      };
      let answer: PhoneAnswer;
      try { answer = await decryptBlob(deps.config.e2eKey, answerBlob) as PhoneAnswer; }
      catch { return reject("undecryptable", "transport-error"); }
      if (answer.requestId !== requestId) return reject("request-id mismatch", "unsupported");
      if (answer.decision === "deny") {
        const result = await deps.interruptAppServer();
        if (result === "sent" || result === "already-sent") {
          resumed = true;
          return "denied";
        }
        await reportUndelivered("deny", result);
        return "transport-error";
      }
      if (answer.decision !== "answer") return reject("unknown decision", "unsupported");
      const mapped = codexAnswersFromPhone(request, answer.answers);
      if (!mapped) return reject("unmappable to the app-server questions", "unsupported");
      const result = await deps.answerAppServer(mapped);
      if (result === "sent" || result === "already-sent") {
        resumed = true;
        return "answered";
      }
      await reportUndelivered("answer", result);
      return "transport-error";
    };

    // The LAN store lives in THIS process (the listener is hosted by the same watchdog), so a LAN-
    // delivered answer needs no poll at all: it is checked at the top of every iteration AND raced
    // against the sleep at the bottom, which is what removes the up-to-3 s tick from the answer path.
    // The worker poll below keeps its own cadence untouched — it is the relay's liveness proof.
    const answers = deps.answerStore ?? lanAnswerStore;
    const clock = deps.now ?? Date.now;
    /** THE STORE IS THIS MACHINE'S AUTHORITY on a request it is holding, and it OUTRANKS whatever the
     *  worker says about that request. Not a nicety — the two are causally linked: the listener that
     *  stores a LAN answer also echoes POST /cc/decision/resolve (cc-watchdog's acceptLanAnswer, the
     *  split-brain backstop that retires the island's buttons when the phone's own worker leg fails),
     *  and that route flips the record to `superseded`. The phone's answer therefore routinely lands
     *  while a poll is in flight, and that poll returns TERMINAL for a prompt this process can answer.
     *  Honouring it dropped the pick on the floor (field 2026-08-05): the hold released, the row fell
     *  back to the yellow attention frame, and Codex waited forever. `put` is synchronous and strictly
     *  precedes the echo, so a terminal status caused by our own echo can never outrun this peek. */
    const localAnswer = (): string | undefined => answers.peek(requestId, clock())?.answerBlob;

    let misses = 0;
    let definitiveFailures = 0;
    let polls = 0;
    // The SAME adaptive per-fetch ceiling the permission hook polls on, and for the same reason: first
    // contact pays a proxy/tunnel's DNS + connect + TLS setup on the v1.6.6 floor, and every poll after
    // it is bounded by what THIS relay's own completed round trips actually cost — the tight 2s on a
    // healthy network, up to 8s on a tunnel that cannot meet it. See createPollBudget.
    const pollBudget = deps.pollBudget ?? createPollBudget();
    while (!signal.aborted) {
      const local = localAnswer();
      if (local) return await applyAnswerBlob(local);
      polls += 1;
      const budgetMs = pollBudget.next(polls);
      const startedAt = clock();
      try {
        const response = await fetchFn(`${deps.config.url}/v1/cc/decision/${requestId}`, {
          headers,
          signal: requestSignal(budgetMs, signal),
        });
        // An unreadable 200 counts as a miss exactly like a non-2xx, so a relay that answers with
        // garbage forever still trips MAX_CONSECUTIVE_MISSES instead of polling until the heat death.
        const data = response.ok
          ? await parseJson<{ status?: unknown; answerBlob?: unknown }>(response)
          : undefined;
        // A response ARRIVED, body and all — ok or not, the transport cost is a real measurement, and the
        // budget it must fit under covers the body read too (the abort signal does). A THROW is never fed
        // (see PollBudget.observe): it measures nothing and must not inflate the give-up clock.
        pollBudget.observe(clock() - startedAt);
        if (!data) {
          misses += 1;
          if (response.ok) report(deps, new Error("Unparseable relay poll response"), "Relay poll");
          // DEFINITIVE vs transient — the same rule the permission hook's poll loop uses, and for the
          // same reason: 401/403/404/410 mean this pairing cannot read this record AT ALL (unauthorized /
          // revoked / GC'd), so the remaining ~100 polls would fail identically. Riding the miss cap
          // there burns ~5 min of the shared per-pairing poll budget on a doomed request and starves
          // genuinely live holds into 429s. Two CONSECUTIVE strikes (one can be a racing delete/deploy)
          // give up at once. Everything else — 429, 5xx, an unreadable 200, a transport throw — stays
          // transient.
          if (!response.ok && DEFINITIVE_POLL_STATUSES.has(response.status)) {
            definitiveFailures += 1;
            if (definitiveFailures >= MAX_DEFINITIVE_POLL_FAILURES) return "transport-error";
          } else {
            definitiveFailures = 0;
          }
        } else {
          misses = 0;
          definitiveFailures = 0;
          if (data.status === "answered" && typeof data.answerBlob === "string") {
            return await applyAnswerBlob(data.answerBlob); // the shared branch — see applyAnswerBlob
          } else if (data.status === "expired" || data.status === "superseded") {
            // A TERMINAL worker status is honoured only when the store holds nothing — see localAnswer.
            const raced = localAnswer();
            if (raced) return await applyAnswerBlob(raced);
            return data.status === "expired" ? "expired" : "superseded";
          }
        }
      } catch {
        misses += 1;
        definitiveFailures = 0; // a transport throw says nothing about the record — never a strike
      }
      if (misses >= MAX_CONSECUTIVE_MISSES) {
        // ~5 min of consecutive unusable polls: the worker is gone, not slow. Fail open here, and let the
        // settle below tell the phone it is a RECONNECTING row rather than a question it can answer.
        attentionStalled = true;
        return "transport-error";
      }
      // The poll cadence is unchanged: the race can only END this wait EARLY (a LAN answer landed), never
      // extend it. `cancel()` in the finally is mandatory — without it every abandoned tick would leave a
      // listener behind in the store.
      const waiter = answers.waiter(requestId, clock());
      try {
        await Promise.race([abortableSleep(deps.pollIntervalMs ?? POLL_INTERVAL_MS, signal, sleep), waiter.promise]);
      } finally {
        waiter.cancel();
      }
    }
    return "resolved-elsewhere";
  } catch (error) {
    // Nothing in this task may throw out: the caller only holds the completion promise, and an escaping
    // rejection kills the watchdog process. readRecord, encryptBlob, JSON decoding, and a hostile relay
    // response all land here and degrade to the normal error/release semantics.
    report(deps, error, "Codex remote input failed");
    if (holdCreated) await resolveOnRelay(deps.config, requestId, deps.fetchFn ?? fetch);
    return signal.aborted ? "resolved-elsewhere" : "transport-error";
  } finally {
    // Same settle-before-unlink compare-and-clear discipline as permission.ts. A later hold owns the
    // marker/record if its pid differs; a moved record makes settleDecisionHoldRecord a no-op.
    if (heldSessionId !== undefined) {
      try {
        await (deps.clearHoldFn ?? defaultClearHold())(
          heldSessionId, deps.holdPid ?? process.pid, settleHeldRecord,
        );
      } catch { /* marker liveness + TTL are the crash-safe release */ }
    }
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
  // Belt and braces: runRemoteInput already catches everything, so this only covers a throwing reporter
  // or a future edit. The completion promise must never reject — its consumer detaches it.
  const completion = runRemoteInput(request, requestId, controller.signal, deps, settleHold)
    .catch((error): CodexRemoteInputResult => {
      report(deps, error, "Codex remote input failed");
      return "transport-error";
    });
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
