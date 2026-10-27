<p align="center"><img src="assets/icon.png" width="120" alt="Nomo"></p>

# Nomo — Live Activity on your iPhone

<p align="center">
<img src="assets/claude.png" height="26" alt="Claude Code">&nbsp;&nbsp;
<img src="assets/codex.png" height="26" alt="OpenAI Codex">&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="assets/opencode-dark.png"><img src="assets/opencode-light.png" height="26" alt="OpenCode"></picture>&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="assets/cursor-dark.png"><img src="assets/cursor-light.png" height="26" alt="Cursor"></picture>&nbsp;&nbsp;
<img src="https://img.shields.io/badge/License-MIT-blue" alt="License: MIT">
</p>

<p align="center">
<a href="https://apps.apple.com/app/nomo-ai-status-usage/id6779366830"><img src="assets/app-store-badge.svg" height="48" alt="Download Nomo on the App Store"></a>
</p>

Mirror your **Claude Code**, **OpenAI Codex**, **OpenCode**, **Cursor** and **Antigravity** session milestones to
the **Nomo iPhone app** as a Live Activity (Dynamic Island). A session's status — working,
needs-your-approval, done — shows up on your phone in real time, so you can step away from the
terminal and still know when an agent needs you or has finished. When a Claude Code, Codex,
OpenCode or Antigravity session stops for a permission prompt or a question, you can **answer it from
the phone** — tap Allow/Deny or pick an option and the session carries on without you at the keyboard
(Cursor is status-only; Antigravity answers Allow/Deny for shell commands and file writes). Works with **Codex** in the terminal and the **Codex desktop app** alike.

Everything is **end-to-end encrypted**. Pairing is a single QR-code scan (or a short typed code);
there is no server key to copy. All session content (titles, machine name, status, even *which* agent
produced an event) rides **inside** an encrypted blob, so the relay Worker that fans out the APNs
push is a blind relay and never sees plaintext. **One pairing covers every agent** on a machine —
Claude Code, Codex, OpenCode, Cursor and Antigravity share the same credentials, encryption key, watchdog, and
Live Activity.

