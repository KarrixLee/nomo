// status-cmd — one-glance health readout for the CC → phone bridge: pairing presence, watchdog
// liveness, when the hook last delivered an event, and how many sessions are being tracked.
// Interactive command (see pair.ts's output contract): pure sequential stdout, exit 0 always —
// "not paired" is information, not an error.
//
// PORTABILITY: bun AND node >= 18 (after Task 2.3 bundles it) — no Bun.* APIs.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeAdapter, codexAdapter } from "../core/adapter";
import {
  CC_DIR, CODEX_HOOK_MARKER, codexHome, LAST_SEND_PATH, parseConfig, parsePendingConfig, pidAlive,
  SESSIONS_DIR, WATCHDOG_PID_PATH,
} from "../core/shared";

export interface StatusDeps {
  print?: (line: string) => void;
  configPath?: string;
  lastSendPath?: string;
  sessionsDir?: string;
  watchdogPidPath?: string;
  /** Path to codex's hooks.json; defaults to `<CODEX_HOME>/hooks.json`. Injected so a test can point
   *  it at a temp file instead of the real ~/.codex. */
  codexHooksPath?: string;
  /** Path to codex's config.toml; defaults to `<CODEX_HOME>/config.toml` (same dir as hooks.json).
   *  Injected so a test can point it at a temp file instead of the real ~/.codex. */
  codexConfigPath?: string;
  /** Where codex's rollout transcripts live; defaults to `<CODEX_HOME>/sessions`. The newest
   *  `rollout-*.jsonl` under here dates the last codex session activity for the hooks-not-firing check. */
  codexSessionsDir?: string;
  /** Where claude's session transcripts live; defaults to `~/.claude/projects`. The newest `*.jsonl`
   *  under here dates the last claude session activity for the hooks-not-firing check. */
  claudeProjectsDir?: string;
  /** Per-agent hook-liveness stamp paths; default to `<CC_DIR>/last-hook-{codex,claude}`. Injected so a
   *  test can point them at temp files. */
  lastHookCodexPath?: string;
  lastHookClaudePath?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

/** How many hook events in a codex hooks.json register OUR command (grepping for CODEX_HOOK_MARKER
 *  inside each event's matcher-group handler commands). 0 → not installed. Tolerant of any malformed
 *  shape (returns 0) — this is a health glance, never a hard parse. */
export function countCodexHookEvents(raw: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  const hooks = (parsed as Record<string, unknown> | null)?.hooks;
  if (typeof hooks !== "object" || hooks === null) return 0;
  let count = 0;
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    const has = groups.some((g) => {
      const handlers = (g as Record<string, unknown> | null)?.hooks;
      return Array.isArray(handlers) && handlers.some((h) => {
        const cmd = (h as Record<string, unknown> | null)?.command;
        return typeof cmd === "string" && cmd.includes(CODEX_HOOK_MARKER);
      });
    });
    if (has) count++;
  }
  return count;
}

/** The native Codex plugin's state, scraped from `<CODEX_HOME>/config.toml`. A naive line-scan — NO
 *  TOML dependency, same spirit as countCodexHookEvents — tolerant of any shape (a malformed file
 *  reads as "not installed"). Reports:
 *    - installed: a `[plugins."nomo@…"]` section is present (Codex records one per added plugin).
 *    - enabled:   true unless that section carries an explicit `enabled = false` (a plugin section
 *                 with no `enabled` key is enabled by default).
 *    - trusted:   how many `[hooks.state."nomo@…"]` section headers exist — Codex writes one (with a
 *                 trusted_hash) per hook it has trust-reviewed, so this is the N-of-6 trusted count.
 *    - ccTrusted: how many `[hooks.state."nomo-cc@…"]` section headers exist — Codex auto-discovers the
 *                 CLAUDE plugin (nomo-cc, hooks/hooks.json) and lets you trust ITS hooks too; when both
 *                 this and `trusted` are >0 every Codex event runs BOTH plugins' hooks (double-fire). */
export function parseCodexPluginState(configToml: string): { installed: boolean; enabled: boolean; trusted: number; ccTrusted: number } {
  let installed = false;
  let enabled = true;
  let trusted = 0;
  let ccTrusted = 0;
  let inPluginSection = false;
  for (const raw of configToml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      // A new section header ends the nomo plugin section we may have been scanning for `enabled`.
      inPluginSection = line.startsWith("[plugins.\"nomo@");
      if (inPluginSection) installed = true;
      if (line.startsWith("[hooks.state.\"nomo@")) trusted++;
      else if (line.startsWith("[hooks.state.\"nomo-cc@")) ccTrusted++;
      continue;
    }
    if (inPluginSection) {
      const m = line.match(/^enabled\s*=\s*(true|false)\b/);
      if (m) enabled = m[1] === "true";
    }
  }
  return { installed, enabled, trusted, ccTrusted };
}

