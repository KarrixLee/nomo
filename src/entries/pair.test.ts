import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { b64url, decryptBlob, deriveE2EKey, fromB64url, sha256Hex } from "../core/crypto";
import {
  buildPairURL, bytesToHex, decryptDeviceName, DEFAULT_WORKER_URL, pairStart, pairWait,
} from "./pair";
import { completePendingPairing, PAIR_HTML_FILE, parsePendingConfig, PENDING_STASH_FILE } from "../core/shared";
import { deriveCodeIkm } from "../core/pair-code";
import { unpair } from "./unpair";
import { humanAge, statusCmd } from "./status-cmd";

// ---------- shared test plumbing -----------------------------------------------------------------

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

/** Deterministic randomness: hands out the queued arrays in order, asserting requested sizes. */
function scriptedRandom(queue: Uint8Array[]): (n: number) => Uint8Array {
  return (n: number) => {
    const next = queue.shift();
    if (!next) throw new Error("randomBytes called more times than scripted");
    expect(next.length).toBe(n);
    return next;
  };
}

/** AES-256-GCM seal of raw plaintext bytes as standard base64(iv ‖ ct ‖ tag) — the phone side of
 *  deviceNameEnc, built with WebCrypto directly so the test derives everything independently. */
async function seal(key: Uint8Array, plaintext: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ck = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, plaintext));
  const combined = new Uint8Array(12 + ct.length);
  combined.set(iv, 0);
  combined.set(ct, 12);
  let bin = "";
  for (const b of combined) bin += String.fromCharCode(b);
  return btoa(bin);
}

const PAIRING_BYTES = Uint8Array.from({ length: 16 }, (_, i) => i);
const PC_SECRET_BYTES = Uint8Array.from({ length: 24 }, (_, i) => 100 + i);
const QR_SECRET = Uint8Array.from({ length: 16 }, (_, i) => 200 + i);
const PHONE_NONCE = Uint8Array.from({ length: 16 }, (_, i) => 50 + i);
const EXPECTED_PAIRING_ID = bytesToHex(PAIRING_BYTES);
const EXPECTED_PC_SECRET = b64url(PC_SECRET_BYTES);

let dir: string;
let configPath: string;
let sleeps: number[];
let lines: string[];
const sleep = async (ms: number) => { sleeps.push(ms); };
const print = (l: string) => { lines.push(l); };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-pair-test-"));
  configPath = join(dir, "config.json");
  sleeps = [];
  lines = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------- pair: shared helpers ------------------------------------------------------------------

/** spawnWatchdog spy: pairStart must fire it so a mid-pairing config self-heals if `wait` never runs. */
function watchdogSpy() {
  let calls = 0;
  return { spawn: () => { calls++; }, get calls() { return calls; } };
}

/** Write a PENDING config (what pairStart persists) so pairWait / completePendingPairing tests can run
 *  against the on-disk contract without re-running the start phase. */
async function writePending(over: Record<string, unknown> = {}): Promise<void> {
  await writeFile(configPath, JSON.stringify({
    url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET, qrSecretB64: b64url(QR_SECRET), ...over,
  }));
}

// ---------- pairStart (phase 1: fast, writes + opens the pairing page) ----------------------------

