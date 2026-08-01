import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64url, decryptBlob, deriveLanKey, encryptBlob } from "./crypto";
import {
  createLanFrameStore,
  lanFrameContent,
  lanFrameSessionLive,
  LAN_FRAMES_WAITERS_MAX,
  LAN_HOLD_MAX_AGE_MS,
  LAN_FRAME_RETIRE_GRACE_MS,
  LAN_FRAME_SESSION_STALE_MS,
} from "./lan-frames";
import type { LanFrame, LanFramesSlice, LanFrameStore } from "./lan-frames";
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
  LAN_FRAMES_WAIT_MAX_MS,
  LAN_FUTURE_SKEW_MS,
  LAN_HINT_MAX_CHARS,
  LAN_HINT_REFRESH_MS,
  LAN_PATH,
  LAN_TTL_MS,
  parseLanEnvelope,
  parseLanFramesRequest,
  parseLanReadRequest,
  parseLanState,
} from "./lan-listener";
import type { LanAnswerDelivery, LanAnswerStore, LanCommand, LanListener } from "./lan-listener";
// Namespace imports for the re-export shim test below — the ONE place that asserts on the module
// surfaces themselves rather than on any single name.
import * as listener from "./lan-listener";
import * as wire from "./lan-wire";
import {
  BLOB_FIT_CHARS, fullTextForRecord, RECORD_FULL_TEXT_MAX_CHARS, RECORD_FULL_TEXT_TRUNCATION_MARKER,
} from "./shared";
import { decisionHoldFileName } from "./shared";
import type { Config, DecisionHold, SessionRecord } from "./shared";

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
  frames?: LanFrameStore;
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
    frames: options.frames,
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

  // THE SHIM RULE (see lan-listener's re-export block). lan-wire exists so the short-lived permission
  // hook can speak the protocol without bundling an HTTP server, and lan-listener re-exports ALL of it so
  // its own importers — this file included — never had to move. That "all of it" is the part that rots
  // silently: a wire constant added to lan-wire and forgotten in the shim is invisible until some future
  // importer reaches for it through the module the header says is the reference. Runtime values only,
  // which is exactly the set that can break at runtime; types are erased and cannot.
  test("lan-listener re-exports every runtime name lan-wire exports, identically", () => {
    const missing = Object.keys(wire).filter((name) => !(name in listener));
    expect(missing).toEqual([]);
    for (const name of Object.keys(wire)) {
      expect((listener as Record<string, unknown>)[name]).toBe((wire as Record<string, unknown>)[name]);
    }
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
    // Deliberately an op no build implements (phase 3 took "frames", phase 4 took "read").
    const res = await post(port, await sealRequest(cfg, { op: "transcript", ts: Date.now(), nonce: n, payload: {} }));
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

// --- phase 3: status frames -----------------------------------------------------------------------

describe("frames — pure helpers", () => {
  const NOW = 1_800_000_000_000;
  const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    pid: 4242, machine: "mac-mini", label: "api-status", ts: NOW,
    op: "update", prio: 0, blob: "sealed-blob", pairingId: "pairing-abc", ...over,
  });

  test("parseLanFramesRequest accepts the frozen shape and refuses everything else", () => {
    expect(parseLanFramesRequest({ sinceSeq: 0, waitMs: 0 })).toEqual({ sinceSeq: 0, waitMs: 0 });
    expect(parseLanFramesRequest({ sinceSeq: 7, waitMs: LAN_FRAMES_WAIT_MAX_MS }))
      .toEqual({ sinceSeq: 7, waitMs: LAN_FRAMES_WAIT_MAX_MS });
    expect(parseLanFramesRequest({ waitMs: 0 })).toBeNull();                       // both fields required
    expect(parseLanFramesRequest({ sinceSeq: 0 })).toBeNull();
    expect(parseLanFramesRequest({ sinceSeq: -1, waitMs: 0 })).toBeNull();         // no negative cursor
    expect(parseLanFramesRequest({ sinceSeq: 1.5, waitMs: 0 })).toBeNull();        // integers only
    expect(parseLanFramesRequest({ sinceSeq: "3", waitMs: 0 })).toBeNull();
    expect(parseLanFramesRequest({ sinceSeq: 0, waitMs: LAN_FRAMES_WAIT_MAX_MS + 1 })).toBeNull(); // hold ceiling
    expect(parseLanFramesRequest({ sinceSeq: 0, waitMs: -1 })).toBeNull();
    expect(parseLanFramesRequest({ sinceSeq: Number.NaN, waitMs: 0 })).toBeNull();
  });

  test("lanFrameContent mirrors the heartbeat envelope's op/prio defaults and carries the blob verbatim", () => {
    expect(lanFrameContent(rec(), "pairing-abc")).toEqual({ op: "update", prio: 0, ts: NOW, blob: "sealed-blob" });
    // op/prio absent (a pre-v2 record) → the same defaults buildHeartbeatEnvelope applies.
    expect(lanFrameContent(rec({ op: undefined, prio: undefined }), "pairing-abc"))
      .toEqual({ op: "update", prio: 0, ts: NOW, blob: "sealed-blob" });
    expect(lanFrameContent(rec({ op: "done", agent: "codex" }), "pairing-abc"))
      .toEqual({ op: "done", prio: 0, ts: NOW, blob: "sealed-blob", agent: "codex" });
  });

  test("nothing renderable is ever invented: no blob, another pairing, or no ts all read as null", () => {
    expect(lanFrameContent(rec({ blob: undefined }), "pairing-abc")).toBeNull();
    expect(lanFrameContent(rec({ blob: "" }), "pairing-abc")).toBeNull();
    // Sealed under a pairing that is no longer live → the phone could never decrypt it ("Encrypted
    // session forever"), which is exactly what the heartbeat's own pairing guard prevents.
    expect(lanFrameContent(rec({ pairingId: "pairing-old" }), "pairing-abc")).toBeNull();
    expect(lanFrameContent(rec({ pairingId: undefined }), "pairing-abc")).toBeNull();
    expect(lanFrameContent(rec(), undefined)).toBeNull();                 // unpaired listener
    expect(lanFrameContent(rec({ ts: undefined as unknown as number }), "pairing-abc")).toBeNull();
  });

  test("attentionKind rides ONLY on a live prio-1 frame (a stale marker can't relabel a done row)", () => {
    const question = rec({ prio: 1, attentionKind: "userInput" });
    expect(lanFrameContent(question, "pairing-abc")).toEqual({
      op: "update", prio: 1, ts: NOW, blob: "sealed-blob", attentionKind: "userInput",
    });
    // Same marker left behind on a record a watchdog net rewrote into a done (those nets spread
    // ...record): prio 0 ⇒ the discriminator is dropped rather than mislabelling the frame.
    expect(lanFrameContent(rec({ op: "done", prio: 0, attentionKind: "userInput" }), "pairing-abc"))
      .toEqual({ op: "done", prio: 0, ts: NOW, blob: "sealed-blob" });
  });

  test("a record written by an OLDER plugin (no attentionKind key at all) parses and simply has none", () => {
    // Byte-for-byte an old-format record: the append-last field is absent from the JSON entirely.
    const legacy = JSON.parse(
      '{"pid":4242,"machine":"mac-mini","label":"api-status","ts":1800000000000,"op":"update","prio":1,'
      + '"blob":"sealed-blob","pairingId":"pairing-abc"}',
    ) as SessionRecord;
    expect(legacy.attentionKind).toBeUndefined();
    const content = lanFrameContent(legacy, "pairing-abc");
    expect(content).toEqual({ op: "update", prio: 1, ts: 1_800_000_000_000, blob: "sealed-blob" });
    expect(content).not.toHaveProperty("attentionKind");
  });

  // --- the remote-approval hold overlay (the LAN half of the worker's decision-pending guard) -------
  //
  // FIELD CASE, session bed2e681 (2026-08-02, build 10). The permission hook POSTs its decisionPending
  // frame to /v1/cc/decision at T and holds; ~6 s later CC's `Notification` (permission_prompt) hook
  // fires and rewrites the SESSION RECORD as a plain prio:1 needsAttention. On the worker that envelope
  // is dropped (`dropped:"decision-pending"`, server/src/cc.ts) so the stored blob stays the card — but
  // the record channel had no such guard, so the LAN feed shipped the plain needsAttention at a stamp
  // 6 s NEWER than the worker's. Build 10's CCWorkerSnapshotMerge then held the worker's (older)
  // decisionPending brief back for good, and the prompt settled permanently on the yellow "needs help"
  // row with no Allow/Deny. The overlay is the missing guard.
  const HOLD_AT = NOW - 6_000;
  const hold = (over: Partial<DecisionHold> = {}): DecisionHold =>
    ({ blob: "sealed-decision-pending", at: HOLD_AT, pid: 4242, ...over });

  test("a LIVE hold overrides the plain needsAttention a concurrent Notification hook wrote (bed2e681)", () => {
    expect(lanFrameContent(rec({ prio: 1 }), "pairing-abc", hold(), NOW, () => true)).toEqual({
      op: "update", prio: 1, ts: NOW, blob: "sealed-decision-pending",
    });
    // A record that has NOT been rewritten since the hold began still gets the card — stamped at the
    // hold, which is strictly newer than the pre-hold working frame the phone already holds.
    expect(lanFrameContent(rec({ ts: HOLD_AT - 1_000, prio: 0 }), "pairing-abc", hold(), NOW, () => true))
      .toEqual({ op: "update", prio: 1, ts: HOLD_AT, blob: "sealed-decision-pending" });
    // The codex discriminator still rides (a held `request_user_input` is still a question).
    expect(lanFrameContent(rec({ prio: 1, agent: "codex", attentionKind: "userInput" }),
                           "pairing-abc", hold(), NOW, () => true))
      .toEqual({ op: "update", prio: 1, ts: NOW, blob: "sealed-decision-pending",
                 agent: "codex", attentionKind: "userInput" });
  });

  test("the hold overlay releases exactly where the worker's guard does — and cannot wedge a row", () => {
    const alive = () => true;
    // FORWARD PROGRESS SPEAKS. Claude runs tools in parallel: tool B's PostToolUse (prio:0) lands while
    // tool A is still held, and a done/end ends the row. Same carve-outs cc.ts's guard makes.
    expect(lanFrameContent(rec({ prio: 0 }), "pairing-abc", hold(), NOW, alive))
      .toEqual({ op: "update", prio: 0, ts: NOW, blob: "sealed-blob" });
    expect(lanFrameContent(rec({ op: "done", prio: 0 }), "pairing-abc", hold(), NOW, alive))
      .toEqual({ op: "done", prio: 0, ts: NOW, blob: "sealed-blob" });
    // CRASH SAFETY. The holding hook is a separate short-lived process; a SIGTERM/SIGKILL skips its
    // `finally` and leaves the marker behind (observed live on bed2e681). A dead holder is inert at
    // once, and the TTL covers the case where its pid was recycled by something else.
    expect(lanFrameContent(rec({ prio: 1 }), "pairing-abc", hold(), NOW, () => false))
      .toEqual({ op: "update", prio: 1, ts: NOW, blob: "sealed-blob" });
    expect(lanFrameContent(rec({ prio: 1 }), "pairing-abc", hold(), HOLD_AT + LAN_HOLD_MAX_AGE_MS + 1, alive))
      .toEqual({ op: "update", prio: 1, ts: NOW, blob: "sealed-blob" });
    // A malformed / empty marker is simply not a hold.
    expect(lanFrameContent(rec({ prio: 1 }), "pairing-abc", hold({ blob: "" }), NOW, alive))
      .toEqual({ op: "update", prio: 1, ts: NOW, blob: "sealed-blob" });
    expect(lanFrameContent(rec({ prio: 1 }), "pairing-abc", null, NOW, alive))
      .toEqual({ op: "update", prio: 1, ts: NOW, blob: "sealed-blob" });
  });

  test("lanFrameSessionLive mirrors classifySession's keep/end/stale decision", () => {
    expect(lanFrameSessionLive(rec(), NOW, () => true)).toBe(true);
    expect(lanFrameSessionLive(rec(), NOW, () => false)).toBe(false);                    // dead pid
    expect(lanFrameSessionLive(rec({ ts: NOW - 86_400_001 }), NOW, () => true)).toBe(false); // 24 h cap
    expect(lanFrameSessionLive(rec({ pid: undefined as unknown as number }), NOW, () => true)).toBe(false);
    expect(lanFrameSessionLive(rec({ ts: undefined as unknown as number }), NOW, () => true)).toBe(false);
  });
});

