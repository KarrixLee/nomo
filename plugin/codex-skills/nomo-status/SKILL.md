---
name: nomo-status
description: Show Nomo pairing, watchdog, hook-trust, and event-delivery health for this computer. Use when the user asks whether Nomo is paired or working, wants to check the Nomo connection, or asks why their Codex sessions aren't showing up on their iPhone.
---

## Step 1 — resolve the plugin path

Skills get no `PLUGIN_ROOT`, so find it first. Run this exact command:

```
codex plugin list
```

It is a local, read-only command — no approval needed. In its output, find the row whose **PLUGIN**
column starts with `nomo@` and take that row's **PATH** column value as `<ROOT>`.

## Step 2 — show status

Run this exact command and present its output block **as-is**:

```
exec "<ROOT>/scripts/run.sh" "<ROOT>/dist/status-cmd.mjs"
```

It prints a short health readout: whether this machine is paired (and to which worker), whether the
liveness watchdog is running, when the last event was delivered, and how many sessions are tracked.
This is a read-only local command — no approval needed. It **always exits 0** — "Paired: no" is
information, not an error; if the user isn't paired, point them at the **nomo-pair** skill.

If the output reports that **Codex hooks are not trusted**, tell the user to run `/hooks` in Codex and
**trust the Nomo entries** — until then Codex sessions stay inert and won't reach the phone.
