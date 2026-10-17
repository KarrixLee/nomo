// handoff — NOM-72 P1a: move the current Claude Code session to a cloud box (omg sandbox) and keep it
// running there in tmux. One box per user, remembered in ~/.config/cc-status/cloud.json.
//
//   bun plugin/dist/handoff.mjs [--session <uuid>] [--model <id>] [--force] [--dry-run]
//   bun plugin/dist/handoff.mjs --status | --stop | --pair
//   bun plugin/dist/handoff.mjs --screen | --send "<text>" | --send-key <tmux key, e.g. Escape, BTab, C-c>
//   bun plugin/dist/handoff.mjs --bake      (one-off: publish the credential-free `nomo-base` template)
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
// PORTABILITY: bun or node >= 18 (global fetch). Under node, an exec longer than ~300s trips undici's
// headers timeout — the box script is kept short, so prefer bun.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { b64url, type Bytes, fromB64url } from "../core/crypto";
import { renderPairPage } from "../core/pair-page";
import { buildPairURL, DEFAULT_WORKER_URL } from "../core/pair-url";
import { normalizeModelId } from "../core/adapter";
import { atomicWrite, CC_DIR } from "../core/shared";
import { renderQR } from "../qr/qr";
import { renderQRSVG } from "../qr/qr-svg";

const API = "https://infra.omg.dev/v1";
const CLOUD_PATH = `${CC_DIR}/cloud.json`;
const STAGE = "/tmp/nomo-handoff"; // flat files (/tmp/nomo-handoff-*): POST /files is only proven for existing dirs
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024; // ponytail: one JSON/base64 POST per file; chunk when a real repo needs more
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
export const PAIR_POLL = `grep -q '"e2eKeyB64"' ${BOX_CC}/config.json 2>/dev/null && echo PAIRED && exit 0
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
  if (!/^https?:\/\/[^/\s]+$/.test(w)) throw new Error(`worker URL must be an http(s) origin, got ${JSON.stringify(w)}`);
  return w;
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
}

function build(args: Map<string, string | true>, outDir: string): Plan {
  const cwd = process.cwd();
  const projDir = join(process.env.HOME!, ".claude", "projects", projectDirName(cwd));
  if (!existsSync(projDir)) throw new Error(`no Claude Code transcripts for ${cwd} (looked in ${projDir})`);
  const uuid = typeof args.get("--session") === "string"
    ? (args.get("--session") as string)
    : latestSession(readdirSync(projDir).map((name) => ({ name, mtimeMs: statSync(join(projDir, name)).mtimeMs })));
  if (!uuid || !existsSync(join(projDir, `${uuid}.jsonl`))) throw new Error(`session ${uuid ?? "(none)"} not found in ${projDir}`);

  const transcript = readFileSync(join(projDir, `${uuid}.jsonl`), "utf8");
  const model = typeof args.get("--model") === "string"
    ? toOpenRouterModel(args.get("--model") as string)
    : toOpenRouterModel(lastModel(transcript) ?? "claude-opus-5-5");

  const art: Record<string, string> = {};
  const put = (name: string) => { art[`${STAGE}-${name}`] = join(outDir, name); return join(outDir, name); };

  // Transcript + its subagent dir + project memory.
  tar(put("project.tgz"), projDir, [`${uuid}.jsonl`, ...[uuid, "memory"].filter((p) => existsSync(join(projDir, p)))]);

  // User layer. -h: skills are often symlinks into plugin/checkout dirs.
  const claudeHome = join(process.env.HOME!, ".claude");
  const layer = ["skills", "agents", "commands", "CLAUDE.md"].filter((p) => existsSync(join(claudeHome, p)));
  const hasLayer = layer.length > 0;
  if (hasLayer) tar(put("userlayer.tgz"), claudeHome, ["-h", ...layer]);

  // This plugin, to install for root on the box (hooks live from SessionStart).
  const marketplace = packPlugin(put("plugin.tgz"));

  let git = true, root = cwd, branch: string | undefined;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch { git = false; }
  if (git) {
    branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], root).trim();
    sh("git", ["bundle", "create", "-q", put("repo.bundle"), "HEAD"], root);
    // READ-ONLY on the user's tree: diff vs HEAD covers staged + unstaged; untracked ride in a tar.
    writeFileSync(put("wip.patch"), execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: 1 << 30 }));
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, maxBuffer: 1 << 30 });
    tar(put("untracked.tgz"), root, ["--null", "-T", "-"], untracked);
  } else {
    tar(put("folder.tgz"), cwd, ["--exclude", "node_modules", "--exclude", ".git", "."]);
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
  const launch = `. /dev/shm/nomo-env; rm -f /dev/shm/nomo-env; export PATH="/root/.local/bin:$PATH"; exec claude --resume ${uuid} --model ${model}`;
  const keepalive = `while tmux has-session -t nomo 2>/dev/null; do curl -s -X POST http://169.254.0.1:9090/v1/sandbox/keepalive -H 'Content-Type: application/json' -d '{"seconds":${KEEPALIVE_S}}' >/dev/null; sleep 600; done`;

  const script = `set -euo pipefail
if command -v tmux >/dev/null && tmux has-session -t nomo 2>/dev/null; then
  if [ "\${NOMO_FORCE:-}" != 1 ]; then echo "NOMO_BUSY: a handed-off session is still running on this box"; exit 3; fi
  tmux kill-server # not just the session: a pre-2.3.2 server still carries the API key in its argv
fi
# Keys reach claude via RAM, never argv: the file is gone the moment the launcher has read it. Taken
# FIRST and the key unset, so no tmux server (pair wait, relay, keepalive) ever inherits it in its env;
# a run that dies before claude starts removes the file on the way out.
( umask 077; export -p | grep -E '^declare -x (${runEnv.join("|")})=' > /dev/shm/nomo-env )
unset ANTHROPIC_AUTH_TOKEN
trap 'tmux has-session -t nomo 2>/dev/null || rm -f /dev/shm/nomo-env' EXIT
${boxSetup(marketplace)}

P=/root/.claude/projects/${enc}
mkdir -p "$P" && tar xzf ${STAGE}-project.tgz -C "$P"
${hasLayer ? `tar xzf ${STAGE}-userlayer.tgz -C /root/.claude` : "# no user layer"}

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

tmux new-session -d -s nomo -x 200 -y 50 -c ${q(cwd)} ${q(`bash -c ${q(launch)}`)}
tmux has-session -t nomo-keepalive 2>/dev/null || tmux new-session -d -s nomo-keepalive ${q(keepalive)}
sleep 8
tmux has-session -t nomo
tmux capture-pane -p -t nomo
`;
  return { uuid, cwd, root, git, branch, model, artifacts: art, script };
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

