// Tests for the bin/nomo-ai.mjs plan preview — specifically the CODEX GATE.
//
// THE REGRESSION THIS GUARDS. There is no `codex plugin update` verb at all, so what "update" means
// depends entirely on how the marketplace was added, which `~/.codex/config.toml` records as
// `source_type`. A "local" marketplace is read LIVE from its path — no snapshot, nothing for the user
// to run — and every marketplace Codex ships with is local, so an unconditional
// `codex plugin marketplace upgrade` line is wrong more often than it is right. A printed no-op costs
// somebody an afternoon; the line has to be gated.
//
// Driven as a SUBPROCESS against a throwaway HOME, because nomo-ai.mjs is a zero-dependency script
// with no exports (it runs main() on import) — the same reason hook-shim.test.ts drives the real shell
// scripts rather than reimplementing them. `--dry-run` guarantees nothing is installed or written.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createProcessHygiene, isolatedTestEnv } from "../test/process-hygiene";

const { spawnTestProcess } = createProcessHygiene();
const NOMO_AI = join(import.meta.dir, "../../bin/nomo-ai.mjs");

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

/** A machine with Nomo already installed for Codex, whose marketplace has this `source_type`.
 *  `undefined` writes no config.toml at all — the unreadable case. */
async function machine(sourceType: string | undefined): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "nomo-ai-"));
  homes.push(home);
  // The host's own plugin cache is how nomo-ai answers "already installed", and the directory under
  // cache/ is the MARKETPLACE NAME the update command has to quote.
  await mkdir(join(home, ".codex", "plugins", "cache", "acme-mp", "nomo"), { recursive: true });
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  if (sourceType !== undefined) {
    // A decoy section FIRST: the scan must not leak a neighbouring marketplace's source_type.
    await writeFile(
      join(home, ".codex", "config.toml"),
      `[marketplaces.openai-bundled]\nsource_type = "git"\nsource = "/x"\n\n` +
        `[marketplaces.acme-mp]\nlast_updated = "2026-08-17T12:55:41Z"\nsource_type = "${sourceType}"\nsource = "/somewhere"\n`,
    );
  }
  return home;
}

