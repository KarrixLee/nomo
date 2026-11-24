# OpenCode 2.x remote contract (plugin 2.5.3)

What the Nomo app needs to build Reply, Interrupt, Deny with note, Always allow (saved for this
project) and the honest states for OpenCode 2.x sessions (NOM-213). Everything here reuses wire shapes
the app already speaks for other agents. Nothing changes on the worker.

All new blob keys are **optional and appended last**. An older app ignores them; a 1.x session never
sends them.

## 1. Which sessions can do what: `controls`

| Key | Type | Where |
|---|---|---|
| `controls` | `[String]`, any of `"reply"`, `"interrupt"`, `"denyNote"` | every plugin-authored blob of an OpenCode **2.x** session, and its `decisionPending` card |

- The plugin lists only what this OpenCode's plugin context really exposes (`session.prompt`,
  `session.interrupt`, `permission.reply`). On OpenCode 2.4 all three are present.
- **Absent = none.** OpenCode 1.x sessions, and plugins older than 2.5.3, never send it.
- Watchdog-rebuilt frames (rare for OpenCode: a corrective `done`, a title repair) may omit it. **Latch
  it per session** (a session never changes OpenCode major), the same way the app already latches the
  agent.

App gates to flip, for `agent == .opencode`:

| Feature | Gate |
|---|---|
| Reply (`CCAgent.supportsReply`, `CCReply.offersReply`) | `controls` contains `"reply"` |
| Interrupt (`CCInterrupt.canInterrupt`) | `controls` contains `"interrupt"` (still LAN-only and `working`-only, as for every agent) |
| Deny with note (`CCAgent.supportsDenyNote`) | `controls` contains `"denyNote"` |
| Always allow | `permissionProjectGrant` is non-empty (section 4) |

The per-computer plugin version gate for these is **2.5.3**, but `controls` alone is enough: no
older plugin sends it. Versions are per agent (`plugin-versions-contract.md`): gate on the session's own
`pluginVersion`, never on the watchdog's.

## 2. Reply

Exactly the Antigravity wire (NOM-96):

- **Command:** `send-message` / `cancel-message`, `{kind, sessionId, ts, nonce, mid, text}`, sealed
  under the pairing key, raced over LAN and the relay. `text` up to 4,000 UTF-16 units, no control
  characters except `\n`. `mid` is `[A-Za-z0-9_-]{8,64}`.
- **Receipts:** the blob's `replies` key, `{mid: "q" | "d" | "c" | "x"}` (the newest 16).
  - `q` queued: the watchdog accepted it and the OpenCode server is running.
  - `d` delivered: the plugin handed it to OpenCode (`session.prompt`, `delivery: "steer"`).
  - `c` cancelled by `cancel-message` before delivery.
  - `x` refused: the OpenCode server is gone, or OpenCode rejected the message.
  - `w` / `r` never occur for OpenCode (no resume step).
- **Timing:** delivery is about 1 s after `q`. `steer` reaches the model before its next call, even
  mid-turn. On an idle (`done`) session it starts a new turn, so **Reply works on idle rows too** (no
  "desktop app only on the Mac" case like Antigravity's). Keep re-sending the same `mid` until a
  receipt arrives, as today; a repeated `mid` is delivered once.
- While a permission card is held, the `d` receipt arrives with the session's next frame (after the
  card is answered).
- A watchdog that can't route a message (2.5.3+) answers `x` at once. A watchdog from an older plugin
  (one that lacks this feature) drops it silently. The resident OpenCode plugin replaces such a watchdog
  within about 15 s, even while idle, and the phone's re-send (same `mid`) then gets through. So keep
  re-sending until a receipt arrives, as today.

## 3. Interrupt

Exactly the existing command: `interrupt-session` `{kind, sessionId, ts, nonce}`, LAN leg only.

- The watchdog traces `interrupt-flagged` (like Claude Code). The plugin calls
  `ctx.session.interrupt` within about 1 s; OpenCode stops the turn at once.
- The row then gets a `done` frame with `outcome: "interrupted"` (section 5).
- A flag older than 2 minutes is dropped. Interrupting a row that is already `done` is a no-op
  (`not-running`).

## 4. Always allow, saved for this project

| Key | Type | Where |
|---|---|---|
| `permissionProjectGrant` | `String`, the existing grant wire format (`cmd:git status`, `edits`, `reads`, `dir:~/x`, `similar`, …) | the `decisionPending` card, after `permissionGrant` |

- On 2.x, `permissionGrant` is **always `""`**, so older apps keep hiding Always (they would label it
  "(until OpenCode restarts)", which is wrong on 2.x).
- `permissionProjectGrant` non-empty → show **"Always allow {grant} (saved for this project)"**. Empty
  or absent → hide Always.
- **Answer:** the existing `allow_always` decision. The plugin replies `always`; OpenCode saves the
  rule for the project on disk, and it outlives restarts. It also auto-resolves other pending requests
  the new rule covers; their cards are retired as usual.
- 1.x is unchanged: `permissionGrant` is non-empty there and the "(until OpenCode restarts)" label
  stays right.

## 5. Deny with note

- **Answer:** the existing `deny` decision with `message` (the same answer blob Claude Code, Codex,
  Antigravity and Devin use). Capped at 500 characters.
- The plugin sends `permission.reply({decision: "reject", message})`. OpenCode gives the note to the
  model as tool feedback, and **the model keeps working** (a plain Deny ends the step).
- A plain Deny (no note) is unchanged.
- **Copy change:** on 2.x a Deny (with or without a note) also rejects the session's other pending
  requests **from the same assistant message** only, not the whole session.
  `CCAgent.denyRejectsSiblingPermissions` wording should say "from the same step" for 2.x rows
  (`controls` present).

## 6. Honest states

| Key | Type | Frames | Meaning |
|---|---|---|---|
| `retryAt` | Int, epoch **seconds** | `working` with `detail: "retrying"` | when the next attempt runs ("Retrying in 12 s") |
| `retryReason` | `"rateLimited"` | with `retryAt` | the provider said 429 / rate limit ("Retrying (rate limited)") |
| `phase` | `"compacting"` | `working` | OpenCode is summarizing the context ("Compacting") |
| `outcome` | `"failed"` \| `"interrupted"` | `done` | the turn did not succeed ("Failed" / "Interrupted"); absent = succeeded |
| `bgAgents` | Int > 0 | `done` | background subagents of this session still running ("Idle · 2 subagents running") |

- `detail` is unchanged (`"retrying"` still renders "Reconnecting…" on older apps), and no new
  `detail` key was added, because older apps print an unknown detail key verbatim.
- `bgAgents` is a snapshot at turn end. OpenCode wakes the parent when its subagents report back, and
  that turn's `done` re-counts. No extra frame is sent when one finishes in between.
- Per the transient-failure rule, show `retrying` in amber/positive copy; `outcome: "failed"` is a
  finished state, not a transient.

## 7. Key order (sealed blob)

Base keys, then `controls`, `phase`, `retryAt`, `retryReason`, `outcome`, `bgAgents`, `replies`,
then the fitted `plan`. On the card: the existing permission tail, `permissionGrant`, then
`permissionProjectGrant`, `controls`.

## Not possible on OpenCode 2.x (unchanged)

- Answering questions (2.x forms): plugins have no route to answer a form. Questions stay
  "answer on your Mac".
- Open on Mac: desktop app only, as before.
