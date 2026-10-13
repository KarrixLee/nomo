---
name: nomo-status
description: Show Nomo pairing, watchdog, and event-delivery health for this computer
disable-model-invocation: true
---

Run this exact command in the terminal and show its output verbatim to the user:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/status-cmd.mjs" cursor; [ -x "$NOMOS" ] && exec "$NOMOS" status-cmd cursor; echo "Nomo could not find its installed files - re-run: bunx nomo-ai --cursor"; exit 1
```

The trailing `cursor` tells the readout who is asking, so it leads with **Cursor**. It prints the
machine-wide facts first (pairing, delivery), then a Cursor section — whether Nomo's hooks are firing
and how many of the tracked sessions are Cursor's — and one condensed line per other agent installed
on this computer.

Present the block as-is; do not summarise or re-order it. Any line beginning with `!` is a real
problem and the `→` line under it is the fix — read those out. It always exits 0 — "NOT PAIRED" is
information, not an error; if the user isn't paired, suggest `/nomo-pair`.

Cursor sessions are read-only in Nomo: they show as working / done on the phone, and Cursor's own
approval prompts stay in Cursor. The "Approvals" row describes the other agents on this computer.
