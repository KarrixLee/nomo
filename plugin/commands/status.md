---
description: Show Nomo pairing, watchdog, and event-delivery health for this computer
---

Run this exact command and show its output verbatim to the user:

```
"${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "${CLAUDE_PLUGIN_ROOT}/dist/status-cmd.mjs"
```

It prints a short health readout: whether this machine is paired (and to which worker), whether
the liveness watchdog is running, when the last event was delivered, and how many sessions are
being tracked. Present the block as-is. It always exits 0 — "Paired: no" is information, not an
error; if the user isn't paired, suggest running `/nomo-cc:pair`.
