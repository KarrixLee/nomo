---
description: Pause or resume Nomo remote approvals on this computer — control whether Claude Code permission prompts are sent to your phone
argument-hint: [on|off|status]
---

Remote approvals let you answer a Claude Code permission prompt (run a command, edit a file, …) from
the Nomo iPhone app when that session is on your phone's Live Activity — the terminal dialog waits
while you tap Allow or Deny. This command is the LOCAL switch for it on this computer, useful when
your phone is unreachable and you just want prompts to appear in the terminal as usual.

## Read `$ARGUMENTS` first

Trim whitespace, lowercase it, and pick the matching sub-command. Anything empty or unrecognized →
treat as `status`.

- `off` → pause remote approvals here (prompts appear in the terminal; your phone is not asked).
- `on` → resume remote approvals here.
- `status` (or no argument) → report the current state.

## Run it

Run this exact command with your chosen sub-command and relay its single output line to the user:

```
NOMOR="${CLAUDE_PLUGIN_ROOT}"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/cc-permission.mjs" <on|off|status>; [ -x "$NOMOS" ] && exec "$NOMOS" cc-permission <on|off|status>; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

Notes to relay:

- This is a per-computer local switch. It does not change your phone's settings and does not unpair
  anything — pairing and the "Remote approvals" toggle in the app are unaffected.
- `off` is the escape hatch for a dead or unreachable phone: with it set, permission prompts never
  wait on the phone and always fall back to the terminal dialog immediately.
- The command always exits 0.
