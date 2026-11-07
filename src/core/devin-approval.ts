// devin-approval — answer a Devin PermissionRequest from the phone (NOM-158).
//
// The Antigravity recipe (core/antigravity-approval.ts): build a Claude-shaped PermissionRequest stdin,
// hand it WHOLE to permission.ts's runPermissionHook (same relay, same gates, same decisionPending card,
// same approvals pause switch), capture the one decision line it emits, and translate it into Devin's
// wire. Run by the PermissionRequest entry in ~/.config/devin/config.json (devin-install.mjs), and by
// the PreToolUse `^ask_user_question$` entry: Devin's question fires PreToolUse, never PermissionRequest.
//
// QUESTIONS (spikes F3/F4, via `devin acp`): mapped to Claude's AskUserQuestion card, so the phone's
// picker and permission.ts's answerLine / release rule apply unchanged. Devin parses
// `updatedInput.answers` and then ignores it (it still asks its own front end), so the answer goes back
// as a BLOCK whose reason states it; the model continues with that answer. The Mac shows the question
// as rejected with Nomo's text. While the phone holds, Devin's own question card is not shown (it comes
// only after this hook returns); a release, a timeout or paused approvals hand it back.
//
// THE WIRE (verified against devin 3000.11.234, 2026-11-07 — docs/devin-spike-2026-11-07.md):
//   {"decision":"approve"}                   → the tool runs
//   {"decision":"block","reason":"…"}        → denied; the agent sees the reason
//   no output + exit 0                       → no opinion: Devin's own prompt decides (in `-p` the
//                                              tool is rejected and the run ends)
// FAIL-OPEN: a crash, garbage, or the hook timeout ("Command timed out") is logged and counts as no
// opinion. So every path without a phone answer — unpaired, approvals paused, network down, our own
// deadline, an exception — prints NOTHING.
//
// TIMEOUT: `"timeout": 86400` is honoured (a 610 s hold was answered and the tool ran), so the hold
// waits like Claude's and each layer sits strictly inside the next: hold deadline (T−600 s) < the
// entry's own cap (T−300 s) < T.
//
// ABANDONMENT: when Devin gives up on the hook (its timeout, Ctrl-C, the session ending) it SIGKILLs the
// hook's DIRECT child only — no catchable signal. So the installer's command ends in `; exit 0`, which
// keeps a shell between Devin and this process: the kill lands on the shell, we are reparented, and
// `process.ppid` changing is the signal that withdraws the phone's card (runPermissionHook's
// `abandoned`). A SIGTERM/SIGHUP (a closed terminal) is honoured too.
//
// tool_input keys (verified): exec → command; write → file_path, content. edit/read use file_path
// (Devin's EditInput/ReadInput), webfetch url. `allow_mode` is a plain approve (no allowMode).
//
// ALWAYS ALLOW IS NOMO-SIDE (spikes A/B): a hook can only approve/block ONE call (Devin has no
// `updatedPermissions`), and a rule written into Devin's config only applies from the NEXT session. So an
// Always-allow tap stores a grant in `<sessions>/<id>.devin-allow` (0600) and the next matching request
// in that session is approved at once, without the phone — even while approvals are paused (an explicit
// grant, like a Claude Code session rule). Scope mirrors Devin's own "(this session)" option: a plain
// shell command grants its command NAME (word-complete, `touch` ≠ `touchy`); a command with any shell
// operator, substitution or redirect grants only that exact text, and only a plain command can ever
// match a name grant, so `touch a && rm -rf ~` always goes to the phone. Any other tool is granted whole.
// The grant is deleted on SessionEnd and when the watchdog retires the row.
//
// NOMO'S OWN COMMANDS: on a paired computer, the `exec` of one of Nomo's own SAFE skill commands
// (/nomo-status, /nomo-pair, /nomo-approvals on|status, /nomo-reset — the plugin's /nomo:* or the
// installer's /nomo-*) is approved at once, byte for byte, so /nomo-status never puts a card on the
// phone. Pausing approvals, unpairing and the typed pairing code still ask (Antigravity's rule).

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVIN_ASK_TOOL, runDevinHook } from "./devin";
import { runPermissionHook, type PermissionHookDeps } from "./permission";
import { atomicWrite, devinGrantsPath, loadConfig, SESSIONS_DIR } from "./shared";

