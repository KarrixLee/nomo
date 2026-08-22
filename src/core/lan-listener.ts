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
//
// THE OPS, in the order the phases added them. Every one of them rides the envelope above, and every one
// answers SEALED — the 400 is reserved for envelopes that never authenticated at all.
//
// PHASE 1 ships the reachability probe every LAN link opens with, and the command op it exists for:
//
//   {"op":"ping", payload:{}}
//        → sealed {"ok":true}. No side effects: it proves the endpoint is this pairing's Mac, that the
//          key still opens, and that the clock/nonce guards agree — which is exactly what the phone
//          needs before it commits a real command to the LAN leg.
//
//   {"op":"command", payload:{"blob":"<b64 sealed under the PAIRING key>"}}
//        → sealed {"ok":true}. The blob is handed to the watchdog untouched; all command validation
//          (kind allow-list, freshness, replay dedupe) stays in drainCommands, so a LAN command and its
//          worker twin collapse on the SAME inner nonce.
//
// PHASE 2 adds two ops on the same envelope (see the answer store below):
//
//   {"op":"answer",      payload:{"requestId":"<id>","answerBlob":"<b64 sealed under the PAIRING key>"}}
//        → sealed {"ok":true}. The answerBlob is NEVER opened here: it is sealed under e2eKey, and the
//          hold that consumes it (Claude hook / Codex relay) does the decrypt + requestId match exactly
//          as it does for a worker-delivered answer. This listener is as blind as the worker.
//   {"op":"answer-poll", payload:{"requestId":"<id>"}}
//        → sealed {"status":"pending"} | {"status":"answered","answerBlob":"<b64>"} — the LOOPBACK-ONLY
//          op the blocked Claude hook (a separate short-lived process with no IPC to this daemon) uses
//          to read the store. Off-loopback callers get the same {"ok":false,"err":"bad-op"} any unknown
//          op gets, so the phone cannot tell this op exists at all.
//
// PHASE 3 adds the Mac→phone status feed on the same envelope (the map itself lives in lan-frames.ts):
//
//   {"op":"frames", payload:{"sinceSeq":<integer >= 0>,"waitMs":<0..25000>}}
//        → sealed {"ok":true,"seq":<latest counter>,"lid":"<this listener instance>","frames":[…]} where each
//          frame is {"seq","sessionId","op","prio","ts","blob"(+"agent","attentionKind")} and `blob` is
//          the record's e2eKey-sealed ciphertext VERBATIM — the listener never opens it, so this feed is
//          as blind as the worker. Frames are seq-ascending, one per session (latest state only), and a
//          request with nothing new is HELD up to waitMs, answered the moment anything changes.
//
// LAN STATUS v2 (NOM-47 phase A) adds the op that supersedes `frames` — a SNAPSHOT feed rather than an
// event replay. The Mac computes the final display state (core/session-state.ts) and serves complete
// current-state snapshots of it, so there is nothing left on the phone to order or arbitrate:
//
//   {"op":"state", payload:{"sinceSeq":<integer >= 0>,"waitMs":<0..25000>}}    (byte-identical to `frames`)
//        → sealed {"ok":true,"seq":<change counter>,"lid":"<instance>","at":<epoch ms>,
//                  "complete":true|false,
//                  "sessions":[{"sessionId","ts","terminal","blob"
//                               (+"agent","startedAt","attentionKind","why")}, …]}
//        `attentionKind` is the SAME clear discriminator the v1 `frames` envelope and the worker wire
//        carry ("userInput" = a Codex request_user_input, i.e. a question rather than an approval); the
//        phone's answer flows key on it and it is not derivable from the sealed blob. It rides only while
//        the state is one the user can answer.
//        `complete:true` means this response IS the whole current map for this pairing — the ONLY thing
//        the phone may seed per-row LAN ownership from. On `complete:false`, absence is still never
//        evidence. `seq` is a CURSOR, never a comparison; `ts` is an observation stamp, never an ordering
//        guard; `why` names the input that decided the row (`hold`, `work+cc`, `done/cx`, …).
//        `frames` KEEPS WORKING from the same store for the whole deprecation window — the phone is the
//        laggard here, since a user can point an old app at a fresh plugin indefinitely.
//
// PHASE 4 adds the on-demand pull for content the WORKER path has to truncate:
//
//   {"op":"read", payload:{"what":"plan"|"permission-detail","sessionId":"<id>"}}
//        → sealed {"ok":true,"content":"<the whole thing>","complete":true|false}
//          |       {"ok":false,"err":"not-found"}
//        The worker caps a sealed blob at 3072 base64 chars, so a long plan reaches the phone as a
//        prefix (and a long permission detail as a prefix plus an omitted-count). The hook tees the
//        UNABRIDGED string onto the 0600 session record whenever that fit actually cut something;
//        this op serves it. There is no ceiling on this path — `complete:false` means only that the
//        record-side 256 KB cap clipped it. Unlike `frames`, the content here is PLAINTEXT inside the
//        K_lan seal rather than a second, e2eKey-sealed blob: this is a direct Mac↔phone channel with
//        no blind relay in the middle, so the outer seal already IS the end-to-end seal. `not-found`
//        covers every miss identically (unknown session, other pairing, expired record, nothing was
//        truncated) — the phone's fallback is the blob's own copy in all of them.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { b64url, Bytes, decryptBlob, deriveLanKey, encryptBlob } from "./crypto";
import { createLanFrameStore } from "./lan-frames";
import type { LanFrameStore } from "./lan-frames";
import { rememberBounded } from "./bounded-set";
import { atomicWrite, Config, traceSession } from "./shared";
import {
  isLoopbackAddress, LAN_ANSWER_BLOB_MAX_CHARS, LAN_COMMAND_BLOB_MAX_CHARS, LAN_ENVELOPE_VERSION,
  LAN_PATH, LAN_REQUEST_ID_RE, LAN_STATE_PATH, lanEnvelopeIsFresh, lanRunningUnderTest,
  parseLanEnvelope, parseLanFramesRequest, parseLanReadRequest, parseLanState,
} from "./lan-wire";
import type { LanState } from "./lan-wire";

