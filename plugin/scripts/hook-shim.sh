#!/bin/sh
# hook-shim.sh — a version-STABLE address for this plugin's hooks.
#
# THE OUTAGE THIS EXISTS FOR (2026-08-06, field). Both hosts cache an installed plugin in a
# VERSION-PINNED directory — ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/ and the same
# shape under ~/.claude — and Codex DELETES the previous version's directory on update. The hook
# commands in our manifests address the plugin through $PLUGIN_ROOT / $CLAUDE_PLUGIN_ROOT, which the
# host resolves ONCE per process. Codex's hooks are spawned by the long-lived `codex app-server`
# daemon (proven on this machine: our own breadcrumbs record origin.ppid = the daemon's pid, uptime
# 24h+), so that daemon keeps handing out the root it resolved at startup. After ANY version bump the
# directory it names is gone, every hook exec dies with 127 — including hooks for BRAND NEW sessions —
# and nothing recovers until the user restarts the daemon, which nobody knows to do. Eight-day silent
# outages start exactly like this.
#
# So the manifests now say, in effect: "use the live PLUGIN_ROOT if it is still there, otherwise ask
# this shim". The shim lives OUTSIDE any version directory (in the plugin's own state dir, next to
# config.json and the runtime cache — see CC_DIR in src/core/shared.ts), so its path never changes and
# a stale daemon's baked-in command line still lands somewhere real.
#
# COST DISCIPLINE. This file runs ONLY when the host's own root is already broken; the happy path in
# the manifest execs run.sh directly and never touches it. Even so it stays fork-free: every step is a
# shell builtin or a test, the directory scan is a glob (no find/ls/sort/sed subprocesses), and it does
# no work at all before rejecting an unknown entry name.
#
# FAIL-OPEN, ALWAYS. Every unresolvable case exits 0 in silence, for the same reason run.sh does: a
# hook that exits non-zero or writes to stderr is surfaced to the user as a failure in their agent
# turn, and a plugin whose job is a phone notification must never do that.
#
# THREE CALLERS, one address. (1) hook manifests, as the fallback when the host's own root is gone.
# (2) The slash commands and Codex skills, same shape. (3) Codex's `notify` setting in config.toml,
# which has NO fallback at all — config.toml is written once at pairing and never revisited, so a
# version-pinned path there breaks permanently rather than until a restart. That third caller is why
# the shim also carries the notify FAN-OUT (see nomo_notify below).
#
# Installed and kept current by run.sh (see the NOMO_SHIM_REV block there). Editing this file requires
# bumping NOMO_SHIM_REV in run.sh, or already-installed copies will never be refreshed.

# ENTRY WHITELIST. The name arrives from our own manifest, but it is still an attacker-shaped input if
# anything else ever invokes this script, and it is interpolated into a path — so it is matched against
# a fixed set of literals rather than sanitized. No slash, no "..", no glob character can survive an
# exact-literal `case`, which is why this is a whitelist and not a character filter. An unknown name is
# not an error: exit 0 and leave the session alone.
case "$1" in
  cc-status|cc-permission|cc-watchdog|codex-status|codex-permission|codex-notify|pair|unpair|reset|status-cmd|opencode-update)
    NOMO_ENTRY=$1 ;;
  *) exit 0 ;;
esac
# Everything after the entry name is FORWARDED to the bundle verbatim ("$@" from here on): the slash
# commands pass sub-commands (`wait`, `--show-code`, `on|off|status`) and Codex appends the notify
# payload. Nothing here inspects those — they are our own bundles' argv, at the same trust level as
# the entry name itself.
shift

# Everything below is addressed relative to HOME. Without it there is nothing to resolve.
[ -n "$HOME" ] || exit 0

# THE NOTIFY FAN-OUT, transplanted from the old scripts/notify-chain.sh (which lived inside the
# version-pinned root and so had the exact bug this file exists to fix). Codex runs the `notify`
# program with ONE JSON payload appended as the FINAL argument, fire-and-forget. argv contract:
#   hook-shim.sh codex-notify <JSON>                            — nomo only
#   hook-shim.sh codex-notify -- <orig-prog> <orig-args…> <JSON> — nomo + the pre-existing notify
# After the "--" the payload already sits in the exact position the original program expects, so it is
# exec'd verbatim. This is reached ONLY for the codex-notify entry, so no hook pays for it.
nomo_notify() {
  _run=$1; _mjs=$2; shift 2
  # The payload is whatever ended up last; the loop is a builtin, so this stays fork-free.
  _payload=""
  for _payload in "$@"; do :; done
  # (a) The nomo backstop, backgrounded so a chained notify program is never delayed behind it.
  ( "$_run" "$_mjs" "$_payload" >/dev/null 2>&1 || true ) &
  # (b) The pre-existing notify program, if we are wrapping one. `command -v` first: exec'ing an
  # uninstalled program would die 127 and Codex may surface that stderr.
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ] && command -v "$1" >/dev/null 2>&1; then exec "$@"; fi
  fi
  exit 0
}

