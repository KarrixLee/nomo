/** The OpenCode plugin entrypoint — nomo's third agent.
 *
 *  UNLIKE the Claude Code and Codex integrations, this is NOT a hook. OpenCode has no hook system: it
 *  discovers `{plugin,plugins}/*.{ts,js}` and `import()`s ONE resident module into its own server
 *  process, then feeds it a fire-and-forget event firehose. So there is no one-shot process, no
 *  `$PLUGIN_ROOT` staleness, no shim — and equally no free lunch: everything this file does happens
 *  inside the user's editor process and must never throw into it, never block it, and never print.
 *
 *  DEFENSIVE AT MODULE SCOPE. A throw during import kills this plugin permanently for the life of that
 *  OpenCode server (Bun caches the failed module resolution — a later, healthy import of the same
 *  specifier gets the cached failure). So this module does NO work at load: it declares functions and
 *  a default export, and every side effect lives inside `server()`/the hooks, each wrapped. The legacy
 *  loader also throws `TypeError` on any non-function NAMED export, so the module exports exactly one
 *  thing: the `{id, server}` default.
 *
 *  UNPAIRED IS THE COMMON CASE. `loadConfig()` returning null (no `~/.config/cc-status/config.json`)
 *  means this machine was never paired with the phone; we return `{}` and cost the user nothing.
 *  Pairing is shared across agents — pair once from Claude Code or Codex and this plugin is paired.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { buildEnvelope, markDoneDelivered, trackSession } from "../core/hook";
import {
  atomicWrite, CC_DIR, Config, ensureWatchdog, folderIdentity, FolderIdentity, fullTextForRecord,
  lastHookPath, loadConfig, postFullText, SessionOrigin, WATCHDOG_PATH,
} from "../core/shared";
import {
  ocDecisionRequest, OcDecisionRequest, ocPost, ocResolvedRequestId, ocResolveOnRelay, runOcApproval,
} from "./approvals";
import {
  newOcState, ocAttentionFrame, ocEndFrames, ocForgetStatusFrame, OcFrame, OcState, postOcEvent,
  reduceOcEvent,
} from "./state";

/** The verified-live shape of OpenCode's `PluginInput` (1.18.15). Declared structurally rather than
 *  imported from `@opencode-ai/plugin`, which is not a dependency of this repo (the plugin ships as a
 *  bundle, and adding an npm dep to a zero-dependency plugin to get five field names is a bad trade).
 *  Note there is NO `app` key — the published docs' examples are out of date. */
interface OpenCodePluginInput {
  directory?: string;
  worktree?: string;
  /** OpenCode's own `OpencodeClient`. THE reply transport for the permission/question routes — the
   *  typed surface has no namespace for either, so `approvals.ts`'s `ocPost` goes through the
   *  generated SDK's `_client.post`. Untyped here for the same reason the rest of this interface is. */
  client?: unknown;
  /** A URL OBJECT ending in "/". LOOKS like this server's origin and IS NOT: OpenCode's getter
   *  fabricates `http://localhost:4096` whenever there is no TCP listener, which is every TUI session.
   *  Never reach for it without reading `ocPost` first — it is a fallback, not a route. */
  serverUrl?: unknown;
}

interface OpenCodeHooks {
  event?: (input: { event: unknown }) => Promise<void>;
  dispose?: () => Promise<void>;
}

/** THE LANDMINE (plan landmine #2). `ensureWatchdog`'s default spawner falls back to
 *  `process.execPath` — under OpenCode that is OpenCode's own single-file Bun executable, and
 *  `opencode …/cc-watchdog.mjs` is not a JS-runtime invocation, it is OpenCode being told to open a
 *  file. So we resolve a REAL runtime the same way `plugin/scripts/run.sh` does, in the same order:
 *  `$NOMO_RUNTIME` (the shim's own resolved interpreter, when a hook set it) → the `~/.config/
 *  cc-status/runtime` cache run.sh writes → give up in silence.
 *
 *  Giving up is not cosmetic: the watchdog's `kill(pid,0)` sweep (~5s) is the ONLY thing that retires
 *  a row when the OpenCode server dies without a `dispose()` (a SIGKILL, a crash, a closed terminal).
 *  Without it the phone holds a working row until the worker's one-hour eviction. */
function resolveRuntime(): string | undefined {
  const env = process.env.NOMO_RUNTIME;
  if (env && env.length > 0 && isExecutable(env)) return env;
  try {
    const cached = readFileSync(`${CC_DIR}/runtime`, "utf8").trim();
    // run.sh writes a `NONE:<epoch>` sentinel when it found no runtime at all — that is a negative
    // cache, not a path.
    if (cached.length > 0 && !cached.startsWith("NONE:") && isExecutable(cached)) return cached;
  } catch { /* no cache yet — a hook has never run on this machine */ }
  return undefined;
}

function isExecutable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

