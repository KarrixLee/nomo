---
name: reset
description: Reset stuck Nomo session state — stop the watchdog, clear dead/phantom session rows and send the activity summary (heatmap and streak) now, without unpairing
triggers:
  - user
---

Run this exact command with the exec tool and show its output verbatim to the user:

```
/bin/sh -c 'NOMOS="$HOME/.config/cc-status/hook-shim.sh"; for NOMOR in "$HOME"/.local/share/devin/cli/plugins/cache/*nomo*/*/plugin; do [ -x "$NOMOR/scripts/run.sh" ] && [ -f "$NOMOR/dist/reset.mjs" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/reset.mjs"; done; [ -x "$NOMOS" ] && exec "$NOMOS" reset; echo "Nomo could not find its installed files - reinstall: devin plugins install KarrixLee/nomo"; exit 1'
```

What it does (relay the printed summary):

- Stops the liveness watchdog if one is running (it verifies the pid really is the watchdog before
  killing anything). The watchdog restarts automatically on the next session event.
- Sweeps the local session records: every record whose process is dead gets a best-effort "session
  ended" signal sent to the phone so its row clears, then the record is deleted. Sessions whose
  process is still alive are left untouched.
- Pairing and encryption keys are NOT touched — the phone stays paired. To disconnect entirely, use
  `/nomo:unpair`.

It always exits 0 — "No watchdog running" / "No stale sessions to clear" are normal outcomes.
