import { describe, expect, test } from "bun:test";
import {
  b64url,
  decryptBlob,
  deriveE2EKey,
  deriveRatchetKey,
  encryptBlob,
  encryptBlobWithIVForVectors,
  fromB64url,
  generateEphemeralKeyPair,
  sha256Hex,
} from "./crypto";
import vectors from "./cc-e2e-test-vectors.json";

// Fixed inputs pinned for Step 1c: qrSecret = sixteen 0x01 bytes, phoneNonce = sixteen 0x02 bytes.
// Expected key computed once via globalThis.crypto.subtle HKDF-SHA256(info="nomo-cc-e2e-v1") and
// hardcoded here so a regression in the derivation (wrong hash, wrong info string, swapped
// ikm/salt) fails loudly instead of only showing up cross-platform against Swift later.
const QR_SECRET = new Uint8Array(16).fill(1);
const PHONE_NONCE = new Uint8Array(16).fill(2);
const EXPECTED_KEY_HEX = "256a40ccc3cbb4c7338d5fe2bfbf7ae2f021d46a71a99c0d9a935f48e9a6fe22";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("deriveE2EKey", () => {
  test("matches the pinned HKDF-SHA256 vector", async () => {
    const key = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    expect(key.length).toBe(32);
    expect(toHex(key)).toBe(EXPECTED_KEY_HEX);
  });

  test("different phoneNonce (salt) yields a different key", async () => {
    const key = await deriveE2EKey(QR_SECRET, new Uint8Array(16).fill(3));
    expect(toHex(key)).not.toBe(EXPECTED_KEY_HEX);
  });
});

describe("encryptBlob / decryptBlob round-trip", () => {
  test("decrypts back to the original object", async () => {
    const key = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const plaintext = { status: "working", title: "add font and timer", machine: "Karrix's MacBook", label: "api-status" };
    const blob = await encryptBlob(key, plaintext);
    expect(await decryptBlob(key, blob)).toEqual(plaintext);
  });

  test("round-trips CJK + emoji content byte-for-byte", async () => {
    const key = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const plaintext = { status: "done", title: "修复登录问题 🎉", machine: "开发机", label: "api-status" };
    const blob = await encryptBlob(key, plaintext);
    expect(await decryptBlob(key, blob)).toEqual(plaintext);
  });

  test("tampering a single ciphertext byte throws", async () => {
    const key = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const blob = await encryptBlob(key, { title: "hello" });
    const bytes = fromB64urlPadded(blob);
    // Flip a bit well past the 12-byte IV, inside the ciphertext/tag region.
    bytes[20] ^= 0xff;
    const tampered = toBase64Padded(bytes);
    await expect(decryptBlob(key, tampered)).rejects.toThrow();
  });

  test("wrong key throws instead of returning garbage", async () => {
    const key = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const wrongKey = await deriveE2EKey(new Uint8Array(16).fill(9), PHONE_NONCE);
    const blob = await encryptBlob(key, { title: "hello" });
    await expect(decryptBlob(wrongKey, blob)).rejects.toThrow();
  });
});

describe("b64url / fromB64url", () => {
  test("output has no padding and no +, /", () => {
    // All-0xff bytes are the classic case that produces +/= in standard base64.
    const encoded = b64url(new Uint8Array(16).fill(0xff));
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });

  test("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 16, 32, 64, 128]);
    expect(fromB64url(b64url(bytes))).toEqual(bytes);
  });
});

