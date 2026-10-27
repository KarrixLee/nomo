#!/bin/sh
# antigravity-approve.sh — the PreToolUse command Nomo's block in ~/.gemini/config/hooks.json runs (only
# for the tools in its matcher: shell commands and file writes/edits). It asks the phone through
# dist/antigravity-approve.mjs and prints EXACTLY ONE decision line, then exits 0.
#
# Antigravity's PreToolUse is FAIL-CLOSED: `{}`, a non-zero exit, garbage, or overrunning the hook
# timeout all BLOCK the tool. So the bundle's output is captured, checked against the three shapes Nomo
# ever sends, and replaced by `{"decision":"allow"}` (= no opinion: Antigravity's own prompt) when it is
# anything else — a crash, a missing runtime, nothing at all. A kill guard ends the bundle well inside
# the registered timeout (see ANTIGRAVITY_APPROVAL_TIMEOUT_S in core/antigravity-approval.ts).
# (`sleep 1` per guard second: a fork a second only while a hold is actually waiting on the phone.)
FALLBACK='{"decision":"allow"}'
GUARD_S=${NOMO_AGY_GUARD_S:-86280}
d=$(dirname "$0")
tmp=$(mktemp "${TMPDIR:-/tmp}/nomo-agy.XXXXXX" 2>/dev/null) || { printf '%s\n' "$FALLBACK"; exit 0; }
pid=
guard=
# Antigravity interrupting the hook (TERM/INT/HUP) must not orphan the bundle or the guard: TERM both —
# the bundle's SIGTERM handler withdraws the phone's card at its next round and exits — and still give
# the one reply. A SIGKILL skips this; then the bundle notices its parent changed and does the same.
trap 'kill "$pid" "$guard" 2>/dev/null; rm -f "$tmp"; printf "%s\n" "$FALLBACK"; exit 0' TERM INT HUP
exec 3<&0
"$d/run.sh" "$d/../dist/antigravity-approve.mjs" <&3 >"$tmp" 2>/dev/null &
pid=$!
# The kill guard: ends the bundle after GUARD_S, and ends ITSELF the moment the bundle is done or this
# wrapper is gone — so it never outlives the hold (no 24-hour orphan `sleep`, no kill of a reused pid).
me=$$
(
  i=0
  while [ "$i" -lt "$GUARD_S" ]; do
    sleep 1
    kill -0 "$pid" 2>/dev/null || exit 0
    kill -0 "$me" 2>/dev/null || exit 0
    i=$((i + 1))
  done
  kill -9 "$pid" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
guard=$!
wait "$pid" 2>/dev/null
kill "$guard" 2>/dev/null
out=$(cat "$tmp" 2>/dev/null)
rm -f "$tmp"
case "$out" in
  *'
'*) out=$FALLBACK ;;
  '{"decision":"allow"}'|'{"decision":"auto_approve"}') ;;
  '{"decision":"deny","reason":"'*'"}') ;;
  *) out=$FALLBACK ;;
esac
printf '%s\n' "$out"
exit 0
