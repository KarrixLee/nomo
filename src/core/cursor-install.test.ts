// Tests for plugin/scripts/cursor-install.mjs — the merge into Cursor's user-level hooks.json.
//
// THE PROPERTY UNDER TEST: that file belongs to the user and to other tools (herdr registers its own
// sessionStart entry there). Install and uninstall may add and remove NOMO's entries and nothing else.
//
// Driven as a SUBPROCESS against a throwaway plugin root + CURSOR_CONFIG_DIR, like nomo-ai.test.ts:
// the script is a zero-dependency .mjs that runs on import, and what matters is what lands on disk.
// The real ~/.cursor is never read or written — CURSOR_CONFIG_DIR and HOME both point into the temp dir.

import { chmod, cp, link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createProcessHygiene, isolatedTestEnv } from "../test/process-hygiene";

const { spawnTestProcess } = createProcessHygiene();
const PLUGIN = join(import.meta.dir, "../../plugin");
const NOMO_AI = join(import.meta.dir, "../../bin/nomo-ai.mjs");

/** The events the installer registers — spelled out here on purpose, so dropping or adding one is a
 *  deliberate, reviewed change (a permission-class event must never appear in this list). */
const EVENTS = [
  "sessionStart", "beforeSubmitPrompt", "postToolUse", "postToolUseFailure",
  "afterShellExecution", "afterFileEdit", "stop", "sessionEnd",
];
const SKILLS = ["nomo-pair", "nomo-reset", "nomo-status", "nomo-unpair"];

/** What another tool left in hooks.json: its own entry on an event we also use, an entry with extra
 *  keys on another, an event we never touch, an empty array, and a top-level key we know nothing about. */
const FOREIGN = {
  version: 1,
  hooks: {
    sessionStart: [{ command: "bash '/Users/x/.cursor/herdr-agent-state.sh' session" }],
    afterFileEdit: [{ command: "./format.sh", matcher: "*.ts", timeout: 3 }],
    beforeShellExecution: [{ command: "./audit.sh", failClosed: true }],
    preCompact: [],
  },
  someOtherTool: { keep: "me" },
};

const tmps: string[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Box { root: string; cursor: string; hooks: string; home: string; script: string; tmp: string }

/** A throwaway nomo plugin root (the real script + the real skills, a stub bundle) and an empty
 *  Cursor config dir. `name` lets one test build two differently-pathed checkouts. */
async function box(name = "nomo"): Promise<Box> {
  // realpath: node resolves the script's own path through symlinks (macOS /var → /private/var), and
  // that resolved path is what the installer writes.
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "nomo-cursor-install-")));
  tmps.push(tmp);
  const cursor = join(tmp, "cursor-config");
  await mkdir(cursor, { recursive: true });
  return { tmp, cursor, hooks: join(cursor, "hooks.json"), home: join(tmp, "home"), ...(await checkout(tmp, name)) };
}

