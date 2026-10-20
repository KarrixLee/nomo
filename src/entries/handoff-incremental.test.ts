// NOM-110: incremental move — path selection, the public-URL filter, bundle ranges and the box-side
// seed script, all on real temp git repos (no network: ls-remote is injected).
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, boxHeadScript, newCommits, parseBoxHead, pickRepoShip, projectDirName, publicCloneUrl, type RepoShip, SEED_FAILED, seedScript } from "./handoff";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `nomo-incr-${p}-`)));
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...a], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
function commit(dir: string, file: string, text: string): string {
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", file);
  return git(dir, "rev-parse", "HEAD");
}
/** A Mac repo with commits a, b (returns their shas). */
function macRepo(): { dir: string; a: string; b: string } {
  const dir = tmp("mac");
  git(dir, "init", "-q");
  const a = commit(dir, "a.txt", "a\n");
  const b = commit(dir, "b.txt", "b\n");
  return { dir, a, b };
}
/** Give `dir`'s main branch an upstream `origin/main` at `at`, with origin = `url`. */
function upstream(dir: string, url: string, at: string): void {
  git(dir, "remote", "add", "origin", url);
  git(dir, "update-ref", "refs/remotes/origin/main", at);
  git(dir, "config", "branch.main.remote", "origin");
  git(dir, "config", "branch.main.merge", "refs/heads/main");
}
const never = () => { throw new Error("ls-remote must not run"); };
/** Run a box snippet with ROOT set, under set -euo pipefail like the real box script. */
const runBox = (root: string, script: string) =>
  spawnSync("bash", ["-c", `set -euo pipefail\nROOT='${root}'\n${script}`], { encoding: "utf8", env: { PATH: process.env.PATH!, HOME: tmp("home") } });

describe("publicCloneUrl", () => {
  test("accepts plain https forge URLs", () => {
    for (const u of ["https://github.com/o/r", "https://github.com/o/r.git", "https://gitlab.com/group/sub/r.git", "https://codeberg.org/o/r"]) expect(publicCloneUrl(u)).toBe(u);
  });
  test("rejects ssh, scp-style, userinfo, non-https, file://, local paths and anything odd", () => {
    for (const u of [
      "git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "git://github.com/o/r", "http://github.com/o/r",
      "https://user:tok@github.com/o/r", "https://tok@github.com/o/r", "https://x-access-token:ghp_x@github.com/o/r.git",
      "file:///tmp/r", "/tmp/r", "../r", "r", "https://github.com:443/o/r", "https://github.com/o/r?x=1", "https://github.com/o/r#x",
      "https://evil.com/o/r", "https://github.com.evil.com/o/r", "https://GITHUB.com/o/r", "https://github.com/o",
      "https://github.com/../r", "https://github.com/o/%2e%2e", "https://github.com/o/r\n", "https://github.com/o/r --upload-pack=x", "",
    ]) expect(publicCloneUrl(u)).toBeUndefined();
  });
});

describe("pickRepoShip", () => {
  test("box head this Mac has → box mode, based on it (ancestor or not)", () => {
    const { dir, a } = macRepo();
    expect(pickRepoShip(dir, a, never)).toEqual({ mode: "box", base: a, head: git(dir, "rev-parse", "HEAD") });
    // a box head off to the side (a cloud commit brought back onto its own branch) is still a valid base
    git(dir, "checkout", "-q", "-b", "side", a);
    const side = commit(dir, "s.txt", "s\n");
    git(dir, "checkout", "-q", "main");
    expect(pickRepoShip(dir, side, never)).toMatchObject({ mode: "box", base: side });
  });
  test("unknown or malformed box head → not box mode (rewritten history / new box)", () => {
    const { dir } = macRepo();
    expect(pickRepoShip(dir, "f".repeat(40), () => false)).toEqual({ mode: "full" });
    expect(pickRepoShip(dir, "HEAD", () => false)).toEqual({ mode: "full" });
    expect(pickRepoShip(dir, undefined, () => false)).toEqual({ mode: "full" });
  });
  test("public upstream an anonymous ls-remote sees → clone, base = merge-base with @{u}", () => {
    const { dir, a, b } = macRepo();
    upstream(dir, "https://github.com/o/r.git", a);
    const calls: string[] = [];
    expect(pickRepoShip(dir, undefined, (u, r) => { calls.push(`${u} ${r}`); return true; }))
      .toEqual({ mode: "clone", url: "https://github.com/o/r.git", base: a, head: b });
    expect(calls).toEqual(["https://github.com/o/r.git refs/heads/main"]);
    expect(pickRepoShip(dir, "0".repeat(40), () => true)).toMatchObject({ mode: "clone" }); // unknown box head → clone
  });
  test("private (ls-remote fails), ssh, token URL, detached, no upstream → full", () => {
    const { dir, a } = macRepo();
    expect(pickRepoShip(dir, undefined, never)).toEqual({ mode: "full" }); // no upstream
    upstream(dir, "https://github.com/o/r.git", a);
    expect(pickRepoShip(dir, undefined, () => false)).toEqual({ mode: "full" });
    git(dir, "remote", "set-url", "origin", "git@github.com:o/r.git");
    expect(pickRepoShip(dir, undefined, never)).toEqual({ mode: "full" });
    git(dir, "remote", "set-url", "origin", "https://tok@github.com/o/r.git");
    expect(pickRepoShip(dir, undefined, never)).toEqual({ mode: "full" });
    git(dir, "remote", "set-url", "origin", "https://github.com/o/r.git");
    git(dir, "checkout", "-q", "--detach");
    expect(pickRepoShip(dir, undefined, never)).toEqual({ mode: "full" });
  });
  test("probe script/parser", () => {
    const { dir, b } = macRepo();
    expect(parseBoxHead(runBox(dir, boxHeadScript(dir)).stdout)).toBe(b);
    expect(runBox(dir, boxHeadScript(join(dir, "nope"))).stdout).toBe("");
    expect(runBox(dir, boxHeadScript(`${dir}'; touch /tmp/x; '`)).status).toBe(0); // quoted
    expect(parseBoxHead("NOMO_BOX_HEAD=abc\n")).toBeUndefined();
    expect(parseBoxHead(`NOMO_BOX_HEAD=${"a".repeat(41)}`)).toBeUndefined();
  });
});

