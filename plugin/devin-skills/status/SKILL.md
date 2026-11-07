---
name: status
description: Show Nomo pairing, watchdog, and event-delivery health for this computer
triggers:
  - user
---

Run this exact command with the exec tool and show its output verbatim to the user:

```
/bin/sh -c 'NOMOS="$HOME/.config/cc-status/hook-shim.sh"; for NOMOR in "$HOME"/.local/share/devin/cli/plugins/cache/*nomo*/*/plugin; do [ -x "$NOMOR/scripts/run.sh" ] && [ -f "$NOMOR/dist/status-cmd.mjs" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/status-cmd.mjs" devin; done; [ -x "$NOMOS" ] && exec "$NOMOS" status-cmd devin; echo "Nomo could not find its installed files - reinstall: devin plugins install KarrixLee/nomo"; exit 1'
```

The trailing `devin` tells the readout who is asking, so it leads with **Devin**. It prints the
machine-wide facts first (pairing, delivery), then a Devin section — how Nomo is installed (`plugin`,
`hooks`, or both, in which case the plugin stays idle), whether Nomo's hooks are firing, and how many
of the tracked sessions are Devin's — and one condensed line per other agent installed on this
computer.

Present the block as-is; do not summarise or re-order it. Any line beginning with `!` is a real
problem and the `→` line under it is the fix — read those out. It always exits 0 — "NOT PAIRED" is
information, not an error; if the user isn't paired, suggest `/nomo:pair`.

Devin sessions show as working / needs you / done on the phone. From the phone the user can answer
Devin's permission prompts (Allow, Always allow for this session, Deny), answer the questions Devin
asks (`ask_user_question`), and interrupt a running turn (Devin stops after its current step).
