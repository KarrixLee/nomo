// Cloud-readiness check (NOM-90 item 6): before /nomo-cc:handoff moves a session, name what the cloud box
// WON'T have. Local only: no box contact, and no secret VALUE is ever read — secret files are matched by
// name, and the JSON configs below are parsed only for their key names. Never blocks a handoff.
//
// What ships is decided by handoff.ts build(): in a git repo, HEAD + the diff + untracked NON-ignored files;
// a non-git folder is tarred whole minus node_modules and .git. Both tars drop every isSecretName file, so a
// secret travels only when git TRACKS it (it is in the bundle). Submodule contents never travel (the bundle
// holds only the gitlink); an untracked, unignored nested repo rides in the untracked tar.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface GitProbe {
  /** Tracked files among / under `paths` (relative to the repo root). */
  tracked(paths: string[]): Set<string>;
  /** The subset of `paths` that .gitignore (or info/exclude, global excludes) ignores. */
  ignored(paths: string[]): Set<string>;
  /** `git remote -v` output. */
  remotes(): string;
}

export interface ReadinessDeps {
  home: string;
  /** Where Claude Code runs (~/.claude.json keys project MCP servers by it); defaults to the root. */
  cwd?: string;
  /** Undefined for a non-git folder. */
  git?: GitProbe;
  /** A text file's contents, or undefined when missing, unreadable or over `max` bytes. */
  readText?: (path: string, max: number) => string | undefined;
  /** Walk budget (directory entries looked at). */
  maxEntries?: number;
}

const MAX_DEPTH = 4;
const DEP_DIRS: Record<string, true> = { node_modules: true, ".venv": true, venv: true, target: true, build: true, dist: true, ".build": true, Pods: true, vendor: true };
const NO_DESCEND = new Set(["DerivedData", "__pycache__", ".git"]);
const LOCKS: [string, string][] = [
  ["bun.lock", "bun install"], ["bun.lockb", "bun install"], ["pnpm-lock.yaml", "pnpm install"], ["yarn.lock", "yarn install"],
  ["package-lock.json", "npm ci"], ["uv.lock", "uv sync"], ["poetry.lock", "poetry install"], ["Cargo.lock", "cargo build"],
  ["Podfile.lock", "pod install"], ["Gemfile.lock", "bundle install"], ["composer.lock", "composer install"],
];
const LOCK_NAMES = new Set(LOCKS.map(([n]) => n));

/** A file whose name says it likely holds a secret. Example/template env files are not secrets. */
export function isSecretName(name: string): boolean {
  if (/^\.env(\..+)?$/.test(name)) return !/\.(example|sample|template|dist|defaults?)$/i.test(name);
  return /^(\.envrc|\.dev\.vars|\.npmrc|\.netrc|\.pypirc|credentials\.json|id_(rsa|ed25519|ecdsa)|secrets?\.(json|ya?ml|toml))$/.test(name)
    || /^service[-_]?account.*\.json$/i.test(name)
    || /\.(pem|key|p12|p8|pfx|keystore|jks)$/.test(name);
}
const isCompose = (n: string) => /^(docker-)?compose([.-].*)?\.ya?ml$/.test(n);
const isLocalhostCandidate = (n: string) => !LOCK_NAMES.has(n) && /\.(toml|ya?ml)$/.test(n);

