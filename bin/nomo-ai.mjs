#!/usr/bin/env node
// nomo-ai — one-command installer for the Nomo plugin.
//
// A BOOTSTRAPPER, NOT A PACKAGE MANAGER. Claude Code and Codex already own install *and* update
// through their own marketplaces, and both keep the plugin in a VERSION-PINNED cache directory they
// evict on upgrade. Writing their plugin files from here would put this script in a fight with
// `claude plugin update` and leave two installs at different versions arguing over one shared
// watchdog daemon. So every leg below drives the host's own native command; nothing here writes into
// ~/.claude or ~/.codex. OpenCode is the one agent with no marketplace, and even there the work is
// delegated to plugin/scripts/opencode-install.sh in a real git checkout — not reimplemented here.
//
// NO POSTINSTALL HOOK, deliberately. A package that writes into an agent's config merely because
// someone `npm install`ed it is the exact shape supply-chain scanners flag. This must be a command a
// human typed. (OpenCode also sets ignoreScripts: true, so a postinstall would not even fire there.)
//
// LOUD ON FAILURE, unlike the plugin's hooks. run.sh and every hook exit 0 on any problem so a broken
// install never disturbs a session. This is the opposite: the user typed it on purpose, so every
// failure names the step, the command, and what to run by hand.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "KarrixLee/nomo";
const CLONE_URL = `https://github.com/${REPO}.git`;
// The OpenCode stub is a re-export of an ABSOLUTE path, so that path has to outlive this process.
// A bunx/npx cache directory does not, which is why the OpenCode leg clones instead of shipping
// plugin/ inside the tarball. ~/.nomo is also deliberately NOT a host's plugin cache: those are
// version-pinned and deleted on upgrade, which would dangle the stub on the next `claude plugin
// update`. A checkout we own upgrades with `git pull` and never moves.
const CHECKOUT = join(homedir(), ".nomo");

const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

const USAGE = `nomo-ai ${VERSION} — install the Nomo plugin for your coding agents.

  bunx nomo-ai            detect agents, confirm, install
  npx nomo-ai             same, without bun

Agents (naming any one of these skips the prompt):
  --claude                Claude Code
  --codex                 OpenAI Codex
  --opencode              OpenCode
  --all                   all three

Options:
  -y, --yes               no prompt; install every agent detected on this machine
  -n, --dry-run           print the commands that would run, run nothing
      --ref <branch|tag>  OpenCode only: install from this ref of the repo
                          instead of its default branch. Claude Code and Codex
                          install through their own marketplaces, which read the
                          default branch and take no ref — --ref cannot pin them.
  -h, --help              this
  -v, --version           print the version

Nothing here pairs your phone — that stays a deliberate step you run from inside the
agent afterwards (/nomo-cc:pair, $nomo-pair, /nomo-pair).`;

// ── plumbing ─────────────────────────────────────────────────────────────────────────────────────

let DRY = false;
// --ref pins the OpenCode checkout to one branch or tag; null means the repo's default branch, which
// is also the ONLY thing the other two legs can ever install (their marketplaces take an owner/repo
// and read the default branch — there is no ref to pass them). So this is deliberately not a global
// "install this version": it is scoped to the one leg that owns its own checkout.
let REF = null;

/** One colour decision for the whole file, so NO_COLOR turns off the banner and the bold/dim runs
 *  together instead of half of them. NO_COLOR is honoured as the convention defines it — set and
 *  non-empty disables, which is exactly what a falsy check on an env var already gives. FORCE_COLOR
 *  is the counterweight, for a caller that wants ANSI down a pipe anyway (`0` still means off). */
