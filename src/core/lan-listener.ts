// lan-listener — the Mac side of the hybrid LAN transport (NOM-44 phase 1).
//
// WHAT IT IS: a tiny `node:http` server hosted inside the watchdog so a phone on the SAME network can
// hand this computer a command directly instead of waiting for the Cloudflare worker to piggyback it on
// the next /cc/event response (~5-12 s → <200 ms). It is STRICTLY ADDITIVE: the worker path keeps
// running unchanged and stays the canonical channel, and every LAN failure mode collapses into "the
// phone's parallel worker leg wins" — never into a lost command.
//
// PORTABILITY: no `Bun.*` anywhere (`Bun.serve` is explicitly forbidden — see the design's hard limits);
// this file must run unmodified under bun AND node >= 18, so the server is `node:http`, the crypto is
// globalThis.crypto via ../core/crypto, and file IO goes through shared's atomicWrite.
//
// SILENCE: the watchdog is detached with stdio ignored, so nothing here may ever write to the console.
// Diagnostics go to session-trace.log through traceSession, exactly like every other daemon net.
//
// THE WIRE (frozen — the iOS CCLanClient implements the mirror image):
//
//   POST http://<host>:<port>/v1/lan          (plain HTTP; the seal below is the security boundary)
//   request  body: {"p":"<base64 of iv(12)||ct||tag(16), AES-256-GCM under K_lan>"}
//   response body: {"p":"<same envelope format>"}   on success, 200
//                  {}                                on ANY rejection, 400 — no detail is ever leaked
//
//   K_lan  = HKDF-SHA256(ikm = e2eKey, salt = <empty>, info = "nomo-lan-v1|" + pairingId)  (crypto.ts)
//   sealed request  plaintext: {"v":1,"op":"<op>","ts":<epoch ms>,"nonce":"<b64url 16B>","payload":{…}}
//   sealed response plaintext: {"v":1,"reqNonce":"<echo>","ts":<epoch ms>,"payload":{…}}
//
// WHY the outer seal: the pairing's own blobs are already E2E-sealed under e2eKey, but their METADATA
// (op, requestIds, sizes, the fact a pairing exists here at all) would otherwise be readable by anyone
// on the Wi-Fi. Sealing the whole envelope under a SEPARATE key also makes cross-channel replay
// structurally impossible — a worker-path ciphertext is sealed under e2eKey and simply will not open
// under K_lan, and vice versa.
//
// WHY a generic 400 with an empty body for every rejection: the endpoint is reachable by anything on the
// LAN. A prober must not be able to tell "wrong key" from "stale timestamp" from "no pairing here" —
// the only bit it learns is that something answered, which the TCP accept already told it.
//
// The ONE semantic exception is a well-formed, authenticated envelope naming an op this build does not
// implement: that gets a SEALED 200 {"ok":false,"err":"bad-op"} so a newer phone can distinguish "this
// Mac is alive but older" from "unreachable". Only a holder of K_lan can ever see that answer.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { b64url, decryptBlob, deriveLanKey, encryptBlob } from "./crypto";
import { atomicWrite, CC_DIR, Config, traceSession } from "./shared";

/** The single endpoint. Anything else is a 400 — there is no index, no health page, no discovery URL. */
export const LAN_PATH = "/v1/lan";
/** Envelope version, inner request AND response. Bumped only on a breaking plaintext-shape change. */
export const LAN_ENVELOPE_VERSION = 1;
/** Request-body ceiling. A command envelope is a few hundred bytes; 64 KB is enormous headroom and
 *  still bounds what a hostile LAN peer can make this daemon buffer. Enforced on Content-Length AND on
 *  the streamed bytes (a chunked body has no honest Content-Length). */
export const LAN_BODY_MAX_BYTES = 65_536;
/** How old a sealed `ts` may be. Mirrors the worker path's COMMAND_TTL_MS so the two channels expire
 *  the same intent at the same moment — a phone that raced both legs must not have one of them still
 *  accepted after the other went stale. */
