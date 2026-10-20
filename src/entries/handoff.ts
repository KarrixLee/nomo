// handoff — NOM-72 P1a: move the current Claude Code session to a cloud box (omg sandbox) and keep it
// running there in tmux. One box per user, remembered in ~/.config/cc-status/cloud.json.
//
//   bun plugin/dist/handoff.mjs [--session <uuid>] [--model <id>] [--force] [--dry-run] [--then "<first message>"]
//   bun plugin/dist/handoff.mjs --status | --stop [--session <uuid> | --all] | --pair
//   bun plugin/dist/handoff.mjs --screen | --send "<text>" | --send-key <tmux key, e.g. Escape, BTab, C-c>   [--session <uuid>]
//   bun plugin/dist/handoff.mjs --bake      (one-off: publish the credential-free `nomo-base` template)
//   bun plugin/dist/handoff.mjs --back [--session <uuid>] [--force] [--no-open] [--wait <min>]
//   bun plugin/dist/handoff.mjs --check     (only print the cloud-readiness block, core/readiness.ts; moves nothing)
//   bun plugin/dist/handoff.mjs --later [--session <uuid>] | --later-cancel | --later-status   (/nomo-cc:handoff, see core/handoff-later.ts)
//
// WHAT TRAVELS: a git bundle of HEAD + `git diff --binary HEAD` + a tar of untracked non-ignored files
// (the user's working tree and index are only READ), the transcript (+ its subagent dir) and project
// memory into /root/.claude/projects/<same dir>/, and the user layer (~/.claude/{skills,agents,commands,
// CLAUDE.md}). The repo is recreated at the SAME absolute path because the transcript embeds its cwd.
//
// WHAT NEVER TRAVELS: the Mac's ~/.claude.json, .credentials.json or settings env, and any untracked
// secret-named file (.env, .dev.vars, *.pem… core/readiness.ts isSecretName; packList drops them). The model runs on
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
// 169.254.0.1:9090 endpoint for as long as any session's tmux lives. When the last CC exits, the lease
// lapses and the box sleeps on its own.
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
// holds no marker for unless --force. Ends by opening Terminal on `claude --resume` (--no-open just prints it).
//
// SEVERAL SESSIONS (NOM-92): a box runs up to BOX_MAX_SESSIONS at once, each in its own tmux
// `nomo-<id12>` with its own marker /root/.nomo-sessions/<uuid> (project root + tmux name) and key file
// /dev/shm/nomo-env-<id12>; one per project root (two would share the working tree). cloud.json `active`
// lists them on the Mac. --force, --stop --session, --back act on ONE session; the box sleeps only when
// none is left running. --screen/--send/--send-key/--stop/--back take --session; without it the parked
// window's own session, else the only active one, else the list. A pre-2.3.29 box (tmux `nomo`,
// /root/.nomo-current) is migrated in place by nomo_migrate.
//
// PORTABILITY: bun or node >= 18 (global fetch). Under node, an exec longer than ~300s trips undici's
// headers timeout — the box script is kept short, so prefer bun.

import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { b64url, type Bytes, fromB64url } from "../core/crypto";
import { renderPairPage } from "../core/pair-page";
import { buildPairURL, DEFAULT_WORKER_URL } from "../core/pair-url";
import { normalizeModelId } from "../core/adapter";
import { cloudReadiness, gitProbe, isSecretName, trackedSecretFiles } from "../core/readiness";
import { scanHandoff, secretSummary } from "../core/transcript-scan";
import { backLockHolder, clearPark, cloudActive, moveResultFile, type MoveWhy, PARK_DIR, writeBackResult, writeMoveResult, readPark, releaseBackLock, stageLanding, takeBackLock, writePark } from "../core/park";
import { atomicWrite, CC_DIR, pidAlive, pidAncestors, pidCommand, readRecord, SESSIONS_DIR } from "../core/shared";
import {
  BOX_MAX_SESSIONS, cancelPending, claimPending, DEFAULT_THEN, EXIT_BOX_GONE, phoneMoveCheck, settleThenStamp, contextTokens, contextTokensOf, GONE_MSG, sizeWarning, TAIL_BYTES, handoffArgv, LATER_LOG, LATER_USAGE, laterStatus, transcriptSecretWarning, needsPairing, parseLaterArg, type Pending, PENDING_PATH, readPending, resolveSession, waitThenHandoff,
} from "../core/handoff-later";
import {
  agentConfigPaths, applyInPlace, atomicWriteBytes, type BoxArtifacts, boxChangedPaths, boxIdle, copyContained, decideCode, extractTgz,
  backCaps, landFolder, landOnBranch, listFiles, MAX_ARTIFACT_BYTES, macGitState, mergeMemory, mkdirp, parseMarkers, printable,
  type Snapshot, takeSnapshot, transcriptAction, validateTree,
} from "../core/cloud-back";
export { BOX_MAX_SESSIONS };
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
const BOX_PLUGIN = `R=$(ls -d /root/.claude/plugins/cache/nomo/nomo-cc/*/ 2>/dev/null | tail -1) || true`; // none: callers say so
/** == or-relay.ts RELAY_PORT (not imported: bundling an entry inlines its main block into this one). */
export const RELAY_PORT = 47181;
const BASE_TEMPLATE = "nomo-base";
/** First line of every box script: drop a /dev/shm/nomo-env* a dead launch left behind. Only one older
 *  than 15 min: a handoff in flight (a fresh box installs for minutes) writes its own and touches it again
 *  right before launch; the box exec itself times out at 10 min. */
export const SHM_SWEEP = `find /dev/shm -maxdepth 1 -name 'nomo-env*' -mmin +15 -delete 2>/dev/null || true`;
/** Per handed-off session: /root/.nomo-sessions/<uuid> = "<project root>\n<tmux session>\n". It lives
 *  from the handoff until --back pulls the work (a stopped session keeps it: its work is still there). */
const BOX_SESSIONS = "/root/.nomo-sessions";
/** Pre-2.3.29: the one session the box ran, in tmux `nomo` (migrated into a marker by nomo_migrate). */
const BOX_CURRENT = "/root/.nomo-current";
/** Box shell helpers shared by every per-session script. tmux targets are always exact (`=name`): a bare
 *  `-t nomo` prefix-matches nomo-relay once `nomo` is gone.
 *  - nomo_t <uuid>: T = that session's tmux name (the marker's — 2.3.29 wrote nomo-<id8> — else nomo-<id12>).
 *  - nomo_migrate: a pre-2.3.29 box's /root/.nomo-current becomes a marker (root from the transcript's
 *    cwd), keeping its legacy tmux name `nomo` — only while that tmux runs: older --back never removed
 *    the file, so without a live `nomo` it names a session that already came home and is just dropped.
 *  - nomo_live: the uuids whose tmux runs.
 *  - nomo_prune [self]: with NOMO_KNOWN set (exec env: the Mac's cloud.json `active`, space-separated),
 *    drop every marker that is neither running, nor being handed off (.claim-), nor on the Mac's record:
 *    a session already brought back (by a plugin that left its marker), which would otherwise block
 *    its folder forever. Unset NOMO_KNOWN = prune nothing.
 *  Functions always return 0 (callers run under set -e). */
export const BOX_LIB = `SD=${BOX_SESSIONS}
nomo_t() { T=$(sed -n 2p "$SD/$1" 2>/dev/null) || true; [ -n "$T" ] || T="nomo-$(printf %s "$1" | tr -d - | cut -c1-12)"; return 0; }
nomo_alive() { tmux has-session -t "=$1" 2>/dev/null; }
nomo_migrate() {
  local L t d r
  L=$(head -c 64 ${BOX_CURRENT} 2>/dev/null | tr -cd '0-9a-f-') || true
  [ -n "$L" ] || return 0
  if [ ! -f "$SD/$L" ] && nomo_alive nomo; then
    t=$(ls /root/.claude/projects/*/"$L".jsonl 2>/dev/null | head -1) || true
    d=; [ -z "$t" ] || d=$(grep -o '"cwd":"[^"]*"' "$t" | tail -1 | cut -d'"' -f4) || true
    r=; [ -z "$d" ] || r=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || true; [ -n "$r" ] || r=$d
    mkdir -p "$SD" && printf '%s\\nnomo\\n' "$r" > "$SD/$L"
  fi
  rm -f ${BOX_CURRENT}
  return 0
}
nomo_live() { local f; for f in "$SD"/*; do [ -f "$f" ] || continue; nomo_t "\${f##*/}"; if nomo_alive "$T"; then printf '%s\\n' "\${f##*/}"; fi; done; return 0; }
nomo_prune() {
  [ -n "\${NOMO_KNOWN+x}" ] || return 0
  local f u T
  for f in "$SD"/*; do
    [ -f "$f" ] || continue; u=\${f##*/}
    [ "$u" != "\${1:-}" ] && [ ! -f "$SD/.claim-$u" ] || continue
    case " $NOMO_KNOWN " in *" $u "*) continue ;; esac
    nomo_t "$u"; if command -v tmux >/dev/null && nomo_alive "$T"; then continue; fi
    rm -f "$f"; echo "Dropped the box's stale record of session $u (not running, not on this Mac's record: brought back already)."
  done
  return 0
}`;
/** Prelude of every per-session box script: sweep, helpers, migrate, T for `uuid`. */
export const boxPrelude = (uuid: string): string => `${SHM_SWEEP}\n${BOX_LIB}\nnomo_migrate\nnomo_t ${q(uuid)}`;
/** The marker line (the session's claim on its root + slot), written inside the admission lock. */
export const writeMarker = (uuid: string, root: string): string =>
  `mkdir -p "$SD" && printf '%s\\n%s\\n' ${q(root)} ${q(tmuxName(uuid))} > "$SD/"${q(uuid)}`;