> [!NOTE]
> **This README is the contributor and security view** — how it's built, how it's wired, and what
> the crypto actually guarantees. The user guide (pairing walkthrough, command reference,
> per-agent differences, troubleshooting) lives at **[docs.nomo.gg](https://docs.nomo.gg)**.

> [!NOTE]
> **Platforms:** developed and tested on **macOS** and **Linux**. **Windows is untested** — it may
> work (the hooks are pure Node built-ins), but nothing on Windows has been verified, so treat it as
> unsupported for now.

The PC side ships as **four integrations over one shared `plugin/` directory**: a **Claude Code
plugin** (`nomo-cc`), a **native Codex plugin** (`nomo`), an **OpenCode plugin module**, and a
**Cursor hook** merged into Cursor's `hooks.json`. Claude Code, Codex and Cursor run the same kind of
self-contained `.mjs` hooks, the liveness watchdog, and the interactive commands as single-file
artifacts that run under **either bun or node ≥ 18** (a `run.sh` shim picks whichever is installed);
OpenCode instead loads one resident `.js` bundle inside its own server process. There are **zero
npm dependencies** — Node built-ins only.

## Architecture — end-to-end encrypted

Pairing establishes **one shared key** that only your phone and computer ever hold — no server
sees it. There are two ways to hand it over, and both keep the key off every server:

- **Scan the QR** on the pairing page. The QR carries a random pairing secret that rides only in the
  code image; the phone mixes it with its own nonce (HKDF-SHA256) to derive the shared key.
- **Type the one-time code** — six words and a short channel number (e.g.
  `7-ocean-sunset-mango-river-atlas-cabin`). The phone runs PBKDF2-SHA256 over the six words to
  reconstruct the same secret, then the same HKDF step, arriving at the identical key. The words never
  leave the pairing page; the channel is only a one-time routing handle the phone redeems once (it
  burns on first use and expires in 10 minutes).

Either way, the plugin encrypts every session update with the derived key **before** anything leaves
your machine, so the relay Worker and Apple's push service only ever carry ciphertext. Decryption
happens on your iPhone.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.png">
  <img src="assets/architecture-light.png" alt="End-to-end encryption architecture: hooks on your computer feed the nomo plugin, which encrypts with a key shared only at pair time — by scanning the QR or typing the one-time code, never through a server; the Cloudflare Worker relay and APNs carry ciphertext they cannot read; your iPhone decrypts on device and renders the Live Activity.">
</picture>

<sub>Diagram source: [`assets/architecture.excalidraw`](assets/architecture.excalidraw) — open it at [excalidraw.com](https://excalidraw.com) to edit.</sub>

**Plaintext — titles, machine name, status, even which agent produced the event — never leaves
your computer except end-to-end encrypted.** The Worker is a blind fan-out relay: it can route by
pairing id but cannot read a single field of what it forwards.

### The code is never printed

By default the one-time pairing code is shown **only on the pairing page**, behind a "Tap to reveal
code" control — it is never printed to the terminal, so it cannot end up in shell history, a screen
recording, or an AI assistant's transcript. `pair.mjs --show-code` (`/nomo-cc:pair code`,
`$nomo-pair code`, `/nomo-pair code`) is the deliberate opt-out for a headless or SSH-only box: it
skips the page and prints the code to stdout, where it is sensitive for the ~10 minutes it is valid.
When a browser is available at all, prefer the page — scanning the QR never touches a keyboard, a
terminal, or a chat transcript. Walkthrough: [docs.nomo.gg/setup/pairing](https://docs.nomo.gg/setup/pairing).

## Encryption

In plain English:

- **Every session update is sealed with AES-256-GCM** before it leaves your machine. The relay Worker
  and Apple's push service only ever carry ciphertext — they can route it by pairing id but can't read
  a single field (title, machine name, status, or which agent produced it). The relay is **blind**:
  the only things that transit it in the clear are *public* keys.
- **The typeable code is six BIP39 words (~66 bits of entropy)**, stretched with **PBKDF2-SHA256 at
  600,000 iterations**. Six words (up from four) puts an offline brute-force — the attack a
  logging/compromised relay could try against the known-plaintext pairing blob — out of reach.
- **A per-pairing ephemeral ECDH (P-256) "ratchet" derives the durable key.** The code (or the
  scanned QR secret) only bootstraps a one-time handshake key; your computer and phone each generate a
  throwaway keypair, do an ECDH, and mix the result with that bootstrap key to produce the key that
  actually encrypts your sessions. The throwaway private keys are discarded right after pairing. This
  gives **forward secrecy**: a code revealed *after* you've paired — leaked into a screen recording, a
  shell history, or an AI transcript — **can't decrypt your sessions**, because the ephemeral private
  keys it would need are already gone. Mixing the code into the handshake also stops a relay from
  quietly swapping the public keys (a man-in-the-middle): if it tampers, pairing fails instead of
  silently succeeding under the attacker's key.
- **Each sealed session update names its own session.** The session id travels in the clear (the
  relay routes by it), so every sealed session blob also carries the same id inside the seal (`sid`).
  The app treats a blob whose sealed `sid` differs from the session it is listed under as unreadable,
  so a relay cannot relabel one session's real update as another's and steer what you tap (an
  approval, an interrupt) onto the wrong session. Updates from plugins older than this carry no `sid`
  and are still shown.

## Install — one command

```sh
bunx nomo-ai     # or: npx nomo-ai
```

It detects which of Claude Code, Codex, OpenCode, Cursor and Antigravity are on this machine, shows exactly what
it will run for each, and lets you toggle the list before anything happens. Then it drives **each
host's own install path** — the same four flows spelled out below — and prints the restart-and-pair
step for each one it installed.

It is a **bootstrapper, not a package manager**: it never writes into `~/.claude` or `~/.codex`
itself, because those hosts own install *and* update through their marketplaces, and a second writer
racing `claude plugin update` is how you end up with two versions fighting over one watchdog daemon.
There is deliberately **no `postinstall` hook** — a package that edits your agent config just because
you `npm install`ed it is the shape you should distrust. It only does something when you run it.

It never pairs your phone. Pairing stays the deliberate step you run from inside the agent
afterwards.

For scripting and CI:

| Flag | |
|---|---|
| `--claude` `--codex` `--opencode` `--cursor` `--antigravity` | install exactly these — naming any one of them skips the prompt |
| `--all` | all of them, detected or not — except Cursor and Antigravity, which are skipped with a note when they are not on this machine (name `--cursor` / `--antigravity` to try anyway) |
| `-y`, `--yes` | no prompt; install everything detected |
| `-n`, `--dry-run` | print the commands, run nothing |
| `--ref <branch\|tag>` | **OpenCode, Cursor and Antigravity only** — install from that ref instead of the default branch |
| `-h`, `--help` / `-v`, `--version` | |

With no flags and no terminal to ask, it refuses rather than guessing. Every failure names the step,
the exit code, and the command to run by hand; the exit status is non-zero if any agent failed.

The OpenCode leg clones this repo to `~/.nomo` and runs `plugin/scripts/opencode-install.sh` from
there — the same thing you would do by hand below. It has to be a durable checkout, not the npm
tarball: the installed stub re-exports an absolute path, and a `bunx` cache directory does not survive
the week.

**It updates as well as installs**, and the two clone-based legs do it for you. An agent that already
has Nomo shows an update in the plan instead of an install. For OpenCode and Cursor that update really
runs — neither host has an update path for Nomo, so the `~/.nomo` checkout is the version. OpenCode's
`~/.nomo` is fetched, compared and pulled by the same code `/nomo-update` uses; Cursor's is
fast-forwarded (`git pull --ff-only`) and `cursor-install.mjs` re-run to refresh `hooks.json` and the
skills. For Claude Code the row **prints** the host's own command and runs nothing:

```sh
claude plugin update nomo-cc@nomo
```

Claude Code does auto-update plugins, but per-marketplace behind an `autoUpdate` flag that defaults
**on** for Anthropic-official marketplaces and **off** for third-party and local ones. Nomo is
third-party, so that command is the only thing that moves your install.

**Codex has no update verb at all** — `codex plugin` is add/list/marketplace/remove — so its row is
gated on how the marketplace was added, which `~/.codex/config.toml` records as `source_type`:

| `source_type` | what an update is | the row |
| --- | --- | --- |
| `local` | Codex reads the plugin **live from the path**; a `git pull` there is the whole update | prints no command — there is nothing to run |
| `git` | Codex holds a snapshot, and refreshing it *is* the plugin update | `codex plugin marketplace upgrade <marketplace>` |
| missing / unreadable | unknown | prints no command |

Every marketplace Codex ships with is local, so "nothing to run" is the common case, not the corner
one. A printed no-op is worse than a missing line: one is invisible, the other sends you chasing it.

The asymmetry is deliberate. Both hosts already update in one command you own, so running it for you
buys almost nothing — and install begins with `marketplace add`, which would silently repoint a
marketplace you had aimed somewhere else (a local checkout, a fork) and send every later update to the
wrong place. Repointing a marketplace is install-time behaviour; it has no business in an update.

`--ref` exists for testing a branch or tag before it merges, and it reaches **two legs**: the
`~/.nomo` checkout that OpenCode and Cursor share is the only thing the installer owns. `claude plugin
marketplace add` and `codex plugin marketplace add` take an owner/repo and read the default branch —
there is no ref to hand them — so the installer says so out loud when you combine `--ref` with those
legs rather than implying it pinned all four. A `--ref` checkout is left **detached** on purpose:
that is how a later plain `bunx nomo-ai` recognises a pin and refuses to quietly fast-forward it
back (delete `~/.nomo`, or pass `--ref` again, to move it).

## <img src="assets/claude.png" height="22" align="center" alt=""> Install — Claude Code

From inside Claude Code:

```
/plugin marketplace add KarrixLee/nomo
/plugin install nomo-cc@nomo
```

Restart Claude Code so the hooks load, then pair this machine with your phone:

```
/nomo-cc:pair
```

It opens a browser page with a QR code; scan it from the Nomo app's **Sessions** tab
(**Pair a Computer**). Once it reports `Paired with … ✓` this machine's sessions appear in the app.

Five commands, all namespaced `nomo-cc:` — `pair`, `status`, `approvals`, `reset`, `unpair`
([reference](https://docs.nomo.gg/sessions/commands)).

The lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Notification`, `PermissionRequest`, `Stop`, `SessionEnd`, `StopFailure`, `PostToolUseFailure`,
`PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`) are wired automatically by the
plugin — no `settings.json` edits. The hook is deliberately silent: no pairing → no-op; network down
→ 2 s timeout, exit 0. It cannot affect a Claude Code session. A `start`/`update` POST the timeout
cuts off marks the session record `updatePending`; the watchdog's next 5 s sweep re-sends the
record's current state with a 5 s POST timeout, backing off 5 s → 60 s after a failure and holding
back while an approval hold is live.

## <img src="assets/codex.png" height="22" align="center" alt=""> Install — OpenAI Codex

Codex (**≥ 0.142**) ships a native plugin system, so Nomo installs as a standalone Codex plugin
(also named `nomo`, sharing the same `plugin/` directory as the Claude manifest). No Claude Code
required. From inside a Codex session — or the **Codex desktop app**'s built-in terminal:

```
codex plugin marketplace add KarrixLee/nomo
codex plugin add nomo@nomo
```

Then **trust the hooks once**: run `/hooks` and trust the **ten Nomo entries**. They ship with the
plugin (`plugin/hooks/codex-hooks.json`) but stay **inert until trusted** — this is Codex's own
safety gate, which Nomo cannot pre-approve. Skipping it leaves the plugin installed and silently
doing nothing. The hook command lines are byte-stable across releases, so trusting once holds
through updates (only a changed hook line re-arms the review).

Pair with `$nomo-pair`; the other four skills are `$nomo-status`, `$nomo-approvals`, `$nomo-reset`,
`$nomo-unpair` ([reference](https://docs.nomo.gg/sessions/commands)). There is **no separate Codex
pairing** — the hooks and skills read the same `~/.config/cc-status/config.json`, so they stay inert
(exit 0) until pairing completes. On the wire the only difference from Claude Code is that Codex's
encrypted blob is tagged `agent: "codex"`, so the phone can brand it.

Codex `request_user_input` questions additionally need the Codex task and the Nomo watchdog to share
one app-server process — see [docs.nomo.gg/sessions/codex](https://docs.nomo.gg/sessions/codex).

## <picture><source media="(prefers-color-scheme: dark)" srcset="assets/opencode-dark.png"><img src="assets/opencode-light.png" height="22" align="center" alt=""></picture> Install — OpenCode

OpenCode has no marketplace and no hooks: it loads **one resident plugin module** inside its own
server process, auto-discovering `{plugin,plugins}/*.{ts,js}` in its config directories. So the
install is a clone plus **one command** — no `opencode plugin` command, and deliberately **no
npm-resolved plugin**: OpenCode's `Npm.add` short-circuits on an existing cache directory, so a bare
spec resolves `@latest` exactly once and never updates again. (`bunx nomo-ai` automates the clone
below; it hands OpenCode a filesystem path, never a package spec.)

Already installed Nomo for Claude Code or Codex? Reuse that copy — `claude plugin list` /
`codex plugin list` prints its path. Otherwise clone the repo anywhere:

```sh
git clone https://github.com/KarrixLee/nomo.git ~/.nomo
~/.nomo/plugin/scripts/opencode-install.sh
```

That is the whole install. The script resolves its own location, so there is no path to look up and
nothing to hand-edit. It writes two things and prints exactly what it wrote:

- `~/.config/opencode/plugins/nomo.js` — a one-line stub re-exporting `<checkout>/plugin/dist/opencode.js`.
- `~/.config/opencode/commands/nomo-*.md` — the six slash commands, with the plugin path baked in.

Re-running it is safe and idempotent; run it again if you move the checkout. It refuses to overwrite
a same-named file it did not write (pass `--force` to override), and `--project` installs into
`./.opencode/` for one repo instead of globally.

**Restart OpenCode** — plugins are imported once at server start; there is no hot reload.

The stub is a **re-export, not a copy**: the bundle keeps executing from `plugin/dist/`, where it can
find its sibling `cc-watchdog.mjs`. OpenCode auto-discovers the directory, so there is nothing to add
to `opencode.json`.

The six commands are the same ones Claude Code and Codex ship, minus the namespace — OpenCode command
names are flat and global, so they are `/nomo-pair`, `/nomo-status`, `/nomo-approvals`,
`/nomo-reset`, `/nomo-unpair` ([reference](https://docs.nomo.gg/sessions/commands)) — plus
`/nomo-update`, which those two do not need.

### Updating — `/nomo-update`

```
/nomo-update
```

Then restart OpenCode. That is the whole thing.

It checks before it changes anything: fetch, read the target version straight off the remote
(`git show <upstream>:plugin/.claude-plugin/plugin.json` — nothing is checked out), compare. Already
current prints `Already on 2.1.21 — nothing to do.` and stops — no pull, no reinstall, and no restart
advice for a restart that would change nothing. Behind prints the delta (`2.1.21 → 2.1.23`) **before**
pulling, fast-forwards, and re-runs the installer so a new `/nomo-*` command appears and the stub is
refreshed.

It refuses, loudly and specifically, rather than guessing: a checkout pinned to a branch or tag by
`bunx nomo-ai --ref` (deliberately detached — fast-forwarding it would silently un-pin someone testing
a branch), a dirty tree, no upstream, a diverged history, an unreachable remote, and a stub whose
checkout has been moved or deleted. Every refusal names the command to run by hand.

**It only ever acts on Nomo's own checkout.** Updating runs git in the checkout and then executes its
`opencode-install.sh`, so the stub is not taken on faith: its target must be an absolute
`<checkout>/plugin/dist/opencode.js` (what the installer writes), and the checkout's `origin` must be
this repo on github.com (`https://`, `ssh://` or `git@github.com:`), or it refuses before running
anything there. `bunx nomo-ai` updates global scope only, from
your home directory, so the folder you happen to run it in can never pick the checkout; a project
`./.opencode` stub is read only by `/nomo-update` inside that project.

**The mechanism, for the curious.** OpenCode has no marketplace and no `plugin update`, so the
*checkout is the version* — `~/.config/opencode/plugins/nomo.js` is a one-line re-export of an
absolute `<checkout>/plugin/dist/opencode.js`, and updating means pulling that checkout and re-running
the installer. `/nomo-update` reads its own path back out of that stub, which is why it updates the
copy OpenCode actually imports rather than whichever one the command file was installed from. Doing it
by hand is still exactly `git -C <checkout> pull --ff-only && <checkout>/plugin/scripts/opencode-install.sh`.

**Pairing is shared, and `/nomo-pair` also works standalone.** The plugin reads the same
`~/.config/cc-status/config.json` as the other agents, so if you already paired with
`/nomo-cc:pair` or `$nomo-pair` there is nothing to do. If this machine has never been paired,
`/nomo-pair` does the whole pairing from inside OpenCode — then **quit and reopen OpenCode**, because
the plugin read the (absent) config once at server start and already decided to no-op for that
process. Unpaired, it stays silent. On the wire the only difference is the `agent: "opencode"` tag,
so the phone can brand it.

`opencode --pure` starts without external plugins, if you ever need to A/B whether Nomo is involved
in something.

### What OpenCode does and doesn't do

- **Approvals work**, on both channels: `permission.asked` (Allow / Always / Deny) and
  `question.asked` (pick an option, or decline). Todo lists ride along as ambient plan detail.
- **"Open on Mac" works for the desktop app only.** `opencodeLocateTuiPid` walks the server pid's
  ancestry for the `/OpenCode.app/Contents/MacOS/` main process; a CLI or `opencode serve` session
  belongs to the server, not to any terminal window, so it returns nothing and the button stays hidden.
- **Auto vs. manual approval mode is not observable.** It is TUI-side state that never crosses HTTP,
  so the phone cannot show which mode a session is in.
- **Plan mode shows a "Planning" indicator only.** With `OPENCODE_EXPERIMENTAL_PLAN_MODE` off (the
  default) a plan turn emits no plan document, so there is nothing to send; the phone gets the
  indicator. With the flag on, `plan_exit` rides the question channel and arrives on the phone as a
  normal approval, with no plugin change.
- A session's liveness is the **OpenCode server process**, not the terminal — quit OpenCode to retire
  a row that looks stale.

## <picture><source media="(prefers-color-scheme: dark)" srcset="assets/cursor-dark.png"><img src="assets/cursor-light.png" height="22" align="center" alt=""></picture> Install — Cursor

One install covers **both** the Cursor desktop app's agent and the `cursor-agent` CLI — they read the
same user-level hooks file, and Nomo runs one hook binary for both.

```sh
bunx nomo-ai --cursor     # or: npx nomo-ai --cursor
```

That clones this repo to `~/.nomo` (the same checkout the OpenCode leg uses) and runs
`plugin/scripts/cursor-install.mjs` from it. From a checkout you already have:

```sh
bun build.ts                                  # only if plugin/dist/ is not built
node plugin/scripts/cursor-install.mjs
```

**Restart Cursor** (and any open `cursor-agent`) so it re-reads its hooks, then `/nomo-pair` from
inside it. `/nomo-status`, `/nomo-reset` and `/nomo-unpair` are installed next to it as Cursor
**skills** (`~/.cursor/skills/nomo-*/SKILL.md`, or `$CURSOR_CONFIG_DIR/skills/` when that is set) —
the one format Cursor documents for the app and lists in the CLI's `/` menu. Pairing is shared with
the other agents, and needs no restart.

**What the installer writes.** Cursor's plugin format is documented for the desktop app only, so Nomo
uses the hook source both surfaces read: `~/.cursor/hooks.json` (or `$CURSOR_CONFIG_DIR/hooks.json`).
That file is yours and may carry other tools' hooks, so the installer **merges**:

- it checks first and **refuses before writing anything** if the file is not valid JSON of the
  expected shape, is a dangling symlink or has more than one hard link, or if it or the skills
  directory is not writable; if a same-named skill exists that it did not write (pass `--force` to
  override); if the Cursor config directory does not exist; or if `plugin/dist/` is not built. A live
  symlink is written through, not replaced;
- it appends one entry per event only if that exact entry is absent, adds `"version": 1` only if the
  key is missing, and never edits, reorders or removes an entry it did not write. An entry is Nomo's
  only if it sits on one of the eight events below, its command is exactly Nomo's two quoted paths
  under one checkout, and it has no keys besides `command` and `timeout`;
- when something does change, the file is re-serialised as 2-space JSON — every entry, its key order
  and its position kept, hand formatting not. A file that already has the entries is not rewritten;
- it writes atomically (temp file + rename) with the file's existing permissions, re-reading the file
  just before the rename so another tool's write in between is merged rather than lost.

The checkout path is written into the hook command and the skills, so a path containing `'`, `"`,
`$`, `\` or a backtick is refused.

**Events, and what the hook cannot do.** It registers eight — `sessionStart`, `beforeSubmitPrompt`,
`postToolUse`, `postToolUseFailure`, `afterShellExecution`, `afterFileEdit`, `stop`, `sessionEnd` —
and **no permission hook** (`preToolUse`, `beforeShellExecution`, …). The hook prints nothing and
always exits 0, so it cannot allow, deny or redirect anything Cursor does. `beforeSubmitPrompt` is an
event Cursor waits on, so the hook can **delay** a prompt by one small HTTPS request — up to about
2 seconds when the relay is unreachable (the send is awaited with a 2-second timeout).

### How the Cursor leg works

- **Read-only by construction.** With no permission hook there is nothing to hold and nothing to
  answer, so a Cursor session is only ever *working* or *done*; the `cursorAdapter` has no
  `locateTuiPid` seam either, so nothing can point at the window that owns a session.
- **A row starts at `beforeSubmitPrompt`**, not `sessionStart`, and only a new prompt reopens a
  stopped turn — subagent activity or a follow-up Cursor starts by itself does not.
- **The title is Cursor's own chat name**, read as one field from the desktop app's local state
  database with the system `sqlite3`, read-only, as soon as Cursor has generated it; until then, and
  for `cursor-agent` chats (which that database does not hold), the row is named after the first prompt.
- **Liveness is the `stop`/`sessionEnd` pair.** A turn whose `stop` never arrives is marked done after
  30 quiet minutes; a finished row retires after a little over an hour, and goes back to working if the
  turn shows activity again.
- The account email in Cursor's hook payloads is never read and is in no frame, record or log.

What the phone shows for a Cursor session, and the v1 limits, are at
[docs.nomo.gg/sessions/cursor](https://docs.nomo.gg/sessions/cursor).

To update, run `bunx nomo-ai --cursor` again (it pulls `~/.nomo`; the hook entries point at that
checkout, so a pull is the whole update). To remove it:

```sh
node ~/.nomo/plugin/scripts/cursor-install.mjs --uninstall
```

which removes exactly Nomo's hook entries and skills and leaves everything else in `hooks.json` as it
was. Pairing is untouched — it belongs to every agent on the computer.

## Install — Antigravity

One install covers the Google **Antigravity** desktop app/IDE and the `agy` CLI — both read
`~/.gemini/config/hooks.json`.

```sh
bunx nomo-ai --antigravity     # or, from a checkout: node plugin/scripts/antigravity-install.mjs
```

**Restart Antigravity** (and any open `agy`), then type **`/nomo-pair`**. The installer also adds a
small Antigravity plugin, `nomo`, with five commands:

| Command | What it does |
|---|---|
| `/nomo-pair` (`/nomo-pair code` without a browser) | connect this computer to the Nomo app |
| `/nomo-status` (`/nomo-status verbose` for details) | is it connected, are phone approvals on |
| `/nomo-approvals on` / `off` | phone approvals on or paused (shared by every agent on this computer) |
| `/nomo-reset` | clear stuck sessions from the phone, keep the connection |
| `/nomo-unpair` | disconnect this computer |

Pairing is shared machine-wide, so a computer already paired from another agent needs no
`/nomo-pair`. Antigravity asks before each command runs a shell command — choose Allow. If you once
imported Nomo's Claude Code plugin into Antigravity (`nomo-cc`), the installer tells you to remove it
(`agy plugin uninstall nomo-cc`): its Claude hooks would report every session twice. It never removes
it for you. Add `--verbose` to see the installer's technical detail.

**What the installer writes.** Antigravity's `hooks.json` is a set of *named* blocks. Nomo owns
exactly one, `"nomo"`, rewrites it whole on every install and leaves every other block alone; the
file is created as `{}` if it does not exist. It refuses — writing nothing — on a file that is not
valid JSON or not an object, and writes through a symlink rather than over it. The block registers
`SessionStart`, `PreInvocation`, `PostInvocation`, `Stop` and `PostToolUse`, each running
`plugin/scripts/antigravity-hook.sh <Event>` with a 10-second timeout, and one `PreToolUse` entry for
phone approvals: `plugin/scripts/antigravity-approve.sh`, matched **only** to shell commands and file
writes/edits (`run_command`, `write_file`, `write_to_file`, `edit_file`, `replace_file_content`,
`multi_replace_file_content`), with Claude Code's approval timeout of 24 hours. Each command first
checks that its script still exists and otherwise answers on its own (`{}`, or `{"decision":"allow"}`
for `PreToolUse`), so moving or deleting `~/.nomo` without uninstalling never blocks a tool.

It also copies the `nomo` plugin (a `plugin.json` and five skills, no hooks — plugin-packaged hooks
reach only the CLI, so the hooks stay in `hooks.json` for the desktop app) to
`~/.gemini/config/plugins/nomo`, with the checkout path written into each skill, plus a marker file.
A `nomo` folder without that marker is someone else's: the installer refuses and writes nothing.

### How the Antigravity leg works

- **The status hooks are read-only, except for your phone's Interrupt.** Their wrapper prints `{}`,
  hands the event to the work in the background and exits at once, so Antigravity never waits on Nomo
  and every path — a crash, no runtime, not paired, no network — returns the empty reply, never a
  `decision`. The one exception is a `PostInvocation` (after each model call) while an Interrupt is
  pending: then the wrapper waits for the work (capped at 4 seconds) and prints
  `{"terminationBehavior":"terminate"}` only when the bundle printed exactly that, else `{}`.
- **Interrupt from the phone.** Tapping Interrupt on a running Antigravity row (same rules as Claude
  Code: a live local link to this computer) stamps a one-shot flag for that conversation. The next
  `PostInvocation` consumes it and ends the turn there — so the turn stops when the current model call
  (or tool) finishes — and the row turns *done*. While the flag is up, a shell command or file write
  waiting on the phone, or about to, is denied with "Stopped from phone". A flag not acted on within
  10 minutes, or left when the turn ended on its own, is dropped and never touches a later turn.
  Nomo never signals the `agy` process (that would exit the CLI).
- **Phone approvals (`PreToolUse`).** For a shell command or a file write in a session your phone is
  showing, the tool waits while the phone shows Allow / Deny / Deny with note. Allow answers
  `auto_approve`; Deny answers `deny` with your note (or "Denied from phone") as the reason the agent
  sees. Every other outcome — not paired, approvals paused, the session not on the phone, no network,
  the request expiring — answers `allow`, which means "no opinion": Antigravity applies its own
  permission settings and shows its own prompt exactly as without Nomo. Your own `permissions` rules
  (the CLI's `~/.gemini/antigravity-cli/settings.json`, read-only) come first, in Antigravity's order
  Deny > Ask > Allow: anything a `deny` rule may match never reaches the phone — Antigravity denies it
  itself, and a phone Allow can never override it — and a command or path a plain-prefix `allow` rule
  covers (and no `ask` rule touches) is passed straight through. Reads, searches and every other tool
  never reach Nomo at all. "Always allow" is not offered for Antigravity. If Antigravity cancels the hook
  while it waits (you interrupted the turn at the computer), the card is withdrawn from the phone and
  the row turns *done* within a few seconds; nothing is left running.
- **A row starts at `PreInvocation`** (before a model call), not `SessionStart`. `PreInvocation`,
  `PostInvocation` and `PostToolUse` keep it *working* (they fire many times per turn and are
  throttled); `Stop` marks it *done*. A turn that ends with **no** event — an interrupt, or a headless
  run that auto-denies a permission and exits — is settled by the watchdog: the row ends as soon as
  the process that ran the hook (`agy`, or the app's helper) is gone, and is marked done once
  Antigravity's own conversation index records the run as idle after the row's last event. The
  30-quiet-minute reap stays as the last resort.
- **The title is Antigravity's own conversation title**, one field read with the system `sqlite3`,
  read-only, from `conversation_summaries.db` in `~/.gemini/antigravity` (desktop) or
  `~/.gemini/antigravity-cli` (`agy`). It exists only after the first turn completes; until then the
  row is named after the first prompt, read from the first line of that conversation's transcript,
  and failing that after the workspace folder.
  The model badge is the payload's `modelName`.

To remove it:

```sh
node ~/.nomo/plugin/scripts/antigravity-install.mjs --uninstall
```

which deletes only the `"nomo"` block and the `nomo` plugin folder Nomo installed. Pairing is untouched.

## Answering from your phone

When a session stops for a **permission prompt** or a multiple-choice **question**, the card reaches
the phone with its options; the answer rides back inside the same E2E-encrypted blob, so the relay
never learns what you chose. Works for Claude Code, Codex, OpenCode and Antigravity (Antigravity:
Allow/Deny on shell commands and file writes; Cursor is read-only).
`/nomo-cc:approvals` (or `$nomo-approvals`, `/nomo-approvals` in OpenCode and Antigravity) is the local off switch when your
phone is away — one switch, machine-wide.

Only sessions your phone is actually showing are answerable, and a hold is **fail-open**: a
network error, timeout or unpaired state before the hold is granted drops straight to the terminal
dialog; once it is granted, a failed poll only counts as a miss, and ~5 min of consecutive misses
gives up the same way. While the relay is reachable the hold has no ceiling of its own — it waits
until the phone answers, the request is expired or superseded server-side, or the hook process is
killed (Esc at the terminal, or the agent's own hook timeout). Nomo can delay a decision; it can
never make one for you. Details:
[docs.nomo.gg/sessions/approvals](https://docs.nomo.gg/sessions/approvals).

**"Always allow (this session)" stays in this session.** Claude Code suggests narrow rules for an
always-allow (for example `Bash(bun test:*)`) and often marks them to be saved to
`.claude/settings.local.json`. Nomo keeps the allow rules, extra directories and mode switches CC
suggested and rewrites every one to `destination: "session"`, dropping deny rules and the
`bypassPermissions` / `dontAsk` modes, so a tap on the phone never writes to a settings file and the
grant ends with the session. It never widens CC's suggestion: the whole-tool rule (for example plain
`Read`) is used only when CC suggested nothing at all; if everything CC suggested was dropped, the
tap is a one-time allow.

**Shell cards keep the command.** The one-line description on a shell approval is written by the
model, so Nomo treats it as a caption: it is kept short, and when the card runs out of room the
description is dropped before the command is.

## Hooks on your computer — security

- **Antigravity: status hooks observe only, except to end a turn you interrupted; the approval hook
  can only defer, approve what you approved, or deny what you denied (or interrupted).** Nomo's
  `"nomo"` block in `~/.gemini/config/hooks.json` answers every status event with `{}` before running
  anything, so those can neither stop a tool nor keep or end a turn — except `PostInvocation`, whose
  wrapper prints `{"terminationBehavior":"terminate"}` only when the bundle printed exactly that line
  (anything else is `{}`), and the bundle prints it only after consuming a fresh interrupt flag the
  watchdog wrote for that conversation from an `interrupt-session` command sealed by your paired phone
  (decrypted, fresh, never replayed, naming a session this computer tracks). The same flag makes the
  approval hook answer `deny` ("Stopped from phone"). Its one `PreToolUse` entry is matched only to
  shell commands and file writes/edits.
  Antigravity treats a failing `PreToolUse` hook as a block, so `antigravity-approve.sh` checks the
  hook's output against the only three replies Nomo sends (`allow`, `auto_approve`, `deny` with a
  reason) and answers `{"decision":"allow"}` — Antigravity's own permission settings and prompt — for
  anything else: a crash, no runtime, empty or malformed output, a missing script (the registered
  command answers by itself), or a hold still running when its internal kill guard fires, which is
  before the hook's 24-hour timeout. If Antigravity signals or kills the hook mid-hold, the wrapper's
  trap and the bundle's own parent check end the hold, withdraw the phone's card and leave no process
  behind. `auto_approve` is sent only for an Allow sealed by your paired phone for that exact request
  id, and never for a call one of your own `deny` rules may match: such a call is not sent to the
  phone at all (Deny > Ask > Allow). Nomo never sends `permissionOverrides`, `overwrite` or a changed
  tool input. The
  approval hook reads the tool name, the command (`CommandLine`) or file path, and the model's one-line
  `toolSummary`, puts them in the end-to-end encrypted card, and reads your `permissions` rules from
  `settings.json` in that conversation's Antigravity data dir (both CLI and desktop dirs when the
  transcript does not say which), read-only. From each status event's stdin
  it reads only
  `conversationId`, the first `workspacePaths` entry, `transcriptPath` (its modification time, for
  the idle check, and its first line for the first prompt) and `modelName` — never tool arguments.
  From Antigravity's `conversation_summaries.db` it reads only the `title`, `status` and
  `last_modified_time` of that one conversation, read-only; the conversation id must be UUID-shaped
  before it is put into the query, and only the two Antigravity data dirs are ever read. Remove it with
  `node ~/.nomo/plugin/scripts/antigravity-install.mjs --uninstall` (deletes only that block and the
  marked plugin folder). The `/nomo-*` skills run only Nomo's own local commands (pair, status, the
  approvals switch, reset, unpair) from the checkout, each behind Antigravity's own run-command
  prompt; they never print the pairing link or QR secret.

- **Your project's runtime config is never loaded into Nomo's hooks.** Hooks run with your project as
  their working folder, and bun reads `bunfig.toml` (whose `preload` runs code) and `.env` files from
  the working folder at startup. Whenever the runtime is bun, Nomo starts it with
  `--config=/dev/null --env-file=/dev/null`, which turns both off; the same goes for processes Nomo
  starts itself (the watchdog). Node.js reads neither file and is
  started as-is. The working folder is left alone, so version managers (asdf, mise, proto, nodenv) that
  pick the runtime from it keep working.
- **Only installed copies of Nomo are launched.** The version-stable hook shim runs the copy that last
  ran, or the newest installed copy in the Claude Code / Codex plugin cache. It never runs code from a
  marketplace you added but did not install.
- **Runtime floor.** bun before 1.4.4 and Node.js 22 before 22.23.4 are affected by CVE-2026-111497
  (brotli decompression). `/nomo-cc:status` (and `$nomo-status`, `/nomo-status`) and the
  `nomo-ai` installer print a warning naming the runtime and how to upgrade (`bun upgrade`). It is
  only a warning: hooks keep running.

## How it works

- **Pairing.** `pair` opens a themed browser page with a QR code and a one-time code; it derives a
  per-pairing E2E key from the QR-scanned secret (or the typed code, via PBKDF2) + the phone's nonce
  (HKDF-SHA256), and writes `~/.config/cc-status/config.json` (mode `0600`) with the pairing id,
  the PC secret, and the 32-byte key. Nothing is copied by hand.
- **Hook.** On every Claude Code / Codex / Cursor lifecycle event the hook (`cursor-status` for
  Cursor) plans a v2 op (`start` / `update` / `done` / `end` with a `working` / `needsAttention` /
  `done` status), encrypts the payload, and POSTs the blob to the relay Worker, which pushes it to
  the phone via APNs.
- **Resident module (OpenCode).** No hooks and no one-shot processes: a single module runs inside
  OpenCode's own server process and reduces its event firehose into the same frames. Because it is a
  guest in the user's editor, it must never throw, block, print, or install process-wide signal
  handlers — see the landmine notes in `src/opencode/plugin.ts` and `src/opencode/approvals.ts`.
- **Liveness watchdog.** Closing a terminal kills the agent without a clean end event, so a session
  could otherwise show "working" forever. Each event records `sessions/<id>.json` with the agent's
  pid; a single detached `cc-watchdog.mjs` polls every 5 s and POSTs a corrective `end` once that
  pid is dead (Codex interrupts are detected from the rollout transcript). It also settles the
  hook's undelivered-update debt: a record the hook marked `updatePending` is re-sent on the next
  sweep with a 5 s POST timeout, backing off 5 s → 60 s after a failure and held back while an
  approval hold is live. When no sessions remain it lingers, while paired, up to 30 min
  (`IDLE_GRACE_MS`) before exiting; the next hook re-spawns it.
- **LAN fast path.** When the phone is on the same network, the watchdog hosts a tiny local HTTP
  listener so commands and answers travel direct (<200 ms) instead of waiting to be piggybacked on
  the next relay response (~5–12 s). It is strictly additive: the relay leg runs in parallel and
  stays canonical, so every LAN failure collapses into "the relay wins", never a lost command. The
  envelope carries a **second** seal (`K_lan`, HKDF-derived from the pairing key) so nobody on the
  Wi-Fi can read even the metadata, and a relay ciphertext simply won't open on the LAN channel.
  Off by default — turn it on in the Nomo app.
- **Encryption boundary.** The Worker only ever sees ciphertext; decryption happens on the phone
  (and, for the Live Activity, in the widget at render time). The agent marker is inside the blob,
  so even the fan-out relay can't tell one agent from another.

State lives under `~/.config/cc-status/`. Set `NOMO_WORKER_URL` to point at a staging Worker at
pair time; leave it unset for the default.

## Development

The portable TypeScript sources live in `src/`, grouped into `entries/` (the bundled
entrypoints), `core/` (shared leaf modules — paths/config, E2E crypto, the hook op planner, the
agent adapters), `opencode/` (the resident OpenCode module), and `qr/` (the vendored QR encoder). All
are written to run unmodified under **bun and node ≥ 18** — no `Bun.*` runtime APIs, no npm
dependencies.

### Tests

```
bun test
```

Runs the full suite (2011 tests across `core/`, `entries/`, `opencode/`, and `qr/`).

### Building the plugin bundle

```
bun build.ts
```

`build.ts` bundles the thirteen hook/command entrypoints (`cc-status`, `cc-permission`, `codex-status`,
`codex-permission`, `codex-notify`, `cc-watchdog`, `pair`, `unpair`, `reset`, `status-cmd`,
`opencode-update`, `cursor-status`, `antigravity-status`) into
`plugin/dist/*.mjs`, inlining every local import so each artifact is a single node-runnable file.

A second pass bundles `src/opencode/plugin.ts` into `plugin/dist/opencode.js` — **`.js`, not
`.mjs`**, because OpenCode discovers plugins with the glob `{plugin,plugins}/*.{ts,js}` and would
never see a `.mjs`. It is the one resident module (no hooks, no shim, no one-shot processes), which
is why it has no `hooks.json` entry and no `hook-shim.sh` whitelist row.

The OpenCode slash commands are **templates**, not built artifacts: `plugin/opencode-commands/*.md`
(filename = command name) each carry a `__NOMO_ROOT__` placeholder, and
`plugin/scripts/opencode-install.sh` substitutes the resolved plugin path as it copies them into the
user's `commands/` directory. Baking the path in is unavoidable — OpenCode gives a command file no
equivalent of Claude's `${CLAUDE_PLUGIN_ROOT}` and no `plugin list` to recover it from, the way the
Codex skills do. Add a command by dropping another `.md` in that directory; the installer picks it
up with no code change.

`plugin/dist/` **is committed to the repo.** Marketplace installs are a plain `git clone` of this
repository — there is no CI build step, and the `nomo-ai` npm package ships only the installer, not
the bundle — so the committed `dist/` is what actually runs. Re-run `bun build.ts` after any source change so `dist/` stays reproducible from source, and
commit the regenerated bundles. The committed bundle was built with `bun 1.3.14`; use the same
major/minor to reproduce it byte-for-byte.

### Releasing

The plugin version is written in **manifests that must move together** — a release that bumps all
but one installs a stale version somewhere. The current number is deliberately NOT repeated in this
sentence: `build.ts` cross-checks the JSON manifests against each other, never prose, so a version
written here goes stale silently with nothing to catch it (it had already drifted to 2.1.5 while the
manifests said 2.1.7). The manifests are the source of truth; read them.

- `.claude-plugin/marketplace.json` (Claude Code marketplace)
- `.agents/plugins/marketplace.json` (Codex marketplace)
- `plugin/.claude-plugin/plugin.json` (`nomo-cc`)
- `plugin/.codex-plugin/plugin.json` (`nomo`)
- `package.json` (the `nomo-ai` npm bootstrapper)

OpenCode has no manifest — it installs from the checkout, so the checkout is its version. That is
what makes `/nomo-update` a `git pull`, and what makes these manifests the number it reports.

`bun build.ts` cross-checks all five and refuses to build on disagreement. `package.json` carries the
version only so `bunx nomo-ai --version` is quotable in a bug report; it ships no plugin code. The
npm publish is a separate manual step — `npm pack --dry-run` first: the tarball is `bin/` plus the
three files npm always adds (`package.json`, `README.md`, `LICENSE`), and nothing else.

## License — MIT

Released under the [MIT License](LICENSE). © 2026 KarrixLee.
