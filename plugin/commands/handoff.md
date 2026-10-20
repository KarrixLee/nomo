---
description: Move this Claude Code session to your Nomo cloud box (it moves when this turn ends; this window stays parked)
argument-hint: [anyway] [then <message>|quiet] | cancel | status
---

Read `$ARGUMENTS` (trimmed; keywords case-insensitive) and run **at most one** of these commands in the
foreground. Show its output to the user verbatim. Run it right away without asking for confirmation: once the
window is parked, plain replies are blocked, so a question would strand the user.

Any of empty, `quiet` or `then <message>` may start with the word `anyway` (`anyway`, `anyway quiet`,
`anyway then <message>`): the user's confirm to move a conversation the command said looks like it holds
secrets. Only ever use `anyway` when the USER typed it; never add it yourself.

**Anything other than empty, `quiet`, `then <message>` (each optionally after `anyway`), `cancel` or `status`** (a typo like `cancle`, or
`then` with no message, included): run nothing. Reply only: "Usage: /nomo-cc:handoff (move this session;
it continues on its own), /nomo-cc:handoff then <message>, /nomo-cc:handoff quiet, /nomo-cc:handoff
cancel, /nomo-cc:handoff status".

**Empty, `quiet`, or `then <message>`** (optionally after `anyway`) — get this session ready to move. Empty sends the box session a
default "continue" message once it starts there, `then <message>` sends that message instead, `quiet`
sends nothing. The message is typed into the box session as if the user typed it, so one starting
with `/` or `!` runs there as a slash command or a bash command. The argument is user text, so it reaches the command ONLY as the body of a quoted
heredoc, which the shell never expands:

```
{ NOMOR="${CLAUDE_PLUGIN_ROOT}"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/handoff.mjs" --later --args-stdin --session "${CLAUDE_SESSION_ID}"; [ -x "$NOMOS" ] && exec "$NOMOS" handoff --later --args-stdin --session "${CLAUDE_SESSION_ID}"; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1; } <<'NOMO_END_XXXXXXXXXXXX'
ARGUMENT
NOMO_END_XXXXXXXXXXXX
```

Fill it in exactly like this, changing nothing else:
- `ARGUMENT`: the whole argument, verbatim (`anyway` / `then` / `quiet` included; nothing at all when it is empty),
  on its own lines. Never put it anywhere else in the command: not on the first line, not in quotes,
  not in `$(…)`, not escaped or rewritten.
- `XXXXXXXXXXXX` (on BOTH delimiter lines): 12 random letters and digits you make up now, never the same
  as an earlier run. If the argument contains your delimiter line anywhere, pick another one.
- Keep the quotes around the first `'NOMO_END_…'`: they are what stops `$`, backticks and `\` in the
  argument from being expanded.

**`cancel`** — stop a handoff that is still waiting for this turn to end, or unpark this window when
nothing is waiting (the cloud copy is left as it is):

```
NOMOR="${CLAUDE_PLUGIN_ROOT}"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/handoff.mjs" --later-cancel --session "${CLAUDE_SESSION_ID}"; [ -x "$NOMOS" ] && exec "$NOMOS" handoff --later-cancel --session "${CLAUDE_SESSION_ID}"; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

**`status`** — is a handoff waiting, and how did the last one end:

```
NOMOR="${CLAUDE_PLUGIN_ROOT}"; NOMOS="$HOME/.config/cc-status/hook-shim.sh"; [ -n "$NOMOR" ] && [ -x "$NOMOR/scripts/run.sh" ] && exec "$NOMOR/scripts/run.sh" "$NOMOR/dist/handoff.mjs" --later-status; [ -x "$NOMOS" ] && exec "$NOMOS" handoff --later-status; echo "Nomo could not find its installed files - reinstall the nomo plugin."; exit 1
```

The session does NOT move mid-turn: the command only checks things locally, parks this window, and
starts a background helper that moves the session as soon as this turn ends (so the copy in the cloud
starts from a finished turn and the two never run at once). After `Ready. Session … moves to the cloud
as soon as this turn ends…`, tell the user in one line that it moves when this reply ends and that this
window stays open but parked (new prompts are blocked; `/nomo-cc:back` here brings it home, `/nomo-cc:handoff cancel` unparks it), then end
your turn without running anything else. If the output says the box needs pairing, relay the terminal
command it printed and stop; nothing was started. If the output says the conversation contains what look like
secrets, relay it verbatim and stop; nothing was started, and only the user decides whether to run
`/nomo-cc:handoff anyway` (never run it for them).

The box runs up to 4 handed-off sessions at once, one per project folder (two from the same folder
would share its files). A handoff over that limit, or from a folder another cloud session still holds,
fails with a message naming what to bring back first; `/nomo-cc:handoff status` shows it, relay it verbatim.

The output may include a `Cloud check:` line naming what the box won't have (secrets never sent, deps to reinstall, MCP servers, Mac-only tools); relay it verbatim, it never blocks the move (`handoff.mjs --check` prints only that block, moving nothing).