export const LAN_TTL_MS = 120_000;
/** How far a sealed `ts` may sit in the future. Mirrors COMMAND_FUTURE_SKEW_MS. */
export const LAN_FUTURE_SKEW_MS = 30_000;
/** Bound on the OUTER-nonce replay set. Deliberately SEPARATE from the watchdog's seenCommandNonces:
 *  that set guards the INNER (e2eKey-sealed) command nonce and is shared with the worker channel, which
 *  is exactly why it must not be consumed by outer-envelope traffic — a flood of junk LAN envelopes must
 *  not be able to evict a real command's inner nonce and reopen the cross-channel replay window.
 *  512 with FIFO eviction, same sizing argument as the inner set. */
export const LAN_SEEN_NONCES_MAX = 512;
/** Upper bound on the nonce string we will remember, so the seen-set cannot be grown by long values.
 *  The phone sends base64url of 16 CSPRNG bytes = 22 characters. */
export const LAN_NONCE_MAX_CHARS = 64;
/** Upper bound on a command's inner sealed blob. The worker path caps blobs at 3072 base64 chars
 *  (BLOB_FIT_CHARS + margin); the LAN path has no worker in it, but a bound is still a bound. */
export const LAN_COMMAND_BLOB_MAX_CHARS = 8192;
/** Idle keep-alive / whole-request ceilings, so a half-open LAN peer cannot pin a socket forever. */
const LAN_KEEPALIVE_MS = 5_000;
const LAN_REQUEST_TIMEOUT_MS = 10_000;

/** Where the bound port + listener-instance id are persisted, next to config.json (0600, atomicWrite —
 *  same directory discipline as every other piece of daemon state). Re-binding the SAME port across
 *  watchdog restarts is what lets the phone keep a cached endpoint working instead of re-probing. */
export const LAN_STATE_PATH = `${CC_DIR}/lan.json`;

/** What `lan.json` holds. `lid` identifies this LISTENER INSTANCE (not the machine): the phone caches
 *  per-lid, so a changed lid tells it "everything you cached about this endpoint is void". */
export interface LanState {
  port: number;
  lid: string;
  createdAt: number;
}

/** The listener's current address, once bound. */
export interface LanAddress {
  port: number;
  lid: string;
}

/** A LAN-delivered command, handed to the watchdog. `nonce` is the OUTER envelope nonce (the caller
 *  turns it into a command id); `blob` is the untouched e2eKey-sealed CCCommandPayload — byte-identical
 *  to what the worker piggybacks — so ALL command validation stays in the existing drainCommands chain
 *  and the two channels dedupe against each other on the inner nonce. */
export interface LanCommand {
  nonce: string;
  blob: string;
  /** The config the envelope authenticated against, so the callback can drain without re-reading it. */
  config: Config;
}

export interface LanListenerDeps {
  /** Called when an authenticated `op:"command"` arrives. MUST return promptly: it runs on the HTTP
   *  request path, so the real implementation only buffers + schedules. */
  onCommand?: (command: LanCommand) => void;
  /** Interface to bind. Defaults to every interface (that is the entire point); tests bind loopback. */
  host?: string;
  /** Where the port/lid are persisted. Injectable so tests never touch the user's real state dir. */
  statePath?: string;
  now?: () => number;
  /** Diagnostics sink. Defaults to the guarded session trace (see traceLan). */
  trace?: (event: object) => void;
  /** Listener-instance id factory (test seam). */
  newListenerId?: () => string;
}

/** The handle the watchdog holds. `sync` is called once per sweep with the CURRENT config and returns
 *  immediately — key derivation happens off the caller's stack. */
export interface LanListener {
  sync(config: Config | null): void;
  address(): LanAddress | null;
  stop(): void;
  /** Resolves once the initial bind attempt has SETTLED (bound or permanently failed). Test/diagnostic
   *  seam only — the watchdog never waits on it, because the sweep must never depend on a socket. */
  readonly ready: Promise<LanAddress | null>;
}

// --- small helpers -----------------------------------------------------------------------------

const textDecoder = new TextDecoder();

/** Best-effort trace with the same argv guard the watchdog's traceFocus uses: unit tests run with the
 *  user's real HOME visible and must never pollute their live session trace. */
