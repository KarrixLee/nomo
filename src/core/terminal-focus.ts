// terminal-focus — bring the macOS window showing a given process's terminal to the front.
//
// The agent-AGNOSTIC half of the phone's "open this session on my Mac" command. WHICH process is a
// session's interactive TUI is agent-specific and lives in adapter.ts (AgentAdapter.locateTuiPid);
// everything here works purely off a pid and knows nothing about Claude, Codex, or sessions.
//
// How a pid becomes a window:
//   0. if herdr owns the pty (the pid or an ancestor IS a herdr process), the pane list — not the
//      tty — is the correlation key, so that branch is taken FIRST and the tty is never consulted,
//   1. the pid's controlling tty (`ps -o tty=` → "ttys004" → the device path "/dev/ttys004"), which
//      the DESKTOP agent apps (Claude, Codex) are exempt from for the same reason herdr is: their
//      conversation windows run with no controlling tty, so a tty-first refusal no-ops the command,
//   2. the OWNING terminal application, from the pid's ancestor chain's argv (Terminal.app, iTerm2,
//      Ghostty, WezTerm, Alacritty, kitty, Hyper, Warp, VS Code, and the Claude/Codex desktop apps),
//   3. for the two emulators with a scriptable tty→tab mapping (Terminal.app, iTerm2), an AppleScript
//      that finds the tab/session whose `tty` is that device path, selects it and raises its window;
//      for everything else — and for a tty scan that matches nothing — merely ACTIVATING the owning
//      app. Coarse, but it can never raise the WRONG terminal window, which is the invariant that
//      matters: a user who asked for their session must not be dumped into someone else's.
//
// Contract: never throws, never writes to stdout, and a refusal is always a typed result. macOS
// Automation (TCC) gates the very first osascript at runtime — it either prompts the user or fails
// with errAEEventNotPermitted (-1743); either way that surfaces here as {ok:false,
// reason:"osascript-failed"} and the command simply no-ops until the user grants permission.
//
// PORTABLE: no `Bun.*`; node >= 18 (node:child_process + node:util only).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRealTty, pidAncestors, pidCommand } from "./shared";
import type { AgentKind, AgentKindWire, SessionRecord } from "./shared";

const execFileP = promisify(execFile);

/** Hard ceiling on ANY osascript run. Existing execFileP calls in this codebase set no timeout, but
 *  AppleScript can block indefinitely — on a modal dialog, a hung terminal app, or the TCC consent
 *  prompt itself — and this runs inside the watchdog's sweep loop, which must keep its cadence. */
const OSASCRIPT_TIMEOUT_MS = 4000;
const HERDR_TIMEOUT_MS = 4000;

/** How the window was raised. `terminal-app`/`iterm2` mean the EXACT tab/session for that tty was
 *  selected; `app-activate` means only the owning application was brought forward. */
export type FocusVia = "terminal-app" | "iterm2" | "app-activate" | "herdr";

/** Why nothing was focused. `no-tty` — the pid holds no real controlling terminal (dead, or a
 *  headless/daemon process). `unsupported` — not macOS, or no known terminal application owns the
 *  pid. `osascript-failed` — the AppleScript bridge errored (most likely a denied/unprompted TCC
 *  Automation permission, -1743), timed out, or the app refused the event. */
export type FocusFailure =
  | "no-tty"
  | "unsupported"
  | "osascript-failed"
  | "herdr-ambiguous"
  | "herdr-cli-failed";

export type HerdrFocusReason = "herdr-focused" | "focused-detached";

export type FocusResult =
  | { ok: true; via: FocusVia; reason?: HerdrFocusReason }
  | { ok: false; reason: FocusFailure };

/** Session evidence herdr needs because its daemon owns the TUI pty: the pane, rather than the pid's
 *  terminal ancestry, is correlated to the record. */
