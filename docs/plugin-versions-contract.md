# Plugin versions per agent (plugin 2.5.3)

One computer can run a different Nomo plugin build per agent (for example Claude Code on 2.5.1 from a
lagging marketplace cache, OpenCode on 2.5.3). Versions are therefore tracked **per agent**, and a
feature is gated on the version of the integration that **owns the session** — never on whichever
watchdog happens to be running, and never on one per-computer number.

## What each POST carries

| POST | Sent by | New (append-only) | Unchanged |
|---|---|---|---|
| `POST /v1/cc/presence` | the watchdog, for every agent on the computer | body `agent` (`claude`, `codex`, `opencode`, `cursor`, `antigravity`, `devin`) + `pluginVersion` (that agent's integration version) | body `coding`, `waiting`; header `x-cc-version` (the watchdog's own version) |
| `POST /v1/cc/event` | each integration (hooks, resident plugins), and the watchdog on behalf of sessions | sealed blob key `pluginVersion` (the session's own integration version) | header `x-cc-version`; `agent` stays sealed in the blob, as today |
| decision cards (`POST /v1/cc/decision`) | the integration holding the prompt | sealed `pluginVersion` (same blob base) | everything else |

### Presence

- One `agent` + `pluginVersion` pair per POST (the server keeps each agent's for 7 days). The watchdog
  takes the agents in turn, one per heartbeat minute, so a computer with three agents reports all
  three within about three minutes.
- The version is read from the session records: each integration stamps `pluginVersion` on the
  records it writes (the highest one wins if two sessions of one agent disagree). The watchdog never
  reports its own version for another agent. An agent whose integration is older than 2.5.3 writes no
  version and is not reported (the app falls back to the legacy per-computer `pluginVersion`).
- **Older server safety:** a worker without per-agent versions rejects the new keys with 400. The
  plugin then resends the same POST at once without them, and leaves them off for 6 hours (in memory)
  before trying again. Presence never stops working.

### Sessions

- Every blob an integration seals carries `pluginVersion` = that integration's version, right after
  `sid` (optional, append-only: older apps ignore it).
- Blobs the watchdog rebuilds for a session (corrective done / needsAttention / working, title repair,
  LAN record frames) restate the **record's** `pluginVersion`, i.e. the session's integration — never
  the watchdog's. A record written by an older integration has none, and the rebuilt blob omits it.
- Heartbeats re-send the record's blob verbatim, so they carry the integration's version too.

## App and server

- App: gate per-agent features on the session blob's `pluginVersion` when present (OpenCode Reply,
  Interrupt, Deny with note: `controls` in the same blob, see `opencode-2x-remote-contract.md`), else
  on GET presence `pluginVersions[agent]`, else on the legacy `pluginVersion`.
- Server (api-status PR #132): stores `versions[agent]` from presence; GET adds
  `pluginVersions: {agent: version}`. The legacy `pluginVersion` (last `x-cc-version`) is unchanged.