function traceLan(deps: LanListenerDeps, event: object): void {
  if (deps.trace) {
    try { deps.trace(event); } catch { /* diagnostics only */ }
    return;
  }
  if (process.argv.some((arg) => arg === "test" || arg.endsWith(".test.ts"))) return;
  traceSession({ event: "lan", ...event });
}

/** A listener-instance id. crypto.randomUUID is present on node >= 19 and bun; the random fallback
 *  keeps node 18 (where the global may be flagged off) on the supported floor. Opaque either way. */
function defaultListenerId(): string {
  const c = globalThis.crypto as unknown as { randomUUID?: () => string };
  try {
    if (typeof c?.randomUUID === "function") return c.randomUUID();
  } catch { /* fall through to the random id */ }
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Parse `lan.json`. Anything malformed reads as "no persisted state" (bind fresh) — a corrupt file
 *  must never keep the listener from coming up. Pure. */
export function parseLanState(raw: string): LanState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const s = parsed as Record<string, unknown>;
    if (typeof s.port !== "number" || !Number.isInteger(s.port) || s.port < 1 || s.port > 65_535) return null;
    if (typeof s.lid !== "string" || s.lid.length === 0 || s.lid.length > 128) return null;
    const createdAt = typeof s.createdAt === "number" && Number.isFinite(s.createdAt) ? s.createdAt : 0;
    return { port: s.port, lid: s.lid, createdAt };
  } catch {
    return null;
  }
}

/** The inner request envelope, after the outer seal opens. Every field is phone-authored and
 *  tag-protected — nothing here is trustworthy before decryptBlob succeeded. */
export interface LanEnvelope {
  v: number;
  op: string;
  ts: number;
  nonce: string;
  payload: Record<string, unknown>;
}

/** Shape-check a DECRYPTED envelope. A failure here can only be a client bug (a forger cannot produce a
 *  valid GCM tag), and is still answered with the same opaque 400. Pure. */
export function parseLanEnvelope(plain: unknown): LanEnvelope | null {
  if (typeof plain !== "object" || plain === null) return null;
  const e = plain as Record<string, unknown>;
  if (e.v !== LAN_ENVELOPE_VERSION) return null;
  if (typeof e.op !== "string" || e.op.length === 0 || e.op.length > 32) return null;
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return null;
  if (typeof e.nonce !== "string" || e.nonce.length === 0 || e.nonce.length > LAN_NONCE_MAX_CHARS) return null;
  if (typeof e.payload !== "object" || e.payload === null || Array.isArray(e.payload)) return null;
  return { v: e.v, op: e.op, ts: e.ts, nonce: e.nonce, payload: e.payload as Record<string, unknown> };
}

/** Freshness on the AUTHENTICATED clock, with the worker channel's exact bounds. Pure. */
export function lanEnvelopeIsFresh(ts: number, now: number): boolean {
  if (ts > now + LAN_FUTURE_SKEW_MS) return false;
  return now - ts <= LAN_TTL_MS;
}

/** Add to a bounded insertion-ordered set, evicting oldest-first (mirrors the watchdog's helper). */
function rememberBounded(set: Set<string>, value: string, max: number): void {
  set.add(value);
  while (set.size > max) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}

// --- the listener ------------------------------------------------------------------------------

/** Minimal structural shapes for the node:http objects we touch. Declared locally because this repo
 *  ships no @types/node and the rest of src/ types node builtins the same way. */
interface LanReq {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (arg?: unknown) => void): unknown;
  pause(): unknown;
}
interface LanRes {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string): unknown;
}
interface LanServer {
  listen(port: number, host: string): unknown;
  close(cb?: () => void): unknown;
  address(): unknown;
  on(event: string, listener: (arg?: unknown) => void): unknown;
  once(event: string, listener: (arg?: unknown) => void): unknown;
  removeAllListeners(event?: string): unknown;
  unref?(): unknown;
  keepAliveTimeout?: number;
  requestTimeout?: number;
}

