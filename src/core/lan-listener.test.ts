import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64url, decryptBlob, deriveLanKey, encryptBlob } from "./crypto";
import {
  createLanAnswerStore,
  createLanHintPublisher,
  createLanListener,
  isLoopbackAddress,
  lanEnvelopeIsFresh,
  lanHostAddresses,
  LAN_ANSWER_BLOB_MAX_CHARS,
  LAN_ANSWER_STORE_MAX,
  LAN_ANSWER_TTL_MS,
  LAN_BODY_MAX_BYTES,
  LAN_ENVELOPE_VERSION,
  LAN_FUTURE_SKEW_MS,
  LAN_HINT_MAX_CHARS,
  LAN_HINT_REFRESH_MS,
  LAN_PATH,
  LAN_TTL_MS,
  parseLanEnvelope,
  parseLanState,
} from "./lan-listener";
import type { LanAnswerDelivery, LanAnswerStore, LanCommand, LanListener } from "./lan-listener";
import type { Config } from "./shared";

// Every listener binds LOOPBACK in tests: a `bun test` run must never open a port to the network the
// developer's machine is on. Production defaults to 0.0.0.0 — that is the one difference.
const HOST = "127.0.0.1";

const config = (over: Partial<Config> = {}): Config => ({
  url: "https://worker.example",
  pairingId: "pairing-abc",
  pcSecret: "secret",
  e2eKey: new Uint8Array(32).fill(7),
  ...over,
});

// --- per-test listener registry (a leaked listening socket would wedge the next test's re-bind) ---
const live: LanListener[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  while (live.length > 0) {
    try { live.pop()?.stop(); } catch { /* already stopped */ }
  }
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nomo-lan-"));
  tmpDirs.push(dir);
  return dir;
}

async function startListener(options: {
  statePath: string;
  onCommand?: (c: LanCommand) => void;
  onAnswer?: (a: LanAnswerDelivery) => void;
  answers?: LanAnswerStore;
  remoteAddress?: (req: unknown) => string | undefined;
  now?: () => number;
  cfg?: Config | null;
  newListenerId?: () => string;
}): Promise<{ listener: LanListener; port: number; lid: string }> {
  const listener = createLanListener({
    host: HOST,
    statePath: options.statePath,
    onCommand: options.onCommand,
    onAnswer: options.onAnswer,
    answers: options.answers,
    remoteAddress: options.remoteAddress,
    now: options.now,
    newListenerId: options.newListenerId,
    trace: () => { /* tests never touch the user's session trace */ },
  });
  live.push(listener);
  const address = await listener.ready;
  if (options.cfg !== null) listener.sync(options.cfg ?? config());
  expect(address).not.toBeNull();
  return { listener, port: address!.port, lid: address!.lid };
}

