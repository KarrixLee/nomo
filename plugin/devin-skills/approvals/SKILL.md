---
name: approvals
description: Turn Nomo phone approvals on or off for this computer (whether Devin's permission prompts go to your iPhone)
triggers:
  - user
---

Read the text after `/nomo:approvals`, trimmed and lowercased:

- `off` (or "pause", "stop") → run the **off** command
- `on` (or "resume", "start") → run the **on** command
- anything else, or nothing → run the **status** command

Run the ONE matching command with the exec tool, exactly as written, and show its output verbatim:

- on:

```
/bin/sh -c 'NOMOS="$HOME/.config/cc-status/hook-shim.sh"; for NOMOR in "$HOME"/.local/share/devin/cli/plugins/cache/*nomo*/*/plugin; do [ -x "$NOMOR/scripts/run.sh" ] && [ -f "$NOMOR/dist/cc-permission.mjs" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/cc-permission.mjs" on; done; [ -x "$NOMOS" ] && exec "$NOMOS" cc-permission on; echo "Nomo could not find its installed files - reinstall: devin plugins install KarrixLee/nomo"; exit 1'
```

- off:

```
/bin/sh -c 'NOMOS="$HOME/.config/cc-status/hook-shim.sh"; for NOMOR in "$HOME"/.local/share/devin/cli/plugins/cache/*nomo*/*/plugin; do [ -x "$NOMOR/scripts/run.sh" ] && [ -f "$NOMOR/dist/cc-permission.mjs" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/cc-permission.mjs" off; done; [ -x "$NOMOS" ] && exec "$NOMOS" cc-permission off; echo "Nomo could not find its installed files - reinstall: devin plugins install KarrixLee/nomo"; exit 1'
```

- status:

```
/bin/sh -c 'NOMOS="$HOME/.config/cc-status/hook-shim.sh"; for NOMOR in "$HOME"/.local/share/devin/cli/plugins/cache/*nomo*/*/plugin; do [ -x "$NOMOR/scripts/run.sh" ] && [ -f "$NOMOR/dist/cc-permission.mjs" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/cc-permission.mjs" status; done; [ -x "$NOMOS" ] && exec "$NOMOS" cc-permission status; echo "Nomo could not find its installed files - reinstall: devin plugins install KarrixLee/nomo"; exit 1'
```

It only flips a setting on this computer (no internet) and returns at once. Then say one of:

- on, or a status that says ON → "Phone approvals are on. When Devin asks for permission in a session
  your phone is showing, your iPhone can answer it (Allow, Always allow for this session, Deny)."
- off, or a status that says OFF → "Phone approvals are paused. Devin will ask you on this computer
  instead. Type `/nomo:approvals on` to turn them back on."

The switch is shared by every coding agent on this computer that uses Nomo (Claude Code, Codex and
others too). It does not disconnect the phone. In Devin Desktop it takes effect from the next prompt.
