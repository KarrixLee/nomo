// presence — the tiny "who is coding, is anyone waiting" ping (2.5.0 free pairing).
//
// Sent for EVERY pairing, Pro or free (status lines never depend on the tier being exactly right), from the
// watchdog every 60 s while it runs. The body is exactly `{ coding, waiting }`: the agent ids that have a
// turn open and one yes/no for "an agent is waiting for approval". No session ids, titles, folders,
// commands or timing beyond the request itself. The reply carries the pairing's tier, which is how the
// plugin learns a free → Pro flip (live sessions resume within a minute) or Pro → free.

import { readdir, readFile } from "node:fs/promises";
import {
  AgentKindWire, clearFreeMode, Config, FREE_MODE_PATH, isNotProResponse, loadConfig, markFreeMode,
  PLUGIN_VERSION, SessionRecord, SESSIONS_DIR,
} from "./shared";

export const PRESENCE_EVERY_MS = 60_000;
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

async function readRecords(dir: string): Promise<SessionRecord[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const out: SessionRecord[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(await readFile(`${dir}/${f}`, "utf8")) as SessionRecord); } catch { /* half-written → skip */ }
  }
  return out;
}

/** POST one presence ping and apply the tier it reports to the free-mode marker. Returns the tier, or null
 *  when the answer says nothing about it (429, 5xx, an older server's 404, offline) — the marker is then
 *  left alone to age out. Never throws, and never counts toward teardown. */
export async function sendPresence(
  config: Config, fetchFn: typeof fetch = fetch,
  paths: { sessionsDir?: string; freeModePath?: string } = {},
): Promise<"pro" | "free" | null> {
  const freeModePath = paths.freeModePath ?? FREE_MODE_PATH;
  try {
    const presence = buildPresence(await readRecords(paths.sessionsDir ?? SESSIONS_DIR));
    const res = await fetchFn(`${config.url}/v1/cc/presence`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret, "x-cc-version": PLUGIN_VERSION,
      },
      body: JSON.stringify({ coding: presence.coding, waiting: presence.waiting }),
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text().catch(() => "");
    let tier: unknown;
    if (res.ok) {
      try { tier = (JSON.parse(text) as { tier?: unknown }).tier; } catch { /* not JSON */ }
    } else if (isNotProResponse(res.status, text)) {
      tier = "free";
    }
    if (tier === "free") { await markFreeMode(freeModePath); return "free"; }
    if (tier === "pro") { await clearFreeMode(freeModePath); return "pro"; }
    return null;
  } catch {
    return null;
  }
}

/** Watchdog hook: ping now, then every PRESENCE_EVERY_MS; overlapping runs are skipped and an unpaired
 *  computer sends nothing. Returns the stopper. */
export function startPresenceLoop(load = loadConfig): () => void {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const config = await load();
      if (config) await sendPresence(config);
    } catch { /* best-effort */ } finally { busy = false; }
  };
  const timer = setInterval(() => void run(), PRESENCE_EVERY_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  void run();
  return () => clearInterval(timer);
}
