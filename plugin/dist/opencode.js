// src/opencode/plugin.ts
import { spawn as spawn2 } from "node:child_process";
import { accessSync, constants, readFileSync as readFileSync2 } from "node:fs";
import { hostname } from "node:os";

// src/core/hook.ts
import { readdir, readFile as readFile2, unlink as unlink2 } from "node:fs/promises";

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
function fromB64url(s) {
  const standard = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - standard.length % 4) % 4);
  return base64ToBytes(padded);
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

// src/core/adapter.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";

// src/core/shared.ts
import { access, chmod, open, readFile, rename, stat, mkdir, unlink, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
var PLUGIN_VERSION = "2.2.0";
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
var SESSIONS_DIR = `${CC_DIR}/sessions`;
var WATCHDOG_PID_PATH = `${CC_DIR}/watchdog.pid`;
var LAST_SEND_PATH = `${CC_DIR}/last-send`;
var GONE_STRIKES_PATH = `${CC_DIR}/gone-strikes`;
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
var DECISION_HOLD_SUFFIX = ".hold";
function decisionHoldFileName(sessionId) {
  return `${sessionId}${DECISION_HOLD_SUFFIX}`;
}
async function atomicWrite(path, data, mode) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, mode !== undefined ? { mode } : undefined);
  await rename(tmp, path);
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
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

// src/core/terminal-focus.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileP = promisify(execFile);

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
var TITLE_TAIL_BYTES = 128 * 1024;
var INDEX_SCAN_BYTES = 128 * 1024;
var MODEL_TAIL_BYTES = 64 * 1024;
var CODEX_TURN_EVENTS = new Set(["task_started", "task_complete", "turn_aborted"]);
var CODEX_APPROVAL_REQUEST_EVENTS = new Set(["exec_approval_request", "apply_patch_approval_request"]);
var CODEX_APPROVAL_RESOLUTION_EVENTS = new Set(["exec_command_end", "patch_apply_end", "task_complete", "turn_aborted", "task_started", "user_message"]);
var CODEX_APPROVAL_RESOLUTION_ITEMS = new Set(["function_call_output", "custom_tool_call_output"]);
var CLAUDE_USER_BLOCKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
var CLAUDE_HEADLESS_ARG_TOKENS = new Set(["-p", "--print", "--output-format"]);
var TURN_STATE_TAIL_BYTES = 8 * 1024;
var PLAN_PICKER_TAIL_BYTES = 64 * 1024;
var ROLLOUT_META_HEAD_BYTES = 64 * 1024;
var CODEX_DESKTOP_ORIGINATORS = new Set(["Codex Desktop", "codex_work_desktop"]);

