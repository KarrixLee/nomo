#!/usr/bin/env node
// antigravity-install.mjs — wire Nomo into Google Antigravity (desktop app/IDE AND the `agy` CLI).
//
//   node plugin/scripts/antigravity-install.mjs              install / refresh
//   node plugin/scripts/antigravity-install.mjs --uninstall  remove exactly what install wrote
//
// Antigravity reads ONE global hooks file, ~/.gemini/config/hooks.json, whose top level is a set of
// NAMED hook blocks. Nomo owns exactly one, "nomo": install rewrites it wholesale, uninstall deletes
// it, and every other block (and its formatting-independent data) is left as it was. Never
// ~/.gemini/antigravity-cli/ — that is runtime data and is not read for hooks.
//
// The status events (SessionStart, PreInvocation, PostInvocation, Stop, PostToolUse) run
// plugin/scripts/antigravity-hook.sh, which prints `{}` before doing anything — observe only.
// PreToolUse (phone approvals, NOM-96 v2) runs plugin/scripts/antigravity-approve.sh, ONLY for the
// tools in APPROVAL_MATCHER (shell + file writes/edits). PreToolUse is FAIL-CLOSED (`{}`, a crash or a
// timeout BLOCK the tool), so that wrapper always prints a valid decision — `{"decision":"allow"}`,
// Antigravity's own policy, whenever the phone has not answered — and its timeout is Claude Code's
// PermissionRequest one (86400 s), with every internal deadline strictly inside it.
//
// SHAPES (a wrong one invalidates the WHOLE file): non-tool events take a FLAT handler list; only the
// tool events take `[{ matcher, hooks: [...] }]`.
//
// Refuses — writing nothing — on a hooks.json that is not valid JSON, not an object, or a dangling
// symlink. Writes through a live symlink (dotfiles), via temp file + rename, so a crash never leaves
// half a file. Zero dependencies, plain node >= 18, runs straight out of a fresh clone.

import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "scripts", "antigravity-hook.sh");
const APPROVE = join(ROOT, "scripts", "antigravity-approve.sh");
const BUNDLE = join(ROOT, "dist", "antigravity-status.mjs");
const APPROVE_BUNDLE = join(ROOT, "dist", "antigravity-approve.mjs");
const BLOCK = "nomo";
/** Seconds. Our own work is hard-capped at 4 s; the slack covers run.sh's first-ever runtime probe. */
const TIMEOUT = 10;
const FLAT_EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "Stop"];
const TOOL_EVENTS = ["PostToolUse"];
/** Mirrors ANTIGRAVITY_APPROVAL_MATCHER / ANTIGRAVITY_APPROVAL_TIMEOUT_S in core/antigravity-approval.ts
 *  (pinned equal by antigravity-approval.test.ts) — this script runs from a clone with no build step. */
const APPROVAL_MATCHER = "^(run_command|write_file|write_to_file|edit_file|replace_file_content|multi_replace_file_content)$";
const APPROVAL_TIMEOUT = 86400;

const fail = (msg) => {
  console.error(`antigravity-install: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const UNINSTALL = args.includes("--uninstall");
for (const a of args) {
  if (a === "-h" || a === "--help") {
    console.log("usage: antigravity-install.mjs [--uninstall]");
    process.exit(0);
  }
  if (a !== "--uninstall") fail(`unknown argument: ${a}`);
}

const CONFIG_DIR = join(homedir(), ".gemini", "config");
const HOOKS = join(CONFIG_DIR, "hooks.json");

const handler = (event) => ({ type: "command", command: `'${HOOK}' ${event}`, timeout: TIMEOUT });
const block = () => ({
  enabled: true,
  ...Object.fromEntries(FLAT_EVENTS.map((e) => [e, [handler(e)]])),
  ...Object.fromEntries(TOOL_EVENTS.map((e) => [e, [{ matcher: "*", hooks: [handler(e)] }]])),
  PreToolUse: [{ matcher: APPROVAL_MATCHER, hooks: [{ type: "command", command: `'${APPROVE}'`, timeout: APPROVAL_TIMEOUT }] }],
});

/** { doc, target, mode } — `doc` is `{}` when there is no file yet. */
function readHooks() {
  let link = null;
  try { link = lstatSync(HOOKS); } catch { /* no file */ }
  if (link === null) return { doc: {}, before: null, target: HOOKS, mode: undefined };
  if (link.isSymbolicLink() && !existsSync(HOOKS)) fail(`${HOOKS} is a symlink whose target does not exist — nothing was changed`);
  const target = realpathSync(HOOKS);
  const info = statSync(target);
  if (!info.isFile()) fail(`${HOOKS} is not a regular file — nothing was changed`);
  const before = readFileSync(target, "utf8");
  let doc;
  try {
    doc = before.trim() === "" ? {} : JSON.parse(before);
  } catch (e) {
    fail(`${HOOKS} is not valid JSON (${e.message}) — fix or move it, nothing was changed`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) fail(`${HOOKS} is not a JSON object — nothing was changed`);
  return { doc, before, target, mode: info.mode & 0o7777 };
}

/** Apply `edit` to the parsed file; write only if the DATA changed. Returns whether it wrote. */
function update(edit) {
  const { doc, before, target, mode } = readHooks();
  edit(doc);
  if (before !== null && before.trim() !== "" && JSON.stringify(JSON.parse(before)) === JSON.stringify(doc)) return false;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, mode === undefined ? undefined : { mode });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  return true;
}

try {
  if (UNINSTALL) {
    const changed = existsSync(HOOKS) && update((doc) => { delete doc[BLOCK]; });
    console.log(`antigravity-install: hooks -> ${changed ? `removed the "${BLOCK}" block from ${HOOKS}` : "no Nomo block found"}`);
    console.log("antigravity-install: pairing is untouched (it is shared with your other agents).");
  } else {
    // The root is written inside single quotes in every hook command.
    if (/['"$\\`]/.test(ROOT)) fail(`the plugin path contains one of ' " $ \\ \` and cannot be written into a hook command: ${ROOT}`);
    for (const f of [BUNDLE, APPROVE_BUNDLE]) if (!existsSync(f)) fail(`${f} is missing — run 'bun build.ts' from the repo root first`);
    if (!existsSync(HOOK) || !existsSync(APPROVE)) fail(`${HOOK} is missing — this does not look like a nomo plugin directory`);
    if (!existsSync(CONFIG_DIR)) fail(`${CONFIG_DIR} does not exist — open Antigravity once first`);
    const changed = update((doc) => { doc[BLOCK] = block(); });
    console.log(`antigravity-install: hooks -> ${HOOKS}${changed ? "" : " (already up to date)"}`);
    console.log(`antigravity-install:          block "${BLOCK}": ${[...FLAT_EVENTS, ...TOOL_EVENTS].join(", ")}, PreToolUse (phone approvals: shell commands + file writes)`);
    console.log("antigravity-install: restart Antigravity (and any open agy) so it re-reads hooks.json.");
  }
} catch (e) {
  fail(`could not finish — ${e?.message ?? e}`);
}
