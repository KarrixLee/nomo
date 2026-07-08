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

// src/core/icon-data.ts
var NOMO_ICON_DATA_URI = "data:image/png;base64,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";

// src/core/pair-page.ts
var CLIPBOARD_ICON = '<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + '<rect x="9" y="9" width="13" height="13" rx="2"/>' + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
var CHECK_ICON = '<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' + 'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + '<polyline points="20 6 9 17 4 12"/></svg>';
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function jsStr(s) {
  return JSON.stringify(s).replace(/</g, "\\u003c");
}
function renderPairPage(opts) {
  const { svg, code, expiresAt, poll } = opts;
  const codeSection = code ? `
      <div class="or">or enter the code</div>
      <div class="code-row">
        <span class="code" id="code" aria-label="one-time pairing code">${esc(code)}</span>
        <button class="copy" id="copy" type="button" aria-label="Copy the code" title="Copy the code">${CLIPBOARD_ICON}</button>
      </div>
      <p class="hint">In the Nomo app: <b>Sessions</b> → <b>Pair a Computer</b> → scan the QR, or tap <b>“Enter code”</b>.</p>` : `
      <p class="hint">In the Nomo app: <b>Sessions</b> → <b>Pair a Computer</b> → point the camera at the QR.</p>`;
  const pollScript = poll ? `
    polling = true;
    var poll = {
      url: ${jsStr(poll.workerURL)} + "/v1/cc/pair/status?p=" + ${jsStr(poll.pairingId)},
      auth: ${jsStr(poll.pcSecret)}
    };
    // state "claimed" → swap the whole card to a success state; stop polling + the countdown, and drop
    // the QR/code with it (the secrets are no longer needed on screen).
    function paired() {
      if (!polling) return;
      polling = false;
      if (pollIv) clearInterval(pollIv);
      clearInterval(iv);
      var card = document.getElementById("card");
      card.classList.add("done");
      card.innerHTML =
        '<div class="check" aria-hidden="true">✓</div>' +
        '<h1>Paired successfully</h1>' +
        '<p class="sub">You can close this window.</p>';
    }
    // GET {workerURL}/v1/cc/pair/status?p={pairingId} with the x-cc-auth header (worker serves CORS for
    // this route). 404 → the pending record is gone (expired) → expire(). Network / CORS blips are
    // swallowed so an offline page keeps trying quietly; only a 404 is terminal.
    function pollOnce() {
      if (!polling) return;
      fetch(poll.url, { headers: { "x-cc-auth": poll.auth }, cache: "no-store" })
        .then(function (r) {
          if (r.status === 404) { expire(); return null; }
          if (!r.ok) return null; // transient server hiccup — keep polling
          return r.json();
        })
        .then(function (body) { if (body && body.state === "claimed") paired(); })
        .catch(function () { /* offline / CORS blip — keep trying quietly */ });
    }
    pollIv = setInterval(pollOnce, 3000);
    pollOnce();` : "";
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
    --ok: #16a34a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #09090b; --card: #18181b; --fg: #fafafa; --muted: #a1a1aa;
      --border: #27272a; --accent: #818cf8; --code-bg: #27272a; --shadow: rgba(0,0,0,.5);
      --ok: #22c55e;
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
    position: relative;
    background: #ffffff; border-radius: 16px; padding: 16px;
    display: inline-block; line-height: 0; box-shadow: 0 2px 10px var(--shadow);
  }
  .qr-tile svg { width: 232px; height: 232px; display: block; }
  /* Nomo logo overlaid dead-centre on a rounded white tile. Sized to cover only a few percent of the
     QR AREA — safe at EC level Q (25% recovery), which the page QR uses. */
  .logo {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: 56px; height: 56px; border-radius: 13px; background: #ffffff;
    box-shadow: 0 0 0 3px #ffffff, 0 1px 4px rgba(0,0,0,.18);
    display: flex; align-items: center; justify-content: center; line-height: 0;
  }
  .logo img { width: 44px; height: 44px; border-radius: 10px; display: block; }
  .or {
    color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
    margin: 26px 0 10px; font-weight: 600;
  }
  .code-row { display: flex; align-items: stretch; gap: 8px; }
  .code {
    flex: 1 1 auto; min-width: 0;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 19px; font-weight: 600; color: var(--fg);
    background: var(--code-bg); border: 1px solid var(--border); border-radius: 12px;
    padding: 12px 12px; word-break: break-word; line-height: 1.35;
    display: flex; align-items: center; justify-content: center; text-align: center;
  }
  .copy {
    flex: 0 0 auto; cursor: pointer; color: #ffffff;
    background: var(--accent); border: none; border-radius: 12px;
    width: 48px; display: flex; align-items: center; justify-content: center;
    transition: background .15s, opacity .15s;
  }
  .copy:hover { opacity: .92; }
  .copy.copied { background: var(--ok); }
  .copy .ic { display: block; }
  .hint { color: var(--muted); font-size: 13px; line-height: 1.5; margin: 20px 0 0; }
  .hint b { color: var(--fg); font-weight: 600; }
  .timer {
    margin-top: 24px; font-size: 13px; color: var(--muted);
    padding-top: 20px; border-top: 1px solid var(--border);
  }
  .timer #count { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--accent); }
  .timer.expired { color: #ef4444; }
  .timer.expired #count { color: #ef4444; }
  /* Success state (swapped in on claim). */
  .card.done { padding-top: 48px; padding-bottom: 48px; }
  .check {
    width: 72px; height: 72px; margin: 0 auto 20px; border-radius: 50%;
    background: var(--ok); color: #ffffff; font-size: 40px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; line-height: 0;
  }
</style>
</head>
<body>
  <main class="card" id="card">
    <h1>Pair with Nomo</h1>
    <p class="sub">Scan this with the Nomo app on your iPhone.</p>
    <div class="qr-tile" id="qr-wrap">${svg}<div class="logo"><img src="${NOMO_ICON_DATA_URI}" alt="Nomo"></div></div>
    <div id="code-block">${codeSection}
    </div>
    <div class="timer" id="timer">
      Expires in <span id="count">10:00</span>
    </div>
  </main>
<script>
  (function () {
    var expiresAt = ${Math.floor(expiresAt)};
    var timer = document.getElementById("timer");
    var count = document.getElementById("count");
    var pollIv = null;   // the poll interval handle (set by the poll block below, if any)
    var polling = false; // true only while the poll block is actively polling

    // Expired state: the countdown hit zero OR the poll saw a 404. Stop everything and hide the QR +
    // code (the secrets are dead). Defined once here so it's safe with OR without the poll block.
    function expire() {
      polling = false;
      if (pollIv) clearInterval(pollIv);
      clearInterval(iv);
      var qr = document.getElementById("qr-wrap"); if (qr) qr.style.display = "none";
      var cb = document.getElementById("code-block"); if (cb) cb.style.display = "none";
      timer.classList.add("expired");
      timer.textContent = "Code expired — run /nomo-cc:pair again for a fresh one.";
    }
    function tick() {
      var ms = expiresAt - Date.now();
      if (ms <= 0) {
        clearInterval(iv);
        expire();
        return;
      }
      var total = Math.floor(ms / 1000);
      var m = Math.floor(total / 60);
      var s = total % 60;
      count.textContent = m + ":" + (s < 10 ? "0" : "") + s;
    }

    // Copy button: clipboard API first (best-effort), execCommand fallback (file:// pages may block the
    // async clipboard API). Flashes "Copied ✓" for ~1.5s.
    var copyBtn = document.getElementById("copy");
    var codeEl = document.getElementById("code");
    if (copyBtn && codeEl) {
      var CLIP = copyBtn.innerHTML;           // the idle clipboard glyph (as rendered)
      var CHECK = ${jsStr(CHECK_ICON)};       // swapped in on a successful copy
      copyBtn.addEventListener("click", function () {
        var text = codeEl.textContent || "";
        var done = function () {
          copyBtn.classList.add("copied");
          copyBtn.innerHTML = CHECK;          // clipboard → checkmark feedback
          copyBtn.setAttribute("aria-label", "Copied");
          setTimeout(function () {
            copyBtn.classList.remove("copied");
            copyBtn.innerHTML = CLIP;
            copyBtn.setAttribute("aria-label", "Copy the code");
          }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done); });
        } else {
          legacyCopy(text, done);
        }
      });
    }
    function legacyCopy(text, done) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done();
      } catch (e) { /* clipboard unavailable — the code is still visible to type */ }
    }
    ${pollScript}

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
var Q_TOTAL_DATA = {
  1: 13,
  2: 22,
  3: 34,
  4: 48,
  5: 62,
  6: 76,
  7: 88,
  8: 110,
  9: 132,
  10: 154
};
var Q_EC_PER_BLOCK = {
  1: 13,
  2: 22,
  3: 18,
  4: 26,
  5: 18,
  6: 24,
  7: 18,
  8: 22,
  9: 20,
  10: 24
};
var Q_GROUPS = {
  1: [[1, 13]],
  2: [[1, 22]],
  3: [[2, 17]],
  4: [[2, 24]],
  5: [[2, 15], [2, 16]],
  6: [[4, 19]],
  7: [[2, 14], [4, 15]],
  8: [[4, 18], [2, 19]],
  9: [[4, 16], [4, 17]],
  10: [[6, 19], [2, 20]]
};
var EC = {
  L: { totalData: L_TOTAL_DATA, ecPerBlock: L_EC_PER_BLOCK, groups: L_GROUPS, formatIndicator: 1 },
  Q: { totalData: Q_TOTAL_DATA, ecPerBlock: Q_EC_PER_BLOCK, groups: Q_GROUPS, formatIndicator: 3 }
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
function pickVersion(byteLen, level) {
  const totalData = EC[level].totalData;
  for (let v = 1;v <= 10; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + byteLen * 8 <= totalData[v] * 8)
      return v;
  }
  throw new Error(`payload too large for QR v1..10 at level ${level}: ${byteLen} bytes`);
}
function buildDataCodewords(bytes, version, level = "L") {
  const totalData = EC[level].totalData[version];
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
function interleave(dataCodewords, version, level) {
  const ecLen = EC[level].ecPerBlock[version];
  const blocks = [];
  let ptr = 0;
  for (const [count, dataLen] of EC[level].groups[version]) {
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
function drawFormat(g, mask, level) {
  const size = g.size;
  const data = EC[level].formatIndicator << 3 | mask;
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
function qrGrid(text, forceMask, level = "L") {
  const bytes = encoder.encode(text);
  const version = pickVersion(bytes.length, level);
  const codewords = interleave(buildDataCodewords(bytes, version, level), version, level);
  const g = newGrid(17 + 4 * version);
  drawFunctionPatterns(g, version);
  drawFormat(g, 0, level);
  drawVersion(g, version);
  drawCodewords(g, codewords);
  let bestMask = 0, bestPenalty = Infinity;
  if (forceMask !== undefined) {
    bestMask = forceMask;
  } else {
    for (let mask = 0;mask < 8; mask++) {
      applyMask(g, mask);
      drawFormat(g, mask, level);
      const penalty = penaltyScore(g);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = mask;
      }
      applyMask(g, mask);
    }
  }
  applyMask(g, bestMask);
  drawFormat(g, bestMask, level);
  return g;
}
function qrMatrix(text, level = "L") {
  return qrGrid(text, undefined, level).modules;
}

// src/qr/qr-svg.ts
function renderQRSVG(text, opts = {}) {
  const quiet = opts.quiet ?? 4;
  const pixelSize = opts.pixelSize ?? 512;
  const level = opts.ecLevel ?? "L";
  let matrix;
  try {
    matrix = qrMatrix(text, level);
  } catch {
    matrix = qrMatrix(text, "L");
  }
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
    svg: renderQRSVG(url, { ecLevel: "Q" }),
    code: codeString ?? null,
    expiresAt: now() + MAX_WAIT_MS,
    poll: { workerURL: workerUrl, pairingId, pcSecret }
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
  const showCode = deps.showCode ?? false;
  const isTTY = deps.isTTY ?? process.stdout.isTTY === true;
  if (codeString && (showCode || isTTY)) {
    print(`One-time code: ${codeString} · expires in 10 min`);
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
    console.log("usage: pair [wait [--timeout <seconds>]] [--show-code] [--check]  — pair this machine with the Nomo app (opens a browser page with the QR + code; --show-code also prints the one-time code for SSH/headless)");
    process.exit(0);
  }
  if (process.argv.includes("wait")) {
    const softTimeoutMs = parseTimeoutMs(process.argv);
    process.exit(await pairWait(softTimeoutMs !== undefined ? { softTimeoutMs } : {}));
  } else {
    process.exit(await pairStart(process.argv.includes("--show-code") ? { showCode: true } : {}));
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