async function exec(key: string, id: string, script: string, env: Record<string, string> = {}) {
  return (await api(key, "POST", `/sandboxes/${id}/exec`, { cmd: "bash", args: ["-lc", script], env, timeoutMs: 600_000 })) as
    { stdout?: string; stderr?: string; exitCode: number };
}

interface Cloud { sandboxId?: string; macId?: string }
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
  if (sb?.status === "hibernated") { console.log(`Waking box ${sb.id}…`); sb = await api(key, "POST", `/sandboxes/${sb.id}/wake`); }
  if (!sb) {
    const hasBase = await api(key, "GET", `/templates/${BASE_TEMPLATE}/latest`).then(() => true, () => false);
    console.log(`Creating your cloud box (${hasBase ? `template ${BASE_TEMPLATE}` : "omg preset"})…`);
    sb = await api(key, "POST", "/sandboxes", createBody(hasBase, macId()));
    saveCloud({ ...loadCloud(), sandboxId: sb.id });
  }
  return waitRunning(key, sb);
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
  const guard = `tmux has-session -t nomo 2>/dev/null || { echo 'tmux nomo: not running'; exit 2; }`;
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
async function showPairing(omg: string, id: string, url: string): Promise<void> {
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
  try {
    for (const end = Date.now() + PAIR_WAIT_MS; Date.now() < end;) {
      await new Promise((r) => setTimeout(r, 5000));
      const out = ((await exec(omg, id, PAIR_POLL).catch(() => ({ stdout: "WAITING" }))).stdout ?? "").trim();
      if (out === "PAIRED") {
        result = resultPage("Paired ✓", `The box shows in Nomo as “${BOX_MACHINE_NAME}”. You can close this window.`);
        console.log(`Paired ✓ The box shows in Nomo as "${BOX_MACHINE_NAME}".`);
        return;
      }
      if (out.startsWith("ENDED")) { console.log(`Pairing ended without a scan: ${out.slice(5).trim() || "(no detail)"}`); break; }
    }
  } finally {
    // The QR (a secret) is overwritten either way; the open tab reloads into the result.
    if (!process.stdout.isTTY) writeFileSync(page, result, { mode: 0o600 });
  }
  console.log("Not paired. Retry with: bun plugin/dist/handoff.mjs --pair");
}

/** Act on the pairing lines of a box script's stdout. */
async function afterPair(omg: string, id: string, stdout: string): Promise<void> {
  const { url, rest } = takePairUrl(stdout);
  const failed = rest.match(/^NOMO_PAIR_FAILED: (.*)$/m);
  const old = rest.match(/^NOMO_REPAIR: (.*)$/m);
  if (old) console.log(`\nThe box was paired to ${old[1] || "another worker"}; pairing it again to the target worker.`);
  if (failed) console.log(`\nNomo pairing on the box failed: ${failed[1]}\nRetry with: bun plugin/dist/handoff.mjs --pair`);
  if (url) await showPairing(omg, id, url);
}

