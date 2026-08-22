---
description: Update the Nomo plugin for OpenCode — check for a newer version, pull it, and reinstall the commands
---

Run this exact command and show its output verbatim to the user:

```
NOMOR="__NOMO_ROOT__"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/opencode-update.mjs"; [ -x "$NOMOS" ] && exec "$NOMOS" opencode-update; echo "Nomo could not find its installed files - re-run plugin/scripts/opencode-install.sh."; exit 1
```

OpenCode has no marketplace and no `plugin update`, so the checkout Nomo was installed from **is** its
version. This command does that update for the user: it checks the remote first, and only pulls if
there is something to pull.

- **Already current** → it says so (`Already on 2.1.21 — nothing to do.`) and changes nothing. That is
  a normal, successful outcome, not an error. Do not suggest a restart — nothing moved.
- **An update exists** → it prints the version delta (`Update available: 2.1.21 → 2.1.23.`) before
  pulling, fast-forwards the checkout, and re-runs the installer so any new `/nomo-*` command appears
  and the plugin stub is refreshed.
- **Then tell the user to restart OpenCode.** Plugins are imported once at server start and there is
  no hot reload, so the running server keeps using the old copy until they quit and reopen it.

If it refuses, relay the message and the `→` fix line exactly — every refusal names the command to run
by hand. It refuses rather than guessing when the checkout is pinned to a branch or tag (a detached
HEAD from `bunx nomo-ai --ref`), has uncommitted changes, tracks no upstream, has diverged, is
unreachable over the network, or has been moved or deleted out from under the stub.

This only ever touches OpenCode's own checkout. Claude Code and Codex install Nomo through their own
marketplaces and update with their own commands — this command never writes into `~/.claude` or
`~/.codex`.
