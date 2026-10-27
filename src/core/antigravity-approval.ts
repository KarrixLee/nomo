// antigravity-approval — answer an Antigravity tool permission from the phone (NOM-96 v2).
//
// The Antigravity PreToolUse hook, run by plugin/scripts/antigravity-approve.sh. It is the OpenCode
// recipe (opencode/approvals.ts): synthesize a Claude-shaped PermissionRequest stdin, hand it WHOLE to
// permission.ts's runPermissionHook (same relay, same gates, same decisionPending card, same approvals
// pause switch), capture the one decision line it emits, and translate it into Antigravity's wire.
//
// THE WIRE (verified against agy 1.4.8, 2026-10-27):
//   {"decision":"auto_approve"}              → the tool runs where the default policy would prompt
//   {"decision":"deny","reason":"…"}         → blocked; the agent sees the reason
//   {"decision":"allow"}                     → no opinion: Antigravity's own policy (its local prompt)
// FAIL-CLOSED: `{}`, a non-zero exit, garbage, or running past the hook timeout all BLOCK the tool. So
// every path here — unpaired, approvals paused, session not on the phone, network down, a deadline, an
// exception — returns ANTIGRAVITY_FALLBACK, and the shell wrapper re-validates whatever we print.
//
// WHAT GOES TO THE PHONE. PreToolUse fires for EVERY tool, reads included; holding those would make
// Antigravity unusable. The installer's matcher already limits the hook to ANTIGRAVITY_APPROVAL_TOOLS
// (shell + file writes/edits), and `antigravityApprovalRequest` additionally lets through, untouched, a
// call the user's own settings.json `permissions` decide: anything a `deny` rule may match (Deny > Ask >
// Allow — the phone can never override a local deny), or a plain-prefix `allow` no `ask` rule touches. Workspace
// writes are NOT exempt: agy 1.4.8 prompted for a write inside its own workspace in the spike, so the
// docs' "workspace writes are auto-allowed" cannot be relied on.
//
// PHONE STOP: while the phone's Stop flag is up (see core/antigravity.ts), a routed tool call is denied
// with ANTIGRAVITY_STOP_REASON at once, and a hold already waiting on the phone ends the same way — the
// turn is about to be terminated, and the fallback would park it on Antigravity's own prompt instead.
//
// "ALWAYS ALLOW" IS NOT OFFERED: `permissionOverrides` persistence is undocumented and testing it would
// write to the user's real ~/.gemini. A phone that sends allow_always anyway gets a plain auto_approve.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SAFE_SKILL_COMMANDS, skillCommand } from "../../plugin/scripts/antigravity-skill-command.mjs";
import { antigravityDataDirFor, antigravityDataDirs } from "./adapter";
import {
  ANTIGRAVITY_STOP_REASON, antigravityCwd, antigravitySessionId, antigravityStopRequested,
} from "./antigravity";
import { runPermissionHook, type PermissionHookDeps } from "./permission";
import { CC_DIR, Config, loadConfig, SESSIONS_DIR } from "./shared";

/** The plugin checkout this bundle runs from (`<root>/dist/antigravity-approve.mjs` → `<root>`). */
export const ANTIGRAVITY_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Is `command` EXACTLY one of Nomo's own safe /nomo-* skill commands, as the installer wrote them for
 *  this checkout? Only a single trailing newline is forgiven; any other byte difference — a space, a
 *  `cd`, `&& …`, other quoting, a CR or LF anywhere — is not ours. Pure. */
export function isNomoSkillCommand(command: string, root: string = ANTIGRAVITY_PLUGIN_ROOT): boolean {
  const c = command.endsWith("\n") ? command.slice(0, -1) : command;
  if (/[\r\n]/.test(c)) return false;
  return SAFE_SKILL_COMMANDS.some((key) => skillCommand(root, key) === c);
}

/** Writes here become code Nomo runs (the plugin checkout) or Nomo's own state (pairing, flags): they
 *  always go to the phone, even when an allow rule covers them. */
export function nomoProtectedDirs(root: string = ANTIGRAVITY_PLUGIN_ROOT): string[] {
  return [root, CC_DIR];
}

/** Printed whenever we have no phone answer: defer to Antigravity's own policy. */
export const ANTIGRAVITY_FALLBACK = '{"decision":"allow"}';

/** Antigravity tool → the Claude-shaped card the phone already draws. `shell` is a name the phone's
 *  CCShellCommandDisplay renders as a command; Write/Edit show the file. CLI names (agy 1.4.8:
 *  run_command, write_file) and the desktop/IDE names from antigravity.google/docs/hooks. */
