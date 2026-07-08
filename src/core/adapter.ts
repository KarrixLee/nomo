// adapter — the per-AGENT half of the hook pipeline, behind one small AgentAdapter interface.
//
// Everything the Claude and Codex bridges do DIFFERENTLY lives here: how a session's title is
// resolved, how an interrupt is detected in the transcript tail, where each agent's sessions and
// hook-liveness stamp live, and each agent's tool→detail map. The agent-AGNOSTIC pipeline
// (planOp / buildBlob / buildEnvelope / trackSession / the watchdog sweep) stays in hook.ts /
// cc-watchdog.ts and dispatches through `adapterFor(agent)`.
//
// This module has NO entry (no import.meta.main) — it's inlined into every bundle that dispatches
// through it (cc-status, codex-status, codex-notify, cc-watchdog, status-cmd). It imports only the
// leaf helpers in shared.ts, so it never pulls an entry's top-level side effects into a bundle.
//
// PORTABILITY: bun AND node >= 18 — no `Bun.*` APIs; file IO via node:fs/promises (shared helpers).

import { join } from "node:path";
import { AgentKind, codexHome, lastHookPath, readSuffix } from "./shared";

/// Tool → semantic sub-status key (localized on-device by the widget). Mirrors the reference
/// menu-bar app's tool labels, but as stable keys, not English strings. Unknown tools (e.g. MCP)
/// get no detail rather than a wrong guess — the phone then just shows "Working".
///
/// The two halves are kept per-agent (each adapter carries its own), but merge with ZERO key
/// collisions, so hook.ts's detailForHook does a single merged lookup that covers whichever agent
/// fired the hook.
///   - Codex serializes shell/unified_exec as the Claude-style "Bash" (HookToolName::bash()), so the
///     existing Bash→running entry already covers it; "shell"/"local_shell" are added defensively in
///     case a future/native variant emits them.
///   - apply_patch (codex's edit tool; matcher aliases Write/Edit are internal-only and NOT the
///     serialized payload name) → editing.
///   - update_plan → planning, view_image → reading, web_search → web, spawn_agent (matcher alias
///     Agent) → delegating.
///   - MCP tools serialize as mcp__server__tool on both agents → unknown → no detail.

/** Claude Code tool names → sub-status key. */
export const claudeToolDetail: Record<string, string> = {
  Bash: "running",
  Edit: "editing", Write: "editing", MultiEdit: "editing", NotebookEdit: "editing",
  Read: "reading",
  Grep: "searching", Glob: "searching",
  WebFetch: "web", WebSearch: "web",
  Task: "delegating",
  TodoWrite: "planning",
};

/** Codex CLI native tool names (canonical hook payload `tool_name`s) → sub-status key. */
export const codexToolDetail: Record<string, string> = {
  shell: "running", local_shell: "running",
  apply_patch: "editing",
  view_image: "reading",
  web_search: "web",
  spawn_agent: "delegating",
  update_plan: "planning",
};

// --- Title resolution ------------------------------------------------------------------------

/// The session's name is CC's own generated summary when available, else its first human prompt.
/// CC writes its short summary to the transcript as `{"type":"ai-title","aiTitle":"…"}` lines and
/// re-emits them as the session evolves — so we prefer the freshest ai-title and only fall back to
/// the first user message before CC has generated one (the opening turns). Command/UI artifacts
/// (content wrapped in <tags>) are skipped so the fallback lands on the real first ask.

/** ai-title over pre-split lines: scan BOTTOM-UP and early-exit on the first (i.e. freshest) valid
 *  `ai-title`, so we JSON.parse one line instead of every re-emitted ai-title in the prefix. A cheap
 *  substring pre-filter (`"ai-title"` must appear literally in the raw line) skips JSON.parse on the
 *  vast majority of lines. Result is identical to a top-down "keep the last non-empty" scan. */
function aiTitleFromLines(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes("\"ai-title\"")) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.type !== "ai-title" || typeof r.aiTitle !== "string") continue;
    const cleaned = r.aiTitle.replace(/\s+/g, " ").trim();
    if (cleaned) return cleaned.slice(0, 80);
  }
  return undefined;
}

