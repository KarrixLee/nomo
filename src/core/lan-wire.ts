// lan-wire — the LAN transport's PURE wire contract, shared by both ends of the loopback.
//
// WHY IT IS ITS OWN MODULE: two very different processes speak this protocol on this machine. The
// watchdog HOSTS it (lan-listener.ts — a node:http server, an answer store, interface enumeration), and
// the blocked permission hook CONSUMES it (permission.ts — a ~300 ms loopback `answer-poll` and nothing
// else). The hook is a short-lived process spawned on every permission prompt, so it must not bundle an
// HTTP server it will never start: the PURE contract — the endpoint, the envelope shape, the freshness
// bounds, the id/blob ceilings, lan.json — lives here, and lan-listener re-exports every name in this
// file (all of it, nothing more) so its own importers are unaffected.
//
// Everything in this file is PURE (no sockets, no timers, no filesystem) apart from the `CC_DIR` path
// constant. The wire itself is documented in lan-listener's header, which remains the reference.

import { CC_DIR } from "./shared";

/** The single endpoint. Anything else is a 400 — there is no index, no health page, no discovery URL. */
export const LAN_PATH = "/v1/lan";
/** Envelope version, inner request AND response. Bumped only on a breaking plaintext-shape change. */
export const LAN_ENVELOPE_VERSION = 1;
/** How old a sealed `ts` may be. Mirrors the worker path's COMMAND_TTL_MS so the two channels expire
 *  the same intent at the same moment — a phone that raced both legs must not have one of them still
 *  accepted after the other went stale. */
export const LAN_TTL_MS = 120_000;
/** How far a sealed `ts` may sit in the future. Mirrors COMMAND_FUTURE_SKEW_MS. */
export const LAN_FUTURE_SKEW_MS = 30_000;
/** Upper bound on the nonce string the listener will remember, so its seen-set cannot be grown by long
 *  values. The phone sends base64url of 16 CSPRNG bytes = 22 characters. */
export const LAN_NONCE_MAX_CHARS = 64;
/** requestId charset gate — the WORKER's REQID_RE verbatim (server/src/decision.ts:100). The two
 *  channels carry the SAME ids, so a phone that raced both legs must not have one of them accept an id
 *  the other refuses. */
export const LAN_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Answer-blob ceiling — the worker's MAX_ANSWER_BLOB_CHARS (3072) verbatim, for the same reason. The
 *  LAN leg has no worker in it and could physically carry more, but a phone seals the answer ONCE and
 *  sends the identical ciphertext down both legs: a blob this side accepted and the worker refused would
 *  be a silent split brain between the two channels. */
export const LAN_ANSWER_BLOB_MAX_CHARS = 3072;
/** Upper bound on a `command` op's inner sealed blob — the sibling of the answer ceiling above, and here
 *  for the same reason: it is a payload-field ceiling the iOS CCLanClient mirrors, not host machinery.
 *  The worker path caps blobs at 3072 base64 chars (BLOB_FIT_CHARS + margin); the LAN path has no worker
 *  in it, so it is allowed more headroom — but a bound is still a bound. */
export const LAN_COMMAND_BLOB_MAX_CHARS = 8192;

/** Longest a `frames` long-poll may be held open (phase 3). The phone asks for at most this; anything
 *  larger is a client bug and is refused rather than clamped, so both ends always agree on the deadline.
 *  25 s sits comfortably under every timeout in the path — see the node:http timeout note in
 *  lan-listener's tryListen — and gives the phone a cheap re-arm loop while it is foregrounded. */
export const LAN_FRAMES_WAIT_MAX_MS = 25_000;

/** A `frames` request payload, after the outer seal opens: "everything newer than sinceSeq, and if there
 *  is nothing, hold the response up to waitMs". Both fields are REQUIRED — the contract is frozen and
 *  shared verbatim with the iOS CCLanClient, so a missing field is a client bug, not a default. */
export interface LanFramesRequest {
  sinceSeq: number;
  waitMs: number;
}

/** Shape-check a `frames` payload. Integers only: `sinceSeq` is a counter the phone echoes back from a
 *  previous response (0 on a fresh connection), `waitMs` is bounded by LAN_FRAMES_WAIT_MAX_MS so a
 *  caller cannot pin a socket for longer than the listener intends. Pure; anything else → null → the
 *  same opaque 400 every other malformed payload gets. */
