---
name: unpair
description: Unpair this computer from the Nomo iPhone app and remove local pairing state
triggers:
  - user
---

Run this exact command with the exec tool and show its output verbatim to the user:

```
/bin/sh -c 'NOMOS="$HOME/.config/cc-status/hook-shim.sh"; for NOMOR in "$HOME"/.local/share/devin/cli/plugins/cache/*nomo*/*/plugin; do [ -x "$NOMOR/scripts/run.sh" ] && [ -f "$NOMOR/dist/unpair.mjs" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/unpair.mjs"; done; [ -x "$NOMOS" ] && exec "$NOMOS" unpair; echo "Nomo could not find its installed files - reinstall: devin plugins install KarrixLee/nomo"; exit 1'
```

It revokes the pairing on the server (best-effort) and deletes the local pairing config, then prints
a short status line. Relay that line. It always exits 0 — "Not paired" is a normal outcome.

This works whether the pairing is completed OR still pending (a QR that no phone finished scanning).

The pairing is shared by every agent on this computer, so unpairing here also stops Claude Code, Codex,
Cursor and other agents' sessions from reaching the phone. It does not uninstall anything: Nomo stays
installed in Devin and simply does nothing until the machine is paired again.
