import { describe, expect, test } from "bun:test";
import {
  activateScript, focusTerminalForPid, isTtyDevicePath, iterm2Script, owningTerminalApp,
  terminalAppScript, ttyDevicePath,
} from "./terminal-focus";
import type { FocusDeps } from "./terminal-focus";
import type { SessionRecord } from "./shared";

// Every test here runs entirely on injected seams: NO osascript is ever spawned, no real process is
// inspected, and the platform is injected. The AppleScript itself is asserted as text (the builders
// are pure), which is the only way to check the tty→tab/session mapping without a live desktop.

const TERMINAL_ARGV = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
const ITERM_ARGV = "/Applications/iTerm.app/Contents/MacOS/iTerm2";
const GHOSTTY_ARGV = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
const HERDR_SERVER_ARGV = "/opt/homebrew/bin/herdr server";

// The Claude DESKTOP app's three-process shape, captured verbatim off this machine (Claude 1.30096.1,
// claude-code 2.1.229) and trimmed only in the flag tail. The session's own `claude` is the record's
// pid; note its bundled path is a LOWERCASE `claude.app`, which the desktop entry must not match, or
// the owner would resolve to the session's own process instead of to the app.
const CLAUDE_DESKTOP_SESSION_ARGV =
  "/Users/karrix/Library/Application Support/Claude/claude-code/2.1.229/claude.app/Contents/MacOS/claude"
  + " --output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio"
  + " --resume=8fc9dfd6-adde-4da4-9afb-e209b4c1947e"
  + " --plugin-dir /Users/karrix/.claude/plugins/cache/thedotmack/claude-mem/13.12.4";
const CLAUDE_DESKTOP_LAUNCHER_ARGV =
  "/Applications/Claude.app/Contents/Helpers/disclaimer " + CLAUDE_DESKTOP_SESSION_ARGV;
const CLAUDE_DESKTOP_APP_ARGV = "/Applications/Claude.app/Contents/MacOS/Claude";

const REAL_HERDR_PANE_LIST = JSON.stringify({
  result: {
    panes: [
      {
        agent: "codex", agent_status: "idle", cwd: "/Users/karrix/api-status", focused: false,
        pane_id: "w2:pB", tab_id: "w2:tB", terminal_id: "term_657d", terminal_title: "api-status",
        terminal_title_stripped: "api-status", workspace_id: "w2",
      },
      {
        agent: "claude", agent_status: "working", cwd: "/Users/karrix/api-status", focused: true,
        pane_id: "w2:p8", tab_id: "w2:t8", terminal_title: "⠂ Review and clean up test cases for NOM-42",
        terminal_title_stripped: "Review and clean up test cases for NOM-42", workspace_id: "w2",
      },
    ],
    type: "pane_list",
  },
});

/** A fully-injected deps object: darwin, one tty, an ancestor chain, and a scripted osascript. */
function deps(over: Partial<FocusDeps> & { argvOf?: Record<number, string> } = {}): FocusDeps {
  const argv = over.argvOf ?? { 100: "codex", 200: TERMINAL_ARGV };
  return {
    platform: "darwin",
    ttyOf: async () => "ttys004",
    ancestorsOf: () => Object.keys(argv).map(Number).filter((p) => p !== 100),
    commandOf: (pid) => argv[pid],
    osascript: async () => "ok",
    ...over,
  };
}

function herdrRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    pid: 100, machine: "Mac", label: "api-status", ts: 1,
    title: "Review and clean up test cases for NOM-42",
    origin: { hook_event_name: "SessionStart", ppid: 100, cwd: "/Users/karrix/api-status" },
    ...over,
  };
}

