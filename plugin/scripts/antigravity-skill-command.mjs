// antigravity-skill-command.mjs — THE one template for the shell commands Nomo's Antigravity skills run.
//
// Two readers, one source: antigravity-install.mjs expands `{{nomo-command <key>}}` in each SKILL.md
// with it, and the phone-approval hook (core/antigravity-approval.ts) rebuilds the SAFE ones with it to
// recognise Nomo's own commands byte for byte — so /nomo-status never puts a card on the phone. The
// hook never reads SKILL.md. Plain node, no dependencies: the installer runs from a fresh clone.

/** key → [script in dist/, its arguments]. */
export const SKILL_COMMANDS = {
  "status": ["status-cmd.mjs", "antigravity --plain"],
  "status-verbose": ["status-cmd.mjs", "antigravity"],
  "approvals-status": ["cc-permission.mjs", "status"],
  "approvals-on": ["cc-permission.mjs", "on"],
  "approvals-off": ["cc-permission.mjs", "off"],
  "reset": ["reset.mjs", ""],
  "unpair": ["unpair.mjs", ""],
  "pair": ["pair.mjs", ""],
  "pair-code": ["pair.mjs", "--show-code"],
  "pair-wait": ["pair.mjs", "wait --timeout 60"],
};

/** Run without a phone card: they only read state, restore the default, or start/finish pairing. NOT
 *  here (they still ask the phone): pausing approvals, unpairing, printing the typed pairing code. */
export const SAFE_SKILL_COMMANDS = ["status", "status-verbose", "approvals-status", "approvals-on", "reset", "pair", "pair-wait"];

/** The exact command line for `key` under plugin root `root` (which the installer has already checked
 *  for quotes, `$`, backslashes, backticks and newlines). */
export function skillCommand(root, key) {
  const entry = SKILL_COMMANDS[key];
  if (!entry) throw new Error(`unknown Nomo skill command: ${key}`);
  const [script, args] = entry;
  return `'${root}/scripts/run.sh' '${root}/dist/${script}'${args ? ` ${args}` : ""}`;
}

/** A SKILL.md template with every `{{nomo-command <key>}}` replaced. */
export function expandSkillTemplate(text, root) {
  return text.replace(/\{\{nomo-command ([a-z-]+)\}\}/g, (_, key) => skillCommand(root, key));
}
