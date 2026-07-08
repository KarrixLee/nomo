import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/entries/pair.ts
import { spawn as spawn2 } from "node:child_process";
import { readFile as readFile2, unlink as unlink2 } from "node:fs/promises";

// src/core/shared.ts
import { chmod, open, readFile, rename, stat, mkdir, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/core/crypto.ts
var textEncoder = new TextEncoder;
var textDecoder = new TextDecoder;
var HKDF_INFO = textEncoder.encode("nomo-cc-e2e-v1");
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
async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// src/core/shared.ts
var CC_DIR = `${process.env.HOME}/.config/cc-status`;
var SESSIONS_DIR = `${CC_DIR}/sessions`;
var WATCHDOG_PID_PATH = `${CC_DIR}/watchdog.pid`;
var LAST_SEND_PATH = `${CC_DIR}/last-send`;
var GONE_STRIKES_PATH = `${CC_DIR}/gone-strikes`;
var GONE_STRIKE_LIMIT = 2;
var PENDING_STASH_FILE = "pending-event.json";
var PENDING_STASH_PATH = `${CC_DIR}/${PENDING_STASH_FILE}`;
var PAIR_QR_SVG_FILE = "pair-qr.svg";
var PAIR_QR_SVG_PATH = `${CC_DIR}/${PAIR_QR_SVG_FILE}`;
var HERE = dirname(fileURLToPath(import.meta.url));
var WATCHDOG_PATH = existsSync(`${HERE}/cc-watchdog.mjs`) ? `${HERE}/cc-watchdog.mjs` : `${HERE}/../entries/cc-watchdog.ts`;
function codexHome() {
  const env = process.env.CODEX_HOME;
  return env && env.length > 0 ? env : `${process.env.HOME}/.codex`;
}
var CODEX_HOOK_MARKER = "codex-status.mjs";
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
  return {
    url: c.url.replace(/\/$/, ""),
    pairingId: c.pairingId,
    pcSecret: c.pcSecret,
    qrSecret,
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
          headers: { "content-type": "application/json", "x-cc-pairing": pairingId, "x-cc-auth": pcSecret },
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
          ...stash.blob.agent === "codex" ? { agent: "codex" } : {}
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
  const e2eKey = await deriveE2EKey(pending.qrSecret, fromB64url(body.phoneNonce));
  let deviceName;
  try {
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
        headers: { "x-cc-pairing": pending.pairingId, "x-cc-auth": pending.pcSecret },
        signal: AbortSignal.timeout(fetchTimeoutMs)
      });
      break;
    } catch {
      if (attempt < ackAttempts - 1)
        await sleep(ackRetryDelayMs);
    }
  }
  await flushPendingStash(join(dirname(configPath), PENDING_STASH_FILE), pending.url, pending.pairingId, pending.pcSecret, e2eKey, Date.now(), fetchFn, fetchTimeoutMs, ackAttempts, ackRetryDelayMs, sleep, opts.isAlive ?? pidAlive, opts.ensureWatchdog ?? ensureWatchdog, opts.sessionsDir ?? SESSIONS_DIR);
  await unlink(join(dirname(configPath), PAIR_QR_SVG_FILE)).catch(() => {});
  return { state: "completed", deviceName };
}
function ensureWatchdog() {
  try {
    let running = false;
    try {
      const pid = Number.parseInt(readFileSync(WATCHDOG_PID_PATH, "utf8").trim(), 10);
      running = Number.isFinite(pid) && pid > 0 && pidAlive(pid);
    } catch {
      running = false;
    }
    if (running)
      return;
    const runtime = process.env.NOMO_RUNTIME && process.env.NOMO_RUNTIME.length > 0 ? process.env.NOMO_RUNTIME : process.execPath;
    spawn(runtime, [WATCHDOG_PATH], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}
async function readRecord(sessionId) {
  try {
    return JSON.parse(await readFile(`${SESSIONS_DIR}/${sessionId}.json`, "utf8"));
  } catch {
    return null;
  }
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

// src/qr/qr.ts
var encoder = new TextEncoder;
var GF_EXP = new Uint8Array(512);
var GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0;i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 256)
      x ^= 285;
  }
  for (let i = 255;i < 512; i++)
    GF_EXP[i] = GF_EXP[i - 255];
})();
function gfMul(a, b) {
  if (a === 0 || b === 0)
    return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}
function reedSolomon(data, ecLen) {
  let gen = [1];
  for (let i = 0;i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0;j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], GF_EXP[i]);
    }
    gen = next;
  }
  const res = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0)
      for (let i = 0;i < ecLen; i++)
        res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}
