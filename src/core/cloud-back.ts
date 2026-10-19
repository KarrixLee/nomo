// cloud-back — NOM-77 P2: the Mac half of `handoff --back`, bringing a cloud session home. Pure
// decisions (decideCode / transcriptAction / boxIdle) plus the steps that touch the Mac (mergeMemory,
// applyInPlace, landOnBranch, landFolder). handoff.ts drives the box; this file never talks to it.
//
// TRUST: everything pulled from the box is UNTRUSTED. A tar is extracted into a fresh empty temp dir
// and only then walked (validateTree: lstat, regular files + dirs only, safeRel on every path);
// files are copied out with modes masked to 0644/0755 after a realpath containment check. Git runs
// with hooks disabled, a bundle is verified before it is fetched, and `git apply` never gets
// --unsafe-paths. No box code ever runs here.
//
// NEVER: `reset --hard`, `clean`, deleting a Mac-only file, or editing transcript bytes. An in-place
// apply that fails stops and prints the exact recovery instead.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

/** Per-artifact compressed cap (== handoff's MAX_ARTIFACT_BYTES) and the extracted total across all tars. */
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
/** The transcript cap's hard ceiling, however big the session was: a hostile box still can't fill the Mac.
 *  ponytail: 512 MB because --back pulls each artifact as ONE base64 JSON string held in memory (~5x RSS;
 *  a 1.7 GB one overflows bun's max string). Raise it only with a streaming download to disk. */
export const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;

/** --back's caps for one session. project.tgz (transcript + memory) may grow to 4x the transcript handoff
 *  sent (never under the default cap, never over the ceiling), so a big session that kept going on the box
 *  can always come back; the extracted total grows with it. Code artifacts keep the default cap. */
export function backCaps(sentTranscriptBytes = 0): { project: number; artifact: number; extracted: number } {
  const project = Math.min(MAX_TRANSCRIPT_BYTES, Math.max(MAX_ARTIFACT_BYTES, 4 * sentTranscriptBytes));
  return { project, artifact: MAX_ARTIFACT_BYTES, extracted: MAX_EXTRACTED_BYTES + project - MAX_ARTIFACT_BYTES };
}
/** == handoff.ts SENSITIVE (not imported: entries must not be imported by core). */
const SENSITIVE = [".claude", ".config/cc-status", ".ssh", ".gnupg", ".aws", "Library/Keychains"];

/** What cloud.json remembers about a session at handoff time, so `--back` can tell what changed. */
export interface Snapshot {
  cwd: string;
  root: string;
  git: boolean;
  branch?: string;
  head?: string;
  wipFp?: string;
  tBytes: number;
  tSha: string;
  memory: Record<string, string>; // memory/<rel> -> sha256
  at: number;
}

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Every git call on the Mac: the user's hooks never run on box-made content, and no LFS filter (a
 *  box-planted .gitattributes) ever runs a smudge/process command. */
export const git = (root: string, args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false", ...args,
  ], {
    cwd: root, env: { ...(env ?? process.env), GIT_LFS_SKIP_SMUDGE: "1" }, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"],
  }).toString();

/** Box-derived text made safe to print: ANSI escapes and control characters gone (newlines and tabs
 *  kept unless `oneLine`). */
