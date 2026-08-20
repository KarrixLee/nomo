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
  -h, --help              this
  -v, --version           print the version

Nothing here pairs your phone — that stays a deliberate step you run from inside the
agent afterwards (/nomo-cc:pair, $nomo-pair, /nomo-pair).`;

// ── plumbing ─────────────────────────────────────────────────────────────────────────────────────

let DRY = false;

const bold = (s) => (process.stdout.isTTY ? `\u001b[1m${s}\u001b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\u001b[2m${s}\u001b[0m` : s);
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
    plan: [`claude plugin marketplace add ${REPO}`, `claude plugin install nomo-cc@nomo -y`],
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
    plan: [`codex plugin marketplace add ${REPO}`, `codex plugin add nomo@nomo`],
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
    plan: [`git clone ${CLONE_URL} ${CHECKOUT}`, `${CHECKOUT}/plugin/scripts/opencode-install.sh`],
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
        const remote = spawnSync("git", ["-C", CHECKOUT, "remote", "get-url", "origin"], { encoding: "utf8" });
        if (!(remote.stdout || "").includes(REPO)) {
          return {
            error: `${CHECKOUT} is a git checkout of something else (origin: ${(remote.stdout || "?").trim()})`,
            hint: `Move it aside, then re-run. Or install from a checkout you already have:\n    <checkout>/plugin/scripts/opencode-install.sh`,
          };
        }
        say(`  ${dim(`${CHECKOUT} already exists — updating`)}`);
        const fail = run("git", ["-C", CHECKOUT, "pull", "--ff-only"]);
        if (fail) {
          return {
            error: fail,
            hint: `Local commits or a dirty tree in ${CHECKOUT}? Sort it out there, then re-run.`,
          };
        }
      } else if (existsSync(CHECKOUT)) {
        return {
          error: `${CHECKOUT} exists but is not a git checkout`,
          hint: `Move it aside and re-run, or run the installer from a checkout you already have:\n    <checkout>/plugin/scripts/opencode-install.sh`,
        };
      } else {
        const fail = run("git", ["clone", "--depth", "1", CLONE_URL, CHECKOUT]);
        if (fail) return { error: fail, hint: "Check network access to github.com and re-run." };
      }
      if (!DRY && !existsSync(script)) {
        return { error: `${script} is missing from the checkout`, hint: `Delete ${CHECKOUT} and re-run.` };
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
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { help: true };
    else if (a === "-v" || a === "--version") return { showVersion: true };
    else if (a === "-y" || a === "--yes") yes = true;
    else if (a === "-n" || a === "--dry-run") DRY = true;
    else if (a === "--all") for (const ag of AGENTS) picked.add(ag.id);
    else if (a.startsWith("--") && AGENTS.some((ag) => ag.id === a.slice(2))) picked.add(a.slice(2));
    else return { bad: a };
  }
  return { picked, yes };
}

// ── the prompt ───────────────────────────────────────────────────────────────────────────────────

function render(selected) {
  say();
  AGENTS.forEach((a, i) => {
    const on = selected.has(a.id);
    say(`  ${i + 1}. [${on ? "x" : " "}] ${bold(a.label)}${a.detect() ? "" : dim("  (not detected)")}`);
    if (on) for (const line of a.plan) say(`         ${dim(line)}`);
  });
  say();
}

async function choose(selected) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
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

// ── main ─────────────────────────────────────────────────────────────────────────────────────────
//
// Wrapped in a function purely so every exit is `process.exitCode` + `return`, never `process.exit()`.
// console.log to a PIPE is asynchronous in node and process.exit() does not wait for it — the failure
// report below is the longest thing this script prints and the last thing before a non-zero exit,
// i.e. exactly the output a `bunx nomo-ai | tee install.log` would lose.

async function main() {
  const args = parseArgs(process.argv.slice(2));
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

  say(`${bold("nomo-ai")} ${dim(VERSION)} — Nomo plugin installer`);

  const explicit = args.picked.size > 0;
  const selected = explicit ? args.picked : new Set(AGENTS.filter((a) => a.detect()).map((a) => a.id));

  if (!explicit && selected.size === 0) {
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
    if (!(await choose(selected))) {
      say("\nnomo-ai: nothing selected — no changes made.");
      return 0;
    }
  } else {
    render(selected);
  }

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