# Hand off to a candidate root, or return non-zero so the caller keeps looking. Both tests matter: a
# root can survive with its scripts/ intact but WITHOUT the entry we were asked for (an older version
# predating that entry), and exec'ing run.sh on a missing bundle would surface the runtime's own error.
nomo_launch() {
  _root=$1; shift
  [ -x "$_root/scripts/run.sh" ] || return 1
  [ -f "$_root/dist/$NOMO_ENTRY.mjs" ] || return 1
  # nomo_notify never returns (it execs the chained program or exits 0).
  [ "$NOMO_ENTRY" = codex-notify ] && nomo_notify "$_root/scripts/run.sh" "$_root/dist/$NOMO_ENTRY.mjs" "$@"
  exec "$_root/scripts/run.sh" "$_root/dist/$NOMO_ENTRY.mjs" "$@"
}

# (a) FAST PATH — the root run.sh last recorded. One open, one builtin read, two tests. This is the
# answer in every real post-bump invocation, because the hook that ran before the bump wrote it.
NOMO_STAMP="$HOME/.config/cc-status/hook-shim.stamp"
if [ -r "$NOMO_STAMP" ]; then
  # Fields: "<shim-rev> <plugin-root>". The root is last so a path containing spaces survives IFS.
  read -r nomo_rev nomo_root <"$NOMO_STAMP" 2>/dev/null
  if [ -n "$nomo_root" ]; then nomo_launch "$nomo_root" "$@"; fi
fi

# Numeric semver compare: true when $1 sorts strictly AFTER $2. Written out longhand because the
# obvious `sort -V`/`sort -r` pipeline is two forks, and a lexical compare gets 1.7.10 vs 1.7.9
# backwards — which is the single most likely bump to hit this code path. A prerelease is ordered
# BELOW the release it precedes (1.8.0-rc1 < 1.8.0), matching semver.
nomo_newer() {
  _a=${1%%[-+]*}; _b=${2%%[-+]*}
  for _i in 1 2 3; do
    _x=${_a%%.*}; _y=${_b%%.*}
    case "$_x" in ''|*[!0-9]*) _x=0 ;; esac
    case "$_y" in ''|*[!0-9]*) _y=0 ;; esac
    [ "$_x" -gt "$_y" ] && return 0
    [ "$_x" -lt "$_y" ] && return 1
    case "$_a" in *.*) _a=${_a#*.} ;; *) _a=0 ;; esac
    case "$_b" in *.*) _b=${_b#*.} ;; *) _b=0 ;; esac
  done
  # Equal numerically: a plain version outranks a prerelease of the same numbers.
  case "$1" in *-*) return 1 ;; esac
  case "$2" in *-*) return 0 ;; esac
  return 1
}

# (b) SCAN — no usable record, so find the newest nomo actually on disk.
#
# The MARKETPLACE directory name is whatever the user called the marketplace when they added it (ours
# is "nomo" here, but a fork or a second install can be anything), so it is globbed, never assumed. The
# PLUGIN directory name is NOT user-chosen — the host derives it from the marketplace manifest's plugin
# name — so "nomo" (the Codex plugin) and "nomo-cc" (the Claude plugin) are the two exact literals our
# own manifests can produce, and matching them is a real identity check rather than a guess. It is also
# a pure string test, which is what keeps this loop from stat()-ing every unrelated plugin on the box.
# The dist/<entry>.mjs test below then confirms it is genuinely ours and genuinely complete.
#
# The trailing slash in each glob restricts the match to directories, and an unmatched glob is left
# literal by POSIX sh, so a missing tree shows up as a path still containing "*" and is skipped.
nomo_best=
nomo_bestv=
for nomo_d in \
  "$HOME"/.codex/plugins/cache/*/*/*/ \
  "$HOME"/.claude/plugins/cache/*/*/*/
do
  case "$nomo_d" in *'*'*) continue ;; esac
  nomo_r=${nomo_d%/}
  nomo_p=${nomo_r%/*}; nomo_p=${nomo_p##*/}
  case "$nomo_p" in nomo|nomo-cc) ;; *) continue ;; esac
  # Codex marks a superseded version directory instead of always removing it immediately; launching one
  # would resurrect the very version the user just replaced. (Same marker claude-mem's bootstrap skips.)
  [ -e "$nomo_r/.orphaned_at" ] && continue
  [ -x "$nomo_r/scripts/run.sh" ] || continue
  [ -d "$nomo_r/dist" ] || continue
  [ -f "$nomo_r/dist/$NOMO_ENTRY.mjs" ] || continue
  nomo_v=${nomo_r##*/}
  if [ -z "$nomo_best" ] || nomo_newer "$nomo_v" "$nomo_bestv"; then
    nomo_best=$nomo_r
    nomo_bestv=$nomo_v
  fi
done
if [ -n "$nomo_best" ]; then nomo_launch "$nomo_best" "$@"; fi

# (c) LAST RESORT — a marketplace installed straight from git keeps an unversioned working copy here.
# It has no version to rank, so it is only consulted when the versioned caches produced nothing.
for nomo_d in "$HOME"/.claude/plugins/marketplaces/*/plugin/ "$HOME"/.codex/plugins/marketplaces/*/plugin/; do
  case "$nomo_d" in *'*'*) continue ;; esac
  nomo_launch "${nomo_d%/}" "$@"
done

# Nothing anywhere. Silence is the contract.
exit 0
