import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  appendCodexBridgeMarker, clearDecisionHoldAt, CODEX_BRIDGE_DOWN_MARKER, CODEX_DAEMON_START_ARGS,
  codexAppServerSocketAvailable, codexAppServerSocketPath, codexCompanionBrokerEvidence,
  DBG_BLOB_TEXT_MAX_CHARS, startCodexAppServerDaemon,
  decisionHoldFileName, ensureWatchdog, formatWatchdogPidfile, fullTextForRecord, isWatchdogCommand,
  readDecisionHoldAt, writeDecisionHoldAt,
  localApprovalsState, parseWatchdogPidfile, PLUGIN_VERSION, RECORD_FULL_TEXT_MAX_CHARS,
  RECORD_FULL_TEXT_TRUNCATION_MARKER, recordFullTextIsComplete, settleDecisionHoldRecordAt,
  stampPermissionDetailFullAt, watchdogBuildStamp,
  watchdogHolderIsLive,
} from "./shared";

describe("codexCompanionBrokerEvidence (structural companion-session proof)", () => {
  test("matches an exact app-server-broker.mjs argv path in the ancestor chain", () => {
    const commands: Record<number, string> = {
      10: "/opt/codex codex app-server",
      20: "node /Users/x/.claude/plugins/cache/openai-codex/codex/1.2.3/scripts/app-server-broker.mjs",
    };
    expect(codexCompanionBrokerEvidence(10, () => [20], (pid) => commands[pid])).toMatchObject({
      pid: 20, matchedBy: "app-server-broker.mjs",
    });
  });

  test("matches the cxc broker socket endpoint even when the script path is absent", () => {
    const command = "codex app-server --listen unix:///private/tmp/cxc-a81f/broker.sock";
    expect(codexCompanionBrokerEvidence(10, () => [], () => command)).toMatchObject({
      pid: 10, matchedBy: "cxc-broker-socket",
    });
  });

  test("unreadable or throwing ancestry fails open", () => {
    expect(codexCompanionBrokerEvidence(10, () => { throw new Error("EPERM"); }, () => undefined)).toBeNull();
    expect(codexCompanionBrokerEvidence(10, () => [20], () => undefined)).toBeNull();
  });

  test("a standalone codex app-server without broker ancestry is unaffected", () => {
    const commands: Record<number, string> = {
      10: "/Applications/Codex.app/codex app-server --listen unix:///tmp/codex.sock",
      20: "/sbin/launchd",
    };
    expect(codexCompanionBrokerEvidence(10, () => [20], (pid) => commands[pid])).toBeNull();
  });
});

// PLUGIN_VERSION is injected by build.ts as a compile-time `__NOMO_VERSION__` define ONLY in the
// bundled dist/*.mjs. Tests import the raw .ts with no define, so the typeof guard must degrade to
// the dev sentinel rather than throw a ReferenceError.
describe("PLUGIN_VERSION", () => {
  test("falls back to the dev sentinel when __NOMO_VERSION__ is not defined (unbundled/tests)", () => {
    expect(PLUGIN_VERSION).toBe("0.0.0-dev");
  });
});