describe("box seed script (real git)", () => {
  /** A box checkout = clone of `mac` at `at`, on branch `cloud`, with uncommitted + untracked work. */
  function boxCopy(mac: string, at: string): string {
    const root = join(tmp("box"), "proj");
    execFileSync("git", ["clone", "-q", mac, root]);
    git(root, "checkout", "-q", "-b", "cloud", at);
    writeFileSync(join(root, "a.txt"), "box edit\n");
    writeFileSync(join(root, "box-only.txt"), "untracked\n");
    return root;
  }
  function bundle(mac: string, base: string): string {
    const f = join(tmp("bundle"), "repo.bundle");
    git(mac, "bundle", "create", "-q", f, `${base}..HEAD`);
    return f;
  }
  const bak = (root: string) => execFileSync("bash", ["-c", `ls -d '${root}'.nomo-bak-*`]).toString().trim();

  test("box mode: only base..HEAD travels; ROOT ends at the Mac HEAD; the box's own work is moved aside", () => {
    const { dir, a } = macRepo();
    const c = commit(dir, "c.txt", "c\n");
    const root = boxCopy(dir, a);
    const ship: RepoShip = { mode: "box", base: a, head: c };
    expect(newCommits(dir, a)).toBe(2);
    const f = bundle(dir, a);
    expect(git(dir, "bundle", "list-heads", f)).toContain("HEAD");
    expect(spawnSync("git", ["bundle", "verify", f], { cwd: root }).status).toBe(0); // the box copy holds its prerequisite
    const r = runBox(root, seedScript(ship, f));
    expect(r.status).toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(c);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(git(root, "remote", "get-url", "origin")).toBe(dir); // the box copy's origin is kept
    expect(readFileSync(join(bak(root), "a.txt"), "utf8")).toBe("box edit\n"); // not clobbered
    expect(existsSync(join(bak(root), "box-only.txt"))).toBe(true);
    expect(existsSync(`${root}.nomo-seed`)).toBe(false);
  });

  test("box mode, nothing new (box already at HEAD, even on another branch): no bundle at all", () => {
    const { dir, b } = macRepo();
    const root = boxCopy(dir, b);
    expect(newCommits(dir, b)).toBe(0);
    const r = runBox(root, seedScript({ mode: "box", base: b, head: b }, undefined));
    expect(r.status).toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(b);
  });

  test("box mode, box is detached at an old commit", () => {
    const { dir, a } = macRepo();
    const c = commit(dir, "c.txt", "c\n");
    const root = boxCopy(dir, a);
    git(root, "checkout", "-q", "--detach", a);
    expect(runBox(root, seedScript({ mode: "box", base: a, head: c }, bundle(dir, a))).status).toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(c);
  });

  test("bundle prerequisite missing on the box → exit SEED_FAILED, ROOT untouched, no seed left", () => {
    const { dir, a } = macRepo();
    const c = commit(dir, "c.txt", "c\n");
    const root = join(tmp("box"), "proj"); // an unrelated repo at ROOT (rewritten history)
    mkdirSync(root);
    git(root, "init", "-q");
    commit(root, "x.txt", "x\n");
    writeFileSync(join(root, "dirty.txt"), "keep me\n");
    const r = runBox(root, seedScript({ mode: "box", base: a, head: c }, bundle(dir, a)));
    expect(r.status).toBe(SEED_FAILED);
    expect(r.stdout).toContain("NOMO_SEED_FAILED");
    expect(readFileSync(join(root, "dirty.txt"), "utf8")).toBe("keep me\n");
    expect(existsSync(`${root}.nomo-seed`)).toBe(false);
    expect(execFileSync("bash", ["-c", `ls -d '${root}'.nomo-bak-* 2>/dev/null || true`]).toString()).toBe("");
  });

  test("clone mode (local fake remote): clone + unpushed commits; a failed clone → SEED_FAILED, ROOT untouched", () => {
    const { dir, b } = macRepo();
    const remote = join(tmp("remote"), "r.git");
    execFileSync("git", ["clone", "-q", "--bare", dir, remote]);
    const c = commit(dir, "c.txt", "c\n"); // unpushed
    const root = join(tmp("box"), "deep", "proj"); // a new box: ROOT and its parent don't exist
    const r = runBox(root, seedScript({ mode: "clone", url: remote, base: b, head: c }, bundle(dir, b)));
    expect(r.status).toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(c);
    expect(git(root, "remote", "get-url", "origin")).toBe(remote);

    const root2 = join(tmp("box"), "proj");
    mkdirSync(root2);
    writeFileSync(join(root2, "keep.txt"), "k\n");
    const bad = runBox(root2, seedScript({ mode: "clone", url: join(tmp("gone"), "nope.git"), base: b, head: c }, bundle(dir, b)));
    expect(bad.status).toBe(SEED_FAILED);
    expect(readFileSync(join(root2, "keep.txt"), "utf8")).toBe("k\n");
    expect(existsSync(`${root2}.nomo-seed`)).toBe(false);
  });

  test("clone script never carries a credential and disables prompts", () => {
    const s = seedScript({ mode: "clone", url: "https://github.com/o/r.git", base: "a".repeat(40), head: "b".repeat(40) }, undefined);
    expect(s).toContain("GIT_TERMINAL_PROMPT=0 git -c credential.helper=");
    expect(s).toContain("clone -q --no-checkout 'https://github.com/o/r.git'");
  });
});

