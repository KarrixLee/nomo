---
description: Reset stuck Nomo session state — stop the watchdog and clear dead/phantom session rows without unpairing
---

Run this exact command and show its output verbatim to the user:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/reset.mjs"; [ -x "$NOMOS" ] && exec "$NOMOS" reset; echo "Nomo could not find its installed files - re-run plugin/scripts/opencode-install.sh."; exit 1
```

What it does (relay the printed summary):

- Stops the liveness watchdog if one is running (it verifies the pid really is the watchdog before
  killing anything, then removes the pidfile). The watchdog restarts automatically on the next
  session event, so stopping it is always safe.
- Sweeps the local session records: every record whose process is dead (or that is a provisional
  placeholder) gets a best-effort "session ended" signal sent to the phone so its row actually
  clears, then the record is deleted. Sessions whose process is still alive are left untouched.
- Pairing and encryption keys are NOT touched — the phone stays paired. If the user wants to
  disconnect entirely, point them at `/nomo-unpair` instead.

One caveat specific to OpenCode: an OpenCode session's liveness is the **OpenCode server process**,
not the terminal. This command will not clear a row for a session whose server is still running —
quit OpenCode first if a stale-looking row belongs to a live server.

It always exits 0 — "No watchdog running" / "No stale sessions to clear" are normal, successful
outcomes, not errors.