/** The short id in box names (tmux, key file, stage, pack): 12 hex chars of the uuid. */
export const id12 = (uuid: string): string => uuid.replace(/-/g, "").slice(0, 12);
export const tmuxName = (uuid: string): string => `nomo-${id12(uuid)}`;
/** This session's own key file on /dev/shm (RAM, 0600, deleted by the launcher as it reads it). */
export const shmEnvFile = (uuid: string): string => `/dev/shm/nomo-env-${id12(uuid)}`;
/** The tmux command that runs claude for `uuid` (ids checked by checkLaunchIds). No key file (swept, or
 *  a rerun) → it stops there, never a claude without its keys. */
export const launchLine = (uuid: string, model: string): string =>
  `[ -f ${shmEnvFile(uuid)} ] || { echo 'Nomo: the key file is gone; rerun the handoff.'; sleep 30; exit 1; }; . ${shmEnvFile(uuid)}; rm -f ${shmEnvFile(uuid)}; export PATH="/root/.local/bin:$PATH"; exec claude --resume ${uuid} --model ${q(model)}`;
/** The in-VM keep-awake loop: renews the lease while ANY handed-off session's tmux runs. */
export const keepaliveLoop = (): string =>
  `while ${ANY_SESSION}; do curl -s -X POST http://169.254.0.1:9090/v1/sandbox/keepalive -H 'Content-Type: application/json' -d '{"seconds":${KEEPALIVE_S}}' >/dev/null; sleep 600; done`;
/** True while any handed-off session's tmux runs (nomo-<id12>, 2.3.29's nomo-<id8>, or the legacy
 *  `nomo`); never relay/keepalive/pair. */
export const ANY_SESSION = `tmux ls -F '#{session_name}' 2>/dev/null | grep -qxE 'nomo(-[0-9a-f]{8}|-[0-9a-f]{12})?'`;
/** Box (after boxPrelude, under set -e): may `uuid` start at `root`? Exit 3 with NOMO_BUSY (its own tmux
 *  runs; --force kills THAT session only, never the server), NOMO_SAME_ROOT=<id> (another session that
 *  was not brought back holds the root: they would share the tree; --force does not override it),
 *  NOMO_FULL=<n> (BOX_MAX_SESSIONS running or being handed off) or NOMO_LOCKED (another handoff held the
 *  lock past 5 min). Under flock: the check and this session's claim (its marker + $SD/.claim-<uuid>)
 *  are one step, so two concurrent handoffs can't both pass. Only tmux has-session/kill-session run
 *  inside the lock (neither starts a tmux server, which would inherit fd 9 and hold it forever). The
 *  EXIT trap drops the claim, and a marker this run created when no session got launched. Leaves N =
 *  the other sessions running or being handed off. */
export function admitScript(uuid: string, root: string): string {
  const u = q(uuid);
  return `N=0; OWN=; mkdir -p "$SD"
nomo_exit() {
  rm -f "$SD/.claim-"${u}
  if ! nomo_alive ${q(tmuxName(uuid))}; then rm -f ${shmEnvFile(uuid)}; [ "$OWN" != 1 ] || rm -f "$SD/"${u}; fi
  return 0
}
exec 9>${BOX_SESSIONS}.lock
if command -v flock >/dev/null; then flock -w 300 9 || { echo NOMO_LOCKED; exit 3; }; fi
if command -v tmux >/dev/null && nomo_alive "$T"; then
  if [ "\${NOMO_FORCE:-}" != 1 ]; then echo "NOMO_BUSY: session ${uuid} is already running on this box"; exit 3; fi
  tmux kill-session -t "=$T"
fi
find "$SD" -maxdepth 1 -name '.claim-*' -mmin +15 -delete 2>/dev/null || true
nomo_prune ${u}
for f in "$SD"/*; do
  [ -f "$f" ] && [ "\${f##*/}" != ${u} ] || continue
  if [ "$(head -1 "$f")" = ${q(root)} ]; then echo "NOMO_SAME_ROOT=\${f##*/}"; exit 3; fi
done
C=0
for c in "$SD"/.claim-*; do
  [ -f "$c" ] && [ "\${c##*/.claim-}" != ${u} ] || continue
  nomo_t "\${c##*/.claim-}"; command -v tmux >/dev/null && nomo_alive "$T" || C=$((C+1))
done
if command -v tmux >/dev/null; then N=$(( $(nomo_live | wc -l) + C )); else N=$C; fi
if [ "$N" -ge ${BOX_MAX_SESSIONS} ]; then echo "NOMO_FULL=$N"; exit 3; fi
[ -f "$SD/"${u} ] || OWN=1
${writeMarker(uuid, root)}
: > "$SD/.claim-"${u}
trap nomo_exit EXIT
flock -u 9 2>/dev/null || true
exec 9>&-`;
}
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
 *  the old cached dist. Needs <stage>-plugin.tgz uploaded. With other sessions running or being handed
 *  off ($N > 0) and a plugin installed, nothing is reinstalled: the wipe would pull the hooks out from
 *  under them (exit 127). The box then keeps its version until those sessions are back. */
export function boxSetup(marketplace: string, stage = STAGE): string {
  const version = (JSON.parse(marketplace).plugins?.[0]?.version ?? "") as string;
  return `export PATH="/root/.local/bin:/root/.bun/bin:$PATH"
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1
command -v tmux >/dev/null || { apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux >/dev/null; }
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || true
command -v bun >/dev/null || echo "WARN: no bun on the box, Nomo hooks stay silent"
claude --version

I=$(ls /root/.claude/plugins/cache/nomo/nomo-cc/ 2>/dev/null | tail -1) || true
if [ "\${N:-0}" -gt 0 ] && [ -n "$I" ]; then
  [ "$I" = ${q(version)} ] || echo "The box keeps Nomo plugin $I (not ${version}) until its $N other session(s) are back."
else
M=/root/.nomo/marketplace
rm -rf "$M" && mkdir -p "$M/plugin" "$M/.claude-plugin" && tar xzf ${stage}-plugin.tgz -C "$M/plugin"
printf '%s\n' ${q(marketplace)} > "$M/.claude-plugin/marketplace.json"
claude plugin marketplace add "$M" </dev/null >/dev/null 2>&1 || true
claude plugin uninstall nomo-cc@nomo </dev/null >/dev/null 2>&1 || true
rm -rf /root/.claude/plugins/cache/nomo
claude plugin install nomo-cc@nomo </dev/null >/dev/null
fi`;
}

