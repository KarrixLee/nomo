---
name: nomo-approvals
description: Turn Nomo phone approvals on or off for this computer (whether Antigravity asks your iPhone before running commands or changing files). Run ONLY when the user types /nomo-approvals — never on your own.
---

**How to talk to the user.** Nomo users are often not technical. Reply in plain, friendly words,
one next step at a time. Never mention hooks, scripts, file paths, JSON, exit codes or the "watchdog".

**Antigravity may ask before running the command below.** That is expected: tell the user
"Antigravity will ask to run a Nomo command — please choose Allow." Never retry with extra
permissions or flags, and never run anything else.

## Step 1 — what did the user ask for?

Read the text after `/nomo-approvals`, trimmed and lowercased:

- `off` (or "pause", "stop") → use `off`
- `on` (or "resume", "start") → use `on`
- anything else, or nothing → use `status`

## Step 2 — run it

Run this exact command, with `<on|off|status>` replaced by your choice:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/cc-permission.mjs" <on|off|status>; [ -x "$NOMOS" ] && exec "$NOMOS" cc-permission <on|off|status>; echo "Nomo could not find its files. Please run the Nomo installer again: bunx nomo-ai --antigravity"; exit 1
```

It only flips a setting on this computer (no internet) and returns at once.

## Step 3 — reply with exactly one of these

- After `on`, or a status that says ON:
  "✅ Phone approvals are on. When Antigravity wants to run a command or change a file in a session
  your phone is showing, your iPhone will ask you to Allow or Deny."
- After `off`, or a status that says OFF:
  "⏸️ Phone approvals are paused. Antigravity will ask you on this computer instead. Type
  /nomo-approvals on to turn them back on."

This switch is shared by every coding app on this computer that uses Nomo (for example Claude Code
and Codex too). It does not disconnect the phone.
