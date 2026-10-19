// handoff — NOM-72 P1a: move the current Claude Code session to a cloud box (omg sandbox) and keep it
// running there in tmux. One box per user, remembered in ~/.config/cc-status/cloud.json.
//
//   bun plugin/dist/handoff.mjs [--session <uuid>] [--model <id>] [--force] [--dry-run]
//   bun plugin/dist/handoff.mjs --status | --stop | --pair
//   bun plugin/dist/handoff.mjs --screen | --send "<text>" | --send-key <tmux key, e.g. Escape, BTab, C-c>
//   bun plugin/dist/handoff.mjs --bake      (one-off: publish the credential-free `nomo-base` template)
//   bun plugin/dist/handoff.mjs --back [--session <uuid>] [--force] [--no-open] [--wait <min>]
//   bun plugin/dist/handoff.mjs --later [--session <uuid>] | --later-cancel | --later-status   (/nomo-cc:handoff, see core/handoff-later.ts)
//
// WHAT TRAVELS: a git bundle of HEAD + `git diff --binary HEAD` + a tar of untracked non-ignored files
// (the user's working tree and index are only READ), the transcript (+ its subagent dir) and project
// memory into /root/.claude/projects/<same dir>/, and the user layer (~/.claude/{skills,agents,commands,
// CLAUDE.md}). The repo is recreated at the SAME absolute path because the transcript embeds its cwd.
//
// WHAT NEVER TRAVELS: the Mac's ~/.claude.json, .credentials.json or settings env. The model runs on
// OpenRouter (ANTHROPIC_AUTH_TOKEN), never the user's Claude subscription. Keys are sent ONLY
// as exec env and handed to claude through a 0600 file on /dev/shm (RAM) that the launcher deletes as it
// reads it — NOT `tmux -e`, which leaves them in the tmux server's argv for `ps` to show forever.
// The Mac's Nomo pairing (config.json) never travels either. Create-time `env` is NOT a secret channel:
// omg stores it in plaintext and forks inherit it.
//
// OPENROUTER RELAY (NOM-82): claude talks to or-relay.mjs on 127.0.0.1:RELAY_PORT (tmux `nomo-relay`,
// restarted on every handoff), which forwards to OpenRouter minus the `tool_addition` blocks OpenRouter
// rejects. The key rides CC's own Authorization header through it; the relay never sees it otherwise.
//
// BOX IMAGE: a box is created from the user's `nomo-base` template (Claude Code + bun + this plugin
// pre-installed, baked by --bake, NO credentials/pairing/transcripts) when it exists, else from omg's
// `omg` preset; the box script installs whatever is missing either way. Same size as the bake, so the
// template restores warm.
//
// NOMO ON THE BOX (P1b): this plugin's own dist is shipped and installed for root as a directory
// marketplace BEFORE claude starts, so hooks are live from SessionStart. The box pairs as ITS OWN
// computer ("Nomo Cloud") with its own keys: pair.mjs runs on the box, the box hands back only the
// nomo://pair URL (the QR content — the ephemeral private key stays there), and the Mac renders it.
// The QR is printed only to a real terminal; captured stdout (e.g. `!` inside Claude Code) gets the
// pairing page in the browser instead, because the QR is a secret that must never land in a transcript.
// The SessionStart fired while the pairing is still pending is stashed and flushed on completion.
//
// KEEP-AWAKE: omg sleeps a box 2h after start regardless of activity. We take a 30-min lease from here
// and start an in-VM loop (tmux session `nomo-keepalive`) that renews it every 10 min via the keyless
// 169.254.0.1:9090 endpoint for as long as tmux session `nomo` lives. When CC exits, the lease lapses and
// the box sleeps on its own.
//
// BRING BACK (P2, NOM-77): `--back` waits for a turn boundary on the box (Nomo's record, else an
// `end_turn` transcript + 15s quiet; --force interrupts instead), exits claude there (/exit, then C-c,
// then kill-session, then the box's reset.mjs so no ghost row stays on the phone), packs the box's work
// (bundle of BASE..HEAD, `git diff --binary HEAD`, untracked tar, transcript + subagent dir + memory),
// pulls that FIXED file list into a 0700 backup dir, hibernates the box and only then applies it on
// the Mac (core/cloud-back.ts: transcript, memory, code). What changed is judged against the snapshot
// handoff saved in cloud.json `sessions[uuid]` (HEAD, branch, worktree fingerprint, transcript size +
// sha, memory hashes): a Mac untouched since handoff fast-forwards in place, anything else lands on
// branch `nomo/cloud-<id8>`; a Mac transcript appended after handoff forks to a new session id. Box work
// that touches agent/editor/git config (.claude/, .mcp.json, CLAUDE.md, .envrc, .vscode/, …) never lands
// in place: it goes to the branch and Terminal is not opened. It refuses to stop or pack a session the box
// did not last run (/root/.nomo-current) unless --force. Ends by opening Terminal on `claude --resume`
// (--no-open just prints it).
//
// PORTABILITY: bun or node >= 18 (global fetch). Under node, an exec longer than ~300s trips undici's
// headers timeout — the box script is kept short, so prefer bun.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { b64url, type Bytes, fromB64url } from "../core/crypto";
import { renderPairPage } from "../core/pair-page";
import { buildPairURL, DEFAULT_WORKER_URL } from "../core/pair-url";
import { normalizeModelId } from "../core/adapter";
import { atomicWrite, CC_DIR, pidAlive, pidAncestors, pidCommand, readRecord, SESSIONS_DIR } from "../core/shared";
import {
  cancelPending, claimPending, LATER_LOG, laterStatus, needsPairing, type Pending, PENDING_PATH, readPending, resolveSession, waitThenHandoff,
} from "../core/handoff-later";
import {
  agentConfigPaths, applyInPlace, atomicWriteBytes, type BoxArtifacts, boxChangedPaths, boxIdle, copyContained, decideCode, extractTgz,
  landFolder, landOnBranch, listFiles, MAX_ARTIFACT_BYTES, MAX_EXTRACTED_BYTES, macGitState, mergeMemory, mkdirp, parseMarkers, printable,
  type Snapshot, takeSnapshot, transcriptAction, validateTree,
} from "../core/cloud-back";
import { renderQR } from "../qr/qr";
import { renderQRSVG } from "../qr/qr-svg";

const API = "https://infra.omg.dev/v1";
const CLOUD_PATH = `${CC_DIR}/cloud.json`;
const STAGE = "/tmp/nomo-handoff"; // flat files (/tmp/nomo-handoff-*): POST /files is only proven for existing dirs
const KEEPALIVE_S = 1800;
/** The box's computer name in the Nomo app (config.json machineName overrides the "169.254.0.2" hostname). */
export const BOX_MACHINE_NAME = "Nomo Cloud";
const PAIR_URL_MARKER = "NOMO_PAIR_URL=";
const PAIR_WAIT_MS = 600_000; // == the worker's pending-pairing TTL
const BOX_CC = "/root/.config/cc-status";
const BOX_PLUGIN = `R=$(ls -d /root/.claude/plugins/cache/nomo/nomo-cc/*/ 2>/dev/null | tail -1)`;
/** == or-relay.ts RELAY_PORT (not imported: bundling an entry inlines its main block into this one). */
export const RELAY_PORT = 47181;
const BASE_TEMPLATE = "nomo-base";
/** First line of every non-handoff box script: drop a /dev/shm/nomo-env a dead launch left behind. Only
 *  one older than a minute — a handoff in flight right now writes it and its launcher reads it in seconds. */
export const SHM_SWEEP = `find /dev/shm -maxdepth 1 -name nomo-env -mmin +1 -delete 2>/dev/null || true`;
const BOX_SIZE = "pro"; // the bake and every create must match, or the template cold-boots

/** Box-side: start a pairing unless already paired TO $NOMO_WORKER_URL (exec env; the Mac resolves it).
 *  Prints NOMO_PAIRED, NOMO_PAIR_FAILED: <why>, or the URL marker; never fails the caller (an unpaired
 *  box still runs the session). A box paired to a DIFFERENT worker prints NOMO_REPAIR: <old url> and
 *  pairs again (pair.mjs revokes the old pairing itself) — never a silently mismatched server. Only
 *  pair.mjs reads NOMO_WORKER_URL: it persists it as config.json `url`, which every hook and the
 *  watchdog read from then on. The wait lives in tmux `nomo-pair` so it outlives this exec; the watchdog
 *  pair.mjs spawns self-heals it too. */
export const PAIR_FN = `nomo_pair() {
  ${BOX_PLUGIN}
  [ -n "$R" ] || { echo "NOMO_PAIR_FAILED: the Nomo plugin is not installed on the box"; return 0; }
  local W="\${NOMO_WORKER_URL:-${DEFAULT_WORKER_URL}}"
  if grep -q '"e2eKeyB64"' ${BOX_CC}/config.json 2>/dev/null; then
    if grep -qF '"url":"'"$W"'"' ${BOX_CC}/config.json; then echo NOMO_PAIRED; return 0; fi
    echo "NOMO_REPAIR: $(grep -o '"url":"[^"]*"' ${BOX_CC}/config.json | cut -d'"' -f4)"
  fi
  tmux kill-session -t nomo-pair 2>/dev/null || true
  local out
  out=$(NOMO_NO_OPEN=1 NOMO_WORKER_URL="$W" bun "$R/dist/pair.mjs" 2>&1) || { echo "NOMO_PAIR_FAILED: $(echo "$out" | tail -1)"; return 0; }
  bun "$R/dist/handoff.mjs" --box-pair || { echo "NOMO_PAIR_FAILED: could not read the pending pairing"; return 0; }
  tmux kill-session -t nomo-pair 2>/dev/null || true
  tmux new-session -d -s nomo-pair "bun $R/dist/pair.mjs wait > ${BOX_CC}/cloud-pair.log 2>&1"
}`;
export const PAIR_POLL = `${SHM_SWEEP}
grep -q '"e2eKeyB64"' ${BOX_CC}/config.json 2>/dev/null && echo PAIRED && exit 0
tmux has-session -t nomo-pair 2>/dev/null && echo WAITING && exit 0
grep -q '"e2eKeyB64"' ${BOX_CC}/config.json 2>/dev/null && echo PAIRED || { echo ENDED; tail -1 ${BOX_CC}/cloud-pair.log 2>/dev/null; }`;