/** --bake's box script: tools + plugin, then scrub anything a template must never carry. */
export function bakeScript(marketplace: string): string {
  return `set -euo pipefail
${boxSetup(marketplace)}
rm -rf ${STAGE}-* ${BOX_CC} /root/.claude/projects /dev/shm/nomo-env* ${BOX_SESSIONS} ${BOX_CURRENT}
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

/** The NUL list (for `tar --no-recursion -T -`) of the user's files to send from `root`: each of `entries`
 *  (a dir is walked; links are listed, never followed), minus every file isSecretName matches and any dir
 *  `skipDir` names. An un-ignored .env never leaves the Mac; a git-TRACKED one is in the bundle anyway. */
export function packList(root: string, entries: string[], skipDir: (name: string) => boolean = () => false): Buffer {
  const out: string[] = [];
  const add = (rel: string): void => {
    const name = rel.split("/").pop()!;
    const st = lstatSync(join(root, rel), { throwIfNoEntry: false });
    if (!st) return;
    if (!st.isDirectory()) { if (!isSecretName(name)) out.push(rel); return; }
    if (skipDir(name)) return;
    out.push(rel);
    for (const n of readdirSync(join(root, rel))) add(`${rel}/${n}`);
  };
  for (const e of entries) add(e.replace(/\/$/, ""));
  return Buffer.from(out.map((p) => p + "\0").join(""));
}

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

export interface Plan {
  uuid: string;
  warn?: string; // a big-session heads-up (sizeWarning)
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

export function build(args: Map<string, string | true>, outDir: string): Plan {
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
  const stage = `${STAGE}-${id12(uuid)}`; // per session: two handoffs never share an upload
  const put = (name: string) => { art[`${stage}-${name}`] = join(outDir, name); return join(outDir, name); };

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
    const list = packList(root, untracked.toString().split("\0").filter(Boolean));
    tar(put("untracked.tgz"), root, [...EXCLUDE_SENSITIVE, "--no-recursion", "--null", "-T", "-"], list);
  } else {
    const skip = (n: string) => n === "node_modules" || n === ".git";
    const list = packList(cwd, readdirSync(cwd).filter((n) => !skip(n)), skip);
    tar(put("folder.tgz"), cwd, [...EXCLUDE_SENSITIVE, "--no-recursion", "--null", "-T", "-"], list);
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
  const envFile = shmEnvFile(uuid);
  const keepalive = keepaliveLoop();

  const script = `${boxPrelude(uuid)}
set -euo pipefail
${admitScript(uuid, root)}
T=${tmuxName(uuid)}
# Keys reach claude via RAM, never argv: the file (this session's own, so two handoffs never race on it)
# is gone the moment the launcher has read it. Taken FIRST and the key unset, so no tmux server (pair
# wait, relay, keepalive) ever inherits it in its env; a run that dies before claude starts removes it.
rm -f ${envFile}
( umask 077; export -p | grep -E '^declare -x (${runEnv.join("|")})=' > ${envFile} )
unset ANTHROPIC_AUTH_TOKEN
${boxSetup(marketplace, stage)}

P=/root/.claude/projects/${enc}
mkdir -p "$P" && tar xzf ${stage}-project.tgz -C "$P"
${hasLayer ? `tar xzf ${stage}-userlayer.tgz -C /root/.claude` : "# no user layer"}

# The user's git identity arrives as exec env (never argv), so the box's commits are authored as them.
if [ -n "\${NOMO_GIT_NAME:-}" ]; then git config --global user.name "$NOMO_GIT_NAME"; fi
if [ -n "\${NOMO_GIT_EMAIL:-}" ]; then git config --global user.email "$NOMO_GIT_EMAIL"; fi

ROOT=${q(root)}
[ -e "$ROOT" ] && mv "$ROOT" "$ROOT.nomo-bak-$(date +%s)"
mkdir -p "$(dirname "$ROOT")"
${git
    ? `git -c advice.detachedHead=false clone -q ${stage}-repo.bundle "$ROOT"
cd "$ROOT"
${branch && branch !== "HEAD" ? `git checkout -q -B ${q(branch)}` : "# detached HEAD"}
[ -s ${stage}-wip.patch ] && git apply --binary ${stage}-wip.patch
tar xzf ${stage}-untracked.tgz -C "$ROOT"`
    : `mkdir -p "$ROOT" && tar xzf ${stage}-folder.tgz -C "$ROOT"`}

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

# The OpenRouter relay, fresh from this install, unless other sessions are talking through it right now.
${BOX_PLUGIN}
# (A concurrent handoff may be starting it too: start only when none runs, never kill one in use.)
if [ "$N" -gt 0 ] && (exec 3<>/dev/tcp/127.0.0.1/${RELAY_PORT}) 2>/dev/null; then :; else
  [ "$N" -gt 0 ] || tmux kill-session -t =nomo-relay 2>/dev/null || true
  tmux has-session -t =nomo-relay 2>/dev/null || tmux new-session -d -s nomo-relay "$(command -v bun || command -v node) $R/dist/or-relay.mjs" || true
  for _ in $(seq 20); do (exec 3<>/dev/tcp/127.0.0.1/${RELAY_PORT}) 2>/dev/null && break; sleep 0.5; done
fi
(exec 3<>/dev/tcp/127.0.0.1/${RELAY_PORT}) 2>/dev/null || { echo "NOMO_RELAY_FAILED"; tmux capture-pane -p -t =nomo-relay: 2>/dev/null; exit 4; }

# The marker (written at admission) says which session this tmux runs and at which root. The key file
# must still be there (a stuck run past the sweep age lost it): touched so no sweep takes it before launch.
[ -f ${envFile} ] || { echo "NOMO_KEYS_GONE"; exit 5; }
touch ${envFile}
tmux new-session -d -s "$T" -x 200 -y 50 -c ${q(cwd)} ${q(`bash -c ${q(launchLine(uuid, model))}`)}
# Restarted every time: a pre-2.3.29 loop watches the legacy name only.
tmux kill-session -t =nomo-keepalive 2>/dev/null || true
tmux new-session -d -s nomo-keepalive ${q(keepalive)}
sleep 8
tmux has-session -t "=$T"
tmux capture-pane -p -t "=$T:"
`;
  return { uuid, cwd, root, git, branch, model, artifacts: art, script, snap, gitUser, warn: sizeWarning(contextTokens(transcriptBytes.subarray(Math.max(0, transcriptBytes.length - TAIL_BYTES)).toString("utf8"), transcriptBytes.length)) };
}

// --------------------------------------------------------------------------------------------- omg

/** A response body as text, aborting past `max` bytes: by Content-Length before reading, else by counting
 *  (a box-reported size is not a limit on what the download actually sends). */
export async function readCapped(res: Response, max = Infinity): Promise<string> {
  const tooBig = () => new Error(`response over ${(max / 1e6).toFixed(0)} MB; refusing it`);
  if (Number(res.headers.get("content-length") ?? 0) > max) { await res.body?.cancel(); throw tooBig(); }
  if (!res.body || max === Infinity) return res.text();
  const reader = res.body.getReader(), dec = new TextDecoder();
  let n = 0, text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + dec.decode();
    if ((n += value.byteLength) > max) { await reader.cancel(); throw tooBig(); }
    text += dec.decode(value, { stream: true });
  }
}

async function api(key: string, method: string, path: string, body?: unknown, maxBytes?: number): Promise<any> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await readCapped(res, maxBytes);
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

/** `active`: the sessions handed off to the box and not brought back yet (oldest first); `sessions` holds
 *  each one's handoff snapshot for --back; `pairedTo` is "<sandboxId> <worker>" once that box was seen
 *  paired to that worker (/nomo-cc:handoff's gate). Pre-2.3.29 files carry `current` (one id) instead. */
export interface Cloud { sandboxId?: string; macId?: string; active?: string[]; sessions?: Record<string, Snapshot>; pairedTo?: string }
/** A cloud.json as read: a legacy `current` becomes `active` (and is dropped on the next write). */
export function normalizeCloud(raw: Cloud & { current?: string }): Cloud {
  const { current, ...c } = raw;
  const active = Array.isArray(c.active) ? c.active.filter((s) => typeof s === "string" && UUID_RE.test(s)) : current && UUID_RE.test(current) ? [current] : [];
  return { ...c, active };
}
/** `here` (the invoking Claude Code session) when it is one of the cloud's: active, or a parked window. */
export function hereSession(here: unknown, c: Cloud, park: (id: string) => { state: string } | undefined = readPark): string | undefined {
  if (typeof here !== "string" || !UUID_RE.test(here)) return undefined;
  return c.active?.includes(here) || ["cloud", "landing"].includes(park(here)?.state ?? "") ? here : undefined;
}
/** Which session a per-session command means: --session, else `here` (the parked window it runs from),
 *  else the only active one; several → an error listing them. */
export function pickSession(flag: string | true | undefined, here: string | undefined, c: Cloud): string {
  if (typeof flag === "string") {
    if (!UUID_RE.test(flag)) throw new Error(`session id must be a UUID, got ${JSON.stringify(flag)}`);
    return flag;
  }
  const active = c.active ?? [];
  if (here) return here;
  if (active.length === 1) return active[0];
  if (!active.length) throw new Error("no handed-off session on record; pass --session <uuid>");
  throw new Error(`${active.length} sessions are in the cloud; say which with --session <id>:\n${listActive(c)}`);
}
export const listActive = (c: Cloud): string =>
  (c.active ?? []).map((s) => `  ${s}  ${c.sessions?.[s]?.root ?? "(no snapshot)"}`).join("\n");

/** Mac-side reason for a handoff box script's exit 3. */
export function busyMessage(stdout: string, box: string, uuid: string, root: string): string {
  const same = stdout.match(/^NOMO_SAME_ROOT=([0-9a-f-]+)$/m);
  if (same) {
    return `session ${same[1]} is already on box ${box} for ${root}, and one project folder holds one session (two would share the working tree). ` +
      `Bring it back first: --back --session ${same[1]}`;
  }
  if (/^NOMO_LOCKED$/m.test(stdout)) return `another handoff to box ${box} is still in progress; rerun this one in a minute.`;
  const full = stdout.match(/^NOMO_FULL=(\d+)$/m);
  if (full) {
    return `box ${box} already runs ${full[1]} sessions (the cap is ${BOX_MAX_SESSIONS}). Bring one back (--back --session <id>) or stop one (--stop --session <id>) first; --status lists them.`;
  }
  return `session ${uuid} is already running on box ${box}. Check it with --status; rerun with --force to replace it (only that session is stopped).`;
}

/** --stop for one session: exit its claude (its work stays on the box for --back), then hibernate the box
 *  only when no session is left running. */
export async function stopOne(uuid: string, run: (script: string, env: Record<string, string>) => Promise<{ stdout?: string }>,
  hibernate: () => Promise<void>, force = false): Promise<string> {
  const out = (await run(backStopScript(uuid), force ? { NOMO_FORCE: "1" } : {})).stdout ?? "";
  if (/^NOMO_OTHER$/m.test(out)) return `The box has no session ${uuid} (already brought back?); nothing was stopped. --status lists the box's sessions.`;
  const left = parseLeft(out);
  const hard = /^NOMO_HARD_STOP$/m.test(out) ? " (hard stop: its last turn may be cut short)" : "";
  if (left === 0) { await hibernate(); return `Stopped session ${uuid}${hard}. No session left running, so the box is asleep.`; }
  return `Stopped session ${uuid}${hard}; its work stays on the box for --back. The box stays awake for ${left ?? "the other"} running session(s).`;
}