// -------------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "handoff");
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session" || a === "--model" || a === "--send" || a === "--send-key" || a === "--worker") args.set(a, argv[++i] ?? "");
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

  const keys = readKeys();
  const worker = targetWorker(args.get("--worker"), process.env.NOMO_WORKER_URL);

  if (args.has("--dry-run")) {
    const out = mkdtempSync(join(tmpdir(), "nomo-handoff-"));
    const plan = build(args, out);
    console.log(`DRY RUN: nothing was sent. Artifacts in ${out}`);
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

  if (["--status", "--stop", "--pair", "--screen", "--send", "--send-key"].some((f) => args.has(f))) {
    const sb = await getBox(omg, loadCloud().sandboxId);
    if (!sb) { console.log("No cloud box. Run `handoff` to create one."); return; }
    if (args.has("--stop")) {
      if (sb.status === "running") await api(omg, "POST", `/sandboxes/${sb.id}/hibernate`);
      console.log(`Box ${sb.id} is asleep (hibernated; files and memory kept, deleted after 14 days asleep).`);
      return;
    }
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
      const r = await exec(omg, sb.id, `${PAIR_FN}\nnomo_pair`, { NOMO_WORKER_URL: worker });
      if (/^NOMO_PAIRED$/m.test(r.stdout ?? "")) console.log(`Box ${sb.id} is already paired ✓`);
      await afterPair(omg, sb.id, r.stdout ?? "");
      return;
    }
    console.log(`Target worker: ${worker}`);
    console.log(`Box ${sb.id}: ${sb.status}${sb.keepAwakeUntil ? `, keep-awake until ${sb.keepAwakeUntil}` : ""}`);
    const r = await exec(omg, sb.id, `tmux has-session -t nomo 2>/dev/null && { echo 'tmux nomo: alive'; tmux capture-pane -p -t nomo | sed -e :a -e '/^\\n*$/{$d;N;ba' -e '}' | tail -20; } || echo 'tmux nomo: not running'
echo; echo '--- Nomo on the box ---'
${BOX_PLUGIN}
[ -n "$R" ] && bun "$R/dist/status-cmd.mjs" claude || echo 'Nomo plugin: not installed on the box'`);
    process.stdout.write(r.stdout ?? "");
    console.log(attachHelp());
    return;
  }

  if (!keys.openrouter) throw new Error("OPENROUTER_API_KEY not set (env or ~/.nomo-spike.env)");
  const out = mkdtempSync(join(tmpdir(), "nomo-handoff-"));
  const plan = build(args, out);
  console.log(`Handing off session ${plan.uuid} (${plan.model}) from ${plan.cwd} · Nomo worker ${worker}`);

  const id = await ensureBox(omg);
  for (const [box, local] of Object.entries(plan.artifacts)) {
    await api(omg, "POST", `/sandboxes/${id}/files`, [{ path: box, content: readFileSync(local).toString("base64"), mode: 0o600 }]);
  }
  const r = await exec(omg, id, plan.script, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${RELAY_PORT}`, // or-relay, which forwards to OpenRouter
    ANTHROPIC_AUTH_TOKEN: keys.openrouter,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    NOMO_WORKER_URL: worker,
    ...(args.has("--force") ? { NOMO_FORCE: "1" } : {}),
  });
  const pane = takePairUrl(r.stdout ?? "").rest.replace(/^NOMO_(PAIRED|PAIR_FAILED: .*|REPAIR: .*)$\n?/gm, ""); // never echo the QR URL
  if (r.exitCode === 4) throw new Error(`the OpenRouter relay did not start on box ${id}:\n${pane.slice(-1000)}`);
  if (r.exitCode === 3) throw new Error(`box ${id} is still running an earlier handoff. Check it with --status; rerun with --force to replace it.`);
  if (r.exitCode !== 0 || /No conversation found|API Error|Invalid API key|command not found/i.test(pane)) {
    throw new Error(`box start failed (exit ${r.exitCode}):\n${pane.slice(-2000)}\n${(r.stderr ?? "").slice(-2000)}`);
  }
  await api(omg, "POST", `/sandboxes/${id}/extend`, { seconds: KEEPALIVE_S }).catch(() => {}); // the in-VM loop renews after this

  console.log(pane.trimEnd().split("\n").slice(-15).join("\n"));
  console.log(`\nSession ${plan.uuid} is running on cloud box ${id} (tmux session "nomo").`);
  console.log(attachHelp());
  console.log(`  Status: --status   Sleep the box: --stop`);
  console.log(`\n!! Quit your local Claude Code session for ${plan.uuid} now, so the two copies don't diverge.`);
  await afterPair(omg, id, r.stdout ?? "");
}

if (import.meta.main) {
  main().catch((e) => { console.error(`handoff: ${e.message ?? e}`); process.exit(1); });
}
