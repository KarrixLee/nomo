import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/core/permission.ts
import { readFile as readFile4, realpath, unlink as unlink3 } from "node:fs/promises";
import { appendFileSync as appendFileSync2, statSync as statSync2, truncateSync as truncateSync2 } from "node:fs";
import { hostname as hostname2 } from "node:os";
import { basename as basename3, isAbsolute, relative, resolve } from "node:path";

// src/core/hook.ts
import { readdir as readdir2, readFile as readFile3, unlink as unlink2 } from "node:fs/promises";
import { hostname } from "node:os";
import { basename as basename2 } from "node:path";

// src/core/crypto.ts
var textEncoder = new TextEncoder;
var textDecoder = new TextDecoder;
var HKDF_INFO = textEncoder.encode("nomo-cc-e2e-v1");
var RATCHET_INFO_PREFIX = "nomo-cc-ratchet-v1|";
var LAN_INFO_PREFIX = "nomo-lan-v1|";
var ECDH_P256 = { name: "ECDH", namedCurve: "P-256" };
function bytesToBase64(bytes) {
  let binary = "";
  for (const b of bytes)
    binary += String.fromCharCode(b);
  return btoa(binary);
}
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0;i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function b64url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  const standard = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - standard.length % 4) % 4);
  return base64ToBytes(padded);
}
async function deriveE2EKey(qrSecret, phoneNonce) {
  const ikm = await crypto.subtle.importKey("raw", qrSecret, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: phoneNonce, info: HKDF_INFO }, ikm, 256);
  return new Uint8Array(bits);
}
async function deriveLanKey(e2eKey, pairingId) {
  const ikm = await crypto.subtle.importKey("raw", e2eKey, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: textEncoder.encode(LAN_INFO_PREFIX + pairingId)
  }, ikm, 256);
  return new Uint8Array(bits);
}
async function generateEphemeralKeyPair() {
  const kp = await crypto.subtle.generateKey(ECDH_P256, true, ["deriveBits"]);
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { privPkcs8, pubRaw };
}
async function deriveRatchetKey(ownPrivPkcs8, otherPubRaw, k0, pairingId) {
  const priv = await crypto.subtle.importKey("pkcs8", ownPrivPkcs8, ECDH_P256, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("raw", otherPubRaw, ECDH_P256, false, []);
  const z = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
  const zKey = await crypto.subtle.importKey("raw", z, "HKDF", false, ["deriveBits"]);
  const info = textEncoder.encode(RATCHET_INFO_PREFIX + pairingId);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: k0, info }, zKey, 256);
  return new Uint8Array(bits);
}
async function sealCombined(key, plaintext, iv) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const data = textEncoder.encode(JSON.stringify(plaintext));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, data);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return combined;
}
async function encryptBlob(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return bytesToBase64(await sealCombined(key, plaintext, iv));
}
async function decryptBlob(key, blob) {
  const combined = base64ToBytes(blob);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
  return JSON.parse(textDecoder.decode(plaintext));
}
async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// src/core/adapter.ts
import { execFile as execFile2 } from "node:child_process";
import { readdir, readFile as readFile2, stat as stat2 } from "node:fs/promises";
import { promisify as promisify2 } from "node:util";
import { basename, join as join2 } from "node:path";

