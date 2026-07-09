// hook — the SHARED hook implementation for BOTH the Claude Code and Codex CLI bridges (v2:
// pairing + E2E). This module has NO top-level entry (no `import.meta.main` block) on purpose: the
// two thin entry files — cc-status.ts (Claude) and codex-status.ts (Codex) — each import runHook from
// here and call it with their own AgentKind. Keeping the entry OUT of this module is what lets both
// bundles include it without double-firing the other agent's entry (Bun's bundler collapses every
// entrypoint into one file and rewrites each `import.meta.main` to the SAME runtime check, so an
// entry block in an IMPORTED entrypoint would run too — hence the strict "entries never import
// entries" split; codex-status.ts imports THIS, not cc-status.ts).
//
// Reads the hook JSON from stdin, plans a v2 envelope (op + prio + an E2E-encrypted blob), and POSTs
// it to the Worker, which is a BLIND relay: it never sees plaintext. Contract with the agent: NOTHING
// on stdout, exit 0 no matter what, give up after 2 seconds — a dead network must never stall or
// derail a session. cc-status.ts re-exports this module's whole surface, so existing importers/tests
// that reference "./cc-status" are unaffected.
//
// PORTABILITY: runs unmodified under bun AND node >= 18. No `Bun.*` APIs — stdin is read via the
// async-iterable process.stdin, file IO via node:fs/promises (shared helpers). build.ts bundles
// this (inlined into each entry) to a .mjs.

import { readdir, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename } from "node:path";
import { encryptBlob } from "./crypto";
import { adapterFor, claudeToolDetail, codexToolDetail, findProvisionalForPid, TrackedSessionLite } from "./adapter";
import {
  AgentKind, atomicWrite, CCOp, CCStatus, Config, ensureWatchdog, GONE_STRIKE_LIMIT,
  LAST_SEND_PATH, lastHookPath, loadConfig, loadPendingConfig, PENDING_STASH_PATH, PendingEventStash, pidAncestors, readPrefix,
  readRecord, recordGoneStrike, removeRevokedConfig, resetGoneStrikes, SessionRecord, SESSIONS_DIR,
} from "./shared";

// Re-export the per-agent title/interrupt/tool-detail surface so existing importers (and cc-status's
// `export *`, which many tests import through) keep seeing sessionTitle / codexIndexTitle / etc.
export * from "./adapter";

/** The plan for one hook event: the v2 op + delivery prio (APNs mechanics) and the semantic status
 *  that will ride INSIDE the encrypted blob (invisible to the worker). Null → the hook is ignored. */
export interface OpPlan {
  op: CCOp;
  prio: 0 | 1;
  status: CCStatus;
}

/// Tool → semantic sub-status key. The two agents' halves live in their adapters (claudeToolDetail /
/// codexToolDetail — see adapter.ts for the per-key rationale); they merge with ZERO key collisions,
/// so this single merged lookup covers whichever agent fired the hook. Unknown tools (e.g. MCP) get
/// no detail rather than a wrong guess — the phone then just shows "Working".
const TOOL_DETAIL: Record<string, string> = { ...claudeToolDetail, ...codexToolDetail };

/** The working sub-status for a tool hook: the tool's label before it runs, "thinking" after. */
export function detailForHook(hookName: string, toolName?: string): string | undefined {
  if (hookName === "PreToolUse") return toolName ? TOOL_DETAIL[toolName] : undefined;
  if (hookName === "PostToolUse") return "thinking";
  return undefined;
}

/// Notification fires for BOTH a real permission prompt and the ~60s idle "Claude is waiting
/// for your input" nudge. Only the permission case actually needs the user — the idle nudge must
/// not flip a finished/working session to "needs help". Mirrors the reference app's `isPerm` gate.
export function isPermissionNotification(i: Record<string, unknown>): boolean {
  const type = typeof i.notification_type === "string" ? i.notification_type : "";
  const msg = (typeof i.message === "string" ? i.message : "").toLowerCase();
  return type === "permission_prompt" || msg.includes("permission") || msg.includes("approve") || msg.includes("allow");
}

