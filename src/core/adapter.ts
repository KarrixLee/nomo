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

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import { AgentKind, codexHome, lastHookPath, readPrefix, readSuffix, SessionRecord } from "./shared";

const execFileP = promisify(execFile);

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

/** How much of the transcript TAIL the Claude title resolver reads. CC re-emits `ai-title` lines as
 *  the session evolves, so on a LONG transcript the freshest one lives near the END — far outside the
 *  bounded head window (observed live: a 3.7 MB transcript whose FIRST ai-title sat at byte ~590K;
 *  the head scan found nothing and the phone fell back to the folder-name label). Sized to match the
 *  128 KB head window so a large assistant/tool line between the last ai-title and EOF still leaves
 *  the title inside the read. */
const TITLE_TAIL_BYTES = 128 * 1024;

/** The Claude session's display title: the FRESHEST `ai-title` from a bounded transcript TAIL (long
 *  sessions append them over time, so the newest one sits near EOF, not in the head), else the head's
 *  ai-title / first user prompt (sessionTitle — the opening turns, before CC has generated a summary).
 *  Mirrors claudeSessionModel's tail-then-head shape: one bounded readSuffix, best-effort — a missing/
 *  unreadable transcript just falls through to the already-read head prefix. */
export async function claudeSessionTitle(prefix: string, transcriptPath: string): Promise<string | undefined> {
  if (transcriptPath.length > 0) {
    try {
      const t = aiTitle(await readSuffix(transcriptPath, TITLE_TAIL_BYTES));
      if (t) return t;
    } catch { /* no transcript yet / unreadable — fall through to the head prefix */ }
  }
  return prefix.length > 0 ? sessionTitle(prefix) : undefined;
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

/** First user prompt over pre-split lines: early-exits on the first REAL `type:"user"` turn. A cheap
 *  substring pre-filter (a user row always carries the literal `"user"`) skips JSON.parse on the
 *  assistant / ai-title / tool lines above it, so a transcript whose first user turn sits a few rows
 *  down parses only the handful of candidate lines instead of every line.
 *
 *  "Real" excludes the non-prompt user rows a Claude transcript can OPEN with (observed in the wild:
 *  a session whose head was all local-command noise resolved title:"" and the phone fell back to the
 *  folder name):
 *    - `isMeta:true` rows (CC's own bookkeeping marker for injected/meta user messages),
 *    - `<command-name>` / `<command-message>` / `<local-command-stdout>` command-UI rows (the existing
 *      leading-`<` skip covers these, plus a substring check for tag-noise that doesn't lead),
 *    - the "Caveat: The messages below were generated by the user while running local commands…"
 *      wrapper CC injects ahead of local-command output,
 *    - messages that are ONLY a <system-reminder> block; reminder blocks embedded in a real prompt
 *      are stripped so the visible prompt text becomes the title. */
function firstUserPromptFromLines(lines: string[]): string | undefined {
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!line.includes("\"user\"")) continue; // a user row is `{"type":"user",...}` — always present
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.type !== "user") continue;
    if (r.isMeta === true) continue; // CC bookkeeping row (caveat/command noise), never the real ask
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
    const title = displayTitleFromUserText(text);
    if (title === undefined) continue; // command/UI noise — keep scanning for the real ask
    return title;
  }
  return undefined;
}

/** Clean ONE raw user-message text into a display title, or undefined when it's command/UI noise.
 *  The single cleaning gauntlet shared by the transcript first-prompt scanner above and the claude
 *  adapter's UserPromptSubmit `input.prompt` fallback, so both judge "is this a real ask?" identically:
 *  embedded <system-reminder> blocks are stripped FIRST (a reminder-only message reduces to "" and is
 *  rejected, while a real prompt carrying an appended reminder keeps its visible text); command/UI
 *  artifacts (leading `<`, the local-command Caveat wrapper, command-tag noise mid-string) are
 *  rejected; what survives is Markdown-stripped + word-boundary truncated (cleanPromptTitle) so a
 *  Markdown prompt doesn't render raw `**asterisks**` or get hard-cut mid-word. Never returns "". */
export function displayTitleFromUserText(text: string): string | undefined {
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.startsWith("<")) return undefined; // command/UI artifacts
  if (cleaned.startsWith("Caveat:")) return undefined; // the local-command caveat wrapper is not a prompt
  if (cleaned.includes("<command-name>") || cleaned.includes("<local-command-stdout>")) return undefined; // command noise mid-string
  const title = cleanPromptTitle(cleaned);
  return title.length > 0 ? title : undefined; // all-Markdown-noise input can clean to "" — that's not a title
}

export function firstUserPrompt(transcript: string): string | undefined {
  return firstUserPromptFromLines(transcript.split("\n"));
}

// --- Session model resolution -----------------------------------------------------------------
//
// v0.8.5: each blob OPTIONALLY carries the session's raw model id (e.g. "claude-fable-5",
// "gpt-5-codex") so the phone can badge the session. STRICTLY optional — OMITTED entirely when
// unknown, NEVER an empty string — so an old blob stays byte-identical and the app hides the badge.
// The two agents' sources differ, so resolution lives here behind AgentAdapter.model:
//   - Claude's hook stdin has NO model field. The transcript's assistant lines each carry the
//     serving model at `message.model`, so the LAST assistant line (bounded tail read) tracks a
//     mid-session /model switch; the FIRST assistant line in the already-read head prefix is the
//     free fallback (frozen at session start).
//   - Codex stamps a top-level `model` on its per-turn hook payloads (primary); the rollout's
//     freshest `turn_context` line carries `payload.model` (fallback); the configured default in
//     $CODEX_HOME/config.toml is the last resort (weakest — a per-session override never reaches it).

/** How much of the transcript tail the model resolvers read. Bigger than the 8 KB interrupt nets:
 *  a single assistant line (large code block) or a burst of response items can exceed a few KB, and
 *  the freshest assistant/turn_context line must land inside the window. Still one bounded read. */
const MODEL_TAIL_BYTES = 64 * 1024;

/** The `message.model` of ONE Claude transcript line, or undefined when the line isn't a real
 *  assistant turn. CRITICAL: only a `"type":"assistant"` row's TOP-LEVEL `message.model` counts —
 *  transcripts also contain Task subagent invocations whose tool_use input has a `model` field
 *  ("model":"opus") that is NOT the session model; parsing (not substring-matching) `message.model`
 *  is what keeps those out. Sidechain rows (a Task subagent's own turns, `isSidechain:true`) and
 *  CC's synthetic error rows (`message.model:"<synthetic>"`) are likewise not the session model. */
function assistantModelFromLine(line: string): string | undefined {
  if (!line.includes("\"assistant\"") || !line.includes("\"model\"")) return undefined; // cheap pre-filter
  let row: unknown;
  try { row = JSON.parse(line); } catch { return undefined; }
  if (typeof row !== "object" || row === null) return undefined;
  const r = row as Record<string, unknown>;
  if (r.type !== "assistant") return undefined;
  if (r.isSidechain === true) return undefined; // a Task subagent's turn — its model isn't the session's
  const model = (r.message as Record<string, unknown> | undefined)?.model;
  if (typeof model !== "string") return undefined;
  const cleaned = model.trim();
  if (!cleaned || cleaned.startsWith("<")) return undefined; // "" / "<synthetic>" → not a real model id
  return cleaned;
}

