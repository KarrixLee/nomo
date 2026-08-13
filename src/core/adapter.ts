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
import { AgentKind, codexHome, folderKeyFromCwd, isRealTty, lastHookPath, pidAlive, pidAncestors, pidCommand, readPrefix, readSuffix, SessionRecord } from "./shared";
import { ancestryContainsHerdr } from "./terminal-focus";

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

/** Maximum encrypted one-line question preview carried as the generic session `detail`. The full
 *  request remains in Codex; this is only enough context for the phone row to say what it needs. */
const USER_INPUT_DETAIL_MAX = 240;

/** Extract the first human-facing Codex `request_user_input` question from either the hook's parsed
 *  `tool_input` object or the rollout's JSON-string `arguments`. The tool is EXPERIMENT-GATED, not
 *  mode-gated: the 0.145.0 binary carries `tools.experimental_request_user_input` plus a
 *  `default_mode_request_user_input` feature flag, so it can be enabled in DEFAULT mode as well as in
 *  Plan collaboration mode. What we rely on is narrower and does hold either way: WHEN the call appears,
 *  the session is genuinely blocked on the user, and the hook/rollout contracts expose it — so it is a
 *  sound blocked-state signal, not a complete one (a build with the experiment off simply never emits it,
 *  and this path stays dormant). This helper remains display-only; the separate app-server bridge owns
 *  validated answers and turn interruption. */
export function requestUserInputDetail(toolInput: unknown): string | undefined {
  let parsed = toolInput;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return undefined; }
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const questions = (parsed as Record<string, unknown>).questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const first = questions[0];
  if (typeof first !== "object" || first === null) return undefined;
  const q = first as Record<string, unknown>;
  const question = typeof q.question === "string" ? q.question.replace(/\s+/g, " ").trim() : "";
  if (!question) return undefined;
  const header = typeof q.header === "string" ? q.header.replace(/\s+/g, " ").trim() : "";
  const text = header && !question.toLowerCase().startsWith(`${header.toLowerCase()}:`)
    ? `${header}: ${question}`
    : question;
  const characters = Array.from(text);
  return characters.length <= USER_INPUT_DETAIL_MAX
    ? text
    : `${characters.slice(0, USER_INPUT_DETAIL_MAX - 1).join("")}…`;
}

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

// --- Codex TUI plan-picker detection ----------------------------------------------------------
//
// Codex's client-side "Implement this plan?" picker emits no hook and no durable approval event.
// The rollout DOES retain a precise turn-end fingerprint: the final assistant message is wrapped in
// `<proposed_plan>...</proposed_plan>`, then task_complete closes the turn. While the picker is open,
// no later task_started/user_message exists. Requiring the complete wrapper (rather than guessing from
// ordinary prose that mentions a plan) keeps this intentionally precision-biased: a normal completed
// turn must never be held in needsAttention merely because its TUI remains open at the prompt.

export type CodexPlanPickerState = "pending" | "incomplete" | "resolved" | "none" | "exited" | "unknown";
export interface CodexPlanPickerEvidence {
  state: CodexPlanPickerState;
  /** Inner markdown from the exact final <proposed_plan> wrapper. Present only while pending. */
  plan?: string;
}

/** Exact Plan-mode final-answer wrapper. The watchdog verification marker is armed when this durable
 *  message exists before the rollout has appended its trailing task_complete. */
export function codexProposedPlanText(text: unknown): boolean {
  return codexProposedPlanMarkdown(text) !== undefined;
}

/** Extract the wrapper's inner markdown. Trimming is limited to the wrapper boundary so the phone
 *  receives markdown content, never the protocol tags themselves. */
export function codexProposedPlanMarkdown(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  const open = "<proposed_plan>";
  const close = "</proposed_plan>";
  if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) return undefined;
  return trimmed.slice(open.length, -close.length).trim();
}

/** Whether an assistant payload is the durable FINAL plan emitted by Codex Plan mode. Supports both
 *  rollout forms seen across Codex versions: response_item message content and event_msg agent_message.
 *  The exact full wrapper is load-bearing for precision. */
function codexFinalProposedPlan(row: Record<string, unknown>): string | undefined {
  const payload = row.payload as Record<string, unknown> | undefined;
  if (!payload || payload.phase !== "final_answer") return undefined;
  let text = "";
  if (row.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
    const content = payload.content;
    if (!Array.isArray(content)) return undefined;
    text = content.map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const p = part as Record<string, unknown>;
      return p.type === "output_text" && typeof p.text === "string" ? p.text : "";
    }).join("");
  } else if (row.type === "event_msg" && payload.type === "agent_message") {
    text = typeof payload.message === "string" ? payload.message : "";
  } else {
    return undefined;
  }
  return codexProposedPlanMarkdown(text);
}

/** Classify the plan-picker episode visible in a bounded rollout tail.
 *
 *  pending  — an exact final proposed-plan message was followed by task_complete, with no later
 *             task_started/user_message (the client-side picker is still the next action)
 *  resolved — such an episode exists and explicit later turn/user progress proves the Mac answered it
 *  none      — no exact completed-plan episode is present (the overwhelmingly common normal-done case)
 *
 * A later completed plan supersedes an older resolved one, so repeated Plan turns classify correctly.
 * Malformed/byte-sliced lines are skipped, matching the other rollout-tail classifiers. */
interface CodexPlanPickerTailAnalysis {
  state: Extract<CodexPlanPickerState, "pending" | "resolved" | "none">;
  /** Inner markdown for the currently pending completed Plan episode. */
  plan?: string;
  /** Exact final wrapper is durable, but task_complete has not been appended yet. Retry-only signal. */
  incompleteFinalPlan: boolean;
}

function codexPlanPickerTailAnalysis(tail: string): CodexPlanPickerTailAnalysis {
  let state: "pending" | "resolved" | "none" = "none";
  let plan: string | undefined;
  let finalPlanInTurn: string | undefined;
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    if (!line.includes("event_msg") && !line.includes("response_item")) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const finalPlan = codexFinalProposedPlan(r);
    if (finalPlan !== undefined) {
      finalPlanInTurn = finalPlan;
      continue;
    }
    if (r.type !== "event_msg") continue;
    const ptype = (r.payload as Record<string, unknown> | undefined)?.type;
    if (ptype === "task_complete") {
      if (finalPlanInTurn !== undefined) {
        state = "pending";
        plan = finalPlanInTurn;
      }
      finalPlanInTurn = undefined;
    } else if (ptype === "task_started" || ptype === "user_message") {
      if (state === "pending") {
        state = "resolved";
        plan = undefined;
      }
      finalPlanInTurn = undefined;
    } else if (ptype === "turn_aborted") {
      finalPlanInTurn = undefined;
    }
  }
  return { state, ...(state === "pending" && plan !== undefined ? { plan } : {}), incompleteFinalPlan: finalPlanInTurn !== undefined };
}

