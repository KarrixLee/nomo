// permission — the Claude Code PermissionRequest hold: answer a permission prompt from the phone.
//
// Wired into hooks.json as the PermissionRequest handler (dist/cc-permission.mjs). When a session is
// on the phone's Live Activity and remote approvals are enabled, the terminal dialog is held here
// while the phone decides; otherwise it falls straight through to the normal terminal dialog.
//
// CONTRACT — this module DELIBERATELY breaks the plugin's "2s, never block" rule that every other
// entry keeps (see hook.ts:12-14 and cc-watchdog.ts's header). Each individual fetch still has a 2s
// ceiling, but the TOTAL wait is unbounded: the hook polls until the phone answers, the request is
// expired/superseded server-side, sustained downlink failure trips the give-up cap, or the process is
// killed (Esc at the terminal). Fail-open is absolute — any network error, timeout, non-200, decrypt
// failure, or unpaired/misconfigured state exits 0 with NOTHING on stdout, so the terminal dialog
// appears and Claude is never blocked on our infrastructure. The ONLY thing ever written to stdout is
// a single PermissionRequest decision line on a genuine phone answer.
//
// PORTABILITY: runs unmodified under bun AND node >= 18 — no `Bun.*` APIs. build.ts bundles this into
// dist/cc-permission.mjs.

import { access, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename } from "node:path";
import { runHook, buildBlob, OpPlan } from "./hook";
import { atomicWrite, CC_DIR, Config, loadConfig, PLUGIN_VERSION, readRecord, SessionRecord } from "./shared";
import { decryptBlob, encryptBlob } from "./crypto";

/** Local escape-hatch flag: when this file exists, the hook skips the hold entirely and behaves as a
 *  plain fire-and-forget attention event (instant terminal dialog). Toggled by `cc-permission off|on`. */
export const NO_HOLD_PATH = `${CC_DIR}/no-hold`;

/** How often to poll for the phone's answer while holding (ms). Small jitter is added per cycle. */
const POLL_INTERVAL_MS = 3_000;
/** Per-fetch ceiling — the "2s" half of the contract survives; only the TOTAL wait is unbounded. */
const FETCH_TIMEOUT_MS = 2_000;
/** Give-up cap: this many consecutive polls without a 2xx (~5 min of sustained failure) → the worker
 *  is unreachable → exit silently (fail open, terminal dialog after Esc/retry). A successful poll —
 *  including a plain {status:"pending"} — resets the counter, so a healthy hold is unbounded. */
const MAX_CONSECUTIVE_MISSES = 100;

/** The exact decision lines Claude Code consumes on stdout (frozen wire contract). */
const ALLOW_LINE = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
const DENY_LINE = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Denied from phone" } } });

/** A concise, human-readable one-liner describing what the tool wants to do — shown on the phone's
 *  card next to Allow/Deny. Pure (unit-tested); never throws (a bad URL etc. falls back to the query
 *  or the tool name). */