describe("build() picks the path", () => {
  type Opts = NonNullable<Parameters<typeof build>[2]>;
  function plan(opts: (r: { dir: string; a: string; b: string }) => Opts) {
    const r = macRepo();
    const u = "00000000-0000-4000-8000-0000000000aa";
    const home = tmp("home"), out = tmp("out");
    const pd = join(home, ".claude", "projects", projectDirName(r.dir));
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, `${u}.jsonl`), JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } }) + "\n");
    const prev = { home: process.env.HOME, cwd: process.cwd() };
    process.env.HOME = home; process.chdir(r.dir);
    try { return { ...r, p: build(new Map([["--session", u]]), out, opts(r)) }; } finally { process.env.HOME = prev.home; process.chdir(prev.cwd); }
  }
  const bundleOf = (p: ReturnType<typeof build>) => Object.entries(p.artifacts).find(([k]) => k.endsWith("-repo.bundle"));

  test("no box head, no upstream → the full bundle, script as before", () => {
    const { p } = plan(() => ({}));
    expect(p.repoLine).toMatch(/^Repo: full bundle of HEAD \(\d/);
    const [box] = bundleOf(p)!;
    expect(p.script).toContain(`clone -q ${box} "$ROOT"`);
    expect(p.script).not.toContain("nomo-seed");
  });

  test("box head = HEAD → no bundle at all, seeded from the box copy", () => {
    const { p, b } = plan(({ b }) => ({ boxHead: b }));
    expect(p.repoLine).toBe(`Repo: the box already has ${b.slice(0, 8)}; sending 0 new commit(s) (nothing to send).`);
    expect(bundleOf(p)).toBeUndefined();
    expect(p.script).toContain(`git -C "$S" cat-file -e ${b}^{commit}`);
  });

  test("box head behind → bundle of base..HEAD only (its prerequisite is the box head)", () => {
    const { p, a, b, dir } = plan(({ a }) => ({ boxHead: a }));
    const [box, local] = bundleOf(p)!;
    expect(p.repoLine).toMatch(/sending 1 new commit\(s\)/);
    expect(git(dir, "bundle", "list-heads", local)).toContain(b);
    const v = spawnSync("git", ["bundle", "verify", local], { cwd: dir, encoding: "utf8" });
    expect(v.status).toBe(0);
    expect(v.stdout + v.stderr).toMatch(new RegExp(`requires.*\\n${a}`, "s")); // the one prerequisite: the box head
    expect(p.script).toContain(`bundle verify -q ${box}`);
    expect(p.script).toContain(`git fetch -q ${box}`);
  });

  test("public upstream → clone mode; full:true forces the full bundle", () => {
    const pub = plan(({ dir, a }) => { upstream(dir, "https://github.com/o/r.git", a); return { ls: () => true }; });
    expect(pub.p.repoLine).toMatch(/^Repo: the box clones https:\/\/github.com\/o\/r.git anonymously; sending 1 unpushed/);
    expect(pub.p.script).toContain("clone -q --no-checkout 'https://github.com/o/r.git'");
    const full = plan(({ dir, a }) => { upstream(dir, "https://github.com/o/r.git", a); return { boxHead: a, full: true, ls: never }; });
    expect(full.p.repoLine).toMatch(/^Repo: full bundle/);
  });
});
