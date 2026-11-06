// devin — the Devin (CLI + Desktop's "Devin Local") hook → Nomo frame producer (NOM-158).
//
// The Cursor recipe (core/cursor.ts): Devin's hooks are Claude-SHAPED (same event names, `session_id`,
// `tool_name`), but the payload has no `transcript_path` and no `cwd`, only a prompt may create a row,
// and the owning pid is not the hook's parent. So this is a small producer of its own that reuses the
// shared seal/record/POST pieces (buildEnvelope, trackSessionAt, postOcEvent) and touches nothing in
// hook.ts.
//
//   Devin hook event                   → row status on the phone
//   SessionStart                       not registered (only a prompt creates a row)
//   UserPromptSubmit                   start (no row yet) / update · working, new turn anchor
//   PostToolUse                        update · working (detail thinking), keep-alive ≤ every 15 s;
//                                      clears a needs-attention row at once
//   PreToolUse ^ask_user_question$     update prio 1 · needsAttention (display-only heads-up)
//   PermissionRequest, approvals paused  update prio 1 · needsAttention (devin-approve delegates here)
//   Stop                               done
//   SessionEnd                         end (row retired)
//
// THE CONTRACT WITH DEVIN: observe only. This process prints nothing (so it can never return a
// decision, block a prompt or rewrite a tool call), always exits 0 and swallows every error. Devin
// waits for UserPromptSubmit, so that path does no sqlite read and at most one awaited 2 s POST.

import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { devinAdapter, devinSessionMeta } from "./adapter";
import { CURSOR_KEEPALIVE_MS, CURSOR_UNKNOWN_OWNER_PID } from "./cursor";
import { buildEnvelope, markDoneDeliveredAt, OpPlan, trackSessionAt } from "./hook";
import {
  atomicWrite, Config, devinConfigDir, ensureWatchdog, folderIdentity, lastHookPath, loadConfig, pidAlive, pidAncestors,
  pidCommand, readRecord, SESSIONS_DIR, SessionRecord, traceSession,
} from "./shared";
import { postOcEvent } from "../opencode/state";

export type DevinEventKind = "prompt" | "tool" | "ask" | "permission" | "stop" | "end";

const EVENT_KINDS: Record<string, DevinEventKind> = {
  UserPromptSubmit: "prompt",
  PostToolUse: "tool",
  PermissionRequest: "permission",
  Stop: "stop",
  SessionEnd: "end",
};

/** The one PreToolUse we listen to (the installer's matcher): Devin asking the user a question. */
export const DEVIN_ASK_TOOL = "ask_user_question";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Classify one payload; anything unrecognised is ignored (undefined), never guessed into a state. */
export function devinEventKind(input: Record<string, unknown>): DevinEventKind | undefined {
  const name = str(input.hook_event_name);
  if (name === "PreToolUse") return input.tool_name === DEVIN_ASK_TOOL ? "ask" : undefined;
  return name ? EVENT_KINDS[name] : undefined;
}

/** A session id becomes a FILENAME under the sessions dir and arrives on stdin (Cursor's rule). */
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

export interface DevinPlan extends OpPlan {
  /** Epoch SECONDS — re-stamped by a prompt, else the cached anchor. */
  turnStartedAt?: number;
  /** The turn's `prompt_id`, parked in the record's `turnId`. Only a prompt sets a new one. */
  promptId?: string;
}

/** The state mapping, pure. ONLY A PROMPT CREATES A ROW (Cursor's rule). A tool event on a done row
 *  re-arms it only when it names the SAME prompt_id the prompt stamped: a Stop hook that blocked kept
 *  that turn going, or the watchdog's idle reap guessed done mid-turn. Anything else is a straggler. */
export function planDevin(
  kind: DevinEventKind, input: Record<string, unknown>, record: SessionRecord | null, now: number,
): DevinPlan | null {
  const promptId = str(input.prompt_id);
  const nowSec = Math.floor(now / 1000);
  if (!record) {
    return kind === "prompt" ? { op: "start", prio: 0, status: "working", turnStartedAt: nowSec, promptId } : null;
  }
  const cachedTurn = typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt)
    ? record.turnStartedAt : undefined;
  const turn = str(record.turnId);
  const isDone = record.op === "done" || record.lastEvent === "done";
  const working = { op: "update" as const, prio: 0 as const, status: "working" as const, turnStartedAt: cachedTurn, promptId: turn };
  switch (kind) {
    case "prompt":
      return { op: "update", prio: 0, status: "working", turnStartedAt: nowSec, promptId };
    case "tool":
      if (isDone) return promptId !== undefined && promptId === turn ? working : null;
      if (record.lastEvent === "needsAttention") return working;
      if (typeof record.ts === "number" && now - record.ts < CURSOR_KEEPALIVE_MS) return null;
      return working;
    case "ask":
    case "permission":
      if (isDone && !(promptId !== undefined && promptId === turn)) return null;
      return { op: "update", prio: 1, status: "needsAttention", turnStartedAt: cachedTurn, promptId: turn };
    case "stop":
      // A second Stop for a turn already reported done (and delivered) adds nothing.
      if (isDone && record.donePending !== true) return null;
      return { op: "done", prio: 0, status: "done", turnStartedAt: cachedTurn, promptId: turn };
    case "end":
      return { op: "end", prio: 0, status: "done", turnStartedAt: cachedTurn, promptId: turn };
    default:
      return null;
  }
}