function herdrDeps(over: {
  agent?: "claude" | "codex";
  record?: SessionRecord;
  paneList?: string;
  focusResult?: { stdout: string; exitCode?: number };
  ps?: string;
  trace?: (event: object) => void;
} = {}): { deps: FocusDeps; calls: Array<{ file: string; args: string[] }>; scripts: string[] } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const scripts: string[] = [];
  const commands: Record<number, string> = {
    100: "codex", 101: "-zsh", 102: HERDR_SERVER_ARGV, 500: "/opt/homebrew/bin/herdr",
    501: "-zsh", 502: "/usr/bin/login -fp karrix", 503: GHOSTTY_ARGV,
  };
  return {
    calls,
    scripts,
    deps: {
      platform: "darwin",
      ttyOf: async () => "ttys001",
      ancestorsOf: (pid) => pid === 500 ? [501, 502, 503] : [101, 102, 1],
      commandOf: (pid) => commands[pid],
      context: { agent: over.agent ?? "claude", record: over.record ?? herdrRecord() },
      execFile: async (file, args) => {
        calls.push({ file, args });
        if (file === "herdr" && args[0] === "pane") return { stdout: over.paneList ?? REAL_HERDR_PANE_LIST };
        if (file === "herdr" && args[0] === "tab") return over.focusResult ?? { stdout: "focused\n" };
        if (file === "ps") return { stdout: over.ps ?? "500 ttys009 /opt/homebrew/bin/herdr\n" };
        throw new Error("unexpected execFile call");
      },
      osascript: async (script) => { scripts.push(script); return ""; },
      trace: over.trace,
    },
  };
}

describe("ttyDevicePath", () => {
  test("normalises what `ps -o tty=` prints into an absolute device path", () => {
    expect(ttyDevicePath("ttys004")).toBe("/dev/ttys004");
    expect(ttyDevicePath("  ttys017 ")).toBe("/dev/ttys017");
    expect(ttyDevicePath("/dev/ttys004")).toBe("/dev/ttys004");
    expect(ttyDevicePath("s004")).toBe("/dev/ttys004"); // the short form some ps formats print
  });

  test("rejects every non-real tty spelling (a process with no controlling terminal)", () => {
    expect(ttyDevicePath("??")).toBeUndefined();
    expect(ttyDevicePath("?")).toBeUndefined();
    expect(ttyDevicePath("-")).toBeUndefined();
    expect(ttyDevicePath("")).toBeUndefined();
    expect(ttyDevicePath(undefined)).toBeUndefined();
  });

  test("rejects junk that could break out of an AppleScript string literal", () => {
    expect(ttyDevicePath(`ttys004" & (do shell script "id") & "`)).toBeUndefined();
    expect(ttyDevicePath("ttys004\nactivate")).toBeUndefined();
    expect(ttyDevicePath("../../etc/passwd")).toBeUndefined();
    expect(ttyDevicePath("/dev/../tmp/x")).toBeUndefined();
    expect(isTtyDevicePath("/dev/ttys004")).toBe(true);
    expect(isTtyDevicePath("/dev/tty s004")).toBe(false);
  });
});

describe("AppleScript builders", () => {
  test("Terminal.app: walks windows→tabs, compares the tab tty, selects it and raises the window", () => {
    const script = terminalAppScript("/dev/ttys004");
    expect(script).toBe([
      `tell application "Terminal"`,
      `\trepeat with w in windows`,
      `\t\trepeat with t in tabs of w`,
      `\t\t\tif tty of t is "/dev/ttys004" then`,
      `\t\t\t\tset selected of t to true`,
      `\t\t\t\tset index of w to 1`,
      `\t\t\t\tactivate`,
      `\t\t\t\treturn "ok"`,
      `\t\t\tend if`,
      `\t\tend repeat`,
      `\tend repeat`,
      `end tell`,
      `return "none"`,
    ].join("\n"));
  });

  test("iTerm2: walks windows→tabs→sessions, compares the session tty, selects the whole chain", () => {
    const script = iterm2Script("/dev/ttys017");
    expect(script).toBe([
      `tell application "iTerm"`,
      `\trepeat with w in windows`,
      `\t\trepeat with t in tabs of w`,
      `\t\t\trepeat with s in sessions of t`,
      `\t\t\t\tif tty of s is "/dev/ttys017" then`,
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
    ].join("\n"));
  });

  test("both builders refuse a tty path that failed validation", () => {
    expect(() => terminalAppScript(`/dev/ttys004" & beep & "`)).toThrow();
    expect(() => iterm2Script("/dev/../x")).toThrow();
  });

  test("the activate fallback binds by bundle id and refuses a junk id", () => {
    expect(activateScript("com.apple.Terminal")).toBe(`tell application id "com.apple.Terminal" to activate`);
    expect(() => activateScript(`x" to activate\ntell application "Finder`)).toThrow();
  });
});

