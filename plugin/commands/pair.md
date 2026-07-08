---
description: Pair this computer with the Nomo iPhone app via a QR code (end-to-end encrypted)
---

Pairing is two quick steps: **open the pairing page**, then **wait for the phone to scan it**. Run
them in order, both in the **foreground**.

## Step 1 — open the pairing page (fast)

Run this exact command in the foreground and wait for it to finish (it returns in a second or two):

```
"${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "${CLAUDE_PLUGIN_ROOT}/dist/pair.mjs" --show-code
```

- This registers the pairing, writes a themed pairing **page**, and **opens it in the user's default
  browser**, then exits. It does **not** wait for the phone — that's step 2. `--show-code` also prints
  the one-time pairing code to stdout so it works everywhere, including SSH/headless where the browser
  page can't be seen.
- **The command's output tells you what happened — relay it in your own words:**
  - `One-time code: <code> · expires in 10 min` → relay this code to the user **prominently**, e.g.
    "Your one-time code: `7-ocean-sunset-mango-river`", and tell them to either **scan the QR on the
    pairing page** or **enter this code in the app** (**Sessions → Pair a Computer → “Enter code”**).
    Note it is **one-time and expires in 10 minutes**.
  - `Pairing page opened in your browser.` → tell the user the pairing page just opened in a browser
    window/tab, where the QR code (and the same code) are shown.
  - `Open this file in a browser: <path>` (the browser couldn't be launched — headless/SSH) → give
    the user that **file path** to open on the machine's display. The code above still lets them pair
    without the page.
- **NEVER reproduce QR art, and never echo, reconstruct, or invent any `nomo://pair…` URL or `s=`
  value** in your reply. The `nomo://` deep link is the QR's end-to-end secret; it is never printed to
  stdout — it lives ONLY on the pairing page — and it must never enter the chat transcript. The
  one-time pairing code is safe to relay (short-lived, single-use); the `nomo://…` URL is not.
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