export const DEVIN_APPROVAL_TIMEOUT_S = 86_400;
export const DEVIN_HOLD_DEADLINE_MS = (DEVIN_APPROVAL_TIMEOUT_S - 600) * 1000;
export const DEVIN_ENTRY_CAP_MS = (DEVIN_APPROVAL_TIMEOUT_S - 300) * 1000;

/** Devin tool → the card name the phone already draws (CCShellCommandDisplay for `shell`, the file for
 *  Write/Edit/Read, the URL for WebFetch). Every other tool keeps its raw name. */
const CARD_TOOL: Record<string, string> = {
  exec: "shell",
  write: "Write",
  edit: "Edit",
  read: "Read",
  webfetch: "WebFetch",
};

const APPROVE = '{"decision":"approve"}';
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** The question's card tool: Claude's, so the phone's picker, answerLine and THE RELEASE RULE apply. */
export const DEVIN_QUESTION_CARD_TOOL = "AskUserQuestion";

/** Devin's `ask_user_question` input → Claude's AskUserQuestion shape (`multi_select` → `multiSelect`).
 *  Anything malformed is dropped here and filtered again by permission.ts's usableQuestions. Pure. */
export function devinQuestionInput(toolInput: Record<string, unknown>): Record<string, unknown> {
  const qs = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  return {
    questions: qs.filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null).map((q) => ({
      question: q.question,
      ...(typeof q.header === "string" ? { header: q.header } : {}),
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
        .map((o) => ({ label: o.label, ...(typeof o.description === "string" ? { description: o.description } : {}) })),
      multiSelect: q.multi_select === true,
    })),
  };
}

/** The Claude-shaped stdin for one Devin PermissionRequest — or the PreToolUse of Devin's question —
 *  or undefined = not ours to hold (no opinion at once). `permission_mode` / `agent_id` are absent on
 *  purpose: the interactive arm. Pure. */
export function devinPermissionStdin(input: Record<string, unknown>, cwd?: string): string | undefined {
  const sessionId = str(input.session_id);
  const tool = str(input.tool_name);
  if (!sessionId || !SAFE_ID.test(sessionId) || !tool) return undefined;
  // The question arrives on PreToolUse only (it fires no PermissionRequest); nothing else does.
  const isQuestion = tool === DEVIN_ASK_TOOL;
  if (isQuestion !== (input.hook_event_name === "PreToolUse")) return undefined;
  const toolInput = typeof input.tool_input === "object" && input.tool_input !== null && !Array.isArray(input.tool_input)
    ? input.tool_input as Record<string, unknown> : {};
  return JSON.stringify({
    session_id: sessionId,
    ...(cwd ? { cwd } : {}),
    hook_event_name: "PermissionRequest",
    tool_name: isQuestion ? DEVIN_QUESTION_CARD_TOOL : CARD_TOOL[tool] ?? tool,
    tool_input: isQuestion ? devinQuestionInput(toolInput) : toolInput,
  });
}

// ── Nomo's own /nomo-* commands ─────────────────────────────────────────────────────────────────

/** The plugin dir this bundle runs from (`<root>/dist/devin-approve.mjs` → `<root>`): the installer's
 *  checkout (`~/.nomo/plugin`) or the Devin plugin cache's `…/plugin`. */
export const DEVIN_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The plugin skills' search of Devin's plugin cache (plugin/devin-skills); the installer's skills put
 *  the one quoted checkout path in its place (devin-install.mjs userSkill). */
const PLUGIN_CACHE_GLOB = '"$HOME"/.local/share/devin/cli/plugins/cache/*nomo*/*/plugin';

