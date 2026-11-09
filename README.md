<p align="center"><img src="assets/icon.png" width="120" alt="Nomo"></p>

# Nomo — Live Activity on your iPhone

<p align="center">
<img src="assets/claude.png" height="26" alt="Claude Code">&nbsp;&nbsp;
<img src="assets/codex.png" height="26" alt="OpenAI Codex">&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="assets/opencode-dark.png"><img src="assets/opencode-light.png" height="26" alt="OpenCode"></picture>&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="assets/cursor-dark.png"><img src="assets/cursor-light.png" height="26" alt="Cursor"></picture>&nbsp;&nbsp;
<img src="assets/antigravity.png" height="26" alt="Antigravity">&nbsp;&nbsp;
<img src="https://img.shields.io/badge/License-MIT-blue" alt="License: MIT">
</p>

<p align="center">
<a href="https://apps.apple.com/app/nomo-ai-status-usage/id6779366830"><img src="assets/app-store-badge.svg" height="48" alt="Download Nomo on the App Store"></a>
</p>

Nomo mirrors your **Claude Code**, **OpenAI Codex** (CLI and desktop app), **OpenCode**, **Cursor**
and **Antigravity** sessions to the Nomo iPhone app as a Live Activity — working, needs you, done — and
lets you answer permission prompts and questions from the phone (Cursor is status-only; Antigravity
answers Allow/Deny for shell commands and file writes). Everything is end-to-end encrypted; one pairing
covers every agent on a computer.

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
  title, machine name, status text, command, answer or even which agent sent it.
  [What leaves your computer](#what-leaves-your-computer)
- **No telemetry, no credentials.** The plugin's only network peer is that relay (`https://api.nomo.gg`
  by default). It never reads your agents' API keys or logins, and has no analytics. The installer and
  `/nomo-update` also run `git` against `github.com/KarrixLee/nomo`. [Network](#network)
- **Hooks can only do what you answered.** A phone Allow, Deny or answer is acted on only when it is
  sealed by your paired phone for that exact request. Every failure — unpaired, offline, timeout,
  crash — **fails open** to the agent's own prompt. Nomo can delay a decision; it never makes one for
  you, except auto-approving its **own** status/pair commands in Antigravity, matched byte for byte.
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
install path (`--claude` `--codex` `--opencode` `--cursor` `--antigravity` pick agents; `-n` prints
the plan and runs nothing). It never pairs your phone and has no `postinstall` hook. The two agent
config files it merges into directly are undone with
`node ~/.nomo/plugin/scripts/cursor-install.mjs --uninstall` (Cursor) and
`node ~/.nomo/plugin/scripts/antigravity-install.mjs --uninstall` (Antigravity).

The full guides live at [docs.nomo.gg](https://docs.nomo.gg):

| | |
| --- | --- |
| **Get started** | [Install](https://docs.nomo.gg/setup/install) · [Pair your iPhone](https://docs.nomo.gg/setup/pairing) |
| **Everyday use** | [Answer from your phone](https://docs.nomo.gg/sessions/approvals) · [Commands, update and uninstall](https://docs.nomo.gg/sessions/commands) |
| **Each agent** | [Codex](https://docs.nomo.gg/sessions/codex) · [OpenCode](https://docs.nomo.gg/sessions/opencode) · [Cursor](https://docs.nomo.gg/sessions/cursor) · [Antigravity](https://docs.nomo.gg/sessions/antigravity) |
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
| Relay Worker (`https://api.nomo.gg`, or `NOMO_WORKER_URL` at pair time) | every session event; approval holds; pairing; unpair | `/v1/cc/event`, `/v1/cc/decision*`, `/v1/cc/full`, `/v1/cc/pair/*` |
| Your iPhone, on the same network (only if LAN is turned on in the app) | commands and answers | `POST /v1/lan`, sealed under `K_lan` |
| `github.com/KarrixLee/nomo` via `git` | `bunx nomo-ai` (OpenCode, Cursor, Antigravity legs) and `/nomo-update` | clone / fetch / pull of this repo |

Nothing else: no analytics, no crash reporting, no reads of agent credentials.

**In the clear to the relay** (needed to route and authenticate): the pairing id and the computer's
pairing secret (headers), the plugin version, whether remote approvals are on, and per event the
session id, the op (`start` / `update` / `done` / `end`), a priority, timestamps, and — for a Codex
`request_user_input` question only — `attentionKind: "userInput"`. **Sealed**: everything else —
title, machine name, folder, status, model, tool name, command, file path, plan text, questions,
answers, and which agent produced the event.

**Daily activity summary — counts only, sealed.** While paired, the watchdog reads your agents' local
history read-only — Claude Code transcripts (`~/.claude/projects`), Codex rollouts and its
`state_5.sqlite` / `thread_history_1.sqlite`, OpenCode's `opencode.db` — and builds one row per day per
agent: session count, prompt count, which 5-minute slots had activity, and token totals per model. It
**never** puts prompt or reply text, project names or paths into the summary. Rows are kept in
`~/.config/cc-status/activity-days.json` (at most 400 days) and, at most every 6 hours and only when
changed, sealed and uploaded to `/v1/cc/full` (`what: "activity"`); right after pairing a new phone the
existing rows go up once within about a minute. The relay cannot read them and deletes them after
**35 days**. The summary carries a random per-computer id (`mid`) so the phone does not count a
computer twice — a UUID made once and kept in `~/.config/cc-status/machine-id` (owner-only), **never**
derived from serial, MAC, hostname or user name; delete the file for a new one.

**On the iPhone,** the Live Agents widget (Nomo Pro) reads a snapshot of decrypted titles, states and
computer names from the app's own App Group container. It never leaves the device.

### Files on your computer

| Path | What | Written by |
|---|---|---|
| `~/.config/cc-status/config.json` (`0600`) | pairing id, computer secret, 32-byte key; deleted by unpair (after a server revoke) | pair |
| `~/.config/cc-status/sessions/*.json` (`0600`) | one record per live session (agent pid, last sealed blob) | hooks, watchdog |
| `~/.config/cc-status/sessions/<conv>.<id>.agy-inbox` (owner-only) | queued Antigravity phone replies, deleted after a day | watchdog |
| `~/.config/cc-status/hook-shim.sh` (`0700`) | version-stable hook launcher | `run.sh`, pair |
| `~/.config/cc-status/activity-days.json`, `machine-id` | activity summary, per-computer id | watchdog |
| `~/.config/cc-status/*-trace.log` (`0600`) | local diagnostics; never uploaded | hooks, watchdog |
| `~/.codex/config.toml` | Codex `notify` backstop (your existing `notify` is chained, mode kept, one-time `config.toml.bak-nomo`); refuses an unparseable `notify` line | Codex pair |
| `~/.config/opencode/plugins/nomo.js`, `commands/nomo-*.md` | OpenCode stub + commands | `opencode-install.sh` |
| `~/.cursor/hooks.json` (merged), `~/.cursor/skills/nomo-*/` | Cursor hooks + skills (`$CURSOR_CONFIG_DIR` if set) | `cursor-install.mjs` |
| `~/.gemini/config/hooks.json` (`"nomo"` block), `~/.gemini/config/plugins/nomo/` | Antigravity hooks + plugin | `antigravity-install.mjs` |
| `~/.nomo/` | git checkout of this repo (OpenCode, Cursor, Antigravity installer) | `bunx nomo-ai` |

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
- **Shell cards keep the command.** The model-written one-line description is a caption: shortened
  first, and dropped before the command when space runs out.
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
  `auto_approve` — on a paired computer, after the deny rules and a pending Stop — for exactly seven
  command lines rebuilt in code from the template the installer writes the skills from (never read from
  the skill files): status (plain and verbose), approvals status, approvals **on**, reset, pair, and the
  pair wait. Byte-for-byte match (one trailing newline forgiven; a second line, a `cd`, `&& …` or other
  quoting goes to the phone). Approvals **off**, unpair and the typed pairing code still ask your phone.
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
**Cursor** and **Antigravity** config. The hooks, watchdog and commands are single-file `.mjs` bundles
that run under **bun or node ≥ 18** (`run.sh` picks whichever is installed); OpenCode loads one
resident `.js` bundle. **Zero npm dependencies.**

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

### Installer (`nomo-ai`)

- A **bootstrapper, not a package manager**: it drives each host's own install path and never writes
  into `~/.claude` or `~/.codex` itself — a second writer racing `claude plugin update` is how two
  versions end up fighting over one watchdog. The npm package ships only `bin/`, not the plugin bundle.
- With no flags and no terminal it refuses rather than guessing; every failure names the step, exit code
  and the command to run by hand, and the exit status is non-zero if any agent failed.
- Updates: OpenCode, Cursor and Antigravity legs update `~/.nomo` themselves (the checkout is the
  version). Claude Code and Codex rows only **print** the host command, because install begins with
  `marketplace add`, which would silently repoint a marketplace you aimed elsewhere (a fork, a local
  checkout). A Codex `local` marketplace prints nothing, since there is nothing to run.
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

OpenCode has no manifest; its checkout is its version. `bun build.ts` refuses to build when the five
disagree. `package.json` carries the version only so `bunx nomo-ai --version` is quotable in a bug
report. The npm publish is manual — `npm pack --dry-run` first: the tarball is `bin/` plus
`package.json`, `README.md` and `LICENSE`, nothing else.

## License — MIT

Released under the [MIT License](LICENSE). © 2026 KarrixLee.