// localApprovalsState is the ONE place that turns the local `no-hold` pause flag into the wire value
// carried by every /cc/event POST. The worker literal-matches "on"/"off" and silently ignores every
// other string, so these assert the EXACT bytes — no case folding, no substring.
describe("localApprovalsState (the x-cc-approvals wire value)", () => {
  test("flag file present → exactly \"off\"", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-nohold-"));
    try {
      const flag = join(dir, "no-hold");
      await writeFile(flag, ""); // `permission off` writes a zero-byte file
      expect(await localApprovalsState(flag)).toBe("off");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("flag file absent → exactly \"on\"", async () => {
    expect(await localApprovalsState("/does/not/exist/no-hold")).toBe("on");
  });
});

// --- watchdog pidfile: pid identity + build stamp ---------------------------------------------
//
// Two ways the single-instance lock used to wedge: a pidfile that outlived a reboot naming a RECYCLED
// pid (kill(pid,0) says "alive" forever → no watchdog is ever spawned again), and a live watchdog running
// an OLD bundle after a plugin upgrade (it lingers up to 30 min between sessions). The pidfile now carries
// the incumbent's version and both claim paths `ps`-verify the pid.

describe("watchdog pidfile format (parseInt-compatible so old readers keep working)", () => {
  test("round-trips pid + version", () => {
    expect(formatWatchdogPidfile(4242, "1.4.4")).toBe("4242 1.4.4");
    expect(parseWatchdogPidfile("4242 1.4.4")).toEqual({ pid: 4242, version: "1.4.4" });
    expect(parseWatchdogPidfile(" 4242 1.4.4\n")).toEqual({ pid: 4242, version: "1.4.4" });
  });

  test("a legacy bare-pid pidfile parses with NO version (i.e. an older build)", () => {
    expect(parseWatchdogPidfile("4242")).toEqual({ pid: 4242 });
    expect(parseWatchdogPidfile("4242\n")).toEqual({ pid: 4242 });
  });

  test("every EXISTING reader (plain parseInt) still reads the pid out of the new format", () => {
    // status-cmd / reset / the watchdog's own release all do exactly this.
    expect(Number.parseInt(formatWatchdogPidfile(99, "9.9.9").trim(), 10)).toBe(99);
  });

  test("garbage / empty / non-positive → null (nothing to trust)", () => {
    expect(parseWatchdogPidfile("")).toBeNull();
    expect(parseWatchdogPidfile("   ")).toBeNull();
    expect(parseWatchdogPidfile("not-a-pid")).toBeNull();
    expect(parseWatchdogPidfile("0 1.4.4")).toBeNull();
    expect(parseWatchdogPidfile("-1")).toBeNull();
  });
});

describe("watchdogHolderIsLive (a recycled pid is NOT a live watchdog)", () => {
  test("alive + a cc-watchdog command line → live", () => {
    expect(watchdogHolderIsLive(4242, { isAlive: () => true, commandOf: () => "/usr/bin/bun /x/dist/cc-watchdog.mjs" })).toBe(true);
    expect(watchdogHolderIsLive(4242, { isAlive: () => true, commandOf: () => "bun /repo/src/entries/cc-watchdog.ts" })).toBe(true);
  });

  test("alive but a DIFFERENT program (pid recycled after a reboot) → stale, so the claim proceeds", () => {
    expect(watchdogHolderIsLive(4242, { isAlive: () => true, commandOf: () => "/Applications/Safari.app/Contents/MacOS/Safari" })).toBe(false);
  });

  test("dead pid → stale (no ps call needed)", () => {
    let asked = false;
    expect(watchdogHolderIsLive(4242, { isAlive: () => false, commandOf: () => { asked = true; return "cc-watchdog.mjs"; } })).toBe(false);
    expect(asked).toBe(false);
  });

  test("`ps` unavailable (undefined) falls back to liveness — never guess 'recycled' and double-spawn", () => {
    expect(watchdogHolderIsLive(4242, { isAlive: () => true, commandOf: () => undefined })).toBe(true);
  });

  test("a nonsense pid is never live", () => {
    expect(watchdogHolderIsLive(0, { isAlive: () => true, commandOf: () => "cc-watchdog" })).toBe(false);
    expect(watchdogHolderIsLive(Number.NaN, { isAlive: () => true, commandOf: () => "cc-watchdog" })).toBe(false);
  });

  test("isWatchdogCommand is the shared fingerprint (reset re-exports this one)", () => {
    expect(isWatchdogCommand("node /opt/nomo/dist/cc-watchdog.mjs")).toBe(true);
    expect(isWatchdogCommand("node /opt/nomo/dist/cc-status.mjs")).toBe(false);
  });
});

describe("ensureWatchdog (spawn gate: recycled pids and stale builds must not block the daemon)", () => {
  const WATCHDOG_CMD = "bun /x/dist/cc-watchdog.mjs";
  /** Drives ensureWatchdog with fully-faked process seams and reports what it did. */
  const run = (pidfile: string | undefined, over: Parameters<typeof ensureWatchdog>[0] = {}) => {
    const kills: Array<[number, string]> = [];
    let spawned = 0;
    ensureWatchdog({
      readPidfile: () => pidfile,
      isAlive: () => true,
      commandOf: () => WATCHDOG_CMD,
      killPid: (pid, sig) => { kills.push([pid, sig as string]); },
      spawnWatchdog: () => { spawned++; },
      version: "1.4.4",
      ...over,
    });
    return { kills, spawned };
  };

  test("no pidfile → spawn, nothing killed", () => {
    expect(run(undefined)).toEqual({ kills: [], spawned: 1 });
  });

  test("a live watchdog on the SAME build → no spawn, no signal", () => {
    expect(run("777 1.4.4")).toEqual({ kills: [], spawned: 0 });
  });

  test("a live watchdog on a DIFFERENT build → SIGTERM once, then spawn the current bundle", () => {
    expect(run("777 1.4.3")).toEqual({ kills: [[777, "SIGTERM"]], spawned: 1 });
  });

  test("a legacy UNSTAMPED pidfile is treated as an older build → takeover", () => {
    expect(run("777")).toEqual({ kills: [[777, "SIGTERM"]], spawned: 1 });
  });

  test("the takeover kills AT MOST once per call (no kill loop within an ensure)", () => {
    const { kills, spawned } = run("777 0.9.0");
    expect(kills).toHaveLength(1);
    expect(spawned).toBe(1);
  });

  test("a RECYCLED pid (alive, but not our watchdog) → spawn WITHOUT signalling the innocent process", () => {
    expect(run("777 1.4.4", { commandOf: () => "/usr/sbin/cupsd" })).toEqual({ kills: [], spawned: 1 });
    // …and the same holds for a stale-version stamp on a recycled pid — still never signalled.
    expect(run("777 0.1.0", { commandOf: () => "/usr/sbin/cupsd" })).toEqual({ kills: [], spawned: 1 });
  });

  test("a dead pid → spawn, nothing killed", () => {
    expect(run("777 1.4.4", { isAlive: () => false })).toEqual({ kills: [], spawned: 1 });
  });

  test("a kill that throws (the incumbent raced its own exit) still spawns", () => {
    const { spawned } = run("777 1.4.3", { killPid: () => { throw new Error("ESRCH"); } });
    expect(spawned).toBe(1);
  });

  test("a garbage pidfile → spawn", () => {
    expect(run("nonsense")).toEqual({ kills: [], spawned: 1 });
  });

  // THE FIELD BUG (2026-08-02): the version string is not the build. A bundle rebuilt in place under
  // the SAME version — every iteration of a fix before its release bump — left the incumbent running
  // the OLD code forever, because the stamp it was compared against had not changed. The daemon is
  // long-lived (a 30-min idle grace), so "the fix is on disk" and "the fix is running" diverged
  // silently: the .hold markers the new permission hook wrote were read by nobody.
  test("a live watchdog on the same VERSION but a DIFFERENT bundle → takeover", () => {
    expect(run("777 1.4.4 aaa", { build: "bbb" })).toEqual({ kills: [[777, "SIGTERM"]], spawned: 1 });
  });

  test("same version AND same bundle → still no spawn, no signal", () => {
    expect(run("777 1.4.4 aaa", { build: "aaa" })).toEqual({ kills: [], spawned: 0 });
  });

  test("an UNKNOWN build stamp on either side compares on the version alone (never a restart loop)", () => {
    // A pre-stamp incumbent, or a bundle we cannot stat: absence of evidence is not evidence of a
    // different build, and guessing "different" would SIGTERM the daemon on every hook.
    expect(run("777 1.4.4", { build: "bbb" })).toEqual({ kills: [], spawned: 0 });
    expect(run("777 1.4.4 aaa", { build: undefined })).toEqual({ kills: [], spawned: 0 });
    // …but a genuine version change still takes over, stamps or no stamps.
    expect(run("777 1.4.3", { build: undefined })).toEqual({ kills: [[777, "SIGTERM"]], spawned: 1 });
  });

  test("the pidfile carries the build as a THIRD field, and stays parseInt-compatible", () => {
    expect(formatWatchdogPidfile(777, "1.4.4", "abc")).toBe("777 1.4.4 abc");
    expect(Number.parseInt(formatWatchdogPidfile(777, "1.4.4", "abc"), 10)).toBe(777);
    expect(parseWatchdogPidfile("777 1.4.4 abc")).toEqual({ pid: 777, version: "1.4.4", build: "abc" });
    expect(parseWatchdogPidfile("777 1.4.4")).toEqual({ pid: 777, version: "1.4.4" });
    // No stamp available → the two-field form the previous build wrote, byte for byte.
    expect(formatWatchdogPidfile(777, "1.4.4", undefined)).toBe("777 1.4.4");
  });
});

describe("watchdogBuildStamp (the bundle's identity, not its version)", () => {
  test("equal for two copies of the SAME bytes, different the moment the bytes change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-build-"));
    try {
      const a = join(dir, "a.mjs");
      const b = join(dir, "b.mjs");
      await writeFile(a, "console.log(1)\n");
      await writeFile(b, "console.log(1)\n");
      // CONTENT, not mtime: the same bundle installed twice (a plugin cache copy and a dev checkout)
      // must not look like two different builds, or every hook would fight over the daemon.
      expect(watchdogBuildStamp(a)).toBe(watchdogBuildStamp(b));
      await writeFile(b, "console.log(2)\n");
      expect(watchdogBuildStamp(a)).not.toBe(watchdogBuildStamp(b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable path is UNKNOWN (undefined), never a throw and never a fake stamp", () => {
    expect(watchdogBuildStamp("/does/not/exist/cc-watchdog.mjs")).toBeUndefined();
  });
});

// The ONE Codex-daemon presence probe: `status` reports it and the watchdog gates its remote-input
// bridge on it (so a Claude-only machine never spawns `codex app-server proxy` at all).
describe("codexAppServerSocketAvailable (the shared control-socket probe)", () => {
  test("a missing socket → false, never a throw", async () => {
    expect(await codexAppServerSocketAvailable("/does/not/exist/app-server-control.sock")).toBe(false);
  });

  test("a plain FILE at the socket path is not a socket → false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-sock-"));
    try {
      const p = join(dir, "app-server-control.sock");
      await writeFile(p, "");
      expect(await codexAppServerSocketAvailable(p)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the default path lives under CODEX_HOME", () => {
    expect(codexAppServerSocketPath().endsWith("/app-server-control/app-server-control.sock")).toBe(true);
  });
});

// Recovery for the OTHER half of the presence gate: when the socket is missing, try (once per watchdog
// cooldown) to bring the daemon back. `codex app-server daemon start` is verified against codex-cli
// 0.146.0's own help — "Start the local app server daemon if it is not already running" — and is NOT
// `app-server proxy`, which only attaches to an existing socket and errors when there is none.
describe("startCodexAppServerDaemon (bounded, non-interactive, never-throwing)", () => {
  /** A scriptable stand-in for the spawned child. */
  const child = (script: (emit: (event: "error" | "exit", ...args: unknown[]) => void) => void) => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const kills: string[] = [];
    const handle = {
      on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return handle; },
      kill(signal?: string) { kills.push(signal ?? "SIGTERM"); return true; },
    };
    queueMicrotask(() => script((event, ...args) => listeners.get(event)?.(...args)));
    return { handle, kills };
  };

  test("runs the exact verified subcommand and reports success only when the SOCKET appears", async () => {
    const spawned: Array<{ command: string; args: readonly string[] }> = [];
    const traced: object[] = [];
    let socket = false;
    const ok = await startCodexAppServerDaemon({
      spawnFn: (command, args) => {
        spawned.push({ command, args });
        return child((emit) => { socket = true; emit("exit", 0, null); }).handle;
      },
      probe: async () => socket,
      sleep: async () => {},
      trace: (event) => traced.push(event),
    });
    expect(ok).toBe(true);
    expect(spawned).toEqual([{ command: "codex", args: CODEX_DAEMON_START_ARGS }]);
    expect(CODEX_DAEMON_START_ARGS).toEqual(["app-server", "daemon", "start"]);
    expect(traced[0]).toMatchObject({ event: "codex-daemon-start", outcome: "started" });
  });

  test("exit 0 with NO socket is a failure, traced, bounded — never an infinite wait", async () => {
    const traced: object[] = [];
    const ok = await startCodexAppServerDaemon({
      spawnFn: () => child((emit) => emit("exit", 0, null)).handle,
      probe: async () => false,
      sleep: async () => {},
      trace: (event) => traced.push(event),
      socketWaitMs: 1_000,
    });
    expect(ok).toBe(false);
    expect(traced).toEqual([{ event: "codex-daemon-start", outcome: "no-socket", waitedMs: 1_000 }]);
  });

  test("a missing binary (spawn throws / emits error) and a non-zero exit both resolve false, traced", async () => {
    const traced: object[] = [];
    expect(await startCodexAppServerDaemon({
      spawnFn: () => { throw new Error("ENOENT"); },
      probe: async () => true, trace: (event) => traced.push(event),
    })).toBe(false);
    expect(await startCodexAppServerDaemon({
      spawnFn: () => child((emit) => emit("error", new Error("ENOENT"))).handle,
      probe: async () => true, trace: (event) => traced.push(event),
    })).toBe(false);
    expect(await startCodexAppServerDaemon({
      spawnFn: () => child((emit) => emit("exit", 1, null)).handle,
      probe: async () => true, trace: (event) => traced.push(event),
    })).toBe(false);
    expect(traced.map((event) => (event as { outcome: string }).outcome))
      .toEqual(["spawn-failed", "spawn-failed", "nonzero-exit"]);
  });

  test("a child that never exits is KILLED at the timeout instead of pinning the caller", async () => {
    const traced: object[] = [];
    const c = child(() => { /* never exits */ });
    const ok = await startCodexAppServerDaemon({
      spawnFn: () => c.handle, probe: async () => true, trace: (event) => traced.push(event), timeoutMs: 20,
    });
    expect(ok).toBe(false);
    expect(c.kills).toEqual(["SIGTERM"]);
    expect(traced).toEqual([{ event: "codex-daemon-start", outcome: "timeout" }]);
  });
});

