// unpair — tear down the pairing: best-effort server-side revoke, then remove the local config and
// the last-send marker. Interactive command (see pair.ts's output contract): sequential stdout,
// non-zero exit only for genuinely broken states — "not paired" is a clean exit 0.
//
// Works on BOTH config states: a COMPLETED pairing ({...e2eKeyB64}) and a still-PENDING pair attempt
// ({...qrSecretB64}) that was abandoned before a phone claimed — both carry a real server-side record
// (pairingId + pcSecret) that should be revoked, and both must be locally removable.
//
// PORTABILITY: bun AND node >= 18 (after Task 2.3 bundles it) — no Bun.* APIs.

import { readFile, unlink } from "node:fs/promises";
import { CC_DIR, LAST_SEND_PATH, PAIR_HTML_PATH, parseConfig, parsePendingConfig } from "../core/shared";

export interface UnpairDeps {
  fetchFn?: typeof fetch;
  print?: (line: string) => void;
  configPath?: string;
  lastSendPath?: string;
  /** The transient pairing page (pair.html) to tear down alongside the config; defaults to PAIR_HTML_PATH. */
  htmlPath?: string;
  /** Per-request ceiling on the server revoke so a hung socket can't stall the command. */
  revokeTimeoutMs?: number;
}

/** The minimal auth material a revoke needs — present in BOTH a completed and a pending config. */
interface RevokeCreds {
  url: string;
  pairingId: string;
  pcSecret: string;
}

/** Pull revoke credentials from either a COMPLETED ({...e2eKeyB64}) or a still-PENDING
 *  ({...qrSecretB64}) config: an abandoned pending pair still owns a claimable server-side record, so
 *  it should be revoked too. Null only for a corrupt/pre-v2 config that carries no id/secret to
 *  present — nothing to revoke, but still locally removable.
 *
 *  NOTE: pair.ts's revokeExisting keeps a deliberate LOCAL MIRROR of this extraction (revoke-before-
 *  repair). It is not shared via core/shared because that module is inlined into every plugin entry
 *  bundle — hoisting this helper there ripples ~9 identical lines into 5 unrelated dist artifacts. Keep
 *  the two in sync. */
function revokeCreds(raw: string): RevokeCreds | null {
  const completed = parseConfig(raw);
  if (completed) return { url: completed.url, pairingId: completed.pairingId, pcSecret: completed.pcSecret };
  const pending = parsePendingConfig(raw);
  if (pending) return { url: pending.url, pairingId: pending.pairingId, pcSecret: pending.pcSecret };
  return null;
}

/** Revoke on the worker (best-effort), then delete the local pairing state. Returns an exit code. */
export async function unpair(deps: UnpairDeps = {}): Promise<number> {
  const fetchFn = deps.fetchFn ?? fetch;
  const print = deps.print ?? ((line: string) => console.log(line));
  const configPath = deps.configPath ?? `${CC_DIR}/config.json`;
  const lastSendPath = deps.lastSendPath ?? LAST_SEND_PATH;
  const htmlPath = deps.htmlPath ?? PAIR_HTML_PATH;
  const revokeTimeoutMs = deps.revokeTimeoutMs ?? 5000;

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    print("Not paired.");
    return 0;
  }

  const creds = revokeCreds(raw);
  if (creds) {
    try {
      const res = await fetchFn(`${creds.url}/v1/cc/pair/revoke`, {
        method: "POST",
        headers: { "x-cc-pairing": creds.pairingId, "x-cc-auth": creds.pcSecret },
        signal: AbortSignal.timeout(revokeTimeoutMs),
      });
      if (res.ok) {
        print("Revoked the pairing on the server.");
      } else if (res.status === 404) {
        // The pairing is already gone server-side (the phone forgot it, or a pending id expired) —
        // requirePCAuth 404s an unknown pairing (see server/src/pairing.ts). Nothing to revoke, which
        // is exactly the outcome we want, so treat it as success rather than an error.
        print("Pairing was already revoked on the server.");
      } else {
        print(`Server revoke returned HTTP ${res.status} — removing the local pairing anyway.`);
      }
    } catch {
      // Network error / timeout — the local teardown still proceeds so the machine ends up unpaired.
      print("Could not reach the worker to revoke — removing the local pairing anyway.");
    }
  } else {
    // A corrupt/pre-v2 config can't be revoked (no id/secret) but should still be cleaned up.
    print("Local config is not a valid pairing — removing it.");
  }

  await unlink(configPath).catch(() => {});
  await unlink(lastSendPath).catch(() => {});
  await unlink(htmlPath).catch(() => {}); // tear down the transient pairing page (best-effort)
  print("Unpaired ✓");
  return 0;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    console.log("usage: unpair [--check]  — revoke and remove this machine's Nomo pairing");
    process.exit(0);
  }
  process.exit(await unpair());
}