const loadCloud = (): Cloud => { try { return normalizeCloud(JSON.parse(readFileSync(CLOUD_PATH, "utf8"))); } catch { return {}; } };
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
/** The ONLY way cloud.json is written: under an exclusive lockfile (O_EXCL; one older than 10s is a dead
 *  writer's and is broken), `fn` applied to a FRESH read, then tmp + rename. Two handoffs finishing at
 *  once each add their own session instead of one overwriting the other.
 *  ponytail: two waiters breaking the same stale lock at once can both proceed; that needs a writer dead
 *  mid-write AND two racing ones. */
export function updateCloudAt(path: string, fn: (c: Cloud) => Cloud): Cloud {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  for (const end = Date.now() + 15_000; ;) {
    try { closeSync(openSync(lock, "wx", 0o600)); break; } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > end) throw new Error(`${path} is locked by another Nomo command (delete ${lock} if none is running)`);
      Atomics.wait(SLEEP, 0, 0, 20);
    }
  }
  try {
    let raw: Cloud = {};
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { /* none yet */ }
    const next = fn(normalizeCloud(raw));
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return next;
  } finally { try { unlinkSync(lock); } catch { /* gone */ } }
}
const updateCloud = (fn: (c: Cloud) => Cloud): Cloud => updateCloudAt(CLOUD_PATH, fn);
/** A random per-Mac id for omg's externalUserId (lists a user's boxes); no PII, minted once. */
function macId(): string {
  return updateCloud((c) => (c.macId ? c : { ...c, macId: randomUUID() })).macId!;
}

/** The create body: the baked template when the account has one, else the omg preset. The two are
 *  mutually exclusive (both → 400). */
export function createBody(hasBase: boolean, externalUserId: string): Record<string, string> {
  return { ...(hasBase ? { templateId: BASE_TEMPLATE } : { template: "omg" }), size: BOX_SIZE, externalUserId };
}

/** A definitive "this box does not exist" answer from the box API. Nothing else (network, timeout,
 *  401/403, 409, 5xx) ever means gone. */
const isGone = (e: any): boolean => e?.status === 404 || e?.status === 410;

/** The box, or undefined when it is DEFINITIVELY gone: none on record, or a 404/410 from the GET or
 *  from waking a stopped box. Every other error throws. A wake 409 (already waking) is retried like
 *  exec's. `wake: false` (the read-only commands) returns a stopped box as it is. */
