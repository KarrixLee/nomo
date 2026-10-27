---
name: nomo-status
description: Check whether this computer is connected to the Nomo iPhone app. Run ONLY when the user types /nomo-status — never on your own.
---

**How to talk to the user.** Nomo users are often not technical. Reply in plain, friendly words,
one next step at a time. Never mention hooks, scripts, file paths, JSON, exit codes or the "watchdog".

**Antigravity may ask before running the command below.** That is expected: tell the user
"Antigravity will ask to run a Nomo command — please choose Allow." Never retry with extra
permissions or flags, and never run anything else.

## Step 1 — run the check

If the user typed `/nomo-status verbose` (or asked for details), run this exact command:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/status-cmd.mjs" antigravity; [ -x "$NOMOS" ] && exec "$NOMOS" status-cmd antigravity; echo "Nomo could not find its files. Please run the Nomo installer again: bunx nomo-ai --antigravity"; exit 1
```

Otherwise run this exact command:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/status-cmd.mjs" antigravity --plain; [ -x "$NOMOS" ] && exec "$NOMOS" status-cmd antigravity --plain; echo "Nomo could not find its files. Please run the Nomo installer again: bunx nomo-ai --antigravity"; exit 1
```

It only reads this computer's state and returns in a second.

## Step 2 — reply

- **Plain check:** show the lines it printed exactly as they are (they are already written for the
  user), and nothing else.
- **Verbose check:** show the block exactly as printed, then one sentence in plain words saying
  whether everything is fine or what the single next step is.