export function buildPermissionSummary(toolName: string, toolInput: Record<string, unknown>): string {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const truncate = (s: string, n = 80): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
  switch (toolName) {
    case "Bash": {
      const cmd = str(toolInput.command);
      return cmd ? truncate(cmd.split("\n")[0]) : toolName;
    }
    case "Edit":
    case "Write":
    case "Read":
    case "NotebookEdit": {
      const fp = str(toolInput.file_path);
      return fp ? basename(fp) : toolName;
    }
    case "WebFetch":
    case "WebSearch": {
      const url = str(toolInput.url);
      if (url) {
        try { return new URL(url).host; } catch { /* not a URL — fall through to the query */ }
      }
      const query = str(toolInput.query);
      return query ? truncate(query) : toolName;
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

/** Injectable seams so permission.test.ts drives the state machine with a scripted fetch, an instant
 *  sleep, a deterministic requestId, and a temp flag path — no real stdin/network/timers. Production
 *  uses every default. */
export interface PermissionHookDeps {
  fetchFn?: typeof fetch;
  /** Reads the hook JSON from stdin. */
  readInput?: () => Promise<string>;
  loadConfigFn?: () => Promise<Config | null>;
  readRecordFn?: (sessionId: string) => Promise<SessionRecord | null>;
  sleep?: (ms: number) => Promise<void>;
  /** Writes the ONE decision line to stdout. Called only on a genuine phone answer. */
  emit?: (line: string) => void;
  now?: () => number;
  randomUUID?: () => string;
  /** Extra ms added to each poll interval so many concurrent holds don't poll in lockstep. */
  jitter?: () => number;
  noHoldPath?: string;
  /** The no-hold fire-and-forget path (defaults to the normal attention event via runHook). */
  delegate?: () => Promise<void>;
  pollIntervalMs?: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function flagExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** The PermissionRequest hook body. See the module header for the (deliberately) unbounded-wait
 *  contract and the absolute fail-open posture. Never throws across its boundary. */
export async function runPermissionHook(deps: PermissionHookDeps = {}): Promise<void> {
  const noHoldPath = deps.noHoldPath ?? NO_HOLD_PATH;
  try {
    // Escape hatch FIRST (a file stat — no stdin consumed yet): if the user paused remote approvals
    // locally, behave exactly as the old fire-and-forget attention event (instant terminal dialog).
    // Delegating to runHook reuses the entire needs-attention pipeline (POST, tracking, watchdog) and
    // returns silently with exit 0 — it also no-ops cleanly when unpaired, so zero network in that case.
    if (await flagExists(noHoldPath)) {
      await (deps.delegate ?? (() => runHook("claude")))();
      return;
    }

    const [config, raw] = await Promise.all([
      (deps.loadConfigFn ?? loadConfig)(),
      (deps.readInput ?? readStdin)(),
    ]);
    if (!config) return; // unpaired → exit 0, zero output, zero network

    const input = JSON.parse(raw) as Record<string, unknown>;
    const sessionId = typeof input.session_id === "string" ? input.session_id : "";
    if (sessionId.length === 0) return;

    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const toolInput = typeof input.tool_input === "object" && input.tool_input !== null
      ? (input.tool_input as Record<string, unknown>)
      : {};
    const requestId = (deps.randomUUID ?? (() => crypto.randomUUID()))();
    const summary = buildPermissionSummary(toolName, toolInput);
    const now = (deps.now ?? Date.now)();
    const fetchFn = deps.fetchFn ?? fetch;

    // Build the SAME session frame the normal hook would (reuse buildBlob + the record the working
    // hooks already wrote), then seal TWO variants: `blob` carries status "decisionPending" plus the
    // two permission fields appended LAST (the iOS decoder's append-only discipline; spread-override
    // keeps `status` in its original key position), and `fallbackBlob` is the untouched plain
    // needsAttention frame the worker stores when it declines the hold — so clients that never opted
    // in never see the new status. The worker is blind and can read neither; it just picks one.
    const record = await (deps.readRecordFn ?? readRecord)(sessionId);
    const machine = config.machineName ?? hostname().replace(/\.local$/, "");
    const plan: OpPlan = { op: "update", prio: 1, status: "needsAttention" };
    const base = buildBlob(input, machine, record?.title, plan, "claude", record?.turnStartedAt, record?.label, record?.model);
    const blob = await encryptBlob(config.e2eKey, { ...base, status: "decisionPending", permissionSummary: summary, permissionRequestId: requestId });
    const fallbackBlob = await encryptBlob(config.e2eKey, base);

    const pcHeaders = { "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret, "x-cc-version": PLUGIN_VERSION };

    let hold = false;
    try {
      const res = await fetchFn(`${config.url}/v1/cc/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", ...pcHeaders },
        body: JSON.stringify({ v: 2, sessionId, requestId, op: "update", prio: 1, ts: now, blob, fallbackBlob }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) hold = ((await res.json()) as { hold?: unknown }).hold === true;
    } catch {
      return; // network/timeout on the POST → fail open (terminal dialog)
    }
    if (!hold) return; // hold:false → worker already applied the attention update → terminal dialog

    // HOLD: poll until the phone answers, the request leaves "pending", sustained failure trips the
    // give-up cap, or we're killed. Each fetch keeps its own 2s ceiling; transient failures are
    // tolerated (keep polling). A decrypt failure or requestId mismatch exits silently (fail open).
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const jitter = deps.jitter ?? (() => Math.floor(Math.random() * 500));
    const interval = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    const emit = deps.emit ?? ((line: string) => process.stdout.write(`${line}\n`));
    let misses = 0;
    for (;;) {
      let data: { status?: string; answerBlob?: string } | undefined;
      try {
        const res = await fetchFn(`${config.url}/v1/cc/decision/${requestId}`, {
          headers: pcHeaders,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.ok) data = (await res.json()) as { status?: string; answerBlob?: string };
      } catch { /* transient — counted below, kept polling until the cap */ }

      if (data) {
        misses = 0;
        if (data.status === "answered" && typeof data.answerBlob === "string") {
          // A decrypt failure here throws to the outer catch → silent exit 0 (fail open), never a retry.
          const answer = (await decryptBlob(config.e2eKey, data.answerBlob)) as { requestId?: unknown; decision?: unknown };
          if (answer.requestId === requestId) {
            if (answer.decision === "allow") emit(ALLOW_LINE);
            else if (answer.decision === "deny") emit(DENY_LINE);
          }
          return; // answered (or mismatch) → done, exactly one or zero lines emitted
        }
        if (typeof data.status === "string" && data.status !== "pending") return; // expired/superseded/unknown → silent
      } else if (++misses >= MAX_CONSECUTIVE_MISSES) {
        return; // sustained downlink failure → fail open silently
      }
      await sleep(interval + jitter());
    }
  } catch {
    // Silence + exit 0 is the contract — never surface into a Claude Code session, never block.
  }
}

// ---- local escape-hatch command (off/on/status) -------------------------------------------

export interface ApprovalsDeps {
  noHoldPath?: string;
  print?: (line: string) => void;
}

/** `cc-permission off|on|status`: toggle/report the local no-hold flag. `off` pauses remote approvals
 *  (creates the flag → prompts stay in the terminal); `on` resumes them (removes the flag); `status`
 *  reports which. Always exits 0. */
export async function approvalsCommand(sub: "off" | "on" | "status", deps: ApprovalsDeps = {}): Promise<number> {
  const path = deps.noHoldPath ?? NO_HOLD_PATH;
  const print = deps.print ?? ((line: string) => console.log(line));
  const exists = async () => {
    try { await access(path); return true; } catch { return false; }
  };
  if (sub === "off") {
    await atomicWrite(path, "", 0o600);
    print("Remote approvals are OFF for this computer — Claude Code permission prompts will appear in the terminal as usual (your phone is not asked).");
    return 0;
  }
  if (sub === "on") {
    await unlink(path).catch(() => {}); // already on / never set — fine
    print("Remote approvals are ON for this computer — when a session is on your phone's Live Activity, its permission prompts are sent to the phone to Allow or Deny.");
    return 0;
  }
  // status
  print(await exists()
    ? "Remote approvals: OFF (paused locally) — permission prompts appear in the terminal. Run `on` to resume."
    : "Remote approvals: ON — permission prompts for phone-attached sessions are sent to your phone. Run `off` to pause them here.");
  return 0;
}