// The breadcrumb the phone shows under its diagnostics toggle while the socket is gone.
describe("appendCodexBridgeMarker (append-last, at most once, dropped rather than truncated)", () => {
  test("appends LAST while down, never doubles, and is STRIPPED once the socket is back", () => {
    expect(appendCodexBridgeMarker("1.0 ev:attention", true)).toBe(`1.0 ev:attention ${CODEX_BRIDGE_DOWN_MARKER}`);
    expect(appendCodexBridgeMarker("1.0 ev:attention", false)).toBe("1.0 ev:attention");
    const once = appendCodexBridgeMarker("1.0 ev:attention", true);
    expect(appendCodexBridgeMarker(once, true)).toBe(once);
    // A `dbg` CACHED on the session record (title repair, provisional row) must not keep accusing a
    // daemon that has since recovered.
    expect(appendCodexBridgeMarker(once, false)).toBe("1.0 ev:attention");
  });

  test("a non-Codex frame (undefined dbg) stays undefined — nothing is ever added to Claude", () => {
    expect(appendCodexBridgeMarker(undefined, true)).toBeUndefined();
    expect(appendCodexBridgeMarker("", true)).toBe("");
  });

  test("a dbg that has no room for the marker keeps its own grammar intact (whole-marker drop)", () => {
    const full = "x".repeat(DBG_BLOB_TEXT_MAX_CHARS);
    expect(appendCodexBridgeMarker(full, true)).toBe(full);
    const roomy = "x".repeat(DBG_BLOB_TEXT_MAX_CHARS - CODEX_BRIDGE_DOWN_MARKER.length - 1);
    expect(appendCodexBridgeMarker(roomy, true)).toBe(`${roomy} ${CODEX_BRIDGE_DOWN_MARKER}`);
  });
});