// The PURE wire contract lives in lan-wire.ts so the permission hook can speak it without bundling this
// HTTP server (see that file's header). Re-exported here, unchanged, so every existing importer of
// "./lan-listener" — tests included — keeps resolving exactly the same names.
//
// THE RULE, so this shim cannot rot: it re-exports ALL of lan-wire and nothing else. "This name is part
// of the wire" is then the same question as "is it reachable through lan-listener?", and a new wire
// constant is added in exactly one place with no importer to chase.
export {
  isLoopbackAddress, LAN_ANSWER_BLOB_MAX_CHARS, LAN_COMMAND_BLOB_MAX_CHARS, LAN_ENVELOPE_VERSION,
  LAN_FRAMES_WAIT_MAX_MS, LAN_FUTURE_SKEW_MS, LAN_NONCE_MAX_CHARS, LAN_PATH, LAN_REQUEST_ID_RE,
  LAN_SESSION_ID_RE, LAN_STATE_PATH, LAN_TTL_MS, lanEnvelopeIsFresh, lanRunningUnderTest,
  parseLanEnvelope, parseLanFramesRequest, parseLanReadRequest, parseLanState,
} from "./lan-wire";
export type { LanEnvelope, LanFramesRequest, LanReadRequest, LanReadWhat, LanState } from "./lan-wire";

/** Request-body ceiling. A command envelope is a few hundred bytes; 64 KB is enormous headroom and
 *  still bounds what a hostile LAN peer can make this daemon buffer. Enforced on Content-Length AND on
 *  the streamed bytes (a chunked body has no honest Content-Length). */
export const LAN_BODY_MAX_BYTES = 65_536;
/** Bound on the OUTER-nonce replay set. Deliberately SEPARATE from the watchdog's seenCommandNonces:
 *  that set guards the INNER (e2eKey-sealed) command nonce and is shared with the worker channel, which
 *  is exactly why it must not be consumed by outer-envelope traffic — a flood of junk LAN envelopes must
 *  not be able to evict a real command's inner nonce and reopen the cross-channel replay window.
 *  512 with FIFO eviction, same sizing argument as the inner set. */
const LAN_SEEN_NONCES_MAX = 512;
/** Idle keep-alive / whole-request ceilings, so a half-open LAN peer cannot pin a socket forever. */
const LAN_KEEPALIVE_MS = 5_000;
const LAN_REQUEST_TIMEOUT_MS = 10_000;

/** How long a LAN-delivered answer stays consumable. Sized like LAN_TTL_MS: past two minutes the hold it
 *  belongs to is gone (worker-expired, released, or the terminal was killed) and the entry is garbage. */
export const LAN_ANSWER_TTL_MS = 120_000;
/** Bound on the answer store, FIFO-evicted. One entry per LIVE permission prompt on this machine;
 *  64 concurrent holds is already implausible, and the bound is what stops a K_lan holder from growing
 *  this daemon's heap with answers no hold will ever read. */
