// presence — the tiny "who is coding, is anyone waiting" ping (2.5.0 free pairing).
//
// Sent for EVERY pairing, Pro or free (status lines never depend on the tier being exactly right), from the
// watchdog while it runs: at once when the state changes (an agent starts or stops coding, a prompt starts
// or stops waiting), else every 60 s as a heartbeat. The body is `{ coding, waiting }`: the agent ids that
// have a turn open and one yes/no for "an agent is waiting for approval" — plus, since 2.5.3, one
// `agent` + `pluginVersion` pair (see presenceVersion; dropped against a server that 400s them). No
// session ids, titles, folders, commands or timing beyond the request itself. The reply carries the pairing's tier, which is
// how the plugin learns a free → Pro flip (live sessions resume within a minute) or Pro → free.

import { readdir, readFile } from "node:fs/promises";
import {
  AgentKindWire, clearFreeMode, Config, FREE_MODE_PATH, isNotProResponse, loadConfig, markFreeMode,
  PLUGIN_VERSION, SessionRecord, SESSIONS_DIR, watchdogVersionOutranks,
} from "./shared";

/** Heartbeat while nothing changes (the server forgets a presence 180 s after the last one). */
export const PRESENCE_EVERY_MS = 60_000;
/** How often the loop re-reads the local session records. Local only: no request unless the state changed
 *  or the heartbeat is due. */
export const PRESENCE_CHECK_MS = 5_000;
/** Minimum gap between two presence POSTs, change or not. The server refuses (429) a POST within 25 s of
 *  the last one it stored (server/src/presence.ts PRESENCE_MIN_INTERVAL_MS); +2 s covers latency skew.
 *  Also what keeps state flapping from turning into a POST burst (workers.dev bans those silently). */
export const PRESENCE_MIN_GAP_MS = 27_000;
/** The server accepts at most 8 distinct agent ids. */
const MAX_CODING = 8;

export interface Presence { coding: AgentKindWire[]; waiting: boolean }

/** Pure. An agent is "coding" while one of its sessions has a turn open (working, or blocked on the user);
 *  a session idle at its prompt (done) or just opened (sessionStart) is not. */
export function buildPresence(records: SessionRecord[]): Presence {
  const coding = new Set<AgentKindWire>();
  let waiting = false;
  for (const r of records) {
    if (r.op === "done" || r.op === "end") continue;
    if (r.lastEvent !== "working" && r.lastEvent !== "needsAttention") continue;
    coding.add(r.agent ?? "claude");
    if (r.lastEvent === "needsAttention") waiting = true;
  }
  return { coding: [...coding].slice(0, MAX_CODING), waiting };
}

/** One agent's integration version for this POST (docs/plugin-versions-contract.md). */
export interface PresenceVersion { agent: AgentKindWire; pluginVersion: string }

/** Pure. Which agent's version this POST reports. The server takes ONE `agent` + `pluginVersion` per
 *  presence POST and keeps each agent's for 7 days, so the watchdog — posting for every agent on this
 *  computer — takes them in turn, one per heartbeat minute (all of them within a few minutes). The
 *  version is the one each session's OWN integration stamped on its record (the highest, if two
 *  sessions disagree), never this watchdog's. Undefined when no record names one (older integrations). */
export function presenceVersion(records: SessionRecord[], now: number): PresenceVersion | undefined {
  const best = new Map<AgentKindWire, string>();
  for (const r of records) {
    const v = r.pluginVersion;
    if (typeof v !== "string" || v.length === 0) continue;
    const agent = r.agent ?? "claude";
    const held = best.get(agent);
    if (held === undefined || watchdogVersionOutranks(v, held)) best.set(agent, v);
  }
  const agents = [...best.keys()].sort();
  if (agents.length === 0) return undefined;
  const agent = agents[Math.floor(now / PRESENCE_EVERY_MS) % agents.length]!;
  return { agent, pluginVersion: best.get(agent)! };
}

/** A worker that predates per-agent versions answers a presence POST carrying them with 400 (its key
 *  set is closed). Then: resend without them at once (a 400 stored nothing, so the 25 s gate does not
 *  apply), and leave them off until this time (in-memory) before probing again. */
let versionKeysRefusedUntil = 0;
export const PRESENCE_VERSION_REPROBE_MS = 6 * 60 * 60_000;
/** Test-only reset of the remembered refusal. */
export function resetPresenceVersionProbe(): void { versionKeysRefusedUntil = 0; }

async function readRecords(dir: string): Promise<SessionRecord[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const out: SessionRecord[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(await readFile(`${dir}/${f}`, "utf8")) as SessionRecord); } catch { /* half-written → skip */ }
  }
  return out;
}

export type PresenceResult = "pro" | "free" | "gone" | null;

/** The pairing-gone answer: 410, or 404 with requirePCAuth's own `{"error":"not found"}` body — never a
 *  bare route 404 from a server that predates /v1/cc/presence. */
function isGoneResponse(status: number, text: string): boolean {
  if (status === 410) return true;
  if (status !== 404) return false;
  try { return (JSON.parse(text) as { error?: unknown }).error === "not found"; } catch { return false; }
}

