// cursor-status — the Cursor hook ENTRY (bundled to dist/cursor-status.mjs), for BOTH the desktop
// app's agent and the `cursor-agent` CLI. Registered in Cursor's user-level hooks.json by
// plugin/scripts/cursor-install.mjs. The whole implementation is core/cursor.ts.
//
// Contract with Cursor: read the event JSON on stdin, print NOTHING, exit 0 — always. No stdout means
// no permission decision, no `continue`, no followup: this hook observes and can never steer or block.
// It can DELAY a prompt submission, by as long as its own POST takes (≤ 2 s) — see core/cursor.ts.
// PORTABILITY: bun AND node >= 18 — no `Bun.*` APIs.

import { runCursorHook } from "../core/cursor";

if (import.meta.main) {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  } catch { /* unreadable stdin → nothing to report */ }
  await runCursorHook(Buffer.concat(chunks).toString("utf8"));
  process.exit(0);
}