/** [dist script, args] of the SAFE skill commands: they only read state, restore the default, or
 *  start/finish pairing — the same set as Antigravity's SAFE_SKILL_COMMANDS. NOT here (they still ask
 *  the phone): pausing approvals, unpairing, printing the typed pairing code. */
const SAFE_DEVIN_SKILL_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["status-cmd", "devin"],
  ["cc-permission", "status"],
  ["cc-permission", "on"],
  ["reset", ""],
  ["pair", ""],
  ["pair", "wait --timeout 60"],
];

/** The exact line a Devin skill runs for `script args`, searching `loop` (the plugin-cache glob, or a
 *  quoted checkout path), then the hook-shim fallback. Mirrors plugin/devin-skills byte for byte (a
 *  test checks every skill's command against it). */
function devinSkillCommand(loop: string, script: string, args: string, reinstall: string): string {
  const a = args ? ` ${args}` : "";
  return `/bin/sh -c 'NOMOS="$HOME/.config/cc-status/hook-shim.sh"; for NOMOR in ${loop}; do [ -x "$NOMOR/scripts/run.sh" ] && [ -f "$NOMOR/dist/${script}.mjs" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/${script}.mjs"${a}; done; [ -x "$NOMOS" ] && exec "$NOMOS" ${script}${a}; echo "Nomo could not find its installed files - ${reinstall}"; exit 1'`;
}

/** Is `command` EXACTLY one of Nomo's own safe skill commands — the Devin plugin's (/nomo:*, plugin
 *  cache search) or the installer's (/nomo-*, this checkout)? Only a single trailing newline is
 *  forgiven; any other byte difference (`&& …`, `;`, `|`, a redirect, a CR/LF, other quoting, another
 *  script) is not ours. Pure. */
export function isDevinSkillCommand(command: string, root: string = DEVIN_PLUGIN_ROOT): boolean {
  const c = command.endsWith("\n") ? command.slice(0, -1) : command;
  if (/[\r\n]/.test(c)) return false;
  return SAFE_DEVIN_SKILL_COMMANDS.some(([script, args]) =>
    devinSkillCommand(PLUGIN_CACHE_GLOB, script, args, "reinstall: devin plugins install KarrixLee/nomo") === c
    || devinSkillCommand(`"${root}"`, script, args, "re-run: bunx nomo-ai --devin") === c);
}

/** An `exec` call that is only Nomo's own skill command: `command` plus at most Devin Desktop's
 *  `workdir` (the paths are absolute). Any other key (an env, …) could change what runs → not ours. */
function isOwnExec(cardTool: string, toolInput: Record<string, unknown>, root?: string): boolean {
  return cardTool === "shell" && typeof toolInput.command === "string"
    && Object.keys(toolInput).every((k) => k === "command" || k === "workdir")
    && isDevinSkillCommand(toolInput.command, root);
}

// ── Always allow (session grants) ───────────────────────────────────────────────────────────────

export interface DevinGrant { tool: string; prefix?: string; exact?: string }

/** A plain command: a name, then arguments with no shell operator, substitution, redirect or newline.
 *  ponytail: a regex, not a shell parser — anything it is unsure of is not plain (asks the phone).
 *  Upgrade path: Devin's own commandNames, if it ever reaches hooks. */
