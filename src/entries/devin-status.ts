// devin-status — the Devin hook ENTRY (bundled to dist/devin-status.mjs), for the Devin CLI and Devin
// Desktop's "Devin Local" agent. Registered in ~/.config/devin/config.json by
// plugin/scripts/devin-install.mjs, or by the native Devin plugin (repo-root hooks.json, which adds
// `--via=devin-plugin`). The whole implementation is core/devin.ts.
//
// Contract with Devin: read the event JSON on stdin, exit 0 — always. It prints NOTHING, with one
// exception: a PostToolUse while the phone's Interrupt flag is set prints
// `{"continue":false,"stopReason":"Interrupted from Nomo"}` (core/devin.ts), which ends the turn after
// that tool. It never returns a decision, injects context or rewrites input.
// PORTABILITY: bun AND node >= 18 — no `Bun.*` APIs.

import { devinPluginStandsDown, runDevinHook } from "../core/devin";

if (import.meta.main) {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  } catch { /* unreadable stdin → nothing to report */ }
  // The native plugin's copy of this hook goes quiet while `nomo-ai --devin`'s is installed.
  if (!devinPluginStandsDown()) await runDevinHook(Buffer.concat(chunks).toString("utf8"));
  process.exit(0);
}
