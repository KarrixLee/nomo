// antigravity-approve — the Antigravity PreToolUse hook ENTRY (bundled to dist/antigravity-approve.mjs),
// run by plugin/scripts/antigravity-approve.sh. Prints EXACTLY ONE decision line and exits 0 — the
// fallback `{"decision":"allow"}` on every path without a phone answer, including its own hard cap.
// All logic: core/antigravity-approval.ts. PORTABILITY: bun AND node >= 18 — no `Bun.*` APIs.

import { ANTIGRAVITY_ENTRY_CAP_MS, ANTIGRAVITY_FALLBACK, runAntigravityApproval } from "../core/antigravity-approval";

/** Exit from the write's own callback: stdout is a pipe/file and process.exit does not wait for it
 *  (see cc-permission.ts). The timer bounds a callback that never fires. */
function printAndExit(line: string): void {
  setTimeout(() => process.exit(0), 1000).unref();
  process.stdout.write(`${line}\n`, () => process.exit(0));
}

if (import.meta.main) {
  let done = false;
  const finish = (line: string) => { if (!done) { done = true; printAndExit(line); } };
  setTimeout(() => finish(ANTIGRAVITY_FALLBACK), ANTIGRAVITY_ENTRY_CAP_MS).unref();
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  } catch { /* unreadable stdin → the fallback below */ }
  finish(await runAntigravityApproval(Buffer.concat(chunks).toString("utf8")));
}
