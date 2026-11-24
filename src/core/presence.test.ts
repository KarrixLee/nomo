import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildPresence, PRESENCE_EVERY_MS, PRESENCE_MIN_GAP_MS, PRESENCE_VERSION_REPROBE_MS, presenceDue, presenceVersion,
  resetPresenceVersionProbe, sendPresence, startPresenceLoop,
} from "./presence";
import type { Presence, PresenceResult } from "./presence";
import { isFreeMode, markFreeMode } from "./shared";
import type { Config, SessionRecord } from "./shared";

const CONFIG: Config = { url: "https://relay.test", pairingId: "pair-1", pcSecret: "secret", e2eKey: new Uint8Array(32) };
const rec = (over: Partial<SessionRecord>): SessionRecord => ({ pid: 1, machine: "m", label: "l", ts: 1, ...over });

async function withDirs<T>(run: (d: { sessionsDir: string; freeModePath: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "presence-"));
  try {
    return await run({ sessionsDir: join(dir, "sessions"), freeModePath: join(dir, "free-mode") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function replying(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("presence", () => {
  test("buildPresence lists each agent once and sets waiting when any record awaits approval", () => {
    expect(buildPresence([])).toEqual({ coding: [], waiting: false });
    const p = buildPresence([
      rec({ lastEvent: "working" }), // agent absent → claude
      rec({ agent: "claude", lastEvent: "working" }),
      rec({ agent: "codex", lastEvent: "needsAttention" }),
      rec({ agent: "opencode", lastEvent: "done" }), // idle at its prompt → not coding
      rec({ agent: "cursor", lastEvent: "working", op: "done" }),
    ]);
    expect(p.coding.sort()).toEqual(["claude", "codex"]);
    expect(p.waiting).toBe(true);
    expect(buildPresence([rec({ agent: "devin", lastEvent: "working" })]).waiting).toBe(false);
  });

  test("presence body has only coding and waiting keys", async () => {
    await withDirs(async ({ sessionsDir, freeModePath }) => {
      await Bun.write(join(sessionsDir, "s1.json"), JSON.stringify(rec({
        agent: "codex", lastEvent: "needsAttention", title: "secret title", label: "secret-folder", blob: "xyz",
      })));
      const { fn, calls } = replying({ ok: true, tier: "pro" });
      await sendPresence(CONFIG, fn, { sessionsDir, freeModePath });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://relay.test/v1/cc/presence");
      expect(calls[0]!.init.method).toBe("POST");
      const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["coding", "waiting"]);
      expect(body).toEqual({ coding: ["codex"], waiting: true });
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers["x-cc-pairing"]).toBe("pair-1");
      expect(headers["x-cc-auth"]).toBe("secret");
    });
  });

  test("sendPresence marks free on tier free and clears on tier pro", async () => {
    await withDirs(async ({ sessionsDir, freeModePath }) => {
      expect(await sendPresence(CONFIG, replying({ ok: true, tier: "free" }).fn, { sessionsDir, freeModePath })).toBe("free");
      expect(await isFreeMode(Date.now(), freeModePath)).toBe(true);
      expect(await sendPresence(CONFIG, replying({ ok: true, tier: "pro" }).fn, { sessionsDir, freeModePath })).toBe("pro");
      expect(await isFreeMode(Date.now(), freeModePath)).toBe(false);
      // The shared "not Pro" 403 also means free.
      expect(await sendPresence(CONFIG, replying({ error: "entitlement suspended" }, 403).fn, { sessionsDir, freeModePath })).toBe("free");
      expect(await isFreeMode(Date.now(), freeModePath)).toBe(true);
    });
  });

  test("an unknown answer leaves the marker alone (429, 5xx, old server 404, network error)", async () => {
    await withDirs(async ({ sessionsDir, freeModePath }) => {
      await markFreeMode(freeModePath);
      for (const status of [429, 500, 404]) {
        expect(await sendPresence(CONFIG, replying({}, status).fn, { sessionsDir, freeModePath })).toBeNull();
      }
      const throwing = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
      expect(await sendPresence(CONFIG, throwing, { sessionsDir, freeModePath })).toBeNull();
      expect(await isFreeMode(Date.now(), freeModePath)).toBe(true);
      await writeFile(freeModePath, "garbage");
      expect(await isFreeMode(Date.now(), freeModePath)).toBe(false);
    });
  });

  test("pairing gone (404 not found / 410) → 'gone' and the marker is untouched; a bare route 404 is not gone", async () => {
    await withDirs(async ({ sessionsDir, freeModePath }) => {
      await markFreeMode(freeModePath);
      expect(await sendPresence(CONFIG, replying({ error: "not found" }, 404).fn, { sessionsDir, freeModePath })).toBe("gone");
      expect(await sendPresence(CONFIG, replying({ error: "gone" }, 410).fn, { sessionsDir, freeModePath })).toBe("gone");
      expect(await sendPresence(CONFIG, replying("404 Not Found", 404).fn, { sessionsDir, freeModePath })).toBeNull();
      expect(await sendPresence(CONFIG, replying({ error: "pairing not claimed" }, 409).fn, { sessionsDir, freeModePath })).toBeNull();
      expect(await isFreeMode(Date.now(), freeModePath)).toBe(true);
    });
  });

  test("presenceDue: a change goes out once the min gap has passed; an accepted state only on the heartbeat", () => {
    const at = 1_000_000;
    expect(presenceDue("a", null, -Infinity, at)).toBe(true); // first ever
    expect(presenceDue("b", "a", at, at + PRESENCE_MIN_GAP_MS - 1)).toBe(false); // changed, too soon
    expect(presenceDue("b", "a", at, at + PRESENCE_MIN_GAP_MS)).toBe(true);
    expect(presenceDue("a", "a", at, at + PRESENCE_EVERY_MS - 1)).toBe(false); // unchanged
    expect(presenceDue("a", "a", at, at + PRESENCE_EVERY_MS)).toBe(true);
  });
});

describe("presence loop", () => {
  const working = (lastEvent: SessionRecord["lastEvent"]) => [rec({ agent: "claude", lastEvent })];

  function harness(reply: () => PresenceResult = () => "pro", initial: SessionRecord[] = []) {
    let clock = 1_000_000;
    let records = initial;
    const sent: Presence[] = [];
    const results: PresenceResult[] = [];
    let tick = () => {};
    const stop = startPresenceLoop({
      load: async () => CONFIG,
      read: async () => records,
      send: async (_c, p) => { sent.push(p); return reply(); },
      onResult: (r) => { results.push(r); },
      now: () => clock,
      schedule: (t) => { tick = t; return () => { tick = () => {}; }; },
    });
    const flush = () => new Promise((r) => setTimeout(r, 5));
    return {
      sent, results, stop,
      set: (r: SessionRecord[]) => { records = r; },
      advance: async (ms: number) => { clock += ms; tick(); await flush(); },
      flush,
    };
  }

  test("pings at once on a change (after the min gap), never more often, and heartbeats when idle", async () => {
    const h = harness();
    await h.flush();
    expect(h.sent).toEqual([{ coding: [], waiting: false }]); // the first ping goes out at start

    h.set(working("working"));
    await h.advance(5_000); // changed but inside the server's 25 s floor → held
    expect(h.sent).toHaveLength(1);
    await h.advance(PRESENCE_MIN_GAP_MS - 5_000);
    expect(h.sent.at(-1)).toEqual({ coding: ["claude"], waiting: false });

    h.set(working("needsAttention")); // a prompt starts waiting
    await h.advance(PRESENCE_MIN_GAP_MS);
    expect(h.sent.at(-1)).toEqual({ coding: ["claude"], waiting: true });
    h.set(working("working")); // answered in the terminal
    await h.advance(PRESENCE_MIN_GAP_MS);
    expect(h.sent.at(-1)).toEqual({ coding: ["claude"], waiting: false });

    // Flapping inside one gap costs at most one POST.
    const before = h.sent.length;
    for (const e of ["needsAttention", "working", "needsAttention"] as const) { h.set(working(e)); await h.advance(5_000); }
    expect(h.sent.length).toBe(before);

    // Back to the accepted state → nothing until the heartbeat, 60 s after the last POST (15 s ago).
    h.set(working("working"));
    await h.advance(PRESENCE_EVERY_MS - 15_000 - 1);
    expect(h.sent.length).toBe(before);
    await h.advance(1);
    expect(h.sent.length).toBe(before + 1);
    await h.stop();
  });

  test("a gone answer is reported and retried at the min gap (fast second strike); a refused change retries too", async () => {
    let answer: PresenceResult = "gone";
    const h = harness(() => answer);
    await h.flush();
    expect(h.results).toEqual(["gone"]);
    await h.advance(PRESENCE_MIN_GAP_MS);
    expect(h.results).toEqual(["gone", "gone"]);

    answer = null; // e.g. 429: the changed state was not stored → try again after the gap
    h.set(working("working"));
    await h.advance(PRESENCE_MIN_GAP_MS);
    answer = "pro";
    await h.advance(PRESENCE_MIN_GAP_MS);
    expect(h.sent.at(-1)).toEqual({ coding: ["claude"], waiting: false });
    expect(h.results.at(-1)).toBe("pro");
    await h.stop();
  });

  test("stop(true) clears a non-empty server presence; stop() and an already-empty one send nothing", async () => {
    const h = harness(undefined, working("working"));
    await h.flush();
    expect(h.sent).toEqual([{ coding: ["claude"], waiting: false }]);
    await h.stop(true);
    expect(h.sent.at(-1)).toEqual({ coding: [], waiting: false });

    const quiet = harness();
    await quiet.flush();
    await quiet.stop(true); // server already holds the empty state
    expect(quiet.sent).toHaveLength(1);

    const takeover = harness(undefined, working("working"));
    await takeover.flush();
    await takeover.stop(); // ownership loss / SIGTERM: the successor owns presence
    expect(takeover.sent).toHaveLength(1);
  });
});

describe("per-agent plugin versions (2.5.3)", () => {
  test("each agent's OWN integration version, taken in turn one per heartbeat minute; none when no record names one", () => {
    const records = [
      rec({ agent: "opencode", pluginVersion: "2.5.3" }), rec({ pluginVersion: "2.5.1" }),
      rec({ pluginVersion: "2.5.0" }), rec({ agent: "codex" }),
    ];
    expect(presenceVersion(records, 0)).toEqual({ agent: "claude", pluginVersion: "2.5.1" });
    expect(presenceVersion(records, PRESENCE_EVERY_MS)).toEqual({ agent: "opencode", pluginVersion: "2.5.3" });
    expect(presenceVersion(records, 2 * PRESENCE_EVERY_MS)).toEqual({ agent: "claude", pluginVersion: "2.5.1" });
    expect(presenceVersion([rec({ agent: "codex" })], 0)).toBeUndefined();
  });

  test("the POST carries `agent` + `pluginVersion` beside the unchanged coding/waiting", async () => {
    resetPresenceVersionProbe();
    const r = replying({ ok: true, tier: "pro" });
    await withDirs((d) => sendPresence(CONFIG, r.fn, d, { coding: ["opencode"], waiting: false }, { agent: "opencode", pluginVersion: "2.5.3" }));
    expect(JSON.parse(String(r.calls[0]!.init.body))).toEqual({ coding: ["opencode"], waiting: false, agent: "opencode", pluginVersion: "2.5.3" });
  });

  test("an older worker's 400 → resent at once without them, and left off until the re-probe", async () => {
    resetPresenceVersionProbe();
    const bodies: Record<string, unknown>[] = [];
    const fn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return "agent" in body ? new Response("{}", { status: 400 }) : Response.json({ ok: true, tier: "pro" });
    }) as unknown as typeof fetch;
    const v = { agent: "claude" as const, pluginVersion: "2.5.3" };
    let now = 1_000;
    await withDirs(async (d) => {
      expect(await sendPresence(CONFIG, fn, d, { coding: [], waiting: false }, v, () => now)).toBe("pro");
      expect(await sendPresence(CONFIG, fn, d, { coding: [], waiting: false }, v, () => now)).toBe("pro");
      now += PRESENCE_VERSION_REPROBE_MS;
      await sendPresence(CONFIG, fn, d, { coding: [], waiting: false }, v, () => now);
    });
    expect(bodies.map((b) => "agent" in b)).toEqual([true, false, false, true, false]);
  });
});
