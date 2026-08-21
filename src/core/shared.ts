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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { b64url, Bytes, deriveE2EKey, deriveRatchetKey, encryptBlob, fromB64url } from "./crypto";
// TYPE-ONLY (erased at build): PendingEventStash.blob IS buildBlob's return type, and duplicating it
// here is what let the two drift apart.
import type { buildBlob } from "./hook";

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

/** The `dbg` breadcrumb for a LAN decision HOLD — the same space-separated `key:value` line
 *  formatPlanPickerDebug produces, for the other state machine that can wedge a row.
 *
 *  It answers the one question a stuck approval always raises: is the card the phone is showing the
 *  Mac's hold, or the record's own frame? The hold's blob is this one and carries this line; the
 *  record's blob never does. `ev:hold` on the row is that statement, and its absence under a
 *  decisionPending row means the phone is looking at the worker's copy instead.
 *
 *  THE `hold@<at>` TAIL IS RETIRED (LAN status v2 phase 3). It carried the marker's own stamp so a
 *  reader could line it up against the frame stamp the overlay was max()-ed to — an ordering fact, from
 *  the era when `ts` was an ordering contract. Under v2 the state feed serves whole snapshots and names
 *  the deciding input on the wire (`why:"hold"`), so there is no stamp to reconcile and the tail was
 *  reporting a mechanism nobody reads any more. `ev:hold` alone keeps the only question it ever
 *  answered answered, on BOTH protocols — nothing on either side has ever parsed the tail, so an old
 *  phone loses no behaviour, only a number it could not use. Fitted into BLOB_FIT_CHARS by
 *  appendFittedPlanAndDebug like every other dbg, i.e. dropped entirely rather than crowding out the
 *  card's real content. */
export function formatDecisionHoldDebug(input: {
  requestId: string;
  pid: number;
  version?: string;
}): string {
  const value = `${debugToken(input.version ?? PLUGIN_VERSION)} ev:hold req:${debugToken(input.requestId.slice(0, 8))} pid:${input.pid}`;
  return Array.from(value).slice(0, DBG_BLOB_TEXT_MAX_CHARS).join("");
}

/** The `dbg` tail that says "this Codex session has NO app-server bridge, because the control socket is
 *  missing right now". It exists because the failure it names is otherwise completely silent: phone
 *  answering of a Codex TUI `request_user_input` works ONLY through the app-server bridge, and with no
 *  daemon socket the watchdog's presence gate never builds one — every question then degrades to an
 *  attention row the phone can look at but not answer. The phone already shows `dbg` verbatim under its
 *  diagnostics toggle, so one token there turns an invisible degradation into a readable one without any
 *  new UI.
 *
 *  ORDERING TRUTH, encoded here so nobody widens the claim: the marker describes the socket's state at
 *  the moment the frame was built. It never promises that starting the daemon will rescue THIS session —
 *  a Codex TUI that launched with no daemon hosts its conversation in-process and can never retro-attach.
 *  The recovery attempt this marker accompanies is only ever about the NEXT session. */
export const CODEX_BRIDGE_DOWN_MARKER = "cxbridge:down";

/** Bring a Codex `dbg` line into line with the CURRENT socket observation, honoring append-last
 *  discipline: the marker goes at the very END (never reordering the frozen grammar
 *  formatPlanPickerDebug produces), it is added at most once, and it is DROPPED WHOLE rather than
 *  pushing the line past DBG_BLOB_TEXT_MAX_CHARS — the outer appendFittedPlanAndDebug would otherwise
 *  slice it into a half-token. `undefined` in (a non-Codex frame) is `undefined` out: nothing is ever
 *  added to a Claude session.
 *
 *  It also REMOVES the marker when the socket is back, which is not symmetry for its own sake: several
 *  producers rebuild a frame from a `dbg` CACHED ON THE SESSION RECORD (the title repair, the
 *  provisional row), so without the strip a marker stamped during an outage would ride forward forever
 *  and keep accusing a daemon that has since recovered. */
export function appendCodexBridgeMarker(dbg: string | undefined, down: boolean): string | undefined {
  if (typeof dbg !== "string" || dbg.length === 0) return dbg;
  const bare = dbg.split(` ${CODEX_BRIDGE_DOWN_MARKER}`).join("");
  if (!down) return bare;
  const next = `${bare} ${CODEX_BRIDGE_DOWN_MARKER}`;
  return Array.from(next).length <= DBG_BLOB_TEXT_MAX_CHARS ? next : bare;
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
 *  terminal dialog). Toggled by `/nomo-cc:approvals off|on` (or `$nomo-approvals off|on` in Codex).
 *  It lives HERE (not in permission.ts, which re-exports it) because every /cc/event POSTer must
 *  report it — and permission.ts already imports this module, so the reverse import would be a
 *  cycle. */
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

// --- unabridged copies for the LAN read op (NOM-44 phase 4) -------------------------------------
//
// Everything above fits text into the WORKER's 3072-char sealed-blob ceiling: a long plan keeps a
// prefix, a long permission detail keeps a prefix plus an omitted-count. That ceiling is real and stays
// exactly as it is — every byte that crosses the worker still obeys it. But a phone on the SAME network
// can pull from this machine directly (lan-listener's `read` op), and there is no ceiling on that path,
// so the UNABRIDGED string is teed onto the session record and served on demand.
//
// POSTURE: session records are 0600 local files that never leave this Mac — the watchdog's heartbeat
// posts `record.blob` (already sealed under the pairing key) and nothing else, and the LAN frames feed
// copies only the sealed blob plus the clear envelope fields. Plaintext on the record is therefore
// exactly the posture the record already has (it holds the hostname, the cwd label, and the absolute
// transcript path in the clear today).

/** Ceiling on a full copy kept for the LAN read op. "No worker ceiling" is not "unbounded": 256 K
 *  characters is far past any real plan or shell command, and it bounds what a runaway tool_input can
 *  make this plugin write per session (and re-write on every watchdog record rewrite). */
export const RECORD_FULL_TEXT_MAX_CHARS = 262_144;
/** Appended when the cap above actually clipped the text. It is what lets a reader report
 *  `complete:false` out loud instead of silently amputating — the same honest-truncation contract
 *  `fitPermissionDetail`'s omitted-count and `appendFittedPlan`'s "\n…" marker carry on the wire. */
export const RECORD_FULL_TEXT_TRUNCATION_MARKER = "\n…[truncated]";

/** The value to persist on the session record for a blob field that was fitted, or undefined when
 *  there is nothing worth keeping.
 *
 *  Undefined — meaning "the phone falls back to the copy already in the blob" — in exactly two cases:
 *  there was no text at all, or the fit changed NOTHING (`full === fitted`), in which case a second copy
 *  on disk would only be a bigger record saying the same thing. Otherwise the whole string, clipped at
 *  RECORD_FULL_TEXT_MAX_CHARS code points (never mid-code-point) with the marker appended.
 *
 *  `fitted` is undefined when the fit dropped the field ENTIRELY (a plan that could not fit at all) —
 *  that is a change, so the full text is stored. Pure; never throws. */
export function fullTextForRecord(full: string | undefined, fitted: string | undefined): string | undefined {
  if (typeof full !== "string" || full.length === 0) return undefined;
  if (full === fitted) return undefined;
  const chars = Array.from(full);
  if (chars.length <= RECORD_FULL_TEXT_MAX_CHARS) return full;
  const markerChars = Array.from(RECORD_FULL_TEXT_TRUNCATION_MARKER).length;
  return chars.slice(0, RECORD_FULL_TEXT_MAX_CHARS - markerChars).join("") + RECORD_FULL_TEXT_TRUNCATION_MARKER;
}

/** Did a stored full copy survive the cap whole? The marker is the signal (a suffix test, not a length
 *  test: the stored string is the only thing the reader has). A genuine text that happens to END with
 *  the exact marker would be reported one notch more conservatively than it deserves — cosmetic, and
 *  the alternative (a second record field) would spend an append-last slot on it. Pure. */
