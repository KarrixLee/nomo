---
description: Move this Claude Code session to your Nomo cloud box (it moves the moment you quit here)
argument-hint: [then <message>|quiet|cancel|status]
---

Read `$ARGUMENTS` (trimmed; keywords case-insensitive) and run **at most one** of these commands in the
foreground. Show its output to the user verbatim.

**Anything other than empty, `quiet`, `then <message>`, `cancel` or `status`** (a typo like `cancle`, or
`then` with no message, included): run nothing. Reply only: "Usage: /nomo-cc:handoff (move this session;
it continues on its own), /nomo-cc:handoff then <message>, /nomo-cc:handoff quiet, /nomo-cc:handoff
cancel, /nomo-cc:handoff status".

**Empty, `quiet`, or `then <message>`** — get this session ready to move. Empty sends the box session a
default "continue" message once it starts there, `then <message>` sends that message instead, `quiet`
sends nothing. The argument is user text, so it reaches the command ONLY as the body of a quoted
heredoc, which the shell never expands:

```
{ NOMOR="${CLAUDE_PLUGIN_ROOT}"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/handoff.mjs" --later --args-stdin --session "${CLAUDE_SESSION_ID}"; [ -x "$NOMOS" ] && exec "$NOMOS" handoff --later --args-stdin --session "${CLAUDE_SESSION_ID}"; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1; } <<'NOMO_END_XXXXXXXXXXXX'
ARGUMENT
NOMO_END_XXXXXXXXXXXX
```

Fill it in exactly like this, changing nothing else:
- `ARGUMENT`: the whole argument, verbatim (`then` / `quiet` included; nothing at all when it is empty),
  on its own lines. Never put it anywhere else in the command: not on the first line, not in quotes,
  not in `$(…)`, not escaped or rewritten.
- `XXXXXXXXXXXX` (on BOTH delimiter lines): 12 random letters and digits you make up now, never the same
  as an earlier run. If the argument contains your delimiter line anywhere, pick another one.
- Keep the quotes around the first `'NOMO_END_…'`: they are what stops `$`, backticks and `\` in the
  argument from being expanded.

**`cancel`** — stop a handoff that is still waiting for this session to close:

```
NOMOR="${CLAUDE_PLUGIN_ROOT}"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/handoff.mjs" --later-cancel; [ -x "$NOMOS" ] && exec "$NOMOS" handoff --later-cancel; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

**`status`** — is a handoff waiting, and how did the last one end:

```
NOMOR="${CLAUDE_PLUGIN_ROOT}"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/handoff.mjs" --later-status; [ -x "$NOMOS" ] && exec "$NOMOS" handoff --later-status; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

The session does NOT move while it is open: the command only checks things locally and starts a
background helper that moves it once this Claude Code session exits (so the copy in the cloud starts
from a finished turn and the two never run at once). After `Ready. Quit Claude Code now (/exit)…`,
tell the user to type `/exit` now, and do nothing else in this session: any further turn here would
be left behind. If the output says the box needs pairing, relay the terminal command it printed and
stop; nothing was started.
