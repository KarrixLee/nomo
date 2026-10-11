#!/usr/bin/env node
// cursor-install.mjs — wire Nomo into Cursor (the desktop app's agent AND the `cursor-agent` CLI).
//
//   node plugin/scripts/cursor-install.mjs               install / refresh
//   node plugin/scripts/cursor-install.mjs --uninstall   remove exactly what install wrote
//   node plugin/scripts/cursor-install.mjs --force       also overwrite a same-named skill we did not write
//
// WHY A MERGE INTO hooks.json AND NOT A CURSOR PLUGIN. Cursor's plugin docs describe plugins for the
// desktop app (Customize panel, `~/.cursor/plugins/local/`, "Reload Window") and say nothing about the
// CLI loading them; they also leave unsaid whether a plugin's hook commands can address their own
// install path. The user-level `hooks.json` is the one hook source documented for Cursor itself and
// the one other tools already rely on for the CLI. So Nomo's entries go there — next to whatever is
// already in the file, which is NOT ours to touch:
//
//   * unparseable, not the shape we expect, a dangling symlink, hard-linked, or somewhere we cannot
//     write → refuse, write nothing, say why;
//   * `"version": 1` is added only when the key is missing;
//   * an entry is ours only if it is on an event we register AND its `command` is the exact string we
//     write (or the same string for a different checkout path) AND it has no key we do not write —
//     see isOurs below. Every other entry, event and top-level key keeps its data, its key order and
//     its position;
//   * append only if absent; uninstall removes only ours, and drops an event only when removing ours
//     is what emptied it;
//   * the FILE is re-serialised (2-space JSON) whenever something actually changes, so hand
//     formatting is not kept — a file that already says what we want is not rewritten at all;
//   * written to a temp file (same mode as the original) and renamed, so a crash never leaves half a
//     hooks.json; the file is re-read just before the rename and the merge re-applied if another tool
//     wrote it in between.
//
// The hook command addresses THIS checkout by absolute path. That is safe to persist because the
// installer runs from a checkout the user owns (`~/.nomo`, via `bunx nomo-ai --cursor`), not from a
// host's version-pinned plugin cache — it never moves on update, it is just `git pull`ed.
//
// Zero dependencies and no build step: plain node >= 18, so it runs straight out of a fresh clone.

import {
  accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "dist", "cursor-status.mjs");
const RUN = join(ROOT, "scripts", "run.sh");
const SKILLS = join(ROOT, "cursor-skills");
const MARK = "nomo-cursor-install";

/** The events Nomo observes. None is a tool/shell/MCP/file permission gate. `beforeSubmitPrompt` is
 *  the one event here whose hook OUTPUT Cursor honours (`continue: false` blocks the prompt); ours
 *  prints nothing, so it never does — but Cursor does wait for it, so a slow hook delays the submit
 *  (see TIMEOUT). The rest are after/lifecycle events that cannot block or steer anything.
 *    both surfaces: sessionStart, beforeSubmitPrompt, postToolUse, afterShellExecution, afterFileEdit, stop
 *    app-only extras: postToolUseFailure (keep-alive through failing tools), sessionEnd (clean end) */
const EVENTS = [
  "sessionStart", "beforeSubmitPrompt", "postToolUse", "postToolUseFailure",
  "afterShellExecution", "afterFileEdit", "stop", "sessionEnd",
];
/** Seconds. The hook's own worst case is one awaited 2 s POST (relay unreachable) plus, on a chat's
 *  first prompt, a handful of `ps` calls; this is only the ceiling Cursor enforces. */
const TIMEOUT = 10;

const COMMAND = `'${RUN}' '${BUNDLE}'`;
/** The command we write, for ANY checkout path: two single-quoted paths under ONE root (the
 *  backreference). Matching any root is what lets a re-install from a moved checkout replace its old
 *  entries instead of firing every event twice. */
const OWNED = /^'([^']+\/)scripts\/run\.sh' '\1dist\/cursor-status\.mjs'$/;
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** Is this entry one WE wrote? All three, or it is somebody else's and is never touched:
 *    - it sits on an event we register (our command on any other event was put there by its owner);
 *    - its command is exactly the OWNED shape;
 *    - it has no key but the two we write. `timeout`'s VALUE is free — it is ours across versions and
 *      a user may tune it — but a `matcher`, `failClosed`, … means someone made the entry their own. */
const isOurs = (event, entry) =>
  EVENTS.includes(event) && isObject(entry) && typeof entry.command === "string" && OWNED.test(entry.command) &&
  Object.keys(entry).every((k) => k === "command" || k === "timeout");