/** "12s ago" / "5m ago" / "3h ago" / "2d ago" — coarse on purpose; this is a health glance. */
export function humanAge(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Grace: the newest session activity may lead the last hook stamp by up to this much and still read
 *  healthy (the hook fires slightly after the transcript line lands; a 10-min slack absorbs clock skew
 *  and a mid-turn island toggle). Past it, the agent's hooks are silently not firing. */
const HOOK_STALE_MS = 10 * 60 * 1000;
/** Only judge an agent with session activity inside this window — an idle agent's absent/old stamp is
 *  normal, not a fault. */
const HOOK_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The hooks-not-firing decision (all args epoch ms; a 0 `sessionMtime`/`hookStamp` is the absent
 *  sentinel). True → recent session activity but a hook stamp that's absent or lagging the newest
 *  session by more than the grace, i.e. the agent's hooks appear to have silently stopped firing.
 *    - no session activity (0)                  → false (nothing to compare)
 *    - newest activity older than the window    → false (idle agent — don't nag)
 *    - recent activity, no stamp                → true  (hook never fired)
 *    - recent activity, stamp lags by > grace   → true
 *    - stamp at/after the newest session         → false (healthy) */
export function hooksAppearStale(now: number, sessionMtime: number, hookStamp: number): boolean {
  if (sessionMtime <= 0) return false;
  if (now - sessionMtime > HOOK_ACTIVITY_WINDOW_MS) return false;
  if (hookStamp <= 0) return true;
  return sessionMtime - hookStamp > HOOK_STALE_MS;
}

/** Newest mtime (epoch ms) of any file matching `match` anywhere under `dir` (recursive). 0 when the
 *  directory is absent/empty or nothing matches — the "no activity" sentinel hooksAppearStale keys off.
 *  Tolerant of unreadable dirs/files (a health glance, never a hard walk). */
async function newestFileMtime(dir: string, match: (name: string) => boolean): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // no such dir → no activity
  }
  let newest = 0;
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const m = await newestFileMtime(full, match);
      if (m > newest) newest = m;
    } else if (match(e.name)) {
      try {
        const m = (await stat(full)).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        // unreadable file → skip
      }
    }
  }
  return newest;
}

/** Read an epoch-ms marker file (the hook stamp / last-send text), or 0 when absent/unreadable/blank. */
async function readMsMarker(path: string): Promise<number> {
  try {
    const ts = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  } catch {
    return 0;
  }
}

