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
  await runPermissionHook();
  process.exit(0);
}
