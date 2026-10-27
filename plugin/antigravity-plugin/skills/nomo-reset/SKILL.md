---
name: nomo-reset
description: Clear stuck or ghost Nomo sessions from the iPhone app without disconnecting the phone. Run ONLY when the user types /nomo-reset — never on your own.
---

**How to talk to the user.** Nomo users are often not technical. Reply in plain, friendly words,
one next step at a time. Never mention hooks, scripts, file paths, JSON, exit codes or the "watchdog".

**Antigravity may ask before running the command below.** That is expected: tell the user
"Antigravity will ask to run a Nomo command — please choose Allow." Never retry with extra
permissions or flags, and never run anything else.

## Step 1 — run it

Run this exact command. It may reach the internet for a few seconds (it tells your phone which
sessions ended):

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/reset.mjs"; [ -x "$NOMOS" ] && exec "$NOMOS" reset; echo "Nomo could not find its files. Please run the Nomo installer again: bunx nomo-ai --antigravity"; exit 1
```

## Step 2 — reply

- If it printed "Cleared N stale session record(s)": "✅ Cleaned up N old session(s). They will
  disappear from your phone in a moment. Your phone is still connected."
- If it printed "No stale sessions to clear": "✅ Nothing was stuck — your sessions look fine. Your
  phone is still connected."
- Anything else: say in one plain sentence what happened, then "Your phone is still connected."

Do not mention the watchdog or the other technical lines.
