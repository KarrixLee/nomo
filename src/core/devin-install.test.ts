// Tests for plugin/scripts/devin-install.mjs — the merge into Devin's ~/.config/devin/config.json.
//
// THE PROPERTY UNDER TEST: that file is the user's whole Devin config (org, shell, theme, their own
// hooks). Install and uninstall may add and remove NOMO's entries and nothing else. Driven as a
// SUBPROCESS against a throwaway plugin root + HOME (what lands on disk is what matters), plus direct
// calls into the pure exports. The real ~/.config/devin is never read or written.

import { cp, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { DEVIN_INSTALLER_COMMAND, devinPluginInstalled as tsPluginInstalled } from "./devin";
import { DEVIN_APPROVAL_TIMEOUT_S } from "./devin-approval";
import { createProcessHygiene, isolatedTestEnv } from "../test/process-hygiene";

const { spawnTestProcess } = createProcessHygiene();
const SCRIPT = join(import.meta.dir, "../../plugin/scripts/devin-install.mjs");

interface Installer {
  APPROVAL_TIMEOUT: number;
  OWNED: RegExp;
  devinPluginHooks(): Record<string, unknown[]>;
  devinPluginInstalled(lockText: string): boolean;
  devinHooks(root: string): Record<string, unknown[]>;
  stripJsonc(text: string): { json: string; hadComments: boolean };
  mergeHooks(config: Record<string, unknown>, root: string): Record<string, unknown>;
  removeHooks(config: Record<string, unknown>): Record<string, unknown>;
}
const mod = async () => await import(SCRIPT as string) as Installer;

/** A user's config as Devin writes it, plus a foreign hook on an event we use and one we do not. */
const FOREIGN = {
  version: 1,
  devin: { org_id: "org-test" },
  shell: { setup_complete: true },
  hooks: {
    PreToolUse: [{ matcher: "exec", hooks: [{ type: "command", command: "./audit.sh", timeout: 5 }] }],
    PostCompaction: [{ hooks: [{ type: "command", command: "./log.sh" }] }],
  },
  theme_mode: "dark",
};

const tmps: string[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Box { tmp: string; home: string; config: string; root: string; script: string }

async function checkout(tmp: string, name: string): Promise<{ root: string; script: string }> {
  const root = join(tmp, name, "plugin");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await cp(SCRIPT, join(root, "scripts", "devin-install.mjs"));
  await cp(join(import.meta.dir, "../../plugin/devin-skills"), join(root, "devin-skills"), { recursive: true });
  await writeFile(join(root, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const f of ["devin-status.mjs", "devin-approve.mjs"]) await writeFile(join(root, "dist", f), "// stub\n");
  return { root, script: join(root, "scripts", "devin-install.mjs") };
}

async function box(name = "nomo"): Promise<Box> {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "nomo-devin-install-")));
  tmps.push(tmp);
  const home = join(tmp, "home");
  await mkdir(home, { recursive: true });
  return { tmp, home, config: join(home, ".config", "devin", "config.json"), ...(await checkout(tmp, name)) };
}

