#!/bin/sh
# Resolve a JS runtime: prefer bun, else node; hooks must stay silent on failure.
#
# WHY THE ABSOLUTE-PATH FALLBACKS (2026-08-05, field): a hook runs with whatever PATH the agent hands
# it, which is often thinner than an interactive shell's — a bun installed at ~/.bun/bin is routinely
# invisible, so every hook silently falls through to node. If that node is Homebrew's, a `brew upgrade`
# unlinks and relinks it, and any hook firing inside that window dies with 127 ("command not found").
# The competitor this project grew out of shipped exactly that outage by baking a resolved node path
# into its hook command; runtime resolution alone is necessary but not sufficient, because PATH lookup
# and the exec are two separate moments.
#
# So: try PATH first (respects whatever the user actually installed), then a small list of the places
# these runtimes really live. `exec` replaces this shell only on success — a candidate that vanished
# between the -x test and the exec falls through to the next one rather than taking the hook down.
#
# EXIT 0 ON NOTHING FOUND is deliberate and must not become an error: an unpaired or runtime-less
# machine has to leave the user's agent completely undisturbed. A hook that exits non-zero is surfaced
# to the user as a failure, which is exactly the noise this whole file exists to prevent.
if command -v bun >/dev/null 2>&1; then exec bun "$@"; fi
if command -v node >/dev/null 2>&1; then exec node "$@"; fi

for rt in \
  "$HOME/.bun/bin/bun" \
  "/opt/homebrew/bin/bun" \
  "/usr/local/bin/bun" \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node" \
  "/usr/bin/node"
do
  if [ -x "$rt" ]; then exec "$rt" "$@"; fi
done

# CACHED RESULT of the login-shell probe below. Checked before the probe, never before PATH or the
# fixed candidates — so installing bun later still takes effect immediately, and the cache can only
# ever short-circuit the SLOW path. A cached path that no longer exists (node upgraded, version
# switched) simply fails the -x test and falls through to a fresh probe that rewrites it.
cache="${XDG_CONFIG_HOME:-$HOME/.config}/cc-status/runtime"
if [ -r "$cache" ]; then
  rt=$(cat "$cache" 2>/dev/null)
  if [ -n "$rt" ] && [ -x "$rt" ]; then exec "$rt" "$@"; fi
fi

# LAST RESORT: a login shell. Version managers (nvm, fnm, volta, asdf) install node under a
# per-version directory no fixed list can enumerate, and they publish it by editing the user's shell
# rc — so the only portable way to find that node is to ask the shell that has it. It costs a shell
# spawn (~100ms), and a hook fires on every tool use, so the result is CACHED above: a version-manager
# user pays this once per machine, not once per hook. `-i` matters — nvm/fnm are commonly set up in
# .zshrc, which a non-interactive login shell does not read.
if [ -n "$SHELL" ] && [ -x "$SHELL" ]; then
  rt=$("$SHELL" -ilc 'command -v bun || command -v node' 2>/dev/null | head -n 1)
  if [ -n "$rt" ] && [ -x "$rt" ]; then
    # Best-effort cache write; a read-only or missing dir must never break the hook.
    (mkdir -p "$(dirname "$cache")" 2>/dev/null && printf '%s\n' "$rt" >"$cache" 2>/dev/null) || true
    exec "$rt" "$@"
  fi
fi

exit 0