export async function getBox(key: string, id: string | undefined, call: typeof api = api,
  opts: { wake?: boolean; sleep?: (ms: number) => Promise<void> } = {}): Promise<any | undefined> {
  if (!id) return undefined;
  let sb: any;
  try {
    sb = await call(key, "GET", `/sandboxes/${id}`);
  } catch (e: any) {
    if (isGone(e)) return undefined;
    throw e;
  }
  if (sb?.status !== "stopped" || opts.wake === false) return sb;
  console.log(`Box ${id} is stopped; trying to wake it…`);
  for (let i = 0; ; i++) {
    try { return await call(key, "POST", `/sandboxes/${id}/wake`); } catch (e: any) {
      if (isGone(e)) return undefined;
      if (e?.status !== 409 || i >= 5) throw e;
      await (opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(2000);
    }
  }
}

/** The box is gone (NOM-99): unpark the session, drop it from cloud.json, and say so plainly. The
 *  session continues on this Mac from where it was before the move; the phone row reads "box-gone". */
export function boxGone(uuid: string, deps: { clear?: (id: string) => void; update?: (fn: (c: Cloud) => Cloud) => unknown; result?: (id: string) => void } = {}): string {
  (deps.clear ?? clearPark)(uuid);
  (deps.update ?? updateCloud)((c) => {
    const { [uuid]: _gone, ...sessions } = c.sessions ?? {};
    return { ...c, sessions, active: (c.active ?? []).filter((s) => s !== uuid) };
  });
  (deps.result ?? ((id: string) => writeBackResult(id, "gone")))(uuid);
  return `Your cloud box is gone (deleted or stopped for good), so the work session ${uuid} did there is lost. ` +
    `The session continues on this Mac from where it was before the move; this window is unparked.`;
}

/** The user's one box, running: reuse (waking it if asleep) or create. */
async function ensureBox(key: string): Promise<string> {
  let sb: any;
  try { sb = await getBox(key, loadCloud().sandboxId); } catch (e: any) {
    throw new Error(`couldn't reach your cloud box (${e?.message ?? e}); nothing was changed. Try again in a minute.`);
  }
  if (!sb && process.env.NOMO_HANDOFF_HELPER) {
    // Unattended (/nomo-cc:handoff's helper): a new box needs a QR scan nobody is there to do.
    throw Object.assign(new Error(`your cloud box is gone (deleted after 14 days asleep, or stopped). Create and pair a new one from a terminal: cd ${q(process.cwd())} && ${q(process.execPath)} ${q(SELF)} --session <id>`), { exitCode: EXIT_BOX_GONE });
  }
  if (!sb) {
    const hasBase = await api(key, "GET", `/templates/${BASE_TEMPLATE}/latest`).then(() => true, () => false);
    console.log(`Creating your cloud box (${hasBase ? `template ${BASE_TEMPLATE}` : "omg preset"})…`);
    // The old box is confirmed gone (or none was on record): its sessions are box-gone, said out loud.
    for (const id of loadCloud().active ?? []) console.log(boxGone(id));
    sb = await api(key, "POST", "/sandboxes", createBody(hasBase, macId()));
    updateCloud((c) => ({ ...c, sandboxId: sb.id, active: [] }));
  }
  return wakeBox(key, sb);
}

/** NOM-99: the watchdog's ~30 min probe while a session is parked "cloud": a DEFINITIVELY gone box
 *  (getBox) unparks every one of its parked sessions. Any error (network, 5xx) changes nothing. */
export async function boxHealth(omg: string, deps: { cloud?: Cloud; park?: (id: string) => { state: string } | undefined; get?: typeof getBox; gone?: (id: string) => string; locked?: (id: string) => boolean } = {}): Promise<string[]> {
  const cloud = deps.cloud ?? loadCloud();
  // A session with a back running is that run's to settle (it reports gone itself), never the probe's.
  const parked = (cloud.active ?? []).filter((id) => (deps.park ?? readPark)(id)?.state === "cloud" &&
    !(deps.locked ?? ((s: string) => backLockHolder(s) !== undefined))(id));
  if (!parked.length || await (deps.get ?? getBox)(omg, cloud.sandboxId)) return [];
  for (const id of parked) console.log((deps.gone ?? boxGone)(id));
  return parked;
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

function attachHelp(several = false): string {
  const s = several ? " --session <id>" : "";
  return [
    `  Watch:  bun plugin/dist/handoff.mjs --screen${s}`,
    `  Type:   bun plugin/dist/handoff.mjs --send "your message"${s}     (keys: --send-key Escape | BTab | C-c | Enter)`,
  ].join("\n");
}

/** Box script for --status: every session the box holds (running or stopped, with its root), then Nomo's own status. */
export function statusScript(): string {
  return `${SHM_SWEEP}
${BOX_LIB}
nomo_migrate
nomo_prune
n=0; echo "Sessions on the box:"
for f in "$SD"/*; do
  [ -f "$f" ] || continue
  u=\${f##*/}; nomo_t "$u"
  if nomo_alive "$T"; then s=running; n=$((n+1)); else s=stopped; fi
  printf '  %s  %-8s %s  (tmux %s)\\n' "$u" "$s" "$(head -1 "$f")" "$T"
done
echo "  $n of ${BOX_MAX_SESSIONS} running"
echo NOMO_STATUS_SPLIT
echo '--- Nomo on the box ---'
${BOX_PLUGIN}
[ -n "$R" ] && bun "$R/dist/status-cmd.mjs" claude || echo 'Nomo plugin: not installed on the box'`;
}

/** Box-side `nomo_wait_idle N`: poll up to N times, 2s apart, until claude in tmux $T is idle at its
 *  input box (the screen's last lines hold a `>`/`❯` prompt line and a ─ rule, the LAST prompt line is
 *  not a numbered menu item, and the screen is unchanged for one poll). Only the last prompt line is
 *  menu-checked: chat history may hold `❯ 2.`. */
const IDLE_FN = `nomo_wait_idle() {
  prev=
  for _ in $(seq "$1"); do
    tmux has-session -t "=$T" 2>/dev/null || return 1
    cur=$(tmux capture-pane -p -t "=$T:" | grep -v '^[[:space:]]*$' | tail -8)
    if [ -n "$cur" ] && [ "$cur" = "$prev" ] && printf '%s\\n' "$cur" | grep -q '─' \\
      && printf '%s\\n' "$cur" | grep -Eq '^[│ ]*(>|❯)' \\
      && ! printf '%s\\n' "$cur" | grep -E '^[│ ]*(>|❯)' | tail -1 | grep -Eq '^[│ ]*(>|❯).{0,3}[0-9]+\\.'; then
      return 0
    fi
    prev=$cur
    sleep 2
  done
  return 1
}`;

/** Box-side `nomo_type`, shared by --send and --then: wait (~20s) for the idle prompt — a paste into a
 *  busy CC is silently dropped — else NOMO_BUSY, nothing typed. Then paste NOMO_TEXT (exec env only) into
 *  tmux $T as one bracketed paste (load-buffer from stdin, so a trailing `;` is never a tmux command
 *  separator and LF stays a newline, not a submit) and press Enter. NOMO_SENT needs positive evidence:
 *  the input box empty AND the text's first line (its first 40 bytes, cut back to a whole UTF-8 char)
 *  visible above the input; or a numbered menu took over. Text still in the box gets ONE more Enter.
 *  Else NOMO_UNCONFIRMED. */
export const TYPE_FN = `${IDLE_FN}
nomo_type() {
  want=
  if [ -n "$NOMO_TEXT" ]; then
    nomo_wait_idle 10 || { echo NOMO_BUSY; return 1; }
    want=$(printf '%s\\n' "$NOMO_TEXT" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -m1 . | LC_ALL=C cut -b1-40 \\
      | LC_ALL=C sed "s/[$(printf '\\300-\\377')][$(printf '\\200-\\277')]*\\$//")
    printf '%s' "$NOMO_TEXT" | tmux load-buffer -b nomo-first - && tmux paste-buffer -p -r -d -b nomo-first -t "=$T:" || { echo NOMO_UNCONFIRMED; return 1; }
    sleep 0.5
  fi
  tmux send-keys -t "=$T:" Enter
  for n in 1 2 3; do
    sleep 1
    p=$(tmux capture-pane -p -t "=$T:")
    k=$(printf '%s\\n' "$p" | grep -nE '^[│ ]*(>|❯)' | tail -1 | cut -d: -f1)
    l=$(printf '%s\\n' "$p" | sed -n "\${k:-0}p")
    if printf '%s\\n' "$l" | grep -Eq '^[│ ]*(>|❯).{0,3}[0-9]+\\.'; then echo NOMO_SENT; return 0; fi
    if { [ -z "$l" ] || printf '%s\\n' "$l" | grep -Eq '^[│ ]*(>|❯)( | )*$'; } \\
      && printf '%s\\n' "$p" | head -n "$(( \${k:-99999} - 1 ))" | grep -qF -- "$want"; then echo NOMO_SENT; return 0; fi
    [ "$n" = 1 ] && tmux send-keys -t "=$T:" Enter
  done
  echo NOMO_UNCONFIRMED
}`;

/** Box script for --screen / --send / --send-key. User text arrives ONLY as exec env (NOMO_TEXT /
 *  NOMO_KEY), never interpolated into the script. */
export function paneScript(mode: "screen" | "send" | "key", uuid: string): string {
  const guard = `${boxPrelude(uuid)}
tmux has-session -t "=$T" 2>/dev/null || { echo "session ${uuid} is not running on the box (tmux $T)"; exit 2; }`;
  if (mode === "send") return `${guard}\n${TYPE_FN}\nnomo_type`;
  if (mode === "key") return `${guard}\ntmux send-keys -t "=$T:" -- "$NOMO_KEY"`;
  return `${guard}\ntmux capture-pane -p -t "=$T:" | sed -e :a -e '/^\\n*$/{$d;N;ba' -e '}' | tail -40`;
}

/** Mac-side line for a --send result; "" when the box printed something else (e.g. tmux not running). */
export function sendResult(stdout: string): string {
  if (/^NOMO_SENT$/m.test(stdout)) return "Sent.";
  if (/^NOMO_BUSY$/m.test(stdout)) return "Not sent: the cloud session is still busy (no idle prompt after ~20s). Check --screen, then --send again.";
  if (/^NOMO_UNCONFIRMED$/m.test(stdout)) return "Not confirmed: the message wasn't seen submitted. Check --screen before resending (if it's still in the input, --send-key Enter).";
  return "";
}

/** Box script for --then: nomo_wait_idle up to `tries` polls, then nomo_type: NOMO_SENT / NOMO_UNCONFIRMED,
 *  or NOMO_NOT_READY. */
export function firstMessageScript(uuid: string, tries = 45): string {
  return `${boxPrelude(uuid)}
${TYPE_FN}
if nomo_wait_idle ${tries}; then nomo_type; exit 0; fi
echo NOMO_NOT_READY`;
}

export const FIRST_SKIPPED = "Session is in the cloud but the first message wasn't sent yet; the box may still type it, so check --screen first and only then --send it";
export const FIRST_UNCONFIRMED = "First message typed in the cloud session, but its submit wasn't confirmed; check --screen (if it's still in the input, --send-key Enter)";

/** --then after a successful handoff. Never throws: the session is already in the cloud. */
export async function sendFirstMessage(run: (script: string, env: Record<string, string>) => Promise<{ stdout?: string }>, text: string, uuid: string): Promise<string> {
  try {
    const out = (await run(firstMessageScript(uuid), { NOMO_TEXT: text })).stdout ?? "";
    if (/^NOMO_SENT$/m.test(out)) return "First message sent to the cloud session.";
    if (/^NOMO_UNCONFIRMED$/m.test(out)) return FIRST_UNCONFIRMED;
  } catch { /* box unreachable: same answer */ }
  return FIRST_SKIPPED;
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
        updateCloud((c) => ({ ...c, pairedTo: `${id} ${worker}` }));
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
  updateCloud((c) => ({ ...c, pairedTo: paired ? `${id} ${worker}` : undefined }));
  if (!paired && process.env.NOMO_HANDOFF_HELPER) {
    // Never a QR on an unattended Mac: the box runs the session, but the phone can't see it until paired.
    throw new Error(`the session started on box ${id}, but the box needs pairing, so your phone can't see it. Pair it from a terminal: ${q(process.execPath)} ${q(SELF)} --pair`);
  }
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
/** Where --back packs `uuid`'s work on the box: per session, so two backs never share files. */
export const backPrefix = (uuid: string): string => `${BACK}-${id12(uuid)}`;

/** Box shell (after boxPrelude): unless NOMO_FORCE=1, stop here (NOMO_OTHER) when the box holds no marker
 *  for `uuid`: already brought back, or never handed off to this box. Its root may hold another session. */
export function sessionGuard(uuid: string): string {
  return `if [ ! -f "$SD/"${q(uuid)} ] && [ "\${NOMO_FORCE:-}" != 1 ]; then echo NOMO_OTHER; exit 0; fi`;
}
/** Box: how many handed-off sessions still run (for "hibernate only when none are left"). */
export const LEFT_LINE = `echo "NOMO_LEFT=$(( $(nomo_live | wc -l) ))"`;
export function parseLeft(stdout: string): number | undefined {
  const m = stdout.match(/^NOMO_LEFT=(\d+)$/m);
  return m ? Number(m[1]) : undefined;
}

/** Box: is the session at a turn boundary? NOMO_OTHER when the box holds no marker for it; NOMO_GONE
 *  when claude already exited; else the Nomo record's lastEvent (when there is one), the transcript's
 *  age in seconds, and its last 64 KiB after NOMO_TAIL. */
export function backWaitScript(uuid: string, enc: string): string {
  return `${boxPrelude(uuid)}
${sessionGuard(uuid)}
tmux has-session -t "=$T" 2>/dev/null || { echo NOMO_GONE; exit 0; }
F=${BOX_CC}/sessions/${uuid}.json
[ -f "$F" ] && echo "NOMO_EVENT=$(grep -o '"lastEvent": *"[^"]*"' "$F" | head -1 | cut -d'"' -f4)"
T=/root/.claude/projects/${enc}/${uuid}.jsonl
[ -f "$T" ] || { echo NOMO_NOTRANSCRIPT; exit 0; }
echo "NOMO_AGE=$(( $(date +%s) - $(stat -c %Y "$T") ))"
echo NOMO_TAIL
tail -c 65536 "$T"`;
}

/** Box: exit claude — /exit, then C-c ×2, then kill-session (prints NOMO_HARD_STOP) — then the box's own
 *  reset.mjs, which ends the now-dead session's phone row (only dead-pid rows: other sessions' stay) and
 *  stops the box watchdog (the next hook restarts it). Refuses (NOMO_OTHER) without the session's marker;
 *  NOMO_FORCE=1 (--force) stops it anyway, and NOMO_ESC=1 interrupts a running turn first. The marker
 *  stays (the pack checks it too). Ends with NOMO_LEFT=<sessions still running>. */
export function backStopScript(uuid: string): string {
  return `${boxPrelude(uuid)}
${sessionGuard(uuid)}
gone() { ! tmux has-session -t "=$T" 2>/dev/null; }
if ! gone; then
  if [ "\${NOMO_ESC:-}" = 1 ]; then tmux send-keys -t "=$T:" Escape; sleep 2; fi
  tmux send-keys -t "=$T:" -l /exit; sleep 0.5; tmux send-keys -t "=$T:" Enter
  for _ in $(seq 30); do gone && break; sleep 1; done
  if ! gone; then
    tmux send-keys -t "=$T:" C-c; sleep 1; tmux send-keys -t "=$T:" C-c
    for _ in $(seq 10); do gone && break; sleep 1; done
  fi
  if ! gone; then tmux kill-session -t "=$T"; echo NOMO_HARD_STOP; fi
fi
${BOX_PLUGIN}
if [ -n "$R" ]; then bun "$R/dist/reset.mjs" >/dev/null 2>&1 || true; fi
echo NOMO_STOPPED
${LEFT_LINE}`;
}

/** Box: unless the box holds `uuid`'s marker (sessionGuard: another session's repo may sit at the same
 *  root), pack the session's work as backPrefix(uuid)-* (BACK_FILES) and report NOMO_HEAD / NOMO_BRANCH /
 *  NOMO_COMMITS / NOMO_FF (the handoff HEAD, NOMO_BASE in exec env, is an ancestor of the box HEAD) and
 *  NOMO_SIZE <name> <bytes>. Without a base the bundle carries all of HEAD and FF is 0. */
export function backPackScript(uuid: string, enc: string, root: string, isGit: boolean): string {
  const ex = EXCLUDE_SENSITIVE.map((a) => (a === "--exclude" ? a : q(a))).join(" ");
  const BACK = backPrefix(uuid);
  return `${boxPrelude(uuid)}
${sessionGuard(uuid)}
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

/** The Terminal launcher --back opens: one `exec` line. `model` (lastModel of the returned transcript) is
 *  passed as --model because box turns record OpenRouter ids that first-party CC can't restore; anything
 *  not shaped like a bare CC id is dropped. */
export function resumeCommand(cwd: string, id: string, model?: string): string {
  const m = model && /^claude-[a-z0-9.-]+$/.test(model) ? ` --model ${q(model)}` : "";
  return `cd ${q(cwd)} && exec claude --resume ${id}${m}`;
}

/** The last line of a /nomo-cc:back run from the parked window itself. */
export const sameWindowBackLine = (id: string): string => `Back. Type /resume ${id} to continue here.`;

async function back(omg: string, args: Map<string, string | true>): Promise<void> {
  // --phone (NOM-93: the watchdog runs this for the phone's Bring back): no turn of the window launched
  // this run, so "idle" is just "no open turn" (stageLanding with -1), not "a turn ended since".
  const startedAt = args.has("--phone") ? -1 : Date.now();
  const cloud = loadCloud();
  const here = args.get("--from-session") || process.env.CLAUDE_CODE_SESSION_ID;
  // From a parked window: that window's session (a rerun whose back was interrupted after staging is
  // "landing", and cloud.json no longer names it). From anywhere else: the only active one, else ask.
  const uuid = pickSession(args.get("--session"), hereSession(here, cloud), cloud);
  // One back per session at a time, however it was started (phone, /nomo-cc:back, a terminal).
  if (!takeBackLock(uuid)) {
    throw new Error(`session ${uuid} is already being brought back (pid ${backLockHolder(uuid) ?? "?"}); let that finish.`);
  }
  process.once("exit", () => releaseBackLock(uuid)); // every exit path, incl. the SIGINT handler's
  // NOM-99: this run's outcome for the phone row, whoever started it; anything but a finish is FAILED.
  let outcome: "done" | "failed" | "gone" = "failed";
  process.once("exit", () => { if (outcome !== "gone") writeBackResult(uuid, outcome); });
  // /nomo-cc:back from the parked window itself (NOM-90) lands the box copy under it: the user then types
  // /resume <id> there. Only a window parked as "cloud" (gated since the move, so it cannot have diverged
  // except through Nomo's own commands) qualifies. From anywhere else it opens a new Terminal, as before.
  const parkedAtStart = readPark(uuid);
  const sameWindow = here === uuid;
  if (sameWindow && parkedAtStart?.state === "landing") {
    // The box copy is already pulled and staged; only the install (at this turn's end) is left.
    if (!parkedAtStart.staged || !existsSync(parkedAtStart.staged)) {
      clearPark(uuid);
      throw new Error(`the staged box copy is gone; unparked this window. The pulled copy is under ${join(CC_DIR, "cloud-back")}.`);
    }
    // No marker write here: the hook may have just installed it ("back"), which must not go back to landing.
    console.log(`The box's copy is staged; it goes in as this turn ends.\n\n${sameWindowBackLine(parkedAtStart.resume ?? uuid)}`);
    outcome = "done";
    return;
  }
  if (sameWindow && parkedAtStart?.state !== "cloud") {
    throw new Error(`this Claude Code session is ${uuid} itself and is not parked. Run /nomo-cc:back from another session; it resumes in a new Terminal window.`);
  }
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
  // A window parked as "cloud" is gated, so it can stay open (it is told to close once this lands).
  if (parkedAtStart?.state !== "cloud" && rec && typeof rec.pid === "number" && pidAlive(rec.pid)) {
    throw new Error(`session ${uuid} is running on this Mac (pid ${rec.pid}). Quit it there first, then rerun --back.`);
  }
  const enc = projectDirName(cwd);
  const sb = await getBox(omg, cloud.sandboxId);
  if (!sb) {
    outcome = "gone";
    console.log(boxGone(uuid));
    process.exitCode = 1;
    return;
  }
  const id = await wakeBox(omg, sb);

  // 1. A turn boundary (or --force, which interrupts instead of waiting).
  let gone = false;
  const other = (out: string) => {
    if (/^NOMO_OTHER$/m.test(out)) {
      throw new Error(`the box holds no session ${uuid} (already brought back, or handed off before 2.3.12 and since replaced); nothing was stopped.\n` +
        `--status lists the box's sessions; rerun with --force to stop and pack whatever is at its folder anyway.`);
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
  const caps = backCaps(snap?.tBytes);
  const capOf = (name: string) => (name === "project.tgz" ? caps.project : caps.artifact);
  for (const [name, size] of Object.entries(sizes)) {
    if (size > capOf(name)) {
      throw new Error(`${name} on the box is ${(size / 1e6).toFixed(0)} MB, over this session's ${(capOf(name) / 1e6).toFixed(0)} MB cap. ` +
        `Nothing was pulled and nothing changed on this Mac. Claude Code on the box was stopped; the session and all its work ` +
        `stay on box ${id} (it sleeps on its own; files are kept 14 days asleep).`);
    }
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
    // base64 is 4/3 of the cap, plus slack for the JSON around it.
    const r = await api(omg, "GET", `/sandboxes/${id}/files?path=${encodeURIComponent(`${backPrefix(uuid)}-${name}`)}`, undefined, Math.ceil(capOf(name) * 4 / 3) + 65_536);
    const bytes = Buffer.from(r?.content ?? "", "base64");
    if (bytes.length !== sizes[name]) throw new Error(`pulled ${name}: ${bytes.length} B, the box reported ${sizes[name]} B`);
    writeFileSync(join(backup, name), bytes, { mode: 0o600 });
  }
  console.log(`Pulled the box's work into ${backup}`);
  // Its work is home: drop the pack and the marker; the box sleeps only when no other session runs.
  const done = await exec(omg, id, `${boxPrelude(uuid)}\nrm -f ${backPrefix(uuid)}-* "$SD/"${q(uuid)}\n[ "$(head -c 64 ${BOX_CURRENT} 2>/dev/null)" != ${q(uuid)} ] || rm -f ${BOX_CURRENT}\n${LEFT_LINE}`).catch(() => undefined);
  const left = parseLeft(done?.stdout ?? "");
  if (left === 0) await sleepBox(omg, { id, status: "running" });
  else console.log(left ? `The box stays awake for ${left} other running session(s).` : "The box sleeps once no session runs on it.");

  // 4. Apply: transcript, memory, code. Every tar is untrusted (core/cloud-back.ts).
  phase = "landing the box's work on this Mac";
  const problems: string[] = [];
  const budget = { left: caps.extracted };
  const paths = (ps: string[]) => ps.map((p) => printable(p, true)).join(", ");
  /** One artifact that will not unpack (a bad entry, a cap) is reported and skipped; the rest still land. */
  const unpack = (name: string): string | undefined => {
    try { return extractTgz(join(backup, name), backup, capOf(name), name === "project.tgz" ? caps.extracted : undefined); } catch (e: any) {
      problems.push(`${name} could not be unpacked, so it was NOT applied (${printable((e.stderr?.toString() || e.message || String(e)).trim(), true).slice(0, 300)}); it is kept in ${backup}`);
    }
  };
  const projDir = mkdirp(join(process.env.HOME!, ".claude", "projects", enc));
  const pdir = unpack("project.tgz");
  const pt = pdir
    ? validateTree(pdir, (r) => r === `${uuid}.jsonl` || r === uuid || r.startsWith(`${uuid}/`) || r === "memory" || r.startsWith("memory/"), budget)
    : { files: [], skipped: [] };
  if (pt.skipped.length) console.log(`Skipped ${pt.skipped.length} unexpected path(s) in the box's project files: ${paths(pt.skipped)}`);
  let resumeId = uuid, stagedThisRun: string | undefined;
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
      for (const r of sub) copyContained(join(pdir, r), projDir, r, true, true);
      if (sameWindow) {
        // This window is mid-turn (this command): the rest of the turn would append onto the box copy.
        // The park hook installs it at the turn's end (core/park.ts).
        const staged = `${macPath}.nomo-back`;
        atomicWriteBytes(staged, boxT);
        stagedThisRun = staged;
        const now = stageLanding(uuid, { staged, target: macPath, resume: uuid }, startedAt);
        console.log(`Transcript: the box's copy (+${boxT.length - (macT?.length ?? 0)} B) ${now ? "is installed" : "goes in as this turn ends"}; the Mac's previous copy is in ${before}`);
      } else {
        atomicWriteBytes(macPath, boxT);
        console.log(`Transcript: installed the box's copy (+${boxT.length - (macT?.length ?? 0)} B); the Mac's previous copy is in ${before}`);
      }
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

  updateCloud((c) => {
    const { [uuid]: _done, ...sessions } = c.sessions ?? {};
    return { ...c, sessions, active: (c.active ?? []).filter((s) => s !== uuid) };
  });

  // 5. Resume here.
  let parked = readPark(uuid);
  if (sameWindow && stagedThisRun && parked?.state !== "landing" && parked?.state !== "back" && existsSync(stagedThisRun)) {
    // A hook's stamp raced the "landing" write: stage again (installs now if the window is idle), never
    // report Back with the box copy orphaned next to the transcript.
    stageLanding(uuid, { staged: stagedThisRun, target: join(projDir, `${uuid}.jsonl`), resume: uuid }, startedAt);
    parked = readPark(uuid);
  }
  if (sameWindow) {
    if (parked?.state !== "landing" && parked?.state !== "back") {
      if (resumeId !== uuid) writePark(uuid, { state: "back", resume: resumeId });
      else clearPark(uuid);
    }
  } else if (parkedAtStart?.state === "cloud" && typeof parkedAtStart.pid === "number" && pidAlive(parkedAtStart.pid)) {
    writePark(uuid, { state: "elsewhere", pid: parkedAtStart.pid });
  } else clearPark(uuid);
  outcome = "done"; // the work landed; anything below is reporting
  if (sameWindow) {
    console.log(`\n${sameWindowBackLine(resumeId)}`);
    if (problems.length) {
      console.log(`\nNeeds a look:\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
    }
    return;
  }
  let model: string | undefined;
  try { model = lastModel(readFileSync(join(projDir, `${resumeId}.jsonl`), "utf8")); } catch { /* no transcript: CC picks */ }
  const line = resumeCommand(cwd, resumeId, model);
  console.log(`\nResume on this Mac:\n  ${line.replace(" && exec ", " && ")}`);
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

/** The "Cloud check:" block for the project at `cwd` (its repo root when git). Never throws, never blocks. */
function readiness(cwd: string): string | undefined {
  try {
    let root = cwd;
    try { root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* not git */ }
    return cloudReadiness(root, { home: process.env.HOME!, cwd, git: gitProbe(root) });
  } catch { return undefined; }
}

/** Mac files under <projDir>/<dir>/ as paths relative to projDir. */
function listUnder(projDir: string, dir: string): string[] {
  return listFiles(join(projDir, dir)).map((r) => join(dir, r));
}

// ------------------------------------------------------------------- /nomo-cc:handoff (core/handoff-later.ts)

const SELF = fileURLToPath(import.meta.url);
// --later: the foreground's placeholder claim; --after-exit: the helper. A reused pid matches neither.
const PENDING = { path: PENDING_PATH, isHelper: (pid: number) => pidAlive(pid) && /handoff.*--(after-exit|later)(\s|$)/.test(pidCommand(pid) ?? "") };

/** Foreground preflight (local only), then the detached helper that hands off once this session exits. */
async function later(args: Map<string, string | true>, keys: { omg?: string; openrouter?: string }, worker: string): Promise<void> {
  if (args.has("--phone")) return phoneLater(args, keys, worker);
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
  const arg = parseLaterArg(args.has("--args-stdin") ? readFileSync(0, "utf8") : "");
  if (!arg) { console.log(LATER_USAGE); process.exitCode = 1; return; }
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
  // NOM-103: before anything is parked or started, so a refusal leaves the window as it was.
  const inTranscript = secretSummary(scanHandoff(join(home, ".claude", "projects", projectDirName(cwd)), session), session);
  if (inTranscript && !arg.anyway) { console.log(transcriptSecretWarning(inTranscript, false)); process.exitCode = 1; return; }
  if (needsPairing(loadCloud(), worker)) {
    console.log(`Your cloud box needs a one-time pairing (a QR scan), which can't happen in the background. Nothing was started.\n` +
      `Quit Claude Code (/exit), then run this in a terminal:\n  cd ${q(cwd)} && ${q(process.execPath)} ${q(SELF)} --session ${session}` +
      `${worker === DEFAULT_WORKER_URL ? "" : ` --worker ${worker}`}\nAfter that, /nomo-cc:handoff works from inside Claude Code.`);
    process.exitCode = 1;
    return;
  }
  if (!arm(session, claudePid, cwd, arg.message, worker)) return;
  console.log(`Ready. Session ${session} moves to the cloud as soon as this turn ends; watch it on your phone.\n` +
    `This window stays open but parked: new prompts are blocked until you run /nomo-cc:back here.\n` +
    (arg.message ? `First message on the box: "${arg.message}"` : "No first message (quiet).") +
    `\nLog: ${LATER_LOG}\nTo stop it: /nomo-cc:handoff cancel`);
  let warn: string | undefined;
  try { warn = sizeWarning(contextTokensOf(join(home, ".claude", "projects", projectDirName(cwd), `${session}.jsonl`))); } catch { /* estimate only */ }
  if (warn) console.log(warn);
  const ready = readiness(cwd);
  if (ready) console.log(ready);
  if (inTranscript) console.log(transcriptSecretWarning(inTranscript, true));
}

/** Claim the pending slot, park the window "moving" and start the detached helper. False (message
 *  printed) when another handoff already holds the slot. */
function arm(session: string, claudePid: number, cwd: string, message: string | undefined, worker: string): boolean {
  mkdirSync(CC_DIR, { recursive: true, mode: 0o700 });
  const p: Pending = { helperPid: process.pid, session, claudePid, state: "waiting", startedAt: Date.now(), message };
  if (!claimPending(PENDING, p)) {
    const cur = readPending(PENDING_PATH);
    console.log(`A handoff is already waiting (session ${cur?.session ?? "?"}). See /nomo-cc:handoff status, or /nomo-cc:handoff cancel.`);
    return false;
  }
  writePark(session, { state: "moving", pid: claudePid });
  const fd = openSync(LATER_LOG, "w", 0o600);
  const child = spawn(process.execPath, [SELF, "--after-exit", "--session", session, "--claude-pid", String(claudePid), "--worker", worker],
    { cwd, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  writeFileSync(PENDING_PATH, JSON.stringify({ ...p, helperPid: child.pid }) + "\n", { mode: 0o600 });
  return true;
}

/** NOM-94: the phone's "Move to cloud", run by the watchdog (no turn of the window behind it). Every
 *  refusal exits non-zero (the row then reads cloud:"move-failed"); a busy slot too. The first message
 *  is always the default one: the phone sends no text. */
async function phoneLater(args: Map<string, string | true>, keys: { omg?: string; openrouter?: string }, worker: string): Promise<void> {
  const session = args.get("--session");
  if (typeof session !== "string" || !UUID_RE.test(session)) throw new Error("--phone needs --session <uuid>");
  if (!keys.omg || !keys.openrouter) throw new Error("OMG_API_KEY and OPENROUTER_API_KEY must be set (env or ~/.nomo-spike.env)");
  const home = process.env.HOME!;
  rmSync(moveResultFile(session), { force: true }); // this run's outcome only (NOM-99)
  const refuse = (why: MoveWhy, msg: string): never => { writeMoveResult(session, false, undefined, why); throw new Error(`not moving ${session}: ${msg}.`); };
  const cloud = loadCloud();
  const ok = phoneMoveCheck({
    record: await readRecord(session),
    command: (pid) => (pidAlive(pid) ? pidCommand(pid) : undefined),
    ancestorsOf: pidAncestors,
    parked: readPark(session) !== undefined,
    active: cloudActive(session),
    needsPairing: needsPairing(cloud, worker),
    cloudCount: cloud.active?.length ?? 0,
    transcriptExists: (cwd) => existsSync(join(home, ".claude", "projects", projectDirName(cwd), `${session}.jsonl`)),
    trackedSecrets: trackedSecretFiles,
    transcriptSecrets: (cwd) => secretSummary(scanHandoff(join(home, ".claude", "projects", projectDirName(cwd)), session), session),
  });
  if ("refuse" in ok) return refuse(ok.why, ok.refuse);
  let root: string | undefined;
  try { root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ok.cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* not git */ }
  const refusal = root ? packRefusal(root, home, () => false) : packRefusal(ok.cwd, home);
  if (refusal) return refuse("secret", refusal);
  if (!arm(session, ok.claudePid, ok.cwd, DEFAULT_THEN, worker)) { writeMoveResult(session, false, undefined, "busy"); process.exitCode = 1; return; }
  const now = await settleThenStamp(session, { readRecord: () => readRecord(session), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  console.log(`Armed. Session ${session} moves to the cloud ${now ? "now (it was idle)" : "when its current turn ends"}. Log: ${LATER_LOG}`);
}

/** The detached helper spawned by later(). */
async function afterExit(args: Map<string, string | true>, worker: string): Promise<void> {
  const session = String(args.get("--session")), claudePid = Number(args.get("--claude-pid"));
  if (!UUID_RE.test(session) || !(claudePid > 1)) throw new Error("--after-exit needs --session <uuid> --claude-pid <pid>");
  let pending = readPending(PENDING_PATH); // wait out later()'s rewrite naming this helper (a torn read is undefined)
  for (let i = 0; i < 30 && pending?.helperPid !== process.pid; i++) { await new Promise((r) => setTimeout(r, 100)); pending = readPending(PENDING_PATH); }
  const message = pending?.session === session ? pending.message : undefined; // from the 0600 record, never argv
  process.exitCode = await waitThenHandoff({ helperPid: process.pid, session, claudePid, state: "waiting", startedAt: Date.now(), message }, {
    pending: PENDING_PATH,
    parkDir: PARK_DIR,
    result: (ok, why) => writeMoveResult(session, ok, undefined, why),
    alive: pidAlive,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    readCloud: loadCloud,
    runHandoff: () => new Promise((res, rej) => {
      const argv = handoffArgv({
        runtime: process.execPath, self: SELF, shim: `${CC_DIR}/hook-shim.sh`, args: ["--session", session, "--worker", worker], exists: existsSync,
      });
      if (!argv) return rej(new Error(GONE_MSG));
      spawn(argv[0], argv.slice(1), { stdio: "inherit", env: { ...process.env, NOMO_HANDOFF_HELPER: "1", ...(message ? { NOMO_THEN: message } : {}) } })
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
    if (["--session", "--model", "--send", "--send-key", "--then", "--worker", "--claude-pid", "--from-session"].includes(a)) args.set(a, argv[++i] ?? "");
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

  if (args.has("--check")) { console.log(readiness(process.cwd()) ?? "Cloud check: couldn't run here."); return; }

  // --then: argv from a terminal, NOMO_THEN env from the /nomo-cc:handoff helper; unset so no child inherits it.
  const then = (typeof args.get("--then") === "string" ? String(args.get("--then")) : process.env.NOMO_THEN ?? "").replace(/\r\n?/g, "\n");
  delete process.env.NOMO_THEN;
  if (args.has("--then") && !then.trim()) throw new Error('usage: --then "<first message for the cloud session>"');
  if (args.has("--send") && !String(args.get("--send")).trim()) throw new Error('usage: --send "<text>" (use --send-key Enter for a bare Enter)');
  const keys = readKeys();
  const worker = targetWorker(args.get("--worker"), process.env.NOMO_WORKER_URL);

  if (args.has("--later-cancel")) {
    // The helper is a detached group leader: -pid also stops a handoff child it raced into starting.
    const session = args.get("--session");
    console.log(cancelPending({
      ...PENDING, kill: (p) => { try { process.kill(-p, "SIGTERM"); } catch { process.kill(p, "SIGTERM"); } }, log: LATER_LOG, parkDir: PARK_DIR,
      session: typeof session === "string" && UUID_RE.test(session) ? session : undefined,
    }));
    return;
  }
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
  if (args.has("--box-health")) { await boxHealth(omg); return; }

  if (["--status", "--stop", "--pair", "--screen", "--send", "--send-key"].some((f) => args.has(f))) {
    const cloud = loadCloud();
    const sb = await getBox(omg, cloud.sandboxId, api, { wake: false }); // read-only: a stopped box stays stopped
    if (!sb) { console.log("No cloud box. Run `handoff` to create one."); return; }
    const here = hereSession(args.get("--from-session") || process.env.CLAUDE_CODE_SESSION_ID, cloud);
    if (args.has("--stop")) {
      // --all, or bare with at most one session on record: sleep the whole box (sessions resume on wake).
      if (args.has("--all") || (!args.has("--session") && !here && (cloud.active ?? []).length <= 1)) { await sleepBox(omg, sb); return; }
      const uuid = pickSession(args.get("--session"), here, cloud);
      if (sb.status !== "running") { console.log(`Box ${sb.id} is ${sb.status}: session ${uuid} is not running.`); return; }
      console.log(await stopOne(uuid, (script, env) => exec(omg, sb.id, script, env), () => sleepBox(omg, sb), args.has("--force")));
      return;
    }
    if (sb.status !== "running") { console.log(`Box ${sb.id} is ${sb.status}. Run handoff to wake it.`); return; }
    if (args.has("--screen") || args.has("--send") || args.has("--send-key")) {
      const key = String(args.get("--send-key") ?? "");
      if (args.has("--send-key") && !/^[A-Za-z0-9-]+$/.test(key)) throw new Error("--send-key takes one tmux key name, e.g. Escape, BTab, C-c, Enter");
      const mode = args.has("--send") ? "send" : args.has("--send-key") ? "key" : "screen";
      const uuid = pickSession(args.get("--session"), here, cloud);
      const r = await exec(omg, sb.id, paneScript(mode, uuid), { NOMO_TEXT: String(args.get("--send") ?? ""), NOMO_KEY: key });
      process.stdout.write((r.stdout ?? "").replace(/^NOMO_(SENT|UNCONFIRMED|BUSY)\n?/m, ""));
      if (mode === "key" && r.exitCode === 0) console.log("Sent. Check with --screen.");
      if (mode === "send") { const m = sendResult(r.stdout ?? ""); if (m) console.log(m); }
      if (r.exitCode !== 0) process.exitCode = 1;
      return;
    }
    if (args.has("--pair")) {
      const r = await exec(omg, sb.id, `${SHM_SWEEP}\n${PAIR_FN}\nnomo_pair`, { NOMO_WORKER_URL: worker });
      if (/^NOMO_PAIRED$/m.test(r.stdout ?? "")) console.log(`Box ${sb.id} is already paired ✓`);
      await afterPair(omg, sb.id, r.stdout ?? "", worker);
      return;
    }
    console.log(`Box ${sb.id}: ${sb.status}${sb.keepAwakeUntil ? `, keep-awake until ${sb.keepAwakeUntil}` : ""}`);
    const r = await exec(omg, sb.id, statusScript(), { NOMO_KNOWN: (cloud.active ?? []).join(" ") });
    const [sessions, nomo = ""] = (r.stdout ?? "").split(/^NOMO_STATUS_SPLIT$\n?/m);
    process.stdout.write(sessions); // the box's sessions first: id, running/stopped, root
    console.log((cloud.active ?? []).length ? `On record on this Mac (not brought back yet):\n${listActive(cloud)}` : "On record on this Mac: none.");
    console.log(attachHelp((cloud.active ?? []).length > 1));
    console.log(`\nTarget worker: ${worker}`);
    process.stdout.write(nomo);
    return;
  }

  if (!keys.openrouter) throw new Error("OPENROUTER_API_KEY not set (env or ~/.nomo-spike.env)");
  // The work dir holds the transcript, repo bundle, patch and untracked files: gone once uploaded.
  const out = mkdtempSync(join(tmpdir(), "nomo-handoff-"));
  let plan: Plan, id: string;
  try {
    plan = build(args, out);
    console.log(`Handing off session ${plan.uuid} (${plan.model}) from ${plan.cwd} · Nomo worker ${worker}`);
    if (plan.warn) console.log(plan.warn);
    const ready = readiness(plan.cwd);
    if (ready) console.log(ready);
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
    NOMO_KNOWN: (loadCloud().active ?? []).join(" "), // nomo_prune: what this Mac has not brought back yet
    ...plan.gitUser,
    ...(args.has("--force") ? { NOMO_FORCE: "1" } : {}),
  });
  const pane = takePairUrl(r.stdout ?? "").rest.replace(/^NOMO_(PAIRED|PAIR_FAILED: .*|REPAIR: .*)$\n?/gm, ""); // never echo the QR URL
  if (r.exitCode === 4) throw new Error(`the OpenRouter relay did not start on box ${id}:\n${pane.slice(-1000)}`);
  if (r.exitCode === 3) throw new Error(busyMessage(r.stdout ?? "", id, plan.uuid, plan.root));
  if (r.exitCode === 5) throw new Error(`the box run took so long its key file was swept before launch; nothing was started. Rerun the handoff.`);
  if (r.exitCode !== 0 || /No conversation found|API Error|Invalid API key|command not found/i.test(pane)) {
    throw new Error(`box start failed (exit ${r.exitCode}):\n${pane.slice(-2000)}\n${(r.stderr ?? "").slice(-2000)}`);
  }
  await api(omg, "POST", `/sandboxes/${id}/extend`, { seconds: KEEPALIVE_S }).catch(() => {}); // the in-VM loop renews after this
  const { active = [] } = updateCloud((c) => ({
    ...c, active: [...(c.active ?? []).filter((s) => s !== plan.uuid), plan.uuid], sessions: { ...c.sessions, [plan.uuid]: plan.snap },
  }));

  console.log(pane.trimEnd().split("\n").slice(-15).join("\n"));
  console.log(`\nSession ${plan.uuid} is running on cloud box ${id} (tmux session "${tmuxName(plan.uuid)}"${active.length > 1 ? `; ${active.length} sessions on record` : ""}).`);
  if (then.trim()) console.log(await sendFirstMessage((script, env) => exec(omg, id, script, env), then, plan.uuid));
  console.log(attachHelp(active.length > 1));
  console.log(`  Status: --status   Stop it: --stop${active.length > 1 ? " --session <id> (or --all)" : ""}   Bring it back to this Mac: --back${active.length > 1 ? " --session <id>" : ""}`);
  if (!process.env.NOMO_HANDOFF_HELPER) console.log(`\n!! Quit your local Claude Code session for ${plan.uuid} now, so the two copies don't diverge.`);
  await afterPair(omg, id, r.stdout ?? "", worker);
}

if (import.meta.main) {
  main().catch((e) => { console.error(`handoff: ${e.message ?? e}`); process.exit(e?.exitCode === EXIT_BOX_GONE ? EXIT_BOX_GONE : 1); });
}