const defaultRead = (p: string, max: number): string | undefined => {
  try { const st = statSync(p); return st.isFile() && st.size <= max ? readFileSync(p, "utf8") : undefined; } catch { return undefined; } // a link to /dev/zero or a FIFO never hangs
};
/** The key names of a JSON object member, or [] when it isn't one. */
const keysOf = (v: unknown): string[] => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []);
const listNames = (names: string[], max = 3): string =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} +${names.length - max}`;

interface Walk { secrets: string[]; deps: string[]; locks: Map<string, string[]>; xcode: boolean; compose: string[]; config: string[]; nested: string[] }

/** Bounded breadth-first walk from `root`: never descends into dependency/build dirs, dot-dirs, Xcode
 *  bundles or nested repos/submodules, and stops after `budget` entries. */
function walk(root: string, budget: number): Walk {
  const w: Walk = { secrets: [], deps: [], locks: new Map(), xcode: false, compose: [], config: [], nested: [] };
  const queue: [string, number][] = [["", 0]];
  let seen = 0;
  while (queue.length && seen < budget) {
    const [rel, depth] = queue.shift()!;
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { continue; }
    for (const e of entries) {
      if (++seen > budget) break;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (DEP_DIRS[e.name]) { w.deps.push(p); continue; }
        if (/\.(xcodeproj|xcworkspace)$/.test(e.name)) { w.xcode = true; continue; }
        if (existsSync(join(root, p, ".git"))) { w.nested.push(p); continue; }
        if (e.name.startsWith(".") || NO_DESCEND.has(e.name) || depth + 1 > MAX_DEPTH) continue;
        queue.push([p, depth + 1]);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (isSecretName(e.name)) { w.secrets.push(p); continue; } // never opened: no localhost grep on a secret
        if (isCompose(e.name)) w.compose.push(p);
        if (LOCK_NAMES.has(e.name)) w.locks.set(rel, [...(w.locks.get(rel) ?? []), e.name]);
        if (isLocalhostCandidate(e.name) && !e.name.startsWith(".")) w.config.push(p);
      }
    }
  }
  return w;
}

/** The "Cloud check:" block printed next to the size heads-up. One or two lines, never empty. */
export function cloudReadiness(root: string, deps: ReadinessDeps): string {
  const read = (p: string, max: number) => { try { return (deps.readText ?? defaultRead)(p, max); } catch { return undefined; } };
  const w = walk(root, deps.maxEntries ?? 4000);
  const safe = <T>(f: () => T, d: T): T => { try { return f(); } catch { return d; } };
  const git = deps.git;
  const probe = [...w.secrets, ...w.deps, ...w.nested];
  const trackedFiles = git ? safe(() => git.tracked(probe), new Set<string>()) : new Set<string>();
  // ls-files names a tracked DIR by its files: a path counts as tracked when it or anything under it is.
  const trackedDirs = new Set([...trackedFiles].flatMap((f) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
  const tracked = new Set(probe.filter((p) => trackedFiles.has(p) || trackedDirs.has(p)));
  const ignored = git ? safe(() => git.ignored(probe), new Set<string>()) : new Set<string>();
  const missing: string[] = [];
  const warnings: string[] = [];

  // Secrets: the handoff tars drop them all (handoff.ts packList); only a git-TRACKED one is in the bundle.
  const shipped = w.secrets.filter((s) => tracked.has(s));
  const kept = w.secrets.filter((s) => !tracked.has(s));
  if (kept.length) missing.push(`${listNames(kept)} (${kept.length} file${kept.length > 1 ? "s" : ""}, never sent)`);
  for (const s of shipped) warnings.push(`Heads-up: ${s} looks like a secret and is tracked in git: it WILL be on the box.`);

  // Deps/builds the box must reinstall: git-ignored ones (git), node_modules (non-git: the folder tar skips it).
  const gone = w.deps.filter((d) => git ? ignored.has(d) && !tracked.has(d) : d === "node_modules" || d.endsWith("/node_modules"));
  if (gone.length) {
    const names = [...new Set(gone.map((d) => d.split("/").pop()!))];
    const cmds = [...new Set(gone.flatMap((d) => (w.locks.get(d.split("/").slice(0, -1).join("/")) ?? [])
      .map((l) => LOCKS.find(([n]) => n === l)![1])))];
    missing.push(`${names.join(", ")} (box must reinstall${cmds.length ? `: ${cmds.join(", ")}` : ""})`);
  }
  const nested = w.nested.filter((n) => tracked.has(n) || ignored.has(n)); // an untracked unignored one IS sent
  if (git && nested.length) missing.push(`${listNames(nested)} (nested repo/submodule, not in the bundle)`);

  // MCP servers + other plugins: key names only, never env/headers/args. A big or broken file is skipped.
  const json = (p: string, max: number): any => { const t = read(p, max); return t === undefined ? undefined : safe(() => JSON.parse(t), undefined); };
  const user = json(join(deps.home, ".claude.json"), 8 << 20);
  const servers = [...new Set([
    ...keysOf(json(join(root, ".mcp.json"), 1 << 20)?.mcpServers),
    ...keysOf(user?.mcpServers),
    ...keysOf(user?.projects?.[root]?.mcpServers),
    ...keysOf(user?.projects?.[deps.cwd ?? root]?.mcpServers),
  ])];
  if (servers.length) missing.push(`${servers.length} MCP server${servers.length > 1 ? "s" : ""} (${listNames(servers)})`);
  const plugins = Object.entries(json(join(deps.home, ".claude", "settings.json"), 1 << 20)?.enabledPlugins ?? {})
    .filter(([k, v]) => v === true && !k.startsWith("nomo-cc@")).map(([k]) => k.split("@")[0]);
  if (plugins.length) missing.push(`${plugins.length} other plugin${plugins.length > 1 ? "s" : ""} (${listNames(plugins)})`);

  // Mac-only tooling.
  if (w.xcode) missing.push("Xcode project");
  if (/\.iOS\s*\(/.test(read(join(root, "Package.swift"), 256 << 10) ?? "")) missing.push("iOS Swift package");
  if (w.compose.length) missing.push(`Docker Compose (${listNames(w.compose)})`);
  const local = [...w.compose, ...w.config].slice(0, 50).filter((p) => /\b(localhost|127\.0\.0\.1)\b/.test(read(join(root, p), 64 << 10) ?? ""));
  if (local.length) missing.push(`localhost services (${listNames(local)})`);

  // CLI logins.
  if (git && /github\.com[:/]/.test(safe(() => git.remotes(), ""))) missing.push("gh login (GitHub remote)");

  const head = missing.length
    ? `Cloud check: fine for code edits and tests. Won't be on the box: ${missing.join(" · ")}. Anything needing those will stall.`
    : warnings.length ? "Cloud check: fine for code edits and tests." : "Cloud check: nothing Mac-only spotted.";
  return [head, ...warnings].join("\n");
}

