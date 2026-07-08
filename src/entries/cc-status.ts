// cc-status — the Claude Code hook ENTRY (bundled to dist/cc-status.mjs, wired into the plugin's
// hooks.json). The whole implementation lives in hook.ts (shared with the Codex entry,
// codex-status.ts); this file just re-exports that surface — so every existing importer/test that
// references "./cc-status" is unchanged — and calls runHook("claude") when run as the entry.
//
// WHY the split: build.ts bundles each entrypoint standalone, and Bun's bundler rewrites every
// `import.meta.main` to one shared runtime check. If codex-status.ts imported THIS file (an entry
// with a top-level import.meta.main block), that block would be inlined into codex-status.mjs and
// fire too, running runHook("claude") + process.exit(0) before the codex entry. Keeping runHook in a
// non-entry module (hook.ts) that both entries import is what prevents that.

export * from "../core/hook";

import { runHook } from "../core/hook";

// import.meta.main is true under bun and node >= 24 when this file is the entry point; build.ts's
// bundling rewrites it for older nodes.
if (import.meta.main) {
  await runHook("claude");
  process.exit(0);
}
