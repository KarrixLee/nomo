import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/entries/status-cmd.ts
import { readdir as readdir2, readFile as readFile3, stat as stat3 } from "node:fs/promises";
import { join as join3 } from "node:path";

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

// src/core/shared.ts
var PLUGIN_VERSION = "1.6.6";
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
function formatDecisionHoldDebug(input) {
  const value = `${debugToken(input.version ?? PLUGIN_VERSION)} ev:hold req:${debugToken(input.requestId.slice(0, 8))} pid:${input.pid}`;
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
function watchdogBuildStamp(path = WATCHDOG_PATH) {
  try {
    const bytes = readFileSync(path);
    let hash = 2166136261;
    for (let i = 0;i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  } catch {
    return;
  }
}
function watchdogBuildDiffers(incumbent, current) {
  if (incumbent === undefined || current === undefined)
    return false;
  return incumbent !== current;
}
function formatWatchdogPidfile(pid, version = PLUGIN_VERSION, build) {
  return `${pid} ${version}${typeof build === "string" && build.length > 0 ? ` ${build}` : ""}`;
}
function parseWatchdogPidfile(raw) {
  const [pidField, versionField, buildField] = raw.trim().split(/\s+/);
  const pid = Number.parseInt(pidField ?? "", 10);
  if (!Number.isFinite(pid) || pid <= 0)
    return null;
  return {
    pid,
    ...typeof versionField === "string" && versionField.length > 0 ? { version: versionField } : {},
    ...typeof buildField === "string" && buildField.length > 0 ? { build: buildField } : {}
  };
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
    const build = "build" in deps ? deps.build : watchdogBuildStamp();
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
      if (holder.version === version && !watchdogBuildDiffers(holder.build, build))
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
async function clearDecisionHoldAt(sessionsDir, sessionId, pid, beforeUnlink) {
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
        return false;
    }
    if (beforeUnlink !== undefined) {
      try {
        await beforeUnlink();
      } catch {}
    }
    await unlink(path).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
async function settleDecisionHoldRecordAt(sessionsDir, sessionId, patch) {
  try {
    const record = await readRecord(sessionId, sessionsDir);
    if (!record)
      return;
    if (record.op !== "update" || record.prio !== 1)
      return;
    await atomicWrite(`${sessionsDir}/${sessionId}.json`, JSON.stringify({ ...record, ...patch }), 384);
  } catch {}
}
async function readDecisionHoldAt(sessionsDir, sessionId) {
  try {
    return JSON.parse(await readFile(`${sessionsDir}/${decisionHoldFileName(sessionId)}`, "utf8"));
  } catch {
    return null;
  }
}
async function writeDecisionHold(sessionId, hold) {
  return writeDecisionHoldAt(SESSIONS_DIR, sessionId, hold);
}
async function clearDecisionHold(sessionId, pid, beforeUnlink) {
  return clearDecisionHoldAt(SESSIONS_DIR, sessionId, pid, beforeUnlink);
}
async function settleDecisionHoldRecord(sessionId, patch) {
  return settleDecisionHoldRecordAt(SESSIONS_DIR, sessionId, patch);
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
  const retiredOwners = known.filter((r) => r.agent === "codex" && typeof r.retiredAt === "number" && Number.isFinite(r.retiredAt));
  const knownPids = new Set(known.filter((r) => !retiredOwners.includes(r)).flatMap((r) => [r.pid, r.tuiPid]).filter((p) => typeof p === "number" && Number.isFinite(p)));
  const tuis = filterCodexTuis(parseCodexProcs(output), knownPids);
  const out = [];
  for (const { pid } of tuis) {
    const cwd = await cwdOf(pid);
    const startedAt = await startedAtOf(pid);
    const retiredOwner = retiredOwners.find((r) => r.tuiPid === pid || r.pid === pid);
    if (retiredOwner && typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt <= retiredOwner.retiredAt)
      continue;
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
  let headlessExec = false;
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
    if (r.type === "session_meta") {
      if (codexSubagentSource(payload?.source ?? r.source))
        subagent = true;
      if (payload?.originator === "codex_exec" || payload?.source === "exec")
        headlessExec = true;
    }
    if (r.type === "event_msg" && payload?.type === "user_message")
      hasUserMessage = true;
  }
  return { subagent, hasUserMessage, headlessExec };
}
async function codexSessionCreationSuppression(sessionId, transcriptPrefix, transcriptPath, input = {}, deps = {}) {
  const evidence = codexRolloutCreationEvidence(transcriptPrefix);
  if (evidence.subagent) {
    return {
      guard: "codex-subagent-rollout",
      reason: "session_meta.source is a subagent variant"
    };
  }
  if (evidence.headlessExec) {
    return {
      guard: "codex-headless-exec",
      reason: "session_meta identifies a non-interactive codex exec run"
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

// src/entries/status-cmd.ts
var CODEX_PLUGIN_HOOK_COUNT = 7;
function countCodexHookEvents(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  const hooks = parsed?.hooks;
  if (typeof hooks !== "object" || hooks === null)
    return 0;
  let count = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups))
      continue;
    const has = groups.some((g) => {
      const handlers = g?.hooks;
      return Array.isArray(handlers) && handlers.some((h) => {
        const cmd = h?.command;
        return typeof cmd === "string" && cmd.includes(CODEX_HOOK_MARKER);
      });
    });
    if (has)
      count++;
  }
  return count;
}
function parseCodexPluginState(configToml) {
  let installed = false;
  let enabled = true;
  let trusted = 0;
  let ccTrusted = 0;
  let inPluginSection = false;
  for (const raw of configToml.split(`
`)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inPluginSection = line.startsWith('[plugins."nomo@');
      if (inPluginSection)
        installed = true;
      if (line.startsWith('[hooks.state."nomo@'))
        trusted++;
      else if (line.startsWith('[hooks.state."nomo-cc@'))
        ccTrusted++;
      continue;
    }
    if (inPluginSection) {
      const m = line.match(/^enabled\s*=\s*(true|false)\b/);
      if (m)
        enabled = m[1] === "true";
    }
  }
  return { installed, enabled, trusted, ccTrusted };
}
function humanAge(ms) {
  if (ms < 0)
    ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60)
    return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)
    return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)
    return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
