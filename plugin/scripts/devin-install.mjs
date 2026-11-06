#!/usr/bin/env node
// devin-install.mjs — wire Nomo into Devin (the Devin CLI and Devin Desktop's "Devin Local" agent).
//
//   node plugin/scripts/devin-install.mjs              install / refresh
//   node plugin/scripts/devin-install.mjs --uninstall  remove exactly what install wrote
//   add --verbose for the technical lines
//
// Devin reads user-level hooks from the `"hooks"` key of ~/.config/devin/config.json — the same file
// that holds the user's other Devin settings, which are NOT ours to touch:
//
//   * an entry is ours only if every command in its `hooks` list is the exact string we write (for
//     any checkout path — see OWNED). Ours is replaced in place, otherwise appended; every other entry,
//     event and top-level key keeps its data, key order and position;
//   * uninstall removes only ours, and drops an event / the `hooks` key only when removing ours is
//     what emptied it;
//   * Devin's config is JSON "with comment support". A strict-JSON file is merged as is. A file that
//     only parses once comments are stripped is copied to config.json.nomo-backup first, then written
//     back without its comments (said in one line);
//   * unparseable, not an object, a dangling symlink, hard-linked, unwritable → refuse, write nothing;
//   * written to a temp file (the original's mode; a new file is 0600 in a 0700 dir) and renamed,
//     through a live symlink; the file is re-read just before the rename and the merge re-applied if
//     another tool wrote it in between. A file that already says what we want is not rewritten.
//
// The status hook observes (it prints only a phone Interrupt). The PermissionRequest hook — and the
// PreToolUse hook for Devin's `ask_user_question` — is the phone hold: Devin hooks
// are FAIL-OPEN (no output, a crash or a timeout = Devin's own prompt). Its command ends in `; exit 0`
// ON PURPOSE: Devin SIGKILLs the hook's direct child when it gives up, so a shell must stay between
// Devin and the bundle for the bundle to notice (its parent pid changes) and withdraw the phone card.
//
// Zero dependencies and no build step: plain node >= 18, so it runs straight out of a fresh clone.

import {
  accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Seconds. Mirrors DEVIN_APPROVAL_TIMEOUT_S in core/devin-approval.ts (pinned equal by
 *  devin-install.test.ts) — this script runs from a clone with no build step. */
export const APPROVAL_TIMEOUT = 86400;
/** Seconds for the status hook: one awaited 2 s POST plus, on a session's first prompt, a few `ps`. */
const STATUS_TIMEOUT = 10;

/** Our two commands for ANY checkout root (the backreference keeps both paths under one root).
 *  core/devin.ts DEVIN_INSTALLER_COMMAND is its TS twin (pinned equal by devin-install.test.ts). */
export const OWNED = /^'([^']+\/)scripts\/run\.sh' '\1dist\/devin-(status|approve)\.mjs'(; exit 0)?$/;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The hooks object Nomo registers for a plugin checkout at `root`. */
export function devinHooks(root) {
  const run = `'${root}/scripts/run.sh'`;
  const S = () => ({ type: "command", command: `${run} '${root}/dist/devin-status.mjs'`, timeout: STATUS_TIMEOUT });
  const A = () => ({ type: "command", command: `${run} '${root}/dist/devin-approve.mjs'; exit 0`, timeout: APPROVAL_TIMEOUT });
  return {
    UserPromptSubmit: [{ hooks: [S()] }],
    // Devin's question: held for the phone's answer (it fires PreToolUse, never PermissionRequest).
    PreToolUse: [{ matcher: "^ask_user_question$", hooks: [A()] }],
    PostToolUse: [{ hooks: [S()] }],
    Stop: [{ hooks: [S()] }],
    SessionEnd: [{ hooks: [S()] }],
    PermissionRequest: [{ hooks: [A()] }],
  };
}

/** The same hooks for the native Devin PLUGIN (repo-root hooks.json, pinned equal by
 *  devin-install.test.ts). The plugin root is the REPO root, known only at run time from Devin's env;
 *  `--via=devin-plugin` makes the bundle stand down when this installer's entries are also present
 *  (one install wins: this one). The approval command keeps the shell as the bundle's parent (no
 *  `exec`) for the same SIGKILL reason as above. */
export function devinPluginHooks() {
  const at = `R="\${DEVIN_PLUGIN_ROOT:-\${PLUGIN_ROOT:-}}"; [ -n "$R" ] && [ -f "$R/plugin/scripts/run.sh" ] && `;
  const cmd = (bundle, exec) =>
    `${at}${exec ? "exec " : ""}/bin/sh "$R/plugin/scripts/run.sh" "$R/plugin/dist/${bundle}" --via=devin-plugin; exit 0`;
  const out = devinHooks("");
  for (const list of Object.values(out)) {
    for (const entry of list) {
      for (const h of entry.hooks) {
        h.command = h.command.includes("devin-approve.mjs") ? cmd("devin-approve.mjs", false) : cmd("devin-status.mjs", true);
      }
    }
  }
  return out;
}