describe("pairStart", () => {
  test("registers the pairing, writes a PENDING config (0600), writes + opens pair.html (QR only, no channel), spawns the watchdog", async () => {
    const wd = watchdogSpy();
    const htmlPath = join(dir, PAIR_HTML_FILE);
    const opened: string[] = [];
    const { fn, calls } = scriptedFetch([
      (url, init) => {
        expect(url).toBe(`${WORKER}/v1/cc/pair/start`);
        expect(init?.method).toBe("POST");
        return json({ ok: true }, 201); // NO channel → QR-only page
      },
    ]);

    const code = await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: wd.spawn, now: () => 1_700_000_000_000,
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath, openFile: (p: string) => { opened.push(p); return true; },
    });

    expect(code).toBe(0);
    expect(calls.length).toBe(1); // ONLY the start call — no polling, so it returns fast
    expect(wd.calls).toBe(1); // the self-heal watchdog was spawned
    expect(opened).toEqual([htmlPath]); // the browser opener was invoked with the page path

    // start body: minted 32-hex id + sha256(pcSecret).
    const startBody = JSON.parse(String(calls[0].init?.body)) as Record<string, string>;
    expect(startBody.pairingId).toBe(EXPECTED_PAIRING_ID);
    expect(startBody.pairingId).toMatch(/^[0-9a-f]{32}$/);
    expect(startBody.pcAuthHash).toBe(await sha256Hex(EXPECTED_PC_SECRET));

    // PENDING config: qrSecret persisted, createdAt stamped, NO channel → NO codeIkm, NO e2eKey yet.
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(written).toEqual({
      url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET,
      qrSecretB64: b64url(QR_SECRET), createdAt: 1_700_000_000_000,
    });
    expect(written.e2eKeyB64).toBeUndefined();
    expect(written.codeIkmB64).toBeUndefined();
    // parsePendingConfig round-trips it; parseConfig (completed-only) rejects it.
    const pending = parsePendingConfig(JSON.stringify(written));
    expect(pending?.pairingId).toBe(EXPECTED_PAIRING_ID);
    expect(pending?.qrSecret).toEqual(QR_SECRET);

    // Owner-only — qrSecret is key material.
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);

    // The page: self-contained HTML with the inline QR SVG; written 0600 (embeds the QR secret).
    const html = await readFile(htmlPath, "utf8");
    expect(html).toContain("<title>Pair with Nomo</title>");
    expect(html).toContain("<svg");
    expect((await stat(htmlPath)).mode & 0o777).toBe(0o600);

    const out = lines.join("\n");
    expect(out).toContain("Pairing page opened in your browser.");
    expect(out).toContain("expires in 10 minutes");
    expect(out).not.toContain("Paired with"); // no completion in the start phase

    // SECURITY: nothing secret is printed to stdout — no QR art, no nomo:// link (they live on the page).
    expect(out).not.toContain("█");
    expect(out).not.toContain(buildPairURL(WORKER, EXPECTED_PAIRING_ID, QR_SECRET));
    expect(out).not.toContain("nomo://pair");
  });

  test("with a channel: mints the magic code, persists codeIkm, shows the code on the page (never on stdout)", async () => {
    const htmlPath = join(dir, PAIR_HTML_FILE);
    const words = ["koala", "sunset", "mango", "river"];
    const { fn } = scriptedFetch([() => json({ channel: 7 }, 201)]);

    const code = await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: () => {}, now: () => 1_700_000_000_000,
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath, openFile: () => true, pickWords: () => words, isTTY: false, // non-TTY (agent Bash tool)
    });
    expect(code).toBe(0);

    // The codeIkm is persisted (b64url of the PBKDF2 output) so wait/watchdog complete a code claim.
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const expectedIkm = await deriveCodeIkm(words, EXPECTED_PAIRING_ID);
    expect(written.codeIkmB64).toBe(b64url(expectedIkm));
    const pending = parsePendingConfig(JSON.stringify(written));
    expect(pending?.codeIkm).toEqual(expectedIkm);

    // The full code (`<channel>-w1-w2-w3-w4`) appears on the page…
    const html = await readFile(htmlPath, "utf8");
    expect(html).toContain("7-koala-sunset-mango-river");
    // …and the page bakes the live-status poll params (worker/pairing/pcSecret) so it self-updates.
    expect(html).toContain(`/v1/cc/pair/status?p=`);
    expect(html).toContain(EXPECTED_PC_SECRET);
    // …but the code is NEVER on stdout on a non-TTY (agent transcript).
    expect(lines.join("\n")).not.toContain("koala");
    expect(lines.join("\n")).not.toContain("7-koala");
  });

  // --- Feature 1: one-time code on stdout is TTY-gated (+ --show-code override) --------------------
  test("prints the one-time code to stdout when stdout is an interactive TTY", async () => {
    const words = ["koala", "sunset", "mango", "river"];
    const { fn } = scriptedFetch([() => json({ channel: 7 }, 201)]);
    await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: () => {},
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath: join(dir, PAIR_HTML_FILE), openFile: () => true, pickWords: () => words,
      isTTY: true, // the user ran `pair` directly in a real terminal
    });
    expect(lines.join("\n")).toContain("One-time code: 7-koala-sunset-mango-river · expires in 10 min");
  });

  test("does NOT print the code on a non-TTY without --show-code (agent Bash tool / pipe)", async () => {
    const words = ["koala", "sunset", "mango", "river"];
    const { fn } = scriptedFetch([() => json({ channel: 7 }, 201)]);
    await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: () => {},
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath: join(dir, PAIR_HTML_FILE), openFile: () => true, pickWords: () => words,
      isTTY: false, showCode: false,
    });
    expect(lines.join("\n")).not.toContain("One-time code");
    expect(lines.join("\n")).not.toContain("koala");
  });

  test("--show-code (showCode) forces the code onto stdout even on a non-TTY (SSH/headless)", async () => {
    const words = ["koala", "sunset", "mango", "river"];
    const { fn } = scriptedFetch([() => json({ channel: 7 }, 201)]);
    await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: () => {},
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath: join(dir, PAIR_HTML_FILE), openFile: () => true, pickWords: () => words,
      isTTY: false, showCode: true,
    });
    expect(lines.join("\n")).toContain("One-time code: 7-koala-sunset-mango-river · expires in 10 min");
  });

  test("QR-only (no channel from the worker) → no code to print even on a TTY / with --show-code", async () => {
    const { fn } = scriptedFetch([() => json({ ok: true }, 201)]); // no channel → no code
    await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: () => {},
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath: join(dir, PAIR_HTML_FILE), openFile: () => true, isTTY: true, showCode: true,
    });
    expect(lines.join("\n")).not.toContain("One-time code");
  });

  test("falls back to printing the page path when the browser opener declines (headless / NOMO_NO_OPEN)", async () => {
    const htmlPath = join(dir, PAIR_HTML_FILE);
    const { fn } = scriptedFetch([() => json({ ok: true }, 201)]);
    expect(await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: () => {},
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath, openFile: () => false,
    })).toBe(0);
    expect(await readFile(htmlPath, "utf8")).toContain("<svg"); // still written for the user to open
    expect(lines.join("\n")).toContain(`Open this file in a browser: ${htmlPath}`);
  });

  test("removes a stale pairing page from a prior attempt at the start", async () => {
    const htmlPath = join(dir, PAIR_HTML_FILE);
    await writeFile(htmlPath, "<html>stale secret from a previous pairing</html>");
    const { fn } = scriptedFetch([() => json({ ok: true }, 201)]);
    expect(await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: () => {},
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath, openFile: () => true,
    })).toBe(0);
    // Overwritten with the fresh page (the stale content is gone).
    expect(await readFile(htmlPath, "utf8")).not.toContain("stale secret");
  });
});

// ---------- pairWait (phase 2: polls until claimed) -----------------------------------------------

