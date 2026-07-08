import { describe, expect, test } from "bun:test";
import { deriveCodeIkm, formatCodeString, randomCodeWords, uniformIndex } from "./pair-code";
import { deriveE2EKey } from "./crypto";
import { BIP39_WORDLIST } from "./wordlist";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("BIP39 wordlist", () => {
  test("is exactly 2048 words, in the frozen order", () => {
    expect(BIP39_WORDLIST.length).toBe(2048);
    expect(BIP39_WORDLIST[0]).toBe("abandon");
    expect(BIP39_WORDLIST[2047]).toBe("zoo");
  });
});

// The FROZEN cross-platform key-derivation vector. If this ever changes, the iPhone app's code path
// breaks — treat a failure here as a contract violation, not a test to "fix".
describe("deriveCodeIkm — mandatory cross-platform test vector (pairing v3: 6 words, salt v2)", () => {
  const words = ["ocean", "sunset", "mango", "river", "atlas", "cabin"];
  const pairingId = "0123456789abcdef0123456789abcdef";

  test("codeIkm = PBKDF2-SHA256(6 words, 'nomo-pair-code-v2|'+pairingId, 600000, 32) matches the frozen vector", async () => {
    const ikm = await deriveCodeIkm(words, pairingId);
    expect(hex(ikm)).toBe("9643dc4cd683b866afa5bd764394ccb1c063bfba8224e64209d01055655c758c");
  });

  test("K0 = HKDF(codeIkm, phoneNonce) matches the frozen vector (the ratchet's bootstrap key)", async () => {
    const ikm = await deriveCodeIkm(words, pairingId);
    const phoneNonce = fromHex("000102030405060708090a0b0c0d0e0f");
    const key = await deriveE2EKey(ikm, phoneNonce);
    expect(hex(key)).toBe("39f005d941b7bfc87b66e5a1f6a6b8c78562da363189f5ba55208812fe6b3a9e");
  });
});

describe("formatCodeString", () => {
  test("joins channel + words, all lowercase", () => {
    expect(formatCodeString(7, ["koala", "sunset", "mango", "river"])).toBe("7-koala-sunset-mango-river");
    expect(formatCodeString(12, ["Koala", "SUNSET"])).toBe("12-koala-sunset");
  });
});

describe("uniformIndex (rejection sampling, no modulo bias)", () => {
  test("always returns an index in [0, max)", () => {
    // Deterministic byte source cycling through many 2-byte draws.
    let i = 0;
    const rand = (_n: number) => new Uint8Array([i++ & 0xff, (i * 7) & 0xff]);
    for (let k = 0; k < 5000; k++) {
      const idx = uniformIndex(2048, rand);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(2048);
    }
  });

  test("decodes a 2-byte big-endian draw modulo max", () => {
    // For a power-of-two max (2048) there is no rejection: v = (b0<<8)|b1, index = v % 2048.
    const rand = () => new Uint8Array([0x12, 0x34]); // 0x1234 = 4660; 4660 % 2048 = 564
    expect(uniformIndex(2048, rand)).toBe(4660 % 2048);
  });
});

describe("randomCodeWords", () => {
  test("returns 6 valid BIP39 words from the injected crypto source", () => {
    const rand = (_n: number) => new Uint8Array([0x00, 0x01]); // index 1 → "ability" every draw
    const words = randomCodeWords(rand);
    expect(words).toEqual(["ability", "ability", "ability", "ability", "ability", "ability"]);
    for (const w of words) expect(BIP39_WORDLIST).toContain(w);
  });

  test("honors a custom count", () => {
    const rand = (_n: number) => new Uint8Array([0x00, 0x00]); // index 0 → "abandon"
    expect(randomCodeWords(rand, 2)).toEqual(["abandon", "abandon"]);
  });
});