describe("owningTerminalApp", () => {
  test("the NEAREST matching ancestor wins (a shell in tmux in iTerm resolves to iTerm)", () => {
    const argv: Record<number, string> = {
      1: "codex", 2: "-zsh", 3: "tmux", 4: ITERM_ARGV, 5: "/sbin/launchd",
    };
    expect(owningTerminalApp(1, () => [2, 3, 4, 5], (p) => argv[p])?.id).toBe("iterm2");
  });

  test("no known emulator in the chain → undefined (never a guess)", () => {
    const argv: Record<number, string> = { 1: "codex", 2: "sshd: karrix", 3: "/sbin/launchd" };
    expect(owningTerminalApp(1, () => [2, 3], (p) => argv[p])).toBeUndefined();
  });

  test("a throwing ancestor walk degrades to inspecting the pid itself", () => {
    expect(owningTerminalApp(9, () => { throw new Error("ps died"); }, () => GHOSTTY_ARGV)?.id).toBe("ghostty");
  });

  test("a Claude DESKTOP conversation window resolves to the desktop app", () => {
    const argv: Record<number, string> = {
      27773: CLAUDE_DESKTOP_SESSION_ARGV,
      27772: CLAUDE_DESKTOP_LAUNCHER_ARGV,
      52631: CLAUDE_DESKTOP_APP_ARGV,
      1: "/sbin/launchd",
    };
    const app = owningTerminalApp(27773, () => [27772, 52631, 1], (p) => argv[p]);
    expect(app?.id).toBe("claude-desktop");
    expect(app?.bundleId).toBe("com.anthropic.claudefordesktop");
  });

  test("the session's OWN bundled binary is not the app (the lowercase claude.app must not match)", () => {
    expect(owningTerminalApp(27773, () => [], () => CLAUDE_DESKTOP_SESSION_ARGV)).toBeUndefined();
  });

  test("a desktop app installed outside /Applications resolves identically (no location pin)", () => {
    const relocated = "/Users/karrix/Applications/Claude.app/Contents/MacOS/Claude";
    expect(owningTerminalApp(1, () => [2], (p) => (p === 2 ? relocated : "claude"))?.id).toBe("claude-desktop");
  });

  test("a CLI session in a terminal launched from the desktop app still resolves to the terminal", () => {
    // The NEAREST ancestor wins, so an app further up the chain can never steal a real emulator.
    const argv: Record<number, string> = { 1: "claude", 2: "-zsh", 3: GHOSTTY_ARGV, 4: CLAUDE_DESKTOP_APP_ARGV };
    expect(owningTerminalApp(1, () => [2, 3, 4], (p) => argv[p])?.id).toBe("ghostty");
  });
});

