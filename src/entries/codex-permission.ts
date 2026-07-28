// codex-permission — the OpenAI Codex PermissionRequest hook ENTRY (bundled to dist/codex-permission.mjs,
// wired into codex-hooks.json as the PermissionRequest handler). The codex-side twin of cc-permission.ts:
// all logic lives in ../core/permission; this file is a thin argv dispatcher that calls the shared hold
// with agent "codex" (which tags the blob agent:"codex" and wraps the decision line in continue:true —
// the shape Codex 0.144.1 consumes). Entries never import entries.
//
// UNLIKE every other codex entry, the hook path here can BLOCK for an unbounded time (it holds the
// terminal permission dialog while the phone decides) — see ../core/permission's header. codex-hooks.json
// gives PermissionRequest a 3600s (1h) timeout to match (the competitor-proven ceiling). The
// `off|on|status` args toggle the SAME local no-hold escape hatch as the Claude side (one per-computer
// pause switch, shared across both agents — see approvalsCommand / NO_HOLD_PATH).
//
// PORTABILITY: runs unmodified under bun AND node >= 18 — no `Bun.*` APIs. build.ts bundles this into
// dist/codex-permission.mjs.

import { runPermissionHook, approvalsCommand } from "../core/permission";

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    console.log("usage: codex-permission [off|on|status]  — Codex PermissionRequest hook; off/on/status toggle the local no-hold escape hatch (pause/resume remote approvals on this computer — shared with Claude Code)");
    process.exit(0);
  }
  const sub = process.argv[2];
  if (sub === "off" || sub === "on" || sub === "status") {
    process.exit(await approvalsCommand(sub));
  }
  // FLUSH BEFORE EXIT — same 64 KB pipe-truncation hazard as cc-permission.ts (see the measured
  // rationale there). Codex has no ExitPlanMode plan echo, so the decision line rarely nears the
  // buffer, but a large request_user_input answer set can — and a truncated line is a lost approval.
  let flushed: Promise<void> = Promise.resolve();
  await runPermissionHook({
    emit: (line: string) => {
      flushed = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        (timer as unknown as { unref?: () => void }).unref?.();
        process.stdout.write(`${line}\n`, () => { clearTimeout(timer); resolve(); });
      });
    },
  }, "codex");
  await flushed;
  process.exit(0);
}
