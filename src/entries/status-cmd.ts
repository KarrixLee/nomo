// status-cmd — one-glance health readout for the agent → phone bridge.
//
// IT LEADS WITH THE AGENT THAT ASKED. The three launch blocks (plugin/commands/status.md,
// plugin/codex-skills/nomo-status/SKILL.md, plugin/opencode-commands/nomo-status.md) each pass their
// own agent name as argv[2], because the command cannot otherwise know. Without it this printed every
// agent's internals at everyone — four lines of Codex hook-trust at a user sitting in Claude Code, who
// reasonably read that as "why am I looking at Codex?". So: machine-wide facts first (they are true
// whoever asked), then the caller's own section, then the other agents collapsed to one line each.
//
// NOT CENSORSHIP — PROPORTION. A genuine misconfiguration in another agent (the Codex double-fire, an
// untrusted hook set) still prints in full, with its fix, in the collapsed view: it is a real problem
// and any user on the machine can go fix it. What the collapsed view drops is CAPABILITY detail
// (plugin/trust counts, the Plan-answer bridge) that only means something to a reader sitting in that
// agent — and it says which command to run there to get it back.
//
// NO ARGUMENT still prints everything, in the same order — an older command file that predates the
// argument, or a hand-run bundle, must not lose information.
//
// Interactive command (see pair.ts's output contract): pure sequential stdout, exit 0 always —
// "not paired" is information, not an error.
//
// PORTABILITY: bun AND node >= 18 (after Task 2.3 bundles it) — no Bun.* APIs.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeAdapter, codexAdapter, opencodeAdapter } from "../core/adapter";
import {
  AgentKind, CC_DIR, CODEX_HOOK_MARKER, codexAppServerSocketAvailable, codexHome, LAST_SEND_PATH,
  localApprovalsState, NO_HOLD_PATH, parseConfig, parsePendingConfig, pidAlive, PLUGIN_VERSION,
  SESSIONS_DIR, WATCHDOG_PID_PATH,
} from "../core/shared";

/** Native Codex plugin hook declarations in plugin/hooks/codex-hooks.json. Keep the status denominator
 *  in lockstep with the manifest; SessionEnd is the seventh entry and records terminal history. */
const CODEX_PLUGIN_HOOK_COUNT = 7;