async function run(b: Box, args: string[] = [], script = b.script): Promise<{ code: number; out: string }> {
  const proc = spawnTestProcess({
    cmd: ["node", script, ...args], cwd: b.tmp, env: isolatedTestEnv(b.home), stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out + err };
}

const read = async (p: string) => JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
const seed = async (b: Box, text: string) => {
  await mkdir(join(b.home, ".config", "devin"), { recursive: true });
  await writeFile(b.config, text, { mode: 0o644 });
};

describe("devin-install.mjs", () => {
  test("APPROVAL_TIMEOUT === DEVIN_APPROVAL_TIMEOUT_S", async () => {
    expect((await mod()).APPROVAL_TIMEOUT).toBe(DEVIN_APPROVAL_TIMEOUT_S);
  });

  test("fresh install writes exactly devinHooks under \"hooks\", file mode 0600 in a 0700 dir", async () => {
    const b = await box();
    const r = await run(b);
    expect(r.code).toBe(0);
    expect(r.out).toContain("restart devin");
    expect(await read(b.config)).toEqual({ hooks: (await mod()).devinHooks(b.root) });
    expect((await stat(b.config)).mode & 0o777).toBe(0o600);
    expect((await stat(join(b.home, ".config", "devin"))).mode & 0o777).toBe(0o700);
    // the approval command keeps a shell between Devin and the bundle (abandonment detection)
    const pr = (await read(b.config)).hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>>;
    expect(pr.PermissionRequest![0]!.hooks[0]!.command).toBe(`'${b.root}/scripts/run.sh' '${b.root}/dist/devin-approve.mjs'; exit 0`);
    expect(pr.PermissionRequest![0]!.hooks[0]!.timeout).toBe(86400);
    // Devin's question (PreToolUse ^ask_user_question$) is held by the same approval command
    expect(pr.PreToolUse![0]).toEqual({ matcher: "^ask_user_question$", hooks: pr.PermissionRequest![0]!.hooks });
  });

  test("re-running over an older install swaps the question entry from the status to the approval command, in place", async () => {
    const m = await mod();
    const old = { hooks: { PreToolUse: [{ matcher: "^ask_user_question$", hooks: [{ type: "command", command: "'/r/scripts/run.sh' '/r/dist/devin-status.mjs'", timeout: 10 }] }] } };
    expect((m.mergeHooks(old, "/r").hooks as Record<string, unknown>).PreToolUse).toEqual(m.devinHooks("/r").PreToolUse);
  });

  test("devinPluginHooks: the question entry is the approval command with the long timeout, shell kept as its parent", async () => {
    const pre = ((await mod()).devinPluginHooks() as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>>).PreToolUse![0]!;
    expect(pre.matcher).toBe("^ask_user_question$");
    expect(pre.hooks[0]!.command).toContain("devin-approve.mjs");
    expect(pre.hooks[0]!.command).not.toContain("exec ");
    expect(pre.hooks[0]!.timeout).toBe(86400);
  });

  test("foreign hooks, unknown top-level keys and their order survive install and uninstall", async () => {
    const b = await box();
    await seed(b, JSON.stringify(FOREIGN, null, 2));
    expect((await run(b)).code).toBe(0);
    const installed = await read(b.config);
    expect(Object.keys(installed)).toEqual(Object.keys(FOREIGN));
    const hooks = installed.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse![0]).toEqual(FOREIGN.hooks.PreToolUse[0]); // theirs first, ours appended
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PostCompaction).toEqual(FOREIGN.hooks.PostCompaction);
    expect((await stat(b.config)).mode & 0o777).toBe(0o644); // the original's mode
    expect((await run(b, ["--uninstall"])).code).toBe(0);
    expect(await read(b.config)).toEqual(FOREIGN);
  });

  test("re-install is byte-identical (no rewrite)", async () => {
    const b = await box();
    await seed(b, JSON.stringify(FOREIGN));
    await run(b);
    const text = await readFile(b.config, "utf8");
    const mtime = (await stat(b.config)).mtimeMs;
    const r = await run(b);
    expect(r.out).toContain("already set up");
    expect(await readFile(b.config, "utf8")).toBe(text);
    expect((await stat(b.config)).mtimeMs).toBe(mtime);
  });

  test("install from a moved checkout replaces our old entries in place, never duplicates", async () => {
    const b = await box();
    await seed(b, JSON.stringify(FOREIGN));
    await run(b);
    const moved = await checkout(b.tmp, "moved");
    expect((await run(b, [], moved.script)).code).toBe(0);
    const text = await readFile(b.config, "utf8");
    expect(text).not.toContain(`${b.root}/`);
    expect((await read(b.config)).hooks).toEqual((await mod()).mergeHooks(FOREIGN, moved.root).hooks as object);
    expect((((await read(b.config)).hooks as Record<string, unknown[]>).PreToolUse)).toHaveLength(2);
  });

  test("uninstall removes only ours and drops an event / the hooks key only when we emptied it", async () => {
    const m = await mod();
    const fresh = m.mergeHooks({ version: 1 }, "/r");
    expect(m.removeHooks(fresh)).toEqual({ version: 1 });
    // an event the user left EMPTY themselves is not ours to delete
    const theirsEmpty = m.mergeHooks({ hooks: { Stop: [], Notification: [] } }, "/r");
    expect(m.removeHooks(theirsEmpty)).toEqual({ hooks: { Notification: [] } });
    // an entry mixing our command with someone else's is not ours
    const mixed = { hooks: { Stop: [{ hooks: [{ type: "command", command: "'/r/scripts/run.sh' '/r/dist/devin-status.mjs'" }, { type: "command", command: "./x.sh" }] }] } };
    expect(m.removeHooks(mixed)).toEqual(mixed);
    // pure: inputs are not mutated
    const input = structuredClone(FOREIGN);
    m.mergeHooks(input, "/r");
    m.removeHooks(input);
    expect(input).toEqual(FOREIGN);
    // the CLI with no config file → nothing to do, exit 0, no file created
    const b = await box();
    const r = await run(b, ["--uninstall"]);
    expect(r.code).toBe(0);
    expect(await stat(b.config).then(() => true, () => false)).toBe(false);
  });

  test("a config with // comments: backed up to config.json.nomo-backup, comments dropped, merged, one line said", async () => {
    const b = await box();
    const commented = `{\n  // my org\n  "version": 1,\n  "devin": { "org_id": "org-test" }, /* theme */ "theme_mode": "dark",\n}\n`;
    await seed(b, commented);
    const r = await run(b);
    expect(r.code).toBe(0);
    expect(r.out).toContain("comments");
    expect(r.out).toContain("config.json.nomo-backup");
    expect(await readFile(`${b.config}.nomo-backup`, "utf8")).toBe(commented);
    const doc = await read(b.config);
    expect(doc).toMatchObject({ version: 1, devin: { org_id: "org-test" }, theme_mode: "dark" });
    expect(doc.hooks).toEqual((await mod()).devinHooks(b.root));
    expect(await readFile(b.config, "utf8")).not.toContain("//");
  });

  test("stripJsonc keeps strings intact and drops trailing commas", async () => {
    const { stripJsonc } = await mod();
    const r = stripJsonc(`{"u": "http://x//y /* no */", "a": [1, 2,], // c\n "b": {"c": "q\\"//",},}`);
    expect(r.hadComments).toBe(true);
    expect(JSON.parse(r.json)).toEqual({ u: "http://x//y /* no */", a: [1, 2], b: { c: 'q"//' } });
    expect(stripJsonc(`{"a": 1}`)).toEqual({ json: `{"a": 1}`, hadComments: false });
  });

  test("unparseable / non-object / bad hooks / dangling symlink / hard link → refuse, exit 1, file untouched", async () => {
    for (const text of ["{ not json", "[1, 2]", `{"hooks": []}`]) {
      const b = await box();
      await seed(b, text);
      const r = await run(b);
      expect(r.code).toBe(1);
      expect(await readFile(b.config, "utf8")).toBe(text);
      expect(r.out).toContain("nothing was changed");
    }
    const b = await box();
    await mkdir(join(b.home, ".config", "devin"), { recursive: true });
    await symlink(join(b.tmp, "missing.json"), b.config);
    expect((await run(b)).code).toBe(1);
    const h = await box();
    await seed(h, "{}");
    await link(h.config, join(h.tmp, "other-name.json"));
    expect((await run(h)).code).toBe(1);
    expect(await readFile(h.config, "utf8")).toBe("{}");
  });

  test("writes THROUGH a live symlink (dotfiles), keeping the link", async () => {
    const b = await box();
    const real = join(b.tmp, "dotfiles-devin.json");
    await writeFile(real, JSON.stringify(FOREIGN));
    await mkdir(join(b.home, ".config", "devin"), { recursive: true });
    await symlink(real, b.config);
    expect((await run(b)).code).toBe(0);
    expect((await read(real)).hooks).toHaveProperty("PermissionRequest");
    const { lstat } = await import("node:fs/promises");
    expect((await lstat(b.config)).isSymbolicLink()).toBe(true);
  });

  test("a missing bundle refuses before writing", async () => {
    const b = await box();
    await rm(join(b.root, "dist", "devin-approve.mjs"));
    const r = await run(b);
    expect(r.code).toBe(1);
    expect(await stat(b.config).then(() => true, () => false)).toBe(false);
  });

  test("a Nomo Devin plugin in Devin's lock.json → one line, config.json never written", async () => {
    const b = await box();
    await mkdir(join(b.home, ".local", "share", "devin", "cli", "plugins"), { recursive: true });
    await writeFile(join(b.home, ".local", "share", "devin", "cli", "plugins", "lock.json"),
      JSON.stringify({ requirements: [], resolved: [{ name: "devin-playbooks" }, { name: "nomo" }] }));
    const r = await run(b);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("devin-install: Nomo is already installed as a Devin plugin — nothing to do");
    expect(await stat(b.config).then(() => true, () => false)).toBe(false);
    expect(existsSync(join(b.home, ".config", "devin", "skills"))).toBe(false); // the plugin gives /nomo:*
  });

  const SKILLS = ["approvals", "pair", "reset", "status", "unpair"];
  const skillPath = (b: Box, name: string) => join(b.home, ".config", "devin", "skills", name, "SKILL.md");

  test("install writes the user-level /nomo-* skills from the plugin's, pointed at this checkout", async () => {
    const b = await box();
    expect((await run(b)).code).toBe(0);
    for (const name of SKILLS) {
      const text = await readFile(skillPath(b, `nomo-${name}`), "utf8");
      expect(text).toContain(`name: nomo-${name}\n`);
      expect(text).toContain(`for NOMOR in "${b.root}"; do`);
      expect(text).not.toContain("plugins/cache");
      expect(text).not.toContain("/nomo:");
      expect(text).not.toContain("devin plugins install");
      expect(text.trimEnd().endsWith("<!-- nomo-devin-install -->")).toBe(true);
    }
    expect(await readFile(skillPath(b, "nomo-status"), "utf8")).toContain("suggest `/nomo-pair`");
    const again = await run(b);
    expect(again.out).toContain("already set up — nothing changed");
  });

  test("a same-named skill of the user's is skipped with a note, and survives uninstall; ours go", async () => {
    const b = await box();
    await mkdir(join(b.home, ".config", "devin", "skills", "nomo-reset"), { recursive: true });
    await writeFile(skillPath(b, "nomo-reset"), "mine\n");
    const r = await run(b);
    expect(r.code).toBe(0);
    expect(r.out).toContain("skipped /nomo-reset: you already have your own skill with that name");
    expect(await readFile(skillPath(b, "nomo-reset"), "utf8")).toBe("mine\n");
    expect(existsSync(skillPath(b, "nomo-status"))).toBe(true);
    const u = await run(b, ["--uninstall"]);
    expect(u.out).toContain("removed the /nomo-approvals /nomo-pair /nomo-status /nomo-unpair skills");
    expect(await readFile(skillPath(b, "nomo-reset"), "utf8")).toBe("mine\n");
    for (const name of ["approvals", "pair", "status", "unpair"]) expect(existsSync(join(b.home, ".config", "devin", "skills", `nomo-${name}`))).toBe(false);
  });
});