/** Raw POST helper — returns the status plus the parsed JSON body (always JSON, by contract). */
async function post(
  port: number,
  body: string,
  init: { path?: string; method?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://${HOST}:${port}${init.path ?? LAN_PATH}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: init.method === "GET" ? undefined : body,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json };
}

/** Seal a request envelope exactly the way the iOS CCLanClient will. */
async function sealRequest(
  cfg: Config,
  envelope: { op: string; ts: number; nonce: string; payload: Record<string, unknown>; v?: number },
): Promise<string> {
  const key = await deriveLanKey(cfg.e2eKey, cfg.pairingId);
  return JSON.stringify({
    p: await encryptBlob(key, {
      v: envelope.v ?? LAN_ENVELOPE_VERSION,
      op: envelope.op,
      ts: envelope.ts,
      nonce: envelope.nonce,
      payload: envelope.payload,
    }),
  });
}

async function openResponse(cfg: Config, json: unknown): Promise<Record<string, unknown>> {
  const key = await deriveLanKey(cfg.e2eKey, cfg.pairingId);
  const p = (json as Record<string, unknown>).p;
  expect(typeof p).toBe("string");
  return await decryptBlob(key, p as string) as Record<string, unknown>;
}

const nonce = (): string => b64url(crypto.getRandomValues(new Uint8Array(16)));

// -----------------------------------------------------------------------------------------------

describe("K_lan derivation (the outer seal key)", () => {
  test("is 32 bytes, deterministic, and domain-separated by pairingId", async () => {
    const key = new Uint8Array(32).fill(7);
    const a = await deriveLanKey(key, "pairing-abc");
    const b = await deriveLanKey(key, "pairing-abc");
    const c = await deriveLanKey(key, "pairing-xyz");
    expect(a.length).toBe(32);
    expect(b64url(a)).toBe(b64url(b));
    expect(b64url(a)).not.toBe(b64url(c));
  });

  test("is NOT the e2eKey — a worker-path ciphertext cannot open on the LAN channel", async () => {
    const cfg = config();
    const lanKey = await deriveLanKey(cfg.e2eKey, cfg.pairingId);
    expect(b64url(lanKey)).not.toBe(b64url(cfg.e2eKey));
    const workerSealed = await encryptBlob(cfg.e2eKey, { kind: "focus-terminal" });
    await expect(decryptBlob(lanKey, workerSealed)).rejects.toThrow();
  });
});

describe("pure envelope helpers", () => {
  test("parseLanEnvelope accepts a well-formed envelope and rejects every malformed shape", () => {
    const ok = { v: 1, op: "command", ts: 1, nonce: "n", payload: { blob: "b" } };
    expect(parseLanEnvelope(ok)).toEqual(ok);
    expect(parseLanEnvelope({ ...ok, v: 2 })).toBeNull();          // wrong version
    expect(parseLanEnvelope({ ...ok, op: "" })).toBeNull();        // empty op
    expect(parseLanEnvelope({ ...ok, ts: "1" })).toBeNull();       // ts must be a number
    expect(parseLanEnvelope({ ...ok, nonce: "" })).toBeNull();     // empty nonce
    expect(parseLanEnvelope({ ...ok, nonce: "x".repeat(65) })).toBeNull(); // nonce ceiling
    expect(parseLanEnvelope({ ...ok, payload: [] })).toBeNull();   // array is not an object
    expect(parseLanEnvelope(null)).toBeNull();
  });

  test("lanEnvelopeIsFresh mirrors the worker channel's TTL and future-skew bounds", () => {
    const now = 1_000_000_000;
    expect(lanEnvelopeIsFresh(now, now)).toBe(true);
    expect(lanEnvelopeIsFresh(now - LAN_TTL_MS, now)).toBe(true);
    expect(lanEnvelopeIsFresh(now - LAN_TTL_MS - 1, now)).toBe(false);
    expect(lanEnvelopeIsFresh(now + LAN_FUTURE_SKEW_MS, now)).toBe(true);
    expect(lanEnvelopeIsFresh(now + LAN_FUTURE_SKEW_MS + 1, now)).toBe(false);
  });

  test("parseLanState rejects corrupt/out-of-range persisted state instead of poisoning the bind", () => {
    expect(parseLanState('{"port":51234,"lid":"abc","createdAt":5}')).toEqual({ port: 51234, lid: "abc", createdAt: 5 });
    expect(parseLanState('{"port":51234,"lid":"abc"}')).toEqual({ port: 51234, lid: "abc", createdAt: 0 });
    expect(parseLanState('{"port":0,"lid":"abc"}')).toBeNull();
    expect(parseLanState('{"port":70000,"lid":"abc"}')).toBeNull();
    expect(parseLanState('{"port":51234,"lid":""}')).toBeNull();
    expect(parseLanState("not json")).toBeNull();
  });
});

describe("POST /v1/lan — the happy paths", () => {
  test("op:command hands the still-sealed blob to the callback and answers a sealed ok", async () => {
    const cfg = config();
    const seen: LanCommand[] = [];
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), onCommand: (c) => { seen.push(c); }, cfg });

    const n = nonce();
    const blob = await encryptBlob(cfg.e2eKey, { kind: "focus-terminal", sessionId: "s1", ts: Date.now(), nonce: "inner" });
    const res = await post(port, await sealRequest(cfg, { op: "command", ts: Date.now(), nonce: n, payload: { blob } }));

    expect(res.status).toBe(200);
    const opened = await openResponse(cfg, res.json);
    expect(opened.v).toBe(LAN_ENVELOPE_VERSION);
    expect(opened.reqNonce).toBe(n);           // response is bound to THIS request
    expect(typeof opened.ts).toBe("number");
    expect(opened.payload).toEqual({ ok: true });

    expect(seen.length).toBe(1);
    expect(seen[0].nonce).toBe(n);
    expect(seen[0].blob).toBe(blob);           // handed over untouched — drainCommands owns validation
    expect(seen[0].config.pairingId).toBe(cfg.pairingId);
  });

  test("op:ping answers a sealed ok echoing the request nonce (the ⚡ Local liveness probe)", async () => {
    const cfg = config();
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), cfg });
    const n = nonce();
    const res = await post(port, await sealRequest(cfg, { op: "ping", ts: Date.now(), nonce: n, payload: {} }));
    expect(res.status).toBe(200);
    const opened = await openResponse(cfg, res.json);
    expect(opened.reqNonce).toBe(n);
    expect(opened.payload).toEqual({ ok: true });
  });

  test("an authenticated but UNKNOWN op gets a sealed ok:false — a newer phone can tell 'old Mac' from 'unreachable'", async () => {
    const cfg = config();
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), cfg });
    const n = nonce();
    const res = await post(port, await sealRequest(cfg, { op: "frames", ts: Date.now(), nonce: n, payload: {} }));
    expect(res.status).toBe(200);
    const opened = await openResponse(cfg, res.json);
    expect(opened.reqNonce).toBe(n);
    expect(opened.payload).toEqual({ ok: false, err: "bad-op" });
  });

  test("re-keying via sync() switches the listener to the new pairing's K_lan", async () => {
    const oldCfg = config();
    const newCfg = config({ pairingId: "pairing-new", e2eKey: new Uint8Array(32).fill(3) });
    const dir = await stateDir();
    const { listener, port } = await startListener({ statePath: join(dir, "lan.json"), cfg: oldCfg });

    listener.sync(newCfg);
    const stale = await post(port, await sealRequest(oldCfg, { op: "ping", ts: Date.now(), nonce: nonce(), payload: {} }));
    expect(stale.status).toBe(400);
    const fresh = await post(port, await sealRequest(newCfg, { op: "ping", ts: Date.now(), nonce: nonce(), payload: {} }));
    expect(fresh.status).toBe(200);
  });
});

