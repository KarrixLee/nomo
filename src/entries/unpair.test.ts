import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { b64url } from "../core/crypto";
import { unpair } from "./unpair";

// ---------- test plumbing (self-contained; does not share pair.test.ts's helpers) ----------------

const WORKER = "https://worker.test";

/** Scripted fetch: each call consumes the next step; an exhausted script fails the test loudly. */
function scriptedFetch(steps: ((url: string, init?: RequestInit) => Response | Promise<Response>)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const step = steps.shift();
    if (!step) throw new Error(`unexpected fetch #${calls.length}: ${String(url)}`);
    return step(String(url), init);
  }) as typeof fetch;
  return { fn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PAIRING_ID = "a".repeat(32);
const PC_SECRET = "pc-secret";
const QR_SECRET_B64 = b64url(new Uint8Array(16).fill(7)); // a valid 16-byte pending qrSecret
const E2E_KEY_B64 = b64url(new Uint8Array(32).fill(2)); // a valid 32-byte completed key

let dir: string;
let configPath: string;
let lastSendPath: string;
let lines: string[];
const print = (line: string) => { lines.push(line); };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-unpair-test-"));
  configPath = join(dir, "config.json");
  lastSendPath = join(dir, "last-send");
  lines = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("unpair (completed pairing)", () => {
  test("revokes with the pairing's headers, deletes config + last-send, prints Unpaired ✓", async () => {
    await writeFile(configPath, JSON.stringify({
      url: WORKER, pairingId: PAIRING_ID, pcSecret: PC_SECRET, e2eKeyB64: E2E_KEY_B64,
    }));
    await writeFile(lastSendPath, String(Date.now()));

    const { fn, calls } = scriptedFetch([
      (url, init) => {
        expect(url).toBe(`${WORKER}/v1/cc/pair/revoke`);
        expect(init?.method).toBe("POST");
        const h = init?.headers as Record<string, string>;
        expect(h["x-cc-pairing"]).toBe(PAIRING_ID);
        expect(h["x-cc-auth"]).toBe(PC_SECRET);
        return json({ ok: true });
      },
    ]);

    expect(await unpair({ fetchFn: fn, print, configPath, lastSendPath })).toBe(0);
    expect(calls.length).toBe(1);
    await expect(stat(configPath)).rejects.toBeDefined();
    await expect(stat(lastSendPath)).rejects.toBeDefined();
    expect(lines).toContain("Revoked the pairing on the server.");
    expect(lines.at(-1)).toBe("Unpaired ✓");
  });
});

describe("unpair (tears down the transient pairing page)", () => {
  test("deletes pair.html alongside config + last-send", async () => {
    const htmlPath = join(dir, "pair.html");
    await writeFile(configPath, JSON.stringify({
      url: WORKER, pairingId: PAIRING_ID, pcSecret: PC_SECRET, e2eKeyB64: E2E_KEY_B64,
    }));
    await writeFile(lastSendPath, String(Date.now()));
    await writeFile(htmlPath, "<html>secret QR + code</html>");

    const { fn } = scriptedFetch([() => json({ ok: true })]);
    expect(await unpair({ fetchFn: fn, print, configPath, lastSendPath, htmlPath })).toBe(0);
    await expect(stat(configPath)).rejects.toBeDefined();
    await expect(stat(htmlPath)).rejects.toBeDefined(); // the secret-bearing page is gone too
    expect(lines.at(-1)).toBe("Unpaired ✓");
  });
});

describe("unpair (pending pairing — abandoned pair attempt)", () => {
  test("still revokes the pending record (has pairingId + pcSecret) and deletes local state", async () => {
    // A PENDING config: qrSecretB64 present, e2eKeyB64 absent (the phone never claimed).
    await writeFile(configPath, JSON.stringify({
      url: WORKER, pairingId: PAIRING_ID, pcSecret: PC_SECRET, qrSecretB64: QR_SECRET_B64, createdAt: Date.now(),
    }));

    const { fn, calls } = scriptedFetch([
      (url, init) => {
        expect(url).toBe(`${WORKER}/v1/cc/pair/revoke`);
        const h = init?.headers as Record<string, string>;
        expect(h["x-cc-pairing"]).toBe(PAIRING_ID);
        expect(h["x-cc-auth"]).toBe(PC_SECRET);
        return json({ ok: true });
      },
    ]);

    expect(await unpair({ fetchFn: fn, print, configPath, lastSendPath })).toBe(0);
    expect(calls.length).toBe(1); // the pending record WAS revoked, not silently skipped
    await expect(stat(configPath)).rejects.toBeDefined();
    expect(lines).toContain("Revoked the pairing on the server.");
    expect(lines.at(-1)).toBe("Unpaired ✓");
  });
});

describe("unpair (server already forgot the pairing → 404)", () => {
  test("tolerates a 404, treats it as already-revoked, still deletes local state, exit 0", async () => {
    await writeFile(configPath, JSON.stringify({
      url: WORKER, pairingId: PAIRING_ID, pcSecret: PC_SECRET, e2eKeyB64: E2E_KEY_B64,
    }));
    const { fn } = scriptedFetch([() => json({ error: "not found" }, 404)]);

    expect(await unpair({ fetchFn: fn, print, configPath, lastSendPath })).toBe(0);
    await expect(stat(configPath)).rejects.toBeDefined();
    expect(lines).toContain("Pairing was already revoked on the server.");
    expect(lines.at(-1)).toBe("Unpaired ✓");
  });
});

describe("unpair (edge cases)", () => {
  test("no config → 'Not paired.', exit 0, no fetch", async () => {
    const { fn, calls } = scriptedFetch([]);
    expect(await unpair({ fetchFn: fn, print, configPath, lastSendPath })).toBe(0);
    expect(calls.length).toBe(0);
    expect(lines).toEqual(["Not paired."]);
  });

  test("unreachable worker (fetch throws) → still deletes local state, exit 0", async () => {
    await writeFile(configPath, JSON.stringify({
      url: WORKER, pairingId: PAIRING_ID, pcSecret: PC_SECRET, e2eKeyB64: E2E_KEY_B64,
    }));
    const { fn } = scriptedFetch([() => { throw new Error("down"); }]);
    expect(await unpair({ fetchFn: fn, print, configPath, lastSendPath })).toBe(0);
    await expect(stat(configPath)).rejects.toBeDefined();
    expect(lines.join("\n")).toContain("removing the local pairing anyway");
    expect(lines.at(-1)).toBe("Unpaired ✓");
  });

  test("a non-404 server error → removes local pairing anyway, exit 0", async () => {
    await writeFile(configPath, JSON.stringify({
      url: WORKER, pairingId: PAIRING_ID, pcSecret: PC_SECRET, e2eKeyB64: E2E_KEY_B64,
    }));
    const { fn } = scriptedFetch([() => json({ error: "boom" }, 500)]);
    expect(await unpair({ fetchFn: fn, print, configPath, lastSendPath })).toBe(0);
    await expect(stat(configPath)).rejects.toBeDefined();
    expect(lines.join("\n")).toContain("Server revoke returned HTTP 500");
    expect(lines.at(-1)).toBe("Unpaired ✓");
  });

  test("corrupt config (no id/secret) → cannot revoke, no fetch, still cleaned up, exit 0", async () => {
    await writeFile(configPath, JSON.stringify({ url: WORKER, garbage: true }));
    const { fn, calls } = scriptedFetch([]);
    expect(await unpair({ fetchFn: fn, print, configPath, lastSendPath })).toBe(0);
    expect(calls.length).toBe(0); // nothing to revoke — no server round-trip
    await expect(stat(configPath)).rejects.toBeDefined();
    expect(lines).toContain("Local config is not a valid pairing — removing it.");
    expect(lines.at(-1)).toBe("Unpaired ✓");
  });

  test("passes an abort signal so a hung revoke can't stall the command", async () => {
    await writeFile(configPath, JSON.stringify({
      url: WORKER, pairingId: PAIRING_ID, pcSecret: PC_SECRET, e2eKeyB64: E2E_KEY_B64,
    }));
    let sawSignal = false;
    const { fn } = scriptedFetch([(_url, init) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return json({ ok: true });
    }]);
    await unpair({ fetchFn: fn, print, configPath, lastSendPath, revokeTimeoutMs: 1000 });
    expect(sawSignal).toBe(true);
  });
});
