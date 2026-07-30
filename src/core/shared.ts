// shared — infrastructure shared by the hook core and the cc-watchdog poller.
//
// Kept deliberately tiny: on-disk paths, the config reader, the per-session record shape, and a
// few side-effect primitives (atomic write, pid liveness, bounded file reads). The hook
// (cc-status.ts) runs main() at top level, so the watchdog can't safely import IT — instead both
// import these leaf helpers. Nothing here touches stdout or throws across its boundary; callers
// stay best-effort.
//
// PORTABILITY: this module (and everything it's imported into) must run unmodified under BOTH bun
// and node >= 18 — no `Bun.*` APIs. File IO goes through node:fs/promises; base64 decode goes
// through the portable crypto.ts helpers. Task 2.3 bundles these .ts files to a single .mjs.

import { access, chmod, open, readFile, rename, stat, mkdir, unlink, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { b64url, deriveE2EKey, deriveRatchetKey, encryptBlob, fromB64url } from "./crypto";

// The plugin's own build version, injected by build.ts as a compile-time define (`__NOMO_VERSION__`,
// read from plugin/.claude-plugin/plugin.json). Sent as the plaintext `x-cc-version` request header on
// every /cc/event POST so the app can flag "update available" per computer — it NEVER rides inside the
// E2E blob or the envelope JSON. The `typeof` guard keeps the UNBUNDLED path alive: tests (and any
// `bun src/...` run) import the raw .ts with no define, and `typeof <undeclared>` is safe in JS (it
// yields "undefined", never a ReferenceError), so this degrades to the dev sentinel instead of throwing.
declare const __NOMO_VERSION__: string | undefined;
export const PLUGIN_VERSION: string = typeof __NOMO_VERSION__ === "string" ? __NOMO_VERSION__ : "0.0.0-dev";

/** Plan-picker/session state carried in the optional encrypted `dbg` blob field.
 *  Stable grammar (tokens and order are part of the phone contract):
 *    `<version> ev:<event> cls:<verdict> mk:<0|v|p|s> dq:<na|wait|idle>(<na|keep|ign>) ttl:<-|Nm|fire> by:<h|n|wd>`
 *  `mk` is none/verification/pending/settled; `dq` is daemon query + disposition; `ttl` is marker
 *  age (whole minutes) or `fire`; and `by` is hook/notify/watchdog. Values are token-sanitized and the
 *  complete string is code-point capped, so `dbg` is always plain text <= 200 characters. */
export const DBG_BLOB_TEXT_MAX_CHARS = 200;
export type PlanPickerDebugActor = "h" | "n" | "wd";
export type PlanPickerDebugMarker = "0" | "v" | "p" | "s";

function debugToken(value: string): string {
  if (value === "-") return "-";
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "na";
}

export function formatPlanPickerDebug(input: {
  event: string;
  classifier: string;
  marker?: PlanPickerDebugMarker;
  daemon?: "na" | "wait" | "idle";
  daemonDisposition?: "na" | "keep" | "ign";
  ttl?: string;
  by: PlanPickerDebugActor;
  version?: string;
}): string {
  const value = `${debugToken(input.version ?? PLUGIN_VERSION)} ev:${debugToken(input.event)} cls:${debugToken(input.classifier)} mk:${input.marker ?? "0"} dq:${input.daemon ?? "na"}(${input.daemonDisposition ?? "na"}) ttl:${debugToken(input.ttl ?? "-")} by:${input.by}`;
  return Array.from(value).slice(0, DBG_BLOB_TEXT_MAX_CHARS).join("");
}

/** Root of the on-disk state: config.json, the per-session pid files, the watchdog pidfile. */
export const CC_DIR = `${process.env.HOME}/.config/cc-status`;
/** Append-only, local-only session lifecycle/state-machine trace next to config.json. */
export const SESSION_TRACE_PATH = `${CC_DIR}/session-trace.log`;
const SESSION_TRACE_MAX_BYTES = 256 * 1024;
let sessionTraceRotated = false;

/** One-line JSON trace with the same best-effort, owner-only, rotate-once discipline for every
 * producer (hook, notify, watchdog). Nothing here enters the clear envelope. */
export function traceSession(event: object, path: string = SESSION_TRACE_PATH): void {
  try {
    if (!sessionTraceRotated) {
      sessionTraceRotated = true;
      try { if (statSync(path).size > SESSION_TRACE_MAX_BYTES) truncateSync(path, 0); } catch { /* absent */ }
    }
    appendFileSync(path, `${JSON.stringify({ ts: Date.now(), pid: process.pid, ...event })}\n`, { mode: 0o600 });
  } catch { /* tracing must never surface into an agent session */ }
}

export interface PlanPickerTraceDecision {
  source: "hook" | "notify" | "watchdog";
  classifier: string;
  marker: "set-verification" | "set-pending" | "cleared" | "kept" | "none" | "settled";
  daemonQuery?: "not-queried" | "waitingOnUserInput" | "notWaitingOnUserInput" | "unavailable";
  daemonIgnored?: boolean;
  ttlFired?: boolean;
  settle?: "none" | "blocked" | "done";
  correctionPosted?: boolean;
  doneBy?: "hook" | "notify" | "watchdog";
}

/** Fixed-shape Plan-picker decision line. Explicit false/none values keep grep/jq queries stable and
 * make every line answer classifier, marker, daemon, TTL, settlement, correction, and done-owner. */
export function tracePlanPickerDecision(
  sessionId: string, decision: PlanPickerTraceDecision, path?: string,
): void {
  traceSession({
    event: "plan-picker",
    sessionId,
    source: decision.source,
    classifier: decision.classifier,
    marker: decision.marker,
    daemonQuery: decision.daemonQuery ?? "not-queried",
    daemonIgnored: decision.daemonIgnored ?? false,
    ttlFired: decision.ttlFired ?? false,
    settle: decision.settle ?? "none",
    correctionPosted: decision.correctionPosted ?? false,
    doneBy: decision.doneBy ?? null,
  }, path);
}
/** One `<session_id>.json` per live session — written by the hook, reaped by the watchdog. */
export const SESSIONS_DIR = `${CC_DIR}/sessions`;
/** Single-instance handle/lock for the watchdog process. */
export const WATCHDOG_PID_PATH = `${CC_DIR}/watchdog.pid`;
/** The hook touches this (epoch-ms text) after a successful POST; Task 2.2's status command reads it. */
export const LAST_SEND_PATH = `${CC_DIR}/last-send`;
/** Consecutive "pairing is gone" strike counter (small integer text), sitting next to LAST_SEND_PATH.
 *  The hook's POST path increments this on a 404/410 response and tears the pairing down at
 *  GONE_STRIKE_LIMIT, so a revoked pairing stops POSTing forever instead of 404ing on every tool use.
 *  Any success or non-gone status clears it, and removeRevokedConfig deletes it on teardown. */
export const GONE_STRIKES_PATH = `${CC_DIR}/gone-strikes`;
/** How many CONSECUTIVE gone (404/410) responses the hook must see before it tears the local pairing
 *  down. Two, not one: a single 404 can be a transient/racing delete, so we require a second to confirm
 *  the pairing is really gone before deleting the credential-bearing config. */
export const GONE_STRIKE_LIMIT = 2;
/** Local escape-hatch flag for remote approvals: when this zero-byte file exists, the permission hook
 *  skips the phone hold entirely and behaves as a plain fire-and-forget attention event (instant
 *  terminal dialog). Toggled by `nomo-cc permission off|on`. It lives HERE (not in permission.ts, which
 *  re-exports it) because every /cc/event POSTer must report it — and permission.ts already imports
 *  this module, so the reverse import would be a cycle. */
export const NO_HOLD_PATH = `${CC_DIR}/no-hold`;

/** Shared sealed-blob fit ceiling. The worker's hard limit is 3072 base64 characters; keep the
 *  existing 64-character safety margin used by permission frames. Blob producers must measure the
 *  complete plaintext shape before appending optional large text. */
export const BLOB_FIT_CHARS = 3008;

/** Exact base64 length of AES-GCM(iv || ciphertext || tag) for a JSON plaintext byte count. */
export function sealedBlobChars(plaintextBytes: number): number {
  return Math.ceil((12 + plaintextBytes + 16) / 3) * 4;
}

/** The phone-plan preview's preferred cap, including the trailing truncation marker. */
export const PLAN_BLOB_TEXT_MAX_CHARS = 1800;
export const PLAN_BLOB_TRUNCATION_MARKER = "\n…";

/** Append the optional Plan-picker markdown LAST while fitting the ENTIRE sealed blob. `plan` is the
 *  first and only sacrifice: every existing base key is retained. A long plan keeps the longest
 *  code-point prefix that fits both the 1800-character preview cap and BLOB_FIT_CHARS, followed by
 *  "\n…". If even that marker-only minimal value cannot fit, the key is omitted entirely. */
export function appendFittedPlan<T extends Record<string, unknown>>(base: T, plan: string | undefined): T & { plan?: string } {
  if (typeof plan !== "string" || plan.length === 0) return base;
  const chars = Array.from(plan);
  const marker = PLAN_BLOB_TRUNCATION_MARKER;
  const markerChars = Array.from(marker).length;
  const encoder = new TextEncoder();
  const fits = (value: string): boolean =>
    sealedBlobChars(encoder.encode(JSON.stringify({ ...base, plan: value })).length) <= BLOB_FIT_CHARS;

  if (chars.length <= PLAN_BLOB_TEXT_MAX_CHARS && fits(plan)) return { ...base, plan };
  if (!fits(marker)) return base;

  let lo = 0;
  let hi = Math.min(chars.length, PLAN_BLOB_TEXT_MAX_CHARS - markerChars);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(chars.slice(0, mid).join("") + marker)) lo = mid;
    else hi = mid - 1;
  }
  return { ...base, plan: chars.slice(0, lo).join("") + marker };
}

