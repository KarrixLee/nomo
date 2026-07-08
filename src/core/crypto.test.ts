import { describe, expect, test } from "bun:test";
import {
  b64url,
  decryptBlob,
  deriveE2EKey,
  encryptBlob,
  encryptBlobWithIVForVectors,
  fromB64url,
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
