// cc-permission — the Claude Code PermissionRequest hook ENTRY (bundled to dist/cc-permission.mjs,
// wired into hooks.json as the PermissionRequest handler). All logic lives in ../core/permission;
// this file is a thin argv dispatcher, mirroring cc-status.ts (entries never import entries).
//
// UNLIKE every other entry, the hook path here can BLOCK for an unbounded time (it holds the terminal
// permission dialog while the phone decides) — see ../core/permission's header. hooks.json gives it a
// 24h timeout to match. The `off|on|status` args toggle the local escape hatch instead of hooking.

import { runPermissionHook, approvalsCommand } from "../core/permission";

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    console.log("usage: cc-permission [off|on|status]  — PermissionRequest hook; off/on/status toggle the local no-hold escape hatch (pause/resume remote approvals on this computer)");
    process.exit(0);
  }
  const sub = process.argv[2];
  if (sub === "off" || sub === "on" || sub === "status") {
    process.exit(await approvalsCommand(sub));
  }
  // FLUSH BEFORE EXIT. The hook's entire product is ONE decision line on stdout, and stdout is a PIPE
  // under a hook runner: `process.stdout.write` is asynchronous there, and `process.exit()` does not wait
  // for it. Measured (node 26 AND bun 1.3): a line past the 64 KB pipe buffer is TRUNCATED at exactly
  // 65536 bytes by the bare `write(); exit(0)` pair — and an ExitPlanMode allow echoes the whole plan back
  // through `updatedInput`, so this is reachable, not theoretical. A truncated line is unparseable, so the
  // phone's Allow silently becomes "no decision".
  //
  // The fix is to exit from the write's OWN callback, which is why the emit seam is overridden here rather
  // than left to the module default: only the callback attached to the REAL write is ordered after the
  // pipe drains under both runtimes (bun does not defer a later empty write's callback behind it, and
  // relying on a natural `process.exitCode` exit instead would let undici's keep-alive sockets hold the
  // process open for seconds after the decision). The unref'd timer is a bound so a callback that never
  // fires cannot hang the terminal; resolving twice is a no-op.
  let flushed: Promise<void> = Promise.resolve();
  await runPermissionHook({
    emit: (line: string) => {
      flushed = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        (timer as unknown as { unref?: () => void }).unref?.();
        process.stdout.write(`${line}\n`, () => { clearTimeout(timer); resolve(); });
      });
    },
  });
  await flushed;
  process.exit(0);
}