/** Append optional `plan`, then optional `dbg` LAST. Budget precedence is intentional: build the
 *  best-fitting plan first, try the capped debug string on that complete shape, and drop `dbg` whole
 *  if it would overflow. Thus `dbg` is always the FIRST sacrifice; only then may plan be truncated or
 *  omitted by appendFittedPlan. Base fields are never removed. */
export function appendFittedPlanAndDebug<T extends Record<string, unknown>>(
  base: T, plan: string | undefined, dbg: string | undefined,
): T & { plan?: string; dbg?: string } {
  const withPlan = appendFittedPlan(base, plan);
  if (typeof dbg !== "string" || dbg.length === 0) return withPlan;
  const capped = Array.from(dbg).slice(0, DBG_BLOB_TEXT_MAX_CHARS).join("");
  const encoder = new TextEncoder();
  const withDebug = { ...withPlan, dbg: capped };
  return sealedBlobChars(encoder.encode(JSON.stringify(withDebug)).length) <= BLOB_FIT_CHARS
    ? withDebug
    : withPlan;
}

/** Whether a zero-byte marker/flag file exists on disk. The ONE probe shared by every reader of the
 *  local no-hold flag — the permission hook's escape-hatch gate, the `permission off|on|status` CLI
 *  toggle, and localApprovalsState just below — so the gate, the toggle and the reported header can
 *  never drift apart in what they consider "paused". Never throws: any error (absent, unreadable,
 *  malformed path) reads as absent. Lives here for the same reason NO_HOLD_PATH does — permission.ts
 *  already imports this module, so the reverse import would be a cycle. */
export async function flagExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** This computer's local remote-approvals state, as it goes on the wire.
 *
 *  CONTRACT — LITERAL, and the whole feature dies SILENTLY if it drifts: the worker
 *  (server/src/cc.ts) accepts ONLY the exact lowercase strings "on" and "off" as the `x-cc-approvals`
 *  request header and ignores anything else without complaint (an absent header from an old plugin
 *  stays "never reported", which the phone distinguishes from a reported "off"). So "true", "OFF",
 *  "On", "1", or a stray space are all indistinguishable from the feature being reverted. Return type
 *  is the literal union for exactly that reason; the plugin-side proof lives in shared.test.ts and
 *  cc-status.test.ts.
 *
 *  Cost is a non-issue on the status path: one access() stat per POST (the Codex reconcile path pays
 *  a second when a provisional sentinel exists, since that is a second POST), strictly cheaper than
 *  the readFile()s (loadConfig, readRecord, and on Codex a readdir + per-file reads) that path
 *  already performs — and the permission hook already pays exactly this stat on every prompt. */
export async function localApprovalsState(noHoldPath: string = NO_HOLD_PATH): Promise<"on" | "off"> {
  return (await flagExists(noHoldPath)) ? "off" : "on";
}

/** Basename of the pending-pairing event stash — a hook that fires WHILE pairing is still pending has
 *  no e2eKey yet, so it stashes its plaintext event here (next to config.json) instead of POSTing;
 *  completePendingPairing encrypts + flushes it the instant it derives the key, so the phone sees the
 *  session that ran the pairing without waiting for the PC's next hook. */
export const PENDING_STASH_FILE = "pending-event.json";
/** Absolute stash path for the running hook. Tests derive their own from a temp configPath's dir. */
export const PENDING_STASH_PATH = `${CC_DIR}/${PENDING_STASH_FILE}`;
/** Basename of the transient pairing PAGE `pair` writes next to config.json (0600) and opens in the
 *  browser. It embeds the same `nomo://pair` secret (inside the inline QR SVG) plus, when the worker
 *  assigned a channel, the one-time code — so it is short-lived: deleted the instant pairing completes
 *  (completePendingPairing, covering the watchdog self-heal), by unpair, and overwritten by any new
 *  pairStart. */
export const PAIR_HTML_FILE = "pair.html";
/** Absolute pairing-page path for the running CLI. Tests derive their own from a temp configPath's dir. */
export const PAIR_HTML_PATH = `${CC_DIR}/${PAIR_HTML_FILE}`;

/** This module's own directory, resolved from import.meta.url so it works regardless of the hook's
 *  cwd (both files live in the same directory). fileURLToPath+dirname is portable across bun and
 *  node (unlike Bun's import.meta.dir / node's import.meta.dirname). */
const HERE = dirname(fileURLToPath(import.meta.url));
/** Absolute path to the watchdog script. Bundled (Task 2.3) every entrypoint collapses into
 *  `dist/*.mjs`, and because shared is inlined into each bundle, `import.meta.url` here resolves to
 *  the running bundle in `dist/`, where the sibling is `cc-watchdog.mjs` — so the `.mjs` branch is a
 *  same-dir sibling lookup. Raw (`bun entries/cc-status.ts`) shared runs from `core/`, and the
 *  watchdog source lives in `entries/cc-watchdog.ts`, so the `.ts` fallback reaches across to
 *  `../entries/`. Prefer the `.mjs` when present so the spawn works from `dist/`, else fall back to
 *  the `.ts` for raw runs. The extension (and dir) is chosen at load time. */
export const WATCHDOG_PATH = existsSync(`${HERE}/cc-watchdog.mjs`)
  ? `${HERE}/cc-watchdog.mjs`
  : `${HERE}/../entries/cc-watchdog.ts`;

export type CCOp = "start" | "update" | "done" | "end";
export type CCStatus = "working" | "needsAttention" | "done";

/** Which coding agent drove this event. Omitted-from-the-blob for `claude` (the historical default,
 *  so old records/blobs read as claude); the literal `"codex"` for Codex CLI sessions. The Swift side
 *  keys its per-agent icon/label off the blob's optional `agent` field. */
export type AgentKind = "claude" | "codex";

/** Codex's config home — `$CODEX_HOME` when set & non-empty, else `~/.codex`. Mirrors codex's own
 *  `find_codex_home` (codex-rs/utils/home-dir): the env var wins, otherwise the default dot-dir. Used
 *  by status-cmd (to read config.toml plugin/trust state and probe legacy hooks.json entries). */
export function codexHome(): string {
  const env = process.env.CODEX_HOME;
  return env && env.length > 0 ? env : `${process.env.HOME}/.codex`;
}

/** The substring that identifies OUR hook command inside a codex `hooks.json` entry (the bundled
 *  hook's basename). status-cmd greps for it to flag leftover legacy (pre-native-plugin) installs. */
export const CODEX_HOOK_MARKER = "codex-status.mjs";

/** The shared Codex app-server CONTROL socket — the one `codex app-server proxy` attaches to. Its mere
 *  existence is the cheapest honest signal that a Codex app-server daemon is up on this machine (the
 *  socket is created by the daemon and disappears with it). */
export function codexAppServerSocketPath(): string {
  return `${codexHome()}/app-server-control/app-server-control.sock`;
}

