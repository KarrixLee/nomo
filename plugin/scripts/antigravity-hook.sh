#!/bin/sh
# antigravity-hook.sh — the command Nomo's block in ~/.gemini/config/hooks.json runs, one per event:
#   '<root>/scripts/antigravity-hook.sh' <EventName>
# Antigravity requires every handler to print a JSON object and exit 0, and it waits for this script on
# EVERY model call. So this prints `{}` FIRST — no crash, missing runtime, unpaired machine, slow network
# or kill can leave it without its reply — then hands the payload to the bundle DETACHED (stdin saved to
# a private temp file, all output to /dev/null) and exits at once. Always exit 0.
#
# EXCEPT a PostInvocation while a phone Stop is pending (any `*.interrupt` flag in the sessions dir — one
# glob, no parsing): then the bundle runs in the foreground and may answer
# {"terminationBehavior":"terminate"}. Its output is printed only if it is EXACTLY that line; anything
# else (nothing, a crash, garbage) prints `{}`. The bundle is hard-capped at 4 s, inside the 10 s timeout.
# Only that foreground run (NOMO_AGY_SYNC=1) may consume the flag; a detached run never does.
d=$(dirname "$0")
# $PPID is the process that ran this hook (agy, or the desktop app's helper) — handed on before run.sh
# adds layers, so the bundle can record it as the session's owner.
if [ "$1" = PostInvocation ]; then
  for f in "$HOME/.config/cc-status/sessions/"*.interrupt; do
    [ -e "$f" ] || break
    out=$(NOMO_AGY_SYNC=1 NOMO_HOOK_PPID=$PPID "$d/run.sh" "$d/../dist/antigravity-status.mjs" "$1" 2>/dev/null)
    case "$out" in
      '{"terminationBehavior":"terminate"}') printf '%s\n' "$out" ;;
      *) printf '{}\n' ;;
    esac
    exit 0
  done
fi
printf '{}\n'
tmp=$(umask 077; mktemp "${TMPDIR:-/tmp}/nomo-agy-ev.XXXXXX" 2>/dev/null) || exit 0
cat >"$tmp" 2>/dev/null
(NOMO_HOOK_PPID=$PPID "$d/run.sh" "$d/../dist/antigravity-status.mjs" "$1" <"$tmp"; rm -f "$tmp") \
  </dev/null >/dev/null 2>&1 &
exit 0
