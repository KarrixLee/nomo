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
  CC_DIR, Config, ensureWatchdog, folderIdentity, FolderIdentity, loadConfig, SessionOrigin,
  WATCHDOG_PATH,
} from "../core/shared";
import { newOcState, ocEndFrames, OcFrame, OcState, postOcEvent, reduceOcEvent } from "./state";

/** The verified-live shape of OpenCode's `PluginInput` (1.18.15). Declared structurally rather than
 *  imported from `@opencode-ai/plugin`, which is not a dependency of this repo (the plugin ships as a
 *  bundle, and adding an npm dep to a zero-dependency plugin to get five field names is a bad trade).
 *  Note there is NO `app` key — the published docs' examples are out of date. */
interface OpenCodePluginInput {
  directory?: string;
  worktree?: string;
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
  // buildBlob derives `detail` from a hook payload's tool fields, and this path has no hook payload.
  // A `retry` message is exactly what `detail` is for (the island's sub-status line), so we hand
  // buildBlob the one input shape that yields free-text detail rather than duplicating the pinned
  // blob key order here — two producers of one blob shape drifting is a bug this repo has shipped
  // before. ponytail: a `detailOverride` seam on buildBlob would retire the disguise; not worth
  // touching a file three other agents are editing.
  const input: Record<string, unknown> = frame.detail
    ? {
      session_id: frame.sessionId,
      cwd: ctx.folder.cwd,
      hook_event_name: "PreToolUse",
      tool_name: "request_user_input",
      tool_input: { questions: [{ question: frame.detail }] },
    }
    : { session_id: frame.sessionId, cwd: ctx.folder.cwd };
  const envelope = await buildEnvelope(
    input, ctx.machine, now, frame.title, ctx.config.e2eKey, false, "opencode",
    frame.startedAt, frame.turnStartedAt, ctx.folder, frame.model,
    { op: frame.op, prio: frame.prio, status: frame.status },
  );
  if (!envelope) return;
  await trackSession(
    frame.sessionId, frame.op, frame.prio, frame.status, envelope.blob as string | undefined,
    ctx.machine, ctx.folder,
    "", // no transcript: OpenCode's history is SQLite, and every reader guards an empty path
    "opencode", frame.startedAt, frame.turnStartedAt, undefined, frame.title, ctx.config.pairingId,
    frame.model, false, process.pid, ctx.origin,
  );
  ensureWatchdog({ spawnWatchdog });
  const delivered = await postOcEvent(ctx.config, envelope);
  if (delivered && frame.op === "done") await markDoneDelivered(frame.sessionId);
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

    return {
      event: async ({ event }) => {
        try {
          const frame = reduceOcEvent(ctx.state, event);
          if (frame) await enqueue(() => send(ctx, frame));
        } catch { /* one malformed event must never break the firehose */ }
      },
      dispose: async () => {
        try {
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
