// Tests for plugin/scripts/grokbot-install.mjs — the hourly LaunchAgent for a Grok Bot-only Mac.
//
// Driven as a SUBPROCESS against a throwaway plugin root and HOME, like cursor-install.test.ts. The real
// ~/Library/LaunchAgents and the real launchd are never touched: HOME points into the temp dir and a fake
// `launchctl` first on PATH records every call and keeps a "loaded" flag file.

import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { createProcessHygiene, isolatedTestEnv } from "../test/process-hygiene";

const { spawnTestProcess } = createProcessHygiene();
const PLUGIN = join(import.meta.dir, "../../plugin");
const NOMO_AI = join(import.meta.dir, "../../bin/nomo-ai.mjs");
const LINUX = 'data:text/javascript,Object.defineProperty(process,"platform",{value:"linux"})';

const tmps: string[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Box { tmp: string; home: string; root: string; script: string; plist: string; log: string; bin: string }

async function box(name = "nomo"): Promise<Box> {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "nomo-grokbot-install-")));
  tmps.push(tmp);
  const root = join(tmp, name, "plugin");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await cp(join(PLUGIN, "scripts", "grokbot-install.mjs"), join(root, "scripts", "grokbot-install.mjs"));
  await writeFile(join(root, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(root, "dist", "cc-watchdog.mjs"), "// stub\n");
  const home = join(tmp, "home");
  const bin = join(tmp, "bin");
  const log = join(tmp, "launchctl.log");
  await mkdir(bin, { recursive: true });
  // print → 0 when loaded; bootstrap loads; bootout unloads (3 when there was nothing to unload).
  await writeFile(join(bin, "launchctl"), `#!/bin/sh
echo "$*" >> '${log}'
f='${join(tmp, "loaded")}'
case "$1" in
  print) [ -f "$f" ] && exit 0; exit 113 ;;
  bootstrap) [ -f "$2" ] || [ -f "$3" ] && : > "$f"; exit 0 ;;
  bootout) [ -f "$f" ] || exit 3; rm -f "$f"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  return {
    tmp, home, root, bin, log, script: join(root, "scripts", "grokbot-install.mjs"),
    plist: join(home, "Library", "LaunchAgents", "gg.nomo.activity.plist"),
  };
}

async function run(b: Box, args: string[] = [], pre: string[] = []): Promise<{ code: number; out: string }> {
  const proc = spawnTestProcess({
    cmd: [Bun.which("node")!, ...pre, b.script, ...args],
    cwd: b.tmp,
    env: isolatedTestEnv(b.home, { PATH: `${b.bin}:/usr/bin:/bin` }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: `${out}${err}` };
}

const calls = async (b: Box) => (existsSync(b.log) ? (await readFile(b.log, "utf8")).trim().split("\n") : []);

describe("grokbot-install.mjs", () => {
  test("install writes a valid per-user plist that starts the existing watchdog through run.sh, hourly", async () => {
    const b = await box();
    const r = await run(b);
    expect(r.code).toBe(0);
    const xml = await readFile(b.plist, "utf8");
    expect(xml).toContain("<string>gg.nomo.activity</string>");
    expect(xml).toContain(`<string>/bin/sh</string>\n\t\t<string>${b.root}/scripts/run.sh</string>\n\t\t<string>${b.root}/dist/cc-watchdog.mjs</string>\n\t\t<string>--scheduled</string>`);
    expect(xml).toContain("<key>StartInterval</key>\n\t<integer>3600</integer>");
    expect(xml).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(xml).toContain("<string>Background</string>");
    // No absolute runtime path baked in: run.sh resolves bun/node each run.
    expect(xml).not.toMatch(/\/(bun|node)<\/string>/);
    expect((await stat(b.plist)).mode & 0o777).toBe(0o644);
    if (existsSync("/usr/bin/plutil")) expect(spawnSync("/usr/bin/plutil", ["-lint", b.plist]).status).toBe(0);
    const uid = process.getuid!();
    expect(await calls(b)).toContain(`bootstrap gui/${uid} ${b.plist}`);
    // Next steps are the CLI commands, which work from any folder.
    expect(r.out).toContain("bunx nomo-ai pair");
    expect(r.out).toContain("bunx nomo-ai status");
  });

  test("a re-run with nothing changed does not reload the job (a running watchdog is left alone)", async () => {
    const b = await box();
    expect((await run(b)).code).toBe(0);
    const before = (await calls(b)).length;
    const r = await run(b);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already up to date");
    expect((await calls(b)).slice(before).every((c) => c.startsWith("print"))).toBe(true);
  });

  test("a path with XML-special characters is escaped, not broken", async () => {
    const b = await box("a&b<c");
    expect((await run(b)).code).toBe(0);
    const xml = await readFile(b.plist, "utf8");
    expect(xml).toContain("a&amp;b&lt;c/plugin/scripts/run.sh");
    if (existsSync("/usr/bin/plutil")) expect(spawnSync("/usr/bin/plutil", ["-lint", b.plist]).status).toBe(0);
  });

  test("uninstall unloads and deletes only the plist, and is idempotent", async () => {
    const b = await box();
    await run(b);
    const neighbour = join(b.home, "Library", "LaunchAgents", "com.example.other.plist");
    await writeFile(neighbour, "keep");
    const r = await run(b, ["--uninstall"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("unloaded and removed");
    expect(existsSync(b.plist)).toBe(false);
    expect(existsSync(neighbour)).toBe(true);
    expect(await calls(b)).toContain(`bootout gui/${process.getuid!()}/gg.nomo.activity`);
    const again = await run(b, ["--uninstall"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("not installed — nothing to remove");
  });

  test("not macOS: install refuses in one line and writes nothing; uninstall is a no-op", async () => {
    const b = await box();
    const r = await run(b, [], ["--import", LINUX]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("macOS only");
    expect(existsSync(b.plist)).toBe(false);
    expect(await calls(b)).toEqual([]);
    expect((await run(b, ["--uninstall"], ["--import", LINUX])).code).toBe(0);
  });

  test("a missing bundle is refused before anything is written", async () => {
    const b = await box();
    await rm(join(b.root, "dist", "cc-watchdog.mjs"));
    const r = await run(b);
    expect(r.code).toBe(1);
    expect(r.out).toContain("bun build.ts");
    expect(existsSync(b.plist)).toBe(false);
  });
});

describe("bunx nomo-ai --grokbot", () => {
  async function nomoAi(home: string, flags: string[], pre: string[] = []): Promise<{ code: number; out: string }> {
    const proc = spawnTestProcess({
      cmd: [Bun.which("node")!, ...pre, NOMO_AI, ...flags],
      cwd: home,
      env: isolatedTestEnv(home, { NO_COLOR: "1", PATH: "/usr/bin:/bin" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out: `${out}${err}` };
  }
  const home = async () => {
    const h = await realpath(await mkdtemp(join(tmpdir(), "nomo-ai-grokbot-")));
    tmps.push(h);
    return h;
  };

  test("detected from its data folder: -y plans the ~/.nomo checkout + grokbot-install.mjs", async () => {
    const h = await home();
    await mkdir(join(h, "Library", "Application Support", "Grok Bot"), { recursive: true });
    const r = await nomoAi(h, ["-y", "-n"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[*] Grok Bot");
    expect(r.out).toContain(`would run: git clone --depth 1 https://github.com/KarrixLee/nomo.git ${h}/.nomo`);
    expect(r.out).toContain(`${h}/.nomo/plugin/scripts/grokbot-install.mjs`);
    expect(r.out).toContain("ok (dry run)");
  });

  test("not macOS: the leg refuses with one clear line, nothing run", async () => {
    const h = await home();
    const r = await nomoAi(h, ["--grokbot", "-n"], ["--import", LINUX]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Grok Bot setup is macOS only");
    expect(r.out).not.toContain("would run");
  });

  test("--uninstall --grokbot runs ~/.nomo's grokbot-install.mjs --uninstall", async () => {
    const h = await home();
    const scripts = join(h, ".nomo", "plugin", "scripts");
    await mkdir(scripts, { recursive: true });
    const log = join(h, "argv.log");
    await writeFile(join(scripts, "grokbot-install.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" "));\n`);
    const r = await nomoAi(h, ["--uninstall", "--grokbot"]);
    expect(r.code).toBe(0);
    expect(await readFile(log, "utf8")).toBe("--uninstall");
  });

  test("--help names the leg and its uninstall", async () => {
    const r = await nomoAi(await home(), ["--help"]);
    expect(r.out).toContain("--grokbot");
    expect(r.out).toContain("bunx nomo-ai uninstall --grokbot");
  });
});