describe("pairWait (happy path)", () => {
  test("pending → claimed → ack, exact completed config, derived key, printed name, qrSecret dropped", async () => {
    await writePending();
    // The "phone": derives the same key from the QR secret + its nonce, encrypts its name.
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("Karrix's iPhone")));

    const { fn, calls } = scriptedFetch([
      (url, init) => {
        expect(url).toBe(`${WORKER}/v1/cc/pair/status?p=${EXPECTED_PAIRING_ID}`);
        expect((init?.headers as Record<string, string>)["x-cc-auth"]).toBe(EXPECTED_PC_SECRET);
        return json({ state: "pending" });
      },
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      (url, init) => {
        expect(url).toBe(`${WORKER}/v1/cc/pair/ack`);
        expect(init?.method).toBe("POST");
        const h = init?.headers as Record<string, string>;
        expect(h["x-cc-pairing"]).toBe(EXPECTED_PAIRING_ID);
        expect(h["x-cc-auth"]).toBe(EXPECTED_PC_SECRET);
        return json({ ok: true });
      },
    ]);

    const code = await pairWait({ fetchFn: fn, sleep, print, configPath });

    expect(code).toBe(0);
    expect(calls.length).toBe(3); // status x2, ack — no start (that was phase 1)

    // COMPLETED config: qrSecret dropped, e2eKey present, independently re-derived by the test.
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, string>;
    expect(written).toEqual({
      url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET, e2eKeyB64: b64url(phoneKey),
    });
    expect(written.qrSecretB64).toBeUndefined();
    expect(fromB64url(written.e2eKeyB64).length).toBe(32);

    // Still owner-only after the rewrite.
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);

    // One 3 s sleep — after the single "pending" poll; none after "claimed".
    expect(sleeps).toEqual([3000]);
    expect(lines.join("\n")).toContain("Paired with Karrix's iPhone ✓");
  });

  test("ack is retried up to 3 times on persistent failure; pairing still succeeds", async () => {
    await writePending();
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("P")));
    let ackAttempts = 0;
    const { fn, calls } = scriptedFetch([
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      () => { ackAttempts++; throw new Error("ECONNRESET"); },
      () => { ackAttempts++; throw new Error("ECONNRESET"); },
      () => { ackAttempts++; throw new Error("ECONNRESET"); },
    ]);

    const code = await pairWait({ fetchFn: fn, sleep, print, configPath });

    expect(code).toBe(0); // still best-effort/non-fatal
    expect(ackAttempts).toBe(3);
    expect(calls.length).toBe(4); // status, 3x ack
    for (const c of calls.slice(1)) expect(c.url).toBe(`${WORKER}/v1/cc/pair/ack`);
    expect(lines.join("\n")).toContain("Paired with P ✓");
  });

  test("no pending config at all → clear one-line error, non-zero exit", async () => {
    const { fn, calls } = scriptedFetch([]);
    expect(await pairWait({ fetchFn: fn, sleep, print, configPath })).toBe(1);
    expect(calls.length).toBe(0);
    expect(lines.join("\n")).toContain("No pairing in progress");
  });

  test("an ALREADY-completed config → says so, exit 0, no network", async () => {
    await writeFile(configPath, JSON.stringify({
      url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET, e2eKeyB64: b64url(new Uint8Array(32).fill(4)),
    }));
    const { fn, calls } = scriptedFetch([]);
    expect(await pairWait({ fetchFn: fn, sleep, print, configPath })).toBe(0);
    expect(calls.length).toBe(0);
    expect(lines.join("\n")).toContain("already paired");
  });

  test("a concurrent completer (watchdog) finished first: a 404 poll but a completed config → success", async () => {
    await writePending();
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const { fn } = scriptedFetch([
      async () => {
        // Simulate the watchdog completing under us just before this poll resolves 404.
        await writeFile(configPath, JSON.stringify({
          url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET, e2eKeyB64: b64url(phoneKey),
        }));
        return json({ error: "not found" }, 404);
      },
    ]);
    expect(await pairWait({ fetchFn: fn, sleep, print, configPath })).toBe(0);
    expect(lines.join("\n")).toContain("Paired ✓");
  });

  test("the watchdog completes the config UNDER a mid-poll wait → the top-of-loop re-read succeeds (no false expiry)", async () => {
    await writePending();
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    // Our own poll still sees "pending" (the ack hadn't landed yet), but the watchdog writes the
    // completed config to disk. The next iteration's top-of-loop re-read spots it and succeeds.
    const { fn, calls } = scriptedFetch([
      async () => {
        await writeFile(configPath, JSON.stringify({
          url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET,
          e2eKeyB64: b64url(phoneKey), machineName: "Studio",
        }));
        return json({ state: "pending" });
      },
    ]);
    expect(await pairWait({ fetchFn: fn, sleep, print, configPath })).toBe(0);
    expect(calls.length).toBe(1); // one poll only — the re-read short-circuits the rest of the window
    expect(lines.join("\n")).toContain("Paired with Studio ✓");
  });

  test("a nonce-stripped 'claimed' poll (already acked) with a completed config on disk → success", async () => {
    await writePending();
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const { fn } = scriptedFetch([
      async () => {
        await writeFile(configPath, JSON.stringify({
          url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET, e2eKeyB64: b64url(phoneKey),
        }));
        return json({ state: "claimed" }); // server stripped phoneNonce/deviceNameEnc after ack
      },
    ]);
    expect(await pairWait({ fetchFn: fn, sleep, print, configPath })).toBe(0);
    expect(lines.join("\n")).toContain("Paired ✓");
  });

  test("a nonce-stripped 'claimed' poll but NO completed config on disk (unrecoverable) → fails + cleans up, no spin", async () => {
    await writePending();
    const { fn, calls } = scriptedFetch([() => json({ state: "claimed" })]);
    expect(await pairWait({ fetchFn: fn, sleep, print, configPath })).toBe(1);
    expect(calls.length).toBe(1); // does NOT keep polling to the 10-min timeout
    await expect(stat(configPath)).rejects.toBeDefined(); // stale pending config removed
    expect(sleeps).toEqual([]); // no polling loop
  });
});

// ---------- pending-pairing stash flush (completePendingPairing, via pairWait) --------------------
//
// A CC hook that fires WHILE pairing is pending stashes its plaintext event next to config.json (it
// has no e2eKey yet). completePendingPairing must flush it — encrypt under the freshly-derived key,
// POST /v1/cc/event — the instant it completes, so the phone sees the pairing session without waiting
// for the PC's next hook. Exercised through pairWait (a real completer). See cc-status.test.ts for the
// stash-WRITE side.
describe("pairWait flushes a pending-pairing event stash on completion", () => {
  /** Write the stash pairStart's sibling hook would have left, in the same dir as configPath. */
  async function writeStash(over: Record<string, unknown> = {}): Promise<void> {
    await writeFile(join(dir, PENDING_STASH_FILE), JSON.stringify({
      sessionId: "pair-sess", op: "done", prio: 0, stashedAt: Date.now(),
      blob: { status: "done", title: "the pairing turn", machine: "MacHost", label: "api-status" },
      ...over,
    }));
  }

  test("a fresh stash → encrypted /v1/cc/event POST after the ack, then the stash is deleted", async () => {
    await writePending();
    await writeStash();
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("iPhone")));

    const { fn, calls } = scriptedFetch([
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      (url) => { expect(url).toBe(`${WORKER}/v1/cc/pair/ack`); return json({ ok: true }); },
      async (url, init) => {
        expect(url).toBe(`${WORKER}/v1/cc/event`);
        expect(init?.method).toBe("POST");
        const h = init?.headers as Record<string, string>;
        expect(h["x-cc-pairing"]).toBe(EXPECTED_PAIRING_ID);
        expect(h["x-cc-auth"]).toBe(EXPECTED_PC_SECRET);
        const body = JSON.parse(String(init?.body)) as { v: number; sessionId: string; op: string; prio: number; blob: string };
        expect(body).toMatchObject({ v: 2, sessionId: "pair-sess", op: "done", prio: 0 });
        // The blob decrypts under the same key the phone derived — the worker never sees plaintext.
        expect(await decryptBlob(phoneKey, body.blob)).toEqual({
          status: "done", title: "the pairing turn", machine: "MacHost", label: "api-status",
        });
        return json({ ok: true });
      },
    ]);

    expect(await pairWait({ fetchFn: fn, sleep, print, configPath })).toBe(0);
    expect(calls.length).toBe(3); // status(claimed), ack, event — the flush is the third
    await expect(stat(join(dir, PENDING_STASH_FILE))).rejects.toBeDefined(); // one-shot: stash consumed
  });

  test("a stale stash (older than the 10-min QR TTL) is dropped, not posted", async () => {
    await writePending();
    await writeStash({ stashedAt: Date.now() - 700_000 }); // past PENDING_STASH_STALE_MS
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("iPhone")));

    const { fn, calls } = scriptedFetch([
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      (url) => { expect(url).toBe(`${WORKER}/v1/cc/pair/ack`); return json({ ok: true }); },
    ]);

    expect(await pairWait({ fetchFn: fn, sleep, print, configPath })).toBe(0);
    expect(calls.length).toBe(2); // status, ack — NO event POST for a ghost stash
    await expect(stat(join(dir, PENDING_STASH_FILE))).rejects.toBeDefined(); // dropped, not left behind
  });

  test("no stash at all → pairing completes with no extra POST", async () => {
    await writePending();
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("iPhone")));

    const { fn, calls } = scriptedFetch([
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      (url) => { expect(url).toBe(`${WORKER}/v1/cc/pair/ack`); return json({ ok: true }); },
    ]);

    expect(await pairWait({ fetchFn: fn, sleep, print, configPath })).toBe(0);
    expect(calls.length).toBe(2); // status, ack — nothing to flush
  });
});