/** Is a Codex app-server daemon present right now? ONE stat of the control socket — the presence probe
 *  shared by `status` (which reports it) and the watchdog (which gates the remote-input bridge on it, so
 *  a Claude-only user never gets a perpetual `codex app-server proxy` spawn loop). Cheap enough to
 *  re-run every sweep, so a daemon that appears/disappears later is picked up without a restart. Never
 *  throws: any error (absent socket, no ~/.codex, permission) reads as "not available". */
export async function codexAppServerSocketAvailable(socketPath = codexAppServerSocketPath()): Promise<boolean> {
  try {
    return (await stat(socketPath)).isSocket();
  } catch {
    return false;
  }
}

/** Per-agent hook-liveness stamp: the hook rewrites `<CC_DIR>/last-hook-<agent>` (epoch-ms text) on
 *  EVERY invocation, before the pairing gate — so a hook that silently never fires (Codex #16430/
 *  #30835) leaves NO stamp at all. status-cmd compares it against the newest session-transcript mtime
 *  to flag an agent whose hooks aren't firing despite recent activity. */
export function lastHookPath(agent: AgentKind): string {
  return `${CC_DIR}/last-hook-${agent}`;
}

/** Local-only provenance for the hook invocation that FIRST created a session record. This is
 *  deliberately absent from the encrypted blob and clear wire envelope: it exists solely to make a
 *  phantom row diagnosable from the Mac. Field names mirror the hook payload / process vocabulary so
 *  a copied record can be compared directly with hook stdin and `ps`. */
export interface SessionOrigin {
  hook_event_name: string;
  source?: string;
  agent_id?: string;
  agent_type?: string;
  cwd?: string;
  ppid: number;
  ppid_command?: string;
}

/** What the hook records per session so the watchdog can check liveness and, on death, POST a
 *  corrective v2 envelope (op:end to reap, op:done on a detected interrupt) or re-send the last blob
 *  as a staleness heartbeat. */
export interface SessionRecord {
  /** The session's `claude` process — process.ppid at hook time (see hook.ts header). */
  pid: number;
  machine: string;
  label: string;
  /** Epoch-ms the file was last written — drives the 24 h staleness cap in the watchdog. */
  ts: number;
  /** Absolute path to the session's JSONL transcript (the hook input's `transcript_path`); "" if
   *  absent. The watchdog tails it to catch an Esc-interrupt / denied-permission that fires NO hook.
   *  Optional so a file from an older hook (no field) is read safely — the interrupt net skips it. */
  transcript?: string;
  /** The semantic status kind just POSTed for this session — the gate the watchdog's interrupt net
   *  keys off (sessionStart/working/needsAttention/done). Optional for backward-compat. */
  lastEvent?: string;
  /** True once an op:done was POSTed for this session; the hook clears it on the next start/update so
   *  a re-armed turn maps to `update`, not a fresh `start`. */
  sentDone?: boolean;
  /** The v2 op just POSTed — the watchdog re-sends it verbatim in a staleness heartbeat so a
   *  genuinely-alive-but-silent session never flips state. Optional (pre-v2 records lack it). */
  op?: CCOp;
  /** The prio just POSTed — re-sent alongside `op`/`blob` in a heartbeat. */
  prio?: 0 | 1;
  /** The last encrypted blob POSTed for this session. The watchdog re-sends it verbatim as the
   *  heartbeat payload (op:end and the interrupt-corrective op:done build their own). Absent → the
   *  watchdog cannot heartbeat this session (a pre-v2 record). */
  blob?: string;
  /** Which agent drove this session. Absent → claude (backward-compat for records the pre-codex hook
   *  wrote). The watchdog reads it to pick the agent-specific interrupt marker (claude "interrupted
   *  by user" vs codex "turn_aborted") and to rebuild an interrupt-corrective done blob with the same
   *  `agent` key the hook stamped. */
  agent?: AgentKind;
  /** The session's TRUE start (epoch ms), parsed once from the transcript head and cached here so
   *  subsequent hooks and the watchdog re-send it WITHOUT re-parsing — and so it survives even if the
   *  transcript is later unavailable. Threaded into the envelope's optional `startedAt` on every POST;
   *  the worker takes the earliest credible value. Absent → unknown (pre-fix records / no transcript);
   *  the worker then keeps its first-seen fallback. */
  sessionStartedAt?: number;
  /** The CURRENT TURN's start (epoch SECONDS — the blob's unit, unlike the ms everywhere else here),
   *  stamped fresh by each UserPromptSubmit hook and cached so every later hook of the turn (and the
   *  watchdog's interrupt-corrective done) threads the SAME anchor into the encrypted blob's optional
   *  `turnStartedAt`. Rides ONLY inside the blob — never on the clear wire envelope — so the island
   *  timer measures the turn while the worker/Sessions tab keep session-start semantics. Absent →
   *  unknown (pre-0.3.5 records / no prompt seen yet); the blob then omits it and the widget falls
   *  back to `startedAt`. */
  turnStartedAt?: number;
  /** The Codex turn this record belongs to (the hook input's `turn_id`, a non-empty string). Stamped
   *  by every hook of the turn and preserved verbatim across the watchdog's record re-writes (they
   *  spread `...record`). It's the notify backstop's stale-turn guard: a delayed `notify` from turn N
   *  must NOT clobber turn N+1's record with a wrong `done`, so runNotify bails when this differs from
   *  the notify payload's turn-id. Claude payloads carry no turn_id → undefined (the guard is inert). */
  turnId?: string;
  /** The last NON-EMPTY display title POSTed for this session (the hook threads
   *  `title ?? previousRecord.title` so it never regresses to empty). The watchdog's corrective
   *  done/needsAttention envelopes rebuild their blobs from the record; without this they'd re-push
   *  title:"" and the phone would fall back to the folder-name label. Absent → no title yet. */
  title?: string;
  /** The last NON-EMPTY raw model id POSTed for this session (e.g. "claude-fable-5", "gpt-5-codex";
   *  the hook threads `model ?? previousRecord.model`, exactly like title). The watchdog's corrective
   *  done/needsAttention envelopes rebuild their blobs from the record; caching the model here keeps
   *  the phone's model badge on those frames instead of silently dropping it. Absent → unknown; the
   *  rebuilt blob then OMITS the optional `model` key (never an empty string). */
  model?: string;
  /** The pairingId whose key SEALED this record's `blob`. A re-pair rotates both the pairing and the
   *  E2E key, but session records survive it — so the watchdog's staleness heartbeat (which re-sends
   *  `blob` verbatim) must check this against the CURRENT config.pairingId and skip on mismatch;
   *  otherwise the phone gets frames it can never decrypt ("Encrypted session" forever). Absent on
   *  records from older plugins → treated as unknown, never heartbeated. */
  pairingId?: string;
  /** True for a PROVISIONAL record the watchdog wrote from process-scan discovery (an interactive TUI
   *  the hooks can't see yet — see AgentAdapter.discoverLive). Its `pid` is the discovered TUI process
   *  and its sessionId is a sentinel (`codex-pid-<pid>`). Reconciled away (op:end + delete) the moment
   *  the real hook fires for that process, or reaped like any session when the pid dies. Absent on a
   *  normal hook-written record. */
  provisional?: boolean;
  /** How many consecutive times the watchdog's interrupt net has confirmed this session interrupted and
   *  tried — and FAILED — to deliver its corrective op:done. It's the interrupt net's bounded-retry
   *  counter: a delivered done clears it (and pins lastEvent:"done"); a failed done bumps it and, while
   *  it's > 0, the staleness heartbeat holds off (shouldHeartbeat) so the interrupt net owns the
   *  session's fate and never fights the heartbeat re-raising the stale needsAttention blob. Past the
   *  retry cap the record is pinned done LOCALLY (the worker's own eviction resolves the phone since we
   *  can't deliver). Absent → the interrupt net hasn't taken ownership; a real hook re-write clears it. */
  doneAttempts?: number;
  /** True while an op:done for this session has been RECORDED but NOT confirmed delivered — the ack
   *  marker for the hook's write-before-POST ordering. trackSession persists the record BEFORE the POST
   *  is attempted (so a force-killed terminal still leaves a reapable file), so a Stop whose POST then
   *  non-2xx'd, timed out, or threw left `sentDone:true` on disk while the worker still held the
   *  previous op:"update" — the phone showed the session running forever, and EVERY self-heal net gates
   *  itself off on exactly that done state (live incident 2026-07-26: a session stuck "running" ~13 h).
   *  So the done is stamped PESSIMISTICALLY (set when the record is written, cleared only by a confirmed
   *  2xx — see markDoneDelivered), which means a thrown/timed-out fetch, or a crash mid-POST, still
   *  leaves the marker set. The watchdog's correctPendingDone net re-POSTs it.
   *
   *  DELIBERATELY SEPARATE from `sentDone`, which keeps its existing meaning ("the last POSTed event for
   *  this session was a done") because planOp's re-arm (SessionStart + sentDone → op:update) and
   *  codex-notify's double-send dedupe both key on it. Absent → nothing owed. */
  donePending?: boolean;
  /** True only when a Codex turn completion was reclassified as the client-side Plan picker. The
   *  watchdog uses this explicit provenance marker to clear needsAttention on later rollout progress
   *  without touching an ordinary permission/question attention episode. */
  pendingPlanPicker?: boolean;
  /** Epoch-ms at which either Plan-picker marker was first persisted. Unlike `ts`, this is explicitly
   *  the hard-sanity-TTL anchor and is never refreshed by a heartbeat or repeated status query. */
  planPickerPendingSince?: number;
  /** Exact Plan final wrapper was durable when Stop/notify ran, but task_complete had not flushed yet.
   *  The short-lived hook deliberately leaves the phone working and delegates the terminal decision
   *  to the watchdog. Any ordinary later hook rewrite omits this marker and therefore cancels it. */
  planPickerVerificationPending?: boolean;
  /** Terminal provenance for a picker resolved by the verification/hard-TTL bounds. Prevents the
   *  ordinary recent-done migration backstop from re-raising the same structurally-valid rollout
   *  signature. A bounded repair may still reconsider this flag when full proof + live pid survives,
   *  because v1.4.8 incorrectly stamped it while the client-side picker was still open. */
  planPickerSettled?: boolean;
  /** Latest compact state-machine decision mirrored into rebuilt encrypted frames. Local cache only;
   *  the clear worker envelope never sees it. Plain text, optional, <= 200 chars. */
  dbg?: string;
  /** The hook/process provenance that FIRST created this local record. Preserved across later hook and
   *  watchdog rewrites. Local-only diagnostic metadata — never copied into the blob or wire envelope.
   *  Optional for backward compatibility with records written before the phantom-session trace fix. */
  origin?: SessionOrigin;
}

