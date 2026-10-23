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
  lastHookPath, loadConfig, postFullText, runtimeArgs, SessionOrigin, WATCHDOG_PATH,
} from "../core/shared";
import {
  ocDecisionRequest, OcDecisionRequest, ocPost, ocResolvedRequestId, ocResolveOnRelay, runOcApproval,
} from "./approvals";
import {
  newOcState, ocEndFrames, ocForgetStatusFrame, OcFrame, ocPromptAsked, ocPromptFrame, ocPromptHeld,
  ocPromptResolved, ocPromptsEndedBy, ocRowHeld, OcState, postOcEvent, reduceOcEvent,
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
  spawn(runtime, runtimeArgs(runtime, [WATCHDOG_PATH]), { detached: true, stdio: "ignore" }).unref(); // NOM-133
}

/** How long a CONFIRMED-live watchdog is taken on trust before we look again. A hook pays the check
 *  once per process; this plugin is RESIDENT and calls it on every frame, and the check is not cheap —
 *  it hashes the whole ~341 KB watchdog bundle and forks a `ps` — all of it on the thread OpenCode
 *  runs its own server on. A minute of trust turns steady-state frames into no syscalls at all while
 *  still re-verifying often enough that a daemon killed mid-session is respawned long before the
 *  worker's one-hour eviction would matter. */
const WATCHDOG_TRUST_MS = 60_000;
/** When that trust expires. Only a POSITIVE verdict extends it (ensureWatchdog's return): a spawn, a
 *  failure, or the test opt-out leaves it in the past, so the very next frame checks again. */
let watchdogTrustedUntil = 0;

/** The resident twin of a hook's bare `ensureWatchdog()` call — same guarantee, TTL'd. */
function ensureWatchdogCached(now: number): void {
  if (now < watchdogTrustedUntil) return;
  watchdogTrustedUntil = ensureWatchdog({ spawnWatchdog }) ? now + WATCHDOG_TRUST_MS : 0;
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
  ensureWatchdogCached(now);
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

    /** Repaint a session's ROOT row from the pending-prompt registry: needsAttention while a prompt is
     *  up, working again once the last one is gone. Called on every edge (asked, replied, hold ended)
     *  and it READS the answer each time, so no edge has to know what the others did. Paints nothing
     *  while a hold's card owns the row — see ocPromptHeld. `workingOnly` is for the one caller that
     *  must never repaint attention (a GRANTED hold's exit, below).
     *
     *  THE FRAME IS DECIDED WHEN IT IS SENT, inside the chain — not when the edge fired. The chain can be
     *  seconds deep (each send is a POST with a 2 s budget), and a hold posts its card on a different
     *  route entirely: a "working" decided at enqueue time for an answered prompt landed AFTER the next
     *  prompt's card and, being a prio:0 frame, took that card down. */
    const repaint = (sessionID: string, workingOnly = false): Promise<void> => enqueue(async () => {
      const frame = ocPromptFrame(ctx.state, sessionID);
      if (frame && !(workingOnly && frame.status !== "working")) await send(ctx, frame);
    });

    /** Send one REDUCER-planned frame — unless it is a working update and a hold's card has gone up on
     *  its row while it sat in the chain (the same hazard repaint has; the reducer mutes working only for
     *  prompts that were already up when it planned). Only `update`/working is dropped: a `start` opens
     *  the row the hold needs, and done/end are the truth whatever is held. The skip key is retracted so
     *  the busy that follows the hold is sent rather than taken for a repeat. */
    const sendPlanned = async (frame: OcFrame): Promise<void> => {
      if (frame.op === "update" && frame.status === "working" && ocRowHeld(ctx.state, frame.sessionId)) {
        ocForgetStatusFrame(ctx.state, frame.sessionId);
        return;
      }
      await send(ctx, frame);
    };

    /** Start ONE hold, detached. Deliberately NOT on `enqueue`: a hold is unbounded by design (the
     *  phone owns the dialog), and putting it on the send chain would freeze every session frame on
     *  this server behind one unanswered prompt. */
    const hold = (request: OcDecisionRequest): void => {
      if (holds.has(request.id)) return;
      // A SUBAGENT's prompt is SHOWN, not held: its root row goes needsAttention ("answer at your
      // Mac") instead of sitting on working while OpenCode waits on a human. It gets no Allow/Deny
      // card — the hold machinery (marker, record, settle) is keyed by the session that asked, and
      // that session has no row. The same plain attention covers a server we have no reply route to.
      if (!canReply || ctx.state.children.has(request.sessionID)) { void repaint(request.sessionID); return; }
      const requestId = crypto.randomUUID();
      holds.set(request.id, requestId);
      ocPromptHeld(ctx.state, request.id, true);
      let delegated = false;
      void runOcApproval(request, {
        config: ctx.config,
        client: input?.client,
        serverUrl,
        cwd: ctx.folder.cwd,
        requestId,
        // The local no-hold escape hatch: report the session as blocked on the user and let OpenCode's
        // own dialog take it, exactly like the hooks' fire-and-forget delegate.
        delegate: async () => {
          delegated = true;
          ocPromptHeld(ctx.state, request.id, false); // paused = no card, so the row is ours to paint
          await repaint(request.sessionID);
        },
      }).catch(() => ({ answered: false, granted: false }) /* runOcApproval swallows everything; this is the belt */)
        .then(({ answered, granted }) => {
          holds.delete(request.id);
          ocPromptHeld(ctx.state, request.id, false);
          if (answered) return; // the hold re-sealed the record as working itself
          // A GRANTED HOLD'S UNANSWERED EXIT RE-SEALS THE RECORD AS needsAttention (runPermissionHook's
          // settle), up to one poll (~3 s) AFTER the `permission.replied` that already repainted the
          // row working when the user answered at the Mac — a stale yellow the watchdog/LAN feed would
          // then re-ship. So re-assert working if that is what the registry says, and never attention:
          // that settle already wrote it, with its `reconnecting` marker when the hold gave up. The
          // paused path painted its own attention in `delegate`, so it is working-only here too.
          //
          // A HOLD THAT WAS NEVER GRANTED (the worker refused it, or the POST never landed) wrote
          // NOTHING: no marker, so no settle — while the registry mutes every busy for as long as the
          // prompt is pending. Paint whatever the registry says, which is the plain needsAttention
          // ("answer at your Mac") until OpenCode reports the prompt gone.
          void repaint(request.sessionID, granted || delegated);
        });
    };

    /** A prompt is over (replied, its tool finished, its session ended): forget it and repaint. */
    const settle = (opencodeId: string): void => {
      const root = ocPromptResolved(ctx.state, opencodeId);
      if (root !== undefined) void repaint(root);
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
          if (request) { ocPromptAsked(ctx.state, event); hold(request); return; }
          const resolved = ocResolvedRequestId(event);
          if (resolved) { retire(resolved); settle(resolved); return; }
          const frame = reduceOcEvent(ctx.state, event);
          // AFTER the reducer (a turn end plans its done first, and then there is nothing to repaint)
          // and BEFORE the await (state must be folded in arrival order; sends are ordered by the chain).
          const sent = frame ? enqueue(() => sendPlanned(frame)) : undefined;
          for (const ended of ocPromptsEndedBy(ctx.state, event)) {
            // Only a finished TOOL retires a card: that is per-call proof the request is gone. A turn
            // end just stops the prompt muting the row — a hold is never taken down on inference.
            if (ended.byTool) retire(ended.id);
            settle(ended.id);
          }
          await sent;
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