/** Where Devin records installed plugins (read only — never written by Nomo). */
export const devinPluginLock = () => join(homedir(), ".local", "share", "devin", "cli", "plugins", "lock.json");

/** Is the Nomo Devin plugin (manifest name `nomo`) installed, per the text of Devin's plugin lock.json?
 *  core/devin.ts devinPluginInstalled is its TS twin. */
export function devinPluginInstalled(lockText) {
  try {
    const resolved = JSON.parse(lockText)?.resolved;
    return Array.isArray(resolved) && resolved.some((r) => isObject(r) && r.name === "nomo");
  } catch {
    return false;
  }
}

/** Is this hooks entry one WE wrote? Every command in it must be OWNED. */
const isOurs = (entry) =>
  isObject(entry) && Array.isArray(entry.hooks) && entry.hooks.length > 0 &&
  entry.hooks.every((h) => isObject(h) && typeof h.command === "string" && OWNED.test(h.command));

/** JSONC → JSON: drops `//` and `/* *\/` comments, then trailing commas — never inside strings.
 *  `hadComments` is true when anything was dropped. */
export function stripJsonc(text) {
  // One string-aware scan; `drop` decides what happens to everything outside strings.
  const scan = (src, drop) => {
    let out = "";
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
        out += src.slice(i, j + 1);
        i = j;
        continue;
      }
      const skip = drop(src, i);
      if (skip === undefined) out += src[i];
      else { changed = true; out += skip.keep; i = skip.to; }
    }
    return out;
  };
  let changed = false;
  const noComments = scan(text, (src, i) => {
    if (src[i] !== "/") return undefined;
    if (src[i + 1] === "/") { const nl = src.indexOf("\n", i); return { keep: "\n", to: nl === -1 ? src.length : nl }; }
    if (src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); return { keep: " ", to: end === -1 ? src.length : end + 1 }; }
    return undefined;
  });
  const closer = /\s*[}\]]/y; // sticky: tested AT the char after the comma, no slicing
  const json = scan(noComments, (src, i) => {
    if (src[i] !== ",") return undefined;
    closer.lastIndex = i + 1;
    return closer.test(src) ? { keep: "", to: i } : undefined;
  });
  return { json, hadComments: changed };
}

/** `config` with Nomo's entries for `root` merged into `config.hooks` (a new object; the input is not
 *  mutated). Ours is replaced in place, otherwise appended; stale ours on events we no longer register
 *  go; nothing else changes. */
export function mergeHooks(config, root) {
  const out = structuredClone(config);
  const want = devinHooks(root);
  const hooks = (out.hooks ??= {});
  for (const event of Object.keys(hooks)) {
    if (event in want || !Array.isArray(hooks[event])) continue;
    const kept = hooks[event].filter((e) => !isOurs(e));
    if (kept.length !== hooks[event].length) {
      if (kept.length === 0) delete hooks[event]; else hooks[event] = kept;
    }
  }
  for (const [event, [entry]] of Object.entries(want)) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
    const at = list.findIndex(isOurs);
    if (at === -1) { list.push(entry); continue; }
    list[at] = entry;
    hooks[event] = list.filter((e, i) => i === at || !isOurs(e));
  }
  return out;
}