describe("frames — the state-sync store", () => {
  const NOW = 1_800_000_000_000;
  const stores: LanFrameStore[] = [];

  afterEach(() => {
    while (stores.length > 0) {
      try { stores.pop()?.stop(); } catch { /* already stopped */ }
    }
  });

  async function framesDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "nomo-frames-"));
    tmpDirs.push(dir);
    return dir;
  }

  const recordFile = (over: Partial<SessionRecord> = {}): string => JSON.stringify({
    pid: 4242, machine: "mac-mini", label: "api-status", ts: NOW,
    op: "update", prio: 0, blob: "sealed-blob", pairingId: "pairing-abc", ...over,
  });

  async function put(dir: string, sessionId: string, over: Partial<SessionRecord> = {}): Promise<void> {
    await writeFile(join(dir, `${sessionId}.json`), recordFile(over));
  }

  function makeStore(dir: string, over: Record<string, unknown> = {}): LanFrameStore {
    const store = createLanFrameStore({
      sessionsDir: dir, isAlive: () => true, now: () => NOW, ...over,
    });
    stores.push(store);
    store.setPairing("pairing-abc");
    return store;
  }

  test("a hold marker beside the record makes the feed serve the CARD, and clearing it hands the row back", async () => {
    const dir = await framesDir();
    const store = makeStore(dir);
    // Pre-hold working frame — what the phone is looking at when the prompt arrives.
    await put(dir, "s1", { ts: NOW - 10_000 });
    await store.reconcile();
    expect(store.since(0).frames[0]).toMatchObject({ prio: 0, ts: NOW - 10_000, blob: "sealed-blob" });

    // The permission hook holds, then CC's Notification hook rewrites the record as a plain
    // needsAttention 6 s later — the exact bed2e681 sequence.
    await writeFile(join(dir, decisionHoldFileName("s1")),
                    JSON.stringify({ blob: "sealed-decision-pending", at: NOW - 6_000, pid: 4242 }));
    await put(dir, "s1", { prio: 1 });
    await store.reconcile();
    expect(store.since(0).frames).toEqual([
      { seq: 2, sessionId: "s1", op: "update", prio: 1, ts: NOW, blob: "sealed-decision-pending" },
    ]);
    // The marker is NOT a session: it must never surface as a row of its own.
    expect(store.size()).toBe(1);

    // Answered → the hook's `finally` removes the marker → the record speaks for itself again.
    await unlink(join(dir, decisionHoldFileName("s1")));
    await put(dir, "s1", { ts: NOW + 1_000 });
    await store.reconcile();
    expect(store.since(2).frames).toEqual([
      { seq: 3, sessionId: "s1", op: "update", prio: 0, ts: NOW + 1_000, blob: "sealed-blob" },
    ]);
  });

  test("one counter, monotonic; three rapid updates COALESCE into one frame carrying the latest blob", async () => {
    const dir = await framesDir();
    const store = makeStore(dir);
    await put(dir, "s1", { blob: "blob-1" });
    await store.reconcile();
    expect(store.seq()).toBe(1);

    // Three more writes, each observed (this is what a burst of watch events looks like).
    for (const blob of ["blob-2", "blob-3", "blob-4"]) {
      await put(dir, "s1", { blob });
      await store.reconcile();
    }
    expect(store.seq()).toBe(4);          // the counter counts CHANGES…
    expect(store.size()).toBe(1);         // …but the map holds one entry per session
    const slice = store.since(0);
    expect(slice.seq).toBe(4);
    expect(slice.frames).toHaveLength(1); // …so the phone gets the latest state, never the history
    expect(slice.frames[0]).toEqual({ seq: 4, sessionId: "s1", op: "update", prio: 0, ts: NOW, blob: "blob-4" });

    // An unchanged record must NOT bump the counter — otherwise every 5 s reconcile would wake every
    // long-poll for nothing.
    await store.reconcile();
    expect(store.seq()).toBe(4);
  });

  test("sinceSeq filters to what the phone has not seen, seq ascending", async () => {
    const dir = await framesDir();
    const store = makeStore(dir);
    await put(dir, "s1", { blob: "a1" });
    await store.reconcile();
    await put(dir, "s2", { blob: "b1" });
    await store.reconcile();

    expect(store.since(0).frames.map((f: LanFrame) => f.sessionId)).toEqual(["s1", "s2"]);
    expect(store.since(1).frames.map((f: LanFrame) => f.sessionId)).toEqual(["s2"]);
    expect(store.since(2).frames).toEqual([]);

    await put(dir, "s1", { blob: "a2" });
    await store.reconcile();
    const tail = store.since(2);
    expect(tail.seq).toBe(3);
    expect(tail.frames).toHaveLength(1);
    expect(tail.frames[0]).toMatchObject({ seq: 3, sessionId: "s1", blob: "a2" });
    // Frames always arrive seq-ascending, whatever the map's own iteration order is.
    const all = store.since(0).frames;
    expect(all.map((f: LanFrame) => f.seq)).toEqual([...all.map((f: LanFrame) => f.seq)].sort((a, b) => a - b));
  });

  test("a STALE-HIGH sinceSeq (a cursor from a previous listener instance) yields the FULL map", async () => {
    const dir = await framesDir();
    const store = makeStore(dir);
    await put(dir, "s1");
    await put(dir, "s2");
    await store.reconcile();
    expect(store.seq()).toBe(2);

    // The phone still holds a cursor from before the watchdog restarted (the counter is in-memory and
    // restarts at 0). Filtering by it would silently starve it forever.
    const slice = store.since(9_999);
    expect(slice.seq).toBe(2);
    expect(slice.frames).toHaveLength(2);
  });

  test("a long-poll resolves on the very next change (well under 200 ms) and answers empty on timeout", async () => {
    const dir = await framesDir();
    const store = makeStore(dir);
    await put(dir, "s1", { blob: "a1" });
    await store.reconcile();

    const started = Date.now();
    const held = store.wait(store.seq(), 5_000);
    setTimeout(() => {
      void put(dir, "s1", { blob: "a2" }).then(() => store.reconcile());
    }, 20);
    const woken = await held;
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(200);
    expect(woken.frames).toHaveLength(1);
    expect(woken.frames[0]).toMatchObject({ sessionId: "s1", blob: "a2" });

    // Nothing happens → the hold expires and answers an EMPTY frame list (never an error, never a
    // dangling socket).
    const timedOut = await store.wait(store.seq(), 60);
    expect(timedOut.frames).toEqual([]);
    expect(timedOut.seq).toBe(store.seq());
  });

  test("waitMs 0 never holds, and a request whose cursor is already behind answers immediately", async () => {
    const dir = await framesDir();
    const store = makeStore(dir);
    await put(dir, "s1");
    await store.reconcile();
    const started = Date.now();
    expect((await store.wait(store.seq(), 0)).frames).toEqual([]);
    expect((await store.wait(0, 5_000)).frames).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("the waiter list is capped: the OLDEST hold is dropped with an immediate empty response", async () => {
    const dir = await framesDir();
    const store = makeStore(dir);
    const settled: number[] = [];
    const holds = Array.from({ length: LAN_FRAMES_WAITERS_MAX + 1 }, (_, i) =>
      store.wait(0, 5_000).then((slice) => { settled.push(i); return slice; }));
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toEqual([0]); // exactly the oldest, and it answered rather than erroring
    expect((await holds[0]).frames).toEqual([]);

    // Teardown must resolve every remaining hold — a listener that stops may not leave sockets hanging.
    store.stop();
    const rest = await Promise.all(holds.slice(1));
    expect(rest).toHaveLength(LAN_FRAMES_WAITERS_MAX);
    for (const slice of rest) expect(slice.frames).toEqual([]);
    // …and after stop() nothing holds at all.
    const after = Date.now();
    await store.wait(0, 5_000);
    expect(Date.now() - after).toBeLessThan(200);
  });

  test("a retired session gets ONE final terminal frame, then drops out of the map after the grace", async () => {
    const dir = await framesDir();
    let clock = NOW;
    const store = makeStore(dir, { now: () => clock });
    await put(dir, "s1", { blob: "a1" });
    await store.reconcile();
    expect(store.since(0).frames[0]).toMatchObject({ op: "update", prio: 0 });

    // The record is deleted (a clean op:end, a reap, or the idle-done retire).
    await unlink(join(dir, "s1.json"));
    clock = NOW + 1_000;
    await store.reconcile();
    const final = store.since(1);
    expect(final.frames).toHaveLength(1);
    expect(final.frames[0]).toMatchObject({ sessionId: "s1", op: "end", prio: 0, ts: NOW + 1_000, blob: "a1" });

    // Re-observing the same absence must NOT restamp it — one last word, not a heartbeat of ends.
    const seqAfterEnd = store.seq();
    await store.reconcile();
    expect(store.seq()).toBe(seqAfterEnd);

    // Past the grace the entry leaves the map entirely (silently, by contract: the phone was already
    // told, and absence in a LAN response is never evidence on its side).
    clock = NOW + 1_000 + LAN_FRAME_RETIRE_GRACE_MS + 1;
    await store.reconcile();
    expect(store.size()).toBe(0);
    expect(store.since(0).frames).toEqual([]);
  });

  test("a session whose pid died gets the same terminal frame, mirroring the sweep's verdict", async () => {
    const dir = await framesDir();
    let alive = true;
    const store = makeStore(dir, { isAlive: () => alive });
    await put(dir, "s1", { blob: "a1" });
    await store.reconcile();
    expect(store.since(0).frames[0]).toMatchObject({ op: "update" });
    alive = false;
    await store.reconcile();
    expect(store.since(1).frames[0]).toMatchObject({ sessionId: "s1", op: "end", prio: 0, blob: "a1" });
  });

  test("records the feed cannot render are skipped without inventing a frame", async () => {
    const dir = await framesDir();
    const store = makeStore(dir);
    await put(dir, "no-blob", { blob: undefined });
    await put(dir, "other-pairing", { pairingId: "pairing-old" });
    await writeFile(join(dir, "corrupt.json"), "{{{ not json");
    await writeFile(join(dir, "notes.txt"), "ignored");
    await put(dir, "good");
    await store.reconcile();
    expect(store.since(0).frames.map((f: LanFrame) => f.sessionId)).toEqual(["good"]);
  });

  test("a pairing rotation voids every cached frame (they are sealed under a key the phone no longer has)", async () => {
    const dir = await framesDir();
    const store = makeStore(dir);
    await put(dir, "s1");
    await store.reconcile();
    expect(store.size()).toBe(1);
    store.setPairing("pairing-new");
    await store.reconcile();
    expect(store.size()).toBe(0);                 // the old record's blob can't be opened by the new pairing
    await put(dir, "s2", { pairingId: "pairing-new" });
    await store.reconcile();
    expect(store.since(0).frames.map((f: LanFrame) => f.sessionId)).toEqual(["s2"]);
  });

  test("the fs.watch feed picks up a record written by a HOOK PROCESS with no reconcile call at all", async () => {
    const dir = await framesDir();
    const store = makeStore(dir, { debounceMs: 20 });
    store.start();
    store.start(); // idempotent

    const held = store.wait(0, 8_000);
    // Nothing here ever calls reconcile(): this is the real node fs.watch feed, which is how a separate,
    // short-lived hook process's write reaches the phone in ~100 ms instead of on the 5 s sweep.
    //
    // The write is REPEATED on a slow tick on purpose. A cold macOS watcher can miss its first event
    // (reproduced at ~1-in-15 fresh processes) — that is exactly the documented lossiness this design
    // answers with the sweep fallback, so pinning a single event would be testing a guarantee the
    // platform does not make. Any one delivery proves the feed; identical content means the extra
    // writes cost nothing (an unchanged record never bumps the counter).
    let slice: LanFramesSlice | null = null;
    for (let attempt = 0; attempt < 10 && slice === null; attempt += 1) {
      await put(dir, "s1", { blob: "from-the-hook" });
      slice = await Promise.race([held, new Promise<null>((r) => setTimeout(() => r(null), 400))]);
    }
    expect(slice).not.toBeNull();
    expect(slice!.frames).toHaveLength(1);
    expect(slice!.frames[0]).toMatchObject({ sessionId: "s1", blob: "from-the-hook" });
  });

  test("the watch feed is debounced: a burst of events costs exactly ONE directory pass", async () => {
    const dir = await framesDir();
    await put(dir, "s1");
    let fire: (() => void) | undefined;
    let closed = 0;
    let passes = 0;
    const store = makeStore(dir, {
      debounceMs: 30,
      isAlive: () => { passes += 1; return true; }, // called once per readable record per pass
      watchDir: (_dir: string, onChange: () => void) => {
        fire = onChange;
        return { close: () => { closed += 1; } };
      },
    });
    store.start();
    expect(typeof fire).toBe("function");
    await store.reconcile(); // settle the pairing-driven first pass, then measure only the watch feed
    passes = 0;
    for (let i = 0; i < 5; i += 1) fire!();          // a write burst
    await new Promise((r) => setTimeout(r, 120));
    expect(passes).toBe(1);                          // …collapsed into one reload
    fire!();
    await new Promise((r) => setTimeout(r, 120));
    expect(passes).toBe(2);                          // a later event still gets its own pass
    store.stop();
    expect(closed).toBe(1);
    fire!();                                          // an event after teardown must do nothing
    await new Promise((r) => setTimeout(r, 120));
    expect(passes).toBe(2);
  });

  test("a store with no session dir (the `bun test` default) is inert rather than reading real records", async () => {
    const store = createLanFrameStore({ now: () => NOW });
    stores.push(store);
    store.setPairing("pairing-abc");
    store.start();
    await store.reconcile();
    expect(store.size()).toBe(0);
    expect(store.since(0)).toEqual({ seq: 0, frames: [] });
  });
});

