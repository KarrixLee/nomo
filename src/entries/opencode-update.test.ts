// Tests for opencode-update — the /nomo-update check.
//
// The stub resolution runs against REAL temp files (that is where the bug would be: two directory
// names, two scopes, and a target that outlives its checkout), while git is injected — every refusal
// this command exists for is a git state that a real repository would take a network round-trip and a
// commit graph to produce, and none of them are about git itself.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { REMOTE_IS_OURS } from "../core/shared";
import { checkUpdate, opencodeUpdate, type UpdateDeps } from "./opencode-update";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nomo-update-"));
  dirs.push(d);
  return d;
}

/** A checkout on disk: <root>/plugin/dist/opencode.js + the manifest the build injects from. */
async function checkout(root: string, version: string): Promise<string> {
  await mkdir(join(root, "plugin", "dist"), { recursive: true });
  await mkdir(join(root, "plugin", ".claude-plugin"), { recursive: true });
  await writeFile(join(root, "plugin", "dist", "opencode.js"), "export default {};\n");
  await writeFile(join(root, "plugin", ".claude-plugin", "plugin.json"), JSON.stringify({ version }));
  return join(root, "plugin", "dist", "opencode.js");
}

async function stub(path: string, target: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `// nomo-opencode-install\nexport { default } from "${target}";\n`);
  return path;
}