/** The LAST assistant line's `message.model` in the given text (scanned bottom-up, early-exit) — the
 *  freshest, so it tracks a mid-session /model switch. Undefined when no assistant line carries one. */
export function lastAssistantModel(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = assistantModelFromLine(lines[i]);
    if (m) return m;
  }
  return undefined;
}

/** The FIRST assistant line's `message.model` in the given text — the session's opening model. Used
 *  on the already-read head prefix as the free fallback when the tail read fails/finds nothing. */
export function firstAssistantModel(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const m = assistantModelFromLine(line);
    if (m) return m;
  }
  return undefined;
}

/** The Claude session's model id: the LAST assistant `message.model` from a bounded transcript tail
 *  (tracks /model switches), else the FIRST from the already-read head prefix (frozen at session
 *  start), else undefined (a session with no assistant turn yet — the blob then omits `model`).
 *  Best-effort: a missing/unreadable transcript just falls through to the prefix. */
export async function claudeSessionModel(prefix: string, transcriptPath: string): Promise<string | undefined> {
  if (transcriptPath.length > 0) {
    try {
      const m = lastAssistantModel(await readSuffix(transcriptPath, MODEL_TAIL_BYTES));
      if (m) return m;
    } catch { /* no transcript yet / unreadable — fall through to the head prefix */ }
  }
  return prefix.length > 0 ? firstAssistantModel(prefix) : undefined;
}

/** The freshest `turn_context` line's `payload.model` in the given rollout text (scanned bottom-up,
 *  early-exit — codex re-emits turn_context per turn, so the last one is the turn that's running).
 *  Line shape: `{"timestamp":…,"type":"turn_context","payload":{…,"model":"gpt-5-codex",…}}`. A
 *  byte-sliced first line just fails JSON.parse and is skipped, like every tail scanner here. */
export function codexModelFromRollout(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes("turn_context")) continue; // cheap pre-filter
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.type !== "turn_context") continue;
    const model = (r.payload as Record<string, unknown> | undefined)?.model;
    if (typeof model !== "string") continue;
    const cleaned = model.trim();
    if (cleaned) return cleaned;
  }
  return undefined;
}

/** The TOP-LEVEL `model = "…"` assignment in codex's config.toml (the configured DEFAULT model —
 *  the weakest source: a per-session `codex -m …` override never reaches it). Only the root section
 *  (before the first `[table]` header) is scanned, mirroring parseNotifyFromToml. Basic (double-
 *  quoted) strings parse via JSON (a compatible subset on one line, tolerating a trailing comment);
 *  literal ('single-quoted') strings are matched directly. Anything else → undefined. */
export function codexConfigModel(toml: string): string | undefined {
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) break; // first table header → past the top-level section
    const m = line.match(/^\s*model\s*=\s*(.*)$/);
    if (!m) continue;
    const rest = m[1].trim();
    const dq = rest.match(/^"((?:[^"\\]|\\.)*)"/); // basic string (stops at the closing quote → ignores a trailing # comment)
    if (dq) {
      try {
        const v = JSON.parse(`"${dq[1]}"`) as string;
        if (v.length > 0) return v;
      } catch { /* malformed escapes → unusable */ }
      return undefined;
    }
    const sq = rest.match(/^'([^']*)'/); // literal string
    if (sq && sq[1].length > 0) return sq[1];
    return undefined; // present but not a shape we can parse
  }
  return undefined;
}

/** The Codex session's model id, by decreasing authority:
 *  1. the hook payload's own top-level `model` (codex stamps it on per-turn hook events — exact);
 *  2. the freshest rollout `turn_context` payload.model — a bounded tail read first (latest turn),
 *     then the already-read head prefix (the opening turn);
 *  3. the configured default in $CODEX_HOME/config.toml (weakest).
 *  Undefined when all three fail — the blob then omits `model`. Never throws; never returns "". */
export async function codexSessionModel(
  input: Record<string, unknown>, prefix: string, transcriptPath: string, home: string = codexHome(),
): Promise<string | undefined> {
  if (typeof input.model === "string" && input.model.trim().length > 0) return input.model.trim();
  if (transcriptPath.length > 0) {
    try {
      const m = codexModelFromRollout(await readSuffix(transcriptPath, MODEL_TAIL_BYTES));
      if (m) return m;
    } catch { /* no rollout yet / unreadable — fall through */ }
  }
  if (prefix.length > 0) {
    const m = codexModelFromRollout(prefix);
    if (m) return m;
  }
  try {
    return codexConfigModel(await readFile(join(home, "config.toml"), "utf8"));
  } catch {
    return undefined; // no config.toml — the model is genuinely unknown
  }
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

// --- Codex pending-approval detection (backstop for a DROPPED PermissionRequest hook) --------
//
// On Codex, `needsAttention` can come from a PermissionRequest hook (tool/patch approval) or the
// PreToolUse hook for request_user_input (an interactive question). Codex has NO upstream Notification
// event (unlike Claude Code), and is known to SILENTLY DROP lifecycle hooks (openai/codex#16430).
// This classifier is the watchdog's rollout-tail backstop: it detects either kind of user-blocking
// request at the tail with no subsequent resolution.
//
// The approval-request events (codex-rs `protocol/src/protocol.rs`, EventMsg is
// `#[serde(tag="type", rename_all="snake_case")]`):
//   - EventMsg::ExecApprovalRequest       → payload.type "exec_approval_request"
//     (crate::approvals::ExecApprovalRequestEvent — carries call_id/command/cwd/reason)
//   - EventMsg::ApplyPatchApprovalRequest → payload.type "apply_patch_approval_request"
// A pending episode is RESOLVED by the tool result / turn progress that follows the user's decision:
//   - a function_call_output / custom_tool_call_output ResponseItem (the tool ran, was denied, or the
//     user answered request_user_input),
//   - an exec_command_end / patch_apply_end event_msg (the tool finished),
//   - a task_complete / turn_aborted / task_started event_msg (turn ended / a new turn began),
//   - a user_message event_msg (the user moved the session on).
// So "pending" = scanning the tail from the end, the FIRST decisive marker is a request, not a
// resolution (symmetric with codexLastTurnEvent). A function_call named request_user_input is itself
// a request because Codex persists that call while the choice UI is open. Every other line
// (token_count, agent_message, reasoning, ordinary function calls, …) is noise and is scanned past.
//
// PERSISTENCE CAVEAT — verified against codex-rs `rollout/src/policy.rs` @ tag `rust-v0.142.5` (the
// user's installed codex-cli): `should_persist_event_msg` classifies BOTH approval-request events as
// "Transient, non-durable" (→ false), so on that build they are NOT written to the rollout and this
// backstop stays DORMANT (returns false on every real rollout — confirmed empirically: 0 approval
// events across 82 local rollouts, all auto-approved). It is kept as a forward-/other-version- and
// history-mode-compatible net that costs one already-bounded tail read per sweep and — because it keys
// ONLY on the explicit approval event or a function_call whose name is exactly request_user_input —
// never on an ordinary function_call awaiting output — so a long-running command cannot false-flag.

/** Codex approval-REQUEST event_msg payload.type values (EventMsg::ExecApprovalRequest /
 *  ApplyPatchApprovalRequest). A trailing one, unresolved, is a pending approval. */
const CODEX_APPROVAL_REQUEST_EVENTS = new Set(["exec_approval_request", "apply_patch_approval_request"]);
/** The persisted function call that opens Codex's interactive choice UI and blocks on the user. */
const CODEX_USER_INPUT_TOOL = "request_user_input";
/** event_msg payload.type values that RESOLVE a pending approval (the tool finished, or the turn
 *  ended / a new turn began, or the user moved on). */
const CODEX_APPROVAL_RESOLUTION_EVENTS = new Set(["exec_command_end", "patch_apply_end", "task_complete", "turn_aborted", "task_started", "user_message"]);
/** response_item payload.type values that RESOLVE a pending approval — the tool RESULT landed (the
 *  call ran after approval, or carries the denial). */
const CODEX_APPROVAL_RESOLUTION_ITEMS = new Set(["function_call_output", "custom_tool_call_output"]);

/** Whether the codex rollout tail shows an approval REQUEST that has no subsequent resolution — a
 *  pending approval the phone must surface as needsAttention. Scans from the END and returns on the
 *  first DECISIVE line: a request → pending (true); a resolution (tool result / turn progress) →
 *  resolved (false). Noise lines (token_count, agent_message, reasoning, the proposing function_call)
 *  are skipped. No request anywhere in the tail → false. Backstop for a dropped Codex PermissionRequest
 *  hook (openai/codex#16430); see the section note for the persistence caveat. A byte-sliced first line
 *  just fails JSON.parse and is skipped, like the other tail scanners. */
export function codexTailPendingApproval(tail: string): boolean {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    // cheap pre-filter: only event_msg (approval requests + turn/tool-end events) and response_item
    // (tool results) lines can be decisive — everything else is noise.
    if (!line.includes("event_msg") && !line.includes("response_item")) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const payload = r.payload as Record<string, unknown> | undefined;
    const ptype = typeof payload?.type === "string" ? (payload.type as string) : undefined;
    if (!ptype) continue;
    if (r.type === "event_msg") {
      if (CODEX_APPROVAL_REQUEST_EVENTS.has(ptype)) return true;    // last decisive marker is a request → pending
      if (CODEX_APPROVAL_RESOLUTION_EVENTS.has(ptype)) return false; // turn/tool progress → resolved
    } else if (r.type === "response_item") {
      if (ptype === "function_call" && payload?.name === CODEX_USER_INPUT_TOOL) {
        return true; // the interactive choice call is persisted before the user answers it
      }
      if (CODEX_APPROVAL_RESOLUTION_ITEMS.has(ptype)) {
        return false; // the tool result landed → the approval/question was answered
      }
    }
    // anything else (function_call proposing the tool, token_count, agent_message, …) → keep scanning
  }
  return false; // no approval request in the tail → nothing pending
}