/** Read the body with a hard byte ceiling. Returns null on overflow, transport error, or a
 *  Content-Length that already declares too much (rejected before a single byte is buffered).
 *
 *  Overflow PAUSES the request rather than destroying it: pausing applies TCP backpressure (so the
 *  sender stops immediately, which is the whole point of the cap) while still letting the handler write
 *  its 400 — destroying the socket mid-request would truncate that response and leave the caller
 *  guessing. Node closes the connection itself once a response is flushed over an unread body. */
function readBody(req: LanReq, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      try { req.pause(); } catch { /* already gone */ }
      resolve(null);
      return;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk?: unknown) => {
      const bytes = chunk as Uint8Array;
      total += bytes.length;
      if (total > max) {
        try { req.pause(); } catch { /* already gone */ }
        done(null);
        return;
      }
      chunks.push(bytes);
    });
    req.on("end", () => {
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { merged.set(c, offset); offset += c.length; }
      done(textDecoder.decode(merged));
    });
    req.on("error", () => done(null));
    req.on("aborted", () => done(null));
  });
}

/** Create (and immediately start binding) the LAN listener. Returns synchronously: the bind runs off
 *  the caller's stack so this is safe to call from the watchdog's startup path, and `sync` never awaits
 *  anything either — the sweep loop can NEVER be slowed down by a socket. */
