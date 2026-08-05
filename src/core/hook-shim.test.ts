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

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  "codex-notify", "pair", "unpair", "reset", "status-cmd",
];

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
    await writeFile(join(root, "dist", `${entry}.mjs`), `console.log("ran ${entry} @ ${root}");\n`);
  }
  return root;
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

/** Invoke the installed shim exactly the way a hook command does. */
const runShim = (home: string, entry: string): Promise<ShellResult> =>
  runShell([join(home, ".config/cc-status/hook-shim.sh"), entry], home);

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
    await writeFile(join(home, ".config/cc-status/hook-shim.stamp"), `1 ${join(home, "gone")}\n`);

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

describe("run.sh shim upkeep", () => {
  test("a fresh install writes the shim 0700 and the stamp 0600, and the bundle still runs", async () => {
    const home = await newHome();
    const root = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.7.8"));
    const res = await runShell([join(root, "scripts/run.sh"), join(root, "dist/codex-status.mjs")], home);

    expect(res.stdout).toContain(`@ ${root}`);
    expect(await readStamp(home)).toBe(`1 ${root}`);
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
    expect(first).toBe(`1 ${claude}`);

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
    expect(await readStamp(home)).toBe(`1 ${older}`);

    await runShell([join(newer, "scripts/run.sh"), join(newer, "dist/cc-status.mjs")], home);
    expect(await readStamp(home)).toBe(`1 ${newer}`);

    await runShell([join(older, "scripts/run.sh"), join(older, "dist/cc-status.mjs")], home);
    expect(await readStamp(home)).toBe(`1 ${newer}`);
  });

  test("a recorded root that has been deleted is replaced by whoever is running now", async () => {
    const home = await newHome();
    const gone = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "9.9.9"));
    await runShell([join(gone, "scripts/run.sh"), join(gone, "dist/codex-status.mjs")], home);
    expect(await readStamp(home)).toBe(`1 ${gone}`);
    await rm(gone, { recursive: true, force: true });

    // An OLDER install: normally it would defer, but there is nothing left to defer to.
    const survivor = await installRoot(cachedRoot(home, ".codex", "acme", "nomo", "1.0.0"));
    await runShell([join(survivor, "scripts/run.sh"), join(survivor, "dist/codex-status.mjs")], home);
    expect(await readStamp(home)).toBe(`1 ${survivor}`);
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