var HOOK_STALE_MS = 10 * 60 * 1000;
var HOOK_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
function hooksAppearStale(now, sessionMtime, hookStamp) {
  if (sessionMtime <= 0)
    return false;
  if (now - sessionMtime > HOOK_ACTIVITY_WINDOW_MS)
    return false;
  if (hookStamp <= 0)
    return true;
  return sessionMtime - hookStamp > HOOK_STALE_MS;
}
async function newestFileMtime(dir, match) {
  let entries;
  try {
    entries = await readdir2(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let newest = 0;
  for (const e of entries) {
    const full = join3(dir, e.name);
    if (e.isDirectory()) {
      const m = await newestFileMtime(full, match);
      if (m > newest)
        newest = m;
    } else if (match(e.name)) {
      try {
        const m = (await stat3(full)).mtimeMs;
        if (m > newest)
          newest = m;
      } catch {}
    }
  }
  return newest;
}
async function readMsMarker(path) {
  try {
    const ts = Number.parseInt((await readFile3(path, "utf8")).trim(), 10);
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  } catch {
    return 0;
  }
}
async function statusCmd(deps = {}) {
  const print = deps.print ?? ((line) => console.log(line));
  const configPath = deps.configPath ?? `${CC_DIR}/config.json`;
  const lastSendPath = deps.lastSendPath ?? LAST_SEND_PATH;
  const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
  const watchdogPidPath = deps.watchdogPidPath ?? WATCHDOG_PID_PATH;
  const codexHooksPath = deps.codexHooksPath ?? `${codexHome()}/hooks.json`;
  const codexConfigPath = deps.codexConfigPath ?? `${codexHome()}/config.toml`;
  const codexSessionsDir = deps.codexSessionsDir ?? codexAdapter.sessionsDir();
  const claudeProjectsDir = deps.claudeProjectsDir ?? claudeAdapter.sessionsDir();
  const lastHookCodexPath = deps.lastHookCodexPath ?? codexAdapter.hookStampPath();
  const lastHookClaudePath = deps.lastHookClaudePath ?? claudeAdapter.hookStampPath();
  const isAlive = deps.isAlive ?? pidAlive;
  const now = deps.now ?? Date.now;
  const codexAppServerAvailable = deps.codexAppServerAvailable ?? (() => codexAppServerSocketAvailable());
  let raw = null;
  try {
    raw = await readFile3(configPath, "utf8");
  } catch {}
  const config = raw !== null ? parseConfig(raw) : null;
  if (config) {
    print(`Paired: yes (pairing ${config.pairingId.slice(0, 8)}…)`);
    print(`Worker: ${config.url}`);
  } else if (raw !== null && parsePendingConfig(raw)) {
    print("Paired: pairing started, waiting for phone scan — run /nomo-cc:pair to finish or retry.");
  } else {
    print("Paired: no — run pair to connect this machine to the Nomo app.");
  }
  let watchdog = "not running";
  try {
    const pid = Number.parseInt((await readFile3(watchdogPidPath, "utf8")).trim(), 10);
    if (Number.isFinite(pid) && pid > 0 && isAlive(pid))
      watchdog = `running (pid ${pid})`;
  } catch {}
  print(`Watchdog: ${watchdog}`);
  let lastSend = "never";
  try {
    const ts = Number.parseInt((await readFile3(lastSendPath, "utf8")).trim(), 10);
    if (Number.isFinite(ts) && ts > 0)
      lastSend = humanAge(now() - ts);
  } catch {}
  print(`Last event sent: ${lastSend}`);
  let sessions = 0;
  try {
    sessions = (await readdir2(sessionsDir)).filter((f) => f.endsWith(".json")).length;
  } catch {}
  print(`Tracked sessions: ${sessions}`);
  let plugin = { installed: false, enabled: true, trusted: 0, ccTrusted: 0 };
  try {
    plugin = parseCodexPluginState(await readFile3(codexConfigPath, "utf8"));
  } catch {}
  let legacyEvents = 0;
  try {
    legacyEvents = countCodexHookEvents(await readFile3(codexHooksPath, "utf8"));
  } catch {}
  let pluginState;
  if (plugin.installed) {
    if (!plugin.enabled)
      pluginState = "installed, disabled";
    else if (plugin.trusted === 0)
      pluginState = "installed, hooks NOT trusted (run /hooks in Codex)";
    else
      pluginState = `installed, trusted (${plugin.trusted}/${CODEX_PLUGIN_HOOK_COUNT})`;
  } else if (legacyEvents > 0) {
    pluginState = `legacy hooks.json (${legacyEvents} events)`;
  } else {
    pluginState = "not installed";
  }
  print(`Codex plugin: ${pluginState}`);
  if (await codexAppServerAvailable()) {
    print("Codex Plan answers: bridge available (shared app-server socket found)");
  } else {
    print("Codex Plan answers: status-only (start `codex app-server daemon start` before launching Codex)");
  }
  if (!plugin.installed && legacyEvents > 0) {
    print("  Legacy Codex hooks still work — consider migrating to the native Nomo plugin.");
  }
  if (plugin.installed && plugin.enabled && legacyEvents > 0) {
    print(`  WARNING: ~/.codex/hooks.json ALSO has ${legacyEvents} legacy Nomo event(s) — events will double-fire.`);
    print("  Delete the six Nomo entries (command contains codex-status.mjs) from ~/.codex/hooks.json.");
  }
  if (plugin.trusted > 0 && plugin.ccTrusted > 0) {
    print("  WARNING: Codex auto-discovered the Claude plugin and runs BOTH plugins' hooks on every Codex event (redundant double-fire).");
    print('  Untrust/remove the `nomo-cc@nomo` entries in Codex (`/hooks` in Codex, or delete those `[hooks.state."nomo-cc@…"]` blocks from <CODEX_HOME>/config.toml) — the native `nomo` plugin alone is correct.');
  }
  if (config) {
    const checks = [
      {
        name: "Codex",
        enabled: plugin.installed,
        requireStamp: false,
        sessionsDir: codexSessionsDir,
        match: codexAdapter.sessionMatch,
        stampPath: lastHookCodexPath,
        hint: codexAdapter.hooksNotFiringHint
      },
      {
        name: "Claude",
        enabled: true,
        requireStamp: true,
        sessionsDir: claudeProjectsDir,
        match: claudeAdapter.sessionMatch,
        stampPath: lastHookClaudePath,
        hint: claudeAdapter.hooksNotFiringHint
      }
    ];
    for (const c of checks) {
      if (!c.enabled)
        continue;
      const sessionMtime = await newestFileMtime(c.sessionsDir, c.match);
      const hookStamp = await readMsMarker(c.stampPath);
      if (c.requireStamp && hookStamp <= 0)
        continue;
      if (!hooksAppearStale(now(), sessionMtime, hookStamp))
        continue;
      const stampAge = hookStamp > 0 ? humanAge(now() - hookStamp) : "never";
      print(`  WARNING: ${c.name} hooks appear NOT to be firing — session active ${humanAge(now() - sessionMtime)}, last hook ${stampAge}.`);
      print(c.hint);
    }
  }
  return 0;
}
if (__require.main == __require.module) {
  if (process.argv.includes("--check")) {
    console.log("usage: status [--check]  — show pairing, watchdog, and delivery health");
    process.exit(0);
  }
  process.exit(await statusCmd());
}
export {
  statusCmd,
  parseCodexPluginState,
  humanAge,
  hooksAppearStale,
  countCodexHookEvents
};