/** The plaintext a pending-pairing flush needs to POST the pairing session the instant the shared key
 *  exists. A mid-pairing hook has NO e2eKey (the phone hasn't claimed yet), so it stashes the planned
 *  op/prio + the PLAINTEXT blob (the hook's buildBlob output); completePendingPairing encrypts the
 *  blob under the freshly-derived key and POSTs it. `op` is never "end" — an end carries no blob for a
 *  session the worker has never seen. */
export interface PendingEventStash {
  sessionId: string;
  op: CCOp;
  prio: 0 | 1;
  blob: { status: CCStatus; detail?: string; title: string; machine: string; label: string; agent?: AgentKind; turnStartedAt?: number; model?: string; at?: number; plan?: string; dbg?: string };
  /** Epoch-ms the stashing hook fired — bounds the flush to the QR's 10-min TTL (a stale stash is a
   *  ghost from a turn long since over and is dropped, not posted). */
  stashedAt: number;
  /** The stashing hook's session process (process.ppid — the `claude` process, the same notion
   *  trackSession/the watchdog use). At flush time the completer probes this pid: if it's already dead
   *  the session's terminal was closed while pairing was still pending (its later hooks no-op'd, so no
   *  watchdog was ever attached and nothing will EVER post its `end`), so the stash is dropped rather
   *  than resurrected as a ghost "done"/"working" row. Optional so a stash from a pre-0.1.5 hook (no
   *  pid) still parses — it's posted without a liveness check, as before. */
  pid?: number;
}

/** The paired, per-machine config. v2 replaces the old global `{url,key}`: auth is now a per-pairing
 *  id + secret, and `e2eKey` is the decoded 32-byte AES key (the blob is E2E-encrypted client-side). */
export interface Config {
  url: string;
  pairingId: string;
  pcSecret: string;
  e2eKey: Uint8Array;
  /** Optional friendly machine name; overrides the OS hostname in the blob when set. */
  machineName?: string;
}

/** Pure config validation, split out from the file read so it's unit-testable. Requires ALL four v2
 *  fields (url/pairingId/pcSecret/e2eKeyB64) and a key that decodes to exactly 32 bytes. An old
 *  `{url,key}` config lacks the new fields → null, which forces a clean re-pair (no silent migration). */
export function parseConfig(raw: string): Config | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (
    typeof c.url !== "string" || typeof c.pairingId !== "string" ||
    typeof c.pcSecret !== "string" || typeof c.e2eKeyB64 !== "string"
  ) {
    return null;
  }
  let e2eKey: Uint8Array;
  try {
    e2eKey = fromB64url(c.e2eKeyB64);
  } catch {
    return null;
  }
  if (e2eKey.length !== 32) return null;
  return {
    url: c.url.replace(/\/$/, ""),
    pairingId: c.pairingId,
    pcSecret: c.pcSecret,
    e2eKey,
    machineName: typeof c.machineName === "string" && c.machineName.length > 0 ? c.machineName : undefined,
  };
}

/** Read + validate ~/.config/cc-status/config.json. Null when absent, unreadable, or not a valid v2
 *  config (which leaves the hook inert — silence is the contract). */
export async function loadConfig(): Promise<Config | null> {
  try {
    return parseConfig(await readFile(`${CC_DIR}/config.json`, "utf8"));
  } catch {
    return null;
  }
}

/** A pairing that has been STARTED but not yet COMPLETED: the QR is on screen and no phone has
 *  claimed it. `qrSecret` (the raw 16-byte HKDF input) is persisted on disk (0600) only for the span
 *  of the pairing window, so the `wait` step — or the watchdog self-heal — can derive the shared E2E
 *  key once the phone claims. It is dropped the instant pairing completes (replaced by e2eKeyB64); it
 *  is no more sensitive than the e2eKeyB64 that then lives in its place. */
export interface PendingConfig {
  url: string;
  pairingId: string;
  pcSecret: string;
  qrSecret: Uint8Array;
  /** The 32-byte PBKDF2 codeIkm for the magic-code pairing path (pairing v2), persisted alongside
   *  qrSecret so `wait` / the watchdog self-heal can complete a CODE claim without recomputing the
   *  600k-iteration PBKDF2. Absent when the worker assigned no channel (QR-only) or for a config
   *  written by an older `pair` — a `path:"code"` claim then can't be completed (treated as tampered). */
  codeIkm?: Uint8Array;
  /** The PC's ephemeral P-256 private key (pkcs8 DER), generated by pairStart and persisted 0600 so
   *  `wait` / the watchdog self-heal can finish the pairing-v3 ratchet once the phone claims (it needs
   *  the phone's ephemeral public key from /pair/status to derive the durable K1). Absent for a config
   *  written by an older `pair` (pre-v3) — a claim then can't complete the ratchet (treated as tampered). */
  pcEphPriv?: Uint8Array;
  machineName?: string;
  /** Epoch-ms the pairing was STARTED (stamped by pairStart). Bounds the self-heal window: past
   *  createdAt + the 10-min QR TTL, a still-pending config is expired. Optional so a config written by
   *  an older `pair` (no field) still parses — the watchdog then falls back to a process-local deadline. */
  createdAt?: number;
}

/** Parse a PENDING config: url/pairingId/pcSecret/qrSecretB64 present AND e2eKeyB64 absent (a config
 *  carrying e2eKeyB64 is COMPLETED — parseConfig owns that, and takes precedence here). qrSecret must
 *  decode to exactly 16 bytes. Null for anything else (completed, corrupt, or pre-split config). */
