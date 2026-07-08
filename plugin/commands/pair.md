---
description: Pair this computer with the Nomo iPhone app via a QR code (end-to-end encrypted)
---

Pairing is two quick steps: **show the QR fast**, then **wait for the phone to scan it**. Run them
in order, both in the **foreground**.

## Step 1 — show the QR (fast)

Run this exact command in the foreground and wait for it to finish (it returns in a second or two):

```
"${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "${CLAUDE_PLUGIN_ROOT}/dist/pair.mjs"
```

- **Reproduce ONLY the QR block in your reply.** The command prints the QR fenced between two marker
  lines — `──── NOMO PAIRING QR … ────` above and `──── end QR ────` below. Copy **exactly** the lines
  **between** those two markers (the QR art itself) into your reply inside a fenced (triple-backtick)
  code block, so the user can scan it right from the chat. Preserve every character and line — no
  re-indenting, cropping, or substituting; a mangled QR won't scan.
- **Never reproduce anything OUTSIDE the QR block.** In particular, do not echo — or invent — any
  `nomo://pair…` link or `s=` value. The command does not print that link, and it must never appear
  in your reply: it is a plaintext copy of the end-to-end secret and would leak into the transcript.
  Reproduce the QR, and nothing else from the output.
- This step registers the pairing and prints the QR, then exits. It does **not** wait for the
  phone — that's step 2.
- If the command prints an error line instead of a QR (network, rate-limit), relay that error line
  to the user and stop; do not proceed to step 2.

After the command finishes (and only if it did not error), show the QR block in a fenced code block
and tell the user, in your own words:

> Scan this QR with the Nomo app on your iPhone: open the **Sessions** tab, tap **"Pair a Computer"**,
> and point the camera at the QR above. The code expires in 10 minutes.

## Step 2 — wait for the scan

Now run this exact command in the foreground and wait for it to finish (blocking here is fine — the
QR is already visible, and this just waits for the phone):

```
"${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "${CLAUDE_PLUGIN_ROOT}/dist/pair.mjs" wait
```

- It polls for up to 10 minutes until the phone claims the pairing, then prints `Paired with … ✓`
  (or a plain `Paired ✓` when the self-heal watchdog completed the pairing first — same success).
- **Relay its final line to the user.** On `Paired with … ✓` / `Paired ✓`, tell the user pairing is
  complete and this machine's Claude Code sessions will now appear in the Nomo app.
- On failure (e.g. "Pairing window expired" or "expired or was removed"), tell the user the QR
  timed out and suggest re-running `/nomo-cc:pair` to get a fresh code.
