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
FALLBACK='{"decision":"allow"}'
GUARD_S=${NOMO_AGY_GUARD_S:-86280}
d=$(dirname "$0")
tmp=$(mktemp "${TMPDIR:-/tmp}/nomo-agy.XXXXXX" 2>/dev/null) || { printf '%s\n' "$FALLBACK"; exit 0; }
exec 3<&0
"$d/run.sh" "$d/../dist/antigravity-approve.mjs" <&3 >"$tmp" 2>/dev/null &
pid=$!
(
  trap 'kill "$s" 2>/dev/null; exit 0' TERM
  sleep "$GUARD_S" & s=$!
  wait "$s" && kill -9 "$pid" 2>/dev/null
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
