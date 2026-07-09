import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/entries/codex-notify.ts
import { hostname as hostname2 } from "node:os";
import { basename as basename2 } from "node:path";

// src/core/adapter.ts
import { join as join2 } from "node:path";

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
var RATCHET_INFO_PREFIX = "nomo-cc-ratchet-v1|";
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
var PAIR_HTML_FILE = "pair.html";
var PAIR_HTML_PATH = `${CC_DIR}/${PAIR_HTML_FILE}`;
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
  await unlink(join(dirname(configPath), PAIR_HTML_FILE)).catch(() => {});
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

// src/core/adapter.ts
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
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.startsWith("<"))
      continue;
    return cleanPromptTitle(cleaned);
  }
  return;
}
function firstUserPrompt(transcript) {
  return firstUserPromptFromLines(transcript.split(`
`));
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
var claudeAdapter = {
  kind: "claude",
  async title({ prefix }) {
    return prefix.length > 0 ? sessionTitle(prefix) : undefined;
  },
  detectInterrupt(tail) {
    const line = lastTurnLine(tail);
    return line !== null && hasInterruptMarker(line);
  },
  sessionsDir: () => `${process.env.HOME}/.claude/projects`,
  sessionMatch: (name) => name.endsWith(".jsonl"),
  hookStampPath: () => lastHookPath("claude"),
  hooksNotFiringHint: "  Reinstall the plugin / check /plugin.",
  toolDetail: claudeToolDetail
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
  detectInterrupt(tail) {
    return codexLastTurnEvent(tail) === CODEX_ABORT_EVENT;
  },
  sessionsDir: () => `${codexHome()}/sessions`,
  sessionMatch: (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
  hookStampPath: () => lastHookPath("codex"),
  hooksNotFiringHint: "  Run /hooks in Codex to re-trust, or reinstall the plugin — known upstream bugs #16430/#30835.",
  toolDetail: codexToolDetail
};
function adapterFor(agent) {
  return agent === "codex" ? codexAdapter : claudeAdapter;
}

// src/core/hook.ts
import { unlink as unlink2 } from "node:fs/promises";
import { hostname } from "node:os";
import { basename } from "node:path";
var TOOL_DETAIL = { ...claudeToolDetail, ...codexToolDetail };
function detailForHook(hookName, toolName) {
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
function planOp(hookName, input, sentDone) {
  switch (hookName) {
    case "SessionStart":
      return sentDone ? { op: "update", prio: 0, status: "working" } : { op: "start", prio: 0, status: "working" };
    case "UserPromptSubmit":
    case "PreToolUse":
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
function buildBlob(input, machine, title, plan, agent = "claude", turnStartedAt) {
  const label = typeof input.cwd === "string" && input.cwd.length > 0 ? basename(input.cwd) : "session";
  const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const detail = detailForHook(hookName, typeof input.tool_name === "string" ? input.tool_name : undefined);
  return {
    status: plan.status,
    title: title ?? "",
    machine,
    label,
    ...detail ? { detail } : {},
    ...agent === "codex" ? { agent: "codex" } : {},
    ...typeof turnStartedAt === "number" && Number.isFinite(turnStartedAt) ? { turnStartedAt } : {}
  };
}
async function buildEnvelope(input, machine, now, title, e2eKey, sentDone, agent = "claude", startedAt, turnStartedAt) {
  if (typeof input !== "object" || input === null)
    return null;
  const i = input;
  if (typeof i.session_id !== "string" || i.session_id.length === 0)
    return null;
  const hookName = typeof i.hook_event_name === "string" ? i.hook_event_name : "";
  const plan = planOp(hookName, i, sentDone);
  if (!plan)
    return null;
  const base = { v: 2, sessionId: i.session_id, op: plan.op, prio: plan.prio, ts: now };
  if (typeof startedAt === "number" && Number.isFinite(startedAt))
    base.startedAt = startedAt;
  if (plan.op === "end")
    return base;
  const blob = await encryptBlob(e2eKey, buildBlob(i, machine, title, plan, agent, turnStartedAt));
  return { ...base, blob };
}
function buildPendingStash(input, machine, title, now, pid = process.ppid, agent = "claude") {
  if (typeof input.session_id !== "string" || input.session_id.length === 0)
    return null;
  const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const plan = planOp(hookName, input, false);
  if (!plan || plan.op === "end")
    return null;
  const turnStartedAt = hookName === "UserPromptSubmit" ? Math.floor(now / 1000) : undefined;
  return { sessionId: input.session_id, op: plan.op, prio: plan.prio, blob: buildBlob(input, machine, title, plan, agent, turnStartedAt), stashedAt: now, pid };
}
async function stashPendingEvent(input, machine, title, now, stashPath = PENDING_STASH_PATH, pid = process.ppid, agent = "claude") {
  try {
    const stash = buildPendingStash(input, machine, title, now, pid, agent);
    if (!stash)
      return;
    await atomicWrite(stashPath, JSON.stringify(stash), 384);
  } catch {}
}
async function trackSession(sessionId, op, prio, status, blob, machine, label, transcript, agent = "claude", sessionStartedAt, turnStartedAt, turnId) {
  try {
    const path = `${SESSIONS_DIR}/${sessionId}.json`;
    if (op === "end") {
      await unlink2(path).catch(() => {});
      return;
    }
    const record = {
      pid: process.ppid,
      machine,
      label,
      ts: Date.now(),
      transcript,
      lastEvent: op === "start" ? "sessionStart" : status,
      sentDone: op === "done",
      op,
      prio,
      ...blob ? { blob } : {},
      ...agent === "codex" ? { agent } : {},
      ...typeof sessionStartedAt === "number" && Number.isFinite(sessionStartedAt) ? { sessionStartedAt } : {},
      ...typeof turnStartedAt === "number" && Number.isFinite(turnStartedAt) ? { turnStartedAt } : {},
      ...typeof turnId === "string" && turnId.length > 0 ? { turnId } : {}
    };
    await atomicWrite(path, JSON.stringify(record), 384);
  } catch {}
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
    const readTitle = async () => adapter2.title({ sessionId: input.session_id, prefix: await getPrefix(), input });
    if (!config) {
      const pending = await loadPendingConfig();
      if (pending) {
        const machine2 = pending.machineName ?? hostname().replace(/\.local$/, "");
        await stashPendingEvent(input, machine2, await readTitle(), Date.now(), PENDING_STASH_PATH, process.ppid, agent);
      }
      return;
    }
    const machine = config.machineName ?? hostname().replace(/\.local$/, "");
    const title = await readTitle();
    const existingRecord = await readRecord(input.session_id);
    const sentDone = existingRecord?.sentDone === true;
    const cachedStart = typeof existingRecord?.sessionStartedAt === "number" && Number.isFinite(existingRecord.sessionStartedAt) ? existingRecord.sessionStartedAt : undefined;
    const startedAt = cachedStart ?? transcriptStartMs(await getPrefix());
    const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
    const cachedTurn = typeof existingRecord?.turnStartedAt === "number" && Number.isFinite(existingRecord.turnStartedAt) ? existingRecord.turnStartedAt : undefined;
    const turnStartedAt = hookName === "UserPromptSubmit" ? Math.floor(Date.now() / 1000) : cachedTurn;
    const turnId = typeof input.turn_id === "string" && input.turn_id.length > 0 ? input.turn_id : undefined;
    const plan = planOp(hookName, input, sentDone);
    if (!plan)
      return;
    const envelope = await buildEnvelope(input, machine, Date.now(), title, config.e2eKey, sentDone, agent, startedAt, turnStartedAt);
    if (!envelope)
      return;
    const label = typeof input.cwd === "string" && input.cwd.length > 0 ? basename(input.cwd) : "session";
    await trackSession(input.session_id, plan.op, plan.prio, plan.status, envelope.blob, machine, label, transcriptPath, agent, startedAt, turnStartedAt, turnId);
    ensureWatchdog();
    const res = await fetch(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(2000)
    });
    if (res.ok) {
      await atomicWrite(LAST_SEND_PATH, String(Date.now()));
      await resetGoneStrikes();
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

// src/entries/codex-notify.ts
function synthStopInput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null)
    return null;
  const p = parsed;
  if (p.type !== "agent-turn-complete")
    return null;
  const threadId = typeof p["thread-id"] === "string" ? p["thread-id"] : "";
  if (threadId.length === 0)
    return null;
  return {
    session_id: threadId,
    hook_event_name: "Stop",
    cwd: typeof p.cwd === "string" ? p.cwd : "",
    turn_id: typeof p["turn-id"] === "string" ? p["turn-id"] : "",
    last_assistant_message: typeof p["last-assistant-message"] === "string" ? p["last-assistant-message"] : "",
    "input-messages": Array.isArray(p["input-messages"]) ? p["input-messages"] : []
  };
}
function notifyFallbackTitle(inputMessages) {
  if (!Array.isArray(inputMessages))
    return;
  for (const m of inputMessages) {
    if (typeof m !== "string")
      continue;
    const cleaned = m.replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.startsWith("<") || /^\[[$@]/.test(cleaned))
      continue;
    return cleanPromptTitle(cleaned);
  }
  return;
}
var DEFAULT_NOTIFY_DEFER_MS = 3000;
function notifyDeferMs() {
  const env = process.env.NOMO_NOTIFY_DEFER_MS;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0)
      return n;
  }
  return DEFAULT_NOTIFY_DEFER_MS;
}
async function runNotify(raw, deferMs = notifyDeferMs(), sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  try {
    const config = await loadConfig();
    if (!config)
      return;
    const input = synthStopInput(raw);
    if (!input)
      return;
    const sessionId = input.session_id;
    const payloadTurnId = typeof input.turn_id === "string" && input.turn_id.length > 0 ? input.turn_id : undefined;
    const record = await readRecord(sessionId);
    if (record?.turnId && payloadTurnId && record.turnId !== payloadTurnId)
      return;
    if (record?.sentDone === true)
      return;
    if (deferMs > 0) {
      await sleep(deferMs);
      const after = await readRecord(sessionId);
      if (after?.sentDone === true)
        return;
      if (after?.turnId && payloadTurnId && after.turnId !== payloadTurnId)
        return;
    }
    const machine = config.machineName ?? hostname2().replace(/\.local$/, "");
    const title = await codexAdapter.title({ sessionId, prefix: "", input }) ?? notifyFallbackTitle(input["input-messages"]);
    const startedAt = typeof record?.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt) ? record.sessionStartedAt : undefined;
    const turnStartedAt = typeof record?.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? record.turnStartedAt : undefined;
    const now = Date.now();
    const envelope = await buildEnvelope(input, machine, now, title, config.e2eKey, false, "codex", startedAt, turnStartedAt);
    if (!envelope)
      return;
    const label = typeof input.cwd === "string" && input.cwd.length > 0 ? basename2(input.cwd) : "session";
    await trackSession(sessionId, "done", 0, "done", envelope.blob, machine, label, typeof record?.transcript === "string" ? record.transcript : "", "codex", startedAt, turnStartedAt, payloadTurnId);
    ensureWatchdog();
    const res = await fetch(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(2000)
    });
    if (res.ok)
      await atomicWrite(LAST_SEND_PATH, String(now));
  } catch {}
}
if (__require.main == __require.module) {
  await runNotify(process.argv[process.argv.length - 1] ?? "");
  process.exit(0);
}
export {
  synthStopInput,
  runNotify,
  notifyFallbackTitle
};
