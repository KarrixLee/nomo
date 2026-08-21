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
NOMOR="<ROOT>"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/status-cmd.mjs" codex; [ -x "$NOMOS" ] && exec "$NOMOS" status-cmd codex; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

The trailing `codex` tells the readout who is asking, so it leads with **Codex**. It prints the
machine-wide facts first (pairing, worker, delivery, whether remote approvals are paused), then a
Codex section — hooks firing, plugin/trust state, whether Plan questions can be answered from the
phone, and how many of the tracked sessions are Codex's — and finally one condensed line per other
agent installed on this computer.

Present the block as-is; do not summarise or re-order it. This is a read-only local command — no
approval needed. It **always exits 0** — "NOT PAIRED" is information, not an error; if the user
isn't paired, point them at the **nomo-pair** skill.

Any line beginning with `!` is a real problem and the `→` line under it is the fix — read those out.
In particular, if the output says Codex has **not trust-reviewed Nomo's hooks**, tell the user to run
`/hooks` in Codex and **trust the Nomo entries** — until then Codex sessions stay inert and won't
reach the phone.