export interface StatusDeps {
  print?: (line: string) => void;
  /** WHICH AGENT ASKED — the whole point of the argument the three launch blocks now pass. That agent
   *  gets its own labelled section directly under the machine-wide facts; the others collapse to one
   *  line each (plus any genuine problem, which is never hidden — see renderOther). Undefined is the
   *  no-argument contract: no agent is the subject, so every agent is rendered in full, as before. */
  audience?: AgentKind;
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
  /** Whether the shared Codex app-server control socket is reachable. Tests inject this to avoid
   * touching the user's daemon; production defaults to a bounded connect to the standard Unix socket
   * (a stat cannot tell a live daemon from the socket file a dead one left behind). */
  codexAppServerAvailable?: () => Promise<boolean>;
  /** Where the OpenCode plugin stamps its liveness (defaults to `<CC_DIR>/last-hook-opencode`). */
  lastHookOpencodePath?: string;
  /** The local remote-approvals escape-hatch flag (`<CC_DIR>/no-hold`). Its presence means permission
   *  prompts stay in the terminal and never reach the phone — the single commonest reason a user
   *  reports "my phone never asked me". Injected so a test can point it at a temp file. */
  noHoldPath?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

// --- presentation ------------------------------------------------------------------------------
//
// A terminal readout read by someone who is ALREADY confused, so the shape is fixed by the questions
// they actually arrive with, in the order they arrive:
//   1. is my phone connected to this computer at all?   → the Phone row
//   2. is this computer sending anything?               → the Delivery row
//   3. is the agent I am sitting in working?            → the caller's own section, Hooks row
//   4. why can't I see a session on my phone?           → that section's Sessions row
//   5. why didn't I get a permission prompt?            → the Approvals row
// Anything healthy costs ONE line. Anything broken costs a `!` line naming it in plain language plus a
// `→` line naming the command that fixes it — the fix is the point, not the diagnosis. Nothing prints
// a checkmark: a calm machine should be short, not decorated.

/** Per-agent presentation: display name, and the commands THIS reader can actually type. The command
 *  prefixes genuinely differ per host (`/nomo-cc:pair` vs `$nomo-pair` vs `/nomo-pair`), and telling a
 *  Codex user to run a Claude slash command is exactly the confusion this rewrite is about. A local
 *  3-row table rather than four more members on AgentAdapter — this file is the only consumer. */
const AGENT_UI: Record<AgentKind, { name: string; pair: string; approvalsOn: string; status: string }> = {
  claude: { name: "Claude Code", pair: "/nomo-cc:pair", approvalsOn: "/nomo-cc:approvals on", status: "/nomo-cc:status" },
  codex: { name: "Codex", pair: "$nomo-pair", approvalsOn: "$nomo-approvals on", status: "$nomo-status" },
  opencode: { name: "OpenCode", pair: "/nomo-pair", approvalsOn: "/nomo-approvals on", status: "/nomo-status" },
};

/** Fixed order, so two runs on the same machine never disagree about where to look. */
const AGENT_ORDER: AgentKind[] = ["claude", "codex", "opencode"];

/** Value column. Top-level rows pad the label to it; an agent's rows indent 2 and pad to it minus 2,
 *  so every value on the screen starts in the same column and the eye can run straight down it. Wide
 *  enough for the longest label that can appear in the narrower nested position ("Claude Code"). */
const VALUE_COL = 14;
const row = (label: string, value: string): string => `${label.padEnd(VALUE_COL)}${value}`;
const subRow = (label: string, value: string): string => `  ${label.padEnd(VALUE_COL - 2)}${value}`;
/** A continuation line (a `!` problem or its `→` fix) under whichever row it belongs to. */
const cont = (text: string): string => `${" ".repeat(VALUE_COL)}${text}`;

/** One agent's health, gathered once and rendered two ways: in full when it is the caller's own agent
 *  (or nobody's), and collapsed to a single line + its problems when it is somebody else's. */
interface AgentReport {
  kind: AgentKind;
  /** Whether this agent has left ANY trace on this computer (a session record, a liveness stamp, a
   *  Codex plugin section). A Claude-only machine should not be told about OpenCode at all. */
  present: boolean;
  /** The liveness row: its LABEL (OpenCode has no hooks — it loads one resident plugin module, and
   *  calling its row "Hooks" would teach a confused user something untrue) and its value. */
  hooksLabel: string;
  hooks: string;
  /** The Sessions row's value — "why can't I see a session on my phone". Already phrased against the
   *  machine total, because "Tracked sessions: 4" told a Claude Code user nothing about their own. */
  sessions: string;
  /** Rows that only matter to a reader sitting IN this agent (Codex's plugin/trust state, its Plan
   *  answer bridge). Suppressed in the collapsed view — they are capability, not fault. */
  detail: [label: string, value: string][];
  /** Genuine misconfigurations. Rendered in BOTH views: a Codex double-fire is a real problem and a
   *  Claude Code user is exactly who is able to go fix it. */
  problems: { what: string; fix?: string }[];
}

/** The caller's own agent (or, with no argument, every agent): the full section. */
function renderOwn(r: AgentReport, heading: string, print: (l: string) => void): void {
  print("");
  print(heading);
  print(subRow(r.hooksLabel, r.hooks));
  print(subRow("Sessions", r.sessions));
  for (const [label, value] of r.detail) print(subRow(label, value));
  for (const p of r.problems) {
    print(cont(`! ${p.what}`));
    if (p.fix) print(cont(`→ ${p.fix}`));
  }
}

/** Somebody else's agent: one line, plus any problem (never hidden) and a pointer to that agent's own
 *  status for the detail this view dropped. */
function renderOther(r: AgentReport, print: (l: string) => void): void {
  const ui = AGENT_UI[r.kind];
  print(subRow(ui.name, `${r.hooks} · ${r.sessions}`));
  for (const p of r.problems) {
    print(cont(`! ${p.what}`));
    if (p.fix) print(cont(`→ ${p.fix}`));
  }
  if (r.problems.length > 0) print(cont(`→ full detail: run ${ui.status} inside ${ui.name}`));
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
 *                 trusted_hash) per hook it has trust-reviewed, so this is the N-of-CODEX_PLUGIN_HOOK_COUNT
 *                 (7 since SessionEnd) trusted count — NOT the legacy config-layer hooks.json's 6.
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
  const lastHookOpencodePath = deps.lastHookOpencodePath ?? opencodeAdapter.hookStampPath();
  const noHoldPath = deps.noHoldPath ?? NO_HOLD_PATH;
  const isAlive = deps.isAlive ?? pidAlive;
  const now = deps.now ?? Date.now;
  // The SAME control-socket probe the watchdog gates its remote-input bridge on (core/shared) — one
  // definition, so "Codex app-server present" can never mean two different things in two places.
  const codexAppServerAvailable = deps.codexAppServerAvailable ?? (() => codexAppServerSocketAvailable());
  const audience = deps.audience;
  /** The commands to name in a fix. With no calling agent there is no right prefix to suggest, so the
   *  no-argument render falls back to Claude's — the same thing it did before this change. */
  const ui = AGENT_UI[audience ?? "claude"];