// src/core/shared.ts
import { access, chmod, open, readFile, rename, stat, mkdir, unlink, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var PLUGIN_VERSION = "1.5.1";
var DBG_BLOB_TEXT_MAX_CHARS = 200;
function debugToken(value) {
  if (value === "-")
    return "-";
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "na";
}
function formatPlanPickerDebug(input) {
  const value = `${debugToken(input.version ?? PLUGIN_VERSION)} ev:${debugToken(input.event)} cls:${debugToken(input.classifier)} mk:${input.marker ?? "0"} dq:${input.daemon ?? "na"}(${input.daemonDisposition ?? "na"}) ttl:${debugToken(input.ttl ?? "-")} by:${input.by}`;
  return Array.from(value).slice(0, DBG_BLOB_TEXT_MAX_CHARS).join("");
}
var CC_DIR = `${process.env.HOME}/.config/cc-status`;
var SESSION_TRACE_PATH = `${CC_DIR}/session-trace.log`;
var SESSION_TRACE_MAX_BYTES = 256 * 1024;
var sessionTraceRotated = false;
function traceSession(event, path = SESSION_TRACE_PATH) {
  try {
    if (!sessionTraceRotated) {
      sessionTraceRotated = true;
      try {
        if (statSync(path).size > SESSION_TRACE_MAX_BYTES)
          truncateSync(path, 0);
      } catch {}
    }
    appendFileSync(path, `${JSON.stringify({ ts: Date.now(), pid: process.pid, ...event })}
`, { mode: 384 });
  } catch {}
}
function tracePlanPickerDecision(sessionId, decision, path) {
  traceSession({
    event: "plan-picker",
    sessionId,
    source: decision.source,
    classifier: decision.classifier,
    marker: decision.marker,
    daemonQuery: decision.daemonQuery ?? "not-queried",
    daemonIgnored: decision.daemonIgnored ?? false,
    ttlFired: decision.ttlFired ?? false,
    settle: decision.settle ?? "none",
    correctionPosted: decision.correctionPosted ?? false,
    doneBy: decision.doneBy ?? null
  }, path);
}
var SESSIONS_DIR = `${CC_DIR}/sessions`;
var WATCHDOG_PID_PATH = `${CC_DIR}/watchdog.pid`;
var LAST_SEND_PATH = `${CC_DIR}/last-send`;
var GONE_STRIKES_PATH = `${CC_DIR}/gone-strikes`;
var GONE_STRIKE_LIMIT = 2;
var NO_HOLD_PATH = `${CC_DIR}/no-hold`;
var BLOB_FIT_CHARS = 3008;
function sealedBlobChars(plaintextBytes) {
  return Math.ceil((12 + plaintextBytes + 16) / 3) * 4;
}
var PLAN_BLOB_TEXT_MAX_CHARS = 1800;
var PLAN_BLOB_TRUNCATION_MARKER = `
…`;
function appendFittedPlan(base, plan) {
  if (typeof plan !== "string" || plan.length === 0)
    return base;
  const chars = Array.from(plan);
  const marker = PLAN_BLOB_TRUNCATION_MARKER;
  const markerChars = Array.from(marker).length;
  const encoder = new TextEncoder;
  const fits = (value) => sealedBlobChars(encoder.encode(JSON.stringify({ ...base, plan: value })).length) <= BLOB_FIT_CHARS;
  if (chars.length <= PLAN_BLOB_TEXT_MAX_CHARS && fits(plan))
    return { ...base, plan };
  if (!fits(marker))
    return base;
  let lo = 0;
  let hi = Math.min(chars.length, PLAN_BLOB_TEXT_MAX_CHARS - markerChars);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(chars.slice(0, mid).join("") + marker))
      lo = mid;
    else
      hi = mid - 1;
  }
  return { ...base, plan: chars.slice(0, lo).join("") + marker };
}
function appendFittedPlanAndDebug(base, plan, dbg) {
  const withPlan = appendFittedPlan(base, plan);
  if (typeof dbg !== "string" || dbg.length === 0)
    return withPlan;
  const capped = Array.from(dbg).slice(0, DBG_BLOB_TEXT_MAX_CHARS).join("");
  const encoder = new TextEncoder;
  const withDebug = { ...withPlan, dbg: capped };
  return sealedBlobChars(encoder.encode(JSON.stringify(withDebug)).length) <= BLOB_FIT_CHARS ? withDebug : withPlan;
}
var RECORD_FULL_TEXT_MAX_CHARS = 262144;
var RECORD_FULL_TEXT_TRUNCATION_MARKER = `
…[truncated]`;
function fullTextForRecord(full, fitted) {
  if (typeof full !== "string" || full.length === 0)
    return;
  if (full === fitted)
    return;
  const chars = Array.from(full);
  if (chars.length <= RECORD_FULL_TEXT_MAX_CHARS)
    return full;
  const markerChars = Array.from(RECORD_FULL_TEXT_TRUNCATION_MARKER).length;
  return chars.slice(0, RECORD_FULL_TEXT_MAX_CHARS - markerChars).join("") + RECORD_FULL_TEXT_TRUNCATION_MARKER;
}
function recordFullTextIsComplete(value) {
  return !value.endsWith(RECORD_FULL_TEXT_TRUNCATION_MARKER);
}
async function flagExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function localApprovalsState(noHoldPath = NO_HOLD_PATH) {
  return await flagExists(noHoldPath) ? "off" : "on";
}
var PENDING_STASH_FILE = "pending-event.json";
var PENDING_STASH_PATH = `${CC_DIR}/${PENDING_STASH_FILE}`;
var PAIR_HTML_FILE = "pair.html";
var PAIR_HTML_PATH = `${CC_DIR}/${PAIR_HTML_FILE}`;
var HERE = dirname(fileURLToPath(import.meta.url));
var WATCHDOG_PATH = existsSync(`${HERE}/cc-watchdog.mjs`) ? `${HERE}/cc-watchdog.mjs` : `${HERE}/../entries/cc-watchdog.ts`;
function codexHome() {
  const env = process.env.CODEX_HOME;
  return env && env.length > 0 ? env : `${process.env.HOME}/.codex`;
}
var CODEX_HOOK_MARKER = "codex-status.mjs";
function codexAppServerSocketPath() {
  return `${codexHome()}/app-server-control/app-server-control.sock`;
}
async function codexAppServerSocketAvailable(socketPath = codexAppServerSocketPath()) {
  try {
    return (await stat(socketPath)).isSocket();
  } catch {
    return false;
  }
}
function lastHookPath(agent) {
  return `${CC_DIR}/last-hook-${agent}`;
}
function parseConfig(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null)
    return null;
  const c = parsed;
  if (typeof c.url !== "string" || typeof c.pairingId !== "string" || typeof c.pcSecret !== "string" || typeof c.e2eKeyB64 !== "string") {
    return null;
  }
  let e2eKey;
  try {
    e2eKey = fromB64url(c.e2eKeyB64);
  } catch {
    return null;
  }
  if (e2eKey.length !== 32)
    return null;
  return {
    url: c.url.replace(/\/$/, ""),
    pairingId: c.pairingId,
    pcSecret: c.pcSecret,
    e2eKey,
    machineName: typeof c.machineName === "string" && c.machineName.length > 0 ? c.machineName : undefined
  };
}
async function loadConfig() {
  try {
    return parseConfig(await readFile(`${CC_DIR}/config.json`, "utf8"));
  } catch {
    return null;
  }
}
function parsePendingConfig(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null)
    return null;
  const c = parsed;
  if (typeof c.e2eKeyB64 === "string")
    return null;
  if (typeof c.url !== "string" || typeof c.pairingId !== "string" || typeof c.pcSecret !== "string" || typeof c.qrSecretB64 !== "string") {
    return null;
  }
  let qrSecret;
  try {
    qrSecret = fromB64url(c.qrSecretB64);
  } catch {
    return null;
  }
  if (qrSecret.length !== 16)
    return null;
  let codeIkm;
  if (typeof c.codeIkmB64 === "string") {
    try {
      const decoded = fromB64url(c.codeIkmB64);
      if (decoded.length === 32)
        codeIkm = decoded;
    } catch {}
  }
  let pcEphPriv;
  if (typeof c.pcEphPrivB64 === "string") {
    try {
      pcEphPriv = fromB64url(c.pcEphPrivB64);
    } catch {}
  }
  return {
    url: c.url.replace(/\/$/, ""),
    pairingId: c.pairingId,
    pcSecret: c.pcSecret,
    qrSecret,
    ...codeIkm ? { codeIkm } : {},
    ...pcEphPriv ? { pcEphPriv } : {},
    machineName: typeof c.machineName === "string" && c.machineName.length > 0 ? c.machineName : undefined,
    createdAt: typeof c.createdAt === "number" && Number.isFinite(c.createdAt) ? c.createdAt : undefined
  };
}
async function loadPendingConfig(configPath = `${CC_DIR}/config.json`) {
  try {
    return parsePendingConfig(await readFile(configPath, "utf8"));
  } catch {
    return null;
  }
}
var CONFIG_MODE = 384;
async function decryptDeviceName(key, blob) {
  const bin = atob(blob);
  const combined = new Uint8Array(bin.length);
  for (let i = 0;i < bin.length; i++)
    combined[i] = bin.charCodeAt(i);
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: combined.slice(0, 12) }, cryptoKey, combined.slice(12));
  const utf8 = new TextDecoder().decode(plain);
  try {
    const parsed = JSON.parse(utf8);
    if (typeof parsed === "string" && parsed.length > 0)
      return parsed;
  } catch {}
  const raw = utf8.trim();
  return raw.length > 0 ? raw : "your phone";
}
var PENDING_STASH_STALE_MS = 600000;
async function flushPendingStash(stashPath, url, pairingId, pcSecret, e2eKey, now, fetchFn, fetchTimeoutMs, attempts, retryDelayMs, sleep, isAlive, ensureWD, sessionsDir) {
  let stash;
  try {
    stash = JSON.parse(await readFile(stashPath, "utf8"));
  } catch {
    return;
  }
  if (typeof stash.stashedAt !== "number" || now - stash.stashedAt >= PENDING_STASH_STALE_MS) {
    await unlink(stashPath).catch(() => {});
    return;
  }
  if (typeof stash.pid === "number" && !isAlive(stash.pid)) {
    await unlink(stashPath).catch(() => {});
    return;
  }
  try {
    const blob = await encryptBlob(e2eKey, stash.blob);
    const envelope = { v: 2, sessionId: stash.sessionId, op: stash.op, prio: stash.prio, ts: now, blob };
    for (let attempt = 0;attempt < attempts; attempt++) {
      try {
        const res = await fetchFn(`${url}/v1/cc/event`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-cc-pairing": pairingId, "x-cc-auth": pcSecret, "x-cc-version": PLUGIN_VERSION, "x-cc-approvals": await localApprovalsState() },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(fetchTimeoutMs)
        });
        if (res.ok)
          break;
      } catch {}
      if (attempt < attempts - 1)
        await sleep(retryDelayMs);
    }
    if (typeof stash.pid === "number") {
      try {
        const record = {
          pid: stash.pid,
          machine: stash.blob.machine,
          label: stash.blob.label,
          ts: Date.now(),
          lastEvent: stash.op === "start" ? "sessionStart" : stash.blob.status,
          sentDone: stash.op === "done",
          op: stash.op,
          prio: stash.prio,
          blob,
          ...stash.blob.agent === "codex" ? { agent: "codex" } : {},
          ...typeof stash.blob.title === "string" && stash.blob.title.length > 0 ? { title: stash.blob.title } : {},
          ...typeof stash.blob.model === "string" && stash.blob.model.length > 0 ? { model: stash.blob.model } : {},
          ...pairingId.length > 0 ? { pairingId } : {}
        };
        await atomicWrite(`${sessionsDir}/${stash.sessionId}.json`, JSON.stringify(record), 384);
        ensureWD();
      } catch {}
    }
  } finally {
    await unlink(stashPath).catch(() => {});
  }
}
async function completePendingPairing(pending, configPath, opts = {}) {
  const fetchFn = opts.fetchFn ?? fetch;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 1e4;
  const ackAttempts = opts.ackAttempts ?? 3;
  const ackRetryDelayMs = opts.ackRetryDelayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let res;
  try {
    res = await fetchFn(`${pending.url}/v1/cc/pair/status?p=${pending.pairingId}`, {
      headers: { "x-cc-auth": pending.pcSecret },
      signal: AbortSignal.timeout(fetchTimeoutMs)
    });
  } catch {
    return { state: "network" };
  }
  if (res.status === 404)
    return { state: "gone" };
  if (!res.ok)
    return { state: "rejected", httpStatus: res.status };
  const body = await res.json();
  if (body.state === "claimed" && typeof body.phoneNonce !== "string") {
    return { state: "already-completed" };
  }
  if (body.state !== "claimed" || typeof body.phoneNonce !== "string" || typeof body.deviceNameEnc !== "string") {
    return { state: "pending" };
  }
  const ikm = body.path === "code" ? pending.codeIkm : pending.qrSecret;
  if (!ikm)
    return { state: "tampered" };
  const k0 = await deriveE2EKey(ikm, fromB64url(body.phoneNonce));
  if (!pending.pcEphPriv || typeof body.phoneEphPub !== "string")
    return { state: "tampered" };
  let e2eKey;
  let deviceName;
  try {
    e2eKey = await deriveRatchetKey(pending.pcEphPriv, fromB64url(body.phoneEphPub), k0, pending.pairingId);
    deviceName = await decryptDeviceName(e2eKey, body.deviceNameEnc);
  } catch {
    return { state: "tampered" };
  }
  try {
    await chmod(configPath, CONFIG_MODE);
  } catch {}
  await atomicWrite(configPath, JSON.stringify({
    url: pending.url,
    pairingId: pending.pairingId,
    pcSecret: pending.pcSecret,
    e2eKeyB64: b64url(e2eKey),
    ...pending.machineName ? { machineName: pending.machineName } : {}
  }), CONFIG_MODE);
  for (let attempt = 0;attempt < ackAttempts; attempt++) {
    try {
      await fetchFn(`${pending.url}/v1/cc/pair/ack`, {
        method: "POST",
        headers: { "x-cc-pairing": pending.pairingId, "x-cc-auth": pending.pcSecret, "x-cc-version": PLUGIN_VERSION },
        signal: AbortSignal.timeout(fetchTimeoutMs)
      });
      break;
    } catch {
      if (attempt < ackAttempts - 1)
        await sleep(ackRetryDelayMs);
    }
  }
  await flushPendingStash(join(dirname(configPath), PENDING_STASH_FILE), pending.url, pending.pairingId, pending.pcSecret, e2eKey, Date.now(), fetchFn, fetchTimeoutMs, ackAttempts, ackRetryDelayMs, sleep, opts.isAlive ?? pidAlive, opts.ensureWatchdog ?? ensureWatchdog, opts.sessionsDir ?? SESSIONS_DIR);
  await unlink(join(dirname(configPath), PAIR_HTML_FILE)).catch(() => {});
  return { state: "completed", deviceName };
}
function isWatchdogCommand(psCommand) {
  return psCommand.includes("cc-watchdog");
}
function formatWatchdogPidfile(pid, version = PLUGIN_VERSION) {
  return `${pid} ${version}`;
}
function parseWatchdogPidfile(raw) {
  const [pidField, versionField] = raw.trim().split(/\s+/);
  const pid = Number.parseInt(pidField ?? "", 10);
  if (!Number.isFinite(pid) || pid <= 0)
    return null;
  return { pid, ...typeof versionField === "string" && versionField.length > 0 ? { version: versionField } : {} };
}
function watchdogHolderIsLive(pid, deps = {}) {
  const isAlive = deps.isAlive ?? pidAlive;
  const commandOf = deps.commandOf ?? pidCommand;
  if (!Number.isFinite(pid) || pid <= 0)
    return false;
  if (!isAlive(pid))
    return false;
  const cmd = commandOf(pid);
  if (cmd === undefined)
    return true;
  return isWatchdogCommand(cmd);
}
function ensureWatchdog(deps = {}) {
  try {
    if (process.env.NOMO_SKIP_WATCHDOG === "1")
      return;
    const pidPath = deps.pidPath ?? WATCHDOG_PID_PATH;
    const version = deps.version ?? PLUGIN_VERSION;
    const readPidfile = deps.readPidfile ?? (() => {
      try {
        return readFileSync(pidPath, "utf8");
      } catch {
        return;
      }
    });
    const killPid = deps.killPid ?? ((pid, signal) => process.kill(pid, signal));
    const spawnWatchdog = deps.spawnWatchdog ?? (() => {
      const runtime = process.env.NOMO_RUNTIME && process.env.NOMO_RUNTIME.length > 0 ? process.env.NOMO_RUNTIME : process.execPath;
      spawn(runtime, [WATCHDOG_PATH], { detached: true, stdio: "ignore" }).unref();
    });
    const raw = readPidfile();
    const holder = typeof raw === "string" ? parseWatchdogPidfile(raw) : null;
    if (holder && watchdogHolderIsLive(holder.pid, deps)) {
      if (holder.version === version)
        return;
      try {
        killPid(holder.pid, "SIGTERM");
      } catch {}
    }
    spawnWatchdog();
  } catch {}
}
async function readRecord(sessionId, sessionsDir = SESSIONS_DIR) {
  try {
    return JSON.parse(await readFile(`${sessionsDir}/${sessionId}.json`, "utf8"));
  } catch {
    return null;
  }
}
async function stampPermissionDetailFullAt(sessionsDir, sessionId, permissionDetailFull) {
  try {
    const record = await readRecord(sessionId, sessionsDir);
    if (!record)
      return;
    if (record.permissionDetailFull === permissionDetailFull)
      return;
    await atomicWrite(`${sessionsDir}/${sessionId}.json`, JSON.stringify({ ...record, permissionDetailFull }), 384);
  } catch {}
}
async function stampPermissionDetailFull(sessionId, permissionDetailFull) {
  return stampPermissionDetailFullAt(SESSIONS_DIR, sessionId, permissionDetailFull);
}
var DECISION_HOLD_SUFFIX = ".hold";
function decisionHoldFileName(sessionId) {
  return `${sessionId}${DECISION_HOLD_SUFFIX}`;
}
async function writeDecisionHoldAt(sessionsDir, sessionId, hold) {
  try {
    await atomicWrite(`${sessionsDir}/${decisionHoldFileName(sessionId)}`, JSON.stringify(hold), 384);
  } catch {}
}
async function clearDecisionHoldAt(sessionsDir, sessionId, pid) {
  const path = `${sessionsDir}/${decisionHoldFileName(sessionId)}`;
  try {
    const raw = await readFile(path, "utf8").catch(() => {
      return;
    });
    if (raw !== undefined) {
      let owner;
      try {
        owner = JSON.parse(raw).pid;
      } catch {
        owner = undefined;
      }
      if (typeof owner === "number" && owner !== pid)
        return;
    }
    await unlink(path).catch(() => {});
  } catch {}
}
async function writeDecisionHold(sessionId, hold) {
  return writeDecisionHoldAt(SESSIONS_DIR, sessionId, hold);
}
async function clearDecisionHold(sessionId, pid) {
  return clearDecisionHoldAt(SESSIONS_DIR, sessionId, pid);
}
async function readPrefix(path, maxBytes) {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}
async function readSuffix(path, maxBytes) {
  const { size } = await stat(path);
  const start = Math.max(0, size - maxBytes);
  const len = Math.min(maxBytes, size);
  if (len === 0)
    return "";
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}
async function atomicWrite(path, data, mode) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, mode !== undefined ? { mode } : undefined);
  await rename(tmp, path);
}
async function removeRevokedConfig(configPath = `${CC_DIR}/config.json`, lastSendPath = LAST_SEND_PATH, goneStrikesPath = GONE_STRIKES_PATH) {
  await unlink(configPath).catch(() => {});
  await unlink(lastSendPath).catch(() => {});
  await unlink(goneStrikesPath).catch(() => {});
}
async function readGoneStrikes(goneStrikesPath = GONE_STRIKES_PATH) {
  try {
    const n = parseInt(await readFile(goneStrikesPath, "utf8"), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
async function resetGoneStrikes(goneStrikesPath = GONE_STRIKES_PATH) {
  await unlink(goneStrikesPath).catch(() => {});
}
async function recordGoneStrike(goneStrikesPath = GONE_STRIKES_PATH) {
  const next = await readGoneStrikes(goneStrikesPath) + 1;
  await atomicWrite(goneStrikesPath, String(next));
  return next;
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function isRealTty(tty) {
  return tty.length > 0 && tty !== "??" && tty !== "?" && tty !== "-";
}
function pidAncestors(pid, maxDepth = 12) {
  const chain = [];
  let cur = pid;
  for (let i = 0;i < maxDepth; i++) {
    let ppid;
    try {
      const out = execFileSync("ps", ["-o", "ppid=", "-p", String(cur)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      ppid = Number.parseInt(out.trim(), 10);
    } catch {
      break;
    }
    if (!Number.isFinite(ppid) || ppid <= 1 || chain.includes(ppid))
      break;
    chain.push(ppid);
    cur = ppid;
  }
  return chain;
}
function pidCommand(pid) {
  try {
    const out = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return;
  }
}
function codexCompanionBrokerEvidence(pid, ancestorsOf = pidAncestors, commandOf = pidCommand) {
  const appServer = /(?:^|[\/\s"'])codex(?:\.exe)?(?:["']?)\s+app-server(?:$|\s)/;
  const brokerScript = /(?:^|[\/\s"'=])app-server-broker\.mjs(?:$|[\s"'])/;
  const brokerSocket = /unix:\/\/[^\s"'<>]*\/cxc-[^/\s"'<>]+\/broker\.sock(?:$|[\s"'])/;
  let ownerCommand;
  try {
    ownerCommand = commandOf(pid);
  } catch {
    return null;
  }
  if (typeof ownerCommand !== "string" || !appServer.test(ownerCommand))
    return null;
  let ancestors = [];
  try {
    ancestors = ancestorsOf(pid);
  } catch {}
  for (const candidate of [pid, ...ancestors]) {
    let command;
    try {
      command = candidate === pid ? ownerCommand : commandOf(candidate);
    } catch {
      continue;
    }
    if (typeof command !== "string" || command.length === 0)
      continue;
    if (brokerScript.test(command)) {
      return { pid: candidate, command, matchedBy: "app-server-broker.mjs" };
    }
    if (brokerSocket.test(command)) {
      return { pid: candidate, command, matchedBy: "cxc-broker-socket" };
    }
  }
  return null;
}

// src/core/terminal-focus.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileP = promisify(execFile);
var OSASCRIPT_TIMEOUT_MS = 4000;
var HERDR_TIMEOUT_MS = 4000;
var HERDR_TAB_ID = /^[A-Za-z0-9:]+$/;
function commandTokens(command) {
  return command.trim().split(/\s+/).filter(Boolean);
}
function isHerdrCommand(command) {
  if (typeof command !== "string")
    return false;
  const executable = commandTokens(command)[0]?.replace(/^['"]|['"]$/g, "");
  return typeof executable === "string" && /(?:^|\/)herdr$/.test(executable);
}
function isHerdrServer(command) {
  return typeof command === "string" && isHerdrCommand(command) && commandTokens(command).slice(1).includes("server");
}
function ancestryContainsHerdr(pid, ancestorsOf = pidAncestors, commandOf = pidCommand) {
  let ancestors;
  try {
    ancestors = ancestorsOf(pid);
  } catch {
    ancestors = [];
  }
  for (const candidate of [pid, ...ancestors]) {
    try {
      if (isHerdrCommand(commandOf(candidate)))
        return true;
    } catch {}
  }
  return false;
}
function recordTitleMatchesPane(recordTitle, paneTitle) {
  if (typeof recordTitle !== "string" || typeof paneTitle !== "string")
    return false;
  if (recordTitle === paneTitle)
    return true;
  const match = /^(.*?)(?:\u2026|\.{3})$/.exec(recordTitle);
  return !!match && match[1].length > 0 && paneTitle.startsWith(match[1]);
}
function correlateHerdrPane(context, panes) {
  let candidates = context.agent === "claude" ? panes.filter((pane) => pane.agent === "claude" && recordTitleMatchesPane(context.record.title, pane.terminal_title_stripped)) : panes.filter((pane) => pane.agent === "codex" && typeof context.record.origin?.cwd === "string" && context.record.origin.cwd.length > 0 && pane.cwd === context.record.origin.cwd);
  if (candidates.length > 1) {
    const working = candidates.filter((pane) => pane.agent_status === "working");
    if (working.length > 0)
      candidates = working;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}
function parseHerdrPanes(stdout) {
  const parsed = JSON.parse(stdout);
  const panes = parsed?.result?.panes;
  if (!Array.isArray(panes))
    throw new Error("invalid herdr pane list");
  return panes.filter((value) => {
    if (!value || typeof value !== "object")
      return false;
    const pane = value;
    return typeof pane.agent === "string" && typeof pane.tab_id === "string";
  });
}
function parsePsProcesses(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match)
      continue;
    const pid = Number.parseInt(match[1], 10);
    if (Number.isFinite(pid))
      out.push({ pid, tty: match[2], command: match[3] });
  }
  return out;
}
async function runExecFile(file, args, options, deps) {
  if (deps.execFile)
    return deps.execFile(file, args, options);
  const { stdout, stderr } = await execFileP(file, args, options);
  return { stdout: String(stdout), stderr: String(stderr) };
}
var TERMINAL_APPS = [
  { id: "terminal-app", bundleId: "com.apple.Terminal", match: /\/Terminal\.app\// },
  { id: "iterm2", bundleId: "com.googlecode.iterm2", match: /\/iTerm\.app\/|\/iTerm2\.app\// },
  { id: "ghostty", bundleId: "com.mitchellh.ghostty", match: /\/Ghostty\.app\/|(?:^|\/)ghostty(?:\s|$)/ },
  { id: "wezterm", bundleId: "com.github.wez.wezterm", match: /\/WezTerm\.app\/|(?:^|\/)wezterm(?:-gui)?(?:\s|$)/ },
  { id: "alacritty", bundleId: "org.alacritty", match: /\/Alacritty\.app\/|(?:^|\/)alacritty(?:\s|$)/ },
  { id: "kitty", bundleId: "net.kovidgoyal.kitty", match: /\/kitty\.app\/|(?:^|\/)kitty(?:\s|$)/ },
  { id: "hyper", bundleId: "co.zeit.hyper", match: /\/Hyper\.app\// },
  { id: "warp", bundleId: "dev.warp.Warp-Stable", match: /\/Warp\.app\// },
  { id: "vscode", bundleId: "com.microsoft.VSCode", match: /\/Visual Studio Code\.app\/|\/Code\.app\/|Code Helper/ }
];
function owningTerminalApp(pid, ancestorsOf = pidAncestors, commandOf = pidCommand) {
  let chain = [];
  try {
    chain = ancestorsOf(pid);
  } catch {
    chain = [];
  }
  for (const candidate of [pid, ...chain]) {
    let command;
    try {
      command = commandOf(candidate);
    } catch {
      continue;
    }
    if (typeof command !== "string" || command.length === 0)
      continue;
    const app = TERMINAL_APPS.find((a) => a.match.test(command));
    if (app)
      return app;
  }
  return;
}
function ttyDevicePath(raw) {
  if (typeof raw !== "string")
    return;
  const trimmed = raw.trim();
  if (!isRealTty(trimmed))
    return;
  const bare = trimmed.startsWith("/dev/") ? trimmed.slice(5) : trimmed;
  const name = /^s[0-9]+$/.test(bare) ? `tty${bare}` : bare;
  const path = `/dev/${name}`;
  return isTtyDevicePath(path) ? path : undefined;
}
function isTtyDevicePath(path) {
  return /^\/dev\/tty[a-z0-9]+$/.test(path);
}
function terminalAppScript(devPath) {
  if (!isTtyDevicePath(devPath))
    throw new Error("unsafe tty path");
  return [
    `tell application "Terminal"`,
    `	repeat with w in windows`,
    `		repeat with t in tabs of w`,
    `			if tty of t is "${devPath}" then`,
    `				set selected of t to true`,
    `				set index of w to 1`,
    `				activate`,
    `				return "ok"`,
    `			end if`,
    `		end repeat`,
    `	end repeat`,
    `end tell`,
    `return "none"`
  ].join(`
`);
}
function iterm2Script(devPath) {
  if (!isTtyDevicePath(devPath))
    throw new Error("unsafe tty path");
  return [
    `tell application "iTerm"`,
    `	repeat with w in windows`,
    `		repeat with t in tabs of w`,
    `			repeat with s in sessions of t`,
    `				if tty of s is "${devPath}" then`,
    `					select s`,
    `					select t`,
    `					select w`,
    `					activate`,
    `					return "ok"`,
    `				end if`,
    `			end repeat`,
    `		end repeat`,
    `	end repeat`,
    `end tell`,
    `return "none"`
  ].join(`
`);
}
function activateScript(bundleId) {
  if (!/^[A-Za-z0-9.\-]+$/.test(bundleId))
    throw new Error("unsafe bundle id");
  return `tell application id "${bundleId}" to activate`;
}
async function runOsascript(script) {
  const { stdout } = await execFileP("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
  return String(stdout).trim();
}
async function ttyViaPs(pid) {
  try {
    const { stdout } = await execFileP("ps", ["-o", "tty=", "-p", String(pid)]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return;
  }
}
function note(deps, event) {
  try {
    deps.trace?.(event);
  } catch {}
}
async function focusHerdr(pid, deps, ancestorsOf, commandOf) {
  const context = deps.context;
  if (!context) {
    note(deps, { event: "terminal-focus", pid, result: "ambiguous", reason: "herdr-ambiguous" });
    return { ok: false, reason: "herdr-ambiguous" };
  }
  let pane;
  try {
    const listed = await runExecFile("herdr", ["pane", "list"], { timeout: HERDR_TIMEOUT_MS }, deps);
    if ((listed.exitCode ?? 0) !== 0)
      throw new Error("herdr pane list failed");
    pane = correlateHerdrPane(context, parseHerdrPanes(String(listed.stdout)));
  } catch {
    note(deps, { event: "terminal-focus", pid, result: "unsupported", reason: "herdr-cli-failed" });
    return { ok: false, reason: "herdr-cli-failed" };
  }
  if (!pane) {
    note(deps, { event: "terminal-focus", pid, result: "ambiguous", reason: "herdr-ambiguous" });
    return { ok: false, reason: "herdr-ambiguous" };
  }
  if (!HERDR_TAB_ID.test(pane.tab_id)) {
    note(deps, { event: "terminal-focus", pid, result: "unsupported", reason: "herdr-cli-failed" });
    return { ok: false, reason: "herdr-cli-failed" };
  }
  try {
    const focused = await runExecFile("herdr", ["tab", "focus", pane.tab_id], { timeout: HERDR_TIMEOUT_MS }, deps);
    if ((focused.exitCode ?? 0) !== 0)
      throw new Error("herdr tab focus failed");
  } catch {
    note(deps, { event: "terminal-focus", pid, result: "unsupported", reason: "herdr-cli-failed" });
    return { ok: false, reason: "herdr-cli-failed" };
  }
  let app;
  try {
    const scanned = await runExecFile("ps", ["-axo", "pid=,tty=,args="], { timeout: HERDR_TIMEOUT_MS }, deps);
    if ((scanned.exitCode ?? 0) === 0) {
      const apps = new Map;
      for (const process2 of parsePsProcesses(String(scanned.stdout))) {
        if (!isRealTty(process2.tty) || !isHerdrCommand(process2.command) || isHerdrServer(process2.command))
          continue;
        const owner = owningTerminalApp(process2.pid, ancestorsOf, commandOf);
        if (owner)
          apps.set(owner.bundleId, owner);
      }
      if (apps.size === 1)
        app = apps.values().next().value;
    }
  } catch {}
  if (!app) {
    note(deps, { event: "terminal-focus", pid, result: "focused", via: "herdr", reason: "focused-detached" });
    return { ok: true, via: "herdr", reason: "focused-detached" };
  }
  try {
    await (deps.osascript ?? runOsascript)(activateScript(app.bundleId));
    note(deps, { event: "terminal-focus", pid, result: "focused", via: "herdr", app: app.id, reason: "herdr-focused" });
    return { ok: true, via: "herdr", reason: "herdr-focused" };
  } catch {
    note(deps, { event: "terminal-focus", pid, result: "osascript-failed", app: app.id });
    return { ok: false, reason: "osascript-failed" };
  }
}
async function focusTerminalForPid(pid, deps = {}) {
  try {
    if ((deps.platform ?? process.platform) !== "darwin") {
      note(deps, { event: "terminal-focus", pid, result: "unsupported", why: "not-darwin" });
      return { ok: false, reason: "unsupported" };
    }
    const ancestorsOf = deps.ancestorsOf ?? pidAncestors;
    const commandOf = deps.commandOf ?? pidCommand;
    if (ancestryContainsHerdr(pid, ancestorsOf, commandOf)) {
      return await focusHerdr(pid, deps, ancestorsOf, commandOf);
    }
    let rawTty;
    try {
      rawTty = await (deps.ttyOf ?? ttyViaPs)(pid);
    } catch {
      rawTty = undefined;
    }
    const devPath = ttyDevicePath(rawTty);
    if (devPath === undefined) {
      note(deps, { event: "terminal-focus", pid, result: "no-tty", tty: rawTty ?? "" });
      return { ok: false, reason: "no-tty" };
    }
    const app = owningTerminalApp(pid, ancestorsOf, commandOf);
    if (!app) {
      note(deps, { event: "terminal-focus", pid, result: "unsupported", why: "no-owning-app" });
      return { ok: false, reason: "unsupported" };
    }
    const osascript = deps.osascript ?? runOsascript;
    try {
      if (app.id === "terminal-app" || app.id === "iterm2") {
        const script = app.id === "terminal-app" ? terminalAppScript(devPath) : iterm2Script(devPath);
        const out = await osascript(script);
        if (String(out).trim() === "ok") {
          const via = app.id === "terminal-app" ? "terminal-app" : "iterm2";
          note(deps, { event: "terminal-focus", pid, result: "focused", via, app: app.id });
          return { ok: true, via };
        }
      }
      await osascript(activateScript(app.bundleId));
      note(deps, { event: "terminal-focus", pid, result: "focused", via: "app-activate", app: app.id });
      return { ok: true, via: "app-activate" };
    } catch {
      note(deps, { event: "terminal-focus", pid, result: "osascript-failed", app: app.id });
      return { ok: false, reason: "osascript-failed" };
    }
  } catch {
    return { ok: false, reason: "osascript-failed" };
  }
}

// src/core/adapter.ts
var execFileP2 = promisify2(execFile2);
var claudeToolDetail = {
  Bash: "running",
  Edit: "editing",
  Write: "editing",
  MultiEdit: "editing",
  NotebookEdit: "editing",
  Read: "reading",
  Grep: "searching",
  Glob: "searching",
  WebFetch: "web",
  WebSearch: "web",
  Task: "delegating",
  TodoWrite: "planning"
};
var codexToolDetail = {
  shell: "running",
  local_shell: "running",
  apply_patch: "editing",
  view_image: "reading",
  web_search: "web",
  spawn_agent: "delegating",
  update_plan: "planning"
};
var USER_INPUT_DETAIL_MAX = 240;
function requestUserInputDetail(toolInput) {
  let parsed = toolInput;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return;
    }
  }
  if (typeof parsed !== "object" || parsed === null)
    return;
  const questions = parsed.questions;
  if (!Array.isArray(questions) || questions.length === 0)
    return;
  const first = questions[0];
  if (typeof first !== "object" || first === null)
    return;
  const q = first;
  const question = typeof q.question === "string" ? q.question.replace(/\s+/g, " ").trim() : "";
  if (!question)
    return;
  const header = typeof q.header === "string" ? q.header.replace(/\s+/g, " ").trim() : "";
  const text = header && !question.toLowerCase().startsWith(`${header.toLowerCase()}:`) ? `${header}: ${question}` : question;
  const characters = Array.from(text);
  return characters.length <= USER_INPUT_DETAIL_MAX ? text : `${characters.slice(0, USER_INPUT_DETAIL_MAX - 1).join("")}…`;
}
function aiTitleFromLines(lines) {
  for (let i = lines.length - 1;i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"ai-title"'))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const r = row;
    if (r.type !== "ai-title" || typeof r.aiTitle !== "string")
      continue;
    const cleaned = r.aiTitle.replace(/\s+/g, " ").trim();
    if (cleaned)
      return cleaned.slice(0, 80);
  }
  return;
}
function aiTitle(transcript) {
  return aiTitleFromLines(transcript.split(`
`));
}
function sessionTitle(transcript) {
  const lines = transcript.split(`
`);
  return aiTitleFromLines(lines) ?? firstUserPromptFromLines(lines);
}
var TITLE_TAIL_BYTES = 128 * 1024;
async function claudeSessionTitle(prefix, transcriptPath) {
  if (transcriptPath.length > 0) {
    try {
      const t = aiTitle(await readSuffix(transcriptPath, TITLE_TAIL_BYTES));
      if (t)
        return t;
    } catch {}
  }
  return prefix.length > 0 ? sessionTitle(prefix) : undefined;
}
function codexThreadName(indexContent, sessionId) {
  let found;
  for (const line of indexContent.split(`
`)) {
    if (!line.includes(sessionId))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const r = row;
    if (r.id !== sessionId || typeof r.thread_name !== "string")
      continue;
    const cleaned = r.thread_name.replace(/\s+/g, " ").trim();
    if (cleaned)
      found = truncateOnWord(cleaned);
  }
  return found;
}
var INDEX_SCAN_BYTES = 128 * 1024;
async function codexIndexTitle(sessionId, home = codexHome()) {
  try {
    const content = await readSuffix(join2(home, "session_index.jsonl"), INDEX_SCAN_BYTES);
    return codexThreadName(content, sessionId);
  } catch {
    return;
  }
}
function codexSessionTitle(transcript) {
  const lines = transcript.split(`
`);
  for (const line of lines) {
    if (!line.trim())
      continue;
    if (!line.includes('"user_message"'))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const r = row;
    if (r.type !== "event_msg")
      continue;
    const payload = r.payload;
    if (!payload || payload.type !== "user_message")
      continue;
    const message = payload.message;
    if (typeof message !== "string")
      continue;
    const cleaned = message.replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.startsWith("<") || /^\[[$@]/.test(cleaned))
      continue;
    return cleanPromptTitle(cleaned);
  }
  return;
}
var TITLE_MAX = 80;
function truncateOnWord(s, max = TITLE_MAX) {
  if (s.length <= max)
    return s;
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[\s,;:.!?-]+$/, "")}…`;
}
function cleanPromptTitle(text) {
  const stripped = text.replace(/`+/g, "").replace(/\*{1,3}([^*]+?)\*{1,3}/g, "$1").replace(/_{1,3}([^_]+?)_{1,3}/g, "$1").replace(/~~([^~]+?)~~/g, "$1").replace(/^\s*#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim();
  return truncateOnWord(stripped);
}
function firstUserPromptFromLines(lines) {
  for (const line of lines) {
    if (!line.trim())
      continue;
    if (!line.includes('"user"'))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const r = row;
    if (r.type !== "user")
      continue;
    if (r.isMeta === true)
      continue;
    const msg = r.message;
    const content = msg?.content;
    let text;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const part = content.find((p) => typeof p === "object" && p !== null && p.type === "text");
      const t = part?.text;
      if (typeof t === "string")
        text = t;
    }
    if (typeof text !== "string")
      continue;
    const title = displayTitleFromUserText(text);
    if (title === undefined)
      continue;
    return title;
  }
  return;
}
function displayTitleFromUserText(text) {
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.startsWith("<"))
    return;
  if (cleaned.startsWith("Caveat:"))
    return;
  if (cleaned.includes("<command-name>") || cleaned.includes("<local-command-stdout>"))
    return;
  const title = cleanPromptTitle(cleaned);
  return title.length > 0 ? title : undefined;
}
function firstUserPrompt(transcript) {
  return firstUserPromptFromLines(transcript.split(`
`));
}
var MODEL_TAIL_BYTES = 64 * 1024;
function assistantModelFromLine(line) {
  if (!line.includes('"assistant"') || !line.includes('"model"'))
    return;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof row !== "object" || row === null)
    return;
  const r = row;
  if (r.type !== "assistant")
    return;
  if (r.isSidechain === true)
    return;
  const model = r.message?.model;
  if (typeof model !== "string")
    return;
  const cleaned = model.trim();
  if (!cleaned || cleaned.startsWith("<"))
    return;
  return cleaned;
}
function lastAssistantModel(text) {
  const lines = text.split(`
`);
  for (let i = lines.length - 1;i >= 0; i--) {
    const m = assistantModelFromLine(lines[i]);
    if (m)
      return m;
  }
  return;
}
function firstAssistantModel(text) {
  for (const line of text.split(`
`)) {
    const m = assistantModelFromLine(line);
    if (m)
      return m;
  }
  return;
}
async function claudeSessionModel(prefix, transcriptPath) {
  if (transcriptPath.length > 0) {
    try {
      const m = lastAssistantModel(await readSuffix(transcriptPath, MODEL_TAIL_BYTES));
      if (m)
        return m;
    } catch {}
  }
  return prefix.length > 0 ? firstAssistantModel(prefix) : undefined;
}
function codexModelFromRollout(text) {
  const lines = text.split(`
`);
  for (let i = lines.length - 1;i >= 0; i--) {
    const line = lines[i];
    if (!line.includes("turn_context"))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const r = row;
    if (r.type !== "turn_context")
      continue;
    const model = r.payload?.model;
    if (typeof model !== "string")
      continue;
    const cleaned = model.trim();
    if (cleaned)
      return cleaned;
  }
  return;
}
function codexConfigModel(toml) {
  for (const line of toml.split(`
`)) {
    if (/^\s*\[/.test(line))
      break;
    const m = line.match(/^\s*model\s*=\s*(.*)$/);
    if (!m)
      continue;
    const rest = m[1].trim();
    const dq = rest.match(/^"((?:[^"\\]|\\.)*)"/);
    if (dq) {
      try {
        const v = JSON.parse(`"${dq[1]}"`);
        if (v.length > 0)
          return v;
      } catch {}
      return;
    }
    const sq = rest.match(/^'([^']*)'/);
    if (sq && sq[1].length > 0)
      return sq[1];
    return;
  }
  return;
}
async function codexSessionModel(input, prefix, transcriptPath, home = codexHome()) {
  if (typeof input.model === "string" && input.model.trim().length > 0)
    return input.model.trim();
  if (transcriptPath.length > 0) {
    try {
      const m = codexModelFromRollout(await readSuffix(transcriptPath, MODEL_TAIL_BYTES));
      if (m)
        return m;
    } catch {}
  }
  if (prefix.length > 0) {
    const m = codexModelFromRollout(prefix);
    if (m)
      return m;
  }
  try {
    return codexConfigModel(await readFile2(join2(home, "config.toml"), "utf8"));
  } catch {
    return;
  }
}
var INTERRUPT_MARKER = "interrupted by user";
var CODEX_TURN_EVENTS = new Set(["task_started", "task_complete", "turn_aborted"]);
var CODEX_ABORT_EVENT = "turn_aborted";
function lastTurnLine(text) {
  const lines = text.split(`
`);
  for (let i = lines.length - 1;i >= 0; i--) {
    const line = lines[i];
    if (!line.trim())
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const t = row.type;
    if (t === "user" || t === "assistant")
      return line;
  }
  return null;
}
function hasInterruptMarker(line) {
  return line.includes(INTERRUPT_MARKER);
}
function codexLastTurnEvent(text) {
  const lines = text.split(`
`);
  for (let i = lines.length - 1;i >= 0; i--) {
    const line = lines[i];
    if (!line.trim())
      continue;
    if (!line.includes("event_msg"))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const r = row;
    if (r.type !== "event_msg")
      continue;
    const payload = r.payload;
    const t = payload?.type;
    if (typeof t === "string" && CODEX_TURN_EVENTS.has(t))
      return t;
  }
  return null;
}
var CODEX_APPROVAL_REQUEST_EVENTS = new Set(["exec_approval_request", "apply_patch_approval_request"]);
var CODEX_USER_INPUT_TOOL = "request_user_input";
var CODEX_APPROVAL_RESOLUTION_EVENTS = new Set(["exec_command_end", "patch_apply_end", "task_complete", "turn_aborted", "task_started", "user_message"]);
var CODEX_APPROVAL_RESOLUTION_ITEMS = new Set(["function_call_output", "custom_tool_call_output"]);
function codexTailPendingApproval(tail) {
  const lines = tail.split(`
`);
  for (let i = lines.length - 1;i >= 0; i--) {
    const line = lines[i];
    if (!line.trim())
      continue;
    if (!line.includes("event_msg") && !line.includes("response_item"))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const r = row;
    const payload = r.payload;
    const ptype = typeof payload?.type === "string" ? payload.type : undefined;
    if (!ptype)
      continue;
    if (r.type === "event_msg") {
      if (CODEX_APPROVAL_REQUEST_EVENTS.has(ptype))
        return true;
      if (CODEX_APPROVAL_RESOLUTION_EVENTS.has(ptype))
        return false;
    } else if (r.type === "response_item") {
      if (ptype === "function_call" && payload?.name === CODEX_USER_INPUT_TOOL) {
        return true;
      }
      if (CODEX_APPROVAL_RESOLUTION_ITEMS.has(ptype)) {
        return false;
      }
    }
  }
  return false;
}
function codexProposedPlanText(text) {
  return codexProposedPlanMarkdown(text) !== undefined;
}
function codexProposedPlanMarkdown(text) {
  if (typeof text !== "string")
    return;
  const trimmed = text.trim();
  const open2 = "<proposed_plan>";
  const close = "</proposed_plan>";
  if (!trimmed.startsWith(open2) || !trimmed.endsWith(close))
    return;
  return trimmed.slice(open2.length, -close.length).trim();
}
function codexFinalProposedPlan(row) {
  const payload = row.payload;
  if (!payload || payload.phase !== "final_answer")
    return;
  let text = "";
  if (row.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
    const content = payload.content;
    if (!Array.isArray(content))
      return;
    text = content.map((part) => {
      if (typeof part !== "object" || part === null)
        return "";
      const p = part;
      return p.type === "output_text" && typeof p.text === "string" ? p.text : "";
    }).join("");
  } else if (row.type === "event_msg" && payload.type === "agent_message") {
    text = typeof payload.message === "string" ? payload.message : "";
  } else {
    return;
  }
  return codexProposedPlanMarkdown(text);
}
function codexPlanPickerTailAnalysis(tail) {
  let state = "none";
  let plan;
  let finalPlanInTurn;
  for (const line of tail.split(`
`)) {
    if (!line.trim())
      continue;
    if (!line.includes("event_msg") && !line.includes("response_item"))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const r = row;
    const finalPlan = codexFinalProposedPlan(r);
    if (finalPlan !== undefined) {
      finalPlanInTurn = finalPlan;
      continue;
    }
    if (r.type !== "event_msg")
      continue;
    const ptype = r.payload?.type;
    if (ptype === "task_complete") {
      if (finalPlanInTurn !== undefined) {
        state = "pending";
        plan = finalPlanInTurn;
      }
      finalPlanInTurn = undefined;
    } else if (ptype === "task_started" || ptype === "user_message") {
      if (state === "pending") {
        state = "resolved";
        plan = undefined;
      }
      finalPlanInTurn = undefined;
    } else if (ptype === "turn_aborted") {
      finalPlanInTurn = undefined;
    }
  }
  return { state, ...state === "pending" && plan !== undefined ? { plan } : {}, incompleteFinalPlan: finalPlanInTurn !== undefined };
}
function codexPlanPickerStateFromTail(tail) {
  return codexPlanPickerTailAnalysis(tail).state;
}
function codexTailPendingUserInput(tail) {
  const lines = tail.split(`
`);
  for (let i = lines.length - 1;i >= 0; i--) {
    const line = lines[i];
    if (!line.trim())
      continue;
    if (!line.includes("event_msg") && !line.includes("response_item"))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const r = row;
    const payload = r.payload;
    const ptype = typeof payload?.type === "string" ? payload.type : undefined;
    if (!ptype)
      continue;
    if (r.type === "event_msg") {
      if (CODEX_APPROVAL_REQUEST_EVENTS.has(ptype))
        return;
      if (CODEX_APPROVAL_RESOLUTION_EVENTS.has(ptype))
        return;
    } else if (r.type === "response_item") {
      if (ptype === "function_call" && payload?.name === CODEX_USER_INPUT_TOOL) {
        const detail = requestUserInputDetail(payload.arguments);
        return { kind: "userInput", ...detail ? { detail } : {} };
      }
      if (CODEX_APPROVAL_RESOLUTION_ITEMS.has(ptype))
        return;
    }
  }
  return;
}
function codexTailPendingUserInputDetail(tail) {
  return codexTailPendingUserInput(tail)?.detail;
}
function codexTailPendingAttentionKind(tail) {
  return codexTailPendingUserInput(tail)?.kind;
}
var CLAUDE_USER_BLOCKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
function blockingToolUseId(assistantRow) {
  const content = assistantRow.message?.content;
  if (!Array.isArray(content))
    return;
  for (const part of content) {
    if (typeof part !== "object" || part === null)
      continue;
    const p = part;
    if (p.type !== "tool_use" || typeof p.name !== "string" || !CLAUDE_USER_BLOCKING_TOOLS.has(p.name))
      continue;
    if (typeof p.id === "string" && p.id.length > 0)
      return p.id;
  }
  return;
}
function hasToolResultFor(row, id) {
  const content = row.message?.content;
  if (!Array.isArray(content))
    return false;
  for (const part of content) {
    if (typeof part !== "object" || part === null)
      continue;
    const p = part;
    if (p.type === "tool_result" && p.tool_use_id === id)
      return true;
  }
  return false;
}
function claudeTailPendingApproval(tail) {
  const rows = [];
  for (const line of tail.split(`
`)) {
    if (!line.trim())
      continue;
    if (!line.includes("tool_use") && !line.includes("tool_result"))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const r = row;
    if (r.isSidechain === true)
      continue;
    rows.push(r);
  }
  for (let i = rows.length - 1;i >= 0; i--) {
    if (rows[i].type !== "assistant")
      continue;
    const id = blockingToolUseId(rows[i]);
    if (!id)
      return false;
    for (let j = i + 1;j < rows.length; j++)
      if (hasToolResultFor(rows[j], id))
        return false;
    return true;
  }
  return false;
}
var CLAUDE_HEADLESS_ARG_TOKENS = new Set(["-p", "--print", "--output-format"]);
var CLAUDE_DAEMON_MARKERS = [
  "claude-mem",
  "worker-service",
  "daemon run --origin transient",
  "bg-pty-host",
  "bg-spare"
];
function claudeForkResumePredecessor(command) {
  if (typeof command !== "string" || command.length === 0)
    return;
  const tokens = command.trim().split(/\s+/);
  if (!tokens.includes("--fork-session") || !tokens.includes("--reply-on-resume"))
    return;
  const match = /(?:^|\s)--resume(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const resume = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!resume || !resume.endsWith(".jsonl"))
    return;
  const id = basename(resume, ".jsonl");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : undefined;
}
function claudeHeadlessInvocation(selfArgs, ancestorArgs) {
  const chain = [selfArgs, ...ancestorArgs].filter((s) => typeof s === "string" && s.length > 0);
  if (chain.some((args) => CLAUDE_DAEMON_MARKERS.some((m) => args.includes(m))))
    return true;
  if (typeof selfArgs !== "string" || selfArgs.length === 0)
    return false;
  const tokens = selfArgs.trim().split(/\s+/);
  if (tokens.some((tok) => CLAUDE_HEADLESS_ARG_TOKENS.has(tok)))
    return true;
  return tokens.includes("--fork-session") && tokens.includes("--reply-on-resume");
}
var CODEX_ROLLOUT_IDLE_SILENCE_MS = 30000;
var CODEX_TURN_OPEN_EVENT = "task_started";
function codexTurnActiveFromTail(tail, silentForMs) {
  const last = codexLastTurnEvent(tail);
  if (last === CODEX_TURN_OPEN_EVENT)
    return true;
  if (last !== null)
    return false;
  if (silentForMs >= CODEX_ROLLOUT_IDLE_SILENCE_MS)
    return false;
  return tail.includes('"response_item"') || tail.includes('"event_msg"');
}
var TURN_STATE_TAIL_BYTES = 8 * 1024;
var PLAN_PICKER_TAIL_BYTES = 64 * 1024;
function rolloutPathFromLsof(output) {
  for (const line of output.split(`
`)) {
    if (!line.startsWith("n"))
      continue;
    const path = line.slice(1);
    const name = basename(path);
    if (name.startsWith("rollout-") && name.endsWith(".jsonl"))
      return path;
  }
  return;
}
async function rolloutViaLsof(pid) {
  try {
    const { stdout } = await execFileP2("lsof", ["-a", "-p", String(pid), "-Fn"]);
    return rolloutPathFromLsof(stdout);
  } catch {
    return;
  }
}
function rolloutMetaCwd(head) {
  for (const line of head.split(`
`)) {
    if (!line.includes("session_meta"))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const r = row;
    if (r.type !== "session_meta")
      continue;
    const cwd = r.payload?.cwd;
    if (typeof cwd === "string" && cwd.length > 0)
      return cwd;
  }
  return;
}
var ROLLOUT_SCAN_MAX_DAYS = 10;
var ROLLOUT_SCAN_MAX_HEADS = 40;
var ROLLOUT_META_HEAD_BYTES = 64 * 1024;
async function listNumericDirsDesc(path) {
  try {
    return (await readdir(path)).filter((n) => /^\d+$/.test(n)).sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}
async function codexNewestRolloutForCwd(cwd, home = codexHome()) {
  const sessions = join2(home, "sessions");
  const candidates = [];
  let days = 0;
  outer:
    for (const y of await listNumericDirsDesc(sessions)) {
      for (const m of await listNumericDirsDesc(join2(sessions, y))) {
        for (const d of await listNumericDirsDesc(join2(sessions, y, m))) {
          const dir = join2(sessions, y, m, d);
          let names;
          try {
            names = await readdir(dir);
          } catch {
            continue;
          }
          for (const n of names) {
            if (!n.startsWith("rollout-") || !n.endsWith(".jsonl"))
              continue;
            const path = join2(dir, n);
            try {
              candidates.push({ path, mtime: (await stat2(path)).mtimeMs });
            } catch {}
          }
          if (++days >= ROLLOUT_SCAN_MAX_DAYS)
            break outer;
        }
      }
    }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates.slice(0, ROLLOUT_SCAN_MAX_HEADS)) {
    try {
      if (rolloutMetaCwd(await readPrefix(c.path, ROLLOUT_META_HEAD_BYTES)) === cwd)
        return c.path;
    } catch {}
  }
  return;
}
async function codexRolloutForPid(pid, deps) {
  let rollout = await (deps.rolloutOf ?? rolloutViaLsof)(pid);
  if (!rollout) {
    const cwd = await (deps.cwdOf ?? cwdViaLsof)(pid);
    if (cwd)
      rollout = await (deps.rolloutForCwd ?? codexNewestRolloutForCwd)(cwd);
  }
  return rollout;
}
async function codexPidTurnActive(pid, deps = {}) {
  try {
    const rollout = await codexRolloutForPid(pid, deps);
    if (!rollout)
      return false;
    const tail = await (deps.readTail ?? readSuffix)(rollout, TURN_STATE_TAIL_BYTES);
    const mtime = await (deps.mtimeOf ?? (async (p) => (await stat2(p)).mtimeMs))(rollout);
    return codexTurnActiveFromTail(tail, (deps.now ?? Date.now)() - mtime);
  } catch {
    return false;
  }
}
async function codexPidPlanPickerAnalysis(pid, deps) {
  try {
    if (!(deps.isAlive ?? pidAlive)(pid))
      return { state: "exited", incompleteFinalPlan: false };
    const rollout = await codexRolloutForPid(pid, deps);
    if (!rollout)
      return { state: "unknown", incompleteFinalPlan: false };
    const tail = await (deps.readTail ?? readSuffix)(rollout, PLAN_PICKER_TAIL_BYTES);
    const analysis = codexPlanPickerTailAnalysis(tail);
    return {
      state: analysis.incompleteFinalPlan ? "incomplete" : analysis.state,
      ...!analysis.incompleteFinalPlan && analysis.plan !== undefined ? { plan: analysis.plan } : {},
      incompleteFinalPlan: analysis.incompleteFinalPlan
    };
  } catch {
    return { state: "unknown", incompleteFinalPlan: false };
  }
}
async function codexPidPlanPickerState(pid, deps = {}) {
  return (await codexPidPlanPickerAnalysis(pid, deps)).state;
}
async function codexPidPlanPickerEvidence(pid, deps = {}) {
  const { state, plan } = await codexPidPlanPickerAnalysis(pid, deps);
  return { state, ...state === "pending" && plan !== undefined ? { plan } : {} };
}
function codexSentinelSessionId(pid) {
  return `codex-pid-${pid}`;
}
function parseCodexProcs(psOutput) {
  const rows = [];
  for (const line of psOutput.split(`
`)) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m)
      continue;
    const pid = Number.parseInt(m[1], 10);
    if (!Number.isFinite(pid))
      continue;
    rows.push({ pid, tty: m[2], args: m[3] });
  }
  return rows;
}
function codexTuiCandidates(rows, knownPids) {
  const out = [];
  for (const r of rows) {
    if (knownPids.has(r.pid))
      continue;
    const tokens = r.args.trim().split(/\s+/);
    if (basename(tokens[0] ?? "") !== "codex")
      continue;
    if (!isRealTty(r.tty))
      continue;
    if (tokens.slice(1).includes("exec"))
      continue;
    out.push({ pid: r.pid, tty: r.tty });
  }
  return out;
}
function filterCodexTuis(rows, knownPids) {
  return codexTuiCandidates(rows, knownPids).map(({ pid }) => ({ pid }));
}
function labelFromCwd(cwd) {
  if (!cwd)
    return "session";
  const b = basename(cwd);
  return b.length > 0 ? b : "session";
}
async function runPs() {
  const { stdout } = await execFileP2("ps", ["-axo", "pid=,tty=,args="]);
  return stdout;
}
async function cwdViaLsof(pid) {
  try {
    const { stdout } = await execFileP2("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    for (const line of stdout.split(`
`))
      if (line.startsWith("n"))
        return line.slice(1);
    return;
  } catch {
    return;
  }
}
async function processStartedAtViaPs(pid) {
  try {
    const { stdout } = await execFileP2("ps", ["-p", String(pid), "-o", "lstart="]);
    const value = Date.parse(stdout.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return;
  }
}
async function codexDiscoverLive(known, deps = {}) {
  const ps = deps.ps ?? runPs;
  const cwdOf = deps.cwdOf ?? cwdViaLsof;
  const startedAtOf = deps.startedAtOf ?? processStartedAtViaPs;
  const turnActive = deps.turnActive ?? codexPidTurnActive;
  let output;
  try {
    output = await ps();
  } catch {
    return [];
  }
  const knownPids = new Set(known.map((r) => r.pid).filter((p) => typeof p === "number" && Number.isFinite(p)));
  const tuis = filterCodexTuis(parseCodexProcs(output), knownPids);
  const out = [];
  for (const { pid } of tuis) {
    const cwd = await cwdOf(pid);
    const startedAt = await startedAtOf(pid);
    const label = labelFromCwd(cwd);
    let active = false;
    try {
      active = await turnActive(pid);
    } catch {}
    out.push({
      pid,
      sessionId: codexSentinelSessionId(pid),
      title: label,
      label,
      idle: !active,
      ...cwd ? { cwd } : {},
      ...typeof startedAt === "number" && Number.isFinite(startedAt) ? { startedAt } : {}
    });
  }
  return out;
}
async function ttyViaPs2(pid) {
  try {
    const { stdout } = await execFileP2("ps", ["-o", "tty=", "-p", String(pid)]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return;
  }
}
async function startTimeViaPs(pid) {
  try {
    const { stdout } = await execFileP2("ps", ["-o", "lstart=", "-p", String(pid)]);
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return;
  }
}
function noteLocate(deps, reason) {
  try {
    deps.note?.(reason);
  } catch {}
}
function sentinelPid(sessionId) {
  const m = /^codex-pid-(\d+)$/.exec(sessionId);
  if (!m)
    return;
  const pid = Number.parseInt(m[1], 10);
  return Number.isFinite(pid) ? pid : undefined;
}
async function codexLocateTuiPid(ctx, deps = {}) {
  try {
    let output;
    try {
      output = await (deps.ps ?? runPs)();
    } catch {
      noteLocate(deps, "error");
      return;
    }
    const candidates = codexTuiCandidates(parseCodexProcs(output), new Set);
    if (candidates.length === 0) {
      noteLocate(deps, "no-candidate");
      return;
    }
    const pids = new Set(candidates.map((c) => c.pid));
    if (typeof ctx.record.pid === "number" && Number.isFinite(ctx.record.pid) && pids.has(ctx.record.pid)) {
      noteLocate(deps, "record-pid");
      return ctx.record.pid;
    }
    const sentinel = sentinelPid(ctx.sessionId);
    if (sentinel !== undefined && pids.has(sentinel)) {
      noteLocate(deps, "sentinel-pid");
      return sentinel;
    }
    let subset = candidates;
    const cwd = ctx.record.origin?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) {
      const cwdOf = deps.cwdOf ?? cwdViaLsof;
      const matched = [];
      for (const c of candidates) {
        let candidateCwd;
        try {
          candidateCwd = await cwdOf(c.pid);
        } catch {
          candidateCwd = undefined;
        }
        if (candidateCwd === cwd)
          matched.push(c);
      }
      if (matched.length === 1) {
        noteLocate(deps, "cwd-unique");
        return matched[0].pid;
      }
      subset = matched;
    }
    const startedAt = ctx.record.sessionStartedAt;
    if (subset.length > 1 && typeof startedAt === "number" && Number.isFinite(startedAt)) {
      const startTimeOf = deps.startTimeOf ?? startTimeViaPs;
      let best;
      let tied = false;
      for (const c of subset) {
        let started;
        try {
          started = await startTimeOf(c.pid);
        } catch {
          started = undefined;
        }
        if (typeof started !== "number" || !Number.isFinite(started))
          continue;
        const delta = Math.abs(started - startedAt);
        if (best === undefined || delta < best.delta) {
          best = { pid: c.pid, delta };
          tied = false;
        } else if (delta === best.delta) {
          tied = true;
        }
      }
      if (best !== undefined && !tied) {
        noteLocate(deps, "start-time");
        return best.pid;
      }
      noteLocate(deps, "ambiguous");
      return;
    }
    if (subset.length > 1) {
      noteLocate(deps, "ambiguous");
      return;
    }
    if (candidates.length === 1) {
      noteLocate(deps, "only-candidate");
      return candidates[0].pid;
    }
    noteLocate(deps, "ambiguous");
    return;
  } catch {
    noteLocate(deps, "error");
    return;
  }
}
async function claudeLocateTuiPid(ctx, deps = {}) {
  try {
    const pid = ctx.record.pid;
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
      noteLocate(deps, "no-candidate");
      return;
    }
    if (ancestryContainsHerdr(pid, deps.ancestorsOf ?? pidAncestors, deps.commandOf ?? pidCommand)) {
      noteLocate(deps, "record-pid");
      return pid;
    }
    let tty;
    try {
      tty = await (deps.ttyOf ?? ttyViaPs2)(pid);
    } catch {
      tty = undefined;
    }
    if (typeof tty !== "string" || !isRealTty(tty.trim())) {
      noteLocate(deps, "no-candidate");
      return;
    }
    noteLocate(deps, "record-pid");
    return pid;
  } catch {
    noteLocate(deps, "error");
    return;
  }
}
function claudeClearPredecessor(sessionId, hookPid, tracked) {
  return tracked.filter((t) => t.sessionId !== sessionId && t.provisional !== true && t.agent !== "codex" && typeof t.pid === "number" && Number.isFinite(t.pid) && t.pid === hookPid).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0]?.sessionId;
}
function codexChildSessionGhost(sessionId, transcriptPrefix, hookPid, tracked) {
  if (transcriptPrefix.trim().length > 0)
    return false;
  return tracked.some((t) => t.sessionId !== sessionId && t.provisional !== true && t.agent === "codex" && typeof t.pid === "number" && Number.isFinite(t.pid) && t.pid === hookPid);
}
async function codexRolloutExistsForSession(sessionId, home = codexHome()) {
  if (sessionId.length === 0)
    return false;
  const sessions = join2(home, "sessions");
  let days = 0;
  for (const y of await listNumericDirsDesc(sessions)) {
    for (const m of await listNumericDirsDesc(join2(sessions, y))) {
      for (const d of await listNumericDirsDesc(join2(sessions, y, m))) {
        let names;
        try {
          names = await readdir(join2(sessions, y, m, d));
        } catch {
          names = [];
        }
        if (names.some((n) => n.startsWith("rollout-") && n.endsWith(".jsonl") && n.includes(sessionId)))
          return true;
        if (++days >= ROLLOUT_SCAN_MAX_DAYS)
          return false;
      }
    }
  }
  return false;
}
function codexSubagentSource(source) {
  return source === "subagent" || typeof source === "object" && source !== null && Object.prototype.hasOwnProperty.call(source, "subagent");
}
function codexRolloutCreationEvidence(prefix) {
  let subagent = false;
  let hasUserMessage = false;
  for (const line of prefix.split(`
`)) {
    if (!line.trim())
      continue;
    if (!line.includes("session_meta") && !line.includes("user_message"))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const r = row;
    const payload = r.payload;
    if (r.type === "session_meta" && codexSubagentSource(payload?.source ?? r.source))
      subagent = true;
    if (r.type === "event_msg" && payload?.type === "user_message")
      hasUserMessage = true;
  }
  return { subagent, hasUserMessage };
}
async function codexSessionCreationSuppression(sessionId, transcriptPrefix, transcriptPath, input = {}, deps = {}) {
  const evidence = codexRolloutCreationEvidence(transcriptPrefix);
  if (evidence.subagent) {
    return {
      guard: "codex-subagent-rollout",
      reason: "session_meta.source is a subagent variant"
    };
  }
  const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const hookPrompt = hookName === "UserPromptSubmit" && typeof input.prompt === "string" && input.prompt.trim().length > 0;
  if (!evidence.hasUserMessage && !hookPrompt) {
    return {
      guard: "codex-promptless-rollout",
      reason: "no rollout user_message or UserPromptSubmit prompt yet"
    };
  }
  if (transcriptPrefix.trim().length > 0)
    return null;
  if (transcriptPath.length > 0) {
    try {
      await (deps.statOf ?? stat2)(transcriptPath);
      return null;
    } catch {}
  }
  try {
    if (await (deps.rolloutExists ?? codexRolloutExistsForSession)(sessionId))
      return null;
  } catch {}
  return {
    guard: "codex-internal-no-rollout",
    reason: "hook prompt exists but no transcript file or rollout can be found"
  };
}
async function codexInternalSessionGhost(sessionId, transcriptPrefix, transcriptPath, deps = {}, input = {}) {
  return await codexSessionCreationSuppression(sessionId, transcriptPrefix, transcriptPath, input, deps) !== null;
}
function findProvisionalForPid(provisionals, hookPid, ancestorsOf) {
  for (const p of provisionals)
    if (p.pid === hookPid)
      return p.sessionId;
  const chain = new Set(ancestorsOf(hookPid));
  for (const p of provisionals)
    if (chain.has(p.pid))
      return p.sessionId;
  return null;
}
var claudeAdapter = {
  kind: "claude",
  async title({ prefix, input, transcriptPath }) {
    const fromTranscript = await claudeSessionTitle(prefix, transcriptPath ?? "");
    if (fromTranscript)
      return fromTranscript;
    if (typeof input.prompt === "string" && input.prompt.length > 0) {
      const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
      if (hookName === "UserPromptSubmit")
        return displayTitleFromUserText(input.prompt);
    }
    return;
  },
  model({ prefix, transcriptPath }) {
    return claudeSessionModel(prefix, transcriptPath);
  },
  detectInterrupt(tail) {
    const line = lastTurnLine(tail);
    return line !== null && hasInterruptMarker(line);
  },
  tailShowsPendingApproval(tail) {
    return claudeTailPendingApproval(tail);
  },
  isHeadlessInvocation({ pid, ancestorsOf, commandOf }) {
    return claudeHeadlessInvocation(commandOf(pid), ancestorsOf(pid).map((p) => commandOf(p)));
  },
  forkResumePredecessor(command) {
    return claudeForkResumePredecessor(command);
  },
  clearPredecessor({ sessionId, hookPid, tracked }) {
    return claudeClearPredecessor(sessionId, hookPid, tracked);
  },
  sessionsDir: () => `${process.env.HOME}/.claude/projects`,
  sessionMatch: (name) => name.endsWith(".jsonl"),
  hookStampPath: () => lastHookPath("claude"),
  hooksNotFiringHint: "  Reinstall the plugin / check /plugin.",
  toolDetail: claudeToolDetail,
  blobAgentFields: {},
  locateTuiPid: (ctx, deps) => claudeLocateTuiPid(ctx, deps)
};
var codexAdapter = {
  kind: "codex",
  async title({ sessionId, prefix, input }) {
    const indexTitle = await codexIndexTitle(sessionId);
    if (indexTitle)
      return indexTitle;
    let title;
    if (prefix.length > 0)
      title = codexSessionTitle(prefix);
    if (title === undefined && typeof input.prompt === "string" && input.prompt.length > 0) {
      const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
      if (hookName === "UserPromptSubmit")
        title = cleanPromptTitle(input.prompt);
    }
    return title;
  },
  model({ input, prefix, transcriptPath }) {
    return codexSessionModel(input, prefix, transcriptPath);
  },
  detectInterrupt(tail) {
    return codexLastTurnEvent(tail) === CODEX_ABORT_EVENT;
  },
  tailShowsPendingApproval(tail) {
    return codexTailPendingApproval(tail);
  },
  tailPendingAttentionDetail(tail) {
    return codexTailPendingUserInputDetail(tail);
  },
  tailPendingAttentionKind(tail) {
    return codexTailPendingAttentionKind(tail);
  },
  completedTurnWaitState({ pid, transcriptPath }) {
    return codexPidPlanPickerState(pid, transcriptPath ? { rolloutOf: async () => transcriptPath } : {});
  },
  completedTurnWaitEvidence({ pid, transcriptPath }) {
    return codexPidPlanPickerEvidence(pid, transcriptPath ? { rolloutOf: async () => transcriptPath } : {});
  },
  isChildSessionGhost({ sessionId, prefix, hookPid, tracked }) {
    return codexChildSessionGhost(sessionId, prefix, hookPid, tracked);
  },
  isInternalSessionGhost({ sessionId, prefix, transcriptPath }) {
    return codexInternalSessionGhost(sessionId, prefix, transcriptPath);
  },
  sessionCreationSuppression({ sessionId, prefix, transcriptPath, input }) {
    return codexSessionCreationSuppression(sessionId, prefix, transcriptPath, input);
  },
  sessionsDir: () => `${codexHome()}/sessions`,
  sessionMatch: (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
  hookStampPath: () => lastHookPath("codex"),
  hooksNotFiringHint: "  Run /hooks in Codex to re-trust, or reinstall the plugin — known upstream bugs #16430/#30835.",
  toolDetail: codexToolDetail,
  blobAgentFields: { agent: "codex" },
  discoverLive: (known) => codexDiscoverLive(known),
  pidTurnActive: (pid) => codexPidTurnActive(pid),
  locateTuiPid: (ctx, deps) => codexLocateTuiPid(ctx, deps)
};
function adapterFor(agent) {
  return agent === "codex" ? codexAdapter : claudeAdapter;
}
var allAdapters = [claudeAdapter, codexAdapter];

// src/core/hook.ts
var TOOL_DETAIL = { ...claudeToolDetail, ...codexToolDetail };
function sessionOrigin(input, ppid = process.ppid, command = pidCommand(ppid)) {
  const stringField = (key) => typeof input[key] === "string" && input[key].length > 0 ? input[key] : undefined;
  return {
    hook_event_name: stringField("hook_event_name") ?? "",
    ...stringField("source") ? { source: stringField("source") } : {},
    ...stringField("agent_id") ? { agent_id: stringField("agent_id") } : {},
    ...stringField("agent_type") ? { agent_type: stringField("agent_type") } : {},
    ...stringField("cwd") ? { cwd: stringField("cwd") } : {},
    ppid,
    ...typeof command === "string" && command.length > 0 ? { ppid_command: command } : {}
  };
}
function detailForHook(hookName, toolName, toolInput) {
  if (hookName === "PreToolUse" && toolName === "request_user_input") {
    return requestUserInputDetail(toolInput);
  }
  if (hookName === "PreToolUse")
    return toolName ? TOOL_DETAIL[toolName] : undefined;
  if (hookName === "PostToolUse")
    return "thinking";
  return;
}
function isPermissionNotification(i) {
  const type = typeof i.notification_type === "string" ? i.notification_type : "";
  const msg = (typeof i.message === "string" ? i.message : "").toLowerCase();
  return type === "permission_prompt" || msg.includes("permission") || msg.includes("approve") || msg.includes("allow");
}
var USER_BLOCKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "request_user_input"]);
function planOp(hookName, input, sentDone) {
  switch (hookName) {
    case "SessionStart":
      return sentDone ? { op: "update", prio: 0, status: "working" } : { op: "start", prio: 0, status: "working" };
    case "PreToolUse": {
      const tool = typeof input.tool_name === "string" ? input.tool_name : "";
      return USER_BLOCKING_TOOLS.has(tool) ? { op: "update", prio: 1, status: "needsAttention" } : { op: "update", prio: 0, status: "working" };
    }
    case "UserPromptSubmit":
    case "PostToolUse":
      return { op: "update", prio: 0, status: "working" };
    case "Notification":
      if (!isPermissionNotification(input))
        return null;
      return { op: "update", prio: 1, status: "needsAttention" };
    case "PermissionRequest":
      return { op: "update", prio: 1, status: "needsAttention" };
    case "Stop":
      return { op: "done", prio: 0, status: "done" };
    case "SessionEnd":
      return { op: "end", prio: 0, status: "done" };
    default:
      return null;
  }
}
var TITLE_SCAN_BYTES = 128 * 1024;
function transcriptStartMs(prefix) {
  for (const line of prefix.split(`
`)) {
    if (!line.includes('"timestamp"'))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const ts = row.timestamp;
    if (typeof ts !== "string")
      continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms))
      return ms;
  }
  return;
}
function buildBlob(input, machine, title, plan, agent = "claude", turnStartedAt, pinnedLabel, model, at, proposedPlan, dbgOverride) {
  const label = typeof pinnedLabel === "string" && pinnedLabel.length > 0 ? pinnedLabel : typeof input.cwd === "string" && input.cwd.length > 0 ? basename2(input.cwd) : "session";
  const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const detail = detailForHook(hookName, typeof input.tool_name === "string" ? input.tool_name : undefined, input.tool_input);
  const base = {
    status: plan.status,
    title: title ?? "",
    machine,
    label,
    ...detail ? { detail } : {},
    ...agent === "codex" ? { agent: "codex" } : {},
    ...typeof turnStartedAt === "number" && Number.isFinite(turnStartedAt) ? { turnStartedAt } : {},
    ...typeof model === "string" && model.length > 0 ? { model } : {},
    ...typeof at === "number" && Number.isFinite(at) ? { at } : {}
  };
  const dbg = agent === "codex" ? dbgOverride ?? formatPlanPickerDebug({
    event: hookName || "event",
    classifier: plan.status === "needsAttention" ? "attn" : plan.status === "working" ? "work" : "done",
    by: "h"
  }) : undefined;
  return appendFittedPlanAndDebug(base, proposedPlan, dbg);
}
async function buildEnvelope(input, machine, now, title, e2eKey, sentDone, agent = "claude", startedAt, turnStartedAt, pinnedLabel, model, planOverride, attentionKindOverride, proposedPlan, dbg, onBlobPlaintext) {
  if (typeof input !== "object" || input === null)
    return null;
  const i = input;
  if (typeof i.session_id !== "string" || i.session_id.length === 0)
    return null;
  const hookName = typeof i.hook_event_name === "string" ? i.hook_event_name : "";
  const plan = planOverride ?? planOp(hookName, i, sentDone);
  if (!plan)
    return null;
  const base = { v: 2, sessionId: i.session_id, op: plan.op, prio: plan.prio, ts: now };
  if (typeof startedAt === "number" && Number.isFinite(startedAt))
    base.startedAt = startedAt;
  const at = Math.floor(now / 1000);
  const plaintext = buildBlob(i, machine, title, plan, agent, turnStartedAt, pinnedLabel, model, at, proposedPlan, dbg);
  try {
    onBlobPlaintext?.(plaintext);
  } catch {}
  const blob = await encryptBlob(e2eKey, plaintext);
  const attentionKind = attentionKindOverride ?? (agent === "codex" && hookName === "PreToolUse" && i.tool_name === "request_user_input" ? "userInput" : undefined);
  return { ...base, ...attentionKind ? { attentionKind } : {}, blob };
}
function buildPendingStash(input, machine, title, now, pid = process.ppid, agent = "claude", model) {
  if (typeof input.session_id !== "string" || input.session_id.length === 0)
    return null;
  const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const plan = planOp(hookName, input, false);
  if (!plan || plan.op === "end")
    return null;
  const turnStartedAt = hookName === "UserPromptSubmit" ? Math.floor(now / 1000) : undefined;
  const at = Math.floor(now / 1000);
  return { sessionId: input.session_id, op: plan.op, prio: plan.prio, blob: buildBlob(input, machine, title, plan, agent, turnStartedAt, undefined, model, at), stashedAt: now, pid };
}
async function stashPendingEvent(input, machine, title, now, stashPath = PENDING_STASH_PATH, pid = process.ppid, agent = "claude", model) {
  try {
    const stash = buildPendingStash(input, machine, title, now, pid, agent, model);
    if (!stash)
      return;
    await atomicWrite(stashPath, JSON.stringify(stash), 384);
  } catch {}
}
async function trackSessionAt(sessionsDir, sessionId, op, prio, status, blob, machine, label, transcript, agent = "claude", sessionStartedAt, turnStartedAt, turnId, title, pairingId, model, pendingPlanPicker = false, pid = process.ppid, origin, planPickerVerificationPending = false, dbg, attentionKind, planFull) {
  try {
    const path = `${sessionsDir}/${sessionId}.json`;
    if (op === "end") {
      await unlink2(path).catch(() => {});
      await unlink2(`${sessionsDir}/${decisionHoldFileName(sessionId)}`).catch(() => {});
      return;
    }
    const recordedAt = Date.now();
    const record = {
      pid,
      machine,
      label,
      ts: recordedAt,
      transcript,
      lastEvent: op === "start" ? "sessionStart" : status,
      sentDone: op === "done",
      ...op === "done" ? { donePending: true } : {},
      op,
      prio,
      ...blob ? { blob } : {},
      ...agent === "codex" ? { agent } : {},
      ...typeof sessionStartedAt === "number" && Number.isFinite(sessionStartedAt) ? { sessionStartedAt } : {},
      ...typeof turnStartedAt === "number" && Number.isFinite(turnStartedAt) ? { turnStartedAt } : {},
      ...typeof turnId === "string" && turnId.length > 0 ? { turnId } : {},
      ...typeof title === "string" && title.length > 0 ? { title } : {},
      ...typeof model === "string" && model.length > 0 ? { model } : {},
      ...typeof pairingId === "string" && pairingId.length > 0 ? { pairingId } : {},
      ...pendingPlanPicker ? { pendingPlanPicker: true } : {},
      ...planPickerVerificationPending ? { planPickerVerificationPending: true } : {},
      ...pendingPlanPicker || planPickerVerificationPending ? { planPickerPendingSince: recordedAt } : {},
      ...typeof dbg === "string" && dbg.length > 0 ? { dbg } : {},
      ...origin ? { origin } : {},
      ...attentionKind ? { attentionKind } : {},
      ...typeof planFull === "string" && planFull.length > 0 ? { planFull } : {}
    };
    await atomicWrite(path, JSON.stringify(record), 384);
  } catch {}
}
async function trackSession(sessionId, op, prio, status, blob, machine, label, transcript, agent = "claude", sessionStartedAt, turnStartedAt, turnId, title, pairingId, model, pendingPlanPicker = false, pid = process.ppid, origin, planPickerVerificationPending = false, dbg, attentionKind, planFull) {
  return trackSessionAt(SESSIONS_DIR, sessionId, op, prio, status, blob, machine, label, transcript, agent, sessionStartedAt, turnStartedAt, turnId, title, pairingId, model, pendingPlanPicker, pid, origin, planPickerVerificationPending, dbg, attentionKind, planFull);
}
async function markDoneDeliveredAt(sessionsDir, sessionId) {
  try {
    const record = await readRecord(sessionId, sessionsDir);
    if (!record || record.donePending !== true)
      return;
    await atomicWrite(`${sessionsDir}/${sessionId}.json`, JSON.stringify({ ...record, donePending: undefined }), 384);
  } catch {}
}
async function markDoneDelivered(sessionId) {
  return markDoneDeliveredAt(SESSIONS_DIR, sessionId);
}
async function reconcileProvisional(config, hookPid) {
  try {
    const files = await readdir2(SESSIONS_DIR).catch(() => []);
    const provisionals = [];
    for (const f of files) {
      if (!f.endsWith(".json"))
        continue;
      let r;
      try {
        r = JSON.parse(await readFile3(`${SESSIONS_DIR}/${f}`, "utf8"));
      } catch {
        continue;
      }
      if (r.provisional === true && typeof r.pid === "number")
        provisionals.push({ sessionId: basename2(f, ".json"), pid: r.pid });
    }
    if (provisionals.length === 0)
      return;
    const sentinel = findProvisionalForPid(provisionals, hookPid, pidAncestors);
    if (!sentinel)
      return;
    let delivered = false;
    try {
      const res = await fetch(`${config.url}/v1/cc/event`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret, "x-cc-version": PLUGIN_VERSION, "x-cc-approvals": await localApprovalsState() },
        body: JSON.stringify({ v: 2, sessionId: sentinel, op: "end", prio: 0, ts: Date.now() }),
        signal: AbortSignal.timeout(2000)
      });
      delivered = res.ok;
    } catch {}
    if (delivered)
      await unlink2(`${SESSIONS_DIR}/${sentinel}.json`).catch(() => {});
  } catch {}
}
async function readTrackedSessions() {
  const files = await readdir2(SESSIONS_DIR).catch(() => []);
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json"))
      continue;
    try {
      const r = JSON.parse(await readFile3(`${SESSIONS_DIR}/${f}`, "utf8"));
      out.push({ sessionId: basename2(f, ".json"), pid: r.pid, provisional: r.provisional, agent: r.agent, ts: r.ts });
    } catch {}
  }
  return out;
}
async function retireLineageSession(config, sessionId, agent, input, reason) {
  let delivered = false;
  try {
    const res = await fetch(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret,
        "x-cc-version": PLUGIN_VERSION,
        "x-cc-approvals": await localApprovalsState()
      },
      body: JSON.stringify({ v: 2, sessionId, op: "end", prio: 0, ts: Date.now() }),
      signal: AbortSignal.timeout(2000)
    });
    delivered = res.ok;
  } catch {}
  await unlink2(`${SESSIONS_DIR}/${sessionId}.json`).catch(() => {});
  traceSession({
    event: "retire",
    sessionId,
    agent,
    hook_event_name: input.hook_event_name,
    source: input.source,
    reason,
    delivered
  });
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin)
    chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function runHook(agent) {
  try {
    const [config, raw] = await Promise.all([loadConfig(), readStdin()]);
    const input = JSON.parse(raw);
    if (typeof input.session_id !== "string" || input.session_id.length === 0)
      return;
    if (agent === "claude" && (typeof input.turn_id === "string" && input.turn_id.length > 0 || typeof input.transcript_path === "string" && input.transcript_path.includes("/.codex/"))) {
      agent = "codex";
    }
    const adapter2 = adapterFor(agent);
    await atomicWrite(lastHookPath(agent), String(Date.now())).catch(() => {});
    const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
    let prefixCache;
    const getPrefix = async () => {
      if (prefixCache !== undefined)
        return prefixCache;
      prefixCache = "";
      if (transcriptPath.length > 0) {
        try {
          prefixCache = await readPrefix(transcriptPath, TITLE_SCAN_BYTES);
        } catch {}
      }
      return prefixCache;
    };
    const readTitle = async () => adapter2.title({ sessionId: input.session_id, prefix: await getPrefix(), input, transcriptPath });
    const readModel = async () => adapter2.model?.({ sessionId: input.session_id, prefix: await getPrefix(), input, transcriptPath });
    if (!config) {
      const pending = await loadPendingConfig();
      if (pending) {
        const machine2 = pending.machineName ?? hostname().replace(/\.local$/, "");
        await stashPendingEvent(input, machine2, await readTitle(), Date.now(), PENDING_STASH_PATH, process.ppid, agent, await readModel());
      }
      return;
    }
    const machine = config.machineName ?? hostname().replace(/\.local$/, "");
    const reportedSessionId = input.session_id;
    const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
    const sessionStartSource = typeof input.source === "string" ? input.source : "";
    const hookPid = process.ppid;
    const hookCommand = pidCommand(hookPid);
    let sessionId = reportedSessionId;
    let eventInput = input;
    let reusedForkPredecessor = false;
    let existingRecord = await readRecord(reportedSessionId);
    let trackedCache;
    const trackedSessions = async () => {
      if (trackedCache === undefined)
        trackedCache = await readTrackedSessions();
      return trackedCache;
    };
    const suppress = (suppression, extra = {}) => traceSession({
      event: "suppress",
      sessionId: reportedSessionId,
      agent,
      hook_event_name: hookName,
      ...sessionStartSource ? { source: sessionStartSource } : {},
      ...suppression,
      ...extra
    });
    const companionBroker = agent === "codex" ? codexCompanionBrokerEvidence(hookPid, pidAncestors, pidCommand) : null;
    if (companionBroker) {
      const reason = `broker ancestry proven by ${companionBroker.matchedBy}`;
      if (existingRecord) {
        await retireLineageSession(config, reportedSessionId, agent, input, `codex companion ${reason}`);
      }
      suppress({
        guard: "codex-companion-broker",
        reason
      }, {
        brokerPid: companionBroker.pid,
        brokerMatch: companionBroker.matchedBy
      });
      return;
    }
    const clearLineage = !existingRecord && hookName === "SessionStart" && sessionStartSource === "clear" && adapter2.clearPredecessor;
    if (clearLineage && adapter2.clearPredecessor) {
      const predecessor = adapter2.clearPredecessor({
        sessionId: reportedSessionId,
        hookPid,
        tracked: await trackedSessions()
      });
      if (predecessor) {
        await retireLineageSession(config, predecessor, agent, input, "claude SessionStart source:clear");
        trackedCache = trackedCache?.filter((t) => t.sessionId !== predecessor);
      }
    }
    if (!existingRecord && hookName === "SessionStart" && adapter2.forkResumePredecessor) {
      const predecessor = adapter2.forkResumePredecessor(hookCommand);
      const predecessorRecord = predecessor ? await readRecord(predecessor) : null;
      if (predecessor && predecessorRecord) {
        sessionId = predecessor;
        eventInput = { ...input, session_id: predecessor };
        existingRecord = predecessorRecord;
        reusedForkPredecessor = true;
        suppress({
          guard: "claude-fork-reemission",
          reason: "daemon fork/resume SessionStart reused the already-tracked predecessor row"
        }, { predecessorSessionId: predecessor, effectiveSessionId: predecessor });
      }
    }
    if (!existingRecord && adapter2.isChildSessionGhost) {
      const tracked = await trackedSessions();
      if (tracked.length > 0 && adapter2.isChildSessionGhost({
        sessionId: reportedSessionId,
        prefix: await getPrefix(),
        hookPid,
        tracked
      })) {
        suppress({
          guard: "codex-child-session",
          reason: "never-tracked empty child id shares a pid with a tracked Codex session"
        });
        return;
      }
    }
    if (!existingRecord && adapter2.sessionCreationSuppression) {
      const suppression = await adapter2.sessionCreationSuppression({
        sessionId: reportedSessionId,
        prefix: await getPrefix(),
        transcriptPath,
        input
      });
      if (suppression) {
        suppress(suppression);
        return;
      }
    }
    const continuedForkPrompt = hookName === "UserPromptSubmit" && typeof input.prompt === "string" && input.prompt.trim().length > 0 && !!adapter2.forkResumePredecessor?.(hookCommand);
    if (!existingRecord && !continuedForkPrompt && adapter2.isHeadlessInvocation && adapter2.isHeadlessInvocation({
      pid: hookPid,
      ancestorsOf: pidAncestors,
      commandOf: pidCommand
    })) {
      suppress({
        guard: "claude-headless-invocation",
        reason: "invoking process or ancestor matches a non-interactive/daemon discriminator"
      });
      return;
    }
    const title = await readTitle() ?? existingRecord?.title;
    if (!existingRecord && clearLineage && !title) {
      suppress({
        guard: "claude-clear-untitled",
        reason: "clear-lineage SessionStart has no prompt/title yet"
      });
      return;
    }
    const model = await readModel() ?? existingRecord?.model;
    const sentDone = existingRecord?.sentDone === true;
    const cachedStart = typeof existingRecord?.sessionStartedAt === "number" && Number.isFinite(existingRecord.sessionStartedAt) ? existingRecord.sessionStartedAt : undefined;
    const startedAt = cachedStart ?? transcriptStartMs(await getPrefix());
    const cachedTurn = typeof existingRecord?.turnStartedAt === "number" && Number.isFinite(existingRecord.turnStartedAt) ? existingRecord.turnStartedAt : undefined;
    const isTurnOpener = hookName === "UserPromptSubmit" || hookName === "SessionStart" && sessionStartSource !== "compact";
    const turnStartedAt = isTurnOpener ? Math.floor(Date.now() / 1000) : cachedTurn;
    const turnId = typeof input.turn_id === "string" && input.turn_id.length > 0 ? input.turn_id : undefined;
    let plan = planOp(hookName, input, sentDone);
    if (!plan)
      return;
    let pendingPlanPicker = false;
    let planPickerVerificationPending = false;
    let attentionKind;
    let proposedPlan;
    let pickerClassifier = plan.op === "done" ? "none" : plan.status;
    if (plan.op === "done" && adapter2.completedTurnWaitState) {
      const evidence = adapter2.completedTurnWaitEvidence ? await adapter2.completedTurnWaitEvidence({ pid: hookPid, transcriptPath }) : { state: await adapter2.completedTurnWaitState({ pid: hookPid, transcriptPath }) };
      const wait = evidence.state;
      pickerClassifier = wait;
      if (wait === "pending") {
        plan = { op: "update", prio: 1, status: "needsAttention" };
        attentionKind = "userInput";
        pendingPlanPicker = true;
        proposedPlan = evidence.plan;
      } else if (wait === "incomplete") {
        plan = { op: "update", prio: 0, status: "working" };
        planPickerVerificationPending = true;
      }
    }
    const label = typeof existingRecord?.label === "string" && existingRecord.label.length > 0 ? existingRecord.label : typeof input.cwd === "string" && input.cwd.length > 0 ? basename2(input.cwd) : "session";
    const dbg = agent === "codex" ? formatPlanPickerDebug({
      event: hookName || "event",
      classifier: pickerClassifier,
      marker: pendingPlanPicker ? "p" : planPickerVerificationPending ? "v" : "0",
      ttl: pendingPlanPicker || planPickerVerificationPending ? "0m" : "-",
      by: "h"
    }) : undefined;
    let planFull;
    const envelope = await buildEnvelope(eventInput, machine, Date.now(), title, config.e2eKey, sentDone, agent, startedAt, turnStartedAt, label, model, plan, attentionKind, proposedPlan, dbg, (plaintext) => {
      planFull = fullTextForRecord(proposedPlan, plaintext.plan);
    });
    if (!envelope)
      return;
    const createsRecord = !existingRecord && plan.op !== "end";
    const retiresRecord = !!existingRecord && plan.op === "end";
    const origin = existingRecord?.origin ?? sessionOrigin(input, hookPid, hookCommand);
    const recordPid = reusedForkPredecessor ? existingRecord.pid : hookPid;
    const recordTranscript = reusedForkPredecessor ? existingRecord.transcript ?? transcriptPath : transcriptPath;
    await trackSession(sessionId, plan.op, plan.prio, plan.status, envelope.blob, machine, label, recordTranscript, agent, startedAt, turnStartedAt, turnId, title, config.pairingId, model, pendingPlanPicker, recordPid, origin, planPickerVerificationPending, dbg, attentionKind, planFull);
    const clearedPickerMarker = pendingPlanPicker === false && planPickerVerificationPending === false && (existingRecord?.pendingPlanPicker === true || existingRecord?.planPickerVerificationPending === true || existingRecord?.planPickerSettled === true);
    if (agent === "codex" && (hookName === "Stop" || pendingPlanPicker || planPickerVerificationPending || clearedPickerMarker)) {
      tracePlanPickerDecision(sessionId, {
        source: "hook",
        classifier: pickerClassifier,
        marker: pendingPlanPicker ? "set-pending" : planPickerVerificationPending ? "set-verification" : clearedPickerMarker ? "cleared" : "none",
        correctionPosted: false,
        ...plan.op === "done" ? { doneBy: "hook" } : {}
      });
    }
    if (createsRecord) {
      traceSession({
        event: "create",
        sessionId,
        agent,
        hook_event_name: hookName,
        ...sessionStartSource ? { source: sessionStartSource } : {},
        origin
      });
    } else if (retiresRecord) {
      traceSession({
        event: "retire",
        sessionId,
        agent,
        hook_event_name: hookName,
        ...sessionStartSource ? { source: sessionStartSource } : {},
        reason: "hook op:end"
      });
    }
    ensureWatchdog();
    if (agent === "codex")
      await reconcileProvisional(config, hookPid);
    const res = await fetch(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret,
        "x-cc-version": PLUGIN_VERSION,
        "x-cc-approvals": await localApprovalsState()
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(2000)
    });
    if (res.ok) {
      await atomicWrite(LAST_SEND_PATH, String(Date.now()));
      await resetGoneStrikes();
      if (plan.op === "done")
        await markDoneDelivered(sessionId);
    } else if (res.status === 404 || res.status === 410) {
      const strikes = await recordGoneStrike();
      if (strikes >= GONE_STRIKE_LIMIT) {
        await removeRevokedConfig();
        process.stderr.write(`[nomo-cc] pairing gone server-side (HTTP ${res.status}) — removed local pairing; re-pair with \`nomo-cc pair\` to reconnect
`);
      }
    } else {
      await resetGoneStrikes();
    }
  } catch {}
}

// src/core/decision-poll.ts
var POLL_INTERVAL_MS = 3000;
var POLL_TIMEOUT_MS = 2000;
var POST_MAX_ATTEMPTS = 2;
var POST_RETRY_PAUSE_MS = 1000;
var MAX_CONSECUTIVE_MISSES = 100;
var DEFINITIVE_POLL_STATUSES = new Set([401, 403, 404, 410]);
var MAX_DEFINITIVE_POLL_FAILURES = 2;

// src/core/lan-wire.ts
var LAN_PATH = "/v1/lan";
var LAN_ENVELOPE_VERSION = 1;
var LAN_TTL_MS = 120000;
var LAN_FUTURE_SKEW_MS = 30000;
var LAN_NONCE_MAX_CHARS = 64;
var LAN_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
var LAN_ANSWER_BLOB_MAX_CHARS = 3072;
var LAN_COMMAND_BLOB_MAX_CHARS = 8192;
var LAN_FRAMES_WAIT_MAX_MS = 25000;
function parseLanFramesRequest(payload) {
  const sinceSeq = payload.sinceSeq;
  const waitMs = payload.waitMs;
  if (typeof sinceSeq !== "number" || !Number.isInteger(sinceSeq))
    return null;
  if (sinceSeq < 0 || sinceSeq > Number.MAX_SAFE_INTEGER)
    return null;
  if (typeof waitMs !== "number" || !Number.isInteger(waitMs))
    return null;
  if (waitMs < 0 || waitMs > LAN_FRAMES_WAIT_MAX_MS)
    return null;
  return { sinceSeq, waitMs };
}
var LAN_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function parseLanReadRequest(payload) {
  const what = payload.what;
  const sessionId = payload.sessionId;
  if (what !== "plan" && what !== "permission-detail")
    return null;
  if (typeof sessionId !== "string" || !LAN_SESSION_ID_RE.test(sessionId))
    return null;
  return { what, sessionId };
}
var LAN_STATE_PATH = `${CC_DIR}/lan.json`;
function parseLanState(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null)
      return null;
    const s = parsed;
    if (typeof s.port !== "number" || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535)
      return null;
    if (typeof s.lid !== "string" || s.lid.length === 0 || s.lid.length > 128)
      return null;
    const createdAt = typeof s.createdAt === "number" && Number.isFinite(s.createdAt) ? s.createdAt : 0;
    return { port: s.port, lid: s.lid, createdAt };
  } catch {
    return null;
  }
}
function parseLanEnvelope(plain) {
  if (typeof plain !== "object" || plain === null)
    return null;
  const e = plain;
  if (e.v !== LAN_ENVELOPE_VERSION)
    return null;
  if (typeof e.op !== "string" || e.op.length === 0 || e.op.length > 32)
    return null;
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts))
    return null;
  if (typeof e.nonce !== "string" || e.nonce.length === 0 || e.nonce.length > LAN_NONCE_MAX_CHARS)
    return null;
  if (typeof e.payload !== "object" || e.payload === null || Array.isArray(e.payload))
    return null;
  return { v: e.v, op: e.op, ts: e.ts, nonce: e.nonce, payload: e.payload };
}
function lanEnvelopeIsFresh(ts, now) {
  if (ts > now + LAN_FUTURE_SKEW_MS)
    return false;
  return now - ts <= LAN_TTL_MS;
}
function isLoopbackAddress(address) {
  if (typeof address !== "string" || address.length === 0)
    return false;
  const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
  return bare === "::1" || bare === "127.0.0.1" || bare.startsWith("127.");
}
function lanRunningUnderTest() {
  return process.argv.some((arg) => arg === "test" || arg.endsWith(".test.ts"));
}