// --- unabridged copies for the LAN read op (NOM-44 phase 4) -------------------------------------

describe("fullTextForRecord (what gets teed onto the session record)", () => {
  test("stores NOTHING when the fit changed nothing — the phone reads the blob's own copy", () => {
    expect(fullTextForRecord("# Plan", "# Plan")).toBeUndefined();
    expect(fullTextForRecord("", "")).toBeUndefined();
    expect(fullTextForRecord(undefined, undefined)).toBeUndefined();
    expect(fullTextForRecord(undefined, "anything")).toBeUndefined();
  });

  test("stores the WHOLE string whenever the fit cut it — including when the field was dropped outright", () => {
    const full = `${"a".repeat(5000)}END`;
    expect(fullTextForRecord(full, `${"a".repeat(1200)}\n…`)).toBe(full); // truncated prefix
    expect(fullTextForRecord(full, undefined)).toBe(full);                // dropped entirely
    expect(fullTextForRecord(full, "")).toBe(full);                       // shed to empty
  });

  test("clips at the 256 K cap with the marker, and never mid-code-point", () => {
    const over = "🙂".repeat(RECORD_FULL_TEXT_MAX_CHARS + 1_000); // astral: 2 UTF-16 units per code point
    const stored = fullTextForRecord(over, "…")!;
    const chars = Array.from(stored);
    expect(chars.length).toBe(RECORD_FULL_TEXT_MAX_CHARS);
    expect(stored.endsWith(RECORD_FULL_TEXT_TRUNCATION_MARKER)).toBe(true);
    // No lone surrogate survived the slice: re-encoding is lossless.
    expect(chars.slice(0, chars.length - Array.from(RECORD_FULL_TEXT_TRUNCATION_MARKER).length).join("")).not.toContain("�");
    // Exactly AT the cap is not clipped.
    const exact = "x".repeat(RECORD_FULL_TEXT_MAX_CHARS);
    expect(fullTextForRecord(exact, "…")).toBe(exact);
  });

  test("recordFullTextIsComplete keys off the marker the cap appends", () => {
    expect(recordFullTextIsComplete("the whole plan")).toBe(true);
    expect(recordFullTextIsComplete(`clipped${RECORD_FULL_TEXT_TRUNCATION_MARKER}`)).toBe(false);
  });
});