describe("focusTerminalForPid", () => {
  test("non-darwin is a no-op (the whole module is macOS-only)", async () => {
    expect(await focusTerminalForPid(100, deps({ platform: "linux" }))).toEqual({ ok: false, reason: "unsupported" });
  });

  test("a pid with no real controlling tty owns no window → no-tty", async () => {
    expect(await focusTerminalForPid(100, deps({ ttyOf: async () => "??" }))).toEqual({ ok: false, reason: "no-tty" });
    expect(await focusTerminalForPid(100, deps({ ttyOf: async () => undefined }))).toEqual({ ok: false, reason: "no-tty" });
  });

  // FIELD REGRESSION: "Open on Mac" was a silent no-op for every session started in the Claude desktop
  // app. Its `claude` has no controlling tty, so the tty gate refused the pid before the owning app was
  // ever consulted — the same shape as the 2026-08-02 herdr bug, in its second guise.
  test("a tty-less Claude DESKTOP session activates the app instead of refusing on no-tty", async () => {
    const scripts: string[] = [];
    const result = await focusTerminalForPid(27773, deps({
      ttyOf: async () => "??",
      argvOf: {
        27773: CLAUDE_DESKTOP_SESSION_ARGV, 27772: CLAUDE_DESKTOP_LAUNCHER_ARGV,
        52631: CLAUDE_DESKTOP_APP_ARGV,
      },
      ancestorsOf: () => [27772, 52631],
      osascript: async (s) => { scripts.push(s); return ""; },
    }));
    expect(result).toEqual({ ok: true, via: "app-activate" });
    expect(scripts).toEqual([`tell application id "com.anthropic.claudefordesktop" to activate`]);
  });

  test("the tty exemption is scoped to the desktop app — a tty-less Ghostty pid is still no-tty", async () => {
    let calls = 0;
    const result = await focusTerminalForPid(100, deps({
      ttyOf: async () => "??",
      argvOf: { 100: "claude", 200: GHOSTTY_ARGV },
      osascript: async () => { calls++; return ""; },
    }));
    expect(result).toEqual({ ok: false, reason: "no-tty" });
    expect(calls).toBe(0);
  });

  test("a Terminal.app-owned pid takes the exact tty→tab path", async () => {
    const scripts: string[] = [];
    const result = await focusTerminalForPid(100, deps({
      osascript: async (s) => { scripts.push(s); return "ok"; },
    }));
    expect(result).toEqual({ ok: true, via: "terminal-app" });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(`tell application "Terminal"`);
    expect(scripts[0]).toContain(`if tty of t is "/dev/ttys004" then`);
  });

  test("an iTerm2-owned pid takes the session path", async () => {
    const scripts: string[] = [];
    const result = await focusTerminalForPid(100, deps({
      argvOf: { 100: "codex", 200: ITERM_ARGV },
      osascript: async (s) => { scripts.push(s); return "ok"; },
    }));
    expect(result).toEqual({ ok: true, via: "iterm2" });
    expect(scripts[0]).toContain(`tell application "iTerm"`);
    expect(scripts[0]).toContain(`if tty of s is "/dev/ttys004" then`);
  });

  test("a tty that matches no open tab degrades to activating the app (never a guessed window)", async () => {
    const scripts: string[] = [];
    const result = await focusTerminalForPid(100, deps({
      osascript: async (s) => { scripts.push(s); return "none"; },
    }));
    expect(result).toEqual({ ok: true, via: "app-activate" });
    expect(scripts).toHaveLength(2);
    expect(scripts[1]).toBe(`tell application id "com.apple.Terminal" to activate`);
  });

  test("a known-but-unscriptable emulator activates the app only — one osascript, no window guess", async () => {
    const scripts: string[] = [];
    const result = await focusTerminalForPid(100, deps({
      argvOf: { 100: "codex", 200: GHOSTTY_ARGV },
      osascript: async (s) => { scripts.push(s); return ""; },
    }));
    expect(result).toEqual({ ok: true, via: "app-activate" });
    expect(scripts).toEqual([`tell application id "com.mitchellh.ghostty" to activate`]);
  });

  test("an unrecognised owner does nothing at all (no osascript is ever run)", async () => {
    let calls = 0;
    const result = await focusTerminalForPid(100, deps({
      argvOf: { 100: "codex", 200: "sshd: karrix [priv]" },
      osascript: async () => { calls++; return "ok"; },
    }));
    expect(result).toEqual({ ok: false, reason: "unsupported" });
    expect(calls).toBe(0);
  });

  test("an osascript throw (TCC -1743, a timeout, a refused event) is a typed no-op, never a throw", async () => {
    const result = await focusTerminalForPid(100, deps({
      osascript: async () => { throw new Error("execution error: Not authorized to send Apple events (-1743)"); },
    }));
    expect(result).toEqual({ ok: false, reason: "osascript-failed" });
  });

  test("a throwing tty probe cannot escape the boundary", async () => {
    const result = await focusTerminalForPid(100, deps({
      ttyOf: async () => { throw new Error("ps died"); },
    }));
    expect(result.ok).toBe(false);
  });

  test("every outcome is traceable through the injected sink", async () => {
    const events: object[] = [];
    await focusTerminalForPid(100, deps({ trace: (e) => events.push(e) }));
    expect(events).toEqual([{ event: "terminal-focus", pid: 100, result: "focused", via: "terminal-app", app: "terminal-app" }]);
  });
});

