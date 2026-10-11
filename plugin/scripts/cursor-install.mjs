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
//   * unparseable, or not the shape we expect → refuse, write nothing, say why;
//   * `"version": 1` is added only when the key is missing;
//   * an entry is ours only if its `command` is the exact string we write (or the same string for a
//     different checkout path — see OWNED below); everything else is left byte-for-byte in place;
//   * append only if absent; uninstall removes only ours and drops an event whose array empties;
//   * written to a temp file and renamed, so a crash never leaves half a hooks.json.
//
// The hook command addresses THIS checkout by absolute path. That is safe to persist because the
// installer runs from a checkout the user owns (`~/.nomo`, via `bunx nomo-ai --cursor`), not from a
// host's version-pinned plugin cache — it never moves on update, it is just `git pull`ed.
//
// Zero dependencies and no build step: plain node >= 18, so it runs straight out of a fresh clone.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "dist", "cursor-status.mjs");
const RUN = join(ROOT, "scripts", "run.sh");
const SKILLS = join(ROOT, "cursor-skills");
const MARK = "nomo-cursor-install";

/** The events Nomo observes. Every one is an AFTER/lifecycle event: none is a permission gate, so
 *  nothing this hook does (or fails to do) can block or steer Cursor.
 *    both surfaces: sessionStart, beforeSubmitPrompt, postToolUse, afterShellExecution, afterFileEdit, stop
 *    app-only extras: postToolUseFailure (keep-alive through failing tools), sessionEnd (clean end) */
const EVENTS = [
  "sessionStart", "beforeSubmitPrompt", "postToolUse", "postToolUseFailure",
  "afterShellExecution", "afterFileEdit", "stop", "sessionEnd",
];
/** Seconds. The hook's own worst case is one 2 s POST; this is only the ceiling Cursor enforces. */
const TIMEOUT = 10;

const COMMAND = `'${RUN}' '${BUNDLE}'`;
/** Ours by shape: the exact command above, for ANY checkout path. cursor-status.mjs is a bundle name
 *  only Nomo ships, so this cannot match another tool — and it is what lets a re-install from a moved
 *  checkout replace its old entries instead of firing every event twice. */
const OWNED = /^'[^']+\/scripts\/run\.sh' '[^']+\/dist\/cursor-status\.mjs'$/;
const isOurs = (entry) => typeof entry?.command === "string" && OWNED.test(entry.command);

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
  if (ROOT.includes("'")) fail(`the plugin path contains a quote and cannot be written safely: ${ROOT}`);
  if (!existsSync(BUNDLE)) fail(`${BUNDLE} is missing — run 'bun build.ts' from the repo root first`);
  if (!existsSync(RUN)) fail(`${RUN} is missing — this does not look like a nomo plugin directory`);
  if (!existsSync(CURSOR_DIR)) {
    fail(`${CURSOR_DIR} does not exist — open Cursor (or run cursor-agent) once, or set CURSOR_CONFIG_DIR`);
  }
}

// ── hooks.json ───────────────────────────────────────────────────────────────────────────────────

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The parsed file, or a fresh skeleton when there is none. Anything we cannot safely edit exits. */
function readHooks() {
  if (!existsSync(HOOKS)) return { doc: { version: 1, hooks: {} }, before: null };
  const before = readFileSync(HOOKS, "utf8");
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
  return { doc, before };
}

function writeHooks(doc, before) {
  const after = `${JSON.stringify(doc, null, 2)}\n`;
  // Compared as DATA, not text: a file that already says what we want is left exactly as its owner
  // formatted it.
  if (before !== null && JSON.stringify(JSON.parse(before)) === JSON.stringify(doc)) return false;
  // Through a symlink, not over it: a dotfiles-managed hooks.json must stay a link to the same file.
  const target = before !== null ? realpathSync(HOOKS) : HOOKS;
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, after);
  renameSync(tmp, target);
  return true;
}

