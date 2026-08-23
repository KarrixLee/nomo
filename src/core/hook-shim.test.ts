// Tests for the version-stable hook shim (plugin/scripts/hook-shim.sh) and the run.sh upkeep block
// that installs it.
//
// THE REGRESSION THESE GUARD. Both hosts install a plugin into a VERSION-PINNED cache directory
// (~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/, same shape under ~/.claude) and Codex
// removes the previous one on update. Codex hooks are spawned by the long-lived `codex app-server`
// daemon, which resolves $PLUGIN_ROOT once and keeps it for days — so after any version bump every
// hook exec'd through that root dies with 127, for new sessions too, until the daemon restarts. The
// shim is a path that never moves; these tests drive the real shell scripts, because the bug lives in
// process/exec semantics that a mocked filesystem would not reproduce.
//
// Everything runs against a throwaway HOME with a synthetic plugin cache; the shell scripts are the
// repo's real ones, and the "dist bundles" are one-line scripts that announce which root ran them.

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createProcessHygiene, isolatedTestEnv } from "../test/process-hygiene";

const { spawnTestProcess } = createProcessHygiene();

const PLUGIN_DIR = join(import.meta.dir, "../../plugin");
const RUN_SH = join(PLUGIN_DIR, "scripts/run.sh");
const SHIM_SH = join(PLUGIN_DIR, "scripts/hook-shim.sh");
const CODEX_HOOKS = join(PLUGIN_DIR, "hooks/codex-hooks.json");
const CLAUDE_HOOKS = join(PLUGIN_DIR, "hooks/hooks.json");

/** The entry names the shim is allowed to launch — kept in step with plugin/dist/*.mjs. */
const ENTRIES = [
  "cc-status", "cc-permission", "cc-watchdog", "codex-status", "codex-permission",
  "codex-notify", "pair", "unpair", "reset", "status-cmd", "opencode-update",
];

/** The shim revision run.sh currently installs. Read from the script rather than hard-coded, so a
 *  future shim edit (which MUST bump this) doesn't fail these tests for the wrong reason. */
const SHIM_REV = (/^NOMO_SHIM_REV=(\d+)$/m.exec(await readFile(RUN_SH, "utf8")) ?? [, "?"])[1]!;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

async function newHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "nomo-shim-"));
  homes.push(home);
  return home;
}

/** A synthetic installed copy: the repo's real run.sh + hook-shim.sh, plus stub bundles that print the
 *  root they were launched from, so a test can tell WHICH version actually ran. */
async function installRoot(root: string): Promise<string> {
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  for (const [name, src] of [["run.sh", RUN_SH], ["hook-shim.sh", SHIM_SH]] as const) {
    await writeFile(join(root, "scripts", name), await readFile(src, "utf8"));
    await chmod(join(root, "scripts", name), 0o755);
  }
  for (const entry of ENTRIES) {
    // Also record argv to a file: the notify path BACKGROUNDS the bundle with its output sent to
    // /dev/null, so stdout cannot prove what ran or what it was handed.
    await writeFile(join(root, "dist", `${entry}.mjs`), [
      'import { appendFileSync } from "node:fs";',
      `console.log("ran ${entry} @ ${root}");`,
      `appendFileSync(process.env.HOME + "/ran.log", ${JSON.stringify(`${entry} @ ${root} `)} + JSON.stringify(process.argv.slice(2)) + "\\n");`,
      "",
    ].join("\n"));
  }
  return root;
}

/** A stand-in for a pre-existing `notify` program the user already had (the SkyComputerUseClient
 *  slot). Records its own argv so the chain's hand-off can be verified verbatim. */
