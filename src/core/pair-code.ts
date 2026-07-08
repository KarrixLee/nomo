// pair-code.ts — the "magic code" pairing path (pairing v2). When the worker assigns a numeric
// `channel`, the pairing page shows a human-typeable code — `<channel>-w1-w2-w3-w4` — the user reads
// into the Nomo app instead of scanning the QR. The four words index into the FROZEN BIP39 English
// wordlist (wordlist.ts); the phone reconstructs the same shared E2E key from the words the user typed.
//
// Key derivation (FROZEN cross-platform contract — must match the iPhone app byte-for-byte):
//   codeIkm = PBKDF2-SHA256(password = utf8("w1-w2-w3-w4")  [words ONLY, no channel],
//                           salt     = utf8("nomo-pair-code-v1|" + pairingId),
//                           iterations = 600000, dkLen = 32)
//   e2eKey  = HKDF-SHA256(ikm = codeIkm, salt = phoneNonce, info = "nomo-cc-e2e-v1")   (deriveE2EKey)
// i.e. codeIkm is a drop-in replacement for the QR path's qrSecret as the HKDF input. The channel is
// NOT part of the derivation — it only routes the pairing at the worker — so it never enters PBKDF2.
//
// PORTABILITY: node:crypto's pbkdf2 works under BOTH bun and node >= 18 (WebCrypto's PBKDF2 is also an
// option, but node:crypto keeps the 600k-iteration call synchronous-friendly and matches the app).

import { pbkdf2 } from "node:crypto";
import { BIP39_WORDLIST } from "./wordlist";

/** The pending-pairing TTL / code lifetime salt tag — bumping this string invalidates every code, so
 *  it changes ONLY alongside a matching app change (a versioned domain separator). */
const CODE_SALT_PREFIX = "nomo-pair-code-v1|";
const PBKDF2_ITERATIONS = 600_000;
const CODE_KEY_LEN = 32;
/** How many words a code carries (the `<channel>-w1-w2-w3-w4` form). */
export const CODE_WORD_COUNT = 4;

/** One uniformly-random index in [0, maxExclusive) drawn from crypto bytes, rejection-sampled so there
 *  is NO modulo bias: a 16-bit draw is rejected when it falls in the short non-uniform tail above the
 *  largest multiple of maxExclusive. (For 2048 = 2^11 the tail is empty and nothing is ever rejected,
 *  but the rejection guard keeps the routine correct for any wordlist size.) `randomBytes(n)` returns
 *  n fresh crypto bytes. */
export function uniformIndex(maxExclusive: number, randomBytes: (n: number) => Uint8Array): number {
  const range = 0x1_00_00; // 2 bytes → 0..65535
  const limit = range - (range % maxExclusive); // largest multiple of maxExclusive that fits in `range`
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const b = randomBytes(2);
    const v = (b[0] << 8) | b[1];
    if (v < limit) return v % maxExclusive;
    // else: in the biased tail — draw again (vanishingly rare; impossible for a power-of-two wordlist)
  }
}

/** Pick CODE_WORD_COUNT uniformly-random words from the BIP39 wordlist (with replacement — the 2048^4
 *  space is ample and the phone matches by position, so a repeated word is fine). `randomBytes` is the
 *  crypto source (injectable for tests). */
export function randomCodeWords(
  randomBytes: (n: number) => Uint8Array,
  count = CODE_WORD_COUNT,
): string[] {
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(BIP39_WORDLIST[uniformIndex(BIP39_WORDLIST.length, randomBytes)]);
  }
  return words;
}

/** PBKDF2-SHA256(password = words.join("-"), salt = "nomo-pair-code-v1|" + pairingId, 600000, 32) →
 *  the 32-byte codeIkm that replaces qrSecret as the HKDF input for the code pairing path. Words ONLY —
 *  the channel is never part of the password. */
export function deriveCodeIkm(words: string[], pairingId: string): Promise<Uint8Array> {
  const password = words.join("-");
  const salt = `${CODE_SALT_PREFIX}${pairingId}`;
  return new Promise<Uint8Array>((resolve, reject) => {
    pbkdf2(password, salt, PBKDF2_ITERATIONS, CODE_KEY_LEN, "sha256", (err, derived) => {
      if (err) reject(err);
      else resolve(new Uint8Array(derived));
    });
  });
}

/** The full code string shown on the pairing page: `<channel>-w1-w2-w3-w4`, all lowercase. The channel
 *  routes the pairing at the worker; the words derive the key. */
export function formatCodeString(channel: number, words: string[]): string {
  return `${channel}-${words.join("-")}`.toLowerCase();
}