describe("POST /v1/lan — every rejection is an opaque 400 with an empty body", () => {
  const expectOpaque = (res: { status: number; json: unknown }): void => {
    expect(res.status).toBe(400);
    expect(res.json).toEqual({});
  };

  test("a replayed OUTER nonce is refused even though the envelope is otherwise valid", async () => {
    const cfg = config();
    const seen: LanCommand[] = [];
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), onCommand: (c) => { seen.push(c); }, cfg });

    const n = nonce();
    const blob = await encryptBlob(cfg.e2eKey, { kind: "focus-terminal", sessionId: "s1", ts: Date.now(), nonce: "inner" });
    const body = await sealRequest(cfg, { op: "command", ts: Date.now(), nonce: n, payload: { blob } });
    expect((await post(port, body)).status).toBe(200);
    expectOpaque(await post(port, body));
    expect(seen.length).toBe(1); // the replay never reached the sink
  });

  test("a stale ts is refused", async () => {
    const cfg = config();
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), cfg });
    expectOpaque(await post(port, await sealRequest(cfg, {
      op: "ping", ts: Date.now() - LAN_TTL_MS - 5_000, nonce: nonce(), payload: {},
    })));
  });

  test("an implausibly future-dated ts is refused", async () => {
    const cfg = config();
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), cfg });
    expectOpaque(await post(port, await sealRequest(cfg, {
      op: "ping", ts: Date.now() + LAN_FUTURE_SKEW_MS + 5_000, nonce: nonce(), payload: {},
    })));
  });

  test("a wrong path is refused (there is exactly one endpoint)", async () => {
    const cfg = config();
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), cfg });
    const body = await sealRequest(cfg, { op: "ping", ts: Date.now(), nonce: nonce(), payload: {} });
    expectOpaque(await post(port, body, { path: "/" }));
    expectOpaque(await post(port, body, { path: "/v1/lan/extra" }));
    expectOpaque(await post(port, body, { path: "/v1/cc/event" }));
  });

  test("a non-POST method is refused", async () => {
    const cfg = config();
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), cfg });
    expectOpaque(await post(port, "", { method: "GET" }));
  });

  test("an oversized body is refused before it is buffered", async () => {
    const cfg = config();
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), cfg });
    const huge = JSON.stringify({ p: "A".repeat(LAN_BODY_MAX_BYTES + 1_024) });
    expect(huge.length).toBeGreaterThan(LAN_BODY_MAX_BYTES);
    expectOpaque(await post(port, huge));
  });

  test("a body that is not JSON, or lacks a string `p`, is refused", async () => {
    const cfg = config();
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), cfg });
    expectOpaque(await post(port, "definitely not json"));
    expectOpaque(await post(port, JSON.stringify({ nope: 1 })));
    expectOpaque(await post(port, JSON.stringify({ p: "" })));
    expectOpaque(await post(port, JSON.stringify({ p: 12 })));
  });

  test("a payload sealed under the WRONG key (or the raw e2eKey) is refused", async () => {
    const cfg = config();
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), cfg });
    const wrong = await encryptBlob(new Uint8Array(32).fill(1), {
      v: 1, op: "ping", ts: Date.now(), nonce: nonce(), payload: {},
    });
    expectOpaque(await post(port, JSON.stringify({ p: wrong })));
    // Sealed under the pairing's OWN e2eKey rather than K_lan — the cross-channel replay case.
    const e2eSealed = await encryptBlob(cfg.e2eKey, {
      v: 1, op: "ping", ts: Date.now(), nonce: nonce(), payload: {},
    });
    expectOpaque(await post(port, JSON.stringify({ p: e2eSealed })));
  });

  test("an authentic envelope with the wrong inner shape is refused", async () => {
    const cfg = config();
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), cfg });
    const key = await deriveLanKey(cfg.e2eKey, cfg.pairingId);
    expectOpaque(await post(port, JSON.stringify({ p: await encryptBlob(key, { hello: "world" }) })));
    expectOpaque(await post(port, JSON.stringify({
      p: await encryptBlob(key, { v: 2, op: "ping", ts: Date.now(), nonce: nonce(), payload: {} }),
    })));
  });

  test("op:command with a missing/oversized blob is refused and never reaches the sink", async () => {
    const cfg = config();
    const seen: LanCommand[] = [];
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), onCommand: (c) => { seen.push(c); }, cfg });
    expectOpaque(await post(port, await sealRequest(cfg, { op: "command", ts: Date.now(), nonce: nonce(), payload: {} })));
    expectOpaque(await post(port, await sealRequest(cfg, {
      op: "command", ts: Date.now(), nonce: nonce(), payload: { blob: "A".repeat(9_000) },
    })));
    expect(seen.length).toBe(0);
  });

  test("an UNPAIRED listener (sync never called / config null) refuses everything", async () => {
    const cfg = config();
    const dir = await stateDir();
    const { listener, port } = await startListener({ statePath: join(dir, "lan.json"), cfg: null });
    expectOpaque(await post(port, await sealRequest(cfg, { op: "ping", ts: Date.now(), nonce: nonce(), payload: {} })));
    listener.sync(null);
    expectOpaque(await post(port, await sealRequest(cfg, { op: "ping", ts: Date.now(), nonce: nonce(), payload: {} })));
  });
});