  // ── header ────────────────────────────────────────────────────────────────────────────────────
  // The build, because every bug report starts with "which version?" and nothing else on this screen
  // says. NOT "an update is available": this command makes no network call, and the app is what
  // flags a stale computer (it receives x-cc-version on every event) — inventing that here would be a
  // guess wearing a fact's clothes.
  print(audience ? `Nomo ${PLUGIN_VERSION} · ${AGENT_UI[audience].name}` : `Nomo ${PLUGIN_VERSION}`);

  // ── this computer ─────────────────────────────────────────────────────────────────────────────
  // True regardless of which agent asked — one pairing, one worker, one watchdog, one approvals flag
  // cover Claude Code, Codex and OpenCode together. Printed first and UNLABELLED by agent because
  // "is my phone connected at all" precedes every other question, and because a break here makes
  // every per-agent line below moot.
  let raw: string | null = null;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    // no config file
  }
  const config = raw !== null ? parseConfig(raw) : null;
  const pending = config === null && raw !== null && parsePendingConfig(raw);
  print("");
  if (config) {
    print(row("Phone", `paired · ${config.url} · pairing ${config.pairingId.slice(0, 8)}…`));
  } else if (pending) {
    // Mid-pairing: the QR was printed but no phone has claimed yet — not broken, just unfinished.
    print(row("Phone", "waiting for the QR scan — pairing was started but no phone has claimed it"));
    print(cont(`→ run ${ui.pair} to finish or retry`));
  } else {
    print(row("Phone", "NOT PAIRED — nothing from this computer reaches the app"));
    print(cont(`→ run ${ui.pair}`));
  }

  if (config) {
    // Delivery, in one line: when something last actually landed, and whether the process that keeps
    // long-running sessions honest is up. The watchdog is spawned BY the hooks (ensureWatchdog), so
    // "not running" on an idle machine is normal — say so rather than dressing it as a fault.
    let watchdog = "watchdog idle (the next turn starts it)";
    try {
      const pid = Number.parseInt((await readFile(watchdogPidPath, "utf8")).trim(), 10);
      if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) watchdog = `watchdog running (pid ${pid})`;
    } catch {
      // no pidfile → idle
    }
    let lastSend = "nothing sent yet";
    try {
      const ts = Number.parseInt((await readFile(lastSendPath, "utf8")).trim(), 10);
      if (Number.isFinite(ts) && ts > 0) lastSend = `last event sent ${humanAge(now() - ts)}`;
    } catch {
      // marker absent → never
    }
    print(row("Delivery", `${lastSend} · ${watchdog}`));

    // The local remote-approvals escape hatch. This is the whole answer to "why didn't my phone ask
    // me?", and nothing else on the machine hints at it — so it earns a permanent row, one calm line
    // when on and a named fix when off.
    if (await localApprovalsState(noHoldPath) === "on") {
      print(row("Approvals", "on — permission prompts are held and sent to your phone"));
    } else {
      print(row("Approvals", "PAUSED — prompts stay in this terminal, your phone is never asked"));
      print(cont(`→ run ${ui.approvalsOn}`));
    }
  }

  // ── per-agent gathering ───────────────────────────────────────────────────────────────────────
  // Session records, split by the agent that wrote them. "Tracked sessions: 4" was machine-wide and so
  // answered nobody's question; what a reader wants is how many of those are THEIRS. A record with no
  // `agent` key predates the Codex work and is Claude's by definition (same rule the watchdog uses).
  const perAgent: Record<string, number> = { claude: 0, codex: 0, opencode: 0 };
  let totalSessions = 0;
  try {
    for (const name of await readdir(sessionsDir)) {
      if (!name.endsWith(".json")) continue;
      totalSessions++;
      let kind = "claude";
      try {
        const parsed = JSON.parse(await readFile(join(sessionsDir, name), "utf8")) as { agent?: unknown };
        if (typeof parsed.agent === "string" && parsed.agent.length > 0) kind = parsed.agent;
      } catch {
        // unreadable/half-written record → count it in the total, attribute it to nobody
      }
      if (kind in perAgent) perAgent[kind]!++;
    }
  } catch {
    // directory absent → 0
  }

  // Native Codex plugin: the supported path — a `nomo@…` plugin in <CODEX_HOME>/config.toml whose 7
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

  /** Build one agent's Hooks row + its hooks-not-firing problem, if any.
   *
   *  THE DETECTOR IS UNCHANGED (hooksAppearStale): recent session activity plus an absent or badly
   *  lagging liveness stamp means this agent's half of the bridge is silently dead. What IS new is the
   *  `requireStamp` gate. It exists because a never-written Claude stamp cannot be told apart from
   *  "the Nomo plugin isn't installed in Claude Code" — but that ambiguity DISAPPEARS when Claude Code
   *  is the agent that just invoked this command, because the command only exists as a slash command
   *  the plugin ships. So the caller's own agent is always judged; somebody else's keeps the old gate. */
  async function hooksRow(kind: AgentKind, opts: {
    /** Whether we know this agent's plugin is installed here. */
    installed: boolean;
    sessionsDir: string;
    match: (n: string) => boolean;
    stampPath: string;
    hint: string;
  }): Promise<{ value: string; problem?: { what: string; fix?: string }; stamp: number }> {
    const stamp = await readMsMarker(opts.stampPath);
    const own = audience === kind;
    // Judge this agent only on evidence it is set up here at all — otherwise a plain-Codex or
    // plain-Claude user (pairing is machine-global) gets warned about a plugin they never installed.
    // Three kinds of evidence, any one is enough: it is the agent that just asked; its plugin is
    // recorded as installed; or it has written a liveness stamp at some point.
    if (!own && !opts.installed && stamp <= 0) return { value: "not set up here", stamp };
    // Only meaningful once paired: an unpaired machine's hooks are inert by design, so a missing stamp
    // there is expected and warning about it would be crying wolf.
    const sessionMtime = config ? await newestFileMtime(opts.sessionsDir, opts.match) : 0;
    if (hooksAppearStale(now(), sessionMtime, stamp)) {
      // The ROW stays short so the compact other-agent view survives it; the whole explanation lives on
      // the problem line, which prints identically in both views.
      const seen = stamp > 0 ? `the last one was ${humanAge(now() - stamp)}` : "none has ever run";
      return {
        value: "NOT FIRING",
        problem: {
          what: `${AGENT_UI[kind].name} was active ${humanAge(now() - sessionMtime)} but Nomo never heard about it (${seen}) — nothing new will reach your phone.`,
          fix: opts.hint.trim(),
        },
        stamp,
      };
    }
    if (stamp > 0) return { value: `firing · last ${humanAge(now() - stamp)}`, stamp };
    return { value: own ? "no activity yet — it stamps on your next turn" : "not set up here", stamp };
  }

  const sessionText = (n: number): string => {
    if (n === 0) return "none yet";
    if (n === totalSessions) return `${n} tracked`;
    return `${n} of ${totalSessions} tracked here`;
  };

  // Claude Code. No install signal of its own (see hooksRow) — treated as installed when it is the
  // caller, and otherwise judged only on evidence it has left behind.
  const claudeHooks = await hooksRow("claude", {
    installed: audience === "claude", sessionsDir: claudeProjectsDir,
    match: claudeAdapter.sessionMatch, stampPath: lastHookClaudePath,
    hint: claudeAdapter.hooksNotFiringHint,
  });
  const claudeReport: AgentReport = {
    kind: "claude", present: perAgent.claude! > 0 || claudeHooks.stamp > 0, hooksLabel: "Hooks",
    hooks: claudeHooks.value, sessions: sessionText(perAgent.claude!), detail: [],
    problems: claudeHooks.problem ? [claudeHooks.problem] : [],
  };

  // Codex. The only agent with a real installed/trusted signal on disk, and the only one carrying
  // misconfigurations another agent's user can (and should) go fix.
  const codexHooks = await hooksRow("codex", {
    installed: plugin.installed, sessionsDir: codexSessionsDir,
    match: codexAdapter.sessionMatch, stampPath: lastHookCodexPath,
    hint: codexAdapter.hooksNotFiringHint,
  });
  let pluginState: string;
  if (plugin.installed) {
    if (!plugin.enabled) pluginState = "installed, disabled";
    else if (plugin.trusted === 0) pluginState = "installed, hooks NOT trusted";
    else pluginState = `installed, trusted (${plugin.trusted}/${CODEX_PLUGIN_HOOK_COUNT})`;
  } else if (legacyEvents > 0) {
    // No native plugin, but the legacy hooks.json path is still wired — functional, just not the
    // supported surface anymore.
    pluginState = `legacy hooks.json (${legacyEvents} events)`;
  } else {
    pluginState = "not installed";
  }
  const codexProblems: { what: string; fix?: string }[] = [];
  if (codexHooks.problem) codexProblems.push(codexHooks.problem);
  if (plugin.installed && !plugin.enabled) {
    codexProblems.push({
      what: "The Nomo plugin is switched off in Codex — Codex sessions never reach your phone.",
      fix: "re-enable the nomo plugin in Codex",
    });
  }
  if (plugin.installed && plugin.enabled && plugin.trusted === 0) {
    codexProblems.push({
      what: "Codex has not trust-reviewed Nomo's hooks, so Codex sessions stay invisible.",
      fix: "in Codex run /hooks and trust the Nomo entries",
    });
  }
  // Double-fire overlap (D7.1): the native plugin fires AND the legacy hooks.json fires, so every
  // event is sent twice. Tell the user to remove the legacy entries by hand.
  if (plugin.installed && plugin.enabled && legacyEvents > 0) {
    codexProblems.push({
      what: `~/.codex/hooks.json still has ${legacyEvents} legacy Nomo event(s) — every Codex event is sent twice.`,
      fix: "delete the Nomo entries (command contains codex-status.mjs) from ~/.codex/hooks.json",
    });
  }
  // Auto-discovery double-fire: Codex auto-discovers the CLAUDE plugin (nomo-cc) and, once its hooks
  // are trusted in config.toml too, runs BOTH plugins' hooks on every Codex event. Redundant load —
  // the turn_id guard prevents corruption, but it is a wasted process spawn on every single event.
  if (plugin.trusted > 0 && plugin.ccTrusted > 0) {
    codexProblems.push({
      what: "Also runs the Claude Code plugin's hooks on every Codex event — double the work, no benefit.",
      fix: "in Codex run /hooks and untrust the `nomo-cc@nomo` entries",
    });
  }
  const codexDetail: [string, string][] = [["Plugin", pluginState]];
  if (!plugin.installed && legacyEvents > 0) {
    codexDetail.push(["", "these still work, but the native Nomo plugin is the supported path now"]);
  }
  // Plan answers ride a separate control socket, so a perfectly healthy Codex plugin can still be
  // unable to answer a Plan question from the phone. Capability, not fault: it is a row in Codex's own
  // section and is dropped from the collapsed view rather than promoted to a warning.
  codexDetail.push(["Plan", await codexAppServerAvailable()
    ? "questions are answerable from your phone"
    // Deliberately not "socket missing": the socket FILE can outlive its daemon, and this line's job is
    // to name the only thing that matters — nothing is listening, so start the daemon.
    : "questions can only be answered here — run `codex app-server daemon start` before launching Codex"]);
  const codexReport: AgentReport = {
    kind: "codex", present: plugin.installed || legacyEvents > 0 || perAgent.codex! > 0 || codexHooks.stamp > 0,
    hooksLabel: "Hooks", hooks: codexHooks.value, sessions: sessionText(perAgent.codex!), detail: codexDetail,
    problems: codexProblems,
  };

  // OpenCode. No hooks and no transcript directory of its own (see opencodeAdapter) — the resident
  // plugin stamps its own liveness on every frame it sends, and that stamp is the whole signal.
  const opencodeStamp = await readMsMarker(lastHookOpencodePath);
  const opencodeReport: AgentReport = {
    kind: "opencode", present: perAgent.opencode! > 0 || opencodeStamp > 0, hooksLabel: "Plugin",
    hooks: opencodeStamp > 0
      ? `loaded · last activity ${humanAge(now() - opencodeStamp)}`
      : audience === "opencode"
        ? "no activity yet — the plugin stamps on your next turn"
        : "not set up here",
    sessions: sessionText(perAgent.opencode!),
    detail: [], problems: [],
  };

  // ── render ────────────────────────────────────────────────────────────────────────────────────
  const reports: Record<AgentKind, AgentReport> = { claude: claudeReport, codex: codexReport, opencode: opencodeReport };
  if (audience) {
    // The subject, in full and immediately under the machine facts.
    renderOwn(reports[audience], `${AGENT_UI[audience].name} — you are here`, print);
    // Then everyone else, one line each. Only agents that have actually left a trace: a Claude-only
    // machine has no business being told about OpenCode. Problems still print in full — the point is
    // proportion, not censorship.
    const others = AGENT_ORDER.filter((k) => k !== audience && reports[k].present);
    if (others.length > 0) {
      print("");
      print("Also on this computer");
      for (const k of others) renderOther(reports[k], print);
    }
  } else {
    // NO ARGUMENT: nobody is the subject, so every agent is rendered in full — the same total
    // information the command printed before it learned who was asking.
    for (const k of AGENT_ORDER) renderOwn(reports[k], AGENT_UI[k].name, print);
  }

  return 0;
}

/** The invoking agent, off argv. Anything unrecognised (including nothing) reads as "no agent asked",
 *  which is the everything-in-full render — an older command file that predates the argument, or a
 *  hand-run bundle, must keep working exactly as it did. */
export function parseAudience(argv: readonly string[]): AgentKind | undefined {
  for (const arg of argv) {
    if (arg === "claude" || arg === "codex" || arg === "opencode") return arg;
  }
  return undefined;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    console.log("usage: status [claude|codex|opencode] [--check]  — show pairing, delivery and per-agent health");
    process.exit(0);
  }
  process.exit(await statusCmd({ audience: parseAudience(process.argv.slice(2)) }));
}
