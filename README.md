<p align="center"><img src="assets/icon.png" width="120" alt="Nomo"></p>

# Nomo — Live Activity on your iPhone

<p align="center">
<img src="assets/claude.png" height="26" alt="Claude Code">&nbsp;&nbsp;
<img src="assets/codex.png" height="26" alt="OpenAI Codex">&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="assets/opencode-dark.png"><img src="assets/opencode-light.png" height="26" alt="OpenCode"></picture>&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="assets/cursor-dark.png"><img src="assets/cursor-light.png" height="26" alt="Cursor"></picture>&nbsp;&nbsp;
<img src="assets/antigravity.png" height="26" alt="Antigravity">&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="assets/devin-dark.png"><img src="assets/devin-light.png" height="26" alt="Devin"></picture>&nbsp;&nbsp;
<img src="https://img.shields.io/badge/License-MIT-blue" alt="License: MIT">
</p>

<p align="center">
<a href="https://apps.apple.com/app/nomo-ai-status-usage/id6779366830"><img src="assets/app-store-badge.svg" height="48" alt="Download Nomo on the App Store"></a>
</p>

Nomo mirrors your **Claude Code**, **OpenAI Codex** (CLI and desktop app), **OpenCode**, **Cursor**,
**Antigravity** and **Devin** sessions to the Nomo iPhone app as a Live Activity — working, needs you,
done — and lets you answer permission prompts and questions from the phone. Everything is end-to-end
encrypted; one pairing covers every agent on a computer.