export const LAN_ANSWER_STORE_MAX = 64;

/** One stored answer: the still-sealed phone ciphertext plus when it landed (TTL clock). */
export interface LanAnswer {
  answerBlob: string;
  at: number;
}

/** A cancellable "tell me when an answer for this requestId lands" handle. `cancel()` MUST be called by
 *  every waiter (a `finally`), or the store keeps a listener per abandoned poll tick. */
export interface LanAnswerWaiter {
  promise: Promise<void>;
  cancel(): void;
}

/** The in-memory answer store: written by the listener's `answer` op, read by the `answer-poll` op (the
 *  Claude hook's loopback client) and DIRECTLY by the in-process Codex relay (codex-remote-input), which
 *  also uses `waiter` to skip its 3 s poll tick.
 *
 *  FIRST-WRITER-WINS, mirroring the worker's answer route: a second `answer` for a live requestId is
 *  acknowledged (the phone must never see an error for a duplicate it deliberately raced) but does NOT
 *  overwrite. Two different blobs for one requestId can only mean a retry or a racing tap, and the hold
 *  has already been told about the first. */
export interface LanAnswerStore {
  /** Store unless this requestId already holds a live answer. Returns which happened — the caller uses
   *  it to fire the worker echo exactly ONCE per genuinely stored answer. */
  put(requestId: string, answerBlob: string, at: number): "stored" | "duplicate";
  /** The live (non-expired) answer for this requestId, or undefined. Non-destructive: a hold may read
   *  the same answer twice (worker poll and loopback poll can both be in flight) and TTL is the only
   *  thing that removes an entry. */
  peek(requestId: string, now: number): LanAnswer | undefined;
  waiter(requestId: string, now: number): LanAnswerWaiter;
  /** Live entry count (test/diagnostic seam). */
  size(): number;
}

export function createLanAnswerStore(options: { ttlMs?: number; max?: number } = {}): LanAnswerStore {
  const ttl = options.ttlMs ?? LAN_ANSWER_TTL_MS;
  const max = options.max ?? LAN_ANSWER_STORE_MAX;
  /** Insertion-ordered by construction (Map), which is what makes the eviction below FIFO. */
  const entries = new Map<string, LanAnswer>();
  const waiters = new Map<string, Set<() => void>>();

  const live = (entry: LanAnswer | undefined, now: number): LanAnswer | undefined =>
    entry && now - entry.at <= ttl && entry.at - now <= ttl ? entry : undefined;

  return {
    put(requestId: string, answerBlob: string, at: number): "stored" | "duplicate" {
      const existing = entries.get(requestId);
      if (live(existing, at)) return "duplicate"; // first writer wins (the worker's rule)
      entries.delete(requestId); // re-insert so an expired entry's slot moves to the END of the FIFO
      entries.set(requestId, { answerBlob, at });
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      for (const notify of waiters.get(requestId) ?? []) {
        try { notify(); } catch { /* a broken waiter must not break the store */ }
      }
      return "stored";
    },
    peek(requestId: string, now: number): LanAnswer | undefined {
      const entry = entries.get(requestId);
      const fresh = live(entry, now);
      if (entry && !fresh) entries.delete(requestId); // expired → drop on read
      return fresh;
    },
    waiter(requestId: string, now: number): LanAnswerWaiter {
      if (this.peek(requestId, now)) return { promise: Promise.resolve(), cancel: () => { /* nothing registered */ } };
      let settle!: () => void;
      const promise = new Promise<void>((resolve) => { settle = resolve; });
      const set = waiters.get(requestId) ?? new Set<() => void>();
      set.add(settle);
      waiters.set(requestId, set);
      return {
        promise,
        cancel(): void {
          const current = waiters.get(requestId);
          if (current) {
            current.delete(settle);
            if (current.size === 0) waiters.delete(requestId);
          }
          settle(); // never leave a racing awaiter pending
        },
      };
    },
    size(): number {
      return entries.size;
    },
  };
}

/** THE process-wide store. The listener writes it, the loopback `answer-poll` op reads it, and the Codex
 *  relay (same process) reads it directly — one instance is what makes those three the same store. Tests
 *  inject their own via `LanListenerDeps.answers` / `CodexRemoteInputDeps.answerStore`. */
export const lanAnswerStore: LanAnswerStore = createLanAnswerStore();

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

