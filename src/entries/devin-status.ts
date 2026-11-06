// devin-status — the Devin hook ENTRY (bundled to dist/devin-status.mjs), for the Devin CLI and Devin
// Desktop's "Devin Local" agent. Registered in ~/.config/devin/config.json by
// plugin/scripts/devin-install.mjs, or by the native Devin plugin (repo-root hooks.json, which adds
// `--via=devin-plugin`). The whole implementation is core/devin.ts.
//
// Contract with Devin: read the event JSON on stdin, print NOTHING, exit 0 — always. No stdout means no
// decision, no context injection, no input rewrite: this hook observes and can never steer or block.
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