/// The LOCAL op planner (the worker is now blind — lifecycle semantics live here). Maps a hook to a
/// v2 op, its delivery prio, and the semantic status carried in the blob:
///   SessionStart                                → start,  prio 0, working
///   UserPromptSubmit / PreToolUse / PostToolUse → update, prio 0, working
///   Notification (permission only) / PermissionRequest → update, prio 1, needsAttention
///   Stop                                        → done,   prio 0, done
///   SessionEnd                                  → end,    prio 0  (no blob)
/// Re-arm: a SessionStart AFTER an op:done was sent for this session (sentDone) restarts as a fresh
/// `update`/working — the session already exists in the worker, so it's an update, not a new start.
/// The update-mapped hooks are already `update`, so they naturally re-arm (and clear sentDone) too.
export function planOp(hookName: string, input: Record<string, unknown>, sentDone: boolean): OpPlan | null {
  switch (hookName) {
    case "SessionStart":
      return sentDone
        ? { op: "update", prio: 0, status: "working" }
        : { op: "start", prio: 0, status: "working" };
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      return { op: "update", prio: 0, status: "working" };
    case "Notification":
      // Drop the idle-waiting Notification so it can't masquerade as "needs help".
      if (!isPermissionNotification(input)) return null;
      return { op: "update", prio: 1, status: "needsAttention" };
    case "PermissionRequest":
      return { op: "update", prio: 1, status: "needsAttention" };
    case "Stop":
      return { op: "done", prio: 0, status: "done" };
    case "SessionEnd":
      return { op: "end", prio: 0, status: "done" };
    default:
      return null;
  }
}

/** How much of the transcript head to scan (title scanners + start-time extractor share this one
 *  bounded read). Both the first user message and CC's first ai-title sit in the opening lines; 128 KB
 *  covers hundreds of JSONL rows without reading the whole (multi-MB, ever-growing) file. */
const TITLE_SCAN_BYTES = 128 * 1024;