const COLOR =
  !process.env.NO_COLOR &&
  (process.stdout.isTTY || (!!process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0"));
const bold = (s) => (COLOR ? `\u001b[1m${s}\u001b[0m` : s);
const dim = (s) => (COLOR ? `\u001b[2m${s}\u001b[0m` : s);
const say = (s = "") => console.log(s);
const err = (s) => console.error(s);

/** Is `name` an executable on PATH? A scan, not a `command -v` fork: no subprocess, and a test can
 *  point PATH at a throwaway directory and get a truthful answer. */
function onPath(name) {
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

/** A step failed if it returns a message. stdio is inherited so the host's own output — which is
 *  usually the real explanation — reaches the user unfiltered. */
function run(cmd, args) {
  const line = [cmd, ...args].join(" ");
  if (DRY) {
    say(`  ${dim("would run:")} ${line}`);
    return null;
  }
  say(`  ${dim("$")} ${line}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error) return `${line}\n  ${r.error.message}`;
  if (r.status !== 0) return `${line}\n  exited ${r.status ?? `on signal ${r.signal}`}`;
  return null;
}

/** A read-only git query inside CHECKOUT. Empty string on any failure — every caller treats
 *  "could not tell" the same as "not the thing I asked about", which is the safe reading. */
const git = (...args) =>
  (spawnSync("git", ["-C", CHECKOUT, ...args], { encoding: "utf8" }).stdout || "").trim();

// ── the three agents ─────────────────────────────────────────────────────────────────────────────
//
// `detect` is "is this agent on this machine at all" (binary or config dir — a user who has run the
// agent once has the dir even if the binary lives behind a shell alias). `install` is what actually
// needs to be runnable, and each one checks its own prerequisite loudly rather than assuming detect
// implied it.

const AGENTS = [
  {
    id: "claude",
    label: "Claude Code",
    plan: () => [`claude plugin marketplace add ${REPO}`, `claude plugin install nomo-cc@nomo -y`],
    next: ["restart Claude Code so the hooks load", "run /nomo-cc:pair"],
    detect: () => onPath("claude") || existsSync(join(homedir(), ".claude")),
    install() {
      if (!onPath("claude")) {
        return {
          error: "`claude` is not on PATH",
          hint: "Install the Claude Code CLI, or from inside Claude Code run:\n" +
            `    /plugin marketplace add ${REPO}\n    /plugin install nomo-cc@nomo`,
        };
      }
      // -y on install: it is only consumed by marketplaces that declare an install command (nomo does
      // not), but it is REQUIRED whenever stdin/stdout is not a TTY, which is exactly the CI shape.
      const fail =
        run("claude", ["plugin", "marketplace", "add", REPO]) ||
        run("claude", ["plugin", "install", "nomo-cc@nomo", "-y"]);
      return fail
        ? {
            error: fail,
            hint: "Run that command by hand, or from inside Claude Code:\n" +
              `    /plugin marketplace add ${REPO}\n    /plugin install nomo-cc@nomo`,
          }
        : null;
    },
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    plan: () => [`codex plugin marketplace add ${REPO}`, `codex plugin add nomo@nomo`],
    // The /hooks step is Codex's own safety gate and nothing here can pre-approve it. Skipping it
    // leaves the plugin installed and silently doing nothing, so it leads the list.
    next: ["run /hooks in Codex and trust the seven Nomo entries", "run $nomo-pair"],
    detect: () => onPath("codex") || existsSync(join(homedir(), ".codex")),
    install() {
      if (!onPath("codex")) {
        return {
          error: "`codex` is not on PATH",
          hint: "Install the Codex CLI (>= 0.142), then run:\n" +
            `    codex plugin marketplace add ${REPO}\n    codex plugin add nomo@nomo`,
        };
      }
      const fail =
        run("codex", ["plugin", "marketplace", "add", REPO]) ||
        run("codex", ["plugin", "add", "nomo@nomo"]);
      return fail
        ? { error: fail, hint: "Run that command by hand. Codex >= 0.142 is required for `codex plugin`." }
        : null;
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    plan: () => [
      `git clone --depth 1 ${REF ? `--branch ${REF} ` : ""}${CLONE_URL} ${CHECKOUT}`,
      `${CHECKOUT}/plugin/scripts/opencode-install.sh`,
    ],
    next: ["restart OpenCode (plugins load once at server start; no hot reload)", "run /nomo-pair"],
    detect: () =>
      onPath("opencode") ||
      existsSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")),
    install() {
      if (!onPath("git")) {
        return { error: "`git` is not on PATH", hint: "OpenCode installs from a checkout; install git and re-run." };
      }
      const script = join(CHECKOUT, "plugin", "scripts", "opencode-install.sh");
      if (existsSync(join(CHECKOUT, ".git"))) {
        // Somebody else's ~/.nomo would get a `git pull` aimed at it. Prove it is ours first.
        const remote = git("remote", "get-url", "origin");
        if (!remote.includes(REPO)) {
          return {
            error: `${CHECKOUT} is a git checkout of something else (origin: ${remote || "?"})`,
            hint: `Move it aside, then re-run. Or install from a checkout you already have:\n    <checkout>/plugin/scripts/opencode-install.sh`,
          };
        }
        // Which ref is it on? A branch checkout fast-forwards; a --ref checkout is deliberately
        // DETACHED and cannot. Confusing the two is how `git pull --ff-only` on a tag produces the
        // unreadable git error this flag exists to avoid.
        const branch = git("symbolic-ref", "--short", "-q", "HEAD");
        const at = branch || `detached at ${git("describe", "--tags", "--always") || "?"}`;
        if (REF) {
          // Pinning is one path for a branch AND a tag: fetch exactly that ref, detach onto it. No
          // local branch to fast-forward means no --ff-only, so the tag case cannot fail weirdly, and
          // a re-run is idempotent — it lands on whatever origin says that ref is right now.
          say(`  ${dim(`${CHECKOUT} already exists (${at}) — pinning to ${REF}`)}`);
          const fail =
            run("git", ["-C", CHECKOUT, "fetch", "--depth", "1", "origin", REF]) ||
            run("git", ["-C", CHECKOUT, "checkout", "--detach", "FETCH_HEAD"]);
          if (fail) {
            return {
              error: fail,
              hint: `Does \`${REF}\` exist in ${REPO}? Otherwise it is local changes in ${CHECKOUT} —\n` +
                `check \`git -C ${CHECKOUT} status\`, or move it aside and re-run.`,
            };
          }
        } else if (!branch) {
          // Refusing beats guessing: silently fast-forwarding a pin back onto the default branch
          // would undo a deliberate --ref with no way to notice.
          return {
            error: `${CHECKOUT} is ${at} — pinned by an earlier --ref run`,
            hint: "`git pull --ff-only` cannot update a detached HEAD. Re-run with --ref <branch-or-tag>\n" +
              `to move the pin, or delete ${CHECKOUT} to go back to the default branch.`,
          };
        } else {
          say(`  ${dim(`${CHECKOUT} already exists (${at}) — updating`)}`);
          const fail = run("git", ["-C", CHECKOUT, "pull", "--ff-only"]);
          if (fail) {
            return {
              error: fail,
              hint: `Local commits or a dirty tree in ${CHECKOUT}? Sort it out there, then re-run.`,
            };
          }
        }
      } else if (existsSync(CHECKOUT)) {
        return {
          error: `${CHECKOUT} exists but is not a git checkout`,
          hint: `Move it aside and re-run, or run the installer from a checkout you already have:\n    <checkout>/plugin/scripts/opencode-install.sh`,
        };
      } else {
        // `--branch` takes a tag as happily as a branch. A clone that fails removes the directory it
        // made, so a bad ref leaves nothing half-written behind.
        //
        // The detach afterwards is load-bearing, not cosmetic: DETACHED IS HOW A PIN IS RECOGNISED
        // on a later run. A tag clone detaches on its own but a branch clone does not, and an
        // attached feature branch is indistinguishable from the default branch — a plain `bunx
        // nomo-ai` months later would fast-forward it and silently keep installing from a branch
        // nobody asked for. Detaching both makes the refusal above catch every pin.
        const fail =
          run("git", ["clone", "--depth", "1", ...(REF ? ["--branch", REF] : []), CLONE_URL, CHECKOUT]) ||
          (REF ? run("git", ["-C", CHECKOUT, "checkout", "--detach", "HEAD"]) : null);
        if (fail) {
          return {
            error: fail,
            hint: REF
              ? `Check network access to github.com, and that \`${REF}\` exists in ${REPO}.`
              : "Check network access to github.com and re-run.",
          };
        }
      }
      if (!DRY && !existsSync(script)) {
        return {
          error: `${script} is missing from the checkout`,
          hint: REF
            ? `Does \`${REF}\` have OpenCode support? Older refs do not ship that script.`
            : `Delete ${CHECKOUT} and re-run.`,
        };
      }
      const fail = run(script, []);
      return fail
        ? {
            error: fail,
            hint: "The script prints what it refused to do. A same-named file it did not write?\n" +
              `    ${script} --force`,
          }
        : null;
    },
  },
];

