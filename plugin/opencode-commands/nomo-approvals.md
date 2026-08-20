---
description: Pause or resume Nomo remote approvals on this computer — control whether permission prompts are sent to your phone
---

Remote approvals let you answer an agent's permission prompt (run a command, edit a file, …) from the
Nomo iPhone app while the terminal dialog waits. This command is the LOCAL switch for it on this
computer, useful when your phone is unreachable and you just want prompts to appear in the terminal
as usual.

**Scope, and say this to the user when they ask what it changed:** the flag is per-computer and
SHARED by every agent — Claude Code, Codex and OpenCode all read it. OpenCode holds on both of its
approval channels: an ordinary permission prompt (run a command, edit a file, …) and a question the
agent asks you. Turning this off means those wait in the terminal instead of reaching your phone.

## Read `$ARGUMENTS` first

Trim whitespace, lowercase it, and pick the matching sub-command. Anything empty or unrecognized →
treat as `status`.

- `off` → pause remote approvals here (prompts appear in the terminal; your phone is not asked).
- `on` → resume remote approvals here.
- `status` (or no argument) → report the current state.

## Run it

Run this exact command with your chosen sub-command substituted for the placeholder, and relay its
single output line to the user:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/cc-permission.mjs" <on|off|status>; [ -x "$NOMOS" ] && exec "$NOMOS" cc-permission <on|off|status>; echo "Nomo could not find its installed files - re-run plugin/scripts/opencode-install.sh."; exit 1
```

Substitute only one of the three literal words `on`, `off`, `status` — never pass the user's raw text
through to the shell.

Notes to relay:

- This does not change your phone's settings and does not unpair anything.
- `off` is the escape hatch for a dead or unreachable phone: with it set, permission prompts never
  wait on the phone and always fall back to the terminal dialog immediately.
- The command always exits 0.