// ── one install wins: the `nomo-ai --devin` hooks, or the native Devin plugin ─────────────────────

/** Nomo's two commands as `nomo-ai --devin` writes them into Devin's config.json. A TWIN of OWNED in
 *  plugin/scripts/devin-install.mjs (pinned equal by devin-install.test.ts) — that script runs from a
 *  clone with no build step, and importing it here would bundle its CLI `main()`. */
export const DEVIN_INSTALLER_COMMAND = /^'([^']+\/)scripts\/run\.sh' '\1dist\/devin-(status|approve)\.mjs'(; exit 0)?$/;

/** The plugin hooks' marker argv (root hooks.json, from devinPluginHooks in devin-install.mjs). */
export const DEVIN_PLUGIN_FLAG = "--via=devin-plugin";

/** Does this Devin config.json text carry a LIVE `nomo-ai --devin` install — one of our commands
 *  whose checkout still has its run.sh? A dead checkout is not an install (the plugin must not go
 *  quiet behind hooks that can no longer run). Every JSON string literal is checked, so a JSONC file
 *  needs no parser. ponytail: a commented-out command line still counts; --uninstall is the off switch. */
export function devinInstallerActive(configText: string, exists: (p: string) => boolean = existsSync): boolean {
  for (const m of configText.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    let value: unknown;
    try { value = JSON.parse(`"${m[1]}"`); } catch { continue; }
    const owned = typeof value === "string" ? DEVIN_INSTALLER_COMMAND.exec(value) : null;
    if (owned && exists(`${owned[1]}scripts/run.sh`)) return true;
  }
  return false;
}

/** Devin's plugin lock (read only). */
export const devinPluginLockPath = (): string => `${process.env.HOME ?? ""}/.local/share/devin/cli/plugins/lock.json`;

/** Is the Nomo Devin plugin (manifest name `nomo`) installed, per lock.json's text? A TWIN of
 *  devinPluginInstalled in devin-install.mjs. */
export function devinPluginInstalled(lockText: string): boolean {
  try {
    const resolved: unknown = JSON.parse(lockText)?.resolved;
    return Array.isArray(resolved) && resolved.some((r) => typeof r === "object" && r !== null && (r as { name?: unknown }).name === "nomo");
  } catch {
    return false;
  }
}

/** Should this invocation stay silent? Only a PLUGIN hook (argv carries DEVIN_PLUGIN_FLAG), and only
 *  while the installer's hooks are live in Devin's config — they run on the same events, so the plugin
 *  firing too would double every frame and every phone card. NOMO_DEVIN_CONFIG is a test seam (a
 *  `devin --config <file>` run). */
export function devinPluginStandsDown(
  argv: readonly string[] = process.argv,
  configPath: string = process.env.NOMO_DEVIN_CONFIG ?? `${devinConfigDir()}/config.json`,
): boolean {
  if (!argv.includes(DEVIN_PLUGIN_FLAG)) return false;
  try { return devinInstallerActive(readFileSync(configPath, "utf8")); } catch { return false; }
}

const argv0 = (command: string): string => command.trimStart().split(/\s/, 1)[0] ?? "";

/** The session's owner out of the hook's ancestor chain (nearest first): the nearest process whose
 *  EXECUTABLE is `devin` (the CLI's `devin acp` agent server in practice — it lives exactly as long as
 *  the session). Never an argument: `vim ~/.local/bin/devin` is not Devin. Undefined → the caller
 *  records CURSOR_UNKNOWN_OWNER_PID and the idle nets retire the row. Pure. */
export function devinOwnerPid(chain: { pid: number; command: string | undefined }[]): number | undefined {
  return chain.find((p) => p.command !== undefined && /(^|\/)devin$/.test(argv0(p.command)))?.pid;
}