// --- Claude pending-approval detection (backstop for a DROPPED PreToolUse hook) ---------------
//
// On Claude, needsAttention for a USER-blocking tool (AskUserQuestion / ExitPlanMode) rides the hook
// path: the PreToolUse-mapped instant needsAttention (see hook.ts planOp / USER_BLOCKING_TOOLS), plus
// the reliable Notification/PermissionRequest channels. But if that PreToolUse hook is DROPPED, the
// phone keeps showing "working" while Claude is actually parked on the user — until Claude Code's own
// idle Notification eventually fires (~5 min). This classifier is the watchdog's transcript-tail
// backstop, mirroring the codex one: it converts a missed hook into ≤~5-10 s of delay (the watchdog
// polls every 5 s) instead of ~5 min.
//
// A Claude session is blocked-on-user iff the LAST assistant turn issues a `tool_use` for one of the
// user-blocking tools AND no LATER line carries a `tool_result` for that tool_use id (the user hasn't
// answered). Claude writes the assistant turn as `{"type":"assistant","message":{"content":[…,{"type":
// "tool_use","id":"toolu_…","name":"AskUserQuestion",…}]}}` and the answer as a user turn
// `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_…",…}]}}`. An
// ordinary long-running tool (Bash, Task, …) ALSO has a tool_use with no result WHILE it runs, so the
// name gate is load-bearing: ONLY AskUserQuestion / ExitPlanMode count, never a bare pending tool_use.
// Sidechain (subagent) rows are ignored — a Task subagent's own turns aren't the session's block state.

/** The Claude tools that block on the USER (mirrors hook.ts USER_BLOCKING_TOOLS — a question / plan
 *  approval only the human can answer). Kept here so this watchdog backstop is self-contained. */
const CLAUDE_USER_BLOCKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** The id of a USER-BLOCKING `tool_use` in an assistant row's content array, or undefined when the row
 *  issues no such tool_use. Only AskUserQuestion / ExitPlanMode qualify — an ordinary tool_use (a
 *  long-running Bash, an Edit, …) returns undefined, so a merely in-flight tool never reads as pending. */
function blockingToolUseId(assistantRow: Record<string, unknown>): string | undefined {
  const content = (assistantRow.message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p.type !== "tool_use" || typeof p.name !== "string" || !CLAUDE_USER_BLOCKING_TOOLS.has(p.name)) continue;
    if (typeof p.id === "string" && p.id.length > 0) return p.id;
  }
  return undefined;
}

/** Whether a Claude `user` turn carries a `tool_result` for the given tool_use id — the user's answer to
 *  the blocking question/plan (an approval, or a rejection; both write a tool_result). */
function hasToolResultFor(row: Record<string, unknown>, id: string): boolean {
  const content = (row.message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p.type === "tool_result" && p.tool_use_id === id) return true;
  }
  return false;
}

/** Whether the Claude transcript tail shows a PENDING user-blocking tool — an AskUserQuestion /
 *  ExitPlanMode the session is parked on with no answer yet. Finds the LAST assistant turn (sidechain
 *  rows skipped); if it issues a user-blocking tool_use and no later line carries that tool_use's
 *  tool_result, the session is blocked (true). Any other last assistant turn — plain text, or an
 *  ordinary non-blocking tool_use like a running Bash — is not a pending approval (false). Because
 *  Claude can only continue PAST a user-blocking tool once the user answers (which writes a
 *  tool_result), a later assistant turn always implies the earlier block was resolved — so the
 *  tool_result check is exact. Backstop for a dropped PreToolUse hook; a byte-sliced line just fails
 *  JSON.parse and is skipped, like every other tail scanner. Never throws. */
export function claudeTailPendingApproval(tail: string): boolean {
  // Collect only the decisive rows — assistant `tool_use` turns and user `tool_result` turns — skipping
  // sidechain/subagent noise. The cheap substring pre-filter skips JSON.parse on the vast majority of
  // lines (a user tool_result row still matches via its `tool_use_id`).
  const rows: Record<string, unknown>[] = [];
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    if (!line.includes("tool_use") && !line.includes("tool_result")) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.isSidechain === true) continue; // a Task subagent's turn — not the session's own block state
    rows.push(r);
  }
  // The LAST assistant turn decides: pending only if IT is a user-blocking tool_use with no later result.
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type !== "assistant") continue;
    const id = blockingToolUseId(rows[i]);
    if (!id) return false; // last assistant turn isn't a user-blocking tool → not parked on the user
    for (let j = i + 1; j < rows.length; j++) if (hasToolResultFor(rows[j], id)) return false; // answered
    return true; // user-blocking tool_use, no answer yet → pending
  }
  return false; // no assistant turn in the tail
}