describe("buildPairURL", () => {
  test("encodes the worker URL (b64url utf8), pairing id (hex), and QR secret (b64url)", () => {
    const url = buildPairURL(WORKER, EXPECTED_PAIRING_ID, QR_SECRET);
    const params = new URL(url.replace("nomo://", "https://nomo/")).searchParams;
    expect(params.get("v")).toBe("1");
    expect(new TextDecoder().decode(fromB64url(params.get("u")!))).toBe(WORKER);
    expect(params.get("p")).toBe(EXPECTED_PAIRING_ID);
    expect(fromB64url(params.get("s")!)).toEqual(QR_SECRET);
  });

  test("OMITS `u` when the worker URL is the production default (the QR-shrink lever)", () => {
    const url = buildPairURL(DEFAULT_WORKER_URL, EXPECTED_PAIRING_ID, QR_SECRET);
    expect(url).not.toContain("&u=");
    const params = new URL(url.replace("nomo://", "https://nomo/")).searchParams;
    expect(params.get("u")).toBeNull();
    // The other params are untouched — only `u` drops out.
    expect(params.get("v")).toBe("1");
    expect(params.get("p")).toBe(EXPECTED_PAIRING_ID);
    expect(fromB64url(params.get("s")!)).toEqual(QR_SECRET);
    // The shortened default payload is meaningfully smaller than the explicit-`u` form.
    expect(url.length).toBeLessThan(buildPairURL(WORKER, EXPECTED_PAIRING_ID, QR_SECRET).length);
  });

  test("still emits `u` for a non-default (self-hosted) worker URL", () => {
    const selfHosted = "https://cc.example.com";
    const url = buildPairURL(selfHosted, EXPECTED_PAIRING_ID, QR_SECRET);
    expect(url).toContain("&u=");
    const params = new URL(url.replace("nomo://", "https://nomo/")).searchParams;
    expect(new TextDecoder().decode(fromB64url(params.get("u")!))).toBe(selfHosted);
  });
});

describe("decryptDeviceName tolerance", () => {
  const key = new Uint8Array(32).fill(9);

  test("JSON-encoded string plaintext (the contract)", async () => {
    const blob = await seal(key, new TextEncoder().encode(JSON.stringify("Karrix's iPhone")));
    expect(await decryptDeviceName(key, blob)).toBe("Karrix's iPhone");
  });
  test("raw UTF-8 plaintext (tolerant fallback)", async () => {
    const blob = await seal(key, new TextEncoder().encode("Plain Phone"));
    expect(await decryptDeviceName(key, blob)).toBe("Plain Phone");
  });
  test("wrong key rejects (GCM tag check)", async () => {
    const blob = await seal(key, new TextEncoder().encode(JSON.stringify("x")));
    await expect(decryptDeviceName(new Uint8Array(32).fill(1), blob)).rejects.toBeDefined();
  });
});

describe("pairStart (failure paths — one friendly line, non-zero exit, no config written)", () => {
  const startDeps = () => ({
    print, configPath, workerUrl: WORKER, spawnWatchdog: () => {},
    randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
  });

  test("429 on start → rate-limit message, no QR, no config", async () => {
    const { fn } = scriptedFetch([() => json({ error: "rate limited" }, 429)]);
    expect(await pairStart({ ...startDeps(), fetchFn: fn })).toBe(1);
    expect(lines.join("\n")).toContain("Too many pairing attempts");
    expect(lines.join("\n")).not.toContain("█");
    await expect(stat(configPath)).rejects.toBeDefined();
  });

  test("409 on start → collision message", async () => {
    const { fn } = scriptedFetch([() => json({ error: "already claimed" }, 409)]);
    expect(await pairStart({ ...startDeps(), fetchFn: fn })).toBe(1);
    expect(lines.join("\n")).toContain("collision");
  });

  test("network failure on start → unreachable message naming the worker", async () => {
    const { fn } = scriptedFetch([() => { throw new Error("ECONNREFUSED"); }]);
    expect(await pairStart({ ...startDeps(), fetchFn: fn })).toBe(1);
    expect(lines.join("\n")).toContain(`Could not reach the worker at ${WORKER}`);
  });
});

