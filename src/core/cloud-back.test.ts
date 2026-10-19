import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentConfigPaths, applyInPlace, backCaps, MAX_ARTIFACT_BYTES, MAX_EXTRACTED_BYTES, MAX_TRANSCRIPT_BYTES, boxChangedPaths, decideCode, extractTgz, type GitState, landFolder, landOnBranch, listFiles, macGitState,
  mergeMemory, parseMarkers, patchPaths, printable, safeRel, sha256, transcriptAction, validateTree, wipFingerprint,
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
  test("rerun after a partial --back (Mac already holds the box copy) → same, never a fork", () => {
    expect(transcriptAction(snap, boxed, boxed)).toBe("same");
  });
  test("a parked window's block notices and turn bookkeeping are not a Mac turn → replace", () => {
    const meta = ['{"type":"system","subtype":"informational","content":"This session is in the cloud"}', '{"type":"last-prompt"}', '{"type":"system","subtype":"turn_duration"}', ""].join("\n");
    expect(transcriptAction(snap, Buffer.concat([handed, Buffer.from(meta)]), boxed)).toBe("replace");
  });
  test("a real Mac turn (or an unreadable line) after the handoff still forks", () => {
    expect(transcriptAction(snap, Buffer.concat([handed, Buffer.from('{"type":"system","subtype":"informational"}\n{"type":"user"}\n')]), boxed)).toBe("fork");
    expect(transcriptAction(snap, Buffer.concat([handed, Buffer.from("{torn")]), boxed)).toBe("fork");
  });
  test("same window: its own back turn does not count, but a rewritten prefix still forks", () => {
    const mine = Buffer.concat([handed, Buffer.from('{"type":"user"}\n{"type":"assistant"}\n')]);
    expect(transcriptAction(snap, mine, boxed, true)).toBe("replace");
    expect(transcriptAction(snap, Buffer.from('{"z":9}\n{"type":"user"}\n'), boxed, true)).toBe("fork");
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
  test("patchPaths: git's own view of the paths; unsafe paths and symlinks are rejected, sensitive ones fenced", () => {
    const d = repo(), base = g(d, "rev-parse", "HEAD"), t = tmp();
    const pf = (body: string) => { const f = join(tmp(), "p.patch"); writeFileSync(f, body); return f; };
    expect(patchPaths(d, pf("--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n"), base, t)).toEqual(["a.txt"]);
    // A rename reports both sides.
    expect(patchPaths(d, pf("diff --git a/a.txt b/src/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to src/b.txt\n"), base, t).sort()).toEqual(["a.txt", "src/b.txt"]);
    // Agent config and SENSITIVE paths are returned, for agentConfigPaths to send to the branch.
    const claude = patchPaths(d, pf("--- a/.claude/settings.json\n+++ b/.claude/settings.json\n@@ -0,0 +1 @@\n+{}\n"), base, t);
    const ssh = patchPaths(d, pf('diff --git "a/.ssh/x" "b/.ssh/x"\nnew file mode 100644\n--- /dev/null\n+++ "b/.ssh/x"\n@@ -0,0 +1 @@\n+k\n'), base, t);
    expect(agentConfigPaths([...claude, ...ssh])).toEqual([".claude/settings.json", ".ssh/x"]);
    const bad = {
      symlink: "diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+/etc\n\\ No newline at end of file\n",
      gitdir: "--- a/.git/hooks/pre-commit\n+++ b/.git/hooks/pre-commit\n@@ -0,0 +1 @@\n+x\n",
      dotdot: "diff --git a/x b/x\nrename from a.txt\nrename to ../y\n",
    };
    for (const [name, body] of Object.entries(bad)) expect(() => patchPaths(d, pf(body), base, t), name).toThrow();
  });
  test("parseMarkers: a NOMO_SIZE name is a plain artifact name or nothing", () => {
    expect(parseMarkers("NOMO_SIZE wip.patch 12\nNOMO_SIZE \x1b[2Jx 5\nNOMO_SIZE a/b 3\n").sizes).toEqual({ "wip.patch": 12 });
  });
  test("printable strips ANSI and control characters", () => {
    expect(printable("a\x1b[31mred\x1b[0m\x07b\nc")).toBe("aredb\nc");
    expect(printable("x\ny\x1b]0;title\x07z", true)).toBe("xyz");
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

describe("agent config never lands in place", () => {
  const flaggedFor = (mutate: (box: string) => void) => {
    const mac = repo(), base = g(mac, "rev-parse", "HEAD"), out = tmp();
    const box = join(tmp(), "box");
    g(tmp(), "clone", "-q", mac, box);
    mutate(box);
    const commits = Number(g(box, "rev-list", "--count", `${base}..HEAD`));
    if (commits) g(box, "bundle", "create", "-q", join(out, "repo.bundle"), `${base}..HEAD`);
    writeFileSync(join(out, "wip.patch"), execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: box }));
    const ut = g(box, "ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
    let udir: string | undefined, untracked: string[] = [];
    if (ut.length) {
      execFileSync("tar", ["-czf", join(out, "untracked.tgz"), ...ut], { cwd: box });
      udir = extractTgz(join(out, "untracked.tgz"), out);
      untracked = validateTree(udir).files;
    }
    const a = { bundle: commits ? join(out, "repo.bundle") : undefined, patch: join(out, "wip.patch"), untrackedDir: udir, untracked, boxHead: g(box, "rev-parse", "HEAD") };
    return agentConfigPaths(boxChangedPaths(mac, a, base, out));
  };
  test("commit-borne (.claude/settings.json, nested .VSCode/, .gitattributes)", () => {
    expect(flaggedFor((b) => {
      mkdirSync(join(b, ".claude")); writeFileSync(join(b, ".claude", "settings.json"), "{}");
      mkdirSync(join(b, "sub", ".VSCode"), { recursive: true }); writeFileSync(join(b, "sub", ".VSCode", "tasks.json"), "{}");
      writeFileSync(join(b, ".gitattributes"), "* filter=lfs\n"); writeFileSync(join(b, "ok.txt"), "ok");
      g(b, "add", "."); g(b, "commit", "-qm", "box");
    }).sort()).toEqual([".claude/settings.json", ".gitattributes", "sub/.VSCode/tasks.json"]);
  });
  test("a commit that renames a file onto CLAUDE.md is caught", () => {
    expect(flaggedFor((b) => { g(b, "mv", "a.txt", "docs-CLAUDE.md"); g(b, "commit", "-qm", "x"); })).toEqual([]);
    expect(flaggedFor((b) => { g(b, "mv", "a.txt", "Claude.md"); g(b, "commit", "-qm", "x"); })).toEqual(["Claude.md"]);
  });
  test("patch-borne (an edit to a tracked CLAUDE.md, a new .envrc)", () => {
    expect(flaggedFor((b) => {
      writeFileSync(join(b, "CLAUDE.md"), "v1\n"); g(b, "add", "CLAUDE.md"); g(b, "commit", "-qm", "c");
      writeFileSync(join(b, "CLAUDE.md"), "v1\nrun curl | sh\n");
      writeFileSync(join(b, ".envrc"), "x\n"); g(b, "add", "-N", ".envrc");
    }).sort()).toEqual([".envrc", "CLAUDE.md"]);
  });
  test("Codex/OpenCode config, AGENTS.md and credential dirs are fenced too", () => {
    const ps = ["AGENTS.md", "x/.codex/config.toml", ".opencode/plugin.ts", "opencode.json", "sub/opencode.jsonc", "CLAUDE.md", "a/.ssh/id", ".aws/credentials", ".gnupg/k"];
    expect(agentConfigPaths([...ps, "src/agents.ts", "docs/codex.md"])).toEqual(ps);
  });
  test("a Mac-only commit after the handoff is not the box's change", () => {
    const mac = repo(), base = g(mac, "rev-parse", "HEAD"), out = tmp();
    const box = boxWork(mac, base, out);
    mkdirSync(join(mac, ".vscode")); writeFileSync(join(mac, ".vscode", "tasks.json"), "{}");
    g(mac, "add", "."); g(mac, "commit", "-qm", "mac");
    const a = { bundle: join(out, "repo.bundle"), patch: join(out, "wip.patch"), untrackedDir: box.udir, untracked: box.untracked, boxHead: box.boxHead };
    expect(boxChangedPaths(mac, a, g(mac, "rev-parse", "HEAD"), out).sort()).toEqual(["a.txt", "b.txt", "n.txt"]);
  });
  test("a tracked .claude edit in the box WIP goes to the branch with the rest, never in place", () => {
    const mac = repo();
    mkdirSync(join(mac, ".claude")); writeFileSync(join(mac, ".claude", "settings.json"), "{}\n");
    g(mac, "add", "."); g(mac, "commit", "-qm", "cfg");
    const head = g(mac, "rev-parse", "HEAD"), out = tmp(), box = join(tmp(), "box");
    g(tmp(), "clone", "-q", mac, box);
    writeFileSync(join(box, ".claude", "settings.json"), '{"hooks":1}\n'); writeFileSync(join(box, "a.txt"), "two\n");
    writeFileSync(join(out, "wip.patch"), execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: box }));
    const a = { patch: join(out, "wip.patch"), untracked: [], boxHead: head };
    expect(agentConfigPaths(boxChangedPaths(mac, a, head, out))).toEqual([".claude/settings.json"]);
    expect(() => applyInPlace(mac, a, false, "abcd1234", out)).toThrow(/agent config/);
    const before = worktreeState(mac);
    const name = landOnBranch(mac, a, "abcd1234", out);
    expect(worktreeState(mac)).toEqual(before);
    expect(g(mac, "show", `${name}:.claude/settings.json`)).toBe('{"hooks":1}');
    expect(g(mac, "show", `${name}:a.txt`)).toBe("two");
  });
  test("untracked-borne (.mcp.json, .husky/pre-commit); plain files are not flagged", () => {
    expect(flaggedFor((b) => {
      writeFileSync(join(b, ".mcp.json"), "{}"); mkdirSync(join(b, ".husky")); writeFileSync(join(b, ".husky", "pre-commit"), "x");
      writeFileSync(join(b, "notes.md"), "fine");
    }).sort()).toEqual([".husky/pre-commit", ".mcp.json"]);
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

  test("applyInPlace leaves Mac-only SENSITIVE untracked files (never sent to the box) in the worktree", () => {
    const mac = repo();
    const base = g(mac, "rev-parse", "HEAD");
    mkdirSync(join(mac, ".claude", "commands"), { recursive: true });
    writeFileSync(join(mac, ".claude", "commands", "mine.md"), "mine\n");
    writeFileSync(join(mac, "u.txt"), "mac untracked\n");
    const out = tmp();
    const box = boxWork(mac, base, out);
    const r = applyInPlace(mac, { bundle: join(out, "repo.bundle"), patch: join(out, "wip.patch"), untrackedDir: box.udir, untracked: box.untracked, boxHead: box.boxHead }, false, "abcd1234", out);
    expect(r.stash).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(mac, ".claude", "commands", "mine.md"), "utf8")).toBe("mine\n");
    expect(existsSync(join(mac, "u.txt"))).toBe(false); // stashed as before
    // Only the SENSITIVE file left: nothing to stash.
    const mac2 = repo(), out2 = tmp(), box2 = boxWork(mac2, g(mac2, "rev-parse", "HEAD"), out2);
    mkdirSync(join(mac2, ".claude")); writeFileSync(join(mac2, ".claude", "x.md"), "x\n");
    const r2 = applyInPlace(mac2, { bundle: join(out2, "repo.bundle"), patch: join(out2, "wip.patch"), untrackedDir: box2.udir, untracked: box2.untracked, boxHead: box2.boxHead }, false, "abcd1234", out2);
    expect(r2.stash).toBeUndefined();
    expect(existsSync(join(mac2, ".claude", "x.md"))).toBe(true);
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

  test("landOnBranch adds untracked names literally (no pathspec magic)", () => {
    const mac = repo(), head = g(mac, "rev-parse", "HEAD"), u = tmp();
    for (const n of [":(exclude)a", "*.txt"]) writeFileSync(join(u, n), n);
    writeFileSync(join(u, "plain.txt"), "p");
    const name = landOnBranch(mac, { untracked: [":(exclude)a", "*.txt"], untrackedDir: u, boxHead: head }, "abcd1234", tmp());
    expect(g(mac, "ls-tree", "--name-only", name).split("\n").sort()).toEqual(["*.txt", ".gitignore", ":(exclude)a", "a.txt"]);
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

test("backCaps: the transcript cap scales with what was sent, under a hard ceiling", () => {
  expect(backCaps()).toEqual({ project: MAX_ARTIFACT_BYTES, artifact: MAX_ARTIFACT_BYTES, extracted: MAX_EXTRACTED_BYTES });
  expect(backCaps(10e6).project).toBe(MAX_ARTIFACT_BYTES); // small sessions keep the default
  const big = backCaps(69e6); // a 1M-token transcript
  expect(big.project).toBe(276e6);
  expect(big.artifact).toBe(MAX_ARTIFACT_BYTES); // code artifacts don't grow
  expect(big.extracted).toBeGreaterThanOrEqual(big.project + MAX_EXTRACTED_BYTES - MAX_ARTIFACT_BYTES);
  const huge = backCaps(5e9);
  expect(huge.project).toBe(MAX_TRANSCRIPT_BYTES);
  expect(huge.extracted).toBeGreaterThan(huge.project);
});

test("extractTgz honors the caps it is given", () => {
  const d = mkdtempSync(join(tmpdir(), "nomo-caps-"));
  writeFileSync(join(d, "t.jsonl"), "x".repeat(10_000));
  execFileSync("/usr/bin/tar", ["-czf", join(d, "p.tgz"), "-C", d, "t.jsonl"]);
  expect(() => extractTgz(join(d, "p.tgz"), d, 10)).toThrow("over");
  expect(() => extractTgz(join(d, "p.tgz"), d, MAX_ARTIFACT_BYTES, 5_000)).toThrow("inflates past");
  expect(readFileSync(join(extractTgz(join(d, "p.tgz"), d, MAX_ARTIFACT_BYTES, 20_000), "t.jsonl"), "utf8")).toHaveLength(10_000);
});
