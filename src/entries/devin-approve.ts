// devin-approve — the Devin PermissionRequest hook ENTRY (bundled to dist/devin-approve.mjs), registered
// in ~/.config/devin/config.json by plugin/scripts/devin-install.mjs or by the native Devin plugin's
// hooks.json (`--via=devin-plugin`). Prints AT MOST ONE decision line
// and exits 0 — and prints NOTHING (= Devin's own prompt) on every path without a phone answer,
// including its own hard cap. All logic: core/devin-approval.ts. PORTABILITY: bun AND node >= 18.

import { devinPluginStandsDown } from "../core/devin";
import { DEVIN_ENTRY_CAP_MS, markDevinApprovalTerminated, runDevinApproval } from "../core/devin-approval";

/** Exit from the write's own callback: stdout is a pipe and process.exit does not wait for it (see
 *  cc-permission.ts). The timer bounds a callback that never fires. An empty line is no write at all. */
function printAndExit(line: string): void {
  if (!line) process.exit(0);
  setTimeout(() => process.exit(0), 1000).unref();
  process.stdout.write(`${line}\n`, () => process.exit(0));
}

if (import.meta.main) {
  let done = false;
  const finish = (line: string) => { if (!done) { done = true; printAndExit(line); } };
  setTimeout(() => finish(""), DEVIN_ENTRY_CAP_MS).unref();
  // A closed terminal (SIGHUP) or a polite TERM: end the hold at its next round — which withdraws the
  // phone's card — rather than die with it still up. Bounded by a hard exit. Devin's own give-up is a
  // SIGKILL of our parent shell instead; the hold sees that as a parent-pid change.
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      markDevinApprovalTerminated();
      setTimeout(() => process.exit(0), 10_000).unref();
    });
  }
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  } catch { /* unreadable stdin → no opinion */ }
  // The native plugin's copy goes quiet (no card, no opinion) while `nomo-ai --devin`'s is installed.
  finish(devinPluginStandsDown() ? "" : await runDevinApproval(Buffer.concat(chunks).toString("utf8")));
}
