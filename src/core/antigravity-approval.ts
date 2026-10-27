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
// call the user's own settings.json `permissions.allow` already allows by a plain prefix. Workspace
// writes are NOT exempt: agy 1.4.8 prompted for a write inside its own workspace in the spike, so the
// docs' "workspace writes are auto-allowed" cannot be relied on.
//
// "ALWAYS ALLOW" IS NOT OFFERED: `permissionOverrides` persistence is undocumented and testing it would
// write to the user's real ~/.gemini. A phone that sends allow_always anyway gets a plain auto_approve.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { antigravityDataDirFor } from "./adapter";
import { antigravityCwd, antigravitySessionId } from "./antigravity";
import { runPermissionHook, type PermissionHookDeps } from "./permission";

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

/** `permissions.{allow,ask,deny}` from the settings.json beside this conversation's data dir; empty when
 *  absent/unreadable. Read-only. */
export function loadAntigravityRules(transcriptPath: string | undefined): AntigravityPermissionRules {
  const empty = { allow: [], ask: [], deny: [] };
  const dir = antigravityDataDirFor(transcriptPath);
  if (!dir) return empty;
  try {
    const p = (JSON.parse(readFileSync(`${dir}/settings.json`, "utf8")) as { permissions?: Record<string, unknown> }).permissions ?? {};
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { allow: list(p.allow), ask: list(p.ask), deny: list(p.deny) };
  } catch {
    return empty;
  }
}

/** Does a rule of `action` possibly match `target`? `exact` (allow side) accepts only a literal word
 *  prefix / path prefix; otherwise (ask/deny side) a `regex:` rule counts as a match — the safe reading.
 *  ponytail: prefix + `*` only; regex allow rules and modes (auto/accept-edits) still route to the phone. */
function ruleMatches(rule: string, action: string, target: string, workspace: string | undefined, exact: boolean): boolean {
  const m = /^([a-z_]+)\((.*)\)$/s.exec(rule.trim());
  if (!m || m[1] !== action) return false;
  const want = m[2]!.trim();
  if (want === "*") return true;
  if (want.startsWith("regex:")) return !exact;
  if (action === "command") {
    if (want === target.trim()) return true;
    // A compound line could smuggle a second command past a prefix rule: never prefix-match one.
    if (/[;&|$`<>(){}\n]/.test(target)) return false;
    const a = want.split(/\s+/), b = target.trim().split(/\s+/);
    return a.length <= b.length && a.every((w, i) => w === b[i]);
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
  if (hit(rules.allow, true) && !hit(rules.ask, false) && !hit(rules.deny, false)) return null;
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
}

/** One PreToolUse invocation → exactly one decision string. Never throws. */
export async function runAntigravityApproval(raw: string, deps: AntigravityApprovalDeps = {}): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return ANTIGRAVITY_FALLBACK;
    const input = parsed as Record<string, unknown>;
    const req = antigravityApprovalRequest(input, (deps.rules ?? loadAntigravityRules)(str(input.transcriptPath)));
    if (!req) return ANTIGRAVITY_FALLBACK;
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
    await (deps.run ?? runPermissionHook)({
      // Paused approvals (the shared no-hold flag): nothing to post — Antigravity's own prompt follows.
      delegate: async () => {},
      deadlineAt: (deps.hold?.now ?? Date.now)() + ANTIGRAVITY_HOLD_DEADLINE_MS,
      ...deps.hold,
      readInput: async () => stdin,
      emit: (l) => { line = l; },
    }, "antigravity");
    return antigravityDecision(line);
  } catch {
    return ANTIGRAVITY_FALLBACK;
  }
}