// --- Codex idle-vs-in-flight turn classification (for discovery/provisional rows) -------------
//
// The watchdog's discovery step used to advertise EVERY live Codex TUI as status "working" — but an
// idle REPL sitting at its prompt is NOT "Running", and with no hook ever firing for it the phone
// showed a perpetual working row (user-confirmed live repro 2026-07-10: an idle TUI open since 2 AM
// stuck "Running" all night). The classifier below decides, from the pid's own rollout tail, whether
// a turn is GENUINELY open:
//   - the last turn-lifecycle boundary (codexLastTurnEvent) is task_started → a turn is open;
//   - it is task_complete / turn_aborted → the turn ended → idle;
//   - NO boundary in the tail (a fresh rollout that's only session_meta, or a long turn whose
//     task_started scrolled past the tail window): idle unless the tail shows turn traffic
//     (response_item / event_msg lines) AND the file was written recently — a mid-flight turn keeps
//     appending, so recent traffic with an unknown boundary is conservatively "open", while a silent
//     or traffic-less rollout is idle.
// Defaults are deliberately IDLE-biased: misreading an active turn as idle self-corrects in seconds
// (its next real hook posts "working" under the real session id), whereas misreading idle as working
// sticks forever (no hook will ever correct a promptless TUI) — the very bug this fixes.

/** How long a rollout with NO turn boundary in its tail must be write-silent before the TUI is
 *  classified idle. Short: a genuinely open turn appends response/event lines far more often than
 *  this, and the watchdog re-checks every sweep (5 s) anyway. */
export const CODEX_ROLLOUT_IDLE_SILENCE_MS = 30_000;

/** The codex turn-OPEN boundary (payload.type of EventMsg::TurnStarted, serde-renamed). */
const CODEX_TURN_OPEN_EVENT = "task_started";

/** Whether the rollout tail shows a turn GENUINELY in flight. `silentForMs` is how long ago the
 *  rollout was last written (now − mtime) — consulted only when the tail carries no turn boundary.
 *  Pure so the whole decision matrix is unit-testable; see the section note for the rules. */
export function codexTurnActiveFromTail(tail: string, silentForMs: number): boolean {
  const last = codexLastTurnEvent(tail);
  if (last === CODEX_TURN_OPEN_EVENT) return true; // a turn is open (trailing token_count/… is noise)
  if (last !== null) return false; // task_complete / turn_aborted → the turn ended → idle
  // No boundary in the tail. A fresh rollout (session_meta only — no turn ever ran) is idle no matter
  // how recently it was created; a boundary-less tail WITH turn traffic is only "open" while the file
  // is still being written (a mid-turn rollout appends continuously).
  if (silentForMs >= CODEX_ROLLOUT_IDLE_SILENCE_MS) return false;
  return tail.includes("\"response_item\"") || tail.includes("\"event_msg\"");
}

/** How much of the rollout tail the turn-state probe reads — same bound as the watchdog's interrupt/
 *  pending-approval nets (the turn boundary rides the last few KB). */
const TURN_STATE_TAIL_BYTES = 8 * 1024;

/** Pure: the open rollout path from `lsof -p <pid> -Fn` output (an `n<path>` line whose basename is a
 *  `rollout-*.jsonl`). When present this pins the pid's EXACT rollout — but the TUI only holds the fd
 *  open around writes (observed live: an idle TUI showed `45w …/rollout-….jsonl` one minute and no
 *  rollout fd the next), so absence proves nothing; the cwd+recency fallback below covers the closed
 *  case. Undefined when no rollout fd is listed. */
export function rolloutPathFromLsof(output: string): string | undefined {
  for (const line of output.split("\n")) {
    if (!line.startsWith("n")) continue;
    const path = line.slice(1);
    const name = basename(path);
    if (name.startsWith("rollout-") && name.endsWith(".jsonl")) return path;
  }
  return undefined;
}

/** The rollout file `pid` holds open, via `lsof -p <pid> -Fn`. Undefined on any failure. */
async function rolloutViaLsof(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("lsof", ["-a", "-p", String(pid), "-Fn"]);
    return rolloutPathFromLsof(stdout);
  } catch {
    return undefined;
  }
}

/** Pure: the session_meta `payload.cwd` from a rollout HEAD (its first line — verified live:
 *  `{"timestamp":…,"type":"session_meta","payload":{…,"cwd":"/Users/…",…}}`). Undefined when the head
 *  carries no parseable session_meta (byte-sliced/corrupt lines are skipped, like every tail scanner). */
export function rolloutMetaCwd(head: string): string | undefined {
  for (const line of head.split("\n")) {
    if (!line.includes("session_meta")) continue; // cheap pre-filter
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.type !== "session_meta") continue;
    const cwd = (r.payload as Record<string, unknown> | undefined)?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return undefined;
}

/** Bounds for the cwd+recency fallback scan: only the most recent day-directories are visited and at
 *  most this many rollout heads are read, so a months-deep sessions tree costs a handful of small,
 *  bounded reads per probe. A TUI idle longer than the day window classifies idle anyway (the default). */
const ROLLOUT_SCAN_MAX_DAYS = 10;
const ROLLOUT_SCAN_MAX_HEADS = 40;
/** How much of a candidate rollout's head the cwd matcher reads. session_meta is the FIRST line, but
 *  it embeds the session's whole base_instructions — measured up to ~41 KB on live 0.144 rollouts — so
 *  a small head read truncates the line and the parse fails. 64 KB covers it with headroom while
 *  staying a bounded, one-shot read (half of TITLE_SCAN_BYTES). */
const ROLLOUT_META_HEAD_BYTES = 64 * 1024;

/** Numeric child directories of `path`, newest-first (the sessions tree is `YYYY/MM/DD`). */
async function listNumericDirsDesc(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).filter((n) => /^\d+$/.test(n)).sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

/** FALLBACK rollout locator: the most recently WRITTEN rollout under `$CODEX_HOME/sessions/YYYY/MM/DD`
 *  whose session_meta cwd matches the TUI's cwd. Recency is mtime (not the filename's start stamp), so
 *  a resumed/stolen session that's still being appended to — e.g. a ChatGPT-desktop resume of the TUI's
 *  thread — outranks a long-dead sibling in the same cwd. Bounded (see the scan caps); best-effort:
 *  any fs failure just yields undefined → the probe classifies idle. */