const fail = (msg) => {
  console.error(`cursor-install: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const UNINSTALL = args.includes("--uninstall");
const FORCE = args.includes("--force");
for (const a of args) {
  if (a === "-h" || a === "--help") {
    console.log("usage: cursor-install.mjs [--uninstall] [--force]");
    process.exit(0);
  }
  if (a !== "--uninstall" && a !== "--force") fail(`unknown argument: ${a}`);
}

const CURSOR_DIR = process.env.CURSOR_CONFIG_DIR || join(homedir(), ".cursor");
const HOOKS = join(CURSOR_DIR, "hooks.json");

if (!UNINSTALL) {
  // ROOT is written inside single quotes in the hook command and inside DOUBLE quotes in every skill
  // (`NOMOR="<root>"`), where `$(…)`, backticks, `"` and `\` would run, expand or break out.
  if (/['"$\\`]/.test(ROOT)) {
    fail(`the plugin path contains one of ' " $ \\ \` and cannot be written safely into a hook command: ${ROOT}\n` +
      "cursor-install: move the checkout to a path without those characters and re-run — nothing was changed");
  }
  if (!existsSync(BUNDLE)) fail(`${BUNDLE} is missing — run 'bun build.ts' from the repo root first`);
  if (!existsSync(RUN)) fail(`${RUN} is missing — this does not look like a nomo plugin directory`);
  if (!existsSync(CURSOR_DIR)) {
    fail(`${CURSOR_DIR} does not exist — open Cursor (or run cursor-agent) once, or set CURSOR_CONFIG_DIR`);
  }
}

// ── hooks.json ───────────────────────────────────────────────────────────────────────────────────

const writable = (path) => {
  try {
    accessSync(path, constants.W_OK | (statSync(path).isDirectory() ? constants.X_OK : 0));
    return true;
  } catch {
    return false;
  }
};

/** The parsed file, or a fresh skeleton when there is none; `target` is the real file a write must
 *  replace and `mode` its permission bits. Anything we cannot safely edit exits. */
function readHooks() {
  let link = null;
  try { link = lstatSync(HOOKS); } catch { /* no such file */ }
  if (link === null) return { doc: { version: 1, hooks: {} }, before: null, target: HOOKS, mode: undefined, links: 1 };
  if (link.isSymbolicLink() && !existsSync(HOOKS)) {
    fail(`${HOOKS} is a symlink whose target does not exist — fix or remove the link, nothing was changed`);
  }
  // Through a live symlink, not over it: a dotfiles-managed hooks.json must stay a link to the same file.
  const target = realpathSync(HOOKS);
  const info = statSync(target);
  if (!info.isFile()) fail(`${HOOKS} is not a regular file — nothing was changed`);
  const before = readFileSync(target, "utf8");
  let doc;
  try {
    doc = JSON.parse(before);
  } catch (e) {
    fail(`${HOOKS} is not valid JSON (${e.message}) — fix or move it, nothing was changed`);
  }
  if (!isObject(doc)) fail(`${HOOKS} is not a JSON object — nothing was changed`);
  if (doc.hooks !== undefined && !isObject(doc.hooks)) fail(`${HOOKS}: "hooks" is not an object — nothing was changed`);
  for (const [event, entries] of Object.entries(doc.hooks ?? {})) {
    if (!Array.isArray(entries)) fail(`${HOOKS}: hooks.${event} is not an array — nothing was changed`);
  }
  return { doc, before, target, mode: info.mode & 0o7777, links: info.nlink };
}

const currentText = (target) => {
  try { return readFileSync(target, "utf8"); } catch { return null; }
};

/** Read → `merge` → write, or do nothing when the file already says what we want (compared as DATA,
 *  so such a file is left exactly as its owner formatted it). Returns whether it wrote.
 *
 *  LOST UPDATES: hooks.json is shared, and a rename replaces whatever is there. So the file is re-read
 *  immediately before the rename; if it is not the text the merge started from, the temp file is
 *  discarded and the merge re-applied to the fresh content.
 *  ponytail: optimistic, not locked — a write landing in the instant between that re-read and the
 *  rename is still lost. Cursor defines no lock for this file; closing the gap needs one. */
function updateHooks(merge) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { doc, before, target, mode, links } = readHooks();
    merge(doc);
    if (before !== null && JSON.stringify(JSON.parse(before)) === JSON.stringify(doc)) return false;
    // A rename gives the path a NEW inode: every other hard link would silently keep the old content.
    if (links > 1) {
      fail(`${HOOKS} has ${links} hard links — replacing it would detach it from its other name(s); ` +
        "edit it by hand or remove the extra link, nothing was changed");
    }
    if (!writable(dirname(target))) fail(`${dirname(target)} is not writable — cannot update ${HOOKS}, nothing was changed`);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, mode === undefined ? undefined : { mode });
      if (mode !== undefined) chmodSync(tmp, mode); // exactly the original's bits, whatever the umask
      // TEST SEAM (cursor-install.test.ts): hold here so a test can play "another tool" deterministically.
      const pause = attempt === 0 ? Number(process.env.NOMO_CURSOR_INSTALL_TEST_PAUSE_MS) : 0;
      if (pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
      if (currentText(target) === before) {
        renameSync(tmp, target);
        return true;
      }
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  fail(`${HOOKS} kept changing while it was being updated (is another tool rewriting it?) — re-run`);
}

function mergeInstall(doc) {
  if (doc.version === undefined) doc.version = 1;
  if (doc.hooks === undefined) doc.hooks = {};
  for (const [event, entries] of Object.entries(doc.hooks)) {
    // An entry of ours from another checkout path goes. The key itself stays where it is — ours are
    // only ever on events the loop below refills.
    const kept = entries.filter((e) => !isOurs(event, e) || e.command === COMMAND);
    if (kept.length !== entries.length) doc.hooks[event] = kept;
  }
  for (const event of EVENTS) {
    const entries = (doc.hooks[event] ??= []);
    if (!entries.some((e) => e?.command === COMMAND)) entries.push({ command: COMMAND, timeout: TIMEOUT });
  }
}

function mergeUninstall(doc) {
  for (const [event, entries] of Object.entries(doc.hooks ?? {})) {
    const kept = entries.filter((e) => !isOurs(event, e));
    if (kept.length === entries.length) continue; // nothing of ours here — not even an empty array is touched
    if (kept.length === 0) delete doc.hooks[event]; // removing OURS is what emptied it
    else doc.hooks[event] = kept;
  }
}

// ── skills (/nomo-pair, /nomo-unpair, /nomo-status, /nomo-reset) ─────────────────────────────────
//
// Skills, not `commands/*.md`: Cursor is migrating slash commands to skills, documents
// `~/.cursor/skills/<name>/SKILL.md` as the user-level location, and the CLI's `/` menu lists skills.

const skillNames = () => (existsSync(SKILLS) ? readdirSync(SKILLS).filter((n) => existsSync(join(SKILLS, n, "SKILL.md"))) : []);
const skillDest = (name) => join(CURSOR_DIR, "skills", name, "SKILL.md");
const wroteIt = (path) => existsSync(path) && readFileSync(path, "utf8").includes(MARK);

/** Every refusal the skills can cause, with NOTHING written: a same-named skill we did not write, or
 *  a place we cannot write to. Returns the names to install. */
function claimSkills() {
  const names = skillNames();
  if (names.length === 0) fail(`no skills found in ${SKILLS}`);
  for (const name of names) {
    const dest = skillDest(name);
    if (existsSync(dest) && !wroteIt(dest) && !FORCE) {
      fail(`${dest} already exists and was not written by this script — move it aside, or re-run with --force`);
    }
    // The file itself if it exists, else the nearest directory that does (the rest gets created).
    let at = dest;
    while (!existsSync(at)) at = dirname(at);
    if (!writable(at)) fail(`${at} is not writable — cannot install the /${name} skill, nothing was changed`);
  }
  return names;
}

function writeSkills(names) {
  for (const name of names) {
    const dest = skillDest(name);
    // A function, not a string: a replacement STRING would expand `$&`-style patterns in the path.
    const body = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8").replaceAll("__NOMO_ROOT__", () => ROOT);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, `${body.trimEnd()}\n\n<!-- ${MARK} -->\n`);
  }
}

function uninstallSkills() {
  const dir = join(CURSOR_DIR, "skills");
  const removed = [];
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!name.startsWith("nomo-") || !wroteIt(skillDest(name))) continue;
    rmSync(skillDest(name));
    try { rmdirSync(join(dir, name)); } catch { /* the user put something else in it */ }
    removed.push(name);
  }
  return removed;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

