---
name: nomo-pair
description: Pair this computer with the Nomo iPhone app via a QR code (end-to-end encrypted). Use when the user asks to pair, connect their phone, set up Nomo, or link this machine so Codex sessions appear on their iPhone.
---

Pairing is: **resolve the plugin path**, **open the pairing page**, then **confirm the scan**.
Run the steps in order, in the foreground.

## Which path — read the text after `$nomo-pair` first

The text the user typed after `$nomo-pair` decides how step 2 hands off the pairing. Steps 1, 3, 4,
and 5 are identical either way.

- **No argument** (nothing after `$nomo-pair`) → **default browser path.** Run step 2 exactly as
  written: it opens a themed pairing page (QR + click-to-reveal code) in the browser and keeps the
  one-time code out of this transcript.
- **The argument is `code`** (trim whitespace, case-insensitive) → **no-browser code path.** The user
  explicitly asked for the typeable code without a browser (headless / SSH). Run step 2's command with
  `--show-code` appended (see the code-path block in step 2): this skips the browser/QR page and
  prints **only** the one-time pairing code straight into this transcript. Relay that printed code to
  the user, plus the app instructions (**Nomo → Sessions → "Pair a Computer" → "Enter code"**). This
  puts the code in the transcript, but that trade-off is intended here — the user opted in by typing
  `code`.
- **Any other value** → treat it as the **default browser path** (do not error).

Whichever path you take, the guard in step 2 still holds: **only the short typeable code may ever be
printed — the `nomo://pair…` / `s=` deep link and the QR art must NEVER be echoed or reconstructed.**

## Step 1 — resolve the plugin path

Skills get no `PLUGIN_ROOT`, so find it first. Run this exact command:

```
codex plugin list
```

It is a local, read-only command — no approval needed. In its output, find the row whose **PLUGIN**
column starts with `nomo@` and take that row's **PATH** column value as `<ROOT>`. Every command below
uses `<ROOT>` — substitute the real path you just read.

If no `nomo@…` row exists, the plugin isn't installed — tell the user to add the Nomo marketplace and
install the `nomo` plugin, then stop.

## Step 2 — open the pairing page (outside the TUI)

Network calls need sandbox escalation in Codex. **Request escalated/approved permissions up front**
and tell the user it's because pairing has to reach the Nomo relay over HTTPS — don't just let the
command fail. Then run the command for your path (from **Which path** above) in the foreground and
wait for it to finish (it returns in a second or two). Use **exactly one** of these two forms:

**Default browser path** (no argument) — opens the QR page, code stays hidden from the transcript:

```
exec "<ROOT>/scripts/run.sh" "<ROOT>/dist/pair.mjs"
```

**Code path** (the argument is `code`) — no browser; prints the one-time code into this transcript:

```
exec "<ROOT>/scripts/run.sh" "<ROOT>/dist/pair.mjs" --show-code
```

- The **default** command writes a themed pairing **page** and **opens it in the default browser**,
  outside the Codex TUI (a folded terminal QR is unreliable in Codex). The **code** command skips that
  page entirely and prints only the one-time typeable code. On the default path the page shows the QR
  **and** a one-time pairing code, hidden behind a "Tap to reveal code" control until clicked — the
  code is **not** printed to stdout/the transcript by default. **Relay the script's printed lines to
  the user in your own words:**
  - `Pairing page opened in your browser.` → tell them the pairing page just opened in a browser
    window, where they can scan the QR, or click **"Tap to reveal code"** to see the one-time code and
    enter it in the app (Nomo → Sessions → "Pair a Computer" → "Enter code").
  - `Open this file in a browser: <path>` → the browser couldn't launch; give them that **file path**
    to open on the machine's display.
  - `The one-time code is hidden for privacy — …` → tell the user the code is deliberately kept out of
    this transcript; it can be revealed on the pairing page instead. **Only if the user says they
    genuinely can't open a browser** (headless/SSH-only), re-run this step yourself with `--show-code`
    appended — mention first that doing so prints the code straight into this transcript.
- **Do NOT reproduce QR art in your reply, and NEVER echo, reconstruct, or invent any `nomo://pair…`
  URL or `s=` value**, regardless of which variant of this step you ran. The `nomo://` deep link is the
  QR's end-to-end secret; it is never printed to stdout — it lives ONLY on the page — and it must
  never enter the transcript.
- If the command prints an error line instead (network, rate-limit), relay that line and stop.

## Step 3 — confirm the scan

Run this exact command once and relay its final line:

```
exec "<ROOT>/scripts/run.sh" "<ROOT>/dist/pair.mjs" wait --timeout 60
```

- On `Paired with … ✓` / `Paired ✓`, tell the user pairing is complete and this machine's Codex
  sessions will now appear in the Nomo app.
- On timeout, tell the user pairing **completes in the background** once they scan — no need to
  re-run pair. They can confirm any time with the **nomo-status** skill.

## Step 4 — wire the `notify` backstop

Codex's lifecycle hooks occasionally fail to fire a turn's `Stop` (upstream openai/codex#16430,
#30835), so a finished turn can silently never reach the phone. Codex's separate, stable `notify`
channel is the backstop: on turn completion Codex runs the configured program with one JSON payload
appended. Point it at Nomo's chain wrapper, which fires `dist/codex-notify.mjs` (a de-duplicated
"done" push) **and** forwards the payload to any pre-existing notify program so nothing breaks.

Run this exact command and relay its final line (do NOT hand-edit `config.toml` yourself — the
command is idempotent: it unwraps any previous Nomo wrapping, preserves the innermost original
notify program, and rewrites the `notify` line exactly once, backing up the previous file to
`config.toml.bak-nomo`):

```
exec "<ROOT>/scripts/run.sh" "<ROOT>/dist/pair.mjs" wire-notify "<ROOT>"
```

- `Codex notify backstop wired…` / `already wired — no change` → done; tell the user this makes
  "done" alerts reliable even when a Codex hook misfires (any pre-existing notify program keeps
  running unchanged).
- `Couldn't safely parse the existing notify line…` → the command refused to touch an unusual
  `notify` value; relay its printed replacement line so the user can set it manually.

Codex appends the JSON payload as the final array element at runtime, so the wrapper passes it to
`codex-notify.mjs` and (after `--`) re-invokes the original program with that payload in the exact
position it expects.

## Step 5 — trust the hooks (fresh install only)

If this is a fresh install, remind the user: the six Nomo hooks are **inert until trusted**. They must
run `/hooks` in Codex once and **trust the six Nomo entries** — one time only; updates never re-prompt
unless the hook lines change (they don't). Without this, Codex sessions won't mirror to the phone.