describe("pairWait (failure / retry paths)", () => {
  const waitDeps = () => ({ sleep, print, configPath });

  test("404 while polling (pending record expired, config still pending) → expired message + stale config removed", async () => {
    await writePending();
    const { fn } = scriptedFetch([() => json({ error: "not found" }, 404)]);
    expect(await pairWait({ ...waitDeps(), fetchFn: fn })).toBe(1);
    expect(lines.join("\n")).toContain("expired or was removed");
    // The genuinely-gone pending config is cleaned up so /status reports unpaired, not "waiting".
    await expect(stat(configPath)).rejects.toBeDefined();
  });

  test("timeout: polls every interval until the window closes, then gives up (no real waits)", async () => {
    await writePending();
    const steps: (() => Response)[] = [];
    for (let i = 0; i < 3; i++) steps.push(() => json({ state: "pending" }));
    const { fn, calls } = scriptedFetch(steps);
    const code = await pairWait({ ...waitDeps(), fetchFn: fn, pollIntervalMs: 3000, maxWaitMs: 9000 });
    expect(code).toBe(1);
    expect(calls.length).toBe(3); // 3 polls (at t=0, 3, 6; window closes at 9) — no start in wait
    expect(sleeps).toEqual([3000, 3000, 3000]);
    expect(lines.join("\n")).toContain("Pairing window expired");
    // The pending config is left in place (not clobbered) so a re-run can resume/retry.
    expect(parsePendingConfig(await readFile(configPath, "utf8"))).not.toBeNull();
  });

  test("wait --timeout (softTimeoutMs): no claim within the bound → SOFT exit 0 with the background-waiting line", async () => {
    await writePending();
    const steps: (() => Response)[] = [];
    for (let i = 0; i < 2; i++) steps.push(() => json({ state: "pending" }));
    const { fn, calls } = scriptedFetch(steps);
    // A 6s soft bound at a 3s poll → two polls (t=0, 3), then the loop closes at 6 — well under the
    // real 10-min TTL, so it's the Codex "still waiting in the background" soft exit, not a failure.
    const code = await pairWait({ ...waitDeps(), fetchFn: fn, pollIntervalMs: 3000, softTimeoutMs: 6000 });
    expect(code).toBe(0); // NOT an error — self-heal finishes in the background
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([3000, 3000]);
    const out = lines.join("\n");
    expect(out).toContain("Still waiting for the scan");
    expect(out).not.toContain("Pairing window expired");
    // The pending config is untouched — the QR is still live for its full 10 minutes.
    expect(parsePendingConfig(await readFile(configPath, "utf8"))).not.toBeNull();
  });

  test("transient network blips while polling are retried, not fatal", async () => {
    await writePending();
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("P")));
    const { fn } = scriptedFetch([
      () => { throw new Error("ETIMEDOUT"); },
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      () => json({ ok: true }),
    ]);
    expect(await pairWait({ ...waitDeps(), fetchFn: fn })).toBe(0);
    expect(lines.join("\n")).toContain("Paired with P ✓");
  });

  test("a per-request timeout (AbortError) on a status poll is a transient blip too, not fatal", async () => {
    await writePending();
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("P")));
    const abortError = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const { fn } = scriptedFetch([
      () => { throw abortError; }, // shape of a fetch rejecting because AbortSignal.timeout() fired
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      () => json({ ok: true }),
    ]);
    expect(await pairWait({ ...waitDeps(), fetchFn: fn })).toBe(0);
    expect(lines.join("\n")).toContain("Paired with P ✓");
  });

  test("a tampered claim (undecryptable response) → tampered message, config NOT completed", async () => {
    await writePending();
    // Seal the name under a DIFFERENT key than the QR secret derives → GCM tag check fails.
    const wrongKey = new Uint8Array(32).fill(1);
    const deviceNameEnc = await seal(wrongKey, new TextEncoder().encode(JSON.stringify("Evil")));
    const { fn } = scriptedFetch([
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
    ]);
    expect(await pairWait({ ...waitDeps(), fetchFn: fn })).toBe(1);
    expect(lines.join("\n")).toContain("tampered");
    // Still pending — no bogus key was persisted.
    expect(parsePendingConfig(await readFile(configPath, "utf8"))).not.toBeNull();
  });
});

describe("pairStart (re-pairing over an existing config)", () => {
  test("revokes the OLD *completed* pairing before starting fresh, then writes a pending config", async () => {
    const oldKey = b64url(new Uint8Array(32).fill(3));
    await writeFile(configPath, JSON.stringify({
      url: "https://old-worker.test", pairingId: "f".repeat(32), pcSecret: "old-secret", e2eKeyB64: oldKey,
    }));

    const { fn, calls } = scriptedFetch([
      (url, init) => {
        expect(url).toBe("https://old-worker.test/v1/cc/pair/revoke");
        const h = init?.headers as Record<string, string>;
        expect(h["x-cc-pairing"]).toBe("f".repeat(32));
        expect(h["x-cc-auth"]).toBe("old-secret");
        return json({ ok: true });
      },
      () => json({ ok: true }, 201),
    ]);

    const code = await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: () => {},
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath: join(dir, PAIR_HTML_FILE), openFile: () => true,
    });
    expect(code).toBe(0);
    expect(calls[0].url).toContain("/pair/revoke");
    expect(calls[1].url).toContain("/pair/start");

    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, string>;
    expect(written.pairingId).toBe(EXPECTED_PAIRING_ID);
    expect(written.url).toBe(WORKER);
    expect(written.qrSecretB64).toBe(b64url(QR_SECRET));
    expect(written.e2eKeyB64).toBeUndefined();
  });

  test("revokes the OLD *pending* pairing too before starting fresh (an abandoned mid-pairing record still owns a claimable server-side record)", async () => {
    // writePending's default pcSecret (EXPECTED_PC_SECRET) is the auth material revoke presents.
    await writePending({ pairingId: "c".repeat(32), qrSecretB64: b64url(new Uint8Array(16).fill(7)) });
    const { fn, calls } = scriptedFetch([
      (url, init) => {
        expect(url).toBe(`${WORKER}/v1/cc/pair/revoke`);
        expect(init?.method).toBe("POST");
        const h = init?.headers as Record<string, string>;
        expect(h["x-cc-pairing"]).toBe("c".repeat(32)); // the OLD pending pairingId, not the fresh one
        expect(h["x-cc-auth"]).toBe(EXPECTED_PC_SECRET);
        return json({ ok: true });
      },
      () => json({ ok: true }, 201),
    ]);
    expect(await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: () => {},
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath: join(dir, PAIR_HTML_FILE), openFile: () => true,
    })).toBe(0);
    expect(calls.length).toBe(2); // revoke (of the old pending) THEN start
    expect(calls[0].url).toContain("/pair/revoke");
    expect(calls[1].url).toContain("/pair/start");
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, string>;
    expect(written.pairingId).toBe(EXPECTED_PAIRING_ID); // overwritten with the fresh pairing
  });

  test("a failing revoke of an old PENDING pairing does not block re-pairing", async () => {
    await writePending({ pairingId: "c".repeat(32) });
    const { fn, calls } = scriptedFetch([
      () => { throw new Error("worker unreachable"); }, // revoke of the old pending fails
      () => json({ ok: true }, 201), // start still proceeds
    ]);
    expect(await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: () => {},
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath: join(dir, PAIR_HTML_FILE), openFile: () => true,
    })).toBe(0);
    expect(calls.length).toBe(2);
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, string>;
    expect(written.pairingId).toBe(EXPECTED_PAIRING_ID);
  });

  test("a failing revoke of the old pairing does not block re-pairing", async () => {
    await writeFile(configPath, JSON.stringify({
      url: "https://old-worker.test", pairingId: "e".repeat(32), pcSecret: "s", e2eKeyB64: b64url(new Uint8Array(32)),
    }));
    const { fn } = scriptedFetch([
      () => { throw new Error("old worker gone"); },
      () => json({ ok: true }, 201),
    ]);
    expect(await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: () => {},
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath: join(dir, PAIR_HTML_FILE), openFile: () => true,
    })).toBe(0);
  });

  test("re-pairing over a pre-existing config with loose permissions locks the pending config to 0600", async () => {
    await writeFile(configPath, JSON.stringify({
      url: "https://old-worker.test", pairingId: "d".repeat(32), pcSecret: "s", e2eKeyB64: b64url(new Uint8Array(32)),
    }));
    await chmod(configPath, 0o644); // simulate a config written before the world-readable fix
    expect((await stat(configPath)).mode & 0o777).toBe(0o644);

    const { fn } = scriptedFetch([
      () => json({ ok: true }), // revoke
      () => json({ ok: true }, 201), // start
    ]);
    expect(await pairStart({
      fetchFn: fn, print, configPath, workerUrl: WORKER, spawnWatchdog: () => {},
      randomBytes: scriptedRandom([PAIRING_BYTES, PC_SECRET_BYTES, QR_SECRET]),
      htmlPath: join(dir, PAIR_HTML_FILE), openFile: () => true,
    })).toBe(0);

    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });
});