describe("focusTerminalForPid through herdr", () => {
  // FIELD REGRESSION (2026-08-02): "Open on Mac" no-opped for a daemon-hosted Claude session. The
  // hook records `process.ppid`, which for a `claude daemon run` / `--bg-pty-host` session is a
  // process with NO controlling tty ("??") — so the tty gate refused it as no-tty even though its
  // herdr TAB was open and correlated uniquely by title. The herdr daemon owns the pty; the pid's
  // own tty is simply not the signal there, so the herdr branch has to be reached FIRST.
  test("a daemon-hosted pid with NO controlling tty still reaches herdr — the daemon owns the pty", async () => {
    const events: object[] = [];
    const h = herdrDeps({ trace: (event) => events.push(event) });
    expect(await focusTerminalForPid(100, { ...h.deps, ttyOf: async () => "??" }))
      .toEqual({ ok: true, via: "herdr", reason: "herdr-focused" });
    expect(h.calls[1]).toEqual({ file: "herdr", args: ["tab", "focus", "w2:t8"] });
    expect(events.at(-1)).toMatchObject({ result: "focused", reason: "herdr-focused" });
  });

  test("a pid whose tty cannot be read at all still reaches herdr", async () => {
    const h = herdrDeps({});
    expect(await focusTerminalForPid(100, { ...h.deps, ttyOf: async () => undefined }))
      .toEqual({ ok: true, via: "herdr", reason: "herdr-focused" });
  });

  test("WITHOUT herdr in the ancestry a tty-less pid is still refused as no-tty", async () => {
    // The guard for the change above: only a herdr-owned pty may skip the tty gate. A headless
    // `claude` on a plain machine owns no window and must still be refused.
    expect(await focusTerminalForPid(100, deps({ ttyOf: async () => "??" })))
      .toEqual({ ok: false, reason: "no-tty" });
  });

  test("matches a Claude pane by exact terminal_title_stripped and activates its client host", async () => {
    const events: object[] = [];
    const h = herdrDeps({
      focusResult: { stdout: JSON.stringify({ id: "cli:tab:focus", result: { tab_id: "w2:t8" } }) },
      trace: (event) => events.push(event),
    });
    expect(await focusTerminalForPid(100, h.deps)).toEqual({ ok: true, via: "herdr", reason: "herdr-focused" });
    expect(h.calls.map((call) => [call.file, ...call.args])).toEqual([
      ["herdr", "pane", "list"], ["herdr", "tab", "focus", "w2:t8"],
      ["ps", "-axo", "pid=,tty=,args="],
    ]);
    expect(h.scripts).toEqual([`tell application id "com.mitchellh.ghostty" to activate`]);
    expect(events.at(-1)).toMatchObject({ result: "focused", reason: "herdr-focused", app: "ghostty" });
  });

  test("matches when an explicitly ellipsis-truncated record title prefixes the full pane title", async () => {
    const h = herdrDeps({ record: herdrRecord({ title: "Review and clean up test cases…" }) });
    expect(await focusTerminalForPid(100, h.deps)).toEqual({ ok: true, via: "herdr", reason: "herdr-focused" });
    expect(h.calls[1]).toEqual({ file: "herdr", args: ["tab", "focus", "w2:t8"] });
  });

  test("matches a Codex pane only by a unique exact origin cwd", async () => {
    const h = herdrDeps({ agent: "codex", record: herdrRecord({ agent: "codex", title: "unrelated" }) });
    expect(await focusTerminalForPid(100, h.deps)).toEqual({ ok: true, via: "herdr", reason: "herdr-focused" });
    expect(h.calls[1]).toEqual({ file: "herdr", args: ["tab", "focus", "w2:tB"] });
  });

  test("uses agent_status only to break a tie between primary-signal matches", async () => {
    const payload = JSON.stringify({ result: { panes: [
      { agent: "codex", agent_status: "idle", cwd: "/Users/karrix/api-status", tab_id: "w2:tIdle" },
      { agent: "codex", agent_status: "working", cwd: "/Users/karrix/api-status", tab_id: "w2:tWorking" },
    ] } });
    const h = herdrDeps({
      agent: "codex", record: herdrRecord({ agent: "codex", lastEvent: "working" }), paneList: payload,
    });
    expect(await focusTerminalForPid(100, h.deps)).toEqual({ ok: true, via: "herdr", reason: "herdr-focused" });
    expect(h.calls[1]).toEqual({ file: "herdr", args: ["tab", "focus", "w2:tWorking"] });
  });

  test("gives up on multiple candidates after tiebreak and never runs tab focus", async () => {
    const payload = JSON.stringify({ result: { panes: [
      { agent: "codex", agent_status: "idle", cwd: "/Users/karrix/api-status", tab_id: "w2:tB" },
      { agent: "codex", agent_status: "idle", cwd: "/Users/karrix/api-status", tab_id: "w2:tC" },
    ] } });
    const events: object[] = [];
    const h = herdrDeps({ agent: "codex", paneList: payload, trace: (event) => events.push(event) });
    expect(await focusTerminalForPid(100, h.deps)).toEqual({ ok: false, reason: "herdr-ambiguous" });
    expect(h.calls).toEqual([{ file: "herdr", args: ["pane", "list"] }]);
    expect(events.at(-1)).toMatchObject({ result: "ambiguous", reason: "herdr-ambiguous" });
  });

  test("treats malformed pane-list JSON as herdr-cli-failed and never throws", async () => {
    const h = herdrDeps({ paneList: "{ definitely not json" });
    expect(await focusTerminalForPid(100, h.deps)).toEqual({ ok: false, reason: "herdr-cli-failed" });
    expect(h.calls).toEqual([{ file: "herdr", args: ["pane", "list"] }]);
  });

  test("rejects an unsafe tab_id before it can reach execFile", async () => {
    const payload = JSON.stringify({ result: { panes: [{
      agent: "codex", agent_status: "idle", cwd: "/Users/karrix/api-status",
      tab_id: "w2:tB;touch /tmp/herdr-injected",
    }] } });
    const h = herdrDeps({ agent: "codex", paneList: payload });
    expect(await focusTerminalForPid(100, h.deps)).toEqual({ ok: false, reason: "herdr-cli-failed" });
    expect(h.calls).toEqual([{ file: "herdr", args: ["pane", "list"] }]);
  });

  test("keeps a successful tab focus when no real-tty herdr client is attached", async () => {
    const events: object[] = [];
    const h = herdrDeps({ ps: "500 ?? /opt/homebrew/bin/herdr\n", trace: (event) => events.push(event) });
    expect(await focusTerminalForPid(100, h.deps)).toEqual({ ok: true, via: "herdr", reason: "focused-detached" });
    expect(h.calls[1]).toEqual({ file: "herdr", args: ["tab", "focus", "w2:t8"] });
    expect(h.scripts).toEqual([]);
    expect(events.at(-1)).toMatchObject({ result: "focused", reason: "focused-detached" });
  });

  test("maps a non-zero herdr tab-focus exit to herdr-cli-failed", async () => {
    const h = herdrDeps({ focusResult: { stdout: "failed", exitCode: 1 } });
    expect(await focusTerminalForPid(100, h.deps)).toEqual({ ok: false, reason: "herdr-cli-failed" });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toEqual({ file: "herdr", args: ["tab", "focus", "w2:t8"] });
  });
});
