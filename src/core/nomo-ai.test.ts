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

describe("bunx nomo-ai --devin", () => {
  async function nomoAi(flags: string[], setup: (home: string, bin: string) => Promise<void> = async () => {}): Promise<{ code: number; out: string }> {
    const home = await mkdtemp(join(tmpdir(), "nomo-ai-devin-"));
    homes.push(home);
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    for (const name of ["claude", "codex"]) await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await setup(home, bin);
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

  test("--devin is a known flag and appears in --help with its uninstall line", async () => {
    const help = await nomoAi(["--help"]);
    expect(help.out).toContain("--devin");
    expect(help.out).toContain("bunx nomo-ai --uninstall --devin");
    const r = await nomoAi(["--dry-run", "--devin"]);
    expect(r.out).not.toContain("unknown");
    expect(r.code).toBe(0);
  });

  test("--dry-run plan names the clone + devin-install.mjs, and the pair command for Devin-only users", async () => {
    const r = await nomoAi(["--dry-run", "--devin"]);
    expect(r.out).toContain("git clone --depth 1 https://github.com/KarrixLee/nomo.git");
    expect(r.out).toContain(".nomo/plugin/scripts/devin-install.mjs");
    expect(r.out).not.toContain("claude plugin");
  });

  test("detect: devin on PATH or ~/.config/devin exists; skipped under --all when undetected", async () => {
    const none = await nomoAi(["--dry-run", "--all"]);
    expect(none.out).toContain("Devin was not found on this machine — skipped");
    expect(none.out).not.toContain("devin-install.mjs");
    expect(none.code).toBe(0);
    const onPath = await nomoAi(["--dry-run", "--all"], async (_h, bin) => { await writeFile(join(bin, "devin"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); });
    expect(onPath.out).toContain("devin-install.mjs");
    const dir = await nomoAi(["--dry-run", "--all"], async (home) => { await mkdir(join(home, ".config", "devin"), { recursive: true }); });
    expect(dir.out).toContain("devin-install.mjs");
  });

  test("installed() reads the devin-status.mjs marker from ~/.config/devin/config.json", async () => {
    const r = await nomoAi(["--dry-run", "--devin"], async (home) => {
      await mkdir(join(home, ".config", "devin"), { recursive: true });
      await writeFile(join(home, ".config", "devin", "config.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "'/r/scripts/run.sh' '/r/dist/devin-status.mjs'" }] }] } }));
    });
    expect(r.out).toContain("already installed");
    expect(r.out).toContain("config.json");
  });

  test("--uninstall needs an agent flag: no picker, nothing run", async () => {
    const r = await nomoAi(["--uninstall"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--uninstall needs to know which agent");
    expect((await nomoAi(["--uninstall", "-y"])).code).toBe(2);
  });

  test("--uninstall --devin runs ~/.nomo's devin-install.mjs --uninstall; -y is accepted", async () => {
    let log = "";
    const r = await nomoAi(["--uninstall", "--devin", "-y"], async (home) => {
      const scripts = join(home, ".nomo", "plugin", "scripts");
      await mkdir(scripts, { recursive: true });
      log = join(home, "argv.log");
      await writeFile(join(scripts, "devin-install.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" "));\n`);
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
    const r = await nomoAi(["--uninstall", "--claude", "--codex"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("claude plugin uninstall nomo-cc@nomo");
    expect(r.out).toContain("codex plugin remove nomo@nomo");
    expect(r.out).not.toContain("$ claude");
  });

  test("--ref note lists Devin among the pinned agents", async () => {
    const r = await nomoAi(["--dry-run", "--devin", "--ref", "dev"]);
    expect(r.out).toContain("(OpenCode, Cursor, Antigravity, Devin) only");
    expect(r.out).not.toContain("None of them is selected");
  });
});