describe("port persistence + listener-instance id", () => {
  test("persists port/lid on a fresh bind, re-binds the SAME port after a restart, and rotates the lid when the port is taken", async () => {
    const dir = await stateDir();
    const statePath = join(dir, "lan.json");

    // 1. Fresh bind: an ephemeral port and a new lid, both persisted 0600.
    const first = await startListener({ statePath });
    const persisted = parseLanState(await readFile(statePath, "utf8"));
    expect(persisted).toEqual({ port: first.port, lid: first.lid, createdAt: expect.any(Number) });

    // 2. A SECOND listener over the same state file cannot take the still-occupied port, so it binds
    //    fresh AND rotates the lid — from the phone's point of view this is a different endpoint.
    const second = await startListener({ statePath });
    expect(second.port).not.toBe(first.port);
    expect(second.lid).not.toBe(first.lid);
    expect(parseLanState(await readFile(statePath, "utf8"))).toMatchObject({ port: second.port, lid: second.lid });

    // 3. With both stopped, a restart re-binds the persisted port and KEEPS the lid — that stability
    //    is what lets the phone's cached endpoint keep working across a watchdog restart.
    first.listener.stop();
    second.listener.stop();
    const third = await startListener({ statePath });
    expect(third.port).toBe(second.port);
    expect(third.lid).toBe(second.lid);
  });

  test("a corrupt lan.json is ignored: the listener still binds, with a fresh lid", async () => {
    const dir = await stateDir();
    const statePath = join(dir, "lan.json");
    await writeFile(statePath, "{{{ not json");
    const started = await startListener({ statePath, newListenerId: () => "fixed-lid" });
    expect(started.port).toBeGreaterThan(0);
    expect(started.lid).toBe("fixed-lid");
    expect(parseLanState(await readFile(statePath, "utf8"))).toMatchObject({ port: started.port, lid: "fixed-lid" });
  });

  test("stop() closes the socket and clears the published address", async () => {
    const dir = await stateDir();
    const { listener, port } = await startListener({ statePath: join(dir, "lan.json") });
    expect(listener.address()).not.toBeNull();
    listener.stop();
    expect(listener.address()).toBeNull();
    listener.stop(); // idempotent
    await expect(fetch(`http://${HOST}:${port}${LAN_PATH}`, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

// --- phase 2: approval answers ------------------------------------------------------------------

describe("LAN answer store", () => {
  const NOW = 1_800_000_000_000;

  test("first writer wins: a second answer for the same requestId never overwrites", () => {
    const store = createLanAnswerStore();
    expect(store.put("req-1", "blob-a", NOW)).toBe("stored");
    expect(store.put("req-1", "blob-b", NOW + 10)).toBe("duplicate");
    expect(store.peek("req-1", NOW + 20)?.answerBlob).toBe("blob-a");
  });

  test("an entry expires at the TTL and is dropped on read", () => {
    const store = createLanAnswerStore();
    store.put("req-1", "blob-a", NOW);
    expect(store.peek("req-1", NOW + LAN_ANSWER_TTL_MS)?.answerBlob).toBe("blob-a");
    expect(store.peek("req-1", NOW + LAN_ANSWER_TTL_MS + 1)).toBeUndefined();
    expect(store.size()).toBe(0);
    // …and once expired the id is writable again (a re-asked prompt reuses nothing, but the store must
    // not become a permanent tombstone either).
    expect(store.put("req-1", "blob-b", NOW + LAN_ANSWER_TTL_MS + 2)).toBe("stored");
  });

  test("the store is FIFO-bounded, so a K_lan holder cannot grow it without limit", () => {
    const store = createLanAnswerStore();
    for (let i = 0; i < LAN_ANSWER_STORE_MAX + 10; i += 1) store.put(`req-${i}`, `blob-${i}`, NOW);
    expect(store.size()).toBe(LAN_ANSWER_STORE_MAX);
    expect(store.peek("req-0", NOW)).toBeUndefined();                       // oldest evicted first
    expect(store.peek(`req-${LAN_ANSWER_STORE_MAX + 9}`, NOW)?.answerBlob)
      .toBe(`blob-${LAN_ANSWER_STORE_MAX + 9}`);                            // newest survives
  });

  test("waiter() resolves when the answer lands, is pre-resolved when it is already there, and cancels clean", async () => {
    const store = createLanAnswerStore();
    let woke = false;
    const waiter = store.waiter("req-1", NOW);
    void waiter.promise.then(() => { woke = true; });
    await Promise.resolve();
    expect(woke).toBe(false);
    store.put("req-1", "blob-a", NOW);
    await waiter.promise;
    expect(woke).toBe(true);
    waiter.cancel(); // idempotent

    expect(await Promise.race([
      store.waiter("req-1", NOW).promise.then(() => "already-there"),
      Promise.resolve().then(() => "pending"),
    ])).toBe("already-there");

    // A cancelled waiter must resolve (never leave a racing awaiter hanging) and must be unregistered.
    const abandoned = store.waiter("req-2", NOW);
    abandoned.cancel();
    await abandoned.promise;
  });
});

describe("POST /v1/lan — op:answer", () => {
  const NOW = 1_800_000_000_000;

  test("stores the still-sealed answer, answers a sealed ok, and echoes to the worker exactly once", async () => {
    const cfg = config();
    const store = createLanAnswerStore();
    const echoed: LanAnswerDelivery[] = [];
    const dir = await stateDir();
    const { port } = await startListener({
      statePath: join(dir, "lan.json"), answers: store, onAnswer: (a) => { echoed.push(a); }, now: () => NOW, cfg,
    });

    // The answerBlob is sealed under the PAIRING key by the phone; the listener never opens it (the hold
    // that consumes it does the decrypt + requestId match, exactly as on the worker path).
    const answerBlob = await encryptBlob(cfg.e2eKey, { requestId: "req-1", decision: "allow" });
    const n = nonce();
    const res = await post(port, await sealRequest(cfg, {
      op: "answer", ts: NOW, nonce: n, payload: { requestId: "req-1", answerBlob },
    }));

    expect(res.status).toBe(200);
    const opened = await openResponse(cfg, res.json);
    expect(opened.reqNonce).toBe(n);
    expect(opened.payload).toEqual({ ok: true });
    expect(store.peek("req-1", NOW)).toEqual({ answerBlob, at: NOW });
    expect(echoed).toHaveLength(1);
    expect(echoed[0].requestId).toBe("req-1");
    expect(echoed[0].answerBlob).toBe(answerBlob);
    expect(echoed[0].config.pairingId).toBe(cfg.pairingId);
  });

  test("a duplicate requestId keeps the FIRST blob, still answers ok, and does NOT re-echo", async () => {
    const cfg = config();
    const store = createLanAnswerStore();
    const echoed: LanAnswerDelivery[] = [];
    const dir = await stateDir();
    const { port } = await startListener({
      statePath: join(dir, "lan.json"), answers: store, onAnswer: (a) => { echoed.push(a); }, now: () => NOW, cfg,
    });
    const first = await encryptBlob(cfg.e2eKey, { requestId: "req-1", decision: "allow" });
    const second = await encryptBlob(cfg.e2eKey, { requestId: "req-1", decision: "deny" });
    for (const answerBlob of [first, second]) {
      const res = await post(port, await sealRequest(cfg, {
        op: "answer", ts: NOW, nonce: nonce(), payload: { requestId: "req-1", answerBlob },
      }));
      expect(res.status).toBe(200);
      expect((await openResponse(cfg, res.json)).payload).toEqual({ ok: true });
    }
    expect(store.peek("req-1", NOW)?.answerBlob).toBe(first); // first-writer-wins, like the worker route
    expect(echoed).toHaveLength(1);                           // the echo fires per STORED answer, not per POST
  });

  test("a bad requestId or an oversized/empty blob is an opaque 400 that never reaches the store", async () => {
    const cfg = config();
    const store = createLanAnswerStore();
    const echoed: LanAnswerDelivery[] = [];
    const dir = await stateDir();
    const { port } = await startListener({
      statePath: join(dir, "lan.json"), answers: store, onAnswer: (a) => { echoed.push(a); }, now: () => NOW, cfg,
    });
    const answerBlob = await encryptBlob(cfg.e2eKey, { requestId: "req-1", decision: "allow" });
    const bad = [
      { requestId: "not a request id", answerBlob },        // space — outside the worker's REQID_RE
      { requestId: "", answerBlob },
      { requestId: "x".repeat(129), answerBlob },            // past the 128-char ceiling
      { requestId: 7, answerBlob },
      { requestId: "req-1" },                                // no blob at all
      { requestId: "req-1", answerBlob: "" },
      { requestId: "req-1", answerBlob: "A".repeat(LAN_ANSWER_BLOB_MAX_CHARS + 1) },
    ];
    for (const payload of bad) {
      const res = await post(port, await sealRequest(cfg, { op: "answer", ts: NOW, nonce: nonce(), payload }));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({});
    }
    expect(store.size()).toBe(0);
    expect(echoed).toHaveLength(0);
  });

  test("a sink that throws cannot break the phone's response (the echo is never on the request path)", async () => {
    const cfg = config();
    const store = createLanAnswerStore();
    const dir = await stateDir();
    const { port } = await startListener({
      statePath: join(dir, "lan.json"), answers: store,
      onAnswer: () => { throw new Error("worker echo exploded"); }, now: () => NOW, cfg,
    });
    const answerBlob = await encryptBlob(cfg.e2eKey, { requestId: "req-1", decision: "allow" });
    const res = await post(port, await sealRequest(cfg, {
      op: "answer", ts: NOW, nonce: nonce(), payload: { requestId: "req-1", answerBlob },
    }));
    expect(res.status).toBe(200);
    expect((await openResponse(cfg, res.json)).payload).toEqual({ ok: true });
    expect(store.peek("req-1", NOW)?.answerBlob).toBe(answerBlob); // stored BEFORE the sink ran
  });
});

describe("POST /v1/lan — op:answer-poll (loopback only)", () => {
  const NOW = 1_800_000_000_000;

  test("isLoopbackAddress accepts only this machine's own loopback forms", () => {
    for (const ok of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(ok)).toBe(true);
    }
    for (const no of ["192.168.1.42", "10.0.0.7", "::ffff:192.168.1.42", "fd00::1", "", undefined, 127]) {
      expect(isLoopbackAddress(no)).toBe(false);
    }
  });

  test("answers pending, then the stored answerBlob — the SAME shape the worker's decision GET returns", async () => {
    const cfg = config();
    const store = createLanAnswerStore();
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), answers: store, now: () => NOW, cfg });

    const pending = await post(port, await sealRequest(cfg, {
      op: "answer-poll", ts: NOW, nonce: nonce(), payload: { requestId: "req-1" },
    }));
    expect((await openResponse(cfg, pending.json)).payload).toEqual({ status: "pending" });

    const answerBlob = await encryptBlob(cfg.e2eKey, { requestId: "req-1", decision: "allow" });
    store.put("req-1", answerBlob, NOW);
    const answered = await post(port, await sealRequest(cfg, {
      op: "answer-poll", ts: NOW, nonce: nonce(), payload: { requestId: "req-1" },
    }));
    expect((await openResponse(cfg, answered.json)).payload).toEqual({ status: "answered", answerBlob });
  });

  test("an expired answer reads as pending again (the TTL is enforced on the read path too)", async () => {
    const cfg = config();
    const store = createLanAnswerStore();
    let now = NOW;
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), answers: store, now: () => now, cfg });
    store.put("req-1", await encryptBlob(cfg.e2eKey, { requestId: "req-1", decision: "allow" }), NOW);
    now = NOW + LAN_ANSWER_TTL_MS + 1;
    const res = await post(port, await sealRequest(cfg, {
      op: "answer-poll", ts: now, nonce: nonce(), payload: { requestId: "req-1" },
    }));
    expect((await openResponse(cfg, res.json)).payload).toEqual({ status: "pending" });
  });

  test("a NON-loopback caller gets the plain bad-op answer — the op is invisible from the network", async () => {
    const cfg = config();
    const store = createLanAnswerStore();
    const dir = await stateDir();
    // The listener only ever binds loopback in tests, so the peer address is the injected seam.
    const { port } = await startListener({
      statePath: join(dir, "lan.json"), answers: store, remoteAddress: () => "192.168.1.42", now: () => NOW, cfg,
    });
    store.put("req-1", "secret-blob", NOW);
    const res = await post(port, await sealRequest(cfg, {
      op: "answer-poll", ts: NOW, nonce: nonce(), payload: { requestId: "req-1" },
    }));
    expect(res.status).toBe(200);
    // Byte-identical to ANY unknown op, so an old and a new phone see the same thing and nothing leaks.
    expect((await openResponse(cfg, res.json)).payload).toEqual({ ok: false, err: "bad-op" });
  });

  test("a malformed requestId on the loopback op is the same opaque 400", async () => {
    const cfg = config();
    const dir = await stateDir();
    const { port } = await startListener({ statePath: join(dir, "lan.json"), now: () => NOW, cfg });
    for (const payload of [{}, { requestId: "" }, { requestId: "bad id" }, { requestId: "x".repeat(129) }]) {
      const res = await post(port, await sealRequest(cfg, { op: "answer-poll", ts: NOW, nonce: nonce(), payload }));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({});
    }
  });
});