This README is the **technical and security reference**. How to install, pair, use the commands,
update and uninstall lives at **[docs.nomo.gg](https://docs.nomo.gg)**.

> [!NOTE]
> Developed and tested on **macOS** and **Linux**. **Windows is untested** (the hooks are pure Node
> built-ins, but nothing has been verified there), so treat it as unsupported.

## Security at a glance

- **End-to-end encrypted.** Every session update is sealed with **AES-256-GCM** on your computer and
  opened only on your iPhone. The key comes from pairing (QR secret or six-word code, then a per-pairing
  ephemeral **ECDH P-256** exchange) and never passes through a server. [Encryption](#encryption)
- **The relay is blind.** The Cloudflare Worker that forwards pushes sees routing metadata only — never a
  title, machine name, status text, command or answer. The one thing it sees in the clear is the
  once-a-minute presence ping: which agents have a turn open, and whether one is waiting for approval.
  A free (not Pro) pairing sends only that ping and the sealed daily activity summary, except that after
  a quiet spell the first prompt's requests still go out (end-to-end encrypted, as always) and are refused.
  [What leaves your computer](#what-leaves-your-computer)
- **No telemetry, no credentials.** The plugin's only network peer is that relay (`https://api.nomo.gg`
  by default). It never reads your agents' API keys or logins, and has no analytics. The installer and
  `/nomo-update` also run `git` against `github.com/KarrixLee/nomo`. [Network](#network)
- **Hooks can only do what you answered.** A phone Allow, Deny or answer is acted on only when it is
  sealed by your paired phone for that exact request. Every failure — unpaired, offline, timeout,
  crash — **fails open** to the agent's own prompt. Nomo can delay a decision; it never makes one for
  you, except auto-approving its **own** status commands, matched byte for byte. Nomo's own pair,
  unpair, reset and uninstall commands always ask.
  [Hooks security](#hooks-security)
- **Local files are owner-only.** Pairing keys and session records live in `~/.config/cc-status/`,
  written `0600`. Every file Nomo writes into an agent's config is listed below, and the installers
  merge rather than overwrite. [Files on your computer](#files-on-your-computer)
- **Unpair revokes the pairing on the server** and deletes the local keys (even when the server is
  unreachable); uninstall removes only Nomo's own entries. Steps: [docs.nomo.gg/sessions/commands](https://docs.nomo.gg/sessions/commands).
- **Open source (MIT), zero npm dependencies.** The bundles in `plugin/dist/` are what runs, committed
  and reproducible from `src/`. [Development](#development)

## Install

```sh
bunx nomo-ai     # or: npx nomo-ai
```

It detects which agents are on this computer and installs Nomo for each through that agent's own
install path (`--claude` `--codex` `--opencode` `--cursor` `--antigravity` `--devin` pick agents;
`-n` prints the plan and runs nothing). Installing never pairs your phone and has no `postinstall`
hook; pairing is the separate, explicit `nomo pair` (or the pair command inside your agent). Devin
can instead use the plugin: `devin plugins install KarrixLee/nomo`. The three agent config files it
merges into directly are undone with `nomo uninstall --cursor`, `nomo uninstall --antigravity` and
`nomo uninstall --devin` (also spelled `--uninstall`; the same as
`node ~/.nomo/plugin/scripts/<agent>-install.mjs --uninstall`). An agent flag is required. For Claude
Code, Codex and OpenCode, uninstall only prints the host's own removal command.

**Commands**, from any folder, for any agent:

```sh
nomo pair       # pair with your phone (QR page, then waits for the scan); `pair code` for the typeable code
nomo status     # is this computer paired, and is each agent set up
nomo reset      # clear stuck sessions and send your activity summary now
nomo unpair     # disconnect this computer from your phone (every agent on it)
nomo uninstall --cursor   # remove Nomo from an agent you name
```

They run the same plugin code as the in-agent commands (`/nomo-cc:pair`, `$nomo-reset`, `/nomo-status`,
…), and pairing, sessions and the watchdog are shared by every agent on a computer, so one `reset` or
`pair` here covers all of them.

**Short `nomo` command.** The installer also adds a short `nomo` command (`bun add -g nomo-ai`, or
`npm install -g nomo-ai` when not run from bun; no `sudo`), so `nomo pair`, `nomo status`, … work from
any folder; pass `--no-global` to skip it, and remove it with `bun remove -g nomo-ai` (or
`npm uninstall -g nomo-ai`). Without it, every command works the same as `bunx nomo-ai pair`,
`bunx nomo-ai status`, … Never type `bunx nomo` or `npx nomo`: the npm package named `nomo` is
someone else's.

The full guides live at [docs.nomo.gg](https://docs.nomo.gg):

| | |
| --- | --- |
| **Get started** | [Install](https://docs.nomo.gg/setup/install) · [Pair your iPhone](https://docs.nomo.gg/setup/pairing) |
| **Everyday use** | [Answer from your phone](https://docs.nomo.gg/sessions/approvals) · [Commands, update and uninstall](https://docs.nomo.gg/sessions/commands) |
| **Each agent** | [Codex](https://docs.nomo.gg/sessions/codex) · [OpenCode](https://docs.nomo.gg/sessions/opencode) · [Cursor](https://docs.nomo.gg/sessions/cursor) · [Antigravity](https://docs.nomo.gg/sessions/antigravity) · [Devin](https://docs.nomo.gg/sessions/devin) |
| **Help** | [Troubleshooting](https://docs.nomo.gg/sessions/troubleshooting) |

## Architecture

Pairing establishes **one shared key** that only your phone and computer hold. It can be handed over
two ways, both keeping it off every server:

- **Scan the QR** on the local pairing page. The QR carries a random pairing secret that exists only in
  the code image; the phone mixes it with its own nonce (HKDF-SHA256).
- **Type the one-time code** — six words and a channel number (e.g.
  `7-ocean-sunset-mango-river-atlas-cabin`). The phone runs PBKDF2-SHA256 over the words to rebuild the
  same secret, then the same HKDF step. The words never leave the pairing page; the channel is a
  one-time routing handle that burns on first use and expires in 10 minutes.

The plugin seals every update before it leaves the machine; the relay Worker and Apple's push service
carry ciphertext only, and the iPhone decrypts (for the Live Activity, in the widget at render time).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.png">
  <img src="assets/architecture-light.png" alt="End-to-end encryption architecture: hooks on your computer feed the nomo plugin, which encrypts with a key shared only at pair time — by scanning the QR or typing the one-time code, never through a server; the Cloudflare Worker relay and APNs carry ciphertext they cannot read; your iPhone decrypts on device and renders the Live Activity.">
</picture>

<sub>Diagram source: [`assets/architecture.excalidraw`](assets/architecture.excalidraw) — open it at [excalidraw.com](https://excalidraw.com) to edit.</sub>

### The pairing code is never printed

By default the one-time code is shown **only on the pairing page** (a local `file://` page, `0600`,
with no fonts, remote images, analytics or CDN), behind "Tap to reveal code". It is never printed to the
terminal, so it cannot land in shell history, a screen recording or an AI transcript. `pair.mjs
--show-code` (the `pair code` form of each agent's pair command) is the deliberate opt-out for a
headless or SSH-only box: it prints the code to stdout, where it is sensitive for the ~10 minutes it is
valid. The page is deleted when pairing completes.

## Encryption

- **AES-256-GCM** seals every session update, approval card and answer. The relay can route by pairing
  id but cannot read a field.
- **Six BIP39 words (~66 bits)**, stretched with **PBKDF2-SHA256 at 600,000 iterations** (salted with
  the pairing id), put an offline brute-force of the code — what a logging relay could try against the
  known-plaintext pairing blob — out of reach.
- **Forward secrecy via a per-pairing ephemeral ECDH (P-256) ratchet.** The QR secret or code only
  bootstraps a handshake key. Computer and phone each generate a throwaway keypair, do an ECDH, and mix
  the result with the bootstrap key into the key that encrypts your sessions; the throwaway private
  keys are discarded after pairing. A code leaked **after** pairing cannot decrypt anything, and mixing
  it into the handshake means a relay that swaps the public keys (man-in-the-middle) makes pairing
  fail rather than succeed under its key. Only public keys transit the relay in the clear.
- **Each sealed update names its own session.** The session id travels in the clear for routing, so
  the sealed blob repeats it (`sid`). The app treats a blob whose sealed `sid` differs from the session
  it is listed under as unreadable, so a relay cannot relabel one session's update as another's and
  steer an approval or interrupt onto the wrong session. (Plugins older than this send no `sid`; their
  updates are still shown.)
- **LAN fast path has its own seal.** Local-network traffic is sealed under `K_lan` =
  HKDF-SHA256(pairing key, info `nomo-lan-v1|<pairing id>`), so nobody on the Wi-Fi can read even the
  metadata, and a relay ciphertext will not open on the LAN channel (or vice versa).
  See [LAN fast path](#lan-fast-path).

## What leaves your computer

### Network

| Destination | When | What |
|---|---|---|
| Relay Worker (`https://api.nomo.gg`, or `NOMO_WORKER_URL` at pair time) | every session event; approval holds; pairing; unpair; the activity summary; presence about once a minute while an agent session is open | `/v1/cc/event`, `/v1/cc/decision*`, `/v1/cc/full`, `/v1/cc/pair/*`, `/v1/cc/presence` |
| Your iPhone, on the same network (only if LAN is turned on in the app) | commands and answers | `POST /v1/lan`, sealed under `K_lan` |
| `github.com/KarrixLee/nomo` via `git` | `bunx nomo-ai` (OpenCode, Cursor, Antigravity, Devin legs) and `/nomo-update` | clone / fetch / pull of this repo |
| The npm registry, via your package manager | `bunx nomo-ai`, for the short `nomo` command (skip with `--no-global`) | `bun add -g nomo-ai` or `npm install -g nomo-ai` |

Nothing else: no analytics, no crash reporting, no reads of agent credentials.

**In the clear to the relay** (needed to route and authenticate): the pairing id and the computer's
pairing secret (headers), the plugin version, whether remote approvals are on, and per event the
session id, the op (`start` / `update` / `done` / `end`), a priority, timestamps, and — for a Codex
`request_user_input` question only — `attentionKind: "userInput"`. **Sealed**: everything else —
title, machine name, folder, status, model, tool name, command, file path, plan text, questions,
answers, and which agent produced the event. The diff on an edit approval (patch or edit content,
line counts) is sealed the same way as a command, in the card and in a full-text pull. For an
overwrite (a whole-file write onto an existing file) the plugin reads that file from disk — a regular
UTF-8 text file up to 2 MiB, never a device, FIFO or directory — so the diff also carries the current
file's changed lines.

**Daily activity summary — counts only, sealed.** While paired, the watchdog reads your agents' local
history read-only — Claude Code transcripts (`~/.claude/projects`), Codex rollouts and its
`state_5.sqlite` / `thread_history_1.sqlite`, OpenCode's `opencode.db` — and builds one row per day per
agent: session count, prompt count, which 5-minute slots had activity, and token totals per model. It
**never** puts prompt or reply text, project names or paths into the summary. Rows are kept in
`~/.config/cc-status/activity-days.json` (at most 400 days) and, at most every 6 hours and only when
changed, sealed and uploaded to `/v1/cc/full` (`what: "activity"`); right after pairing a new phone the
existing rows go up once within about a minute, and after a plugin update new rows go up at the next
scan instead of waiting the 6 hours. To send it right away, run `nomo reset` (or reset inside your
agent: `/nomo-cc:reset`, `$nomo-reset`, `/nomo-reset`): it scans and uploads once, then says whether it
was sent. The relay cannot read them and deletes them after
**35 days**. The summary carries a random per-computer id (`mid`) so the phone does not count a
computer twice — a UUID made once and kept in `~/.config/cc-status/machine-id` (owner-only), **never**
derived from serial, MAC, hostname or user name; delete the file for a new one.

**Presence — two fields, every pairing.** About once a minute while the watchdog runs (an agent session
is open), the plugin POSTs `/v1/cc/presence` with exactly `{ "coding": [agent ids], "waiting": true|false }`:
which agents (`claude`, `codex`, …) have a turn open, and whether any session is waiting for an
approval. No session id, title, folder, command or text. It is not sealed (the relay keeps it about 3
minutes so the phone can show "Claude is coding"), and the reply tells the plugin whether the pairing is
Pro.

**Free pairing (not Pro) — only presence and the activity summary leave the computer.** When the relay
says a pairing is not Pro (the presence reply, or a 403 `{"error":"entitlement suspended"}` on any
session route), the plugin writes `~/.config/cc-status/free-mode` and, while it is fresh (15 minutes,
refreshed by each presence reply), sends **no** session events, opens **no** approval holds (every prompt
goes straight to the agent's own dialog), uploads **no** plan or permission text, and keys the LAN
listener off. Sessions are still tracked on disk so presence stays accurate. After a quiet spell (15
minutes with no presence reply) the marker has expired, so the first prompt's sealed requests go out (one
event; on a permission prompt also the full text and the approval request), the relay refuses them and
stores nothing, and free mode resumes. The LAN listener does not come back when the marker expires: it
stays keyed off until the relay says the pairing is Pro (a presence reply, or an accepted session
request), which deletes the marker. A 403 is never treated as an unpair (only a 404/410 is), and neither
is a `409` (a pairing the relay has not seen claimed yet): a session event is retried later, and a
prompt's approval request falls open to the agent's own prompt, as on any other relay error.

**On the iPhone,** the Live Agents widget (Nomo Pro) reads a snapshot of decrypted titles, states and
computer names from the app's own App Group container. It never leaves the device.

### Files on your computer

| Path | What | Written by |
|---|---|---|
| `~/.config/cc-status/config.json` (`0600`) | pairing id, computer secret, 32-byte key; deleted by unpair (after a server revoke) | pair |
| `~/.config/cc-status/sessions/*.json` (`0600`) | one record per live session (agent pid, last sealed blob) | hooks, watchdog |
| `~/.config/cc-status/sessions/<id>.devin-allow` (owner-only) | Devin "Always allow (this session)" grants; deleted by unpair, reset and pairing again | Devin approval hook |
| `~/.config/cc-status/sessions/<conv>.<id>.agy-inbox` (owner-only) | queued Antigravity phone replies, deleted after a day | watchdog |
| `~/.config/cc-status/hook-shim.sh` (`0700`) | version-stable hook launcher | `run.sh`, pair |
| `~/.config/cc-status/activity-days.json`, `machine-id` | activity summary, per-computer id | watchdog |
| `~/.config/cc-status/free-mode` | time the relay last said this pairing is not Pro (counts for 15 minutes for sending; keeps the LAN listener off until the relay says Pro) | hooks, watchdog |
| `~/.config/cc-status/short-command` | `1` or `0`: whether the short `nomo` command is installed, so status and reset name `nomo …` or `bunx nomo-ai …` | `bunx nomo-ai` |
| `~/.config/cc-status/*-trace.log` (`0600`) | local diagnostics; never uploaded | hooks, watchdog |
| `~/.codex/config.toml` | Codex `notify` backstop (your existing `notify` is chained, mode kept, one-time `config.toml.bak-nomo`); refuses an unparseable `notify` line | Codex pair |
| `~/.config/opencode/plugins/nomo.js`, `commands/nomo-*.md` | OpenCode stub + commands | `opencode-install.sh` |
| `~/.cursor/hooks.json` (merged), `~/.cursor/skills/nomo-*/` | Cursor hooks + skills (`$CURSOR_CONFIG_DIR` if set) | `cursor-install.mjs` |
| `~/.gemini/config/hooks.json` (`"nomo"` block), `~/.gemini/config/plugins/nomo/` | Antigravity hooks + plugin | `antigravity-install.mjs` |
| `~/.config/devin/config.json` (`"hooks"` key, merged), `~/.config/devin/skills/nomo-*/` | Devin hooks + skills | `devin-install.mjs` |
| `~/.nomo/` | git checkout of this repo (OpenCode, Cursor, Antigravity, Devin installer) | `bunx nomo-ai` |

Claude Code and Codex install through their own marketplaces; Nomo writes nothing into `~/.claude` or
`~/.codex` except the Codex `notify` line above. `NOMO_CC_DIR` (testing only) moves the state folder;
real installs never set it, and anything that can set your agent's environment could already change
`HOME`.

## Hooks security

<a id="hooks-on-your-computer--security"></a>

### Approval holds (all agents)

- **Only sessions your phone is showing are answerable.** The hook holds the agent's prompt while the
  phone shows the card; the answer rides back sealed, so the relay never learns what you chose.
- **Fail-open.** A network error, timeout or unpaired state before the hold is granted drops straight
  to the agent's own dialog. Once granted, a failed poll counts as a miss; ~5 minutes of consecutive
  misses gives up the same way. While the relay is reachable the hold has no ceiling of its own — it
  waits until you answer, the request expires or is superseded server-side, or the hook is killed (Esc
  at the terminal, or the agent's hook timeout).
- **Approvals switch.** One machine-wide flag pauses remote approvals for every agent; prompts then go
  straight to the computer.
- **Free pairings never hold.** While the pairing is not Pro (see
  [What leaves your computer](#what-leaves-your-computer)) every prompt goes straight to the agent's own
  dialog, exactly like the paused switch, and nothing is posted.
- **Shell cards keep the command.** The model-written one-line description is a caption: shortened
  first, and dropped before the command when space runs out.
- **The "Always allow" label is display-only.** At hold time the plugin seals what an Always-allow tap
  would grant into the card as `permissionGrant`: structured data, never prose, so the phone builds the
  label in its own language. Format: `""`, or one or more entries joined by `\n`, each `kind` or
  `kind:literal` (the literal is everything after the first `:`, has no control characters, is capped at
  80 characters, and the phone shows it verbatim in monospace, never as Markdown). Kinds: `cmd:<prefix>`
  (commands starting with it, or a Claude Code rule with a `*` wildcard shown as written), `exact` (this
  exact command), `domain:<host>`, `edit:<glob>`,
  `dir:<path>` (one folder), `dirs:<N>` (N folders), `edits`, `reads`, `fetches`, `searches`, `commands`
  (every one of that kind), `planmode`, `automode`, `plans` (plan approvals), `tool:<tool id>` (the whole
  tool) and `similar` (a rule the plugin can't name; also how the phone shows a kind it doesn't know).
  Any unnamed part, or a value over 240 characters, collapses to `similar`, never a shorter list. It is
  built from the same input as the answer: Claude Code's own suggestions (after the filter below),
  OpenCode's `always` patterns, or Devin's Nomo-side grant rule. `""` means the tap would only be a
  one-time allow, and the phone hides the option; absent (Codex, Antigravity, questions, older plugins)
  means unknown. It only labels the button: the rule itself is still decided and enforced by the agent.
- **Claude Code Computer Use** app-access dialogs fire no answerable hook, so the phone shows a sealed
  heads-up naming the apps with no Allow/Deny; approve it on the computer.

### Claude Code hooks

- Wired by the plugin's `hooks.json` (no `settings.json` edits). Status hooks are silent: unpaired → no-op;
  relay down → 2 s POST timeout, exit 0. They cannot affect the session.
- `PermissionRequest` (timeout 24 h) is the only hook that answers. **"Always allow (this session)"
  stays in this session:** Claude Code often marks its suggested rules (e.g. `Bash(bun test:*)`) to be
  saved to `.claude/settings.local.json`; Nomo keeps the allow rules, extra directories and mode
  switches it suggested, rewrites every one to `destination: "session"`, and drops deny rules and the
  `bypassPermissions` / `dontAsk` modes. A phone tap never writes a settings file and the grant ends
  with the session. It never widens the suggestion: the whole-tool rule (e.g. plain `Read`) is used only
  when nothing was suggested; if everything suggested was dropped, the tap is a one-time allow.
- Inside Devin (which also runs `~/.claude` hooks), Nomo's Claude Code hooks stand down, so a Devin
  session is never a Claude Code row and never answered by them.

### Codex hooks

- The ten hooks ship in `plugin/hooks/codex-hooks.json` and stay **inert until you trust them** in
  Codex's `/hooks` review — Codex's own gate, which Nomo cannot pre-approve. The command lines are
  byte-stable across releases, so a trust holds through updates.
- `PermissionRequest` (timeout 1 h) is the answering hook; status hooks are fail-silent like Claude
  Code's. Pairing also chains a `notify` backstop into `~/.codex/config.toml` (see
  [Files](#files-on-your-computer)).

### OpenCode plugin

- One resident module inside OpenCode's server process; it must never throw, block, print or install
  process-wide signal handlers. It answers `permission.asked` (Allow / Always / Deny) and
  `question.asked`. **Always** is OpenCode's own `always` reply: it allows the request's `always`
  patterns (e.g. `git status *`, or `*` for every edit) for that project **until OpenCode restarts**,
  across its sessions — OpenCode keeps the rule in memory, never on disk.
- `/nomo-update` acts only on Nomo's own checkout: the stub's target must be an absolute
  `<checkout>/plugin/dist/opencode.js` and the checkout's `origin` must be this repo on github.com
  (`https://`, `ssh://` or `git@github.com:`), or it refuses before running anything there.
  `bunx nomo-ai` updates global scope only, from your home directory, so the folder you run it in can
  never pick the checkout.
- `opencode-install.sh` refuses to overwrite a same-named file it did not write (`--force` overrides).

### Cursor hooks

- **Read-only by construction.** Eight events, **no permission hook**; the hook prints nothing and
  always exits 0, so it cannot allow, deny or redirect anything. `beforeSubmitPrompt` is awaited by
  Cursor, so a prompt can be **delayed** by one HTTPS request — at most ~2 s when the relay is
  unreachable.
- **`hooks.json` is merged, never clobbered.** The installer refuses before writing if the file is not
  valid JSON of the expected shape, is a dangling symlink, has more than one hard link, or it or the
  skills directory is not writable; if a same-named skill it did not write exists (`--force`
  overrides); if the Cursor config directory is missing; or if `plugin/dist/` is not built. A live
  symlink is written through. It appends an entry only if that exact entry is absent, adds
  `"version": 1` only if missing, and never edits, reorders or removes an entry it did not write — an
  entry is Nomo's only if it is on one of its eight events, its command is exactly Nomo's two quoted
  paths under one checkout, and it has no keys besides `command` and `timeout`. A changed file is
  re-serialised as 2-space JSON (entries, key order and positions kept); an unchanged file is not
  rewritten. Writes are atomic (temp + rename) with the file's existing mode, re-reading just before
  the rename so another tool's concurrent write is merged. A checkout path containing `'`, `"`, `$`,
  `\` or a backtick is refused. Uninstall removes exactly Nomo's entries and skills.
- The account email in Cursor's hook payloads is never read and is in no frame, record or log.

### Antigravity hooks

- **Status hooks observe only, except to end a turn you interrupted or hand over a message you sent.**
  Nomo's `"nomo"` block answers every status event with `{}` before running anything — except
  `PostInvocation`, whose wrapper prints `{"terminationBehavior":"terminate"}` only when the bundle
  printed exactly that, which it does only after consuming a fresh interrupt flag the watchdog wrote
  from an `interrupt-session` command sealed by your paired phone (decrypted, fresh, never replayed,
  naming a session this computer tracks).
- **Phone replies** take the same path: a sealed `send-message` command (same gates, a message id, at
  most 4,000 characters, no control characters but line breaks) becomes one owner-only `.agy-inbox`
  file. Only while such a file exists for the hook's own conversation do `PreInvocation` and `Stop` run
  in the foreground (capped at 4 s; the wrapper stops waiting at the bundle's first line, before any
  network call) and the wrapper prints that line only if it is exactly
  `{"injectSteps":[{"userMessage":"…"}…]}` (PreInvocation) or `{"decision":"continue","reason":"…"}`
  (Stop), else `{}`. A Stop continues at most once a minute, never for a turn your phone is stopping;
  unclaimed messages are deleted after a day. The only process Nomo ever starts for a reply is
  `agy --conversation <id> --print=<message>` (message as one argument, never shell-parsed), for a
  tracked `agy` CLI conversation whose `agy` has exited, in that conversation's folder. `agy` is found
  via `NOMO_AGY_BIN`, else the first **absolute** `PATH` entry holding one, else `~/.local/bin/agy`.
  Nomo never signals the `agy` process.
- **The approval hook can only defer, approve what you approved, or deny what you denied or
  interrupted.** One `PreToolUse` entry, matched only to `run_command`, `write_file`, `write_to_file`,
  `edit_file`, `replace_file_content`, `multi_replace_file_content`. Antigravity treats a failing
  `PreToolUse` hook as a block, so `antigravity-approve.sh` passes through only Nomo's three replies
  (`allow`, `auto_approve`, `deny` with a reason) and answers `{"decision":"allow"}` — "no opinion":
  Antigravity's own settings and prompt — for anything else (crash, no runtime, malformed output,
  missing script, or a hold outliving its internal kill guard, which fires before the 24 h timeout). A
  signal mid-hold ends the hold, withdraws the card and leaves no process. `auto_approve` is sent only
  for an Allow sealed by your paired phone for that exact request id. Nomo never sends
  `permissionOverrides`, `overwrite` or a changed tool input. An interrupt flag makes it answer `deny`
  ("Stopped from phone").
- **Your `permissions` rules come first** (`settings.json` in that conversation's Antigravity data dir;
  both CLI and desktop dirs when unclear; read-only), in Antigravity's order Deny > Ask > Allow. Deny
  and ask rules are read **loosely**: a command rule matches when its command appears anywhere as
  something that runs — after `sudo`/`env`/`xargs`/`timeout`/`watch`/`stdbuf`/`nice`/`nohup`, inside
  `sh -c`/`bash -c`/`zsh -c` or `eval`, after `find -exec`, `then` or `!`, as `/bin/rm`, quoted, behind
  `FOO=1`, after `;`/`&&`/`|`, or inside `$(…)`; a `regex:` rule that does not compile matches
  everything. A call a deny rule may match never reaches the phone, and a phone Allow can never override
  it. File paths are normalized (`..`, `.`, repeated `/`) first. Allow rules are read **strictly**: only
  a single plain command (no separators, subshells, quotes or line breaks) whose words start with the
  rule's passes straight through, and never a write into Nomo's checkout or state folder.
- **One sandbox-retry exception:** after a phone Allow on a shell command, the next call in the same
  conversation and workspace within 90 s whose arguments are identical except `BypassSandbox`, the
  one-line summary and the async wait time (the desktop app's retry outside its sandbox) is answered
  `auto_approve` once, without a new card. Any other difference gets a fresh card; never after a Deny;
  the one-use ticket is a `0600` file in the sessions folder.
- **Own commands:** so that `/nomo-status` doesn't put a card on your phone, the approval hook answers
  `auto_approve` — on a paired computer, after the deny rules and a pending Stop — for exactly four
  command lines rebuilt in code from the template the installer writes the skills from (never read from
  the skill files): status (plain and verbose), approvals status and approvals **on**. Byte-for-byte
  match (one trailing newline forgiven; a second line, a `cd`, `&& …` or other quoting goes to the
  phone). Approvals **off**, pair, the pair wait, reset, unpair and the typed pairing code still ask your
  phone: on a paired computer, pairing again first revokes the current pairing.
- **What it reads.** The approval hook: tool name, `CommandLine` or file path, and the model's
  `toolSummary` (sent sealed). Status events: only `conversationId`, the first `workspacePaths` entry,
  `transcriptPath` (its mtime and first line) and `modelName` — never tool arguments. From
  `conversation_summaries.db`: only `title`, `status` and `last_modified_time` of that conversation,
  read-only; the id must be UUID-shaped before it enters the query, and only the two Antigravity data
  dirs are read.
- **Installer.** Owns exactly the `"nomo"` block in `~/.gemini/config/hooks.json` (rewritten whole;
  other blocks untouched; file created as `{}` if absent; refuses a file that is not a JSON object;
  writes through a symlink). Each registered command first checks its script exists and otherwise
  answers on its own (`{}`, or `{"decision":"allow"}` for `PreToolUse`), so a moved or deleted `~/.nomo`
  never blocks a tool. The plugin folder carries a marker file; an unmarked `nomo` folder is someone
  else's and the installer refuses. The `/nomo-*` skills run only Nomo's own local commands and never
  print the pairing link or QR secret. Uninstall deletes only that block and the marked folder.

### Devin hooks

- **The status hook observes only, except to end a turn you interrupted.** It prints nothing — except
  that after you tap **Interrupt**, its next `PostToolUse` prints
  `{"continue":false,"stopReason":"Interrupted from Nomo"}` (the watchdog writes the flag only for an
  interrupt sealed by your paired phone; the next prompt clears it). From each event it reads only
  `session_id`, `prompt_id`, the event and tool names, the first prompt (for the title) and
  `DEVIN_PROJECT_DIR`; from Devin's `sessions.db` only that session's `title`, `model` and
  `working_directory`, read-only (the id must be a plain slug before it enters the query).
- **The approval hook can only defer, approve what you approved, deny what you denied, or pass on your
  answer.** On `PermissionRequest` it sends the tool name and command or file path sealed, and prints
  `{"decision":"approve"}` only for an Allow sealed by your paired phone for that exact request id
  (`{"decision":"block"}` with your note, or "Denied from phone", for a Deny). On `PreToolUse` it holds
  only `ask_user_question`: questions and options go sealed to the phone, and your answer comes back as
  `{"decision":"block","reason":"The user answered from their phone (Nomo): …"}` — Devin has no way to
  take an answer from a hook, so the model reads the decline reason as your answer and the transcript
  shows the question as rejected. A Deny is a block saying you chose not to answer. **Fail-open:**
  unpaired, approvals paused, session not on the phone, offline, expiry, crash or timeout all print
  nothing, leaving Devin's own prompt. If Devin stops waiting (its timeout, Ctrl-C, session end), the
  hook notices its parent shell is gone, withdraws the card and exits.
- **"Always allow (this session)"** is stored only on this computer in
  `~/.config/cc-status/sessions/<session>.devin-allow` and forgotten when the session ends (or Nomo
  retires its quiet row), and every one is deleted by unpair, by reset, and when you pair again. While it exists, and only
  while this computer is paired, a matching request in that session is approved at once, even with
  approvals paused. A shell grant covers the command's name only for a short list of tools whose
  arguments cannot run code (`ls`, `cat`, `head`, `tail`, `wc`, `touch`, `mkdir`, `grep`, `echo`,
  `pwd`, `which`, `file`, `stat`, `du`, `cut`, `tr`, `jq`), typed as the bare name and with no shell
  operators (`touch` covers `touch b.txt`, not `touchy` or `./touch`). Every other command — shells,
  interpreters, `git`, `make`, `rg`, build tools, agents, `cp`, `rm`, anything with `&&`, `;`, `|`,
  `$(…)`, backticks or a redirect — is covered only by a grant for that exact text: `git status` does not
  cover `git -c core.fsmonitor=… status`, and `touch x && rm -rf ~` still asks. An exact grant re-runs
  that text as-is, in any folder, and does not pin what it runs (`make test` runs whatever the Makefile
  says then). Nomo's own pair, unpair, reset, disable and uninstall commands, and commands naming its
  state folders (`~/.config/cc-status`, `~/.nomo`), are never approved by a grant; quoting tricks are
  normalized, but a glob can still slip past that check (it is the allowlist above that stops one becoming
  a name grant). For any other tool it covers that tool for the session.
- **Own commands:** on a paired computer, before any card, Nomo auto-approves exactly three command
  lines, rebuilt in code and matched byte for byte against what the skills run (the plugin's `/nomo:*`
  and the installer's `/nomo-*` forms, with at most Devin Desktop's `workdir` beside them): status,
  approvals status and approvals **on**. One trailing newline is forgiven; any other difference (`&& …`,
  `;`, `|`, a redirect, a second line, another script or path, an extra argument) goes to the phone.
  Approvals **off**, pair, the pair wait, reset, unpair and the typed pairing code still ask your phone:
  on a paired computer, pairing again first revokes the current pairing.
- **Writes.** Devin's own config files are never written by the hooks. The installer writes only its
  entries in the `"hooks"` key and the marked `nomo-*` skills (which run only Nomo's local commands and
  never print the pairing link or QR secret); a same-named skill of yours is left alone. A
  `config.json` with comments is first copied to `config.json.nomo-backup`, then written back without
  them. The plugin registers the same two bundles through its `hooks.json`, adds no rules, MCP servers
  or agents, and declares `"platforms": ["local"]`; while the installer's entries are present its copies
  exit without sending anything. Uninstall removes only Nomo's entries and marked skills.
- Devin Desktop's **Restricted Mode** turns hooks off, and Nomo with them.

### Runtime and launch

- **Your project's runtime config is never loaded.** Hooks run with your project as working folder, and
  bun reads `bunfig.toml` (whose `preload` runs code) and `.env` from there. Whenever the runtime is
  bun, Nomo starts it with `--config=/dev/null --env-file=/dev/null`, including for processes it starts
  itself (the watchdog). Node reads neither and is started as-is. The working folder is left alone, so
  version managers (asdf, mise, proto, nodenv) keep working.
- **Only installed copies run.** The version-stable hook shim runs the copy that last ran, or the newest
  installed copy in the Claude Code / Codex plugin cache — never code from a marketplace you added but
  did not install.
- **Runtime floor.** bun before 1.4.4 and Node.js 22 before 22.23.4 are affected by CVE-2026-111497
  (brotli decompression). The status commands and the `nomo-ai` installer print a warning naming the
  runtime and how to upgrade; hooks keep running.
- **LAN listener.** Plain HTTP on the local network; the `K_lan` seal is the security boundary. Every
  rejection is an empty `400` so a prober cannot tell wrong key from stale timestamp from "no pairing
  here"; requests carry a timestamp and nonce, body size is capped, and commands are still validated
  (allow-list, freshness, replay dedupe) exactly as on the relay path.

## How it works

Every integration runs from one shared `plugin/` directory: a **Claude Code plugin**
(`nomo-cc`), a **native Codex plugin** (`nomo`), an **OpenCode plugin module**, and hooks merged into
**Cursor**, **Antigravity** and **Devin** config (Devin can also use a native plugin). The hooks,
watchdog and commands are single-file `.mjs` bundles that run under **bun or node ≥ 18** (`run.sh` picks
whichever is installed); OpenCode loads one resident `.js` bundle. **Zero npm dependencies.**

- **Pairing.** `pair` writes a themed local page with a QR and one-time code, derives the key as in
  [Architecture](#architecture), and writes `~/.config/cc-status/config.json` (`0600`). Every agent
  reads that same file, so one pairing covers them all and an unpaired hook is a no-op.
- **Hook.** Each lifecycle event plans a v2 op (`start` / `update` / `done` / `end` with a `working` /
  `needsAttention` / `done` status), seals the payload, and POSTs it to the relay, which pushes via
  APNs. A POST the 2 s timeout cuts off marks the record `updatePending`.
- **Liveness watchdog.** Closing a terminal kills the agent with no end event. Each event records
  `sessions/<id>.json` with the agent's pid; one detached `cc-watchdog.mjs` polls every 5 s and POSTs a
  corrective `end` once that pid is dead (Codex interrupts are read from the rollout transcript). It
  re-sends `updatePending` records with a 5 s timeout, backing off 5 s → 60 s after a failure and holding
  back while an approval hold is live. With no sessions it lingers, while paired, up to 30 min
  (`IDLE_GRACE_MS`), and the next hook re-spawns it.
- <a id="lan-fast-path"></a>**LAN fast path.** When the phone is on the same network, the watchdog hosts
  a small HTTP listener so commands and answers arrive in <200 ms instead of riding the next relay
  response (~5–12 s). It is strictly additive: the relay leg runs in parallel and stays canonical, so
  any LAN failure means "the relay wins", never a lost command. Off by default; turned on in the app.

State lives under `~/.config/cc-status/`. `NOMO_WORKER_URL` at pair time points at a staging Worker.

### Claude Code integration

Hooks: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`,
`PermissionRequest`, `Stop`, `SessionEnd`, `StopFailure`, `PostToolUseFailure`, `PreCompact`,
`PostCompact`, `Elicitation`, `ElicitationResult` — wired by the plugin. Claude Code auto-updates
third-party marketplaces only when their `autoUpdate` flag is on (off by default), so
`claude plugin update nomo-cc@nomo` is what moves an install.

### Codex integration

Codex **≥ 0.142** native plugin `nomo`, sharing `plugin/` with the Claude manifest. Hooks:
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`,
`SessionEnd`, `PreCompact`, `PostCompact`, `Interrupt`. Its blob is tagged `agent: "codex"` inside the
seal. `request_user_input` questions need the Codex task and the Nomo watchdog to share one app-server
process. Codex has no plugin update verb: with a `local` marketplace (`source_type` in
`~/.codex/config.toml`, the common case) Codex reads the plugin live from the path; with `git`,
`codex plugin marketplace upgrade <marketplace>` refreshes the snapshot.

### OpenCode integration

- No marketplace, no hooks: OpenCode auto-discovers `{plugin,plugins}/*.{ts,js}`, so
  `opencode-install.sh` writes `~/.config/opencode/plugins/nomo.js` — a one-line stub **re-exporting**
  `<checkout>/plugin/dist/opencode.js` (so the bundle executes beside its sibling `cc-watchdog.mjs`) —
  and the six `commands/nomo-*.md` with the plugin path baked in. `--project` targets `./.opencode/`.
- Deliberately **no npm-resolved plugin**: OpenCode's `Npm.add` short-circuits on an existing cache
  directory, so a package spec resolves `@latest` once and never updates. The **checkout is the
  version**, which is why the installer needs a durable `~/.nomo` clone rather than a `bunx` cache.
- `/nomo-update` reads its checkout back out of the stub, fetches, reads the target version with
  `git show <upstream>:plugin/.claude-plugin/plugin.json` (nothing checked out), and only if behind
  fast-forwards and re-runs the installer. It refuses on a `--ref` pin (detached), a dirty tree, no
  upstream, diverged history, unreachable remote, or a moved stub.
- Plugins are imported once at server start (no hot reload), and the plugin reads the pairing then — so
  pairing from inside OpenCode needs a restart. The blob is tagged `agent: "opencode"`. Todo lists ride
  along as plan detail. "Open on Mac" works for the desktop app only (`opencodeLocateTuiPid` walks the
  server's ancestry for `/OpenCode.app/Contents/MacOS/`). Auto vs. manual approval mode is TUI state
  that never crosses HTTP, so it is not shown. With `OPENCODE_EXPERIMENTAL_PLAN_MODE` off a plan turn
  shows only "Planning"; with it on, `plan_exit` arrives as a normal question. Liveness is the OpenCode
  server process. `opencode --pure` starts without external plugins.

### Cursor integration

- One user-level `hooks.json` serves both the desktop app and `cursor-agent`. Events: `sessionStart`,
  `beforeSubmitPrompt`, `postToolUse`, `postToolUseFailure`, `afterShellExecution`, `afterFileEdit`,
  `stop`, `sessionEnd`. Commands are Cursor skills (`~/.cursor/skills/nomo-*/SKILL.md`).
- Status-only: no hold, no answer, and no `locateTuiPid` seam, so a session is only *working* or *done*.
- A row starts at `beforeSubmitPrompt`, and only a new prompt reopens a stopped turn.
- The title is Cursor's own chat name, one field read read-only with the system `sqlite3` from the
  desktop app's state database; until then, and for `cursor-agent` chats, the first prompt.
- A turn with no `stop` is marked done after 30 quiet minutes; a finished row retires after a little
  over an hour and returns to working on new activity.
- Updating is a `git pull --ff-only` of `~/.nomo` plus a re-run of `cursor-install.mjs`.

### Antigravity integration

- `~/.gemini/config/hooks.json` serves both the desktop app and the `agy` CLI. Status events
  `SessionStart`, `PreInvocation`, `PostInvocation`, `Stop`, `PostToolUse` run
  `antigravity-hook.sh <Event>` (10 s timeout); `PreToolUse` runs `antigravity-approve.sh` (24 h). The
  plugin in `~/.gemini/config/plugins/nomo` carries only skills — plugin-packaged hooks reach only the
  CLI. An imported `nomo-cc` would report every session twice; the installer says so but never removes
  it.
- A row starts at `PreInvocation`. `PreInvocation`, `PostInvocation` and `PostToolUse` keep it working
  (throttled); `Stop` marks it done. A turn that ends with no event is settled by the watchdog once the
  hook's parent process is gone and Antigravity's conversation index shows the run idle after the last
  event; the 30-minute reap is the last resort.
- **Interrupt** stamps a one-shot flag for that conversation (needs the local link); the next
  `PostInvocation` ends the turn after the current model call or tool. Flags unused within an hour, or
  left when the turn ended on its own, are dropped; Antigravity's flags are separate from Claude
  Code's.
- **Reply** (up to 4,000 characters, sealed, over LAN and relay) is queued per conversation and handed
  over at the next `PreInvocation`; a message arriving during the last step makes that turn's `Stop`
  continue once. The phone shows *Queued* then *Delivered* and can cancel until then. A finished,
  exited `agy` conversation is resumed with `agy --conversation <id> --print=…`; an `agy` still open
  keeps the message for your next turn; a finished desktop conversation continues only on the Mac. An
  Interrupt always wins.
- Approval outcomes: Allow → `auto_approve`; Deny → `deny` with your note; everything else → `allow`
  ("no opinion"). "Always allow" is not offered. If Antigravity cancels the hook mid-hold, the card is
  withdrawn within seconds and the row returns to working.
- The title is `title` from `conversation_summaries.db` in `~/.gemini/antigravity` (desktop) or
  `~/.gemini/antigravity-cli` (`agy`), available after the first turn; before that, the first prompt
  from the transcript, then the workspace folder. The model badge is `modelName`.

### Devin integration

- Two install routes for the Devin CLI and Devin Desktop's Devin Local: the installer (hooks merged into
  `~/.config/devin/config.json`, read by both) or the native plugin (`.devin-plugin/plugin.json`,
  `"platforms": ["local"]`, never runs in Devin cloud sessions). If both are present the installer's
  entries win and the plugin stands down ("both installed — plugin idle" in status).
- Hooks: status on `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd` (10 s); approval on
  `PermissionRequest` and `PreToolUse` matched to `^ask_user_question$` (24 h). Commands are skills —
  `/nomo:*` from the plugin, `/nomo-*` from the installer.
- Interrupt (local link) ends the turn after the current step; Devin cannot cut a command or reply off
  halfway. While the phone holds a prompt, Devin Desktop shows no buttons of its own for it (like
  Claude Code's terminal). In Desktop's default Code mode Devin asks only for commands, web fetches and
  writes outside the project.

### Installer (`nomo-ai`)

- A **bootstrapper, not a package manager**: it drives each host's own install path and never writes
  into `~/.claude` or `~/.codex` itself — a second writer racing `claude plugin update` is how two
  versions end up fighting over one watchdog. The npm package ships only `bin/`, not the plugin bundle.
- With no flags and no terminal it refuses rather than guessing; every failure names the step, exit code
  and the command to run by hand, and the exit status is non-zero if any agent failed.
- Updates: OpenCode, Cursor, Antigravity and Devin legs update `~/.nomo` themselves (the checkout is the
  version). Claude Code and Codex rows only **print** the host command, because install begins with
  `marketplace add`, which would silently repoint a marketplace you aimed elsewhere (a fork, a local
  checkout). A Codex `local` marketplace prints nothing, since there is nothing to run.
- **Commands** (`pair`, `status`, `reset`, `unpair`) run the INSTALLED plugin's own entry, not code from the npm
  package: the highest plugin version among every installed copy — the copy named in the hook shim's
  stamp (`~/.config/cc-status`), `~/.nomo`, and each version in the Claude Code / Codex plugin caches
  (the same copies the hook shim considers; superseded Codex copies are skipped) — through that copy's
  `run.sh`, so the runtime rules in [Runtime and launch](#runtime-and-launch) apply. Nothing installed → one line saying
  to run `bunx nomo-ai` first. Output and exit status are the entry's own. An unknown word is refused,
  never treated as an install.
- **Short command.** Installed without asking once Nomo is installed (also under `-y`), skipped with
  `--no-global`, and not reinstalled when this version is already on PATH. It runs exactly `bun add -g nomo-ai` or `npm install -g nomo-ai` (shown first; `-n` only shows it),
  never with `sudo`, and a failure never changes the exit status. A `nomo` already on PATH counts as
  this package only if it resolves to `bin/nomo-ai.mjs` beside a `package.json` named `nomo-ai`; any
  other `nomo` is left alone and never run. The outcome goes to `~/.config/cc-status/short-command`,
  which the plugin's own output reads (no PATH probe); with no record it names both forms.
- `--ref <branch|tag>` applies only to the `~/.nomo` checkout (Claude/Codex marketplaces read the
  default branch, and the installer says so). The checkout is left **detached** so a later plain run
  recognises the pin and refuses to fast-forward it.

## Development

Sources live in `src/`: `entries/` (bundled entrypoints), `core/` (paths/config, E2E crypto, the hook
op planner, agent adapters), `opencode/` (the resident module), `qr/` (vendored QR encoder). All run
unmodified under **bun and node ≥ 18** — no `Bun.*` runtime APIs, no npm dependencies.

### Tests

```
bun test
```

Runs the full suite across `core/`, `entries/`, `opencode/` and `qr/`.

### Building the plugin bundle

```
bun build.ts
```

Bundles every hook/command entrypoint in `src/entries/` into `plugin/dist/*.mjs`, inlining local
imports so each is one node-runnable file. A second pass bundles `src/opencode/plugin.ts` into
`plugin/dist/opencode.js` — **`.js`, not `.mjs`**, because OpenCode's discovery glob is
`{plugin,plugins}/*.{ts,js}`; it has no `hooks.json` entry and no `hook-shim.sh` row.

The OpenCode commands are templates: `plugin/opencode-commands/*.md` (filename = command name) carry a
`__NOMO_ROOT__` placeholder that `opencode-install.sh` replaces with the plugin path — OpenCode offers no
`${CLAUDE_PLUGIN_ROOT}` equivalent. A new `.md` there is picked up with no code change.

`plugin/dist/` **is committed.** Marketplace installs are a plain `git clone` with no CI build step, so
the committed bundle is what runs. Re-run `bun build.ts` after any source change and commit the result;
it was built with `bun 1.3.14` — use the same major/minor to reproduce it byte for byte.

### Releasing

The version lives in manifests that must move together (deliberately not repeated here — prose drifts,
and `build.ts` checks only the JSON):

- `.claude-plugin/marketplace.json` (Claude Code marketplace)
- `.agents/plugins/marketplace.json` (Codex marketplace)
- `plugin/.claude-plugin/plugin.json` (`nomo-cc`)
- `plugin/.codex-plugin/plugin.json` (`nomo`)
- `package.json` (the `nomo-ai` npm bootstrapper)
- `.devin-plugin/plugin.json` (the native Devin plugin, `nomo`)

OpenCode has no manifest; its checkout is its version. `bun build.ts` refuses to build when the six
disagree. `package.json` carries the version only so `bunx nomo-ai --version` is quotable in a bug
report. The npm publish is manual — `npm pack --dry-run` first: the tarball is `bin/` plus
`package.json`, `README.md` and `LICENSE`, nothing else.

## License — MIT

Released under the [MIT License](LICENSE). © 2026 KarrixLee.