/** `config` without any of Nomo's entries (a new object). */
export function removeHooks(config) {
  const out = structuredClone(config);
  if (!isObject(out.hooks)) return out;
  let removed = false;
  for (const [event, list] of Object.entries(out.hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => !isOurs(e));
    if (kept.length === list.length) continue;
    removed = true;
    if (kept.length === 0) delete out.hooks[event]; else out.hooks[event] = kept;
  }
  if (removed && Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

// ── the file ─────────────────────────────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`devin-install: ${msg}`);
  process.exit(1);
}

const writable = (path) => {
  try {
    accessSync(path, constants.W_OK | (statSync(path).isDirectory() ? constants.X_OK : 0));
    return true;
  } catch {
    return false;
  }
};

/** The parsed config (or `{}` when there is none), the text it came from, the real file to replace,
 *  its mode/links, and whether it needed comments stripped. Anything we cannot safely edit exits. */
function readConfig(path) {
  let link = null;
  try { link = lstatSync(path); } catch { /* no such file */ }
  if (link === null) return { doc: {}, before: null, target: path, mode: undefined, links: 1, jsonc: false };
  if (link.isSymbolicLink() && !existsSync(path)) fail(`${path} is a symlink whose target does not exist — nothing was changed`);
  const target = realpathSync(path);
  const info = statSync(target);
  if (!info.isFile()) fail(`${path} is not a regular file — nothing was changed`);
  const before = readFileSync(target, "utf8");
  let doc;
  let jsonc = false;
  try {
    doc = JSON.parse(before);
  } catch {
    try {
      doc = JSON.parse(stripJsonc(before).json);
      jsonc = true;
    } catch (e) {
      fail(`${path} is not valid JSON (${e.message}) — fix or move it, nothing was changed`);
    }
  }
  if (!isObject(doc)) fail(`${path} is not a JSON object — nothing was changed`);
  if (doc.hooks !== undefined && !isObject(doc.hooks)) fail(`${path}: "hooks" is not an object — nothing was changed`);
  return { doc, before, target, mode: info.mode & 0o7777, links: info.nlink, jsonc };
}

const currentText = (target) => {
  try { return readFileSync(target, "utf8"); } catch { return null; }
};

/** Read → `change` → write, or nothing when the data already says what we want. Returns
 *  `{ wrote, backup }` (`backup` = where a commented original was copied). */
export function updateConfig(path, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { doc, before, target, mode, links, jsonc } = readConfig(path);
    const next = change(doc);
    if (before !== null && JSON.stringify(doc) === JSON.stringify(next)) return { wrote: false };
    if (links > 1) fail(`${path} has ${links} hard links — replacing it would detach it from its other name(s); nothing was changed`);
    const dir = dirname(target);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!writable(dir)) fail(`${dir} is not writable — cannot update ${path}, nothing was changed`);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      const fileMode = mode ?? 0o600;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: fileMode });
      chmodSync(tmp, fileMode); // exactly the original's bits, whatever the umask
      const pause = attempt === 0 ? Number(process.env.NOMO_DEVIN_INSTALL_TEST_PAUSE_MS) : 0; // TEST SEAM
      if (pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
      if (currentText(target) === before) {
        let backup;
        if (jsonc) {
          backup = `${path}.nomo-backup`;
          copyFileSync(target, backup);
          chmodSync(backup, mode ?? 0o600);
        }
        renameSync(tmp, target);
        return { wrote: true, backup };
      }
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  fail(`${path} kept changing while it was being updated (is another tool rewriting it?) — re-run`);
}

function main() {
  const args = process.argv.slice(2);
  for (const a of args) {
    if (a === "-h" || a === "--help") {
      console.log("usage: devin-install.mjs [--uninstall] [--verbose]");
      process.exit(0);
    }
    if (a !== "--uninstall" && a !== "--verbose") fail(`unknown argument: ${a}`);
  }
  const UNINSTALL = args.includes("--uninstall");
  const VERBOSE = args.includes("--verbose");
  const CONFIG = join(homedir(), ".config", "devin", "config.json");
  const say = (line) => console.log(`devin-install: ${line}`);
  const comments = (r) => {
    if (r.backup) say(`your config.json had comments; they were removed (original kept at ${r.backup})`);
  };
  try {
    if (UNINSTALL) {
      const r = existsSync(CONFIG) ? updateConfig(CONFIG, removeHooks) : { wrote: false };
      say(r.wrote ? "removed Nomo's hooks from Devin — restart devin" : "no Nomo hooks found in Devin's config");
      comments(r);
      if (VERBOSE) say(`config -> ${CONFIG}`);
      return;
    }
    // One install wins. The plugin defers to this installer's entries, so writing them now would
    // silently switch a working plugin install over to this checkout — say so and leave it.
    let lock = "";
    try { lock = readFileSync(devinPluginLock(), "utf8"); } catch { /* no plugins */ }
    if (devinPluginInstalled(lock)) {
      say("Nomo is already installed as a Devin plugin — nothing to do");
      return;
    }
    // ROOT is written inside single quotes in the hook commands.
    if (/['"$\\`\n]/.test(ROOT)) {
      fail(`the plugin path contains a quote, $, \\ or \` and cannot be written safely into a hook command: ${ROOT} — nothing was changed`);
    }
    for (const f of ["dist/devin-status.mjs", "dist/devin-approve.mjs"]) {
      if (!existsSync(join(ROOT, f))) fail(`${join(ROOT, f)} is missing — run 'bun build.ts' from the repo root first`);
    }
    if (!existsSync(join(ROOT, "scripts", "run.sh"))) fail(`${join(ROOT, "scripts", "run.sh")} is missing — this does not look like a nomo plugin directory`);
    const r = updateConfig(CONFIG, (doc) => mergeHooks(doc, ROOT));
    say(r.wrote ? "Devin sessions will now show in Nomo — restart devin (and Devin Desktop)" : "already set up — nothing changed");
    comments(r);
    if (VERBOSE) {
      say(`config -> ${CONFIG}`);
      say(`status hook   -> ${join(ROOT, "dist", "devin-status.mjs")} (UserPromptSubmit, PostToolUse, Stop, SessionEnd)`);
      say(`approval hook -> ${join(ROOT, "dist", "devin-approve.mjs")} (PermissionRequest, PreToolUse ask_user_question, timeout ${APPROVAL_TIMEOUT}s)`);
    }
  } catch (e) {
    fail(`could not finish — ${e?.message ?? e}`);
  }
}

// Only when executed directly — the tests import the pure exports above.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
