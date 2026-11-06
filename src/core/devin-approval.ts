// devin-approval — answer a Devin PermissionRequest from the phone (NOM-158).
//
// The Antigravity recipe (core/antigravity-approval.ts): build a Claude-shaped PermissionRequest stdin,
// hand it WHOLE to permission.ts's runPermissionHook (same relay, same gates, same decisionPending card,
// same approvals pause switch), capture the one decision line it emits, and translate it into Devin's
// wire. Run by the PermissionRequest entry in ~/.config/devin/config.json (devin-install.mjs).
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
// (Devin's EditInput/ReadInput), webfetch url. "ALWAYS ALLOW" IS NOT OFFERED (the phone's matrix);
// an old phone that sends allow_always / allow_mode anyway gets a plain approve.

import { runDevinHook } from "./devin";
import { runPermissionHook, type PermissionHookDeps } from "./permission";

export const DEVIN_APPROVAL_TIMEOUT_S = 86_400;
export const DEVIN_HOLD_DEADLINE_MS = (DEVIN_APPROVAL_TIMEOUT_S - 600) * 1000;
export const DEVIN_ENTRY_CAP_MS = (DEVIN_APPROVAL_TIMEOUT_S - 300) * 1000;

/** Tools whose permission never goes to the phone (Devin's own prompt only). */
export const DEVIN_NO_HOLD_TOOLS = new Set(["ask_user_question"]);

/** Devin tool → the card name the phone already draws (CCShellCommandDisplay for `shell`, the file for
 *  Write/Edit/Read, the URL for WebFetch). Every other tool keeps its raw name. */
const CARD_TOOL: Record<string, string> = {
  exec: "shell",
  write: "Write",
  edit: "Edit",
  read: "Read",
  webfetch: "WebFetch",
};

const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** The Claude-shaped stdin for one Devin PermissionRequest, or undefined = not ours to hold (no opinion
 *  at once). `permission_mode` / `agent_id` are absent on purpose: the interactive arm. Pure. */
export function devinPermissionStdin(input: Record<string, unknown>, cwd?: string): string | undefined {
  const sessionId = str(input.session_id);
  const tool = str(input.tool_name);
  if (!sessionId || !SAFE_ID.test(sessionId) || !tool || DEVIN_NO_HOLD_TOOLS.has(tool)) return undefined;
  const toolInput = typeof input.tool_input === "object" && input.tool_input !== null && !Array.isArray(input.tool_input)
    ? input.tool_input as Record<string, unknown> : {};
  return JSON.stringify({
    session_id: sessionId,
    ...(cwd ? { cwd } : {}),
    hook_event_name: "PermissionRequest",
    tool_name: CARD_TOOL[tool] ?? tool,
    tool_input: toolInput,
  });
}

/** runPermissionHook's emitted line → Devin's decision; "" = no opinion (print nothing). Every allow
 *  variant (allow / allow_always / allow_mode all emit behavior "allow") is a plain approve. */
export function devinDecision(line: string | undefined): string {
  if (!line) return "";
  try {
    const d = (JSON.parse(line) as { hookSpecificOutput?: { decision?: { behavior?: unknown; message?: unknown } } })
      .hookSpecificOutput?.decision;
    if (d?.behavior === "allow") return '{"decision":"approve"}';
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
    return devinDecision(line);
  } catch {
    return "";
  }
}