export function createLanListener(deps: LanListenerDeps = {}): LanListener {
  const host = deps.host ?? "0.0.0.0";
  const statePath = deps.statePath ?? LAN_STATE_PATH;
  const now = deps.now ?? Date.now;
  const newListenerId = deps.newListenerId ?? defaultListenerId;

  let server: LanServer | undefined;
  let address: LanAddress | null = null;
  let stopped = false;
  const sockets = new Set<{ destroy(): unknown }>();
  const seenNonces = new Set<string>();

  /** The CURRENT pairing, refreshed by sync(). Null while unpaired — every request then fails to
   *  decrypt (there is no key) and gets the same opaque 400 as a wrong-key probe. */
  let config: Config | null = null;
  /** K_lan for `config`, as a promise so a request never races the derivation. */
  let keyPromise: Promise<Uint8Array | null> = Promise.resolve(null);
  /** Memo of what keyPromise was derived from — pairingId AND the key bytes, because a re-pair can in
   *  principle keep the id while rotating the key, and a stale K_lan would silently 400 everything. */
  let keyMemo: string | undefined;

  const send = (res: LanRes, status: number, body: object): void => {
    try {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    } catch { /* peer vanished mid-write */ }
  };
  /** The ONLY rejection answer: no status variety, no body, nothing to fingerprint. */
  const reject = (res: LanRes, why: string): void => {
    traceLan(deps, { result: "reject", why });
    send(res, 400, {});
  };

  const handle = async (req: LanReq, res: LanRes): Promise<void> => {
    try {
      if ((req.method ?? "").toUpperCase() !== "POST") return reject(res, "method");
      if ((req.url ?? "").split("?")[0] !== LAN_PATH) return reject(res, "path");

      const raw = await readBody(req, LAN_BODY_MAX_BYTES);
      if (raw === null) return reject(res, "body-size");

      let outer: unknown;
      try { outer = JSON.parse(raw); } catch { return reject(res, "json"); }
      if (typeof outer !== "object" || outer === null) return reject(res, "shape");
      const p = (outer as Record<string, unknown>).p;
      if (typeof p !== "string" || p.length === 0) return reject(res, "shape");

      const key = await keyPromise;
      const pairing = config;
      if (!key || !pairing) return reject(res, "unpaired");

      let plain: unknown;
      try { plain = await decryptBlob(key, p); } catch { return reject(res, "decrypt"); }

      const envelope = parseLanEnvelope(plain);
      if (!envelope) return reject(res, "envelope");
      if (!lanEnvelopeIsFresh(envelope.ts, now())) return reject(res, "stale");
      if (seenNonces.has(envelope.nonce)) return reject(res, "replay");
      rememberBounded(seenNonces, envelope.nonce, LAN_SEEN_NONCES_MAX);

      // Authenticated from here on. Everything below answers SEALED, so only the phone learns anything.
      let payload: Record<string, unknown>;
      if (envelope.op === "ping") {
        payload = { ok: true };
      } else if (envelope.op === "command") {
        const blob = envelope.payload.blob;
        if (typeof blob !== "string" || blob.length === 0 || blob.length > LAN_COMMAND_BLOB_MAX_CHARS) {
          return reject(res, "command-payload");
        }
        // Hand the still-sealed blob straight to the watchdog: the inner CCCommandPayload's kind
        // allow-list, freshness and replay dedupe are drainCommands' job, unchanged, so a LAN command
        // and its worker twin collapse on the SAME inner nonce.
        try { deps.onCommand?.({ nonce: envelope.nonce, blob, config: pairing }); } catch { /* never fail the response on the sink */ }
        payload = { ok: true };
      } else {
        payload = { ok: false, err: "bad-op" };
      }

      const sealed = await encryptBlob(key, {
        v: LAN_ENVELOPE_VERSION,
        reqNonce: envelope.nonce,
        ts: now(),
        payload,
      });
      traceLan(deps, { result: "ok", op: envelope.op });
      send(res, 200, { p: sealed });
    } catch {
      // Any unexpected throw is answered like every other rejection — the daemon's contract is silence
      // and an opaque endpoint, not a stack trace on the wire.
      try { send(res, 400, {}); } catch { /* peer gone */ }
    }
  };

  /** One bind attempt. Resolves true when the socket is listening, false on ANY failure (port taken,
   *  permission denied, no network) — never throws, because a listener that cannot bind is a degraded
   *  feature, not a daemon failure. */
  const tryListen = (port: number): Promise<LanServer | null> => new Promise((resolve) => {
    let settled = false;
    let candidate: LanServer;
    try {
      candidate = createServer((req: unknown, res: unknown) => {
        void handle(req as LanReq, res as LanRes);
      }) as unknown as LanServer;
    } catch {
      resolve(null);
      return;
    }
    const finish = (value: LanServer | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      candidate.keepAliveTimeout = LAN_KEEPALIVE_MS;
      candidate.requestTimeout = LAN_REQUEST_TIMEOUT_MS;
      candidate.on("error", () => {
        try { candidate.close(); } catch { /* never listened */ }
        finish(null);
      });
      candidate.on("connection", (socket?: unknown) => {
        const s = socket as { destroy(): unknown; on(e: string, cb: () => void): unknown };
        sockets.add(s);
        try { s.on("close", () => { sockets.delete(s); }); } catch { /* exotic socket */ }
      });
      candidate.once("listening", () => finish(candidate));
      candidate.listen(port, host);
    } catch {
      finish(null);
    }
  });

  /** Bind, preferring the persisted port so a phone's cached endpoint survives a watchdog restart.
   *  A failed re-bind (someone else took the port) falls back to an ephemeral one AND rotates the lid,
   *  because from the phone's point of view this is a different endpoint and everything it cached for
   *  the old lid is void. */
  const bind = async (): Promise<LanAddress | null> => {
    let persisted: LanState | null = null;
    try { persisted = parseLanState(await readFile(statePath, "utf8")); } catch { persisted = null; }

    if (persisted) {
      const bound = await tryListen(persisted.port);
      if (stopped) { try { bound?.close(); } catch { /* never listened */ } return null; }
      if (bound) {
        server = bound;
        try { bound.unref?.(); } catch { /* runtime without unref */ }
        address = { port: persisted.port, lid: persisted.lid };
        traceLan(deps, { result: "bound", port: address.port, lid: address.lid, reused: true });
        return address;
      }
    }

    const fresh = await tryListen(0);
    if (stopped) { try { fresh?.close(); } catch { /* never listened */ } return null; }
    if (!fresh) {
      traceLan(deps, { result: "bind-failed" });
      return null;
    }
    server = fresh;
    try { fresh.unref?.(); } catch { /* runtime without unref */ }
    const info = fresh.address() as { port?: number } | null;
    const port = typeof info?.port === "number" ? info.port : 0;
    if (port === 0) {
      traceLan(deps, { result: "bind-failed", why: "no-port" });
      return null;
    }
    address = { port, lid: newListenerId() };
    const state: LanState = { port, lid: address.lid, createdAt: now() };
    try {
      await atomicWrite(statePath, JSON.stringify(state), 0o600);
    } catch {
      // The port still works for THIS run; only cross-restart stability is lost.
      traceLan(deps, { result: "state-write-failed" });
    }
    traceLan(deps, { result: "bound", port, lid: address.lid, reused: false });
    return address;
  };

  const ready = bind().catch(() => null);

  return {
    ready,
    sync(next: Config | null): void {
      try {
        config = next;
        const memo = next ? `${next.pairingId}|${b64url(next.e2eKey)}` : "";
        if (memo === keyMemo) return;
        keyMemo = memo;
        // Derived OFF the caller's stack and held as a promise, so a request that lands mid-rotation
        // waits for the new key instead of failing against the old one.
        keyPromise = next
          ? deriveLanKey(next.e2eKey, next.pairingId).catch(() => null)
          : Promise.resolve(null);
        // A key rotation makes every previously-seen nonce meaningless (they were sealed under a key
        // that no longer opens anything), and keeping them would only shrink the live replay window.
        seenNonces.clear();
      } catch { /* sync must never throw into the sweep */ }
    },
    address(): LanAddress | null {
      return address;
    },
    stop(): void {
      stopped = true;
      address = null;
      const dying = server;
      server = undefined;
      // Destroy live sockets first: a keep-alive connection would otherwise hold close() open.
      for (const s of sockets) {
        try { s.destroy(); } catch { /* already gone */ }
      }
      sockets.clear();
      if (!dying) return;
      try { dying.removeAllListeners("error"); } catch { /* fine */ }
      try { dying.on("error", () => { /* a close-time error is not news */ }); } catch { /* fine */ }
      try { dying.close(); } catch { /* never listened */ }
    },
  };
}