/** NOM-106: the setup commands the box should run, derived ONLY from lockfiles and compose files (never
 *  from the model): one install per lockfile dir (one JS package manager per dir, LOCKS order), then
 *  `docker compose up -d` per compose file. Prefixed `cd <dir> && ` outside the root. At most `max`. */
export function setupSteps(root: string, maxEntries = 4000, max = 8): string[] {
  const w = walk(root, maxEntries);
  const JS = new Set(LOCKS.slice(0, 5).map(([n]) => n));
  const sq = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  const cd = (dir: string, cmd: string) => (dir ? `cd ${sq(dir)} && ${cmd}` : cmd);
  const steps: string[] = [];
  for (const dir of [...w.locks.keys()].sort()) {
    let js = false;
    for (const [name, cmd] of LOCKS) {
      if (!w.locks.get(dir)!.includes(name) || (JS.has(name) && js)) continue;
      js ||= JS.has(name);
      steps.push(cd(dir, cmd));
    }
  }
  for (const f of w.compose) steps.push(`docker compose -f ${sq(f)} up -d`);
  return [...new Set(steps)].slice(0, max);
}

/** The real git probe for the repo at `root`, or undefined when it isn't one. */
export function gitProbe(root: string): GitProbe | undefined {
  const run = (args: string[], input?: string): string =>
    execFileSync("git", args, { cwd: root, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"], maxBuffer: 1 << 24 }).toString();
  const split = (s: string) => new Set(s.split("\0").filter(Boolean).map((p) => p.replace(/\/$/, "")));
  try { if (run(["rev-parse", "--show-toplevel"]).trim() === "") return undefined; } catch { return undefined; }
  return {
    tracked: (paths) => (paths.length ? split(run(["--literal-pathspecs", "ls-files", "-z", "--", ...paths])) : new Set()),
    // check-ignore exits 1 when nothing matches; that is "none ignored", not a failure.
    ignored: (paths) => {
      if (!paths.length) return new Set();
      try { return split(run(["check-ignore", "-z", "--stdin"], paths.join("\0") + "\0")); } catch (e: any) { return split(e?.stdout?.toString() ?? ""); }
    },
    remotes: () => run(["remote", "-v"]),
  };
}

/** NOM-94: the phone's move-to-cloud gate. Every file git TRACKS in cwd's repo (they all travel in the
 *  bundle) whose name isSecretName matches: no walk caps, dot-dirs included. [] outside a git repo
 *  (nothing is tracked); undefined when git itself fails, which the caller must treat as a refusal. */
export function trackedSecretFiles(cwd: string): string[] | undefined {
  const git = (args: string[]): string => execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" }, maxBuffer: 256 * 1024 * 1024,
  });
  let top: string;
  try { top = git(["rev-parse", "--show-toplevel"]).trim(); } catch (e: any) {
    return /not a git repository/.test(String(e?.stderr ?? "")) ? [] : undefined;
  }
  try {
    return execFileSync("git", ["-C", top, "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 })
      .split("\0").filter((f) => f && isSecretName(f.split("/").pop()!));
  } catch { return undefined; }
}
