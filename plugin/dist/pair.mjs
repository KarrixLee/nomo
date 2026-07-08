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
  return {
    url: c.url.replace(/\/$/, ""),
    pairingId: c.pairingId,
    pcSecret: c.pcSecret,
    qrSecret,
    ...codeIkm ? { codeIkm } : {},
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
  const e2eKey = await deriveE2EKey(ikm, fromB64url(body.phoneNonce));
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

// src/core/pair-code.ts
import { pbkdf2 } from "node:crypto";

// src/core/wordlist.ts
var BIP39_WORDLIST = [
  "abandon",
  "ability",
  "able",
  "about",
  "above",
  "absent",
  "absorb",
  "abstract",
  "absurd",
  "abuse",
  "access",
  "accident",
  "account",
  "accuse",
  "achieve",
  "acid",
  "acoustic",
  "acquire",
  "across",
  "act",
  "action",
  "actor",
  "actress",
  "actual",
  "adapt",
  "add",
  "addict",
  "address",
  "adjust",
  "admit",
  "adult",
  "advance",
  "advice",
  "aerobic",
  "affair",
  "afford",
  "afraid",
  "again",
  "age",
  "agent",
  "agree",
  "ahead",
  "aim",
  "air",
  "airport",
  "aisle",
  "alarm",
  "album",
  "alcohol",
  "alert",
  "alien",
  "all",
  "alley",
  "allow",
  "almost",
  "alone",
  "alpha",
  "already",
  "also",
  "alter",
  "always",
  "amateur",
  "amazing",
  "among",
  "amount",
  "amused",
  "analyst",
  "anchor",
  "ancient",
  "anger",
  "angle",
  "angry",
  "animal",
  "ankle",
  "announce",
  "annual",
  "another",
  "answer",
  "antenna",
  "antique",
  "anxiety",
  "any",
  "apart",
  "apology",
  "appear",
  "apple",
  "approve",
  "april",
  "arch",
  "arctic",
  "area",
  "arena",
  "argue",
  "arm",
  "armed",
  "armor",
  "army",
  "around",
  "arrange",
  "arrest",
  "arrive",
  "arrow",
  "art",
  "artefact",
  "artist",
  "artwork",
  "ask",
  "aspect",
  "assault",
  "asset",
  "assist",
  "assume",
  "asthma",
  "athlete",
  "atom",
  "attack",
  "attend",
  "attitude",
  "attract",
  "auction",
  "audit",
  "august",
  "aunt",
  "author",
  "auto",
  "autumn",
  "average",
  "avocado",
  "avoid",
  "awake",
  "aware",
  "away",
  "awesome",
  "awful",
  "awkward",
  "axis",
  "baby",
  "bachelor",
  "bacon",
  "badge",
  "bag",
  "balance",
  "balcony",
  "ball",
  "bamboo",
  "banana",
  "banner",
  "bar",
  "barely",
  "bargain",
  "barrel",
  "base",
  "basic",
  "basket",
  "battle",
  "beach",
  "bean",
  "beauty",
  "because",
  "become",
  "beef",
  "before",
  "begin",
  "behave",
  "behind",
  "believe",
  "below",
  "belt",
  "bench",
  "benefit",
  "best",
  "betray",
  "better",
  "between",
  "beyond",
  "bicycle",
  "bid",
  "bike",
  "bind",
  "biology",
  "bird",
  "birth",
  "bitter",
  "black",
  "blade",
  "blame",
  "blanket",
  "blast",
  "bleak",
  "bless",
  "blind",
  "blood",
  "blossom",
  "blouse",
  "blue",
  "blur",
  "blush",
  "board",
  "boat",
  "body",
  "boil",
  "bomb",
  "bone",
  "bonus",
  "book",
  "boost",
  "border",
  "boring",
  "borrow",
  "boss",
  "bottom",
  "bounce",
  "box",
  "boy",
  "bracket",
  "brain",
  "brand",
  "brass",
  "brave",
  "bread",
  "breeze",
  "brick",
  "bridge",
  "brief",
  "bright",
  "bring",
  "brisk",
  "broccoli",
  "broken",
  "bronze",
  "broom",
  "brother",
  "brown",
  "brush",
  "bubble",
  "buddy",
  "budget",
  "buffalo",
  "build",
  "bulb",
  "bulk",
  "bullet",
  "bundle",
  "bunker",
  "burden",
  "burger",
  "burst",
  "bus",
  "business",
  "busy",
  "butter",
  "buyer",
  "buzz",
  "cabbage",
  "cabin",
  "cable",
  "cactus",
  "cage",
  "cake",
  "call",
  "calm",
  "camera",
  "camp",
  "can",
  "canal",
  "cancel",
  "candy",
  "cannon",
  "canoe",
  "canvas",
  "canyon",
  "capable",
  "capital",
  "captain",
  "car",
  "carbon",
  "card",
  "cargo",
  "carpet",
  "carry",
  "cart",
  "case",
  "cash",
  "casino",
  "castle",
  "casual",
  "cat",
  "catalog",
  "catch",
  "category",
  "cattle",
  "caught",
  "cause",
  "caution",
  "cave",
  "ceiling",
  "celery",
  "cement",
  "census",
  "century",
  "cereal",
  "certain",
  "chair",
  "chalk",
  "champion",
  "change",
  "chaos",
  "chapter",
  "charge",
  "chase",
  "chat",
  "cheap",
  "check",
  "cheese",
  "chef",
  "cherry",
  "chest",
  "chicken",
  "chief",
  "child",
  "chimney",
  "choice",
  "choose",
  "chronic",
  "chuckle",
  "chunk",
  "churn",
  "cigar",
  "cinnamon",
  "circle",
  "citizen",
  "city",
  "civil",
  "claim",
  "clap",
  "clarify",
  "claw",
  "clay",
  "clean",
  "clerk",
  "clever",
  "click",
  "client",
  "cliff",
  "climb",
  "clinic",
  "clip",
  "clock",
  "clog",
  "close",
  "cloth",
  "cloud",
  "clown",
  "club",
  "clump",
  "cluster",
  "clutch",
  "coach",
  "coast",
  "coconut",
  "code",
  "coffee",
  "coil",
  "coin",
  "collect",
  "color",
  "column",
  "combine",
  "come",
  "comfort",
  "comic",
  "common",
  "company",
  "concert",
  "conduct",
  "confirm",
  "congress",
  "connect",
  "consider",
  "control",
  "convince",
  "cook",
  "cool",
  "copper",
  "copy",
  "coral",
  "core",
  "corn",
  "correct",
  "cost",
  "cotton",
  "couch",
  "country",
  "couple",
  "course",
  "cousin",
  "cover",
  "coyote",
  "crack",
  "cradle",
  "craft",
  "cram",
  "crane",
  "crash",
  "crater",
  "crawl",
  "crazy",
  "cream",
  "credit",
  "creek",
  "crew",
  "cricket",
  "crime",
  "crisp",
  "critic",
  "crop",
  "cross",
  "crouch",
  "crowd",
  "crucial",
  "cruel",
  "cruise",
  "crumble",
  "crunch",
  "crush",
  "cry",
  "crystal",
  "cube",
  "culture",
  "cup",
  "cupboard",
  "curious",
  "current",
  "curtain",
  "curve",
  "cushion",
  "custom",
  "cute",
  "cycle",
  "dad",
  "damage",
  "damp",
  "dance",
  "danger",
  "daring",
  "dash",
  "daughter",
  "dawn",
  "day",
  "deal",
  "debate",
  "debris",
  "decade",
  "december",
  "decide",
  "decline",
  "decorate",
  "decrease",
  "deer",
  "defense",
  "define",
  "defy",
  "degree",
  "delay",
  "deliver",
  "demand",
  "demise",
  "denial",
  "dentist",
  "deny",
  "depart",
  "depend",
  "deposit",
  "depth",
  "deputy",
  "derive",
  "describe",
  "desert",
  "design",
  "desk",
  "despair",
  "destroy",
  "detail",
  "detect",
  "develop",
  "device",
  "devote",
  "diagram",
  "dial",
  "diamond",
  "diary",
  "dice",
  "diesel",
  "diet",
  "differ",
  "digital",
  "dignity",
  "dilemma",
  "dinner",
  "dinosaur",
  "direct",
  "dirt",
  "disagree",
  "discover",
  "disease",
  "dish",
  "dismiss",
  "disorder",
  "display",
  "distance",
  "divert",
  "divide",
  "divorce",
  "dizzy",
  "doctor",
  "document",
  "dog",
  "doll",
  "dolphin",
  "domain",
  "donate",
  "donkey",
  "donor",
  "door",
  "dose",
  "double",
  "dove",
  "draft",
  "dragon",
  "drama",
  "drastic",
  "draw",
  "dream",
  "dress",
  "drift",
  "drill",
  "drink",
  "drip",
  "drive",
  "drop",
  "drum",
  "dry",
  "duck",
  "dumb",
  "dune",
  "during",
  "dust",
  "dutch",
  "duty",
  "dwarf",
  "dynamic",
  "eager",
  "eagle",
  "early",
  "earn",
  "earth",
  "easily",
  "east",
  "easy",
  "echo",
  "ecology",
  "economy",
  "edge",
  "edit",
  "educate",
  "effort",
  "egg",
  "eight",
  "either",
  "elbow",
  "elder",
  "electric",
  "elegant",
  "element",
  "elephant",
  "elevator",
  "elite",
  "else",
  "embark",
  "embody",
  "embrace",
  "emerge",
  "emotion",
  "employ",
  "empower",
  "empty",
  "enable",
  "enact",
  "end",
  "endless",
  "endorse",
  "enemy",
  "energy",
  "enforce",
  "engage",
  "engine",
  "enhance",
  "enjoy",
  "enlist",
  "enough",
  "enrich",
  "enroll",
  "ensure",
  "enter",
  "entire",
  "entry",
  "envelope",
  "episode",
  "equal",
  "equip",
  "era",
  "erase",
  "erode",
  "erosion",
  "error",
  "erupt",
  "escape",
  "essay",
  "essence",
  "estate",
  "eternal",
  "ethics",
  "evidence",
  "evil",
  "evoke",
  "evolve",
  "exact",
  "example",
  "excess",
  "exchange",
  "excite",
  "exclude",
  "excuse",
  "execute",
  "exercise",
  "exhaust",
  "exhibit",
  "exile",
  "exist",
  "exit",
  "exotic",
  "expand",
  "expect",
  "expire",
  "explain",
  "expose",
  "express",
  "extend",
  "extra",
  "eye",
  "eyebrow",
  "fabric",
  "face",
  "faculty",
  "fade",
  "faint",
  "faith",
  "fall",
  "false",
  "fame",
  "family",
  "famous",
  "fan",
  "fancy",
  "fantasy",
  "farm",
  "fashion",
  "fat",
  "fatal",
  "father",
  "fatigue",
  "fault",
  "favorite",
  "feature",
  "february",
  "federal",
  "fee",
  "feed",
  "feel",
  "female",
  "fence",
  "festival",
  "fetch",
  "fever",
  "few",
  "fiber",
  "fiction",
  "field",
  "figure",
  "file",
  "film",
  "filter",
  "final",
  "find",
  "fine",
  "finger",
  "finish",
  "fire",
  "firm",
  "first",
  "fiscal",
  "fish",
  "fit",
  "fitness",
  "fix",
  "flag",
  "flame",
  "flash",
  "flat",
  "flavor",
  "flee",
  "flight",
  "flip",
  "float",
  "flock",
  "floor",
  "flower",
  "fluid",
  "flush",
  "fly",
  "foam",
  "focus",
  "fog",
  "foil",
  "fold",
  "follow",
  "food",
  "foot",
  "force",
  "forest",
  "forget",
  "fork",
  "fortune",
  "forum",
  "forward",
  "fossil",
  "foster",
  "found",
  "fox",
  "fragile",
  "frame",
  "frequent",
  "fresh",
  "friend",
  "fringe",
  "frog",
  "front",
  "frost",
  "frown",
  "frozen",
  "fruit",
  "fuel",
  "fun",
  "funny",
  "furnace",
  "fury",
  "future",
  "gadget",
  "gain",
  "galaxy",
  "gallery",
  "game",
  "gap",
  "garage",
  "garbage",
  "garden",
  "garlic",
  "garment",
  "gas",
  "gasp",
  "gate",
  "gather",
  "gauge",
  "gaze",
  "general",
  "genius",
  "genre",
  "gentle",
  "genuine",
  "gesture",
  "ghost",
  "giant",
  "gift",
  "giggle",
  "ginger",
  "giraffe",
  "girl",
  "give",
  "glad",
  "glance",
  "glare",
  "glass",
  "glide",
  "glimpse",
  "globe",
  "gloom",
  "glory",
  "glove",
  "glow",
  "glue",
  "goat",
  "goddess",
  "gold",
  "good",
  "goose",
  "gorilla",
  "gospel",
  "gossip",
  "govern",
  "gown",
  "grab",
  "grace",
  "grain",
  "grant",
  "grape",
  "grass",
  "gravity",
  "great",
  "green",
  "grid",
  "grief",
  "grit",
  "grocery",
  "group",
  "grow",
  "grunt",
  "guard",
  "guess",
  "guide",
  "guilt",
  "guitar",
  "gun",
  "gym",
  "habit",
  "hair",
  "half",
  "hammer",
  "hamster",
  "hand",
  "happy",
  "harbor",
  "hard",
  "harsh",
  "harvest",
  "hat",
  "have",
  "hawk",
  "hazard",
  "head",
  "health",
  "heart",
  "heavy",
  "hedgehog",
  "height",
  "hello",
  "helmet",
  "help",
  "hen",
  "hero",
  "hidden",
  "high",
  "hill",
  "hint",
  "hip",
  "hire",
  "history",
  "hobby",
  "hockey",
  "hold",
  "hole",
  "holiday",
  "hollow",
  "home",
  "honey",
  "hood",
  "hope",
  "horn",
  "horror",
  "horse",
  "hospital",
  "host",
  "hotel",
  "hour",
  "hover",
  "hub",
  "huge",
  "human",
  "humble",
  "humor",
  "hundred",
  "hungry",
  "hunt",
  "hurdle",
  "hurry",
  "hurt",
  "husband",
  "hybrid",
  "ice",
  "icon",
  "idea",
  "identify",
  "idle",
  "ignore",
  "ill",
  "illegal",
  "illness",
  "image",
  "imitate",
  "immense",
  "immune",
  "impact",
  "impose",
  "improve",
  "impulse",
  "inch",
  "include",
  "income",
  "increase",
  "index",
  "indicate",
  "indoor",
  "industry",
  "infant",
  "inflict",
  "inform",
  "inhale",
  "inherit",
  "initial",
  "inject",
  "injury",
  "inmate",
  "inner",
  "innocent",
  "input",
  "inquiry",
  "insane",
  "insect",
  "inside",
  "inspire",
  "install",
  "intact",
  "interest",
  "into",
  "invest",
  "invite",
  "involve",
  "iron",
  "island",
  "isolate",
  "issue",
  "item",
  "ivory",
  "jacket",
  "jaguar",
  "jar",
  "jazz",
  "jealous",
  "jeans",
  "jelly",
  "jewel",
  "job",
  "join",
  "joke",
  "journey",
  "joy",
  "judge",
  "juice",
  "jump",
  "jungle",
  "junior",
  "junk",
  "just",
  "kangaroo",
  "keen",
  "keep",
  "ketchup",
  "key",
  "kick",
  "kid",
  "kidney",
  "kind",
  "kingdom",
  "kiss",
  "kit",
  "kitchen",
  "kite",
  "kitten",
  "kiwi",
  "knee",
  "knife",
  "knock",
  "know",
  "lab",
  "label",
  "labor",
  "ladder",
  "lady",
  "lake",
  "lamp",
  "language",
  "laptop",
  "large",
  "later",
  "latin",
  "laugh",
  "laundry",
  "lava",
  "law",
  "lawn",
  "lawsuit",
  "layer",
  "lazy",
  "leader",
  "leaf",
  "learn",
  "leave",
  "lecture",
  "left",
  "leg",
  "legal",
  "legend",
  "leisure",
  "lemon",
  "lend",
  "length",
  "lens",
  "leopard",
  "lesson",
  "letter",
  "level",
  "liar",
  "liberty",
  "library",
  "license",
  "life",
  "lift",
  "light",
  "like",
  "limb",
  "limit",
  "link",
  "lion",
  "liquid",
  "list",
  "little",
  "live",
  "lizard",
  "load",
  "loan",
  "lobster",
  "local",
  "lock",
  "logic",
  "lonely",
  "long",
  "loop",
  "lottery",
  "loud",
  "lounge",
  "love",
  "loyal",
  "lucky",
  "luggage",
  "lumber",
  "lunar",
  "lunch",
  "luxury",
  "lyrics",
  "machine",
  "mad",
  "magic",
  "magnet",
  "maid",
  "mail",
  "main",
  "major",
  "make",
  "mammal",
  "man",
  "manage",
  "mandate",
  "mango",
  "mansion",
  "manual",
  "maple",
  "marble",
  "march",
  "margin",
  "marine",
  "market",
  "marriage",
  "mask",
  "mass",
  "master",
  "match",
  "material",
  "math",
  "matrix",
  "matter",
  "maximum",
  "maze",
  "meadow",
  "mean",
  "measure",
  "meat",
  "mechanic",
  "medal",
  "media",
  "melody",
  "melt",
  "member",
  "memory",
  "mention",
  "menu",
  "mercy",
  "merge",
  "merit",
  "merry",
  "mesh",
  "message",
  "metal",
  "method",
  "middle",
  "midnight",
  "milk",
  "million",
  "mimic",
  "mind",
  "minimum",
  "minor",
  "minute",
  "miracle",
  "mirror",
  "misery",
  "miss",
  "mistake",
  "mix",
  "mixed",
  "mixture",
  "mobile",
  "model",
  "modify",
  "mom",
  "moment",
  "monitor",
  "monkey",
  "monster",
  "month",
  "moon",
  "moral",
  "more",
  "morning",
  "mosquito",
  "mother",
  "motion",
  "motor",
  "mountain",
  "mouse",
  "move",
  "movie",
  "much",
  "muffin",
  "mule",
  "multiply",
  "muscle",
  "museum",
  "mushroom",
  "music",
  "must",
  "mutual",
  "myself",
  "mystery",
  "myth",
  "naive",
  "name",
  "napkin",
  "narrow",
  "nasty",
  "nation",
  "nature",
  "near",
  "neck",
  "need",
  "negative",
  "neglect",
  "neither",
  "nephew",
  "nerve",
  "nest",
  "net",
  "network",
  "neutral",
  "never",
  "news",
  "next",
  "nice",
  "night",
  "noble",
  "noise",
  "nominee",
  "noodle",
  "normal",
  "north",
  "nose",
  "notable",
  "note",
  "nothing",
  "notice",
  "novel",
  "now",
  "nuclear",
  "number",
  "nurse",
  "nut",
  "oak",
  "obey",
  "object",
  "oblige",
  "obscure",
  "observe",
  "obtain",
  "obvious",
  "occur",
  "ocean",
  "october",
  "odor",
  "off",
  "offer",
  "office",
  "often",
  "oil",
  "okay",
  "old",
  "olive",
  "olympic",
  "omit",
  "once",
  "one",
  "onion",
  "online",
  "only",
  "open",
  "opera",
  "opinion",
  "oppose",
  "option",
  "orange",
  "orbit",
  "orchard",
  "order",
  "ordinary",
  "organ",
  "orient",
  "original",
  "orphan",
  "ostrich",
  "other",
  "outdoor",
  "outer",
  "output",
  "outside",
  "oval",
  "oven",
  "over",
  "own",
  "owner",
  "oxygen",
  "oyster",
  "ozone",
  "pact",
  "paddle",
  "page",
  "pair",
  "palace",
  "palm",
  "panda",
  "panel",
  "panic",
  "panther",
  "paper",
  "parade",
  "parent",
  "park",
  "parrot",
  "party",
  "pass",
  "patch",
  "path",
  "patient",
  "patrol",
  "pattern",
  "pause",
  "pave",
  "payment",
  "peace",
  "peanut",
  "pear",
  "peasant",
  "pelican",
  "pen",
  "penalty",
  "pencil",
  "people",
  "pepper",
  "perfect",
  "permit",
  "person",
  "pet",
  "phone",
  "photo",
  "phrase",
  "physical",
  "piano",
  "picnic",
  "picture",
  "piece",
  "pig",
  "pigeon",
  "pill",
  "pilot",
  "pink",
  "pioneer",
  "pipe",
  "pistol",
  "pitch",
  "pizza",
  "place",
  "planet",
  "plastic",
  "plate",
  "play",
  "please",
  "pledge",
  "pluck",
  "plug",
  "plunge",
  "poem",
  "poet",
  "point",
  "polar",
  "pole",
  "police",
  "pond",
  "pony",
  "pool",
  "popular",
  "portion",
  "position",
  "possible",
  "post",
  "potato",
  "pottery",
  "poverty",
  "powder",
  "power",
  "practice",
  "praise",
  "predict",
  "prefer",
  "prepare",
  "present",
  "pretty",
  "prevent",
  "price",
  "pride",
  "primary",
  "print",
  "priority",
  "prison",
  "private",
  "prize",
  "problem",
  "process",
  "produce",
  "profit",
  "program",
  "project",
  "promote",
  "proof",
  "property",
  "prosper",
  "protect",
  "proud",
  "provide",
  "public",
  "pudding",
  "pull",
  "pulp",
  "pulse",
  "pumpkin",
  "punch",
  "pupil",
  "puppy",
  "purchase",
  "purity",
  "purpose",
  "purse",
  "push",
  "put",
  "puzzle",
  "pyramid",
  "quality",
  "quantum",
  "quarter",
  "question",
  "quick",
  "quit",
  "quiz",
  "quote",
  "rabbit",
  "raccoon",
  "race",
  "rack",
  "radar",
  "radio",
  "rail",
  "rain",
  "raise",
  "rally",
  "ramp",
  "ranch",
  "random",
  "range",
  "rapid",
  "rare",
  "rate",
  "rather",
  "raven",
  "raw",
  "razor",
  "ready",
  "real",
  "reason",
  "rebel",
  "rebuild",
  "recall",
  "receive",
  "recipe",
  "record",
  "recycle",
  "reduce",
  "reflect",
  "reform",
  "refuse",
  "region",
  "regret",
  "regular",
  "reject",
  "relax",
  "release",
  "relief",
  "rely",
  "remain",
  "remember",
  "remind",
  "remove",
  "render",
  "renew",
  "rent",
  "reopen",
  "repair",
  "repeat",
  "replace",
  "report",
  "require",
  "rescue",
  "resemble",
  "resist",
  "resource",
  "response",
  "result",
  "retire",
  "retreat",
  "return",
  "reunion",
  "reveal",
  "review",
  "reward",
  "rhythm",
  "rib",
  "ribbon",
  "rice",
  "rich",
  "ride",
  "ridge",
  "rifle",
  "right",
  "rigid",
  "ring",
  "riot",
  "ripple",
  "risk",
  "ritual",
  "rival",
  "river",
  "road",
  "roast",
  "robot",
  "robust",
  "rocket",
  "romance",
  "roof",
  "rookie",
  "room",
  "rose",
  "rotate",
  "rough",
  "round",
  "route",
  "royal",
  "rubber",
  "rude",
  "rug",
  "rule",
  "run",
  "runway",
  "rural",
  "sad",
  "saddle",
  "sadness",
  "safe",
  "sail",
  "salad",
  "salmon",
  "salon",
  "salt",
  "salute",
  "same",
  "sample",
  "sand",
  "satisfy",
  "satoshi",
  "sauce",
  "sausage",
  "save",
  "say",
  "scale",
  "scan",
  "scare",
  "scatter",
  "scene",
  "scheme",
  "school",
  "science",
  "scissors",
  "scorpion",
  "scout",
  "scrap",
  "screen",
  "script",
  "scrub",
  "sea",
  "search",
  "season",
  "seat",
  "second",
  "secret",
  "section",
  "security",
  "seed",
  "seek",
  "segment",
  "select",
  "sell",
  "seminar",
  "senior",
  "sense",
  "sentence",
  "series",
  "service",
  "session",
  "settle",
  "setup",
  "seven",
  "shadow",
  "shaft",
  "shallow",
  "share",
  "shed",
  "shell",
  "sheriff",
  "shield",
  "shift",
  "shine",
  "ship",
  "shiver",
  "shock",
  "shoe",
  "shoot",
  "shop",
  "short",
  "shoulder",
  "shove",
  "shrimp",
  "shrug",
  "shuffle",
  "shy",
  "sibling",
  "sick",
  "side",
  "siege",
  "sight",
  "sign",
  "silent",
  "silk",
  "silly",
  "silver",
  "similar",
  "simple",
  "since",
  "sing",
  "siren",
  "sister",
  "situate",
  "six",
  "size",
  "skate",
  "sketch",
  "ski",
  "skill",
  "skin",
  "skirt",
  "skull",
  "slab",
  "slam",
  "sleep",
  "slender",
  "slice",
  "slide",
  "slight",
  "slim",
  "slogan",
  "slot",
  "slow",
  "slush",
  "small",
  "smart",
  "smile",
  "smoke",
  "smooth",
  "snack",
  "snake",
  "snap",
  "sniff",
  "snow",
  "soap",
  "soccer",
  "social",
  "sock",
  "soda",
  "soft",
  "solar",
  "soldier",
  "solid",
  "solution",
  "solve",
  "someone",
  "song",
  "soon",
  "sorry",
  "sort",
  "soul",
  "sound",
  "soup",
  "source",
  "south",
  "space",
  "spare",
  "spatial",
  "spawn",
  "speak",
  "special",
  "speed",
  "spell",
  "spend",
  "sphere",
  "spice",
  "spider",
  "spike",
  "spin",
  "spirit",
  "split",
  "spoil",
  "sponsor",
  "spoon",
  "sport",
  "spot",
  "spray",
  "spread",
  "spring",
  "spy",
  "square",
  "squeeze",
  "squirrel",
  "stable",
  "stadium",
  "staff",
  "stage",
  "stairs",
  "stamp",
  "stand",
  "start",
  "state",
  "stay",
  "steak",
  "steel",
  "stem",
  "step",
  "stereo",
  "stick",
  "still",
  "sting",
  "stock",
  "stomach",
  "stone",
  "stool",
  "story",
  "stove",
  "strategy",
  "street",
  "strike",
  "strong",
  "struggle",
  "student",
  "stuff",
  "stumble",
  "style",
  "subject",
  "submit",
  "subway",
  "success",
  "such",
  "sudden",
  "suffer",
  "sugar",
  "suggest",
  "suit",
  "summer",
  "sun",
  "sunny",
  "sunset",
  "super",
  "supply",
  "supreme",
  "sure",
  "surface",
  "surge",
  "surprise",
  "surround",
  "survey",
  "suspect",
  "sustain",
  "swallow",
  "swamp",
  "swap",
  "swarm",
  "swear",
  "sweet",
  "swift",
  "swim",
  "swing",
  "switch",
  "sword",
  "symbol",
  "symptom",
  "syrup",
  "system",
  "table",
  "tackle",
  "tag",
  "tail",
  "talent",
  "talk",
  "tank",
  "tape",
  "target",
  "task",
  "taste",
  "tattoo",
  "taxi",
  "teach",
  "team",
  "tell",
  "ten",
  "tenant",
  "tennis",
  "tent",
  "term",
  "test",
  "text",
  "thank",
  "that",
  "theme",
  "then",
  "theory",
  "there",
  "they",
  "thing",
  "this",
  "thought",
  "three",
  "thrive",
  "throw",
  "thumb",
  "thunder",
  "ticket",
  "tide",
  "tiger",
  "tilt",
  "timber",
  "time",
  "tiny",
  "tip",
  "tired",
  "tissue",
  "title",
  "toast",
  "tobacco",
  "today",
  "toddler",
  "toe",
  "together",
  "toilet",
  "token",
  "tomato",
  "tomorrow",
  "tone",
  "tongue",
  "tonight",
  "tool",
  "tooth",
  "top",
  "topic",
  "topple",
  "torch",
  "tornado",
  "tortoise",
  "toss",
  "total",
  "tourist",
  "toward",
  "tower",
  "town",
  "toy",
  "track",
  "trade",
  "traffic",
  "tragic",
  "train",
  "transfer",
  "trap",
  "trash",
  "travel",
  "tray",
  "treat",
  "tree",
  "trend",
  "trial",
  "tribe",
  "trick",
  "trigger",
  "trim",
  "trip",
  "trophy",
  "trouble",
  "truck",
  "true",
  "truly",
  "trumpet",
  "trust",
  "truth",
  "try",
  "tube",
  "tuition",
  "tumble",
  "tuna",
  "tunnel",
  "turkey",
  "turn",
  "turtle",
  "twelve",
  "twenty",
  "twice",
  "twin",
  "twist",
  "two",
  "type",
  "typical",
  "ugly",
  "umbrella",
  "unable",
  "unaware",
  "uncle",
  "uncover",
  "under",
  "undo",
  "unfair",
  "unfold",
  "unhappy",
  "uniform",
  "unique",
  "unit",
  "universe",
  "unknown",
  "unlock",
  "until",
  "unusual",
  "unveil",
  "update",
  "upgrade",
  "uphold",
  "upon",
  "upper",
  "upset",
  "urban",
  "urge",
  "usage",
  "use",
  "used",
  "useful",
  "useless",
  "usual",
  "utility",
  "vacant",
  "vacuum",
  "vague",
  "valid",
  "valley",
  "valve",
  "van",
  "vanish",
  "vapor",
  "various",
  "vast",
  "vault",
  "vehicle",
  "velvet",
  "vendor",
  "venture",
  "venue",
  "verb",
  "verify",
  "version",
  "very",
  "vessel",
  "veteran",
  "viable",
  "vibrant",
  "vicious",
  "victory",
  "video",
  "view",
  "village",
  "vintage",
  "violin",
  "virtual",
  "virus",
  "visa",
  "visit",
  "visual",
  "vital",
  "vivid",
  "vocal",
  "voice",
  "void",
  "volcano",
  "volume",
  "vote",
  "voyage",
  "wage",
  "wagon",
  "wait",
  "walk",
  "wall",
  "walnut",
  "want",
  "warfare",
  "warm",
  "warrior",
  "wash",
  "wasp",
  "waste",
  "water",
  "wave",
  "way",
  "wealth",
  "weapon",
  "wear",
  "weasel",
  "weather",
  "web",
  "wedding",
  "weekend",
  "weird",
  "welcome",
  "west",
  "wet",
  "whale",
  "what",
  "wheat",
  "wheel",
  "when",
  "where",
  "whip",
  "whisper",
  "wide",
  "width",
  "wife",
  "wild",
  "will",
  "win",
  "window",
  "wine",
  "wing",
  "wink",
  "winner",
  "winter",
  "wire",
  "wisdom",
  "wise",
  "wish",
  "witness",
  "wolf",
  "woman",
  "wonder",
  "wood",
  "wool",
  "word",
  "work",
  "world",
  "worry",
  "worth",
  "wrap",
  "wreck",
  "wrestle",
  "wrist",
  "write",
  "wrong",
  "yard",
  "year",
  "yellow",
  "you",
  "young",
  "youth",
  "zebra",
  "zero",
  "zone",
  "zoo"
];

// src/core/pair-code.ts
var CODE_SALT_PREFIX = "nomo-pair-code-v1|";
var PBKDF2_ITERATIONS = 600000;
var CODE_KEY_LEN = 32;
var CODE_WORD_COUNT = 4;
function uniformIndex(maxExclusive, randomBytes) {
  const range = 65536;
  const limit = range - range % maxExclusive;
  while (true) {
    const b = randomBytes(2);
    const v = b[0] << 8 | b[1];
    if (v < limit)
      return v % maxExclusive;
  }
}
function randomCodeWords(randomBytes, count = CODE_WORD_COUNT) {
  const words = [];
  for (let i = 0;i < count; i++) {
    words.push(BIP39_WORDLIST[uniformIndex(BIP39_WORDLIST.length, randomBytes)]);
  }
  return words;
}
function deriveCodeIkm(words, pairingId) {
  const password = words.join("-");
  const salt = `${CODE_SALT_PREFIX}${pairingId}`;
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, PBKDF2_ITERATIONS, CODE_KEY_LEN, "sha256", (err, derived) => {
      if (err)
        reject(err);
      else
        resolve(new Uint8Array(derived));
    });
  });
}
function formatCodeString(channel, words) {
  return `${channel}-${words.join("-")}`.toLowerCase();
}