describe("sha256Hex", () => {
  test("matches a known SHA-256 vector for the empty string", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("is deterministic and case-normalized lowercase hex", async () => {
    const a = await sha256Hex("nomo-cc-e2e-v1");
    const b = await sha256Hex("nomo-cc-e2e-v1");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("encryptBlobWithIVForVectors (test-only deterministic export)", () => {
  test("same key + same IV + same plaintext produces the same blob", async () => {
    const key = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const iv = new Uint8Array(12).fill(7);
    const a = await encryptBlobWithIVForVectors(key, { title: "pinned" }, iv);
    const b = await encryptBlobWithIVForVectors(key, { title: "pinned" }, iv);
    expect(a).toBe(b);
  });

  test("still decrypts correctly via the normal decryptBlob path", async () => {
    const key = await deriveE2EKey(QR_SECRET, PHONE_NONCE);
    const iv = new Uint8Array(12).fill(9);
    const plaintext = { status: "needsAttention", title: "审查 PR 🔍", machine: "m", label: "l" };
    const blob = await encryptBlobWithIVForVectors(key, plaintext, iv);
    expect(await decryptBlob(key, blob)).toEqual(plaintext);
  });
});

describe("cc-e2e-test-vectors.json (cross-platform fixture consumed by the Swift counterpart)", () => {
  function fromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  test("HKDF vector matches deriveE2EKey", async () => {
    const { qrSecretHex, phoneNonceHex, expectedKeyHex } = vectors.hkdf;
    const key = await deriveE2EKey(fromHex(qrSecretHex), fromHex(phoneNonceHex));
    expect(toHex(key)).toBe(expectedKeyHex);
  });

  test("decryptBlob opens every GCM vector to its recorded plaintext", async () => {
    expect(vectors.gcm.length).toBeGreaterThanOrEqual(3);
    for (const { keyHex, blobB64, plaintextJson } of vectors.gcm) {
      expect(await decryptBlob(fromHex(keyHex), blobB64)).toEqual(plaintextJson);
    }
  });

  test("at least one vector's title exercises CJK + emoji (UTF-8 handling parity with Swift)", () => {
    const hasCjkEmoji = vectors.gcm.some(
      (v) => /[一-鿿]/.test(v.plaintextJson.title) && /\p{Emoji}/u.test(v.plaintextJson.title),
    );
    expect(hasCjkEmoji).toBe(true);
  });
});

// The FROZEN pairing-v3 ratchet vector (spec 2026-07-09). If Z or K1 ever changes, the iPhone app's
// ratchet breaks — treat a failure here as a cross-platform contract violation, not a test to "fix".
describe("pairing-v3 ECDH ratchet — mandatory cross-platform KAT (Z + K1 byte-equality)", () => {
  const r = vectors.ratchet;

  function fromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  /** The spec's pkcs8 blobs are standard base64 with NO padding — decode via atob after re-padding. */
  function pkcs8Bytes(b64: string): Uint8Array {
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  test("codeIkm (PBKDF2, 6 words) + K0 (HKDF) match the pinned vector", async () => {
    // K0 = HKDF(codeIkm, phoneNonce) — codeIkm is verified against its own hex in pair-code.test.ts.
    const k0 = await deriveE2EKey(fromHex(r.codeIkmHex), fromHex(r.phoneNonceHex));
    expect(toHex(k0)).toBe(r.k0Hex);
  });

  test("Z = ECDH(dPh, QPC) matches the pinned X-coordinate (importing dPh via pkcs8, QPC via raw)", async () => {
    const priv = await crypto.subtle.importKey(
      "pkcs8", pkcs8Bytes(r.dPh_pkcs8), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
    );
    const pub = await crypto.subtle.importKey(
      "raw", fromHex(r.qpcHex), { name: "ECDH", namedCurve: "P-256" }, false, [],
    );
    const z = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
    expect(toHex(z)).toBe(r.zHex);
  });

  test("K1 = deriveRatchetKey(dPh, QPC, K0, pairingId) matches the pinned durable key", async () => {
    const k1 = await deriveRatchetKey(pkcs8Bytes(r.dPh_pkcs8), fromHex(r.qpcHex), fromHex(r.k0Hex), r.pairingId);
    expect(toHex(k1)).toBe(r.k1Hex);
  });

  test("the ECDH is symmetric: deriveRatchetKey(dPC, QPh, …) yields the same K1", async () => {
    const k1 = await deriveRatchetKey(pkcs8Bytes(r.dPC_pkcs8), fromHex(r.qphHex), fromHex(r.k0Hex), r.pairingId);
    expect(toHex(k1)).toBe(r.k1Hex);
  });

  test("generateEphemeralKeyPair produces a 65-byte SEC1 public key (0x04) and a usable pkcs8 private key", async () => {
    const a = await generateEphemeralKeyPair();
    const b = await generateEphemeralKeyPair();
    expect(a.pubRaw.length).toBe(65);
    expect(a.pubRaw[0]).toBe(0x04); // uncompressed point
    // Fresh keypairs derive a real shared key (round-trips through deriveRatchetKey without throwing).
    const k0 = new Uint8Array(32).fill(5);
    const k1 = await deriveRatchetKey(a.privPkcs8, b.pubRaw, k0, "pid");
    const k1b = await deriveRatchetKey(b.privPkcs8, a.pubRaw, k0, "pid");
    expect(toHex(k1)).toBe(toHex(k1b)); // ECDH symmetry on freshly generated keys
    expect(k1.length).toBe(32);
  });
});

// --- local helpers for the tamper test (standard base64 <-> bytes, no crypto.ts internals) ---
function fromB64urlPadded(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function toBase64Padded(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