// ── argv ─────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const picked = new Set();
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    else if (a === "-v" || a === "--version") return { showVersion: true };
    else if (a === "-y" || a === "--yes") yes = true;
    else if (a === "-n" || a === "--dry-run") DRY = true;
    else if (a === "--all") for (const ag of AGENTS) picked.add(ag.id);
    else if (a === "--ref" || a.startsWith("--ref=")) {
      // A missing value would otherwise swallow the next flag and pin the checkout to "--opencode".
      REF = a === "--ref" ? argv[++i] : a.slice("--ref=".length);
      if (!REF || REF.startsWith("-")) return { needsValue: "--ref" };
    } else if (a.startsWith("--") && AGENTS.some((ag) => ag.id === a.slice(2))) picked.add(a.slice(2));
    else return { bad: a };
  }
  return { picked, yes };
}

/** --ref reaches exactly one leg. Saying so out loud is the whole point: a flag that reads as
 *  "install this version" while two of three legs quietly ignore it is worse than no flag. */
function refCaveat(selected) {
  const ignoring = AGENTS.filter((a) => a.id !== "opencode" && selected.has(a.id)).map((a) => a.label);
  say(`${bold("Note:")} --ref ${REF} pins the OpenCode checkout only.`);
  if (ignoring.length > 0) {
    say(dim(`  ${ignoring.join(" and ")} install through their own marketplace, which takes an`));
    say(dim(`  owner/repo and reads ${REPO}'s default branch. There is no ref to pass it, so`));
    say(dim(`  ${ignoring.length > 1 ? "those legs" : "that leg"} will install from the default branch regardless.`));
  }
  if (!selected.has("opencode")) say(dim("  OpenCode is not selected, so --ref changes nothing in this run."));
  say();
}

