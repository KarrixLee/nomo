import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  codexAppServerSocketAvailable, codexAppServerSocketPath, ensureWatchdog, formatWatchdogPidfile, isWatchdogCommand,
  localApprovalsState, parseWatchdogPidfile, PLUGIN_VERSION, watchdogHolderIsLive,
} from "./shared";

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