// ---------- parsePendingConfig ---------------------------------------------------------------------

describe("parsePendingConfig", () => {
  const pendingRaw = (over: Record<string, unknown> = {}) => JSON.stringify({
    url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET, qrSecretB64: b64url(QR_SECRET), ...over,
  });

  test("parses a valid pending config, decoding the 16-byte qrSecret and trimming a trailing slash", () => {
    const p = parsePendingConfig(pendingRaw({ url: `${WORKER}/` }));
    expect(p).not.toBeNull();
    expect(p!.url).toBe(WORKER);
    expect(p!.pairingId).toBe(EXPECTED_PAIRING_ID);
    expect(p!.pcSecret).toBe(EXPECTED_PC_SECRET);
    expect(p!.qrSecret).toEqual(QR_SECRET);
  });

  test("a COMPLETED config (has e2eKeyB64) is NOT pending → null (parseConfig owns it)", () => {
    expect(parsePendingConfig(JSON.stringify({
      url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET, e2eKeyB64: b64url(new Uint8Array(32)),
    }))).toBeNull();
    // even if BOTH are present, the completed form wins (never treated as pending)
    expect(parsePendingConfig(pendingRaw({ e2eKeyB64: b64url(new Uint8Array(32)) }))).toBeNull();
  });

  test("missing any required field → null", () => {
    expect(parsePendingConfig(JSON.stringify({ url: WORKER, pairingId: "x", pcSecret: "y" }))).toBeNull(); // no qrSecretB64
    expect(parsePendingConfig(JSON.stringify({ pairingId: "x", pcSecret: "y", qrSecretB64: b64url(QR_SECRET) }))).toBeNull();
  });

  test("a qrSecret that does not decode to 16 bytes → null", () => {
    expect(parsePendingConfig(pendingRaw({ qrSecretB64: b64url(new Uint8Array(8)) }))).toBeNull();
    expect(parsePendingConfig(pendingRaw({ qrSecretB64: b64url(new Uint8Array(32)) }))).toBeNull();
  });

  test("not JSON / not an object → null", () => {
    expect(parsePendingConfig("not json")).toBeNull();
    expect(parsePendingConfig("42")).toBeNull();
  });
});

// ---------- completePendingPairing (the shared self-heal core) ------------------------------------

describe("completePendingPairing", () => {
  const pending = () => ({
    url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET, qrSecret: QR_SECRET,
  });

  test("pending state → { state: 'pending' }, no config written", async () => {
    const { fn, calls } = scriptedFetch([() => json({ state: "pending" })]);
    const r = await completePendingPairing(pending(), configPath, { fetchFn: fn });
    expect(r.state).toBe("pending");
    expect(calls.length).toBe(1);
    await expect(stat(configPath)).rejects.toBeDefined();
  });

  test("claimed → completes: writes 0600 completed config, acks, returns the device name (self-heal core)", async () => {
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("Watchdog Phone")));
    const { fn, calls } = scriptedFetch([
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      (url) => { expect(url).toBe(`${WORKER}/v1/cc/pair/ack`); return json({ ok: true }); },
    ]);
    const r = await completePendingPairing(pending(), configPath, { fetchFn: fn, ackAttempts: 1 });
    expect(r).toEqual({ state: "completed", deviceName: "Watchdog Phone" });
    expect(calls.length).toBe(2); // status + ack
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, string>;
    expect(written).toEqual({
      url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET, e2eKeyB64: b64url(phoneKey),
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  test("deletes the transient pairing page on completion (covers the watchdog self-heal path)", async () => {
    const htmlPath = join(dir, PAIR_HTML_FILE);
    await writeFile(htmlPath, "<html>the pairing QR secret + code</html>"); // what pair left next to config
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("P")));
    const { fn } = scriptedFetch([
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      () => json({ ok: true }),
    ]);
    expect((await completePendingPairing(pending(), configPath, { fetchFn: fn, ackAttempts: 1 })).state).toBe("completed");
    await expect(stat(htmlPath)).rejects.toBeDefined(); // the secret-bearing page is gone
  });

  test("preserves a machineName from the pending config into the completed one", async () => {
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("P")));
    const { fn } = scriptedFetch([
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      () => json({ ok: true }),
    ]);
    await completePendingPairing({ ...pending(), machineName: "Studio" }, configPath, { fetchFn: fn, ackAttempts: 1 });
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, string>;
    expect(written.machineName).toBe("Studio");
  });

  test("a code-path claim (path:'code') derives the key from codeIkm, not qrSecret", async () => {
    const codeIkm = new Uint8Array(32).fill(9);
    const phoneKey = await deriveE2EKey(codeIkm, PHONE_NONCE); // the phone reconstructed codeIkm from the words
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("Code Phone")));
    const { fn } = scriptedFetch([
      () => json({ state: "claimed", path: "code", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      () => json({ ok: true }),
    ]);
    const r = await completePendingPairing({ ...pending(), codeIkm }, configPath, { fetchFn: fn, ackAttempts: 1 });
    expect(r).toEqual({ state: "completed", deviceName: "Code Phone" });
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, string>;
    expect(written.e2eKeyB64).toBe(b64url(phoneKey)); // keyed off codeIkm, matching the phone
  });

  test("a code-path claim with NO stored codeIkm (QR-only config) → tampered, no config written", async () => {
    const codeIkm = new Uint8Array(32).fill(9);
    const phoneKey = await deriveE2EKey(codeIkm, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("x")));
    const { fn } = scriptedFetch([
      () => json({ state: "claimed", path: "code", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
    ]);
    // pending() has no codeIkm → a code claim cannot be completed.
    expect((await completePendingPairing(pending(), configPath, { fetchFn: fn })).state).toBe("tampered");
    await expect(stat(configPath)).rejects.toBeDefined();
  });

  test("a claimed poll with the nonce stripped (already acked by a concurrent completer) → { state: 'already-completed' }, no config written", async () => {
    const { fn } = scriptedFetch([() => json({ state: "claimed" })]); // no phoneNonce / deviceNameEnc
    const r = await completePendingPairing(pending(), configPath, { fetchFn: fn });
    expect(r.state).toBe("already-completed");
    await expect(stat(configPath)).rejects.toBeDefined();
  });

  test("404 → { state: 'gone' }, no config written", async () => {
    const { fn } = scriptedFetch([() => json({ error: "not found" }, 404)]);
    expect((await completePendingPairing(pending(), configPath, { fetchFn: fn })).state).toBe("gone");
    await expect(stat(configPath)).rejects.toBeDefined();
  });

  test("non-404 error → { state: 'rejected', httpStatus }", async () => {
    const { fn } = scriptedFetch([() => json({ error: "boom" }, 500)]);
    const r = await completePendingPairing(pending(), configPath, { fetchFn: fn });
    expect(r).toEqual({ state: "rejected", httpStatus: 500 });
  });

  test("network failure → { state: 'network' }", async () => {
    const { fn } = scriptedFetch([() => { throw new Error("down"); }]);
    expect((await completePendingPairing(pending(), configPath, { fetchFn: fn })).state).toBe("network");
  });

  test("a tampered claim (wrong key) → { state: 'tampered' }, no config written", async () => {
    const deviceNameEnc = await seal(new Uint8Array(32).fill(1), new TextEncoder().encode(JSON.stringify("Evil")));
    const { fn } = scriptedFetch([
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
    ]);
    expect((await completePendingPairing(pending(), configPath, { fetchFn: fn })).state).toBe("tampered");
    await expect(stat(configPath)).rejects.toBeDefined();
  });
});