export function parsePendingConfig(raw: string): PendingConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (typeof c.e2eKeyB64 === "string") return null; // already completed — not pending
  if (
    typeof c.url !== "string" || typeof c.pairingId !== "string" ||
    typeof c.pcSecret !== "string" || typeof c.qrSecretB64 !== "string"
  ) {
    return null;
  }
  let qrSecret: Uint8Array;
  try {
    qrSecret = fromB64url(c.qrSecretB64);
  } catch {
    return null;
  }
  if (qrSecret.length !== 16) return null;
  // codeIkm is optional (the magic-code path): present only when the worker assigned a channel. A
  // malformed or wrong-length value is ignored (treated as absent) — a code claim then fails the tamper
  // gate rather than crashing the parse; the QR path is unaffected.
  let codeIkm: Uint8Array | undefined;
  if (typeof c.codeIkmB64 === "string") {
    try {
      const decoded = fromB64url(c.codeIkmB64);
      if (decoded.length === 32) codeIkm = decoded;
    } catch {
      // ignore a corrupt codeIkm — the pending config is still valid for the QR path
    }
  }
  // The PC's ephemeral ratchet private key (pkcs8 DER). Optional (absent for a pre-v3 config); a
  // corrupt value is ignored (treated as absent) so the pending config still parses — completion then
  // fails the ratchet's tamper gate rather than crashing here.
  let pcEphPriv: Uint8Array | undefined;
  if (typeof c.pcEphPrivB64 === "string") {
    try {
      pcEphPriv = fromB64url(c.pcEphPrivB64);
    } catch {
      // ignore a corrupt ephemeral key — the rest of the pending config is still usable
    }
  }
  return {
    url: c.url.replace(/\/$/, ""),
    pairingId: c.pairingId,
    pcSecret: c.pcSecret,
    qrSecret,
    ...(codeIkm ? { codeIkm } : {}),
    ...(pcEphPriv ? { pcEphPriv } : {}),
    machineName: typeof c.machineName === "string" && c.machineName.length > 0 ? c.machineName : undefined,
    createdAt: typeof c.createdAt === "number" && Number.isFinite(c.createdAt) ? c.createdAt : undefined,
  };
}

/** Read + validate a pending config from ~/.config/cc-status/config.json. Null when absent, unreadable,
 *  completed, or otherwise not a valid pending config. */
export async function loadPendingConfig(configPath = `${CC_DIR}/config.json`): Promise<PendingConfig | null> {
  try {
    return parsePendingConfig(await readFile(configPath, "utf8"));
  } catch {
    return null;
  }
}

/** config.json holds pcSecret + e2eKeyB64 (or, mid-pairing, qrSecretB64) — owner-only, never
 *  group/world readable. */
const CONFIG_MODE = 0o600;

/** Decrypt the phone's deviceNameEnc blob: standard base64(iv(12B) ‖ ct ‖ tag(16B)) under the derived
 *  E2E key. The plaintext SHOULD be a JSON-encoded string, but be tolerant: if JSON.parse fails (or
 *  yields a non-string), fall back to the raw UTF-8. Doubles as the pairing's tamper gate — a wrong
 *  key (a manipulated QR/nonce) fails GCM's tag check and rejects, so a tampered claim never persists
 *  a bogus key. Kept here (not in crypto.ts) so both the pair CLI and the watchdog self-heal share it. */
export async function decryptDeviceName(key: Uint8Array, blob: string): Promise<string> {
  const bin = atob(blob);
  const combined = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) combined[i] = bin.charCodeAt(i);
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: combined.slice(0, 12) },
    cryptoKey,
    combined.slice(12),
  );
  const utf8 = new TextDecoder().decode(plain);
  try {
    const parsed = JSON.parse(utf8) as unknown;
    if (typeof parsed === "string" && parsed.length > 0) return parsed;
  } catch {
    // not JSON — treat the decrypted UTF-8 as the raw name
  }
  const raw = utf8.trim();
  return raw.length > 0 ? raw : "your phone";
}

/** The outcome of one poll-and-maybe-complete of a pending pairing:
 *  - completed         → the phone claimed; the config was rewritten to its completed form and acked.
 *  - already-completed → the worker still has the record as state:"claimed" but the phoneNonce/name
 *                        were stripped, i.e. a CONCURRENT completer (the watchdog, or a prior wait)
 *                        already acked it. We can't derive the key from this response; the caller must
 *                        re-read config.json — completed on disk → success, else genuinely unrecoverable.
 *  - pending           → no phone has claimed yet; poll again.
 *  - gone              → the worker no longer has the pending record (expired / consumed).
 *  - tampered          → a claim arrived but its response failed to decrypt (wrong key → manipulated QR).
 *  - rejected          → the worker rejected the status poll (non-404 HTTP error).
 *  - network           → the request failed / timed out (transient). */
export type PairPollResult =
  | { state: "completed"; deviceName: string }
  | { state: "already-completed" }
  | { state: "pending" }
  | { state: "gone" }
  | { state: "tampered" }
  | { state: "rejected"; httpStatus: number }
  | { state: "network" };

export interface CompletePairingOpts {
  fetchFn?: typeof fetch;
  /** Per-request ceiling so a hung socket can't stall a poll (the CLI uses 10s; the watchdog 2s). */
  fetchTimeoutMs?: number;
  ackAttempts?: number;
  ackRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Liveness probe for the stashed session's pid at flush time (kill(pid,0)-style); defaults to
   *  pidAlive. Injected so a flush test needn't spawn/kill a real process. */
  isAlive?: (pid: number) => boolean;
  /** Ensures the liveness watchdog is running after a LIVE stash flush (so a later terminal close reaps
   *  the flushed session with an `end`); defaults to the real ensureWatchdog. Injected so a flush test
   *  needn't spawn a real detached poller. */
  ensureWatchdog?: () => void;
  /** Where the flush writes the attached session record; defaults to SESSIONS_DIR. Injected so a flush
   *  test writes to a temp dir instead of ~/.config/cc-status/sessions. */
  sessionsDir?: string;
}

/** Past the QR's 10-min TTL a stashed event is a ghost — the hook that wrote it is long over — so it
 *  is dropped rather than POSTed as a stale session. Mirrors PAIRING_TTL_MS in the watchdog. */
const PENDING_STASH_STALE_MS = 600_000;

/** Flush the pending-pairing event stash, if one exists, the instant pairing completes: encrypt the
 *  stashed plaintext blob under the freshly-derived e2eKey and POST it as a real /v1/cc/event, so the
 *  phone sees the session that RAN the pairing without waiting for the PC's next hook. Best-effort,
 *  retried like the ack — a failure must never break pairing completion. No stash (pairing run outside
 *  a CC session) or a stale stash → silent no-op. One-shot: the stash is deleted regardless of POST
 *  outcome, so a leftover can never resurface as a ghost session on a later pairing. */
async function flushPendingStash(
  stashPath: string, url: string, pairingId: string, pcSecret: string, e2eKey: Uint8Array, now: number,
  fetchFn: typeof fetch, fetchTimeoutMs: number, attempts: number, retryDelayMs: number, sleep: (ms: number) => Promise<void>,
  isAlive: (pid: number) => boolean, ensureWD: () => void, sessionsDir: string,
): Promise<void> {
  let stash: PendingEventStash;
  try {
    stash = JSON.parse(await readFile(stashPath, "utf8")) as PendingEventStash;
  } catch {
    return; // no stash — the pairing ran outside a CC session (or was already flushed)
  }
  if (typeof stash.stashedAt !== "number" || now - stash.stashedAt >= PENDING_STASH_STALE_MS) {
    await unlink(stashPath).catch(() => {});
    return; // ghost from an expired turn — drop it rather than post a stale session
  }
  // Liveness gate: the stash was written by a hook of a session whose terminal may have been closed
  // WHILE pairing was still pending — that session's later hooks no-op'd, so no watchdog was ever
  // attached and nothing will ever post its `end`. If its `claude` process is already gone, posting the
  // stash would resurrect a ghost "done"/"working" row that lingers until the worker's KV TTL — so DROP
  // it silently. The kill(pid,0)-style probe works identically from BOTH completers (the `pair wait`
  // CLI and the detached watchdog self-heal). A pid-less stash (pre-0.1.5 hook) can't be checked → post
  // it as before.
  if (typeof stash.pid === "number" && !isAlive(stash.pid)) {
    await unlink(stashPath).catch(() => {});
    return;
  }
  try {
    const blob = await encryptBlob(e2eKey, stash.blob);
    const envelope = { v: 2, sessionId: stash.sessionId, op: stash.op, prio: stash.prio, ts: now, blob };
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await fetchFn(`${url}/v1/cc/event`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-cc-pairing": pairingId, "x-cc-auth": pcSecret, "x-cc-version": PLUGIN_VERSION, "x-cc-approvals": await localApprovalsState() },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(fetchTimeoutMs),
        });
        if (res.ok) break;
      } catch {
        // transient (network / timeout) — retry within the ack's budget
      }
      if (attempt < attempts - 1) await sleep(retryDelayMs);
    }
    // The flushed session IS alive (the pid probe above passed) but its stashing hook never attached a
    // watchdog (mid-pairing hooks no-op). Attach one now — write the same SessionRecord trackSession
    // would have, then ensure the poller is running — so a LATER terminal close reaps it with an `end`
    // exactly like a normal session. Only when we know the pid (a pid-less stash can't be tracked).
    // Best-effort: a bookkeeping failure just falls back to the worker's own staleness eviction.
    if (typeof stash.pid === "number") {
      try {
        const record: SessionRecord = {
          pid: stash.pid,
          machine: stash.blob.machine,
          label: stash.blob.label,
          ts: Date.now(),
          lastEvent: stash.op === "start" ? "sessionStart" : stash.blob.status,
          sentDone: stash.op === "done",
          op: stash.op,
          prio: stash.prio,
          blob,
          // Carry the agent so a LATER interrupt/heartbeat on this flushed session uses the right
          // marker. The stash's plaintext blob already holds `agent` (buildBlob stamped it), so we
          // derive it from there rather than adding a redundant top-level stash field.
          ...(stash.blob.agent === "codex" ? { agent: "codex" as const } : {}),
          // Cache the stash's title (if any) and the pairing this blob was sealed under, mirroring
          // trackSession — so a watchdog corrective keeps the title and the heartbeat's key-rotation
          // guard can prove the blob decryptable.
          ...(typeof stash.blob.title === "string" && stash.blob.title.length > 0 ? { title: stash.blob.title } : {}),
          // Cache the stash's model the same way (the stashed plaintext blob carries it, like agent/
          // title), so a watchdog corrective on this flushed session keeps the phone's model badge.
          ...(typeof stash.blob.model === "string" && stash.blob.model.length > 0 ? { model: stash.blob.model } : {}),
          ...(pairingId.length > 0 ? { pairingId } : {}),
        };
        // Owner-only (0600): like the hook's trackSession, this record carries hostname, cwd basename,
        // the session pid, and (via the reused blob) the machine/label — never group/world readable.
        await atomicWrite(`${sessionsDir}/${stash.sessionId}.json`, JSON.stringify(record), 0o600);
        ensureWD();
      } catch {
        // best-effort watchdog attach — never blocks pairing completion
      }
    }
  } finally {
    await unlink(stashPath).catch(() => {}); // one-shot — never linger as a ghost
  }
}

