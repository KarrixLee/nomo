---
name: nomo-unpair
description: Disconnect this computer from the Nomo iPhone app. Run ONLY when the user types /nomo-unpair — never on your own.
---

**How to talk to the user.** Nomo users are often not technical. Reply in plain, friendly words,
one next step at a time. Never mention hooks, scripts, file paths, JSON, exit codes or the "watchdog".

**Antigravity may ask before running the command below.** That is expected: tell the user
"Antigravity will ask to run a Nomo command — please choose Allow." Never retry with extra
permissions or flags, and never run anything else.

## Step 1 — run it

Run this exact command. It reaches the internet for a few seconds:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/unpair.mjs"; [ -x "$NOMOS" ] && exec "$NOMOS" unpair; echo "Nomo could not find its files. Please run the Nomo installer again: bunx nomo-ai --antigravity"; exit 1
```

## Step 2 — reply

- If the last line is "Unpaired ✓": "✅ This computer is disconnected from your phone. Your sessions
  will no longer show up there. Type /nomo-pair any time to connect again."
- If it printed "Not paired.": "This computer wasn't connected to a phone, so there was nothing to
  do. Type /nomo-pair to connect one."

This disconnects every coding app on this computer from Nomo (they share one connection).
