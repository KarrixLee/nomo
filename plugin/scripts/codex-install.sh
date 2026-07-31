#!/bin/bash
# Refresh the Codex-side nomo install WITHOUT breaking open sessions.
#
# `codex plugin add` replaces the versioned cache snapshot and DELETES the
# previous version's directory — but hooks in already-open Codex sessions
# resolved ${PLUGIN_ROOT} to that old path at session start, so every hook
# in them exits 127 ("command not found") until the session restarts.
#
# Fix: remember which version dirs existed before the add, and re-create any
# that vanished as symlinks to the new snapshot. Hooks are stateless per
# event and forward-compatible, and since v1.4.9 a stale watchdog
# self-terminates on pidfile ownership/version mismatch — so old sessions
# executing the new bundles is safe.
#
# Usage: plugin/scripts/codex-install.sh   (run after bumping the version)
set -euo pipefail

CACHE="$HOME/.codex/plugins/cache/nomo/nomo"

before=()
if [ -d "$CACHE" ]; then
  while IFS= read -r d; do before+=("$d"); done < <(ls "$CACHE")
fi

codex plugin add nomo@nomo

# Newest real directory (the freshly-installed snapshot) — symlinks excluded.
latest=$(find "$CACHE" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort -V | tail -1)
if [ -z "$latest" ]; then
  echo "codex-install: no snapshot dir found after add — aborting backfill" >&2
  exit 1
fi

for v in "${before[@]:-}"; do
  [ -z "$v" ] && continue
  [ "$v" = "$latest" ] && continue
  # A prior backfill symlink survives the add but now DANGLES (its target dir
  # was deleted) — `-e` follows links, so a dangling link reads as missing yet
  # `ln` collides on it. Remove any symlink first, then (re)point at the new
  # snapshot. Never touch real directories.
  if [ -L "$CACHE/$v" ]; then
    rm "$CACHE/$v"
  fi
  if [ ! -e "$CACHE/$v" ]; then
    ln -s "$latest" "$CACHE/$v"
    echo "codex-install: backfilled $v -> $latest (open sessions keep working)"
  fi
done

echo "codex-install: installed $latest"
