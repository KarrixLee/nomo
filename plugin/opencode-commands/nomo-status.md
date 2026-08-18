---
description: Show Nomo pairing, watchdog, and event-delivery health for this computer
---

Run this exact command and show its output verbatim to the user:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/status-cmd.mjs"; [ -x "$NOMOS" ] && exec "$NOMOS" status-cmd; echo "Nomo could not find its installed files - re-run plugin/scripts/opencode-install.sh."; exit 1
```

It prints a short health readout: whether this machine is paired (and to which worker), whether the
liveness watchdog is running, when the last event was delivered, and how many sessions are being
tracked. Present the block as-is. It always exits 0 — "Paired: no" is information, not an error; if
the user isn't paired, suggest running `/nomo-pair`.

The readout is machine-wide, not OpenCode-specific: one pairing covers OpenCode, Claude Code and
Codex on this computer. Rows about Codex hook trust are irrelevant to OpenCode — OpenCode has no
hooks, it loads one resident plugin module at server start.