/** CC's generated session summary, taken from the last `ai-title` line in the given text (CC
 *  re-emits it as the topic shifts, so the last one is freshest). Undefined if none is present. */
export function aiTitle(transcript: string): string | undefined {
  return aiTitleFromLines(transcript.split("\n"));
}

/** The name to show for a session: CC's ai-title if it exists, else the first user prompt. Splits the
 *  transcript ONCE and hands the same line array to both scanners, so a per-hook title costs a single
 *  split (was two — one in aiTitle, another in firstUserPrompt) plus two early-exit passes. */
export function sessionTitle(transcript: string): string | undefined {
  const lines = transcript.split("\n");
  return aiTitleFromLines(lines) ?? firstUserPromptFromLines(lines);
}

/// The PRIMARY codex title source. Codex CLI (≥0.142) writes a clean, AI-generated thread title to
/// `$CODEX_HOME/session_index.jsonl` — one JSON object per line
/// `{"id":<session uuid>,"thread_name":<title>,"updated_at":<iso>}` — the very label `codex resume`
/// displays. It's written asynchronously ~30-40s into a NAMED thread (absent before that, and for
/// unnamed threads). This beats the rollout scan below, whose raw `user_message` lines catch skill /
/// plugin invocation artifacts (`[$nomo:…](…)`, `[@nomo-cc](…) pair`) rather than the real intent.
///
/// Pure parser (content in, title out) so it's trivially testable. We match the hook's `session_id`;
/// on duplicate ids the LAST matching line wins (freshest — the file is append/rewrite-ordered). The
/// cheap substring pre-filter skips JSON.parse on non-matching lines; malformed lines are tolerated.
/// The clean thread_name is capped via truncateOnWord (NOT cleanPromptTitle — like CC's ai-title it's
/// already a summary, so it needs the length cap, not the Markdown-strip meant for raw prompts).
export function codexThreadName(indexContent: string, sessionId: string): string | undefined {
  let found: string | undefined;
  for (const line of indexContent.split("\n")) {
    if (!line.includes(sessionId)) continue; // cheap pre-filter — skip JSON.parse on non-matches
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.id !== sessionId || typeof r.thread_name !== "string") continue;
    const cleaned = r.thread_name.replace(/\s+/g, " ").trim();
    if (cleaned) found = truncateOnWord(cleaned); // keep scanning: last match wins
  }
  return found;
}

/** How much of the session_index tail to scan. The file is append/rewrite-ordered and grows for the
 *  LIFE of the install (one row per thread, ever), so an uncapped read would balloon on every hook —
 *  including sub-second PreToolUse/PostToolUse bursts. A session's freshest entry sits at/near the END
 *  (see codexThreadName's ordering note), so a bounded TAIL is both cheap and sufficient. 128 KB
 *  matches TITLE_SCAN_BYTES and covers hundreds of index rows. */
const INDEX_SCAN_BYTES = 128 * 1024;

/** Read `$CODEX_HOME/session_index.jsonl` (honoring CODEX_HOME like the rest of the codebase) and
 *  resolve `sessionId` to its thread_name. Reads a bounded TAIL (INDEX_SCAN_BYTES) rather than the
 *  whole file: the index grows unboundedly over an install's lifetime, and the freshest row for a
 *  session is at/near the end, so the tail carries it. A byte-sliced partial first line just fails the
 *  sessionId substring pre-filter / JSON.parse in codexThreadName and is skipped — the same tolerance
 *  tailShowsInterrupt/codexLastTurnEvent rely on. Missing/unreadable → undefined (fall through to the
 *  rollout scan); a hook must never crash, so every failure is swallowed silently. */
export async function codexIndexTitle(sessionId: string, home: string = codexHome()): Promise<string | undefined> {
  try {
    const content = await readSuffix(join(home, "session_index.jsonl"), INDEX_SCAN_BYTES);
    return codexThreadName(content, sessionId);
  } catch {
    return undefined; // no index yet (or unreadable) — the rollout scan is the fallback
  }
}