export function recordFullTextIsComplete(value: string): boolean {
  return !value.endsWith(RECORD_FULL_TEXT_TRUNCATION_MARKER);
}

/** What a full-text upload is a copy OF. Rides in the clear body (so the blind worker can key the
 *  record) AND inside the sealed plaintext (so the phone can check them against what it asked for). */
export type FullTextKind = "plan" | "permission-detail";

/** The event/decision POSTs' 2 s idiom, widened for a payload that is up to ~350 KB of base64 rather
 *  than a ~3 KB frame. It never delays anything the user is waiting on: the upload rides in PARALLEL
 *  with the card's own POST (see the two call sites) and a miss is soft. */
export const FULL_TEXT_POST_TIMEOUT_MS = 5000;

/** Ship a text that had to be CUT to fit the sealed frame to the (blind) worker, so a phone that is NOT
 *  on this network can still pull the whole thing — the LAN `read` op's remote twin. The inline preview
 *  on the card is untouched and stays the degraded mode when this never lands.
 *
 *  GATED ON `fullTextForRecord`: `content === undefined` means nothing was cut, so there is nothing to
 *  pull and no POST happens at all — no upload, no KV write — for the overwhelmingly common prompt.
 *
 *  `sessionId` and `what` ride INSIDE the sealed plaintext as well as in the clear body, and that is not
 *  redundancy: the relay is blind and can read neither copy, so anything that answered one session's
 *  pull with another session's body would hand the phone a plaintext whose own labels disagree with what
 *  it asked for. Dropping them would make substitution undetectable.
 *
 *  `requestId` rides there for that reason AND ONE MORE, which is why a permission detail must carry it.
 *  The worker's slot is `<pid>:full:<sid>:<what>` and lives 24 h, so a SUCCESSOR hold in the SAME session
 *  is a DIFFERENT text under the SAME key — and this POST never retries, so hold #2's upload can 429, time
 *  out, or simply still be in flight when the phone pulls. Session and `what` both agree in that case, so
 *  they cannot tell hold #1's parked text apart from hold #2's: without the id the phone would render one
 *  prompt's command above an Allow button sealed to another's, on a consent surface. It goes only inside
 *  the seal — the worker keys nothing by it and must stay blind. A plan passes none (no hold, no decision
 *  bar) and `undefined` drops the key, so a plan's plaintext is byte-for-byte what it always was.
 *
 *  NEVER THROWS, never retries (the phone falls back to the LAN read, then to the truncated preview).
 *  Callers START it before the event/decision POST and AWAIT it after, so it adds no latency to the card
 *  yet still finishes before a short-lived hook process exits. */
export async function postFullText(
  config: Config, sessionId: string, what: FullTextKind, content: string | undefined,
  fetchFn: typeof fetch = fetch, trace?: (event: object) => void, requestId?: string,
): Promise<void> {
  if (content === undefined) return;
  try {
    const blob = await encryptBlob(config.e2eKey, {
      sessionId, what, requestId, content, complete: recordFullTextIsComplete(content),
    });
    const res = await fetchFn(`${config.url}/v1/cc/full`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret, "x-cc-version": PLUGIN_VERSION,
      },
      body: JSON.stringify({ v: 2, sessionId, what, blob }),
      signal: AbortSignal.timeout(FULL_TEXT_POST_TIMEOUT_MS),
    });
    trace?.({ event: "full-text", what, chars: content.length, status: res.status });
  } catch (e) {
    trace?.({ event: "full-text", what, chars: content.length, status: 0, error: (e as { name?: string })?.name ?? "Error" });
  }
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
 *  so old records/blobs read as claude); the literal `"codex"` for Codex CLI sessions and
 *  `"opencode"` for OpenCode ones. The Swift side keys its per-agent icon/label off the blob's
 *  optional `agent` field — and maps an UNKNOWN value to claude ON PURPOSE, so the OpenCode plugin can
 *  ship before the app release without crashing or losing rows.
 *
 *  A third kind is NOT free: the dominant coercion idiom in this repo is
 *  `record.agent === "codex" ? "codex" : "claude"`, which silently reads opencode as CLAUDE. The ones
 *  that matter are the blob/record agent literals and anything that would join an OpenCode session
 *  against a Claude transcript or CC file. */
export type AgentKind = "claude" | "codex" | "opencode";

/** An agent literal AS IT ARRIVES — off a session record, out of a blob a peer install wrote. It is
 *  `AgentKind` plus "some string this build has never heard of", because that case is now REAL: two
 *  nomo installs at different versions coexist on one machine (Claude Code and OpenCode ship separate
 *  dists), so the OLDER build routinely reads records stamped by the NEWER one.
 *
 *  Nothing may COERCE such a value. Observed live: a 2.0.2 watchdog rebuilt a `done` envelope for an
 *  `agent:"opencode"` record, `adapterFor` fell through to claude, claude's `blobAgentFields` is `{}`,
 *  and the agent key vanished from the rebuilt blob — the Dynamic Island flipped from OpenCode to
 *  Claude Code. The wire value must survive a build that does not understand it; see adapterFor's
 *  passthrough adapter. This mirrors iOS, where `CCAgent.from(blobValue:)` maps unknown → .claude for
 *  RENDERING only and never rewrites what it was sent. */
export type AgentKindWire = AgentKind | (string & {});

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

/** The shared Codex app-server CONTROL socket — the one `codex app-server proxy` attaches to. The
 *  daemon creates it on startup.
 *
 *  IT DOES NOT RELIABLY DISAPPEAR WITH THE DAEMON. This comment used to claim it did, and the
 *  presence probe below was a single `stat` built on that claim. Field evidence (2026-08-09): the
 *  daemon's recorded pid was long dead, no process held the socket, `connect()` returned
 *  ECONNREFUSED — and the socket FILE was still sitting there. A daemon killed abruptly (crash,
 *  SIGKILL, reboot with a surviving filesystem) leaves the inode behind, so existence proves only
 *  that a daemon once ran. Only a connect proves one is listening now. */
export function codexAppServerSocketPath(): string {
  return `${codexHome()}/app-server-control/app-server-control.sock`;
}

/** Ceiling on the presence probe's connect. A unix-domain connect to a listening peer is a
 *  kernel-local handshake (microseconds); anything slower is a wedged or backlogged daemon, and for
 *  the purposes of "can the bridge attach right now" that reads the same as absent. Short enough to sit
 *  on the watchdog's five-second sweep and on `status`'s output path without being felt. */
export const CODEX_SOCKET_PROBE_TIMEOUT_MS = 200;

/** What the control socket actually IS right now. `stale` is the case that cost a day: the socket file
 *  exists (so every `stat`-based check said "daemon up") but nothing is listening on it. */
export type CodexAppServerSocketState = "live" | "stale" | "absent";

/** Bounded, never-throwing "is someone listening on this unix socket". Resolves false on any error
 *  (ENOENT, ECONNREFUSED, EACCES, EPERM, a non-socket inode) and on the timeout. The socket is closed
 *  immediately either way — we send nothing and read nothing, so a live app-server sees an ordinary
 *  client that hung up before speaking. */
async function unixSocketAccepts(socketPath: string, timeoutMs: number): Promise<boolean> {
  // node:net is imported lazily: this module is inlined into the per-event hook bundles, whose startup
  // cost is paid on every agent event, and only the watchdog/status probe ever needs a socket.
  let createConnection: typeof import("node:net").createConnection;
  try {
    ({ createConnection } = await import("node:net"));
  } catch {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let socket: import("node:net").Socket | undefined;
    const timer = setTimeout(() => done(false), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    function done(accepted: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(accepted);
    }
    try {
      socket = createConnection({ path: socketPath });
    } catch {
      done(false); // an unusable path never even reaches the kernel
      return;
    }
    socket.unref?.(); // a probe must never hold a process open
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
  });
}