// ── the prompt ───────────────────────────────────────────────────────────────────────────────────

function render(selected) {
  say();
  AGENTS.forEach((a, i) => {
    const on = selected.has(a.id);
    say(`  ${i + 1}. [${on ? "*" : " "}] ${bold(a.label)}${a.detect() ? "" : dim("  (not detected)")}`);
    if (on) for (const line of a.plan()) say(`         ${dim(line)}`);
  });
  say();
}

// The arrow-key list. Hand-rolled on raw mode + ANSI rather than a prompt library: this package's
// only real security claim is that it has zero dependencies and no postinstall, and a transitive dep
// in the thing a user runs to wire up their agents would spend exactly that claim. The one piece not
// hand-rolled is the key DECODER — node:readline's own emitKeypressEvents, which already carries the
// two things a hand-written one gets wrong: an escape sequence split across `data` events, and a
// paste that delivers fifty keys in one chunk.

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
// Esc is `\u001b`, and so is the first byte of every arrow key. The two ways to tell them apart are
// to look at chunk boundaries (a `data` event that is exactly one Esc byte) or to wait a moment for
// a continuation. This takes the timer, because the chunk shape is the thing the decoder above is
// deliberately hiding — reading it back would mean hand-writing the parser after all, and the split
// arrow key is a worse bug than a 50ms Esc. 50 rather than node's 500 default because half a second
// of nothing after a keypress reads as a hang; it is still ~40x the gap between the bytes of one
// arrow key on any link you would type over. A stray Esc INSIDE a paste never gets here: the
// decoder pairs it with whatever follows and reports meta+that key, so only a trailing one asks.
const KEYS = { escapeCodeTimeout: 50 };

/** One terminal row per line, so the cursor-up count below stays true: a line that wrapped would
 *  make the next redraw start mid-block and walk the list down the screen. ANSI runs are copied
 *  through and cost no width. The width comes back with the line because the redraw needs it later,
 *  at a window size that may no longer be this one.
 *  @param {string} s @param {number} w @returns {[string, number]} the line, and its visible width */
function fit(s, w) {
  let out = "";
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\u001b") {
      const end = s.indexOf("m", i);
      if (end < 0) break;
      out += s.slice(i, end + 1);
      i = end;
    } else if (n < w) {
      out += s[i];
      n++;
    } else return [out + (COLOR ? "\u001b[0m…" : "…"), n + 1];
  }
  return [out, n];
}