/// The FALLBACK codex title source, used until codex writes the session_index thread_name (~30s in).
/// Codex's rollout transcript has NO `ai-title` lines and NO `{"type":"user"}` turns, so neither
/// aiTitle nor firstUserPrompt can name a codex session. Instead codex records the user's prompt as a
/// rollout line `{"timestamp":…,"type":"event_msg","payload":{"type":"user_message","message":"…"}}`
/// (verified against codex-rs: RolloutItem is #[serde(tag="type",content="payload")] → the outer
/// `event_msg` tag; EventMsg::UserMessage(UserMessageEvent{ message }) → payload.type "user_message"
/// with the text in `payload.message`; matches the real fixture in rollout/src/tests.rs). We take the
/// FIRST such message from the same bounded prefix, skip empty / `<`-wrapped command artifacts AND
/// `[$…`/`[@…` skill/plugin invocation artifacts (these pass through the plain event_msg pipe and
/// would otherwise become the title), and clean it exactly like the Claude first-prompt fallback
/// (cleanPromptTitle). The cheap `"user_message"` substring pre-filter skips JSON.parse on the
/// session_meta / turn_context / response_item noise above it.
export function codexSessionTitle(transcript: string): string | undefined {
  const lines = transcript.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!line.includes("\"user_message\"")) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.type !== "event_msg") continue;
    const payload = r.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== "user_message") continue;
    const message = payload.message;
    if (typeof message !== "string") continue;
    const cleaned = message.replace(/\s+/g, " ").trim();
    // skip empty / command-UI artifacts (`<…>`) and skill/plugin invocation artifacts (`[$…`, `[@…`)
    if (!cleaned || cleaned.startsWith("<") || /^\[[$@]/.test(cleaned)) continue;
    return cleanPromptTitle(cleaned);
  }
  return undefined;
}

/** Title length cap — kept at the historical 80 so the phone/island layout is unchanged; the ellipsis
 *  on a truncated title can add one char (≤ 81), which the layout already tolerates. */
const TITLE_MAX = 80;

/** Truncate on a WORD boundary with an ellipsis instead of a hard mid-word cut. At/under the cap the
 *  string is returned verbatim. Past it, back off to the last space inside the cap (so no partial word
 *  survives), strip any trailing punctuation/space, and append "…". A single long word with no space
 *  falls back to a hard cut + ellipsis. */
export function truncateOnWord(s: string, max: number = TITLE_MAX): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[\s,;:.!?-]+$/, "")}…`;
}

/** Clean a raw first-user-prompt into a display title: strip the common Markdown noise CC prompts
 *  carry (inline-code backticks, *emphasis* / **strong** / _underscores_, ~~strike~~, and leading #
 *  heading markers), collapse whitespace, then truncate on a word boundary. This runs on the
 *  first-prompt FALLBACK only — CC's own `aiTitle` is already a clean summary and is NOT passed here.
 *  Paired-marker regexes (not a blanket `*`/`_` strip) so snake_case and a*b don't get mangled. */
export function cleanPromptTitle(text: string): string {
  const stripped = text
    .replace(/`+/g, "")                       // inline-code backticks
    .replace(/\*{1,3}([^*]+?)\*{1,3}/g, "$1")  // *italic* / **bold** / ***both***
    .replace(/_{1,3}([^_]+?)_{1,3}/g, "$1")    // _italic_ / __bold__
    .replace(/~~([^~]+?)~~/g, "$1")            // ~~strike~~
    .replace(/^\s*#{1,6}\s+/gm, "")            // leading # heading markers
    .replace(/\s+/g, " ")
    .trim();
  return truncateOnWord(stripped);
}

/** First user prompt over pre-split lines: early-exits on the first `type:"user"` turn. A cheap
 *  substring pre-filter (a user row always carries the literal `"user"`) skips JSON.parse on the
 *  assistant / ai-title / tool lines above it, so a transcript whose first user turn sits a few rows
 *  down parses only the handful of candidate lines instead of every line. */