// ---------- stash flush: pid-liveness gate + watchdog attach --------------------------------------
//
// The field-reported "ghost done-session" bug: a stash written by a hook of session X, whose terminal
// the user closed while pairing was still pending (X's later hooks no-op'd, so no watchdog was ever
// attached) — the flush would post X anyway, resurrecting a "done" row nothing ever ends. The fix: the
// stash records X's `claude` pid, and the flush probes it. Dead → drop silently. Alive → post AND
// attach the watchdog (write a session record + ensure the poller) so a later terminal close ends it.
// Seams (isAlive / ensureWatchdog / sessionsDir) are injected so the test never touches a real pid or
// spawns a real poller, and works whether the flush is driven by `pair wait` or the watchdog self-heal.
describe("completePendingPairing stash flush — pid-liveness gate + watchdog attach", () => {
  const pending = () => ({ url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET, qrSecret: QR_SECRET });

  async function writeStash(over: Record<string, unknown> = {}): Promise<void> {
    await writeFile(join(dir, PENDING_STASH_FILE), JSON.stringify({
      sessionId: "pair-sess", op: "done", prio: 0, stashedAt: Date.now(), pid: 4242,
      blob: { status: "done", title: "the pairing turn", machine: "MacHost", label: "api-status" },
      ...over,
    }));
  }

  test("a LIVE stashed session → flush posts it, writes a session record, and ensures the watchdog", async () => {
    await writeStash({ pid: 4242 });
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("iPhone")));
    const sessionsDir = join(dir, "sessions");
    let ensured = 0;
    const probed: number[] = [];

    const { fn, calls } = scriptedFetch([
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      (url) => { expect(url).toBe(`${WORKER}/v1/cc/pair/ack`); return json({ ok: true }); },
      async (url, init) => {
        expect(url).toBe(`${WORKER}/v1/cc/event`);
        const body = JSON.parse(String(init?.body)) as { v: number; sessionId: string; op: string; blob: string };
        expect(body).toMatchObject({ v: 2, sessionId: "pair-sess", op: "done", prio: 0 });
        expect(await decryptBlob(phoneKey, body.blob)).toMatchObject({ status: "done", machine: "MacHost", label: "api-status" });
        return json({ ok: true });
      },
    ]);

    const r = await completePendingPairing(pending(), configPath, {
      fetchFn: fn, ackAttempts: 1, sleep, sessionsDir,
      isAlive: (pid) => { probed.push(pid); return true; },
      ensureWatchdog: () => { ensured++; },
    });

    expect(r.state).toBe("completed");
    expect(calls.length).toBe(3); // status, ack, event — the live stash was flushed
    expect(probed).toEqual([4242]); // liveness probed the stashed session's pid
    expect(ensured).toBe(1); // watchdog ensured so a later terminal close ends the session

    // A SessionRecord was written (like trackSession) so the watchdog reaps it on a later close.
    const rec = JSON.parse(await readFile(join(sessionsDir, "pair-sess.json"), "utf8")) as Record<string, unknown>;
    expect(rec).toMatchObject({ pid: 4242, op: "done", sentDone: true, machine: "MacHost", label: "api-status" });
    expect(typeof rec.blob).toBe("string");
    await expect(stat(join(dir, PENDING_STASH_FILE))).rejects.toBeDefined(); // one-shot: stash consumed
  });

  test("a DEAD stashed session → flush DROPS it silently: no event POST, no record, no watchdog", async () => {
    await writeStash({ pid: 5555 });
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("iPhone")));
    const sessionsDir = join(dir, "sessions");
    let ensured = 0;

    const { fn, calls } = scriptedFetch([
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      (url) => { expect(url).toBe(`${WORKER}/v1/cc/pair/ack`); return json({ ok: true }); },
    ]);

    const r = await completePendingPairing(pending(), configPath, {
      fetchFn: fn, ackAttempts: 1, sleep, sessionsDir,
      isAlive: () => false, // the terminal that stashed this was closed mid-pairing
      ensureWatchdog: () => { ensured++; },
    });

    expect(r.state).toBe("completed"); // pairing itself still succeeds
    expect(calls.length).toBe(2); // status, ack — NO /v1/cc/event for a ghost session
    expect(ensured).toBe(0);
    await expect(stat(join(sessionsDir, "pair-sess.json"))).rejects.toBeDefined(); // no record written
    await expect(stat(join(dir, PENDING_STASH_FILE))).rejects.toBeDefined(); // stash dropped, not left behind
  });

  test("a pid-less stash (pre-0.1.5 hook) → posts as before, but attaches no watchdog (can't verify liveness)", async () => {
    await writeStash({ pid: undefined }); // JSON.stringify drops the undefined key → no pid on disk
    const phoneKey = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const deviceNameEnc = await seal(phoneKey, new TextEncoder().encode(JSON.stringify("iPhone")));
    const sessionsDir = join(dir, "sessions");
    let ensured = 0;

    const { fn, calls } = scriptedFetch([
      () => json({ state: "claimed", phoneNonce: b64url(PHONE_NONCE), deviceNameEnc }),
      (url) => { expect(url).toBe(`${WORKER}/v1/cc/pair/ack`); return json({ ok: true }); },
      (url) => { expect(url).toBe(`${WORKER}/v1/cc/event`); return json({ ok: true }); },
    ]);

    const r = await completePendingPairing(pending(), configPath, {
      fetchFn: fn, ackAttempts: 1, sleep, sessionsDir,
      isAlive: () => { throw new Error("must not probe a pid-less stash"); },
      ensureWatchdog: () => { ensured++; },
    });

    expect(r.state).toBe("completed");
    expect(calls.length).toBe(3); // still posts the event (backward-compat)
    expect(ensured).toBe(0); // but no watchdog attach — there's no pid to track
    await expect(stat(join(sessionsDir, "pair-sess.json"))).rejects.toBeDefined(); // no record without a pid
  });
});