const PLAIN_COMMAND = /^[A-Za-z0-9_./-]+( [^;&|`$<>(){}\n]*)?$/;

const commandOf = (toolInput: Record<string, unknown>): string =>
  typeof toolInput.command === "string" ? toolInput.command : "";

/** The grant an Always-allow tap makes for this card tool + input. Pure. */
export function devinGrantFor(cardTool: string, toolInput: Record<string, unknown>): DevinGrant {
  if (cardTool !== "shell") return { tool: cardTool };
  const command = commandOf(toolInput);
  return PLAIN_COMMAND.test(command) ? { tool: "shell", prefix: command.split(" ", 1)[0] } : { tool: "shell", exact: command };
}

/** Does `grant` cover this request? Pure. */
export function devinGrantMatches(grant: DevinGrant, cardTool: string, toolInput: Record<string, unknown>): boolean {
  if (grant.tool !== cardTool) return false;
  if (cardTool !== "shell") return true;
  const command = commandOf(toolInput);
  if (typeof grant.exact === "string") return command === grant.exact;
  return typeof grant.prefix === "string" && grant.prefix.length > 0 && PLAIN_COMMAND.test(command)
    && (command === grant.prefix || command.startsWith(`${grant.prefix} `));
}

async function readGrants(path: string): Promise<DevinGrant[]> {
  try {
    const list: unknown = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(list)
      ? list.filter((g): g is DevinGrant => typeof g === "object" && g !== null && typeof (g as DevinGrant).tool === "string")
      : [];
  } catch {
    return [];
  }
}

/** Append one grant (deduped). ponytail: read-modify-write, so two Always-allow taps landing in the same
 *  instant can drop one (that prompt just asks again); add a lock if that ever shows up. */
async function storeGrant(path: string, grant: DevinGrant): Promise<void> {
  const grants = await readGrants(path);
  if (grants.some((g) => JSON.stringify(g) === JSON.stringify(grant))) return;
  await atomicWrite(path, JSON.stringify([...grants, grant]), 0o600);
}

/** Did the phone answer Always allow? Only allowAlwaysLine carries `updatedPermissions` for Devin
 *  (devinAdapter has no allowMode). */
function grantsAlways(line: string | undefined): boolean {
  try {
    const d = (JSON.parse(line ?? "") as { hookSpecificOutput?: { decision?: { behavior?: unknown; updatedPermissions?: unknown } } })
      .hookSpecificOutput?.decision;
    return d?.behavior === "allow" && Array.isArray(d.updatedPermissions) && d.updatedPermissions.length > 0;
  } catch {
    return false;
  }
}

/** Longest answer reason we hand Devin. Over it → no opinion (Devin's own question card), never a
 *  sliced answer — the same refuse-don't-slice rule as permission.ts's ANSWER_MAX. */
export const DEVIN_ANSWER_REASON_MAX = 2000;
const QUESTION_DENIED = "The user chose not to answer from their phone; continue without asking again or ask in chat.";

/** The phone's answers (Claude's `updatedInput.answers`, keyed by question text, valued by the picked
 *  label(s) "A, B" or typed text, plus `annotations[q].notes`) as the block reason Devin's model reads.
 *  Devin parses `updatedInput.answers` and then IGNORES it (spike F3); a block whose reason carries the
 *  answer is what the model acts on (F4). "" = unrepresentable (release). */
function answerReason(updatedInput: unknown): string {
  const input = (typeof updatedInput === "object" && updatedInput !== null ? updatedInput : {}) as {
    answers?: unknown; annotations?: Record<string, { notes?: unknown }>;
  };
  if (typeof input.answers !== "object" || input.answers === null) return "";
  const parts = Object.entries(input.answers as Record<string, unknown>).map(([q, a]) => {
    const note = str(input.annotations?.[q]?.notes);
    return `"${q}" → ${String(a)}${note ? ` (note: ${note})` : ""}`;
  });
  if (parts.length === 0) return "";
  const reason = `The user answered from their phone (Nomo): ${parts.join("; ")}. Use these answers and continue; do not ask the same question again.`;
  return reason.length <= DEVIN_ANSWER_REASON_MAX ? reason : "";
}

/** runPermissionHook's emitted line → Devin's decision; "" = no opinion (print nothing). Every allow
 *  variant (allow / allow_always / allow_mode all emit behavior "allow") is an approve; the
 *  Always-allow grant is stored by the caller. On a QUESTION, an answer is a block carrying it (the
 *  only channel Devin's model honours), and a deny is a block saying the user declined. A bare allow
 *  on a question never gets here (permission.ts releases it: Devin's own question card). */
export function devinDecision(line: string | undefined, isQuestion = false): string {
  if (!line) return "";
  try {
    const d = (JSON.parse(line) as { hookSpecificOutput?: { decision?: { behavior?: unknown; message?: unknown; updatedInput?: unknown } } })
      .hookSpecificOutput?.decision;
    if (isQuestion) {
      if (d?.behavior === "allow") {
        const reason = answerReason(d.updatedInput);
        return reason ? JSON.stringify({ decision: "block", reason }) : "";
      }
      if (d?.behavior === "deny") {
        const note = str(d.message);
        return JSON.stringify({ decision: "block", reason: note && note !== "Denied from phone" ? note : QUESTION_DENIED });
      }
      return "";
    }
    if (d?.behavior === "allow") return APPROVE;
    if (d?.behavior === "deny") return JSON.stringify({ decision: "block", reason: str(d.message) ?? "Denied from phone" });
  } catch { /* fall through */ }
  return "";
}

export interface DevinApprovalDeps {
  /** Overrides for the shared hold (tests: fetch, config, clock…). */
  hold?: PermissionHookDeps;
  run?: typeof runPermissionHook;
  /** The paused-approvals path. Default: the status producer posts the yellow heads-up. */
  delegate?: () => Promise<void>;
  /** Has Devin given up on this hook (tests)? Default: SIGTERM seen, or our parent pid changed. */
  abandoned?: () => boolean;
  env?: Record<string, string | undefined>;
  /** Where the session grants live (tests). Default: SESSIONS_DIR. */
  sessionsDir?: string;
  /** The plugin root Nomo's own skill commands are rebuilt under (tests). */
  pluginRoot?: string;
}

/** Set by the entry's SIGTERM/SIGHUP handler. */
let terminated = false;
export function markDevinApprovalTerminated(): void { terminated = true; }
const parentAtStart = process.ppid;
const defaultAbandoned = () => terminated || process.ppid !== parentAtStart;

/** One PermissionRequest invocation → Devin's decision line, or "" for no opinion. Never throws. */
export async function runDevinApproval(raw: string, deps: DevinApprovalDeps = {}): Promise<string> {
  try {
    const env = deps.env ?? process.env;
    if (env.DEVIN_PROJECT_DIR === undefined) return "";
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "";
    const stdin = devinPermissionStdin(parsed as Record<string, unknown>, str(env.DEVIN_PROJECT_DIR));
    if (!stdin) return "";
    const { session_id: sessionId, tool_name: cardTool, tool_input: toolInput } =
      JSON.parse(stdin) as { session_id: string; tool_name: string; tool_input: Record<string, unknown> };
    // An Always-allow grant answers at once — before the pause gate and before any phone card.
    const grantsPath = devinGrantsPath(deps.sessionsDir ?? SESSIONS_DIR, sessionId);
    if (cardTool !== DEVIN_QUESTION_CARD_TOOL && (await readGrants(grantsPath)).some((g) => devinGrantMatches(g, cardTool, toolInput))) return APPROVE;
    // Nomo's OWN /nomo-* commands (status, approvals on, …) never become a phone card — but only when
    // paired (unpaired, Devin's own prompt decides) and only byte-for-byte the skill's command.
    if (isOwnExec(cardTool, toolInput, deps.pluginRoot) && await (deps.hold?.loadConfigFn ?? loadConfig)()) return APPROVE;
    let line: string | undefined;
    let gone = false;
    const abandoned = () => (gone ||= (deps.abandoned ?? defaultAbandoned)());
    await (deps.run ?? runPermissionHook)({
      delegate: deps.delegate ?? (() => runDevinHook(raw)),
      deadlineAt: (deps.hold?.now ?? Date.now)() + DEVIN_HOLD_DEADLINE_MS,
      abandoned,
      ...deps.hold,
      readInput: async () => stdin,
      emit: (l) => { line = l; },
    }, "devin");
    const isQuestion = cardTool === DEVIN_QUESTION_CARD_TOOL;
    if (!isQuestion && grantsAlways(line)) await storeGrant(grantsPath, devinGrantFor(cardTool, toolInput)).catch(() => {});
    return devinDecision(line, isQuestion);
  } catch {
    return "";
  }
}
