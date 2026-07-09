---
description: Reset stuck Nomo session state — stop the watchdog and clear dead/phantom session rows without unpairing
---

Run this exact command and show its output verbatim to the user:

```
"${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "${CLAUDE_PLUGIN_ROOT}/dist/reset.mjs"
```

What it does (relay the printed summary):

- Stops the liveness watchdog if one is running (it verifies the pid really is the watchdog before
  killing anything, then removes the pidfile). The watchdog restarts automatically on the next
  session event, so stopping it is always safe.
- Sweeps the local session records: every record whose process is dead (or that is a provisional
  placeholder) gets a best-effort "session ended" signal sent to the phone so its row actually
  clears, then the record is deleted. Sessions whose process is still alive are left untouched.
- Pairing and encryption keys are NOT touched — the phone stays paired. If the user wants to
  disconnect entirely, point them at `/nomo-cc:unpair` instead.

It always exits 0 — "No watchdog running" / "No stale sessions to clear" are normal, successful
outcomes, not errors.