export function codexPlanPickerStateFromTail(tail: string): Extract<CodexPlanPickerState, "pending" | "resolved" | "none"> {
  return codexPlanPickerTailAnalysis(tail).state;
}

interface CodexPendingUserInput {
  kind: "userInput";
  detail?: string;
}

/** Classify the CURRENT pending Codex `request_user_input`, if any. This mirrors
 *  `codexTailPendingApproval`'s reverse decisive-marker scan so an older question never leaks through a
 *  later result/turn boundary. Unlike the optional question preview, the kind survives malformed or
 *  future arguments: the function-call name alone is enough for the clear-envelope discriminator. */
function codexTailPendingUserInput(tail: string): CodexPendingUserInput | undefined {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!line.includes("event_msg") && !line.includes("response_item")) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const payload = r.payload as Record<string, unknown> | undefined;
    const ptype = typeof payload?.type === "string" ? payload.type : undefined;
    if (!ptype) continue;
    if (r.type === "event_msg") {
      if (CODEX_APPROVAL_REQUEST_EVENTS.has(ptype)) return undefined;
      if (CODEX_APPROVAL_RESOLUTION_EVENTS.has(ptype)) return undefined;
    } else if (r.type === "response_item") {
      if (ptype === "function_call" && payload?.name === CODEX_USER_INPUT_TOOL) {
        const detail = requestUserInputDetail(payload.arguments);
        return { kind: "userInput", ...(detail ? { detail } : {}) };
      }
      if (CODEX_APPROVAL_RESOLUTION_ITEMS.has(ptype)) return undefined;
    }
  }
  return undefined;
}

/** The first-question preview for a CURRENT pending Codex `request_user_input`, when recoverable. */
export function codexTailPendingUserInputDetail(tail: string): string | undefined {
  return codexTailPendingUserInput(tail)?.detail;
}