/** The frame as lines. `cursor < 0` is the settled frame left on screen after the prompt ends —
 *  same list, no marker, no key hints to read as still-live.
 *  @param {Set<string>} selected @param {Map<string, unknown>} detected @param {number} cursor */
function frame(selected, detected, cursor) {
  const rows = [""];
  AGENTS.forEach((a, i) => {
    const on = selected.has(a.id);
    const here = i === cursor;
    // Nothing is ticked when this opens, so detection has to carry itself visually or the answer to
    // "which of these do I even have?" costs a keypress: a found agent is bold and says so, one that
    // is missing is dimmed whole. Both keep their word — only the automatic ticking went away.
    const found = !!detected.get(a.id);
    const label = found ? `${bold(a.label)}${dim("  (detected)")}` : dim(`${a.label}  (not detected)`);
    rows.push(`  ${here ? bold("❯") : " "} ${dim(`${i + 1}.`)} [${on ? "*" : " "}] ${label}`);
    // The plan follows the CURSOR as well as the tick. With an empty starting selection, tying it to
    // the tick alone would open on a list of three bare names — the commands each row would run are
    // the whole point of showing a plan before the install, and moving is cheaper than guessing.
    if (on || here) for (const line of a.plan()) rows.push(`         ${dim(line)}`);
  });
  rows.push("");
  if (cursor >= 0) rows.push(`  ${dim("↑↓ move · space select · enter install · esc/q quit")}`);
  return rows;
}

/** The visible width of every line in the frame currently on screen — not a count of them. See
 *  paint: after a resize those are different numbers, and it is the widths that survive. */
let painted = /** @type {number[]} */ ([]);

/** Redraw in place: back up over the last frame, overwrite it line by line, then erase whatever the
 *  old frame had below the new one (the block shrinks every time an agent is unticked). Never a
 *  screen clear and never a reprint — the banner above must survive and the scrollback must not
 *  collect one copy of the list per keypress.
 *  @param {string[]} rows */
