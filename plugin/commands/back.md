---
description: Bring your Nomo cloud session back to this Mac (resumes in a new Terminal window)
argument-hint: [--wait <min>] [--session <uuid>]
---

Bring the session running on the Nomo cloud box back to this Mac. It waits for the box session to
finish its turn (15 min by default), pulls its work back, sleeps the box, and opens a **new Terminal
window** on `claude --resume`. It never resumes inside this Claude Code session.

Build the command from this block. From `$ARGUMENTS` append only `--wait <number>` and/or
`--session <uuid>` (a UUID like `0a1b2c3d-…`) when present, at the end of BOTH `handoff.mjs`
invocations (the `run.sh` one and the `$NOMOS` one) before their `;`. Drop anything else.

```
NOMOR="${CLAUDE_PLUGIN_ROOT}"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/handoff.mjs" --back --from-session "${CLAUDE_SESSION_ID}"; [ -x "$NOMOS" ] && exec "$NOMOS" handoff --back --from-session "${CLAUDE_SESSION_ID}"; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

It can take many minutes, so run it with the Bash tool's `run_in_background: true` (not a trailing
`&`), tell the user it is bringing the session back and to keep this Claude Code session open until it
reports, then end your turn. When the completion notification arrives, Read its output file and relay
it **verbatim**, in particular every line under `Needs a look:` and any `nomo/cloud-…` branch name. If
the Bash tool has no background option, run it in the foreground with the longest timeout allowed.
