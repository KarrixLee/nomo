import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/entries/reset.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { readdir, readFile as readFile2, unlink as unlink2 } from "node:fs/promises";
import { basename as basename2 } from "node:path";

// src/core/shared.ts
import { access, chmod, open, readFile, rename, stat, mkdir, unlink, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
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
var PLUGIN_VERSION = "2.1.25";
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
var FULL_TEXT_POST_TIMEOUT_MS = 5000;
async function postFullText(config, sessionId, what, content, fetchFn = fetch, trace, requestId) {
  if (content === undefined)
    return;
  try {
    const blob = await encryptBlob(config.e2eKey, {
      sessionId,
      what,
      requestId,
      content,
      complete: recordFullTextIsComplete(content)
    });
    const res = await fetchFn(`${config.url}/v1/cc/full`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret,
        "x-cc-version": PLUGIN_VERSION
      },
      body: JSON.stringify({ v: 2, sessionId, what, blob }),
      signal: AbortSignal.timeout(FULL_TEXT_POST_TIMEOUT_MS)
    });
    trace?.({ event: "full-text", what, chars: content.length, status: res.status });
  } catch (e) {
    trace?.({ event: "full-text", what, chars: content.length, status: 0, error: e?.name ?? "Error" });
  }
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
var CODEX_SOCKET_PROBE_TIMEOUT_MS = 200;
async function unixSocketAccepts(socketPath, timeoutMs) {
  let createConnection;
  try {
    ({ createConnection } = await import("node:net"));
  } catch {
    return false;
  }
  return await new Promise((resolve2) => {
    let settled = false;
    let socket;
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    function done(accepted) {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {}
      resolve2(accepted);
    }
    try {
      socket = createConnection({ path: socketPath });
    } catch {
      done(false);
      return;
    }
    socket.unref?.();
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
  });
}
async function codexAppServerSocketAvailable(socketPath = codexAppServerSocketPath()) {
  return await unixSocketAccepts(socketPath, CODEX_SOCKET_PROBE_TIMEOUT_MS);
}
async function codexAppServerSocketState(socketPath = codexAppServerSocketPath()) {
  if (await codexAppServerSocketAvailable(socketPath))
    return "live";
  try {
    return (await stat(socketPath)).isSocket() ? "stale" : "absent";
  } catch {
    return "absent";
  }
}
var CODEX_DAEMON_START_ARGS = ["app-server", "daemon", "start"];
var CODEX_DAEMON_START_TIMEOUT_MS = 8000;
var CODEX_DAEMON_SOCKET_WAIT_MS = 4000;
var CODEX_DAEMON_SOCKET_POLL_MS = 250;
async function startCodexAppServerDaemon(deps = {}) {
  const trace = deps.trace ?? ((event) => traceSession(event));
  const probe = deps.probe ?? (() => codexAppServerSocketAvailable());
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve2) => setTimeout(resolve2, ms)));
  const command = deps.codexPath ?? "codex";
  const timeoutMs = deps.timeoutMs ?? CODEX_DAEMON_START_TIMEOUT_MS;
  const socketWaitMs = deps.socketWaitMs ?? CODEX_DAEMON_SOCKET_WAIT_MS;
  const spawnFn = deps.spawnFn ?? ((cmd, args) => spawn(cmd, [...args], { stdio: "ignore" }));
  let exit;
  try {
    exit = await new Promise((resolve2) => {
      let settled = false;
      const done = (value) => {
        if (settled)
          return;
        settled = true;
        resolve2(value);
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
function opencodeStubPaths() {
  const base = `${process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`}/opencode`;
  return [`${base}/plugins/nomo.js`, `${base}/plugin/nomo.js`];
}
function opencodeStubTarget(text) {
  return /^export \{ default \} from "(.+)";$/m.exec(text)?.[1];
}
var FOLDER_KEY_HEX_CHARS = 12;
var BRANCH_MAX_CHARS = 60;
var GIT_DIR_WALK_MAX_DEPTH = 64;
function gitDirPointer(content, containingDir) {
  const match = /^[ \t]*gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(content);
  const target = match?.[1];
  if (typeof target !== "string" || target.length === 0)
    return;
  return isAbsolute(target) ? target : resolve(containingDir, target);
}
function resolveGitDir(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0)
    return;
  let dir = cwd;
  for (let depth = 0;depth < GIT_DIR_WALK_MAX_DEPTH; depth++) {
    const candidate = join(dir, ".git");
    try {
      const st = statSync(candidate);
      if (st.isDirectory())
        return candidate;
      if (st.isFile())
        return gitDirPointer(readFileSync(candidate, "utf8"), dir);
    } catch {}
    const parent = dirname(dir);
    if (parent === dir)
      return;
    dir = parent;
  }
  return;
}
function branchFromHead(gitDir) {
  if (typeof gitDir !== "string" || gitDir.length === 0)
    return;
  let head;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8");
  } catch {
    return;
  }
  const first = (head.split(`
`, 1)[0] ?? "").trim();
  if (first.length === 0)
    return;
  const ref = /^ref:[ \t]*refs\/heads\/(.+)$/.exec(first);
  if (ref) {
    const name = ref[1].trim();
    return name.length > 0 ? name.slice(0, BRANCH_MAX_CHARS) : undefined;
  }
  if (/^[0-9a-f]{40}$/.test(first) || /^[0-9a-f]{64}$/.test(first))
    return first.slice(0, 7);
  return;
}
function sessionBranch(folder) {
  if (!folder)
    return;
  const cached = typeof folder.gitDir === "string" && folder.gitDir.length > 0 ? folder.gitDir : undefined;
  if (cached) {
    const branch = branchFromHead(cached);
    if (branch)
      return branch;
  }
  const fresh = resolveGitDir(folder.cwd);
  if (!fresh || fresh === cached)
    return;
  return branchFromHead(fresh);
}
function folderKeyFromCwd(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0)
    return;
  return createHash("sha256").update(cwd, "utf8").digest("hex").slice(0, FOLDER_KEY_HEX_CHARS);
}
function folderIdentity(cwd, pinned) {
  const pin = typeof pinned === "string" ? { label: pinned, folderKey: undefined, cwd: undefined, gitDir: undefined } : pinned;
  if (typeof pin?.label === "string" && pin.label.length > 0) {
    return {
      label: pin.label,
      ...typeof pin.folderKey === "string" && pin.folderKey.length > 0 ? { folderKey: pin.folderKey } : {},
      ...typeof pin.cwd === "string" && pin.cwd.length > 0 ? { cwd: pin.cwd } : {},
      ...typeof pin.gitDir === "string" && pin.gitDir.length > 0 ? { gitDir: pin.gitDir } : {}
    };
  }
  const key = folderKeyFromCwd(cwd);
  const gitDir = typeof cwd === "string" && cwd.length > 0 ? resolveGitDir(cwd) : undefined;
  return {
    label: typeof cwd === "string" && cwd.length > 0 ? basename(cwd) : "session",
    ...key ? { folderKey: key } : {},
    ...typeof cwd === "string" && cwd.length > 0 ? { cwd } : {},
    ...gitDir ? { gitDir } : {}
  };
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
          ...stash.blob.agent && stash.blob.agent !== "claude" ? { agent: stash.blob.agent } : {},
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
function watchdogVersionOutranks(mine, incumbent) {
  if (incumbent === undefined)
    return true;
  const parse = (v) => {
    const core = v.trim().split("+")[0].split("-")[0];
    if (core.length === 0)
      return;
    const parts = core.split(".").map((p) => /^\d+$/.test(p) ? Number(p) : Number.NaN);
    return parts.some((n) => !Number.isFinite(n)) ? undefined : parts;
  };
  const a = parse(mine), b = parse(incumbent);
  if (a === undefined || b === undefined)
    return false;
  for (let i = 0;i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y)
      return x > y;
  }
  return false;
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
      return false;
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
      if (holder.version === version) {
        if (!watchdogBuildDiffers(holder.build, build))
          return true;
      } else if (!watchdogVersionOutranks(version, holder.version)) {
        return true;
      }
      try {
        killPid(holder.pid, "SIGTERM");
      } catch {}
    }
    spawnWatchdog();
    return false;
  } catch {
    return false;
  }
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
async function clearDecisionHoldAt(sessionsDir, sessionId, pid, beforeUnlink, holdId) {
  const path = `${sessionsDir}/${decisionHoldFileName(sessionId)}`;
  try {
    const raw = await readFile(path, "utf8").catch(() => {
      return;
    });
    if (raw !== undefined) {
      let marker;
      try {
        marker = JSON.parse(raw);
      } catch {
        marker = undefined;
      }
      const owner = marker?.pid;
      if (typeof owner === "number" && owner !== pid)
        return false;
      if (holdId !== undefined && typeof marker?.holdId === "string" && marker.holdId !== holdId)
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
async function clearDecisionHold(sessionId, pid, beforeUnlink, holdId) {
  return clearDecisionHoldAt(SESSIONS_DIR, sessionId, pid, beforeUnlink, holdId);
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

// src/entries/reset.ts
function classifyResetSession(record, isAlive) {
  if (!record || typeof record.pid !== "number" || !Number.isFinite(record.pid))
    return "clear";
  if (record.provisional === true)
    return "clear";
  return isAlive(record.pid) ? "keep" : "clear";
}
function psCommandOf(pid) {
  try {
    const out = execFileSync2("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const line = out.trim();
    return line.length > 0 ? line : undefined;
  } catch {
    return;
  }
}
async function stopWatchdog(deps) {
  const pidPath = deps.watchdogPidPath ?? WATCHDOG_PID_PATH;
  const commandOf = deps.commandOf ?? psCommandOf;
  const killPid = deps.killPid ?? ((pid2) => process.kill(pid2));
  let raw;
  try {
    raw = await readFile2(pidPath, "utf8");
  } catch {
    return "none";
  }
  const pid = Number.parseInt(raw.trim(), 10);
  let killed = false;
  if (Number.isFinite(pid) && pid > 1) {
    const cmd = commandOf(pid);
    if (cmd !== undefined && isWatchdogCommand(cmd)) {
      try {
        killPid(pid);
        killed = true;
      } catch {}
    }
  }
  await unlink2(pidPath).catch(() => {});
  return killed ? "killed" : "stale-pidfile";
}
async function postEnd(config, sessionId, fetchFn) {
  try {
    const res = await fetchFn(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret, "x-cc-version": PLUGIN_VERSION, "x-cc-approvals": await localApprovalsState() },
      body: JSON.stringify({ v: 2, sessionId, op: "end", prio: 0, ts: Date.now() }),
      signal: AbortSignal.timeout(2000)
    });
    return res.ok;
  } catch {
    return false;
  }
}
async function reset(deps = {}) {
  const print = deps.print ?? ((line) => console.log(line));
  const fetchFn = deps.fetchFn ?? fetch;
  const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
  const isAlive = deps.isAlive ?? pidAlive;
  const wd = await stopWatchdog(deps);
  if (wd === "killed")
    print("Stopped the watchdog (it restarts automatically on your next session).");
  else if (wd === "stale-pidfile")
    print("Removed a stale watchdog pidfile (no watchdog was running).");
  else
    print("No watchdog running.");
  const config = await (deps.loadConfigFn ?? loadConfig)();
  let files = [];
  try {
    files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  let cleared = 0;
  let ended = 0;
  let kept = 0;
  for (const f of files) {
    const path = `${sessionsDir}/${f}`;
    let record = null;
    try {
      record = JSON.parse(await readFile2(path, "utf8"));
    } catch {
      record = null;
    }
    if (classifyResetSession(record, isAlive) === "keep") {
      kept++;
      continue;
    }
    if (config && await postEnd(config, basename2(f, ".json"), fetchFn))
      ended++;
    await unlink2(path).catch(() => {});
    cleared++;
  }
  if (cleared > 0) {
    print(`Cleared ${cleared} stale session record${cleared === 1 ? "" : "s"}${config ? ` (${ended} end signal${ended === 1 ? "" : "s"} delivered to your phone)` : " (not paired — cleared locally only)"}.`);
  } else {
    print("No stale sessions to clear.");
  }
  if (kept > 0)
    print(`Left ${kept} live session${kept === 1 ? "" : "s"} untouched.`);
  print("Pairing and keys were not touched — use the unpair command if you want that.");
  return 0;
}
if (__require.main == __require.module) {
  if (process.argv.includes("--check")) {
    console.log("usage: reset  — stop the watchdog and clear dead/phantom session rows (keeps the pairing; watchdog restarts on the next session)");
    process.exit(0);
  }
  process.exit(await reset());
}
export {
  reset,
  isWatchdogCommand,
  classifyResetSession
};
