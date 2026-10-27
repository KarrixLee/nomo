#!/bin/sh
# antigravity-hook.sh — the command Nomo's block in ~/.gemini/config/hooks.json runs, one per event:
#   '<root>/scripts/antigravity-hook.sh' <EventName>
# Antigravity requires every handler to print a JSON object and exit 0. This prints `{}` FIRST — so no
# crash, missing runtime, unpaired machine, slow network or kill can ever leave it without its reply —
# then hands stdin to the bundle, whose output is discarded (it prints nothing anyway). Always exit 0.
printf '{}\n'
d=$(dirname "$0")
"$d/run.sh" "$d/../dist/antigravity-status.mjs" "$1" >/dev/null 2>&1
exit 0
