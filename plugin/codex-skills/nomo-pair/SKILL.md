---
name: nomo-pair
description: Pair this computer with the Nomo iPhone app via a QR code (end-to-end encrypted). Use when the user asks to pair, connect their phone, set up Nomo, or link this machine so Codex sessions appear on their iPhone.
---

Pairing is: **resolve the plugin path**, **open the pairing page**, then **confirm the scan**.
Run the steps in order, in the foreground.

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
command fail. Then run this exact command in the foreground and wait for it to finish (it returns in
a second or two):

```
exec "<ROOT>/scripts/run.sh" "<ROOT>/dist/pair.mjs"
```

- This writes a themed pairing **page** and **opens it in the default browser**, outside the Codex
  TUI (a folded terminal QR is unreliable in Codex). The page shows the QR **and** a one-time pairing
  code. **Relay the script's printed status line to the user in your own words:**
  - `Pairing page opened in your browser.` → tell them to look at the browser window that just
    opened, then scan the QR in Nomo → Sessions → "Pair a Computer" (or tap "Enter code" and type the
    code shown on the page).
  - `Open this file in a browser: <path>` → the browser couldn't launch; give them that **file path**
    to open on the machine's display.
- **Do NOT reproduce QR art in your reply, and NEVER echo, reconstruct, or invent any `nomo://pair…`
  URL, `s=` value, or the code words.** None of that is printed to stdout — it lives ONLY on the page —
  and it must never enter the transcript: it is the end-to-end secret. Relay only the neutral status
  line above.
- **Fallback for SSH / headless (the user can't see a browser page):** if the user says they cannot
  open the pairing page — no display, working over SSH, or you got `Open this file in a browser:
  <path>` with no way to open it — re-run the command with `--show-code` appended:
  ```
  exec "<ROOT>/scripts/run.sh" "<ROOT>/dist/pair.mjs" --show-code
  ```
  It then prints a `One-time code: <code> · expires in 10 min` line. In that case ONLY, relay the code
  to the user, note it is **one-time and expires in 10 minutes**, and have them type it in Nomo
  (**Sessions → Pair a Computer → “Enter code”**). Never use `--show-code` by default — only once the
  user has confirmed they can't view the page.
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

Edit Codex's config file — `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` — as follows.
Read its current `notify` line first, then:

- **Already wired** (the `notify` array's first element ends in `scripts/notify-chain.sh`): leave it
  as-is — do NOT double-wrap.
- **No `notify` line yet**: add
  ```
  notify = ["<ROOT>/scripts/notify-chain.sh", "<ROOT>/dist/codex-notify.mjs"]
  ```
- **An existing `notify = [<prog>, <args…>]`** (e.g. the computer-use `SkyComputerUseClient`): WRAP it,
  preserving every original element after a literal `"--"` separator:
  ```
  notify = ["<ROOT>/scripts/notify-chain.sh", "<ROOT>/dist/codex-notify.mjs", "--", <prog>, <args…>]
  ```

Substitute the real `<ROOT>` from Step 1. Codex appends the JSON payload as the final array element at
runtime, so the wrapper passes it to `codex-notify.mjs` and (after `--`) re-invokes the original
program with that payload in the exact position it expects. Tell the user this makes "done" alerts
reliable even when a Codex hook misfires.

## Step 5 — trust the hooks (fresh install only)

If this is a fresh install, remind the user: the six Nomo hooks are **inert until trusted**. They must
run `/hooks` in Codex once and **trust the six Nomo entries** — one time only; updates never re-prompt
unless the hook lines change (they don't). Without this, Codex sessions won't mirror to the phone.