function spawnWatchdog(): void {
  const runtime = resolveRuntime();
  if (!runtime) return; // silence is the contract; the worker's eviction is the remaining backstop
  spawn(runtime, [WATCHDOG_PATH], { detached: true, stdio: "ignore" }).unref();
}

interface OcContext {
  config: Config;
  machine: string;
  folder: FolderIdentity;
  origin: SessionOrigin;
  state: OcState;
}

/** Turn one planned frame into the same three effects a hook produces, in the same order: seal the
 *  envelope, write the session record (BEFORE the POST — `donePending` is stamped pessimistically so
 *  a lost `done` stays owed), then POST and, only on a confirmed 2xx, clear the done debt.
 *
 *  The record's pid is `process.pid` — the OPENCODE SERVER's pid. That is the whole liveness contract:
 *  the watchdog reaps this row within ~5s of that process dying. */
async function send(ctx: OcContext, frame: OcFrame): Promise<void> {
  const now = Date.now();
  // There is no hook payload on this path — the frame IS the payload — so the input carries only what
  // buildBlob genuinely needs from it (the session id and the cwd the folder identity is pinned to) and
  // the free-text sub-status rides the `detailOverride` seam instead of a hook shape reverse-engineered
  // to produce it.
  const input: Record<string, unknown> = { session_id: frame.sessionId, cwd: ctx.folder.cwd };
  /** The `plan` the blob actually ended up carrying — appendFittedPlan may truncate a long todo list
   *  (or drop it) to stay inside the worker's 3072-char sealed ceiling. Captured from the tee so the
   *  overflow can be parked for the LAN `read` op and the remote /v1/cc/full pull. */
  let fittedPlan: string | undefined;
  const envelope = await buildEnvelope(
    input, ctx.machine, now, frame.title, ctx.config.e2eKey, false, "opencode",
    frame.startedAt, frame.turnStartedAt, ctx.folder, frame.model,
    { op: frame.op, prio: frame.prio, status: frame.status },
    undefined, frame.plan, undefined, (plain) => { fittedPlan = plain.plan; }, frame.detail,
  );
  // An unsealable frame reaches the phone exactly as little as a failed POST does — retract the skip
  // key for the same reason (see ocForgetStatusFrame).
  if (!envelope) { ocForgetStatusFrame(ctx.state, frame.sessionId); return; }
  /** The WHOLE todo list, capped, parked on the session record — even when it fitted the blob whole.
   *  This is the only copy of an OpenCode plan any REBUILT frame has: a watchdog corrective or a LAN
   *  record-terminal frame re-seals a fresh plaintext from the record and would otherwise ship the row
   *  with no plan at all until the next plugin-authored frame (see the adapter's `ambientPlan`). It
   *  also serves the LAN `read` op, which simply returns the same text the blob already carries when
   *  nothing was cut. */
  const planFull = fullTextForRecord(frame.plan, undefined);
  // Started BEFORE the event POST and awaited after, exactly like the permission hold's own upload: a
  // parked list must never sit in front of the frame that puts the row on the phone. The UPLOAD is
  // still gated on something actually having been CUT (`fullTextForRecord` against the fitted copy →
  // undefined when the blob already carries the whole list), which is the overwhelmingly common case —
  // a real todo list maxes at ~972 chars against an 1800 budget — and is a no-op inside postFullText:
  // no upload, no KV write.
  const fullUpload = postFullText(ctx.config, frame.sessionId, "plan", fullTextForRecord(frame.plan, fittedPlan));
  await trackSession(
    frame.sessionId, frame.op, frame.prio, frame.status, envelope.blob as string | undefined,
    ctx.machine, ctx.folder,
    "", // no transcript: OpenCode's history is SQLite, and every reader guards an empty path
    "opencode", frame.startedAt, frame.turnStartedAt, undefined, frame.title, ctx.config.pairingId,
    frame.model, false, process.pid, ctx.origin, false, undefined, undefined, planFull,
  );
  ensureWatchdog({ spawnWatchdog });
  // Liveness stamp — the OpenCode twin of the one runHook writes for Claude/Codex (core/hook.ts). It
  // is the ONLY on-disk proof this resident plugin is loaded and producing frames: OpenCode has no
  // hooks to count and no transcript directory to date, so without it `nomo status` cannot tell "the
  // plugin is running, you just haven't started a turn" from "the plugin never loaded". Best-effort
  // and swallowed, like every other write on this path — the editor must never see it fail.
  await atomicWrite(lastHookPath("opencode"), String(now)).catch(() => {});
  const delivered = await postOcEvent(ctx.config, envelope);
  if (delivered && frame.op === "done") await markDoneDelivered(frame.sessionId);
  // NOT delivered → the phone never saw this frame, so the reducer must stop believing it did.
  if (!delivered) ocForgetStatusFrame(ctx.state, frame.sessionId);
  await fullUpload;
}

