// antigravity-status — the Antigravity hook ENTRY (bundled to dist/antigravity-status.mjs), for the
// desktop app/IDE and the `agy` CLI. Run by plugin/scripts/antigravity-hook.sh, which hooks.json names
// and which prints the `{}` Antigravity requires BEFORE starting this — so this prints NOTHING.
// argv[2] is the event name (Antigravity's payload does not carry one). Always exits 0, and never
// outlives HARD_CAP_MS whatever the network does. The whole implementation is core/antigravity.ts.
// PORTABILITY: bun AND node >= 18 — no `Bun.*` APIs.

import { runAntigravityHook } from "../core/antigravity";

/** Well under the 10 s timeout the installer registers: one 2 s POST, a ≤300 ms title read, a `ps` walk. */
const HARD_CAP_MS = 4_000;

if (import.meta.main) {
  setTimeout(() => process.exit(0), HARD_CAP_MS).unref();
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  } catch { /* unreadable stdin → nothing to report */ }
  await runAntigravityHook(Buffer.concat(chunks).toString("utf8"), process.argv[2]);
  process.exit(0);
}