var L_TOTAL_DATA = {
  1: 19,
  2: 34,
  3: 55,
  4: 80,
  5: 108,
  6: 136,
  7: 156,
  8: 194,
  9: 232,
  10: 274
};
var L_EC_PER_BLOCK = {
  1: 7,
  2: 10,
  3: 15,
  4: 20,
  5: 26,
  6: 18,
  7: 20,
  8: 24,
  9: 30,
  10: 18
};
var L_GROUPS = {
  1: [[1, 19]],
  2: [[1, 34]],
  3: [[1, 55]],
  4: [[1, 80]],
  5: [[1, 108]],
  6: [[2, 68]],
  7: [[2, 78]],
  8: [[2, 97]],
  9: [[2, 116]],
  10: [[2, 68], [2, 69]]
};
var ALIGN = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50]
};
var PENALTY_N1 = 3;
var PENALTY_N2 = 3;
var PENALTY_N3 = 40;
var PENALTY_N4 = 10;
function getBit(x, i) {
  return x >>> i & 1;
}
function pickVersion(byteLen) {
  for (let v = 1;v <= 10; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + byteLen * 8 <= L_TOTAL_DATA[v] * 8)
      return v;
  }
  throw new Error(`payload too large for QR v1..10 at level L: ${byteLen} bytes`);
}
function buildDataCodewords(bytes, version) {
  const totalData = L_TOTAL_DATA[version];
  const capacityBits = totalData * 8;
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1;i >= 0; i--)
      bits.push(value >> i & 1);
  };
  push(4, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes)
    push(b, 8);
  for (let i = 0;i < 4 && bits.length < capacityBits; i++)
    bits.push(0);
  while (bits.length % 8 !== 0)
    bits.push(0);
  const codewords = [];
  for (let i = 0;i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0;j < 8; j++)
      byte = byte << 1 | bits[i + j];
    codewords.push(byte);
  }
  const pad = [236, 17];
  for (let i = 0;codewords.length < totalData; i++)
    codewords.push(pad[i % 2]);
  return codewords;
}
function interleave(dataCodewords, version) {
  const ecLen = L_EC_PER_BLOCK[version];
  const blocks = [];
  let ptr = 0;
  for (const [count, dataLen] of L_GROUPS[version]) {
    for (let k = 0;k < count; k++) {
      const data = dataCodewords.slice(ptr, ptr + dataLen);
      ptr += dataLen;
      blocks.push({ data, ec: reedSolomon(data, ecLen) });
    }
  }
  const result = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0;i < maxData; i++) {
    for (const b of blocks)
      if (i < b.data.length)
        result.push(b.data[i]);
  }
  for (let i = 0;i < ecLen; i++) {
    for (const b of blocks)
      result.push(b.ec[i]);
  }
  return result;
}
function newGrid(size) {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array(size).fill(0)),
    func: Array.from({ length: size }, () => new Array(size).fill(false))
  };
}
function setFn(g, r, c, val) {
  if (r < 0 || c < 0 || r >= g.size || c >= g.size)
    return;
  g.modules[r][c] = val;
  g.func[r][c] = true;
}
function placeFinder(g, r, c) {
  for (let dr = -1;dr <= 7; dr++) {
    for (let dc = -1;dc <= 7; dc++) {
      const inCore = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const isBorder = inCore && (dr === 0 || dr === 6 || (dc === 0 || dc === 6));
      const isCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      setFn(g, r + dr, c + dc, inCore && (isBorder || isCenter) ? 1 : 0);
    }
  }
}
function placeAlignment(g, r, c) {
  for (let dr = -2;dr <= 2; dr++) {
    for (let dc = -2;dc <= 2; dc++) {
      const maxAbs = Math.max(Math.abs(dr), Math.abs(dc));
      setFn(g, r + dr, c + dc, maxAbs !== 1 ? 1 : 0);
    }
  }
}
function drawFunctionPatterns(g, version) {
  const size = g.size;
  placeFinder(g, 0, 0);
  placeFinder(g, 0, size - 7);
  placeFinder(g, size - 7, 0);
  for (let i = 8;i < size - 8; i++) {
    const val = i % 2 === 0 ? 1 : 0;
    if (!g.func[6][i])
      setFn(g, 6, i, val);
    if (!g.func[i][6])
      setFn(g, i, 6, val);
  }
  const centres = ALIGN[version];
  const last = centres.length - 1;
  for (let i = 0;i <= last; i++) {
    for (let j = 0;j <= last; j++) {
      if (i === 0 && j === 0 || i === 0 && j === last || i === last && j === 0)
        continue;
      placeAlignment(g, centres[i], centres[j]);
    }
  }
  setFn(g, size - 8, 8, 1);
}
function drawFormat(g, mask) {
  const size = g.size;
  const data = 1 << 3 | mask;
  let rem = data;
  for (let i = 0;i < 10; i++)
    rem = rem << 1 ^ (rem >>> 9) * 1335;
  const bits = (data << 10 | rem) ^ 21522;
  for (let i = 0;i <= 5; i++)
    setFn(g, i, 8, getBit(bits, i));
  setFn(g, 7, 8, getBit(bits, 6));
  setFn(g, 8, 8, getBit(bits, 7));
  setFn(g, 8, 7, getBit(bits, 8));
  for (let i = 9;i < 15; i++)
    setFn(g, 8, 14 - i, getBit(bits, i));
  for (let i = 0;i < 8; i++)
    setFn(g, 8, size - 1 - i, getBit(bits, i));
  for (let i = 8;i < 15; i++)
    setFn(g, size - 15 + i, 8, getBit(bits, i));
  setFn(g, size - 8, 8, 1);
}
function drawVersion(g, version) {
  if (version < 7)
    return;
  const size = g.size;
  let rem = version;
  for (let i = 0;i < 12; i++)
    rem = rem << 1 ^ (rem >>> 11) * 7973;
  const bits = version << 12 | rem;
  for (let i = 0;i < 18; i++) {
    const bit = getBit(bits, i);
    const a = size - 11 + i % 3;
    const b = Math.floor(i / 3);
    setFn(g, a, b, bit);
    setFn(g, b, a, bit);
  }
}
function drawCodewords(g, codewords) {
  const size = g.size;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1;right >= 1; right -= 2) {
    if (right === 6)
      right = 5;
    for (let vert = 0;vert < size; vert++) {
      for (let j = 0;j < 2; j++) {
        const col = right - j;
        const upward = (right + 1 & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (!g.func[row][col] && bitIndex < totalBits) {
          const bit = getBit(codewords[bitIndex >> 3], 7 - (bitIndex & 7));
          g.modules[row][col] = bit;
          bitIndex++;
        }
      }
    }
  }
}
function maskCondition(mask, r, c) {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return r * c % 2 + r * c % 3 === 0;
    case 6:
      return (r * c % 2 + r * c % 3) % 2 === 0;
    default:
      return ((r + c) % 2 + r * c % 3) % 2 === 0;
  }
}
function applyMask(g, mask) {
  for (let r = 0;r < g.size; r++) {
    for (let c = 0;c < g.size; c++) {
      if (!g.func[r][c] && maskCondition(mask, r, c))
        g.modules[r][c] ^= 1;
    }
  }
}
function finderPenaltyAddHistory(runLength, history, size) {
  if (history[0] === 0)
    runLength += size;
  history.pop();
  history.unshift(runLength);
}
function finderPenaltyCount(history) {
  const n = history[1];
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
}
function finderPenaltyTerminate(runColor, runLength, history, size) {
  if (runColor) {
    finderPenaltyAddHistory(runLength, history, size);
    runLength = 0;
  }
  runLength += size;
  finderPenaltyAddHistory(runLength, history, size);
  return finderPenaltyCount(history);
}
function penaltyScore(g) {
  const size = g.size;
  const dark = (r, c) => g.modules[r][c] === 1;
  let result = 0;
  for (let y = 0;y < size; y++) {
    let runColor = false, runX = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0;x < size; x++) {
      if (dark(y, x) === runColor) {
        runX++;
        if (runX === 5)
          result += PENALTY_N1;
        else if (runX > 5)
          result++;
      } else {
        finderPenaltyAddHistory(runX, history, size);
        if (!runColor)
          result += finderPenaltyCount(history) * PENALTY_N3;
        runColor = dark(y, x);
        runX = 1;
      }
    }
    result += finderPenaltyTerminate(runColor, runX, history, size) * PENALTY_N3;
  }
  for (let x = 0;x < size; x++) {
    let runColor = false, runY = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0;y < size; y++) {
      if (dark(y, x) === runColor) {
        runY++;
        if (runY === 5)
          result += PENALTY_N1;
        else if (runY > 5)
          result++;
      } else {
        finderPenaltyAddHistory(runY, history, size);
        if (!runColor)
          result += finderPenaltyCount(history) * PENALTY_N3;
        runColor = dark(y, x);
        runY = 1;
      }
    }
    result += finderPenaltyTerminate(runColor, runY, history, size) * PENALTY_N3;
  }
  for (let y = 0;y < size - 1; y++) {
    for (let x = 0;x < size - 1; x++) {
      const color = dark(y, x);
      if (color === dark(y, x + 1) && color === dark(y + 1, x) && color === dark(y + 1, x + 1)) {
        result += PENALTY_N2;
      }
    }
  }
  let darkCount = 0;
  for (let y = 0;y < size; y++)
    for (let x = 0;x < size; x++)
      if (dark(y, x))
        darkCount++;
  const total = size * size;
  const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}