/** A LAN-delivered approval answer, handed to the watchdog AFTER it has been stored (so the store is
 *  already serving it when this fires). `answerBlob` is the untouched e2eKey-sealed ciphertext — the
 *  listener never opens it; the hold that consumes it does, exactly as for a worker-delivered answer. */
export interface LanAnswerDelivery {
  requestId: string;
  answerBlob: string;
  /** The config the envelope authenticated against, so the sink can echo to the worker without a reload. */
  config: Config;
}

export interface LanListenerDeps {
  /** Called when an authenticated `op:"command"` arrives. MUST return promptly: it runs on the HTTP
   *  request path, so the real implementation only buffers + schedules. */
  onCommand?: (command: LanCommand) => void;
  /** Called ONCE per genuinely stored `op:"answer"` (never for a duplicate). Same contract as onCommand:
   *  it runs on the request path, so the real implementation starts its work and returns — the phone's
   *  sealed {"ok":true} must not wait for a worker round trip. */
  onAnswer?: (answer: LanAnswerDelivery) => void;
  /** The answer store this listener writes/serves. Defaults to the process-wide singleton, which is what
   *  makes the in-process Codex relay see the same answers. */
  answers?: LanAnswerStore;
  /** The phase-3 status feed the `frames` op serves (and the phase-4 `read` op's record access).
   *  Defaults to a store over the real session dir
   *  (inert under `bun test` — see createLanFrameStore). Its lifecycle is OWNED here: started with the
   *  listener and stopped by stop(), which is what wires it into all three watchdog teardown seams
   *  (ownership loss, run()'s finally, SIGTERM/SIGINT) without the daemon knowing it exists. */
  frames?: LanFrameStore;
  /** How the peer's address is read, for the `answer-poll` loopback gate. Production reads node's
   *  `req.socket.remoteAddress`; tests inject a LAN address to exercise the OFF-loopback branch, which is
   *  otherwise unreachable from a test that (correctly) only ever binds loopback. */
  remoteAddress?: (req: unknown) => string | undefined;
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
  if (lanRunningUnderTest()) return;
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

/** The `requestId` field of a payload, or null when it is absent or outside the charset gate. ONE
 *  helper because TWO ops read it — `answer` (phone → store) and `answer-poll` (hook ← store) — and they
 *  must apply the identical gate: the worker's REQID_RE is what decides whether the SAME id is accepted
 *  on the worker leg, and an id one op here took while the other refused would be a split brain between
 *  the two halves of a single answer's journey. Each caller keeps its OWN reject reason, so the trace
 *  still says which op failed. */
function requestIdOf(payload: Record<string, unknown>): string | null {
  const requestId = payload.requestId;
  return typeof requestId === "string" && LAN_REQUEST_ID_RE.test(requestId) ? requestId : null;
}

// --- the listener ------------------------------------------------------------------------------

/** Minimal structural shapes for the node:http objects we touch. Declared locally because this repo
 *  ships no @types/node and the rest of src/ types node builtins the same way. */
interface LanReq {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  /** node's connection socket. Only `remoteAddress` is read — the loopback gate on `answer-poll`. */
  socket?: { remoteAddress?: string };
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
  /** Per-socket inactivity timeout. 0 = off (node's default since v13); see tryListen's timeout note. */
  timeout?: number;
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
  const answers = deps.answers ?? lanAnswerStore;
  const frames = deps.frames ?? createLanFrameStore();
  const peerAddress = deps.remoteAddress ?? ((req: unknown) => (req as LanReq)?.socket?.remoteAddress);

