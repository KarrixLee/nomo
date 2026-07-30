// terminal-focus — bring the macOS window showing a given process's terminal to the front.
//
// The agent-AGNOSTIC half of the phone's "open this session on my Mac" command. WHICH process is a
// session's interactive TUI is agent-specific and lives in adapter.ts (AgentAdapter.locateTuiPid);
// everything here works purely off a pid and knows nothing about Claude, Codex, or sessions.
//
// How a pid becomes a window:
//   1. the pid's controlling tty (`ps -o tty=` → "ttys004" → the device path "/dev/ttys004"),
//   2. the OWNING terminal application, from the pid's ancestor chain's argv (Terminal.app, iTerm2,
//      Ghostty, WezTerm, Alacritty, kitty, Hyper, Warp, VS Code),
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

const execFileP = promisify(execFile);

/** Hard ceiling on ANY osascript run. Existing execFileP calls in this codebase set no timeout, but
 *  AppleScript can block indefinitely — on a modal dialog, a hung terminal app, or the TCC consent
 *  prompt itself — and this runs inside the watchdog's sweep loop, which must keep its cadence. */
const OSASCRIPT_TIMEOUT_MS = 4000;

/** How the window was raised. `terminal-app`/`iterm2` mean the EXACT tab/session for that tty was
 *  selected; `app-activate` means only the owning application was brought forward. */
export type FocusVia = "terminal-app" | "iterm2" | "app-activate";

/** Why nothing was focused. `no-tty` — the pid holds no real controlling terminal (dead, or a
 *  headless/daemon process). `unsupported` — not macOS, or no known terminal application owns the
 *  pid. `osascript-failed` — the AppleScript bridge errored (most likely a denied/unprompted TCC
 *  Automation permission, -1743), timed out, or the app refused the event. */
export type FocusFailure = "no-tty" | "unsupported" | "osascript-failed";

export type FocusResult = { ok: true; via: FocusVia } | { ok: false; reason: FocusFailure };

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
  /** Best-effort diagnostics sink (the watchdog passes traceSession). */
  trace?: (event: object) => void;
}

/** A terminal emulator we can recognise from argv and activate by bundle id. `script` is the
 *  tty→window strategy: only Terminal.app and iTerm2 expose a scriptable tty per tab/session; every
 *  other entry is activate-only by design (guessing a window in kitty/WezTerm/Ghostty from a tty is
 *  not possible over AppleScript, and a wrong guess is the one outcome worth avoiding). */
export interface TerminalApp {
  id: "terminal-app" | "iterm2" | "ghostty" | "wezterm" | "alacritty" | "kitty" | "hyper" | "warp" | "vscode";
  /** CFBundleIdentifier — `tell application id "…"` binds to the installed copy, wherever it lives. */
  bundleId: string;
  /** Matched against a process's full argv (the .app bundle path, or the binary name for the
   *  bundle-less launches WezTerm/kitty/Alacritty can have). */
  match: RegExp;
}

/** The known emulators, most specific first. VS Code's integrated terminal is included because a
 *  session started from it is genuinely owned by VS Code (activate-only). */
const TERMINAL_APPS: TerminalApp[] = [
  { id: "terminal-app", bundleId: "com.apple.Terminal", match: /\/Terminal\.app\// },
  { id: "iterm2", bundleId: "com.googlecode.iterm2", match: /\/iTerm\.app\/|\/iTerm2\.app\// },
  { id: "ghostty", bundleId: "com.mitchellh.ghostty", match: /\/Ghostty\.app\/|(?:^|\/)ghostty(?:\s|$)/ },
  { id: "wezterm", bundleId: "com.github.wez.wezterm", match: /\/WezTerm\.app\/|(?:^|\/)wezterm(?:-gui)?(?:\s|$)/ },
  { id: "alacritty", bundleId: "org.alacritty", match: /\/Alacritty\.app\/|(?:^|\/)alacritty(?:\s|$)/ },
  { id: "kitty", bundleId: "net.kovidgoyal.kitty", match: /\/kitty\.app\/|(?:^|\/)kitty(?:\s|$)/ },
  { id: "hyper", bundleId: "co.zeit.hyper", match: /\/Hyper\.app\// },
  { id: "warp", bundleId: "dev.warp.Warp-Stable", match: /\/Warp\.app\// },
  { id: "vscode", bundleId: "com.microsoft.VSCode", match: /\/Visual Studio Code\.app\/|\/Code\.app\/|Code Helper/ },
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

/** Bring the macOS terminal window running `pid` to the front. See the module header for the full
 *  strategy. Never throws; every refusal is a typed {ok:false} result. */
export async function focusTerminalForPid(pid: number, deps: FocusDeps = {}): Promise<FocusResult> {
  try {
    if ((deps.platform ?? process.platform) !== "darwin") {
      note(deps, { event: "terminal-focus", pid, result: "unsupported", why: "not-darwin" });
      return { ok: false, reason: "unsupported" };
    }
    let rawTty: string | undefined;
    try { rawTty = await (deps.ttyOf ?? ttyViaPs)(pid); } catch { rawTty = undefined; }
    const devPath = ttyDevicePath(rawTty);
    if (devPath === undefined) {
      note(deps, { event: "terminal-focus", pid, result: "no-tty", tty: rawTty ?? "" });
      return { ok: false, reason: "no-tty" };
    }
    const app = owningTerminalApp(pid, deps.ancestorsOf ?? pidAncestors, deps.commandOf ?? pidCommand);
    if (!app) {
      note(deps, { event: "terminal-focus", pid, result: "unsupported", why: "no-owning-app" });
      return { ok: false, reason: "unsupported" };
    }
    const osascript = deps.osascript ?? runOsascript;
    try {
      // The two emulators that can map a tty to an exact tab/session get the precise treatment.
      if (app.id === "terminal-app" || app.id === "iterm2") {
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