/** Print the status block. Returns an exit code (always 0). */
export async function statusCmd(deps: StatusDeps = {}): Promise<number> {
  const print = deps.print ?? ((line: string) => console.log(line));
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

  // Pairing.
  let raw: string | null = null;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    // no config file
  }
  const config = raw !== null ? parseConfig(raw) : null;
  if (config) {
    print(`Paired: yes (pairing ${config.pairingId.slice(0, 8)}…)`);
    print(`Worker: ${config.url}`);
  } else if (raw !== null && parsePendingConfig(raw)) {
    // Mid-pairing: the QR was printed but no phone has claimed yet — not broken, just unfinished.
    print("Paired: pairing started, waiting for phone scan — run /nomo-cc:pair to finish or retry.");
  } else {
    print("Paired: no — run pair to connect this machine to the Nomo app.");
  }

  // Watchdog liveness: a pidfile naming a live process.
  let watchdog = "not running";
  try {
    const pid = Number.parseInt((await readFile(watchdogPidPath, "utf8")).trim(), 10);
    if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) watchdog = `running (pid ${pid})`;
  } catch {
    // no pidfile → not running
  }
  print(`Watchdog: ${watchdog}`);

  // Last successful event delivery (epoch-ms text written by the hook on POST success).
  let lastSend = "never";
  try {
    const ts = Number.parseInt((await readFile(lastSendPath, "utf8")).trim(), 10);
    if (Number.isFinite(ts) && ts > 0) lastSend = humanAge(now() - ts);
  } catch {
    // marker absent → never
  }
  print(`Last event sent: ${lastSend}`);

  // Live session records.
  let sessions = 0;
  try {
    sessions = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json")).length;
  } catch {
    // directory absent → 0
  }
  print(`Tracked sessions: ${sessions}`);

  // Native Codex plugin: the supported path — a `nomo@…` plugin in <CODEX_HOME>/config.toml whose 6
  // bundled hooks Codex trust-reviews via `/hooks`. Legacy = the pre-plugin `/nomo-cc:codex` path that
  // wrote OUR command into <CODEX_HOME>/hooks.json; the two can coexist on an upgraded box and then
  // every event double-fires (D7.1). Both reads are naive line-scans (no TOML dep) — this is a health
  // glance, never a hard parse.
  let plugin = { installed: false, enabled: true, trusted: 0, ccTrusted: 0 };
  try {
    plugin = parseCodexPluginState(await readFile(codexConfigPath, "utf8"));
  } catch {
    // no config.toml → not installed
  }
  let legacyEvents = 0;
  try {
    legacyEvents = countCodexHookEvents(await readFile(codexHooksPath, "utf8"));
  } catch {
    // no hooks.json → no legacy entries
  }

  let pluginState: string;
  if (plugin.installed) {
    if (!plugin.enabled) pluginState = "installed, disabled";
    else if (plugin.trusted === 0) pluginState = "installed, hooks NOT trusted (run /hooks in Codex)";
    else pluginState = `installed, trusted (${plugin.trusted}/6)`;
  } else if (legacyEvents > 0) {
    // No native plugin, but the legacy hooks.json path is still wired — functional, just not the
    // supported surface anymore.
    pluginState = `legacy hooks.json (${legacyEvents} events)`;
  } else {
    pluginState = "not installed";
  }
  print(`Codex plugin: ${pluginState}`);

  if (!plugin.installed && legacyEvents > 0) {
    print("  Legacy Codex hooks still work — consider migrating to the native Nomo plugin.");
  }
  // Double-fire overlap (D7.1): the native plugin fires AND the legacy hooks.json fires, so every
  // event is sent twice. Tell the user to remove the legacy entries by hand.
  if (plugin.installed && plugin.enabled && legacyEvents > 0) {
    print(`  WARNING: ~/.codex/hooks.json ALSO has ${legacyEvents} legacy Nomo event(s) — events will double-fire.`);
    print("  Delete the six Nomo entries (command contains codex-status.mjs) from ~/.codex/hooks.json.");
  }
  // Auto-discovery double-fire: Codex auto-discovers the CLAUDE plugin (nomo-cc) and, once its hooks are
  // trusted in config.toml too, runs BOTH plugins' hooks on every Codex event. Redundant load — the turn_id
  // guard prevents corruption, but it's a wasted spawn per event. Only when BOTH sets of entries are present.
  if (plugin.trusted > 0 && plugin.ccTrusted > 0) {
    print("  WARNING: Codex auto-discovered the Claude plugin and runs BOTH plugins' hooks on every Codex event (redundant double-fire).");
    print("  Untrust/remove the `nomo-cc@nomo` entries in Codex (`/hooks` in Codex, or delete those `[hooks.state.\"nomo-cc@…\"]` blocks from <CODEX_HOME>/config.toml) — the native `nomo` plugin alone is correct.");
  }

  // Hooks-not-firing detector: a paired machine with RECENT session activity but a hook stamp that's
  // absent or badly lagging the newest session means that agent's plugin-bundled hooks are silently
  // never firing — the island stays frozen while the transcript grows. Only meaningful once paired
  // (an unpaired machine's hooks are inert by design). Codex's #16430/#30835 make a healthy-LOOKING
  // plugin do exactly this, so the stamp is the only honest liveness signal.
  if (config) {
    // Two per-agent gates keep the detector from crying wolf when the OTHER agent's CLI runs without
    // the Nomo plugin (pairing is machine-global, so a plain-Codex or plain-Claude user still trips the
    // walk):
    //   - `enabled`: only judge an agent whose plugin we KNOW is installed here. Codex reuses the
    //     config.toml `plugin.installed` already parsed above — installed-but-silent (#16430) still
    //     warns (that's the detector's whole point); NOT installed never warns. Claude has no such
    //     signal, so it's always eligible but gated by `requireStamp` instead.
    //   - `requireStamp`: for Claude, only warn when a stamp EXISTS but lags — a never-written stamp is
    //     indistinguishable from "the Nomo plugin isn't installed in Claude Code", so it must stay quiet.
    const checks: { name: string; enabled: boolean; requireStamp: boolean; sessionsDir: string; match: (n: string) => boolean; stampPath: string; hint: string }[] = [
      {
        name: "Codex", enabled: plugin.installed, requireStamp: false, sessionsDir: codexSessionsDir,
        match: codexAdapter.sessionMatch, stampPath: lastHookCodexPath,
        hint: codexAdapter.hooksNotFiringHint,
      },
      {
        name: "Claude", enabled: true, requireStamp: true, sessionsDir: claudeProjectsDir,
        match: claudeAdapter.sessionMatch, stampPath: lastHookClaudePath,
        hint: claudeAdapter.hooksNotFiringHint,
      },
    ];
    for (const c of checks) {
      if (!c.enabled) continue; // the agent's plugin isn't installed here → nothing to judge
      const sessionMtime = await newestFileMtime(c.sessionsDir, c.match);
      const hookStamp = await readMsMarker(c.stampPath);
      if (c.requireStamp && hookStamp <= 0) continue; // no stamp ever → can't tell "silent" from "not installed"
      if (!hooksAppearStale(now(), sessionMtime, hookStamp)) continue;
      const stampAge = hookStamp > 0 ? humanAge(now() - hookStamp) : "never";
      print(`  WARNING: ${c.name} hooks appear NOT to be firing — session active ${humanAge(now() - sessionMtime)}, last hook ${stampAge}.`);
      print(c.hint);
    }
  }

  return 0;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    console.log("usage: status [--check]  — show pairing, watchdog, and delivery health");
    process.exit(0);
  }
  process.exit(await statusCmd());
}
