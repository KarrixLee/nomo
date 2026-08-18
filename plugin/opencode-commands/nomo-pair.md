---
description: Pair this computer with the Nomo iPhone app via a QR code (end-to-end encrypted)
---

Pairing is two steps: **hand off the pairing** (opens a QR page in the browser), then **wait for the
phone to claim it**. Run both in the foreground, in order.

One pairing covers every agent on this computer — if this machine is already paired from Claude Code
or Codex there is nothing to do, and `/nomo-status` will say so.

## Which path — read `$ARGUMENTS` first

- **No argument** → **default browser path.** Run step 1 exactly as written: it opens a themed
  pairing page (QR + click-to-reveal code) in the browser and keeps the one-time code out of this
  transcript.
- **`$ARGUMENTS` is `code`** (trim whitespace, case-insensitive) → **no-browser code path.** The user
  explicitly asked for the typeable code without a browser (headless / SSH). Run step 1's command
  with `--show-code` appended: this skips the browser/QR page and prints **only** the one-time
  pairing code straight into this transcript. Relay that printed code plus the app instructions
  (**Nomo → Sessions → "Pair a Computer" → "Enter code"**). This puts the code in the transcript, but
  the user opted in by typing `code`.
- **Any other value** → treat it as the **default browser path** (do not error).

Either way: **only the short typeable code may ever be printed — the `nomo://pair…` / `s=` deep link
and the QR art must NEVER be echoed or reconstructed.**

## Step 1 — hand off the pairing (fast, returns in a second or two)

**Default browser path** (no argument):

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/pair.mjs"; [ -x "$NOMOS" ] && exec "$NOMOS" pair; echo "Nomo could not find its installed files - re-run plugin/scripts/opencode-install.sh."; exit 1
```

**Code path** (`$ARGUMENTS` is `code`) — no browser; prints the one-time code into this transcript:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/pair.mjs" --show-code; [ -x "$NOMOS" ] && exec "$NOMOS" pair --show-code; echo "Nomo could not find its installed files - re-run plugin/scripts/opencode-install.sh."; exit 1
```

Neither one waits for the phone — that is step 2. **The command's output tells you what happened —
relay it in your own words:**

- `Pairing page opened in your browser.` → tell the user the pairing page just opened in a browser
  window, where they can scan the QR, or click **"Tap to reveal code"** to see the one-time code and
  enter it in the app (Nomo → Sessions → "Pair a Computer" → "Enter code").
- `Open this file in a browser: <path>` (the browser couldn't be launched — headless/SSH) → give the
  user that **file path** to open on the machine's display.
- `The one-time code is hidden for privacy — …` → tell the user the code is deliberately kept out of
  this transcript; they can reveal it on the pairing page. **Only if the user says they can't open a
  browser at all**, re-run step 1 with `--show-code` appended — mention first that this prints the
  code straight into the transcript.
- An error line instead (network, rate-limit) → relay it and stop; do not run step 2.

**Do NOT reproduce QR art, and NEVER echo, reconstruct, or invent any `nomo://pair…` URL or `s=`
value.** The deep link is the QR's end-to-end secret; it is never printed to stdout — it lives ONLY
on the pairing page.

## Step 2 — wait for the scan

**Relay step 1 first** — the "pairing page opened" note, or (on the code path) the one-time code and
app instructions must already be in your reply before you start the wait, or the user will be
staring at a blocked terminal with nothing to scan.

Then run this exact command once in the foreground and relay its final line:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/pair.mjs" wait --timeout 100; [ -x "$NOMOS" ] && exec "$NOMOS" pair wait --timeout 100; echo "Nomo could not find its installed files - re-run plugin/scripts/opencode-install.sh."; exit 1
```

- `Paired with … ✓` / `Paired ✓` → pairing is complete; this machine's OpenCode sessions will now
  appear in the Nomo app.
- Timeout → tell the user pairing **completes in the background** the moment they scan; there is no
  need to re-run pair. They can confirm any time with `/nomo-status`.

## Step 3 — one restart, on a fresh install only

The Nomo plugin reads the pairing config **once, when the OpenCode server starts**. If this machine
was unpaired when you launched OpenCode, the plugin already decided to no-op for this process. Tell
the user to **quit and reopen OpenCode** so the newly paired session starts mirroring. There is no
hot reload.
