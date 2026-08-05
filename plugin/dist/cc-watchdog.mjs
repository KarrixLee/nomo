import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/entries/cc-watchdog.ts
import { readdir as readdir4, readFile as readFile8, unlink as unlink4 } from "node:fs/promises";
import { readFileSync as readFileSync2, statSync as statSync3, unlinkSync } from "node:fs";
import { hostname as hostname4 } from "node:os";
import { basename as basename5 } from "node:path";

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
var PLUGIN_VERSION = "1.7.9";
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
var CODEX_BRIDGE_DOWN_MARKER = "cxbridge:down";
function appendCodexBridgeMarker(dbg, down) {
  if (typeof dbg !== "string" || dbg.length === 0)
    return dbg;
  const bare = dbg.split(` ${CODEX_BRIDGE_DOWN_MARKER}`).join("");
  if (!down)
    return bare;
  const next = `${bare} ${CODEX_BRIDGE_DOWN_MARKER}`;
  return Array.from(next).length <= DBG_BLOB_TEXT_MAX_CHARS ? next : bare;
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
var CODEX_DAEMON_START_ARGS = ["app-server", "daemon", "start"];
var CODEX_DAEMON_START_TIMEOUT_MS = 8000;
var CODEX_DAEMON_SOCKET_WAIT_MS = 4000;
var CODEX_DAEMON_SOCKET_POLL_MS = 250;
async function startCodexAppServerDaemon(deps = {}) {
  const trace = deps.trace ?? ((event) => traceSession(event));
  const probe = deps.probe ?? (() => codexAppServerSocketAvailable());
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const command = deps.codexPath ?? "codex";
  const timeoutMs = deps.timeoutMs ?? CODEX_DAEMON_START_TIMEOUT_MS;
  const socketWaitMs = deps.socketWaitMs ?? CODEX_DAEMON_SOCKET_WAIT_MS;
  const spawnFn = deps.spawnFn ?? ((cmd, args) => spawn(cmd, [...args], { stdio: "ignore" }));
  let exit;
  try {
    exit = await new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled)
          return;
        settled = true;
        resolve(value);
      };
      let child;
      try {
        child = spawnFn(command, CODEX_DAEMON_START_ARGS);
      } catch {
        done("error");
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {}
        done("timeout");
      }, timeoutMs);
      timer.unref?.();
      child.on("error", () => {
        clearTimeout(timer);
        done("error");
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        done({ code, signal });
      });
    });
  } catch {
    exit = "error";
  }
  if (exit === "error" || exit === "timeout" || exit.code !== 0) {
    trace({
      event: "codex-daemon-start",
      outcome: exit === "error" ? "spawn-failed" : exit === "timeout" ? "timeout" : "nonzero-exit",
      ...typeof exit === "object" ? { code: exit.code, signal: exit.signal } : {}
    });
    return false;
  }
  const deadline = socketWaitMs;
  for (let waited = 0;; waited += CODEX_DAEMON_SOCKET_POLL_MS) {
    let up = false;
    try {
      up = await probe();
    } catch {
      up = false;
    }
    if (up) {
      trace({ event: "codex-daemon-start", outcome: "started", waitedMs: waited });
      return true;
    }
    if (waited >= deadline)
      break;
    await sleep(CODEX_DAEMON_SOCKET_POLL_MS);
  }
  trace({ event: "codex-daemon-start", outcome: "no-socket", waitedMs: deadline });
  return false;
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

