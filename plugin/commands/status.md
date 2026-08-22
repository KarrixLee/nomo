---
description: Show Nomo pairing, watchdog, and event-delivery health for this computer
---

Run this exact command and show its output verbatim to the user:

```
NOMOR="${CLAUDE_PLUGIN_ROOT}"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/status-cmd.mjs" claude; [ -x "$NOMOS" ] && exec "$NOMOS" status-cmd claude; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

The trailing `claude` tells the readout who is asking, so it leads with **Claude Code**. It prints
the machine-wide facts first (pairing, worker, delivery, whether remote approvals are paused), then
a Claude Code section — are its hooks firing, how many of the tracked sessions are its own — and
finally one condensed line per other agent installed on this computer.

Present the block as-is; do not summarise or re-order it. Any line beginning with `!` is a real
problem and the `→` line under it is the fix — read those out. It always exits 0 — "NOT PAIRED" is
information, not an error; if the user isn't paired, suggest running `/nomo-cc:pair`.
