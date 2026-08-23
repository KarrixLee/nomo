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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTDIR = join(HERE, "plugin", "dist");

/** Every manifest that carries the plugin version, and how to pull it out. The Claude plugin manifest
 *  is the source of truth (see readVersion below); the rest must agree with it. A release that bumps
 *  only some of them ships hosts a version that disagrees with what the bundle reports, so the build
 *  refuses rather than baking the disagreement into dist/.
 *
 *  package.json is the FIFTH and newest of them (the `nomo-ai` npm bootstrapper). It ships no plugin
 *  code — it only drives `claude plugin install` / `codex plugin add` / opencode-install.sh — so
 *  there was an argument for versioning it independently. It is here anyway: same product, same
 *  repo, and `bunx nomo-ai --version` is what a user will quote in a bug report. Locking it in means
 *  the build fails loudly on drift instead of leaving that trap for a future release to find. */
const VERSION_MANIFESTS: { path: string; versions: (doc: any) => (string | undefined)[] }[] = [
  { path: join("plugin", ".claude-plugin", "plugin.json"), versions: (d) => [d.version] },
  { path: join("plugin", ".codex-plugin", "plugin.json"), versions: (d) => [d.version] },
  { path: join(".claude-plugin", "marketplace.json"), versions: (d) => (d.plugins ?? []).map((p: any) => p.version) },
  { path: join(".agents", "plugins", "marketplace.json"), versions: (d) => (d.plugins ?? []).map((p: any) => p.version) },
  { path: "package.json", versions: (d) => [d.version] },
];

/** The Claude plugin manifest's version, after proving every other manifest agrees with it.
 *  PLUGIN_VERSION is injected from this single value, so agreement here is what makes the version the
 *  bundle self-reports trustworthy in a diagnosis. */
function readVersion(): string {
  const readings = VERSION_MANIFESTS.map(({ path, versions }) => {
    const doc = JSON.parse(readFileSync(join(HERE, path), "utf8"));
    return { path, found: versions(doc) };
  });

  const source = readings[0].found[0];
  if (!source) throw new Error(`build: ${VERSION_MANIFESTS[0].path} has no "version"`);

  const disagree = readings.flatMap(({ path, found }) =>
    found.filter((v) => v !== source).map((v) => `  ${path}: ${v ?? "(missing)"}`));
  if (disagree.length > 0) {
    throw new Error(`build: manifest versions disagree — expected ${source} from ${VERSION_MANIFESTS[0].path}:\n${disagree.join("\n")}`);
  }
  return source;
}

/** The entrypoints. cc-status is the Claude hook run on every event; codex-status is its Codex twin
 *  (calls runHook("codex")); cc-watchdog is spawned by either hook (as a sibling dist/cc-watchdog.mjs
 *  — see shared's WATCHDOG_PATH); pair/unpair/status-cmd back the Claude slash commands and the
 *  Codex skills. codex-notify is the Codex `notify`-channel backstop (a done push when the lifecycle
 *  hooks fail to fire) — invoked with its JSON payload as argv by plugin/scripts/hook-shim.sh, not
 *  on stdin. cc-permission / codex-permission are the blocking PermissionRequest holds (Claude / Codex
 *  twins — the phone answers Allow/Deny while the terminal dialog waits). opencode-update backs
 *  /nomo-update: OpenCode is the one agent whose host has no update command of its own, so its
 *  checkout IS its version and pulling it is ours to do. Each is bundled standalone with its local
 *  deps inlined. */
const ENTRYPOINTS = [
  "cc-status.ts",
  "cc-permission.ts",
  "codex-status.ts",
  "codex-permission.ts",
  "codex-notify.ts",
  "cc-watchdog.ts",
  "pair.ts",
  "unpair.ts",
  "reset.ts",
  "status-cmd.ts",
  "opencode-update.ts",
].map((f) => join(HERE, "src", "entries", f));

/** The OpenCode plugin — a SECOND build pass, not another ENTRYPOINTS row, because it needs a
 *  different extension. OpenCode auto-discovers plugins with the glob `{plugin,plugins}/*.{ts,js}`
 *  (packages/opencode/src/config/plugin.ts), so a `.mjs` bundle would never load. Unlike the hooks
 *  this is not a one-shot process: OpenCode imports it once and keeps it resident inside its own
 *  server process, so there is no hooks.json, no hook-shim entry and no NOMO_SHIM_REV bump.
 *  It still lands in plugin/dist/ because shared.ts's WATCHDOG_PATH resolves cc-watchdog.mjs as a
 *  sibling of import.meta.url — the bundle must EXECUTE from dist/. The installed file at
 *  ~/.config/opencode/plugins/nomo.js is a one-line stub re-exporting this absolute path (see README);
 *  that indirection is also what keeps an install from going stale across plugin upgrades. */
const OPENCODE_ENTRY = join(HERE, "src", "opencode", "plugin.ts");

async function main(): Promise<void> {
  // The plugin's version is single-sourced from the Claude plugin manifest; inject it as a build-time
  // define so PLUGIN_VERSION (src/core/shared.ts) resolves to it in the committed dist/*.mjs bundles.
  // Read (and cross-check) BEFORE the clean below: dist/ is committed, so a build that refuses must
  // leave the working tree's bundles intact rather than deleting them on the way out.
  const version = readVersion();

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
    // Replaces the `__NOMO_VERSION__` textual reference in shared.ts with the manifest version string,
    // so the bundled hook reports its real build in the x-cc-version header. Unbundled runs (tests) keep
    // the typeof-guarded fallback.
    define: { __NOMO_VERSION__: JSON.stringify(version) },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("bun build failed");
  }

  // Pass 2 — the OpenCode plugin. Same target/define as above so __NOMO_VERSION__ still injects and
  // the output stays free of Bun-only globals. `naming` is the LITERAL "opencode.js", not
  // "[name].js": the entry is src/opencode/plugin.ts, so `[name]` would emit dist/plugin.js — a
  // meaningless name inside plugin/dist/, and not the dist/opencode.js the install stub points at.
  // Safe as a literal only because this pass has exactly one entrypoint.
  const oc = await Bun.build({
    entrypoints: [OPENCODE_ENTRY],
    outdir: OUTDIR,
    target: "node",
    format: "esm",
    naming: "opencode.js",
    sourcemap: "none",
    minify: false,
    define: { __NOMO_VERSION__: JSON.stringify(version) },
  });

  if (!oc.success) {
    for (const log of oc.logs) console.error(log);
    throw new Error("bun build failed (opencode)");
  }

  const outputs = [...result.outputs, ...oc.outputs];
  const names = outputs.map((o) => o.path.split("/").pop()).sort();
  console.log(`Built ${outputs.length} artifacts stamped ${version} into ${OUTDIR}:`);
  for (const n of names) console.log(`  ${n}`);
}

await main();