describe("POST /v1/lan — op:frames", () => {
  const NOW = 1_800_000_000_000;
  const stores: LanFrameStore[] = [];

  afterEach(() => {
    while (stores.length > 0) {
      try { stores.pop()?.stop(); } catch { /* already stopped */ }
    }
  });

  async function fed(): Promise<{ dir: string; store: LanFrameStore }> {
    const dir = await mkdtemp(join(tmpdir(), "nomo-frames-"));
    tmpDirs.push(dir);
    const store = createLanFrameStore({ sessionsDir: dir, isAlive: () => true, now: () => NOW });
    stores.push(store);
    store.setPairing("pairing-abc");
    return { dir, store };
  }

  const write = (dir: string, sessionId: string, over: Partial<SessionRecord> = {}): Promise<void> =>
    writeFile(join(dir, `${sessionId}.json`), JSON.stringify({
      pid: 4242, machine: "mac-mini", label: "api-status", ts: NOW,
      op: "update", prio: 0, blob: "sealed-blob", pairingId: "pairing-abc", ...over,
    }));

  test("answers a SEALED {seq,lid,frames} — the blob is passed through untouched, never opened here", async () => {
    const cfg = config();
    const { dir, store } = await fed();
    await write(dir, "s1", { blob: "sealed-by-the-hook", prio: 1, attentionKind: "userInput", agent: "codex" });
    await store.reconcile();
    const sdir = await stateDir();
    const { port, lid } = await startListener({ statePath: join(sdir, "lan.json"), frames: store, cfg });

    const n = nonce();
    const res = await post(port, await sealRequest(cfg, {
      op: "frames", ts: Date.now(), nonce: n, payload: { sinceSeq: 0, waitMs: 0 },
    }));
    expect(res.status).toBe(200);
    const opened = await openResponse(cfg, res.json);
    expect(opened.reqNonce).toBe(n);
    expect(opened.payload).toEqual({
      ok: true,
      seq: 1,
      lid,
      frames: [{
        seq: 1, sessionId: "s1", op: "update", prio: 1, ts: NOW,
        blob: "sealed-by-the-hook", agent: "codex", attentionKind: "userInput",
      }],
    });
  });

  test("the lid is stable for the life of the instance (it is the phone's cursor-reset signal)", async () => {
    const cfg = config();
    const { store } = await fed();
    const sdir = await stateDir();
    const { port, lid } = await startListener({ statePath: join(sdir, "lan.json"), frames: store, cfg });
    const seen: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await post(port, await sealRequest(cfg, {
        op: "frames", ts: Date.now(), nonce: nonce(), payload: { sinceSeq: 0, waitMs: 0 },
      }));
      seen.push(((await openResponse(cfg, res.json)).payload as Record<string, unknown>).lid);
    }
    expect(seen).toEqual([lid, lid, lid]);
  });

  test("a held request is answered the moment a record lands (the sub-second win), sealed as always", async () => {
    const cfg = config();
    const { dir, store } = await fed();
    const sdir = await stateDir();
    const { port } = await startListener({ statePath: join(sdir, "lan.json"), frames: store, cfg });

    const started = Date.now();
    const held = post(port, await sealRequest(cfg, {
      op: "frames", ts: Date.now(), nonce: nonce(), payload: { sinceSeq: 0, waitMs: 5_000 },
    }));
    setTimeout(() => { void write(dir, "s9", { blob: "late-blob" }).then(() => store.reconcile()); }, 25);
    const res = await held;
    expect(Date.now() - started).toBeLessThan(1_000);
    const payload = (await openResponse(cfg, res.json)).payload as { frames: LanFrame[] };
    expect(payload.frames).toHaveLength(1);
    expect(payload.frames[0]).toMatchObject({ sessionId: "s9", blob: "late-blob" });
  });

  test("a hold that expires answers an empty frame list rather than an error", async () => {
    const cfg = config();
    const { store } = await fed();
    const sdir = await stateDir();
    const { port } = await startListener({ statePath: join(sdir, "lan.json"), frames: store, cfg });
    const res = await post(port, await sealRequest(cfg, {
      op: "frames", ts: Date.now(), nonce: nonce(), payload: { sinceSeq: 0, waitMs: 80 },
    }));
    expect(res.status).toBe(200);
    expect((await openResponse(cfg, res.json)).payload).toEqual({ ok: true, seq: 0, lid: expect.any(String), frames: [] });
  });

  test("a malformed frames payload is the same opaque 400 every other bad payload gets", async () => {
    const cfg = config();
    const { store } = await fed();
    const sdir = await stateDir();
    const { port } = await startListener({ statePath: join(sdir, "lan.json"), frames: store, cfg });
    const bad = [
      {},
      { sinceSeq: 0 },
      { waitMs: 0 },
      { sinceSeq: -1, waitMs: 0 },
      { sinceSeq: 0, waitMs: LAN_FRAMES_WAIT_MAX_MS + 1 },
      { sinceSeq: "0", waitMs: 0 },
      { sinceSeq: 1.5, waitMs: 0 },
    ];
    for (const payload of bad) {
      const res = await post(port, await sealRequest(cfg, { op: "frames", ts: Date.now(), nonce: nonce(), payload }));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({});
    }
  });

  test("stopping the listener releases a held frames request instead of hanging its socket", async () => {
    const cfg = config();
    const { store } = await fed();
    const sdir = await stateDir();
    const { listener, port } = await startListener({ statePath: join(sdir, "lan.json"), frames: store, cfg });
    const held = post(port, await sealRequest(cfg, {
      op: "frames", ts: Date.now(), nonce: nonce(), payload: { sinceSeq: 0, waitMs: 20_000 },
    })).catch((error: Error) => ({ status: -1, json: error.name }));
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    listener.stop(); // teardown seam: the frame store's waiters are resolved before the sockets die
    await held;      // resolves (answered or socket-closed) — what must NOT happen is a 20 s hang
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("read — the unabridged pull (phase 4)", () => {
  const NOW = 1_800_000_000_000;
  const stores: LanFrameStore[] = [];

  afterEach(() => {
    while (stores.length > 0) {
      try { stores.pop()?.stop(); } catch { /* already stopped */ }
    }
  });

  async function fed(over: Record<string, unknown> = {}): Promise<{ dir: string; store: LanFrameStore }> {
    const dir = await mkdtemp(join(tmpdir(), "nomo-read-"));
    tmpDirs.push(dir);
    const store = createLanFrameStore({ sessionsDir: dir, isAlive: () => true, now: () => NOW, ...over });
    stores.push(store);
    store.setPairing("pairing-abc");
    return { dir, store };
  }

  const write = (dir: string, sessionId: string, over: Partial<SessionRecord> = {}): Promise<void> =>
    writeFile(join(dir, `${sessionId}.json`), JSON.stringify({
      pid: 4242, machine: "mac-mini", label: "api-status", ts: NOW,
      op: "update", prio: 1, blob: "sealed-blob", pairingId: "pairing-abc", ...over,
    }));

  // --- the store's own read path ---------------------------------------------------------------

  test("serves the whole plan / permission detail, complete:true, straight off the record", async () => {
    const { dir, store } = await fed();
    const plan = `# Plan\n${"step\n".repeat(2000)}`;
    await write(dir, "s1", { planFull: plan, permissionDetailFull: "ls -la\n".repeat(500) });
    expect(await store.readFull("s1", "plan")).toEqual({ content: plan, complete: true });
    expect(await store.readFull("s1", "permission-detail")).toEqual({ content: "ls -la\n".repeat(500), complete: true });
  });

  test("a record clipped by the 256 K cap reports complete:false instead of pretending it ended there", async () => {
    const { dir, store } = await fed();
    const clipped = fullTextForRecord("x".repeat(RECORD_FULL_TEXT_MAX_CHARS + 1_000), "…")!;
    await write(dir, "s1", { planFull: clipped });
    const hit = await store.readFull("s1", "plan");
    expect(hit?.complete).toBe(false);
    expect(Array.from(hit!.content).length).toBe(RECORD_FULL_TEXT_MAX_CHARS);
    expect(hit!.content.endsWith(RECORD_FULL_TEXT_TRUNCATION_MARKER)).toBe(true);
  });

  test("null for every miss: unknown session, ANOTHER pairing, an expired record, or an absent field", async () => {
    const { dir, store } = await fed();
    await write(dir, "s1", { planFull: "kept" });                                   // has a plan, no detail
    await write(dir, "s2", { planFull: "other", pairingId: "pairing-was-rotated" }); // not ours to serve
    await write(dir, "s3", { planFull: "old", ts: NOW - LAN_FRAME_SESSION_STALE_MS - 1 });
    expect(await store.readFull("nope", "plan")).toBeNull();               // unknown session
    expect(await store.readFull("s1", "permission-detail")).toBeNull();    // field never truncated
    expect(await store.readFull("s2", "plan")).toBeNull();                 // wrong pairing
    expect(await store.readFull("s3", "plan")).toBeNull();                 // past the 24 h cap
  });

  test("a session id outside the charset gate can never become a path — no traversal, just null", async () => {
    const { dir, store } = await fed();
    await writeFile(join(dir, "secret.json"), JSON.stringify({
      pid: 1, machine: "m", label: "l", ts: NOW, blob: "b", pairingId: "pairing-abc", planFull: "TOP SECRET",
    }));
    for (const id of ["../secret", "s1/../secret", "s1.json", "", "a".repeat(129)]) {
      expect(await store.readFull(id, "plan")).toBeNull();
    }
  });

  test("a record from an OLD plugin (neither field) reads back null rather than throwing", async () => {
    const { dir, store } = await fed();
    await writeFile(join(dir, "s1.json"), JSON.stringify({
      pid: 4242, machine: "mac", label: "proj", ts: NOW, op: "update", prio: 1, blob: "B", pairingId: "pairing-abc",
    }));
    expect(await store.readFull("s1", "plan")).toBeNull();
    expect(await store.readFull("s1", "permission-detail")).toBeNull();
    // …and a corrupt file is a miss too, never a throw.
    await writeFile(join(dir, "s2.json"), "{ not json");
    expect(await store.readFull("s2", "plan")).toBeNull();
  });

  test("a store with no session dir (the `bun test` default) serves nothing", async () => {
    const store = createLanFrameStore({ now: () => NOW });
    stores.push(store);
    store.setPairing("pairing-abc");
    expect(await store.readFull("s1", "plan")).toBeNull();
  });

  test("a session that went terminal is still readable — the plan does not vanish with the process", async () => {
    const { dir, store } = await fed({ isAlive: () => false });
    await write(dir, "s1", { planFull: "the plan the user is reading" });
    expect(await store.readFull("s1", "plan")).toEqual({ content: "the plan the user is reading", complete: true });
  });

  // --- the wire op -----------------------------------------------------------------------------

  test("op:read answers a SEALED {ok,content,complete} — full content, no worker ceiling in sight", async () => {
    const cfg = config();
    const { dir, store } = await fed();
    const plan = `# Plan\n${"a long line of plan markdown\n".repeat(400)}`;
    await write(dir, "s1", { planFull: plan });
    const sdir = await stateDir();
    const { port } = await startListener({ statePath: join(sdir, "lan.json"), frames: store, cfg });

    const n = nonce();
    const res = await post(port, await sealRequest(cfg, {
      op: "read", ts: Date.now(), nonce: n, payload: { what: "plan", sessionId: "s1" },
    }));
    expect(res.status).toBe(200);
    const opened = await openResponse(cfg, res.json);
    expect(opened.reqNonce).toBe(n);
    expect(opened.payload).toEqual({ ok: true, content: plan, complete: true });
    // Well past what the worker's 3072-char sealed ceiling could ever have carried.
    expect(plan.length).toBeGreaterThan(BLOB_FIT_CHARS * 3);
  });

  test("op:read serves the permission detail the decision frame had to cut", async () => {
    const cfg = config();
    const { dir, store } = await fed();
    const detail = "for f in *; do echo \"$f\"; done\n".repeat(300);
    await write(dir, "s1", { permissionDetailFull: detail });
    const sdir = await stateDir();
    const { port } = await startListener({ statePath: join(sdir, "lan.json"), frames: store, cfg });
    const res = await post(port, await sealRequest(cfg, {
      op: "read", ts: Date.now(), nonce: nonce(), payload: { what: "permission-detail", sessionId: "s1" },
    }));
    expect((await openResponse(cfg, res.json)).payload).toEqual({ ok: true, content: detail, complete: true });
  });

  test("every miss is the SAME sealed not-found — unknown session, wrong pairing, absent field", async () => {
    const cfg = config();
    const { dir, store } = await fed();
    await write(dir, "mine", { planFull: "kept" });
    await write(dir, "theirs", { planFull: "not-ours", pairingId: "pairing-rotated" });
    const sdir = await stateDir();
    const { port } = await startListener({ statePath: join(sdir, "lan.json"), frames: store, cfg });
    const asks = [
      { what: "plan", sessionId: "unknown" },
      { what: "plan", sessionId: "theirs" },
      { what: "permission-detail", sessionId: "mine" },
    ];
    for (const payload of asks) {
      const res = await post(port, await sealRequest(cfg, { op: "read", ts: Date.now(), nonce: nonce(), payload }));
      expect(res.status).toBe(200); // authenticated ⇒ a SEALED answer, never an opaque 400
      expect((await openResponse(cfg, res.json)).payload).toEqual({ ok: false, err: "not-found" });
    }
  });

  test("a malformed read payload is the same opaque 400 every other bad payload gets", async () => {
    const cfg = config();
    const { store } = await fed();
    const sdir = await stateDir();
    const { port } = await startListener({ statePath: join(sdir, "lan.json"), frames: store, cfg });
    const bad = [
      {},
      { what: "plan" },
      { sessionId: "s1" },
      { what: "transcript", sessionId: "s1" },   // unknown `what` is refused, never defaulted
      { what: "plan", sessionId: "../secret" },  // path traversal dies at the parser
      { what: "plan", sessionId: "" },
      { what: "plan", sessionId: "a".repeat(129) },
      { what: 1, sessionId: "s1" },
      { what: "plan", sessionId: 5 },
    ];
    for (const payload of bad) {
      const res = await post(port, await sealRequest(cfg, { op: "read", ts: Date.now(), nonce: nonce(), payload }));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({});
    }
  });

  test("parseLanReadRequest is the pure gate behind all of that", () => {
    expect(parseLanReadRequest({ what: "plan", sessionId: "s-1_A" })).toEqual({ what: "plan", sessionId: "s-1_A" });
    expect(parseLanReadRequest({ what: "permission-detail", sessionId: "codex-pid-40738" }))
      .toEqual({ what: "permission-detail", sessionId: "codex-pid-40738" });
    expect(parseLanReadRequest({ what: "detail", sessionId: "s1" })).toBeNull();
    expect(parseLanReadRequest({ what: "plan", sessionId: "a/b" })).toBeNull();
    expect(parseLanReadRequest({ what: "plan", sessionId: "a.b" })).toBeNull();
    expect(parseLanReadRequest({})).toBeNull();
  });
});