async function checkout(tmp: string, name: string): Promise<{ root: string; script: string }> {
  const root = join(tmp, name, "plugin");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await cp(join(PLUGIN, "scripts", "cursor-install.mjs"), join(root, "scripts", "cursor-install.mjs"));
  await cp(join(PLUGIN, "cursor-skills"), join(root, "cursor-skills"), { recursive: true });
  await writeFile(join(root, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(root, "dist", "cursor-status.mjs"), "// stub\n");
  return { root, script: join(root, "scripts", "cursor-install.mjs") };
}

async function run(
  b: Box, args: string[] = [], script = b.script, env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  const proc = spawnTestProcess({
    cmd: ["node", script, ...args],
    cwd: b.tmp,
    env: isolatedTestEnv(b.home, { CURSOR_CONFIG_DIR: b.cursor, ...env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: `${out}${err}` };
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const ours = (root: string) => `'${root}/scripts/run.sh' '${root}/dist/cursor-status.mjs'`;
const skillsIn = async (b: Box) => (await readdir(join(b.cursor, "skills")).catch(() => [])).sort();

describe("install into a hooks.json another tool already uses", () => {
  test("foreign entries survive install, re-install and uninstall untouched", async () => {
    const b = await box();
    const original = `${JSON.stringify(FOREIGN, null, 2)}\n`;
    await writeFile(b.hooks, original);

    expect((await run(b)).code).toBe(0);
    const doc = await readJson(b.hooks);
    // Ours: one entry per event, exact command, short timeout — appended AFTER what was there.
    for (const event of EVENTS) {
      const mine = doc.hooks[event].filter((e: { command: string }) => e.command === ours(b.root));
      expect(mine).toEqual([{ command: ours(b.root), timeout: 10 }]);
    }
    expect(doc.hooks.sessionStart).toEqual([...FOREIGN.hooks.sessionStart, { command: ours(b.root), timeout: 10 }]);
    expect(doc.hooks.afterFileEdit[0]).toEqual(FOREIGN.hooks.afterFileEdit[0]);
    // …and not merely equal as data: every foreign entry keeps its own key order (compared as TEXT),
    // every foreign event keeps its position, and so do the top-level keys.
    for (const [event, entries] of Object.entries(FOREIGN.hooks)) {
      expect(JSON.stringify(doc.hooks[event].slice(0, entries.length))).toBe(JSON.stringify(entries));
    }
    expect(Object.keys(doc.hooks).slice(0, 4)).toEqual(Object.keys(FOREIGN.hooks));
    expect(Object.keys(doc)).toEqual(Object.keys(FOREIGN));
    const text = await readFile(b.hooks, "utf8");
    for (const entries of Object.values(FOREIGN.hooks)) {
      for (const entry of entries) {
        // The entry's exact bytes as a 2-space document holds them (6 = hooks → event → entry).
        expect(text).toContain(JSON.stringify(entry, null, 2).replace(/\n/g, "\n      "));
      }
    }
    // Theirs: every key we do not own is exactly as it was.
    expect(doc.hooks.beforeShellExecution).toEqual(FOREIGN.hooks.beforeShellExecution);
    expect(doc.hooks.preCompact).toEqual([]);
    expect(doc.someOtherTool).toEqual(FOREIGN.someOtherTool);
    expect(doc.version).toBe(1);
    // Never a permission-class event of our own.
    for (const gate of ["preToolUse", "beforeMCPExecution", "beforeReadFile", "subagentStart"]) {
      expect(doc.hooks[gate]).toBeUndefined();
    }

    // Idempotent: a second install changes not one byte.
    const installed = await readFile(b.hooks, "utf8");
    const again = await run(b);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already up to date");
    expect(await readFile(b.hooks, "utf8")).toBe(installed);

    // Uninstall: back to exactly the foreign document, then a second uninstall is a no-op.
    expect((await run(b, ["--uninstall"])).code).toBe(0);
    expect(await readJson(b.hooks)).toEqual(FOREIGN);
    // The original was a 2-space document, so the round trip is exact to the BYTE.
    expect(await readFile(b.hooks, "utf8")).toBe(original);
    const before = await readFile(b.hooks, "utf8");
    const noop = await run(b, ["--uninstall"]);
    expect(noop.out).toContain("no Nomo entries found");
    expect(await readFile(b.hooks, "utf8")).toBe(before);
  });

  test("no hooks.json: one is created with version 1; uninstall leaves an empty hooks object", async () => {
    const b = await box();
    expect((await run(b)).code).toBe(0);
    const doc = await readJson(b.hooks);
    expect(doc.version).toBe(1);
    expect(Object.keys(doc.hooks).sort()).toEqual([...EVENTS].sort());
    await run(b, ["--uninstall"]);
    expect(await readJson(b.hooks)).toEqual({ version: 1, hooks: {} });
  });

  test("version is added only when missing, never rewritten", async () => {
    const missing = await box();
    await writeFile(missing.hooks, JSON.stringify({ hooks: {} }));
    await run(missing);
    expect((await readJson(missing.hooks)).version).toBe(1);

    const other = await box();
    await writeFile(other.hooks, JSON.stringify({ version: 2, hooks: {} }));
    await run(other);
    expect((await readJson(other.hooks)).version).toBe(2);
  });

  test("a symlinked hooks.json is written through, not replaced", async () => {
    const b = await box();
    const real = join(b.tmp, "dotfiles-hooks.json");
    await writeFile(real, JSON.stringify(FOREIGN));
    await symlink(real, b.hooks);
    expect((await run(b)).code).toBe(0);
    expect((await lstat(b.hooks)).isSymbolicLink()).toBe(true);
    expect((await readJson(real)).hooks.stop).toEqual([{ command: ours(b.root), timeout: 10 }]);
  });

  test("the file's mode is preserved (a 0600 hooks.json stays 0600)", async () => {
    const b = await box();
    await writeFile(b.hooks, JSON.stringify(FOREIGN), { mode: 0o600 });
    await chmod(b.hooks, 0o600);
    expect((await run(b)).code).toBe(0);
    expect((await stat(b.hooks)).mode & 0o777).toBe(0o600);
    expect((await readJson(b.hooks)).hooks.stop).toEqual([{ command: ours(b.root), timeout: 10 }]);
    expect((await run(b, ["--uninstall"])).code).toBe(0);
    expect((await stat(b.hooks)).mode & 0o777).toBe(0o600);
  });

  test("look-alike entries are not ours: they survive install AND uninstall, in place", async () => {
    const b = await box();
    const lookalikes = {
      // Our bundle name, but the two paths do not share a root — not a command we could have written.
      stop: [{ command: "'/a/scripts/run.sh' '/b/dist/cursor-status.mjs'", timeout: 10 }],
      // Our exact shape, but somebody added keys of their own to it.
      postToolUse: [{ command: ours("/elsewhere/plugin"), timeout: 10, matcher: "Shell", failClosed: true }],
      // Our exact shape on an event we never register.
      preCompact: [{ command: ours("/elsewhere/plugin"), timeout: 10 }],
      // The genuine article from another checkout: THIS one is replaced.
      sessionEnd: [{ command: ours("/old/plugin"), timeout: 10 }, { command: "./theirs.sh" }],
    };
    await writeFile(b.hooks, JSON.stringify({ version: 1, hooks: lookalikes }));
    expect((await run(b)).code).toBe(0);
    let doc = await readJson(b.hooks);
    expect(doc.hooks.stop).toEqual([...lookalikes.stop, { command: ours(b.root), timeout: 10 }]);
    expect(doc.hooks.postToolUse).toEqual([...lookalikes.postToolUse, { command: ours(b.root), timeout: 10 }]);
    expect(doc.hooks.preCompact).toEqual(lookalikes.preCompact);
    expect(doc.hooks.sessionEnd).toEqual([{ command: "./theirs.sh" }, { command: ours(b.root), timeout: 10 }]);
    expect(Object.keys(doc.hooks).slice(0, 4)).toEqual(Object.keys(lookalikes)); // nothing re-ordered

    expect((await run(b, ["--uninstall"])).code).toBe(0);
    doc = await readJson(b.hooks);
    expect(doc.hooks).toEqual({
      stop: lookalikes.stop, postToolUse: lookalikes.postToolUse, preCompact: lookalikes.preCompact,
      sessionEnd: [{ command: "./theirs.sh" }],
    });
  });

  test("uninstall drops an event only when removing OUR entry emptied it — an empty array it found stays", async () => {
    const b = await box();
    const text = JSON.stringify({ version: 1, hooks: { stop: [], preCompact: [], sessionEnd: [{ command: ours("/gone/plugin"), timeout: 10 }] } });
    await writeFile(b.hooks, text);
    expect((await run(b, ["--uninstall"])).code).toBe(0);
    expect(await readJson(b.hooks)).toEqual({ version: 1, hooks: { stop: [], preCompact: [] } });
  });

  test("another tool's write between our read and our rename is merged, not overwritten", async () => {
    const b = await box();
    await writeFile(b.hooks, JSON.stringify(FOREIGN));
    // The installer holds still (test seam) after preparing its temp file; that file is our cue.
    const pending = run(b, [], b.script, { NOMO_CURSOR_INSTALL_TEST_PAUSE_MS: "1500" });
    const deadline = Date.now() + 10_000;
    while (!(await readdir(b.cursor)).some((n) => n.endsWith(".tmp"))) {
      if (Date.now() > deadline) throw new Error("the installer never reached its write");
      await new Promise((r) => setTimeout(r, 10));
    }
    const theirs = { ...FOREIGN, hooks: { ...FOREIGN.hooks, stop: [{ command: "./landed-in-the-gap.sh" }] } };
    await writeFile(b.hooks, JSON.stringify(theirs));
    expect((await pending).code).toBe(0);
    const doc = await readJson(b.hooks);
    expect(doc.hooks.stop).toEqual([{ command: "./landed-in-the-gap.sh" }, { command: ours(b.root), timeout: 10 }]);
    expect(doc.hooks.sessionStart).toEqual([...FOREIGN.hooks.sessionStart, { command: ours(b.root), timeout: 10 }]);
    expect((await readdir(b.cursor)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  }, 20_000);

  test("a re-install from a moved checkout replaces its old entries instead of doubling them", async () => {
    const b = await box("old-place");
    await run(b);
    const moved = await checkout(b.tmp, "new-place");
    expect((await run(b, [], moved.script)).code).toBe(0);
    const doc = await readJson(b.hooks);
    for (const event of EVENTS) expect(doc.hooks[event]).toEqual([{ command: ours(moved.root), timeout: 10 }]);
    expect(await readFile(join(b.cursor, "skills", "nomo-pair", "SKILL.md"), "utf8")).toContain(moved.root);
  });
});

describe("refusals change nothing", () => {
  const cases: [string, string][] = [
    ["invalid JSON", "{ \"version\": 1, \"hooks\": { // a comment\n"],
    ["a non-object document", "[]"],
    ["a non-object hooks", JSON.stringify({ version: 1, hooks: [] })],
    ["a non-array event", JSON.stringify({ version: 1, hooks: { stop: { command: "x" } } })],
  ];
  for (const [what, text] of cases) {
    test(`${what}: exit 1, file untouched, no skills written`, async () => {
      const b = await box();
      await writeFile(b.hooks, text);
      const r = await run(b);
      expect(r.code).toBe(1);
      expect(r.out).toContain("nothing was changed");
      expect(await readFile(b.hooks, "utf8")).toBe(text);
      expect(await skillsIn(b)).toEqual([]);
      expect((await readdir(b.cursor)).sort()).toEqual(["hooks.json"]); // no temp file left behind
      // Uninstall refuses the same way rather than "cleaning" a file it cannot read.
      expect((await run(b, ["--uninstall"])).code).toBe(1);
      expect(await readFile(b.hooks, "utf8")).toBe(text);
    });
  }

  test("a same-named skill we did not write: refused before hooks.json is touched; --force overwrites", async () => {
    const b = await box();
    const theirs = join(b.cursor, "skills", "nomo-pair", "SKILL.md");
    await mkdir(join(b.cursor, "skills", "nomo-pair"), { recursive: true });
    await writeFile(theirs, "mine\n");
    const r = await run(b);
    expect(r.code).toBe(1);
    expect(await readFile(theirs, "utf8")).toBe("mine\n");
    expect(await readdir(b.cursor)).toEqual(["skills"]);
    expect(await skillsIn(b)).toEqual(["nomo-pair"]);

    expect((await run(b, ["--force"])).code).toBe(0);
    expect(await readFile(theirs, "utf8")).toContain("nomo-cursor-install");
  });

  test("a dangling symlink: refused, the link is left exactly as it was", async () => {
    const b = await box();
    await symlink(join(b.tmp, "nowhere.json"), b.hooks);
    const r = await run(b);
    expect(r.code).toBe(1);
    expect(r.out).toContain("symlink whose target does not exist");
    expect(r.out).toContain("nothing was changed");
    expect(await readlink(b.hooks)).toBe(join(b.tmp, "nowhere.json"));
    expect(await readdir(b.cursor)).toEqual(["hooks.json"]);
    expect((await readdir(b.tmp)).includes("nowhere.json")).toBe(false);
  });

  test("a hard-linked hooks.json: refused rather than silently detached from its other name", async () => {
    const b = await box();
    const other = join(b.tmp, "dotfiles-hooks.json");
    const text = JSON.stringify(FOREIGN);
    await writeFile(other, text);
    await link(other, b.hooks);
    const r = await run(b);
    expect(r.code).toBe(1);
    expect(r.out).toContain("hard link");
    expect(r.out).toContain("nothing was changed");
    expect(await readFile(b.hooks, "utf8")).toBe(text);
    expect((await stat(b.hooks)).ino).toBe((await stat(other)).ino);
    expect(await skillsIn(b)).toEqual([]);
  });

  test("an unwritable Cursor dir: one named failure, no stack trace, nothing written", async () => {
    for (const withHooks of [false, true]) {
      const b = await box();
      if (withHooks) await writeFile(b.hooks, JSON.stringify(FOREIGN));
      await chmod(b.cursor, 0o555);
      try {
        const r = await run(b);
        expect(r.code).toBe(1);
        expect(r.out).toContain("cursor-install:");
        expect(r.out).toContain("not writable");
        expect(r.out).not.toMatch(/\n\s+at |node:fs|node:internal/);
        expect(await readdir(b.cursor)).toEqual(withHooks ? ["hooks.json"] : []);
        if (withHooks) expect(await readFile(b.hooks, "utf8")).toBe(JSON.stringify(FOREIGN));
      } finally {
        await chmod(b.cursor, 0o755);
      }
    }
  });

  test("an unwritable skills dir is refused BEFORE hooks.json is written", async () => {
    const b = await box();
    await mkdir(join(b.cursor, "skills"));
    await chmod(join(b.cursor, "skills"), 0o555);
    try {
      const r = await run(b);
      expect(r.code).toBe(1);
      expect(r.out).toContain("not writable");
      expect(r.out).not.toMatch(/node:fs|node:internal/);
      expect(await readdir(b.cursor)).toEqual(["skills"]);
    } finally {
      await chmod(join(b.cursor, "skills"), 0o755);
    }
  });

  test("a checkout path that is not shell-safe inside the skills' double quotes is refused", async () => {
    // Each of these would run, expand or break out of `NOMOR="<root>"` when a skill's command runs.
    // (`\` is rejected by the same check but cannot be driven from here: node itself refuses to load
    // an ES module from a path containing one.)
    for (const name of ["a$(touch pwned)", "back`tick", "dou\"ble", "dollar$&amp", "it's"]) {
      const b = await box(name);
      const r = await run(b);
      expect(r.code).toBe(1);
      expect(r.out).toContain("cannot be written safely");
      expect(await readdir(b.cursor)).toEqual([]);
    }
  });

  test("no Cursor config dir, or no built bundle: a named failure", async () => {
    const b = await box();
    await rm(b.cursor, { recursive: true });
    const gone = await run(b);
    expect(gone.code).toBe(1);
    expect(gone.out).toContain("does not exist");

    const c = await box();
    await rm(join(c.root, "dist", "cursor-status.mjs"));
    const unbuilt = await run(c);
    expect(unbuilt.code).toBe(1);
    expect(unbuilt.out).toContain("bun build.ts");
    expect(await readdir(c.cursor)).toEqual([]);
  });
});

describe("the /nomo-* skills", () => {
  test("installed with the checkout path baked in, removed by uninstall, foreign skills left alone", async () => {
    const b = await box();
    await mkdir(join(b.cursor, "skills", "someone-elses"), { recursive: true });
    await writeFile(join(b.cursor, "skills", "someone-elses", "SKILL.md"), "---\nname: someone-elses\n---\n");
    await run(b);
    expect(await skillsIn(b)).toEqual([...SKILLS, "someone-elses"].sort());
    for (const name of SKILLS) {
      const text = await readFile(join(b.cursor, "skills", name, "SKILL.md"), "utf8");
      expect(text).toContain(`name: ${name}\n`); // must match the folder name, per Cursor's skill rules
      expect(text).toContain(`NOMOR="${b.root}"`);
      expect(text).not.toContain("__NOMO_ROOT__");
    }
    // Cursor has no approvals in v1 — there must be no such skill to mislead anyone.
    expect(await skillsIn(b)).not.toContain("nomo-approvals");
    expect(await readFile(join(b.cursor, "skills", "nomo-status", "SKILL.md"), "utf8")).toContain("status-cmd.mjs\" cursor");

    await run(b, ["--uninstall"]);
    expect(await skillsIn(b)).toEqual(["someone-elses"]);
  });
});

describe("bunx nomo-ai --cursor", () => {
  async function plan(setup: (home: string, cursor: string) => Promise<void>): Promise<string> {
    const b = await box();
    await mkdir(b.home, { recursive: true });
    await setup(b.home, b.cursor);
    const proc = spawnTestProcess({
      cmd: ["node", NOMO_AI, "--dry-run", "--cursor"],
      cwd: b.tmp,
      env: isolatedTestEnv(b.home, { NO_COLOR: "1", CURSOR_CONFIG_DIR: b.cursor }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return `${out}${err}`;
  }

  /** `nomo-ai --dry-run <flags>` on a machine that has Claude Code and Codex but NO Cursor: PATH is a
   *  temp bin (stub `claude`/`codex`) plus the system dirs (for git), and CURSOR_CONFIG_DIR is absent. */
  async function noCursor(flags: string[]): Promise<{ code: number; out: string }> {
    const b = await box();
    await rm(b.cursor, { recursive: true });
    const bin = join(b.tmp, "bin");
    await mkdir(bin, { recursive: true });
    await mkdir(b.home, { recursive: true });
    for (const name of ["claude", "codex"]) await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const proc = spawnTestProcess({
      cmd: [Bun.which("node")!, NOMO_AI, "--dry-run", ...flags],
      cwd: b.tmp,
      env: isolatedTestEnv(b.home, { NO_COLOR: "1", CURSOR_CONFIG_DIR: b.cursor, PATH: `${bin}:/usr/bin:/bin` }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out: `${out}${err}` };
  }

  test("--all on a machine without Cursor skips it with a note instead of failing the run", async () => {
    const r = await noCursor(["--all"]);
    expect(r.out).toContain("Cursor was not found on this machine — skipped");
    expect(r.out).toContain("--cursor");
    expect(r.out).not.toContain("cursor-install.mjs"); // neither planned nor run
    expect(r.out).not.toContain("FAILED");
    expect(r.code).toBe(0);
    // The agents that ARE there are still installed.
    expect(r.out).toContain("claude plugin install nomo-cc@nomo");
    expect(r.out).toContain("opencode-install.sh");
  });

  test("an explicit --cursor is never skipped, with or without --all", async () => {
    for (const flags of [["--cursor"], ["--all", "--cursor"]]) {
      const r = await noCursor(flags);
      expect(r.out).not.toContain("skipped");
      expect(r.out).toContain("cursor-install.mjs");
    }
  });

  test("fresh: clones the checkout and runs the Cursor installer from it (dry run writes nothing)", async () => {
    const out = await plan(async () => {});
    expect(out).toContain("git clone --depth 1 https://github.com/KarrixLee/nomo.git");
    expect(out).toContain(".nomo/plugin/scripts/cursor-install.mjs");
    expect(out).not.toContain("claude plugin");
  });

  test("already installed (our command is in hooks.json): the row says it refreshes", async () => {
    const out = await plan(async (_home, cursor) => {
      await writeFile(join(cursor, "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: ours("/somewhere/plugin") }] } }));
    });
    expect(out).toContain("already installed");
  });
});