/// The session's TRUE start (epoch ms), read from the transcript head — the SAME bounded prefix the
/// title scanners read, so it adds no second file read. One scan covers BOTH agents because they share
/// a line shape here: the first parseable JSONL line that carries a top-level string `timestamp`
/// (ISO-8601) is the session's first real entry.
///   - Claude's transcript OPENS with meta lines (last-prompt / mode / permission-mode) that have NO
///     timestamp; its first real entry (SessionStart / a user turn) does — verified against a live
///     `~/.claude/projects/*/*.jsonl` (e.g. `"timestamp":"2026-07-07T16:14:10.165Z"`).
///   - Codex's first rollout line is `{"timestamp":"…Z","type":"session_meta","payload":{…}}` — the
///     top-level timestamp — verified against `~/.codex/sessions/2026/.../rollout-*.jsonl`.
/// Scanning top-down and returning the FIRST valid timestamp yields the earliest entry in the head.
/// Malformed / missing / not-yet-flushed → undefined (the worker then keeps its first-seen fallback).
export function transcriptStartMs(prefix: string): number | undefined {
  for (const line of prefix.split("\n")) {
    if (!line.includes("\"timestamp\"")) continue; // cheap pre-filter — skip the timestamp-less meta rows
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; } // a byte-sliced final line / non-JSON → skip
    if (typeof row !== "object" || row === null) continue;
    const ts = (row as Record<string, unknown>).timestamp;
    if (typeof ts !== "string") continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/** The plaintext content of the encrypted blob: the semantic status, the optional tool detail, the
 *  display fields (title/machine/label), and the optional per-turn anchor. This is ALL the worker
 *  never sees. Shape must match the Swift `CCBlobPlaintext` the phone/widget decode.
 *
 *  `pinnedLabel` — the session's FIRST-SEEN label (from its record) — wins over the event's cwd when
 *  given: a mid-session `cd` changes input.cwd on every later hook, and re-deriving the label per event
 *  silently renamed the phone row / island folder chip (observed live: "api-status" → "server" after a
 *  `cd server`). Absent/empty → first event (or a recordless caller): derive from cwd as before. */
export function buildBlob(input: Record<string, unknown>, machine: string, title: string | undefined, plan: OpPlan, agent: AgentKind = "claude", turnStartedAt?: number, pinnedLabel?: string): {
  status: CCStatus; detail?: string; title: string; machine: string; label: string; agent?: AgentKind; turnStartedAt?: number;
} {
  const label = typeof pinnedLabel === "string" && pinnedLabel.length > 0
    ? pinnedLabel
    : typeof input.cwd === "string" && input.cwd.length > 0 ? basename(input.cwd) : "session";
  const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const detail = detailForHook(hookName, typeof input.tool_name === "string" ? input.tool_name : undefined);
  // The `agent` key is OMITTED for claude (byte-identical to the pre-codex blob so old Swift builds and
  // the existing snapshots are unaffected) and the literal "codex" for a codex session. `turnStartedAt`
  // (epoch SECONDS — the current turn's start, see runHook) is likewise OMITTED when unknown, so a blob
  // from a session with no prompt seen yet stays byte-identical to a pre-0.3.5 one.
  return {
    status: plan.status, title: title ?? "", machine, label,
    ...(detail ? { detail } : {}),
    ...(agent === "codex" ? { agent: "codex" as const } : {}),
    ...(typeof turnStartedAt === "number" && Number.isFinite(turnStartedAt) ? { turnStartedAt } : {}),
  };
}

/** The wire envelope for one hook event: the blind v2 shape `{v:2, sessionId, op, prio, ts, blob?}`.
 *  op:end carries no blob (the worker reuses the last stored one); every other op carries the E2E-
 *  encrypted blob. Null when the hook is ignored (unknown/dropped) or has no session id. `sentDone`
 *  drives the re-arm (a start after a done becomes an update). */
export async function buildEnvelope(
  input: unknown, machine: string, now: number, title: string | undefined, e2eKey: Uint8Array, sentDone: boolean,
  agent: AgentKind = "claude", startedAt?: number, turnStartedAt?: number, pinnedLabel?: string,
): Promise<Record<string, unknown> | null> {
  if (typeof input !== "object" || input === null) return null;
  const i = input as Record<string, unknown>;
  if (typeof i.session_id !== "string" || i.session_id.length === 0) return null;
  const hookName = typeof i.hook_event_name === "string" ? i.hook_event_name : "";
  const plan = planOp(hookName, i, sentDone);
  if (!plan) return null;
  // startedAt (epoch ms, matching `ts`'s unit) rides on EVERY op — including end, whose final frame the
  // worker times too. OMITTED when unknown so the wire stays byte-identical to an old plugin's post.
  const base: Record<string, unknown> = { v: 2, sessionId: i.session_id, op: plan.op, prio: plan.prio, ts: now };
  if (typeof startedAt === "number" && Number.isFinite(startedAt)) base.startedAt = startedAt;
  if (plan.op === "end") return base; // clean SessionEnd carries no content — worker reuses last blob
  // turnStartedAt rides INSIDE the encrypted blob only — the clear envelope shape above must stay
  // byte-identical (no new fields the worker could see; zero server changes).
  const blob = await encryptBlob(e2eKey, buildBlob(i, machine, title, plan, agent, turnStartedAt, pinnedLabel));
  return { ...base, blob };
}

/** The pending-pairing stash for THIS hook, or null when there's nothing to stash. Built from the same
 *  planOp + buildBlob the paired path uses, but WITHOUT the e2eKey (still unknown mid-pairing) — the
 *  plaintext blob is stashed and encrypted later, at flush, by completePendingPairing. sentDone is
 *  fixed false: no session record is tracked while pairing, so there is no done to re-arm from. An
 *  op:end is skipped — it carries no blob for a session the worker has never seen. */
export function buildPendingStash(
  input: Record<string, unknown>, machine: string, title: string | undefined, now: number, pid: number = process.ppid,
  agent: AgentKind = "claude",
): PendingEventStash | null {
  if (typeof input.session_id !== "string" || input.session_id.length === 0) return null;
  const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const plan = planOp(hookName, input, false);
  if (!plan || plan.op === "end") return null;
  // Record the session's `claude`/`codex` process (process.ppid — the same notion trackSession/the
  // watchdog use) so the flush can drop the stash if that terminal was closed while pairing was still
  // pending (its later hooks no-op'd, so no watchdog was ever attached) instead of resurrecting a ghost.
  // The agent rides inside the stashed plaintext blob (via buildBlob), so it survives the flush.
  // turnStartedAt is stamped ONLY when the stashed hook ITSELF is the turn opener (UserPromptSubmit):
  // mid-pairing there is no session record to read a cached anchor from, so any other hook's turn
  // start is genuinely unknown and the blob omits it (the widget falls back to `startedAt`).
  const turnStartedAt = hookName === "UserPromptSubmit" ? Math.floor(now / 1000) : undefined;
  return { sessionId: input.session_id, op: plan.op, prio: plan.prio, blob: buildBlob(input, machine, title, plan, agent, turnStartedAt), stashedAt: now, pid };
}

/** Stash THIS hook's plaintext event next to config.json (owner-only, like config.json) so the pairing
 *  completer can flush it the instant it derives the key. Called from main() only while mid-pairing.
 *  Best-effort: a missed stash just leaves the phone waiting for the next hook, as it does today. */
export async function stashPendingEvent(
  input: Record<string, unknown>, machine: string, title: string | undefined, now: number,
  stashPath = PENDING_STASH_PATH, pid: number = process.ppid, agent: AgentKind = "claude",
): Promise<void> {
  try {
    const stash = buildPendingStash(input, machine, title, now, pid, agent);
    if (!stash) return;
    await atomicWrite(stashPath, JSON.stringify(stash), 0o600);
  } catch {
    // best-effort — never surface into a Claude Code session
  }
}

/** Per-session liveness bookkeeping. Record the session's `claude` process (process.ppid) so a
 *  detached watchdog can notice a force-killed terminal that fires no SessionEnd hook; on op:end,
 *  delete the record instead (nothing to reap). Persists the op/prio/blob so the watchdog can re-send
 *  a staleness heartbeat verbatim, and `sentDone` so the next hook re-arms correctly. Best-effort. */
export async function trackSession(
  sessionId: string, op: CCOp, prio: 0 | 1, status: CCStatus, blob: string | undefined,
  machine: string, label: string, transcript: string, agent: AgentKind = "claude", sessionStartedAt?: number,
  turnStartedAt?: number, turnId?: string, title?: string, pairingId?: string,
): Promise<void> {
  try {
    const path = `${SESSIONS_DIR}/${sessionId}.json`;
    if (op === "end") {
      await unlink(path).catch(() => {}); // clean exit → no watchdog reaping needed
      return;
    }
    // lastEvent is the watchdog interrupt-net's gate key: a fresh `start` is a quiet "sessionStart",
    // otherwise the semantic status (working / needsAttention / done). `agent` (omitted for claude)
    // tells the watchdog which interrupt marker to scan the transcript tail for.
    const record: SessionRecord = {
      pid: process.ppid,
      machine,
      label,
      ts: Date.now(),
      transcript,
      lastEvent: op === "start" ? "sessionStart" : status,
      sentDone: op === "done",
      op,
      prio,
      ...(blob ? { blob } : {}),
      ...(agent === "codex" ? { agent } : {}),
      // Cache the parsed start so the next hook and the watchdog re-send it without re-reading the
      // transcript (and so it survives the transcript later going away). Omitted when unknown.
      ...(typeof sessionStartedAt === "number" && Number.isFinite(sessionStartedAt) ? { sessionStartedAt } : {}),
      // Cache the turn anchor (epoch SECONDS, stamped by UserPromptSubmit) the same way, so the turn's
      // later hooks and the watchdog's corrective done thread the SAME value into their blobs.
      ...(typeof turnStartedAt === "number" && Number.isFinite(turnStartedAt) ? { turnStartedAt } : {}),
      // Bind this record to its Codex turn (the hook input's `turn_id`) so the notify backstop can tell
      // a stale turn-N notify from the live turn N+1. Claude has no turn_id → omitted (guard inert).
      ...(typeof turnId === "string" && turnId.length > 0 ? { turnId } : {}),
      // The last NON-EMPTY display title (callers thread `title ?? previousRecord.title`). The
      // watchdog's corrective done/needsAttention envelopes rebuild their blobs from this record, and
      // without a cached title they'd re-push title:"" — the phone then falls back to the folder-name
      // label. Omitted when no title has ever resolved.
      ...(typeof title === "string" && title.length > 0 ? { title } : {}),
      // The pairing this record's `blob` was SEALED under. A re-pair rotates the key; the watchdog's
      // staleness heartbeat re-sends `blob` verbatim, so it must only do that while the pairing that
      // sealed it is still the live one — otherwise the phone renders an undecryptable ghost forever.
      ...(typeof pairingId === "string" && pairingId.length > 0 ? { pairingId } : {}),
    };
    // Owner-only (0600): the record carries hostname, cwd basename, the session pid, and the ABSOLUTE
    // transcript path — never group/world readable, matching config.json / the pending stash.
    await atomicWrite(path, JSON.stringify(record), 0o600);
  } catch {
    // Bookkeeping is best-effort; on failure the server's 30-min eviction is still the backstop.
  }
}

/** Reconcile a provisional discovery (see cc-watchdog's discovery step): a real hook has now fired for
 *  this codex TUI, so end + delete any PROVISIONAL session the watchdog surfaced ahead of it. Matches by
 *  pid — the hook's process.ppid is the codex TUI process, which is the provisional's pid (with an
 *  ancestor-walk fallback; see findProvisionalForPid). POSTs an op:end for the sentinel sessionId (the
 *  worker reuses the last blob for the final frame) then deletes the provisional record so the sweep/
 *  reap never re-touches it. Best-effort: a failure just leaves the provisional for the sweep backstop
 *  or the pid-death reap. REMOVABLE with the discovery feature once openai/codex#15269 ships. */
async function reconcileProvisional(config: Config, hookPid: number): Promise<void> {
  try {
    const files = await readdir(SESSIONS_DIR).catch(() => [] as string[]);
    const provisionals: { sessionId: string; pid: number }[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let r: SessionRecord;
      try { r = JSON.parse(await readFile(`${SESSIONS_DIR}/${f}`, "utf8")) as SessionRecord; } catch { continue; }
      if (r.provisional === true && typeof r.pid === "number") provisionals.push({ sessionId: basename(f, ".json"), pid: r.pid });
    }
    if (provisionals.length === 0) return;
    const sentinel = findProvisionalForPid(provisionals, hookPid, pidAncestors);
    if (!sentinel) return;
    await fetch(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret },
      body: JSON.stringify({ v: 2, sessionId: sentinel, op: "end", prio: 0, ts: Date.now() }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
    await unlink(`${SESSIONS_DIR}/${sentinel}.json`).catch(() => {});
  } catch {
    // best-effort — never surface into a session
  }
}

/** Every tracked session's ghost-check projection (id + pid + provisional + agent), read best-effort
 *  from SESSIONS_DIR. Feeds AgentAdapter.isChildSessionGhost — the codex app-server child-session
 *  guard needs to know whether some OTHER real session already owns this hook's pid. */
async function readTrackedSessions(): Promise<TrackedSessionLite[]> {
  const files = await readdir(SESSIONS_DIR).catch(() => [] as string[]);
  const out: TrackedSessionLite[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(await readFile(`${SESSIONS_DIR}/${f}`, "utf8")) as SessionRecord;
      out.push({ sessionId: basename(f, ".json"), pid: r.pid, provisional: r.provisional, agent: r.agent });
    } catch { /* half-written / corrupt → skip */ }
  }
  return out;
}

/** Read the whole of stdin (the hook JSON) as UTF-8. process.stdin is an async iterable of Buffers
 *  under both bun and node, so this needs no Bun-specific API. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/// The hook body, parametrized by which agent invoked it. Behavior for `claude` is byte-identical to
/// the historical main() (the module entry below calls runHook("claude")); the codex entry
/// (codex-status.ts) calls runHook("codex"). The ONLY agent-dependent branches are (a) the title
/// scanner — codex has no ai-title/user turns, so it reads the rollout's first user_message with a
/// UserPromptSubmit-prompt fallback for the very first prompt (the rollout may not have flushed yet) —
/// and (b) the `agent` key threaded into the blob / stash / session record. Both agents share the
/// same hook_event_name strings, so planOp/prio/op mapping is unchanged. The consecutive-gone strike
// helpers (readGoneStrikes/resetGoneStrikes/recordGoneStrike) live in shared so the watchdog's
// sweep counts against the SAME streak — see the shared-counter note there.
export async function runHook(agent: AgentKind): Promise<void> {
  try {
    const [config, raw] = await Promise.all([loadConfig(), readStdin()]);
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (typeof input.session_id !== "string" || input.session_id.length === 0) return;

    // Codex compat-layer guard: Codex ≥0.142 auto-discovers installed Claude Code plugins as hook
    // sources, so it can invoke cc-status.mjs — the CLAUDE entry (runHook("claude")) — inside a Codex
    // session. Left unguarded, that Codex event masquerades as a Claude session and lands on the wrong
    // tab on the phone. Two independent signals fingerprint a Codex-in-Claude event; EITHER restamps
    // the effective agent to codex for the whole run (blob agent field, session record agent, title
    // scanner):
    //   (a) turn_id — Codex's PER-TURN hook payloads carry a non-empty `turn_id` string; Claude's
    //       never do. This catches every event fired inside a turn.
    //   (b) transcript_path under "/.codex/" — session-scoped Codex events (SessionStart-shaped) carry
    //       NO turn_id (observed in the wild 2026-07-09, flipping Codex sessions onto the Claude tab),
    //       so (a) misses them. But their transcript still points at ~/.codex/sessions/rollout-*.jsonl,
    //       whereas Claude transcripts live under ~/.claude/projects/ — so a "/.codex/" path is a robust
    //       agent fingerprint even when turn_id is absent. Conservative (substring, not a parse): a
    //       "/.claude/" path can never match, so a real Claude run is never wrongly flipped.
    if (agent === "claude" && (
      (typeof input.turn_id === "string" && input.turn_id.length > 0) ||
      (typeof input.transcript_path === "string" && input.transcript_path.includes("/.codex/"))
    )) {
      agent = "codex";
    }
    // Select the per-agent adapter AFTER the restamp guard — this IS the adapter selection, so a
    // Codex-in-Claude event uses the codex adapter (title scanner + tool detail) for the whole run.
    const adapter = adapterFor(agent);

    // Hook-liveness stamp (per RESOLVED agent): rewritten on every invocation, BEFORE the pairing gate,
    // so status-cmd can tell "hooks are firing" from "the agent silently drops them" (Codex #16430/
    // #30835 — activity in the rollout but no stamp). Cheap (one small write; hooks run 8x/turn already)
    // and best-effort — a stamp failure must never derail the rest of the hook.
    await atomicWrite(lastHookPath(agent), String(Date.now())).catch(() => {});

    const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
    // The transcript head, read AT MOST ONCE per hook and shared by BOTH the title scanner and the
    // start-time extractor (so the start-time fix adds no second file read). "" when there's no
    // transcript yet or it's unreadable; the callers tolerate an empty scan.
    let prefixCache: string | undefined;
    const getPrefix = async (): Promise<string> => {
      if (prefixCache !== undefined) return prefixCache;
      prefixCache = "";
      if (transcriptPath.length > 0) {
        try { prefixCache = await readPrefix(transcriptPath, TITLE_SCAN_BYTES); } catch { /* no transcript yet */ }
      }
      return prefixCache;
    };

    // The session name. Read lazily (only the paired or mid-pairing paths need it) so a never-paired
    // machine's hooks stay fully inert. The per-agent resolution chain (codex: session_index
    // thread_name → rollout scan → UserPromptSubmit prompt; claude: ai-title → first user prompt)
    // lives in the adapter, which reads from the same bounded, memoized prefix the start-time
    // extractor uses.
    const readTitle = async (): Promise<string | undefined> =>
      adapter.title({ sessionId: input.session_id as string, prefix: await getPrefix(), input });

    // No completed config: normally inert. But if a pairing is PENDING (QR on screen, phone not yet
    // scanned), stash this hook's plaintext event — we have no e2eKey to POST with yet. The pairing
    // completer flushes it the moment it derives the key, so the phone shows the pairing session
    // immediately instead of empty-until-the-next-hook. Unpaired-and-not-pairing → still fully inert.
    if (!config) {
      const pending = await loadPendingConfig();
      if (pending) {
        const machine = pending.machineName ?? hostname().replace(/\.local$/, "");
        await stashPendingEvent(input, machine, await readTitle(), Date.now(), PENDING_STASH_PATH, process.ppid, agent);
      }
      return;
    }

    const machine = config.machineName ?? hostname().replace(/\.local$/, "");

    // One record read serves the child-ghost guard, the sentDone re-arm, and the cached session
    // start. A cached start (an earlier hook parsed it) wins so we never re-parse and it survives the
    // transcript later vanishing; otherwise parse it from the same head `readTitle` reads (memoized —
    // no second read). Unknown → omitted from the envelope; the worker keeps its first-seen fallback.
    const existingRecord = await readRecord(input.session_id);

    // Child-session ghost guard (adapter seam; codex-only in practice): the ChatGPT.app
    // `codex app-server` spawns child session ids with NO rollout content that share their pid with
    // the real session — each would otherwise become a brand-new, forever-empty phone row. Only consulted
    // for a NEVER-tracked id, so an already-live session can never be silenced by it.
    if (!existingRecord && adapter.isChildSessionGhost) {
      const tracked = await readTrackedSessions();
      if (tracked.length > 0 && adapter.isChildSessionGhost({
        sessionId: input.session_id, prefix: await getPrefix(), hookPid: process.ppid, tracked,
      })) return;
    }

    // Reconcile a provisional discovery: Codex fires no hook at session OPEN (openai/codex#15269), so
    // the watchdog may have surfaced this TUI provisionally. Now that a REAL codex hook is reporting,
    // end that provisional so the phone doesn't show both it and the real session. Codex-only (Claude
    // has no discovery). Runs before the real event so the phone ends the provisional then starts the
    // real session, in order. REMOVABLE once openai/codex#15269 ships.
    if (agent === "codex") await reconcileProvisional(config, process.ppid);

    const title = await readTitle();
    const sentDone = existingRecord?.sentDone === true;
    const cachedStart = typeof existingRecord?.sessionStartedAt === "number" && Number.isFinite(existingRecord.sessionStartedAt)
      ? existingRecord.sessionStartedAt : undefined;
    const startedAt = cachedStart ?? transcriptStartMs(await getPrefix());
    const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
    // The CURRENT TURN's anchor (epoch SECONDS — the blob's unit, unlike the ms everywhere else). A
    // UserPromptSubmit opens a fresh turn — BOTH agents fire it under this exact hook_event_name (codex
    // sends Claude's hook names verbatim; see the codex-payload planOp tests) — so it stamps NOW and the
    // record caches it; every other hook of the turn re-uses the cached value so the island timer keeps
    // one steady anchor. No cache and no prompt yet (session pre-dating 0.3.5 / island enabled mid-turn)
    // → undefined, the blob omits it, and the widget falls back to `startedAt`.
    const cachedTurn = typeof existingRecord?.turnStartedAt === "number" && Number.isFinite(existingRecord.turnStartedAt)
      ? existingRecord.turnStartedAt : undefined;
    const turnStartedAt = hookName === "UserPromptSubmit" ? Math.floor(Date.now() / 1000) : cachedTurn;
    // The Codex turn id (Claude payloads carry none → undefined). Cached on the record so the notify
    // backstop's stale-turn guard can compare it against a delayed notify's payload turn-id.
    const turnId = typeof input.turn_id === "string" && input.turn_id.length > 0 ? input.turn_id : undefined;
    const plan = planOp(hookName, input, sentDone);
    if (!plan) return;
    // Pin the label to the session's FIRST-SEEN cwd: a mid-session `cd` changes input.cwd on every
    // later hook, and re-deriving the label per event silently renamed the phone row / island folder
    // chip (observed live: "api-status" → "server" after a `cd server`). A session's identity must not
    // follow its shell around, so once the record holds a label it is reused verbatim; only the first
    // event (no record yet) derives it from cwd.
    const label = typeof existingRecord?.label === "string" && existingRecord.label.length > 0
      ? existingRecord.label
      : typeof input.cwd === "string" && input.cwd.length > 0 ? basename(input.cwd) : "session";
    const envelope = await buildEnvelope(input, machine, Date.now(), title, config.e2eKey, sentDone, agent, startedAt, turnStartedAt, label);
    if (!envelope) return;

    // Record (or, on op:end, remove) this session's file and make sure the liveness watchdog is
    // running before we POST — a force-killed terminal fires no SessionEnd, so this is how the phone
    // learns of a dead session in seconds instead of after the 30-min eviction.
    // Cache the last NON-EMPTY title (this hook's, else the previous record's) so the watchdog's
    // corrective envelopes never regress to title:"" — and stamp the pairing the blob was sealed
    // under so a heartbeat after a re-pair can't re-send an undecryptable stale blob.
    await trackSession(input.session_id, plan.op, plan.prio, plan.status, envelope.blob as string | undefined, machine, label, transcriptPath, agent, startedAt, turnStartedAt, turnId,
      title ?? existingRecord?.title, config.pairingId);
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
    if (res.ok) {
      // Success marker for Task 2.2's `status` command: the epoch-ms of the last delivered event. A
      // delivered event also breaks any gone streak (the pairing is plainly alive again).
      await atomicWrite(LAST_SEND_PATH, String(Date.now()));
      await resetGoneStrikes();
    } else if (res.status === 404 || res.status === 410) {
      // The pairing is GONE server-side (404 = deleted, 410 = dormant-GC'd once). Without this, a
      // revoked pairing keeps POSTing ~2×/tool-use forever, 404ing on every hook. A single gone
      // response can be a transient/racing delete, so require GONE_STRIKE_LIMIT CONSECUTIVE ones
      // before deleting the credential-bearing config; the watchdog counts against the SAME shared
      // streak and uses the same teardown.
      const strikes = await recordGoneStrike();
      if (strikes >= GONE_STRIKE_LIMIT) {
        await removeRevokedConfig();
        process.stderr.write(`[nomo-cc] pairing gone server-side (HTTP ${res.status}) — removed local pairing; re-pair with \`nomo-cc pair\` to reconnect\n`);
      }
    } else {
      // 401/403/429/5xx — ambiguous / transient. Never tear down; just clear any gone streak so a
      // real revoke later still needs its own two consecutive gone responses.
      await resetGoneStrikes();
    }
  } catch {
    // Silence is the contract — never surface errors into a Claude Code (or Codex) session.
  }
}