/** Clear-envelope discriminator for a CURRENT pending Codex `request_user_input`. */
export function codexTailPendingAttentionKind(tail: string): "userInput" | undefined {
  return codexTailPendingUserInput(tail)?.kind;
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

// --- Claude headless/daemon-invocation detection (phantom-row guard) --------------------------
//
// A `claude` that loads plugins but is NOT a human's interactive session — e.g. claude-mem's
// `claude --output-format stream-json …` observation runs, or any tool that shells out to headless
// Claude — fires SessionStart (and usually UserPromptSubmit) under a brand-new session id that NEVER
// gets a Stop. Left unguarded that mints a phantom "working" phone row which only the one-hour worker eviction
// (the watchdog's correctIdleClaude) or the worker's own eviction ever clears. The interactive TUI runs
// with none of these flags, so keying on the INVOKING process's argv (or a known daemon ancestor) is a
// safe DEFER: skip mirroring a never-tracked session whose invoker looks headless. Mirrors the codex
// app-server ghost guards' verdict-vs-defer discipline (see codexInternalSessionGhost) — the seam is
// consulted ONLY for a never-tracked id, so a live interactive session can never be silenced by it.

/** Headless `claude` argv markers matched as WHOLE tokens on the invoking process's own command line:
 *  programmatic output (`--output-format`, e.g. the stream-json runs claude-mem spawns) and
 *  non-interactive print mode (`-p` / `--print`). An interactive human session carries none of these. */
const CLAUDE_HEADLESS_ARG_TOKENS = new Set(["-p", "--print", "--output-format"]);

/** Command-line shapes of the claude BINARY's OWN detached modes: `claude daemon run --origin
 *  transient` and the `--bg-pty-host` / `--bg-spare` ring it self-forks with `pinToCurrentBinary`.
 *  These are real flags of the binary, so the DESKTOP-bundled binary forks the same spare ring under
 *  the same `Claude.app` ancestry — the desktop allow-list below must NEVER rescue them. Matched as
 *  SUBSTRINGS against the invoking process AND its ancestor chain. */
const CLAUDE_SELF_DAEMON_MARKERS = [
  "daemon run --origin transient",
  "bg-pty-host",
  "bg-spare",
];

/** Command-line shapes of THIRD-PARTY launchers that spawn headless Claude (claude-mem's
 *  worker-service). Also substring-matched over the whole chain, because a bundled worker shows up as
 *  an absolute script path rather than a bare token — which means these also match a mere flag VALUE.
 *  The Claude desktop app passes exactly such values (`--plugin-dir …/claude-mem/13.12.4`, and
 *  `--add-dir "<any user folder>"`), which is why the desktop allow-list is consulted BEFORE these.
 *  ponytail: substring match can still hit a flag value on a NON-desktop invoker; the general cure is
 *  a shell-quote-aware argv split, worth writing only if a second false-positive source appears. */
const CLAUDE_LAUNCHER_MARKERS = ["claude-mem", "worker-service"];

/** The two halves of the path the Claude DESKTOP app runs its bundled `claude` from:
 *  `~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude`.
 *  Split around the version segment and anchored on neither `$HOME` nor `/Applications`: this project
 *  has been bitten by version-pinned paths before (the hook shim), and a relocated bundle or a newer
 *  claude-code must classify identically. */
const CLAUDE_DESKTOP_BUNDLED_PATH_PARTS = [
  "/Library/Application Support/Claude/claude-code/",
  "/claude.app/Contents/MacOS/claude",
];

/** The desktop app's launcher, which sits between the Electron main process and the bundled `claude`:
 *  `…/Claude.app/Contents/Helpers/disclaimer <cmd…>`. Location-agnostic on purpose. */
const CLAUDE_DESKTOP_LAUNCHER = "Claude.app/Contents/Helpers/disclaimer";

/** Pure: is this hook's invoking `claude` a conversation window of the Claude DESKTOP app? BOTH
 *  anchors are required — the bundled binary path on the invoker's OWN argv AND the `disclaimer`
 *  launcher somewhere in its ancestry. Either half alone is NOT enough: claude-mem shells out to the
 *  PATH `claude` (so desktop ancestry with a `~/.local/bin/claude` self argv is still an observer
 *  run), and the bundled binary self-forks its detached `--bg-spare` ring with no disclaimer parent. */
export function claudeDesktopInvocation(selfArgs: string | undefined, ancestorArgs: (string | undefined)[]): boolean {
  if (typeof selfArgs !== "string" || selfArgs.length === 0) return false;
  if (!CLAUDE_DESKTOP_BUNDLED_PATH_PARTS.every((part) => selfArgs.includes(part))) return false;
  return ancestorArgs.some((a) => typeof a === "string" && a.includes(CLAUDE_DESKTOP_LAUNCHER));
}

/** Extract the predecessor session id from the precise Claude daemon fork/replay argv shape:
 *  `--fork-session --resume <old-transcript>.jsonl --reply-on-resume`. Requiring BOTH replay flags,
 *  an actual `.jsonl` path, and a UUID-shaped filename keeps this precision-biased — an ordinary
 *  interactive `claude --resume <id>` or user-created fork is not classified by a loose substring.
 *  Quoted paths (including spaces) and `--resume=<path>` are supported. */
export function claudeForkResumePredecessor(command: string | undefined): string | undefined {
  if (typeof command !== "string" || command.length === 0) return undefined;
  const tokens = command.trim().split(/\s+/);
  if (!tokens.includes("--fork-session") || !tokens.includes("--reply-on-resume")) return undefined;
  const match = /(?:^|\s)--resume(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const resume = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!resume || !resume.endsWith(".jsonl")) return undefined;
  const id = basename(resume, ".jsonl");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : undefined;
}

/** Pure: does the invoking `claude`'s own argv, or any ANCESTOR's argv, look like a non-interactive /
 *  daemon-spawned run whose session must NOT become a phone row? `selfArgs` is process.ppid's command
 *  line (the `claude` that ran this hook); `ancestorArgs` are its ancestors' command lines (undefined
 *  entries — a `ps` that failed for that pid — are ignored).
 *
 *  Order matters. The binary's own detached modes are checked FIRST and are unconditional, because the
 *  Claude desktop app's bundled binary self-forks that very spare ring (`--bg-spare`, `--bg-pty-host`,
 *  pinned to the same bundled path under the same `Claude.app` ancestry) — a desktop allow-list ahead
 *  of them would resurrect every one of those phantoms. Only then is the DESKTOP allow-list consulted:
 *  a real desktop conversation window is a human's interactive session and must mirror, yet its argv
 *  trips both remaining branches — it carries `--output-format stream-json` (headless token) and it
 *  passes `--plugin-dir …/claude-mem/<version>` (launcher marker matched inside a flag VALUE). */
export function claudeHeadlessInvocation(selfArgs: string | undefined, ancestorArgs: (string | undefined)[]): boolean {
  const chain = [selfArgs, ...ancestorArgs].filter((s): s is string => typeof s === "string" && s.length > 0);
  if (chain.some((args) => CLAUDE_SELF_DAEMON_MARKERS.some((m) => args.includes(m)))) return true;
  const tokens = typeof selfArgs === "string" ? selfArgs.trim().split(/\s+/) : [];
  // The replay daemon carries neither -p nor --print. The pair is load-bearing: --fork-session alone
  // is a legitimate interactive feature, while --reply-on-resume is the daemon's auto-reply mode.
  if (tokens.includes("--fork-session") && tokens.includes("--reply-on-resume")) return true;
  if (claudeDesktopInvocation(selfArgs, ancestorArgs)) return false;
  if (chain.some((args) => CLAUDE_LAUNCHER_MARKERS.some((m) => args.includes(m)))) return true;
  return tokens.some((tok) => CLAUDE_HEADLESS_ARG_TOKENS.has(tok));
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
/** A final proposed plan is a single JSONL response_item whose text can be substantially larger than
 *  an ordinary turn boundary. Read enough to retain that WHOLE line; a sliced plan line deliberately
 *  fails closed (normal done) rather than guessing. */
const PLAN_PICKER_TAIL_BYTES = 64 * 1024;

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

/** Locate the rollout owned by a Codex TUI. Shared by the ordinary turn-active probe and the
 *  plan-picker probe so both use the exact-open-fd first / cwd+recency fallback contract. */
async function codexRolloutForPid(pid: number, deps: CodexTurnProbeDeps): Promise<string | undefined> {
  let rollout = await (deps.rolloutOf ?? rolloutViaLsof)(pid);
  if (!rollout) {
    const cwd = await (deps.cwdOf ?? cwdViaLsof)(pid);
    if (cwd) rollout = await (deps.rolloutForCwd ?? codexNewestRolloutForCwd)(cwd);
  }
  return rollout;
}

/** Whether the codex TUI `pid` has a turn genuinely in flight. The rollout is located by the open-fd
 *  match first (exact, but the fd is only held around writes), else by cwd+recency (see
 *  codexNewestRolloutForCwd), then its tail is classified. No locatable/readable rollout → false
 *  (idle): we cannot PROVE a turn is open, and the idle-biased default is the safe one (see the
 *  section note). Never throws across its boundary. */
export async function codexPidTurnActive(pid: number, deps: CodexTurnProbeDeps = {}): Promise<boolean> {
  try {
    const rollout = await codexRolloutForPid(pid, deps);
    if (!rollout) return false;
    const tail = await (deps.readTail ?? readSuffix)(rollout, TURN_STATE_TAIL_BYTES);
    const mtime = await (deps.mtimeOf ?? (async (p: string) => (await stat(p)).mtimeMs))(rollout);
    return codexTurnActiveFromTail(tail, (deps.now ?? Date.now)() - mtime);
  } catch {
    return false; // unreadable rollout / raced deletion → can't prove a turn is open → idle
  }
}

/** Extra seam for the plan-picker probe: liveness is part of the proof, not merely a caller
 *  assumption. A dead process can never be waiting on a client-side TUI picker. */
export interface CodexPlanPickerProbeDeps extends CodexTurnProbeDeps {
  isAlive?: (pid: number) => boolean;
}

/** The current client-side plan-picker state for a Codex TUI pid. Reuses the turn-active probe's
 *  rollout locator, but requires continued process liveness before a rollout can classify pending.
 *  `resolved` is returned only for explicit post-plan task_started/user_message evidence; failures are
 *  `unknown`, so the watchdog never clears a pending row on an incidental read/lsof race. */
async function codexPidPlanPickerAnalysis(
  pid: number,
  deps: CodexPlanPickerProbeDeps,
): Promise<CodexPlanPickerEvidence & { incompleteFinalPlan: boolean }> {
  try {
    if (!(deps.isAlive ?? pidAlive)(pid)) return { state: "exited", incompleteFinalPlan: false };
    const rollout = await codexRolloutForPid(pid, deps);
    if (!rollout) return { state: "unknown", incompleteFinalPlan: false };
    const tail = await (deps.readTail ?? readSuffix)(rollout, PLAN_PICKER_TAIL_BYTES);
    const analysis = codexPlanPickerTailAnalysis(tail);
    return {
      state: analysis.incompleteFinalPlan ? "incomplete" : analysis.state,
      ...(!analysis.incompleteFinalPlan && analysis.plan !== undefined ? { plan: analysis.plan } : {}),
      incompleteFinalPlan: analysis.incompleteFinalPlan,
    };
  } catch {
    return { state: "unknown", incompleteFinalPlan: false };
  }
}

export async function codexPidPlanPickerState(pid: number, deps: CodexPlanPickerProbeDeps = {}): Promise<CodexPlanPickerState> {
  return (await codexPidPlanPickerAnalysis(pid, deps)).state;
}

/** State + plan markdown from ONE durable rollout-tail read, so a pending verdict and its displayed
 *  plan can never come from different filesystem snapshots. */
export async function codexPidPlanPickerEvidence(pid: number, deps: CodexPlanPickerProbeDeps = {}): Promise<CodexPlanPickerEvidence> {
  const { state, plan } = await codexPidPlanPickerAnalysis(pid, deps);
  return { state, ...(state === "pending" && plan !== undefined ? { plan } : {}) };
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
  /** Exact TUI cwd, retained locally so a daemon-fronted real session can be correlated only when
   *  cwd + process-start evidence identify one unique real-terminal client. Never enters a blob. */
  cwd?: string;
  /** Epoch-ms process start reported by ps. Together with cwd this is the conservative correlation
   *  key for standalone-daemon hooks whose process.ppid is the immortal app-server, not the TUI. */
  startedAt?: number;
  /** The sentinel session id for the provisional (agent-specific; e.g. codex `codex-pid-<pid>`). */
  sessionId: string;
  /** Display title for the provisional blob — the cwd basename, since no real prompt exists yet. */
  title?: string;
  /** cwd-basename label, exactly like buildBlob's `label`. */
  label: string;
  /** The GROUPING key for that same cwd — `folderKeyFromCwd(cwd)`, derived from the SAME path as
   *  `label` so the pair can never describe two different folders (see shared.ts `folderIdentity`).
   *  The truncated digest is what rides in the blob; the path itself never does (`cwd` above).
   *  Absent when the cwd could not be read — the phone then groups this row by `label`, as it did
   *  before the key existed. */
  folderKey?: string;
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

/** REMOVABLE (see above). The same filter as filterCodexTuis, but each survivor keeps its `tty`.
 *  Discovery only ever needed the pid; the macOS terminal-focus locator needs the tty too (it is the
 *  correlation key between a codex process and the terminal window showing it), so the tty-preserving
 *  form is the primitive and filterCodexTuis is the pid-only projection of it — the existing
 *  `{pid}`-shaped contract (and its tests) is unchanged. Pure — the pid set and rows are injected. */
export function codexTuiCandidates(
  rows: { pid: number; tty: string; args: string }[], knownPids: Set<number>,
): { pid: number; tty: string }[] {
  const out: { pid: number; tty: string }[] = [];
  for (const r of rows) {
    if (knownPids.has(r.pid)) continue;
    const tokens = r.args.trim().split(/\s+/);
    if (basename(tokens[0] ?? "") !== "codex") continue; // executable basename must be `codex`
    if (!isRealTty(r.tty)) continue;                       // interactive terminal only
    if (tokens.slice(1).includes("exec")) continue;        // exclude `codex exec …` automation
    out.push({ pid: r.pid, tty: r.tty });
  }
  return out;
}

/** REMOVABLE (see above). Keep only interactive codex TUIs not already tracked: executable basename
 *  `codex`, a REAL controlling tty (excludes the tty-less `codex app-server` daemons), and NOT a
 *  `codex exec` automation run. Pure — the pid set and rows are injected. */
export function filterCodexTuis(
  rows: { pid: number; tty: string; args: string }[], knownPids: Set<number>,
): { pid: number }[] {
  return codexTuiCandidates(rows, knownPids).map(({ pid }) => ({ pid }));
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
  startedAtOf?: (pid: number) => Promise<number | undefined>;
  /** Turn-state probe (see codexPidTurnActive) — decides each discovery's `idle` flag. */
  turnActive?: (pid: number) => Promise<boolean>;
}

/** REMOVABLE with discovery. Process birth from macOS/BSD `ps lstart`; undefined on locale/probe
 * failure. A missing start time deliberately prevents later TUI/session correlation. */
async function processStartedAtViaPs(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileP("ps", ["-p", String(pid), "-o", "lstart="]);
    const value = Date.parse(stdout.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** REMOVABLE (see above). Discover interactive Codex TUIs the hooks can't see yet (openai/codex#15269).
 *  Scans `ps`, filters to real terminal `codex` sessions not already tracked, and resolves each cwd to
 *  a sentinel provisional session. Each discovery carries an `idle` verdict from the pid's rollout tail
 *  (codexPidTurnActive) so the watchdog advertises an idle REPL as done, not "working". Best-effort: a
 *  `ps` failure yields no discoveries; a turn-probe failure yields idle (the bug-safe default). */
export async function codexDiscoverLive(known: SessionRecord[], deps: CodexDiscoverDeps = {}): Promise<DiscoveredSession[]> {
  const ps = deps.ps ?? runPs;
  const cwdOf = deps.cwdOf ?? cwdViaLsof;
  const startedAtOf = deps.startedAtOf ?? processStartedAtViaPs;
  const turnActive = deps.turnActive ?? codexPidTurnActive;
  let output: string;
  try {
    output = await ps();
  } catch {
    return []; // no ps / scan failed → surface nothing
  }
  // Ordinary records reserve both their hook pid and any correlated TUI. A retired-owner marker is
  // different: a numeric pid alone is not durable identity and may be reused after the old TUI exits.
  // Validate markers against the candidate's process birth below; unknown/newer birth fails open.
  const retiredOwners = known.filter((r) =>
    r.agent === "codex" && typeof r.retiredAt === "number" && Number.isFinite(r.retiredAt));
  const knownPids = new Set(known.filter((r) => !retiredOwners.includes(r)).flatMap((r) => [r.pid, r.tuiPid])
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p)));
  const tuis = filterCodexTuis(parseCodexProcs(output), knownPids);
  const out: DiscoveredSession[] = [];
  for (const { pid } of tuis) {
    const cwd = await cwdOf(pid);
    const startedAt = await startedAtOf(pid);
    const retiredOwner = retiredOwners.find((r) => r.tuiPid === pid || r.pid === pid);
    if (retiredOwner && typeof startedAt === "number" && Number.isFinite(startedAt) &&
        startedAt <= (retiredOwner.retiredAt as number)) continue;
    const label = labelFromCwd(cwd);
    // Derived from the SAME `cwd` as the label above, in the same pass — the anti-drift rule the hook
    // path gets from folderIdentity, applied to the discovery path.
    const folderKey = folderKeyFromCwd(cwd);
    // Idle unless a turn is PROVABLY open — a probe failure must never resurrect the stuck-"Running"
    // ghost this flag exists to kill (misread-active self-corrects via the next real hook; misread-idle
    // never would).
    let active = false;
    try { active = await turnActive(pid); } catch { /* idle-biased default */ }
    // title == label (cwd basename): a freshly-opened TUI has no prompt yet, so the cwd names it.
    out.push({
      pid, sessionId: codexSentinelSessionId(pid), title: label, label, idle: !active,
      ...(folderKey ? { folderKey } : {}),
      ...(cwd ? { cwd } : {}),
      ...(typeof startedAt === "number" && Number.isFinite(startedAt) ? { startedAt } : {}),
    });
  }
  return out;
}

// --- TUI LOCATE (the per-agent half of "bring this session's terminal window to the front") ----
//
// The phone can ask this computer to focus the terminal a session is running in (the watchdog's
// `focus-terminal` command). That splits cleanly in two: WHICH process is the session's interactive
// TUI (agent-specific — this seam), and HOW to raise the macOS window showing it (agent-agnostic —
// core/terminal-focus.ts). Only the first half belongs here.
//
// Claude is trivial: the hook records process.ppid, which IS the `claude` TUI. Codex is not — the
// record's pid can be an `app-server` host, a resumed thread, or a provisional discovery sentinel —
// so its locator is an explicit, ordered correlation heuristic that STOPS at the first unambiguous
// hit and otherwise gives up. Precision over magic: focusing the WRONG window is worse than doing
// nothing, so every tie, every unresolvable set, and every failed probe returns undefined.

/** Why a locate resolved (or didn't) — reported through LocateTuiDeps.note so the watchdog can trace
 *  an "ambiguous" give-up distinctly from "no candidate at all". Never affects the return value. */
export type LocateTuiReason =
  | "record-pid"      // 1. the record's own pid is a live TUI
  | "sentinel-pid"    // 2. the codex-pid-<n> provisional sentinel names a live TUI
  | "cwd-unique"      // 3. exactly one live TUI runs in the record's origin cwd
  | "start-time"      // 4. the strictly closest process start to the session's start
  | "only-candidate"  // 5. nothing correlated, but the machine has exactly ONE TUI
  | "ambiguous"       // two or more equally-plausible TUIs — deliberately no guess
  | "no-candidate"    // no live TUI at all (or the record has no usable pid)
  | "error";          // the process scan itself failed

/** Injectable seams for the locate step (mirrors CodexDiscoverDeps), so the whole heuristic is
 *  unit-testable without spawning `ps`/`lsof`. */
export interface LocateTuiDeps {
  /** Whole-process-table scan, `ps -axo pid=,tty=,args=` (same output parseCodexProcs reads). */
  ps?: () => Promise<string>;
  /** A pid's current working directory (lsof). */
  cwdOf?: (pid: number) => Promise<string | undefined>;
  /** A pid's process start time as epoch ms, or undefined when it can't be resolved. */
  startTimeOf?: (pid: number) => Promise<number | undefined>;
  /** A pid's controlling tty as `ps` prints it ("ttys004" / "??"), or undefined on failure. */
  ttyOf?: (pid: number) => Promise<string | undefined>;
  /** Ancestor pid chain (shared.pidAncestors) — the herdr-ownership probe. */
  ancestorsOf?: (pid: number) => number[];
  /** A pid's full argv (shared.pidCommand) — the herdr-ownership probe. */
  commandOf?: (pid: number) => string | undefined;
  /** Optional outcome sink (see LocateTuiReason). Best-effort; never throws into the caller. */
  note?: (reason: LocateTuiReason) => void;
}

/** The controlling tty of a pid via `ps -o tty= -p <pid>`. Undefined on any failure. */
async function ttyViaPs(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("ps", ["-o", "tty=", "-p", String(pid)]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** A pid's process start time (epoch ms) via `ps -o lstart= -p <pid>` — the full-date form, which
 *  Date.parse handles ("Wed Jul 30 02:14:07 2026"). Undefined on any failure/unparseable output. */
async function startTimeViaPs(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileP("ps", ["-o", "lstart=", "-p", String(pid)]);
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort note (a throwing sink must never break a locate). */
function noteLocate(deps: LocateTuiDeps, reason: LocateTuiReason): void {
  try { deps.note?.(reason); } catch { /* diagnostics only */ }
}

/** The provisional discovery sentinel's embedded pid (`codex-pid-<n>`), or undefined. */
function sentinelPid(sessionId: string): number | undefined {
  const m = /^codex-pid-(\d+)$/.exec(sessionId);
  if (!m) return undefined;
  const pid = Number.parseInt(m[1], 10);
  return Number.isFinite(pid) ? pid : undefined;
}

/** Locate the interactive Codex TUI process for a session record. ORDERED heuristic; the first
 *  unambiguous hit wins and nothing later can override it:
 *    1. `record.pid` is itself one of the live codex TUI candidates → that process.
 *    2. the session id is the `codex-pid-<n>` discovery sentinel and <n> is a candidate → that one.
 *    3. cwd: resolve each candidate's cwd and keep those equal to `record.origin?.cwd`. Exactly one
 *       → that one; several → continue with ONLY that subset. (Skipped entirely when the record has
 *       no origin cwd — older/provisional records — and NEVER approximated by `record.label`, the cwd
 *       BASENAME, which collides across worktrees/checkouts of the same project.)
 *    4. start-time proximity, only when `record.sessionStartedAt` is known: the candidate whose
 *       process start is STRICTLY closest to it. A tie, or no resolvable start times, → give up.
 *    5. if the surviving subset is EMPTY, fall back to "the codex TUI" only when the whole machine
 *       has exactly one; otherwise undefined.
 *  Never throws: a `ps` failure, an lsof race, or a garbage record all yield undefined. */
export async function codexLocateTuiPid(
  ctx: { sessionId: string; record: SessionRecord }, deps: LocateTuiDeps = {},
): Promise<number | undefined> {
  try {
    let output: string;
    try {
      output = await (deps.ps ?? runPs)();
    } catch {
      noteLocate(deps, "error");
      return undefined; // no process table → no evidence at all
    }
    // knownPids is EMPTY here on purpose: discovery excludes already-tracked pids, but a locate is
    // asking about a tracked session, so its own process must remain a candidate.
    const candidates = codexTuiCandidates(parseCodexProcs(output), new Set());
    if (candidates.length === 0) {
      noteLocate(deps, "no-candidate");
      return undefined;
    }
    const pids = new Set(candidates.map((c) => c.pid));

    // 1. the record's own pid is a live TUI (the common, exact case).
    if (typeof ctx.record.pid === "number" && Number.isFinite(ctx.record.pid) && pids.has(ctx.record.pid)) {
      noteLocate(deps, "record-pid");
      return ctx.record.pid;
    }

    // 2. the discovery sentinel names the pid directly.
    const sentinel = sentinelPid(ctx.sessionId);
    if (sentinel !== undefined && pids.has(sentinel)) {
      noteLocate(deps, "sentinel-pid");
      return sentinel;
    }

    // 3. cwd equality (exact path, never the basename).
    let subset = candidates;
    const cwd = ctx.record.origin?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) {
      const cwdOf = deps.cwdOf ?? cwdViaLsof;
      const matched: { pid: number; tty: string }[] = [];
      for (const c of candidates) {
        let candidateCwd: string | undefined;
        try { candidateCwd = await cwdOf(c.pid); } catch { candidateCwd = undefined; }
        if (candidateCwd === cwd) matched.push(c);
      }
      if (matched.length === 1) {
        noteLocate(deps, "cwd-unique");
        return matched[0].pid;
      }
      subset = matched; // several → tiebreak within them; none → the empty-subset fallback below
    }

    // 4. start-time proximity, strictly closest, only with a known session start.
    const startedAt = ctx.record.sessionStartedAt;
    if (subset.length > 1 && typeof startedAt === "number" && Number.isFinite(startedAt)) {
      const startTimeOf = deps.startTimeOf ?? startTimeViaPs;
      let best: { pid: number; delta: number } | undefined;
      let tied = false;
      for (const c of subset) {
        let started: number | undefined;
        try { started = await startTimeOf(c.pid); } catch { started = undefined; }
        if (typeof started !== "number" || !Number.isFinite(started)) continue;
        const delta = Math.abs(started - startedAt);
        if (best === undefined || delta < best.delta) {
          best = { pid: c.pid, delta };
          tied = false;
        } else if (delta === best.delta) {
          tied = true;
        }
      }
      if (best !== undefined && !tied) {
        noteLocate(deps, "start-time");
        return best.pid;
      }
      noteLocate(deps, "ambiguous"); // equally close, or nothing resolved → refuse to guess
      return undefined;
    }
    if (subset.length > 1) {
      noteLocate(deps, "ambiguous"); // several plausible TUIs and no tiebreak key
      return undefined;
    }
    // 5. nothing correlated (a lone cwd match already returned at step 3). Only a machine with exactly ONE codex TUI is unambiguous.
    if (candidates.length === 1) {
      noteLocate(deps, "only-candidate");
      return candidates[0].pid;
    }
    noteLocate(deps, "ambiguous");
    return undefined;
  } catch {
    noteLocate(deps, "error");
    return undefined;
  }
}

/** Locate the interactive Claude TUI process: the record's own pid IS it (the hook stores
 *  process.ppid, the `claude` process). The check is that the pid still owns a window:
 *    • if herdr's daemon owns its pty (the pid or an ancestor IS a herdr process) the pid's own tty
 *      is MEANINGLESS — terminal-focus correlates the herdr PANE instead — so it is accepted as-is;
 *    • otherwise it must hold a REAL controlling tty, because a dead pid, or one whose tty is "??"
 *      (a headless `claude`), owns no terminal window and there is nothing to focus.
 *  The herdr clause exists because a Claude BACKGROUND/forked session (`claude daemon run` →
 *  `--bg-pty-host`) records a daemon-hosted ppid that always reads "??" while its herdr tab is open
 *  and uniquely correlatable — the tty-only rule silently no-opped "Open on Mac" for every one of
 *  them (field report 2026-08-02). A dead pid has no readable ancestry, so it can never take that
 *  clause. Never throws. */
export async function claudeLocateTuiPid(
  ctx: { sessionId: string; record: SessionRecord }, deps: LocateTuiDeps = {},
): Promise<number | undefined> {
  try {
    const pid = ctx.record.pid;
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
      noteLocate(deps, "no-candidate");
      return undefined;
    }
    if (ancestryContainsHerdr(pid, deps.ancestorsOf ?? pidAncestors, deps.commandOf ?? pidCommand)) {
      noteLocate(deps, "record-pid");
      return pid;
    }
    let tty: string | undefined;
    try { tty = await (deps.ttyOf ?? ttyViaPs)(pid); } catch { tty = undefined; }
    if (typeof tty !== "string" || !isRealTty(tty.trim())) {
      noteLocate(deps, "no-candidate");
      return undefined;
    }
    noteLocate(deps, "record-pid");
    return pid;
  } catch {
    noteLocate(deps, "error");
    return undefined;
  }
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
  ts?: number;
}

/** Adapter-owned explanation for deferring a never-tracked session row. The hook writes this verbatim
 *  (guard + reason) to session-trace.log, so a silent return is inspectable without moving any of this
 *  agent-specific classification into the shared hook pipeline. */
export interface SessionCreationSuppression {
  guard: string;
  reason: string;
}

/** The most recent Claude record on the SAME process is the predecessor of a `SessionStart` whose
 *  source is `clear`. Claude keeps the TUI process alive across `/clear`, changes only the session id,
 *  and emits no SessionEnd for the old id. Codex records and provisional discovery rows are excluded;
 *  newest `ts` wins if an earlier bug already left more than one stale record on the pid. */
export function claudeClearPredecessor(
  sessionId: string, hookPid: number, tracked: TrackedSessionLite[],
): string | undefined {
  return tracked
    .filter((t) =>
      t.sessionId !== sessionId && t.provisional !== true && t.agent !== "codex" &&
      typeof t.pid === "number" && Number.isFinite(t.pid) && t.pid === hookPid)
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0]?.sessionId;
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

/** Does a parsed Codex session_meta source identify a subagent variant? Codex serializes enum variants
 *  as an object keyed by the variant name (`{"subagent":{...}}` in the guardian repro). Accept the
 *  string form too for forward/backward compatibility, but do not recursively match arbitrary nested
 *  keys: only the source variant itself is authoritative. */
function codexSubagentSource(source: unknown): boolean {
  return source === "subagent" || (
    typeof source === "object" && source !== null &&
    Object.prototype.hasOwnProperty.call(source, "subagent")
  );
}

/** Structural evidence from a bounded Codex rollout prefix. Subagent source is sticky and wins even if
 *  the internal thread later writes a user_message; `hasUserMessage` means an actual rollout event_msg
 *  with payload.type=user_message (not an incidental string in instructions/tool output). */
export function codexRolloutCreationEvidence(prefix: string): {
  subagent: boolean; hasUserMessage: boolean; headlessExec: boolean;
} {
  let subagent = false;
  let hasUserMessage = false;
  let headlessExec = false;
  for (const line of prefix.split("\n")) {
    if (!line.trim()) continue;
    if (!line.includes("session_meta") && !line.includes("user_message")) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const payload = r.payload as Record<string, unknown> | undefined;
    if (r.type === "session_meta") {
      if (codexSubagentSource(payload?.source ?? r.source)) subagent = true;
      // Codex's durable session_meta is the only authoritative creation-time discriminator for an
      // ordinary one-shot. Hook stdin carries no interactive/exec bit, and app-server-fronted runs can
      // share a tty-less parent with real desktop sessions. Historical `codex exec` rollouts stamp both
      // originator:"codex_exec" and source:"exec"; either exact enum/string is sufficient. Missing or
      // malformed metadata leaves this false, deliberately failing open to tracking.
      if (payload?.originator === "codex_exec" || payload?.source === "exec") headlessExec = true;
    }
    if (r.type === "event_msg" && payload?.type === "user_message") hasUserMessage = true;
  }
  return { subagent, hasUserMessage, headlessExec };
}

/** Detailed Codex create guard used by runHook. A subagent rollout is permanently suppressed. Any
 *  other rollout is deferred until a REAL user_message exists, with the current UserPromptSubmit's
 *  non-empty `prompt` accepted as race-proof evidence before the JSONL flush. If a hook prompt exists
 *  but the rollout itself is still wholly absent, retain the older top-level internal-job evidence
 *  check so app-server background prompts cannot mint rows merely by carrying prompt text. */
export async function codexSessionCreationSuppression(
  sessionId: string,
  transcriptPrefix: string,
  transcriptPath: string,
  input: Record<string, unknown> = {},
  deps: CodexInternalGhostDeps = {},
): Promise<SessionCreationSuppression | null> {
  const evidence = codexRolloutCreationEvidence(transcriptPrefix);
  if (evidence.subagent) {
    return {
      guard: "codex-subagent-rollout",
      reason: "session_meta.source is a subagent variant",
    };
  }
  if (evidence.headlessExec) {
    return {
      guard: "codex-headless-exec",
      reason: "session_meta identifies a non-interactive codex exec run",
    };
  }
  const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const hookPrompt = hookName === "UserPromptSubmit" &&
    typeof input.prompt === "string" && input.prompt.trim().length > 0;
  if (!evidence.hasUserMessage && !hookPrompt) {
    return {
      guard: "codex-promptless-rollout",
      reason: "no rollout user_message or UserPromptSubmit prompt yet",
    };
  }
  if (transcriptPrefix.trim().length > 0) return null;
  if (transcriptPath.length > 0) {
    try { await (deps.statOf ?? stat)(transcriptPath); return null; } catch { /* no file at the path */ }
  }
  try {
    if (await (deps.rolloutExists ?? codexRolloutExistsForSession)(sessionId)) return null;
  } catch {
    // A failed locator is still no rollout evidence. Defer; a later hook self-heals.
  }
  return {
    guard: "codex-internal-no-rollout",
    reason: "hook prompt exists but no transcript file or rollout can be found",
  };
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
  input: Record<string, unknown> = {},
): Promise<boolean> {
  return (await codexSessionCreationSuppression(
    sessionId, transcriptPrefix, transcriptPath, input, deps,
  )) !== null;
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
  /** OPTIONAL encrypted detail for the pending attention episode found by `tailShowsPendingApproval`.
   *  Codex uses it to recover a dropped Plan/request_user_input hook with the actual first question;
   *  undefined means the episode has no safely recoverable detail. */
  tailPendingAttentionDetail?(tail: string): string | undefined;
  /** OPTIONAL clear-envelope discriminator for the recovered attention episode. Kept deliberately
   *  narrow: only Codex request_user_input currently has a value; ordinary approvals remain absent. */
  tailPendingAttentionKind?(tail: string): "userInput" | undefined;
  /** OPTIONAL: classify the client-side wait that can remain AFTER an agent turn completes. Codex
   *  implements this for its TUI Plan picker; Claude omits it. The hook/notify done paths consult it
   *  before emitting done, and the watchdog consults it only for records explicitly marked as this
   *  kind of wait. `transcriptPath` pins the exact rollout when known; otherwise the pid locator's
   *  open-fd / cwd+recency fallback is used. */
  completedTurnWaitState?(ctx: { pid: number; transcriptPath?: string }): Promise<CodexPlanPickerState>;
  /** OPTIONAL state + plan markdown from the same durable probe. F11 consumers prefer this over the
   *  state-only compatibility seam to avoid a second rollout read. */
  completedTurnWaitEvidence?(ctx: { pid: number; transcriptPath?: string }): Promise<CodexPlanPickerEvidence>;
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
  /** OPTIONAL detailed never-tracked create guard. Codex owns rollout semantics here (subagent source,
   *  promptless deferral, and absent-rollout internal jobs); the shared hook only records and obeys the
   *  adapter's guard/reason. */
  sessionCreationSuppression?(ctx: {
    sessionId: string;
    prefix: string;
    transcriptPath: string;
    input: Record<string, unknown>;
  }): Promise<SessionCreationSuppression | null>;
  /** OPTIONAL Claude lineage seam: extract the predecessor id named by the precise daemon
   *  `--fork-session --resume <transcript> --reply-on-resume` command. The hook confirms that record
   *  exists before reusing it, so argv alone can never invent an alias. */
  forkResumePredecessor?(command: string | undefined): string | undefined;
  /** OPTIONAL Claude `/clear` lineage seam: identify the old row on the same TUI process. */
  clearPredecessor?(ctx: {
    sessionId: string;
    hookPid: number;
    tracked: TrackedSessionLite[];
  }): string | undefined;
  /** OPTIONAL: whether the INVOKING agent process (and its ancestor chain) is a non-interactive /
   *  daemon-spawned "headless" run whose events must be skipped (deferred) — no phone row. Claude
   *  implements it (headless `claude --output-format stream-json …` observation runs — e.g. claude-mem —
   *  fire hooks under a session id that never gets a Stop, minting a phantom "working" row); Codex OMITS
   *  it (its `codex exec` automation is already excluded from discovery by argv). The seam is handed the
   *  invoking pid (process.ppid), the ancestor-chain walker (pidAncestors), and a per-pid command-line
   *  reader (pidCommand) so the pure classifier stays testable. Called by runHook only when NO session
   *  record exists yet, so an already-live interactive session can never be silenced. */
  isHeadlessInvocation?(ctx: { pid: number; ancestorsOf: (pid: number) => number[]; commandOf: (pid: number) => string | undefined }): boolean;
  /** OPTIONAL: is the INVOKING agent process a DESKTOP-app conversation window (as opposed to a
   *  terminal CLI)? Same ctx as isHeadlessInvocation. Claude implements it (see
   *  claudeDesktopInvocation); Codex OMITS it. runHook uses it to scope the transcript-less launch
   *  phantom defer to desktop invocations only — a fresh terminal `claude` legitimately creates its
   *  row before its transcript exists, and that must keep working. */
  isDesktopInvocation?(ctx: { pid: number; ancestorsOf: (pid: number) => number[]; commandOf: (pid: number) => string | undefined }): boolean;
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
  /** OPTIONAL: which live process is this session's INTERACTIVE TUI — the one whose terminal window
   *  the phone's `focus-terminal` command wants raised. Undefined means "don't know / not sure": the
   *  watchdog then does NOTHING (focusing the wrong window is worse than a no-op). Claude returns its
   *  recorded pid when that pid still holds a real controlling tty; Codex runs the ordered correlation
   *  heuristic in codexLocateTuiPid. `sessionId` rides alongside the record because a record does not
   *  carry its own id (the filename stem is the id) and the codex discovery sentinel encodes the pid
   *  in it. Must never throw. */
  locateTuiPid?(ctx: { sessionId: string; record: SessionRecord }, deps?: LocateTuiDeps): Promise<number | undefined>;
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
  // Phantom-row guard: a headless `claude` (claude-mem's stream-json observation runs, or any tool
  // shelling out to non-interactive Claude) fires hooks under a session id that never gets a Stop.
  // Fingerprint it from the invoking process's argv + ancestor chain and DEFER (skip mirroring) so it
  // never becomes a stuck "working" phone row. See claudeHeadlessInvocation.
  isHeadlessInvocation({ pid, ancestorsOf, commandOf }): boolean {
    return claudeHeadlessInvocation(commandOf(pid), ancestorsOf(pid).map((p) => commandOf(p)));
  },
  // Launch-phantom scope: opening the Claude desktop app fires SessionStart→SessionEnd within a
  // second for ~9 session ids that never get a prompt and never get a transcript file. Only desktop
  // invocations are subject to that defer. See claudeDesktopInvocation.
  isDesktopInvocation({ pid, ancestorsOf, commandOf }): boolean {
    return claudeDesktopInvocation(commandOf(pid), ancestorsOf(pid).map((p) => commandOf(p)));
  },
  forkResumePredecessor(command: string | undefined): string | undefined {
    return claudeForkResumePredecessor(command);
  },
  clearPredecessor({ sessionId, hookPid, tracked }): string | undefined {
    return claudeClearPredecessor(sessionId, hookPid, tracked);
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
  // The recorded pid IS the TUI (process.ppid at hook time); it only has to still own a real tty.
  locateTuiPid: (ctx, deps) => claudeLocateTuiPid(ctx, deps),
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
  tailPendingAttentionDetail(tail: string): string | undefined {
    return codexTailPendingUserInputDetail(tail);
  },
  tailPendingAttentionKind(tail: string): "userInput" | undefined {
    return codexTailPendingAttentionKind(tail);
  },
  completedTurnWaitState({ pid, transcriptPath }): Promise<CodexPlanPickerState> {
    return codexPidPlanPickerState(pid, transcriptPath
      ? { rolloutOf: async () => transcriptPath }
      : {});
  },
  completedTurnWaitEvidence({ pid, transcriptPath }): Promise<CodexPlanPickerEvidence> {
    return codexPidPlanPickerEvidence(pid, transcriptPath
      ? { rolloutOf: async () => transcriptPath }
      : {});
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
  sessionCreationSuppression({ sessionId, prefix, transcriptPath, input }): Promise<SessionCreationSuppression | null> {
    return codexSessionCreationSuppression(sessionId, prefix, transcriptPath, input);
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
  // A codex record's pid may be an app-server host or a discovery sentinel, so locating the TUI is an
  // ordered correlation heuristic that refuses to guess (see codexLocateTuiPid).
  locateTuiPid: (ctx, deps) => codexLocateTuiPid(ctx, deps),
};

/** Select the concrete adapter for an agent kind. */
export function adapterFor(agent: AgentKind): AgentAdapter {
  return agent === "codex" ? codexAdapter : claudeAdapter;
}

/** Every concrete adapter, so the agent-agnostic watchdog can drive its generic per-agent steps
 *  (e.g. discovery) across all agents without an inline `agent === …` branch. */
export const allAdapters: AgentAdapter[] = [claudeAdapter, codexAdapter];
