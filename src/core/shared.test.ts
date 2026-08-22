import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { decryptBlob } from "./crypto";
import {
  appendCodexBridgeMarker, BRANCH_MAX_CHARS, branchFromHead, clearDecisionHoldAt, CODEX_BRIDGE_DOWN_MARKER, CODEX_DAEMON_START_ARGS,
  folderIdentity, resolveGitDir, sessionBranch,
  codexAppServerSocketAvailable, codexAppServerSocketPath, codexAppServerSocketState, codexCompanionBrokerEvidence,
  DBG_BLOB_TEXT_MAX_CHARS, startCodexAppServerDaemon,
  decisionHoldFileName, ensureWatchdog, formatWatchdogPidfile, fullTextForRecord, isWatchdogCommand, watchdogVersionOutranks,
  readDecisionHoldAt, writeDecisionHoldAt,
  localApprovalsState, parseWatchdogPidfile, PLUGIN_VERSION, postFullText, RECORD_FULL_TEXT_MAX_CHARS,
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

// The version a running daemon self-reports (watchdog pidfile, a record's `dbg`, the x-cc-version
// header) comes from the stamp baked into the COMMITTED plugin/dist/*.mjs — not from the manifests a
// host reads. Those two drift apart the moment a version bump edits the manifests without re-running
// `bun build.ts`, and the result is a daemon that runs new code while reporting the old version, which
// costs real time in a diagnosis. build.ts refuses to bundle manifests that disagree with each other;
// this is the other half — it proves the checked-in bundle actually carries the current version.
const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Every manifest carrying the plugin version. The Claude plugin manifest is the source build.ts
 *  injects from; the rest are what the Claude/Codex marketplaces and the Codex host display. */
const VERSION_MANIFESTS: [path: string, pick: (doc: any) => (string | undefined)[]][] = [
  ["plugin/.claude-plugin/plugin.json", (d) => [d.version]],
  ["plugin/.codex-plugin/plugin.json", (d) => [d.version]],
  [".claude-plugin/marketplace.json", (d) => (d.plugins ?? []).map((p: any) => p.version)],
  [".agents/plugins/marketplace.json", (d) => (d.plugins ?? []).map((p: any) => p.version)],
];

const manifestVersion = async (path: string): Promise<any> =>
  JSON.parse(await readFile(join(REPO_ROOT, path), "utf8"));

describe("release version stamp (manifests ↔ committed dist)", () => {
  test("every manifest declares the same version", async () => {
    const [sourcePath, sourcePick] = VERSION_MANIFESTS[0];
    const expected = sourcePick(await manifestVersion(sourcePath))[0];
    expect(expected).toMatch(/^\d+\.\d+\.\d+$/);

    for (const [path, pick] of VERSION_MANIFESTS) {
      const found = pick(await manifestVersion(path));
      expect(found.length).toBeGreaterThan(0);
      // Named per-manifest so a partial bump names the file that was missed.
      for (const version of found) expect({ path, version }).toEqual({ path, version: expected });
    }
  });

  test("every committed dist bundle is stamped with the manifest version (rebuild after a bump)", async () => {
    const [sourcePath, sourcePick] = VERSION_MANIFESTS[0];
    const expected = sourcePick(await manifestVersion(sourcePath))[0];

    const distDir = join(REPO_ROOT, "plugin", "dist");
    // .mjs is every hook/command entry; .js is the OpenCode plugin, whose extension is forced
    // by OpenCode's `{plugin,plugins}/*.{ts,js}` discovery glob. Both carry the injected stamp,
    // so both must be checked or a stale OpenCode bundle ships unnoticed.
    const bundles = (await readdir(distDir)).filter((f) => /\.(mjs|js)$/.test(f));
    expect(bundles.length).toBeGreaterThan(0);

    for (const bundle of bundles) {
      const source = await readFile(join(distDir, bundle), "utf8");
      const stamp = source.match(/PLUGIN_VERSION = "([^"]+)"/)?.[1];
      // Named per-bundle so a stale dist/ names the artifact and the version it is stuck on.
      expect({ bundle, stamp }).toEqual({ bundle, stamp: expected });
    }
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

  // THE PEER BUG (2026-08-19): "different build" used to mean "an upgrade", because Claude Code and
  // Codex ship from ONE bundle and could not disagree. OpenCode is the first PEER install, so the two
  // now sit at different versions on one machine — and plain mismatch→SIGTERM made them evict each
  // other on every event (observed live: the watchdog-hosted LAN listener rebinding in a loop, and a
  // 2.0.2 daemon rebuilding an OpenCode frame it had no adapter for). Highest version wins.
  describe("peer installs: only a STRICTLY NEWER build may take the daemon", () => {
    test("newer → SIGTERM the incumbent and spawn", () => {
      expect(run("777 1.4.3", { version: "1.4.4" })).toEqual({ kills: [[777, "SIGTERM"]], spawned: 1 });
      // The live pair, and the case a LEXICAL compare gets backwards: "2.1.1" < "2.0.2" as strings.
      expect(run("777 2.0.2", { version: "2.1.1" })).toEqual({ kills: [[777, "SIGTERM"]], spawned: 1 });
    });

    test("EQUAL → leave it strictly alone (no kill, and no second daemon either)", () => {
      expect(run("777 1.4.4", { version: "1.4.4" })).toEqual({ kills: [], spawned: 0 });
      // Numerically equal but spelled differently (build metadata) is still equal — not a takeover.
      expect(run("777 1.4.4", { version: "1.4.4+codex.3" })).toEqual({ kills: [], spawned: 0 });
    });

    test("OLDER → accept the newer daemon: never downgrade it, never spawn beside it", () => {
      expect(run("777 2.3.0", { version: "2.1.1" })).toEqual({ kills: [], spawned: 0 });
      expect(run("777 2.10.0", { version: "2.9.0" })).toEqual({ kills: [], spawned: 0 });
    });

    test("the two-digit trap: 2.10.0 outranks 2.9.0, both directions", () => {
      expect(watchdogVersionOutranks("2.10.0", "2.9.0")).toBe(true);
      expect(watchdogVersionOutranks("2.9.0", "2.10.0")).toBe(false);
      expect(watchdogVersionOutranks("2.1.1", "2.0.2")).toBe(true);
      expect(watchdogVersionOutranks("2.0.2", "2.1.1")).toBe(false);
    });

    test("ABSENT version (a pre-stamp pidfile) counts as older → we take over", () => {
      expect(watchdogVersionOutranks("2.1.1", undefined)).toBe(true);
      expect(run("777", { version: "2.1.1" })).toEqual({ kills: [[777, "SIGTERM"]], spawned: 1 });
    });

    test("an UNPARSEABLE version on either side fails SAFE — no eviction, no spawn", () => {
      expect(watchdogVersionOutranks("2.1.1", "who-knows")).toBe(false);
      expect(watchdogVersionOutranks("who-knows", "2.1.1")).toBe(false);
      expect(watchdogVersionOutranks("2.1.1", "")).toBe(false);
      expect(run("777 who-knows", { version: "2.1.1" })).toEqual({ kills: [], spawned: 0 });
    });

    test("build metadata and the 0.0.0-dev sentinel parse; dev orders LOWEST", () => {
      expect(watchdogVersionOutranks("0.8.10+codex.3", "0.8.9")).toBe(true);
      expect(watchdogVersionOutranks("0.8.10+codex.3", "0.8.10+codex.2")).toBe(false); // same numbers
      // The unbundled sentinel is 0.0.0: a raw-source run never evicts an installed release (use
      // `reset`), and a release always outranks it.
      expect(watchdogVersionOutranks("0.0.0-dev", "2.1.1")).toBe(false);
      expect(watchdogVersionOutranks("2.1.1", "0.0.0-dev")).toBe(true);
    });

    test("a SAME-version rebuild in place still takes over (the build stamp, unchanged by all this)", () => {
      expect(run("777 2.1.1 aaa", { version: "2.1.1", build: "bbb" }))
        .toEqual({ kills: [[777, "SIGTERM"]], spawned: 1 });
      // …and a build stamp never rescues an OLDER build: the version decides first.
      expect(run("777 2.3.0 aaa", { version: "2.1.1", build: "bbb" })).toEqual({ kills: [], spawned: 0 });
    });
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

  // THE 2026-08-09 OUTAGE, reproduced. A Codex app-server daemon died and left its control socket file
  // behind (recorded pid gone, nothing holding the inode, connect → ECONNREFUSED). The probe was a
  // `stat().isSocket()`, which is TRUE for that corpse — so the watchdog built a bridge on a daemon that
  // was not there, `cxbridge:down` never stamped, the daemon restart never armed, and every Codex
  // question for five hours arrived on the phone as an unanswerable attention row.
  //
  // Building a genuinely stale socket: bind a listener, RENAME its socket file aside, then close the
  // listener. Closing unlinks the name it bound (now gone), so the renamed inode survives as a socket
  // file that no process is listening on — exactly tonight's filesystem state.
  const staleSocket = async (dir: string): Promise<string> => {
    const bound = join(dir, "bound.sock");
    const orphan = join(dir, "app-server-control.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bound, () => resolve());
    });
    await rename(bound, orphan);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return orphan;
  };

  test("a DEAD daemon's leftover socket file reads UNAVAILABLE (a stat would have said 'up')", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-sock-"));
    try {
      const orphan = await staleSocket(dir);
      expect((await stat(orphan)).isSocket()).toBe(true); // the old probe's whole test — still true
      expect(await codexAppServerSocketAvailable(orphan)).toBe(false); // …and still not a daemon
      expect(await codexAppServerSocketState(orphan)).toBe("stale");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a LIVE listener still reads available (the probe did not just turn everything off)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-sock-"));
    const server = createServer();
    try {
      const live = join(dir, "app-server-control.sock");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(live, () => resolve());
      });
      expect(await codexAppServerSocketAvailable(live)).toBe(true);
      expect(await codexAppServerSocketState(live)).toBe("live");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("nothing at the path at all is ABSENT, and a plain file is ABSENT too (never 'stale')", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-sock-"));
    try {
      expect(await codexAppServerSocketState(join(dir, "nope.sock"))).toBe("absent");
      const plain = join(dir, "plain.sock");
      await writeFile(plain, "");
      expect(await codexAppServerSocketState(plain)).toBe("absent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

// --- the remote half: what postFullText puts on the wire vs. inside the seal (NOM-44 phase 5) ----
//
// The split is the whole security property: the CLEAR body is what the blind worker keys on and must
// stay exactly `{v, sessionId, what, blob}`; everything the phone re-asserts an answer against lives
// INSIDE the seal, where only this Mac could have written it.

describe("postFullText (the sealed identity vs. the clear body)", () => {
  const KEY = new Uint8Array(32).fill(7);
  const CONFIG = { url: "https://w.example", pairingId: "p1", pcSecret: "s1", e2eKey: KEY };

  /** Runs one upload against a capturing fetch and hands back both halves of what it sent. */
  const post = async (what: "plan" | "permission-detail", requestId?: string) => {
    let sent: Record<string, unknown> | undefined;
    const fn = (async (_url: string, init?: { body?: string }) => {
      sent = JSON.parse(init!.body!) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await postFullText(CONFIG, "sess-1", what, "the whole thing", fn, undefined, requestId);
    return { body: sent!, sealed: await decryptBlob(KEY, sent!.blob as string) as Record<string, unknown> };
  };

  test("the clear body is FROZEN — the request id rides only inside the seal", async () => {
    const { body, sealed } = await post("permission-detail", "req-9");
    expect(body).toEqual({ v: 2, sessionId: "sess-1", what: "permission-detail", blob: body.blob });
    expect(sealed.requestId).toBe("req-9");
  });

  test("a PLAN seals no request id at all — it has no hold, and the phone asserts the absence", async () => {
    const { sealed } = await post("plan");
    expect(sealed).toEqual({ sessionId: "sess-1", what: "plan", content: "the whole thing", complete: true });
    expect("requestId" in sealed).toBe(false); // `undefined` drops the key: byte-identical to before
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

// --- the session folder's LIVE git branch --------------------------------------------------------
//
// Every fixture below is a REAL directory tree under os.tmpdir() — nothing here is mocked, because the
// whole feature is "what do these two files on disk actually say". The resolver is file reads only (no
// `git` subprocess): it runs inside a hook that BLOCKS the agent, on every single event.
describe("resolveGitDir / branchFromHead / sessionBranch (the folder's live git branch)", () => {
  const roots: string[] = [];
  const tmp = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "nomo-branch-"));
    roots.push(d);
    return d;
  };
  /** A plain checkout: `<dir>/.git/` holding HEAD. */
  const repoAt = async (dir: string, head = "ref: refs/heads/main\n"): Promise<string> => {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), head);
    return join(dir, ".git");
  };
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  test("a plain repo: `.git` is a DIRECTORY, and HEAD names the branch", async () => {
    const root = await tmp();
    const gitDir = await repoAt(root);
    expect(resolveGitDir(root)).toBe(gitDir);
    expect(branchFromHead(gitDir)).toBe("main");
    expect(sessionBranch({ cwd: root })).toBe("main");
  });

  test("a session started in a SUBDIRECTORY walks UP to the repo's `.git`", async () => {
    // The common shape in the field: the agent is launched in `server/` (or deeper) inside a checkout,
    // where there is no `.git` at all. Checking only the cwd would report no branch for a large share of
    // real sessions, which is why the upward walk exists.
    const root = await tmp();
    const gitDir = await repoAt(root, "ref: refs/heads/dev\n");
    const deep = join(root, "packages", "server", "src", "handlers");
    await mkdir(deep, { recursive: true });
    expect(resolveGitDir(deep)).toBe(gitDir);
    expect(sessionBranch({ cwd: deep })).toBe("dev");
  });

  test("`.git` as a FILE with an ABSOLUTE gitdir: (a worktree) resolves to the pointed-at dir", async () => {
    const base = await tmp();
    const store = join(base, "store", "worktrees", "feature");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "HEAD"), "ref: refs/heads/feature-work\n");
    const work = join(base, "wt");
    await mkdir(work, { recursive: true });
    await writeFile(join(work, ".git"), `gitdir: ${store}\n`);
    expect(resolveGitDir(work)).toBe(store);
    expect(sessionBranch({ cwd: work })).toBe("feature-work");
  });

  test("`.git` as a FILE with a RELATIVE gitdir: resolves against the file's OWN directory", async () => {
    // What `git submodule` commonly writes (`gitdir: ../.git/modules/x`). Resolving it against the
    // process cwd instead — the hook's own, which has nothing to do with the session — would miss.
    const base = await tmp();
    const store = join(base, "modules", "plugin");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "HEAD"), "ref: refs/heads/sub-branch\n");
    const sub = join(base, "checkout", "plugin");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, ".git"), "gitdir: ../../modules/plugin\n");
    expect(resolveGitDir(sub)).toBe(store);
    expect(sessionBranch({ cwd: sub })).toBe("sub-branch");
    // …and from a subdirectory of the submodule, the walk finds the SAME pointer file.
    const inner = join(sub, "src");
    await mkdir(inner, { recursive: true });
    expect(sessionBranch({ cwd: inner })).toBe("sub-branch");
  });

  test("a submodule whose pointer is unreadable reports NOTHING, never the superproject's branch", async () => {
    // The `.git` FILE is the repository boundary. Falling through to the parent would confidently show
    // the wrong branch — worse than showing none.
    const base = await tmp();
    await repoAt(base, "ref: refs/heads/superproject\n");
    const sub = join(base, "vendor", "lib");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, ".git"), "this is not a gitdir pointer\n");
    expect(resolveGitDir(sub)).toBeUndefined();
    expect(sessionBranch({ cwd: sub })).toBeUndefined();
  });

  test("a DETACHED HEAD (bare 40-hex sha) becomes the 7-char short sha", async () => {
    const root = await tmp();
    const gitDir = await repoAt(root, "9f1a2b3c4d5e60718293a4b5c6d7e8f901234567\n");
    expect(branchFromHead(gitDir)).toBe("9f1a2b3");
    expect(sessionBranch({ cwd: root })).toBe("9f1a2b3");
  });

  test("a branch name containing `/` survives INTACT (never split on the separator)", async () => {
    const root = await tmp();
    await repoAt(root, "ref: refs/heads/feat/hybrid-lan\n");
    expect(sessionBranch({ cwd: root })).toBe("feat/hybrid-lan");
  });

  test("a pathological ref name is CAPPED at BRANCH_MAX_CHARS (the sealed frame has a ceiling)", async () => {
    const root = await tmp();
    const long = "a".repeat(BRANCH_MAX_CHARS * 3);
    await repoAt(root, `ref: refs/heads/${long}\n`);
    const branch = sessionBranch({ cwd: root })!;
    expect(branch.length).toBe(BRANCH_MAX_CHARS);
    expect(branch).toBe(long.slice(0, BRANCH_MAX_CHARS));
  });

  test("NOT a repo at all ⇒ undefined — the key is omitted, never an empty string", async () => {
    const root = await tmp();
    expect(resolveGitDir(root)).toBeUndefined();
    expect(sessionBranch({ cwd: root })).toBeUndefined();
    expect(sessionBranch({})).toBeUndefined();
    expect(sessionBranch(undefined)).toBeUndefined();
    expect(sessionBranch({ cwd: "" })).toBeUndefined();
  });

  test("an empty / malformed / non-branch HEAD is undefined, never a guess", async () => {
    for (const head of ["", "   \n", "garbage\n", "ref: \n", "ref: refs/tags/v1.2.3\n", "ref: refs/remotes/origin/main\n", "9f1a2b3\n"]) {
      const root = await tmp();
      const gitDir = await repoAt(root, head);
      expect(branchFromHead(gitDir)).toBeUndefined();
      expect(sessionBranch({ cwd: root })).toBeUndefined();
    }
    // …and a `.git` directory with no HEAD in it at all.
    const bare = await tmp();
    await mkdir(join(bare, ".git"), { recursive: true });
    expect(resolveGitDir(bare)).toBe(join(bare, ".git"));
    expect(sessionBranch({ cwd: bare })).toBeUndefined();
  });

  test("LIVE, not pinned: a `git checkout` between two calls CHANGES the emitted value", async () => {
    // The paths are pinned so a `cd` cannot move the phone row; the branch deliberately is not. HEAD is
    // re-read on every call precisely so a checkout shows up on the phone.
    const root = await tmp();
    const gitDir = await repoAt(root, "ref: refs/heads/main\n");
    expect(sessionBranch({ cwd: root })).toBe("main");
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/feat/hybrid-lan\n");
    expect(sessionBranch({ cwd: root })).toBe("feat/hybrid-lan");
    await writeFile(join(gitDir, "HEAD"), "9f1a2b3c4d5e60718293a4b5c6d7e8f901234567\n");
    expect(sessionBranch({ cwd: root })).toBe("9f1a2b3");
  });

  test("the CACHED gitDir skips the walk but still re-reads HEAD (a checkout is not cached away)", async () => {
    const root = await tmp();
    const gitDir = await repoAt(root, "ref: refs/heads/main\n");
    // A pinned record: cwd + the git dir resolved once, at pin time.
    const pinned = { cwd: root, gitDir };
    expect(sessionBranch(pinned)).toBe("main");
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/release/2.0\n");
    expect(sessionBranch(pinned)).toBe("release/2.0");
    // The cache is genuinely used: with a cwd that is nowhere near a repo, the cached dir still answers.
    expect(sessionBranch({ cwd: join(root, "does", "not", "exist"), gitDir })).toBe("release/2.0");
  });

  test("a cached gitDir that stops resolving falls back to a FRESH walk rather than going blank", async () => {
    // The worktree was pruned / the repo moved / `git init` re-made it. A dead cache must degrade to the
    // slow path, not to a permanently branch-less row.
    const root = await tmp();
    await repoAt(root, "ref: refs/heads/main\n");
    expect(sessionBranch({ cwd: root, gitDir: join(root, "gone", "worktrees", "x") })).toBe("main");
    // …and when the fresh walk finds nothing either, the key is simply omitted.
    const bare = await tmp();
    expect(sessionBranch({ cwd: bare, gitDir: join(bare, "gone") })).toBeUndefined();
  });

  test("folderIdentity pins cwd + gitDir alongside label/folderKey, and never re-derives them from a pin", async () => {
    const root = await tmp();
    const gitDir = await repoAt(root, "ref: refs/heads/main\n");
    // FIRST event: everything is derived from the one cwd being pinned.
    const first = folderIdentity(root);
    expect(first).toMatchObject({ label: basename(root), cwd: root, gitDir });
    // A LATER event after the shell `cd`s elsewhere: the pin wins for the paths too, so the branch keeps
    // describing the folder the pinned label names — not wherever the shell wandered.
    const other = await tmp();
    await repoAt(other, "ref: refs/heads/elsewhere\n");
    const later = folderIdentity(other, first);
    expect(later.cwd).toBe(root);
    expect(later.gitDir).toBe(gitDir);
    expect(sessionBranch(later)).toBe("main");
    // A record pinned by a plugin PREDATING the pin has a label and no cwd: it yields no cwd (and so no
    // branch) rather than adopting the live event's, which would describe a different directory.
    const legacy = folderIdentity(other, { label: "api-status", folderKey: "0123456789ab" });
    expect(legacy).toEqual({ label: "api-status", folderKey: "0123456789ab" });
    expect(sessionBranch(legacy)).toBeUndefined();
    // …as does a bare-string pin (every positional caller predating the folder key).
    expect(sessionBranch(folderIdentity(other, "api-status"))).toBeUndefined();
  });
});