const server = async (input: OpenCodePluginInput): Promise<OpenCodeHooks> => {
  try {
    const config = await loadConfig();
    if (!config) return {}; // not paired — no-op in silence, the same contract as the hooks

    const directory = typeof input?.directory === "string" && input.directory.length > 0
      ? input.directory
      : typeof input?.worktree === "string" ? input.worktree : undefined;
    const ctx: OcContext = {
      config,
      machine: config.machineName ?? hostname().replace(/\.local$/, ""),
      // The `event` hook is DIRECTORY-SCOPED by OpenCode itself, so one plugin instance only ever
      // sees one project's sessions: the folder identity is resolved once, at init, and pinned for
      // every session this instance reports.
      folder: folderIdentity(directory),
      origin: { hook_event_name: "opencode", ...(directory ? { cwd: directory } : {}), ppid: process.ppid },
      state: newOcState(),
    };

    // Serialize every send. Frames for one session must reach the worker in order, and OpenCode
    // dispatches the `event` hook WITHOUT awaiting it (`void hook.event(...)`), so two events ~10ms
    // apart would otherwise race through two 2s POSTs. ponytail: one global chain, not per-session —
    // the volume is a handful of frames per turn; split it if a busy multi-session server ever lags.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (task: () => Promise<void>): Promise<void> => {
      chain = chain.then(task).catch(() => { /* never surface into the user's editor */ });
      return chain;
    };

    // The reply transport, resolved ONCE at init. Without it a hold could put an Allow button on the
    // phone that this process has no route to honor, which is strictly worse than not holding at all —
    // so no transport, no approvals, and the TUI dialog stays the only way to answer.
    const serverUrl = input?.serverUrl === undefined || input.serverUrl === null
      ? undefined
      : String(input.serverUrl);
    const canReply = ocPost(input?.client, serverUrl) !== undefined;

    /** OpenCode request id (`per_…` / `que_…`) → the decision id its hold is polling the worker for.
     *  The map IS the hold registry: an entry means "a hold for this request is still running", which
     *  is what makes the reject/always cascades resolvable (see ocResolveOnRelay). */
    const holds = new Map<string, string>();

    /** Start ONE hold, detached. Deliberately NOT on `enqueue`: a hold is unbounded by design (the
     *  phone owns the dialog), and putting it on the send chain would freeze every session frame on
     *  this server behind one unanswered prompt. */
    const hold = (request: OcDecisionRequest): void => {
      // A subagent's prompt is not human-facing here — its session is filtered out of the phone's
      // rows entirely, so a card for it would be answerable against a row the user cannot see. Same
      // policy as the Claude hook's `agent_id` subagent pass-through.
      if (!canReply || ctx.state.children.has(request.sessionID) || holds.has(request.id)) return;
      const requestId = crypto.randomUUID();
      holds.set(request.id, requestId);
      void runOcApproval(request, {
        config: ctx.config,
        client: input?.client,
        serverUrl,
        cwd: ctx.folder.cwd,
        requestId,
        // The local no-hold escape hatch: report the session as blocked on the user and let OpenCode's
        // own dialog take it, exactly like the hooks' fire-and-forget delegate.
        delegate: async () => {
          const attention = ocAttentionFrame(ctx.state, request.sessionID, undefined);
          if (attention) await enqueue(() => send(ctx, attention));
        },
      }).catch(() => { /* runOcApproval swallows everything; this is the belt */ })
        .finally(() => { holds.delete(request.id); });
    };

    /** OpenCode resolved a request without us — the user answered at the Mac, or a reject/always
     *  cascade took it down with a sibling. Retire the phone's card so it cannot be left hanging. */
    const retire = (opencodeId: string): void => {
      const requestId = holds.get(opencodeId);
      if (requestId === undefined) return;
      holds.delete(opencodeId);
      void ocResolveOnRelay(ctx.config, requestId);
    };

    return {
      event: async ({ event }) => {
        try {
          // The approval channels first, and they are EXCLUSIVE of the lifecycle reducer: neither
          // `permission.asked` nor `question.asked` is a session frame — each opens a hold that POSTs
          // its own decisionPending frame on a different route entirely.
          const request = ocDecisionRequest(event);
          if (request) { hold(request); return; }
          const resolved = ocResolvedRequestId(event);
          if (resolved) { retire(resolved); return; }
          const frame = reduceOcEvent(ctx.state, event);
          if (frame) await enqueue(() => send(ctx, frame));
        } catch { /* one malformed event must never break the firehose */ }
      },
      dispose: async () => {
        try {
          // Every pending question/permission is auto-rejected by OpenCode's own service finalizer at
          // shutdown, and it publishes no event for that — so the cards have to be retired from here or
          // they outlive the server that could have answered them.
          for (const opencodeId of [...holds.keys()]) retire(opencodeId);
          const frames = ocEndFrames(ctx.state);
          await enqueue(async () => { for (const frame of frames) await send(ctx, frame); });
        } catch { /* teardown is best-effort; the watchdog's pid sweep is the backstop */ }
      },
    };
  } catch {
    return {}; // a broken init must never take the editor down with it
  }
};

export default { id: "nomo", server };
