import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/entries/status-cmd.ts
import { readdir, readFile as readFile2, stat as stat2 } from "node:fs/promises";
import { join as join3 } from "node:path";

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

// src/entries/status-cmd.ts
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
    entries = await readdir(dir, { withFileTypes: true });
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
        const m = (await stat2(full)).mtimeMs;
        if (m > newest)
          newest = m;
      } catch {}
    }
  }
  return newest;
}
async function readMsMarker(path) {
  try {
    const ts = Number.parseInt((await readFile2(path, "utf8")).trim(), 10);
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
  let raw = null;
  try {
    raw = await readFile2(configPath, "utf8");
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
    const pid = Number.parseInt((await readFile2(watchdogPidPath, "utf8")).trim(), 10);
    if (Number.isFinite(pid) && pid > 0 && isAlive(pid))
      watchdog = `running (pid ${pid})`;
  } catch {}
  print(`Watchdog: ${watchdog}`);
  let lastSend = "never";
  try {
    const ts = Number.parseInt((await readFile2(lastSendPath, "utf8")).trim(), 10);
    if (Number.isFinite(ts) && ts > 0)
      lastSend = humanAge(now() - ts);
  } catch {}
  print(`Last event sent: ${lastSend}`);
  let sessions = 0;
  try {
    sessions = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json")).length;
  } catch {}
  print(`Tracked sessions: ${sessions}`);
  let plugin = { installed: false, enabled: true, trusted: 0, ccTrusted: 0 };
  try {
    plugin = parseCodexPluginState(await readFile2(codexConfigPath, "utf8"));
  } catch {}
  let legacyEvents = 0;
  try {
    legacyEvents = countCodexHookEvents(await readFile2(codexHooksPath, "utf8"));
  } catch {}
  let pluginState;
  if (plugin.installed) {
    if (!plugin.enabled)
      pluginState = "installed, disabled";
    else if (plugin.trusted === 0)
      pluginState = "installed, hooks NOT trusted (run /hooks in Codex)";
    else
      pluginState = `installed, trusted (${plugin.trusted}/6)`;
  } else if (legacyEvents > 0) {
    pluginState = `legacy hooks.json (${legacyEvents} events)`;
  } else {
    pluginState = "not installed";
  }
  print(`Codex plugin: ${pluginState}`);
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