// src/core/codex-app-server-client.ts
var DEFAULT_RECONNECT_DELAY_MS = 1000;
var DEFAULT_MAX_RECONNECT_DELAY_MS = 300000;
var DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
var DEFAULT_REQUEST_TIMEOUT_MS = 1e4;
var defaultSetTimer = (callback, delayMs) => {
  const token = setTimeout(callback, delayMs);
  if (typeof token === "object" && token !== null && "unref" in token) {
    token.unref();
  }
  return token;
};
var defaultClearTimer = (token) => clearTimeout(token);
function rpcIdKey(id) {
  return `${typeof id}:${String(id)}`;
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
function parseRequestId(value) {
  return typeof value === "string" || typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function parseThreadStatus(value) {
  const status = asRecord(value);
  if (!status || typeof status.type !== "string")
    return;
  if (status.type === "notLoaded" || status.type === "idle" || status.type === "systemError") {
    return { type: status.type };
  }
  if (status.type !== "active" || !Array.isArray(status.activeFlags))
    return;
  const activeFlags = [];
  for (const flag of status.activeFlags) {
    if (flag !== "waitingOnApproval" && flag !== "waitingOnUserInput")
      return;
    activeFlags.push(flag);
  }
  return { type: "active", activeFlags };
}
function parseQuestion(value) {
  const q = asRecord(value);
  if (!q || typeof q.id !== "string" || q.id.length === 0 || typeof q.header !== "string" || typeof q.question !== "string" || q.question.length === 0 || typeof q.isOther !== "boolean" || typeof q.isSecret !== "boolean")
    return;
  let options = null;
  if (q.options !== null && q.options !== undefined) {
    if (!Array.isArray(q.options))
      return;
    options = [];
    for (const raw of q.options) {
      const option = asRecord(raw);
      if (!option || typeof option.label !== "string" || option.label.length === 0 || typeof option.description !== "string")
        return;
      options.push({ label: option.label, description: option.description });
    }
    if (options.length === 0)
      return;
  }
  return {
    id: q.id,
    header: q.header,
    question: q.question,
    isOther: q.isOther,
    isSecret: q.isSecret,
    options
  };
}
function parseUserInputParams(value) {
  const params = asRecord(value);
  if (!params || typeof params.threadId !== "string" || params.threadId.length === 0 || typeof params.turnId !== "string" || params.turnId.length === 0 || typeof params.itemId !== "string" || params.itemId.length === 0 || !Array.isArray(params.questions) || params.questions.length === 0)
    return;
  const questions = [];
  const ids = new Set;
  for (const raw of params.questions) {
    const question = parseQuestion(raw);
    if (!question || ids.has(question.id))
      return;
    ids.add(question.id);
    questions.push(question);
  }
  const autoResolutionMs = params.autoResolutionMs === null || params.autoResolutionMs === undefined ? null : typeof params.autoResolutionMs === "number" && Number.isFinite(params.autoResolutionMs) && params.autoResolutionMs >= 0 ? params.autoResolutionMs : undefined;
  if (autoResolutionMs === undefined)
    return;
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    questions,
    autoResolutionMs
  };
}
function identitiesEqual(a, b) {
  return a.connectionEpoch === b.connectionEpoch && a.requestId === b.requestId && a.threadId === b.threadId && a.turnId === b.turnId && a.itemId === b.itemId;
}
function validAnswers(request, answers) {
  const keys = Object.keys(answers);
  if (keys.length !== request.questions.length)
    return false;
  const known = new Set(request.questions.map((q) => q.id));
  if (keys.some((key) => !known.has(key)))
    return false;
  for (const question of request.questions) {
    const selected = answers[question.id];
    if (!Array.isArray(selected) || selected.length === 0 || selected.some((answer) => typeof answer !== "string" || answer.trim().length === 0))
      return false;
    if (question.options !== null && !question.isOther) {
      const labels = new Set(question.options.map((option) => option.label));
      if (selected.some((answer) => !labels.has(answer)))
        return false;
    }
  }
  return true;
}

class CodexAppServerClient {
  options;
  stateValue = "stopped";
  shouldRun = false;
  connectionEpoch = 0;
  transport;
  reconnectTimer;
  reconnectAttempts = 0;
  nextRpcId = 1;
  pendingRpc = new Map;
  pendingUserInput = new Map;
  connectPromise;
  constructor(options) {
    this.options = {
      ...options,
      clientName: options.clientName ?? "nomo",
      clientTitle: options.clientTitle ?? "Nomo Remote Input",
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      maxReconnectAttempts: options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      now: options.now ?? Date.now,
      setTimer: options.setTimer ?? defaultSetTimer,
      clearTimer: options.clearTimer ?? defaultClearTimer
    };
  }
  get state() {
    return this.stateValue;
  }
  async start() {
    this.shouldRun = true;
    this.reconnectAttempts = 0;
    return this.connect();
  }
  async stop() {
    this.shouldRun = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer !== undefined) {
      this.options.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const transport = this.transport;
    this.disconnect(this.connectionEpoch, "connection-lost", false);
    this.connectionEpoch += 1;
    this.connectPromise = undefined;
    try {
      await transport?.close();
    } catch {}
    this.setState("stopped");
  }
  async listThreads(params = {}) {
    const result = asRecord(await this.request("thread/list", params));
    if (!result || !Array.isArray(result.data))
      throw new Error("Invalid thread/list response");
    const data = [];
    for (const value of result.data) {
      const thread = asRecord(value);
      if (!thread || typeof thread.id !== "string" || thread.id.length === 0) {
        throw new Error("Invalid thread/list thread");
      }
      data.push(thread);
    }
    return { ...result, data };
  }
  async listLoadedThreads(params = {}) {
    const result = asRecord(await this.request("thread/loaded/list", params));
    if (!result || !Array.isArray(result.data) || result.data.some((id) => typeof id !== "string" || id.length === 0) || !(result.nextCursor === null || typeof result.nextCursor === "string")) {
      throw new Error("Invalid thread/loaded/list response");
    }
    return { data: [...result.data], nextCursor: result.nextCursor };
  }
  async resumeThread(threadId, params = {}) {
    if (threadId.length === 0)
      throw new Error("threadId is required");
    const result = asRecord(await this.request("thread/resume", { ...params, threadId }));
    const thread = asRecord(result?.thread);
    if (!result || !thread || thread.id !== threadId)
      throw new Error("Invalid thread/resume response");
    return { ...result, thread };
  }
  async readThreadStatus(threadId) {
    if (threadId.length === 0)
      throw new Error("threadId is required");
    const result = asRecord(await this.request("thread/read", { threadId, includeTurns: false }));
    const thread = asRecord(result?.thread);
    const status = parseThreadStatus(thread?.status);
    if (!result || !thread || thread.id !== threadId || !status) {
      throw new Error("Invalid thread/read response");
    }
    return status;
  }
  async answerUserInput(identity, answers) {
    const key = rpcIdKey(identity.requestId);
    const pending = this.pendingUserInput.get(key);
    if (!pending || !identitiesEqual(pending.request.identity, identity))
      return "stale";
    if (pending.responseSent || pending.interruptConfirmed || pending.interruptInFlight)
      return "already-sent";
    if (!validAnswers(pending.request, answers))
      return "invalid";
    if (this.stateValue !== "ready" || identity.connectionEpoch !== this.connectionEpoch || !this.transport)
      return "stale";
    pending.responseSent = true;
    const wireAnswers = {};
    for (const question of pending.request.questions) {
      wireAnswers[question.id] = { answers: [...answers[question.id]] };
    }
    try {
      await this.transport.send({ id: identity.requestId, result: { answers: wireAnswers } });
      return "sent";
    } catch (error) {
      this.reportError(error, "Failed to answer Codex user input");
      this.disconnect(this.connectionEpoch, "connection-lost", true);
      return "transport-error";
    }
  }
  async interruptUserInput(identity) {
    const key = rpcIdKey(identity.requestId);
    const pending = this.pendingUserInput.get(key);
    if (!pending || !identitiesEqual(pending.request.identity, identity))
      return "stale";
    if (pending.responseSent || pending.interruptConfirmed || pending.interruptInFlight)
      return "already-sent";
    if (this.stateValue !== "ready" || identity.connectionEpoch !== this.connectionEpoch || !this.transport) {
      return "stale";
    }
    pending.interruptAttempted = true;
    pending.interruptInFlight = true;
    try {
      await this.request("turn/interrupt", {
        threadId: identity.threadId,
        turnId: identity.turnId
      });
      pending.interruptInFlight = false;
      pending.interruptConfirmed = true;
      return "sent";
    } catch (error) {
      pending.interruptInFlight = false;
      this.reportError(error, "Failed to interrupt Codex user input");
      return "transport-error";
    }
  }
  connect() {
    if (!this.shouldRun)
      return Promise.resolve(false);
    if (this.stateValue === "ready")
      return Promise.resolve(true);
    if (this.connectPromise)
      return this.connectPromise;
    const attempt = this.connectOnce().finally(() => {
      if (this.connectPromise === attempt)
        this.connectPromise = undefined;
    });
    this.connectPromise = attempt;
    return attempt;
  }
  async connectOnce() {
    this.setState("connecting");
    const epoch = ++this.connectionEpoch;
    const transport = this.options.transportFactory();
    this.transport = transport;
    try {
      await transport.open({
        onMessage: (message) => this.onMessage(epoch, message),
        onClose: (error) => {
          if (error !== undefined)
            this.reportError(error, "Codex app-server transport closed");
          this.disconnect(epoch, "connection-lost", true);
        }
      });
      if (epoch !== this.connectionEpoch || this.transport !== transport || !this.shouldRun) {
        await this.abandon(transport);
        return false;
      }
      await this.request("initialize", {
        clientInfo: {
          name: this.options.clientName,
          title: this.options.clientTitle,
          version: this.options.clientVersion
        },
        capabilities: { experimentalApi: true, requestAttestation: false }
      }, true);
      if (epoch !== this.connectionEpoch || this.transport !== transport || !this.shouldRun) {
        await this.abandon(transport);
        return false;
      }
      await transport.send({ method: "initialized" });
      this.reconnectAttempts = 0;
      this.setState("ready");
      return true;
    } catch (error) {
      this.reportError(error, "Failed to initialize Codex app-server");
      this.disconnect(epoch, "connection-lost", true);
      try {
        await transport.close();
      } catch {}
      return false;
    }
  }
  request(method, params, duringInitialize = false) {
    if (!this.transport || !duringInitialize && this.stateValue !== "ready") {
      return Promise.reject(new Error("Codex app-server is not ready"));
    }
    const id = this.nextRpcId++;
    const key = rpcIdKey(id);
    return new Promise((resolve, reject) => {
      const timer = this.options.setTimer(() => {
        this.pendingRpc.delete(key);
        reject(new Error(`${method} timed out`));
      }, this.options.requestTimeoutMs);
      this.pendingRpc.set(key, { resolve, reject, timer });
      this.transport.send({ method, id, params }).catch((error) => {
        const pending = this.pendingRpc.get(key);
        if (!pending)
          return;
        this.pendingRpc.delete(key);
        this.options.clearTimer(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
  onMessage(epoch, message) {
    if (epoch !== this.connectionEpoch)
      return;
    const envelope = asRecord(message);
    if (!envelope) {
      this.reportError(new Error("Non-object JSON-RPC message"));
      return;
    }
    const id = parseRequestId(envelope.id);
    if (typeof envelope.method === "string") {
      if (envelope.method === "item/tool/requestUserInput" && id !== undefined) {
        this.onUserInputRequest(epoch, id, envelope.params);
      } else if (envelope.method === "serverRequest/resolved" && id === undefined) {
        this.onServerRequestResolved(envelope.params);
      }
      return;
    }
    if (id === undefined)
      return;
    const key = rpcIdKey(id);
    const pending = this.pendingRpc.get(key);
    if (!pending)
      return;
    this.pendingRpc.delete(key);
    this.options.clearTimer(pending.timer);
    const error = asRecord(envelope.error);
    if (error && typeof error.code === "number" && typeof error.message === "string") {
      const rpcError = error;
      pending.reject(new Error(`Codex RPC ${rpcError.code}: ${rpcError.message}`));
    } else if ("result" in envelope) {
      pending.resolve(envelope.result);
    } else {
      pending.reject(new Error("Malformed Codex RPC response"));
    }
  }
  onUserInputRequest(epoch, id, rawParams) {
    if (this.stateValue !== "ready") {
      this.reportError(new Error("Dropped item/tool/requestUserInput before the connection was ready"));
      return;
    }
    const parsed = parseUserInputParams(rawParams);
    if (!parsed) {
      this.reportError(new Error("Invalid item/tool/requestUserInput payload"));
      return;
    }
    const key = rpcIdKey(id);
    const existing = this.pendingUserInput.get(key);
    if (existing) {
      if (existing.responseSent || existing.interruptAttempted) {
        this.resolvePending(key, existing, existing.responseSent ? "response-sent" : "interrupt-sent");
      } else {
        this.reportError(new Error("Duplicate app-server request id"));
        return;
      }
    }
    const request = {
      identity: {
        connectionEpoch: epoch,
        requestId: id,
        threadId: parsed.threadId,
        turnId: parsed.turnId,
        itemId: parsed.itemId
      },
      questions: parsed.questions,
      autoResolutionMs: parsed.autoResolutionMs,
      receivedAtMs: this.options.now()
    };
    const entry = {
      request,
      responseSent: false,
      interruptAttempted: false,
      interruptConfirmed: false,
      interruptInFlight: false,
      expiryTimer: undefined
    };
    this.pendingUserInput.set(key, entry);
    this.armAutoResolution(key, entry);
    this.options.onUserInputRequest?.(request);
  }
  armAutoResolution(key, entry) {
    const timeoutMs = entry.request.autoResolutionMs;
    if (timeoutMs === null)
      return;
    entry.expiryTimer = this.options.setTimer(() => {
      entry.expiryTimer = undefined;
      if (this.pendingUserInput.get(key) !== entry)
        return;
      this.resolvePending(key, entry, this.attributionOf(entry));
    }, timeoutMs);
  }
  attributionOf(pending) {
    return pending.responseSent ? "response-sent" : pending.interruptAttempted ? "interrupt-sent" : "server-cleared";
  }
  resolvePending(key, pending, resolution) {
    this.pendingUserInput.delete(key);
    if (pending.expiryTimer !== undefined) {
      this.options.clearTimer(pending.expiryTimer);
      pending.expiryTimer = undefined;
    }
    this.options.onUserInputResolved?.(pending.request, resolution);
  }
  onServerRequestResolved(rawParams) {
    const params = asRecord(rawParams);
    const id = parseRequestId(params?.requestId);
    if (!params || id === undefined || typeof params.threadId !== "string")
      return;
    const key = rpcIdKey(id);
    const pending = this.pendingUserInput.get(key);
    if (!pending)
      return;
    if (pending.request.identity.threadId !== params.threadId) {
      this.reportError(new Error("serverRequest/resolved identity mismatch"));
      return;
    }
    this.resolvePending(key, pending, this.attributionOf(pending));
  }
  async abandon(transport) {
    if (this.transport === transport)
      this.transport = undefined;
    try {
      await transport.close();
    } catch {}
  }
  disconnect(epoch, resolution, reconnect) {
    if (epoch !== this.connectionEpoch)
      return;
    this.transport = undefined;
    for (const pending of this.pendingRpc.values()) {
      this.options.clearTimer(pending.timer);
      pending.reject(new Error("Codex app-server disconnected"));
    }
    this.pendingRpc.clear();
    const pendingInput = [...this.pendingUserInput.entries()];
    this.pendingUserInput.clear();
    for (const [, pending] of pendingInput) {
      if (pending.expiryTimer !== undefined) {
        this.options.clearTimer(pending.expiryTimer);
        pending.expiryTimer = undefined;
      }
      this.options.onUserInputResolved?.(pending.request, resolution);
    }
    if (this.shouldRun) {
      this.setState("disconnected");
      if (reconnect)
        this.scheduleReconnect();
    }
  }
  scheduleReconnect() {
    if (this.reconnectTimer !== undefined)
      return;
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.shouldRun = false;
      this.reportError(new Error(`Codex app-server reconnect gave up after ${this.reconnectAttempts} consecutive failures`));
      this.setState("stopped");
      return;
    }
    const delayMs = Math.min(this.options.reconnectDelayMs * 2 ** this.reconnectAttempts, this.options.maxReconnectDelayMs);
    this.reconnectAttempts += 1;
    this.reconnectTimer = this.options.setTimer(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((error) => this.reportError(error, "Codex app-server reconnect failed"));
    }, delayMs);
  }
  setState(state) {
    if (this.stateValue === state)
      return;
    this.stateValue = state;
    this.options.onStateChange?.(state);
  }
  reportError(error, fallback = "Codex app-server client error") {
    this.options.onError?.(error instanceof Error ? error : new Error(`${fallback}: ${String(error)}`));
  }
}

// src/core/codex-proxy-transport.ts
import { spawn as spawn2 } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
var WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
var DEFAULT_MAX_BUFFER_BYTES = 1 << 20;
var DEFAULT_MAX_HANDSHAKE_BYTES = 16 << 10;
var MAX_FRAME_HEADER_BYTES = 10;
function defaultSpawnProxy(command, args) {
  return spawn2(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
}
function asError(value, fallback) {
  return value instanceof Error ? value : new Error(value === undefined ? fallback : String(value));
}
function websocketAccept(key) {
  return createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
}
function parseUpgradeResponse(raw, key) {
  const text = raw.toString("latin1");
  const lines = text.split(`\r
`);
  if (!/^HTTP\/1\.[01] 101(?:\s|$)/i.test(lines[0] ?? "")) {
    throw new Error(`Codex app-server websocket upgrade failed: ${lines[0] || "empty response"}`);
  }
  const headers = new Map;
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0)
      continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const values = headers.get(name) ?? [];
    values.push(value);
    headers.set(name, values);
  }
  const tokens = (name) => (headers.get(name) ?? []).flatMap((value) => value.split(",")).map((value) => value.trim().toLowerCase());
  if (!tokens("upgrade").includes("websocket") || !tokens("connection").includes("upgrade")) {
    throw new Error("Codex app-server returned an invalid websocket upgrade response");
  }
  if ((headers.get("sec-websocket-accept") ?? [])[0] !== websocketAccept(key)) {
    throw new Error("Codex app-server returned an invalid Sec-WebSocket-Accept header");
  }
}
function encodeClientFrame(opcode, payload, random) {
  if (payload.byteLength > Number.MAX_SAFE_INTEGER)
    throw new Error("Websocket payload is too large");
  const extended = payload.byteLength < 126 ? 0 : payload.byteLength <= 65535 ? 2 : 8;
  const frame = Buffer.allocUnsafe(2 + extended + 4 + payload.byteLength);
  frame[0] = 128 | opcode;
  if (extended === 0)
    frame[1] = 128 | payload.byteLength;
  else if (extended === 2) {
    frame[1] = 128 | 126;
    frame.writeUInt16BE(payload.byteLength, 2);
  } else {
    frame[1] = 128 | 127;
    frame.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }
  const maskOffset = 2 + extended;
  const mask = Buffer.from(random(4));
  if (mask.byteLength !== 4)
    throw new Error("randomBytes must return the requested byte count");
  mask.copy(frame, maskOffset);
  const payloadOffset = maskOffset + 4;
  for (let index = 0;index < payload.byteLength; index++) {
    frame[payloadOffset + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

class CodexProxyTransport {
  options;
  child;
  handlers;
  buffer = Buffer.alloc(0);
  handshakeKey = "";
  upgraded = false;
  closing = false;
  ended = false;
  fragmented;
  fragmentedBytes = 0;
  openResolve;
  openReject;
  stderrTail = "";
  constructor(options = {}) {
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    const maxHandshakeBytes = options.maxHandshakeBytes ?? DEFAULT_MAX_HANDSHAKE_BYTES;
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1)
      throw new Error("maxBufferBytes must be positive");
    if (!Number.isSafeInteger(maxHandshakeBytes) || maxHandshakeBytes < 1)
      throw new Error("maxHandshakeBytes must be positive");
    this.options = {
      codexPath: options.codexPath ?? "codex",
      socketPath: options.socketPath,
      maxBufferBytes,
      maxHandshakeBytes,
      spawnProxy: options.spawnProxy ?? defaultSpawnProxy,
      randomBytes: options.randomBytes ?? randomBytes
    };
  }
  open(handlers) {
    if (this.child || this.openResolve || this.upgraded || this.ended) {
      return Promise.reject(new Error("Codex proxy transport has already been opened"));
    }
    this.handlers = handlers;
    const args = ["app-server", "proxy"];
    if (this.options.socketPath)
      args.push("--sock", this.options.socketPath);
    try {
      this.child = this.options.spawnProxy(this.options.codexPath, args);
    } catch (error) {
      return Promise.reject(asError(error, "Failed to spawn Codex app-server proxy"));
    }
    const child = this.child;
    child.stdout.on("data", this.onStdoutData);
    child.stdout.on("end", this.onStdoutEnd);
    child.stdout.on("error", this.onStreamError);
    child.stdin.on("error", this.onStreamError);
    child.stderr?.on("data", this.onStderrData);
    child.stderr?.on("error", this.onStderrError);
    child.on("error", this.onChildError);
    child.on("exit", this.onChildExit);
    let keyBytes;
    try {
      keyBytes = this.options.randomBytes(16);
      if (keyBytes.byteLength !== 16)
        throw new Error("randomBytes must return the requested byte count");
    } catch (error) {
      this.finish(asError(error, "Could not create websocket key"));
      return Promise.reject(asError(error, "Could not create websocket key"));
    }
    this.handshakeKey = Buffer.from(keyBytes).toString("base64");
    const request = [
      "GET / HTTP/1.1",
      "Host: localhost",
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${this.handshakeKey}`,
      "",
      ""
    ].join(`\r
`);
    return new Promise((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
      this.writeRaw(request).catch((error) => this.finish(error));
    });
  }
  async send(message) {
    if (!this.upgraded || this.closing || this.ended)
      throw new Error("Codex proxy transport is not open");
    let encoded;
    try {
      encoded = Buffer.from(JSON.stringify(message), "utf8");
    } catch (error) {
      throw asError(error, "Could not encode Codex RPC message");
    }
    if (encoded.byteLength > this.options.maxBufferBytes)
      throw new Error("Codex RPC message exceeds transport limit");
    await this.writeFrame(1, encoded);
  }
  async close() {
    if (this.ended || this.closing)
      return;
    this.closing = true;
    if (this.upgraded) {
      try {
        await this.writeFrame(8, Buffer.alloc(0));
      } catch {}
    }
    this.finish();
  }
  onStdoutData = (chunk) => {
    if (this.ended || this.closing)
      return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const receiveLimit = this.upgraded ? this.options.maxBufferBytes + MAX_FRAME_HEADER_BYTES : this.options.maxHandshakeBytes + this.options.maxBufferBytes + MAX_FRAME_HEADER_BYTES;
    if (this.buffer.byteLength + incoming.byteLength > receiveLimit) {
      this.finish(new Error("Codex proxy transport receive buffer exceeded its limit"));
      return;
    }
    this.buffer = this.buffer.byteLength === 0 ? Buffer.from(incoming) : Buffer.concat([this.buffer, incoming]);
    try {
      if (!this.upgraded && !this.consumeHandshake())
        return;
      this.consumeFrames();
    } catch (error) {
      this.finish(asError(error, "Invalid Codex app-server websocket data"));
    }
  };
  onStdoutEnd = () => this.finish(new Error("Codex app-server proxy stdout ended"));
  onStreamError = (error) => this.finish(asError(error, "Codex app-server proxy stream failed"));
  onStderrError = () => {};
  onStderrData = (chunk) => {
    this.stderrTail = (this.stderrTail + Buffer.from(chunk).toString("utf8")).slice(-4096);
  };
  onChildError = (error) => this.finish(asError(error, "Codex app-server proxy failed"));
  onChildExit = (code, signal) => {
    const suffix = this.stderrTail.trim();
    const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    this.finish(new Error(`Codex app-server proxy exited with ${detail}${suffix ? `: ${suffix}` : ""}`));
  };
  consumeHandshake() {
    const boundary = this.buffer.indexOf(`\r
\r
`);
    if (boundary < 0) {
      if (this.buffer.byteLength > this.options.maxHandshakeBytes)
        throw new Error("Codex websocket handshake exceeded its limit");
      return false;
    }
    const end = boundary + 4;
    if (end > this.options.maxHandshakeBytes)
      throw new Error("Codex websocket handshake exceeded its limit");
    parseUpgradeResponse(this.buffer.subarray(0, end), this.handshakeKey);
    this.buffer = this.buffer.subarray(end);
    this.upgraded = true;
    const resolve = this.openResolve;
    this.openResolve = undefined;
    this.openReject = undefined;
    resolve?.();
    return true;
  }
  consumeFrames() {
    while (this.buffer.byteLength >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 128) !== 0;
      const opcode = first & 15;
      if ((first & 112) !== 0)
        throw new Error("Unsupported websocket extension bits");
      if ((second & 128) !== 0)
        throw new Error("Codex app-server sent a masked websocket frame");
      let offset = 2;
      let length = second & 127;
      if (length === 126) {
        if (this.buffer.byteLength < 4)
          return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.byteLength < 10)
          return;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(this.options.maxBufferBytes))
          throw new Error("Websocket frame exceeds transport limit");
        length = Number(longLength);
        offset = 10;
      }
      if (length > this.options.maxBufferBytes)
        throw new Error("Websocket frame exceeds transport limit");
      const control = opcode >= 8;
      if (control && (!fin || length > 125))
        throw new Error("Invalid websocket control frame");
      if (this.buffer.byteLength < offset + length)
        return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      this.onFrame(fin, opcode, payload);
      if (this.ended)
        return;
    }
  }
  onFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0:
        if (!this.fragmented)
          throw new Error("Unexpected websocket continuation frame");
        this.appendFragment(payload);
        if (fin)
          this.finishTextMessage();
        return;
      case 1:
        if (this.fragmented)
          throw new Error("New websocket data frame before fragmented message finished");
        if (fin)
          this.deliverText(payload);
        else {
          this.fragmented = [];
          this.fragmentedBytes = 0;
          this.appendFragment(payload);
        }
        return;
      case 2:
        throw new Error("Codex app-server sent an unsupported binary websocket frame");
      case 8:
        if (payload.byteLength === 1)
          throw new Error("Invalid websocket close payload");
        this.closing = true;
        this.writeFrame(8, payload).catch(() => {
          return;
        }).finally(() => this.finish()).catch(() => {
          return;
        });
        return;
      case 9:
        this.writeFrame(10, payload).catch((error) => this.finish(error)).catch(() => {
          return;
        });
        return;
      case 10:
        return;
      default:
        throw new Error(`Unsupported websocket opcode ${opcode}`);
    }
  }
  appendFragment(payload) {
    this.fragmentedBytes += payload.byteLength;
    if (this.fragmentedBytes > this.options.maxBufferBytes)
      throw new Error("Websocket message exceeds transport limit");
    this.fragmented.push(payload);
  }
  finishTextMessage() {
    const payload = Buffer.concat(this.fragmented ?? [], this.fragmentedBytes);
    this.fragmented = undefined;
    this.fragmentedBytes = 0;
    this.deliverText(payload);
  }
  deliverText(payload) {
    if (payload.byteLength > this.options.maxBufferBytes)
      throw new Error("Websocket message exceeds transport limit");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    } catch {
      throw new Error("Codex app-server sent invalid UTF-8");
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      throw new Error("Codex app-server sent invalid JSON");
    }
    this.handlers?.onMessage(message);
  }
  writeFrame(opcode, payload) {
    return this.writeRaw(encodeClientFrame(opcode, payload, this.options.randomBytes));
  }
  writeRaw(chunk) {
    const child = this.child;
    if (!child || this.ended)
      return Promise.reject(new Error("Codex proxy transport is closed"));
    return new Promise((resolve, reject) => {
      try {
        child.stdin.write(chunk, (error) => error ? reject(error) : resolve());
      } catch (error) {
        reject(asError(error, "Could not write to Codex app-server proxy"));
      }
    });
  }
  finish(error) {
    if (this.ended)
      return;
    this.ended = true;
    this.closing = false;
    const child = this.child;
    this.child = undefined;
    if (child) {
      child.stdout.removeListener("data", this.onStdoutData);
      child.stdout.removeListener("end", this.onStdoutEnd);
      child.stdout.removeListener("error", this.onStreamError);
      child.stdin.removeListener("error", this.onStreamError);
      child.stderr?.removeListener("data", this.onStderrData);
      child.stderr?.removeListener("error", this.onStderrError);
      child.removeListener("error", this.onChildError);
      child.removeListener("exit", this.onChildExit);
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill();
      } catch {}
    }
    const reject = this.openReject;
    const wasOpening = reject !== undefined;
    this.openResolve = undefined;
    this.openReject = undefined;
    if (wasOpening)
      reject(error ?? new Error("Codex proxy transport closed during websocket upgrade"));
    else if (this.upgraded)
      this.handlers?.onClose(error);
    this.upgraded = false;
    this.buffer = Buffer.alloc(0);
    this.fragmented = undefined;
    this.fragmentedBytes = 0;
  }
}

// src/core/codex-remote-input.ts
import { hostname as hostname3 } from "node:os";

// src/core/lan-listener.ts
import { createServer } from "node:http";
import { readFile as readFile4 } from "node:fs/promises";
import { networkInterfaces } from "node:os";

// src/core/lan-frames.ts
import { execFile as execFile3 } from "node:child_process";
import { watch } from "node:fs";
import { readdir as readdir2, readFile as readFile3 } from "node:fs/promises";
import { basename as basename2 } from "node:path";
import { promisify as promisify3 } from "node:util";

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

// src/core/session-state.ts
var SESSION_STATE_STALE_MS = 86400000;
var STATE_HOLD_MAX_AGE_MS = 600000;
var CC_STATUS_MAX_AGE_MS = 600000;
var CC_STATUS_FUTURE_SKEW_MS = 5000;
var CC_PROC_START_TOLERANCE_MS = 5000;
var CC_IDLE_DONE_GRACE_MS = 3000;
var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function parseCcProcStart(value) {
  if (typeof value !== "string")
    return;
  const m = /^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(value);
  if (!m)
    return;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0)
    return;
  const day = Number(m[2]);
  const utc = Date.UTC(Number(m[6]), month, day, Number(m[3]), Number(m[4]), Number(m[5]));
  if (!Number.isFinite(utc))
    return;
  return new Date(utc).getUTCDate() === day ? utc : undefined;
}
function parseCcSessionFile(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const f = parsed;
  if (typeof f.pid !== "number" || !Number.isFinite(f.pid))
    return null;
  if (typeof f.sessionId !== "string" || f.sessionId.length === 0)
    return null;
  const str = (key) => typeof f[key] === "string" && f[key].length > 0 ? f[key] : undefined;
  const num = (key) => typeof f[key] === "number" && Number.isFinite(f[key]) ? f[key] : undefined;
  return {
    pid: f.pid,
    sessionId: f.sessionId,
    ...str("cwd") ? { cwd: str("cwd") } : {},
    ...num("startedAt") !== undefined ? { startedAt: num("startedAt") } : {},
    ...str("procStart") ? { procStart: str("procStart") } : {},
    ...str("version") ? { version: str("version") } : {},
    ...str("kind") ? { kind: str("kind") } : {},
    ...str("entrypoint") ? { entrypoint: str("entrypoint") } : {},
    ...str("name") ? { name: str("name") } : {},
    ...str("nameSource") ? { nameSource: str("nameSource") } : {},
    ...str("status") ? { status: str("status") } : {},
    ...num("updatedAt") !== undefined ? { updatedAt: num("updatedAt") } : {},
    ...num("statusUpdatedAt") !== undefined ? { statusUpdatedAt: num("statusUpdatedAt") } : {}
  };
}
function ccOpinion(file, join3, now) {
  if (!file)
    return null;
  if (typeof join3.pid !== "number" || !Number.isFinite(join3.pid) || file.pid !== join3.pid)
    return null;
  if (file.sessionId !== join3.sessionId)
    return null;
  const probed = join3.procStartedAt;
  if (typeof probed !== "number" || !Number.isFinite(probed))
    return null;
  const claimed = typeof file.startedAt === "number" && Number.isFinite(file.startedAt) ? file.startedAt : parseCcProcStart(file.procStart);
  if (typeof claimed !== "number")
    return null;
  if (Math.abs(claimed - probed) > CC_PROC_START_TOLERANCE_MS)
    return null;
  if (file.status !== "busy" && file.status !== "idle")
    return null;
  const at = file.statusUpdatedAt;
  if (typeof at !== "number" || !Number.isFinite(at))
    return null;
  if (now - at >= CC_STATUS_MAX_AGE_MS)
    return null;
  if (at - now > CC_STATUS_FUTURE_SKEW_MS)
    return null;
  return {
    status: file.status,
    statusUpdatedAt: at,
    ...file.name && file.nameSource === "derived" ? { name: file.name } : {}
  };
}
var finite = (value) => typeof value === "number" && Number.isFinite(value);
var filled = (value) => typeof value === "string" && value.length > 0;
function buildStatePlaintext(record, status, at, titleFallback) {
  const agent = record.agent === "codex" ? "codex" : "claude";
  const base = {
    status,
    title: filled(record.title) ? record.title : filled(titleFallback) ? titleFallback : "",
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    ...adapterFor(agent).blobAgentFields,
    ...finite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {},
    ...filled(record.model) ? { model: record.model } : {},
    at: Math.floor(at / 1000)
  };
  const dbg = agent === "codex" ? formatPlanPickerDebug({
    event: status === "done" ? "done" : "working",
    classifier: status === "done" ? "done" : "resolved",
    marker: "0",
    by: "wd"
  }) : undefined;
  return appendFittedPlanAndDebug(base, undefined, dbg);
}
function stateHoldLive(hold, holdPidAlive, now) {
  if (!hold || !filled(hold.blob))
    return false;
  if (!finite(hold.at))
    return false;
  if (now - hold.at > STATE_HOLD_MAX_AGE_MS)
    return false;
  if (!finite(hold.pid) || holdPidAlive !== true)
    return false;
  return true;
}
function computeSessionState(input) {
  const { sessionId, record, pairingId, hold, pidAlive: pidAlive2, holdPidAlive, cc, ccProcStartedAt, correctives, now } = input;
  if (record === null) {
    return { state: "ended", terminal: true, ts: now, why: "reap", blob: { kind: "last" }, agent: "claude" };
  }
  if (!filled(record.blob))
    return null;
  if (pairingId === undefined || record.pairingId !== pairingId)
    return null;
  const agent = record.agent === "codex" ? "codex" : "claude";
  const ts = finite(record.ts) ? record.ts : now;
  const startedAt = finite(record.sessionStartedAt) ? { startedAt: record.sessionStartedAt } : {};
  const sealed = { kind: "sealed", value: record.blob };
  const asking = record.attentionKind === "userInput" ? { attentionKind: "userInput" } : {};
  const of = (state, why, blob, at, terminal = false) => ({ state, terminal, ts: at, why, blob, agent, ...startedAt });
  if (correctives?.ended === true)
    return of("ended", "end", sealed, ts, true);
  if (record.op === "end")
    return of("ended", "end", sealed, ts, true);
  if (finite(record.ts) && now - record.ts > SESSION_STATE_STALE_MS)
    return of("ended", "stale", sealed, ts, true);
  if (!pidAlive2)
    return of("ended", "reap", sealed, ts, true);
  const ccUsable = agent === "claude" && record.provisional !== true;
  const opinion = ccUsable ? ccOpinion(cc, { pid: record.pid, sessionId, procStartedAt: ccProcStartedAt }, now) : null;
  const suffix = (base) => agent === "codex" ? `${base}/cx` : base;
  const recordDone = correctives?.done === true || record.op === "done" || record.lastEvent === "done";
  if (recordDone) {
    const heldBack = opinion?.status === "busy" && opinion.statusUpdatedAt > ts;
    if (!heldBack) {
      return of("done", opinion?.status === "idle" ? "done+cc" : suffix("done"), { kind: "plain", value: buildStatePlaintext(record, "done", ts, opinion?.name) }, ts, false);
    }
  }
  if (stateHoldLive(hold, holdPidAlive, now)) {
    return {
      state: "decisionPending",
      terminal: false,
      ts,
      why: "hold",
      blob: { kind: "sealed", value: hold.blob },
      agent,
      ...startedAt,
      ...asking
    };
  }
  if (!recordDone && opinion?.status === "idle" && record.prio !== 1 && record.lastEvent !== "needsAttention" && opinion.statusUpdatedAt > ts + CC_IDLE_DONE_GRACE_MS) {
    return of("done", "done+cc", { kind: "plain", value: buildStatePlaintext(record, "done", opinion.statusUpdatedAt, opinion.name) }, ts, false);
  }
  if (record.prio === 1) {
    const why = finite(record.attentionStalledAt) ? "attn/net" : "attn";
    return { ...of("needsAttention", why, sealed, ts, false), ...asking };
  }
  const busy = opinion?.status === "busy" && opinion.statusUpdatedAt > ts;
  return of("working", busy ? "work+cc" : suffix("work"), recordDone ? { kind: "plain", value: buildStatePlaintext(record, "working", now, opinion?.name) } : sealed, ts, false);
}

// src/core/lan-frames.ts
var execFileP3 = promisify3(execFile3);
var LAN_FRAME_RETIRE_GRACE_MS = 60000;
var LAN_FRAMES_WATCH_DEBOUNCE_MS = 100;
var LAN_FRAMES_WAITERS_MAX = 4;
var LAN_FRAME_SESSION_STALE_MS = 86400000;
var LAN_HOLD_MAX_AGE_MS = 600000;
var LAN_STATE_SESSIONS_MAX = 20;
var CC_SESSIONS_DIR = `${process.env.HOME}/.claude/sessions`;
var CC_CAPABILITY_LATCH_SWEEPS = 5;
function lanFrameSessionLive(record, now, isAlive) {
  if (typeof record.retiredAt === "number" && Number.isFinite(record.retiredAt))
    return false;
  if (typeof record.pid !== "number" || !Number.isFinite(record.pid))
    return false;
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts))
    return false;
  if (now - record.ts > LAN_FRAME_SESSION_STALE_MS)
    return false;
  return isAlive(record.pid);
}
function lanFrameContent(record, pairingId, hold = null, now = Date.now(), isAlive = pidAlive) {
  if (typeof record.retiredAt === "number" && Number.isFinite(record.retiredAt))
    return null;
  if (typeof record.blob !== "string" || record.blob.length === 0)
    return null;
  if (pairingId === undefined || record.pairingId !== pairingId)
    return null;
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts))
    return null;
  if (lanHoldLive(hold, record, now, isAlive)) {
    return {
      op: "update",
      prio: 1,
      ts: Math.max(record.ts, hold.at),
      blob: hold.blob,
      ...record.agent === "codex" ? { agent: "codex" } : {},
      ...record.attentionKind === "userInput" ? { attentionKind: "userInput" } : {}
    };
  }
  const prio = record.prio === 1 ? 1 : 0;
  return {
    op: record.op ?? "update",
    prio,
    ts: record.ts,
    blob: record.blob,
    ...record.agent === "codex" ? { agent: "codex" } : {},
    ...prio === 1 && record.attentionKind === "userInput" ? { attentionKind: "userInput" } : {}
  };
}
function lanHoldLive(hold, record, now, isAlive) {
  if (!hold || typeof hold.blob !== "string" || hold.blob.length === 0)
    return false;
  if (typeof hold.at !== "number" || !Number.isFinite(hold.at))
    return false;
  if (now - hold.at > LAN_HOLD_MAX_AGE_MS)
    return false;
  if (typeof hold.pid !== "number" || !Number.isFinite(hold.pid) || !isAlive(hold.pid))
    return false;
  const suppressible = (record.op ?? "update") === "update" && record.prio === 1;
  return record.ts <= hold.at || suppressible;
}
function sameKey(a, b) {
  if (a === b)
    return true;
  if (!a || !b || a.length !== b.length)
    return false;
  for (let i = 0;i < a.length; i += 1) {
    if (a[i] !== b[i])
      return false;
  }
  return true;
}
async function defaultProcStartedAt(pid) {
  try {
    const { stdout } = await execFileP3("ps", ["-o", "lstart=", "-p", String(pid)]);
    const parsed = Date.parse(String(stdout).trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return;
  }
}
function defaultWatchDir(dir, onChange) {
  try {
    const watcher = watch(dir, { persistent: false }, () => onChange());
    try {
      watcher.on?.("error", () => {});
    } catch {}
    try {
      watcher.unref?.();
    } catch {}
    return watcher;
  } catch {
    return null;
  }
}
function createLanFrameStore(deps = {}) {
  const sessionsDir = deps.sessionsDir ?? (lanRunningUnderTest() ? undefined : SESSIONS_DIR);
  const isAlive = deps.isAlive ?? pidAlive;
  const now = deps.now ?? Date.now;
  const retireGraceMs = deps.retireGraceMs ?? LAN_FRAME_RETIRE_GRACE_MS;
  const debounceMs = deps.debounceMs ?? LAN_FRAMES_WATCH_DEBOUNCE_MS;
  const maxWaiters = deps.maxWaiters ?? LAN_FRAMES_WAITERS_MAX;
  const watchDir = deps.watchDir ?? defaultWatchDir;
  const ccSessionsDir = deps.ccSessionsDir ?? (lanRunningUnderTest() ? undefined : CC_SESSIONS_DIR);
  const procStartedAt = deps.procStartedAt ?? defaultProcStartedAt;
  const entries = new Map;
  const stateEntries = new Map;
  const waiters = new Set;
  const stateWaiters = new Set;
  let counter = 0;
  let stateCounter = 0;
  let completeFromSeq = 0;
  let pairingId;
  let e2eKey;
  let stopped = false;
  let watcher = null;
  let ccWatcher = null;
  let debounce;
  const procStartCache = new Map;
  const ccSeenPids = new Set;
  let ccMissStreak = 0;
  let ccLatchedOff = false;
  let chain = Promise.resolve();
  const drop = (waiter) => {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    waiters.delete(waiter);
    stateWaiters.delete(waiter);
    try {
      waiter.resolve();
    } catch {}
  };
  const wake = (set) => {
    for (const waiter of [...set])
      drop(waiter);
  };
  const park = async (set, waitMs) => {
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    const waiter = { resolve: settle };
    set.add(waiter);
    while (set.size > maxWaiters) {
      const oldest = set.values().next();
      if (oldest.done || oldest.value === waiter)
        break;
      drop(oldest.value);
    }
    const timer = setTimeout(() => drop(waiter), waitMs);
    timer.unref?.();
    waiter.timer = timer;
    await promise;
  };
  const stamp = (sessionId, content, retiredAt) => {
    const sig = `${retiredAt === undefined ? "live" : "term"}|${JSON.stringify(content)}`;
    const prev = entries.get(sessionId);
    if (prev && prev.sig === sig && prev.retiredAt === undefined === (retiredAt === undefined))
      return false;
    counter += 1;
    const ts = prev && content.ts <= prev.frame.ts ? prev.frame.ts + 1 : content.ts;
    entries.set(sessionId, {
      frame: { seq: counter, sessionId, ...content, ts },
      sig,
      ...retiredAt === undefined ? {} : { retiredAt }
    });
    return true;
  };
  const terminalContent = (frame, at) => ({
    op: "end",
    prio: 0,
    ts: at,
    blob: frame.blob,
    ...frame.agent ? { agent: frame.agent } : {}
  });
  const startOf = async (pid) => {
    if (typeof pid !== "number" || !Number.isFinite(pid))
      return;
    if (procStartCache.has(pid))
      return procStartCache.get(pid);
    let value;
    try {
      value = await procStartedAt(pid);
    } catch {
      value = undefined;
    }
    procStartCache.set(pid, value);
    return value;
  };
  const ccFileOf = async (pid) => {
    if (!ccSessionsDir || ccLatchedOff)
      return null;
    if (typeof pid !== "number" || !Number.isFinite(pid))
      return null;
    try {
      return parseCcSessionFile(await readFile3(`${ccSessionsDir}/${pid}.json`, "utf8"));
    } catch {
      return null;
    }
  };
  const commitState = async (sessionId, computed, at) => {
    const prev = stateEntries.get(sessionId);
    const blob = computed.blob;
    if (blob.kind === "last" && !prev)
      return false;
    const blobSig = blob.kind === "sealed" ? `s:${blob.value}` : blob.kind === "plain" ? `p:${JSON.stringify(blob.value)}` : `l:${prev.state.blob}`;
    const agent = blob.kind === "last" ? prev.state.agent : computed.agent === "codex" ? "codex" : undefined;
    const startedAt = blob.kind === "last" ? prev.state.startedAt : computed.startedAt;
    const asking = blob.kind === "last" ? undefined : computed.attentionKind;
    const sig = `${computed.terminal ? "term" : "live"}|${computed.ts}|${computed.why}|${agent ?? ""}` + `|${startedAt ?? ""}|${asking ?? ""}|${blobSig}`;
    if (prev && prev.sig === sig)
      return false;
    let sealed;
    if (blob.kind === "sealed") {
      sealed = blob.value;
    } else if (blob.kind === "last") {
      sealed = prev.state.blob;
    } else {
      if (!e2eKey)
        return false;
      try {
        sealed = await encryptBlob(e2eKey, blob.value);
      } catch {
        return false;
      }
    }
    stateCounter += 1;
    stateEntries.set(sessionId, {
      seq: stateCounter,
      state: {
        sessionId,
        ts: computed.ts,
        terminal: computed.terminal,
        blob: sealed,
        ...agent ? { agent } : {},
        ...startedAt !== undefined ? { startedAt } : {},
        ...asking ? { attentionKind: asking } : {},
        why: computed.why.slice(0, 16)
      },
      sig,
      ...computed.terminal ? { retiredAt: at } : {}
    });
    return true;
  };
  const reconcileOnce = async () => {
    if (!sessionsDir)
      return;
    const at = now();
    let files = [];
    try {
      files = await readdir2(sessionsDir);
    } catch {
      files = [];
    }
    let changed = false;
    let stateChanged = false;
    const seen = new Set;
    const aliveCache = new Map;
    const alive = (pid) => {
      const memo = aliveCache.get(pid);
      if (memo !== undefined)
        return memo;
      const value = isAlive(pid);
      aliveCache.set(pid, value);
      return value;
    };
    const held = new Set;
    for (const file of files) {
      if (file.endsWith(DECISION_HOLD_SUFFIX))
        held.add(file.slice(0, -DECISION_HOLD_SUFFIX.length));
    }
    let ccConsulted = false;
    let ccAnswered = false;
    let freshPid = false;
    const livePids = new Set;
    for (const file of files) {
      if (!file.endsWith(".json"))
        continue;
      const sessionId = basename2(file, ".json");
      seen.add(sessionId);
      const v1Retired = entries.get(sessionId)?.retiredAt !== undefined;
      const v2Retired = stateEntries.get(sessionId)?.retiredAt !== undefined;
      let record = null;
      try {
        record = JSON.parse(await readFile3(`${sessionsDir}/${file}`, "utf8"));
      } catch {
        continue;
      }
      if (record.agent === "codex" && typeof record.retiredAt === "number" && Number.isFinite(record.retiredAt)) {
        seen.delete(sessionId);
        continue;
      }
      let hold = null;
      if (held.has(sessionId)) {
        try {
          hold = JSON.parse(await readFile3(`${sessionsDir}/${decisionHoldFileName(sessionId)}`, "utf8"));
        } catch {
          hold = null;
        }
      }
      if (typeof record.pid === "number" && Number.isFinite(record.pid))
        livePids.add(record.pid);
      const v1LiveNow = lanFrameSessionLive(record, at, alive);
      if (!v1Retired || v1LiveNow) {
        const content = lanFrameContent(record, pairingId, hold, at, alive);
        if (content) {
          changed = v1LiveNow ? stamp(sessionId, content) || changed : stamp(sessionId, terminalContent({ seq: 0, sessionId, ...content }, at), at) || changed;
        }
      }
      {
        const askCc = record.agent !== "codex" && record.provisional !== true;
        let cc = null;
        let ccProcStartedAt;
        if (askCc && ccSessionsDir) {
          if (typeof record.pid === "number" && Number.isFinite(record.pid) && !ccSeenPids.has(record.pid)) {
            freshPid = true;
            ccSeenPids.add(record.pid);
          }
          if (!ccLatchedOff) {
            ccConsulted = true;
            cc = await ccFileOf(record.pid);
            if (cc?.status === "busy" || cc?.status === "idle")
              ccAnswered = true;
            ccProcStartedAt = await startOf(record.pid);
          }
        }
        const statePid = record.agent === "codex" && typeof record.tuiPid === "number" && Number.isFinite(record.tuiPid) ? record.tuiPid : record.pid;
        const computed = computeSessionState({
          sessionId,
          record,
          pairingId,
          hold,
          pidAlive: typeof statePid === "number" && Number.isFinite(statePid) ? alive(statePid) : false,
          holdPidAlive: hold && typeof hold.pid === "number" && Number.isFinite(hold.pid) ? alive(hold.pid) : false,
          cc,
          ccProcStartedAt,
          now: at
        });
        if (computed && (!v2Retired || !computed.terminal)) {
          stateChanged = await commitState(sessionId, computed, at) || stateChanged;
        }
      }
    }
    for (const [sessionId, entry] of [...entries]) {
      if (entry.retiredAt === undefined && !seen.has(sessionId)) {
        changed = stamp(sessionId, terminalContent(entry.frame, at), at) || changed;
        continue;
      }
      if (entry.retiredAt !== undefined && at - entry.retiredAt > retireGraceMs && !seen.has(sessionId)) {
        entries.delete(sessionId);
      }
    }
    for (const [sessionId, entry] of [...stateEntries]) {
      if (entry.retiredAt === undefined && !seen.has(sessionId)) {
        const gone = computeSessionState({ sessionId, record: null, pairingId, pidAlive: false, now: at });
        if (gone)
          stateChanged = await commitState(sessionId, gone, at) || stateChanged;
        continue;
      }
      if (entry.retiredAt !== undefined && at - entry.retiredAt > retireGraceMs && !seen.has(sessionId)) {
        stateEntries.delete(sessionId);
      }
    }
    if (freshPid) {
      ccMissStreak = 0;
      ccLatchedOff = false;
    } else if (ccConsulted) {
      ccMissStreak = ccAnswered ? 0 : ccMissStreak + 1;
      if (ccMissStreak >= CC_CAPABILITY_LATCH_SWEEPS)
        ccLatchedOff = true;
    }
    for (const pid of [...procStartCache.keys()]) {
      if (!livePids.has(pid))
        procStartCache.delete(pid);
    }
    for (const pid of [...ccSeenPids]) {
      if (!livePids.has(pid))
        ccSeenPids.delete(pid);
    }
    if (changed)
      wake(waiters);
    if (stateChanged)
      wake(stateWaiters);
  };
  const store = {
    seq() {
      return counter;
    },
    since(sinceSeq) {
      const from = !Number.isFinite(sinceSeq) || sinceSeq < 0 || sinceSeq > counter ? 0 : sinceSeq;
      const frames = [];
      const at = now();
      for (const entry of entries.values()) {
        if (entry.retiredAt !== undefined && at - entry.retiredAt > retireGraceMs)
          continue;
        if (entry.frame.seq > from)
          frames.push(entry.frame);
      }
      frames.sort((a, b) => a.seq - b.seq);
      return { seq: counter, frames };
    },
    async wait(sinceSeq, waitMs) {
      const immediate = store.since(sinceSeq);
      if (stopped || waitMs <= 0 || immediate.frames.length > 0)
        return immediate;
      await park(waiters, waitMs);
      return store.since(sinceSeq);
    },
    states(sinceSeq) {
      const from = !Number.isFinite(sinceSeq) || sinceSeq < 0 || sinceSeq > stateCounter ? 0 : sinceSeq;
      const complete = from === 0 || from <= completeFromSeq;
      const picked = [];
      const instant = now();
      for (const entry of stateEntries.values()) {
        if (entry.retiredAt !== undefined && instant - entry.retiredAt > retireGraceMs)
          continue;
        if (complete || entry.seq > from)
          picked.push(entry);
      }
      picked.sort((a, b) => a.seq - b.seq);
      const capped = picked.length <= LAN_STATE_SESSIONS_MAX ? picked : [...picked].sort((a, b) => b.state.ts - a.state.ts).slice(0, LAN_STATE_SESSIONS_MAX).sort((a, b) => a.seq - b.seq);
      return { seq: stateCounter, at: now(), complete, sessions: capped.map((entry) => entry.state) };
    },
    async waitStates(sinceSeq, waitMs) {
      const immediate = store.states(sinceSeq);
      if (stopped || waitMs <= 0 || immediate.sessions.length > 0 || immediate.complete && stateCounter > 0) {
        return immediate;
      }
      await park(stateWaiters, waitMs);
      return store.states(sinceSeq);
    },
    setPairing(next, key) {
      const rotated = next !== pairingId || e2eKey !== undefined && key !== undefined && !sameKey(e2eKey, key);
      pairingId = next;
      e2eKey = key;
      if (!rotated)
        return;
      entries.clear();
      stateEntries.clear();
      completeFromSeq = stateCounter;
      store.reconcile();
    },
    async readFull(sessionId, what) {
      try {
        if (!sessionsDir)
          return null;
        if (!LAN_SESSION_ID_RE.test(sessionId))
          return null;
        let record;
        try {
          record = JSON.parse(await readFile3(`${sessionsDir}/${sessionId}.json`, "utf8"));
        } catch {
          return null;
        }
        if (pairingId === undefined || record.pairingId !== pairingId)
          return null;
        if (typeof record.ts !== "number" || !Number.isFinite(record.ts))
          return null;
        if (now() - record.ts > LAN_FRAME_SESSION_STALE_MS)
          return null;
        const content = what === "plan" ? record.planFull : record.permissionDetailFull;
        if (typeof content !== "string" || content.length === 0)
          return null;
        return { content, complete: recordFullTextIsComplete(content) };
      } catch {
        return null;
      }
    },
    reconcile() {
      if (stopped)
        return Promise.resolve();
      chain = chain.then(async () => {
        if (stopped)
          return;
        try {
          await reconcileOnce();
        } catch {}
        if (!stopped && !watcher)
          store.start();
      }).catch(() => {});
      return chain;
    },
    start() {
      if (stopped)
        return;
      const bump = () => {
        if (stopped)
          return;
        if (debounce !== undefined)
          clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          store.reconcile();
        }, debounceMs);
        debounce.unref?.();
      };
      if (!watcher && sessionsDir)
        watcher = watchDir(sessionsDir, bump);
      if (!ccWatcher && ccSessionsDir)
        ccWatcher = watchDir(ccSessionsDir, bump);
    },
    stop() {
      stopped = true;
      if (debounce !== undefined) {
        clearTimeout(debounce);
        debounce = undefined;
      }
      const dying = watcher;
      watcher = null;
      try {
        dying?.close();
      } catch {}
      const dyingCc = ccWatcher;
      ccWatcher = null;
      try {
        dyingCc?.close();
      } catch {}
      wake(waiters);
      wake(stateWaiters);
    },
    size() {
      const at = now();
      let visible = 0;
      for (const entry of entries.values()) {
        if (entry.retiredAt === undefined || at - entry.retiredAt <= retireGraceMs)
          visible += 1;
      }
      return visible;
    }
  };
  return store;
}

// src/core/bounded-set.ts
function rememberBounded(set, value, max) {
  set.add(value);
  while (set.size > max) {
    const oldest = set.values().next();
    if (oldest.done)
      break;
    set.delete(oldest.value);
  }
}

// src/core/lan-listener.ts
var LAN_BODY_MAX_BYTES = 65536;
var LAN_SEEN_NONCES_MAX = 512;
var LAN_KEEPALIVE_MS = 5000;
var LAN_REQUEST_TIMEOUT_MS = 1e4;
var LAN_ANSWER_TTL_MS = 120000;
var LAN_ANSWER_STORE_MAX = 64;
function createLanAnswerStore(options = {}) {
  const ttl = options.ttlMs ?? LAN_ANSWER_TTL_MS;
  const max = options.max ?? LAN_ANSWER_STORE_MAX;
  const entries = new Map;
  const waiters = new Map;
  const live = (entry, now) => entry && now - entry.at <= ttl && entry.at - now <= ttl ? entry : undefined;
  return {
    put(requestId, answerBlob, at) {
      const existing = entries.get(requestId);
      if (live(existing, at))
        return "duplicate";
      entries.delete(requestId);
      entries.set(requestId, { answerBlob, at });
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done)
          break;
        entries.delete(oldest.value);
      }
      for (const notify of waiters.get(requestId) ?? []) {
        try {
          notify();
        } catch {}
      }
      return "stored";
    },
    peek(requestId, now) {
      const entry = entries.get(requestId);
      const fresh = live(entry, now);
      if (entry && !fresh)
        entries.delete(requestId);
      return fresh;
    },
    waiter(requestId, now) {
      if (this.peek(requestId, now))
        return { promise: Promise.resolve(), cancel: () => {} };
      let settle;
      const promise = new Promise((resolve) => {
        settle = resolve;
      });
      const set = waiters.get(requestId) ?? new Set;
      set.add(settle);
      waiters.set(requestId, set);
      return {
        promise,
        cancel() {
          const current = waiters.get(requestId);
          if (current) {
            current.delete(settle);
            if (current.size === 0)
              waiters.delete(requestId);
          }
          settle();
        }
      };
    },
    size() {
      return entries.size;
    }
  };
}
var lanAnswerStore = createLanAnswerStore();
var textDecoder2 = new TextDecoder;
function traceLan(deps, event) {
  if (deps.trace) {
    try {
      deps.trace(event);
    } catch {}
    return;
  }
  if (lanRunningUnderTest())
    return;
  traceSession({ event: "lan", ...event });
}
function defaultListenerId() {
  const c = globalThis.crypto;
  try {
    if (typeof c?.randomUUID === "function")
      return c.randomUUID();
  } catch {}
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}
function requestIdOf(payload) {
  const requestId = payload.requestId;
  return typeof requestId === "string" && LAN_REQUEST_ID_RE.test(requestId) ? requestId : null;
}
function readBody(req, max) {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      try {
        req.pause();
      } catch {}
      resolve(null);
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const done = (value) => {
      if (settled)
        return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      const bytes = chunk;
      total += bytes.length;
      if (total > max) {
        try {
          req.pause();
        } catch {}
        done(null);
        return;
      }
      chunks.push(bytes);
    });
    req.on("end", () => {
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      done(textDecoder2.decode(merged));
    });
    req.on("error", () => done(null));
    req.on("aborted", () => done(null));
  });
}
function createLanListener(deps = {}) {
  const host = deps.host ?? "0.0.0.0";
  const statePath = deps.statePath ?? LAN_STATE_PATH;
  const now = deps.now ?? Date.now;
  const newListenerId = deps.newListenerId ?? defaultListenerId;
  let server;
  let address = null;
  let stopped = false;
  const sockets = new Set;
  const seenNonces = new Set;
  const answers = deps.answers ?? lanAnswerStore;
  const frames = deps.frames ?? createLanFrameStore();
  const peerAddress = deps.remoteAddress ?? ((req) => req?.socket?.remoteAddress);
  let config = null;
  let keyPromise = Promise.resolve(null);
  let keyMemo;
  const send = (res, status, body) => {
    try {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    } catch {}
  };
  const reject = (res, why) => {
    traceLan(deps, { result: "reject", why });
    send(res, 400, {});
  };
  const handle = async (req, res) => {
    try {
      if ((req.method ?? "").toUpperCase() !== "POST")
        return reject(res, "method");
      if ((req.url ?? "").split("?")[0] !== LAN_PATH)
        return reject(res, "path");
      const raw = await readBody(req, LAN_BODY_MAX_BYTES);
      if (raw === null)
        return reject(res, "body-size");
      let outer;
      try {
        outer = JSON.parse(raw);
      } catch {
        return reject(res, "json");
      }
      if (typeof outer !== "object" || outer === null)
        return reject(res, "shape");
      const p = outer.p;
      if (typeof p !== "string" || p.length === 0)
        return reject(res, "shape");
      const key = await keyPromise;
      const pairing = config;
      if (!key || !pairing)
        return reject(res, "unpaired");
      let plain;
      try {
        plain = await decryptBlob(key, p);
      } catch {
        return reject(res, "decrypt");
      }
      const envelope = parseLanEnvelope(plain);
      if (!envelope)
        return reject(res, "envelope");
      if (!lanEnvelopeIsFresh(envelope.ts, now()))
        return reject(res, "stale");
      if (seenNonces.has(envelope.nonce))
        return reject(res, "replay");
      rememberBounded(seenNonces, envelope.nonce, LAN_SEEN_NONCES_MAX);
      let payload;
      if (envelope.op === "ping") {
        payload = { ok: true };
      } else if (envelope.op === "command") {
        const blob = envelope.payload.blob;
        if (typeof blob !== "string" || blob.length === 0 || blob.length > LAN_COMMAND_BLOB_MAX_CHARS) {
          return reject(res, "command-payload");
        }
        try {
          deps.onCommand?.({ nonce: envelope.nonce, blob, config: pairing });
        } catch {}
        payload = { ok: true };
      } else if (envelope.op === "answer") {
        const requestId = requestIdOf(envelope.payload);
        const answerBlob = envelope.payload.answerBlob;
        if (requestId === null)
          return reject(res, "answer-request-id");
        if (typeof answerBlob !== "string" || answerBlob.length === 0 || answerBlob.length > LAN_ANSWER_BLOB_MAX_CHARS) {
          return reject(res, "answer-blob");
        }
        const stored = answers.put(requestId, answerBlob, now());
        if (stored === "stored") {
          try {
            deps.onAnswer?.({ requestId, answerBlob, config: pairing });
          } catch {}
        }
        payload = { ok: true };
      } else if (envelope.op === "frames") {
        const request = parseLanFramesRequest(envelope.payload);
        if (!request)
          return reject(res, "frames-payload");
        const lid = address?.lid ?? "";
        const slice = await frames.wait(request.sinceSeq, request.waitMs);
        payload = { ok: true, seq: slice.seq, lid, frames: slice.frames };
      } else if (envelope.op === "state") {
        const request = parseLanFramesRequest(envelope.payload);
        if (!request)
          return reject(res, "state-payload");
        const lid = address?.lid ?? "";
        const slice = await frames.waitStates(request.sinceSeq, request.waitMs);
        payload = {
          ok: true,
          seq: slice.seq,
          lid,
          at: slice.at,
          complete: slice.complete,
          sessions: slice.sessions
        };
      } else if (envelope.op === "read") {
        const request = parseLanReadRequest(envelope.payload);
        if (!request)
          return reject(res, "read-payload");
        const hit = await frames.readFull(request.sessionId, request.what);
        payload = hit ? { ok: true, content: hit.content, complete: hit.complete } : { ok: false, err: "not-found" };
      } else if (envelope.op === "answer-poll" && isLoopbackAddress(peerAddress(req))) {
        const requestId = requestIdOf(envelope.payload);
        if (requestId === null)
          return reject(res, "answer-poll-request-id");
        const hit = answers.peek(requestId, now());
        payload = hit ? { status: "answered", answerBlob: hit.answerBlob } : { status: "pending" };
      } else {
        payload = { ok: false, err: "bad-op" };
      }
      const sealed = await encryptBlob(key, {
        v: LAN_ENVELOPE_VERSION,
        reqNonce: envelope.nonce,
        ts: now(),
        payload
      });
      traceLan(deps, { result: "ok", op: envelope.op });
      send(res, 200, { p: sealed });
    } catch {
      try {
        send(res, 400, {});
      } catch {}
    }
  };
  const tryListen = (port) => new Promise((resolve) => {
    let settled = false;
    let candidate;
    try {
      candidate = createServer((req, res) => {
        handle(req, res);
      });
    } catch {
      resolve(null);
      return;
    }
    const finish = (value) => {
      if (settled)
        return;
      settled = true;
      resolve(value);
    };
    try {
      candidate.keepAliveTimeout = LAN_KEEPALIVE_MS;
      candidate.requestTimeout = LAN_REQUEST_TIMEOUT_MS;
      candidate.timeout = 0;
      candidate.on("error", () => {
        try {
          candidate.close();
        } catch {}
        finish(null);
      });
      candidate.on("connection", (socket) => {
        const s = socket;
        sockets.add(s);
        try {
          s.on("close", () => {
            sockets.delete(s);
          });
        } catch {}
      });
      candidate.once("listening", () => finish(candidate));
      candidate.listen(port, host);
    } catch {
      finish(null);
    }
  });
  const bind = async () => {
    let persisted = null;
    try {
      persisted = parseLanState(await readFile4(statePath, "utf8"));
    } catch {
      persisted = null;
    }
    if (persisted) {
      const bound = await tryListen(persisted.port);
      if (stopped) {
        try {
          bound?.close();
        } catch {}
        return null;
      }
      if (bound) {
        server = bound;
        try {
          bound.unref?.();
        } catch {}
        address = { port: persisted.port, lid: newListenerId() };
        const rotated = { port: address.port, lid: address.lid, createdAt: now() };
        try {
          await atomicWrite(statePath, JSON.stringify(rotated), 384);
        } catch {
          traceLan(deps, { result: "state-write-failed" });
        }
        traceLan(deps, { result: "bound", port: address.port, lid: address.lid, reused: true });
        return address;
      }
    }
    const fresh = await tryListen(0);
    if (stopped) {
      try {
        fresh?.close();
      } catch {}
      return null;
    }
    if (!fresh) {
      traceLan(deps, { result: "bind-failed" });
      return null;
    }
    server = fresh;
    try {
      fresh.unref?.();
    } catch {}
    const info = fresh.address();
    const port = typeof info?.port === "number" ? info.port : 0;
    if (port === 0) {
      traceLan(deps, { result: "bind-failed", why: "no-port" });
      return null;
    }
    address = { port, lid: newListenerId() };
    const state = { port, lid: address.lid, createdAt: now() };
    try {
      await atomicWrite(statePath, JSON.stringify(state), 384);
    } catch {
      traceLan(deps, { result: "state-write-failed" });
    }
    traceLan(deps, { result: "bound", port, lid: address.lid, reused: false });
    return address;
  };
  const ready = bind().catch(() => null);
  frames.start();
  return {
    ready,
    sync(next) {
      try {
        config = next;
        frames.setPairing(next?.pairingId, next?.e2eKey);
        frames.reconcile();
        const memo = next ? `${next.pairingId}|${b64url(next.e2eKey)}` : "";
        if (memo === keyMemo)
          return;
        keyMemo = memo;
        keyPromise = next ? deriveLanKey(next.e2eKey, next.pairingId).catch(() => null) : Promise.resolve(null);
        seenNonces.clear();
      } catch {}
    },
    address() {
      return address;
    },
    stop() {
      stopped = true;
      address = null;
      try {
        frames.stop();
      } catch {}
      const dying = server;
      server = undefined;
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {}
      }
      sockets.clear();
      if (!dying)
        return;
      try {
        dying.removeAllListeners("error");
      } catch {}
      try {
        dying.on("error", () => {});
      } catch {}
      try {
        dying.close();
      } catch {}
    }
  };
}
var LAN_HINT_REFRESH_MS = 300000;
var LAN_HINT_MAX_CHARS = 2048;
var LAN_HOSTS_CACHE_MS = 5000;
function lanHostAddresses(interfaces = networkInterfaces()) {
  const v4 = [];
  const v6 = [];
  try {
    for (const entries of Object.values(interfaces)) {
      if (!entries)
        continue;
      for (const entry of entries) {
        const address = entry?.address;
        if (typeof address !== "string" || address.length === 0)
          continue;
        if (entry.internal)
          continue;
        const isV6 = entry.family === "IPv6" || entry.family === 6;
        if (isV6) {
          const lower = address.toLowerCase();
          if (lower.startsWith("fe80:") || lower.startsWith("::"))
            continue;
          if (!v6.includes(address))
            v6.push(address);
          continue;
        }
        if (address.startsWith("169.254."))
          continue;
        if (!v4.includes(address))
          v4.push(address);
      }
    }
  } catch {
    return [];
  }
  return [...v4, ...v6];
}
async function sealHint(key, hosts, port, lid, ts) {
  let list = hosts;
  for (;; ) {
    const sealed = await encryptBlob(key, { v: LAN_ENVELOPE_VERSION, hosts: list, port, lid, ts });
    if (sealed.length <= LAN_HINT_MAX_CHARS)
      return sealed;
    if (list.length <= 1)
      return;
    list = list.slice(0, list.length - 1);
  }
}
function createLanHintPublisher(deps) {
  const hostsOf = deps.hosts ?? (() => lanHostAddresses());
  const now = deps.now ?? Date.now;
  let lastState;
  let lastSentAt = 0;
  let lastSealed;
  let cachedHosts = [];
  let cachedAt = 0;
  const hosts = (t) => {
    if (t - cachedAt < LAN_HOSTS_CACHE_MS && cachedAt !== 0)
      return cachedHosts;
    cachedAt = t;
    try {
      cachedHosts = hostsOf();
    } catch {
      cachedHosts = [];
    }
    return cachedHosts;
  };
  return {
    async take(config) {
      try {
        if (!config)
          return;
        const addr = deps.address();
        if (!addr)
          return;
        const t = now();
        const list = hosts(t);
        if (list.length === 0)
          return;
        const state = `${config.pairingId}|${addr.port}|${addr.lid}|${list.join(",")}`;
        if (state === lastState) {
          if (t - lastSentAt < LAN_HINT_REFRESH_MS)
            return;
          if (lastSealed) {
            lastSentAt = t;
            return lastSealed;
          }
        }
        const sealed = await sealHint(config.e2eKey, list, addr.port, addr.lid, t);
        if (!sealed)
          return;
        lastState = state;
        lastSealed = sealed;
        lastSentAt = t;
        return sealed;
      } catch {
        return;
      }
    }
  };
}

// src/core/decision-poll.ts
var POLL_INTERVAL_MS = 3000;
var POLL_JITTER_MAX_MS = 500;
var POLL_TIMEOUT_MS = 2000;
var POLL_TIMEOUT_CEILING_MS = 8000;
var POLL_BUDGET_LATENCY_FACTOR = 3;
var POLL_LATENCY_SAMPLES = 5;
var POLL_FIRST_CONTACT_TIMEOUT_MS = 4000;
function createPollBudget() {
  const window = [];
  return {
    next(seq) {
      const floorMs = seq <= 1 ? POLL_FIRST_CONTACT_TIMEOUT_MS : POLL_TIMEOUT_MS;
      if (window.length === 0)
        return floorMs;
      const sorted = [...window].sort((a, b) => a - b);
      const typical = sorted[Math.floor(sorted.length / 2)];
      return Math.min(POLL_TIMEOUT_CEILING_MS, Math.max(floorMs, Math.ceil(typical * POLL_BUDGET_LATENCY_FACTOR)));
    },
    observe(roundTripMs) {
      if (!Number.isFinite(roundTripMs) || roundTripMs < 0)
        return;
      window.push(roundTripMs);
      if (window.length > POLL_LATENCY_SAMPLES)
        window.shift();
    }
  };
}
var POST_MAX_ATTEMPTS = 2;
var POST_RETRY_PAUSE_MS = 1000;
var MAX_CONSECUTIVE_MISSES = 100;
var DEFINITIVE_POLL_STATUSES = new Set([401, 403, 404, 410]);
var MAX_DEFINITIVE_POLL_FAILURES = 2;

// src/core/permission.ts
import { readFile as readFile7, realpath, unlink as unlink3 } from "node:fs/promises";
import { appendFileSync as appendFileSync2, statSync as statSync2, truncateSync as truncateSync2 } from "node:fs";
import { hostname as hostname2 } from "node:os";
import { basename as basename4, isAbsolute, relative, resolve } from "node:path";

// src/core/hook.ts
import { readdir as readdir3, readFile as readFile6, unlink as unlink2 } from "node:fs/promises";
import { hostname } from "node:os";
import { basename as basename3 } from "node:path";

// src/core/notify-wire.ts
import { readFile as readFile5 } from "node:fs/promises";
var NOMO_NOTIFY_ENTRY = "codex-notify";
function nomoNotifyProgram(home) {
  return `${home}/.config/cc-status/hook-shim.sh`;
}
function isNomoNotifyChain(arr) {
  const prog = arr[0] ?? "";
  if (/(^|\/)notify-chain\.sh$/.test(prog))
    return true;
  return /(^|\/)hook-shim\.sh$/.test(prog) && arr[1] === NOMO_NOTIFY_ENTRY;
}
function referencesNomoNotify(text) {
  if (text.includes("notify-chain.sh"))
    return true;
  return text.includes("hook-shim.sh") && text.includes(NOMO_NOTIFY_ENTRY);
}
function arrayReferencesNomoNotify(arr) {
  return isNomoNotifyChain(arr) || arr.some((s) => referencesNomoNotify(s));
}
function sameCommand(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function unwrapNotify(arr) {
  if (arr.length === 0)
    return null;
  if (isNomoNotifyChain(arr)) {
    const sep = arr.indexOf("--");
    if (sep === -1)
      return null;
    return unwrapNotify(arr.slice(sep + 1));
  }
  const i = arr.indexOf("--previous-notify");
  if (i !== -1 && i + 1 < arr.length && referencesNomoNotify(arr[i + 1] ?? "")) {
    const host = [...arr.slice(0, i), ...arr.slice(i + 2)];
    let embedded = null;
    try {
      embedded = JSON.parse(arr[i + 1]);
    } catch {}
    if (Array.isArray(embedded) && embedded.every((x) => typeof x === "string")) {
      const inner = unwrapNotify(embedded);
      if (inner !== null && inner.length > 0 && !sameCommand(inner, host)) {
        return [...arr.slice(0, i), "--previous-notify", JSON.stringify(inner), ...arr.slice(i + 2)];
      }
    }
    return host;
  }
  return [...arr];
}
function wireNotifyArray(existing, program) {
  const orig = existing && existing.length > 0 ? unwrapNotify(existing) : null;
  return orig && orig.length > 0 ? [program, NOMO_NOTIFY_ENTRY, "--", ...orig] : [program, NOMO_NOTIFY_ENTRY];
}
function parseNotifyFromToml(toml) {
  for (const line of toml.split(`
`)) {
    if (/^\s*\[/.test(line))
      break;
    const m = line.match(/^\s*notify\s*=\s*(.*)$/);
    if (!m)
      continue;
    try {
      const parsed = JSON.parse(m[1]);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return { present: true, value: parsed };
      }
    } catch {}
    return { present: true, value: null };
  }
  return { present: false, value: null };
}
function replaceNotifyInToml(toml, arr) {
  const line = `notify = ${JSON.stringify(arr)}`;
  const lines = toml.split(`
`);
  let firstTable = -1;
  for (let i = 0;i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      firstTable = i;
      break;
    }
    if (/^\s*notify\s*=/.test(lines[i])) {
      lines[i] = line;
      return lines.join(`
`);
    }
  }
  if (firstTable === -1) {
    const sep = toml.length === 0 || toml.endsWith(`
`) ? "" : `
`;
    return `${toml}${sep}${line}
`;
  }
  lines.splice(firstTable, 0, line, "");
  return lines.join(`
`);
}
function tomlMayNeedNotifyRepair(toml, program) {
  const flat = toml.includes("\\") ? toml.split("\\").join("") : toml;
  if (flat.includes("notify-chain.sh"))
    return true;
  if (!flat.includes("hook-shim.sh"))
    return false;
  return !flat.includes(program);
}
async function repairNotifyWiring(deps = {}) {
  try {
    const home = deps.home ?? process.env.HOME ?? "";
    if (home.length === 0)
      return "unchanged";
    const program = nomoNotifyProgram(home);
    const tomlPath = deps.tomlPath ?? `${codexHome()}/config.toml`;
    let toml;
    try {
      toml = await readFile5(tomlPath, "utf8");
    } catch {
      return "unchanged";
    }
    if (!tomlMayNeedNotifyRepair(toml, program))
      return "unchanged";
    const parsed = parseNotifyFromToml(toml);
    if (!parsed.present || parsed.value === null)
      return "refused";
    if (!arrayReferencesNomoNotify(parsed.value))
      return "refused";
    const next = wireNotifyArray(parsed.value, program);
    if (sameCommand(next, parsed.value))
      return "unchanged";
    const bak = `${tomlPath}.bak-nomo`;
    try {
      await readFile5(bak);
    } catch {
      await atomicWrite(bak, toml);
    }
    await atomicWrite(tomlPath, replaceNotifyInToml(toml, next));
    return "repaired";
  } catch {
    return "refused";
  }
}

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
  const label = typeof pinnedLabel === "string" && pinnedLabel.length > 0 ? pinnedLabel : typeof input.cwd === "string" && input.cwd.length > 0 ? basename3(input.cwd) : "session";
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
    const files = await readdir3(SESSIONS_DIR).catch(() => []);
    const provisionals = [];
    for (const f of files) {
      if (!f.endsWith(".json"))
        continue;
      let r;
      try {
        r = JSON.parse(await readFile6(`${SESSIONS_DIR}/${f}`, "utf8"));
      } catch {
        continue;
      }
      if (r.provisional === true && typeof r.pid === "number")
        provisionals.push({ sessionId: basename3(f, ".json"), pid: r.pid });
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
  const files = await readdir3(SESSIONS_DIR).catch(() => []);
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json"))
      continue;
    try {
      const r = JSON.parse(await readFile6(`${SESSIONS_DIR}/${f}`, "utf8"));
      out.push({ sessionId: basename3(f, ".json"), pid: r.pid, provisional: r.provisional, agent: r.agent, ts: r.ts });
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
    if (agent === "codex" && input.hook_event_name === "SessionStart") {
      await repairNotifyWiring().catch(() => {});
    }
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
    if (existingRecord?.agent === "codex" && typeof existingRecord.retiredAt === "number" && Number.isFinite(existingRecord.retiredAt))
      existingRecord = null;
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
    const label = typeof existingRecord?.label === "string" && existingRecord.label.length > 0 ? existingRecord.label : typeof input.cwd === "string" && input.cwd.length > 0 ? basename3(input.cwd) : "session";
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
    await trackSession(sessionId, plan.op, plan.prio, plan.status, envelope.blob, machine, label, recordTranscript, agent, startedAt, turnStartedAt, turnId, title, config.pairingId, model, pendingPlanPicker, recordPid, origin, planPickerVerificationPending, dbg, envelope.attentionKind, planFull);
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

// src/core/permission.ts
var POST_FIRST_CONTACT_TIMEOUT_MS = 6000;
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
  if (!transcriptPath || !turnId || !sessionId || !basename4(transcriptPath).match(/^rollout-.*\.jsonl$/))
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
function isQuestionTool(toolName) {
  return toolName === "AskUserQuestion" || toolName === "request_user_input";
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
      return fp ? basename4(fp) : toolName;
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
    case "request_user_input": {
      const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const q = questions.find((raw) => {
        const question = raw?.question;
        return typeof question === "string" && question.length > 0;
      });
      return typeof q?.question === "string" ? truncate(q.question) : toolName;
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
      return parseLanState(await readFile7(deps.statePath, "utf8"))?.port;
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
    async settle() {
      if (pending !== undefined) {
        const blob = pending;
        pending = undefined;
        live = false;
        return blob;
      }
      if (!live)
        return;
      live = false;
      if (port === undefined)
        port = await readPort();
      if (port === undefined)
        return;
      return await attempt();
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
  return lanRunningUnderTest() ? async (_sessionId, _pid, beforeUnlink) => {
    await beforeUnlink?.();
    return true;
  } : clearDecisionHold;
}
function defaultSettleHoldRecord() {
  return lanRunningUnderTest() ? async () => {} : settleDecisionHoldRecord;
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
  let settleAsWorking = false;
  let settleHeldRecord;
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
    const codexDialogMode = agent === "codex" && (permissionMode === "acceptEdits" || permissionMode === "plan");
    const questionExempt = !interactiveMode && !codexDialogMode && isQuestionTool(toolName);
    if (!interactiveMode && !questionExempt) {
      trace({ event: "exit", reason: "mode", mode: permissionMode, ...codexDialogMode ? { codex_dialog_mode: true } : {} });
      return;
    }
    if (questionExempt)
      trace({ event: "mode-gate-bypass", reason: "question", mode: permissionMode, tool_name: toolName });
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
            body: JSON.stringify({
              v: 2,
              sessionId,
              requestId,
              op: "update",
              prio: 1,
              ts,
              blob,
              fallbackBlob
            }),
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
    const clock = deps.now ?? Date.now;
    const pollBudget = createPollBudget();
    const pollDecision = async (seq2) => {
      const budgetMs = pollBudget.next(seq2);
      trace({ event: "poll-begin", seq: seq2, budgetMs });
      const startedAt = clock();
      const measure = () => {
        const ms = clock() - startedAt;
        pollBudget.observe(ms);
        return ms;
      };
      try {
        const res = await fetchFn(`${config.url}/v1/cc/decision/${requestId}`, {
          headers: pcHeaders,
          signal: AbortSignal.timeout(budgetMs)
        });
        if (!res.ok) {
          trace({ event: "poll-end", seq: seq2, outcome: "status", status: res.status, ms: measure() });
          return { status: res.status };
        }
        const data = await res.json();
        trace({ event: "poll-end", seq: seq2, outcome: "ok", ms: measure() });
        return { data, status: res.status };
      } catch (e) {
        trace({ event: "poll-end", seq: seq2, outcome: "error", ...errorTag(e) });
        return { status: 0 };
      }
    };
    let attentionStalled = false;
    const stalledPatch = async (at2) => {
      let stalledBlob = fallbackBlob;
      try {
        stalledBlob = await encryptBlob(config.e2eKey, { ...base, reconnecting: Math.floor(at2 / 1000) });
      } catch {}
      return { ts: at2, blob: stalledBlob, attentionStalledAt: at2 };
    };
    const markAttentionStalled = async () => {
      const at2 = (deps.now ?? Date.now)();
      try {
        await (deps.settleHoldRecordFn ?? defaultSettleHoldRecord())(sessionId, await stalledPatch(at2));
      } catch {}
    };
    let { posted, hold, reason: holdReason } = await postDecision(1, POST_MAX_ATTEMPTS);
    if (!posted) {
      const probe = await pollDecision(0);
      const live = probe.data?.status === "pending" || probe.data?.status === "answered";
      if (!live) {
        if (probe.status === 0)
          await markAttentionStalled();
        trace({ event: "exit", reason: "post-error", ...probe.status === 0 ? { stalled: true } : {} });
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
        await markAttentionStalled();
        trace({ event: "exit", reason: "hold-false", stalled: true });
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
    const holdAt = (deps.now ?? Date.now)();
    const holdPid = deps.holdPid ?? process.pid;
    let holdBlob = blob;
    try {
      holdBlob = await encryptBlob(config.e2eKey, appendFittedPlanAndDebug(permissionFrame(permissionBase, fitted.detail, fitted.omitted, fitted.questions), undefined, formatDecisionHoldDebug({ requestId, pid: holdPid })));
    } catch {}
    await (deps.writeHoldFn ?? defaultWriteHold())(sessionId, { blob: holdBlob, at: holdAt, pid: holdPid });
    heldSessionId = sessionId;
    settleHeldRecord = async () => {
      const settledAt = (deps.now ?? Date.now)();
      const patch = settleAsWorking ? {
        ts: settledAt,
        lastEvent: "working",
        op: "update",
        prio: 0,
        sentDone: false,
        attentionKind: undefined,
        attentionStalledAt: undefined,
        blob: await encryptBlob(config.e2eKey, { ...base, status: "working", at: Math.floor(settledAt / 1000) })
      } : attentionStalled ? await stalledPatch(settledAt) : { ts: settledAt, blob: fallbackBlob, attentionStalledAt: undefined };
      await (deps.settleHoldRecordFn ?? defaultSettleHoldRecord())(sessionId, patch);
    };
    const jitter = deps.jitter ?? (() => Math.floor(Math.random() * POLL_JITTER_MAX_MS));
    const interval = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    const emit = deps.emit ?? ((line) => process.stdout.write(`${line}
`));
    const applyAnswerBlob = async (answerBlob, src) => {
      const answer = await decryptBlob(config.e2eKey, answerBlob);
      const match = answer.requestId === requestId;
      const outcome = match ? emitDecision(agent, answer, toolName, toolInput, suggestions, emit, trace) : "released";
      if (outcome === "emitted")
        settleAsWorking = true;
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
          const settled = loopback === undefined ? undefined : await loopback.settle();
          if (settled !== undefined && await applyAnswerBlob(settled, "lan") === "done")
            return;
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
          attentionStalled = true;
          trace({ event: "giveup", misses, stalled: true });
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
        await (deps.clearHoldFn ?? defaultClearHold())(heldSessionId, deps.holdPid ?? process.pid, settleHeldRecord);
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

// src/core/codex-user-input-shape.ts
var ANSWER_MAX2 = 500;
var OPTION_LABEL_WIRE_MAX = 60;
function capLabel(value) {
  const characters = Array.from(value);
  return characters.length <= OPTION_LABEL_WIRE_MAX ? value : `${characters.slice(0, OPTION_LABEL_WIRE_MAX - 1).join("")}…`;
}
function renderableCodexUserInput(toolInput) {
  const rawQuestions = toolInput.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 3)
    return;
  const questions = [];
  const ids = [];
  for (const raw of rawQuestions) {
    if (!raw || raw.isSecret === true || typeof raw.question !== "string" || raw.question.length === 0) {
      return;
    }
    if (typeof raw.id !== "string" || raw.id.length === 0)
      return;
    ids.push(raw.id);
    if (!Array.isArray(raw.options) || raw.options.length === 0)
      return;
    const options = [];
    const labels = [];
    for (const candidate of raw.options) {
      const option = candidate;
      if (!option || typeof option.label !== "string" || option.label.length === 0)
        return;
      const label = option.label;
      if (label !== label.trim() || label.length > ANSWER_MAX2)
        return;
      labels.push(label);
      options.push({
        label,
        description: typeof option.description === "string" ? option.description : ""
      });
    }
    if (new Set(labels).size !== labels.length)
      return;
    if (new Set(labels.map(capLabel)).size !== labels.length)
      return;
    questions.push({
      question: raw.question,
      ...typeof raw.header === "string" ? { header: raw.header } : {},
      multiSelect: false,
      options
    });
  }
  if (new Set(ids).size !== ids.length)
    return;
  return { questions };
}

// src/core/codex-remote-input.ts
var POST_TIMEOUT_MS = 15000;
var ANSWER_MAX3 = 500;
function defaultWriteHold2() {
  return lanRunningUnderTest() ? async () => {} : writeDecisionHold;
}
function defaultClearHold2() {
  return lanRunningUnderTest() ? async (_sessionId, _pid, beforeUnlink) => {
    await beforeUnlink?.();
    return true;
  } : clearDecisionHold;
}
function defaultSettleHoldRecord2() {
  return lanRunningUnderTest() ? async () => {} : settleDecisionHoldRecord;
}
function codexAnswersFromPhone(request, positional) {
  if (!Array.isArray(positional) || positional.length !== request.questions.length)
    return;
  const mapped = {};
  for (let index = 0;index < request.questions.length; index += 1) {
    const question = request.questions[index];
    if (typeof question?.id !== "string" || question.id.length === 0)
      return;
    const raw = positional[index];
    if (typeof raw !== "string")
      return;
    const answer = raw.trim();
    if (answer.length === 0 || answer.length > ANSWER_MAX3 || !question.options?.length)
      return;
    const hits = question.options.map((option) => option.label).filter((label) => label === answer || capPermissionWireText(label, PERMISSION_QUESTION_LABEL_MAX) === answer);
    const unique = Array.from(new Set(hits));
    if (unique.length !== 1)
      return;
    mapped[question.id] = [unique[0]];
  }
  if (Object.keys(mapped).length !== request.questions.length)
    return;
  return mapped;
}
function baseBlob(request, record, config, now) {
  const preview = requestUserInputDetail({ questions: request.questions });
  return {
    status: "needsAttention",
    title: typeof record.title === "string" ? record.title : "",
    machine: config.machineName ?? (typeof record.machine === "string" && record.machine.length > 0 ? record.machine : hostname3().replace(/\.local$/, "")),
    label: typeof record.label === "string" && record.label.length > 0 ? record.label : "session",
    ...preview ? { detail: preview } : {},
    agent: "codex",
    ...typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {},
    ...typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {},
    at: Math.floor(now / 1000)
  };
}
function requestSignal(ms, signal) {
  const deadline = AbortSignal.timeout(ms);
  const any = AbortSignal.any;
  if (typeof any === "function")
    return any.call(AbortSignal, [signal, deadline]);
  const controller = new AbortController;
  const abort = () => controller.abort();
  if (signal.aborted || deadline.aborted)
    controller.abort();
  else {
    signal.addEventListener("abort", abort, { once: true });
    deadline.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
function abortableSleep(ms, signal, sleep) {
  if (signal.aborted)
    return Promise.resolve();
  return new Promise((resolve2) => {
    let done = false;
    const finish = () => {
      if (done)
        return;
      done = true;
      signal.removeEventListener("abort", finish);
      resolve2();
    };
    signal.addEventListener("abort", finish, { once: true });
    sleep(ms).then(finish, finish);
  });
}
function report(deps, error, fallback) {
  try {
    deps.onError?.(error instanceof Error ? error : new Error(`${fallback}: ${String(error)}`));
  } catch {}
}
async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return;
  }
}
async function resolveOnRelay(config, requestId, fetchFn = fetch) {
  try {
    await fetchFn(`${config.url}/v1/cc/decision/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret,
        "x-cc-version": PLUGIN_VERSION
      },
      body: JSON.stringify({ requestId }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS)
    });
  } catch {}
}
async function runRemoteInput(request, requestId, signal, deps, onHoldCreated) {
  let holdCreated = false;
  let heldSessionId;
  let resumed = false;
  let settleHeldRecord;
  try {
    const toolInput = renderableCodexUserInput({ questions: request.questions });
    if (!toolInput)
      return "unsupported";
    const record = await (deps.readRecordFn ?? readRecord)(request.identity.threadId);
    if (!record || (record.agent ?? "claude") !== "codex")
      return "unsupported";
    if (signal.aborted)
      return "resolved-elsewhere";
    const questions = buildPermissionQuestions(toolInput);
    if (questions.length !== request.questions.length)
      return "unsupported";
    const now = (deps.now ?? Date.now)();
    const fallback = baseBlob(request, record, deps.config, now);
    const { detail: _fallbackDetail, ...promptBase } = fallback;
    const permissionBase = {
      ...promptBase,
      status: "decisionPending",
      permissionSummary: buildPermissionSummary("AskUserQuestion", toolInput),
      permissionRequestId: requestId,
      permissionToolName: "request_user_input"
    };
    const fitted = fitPermissionDetail(permissionBase, "", BLOB_FIT_CHARS, questions);
    if (!fitted.questions || fitted.questions.length !== request.questions.length)
      return "unsupported";
    const promptFrame = { ...permissionBase, permissionQuestions: fitted.questions };
    const [blob, fallbackBlob, approvals] = await Promise.all([
      encryptBlob(deps.config.e2eKey, promptFrame),
      encryptBlob(deps.config.e2eKey, fallback),
      (deps.localApprovalsStateFn ?? localApprovalsState)()
    ]);
    if (signal.aborted)
      return "resolved-elsewhere";
    const fetchFn = deps.fetchFn ?? fetch;
    const headers = {
      "x-cc-pairing": deps.config.pairingId,
      "x-cc-auth": deps.config.pcSecret,
      "x-cc-version": PLUGIN_VERSION
    };
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve2) => {
      const timer = setTimeout(resolve2, ms);
      timer.unref?.();
    }));
    let attentionStalled = false;
    const stalledPatch = async (at) => {
      let stalledBlob = fallbackBlob;
      try {
        stalledBlob = await encryptBlob(deps.config.e2eKey, { ...fallback, reconnecting: Math.floor(at / 1000) });
      } catch {}
      return { ts: at, blob: stalledBlob, attentionStalledAt: at };
    };
    const markAttentionStalled = async () => {
      const at = (deps.now ?? Date.now)();
      try {
        await (deps.settleHoldRecordFn ?? defaultSettleHoldRecord2())(request.identity.threadId, await stalledPatch(at));
      } catch {}
    };
    let response;
    for (let attempt = 1;attempt <= POST_MAX_ATTEMPTS && !signal.aborted; attempt += 1) {
      try {
        response = await fetchFn(`${deps.config.url}/v1/cc/decision`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers, "x-cc-approvals": approvals },
          body: JSON.stringify({
            v: 2,
            sessionId: request.identity.threadId,
            requestId,
            op: "update",
            prio: 1,
            ts: now,
            attentionKind: "userInput",
            blob,
            fallbackBlob,
            ...typeof record.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt) ? { startedAt: record.sessionStartedAt } : {}
          }),
          signal: requestSignal(POST_TIMEOUT_MS, signal)
        });
        break;
      } catch {
        if (attempt < POST_MAX_ATTEMPTS && !signal.aborted) {
          await abortableSleep(POST_RETRY_PAUSE_MS, signal, sleep);
        }
      }
    }
    if (!response) {
      await resolveOnRelay(deps.config, requestId, fetchFn);
      if (!signal.aborted)
        await markAttentionStalled();
      return signal.aborted ? "resolved-elsewhere" : "transport-error";
    }
    if (!response.ok)
      return signal.aborted ? "resolved-elsewhere" : "transport-error";
    const created = await parseJson(response);
    if (!created) {
      report(deps, new Error("Unparseable relay response to the decision hold POST"), "Relay POST");
      await resolveOnRelay(deps.config, requestId, fetchFn);
      return signal.aborted ? "resolved-elsewhere" : "transport-error";
    }
    if (created.hold !== true)
      return signal.aborted ? "resolved-elsewhere" : "not-held";
    holdCreated = true;
    const holdPid = deps.holdPid ?? process.pid;
    await (deps.writeHoldFn ?? defaultWriteHold2())(request.identity.threadId, { blob, at: now, pid: holdPid });
    heldSessionId = request.identity.threadId;
    settleHeldRecord = async () => {
      const settledAt = (deps.now ?? Date.now)();
      const unblocked = resumed || signal.aborted;
      const patch = unblocked ? {
        ts: settledAt,
        lastEvent: "working",
        op: "update",
        prio: 0,
        sentDone: false,
        attentionKind: undefined,
        attentionStalledAt: undefined,
        blob: await encryptBlob(deps.config.e2eKey, {
          ...promptBase,
          status: "working",
          at: Math.floor(settledAt / 1000)
        })
      } : attentionStalled ? await stalledPatch(settledAt) : { ts: settledAt, blob: fallbackBlob, attentionStalledAt: undefined };
      await (deps.settleHoldRecordFn ?? defaultSettleHoldRecord2())(request.identity.threadId, patch);
    };
    onHoldCreated(true);
    if (signal.aborted)
      return "resolved-elsewhere";
    const reportUndelivered = async (action, outcome) => {
      report(deps, new Error(`Codex ${action} was not delivered to app-server (${outcome})`), "Codex remote input delivery");
      await resolveOnRelay(deps.config, requestId, fetchFn);
    };
    const applyAnswerBlob = async (answerBlob) => {
      const reject = (why, result2) => {
        report(deps, new Error(`Codex phone answer rejected (${why})`), "Codex remote input answer");
        return result2;
      };
      let answer;
      try {
        answer = await decryptBlob(deps.config.e2eKey, answerBlob);
      } catch {
        return reject("undecryptable", "transport-error");
      }
      if (answer.requestId !== requestId)
        return reject("request-id mismatch", "unsupported");
      if (answer.decision === "deny") {
        const result2 = await deps.interruptAppServer();
        if (result2 === "sent" || result2 === "already-sent") {
          resumed = true;
          return "denied";
        }
        await reportUndelivered("deny", result2);
        return "transport-error";
      }
      if (answer.decision !== "answer")
        return reject("unknown decision", "unsupported");
      const mapped = codexAnswersFromPhone(request, answer.answers);
      if (!mapped)
        return reject("unmappable to the app-server questions", "unsupported");
      const result = await deps.answerAppServer(mapped);
      if (result === "sent" || result === "already-sent") {
        resumed = true;
        return "answered";
      }
      await reportUndelivered("answer", result);
      return "transport-error";
    };
    const answers = deps.answerStore ?? lanAnswerStore;
    const clock = deps.now ?? Date.now;
    const localAnswer = () => answers.peek(requestId, clock())?.answerBlob;
    let misses = 0;
    let definitiveFailures = 0;
    let polls = 0;
    const pollBudget = deps.pollBudget ?? createPollBudget();
    while (!signal.aborted) {
      const local = localAnswer();
      if (local)
        return await applyAnswerBlob(local);
      polls += 1;
      const budgetMs = pollBudget.next(polls);
      const startedAt = clock();
      try {
        const response2 = await fetchFn(`${deps.config.url}/v1/cc/decision/${requestId}`, {
          headers,
          signal: requestSignal(budgetMs, signal)
        });
        const data = response2.ok ? await parseJson(response2) : undefined;
        pollBudget.observe(clock() - startedAt);
        if (!data) {
          misses += 1;
          if (response2.ok)
            report(deps, new Error("Unparseable relay poll response"), "Relay poll");
          if (!response2.ok && DEFINITIVE_POLL_STATUSES.has(response2.status)) {
            definitiveFailures += 1;
            if (definitiveFailures >= MAX_DEFINITIVE_POLL_FAILURES)
              return "transport-error";
          } else {
            definitiveFailures = 0;
          }
        } else {
          misses = 0;
          definitiveFailures = 0;
          if (data.status === "answered" && typeof data.answerBlob === "string") {
            return await applyAnswerBlob(data.answerBlob);
          } else if (data.status === "expired" || data.status === "superseded") {
            const raced = localAnswer();
            if (raced)
              return await applyAnswerBlob(raced);
            return data.status === "expired" ? "expired" : "superseded";
          }
        }
      } catch {
        misses += 1;
        definitiveFailures = 0;
      }
      if (misses >= MAX_CONSECUTIVE_MISSES) {
        attentionStalled = true;
        return "transport-error";
      }
      const waiter = answers.waiter(requestId, clock());
      try {
        await Promise.race([abortableSleep(deps.pollIntervalMs ?? POLL_INTERVAL_MS, signal, sleep), waiter.promise]);
      } finally {
        waiter.cancel();
      }
    }
    return "resolved-elsewhere";
  } catch (error) {
    report(deps, error, "Codex remote input failed");
    if (holdCreated)
      await resolveOnRelay(deps.config, requestId, deps.fetchFn ?? fetch);
    return signal.aborted ? "resolved-elsewhere" : "transport-error";
  } finally {
    if (heldSessionId !== undefined) {
      try {
        await (deps.clearHoldFn ?? defaultClearHold2())(heldSessionId, deps.holdPid ?? process.pid, settleHeldRecord);
      } catch {}
    }
    if (!holdCreated)
      onHoldCreated(false);
  }
}
function startCodexRemoteInput(request, deps) {
  const requestId = (deps.randomUUID ?? (() => crypto.randomUUID()))();
  const controller = new AbortController;
  const fetchFn = deps.fetchFn ?? fetch;
  let settleHold;
  const holdCreated = new Promise((resolve2) => {
    settleHold = resolve2;
  });
  let resolvePromise;
  const completion = runRemoteInput(request, requestId, controller.signal, deps, settleHold).catch((error) => {
    report(deps, error, "Codex remote input failed");
    return "transport-error";
  });
  return {
    requestId,
    completion,
    async resolvedElsewhere() {
      if (resolvePromise)
        return resolvePromise;
      controller.abort();
      resolvePromise = (async () => {
        if (await holdCreated)
          await resolveOnRelay(deps.config, requestId, fetchFn);
      })();
      await resolvePromise;
    }
  };
}

