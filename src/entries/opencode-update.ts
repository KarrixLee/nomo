// opencode-update — what `/nomo-update` runs, and the ONE implementation of "is there a newer nomo
// for OpenCode" (bin/nomo-ai.mjs shells out to this file rather than growing a second copy).
//
// WHY THIS EXISTS AT ALL. Claude Code and Codex update through their hosts (`claude plugin update`,
// `codex plugin marketplace upgrade`). OpenCode has neither: it auto-discovers a plugin file and
// import()s it, so the checkout IS the version and updating means pulling it. That mechanism used to
// live in the docs, which is the tell that it had leaked into the UX — the user's words were "feels
// like not easy". So it lives here instead and the docs line becomes one command.
//
// CHECK FIRST, THEN UPDATE. `git fetch` (which touches nothing in the working tree), read the target
// version out of the remote side with `git show <upstream>:…` (no checkout, no reset), and only then
// decide. The common case is "nothing to do", and that path must not modify a working tree or ask for
// a restart it does not need. When there IS an update the user sees `2.1.21 → 2.1.23` BEFORE it
// happens, not afterwards.
//
// THE STUB IS THE AUTHORITY, not this bundle's own location and not the root baked into the command
// file. `~/.config/opencode/plugins/nomo.js` is a one-line re-export of `<plugin-root>/dist/
// opencode.js` (plugin/scripts/opencode-install.sh writes it) and that path is what OpenCode actually
// imports — so it is the only honest answer to "which checkout am I updating?". A machine with a
// checkout per branch, or one that ran the installer from somewhere else, updates the copy it runs.
//
// LOUD ON FAILURE, deliberately unlike the hooks. run.sh and every hook exit 0 on any problem so a
// broken install never disturbs a session. This is a command the user typed on purpose: every refusal
// names what is wrong AND the command to run by hand.
//
// PORTABILITY: bun AND node >= 18 (bundled by build.ts) — no Bun.* APIs.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeStubPaths, opencodeStubTarget } from "../core/shared";

/** The manifest build.ts injects PLUGIN_VERSION from, relative to the repo root. Reading the SAME file
 *  the build reads is what makes this number agree with the `x-cc-version` the worker sees — and so
 *  with the update banner the app shows when that version is stale. The banner says *when*; this says
 *  *how*; they must not disagree about the number. */
const VERSION_MANIFEST = "plugin/.claude-plugin/plugin.json";

export interface UpdateDeps {
  print?: (line: string) => void;
  /** Candidate stub paths, global scope. Injected so a test never reads the developer's real
   *  ~/.config/opencode. */
  stubPaths?: string[];
  /** The project OpenCode would also load from (`<cwd>/.opencode`). */
  cwd?: string;
  /** This bundle's own directory — `<plugin-root>/dist`. The fallback checkout when no stub exists at
   *  all, which is the shape `bunx nomo-ai` hits on a machine whose install was never completed. */
  self?: string;
  /** `git -C <dir> <args…>`, returning the exit status plus both streams. Injected only by tests that
   *  want to drive a failure git itself would take a network round-trip to produce. */
  git?: (dir: string, args: string[]) => { status: number; stdout: string; stderr: string };
}

/** What the check found. Exactly one of these three is true; `line` is the one sentence a human reads
 *  and `hint` is the by-hand escape hatch that always accompanies a refusal. */
export interface UpdateCheck {
  state: "current" | "behind" | "blocked";
  line: string;
  hint?: string;
  /** The repo root being updated — absent only when nothing resolvable was found. */
  root?: string;
  /** `origin/dev` etc. — the ref a fast-forward would land on. */
  upstream?: string;
  from?: string;
  to?: string;
  /** The stub that decided all this came from `<cwd>/.opencode`, so the re-install must too. */
  project?: boolean;
}

