import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/entries/cc-watchdog.ts
import { readdir, readFile as readFile2, unlink as unlink2 } from "node:fs/promises";
import { readFileSync as readFileSync2, unlinkSync } from "node:fs";
import { basename } from "node:path";

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

// src/core/adapter.ts
import { join as join2 } from "node:path";

// src/core/shared.ts
import { chmod, open, readFile, rename, stat, mkdir, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
// src/entries/cc-watchdog.ts
var POLL_MS = 5000;
var PAIRING_TTL_MS = 600000;
var SESSION_STALE_MS = 86400000;
var HEARTBEAT_AFTER_MS = 300000;
var heartbeatAt = new Map;
function classifySession(record, now, isAlive) {
  if (!record || typeof record.pid !== "number" || !Number.isFinite(record.pid))
    return "delete";
  if (typeof record.ts !== "number" || now - record.ts > SESSION_STALE_MS)
    return "delete";
  return isAlive(record.pid) ? "keep" : "end";
}
function startedAtField(record) {
  return typeof record.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt) ? { startedAt: record.sessionStartedAt } : {};
}
function buildEndEnvelope(sessionId, now, record) {
  return { v: 2, sessionId, op: "end", prio: 0, ts: now, ...record ? startedAtField(record) : {} };
}
async function buildDoneEnvelope(sessionId, record, now, e2eKey, agent = "claude") {
  const blob = await encryptBlob(e2eKey, {
    status: "done",
    title: "",
    machine: typeof record.machine === "string" ? record.machine : "",
    label: typeof record.label === "string" ? record.label : "",
    ...agent === "codex" ? { agent: "codex" } : {},
    ...typeof record.turnStartedAt === "number" && Number.isFinite(record.turnStartedAt) ? { turnStartedAt: record.turnStartedAt } : {}
  });
  return { v: 2, sessionId, op: "done", prio: 0, ts: now, blob, ...startedAtField(record) };
}
function buildHeartbeatEnvelope(sessionId, record, now) {
  if (typeof record.blob !== "string" || record.blob.length === 0)
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
async function postEvent(config, body) {
  try {
    const res = await fetch(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId,
        "x-cc-auth": config.pcSecret
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000)
    });
    return postOutcomeForStatus(res.status);
  } catch {
    return "failed";
  }
}
var INTERRUPT_TAIL_BYTES = 8 * 1024;
var WORKING_STALE_MS = 20000;
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
async function correctInterrupt(config, path, sessionId, record, now) {
  try {
    if (!shouldInterruptCheck(record, now))
      return "uncorrected";
    let tail;
    try {
      tail = await readSuffix(record.transcript, INTERRUPT_TAIL_BYTES);
    } catch {
      return "uncorrected";
    }
    const agent = record.agent === "codex" ? "codex" : "claude";
    if (!tailShowsInterrupt(tail, agent))
      return "uncorrected";
    const outcome = await postEvent(config, await buildDoneEnvelope(sessionId, record, Date.now(), config.e2eKey, agent));
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
function shouldHeartbeat(record, now, lastHeartbeat, correctedThisSweep) {
  if (record.op === "done")
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
async function sweep(config) {
  let files;
  try {
    files = await readdir(SESSIONS_DIR);
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
    const sessionId = basename(file, ".json");
    let record = null;
    try {
      record = JSON.parse(await readFile2(path, "utf8"));
    } catch {
      record = null;
    }
    const verdict = classifySession(record, now, pidAlive);
    if (verdict === "keep") {
      remaining++;
      if (config && record) {
        const corrected = await correctInterrupt(config, path, sessionId, record, now);
        if (corrected === "revoked")
          return { revoked: true };
        if (corrected === "corrected")
          delivered = true;
        if (shouldHeartbeat(record, now, heartbeatAt.get(sessionId), corrected === "corrected")) {
          const beat = buildHeartbeatEnvelope(sessionId, record, Date.now());
          if (beat) {
            const outcome = await postEvent(config, beat);
            if (outcome === "revoked")
              return { revoked: true };
            if (outcome === "delivered") {
              heartbeatAt.set(sessionId, now);
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
    heartbeatAt.delete(sessionId);
    try {
      await unlink2(path);
    } catch {}
  }
  return { revoked: false, remaining, delivered };
}
async function goneStrikeShouldTeardown(goneStrikesPath) {
  return await recordGoneStrike(goneStrikesPath) >= GONE_STRIKE_LIMIT;
}
async function claimSingleInstance() {
  try {
    const holder = Number.parseInt(readFileSync2(WATCHDOG_PID_PATH, "utf8").trim(), 10);
    if (Number.isFinite(holder) && holder !== process.pid && pidAlive(holder))
      return false;
  } catch {}
  await atomicWrite(WATCHDOG_PID_PATH, String(process.pid));
  return true;
}
function releaseSingleInstance() {
  try {
    const holder = Number.parseInt(readFileSync2(WATCHDOG_PID_PATH, "utf8").trim(), 10);
    if (holder === process.pid)
      unlinkSync(WATCHDOG_PID_PATH);
  } catch {}
}
function pendingPairingExpired(pending, now, fallbackDeadline) {
  const deadline = typeof pending.createdAt === "number" ? pending.createdAt + PAIRING_TTL_MS : fallbackDeadline;
  return now >= deadline;
}
async function removePendingConfig() {
  try {
    await unlink2(`${CC_DIR}/config.json`);
  } catch {}
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
  try {
    while (true) {
      const config = await loadConfig();
      const result = await sweep(config);
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
        if (pending) {
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
      }
      if (remaining === 0)
        return;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    releaseSingleInstance();
  }
}
if (__require.main == __require.module) {
  try {
    await run();
  } catch {}
  process.exit(0);
}
export {
  tailShowsInterrupt,
  shouldInterruptCheck,
  shouldHeartbeat,
  postOutcomeForStatus,
  pendingPairingExpired,
  lastTurnLine,
  hasInterruptMarker,
  goneStrikeShouldTeardown,
  codexLastTurnEvent,
  classifySession,
  buildHeartbeatEnvelope,
  buildEndEnvelope,
  buildDoneEnvelope,
  PAIRING_TTL_MS
};