  /** The CURRENT pairing, refreshed by sync(). Null while unpaired — every request then fails to
   *  decrypt (there is no key) and gets the same opaque 400 as a wrong-key probe. */
  let config: Config | null = null;
  /** K_lan for `config`, as a promise so a request never races the derivation. */
  let keyPromise: Promise<Bytes | null> = Promise.resolve(null);
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
      } else if (envelope.op === "answer") {
        const requestId = requestIdOf(envelope.payload);
        const answerBlob = envelope.payload.answerBlob;
        if (requestId === null) return reject(res, "answer-request-id");
        if (typeof answerBlob !== "string" || answerBlob.length === 0 || answerBlob.length > LAN_ANSWER_BLOB_MAX_CHARS) {
          return reject(res, "answer-blob");
        }
        // Store FIRST (synchronously), so the loopback `answer-poll` and the in-process Codex relay are
        // already able to see this answer before the phone even gets its ok back.
        const stored = answers.put(requestId, answerBlob, now());
        if (stored === "stored") {
          // The split-brain backstop: tell the worker this request is resolved so the island's Allow/Deny
          // buttons retire even when the phone's own parallel worker leg failed. Fire-and-forget by
          // contract — the sink starts the POST and returns; the response below never waits on it, and a
          // failure is traced, never thrown (and NEVER a gone strike: that is worker-authority only).
          try { deps.onAnswer?.({ requestId, answerBlob, config: pairing }); } catch { /* never fail the response on the sink */ }
        }
        payload = { ok: true }; // a duplicate is still an ok: the phone deliberately raced two channels
      } else if (envelope.op === "frames") {
        const request = parseLanFramesRequest(envelope.payload);
        if (!request) return reject(res, "frames-payload");
        // The ONE long-held response in this server. It parks on the frame store's waiter list — never
        // on a timer of its own, never on the sweep, and never holding any watchdog work: the store is
        // fed by an fs.watch on the session dir plus the sweep's own reconcile, both of which only ever
        // WAKE waiters. `lid` is captured before the wait so a teardown mid-hold still answers with the
        // instance the phone was talking to, and the key was captured before it too, so a re-pair
        // landing mid-hold cannot seal the answer under a key this caller doesn't have.
        const lid = address?.lid ?? "";
        const slice = await frames.wait(request.sinceSeq, request.waitMs);
        // `ok:true` is load-bearing beside the data: the phone classifies EVERY reply on `payload.ok`,
        // and a data-bearing reply without it reads as "listener too old for this op" — which would
        // permanently stop the frames channel for this lid.
        payload = { ok: true, seq: slice.seq, lid, frames: slice.frames };
      } else if (envelope.op === "state") {
        // THE v2 FEED. Same parser, same ceiling, same driver loop as `frames` — the request shape is
        // byte-identical on purpose. A NEW OP rather than `frames v2` because that is the only shape
        // change with safe negotiation: CCLanClient turns an unknown op into `.notHandled` and latches it
        // per lid, so an old Mac answering `bad-op` is a fallback the phone already knows how to take,
        // whereas a `frames` response an old phone cannot decode would arrive with `ok:true` telling it
        // everything is fine. Both ops are served from the SAME store for the whole deprecation window,
        // so there is exactly one source of truth here and the old op cannot drift.
        const request = parseLanFramesRequest(envelope.payload);
        if (!request) return reject(res, "state-payload");
        const lid = address?.lid ?? "";
        const slice = await frames.waitStates(request.sinceSeq, request.waitMs);
        // `at` is the Mac's snapshot instant — the freshness anchor for the whole response, taken AFTER
        // the hold resolves. `complete` says this is the whole current map, and it is the only thing the
        // phone may seed per-row LAN ownership from.
        payload = {
          ok: true, seq: slice.seq, lid, at: slice.at, complete: slice.complete, sessions: slice.sessions,
        };
      } else if (envelope.op === "read") {
        const request = parseLanReadRequest(envelope.payload);
        if (!request) return reject(res, "read-payload");
        // On-demand disk read through the frame store (which owns the sessions dir and the pairing
        // guard); nothing is cached here. `not-found` is the ONE answer for every miss — absent session,
        // other pairing, expired record, or a field that was never truncated in the first place — so the
        // phone's fallback is the same in all of them: render the copy already in the blob.
        const hit = await frames.readFull(request.sessionId, request.what);
        payload = hit
          ? { ok: true, content: hit.content, complete: hit.complete }
          : { ok: false, err: "not-found" };
      } else if (envelope.op === "answer-poll" && isLoopbackAddress(peerAddress(req))) {
        // LOOPBACK ONLY. This op exists for the blocked Claude hook — a separate short-lived process on
        // THIS machine with no IPC to the daemon. The phone never needs it, so an off-LAN-address caller
        // falls through to the bad-op branch below and cannot even learn the op exists.
        const requestId = requestIdOf(envelope.payload);
        if (requestId === null) return reject(res, "answer-poll-request-id");
        const hit = answers.peek(requestId, now());
        // The SAME shape the worker's GET /v1/cc/decision/:id returns, so the hook's answer branch is
        // reused verbatim across both channels.
        payload = hit ? { status: "answered", answerBlob: hit.answerBlob } : { status: "pending" };
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
      // Timeout discipline, set EXPLICITLY because the `frames` op holds a response open for up to 25 s
      // and a server-side timeout would kill it (measured on bun 1.3.14 AND node: a 26 s held response
      // survives all three settings below — `requestTimeout` bounds RECEIVING the request, not answering
      // it, and `keepAliveTimeout` only applies to an idle socket BETWEEN responses):
      //   keepAliveTimeout — idle keep-alive reuse window; not running while a response is pending.
      //   requestTimeout   — whole-request RECEIVE ceiling (slowloris); unrelated to the hold.
      //   headersTimeout   — left at node's 60 s default, comfortably above the 25 s hold.
      //   timeout          — per-socket inactivity. Pinned to 0 (node's default; bun reports undefined)
      //                      so no runtime can decide a socket parked on a long-poll is "inactive".
      candidate.keepAliveTimeout = LAN_KEEPALIVE_MS;
      candidate.requestTimeout = LAN_REQUEST_TIMEOUT_MS;
      candidate.timeout = 0;
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
   *  A failed re-bind (someone else took the port) falls back to an ephemeral one.
   *
   *  THE PORT IS REUSED; THE LID NEVER IS. They are different facts and this function used to conflate
   *  them. The port is the ENDPOINT — keeping it is exactly what spares a phone a re-probe across a
   *  restart. The `lid` is the LISTENER INSTANCE, and lan-wire's contract for it is "a changed lid tells
   *  the phone everything you cached about this endpoint is void". After a restart everything it cached
   *  IS void: `counter`, `stateCounter`, `entries` and `stateEntries` are all in-memory and all begin
   *  again at zero. Re-serving the old lid asserts otherwise, and the phone believes it —
   *    • its v2 `state` cursor keeps the DEAD instance's counter, and the new listener answers that
   *      cursor INCREMENTALLY as soon as its own counter has climbed past the number (`states()` coerces
   *      to 0, and so answers `complete`, only while `sinceSeq > counter`). A complete map is the only
   *      thing allowed to seed the phone's LAN ownership, so it never gets one, and a session that is
   *      QUIET — a parked Allow/Deny hold above all — silently stays worker-driven for the whole link;
   *    • `stateUnsupportedLids` / `unsupportedLids` / the restart cooldown are all keyed by lid on the
   *      phone, so the documented "upgrading the plugin mints a new listener instance and re-negotiates
   *      v2 with no app relaunch" only ever fired when the port happened to move as well.
   *  A new process is a new lid, and the rotation is persisted so the next restart cannot re-publish one
   *  the phone has already retired. The cost is one hint reseal and one full map per restart. */
  const bind = async (): Promise<LanAddress | null> => {
    let persisted: LanState | null = null;
    try { persisted = parseLanState(await readFile(statePath, "utf8")); } catch { persisted = null; }

    if (persisted) {
      const bound = await tryListen(persisted.port);
      if (stopped) { try { bound?.close(); } catch { /* never listened */ } return null; }
      if (bound) {
        server = bound;
        try { bound.unref?.(); } catch { /* runtime without unref */ }
        address = { port: persisted.port, lid: newListenerId() };
        const rotated: LanState = { port: address.port, lid: address.lid, createdAt: now() };
        try {
          await atomicWrite(statePath, JSON.stringify(rotated), 0o600);
        } catch {
          // The rotated lid still holds for THIS run (it is what we serve and seal into the hint); only
          // its persistence is lost, and the next restart simply rotates again from the older file.
          traceLan(deps, { result: "state-write-failed" });
        }
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
  // The status feed's watcher is armed with the listener, not on first use: the phone's very first
  // `frames` request must be answerable from a map that is already warm. Never awaited (arming is a
  // single syscall and a failure just degrades the feed to the per-sweep reconcile).
  frames.start();

  return {
    ready,
    sync(next: Config | null): void {
      try {
        config = next;
        // The status feed is re-pointed and re-read on EVERY sweep — this is the lossy-watch fallback
        // for the fs.watch feed (macOS coalesces/drops events), and it is why nothing here is awaited:
        // reconcile() returns a promise the sweep must never sit on. setPairing is a no-op unless the
        // pairing actually rotated, in which case it also voids every frame sealed under the old key.
        // The e2eKey rides along from v2 on: the store seals the plaintexts the MAC AUTHORS (a state no
        // hook-written blob describes) and passes every hook-authored ciphertext through untouched.
        frames.setPairing(next?.pairingId, next?.e2eKey);
        void frames.reconcile();
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
      // FIRST: release the status feed. Its stop() closes the directory watcher AND resolves every held
      // long-poll, so no `frames` response is still parked on a socket we are about to destroy.
      try { frames.stop(); } catch { /* best-effort teardown */ }
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
  key: Bytes,
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