/** A git that answers from a table, so a test states only the answers it cares about. */
function fakeGit(answers: Record<string, { status?: number; stdout?: string; stderr?: string }>) {
  return (_dir: string, args: string[]) => {
    const key = args.join(" ");
    const a = answers[key] ?? answers[args[0]!] ?? {};
    return { status: a.status ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
}

/** The happy-path git: a branch, clean, tracking origin/main. */
function healthyGit(root: string, extra: Record<string, { status?: number; stdout?: string; stderr?: string }> = {}) {
  return fakeGit({
    "rev-parse --show-toplevel": { stdout: root },
    "remote get-url origin": { stdout: "https://github.com/KarrixLee/nomo.git" },
    "symbolic-ref --short -q HEAD": { stdout: "main" },
    "status --porcelain": { stdout: "" },
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": { stdout: "origin/main" },
    "fetch --quiet": {},
    // Default: upstream IS an ancestor of HEAD, i.e. nothing to pull.
    "merge-base --is-ancestor origin/main HEAD": { status: 0 },
    ...extra,
  });
}

async function fixture(version = "2.1.21"): Promise<{ root: string; deps: UpdateDeps }> {
  const home = await scratch();
  const root = join(home, "nomo");
  const target = await checkout(root, version);
  await stub(join(home, ".config", "opencode", "plugins", "nomo.js"), target);
  return {
    root,
    deps: {
      stubPaths: [join(home, ".config", "opencode", "plugins", "nomo.js"), join(home, ".config", "opencode", "plugin", "nomo.js")],
      cwd: join(home, "project"),
      self: join(root, "plugin", "dist"),
    },
  };
}

describe("checkUpdate resolves the checkout from the stub", () => {
  test("up to date says so, and names no restart", async () => {
    const { root, deps } = await fixture("2.1.21");
    const found = checkUpdate({ ...deps, git: healthyGit(root) });
    expect(found.state).toBe("current");
    expect(found.root).toBe(root);
    expect(found.line).toBe("Already on 2.1.21 — nothing to do.");
    expect(found.hint).toBeUndefined();
  });

  test("behind reports the delta read from the REMOTE manifest, without checking anything out", async () => {
    const { root, deps } = await fixture("2.1.21");
    const found = checkUpdate({
      ...deps,
      git: healthyGit(root, {
        "merge-base --is-ancestor origin/main HEAD": { status: 1 },
        "merge-base --is-ancestor HEAD origin/main": { status: 0 },
        "show origin/main:plugin/.claude-plugin/plugin.json": { stdout: JSON.stringify({ version: "2.1.23" }) },
      }),
    });
    expect(found.state).toBe("behind");
    expect(found.from).toBe("2.1.21");
    expect(found.to).toBe("2.1.23");
    expect(found.line).toBe("Update available: 2.1.21 → 2.1.23.");
  });

  test("new commits without a version bump do not render as 2.1.21 → 2.1.21", async () => {
    const { root, deps } = await fixture("2.1.21");
    const found = checkUpdate({
      ...deps,
      git: healthyGit(root, {
        "merge-base --is-ancestor origin/main HEAD": { status: 1 },
        "merge-base --is-ancestor HEAD origin/main": { status: 0 },
        "show origin/main:plugin/.claude-plugin/plugin.json": { stdout: JSON.stringify({ version: "2.1.21" }) },
      }),
    });
    expect(found.state).toBe("behind");
    expect(found.line).toBe("Newer commits on origin/main — still 2.1.21.");
  });

  test("the legacy singular plugin/ stub still resolves", async () => {
    const home = await scratch();
    const root = join(home, "nomo");
    const target = await checkout(root, "2.1.21");
    await stub(join(home, ".config", "opencode", "plugin", "nomo.js"), target);
    const found = checkUpdate({
      stubPaths: [join(home, ".config", "opencode", "plugins", "nomo.js"), join(home, ".config", "opencode", "plugin", "nomo.js")],
      cwd: join(home, "project"),
      self: join(root, "plugin", "dist"),
      git: healthyGit(root),
    });
    expect(found.state).toBe("current");
    expect(found.root).toBe(root);
  });

  test("a project-scope stub is found, and marks the re-install as project scope", async () => {
    const home = await scratch();
    const project = join(home, "project");
    const root = join(home, "nomo");
    const target = await checkout(root, "2.1.21");
    await stub(join(project, ".opencode", "plugins", "nomo.js"), target);
    const found = checkUpdate({
      stubPaths: [join(home, ".config", "opencode", "plugins", "nomo.js")],
      cwd: project,
      self: join(root, "plugin", "dist"),
      git: healthyGit(root),
    });
    expect(found.state).toBe("current");
    expect(found.project).toBe(true);
  });
});

describe("checkUpdate refuses loudly, and always names the by-hand command", () => {
  test("a detached checkout is a PIN, and is left alone rather than fast-forwarded", async () => {
    const { root, deps } = await fixture();
    const found = checkUpdate({
      ...deps,
      git: healthyGit(root, {
        "symbolic-ref --short -q HEAD": { status: 1, stdout: "" },
        "describe --tags --always": { stdout: "v2.1.0" },
      }),
    });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("detached at v2.1.0");
    expect(found.line).toContain("pinned");
    expect(found.hint).toContain("--ref");
  });

  test("a dirty tree is refused BEFORE the network", async () => {
    const { root, deps } = await fixture();
    let fetched = false;
    const inner = healthyGit(root, { "status --porcelain": { stdout: " M src/a.ts\n?? b.ts" } });
    const found = checkUpdate({
      ...deps,
      git: (dir, args) => {
        if (args[0] === "fetch") fetched = true;
        return inner(dir, args);
      },
    });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("2 uncommitted changes");
    expect(found.hint).toContain("git -C");
    expect(fetched).toBe(false);
  });

  test("a branch tracking nothing", async () => {
    const { root, deps } = await fixture();
    const found = checkUpdate({
      ...deps,
      git: healthyGit(root, { "rev-parse --abbrev-ref --symbolic-full-name @{u}": { status: 1, stdout: "" } }),
    });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("tracks nothing");
    expect(found.hint).toContain("--set-upstream-to");
  });

  test("a diverged checkout is named as such rather than left to git's --ff-only wording", async () => {
    const { root, deps } = await fixture();
    const found = checkUpdate({
      ...deps,
      git: healthyGit(root, {
        "merge-base --is-ancestor origin/main HEAD": { status: 1 },
        "merge-base --is-ancestor HEAD origin/main": { status: 1 },
      }),
    });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("diverged");
    expect(found.hint).toContain("log --oneline");
  });

  test("an unreachable remote quotes git's own first line", async () => {
    const { root, deps } = await fixture();
    const found = checkUpdate({
      ...deps,
      git: healthyGit(root, { "fetch --quiet": { status: 128, stderr: "fatal: unable to access 'https://…'\nmore" } }),
    });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("could not reach the remote");
    expect(found.line).toContain("fatal: unable to access");
    expect(found.line).not.toContain("more");
  });

  test("a stub pointing at a deleted checkout is the failure nobody can diagnose, so it is spelled out", async () => {
    const home = await scratch();
    const target = join(home, "gone", "plugin", "dist", "opencode.js");
    await stub(join(home, ".config", "opencode", "plugins", "nomo.js"), target);
    const found = checkUpdate({
      stubPaths: [join(home, ".config", "opencode", "plugins", "nomo.js")],
      cwd: join(home, "project"),
      self: join(home, "self", "dist"),
      git: healthyGit(home),
    });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("which is gone");
    expect(found.line).toContain("moved or deleted");
    expect(found.hint).toContain("opencode-install.sh");
  });

  test("no stub at all is 'nothing installed', and names the installer next to this bundle", async () => {
    const home = await scratch();
    const found = checkUpdate({
      stubPaths: [join(home, "nope.js")],
      cwd: join(home, "project"),
      self: join(home, "nomo", "plugin", "dist"),
      git: healthyGit(home),
    });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("no Nomo plugin stub");
    expect(found.hint).toContain(join(home, "nomo", "plugin", "scripts", "opencode-install.sh"));
  });

  test("somebody else's nomo.js is not overwritten, or read as ours", async () => {
    const home = await scratch();
    const path = join(home, ".config", "opencode", "plugins", "nomo.js");
    await mkdir(join(home, ".config", "opencode", "plugins"), { recursive: true });
    await writeFile(path, "export default function nomo() {}\n");
    const found = checkUpdate({ stubPaths: [path], cwd: home, self: join(home, "x", "dist"), git: healthyGit(home) });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("is not a Nomo stub");
  });

  test("a copy that is not a git checkout cannot be updated in place", async () => {
    const { deps } = await fixture();
    const found = checkUpdate({ ...deps, git: fakeGit({ "rev-parse --show-toplevel": { status: 128 } }) });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("not a git checkout");
    expect(found.hint).toContain("git clone");
  });
});

// NOM-121. The updater pulls a checkout and then EXECUTES its plugin/scripts/opencode-install.sh, so the
// checkout it picks is a trust decision: a repo the user merely cd'd into must not get to name it.
describe("checkUpdate only ever acts on Nomo's own checkout", () => {
  /** A stand-in installer that proves whether it ran (and with what) by writing a marker file. */
  async function installer(root: string): Promise<string> {
    const marker = join(root, "installer-ran");
    const script = join(root, "plugin", "scripts", "opencode-install.sh");
    await mkdir(join(root, "plugin", "scripts"), { recursive: true });
    await writeFile(script, `#!/bin/sh\necho "ran $*" > "${marker}"\n`);
    await chmod(script, 0o755);
    return marker;
  }

  /** git that says "behind", records every call, and reports `origin` as the given URL. */
  function behindGit(root: string, origin: string, calls: string[]) {
    const inner = healthyGit(root, {
      "remote get-url origin": { stdout: origin },
      "merge-base --is-ancestor origin/main HEAD": { status: 1 },
      "merge-base --is-ancestor HEAD origin/main": { status: 0 },
      "show origin/main:plugin/.claude-plugin/plugin.json": { stdout: JSON.stringify({ version: "2.1.23" }) },
    });
    return (dir: string, args: string[]) => {
      calls.push(args.join(" "));
      return inner(dir, args);
    };
  }

  test("a cwd stub into a FOREIGN repo is blocked, and its installer never runs", async () => {
    const home = await scratch();
    const evil = join(home, "evil-repo");
    const target = await checkout(evil, "9.9.9");
    const marker = await installer(evil);
    await stub(join(evil, ".opencode", "plugins", "nomo.js"), target);
    const calls: string[] = [];
    const deps: UpdateDeps = {
      stubPaths: [join(home, ".config", "opencode", "plugins", "nomo.js")],
      cwd: evil,
      self: join(home, "x", "dist"),
      print: () => {},
      git: behindGit(evil, "https://github.com/attacker/KarrixLee-nomo.git", calls),
    };
    const found = checkUpdate(deps);
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("is not a Nomo checkout");
    expect(opencodeUpdate(deps)).toBe(1);
    expect(existsSync(marker)).toBe(false);
    // Nothing past the identity check: no status (which can run configured hooks), no fetch, no merge.
    expect(calls.some((c) => /^(status|fetch|merge)/.test(c))).toBe(false);
  });

  test("REMOTE_IS_OURS: only github.com, exactly KarrixLee/nomo, any case, optional .git and slash", () => {
    for (const ok of [
      "https://github.com/KarrixLee/nomo", "https://github.com/KarrixLee/nomo.git", "https://github.com/KarrixLee/nomo/",
      "https://github.com/KarrixLee/nomo.git/", "ssh://git@github.com/KarrixLee/nomo.git", "git@github.com:KarrixLee/nomo.git",
      "git@github.com:KarrixLee/nomo", "https://github.com/karrixlee/nomo.git", "git@github.com:karrixlee/NOMO",
    ]) expect([ok, REMOTE_IS_OURS.test(ok)]).toEqual([ok, true]);
    for (const bad of [
      "https://github.com/KarrixLee/nomo-evil.git", // look-alike name
      "https://evil.example/KarrixLee/nomo.git", "git@evil.example:KarrixLee/nomo.git", "ssh://git@evil.example/KarrixLee/nomo",
      "https://github.com.evil.example/KarrixLee/nomo", "https://evil.example/github.com/KarrixLee/nomo", // host look-alikes
      "https://gitlab.com/group/KarrixLee/nomo.git", "https://github.com/group/KarrixLee/nomo", "git@github.com:group/KarrixLee/nomo", // subgroup paths
      "/Users/me/KarrixLee/nomo", "KarrixLee/nomo", "",
    ]) expect([bad, REMOTE_IS_OURS.test(bad)]).toEqual([bad, false]);
  });

  test("a RELATIVE stub target is rejected, not resolved against the cwd", async () => {
    const home = await scratch();
    const project = join(home, "project");
    await checkout(project, "2.1.21");
    await stub(join(project, ".opencode", "plugins", "nomo.js"), "./plugin/dist/opencode.js");
    const found = checkUpdate({ stubPaths: [], cwd: project, self: join(home, "x", "dist"), git: healthyGit(project) });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("is not a Nomo stub");
  });

  test("a target that is not <checkout>/plugin/dist/opencode.js is rejected", async () => {
    const home = await scratch();
    await writeFile(join(home, "x.js"), "export default {};\n");
    const path = await stub(join(home, "plugins", "nomo.js"), join(home, "x.js"));
    const found = checkUpdate({ stubPaths: [path], cwd: home, self: join(home, "x", "dist"), git: healthyGit(home) });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("is not a Nomo stub");
  });

  test("--global never reads the cwd stub (what bin/nomo-ai.mjs runs)", async () => {
    const home = await scratch();
    const project = join(home, "project");
    const root = join(home, "nomo");
    await stub(join(project, ".opencode", "plugins", "nomo.js"), await checkout(root, "2.1.21"));
    const found = checkUpdate({ stubPaths: [], cwd: project, global: true, self: join(root, "plugin", "dist"), git: healthyGit(root) });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("no global Nomo plugin stub");
    // A --project user must be pointed at the project, not told nothing is installed.
    expect(found.line).toContain("If you installed Nomo into a project, run /nomo-update inside OpenCode there.");
    expect(found.line).not.toContain("nothing here is installed");
  });

  test("without --global, a missing stub keeps the plain message (no project hint)", async () => {
    const home = await scratch();
    const found = checkUpdate({ stubPaths: [], cwd: home, self: join(home, "x", "dist"), git: healthyGit(home) });
    expect(found.state).toBe("blocked");
    expect(found.line).toContain("nothing here is installed");
    expect(found.line).not.toContain("/nomo-update inside OpenCode");
  });

  test("a legit --project install into Nomo's own checkout still updates, re-installing with --project", async () => {
    const home = await scratch();
    const project = join(home, "project");
    const root = join(home, "nomo");
    const target = await checkout(root, "2.1.21");
    const marker = await installer(root);
    await stub(join(project, ".opencode", "plugins", "nomo.js"), target);
    const calls: string[] = [];
    const code = opencodeUpdate({
      stubPaths: [join(home, ".config", "opencode", "plugins", "nomo.js")],
      cwd: project,
      self: join(root, "plugin", "dist"),
      print: () => {},
      git: behindGit(root, "git@github.com:KarrixLee/nomo.git", calls),
    });
    expect(code).toBe(0);
    expect(calls).toContain("merge --ff-only origin/main");
    expect((await readFile(marker, "utf8")).trim()).toBe("ran --project");
  });

  test("bin/nomo-ai.mjs and src/core/shared.ts agree on REMOTE_IS_OURS", async () => {
    const bin = await readFile(join(import.meta.dir, "../../bin/nomo-ai.mjs"), "utf8");
    const repo = /const REPO = "([^"]+)";/.exec(bin)?.[1];
    const m = /const REMOTE_IS_OURS = new RegExp\(`([^`]+)`, "([a-z]*)"\);/.exec(bin);
    expect(repo).toBe("KarrixLee/nomo");
    const twin = new RegExp(m![1]!.replace("${REPO}", repo!).replaceAll("\\\\", "\\"), m![2]);
    expect(twin.source).toBe(REMOTE_IS_OURS.source);
    expect(twin.flags).toBe(REMOTE_IS_OURS.flags);
  });
});
