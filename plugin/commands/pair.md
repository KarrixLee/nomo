---
description: Pair this computer with the Nomo iPhone app via a QR code (end-to-end encrypted)
---

Pairing is two quick steps: **open the pairing page**, then **wait for the phone to scan it**. Run
them in order, both in the **foreground**.

## Step 1 — open the pairing page (fast)

Run this exact command in the foreground and wait for it to finish (it returns in a second or two):

```
"${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "${CLAUDE_PLUGIN_ROOT}/dist/pair.mjs"
```

- This registers the pairing, writes a themed pairing **page**, and **opens it in the user's default
  browser**, then exits. It does **not** wait for the phone — that's step 2.
- **The command's output tells you what happened — relay it in your own words:**
  - `Pairing page opened in your browser.` → tell the user to look at the browser window/tab that
    just opened; the QR code and a one-time pairing code are shown there.
  - `Open this file in a browser: <path>` (the browser couldn't be launched — headless/SSH) → give
    the user that **file path** and tell them to open it in a browser on the machine's display.
- **NEVER reproduce QR art, and never echo or invent any `nomo://pair…` URL, `s=` value, or the code
  words** in your reply. None of that is printed to stdout — it lives ONLY on the pairing page — and
  it must never enter the chat transcript: it is the end-to-end secret. Relay only the neutral status
  lines above.
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