describe("stampPermissionDetailFullAt (the permission hook's record patch)", () => {
  const record = (over: Record<string, unknown> = {}): string => JSON.stringify({
    pid: 4242, machine: "mac", label: "proj", ts: 1_800_000_000_000, op: "update", prio: 1,
    blob: "SEALED", pairingId: "pairing-abc", ...over,
  });

  async function dir(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "nomo-stamp-"));
  }

  test("patches ONE key onto an existing record, append-last, leaving every other key in place", async () => {
    const d = await dir();
    try {
      await writeFile(join(d, "s1.json"), record());
      await stampPermissionDetailFullAt(d, "s1", "the whole /bin/sh command");
      const parsed = JSON.parse(await readFile(join(d, "s1.json"), "utf8")) as Record<string, unknown>;
      expect(parsed.permissionDetailFull).toBe("the whole /bin/sh command");
      expect(Object.keys(parsed).at(-1)).toBe("permissionDetailFull");
      expect(parsed.blob).toBe("SEALED");
      expect(parsed.pairingId).toBe("pairing-abc");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("undefined DROPS the key — a prompt that rode whole clears the previous prompt's copy", async () => {
    const d = await dir();
    try {
      await writeFile(join(d, "s1.json"), record({ permissionDetailFull: "stale" }));
      await stampPermissionDetailFullAt(d, "s1", undefined);
      const parsed = JSON.parse(await readFile(join(d, "s1.json"), "utf8")) as Record<string, unknown>;
      expect("permissionDetailFull" in parsed).toBe(false);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("no record (reaped session) is a silent no-op, never a created file or a throw", async () => {
    const d = await dir();
    try {
      await stampPermissionDetailFullAt(d, "ghost", "content");
      expect(await readFile(join(d, "ghost.json"), "utf8").catch(() => null)).toBeNull();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("the remote-approval hold marker (the LAN channel's decision-pending guard)", () => {
  async function dir(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "nomo-hold-"));
  }

  test("round-trips, and lives beside the record WITHOUT ever looking like one", async () => {
    const d = await dir();
    try {
      const hold = { blob: "sealed-decision-pending", at: 1_800_000_000_000, pid: 4242 };
      await writeDecisionHoldAt(d, "s1", hold);
      expect(await readDecisionHoldAt(d, "s1")).toEqual(hold);
      // The whole reason this is not a SessionRecord field: `trackSessionAt` rebuilds the record whole
      // on every hook event and would erase it. The whole reason it is not a `.json` file: every other
      // readdir consumer of this directory filters on that extension, and a marker that read as a
      // session would surface on the phone as a row of its own.
      expect(decisionHoldFileName("s1")).toBe("s1.hold");
      expect(decisionHoldFileName("s1").endsWith(".json")).toBe(false);
      expect(await readdir(d)).toEqual(["s1.hold"]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("clearing is COMPARE-AND-CLEAR: a parallel tool's later hold survives our exit", async () => {
    const d = await dir();
    try {
      // Claude runs tools in PARALLEL. Tool A's hook holds, tool B's hook holds over it, then A exits.
      await writeDecisionHoldAt(d, "s1", { blob: "card-b", at: 2, pid: 777 });
      expect(await clearDecisionHoldAt(d, "s1", 4242)).toBe(false); // A's exit — not the owner
      expect(await readDecisionHoldAt(d, "s1")).toMatchObject({ pid: 777 });
      expect(await clearDecisionHoldAt(d, "s1", 777)).toBe(true);   // B's exit — the owner
      expect(await readDecisionHoldAt(d, "s1")).toBeNull();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("an absent or corrupt marker is never a throw: no owner, so it is simply removed", async () => {
    const d = await dir();
    try {
      expect(await clearDecisionHoldAt(d, "ghost", 1)).toBe(true); // nothing there → silent
      expect(await readDecisionHoldAt(d, "ghost")).toBeNull();
      await writeFile(join(d, "s1.hold"), "{not json");
      expect(await readDecisionHoldAt(d, "s1")).toBeNull();
      expect(await clearDecisionHoldAt(d, "s1", 1)).toBe(true);  // nobody can own it → gone
      expect(await readFile(join(d, "s1.hold"), "utf8").catch(() => null)).toBeNull();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  // The hook's record settle rides in here (field reports R2/R3): it must run only for the OWNER, and
  // strictly BEFORE the unlink — the LAN feed reads the record and the marker independently per pass, so
  // "marker gone + record stale" is exactly the frozen-yellow frame the settle exists to prevent.
  test("beforeUnlink runs for the owner, while the marker is still on disk — and never for anyone else", async () => {
    const d = await dir();
    try {
      await writeDecisionHoldAt(d, "s1", { blob: "card-a", at: 2, pid: 777 });
      let markerAtCallback: unknown;
      let calls = 0;
      // Not the owner → the callback never runs and the marker survives.
      expect(await clearDecisionHoldAt(d, "s1", 4242, async () => { calls += 1; })).toBe(false);
      expect(calls).toBe(0);
      expect(await readDecisionHoldAt(d, "s1")).toMatchObject({ pid: 777 });
      // The owner → the callback runs FIRST (the marker is still there when it does), then the unlink.
      expect(await clearDecisionHoldAt(d, "s1", 777, async () => {
        calls += 1;
        markerAtCallback = await readDecisionHoldAt(d, "s1");
      })).toBe(true);
      expect(calls).toBe(1);
      expect(markerAtCallback).toMatchObject({ pid: 777 });
      expect(await readDecisionHoldAt(d, "s1")).toBeNull();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("a throwing settle still retires the marker (a wedged card is worse than a stale record)", async () => {
    const d = await dir();
    try {
      await writeDecisionHoldAt(d, "s1", { blob: "card-a", at: 2, pid: 777 });
      expect(await clearDecisionHoldAt(d, "s1", 777, async () => { throw new Error("disk full"); })).toBe(true);
      expect(await readDecisionHoldAt(d, "s1")).toBeNull();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

// ---- the hold's RECORD settle (the exit the hook used to never write) --------------------------

describe("settleDecisionHoldRecordAt", () => {
  async function dir(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "nomo-settle-"));
  }

  const held = {
    pid: 1, machine: "m", label: "l", ts: 1_000, op: "update", prio: 1,
    lastEvent: "needsAttention", attentionKind: "userInput", blob: "stale-attention",
  };

  test("patches the record the hold overlaid, keys and all", async () => {
    const d = await dir();
    try {
      await writeFile(join(d, "s1.json"), JSON.stringify(held));
      await settleDecisionHoldRecordAt(d, "s1", {
        ts: 2_000, lastEvent: "working", op: "update", prio: 0, sentDone: false,
        attentionKind: undefined, blob: "sealed-working",
      });
      const after = JSON.parse(await readFile(join(d, "s1.json"), "utf8")) as Record<string, unknown>;
      expect(after).toMatchObject({
        pid: 1, machine: "m", ts: 2_000, op: "update", prio: 0, lastEvent: "working",
        sentDone: false, blob: "sealed-working",
      });
      expect("attentionKind" in after).toBe(false);            // undefined DROPS the key, like donePending
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("NO-OP unless the record is still the prio:1 update we overlaid", async () => {
    const d = await dir();
    try {
      // A later hook already advanced it (a parallel tool's PostToolUse / a done / an end): that state is
      // newer than anything this exiting hook knows, and must never be walked back.
      for (const over of [{ prio: 0 }, { op: "done", prio: 0 }, { op: "end", prio: 0 }, { op: undefined }]) {
        const moved = { ...held, ...over };
        await writeFile(join(d, "s1.json"), JSON.stringify(moved));
        await settleDecisionHoldRecordAt(d, "s1", { ts: 2_000, blob: "sealed-working" });
        expect(JSON.parse(await readFile(join(d, "s1.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(moved)));
      }
      // …and a record that is gone entirely is simply nothing to patch.
      await settleDecisionHoldRecordAt(d, "ghost", { ts: 2_000 });
      expect(await readFile(join(d, "ghost.json"), "utf8").catch(() => null)).toBeNull();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
