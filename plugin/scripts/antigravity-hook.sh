#!/bin/sh
# antigravity-hook.sh — the command Nomo's block in ~/.gemini/config/hooks.json runs, one per event:
#   '<root>/scripts/antigravity-hook.sh' <EventName>
# Antigravity requires every handler to print a JSON object and exit 0, and it waits for this script on
# EVERY model call. So this prints `{}` FIRST — no crash, missing runtime, unpaired machine, slow network
# or kill can leave it without its reply — then hands the payload to the bundle DETACHED (stdin saved to
# a private temp file, all output to /dev/null) and exits at once. Always exit 0.
#
# EXCEPT while the phone has something for Antigravity (one glob each, no parsing): a PostInvocation while
# a phone Stop is pending (`*.agy-interrupt`), and a PreInvocation or Stop while a phone reply is queued
# (`*.agy-inbox`). Then the bundle runs in the foreground and may answer — {"terminationBehavior":
# "terminate"}, {"injectSteps":[…]} or {"decision":"continue",…} respectively. Its output is printed only
# if it is EXACTLY that event's shape on one line; anything else (nothing, a crash, garbage) prints `{}`.
# The bundle is hard-capped at 4 s, inside the 10 s timeout. Only a foreground run (NOMO_AGY_SYNC=1) may
# consume a flag or a message; a detached run never does. Those runs also delete expired flags and
# day-old messages, so a stale one cannot keep this path slow.
d=$(dirname "$0")
dir=${NOMO_CC_DIR:-$HOME/.config/cc-status}/sessions
# Run the bundle in the foreground and print its reply only if it is EXACTLY one of the shapes this
# event may answer with ($1 = the event); anything else (nothing, a crash, garbage, two lines) → `{}`.
foreground() {
  out=$(NOMO_AGY_SYNC=1 NOMO_HOOK_PPID=$PPID "$d/run.sh" "$d/../dist/antigravity-status.mjs" "$1" 2>/dev/null)
  case "$1:$out" in
    *'
'*) out='{}' ;;
    'PostInvocation:{"terminationBehavior":"terminate"}') ;;
    'PreInvocation:{"injectSteps":[{"userMessage":"'*'"}]}') ;;
    'Stop:{"decision":"continue","reason":"'*'"}') ;;
    *) out='{}' ;;
  esac
  printf '%s\n' "$out"
  exit 0
}
# $PPID is the process that ran this hook (agy, or the desktop app's helper) — handed on before run.sh
# adds layers, so the bundle can record it as the session's owner.
if [ "$1" = PostInvocation ]; then
  for f in "$dir/"*.agy-interrupt; do [ -e "$f" ] && foreground "$1"; break; done
fi
# A phone reply waiting (any `*.agy-inbox` message, one glob): PreInvocation may inject it, Stop may
# continue the turn for it. Without one, these events stay on the fast path below.
if [ "$1" = PreInvocation ] || [ "$1" = Stop ]; then
  for f in "$dir/"*.agy-inbox; do [ -e "$f" ] && foreground "$1"; break; done
fi
printf '{}\n'
tmp=$(umask 077; mktemp "${TMPDIR:-/tmp}/nomo-agy-ev.XXXXXX" 2>/dev/null) || exit 0
cat >"$tmp" 2>/dev/null
(NOMO_HOOK_PPID=$PPID "$d/run.sh" "$d/../dist/antigravity-status.mjs" "$1" <"$tmp"; rm -f "$tmp") \
  </dev/null >/dev/null 2>&1 &
exit 0