/** Claude Code's ~/.claude/projects/<dir> name for a cwd: every non-alphanumeric char becomes "-".
 *  ponytail: CC truncates+hashes paths over ~200 chars; such a cwd simply reports "no transcripts". */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Transcript model id → OpenRouter id: claude-opus-5-5 → anthropic/claude-opus-5.5,
 *  claude-sonnet-4-5-20250929 → anthropic/claude-sonnet-4.5. Ids that already carry a "/" pass through. */
export function toOpenRouterModel(model: string): string {
  if (model.includes("/")) return model;
  const base = model.replace(/\[.*\]$/, "").replace(/-\d{8}$/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2");
  return `anthropic/${base}`;
}

/** The last real model the session used (synthetic/error rows carry "<synthetic>"), as a bare CC id.
 *  A box-touched transcript records the OpenRouter id ("anthropic/claude-haiku-5.5"), so normalize
 *  first; toOpenRouterModel maps it back for the box. */
export function lastModel(jsonl: string): string | undefined {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    try {
      const m = JSON.parse(lines[i])?.message?.model;
      if (typeof m !== "string") continue;
      const id = normalizeModelId(m);
      if (id.startsWith("claude")) return id;
    } catch { /* torn last line */ }
  }
  return undefined;
}

/** Newest transcript uuid among `{name, mtimeMs}` entries (only *.jsonl count). */
export function latestSession(entries: { name: string; mtimeMs: number }[]): string | undefined {
  const j = entries.filter((e) => e.name.endsWith(".jsonl")).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return j[0]?.name.slice(0, -".jsonl".length);
}

/** POSIX single-quote. */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The SEC1 raw (65 B) P-256 public key of a pkcs8 private key — the QR's `e=` value, recomputed from
 *  the pending config so the private half never leaves the box. */
