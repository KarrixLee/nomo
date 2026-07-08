// codex-status — OpenAI Codex CLI hook → api-status push Live Activity bridge.
//
// The codex-side twin of cc-status.ts. Codex CLI ships a Claude-Code-compatible hooks system
// ($CODEX_HOME/hooks.json, same JSON shape, same hook_event_name strings, event JSON on stdin), so
// the ENTIRE pipeline is shared: this file just calls the shared runHook("codex"), which stamps the
// blob's optional `agent:"codex"` key and swaps the title scanner for the codex rollout format. Same
// contract as the Claude hook: NOTHING on stdout, exit 0 always, 2-second network ceiling.
//
// runHook is imported from hook.ts, NOT cc-status.ts: importing the Claude ENTRY would inline its
// import.meta.main block into this bundle and fire runHook("claude") first (see hook.ts header).
//
// Registered by the native Codex plugin's hooks/codex-hooks.json (`exec <run.sh> <this bundle>`).
// PORTABILITY: bun AND node >= 18 — no `Bun.*` APIs; build.ts bundles this to dist/codex-status.mjs.

import { runHook } from "../core/hook";

// import.meta.main is true under bun and node >= 24 when this file is the entry point; build.ts's
// bundling rewrites it for older nodes (same as every other entrypoint).
if (import.meta.main) {
  await runHook("codex");
  process.exit(0);
}
