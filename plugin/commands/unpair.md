---
description: Unpair this computer from the Nomo iPhone app and remove local pairing state
---

Run this exact command and show its output verbatim to the user:

```
"${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "${CLAUDE_PLUGIN_ROOT}/dist/unpair.mjs"
```

It revokes the pairing on the server (best-effort) and deletes the local pairing config, then
prints a short status line. Relay that line to the user. It always exits 0 — "Not paired" is a
normal, successful outcome, not an error.

This works whether the pairing is fully completed OR still pending (a pair attempt where the QR was
shown but no phone finished scanning) — either way it revokes the server-side record and clears the
local state. If the phone already forgot this machine (or the pairing expired), the server 404s the
revoke and the command reports it was already revoked; the local state is cleared regardless.