/** Is a Codex app-server daemon present right now? A bounded CONNECT to the control socket — the
 *  presence probe shared by `status` (which reports it) and the watchdog (which gates the remote-input
 *  bridge on it, so a Claude-only user never gets a perpetual `codex app-server proxy` spawn loop).
 *  Cheap enough to re-run every sweep, so a daemon that appears/disappears later is picked up without a
 *  restart. Never throws: any error (absent socket, no ~/.codex, permission, refused) reads as "not
 *  available".
 *
 *  WHY NOT A STAT (the 2026-08-09 outage): a dead daemon can leave its socket file behind, and a `stat`
 *  probe read that corpse as a healthy daemon. Everything downstream then behaved as if the bridge could
 *  work — the bridge was built, `codex app-server proxy` died instantly 240 times over five hours, the
 *  `cxbridge:down` breadcrumb never stamped, and the daemon-restart recovery never armed, because all
 *  three of those hang off exactly this boolean. A connect is the only answer that cannot be a corpse. */
export async function codexAppServerSocketAvailable(socketPath = codexAppServerSocketPath()): Promise<boolean> {
  return await unixSocketAccepts(socketPath, CODEX_SOCKET_PROBE_TIMEOUT_MS);
}

/** The probe's answer WITH its reason, for the one trace line an outage gets. Only called when
 *  something has already gone wrong (a down-transition), never per sweep, because it costs a second
 *  syscall pass to tell `stale` from `absent` — and that distinction is the whole diagnosis: `stale`
 *  means "a daemon died and left its socket", `absent` means "no daemon has run here". */
export async function codexAppServerSocketState(
  socketPath = codexAppServerSocketPath(),
): Promise<CodexAppServerSocketState> {
  if (await codexAppServerSocketAvailable(socketPath)) return "live";
  try {
    return (await stat(socketPath)).isSocket() ? "stale" : "absent";
  } catch {
    return "absent"; // nothing at the path at all
  }
}

/** The EXACT subcommand that brings the shared Codex app-server daemon up, verified against the local
 *  binary's help (codex-cli 0.146.0): `codex app-server daemon start` — "Start the local app server
 *  daemon if it is not already running", i.e. it is idempotent by contract. NOTE it is `daemon start`
 *  and NOT `codex app-server proxy`: proxy only ATTACHES to an existing control socket and fails with a
 *  connect error when none is there, which is precisely how the daemon's death stayed invisible. */
export const CODEX_DAEMON_START_ARGS = ["app-server", "daemon", "start"] as const;
/** Ceiling on the start CHILD itself. `daemon start` forks the server and returns; anything slower than
 *  this is a wedged binary and waiting longer only delays the trace. */
const CODEX_DAEMON_START_TIMEOUT_MS = 8_000;
/** After a clean exit, how long we keep re-probing the socket before calling the attempt a failure.
 *  The daemon binds its control socket a beat after the parent returns. */
const CODEX_DAEMON_SOCKET_WAIT_MS = 4_000;
const CODEX_DAEMON_SOCKET_POLL_MS = 250;

