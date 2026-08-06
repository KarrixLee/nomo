---
name: nomo-approvals
description: Pause or resume Nomo remote approvals on this computer — control whether Codex permission prompts are held for your phone to Allow or Deny. Use when the user asks to pause/resume remote approvals, stop sending permission prompts to their phone, answer prompts in the terminal instead, or when their phone is unreachable and Codex approvals seem stuck.
---

Remote approvals let you answer a Codex permission prompt (run a shell command, apply a patch, …) from
the Nomo iPhone app when that session is on your phone's Live Activity — the terminal approval waits
while you tap **Allow** or **Deny**. This skill is the LOCAL switch for it on this computer, useful when
your phone is unreachable and you just want prompts to appear in the terminal as usual.

**One switch per computer.** The pause flag is SHARED across agents: toggling it here affects **both**
Codex **and** Claude Code sessions on this machine (they read the same local `no-hold` flag). It does
**not** change your phone's settings and does not unpair anything.

## Step 1 — resolve the plugin path

Skills get no `PLUGIN_ROOT`, so find it first. Run this exact command:

```
codex plugin list
```

It is a local, read-only command — no approval needed. In its output, find the row whose **PLUGIN**
column starts with `nomo@` and take that row's **PATH** column value as `<ROOT>`.

If no `nomo@…` row exists, the plugin isn't installed — tell the user to add the Nomo marketplace and
install the `nomo` plugin, then stop.

## Step 2 — read the text after `$nomo-approvals`

Trim whitespace, lowercase it, and pick the matching sub-command. Anything empty or unrecognized →
treat as `status`.

- `off` → pause remote approvals here (prompts appear in the terminal; your phone is not asked).
- `on` → resume remote approvals here.
- `status` (or no argument) → report the current state.

## Step 3 — run it

Run this exact command with your chosen sub-command and relay its single output line to the user:

```
NOMOR="<ROOT>"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/codex-permission.mjs" <on|off|status>; [ -x "$NOMOS" ] && exec "$NOMOS" codex-permission <on|off|status>; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

This is a local, read-only toggle — no network, no approval needed. It **always exits 0** — "OFF" is
information, not an error.

Notes to relay:

- This is a per-computer local switch shared by Codex **and** Claude Code — it does not change your
  phone's settings and does not unpair anything (pairing and the app's "Remote approvals" toggle are
  unaffected).
- `off` is the escape hatch for a dead or unreachable phone: with it set, permission prompts never wait
  on the phone and always fall back to the terminal approval immediately.

## Note — re-trust after upgrading to this version

The Nomo update that added phone-held Codex approvals **re-points** the `permission_request` hook to a
new program, which **changes its trusted hash**. Codex will therefore re-prompt for trust on that one
entry the first time after upgrading. Tell the user: run `/hooks` in Codex once and **re-trust the Nomo
`permission_request` entry** — until then Codex falls back to the normal terminal approval (fail-open;
nothing breaks, but prompts won't reach the phone). This is a one-time re-trust; the other five Nomo
hooks are unchanged and are not re-prompted.
