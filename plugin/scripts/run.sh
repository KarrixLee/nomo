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
# these runtimes really live.
#
# THE TOCTOU WINDOW IS REAL AND ACCEPTED. An earlier version of this comment claimed a candidate that
# vanished between the `-x` test and the `exec` "falls through to the next one" — it does NOT. In POSIX
# sh a failed `exec` terminates a NON-interactive shell (verified: exit 126), so the loop below never
# resumes and the hook dies with that status. Closing it properly would mean probing each candidate in
# a subshell before committing, i.e. an extra fork on the hot path that every hook pays forever, to
# cover a window measured in microseconds that only opens mid-`brew upgrade`. The fixed candidates are
# tested immediately before use, the window is not worth a permanent per-invocation cost, and a hook
# that loses that race dies once and is retried by the session's next event.
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
#
# The location deliberately MIRRORS CC_DIR in src/core/shared.ts ("$HOME/.config/cc-status", with no
# XDG_CONFIG_HOME branch) so every piece of this plugin's state lives in exactly one tree.
cache="$HOME/.config/cc-status/runtime"
NEGATIVE_CACHE_TTL=3600

# Atomic + owner-only, matching every other file this plugin writes (config.json, the session records,
# the trace log are all 0600). A plain `> "$cache"` landed 0644 under the default umask and was
# readable half-written by a concurrent hook; temp-then-rename makes the swap all-or-nothing, and the
# chmod happens while the file is still under its private name. Entirely best-effort: a read-only or
# missing directory must never break the hook.
write_cache() {
  tmp="$cache.$$"
  (
    mkdir -p "${cache%/*}" 2>/dev/null &&
    printf '%s\n' "$1" >"$tmp" 2>/dev/null &&
    chmod 600 "$tmp" 2>/dev/null &&
    mv -f "$tmp" "$cache" 2>/dev/null
  ) || rm -f "$tmp" 2>/dev/null
  return 0
}

if [ -r "$cache" ]; then
  rt=$(cat "$cache" 2>/dev/null)
  case "$rt" in
    # NEGATIVE CACHE. A machine with genuinely no runtime anywhere used to re-run the full login-shell
    # probe (~100ms+) on EVERY hook — several times per assistant turn, forever, to re-learn the same
    # nothing. The sentinel remembers that for an hour: still self-healing (a bun installed later is
    # picked up by the PATH/candidate checks above immediately, and the probe re-runs once the hour is
    # up), but no longer a per-hook tax. A malformed or future-dated stamp re-probes.
    NONE:*)
      probed=${rt#NONE:}
      case "$probed" in
        ""|*[!0-9]*) ;;
        *)
          now=$(date +%s 2>/dev/null)
          case "$now" in
            ""|*[!0-9]*) ;;
            *)
              if [ "$now" -ge "$probed" ] && [ $((now - probed)) -lt "$NEGATIVE_CACHE_TTL" ]; then
                exit 0
              fi
              ;;
          esac
          ;;
      esac
      ;;
    *)
      if [ -n "$rt" ] && [ -x "$rt" ]; then exec "$rt" "$@"; fi
      ;;
  esac
fi

# LAST RESORT: a login shell. Version managers (nvm, fnm, volta, asdf) install node under a
# per-version directory no fixed list can enumerate, and they publish it by editing the user's shell
# rc — so the only portable way to find that node is to ask the shell that has it. It costs a shell
# spawn (~100ms), and a hook fires on every tool use, so the result is CACHED above: a version-manager
# user pays this once per machine, not once per hook. `-i` matters — nvm/fnm are commonly set up in
# .zshrc, which a non-interactive login shell does not read.
#
# THE ANSWER IS FRAMED, not positional. `-i` makes the rc files behave as they do for a human, which
# means MOTDs, neofetch, fnm/nvm version notices and "a new release is available" banners — all on
# stdout, all BEFORE our answer. Taking `head -n 1` handed those banners back as a runtime path, which
# broke exactly the version-manager users this block exists for. The shell prints NOMORT:<path> and we
# pick that line out; `tail -n 1` keeps the last one if an rc somehow echoes the marker too.
#
# BOUNDED, AND BOUNDED AT THE PROCESS GROUP. An rc that blocks (a `read`, a prompt theme waiting on a
# slow git/network call, a stale mount) previously hung the shell — and therefore the hook, and
# therefore the user's agent — with no ceiling at all. macOS ships no timeout(1), so perl carries the
# deadline. It is NOT the one-line `alarm 5; exec` trick: alarm does survive exec, but killing only the
# shell leaves its CHILDREN holding the write end of our pipe, so the command substitution keeps
# waiting for EOF and the hook hangs anyway (measured: a `sleep 60` rc still cost the full 60s). So the
# child is put in its OWN process group and the whole group is killed on the alarm, which is the part
# that actually ends the hang. `</dev/null` is the other half: it gives a reading rc immediate EOF
# instead of a hang, and — just as important — stops any rc from consuming the HOOK EVENT JSON on our
# stdin, which we hand to the runtime we exec. Without perl (not on the box at all) the probe still
# runs, just unbounded — a missing timeout must not mean a missing runtime.
if [ -n "$SHELL" ] && [ -x "$SHELL" ]; then
  nomo_probe='p=$(command -v bun || command -v node) && printf "NOMORT:%s\n" "$p"'
  if command -v perl >/dev/null 2>&1; then
    rt=$(perl -e 'my $p = fork(); exit(1) unless defined $p; unless ($p) { setpgrp(0, 0); exec @ARGV; exit(127); } $SIG{ALRM} = sub { kill("KILL", -$p); exit(0) }; alarm(5); waitpid($p, 0); exit(0);' \
      -- "$SHELL" -ilc "$nomo_probe" </dev/null 2>/dev/null \
      | sed -n 's/^NOMORT://p' | tail -n 1)
  else
    rt=$("$SHELL" -ilc "$nomo_probe" </dev/null 2>/dev/null | sed -n 's/^NOMORT://p' | tail -n 1)
  fi
  if [ -n "$rt" ] && [ -x "$rt" ]; then
    write_cache "$rt"
    exec "$rt" "$@"
  fi
fi

# Nothing, anywhere. Remember that (see the negative-cache note above) and leave the agent alone.
now=$(date +%s 2>/dev/null)
case "$now" in
  ""|*[!0-9]*) ;;
  *) write_cache "NONE:$now" ;;
esac
exit 0