export function parseLanFramesRequest(payload: Record<string, unknown>): LanFramesRequest | null {
  const sinceSeq = payload.sinceSeq;
  const waitMs = payload.waitMs;
  if (typeof sinceSeq !== "number" || !Number.isInteger(sinceSeq)) return null;
  if (sinceSeq < 0 || sinceSeq > Number.MAX_SAFE_INTEGER) return null;
  if (typeof waitMs !== "number" || !Number.isInteger(waitMs)) return null;
  if (waitMs < 0 || waitMs > LAN_FRAMES_WAIT_MAX_MS) return null;
  return { sinceSeq, waitMs };
}

/** What a `read` op may ask for (phase 4). FROZEN strings, mirrored verbatim by the iOS CCLanClient —
 *  they name the two blob fields the worker's 3072-char ceiling truncates: the Plan-picker markdown
 *  (`plan`) and the permission card's fuller context (`permissionDetail`). */
export type LanReadWhat = "plan" | "permission-detail";

/** A `read` request payload, after the outer seal opens. Both fields REQUIRED, like every other op's:
 *  the contract is frozen and shared with the phone, so a missing field is a client bug, not a default. */
export interface LanReadRequest {
  what: LanReadWhat;
  sessionId: string;
}

/** Session-id charset gate for the `read` op. Same shape as LAN_REQUEST_ID_RE, but a SEPARATE constant
 *  because it does a second job: the id is turned into a FILE PATH (`<sessionsDir>/<id>.json`), so the
 *  charset is also the path-traversal defence — no dot, no slash, no separator of any kind can survive
 *  it. Real ids are UUIDs or the `codex-pid-<pid>` sentinel, both comfortably inside it; anything
 *  exotic simply reads as not-found, which is a safe answer rather than a wrong one. */
export const LAN_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Shape-check a `read` payload. Strict: an unknown `what` is refused rather than defaulted (a phone
 *  asking for something this build cannot serve must not silently get the other field), and the session
 *  id must pass the charset gate above. Pure; anything else → null → the same opaque 400 every other
 *  malformed payload gets. */
export function parseLanReadRequest(payload: Record<string, unknown>): LanReadRequest | null {
  const what = payload.what;
  const sessionId = payload.sessionId;
  if (what !== "plan" && what !== "permission-detail") return null;
  if (typeof sessionId !== "string" || !LAN_SESSION_ID_RE.test(sessionId)) return null;
  return { what, sessionId };
}

/** Where the bound port + listener-instance id are persisted, next to config.json (0600, atomicWrite —
 *  same directory discipline as every other piece of daemon state). Re-binding the SAME port across
 *  watchdog restarts is what lets the phone keep a cached endpoint working instead of re-probing; it is
 *  ALSO how the permission hook discovers the listener (its absence = no loopback polling at all). */
export const LAN_STATE_PATH = `${CC_DIR}/lan.json`;

/** What `lan.json` holds. `lid` identifies this LISTENER INSTANCE (not the machine): the phone caches
 *  per-lid, so a changed lid tells it "everything you cached about this endpoint is void". */
export interface LanState {
  port: number;
  lid: string;
  createdAt: number;
}

/** Parse `lan.json`. Anything malformed reads as "no persisted state" (bind fresh / no loopback poll) —
 *  a corrupt file must never keep the listener from coming up or make a hook throw. Pure. */
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

/** Loopback-only gate for the `answer-poll` op. Accepts the IPv4 loopback /8, IPv6 ::1, and the
 *  v4-mapped form node reports on a dual-stack socket. Anything else — including this machine's own LAN
 *  address — is NOT loopback: the op must be unreachable from the network the listener is bound to. */
export function isLoopbackAddress(address: unknown): boolean {
  if (typeof address !== "string" || address.length === 0) return false;
  const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
  return bare === "::1" || bare === "127.0.0.1" || bare.startsWith("127.");
}

/** True while this process is a `bun test` run. Unit tests see the developer's REAL home directory, so
 *  anything that would otherwise touch live daemon state (the listener's session trace; the hook's
 *  loopback poll, which would otherwise fetch the user's LIVE listener) keys off this. */
export function lanRunningUnderTest(): boolean {
  return process.argv.some((arg) => arg === "test" || arg.endsWith(".test.ts"));
}