describe("lanHostAddresses", () => {
  test("keeps routable IPv4 first, then IPv6, and drops loopback/link-local/duplicates", () => {
    const hosts = lanHostAddresses({
      lo0: [
        { address: "127.0.0.1", family: "IPv4", internal: true },
        { address: "::1", family: "IPv6", internal: true },
      ],
      en0: [
        { address: "192.168.1.42", family: "IPv4", internal: false },
        { address: "fe80::1c2d", family: "IPv6", internal: false },
        { address: "fd00::abcd", family: "IPv6", internal: false },
      ],
      en1: [
        { address: "169.254.10.1", family: "IPv4", internal: false },
        { address: "192.168.1.42", family: "IPv4", internal: false },
        { address: "10.0.0.7", family: "IPv4", internal: false },
      ],
    });
    expect(hosts).toEqual(["192.168.1.42", "10.0.0.7", "fd00::abcd"]);
  });

  test("numeric family codes (some node builds) are handled, and an empty machine yields []", () => {
    expect(lanHostAddresses({ en0: [{ address: "2001:db8::1", family: 6, internal: false }] })).toEqual(["2001:db8::1"]);
    expect(lanHostAddresses({})).toEqual([]);
    expect(lanHostAddresses({ en0: undefined })).toEqual([]);
  });
});