function resolveOwnerPid(): number | undefined {
  const pids = [process.ppid, ...pidAncestors(process.ppid)];
  return devinOwnerPid(pids.map((pid) => ({ pid, command: pidCommand(pid) })));
}

/** Seams for the tests — every default is the production value. */
export interface DevinHookDeps {
  config?: Config | null;
  sessionsDir?: string;
  stampPath?: string;
  now?: () => number;
  env?: Record<string, string | undefined>;
  ownerPid?: () => number | undefined;
  sessionMeta?: (sessionId: string) => { title?: string; model?: string; cwd?: string };
  post?: (config: Config, envelope: Record<string, unknown>) => Promise<boolean>;
  ensureWatchdog?: () => void;
  trace?: (event: object) => void;
}

/** One hook invocation, start to finish. Never throws, never prints. */
export async function runDevinHook(raw: string, deps: DevinHookDeps = {}): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const input = parsed as Record<string, unknown>;
    const env = deps.env ?? process.env;
    const projectDir = env.DEVIN_PROJECT_DIR;
    if (projectDir === undefined) return; // not Devin calling

    const now = (deps.now ?? Date.now)();
    // Liveness stamp, before every gate below — status-cmd reads it ("hooks are firing").
    await atomicWrite(deps.stampPath ?? lastHookPath("devin"), String(now)).catch(() => {});

    const kind = devinEventKind(input);
    const sessionId = str(input.session_id);
    if (!kind || !sessionId || !SAFE_ID.test(sessionId)) return;

    const config = deps.config !== undefined ? deps.config : await loadConfig();
    if (!config) return; // not paired → inert

    const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
    const record = await readRecord(sessionId, sessionsDir);
    if (record && record.agent !== "devin") return; // another agent's row is not ours to rewrite

    const plan = planDevin(kind, input, record, now);
    if (!plan) return;

    // Devin's own title/model, only on frames that are going out anyway after the prompt — never on
    // the prompt (Devin waits on it, and a new session has no title yet).
    const meta = kind === "prompt" || kind === "end" ? {} : (deps.sessionMeta ?? devinSessionMeta)(sessionId);
    const machine = config.machineName ?? hostname().replace(/\.local$/, "");
    const cwd = str(projectDir) ?? meta.cwd;
    const folder = folderIdentity(cwd, record);
    const title = meta.title ?? record?.title ?? await devinAdapter.title({ sessionId, prefix: "", input });
    const model = meta.model ?? record?.model;
    const startedAt = typeof record?.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt)
      ? record.sessionStartedAt : now;

    // The owner is resolved once, when the row is created (a `ps` per ancestor is the slow part).
    let pid = record?.pid;
    if (typeof pid !== "number") {
      pid = (deps.ownerPid ?? resolveOwnerPid)() ?? CURSOR_UNKNOWN_OWNER_PID;
      if (pid !== CURSOR_UNKNOWN_OWNER_PID && !pidAlive(pid)) pid = CURSOR_UNKNOWN_OWNER_PID;
    }

    // An allow-listed input, NOT the payload: the id, the folder, and the event name (so PostToolUse
    // seals detail "thinking"). tool_input / prompt never reach buildBlob.
    const hookEventName = str(input.hook_event_name) ?? kind;
    const envelope = await buildEnvelope(
      { session_id: sessionId, ...(cwd ? { cwd } : {}), hook_event_name: hookEventName }, machine, now, title,
      config.e2eKey, false, "devin", startedAt, plan.turnStartedAt, folder, model,
      { op: plan.op, prio: plan.prio, status: plan.status },
    );
    if (!envelope) return;

    const origin = record?.origin ?? { hook_event_name: hookEventName, ...(cwd ? { cwd } : {}), ppid: process.ppid };
    await trackSessionAt(
      sessionsDir, sessionId, plan.op, plan.prio, plan.status, envelope.blob as string | undefined,
      machine, folder, "", "devin", startedAt, plan.turnStartedAt, plan.promptId, title,
      config.pairingId, model, false, pid, origin,
    );
    const trace = deps.trace ?? traceSession;
    if (!record) trace({ event: "create", sessionId, agent: "devin", hook_event_name: hookEventName, origin });
    else if (plan.op === "end") trace({ event: "retire", sessionId, agent: "devin", reason: "hook op:end" });
    (deps.ensureWatchdog ?? ensureWatchdog)();

    const delivered = await (deps.post ?? postOcEvent)(config, envelope);
    if (delivered && plan.op === "done") await markDoneDeliveredAt(sessionsDir, sessionId);
  } catch {
    // Silence is the contract — nothing may surface into a Devin session.
  }
}