export async function pubRawFromPkcs8(priv: Bytes): Promise<Bytes> {
  const key = await crypto.subtle.importKey("pkcs8", priv, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return new Uint8Array([4, ...fromB64url(jwk.x!), ...fromB64url(jwk.y!)]);
}

/** Box-side: stamp machineName into a PENDING config (completion carries it over) and rebuild the
 *  pairing's nomo://pair URL. Throws on a completed or malformed config. */
export async function boxPairPayload(
  raw: string, machineName: string,
  buildPairURL: (workerUrl: string, pairingId: string, qrSecret: Bytes, pcEphPub: Bytes) => string,
): Promise<{ config: string; url: string }> {
  const c = JSON.parse(raw);
  if (c.e2eKeyB64 || typeof c.qrSecretB64 !== "string" || typeof c.pcEphPrivB64 !== "string") {
    throw new Error("no pending pairing in config.json");
  }
  const url = buildPairURL(c.url, c.pairingId, fromB64url(c.qrSecretB64), await pubRawFromPkcs8(fromB64url(c.pcEphPrivB64)));
  return { config: JSON.stringify({ ...c, machineName }), url };
}

/** Split the pairing URL marker out of box stdout so it is never echoed with the pane. */
export function takePairUrl(stdout: string): { url?: string; rest: string } {
  let url: string | undefined;
  const rest = stdout.split("\n").filter((l) => {
    if (!l.startsWith(PAIR_URL_MARKER)) return true;
    url = l.slice(PAIR_URL_MARKER.length).trim();
    return false;
  }).join("\n");
  return { url, rest };
}

/** The plugin dir to ship: <root>/dist/handoff.mjs in a built/installed plugin, <repo>/plugin from src/. */
function pluginRoot(): string {
  const up2 = dirname(dirname(fileURLToPath(import.meta.url)));
  return existsSync(join(up2, ".claude-plugin", "plugin.json")) ? up2 : join(dirname(up2), "plugin");
}

// ---------------------------------------------------------------------------------------------------

function readKeys(): { omg?: string; openrouter?: string } {
  // ponytail: dev mode. P1c moves the omg key to the Nomo backend (per-user managed boxes); only the
  // OpenRouter key (or its successor) stays client-side.
  const file: Record<string, string> = {};
  try {
    for (const line of readFileSync(`${process.env.HOME}/.nomo-spike.env`, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=(.*)$/);
      if (m) file[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch { /* no file */ }
  return {
    omg: process.env.OMG_API_KEY || file.OMG_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY || file.OPENROUTER_API_KEY,
  };
}

/** Box-side tools + this plugin for root (as a directory marketplace), idempotent: shared by every
 *  handoff and by --bake. Uninstall + cache wipe first: a same-version reinstall otherwise silently keeps
 *  the old cached dist. Needs ${STAGE}-plugin.tgz uploaded. */
export function boxSetup(marketplace: string): string {
  return `export PATH="/root/.local/bin:/root/.bun/bin:$PATH"
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1
command -v tmux >/dev/null || { apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux >/dev/null; }
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || true
command -v bun >/dev/null || echo "WARN: no bun on the box, Nomo hooks stay silent"
claude --version

M=/root/.nomo/marketplace
rm -rf "$M" && mkdir -p "$M/plugin" "$M/.claude-plugin" && tar xzf ${STAGE}-plugin.tgz -C "$M/plugin"
printf '%s\n' ${q(marketplace)} > "$M/.claude-plugin/marketplace.json"
claude plugin marketplace add "$M" </dev/null >/dev/null 2>&1 || true
claude plugin uninstall nomo-cc@nomo </dev/null >/dev/null 2>&1 || true
rm -rf /root/.claude/plugins/cache/nomo
claude plugin install nomo-cc@nomo </dev/null >/dev/null`;
}

/** --bake's box script: tools + plugin, then scrub anything a template must never carry. */
export function bakeScript(marketplace: string): string {
  return `set -euo pipefail
${boxSetup(marketplace)}
rm -rf ${STAGE}-* ${BOX_CC} /root/.claude/projects /dev/shm/nomo-env
echo NOMO_BAKED`;
}

/** The worker the box pairs with: --worker, else the Mac's NOMO_WORKER_URL, else production. */
export function targetWorker(flag: string | true | undefined, env: string | undefined): string {
  const w = (typeof flag === "string" && flag ? flag : env || DEFAULT_WORKER_URL).replace(/\/$/, "");
  const bad = () => new Error(`worker URL must be an https origin (http only for localhost), got ${JSON.stringify(w)}`);
  if (!/^https?:\/\/[^/\s@]+$/.test(w)) throw bad(); // no path, no userinfo
  const u = new URL(w);
  if (u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw bad();
  return w;
}

/** Paths that never leave the Mac: credentials, the Nomo pairing keys, the Keychain. Excluded from every
 *  tar of the user's files; a non-git folder that holds any of them is refused outright. */
export const SENSITIVE = [".claude", ".config/cc-status", ".ssh", ".gnupg", ".aws", "Library/Keychains"]; // == cloud-back.ts
const EXCLUDE_SENSITIVE = SENSITIVE.flatMap((p) => ["--exclude", p]);

/** Why `dir` must not be packed whole, or undefined when it may. */
export function packRefusal(dir: string, home: string, has: (p: string) => boolean = existsSync): string | undefined {
  const rel = relative(dir, home);
  if (rel !== ".." && !rel.startsWith(".." + sep)) return `${dir} is your home folder or contains it`;
  const hit = SENSITIVE.find((p) => has(join(dir, p)));
  return hit ? `${dir} contains ${hit}` : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_RE = /^[A-Za-z0-9._:/\[\]-]+$/;
/** The session id and model reach the box's launch line: only plain ids get that far. */
export function checkLaunchIds(uuid: string, model: string): void {
  if (!UUID_RE.test(uuid)) throw new Error(`session id must be a UUID, got ${JSON.stringify(uuid)}`);
  if (!MODEL_RE.test(model)) throw new Error(`model id may only contain letters, digits and . _ : / [ ] -, got ${JSON.stringify(model)}`);
}

/** The user-layer files to ship, as paths under `claudeHome`. Symlinks are followed only while they stay
 *  inside their own top-level folder (e.g. ~/.claude/skills); one pointing anywhere else is skipped and
 *  reported, so a link can never pull in ~/.ssh or ~/.claude/.credentials.json. A top-level CLAUDE.md
 *  link is followed to its regular file. */
export function userLayerFiles(claudeHome: string, entries: string[]): { files: string[]; skipped: string[] } {
  const files: string[] = [], skipped: string[] = [];
  for (const top of entries) {
    const abs = join(claudeHome, top);
    if (!statSync(abs, { throwIfNoEntry: false })) { if (lstatSync(abs, { throwIfNoEntry: false })) skipped.push(top); continue; }
    if (statSync(abs).isFile()) { files.push(top); continue; }
    const root = realpathSync(abs);
    const walk = (rel: string, ancestors: Set<string>): void => {
      const p = join(claudeHome, rel);
      let real: string;
      try { real = realpathSync(p); } catch { skipped.push(rel); return; } // a dangling link
      if (real !== root && !real.startsWith(root + sep)) { skipped.push(rel); return; }
      const st = statSync(real);
      if (st.isFile()) { files.push(rel); return; }
      if (!st.isDirectory() || ancestors.has(real)) return; // a link loop
      const next = new Set(ancestors).add(real);
      for (const name of readdirSync(p)) if (name !== ".DS_Store") walk(join(rel, name), next);
    };
    walk(top, new Set());
  }
  return { files, skipped };
}

/** Pack this plugin's own files (never ~/.config/cc-status — that holds the Mac's pairing keys) into
 *  `out` and return the one-plugin marketplace.json that installs it. */
function packPlugin(out: string): string {
  const plugin = pluginRoot();
  const version = JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8")).version as string;
  tar(out, plugin, ["--exclude", ".DS_Store", "."]);
  return JSON.stringify({ name: "nomo", owner: { name: "Nomo" }, plugins: [{ name: "nomo-cc", source: "./plugin", version }] });
}

const sh = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { cwd, env: env ?? process.env, maxBuffer: 1 << 30 }).toString();

function tar(out: string, cwd: string, args: string[], input?: Buffer): void {
  execFileSync("tar", ["--no-xattrs", "-czf", out, ...args], {
    cwd, input, env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: [input ? "pipe" : "ignore", "ignore", "inherit"],
  });
}

interface Plan {
  uuid: string;
  cwd: string;
  root: string; // repo toplevel (or cwd for a non-git folder)
  git: boolean;
  branch?: string;
  model: string;
  artifacts: Record<string, string>; // box path -> local file
  script: string;
  snap: Snapshot; // saved to cloud.json only once the box start succeeds
  gitUser: Record<string, string>; // NOMO_GIT_NAME / NOMO_GIT_EMAIL: box commits are authored as the user
}

function build(args: Map<string, string | true>, outDir: string): Plan {
  const cwd = process.cwd();
  const projDir = join(process.env.HOME!, ".claude", "projects", projectDirName(cwd));
  if (!existsSync(projDir)) throw new Error(`no Claude Code transcripts for ${cwd} (looked in ${projDir})`);
  const uuid = typeof args.get("--session") === "string"
    ? (args.get("--session") as string)
    : latestSession(readdirSync(projDir).map((name) => ({ name, mtimeMs: statSync(join(projDir, name)).mtimeMs })));
  if (uuid && !UUID_RE.test(uuid)) throw new Error(`session id must be a UUID, got ${JSON.stringify(uuid)}`);
  if (!uuid || !existsSync(join(projDir, `${uuid}.jsonl`))) throw new Error(`session ${uuid ?? "(none)"} not found in ${projDir}`);

  const transcriptBytes = readFileSync(join(projDir, `${uuid}.jsonl`));
  const transcript = transcriptBytes.toString("utf8");
  const model = typeof args.get("--model") === "string"
    ? toOpenRouterModel(args.get("--model") as string)
    : toOpenRouterModel(lastModel(transcript) ?? "claude-opus-5-5");
  checkLaunchIds(uuid, model);

  const art: Record<string, string> = {};
  const put = (name: string) => { art[`${STAGE}-${name}`] = join(outDir, name); return join(outDir, name); };

  // Transcript + its subagent dir + project memory.
  tar(put("project.tgz"), projDir, [`${uuid}.jsonl`, ...[uuid, "memory"].filter((p) => existsSync(join(projDir, p)))]);

  // User layer: an explicit file list (see userLayerFiles), -h only resolves the links it vetted.
  const claudeHome = join(process.env.HOME!, ".claude");
  const layer = userLayerFiles(claudeHome, ["skills", "agents", "commands", "CLAUDE.md"]);
  if (layer.skipped.length) console.log(`Not shipping ${layer.skipped.length} user-layer link(s) that point outside their folder: ${layer.skipped.join(", ")}`);
  const hasLayer = layer.files.length > 0;
  if (hasLayer) tar(put("userlayer.tgz"), claudeHome, ["-h", "--null", "-T", "-"], Buffer.from(layer.files.join("\0")));

  // This plugin, to install for root on the box (hooks live from SessionStart).
  const marketplace = packPlugin(put("plugin.tgz"));

  let git = true, root = cwd, branch: string | undefined;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch { git = false; }
  const home = process.env.HOME!;
  const refusal = git ? (packRefusal(root, home, () => false)) : packRefusal(cwd, home);
  if (refusal) throw new Error(`refusing to hand off: ${refusal}. Run it from a project folder.`);
  const snap = takeSnapshot(cwd, root, git, projDir, transcriptBytes);
  const gitUser: Record<string, string> = {};
  if (git) {
    for (const [k, env] of [["user.name", "NOMO_GIT_NAME"], ["user.email", "NOMO_GIT_EMAIL"]]) {
      try { gitUser[env] = execFileSync("git", ["config", k], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* unset */ }
    }
    branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], root).trim();
    sh("git", ["bundle", "create", "-q", put("repo.bundle"), "HEAD"], root);
    // READ-ONLY on the user's tree: diff vs HEAD covers staged + unstaged; untracked ride in a tar.
    writeFileSync(put("wip.patch"), execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: 1 << 30 }));
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, maxBuffer: 1 << 30 });
    tar(put("untracked.tgz"), root, [...EXCLUDE_SENSITIVE, "--null", "-T", "-"], untracked);
  } else {
    tar(put("folder.tgz"), cwd, ["--exclude", "node_modules", "--exclude", ".git", ...EXCLUDE_SENSITIVE, "."]);
  }

  for (const [box, local] of Object.entries(art)) {
    const size = statSync(local).size;
    if (size > MAX_ARTIFACT_BYTES) {
      throw new Error(`${box.split("/").pop()} is ${(size / 1e6).toFixed(0)} MB (cap ${MAX_ARTIFACT_BYTES / 1e6} MB). ` +
        (git ? "Commit or .gitignore large untracked files." : "Run handoff from a git repo, or trim the folder."));
    }
  }

  const enc = projectDirName(cwd);
  const runEnv = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"];
  const launch = `. /dev/shm/nomo-env; rm -f /dev/shm/nomo-env; export PATH="/root/.local/bin:$PATH"; exec claude --resume ${uuid} --model ${q(model)}`;
  const keepalive = `while tmux has-session -t nomo 2>/dev/null; do curl -s -X POST http://169.254.0.1:9090/v1/sandbox/keepalive -H 'Content-Type: application/json' -d '{"seconds":${KEEPALIVE_S}}' >/dev/null; sleep 600; done`;

  const script = `set -euo pipefail
if command -v tmux >/dev/null && tmux has-session -t nomo 2>/dev/null; then
  if [ "\${NOMO_FORCE:-}" != 1 ]; then echo "NOMO_BUSY: a handed-off session is still running on this box"; exit 3; fi
  tmux kill-server # not just the session: a pre-2.3.2 server still carries the API key in its argv
fi
# Keys reach claude via RAM, never argv: the file is gone the moment the launcher has read it. Taken
# FIRST and the key unset, so no tmux server (pair wait, relay, keepalive) ever inherits it in its env;
# a run that dies before claude starts removes the file on the way out.
rm -f /dev/shm/nomo-env
( umask 077; export -p | grep -E '^declare -x (${runEnv.join("|")})=' > /dev/shm/nomo-env )
unset ANTHROPIC_AUTH_TOKEN
trap 'tmux has-session -t nomo 2>/dev/null || rm -f /dev/shm/nomo-env' EXIT
${boxSetup(marketplace)}

P=/root/.claude/projects/${enc}
mkdir -p "$P" && tar xzf ${STAGE}-project.tgz -C "$P"
${hasLayer ? `tar xzf ${STAGE}-userlayer.tgz -C /root/.claude` : "# no user layer"}

# The user's git identity arrives as exec env (never argv), so the box's commits are authored as them.
if [ -n "\${NOMO_GIT_NAME:-}" ]; then git config --global user.name "$NOMO_GIT_NAME"; fi
if [ -n "\${NOMO_GIT_EMAIL:-}" ]; then git config --global user.email "$NOMO_GIT_EMAIL"; fi

ROOT=${q(root)}
[ -e "$ROOT" ] && mv "$ROOT" "$ROOT.nomo-bak-$(date +%s)"
mkdir -p "$(dirname "$ROOT")"
${git
    ? `git -c advice.detachedHead=false clone -q ${STAGE}-repo.bundle "$ROOT"
cd "$ROOT"
${branch && branch !== "HEAD" ? `git checkout -q -B ${q(branch)}` : "# detached HEAD"}
[ -s ${STAGE}-wip.patch ] && git apply --binary ${STAGE}-wip.patch
tar xzf ${STAGE}-untracked.tgz -C "$ROOT"`
    : `mkdir -p "$ROOT" && tar xzf ${STAGE}-folder.tgz -C "$ROOT"`}

# First-run onboarding + trust live in the BOX's own /root/.claude.json (never the Mac's).
python3 - ${q(cwd)} <<'PY'
import json, os, sys
p = "/root/.claude.json"
d = json.load(open(p)) if os.path.exists(p) else {}
d["hasCompletedOnboarding"] = True
d.setdefault("theme", "dark")
d.setdefault("projects", {}).setdefault(sys.argv[1], {}).update(hasTrustDialogAccepted=True, hasCompletedProjectOnboarding=True)
json.dump(d, open(p, "w"))
PY

# Pair BEFORE claude starts, so its SessionStart is stashed and flushed to the phone on the scan.
${PAIR_FN}
nomo_pair

# The OpenRouter relay, fresh from this install (a re-handoff replaces the old one).
${BOX_PLUGIN}
tmux kill-session -t nomo-relay 2>/dev/null || true
tmux new-session -d -s nomo-relay "$(command -v bun || command -v node) $R/dist/or-relay.mjs"
for _ in $(seq 20); do (exec 3<>/dev/tcp/127.0.0.1/${RELAY_PORT}) 2>/dev/null && break; sleep 0.5; done
(exec 3<>/dev/tcp/127.0.0.1/${RELAY_PORT}) 2>/dev/null || { echo "NOMO_RELAY_FAILED"; tmux capture-pane -p -t nomo-relay 2>/dev/null; exit 4; }

# Which session tmux session nomo runs, so --back --session X never stops a different one (an id, no secret).
printf %s ${q(uuid)} > ${BOX_CURRENT}
tmux new-session -d -s nomo -x 200 -y 50 -c ${q(cwd)} ${q(`bash -c ${q(launch)}`)}
tmux has-session -t nomo-keepalive 2>/dev/null || tmux new-session -d -s nomo-keepalive ${q(keepalive)}
sleep 8
tmux has-session -t nomo
tmux capture-pane -p -t nomo
`;
  return { uuid, cwd, root, git, branch, model, artifacts: art, script, snap, gitUser };
}