const CARD_TOOL: Record<string, "shell" | "Write" | "Edit"> = {
  run_command: "shell",
  write_file: "Write",
  write_to_file: "Write",
  edit_file: "Edit",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
};

/** The installer's PreToolUse matcher (a regex over the tool name): only these tools ever start us. */
export const ANTIGRAVITY_APPROVAL_MATCHER = `^(${Object.keys(CARD_TOOL).join("|")})$`;

/** Hook budget, mirroring Claude Code's PermissionRequest (hooks.json timeout 86400 s, hold until the
 *  phone answers). Each layer sits strictly inside the next so the hook timeout — which BLOCKS the
 *  tool — is never reached: hold deadline (T−600 s) < the entry's print-fallback cap (T−300 s) < the
 *  shell wrapper's kill guard (T−120 s) < T. */
export const ANTIGRAVITY_APPROVAL_TIMEOUT_S = 86_400;
export const ANTIGRAVITY_HOLD_DEADLINE_MS = (ANTIGRAVITY_APPROVAL_TIMEOUT_S - 600) * 1000;
export const ANTIGRAVITY_ENTRY_CAP_MS = (ANTIGRAVITY_APPROVAL_TIMEOUT_S - 300) * 1000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export interface AntigravityPermissionRules { allow: string[]; ask: string[]; deny: string[] }

/** `permissions.{allow,ask,deny}` from the settings.json beside this conversation's data dir (the CLI's
 *  ~/.gemini/antigravity-cli/settings.json; the desktop app keeps its rules in its UI), or — when the
 *  transcript does not say which — the union of both dirs, which is safe: every rule only ever makes us
 *  answer "no opinion". Empty when absent/unreadable. Read-only. */
export function loadAntigravityRules(transcriptPath: string | undefined): AntigravityPermissionRules {
  const out: AntigravityPermissionRules = { allow: [], ask: [], deny: [] };
  const known = antigravityDataDirFor(transcriptPath);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  for (const dir of known ? [known] : antigravityDataDirs()) {
    try {
      const p = (JSON.parse(readFileSync(`${dir}/settings.json`, "utf8")) as { permissions?: Record<string, unknown> }).permissions ?? {};
      out.allow.push(...list(p.allow)); out.ask.push(...list(p.ask)); out.deny.push(...list(p.deny));
    } catch { /* absent / unreadable → no rules from this dir */ }
  }
  return out;
}

/** Shell words that run the NEXT word as the command (their own `-flags` are skipped too). */
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nice", "time", "nohup", "xargs", "builtin"]);

/** Every word that may RUN as a command somewhere in `line`, basename'd and unquoted — deliberately
 *  loose (a false hit only makes us say "no opinion"): split on `;` `&` `|` newlines, `$(`, backticks,
 *  parentheses and braces; drop quotes and backslashes; skip `VAR=…` assignments; after a wrapper
 *  (sudo, env, command, xargs, …) every later non-flag word counts. Pure. */