function realGit(dir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.error) return { status: 127, stdout: "", stderr: r.error.message };
  return { status: r.status ?? 1, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

/** The `version` in a repo's plugin manifest, or undefined when it cannot be read or parsed. `text`
 *  is the manifest either from the working tree or from `git show <ref>:<path>` — the same parse for
 *  both sides of the comparison, so a format surprise cannot make them disagree for the wrong reason. */
function manifestVersion(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Fetch, compare, and report — WITHOUT touching the working tree. Everything that can refuse is
 *  decided here, before anything is pulled: a mid-way abort would leave the user guessing which half
 *  ran. */
export function checkUpdate(deps: UpdateDeps = {}): UpdateCheck {
  const git = deps.git ?? realGit;
  const cwd = deps.cwd ?? process.cwd();
  const self = deps.self ?? dirname(fileURLToPath(import.meta.url));

  // ── which checkout? ───────────────────────────────────────────────────────────────────────────
  // Global first (what the installer writes by default), then the project scope `--project` writes.
  // The scope matters beyond finding the file: re-running the installer in the wrong one would leave
  // the user's actual install untouched and quietly create a second one.
  const candidates: { path: string; project: boolean }[] = [
    ...(deps.stubPaths ?? opencodeStubPaths()).map((path) => ({ path, project: false })),
    { path: join(cwd, ".opencode", "plugins", "nomo.js"), project: true },
    { path: join(cwd, ".opencode", "plugin", "nomo.js"), project: true },
  ];

  let stub: string | undefined;
  let target: string | undefined;
  let project = false;
  for (const c of candidates) {
    let text: string;
    try {
      text = readFileSync(c.path, "utf8");
    } catch {
      continue;
    }
    stub = c.path;
    project = c.project;
    target = opencodeStubTarget(text);
    break;
  }

  // The installer that fixes every resolution failure below. `self` is <plugin-root>/dist, so its
  // sibling scripts/ is the copy the user is *already running*, which is the one to name.
  const installer = join(dirname(self), "scripts", "opencode-install.sh");

  if (stub === undefined) {
    return {
      state: "blocked",
      line: "OpenCode has no Nomo plugin stub — nothing here is installed, so there is nothing to update.",
      hint: `install it: ${installer}`,
    };
  }
  if (target === undefined) {
    return {
      state: "blocked",
      line: `${stub} exists but is not a Nomo stub — something else wrote that file.`,
      hint: `move it aside, then: ${installer}`,
    };
  }
  if (!existsSync(target)) {
    // The stub survives a moved or deleted checkout perfectly, and OpenCode then fails the import
    // silently, forever, with no other symptom. This is the one failure a user cannot diagnose.
    return {
      state: "blocked",
      line: `${stub} points at ${target}, which is gone — the checkout was moved or deleted.`,
      hint: `re-run the installer from wherever your nomo checkout is now:\n  <checkout>/plugin/scripts/opencode-install.sh`,
    };
  }

  // <plugin-root>/dist/opencode.js → <plugin-root> → the repo it lives in. Asked of git rather than
  // assumed from the path, because a checkout is not obliged to keep the plugin dir one level down.
  const pluginRoot = dirname(dirname(target));
  const top = git(pluginRoot, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || top.stdout.length === 0) {
    return {
      state: "blocked",
      line: `${pluginRoot} is not a git checkout — this copy of Nomo cannot be updated in place.`,
      hint: `clone it and re-install:\n  git clone https://github.com/KarrixLee/nomo.git ~/.nomo\n  ~/.nomo/plugin/scripts/opencode-install.sh`,
    };
  }
  const root = top.stdout;

  let from: string | undefined;
  try {
    from = manifestVersion(readFileSync(join(root, VERSION_MANIFEST), "utf8"));
  } catch {
    from = undefined;
  }
  if (from === undefined) {
    return {
      state: "blocked",
      line: `${root} has no readable ${VERSION_MANIFEST} — it does not look like a nomo checkout.`,
      hint: `check what is there: git -C ${root} remote -v`,
    };
  }

  // ── refusals, all of them BEFORE the network ──────────────────────────────────────────────────
  //
  // DETACHED IS A PIN, NOT A PROBLEM TO FIX. `bunx nomo-ai --opencode --ref <branch|tag>` deliberately
  // leaves the clone detached, precisely so a later plain run recognises the pin and will not silently
  // un-pin somebody testing a branch (see bin/nomo-ai.mjs). Fast-forwarding it here would undo that
  // with nothing to notice, so this refuses for the identical reason and points at the identical way
  // out. Same test too: symbolic-ref is empty exactly when HEAD is detached.
  const branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).stdout;
  if (branch.length === 0) {
    const at = git(root, ["describe", "--tags", "--always"]).stdout || "?";
    return {
      state: "blocked",
      root,
      line: `${root} is detached at ${at} — pinned by an earlier --ref install, so it is left alone.`,
      hint:
        "a detached HEAD cannot fast-forward. Move the pin, or go back to a branch:\n" +
        `  bunx nomo-ai --opencode --ref <branch-or-tag>\n  git -C ${root} checkout main`,
    };
  }

  const dirty = git(root, ["status", "--porcelain"]).stdout;
  if (dirty.length > 0) {
    const n = dirty.split("\n").length;
    return {
      state: "blocked",
      root,
      line: `${root} has ${n} uncommitted change${n === 1 ? "" : "s"} — a pull would fight them.`,
      hint: `commit or stash them first:\n  git -C ${root} status`,
    };
  }

  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).stdout;
  if (upstream.length === 0) {
    return {
      state: "blocked",
      root,
      line: `${root} is on ${branch}, which tracks nothing — there is no upstream to update from.`,
      hint: `point it at one:\n  git -C ${root} branch --set-upstream-to origin/${branch} ${branch}`,
    };
  }

  // ── the one network call ──────────────────────────────────────────────────────────────────────
  const fetched = git(root, ["fetch", "--quiet"]);
  if (fetched.status !== 0) {
    return {
      state: "blocked",
      root,
      upstream,
      line: `could not reach the remote for ${root}${fetched.stderr ? ` — ${fetched.stderr.split("\n")[0]}` : "."}`,
      hint: `check network access to github.com, then:\n  git -C ${root} fetch`,
    };
  }

  // Already contains the upstream tip: up to date, and ALSO the answer when the checkout is ahead
  // (local commits on top). Neither is an error and neither needs a pull.
  if (git(root, ["merge-base", "--is-ancestor", upstream, "HEAD"]).status === 0) {
    return { state: "current", root, upstream, from, to: from, project, line: `Already on ${from} — nothing to do.` };
  }
  // Not an ancestor either way = the histories diverged. `--ff-only` would fail with git's own wording;
  // saying it here means the user learns it before anything is attempted.
  if (git(root, ["merge-base", "--is-ancestor", "HEAD", upstream]).status !== 0) {
    return {
      state: "blocked",
      root,
      upstream,
      line: `${root} has diverged from ${upstream} — it cannot fast-forward.`,
      hint: `see what is local, then rebase or reset it yourself:\n  git -C ${root} log --oneline ${upstream}..HEAD`,
    };
  }

  // The version that will actually ship, read from the REMOTE side without checking anything out.
  const remoteManifest = git(root, ["show", `${upstream}:${VERSION_MANIFEST}`]);
  const to = manifestVersion(remoteManifest.status === 0 ? remoteManifest.stdout : undefined);
  return {
    state: "behind",
    root,
    upstream,
    from,
    to,
    project,
    // A pull without a version bump is normal (a fix between releases), and rendering it as
    // "2.1.21 → 2.1.21" reads as a bug. Say what actually changed instead.
    line: to === undefined || to === from
      ? `Newer commits on ${upstream} — still ${from}.`
      : `Update available: ${from} → ${to}.`,
  };
}