// ---------- unpair --------------------------------------------------------------------------------

describe("unpair", () => {
  test("revokes on the server, deletes config + last-send marker, prints Unpaired ✓", async () => {
    const lastSendPath = join(dir, "last-send");
    await writeFile(configPath, JSON.stringify({
      url: WORKER, pairingId: "a".repeat(32), pcSecret: "sec", e2eKeyB64: b64url(new Uint8Array(32).fill(2)),
    }));
    await writeFile(lastSendPath, String(Date.now()));

    const { fn, calls } = scriptedFetch([
      (url, init) => {
        expect(url).toBe(`${WORKER}/v1/cc/pair/revoke`);
        expect(init?.method).toBe("POST");
        const h = init?.headers as Record<string, string>;
        expect(h["x-cc-pairing"]).toBe("a".repeat(32));
        expect(h["x-cc-auth"]).toBe("sec");
        return json({ ok: true });
      },
    ]);

    expect(await unpair({ fetchFn: fn, print, configPath, lastSendPath })).toBe(0);
    expect(calls.length).toBe(1);
    await expect(stat(configPath)).rejects.toBeDefined();
    await expect(stat(lastSendPath)).rejects.toBeDefined();
    expect(lines.join("\n")).toContain("Revoked the pairing on the server.");
    expect(lines.at(-1)).toBe("Unpaired ✓");
  });

  test("no config → 'Not paired.', exit 0, no fetch", async () => {
    const { fn, calls } = scriptedFetch([]);
    expect(await unpair({ fetchFn: fn, print, configPath, lastSendPath: join(dir, "last-send") })).toBe(0);
    expect(calls.length).toBe(0);
    expect(lines).toEqual(["Not paired."]);
  });

  test("unreachable worker → still deletes local state, exit 0", async () => {
    await writeFile(configPath, JSON.stringify({
      url: WORKER, pairingId: "b".repeat(32), pcSecret: "s", e2eKeyB64: b64url(new Uint8Array(32)),
    }));
    const { fn } = scriptedFetch([() => { throw new Error("down"); }]);
    expect(await unpair({ fetchFn: fn, print, configPath, lastSendPath: join(dir, "last-send") })).toBe(0);
    await expect(stat(configPath)).rejects.toBeDefined();
    expect(lines.join("\n")).toContain("removing the local pairing anyway");
    expect(lines.at(-1)).toBe("Unpaired ✓");
  });
});

// ---------- status-cmd ----------------------------------------------------------------------------

describe("humanAge", () => {
  test("coarse buckets", () => {
    expect(humanAge(12_000)).toBe("12s ago");
    expect(humanAge(5 * 60_000)).toBe("5m ago");
    expect(humanAge(3 * 3_600_000)).toBe("3h ago");
    expect(humanAge(2 * 86_400_000)).toBe("2d ago");
    expect(humanAge(-5)).toBe("0s ago");
  });
});

describe("statusCmd", () => {
  test("unpaired, no watchdog, never sent, zero sessions", async () => {
    expect(await statusCmd({
      print, configPath, lastSendPath: join(dir, "last-send"),
      sessionsDir: join(dir, "sessions"), watchdogPidPath: join(dir, "watchdog.pid"),
    })).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("Paired: no");
    expect(out).toContain("Watchdog: not running");
    expect(out).toContain("Last event sent: never");
    expect(out).toContain("Tracked sessions: 0");
  });

  test("paired + live watchdog + recent send + session count", async () => {
    const sessionsDir = join(dir, "sessions");
    await writeFile(configPath, JSON.stringify({
      url: WORKER, pairingId: "abcdef0123456789".repeat(2), pcSecret: "s", e2eKeyB64: b64url(new Uint8Array(32)),
    }));
    await writeFile(join(dir, "watchdog.pid"), "4242");
    const now = 1_800_000_000_000;
    await writeFile(join(dir, "last-send"), String(now - 42_000));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, "s1.json"), "{}");
    await writeFile(join(sessionsDir, "s2.json"), "{}");
    await writeFile(join(sessionsDir, "ignore.tmp"), "");

    const seenPids: number[] = [];
    expect(await statusCmd({
      print, configPath, lastSendPath: join(dir, "last-send"), sessionsDir,
      watchdogPidPath: join(dir, "watchdog.pid"),
      isAlive: (pid) => { seenPids.push(pid); return true; },
      now: () => now,
    })).toBe(0);

    const out = lines.join("\n");
    expect(out).toContain("Paired: yes (pairing abcdef01…)");
    expect(out).toContain(`Worker: ${WORKER}`);
    expect(out).toContain("Watchdog: running (pid 4242)");
    expect(seenPids).toEqual([4242]);
    expect(out).toContain("Last event sent: 42s ago");
    expect(out).toContain("Tracked sessions: 2");
  });

  test("a PENDING config → reports pairing-in-progress, not 'no'", async () => {
    await writeFile(configPath, JSON.stringify({
      url: WORKER, pairingId: EXPECTED_PAIRING_ID, pcSecret: EXPECTED_PC_SECRET, qrSecretB64: b64url(QR_SECRET),
    }));
    expect(await statusCmd({
      print, configPath, lastSendPath: join(dir, "last-send"),
      sessionsDir: join(dir, "sessions"), watchdogPidPath: join(dir, "watchdog.pid"),
    })).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("pairing started, waiting for phone scan");
    expect(out).not.toContain("Paired: no");
  });

  test("dead watchdog pid → not running", async () => {
    await writeFile(join(dir, "watchdog.pid"), "999999");
    expect(await statusCmd({
      print, configPath, lastSendPath: join(dir, "last-send"),
      sessionsDir: join(dir, "sessions"), watchdogPidPath: join(dir, "watchdog.pid"),
      isAlive: () => false,
    })).toBe(0);
    expect(lines.join("\n")).toContain("Watchdog: not running");
  });
});