/** ONE status poll of a pending pairing, completing it in place if the phone has claimed: derives the
 *  bootstrap key K0 from the stored qrSecret/codeIkm + the returned phoneNonce, ratchets to the durable
 *  key K1 via ECDH (our persisted ephemeral private key + the phone's ephemeral public key from the
 *  claim), uses the K1 device-name decrypt as the tamper gate, rewrites config.json to its COMPLETED
 *  form (qrSecret/pcEphPriv dropped, e2eKeyB64 = K1 present,
 *  0600), then acks (best-effort, retried) so the worker drops the nonce. Shared by the `pair wait`
 *  CLI (which loops calling this) and the watchdog self-heal (one call per cycle). Never throws across
 *  its boundary. */
export async function completePendingPairing(
  pending: PendingConfig, configPath: string, opts: CompletePairingOpts = {},
): Promise<PairPollResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 10_000;
  const ackAttempts = opts.ackAttempts ?? 3;
  const ackRetryDelayMs = opts.ackRetryDelayMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let res: Response;
  try {
    res = await fetchFn(`${pending.url}/v1/cc/pair/status?p=${pending.pairingId}`, {
      headers: { "x-cc-auth": pending.pcSecret },
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
  } catch {
    return { state: "network" };
  }
  if (res.status === 404) return { state: "gone" };
  if (!res.ok) return { state: "rejected", httpStatus: res.status };

  const body = (await res.json()) as { state?: string; phoneNonce?: string; deviceNameEnc?: string; path?: string; phoneEphPub?: string };
  // A claimed record whose phoneNonce was stripped means it was ALREADY acked by a concurrent
  // completer (the watchdog / a prior wait) — the server keeps state:"claimed" but drops the nonce +
  // name blob after ack. We can't derive the key from it, so this is NOT "pending" (which would spin
  // to the 10-min timeout and falsely report expiry); the caller re-reads config to decide.
  if (body.state === "claimed" && typeof body.phoneNonce !== "string") {
    return { state: "already-completed" };
  }
  if (body.state !== "claimed" || typeof body.phoneNonce !== "string" || typeof body.deviceNameEnc !== "string") {
    return { state: "pending" };
  }

  // The phone claimed via the QR (`path:"qr"` or absent → the historical default) or the magic code
  // (`path:"code"`). Each has its own HKDF input: the raw qrSecret for QR, the PBKDF2 codeIkm for code.
  // A code claim with no stored codeIkm (QR-only pairing / older config) can't be completed — treat it
  // like a tampered claim rather than deriving a bogus key from the wrong material.
  const ikm = body.path === "code" ? pending.codeIkm : pending.qrSecret;
  if (!ikm) return { state: "tampered" };
  // Stage 0: K0, the bootstrap key from the code/QR secret + the phone's nonce. K0 is now EPHEMERAL —
  // it only authenticates the ratchet (mixed in as the HKDF salt); it never seals a session blob.
  const k0 = await deriveE2EKey(ikm, fromB64url(body.phoneNonce));
  // Stage 1: ratchet to the durable K1. We need our persisted ephemeral private key (pkcs8) and the
  // phone's ephemeral public key from the claim. Missing either → we can't finish the ratchet, so this
  // claim can't be completed: treat it as tampered rather than persisting a bogus key.
  if (!pending.pcEphPriv || typeof body.phoneEphPub !== "string") return { state: "tampered" };
  let e2eKey: Uint8Array;
  let deviceName: string;
  try {
    // K1 = HKDF(ikm=ECDH(dPC, QPh), salt=K0, info="nomo-cc-ratchet-v1|"+pairingId). deviceNameEnc is
    // sealed under K1 by the phone — decrypting it here is BOTH the key-confirmation and the tamper gate
    // (a relay that swapped the ephemeral public keys can't know K0, so its K1 won't open this blob).
    e2eKey = await deriveRatchetKey(pending.pcEphPriv, fromB64url(body.phoneEphPub), k0, pending.pairingId);
    deviceName = await decryptDeviceName(e2eKey, body.deviceNameEnc);
  } catch {
    return { state: "tampered" }; // wrong key / malformed phone key → tampered; do NOT persist a bogus key
  }

  // Belt-and-suspenders: lock down any pre-existing file ahead of the atomicWrite (which already
  // writes the replacement at 0600 regardless).
  try {
    await chmod(configPath, CONFIG_MODE);
  } catch {
    // no existing file (fresh pairing) — nothing to chmod
  }
  await atomicWrite(configPath, JSON.stringify({
    url: pending.url,
    pairingId: pending.pairingId,
    pcSecret: pending.pcSecret,
    e2eKeyB64: b64url(e2eKey),
    ...(pending.machineName ? { machineName: pending.machineName } : {}),
  }), CONFIG_MODE);

  // Ack so the worker drops the nonce + name blob. Best-effort (pairing is already complete either
  // way); the /cc/event route self-heals a lost ack on the PC's first post-pair hook.
  for (let attempt = 0; attempt < ackAttempts; attempt++) {
    try {
      await fetchFn(`${pending.url}/v1/cc/pair/ack`, {
        method: "POST",
        headers: { "x-cc-pairing": pending.pairingId, "x-cc-auth": pending.pcSecret, "x-cc-version": PLUGIN_VERSION },
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
      break;
    } catch {
      if (attempt < ackAttempts - 1) await sleep(ackRetryDelayMs);
    }
  }

  // Flush any hook event stashed WHILE pairing was pending (it had no key then) now that we've derived
  // one — so the phone sees the pairing session immediately, not on the PC's next hook. The stash sits
  // next to config.json; shared by both completers (the `pair wait` CLI and the watchdog self-heal),
  // so this one call covers both. Best-effort; already-complete pairing is never blocked by a failure.
  await flushPendingStash(
    join(dirname(configPath), PENDING_STASH_FILE), pending.url, pending.pairingId, pending.pcSecret, e2eKey,
    Date.now(), fetchFn, fetchTimeoutMs, ackAttempts, ackRetryDelayMs, sleep,
    opts.isAlive ?? pidAlive, opts.ensureWatchdog ?? ensureWatchdog, opts.sessionsDir ?? SESSIONS_DIR,
  );

  // Delete the transient pairing page (`pair` writes pair.html next to config.json and opens it): it
  // embeds the QR secret + the one-time code and is worthless the instant the pairing completes.
  // Best-effort, tolerates ENOENT (already gone). This one unlink covers BOTH completers — the
  // `pair wait` CLI and the watchdog self-heal both funnel through here — so no separate cleanup is
  // needed in cc-watchdog.ts.
  await unlink(join(dirname(configPath), PAIR_HTML_FILE)).catch(() => {});
  return { state: "completed", deviceName };
}

// --- Watchdog pidfile: identity + version stamp ----------------------------------------------
//
// The pidfile is BOTH the single-instance lock and the incumbent's build stamp. Two failure modes it
// has to survive:
//   1. PID RECYCLE — a pidfile that outlives a reboot (or a SIGKILLed daemon) names a pid the OS has
//      since handed to some UNRELATED process. kill(pid,0) then says "alive" forever, so nothing ever
//      spawns a watchdog again and every self-heal net is silently dead. The fix is the identity check
//      `reset` already performs before it kills anything: `ps` the pid and require the command line to
//      look like our watchdog.
//   2. UPGRADE UNDER A LIVE DAEMON — the watchdog lingers up to 30 min between sessions, so a plugin
//      update installed mid-session would keep running the OLD bundle indefinitely. The pidfile carries
//      the incumbent's PLUGIN_VERSION so ensureWatchdog can SIGTERM a mismatched build and spawn fresh.
//
// FORMAT — `"<pid> <version>"`, deliberately parseInt-COMPATIBLE: every existing reader (status-cmd,
// reset, this module, the watchdog's own claim/release) does `parseInt(raw.trim(), 10)`, which stops at
// the space and still yields the pid. So an old reader reads a new pidfile correctly, and a new reader
// treats an old (bare-pid) pidfile as "version unknown" — i.e. an older build, which is exactly right.

/** Whether a `ps` command line is our watchdog. The daemon runs as `<runtime> …/cc-watchdog.mjs` (or
 *  the raw .ts in dev), so the script name is the stable fingerprint. Shared by `reset` (which kills
 *  the pid) and the single-instance/spawn claims (which must not trust a recycled pid). */
export function isWatchdogCommand(psCommand: string): boolean {
  return psCommand.includes("cc-watchdog");
}

/** The parsed watchdog pidfile: the holder's pid plus, when the incumbent stamped one, its build. */
export interface WatchdogPidfile {
  pid: number;
  /** The incumbent's PLUGIN_VERSION. Absent for a pidfile written by a pre-stamp build → older code. */
  version?: string;
}

/** Render the pidfile contents for THIS process (see the format note above). */
export function formatWatchdogPidfile(pid: number, version: string = PLUGIN_VERSION): string {
  return `${pid} ${version}`;
}

/** Parse a pidfile's contents. Null when there's no usable pid (empty / non-numeric / ≤ 0). Pure. */
export function parseWatchdogPidfile(raw: string): WatchdogPidfile | null {
  const [pidField, versionField] = raw.trim().split(/\s+/);
  const pid = Number.parseInt(pidField ?? "", 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { pid, ...(typeof versionField === "string" && versionField.length > 0 ? { version: versionField } : {}) };
}

/** Injectable process-identity seams (so both claim paths are testable with a fake `ps`). */
export interface WatchdogIdentityDeps {
  isAlive?: (pid: number) => boolean;
  /** `ps`-style command-line lookup for a pid; undefined when the pid is gone or `ps` failed. */
  commandOf?: (pid: number) => string | undefined;
}

/** Is this pid a REAL, live watchdog? kill(pid,0) alone is not enough (see the pid-recycle note above):
 *  a live pid whose command line is NOT our watchdog is a recycled pid, so the pidfile is STALE and the
 *  caller may claim it. An unavailable `ps` (undefined — no such pid, or the tool failed) falls back to
 *  the liveness verdict: no evidence of recycling is not evidence OF recycling, and guessing "stale"
 *  there would spawn a second daemon. */
export function watchdogHolderIsLive(pid: number, deps: WatchdogIdentityDeps = {}): boolean {
  const isAlive = deps.isAlive ?? pidAlive;
  const commandOf = deps.commandOf ?? pidCommand;
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (!isAlive(pid)) return false;
  const cmd = commandOf(pid);
  if (cmd === undefined) return true; // no evidence → keep the single-instance guarantee
  return isWatchdogCommand(cmd);
}

/** Injectable seams for ensureWatchdog, so the pid-recycle and version-takeover paths are testable
 *  without spawning or signalling anything real. */
export interface EnsureWatchdogDeps extends WatchdogIdentityDeps {
  pidPath?: string;
  /** Reads the pidfile; defaults to a sync read of `pidPath`. Undefined when absent/unreadable. */
  readPidfile?: () => string | undefined;
  /** SIGTERMs a stale-VERSION incumbent so it releases the pidfile; defaults to process.kill. */
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  /** Spawns the detached daemon; defaults to the real spawn below. */
  spawnWatchdog?: () => void;
  /** THIS build's version (the stamp a live incumbent is compared against). */
  version?: string;
}

/** Ensure the detached liveness/self-heal watchdog is running the CURRENT build: if its pidfile is
 *  missing, names a dead process, names a RECYCLED pid (alive but not a watchdog — see
 *  watchdogHolderIsLive), or names a live watchdog running a DIFFERENT plugin version, spawn a fresh one
 *  and let go of it (detached + unref'd, no stdio) so the caller never waits on it. A version-mismatched
 *  incumbent is SIGTERMed first — exactly once per call, and only after the identity check proves it
 *  really is our watchdog — so it releases the pidfile through its normal shutdown path instead of being
 *  left to run stale code for the rest of its 30-min idle grace. The runtime is NOMO_RUNTIME (the run.sh
 *  shim's resolved interpreter) when set, else this process's own execPath. Shared by the hook
 *  (post-pair) and `pair` (so a mid-pairing config self-heals even if `wait` is never run). Best-effort
 *  — a spawn failure just falls back to the worker's own staleness eviction / the next hook. */
export function ensureWatchdog(deps: EnsureWatchdogDeps = {}): void {
  try {
    // Real-entry E2E tests exercise the hook in a child process. They do not need a second, detached
    // daemon to validate hook behavior, and a detached child cannot be joined by Bun's test runner.
    // Keep the opt-out explicit (never inferred from NODE_ENV) so production behavior is unchanged
    // unless a caller deliberately requests it.
    if (process.env.NOMO_SKIP_WATCHDOG === "1") return;
    const pidPath = deps.pidPath ?? WATCHDOG_PID_PATH;
    const version = deps.version ?? PLUGIN_VERSION;
    const readPidfile = deps.readPidfile ?? (() => {
      try { return readFileSync(pidPath, "utf8"); } catch { return undefined; }
    });
    const killPid = deps.killPid ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    const spawnWatchdog = deps.spawnWatchdog ?? (() => {
      const runtime = process.env.NOMO_RUNTIME && process.env.NOMO_RUNTIME.length > 0
        ? process.env.NOMO_RUNTIME
        : process.execPath;
      spawn(runtime, [WATCHDOG_PATH], { detached: true, stdio: "ignore" }).unref();
    });
    const raw = readPidfile();
    const holder = typeof raw === "string" ? parseWatchdogPidfile(raw) : null;
    if (holder && watchdogHolderIsLive(holder.pid, deps)) {
      // A live watchdog on OUR build → nothing to do. A live watchdog on any other build (including an
      // unstamped pre-upgrade one) is running stale code: retire it, then spawn the current bundle.
      if (holder.version === version) return;
      try { killPid(holder.pid, "SIGTERM"); } catch { /* raced its own exit — spawn anyway */ }
    }
    spawnWatchdog();
  } catch {
    // Couldn't start it → the Worker's staleness eviction / the next hook still applies.
  }
}

/** Read a session record file, or null if it's absent/unreadable/corrupt. */
export async function readRecord(sessionId: string, sessionsDir: string = SESSIONS_DIR): Promise<SessionRecord | null> {
  try {
    return JSON.parse(await readFile(`${sessionsDir}/${sessionId}.json`, "utf8")) as SessionRecord;
  } catch {
    return null;
  }
}

/** Read up to `maxBytes` from the START of a file (the transcript's ai-title / first prompt sit near
 *  the top). Bounded `read` so a multi-MB, ever-growing transcript costs one small read. */
export async function readPrefix(path: string, maxBytes: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** Read up to `maxBytes` from the END of a file (the interrupt marker rides the last turn line). */
export async function readSuffix(path: string, maxBytes: number): Promise<string> {
  const { size } = await stat(path);
  const start = Math.max(0, size - maxBytes);
  const len = Math.min(maxBytes, size);
  if (len === 0) return "";
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** Crash-safe write: a fully-written temp file renamed over the target, so a concurrent reader
 *  never sees a half-written pid/record (rename is atomic on the same filesystem).
 *
 *  `mode` (e.g. 0o600 for the credential-bearing config) is applied to the TEMP file at creation
 *  time and survives the rename — POSIX rename() swaps the directory entry to point at the temp
 *  file's inode, it doesn't inherit the replaced target's permissions. Confirmed for this platform
 *  by pair.test.ts's 0o600 config-file mode assertion (the pair flow writes the credential file
 *  through atomicWrite). */
export async function atomicWrite(path: string, data: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, mode !== undefined ? { mode } : undefined);
  await rename(tmp, path);
}

/** Best-effort teardown of the local pairing after the server has DEFINITIVELY revoked it (a
 *  /cc/event POST 404'd or 410'd — see requirePCAuth / dormant GC). Drops config.json, the last-send
 *  marker, AND the gone-strike counter, mirroring `unpair`, so /status stops reporting "paired" the
 *  moment the phone forgets this machine. Shared by the hook (its 2-strike gone path) and the watchdog
 *  (its revoke sweep) so the teardown stays identical. Paths are injectable so tests can point at a
 *  temp HOME; the defaults are the live locations. Tolerates already-gone files (ENOENT). */
export async function removeRevokedConfig(
  configPath = `${CC_DIR}/config.json`,
  lastSendPath = LAST_SEND_PATH,
  goneStrikesPath = GONE_STRIKES_PATH,
): Promise<void> {
  await unlink(configPath).catch(() => {});
  await unlink(lastSendPath).catch(() => {});
  await unlink(goneStrikesPath).catch(() => {});
}

// --- Shared consecutive-gone strike counter -------------------------------------------------
//
// ONE counter file (GONE_STRIKES_PATH), shared by BOTH POSTers to /v1/cc/event — the hook's tool-use
// POST path AND the watchdog's sweep. A genuinely revoked pairing 404s (or 410s) EVERY POST from
// either process, so the combined streak reaches GONE_STRIKE_LIMIT within a couple of events and the
// pairing tears down; a single transient/racing 404 from either never tears down because the next
// delivered event from either resets it. Counting hook + watchdog against one streak (rather than two
// separate counters) is deliberate: they hit the same endpoint for the same pairing, so "gone" is a
// property of the pairing, not of the process observing it — and it means the watchdog can no longer
// nuke a healthy config on one transient 404 the way its old single-strike teardown did.

/** Read the consecutive-gone strike count. Missing / unparseable / non-positive → 0, so a corrupt or
 *  absent marker simply restarts the count rather than ever tearing a pairing down early. Path is
 *  injectable so tests can point at a temp dir. */
export async function readGoneStrikes(goneStrikesPath = GONE_STRIKES_PATH): Promise<number> {
  try {
    const n = parseInt(await readFile(goneStrikesPath, "utf8"), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Clear the strike counter — any delivered event or non-gone status from EITHER POSTer breaks the
 *  consecutive-gone streak, so a later real revoke still needs its own GONE_STRIKE_LIMIT gone
 *  responses. Tolerates an already-absent file. */
export async function resetGoneStrikes(goneStrikesPath = GONE_STRIKES_PATH): Promise<void> {
  await unlink(goneStrikesPath).catch(() => {});
}

/** Record one gone (404/410) response and return the NEW consecutive-strike count; the caller tears
 *  the pairing down when the return value is >= GONE_STRIKE_LIMIT.
 *
 *  CONCURRENCY: this is a best-effort read-modify-write against the single counter file — NOT locked.
 *  Two POSTers (e.g. two parallel sessions' hooks, or a hook and the watchdog) that strike at the same
 *  instant can both read N and both write N+1, losing one increment. That is deliberately tolerated: a
 *  lost increment only DELAYS teardown by one further gone event, and the invariant that matters — a
 *  SINGLE transient 404 never tears a healthy pairing down — is unaffected (one strike is always < the
 *  limit). Two DIFFERENT transient blips can't silently accumulate either, because any delivered event
 *  between them calls resetGoneStrikes and zeroes the streak. Repeated genuine gones DO reach the limit
 *  within a few events. No file locking is used on purpose — the failure mode is bounded and benign. */
export async function recordGoneStrike(goneStrikesPath = GONE_STRIKES_PATH): Promise<number> {
  const next = (await readGoneStrikes(goneStrikesPath)) + 1;
  await atomicWrite(goneStrikesPath, String(next));
  return next;
}

/** Liveness via signal 0: no signal is delivered, it's just an existence/permission probe.
 *  EPERM means the process exists but is owned by another user (still alive); ESRCH means gone. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The ancestor pid chain of `pid` (parent, grandparent, …), walked via `ps -o ppid=` up to a bounded
 *  depth so a garbage/cyclic table can't loop. Stops at pid ≤ 1 (launchd/init). Best-effort — a failed
 *  lookup ends the walk. Used only as a robustness fallback by the provisional-reconcile pid matcher
 *  (findProvisionalForPid): the common case matches on process.ppid directly and never calls this. */
export function pidAncestors(pid: number, maxDepth = 12): number[] {
  const chain: number[] = [];
  let cur = pid;
  for (let i = 0; i < maxDepth; i++) {
    let ppid: number;
    try {
      const out = execFileSync("ps", ["-o", "ppid=", "-p", String(cur)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      ppid = Number.parseInt(out.trim(), 10);
    } catch {
      break; // ps failed / no such pid → end the walk
    }
    if (!Number.isFinite(ppid) || ppid <= 1 || chain.includes(ppid)) break;
    chain.push(ppid);
    cur = ppid;
  }
  return chain;
}

/** The full command line (argv) of `pid` via `ps -o args= -p <pid>`, or undefined on any failure. Sync
 *  (like pidAncestors) so the hook's pre-mirror headless-invocation guard can fingerprint the invoking
 *  agent process — and its ancestor chain — inline without an await. Best-effort: a missing pid / failed
 *  `ps` yields undefined, which the caller treats as "no evidence" (never a false headless verdict). */
export function pidCommand(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined; // no such pid / ps failed → unknown command line
  }
}

export interface CodexCompanionBrokerEvidence {
  pid: number;
  command: string;
  matchedBy: "app-server-broker.mjs" | "cxc-broker-socket";
}

/** Prove that a Codex app-server invocation belongs to the openai-codex companion broker. The
 *  invoking pid must itself have a `codex app-server` argv; this prevents an unrelated descendant of
 *  a broker-owned Codex host (tests, shells, user-launched tools) from inheriting the verdict. That
 *  process and its real ancestor chain are then inspected; titles and hook payload text are irrelevant.
 *  Either structural broker fingerprint is sufficient:
 *    - an argv token/path whose basename is exactly app-server-broker.mjs
 *    - the broker endpoint unix://…/<cxc-prefixed-directory>/broker.sock
 *  Missing commands or a failed ancestor walk provide no evidence and therefore fail OPEN. */
export function codexCompanionBrokerEvidence(
  pid: number,
  ancestorsOf: (pid: number) => number[] = pidAncestors,
  commandOf: (pid: number) => string | undefined = pidCommand,
): CodexCompanionBrokerEvidence | null {
  const appServer = /(?:^|[\/\s"'])codex(?:\.exe)?(?:["']?)\s+app-server(?:$|\s)/;
  const brokerScript = /(?:^|[\/\s"'=])app-server-broker\.mjs(?:$|[\s"'])/;
  const brokerSocket = /unix:\/\/[^\s"'<>]*\/cxc-[^/\s"'<>]+\/broker\.sock(?:$|[\s"'])/;
  let ownerCommand: string | undefined;
  try { ownerCommand = commandOf(pid); } catch { return null; }
  if (typeof ownerCommand !== "string" || !appServer.test(ownerCommand)) return null;
  let ancestors: number[] = [];
  try { ancestors = ancestorsOf(pid); } catch { /* unreadable ancestry → inspect only pid, then fail open */ }
  for (const candidate of [pid, ...ancestors]) {
    let command: string | undefined;
    try { command = candidate === pid ? ownerCommand : commandOf(candidate); } catch { continue; }
    if (typeof command !== "string" || command.length === 0) continue;
    if (brokerScript.test(command)) {
      return { pid: candidate, command, matchedBy: "app-server-broker.mjs" };
    }
    if (brokerSocket.test(command)) {
      return { pid: candidate, command, matchedBy: "cxc-broker-socket" };
    }
  }
  return null;
}
