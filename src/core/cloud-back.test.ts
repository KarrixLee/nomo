import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyInPlace, decideCode, extractTgz, type GitState, landFolder, landOnBranch, listFiles, macGitState, mergeMemory, patchPathsSafe,
  safeRel, sha256, transcriptAction, validateTree, wipFingerprint,
} from "./cloud-back";

const tmp = () => mkdtempSync(join(tmpdir(), "nomo-back-test-"));

beforeAll(() => {
  // Hermetic git: no user/system config (signing, hooksPath, templates) leaks into these repos.
  const cfg = join(tmp(), "gitconfig");
  writeFileSync(cfg, "[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

const g = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
function repo(): string {
  const d = tmp();
  g(d, "init", "-q");
  writeFileSync(join(d, "a.txt"), "one\n");
  writeFileSync(join(d, ".gitignore"), "ignored.txt\n");
  g(d, "add", ".");
  g(d, "commit", "-qm", "A");
  return d;
}
/** Every worktree file (minus .git) → sha, plus HEAD and status: "byte-identical" means this is equal. */
function worktreeState(d: string) {
  const files = Object.fromEntries(listFiles(d).filter((r) => !r.startsWith(".git/")).map((r) => [r, sha256(readFileSync(join(d, r)))]));
  return { files, head: g(d, "rev-parse", "HEAD"), branch: g(d, "rev-parse", "--abbrev-ref", "HEAD"), status: g(d, "status", "--porcelain") };
}

/** A box: a clone of `mac` that commits b.txt, edits a.txt (WIP) and adds untracked n.txt; packed like
 *  backPackScript does. */
function boxWork(mac: string, base: string, out: string) {
  const box = join(tmp(), "box");
  g(tmp(), "clone", "-q", mac, box);
  g(box, "checkout", "-q", base);
  g(box, "checkout", "-q", "-B", "main");
  writeFileSync(join(box, "b.txt"), "from the box\n");
  g(box, "add", "b.txt");
  g(box, "commit", "-qm", "box commit");
  writeFileSync(join(box, "a.txt"), "one\nbox edit\n");
  writeFileSync(join(box, "n.txt"), "new untracked\n");
  g(box, "bundle", "create", "-q", join(out, "repo.bundle"), `${base}..HEAD`);
  writeFileSync(join(out, "wip.patch"), execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: box }));
  execFileSync("tar", ["-czf", join(out, "untracked.tgz"), "n.txt"], { cwd: box });
  const udir = extractTgz(join(out, "untracked.tgz"), out);
  return { boxHead: g(box, "rev-parse", "HEAD"), udir, untracked: validateTree(udir).files };
}

describe("decideCode", () => {
  const s: GitState = { branch: "main", head: "h1", wipFp: "w1" };
  const work = { commits: 1, patchBytes: 10, untracked: 0, ff: true };
  test("box changed nothing → noop", () => {
    expect(decideCode(s, s, { commits: 0, patchBytes: 0, untracked: 0, ff: true })).toBe("noop");
    expect(decideCode(undefined, s, { commits: 0, patchBytes: 0, untracked: 0, ff: false })).toBe("noop");
  });
  test("Mac unchanged + fast-forward → apply in place", () => {
    expect(decideCode(s, { ...s }, work)).toBe("apply");
    expect(decideCode(s, { ...s }, { commits: 0, patchBytes: 0, untracked: 2, ff: true })).toBe("apply");
  });
  test("box rewrote history → branch", () => expect(decideCode(s, s, { ...work, ff: false })).toBe("branch"));
  test("Mac moved (branch, head or worktree) → branch", () => {
    expect(decideCode(s, { ...s, branch: "dev" }, work)).toBe("branch");
    expect(decideCode(s, { ...s, head: "h2" }, work)).toBe("branch");
    expect(decideCode(s, { ...s, wipFp: "w2" }, work)).toBe("branch");
  });
  test("no snapshot → branch", () => expect(decideCode(undefined, s, work)).toBe("branch"));
});

describe("wipFingerprint", () => {
  test("changes on an edit, a staging-only change and a new untracked file; not on an ignored one", () => {
    const d = repo();
    const fp0 = wipFingerprint(d);
    writeFileSync(join(d, "ignored.txt"), "x");
    expect(wipFingerprint(d)).toBe(fp0);
    writeFileSync(join(d, "a.txt"), "two\n");
    const fpEdit = wipFingerprint(d);
    expect(fpEdit).not.toBe(fp0);
    g(d, "add", "a.txt");
    writeFileSync(join(d, "a.txt"), "one\n"); // worktree == HEAD again, only the index differs
    expect(wipFingerprint(d)).not.toBe(fp0);
    g(d, "reset", "-q");
    expect(wipFingerprint(d)).toBe(fp0);
    writeFileSync(join(d, "new.txt"), "n");
    expect(wipFingerprint(d)).not.toBe(fp0);
  });
});

describe("transcriptAction", () => {
  const handed = Buffer.from('{"a":1}\n');
  const snap = { tBytes: handed.length, tSha: sha256(handed) };
  const boxed = Buffer.concat([handed, Buffer.from('{"b":2}\n')]);
  test("box extends; Mac as handed off or missing → replace", () => {
    expect(transcriptAction(snap, handed, boxed)).toBe("replace");
    expect(transcriptAction(snap, undefined, boxed)).toBe("replace");
  });
  test("box extends; Mac appended after handoff → fork", () => {
    expect(transcriptAction(snap, Buffer.concat([handed, Buffer.from('{"mac":1}\n')]), boxed)).toBe("fork");
  });
  test("box added nothing → same", () => expect(transcriptAction(snap, handed, handed)).toBe("same"));
  test("box does not start with the handed-off bytes → corrupt", () => {
    expect(transcriptAction(snap, handed, Buffer.from('{"x":1}\n{"b":2}\n'))).toBe("corrupt");
    expect(transcriptAction(snap, handed, Buffer.from("{"))).toBe("corrupt");
  });
  test("no snapshot: prefix → replace, else fork", () => {
    expect(transcriptAction(undefined, handed, boxed)).toBe("replace");
    expect(transcriptAction(undefined, Buffer.from('{"other":1}\n'), boxed)).toBe("fork");
    expect(transcriptAction(undefined, boxed, boxed)).toBe("same");
  });
});

describe("mergeMemory", () => {
  test("add / skip identical / take box when Mac unchanged / keep Mac on conflict; never deletes", () => {
    const box = tmp(), mac = tmp(), backup = tmp();
    const put = (d: string, n: string, c: string) => writeFileSync(join(d, n), c);
    put(box, "new.md", "box only");
    put(box, "same.md", "same"); put(mac, "same.md", "same");
    put(box, "upd.md", "box v2"); put(mac, "upd.md", "v1");
    put(box, "both.md", "box v2"); put(mac, "both.md", "mac v2");
    put(mac, "maconly.md", "keep me");
    const snap = { "upd.md": sha256("v1"), "both.md": sha256("v1"), "same.md": sha256("old") };
    const r = mergeMemory(snap, box, listFiles(box), mac, backup);
    expect(r).toEqual({ added: ["new.md"], updated: ["upd.md"], conflicts: ["both.md"] });
    expect(readFileSync(join(mac, "new.md"), "utf8")).toBe("box only");
    expect(readFileSync(join(mac, "upd.md"), "utf8")).toBe("box v2");
    expect(readFileSync(join(backup, "memory-before", "upd.md"), "utf8")).toBe("v1");
    expect(readFileSync(join(mac, "both.md"), "utf8")).toBe("mac v2");
    expect(readFileSync(join(backup, "memory-conflicts", "both.md"), "utf8")).toBe("box v2");
    expect(readFileSync(join(mac, "maconly.md"), "utf8")).toBe("keep me");
  });
});

describe("untrusted paths", () => {
  test("safeRel", () => {
    for (const bad of ["../x", "/x", "a/../../x", ".GIT/hooks/x", "a/.git/config", ".ssh/id", "a/.ssh/id", ".config/cc-status/config.json", ".claude/settings.json", ""]) {
      expect(safeRel(bad)).toBe(false);
    }
    for (const ok of ["src/a.ts", ".github/workflows/x.yml", "a.gitignore", "docs/.gitkeep"]) expect(safeRel(ok)).toBe(true);
  });
  test("patchPathsSafe rejects a patch into .git", () => {
    expect(patchPathsSafe("diff --git a/src/x b/src/x\n")).toBe(true);
    expect(patchPathsSafe("diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit\n")).toBe(false);
    expect(patchPathsSafe("diff --git a/x b/x\nrename from x\nrename to ../y\n")).toBe(false);
  });
  test("validateTree skips a symlink to /etc and hardlinks, keeps regular files", () => {
    const d = tmp();
    writeFileSync(join(d, "ok.txt"), "ok");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "deep.txt"), "deep");
    symlinkSync("/etc", join(d, "etc"));
    symlinkSync("/etc/hosts", join(d, "sub", "hosts"));
    writeFileSync(join(d, "h1"), "h");
    linkSync(join(d, "h1"), join(d, "h2"));
    const r = validateTree(d);
    expect(r.files.sort()).toEqual(["ok.txt", "sub/deep.txt"]);
    expect(r.skipped.sort()).toEqual(["etc", "h1", "h2", "sub/hosts"]);
  });
  test("extractTgz never writes outside its fresh dir (.. entries, a file through a symlink)", () => {
    const parent = tmp(), victim = tmp(), tgz = join(tmp(), "evil.tgz");
    execFileSync("python3", ["-I", "-c", `
import io, sys, tarfile
t = tarfile.open(sys.argv[1], "w:gz")
def f(name, data=b"x"):
    i = tarfile.TarInfo(name); i.size = len(data); t.addfile(i, io.BytesIO(data))
f("../escaped")
l = tarfile.TarInfo("link"); l.type = tarfile.SYMTYPE; l.linkname = sys.argv[2]; t.addfile(l)
f("link/through")
f("fine.txt")
t.close()`, tgz, victim]);
    let dir: string | undefined;
    try { dir = extractTgz(tgz, parent); } catch { /* refusing the whole tar is fine too */ }
    expect(existsSync(join(parent, "escaped"))).toBe(false);
    expect(existsSync(join(victim, "through"))).toBe(false);
    if (dir) expect(validateTree(dir).files).toEqual(["fine.txt"]);
  });

  test("an allow-list limits what a tar may carry", () => {
    const d = tmp();
    writeFileSync(join(d, "u.jsonl"), "{}");
    writeFileSync(join(d, "evil.sh"), "x");
    expect(validateTree(d, (r) => r === "u.jsonl")).toEqual({ files: ["u.jsonl"], skipped: ["evil.sh"] });
  });
});

