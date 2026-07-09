---
name: nomo-reset
description: Reset stuck Nomo session state — stop the watchdog and clear dead or phantom session rows from the iPhone app WITHOUT unpairing. Use when the user says Nomo sessions are stuck, ghost/phantom sessions won't go away, the Dynamic Island shows a session that ended long ago, or "reset Nomo" — but NOT when they want to disconnect their phone (that's nomo-unpair).
---

## Step 1 — resolve the plugin path

Skills get no `PLUGIN_ROOT`, so find it first. Run this exact command:

```
codex plugin list
```

It is a local, read-only command — no approval needed. In its output, find the row whose **PLUGIN**
column starts with `nomo@` and take that row's **PATH** column value as `<ROOT>`.

## Step 2 — reset

Network calls need sandbox escalation in Codex. **Request escalated/approved permissions up front**
(clearing a phantom row sends a best-effort "session ended" signal to the Nomo relay over HTTPS),
then run this exact command — it returns in a few seconds, well inside Codex's shell limits — and
show its output **verbatim** to the user:

```
exec "<ROOT>/scripts/run.sh" "<ROOT>/dist/reset.mjs"
```

What it does (relay the printed summary):

- Stops the liveness watchdog if one is running (it verifies the pid really is the watchdog before
  killing anything, then removes the pidfile). The watchdog **restarts automatically on the next
  session event** — stopping it is always safe.
- Sweeps the local session records: every record whose process is dead (or that is a provisional
  placeholder) gets an "ended" signal sent to the phone so its row actually clears, then the record
  is deleted. Sessions whose process is still alive are left untouched.
- **Pairing and encryption keys are NOT touched** — the phone stays paired. If the user wants to
  disconnect entirely, that's the **nomo-unpair** skill instead.

It **always exits 0** — "No watchdog running" / "No stale sessions to clear" are normal, successful
outcomes, not errors.