// src/core/hook.ts
var TOOL_DETAIL = { ...claudeToolDetail, ...codexToolDetail };
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
function buildBlob(input, machine, title, plan, agent = "claude", turnStartedAt, pinnedFolder, model, at, proposedPlan, dbgOverride) {
  const folder = folderIdentity(input.cwd, pinnedFolder);
  const { label, folderKey } = folder;
  const branch = sessionBranch(folder);
  const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const detail = detailForHook(hookName, typeof input.tool_name === "string" ? input.tool_name : undefined, input.tool_input);
  const base = {
    status: plan.status,
    title: title ?? "",
    machine,
    label,
    ...detail ? { detail } : {},
    ...agent === "claude" ? {} : { agent },
    ...typeof turnStartedAt === "number" && Number.isFinite(turnStartedAt) ? { turnStartedAt } : {},
    ...typeof model === "string" && model.length > 0 ? { model } : {},
    ...typeof at === "number" && Number.isFinite(at) ? { at } : {},
    ...folderKey ? { folderKey } : {},
    ...branch ? { branch } : {}
  };
  const dbg = agent === "codex" ? dbgOverride ?? formatPlanPickerDebug({
    event: hookName || "event",
    classifier: plan.status === "needsAttention" ? "attn" : plan.status === "working" ? "work" : "done",
    by: "h"
  }) : undefined;
  return appendFittedPlanAndDebug(base, proposedPlan, dbg);
}
async function buildEnvelope(input, machine, now, title, e2eKey, sentDone, agent = "claude", startedAt, turnStartedAt, pinnedFolder, model, planOverride, attentionKindOverride, proposedPlan, dbg, onBlobPlaintext) {
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
  const plaintext = buildBlob(i, machine, title, plan, agent, turnStartedAt, pinnedFolder, model, at, proposedPlan, dbg);
  try {
    onBlobPlaintext?.(plaintext);
  } catch {}
  const blob = await encryptBlob(e2eKey, plaintext);
  const attentionKind = attentionKindOverride ?? (agent === "codex" && hookName === "PreToolUse" && i.tool_name === "request_user_input" ? "userInput" : undefined);
  return { ...base, ...attentionKind ? { attentionKind } : {}, blob };
}
async function trackSessionAt(sessionsDir, sessionId, op, prio, status, blob, machine, folder, transcript, agent = "claude", sessionStartedAt, turnStartedAt, turnId, title, pairingId, model, pendingPlanPicker = false, pid = process.ppid, origin, planPickerVerificationPending = false, dbg, attentionKind, planFull) {
  try {
    const path = `${sessionsDir}/${sessionId}.json`;
    if (op === "end") {
      await unlink2(path).catch(() => {});
      await unlink2(`${sessionsDir}/${decisionHoldFileName(sessionId)}`).catch(() => {});
      return;
    }
    const recordedAt = Date.now();
    const { label, folderKey, cwd, gitDir } = typeof folder === "string" ? { label: folder, folderKey: undefined, cwd: undefined, gitDir: undefined } : folder;
    const record = {
      pid,
      machine,
      label,
      ...folderKey ? { folderKey } : {},
      ...cwd ? { cwd } : {},
      ...gitDir ? { gitDir } : {},
      ts: recordedAt,
      transcript,
      lastEvent: op === "start" ? "sessionStart" : status,
      sentDone: op === "done",
      ...op === "done" ? { donePending: true } : {},
      op,
      prio,
      ...blob ? { blob } : {},
      ...agent === "claude" ? {} : { agent },
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
async function trackSession(sessionId, op, prio, status, blob, machine, folder, transcript, agent = "claude", sessionStartedAt, turnStartedAt, turnId, title, pairingId, model, pendingPlanPicker = false, pid = process.ppid, origin, planPickerVerificationPending = false, dbg, attentionKind, planFull) {
  return trackSessionAt(SESSIONS_DIR, sessionId, op, prio, status, blob, machine, folder, transcript, agent, sessionStartedAt, turnStartedAt, turnId, title, pairingId, model, pendingPlanPicker, pid, origin, planPickerVerificationPending, dbg, attentionKind, planFull);
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

// src/opencode/state.ts
function newOcState() {
  return { sessions: new Map, children: new Set };
}
function isDefaultOcTitle(title) {
  return /^(New|Child) session - /.test(title);
}
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : undefined;
}
function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function ocModelFromMessage(info) {
  if (info.role !== "assistant")
    return;
  const providerID = asString(info.providerID);
  const modelID = asString(info.modelID);
  if (!providerID || !modelID)
    return;
  return `${providerID}/${modelID}`;
}
function statusType(status) {
  if (typeof status === "string")
    return status;
  return asString(asRecord(status)?.type);
}
function reduceOcEvent(state, event, now = Date.now()) {
  const e = asRecord(event);
  const type = asString(e?.type);
  if (!e || !type)
    return null;
  const properties = asRecord(e.properties) ?? {};
  const info = asRecord(properties.info);
  if (info && type.startsWith("session.")) {
    const id = asString(info.id);
    if (id && asString(info.parentID))
      state.children.add(id);
  }
  const sessionId = asString(properties.sessionID) ?? (type.startsWith("session.") ? asString(info?.id) : undefined);
  if (!sessionId || state.children.has(sessionId))
    return null;
  const entry = state.sessions.get(sessionId);
  switch (type) {
    case "session.created": {
      const startedAt = Number(asRecord(info?.time)?.created);
      const created = {
        startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : now,
        working: false
      };
      applyTitle(created, info);
      state.sessions.set(sessionId, created);
      return frame(sessionId, created, "start", "working", now);
    }
    case "session.updated": {
      if (!entry)
        return null;
      applyTitle(entry, info);
      return null;
    }
    case "message.updated": {
      if (!entry || !info)
        return null;
      const model = ocModelFromMessage(info);
      if (model)
        entry.model = model;
      return null;
    }
    case "session.status": {
      const live = entry ?? adopt(state, sessionId, now);
      const status = statusType(properties.status);
      if (status !== "busy" && status !== "retry")
        return null;
      const detail = status === "retry" ? asString(asRecord(properties.status)?.message) : undefined;
      const planned = frame(sessionId, live, "update", "working", now, detail);
      const key = JSON.stringify([planned.status, planned.detail, planned.title, planned.model]);
      if (live.lastStatusFrame === key)
        return null;
      live.lastStatusFrame = key;
      return planned;
    }
    case "session.idle": {
      if (!entry)
        return null;
      entry.working = false;
      entry.turnStartedAt = undefined;
      entry.lastStatusFrame = undefined;
      return frame(sessionId, entry, "done", "done", now);
    }
    case "session.deleted": {
      if (!entry)
        return null;
      state.sessions.delete(sessionId);
      return frame(sessionId, entry, "end", "done", now);
    }
    default:
      return null;
  }
}
function ocEndFrames(state, now = Date.now()) {
  const frames = [...state.sessions].map(([sessionId, entry]) => frame(sessionId, entry, "end", "done", now));
  state.sessions.clear();
  return frames;
}
function adopt(state, sessionId, now) {
  const entry = { startedAt: now, working: false };
  state.sessions.set(sessionId, entry);
  return entry;
}
function applyTitle(entry, info) {
  const title = asString(info?.title);
  if (title && !isDefaultOcTitle(title))
    entry.title = title;
}
function frame(sessionId, entry, op, status, now, detail) {
  if (status === "working" && op !== "start") {
    if (!entry.working || entry.turnStartedAt === undefined)
      entry.turnStartedAt = Math.floor(now / 1000);
    entry.working = true;
  }
  return {
    sessionId,
    op,
    prio: 0,
    status,
    ...detail ? { detail } : {},
    ...entry.title ? { title: entry.title } : {},
    ...entry.model ? { model: entry.model } : {},
    startedAt: entry.startedAt,
    ...status === "working" && entry.turnStartedAt !== undefined ? { turnStartedAt: entry.turnStartedAt } : {}
  };
}
async function postOcEvent(config, envelope) {
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
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok)
      return false;
    await atomicWrite(LAST_SEND_PATH, String(Date.now())).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// src/opencode/plugin.ts
function resolveRuntime() {
  const env = process.env.NOMO_RUNTIME;
  if (env && env.length > 0 && isExecutable(env))
    return env;
  try {
    const cached = readFileSync2(`${CC_DIR}/runtime`, "utf8").trim();
    if (cached.length > 0 && !cached.startsWith("NONE:") && isExecutable(cached))
      return cached;
  } catch {}
  return;
}
function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function spawnWatchdog() {
  const runtime = resolveRuntime();
  if (!runtime)
    return;
  spawn2(runtime, [WATCHDOG_PATH], { detached: true, stdio: "ignore" }).unref();
}
async function send(ctx, frame2) {
  const now = Date.now();
  const input = frame2.detail ? {
    session_id: frame2.sessionId,
    cwd: ctx.folder.cwd,
    hook_event_name: "PreToolUse",
    tool_name: "request_user_input",
    tool_input: { questions: [{ question: frame2.detail }] }
  } : { session_id: frame2.sessionId, cwd: ctx.folder.cwd };
  const envelope = await buildEnvelope(input, ctx.machine, now, frame2.title, ctx.config.e2eKey, false, "opencode", frame2.startedAt, frame2.turnStartedAt, ctx.folder, frame2.model, { op: frame2.op, prio: frame2.prio, status: frame2.status });
  if (!envelope)
    return;
  await trackSession(frame2.sessionId, frame2.op, frame2.prio, frame2.status, envelope.blob, ctx.machine, ctx.folder, "", "opencode", frame2.startedAt, frame2.turnStartedAt, undefined, frame2.title, ctx.config.pairingId, frame2.model, false, process.pid, ctx.origin);
  ensureWatchdog({ spawnWatchdog });
  const delivered = await postOcEvent(ctx.config, envelope);
  if (delivered && frame2.op === "done")
    await markDoneDelivered(frame2.sessionId);
}
var server = async (input) => {
  try {
    const config = await loadConfig();
    if (!config)
      return {};
    const directory = typeof input?.directory === "string" && input.directory.length > 0 ? input.directory : typeof input?.worktree === "string" ? input.worktree : undefined;
    const ctx = {
      config,
      machine: config.machineName ?? hostname().replace(/\.local$/, ""),
      folder: folderIdentity(directory),
      origin: { hook_event_name: "opencode", ...directory ? { cwd: directory } : {}, ppid: process.ppid },
      state: newOcState()
    };
    let chain = Promise.resolve();
    const enqueue = (task) => {
      chain = chain.then(task).catch(() => {});
      return chain;
    };
    return {
      event: async ({ event }) => {
        try {
          const frame2 = reduceOcEvent(ctx.state, event);
          if (frame2)
            await enqueue(() => send(ctx, frame2));
        } catch {}
      },
      dispose: async () => {
        try {
          const frames = ocEndFrames(ctx.state);
          await enqueue(async () => {
            for (const frame2 of frames)
              await send(ctx, frame2);
          });
        } catch {}
      }
    };
  } catch {
    return {};
  }
};
var plugin_default = { id: "nomo", server };
export {
  plugin_default as default
};