async function plan(home: string): Promise<string> {
  const proc = spawnTestProcess({
    cmd: ["node", NOMO_AI, "--dry-run", "--codex"],
    cwd: home,
    env: isolatedTestEnv(home, { NO_COLOR: "1" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return `${out}${err}`;
}

describe("the Codex row is gated on the marketplace's source_type", () => {
  test("git: the marketplace-upgrade command is printed, quoting the real marketplace name", async () => {
    const out = await plan(await machine("git"));
    expect(out).toContain("codex plugin marketplace upgrade acme-mp");
    // Not the install path — an installed agent must never be re-`marketplace add`ed, which would
    // repoint a source the user aimed somewhere else.
    expect(out).not.toContain("codex plugin marketplace add");
  });

  test("local: NO command at all — Codex reads it live, so anything printed would be a no-op", async () => {
    const out = await plan(await machine("local"));
    expect(out).toContain("already installed");
    expect(out).toContain("live from a local marketplace");
    expect(out).not.toContain("codex plugin marketplace upgrade");
    expect(out).not.toContain("codex plugin marketplace add");
  });

  test("no config.toml: says only what it knows, and borrows neither explanation", async () => {
    const out = await plan(await machine(undefined));
    expect(out).toContain("already installed");
    expect(out).not.toContain("codex plugin marketplace upgrade");
    expect(out).not.toContain("local marketplace");
  });

  test("not installed at all: the install commands are unchanged", async () => {
    const home = await mkdtemp(join(tmpdir(), "nomo-ai-"));
    homes.push(home);
    await mkdir(join(home, ".codex"), { recursive: true });
    const out = await plan(home);
    expect(out).toContain("codex plugin marketplace add KarrixLee/nomo");
    expect(out).toContain("codex plugin add nomo@nomo");
    expect(out).not.toContain("already installed");
  });
});

describe("runtime floor (CVE-2026-111497): a warning, never a block", () => {
  const withBun = async (version: string): Promise<string> => {
    const home = await machine("git");
    const bin = join(home, "fakebin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "bun"), `#!/bin/sh\necho ${version}\n`);
    await chmod(join(bin, "bun"), 0o755);
    const proc = spawnTestProcess({
      cmd: ["node", NOMO_AI, "--dry-run", "--codex"],
      cwd: home,
      env: isolatedTestEnv(home, { NO_COLOR: "1", PATH: `${bin}:${process.env.PATH}` }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0);
    return `${out}${err}`;
  };

  test("bun 1.4.3 on PATH: names the runtime, the version and `bun upgrade`, and still plans the install", async () => {
    const out = await withBun("1.4.3");
    expect(out).toContain("bun 1.4.3 is affected by CVE-2026-111497");
    expect(out).toContain("bun upgrade");
    expect(out).toContain("codex plugin");
  });

  test("bun 1.4.4: no warning", async () => {
    expect(await withBun("1.4.4")).not.toContain("CVE-2026-111497");
  });
});

describe("bunx nomo-ai --uninstall", () => {
  async function nomoAi(flags: string[], setup: (home: string) => Promise<void> = async () => {}): Promise<{ code: number; out: string }> {
    const home = await mkdtemp(join(tmpdir(), "nomo-ai-uninstall-"));
    homes.push(home);
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    for (const name of ["claude", "codex"]) await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await setup(home);
    const proc = spawnTestProcess({
      cmd: [Bun.which("node")!, NOMO_AI, ...flags],
      cwd: home,
      env: isolatedTestEnv(home, { NO_COLOR: "1", PATH: `${bin}:/usr/bin:/bin` }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out: `${out}${err}` };
  }

  test("--help lists the uninstall lines", async () => {
    const help = await nomoAi(["--help"]);
    expect(help.out).toContain("bunx nomo-ai uninstall --cursor");
    expect(help.out).toContain("bunx nomo-ai uninstall --antigravity");
    expect(help.out).toContain("claude plugin uninstall nomo-cc@nomo");
  });

  test("--uninstall needs an agent flag: no picker, nothing run", async () => {
    const r = await nomoAi(["--uninstall"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--uninstall needs to know which agent");
    expect((await nomoAi(["--uninstall", "-y"])).code).toBe(2);
  });

  test("--uninstall --antigravity runs ~/.nomo's antigravity-install.mjs --uninstall; -y is accepted", async () => {
    let log = "";
    const r = await nomoAi(["--uninstall", "--antigravity", "-y"], async (home) => {
      const scripts = join(home, ".nomo", "plugin", "scripts");
      await mkdir(scripts, { recursive: true });
      log = join(home, "argv.log");
      await writeFile(join(scripts, "antigravity-install.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" "));\n`);
    });
    expect(r.code).toBe(0);
    expect(await readFile(log, "utf8")).toBe("--uninstall");
    expect(r.out).not.toContain("claude plugin");
  });

  test("--uninstall with no ~/.nomo checkout fails loudly and names the long form", async () => {
    const r = await nomoAi(["--uninstall", "--cursor"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("cursor-install.mjs --uninstall");
  });

  test("--uninstall for a host-owned install prints the host's command and runs nothing", async () => {
    const r = await nomoAi(["--uninstall", "--claude", "--codex", "--opencode"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("claude plugin uninstall nomo-cc@nomo");
    expect(r.out).toContain("codex plugin remove nomo@nomo");
    expect(r.out).toContain("~/.config/opencode/plugins/nomo.js");
    expect(r.out).not.toContain("$ claude");
  });
});

describe("commands: pair / status / reset / uninstall", () => {
  async function cli(home: string, args: string[], bin = NOMO_AI): Promise<{ code: number; out: string }> {
    const proc = spawnTestProcess({
      cmd: [Bun.which("node")!, bin, ...args],
      cwd: home,
      env: isolatedTestEnv(home, { NO_COLOR: "1", PATH: "/usr/bin:/bin" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out: `${out}${err}` };
  }
  const home = async () => {
    const h = await mkdtemp(join(tmpdir(), "nomo-ai-cmd-"));
    homes.push(h);
    return h;
  };
  /** A fake installed plugin at `root`: run.sh logs "<entry> <args>" and exits with $EXIT (default 0). */
  const plugin = async (root: string, log: string, exit = 0) => {
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    for (const e of ["pair", "reset", "status-cmd"]) await writeFile(join(root, "dist", `${e}.mjs`), "");
    await writeFile(join(root, "scripts", "run.sh"), `#!/bin/sh\ne=$(basename "$1" .mjs); shift\necho "$e $*" >> '${log}'\necho "from-${"$"}e"\nexit ${exit}\n`, { mode: 0o755 });
  };

  test("nothing installed: one plain line naming `bunx nomo-ai`, non-zero exit", async () => {
    for (const c of ["pair", "status", "reset"]) {
      const r = await cli(await home(), [c]);
      expect(r.code).toBe(1);
      expect(r.out.trim()).toBe("nomo-ai: Nomo is not installed on this computer yet — run `bunx nomo-ai` first.");
    }
  });

  test("runs the ~/.nomo copy's entry; stdout, args and exit code pass through", async () => {
    const h = await home();
    const log = join(h, "calls.log");
    await plugin(join(h, ".nomo", "plugin"), log, 3);
    const r = await cli(h, ["status", "--plain", "claude"]);
    expect(r.code).toBe(3);
    expect(r.out).toBe("from-status-cmd\n");
    expect(await readFile(log, "utf8")).toBe("status-cmd --plain claude\n");
  });

  test("pair = start then wait; `pair code` is the typeable-code form; a failed start does not wait", async () => {
    const h = await home();
    const log = join(h, "calls.log");
    await plugin(join(h, ".nomo", "plugin"), log);
    expect((await cli(h, ["pair"])).code).toBe(0);
    expect((await cli(h, ["pair", "code"])).code).toBe(0);
    expect(await readFile(log, "utf8")).toBe("pair \npair wait\npair --show-code\npair wait\n");
    const h2 = await home();
    const log2 = join(h2, "calls.log");
    await plugin(join(h2, ".nomo", "plugin"), log2, 1);
    expect((await cli(h2, ["pair"])).code).toBe(1);
    expect(await readFile(log2, "utf8")).toBe("pair \n");
  });

  test("the copy hooks last ran (the shim stamp) wins over ~/.nomo", async () => {
    const h = await home();
    const log = join(h, "calls.log");
    await plugin(join(h, ".nomo", "plugin"), join(h, "nomo.log"));
    const stamped = join(h, "cache copy", "2.4.2");
    await plugin(stamped, log);
    await mkdir(join(h, ".config", "cc-status"), { recursive: true });
    await writeFile(join(h, ".config", "cc-status", "hook-shim.stamp"), `4 ${stamped}\n`);
    expect((await cli(h, ["reset"])).code).toBe(0);
    expect(await readFile(log, "utf8")).toBe("reset \n");
  });

  test("an unknown word fails clearly and installs nothing; `<cmd> --help` prints help, runs nothing", async () => {
    const h = await home();
    const r = await cli(h, ["instal", "--claude"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("unknown command: instal");
    expect(r.out).not.toContain("$ claude");
    expect(r.out).not.toContain("Nomo plugin installer"); // the install banner never printed
    const log = join(h, "calls.log");
    await plugin(join(h, ".nomo", "plugin"), log);
    const help = await cli(h, ["pair", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("Commands");
    await expect(readFile(log, "utf8")).rejects.toThrow();
  });

  test("`uninstall` is the --uninstall flag: same agent-required rule, same removal", async () => {
    const h = await home();
    expect((await cli(h, ["uninstall"])).code).toBe(2);
    const r = await cli(h, ["uninstall", "--claude"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("claude plugin uninstall nomo-cc@nomo");
  });

  test("help names the command after how it was run: `nomo` (global short bin) or `bunx nomo-ai`", async () => {
    const h = await home();
    const { symlink } = await import("node:fs/promises");
    await symlink(NOMO_AI, join(h, "nomo"));
    const short = await cli(h, ["--help"], join(h, "nomo"));
    expect(short.out).toContain("  nomo pair");
    expect(short.out).not.toContain("bunx nomo-ai pair");
    const long = await cli(h, ["--help"]);
    expect(long.out).toContain("  bunx nomo-ai pair");
    // never point anyone at the `nomo` npm package (not ours)
    for (const o of [short.out, long.out]) expect(o).not.toMatch(/(bunx|npx) nomo (pair|status|reset|uninstall)/);
  });
});


describe("the optional short `nomo` command", () => {
  /** A machine where the Claude leg succeeds (fake `claude`) and `npm` is a fake that logs its argv.
   *  npm modes: ok = links <home>/gbin/nomo → this package's bin; fail = exits 1; offpath = exits 0 but
   *  its bin folder is not on PATH. `foreign` puts some other program called `nomo` on PATH. */
  async function box(npm: "ok" | "fail" | "offpath", opts: { foreign?: boolean } = {}) {
    const h = await mkdtemp(join(tmpdir(), "nomo-ai-short-"));
    homes.push(h);
    const bin = join(h, "bin");
    const gbin = join(h, "gbin");
    await mkdir(bin, { recursive: true });
    await mkdir(gbin, { recursive: true });
    await writeFile(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const log = join(h, "npm.log");
    const install = npm === "ok" ? `ln -s '${NOMO_AI}' '${gbin}/nomo'; exit 0` : npm === "fail" ? "exit 1" : "exit 0";
    await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$*" >> '${log}'\ncase "$1" in\n  prefix) echo '${h}/elsewhere'; exit 0 ;;\n  install) ${install} ;;\nesac\nexit 0\n`, { mode: 0o755 });
    if (opts.foreign) await writeFile(join(bin, "nomo"), "#!/bin/sh\necho not ours\n", { mode: 0o755 });
    return { h, log, path: `${bin}:${gbin}:/usr/bin:/bin` };
  }
  async function cli(b: { h: string; path: string }, flags: string[], ask: boolean, answer = "") {
    const proc = spawnTestProcess({
      cmd: [Bun.which("node")!, NOMO_AI, ...flags],
      cwd: b.h,
      env: isolatedTestEnv(b.h, { NO_COLOR: "1", PATH: b.path, npm_config_user_agent: "", NOMO_AI_TEST_ASK: ask ? "1" : undefined }),
      stdin: new Blob([answer]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out: `${out}${err}` };
  }
  const npmCalls = async (log: string) => (await readFile(log, "utf8").catch(() => "")).trim();
  const Q = "Also install the short nomo command, so you can type nomo pair? (y/N)";

  test("no terminal: never asked, never installed; hints keep `bunx nomo-ai`", async () => {
    const b = await box("ok");
    const r = await cli(b, ["--claude"], false);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(Q);
    expect(await npmCalls(b.log)).toBe("");
    expect(r.out).toContain("`bunx nomo-ai pair` from any folder");
  });

  test("asked in a terminal; Enter (default No) installs nothing", async () => {
    const b = await box("ok");
    const r = await cli(b, ["--claude"], true, "\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain(Q);
    expect(await npmCalls(b.log)).toBe("");
    expect(r.out).toContain("`bunx nomo-ai pair` from any folder");
  });

  test("--yes never asks", async () => {
    const b = await box("ok");
    const r = await cli(b, ["--claude", "-y"], true, "y\n");
    expect(r.out).not.toContain(Q);
    expect(await npmCalls(b.log)).toBe("");
  });

  test("yes: shows and runs `npm install -g nomo-ai`, confirms it is ours, hints switch to `nomo`", async () => {
    const b = await box("ok");
    const r = await cli(b, ["--claude"], true, "y\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("$ npm install -g nomo-ai");
    expect(await npmCalls(b.log)).toBe("install -g nomo-ai");
    expect(r.out).toContain("`nomo pair` from any folder");
  });

  test("a failed install is one line with the hand command, and the exit status stays 0", async () => {
    const b = await box("fail");
    const r = await cli(b, ["--claude"], true, "y\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Could not install it (nothing else changed). To try by hand: npm install -g nomo-ai");
    expect(r.out).toContain("`bunx nomo-ai pair` from any folder");
  });

  test("installed but its bin folder is not on PATH: says which folder, keeps `bunx nomo-ai`", async () => {
    const b = await box("offpath");
    const r = await cli(b, ["--claude"], true, "y\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Installed, but ${b.h}/elsewhere/bin is not on your PATH`);
    expect(r.out).toContain("`bunx nomo-ai pair` from any folder");
  });

  test("another program called `nomo` on PATH: not asked, not run, one line, `bunx nomo-ai` kept", async () => {
    const b = await box("ok", { foreign: true });
    const r = await cli(b, ["--claude"], true, "y\n");
    expect(r.out).toContain("Another program called `nomo` is already on your PATH");
    expect(r.out).not.toContain(Q);
    expect(r.out).not.toContain("not ours"); // never executed
    expect(await npmCalls(b.log)).toBe("");
  });

  test("ours already on PATH: no question, hints use `nomo`", async () => {
    const b = await box("ok");
    const { symlink } = await import("node:fs/promises");
    await symlink(NOMO_AI, join(b.h, "gbin", "nomo"));
    const r = await cli(b, ["--claude"], true, "y\n");
    expect(r.out).not.toContain(Q);
    expect(await npmCalls(b.log)).toBe("");
    expect(r.out).toContain("`nomo pair` from any folder");
  });

  test("--global installs without asking; with -n it only shows the plan", async () => {
    const b = await box("ok");
    const dry = await cli(b, ["--claude", "--global", "-n"], false);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would run: npm install -g nomo-ai");
    expect(await npmCalls(b.log)).toBe("");
    const r = await cli(b, ["--claude", "--global"], false);
    expect(r.out).not.toContain(Q);
    expect(await npmCalls(b.log)).toBe("install -g nomo-ai");
  });

  test("uninstall leaves the short command and names how to remove it", async () => {
    const b = await box("ok");
    const { symlink } = await import("node:fs/promises");
    await symlink(NOMO_AI, join(b.h, "gbin", "nomo"));
    const r = await cli(b, ["uninstall", "--claude"], false);
    expect(r.code).toBe(0);
    expect(r.out).toContain("The short `nomo` command stays. To remove it too: npm uninstall -g nomo-ai");
    expect(await npmCalls(b.log)).toBe("");
  });
});