function installHooks({ doc, before }) {
  if (doc.version === undefined) doc.version = 1;
  if (doc.hooks === undefined) doc.hooks = {};
  for (const [event, entries] of Object.entries(doc.hooks)) {
    // An entry of ours on an event we no longer register, or from another checkout path, goes.
    const kept = entries.filter((e) => !isOurs(e) || (EVENTS.includes(event) && e.command === COMMAND));
    if (kept.length === entries.length) continue;
    if (kept.length === 0) delete doc.hooks[event];
    else doc.hooks[event] = kept;
  }
  for (const event of EVENTS) {
    const entries = (doc.hooks[event] ??= []);
    if (!entries.some((e) => e?.command === COMMAND)) entries.push({ command: COMMAND, timeout: TIMEOUT });
  }
  return writeHooks(doc, before);
}

function uninstallHooks() {
  if (!existsSync(HOOKS)) return false;
  const { doc, before } = readHooks();
  for (const [event, entries] of Object.entries(doc.hooks ?? {})) {
    const kept = entries.filter((e) => !isOurs(e));
    if (kept.length === entries.length) continue; // nothing of ours here — not even an empty array is touched
    if (kept.length === 0) delete doc.hooks[event];
    else doc.hooks[event] = kept;
  }
  return writeHooks(doc, before);
}

// ── skills (/nomo-pair, /nomo-unpair, /nomo-status, /nomo-reset) ─────────────────────────────────
//
// Skills, not `commands/*.md`: Cursor is migrating slash commands to skills, documents
// `~/.cursor/skills/<name>/SKILL.md` as the user-level location, and the CLI's `/` menu lists skills.

const skillNames = () => (existsSync(SKILLS) ? readdirSync(SKILLS).filter((n) => existsSync(join(SKILLS, n, "SKILL.md"))) : []);
const skillDest = (name) => join(CURSOR_DIR, "skills", name, "SKILL.md");
const wroteIt = (path) => existsSync(path) && readFileSync(path, "utf8").includes(MARK);

function installSkills() {
  const names = skillNames();
  if (names.length === 0) fail(`no skills found in ${SKILLS}`);
  // Claim every destination BEFORE writing any, so a refusal leaves nothing half-installed.
  for (const name of names) {
    const dest = skillDest(name);
    if (existsSync(dest) && !wroteIt(dest) && !FORCE) {
      fail(`${dest} already exists and was not written by this script — move it aside, or re-run with --force`);
    }
  }
  for (const name of names) {
    const dest = skillDest(name);
    const body = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8").replaceAll("__NOMO_ROOT__", ROOT);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, `${body.trimEnd()}\n\n<!-- ${MARK} -->\n`);
  }
  return names;
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

if (UNINSTALL) {
  const changed = uninstallHooks();
  const removed = uninstallSkills();
  console.log(`cursor-install: hooks    -> ${changed ? `removed Nomo's entries from ${HOOKS}` : "no Nomo entries found"}`);
  console.log(`cursor-install: skills   -> ${removed.length > 0 ? `removed ${removed.map((n) => `/${n}`).join(" ")}` : "none found"}`);
  console.log("cursor-install: pairing is untouched (it is shared with your other agents) — run /nomo-unpair there to drop it.");
} else {
  // Every refusal happens before the first write: hooks.json is parsed and validated, then every
  // skill destination is claimed, and only then is anything written.
  const state = readHooks();
  const names = installSkills();
  const changed = installHooks(state);
  console.log(`cursor-install: hooks    -> ${HOOKS}${changed ? "" : " (already up to date)"}`);
  console.log(`cursor-install:             ${EVENTS.length} events run ${BUNDLE}`);
  console.log(`cursor-install: skills   -> ${names.map((n) => `/${n}`).join(" ")}`);
  console.log(`cursor-install:             in ${join(CURSOR_DIR, "skills")}/`);
  console.log("cursor-install: restart Cursor (and any open cursor-agent) so it re-reads hooks.json.");
  console.log("cursor-install: then run /nomo-status — or /nomo-pair if this computer has never been paired.");
}