export async function codexNewestRolloutForCwd(cwd: string, home: string = codexHome()): Promise<string | undefined> {
  const sessions = join(home, "sessions");
  const candidates: { path: string; mtime: number }[] = [];
  let days = 0;
  outer:
  for (const y of await listNumericDirsDesc(sessions)) {
    for (const m of await listNumericDirsDesc(join(sessions, y))) {
      for (const d of await listNumericDirsDesc(join(sessions, y, m))) {
        const dir = join(sessions, y, m, d);
        let names: string[];
        try { names = await readdir(dir); } catch { continue; }
        for (const n of names) {
          if (!n.startsWith("rollout-") || !n.endsWith(".jsonl")) continue;
          const path = join(dir, n);
          try { candidates.push({ path, mtime: (await stat(path)).mtimeMs }); } catch { /* raced away */ }
        }
        if (++days >= ROLLOUT_SCAN_MAX_DAYS) break outer;
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates.slice(0, ROLLOUT_SCAN_MAX_HEADS)) {
    try {
      if (rolloutMetaCwd(await readPrefix(c.path, ROLLOUT_META_HEAD_BYTES)) === cwd) return c.path;
    } catch { /* unreadable → skip */ }
  }
  return undefined;
}

/** Injectable seams for the pid turn-state probe, so it's testable without real lsof/fs. */
export interface CodexTurnProbeDeps {
  rolloutOf?: (pid: number) => Promise<string | undefined>;
  cwdOf?: (pid: number) => Promise<string | undefined>;
  rolloutForCwd?: (cwd: string) => Promise<string | undefined>;
  readTail?: (path: string, maxBytes: number) => Promise<string>;
  mtimeOf?: (path: string) => Promise<number>;
  now?: () => number;
}

/** Whether the codex TUI `pid` has a turn genuinely in flight. The rollout is located by the open-fd
 *  match first (exact, but the fd is only held around writes), else by cwd+recency (see
 *  codexNewestRolloutForCwd), then its tail is classified. No locatable/readable rollout → false
 *  (idle): we cannot PROVE a turn is open, and the idle-biased default is the safe one (see the
 *  section note). Never throws across its boundary. */
export async function codexPidTurnActive(pid: number, deps: CodexTurnProbeDeps = {}): Promise<boolean> {
  try {
    let rollout = await (deps.rolloutOf ?? rolloutViaLsof)(pid);
    if (!rollout) {
      const cwd = await (deps.cwdOf ?? cwdViaLsof)(pid);
      if (cwd) rollout = await (deps.rolloutForCwd ?? codexNewestRolloutForCwd)(cwd);
    }
    if (!rollout) return false;
    const tail = await (deps.readTail ?? readSuffix)(rollout, TURN_STATE_TAIL_BYTES);
    const mtime = await (deps.mtimeOf ?? (async (p: string) => (await stat(p)).mtimeMs))(rollout);
    return codexTurnActiveFromTail(tail, (deps.now ?? Date.now)() - mtime);
  } catch {
    return false; // unreadable rollout / raced deletion → can't prove a turn is open → idle
  }
}

// --- Live session discovery (the seam that closes the Codex "late session" gap) --------------
//
// Codex fires NO hook at session OPEN — its SessionStart fires only at the FIRST prompt
// (openai/codex#15269) — so a freshly-opened Codex TUI is invisible to the phone for 30 s+. The
// shared watchdog closes this by asking each adapter to discover live sessions the hooks can't see
// yet (adapter.discoverLive) and surfacing a PROVISIONAL session for each, reconciled away once the
// real hook finally fires. Claude needs none of this (its SessionStart fires at true open).

/** A live session found by process-scan that no hook has reported yet (see AgentAdapter.discoverLive).
 *  The watchdog turns each into a provisional op:start + a provisional session record, then reconciles
 *  it away when the real hook arrives (or reaps it when the process dies). */
export interface DiscoveredSession {
  /** The discovered process — the interactive agent TUI. Stored on the provisional record so the
   *  watchdog reaps the provisional when this pid dies and the hook reconcile can match it. */
  pid: number;
  /** The sentinel session id for the provisional (agent-specific; e.g. codex `codex-pid-<pid>`). */
  sessionId: string;
  /** Display title for the provisional blob — the cwd basename, since no real prompt exists yet. */
  title?: string;
  /** cwd-basename label, exactly like buildBlob's `label`. */
  label: string;
  /** True when the TUI has NO turn in flight (an idle REPL at its prompt — see codexTurnActiveFromTail).
   *  The watchdog then advertises the provisional as done/idle instead of "working", so an idle TUI can
   *  never sit "Running" on the phone forever. Absent/false → a turn is open → working. */
  idle?: boolean;
}

// --- Codex live-process discovery ------------------------------------------------------------
//
// REMOVABLE once openai/codex#15269 (SessionStart at TRUE session open) ships — at that point the
// hook itself sees a freshly-opened Codex TUI and this whole process-scan becomes dead weight.
//
// A live interactive Codex CLI is the `codex` executable running with a controlling tty. That tty is
// the load-bearing filter: the `codex app-server` daemons spawned by the Codex.app desktop app and by
// editor extensions run with NO controlling tty ("??"), so requiring a real tty excludes them while
// keeping the real terminal sessions. `codex exec …` (non-interactive automation) is excluded by argv,
// and any pid we already track (a real hook already fired, or a provisional already exists) is skipped.

/** REMOVABLE (see above). The sentinel session id for a provisional codex session. The worker accepts
 *  ANY 1–128-char sessionId (no UUID required — server parseCCEnvelope only length-checks), so this
 *  readable form is valid as-is and needs no UUID-shaped encoding. */
export function codexSentinelSessionId(pid: number): string {
  return `codex-pid-${pid}`;
}

/** REMOVABLE (see above). Parse `ps -axo pid=,tty=,args=` output into rows. Pure. Lines that don't
 *  start with a pid (blank / header-less noise) are skipped. */
export function parseCodexProcs(psOutput: string): { pid: number; tty: string; args: string }[] {
  const rows: { pid: number; tty: string; args: string }[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number.parseInt(m[1], 10);
    if (!Number.isFinite(pid)) continue;
    rows.push({ pid, tty: m[2], args: m[3] });
  }
  return rows;
}

/** A real controlling tty, i.e. an interactive terminal. macOS `ps` prints "??" for a process with no
 *  controlling terminal (the Codex.app / extension `codex app-server` daemons); "?"/"-" cover other
 *  no-tty spellings defensively. */
function isRealTty(tty: string): boolean {
  return tty.length > 0 && tty !== "??" && tty !== "?" && tty !== "-";
}

/** REMOVABLE (see above). Keep only interactive codex TUIs not already tracked: executable basename
 *  `codex`, a REAL controlling tty (excludes the tty-less `codex app-server` daemons), and NOT a
 *  `codex exec` automation run. Pure — the pid set and rows are injected. */
export function filterCodexTuis(
  rows: { pid: number; tty: string; args: string }[], knownPids: Set<number>,
): { pid: number }[] {
  const out: { pid: number }[] = [];
  for (const r of rows) {
    if (knownPids.has(r.pid)) continue;
    const tokens = r.args.trim().split(/\s+/);
    if (basename(tokens[0] ?? "") !== "codex") continue; // executable basename must be `codex`
    if (!isRealTty(r.tty)) continue;                       // interactive terminal only
    if (tokens.slice(1).includes("exec")) continue;        // exclude `codex exec …` automation
    out.push({ pid: r.pid });
  }
  return out;
}

/** cwd basename → the provisional's label/title, exactly like buildBlob's cwd-basename `label`
 *  ("session" when the cwd is unknown or the filesystem root). */
function labelFromCwd(cwd: string | undefined): string {
  if (!cwd) return "session";
  const b = basename(cwd);
  return b.length > 0 ? b : "session";
}

/** REMOVABLE (see above). `ps -axo pid=,tty=,args=` for the whole process table. */
async function runPs(): Promise<string> {
  const { stdout } = await execFileP("ps", ["-axo", "pid=,tty=,args="]);
  return stdout;
}

/** REMOVABLE (see above). The cwd of a pid via `lsof -a -p <pid> -d cwd -Fn` — the output's `n` line
 *  carries the path. Undefined on any failure (permissions, race, no lsof). */
async function cwdViaLsof(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    for (const line of stdout.split("\n")) if (line.startsWith("n")) return line.slice(1);
    return undefined;
  } catch {
    return undefined;
  }
}

/** Injectable process-scan seams so discovery is testable without spawning real `ps`/`lsof`. */
export interface CodexDiscoverDeps {
  ps?: () => Promise<string>;
  cwdOf?: (pid: number) => Promise<string | undefined>;
  /** Turn-state probe (see codexPidTurnActive) — decides each discovery's `idle` flag. */
  turnActive?: (pid: number) => Promise<boolean>;
}

/** REMOVABLE (see above). Discover interactive Codex TUIs the hooks can't see yet (openai/codex#15269).
 *  Scans `ps`, filters to real terminal `codex` sessions not already tracked, and resolves each cwd to
 *  a sentinel provisional session. Each discovery carries an `idle` verdict from the pid's rollout tail
 *  (codexPidTurnActive) so the watchdog advertises an idle REPL as done, not "working". Best-effort: a
 *  `ps` failure yields no discoveries; a turn-probe failure yields idle (the bug-safe default). */
export async function codexDiscoverLive(known: SessionRecord[], deps: CodexDiscoverDeps = {}): Promise<DiscoveredSession[]> {
  const ps = deps.ps ?? runPs;
  const cwdOf = deps.cwdOf ?? cwdViaLsof;
  const turnActive = deps.turnActive ?? codexPidTurnActive;
  let output: string;
  try {
    output = await ps();
  } catch {
    return []; // no ps / scan failed → surface nothing
  }
  const knownPids = new Set(known.map((r) => r.pid).filter((p): p is number => typeof p === "number" && Number.isFinite(p)));
  const tuis = filterCodexTuis(parseCodexProcs(output), knownPids);
  const out: DiscoveredSession[] = [];
  for (const { pid } of tuis) {
    const label = labelFromCwd(await cwdOf(pid));
    // Idle unless a turn is PROVABLY open — a probe failure must never resurrect the stuck-"Running"
    // ghost this flag exists to kill (misread-active self-corrects via the next real hook; misread-idle
    // never would).
    let active = false;
    try { active = await turnActive(pid); } catch { /* idle-biased default */ }
    // title == label (cwd basename): a freshly-opened TUI has no prompt yet, so the cwd names it.
    out.push({ pid, sessionId: codexSentinelSessionId(pid), title: label, label, idle: !active });
  }
  return out;
}

// --- Codex child-session ghost detection (ChatGPT.app `codex app-server`) ---------------------
//
// Codex ≥0.144 driven by the ChatGPT desktop app (`codex app-server`, tty-less, cwd=$HOME) opens a
// fresh rollout/thread UUID per sub-task AND spawns CHILD session ids that have NO rollout file and
// an EMPTY transcript (observed 2026-07-10: a record with transcript:"" sharing its pid with the real
// session it belongs to). The hook takes input.session_id verbatim, so each child UUID would become a
// brand-new phone row — a ghost that never gets a prompt, a title, or an end. The fingerprint is
// unambiguous: a session id we've NEVER tracked, whose transcript is empty/nonexistent, arriving from
// a pid that ALREADY has a real (non-provisional) codex session tracked. A REAL first session from an
// app-server has a rollout (non-empty prefix), so it is never skipped; a provisional record doesn't
// count as "real" so a discovery sentinel can never suppress the genuine first hook.

/** The tracked-session fields the ghost check needs (a thin projection of SessionRecord + its id). */
export interface TrackedSessionLite {
  sessionId: string;
  pid?: number;
  provisional?: boolean;
  agent?: AgentKind;
}

/** Pure classifier: is this hook event a codex CHILD-session ghost (skip it — no phone row)?
 *  True iff the transcript prefix is empty (no rollout content) AND some OTHER, non-provisional,
 *  codex-tracked session already owns the same pid. See the section note for the fingerprint. */
export function codexChildSessionGhost(
  sessionId: string, transcriptPrefix: string, hookPid: number, tracked: TrackedSessionLite[],
): boolean {
  if (transcriptPrefix.trim().length > 0) return false; // a real rollout exists → a real session
  return tracked.some((t) =>
    t.sessionId !== sessionId && t.provisional !== true && t.agent === "codex" &&
    typeof t.pid === "number" && Number.isFinite(t.pid) && t.pid === hookPid);
}

// --- Codex top-level internal-job ghost detection (ChatGPT.app `codex app-server`) ------------
//
// The child-session net above keys on the hook's pid ALREADY owning a tracked real codex session —
// but ChatGPT.app's background `codex app-server` (tty-less, cwd=$HOME or a project dir) also runs
// TOP-LEVEL internal jobs whose pid owns nothing (observed 2026-07-10: session
// 019f4a6a-88ad-7ed3-8f0a-cdfcc32ff98f, ChatGPT's own "Generate 0 to 3 hyperpersonalized
// suggestions…" prompt, model gpt-5.4, EMPTY transcript, NO rollout under ~/.codex/sessions/). Those
// leak straight past codexChildSessionGhost and become phantom phone rows that never get a real
// title, a turn, or an end. The prompt text is deliberately NOT matched (ChatGPT's internal prompts
// are unversioned strings that can change any release) — the fingerprint is structural, the ROLLOUT:
// codex writes a real session's rollout (session_meta first line) essentially at session CREATION,
// before any hook can fire for it (SessionStart itself only fires at the first prompt,
// openai/codex#15269), so by the time a hook arrives for a REAL session there is rollout evidence —
// content in the transcript prefix, or at least the rollout file on disk. An internal job has
// neither, ever.
//
// The guard is therefore a DEFER, not a hard verdict: skip mirroring while there is NO rollout
// evidence (empty/absent transcript AND no rollout file for the id). A real session racing its first
// flush (never observed, but conceivable) merely loses its first frame — hooks fire many times per
// turn, and the next one finds the rollout and mirrors the session. A phantom row, by contrast,
// would stick forever: no later hook ever corrects an internal job.

/** Whether ANY rollout file for `sessionId` exists under `$CODEX_HOME/sessions/YYYY/MM/DD`. Codex
 *  embeds the session uuid in the rollout filename (`rollout-<started-at>-<uuid>.jsonl` — the same
 *  layout sessionMatch/codexNewestRolloutForCwd rely on), so this is a filename-only scan — zero
 *  file reads — over the newest ROLLOUT_SCAN_MAX_DAYS day-directories. The only caller gates on a
 *  NEVER-tracked id whose transcript is empty, i.e. a session at most minutes old, so the bounded
 *  day window always covers a real one. Best-effort: unreadable directories are skipped (→ no
 *  evidence), like the cwd locator above. */
export async function codexRolloutExistsForSession(sessionId: string, home: string = codexHome()): Promise<boolean> {
  if (sessionId.length === 0) return false;
  const sessions = join(home, "sessions");
  let days = 0;
  for (const y of await listNumericDirsDesc(sessions)) {
    for (const m of await listNumericDirsDesc(join(sessions, y))) {
      for (const d of await listNumericDirsDesc(join(sessions, y, m))) {
        let names: string[];
        try { names = await readdir(join(sessions, y, m, d)); } catch { names = []; }
        if (names.some((n) => n.startsWith("rollout-") && n.endsWith(".jsonl") && n.includes(sessionId))) return true;
        if (++days >= ROLLOUT_SCAN_MAX_DAYS) return false;
      }
    }
  }
  return false;
}

/** Injectable seams for the internal-job ghost check, so the decision matrix is testable without a
 *  real filesystem (the CodexTurnProbeDeps pattern). */
export interface CodexInternalGhostDeps {
  /** stat-like existence probe for the hook's own transcript_path (resolves → the file exists). */
  statOf?: (path: string) => Promise<unknown>;
  /** Rollout-existence locator (see codexRolloutExistsForSession). */
  rolloutExists?: (sessionId: string) => Promise<boolean>;
}

/** Whether a NEVER-tracked codex hook event is a TOP-LEVEL app-server internal job — skip it (defer
 *  mirroring until rollout evidence appears; see the section note). True iff the transcript prefix
 *  is empty AND the hook's transcript_path doesn't exist on disk AND no rollout file exists for the
 *  id. Evidence checks run cheapest-first (the already-read prefix, one stat, then the bounded
 *  filename scan), and any POSITIVE evidence mirrors immediately; a failing probe counts as "no
 *  evidence yet" — the defer self-heals on the session's next hook, whereas mirroring on a broken
 *  probe would mint the very phantom row this guard exists to kill. Never throws. */
export async function codexInternalSessionGhost(
  sessionId: string, transcriptPrefix: string, transcriptPath: string, deps: CodexInternalGhostDeps = {},
): Promise<boolean> {
  if (transcriptPrefix.trim().length > 0) return false; // rollout content → a real session
  if (transcriptPath.length > 0) {
    // The rollout file exists even though its content hasn't flushed into the prefix yet (or the
    // read raced) — codex created it, so the session is real.
    try { await (deps.statOf ?? stat)(transcriptPath); return false; } catch { /* no file at the path */ }
  }
  try {
    return !(await (deps.rolloutExists ?? codexRolloutExistsForSession)(sessionId));
  } catch {
    return true; // locator failed → still no evidence of a real session → defer (self-heals)
  }
}

/** Match a codex hook to a provisional record by pid, returning the provisional's sentinel sessionId (or
 *  null). PRIMARY match is EQUALITY: the codex hook's `process.ppid` IS the codex TUI process — codex
 *  spawns the hook directly and run.sh `exec`s the runtime (same pid, parent unchanged), the very
 *  process.ppid == TUI-pid relationship the Claude reaper already relies on in production — so it equals
 *  the discovered/provisional pid. `ancestorsOf` is a belt-and-suspenders: were a future wrapper process
 *  to sit between codex and the hook, the provisional's pid would be an ANCESTOR of the hook pid, so we
 *  also match any provisional whose pid appears in the hook pid's ancestor chain (walked only if the
 *  cheap equality pass found nothing). Pure — the ancestor walk is injected. */
export function findProvisionalForPid(
  provisionals: { sessionId: string; pid: number }[],
  hookPid: number,
  ancestorsOf: (pid: number) => number[],
): string | null {
  for (const p of provisionals) if (p.pid === hookPid) return p.sessionId; // common case: direct parent
  const chain = new Set(ancestorsOf(hookPid));
  for (const p of provisionals) if (chain.has(p.pid)) return p.sessionId;
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
   *  Async because the codex path reads the session_index and the claude path reads a bounded
   *  transcript TAIL — on a long session the freshest ai-title lives near the END, outside the head
   *  window, so `transcriptPath` rides alongside the memoized head `prefix` for that one readSuffix,
   *  exactly like the model seam below (optional: absent/"" → head-only, for callers with no
   *  transcript on disk). Undefined → no title yet. */
  title(ctx: { sessionId: string; prefix: string; input: Record<string, unknown>; transcriptPath?: string }): Promise<string | undefined>;
  /** OPTIONAL: resolve the session's raw model id (e.g. "claude-fable-5", "gpt-5-codex") for the
   *  blob's OPTIONAL `model` field. Undefined → unknown → the blob OMITS the key (never an empty
   *  string) and the phone hides its badge. Claude reads the transcript's assistant lines (its hook
   *  stdin has no model field); Codex reads the hook payload's own `model` with rollout/config.toml
   *  fallbacks — see claudeSessionModel / codexSessionModel. `transcriptPath` rides alongside the
   *  memoized head `prefix` because the freshest model sits at the transcript TAIL (one bounded
   *  readSuffix), which the title seam never needed. */
  model?(ctx: { sessionId: string; prefix: string; input: Record<string, unknown>; transcriptPath: string }): Promise<string | undefined>;
  /** Whether the transcript tail shows the last turn was interrupted (the two detections differ). */
  detectInterrupt(tail: string): boolean;
  /** OPTIONAL: whether the transcript tail shows a PENDING approval — a tool/patch the session is
   *  blocked on the user approving. Claude OMITS it (its PermissionRequest + Notification channels are
   *  reliable); Codex implements it as the watchdog's backstop for a DROPPED PermissionRequest hook
   *  (openai/codex#16430) — Codex has no upstream Notification event, so a dropped hook otherwise leaves
   *  the phone unaware the session is blocked. See codexTailPendingApproval for the classifier + the
   *  rollout-persistence caveat. Present → the watchdog runs it each sweep on a not-already-attention
   *  session and posts a corrective needsAttention. */
  tailShowsPendingApproval?(tail: string): boolean;
  /** OPTIONAL: whether a hook event for a NEVER-tracked session id is a CHILD-SESSION GHOST that must
   *  be skipped (no phone row). Claude OMITS it (every Claude session id is real); Codex implements it
   *  because the ChatGPT.app `codex app-server` spawns child session ids with no rollout/transcript
   *  that share their pid with the real session (see codexChildSessionGhost). Called by runHook only
   *  when NO session record exists yet for the id. */
  isChildSessionGhost?(ctx: { sessionId: string; prefix: string; hookPid: number; tracked: TrackedSessionLite[] }): boolean;
  /** OPTIONAL: whether a hook event for a NEVER-tracked session id is a TOP-LEVEL app-server
   *  INTERNAL JOB that must be skipped (deferred) — no transcript content, no transcript file, no
   *  rollout for the id (see codexInternalSessionGhost). Complements isChildSessionGhost, which only
   *  nets child ids on an already-tracked pid; ChatGPT.app's internal jobs (e.g. its
   *  "hyperpersonalized suggestions" generator) are top-level, so the pid net can't see them. Claude
   *  OMITS it (every Claude session id is real). Async because it probes the sessions tree. Called by
   *  runHook only when NO session record exists yet, so a live session can never be silenced by it. */
  isInternalSessionGhost?(ctx: { sessionId: string; prefix: string; transcriptPath: string }): Promise<boolean>;
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
  /** The extra fields this agent stamps into an encrypted blob to identify itself — spread into the
   *  blob object so the watchdog's corrective/heartbeat/discovery POSTs carry the same `agent` key the
   *  hook would. Claude yields `{}` (byte-identical to the pre-codex blob); Codex yields
   *  `{ agent: "codex" }`. Replaces the watchdog's old inline `agent === "codex" ? …` ternary so no
   *  per-agent branch remains in the agent-agnostic daemon. Typed as `{ agent?: AgentKind }` so it
   *  spreads cleanly into both a blob object and a SessionRecord (whose `agent` follows the same
   *  omit-for-claude convention). */
  blobAgentFields: { agent?: AgentKind };
  /** OPTIONAL: discover live sessions the hooks can't see yet — interactive TUIs for which NO
   *  SessionStart has fired. Called on every watchdog sweep with the already-tracked sessions (so their
   *  pids can be excluded). Claude OMITS it (its SessionStart fires at true session open, so there's
   *  nothing to discover); Codex implements it because its SessionStart fires only at the FIRST prompt
   *  (openai/codex#15269), leaving a freshly-opened TUI invisible for 30 s+. Returns the provisional
   *  sessions to surface immediately; the watchdog POSTs an op:start + writes a provisional record for
   *  each, and the hook (or a sweep backstop) reconciles them away once the real hook fires. */
  discoverLive?(known: SessionRecord[]): Promise<DiscoveredSession[]>;
  /** OPTIONAL: whether the given live TUI pid has a turn genuinely in flight (see codexPidTurnActive).
   *  Claude OMITS it (no discovery → no provisional rows to keep honest); Codex implements it so the
   *  watchdog can (a) flag an idle discovery as done instead of "working" and (b) correct an existing
   *  provisional "working" row to done once its TUI goes idle. Must never throw. */
  pidTurnActive?(pid: number): Promise<boolean>;
}

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  async title({ prefix, input, transcriptPath }): Promise<string | undefined> {
    // Freshest ai-title from the transcript TAIL, else the head's ai-title / first user prompt —
    // on a long session CC's newest ai-title sits near EOF, outside the head window entirely (see
    // claudeSessionTitle). Preference: aiTitle(tail) ?? aiTitle(head) ?? firstUserPrompt(head).
    const fromTranscript = await claudeSessionTitle(prefix, transcriptPath ?? "");
    if (fromTranscript) return fromTranscript;
    // FALLBACK (mirrors the codex adapter): a first prompt so large its transcript line alone
    // overflows the head window (observed live: a 510 KB opening line — JSON.parse fails on the
    // byte-sliced fragment) leaves every transcript scanner empty at turn 1. But the UserPromptSubmit
    // hook carries the raw prompt itself — clean it through the SAME gauntlet the transcript
    // first-prompt scanner uses, so command noise is rejected identically.
    if (typeof input.prompt === "string" && input.prompt.length > 0) {
      const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
      if (hookName === "UserPromptSubmit") return displayTitleFromUserText(input.prompt);
    }
    return undefined;
  },
  // Claude's hook stdin carries no model field — the transcript's assistant lines do. Last assistant
  // line in a bounded tail (tracks /model switches) → first in the head prefix → undefined.
  model({ prefix, transcriptPath }): Promise<string | undefined> {
    return claudeSessionModel(prefix, transcriptPath);
  },
  detectInterrupt(tail: string): boolean {
    const line = lastTurnLine(tail);
    return line !== null && hasInterruptMarker(line);
  },
  // Backstop for a DROPPED PreToolUse hook (the primary instant-attention path is hook.ts planOp's
  // PreToolUse → needsAttention for AskUserQuestion / ExitPlanMode): re-raise needsAttention when the
  // transcript tail shows Claude parked on a user-blocking tool with no answer yet. See
  // claudeTailPendingApproval. Converts a missed hook into ≤~5-10 s of delay instead of ~5 min.
  tailShowsPendingApproval(tail: string): boolean {
    return claudeTailPendingApproval(tail);
  },
  sessionsDir: () => `${process.env.HOME}/.claude/projects`,
  sessionMatch: (name: string) => name.endsWith(".jsonl"),
  hookStampPath: () => lastHookPath("claude"),
  hooksNotFiringHint: "  Reinstall the plugin / check /plugin.",
  toolDetail: claudeToolDetail,
  // Claude blobs OMIT the agent key (byte-identical to the pre-codex blob), so this is empty.
  blobAgentFields: {},
  // No discoverLive: Claude's SessionStart fires at true session open, so the hooks already see every
  // session — there is nothing for the watchdog to discover ahead of them.
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
  // Codex stamps a top-level `model` on its per-turn hook payloads (primary); rollout turn_context →
  // config.toml default are the fallbacks. See codexSessionModel for the authority order.
  model({ input, prefix, transcriptPath }): Promise<string | undefined> {
    return codexSessionModel(input, prefix, transcriptPath);
  },
  detectInterrupt(tail: string): boolean {
    return codexLastTurnEvent(tail) === CODEX_ABORT_EVENT;
  },
  // Backstop for a dropped Codex PermissionRequest hook (openai/codex#16430): re-raise needsAttention
  // when the rollout tail shows a pending approval. Claude omits this (reliable hook channels).
  tailShowsPendingApproval(tail: string): boolean {
    return codexTailPendingApproval(tail);
  },
  // ChatGPT.app `codex app-server` child-session ghosts: a new session id with no rollout content,
  // sharing its pid with an already-tracked real codex session, is skipped (see codexChildSessionGhost).
  isChildSessionGhost({ sessionId, prefix, hookPid, tracked }): boolean {
    return codexChildSessionGhost(sessionId, prefix, hookPid, tracked);
  },
  // ChatGPT.app `codex app-server` TOP-LEVEL internal jobs (its own background prompts — no rollout
  // is ever written for them): a never-tracked id with no transcript content, no transcript file, and
  // no rollout for the id is deferred — a real session always has rollout evidence by the time a hook
  // fires (see codexInternalSessionGhost).
  isInternalSessionGhost({ sessionId, prefix, transcriptPath }): Promise<boolean> {
    return codexInternalSessionGhost(sessionId, prefix, transcriptPath);
  },
  sessionsDir: () => `${codexHome()}/sessions`,
  sessionMatch: (name: string) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
  hookStampPath: () => lastHookPath("codex"),
  hooksNotFiringHint: "  Run /hooks in Codex to re-trust, or reinstall the plugin — known upstream bugs #16430/#30835.",
  toolDetail: codexToolDetail,
  // Codex blobs carry `agent:"codex"` so the phone tabs/icons the session correctly.
  blobAgentFields: { agent: "codex" as const },
  // Codex fires no hook at session open (openai/codex#15269), so the watchdog process-scans for live
  // Codex TUIs and surfaces them provisionally. REMOVABLE once that issue ships (see codexDiscoverLive).
  discoverLive: (known: SessionRecord[]): Promise<DiscoveredSession[]> => codexDiscoverLive(known),
  // The turn-state probe behind the idle-TUI fix: discovery flags idle REPLs, and the watchdog's
  // idle-provisional corrective flips a stale "working" provisional to done. REMOVABLE with discovery.
  pidTurnActive: (pid: number): Promise<boolean> => codexPidTurnActive(pid),
};

/** Select the concrete adapter for an agent kind. */
export function adapterFor(agent: AgentKind): AgentAdapter {
  return agent === "codex" ? codexAdapter : claudeAdapter;
}

/** Every concrete adapter, so the agent-agnostic watchdog can drive its generic per-agent steps
 *  (e.g. discovery) across all agents without an inline `agent === …` branch. */
export const allAdapters: AgentAdapter[] = [claudeAdapter, codexAdapter];
