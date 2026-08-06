#!/bin/sh
# Resolve a JS runtime: prefer bun, else node; hooks must stay silent on failure. Also keeps the
# version-stable hook shim installed (see the HOOK-SHIM UPKEEP block below).
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

# ATOMIC + OWNER-ONLY, matching every other file this plugin writes (config.json, the session records,
# the trace log are all 0600). A plain `> "$dest"` landed 0644 under the default umask and was readable
# half-written by a concurrent hook; temp-then-rename makes the swap all-or-nothing, and the chmod
# happens while the file is still under its private name. Entirely best-effort: a read-only or missing
# directory must never break the hook, so both helpers always return 0.
#
# Two variants because the callers differ in what they can afford. nomo_atomic_write takes a string and
# is fork-free (`printf` is a builtin) — it runs on the runtime-cache path. nomo_atomic_copy shells out
# to cp and is only ever reached on the rare shim-install path.
nomo_atomic_write() {
  _tmp="$1.$$"
  (
    mkdir -p "${1%/*}" 2>/dev/null &&
    printf '%s\n' "$3" >"$_tmp" 2>/dev/null &&
    chmod "$2" "$_tmp" 2>/dev/null &&
    mv -f "$_tmp" "$1" 2>/dev/null
  ) || rm -f "$_tmp" 2>/dev/null
  return 0
}

nomo_atomic_copy() {
  _tmp="$1.$$"
  (
    mkdir -p "${1%/*}" 2>/dev/null &&
    cp "$3" "$_tmp" 2>/dev/null &&
    chmod "$2" "$_tmp" 2>/dev/null &&
    mv -f "$_tmp" "$1" 2>/dev/null
  ) || rm -f "$_tmp" 2>/dev/null
  return 0
}

# ── HOOK-SHIM UPKEEP ─────────────────────────────────────────────────────────────────────────────
#
# WHY (2026-08-06, field): both hosts install a plugin into a VERSION-PINNED cache directory, and Codex
# deletes the previous one on update. The Codex `app-server` daemon that spawns every Codex hook
# resolves $PLUGIN_ROOT once and keeps it for its whole (multi-day) life, so after ANY version bump the
# path baked into its hook command lines is gone and every hook — including new sessions' — dies with
# 127, silently, until the user restarts a daemon they don't know exists. The manifests therefore fall
# back to a shim at a path that never changes; this block is what puts it there and keeps it current.
#
# SELF-BOOTSTRAPPING: on a fresh install $PLUGIN_ROOT is still valid, the hook runs run.sh directly,
# and run.sh installs the shim that the NEXT bump will need. Nothing asks the user to do anything.
#
# NOT ON EVERY HOOK. The check is a stamp read (one open, one builtin read) plus two stats and three
# string compares — no forks, nothing written. The runtime probe already taught this file that a
# per-invocation write is an SSD tax and a concurrent-hook race; the install runs only when something
# genuinely changed.
#
# BUMP NOMO_SHIM_REV whenever scripts/hook-shim.sh changes, or installed copies will never refresh.
# rev 2 (v1.7.9): the shim forwards extra argv to the bundle and carries the Codex `notify` fan-out,
# so config.toml's notify can name it instead of a version-pinned notify-chain.sh. A rev-1 shim still
# launches every hook correctly; it just drops the notify payload, and this block replaces it on the
# first hook after the upgrade — which is BEFORE the SessionStart self-repair rewrites config.toml,
# because that repair runs inside a bundle this file exec's.
NOMO_SHIM_REV=2

# Numeric semver compare: true when $1 sorts strictly AFTER $2. A DELIBERATE TWIN of the function in
# hook-shim.sh — run.sh has to stay a standalone file that works when nothing else on disk does, so it
# cannot source a shared helper. Lexical comparison is not an option: it orders 1.7.10 below 1.7.9,
# which is precisely the bump most likely to exercise this code.
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
  case "$1" in *-*) return 1 ;; esac
  case "$2" in *-*) return 0 ;; esac
  return 1
}

# $0 is the only trustworthy statement of which plugin copy is actually executing: $PLUGIN_ROOT may be
# a lie (that is the whole bug) and the shim may have exec'd us from somewhere else entirely. An
# invocation that does not look like "<root>/scripts/run.sh", or whose root is relative, is left alone
# — recording a relative path would produce a stamp that resolves to nothing from a hook's cwd.
nomo_root=${0%/scripts/run.sh}
case "$nomo_root" in
  "$0") nomo_root= ;;  # $0 did not end in /scripts/run.sh at all
  /*) ;;               # absolute root — usable
  *) nomo_root= ;;     # relative invocation
esac

if [ -n "$HOME" ] && [ -n "$nomo_root" ]; then
  nomo_shim="$HOME/.config/cc-status/hook-shim.sh"
  nomo_stamp="$HOME/.config/cc-status/hook-shim.stamp"
  nomo_rev=
  nomo_recorded=
  # Fields: "<shim-rev> <plugin-root>"; the root is last so a path with spaces survives IFS splitting.
  [ -r "$nomo_stamp" ] && read -r nomo_rev nomo_recorded <"$nomo_stamp" 2>/dev/null

  nomo_want_install=0
  if [ ! -x "$nomo_shim" ]; then
    # Missing or never installed. Install ours even if the stamp claims a newer rev once lived here —
    # a working older shim beats no shim, and that newer version's run.sh will re-upgrade it.
    nomo_want_install=1
  elif [ "$nomo_rev" != "$NOMO_SHIM_REV" ]; then
    # Only ever move the rev FORWARD. Two versions of this plugin can be installed at once (Claude's
    # cache keeps every version it has ever seen), and letting the older one rewrite the newer one's
    # shim would make the two fight over the file on every single hook.
    case "$nomo_rev" in
      ''|*[!0-9]*) nomo_want_install=1 ;;
      *) [ "$NOMO_SHIM_REV" -gt "$nomo_rev" ] && nomo_want_install=1 ;;
    esac
  elif [ "$nomo_recorded" != "$nomo_root" ]; then
    # Someone else's root is recorded. Take it over only if theirs is gone, or ours is genuinely newer
    # (STRICTLY newer — on a tie the incumbent keeps it, which is what stops a Claude hook and a Codex
    # hook of the same version from rewriting the stamp back and forth forever).
    if [ ! -x "$nomo_recorded/scripts/run.sh" ]; then
      nomo_want_install=1
    elif nomo_newer "${nomo_root##*/}" "${nomo_recorded##*/}"; then
      nomo_want_install=1
    fi
  fi

  if [ "$nomo_want_install" = 1 ] && [ -f "$nomo_root/scripts/hook-shim.sh" ]; then
    # 0700 on the directory too: it holds config.json, i.e. the pairing key this plugin's whole
    # end-to-end encryption story rests on, and it has no business being world-readable.
    mkdir -p "${nomo_shim%/*}" 2>/dev/null && chmod 700 "${nomo_shim%/*}" 2>/dev/null
    # Shim first, stamp second. A crash in between leaves a stale stamp, which merely re-runs this
    # block on the next hook; the reverse order would advertise a shim that is not there yet.
    nomo_atomic_copy "$nomo_shim" 700 "$nomo_root/scripts/hook-shim.sh"
    nomo_atomic_write "$nomo_stamp" 600 "$NOMO_SHIM_REV $nomo_root"
  fi
fi

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

# Owner-only and atomic, via the shared helper defined at the top of this file (see the comment there
# for why a plain redirect was not good enough).
write_cache() { nomo_atomic_write "$cache" 600 "$1"; }

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