// src/core/pair-page.ts
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderPairPage(opts) {
  const { svg, code, expiresAt } = opts;
  const codeSection = code ? `
      <div class="or">or enter the code</div>
      <div class="code" aria-label="one-time pairing code">${esc(code)}</div>
      <p class="hint">In the Nomo app: <b>Sessions</b> → <b>Pair a Computer</b> → scan the QR, or tap <b>“Enter code”</b>.</p>` : `
      <p class="hint">In the Nomo app: <b>Sessions</b> → <b>Pair a Computer</b> → point the camera at the QR.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair with Nomo</title>
<style>
  :root {
    --bg: #f4f4f5; --card: #ffffff; --fg: #18181b; --muted: #71717a;
    --border: #e4e4e7; --accent: #6366f1; --code-bg: #f4f4f5; --shadow: rgba(0,0,0,.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #09090b; --card: #18181b; --fg: #fafafa; --muted: #a1a1aa;
      --border: #27272a; --accent: #818cf8; --code-bg: #27272a; --shadow: rgba(0,0,0,.5);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex; align-items: center; justify-content: center; padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 20px;
    box-shadow: 0 12px 40px var(--shadow);
    padding: 40px; max-width: 400px; width: 100%; text-align: center;
  }
  h1 { font-size: 22px; font-weight: 650; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 14px; margin: 0 0 28px; }
  .qr-tile {
    background: #ffffff; border-radius: 16px; padding: 16px;
    display: inline-block; line-height: 0; box-shadow: 0 2px 10px var(--shadow);
  }
  .qr-tile svg { width: 232px; height: 232px; display: block; }
  .or {
    color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
    margin: 26px 0 10px; font-weight: 600;
  }
  .code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 22px; font-weight: 600; color: var(--fg);
    background: var(--code-bg); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 12px; word-break: break-word; line-height: 1.4;
  }
  .hint { color: var(--muted); font-size: 13px; line-height: 1.5; margin: 20px 0 0; }
  .hint b { color: var(--fg); font-weight: 600; }
  .timer {
    margin-top: 24px; font-size: 13px; color: var(--muted);
    padding-top: 20px; border-top: 1px solid var(--border);
  }
  .timer #count { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--accent); }
  .timer.expired { color: #ef4444; }
  .timer.expired #count { color: #ef4444; }
</style>
</head>
<body>
  <main class="card">
    <h1>Pair with Nomo</h1>
    <p class="sub">Scan this with the Nomo app on your iPhone.</p>
    <div class="qr-tile">${svg}</div>${codeSection}
    <div class="timer" id="timer">
      Expires in <span id="count">10:00</span>
    </div>
  </main>
<script>
  (function () {
    var expiresAt = ${Math.floor(expiresAt)};
    var timer = document.getElementById("timer");
    var count = document.getElementById("count");
    function tick() {
      var ms = expiresAt - Date.now();
      if (ms <= 0) {
        timer.classList.add("expired");
        timer.textContent = "Expired — run /nomo-cc:pair again";
        clearInterval(iv);
        return;
      }
      var total = Math.floor(ms / 1000);
      var m = Math.floor(total / 60);
      var s = total % 60;
      count.textContent = m + ":" + (s < 10 ? "0" : "") + s;
    }
    var iv = setInterval(tick, 250);
    tick();
  })();
</script>
</body>
</html>
`;
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
function openInBrowser(path) {
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
  const htmlPath = deps.htmlPath ?? PAIR_HTML_PATH;
  const pickWords = deps.pickWords ?? (() => randomCodeWords(randomBytes));
  await unlink2(htmlPath).catch(() => {});
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
  let channel;
  try {
    const startBody = await startRes.json();
    if (typeof startBody.channel === "number" && Number.isInteger(startBody.channel) && startBody.channel >= 1) {
      channel = startBody.channel;
    }
  } catch {}
  let codeString;
  let codeIkm;
  if (channel !== undefined) {
    const words = pickWords();
    codeIkm = await deriveCodeIkm(words, pairingId);
    codeString = formatCodeString(channel, words);
  }
  await atomicWrite(configPath, JSON.stringify({
    url: workerUrl,
    pairingId,
    pcSecret,
    qrSecretB64: b64url(qrSecret),
    ...codeIkm ? { codeIkmB64: b64url(codeIkm) } : {},
    createdAt: now()
  }), CONFIG_MODE2);
  spawnWatchdog();
  const url = buildPairURL(workerUrl, pairingId, qrSecret);
  const page = renderPairPage({
    svg: renderQRSVG(url),
    code: codeString ?? null,
    expiresAt: now() + MAX_WAIT_MS
  });
  await atomicWrite(htmlPath, page, CONFIG_MODE2);
  const opened = (deps.openFile ?? openInBrowser)(htmlPath);
  if (opened) {
    print("Pairing page opened in your browser.");
  } else {
    print(`Open this file in a browser: ${htmlPath}`);
  }
  print("The QR code and one-time pairing code are shown on that page.");
  print("This expires in 10 minutes. Keep this session open — the next step waits for your phone.");
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
    console.log("usage: pair [wait [--timeout <seconds>]] [--check]  — pair this machine with the Nomo app (opens a browser page with the QR + code)");
    process.exit(0);
  }
  if (process.argv.includes("wait")) {
    const softTimeoutMs = parseTimeoutMs(process.argv);
    process.exit(await pairWait(softTimeoutMs !== undefined ? { softTimeoutMs } : {}));
  } else {
    process.exit(await pairStart());
  }
}
export {
  pairWait,
  pairStart,
  decryptDeviceName,
  bytesToHex,
  buildPairURL,
  DEFAULT_WORKER_URL
};
