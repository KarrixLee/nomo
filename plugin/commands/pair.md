---
description: Pair this computer with the Nomo iPhone app via a QR code (end-to-end encrypted)
argument-hint: [code]
---

Pairing is two quick steps: **do step 1** (register + hand off the pairing), then **wait for the
phone to claim it** (step 2). Run them in order, both in the **foreground**.

## Which path — read `$ARGUMENTS` first

The `$ARGUMENTS` string decides how step 1 hands off the pairing. Step 2 is identical either way.

- **No argument** (`$ARGUMENTS` is empty) → **default browser path.** Run step 1 exactly as written
  below: it opens a themed pairing page (QR + click-to-reveal code) in the browser and keeps the
  one-time code out of this terminal.
- **`$ARGUMENTS` is `code`** (trim whitespace, case-insensitive) → **no-browser code path.** The user
  explicitly asked for the typeable code without a browser (headless / SSH). Run step 1's command with
  `--show-code` appended (see the code-path block below): this skips the browser/QR page and prints
  **only** the one-time pairing code straight into this terminal/transcript. Relay that printed code to
  the user, plus the app instructions (**Sessions → Pair a Computer → “Enter code”**). This puts the
  code in the transcript, but that trade-off is intended here — the user opted in by typing `code`.
- **Any other value** of `$ARGUMENTS` → treat it as the **default browser path** (do not error).

Whichever path you take, the guard in step 1 still holds: **only the short typeable code may ever be
printed — the `nomo://pair…` / `s=` deep link and the QR art must NEVER be echoed or reconstructed.**

## Step 1 — hand off the pairing (fast)

Run the command for your path in the foreground and wait for it to finish (it returns in a second or
two). Use **exactly one** of these two forms:

**Default browser path** (no argument) — opens the QR page, code stays hidden from the terminal:

```
"${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "${CLAUDE_PLUGIN_ROOT}/dist/pair.mjs"
```

**Code path** (`$ARGUMENTS` is `code`) — no browser; prints the one-time code into this terminal:

```
"${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "${CLAUDE_PLUGIN_ROOT}/dist/pair.mjs" --show-code
```

- The **default** command registers the pairing, writes a themed pairing **page**, and **opens it in
  the user's default browser**, then exits. The **code** command skips that page entirely and prints
  only the one-time typeable code. Neither one waits for the phone — that's step 2. On the default path
  the page shows the QR
  **and** a one-time pairing code, hidden behind a "Tap to reveal code" control until clicked — the
  code is not printed to the terminal by default.
- **The command's output tells you what happened — relay it in your own words:**
  - `Pairing page opened in your browser.` → tell the user the pairing page just opened in a browser
    window/tab, where they can scan the QR, or click **"Tap to reveal code"** to see the one-time code
    and enter it in the app (**Sessions → Pair a Computer → “Enter code”**).
  - `Open this file in a browser: <path>` (the browser couldn't be launched — headless/SSH) → give
    the user that **file path** to open on the machine's display.
  - `The one-time code is hidden for privacy — …` → tell the user the code is deliberately kept out of
    this terminal/transcript; they can reveal it on the pairing page. **Only if the user says they
    can't open a browser at all** (a truly headless/SSH-only box), re-run **step 1** yourself with
    `--show-code` appended — note this prints the code straight into this transcript, so mention that
    trade-off to the user first.
- **NEVER reproduce QR art, and never echo, reconstruct, or invent any `nomo://pair…` URL or `s=`
  value** in your reply, regardless of which variant of step 1 you ran. The `nomo://` deep link is the
  QR's end-to-end secret; it is never printed to stdout — it lives ONLY on the pairing page — and it
  must never enter the chat transcript.
- If the command prints an error line instead (network, rate-limit), relay that error line to the
  user and stop; do not proceed to step 2.

## Step 2 — wait for the scan

Now run this exact command in the foreground and wait for it to finish (blocking here is fine — the
pairing page is already open, and this just waits for the phone):

```
"${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "${CLAUDE_PLUGIN_ROOT}/dist/pair.mjs" wait
```

- It polls for up to 10 minutes until the phone claims the pairing, then prints `Paired with … ✓`
  (or a plain `Paired ✓` when the self-heal watchdog completed the pairing first — same success).
- **Relay its final line to the user.** On `Paired with … ✓` / `Paired ✓`, tell the user pairing is
  complete and this machine's Claude Code sessions will now appear in the Nomo app.
- On failure (e.g. "Pairing window expired" or "expired or was removed"), tell the user the QR
  timed out and suggest re-running `/nomo-cc:pair` to get a fresh code.
