// How the plugin's own output (status, reset) names a terminal command. Its own module, not shared.ts,
// so the hook bundles that inline shared.ts do not carry it.

import { readFileSync } from "node:fs";
import { CC_DIR } from "./shared";

/** What the installer (bin/nomo-ai.mjs) last recorded about the short `nomo` command: "1" usable,
 *  "0" not (skipped with --no-global, or the global install failed). */
export const SHORT_COMMAND_PATH = `${CC_DIR}/short-command`;

/** A terminal command as the user should type it: `nomo pair` when the installer recorded the short
 *  command, `bunx nomo-ai pair` when it recorded "not installed", both when nothing was recorded (an installer
 *  from before the record, or the record unreadable). Never `bunx nomo …`: that package is not ours.
 *  Read from the record, never by probing PATH. */
export function terminalCommand(cmd: string, recordPath: string = SHORT_COMMAND_PATH): string {
  let rec = "";
  try {
    rec = readFileSync(recordPath, "utf8").trim();
  } catch {}
  if (rec === "1") return `nomo ${cmd}`;
  if (rec === "0") return `bunx nomo-ai ${cmd}`;
  return `nomo ${cmd} (or bunx nomo-ai ${cmd})`;
}
