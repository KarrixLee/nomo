// build.ts — bundle the portable nomo-plugin sources into the plugin's self-contained dist/.
//
// Run with `bun build.ts` (from the repo root). It
// bundles the entrypoints — the Claude + Codex hooks, the watchdog, and the interactive commands
// (pair/unpair/status) — into `plugin/dist/*.mjs`, inlining every local import (qr /
// crypto / shared) so each artifact is a single node-runnable file. Target `node` keeps the output
// free of Bun-only globals, so the plugin runs under either runtime once run.sh has resolved one.
//
// The dist/ output IS committed: users install this plugin via the marketplace (a git clone), and
// there is no publish/CI step — the committed bundle is what runs. Re-run this script after any
// source change so dist/ stays reproducible from source.

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTDIR = join(HERE, "plugin", "dist");

/** The entrypoints. cc-status is the Claude hook run on every event; codex-status is its Codex twin
 *  (calls runHook("codex")); cc-watchdog is spawned by either hook (as a sibling dist/cc-watchdog.mjs
 *  — see shared's WATCHDOG_PATH); pair/unpair/status-cmd back the Claude slash commands and the
 *  Codex skills. codex-notify is the Codex `notify`-channel backstop (a done push when the lifecycle
 *  hooks fail to fire) — invoked with its JSON payload as argv by plugin/scripts/notify-chain.sh, not
 *  on stdin. Each is bundled standalone with its local deps inlined. */
const ENTRYPOINTS = [
  "cc-status.ts",
  "codex-status.ts",
  "codex-notify.ts",
  "cc-watchdog.ts",
  "pair.ts",
  "unpair.ts",
  "status-cmd.ts",
].map((f) => join(HERE, "src", "entries", f));

async function main(): Promise<void> {
  // Clean so a removed/renamed entrypoint can never leave a stale .mjs behind.
  await rm(OUTDIR, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: ENTRYPOINTS,
    outdir: OUTDIR,
    target: "node",
    format: "esm",
    // Emit .mjs so `node dist/pair.mjs` treats it as ESM regardless of any package.json `type`.
    // Flat `[name].mjs` (not `[dir]/[name]`) so entrypoints under entries/ still land directly in
    // dist/ — the hook command lines reference dist/*.mjs, not dist/entries/*.mjs.
    naming: "[name].mjs",
    sourcemap: "none",
    minify: false,
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("bun build failed");
  }

  const names = result.outputs.map((o) => o.path.split("/").pop()).sort();
  console.log(`Built ${result.outputs.length} artifacts into ${OUTDIR}:`);
  for (const n of names) console.log(`  ${n}`);
}

await main();
