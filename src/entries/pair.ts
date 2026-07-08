// pair — the PC side of pairing (pairing v2), split into two phases so the pairing page opens within
// seconds instead of after a blocking 10-minute poll (Claude Code's Bash tool does not stream output —
// nothing shows until the process exits, so a foreground poll would hide the page-opened line).
//
//   `pair.mjs`        (default) — the FAST start: mints the pairing, registers it, writes a PENDING
//                     config (qrSecret + codeIkm persisted 0600), writes a self-contained themed
//                     `pair.html` (QR + one-time code) and opens it in the browser, then exits within a
//                     couple of seconds. Also spawns the detached watchdog so the pairing still
//                     completes if the wait step never runs.
//   `pair.mjs wait`   — reads the pending config and polls until the phone claims it (up to 10 min),
//                     then rewrites config to its completed form (secrets dropped, e2eKey present),
//                     acks, and prints `Paired with … ✓`.
//
// Output contract: pure sequential stdout lines — no ANSI cursor tricks/clears — so it renders cleanly
// inside a slash-command transcript. Unlike the hook (silence + exit 0 always), these are interactive
// commands: failures print ONE clear friendly line and exit non-zero. NOTHING secret ever reaches
// stdout — no QR art, no `nomo://pair` URL, no code words; the browser page is the only place they show.
//
// PORTABILITY: bun AND node >= 18 (after Task 2.3 bundles it) — no Bun.* APIs, node: imports and
// globalThis.crypto only.

import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import {
  atomicWrite, CC_DIR, completePendingPairing, ensureWatchdog, PAIR_HTML_PATH, parseConfig,
  parsePendingConfig,
} from "../core/shared";
import { b64url, sha256Hex } from "../core/crypto";
import { deriveCodeIkm, formatCodeString, randomCodeWords } from "../core/pair-code";
import { renderPairPage } from "../core/pair-page";
import { renderQRSVG } from "../qr/qr-svg";

// decryptDeviceName lived here historically; it now backs both this CLI and the watchdog self-heal,
// so it moved to shared. Re-export it so its public name/import path stays stable.
export { decryptDeviceName } from "../core/shared";

export const DEFAULT_WORKER_URL = "https://api-status-push.karrixlee1231.workers.dev";
const POLL_INTERVAL_MS = 3_000;
const MAX_WAIT_MS = 600_000; // == the worker's 10-minute pending-pairing TTL
/** Every network call gets its own ceiling so a hung socket can't stall the 10-minute pairing
 *  window (or the interactive start/ack calls) indefinitely. */
const FETCH_TIMEOUT_MS = 10_000;
/** config.json holds pcSecret + e2eKeyB64 (or, mid-pairing, qrSecretB64) — owner-only. */
const CONFIG_MODE = 0o600;
/** The post-pair ack is best-effort, but worth retrying a few times before giving up — the event
 *  route self-heals a lost ack, so this is only ever a KV-tidiness concern, never a lost pairing. */
const ACK_ATTEMPTS = 3;
const ACK_RETRY_DELAY_MS = 1_000;

const textEncoder = new TextEncoder();

/** Injectable seams so pair.test.ts can run each phase with a scripted fetch, an instant sleep (no
 *  real 3 s waits), deterministic randomness, a temp config path, and a no-op watchdog spawn.
 *  Production (`import.meta.main`) uses every default. */
export interface PairDeps {
  fetchFn?: typeof fetch;
  /** Awaited between status polls; tests inject an instant resolver and assert the call pattern. */
  sleep?: (ms: number) => Promise<void>;
  print?: (line: string) => void;
  randomBytes?: (n: number) => Uint8Array;
  configPath?: string;
  workerUrl?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  /** Spawns the detached self-heal watchdog after a successful start; tests inject a no-op. */
  spawnWatchdog?: () => void;
  /** Wall clock; injectable so tests get a deterministic createdAt stamp. Defaults to Date.now. */
  now?: () => number;
  /** Where the pairing page (pair.html) is written (0600) and opened. Defaults to PAIR_HTML_PATH;
   *  tests point it at a temp dir. A stale page here is removed at the START of every pairStart. */
  htmlPath?: string;
  /** Opens the rendered pairing page in the default browser. Returns true when it launched one, false
   *  to fall back to printing the path. Defaults to openInBrowser (spawn open/xdg-open, best-effort);
   *  tests inject a spy so no real browser launches. */
  openFile?: (path: string) => boolean;
  /** Picks the magic-code words for the code pairing path. Defaults to randomCodeWords (crypto random
   *  from the BIP39 wordlist); tests inject fixed words for deterministic pages. */
  pickWords?: () => string[];
  /** `wait --timeout <seconds>` (as ms): bounds the poll loop. A timeout is then a SOFT exit-0 (the
   *  Codex flow — self-heal finishes in the background), not the hard 10-min "window expired" exit-1.
   *  The QR's real 10-min TTL (the createdAt guard) is unchanged. Absent → historical full-window wait. */
  softTimeoutMs?: number;
  /** Force printing the one-time code to stdout regardless of TTY (`--show-code`) — the SSH/headless
   *  escape hatch where the browser page can't be seen. Defaults to false. */
  showCode?: boolean;
  /** Whether stdout is an interactive terminal. When true (the user ran `pair` directly in a real
   *  terminal, not an agent's Bash tool / a pipe), pairStart ALSO prints the one-time code. Defaults to
   *  `process.stdout.isTTY === true`; tests inject a boolean. */
  isTTY?: boolean;
}