// src/core/permission.ts
var POST_FIRST_CONTACT_TIMEOUT_MS = 4000;
var HOLD_RETRY_DELAY_MS = 4000;
var FRESH_SESSION_MS = 60000;
var MAX_UNKNOWN_ANSWER_READS = 3;
var CODEX_POLICY_TAIL_BYTES = 8 * 1024 * 1024;
var CODEX_ROLLOUT_HEAD_BYTES = 1024 * 1024;
function codexTurnPolicyFromRollout(text, turnId) {
  if (turnId.length === 0)
    return null;
  const lines = text.split(`
`);
  for (let i = lines.length - 1;i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes("turn_context") || !line.includes(turnId))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const record = row;
    if (record.type !== "turn_context")
      continue;
    const payload = record.payload;
    if (typeof payload !== "object" || payload === null)
      continue;
    const context = payload;
    if (context.turn_id !== turnId)
      continue;
    const sandbox = typeof context.sandbox_policy === "object" && context.sandbox_policy !== null ? context.sandbox_policy : undefined;
    const profile = typeof context.permission_profile === "object" && context.permission_profile !== null ? context.permission_profile : undefined;
    return {
      approvalPolicy: context.approval_policy,
      approvalsReviewer: typeof context.approvals_reviewer === "string" ? context.approvals_reviewer : undefined,
      sandboxType: typeof sandbox?.type === "string" ? sandbox.type : undefined,
      permissionProfileType: typeof profile?.type === "string" ? profile.type : undefined
    };
  }
  return null;
}
function codexRolloutSessionId(text) {
  for (const line of text.split(`
`)) {
    if (!line.includes("session_meta"))
      continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null)
      continue;
    const record = row;
    if (record.type !== "session_meta")
      continue;
    const id = record.payload?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }
  return;
}
async function loadCodexTurnPolicy(transcriptPath, turnId, sessionId, home = codexHome()) {
  if (!transcriptPath || !turnId || !sessionId || !basename3(transcriptPath).match(/^rollout-.*\.jsonl$/))
    return null;
  try {
    const sessionsRoot = await realpath(resolve(home, "sessions"));
    const rollout = await realpath(transcriptPath);
    const rel = relative(sessionsRoot, rollout);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
      return null;
    const head = await readPrefix(rollout, CODEX_ROLLOUT_HEAD_BYTES);
    if (codexRolloutSessionId(head) !== sessionId)
      return null;
    return codexTurnPolicyFromRollout(await readSuffix(rollout, CODEX_POLICY_TAIL_BYTES), turnId);
  } catch {
    return null;
  }
}
function codexPassThroughReason(policy) {
  if (!policy)
    return "codex-context-unknown";
  if (policy.approvalPolicy === "never")
    return "codex-full-access";
  const guardianReviewer = policy.approvalsReviewer === "auto_review" || policy.approvalsReviewer === "guardian_subagent";
  const reviewablePolicy = policy.approvalPolicy === "on-request" || policy.approvalPolicy === "granular" || typeof policy.approvalPolicy === "object" && policy.approvalPolicy !== null;
  if (guardianReviewer && reviewablePolicy)
    return "codex-auto-review";
  if (policy.approvalPolicy === "untrusted" || policy.approvalsReviewer === "user")
    return;
  return "codex-context-unknown";
}
function decisionLine(agent, hookSpecificOutput) {
  return JSON.stringify(agent === "codex" ? { continue: true, hookSpecificOutput } : { hookSpecificOutput });
}
var ALLOW_HSO = { hookEventName: "PermissionRequest", decision: { behavior: "allow" } };
var DENY_HSO = { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Denied from phone" } };
var DENY_MESSAGE_MAX = 500;
var ANSWER_MAX = 500;
function allowLine(agent, toolName, toolInput) {
  if (toolName === "ExitPlanMode") {
    return decisionLine(agent, { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: toolInput } });
  }
  return decisionLine(agent, ALLOW_HSO);
}
function denyLine(agent, message) {
  const m = typeof message === "string" ? message.trim().slice(0, DENY_MESSAGE_MAX) : "";
  if (m.length === 0)
    return decisionLine(agent, DENY_HSO);
  return decisionLine(agent, { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: m } });
}
function allowAlwaysLine(agent, toolName, toolInput, suggestions) {
  if (agent === "codex")
    return allowLine(agent, toolName, toolInput);
  const updatedPermissions = Array.isArray(suggestions) && suggestions.length > 0 ? suggestions : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
  const decision = toolName === "ExitPlanMode" ? { behavior: "allow", updatedInput: toolInput, updatedPermissions } : { behavior: "allow", updatedPermissions };
  return decisionLine(agent, { hookEventName: "PermissionRequest", decision });
}
function answerLine(agent, toolName, toolInput, answers) {
  if (toolName !== "AskUserQuestion" || !Array.isArray(answers))
    return;
  const questions = usableQuestions(toolInput);
  if (questions.length === 0)
    return;
  if (new Set(questions.map((q) => q.text)).size !== questions.length)
    return;
  const map = {};
  for (let i = 0;i < questions.length; i += 1) {
    const a = answers[i];
    if (typeof a !== "string")
      return;
    const raw = a.trim();
    if (raw.length === 0)
      return;
    if (raw.length > ANSWER_MAX)
      return;
    const resolved = resolveAnswer(raw, questions[i].labels);
    if (resolved === undefined)
      return;
    map[questions[i].text] = resolved;
  }
  if (Object.keys(map).length !== questions.length)
    return;
  return decisionLine(agent, {
    hookEventName: "PermissionRequest",
    decision: { behavior: "allow", updatedInput: { ...toolInput, answers: map } }
  });
}
function resolveAnswer(answer, labels) {
  const matchOne = (piece) => {
    const hits = Array.from(new Set(labels.filter((l) => l === piece || capPermissionWireText(l, PERMISSION_QUESTION_LABEL_MAX) === piece)));
    return hits.length === 1 ? hits[0] : undefined;
  };
  const whole = matchOne(answer);
  if (whole !== undefined)
    return whole;
  const pieces = answer.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (pieces.length === 0)
    return;
  const mapped = [];
  for (const piece of pieces) {
    const hit = matchOne(piece);
    if (hit === undefined)
      return;
    mapped.push(hit);
  }
  return mapped.join(", ");
}
var TRACE_PATH = `${CC_DIR}/permission-trace.log`;
var TRACE_MAX_BYTES = 256 * 1024;
function errorTag(e) {
  const name = typeof e?.name === "string" ? e.name : typeof e;
  const code = e?.code;
  return { error: name, ...typeof code === "string" ? { code } : {} };
}
function parseErrorPosition(e) {
  const m = typeof e?.message === "string" ? /position (\d+)/.exec(e.message) : null;
  return m ? Number(m[1]) : undefined;
}
function appendTrace(path, event) {
  try {
    appendFileSync2(path, `${JSON.stringify({ ts: Date.now(), pid: process.pid, ...event })}
`, { mode: 384 });
  } catch {}
}
var traceRotated = false;
function rotateTraceOnce(path) {
  if (traceRotated)
    return;
  traceRotated = true;
  try {
    if (statSync2(path).size > TRACE_MAX_BYTES)
      truncateSync2(path, 0);
  } catch {}
}
var signalHandlersInstalled = false;
function defaultTrace() {
  rotateTraceOnce(TRACE_PATH);
  const trace = (event) => appendTrace(TRACE_PATH, event);
  if (!signalHandlersInstalled) {
    signalHandlersInstalled = true;
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.on(sig, () => {
        trace({ event: "signal", signal: sig });
        process.exit(0);
      });
    }
    process.on("uncaughtException", (e) => {
      trace({ event: "uncaughtException", ...errorTag(e) });
      process.exit(0);
    });
    process.on("unhandledRejection", (e) => {
      trace({ event: "unhandledRejection", ...errorTag(e) });
      process.exit(0);
    });
    process.on("exit", (code) => appendTrace(TRACE_PATH, { event: "exit-event", code }));
  }
  return trace;
}
function buildPermissionSummary(toolName, toolInput) {
  const str = (v) => typeof v === "string" && v.length > 0 ? v : undefined;
  const truncate = (s, n = 80) => s.length <= n ? s : `${s.slice(0, n - 1)}…`;
  switch (toolName) {
    case "Bash":
    case "shell":
    case "local_shell": {
      const cmd = str(toolInput.command);
      return cmd ? truncate(cmd.split(`
`)[0]) : toolName;
    }
    case "apply_patch": {
      const desc = str(toolInput.description);
      return desc ? truncate(desc) : toolName;
    }
    case "Edit":
    case "Write":
    case "Read":
    case "NotebookEdit": {
      const fp = str(toolInput.file_path);
      return fp ? basename3(fp) : toolName;
    }
    case "WebFetch":
    case "WebSearch": {
      const url = str(toolInput.url);
      if (url) {
        try {
          return new URL(url).host;
        } catch {}
      }
      const query = str(toolInput.query);
      return query ? truncate(query) : toolName;
    }
    case "ExitPlanMode":
      return "Approve Claude's plan";
    case "AskUserQuestion": {
      const q = str(firstQuestionText(toolInput));
      return q ? truncate(q) : toolName;
    }
    default: {
      if (/^mcp__/.test(toolName)) {
        const seg = toolName.split("__").pop();
        return seg && seg.length > 0 ? seg : toolName;
      }
      return toolName;
    }
  }
}
function buildPermissionDetail(toolName, toolInput) {
  const str = (v) => typeof v === "string" && v.length > 0 ? v : undefined;
  switch (toolName) {
    case "Bash":
    case "shell":
    case "local_shell": {
      const c = str(toolInput.command);
      return c ?? "";
    }
    case "apply_patch": {
      const d = str(toolInput.description);
      return d ?? "";
    }
    case "Edit":
    case "Write":
    case "Read":
    case "NotebookEdit": {
      const fp = str(toolInput.file_path);
      return fp ?? "";
    }
    case "WebFetch": {
      const u = str(toolInput.url);
      return u ?? "";
    }
    case "WebSearch": {
      const q = str(toolInput.query);
      return q ?? "";
    }
    case "ExitPlanMode": {
      const p = str(toolInput.plan);
      return p ?? "";
    }
    case "AskUserQuestion":
      return "";
    default:
      return "";
  }
}
var QUESTION_TEXT_MAX = 240;
var PERMISSION_QUESTION_LABEL_MAX = 60;
var QUESTION_DESCRIPTION_MAX = 160;
function capPermissionWireText(value, max) {
  const characters = Array.from(value);
  return characters.length <= max ? value : `${characters.slice(0, max - 1).join("")}…`;
}
function usableQuestions(toolInput) {
  const qs = toolInput.questions;
  if (!Array.isArray(qs))
    return [];
  const out = [];
  for (const raw of qs) {
    const text = typeof raw?.question === "string" ? raw.question : "";
    if (text.length === 0)
      continue;
    const labels = [];
    const descriptions = [];
    if (Array.isArray(raw?.options)) {
      for (const opt of raw.options) {
        const label = opt?.label;
        if (typeof label === "string" && label.length > 0) {
          labels.push(label);
          const description = opt?.description;
          descriptions.push(typeof description === "string" ? description : "");
        }
      }
    }
    if (labels.length === 0)
      continue;
    out.push({ text, raw, labels, descriptions });
  }
  return out;
}
function firstQuestionText(toolInput) {
  return usableQuestions(toolInput)[0]?.text ?? "";
}
function buildPermissionQuestions(toolInput) {
  return usableQuestions(toolInput).map(({ text, raw, labels, descriptions }) => {
    const wireDescriptions = descriptions.map((description) => capPermissionWireText(description, QUESTION_DESCRIPTION_MAX));
    return {
      q: capPermissionWireText(text, QUESTION_TEXT_MAX),
      ...typeof raw?.header === "string" && raw.header.length > 0 ? { h: raw.header } : {},
      ...raw?.multiSelect === true ? { m: true } : {},
      o: labels.map((l) => capPermissionWireText(l, PERMISSION_QUESTION_LABEL_MAX)),
      ...wireDescriptions.some((description) => description.length > 0) ? { d: wireDescriptions } : {}
    };
  });
}
var MAX_DETAIL_CHARS = 20000;
function fitPermissionDetail(base, detail, maxChars = BLOB_FIT_CHARS, questions = []) {
  const all = Array.from(detail);
  const hardLoss = Math.max(0, all.length - MAX_DETAIL_CHARS);
  const chars = hardLoss > 0 ? all.slice(0, MAX_DETAIL_CHARS) : all;
  const encoder = new TextEncoder;
  const measure = (d, omitted, qs) => sealedBlobChars(encoder.encode(JSON.stringify(permissionFrame(base, d, omitted, qs))).length);
  const worstCase = all.length;
  const bareQuestions = questions.map(({ d: _descriptions, ...question }) => question);
  const kept = questions.length > 0 && measure("", worstCase, questions) <= maxChars ? questions : bareQuestions.length > 0 && measure("", worstCase, bareQuestions) <= maxChars ? bareQuestions : [];
  const tail = kept.length > 0 ? { questions: kept } : {};
  const frameChars = (d, omitted) => measure(d, omitted, kept);
  if (chars.length === 0)
    return { detail: "", omitted: 0, ...tail };
  if (hardLoss === 0 && frameChars(detail, 0) <= maxChars)
    return { detail, omitted: 0, ...tail };
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (frameChars(`${chars.slice(0, mid).join("")}…`, worstCase) <= maxChars)
      lo = mid;
    else
      hi = mid - 1;
  }
  const shortest = `${chars.slice(0, lo).join("")}…`;
  if (lo === 0 && frameChars(shortest, worstCase) > maxChars) {
    if (frameChars("", all.length) <= maxChars)
      return { detail: "", omitted: all.length, ...tail };
    return { detail: "", omitted: 0, ...tail };
  }
  return { detail: shortest, omitted: all.length - lo, ...tail };
}
function permissionFrame(base, detail, omitted, questions = []) {
  return {
    ...base,
    ...detail.length > 0 ? { permissionDetail: detail } : {},
    ...omitted > 0 ? { permissionDetailOmitted: omitted } : {},
    ...questions.length > 0 ? { permissionQuestions: questions } : {}
  };
}
function emitDecision(agent, answer, toolName, toolInput, suggestions, emit, trace) {
  const isQuestion = toolName === "AskUserQuestion";
  switch (answer.decision) {
    case "allow":
      if (isQuestion) {
        trace({ event: "release", reason: "bare-allow-on-question" });
        return "released";
      }
      emit(allowLine(agent, toolName, toolInput));
      trace({ event: "emit", decision: "allow" });
      return "emitted";
    case "allow_always":
      if (isQuestion) {
        trace({ event: "release", reason: "bare-allow-on-question" });
        return "released";
      }
      emit(allowAlwaysLine(agent, toolName, toolInput, suggestions));
      trace({ event: "emit", decision: agent === "codex" ? "allow_always_degraded_to_allow" : "allow_always" });
      return "emitted";
    case "deny":
      emit(denyLine(agent, answer.message));
      trace({ event: "emit", decision: "deny", hasMessage: typeof answer.message === "string" && answer.message.trim().length > 0 });
      return "emitted";
    case "answer": {
      const line = answerLine(agent, toolName, toolInput, answer.answers);
      if (line === undefined) {
        trace({ event: "release", reason: "answer-unmappable", tool_name: toolName });
        return "released";
      }
      emit(line);
      trace({ event: "emit", decision: "answer" });
      return "emitted";
    }
    default:
      trace({ event: "answer-unknown-decision" });
      return "keep-polling";
  }
}
var LOOPBACK_POLL_INTERVAL_MS = 300;
var LOOPBACK_FETCH_TIMEOUT_MS = 250;
var LOOPBACK_MAX_CONSECUTIVE_ERRORS = 5;
function createLoopbackAnswerPoller(config, requestId, deps) {
  const interval = deps.intervalMs ?? LOOPBACK_POLL_INTERVAL_MS;
  const discoverInterval = deps.discoverIntervalMs ?? POLL_INTERVAL_MS;
  const tick = deps.sleep ?? ((ms) => new Promise((resolve2) => {
    const timer = setTimeout(resolve2, ms);
    timer.unref?.();
  }));
  let live = deps.statePath !== undefined;
  let started = false;
  let port;
  let lastDiscoverAt = 0;
  let errors = 0;
  let traced = false;
  let pending;
  let wakeResolve = () => {};
  let wake = new Promise((resolve2) => {
    wakeResolve = resolve2;
  });
  let keyPromise;
  const note2 = (result) => {
    if (traced)
      return;
    traced = true;
    try {
      deps.trace({ event: "lan-poll", result });
    } catch {}
  };
  const key = () => keyPromise ??= deriveLanKey(config.e2eKey, config.pairingId);
  const readPort = async () => {
    if (deps.statePath === undefined)
      return;
    try {
      return parseLanState(await readFile4(deps.statePath, "utf8"))?.port;
    } catch {
      return;
    }
  };
  const attempt = async () => {
    try {
      const k = await key();
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const body = JSON.stringify({
        p: await encryptBlob(k, {
          v: LAN_ENVELOPE_VERSION,
          op: "answer-poll",
          ts: deps.now(),
          nonce,
          payload: { requestId }
        })
      });
      const res = await deps.fetchFn(`http://127.0.0.1:${port}${LAN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(LOOPBACK_FETCH_TIMEOUT_MS)
      });
      if (!res.ok) {
        errors += 1;
        return;
      }
      const outer = await res.json();
      if (typeof outer?.p !== "string") {
        errors += 1;
        return;
      }
      const opened = await decryptBlob(k, outer.p);
      if (opened.reqNonce !== nonce) {
        errors += 1;
        return;
      }
      errors = 0;
      const payload = opened.payload;
      if (payload?.status === "answered" && typeof payload.answerBlob === "string" && payload.answerBlob.length > 0) {
        return payload.answerBlob;
      }
      return;
    } catch {
      errors += 1;
      return;
    }
  };
  const ticker = async () => {
    while (live) {
      await tick(interval);
      if (!live)
        return;
      if (port === undefined) {
        const t = deps.now();
        if (lastDiscoverAt !== 0 && t - lastDiscoverAt < discoverInterval)
          continue;
        lastDiscoverAt = t;
        port = await readPort();
        if (port === undefined)
          continue;
      }
      const blob = await attempt();
      if (!live)
        return;
      if (blob !== undefined) {
        pending = blob;
        wakeResolve();
        return;
      }
      if (errors >= LOOPBACK_MAX_CONSECUTIVE_ERRORS) {
        note2("give-up");
        live = false;
        return;
      }
    }
  };
  return {
    async wait(sleeping) {
      if (!live) {
        await sleeping;
        return;
      }
      if (!started) {
        started = true;
        ticker().catch(() => {
          live = false;
          note2("error");
        });
      }
      await Promise.race([sleeping, wake]);
      if (pending === undefined)
        return;
      const blob = pending;
      pending = undefined;
      live = false;
      return blob;
    },
    stop() {
      live = false;
      wakeResolve();
    }
  };
}
function defaultLanStatePath() {
  return lanRunningUnderTest() ? undefined : LAN_STATE_PATH;
}
function defaultStampDetailFull() {
  return lanRunningUnderTest() ? async () => {} : stampPermissionDetailFull;
}
function defaultWriteHold() {
  return lanRunningUnderTest() ? async () => {} : writeDecisionHold;
}
function defaultClearHold() {
  return lanRunningUnderTest() ? async () => {} : clearDecisionHold;
}
async function readStdin2() {
  const chunks = [];
  for await (const chunk of process.stdin)
    chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function runPermissionHook(deps = {}, agent = "claude") {
  const noHoldPath = deps.noHoldPath ?? NO_HOLD_PATH;
  const trace = deps.trace ?? defaultTrace();
  let loopback;
  let heldSessionId;
  try {
    if (await flagExists(noHoldPath)) {
      await (deps.delegate ?? (() => runHook(agent)))();
      return;
    }
    const [config, raw] = await Promise.all([
      (deps.loadConfigFn ?? loadConfig)(),
      (deps.readInput ?? readStdin2)()
    ]);
    trace({ event: "stdin-read", bytes: raw.length });
    if (!config) {
      trace({ event: "exit", reason: "unpaired" });
      return;
    }
    let input;
    try {
      input = JSON.parse(raw);
    } catch (e) {
      trace({ event: "exit", reason: "bad-stdin", ...errorTag(e), pos: parseErrorPosition(e) });
      return;
    }
    const sessionId = typeof input.session_id === "string" ? input.session_id : "";
    if (sessionId.length === 0) {
      trace({ event: "exit", reason: "no-session-id" });
      return;
    }
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const agentId = typeof input.agent_id === "string" ? input.agent_id : "";
    const permissionMode = typeof input.permission_mode === "string" ? input.permission_mode : undefined;
    trace({ event: "start", session_id: sessionId, tool_name: toolName, permission_mode: permissionMode, agent: agentId.length > 0 });
    if (agentId.length > 0) {
      const agentType = typeof input.agent_type === "string" ? input.agent_type : undefined;
      trace({ event: "exit", reason: "subagent", agent_type: agentType });
      return;
    }
    const interactiveMode = permissionMode === undefined || permissionMode === "default" || agent === "claude" && (permissionMode === "acceptEdits" || permissionMode === "plan");
    if (!interactiveMode) {
      const codexDialogMode = agent === "codex" && (permissionMode === "acceptEdits" || permissionMode === "plan");
      trace({ event: "exit", reason: "mode", mode: permissionMode, ...codexDialogMode ? { codex_dialog_mode: true } : {} });
      return;
    }
    if (agent === "codex" && !toolName.startsWith("mcp__")) {
      const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
      const turnId = typeof input.turn_id === "string" ? input.turn_id : "";
      const policy = await (deps.loadCodexTurnPolicyFn ?? loadCodexTurnPolicy)(transcriptPath, turnId, sessionId);
      const reason = codexPassThroughReason(policy);
      if (reason) {
        trace({ event: "exit", reason });
        return;
      }
      trace({ event: "codex-reviewer", disposition: "hold", reason: "manual" });
    } else if (agent === "codex") {
      trace({ event: "codex-reviewer", disposition: "hold", reason: "mcp-reviewer-unknown" });
    }
    const toolInput = typeof input.tool_input === "object" && input.tool_input !== null ? input.tool_input : {};
    const suggestions = input.permission_suggestions;
    const requestId = (deps.randomUUID ?? (() => crypto.randomUUID()))();
    const summary = buildPermissionSummary(toolName, toolInput);
    const now = (deps.now ?? Date.now)();
    const fetchFn = deps.fetchFn ?? fetch;
    const record = await (deps.readRecordFn ?? readRecord)(sessionId);
    const machine = config.machineName ?? hostname2().replace(/\.local$/, "");
    const plan = { op: "update", prio: 1, status: "needsAttention" };
    const at = Math.floor(now / 1000);
    const base = buildBlob(input, machine, record?.title, plan, agent, record?.turnStartedAt, record?.label, record?.model, at);
    const permissionBase = {
      ...base,
      status: "decisionPending",
      permissionSummary: summary,
      permissionRequestId: requestId,
      permissionToolName: toolName
    };
    const rawDetail = buildPermissionDetail(toolName, toolInput);
    const fitted = fitPermissionDetail(permissionBase, rawDetail, BLOB_FIT_CHARS, buildPermissionQuestions(toolInput));
    const detailFull = fullTextForRecord(rawDetail, fitted.detail);
    if (record && record.permissionDetailFull !== detailFull) {
      await (deps.stampDetailFullFn ?? defaultStampDetailFull())(sessionId, detailFull);
    }
    const blob = await encryptBlob(config.e2eKey, permissionFrame(permissionBase, fitted.detail, fitted.omitted, fitted.questions));
    const fallbackBlob = await encryptBlob(config.e2eKey, base);
    const pcHeaders = { "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret, "x-cc-version": PLUGIN_VERSION };
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let lastPostTs = 0;
    const postDecision = async (round, maxAttempts) => {
      let hold2 = false;
      let posted2 = false;
      let reason;
      for (let attempt = 1;attempt <= maxAttempts; attempt += 1) {
        const ts = Math.max((deps.now ?? Date.now)(), lastPostTs + 1);
        lastPostTs = ts;
        try {
          const res = await fetchFn(`${config.url}/v1/cc/decision`, {
            method: "POST",
            headers: { "content-type": "application/json", ...pcHeaders },
            body: JSON.stringify({ v: 2, sessionId, requestId, op: "update", prio: 1, ts, blob, fallbackBlob }),
            signal: AbortSignal.timeout(POST_FIRST_CONTACT_TIMEOUT_MS)
          });
          if (res.ok) {
            const body = await res.json().catch(() => ({}));
            hold2 = body.hold === true;
            if (typeof body.reason === "string")
              reason = body.reason;
          }
          trace({
            event: "posted",
            requestId,
            round,
            attempt,
            status: res.status,
            ts,
            ...res.ok ? { hold: hold2 } : {},
            ...reason !== undefined ? { reason } : {}
          });
          posted2 = true;
          break;
        } catch (e) {
          const name = e?.name ?? "Error";
          trace({ event: "posted", requestId, round, attempt, status: 0, ts, error: name });
          if (name === "TimeoutError")
            break;
          if (attempt < maxAttempts) {
            await sleep(POST_RETRY_PAUSE_MS);
            continue;
          }
        }
      }
      return { posted: posted2, hold: hold2, reason };
    };
    const pollDecision = async (seq2) => {
      trace({ event: "poll-begin", seq: seq2 });
      try {
        const res = await fetchFn(`${config.url}/v1/cc/decision/${requestId}`, {
          headers: pcHeaders,
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS)
        });
        if (!res.ok) {
          trace({ event: "poll-end", seq: seq2, outcome: "status", status: res.status });
          return { status: res.status };
        }
        const data = await res.json();
        trace({ event: "poll-end", seq: seq2, outcome: "ok" });
        return { data, status: res.status };
      } catch (e) {
        trace({ event: "poll-end", seq: seq2, outcome: "error", ...errorTag(e) });
        return { status: 0 };
      }
    };
    let { posted, hold, reason: holdReason } = await postDecision(1, POST_MAX_ATTEMPTS);
    if (!posted) {
      const probe = await pollDecision(0);
      const live = probe.data?.status === "pending" || probe.data?.status === "answered";
      if (!live) {
        trace({ event: "exit", reason: "post-error" });
        return;
      }
      trace({ event: "post-timeout-landed", status: probe.data?.status });
      hold = true;
      holdReason = undefined;
    }
    trace({ event: "hold", hold, ...holdReason !== undefined ? { reason: holdReason } : {} });
    if (!hold) {
      const fresh = !record || now - record.ts < FRESH_SESSION_MS;
      if (!fresh) {
        trace({ event: "exit", reason: "hold-false" });
        return;
      }
      trace({ event: "hold-retry-wait", delayMs: HOLD_RETRY_DELAY_MS });
      await sleep(HOLD_RETRY_DELAY_MS);
      const retry = await postDecision(2, 1);
      if (!retry.posted) {
        trace({ event: "exit", reason: "hold-false" });
        return;
      }
      hold = retry.hold;
      holdReason = retry.reason;
      trace({ event: "hold", hold, ...holdReason !== undefined ? { reason: holdReason } : {} });
      if (!hold) {
        trace({ event: "exit", reason: "hold-false" });
        return;
      }
    }
    await (deps.writeHoldFn ?? defaultWriteHold())(sessionId, { blob, at: (deps.now ?? Date.now)(), pid: deps.holdPid ?? process.pid });
    heldSessionId = sessionId;
    const jitter = deps.jitter ?? (() => Math.floor(Math.random() * 500));
    const interval = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    const emit = deps.emit ?? ((line) => process.stdout.write(`${line}
`));
    const applyAnswerBlob = async (answerBlob, src) => {
      const answer = await decryptBlob(config.e2eKey, answerBlob);
      const match = answer.requestId === requestId;
      const outcome = match ? emitDecision(agent, answer, toolName, toolInput, suggestions, emit, trace) : "released";
      if (outcome !== "keep-polling") {
        trace({ event: "answered", match, outcome, src });
        trace({ event: "exit", reason: "answered" });
        return "done";
      }
      return "keep-polling";
    };
    loopback = createLoopbackAnswerPoller(config, requestId, {
      fetchFn: deps.lanFetchFn ?? fetchFn,
      now: deps.now ?? Date.now,
      trace,
      statePath: deps.lanStatePath ?? defaultLanStatePath(),
      sleep: deps.lanSleep,
      intervalMs: deps.lanIntervalMs,
      discoverIntervalMs: interval
    });
    let misses = 0;
    let definitiveFailures = 0;
    let unknownBlob;
    let unknownReads = 0;
    let seq = 0;
    for (;; ) {
      seq += 1;
      const { data, status: httpStatus } = await pollDecision(seq);
      if (data) {
        misses = 0;
        definitiveFailures = 0;
        if (data.status === "answered" && typeof data.answerBlob === "string") {
          if (await applyAnswerBlob(data.answerBlob, "worker") === "done") {
            return;
          }
          unknownReads = data.answerBlob === unknownBlob ? unknownReads + 1 : 1;
          unknownBlob = data.answerBlob;
          if (unknownReads >= MAX_UNKNOWN_ANSWER_READS) {
            trace({ event: "release", reason: "unknown-decision-terminal", reads: unknownReads });
            trace({ event: "exit", reason: "unknown-decision" });
            return;
          }
        } else if (typeof data.status === "string" && data.status !== "pending") {
          trace({ event: data.status === "expired" ? "expired" : "superseded", status: data.status });
          trace({ event: "exit", reason: data.status });
          return;
        }
      } else {
        if (DEFINITIVE_POLL_STATUSES.has(httpStatus)) {
          definitiveFailures += 1;
          if (definitiveFailures >= MAX_DEFINITIVE_POLL_FAILURES) {
            trace({ event: "giveup", reason: "definitive", status: httpStatus, strikes: definitiveFailures });
            trace({ event: "exit", reason: "definitive" });
            return;
          }
        } else {
          definitiveFailures = 0;
        }
        if (++misses >= MAX_CONSECUTIVE_MISSES) {
          trace({ event: "giveup", misses });
          trace({ event: "exit", reason: "giveup" });
          return;
        }
      }
      const lanBlob = await loopback.wait(sleep(interval + jitter()));
      if (lanBlob !== undefined) {
        if (await applyAnswerBlob(lanBlob, "lan") === "done")
          return;
      }
    }
  } catch (e) {
    trace({ event: "exit", reason: "exception", ...errorTag(e) });
  } finally {
    try {
      loopback?.stop();
    } catch {}
    if (heldSessionId !== undefined) {
      try {
        await (deps.clearHoldFn ?? defaultClearHold())(heldSessionId, deps.holdPid ?? process.pid);
      } catch {}
    }
  }
}
async function approvalsCommand(sub, deps = {}) {
  const path = deps.noHoldPath ?? NO_HOLD_PATH;
  const print = deps.print ?? ((line) => console.log(line));
  if (sub === "off") {
    await atomicWrite(path, "", 384);
    print("Remote approvals are OFF for this computer — Claude Code permission prompts will appear in the terminal as usual (your phone is not asked).");
    return 0;
  }
  if (sub === "on") {
    await unlink3(path).catch(() => {});
    print("Remote approvals are ON for this computer — when a session is on your phone's Live Activity, its permission prompts are sent to the phone to Allow or Deny.");
    return 0;
  }
  print(await flagExists(path) ? "Remote approvals: OFF (paused locally) — permission prompts appear in the terminal. Run `on` to resume." : "Remote approvals: ON — permission prompts for phone-attached sessions are sent to your phone. Run `off` to pause them here.");
  return 0;
}

// src/entries/codex-permission.ts
if (__require.main == __require.module) {
  if (process.argv.includes("--check")) {
    console.log("usage: codex-permission [off|on|status]  — Codex PermissionRequest hook; off/on/status toggle the local no-hold escape hatch (pause/resume remote approvals on this computer — shared with Claude Code)");
    process.exit(0);
  }
  const sub = process.argv[2];
  if (sub === "off" || sub === "on" || sub === "status") {
    process.exit(await approvalsCommand(sub));
  }
  let flushed = Promise.resolve();
  await runPermissionHook({
    emit: (line) => {
      flushed = new Promise((resolve2) => {
        const timer = setTimeout(resolve2, 1000);
        timer.unref?.();
        process.stdout.write(`${line}
`, () => {
          clearTimeout(timer);
          resolve2();
        });
      });
    }
  }, "codex");
  await flushed;
  process.exit(0);
}
