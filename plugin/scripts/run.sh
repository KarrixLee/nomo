#!/bin/sh
# Resolve a JS runtime: prefer bun, else node; hooks must stay silent on failure.
if command -v bun >/dev/null 2>&1; then exec bun "$@"; fi
if command -v node >/dev/null 2>&1; then exec node "$@"; fi
exit 0