export const printable = (s: string, oneLine = false) =>
  s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P^_X][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(oneLine ? /[\x00-\x1f\x7f-\x9f]/g : /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** A fingerprint of the working tree vs HEAD, READ-ONLY: `git diff --binary HEAD` (worktree), the
 *  staged diff (so a staging-only change shows), and each untracked non-ignored file's content hash. */
export function wipFingerprint(root: string): string {
  const ro = ["--no-optional-locks"];
  const h = createHash("sha256");
  h.update(git(root, [...ro, "diff", "--binary", "HEAD"]));
  h.update("\0staged\0");
  h.update(git(root, [...ro, "diff", "--cached", "--binary", "HEAD"]));
  const untracked = git(root, [...ro, "ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  for (const p of untracked) {
    let c: string;
    try { c = sha256(readFileSync(join(root, p))); } catch { c = "unreadable"; }
    h.update(`\0${p}\0${c}`);
  }
  return h.digest("hex");
}

/** Every regular file under `dir` as a path relative to it (missing dir → none). */
export function listFiles(dir: string, rel = ""): string[] {
  const abs = join(dir, rel);
  if (!lstatSync(abs, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(abs).flatMap((n) => {
    const r = rel ? join(rel, n) : n;
    const st = lstatSync(join(dir, r));
    return st.isDirectory() ? listFiles(dir, r) : st.isFile() ? [r] : [];
  });
}

/** The Mac's state of the session at handoff (handoff.ts build()). */
export function takeSnapshot(cwd: string, root: string, isGit: boolean, projDir: string, transcript: Buffer): Snapshot {
  const memDir = join(projDir, "memory");
  const memory = Object.fromEntries(listFiles(memDir).map((r) => [r, sha256(readFileSync(join(memDir, r)))]));
  const snap: Snapshot = { cwd, root, git: isGit, tBytes: transcript.length, tSha: sha256(transcript), memory, at: Date.now() };
  if (isGit) Object.assign(snap, macGitState(root));
  return snap;
}

export interface GitState { branch?: string; head?: string; wipFp?: string }

export function macGitState(root: string): GitState {
  return {
    branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    wipFp: wipFingerprint(root),
  };
}

// ------------------------------------------------------------------------------------- decisions

export interface BoxCode { commits: number; patchBytes: number; untracked: number; ff: boolean }
export type CodeAction = "noop" | "apply" | "branch";

/** noop: the box changed nothing. apply: the Mac is exactly as it was at handoff and the box only
 *  built on top (fast-forward) → land in place. branch: anything else → `nomo/cloud-<id8>`, the Mac
 *  checkout untouched. */
export function decideCode(snap: GitState | undefined, mac: GitState, box: BoxCode): CodeAction {
  if (box.commits === 0 && box.patchBytes === 0 && box.untracked === 0) return "noop";
  if (!snap || !box.ff) return "branch";
  const same = snap.branch === mac.branch && snap.head === mac.head && snap.wipFp === mac.wipFp;
  return same ? "apply" : "branch";
}

export type TranscriptAction = "corrupt" | "same" | "replace" | "fork";

/** Lines a parked Mac window appends after the handoff without the conversation moving on: block notices
 *  (system/informational), turn bookkeeping, titles. Anything unparseable, untyped, or a user/assistant/
 *  attachment line is a real Mac turn. */
export function onlyMeta(appended: string): boolean {
  return appended.split("\n").filter((l) => l.trim()).every((l) => {
    try {
      const t = JSON.parse(l)?.type;
      return typeof t === "string" && t !== "user" && t !== "assistant" && t !== "attachment";
    } catch { return false; }
  });
}

/** corrupt: the box copy does not extend what was handed off (keep it in the backup only). same: the
 *  box added nothing. replace: the Mac copy is the handed-off one (or missing, or only meta was appended;
 *  or `sameWindow`: the back runs in the parked window itself, whose own turns are its back command) →
 *  install the box copy. fork: the Mac appended a real turn after the handoff → install the box copy
 *  under a NEW id, Mac copy untouched. */
export function transcriptAction(snap: { tBytes: number; tSha: string } | undefined, mac: Buffer | undefined, box: Buffer, sameWindow = false): TranscriptAction {
  if (snap) {
    // A rerun after a partial --back already installed this exact copy: nothing to do, never a fork.
    if (mac?.equals(box)) return "same";
    if (box.length < snap.tBytes || sha256(box.subarray(0, snap.tBytes)) !== snap.tSha) return "corrupt";
    if (box.length === snap.tBytes) return "same";
    if (!mac) return "replace";
    const macHanded = mac.length >= snap.tBytes && sha256(mac.subarray(0, snap.tBytes)) === snap.tSha;
    if (macHanded && (sameWindow || onlyMeta(mac.subarray(snap.tBytes).toString("utf8")))) return "replace";
    return "fork";
  }
  if (!mac) return "replace";
  if (box.equals(mac)) return "same";
  return box.length > mac.length && box.subarray(0, mac.length).equals(mac) ? "replace" : "fork";
}

export type Idle = "idle" | "attention" | "busy";

/** Is the box session at a turn boundary? Nomo's own record wins (done idle, needsAttention
 *  is a question only the user can answer); without one, the transcript must end in an `end_turn`
 *  assistant line followed only by non-conversation meta, and have been quiet for 15s. `tail` is the
 *  file's last 64 KiB, so its first line may be torn. */
export function boxIdle(o: { lastEvent?: string; tail: string; quietS: number }): Idle {
  if (o.lastEvent === "done") return "idle";
  if (o.lastEvent === "needsAttention") return "attention";
  // sessionStart alone proves nothing: a compact's SessionStart fires mid-turn. Ask the transcript.
  if (o.lastEvent && o.lastEvent !== "sessionStart") return "busy";
  const rows: any[] = [];
  for (const line of o.tail.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* the torn first (or last) line */ }
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = rows[i]?.type;
    if (t === "user") return "busy";
    if (t !== "assistant") continue;
    return rows[i]?.message?.stop_reason === "end_turn" && o.quietS >= 15 ? "idle" : "busy";
  }
  return "busy";
}

/** NOMO_KEY=value lines (and NOMO_SIZE <name> <bytes>) out of a box script's stdout. */
export function parseMarkers(stdout: string): { m: Record<string, string>; sizes: Record<string, number> } {
  const m: Record<string, string> = {}, sizes: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const kv = line.match(/^NOMO_([A-Z]+)=(.*)$/);
    if (kv) m[kv[1]] = kv[2].trim();
    const sz = line.match(/^NOMO_SIZE ([a-z.]+) (\d+)$/);
    if (sz) sizes[sz[1]] = Number(sz[2]);
  }
  return { m, sizes };
}

// -------------------------------------------------------------------------------------- untrusted

/** Not absolute, no `..`, no `.git` segment (any case — the Mac's filesystem folds it). */
function plainRel(rel: string): boolean {
  if (!rel || isAbsolute(rel) || rel.includes("\0") || rel.includes("\\")) return false;
  const segs = rel.split("/").filter((s) => s !== "" && s !== ".");
  return segs.length > 0 && !segs.some((s) => s === ".." || s.toLowerCase() === ".git");
}

/** Under SENSITIVE at ANY depth, as the handoff tar's `--exclude` matched it (a/.ssh/id too). */
function sensitive(rel: string): boolean {
  const segs = rel.toLowerCase().split("/").filter((s) => s !== "" && s !== ".");
  return segs.some((_, i) => {
    const sub = segs.slice(i).join("/");
    return SENSITIVE.some((p) => sub === p.toLowerCase() || sub.startsWith(p.toLowerCase() + "/"));
  });
}

/** A box-supplied relative path we may write: plainRel and nothing under SENSITIVE. */
export const safeRel = (rel: string) => plainRel(rel) && !sensitive(rel);

/** Walk an extracted tree with lstat: regular files (single link) and dirs only. Anything else, an
 *  unsafe path, or a path the allow-list rejects is skipped and reported. Throws past the size cap. */
export function validateTree(dir: string, allow: (rel: string) => boolean = () => true, budget = { left: MAX_EXTRACTED_BYTES }): { files: string[]; skipped: string[] } {
  const files: string[] = [], skipped: string[] = [];
  const walk = (rel: string): void => {
    for (const n of readdirSync(join(dir, rel))) {
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(join(dir, r));
      if (!safeRel(r) || !allow(r)) { skipped.push(r); continue; }
      if (st.isDirectory()) { walk(r); continue; }
      if (!st.isFile() || st.nlink > 1) { skipped.push(r); continue; }
      if ((budget.left -= st.size) < 0) throw new Error("box artifacts exceed the extracted-size cap");
      files.push(r);
    }
  };
  walk("");
  return { files, skipped };
}

/** Extract a box .tgz into a FRESH empty dir under `parent`, after proving it inflates under the cap
 *  (streamed, so a gzip bomb never touches the disk). Returns the dir. */
export function extractTgz(tgz: string, parent: string, maxBytes = MAX_ARTIFACT_BYTES, maxInflated = MAX_EXTRACTED_BYTES): string {
  if (lstatSync(tgz).size > maxBytes) throw new Error(`${tgz} is over ${(maxBytes / 1e6).toFixed(0)} MB`);
  const n = Number(execFileSync("sh", ["-c", `gzip -dc < "$1" | head -c ${maxInflated + 1} | wc -c`, "sh", tgz]).toString().trim());
  if (!(n <= maxInflated)) throw new Error(`${tgz} inflates past ${(maxInflated / 2 ** 30).toFixed(1)} GB`);
  const out = mkdtempSync(join(parent, "x-"));
  // /usr/bin/tar (bsdtar): its own refusal of ../ and through-symlink entries, whatever is on PATH.
  execFileSync("/usr/bin/tar", ["-xzf", tgz, "-C", out, "--no-same-owner", "--no-same-permissions"], { stdio: ["ignore", "ignore", "pipe"] });
  return out;
}

/** Copy one validated file to `dst`, never through a symlink out of `dstRoot`, mode masked (0644/0755,
 *  or 0600 for `priv` files: transcripts, memory, backups). False when it was skipped. */
export function copyContained(src: string, dstRoot: string, rel: string, overwrite: boolean, priv = false): boolean {
  if (!safeRel(rel)) return false;
  const dst = join(dstRoot, rel);
  let anc = dirname(dst);
  while (!existsSync(anc)) anc = dirname(anc);
  const realRoot = realpathSync(dstRoot);
  const realAnc = realpathSync(anc);
  if (realAnc !== realRoot && !realAnc.startsWith(realRoot + sep)) throw new Error(`refusing to write ${rel}: it resolves outside ${dstRoot}`);
  const there = lstatSync(dst, { throwIfNoEntry: false });
  if (there && (!overwrite || !there.isFile())) return false;
  mkdirSync(dirname(dst), { recursive: true });
  const exec = (lstatSync(src).mode & 0o111) !== 0;
  copyFileSync(src, dst);
  chmodSync(dst, priv ? 0o600 : exec ? 0o755 : 0o644);
  return true;
}

/** Every path a box patch changes, as git ITSELF applies it (no parsing of our own): applied to a
 *  throwaway index of `base`, then a raw, rename-free diff of that index (both sides of a rename, every
 *  new mode). Throws when a path is unsafe (absolute, `..`, `.git`) or the patch creates or edits a
 *  symlink. Agent-config and SENSITIVE paths come back like any other: agentConfigPaths fences them. */
export function patchPaths(root: string, patch: string, base: string, tmpParent: string): string[] {
  if (!lstatSync(patch).size) return [];
  const env = { ...process.env, GIT_INDEX_FILE: join(mkdtempSync(join(tmpParent, "pidx-")), "index") };
  git(root, ["read-tree", base], env);
  git(root, ["apply", "--cached", "--binary", patch], env);
  const raw = git(root, ["diff-index", "--cached", "--raw", "-z", "--no-renames", base], env).split("\0");
  const paths: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) { // ":<old mode> <new mode> <old> <new> <status>" \0 <path> \0
    const newMode = raw[i].split(" ")[1], p = raw[i + 1];
    if (newMode === "120000") throw new Error(`the box patch makes ${printable(p, true)} a symlink`);
    if (!plainRel(p)) throw new Error(`the box patch touches an unsafe path (${printable(p, true)}: .git, .. or absolute)`);
    paths.push(p);
  }
  return paths;
}

/** Files that make an agent, editor, direnv or git run something on this Mac (or change what it runs)
 *  the moment the checkout holds them. Box work touching any of them never lands in place. */
const AGENT_DIRS = [".claude", ".codex", ".opencode", ".vscode", ".idea", ".githooks", ".husky", ".devcontainer", ".cursor"];
const AGENT_FILES = [
  ".mcp.json", "claude.md", "claude.local.md", ".claude.json", "agents.md", "opencode.json", "opencode.jsonc",
  ".envrc", ".gitattributes", ".lfsconfig", ".gitmodules",
];

/** The paths (at any depth, any case) that are agent/editor/git config, or SENSITIVE (credentials are
 *  never written into the Mac checkout in place either). */
export function agentConfigPaths(paths: string[]): string[] {
  return [...new Set(paths)].filter((p) => {
    const segs = p.toLowerCase().split("/").filter(Boolean);
    return segs.some((s) => AGENT_DIRS.includes(s)) || AGENT_FILES.includes(segs[segs.length - 1] ?? "") || sensitive(p);
  });
}

/** Make the box's HEAD present here: verify + fetch the bundle (objects and FETCH_HEAD only, nothing
 *  checked out) and prove it is the HEAD the box reported; without a bundle it must already exist. */
export function fetchBox(root: string, a: BoxArtifacts): void {
  if (!a.bundle) { git(root, ["cat-file", "-e", `${a.boxHead}^{commit}`]); return; }
  git(root, ["bundle", "verify", "-q", a.bundle]);
  git(root, ["fetch", "-q", a.bundle, "HEAD"]);
  const got = git(root, ["rev-parse", "FETCH_HEAD"]).trim();
  if (got !== a.boxHead) throw new Error(`the bundle's HEAD is ${got}, the box reported ${a.boxHead}`);
}

/** Every path the box's work changed: its commits since the merge-base with `macHead` (rename-free, so
 *  both sides; Mac-only commits are not the box's), its patch (patchPaths: throws on an unsafe one), its
 *  untracked files. */
export function boxChangedPaths(root: string, a: BoxArtifacts, macHead: string, tmpParent: string): string[] {
  fetchBox(root, a);
  let base = macHead;
  try { base = git(root, ["merge-base", macHead, a.boxHead]).trim(); } catch { /* unrelated histories: vs the Mac */ }
  const commits = a.boxHead === base ? [] : git(root, ["diff", "--name-only", "--no-renames", "-z", base, a.boxHead]).split("\0").filter(Boolean);
  return [...commits, ...(a.patch ? patchPaths(root, a.patch, a.boxHead, tmpParent) : []), ...a.untracked];
}

// ----------------------------------------------------------------------------------------- memory

export interface MemoryReport { added: string[]; updated: string[]; conflicts: string[] }

/** Merge the box's memory/ into the Mac's: box-only → add; identical → skip; the Mac still as handed
 *  off → take the box copy (the Mac's goes to <backup>/memory-before/); both changed → keep the Mac's,
 *  the box's goes to <backup>/memory-conflicts/. Never deletes; box deletions are ignored. */
export function mergeMemory(snapMem: Record<string, string> | undefined, boxDir: string, boxFiles: string[], macDir: string, backup: string): MemoryReport {
  const r: MemoryReport = { added: [], updated: [], conflicts: [] };
  mkdirSync(macDir, { recursive: true });
  for (const rel of boxFiles) {
    const src = join(boxDir, rel);
    const mac = join(macDir, rel);
    if (!existsSync(mac)) { if (copyContained(src, macDir, rel, false, true)) r.added.push(rel); continue; }
    const macSha = sha256(readFileSync(mac));
    if (macSha === sha256(readFileSync(src))) continue;
    if (snapMem?.[rel] === macSha) {
      copyContained(mac, mkdirp(join(backup, "memory-before")), rel, true, true);
      if (copyContained(src, macDir, rel, true, true)) r.updated.push(rel);
    } else {
      copyContained(src, mkdirp(join(backup, "memory-conflicts")), rel, true, true);
      r.conflicts.push(rel);
    }
  }
  return r;
}

export const mkdirp = (d: string) => { mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };

/** Atomically put `bytes` at `path` (never a partial transcript). */
export function atomicWriteBytes(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, path);
}

// ------------------------------------------------------------------------------------------- code

export interface BoxArtifacts {
  bundle?: string; // BASE..HEAD (or all of HEAD without a base); absent when the box made no commits
  patch?: string; // git diff --binary HEAD on the box
  untrackedDir?: string; // extracted + validated
  untracked: string[];
  boxHead: string;
}

const recovery = (root: string, stash: string | undefined, backup: string) => [
  `Nothing was reset or cleaned. Inspect with: git -C '${root}' status`,
  stash ? `Your Mac changes from before are in stash ${stash}: git -C '${root}' stash apply ${stash}` : "",
  `Everything the box sent is in ${backup} (repo.bundle, wip.patch, untracked.tgz).`,
].filter(Boolean).join("\n");

/** The Mac is exactly as handed off: stash (only if dirty, kept), fast-forward to the box's commits (or
 *  detach there when the Mac was detached), apply the box's WIP, copy its untracked files (never over an
 *  existing one). Returns the stash sha, if any. Throws with the exact recovery on any failure. */
export function applyInPlace(root: string, a: BoxArtifacts, detached: boolean, uuid8: string, backup: string): { stash?: string; skipped: string[] } {
  let stash: string | undefined;
  const skipped: string[] = [];
  try {
    fetchBox(root, a);
    const flagged = a.patch ? agentConfigPaths(patchPaths(root, a.patch, a.boxHead, backup)) : [];
    if (flagged.length) throw new Error(`the box patch changes agent config (${printable(flagged.join(", "), true)}): not landing it in place`);
    // SENSITIVE files never went to the box (the handoff tar excludes them): they stay put, unstashed.
    const keep = ["--", ".", ...SENSITIVE.flatMap((p) => [`:(exclude,glob,icase)**/${p}`, `:(exclude,glob,icase)**/${p}/**`])];
    if (git(root, ["status", "--porcelain", ...keep]).trim()) {
      const msg = `nomo: before cloud return ${uuid8}`;
      console.log(`Stashing your uncommitted Mac changes as "${msg}"…`);
      git(root, ["stash", "push", "-u", "-m", msg, ...keep]);
      stash = git(root, ["rev-parse", "stash@{0}"]).trim();
    }
    if (a.bundle) git(root, detached ? ["checkout", "-q", "--detach", a.boxHead] : ["merge", "-q", "--ff-only", a.boxHead]);
    if (a.patch && lstatSync(a.patch).size > 0) git(root, ["apply", "--binary", a.patch]);
    for (const rel of a.untracked) if (!copyContained(join(a.untrackedDir!, rel), root, rel, false)) skipped.push(rel);
  } catch (e: any) {
    const why = printable((e.stderr?.toString() || e.message || String(e)).trim());
    throw new Error(`landing the box's code in ${root} failed: ${why}\n${recovery(root, stash, backup)}`);
  }
  return { stash, skipped };
}

/** The first free `nomo/cloud-<id8>[-N]`. */
export function freeBranch(root: string, uuid8: string): string {
  for (let i = 1; ; i++) {
    const name = `nomo/cloud-${uuid8}${i > 1 ? `-${i}` : ""}`;
    try { git(root, ["show-ref", "--verify", "-q", `refs/heads/${name}`]); } catch { return name; }
  }
}

/** Land the box's work on a new branch WITHOUT touching the Mac's checkout: its commits via the bundle
 *  (or the box HEAD when it made none), then its WIP + untracked files as one commit built in a temp
 *  index. Returns the branch name. */
export function landOnBranch(root: string, a: BoxArtifacts, uuid8: string, backup: string): string {
  fetchBox(root, a);
  if (a.patch) patchPaths(root, a.patch, a.boxHead, backup);
  const name = freeBranch(root, uuid8);
  const ref = `refs/heads/${name}`;
  git(root, ["update-ref", ref, a.boxHead, ""]);
  const hasPatch = !!a.patch && lstatSync(a.patch).size > 0;
  if (!hasPatch && !a.untracked.length) return name;

  const tip = git(root, ["rev-parse", ref]).trim();
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]).trim();
  const tmp = mkdtempSync(join(backup, "index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
  git(root, ["read-tree", tip], env);
  if (hasPatch) git(root, ["apply", "--cached", "--binary", a.patch!], env);
  if (a.untracked.length) {
    // From a NUL list, literal: no argv explosion, no pathspec magic in a box-chosen name.
    const list = join(tmp, "paths");
    writeFileSync(list, a.untracked.join("\0"));
    git(a.untrackedDir!, ["--literal-pathspecs", `--git-dir=${gitDir}`, `--work-tree=${a.untrackedDir}`, "add", "-f", `--pathspec-from-file=${list}`, "--pathspec-file-nul"], env);
  }
  const tree = git(root, ["write-tree"], env).trim();
  const commit = git(root, ["commit-tree", tree, "-p", tip, "-m", `nomo: uncommitted work from the cloud session ${uuid8}`]).trim();
  git(root, ["update-ref", ref, commit, tip]);
  return name;
}

/** A non-git folder comes back as a SIBLING `<cwd>.nomo-cloud-<id8>[-N]`, never over the original. */
export function landFolder(cwd: string, extracted: string, files: string[], uuid8: string): string {
  let dst = `${cwd}.nomo-cloud-${uuid8}`;
  for (let i = 2; existsSync(dst); i++) dst = `${cwd}.nomo-cloud-${uuid8}-${i}`;
  mkdirSync(dst, { recursive: true });
  for (const rel of files) copyContained(join(extracted, rel), dst, rel, false);
  return dst;
}
