// crypto — portable E2E crypto primitives shared by the PC hook, the pairing CLI, and (via the
// cc-e2e-test-vectors.json this module's tests generate) a Swift CryptoKit counterpart that must
// interoperate byte-for-byte.
//
// Uses ONLY globalThis.crypto.subtle + the global atob/btoa — no Bun.*, no `node:crypto` import —
// so the same file runs unmodified under bun, node >= 18, and a Cloudflare Worker isolate.
//
// Two encodings are in play, deliberately different:
//   - base64url (b64url/fromB64url): no padding, `-`/`_` — used for QR/URL params.
//   - base64 (bytesToBase64/base64ToBytes, private): standard alphabet with padding — used for the
//     `blob` field, because it must byte-match Swift's `AES.GCM.SealedBox(combined:).base64EncodedString()`.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** e.g. "nomo-cc-e2e-v1" — see the plan's Global Constraints; never changes without a version bump. */
const HKDF_INFO = textEncoder.encode("nomo-cc-e2e-v1");
/** Domain tag for the pairing-v3 ECDH ratchet HKDF info (concatenated with the pairingId). FROZEN
 *  cross-platform — must match the iPhone app byte-for-byte. */
const RATCHET_INFO_PREFIX = "nomo-cc-ratchet-v1|";
/** P-256 ECDH parameters, reused by every keypair/derive call below. */
const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64url, no padding — for QR/URL params (pairingId, qrSecret, phoneNonce, etc). */
export function b64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of b64url. Restores standard alphabet + padding before decoding. */
export function fromB64url(s: string): Uint8Array {
  const standard = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  return base64ToBytes(padded);
}

/** HKDF-SHA256(ikm=qrSecret, salt=phoneNonce, info="nomo-cc-e2e-v1") -> 32 raw key bytes. */
export async function deriveE2EKey(qrSecret: Uint8Array, phoneNonce: Uint8Array): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", qrSecret, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: phoneNonce, info: HKDF_INFO },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

/** Generate an ephemeral P-256 ECDH keypair for the pairing-v3 ratchet. Returns the private key as
 *  pkcs8 DER (to persist 0600) and the public key as SEC1 uncompressed raw bytes (65 B, first byte
 *  0x04 — to publish in the QR `e=` param / the `/pair/start` body). `deriveBits` is the only usage
 *  the ratchet needs; the key is exportable so `pair` can persist the private half. */
export async function generateEphemeralKeyPair(): Promise<{ privPkcs8: Uint8Array; pubRaw: Uint8Array }> {
  const kp = (await crypto.subtle.generateKey(ECDH_P256, true, ["deriveBits"])) as CryptoKeyPair;
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { privPkcs8, pubRaw };
}

/** The pairing-v3 ECDH ratchet: derive the DURABLE key K1 from our ephemeral private key, the other
 *  side's ephemeral public key, and the bootstrap key K0 (the code/QR-derived key, mixed in as the
 *  HKDF salt so a relay that swaps the public keys can't derive K1 — it doesn't know K0).
 *
 *    Z  = ECDH-P256(ownPriv, otherPub)                          // 32-byte X coordinate
 *    K1 = HKDF-SHA256(ikm = Z, salt = K0, info = "nomo-cc-ratchet-v1|" + pairingId)   // 32 B
 *
 *  K1 replaces K0 as the persisted pairing key (forward secrecy — a code revealed AFTER pairing can't
 *  reconstruct Z, so it can't derive K1). FROZEN cross-platform contract (P-256 + HKDF-SHA256).
 *  `ownPrivPkcs8` is pkcs8 DER; `otherPubRaw` is 65-byte SEC1 uncompressed. Throws on a malformed
 *  public key (the caller treats that as a tampered claim). */
export async function deriveRatchetKey(
  ownPrivPkcs8: Uint8Array,
  otherPubRaw: Uint8Array,
  k0: Uint8Array,
  pairingId: string,
): Promise<Uint8Array> {
  const priv = await crypto.subtle.importKey("pkcs8", ownPrivPkcs8, ECDH_P256, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("raw", otherPubRaw, ECDH_P256, false, []);
  const z = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
  const zKey = await crypto.subtle.importKey("raw", z, "HKDF", false, ["deriveBits"]);
  const info = textEncoder.encode(RATCHET_INFO_PREFIX + pairingId);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: k0, info }, zKey, 256);
  return new Uint8Array(bits);
}

/** Raw AES-256-GCM seal with an explicit IV, combined as iv(12B) || ciphertext || tag(16B) — the
 *  same layout CryptoKit's `AES.GCM.SealedBox(combined:)` expects. Not exported: production callers
 *  must go through encryptBlob (random IV); reusing an IV under the same key breaks GCM's guarantees. */
async function sealCombined(key: Uint8Array, plaintext: object, iv: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const data = textEncoder.encode(JSON.stringify(plaintext));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, data);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return combined;
}

/** Encrypts `plaintext` under `key` with a fresh random 12-byte IV. Returns
 *  base64(iv(12B) || AES-256-GCM ciphertext || tag(16B)) — the wire `blob` field. */
export async function encryptBlob(key: Uint8Array, plaintext: object): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return bytesToBase64(await sealCombined(key, plaintext, iv));
}

/** TEST-ONLY: encrypts with a caller-supplied IV instead of a random one, so vector generation
 *  (and cross-platform fixtures) is reproducible. Never call this outside tests/vector generation —
 *  a fixed IV reused across real messages under the same key breaks AES-GCM's security guarantee. */
export async function encryptBlobWithIVForVectors(key: Uint8Array, plaintext: object, iv: Uint8Array): Promise<string> {
  return bytesToBase64(await sealCombined(key, plaintext, iv));
}

/** Inverse of encryptBlob. Throws (rejects) if `blob` was tampered with or `key` is wrong — GCM's
 *  tag check happens inside crypto.subtle.decrypt, so there is no separate verify step to forget. */
export async function decryptBlob(key: Uint8Array, blob: string): Promise<object> {
  const combined = base64ToBytes(blob);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
  return JSON.parse(textDecoder.decode(plaintext));
}

/** Lowercase hex SHA-256 of a UTF-8 string — used for the pairing auth hashes (pcAuthHash/appAuthHash). */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
