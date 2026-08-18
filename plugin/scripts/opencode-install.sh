#!/bin/bash
# Install the OpenCode side of nomo: the plugin stub + the /nomo-* slash commands.
#
# OpenCode has no marketplace and no `plugin add` for a local checkout — it auto-discovers
# `{plugin,plugins}/*.{ts,js}` inside its config directories and `import()`s whatever it finds
# (packages/opencode/src/config/plugin.ts). So the install is one generated file per artifact, and
# this script is what generates them instead of the user hand-editing shell lines.
#
# A STUB, NOT A COPY. `~/.config/opencode/plugin/nomo.js` is a one-line re-export of this checkout's
# `dist/opencode.js`. The bundle must EXECUTE from dist/, because shared.ts resolves the watchdog
# (cc-watchdog.mjs) as a sibling of `import.meta.url` — a copied file would look for a watchdog that
# is not there. The indirection is also what makes `git pull` an upgrade: the stub names a path, not
# a version, so nothing here goes stale.
#
# THE COMMANDS NEED THE ROOT BAKED IN. Claude Code hands a command `${CLAUDE_PLUGIN_ROOT}`; Codex
# skills recover it from `codex plugin list`. OpenCode offers neither — a command file is a plain
# prompt template with no notion of which plugin (if any) shipped it. So the templates in
# ../opencode-commands carry a `__NOMO_ROOT__` placeholder and this script substitutes the real path
# on the way in. Move the checkout and you re-run this script; that is the whole upgrade story.
#
# LOUD ON FAILURE, deliberately unlike the hooks. run.sh and every hook exit 0 on any problem so a
# broken install never disturbs the user's agent. This is an interactive command the user typed on
# purpose: a silent success that installed nothing is the worst outcome, so every error here is a
# message on stderr and a non-zero exit.
#
# Usage:
#   plugin/scripts/opencode-install.sh              # global: $XDG_CONFIG_HOME/opencode (~/.config/opencode)
#   plugin/scripts/opencode-install.sh --project    # this repo only: ./.opencode
#   plugin/scripts/opencode-install.sh --force      # overwrite files this script did not write
set -euo pipefail

# Marker string carried by every file this script writes, so a re-run can tell "mine, refresh it"
# from "someone else's nomo.js, do not touch". Never change it without a migration.
MARK='nomo-opencode-install'

FORCE=0
SCOPE=global

usage() {
  echo "usage: opencode-install.sh [--project] [--force]"
  echo "  --project   install into ./.opencode instead of the global OpenCode config dir"
  echo "  --force     overwrite same-named files this script did not write"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) SCOPE=project ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "opencode-install: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

fail() { echo "opencode-install: $1" >&2; exit 1; }

# $0 is the only trustworthy statement of which checkout is running (same reasoning as run.sh) — and
# the user should never have to find this path themselves, which is the entire point of the script.
# `pwd -P` so the recorded root is canonical and survives the `..`.
ROOT=$(cd "$(dirname "$0")/.." && pwd -P) || fail "could not resolve the plugin root from $0"

# The stub is a JS string literal and the commands are baked shell. A path containing a quote or a
# backslash would produce a file that parses as something else entirely, so refuse rather than
# generate it. (Spaces are fine — every generated line quotes the path.)
# shellcheck disable=SC1003  # '\' is a literal backslash glob here, not an escaped quote
case "$ROOT" in
  *'"'*|*'\'*|*'$'*|*'`'*) fail "the plugin path contains a character that cannot be quoted safely: $ROOT" ;;
esac

BUNDLE="$ROOT/dist/opencode.js"
TEMPLATES="$ROOT/opencode-commands"
[ -f "$BUNDLE" ] || fail "$BUNDLE is missing — run 'bun build.ts' from the repo root first"
[ -d "$TEMPLATES" ] || fail "$TEMPLATES is missing — this does not look like a nomo plugin directory"

if [ "$SCOPE" = project ]; then
  CONFIG_DIR="$PWD/.opencode"
else
  # xdg-basedir, exactly as packages/core/src/global.ts resolves Global.Path.config.
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
fi

# Refuse to overwrite a same-named file this script did not write. `pattern` is what proves ownership:
# for the stub it is the dist path it must contain (which also adopts the hand-written stub from the
# pre-script README instructions), for a command file it is the marker comment.
claim() {
  dest=$1
  pattern=$2
  [ -e "$dest" ] || return 0
  grep -q "$pattern" "$dest" 2>/dev/null && return 0
  if [ "$FORCE" = 1 ]; then
    echo "opencode-install: overwriting unrecognized $dest (--force)"
    return 0
  fi
  fail "$dest already exists and was not written by this script — move it aside, or re-run with --force"
}

STUB="$CONFIG_DIR/plugin/nomo.js"
claim "$STUB" 'dist/opencode\.js'
mkdir -p "$CONFIG_DIR/plugin"
printf '// %s — regenerate with %s\nexport { default } from "%s";\n' \
  "$MARK" "$ROOT/scripts/opencode-install.sh" "$BUNDLE" > "$STUB"

# VERIFY THE STUB, not our own variables: read the path back out of the file we just wrote and check
# it resolves. That is what catches a quoting bug in the line above, which is the one failure mode
# that would otherwise surface as OpenCode silently not loading the plugin.
resolved=$(sed -n 's|^export { default } from "\(.*\)";$|\1|p' "$STUB")
[ -n "$resolved" ] || fail "wrote $STUB but could not read the export target back out of it"
[ -f "$resolved" ] || fail "$STUB points at $resolved, which does not exist"

mkdir -p "$CONFIG_DIR/commands"
installed=""
for template in "$TEMPLATES"/*.md; do
  [ -f "$template" ] || continue
  name=$(basename "$template" .md)
  dest="$CONFIG_DIR/commands/$name.md"
  claim "$dest" "$MARK"
  # Bash substitution, not sed: the root is a filesystem path and any sed delimiter could appear in it.
  body=$(cat "$template")
  # The ownership marker is APPENDED HERE, not carried in the template: a new command file that
  # forgot it would install fine and then be refused on the next run as "someone else's file".
  # Nothing a template author has to remember.
  printf '%s\n\n<!-- %s -->\n' "${body//__NOMO_ROOT__/$ROOT}" "$MARK" > "$dest"
  # Same reasoning as the stub check above: read the RESULT back. Every command has to name the
  # plugin root to be able to run anything, so a template that lost (or never had) its
  # `__NOMO_ROOT__` placeholder installs a command that fails later, inside the user's session, with
  # a confusing message. Requiring the root to appear in the output catches that here instead.
  if ! grep -qF "$ROOT" "$dest"; then
    fail "$dest names no plugin path — $template is missing its __NOMO_ROOT__ placeholder"
  fi
  installed="$installed /$name"
done
[ -n "$installed" ] || fail "no command templates found in $TEMPLATES"

echo "opencode-install: plugin   -> $STUB"
echo "opencode-install:             re-exports $BUNDLE"
echo "opencode-install: commands ->$installed"
echo "opencode-install:             in $CONFIG_DIR/commands/"
if [ "$SCOPE" = project ]; then
  echo "opencode-install: project scope — this install only applies under $PWD"
fi
echo "opencode-install: restart OpenCode to pick it up (plugins are imported once at server start; there is no hot reload)."
echo "opencode-install: then run /nomo-status — or /nomo-pair if this computer has never been paired."