function firstUserPromptFromLines(lines: string[]): string | undefined {
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!line.includes("\"user\"")) continue; // a user row is `{"type":"user",...}` — always present
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.type !== "user") continue;
    const msg = r.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    let text: string | undefined;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      // Tool-result turns are content arrays; take the first text part if any.
      const part = content.find((p) => typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text");
      const t = (part as Record<string, unknown> | undefined)?.text;
      if (typeof t === "string") text = t;
    }
    if (typeof text !== "string") continue;
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.startsWith("<")) continue; // skip command/UI artifacts
    // Markdown-strip + word-boundary truncate so a prompt written in Markdown doesn't render raw
    // `**asterisks**` or get hard-cut mid-word (the stashed pairing-prompt title bug).
    return cleanPromptTitle(cleaned);
  }
  return undefined;
}

export function firstUserPrompt(transcript: string): string | undefined {
  return firstUserPromptFromLines(transcript.split("\n"));
}

// --- Transcript interrupt detection ----------------------------------------------------------
//
// An Esc-interrupt or a denied permission fires NO hook (on either agent). The watchdog tails the
// session transcript and asks its adapter whether the last turn was aborted; the two detections are
// structurally different:
//   - Claude Code writes "[Request interrupted by user]" into the LAST real turn line of its JSONL.
//   - Codex persists a rollout `event_msg` whose payload.type is "turn_aborted" on Esc/abort
//     (EventMsg::TurnAborted; verified in codex-rs/rollout/src/policy.rs — it IS persisted). Codex
//     has no user/assistant turn lines, so we instead look at the LAST turn-lifecycle event
//     (task_started / task_complete / turn_aborted): if that boundary is turn_aborted, the turn was
//     aborted; a later task_started (a fresh/resumed turn) means it wasn't.

/** The raw substring Claude Code writes into the aborted turn ("[Request interrupted by user]" or
 *  "…for tool use"); matching the substring covers both. */
const INTERRUPT_MARKER = "interrupted by user";
/** Codex rollout turn-lifecycle `event_msg` payload.type values (task_started/task_complete are
 *  EventMsg::TurnStarted/TurnComplete serde-renamed; turn_aborted is EventMsg::TurnAborted). The net
 *  inspects the LAST of these in the tail — turn_aborted means the turn was Esc/aborted. */
const CODEX_TURN_EVENTS = new Set(["task_started", "task_complete", "turn_aborted"]);
/** The codex abort marker (payload.type of EventMsg::TurnAborted). */
const CODEX_ABORT_EVENT = "turn_aborted";

/** The transcript's LAST real turn line: the last line whose JSON parses to an object with
 *  type "user" or "assistant", scanning from the end so Claude Code's post-interrupt bookkeeping
 *  lines (system/summary/mode) are skipped. A line that fails JSON.parse is skipped. Null if none. */
export function lastTurnLine(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const t = (row as Record<string, unknown>).type;
    if (t === "user" || t === "assistant") return line;
  }
  return null;
}

/** Whether a raw transcript line carries the user-interrupt marker (Claude Code). */
export function hasInterruptMarker(line: string): boolean {
  return line.includes(INTERRUPT_MARKER);
}

/** The codex rollout's LAST turn-lifecycle event type (payload.type), scanning from the end and
 *  skipping every non-boundary line (response items, agent messages, token counts, byte-sliced
 *  fragments). Returns the payload.type of the last task_started / task_complete / turn_aborted, or
 *  null if none is present. The cheap `event_msg` substring pre-filter skips JSON.parse on the noise. */
export function codexLastTurnEvent(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!line.includes("event_msg")) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.type !== "event_msg") continue;
    const payload = r.payload as Record<string, unknown> | undefined;
    const t = payload?.type;
    if (typeof t === "string" && CODEX_TURN_EVENTS.has(t)) return t;
  }
  return null;
}

// --- The adapter ------------------------------------------------------------------------------

