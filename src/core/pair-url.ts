// pair-url — the `nomo://pair` QR payload, shared by the pair entry and handoff (which rebuilds it on a
// cloud box). Lives in core because importing an ENTRY drags its main block into the bundle.

import { b64url, type Bytes } from "./crypto";

const textEncoder = new TextEncoder();

// The custom domain on the same worker that still answers on
// api-status-push.karrixlee1231.workers.dev. Both hostnames share one KV, so a plugin and an app
// on opposite hosts still resolve the same pairing record — this can flip independently of the
// app's PushServer.baseURL. Override with NOMO_WORKER_URL for wrangler dev / staging.
export const DEFAULT_WORKER_URL = "https://api.nomo.gg";

/** The `nomo://pair` deep link the phone scans: worker URL (b64url of UTF-8), pairing id (hex),
 *  QR secret (b64url of 16 raw bytes — the HKDF input that never touches the worker), and the PC's
 *  ephemeral ratchet public key `QPC` (`e=`, b64url of the 65-byte SEC1 point — a PUBLIC key, safe to
 *  relay; the phone needs it to compute the ratchet's ECDH before it claims).
 *
 *  `u` is OMITTED when the worker URL is the production default (DEFAULT_WORKER_URL): the app fills
 *  in the same constant for a `u`-less link. This is the single biggest QR-shrink lever — the b64url
 *  worker URL is ~66 chars, over half the payload, so dropping it keeps the production QR small even
 *  with the added `e=` key. The 65-byte `e=` (~87 chars) can push the default payload past level-Q's
 *  v10 capacity; renderQRSVG already falls back to level L (larger capacity) so it always renders. */
export function buildPairURL(
  workerUrl: string, pairingId: string, qrSecret: Bytes, pcEphPub: Bytes,
): string {
  const u = workerUrl === DEFAULT_WORKER_URL ? "" : `&u=${b64url(textEncoder.encode(workerUrl))}`;
  return `nomo://pair?v=1${u}&p=${pairingId}&s=${b64url(qrSecret)}&e=${b64url(pcEphPub)}`;
}