// --- sealed host hint (discovery through the worker, never in the clear) ------------------------
//
// The phone cannot find this listener on its own: there is no Bonjour (no multicast entitlement, by
// design) and the worker is a BLIND relay. So the watchdog publishes a hint — the LAN addresses, the
// port and the listener id — SEALED UNDER THE PAIRING e2eKey (not K_lan: the phone must be able to open
// it from the worker echo BEFORE it has ever reached this listener). It rides along on /cc/event POSTs
// the daemon already makes; no new request is ever issued for it.
//
// The addresses are never a plaintext field. A LAN IP fingerprints a household — that is network
// identity, not a build string — and the worker-blindness line says nothing new crosses in the clear.

/** Refresh cadence for an UNCHANGED hint. A change publishes immediately; this only keeps a phone that
 *  missed the change (worker record rewritten, app reinstalled) from being stuck with a stale endpoint. */
export const LAN_HINT_REFRESH_MS = 300_000;
/** Sealed-hint ceiling. A many-homed machine (VPN + docker bridges + IPv6) could otherwise produce an
 *  unbounded list; past this the host list is trimmed from the END (see the ordering note below). */
export const LAN_HINT_MAX_CHARS = 2048;
/** How long an enumeration of the local interfaces is reused. Sized at the sweep cadence so the several
 *  POSTs one sweep can make cost exactly one enumeration. */
const LAN_HOSTS_CACHE_MS = 5_000;

/** The addresses worth advertising, IPv4 FIRST then IPv6.
 *
 *  The order is load-bearing twice over: the phone probes in order (IPv4 is what actually works on a
 *  home LAN), and the 2048-char trim drops from the end (so IPv6 goes before the address most likely to
 *  succeed). Excluded: internal/loopback (useless to another host), IPv4 link-local 169.254/16 (an
 *  unconfigured interface), and IPv6 link-local fe80::/10 (unusable without the peer's own zone index,
 *  which we cannot know). De-duplicated, since one address can appear on several interface entries. */
