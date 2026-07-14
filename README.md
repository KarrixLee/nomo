<p align="center"><img src="assets/icon.png" width="120" alt="Nomo"></p>

# Nomo — Live Activity on your iPhone

<p align="center">
<img src="assets/claude.png" height="26" alt="Claude Code">&nbsp;&nbsp;
<img src="assets/codex.png" height="26" alt="OpenAI Codex">&nbsp;&nbsp;
<img src="https://img.shields.io/badge/License-MIT-blue" alt="License: MIT">
</p>

<p align="center">
<a href="https://apps.apple.com/app/nomo-ai-status-usage/id6779366830"><img src="assets/app-store-badge.svg" height="48" alt="Download Nomo on the App Store"></a>
</p>

Mirror your **Claude Code** and **OpenAI Codex** session milestones to the
**Nomo iPhone app** as a Live Activity (Dynamic Island). A
session's status — working, needs-your-approval, done — shows up on your phone in real time,
so you can step away from the terminal and still know when an agent needs you or has finished.
Works with **Codex** in the terminal and the **Codex desktop app** alike.

> [!NOTE]
> **Platforms:** developed and tested on **macOS** and **Linux**. **Windows is untested** — it may
> work (the hooks are pure Node built-ins), but nothing on Windows has been verified, so treat it as
> unsupported for now.

Everything is **end-to-end encrypted**. Pairing is a single QR-code scan (or a short typed code);
there is no server key to copy. All session content (titles, machine name, status, even *which* agent produced an
event) rides **inside** an encrypted blob, so the relay Worker that fans out the APNs push is a
blind relay and never sees plaintext. **One pairing covers both agents** on a machine — Claude
Code and Codex share the same credentials, encryption key, watchdog, and Live Activity.

The PC side ships as two manifests over one shared `plugin/` directory: a **Claude Code plugin**
(`nomo-cc`) and a **native Codex plugin** (`nomo`). Both bundle the same self-contained `.mjs`
hooks, the liveness watchdog, and the interactive commands as single-file artifacts that run under
**either bun or node ≥ 18** (a `run.sh` shim picks whichever is installed). There are **zero npm
dependencies** — Node built-ins only.

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

### How to show the code

By default the one-time pairing code is shown **only on the pairing page**, hidden behind a "Tap to
reveal code" control until you click it — it's never printed to the terminal, so it can't end up in
shell history, a screen recording, or an AI assistant's transcript. Open the page, click reveal, and
type the code into the app.

If you genuinely **can't open a browser** on this machine at all — a headless box, an SSH-only
session — pass `--show-code` to also print the code to the terminal:

```
pair.mjs --show-code
```

That skips the QR/page entirely and prints a line like
`One-time code: 4823-ocean-sunset-mango-river-atlas-cabin · expires in 10 min` — treat it as
sensitive for the ~10 minutes it's valid, since it's now sitting in your terminal's scrollback. When a
browser is available at all, prefer the page: scanning the QR is the most private option of the
three, since it never touches a keyboard, a terminal, or a chat transcript.

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

## <img src="assets/claude.png" height="22" align="center" alt=""> Install — Claude Code

From inside Claude Code:

```
/plugin marketplace add KarrixLee/nomo
/plugin install nomo-cc@nomo
```

Then pair this machine with your phone:

```
/nomo-cc:pair
```

This opens a pairing page in your browser showing a QR code and a one-time pairing code. In the Nomo
app on your iPhone, open the **Sessions** tab, tap **"Pair a Computer"**, and either scan the QR or
tap **"Enter code"** and type the code (it expires in 10 minutes). Once it reports `Paired with … ✓`,
this machine's Claude Code sessions appear in the app.

Other commands:

- `/nomo-cc:pair` — pair this machine (opens a browser page with the QR code + one-time code).
- `/nomo-cc:pair code` — no-browser variant for a headless/SSH box: skips the QR page and prints the
  one-time typeable code straight into the terminal, so you can enter it in the app by hand.
- `/nomo-cc:status` — pairing / watchdog / last-delivery health at a glance.
- `/nomo-cc:reset` — panic button for stuck/phantom sessions: stops the watchdog and clears
  dead session rows from the phone, **without** unpairing.
- `/nomo-cc:unpair` — revoke the pairing on the server and delete local pairing state.

The lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Notification`, `PermissionRequest`, `Stop`, `SessionEnd`) are wired automatically by the plugin —
no `settings.json` edits. The hook is deliberately silent: no pairing → no-op; network down → 2 s
timeout, exit 0. It cannot affect a Claude Code session.

## <img src="assets/codex.png" height="22" align="center" alt=""> Install — OpenAI Codex

Codex (**≥ 0.142**) ships a native plugin system, so Nomo installs as a standalone Codex
plugin (also named `nomo`, sharing the same `plugin/` directory as the Claude manifest). No Claude
Code required. From inside a Codex session:

```
codex plugin marketplace add KarrixLee/nomo
codex plugin add nomo@nomo
```

This also works in the **Codex desktop app** — the same marketplace-add and plugin-add flow from
its built-in terminal.

Then **trust the hooks once**: run `/hooks` and trust the **six Nomo entries**. They ship with the
plugin (`hooks/codex-hooks.json`) but stay **inert until trusted** — this is Codex's own safety
gate, which Nomo cannot pre-approve. The hook command lines are byte-stable across releases, so
trusting once holds through updates (only a changed hook line re-arms the review).

The plugin bundles four **skills** — invoke them by typing `$<skill>` (or in natural language):

- `$nomo-pair` — pair this machine with your phone (opens a browser page with the QR code + one-time
  code, then confirms the scan). One pairing is **shared** with Claude Code if both agents run on this
  machine.
- `$nomo-status` — pairing / watchdog / hook-trust / last-delivery health.
- `$nomo-reset` — panic button for stuck/phantom sessions: stops the watchdog and clears dead
  session rows from the phone, without unpairing.
- `$nomo-unpair` — revoke the pairing and clear local state.

There is **no separate Codex pairing** — the hooks and skills read the same
`~/.config/cc-status/config.json`, so they stay inert (exit 0) until pairing completes. On the wire
the only difference from Claude Code is that Codex's encrypted blob is tagged `agent: "codex"`, so
the phone can brand it. The island shows the **most-recently-active** session regardless of which
agent produced it.

## How it works

- **Pairing.** `pair` opens a themed browser page with a QR code and a one-time code; it derives a
  per-pairing E2E key from the QR-scanned secret (or the typed code, via PBKDF2) + the phone's nonce
  (HKDF-SHA256), and writes `~/.config/cc-status/config.json` (mode `0600`) with the pairing id,
  the PC secret, and the 32-byte key. Nothing is copied by hand.
- **Hook.** On every lifecycle event the hook plans a v2 op (`start` / `update` / `done` / `end`
  with a `working` / `needsAttention` / `done` status), encrypts the payload, and POSTs the blob to
  the relay Worker, which pushes it to the phone via APNs.
- **Liveness watchdog.** Closing a terminal kills the agent without a clean end event, so a session
  could otherwise show "working" forever. Each event records `sessions/<id>.json` with the agent's
  pid; a single detached `cc-watchdog.mjs` polls every 5 s and POSTs a corrective `end` once that
  pid is dead (Codex interrupts are detected from the rollout transcript). When no sessions remain
  it exits; the next hook re-spawns it.
- **Encryption boundary.** The Worker only ever sees ciphertext; decryption happens on the phone
  (and, for the Live Activity, in the widget at render time). The agent marker is inside the blob,
  so even the fan-out relay can't tell Claude from Codex.

State lives under `~/.config/cc-status/`. Set `NOMO_WORKER_URL` to point at a staging Worker at
pair time; leave it unset for the default.

## Development

The portable TypeScript sources live in `src/`, grouped into `entries/` (the bundled
entrypoints), `core/` (shared leaf modules — paths/config, E2E crypto, the hook op planner, the
agent adapters), and `qr/` (the vendored QR encoder). All are written to run unmodified under
**bun and node ≥ 18** — no `Bun.*` runtime APIs, no npm dependencies.

### Tests

```
bun test
```

Runs the full suite (~318 tests across `core/`, `entries/`, and `qr/`).

### Building the plugin bundle

`build.ts` bundles the eight entrypoints (`cc-status`, `codex-status`, `codex-notify`,
`cc-watchdog`, `pair`, `unpair`, `reset`, `status-cmd`) into `plugin/dist/*.mjs`, inlining every local
import so each artifact is a single node-runnable file:

```
bun build.ts
```

`plugin/dist/` **is committed to the repo.** Marketplace installs are a plain `git clone` of this
repository — there is no publish, npm, or CI build step, so the committed bundle is what actually
runs. Re-run `bun build.ts` after any source change so `dist/` stays reproducible from source, and
commit the regenerated `.mjs` files. The committed bundle was built with `bun 1.3.10`; use the same
major/minor to reproduce it byte-for-byte.

## License — MIT

Released under the [MIT License](LICENSE). © 2026 KarrixLee.
