// Cross-process arbitration between Codex's blocking PreToolUse hook and the watchdog-hosted
// app-server bridge. The hook runs before request_user_input reaches app-server, so the bridge publishes
// a short renewable per-thread lease. A hook with a bridge-servable shape waits a bounded moment for
// that lease; otherwise it stamps a request fingerprint before creating the honest fallback hold. If
// that fallback later releases to the native picker, the bridge consumes the fingerprint and does not
// create a second hold for the same request.

import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { atomicWrite, pidAlive, SESSIONS_DIR } from "./shared";
import { renderableCodexUserInput } from "./codex-user-input-shape";
import type { CodexUserInputRequest } from "./codex-app-server-client";

export const CODEX_INPUT_BRIDGE_SUFFIX = ".input-bridge";
export const CODEX_INPUT_FALLBACK_SUFFIX = ".input-fallback";
/** Refreshed by the watchdog's five-second bridge sweep. Three sweeps of slack tolerate scheduling
 * jitter, while a disconnected/wedged bridge fails back to the hook quickly. */
export const CODEX_INPUT_BRIDGE_LEASE_MS = 15_000;
/** Same hard ceiling as a decision `.hold` marker and the worker decision record. */
export const CODEX_INPUT_FALLBACK_TTL_MS = 600_000;
export const CODEX_INPUT_BRIDGE_WAIT_MS = 750;
const BRIDGE_WAIT_STEP_MS = 50;

interface BridgeLease { at: number; pid: number }
interface FallbackClaim { at: number; fingerprint: string; held: boolean; pid: number }

export interface CodexInputArbitrationDeps {
  sessionsDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isPidAlive?: (pid: number) => boolean;
  pid?: number;
}

function bridgePath(sessionsDir: string, sessionId: string): string {
  return `${sessionsDir}/${sessionId}${CODEX_INPUT_BRIDGE_SUFFIX}`;
}

function fallbackPath(sessionsDir: string, sessionId: string): string {
  return `${sessionsDir}/${sessionId}${CODEX_INPUT_FALLBACK_SUFFIX}`;
}

function canonicalQuestions(toolInput: Record<string, unknown>): unknown[] {
  if (!Array.isArray(toolInput.questions)) return [];
  return toolInput.questions.map((candidate) => {
    const question = candidate as RawQuestion;
    return {
      id: typeof question?.id === "string" ? question.id : "",
      header: typeof question?.header === "string" ? question.header : "",
      question: typeof question?.question === "string" ? question.question : "",
      isSecret: question?.isSecret === true,
      options: Array.isArray(question?.options)
        ? question.options.map((option) => {
          const value = option as { label?: unknown } | null;
          return typeof value?.label === "string" ? value.label : "";
        })
        : null,
    };
  });
}

type RawQuestion = {
  id?: unknown;
  header?: unknown;
  question?: unknown;
  isSecret?: unknown;
  options?: unknown;
} | null;

export function codexInputFingerprint(
  turnId: string, toolInput: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(JSON.stringify([turnId, canonicalQuestions(toolInput)]))
    .digest("hex");
}

async function readMarker<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return undefined; }
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Publish/renew proof that this watchdog is connected and subscribed to this exact app-server thread. */
export async function markCodexInputBridgeReady(
  sessionId: string, deps: CodexInputArbitrationDeps = {},
): Promise<void> {
  const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
  await atomicWrite(bridgePath(sessionsDir, sessionId), JSON.stringify({
    at: (deps.now ?? Date.now)(), pid: deps.pid ?? process.pid,
  } satisfies BridgeLease), 0o600);
}

/** Compare-and-clear so an old bridge cannot erase a successor's renewed lease. */
export async function clearCodexInputBridgeReady(
  sessionId: string, deps: CodexInputArbitrationDeps = {},
): Promise<void> {
  const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
  const path = bridgePath(sessionsDir, sessionId);
  const lease = await readMarker<BridgeLease>(path);
  if (finite(lease?.pid) && lease.pid !== (deps.pid ?? process.pid)) return;
  await unlink(path).catch(() => {});
}

/** The hook's bounded live-bridge gate. Unsupported shapes return immediately and never yield. */
export async function codexInputBridgeCanServe(
  sessionId: string, _turnId: string, toolInput: Record<string, unknown>,
  deps: CodexInputArbitrationDeps = {},
): Promise<boolean> {
  if (!renderableCodexUserInput(toolInput)) return false;
  const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
  const clock = deps.now ?? Date.now;
  const alive = deps.isPidAlive ?? pidAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.ceil(CODEX_INPUT_BRIDGE_WAIT_MS / BRIDGE_WAIT_STEP_MS) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lease = await readMarker<BridgeLease>(bridgePath(sessionsDir, sessionId));
    const now = clock();
    if (finite(lease?.at) && finite(lease?.pid)
      && now >= lease.at && now - lease.at <= CODEX_INPUT_BRIDGE_LEASE_MS && alive(lease.pid)) {
      return true;
    }
    if (attempt + 1 < attempts) await sleep(BRIDGE_WAIT_STEP_MS);
  }
  return false;
}

/** Stamp the fallback attempt before its decision POST, then promote it with `held:true` only after the
 * worker grants the hold. A granted marker intentionally outlives `.hold`: Open-on-Mac/fail-open is
 * exactly when app-server finally receives this same request. */
export async function markCodexInputFallback(
  sessionId: string, turnId: string, toolInput: Record<string, unknown>,
  held = false,
  deps: CodexInputArbitrationDeps = {},
): Promise<void> {
  const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
  await atomicWrite(fallbackPath(sessionsDir, sessionId), JSON.stringify({
    at: (deps.now ?? Date.now)(),
    fingerprint: codexInputFingerprint(turnId, toolInput),
    held,
    pid: deps.pid ?? process.pid,
  } satisfies FallbackClaim), 0o600);
}

/** Remove only this request's claim; a newer/different fallback in the same session must survive. */
export async function clearCodexInputFallback(
  sessionId: string, turnId: string, toolInput: Record<string, unknown>,
  deps: CodexInputArbitrationDeps = {},
): Promise<void> {
  const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
  const path = fallbackPath(sessionsDir, sessionId);
  const claim = await readMarker<FallbackClaim>(path);
  if (!claim || claim.fingerprint !== codexInputFingerprint(turnId, toolInput)) return;
  await unlink(path).catch(() => {});
}

/** Consume a matching recent fallback claim. Consumption prevents an identical later question from
 * being mistaken for this one; the ten-minute TTL is the crash/backpressure ceiling. */
export async function codexInputFallbackOwnsRequest(
  request: CodexUserInputRequest, deps: CodexInputArbitrationDeps = {},
): Promise<boolean> {
  const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
  const path = fallbackPath(sessionsDir, request.identity.threadId);
  const claim = await readMarker<FallbackClaim>(path);
  if (!claim || claim.held !== true || !finite(claim.at) || typeof claim.fingerprint !== "string") return false;
  const now = (deps.now ?? Date.now)();
  if (now < claim.at || now - claim.at > CODEX_INPUT_FALLBACK_TTL_MS) {
    await unlink(path).catch(() => {});
    return false;
  }
  const fingerprint = codexInputFingerprint(request.identity.turnId, { questions: request.questions });
  if (claim.fingerprint !== fingerprint) return false;
  await unlink(path).catch(() => {});
  return true;
}