/** POST one presence ping and apply the tier it reports to the free-mode marker. Returns the tier, "gone"
 *  when the server says the pairing no longer exists (the caller feeds that to the shared gone-strike
 *  teardown), or null when the answer says nothing (409, 429, 5xx, an older server's route 404, offline)
 *  — the marker is then left alone to age out. Never throws. `presence` defaults to the records on disk. */
export async function sendPresence(
  config: Config, fetchFn: typeof fetch = fetch,
  paths: { sessionsDir?: string; freeModePath?: string } = {},
  presence?: Presence,
  version?: PresenceVersion,
  now: () => number = Date.now,
): Promise<PresenceResult> {
  const freeModePath = paths.freeModePath ?? FREE_MODE_PATH;
  try {
    const p = presence ?? buildPresence(await readRecords(paths.sessionsDir ?? SESSIONS_DIR));
    const post = (withVersion: boolean) => fetchFn(`${config.url}/v1/cc/presence`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret, "x-cc-version": PLUGIN_VERSION,
      },
      body: JSON.stringify({
        coding: p.coding, waiting: p.waiting,
        ...(withVersion && version ? { agent: version.agent, pluginVersion: version.pluginVersion } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
    const tryVersion = version !== undefined && now() >= versionKeysRefusedUntil;
    let res = await post(tryVersion);
    if (tryVersion && res.status === 400) {
      versionKeysRefusedUntil = now() + PRESENCE_VERSION_REPROBE_MS;
      res = await post(false);
    }
    const text = await res.text().catch(() => "");
    let tier: unknown;
    if (res.ok) {
      try { tier = (JSON.parse(text) as { tier?: unknown }).tier; } catch { /* not JSON */ }
    } else if (isNotProResponse(res.status, text)) {
      tier = "free";
    } else if (isGoneResponse(res.status, text)) {
      return "gone";
    }
    if (tier === "free") { await markFreeMode(freeModePath); return "free"; }
    if (tier === "pro") { await clearFreeMode(freeModePath); return "pro"; }
    return null;
  } catch {
    return null;
  }
}

/** Pure. POST now? A changed state goes out on the first check at least PRESENCE_MIN_GAP_MS after the
 *  last attempt; an unchanged one that the server accepted is refreshed every PRESENCE_EVERY_MS.
 *  `sentKey` is the last state the server ACCEPTED (null after a gone/unknown answer, so it retries). */
export function presenceDue(key: string, sentKey: string | null, lastAttemptAt: number, now: number): boolean {
  return now - lastAttemptAt >= (key === sentKey ? PRESENCE_EVERY_MS : PRESENCE_MIN_GAP_MS);
}

const EMPTY_KEY = JSON.stringify({ coding: [], waiting: false });

export interface PresenceLoopDeps {
  load?: () => Promise<Config | null>;
  read?: () => Promise<SessionRecord[]>;
  send?: (config: Config, presence: Presence, version?: PresenceVersion) => Promise<PresenceResult>;
  /** Every answer, for the watchdog's gone-strike bookkeeping. */
  onResult?: (result: PresenceResult) => void | Promise<void>;
  now?: () => number;
  /** Manual ticks for tests; the default is a PRESENCE_CHECK_MS interval. */
  schedule?: (tick: () => void) => () => void;
}

/** Watchdog hook: check the local state every PRESENCE_CHECK_MS and POST per presenceDue. Overlapping
 *  ticks are skipped; an unpaired computer sends nothing. Returns the stopper: `stop(true)` (the watchdog
 *  retiring idle) also posts one last empty presence if the server still holds a non-empty one, so the
 *  phone stops saying "Claude is coding" now instead of at the server's 180 s expiry. */
export function startPresenceLoop(deps: PresenceLoopDeps = {}): (clear?: boolean) => Promise<void> {
  const load = deps.load ?? loadConfig;
  const read = deps.read ?? (() => readRecords(SESSIONS_DIR));
  const send = deps.send ?? ((config: Config, p: Presence, v?: PresenceVersion) => sendPresence(config, fetch, {}, p, v));
  const now = deps.now ?? Date.now;
  let sentKey: string | null = null;
  let lastAttemptAt = -Infinity;
  let busy: Promise<void> | null = null;
  const attempt = async (config: Config, p: Presence, key: string, v?: PresenceVersion) => {
    lastAttemptAt = now();
    const result = await send(config, p, v);
    if (result === "pro" || result === "free") sentKey = key;
    else if (result === "gone") sentKey = null; // retry at the gap: a real revoke reaches its 2nd strike fast
    await deps.onResult?.(result);
  };
  const tick = () => {
    if (busy) return;
    busy = (async () => {
      const records = await read();
      const p = buildPresence(records);
      const key = JSON.stringify(p); // the version rotation never triggers a POST of its own
      if (!presenceDue(key, sentKey, lastAttemptAt, now())) return;
      const config = await load();
      if (config) await attempt(config, p, key, presenceVersion(records, now()));
    })().catch(() => { /* best-effort */ }).finally(() => { busy = null; });
  };
  const unschedule = deps.schedule?.(tick) ?? (() => {
    const timer = setInterval(tick, PRESENCE_CHECK_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  })();
  tick();
  return async (clear = false) => {
    unschedule();
    await busy;
    if (!clear || sentKey === null || sentKey === EMPTY_KEY) return;
    try {
      const config = await load();
      if (config) await attempt(config, { coding: [], waiting: false }, EMPTY_KEY);
    } catch { /* best-effort */ }
  };
}
