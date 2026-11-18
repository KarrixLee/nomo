---
name: pair
description: Pair this computer with the Nomo iPhone app via a QR code (end-to-end encrypted)
triggers:
  - user
---

Pairing is two steps: **hand off the pairing** (opens a QR page in the browser), then **wait for the
phone to claim it**. Run both with the exec tool, in the foreground, in order. Both need network access
(they reach the Nomo relay over HTTPS).

One pairing covers every agent on this computer — if this machine is already paired from Claude Code,
Codex, Cursor or OpenCode there is nothing to do, and `/nomo:status` will say so.

## Which path — read the text after `/nomo:pair` first

- **Nothing after it** → **default browser path.** Run step 1 exactly as written: it opens a themed
  pairing page (QR + click-to-reveal code) in the browser and keeps the one-time code out of this
  chat.
- **The text is `code`** (trim whitespace, case-insensitive) → **no-browser code path.** The user
  explicitly asked for the typeable code without a browser (headless / SSH). Run step 1's code-path
  command: it skips the browser/QR page and prints **only** the one-time pairing code into this chat.
  Relay that code plus the app instructions (**Nomo → Sessions → "Pair a Computer" → "Enter code"**).
- **Anything else** → treat it as the **default browser path** (do not error).

Either way: **only the short typeable code may ever be printed — the `nomo://pair…` / `s=` deep link
and the QR art must NEVER be echoed or reconstructed.**

## Step 1 — hand off the pairing (returns in a second or two)

**Default browser path:**

```
/bin/sh -c 'NOMOS="$HOME/.config/cc-status/hook-shim.sh"; for NOMOR in "$HOME"/.local/share/devin/cli/plugins/cache/*nomo*/*/plugin; do [ -x "$NOMOR/scripts/run.sh" ] && [ -f "$NOMOR/dist/pair.mjs" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/pair.mjs"; done; [ -x "$NOMOS" ] && exec "$NOMOS" pair; echo "Nomo could not find its installed files - reinstall: devin plugins install KarrixLee/nomo"; exit 1'
```

**Code path** (the text after `/nomo:pair` is `code`):

```
/bin/sh -c 'NOMOS="$HOME/.config/cc-status/hook-shim.sh"; for NOMOR in "$HOME"/.local/share/devin/cli/plugins/cache/*nomo*/*/plugin; do [ -x "$NOMOR/scripts/run.sh" ] && [ -f "$NOMOR/dist/pair.mjs" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/pair.mjs" --show-code; done; [ -x "$NOMOS" ] && exec "$NOMOS" pair --show-code; echo "Nomo could not find its installed files - reinstall: devin plugins install KarrixLee/nomo"; exit 1'
```

Neither waits for the phone — that is step 2. **Relay what the command printed, in your own words:**

- `Pairing page opened in your browser.` → the pairing page just opened in a browser window; scan the
  QR, or click **"Tap to reveal code"** and enter the code in the app (Nomo → Sessions → "Pair a
  Computer" → "Enter code").
- `Open this file in a browser: <path>` (no browser could be launched) → give the user that **file
  path** to open on the machine's display.
- `The one-time code is hidden for privacy — …` → the code is deliberately kept out of this chat; it
  can be revealed on the pairing page. Only if the user says they cannot open a browser, re-run with
  the code path — and say first that it prints the code into this chat.
- An error line (network, rate limit) → relay it and stop.

## Step 2 — wait for the scan

```
/bin/sh -c 'NOMOS="$HOME/.config/cc-status/hook-shim.sh"; for NOMOR in "$HOME"/.local/share/devin/cli/plugins/cache/*nomo*/*/plugin; do [ -x "$NOMOR/scripts/run.sh" ] && [ -f "$NOMOR/dist/pair.mjs" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/pair.mjs" wait --timeout 60; done; [ -x "$NOMOS" ] && exec "$NOMOS" pair wait --timeout 60; echo "Nomo could not find its installed files - reinstall: devin plugins install KarrixLee/nomo"; exit 1'
```

- `Paired with … ✓` / `Paired ✓` → pairing is complete; this computer's Devin sessions now appear in
  the Nomo app from the next prompt on. No restart is needed.
- Timeout → pairing **completes in the background** the moment the phone scans; there is no need to
  re-run this. `/nomo:status` confirms it any time.