function paint(rows) {
  const cols = process.stdout.columns ?? 80;
  // How many ROWS the last frame occupies right now, which is its line count only until the window
  // narrows under one of those lines: the terminal has since reflowed that line into two, and a
  // plain line count would move up too few and start redrawing inside the old frame. Both misses are
  // bounded and neither survives the next keypress, but they are not equally tidy — counting high
  // walks the block up over the banner and the trailing erase leaves that clean, while counting low
  // strands the old frame's top rows on screen. So when the two models disagree, this counts high.
  //
  // ponytail: assumes the emulator reflows on resize — Terminal.app, iTerm2, VS Code, Ghostty, vte
  // and Windows Terminal all do. One that clips instead (xterm) loses the banner for one frame.
  // Exact for both would need a cursor-position report round-tripped through the key decoder.
  const up = painted.reduce((n, w) => n + Math.max(1, Math.ceil(w / Math.max(cols, 1))), 0);
  const lines = rows.map((r) => fit(r, Math.max(cols - 2, 8)));
  painted = lines.map(([, w]) => w);
  process.stdout.write(
    `${up > 0 ? `\u001b[${up}A` : ""}\r${lines.map(([text]) => `\u001b[2K${text}`).join("\n")}\n\u001b[0J`,
  );
}

/** @param {Set<string>} selected @returns {Promise<"install"|"quit"|"interrupt"|"fallback">} */
function chooseArrows(selected) {
  // Fixed for the life of the prompt, and this runs per keypress — a PATH scan per arrow key is a
  // waste even when it is a fast one.
  const detected = new Map(AGENTS.map((a) => [a.id, a.detect()]));
  const stdin = process.stdin;
  // Open on the first agent this machine actually has, so the common single-agent case is
  // space-enter and never "arrow past the two I do not own". All-missing falls back to the top.
  let cursor = Math.max(AGENTS.findIndex((a) => detected.get(a.id)), 0);
  let live = true;
  painted = [];

  return new Promise((resolve) => {
    // ONE teardown, reached by every exit there is: Enter, q, Esc, Ctrl-C, Ctrl-D, a SIGINT sent
    // from somewhere else, and `exit` for an uncaught throw on the way out. Idempotent, so the
    // paths that overlap cost nothing. A CLI that hands back a terminal with no cursor, or still in
    // raw mode, is the kind of bug people remember the name of.
    const teardown = () => {
      if (!live) return;
      live = false;
      stdin.off("keypress", onKey);
      process.stdout.off("resize", onResize);
      process.off("SIGINT", onSigint);
      process.off("exit", teardown);
      try {
        stdin.setRawMode(false);
      } catch {}
      stdin.pause();
      process.stdout.write(SHOW_CURSOR);
    };
    const finish = (/** @type {"install"|"quit"|"interrupt"} */ result) => {
      if (!live) return;
      paint(frame(selected, detected, -1));
      teardown();
      resolve(result);
    };
    // Raw mode is why this one is safe where permission.ts's process-wide handler was not: this
    // script owns its process, the handler is only alive while the prompt is, and teardown removes
    // it. It is also nearly unreachable — in raw mode Ctrl-C is delivered as the \u0003 byte below,
    // not as a signal — so it is here for a `kill -INT` from elsewhere.
    const onSigint = () => finish("interrupt");
    // A resize is not a keypress, so without this the frame sits at the old width until the user
    // happens to touch a key — every line in it fitted to a window that no longer exists. It goes
    // through the same teardown as the rest: node keeps a SIGWINCH handler alive for as long as one
    // `resize` listener is attached, and this stream outlives the prompt by the whole install.
    //
    // It cannot interleave with a keypress redraw. Both are ordinary callbacks on one thread and
    // paint is a single synchronous write, so one always finishes before the other starts and a lock
    // here would be theatre. What DOES cross between them is `painted`, which is why that is the
    // widths of what is on screen rather than a count of lines — see paint.
    const onResize = () => paint(frame(selected, detected, cursor));
    /** @param {string} str @param {{name?: string, ctrl?: boolean}} [key] */
    const onKey = (str, key) => {
      const n = AGENTS.length;
      const name = key?.name;
      const toggle = (/** @type {number} */ i) => {
        const id = AGENTS[i].id;
        selected.has(id) ? selected.delete(id) : selected.add(id);
      };
      // Ctrl-C in raw mode is not a signal, it is this byte, and the process has to do the exiting
      // itself — including the non-zero status a shell expects from an interrupted command.
      if (key?.ctrl && name === "c") return finish("interrupt");
      if (name === "return" || name === "enter") return finish(selected.size > 0 ? "install" : "quit");
      // Ctrl-D is the same "no" it was when this prompt was a readline question.
      if (name === "escape" || name === "q" || (key?.ctrl && name === "d")) return finish("quit");
      if (name === "up" || name === "k") cursor = (cursor + n - 1) % n;
      else if (name === "down" || name === "j") cursor = (cursor + 1) % n;
      else if (name === "space") toggle(cursor);
      // The numbered list this replaced is muscle memory for anyone who ran an earlier version.
      else if (/^[1-9]$/.test(str) && Number(str) <= n) toggle((cursor = Number(str) - 1));
      else return; // unknown key: no repaint, no "not a choice" noise
      paint(frame(selected, detected, cursor));
    };

    process.stdout.on("resize", onResize);
    process.on("SIGINT", onSigint);
    process.on("exit", teardown);
    emitKeypressEvents(stdin, /** @type {any} */ (KEYS));
    stdin.on("keypress", onKey);
    try {
      stdin.setRawMode(true);
    } catch {
      // A TTY that will not go raw (some CI shims, an odd pty). Hand back the numbered list rather
      // than a prompt that cannot read a key — and unwind everything set up above first.
      teardown();
      return resolve("fallback");
    }
    stdin.resume();
    process.stdout.write(HIDE_CURSOR);
    paint(frame(selected, detected, cursor));
  });
}

/** @param {Set<string>} selected @returns {Promise<"install"|"quit"|"interrupt">} */
async function choose(selected) {
  if (process.stdout.isTTY && typeof process.stdin.setRawMode === "function") {
    const result = await chooseArrows(selected);
    if (result !== "fallback") return result;
  }
  return (await chooseNumbered(selected)) ? "install" : "quit";
}

/** The pre-arrow prompt, kept for a terminal that cannot go raw. Nothing here is dead code by
 *  choice: it is the only path left when setRawMode is missing or throws.
 *  @param {Set<string>} selected */
async function chooseNumbered(selected) {
  // `terminal: false` is the load-bearing word. readline turns it on from output.isTTY and then
  // sets raw mode ITSELF to do its own line editing — which on the one terminal this function
  // exists for is the call that just threw, and it would throw again out of createInterface and
  // take the whole install down with a stack trace. Off, the tty stays canonical and does the
  // echoing and the backspace handling in the kernel, which is all this prompt ever needed.
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  try {
    for (;;) {
      render(selected);
      let answer;
      try {
        answer = (
          await rl.question(`Type a number to toggle, ${bold("Enter")} to install, ${bold("q")} to quit: `)
        ).trim();
      } catch {
        // Ctrl+D closes stdin and node:readline/promises rejects with an AbortError. That is a user
        // saying "no", not a crash — printing a stack trace at someone who pressed Ctrl+D is exactly
        // the noise this file's error handling exists to avoid.
        say();
        return false;
      }
      if (answer === "") return selected.size > 0;
      if (answer === "q" || answer === "quit") return false;
      let understood = false;
      for (const tok of answer.split(/[\s,]+/)) {
        const n = Number(tok);
        if (Number.isInteger(n) && n >= 1 && n <= AGENTS.length) {
          const id = AGENTS[n - 1].id;
          selected.has(id) ? selected.delete(id) : selected.add(id);
          understood = true;
        }
      }
      if (!understood) say(`  ${dim(`not a choice: ${answer}`)}`);
    }
  } finally {
    rl.close();
  }
}

// ── the banner ───────────────────────────────────────────────────────────────────────────────────
//
// TYPOGRAPHIC, not pictorial — and that is a finding, not a shortcut. The Nomo mark is a soft
// pastel gradient with no strong silhouette: pre-rendered into the 6–9 rows that can sit above a
// 15-line install plan it collapses into a coral smudge beside a blue lump, whichever technique
// draws it (half-blocks, character density, arc-only, a redrawn thin sweep — all four were
// rendered and looked at; tools/make-banner.py still generates the block form if that call is
// ever revisited). What survives at terminal resolution is the icon's COLOUR, so that is all the
// banner keeps: the coral→periwinkle sweep, run across the wordmark and a rule under it.

const CORAL = [222, 152, 131]; // sampled straight off assets/icon.png — the arc's far end...
const PERI = [150, 158, 240]; //  ...and the blob, which is periwinkle, not the blue it looks at 1px
// Both source tones are pale enough to vanish on a white terminal, so every step is darkened by
// this much. At 0.78 the worst letter clears 4.5 : 1 against white AND against #1a1b1e, which is
// what lets ONE banner ship for light and dark terminals both.
const SWEEP_DIM = 0.78;
const TAGLINE = "Nomo plugin installer";

/** `s` painted with the icon's gradient, one 24-bit escape per character. Short strings only —
 *  this is ~15 bytes a char and the whole banner is under 40 of them.
 *  @param {string} s @param {boolean} [isBold] */
function sweep(s, isBold) {
  const n = Math.max(s.length - 1, 1);
  const body = [...s]
    .map((ch, i) => {
      const [r, g, b] = CORAL.map((a, k) => Math.round((a + ((PERI[k] - a) * i) / n) * SWEEP_DIM));
      return `\u001b[38;2;${r};${g};${b}m${ch}`;
    })
    .join("");
  return `${isBold ? "\u001b[1m" : ""}${body}\u001b[0m`;
}

function banner() {
  // Not a TTY means something is READING this — a pipe, a CI log, `| tee`. Colour there is noise,
  // so the whole lockup goes and not merely its colour; NO_COLOR lands in the same branch, because
  // an uncoloured rule under an uncoloured wordmark is just two lines of clutter. A window too
  // narrow to hold the rule gets the same one-liner, which was the entire output before any of
  // this existed.
  if (!COLOR || (process.stdout.columns ?? 0) < TAGLINE.length + 4) {
    say(`${bold("nomo-ai")} ${dim(VERSION)} — ${TAGLINE}`);
    return;
  }
  say();
  say(`  ${sweep("nomo-ai", true)} ${dim(VERSION)}`);
  say(`  ${sweep("─".repeat(TAGLINE.length))}`);
  say(`  ${dim(TAGLINE)}`);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────
//
// Wrapped in a function purely so every exit is `process.exitCode` + `return`, never `process.exit()`.
// console.log to a PIPE is asynchronous in node and process.exit() does not wait for it — the failure
// report below is the longest thing this script prints and the last thing before a non-zero exit,
// i.e. exactly the output a `bunx nomo-ai | tee install.log` would lose.

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.needsValue !== undefined) {
    err(`nomo-ai: ${args.needsValue} needs a branch or tag name\n`);
    err(USAGE);
    return 2;
  }
  if (args.bad !== undefined) {
    err(`nomo-ai: unknown argument: ${args.bad}\n`);
    err(USAGE);
    return 2;
  }
  if (args.help) {
    say(USAGE);
    return 0;
  }
  if (args.showVersion) {
    say(VERSION);
    return 0;
  }

  banner();

  const explicit = args.picked.size > 0;
  const found = AGENTS.filter((a) => a.detect()).map((a) => a.id);
  // The PROMPT opens with nothing ticked: this writes into ~/.claude, ~/.codex and
  // ~/.config/opencode, and a stray Enter should do nothing rather than install three things. What
  // was detected is still on screen, it just no longer ticks itself. --yes and the agent flags are
  // untouched — those are a caller who already said what they want.
  const selected = explicit ? args.picked : new Set(args.yes ? found : []);

  if (!explicit && found.length === 0) {
    err("\nnomo-ai: found no Claude Code, Codex or OpenCode install on this machine.");
    err("  Looked for `claude`, `codex`, `opencode` on PATH and ~/.claude, ~/.codex, ~/.config/opencode.");
    err("  Name one anyway with --claude / --codex / --opencode, or --all.");
    return 1;
  }

  // An agent flag IS the non-interactive signal — asking for confirmation of a selection the caller
  // just spelled out is theatre. Otherwise: prompt unless told not to, and refuse to guess when there
  // is no terminal to ask (a CI run that silently installed three agents is the worse outcome).
  if (!explicit && !args.yes) {
    if (!process.stdin.isTTY) {
      err("\nnomo-ai: not a terminal, so there is nobody to ask.");
      err("  Pass --yes to install everything detected, or name agents: --claude --codex --opencode / --all.");
      return 2;
    }
    const answer = await choose(selected);
    // Ctrl-C is not "no changes made", it is an interrupted command, and a shell expects to hear
    // that in the status. 130 is the conventional 128 + SIGINT, which is what the shell itself
    // would have reported had raw mode not swallowed the signal.
    if (answer === "interrupt") {
      say();
      return 130;
    }
    if (answer !== "install") {
      say("\nnomo-ai: nothing selected — no changes made.");
      return 0;
    }
  } else {
    render(selected);
  }

  if (REF) refCaveat(selected);

  if (DRY) say(dim("dry run — nothing will be written\n"));

  const failures = [];
  for (const agent of AGENTS.filter((a) => selected.has(a.id))) {
    say(bold(agent.label));
    const fail = agent.install();
    if (fail) {
      failures.push({ agent, ...fail });
      say(`  ${bold("FAILED")}`);
    } else {
      say(`  ${DRY ? "ok (dry run)" : "ok"}`);
    }
    say();
  }

  for (const f of failures) {
    err(`nomo-ai: ${f.agent.label} — FAILED`);
    err(`  ${f.error.split("\n").join("\n  ")}`);
    err(`  ${f.hint.split("\n").join("\n  ")}`);
    err("");
  }

  const done = AGENTS.filter((a) => selected.has(a.id) && !failures.some((f) => f.agent === a));
  if (done.length > 0 && !DRY) {
    say(bold("Next:"));
    for (const a of done) {
      say(`  ${a.label}`);
      for (const step of a.next) say(`    - ${step}`);
    }
    say();
    say(dim("Pairing is one QR scan from the Nomo app's Sessions tab. One pairing covers every agent."));
    say(dim("Docs: https://docs.nomo.gg"));
  }

  return failures.length > 0 ? 1 : 0;
}

process.exitCode = await main();
