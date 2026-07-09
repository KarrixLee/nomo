// codex-notify — a BACKSTOP that turns Codex CLI's `notify` channel into a "done" push, so a turn
// still reaches the phone even when the lifecycle hooks fail to fire (upstream openai/codex#16430,
// #30835). `notify` is a separate, stable, fire-and-forget channel: Codex runs the configured program
// with ONE trailing JSON argument on turn completion — NOT stdin — so this entry reads its payload
// from the LAST argv, unlike codex-status.ts (which reads a hook JSON from stdin).
//
// Verified payload (codex-cli 0.142.5 binary strings, legacy_notify path):
//   {"type":"agent-turn-complete","thread-id":…,"turn-id":…,"cwd":…,"client":…,
//    "input-messages":[…],"last-assistant-message":…}
// We act ONLY on agent-turn-complete, map `thread-id` → session_id, and synthesize a Stop-equivalent
// through the SAME shared pipeline the hooks use (buildEnvelope → trackSession → POST). It reuses the
// exported pieces of hook.ts + the codex adapter rather than runHook (which reads stdin).
//
// DEDUPE: if the session record already shows a sent Stop (sentDone), the hooks ARE working for this
// turn — exit silently, never double-send. With NO record (hooks never fired at all), send a best-
// effort done anyway. Contract, like the hooks: NOTHING on stdout, exit 0 always, 2-second net ceiling.
//
// PORTABILITY: bun AND node >= 18 — no `Bun.*` APIs; build.ts bundles this to dist/codex-notify.mjs,
// invoked via plugin/scripts/notify-chain.sh (which also chains any pre-existing notify program).

import { hostname } from "node:os";
import { basename } from "node:path";
import { cleanPromptTitle, codexAdapter } from "../core/adapter";
import { buildEnvelope, trackSession } from "../core/hook";
import { atomicWrite, ensureWatchdog, LAST_SEND_PATH, loadConfig, readRecord } from "../core/shared";

/** Map the notify JSON onto the runHook/planOp Stop-hook input shape. Null for any payload that isn't
 *  an agent-turn-complete carrying a non-empty thread-id (the only kind we back-stop) or isn't JSON. */
export function synthStopInput(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.type !== "agent-turn-complete") return null;
  const threadId = typeof p["thread-id"] === "string" ? p["thread-id"] : "";
  if (threadId.length === 0) return null;
  return {
    session_id: threadId,
    hook_event_name: "Stop",
    cwd: typeof p.cwd === "string" ? p.cwd : "",
    turn_id: typeof p["turn-id"] === "string" ? p["turn-id"] : "",
    last_assistant_message: typeof p["last-assistant-message"] === "string" ? p["last-assistant-message"] : "",
    "input-messages": Array.isArray(p["input-messages"]) ? p["input-messages"] : [],
  };
}

/** FALLBACK title (used when the session_index thread_name isn't written yet): the first usable user
 *  input-message, cleaned exactly like the transcript first-prompt path. Skips empty / command-UI
 *  (`<…>`) / skill-plugin (`[$…`, `[@…`) artifacts. Undefined when nothing usable — the blob then
 *  shows just the cwd-basename label. */
export function notifyFallbackTitle(inputMessages: unknown): string | undefined {
  if (!Array.isArray(inputMessages)) return undefined;
  for (const m of inputMessages) {
    if (typeof m !== "string") continue;
    const cleaned = m.replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.startsWith("<") || /^\[[$@]/.test(cleaned)) continue;
    return cleanPromptTitle(cleaned);
  }
  return undefined;
}

/** Default deferral before the notify backstop sends its `done`: long enough for a concurrently-firing
 *  Stop hook (which reads the transcript + encrypts before it writes sentDone) to win the race and set
 *  sentDone, so on a HEALTHY machine the hook — not notify — delivers the done and we never double-send.
 *  Overridable via NOMO_NOTIFY_DEFER_MS (tests shrink it to 0, or set a window they can write into). */
const DEFAULT_NOTIFY_DEFER_MS = 3000;

/** The deferral window: the env override when a valid non-negative number, else the default. */
function notifyDeferMs(): number {
  const env = process.env.NOMO_NOTIFY_DEFER_MS;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_NOTIFY_DEFER_MS;
}

