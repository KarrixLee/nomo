#!/bin/sh
# notify-chain.sh — Codex `notify`-channel fan-out for the Nomo plugin.
#
# LEGACY AS OF v1.7.9 — KEPT ONLY FOR CONFIGS ALREADY POINTING AT IT. New wirings name
# scripts/hook-shim.sh instead (`hook-shim.sh codex-notify [-- <orig…>]`, same argv contract minus the
# leading .mjs path), because THIS file lives inside the version-pinned plugin directory: the host
# deletes that directory on update, and Codex's `notify` setting is written into config.toml once at
# pairing and never rewritten — so a value naming this path broke permanently at the user's first
# plugin update. The fan-out below now lives in nomo_notify() in hook-shim.sh; the two must not drift
# while any un-repaired config.toml can still reach this file. Self-repair (core/notify-wire's
# repairNotifyWiring, run on Codex SessionStart) re-points those configs automatically.
#
# Codex runs the configured `notify` program with ONE JSON payload appended as the FINAL argument on
# turn completion (fire-and-forget). This wrapper (a) fires the Nomo backstop, codex-notify.mjs, with
# that payload — a "done" push for when the lifecycle hooks fail to fire (openai/codex#16430, #30835)
# — AND (b) forwards the same payload to any pre-existing notify program, so wrapping Nomo's notify
# never breaks an existing integration (e.g. the computer-use SkyComputerUseClient).
#
# argv contract (the nomo-pair skill bakes this into config.toml's `notify`; Codex appends <JSON>):
#   [notify-chain.sh, <codex-notify.mjs>, <JSON>]                                — Nomo only
#   [notify-chain.sh, <codex-notify.mjs>, --, <orig-prog>, <orig-args…>, <JSON>] — Nomo + chained original
# After the "--", the JSON payload sits in the exact final position Codex would have placed it for the
# original program, so the original is exec'd verbatim.
#
# Runtime resolution mirrors run.sh (bun then node); every failure is swallowed — a notify hook must
# never surface an error into the Codex session.

SELF="$1"; shift 2>/dev/null || exit 0

# The JSON payload is always the final positional arg (Codex appends exactly one).
PAYLOAD=""
for PAYLOAD in "$@"; do :; done

# (a) Nomo backstop — backgrounded so it never delays a chained notify program.
if command -v bun >/dev/null 2>&1; then
  (bun "$SELF" "$PAYLOAD" >/dev/null 2>&1 || true) &
elif command -v node >/dev/null 2>&1; then
  (node "$SELF" "$PAYLOAD" >/dev/null 2>&1 || true) &
fi

# (b) Chain any pre-existing notify program. After the "--", "$@" already ends with the JSON PAYLOAD
# in the position the original program expects, so exec it verbatim. Guard with command -v: if the
# original program isn't on PATH (uninstalled / bad config), exec would fail with 127 and Codex may
# surface the stderr — so skip it and exit 0 silently instead.
if [ "$1" = "--" ]; then
  shift
  if [ "$#" -gt 0 ] && command -v "$1" >/dev/null 2>&1; then
    exec "$@"
  fi
fi

exit 0