// --------------------------------------------------------------------------------------------- omg

async function api(key: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
  return text ? JSON.parse(text) : null;
}

/** One box script. A 409 (the box is still waking) is retried 5× / 2s. */
async function exec(key: string, id: string, script: string, env: Record<string, string> = {}) {
  for (let i = 0; ; i++) {
    try {
      return (await api(key, "POST", `/sandboxes/${id}/exec`, { cmd: "bash", args: ["-lc", script], env, timeoutMs: 600_000 })) as
        { stdout?: string; stderr?: string; exitCode: number };
    } catch (e: any) {
      if (e.status !== 409 || i >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** `current` is the last handed-off session; `sessions` holds each one's handoff snapshot for --back;
 *  `pairedTo` is "<sandboxId> <worker>" once that box was seen paired to that worker (/nomo-cc:handoff's gate). */
interface Cloud { sandboxId?: string; macId?: string; current?: string; sessions?: Record<string, Snapshot>; pairedTo?: string }
const loadCloud = (): Cloud => { try { return JSON.parse(readFileSync(CLOUD_PATH, "utf8")); } catch { return {}; } };
function saveCloud(c: Cloud): void {
  mkdirSync(dirname(CLOUD_PATH), { recursive: true });
  writeFileSync(CLOUD_PATH, JSON.stringify(c) + "\n", { mode: 0o600 });
}
/** A random per-Mac id for omg's externalUserId (lists a user's boxes); no PII, minted once. */
function macId(): string {
  const c = loadCloud();
  if (!c.macId) saveCloud({ ...c, macId: randomUUID() });
  return loadCloud().macId!;
}

/** The create body: the baked template when the account has one, else the omg preset. The two are
 *  mutually exclusive (both → 400). */
export function createBody(hasBase: boolean, externalUserId: string): Record<string, string> {
  return { ...(hasBase ? { templateId: BASE_TEMPLATE } : { template: "omg" }), size: BOX_SIZE, externalUserId };
}

async function getBox(key: string, id: string | undefined): Promise<any | undefined> {
  if (!id) return undefined;
  try {
    const sb = await api(key, "GET", `/sandboxes/${id}`);
    return sb.status === "stopped" ? undefined : sb;
  } catch (e: any) {
    if (e.status === 404) return undefined;
    throw e;
  }
}

/** The user's one box, running: reuse (waking it if asleep) or create. */
async function ensureBox(key: string): Promise<string> {
  let sb = await getBox(key, loadCloud().sandboxId);
  if (!sb) {
    const hasBase = await api(key, "GET", `/templates/${BASE_TEMPLATE}/latest`).then(() => true, () => false);
    console.log(`Creating your cloud box (${hasBase ? `template ${BASE_TEMPLATE}` : "omg preset"})…`);
    sb = await api(key, "POST", "/sandboxes", createBody(hasBase, macId()));
    saveCloud({ ...loadCloud(), sandboxId: sb.id });
  }
  return wakeBox(key, sb);
}

/** An existing box, running (never creates one). */
async function wakeBox(key: string, sb: any): Promise<string> {
  if (sb.status === "hibernated") { console.log(`Waking box ${sb.id}…`); sb = await api(key, "POST", `/sandboxes/${sb.id}/wake`); }
  return waitRunning(key, sb);
}

/** Hibernate: files and memory kept, $0 while asleep. */
async function sleepBox(key: string, sb: { id: string; status: string }): Promise<void> {
  if (sb.status === "running") {
    await exec(key, sb.id, SHM_SWEEP).catch(() => {});
    await api(key, "POST", `/sandboxes/${sb.id}/hibernate`);
  }
  console.log(`Box ${sb.id} is asleep (hibernated; files and memory kept, deleted after 14 days asleep).`);
}

async function waitRunning(key: string, sb: any): Promise<string> {
  for (let i = 0; sb.status !== "running"; i++) {
    if (i > 90) throw new Error(`box ${sb.id} stuck in ${sb.status}`);
    await new Promise((r) => setTimeout(r, 2000));
    sb = await api(key, "GET", `/sandboxes/${sb.id}`);
  }
  return sb.id;
}

function attachHelp(): string {
  return [
    `  Watch:  bun plugin/dist/handoff.mjs --screen`,
    `  Type:   bun plugin/dist/handoff.mjs --send "your message"     (keys: --send-key Escape | BTab | C-c | Enter)`,
  ].join("\n");
}

/** Box script for --screen / --send / --send-key. User text arrives ONLY as exec env (NOMO_TEXT /
 *  NOMO_KEY), never interpolated into the script. */
export function paneScript(mode: "screen" | "send" | "key"): string {
  const guard = `${SHM_SWEEP}
tmux has-session -t nomo 2>/dev/null || { echo 'tmux nomo: not running'; exit 2; }`;
  if (mode === "send") return `${guard}\ntmux send-keys -t nomo -l -- "$NOMO_TEXT" && tmux send-keys -t nomo Enter`;
  if (mode === "key") return `${guard}\ntmux send-keys -t nomo -- "$NOMO_KEY"`;
  return `${guard}\ntmux capture-pane -p -t nomo | sed -e :a -e '/^\\n*$/{$d;N;ba' -e '}' | tail -40`;
}

/** --bake: a fresh preset box at BOX_SIZE gets tools + this plugin (nothing else), is snapshotted and
 *  published as the account's `nomo-base` template, then deleted. Run by the user, once per plugin bump. */
async function bake(key: string): Promise<void> {
  const out = mkdtempSync(join(tmpdir(), "nomo-bake-"));
  const marketplace = packPlugin(join(out, "plugin.tgz"));
  console.log(`Creating a bake box (omg preset, ${BOX_SIZE})…`);
  const id = await waitRunning(key, await api(key, "POST", "/sandboxes", { template: "omg", size: BOX_SIZE }));
  try {
    await api(key, "POST", `/sandboxes/${id}/files`, [{ path: `${STAGE}-plugin.tgz`, content: readFileSync(join(out, "plugin.tgz")).toString("base64"), mode: 0o600 }]);
    const r = await exec(key, id, bakeScript(marketplace));
    if (r.exitCode !== 0 || !/NOMO_BAKED/.test(r.stdout ?? "")) throw new Error(`bake script failed (exit ${r.exitCode}):\n${(r.stdout ?? "").slice(-1500)}\n${(r.stderr ?? "").slice(-1500)}`);
    console.log(`Installed: ${(r.stdout ?? "").split("\n").find((l) => /Claude Code/.test(l)) ?? "claude"}. Snapshotting…`);
    const snap = await api(key, "POST", `/sandboxes/${id}/snapshot`);
    for (let i = 0; !(await api(key, "GET", `/snapshots/${snap.id}`)).uploadedToTigris; i++) {
      if (i > 180) throw new Error(`snapshot ${snap.id} never finished uploading`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    await api(key, "POST", `/templates/${BASE_TEMPLATE}/latest`, { snapshotId: snap.id });
    console.log(`Published template "${BASE_TEMPLATE}" from snapshot ${snap.id}. New boxes start from it (size ${BOX_SIZE}).`);
  } finally {
    await api(key, "DELETE", `/sandboxes/${id}`).then(() => console.log(`Deleted bake box ${id}.`), (e) => console.log(`Bake box ${id} left behind: ${e.message}`));
    rmSync(out, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------ pairing

/** The box page can't poll the worker itself (the pcSecret stays on the box), so it reloads every 3s and
 *  this process swaps the file for a secret-free result page when the wait ends. */
export function withReload(html: string): string {
  return html.replace("<head>", `<head>\n<meta http-equiv="refresh" content="3">`);
}

export function resultPage(title: string, sub: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nomo Cloud</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
font:16px -apple-system,system-ui,sans-serif;background:#f6f6f8;color:#111}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}
main{text-align:center;padding:16px}h1{font-size:24px;margin:8px 0}p{opacity:.7}</style></head>
<body><main><h1>${title}</h1><p>${sub}</p></main></body></html>`;
}

/** Show the box's pairing QR on the Mac and wait (by polling the box) until the phone claims it. */
async function showPairing(omg: string, id: string, url: string, worker: string): Promise<void> {
  const page = join(CC_DIR, "cloud-pair.html");
  let result = resultPage("Not paired", "Retry with: bun plugin/dist/handoff.mjs --pair");
  if (process.stdout.isTTY) {
    console.log("\n" + renderQR(url) + "\n");
    console.log("Scan with Nomo on your iPhone to add this cloud box (Sessions → Pair a Computer). Expires in 10 minutes.");
  } else {
    // Captured stdout (an agent transcript) must never carry the QR: the page path, as /nomo-cc:pair does.
    mkdirSync(CC_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(page, withReload(renderPairPage({ svg: renderQRSVG(url, { ecLevel: "Q" }), code: null, expiresAt: Date.now() + PAIR_WAIT_MS })), { mode: 0o600 });
    try { spawn("open", [page], { detached: true, stdio: "ignore" }).unref(); } catch { /* path printed below */ }
    console.log(`Pairing page opened in your browser (${page}). Scan it with Nomo on your iPhone to add this cloud box. Expires in 10 minutes.`);
  }
  console.log(`Waiting for the scan… (Ctrl-C is safe: the box keeps waiting on its own)`);
  // Ctrl-C skips `finally`: overwrite the QR page on the way out too.
  const onSignal = (): void => {
    if (!process.stdout.isTTY) try { writeFileSync(page, result, { mode: 0o600 }); } catch { /* best effort */ }
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    for (const end = Date.now() + PAIR_WAIT_MS; Date.now() < end;) {
      await new Promise((r) => setTimeout(r, 5000));
      const out = ((await exec(omg, id, PAIR_POLL).catch(() => ({ stdout: "WAITING" }))).stdout ?? "").trim();
      if (out === "PAIRED") {
        result = resultPage("Paired ✓", `The box shows in Nomo as “${BOX_MACHINE_NAME}”. You can close this window.`);
        console.log(`Paired ✓ The box shows in Nomo as "${BOX_MACHINE_NAME}".`);
        saveCloud({ ...loadCloud(), pairedTo: `${id} ${worker}` });
        return;
      }
      if (out.startsWith("ENDED")) { console.log(`Pairing ended without a scan: ${out.slice(5).trim() || "(no detail)"}`); break; }
    }
  } finally {
    // The QR (a secret) is overwritten either way; the open tab reloads into the result.
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (!process.stdout.isTTY) writeFileSync(page, result, { mode: 0o600 });
  }
  console.log("Not paired. Retry with: bun plugin/dist/handoff.mjs --pair");
}

/** Act on the pairing lines of a box script's stdout. */
async function afterPair(omg: string, id: string, stdout: string, worker: string): Promise<void> {
  const { url, rest } = takePairUrl(stdout);
  const paired = /^NOMO_PAIRED$/m.test(rest);
  saveCloud({ ...loadCloud(), pairedTo: paired ? `${id} ${worker}` : undefined });
  const failed = rest.match(/^NOMO_PAIR_FAILED: (.*)$/m);
  const old = rest.match(/^NOMO_REPAIR: (.*)$/m);
  if (old) console.log(`\nThe box was paired to ${old[1] || "another worker"}; pairing it again to the target worker.`);
  if (failed) console.log(`\nNomo pairing on the box failed: ${failed[1]}\nRetry with: bun plugin/dist/handoff.mjs --pair`);
  if (url) await showPairing(omg, id, url, worker);
}

// ------------------------------------------------------------------------------------ bring back

const BACK = "/tmp/nomo-back";
/** The ONLY files --back ever pulls (BACK-<name>): never .claude.json, credentials, cc-status or /dev/shm. */
export const BACK_FILES = ["repo.bundle", "wip.patch", "untracked.tgz", "project.tgz", "folder.tgz"] as const;
const BACK_POLL_MS = 10_000;
/** The session uuid tmux `nomo` was launched with (written by the handoff box script). */
const BOX_CURRENT = "/root/.nomo-current";

/** Box shell: unless NOMO_FORCE=1, stop here (NOMO_OTHER=<recorded id>) when tmux `nomo` is not running
 *  `uuid` (a box handed off before 2.3.12 records none). */
export function currentGuard(uuid: string, file = BOX_CURRENT): string {
  return `if [ "$(head -c 64 ${q(file)} 2>/dev/null)" != ${q(uuid)} ] && [ "\${NOMO_FORCE:-}" != 1 ]; then echo "NOMO_OTHER=$(head -c 64 ${q(file)} 2>/dev/null | tr -cd '0-9a-f-')"; exit 0; fi`;
}

/** Box: is the session at a turn boundary? NOMO_OTHER when the box last ran another session; NOMO_GONE
 *  when claude already exited; else the Nomo record's lastEvent (when there is one), the transcript's
 *  age in seconds, and its last 64 KiB after NOMO_TAIL. */
export function backWaitScript(uuid: string, enc: string): string {
  return `${SHM_SWEEP}
${currentGuard(uuid)}
tmux has-session -t nomo 2>/dev/null || { echo NOMO_GONE; exit 0; }
F=${BOX_CC}/sessions/${uuid}.json
[ -f "$F" ] && echo "NOMO_EVENT=$(grep -o '"lastEvent": *"[^"]*"' "$F" | head -1 | cut -d'"' -f4)"
T=/root/.claude/projects/${enc}/${uuid}.jsonl
[ -f "$T" ] || { echo NOMO_NOTRANSCRIPT; exit 0; }
echo "NOMO_AGE=$(( $(date +%s) - $(stat -c %Y "$T") ))"
echo NOMO_TAIL
tail -c 65536 "$T"`;
}

/** Box: exit claude — /exit, then C-c ×2, then kill-session (prints NOMO_HARD_STOP) — then the box's own
 *  reset.mjs, which ends the now-dead session's phone row and stops the box watchdog. Refuses
 *  (NOMO_OTHER) when the box last ran another session, running or not; NOMO_FORCE=1 (--force) stops it
 *  anyway, and NOMO_ESC=1 interrupts a running turn first. The current-session file stays: the pack checks it too. */
export function backStopScript(uuid: string): string {
  return `${SHM_SWEEP}
${currentGuard(uuid)}
gone() { ! tmux has-session -t nomo 2>/dev/null; }
if ! gone; then
  if [ "\${NOMO_ESC:-}" = 1 ]; then tmux send-keys -t nomo Escape; sleep 2; fi
  tmux send-keys -t nomo -l /exit; sleep 0.5; tmux send-keys -t nomo Enter
  for _ in $(seq 30); do gone && break; sleep 1; done
  if ! gone; then
    tmux send-keys -t nomo C-c; sleep 1; tmux send-keys -t nomo C-c
    for _ in $(seq 10); do gone && break; sleep 1; done
  fi
  if ! gone; then tmux kill-session -t nomo; echo NOMO_HARD_STOP; fi
fi
${BOX_PLUGIN}
if [ -n "$R" ]; then bun "$R/dist/reset.mjs" >/dev/null 2>&1 || true; fi
echo NOMO_STOPPED`;
}

/** Box: unless the box last ran `uuid` (currentGuard: another session's repo may sit at the same root),
 *  pack the session's work as ${BACK}-* (BACK_FILES) and report NOMO_HEAD / NOMO_BRANCH /
 *  NOMO_COMMITS / NOMO_FF (the handoff HEAD, NOMO_BASE in exec env, is an ancestor of the box HEAD) and
 *  NOMO_SIZE <name> <bytes>. Without a base the bundle carries all of HEAD and FF is 0. */
export function backPackScript(uuid: string, enc: string, root: string, isGit: boolean): string {
  const ex = EXCLUDE_SENSITIVE.map((a) => (a === "--exclude" ? a : q(a))).join(" ");
  return `${SHM_SWEEP}
${currentGuard(uuid)}
set -euo pipefail
rm -f ${BACK}-*
P=/root/.claude/projects/${enc}
[ -f "$P/${uuid}.jsonl" ] || { echo NOMO_NOTRANSCRIPT; exit 5; }
( cd "$P"; set -- ${uuid}.jsonl; if [ -d ${uuid} ]; then set -- "$@" ${uuid}; fi; if [ -d memory ]; then set -- "$@" memory; fi
  tar czf ${BACK}-project.tgz "$@" )
cd ${q(root)}
${isGit
    ? `H=$(git rev-parse HEAD)
echo "NOMO_HEAD=$H"
echo "NOMO_BRANCH=$(git rev-parse --abbrev-ref HEAD)"
B="\${NOMO_BASE:-}"
if [ -n "$B" ] && git cat-file -e "$B^{commit}" 2>/dev/null; then
  N=$(git rev-list --count "$B..HEAD")
  if git merge-base --is-ancestor "$B" HEAD; then FF=1; else FF=0; fi
  if [ "$N" -gt 0 ]; then git bundle create -q ${BACK}-repo.bundle "$B..HEAD"; fi
else
  N=$(git rev-list --count HEAD); FF=0
  git bundle create -q ${BACK}-repo.bundle HEAD
fi
echo "NOMO_COMMITS=$N"
echo "NOMO_FF=$FF"
git diff --binary HEAD > ${BACK}-wip.patch
git ls-files --others --exclude-standard -z > ${BACK}-ut.list
tar czf ${BACK}-untracked.tgz ${ex} --null -T ${BACK}-ut.list
rm -f ${BACK}-ut.list`
    : `tar czf ${BACK}-folder.tgz --exclude node_modules --exclude .git ${ex} .`}
for f in ${BACK}-*; do echo "NOMO_SIZE \${f#${BACK}-} $(stat -c %s "$f")"; done`;
}

/** The Terminal launcher --back opens: one `exec` line, nothing from the box in it. */
export function resumeCommand(cwd: string, id: string): string {
  return `cd ${q(cwd)} && exec claude --resume ${id}`;
}

async function back(omg: string, args: Map<string, string | true>): Promise<void> {
  const cloud = loadCloud();
  const flag = args.get("--session");
  const uuid = typeof flag === "string" ? flag : cloud.current;
  if (!uuid) throw new Error("no handed-off session on record; pass --session <uuid>");
  if (!UUID_RE.test(uuid)) throw new Error(`session id must be a UUID, got ${JSON.stringify(uuid)}`);
  // /nomo-cc:back runs inside some Claude Code session: never the one being brought back.
  const here = args.get("--from-session") || process.env.CLAUDE_CODE_SESSION_ID;
  if (here === uuid) throw new Error(`this Claude Code session is ${uuid} itself. Run /nomo-cc:back from another session; it resumes in a new Terminal window.`);
  const force = args.has("--force");
  const waitArg = args.get("--wait");
  const waitMin = typeof waitArg === "string" ? Number(waitArg) : 15;
  if (!(waitMin >= 0)) throw new Error("--wait takes minutes, e.g. --wait 30");
  const snap = cloud.sessions?.[uuid];
  const uuid8 = uuid.slice(0, 8);

  // Without a snapshot (handed off by a pre-2.3.11 plugin) this folder is the session's.
  let cwd = snap?.cwd ?? process.cwd(), root = snap?.root ?? cwd, isGit = snap?.git ?? true;
  if (!snap) {
    console.log(`No handoff snapshot for ${uuid}: assuming it belongs to ${cwd}; the box's work lands on a branch.`);
    try { root = sh("git", ["rev-parse", "--show-toplevel"], cwd).trim(); } catch { isGit = false; root = cwd; }
  }
  const rec = await readRecord(uuid);
  if (rec && typeof rec.pid === "number" && pidAlive(rec.pid)) {
    throw new Error(`session ${uuid} is running on this Mac (pid ${rec.pid}). Quit it there first, then rerun --back.`);
  }
  const enc = projectDirName(cwd);
  const sb = await getBox(omg, cloud.sandboxId);
  if (!sb) throw new Error("no cloud box on record (nothing to bring back)");
  const id = await wakeBox(omg, sb);

  // 1. A turn boundary (or --force, which interrupts instead of waiting).
  let gone = false;
  const other = (out: string) => {
    const o = out.match(/^NOMO_OTHER=([0-9a-f-]*)/m);
    if (o) {
      throw new Error(`the box's Claude Code is running session ${o[1] || "(not recorded: handed off before 2.3.12)"}, not ${uuid}; nothing was stopped.\n` +
        `Bring that one back with --back --session <its id>, or rerun with --force to stop it anyway.`);
    }
  };
  if (!force) {
    let told = "", state = "";
    for (const end = Date.now() + waitMin * 60_000; ;) {
      const out = (await exec(omg, id, backWaitScript(uuid, enc))).stdout ?? "";
      if (/^NOMO_GONE$/m.test(out)) { gone = true; break; }
      other(out);
      if (/^NOMO_NOTRANSCRIPT$/m.test(out)) throw new Error(`session ${uuid} has no transcript on box ${id}`);
      const at = out.search(/^NOMO_TAIL$/m);
      const head = at < 0 ? out : out.slice(0, at), tail = at < 0 ? "" : out.slice(at + "NOMO_TAIL\n".length);
      const { m } = parseMarkers(head);
      state = boxIdle({ lastEvent: m.EVENT || undefined, tail, quietS: Number(m.AGE ?? 0) });
      if (state === "idle") break;
      if (Date.now() > end) {
        throw new Error(state === "attention"
          ? `the box session was still waiting on your answer after ${waitMin} min. Answer it on your phone or with --send-key, then rerun --back (or --back --force to interrupt it).`
          : `the box session is still mid-turn after ${waitMin} min. Watch it with --screen; rerun --back later, or --back --force to interrupt it.`);
      }
      const msg = state === "attention"
        ? "The box session is waiting on you: answer it on your phone, or with --send-key (e.g. Enter, Escape). Still waiting…"
        : "The box session is mid-turn; waiting for it to finish (checks every 10s)…";
      if (msg !== told) console.log((told = msg));
      await new Promise((r) => setTimeout(r, BACK_POLL_MS));
    }
  }

  // 2. Stop claude there (and clear its phone row).
  if (!gone) console.log("Exiting Claude Code on the box…");
  const stop = await exec(omg, id, backStopScript(uuid), force ? { NOMO_ESC: "1", NOMO_FORCE: "1" } : {});
  other(stop.stdout ?? "");
  if (/^NOMO_HARD_STOP$/m.test(stop.stdout ?? "")) console.log("Claude Code did not exit on its own: hard stop (its last turn may be cut short).");

  // 3. Pack on the box, pull the fixed file list BEFORE touching anything here, then let the box sleep.
  const pack = await exec(omg, id, backPackScript(uuid, enc, root, isGit), { ...(snap?.head ? { NOMO_BASE: snap.head } : {}), ...(force ? { NOMO_FORCE: "1" } : {}) });
  other(pack.stdout ?? "");
  if (pack.exitCode !== 0) throw new Error(`packing on box ${id} failed (exit ${pack.exitCode}):\n${printable((pack.stdout ?? "").slice(-1500))}\n${printable((pack.stderr ?? "").slice(-1500))}`);
  const { m, sizes } = parseMarkers(pack.stdout ?? "");
  for (const [name, size] of Object.entries(sizes)) {
    if (size > MAX_ARTIFACT_BYTES) throw new Error(`${name} on the box is ${(size / 1e6).toFixed(0)} MB (cap ${MAX_ARTIFACT_BYTES / 1e6} MB). The box is still awake: trim it via --screen/--send, rerun --back, or --stop.`);
  }
  const backup = join(CC_DIR, "cloud-back", `${uuid8}-${Date.now()}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  // An interrupt from here on says where everything is (sync git steps finish or fail on their own).
  let phase = "pulling the box's work";
  const onSignal = (sig: string) => {
    console.error(`\nInterrupted (${sig}) while ${phase}.\n  Everything pulled from the box is in ${backup}.` +
      (isGit ? `\n  Nothing was reset or cleaned. Check: git -C ${q(root)} status && git -C ${q(root)} stash list` +
        `\n  Your uncommitted Mac changes, if they were stashed, are under "nomo: before cloud return ${uuid8}".` : "") +
      `\n  Rerun --back to finish: the box still holds the work, and what already landed here is detected.`);
    process.exit(130);
  };
  process.on("SIGINT", onSignal).on("SIGTERM", onSignal);
  for (const name of BACK_FILES) {
    if (!(name in sizes)) continue;
    const r = await api(omg, "GET", `/sandboxes/${id}/files?path=${encodeURIComponent(`${BACK}-${name}`)}`);
    const bytes = Buffer.from(r?.content ?? "", "base64");
    if (bytes.length !== sizes[name]) throw new Error(`pulled ${name}: ${bytes.length} B, the box reported ${sizes[name]} B`);
    writeFileSync(join(backup, name), bytes, { mode: 0o600 });
  }
  console.log(`Pulled the box's work into ${backup}`);
  await exec(omg, id, `rm -f ${BACK}-*`).catch(() => {});
  await sleepBox(omg, { id, status: "running" });

  // 4. Apply: transcript, memory, code. Every tar is untrusted (core/cloud-back.ts).
  phase = "landing the box's work on this Mac";
  const problems: string[] = [];
  const budget = { left: MAX_EXTRACTED_BYTES };
  const paths = (ps: string[]) => ps.map((p) => printable(p, true)).join(", ");
  /** One artifact that will not unpack (a bad entry, a cap) is reported and skipped; the rest still land. */
  const unpack = (name: string): string | undefined => {
    try { return extractTgz(join(backup, name), backup); } catch (e: any) {
      problems.push(`${name} could not be unpacked, so it was NOT applied (${printable((e.stderr?.toString() || e.message || String(e)).trim(), true).slice(0, 300)}); it is kept in ${backup}`);
    }
  };
  const projDir = mkdirp(join(process.env.HOME!, ".claude", "projects", enc));
  const pdir = unpack("project.tgz");
  const pt = pdir
    ? validateTree(pdir, (r) => r === `${uuid}.jsonl` || r === uuid || r.startsWith(`${uuid}/`) || r === "memory" || r.startsWith("memory/"), budget)
    : { files: [], skipped: [] };
  if (pt.skipped.length) console.log(`Skipped ${pt.skipped.length} unexpected path(s) in the box's project files: ${paths(pt.skipped)}`);
  let resumeId = uuid;
  if (!pdir) { /* reported by unpack */ } else if (!pt.files.includes(`${uuid}.jsonl`)) problems.push("the box sent no transcript");
  else {
    const boxT = readFileSync(join(pdir, `${uuid}.jsonl`));
    const macPath = join(projDir, `${uuid}.jsonl`);
    const macT = existsSync(macPath) ? readFileSync(macPath) : undefined;
    const sub = pt.files.filter((r) => r.startsWith(`${uuid}/`));
    const act = transcriptAction(snap, macT, boxT);
    if (act === "corrupt") problems.push(`the box transcript does not continue the one handed off; NOT installed (it is in ${backup}/project.tgz)`);
    if (act === "replace") {
      const before = mkdirp(join(backup, "mac-before"));
      if (macT) copyContained(macPath, before, `${uuid}.jsonl`, true, true);
      for (const r of listUnder(projDir, uuid)) copyContained(join(projDir, r), before, r, true, true);
      atomicWriteBytes(macPath, boxT);
      for (const r of sub) copyContained(join(pdir, r), projDir, r, true, true);
      console.log(`Transcript: installed the box's copy (+${boxT.length - (macT?.length ?? 0)} B); the Mac's previous copy is in ${before}`);
    }
    if (act === "fork") {
      resumeId = randomUUID();
      atomicWriteBytes(join(projDir, `${resumeId}.jsonl`), boxT);
      for (const r of sub) copyContained(join(pdir, r), projDir, resumeId + r.slice(uuid.length), false, true);
      console.log(`Transcript: this Mac also continued ${uuid} after the handoff, so the box's copy was saved as a new file ${resumeId}.jsonl; ` +
        `the Mac's copy is untouched. The new file still carries the original session id inside: check that \`claude --resume ${resumeId}\` opens the box's conversation.`);
    }
    if (act === "same") console.log("Transcript: the box added nothing.");
  }
  const mem = pdir ? mergeMemory(snap?.memory, join(pdir, "memory"), pt.files.filter((r) => r.startsWith("memory/")).map((r) => r.slice(7)), join(projDir, "memory"), backup) : { added: [], updated: [], conflicts: [] };
  if (mem.added.length + mem.updated.length) console.log(`Memory: ${mem.added.length} added, ${mem.updated.length} updated.`);
  if (mem.conflicts.length) console.log(`Memory: kept this Mac's ${paths(mem.conflicts)} (both sides changed); the box's versions are in ${backup}/memory-conflicts`);

  if (isGit) {
    const boxHead = m.HEAD ?? "";
    if (!/^[0-9a-f]{40}$/.test(boxHead)) throw new Error(`the box reported no HEAD (${JSON.stringify(boxHead)})`);
    const commits = Number(m.COMMITS ?? 0);
    const has = (n: string) => existsSync(join(backup, n));
    let untrackedDir: string | undefined, untracked: string[] = [];
    if (has("untracked.tgz") && (untrackedDir = unpack("untracked.tgz"))) {
      const ut = validateTree(untrackedDir, undefined, budget);
      untracked = ut.files;
      if (ut.skipped.length) console.log(`Skipped ${ut.skipped.length} untracked path(s) from the box (links or unsafe paths): ${paths(ut.skipped)}`);
    }
    const a: BoxArtifacts = {
      bundle: commits > 0 && has("repo.bundle") ? join(backup, "repo.bundle") : undefined,
      patch: has("wip.patch") ? join(backup, "wip.patch") : undefined,
      untrackedDir, untracked, boxHead,
    };
    const mac = macGitState(root);
    if (snap?.head && commits === 0 && boxHead !== snap.head) {
      problems.push(`the box's HEAD (${boxHead.slice(0, 12)}) is not the handed-off ${snap.head.slice(0, 12)} and has no new commits: the box dropped or rewound commits. Nothing of that was applied here; look with git -C ${q(root)} log ${boxHead.slice(0, 12)}`);
    }
    const action = decideCode(snap, mac, { commits, patchBytes: sizes["wip.patch"] ?? 0, untracked: untracked.length, ff: m.FF === "1" });
    // Agent/editor/git config from the box must never be live in this checkout unreviewed.
    let flagged: string[] = [];
    if (action !== "noop") {
      try { flagged = agentConfigPaths(boxChangedPaths(root, a, mac.head!, backup)); } catch (e: any) {
        throw new Error(`${printable((e.stderr?.toString() || e.message || String(e)).trim())}\nNothing in ${root} was changed; everything the box sent is in ${backup}.\n` +
          `The conversation itself is back: cd ${q(cwd)} && claude --resume ${resumeId}`);
      }
    }
    if (flagged.length) {
      problems.push(`the box changed agent/editor config or credential files: ${paths(flagged)}. Review these before checking out the branch.`);
    }
    if (action === "noop") console.log("Code: the box changed nothing.");
    if (action === "apply" && !flagged.length) {
      let r: ReturnType<typeof applyInPlace>;
      try { r = applyInPlace(root, a, mac.branch === "HEAD", uuid8, backup); } catch (e: any) {
        throw new Error(`${e.message}\nThe conversation itself is back: cd ${q(cwd)} && claude --resume ${resumeId}`);
      }
      console.log(`Code: landed in ${root} (${commits} commit(s)${a.patch && sizes["wip.patch"] ? " + uncommitted edits" : ""}${untracked.length ? ` + ${untracked.length} new file(s)` : ""}).`);
      if (r.stash) console.log(`  Your Mac edits from before the handoff are kept in stash ${r.stash} ("nomo: before cloud return ${uuid8}").`);
      if (r.skipped.length) console.log(`  Not overwritten (already on the Mac): ${paths(r.skipped)}`);
    }
    if (action === "branch" || (action === "apply" && flagged.length)) {
      const why = action === "apply" ? "the box changed agent/editor config" : !snap ? "no handoff snapshot" : m.FF !== "1" ? "the box rewrote history" : "this Mac changed since the handoff";
      const name = landOnBranch(root, a, uuid8, backup);
      console.log(`Code: ${why}, so the box's work is on branch ${name}; your checkout was not touched.\n  Review: git -C ${q(root)} log -p HEAD..${name}`);
    }
  } else if (existsSync(join(backup, "folder.tgz"))) {
    const dir = unpack("folder.tgz");
    if (dir) {
      const t = validateTree(dir, undefined, budget);
      console.log(`Code: the box's copy of the folder is at ${landFolder(cwd, dir, t.files, uuid8)} (yours was not touched).`);
      if (t.skipped.length) console.log(`  Skipped ${t.skipped.length} path(s) (links or unsafe paths): ${paths(t.skipped)}`);
    }
  }
  process.off("SIGINT", onSignal).off("SIGTERM", onSignal);

  const c = loadCloud();
  const { [uuid]: _done, ...sessions } = c.sessions ?? {};
  saveCloud({ ...c, sessions, current: c.current === uuid ? undefined : c.current });

  // 5. Resume here.
  const line = resumeCommand(cwd, resumeId);
  console.log(`\nResume on this Mac:\n  cd ${q(cwd)} && claude --resume ${resumeId}`);
  if (!args.has("--no-open") && !problems.length) {
    const file = join(backup, "resume.command");
    writeFileSync(file, `#!/bin/sh\n${line}\n`, { mode: 0o700 });
    try { execFileSync("open", ["-a", "Terminal", file], { stdio: "ignore" }); console.log("Opened it in Terminal."); } catch { /* the line above */ }
  }
  if (problems.length) {
    console.log(`\nNeeds a look:\n  ${problems.join("\n  ")}`);
    process.exitCode = 1;
  }
}

/** Mac files under <projDir>/<dir>/ as paths relative to projDir. */
function listUnder(projDir: string, dir: string): string[] {
  return listFiles(join(projDir, dir)).map((r) => join(dir, r));
}

// ------------------------------------------------------------------- /nomo-cc:handoff (core/handoff-later.ts)

const SELF = fileURLToPath(import.meta.url);
const PENDING = { path: PENDING_PATH, isHelper: (pid: number) => pidAlive(pid) && /handoff/.test(pidCommand(pid) ?? "") };

/** Foreground preflight (local only), then the detached helper that hands off once this session exits. */
async function later(args: Map<string, string | true>, keys: { omg?: string; openrouter?: string }, worker: string): Promise<void> {
  const records: { id: string; pid: number }[] = [];
  try {
    for (const f of readdirSync(SESSIONS_DIR).filter((n) => n.endsWith(".json"))) {
      try { records.push({ id: f.slice(0, -5), pid: JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf8")).pid }); } catch { /* skip */ }
    }
  } catch { /* no records */ }
  const flag = args.get("--session");
  const { session, claudePid } = resolveSession({
    substituted: typeof flag === "string" ? flag : undefined, env: process.env, ancestors: pidAncestors(process.pid), records,
  });
  if (!session || !claudePid) throw new Error("could not tell which Claude Code session this is. Run /nomo-cc:handoff inside the session you want to move.");
  if (!keys.omg || !keys.openrouter) throw new Error("OMG_API_KEY and OPENROUTER_API_KEY must be set (env or ~/.nomo-spike.env)");
  const home = process.env.HOME!;
  const cwd = [process.cwd(), (await readRecord(session))?.cwd]
    .find((c): c is string => !!c && existsSync(join(home, ".claude", "projects", projectDirName(c), `${session}.jsonl`)));
  if (!cwd) throw new Error(`no transcript for session ${session} under ${process.cwd()}. cd to the session's project folder and retry.`);
  let root: string | undefined;
  try { root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* not git */ }
  const refusal = root ? packRefusal(root, home, () => false) : packRefusal(cwd, home);
  if (refusal) throw new Error(`refusing to hand off: ${refusal}. Run it from a project folder.`);
  if (needsPairing(loadCloud(), worker)) {
    console.log(`Your cloud box needs a one-time pairing (a QR scan), which can't happen in the background. Nothing was started.\n` +
      `Quit Claude Code (/exit), then run this in a terminal:\n  cd ${q(cwd)} && ${q(process.execPath)} ${q(SELF)} --session ${session}` +
      `${worker === DEFAULT_WORKER_URL ? "" : ` --worker ${worker}`}\nAfter that, /nomo-cc:handoff works from inside Claude Code.`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(CC_DIR, { recursive: true, mode: 0o700 });
  const p: Pending = { helperPid: process.pid, session, claudePid, state: "waiting", startedAt: Date.now() };
  if (!claimPending(PENDING, p)) {
    const cur = readPending(PENDING_PATH);
    console.log(`A handoff is already waiting (session ${cur?.session ?? "?"}). See /nomo-cc:handoff status, or /nomo-cc:handoff cancel.`);
    return;
  }
  const fd = openSync(LATER_LOG, "w", 0o600);
  const child = spawn(process.execPath, [SELF, "--after-exit", "--session", session, "--claude-pid", String(claudePid), "--worker", worker],
    { cwd, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  writeFileSync(PENDING_PATH, JSON.stringify({ ...p, helperPid: child.pid }) + "\n", { mode: 0o600 });
  console.log(`Ready. Quit Claude Code now (/exit). Session ${session} moves to the cloud as soon as it closes; watch it on your phone.\n` +
    `Log: ${LATER_LOG}\nTo cancel before quitting: /nomo-cc:handoff cancel`);
}

/** The detached helper spawned by later(). */
async function afterExit(args: Map<string, string | true>, worker: string): Promise<void> {
  const session = String(args.get("--session")), claudePid = Number(args.get("--claude-pid"));
  if (!UUID_RE.test(session) || !(claudePid > 1)) throw new Error("--after-exit needs --session <uuid> --claude-pid <pid>");
  process.exitCode = await waitThenHandoff({ helperPid: process.pid, session, claudePid, state: "waiting", startedAt: Date.now() }, {
    pending: PENDING_PATH,
    alive: pidAlive,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    runHandoff: () => new Promise((res) => {
      spawn(process.execPath, [SELF, "--session", session, "--worker", worker], { stdio: "inherit" })
        .on("exit", (c) => res(c ?? 1)).on("error", () => res(1));
    }),
    log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
    notify: (text) => {
      try { spawn("osascript", ["-e", `display notification ${JSON.stringify(text)} with title "Nomo"`], { stdio: "ignore", detached: true }).unref(); } catch { /* log has it */ }
    },
  });
}

// -------------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "handoff");
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (["--session", "--model", "--send", "--send-key", "--worker", "--claude-pid", "--from-session"].includes(a)) args.set(a, argv[++i] ?? "");
    else if (a === "--wait" && /^\d+(\.\d+)?$/.test(argv[i + 1] ?? "")) args.set(a, argv[++i]);
    else args.set(a, true);
  }

  if (args.has("--box-pair")) {
    // Runs ON THE BOX (from nomo_pair), never on the Mac: prints only the URL marker.
    const cfg = `${CC_DIR}/config.json`;
    const { config, url } = await boxPairPayload(readFileSync(cfg, "utf8"), BOX_MACHINE_NAME, buildPairURL);
    await atomicWrite(cfg, config, 0o600);
    console.log(PAIR_URL_MARKER + url);
    return;
  }

  if (args.has("--send") && !String(args.get("--send")).trim()) throw new Error('usage: --send "<text>" (use --send-key Enter for a bare Enter)');
  const keys = readKeys();
  const worker = targetWorker(args.get("--worker"), process.env.NOMO_WORKER_URL);

  if (args.has("--later-cancel")) { console.log(cancelPending({ ...PENDING, kill: (p) => process.kill(p, "SIGTERM"), log: LATER_LOG })); return; }
  if (args.has("--later-status")) { console.log(laterStatus({ ...PENDING, log: LATER_LOG })); return; }
  if (args.has("--later")) { await later(args, keys, worker); return; }
  if (args.has("--after-exit")) { await afterExit(args, worker); return; }

  if (args.has("--dry-run")) {
    const out = mkdtempSync(join(tmpdir(), "nomo-handoff-"));
    let plan: Plan;
    try { plan = build(args, out); } catch (e) { rmSync(out, { recursive: true, force: true }); throw e; }
    console.log(`DRY RUN: nothing was sent. Artifacts kept in ${out} (delete it when done)`);
    console.log(`session ${plan.uuid}  cwd ${plan.cwd}  repo ${plan.git ? `${plan.root} (${plan.branch})` : "(not git)"}  model ${plan.model}`);
    for (const [box, local] of Object.entries(plan.artifacts)) console.log(`  ${local} -> ${box}  (${statSync(local).size} B)`);
    console.log(`keys: OMG_API_KEY ${keys.omg ? "found" : "MISSING"}, OPENROUTER_API_KEY ${keys.openrouter ? "found" : "MISSING"}`);
    console.log(`exec env: ANTHROPIC_BASE_URL=http://127.0.0.1:${RELAY_PORT} (or-relay -> OpenRouter) ANTHROPIC_AUTH_TOKEN=<openrouter key> ANTHROPIC_API_KEY= CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 NOMO_WORKER_URL=${worker}${args.has("--force") ? " NOMO_FORCE=1" : ""}`);
    console.log("----- box script -----\n" + plan.script);
    return;
  }

  if (!keys.omg) throw new Error("OMG_API_KEY not set (env or ~/.nomo-spike.env)");
  const omg = keys.omg;

  if (args.has("--bake")) { await bake(omg); return; }
  if (args.has("--back")) { await back(omg, args); return; }

  if (["--status", "--stop", "--pair", "--screen", "--send", "--send-key"].some((f) => args.has(f))) {
    const sb = await getBox(omg, loadCloud().sandboxId);
    if (!sb) { console.log("No cloud box. Run `handoff` to create one."); return; }
    if (args.has("--stop")) { await sleepBox(omg, sb); return; }
    if (sb.status !== "running") { console.log(`Box ${sb.id} is ${sb.status}. Run handoff to wake it.`); return; }
    if (args.has("--screen") || args.has("--send") || args.has("--send-key")) {
      const key = String(args.get("--send-key") ?? "");
      if (args.has("--send-key") && !/^[A-Za-z0-9-]+$/.test(key)) throw new Error("--send-key takes one tmux key name, e.g. Escape, BTab, C-c, Enter");
      const mode = args.has("--send") ? "send" : args.has("--send-key") ? "key" : "screen";
      const r = await exec(omg, sb.id, paneScript(mode), { NOMO_TEXT: String(args.get("--send") ?? ""), NOMO_KEY: key });
      process.stdout.write(r.stdout ?? "");
      if (mode !== "screen" && r.exitCode === 0) console.log("Sent. Check with --screen.");
      if (r.exitCode !== 0) process.exitCode = 1;
      return;
    }
    if (args.has("--pair")) {
      const r = await exec(omg, sb.id, `${SHM_SWEEP}\n${PAIR_FN}\nnomo_pair`, { NOMO_WORKER_URL: worker });
      if (/^NOMO_PAIRED$/m.test(r.stdout ?? "")) console.log(`Box ${sb.id} is already paired ✓`);
      await afterPair(omg, sb.id, r.stdout ?? "", worker);
      return;
    }
    console.log(`Target worker: ${worker}`);
    console.log(`Box ${sb.id}: ${sb.status}${sb.keepAwakeUntil ? `, keep-awake until ${sb.keepAwakeUntil}` : ""}`);
    const r = await exec(omg, sb.id, `${SHM_SWEEP}
tmux has-session -t nomo 2>/dev/null && { echo 'tmux nomo: alive'; tmux capture-pane -p -t nomo | sed -e :a -e '/^\\n*$/{$d;N;ba' -e '}' | tail -20; } || echo 'tmux nomo: not running'
echo; echo '--- Nomo on the box ---'
${BOX_PLUGIN}
[ -n "$R" ] && bun "$R/dist/status-cmd.mjs" claude || echo 'Nomo plugin: not installed on the box'`);
    process.stdout.write(r.stdout ?? "");
    console.log(attachHelp());
    return;
  }

  if (!keys.openrouter) throw new Error("OPENROUTER_API_KEY not set (env or ~/.nomo-spike.env)");
  // The work dir holds the transcript, repo bundle, patch and untracked files: gone once uploaded.
  const out = mkdtempSync(join(tmpdir(), "nomo-handoff-"));
  let plan: Plan, id: string;
  try {
    plan = build(args, out);
    console.log(`Handing off session ${plan.uuid} (${plan.model}) from ${plan.cwd} · Nomo worker ${worker}`);
    id = await ensureBox(omg);
    for (const [box, local] of Object.entries(plan.artifacts)) {
      await api(omg, "POST", `/sandboxes/${id}/files`, [{ path: box, content: readFileSync(local).toString("base64"), mode: 0o600 }]);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  const r = await exec(omg, id, plan.script, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${RELAY_PORT}`, // or-relay, which forwards to OpenRouter
    ANTHROPIC_AUTH_TOKEN: keys.openrouter,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    NOMO_WORKER_URL: worker,
    ...plan.gitUser,
    ...(args.has("--force") ? { NOMO_FORCE: "1" } : {}),
  });
  const pane = takePairUrl(r.stdout ?? "").rest.replace(/^NOMO_(PAIRED|PAIR_FAILED: .*|REPAIR: .*)$\n?/gm, ""); // never echo the QR URL
  if (r.exitCode === 4) throw new Error(`the OpenRouter relay did not start on box ${id}:\n${pane.slice(-1000)}`);
  if (r.exitCode === 3) throw new Error(`box ${id} is still running an earlier handoff. Check it with --status; rerun with --force to replace it.`);
  if (r.exitCode !== 0 || /No conversation found|API Error|Invalid API key|command not found/i.test(pane)) {
    throw new Error(`box start failed (exit ${r.exitCode}):\n${pane.slice(-2000)}\n${(r.stderr ?? "").slice(-2000)}`);
  }
  await api(omg, "POST", `/sandboxes/${id}/extend`, { seconds: KEEPALIVE_S }).catch(() => {}); // the in-VM loop renews after this
  const c = loadCloud();
  saveCloud({ ...c, current: plan.uuid, sessions: { ...c.sessions, [plan.uuid]: plan.snap } });

  console.log(pane.trimEnd().split("\n").slice(-15).join("\n"));
  console.log(`\nSession ${plan.uuid} is running on cloud box ${id} (tmux session "nomo").`);
  console.log(attachHelp());
  console.log(`  Status: --status   Sleep the box: --stop   Bring it back to this Mac: --back`);
  console.log(`\n!! Quit your local Claude Code session for ${plan.uuid} now, so the two copies don't diverge.`);
  await afterPair(omg, id, r.stdout ?? "", worker);
}

if (import.meta.main) {
  main().catch((e) => { console.error(`handoff: ${e.message ?? e}`); process.exit(1); });
}