/** Everything the two agent bridges do DIFFERENTLY, behind one interface. `adapterFor(agent)`
 *  selects the concrete adapter; the agent-agnostic pipeline dispatches through it. */
export interface AgentAdapter {
  /** The blob/record `agent` literal — baked into on-disk `last-hook-<agent>` names, so it MUST equal
   *  the existing "claude"/"codex" values. */
  kind: AgentKind;
  /** Resolve the session's display title from the (already-read) transcript prefix + hook input.
   *  Async because the codex path also reads the session_index. Undefined → no title yet. */
  title(ctx: { sessionId: string; prefix: string; input: Record<string, unknown> }): Promise<string | undefined>;
  /** Whether the transcript tail shows the last turn was interrupted (the two detections differ). */
  detectInterrupt(tail: string): boolean;
  /** Where this agent's session transcripts live (recursively scanned for liveness). */
  sessionsDir(): string;
  /** Whether a filename under sessionsDir() is one of this agent's session transcripts. */
  sessionMatch(name: string): boolean;
  /** This agent's hook-liveness stamp path (`<CC_DIR>/last-hook-<kind>`). */
  hookStampPath(): string;
  /** The user-facing hint printed when this agent's hooks appear to have stopped firing. */
  hooksNotFiringHint: string;
  /** This agent's half of the tool→detail map (see the merged-lookup note above). */
  toolDetail: Record<string, string>;
}

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  async title({ prefix }): Promise<string | undefined> {
    // Both the first user message and CC's ai-title sit near the top; the prefix carries them.
    return prefix.length > 0 ? sessionTitle(prefix) : undefined;
  },
  detectInterrupt(tail: string): boolean {
    const line = lastTurnLine(tail);
    return line !== null && hasInterruptMarker(line);
  },
  sessionsDir: () => `${process.env.HOME}/.claude/projects`,
  sessionMatch: (name: string) => name.endsWith(".jsonl"),
  hookStampPath: () => lastHookPath("claude"),
  hooksNotFiringHint: "  Reinstall the plugin / check /plugin.",
  toolDetail: claudeToolDetail,
};

export const codexAdapter: AgentAdapter = {
  kind: "codex",
  async title({ sessionId, prefix, input }): Promise<string | undefined> {
    // PRIMARY: the clean AI-generated thread_name codex writes to session_index.jsonl ~30-40s in.
    // Re-read every hook (no memo) so a later hook UPGRADES an earlier prompt-derived fallback the
    // moment the index title appears — the blob is rebuilt+resent per hook, so the phone's title
    // corrects itself without any special "already have a title" bookkeeping.
    const indexTitle = await codexIndexTitle(sessionId);
    if (indexTitle) return indexTitle;
    // FALLBACK 1: scan the rollout prefix (bounded — a byte-sliced final line just fails JSON.parse).
    let title: string | undefined;
    if (prefix.length > 0) title = codexSessionTitle(prefix);
    // FALLBACK 2: on the very first prompt the rollout may not have flushed the user_message line yet,
    // but the UserPromptSubmit hook carries the raw prompt in its `prompt` field — clean it the same
    // way the transcript path would.
    if (title === undefined && typeof input.prompt === "string" && input.prompt.length > 0) {
      const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
      if (hookName === "UserPromptSubmit") title = cleanPromptTitle(input.prompt);
    }
    return title;
  },
  detectInterrupt(tail: string): boolean {
    return codexLastTurnEvent(tail) === CODEX_ABORT_EVENT;
  },
  sessionsDir: () => `${codexHome()}/sessions`,
  sessionMatch: (name: string) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
  hookStampPath: () => lastHookPath("codex"),
  hooksNotFiringHint: "  Run /hooks in Codex to re-trust, or reinstall the plugin — known upstream bugs #16430/#30835.",
  toolDetail: codexToolDetail,
};

/** Select the concrete adapter for an agent kind. */
export function adapterFor(agent: AgentKind): AgentAdapter {
  return agent === "codex" ? codexAdapter : claudeAdapter;
}