describe("landing code", () => {
  test("applyInPlace: stash, fast-forward, WIP, untracked; the user's post-merge hook never runs", () => {
    const mac = repo();
    const base = g(mac, "rev-parse", "HEAD");
    writeFileSync(join(mac, "a.txt"), "one\nmac wip\n");
    writeFileSync(join(mac, "u.txt"), "mac untracked\n");
    const marker = join(tmp(), "hook-ran");
    writeFileSync(join(mac, ".git", "hooks", "post-merge"), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(mac, ".git", "hooks", "post-merge"), 0o755);
    const snap = macGitState(mac);
    const out = tmp();
    const box = boxWork(mac, base, out);
    expect(decideCode(snap, macGitState(mac), { commits: 1, patchBytes: 1, untracked: box.untracked.length, ff: true })).toBe("apply");

    const r = applyInPlace(mac, { bundle: join(out, "repo.bundle"), patch: join(out, "wip.patch"), untrackedDir: box.udir, untracked: box.untracked, boxHead: box.boxHead }, false, "abcd1234", out);
    expect(g(mac, "rev-parse", "HEAD")).toBe(box.boxHead);
    expect(g(mac, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(mac, "a.txt"), "utf8")).toBe("one\nbox edit\n");
    expect(readFileSync(join(mac, "n.txt"), "utf8")).toBe("new untracked\n");
    expect(r.stash).toMatch(/^[0-9a-f]{40}$/);
    expect(g(mac, "stash", "list")).toContain("nomo: before cloud return abcd1234");
    expect(existsSync(marker)).toBe(false);
  });

  test("applyInPlace on a clean Mac makes no stash", () => {
    const mac = repo();
    const base = g(mac, "rev-parse", "HEAD");
    const out = tmp();
    const box = boxWork(mac, base, out);
    const r = applyInPlace(mac, { bundle: join(out, "repo.bundle"), patch: join(out, "wip.patch"), untrackedDir: box.udir, untracked: box.untracked, boxHead: box.boxHead }, false, "abcd1234", out);
    expect(r.stash).toBeUndefined();
    expect(g(mac, "stash", "list")).toBe("");
  });

  test("landOnBranch leaves the Mac worktree byte-identical", () => {
    const mac = repo();
    const base = g(mac, "rev-parse", "HEAD");
    const out = tmp();
    const box = boxWork(mac, base, out);
    writeFileSync(join(mac, "a.txt"), "mac moved on\n");
    g(mac, "commit", "-qam", "mac commit");
    writeFileSync(join(mac, "dirty.txt"), "mac dirty\n");
    const before = worktreeState(mac);
    const art = { bundle: join(out, "repo.bundle"), patch: join(out, "wip.patch"), untrackedDir: box.udir, untracked: box.untracked, boxHead: box.boxHead };

    const name = landOnBranch(mac, art, "abcd1234", out);
    expect(name).toBe("nomo/cloud-abcd1234");
    expect(worktreeState(mac)).toEqual(before);
    expect(g(mac, "rev-parse", `${name}^`)).toBe(box.boxHead);
    expect(g(mac, "show", `${name}:a.txt`)).toBe("one\nbox edit");
    expect(g(mac, "show", `${name}:n.txt`)).toBe("new untracked");
    expect(g(mac, "show", `${name}:b.txt`)).toBe("from the box");
    expect(landOnBranch(mac, art, "abcd1234", out)).toBe("nomo/cloud-abcd1234-2");
    expect(worktreeState(mac)).toEqual(before);
  });

  test("landOnBranch with no box commits branches at the box HEAD", () => {
    const mac = repo();
    const head = g(mac, "rev-parse", "HEAD");
    const name = landOnBranch(mac, { untracked: [], boxHead: head }, "abcd1234", tmp());
    expect(g(mac, "rev-parse", name)).toBe(head);
  });

  test("landFolder writes a sibling, never the original", () => {
    const parent = tmp(), cwd = join(parent, "proj"), src = tmp();
    mkdirSync(cwd);
    writeFileSync(join(cwd, "x"), "mine");
    writeFileSync(join(src, "x"), "box");
    const dst = landFolder(cwd, src, ["x"], "abcd1234");
    expect(dst).toBe(`${cwd}.nomo-cloud-abcd1234`);
    expect(readFileSync(join(dst, "x"), "utf8")).toBe("box");
    expect(readFileSync(join(cwd, "x"), "utf8")).toBe("mine");
    expect(landFolder(cwd, src, ["x"], "abcd1234")).toBe(`${cwd}.nomo-cloud-abcd1234-2`);
  });
});
