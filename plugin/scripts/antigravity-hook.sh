#!/bin/sh
# antigravity-hook.sh — the command Nomo's block in ~/.gemini/config/hooks.json runs, one per event:
#   '<root>/scripts/antigravity-hook.sh' <EventName>
# Antigravity requires every handler to print a JSON object and exit 0. This prints `{}` FIRST — so no
# crash, missing runtime, unpaired machine, slow network or kill can ever leave it without its reply —
# then hands stdin to the bundle, whose output is discarded. Always exit 0.
#
# EXCEPT PostInvocation, the phone-Stop seam: there the bundle may answer
# {"terminationBehavior":"terminate"} (it consumed a phone interrupt flag). Its output is captured and
# printed only if it is EXACTLY that line; anything else (nothing, a crash, garbage) prints `{}`.
# Antigravity already waited for this script's exit, so capturing adds no latency; the bundle is
# hard-capped at 4 s, well inside the registered 10 s timeout.
d=$(dirname "$0")
# $PPID is the process that ran this hook (agy, or the desktop app's helper) — handed on before run.sh
# adds layers, so the bundle can record it as the session's owner.
if [ "$1" = PostInvocation ]; then
  out=$(NOMO_HOOK_PPID=$PPID "$d/run.sh" "$d/../dist/antigravity-status.mjs" "$1" 2>/dev/null)
  case "$out" in
    '{"terminationBehavior":"terminate"}') printf '%s\n' "$out" ;;
    *) printf '{}\n' ;;
  esac
  exit 0
fi
printf '{}\n'
NOMO_HOOK_PPID=$PPID "$d/run.sh" "$d/../dist/antigravity-status.mjs" "$1" >/dev/null 2>&1
exit 0