// ── the native Devin plugin (repo root) ──────────────────────────────────────────────────────────

const REPO = join(import.meta.dir, "..", "..");

describe("native Devin plugin", () => {
  test("root hooks.json is exactly devinPluginHooks() — same events, matchers and timeouts as the installer", async () => {
    const m = await mod();
    // On drift, regenerate: node -e 'import("./plugin/scripts/devin-install.mjs").then(m=>process.stdout.write(JSON.stringify(m.devinPluginHooks(),null,2)+"\n"))' > hooks.json
    expect(await read(join(REPO, "hooks.json"))).toEqual(m.devinPluginHooks());
    const shape = (h: Record<string, unknown[]>) => JSON.stringify(h, (k, v) => (k === "command" ? undefined : v));
    expect(shape(m.devinPluginHooks())).toBe(shape(m.devinHooks("/r")));
    for (const list of Object.values(m.devinPluginHooks()) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      const cmd = list[0]!.hooks[0]!.command;
      expect(cmd).toContain("--via=devin-plugin");
      expect(cmd.endsWith("; exit 0")).toBe(true);
      // the approval hold keeps the shell as its parent (Devin SIGKILLs the hook's direct child)
      expect(cmd.includes("exec ")).toBe(!cmd.includes("devin-approve.mjs"));
    }
  });

  test("manifest: name nomo, local only, skills from plugin/devin-skills (pair, status, approvals, reset, unpair)", async () => {
    const manifest = await read(join(REPO, ".devin-plugin", "plugin.json"));
    expect(manifest).toMatchObject({ name: "nomo", platforms: ["local"], skills: "plugin/devin-skills" });
    expect(manifest).not.toHaveProperty("hooks"); // hooks come from root hooks.json
    for (const skill of ["approvals", "pair", "reset", "status", "unpair"]) {
      const text = await readFile(join(REPO, "plugin", "devin-skills", skill, "SKILL.md"), "utf8");
      expect(text).toContain('"$HOME"/.local/share/devin/cli/plugins/cache/*nomo*/*/plugin'); // userSkill() swaps exactly this
      expect(text).toContain(`name: ${skill}`);
      expect(text).not.toContain("__NOMO_ROOT__");
    }
    expect(existsSync(join(REPO, String(manifest.logo)))).toBe(true);
  });

  test("the repo root carries nothing else Devin would load as part of the plugin", () => {
    for (const p of ["hooks", "skills", "AGENTS.md", "rules", "agents", ".mcp.json", "mcp.json", "plugin.json", ".claude-plugin/plugin.json"]) {
      expect({ p, exists: existsSync(join(REPO, p)) }).toEqual({ p, exists: false });
    }
  });

  test("the bundle's TS twins match the installer", async () => {
    const m = await mod();
    expect(DEVIN_INSTALLER_COMMAND.source).toBe(m.OWNED.source);
    for (const lock of ["", "{", "[]", '{"resolved":[{"name":"nomo"}]}', '{"resolved":[{"name":"nomo-cc"}]}', '{"resolved":"nomo"}']) {
      expect({ lock, ts: tsPluginInstalled(lock) }).toEqual({ lock, ts: m.devinPluginInstalled(lock) });
    }
  });
});
