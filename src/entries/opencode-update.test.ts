// Tests for opencode-update — the /nomo-update check.
//
// The stub resolution runs against REAL temp files (that is where the bug would be: two directory
// names, two scopes, and a target that outlives its checkout), while git is injected — every refusal
// this command exists for is a git state that a real repository would take a network round-trip and a
// commit graph to produce, and none of them are about git itself.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { checkUpdate, type UpdateDeps } from "./opencode-update";

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