try {
  if (UNINSTALL) {
    // A hooks.json that is not there (a dangling symlink included) has nothing of ours to remove.
    const changed = existsSync(HOOKS) ? updateHooks(mergeUninstall) : false;
    const removed = uninstallSkills();
    console.log(`cursor-install: hooks    -> ${changed ? `removed Nomo's entries from ${HOOKS}` : "no Nomo entries found"}`);
    console.log(`cursor-install: skills   -> ${removed.length > 0 ? `removed ${removed.map((n) => `/${n}`).join(" ")}` : "none found"}`);
    console.log("cursor-install: pairing is untouched (it is shared with your other agents) — run /nomo-unpair there to drop it.");
  } else {
    // Every refusal happens before the first write. claimSkills only CHECKS (ownership and
    // writability of every skill destination); hooks.json is then the first thing written, and
    // updateHooks does all of its own refusing — unparseable, wrong shape, dangling or hard-linked,
    // unwritable — before it writes. Only then are the skills written.
    const names = claimSkills();
    const changed = updateHooks(mergeInstall);
    writeSkills(names);
    console.log(`cursor-install: hooks    -> ${HOOKS}${changed ? "" : " (already up to date)"}`);
    console.log(`cursor-install:             ${EVENTS.length} events run ${BUNDLE}`);
    console.log(`cursor-install: skills   -> ${names.map((n) => `/${n}`).join(" ")}`);
    console.log(`cursor-install:             in ${join(CURSOR_DIR, "skills")}/`);
    console.log("cursor-install: restart Cursor (and any open cursor-agent) so it re-reads hooks.json.");
    console.log("cursor-install: then run /nomo-status — or /nomo-pair if this computer has never been paired.");
  }
} catch (e) {
  // A filesystem error the checks above did not predict (a race, a full disk): named, never a stack.
  fail(`could not finish — ${e?.message ?? e}`);
}