async function installPrevNotify(home: string, name = "prev-notify"): Promise<string> {
  const path = join(home, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "prev $*" >>"$HOME/ran.log"\n`);
  await chmod(path, 0o755);
  return path;
}

/** The chain backgrounds the nomo bundle, so its line lands after the shim has already exited. */
async function waitForLog(home: string, needle: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let log = "";
    try { log = await readFile(join(home, "ran.log"), "utf8"); } catch { /* not written yet */ }
    if (log.includes(needle)) return log;
    if (Date.now() > deadline) return log;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const cachedRoot = (home: string, host: ".codex" | ".claude", market: string, plugin: string, version: string): string =>
  join(home, host, "plugins/cache", market, plugin, version);

/** Drop the shim into the state dir directly, for the cases that want to exercise resolution without
 *  first arranging a bootstrap run of run.sh. */
async function placeShim(home: string): Promise<void> {
  await mkdir(join(home, ".config/cc-status"), { recursive: true, mode: 0o700 });
  await writeFile(join(home, ".config/cc-status/hook-shim.sh"), await readFile(SHIM_SH, "utf8"));
  await chmod(join(home, ".config/cc-status/hook-shim.sh"), 0o700);
}

interface ShellResult { code: number; stdout: string; stderr: string }

async function runShell(argv: string[], home: string, env: Record<string, string | undefined> = {}): Promise<ShellResult> {
  const proc = spawnTestProcess({
    cmd: argv,
    env: isolatedTestEnv(home, env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Invoke the installed shim exactly the way a hook command does (plus any forwarded argv). */
const runShim = (home: string, entry: string, ...args: string[]): Promise<ShellResult> =>
  runShell([join(home, ".config/cc-status/hook-shim.sh"), entry, ...args], home);

/** Run one hook COMMAND STRING straight out of a manifest, through /bin/sh, with the host's root env
 *  var set to whatever the (possibly stale) daemon would have handed it. */
async function runHookCommand(home: string, command: string, rootEnv: Record<string, string>): Promise<ShellResult> {
  return runShell(["/bin/sh", "-c", command], home, rootEnv);
}

async function readStamp(home: string): Promise<string> {
  return (await readFile(join(home, ".config/cc-status/hook-shim.stamp"), "utf8")).trim();
}

interface HookEntry { type?: string; command?: string; timeout?: number }
interface HookManifest { hooks: Record<string, Array<{ hooks?: HookEntry[] }>> }

async function hookCommands(path: string): Promise<Array<{ event: string; command: string }>> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as HookManifest;
  const out: Array<{ event: string; command: string }> = [];
  for (const [event, groups] of Object.entries(manifest.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) out.push({ event, command: hook.command ?? "" });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("hook manifests carry the shim fallback", () => {
  // A LINT, not a behavior test: the whole fix is worthless on any hook that forgets the fallback, and
  // an eighth event added a year from now must not be able to reintroduce the outage quietly.
  for (const [label, path, rootVar] of [
    ["codex-hooks.json", CODEX_HOOKS, "PLUGIN_ROOT"],
    ["hooks.json", CLAUDE_HOOKS, "CLAUDE_PLUGIN_ROOT"],
  ] as const) {
    test(`${label}: every command prefers the live root, then falls back to the shim`, async () => {
      const commands = await hookCommands(path);
      expect(commands.length).toBeGreaterThan(0);
      for (const { event, command } of commands) {
        expect(`${event}: ${command}`).toContain(`\${${rootVar}}`);
        // Guarded, so an unset/empty root can never produce a bogus "/scripts/run.sh" that passes -x.
        expect(`${event}: ${command}`).toContain('[ -n "$NOMOR" ]');
        expect(`${event}: ${command}`).toContain('[ -x "$NOMOR/scripts/run.sh" ]');
        expect(`${event}: ${command}`).toContain("$HOME/.config/cc-status/hook-shim.sh");
        // The shim exec is itself guarded: exec-ing a missing shim would print to stderr and surface
        // as a failed hook, which is the noise the whole design exists to avoid.
        expect(`${event}: ${command}`).toContain('[ -x "$NOMOS" ]');
        expect(`${event}: ${command}`).toContain("exit 0");
      }
    });

    test(`${label}: the fallback entry name matches the bundle and is on the shim whitelist`, async () => {
      for (const { event, command } of await hookCommands(path)) {
        const bundle = /dist\/([a-z-]+)\.mjs/.exec(command)?.[1];
        const fallback = /exec "\$NOMOS" ([a-z-]+)/.exec(command)?.[1];
        expect(`${event}: bundle=${bundle}`).toBe(`${event}: bundle=${fallback}`);
        expect(ENTRIES).toContain(bundle!);
      }
    });
  }

  test("the shim's whitelist and the test's entry list agree with each other", async () => {
    const shim = await readFile(SHIM_SH, "utf8");
    const clause = /\n\s{2}(cc-status\|[a-z|-]+)\)/.exec(shim)?.[1];
    expect(clause).toBeTruthy();
    expect(clause!.split("|").sort()).toEqual([...ENTRIES].sort());
  });
});

describe("hook-shim resolution", () => {
  test("STALE ROOT: a deleted PLUGIN_ROOT still launches, from the newer version dir", async () => {
    const home = await newHome();
    const old = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.7"));
    // Bootstrap the way a real machine does: the pre-bump hook installs the shim while its root lives.
    const bootstrap = await runShell([join(old, "scripts/run.sh"), join(old, "dist/codex-status.mjs")], home);
    expect(bootstrap.stdout).toContain(`@ ${old}`);

    const next = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.8"));
    await rm(old, { recursive: true, force: true });

    // The daemon keeps handing out the dead root; the manifest command is what has to cope.
    const [{ command }] = await hookCommands(CODEX_HOOKS);
    const res = await runHookCommand(home, command, { PLUGIN_ROOT: old });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`ran codex-status @ ${next}`);
    expect(res.stderr).toBe("");
  });

  test("without the shim installed the same stale root produces nothing (the bug being fixed)", async () => {
    const home = await newHome();
    const old = cachedRoot(home, ".codex", "acme", "nomo", "1.7.7");
    await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.8"));
    const [{ command }] = await hookCommands(CODEX_HOOKS);
    // No bootstrap run, so no shim exists — this is what every pre-1.7.8 install looks like.
    const res = await runHookCommand(home, command, { PLUGIN_ROOT: old });
    expect(res.stdout).toBe("");
    // Silent, though: the guarded exec means the user still sees no hook error.
    expect(res.code).toBe(0);
    expect(res.stderr).toBe("");
  });

  test("FAST PATH: the recorded root wins even when a newer version sits in the cache", async () => {
    const home = await newHome();
    const recorded = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.0.0"));
    await runShell([join(recorded, "scripts/run.sh"), join(recorded, "dist/cc-status.mjs")], home);
    // A newer install the scan would certainly prefer — proving the scan is not being walked at all.
    const newer = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "9.9.9"));

    const res = await runShim(home, "cc-status");
    expect(res.stdout).toContain(`@ ${recorded}`);
    expect(res.stdout).not.toContain(newer);
  });

  test("SEMVER, NOT LEXICAL: 1.7.9 vs 1.7.10 vs 1.10.0 resolves to 1.10.0", async () => {
    const home = await newHome();
    const boot = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.9"));
    await runShell([join(boot, "scripts/run.sh"), join(boot, "dist/codex-status.mjs")], home);
    await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.10"));
    const best = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.10.0"));
    // Drop the stamp so resolution has to go through the scan.
    await rm(join(home, ".config/cc-status/hook-shim.stamp"), { force: true });

    const res = await runShim(home, "codex-status");
    expect(res.stdout).toContain(`@ ${best}`);
  });

  test("a prerelease loses to the release with the same numbers", async () => {
    const home = await newHome();
    await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "2.0.0-rc1"));
    const release = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "2.0.0"));
    await placeShim(home);

    const res = await runShim(home, "codex-status");
    expect(res.stdout).toContain(`@ ${release}`);
  });

  test("ORPHANED dirs are skipped even when they are the newest", async () => {
    const home = await newHome();
    const live = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.8"));
    const orphan = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "2.0.0"));
    await writeFile(join(orphan, ".orphaned_at"), "2026-08-06T00:00:00Z\n");
    await placeShim(home);

    const res = await runShim(home, "codex-status");
    expect(res.stdout).toContain(`@ ${live}`);
    expect(res.stdout).not.toContain(orphan);
  });

  test("the Claude cache is searched too, and a marketplace name of any shape is accepted", async () => {
    const home = await newHome();
    const root = await installRoot(cachedRoot(home, ".claude", "some-fork-of-nomo", "nomo-cc", "1.7.8"));
    await placeShim(home);

    const res = await runShim(home, "cc-status");
    expect(res.stdout).toContain(`@ ${root}`);
  });

  test("a version dir missing the requested bundle is passed over for one that has it", async () => {
    const home = await newHome();
    const partial = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "2.0.0"));
    await rm(join(partial, "dist/codex-permission.mjs"), { force: true });
    const complete = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.9.0"));
    await placeShim(home);

    const res = await runShim(home, "codex-permission");
    expect(res.stdout).toContain(`@ ${complete}`);
  });

  test("NOTHING RESOLVABLE: exit 0, no stdout, no stderr", async () => {
    const home = await newHome();
    await placeShim(home);
    // A stamp pointing at a root that no longer exists, and no cache to fall back on.
    await writeFile(join(home, ".config/cc-status/hook-shim.stamp"), `${SHIM_REV} ${join(home, "gone")}\n`);

    const res = await runShim(home, "codex-status");
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });

  test("ENTRY VALIDATION: traversal, injection and junk names are refused in silence", async () => {
    const home = await newHome();
    const root = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.8"));
    await runShell([join(root, "scripts/run.sh"), join(root, "dist/codex-status.mjs")], home);
    // Something outside the plugin that a traversal could otherwise reach.
    await mkdir(join(home, "evil/scripts"), { recursive: true });
    await writeFile(join(home, "evil/scripts/run.sh"), "#!/bin/sh\necho PWNED\n");
    await chmod(join(home, "evil/scripts/run.sh"), 0o755);

    for (const bad of [
      "../../../../etc/passwd",
      "../../../evil/dist/x",
      "cc-status/../../evil",
      "cc-status; echo PWNED",
      "cc-status\nreset",
      "*",
      "",
      "CC-STATUS",
    ]) {
      const res = await runShim(home, bad);
      expect(`${bad} => ${res.code}`).toBe(`${bad} => 0`);
      expect(res.stdout).toBe("");
      expect(res.stderr).toBe("");
    }
    // …while the legitimate name still works, so the whitelist is not simply refusing everything.
    expect((await runShim(home, "codex-status")).stdout).toContain(`@ ${root}`);
  });
});

describe("the shim forwards argv, and carries the Codex notify fan-out", () => {
  // WHY THE FAN-OUT MOVED HERE (v1.7.9). Codex's `notify` setting is an argv array in config.toml,
  // exec'd directly — no shell, no env expansion, no fallback — and config.toml is written once at
  // pairing and never revisited. So the old value (scripts/notify-chain.sh + dist/codex-notify.mjs,
  // both inside the version-pinned plugin root) broke PERMANENTLY at the user's first update, not
  // merely until a daemon restart. Naming the shim instead moves the resolution to run time; carrying
  // the fan-out here is what lets one stable file serve that value.

  test("extra argv reaches the bundle (this is what the slash commands need)", async () => {
    const home = await newHome();
    const root = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.9"));
    await placeShim(home);

    const res = await runShim(home, "pair", "wait", "--timeout", "60");
    expect(res.code).toBe(0);
    expect(await readFile(join(home, "ran.log"), "utf8"))
      .toContain(`pair @ ${root} ["wait","--timeout","60"]`);
  });

  test("NOMO ONLY: the payload reaches codex-notify with no chained program", async () => {
    const home = await newHome();
    const root = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.9"));
    await placeShim(home);
    const payload = JSON.stringify({ type: "agent-turn-complete", "turn-id": "t1" });

    const res = await runShim(home, "codex-notify", payload);
    expect(res.code).toBe(0);
    expect(res.stderr).toBe("");
    const log = await waitForLog(home, "codex-notify @");
    expect(log).toContain(`codex-notify @ ${root} ${JSON.stringify([payload])}`);
  });

  test("CHAINED: the wrapped previous notify still runs, with the payload in its final position", async () => {
    const home = await newHome();
    const root = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.9"));
    await placeShim(home);
    const prev = await installPrevNotify(home);
    const payload = JSON.stringify({ type: "agent-turn-complete" });

    const res = await runShim(home, "codex-notify", "--", prev, "turn-ended", payload);
    expect(res.code).toBe(0);
    expect(res.stderr).toBe("");
    // BOTH halves fire: nomo's backstop AND the program nomo is wrapping.
    const log = await waitForLog(home, "codex-notify @");
    expect(log).toContain(`prev turn-ended ${payload}`);
    expect(log).toContain(`codex-notify @ ${root} ${JSON.stringify([payload])}`);
  });

  test("a chained program that no longer exists is skipped silently (never a 127 in the session)", async () => {
    const home = await newHome();
    await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.9"));
    await placeShim(home);

    const res = await runShim(home, "codex-notify", "--", join(home, "uninstalled-notify"), "{}");
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
    expect(await waitForLog(home, "codex-notify @")).toContain("codex-notify @");
  });

  test("STALE-PROOF: notify still fires after the version dir it was wired under is deleted", async () => {
    // The whole point. A config.toml written under 1.7.7 names only the shim, so an update that
    // deletes 1.7.7 and installs 1.7.9 leaves the notify value correct and working.
    const home = await newHome();
    const old = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.7"));
    await runShell([join(old, "scripts/run.sh"), join(old, "dist/codex-status.mjs")], home);  // bootstrap
    const next = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.9"));
    await rm(old, { recursive: true, force: true });
    const prev = await installPrevNotify(home);

    const res = await runShim(home, "codex-notify", "--", prev, "{}");
    expect(res.code).toBe(0);
    const log = await waitForLog(home, "codex-notify @");
    expect(log).toContain(`codex-notify @ ${next}`);
    expect(log).toContain("prev {}");
  });
});

describe("run.sh shim upkeep", () => {
  test("a fresh install writes the shim 0700 and the stamp 0600, and the bundle still runs", async () => {
    const home = await newHome();
    const root = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.8"));
    const res = await runShell([join(root, "scripts/run.sh"), join(root, "dist/codex-status.mjs")], home);

    expect(res.stdout).toContain(`@ ${root}`);
    expect(await readStamp(home)).toBe(`${SHIM_REV} ${root}`);
    expect((await stat(join(home, ".config/cc-status/hook-shim.sh"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, ".config/cc-status/hook-shim.stamp"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".config/cc-status"))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(home, ".config/cc-status/hook-shim.sh"), "utf8"))
      .toBe(await readFile(SHIM_SH, "utf8"));
  });

  test("NO WRITE when nothing changed — the stamp's mtime survives repeated hooks", async () => {
    const home = await newHome();
    const root = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.8"));
    const invoke = () => runShell([join(root, "scripts/run.sh"), join(root, "dist/codex-status.mjs")], home);
    await invoke();
    const stampPath = join(home, ".config/cc-status/hook-shim.stamp");
    const before = (await stat(stampPath)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 5; i += 1) await invoke();
    expect((await stat(stampPath)).mtimeMs).toBe(before);
  });

  test("a repaired shim is reinstalled when it goes missing", async () => {
    const home = await newHome();
    const root = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.8"));
    const invoke = () => runShell([join(root, "scripts/run.sh"), join(root, "dist/codex-status.mjs")], home);
    await invoke();
    await rm(join(home, ".config/cc-status/hook-shim.sh"), { force: true });
    await invoke();
    expect((await stat(join(home, ".config/cc-status/hook-shim.sh"))).mode & 0o777).toBe(0o700);
  });

  test("NO PING-PONG: two installs of the same version leave the stamp alone", async () => {
    const home = await newHome();
    const claude = await installRoot(cachedRoot(home, ".claude", "acme", "nomo-cc", "1.7.8"));
    const codex = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.8"));
    await runShell([join(claude, "scripts/run.sh"), join(claude, "dist/cc-status.mjs")], home);
    const first = await readStamp(home);
    expect(first).toBe(`${SHIM_REV} ${claude}`);

    const stampPath = join(home, ".config/cc-status/hook-shim.stamp");
    const before = (await stat(stampPath)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 3; i += 1) {
      await runShell([join(codex, "scripts/run.sh"), join(codex, "dist/codex-status.mjs")], home);
      await runShell([join(claude, "scripts/run.sh"), join(claude, "dist/cc-status.mjs")], home);
    }
    expect(await readStamp(home)).toBe(first);
    expect((await stat(stampPath)).mtimeMs).toBe(before);
  });

  test("a strictly newer install takes the stamp over; an older one does not take it back", async () => {
    const home = await newHome();
    const older = await installRoot(cachedRoot(home, ".claude", "acme", "nomo-cc", "1.7.8"));
    const newer = await installRoot(cachedRoot(home, ".claude", "acme", "nomo-cc", "1.10.0"));
    await runShell([join(older, "scripts/run.sh"), join(older, "dist/cc-status.mjs")], home);
    expect(await readStamp(home)).toBe(`${SHIM_REV} ${older}`);

    await runShell([join(newer, "scripts/run.sh"), join(newer, "dist/cc-status.mjs")], home);
    expect(await readStamp(home)).toBe(`${SHIM_REV} ${newer}`);

    await runShell([join(older, "scripts/run.sh"), join(older, "dist/cc-status.mjs")], home);
    expect(await readStamp(home)).toBe(`${SHIM_REV} ${newer}`);
  });

  test("a recorded root that has been deleted is replaced by whoever is running now", async () => {
    const home = await newHome();
    const gone = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "9.9.9"));
    await runShell([join(gone, "scripts/run.sh"), join(gone, "dist/codex-status.mjs")], home);
    expect(await readStamp(home)).toBe(`${SHIM_REV} ${gone}`);
    await rm(gone, { recursive: true, force: true });

    // An OLDER install: normally it would defer, but there is nothing left to defer to.
    const survivor = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.0.0"));
    await runShell([join(survivor, "scripts/run.sh"), join(survivor, "dist/codex-status.mjs")], home);
    expect(await readStamp(home)).toBe(`${SHIM_REV} ${survivor}`);
  });

  test("an invocation that is not <root>/scripts/run.sh records nothing", async () => {
    const home = await newHome();
    const root = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.8"));
    // Copied out of the plugin layout entirely — $0 no longer identifies a plugin root.
    const loose = join(home, "loose-run.sh");
    await writeFile(loose, await readFile(RUN_SH, "utf8"));
    await chmod(loose, 0o755);

    const res = await runShell([loose, join(root, "dist/codex-status.mjs")], home);
    expect(res.stdout).toContain(`@ ${root}`);          // still resolves a runtime and runs
    await expect(readStamp(home)).rejects.toThrow();     // but records nothing
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("slash commands, Codex skills and OpenCode commands carry the shim fallback", () => {
  // ISSUE B, same bug class as the hooks: these address the plugin through ${CLAUDE_PLUGIN_ROOT} (the
  // Claude commands), a <ROOT> the agent substitutes (the Codex skills) or a __NOMO_ROOT__ the
  // installer bakes in (the OpenCode commands), and all three go stale the same way after a version
  // bump. They fail LOUDLY rather than silently, so they were never the outage the hooks were — but
  // "the plugin is gone" is not an acceptable answer to /nomo-cc:status either.
  // A LINT, not a behavior test: a command added next year must not be able to skip the fallback.
  const COMMANDS = join(PLUGIN_DIR, "commands");
  const SKILLS = join(PLUGIN_DIR, "codex-skills");
  const OPENCODE = join(PLUGIN_DIR, "opencode-commands");

  /** Every fenced block in a doc that actually LAUNCHES a bundle. Prose, `codex plugin list` and the
   *  user-facing `/nomo-cc:…` / `$nomo-…` invocations are deliberately not matched: they are things
   *  the reader runs, not paths we exec, and rewriting them would be nonsense. */
  async function launchBlocks(file: string): Promise<string[]> {
    const text = await readFile(file, "utf8");
    return [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
      .map((m) => m[1].trim())
      .filter((block) => block.includes("/dist/") || block.includes("hook-shim.sh"));
  }

  async function docs(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const name of await readdir(dir, { withFileTypes: true })) {
      if (name.isDirectory()) out.push(join(dir, name.name, "SKILL.md"));
      else if (name.name.endsWith(".md")) out.push(join(dir, name.name));
    }
    return out;
  }

  // `agent` is the argument the status launch block MUST pass so status-cmd knows who asked (see the
  // dedicated test at the bottom of this describe). It is per-host because the answer is per-host.
  for (const [label, dir, rootExpr, agent] of [
    ["commands", COMMANDS, '${CLAUDE_PLUGIN_ROOT}', "claude"],
    ["codex-skills", SKILLS, "<ROOT>", "codex"],
    ["opencode-commands", OPENCODE, "__NOMO_ROOT__", "opencode"],
  ] as const) {
    test(`${label}: every launch block prefers the live root, then falls back to the shim`, async () => {
      const files = await docs(dir);
      expect(files.length).toBeGreaterThan(0);
      let blocks = 0;
      for (const file of files) {
        for (const block of await launchBlocks(file)) {
          blocks += 1;
          const where = `${basename(dirname(file))}/${basename(file)}: ${block.slice(0, 60)}`;
          expect(where + block).toContain(rootExpr);
          // The emptiness guard exists because an UNSET env var would leave a bogus "/scripts/run.sh"
          // that passes -x on some boxes. OpenCode's root is a literal the installer substituted, so
          // it cannot be unset and there is nothing to guard.
          if (rootExpr.startsWith("$")) expect(where + block).toContain('[ -n "$NOMOR" ]');
          expect(where + block).toContain('[ -x "$NOMOR/scripts/run.sh" ]');
          expect(where + block).toContain("$HOME/.config/cc-status/hook-shim.sh");
          expect(where + block).toContain('[ -x "$NOMOS" ]');
          // Interactive, unlike a hook: silence would leave the user staring at a command that did
          // nothing, so the unresolvable case says so and exits non-zero.
          expect(where + block).toContain("exit 1");
        }
      }
      expect(blocks).toBeGreaterThanOrEqual(files.length);
    });

    test(`${label}: the fallback entry name matches the bundle, is whitelisted, and keeps its argv`, async () => {
      for (const file of await docs(dir)) {
        for (const block of await launchBlocks(file)) {
          const live = /dist\/([a-z-]+)\.mjs"([^;]*);/.exec(block);
          const fallback = /exec "\$NOMOS" ([a-z-]+)([^;]*);/.exec(block);
          const where = `${basename(file)}: `;
          expect(where + block).toContain('exec "$NOMOS"');
          expect(`${where}${live?.[1]}`).toBe(`${where}${fallback?.[1]}`);
          expect(ENTRIES).toContain(live![1]);
          // Sub-commands (`wait --timeout 60`, `--show-code`, `<on|off|status>`) must survive the
          // fallback too — the shim forwards them, so dropping them here would silently change what
          // the user's command does the day the live root goes stale.
          expect(`${where}args ${live?.[2]?.trim()}`).toBe(`${where}args ${fallback?.[2]?.trim()}`);
        }
      }
    });

    // THE POINT OF THE ARGUMENT. status-cmd cannot know which agent the user is sitting in, so it used
    // to print every agent's internals at everyone — a Claude Code user pressing status got four lines
    // of Codex. The launch block is the only place that knows, so it says so. BOTH halves must carry
    // it: the shim forwards argv verbatim, and dropping the agent on the fallback half would silently
    // restore the old everything-at-everyone output on exactly the machines the shim exists for.
    test(`${label}: the status launch block tells status-cmd that ${agent} is asking`, async () => {
      // Match below the docs dir, not the absolute path — a checkout under a directory whose
      // NAME contains "status" (this repo lives inside api-status/) would otherwise match every file.
      const file = (await docs(dir)).find((f) => f.slice(dir.length).includes("status"));
      expect(file).toBeDefined();
      const blocks = (await launchBlocks(file!)).filter((b) => b.includes("status-cmd"));
      expect(blocks.length).toBe(1);
      expect(blocks[0]).toContain(`dist/status-cmd.mjs" ${agent};`);
      expect(blocks[0]).toContain(`exec "$NOMOS" status-cmd ${agent};`);
    });
  }
});
