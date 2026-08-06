---
name: nomo-unpair
description: Unpair this computer from the Nomo iPhone app and remove local pairing state. Use when the user asks to unpair, disconnect their phone, unlink this machine, or stop mirroring Codex sessions to Nomo.
---

## Step 1 — resolve the plugin path

Skills get no `PLUGIN_ROOT`, so find it first. Run this exact command:

```
codex plugin list
```

It is a local, read-only command — no approval needed. In its output, find the row whose **PLUGIN**
column starts with `nomo@` and take that row's **PATH** column value as `<ROOT>`.

## Step 2 — unpair

Network calls need sandbox escalation in Codex. **Request escalated/approved permissions up front**
(the revoke is a best-effort HTTPS call to the Nomo relay), then run this exact command and show its
output **verbatim** to the user:

```
NOMOR="<ROOT>"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/unpair.mjs"; [ -x "$NOMOS" ] && exec "$NOMOS" unpair; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

It revokes the pairing on the server (best-effort) and deletes the local pairing config, then prints a
short status line. **Relay that line to the user.** It **always exits 0** — "Not paired" is a normal,
successful outcome, not an error. Treat any exit-0 result as success regardless of what it reports.