describe("sealed host-hint publisher", () => {
  const address = { port: 51234, lid: "lid-1" };

  test("publishes once on first sight, stays quiet while nothing changes, and refreshes after 5 min", async () => {
    const cfg = config();
    let now = 1_000_000;
    const publisher = createLanHintPublisher({
      address: () => address,
      hosts: () => ["192.168.1.42"],
      now: () => now,
    });
    const first = await publisher.take(cfg);
    expect(typeof first).toBe("string");
    expect(await publisher.take(cfg)).toBeUndefined();     // unchanged → nothing to say
    now += LAN_HINT_REFRESH_MS - 1;
    expect(await publisher.take(cfg)).toBeUndefined();     // still inside the refresh window
    now += 2;
    // The refresh re-sends the SAME ciphertext, never a reseal: the worker's "unchanged?" test is a
    // string compare, and a fresh IV would defeat it into a KV write on every refresh.
    expect(await publisher.take(cfg)).toBe(first!);
  });

  test("the hint is sealed under the pairing e2eKey (NOT K_lan) and carries hosts/port/lid/ts", async () => {
    const cfg = config();
    const publisher = createLanHintPublisher({
      address: () => address,
      hosts: () => ["192.168.1.42", "fd00::1"],
      now: () => 1_700_000_000_000,
    });
    const sealed = await publisher.take(cfg);
    const opened = await decryptBlob(cfg.e2eKey, sealed!) as Record<string, unknown>;
    expect(opened).toEqual({
      v: LAN_ENVELOPE_VERSION,
      hosts: ["192.168.1.42", "fd00::1"],
      port: 51234,
      lid: "lid-1",
      ts: 1_700_000_000_000,
    });
    // The phone must be able to open it from the worker echo BEFORE it has any LAN connection, so
    // K_lan must NOT be the key.
    const lanKey = await deriveLanKey(cfg.e2eKey, cfg.pairingId);
    await expect(decryptBlob(lanKey, sealed!)).rejects.toThrow();
  });

  test("a changed address or host set republishes immediately", async () => {
    const cfg = config();
    let current = { port: 51234, lid: "lid-1" };
    let hosts = ["192.168.1.42"];
    let now = 1_000_000;
    const publisher = createLanHintPublisher({ address: () => current, hosts: () => hosts, now: () => now });
    expect(typeof await publisher.take(cfg)).toBe("string");

    now += 6_000; // past the host-enumeration cache
    hosts = ["192.168.1.99"];
    expect(typeof await publisher.take(cfg)).toBe("string");

    now += 6_000;
    current = { port: 51234, lid: "lid-2" };
    expect(typeof await publisher.take(cfg)).toBe("string");

    now += 6_000;
    expect(await publisher.take(cfg)).toBeUndefined();
  });

  test("nothing is published while unpaired, unbound, or with no routable address", async () => {
    const cfg = config();
    expect(await createLanHintPublisher({ address: () => address, hosts: () => ["10.0.0.1"] }).take(null)).toBeUndefined();
    expect(await createLanHintPublisher({ address: () => null, hosts: () => ["10.0.0.1"] }).take(cfg)).toBeUndefined();
    expect(await createLanHintPublisher({ address: () => address, hosts: () => [] }).take(cfg)).toBeUndefined();
  });

  test("a many-homed machine's host list is trimmed until the sealed hint fits the ceiling", async () => {
    const cfg = config();
    const many = Array.from({ length: 400 }, (_, i) => `2001:db8:${i.toString(16)}::dead:beef:cafe:${i}`);
    const publisher = createLanHintPublisher({ address: () => address, hosts: () => many, now: () => 1 });
    const sealed = await publisher.take(cfg);
    expect(sealed!.length).toBeLessThanOrEqual(LAN_HINT_MAX_CHARS);
    const opened = await decryptBlob(cfg.e2eKey, sealed!) as { hosts: string[] };
    expect(opened.hosts.length).toBeGreaterThan(0);
    expect(opened.hosts.length).toBeLessThan(many.length);
    expect(opened.hosts[0]).toBe(many[0]); // trimmed from the END: the best candidate survives
  });
});