export function commandWords(line: string): string[] {
  const out: string[] = [];
  for (const segment of line.split(/[;&|\n\r`(){}]|\$\(/)) {
    const words = segment.replace(/['"\\]/g, "").trim().split(/\s+/).filter(Boolean);
    const base = (w: string) => w.slice(w.lastIndexOf("/") + 1);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    if (i >= words.length) continue;
    const first = base(words[i]!);
    if (first) out.push(first);
    // After a wrapper, its own options (`sudo -u root`, `nice -n 5`) can't be told from the command
    // without knowing each wrapper's flags, so EVERY later word counts — loose is the safe direction.
    if (WRAPPERS.has(first)) for (const w of words.slice(i + 1)) if (!w.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) out.push(base(w));
  }
  return out;
}

/** A `regex:` rule's pattern: compiled, so a valid regex matches only what it matches; one that does not
 *  compile counts as matching everything (deny/ask side only — the safe reading). */
function regexMatches(pattern: string, target: string): boolean {
  try {
    return new RegExp(pattern).test(target);
  } catch {
    return true;
  }
}

/** Does a rule of `action` match `target`?
 *   - DENY/ASK side (`exact` false): LOOSE — a hit only ever makes us defer to Antigravity, so a command
 *     rule matches when its first word is ANY command word of the line (commandWords), whatever wraps
 *     or chains it (`sudo rm`, `/bin/rm`, `FOO=1 rm`, `ls && rm`, `$(rm …)`).
 *   - ALLOW side (`exact` true): STRICT — a plain single command whose words start with the rule's
 *     words; anything with separators, subshells, quotes, escapes or line breaks is never passed
 *     through, and a `regex:` allow rule never passes anything (the phone still asks). */
function ruleMatches(rule: string, action: string, target: string, workspace: string | undefined, exact: boolean): boolean {
  const m = /^([a-z_]+)\((.*)\)$/s.exec(rule.trim());
  if (!m || m[1] !== action) return false;
  const want = m[2]!.trim();
  if (want === "*") return true;
  if (want.startsWith("regex:")) return !exact && regexMatches(want.slice("regex:".length), target);
  if (action === "command") {
    const wantWords = want.split(/\s+/);
    if (!exact) {
      const first = wantWords[0]!.slice(wantWords[0]!.lastIndexOf("/") + 1);
      return want === target.trim() || commandWords(target).includes(first);
    }
    if (/[;&|$`<>(){}\n\r\\'"]/.test(target)) return false;
    const b = target.trim().split(/\s+/);
    return wantWords.length <= b.length && wantWords.every((w, i) => w === b[i]);
  }
  const base = isAbsolute(want) ? want : workspace ? resolve(workspace, want) : undefined;
  if (!base) return false;
  const root = base.replace(/\/+$/, "");
  return target === root || target.startsWith(`${root}/`);
}

export interface AntigravityApprovalRequest {
  sessionId: string;
  cwd?: string;
  transcriptPath?: string;
  /** Antigravity's tool name, and the card name the phone sees. */
  agyTool: string;
  toolName: "shell" | "Write" | "Edit";
  toolInput: Record<string, unknown>;
}

/** The phone request for one PreToolUse payload, or null = not ours to hold (answer the fallback at
 *  once): an unknown tool, no conversation id, no command/path, or a call the user's own allow rules
 *  already let run. Pure apart from the injected rules. */
export function antigravityApprovalRequest(
  input: Record<string, unknown>, rules: AntigravityPermissionRules = { allow: [], ask: [], deny: [] },
  protectedDirs: string[] = nomoProtectedDirs(),
): AntigravityApprovalRequest | null {
  const sessionId = antigravitySessionId(input);
  const call = input.toolCall as { name?: unknown; args?: unknown } | undefined;
  const agyTool = str(call?.name);
  if (!sessionId || !agyTool || !(agyTool in CARD_TOOL)) return null;
  const args = (typeof call?.args === "object" && call.args !== null ? call.args : {}) as Record<string, unknown>;
  const cwd = antigravityCwd(input);
  const toolName = CARD_TOOL[agyTool]!;
  let toolInput: Record<string, unknown>;
  let action: string, target: string;
  if (toolName === "shell") {
    const command = str(args.CommandLine) ?? str(args.command);
    if (!command) return null;
    const description = str(args.toolSummary);
    toolInput = { command, ...(description ? { description } : {}) };
    action = "command"; target = command;
  } else {
    const path = str(args.Path) ?? str(args.TargetFile) ?? str(args.AbsolutePath) ?? str(args.FilePath);
    if (!path) return null;
    toolInput = { file_path: path };
    action = "write_file"; target = cwd && !isAbsolute(path) ? resolve(cwd, path) : path;
  }
  const hit = (list: string[], exact: boolean) => list.some((r) => ruleMatches(r, action, target, cwd, exact));
  // Antigravity's precedence, Deny > Ask > Allow. A call the user's own rules DENY never reaches the
  // phone (an Allow there would answer auto_approve and override it): no opinion, Antigravity denies.
  if (hit(rules.deny, false)) return null;
  const isProtected = action === "write_file"
    && protectedDirs.some((d) => { const r = resolve(d); return target === r || resolve(target).startsWith(`${r}/`); });
  if (!isProtected && !hit(rules.ask, false) && hit(rules.allow, true)) return null;
  return { sessionId, ...(cwd ? { cwd } : {}), transcriptPath: str(input.transcriptPath), agyTool, toolName, toolInput };
}

/** runPermissionHook's emitted PermissionRequest line → Antigravity's decision. Anything that is not a
 *  clean allow/deny (nothing emitted, an unparseable line) is the fallback. */
export function antigravityDecision(line: string | undefined): string {
  if (!line) return ANTIGRAVITY_FALLBACK;
  try {
    const d = (JSON.parse(line) as { hookSpecificOutput?: { decision?: { behavior?: unknown; message?: unknown } } })
      .hookSpecificOutput?.decision;
    if (d?.behavior === "allow") return '{"decision":"auto_approve"}';
    if (d?.behavior === "deny") {
      return JSON.stringify({ decision: "deny", reason: str(d.message) ?? "Denied from phone" });
    }
  } catch { /* fall through */ }
  return ANTIGRAVITY_FALLBACK;
}

export interface AntigravityApprovalDeps {
  /** Overrides for the shared hold (tests: fetch, config, clock…). */
  hold?: PermissionHookDeps;
  rules?: (transcriptPath: string | undefined) => AntigravityPermissionRules;
  run?: typeof runPermissionHook;
  /** Stop-flag check (tests). Default: the real flag in SESSIONS_DIR. */
  stopRequested?: (sessionId: string) => Promise<boolean>;
  /** Has the hook's wrapper gone away (tests)? Default: our parent pid changed (reparented on its death)
   *  or we were sent SIGTERM (the wrapper's trap). */
  abandoned?: () => boolean;
  /** The plugin root Nomo's own skill commands are rebuilt under (tests). */
  pluginRoot?: string;
}

/** Set by the entry's SIGTERM handler (antigravity-approve.sh's trap on TERM/INT/HUP). */
let terminated = false;
export function markAntigravityApprovalTerminated(): void { terminated = true; }
const parentAtStart = process.ppid;
const defaultAbandoned = () => terminated || process.ppid !== parentAtStart;

/** The deny line a phone Stop answers with. */
export const ANTIGRAVITY_STOP_DENY = JSON.stringify({ decision: "deny", reason: ANTIGRAVITY_STOP_REASON });

/** One PreToolUse invocation → exactly one decision string. Never throws. */
export async function runAntigravityApproval(raw: string, deps: AntigravityApprovalDeps = {}): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return ANTIGRAVITY_FALLBACK;
    const input = parsed as Record<string, unknown>;
    const req = antigravityApprovalRequest(input, (deps.rules ?? loadAntigravityRules)(str(input.transcriptPath)));
    if (!req) return ANTIGRAVITY_FALLBACK;
    const stopRequested = () => (deps.stopRequested
      ?? ((id: string) => antigravityStopRequested(SESSIONS_DIR, id, Date.now())))(req.sessionId);
    if (await stopRequested()) return ANTIGRAVITY_STOP_DENY;
    // Nomo's OWN /nomo-* commands (status, approvals on, …) never become a phone card — but only when
    // paired (unpaired, Antigravity's own prompt decides) and only byte-for-byte the installed template.
    const command = req.toolName === "shell" ? str(req.toolInput.command) : undefined;
    if (command && isNomoSkillCommand(command, deps.pluginRoot)) {
      const config: Config | null = await (deps.hold?.loadConfigFn ?? loadConfig)();
      if (config) return '{"decision":"auto_approve"}';
    }
    // `permission_mode` / `agent_id` absent on purpose: the interactive arm, never the subagent pass-through.
    const stdin = JSON.stringify({
      session_id: req.sessionId,
      ...(req.cwd ? { cwd: req.cwd } : {}),
      ...(req.transcriptPath ? { transcript_path: req.transcriptPath } : {}),
      hook_event_name: "PermissionRequest",
      tool_name: req.toolName,
      tool_input: req.toolInput,
    });
    let line: string | undefined;
    let gone = false;
    const abandoned = () => (gone ||= (deps.abandoned ?? defaultAbandoned)());
    await (deps.run ?? runPermissionHook)({
      // Paused approvals (the shared no-hold flag): nothing to post — Antigravity's own prompt follows.
      delegate: async () => {},
      deadlineAt: (deps.hold?.now ?? Date.now)() + ANTIGRAVITY_HOLD_DEADLINE_MS,
      stopRequested,
      stopReason: ANTIGRAVITY_STOP_REASON,
      abandoned,
      ...deps.hold,
      readInput: async () => stdin,
      emit: (l) => { line = l; },
    }, "antigravity");
    // An abandoned hold (the agent killed our wrapper) has already withdrawn the card and settled the row
    // as WORKING inside runPermissionHook: a cancelled tool call is not necessarily a finished turn. The
    // real Stop, or the watchdog's idle net, ends it.
    return antigravityDecision(line);
  } catch {
    return ANTIGRAVITY_FALLBACK;
  }
}
