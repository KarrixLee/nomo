---
name: nomo-unpair
description: Unpair this computer from the Nomo iPhone app and remove local pairing state
disable-model-invocation: true
---

Run this exact command in the terminal and show its output verbatim to the user:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/unpair.mjs"; [ -x "$NOMOS" ] && exec "$NOMOS" unpair; echo "Nomo could not find its installed files - re-run: bunx nomo-ai --cursor"; exit 1
```

It revokes the pairing on the server (best-effort) and deletes the local pairing config, then prints
a short status line. Relay that line. It always exits 0 — "Not paired" is a normal outcome.

This works whether the pairing is completed OR still pending (a QR that no phone finished scanning).

The pairing is shared by every agent on this computer, so unpairing here also stops Claude Code, Codex
and OpenCode sessions from reaching the phone. It does not uninstall anything: Nomo's Cursor hooks stay
registered and simply do nothing until the machine is paired again.