export interface FocusContext {
  /** WIRE-typed (see AgentKindWire): the caller reads it off the session record, which a NEWER peer
   *  install may have stamped with a kind this build has never heard of. Nothing here coerces it —
   *  the exact-id correlation below still works for such a session (herdr publishes the agent's own
   *  name on the pane), and the per-kind fuzzy fallback simply has no entry for it, which is the same
   *  "no signal → refuse" outcome a known-but-unlisted agent already gets. */
  agent: AgentKindWire;
  record: SessionRecord;
  /** The session's id — the agent's OWN uuid, which herdr publishes per pane as `agent_session.value`.
   *  It is the only EXACT correlation key available, so it is required: a SessionRecord does not carry
   *  its own id (the id is the record's FILENAME), and the caller that has one always knows it. */
  sessionId: string;
}

export interface ExecFileResult {
  stdout: string;
  stderr?: string;
  /** The real promisified execFile rejects on non-zero. This optional field lets unit seams model an
   *  exited child directly too; absent means zero. */
  exitCode?: number;
}

/** Injectable seams so every branch is unit-testable without a real desktop. NOTHING here spawns a
 *  process when all four are supplied. */
export interface FocusDeps {
  /** Defaults to process.platform; the module is a no-op anywhere but darwin. */
  platform?: string;
  /** The pid's controlling tty as `ps` prints it ("ttys004", "??"). */
  ttyOf?: (pid: number) => Promise<string | undefined>;
  /** Ancestor pid chain (shared.pidAncestors). */
  ancestorsOf?: (pid: number) => number[];
  /** A pid's full argv (shared.pidCommand). */
  commandOf?: (pid: number) => string | undefined;
  /** Run one AppleScript and return its trimmed stdout. Rejects on any osascript failure. */
  osascript?: (script: string) => Promise<string>;
  /** Session record used only when the TUI ancestry reveals a herdr daemon. */
  context?: FocusContext;
  /** execFile seam for herdr and its client-process scan. No shell is ever involved. */
  execFile?: (file: string, args: string[], options: { timeout: number }) => Promise<ExecFileResult>;
  /** Best-effort diagnostics sink (the watchdog passes traceSession). */
  trace?: (event: object) => void;
}

interface HerdrPane {
  agent: string;
  /** herdr's own record of WHICH agent session this pane is running (`{agent, kind:"id", source,
   *  value}`). Present on every claude/grok pane sampled 2026-08-14; a codex pane has none, and an
   *  older herdr has none anywhere — hence optional, and hence the fuzzy fallback below stays. */
  agent_session?: { agent?: string; value?: string };
  agent_status?: string;
  cwd?: string;
  tab_id: string;
  terminal_title_stripped?: string;
}

const HERDR_TAB_ID = /^[A-Za-z0-9:]+$/;

function commandTokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function isHerdrCommand(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  const executable = commandTokens(command)[0]?.replace(/^['"]|['"]$/g, "");
  return typeof executable === "string" && /(?:^|\/)herdr$/.test(executable);
}

function isHerdrServer(command: string | undefined): boolean {
  return typeof command === "string"
    && isHerdrCommand(command)
    && commandTokens(command).slice(1).includes("server");
}

/** Whether `pid` or any ancestor IS a herdr process — i.e. whether herdr's daemon owns this pty.
 *  EXPORTED because the locate step (adapter.claudeLocateTuiPid) has to ask the same question before
 *  it applies its own tty gate: under herdr the pid's controlling tty is not the signal, so a locate
 *  that rejected a tty-less pid would never let this module see it at all. A dead pid has no readable
 *  ancestry and no command, so it can never answer true here — which is what keeps the escape hatch
 *  from resurrecting a stale record onto a live pane. */
export function ancestryContainsHerdr(
  pid: number,
  ancestorsOf: (pid: number) => number[] = pidAncestors,
  commandOf: (pid: number) => string | undefined = pidCommand,
): boolean {
  let ancestors: number[];
  try { ancestors = ancestorsOf(pid); } catch { ancestors = []; }
  for (const candidate of [pid, ...ancestors]) {
    try {
      if (isHerdrCommand(commandOf(candidate))) return true;
    } catch { /* a raced process contributes no evidence */ }
  }
  return false;
}

function recordTitleMatchesPane(recordTitle: unknown, paneTitle: unknown): boolean {
  if (typeof recordTitle !== "string" || typeof paneTitle !== "string") return false;
  if (recordTitle === paneTitle) return true;
  // Records are occasionally fitted for display with a trailing ellipsis. Only that explicit
  // truncation marker enables prefix matching; arbitrary prefixes would collide too easily.
  const match = /^(.*?)(?:\u2026|\.{3})$/.exec(recordTitle);
  return !!match && match[1].length > 0 && paneTitle.startsWith(match[1]);
}

/** The per-agent fuzzy correlation signal used only when herdr published no `agent_session` id: the
 *  claim "this pane is that record" for an agent whose panes carry nothing exact. Claude's is the
 *  pane's stripped terminal title vs the record title; Codex's is exact cwd equality (its panes have
 *  no title worth matching). An agent ABSENT from this table has no fuzzy signal at all — the
 *  correlation then refuses rather than borrowing another agent's rule. OpenCode is deliberately
 *  absent: its desktop sessions never reach herdr (the app owns no pty), and its CLI sessions belong
 *  to a server process that no pane runs, so cwd equality would be a guess dressed as evidence. */
const HERDR_FUZZY_SIGNAL: Partial<Record<AgentKindWire, (pane: HerdrPane, context: FocusContext) => boolean>> = {
  claude: (pane, context) => recordTitleMatchesPane(context.record.title, pane.terminal_title_stripped),
  codex: (pane, context) => typeof context.record.origin?.cwd === "string"
    && context.record.origin.cwd.length > 0
    && pane.cwd === context.record.origin.cwd,
  // Keyed WIRE-wide so an unknown agent literal reads back `undefined` (no signal) instead of failing
  // to index; `satisfies` keeps the KEYS checked against the kinds this build implements, so a typo or
  // a stale kind still fails to compile.
} satisfies Partial<Record<AgentKind, (pane: HerdrPane, context: FocusContext) => boolean>>;

function correlateHerdrPane(context: FocusContext, panes: HerdrPane[]): HerdrPane | undefined {
  // The EXACT signal first: herdr publishes the agent's own session id on the pane, so the id the
  // command already named is ground truth and short-circuits everything below — no title, no cwd, no
  // status tie-break. Correlating by title instead is what made "Open on Mac" fail for any pane still
  // showing its default title (field report 2026-08-14: record title "hi" vs pane "Claude Code").
  // Cross-agent is refused even on an id hit, and a duplicated id is ambiguous rather than a coin
  // flip. A pane with no `agent_session` (codex, or an older herdr) contributes nothing here and
  // falls through to the fuzzy signals exactly as before. `?.` is also the malformed-value guard:
  // any non-object agent_session simply reads back undefined.
  const byId = panes.filter((pane) => pane.agent === context.agent
    && pane.agent_session?.value === context.sessionId
    && (pane.agent_session?.agent ?? context.agent) === context.agent);
  if (byId.length > 0) return byId.length === 1 ? byId[0] : undefined;

  // The FUZZY fallback, looked up BY AGENT rather than branched on. This was
  // `context.agent === "claude" ? title-match : cwd-match-on-codex-panes`, i.e. every non-Claude
  // agent silently meant "codex" — dead only because no third agent kind could reach here. An
  // OpenCode record hitting that ternary would have correlated to a CODEX pane sharing its cwd and
  // raised the wrong window. Keyed lookup makes the default for an unlisted agent NO fuzzy signal
  // (id-only, then refuse) instead of an inherited one: a new agent has to prove a signal to get one.
  const fuzzy = HERDR_FUZZY_SIGNAL[context.agent];
  let candidates = fuzzy === undefined
    ? []
    : panes.filter((pane) => pane.agent === context.agent && fuzzy(pane, context));

  // Status may break a primary-signal tie, but can never introduce a pane that title/cwd rejected.
  if (candidates.length > 1) {
    const working = candidates.filter((pane) => pane.agent_status === "working");
    if (working.length > 0) candidates = working;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function parseHerdrPanes(stdout: string): HerdrPane[] {
  const parsed: unknown = JSON.parse(stdout);
  const panes = (parsed as { result?: { panes?: unknown } })?.result?.panes;
  if (!Array.isArray(panes)) throw new Error("invalid herdr pane list");
  return panes.filter((value): value is HerdrPane => {
    if (!value || typeof value !== "object") return false;
    const pane = value as Partial<HerdrPane>;
    return typeof pane.agent === "string" && typeof pane.tab_id === "string";
  });
}

function parsePsProcesses(stdout: string): Array<{ pid: number; tty: string; command: string }> {
  const out: Array<{ pid: number; tty: string; command: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    if (Number.isFinite(pid)) out.push({ pid, tty: match[2], command: match[3] });
  }
  return out;
}

async function runExecFile(
  file: string, args: string[], options: { timeout: number }, deps: FocusDeps,
): Promise<ExecFileResult> {
  if (deps.execFile) return deps.execFile(file, args, options);
  const { stdout, stderr } = await execFileP(file, args, options);
  return { stdout: String(stdout), stderr: String(stderr) };
}

/** A terminal emulator we can recognise from argv and activate by bundle id. `script` is the
 *  tty→window strategy: only Terminal.app and iTerm2 expose a scriptable tty per tab/session; every
 *  other entry is activate-only by design (guessing a window in kitty/WezTerm/Ghostty from a tty is
 *  not possible over AppleScript, and a wrong guess is the one outcome worth avoiding). */
export interface TerminalApp {
  id: "terminal-app" | "iterm2" | "ghostty" | "wezterm" | "alacritty" | "kitty" | "hyper" | "warp" | "vscode" | "claude-desktop" | "codex-desktop" | "opencode-desktop";
  /** CFBundleIdentifier — `tell application id "…"` binds to the installed copy, wherever it lives. */
  bundleId: string;
  /** Matched against a process's full argv (the .app bundle path, or the binary name for the
   *  bundle-less launches WezTerm/kitty/Alacritty can have). */
  match: RegExp;
  /** This owner is a GUI AGENT APP, not an emulator: the process it owns holds no controlling terminal
   *  at all, and its window is raised by bundle id without one. Declared on the TABLE — rather than
   *  re-tested as an id comparison at the gate — so the next such app is one row and cannot forget the
   *  exemption. Absent for every real emulator: there a tty-less pid genuinely owns no window, and
   *  refusing is correct. */
  ttyless?: true;
}

/** The known emulators, most specific first. VS Code's integrated terminal is included because a
 *  session started from it is genuinely owned by VS Code (activate-only). The two DESKTOP agent apps
 *  are the entries that are not emulators at all: a desktop conversation window runs its agent with
 *  NO controlling tty, so each is the owning front-end in exactly the sense this table means, and
 *  activating it is the whole of what can be done (see the entries' notes).
 *  Ordering is irrelevant across processes — owningTerminalApp takes the NEAREST matching ancestor —
 *  so a real terminal always wins over an app further up the chain; within one argv the first match
 *  wins, which is why the desktop entries sit last. */
const TERMINAL_APPS: TerminalApp[] = [
  { id: "terminal-app", bundleId: "com.apple.Terminal", match: /\/Terminal\.app\// },
  { id: "iterm2", bundleId: "com.googlecode.iterm2", match: /\/iTerm\.app\/|\/iTerm2\.app\// },
  { id: "ghostty", bundleId: "com.mitchellh.ghostty", match: /\/Ghostty\.app\/|(?:^|\/)ghostty(?:\s|$)/ },
  { id: "wezterm", bundleId: "com.github.wez.wezterm", match: /\/WezTerm\.app\/|(?:^|\/)wezterm(?:-gui)?(?:\s|$)/ },
  { id: "alacritty", bundleId: "org.alacritty", match: /\/Alacritty\.app\/|(?:^|\/)alacritty(?:\s|$)/ },
  { id: "kitty", bundleId: "net.kovidgoyal.kitty", match: /\/kitty\.app\/|(?:^|\/)kitty(?:\s|$)/ },
  { id: "hyper", bundleId: "co.zeit.hyper", match: /\/Hyper\.app\// },
  { id: "warp", bundleId: "dev.warp.Warp-Stable", match: /\/Warp\.app\// },
  // `Code Helper` is PATH-ANCHORED (`/Code Helper`). Unanchored it was a substring rule, and the
  // OpenCode desktop app's own Electron helper — `…/Frameworks/OpenCode Helper.app/Contents/MacOS/
  // OpenCode Helper` — matched it, resolving to VS Code and activating the WRONG APP (observed live
  // 2026-08-19: owningTerminalApp(<OpenCode utility pid>) === "vscode"). VS Code's real helper is
  // always `…/Frameworks/Code Helper*.app/…`, so the leading slash costs nothing and closes the class.
  { id: "vscode", bundleId: "com.microsoft.VSCode", match: /\/Visual Studio Code\.app\/|\/Code\.app\/|\/Code Helper/ },
  // The Claude desktop app. Matched on the bundle path fragment shared by its Electron main
  // (`…/Claude.app/Contents/MacOS/Claude`) and the `disclaimer` launcher that sits between it and the
  // session's `claude` (`…/Claude.app/Contents/Helpers/disclaimer`) — location-agnostic (never
  // `/Applications`) and version-agnostic. CASE MATTERS: the bundled binary the app runs lives under a
  // lowercase `…/claude-code/<version>/claude.app/…`, which this deliberately does NOT match, so the
  // owner resolves to the app rather than to the session's own process.
  // ponytail: app-activate is the ceiling — nothing raises a specific conversation tab inside the
  // Electron window. The two deep links that exist do not close it: `claude://code/<id>` addresses the
  // app's OWN `session_`/`cse_`-prefixed ids (which nothing here ever sees) behind a runtime feature
  // gate, and `claude://resume?session=<uuid>` is an IMPORT that rewrites the session's transcript on
  // disk (verified in app.asar, Claude 1.30096.1). Upgrade path: a deep link that takes a CC session
  // uuid and focuses it without mutating anything.
  { id: "claude-desktop", bundleId: "com.anthropic.claudefordesktop", match: /\/Claude\.app\/Contents\//, ttyless: true },
  // The Codex desktop app — shipped as `ChatGPT.app`, bundle id com.openai.codex. Same ceiling and
  // same tty-lessness as the Claude entry, but it is reached differently: a desktop conversation is
  // hosted by an app-server whose ancestry frequently does NOT include the bundle (the standalone
  // ~/.codex daemon is parented to launchd), so codexLocateTuiPid identifies the session from its
  // rollout and hands this module the APP's own Electron main pid — whose argv is what this matches.
  // A session that DOES run under the bundle's own `…/ChatGPT.app/Contents/Resources/codex` resolves
  // here by plain ancestry too, so both process shapes land on one rule.
  { id: "codex-desktop", bundleId: "com.openai.codex", match: /\/ChatGPT\.app\/Contents\//, ttyless: true },
  // The OpenCode desktop app (Electron, bundle id ai.opencode.desktop). The plugin is resident in the
  // app's node UTILITY process (`…/OpenCode.app/Contents/Frameworks/OpenCode Helper.app/…
  // --utility-sub-type=node.mojom.NodeService`, verified against the running app 2026-08-19), which is
  // tty-less exactly like the two entries above — hence `ttyless`. The bundle-path fragment matches the
  // Electron main AND every helper, so ancestry from the utility process resolves here either way;
  // opencodeLocateTuiPid hands over the MAIN pid, which outlives a recycled helper.
  // ponytail: app-activate is the ceiling and it is a COARSER promise than the other two entries make
  // — this raises the OpenCode app, not the session's window. Upgrade path: an OpenCode deep link (or
  // a plugin-side window API) that can address one session's window.
  { id: "opencode-desktop", bundleId: "ai.opencode.desktop", match: /\/OpenCode\.app\/Contents\//, ttyless: true },
];

/** The terminal application owning `pid`, found by walking its ancestor chain's argv. The chain is
 *  walked oldest-last (parent first), so the NEAREST matching ancestor wins — a shell nested inside a
 *  tmux inside iTerm still resolves to iTerm, and a VS Code window hosting a terminal resolves to VS
 *  Code rather than to whatever launched VS Code. Pure given its two injected readers. */
export function owningTerminalApp(
  pid: number,
  ancestorsOf: (pid: number) => number[] = pidAncestors,
  commandOf: (pid: number) => string | undefined = pidCommand,
): TerminalApp | undefined {
  let chain: number[] = [];
  try { chain = ancestorsOf(pid); } catch { chain = []; }
  for (const candidate of [pid, ...chain]) {
    let command: string | undefined;
    try { command = commandOf(candidate); } catch { continue; }
    if (typeof command !== "string" || command.length === 0) continue;
    const app = TERMINAL_APPS.find((a) => a.match.test(command));
    if (app) return app;
  }
  return undefined;
}

/** The tty device path AppleScript compares against, from whatever `ps` printed. macOS prints
 *  "ttys004" (and, in some formats, a bare "s004"); an absolute "/dev/…" is passed through. Undefined
 *  when the value is not a real controlling terminal or is not a plain device name — the strict
 *  /^\/dev\/tty[a-z0-9]+$/ shape is what makes interpolating it into an AppleScript string literal
 *  safe (execFile means no shell is involved, but AppleScript quoting is still worth closing). */
export function ttyDevicePath(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!isRealTty(trimmed)) return undefined;
  const bare = trimmed.startsWith("/dev/") ? trimmed.slice(5) : trimmed;
  const name = /^s[0-9]+$/.test(bare) ? `tty${bare}` : bare;
  const path = `/dev/${name}`;
  return isTtyDevicePath(path) ? path : undefined;
}

/** The validator the script builders enforce before interpolating. */
export function isTtyDevicePath(path: string): boolean {
  return /^\/dev\/tty[a-z0-9]+$/.test(path);
}

/** Terminal.app: walk windows → tabs, compare each tab's `tty`, then select the tab, raise its window
 *  and activate. Returns "ok" on a match and "none" when the tty belongs to no open tab (the window
 *  was closed, or the process is nested somewhere Terminal doesn't expose), which the caller degrades
 *  to a plain activate. */
export function terminalAppScript(devPath: string): string {
  if (!isTtyDevicePath(devPath)) throw new Error("unsafe tty path");
  return [
    `tell application "Terminal"`,
    `\trepeat with w in windows`,
    `\t\trepeat with t in tabs of w`,
    `\t\t\tif tty of t is "${devPath}" then`,
    `\t\t\t\tset selected of t to true`,
    `\t\t\t\tset index of w to 1`,
    `\t\t\t\tactivate`,
    `\t\t\t\treturn "ok"`,
    `\t\t\tend if`,
    `\t\tend repeat`,
    `\tend repeat`,
    `end tell`,
    `return "none"`,
  ].join("\n");
}

/** iTerm2: windows → tabs → sessions, compare each session's `tty`, then select session, tab and
 *  window before activating. Same "ok"/"none" contract as terminalAppScript. */
export function iterm2Script(devPath: string): string {
  if (!isTtyDevicePath(devPath)) throw new Error("unsafe tty path");
  return [
    `tell application "iTerm"`,
    `\trepeat with w in windows`,
    `\t\trepeat with t in tabs of w`,
    `\t\t\trepeat with s in sessions of t`,
    `\t\t\t\tif tty of s is "${devPath}" then`,
    `\t\t\t\t\tselect s`,
    `\t\t\t\t\tselect t`,
    `\t\t\t\t\tselect w`,
    `\t\t\t\t\tactivate`,
    `\t\t\t\t\treturn "ok"`,
    `\t\t\t\tend if`,
    `\t\t\tend repeat`,
    `\t\tend repeat`,
    `\tend repeat`,
    `end tell`,
    `return "none"`,
  ].join("\n");
}

/** The coarse fallback: bring the owning application forward without touching any window. Bundle id
 *  (not `open -a "<name>"`) so it binds to the installed copy regardless of where it lives, and so
 *  every invocation in this module goes through the SAME osascript seam. */
export function activateScript(bundleId: string): string {
  if (!/^[A-Za-z0-9.\-]+$/.test(bundleId)) throw new Error("unsafe bundle id");
  return `tell application id "${bundleId}" to activate`;
}

/** Run one AppleScript with an explicit timeout. Rejects on any osascript failure (including TCC's
 *  errAEEventNotPermitted / -1743, which is what an unprompted or denied Automation permission looks
 *  like from here). */
async function runOsascript(script: string): Promise<string> {
  const { stdout } = await execFileP("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
  return String(stdout).trim();
}

/** The controlling tty of a pid via `ps -o tty= -p <pid>`; undefined on any failure. */
async function ttyViaPs(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("ps", ["-o", "tty=", "-p", String(pid)]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function note(deps: FocusDeps, event: object): void {
  try { deps.trace?.(event); } catch { /* diagnostics only */ }
}

async function focusHerdr(
  pid: number,
  deps: FocusDeps,
  ancestorsOf: (pid: number) => number[],
  commandOf: (pid: number) => string | undefined,
): Promise<FocusResult> {
  const context = deps.context;
  if (!context) {
    note(deps, { event: "terminal-focus", pid, result: "ambiguous", reason: "herdr-ambiguous" });
    return { ok: false, reason: "herdr-ambiguous" };
  }

  let pane: HerdrPane | undefined;
  try {
    const listed = await runExecFile("herdr", ["pane", "list"], { timeout: HERDR_TIMEOUT_MS }, deps);
    if ((listed.exitCode ?? 0) !== 0) throw new Error("herdr pane list failed");
    pane = correlateHerdrPane(context, parseHerdrPanes(String(listed.stdout)));
  } catch {
    note(deps, { event: "terminal-focus", pid, result: "unsupported", reason: "herdr-cli-failed" });
    return { ok: false, reason: "herdr-cli-failed" };
  }

  if (!pane) {
    note(deps, { event: "terminal-focus", pid, result: "ambiguous", reason: "herdr-ambiguous" });
    return { ok: false, reason: "herdr-ambiguous" };
  }
  if (!HERDR_TAB_ID.test(pane.tab_id)) {
    note(deps, { event: "terminal-focus", pid, result: "unsupported", reason: "herdr-cli-failed" });
    return { ok: false, reason: "herdr-cli-failed" };
  }

  try {
    // Output may be a JSON result or plain text in released herdr versions. Exit zero is the
    // command's contract, so stdout is intentionally not parsed.
    const focused = await runExecFile(
      "herdr", ["tab", "focus", pane.tab_id], { timeout: HERDR_TIMEOUT_MS }, deps,
    );
    if ((focused.exitCode ?? 0) !== 0) throw new Error("herdr tab focus failed");
  } catch {
    note(deps, { event: "terminal-focus", pid, result: "unsupported", reason: "herdr-cli-failed" });
    return { ok: false, reason: "herdr-cli-failed" };
  }

  let app: TerminalApp | undefined;
  try {
    const scanned = await runExecFile(
      "ps", ["-axo", "pid=,tty=,args="], { timeout: HERDR_TIMEOUT_MS }, deps,
    );
    if ((scanned.exitCode ?? 0) === 0) {
      const apps = new Map<string, TerminalApp>();
      for (const process of parsePsProcesses(String(scanned.stdout))) {
        if (!isRealTty(process.tty) || !isHerdrCommand(process.command) || isHerdrServer(process.command)) continue;
        const owner = owningTerminalApp(process.pid, ancestorsOf, commandOf);
        if (owner) apps.set(owner.bundleId, owner);
      }
      // Several client processes inside the same GUI application are safe; distinct host apps are
      // not, because activating one would be a guess.
      if (apps.size === 1) app = apps.values().next().value;
    }
  } catch { /* the tab is already focused; a client scan failure degrades to detached */ }

  if (!app) {
    note(deps, { event: "terminal-focus", pid, result: "focused", via: "herdr", reason: "focused-detached" });
    return { ok: true, via: "herdr", reason: "focused-detached" };
  }

  try {
    await (deps.osascript ?? runOsascript)(activateScript(app.bundleId));
    note(deps, { event: "terminal-focus", pid, result: "focused", via: "herdr", app: app.id, reason: "herdr-focused" });
    return { ok: true, via: "herdr", reason: "herdr-focused" };
  } catch {
    note(deps, { event: "terminal-focus", pid, result: "osascript-failed", app: app.id });
    return { ok: false, reason: "osascript-failed" };
  }
}

/** Bring the macOS terminal window running `pid` to the front. See the module header for the full
 *  strategy. Never throws; every refusal is a typed {ok:false} result. */
export async function focusTerminalForPid(pid: number, deps: FocusDeps = {}): Promise<FocusResult> {
  try {
    if ((deps.platform ?? process.platform) !== "darwin") {
      note(deps, { event: "terminal-focus", pid, result: "unsupported", why: "not-darwin" });
      return { ok: false, reason: "unsupported" };
    }
    const ancestorsOf = deps.ancestorsOf ?? pidAncestors;
    const commandOf = deps.commandOf ?? pidCommand;
    // herdr FIRST, before the tty gate. Its daemon owns the TUI pty, so a session's process can
    // legitimately have no controlling tty of its own — a Claude background/forked task hosted by
    // `claude daemon run` reads back "??" — while its herdr TAB is open and uniquely correlatable.
    // Gating on the tty first refused exactly that case as no-tty and made "Open on Mac" a silent
    // no-op for it (field report 2026-08-02). Correlation is by pane, never by tty, so nothing below
    // this line is needed to raise the right window.
    if (ancestryContainsHerdr(pid, ancestorsOf, commandOf)) {
      return await focusHerdr(pid, deps, ancestorsOf, commandOf);
    }
    let rawTty: string | undefined;
    try { rawTty = await (deps.ttyOf ?? ttyViaPs)(pid); } catch { rawTty = undefined; }
    const devPath = ttyDevicePath(rawTty);
    const app = owningTerminalApp(pid, ancestorsOf, commandOf);
    // The tty gate, with the same exemption the herdr branch takes above and for the same reason: a
    // DESKTOP agent app's window has no controlling tty at all ("??"), so a tty-first refusal made
    // "Open on Mac" a silent no-op for every one of its sessions. The exemption is scoped to the
    // owners that declare `ttyless` — for every emulator a tty-less pid still owns no window and there
    // is nothing to raise.
    if (devPath === undefined && app?.ttyless !== true) {
      note(deps, { event: "terminal-focus", pid, result: "no-tty", tty: rawTty ?? "" });
      return { ok: false, reason: "no-tty" };
    }
    if (!app) {
      note(deps, { event: "terminal-focus", pid, result: "unsupported", why: "no-owning-app" });
      return { ok: false, reason: "unsupported" };
    }
    const osascript = deps.osascript ?? runOsascript;
    try {
      // The two emulators that can map a tty to an exact tab/session get the precise treatment. Both
      // always reach here WITH a devPath (only the desktop app is exempt from the gate above); the
      // check is what tells the compiler so.
      if (devPath !== undefined && (app.id === "terminal-app" || app.id === "iterm2")) {
        const script = app.id === "terminal-app" ? terminalAppScript(devPath) : iterm2Script(devPath);
        const out = await osascript(script);
        if (String(out).trim() === "ok") {
          const via: FocusVia = app.id === "terminal-app" ? "terminal-app" : "iterm2";
          note(deps, { event: "terminal-focus", pid, result: "focused", via, app: app.id });
          return { ok: true, via };
        }
        // The tty matched no open tab — degrade to activating the app rather than guessing a window.
      }
      await osascript(activateScript(app.bundleId));
      note(deps, { event: "terminal-focus", pid, result: "focused", via: "app-activate", app: app.id });
      return { ok: true, via: "app-activate" };
    } catch {
      // TCC denial (-1743), a timeout, or the app refusing the event. The command just no-ops.
      note(deps, { event: "terminal-focus", pid, result: "osascript-failed", app: app.id });
      return { ok: false, reason: "osascript-failed" };
    }
  } catch {
    return { ok: false, reason: "osascript-failed" };
  }
}
