// reset — the user-facing PANIC BUTTON for stuck/phantom session state. Recovers WITHOUT unpairing:
//
//   1. Stops the running watchdog (verifying the pidfile's pid really is a cc-watchdog before
//      killing — a recycled pid must never take out an innocent process) and removes its pidfile.
//   2. Sweeps ~/.config/cc-status/sessions/*.json: every record whose pid is DEAD, or that is
//      PROVISIONAL (a discovery sentinel), or that is corrupt, gets an op:end POSTed under the
//      CURRENT pairing (an end carries no blob, so it clears the phone row regardless of which key
//      sealed the record's stale blob) and its file deleted. Records with LIVE pids are left alone.
//   3. Pairing, keys, and config.json are NOT touched — that is `unpair`'s job.
//
// Interactive command (same output contract as unpair): sequential stdout lines, ALWAYS exit 0 —
// "nothing to reset" is a normal, successful outcome. The watchdog restarts automatically on the
// next hook event (ensureWatchdog), so stopping it here is always safe.
//
// PORTABILITY: bun AND node >= 18 (bundled by build.ts) — no Bun.* APIs.

import { execFileSync } from "node:child_process";
import { readdir, readFile, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { Config, loadConfig, pidAlive, PLUGIN_VERSION, SessionRecord, SESSIONS_DIR, WATCHDOG_PID_PATH } from "../core/shared";

export type ResetVerdict = "clear" | "keep";

/** Pure per-record decision for the reset sweep. `clear` → end it on the phone (when paired) and
 *  delete the file; `keep` → a live, real session — leave it completely alone. Cleared: a corrupt /
 *  pid-less record (nothing can ever reap it), a PROVISIONAL record (a discovery sentinel — the very
 *  ghost this button exists for), or a dead pid. Liveness is injected so this stays testable. */
export function classifyResetSession(record: SessionRecord | null, isAlive: (pid: number) => boolean): ResetVerdict {
  if (!record || typeof record.pid !== "number" || !Number.isFinite(record.pid)) return "clear";
  if (record.provisional === true) return "clear";
  return isAlive(record.pid) ? "keep" : "clear";
}

/** Whether a `ps -o command=` line is our watchdog. The daemon runs as `<runtime> …/cc-watchdog.mjs`
 *  (or the raw .ts in dev), so the script name is the stable fingerprint. */
export function isWatchdogCommand(psCommand: string): boolean {
  return psCommand.includes("cc-watchdog");
}

/** Injectable seams so reset.test.ts can drive the sweep without real processes/fs/network. */
export interface ResetDeps {
  print?: (line: string) => void;
  fetchFn?: typeof fetch;
  loadConfigFn?: () => Promise<Config | null>;
  sessionsDir?: string;
  watchdogPidPath?: string;
  isAlive?: (pid: number) => boolean;
  /** `ps -o command= -p <pid>` — the safety check before killing the pidfile's pid. */
  commandOf?: (pid: number) => string | undefined;
  killPid?: (pid: number) => void;
}

/** The `ps -o command= -p <pid>` line for a pid, or undefined when the pid is gone / ps fails. */
function psCommandOf(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const line = out.trim();
    return line.length > 0 ? line : undefined;
  } catch {
    return undefined;
  }
}

/** Stop the watchdog if one is genuinely running: pidfile → pid → VERIFY the pid's command really is
 *  cc-watchdog → SIGTERM → remove the pidfile. A stale pidfile (dead pid, or a recycled pid now owned
 *  by some other program) is removed without killing anything. Returns what happened for the summary. */
async function stopWatchdog(deps: ResetDeps): Promise<"killed" | "stale-pidfile" | "none"> {
  const pidPath = deps.watchdogPidPath ?? WATCHDOG_PID_PATH;
  const commandOf = deps.commandOf ?? psCommandOf;
  const killPid = deps.killPid ?? ((pid: number) => process.kill(pid));
  let raw: string;
  try {
    raw = await readFile(pidPath, "utf8");
  } catch {
    return "none"; // no pidfile → no watchdog to stop
  }
  const pid = Number.parseInt(raw.trim(), 10);
  let killed = false;
  if (Number.isFinite(pid) && pid > 1) {
    const cmd = commandOf(pid);
    if (cmd !== undefined && isWatchdogCommand(cmd)) {
      try { killPid(pid); killed = true; } catch { /* raced its own exit — fine */ }
    }
  }
  await unlink(pidPath).catch(() => {});
  return killed ? "killed" : "stale-pidfile";
}

/** POST a blob-less op:end for a cleared session under the CURRENT pairing. Best-effort, 2 s ceiling;
 *  true iff the worker 2xx'd (the phone row will clear). */
async function postEnd(config: Config, sessionId: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`${config.url}/v1/cc/event`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret, "x-cc-version": PLUGIN_VERSION },
      body: JSON.stringify({ v: 2, sessionId, op: "end", prio: 0, ts: Date.now() }),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The reset command body. Always returns 0 — see the header contract. */
export async function reset(deps: ResetDeps = {}): Promise<number> {
  const print = deps.print ?? ((line: string) => console.log(line));
  const fetchFn = deps.fetchFn ?? fetch;
  const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;
  const isAlive = deps.isAlive ?? pidAlive;

  // 1. Watchdog.
  const wd = await stopWatchdog(deps);
  if (wd === "killed") print("Stopped the watchdog (it restarts automatically on your next session).");
  else if (wd === "stale-pidfile") print("Removed a stale watchdog pidfile (no watchdog was running).");
  else print("No watchdog running.");

  // 2. Session sweep — needs the pairing only for the phone-side end; local cleanup works unpaired.
  const config = await (deps.loadConfigFn ?? loadConfig)();
  let files: string[] = [];
  try {
    files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    files = []; // no sessions dir yet
  }
  let cleared = 0;
  let ended = 0;
  let kept = 0;
  for (const f of files) {
    const path = `${sessionsDir}/${f}`;
    let record: SessionRecord | null = null;
    try { record = JSON.parse(await readFile(path, "utf8")) as SessionRecord; } catch { record = null; }
    if (classifyResetSession(record, isAlive) === "keep") {
      kept++;
      continue;
    }
    if (config && await postEnd(config, basename(f, ".json"), fetchFn)) ended++;
    await unlink(path).catch(() => {});
    cleared++;
  }

  if (cleared > 0) {
    print(`Cleared ${cleared} stale session record${cleared === 1 ? "" : "s"}${config ? ` (${ended} end signal${ended === 1 ? "" : "s"} delivered to your phone)` : " (not paired — cleared locally only)"}.`);
  } else {
    print("No stale sessions to clear.");
  }
  if (kept > 0) print(`Left ${kept} live session${kept === 1 ? "" : "s"} untouched.`);
  print("Pairing and keys were not touched — use the unpair command if you want that.");
  return 0;
}

// import.meta.main is true under bun and node >= 24 when this file is the entry; build.ts rewrites it
// for older nodes.
if (import.meta.main) {
  if (process.argv.includes("--check")) {
    console.log("usage: reset  — stop the watchdog and clear dead/phantom session rows (keeps the pairing; watchdog restarts on the next session)");
    process.exit(0);
  }
  process.exit(await reset());
}