// src/core/codex-remote-input-bridge.ts
var LOADED_PAGE_SIZE = 100;
var RECONNECT_DELAY_MS = 5000;
function requestKey(request) {
  const identity = request.identity;
  return JSON.stringify([
    identity.connectionEpoch,
    typeof identity.requestId,
    identity.requestId,
    identity.threadId,
    identity.turnId,
    identity.itemId
  ]);
}

class CodexRemoteInputBridge {
  config;
  client;
  startRemoteInputFn;
  onError;
  subscribedThreads = new Set;
  pendingRequests = new Set;
  resolvedWhilePending = new Set;
  handles = new Map;
  pendingRetirements = new Set;
  refreshPromise;
  stopping = false;
  constructor(config, options = {}) {
    this.config = config;
    this.startRemoteInputFn = options.startRemoteInputFn ?? startCodexRemoteInput;
    this.onError = options.onError;
    const callbacks = {
      onUserInputRequest: (request) => this.onRequest(request),
      onUserInputResolved: (request, resolution) => this.onResolved(request, resolution),
      onStateChange: (state) => this.onStateChange(state)
    };
    this.client = options.createClient?.(callbacks) ?? new CodexAppServerClient({
      transportFactory: () => new CodexProxyTransport,
      clientVersion: PLUGIN_VERSION,
      reconnectDelayMs: RECONNECT_DELAY_MS,
      ...callbacks,
      onError: (error) => this.reportError(error)
    });
  }
  reportError(error, fallback = "Codex remote input bridge error") {
    try {
      this.onError?.(error instanceof Error ? error : new Error(`${fallback}: ${String(error)}`));
    } catch {}
  }
  async start() {
    this.stopping = false;
    const connected = await this.client.start();
    if (connected)
      await this.refreshSubscriptions();
    return connected;
  }
  refreshSubscriptions() {
    if (this.client.state !== "ready" || this.stopping)
      return Promise.resolve();
    if (this.refreshPromise)
      return this.refreshPromise;
    this.refreshPromise = this.refreshLoadedThreads().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }
  async readThreadWaitState(threadId) {
    if (this.client.state !== "ready" || this.stopping)
      return "unavailable";
    try {
      const status = await this.client.readThreadStatus(threadId);
      if (status.type === "idle")
        return "notWaitingOnUserInput";
      if (status.type === "active") {
        return status.activeFlags.includes("waitingOnUserInput") ? "waitingOnUserInput" : "notWaitingOnUserInput";
      }
      return "unavailable";
    } catch {
      return "unavailable";
    }
  }
  retire(handle, fallback) {
    const retirement = handle.resolvedElsewhere().catch((error) => this.reportError(error, fallback));
    this.pendingRetirements.add(retirement);
    retirement.then(() => {
      this.pendingRetirements.delete(retirement);
    }).catch(() => {
      return;
    });
  }
  async stop() {
    if (this.stopping)
      return;
    this.stopping = true;
    const handles = [...this.handles.values()];
    await this.client.stop();
    for (const handle of this.handles.values())
      handles.push(handle);
    this.handles.clear();
    for (const handle of new Set(handles))
      this.retire(handle, "Failed to retire a Codex phone card");
    await Promise.allSettled([...this.pendingRetirements]);
    this.subscribedThreads.clear();
  }
  async refreshLoadedThreads() {
    let cursor = null;
    do {
      if (this.client.state !== "ready" || this.stopping)
        return;
      let page;
      try {
        page = await this.client.listLoadedThreads({ cursor, limit: LOADED_PAGE_SIZE });
      } catch {
        return;
      }
      for (const threadId of page.data) {
        if (this.client.state !== "ready" || this.stopping)
          return;
        if (this.subscribedThreads.has(threadId))
          continue;
        try {
          await this.client.resumeThread(threadId);
          this.subscribedThreads.add(threadId);
        } catch {}
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
  onRequest(request) {
    if (this.stopping)
      return;
    const key = requestKey(request);
    if (this.handles.has(key) || this.pendingRequests.has(key))
      return;
    this.pendingRequests.add(key);
    this.routeRequest(request, key);
  }
  async routeRequest(request, key) {
    try {
      if (this.stopping || this.handles.has(key) || this.resolvedWhilePending.delete(key))
        return;
      const handle = this.startRemoteInputFn(request, {
        config: this.config,
        answerAppServer: (answers) => this.client.answerUserInput(request.identity, answers),
        interruptAppServer: () => this.client.interruptUserInput(request.identity),
        onError: (error) => this.reportError(error)
      });
      this.handles.set(key, handle);
      handle.completion.then(() => {
        return;
      }, (error) => this.reportError(error, "Codex remote input failed")).then(() => {
        if (this.handles.get(key) === handle)
          this.handles.delete(key);
      }).catch(() => {
        return;
      });
    } catch (error) {
      this.reportError(error, "Failed to arbitrate Codex remote input");
    } finally {
      this.pendingRequests.delete(key);
      this.resolvedWhilePending.delete(key);
    }
  }
  onResolved(request, resolution) {
    const key = requestKey(request);
    const handle = this.handles.get(key);
    if (!handle) {
      if (this.pendingRequests.has(key))
        this.resolvedWhilePending.add(key);
      return;
    }
    this.handles.delete(key);
    if (resolution !== "response-sent" && resolution !== "interrupt-sent") {
      this.retire(handle, "Failed to retire a Codex phone card");
    }
  }
  onStateChange(state) {
    if (state === "ready") {
      this.subscribedThreads.clear();
      this.refreshSubscriptions().catch((error) => this.reportError(error, "Failed to refresh Codex thread subscriptions"));
    } else if (state === "disconnected" || state === "stopped") {
      this.subscribedThreads.clear();
    }
  }
}
// src/entries/cc-watchdog.ts
var POLL_MS = 5000;
var PAIRING_TTL_MS = 600000;
var SESSION_STALE_MS = 86400000;
var IDLE_GRACE_MS = 1800000;
var HEARTBEAT_AFTER_MS = 300000;
var heartbeatAt = new Map;
var doneAttemptsMem = new Map;
function effectiveDoneAttempts(record, sessionId) {
  const persisted = typeof record.doneAttempts === "number" && Number.isFinite(record.doneAttempts) ? record.doneAttempts : 0;
  return Math.max(persisted, doneAttemptsMem.get(sessionId) ?? 0);
}
function noteDoneAttempt(sessionId, attempts) {
  doneAttemptsMem.set(sessionId, attempts);
}
function clearDoneAttempts(sessionId) {
  doneAttemptsMem.delete(sessionId);
}
function resetDoneAttemptMemory() {
  doneAttemptsMem.clear();
}
async function readRecordAt(path) {
  try {
    return JSON.parse(await readFile8(path, "utf8"));
  } catch {
    return null;
  }
}
function recordMovedSince(snapshot, fresh) {
  return fresh.ts !== snapshot.ts || fresh.lastEvent !== snapshot.lastEvent || fresh.op !== snapshot.op;
}
function isDoneState(record) {
  return record.op === "done" || record.lastEvent === "done";
}
function pendingDoneSettleWrite(snapshot, fresh, settled) {
  if (fresh === null)
    return settled;
  if (!recordMovedSince(snapshot, fresh))
    return settled;
  if (!isDoneState(fresh))
    return null;
  if (fresh.donePending !== true)
    return null;
  return { ...fresh, donePending: undefined, doneAttempts: undefined };
}
function pendingDoneRetryWrite(snapshot, fresh, attempts) {
  if (fresh === null)
    return { ...snapshot, doneAttempts: attempts };
  if (!recordMovedSince(snapshot, fresh))
    return { ...fresh, doneAttempts: attempts };
  if (!isDoneState(fresh))
    return null;
  return { ...fresh, doneAttempts: attempts };
}
function classifySession(record, now, isAlive) {
  if (!record || typeof record.pid !== "number" || !Number.isFinite(record.pid))
    return "delete";
  if (typeof record.ts !== "number")
    return "delete";
  if (record.agent === "codex" && typeof record.retiredAt === "number" && Number.isFinite(record.retiredAt)) {
    if (typeof record.tuiPid !== "number" || !Number.isFinite(record.tuiPid))
      return "delete";
    return isAlive(record.tuiPid) ? "keep" : "delete";
  }
  if (now - record.ts > SESSION_STALE_MS)
    return "stale";
  const ownerPid = record.agent === "codex" && typeof record.tuiPid === "number" && Number.isFinite(record.tuiPid) ? record.tuiPid : record.pid;
  return isAlive(ownerPid) ? "keep" : "end";
}
async function locateCodexOwnedTui(sessionId, record) {
  const resolved = resolveCodexTuiOwner(record, await readAllRecords(), pidAlive);
  if (resolved !== undefined)
    return resolved;
  const locate = adapterFor("codex").locateTuiPid;
  if (!locate)
    return;
  let reason;
  const pid = await locate({ sessionId, record }, { note: (value) => {
    reason = value;
  } });
  return reason === "record-pid" || reason === "sentinel-pid" ? pid : undefined;
}
function startedAtField(record) {
  return typeof record.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt) ? { startedAt: record.sessionStartedAt } : {};
}
function buildEndEnvelope(sessionId, now, record, at) {
  return {
    v: 2,
    sessionId,
    op: "end",
    prio: 0,
    ts: now,
    ...record ? startedAtField(record) : {},
    ...typeof at === "number" && Number.isFinite(at) ? { at } : {}
  };
}
async function buildDoneEnvelope(sessionId, record, now, e2eKey, agent = "claude", at, dbg) {
  const base = {
    status: "done",
    title: typeof record.title === "string" ? record.title : "",
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    ...adapterFor(agent).blobAgentFields,
    ...typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {},
    ...typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {},
    ...typeof at === "number" && Number.isFinite(at) ? { at } : {}
  };
  const debug = appendCodexBridgeMarker(agent === "codex" ? dbg ?? formatPlanPickerDebug({ event: "done", classifier: "done", marker: "0", by: "wd" }) : undefined, codexBridgeIsDown());
  const blob = await encryptBlob(e2eKey, appendFittedPlanAndDebug(base, undefined, debug));
  return { v: 2, sessionId, op: "done", prio: 0, ts: now, blob, ...startedAtField(record) };
}
async function buildNeedsAttentionEnvelope(sessionId, record, now, e2eKey, agent = "claude", at, detail, attentionKind, proposedPlan, dbg) {
  const base = {
    status: "needsAttention",
    title: typeof record.title === "string" ? record.title : "",
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    ...typeof detail === "string" && detail.length > 0 ? { detail } : {},
    ...adapterFor(agent).blobAgentFields,
    ...typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {},
    ...typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {},
    ...typeof at === "number" && Number.isFinite(at) ? { at } : {}
  };
  const debug = appendCodexBridgeMarker(agent === "codex" ? dbg ?? formatPlanPickerDebug({ event: "attention", classifier: "pending", marker: "0", by: "wd" }) : undefined, codexBridgeIsDown());
  const blob = await encryptBlob(e2eKey, appendFittedPlanAndDebug(base, proposedPlan, debug));
  return {
    v: 2,
    sessionId,
    op: "update",
    prio: 1,
    ts: now,
    ...agent === "codex" && attentionKind === "userInput" ? { attentionKind } : {},
    blob,
    ...startedAtField(record)
  };
}
async function buildWorkingEnvelope(sessionId, record, now, e2eKey, agent = "claude", dbg) {
  const base = {
    status: "working",
    title: typeof record.title === "string" ? record.title : "",
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    ...adapterFor(agent).blobAgentFields,
    ...typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {},
    ...typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {},
    at: Math.floor(now / 1000)
  };
  const debug = appendCodexBridgeMarker(agent === "codex" ? dbg ?? formatPlanPickerDebug({ event: "working", classifier: "resolved", marker: "0", by: "wd" }) : undefined, codexBridgeIsDown());
  const blob = await encryptBlob(e2eKey, appendFittedPlanAndDebug(base, undefined, debug));
  return { v: 2, sessionId, op: "update", prio: 0, ts: now, blob, ...startedAtField(record) };
}
function markerAge(record, now) {
  const since = typeof record.planPickerPendingSince === "number" && Number.isFinite(record.planPickerPendingSince) ? record.planPickerPendingSince : record.ts;
  return typeof since === "number" && Number.isFinite(since) ? `${Math.max(0, Math.floor((now - since) / 60000))}m` : "-";
}
function tracePicker(sessionId, deps, decision) {
  if (deps.trace) {
    deps.trace(decision);
    return;
  }
  if (process.argv.some((arg) => arg === "test" || arg.endsWith(".test.ts")))
    return;
  tracePlanPickerDecision(sessionId, decision);
}
async function settlePendingPlanPickerDone(config, path, sessionId, snapshot, now, deps, cause = "settle") {
  const readCurrent = deps.readRecord ?? readRecordAt;
  const writeRecord = deps.writeRecord ?? ((p, rec) => atomicWrite(p, JSON.stringify(rec), 384));
  const fresh = await readCurrent(path);
  if (!fresh || recordMovedSince(snapshot, fresh) || fresh.turnId !== snapshot.turnId || fresh.pendingPlanPicker !== snapshot.pendingPlanPicker || fresh.planPickerVerificationPending !== snapshot.planPickerVerificationPending) {
    tracePicker(sessionId, deps, {
      source: "watchdog",
      classifier: "settle-stale",
      marker: "kept",
      settle: "blocked"
    });
    return "uncorrected";
  }
  const at = typeof snapshot.ts === "number" && Number.isFinite(snapshot.ts) ? Math.floor(snapshot.ts / 1000) : undefined;
  const ttlFired = planPickerPendingExpired(snapshot, now);
  const dbg = formatPlanPickerDebug({
    event: cause === "exit" ? "exit" : ttlFired ? "ttl" : "settle",
    classifier: "done",
    marker: "s",
    ttl: ttlFired ? "fire" : markerAge(snapshot, now),
    by: "wd"
  });
  const envelope = await buildDoneEnvelope(sessionId, snapshot, now, config.e2eKey, "codex", at, dbg);
  const next = {
    ...fresh,
    ts: now,
    lastEvent: "done",
    sentDone: true,
    donePending: true,
    op: "done",
    prio: 0,
    blob: envelope.blob,
    pairingId: config.pairingId,
    pendingPlanPicker: undefined,
    planPickerVerificationPending: undefined,
    planPickerPendingSince: undefined,
    planPickerSettled: true,
    doneAttempts: undefined,
    dbg
  };
  await writeRecord(path, next);
  let outcome;
  try {
    outcome = await (deps.post ?? ((body) => postEvent(config, body)))(envelope);
  } catch {
    tracePicker(sessionId, deps, {
      source: "watchdog",
      classifier: cause === "exit" ? "tui-exit" : "done",
      marker: "settled",
      ttlFired,
      settle: "done",
      correctionPosted: false,
      doneBy: "watchdog"
    });
    return "pending";
  }
  tracePicker(sessionId, deps, {
    source: "watchdog",
    classifier: cause === "exit" ? "tui-exit" : "done",
    marker: "settled",
    ttlFired,
    settle: "done",
    correctionPosted: outcome === "delivered",
    doneBy: "watchdog"
  });
  if (outcome === "revoked")
    return "revoked";
  if (outcome !== "delivered")
    return "pending";
  try {
    const after = await readCurrent(path);
    if (after?.donePending === true && after.blob === next.blob && after.op === "done") {
      await writeRecord(path, { ...after, donePending: undefined });
    }
  } catch {}
  return "corrected";
}
var CODEX_TUI_SESSION_START_SKEW_MS = 30000;
var CODEX_TUI_SESSION_START_FUTURE_SLOP_MS = 2000;
function correlateCodexTuiPid(record, candidates, alive = pidAlive) {
  if (record.agent !== "codex" || record.provisional === true)
    return;
  const cwd = record.origin?.cwd;
  const owner = record.origin?.ppid_command;
  const startedAt = record.sessionStartedAt;
  if (typeof cwd !== "string" || cwd.length === 0 || typeof owner !== "string" || !owner.includes("/standalone/") || !/(?:^|\/)codex app-server(?:\s|$)/.test(owner) || typeof startedAt !== "number" || !Number.isFinite(startedAt))
    return;
  const matches = candidates.filter((candidate) => candidate.provisional === true && candidate.agent === "codex" && candidate.tuiCwd === cwd && typeof candidate.pid === "number" && Number.isFinite(candidate.pid) && typeof candidate.tuiStartedAt === "number" && Number.isFinite(candidate.tuiStartedAt) && startedAt - candidate.tuiStartedAt >= -CODEX_TUI_SESSION_START_FUTURE_SLOP_MS && startedAt - candidate.tuiStartedAt <= CODEX_TUI_SESSION_START_SKEW_MS && alive(candidate.pid));
  return matches.length === 1 ? matches[0].pid : undefined;
}
function resolveCodexTuiOwner(record, candidates, alive = pidAlive) {
  if (record.agent !== "codex")
    return;
  if (typeof record.tuiPid === "number" && Number.isFinite(record.tuiPid) && alive(record.tuiPid)) {
    return record.tuiPid;
  }
  if (record.provisional === true && typeof record.pid === "number" && Number.isFinite(record.pid) && alive(record.pid)) {
    return record.pid;
  }
  const command = record.origin?.ppid_command;
  if (typeof command === "string") {
    const tokens = command.trim().split(/\s+/);
    if (basename5(tokens[0] ?? "") === "codex" && tokens[1] !== "app-server" && !tokens.slice(1).includes("exec") && typeof record.pid === "number" && alive(record.pid)) {
      return record.pid;
    }
  }
  return correlateCodexTuiPid(record, candidates, alive);
}
async function correctResolvedPlanPicker(config, path, sessionId, record, deps = {}) {
  try {
    if (record.pendingPlanPicker !== true)
      return "uncorrected";
    const now = (deps.now ?? Date.now)();
    if (planPickerPendingExpired(record, now)) {
      return await settlePendingPlanPickerDone(config, path, sessionId, record, now, deps);
    }
    let snapshot = record;
    let tuiPid = typeof snapshot.tuiPid === "number" && Number.isFinite(snapshot.tuiPid) ? snapshot.tuiPid : undefined;
    if (tuiPid === undefined && deps.tuiCandidates) {
      const correlated = correlateCodexTuiPid(snapshot, await deps.tuiCandidates(), deps.pidAlive ?? pidAlive);
      if (correlated !== undefined) {
        const readCurrent = deps.readRecord ?? readRecordAt;
        const fresh = await readCurrent(path);
        if (fresh && !recordMovedSince(snapshot, fresh) && fresh.turnId === snapshot.turnId && fresh.pendingPlanPicker === true) {
          snapshot = { ...fresh, tuiPid: correlated };
          await (deps.writeRecord ?? ((p, rec) => atomicWrite(p, JSON.stringify(rec), 384)))(path, snapshot);
          tuiPid = correlated;
        }
      }
    }
    if (tuiPid !== undefined && !(deps.pidAlive ?? pidAlive)(tuiPid)) {
      return await settlePendingPlanPickerDone(config, path, sessionId, snapshot, now, deps, "exit");
    }
    const agent = snapshot.agent === "codex" ? "codex" : "claude";
    const adapter2 = adapterFor(agent);
    if (!adapter2.completedTurnWaitState)
      return "uncorrected";
    const state = await (deps.state ?? (() => adapter2.completedTurnWaitState({
      pid: snapshot.pid,
      transcriptPath: typeof snapshot.transcript === "string" ? snapshot.transcript : undefined
    })))();
    if (state === "pending") {
      const threadState = deps.threadWaitState ? await deps.threadWaitState() : "unavailable";
      const daemonIdle = threadState === "notWaitingOnUserInput";
      tracePicker(sessionId, deps, {
        source: "watchdog",
        classifier: state,
        marker: "kept",
        daemonQuery: threadState,
        daemonIgnored: threadState !== "waitingOnUserInput",
        settle: daemonIdle ? "blocked" : "none"
      });
      return "uncorrected";
    }
    if (state !== "resolved") {
      tracePicker(sessionId, deps, { source: "watchdog", classifier: state, marker: "kept" });
      return "uncorrected";
    }
    const dbg = formatPlanPickerDebug({
      event: "resolve",
      classifier: state,
      marker: "0",
      ttl: markerAge(record, now),
      by: "wd"
    });
    const envelope = await buildWorkingEnvelope(sessionId, snapshot, now, config.e2eKey, agent, dbg);
    const next = {
      ...snapshot,
      ts: now,
      lastEvent: "working",
      sentDone: false,
      op: "update",
      prio: 0,
      blob: envelope.blob,
      pairingId: config.pairingId,
      pendingPlanPicker: undefined,
      planPickerPendingSince: undefined,
      planPickerSettled: undefined,
      dbg
    };
    await (deps.writeRecord ?? ((p, rec) => atomicWrite(p, JSON.stringify(rec), 384)))(path, next);
    let outcome;
    try {
      outcome = await (deps.post ?? ((body) => postEvent(config, body)))(envelope);
    } catch {
      tracePicker(sessionId, deps, {
        source: "watchdog",
        classifier: state,
        marker: "cleared",
        correctionPosted: false
      });
      return "pending";
    }
    tracePicker(sessionId, deps, {
      source: "watchdog",
      classifier: state,
      marker: "cleared",
      correctionPosted: outcome === "delivered"
    });
    if (outcome === "revoked")
      return "revoked";
    if (outcome !== "delivered")
      return "pending";
    return "corrected";
  } catch {
    return "uncorrected";
  }
}
var PLAN_PICKER_VERIFY_MAX_MS = 30000;
var PLAN_PICKER_PENDING_MAX_MS = 60 * 60000;
var PLAN_PICKER_RECENT_DONE_MS = 30 * 60000;
function shouldPlanPickerVerificationCheck(record, now) {
  if (record.agent !== "codex" || record.provisional === true)
    return false;
  if (typeof record.transcript !== "string" || record.transcript.length === 0)
    return false;
  if (record.planPickerVerificationPending === true)
    return true;
  if (record.planPickerSettled === true)
    return false;
  if (record.op !== "done" || record.lastEvent !== "done" || record.sentDone !== true)
    return false;
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts))
    return false;
  const age = now - record.ts;
  return age >= 0 && age <= PLAN_PICKER_RECENT_DONE_MS;
}
function planPickerPendingExpired(record, now) {
  if (record.planPickerVerificationPending !== true && record.pendingPlanPicker !== true)
    return false;
  const since = typeof record.planPickerPendingSince === "number" && Number.isFinite(record.planPickerPendingSince) ? record.planPickerPendingSince : typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : -Infinity;
  return now - since >= PLAN_PICKER_PENDING_MAX_MS;
}
async function correctPlanPickerVerification(config, path, sessionId, record, deps = {}) {
  try {
    const now = (deps.now ?? Date.now)();
    if (!shouldPlanPickerVerificationCheck(record, now))
      return "uncorrected";
    const recentDoneBackstop = record.planPickerVerificationPending !== true;
    const ownerPid = typeof record.tuiPid === "number" && Number.isFinite(record.tuiPid) ? record.tuiPid : record.pid;
    if (recentDoneBackstop && !(deps.pidAlive ?? pidAlive)(ownerPid)) {
      tracePicker(sessionId, deps, {
        source: "watchdog",
        classifier: "dead-pid",
        marker: record.planPickerSettled === true ? "settled" : "none"
      });
      return "uncorrected";
    }
    const readCurrent = deps.readRecord ?? readRecordAt;
    const writeRecord = deps.writeRecord ?? ((p, rec) => atomicWrite(p, JSON.stringify(rec), 384));
    const post = deps.post ?? ((body) => postEvent(config, body));
    const freshUnchanged = async () => {
      const fresh = await readCurrent(path);
      if (!fresh || recordMovedSince(record, fresh))
        return null;
      if (fresh.turnId !== record.turnId)
        return null;
      if (fresh.planPickerVerificationPending !== record.planPickerVerificationPending)
        return null;
      if (fresh.planPickerSettled !== record.planPickerSettled)
        return null;
      return fresh;
    };
    if (record.planPickerVerificationPending === true && planPickerPendingExpired(record, now)) {
      return await settlePendingPlanPickerDone(config, path, sessionId, record, now, deps);
    }
    const evidence = deps.evidence ? await deps.evidence() : deps.state ? { state: await deps.state() } : await codexAdapter.completedTurnWaitEvidence({
      pid: record.pid,
      transcriptPath: record.transcript
    });
    const state = evidence.state;
    if (state === "exited") {
      tracePicker(sessionId, deps, {
        source: "watchdog",
        classifier: state,
        marker: record.planPickerSettled === true ? "settled" : "kept"
      });
      return "uncorrected";
    }
    if (state === "resolved") {
      if (record.planPickerVerificationPending !== true) {
        tracePicker(sessionId, deps, {
          source: "watchdog",
          classifier: state,
          marker: record.planPickerSettled === true ? "settled" : "none"
        });
        return "uncorrected";
      }
      const fresh = await freshUnchanged();
      if (!fresh) {
        tracePicker(sessionId, deps, {
          source: "watchdog",
          classifier: "resolved-stale",
          marker: "kept",
          settle: "blocked"
        });
        return "uncorrected";
      }
      await writeRecord(path, {
        ...fresh,
        planPickerVerificationPending: undefined,
        planPickerPendingSince: undefined
      });
      tracePicker(sessionId, deps, {
        source: "watchdog",
        classifier: state,
        marker: "cleared"
      });
      return "pending";
    }
    if (state === "pending") {
      const threadState = deps.threadWaitState ? await deps.threadWaitState() : "unavailable";
      const daemonIgnored = threadState !== "waitingOnUserInput";
      const fresh = await freshUnchanged();
      if (!fresh) {
        tracePicker(sessionId, deps, {
          source: "watchdog",
          classifier: "pending-stale",
          marker: "kept",
          daemonQuery: threadState,
          daemonIgnored,
          settle: "blocked"
        });
        return "uncorrected";
      }
      const dbg = formatPlanPickerDebug({
        event: recentDoneBackstop ? "recorrect" : "verify",
        classifier: state,
        marker: "p",
        daemon: threadState === "waitingOnUserInput" ? "wait" : threadState === "notWaitingOnUserInput" ? "idle" : "na",
        daemonDisposition: daemonIgnored ? "ign" : "keep",
        ttl: markerAge(record, now),
        by: "wd"
      });
      const envelope = await buildNeedsAttentionEnvelope(sessionId, record, now, config.e2eKey, "codex", Math.floor(now / 1000), undefined, "userInput", evidence.plan, dbg);
      await writeRecord(path, {
        ...fresh,
        ts: now,
        lastEvent: "needsAttention",
        sentDone: false,
        op: "update",
        prio: 1,
        blob: envelope.blob,
        pairingId: config.pairingId,
        pendingPlanPicker: true,
        planPickerVerificationPending: undefined,
        planPickerPendingSince: now,
        planPickerSettled: undefined,
        donePending: undefined,
        doneAttempts: undefined,
        dbg
      });
      let outcome;
      try {
        outcome = await post(envelope);
      } catch {
        tracePicker(sessionId, deps, {
          source: "watchdog",
          classifier: state,
          marker: "set-pending",
          daemonQuery: threadState,
          daemonIgnored,
          settle: threadState === "notWaitingOnUserInput" ? "blocked" : "none",
          correctionPosted: false
        });
        return "pending";
      }
      tracePicker(sessionId, deps, {
        source: "watchdog",
        classifier: state,
        marker: "set-pending",
        daemonQuery: threadState,
        daemonIgnored,
        settle: threadState === "notWaitingOnUserInput" ? "blocked" : "none",
        correctionPosted: outcome === "delivered"
      });
      if (outcome === "revoked")
        return "revoked";
      if (outcome !== "delivered")
        return "pending";
      return "corrected";
    }
    if (record.planPickerVerificationPending !== true) {
      tracePicker(sessionId, deps, {
        source: "watchdog",
        classifier: state,
        marker: record.planPickerSettled === true ? "settled" : "none"
      });
      return "uncorrected";
    }
    const age = typeof record.ts === "number" && Number.isFinite(record.ts) ? now - record.ts : Infinity;
    if (age < PLAN_PICKER_VERIFY_MAX_MS) {
      tracePicker(sessionId, deps, { source: "watchdog", classifier: state, marker: "kept" });
      return "pending";
    }
    return await settlePendingPlanPickerDone(config, path, sessionId, record, now, deps);
  } catch {
    return "uncorrected";
  }
}
function buildHeartbeatEnvelope(sessionId, record, now, currentPairingId) {
  if (typeof record.blob !== "string" || record.blob.length === 0)
    return null;
  if (currentPairingId !== undefined && record.pairingId !== currentPairingId)
    return null;
  return { v: 2, sessionId, op: record.op ?? "update", prio: record.prio ?? 0, ts: now, blob: record.blob, ...startedAtField(record) };
}
function postOutcomeForStatus(status) {
  if (status >= 200 && status < 300)
    return "delivered";
  if (status === 404 || status === 410)
    return "revoked";
  return "failed";
}
function watchdogEventHeaders(config, approvals) {
  return {
    "content-type": "application/json",
    "x-cc-pairing": config.pairingId,
    "x-cc-auth": config.pcSecret,
    "x-cc-version": PLUGIN_VERSION,
    "x-cc-approvals": approvals,
    "x-cc-role": "watchdog"
  };
}
var activeLanListener;
var lanHintPublisher = createLanHintPublisher({ address: () => activeLanListener?.address() ?? null });
async function postEvent(config, body) {
  try {
    const lanHint = await lanHintPublisher.take(config);
    const payload = lanHint ? { ...body, lanHint } : body;
    const res = await fetch(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: watchdogEventHeaders(config, await localApprovalsState()),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000)
    });
    const outcome = postOutcomeForStatus(res.status);
    if (outcome === "delivered") {
      try {
        bufferCommands(extractCommands(await res.json()));
      } catch {}
    }
    return outcome;
  } catch {
    return "failed";
  }
}
var COMMAND_KINDS_ALLOWED = new Set(["focus-terminal"]);
var COMMANDS_PER_RESPONSE_MAX = 8;
var COMMAND_BUFFER_MAX = 32;
var EXECUTED_COMMAND_IDS_MAX = 64;
var SEEN_NONCES_MAX = 512;
var COMMAND_TTL_MS = 120000;
var COMMAND_FUTURE_SKEW_MS = 30000;
var commandBuffer = [];
var executedCommandIds = new Set;
var seenCommandNonces = new Set;
function extractCommands(body) {
  try {
    if (typeof body !== "object" || body === null)
      return [];
    const raw = body.commands;
    if (!Array.isArray(raw))
      return [];
    const out = [];
    for (const entry of raw) {
      if (out.length >= COMMANDS_PER_RESPONSE_MAX)
        break;
      if (typeof entry !== "object" || entry === null)
        continue;
      const e = entry;
      if (typeof e.id !== "string" || e.id.length === 0)
        continue;
      if (typeof e.blob !== "string" || e.blob.length === 0)
        continue;
      out.push({ id: e.id, blob: e.blob });
    }
    return out;
  } catch {
    return [];
  }
}
function parseCommandPayload(plain) {
  if (typeof plain !== "object" || plain === null)
    return;
  const p = plain;
  if (typeof p.kind !== "string" || p.kind.length === 0)
    return;
  if (typeof p.sessionId !== "string" || p.sessionId.length === 0)
    return;
  if (typeof p.ts !== "number" || !Number.isFinite(p.ts))
    return;
  if (typeof p.nonce !== "string" || p.nonce.length === 0)
    return;
  return { kind: p.kind, sessionId: p.sessionId, ts: p.ts, nonce: p.nonce };
}
function commandIsFresh(ts, now) {
  if (ts > now + COMMAND_FUTURE_SKEW_MS)
    return false;
  return now - ts <= COMMAND_TTL_MS;
}
function bufferCommands(commands) {
  for (const c of commands) {
    if (commandBuffer.length >= COMMAND_BUFFER_MAX)
      return;
    commandBuffer.push(c);
  }
}
function resetCommandState() {
  commandBuffer.length = 0;
  executedCommandIds.clear();
  seenCommandNonces.clear();
}
function traceFocus(deps, event) {
  if (deps.trace) {
    try {
      deps.trace(event);
    } catch {}
    return;
  }
  if (process.argv.some((arg) => arg === "test" || arg.endsWith(".test.ts")))
    return;
  traceSession(event);
}
async function releaseFocusedTuiUserInputHold(config, sessionId, now, deps) {
  const readHold = deps.readDecisionHoldFn ?? (lanRunningUnderTest() ? async () => null : (id) => readDecisionHoldAt(SESSIONS_DIR, id));
  const hold = await readHold(sessionId);
  const alive = hold && typeof hold.pid === "number" ? (deps.holdPidAliveFn ?? pidAlive)(hold.pid) : false;
  if (!stateHoldLive(hold, alive, now))
    return false;
  let card;
  try {
    const plain = await decryptBlob(config.e2eKey, hold.blob);
    if (typeof plain !== "object" || plain === null)
      return false;
    card = plain;
  } catch {
    return false;
  }
  const requestId = card.permissionRequestId;
  if (card.status !== "decisionPending" || card.agent !== "codex" || card.permissionToolName !== "request_user_input" || typeof requestId !== "string" || requestId.length === 0 || Object.prototype.hasOwnProperty.call(card, "permissionQuestions"))
    return false;
  const answerBlob = await encryptBlob(config.e2eKey, {
    requestId,
    decision: "allow",
    ts: Math.floor(now / 1000)
  });
  const stored = (deps.answerStore ?? lanAnswerStore).put(requestId, answerBlob, now);
  if (stored !== "stored")
    return false;
  try {
    Promise.resolve((deps.resolveDecisionFn ?? resolveOnRelay)(config, requestId)).catch(() => {});
  } catch {}
  return true;
}
async function drainCommands(config, deps = {}) {
  try {
    const pending = (deps.take ?? (() => commandBuffer.splice(0, commandBuffer.length)))();
    if (pending.length === 0)
      return 0;
    const readRecords = deps.readRecords ?? readAllRecordEntries;
    const focus = deps.focus ?? ((pid, context) => focusTerminalForPid(pid, { context }));
    const now = (deps.now ?? Date.now)();
    let entries = null;
    let focused = 0;
    const batchTargets = new Set;
    for (const cmd of pending) {
      const base = { event: "focus-terminal", id: cmd.id };
      try {
        if (executedCommandIds.has(cmd.id)) {
          traceFocus(deps, { ...base, result: "duplicate", why: "id" });
          continue;
        }
        rememberBounded(executedCommandIds, cmd.id, EXECUTED_COMMAND_IDS_MAX);
        let plain;
        try {
          plain = await decryptBlob(config.e2eKey, cmd.blob);
        } catch {
          traceFocus(deps, { ...base, result: "decrypt-failed" });
          continue;
        }
        const payload = parseCommandPayload(plain);
        if (!payload) {
          traceFocus(deps, { ...base, result: "malformed" });
          continue;
        }
        base.sessionId = payload.sessionId;
        base.kind = payload.kind;
        if (!COMMAND_KINDS_ALLOWED.has(payload.kind)) {
          traceFocus(deps, { ...base, result: "bad-kind" });
          continue;
        }
        if (!commandIsFresh(payload.ts, now)) {
          traceFocus(deps, { ...base, result: "stale", age: now - payload.ts });
          continue;
        }
        if (seenCommandNonces.has(payload.nonce)) {
          traceFocus(deps, { ...base, result: "replay" });
          continue;
        }
        rememberBounded(seenCommandNonces, payload.nonce, SEEN_NONCES_MAX);
        if (entries === null)
          entries = await readRecords();
        const entry = entries.find((e) => e.sessionId === payload.sessionId);
        if (!entry) {
          traceFocus(deps, { ...base, result: "unknown-session" });
          continue;
        }
        const target = `${payload.kind}|${payload.sessionId}`;
        if (batchTargets.has(target)) {
          traceFocus(deps, { ...base, result: "duplicate", why: "batch" });
          continue;
        }
        batchTargets.add(target);
        const agent = recordAgent(entry.rec);
        const adapter2 = deps.adapters ? deps.adapters.find((a) => a.kind === agent) ?? adapterFor(agent) : adapterFor(agent);
        if (!adapter2.locateTuiPid) {
          traceFocus(deps, { ...base, agent, result: "unsupported" });
          continue;
        }
        let reason;
        const pid = await adapter2.locateTuiPid({ sessionId: payload.sessionId, record: entry.rec }, { note: (r) => {
          reason = r;
        } });
        if (typeof pid !== "number" || !Number.isFinite(pid)) {
          const result2 = reason === "ambiguous" ? "ambiguous" : "no-candidate";
          traceFocus(deps, { ...base, agent, result: result2, reason: reason ?? "no-candidate" });
          continue;
        }
        const outcome = await focus(pid, { agent, record: entry.rec });
        if (outcome.ok) {
          focused += 1;
          const releasedTuiInput = await releaseFocusedTuiUserInputHold(config, payload.sessionId, now, deps).catch(() => false);
          traceFocus(deps, {
            ...base,
            agent,
            pid,
            result: "focused",
            via: outcome.via,
            reason: outcome.reason ?? reason,
            ...releasedTuiInput ? { releasedTuiInput: true } : {}
          });
          continue;
        }
        const result = outcome.reason === "herdr-ambiguous" ? "ambiguous" : outcome.reason === "osascript-failed" ? "osascript-failed" : outcome.reason === "unsupported" ? "unsupported" : "no-candidate";
        const focusReason = outcome.reason === "herdr-cli-failed" || outcome.reason === "herdr-ambiguous" ? outcome.reason : reason;
        traceFocus(deps, { ...base, agent, pid, result, why: outcome.reason, reason: focusReason });
      } catch {
        traceFocus(deps, { ...base, result: "no-candidate", why: "error" });
      }
    }
    return focused;
  } catch {
    return 0;
  }
}
var drainChain = Promise.resolve();
function enqueueDrainCommands(config, deps = {}) {
  const run = () => drainCommands(config, deps);
  const next = drainChain.then(run, run);
  drainChain = next.catch(() => {});
  return next;
}
var LAN_COMMAND_ID_PREFIX = "lan:";
function acceptLanCommand(command, deps = {}) {
  try {
    if (commandBuffer.length >= COMMAND_BUFFER_MAX)
      return Promise.resolve(0);
    commandBuffer.push({ id: `${LAN_COMMAND_ID_PREFIX}${command.nonce}`, blob: command.blob });
    return enqueueDrainCommands(command.config, deps).catch(() => 0);
  } catch {
    return Promise.resolve(0);
  }
}
var LAN_ANSWER_ECHO_DELAY_MS = 5000;
function acceptLanAnswer(answer, deps = {}) {
  try {
    const resolve2 = deps.resolveFn ?? ((config, requestId) => resolveOnRelay(config, requestId, fetch));
    const delayMs = deps.delayMs ?? LAN_ANSWER_ECHO_DELAY_MS;
    const sleep = deps.sleep ?? ((ms) => new Promise((done) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
    }));
    return (delayMs > 0 ? sleep(delayMs) : Promise.resolve()).then(() => resolve2(answer.config, answer.requestId)).catch(() => {
      traceFocus(deps, { event: "lan", result: "echo-failed", requestId: answer.requestId });
    });
  } catch {
    return Promise.resolve();
  }
}
function machineName(config) {
  return config.machineName ?? hostname4().replace(/\.local$/, "");
}
async function readAllRecordEntries() {
  try {
    const files = await readdir4(SESSIONS_DIR);
    const out = [];
    for (const f of files) {
      if (!f.endsWith(".json"))
        continue;
      try {
        out.push({ sessionId: basename5(f, ".json"), rec: JSON.parse(await readFile8(`${SESSIONS_DIR}/${f}`, "utf8")) });
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}
async function readAllRecords() {
  return (await readAllRecordEntries()).map((e) => e.rec);
}
async function buildProvisionalBlob(d, machine, blobAgentFields, e2eKey, at) {
  const base = {
    status: d.idle === true ? "done" : "working",
    title: d.title ?? "",
    machine,
    label: d.label,
    ...blobAgentFields,
    ...typeof at === "number" && Number.isFinite(at) ? { at } : {}
  };
  const dbg = appendCodexBridgeMarker(blobAgentFields.agent === "codex" ? formatPlanPickerDebug({
    event: "discover",
    classifier: d.idle === true ? "done" : "work",
    marker: "0",
    by: "wd"
  }) : undefined, codexBridgeIsDown());
  return encryptBlob(e2eKey, appendFittedPlanAndDebug(base, undefined, dbg));
}
function buildProvisionalEnvelope(sessionId, blob, now, idle) {
  return { v: 2, sessionId, op: idle ? "done" : "start", prio: 0, ts: now, blob };
}
function buildStartEnvelope(sessionId, blob, now) {
  return buildProvisionalEnvelope(sessionId, blob, now, false);
}
function buildProvisionalRecord(d, machine, blob, blobAgentFields, now, pairingId, idle = false) {
  return {
    pid: d.pid,
    machine,
    label: d.label,
    ts: now,
    lastEvent: idle ? "done" : "sessionStart",
    op: idle ? "done" : "start",
    ...idle ? { sentDone: true } : {},
    prio: 0,
    blob,
    provisional: true,
    ...typeof d.cwd === "string" && d.cwd.length > 0 ? { tuiCwd: d.cwd } : {},
    ...typeof d.startedAt === "number" && Number.isFinite(d.startedAt) ? { tuiStartedAt: d.startedAt } : {},
    ...typeof d.title === "string" && d.title.length > 0 ? { title: d.title } : {},
    ...blobAgentFields,
    ...blobAgentFields.agent === "codex" ? { dbg: appendCodexBridgeMarker(formatPlanPickerDebug({
      event: "discover",
      classifier: idle ? "done" : "work",
      marker: "0",
      by: "wd"
    }), codexBridgeIsDown()) } : {},
    ...typeof pairingId === "string" && pairingId.length > 0 ? { pairingId } : {}
  };
}
async function discoverLiveSessions(config, deps = {}) {
  const adapters = deps.adapters ?? allAdapters;
  const post = deps.post ?? ((body) => postEvent(config, body));
  const readRecords = deps.readRecords ?? readAllRecords;
  const writeRecord = deps.writeRecord ?? ((sessionId, rec) => atomicWrite(`${SESSIONS_DIR}/${sessionId}.json`, JSON.stringify(rec), 384));
  const now = deps.now ?? Date.now;
  const machine = machineName(config);
  const known = await readRecords();
  for (const adapter2 of adapters) {
    if (!adapter2.discoverLive)
      continue;
    let discovered;
    try {
      discovered = await adapter2.discoverLive(known);
    } catch {
      continue;
    }
    for (const d of discovered) {
      const ts = now();
      const idle = d.idle === true;
      const blob = await buildProvisionalBlob(d, machine, adapter2.blobAgentFields, config.e2eKey, Math.floor(ts / 1000));
      const outcome = await post(buildProvisionalEnvelope(d.sessionId, blob, ts, idle));
      if (outcome !== "delivered")
        continue;
      await writeRecord(d.sessionId, buildProvisionalRecord(d, machine, blob, adapter2.blobAgentFields, ts, config.pairingId, idle));
    }
  }
}
function recordAgent(record) {
  return record.agent === "codex" ? "codex" : "claude";
}
function provisionalsCoveredByReal(entries, adapters = allAdapters) {
  const discoveryCapable = new Set(adapters.filter((a) => typeof a.discoverLive === "function").map((a) => a.kind));
  const realPids = new Set(entries.filter((e) => e.rec.provisional !== true && discoveryCapable.has(recordAgent(e.rec)) && typeof e.rec.pid === "number").map((e) => e.rec.pid));
  return entries.filter((e) => e.rec.provisional === true && typeof e.rec.pid === "number" && realPids.has(e.rec.pid)).map((e) => e.sessionId);
}
async function reconcileProvisionalsSweep(config, deps = {}) {
  const post = deps.post ?? ((body) => postEvent(config, body));
  const readEntries = deps.readEntries ?? readAllRecordEntries;
  const deleteRecord = deps.deleteRecord ?? ((sessionId) => unlink4(`${SESSIONS_DIR}/${sessionId}.json`).catch(() => {}));
  const now = deps.now ?? Date.now;
  const entries = await readEntries();
  for (const sessionId of provisionalsCoveredByReal(entries, deps.adapters ?? allAdapters)) {
    const outcome = await post(buildEndEnvelope(sessionId, now()));
    if (outcome === "delivered")
      await deleteRecord(sessionId);
  }
}
var INTERRUPT_TAIL_BYTES = 8 * 1024;
var WORKING_STALE_MS = 20000;
var INTERRUPT_DONE_MAX_ATTEMPTS = 5;
function tailShowsInterrupt(tail, agent) {
  return adapterFor(agent).detectInterrupt(tail);
}
function shouldInterruptCheck(record, now) {
  if (typeof record.transcript !== "string" || record.transcript.length === 0)
    return false;
  if (record.lastEvent === "needsAttention")
    return true;
  if (record.lastEvent === "working") {
    return typeof record.ts === "number" && now - record.ts > WORKING_STALE_MS;
  }
  return false;
}
async function correctInterrupt(config, path, sessionId, record, now, deps = {}) {
  const post = deps.post ?? ((body) => postEvent(config, body));
  const readTail = deps.readTail ?? ((p, bytes) => readSuffix(p, bytes));
  const writeRecord = deps.writeRecord ?? ((p, rec) => atomicWrite(p, JSON.stringify(rec), 384));
  const clock = deps.now ?? Date.now;
  try {
    if (!shouldInterruptCheck(record, now))
      return "uncorrected";
    let tail;
    try {
      tail = await readTail(record.transcript, INTERRUPT_TAIL_BYTES);
    } catch {
      return "uncorrected";
    }
    const agent = record.agent === "codex" ? "codex" : "claude";
    if (!tailShowsInterrupt(tail, agent))
      return "uncorrected";
    const attempts = effectiveDoneAttempts(record, sessionId);
    if (attempts >= INTERRUPT_DONE_MAX_ATTEMPTS) {
      try {
        await writeRecord(path, { ...record, lastEvent: "done", sentDone: true, op: "done", doneAttempts: undefined });
        clearDoneAttempts(sessionId);
      } catch {}
      return "pending";
    }
    const doneNow = clock();
    const outcome = await post(await buildDoneEnvelope(sessionId, record, doneNow, config.e2eKey, agent, Math.floor(doneNow / 1000)));
    if (outcome === "revoked")
      return "revoked";
    if (outcome === "delivered") {
      try {
        await writeRecord(path, { ...record, lastEvent: "done", sentDone: true, op: "done", doneAttempts: undefined });
      } catch {}
      clearDoneAttempts(sessionId);
      return "corrected";
    }
    noteDoneAttempt(sessionId, attempts + 1);
    try {
      await writeRecord(path, { ...record, doneAttempts: attempts + 1 });
    } catch {}
    return "pending";
  } catch {
    return "uncorrected";
  }
}
function shouldPendingApprovalCheck(record, adapter2) {
  if (!adapter2.tailShowsPendingApproval)
    return false;
  if (typeof record.transcript !== "string" || record.transcript.length === 0)
    return false;
  if (record.lastEvent === "needsAttention")
    return false;
  if (record.lastEvent === "done" || record.op === "done")
    return false;
  return true;
}
async function correctPendingApproval(config, path, sessionId, record, now, deps = {}) {
  const post = deps.post ?? ((body) => postEvent(config, body));
  const readTail = deps.readTail ?? ((p, bytes) => readSuffix(p, bytes));
  const writeRecord = deps.writeRecord ?? ((p, rec) => atomicWrite(p, JSON.stringify(rec), 384));
  const clock = deps.now ?? Date.now;
  try {
    const agent = record.agent === "codex" ? "codex" : "claude";
    const adapter2 = adapterFor(agent);
    if (!shouldPendingApprovalCheck(record, adapter2))
      return "uncorrected";
    let tail;
    try {
      tail = await readTail(record.transcript, INTERRUPT_TAIL_BYTES);
    } catch {
      return "uncorrected";
    }
    if (!adapter2.tailShowsPendingApproval(tail))
      return "uncorrected";
    const detail = adapter2.tailPendingAttentionDetail?.(tail);
    const attentionKind = adapter2.tailPendingAttentionKind?.(tail);
    const attnNow = clock();
    const envelope = await buildNeedsAttentionEnvelope(sessionId, record, attnNow, config.e2eKey, agent, Math.floor(attnNow / 1000), detail, attentionKind);
    const outcome = await post(envelope);
    if (outcome === "revoked")
      return "revoked";
    if (outcome !== "delivered")
      return "uncorrected";
    try {
      const next = {
        ...record,
        lastEvent: "needsAttention",
        op: "update",
        prio: 1,
        sentDone: false,
        ...typeof envelope.blob === "string" ? { blob: envelope.blob } : {},
        attentionKind
      };
      await writeRecord(path, next);
    } catch {}
    return "corrected";
  } catch {
    return "uncorrected";
  }
}
function shouldIdleProvisionalCheck(record, adapter2) {
  if (!adapter2.pidTurnActive)
    return false;
  if (record.provisional !== true)
    return false;
  if (record.op === "done" || record.lastEvent === "done")
    return false;
  if (typeof record.pid !== "number" || !Number.isFinite(record.pid))
    return false;
  return true;
}
async function correctIdleProvisional(config, path, sessionId, record) {
  try {
    const agent = record.agent === "codex" ? "codex" : "claude";
    const adapter2 = adapterFor(agent);
    if (!shouldIdleProvisionalCheck(record, adapter2))
      return "uncorrected";
    let active = false;
    try {
      active = await adapter2.pidTurnActive(record.pid);
    } catch {}
    if (active)
      return "uncorrected";
    const idleNow = Date.now();
    const outcome = await postEvent(config, await buildDoneEnvelope(sessionId, record, idleNow, config.e2eKey, agent, Math.floor(idleNow / 1000)));
    if (outcome === "revoked")
      return "revoked";
    if (outcome !== "delivered")
      return "uncorrected";
    try {
      const next = { ...record, lastEvent: "done", sentDone: true, op: "done" };
      await atomicWrite(path, JSON.stringify(next), 384);
    } catch {}
    return "corrected";
  } catch {
    return "uncorrected";
  }
}
var CLAUDE_IDLE_REAP_MS = 1800000;
var CLAUDE_IDLE_REAP_MAX_ATTEMPTS = 5;
function transcriptMtimeMsDefault(path) {
  try {
    return statSync3(path).mtimeMs;
  } catch {
    return;
  }
}
function isClaudeIdleReapEligible(record, now, transcriptMtimeMs = transcriptMtimeMsDefault) {
  if (record.agent === "codex")
    return false;
  if (record.provisional === true)
    return false;
  return idleReapAgeEligible(record, now, transcriptMtimeMs);
}
function idleReapAgeEligible(record, now, transcriptMtimeMs = transcriptMtimeMsDefault) {
  if (record.lastEvent !== "working" && record.lastEvent !== "sessionStart")
    return false;
  if (typeof record.ts !== "number")
    return false;
  if (now - record.ts < CLAUDE_IDLE_REAP_MS)
    return false;
  if (typeof record.transcript === "string" && record.transcript.length > 0) {
    try {
      const m = transcriptMtimeMs(record.transcript);
      if (typeof m === "number" && Number.isFinite(m) && now - m < CLAUDE_IDLE_REAP_MS)
        return false;
    } catch {}
  }
  return true;
}
async function correctIdleClaude(config, path, sessionId, record, now, deps = {}) {
  const post = deps.post ?? ((body) => postEvent(config, body));
  const writeRecord = deps.writeRecord ?? ((p, rec) => atomicWrite(p, JSON.stringify(rec), 384));
  const clock = deps.now ?? Date.now;
  try {
    const agent = record.agent === "codex" ? "codex" : "claude";
    if (agent === "codex") {
      if (record.provisional === true || !idleReapAgeEligible(record, now) || typeof record.transcript !== "string" || record.transcript.length === 0)
        return "uncorrected";
      let tuiPid = typeof record.tuiPid === "number" && Number.isFinite(record.tuiPid) ? record.tuiPid : undefined;
      if (tuiPid === undefined) {
        const locate = deps.locateTuiPid ?? locateCodexOwnedTui;
        try {
          tuiPid = await locate(sessionId, record);
        } catch {
          return "uncorrected";
        }
      }
      if (typeof tuiPid !== "number" || !Number.isFinite(tuiPid) || !(deps.pidAlive ?? pidAlive)(tuiPid)) {
        return "uncorrected";
      }
      const transcript = record.transcript;
      const active = deps.codexTurnActive ?? (async (_pid, path2) => {
        const tail = await readSuffix(path2, 8 * 1024);
        return codexTurnActiveFromTail(tail, Date.now() - statSync3(path2).mtimeMs);
      });
      try {
        if (await active(tuiPid, transcript))
          return "uncorrected";
      } catch {
        return "uncorrected";
      }
      record = { ...record, tuiPid };
    } else if (!isClaudeIdleReapEligible(record, now)) {
      return "uncorrected";
    }
    const attempts = effectiveDoneAttempts(record, sessionId);
    if (attempts >= CLAUDE_IDLE_REAP_MAX_ATTEMPTS) {
      try {
        await writeRecord(path, { ...record, lastEvent: "done", sentDone: true, op: "done", doneAttempts: undefined });
        clearDoneAttempts(sessionId);
      } catch {}
      return "pending";
    }
    const doneNow = clock();
    const outcome = await post(await buildDoneEnvelope(sessionId, record, doneNow, config.e2eKey, agent, Math.floor(record.ts / 1000)));
    if (outcome === "revoked")
      return "revoked";
    if (outcome === "delivered") {
      try {
        await writeRecord(path, { ...record, lastEvent: "done", sentDone: true, op: "done", doneAttempts: undefined });
      } catch {}
      clearDoneAttempts(sessionId);
      return "corrected";
    }
    noteDoneAttempt(sessionId, attempts + 1);
    try {
      await writeRecord(path, { ...record, doneAttempts: attempts + 1 });
    } catch {}
    return "pending";
  } catch {
    return "uncorrected";
  }
}
var PENDING_DONE_MAX_ATTEMPTS = 5;
function shouldPendingDoneCheck(record) {
  if (record.donePending !== true)
    return false;
  if (record.provisional === true)
    return false;
  return true;
}
async function correctPendingDone(config, path, sessionId, record, now, deps = {}) {
  const post = deps.post ?? ((body) => postEvent(config, body));
  const writeRecord = deps.writeRecord ?? ((p, rec) => atomicWrite(p, JSON.stringify(rec), 384));
  const reread = deps.readRecord ?? readRecordAt;
  const freshRecord = async () => {
    try {
      return await reread(path);
    } catch {
      return null;
    }
  };
  const clock = deps.now ?? Date.now;
  try {
    if (!shouldPendingDoneCheck(record))
      return "uncorrected";
    const agent = record.agent === "codex" ? "codex" : "claude";
    const settled = {
      ...record,
      lastEvent: "done",
      sentDone: true,
      op: "done",
      donePending: undefined,
      doneAttempts: undefined
    };
    const attempts = effectiveDoneAttempts(record, sessionId);
    if (attempts >= PENDING_DONE_MAX_ATTEMPTS) {
      const write = pendingDoneSettleWrite(record, await freshRecord(), settled);
      if (!write) {
        clearDoneAttempts(sessionId);
        return "pending";
      }
      try {
        await writeRecord(path, write);
        clearDoneAttempts(sessionId);
      } catch {}
      traceFocus(deps, { event: "pending-done", sessionId, outcome: "capped", attempts, delivered: false });
      return "pending";
    }
    const at = typeof record.ts === "number" && Number.isFinite(record.ts) ? Math.floor(record.ts / 1000) : undefined;
    const outcome = await post(await buildDoneEnvelope(sessionId, record, clock(), config.e2eKey, agent, at));
    traceFocus(deps, {
      event: "pending-done",
      sessionId,
      outcome,
      attempts,
      delivered: outcome === "delivered",
      at
    });
    if (outcome === "revoked")
      return "revoked";
    if (outcome === "delivered") {
      const write = pendingDoneSettleWrite(record, await freshRecord(), settled);
      if (write) {
        try {
          await writeRecord(path, write);
        } catch {}
      }
      clearDoneAttempts(sessionId);
      return "corrected";
    }
    const retry = pendingDoneRetryWrite(record, await freshRecord(), attempts + 1);
    noteDoneAttempt(sessionId, attempts + 1);
    if (retry) {
      try {
        await writeRecord(path, retry);
      } catch {}
    }
    return "pending";
  } catch {
    return "uncorrected";
  }
}
var RETIRE_AFTER_MS = PLAN_PICKER_PENDING_MAX_MS + 15 * 60000;
function isRetireEligible(record, now) {
  if (typeof record.retiredAt === "number" && Number.isFinite(record.retiredAt))
    return false;
  if (record.provisional === true && record.agent !== "codex")
    return false;
  if (record.op !== "done" && record.lastEvent !== "done")
    return false;
  if (typeof record.ts !== "number")
    return false;
  return now - record.ts >= RETIRE_AFTER_MS;
}
async function retireDoneStale(config, path, sessionId, record, now, deps = {}) {
  const post = deps.post ?? ((body) => postEvent(config, body));
  const deleteRecord = deps.deleteRecord ?? ((p) => unlink4(p).catch(() => {}));
  const writeRecord = deps.writeRecord ?? ((p, rec) => atomicWrite(p, JSON.stringify(rec), 384));
  const alive = deps.pidAlive ?? pidAlive;
  const locateTuiPid = deps.locateTuiPid ?? locateCodexOwnedTui;
  const reread = deps.readRecord ?? readRecordAt;
  const freshRecord = async () => {
    try {
      return await reread(path);
    } catch {
      return null;
    }
  };
  const breadcrumb = (outcome, tuiPid) => traceFocus(deps, {
    event: "retire",
    reason: "idle-done",
    sessionId,
    recordTs: record.ts,
    ageMs: typeof record.ts === "number" ? now - record.ts : undefined,
    tuiPid,
    outcome
  });
  try {
    if (!isRetireEligible(record, now))
      return "skip";
    let tuiPid;
    if (record.agent === "codex") {
      const cached = typeof record.tuiPid === "number" && Number.isFinite(record.tuiPid) ? record.tuiPid : undefined;
      if (cached !== undefined && alive(cached))
        tuiPid = cached;
      if (tuiPid === undefined) {
        try {
          const located = await locateTuiPid(sessionId, record);
          if (typeof located === "number" && Number.isFinite(located) && alive(located))
            tuiPid = located;
        } catch {}
      }
    }
    const before = await freshRecord();
    if (before && (recordMovedSince(record, before) || !isRetireEligible(before, now))) {
      breadcrumb("skip-woken", tuiPid);
      return "skip";
    }
    const outcome = await post(buildEndEnvelope(sessionId, now, record, Math.floor(record.ts / 1000)));
    if (outcome === "revoked") {
      breadcrumb("revoked", tuiPid);
      return "revoked";
    }
    const after = await freshRecord();
    if (after && recordMovedSince(record, after)) {
      breadcrumb("skip-woken-post", tuiPid);
      return "skip";
    }
    heartbeatAt.delete(sessionId);
    clearDoneAttempts(sessionId);
    if (record.agent === "codex" && tuiPid !== undefined) {
      await writeRecord(path, {
        pid: tuiPid,
        machine: record.machine,
        label: record.label,
        ts: record.ts,
        agent: "codex",
        tuiPid,
        retiredAt: now
      });
    } else {
      await deleteRecord(path);
    }
    const verdict = outcome === "delivered" ? "retired" : "retired-offline";
    breadcrumb(verdict, tuiPid);
    return verdict;
  } catch {
    return "skip";
  }
}
var TITLE_REPAIR_HEAD_BYTES = 128 * 1024;
function statusFromRecord(record) {
  if (record.lastEvent === "needsAttention")
    return "needsAttention";
  if (record.lastEvent === "done")
    return "done";
  return "working";
}
async function buildTitleRepairEnvelope(sessionId, record, title, now, e2eKey, agent = "codex", at) {
  const base = {
    status: statusFromRecord(record),
    title,
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    ...adapterFor(agent).blobAgentFields,
    ...typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {},
    ...typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {},
    ...typeof at === "number" && Number.isFinite(at) ? { at } : {}
  };
  const dbg = appendCodexBridgeMarker(agent === "codex" ? record.dbg ?? formatPlanPickerDebug({
    event: "title",
    classifier: statusFromRecord(record),
    marker: record.pendingPlanPicker ? "p" : record.planPickerVerificationPending ? "v" : record.planPickerSettled ? "s" : "0",
    by: "wd"
  }) : undefined, codexBridgeIsDown());
  const blob = await encryptBlob(e2eKey, appendFittedPlanAndDebug(base, undefined, dbg));
  return { v: 2, sessionId, op: record.op ?? "update", prio: record.prio ?? 0, ts: now, blob, ...startedAtField(record) };
}
function shouldRepairTitle(record) {
  if (record.agent !== "codex")
    return false;
  if (record.provisional === true)
    return false;
  return typeof record.title !== "string" || record.title.length === 0;
}
function titleRepairedRecord(record, title, blob, pairingId) {
  return { ...record, title, blob, ...pairingId.length > 0 ? { pairingId } : {} };
}
async function repairTitle(config, path, sessionId, record) {
  try {
    if (!shouldRepairTitle(record))
      return "uncorrected";
    let prefix = "";
    if (typeof record.transcript === "string" && record.transcript.length > 0) {
      try {
        prefix = await readPrefix(record.transcript, TITLE_REPAIR_HEAD_BYTES);
      } catch {}
    }
    const title = await codexAdapter.title({ sessionId, prefix, input: {}, transcriptPath: record.transcript });
    if (!title)
      return "uncorrected";
    const repairNow = Date.now();
    const envelope = await buildTitleRepairEnvelope(sessionId, record, title, repairNow, config.e2eKey, "codex", Math.floor(repairNow / 1000));
    const outcome = await postEvent(config, envelope);
    if (outcome === "revoked")
      return "revoked";
    if (outcome !== "delivered")
      return "uncorrected";
    try {
      const next = titleRepairedRecord(record, title, envelope.blob, config.pairingId);
      await atomicWrite(path, JSON.stringify(next), 384);
    } catch {}
    return "corrected";
  } catch {
    return "uncorrected";
  }
}
function shouldHeartbeat(record, now, lastHeartbeat, correctedThisSweep) {
  if (record.op === "done")
    return false;
  if (typeof record.doneAttempts === "number" && record.doneAttempts > 0)
    return false;
  if (isClaudeIdleReapEligible(record, now))
    return false;
  if (correctedThisSweep)
    return false;
  if (typeof record.ts !== "number")
    return false;
  if (now - record.ts < HEARTBEAT_AFTER_MS)
    return false;
  if (lastHeartbeat !== undefined && now - lastHeartbeat < HEARTBEAT_AFTER_MS)
    return false;
  return true;
}
var WAITING_HEARTBEAT_AFTER_MS = 5000;
function isWaitingSession(record) {
  if (record.op === "done" || record.lastEvent === "done")
    return false;
  return record.lastEvent === "needsAttention" || record.pendingPlanPicker === true || record.prio === 1;
}
function shouldWaitingHeartbeat(record, now, lastWaitingBeat, correctedThisSweep) {
  if (!isWaitingSession(record))
    return false;
  if (typeof record.doneAttempts === "number" && record.doneAttempts > 0)
    return false;
  if (isClaudeIdleReapEligible(record, now))
    return false;
  if (correctedThisSweep)
    return false;
  if (typeof record.ts !== "number")
    return false;
  if (now - record.ts < WAITING_HEARTBEAT_AFTER_MS)
    return false;
  if (lastWaitingBeat !== undefined && now - lastWaitingBeat < WAITING_HEARTBEAT_AFTER_MS)
    return false;
  return true;
}
function heartbeatKind(record, now, lastHeartbeat, lastWaitingBeat, correctedThisSweep) {
  if (shouldHeartbeat(record, now, lastHeartbeat, correctedThisSweep))
    return "stale";
  if (shouldWaitingHeartbeat(record, now, lastWaitingBeat, correctedThisSweep))
    return "waiting";
  return "none";
}
var waitingBeatAt;
async function sweep(config, deps = {}) {
  let files;
  try {
    files = await readdir4(SESSIONS_DIR);
  } catch {
    return { revoked: false, remaining: 0, delivered: false };
  }
  const now = Date.now();
  let remaining = 0;
  let delivered = false;
  for (const file of files) {
    if (!file.endsWith(".json"))
      continue;
    const path = `${SESSIONS_DIR}/${file}`;
    const sessionId = basename5(file, ".json");
    let record = null;
    try {
      record = JSON.parse(await readFile8(path, "utf8"));
    } catch {
      record = null;
    }
    const verdict = classifySession(record, now, pidAlive);
    if (verdict === "keep" && record?.agent === "codex" && typeof record.retiredAt === "number" && Number.isFinite(record.retiredAt)) {
      remaining++;
      continue;
    }
    if (verdict === "keep") {
      let planVerificationHandled = false;
      if (config && record) {
        const verification = await correctPlanPickerVerification(config, path, sessionId, record, {
          ...deps.threadWaitState ? { threadWaitState: () => deps.threadWaitState(sessionId) } : {}
        });
        if (verification === "revoked")
          return { revoked: true };
        if (verification === "corrected")
          delivered = true;
        planVerificationHandled = verification === "corrected" || verification === "pending";
      }
      if (planVerificationHandled) {
        remaining++;
        continue;
      }
      let pendingDoneHandled = false;
      if (config && record) {
        const pendingDone = await correctPendingDone(config, path, sessionId, record, now);
        if (pendingDone === "revoked")
          return { revoked: true };
        if (pendingDone === "corrected")
          delivered = true;
        pendingDoneHandled = pendingDone === "corrected" || pendingDone === "pending";
      }
      if (config && record && !pendingDoneHandled) {
        const retire = await retireDoneStale(config, path, sessionId, record, now);
        if (retire === "revoked")
          return { revoked: true };
        if (retire !== "skip") {
          if (retire === "retired")
            delivered = true;
          continue;
        }
      }
      remaining++;
      if (config && record && !pendingDoneHandled) {
        const idleFix = await correctIdleProvisional(config, path, sessionId, record);
        if (idleFix === "revoked")
          return { revoked: true };
        if (idleFix === "corrected")
          delivered = true;
        const planResolution = await correctResolvedPlanPicker(config, path, sessionId, record, {
          ...deps.threadWaitState ? { threadWaitState: () => deps.threadWaitState(sessionId) } : {},
          tuiCandidates: readAllRecords
        });
        if (planResolution === "revoked")
          return { revoked: true };
        const resolvedPlan = planResolution === "corrected";
        const planResolutionHandled = resolvedPlan || planResolution === "pending";
        if (resolvedPlan)
          delivered = true;
        const corrected = planResolutionHandled ? "uncorrected" : await correctInterrupt(config, path, sessionId, record, now);
        if (corrected === "revoked")
          return { revoked: true };
        if (corrected === "corrected")
          delivered = true;
        const interruptHandled = corrected === "corrected" || corrected === "pending";
        let flaggedAttention = false;
        if (!planResolutionHandled && !interruptHandled) {
          const attn = await correctPendingApproval(config, path, sessionId, record, now);
          if (attn === "revoked")
            return { revoked: true };
          if (attn === "corrected") {
            delivered = true;
            flaggedAttention = true;
          }
        }
        let reapedIdle = false;
        if (idleFix !== "corrected" && !planResolutionHandled && !interruptHandled && !flaggedAttention) {
          const idleClaude = await correctIdleClaude(config, path, sessionId, record, now);
          if (idleClaude === "revoked")
            return { revoked: true };
          if (idleClaude === "corrected" || idleClaude === "pending")
            reapedIdle = true;
          if (idleClaude === "corrected")
            delivered = true;
        }
        let repairedTitle = false;
        if (idleFix !== "corrected" && !planResolutionHandled && !interruptHandled && !flaggedAttention && !reapedIdle) {
          const titleFix = await repairTitle(config, path, sessionId, record);
          if (titleFix === "revoked")
            return { revoked: true };
          if (titleFix === "corrected") {
            delivered = true;
            repairedTitle = true;
          }
        }
        const beatKind = heartbeatKind(record, now, heartbeatAt.get(sessionId), waitingBeatAt, idleFix === "corrected" || planResolutionHandled || interruptHandled || flaggedAttention || reapedIdle || repairedTitle);
        if (beatKind !== "none") {
          const beat = buildHeartbeatEnvelope(sessionId, record, Date.now(), config.pairingId);
          if (beat) {
            const outcome = await postEvent(config, beat);
            if (outcome === "revoked")
              return { revoked: true };
            if (outcome === "delivered") {
              heartbeatAt.set(sessionId, now);
              if (beatKind === "waiting")
                waitingBeatAt = now;
              delivered = true;
            }
          }
        }
      }
      continue;
    }
    if (verdict === "end" && config && record) {
      const outcome = await postEvent(config, buildEndEnvelope(sessionId, now, record));
      if (outcome === "revoked")
        return { revoked: true };
      if (outcome !== "delivered") {
        remaining++;
        continue;
      }
      delivered = true;
    }
    if (verdict === "stale" && config && record) {
      const outcome = await postEvent(config, buildEndEnvelope(sessionId, now, record));
      if (outcome === "revoked")
        return { revoked: true };
      if (outcome === "delivered")
        delivered = true;
    }
    heartbeatAt.delete(sessionId);
    clearDoneAttempts(sessionId);
    try {
      await unlink4(path);
    } catch {}
  }
  return { revoked: false, remaining, delivered };
}
async function goneStrikeShouldTeardown(goneStrikesPath) {
  return await recordGoneStrike(goneStrikesPath) >= GONE_STRIKE_LIMIT;
}
var activeBridgeShutdown;
var activeLanShutdown;
var BRIDGE_OP_DEADLINE_MS = 15000;
var PLAN_PICKER_STATUS_QUERY_DEADLINE_MS = 2000;
function withDeadline(work, ms) {
  let timer;
  const deadline = new Promise((resolve2) => {
    timer = setTimeout(() => resolve2(undefined), ms);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer)
      clearTimeout(timer);
  });
}
var BRIDGE_REARM_MS = 600000;
var GIVE_UP_PATTERN = /gave up/i;
var BRIDGE_DAEMON_START_COOLDOWN_MS = 300000;
var codexBridgeDown = false;
function setCodexBridgeDown(down) {
  codexBridgeDown = down;
}
function codexBridgeIsDown() {
  return codexBridgeDown;
}
function createBridgeSupervisor(deps = {}) {
  const probe = deps.probe ?? (() => codexAppServerSocketAvailable());
  const create = deps.create ?? ((config, options) => new CodexRemoteInputBridge(config, options));
  const detach = deps.detach ?? ((work) => {
    withDeadline(Promise.resolve().then(work), BRIDGE_OP_DEADLINE_MS).catch(() => {});
  });
  const now = deps.now ?? Date.now;
  const startDaemon = deps.startDaemon ?? (lanRunningUnderTest() ? async () => false : () => startCodexAppServerDaemon());
  const trace = deps.trace ?? ((event) => traceSession(event));
  let bridge;
  let pairingId;
  let lastStartAt = 0;
  let parked = false;
  let daemonDown = false;
  let lastDaemonStartAt = 0;
  const onError = (error) => {
    try {
      if (GIVE_UP_PATTERN.test(error.message))
        parked = true;
    } catch {}
    try {
      deps.onError?.(error);
    } catch {}
  };
  const teardown = () => {
    const dying = bridge;
    bridge = undefined;
    pairingId = undefined;
    parked = false;
    if (dying)
      detach(() => dying.stop());
  };
  const arm = (target) => {
    lastStartAt = now();
    parked = false;
    detach(() => target.start());
  };
  const tryStartDaemon = () => {
    const at = now();
    if (lastDaemonStartAt !== 0 && at - lastDaemonStartAt < BRIDGE_DAEMON_START_COOLDOWN_MS)
      return;
    lastDaemonStartAt = at;
    try {
      trace({ event: "codex-daemon-start", outcome: "attempt" });
    } catch {}
    detach(async () => {
      await startDaemon().catch(() => false);
    });
  };
  return {
    async sync(config) {
      if (!config) {
        teardown();
        daemonDown = false;
        return;
      }
      let available = false;
      try {
        available = await probe();
      } catch {
        available = false;
      }
      if (!available) {
        teardown();
        daemonDown = true;
        tryStartDaemon();
        return;
      }
      daemonDown = false;
      if (!bridge || pairingId !== config.pairingId) {
        teardown();
        const next = create(config, { onError });
        bridge = next;
        pairingId = config.pairingId;
        arm(next);
        return;
      }
      const current = bridge;
      if (parked || now() - lastStartAt >= BRIDGE_REARM_MS) {
        arm(current);
        return;
      }
      detach(() => current.refreshSubscriptions());
    },
    shutdown() {
      teardown();
    },
    async threadWaitState(threadId) {
      if (!bridge?.readThreadWaitState)
        return "unavailable";
      let available = false;
      try {
        available = await probe();
      } catch {
        return "unavailable";
      }
      if (!available)
        return "unavailable";
      try {
        return await withDeadline(bridge.readThreadWaitState(threadId), PLAN_PICKER_STATUS_QUERY_DEADLINE_MS) ?? "unavailable";
      } catch {
        return "unavailable";
      }
    },
    get active() {
      return bridge !== undefined;
    },
    get daemonDown() {
      return daemonDown;
    }
  };
}
async function claimSingleInstance() {
  const build = watchdogBuildStamp();
  try {
    const holder = parseWatchdogPidfile(readFileSync2(WATCHDOG_PID_PATH, "utf8"));
    if (holder && holder.pid !== process.pid && watchdogHolderIsLive(holder.pid) && holder.version === PLUGIN_VERSION && !watchdogBuildDiffers(holder.build, build)) {
      return false;
    }
  } catch {}
  await atomicWrite(WATCHDOG_PID_PATH, formatWatchdogPidfile(process.pid, PLUGIN_VERSION, build));
  return true;
}
function isRightfulWatchdogOwner(deps = {}) {
  try {
    const pidPath = deps.pidPath ?? WATCHDOG_PID_PATH;
    const holder = parseWatchdogPidfile((deps.readPidfile ?? (() => readFileSync2(pidPath, "utf8")))());
    return holder?.pid === (deps.pid ?? process.pid) && holder.version === (deps.version ?? PLUGIN_VERSION);
  } catch {
    return false;
  }
}
function enforceWatchdogOwnership(shutdown, deps = {}) {
  if (isRightfulWatchdogOwner(deps))
    return true;
  try {
    shutdown();
  } catch {}
  return false;
}
function releaseSingleInstance() {
  try {
    const holder = parseWatchdogPidfile(readFileSync2(WATCHDOG_PID_PATH, "utf8"));
    if (holder && holder.pid === process.pid)
      unlinkSync(WATCHDOG_PID_PATH);
  } catch {}
}
function pendingPairingExpired(pending, now, fallbackDeadline) {
  const deadline = typeof pending.createdAt === "number" ? pending.createdAt + PAIRING_TTL_MS : fallbackDeadline;
  return now >= deadline;
}
async function removePendingConfig() {
  try {
    await unlink4(`${CC_DIR}/config.json`);
  } catch {}
  await unlink4(`${CC_DIR}/${PAIR_HTML_FILE}`).catch(() => {});
}
async function selfHealPairing(pending) {
  let result;
  try {
    result = await completePendingPairing(pending, `${CC_DIR}/config.json`, { fetchTimeoutMs: 2000, ackAttempts: 1 });
  } catch {
    return "continue";
  }
  if (result.state === "gone" || result.state === "already-completed") {
    return await loadConfig() ? "stop" : "cleanup";
  }
  if (result.state === "rejected" || result.state === "tampered")
    return "stop";
  return "continue";
}
async function run() {
  if (!await claimSingleInstance())
    return;
  const fallbackDeadline = Date.now() + PAIRING_TTL_MS;
  let lastActiveMs = Date.now();
  const bridges = createBridgeSupervisor({
    onError: (error) => traceSession({
      event: "bridge",
      error: error.name,
      msg: String(error.message ?? "").slice(0, 200)
    })
  });
  activeBridgeShutdown = () => bridges.shutdown();
  const lan = createLanListener({
    onCommand: acceptLanCommand,
    onAnswer: (answer) => {
      acceptLanAnswer(answer);
    }
  });
  activeLanListener = lan;
  const stopLan = () => {
    try {
      lan.stop();
    } catch {}
  };
  const shutdown = () => {
    bridges.shutdown();
    stopLan();
  };
  activeLanShutdown = stopLan;
  try {
    while (true) {
      if (!enforceWatchdogOwnership(shutdown))
        return;
      const config = await loadConfig();
      await bridges.sync(config);
      setCodexBridgeDown(bridges.daemonDown);
      lan.sync(config);
      if (config) {
        await reconcileProvisionalsSweep(config);
        await discoverLiveSessions(config);
      }
      const result = await sweep(config, {
        threadWaitState: (threadId) => bridges.threadWaitState(threadId)
      });
      if (config)
        await enqueueDrainCommands(config);
      if (result.revoked) {
        if (await goneStrikeShouldTeardown()) {
          await removeRevokedConfig();
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }
      if (result.delivered)
        await resetGoneStrikes();
      const remaining = result.remaining;
      if (!config) {
        const pending = await loadPendingConfig();
        if (!pending) {
          return;
        }
        if (pendingPairingExpired(pending, Date.now(), fallbackDeadline)) {
          await removePendingConfig();
          return;
        }
        const verdict = await selfHealPairing(pending);
        if (verdict === "stop")
          return;
        if (verdict === "cleanup") {
          await removePendingConfig();
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }
      const nowMs = Date.now();
      if (remaining > 0)
        lastActiveMs = nowMs;
      if (remaining === 0) {
        if (!config || nowMs - lastActiveMs >= IDLE_GRACE_MS)
          return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    shutdown();
    activeBridgeShutdown = undefined;
    activeLanShutdown = undefined;
    activeLanListener = undefined;
    releaseSingleInstance();
  }
}
if (__require.main == __require.module) {
  process.on("unhandledRejection", () => {});
  const onTerminate = () => {
    try {
      releaseSingleInstance();
    } catch {}
    try {
      activeBridgeShutdown?.();
    } catch {}
    try {
      activeLanShutdown?.();
    } catch {}
    const exitTimer = setTimeout(() => process.exit(0), 250);
    exitTimer.unref?.();
  };
  process.on("SIGTERM", onTerminate);
  process.on("SIGINT", onTerminate);
  try {
    await run();
  } catch {}
  process.exit(0);
}
export {
  withDeadline,
  watchdogEventHeaders,
  titleRepairedRecord,
  tailShowsInterrupt,
  shouldWaitingHeartbeat,
  shouldRepairTitle,
  shouldPlanPickerVerificationCheck,
  shouldPendingDoneCheck,
  shouldPendingApprovalCheck,
  shouldInterruptCheck,
  shouldIdleProvisionalCheck,
  shouldHeartbeat,
  setCodexBridgeDown,
  retireDoneStale,
  resolveCodexTuiOwner,
  resetDoneAttemptMemory,
  resetCommandState,
  recordMovedSince,
  reconcileProvisionalsSweep,
  provisionalsCoveredByReal,
  postOutcomeForStatus,
  planPickerPendingExpired,
  pendingPairingExpired,
  pendingDoneSettleWrite,
  pendingDoneRetryWrite,
  parseCommandPayload,
  noteDoneAttempt,
  lastTurnLine,
  isWaitingSession,
  isRightfulWatchdogOwner,
  isRetireEligible,
  isClaudeIdleReapEligible,
  heartbeatKind,
  hasInterruptMarker,
  goneStrikeShouldTeardown,
  extractCommands,
  enqueueDrainCommands,
  enforceWatchdogOwnership,
  effectiveDoneAttempts,
  drainCommands,
  discoverLiveSessions,
  createBridgeSupervisor,
  correlateCodexTuiPid,
  correctResolvedPlanPicker,
  correctPlanPickerVerification,
  correctPendingDone,
  correctPendingApproval,
  correctInterrupt,
  correctIdleClaude,
  commandIsFresh,
  codexTailPendingApproval,
  codexLastTurnEvent,
  codexBridgeIsDown,
  clearDoneAttempts,
  claudeTailPendingApproval,
  classifySession,
  buildWorkingEnvelope,
  buildTitleRepairEnvelope,
  buildStartEnvelope,
  buildProvisionalRecord,
  buildProvisionalEnvelope,
  buildProvisionalBlob,
  buildNeedsAttentionEnvelope,
  buildHeartbeatEnvelope,
  buildEndEnvelope,
  buildDoneEnvelope,
  acceptLanCommand,
  acceptLanAnswer,
  WAITING_HEARTBEAT_AFTER_MS,
  RETIRE_AFTER_MS,
  PLAN_PICKER_VERIFY_MAX_MS,
  PLAN_PICKER_RECENT_DONE_MS,
  PLAN_PICKER_PENDING_MAX_MS,
  PAIRING_TTL_MS,
  LAN_COMMAND_ID_PREFIX,
  LAN_ANSWER_ECHO_DELAY_MS,
  IDLE_GRACE_MS,
  COMMAND_TTL_MS,
  COMMAND_FUTURE_SKEW_MS,
  CODEX_TUI_SESSION_START_SKEW_MS
};
