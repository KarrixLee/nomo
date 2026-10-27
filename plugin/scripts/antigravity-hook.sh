#!/bin/sh
# antigravity-hook.sh — the command Nomo's block in ~/.gemini/config/hooks.json runs, one per event:
#   '<root>/scripts/antigravity-hook.sh' <EventName>
# Antigravity requires every handler to print a JSON object and exit 0, and it waits for this script on
# EVERY model call. So this saves the payload and prints `{}` before any real work — no crash, missing
# runtime, unpaired machine, slow network or kill can leave it without its reply — then hands the payload
# to the bundle DETACHED (from a private temp file, all output to /dev/null) and exits at once. Always
# exit 0.
#
# EXCEPT while the phone has something for Antigravity: a PostInvocation while a phone Stop is pending
# (`*.agy-interrupt`, one glob), and a PreInvocation or Stop while a phone reply is queued for THIS
# conversation (a `<conv>.<mid>.agy-inbox` whose <conv> appears as a quoted string in the payload — one
# fixed-string grep per queued file; a false match only costs a sync run, a foreign inbox costs nothing).
# Then the bundle runs with NOMO_AGY_SYNC=1 and may answer — {"terminationBehavior":"terminate"},
# {"injectSteps":[…]} or {"decision":"continue",…} respectively — or print an empty line once it knows it
# will not. This reads ONE line from it through a private FIFO and returns at once; the bundle finishes
# its bookkeeping and POST in the background. The line is printed only if it is EXACTLY that event's
# shape; anything else (empty, a crash, garbage) prints `{}`. The bundle is hard-capped at 4 s, inside
# the 10 s timeout. Only a sync run may consume a flag or a message; a detached run never does. Those
# runs also delete expired flags and day-old messages.
d=$(dirname "$0")
dir=${NOMO_CC_DIR:-$HOME/.config/cc-status}/sessions
# $PPID is the process that ran this hook (agy, or the desktop app's helper) — handed on before run.sh
# adds layers, so the bundle can record it as the session's owner. The payload is saved to a private
# temp file first (the sync check reads it; the bundle, sync or detached, reads it from there).
tmp=$(umask 077; mktemp "${TMPDIR:-/tmp}/nomo-agy-ev.XXXXXX" 2>/dev/null) || { printf '{}\n'; exit 0; }
cat >"$tmp" 2>/dev/null
detach() {
  (NOMO_HOOK_PPID=$PPID "$d/run.sh" "$d/../dist/antigravity-status.mjs" "$1" <"$tmp"; rm -f "$tmp") \
    </dev/null >/dev/null 2>&1 &
  exit 0
}
# Run the bundle in the background with its stdout on a FIFO, read its FIRST line, and print it only if
# it is EXACTLY one of the shapes this event may answer with ($1 = the event); anything else → `{}`.
foreground() {
  fifo="$tmp.out"
  if ! (umask 077; mkfifo "$fifo") 2>/dev/null; then printf '{}\n'; detach "$1"; fi
  (NOMO_AGY_SYNC=1 NOMO_HOOK_PPID=$PPID "$d/run.sh" "$d/../dist/antigravity-status.mjs" "$1"; rm -f "$tmp") \
    <"$tmp" >"$fifo" 2>/dev/null &
  out=
  IFS= read -r out <"$fifo"
  rm -f "$fifo"
  case "$1:$out" in
    'PostInvocation:{"terminationBehavior":"terminate"}') ;;
    'PreInvocation:{"injectSteps":[{"userMessage":"'*'"}]}') ;;
    'Stop:{"decision":"continue","reason":"'*'"}') ;;
    *) out='{}' ;;
  esac
  printf '%s\n' "$out"
  exit 0
}
if [ "$1" = PostInvocation ]; then
  for f in "$dir/"*.agy-interrupt; do [ -e "$f" ] && foreground "$1"; break; done
fi
if [ "$1" = PreInvocation ] || [ "$1" = Stop ]; then
  for f in "$dir/"*.agy-inbox; do
    [ -e "$f" ] || break
    c=${f##*/}; c=${c%.agy-inbox}; c=${c%.*}
    grep -qF "\"$c\"" "$tmp" 2>/dev/null && foreground "$1"
  done
fi
printf '{}\n'
detach "$1"
