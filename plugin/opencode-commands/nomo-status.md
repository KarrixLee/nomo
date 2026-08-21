---
description: Show Nomo pairing, watchdog, and event-delivery health for this computer
---

Run this exact command and show its output verbatim to the user:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/status-cmd.mjs" opencode; [ -x "$NOMOS" ] && exec "$NOMOS" status-cmd opencode; echo "Nomo could not find its installed files - re-run plugin/scripts/opencode-install.sh."; exit 1
```

The trailing `opencode` tells the readout who is asking, so it leads with **OpenCode**. It prints the
machine-wide facts first (pairing, worker, delivery, whether remote approvals are paused), then an
OpenCode section — whether the resident plugin is loaded and how many of the tracked sessions are its
own — and finally one condensed line per other agent installed on this computer.

Present the block as-is; do not summarise or re-order it. Any line beginning with `!` is a real
problem and the `→` line under it is the fix — read those out. It always exits 0 — "NOT PAIRED" is
information, not an error; if the user isn't paired, suggest running `/nomo-pair`.

The top block is machine-wide, not OpenCode-specific: one pairing covers OpenCode, Claude Code and
Codex on this computer. Anything under "Also on this computer" belongs to another agent — OpenCode
has no hooks and no hook trust, it loads one resident plugin module at server start.