function qrGrid(text, forceMask) {
  const bytes = encoder.encode(text);
  const version = pickVersion(bytes.length);
  const codewords = interleave(buildDataCodewords(bytes, version), version);
  const g = newGrid(17 + 4 * version);
  drawFunctionPatterns(g, version);
  drawFormat(g, 0);
  drawVersion(g, version);
  drawCodewords(g, codewords);
  let bestMask = 0, bestPenalty = Infinity;
  if (forceMask !== undefined) {
    bestMask = forceMask;
  } else {
    for (let mask = 0;mask < 8; mask++) {
      applyMask(g, mask);
      drawFormat(g, mask);
      const penalty = penaltyScore(g);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = mask;
      }
      applyMask(g, mask);
    }
  }
  applyMask(g, bestMask);
  drawFormat(g, bestMask);
  return g;
}
function qrMatrix(text) {
  return qrGrid(text).modules;
}
function renderQR(text, quiet = 4) {
  const g = qrGrid(text);
  const size = g.size;
  const full = size + quiet * 2;
  const dark = (r, c) => {
    const rr = r - quiet, cc = c - quiet;
    if (rr < 0 || cc < 0 || rr >= size || cc >= size)
      return false;
    return g.modules[rr][cc] === 1;
  };
  const lines = [];
  for (let r = 0;r < full; r += 2) {
    let line = "";
    for (let c = 0;c < full; c++) {
      const top = dark(r, c);
      const bottom = r + 1 < full ? dark(r + 1, c) : false;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join(`
`);
}

// src/qr/qr-svg.ts
function renderQRSVG(text, opts = {}) {
  const quiet = opts.quiet ?? 4;
  const pixelSize = opts.pixelSize ?? 512;
  const matrix = qrMatrix(text);
  const size = matrix.length;
  const full = size + quiet * 2;
  const rects = [];
  for (let r = 0;r < size; r++) {
    for (let c = 0;c < size; c++) {
      if (matrix[r][c] === 1) {
        rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" ` + `viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges">` + `<rect width="${full}" height="${full}" fill="#ffffff"/>` + `<g fill="#000000">${rects.join("")}</g>` + `</svg>`;
}
// src/entries/pair.ts
var DEFAULT_WORKER_URL = "https://api-status-push.karrixlee1231.workers.dev";
var POLL_INTERVAL_MS = 3000;
var MAX_WAIT_MS = 600000;
var FETCH_TIMEOUT_MS = 1e4;
var CONFIG_MODE2 = 384;
var ACK_ATTEMPTS = 3;
var ACK_RETRY_DELAY_MS = 1000;
var textEncoder2 = new TextEncoder;
function openSvgFile(path) {
  if (process.env.NOMO_NO_OPEN === "1")
    return false;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!cmd)
    return false;
  try {
    spawn2(cmd, [path], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}
async function removePendingConfig(configPath) {
  try {
    await unlink2(configPath);
  } catch {}
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function buildPairURL(workerUrl, pairingId, qrSecret) {
  const u = workerUrl === DEFAULT_WORKER_URL ? "" : `&u=${b64url(textEncoder2.encode(workerUrl))}`;
  return `nomo://pair?v=1${u}&p=${pairingId}&s=${b64url(qrSecret)}`;
}
var QR_BEGIN_MARKER = "──── NOMO PAIRING QR — scan this with the Nomo app ────";
var QR_END_MARKER = "──── end QR ────";
async function revokeExisting(fetchFn, configPath, print) {
  let old;
  try {
    old = parseConfig(await readFile2(configPath, "utf8"));
  } catch {
    return;
  }
  if (!old)
    return;
  print(`Already paired (pairing ${old.pairingId.slice(0, 8)}…) — revoking the old pairing first.`);
  try {
    await fetchFn(`${old.url}/v1/cc/pair/revoke`, {
      method: "POST",
      headers: { "x-cc-pairing": old.pairingId, "x-cc-auth": old.pcSecret },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch {}
}
async function pairStart(deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const print = deps.print ?? ((line) => console.log(line));
  const randomBytes = deps.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  const configPath = deps.configPath ?? `${CC_DIR}/config.json`;
  const workerUrl = (deps.workerUrl ?? process.env.NOMO_WORKER_URL ?? DEFAULT_WORKER_URL).replace(/\/$/, "");
  const spawnWatchdog = deps.spawnWatchdog ?? ensureWatchdog;
  const now = deps.now ?? Date.now;
  const qrSvgPath = deps.qrSvgPath ?? PAIR_QR_SVG_PATH;
  await unlink2(qrSvgPath).catch(() => {});
  await revokeExisting(fetchFn, configPath, print);
  const pairingId = bytesToHex(randomBytes(16));
  const pcSecret = b64url(randomBytes(24));
  const qrSecret = randomBytes(16);
  let startRes;
  try {
    startRes = await fetchFn(`${workerUrl}/v1/cc/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingId, pcAuthHash: await sha256Hex(pcSecret) }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
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
  await atomicWrite(configPath, JSON.stringify({
    url: workerUrl,
    pairingId,
    pcSecret,
    qrSecretB64: b64url(qrSecret),
    createdAt: now()
  }), CONFIG_MODE2);
  spawnWatchdog();
  const url = buildPairURL(workerUrl, pairingId, qrSecret);
  print(QR_BEGIN_MARKER);
  print(renderQR(url));
  print(QR_END_MARKER);
  print("");
  print("Scan the QR above with the Nomo app: Sessions tab → Pair a Computer.");
  print("This code expires in 10 minutes. Keep this session open — the next step waits for your phone.");
  if (deps.open) {
    try {
      await atomicWrite(qrSvgPath, renderQRSVG(url), CONFIG_MODE2);
      const opened = (deps.openFile ?? openSvgFile)(qrSvgPath);
      if (opened) {
        print("QR opened in a separate window — scan it with the Nomo app (Sessions → Pair a Computer).");
      } else {
        print(`QR image saved: ${qrSvgPath}`);
      }
    } catch {}
  }
  return 0;
}
async function pairWait(deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const print = deps.print ?? ((line) => console.log(line));
  const configPath = deps.configPath ?? `${CC_DIR}/config.json`;
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const maxWaitMs = deps.maxWaitMs ?? MAX_WAIT_MS;
  const now = deps.now ?? Date.now;
  const readCompleted = async () => {
    try {
      return parseConfig(await readFile2(configPath, "utf8"));
    } catch {
      return null;
    }
  };
  const printPaired = (c) => print(c.machineName ? `Paired with ${c.machineName} ✓` : "Paired ✓");
  let raw;
  try {
    raw = await readFile2(configPath, "utf8");
  } catch {
    print("No pairing in progress — run /nomo-cc:pair first.");
    return 1;
  }
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
    fetchFn,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    ackAttempts: ACK_ATTEMPTS,
    ackRetryDelayMs: ACK_RETRY_DELAY_MS,
    sleep
  };
  const loopBound = deps.softTimeoutMs !== undefined ? Math.min(deps.softTimeoutMs, maxWaitMs) : maxWaitMs;
  for (let waited = 0;waited < loopBound; waited += pollIntervalMs) {
    const already = await readCompleted();
    if (already) {
      printPaired(already);
      return 0;
    }
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
    await sleep(pollIntervalMs);
  }
  if (deps.softTimeoutMs !== undefined) {
    print("Still waiting for the scan — pairing completes automatically in the background once you scan; check with the status command.");
    return 0;
  }
  print("Pairing window expired (10 minutes) with no phone claiming it — run /nomo-cc:pair again when ready.");
  return 1;
}
function parseTimeoutMs(argv) {
  const i = argv.indexOf("--timeout");
  if (i === -1)
    return;
  const seconds = Number.parseInt(argv[i + 1] ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
if (__require.main == __require.module) {
  if (process.argv.includes("--check")) {
    console.log("usage: pair [--open] [wait [--timeout <seconds>]] [--check]  — pair this machine with the Nomo app via QR code");
    process.exit(0);
  }
  if (process.argv.includes("wait")) {
    const softTimeoutMs = parseTimeoutMs(process.argv);
    process.exit(await pairWait(softTimeoutMs !== undefined ? { softTimeoutMs } : {}));
  } else {
    process.exit(await pairStart({ open: process.argv.includes("--open") }));
  }
}
export {
  pairWait,
  pairStart,
  decryptDeviceName,
  bytesToHex,
  buildPairURL,
  QR_END_MARKER,
  QR_BEGIN_MARKER,
  DEFAULT_WORKER_URL
};