/** Check, then — only when behind — fast-forward and re-run the installer. Returns the process exit
 *  code: 0 for both "updated" and "already current", 1 for anything refused. */
export function opencodeUpdate(deps: UpdateDeps = {}): number {
  const print = deps.print ?? ((line: string) => console.log(line));
  const git = deps.git ?? realGit;
  const found = checkUpdate(deps);

  if (found.state === "blocked") {
    print(`Nomo could not update OpenCode: ${found.line}`);
    if (found.hint) for (const l of found.hint.split("\n")) print(`→ ${l}`);
    return 1;
  }

  print(`OpenCode plugin: ${found.root}`);
  if (found.state === "current") {
    // Nothing up to date should look like an error, and it should cost the reader nothing: no pull,
    // no re-install, and no restart advice for a restart that would change nothing.
    print(found.line);
    return 0;
  }

  print(found.line);
  // `merge --ff-only` and not `pull --ff-only`: the fetch already happened during the check, and a
  // pull would repeat it. Identical outcome, one network round-trip.
  const merged = git(found.root!, ["merge", "--ff-only", found.upstream!]);
  if (merged.status !== 0) {
    print(`Nomo could not fast-forward ${found.root}${merged.stderr ? ` — ${merged.stderr.split("\n")[0]}` : "."}`);
    print(`→ run it by hand: git -C ${found.root} merge --ff-only ${found.upstream}`);
    return 1;
  }

  // Re-run the installer, ALWAYS — not only when a command file changed. It is what refreshes the
  // stub and installs any new /nomo-* command the pulled version added, and it is idempotent.
  const installer = join(found.root!, "plugin", "scripts", "opencode-install.sh");
  const args = found.project ? ["--project"] : [];
  const r = spawnSync(installer, args, { stdio: "inherit", cwd: found.project ? (deps.cwd ?? process.cwd()) : found.root });
  if (r.error || r.status !== 0) {
    print(`Nomo pulled ${found.to ?? "the update"} but the installer failed.`);
    print(`→ run it by hand: ${installer}${args.length ? ` ${args.join(" ")}` : ""}`);
    return 1;
  }

  print(found.to && found.to !== found.from ? `Updated to ${found.to}.` : "Updated.");
  print("Restart OpenCode — plugins are imported once at server start, so this one is still running the old copy.");
  return 0;
}

// import.meta.main is true under bun and node >= 24 when this file is the entry; build.ts rewrites it
// for older nodes.
if (import.meta.main) {
  if (process.argv.includes("--check")) {
    console.log("usage: opencode-update [--dry-run] [--check]  — pull the checkout OpenCode loads Nomo from, then re-run its installer (--dry-run reports the verdict and changes nothing)");
    process.exit(0);
  }
  if (process.argv.includes("--dry-run") || process.argv.includes("-n")) {
    // The READ-ONLY half, for a caller that wants the verdict without the pull — bin/nomo-ai.mjs shows
    // it in the plan preview, before the user has agreed to anything.
    const found = checkUpdate();
    console.log(found.line);
    if (found.hint) for (const l of found.hint.split("\n")) console.log(`→ ${l}`);
    process.exit(found.state === "blocked" ? 1 : 0);
  }
  process.exit(opencodeUpdate());
}
