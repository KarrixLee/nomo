---
description: Move this Claude Code session to your Nomo cloud box (it moves the moment you quit here)
argument-hint: [cancel|status]
---

Read `$ARGUMENTS` (trimmed, case-insensitive) and run **at most one** of these commands in the
foreground. Show its output to the user verbatim.

**Anything other than empty, `cancel` or `status`** (a typo like `cancle` included): run nothing. Reply
only: "Usage: /nomo-cc:handoff (move this session), /nomo-cc:handoff cancel, /nomo-cc:handoff status".

**No argument** (empty) — get this session ready to move:

```
NOMOR="${CLAUDE_PLUGIN_ROOT}"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/handoff.mjs" --later --session "${CLAUDE_SESSION_ID}"; [ -x "$NOMOS" ] && exec "$NOMOS" handoff --later --session "${CLAUDE_SESSION_ID}"; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

**`cancel`** — stop a handoff that is still waiting for this session to close:

```
NOMOR="${CLAUDE_PLUGIN_ROOT}"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/handoff.mjs" --later-cancel; [ -x "$NOMOS" ] && exec "$NOMOS" handoff --later-cancel; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

**`status`** — is a handoff waiting, and how did the last one end:

```
NOMOR="${CLAUDE_PLUGIN_ROOT}"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/handoff.mjs" --later-status; [ -x "$NOMOS" ] && exec "$NOMOS" handoff --later-status; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

The session does NOT move while it is open: the command only checks things locally and starts a
background helper that moves it once this Claude Code session exits (so the copy in the cloud starts
from a finished turn and the two never run at once). After `Ready. Quit Claude Code now (/exit)…`,
tell the user to type `/exit` now, and do nothing else in this session: any further turn here would
be left behind. If the output says the box needs pairing, relay the terminal command it printed and
stop; nothing was started.
