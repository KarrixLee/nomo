import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildPresence, sendPresence } from "./presence";
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
});