export function lanHostAddresses(
  interfaces: Record<string, Array<{ address?: string; family?: string | number; internal?: boolean }> | undefined> =
    networkInterfaces() as never,
): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  try {
    for (const entries of Object.values(interfaces)) {
      if (!entries) continue;
      for (const entry of entries) {
        const address = entry?.address;
        if (typeof address !== "string" || address.length === 0) continue;
        if (entry.internal) continue;
        const isV6 = entry.family === "IPv6" || entry.family === 6;
        if (isV6) {
          const lower = address.toLowerCase();
          if (lower.startsWith("fe80:") || lower.startsWith("::")) continue; // link-local / unspecified
          if (!v6.includes(address)) v6.push(address);
          continue;
        }
        if (address.startsWith("169.254.")) continue; // IPv4 link-local
        if (!v4.includes(address)) v4.push(address);
      }
    }
  } catch {
    return [];
  }
  return [...v4, ...v6];
}

export interface LanHintPublisherDeps {
  /** The listener's current address, or null while unbound. */
  address: () => LanAddress | null;
  hosts?: () => string[];
  now?: () => number;
}

export interface LanHintPublisher {
  /** The sealed hint to attach to the NEXT /cc/event POST, or undefined when nothing is due. Marks
   *  itself as published on return — a POST that then fails is covered by the refresh interval, which
   *  is far cheaper than threading a delivery outcome back through a dozen injected `post:` deps. */
  take(config: Config | null): Promise<string | undefined>;
}

/** Seal the hint, trimming the host list until it fits the ceiling. Returns undefined when even a
 *  single-host hint does not fit (impossible in practice; a hint is ~150 bytes). */
async function sealHint(
  key: Uint8Array,
  hosts: string[],
  port: number,
  lid: string,
  ts: number,
): Promise<string | undefined> {
  let list = hosts;
  for (;;) {
    const sealed = await encryptBlob(key, { v: LAN_ENVELOPE_VERSION, hosts: list, port, lid, ts });
    if (sealed.length <= LAN_HINT_MAX_CHARS) return sealed;
    if (list.length <= 1) return undefined;
    list = list.slice(0, list.length - 1);
  }
}

/** The publish-when-changed / refresh-every-5-min gate. Stateless from the caller's side: ask for a
 *  hint before each POST and attach whatever comes back. */
export function createLanHintPublisher(deps: LanHintPublisherDeps): LanHintPublisher {
  const hostsOf = deps.hosts ?? (() => lanHostAddresses());
  const now = deps.now ?? Date.now;
  let lastState: string | undefined;
  let lastSentAt = 0;
  /** The CIPHERTEXT last published for `lastState`. Re-sent verbatim on a refresh instead of resealing:
   *  encryptBlob draws a fresh IV every call, so a reseal would produce a different string for identical
   *  content — and the worker's "is this hint unchanged?" test is a string compare on exactly that
   *  ciphertext. Caching it is what keeps a steady-state refresh from costing a KV write every time. */
  let lastSealed: string | undefined;
  let cachedHosts: string[] = [];
  let cachedAt = 0;

  const hosts = (t: number): string[] => {
    if (t - cachedAt < LAN_HOSTS_CACHE_MS && cachedAt !== 0) return cachedHosts;
    cachedAt = t;
    try { cachedHosts = hostsOf(); } catch { cachedHosts = []; }
    return cachedHosts;
  };

  return {
    async take(config: Config | null): Promise<string | undefined> {
      try {
        if (!config) return undefined;
        const addr = deps.address();
        if (!addr) return undefined;
        const t = now();
        const list = hosts(t);
        if (list.length === 0) return undefined; // nothing reachable to advertise
        const state = `${config.pairingId}|${addr.port}|${addr.lid}|${list.join(",")}`;
        if (state === lastState) {
          if (t - lastSentAt < LAN_HINT_REFRESH_MS) return undefined;
          if (lastSealed) {
            lastSentAt = t;
            return lastSealed; // byte-identical refresh — see the lastSealed note above
          }
        }
        const sealed = await sealHint(config.e2eKey, list, addr.port, addr.lid, t);
        if (!sealed) return undefined;
        lastState = state;
        lastSealed = sealed;
        lastSentAt = t;
        return sealed;
      } catch {
        return undefined; // a hint is an optimization; never let it break a status POST
      }
    },
  };
}