/// The backstop body. Inert when unpaired. Reads the session record for the dedupe gate + the cached
/// start/turn anchors (notify carries no transcript path, so those can only come from a record an
/// earlier hook wrote); with no record it still sends a best-effort done. Same POST + trackSession +
/// ensureWatchdog tail as runHook, so a backstop-delivered done behaves identically downstream. The
/// `deferMs`/`sleep` params are injectable so tests can drive the race deterministically without a
/// real 3-second wait (the entry below leaves them defaulted).
export async function runNotify(raw: string, deferMs = notifyDeferMs(), sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  try {
    const config = await loadConfig();
    if (!config) return; // never paired → fully inert, like the hooks
    const input = synthStopInput(raw);
    if (!input) return;
    const sessionId = input.session_id as string;
    // The notify payload's turn-id (synthStopInput maps `turn-id` → turn_id). Undefined when absent —
    // the stale-turn guards below are then inert (they only bail on a DIFFERING known turn).
    const payloadTurnId = typeof input.turn_id === "string" && input.turn_id.length > 0 ? input.turn_id : undefined;

    // STALE-TURN GUARD: a delayed notify from an old turn must never clobber a newer turn. If the
    // record is already bound to a DIFFERENT turn (the next UserPromptSubmit re-stamped turnId and
    // reset sentDone), this notify belongs to a turn that's over — bail silently.
    const record = await readRecord(sessionId);
    if (record?.turnId && payloadTurnId && record.turnId !== payloadTurnId) return;

    // DEDUPE: a record showing a sent Stop means the hooks already delivered this turn's done — the
    // backstop must not double-send. (sentDone is set only by an op:done and cleared by the next
    // start/update, so it's true iff the last POSTed event for this session was a done.)
    if (record?.sentDone === true) return;

    // DEFERRAL BACKSTOP: on a healthy machine the Stop hook fires concurrently and writes sentDone LATE
    // (after transcript reads + encryption), so notify would otherwise win the race and double-send.
    // Wait, then re-read: if the Stop hook won (sentDone now true) OR the turn advanced (turnId changed)
    // while we waited, bail. Otherwise proceed — including the never-had-a-record case, the true
    // hooks-are-dead backstop this whole entry exists for.
    if (deferMs > 0) {
      await sleep(deferMs);
      const after = await readRecord(sessionId);
      if (after?.sentDone === true) return; // the Stop hook delivered this turn's done during the wait
      if (after?.turnId && payloadTurnId && after.turnId !== payloadTurnId) return; // turn advanced under us
    }

    const machine = config.machineName ?? hostname().replace(/\.local$/, "");
    // Title: the codex adapter's resolver (notify carries no transcript, so with prefix "" and a Stop
    // input this reduces to the PRIMARY session_index thread_name lookup — same as the hook path) →
    // first user input-message → (nothing; the blob's cwd-basename label carries the session).
    const title = (await codexAdapter.title({ sessionId, prefix: "", input })) ?? notifyFallbackTitle(input["input-messages"]);

    // Thread the cached start/turn anchors from the record (an earlier hook parsed them); notify has no
    // transcript to re-derive them, so with no record they're simply omitted and the widget falls back.
    const startedAt = typeof record?.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt)
      ? record.sessionStartedAt : undefined;
    const turnStartedAt = typeof record?.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt)
      ? record.turnStartedAt : undefined;
    // The cached model id (an earlier hook resolved it, v0.8.5). The notify payload carries no model
    // field, so like the anchors it's threaded from the record — omitted when there is none.
    const model = typeof record?.model === "string" && record.model.length > 0 ? record.model : undefined;

    const now = Date.now();
    // sentDone is false here (we returned above when it was true), so planOp("Stop") maps to op:done.
    const envelope = await buildEnvelope(input, machine, now, title, config.e2eKey, false, "codex", startedAt, turnStartedAt, undefined, model);
    if (!envelope) return;

    const label = typeof input.cwd === "string" && input.cwd.length > 0 ? basename(input.cwd) : "session";
    await trackSession(sessionId, "done", 0, "done", envelope.blob as string | undefined, machine, label,
      typeof record?.transcript === "string" ? record.transcript : "", "codex", startedAt, turnStartedAt, payloadTurnId,
      title ?? record?.title, config.pairingId, model);
    ensureWatchdog();

    const res = await fetch(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) await atomicWrite(LAST_SEND_PATH, String(now));
  } catch {
    // Silence is the contract — a notify backstop must never surface into a Codex session.
  }
}

// import.meta.main is true under bun and node >= 24 when this file is the entry; build.ts rewrites it
// for older nodes. The notify payload is the LAST argv (codex appends exactly one JSON arg).
if (import.meta.main) {
  await runNotify(process.argv[process.argv.length - 1] ?? "");
  process.exit(0);
}