export interface CodexDaemonStartDeps {
  /** Spawns the start child. Defaults to the real `codex` binary with stdin CLOSED (see below). */
  spawnFn?: (command: string, args: readonly string[]) => {
    on(event: "error", listener: (error: unknown) => void): unknown;
    on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
    // Mirrors node's ChildProcess.kill EXACTLY. Declared `signal?: string` it no longer described the
    // real default (child_process.spawn), so the union of dep-or-default failed to type at all.
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  probe?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  trace?: (event: object) => void;
  codexPath?: string;
  timeoutMs?: number;
  socketWaitMs?: number;
}

/** Best-effort recovery for a MISSING Codex app-server daemon: run `codex app-server daemon start` once
 *  and wait, bounded, for the control socket to appear. Resolves true only when the socket is really
 *  there afterwards.
 *
 *  RULES, all of them load-bearing:
 *   - NON-INTERACTIVE. stdio is `ignore` — stdin is /dev/null, so the child can never prompt, and it
 *     inherits none of our streams (the watchdog owes its stdout absolute silence).
 *   - NEVER THROWS. A missing binary (ENOENT), a non-zero exit, a hang, or a socket that never appears
 *     all resolve false and are TRACED. The caller degrades; it never fails.
 *   - IT DOES NOT RESCUE THE SESSION THAT NOTICED. A Codex TUI started while no daemon existed hosts its
 *     conversation in-process and never retro-attaches, so no amount of starting the daemon makes THAT
 *     TUI answerable from the phone. This buys the NEXT session, and any wording built on top of it must
 *     not promise more (see CODEX_BRIDGE_DOWN_MARKER). */
export async function startCodexAppServerDaemon(deps: CodexDaemonStartDeps = {}): Promise<boolean> {
  const trace = deps.trace ?? ((event: object) => traceSession(event));
  const probe = deps.probe ?? (() => codexAppServerSocketAvailable());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const command = deps.codexPath ?? "codex";
  const timeoutMs = deps.timeoutMs ?? CODEX_DAEMON_START_TIMEOUT_MS;
  const socketWaitMs = deps.socketWaitMs ?? CODEX_DAEMON_SOCKET_WAIT_MS;
  const spawnFn = deps.spawnFn
    ?? ((cmd: string, args: readonly string[]) => spawn(cmd, [...args], { stdio: "ignore" }));

  let exit: { code: number | null; signal: string | null } | "error" | "timeout";
  try {
    exit = await new Promise<typeof exit>((resolve) => {
      let settled = false;
      const done = (value: typeof exit): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let child: ReturnType<NonNullable<CodexDaemonStartDeps["spawnFn"]>>;
      try {
        child = spawnFn(command, CODEX_DAEMON_START_ARGS);
      } catch {
        done("error"); // codex not installed / not executable
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        done("timeout");
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      child.on("error", () => { clearTimeout(timer); done("error"); });
      child.on("exit", (code, signal) => { clearTimeout(timer); done({ code, signal }); });
    });
  } catch {
    exit = "error";
  }

  if (exit === "error" || exit === "timeout" || exit.code !== 0) {
    trace({
      event: "codex-daemon-start", outcome: exit === "error" ? "spawn-failed" : exit === "timeout" ? "timeout" : "nonzero-exit",
      ...(typeof exit === "object" ? { code: exit.code, signal: exit.signal } : {}),
    });
    return false;
  }

  // Exit 0 is not proof: `daemon start` returns before the socket is necessarily bound (and would also
  // exit 0 if it decided the daemon was already up while the socket is being replaced — including when
  // what it "decided" from was a stale socket file). A socket that ACCEPTS is the contract, so re-probe
  // until it does or the bounded wait expires.
  const deadline = socketWaitMs;
  for (let waited = 0; ; waited += CODEX_DAEMON_SOCKET_POLL_MS) {
    let up = false;
    try { up = await probe(); } catch { up = false; }
    if (up) {
      trace({ event: "codex-daemon-start", outcome: "started", waitedMs: waited });
      return true;
    }
    if (waited >= deadline) break;
    await sleep(CODEX_DAEMON_SOCKET_POLL_MS);
  }
  trace({ event: "codex-daemon-start", outcome: "no-socket", waitedMs: deadline });
  return false;
}

/** Per-agent hook-liveness stamp: the hook rewrites `<CC_DIR>/last-hook-<agent>` (epoch-ms text) on
 *  EVERY invocation, before the pairing gate — so a hook that silently never fires (Codex #16430/
 *  #30835) leaves NO stamp at all. status-cmd compares it against the newest session-transcript mtime
 *  to flag an agent whose hooks aren't firing despite recent activity. */
export function lastHookPath(agent: AgentKind): string {
  return `${CC_DIR}/last-hook-${agent}`;
}

// --- project-folder identity (the phone's session grouping) -------------------------------------

/** How many hex characters of the cwd digest ride in the blob. 12 hex = 48 bits: collision-free for
 *  the handful of project folders one machine ever has (birthday-bound ~16M folders for a 1-in-a-
 *  million collision), and short enough to be free against the worker's 3072-char sealed ceiling. */
export const FOLDER_KEY_HEX_CHARS = 12;

/** A session's project folder, as the phone sees it: the DISPLAY name, the optional grouping key, and
 *  the LOCAL-ONLY path facts the live branch is read from. All of them ALWAYS describe the same cwd —
 *  see `folderIdentity`, which is the only thing that makes them, precisely so no caller can pair one
 *  folder's name with another folder's key (or another folder's branch). */
export interface FolderIdentity {
  /** `basename(cwd)` — what the phone renders as the folder title. */
  label: string;
  /** The GROUPING identity (see `folderKeyFromCwd`). Absent when the cwd was unknown, and absent on a
   *  session pinned by a plugin old enough to predate the key (the phone then groups by `label`). */
  folderKey?: string;
  /** The session's pinned ABSOLUTE cwd. LOCAL ONLY — it is kept so `sessionBranch` has something to
   *  resolve a git dir from, and it must NEVER enter a blob (the rule adapter.ts states on
   *  `DiscoveredSession.cwd`; `folderKey` exists precisely so the wire carries a digest instead).
   *  Absent when the cwd was unknown, and absent on a session pinned before this field existed. */
  cwd?: string;
  /** The git directory `cwd` resolved to (see `resolveGitDir`), cached so a later event is one small
   *  HEAD read instead of a fresh upward walk. Local only, like `cwd`. Absent when `cwd` is not inside
   *  a repo — or when it is, but the record predates the cache. */
  gitDir?: string;
}

// --- the session folder's LIVE git branch -------------------------------------------------------

/** Cap on the emitted `branch` string. Ref names are almost never near this, but they are
 *  user-controlled and effectively unbounded, and the blob has to fit the worker's ~3072-char sealed
 *  ceiling with the plan/dbg tail still to come (see appendFittedPlanAndDebug). 60 chars shows every
 *  realistic branch whole and makes a pathological one harmless rather than a frame-eating cost. */
export const BRANCH_MAX_CHARS = 60;

/** How many parent directories the `.git` search visits before giving up. A session started deep in a
 *  monorepo is ordinary; an unbounded loop on a pathological path (or a symlink cycle presented as a
 *  very deep tree) inside a hook that BLOCKS the agent is not. The walk also stops at the filesystem
 *  root, which is what ends it in practice. */
const GIT_DIR_WALK_MAX_DEPTH = 64;

/** The `gitdir: <path>` target of a `.git` FILE, resolved to an absolute path.
 *
 *  A `.git` file (rather than a directory) is how git represents a WORKTREE and a SUBMODULE, and its
 *  pointer may be either absolute (`gitdir: /abs/repo/.git/worktrees/x`, what `git worktree add`
 *  writes) or RELATIVE (`gitdir: ../.git/modules/x`, what `git submodule` commonly writes, and what a
 *  moved checkout ends up with). A relative target resolves against the directory CONTAINING the `.git`
 *  file, not against the process cwd — the hook's own cwd is unrelated to the session's. */
function gitDirPointer(content: string, containingDir: string): string | undefined {
  const match = /^[ \t]*gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(content);
  const target = match?.[1];
  if (typeof target !== "string" || target.length === 0) return undefined;
  return isAbsolute(target) ? target : resolve(containingDir, target);
}

/** The git directory governing `cwd`, or undefined when `cwd` is not inside a repository.
 *
 *  THE UPWARD WALK IS THE POINT. A session is very often started in a SUBDIRECTORY of its repo (a
 *  `server/` or `app/` inside the checkout), where there is no `.git` at all — the repo's is several
 *  levels up. Checking only `cwd` would silently report "no branch" for a large share of real sessions.
 *
 *  FILE READS ONLY, NEVER A SUBPROCESS: this runs on EVERY hook event, and a hook blocks the agent.
 *  `git rev-parse` would cost a process spawn per event for something two `statSync`/`readFileSync`
 *  calls answer.
 *
 *  A `.git` that is a FILE ends the walk whether or not its pointer parses: that file IS the repository
 *  boundary (a worktree/submodule), so falling through to an ancestor would report the SUPERPROJECT's
 *  branch for a submodule — a confident wrong answer, which is worse than none. */
export function resolveGitDir(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  let dir = cwd;
  for (let depth = 0; depth < GIT_DIR_WALK_MAX_DEPTH; depth++) {
    const candidate = join(dir, ".git");
    try {
      const st = statSync(candidate);
      if (st.isDirectory()) return candidate;
      if (st.isFile()) return gitDirPointer(readFileSync(candidate, "utf8"), dir);
    } catch {
      // No `.git` here (or it is unreadable) — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined; // filesystem root reached
    dir = parent;
  }
  return undefined;
}

/** The branch (or short SHA) `gitDir/HEAD` currently names, capped at `BRANCH_MAX_CHARS`.
 *
 *  HEAD holds either `ref: refs/heads/<name>` on a branch — and a branch name may itself contain `/`
 *  (`feat/hybrid-lan`), so everything after `refs/heads/` is the name, never just the last segment — or
 *  a bare object id when the checkout is DETACHED, which is reported as its 7-char short form (what
 *  `git status` shows). A HEAD pointing at any other ref, an empty/short/malformed file, or a missing
 *  one yields UNDEFINED: the key is then omitted entirely rather than guessed or emitted empty. */
export function branchFromHead(gitDir: unknown): string | undefined {
  if (typeof gitDir !== "string" || gitDir.length === 0) return undefined;
  let head: string;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8");
  } catch {
    return undefined; // not a git dir, or unreadable — omit
  }
  const first = (head.split("\n", 1)[0] ?? "").trim();
  if (first.length === 0) return undefined;
  const ref = /^ref:[ \t]*refs\/heads\/(.+)$/.exec(first);
  if (ref) {
    const name = ref[1].trim();
    return name.length > 0 ? name.slice(0, BRANCH_MAX_CHARS) : undefined;
  }
  // Detached HEAD: a bare object id (40 hex for sha1 repos, 64 for the sha256 object format).
  if (/^[0-9a-f]{40}$/.test(first) || /^[0-9a-f]{64}$/.test(first)) return first.slice(0, 7);
  return undefined;
}

/** The LIVE branch of a session's pinned folder — the single producer every blob builder calls.
 *
 *  LIVE, NOT PINNED, and deliberately so: unlike `label`/`folderKey` (which pin the session to its
 *  first-seen folder so a `cd` cannot move the row), the branch is current state — a `git checkout`
 *  mid-session must show up on the phone. Only the PATHS are pinned; HEAD is re-read on every call.
 *
 *  The cached `gitDir` makes that re-read one small file read instead of a fresh upward walk. When the
 *  cache stops resolving — the worktree was pruned, the repo moved, `.git` was re-created by a fresh
 *  `git init`, or the record was pinned before the cache existed — it falls back to walking from `cwd`
 *  again, so a stale cache degrades to the slow path rather than to a permanently branch-less row.
 *
 *  Undefined (⇒ the key is omitted) whenever the folder is not a repo, the paths are unknown, or HEAD
 *  cannot be understood. A record carrying a `label` but no `cwd` — one pinned by a plugin predating
 *  the pin — gets no branch at all, and must NEVER fall back to the live event's cwd: that describes
 *  whatever directory the shell has since wandered into, not the folder the pinned label/key name. */
export function sessionBranch(folder: { cwd?: unknown; gitDir?: unknown } | null | undefined): string | undefined {
  if (!folder) return undefined;
  const cached = typeof folder.gitDir === "string" && folder.gitDir.length > 0 ? folder.gitDir : undefined;
  if (cached) {
    const branch = branchFromHead(cached);
    if (branch) return branch;
  }
  const fresh = resolveGitDir(folder.cwd);
  if (!fresh || fresh === cached) return undefined; // no repo, or the same dead cache re-derived
  return branchFromHead(fresh);
}

/** The grouping identity of a project folder: the first `FOLDER_KEY_HEX_CHARS` hex chars of SHA-256
 *  over the ABSOLUTE cwd.
 *
 *  WHY A HASH AND NOT THE PATH. `label` (the cwd BASENAME) is not unique — two checkouts named `api`
 *  under different parents merged into one card on the phone. The full path would disambiguate them,
 *  but the exact cwd is deliberately local-only (see adapter.ts's `DiscoveredSession.cwd`: "Never
 *  enters a blob"), and that rule stands. A truncated digest reveals strictly no more than the
 *  basename already does while still being collision-free identity.
 *
 *  WHY THE CWD AND NOT THE GIT TOPLEVEL. Both agents key a project on its absolute cwd — Claude Code
 *  slugifies it into its `~/.claude/projects/<slug>` directory, Codex records it as
 *  `session_meta.payload.cwd` — and Claude Code treats a git WORKTREE as its own project. Keying on
 *  the git root would merge a worktree back into its parent repo, which is the opposite of what both
 *  agents (and the user) mean by "project".
 *
 *  Undefined for an unknown/empty cwd: there is nothing to identify, and the phone falls back to
 *  grouping by `label` exactly as it did before the key existed. */
export function folderKeyFromCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  return createHash("sha256").update(cwd, "utf8").digest("hex").slice(0, FOLDER_KEY_HEX_CHARS);
}

/** BOTH halves of a session's folder identity, from ONE source — the single place either is derived.
 *
 *  PINNING, exactly as `label` has always been pinned (hook.ts): a mid-session `cd` changes `input.cwd`
 *  on every later hook, and re-deriving per event silently renamed the phone row ("api-status" →
 *  "server" after a `cd server`). So once a session's record carries a label, `pinned` wins and the
 *  event's cwd is ignored — for the KEY too, or a `cd` would move a live session between folder cards
 *  on the phone.
 *
 *  The two can never drift apart because they are only ever produced together: either both come from
 *  the pin, or both are derived from the same `cwd`. A record pinned by an older plugin has a label and
 *  no key; it keeps having no key for the rest of that session rather than picking up one derived from
 *  wherever the shell has since wandered. The phone documents that mixed state (it groups such rows by
 *  label) and it self-resolves when the session ends.
 *
 *  `cwd`/`gitDir` (v1.9.0) travel in the SAME parcel for the SAME reason. They are LOCAL ONLY — never
 *  in a blob — and exist so `sessionBranch` can re-read the folder's live HEAD. Same rule, same trap: a
 *  record pinned by a plugin predating them has a label and NO cwd, and it gets none here. Deriving one
 *  from the event's cwd would describe a directory the pinned label/key may not even name (the shell
 *  `cd`'d), so such a session simply shows no branch until it ends. */
export function folderIdentity(
  cwd: unknown, pinned?: string | { label?: unknown; folderKey?: unknown; cwd?: unknown; gitDir?: unknown } | null,
): FolderIdentity {
  const pin = typeof pinned === "string" ? { label: pinned, folderKey: undefined, cwd: undefined, gitDir: undefined } : pinned;
  if (typeof pin?.label === "string" && pin.label.length > 0) {
    return {
      label: pin.label,
      ...(typeof pin.folderKey === "string" && pin.folderKey.length > 0 ? { folderKey: pin.folderKey } : {}),
      ...(typeof pin.cwd === "string" && pin.cwd.length > 0 ? { cwd: pin.cwd } : {}),
      ...(typeof pin.gitDir === "string" && pin.gitDir.length > 0 ? { gitDir: pin.gitDir } : {}),
    };
  }
  const key = folderKeyFromCwd(cwd);
  // FIRST event: everything comes off the one cwd being pinned right now, including the git dir the
  // branch will be re-read from for the rest of the session.
  const gitDir = typeof cwd === "string" && cwd.length > 0 ? resolveGitDir(cwd) : undefined;
  return {
    label: typeof cwd === "string" && cwd.length > 0 ? basename(cwd) : "session",
    ...(key ? { folderKey: key } : {}),
    ...(typeof cwd === "string" && cwd.length > 0 ? { cwd } : {}),
    ...(gitDir ? { gitDir } : {}),
  };
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
  /** The PINNED grouping key for `label`'s folder (see `folderIdentity`). Written together with
   *  `label` on the record's FIRST event and reused verbatim by every later blob this session
   *  produces — the hook's, the watchdog's correctives, the LAN state blob — so a mid-session `cd`
   *  cannot move the row to another folder card. Optional: a record written by a plugin predating the
   *  key has none, and a session whose cwd was unknown never had one. */
  folderKey?: string;
  /** The session's PINNED ABSOLUTE cwd — LOCAL ONLY. It NEVER enters a blob (that is exactly why
   *  `folderKey` is a digest; see adapter.ts's `DiscoveredSession.cwd`), and this file is 0600 like the
   *  rest of the record. It exists so every producer that rebuilds a blob from the record — the
   *  watchdog's correctives, the LAN state frame — can re-read the folder's LIVE git branch without a
   *  cwd of its own. Pinned with `label`/`folderKey` on the first event (see `folderIdentity`), so it
   *  always names the folder those two describe. Optional: absent on a record written by a plugin
   *  predating it, and absent when the cwd was unknown — such a session emits no `branch`. */
  cwd?: string;
  /** The git directory `cwd` resolved to, cached at pin time (see `resolveGitDir`) so each later event
   *  is ONE small HEAD read rather than a fresh upward walk. Local only. Absent when the folder is not
   *  a repo; a cache that stops resolving makes `sessionBranch` re-walk instead of going blank. */
  gitDir?: string;
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
   *  `agent` key the hook stamped. Typed WIRE-wide (see AgentKindWire): a record on this disk may have
   *  been written by a NEWER peer install that knows agent kinds this build does not. */
  agent?: AgentKindWire;
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
  /** Real-terminal Codex client confidently correlated to this daemon-fronted session. Unlike `pid`
   *  (the immortal standalone app-server), death of this optional PID is a precise TUI-exit signal.
   *  Written only from unique exact-cwd + tight process/session-start evidence; ambiguity omits it. */
  tuiPid?: number;
  /** Provisional-only exact cwd of the discovered real-TTY client. Local correlation evidence only. */
  tuiCwd?: string;
  /** Provisional-only real-TTY process birth time (epoch ms). Local correlation evidence only. */
  tuiStartedAt?: number;
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
  /** APPENDED LAST (NOM-44 phase 3). The clear `attentionKind` discriminator just POSTed for this
   *  session — today only Codex's `request_user_input` ("the model is asking YOU something", as opposed
   *  to a plain permission approval). It already rides the WORKER envelope (see hook.ts buildEnvelope /
   *  cc-watchdog's needsAttention corrective), but it was never persisted, so the LAN frames feed — which
   *  is rebuilt from these records, not from the POSTs — would have dropped the marker and shown a Codex
   *  question as an ordinary approval on the phone.
   *
   *  APPEND-LAST DISCIPLINE (mirrors how `model`/`pairingId` were added): a new optional field goes at
   *  the END of this interface AND at the END of trackSessionAt's record literal, never interleaved, so
   *  existing keys keep their order and the diff shows exactly one added line on each side. Parsing is
   *  tolerant by construction — readRecord is a plain JSON.parse, so a record written by an older plugin
   *  simply has no `attentionKind` key and reads back `undefined` (never a crash, never a default).
   *  Absent → no discriminator (a plain approval, or an agent that has none). */
  attentionKind?: "userInput";
  /** APPENDED LAST (NOM-44 phase 4), same discipline as `attentionKind` above. The UNABRIDGED plan
   *  markdown whose FITTED copy rides the sealed blob's `plan` key — present ONLY when appendFittedPlan
   *  actually had to cut (or drop) it, so `full === fitted` stores nothing and the phone simply reads the
   *  blob's copy. Served by the LAN listener's `read` op; capped at RECORD_FULL_TEXT_MAX_CHARS with
   *  RECORD_FULL_TEXT_TRUNCATION_MARKER. Written by trackSessionAt, which rebuilds the record whole, so
   *  a later event of the same session drops it automatically. */
  planFull?: string;
  /** APPENDED LAST (NOM-44 phase 4). The UNABRIDGED `permissionDetail` — the whole ExitPlanMode plan,
   *  the whole multi-line Bash command — whose fitted prefix rides the decisionPending blob. Present ONLY
   *  when `fitPermissionDetail` had to cut it. Unlike every other field here it is PATCHED onto an
   *  existing record (see stampPermissionDetailFullAt): the permission hook is a separate short-lived
   *  process that reads the record but never rebuilds it. The next ordinary hook rewrite drops it, which
   *  is exactly the right lifetime — the card is gone by then. */
  permissionDetailFull?: string;
  /** APPENDED LAST. Local-only Codex discovery-suppression marker. After a done row's one-hour
   *  real-event horizon, the watchdog sends op:end but must remember the still-open interactive TUI:
   *  otherwise process discovery would recreate the retired row on its next five-second pass. The
   *  marker is a deliberately minimal SessionRecord (no blob/op/full text), with pid === tuiPid, and
   *  remains only until that TUI exits or a genuine hook rebuilds this file and thereby drops the key.
   *  It never rides a worker or LAN envelope. */
  retiredAt?: number;
  /** APPENDED LAST (NOM-45), same discipline as `attentionKind` above. Epoch ms at which an attention
   *  episode ended because THE WORKER WAS UNREACHABLE — a first-contact POST that failed at the
   *  transport layer with nothing found by the did-it-land probe, or a granted hold that rode
   *  MAX_CONSECUTIVE_MISSES worth of consecutive unusable polls. NOT set for a genuine answer, an
   *  expiry/supersede, a definitive 401/403/404/410, or a thrown exception: those are all states where
   *  the phone's row is telling the truth.
   *
   *  WHY IT EXISTS (field report, 2026-08-03): the hook is fail-open, so the user is never blocked at
   *  the Mac — but the PHONE was left showing a yellow needsAttention hand for a hold that no longer
   *  exists, indistinguishable from a genuine dead end the user could answer. This flag is what lets
   *  computeSessionState say `attn/net` and the settle re-seal the row's blob with `reconnecting`, so
   *  the phone renders the honest auto-retrying treatment instead: the Mac lost contact, and it will
   *  ask again.
   *
   *  LIFETIME is the same as `attentionKind`'s and for the same reason: an ordinary hook rewrite
   *  (trackSessionAt rebuilds the record whole) drops the key, the hold-settle clears it explicitly on
   *  the working branch so the watchdog's `...record` spreads cannot carry it forward, and
   *  computeSessionState only reads it on the rung that can honestly show it (`record.prio === 1`). */
  attentionStalledAt?: number;
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
  /** EXACTLY what buildBlob produced — read from its signature rather than re-declared here. The
   *  hand-copied duplicate this replaces had already drifted: it was missing `folderKey` and `branch`,
   *  the two keys a stash flush is most likely to be blamed for losing (see codex-notify's note on the
   *  sealed blob losing both). */
  blob: ReturnType<typeof buildBlob>;
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
  e2eKey: Bytes;
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
  let e2eKey: Bytes;
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
  qrSecret: Bytes;
  /** The 32-byte PBKDF2 codeIkm for the magic-code pairing path (pairing v2), persisted alongside
   *  qrSecret so `wait` / the watchdog self-heal can complete a CODE claim without recomputing the
   *  600k-iteration PBKDF2. Absent when the worker assigned no channel (QR-only) or for a config
   *  written by an older `pair` — a `path:"code"` claim then can't be completed (treated as tampered). */
  codeIkm?: Bytes;
  /** The PC's ephemeral P-256 private key (pkcs8 DER), generated by pairStart and persisted 0600 so
   *  `wait` / the watchdog self-heal can finish the pairing-v3 ratchet once the phone claims (it needs
   *  the phone's ephemeral public key from /pair/status to derive the durable K1). Absent for a config
   *  written by an older `pair` (pre-v3) — a claim then can't complete the ratchet (treated as tampered). */
  pcEphPriv?: Bytes;
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
  let qrSecret: Bytes;
  try {
    qrSecret = fromB64url(c.qrSecretB64);
  } catch {
    return null;
  }
  if (qrSecret.length !== 16) return null;
  // codeIkm is optional (the magic-code path): present only when the worker assigned a channel. A
  // malformed or wrong-length value is ignored (treated as absent) — a code claim then fails the tamper
  // gate rather than crashing the parse; the QR path is unaffected.
  let codeIkm: Bytes | undefined;
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
  let pcEphPriv: Bytes | undefined;
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
export async function decryptDeviceName(key: Bytes, blob: string): Promise<string> {
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
  stashPath: string, url: string, pairingId: string, pcSecret: string, e2eKey: Bytes, now: number,
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
  let e2eKey: Bytes;
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
//   3. PEER INSTALLS AT DIFFERENT VERSIONS — the rule in (2) was written when a mismatch could only
//      mean an UPGRADE: Claude Code and Codex ship from one build, so their versions could never
//      disagree. OpenCode is the first PEER install (its own dist, updated on its own schedule), and a
//      plain "mismatch → SIGTERM" makes two peers evict each other forever: an OpenCode event spawns
//      the newer daemon, the next Claude hook SIGTERMs it back to the older one, round and round. That
//      is not just churn — the LAN listener lives IN the watchdog, so it flaps down/up on every event
//      (`{"event":"lan","result":"bound","reused":true}`), and the older daemon then REBUILDS frames
//      with an adapter table that predates the newer peer's agent kinds.
//      So: HIGHEST VERSION WINS (watchdogVersionOutranks). Strictly newer → evict and take over. Equal
//      → leave it alone. Older → accept the newer daemon and do NOT downgrade it. The newest build
//      knows the most agent kinds, so it is the one that must own frame rebuilding; an older peer
//      pulling the daemon back down is exactly what corrupts frames. A DELIBERATE downgrade therefore
//      needs an explicit reset — `reset` (src/entries/reset.ts, `/nomo-cc:reset`) stops the watchdog
//      and removes the pidfile, after which the next hook of any build spawns fresh.
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

/** The parsed watchdog pidfile: the holder's pid plus, when the incumbent stamped them, its version
 *  and the identity of the BUNDLE it is actually executing. */
export interface WatchdogPidfile {
  pid: number;
  /** The incumbent's PLUGIN_VERSION. Absent for a pidfile written by a pre-stamp build → older code. */
  version?: string;
  /** The incumbent's `watchdogBuildStamp` — see below. Absent for a pre-build-stamp build, or when it
   *  could not read its own bundle. */
  build?: string;
}

/** The identity of the watchdog BUNDLE — what the version string is not.
 *
 *  A version is bumped at RELEASE; a bundle is rebuilt on every iteration of a fix. The daemon lingers
 *  up to 30 min between sessions, so a rebuild under an unchanged version left the incumbent running
 *  the OLD code with nothing able to notice: `ensureWatchdog` compared version to version, found them
 *  equal, and returned. That is how a shipped, on-disk fix ran nowhere for hours (the LAN decisionPending
 *  hold, 2026-08-02 — the hook wrote its `.hold` markers and the running feed had no code to read them).
 *
 *  CONTENT-DERIVED, deliberately, not mtime or size: the same bundle exists in more than one place on a
 *  real machine (a plugin-cache copy and a dev checkout), and a path-shaped stamp would make two hooks
 *  running from different copies of the SAME build fight over the daemon on every event. FNV-1a over the
 *  bundle is ~0.5 ms for the real ~280 KB file, which is nothing beside the network call this hook is
 *  about to make, and it is not a security boundary — the file is the code we are already executing.
 *
 *  UNDEFINED means UNKNOWN (unreadable, absent, a dev entry that isn't there): never a fabricated stamp,
 *  because a wrong one would either mask a stale daemon or restart a healthy one. */
export function watchdogBuildStamp(path: string = WATCHDOG_PATH): string | undefined {
  try {
    const bytes = readFileSync(path);
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i]!;
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  } catch {
    return undefined;
  }
}

/** Do two build stamps describe DIFFERENT bundles? Only when both are known and disagree: an unknown
 *  stamp on either side (a pre-stamp incumbent, an unreadable bundle) falls back to the version
 *  comparison alone, because guessing "different" there would SIGTERM the daemon on every hook. Pure. */
export function watchdogBuildDiffers(incumbent: string | undefined, current: string | undefined): boolean {
  if (incumbent === undefined || current === undefined) return false;
  return incumbent !== current;
}

/** Does the build stamped `mine` OUTRANK a live incumbent stamped `incumbent` — i.e. may it evict it?
 *  The peer-install rule from note (3) above, and the ONLY place versions are ordered.
 *
 *  RULES, all fail-safe (when in doubt, leave the running daemon alone):
 *    - incumbent version ABSENT (a pre-stamp build wrote a bare-pid pidfile) → older by construction →
 *      outranked, we take over. That is the one "unknown" that is genuinely knowable.
 *    - both parse → strict numeric comparison, component by component. Numeric, never lexical:
 *      "2.10.0" outranks "2.9.0" and "2.1.1" outranks "2.0.2", both of which a string compare gets
 *      backwards.
 *    - EITHER side unparseable → false. Not evicting costs at worst a stale daemon until the next
 *      real upgrade or a `reset`; evicting on a version we cannot read is how the eviction loop starts.
 *  Build metadata ("0.8.10+codex.3") and prerelease tags ("0.0.0-dev", the unbundled sentinel) are
 *  dropped before comparison, so the dev sentinel orders as 0.0.0 — the LOWEST version there is. A raw
 *  source run therefore never evicts an installed release; `reset` is the way to hand it the daemon.
 *  Equal versions return false here; the same-version REBUILD case is handled by the build stamp
 *  (watchdogBuildDiffers), which is what keeps a fix rebuilt in place from running nowhere. Pure. */
export function watchdogVersionOutranks(mine: string, incumbent: string | undefined): boolean {
  if (incumbent === undefined) return true;
  const parse = (v: string): number[] | undefined => {
    const core = v.trim().split("+")[0]!.split("-")[0]!;
    if (core.length === 0) return undefined;
    const parts = core.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
    return parts.some((n) => !Number.isFinite(n)) ? undefined : parts;
  };
  const a = parse(mine), b = parse(incumbent);
  if (a === undefined || b === undefined) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Render the pidfile contents for THIS process (see the format note above). The build stamp is
 *  omitted entirely when unknown, which is byte-for-byte the two-field form earlier builds wrote —
 *  and it is passed IN rather than defaulted, so this stays pure and nothing stats a bundle just to
 *  format a string. The daemon's own claim path supplies `watchdogBuildStamp()`. */
export function formatWatchdogPidfile(
  pid: number, version: string = PLUGIN_VERSION, build?: string,
): string {
  return `${pid} ${version}${typeof build === "string" && build.length > 0 ? ` ${build}` : ""}`;
}

/** Parse a pidfile's contents. Null when there's no usable pid (empty / non-numeric / ≤ 0). Pure. */
export function parseWatchdogPidfile(raw: string): WatchdogPidfile | null {
  const [pidField, versionField, buildField] = raw.trim().split(/\s+/);
  const pid = Number.parseInt(pidField ?? "", 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return {
    pid,
    ...(typeof versionField === "string" && versionField.length > 0 ? { version: versionField } : {}),
    ...(typeof buildField === "string" && buildField.length > 0 ? { build: buildField } : {}),
  };
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
  /** THIS bundle's `watchdogBuildStamp` — the second half of that comparison. */
  build?: string;
}

/** Ensure the detached liveness/self-heal watchdog is running the CURRENT build: if its pidfile is
 *  missing, names a dead process, names a RECYCLED pid (alive but not a watchdog — see
 *  watchdogHolderIsLive), or names a live watchdog this build OUTRANKS (an older plugin version, or the
 *  same version rebuilt in place), spawn a fresh one and let go of it (detached + unref'd, no stdio) so
 *  the caller never waits on it. Such an incumbent is SIGTERMed first — exactly once per call, and only
 *  after the identity check proves it really is our watchdog — so it releases the pidfile through its
 *  normal shutdown path instead of being left to run stale code for the rest of its 30-min idle grace.
 *  A live watchdog from an EQUAL-or-NEWER build is left strictly alone and nothing is spawned: peers at
 *  different versions would otherwise evict each other forever (see note (3) on the pidfile above). The runtime is NOMO_RUNTIME (the run.sh
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
    const build = "build" in deps ? deps.build : watchdogBuildStamp();
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
      if (holder.version === version) {
        // Same VERSION: only the build stamp can tell us anything. Identical bundle → nothing to do;
        // the same version rebuilt in place (the dev loop) → retire the stale bundle. Unchanged.
        if (!watchdogBuildDiffers(holder.build, build)) return;
      } else if (!watchdogVersionOutranks(version, holder.version)) {
        // A DIFFERENT version we do not outrank: an equal-but-differently-spelled stamp, a NEWER peer
        // install (OpenCode vs Claude Code — see note (3) above), or a version we cannot parse. Leave
        // the running daemon alone and do not spawn a second one; the newest build owns the daemon.
        return;
      }
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

/** Tee the UNABRIDGED permission detail onto an EXISTING session record (NOM-44 phase 4), so a phone on
 *  the same network can pull the whole plan/command over LAN instead of the wire-budget prefix.
 *
 *  READ-MODIFY-WRITE, exactly like markDoneDeliveredAt and for the same reason: the permission hook is a
 *  separate short-lived process, so it must patch the one key it owns rather than rewrite a snapshot the
 *  session's own hooks (or the watchdog) may have moved on from. `undefined` is a legitimate value — it
 *  DROPS the key on stringify (the same idiom markDoneDeliveredAt uses for donePending), which is how a
 *  prompt whose detail rode whole clears the copy an earlier prompt in the same session left behind.
 *
 *  No record (the session was reaped, or its first hook has not landed) → nothing to patch, and nothing
 *  to serve either: the LAN read answers not-found, which is the honest answer. Best-effort throughout —
 *  a failed tee costs the phone the truncated copy it would have had anyway. */
export async function stampPermissionDetailFullAt(
  sessionsDir: string, sessionId: string, permissionDetailFull: string | undefined,
): Promise<void> {
  try {
    const record = await readRecord(sessionId, sessionsDir);
    if (!record) return;
    if (record.permissionDetailFull === permissionDetailFull) return; // nothing would change
    await atomicWrite(`${sessionsDir}/${sessionId}.json`, JSON.stringify({ ...record, permissionDetailFull }), 0o600);
  } catch {
    // Bookkeeping is best-effort, exactly like trackSession's own write.
  }
}

/** Production wrapper for the fixed on-disk sessions root (tests inject a temp dir). */
export async function stampPermissionDetailFull(
  sessionId: string, permissionDetailFull: string | undefined,
): Promise<void> {
  return stampPermissionDetailFullAt(SESSIONS_DIR, sessionId, permissionDetailFull);
}

// ---- the remote-approval HOLD marker (the LAN channel's decision-pending guard) ------------------
//
// WHY IT EXISTS. `decisionPending` — the violet Allow/Deny card — is a state the permission hook builds
// ONLY as the body of its POST /v1/cc/decision, never as anything on disk. The worker stores that frame
// and defends it: while a request is pending it DROPS the concurrent plain prio:1 needsAttention that
// CC's `Notification` (permission_prompt) hook fires ~1-6 s later (`dropped:"decision-pending"`,
// server/src/cc.ts). The LAN frames feed, which rebuilds its frames from the SESSION RECORD, had
// neither half: no card to serve, and no guard — so it shipped that plain needsAttention at a stamp
// NEWER than the worker's, and the phone's CCWorkerSnapshotMerge (app build 10) correctly held the
// worker's older decisionPending brief back. The prompt settled on a yellow "needs help" row with no
// Allow/Deny and the user could not answer from the app at all (field report, session bed2e681,
// 2026-08-02). This marker is the record channel's copy of both halves.
//
// A SIBLING FILE, NOT A SessionRecord FIELD, deliberately. `trackSessionAt` rebuilds the record WHOLE on
// every hook event (that is what makes attentionKind/planFull expire on their own), so a field would be
// erased by the very Notification write it exists to outrank — the hook that owns the hold is a separate
// short-lived process and cannot re-stamp it. A `<sessionId>.hold` file sits in the same directory (so
// the feed's fs.watch sees it appear and disappear within milliseconds) while being invisible to every
// other consumer: readdir callers in cc-watchdog, reset, status-cmd, hook.ts and the feed itself all
// filter `.endsWith(".json")`.
//
// CRASH SAFETY IS THE FEED'S, NOT THIS FILE'S. `clearDecisionHold` runs from the hook's `finally`, which
// a SIGKILL — or the SIGTERM a closed terminal sends, seen on bed2e681 — never reaches. So the marker
// carries its own holder pid and start time and the feed treats it as inert the moment that process is
// gone or the TTL lapses (see lanHoldLive). A stale marker can never wedge a row.

/** One live remote-approval hold, as the hook writes it and the LAN frames feed reads it. */
export interface DecisionHold {
  /** The SEALED decisionPending frame — byte-identical to the `blob` the hook POSTed to
   *  /v1/cc/decision, sealed under the pairing e2eKey. The feed is exactly as blind to it as the
   *  worker is; only the phone can open it. */
  blob: string;
  /** Epoch-ms the hold began: the TTL anchor, and the frame's ordering stamp when the record itself
   *  has not been rewritten since. */
  at: number;
  /** The HOLDING HOOK's own pid (not the session's). The feed probes it for liveness, which is what
   *  makes a killed hook release the card in one reconcile pass instead of at the TTL. */
  pid: number;
}

/** Deliberately NOT `.json`: every other readdir consumer of SESSIONS_DIR filters on that extension
 *  (cc-watchdog's two sweeps, reset, status-cmd, hook.ts's two scans, and the frames feed itself), so
 *  a marker can never be mistaken for a session row. */
export const DECISION_HOLD_SUFFIX = ".hold";

/** The marker's file name for a session. */
export function decisionHoldFileName(sessionId: string): string {
  return `${sessionId}${DECISION_HOLD_SUFFIX}`;
}

/** Stamp a live hold beside its session record. Best-effort, like every other write in this file: a
 *  failed stamp costs the phone the LAN card, and the ≤3 s worker poll still carries it. */
export async function writeDecisionHoldAt(
  sessionsDir: string, sessionId: string, hold: DecisionHold,
): Promise<void> {
  try {
    await atomicWrite(`${sessionsDir}/${decisionHoldFileName(sessionId)}`, JSON.stringify(hold), 0o600);
  } catch {
    // Bookkeeping is best-effort, exactly like trackSession's own write.
  }
}

/** Remove a hold marker — COMPARE-AND-CLEAR on the holder pid. Claude runs tools in PARALLEL, so a
 *  SECOND permission hook may have stamped ITS hold over ours while we were polling; an exiting hook
 *  must never silently un-hold a prompt the user is still looking at. A marker we cannot read is
 *  removed anyway (nobody can own it).
 *
 *  Returns whether this pid actually OWNED the marker — which is the gate the caller's record settle
 *  needs (see settleDecisionHoldRecordAt): if a parallel tool's newer hold owns this session, our exit
 *  must move neither the marker nor the record, or we would drop a card the user is still looking at.
 *
 *  `beforeUnlink` runs ONLY when the compare-and-clear accepts, and ALWAYS BEFORE the unlink — this
 *  function is the one place that knows both facts. The order is load-bearing: the LAN frames feed reads
 *  the record and the marker independently per reconcile pass, so a pass that observed "marker gone +
 *  record stale" would ship exactly the frozen yellow the settle exists to prevent. Best-effort: a
 *  throwing callback still retires the marker (a wedged card is worse than a stale record). */
export async function clearDecisionHoldAt(
  sessionsDir: string, sessionId: string, pid: number,
  beforeUnlink?: () => Promise<void>,
): Promise<boolean> {
  const path = `${sessionsDir}/${decisionHoldFileName(sessionId)}`;
  try {
    const raw = await readFile(path, "utf8").catch(() => undefined);
    if (raw !== undefined) {
      let owner: number | undefined;
      try { owner = (JSON.parse(raw) as DecisionHold).pid; } catch { owner = undefined; }
      if (typeof owner === "number" && owner !== pid) return false; // a newer hold owns this session now
    }
    if (beforeUnlink !== undefined) {
      try { await beforeUnlink(); } catch { /* the marker still goes — see the header */ }
    }
    await unlink(path).catch(() => {}); // already gone → nothing to do
    return true;
  } catch {
    // Best-effort: a marker left behind is released by the feed's liveness/TTL guards anyway.
    return false;
  }
}

/** Settle an EXISTING session record out of the hold this process owned (field reports R2/R3, session
 *  a51208e8). The permission hook never wrote the record, so retiring the marker handed the row back to
 *  the state CC's `Notification` hook left there — op:update / prio:1 / needsAttention at a FROZEN ts —
 *  and the LAN feed's monotonic stamp ships that at prevTs+1, where the phone accepts it. Answered, a
 *  later hook advances the record ~1 s on (a yellow FLASH); superseded/expired/gave-up/threw, NOTHING
 *  ever follows — no line is emitted, no tool runs, no hook fires, and the watchdog's idle reap
 *  deliberately skips needsAttention — so the row wedges yellow for good. It also pins the WORKER's
 *  `decact` overlay, which only clears on a prio:0/done/end frame.
 *
 *  READ-MODIFY-WRITE, exactly like markDoneDeliveredAt and stampPermissionDetailFullAt and for the same
 *  reason: the permission hook is a separate short-lived process, so it patches the keys it owns rather
 *  than rewriting a snapshot the session's own hooks (or the watchdog) may have moved on from.
 *
 *  NO-OP UNLESS THE RECORD IS STILL OURS. Only a plain `update`/prio:1 record is the one we overlaid; if
 *  a later hook already advanced it (a parallel tool's PostToolUse, a done, an end) that state is newer
 *  than anything this exiting hook knows and must never be walked back. Best-effort throughout. */
export async function settleDecisionHoldRecordAt(
  sessionsDir: string, sessionId: string, patch: Partial<SessionRecord>,
): Promise<void> {
  try {
    const record = await readRecord(sessionId, sessionsDir);
    if (!record) return;                                        // reaped / never tracked → nothing to settle
    if (record.op !== "update" || record.prio !== 1) return;     // a later hook already moved it on
    await atomicWrite(`${sessionsDir}/${sessionId}.json`, JSON.stringify({ ...record, ...patch }), 0o600);
  } catch {
    // Bookkeeping is best-effort, exactly like trackSession's own write.
  }
}

/** The marker for one session, or null when there is none (the overwhelmingly common case) / it is
 *  unreadable. Never throws. */
export async function readDecisionHoldAt(
  sessionsDir: string, sessionId: string,
): Promise<DecisionHold | null> {
  try {
    return JSON.parse(
      await readFile(`${sessionsDir}/${decisionHoldFileName(sessionId)}`, "utf8"),
    ) as DecisionHold;
  } catch {
    return null;
  }
}

/** Production wrappers for the fixed on-disk sessions root (tests inject a temp dir). */
export async function writeDecisionHold(sessionId: string, hold: DecisionHold): Promise<void> {
  return writeDecisionHoldAt(SESSIONS_DIR, sessionId, hold);
}

export async function clearDecisionHold(
  sessionId: string, pid: number, beforeUnlink?: () => Promise<void>,
): Promise<boolean> {
  return clearDecisionHoldAt(SESSIONS_DIR, sessionId, pid, beforeUnlink);
}

export async function settleDecisionHoldRecord(
  sessionId: string, patch: Partial<SessionRecord>,
): Promise<void> {
  return settleDecisionHoldRecordAt(SESSIONS_DIR, sessionId, patch);
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

/** A REAL controlling tty, i.e. an interactive terminal. macOS `ps` prints "??" for a process with no
 *  controlling terminal (the Codex.app / extension `codex app-server` daemons); "?"/"-" cover other
 *  no-tty spellings defensively. Shared by codex discovery (the daemon filter) and the macOS
 *  terminal-focus locator (a pid with no tty owns no terminal window). Pure. */
export function isRealTty(tty: string): boolean {
  return tty.length > 0 && tty !== "??" && tty !== "?" && tty !== "-";
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