/** Default browser opener: `open` on darwin, `xdg-open` on linux, detached + unref'd so the CLI never
 *  waits on the browser. Best-effort — returns false (caller prints the path instead) on any other
 *  platform, a spawn failure, or when NOMO_NO_OPEN=1 (the test / headless escape hatch). */
function openInBrowser(path: string): boolean {
  if (process.env.NOMO_NO_OPEN === "1") return false;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!cmd) return false;
  try {
    spawn(cmd, [path], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false; // no browser / spawn blocked — the caller prints the saved path
  }
}

/** Delete a stale PENDING config on a terminal expiry/gone path so /status stops reporting
 *  "waiting for phone scan" forever. Tolerates ENOENT (already gone / raced). NEVER call this on a
 *  completed config — callers re-read and confirm the on-disk config is still pending first. */
async function removePendingConfig(configPath: string): Promise<void> {
  try {
    await unlink(configPath);
  } catch {
    // already gone (raced with the watchdog, or never written) — fine
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `nomo://pair` deep link the phone scans: worker URL (b64url of UTF-8), pairing id (hex),
 *  QR secret (b64url of 16 raw bytes — the HKDF input that never touches the worker).
 *
 *  `u` is OMITTED when the worker URL is the production default (DEFAULT_WORKER_URL): the app fills
 *  in the same constant for a `u`-less link. This is the single biggest QR-shrink lever — the b64url
 *  worker URL is ~66 chars, over half the payload, so dropping it takes the production QR from
 *  version 8 down to version 4 (fewer terminal rows, which matters because Claude Code retypes the
 *  QR line-by-line). Self-hosters on a non-default URL still get an explicit `u`. */
export function buildPairURL(workerUrl: string, pairingId: string, qrSecret: Uint8Array): string {
  const u = workerUrl === DEFAULT_WORKER_URL ? "" : `&u=${b64url(textEncoder.encode(workerUrl))}`;
  return `nomo://pair?v=1${u}&p=${pairingId}&s=${b64url(qrSecret)}`;
}

/** Extract the auth material a revoke needs from EITHER a COMPLETED ({...e2eKeyB64}) or a still-PENDING
 *  ({...qrSecretB64}) config — both carry url + pairingId + pcSecret, which is all revoke presents.
 *
 *  This is a deliberate LOCAL MIRROR of revokeCreds in src/entries/unpair.ts. It is NOT hoisted into
 *  core/shared because that module is inlined verbatim into every plugin entry bundle, so a helper
 *  there ripples ~9 identical lines into 5 unrelated dist artifacts (cc-status, cc-watchdog, codex-*,
 *  status-cmd). Keep this in sync with unpair.ts. */
function revokeCreds(raw: string): { url: string; pairingId: string; pcSecret: string } | null {
  const completed = parseConfig(raw);
  if (completed) return { url: completed.url, pairingId: completed.pairingId, pcSecret: completed.pcSecret };
  const pending = parsePendingConfig(raw);
  if (pending) return { url: pending.url, pairingId: pending.pairingId, pcSecret: pending.pcSecret };
  return null;
}

/** Best-effort revoke of an EXISTING pairing before re-pairing overwrites the config — keeps the
 *  worker's KV free of orphaned pairings. Handles BOTH states via revokeCreds (mirrors unpair): a
 *  COMPLETED config ({...e2eKeyB64}) AND a still-PENDING one ({...qrSecretB64}). Revoking the pending
 *  state too matters because an abandoned mid-pairing record otherwise squats at the worker until its
 *  TTL — 600s for an unclaimed pending record, 24h for a claimed-but-unacked one — so re-pairing without
 *  revoking would leave a stale claimable record behind each time. Any failure (network, 401, gone) is
 *  ignored — an unreachable worker must not block re-pairing. */
async function revokeExisting(fetchFn: typeof fetch, configPath: string, print: (l: string) => void): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return; // no config — fresh pair
  }
  const creds = revokeCreds(raw);
  if (!creds) return; // corrupt / pre-v2 config with no id/secret to revoke — just start fresh
  print(`Revoking the previous pairing (pairing ${creds.pairingId.slice(0, 8)}…) before starting fresh.`);
  try {
    await fetchFn(`${creds.url}/v1/cc/pair/revoke`, {
      method: "POST",
      headers: { "x-cc-pairing": creds.pairingId, "x-cc-auth": creds.pcSecret },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // best-effort: an unreachable worker must not block re-pairing
  }
}

/** Phase 1 — the FAST start. Registers the pairing, persists a PENDING config, prints the QR, and
 *  returns within a couple of seconds. Returns a process exit code (0 = QR printed, wait next). */
export async function pairStart(deps: PairDeps = {}): Promise<number> {
  const fetchFn = deps.fetchFn ?? fetch;
  const print = deps.print ?? ((line: string) => console.log(line));
  const randomBytes = deps.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const configPath = deps.configPath ?? `${CC_DIR}/config.json`;
  const workerUrl = (deps.workerUrl ?? process.env.NOMO_WORKER_URL ?? DEFAULT_WORKER_URL).replace(/\/$/, "");
  const spawnWatchdog = deps.spawnWatchdog ?? ensureWatchdog;
  const now = deps.now ?? Date.now;
  const htmlPath = deps.htmlPath ?? PAIR_HTML_PATH;
  const pickWords = deps.pickWords ?? (() => randomCodeWords(randomBytes));

  // Remove any stale pairing page from a PRIOR attempt at the very start — so a leftover page embedding
  // an old (now-revoked) QR secret / code can never be re-used. Tolerates ENOENT.
  await unlink(htmlPath).catch(() => {});

  // Re-pairing over an existing config revokes the old one best-effort — a COMPLETED pairing or an
  // abandoned still-PENDING one (both own a claimable server-side record) — before overwriting it.
  await revokeExisting(fetchFn, configPath, print);

  const pairingId = bytesToHex(randomBytes(16)); // 32-hex
  const pcSecret = b64url(randomBytes(24));
  const qrSecret = randomBytes(16); // never sent to the worker — rides only in the QR/URL

  let startRes: Response;
  try {
    startRes = await fetchFn(`${workerUrl}/v1/cc/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingId, pcAuthHash: await sha256Hex(pcSecret) }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    print(`Could not reach the worker at ${workerUrl} — check your network and try again.`);
    return 1;
  }
  if (startRes.status === 429) {
    print("Too many pairing attempts from this network — wait an hour and try again.");
    return 1;
  }
  if (startRes.status === 409) {
    print("Pairing id collision with an existing pairing — just run pair again.");
    return 1;
  }
  if (!startRes.ok) {
    print(`The worker rejected the pairing request (HTTP ${startRes.status}) — try again.`);
    return 1;
  }

  // The pairing-v2 worker returns a numeric `channel` (>= 1) — the routing prefix for the human-typeable
  // magic code. Absent / non-numeric (an OLD worker) → skip the code path entirely: the page shows the
  // QR alone, and the config carries no codeIkm (a `path:"code"` claim then can't complete). A missing
  // or non-JSON body is tolerated the same way.
  let channel: number | undefined;
  try {
    const startBody = (await startRes.json()) as { channel?: unknown };
    if (typeof startBody.channel === "number" && Number.isInteger(startBody.channel) && startBody.channel >= 1) {
      channel = startBody.channel;
    }
  } catch {
    // no body / not JSON → treat as an old worker (QR-only)
  }

  // With a channel, mint the magic code: 4 crypto-random BIP39 words → the codeIkm (PBKDF2 over the
  // words, salted by pairingId) that replaces qrSecret as the code path's HKDF input. The code STRING
  // (`<channel>-w1-w2-w3-w4`) is shown on the page only; codeIkm is persisted so `wait` / the watchdog
  // can complete a code claim without recomputing the 600k-iteration PBKDF2.
  let codeString: string | undefined;
  let codeIkm: Uint8Array | undefined;
  if (channel !== undefined) {
    const words = pickWords();
    codeIkm = await deriveCodeIkm(words, pairingId);
    codeString = formatCodeString(channel, words);
  }

  // Persist the PENDING config BEFORE opening the page: qrSecret (and codeIkm, if any) must be on disk
  // so the `wait` step (or the watchdog self-heal) can derive the key once the phone claims — even if
  // this process is killed the instant after the page opens. Owner-only (0600); it is key material.
  await atomicWrite(configPath, JSON.stringify({
    url: workerUrl,
    pairingId,
    pcSecret,
    qrSecretB64: b64url(qrSecret),
    ...(codeIkm ? { codeIkmB64: b64url(codeIkm) } : {}),
    createdAt: now(), // bounds the watchdog self-heal to the QR's 10-min TTL
  }), CONFIG_MODE);

  // Spawn the detached watchdog now so the pairing still completes if `wait` is never run (Ctrl-C,
  // closed terminal, dead session): it self-heals a claimed-but-pending config. Best-effort, no wait.
  spawnWatchdog();

  // SECURITY (E2E / blind worker): the QR encodes qrSecret and the page shows the magic code — the HKDF
  // inputs the worker must NEVER see (with the worker-held phoneNonce it would derive every session's
  // AES key). Both live ONLY on the themed pairing page written 0600 and opened in the browser; NOTHING
  // secret (no QR art, no `nomo://pair` URL, no code words) is ever printed to stdout, because stdout
  // lands in greppable agent transcripts. The page is torn down the instant pairing completes
  // (completePendingPairing / the watchdog self-heal / unpair).
  const url = buildPairURL(workerUrl, pairingId, qrSecret);
  const page = renderPairPage({
    svg: renderQRSVG(url, { ecLevel: "Q" }), // Q recovery leaves room for the centred Nomo logo overlay
    code: codeString ?? null,
    expiresAt: now() + MAX_WAIT_MS,
    // Bake the live-status poll params so the page flips itself to "Paired ✓" / "expired" on its own.
    // pcSecret already lives in config.json (same dir, same 0600); the page is deleted on completion.
    poll: { workerURL: workerUrl, pairingId, pcSecret },
  });
  await atomicWrite(htmlPath, page, CONFIG_MODE);
  const opened = (deps.openFile ?? openInBrowser)(htmlPath);
  if (opened) {
    print("Pairing page opened in your browser.");
  } else {
    print(`Open this file in a browser: ${htmlPath}`);
  }
  print("The QR code and one-time pairing code are shown on that page.");
  print("This expires in 10 minutes. Keep this session open — the next step waits for your phone.");

  // The one-time code is normally shown ONLY on the browser page (stdout lands in greppable agent
  // transcripts — the transcript-secrecy rule). Two deliberate exceptions print it to stdout anyway:
  //   • --show-code (showCode): the explicit SSH/headless escape hatch where the page can't be seen.
  //   • a real interactive terminal (isTTY): the user ran `pair` themselves — there is no agent
  //     transcript to leak into, so surfacing the code is a convenience, not a leak.
  // An agent's non-TTY Bash tool (or a pipe) gets neither → the neutral-only output is unchanged.
  const showCode = deps.showCode ?? false;
  const isTTY = deps.isTTY ?? (process.stdout.isTTY === true);
  if (codeString && (showCode || isTTY)) {
    print(`One-time code: ${codeString} · expires in 10 min`);
  }
  return 0;
}

/** Phase 2 — the WAIT. Reads the pending config and polls until the phone claims (up to 10 min),
 *  completing + acking on claim. Returns a process exit code (0 = paired). */
export async function pairWait(deps: PairDeps = {}): Promise<number> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const print = deps.print ?? ((line: string) => console.log(line));
  const configPath = deps.configPath ?? `${CC_DIR}/config.json`;
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const maxWaitMs = deps.maxWaitMs ?? MAX_WAIT_MS;
  const now = deps.now ?? Date.now;

  /** Re-read config.json and return the COMPLETED config if it now parses as one (else null). The
   *  self-heal race is decided here: whoever completed the pairing (this wait, or the watchdog) wrote
   *  the completed form to disk, so a completed config = the pairing succeeded, full stop. */
  const readCompleted = async () => {
    try {
      return parseConfig(await readFile(configPath, "utf8"));
    } catch {
      return null;
    }
  };
  const printPaired = (c: NonNullable<ReturnType<typeof parseConfig>>) =>
    print(c.machineName ? `Paired with ${c.machineName} ✓` : "Paired ✓");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    print("No pairing in progress — run /nomo-cc:pair first.");
    return 1;
  }
  // Already completed (the watchdog self-heal, or a prior wait, finished it) → nothing to do.
  if (parseConfig(raw)) {
    print("This machine is already paired ✓");
    return 0;
  }
  const pending = parsePendingConfig(raw);
  if (!pending) {
    print("No pairing in progress — run /nomo-cc:pair first.");
    return 1;
  }

  print("Waiting for your phone to scan the QR…");
  const completeOpts = {
    fetchFn, fetchTimeoutMs: FETCH_TIMEOUT_MS, ackAttempts: ACK_ATTEMPTS, ackRetryDelayMs: ACK_RETRY_DELAY_MS, sleep,
  };
  // `wait --timeout <seconds>` bounds the poll loop to softTimeoutMs (Codex flow); without it the loop
  // runs the full 10-min window. The QR's real TTL — the createdAt guard below — always uses maxWaitMs.
  const loopBound = deps.softTimeoutMs !== undefined ? Math.min(deps.softTimeoutMs, maxWaitMs) : maxWaitMs;
  for (let waited = 0; waited < loopBound; waited += pollIntervalMs) {
    // (1) Race check FIRST, before acting on any poll: the watchdog self-heal (or a prior wait) may
    // have completed the pairing under us. A completed config on disk = success — this is what stops
    // us losing the race to the watchdog and then spinning to a false 10-minute expiry.
    const already = await readCompleted();
    if (already) {
      printPaired(already);
      return 0;
    }
    // (2) TTL guard: past the QR's 10-minute lifetime (measured from when pairStart minted it), the
    // pending record is expired at the worker regardless of how long THIS wait has run. Clean up and
    // stop. Older pending configs without a createdAt fall through to the loop's own maxWait bound.
    if (pending.createdAt !== undefined && now() - pending.createdAt >= maxWaitMs) {
      await removePendingConfig(configPath);
      print("Pairing window expired (10 minutes) with no phone claiming it — run /nomo-cc:pair again when ready.");
      return 1;
    }

    const result = await completePendingPairing(pending, configPath, completeOpts);
    if (result.state === "completed") {
      print(`Paired with ${result.deviceName} ✓`);
      return 0;
    }
    if (result.state === "already-completed" || result.state === "gone") {
      // The worker has no claimable record for us: a concurrent completer already acked it
      // (already-completed), or it expired/was consumed (gone). If the config completed under us the
      // pairing DID succeed; otherwise it's genuinely gone — delete the stale pending config so
      // /status stops saying "waiting for phone scan", and stop rather than poll to the timeout.
      const done = await readCompleted();
      if (done) {
        printPaired(done);
        return 0;
      }
      await removePendingConfig(configPath);
      print("The pairing expired or was removed before a phone claimed it — run /nomo-cc:pair again.");
      return 1;
    }
    if (result.state === "tampered") {
      print("The phone's response could not be decrypted — the QR may have been tampered with. Run /nomo-cc:pair again.");
      return 1;
    }
    if (result.state === "rejected") {
      print(`The worker rejected the status poll (HTTP ${result.httpStatus}) — run /nomo-cc:pair again.`);
      return 1;
    }
    // pending / network → transient; keep polling until the window closes.
    await sleep(pollIntervalMs);
  }

  // Bounded `wait --timeout` that ran out with no claim is NOT an error in the Codex flow: the QR is
  // still live for its full 10 min and the detached watchdog self-heals the moment the phone scans.
  // Exit 0 with a reassuring line rather than the hard "expired" failure.
  if (deps.softTimeoutMs !== undefined) {
    print("Still waiting for the scan — pairing completes automatically in the background once you scan; check with the status command.");
    return 0;
  }
  print("Pairing window expired (10 minutes) with no phone claiming it — run /nomo-cc:pair again when ready.");
  return 1;
}

// import.meta.main is true under bun and node >= 24 when this file is the entry point; Task 2.3's
// bundling rewrites it for older nodes.
/** Parse `--timeout <seconds>` from argv into ms (the bounded `wait` flag). Undefined when absent or
 *  not a positive integer — the caller then runs the historical full-window wait. */
function parseTimeoutMs(argv: string[]): number | undefined {
  const i = argv.indexOf("--timeout");
  if (i === -1) return undefined;
  const seconds = Number.parseInt(argv[i + 1] ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    console.log("usage: pair [wait [--timeout <seconds>]] [--show-code] [--check]  — pair this machine with the Nomo app (opens a browser page with the QR + code; --show-code also prints the one-time code for SSH/headless)");
    process.exit(0);
  }
  if (process.argv.includes("wait")) {
    const softTimeoutMs = parseTimeoutMs(process.argv);
    process.exit(await pairWait(softTimeoutMs !== undefined ? { softTimeoutMs } : {}));
  } else {
    // `--open` is now the default (a harmless no-op if still passed by an older skill invocation).
    // `--show-code` forces the one-time code onto stdout (SSH/headless where the page can't be seen).
    process.exit(await pairStart(process.argv.includes("--show-code") ? { showCode: true } : {}));
  }
}
