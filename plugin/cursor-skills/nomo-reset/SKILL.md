---
name: nomo-reset
description: Reset stuck Nomo session state — stop the watchdog and clear dead/phantom session rows without unpairing
disable-model-invocation: true
---

Run this exact command in the terminal and show its output verbatim to the user:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/reset.mjs"; [ -x "$NOMOS" ] && exec "$NOMOS" reset; echo "Nomo could not find its installed files - re-run: bunx nomo-ai --cursor"; exit 1
```

What it does (relay the printed summary):

- Stops the liveness watchdog if one is running (it verifies the pid really is the watchdog before
  killing anything). The watchdog restarts automatically on the next session event.
- Sweeps the local session records: every record whose process is dead gets a best-effort "session
  ended" signal sent to the phone so its row clears, then the record is deleted. Sessions whose
  process is still alive are left untouched.
- Pairing and encryption keys are NOT touched — the phone stays paired. To disconnect entirely, use
  `/nomo-unpair`.

One caveat specific to Cursor: a desktop-app session's liveness is the **Cursor app**, so a
stale-looking row belonging to a running Cursor is not cleared here — it retires on its own once the
chat has been idle, or when Cursor quits.

It always exits 0 — "No watchdog running" / "No stale sessions to clear" are normal outcomes.
