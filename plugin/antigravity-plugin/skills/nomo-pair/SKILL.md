---
name: nomo-pair
description: Connect this computer to the Nomo iPhone app with a QR code (end-to-end encrypted). Run ONLY when the user types /nomo-pair — never on your own.
---

**How to talk to the user.** Nomo users are often not technical. Reply in plain, friendly words,
one next step at a time. Never mention hooks, scripts, file paths, JSON, exit codes or the "watchdog".

**Antigravity may ask before running the command below.** That is expected: tell the user
"Antigravity will ask to run a Nomo command — please choose Allow." Run the command EXACTLY as
written — one line, nothing added before or after it, no `cd`, no extra flags — and never run
anything else. If it fails because a file is missing, tell the user: "Nomo's files seem to be
missing — please run the Nomo installer again: bunx nomo-ai --antigravity" and stop.

Connecting is two steps: **show the code**, then **wait for the phone**. Both reach the internet.
One connection covers every coding app on this computer — if it is already connected (for example
from Claude Code or Codex), step 1 says so and you are done.

## Which way — read the text after `/nomo-pair`

- **Nothing** → the browser way (step 1a). It opens a page with a QR code and keeps the one-time
  code out of this chat.
- **`code`** (any capitalisation) → the typed-code way (step 1b), for a computer without a browser
  window. It prints a short code into this chat.
- **Anything else** → the browser way.

Never repeat or make up a `nomo://` link or QR art. Only the short typed code may be shown.

## Step 1a — browser way

```
{{nomo-command pair}}
```

Reply, depending on what it printed:

- "Pairing page opened in your browser." → "📱 A page with a QR code just opened in your browser.
  On your iPhone, open Nomo → Sessions → Pair a Computer, and scan it."
- "Open this file in a browser: …" → "📱 Please open this file in a browser on this computer, then
  scan the QR code with Nomo on your iPhone:" followed by the file path it printed.
- "already paired" → "✅ This computer is already connected to your phone." and stop.
- An error → say what went wrong in one plain sentence and stop.

## Step 1b — typed-code way

```
{{nomo-command pair-code}}
```

Reply: "📱 On your iPhone, open Nomo → Sessions → Pair a Computer → Enter code, and type:" followed
by only the code it printed ("One-time code: …"). It expires in 10 minutes.

## Step 2 — wait for the phone

Run this exact command. It waits up to a minute for the scan; if Antigravity moves it to the
background, check its output until it finishes:

```
{{nomo-command pair-wait}}
```

- "Paired with … ✓" or "Paired ✓" → "✅ Done! This computer is connected to your phone. Your
  Antigravity sessions will show up in Nomo from your next message."
- "Still waiting for the scan" → "No problem — scan whenever you're ready. It finishes by itself;
  type /nomo-status later to check."
