// activity — NOM-142 daily activity summary. Reads each agent's LOCAL history (Claude Code transcripts,
// Codex rollouts + its SQLite state, OpenCode's SQLite db), folds it into per-(local day, agent) rows
// of COUNTS ONLY, and uploads the rows E2E-sealed through the blind /v1/cc/full slot. Driven by the
// watchdog (startActivityLoop): once at start, then hourly; an upload needs changed rows AND ≥6 h since
// the last one — except the first upload to a NEW pairing (re-pair), which goes out within a minute.
//
// PRIVACY: an event carries a timestamp, a session id, a kind, a model id and token counts — never
// prompt or reply text (a user line's text is looked at only to tell a real prompt from a tool echo).
// What leaves the Mac: per day+agent session/turn counts, a 5-minute activity bitmap and per-model
// token sums, sealed with the pairing's e2eKey. No project names or paths (`p` is reserved, unsent).
//
// IDEMPOTENCE: every event has a stable id (CC message.id+requestId, Codex turn_id / cumulative token
// total, OpenCode message id). A HOT row (day within HOT_DAYS) keeps the short hashes of the ids and
// session ids it counted, so re-reading a line — a shrunk/replaced file, a crashed run, CC copying
// history into a resumed transcript — never counts twice. Older rows are FROZEN (hashes dropped) and
// accept no more events; a day with no row yet is accepted (nothing was counted for it), then frozen at
// the end of the run. The cursor only saves work; correctness never depends on it.
//
// TOKENS: i = uncached input, cr = cache read, cw = cache write, o = output EXCLUDING reasoning,
// r = reasoning output (omitted when 0). o + r = all output tokens for every agent.
//
// FAILURE: every reader is wrapped — an unknown schema, a corrupt line or a missing runtime feature
// skips that line/agent, never the watchdog. PORTABLE: runs under node or bun (no Bun.* globals).

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as zlib from "node:zlib";
import { encryptBlob } from "./crypto";
import { atomicWrite, CC_DIR, codexHome, Config, loadConfig, PLUGIN_VERSION } from "./shared";

export type ActivityAgent = "claude" | "codex" | "opencode";
export interface Tokens { i: number; o: number; cw: number; cr: number; r?: number }
export interface ActivityEvent {
  ts: number; agent: ActivityAgent; sessionId: string; kind: "turn" | "assistant"; id: string;
  model?: string; tokens?: Tokens;
}

export const HOT_DAYS = 40; // > CC's 30-day transcript retention
export const MAX_DAYS = 400;
const HOUR_MS = 3_600_000;
export const UPLOAD_EVERY_MS = 6 * HOUR_MS;
const CHUNK = 2 * 1024 * 1024;
const SAVE_EVERY_BYTES = 256 * 1024 * 1024;
const MAX_PAYLOAD_CHARS = 900_000; // the relay refuses blobs over 1.4 M base64 chars

export const ACTIVITY_DAYS_PATH = `${CC_DIR}/activity-days.json`;
export const ACTIVITY_CURSOR_PATH = `${CC_DIR}/activity-cursor.json`;

// --- day rows ----------------------------------------------------------------------------------

interface Row {
  d: string; a: ActivityAgent; s: number; t: number; bits: Uint8Array; u: Record<string, Tokens>;
  k?: Set<string>; ss?: Set<string>; // present ⇔ hot
}
/** lastPairing = the pairingId the last upload went to; the relay keeps the blob PER PAIRING. */
export interface State { lastUpload: number; lastHash: string; lastPairing: string; rows: Map<string, Row> }

export const emptyState = (): State => ({ lastUpload: 0, lastHash: "", lastPairing: "", rows: new Map() });

const h12 = (s: string) => createHash("sha1").update(s).digest("base64").slice(0, 12);
const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD in the Mac's local timezone. */
export function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Fold one event in. Returns whether it counted (false = duplicate, frozen day or bad ts). */
export function addEvent(state: State, ev: ActivityEvent): boolean {
  if (!Number.isFinite(ev.ts)) return false;
  const d = localDate(ev.ts);
  const key = `${d}|${ev.agent}`;
  let row = state.rows.get(key);
  if (!row) {
    row = { d, a: ev.agent, s: 0, t: 0, bits: new Uint8Array(36), u: {}, k: new Set(), ss: new Set() };
    state.rows.set(key, row);
  }
  if (!row.k || !row.ss) return false; // frozen
  const id = h12(ev.id);
  if (row.k.has(id)) return false;
  row.k.add(id);
  if (ev.sessionId) { row.ss.add(h12(ev.sessionId)); row.s = row.ss.size; }
  if (ev.kind === "turn") row.t++;
  if (ev.tokens) {
    const m = (row.u[ev.model || "unknown"] ??= { i: 0, o: 0, cw: 0, cr: 0 });
    m.i += ev.tokens.i; m.o += ev.tokens.o; m.cw += ev.tokens.cw; m.cr += ev.tokens.cr;
    if (ev.tokens.r) m.r = (m.r ?? 0) + ev.tokens.r;
  }
  const t = new Date(ev.ts);
  const slot = t.getHours() * 12 + Math.floor(t.getMinutes() / 5); // 0..287, MSB-first in each byte
  row.bits[slot >> 3] |= 0x80 >> (slot & 7);
  return true;
}

/** Drop dedupe state from rows older than HOT_DAYS (they accept nothing more) and rows past MAX_DAYS. */
export function freeze(state: State, now: number): void {
  const hot = localDate(now - HOT_DAYS * 86_400_000);
  const keep = localDate(now - MAX_DAYS * 86_400_000);
  for (const [key, row] of state.rows) {
    if (row.d < keep) state.rows.delete(key);
    else if (row.d < hot) { delete row.k; delete row.ss; }
  }
}

export function serializeState(state: State): string {
  const days = [...state.rows.values()].map((r) => ({
    d: r.d, a: r.a, s: r.s, t: r.t, b: Buffer.from(r.bits).toString("base64"), u: r.u,
    ...(r.k ? { k: [...r.k], ss: [...r.ss!] } : {}),
  }));
  return JSON.stringify({ v: 1, lastUpload: state.lastUpload, lastHash: state.lastHash, lastPairing: state.lastPairing, days });
}

export function parseState(text: string): State {
  const st = emptyState();
  try {
    const o = JSON.parse(text);
    st.lastUpload = Number(o.lastUpload) || 0;
    st.lastHash = typeof o.lastHash === "string" ? o.lastHash : "";
    st.lastPairing = typeof o.lastPairing === "string" ? o.lastPairing : ""; // absent in older files
    for (const r of o.days ?? []) {
      const bits = new Uint8Array(36);
      bits.set(Buffer.from(String(r.b ?? ""), "base64").subarray(0, 36));
      st.rows.set(`${r.d}|${r.a}`, {
        d: r.d, a: r.a, s: r.s | 0, t: r.t | 0, bits, u: r.u ?? {},
        ...(Array.isArray(r.k) ? { k: new Set<string>(r.k), ss: new Set<string>(r.ss ?? []) } : {}),
      });
    }
  } catch { return emptyState(); }
  return st;
}

/** The exact v1 wire payload (sorted, counts only). */
export function buildPayload(state: State, now: number) {
  const days = [...state.rows.values()]
    .sort((x, y) => (x.d === y.d ? x.a.localeCompare(y.a) : x.d.localeCompare(y.d)))
    .map((r) => ({
      d: r.d, a: r.a, s: r.s, t: r.t, b: Buffer.from(r.bits).toString("base64"),
      u: Object.entries(r.u).map(([m, k]) => ({ m, i: k.i, o: k.o, cw: k.cw, cr: k.cr, ...(k.r ? { r: k.r } : {}) })),
    }));
  while (days.length > 1 && JSON.stringify(days).length > MAX_PAYLOAD_CHARS) days.shift();
  return { v: 1 as const, gen: now, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, days };
}

// --- line parsers (pure) -----------------------------------------------------------------------

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
/** User lines CC writes that are NOT a prompt the person typed (tool/notification echoes). */
const NON_PROMPT = ["<task-notification>", "<bash-stdout>", "<bash-stderr>", "<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>"];

export function parseClaudeLine(line: string): ActivityEvent | null {
  const isA = line.includes('"type":"assistant"');
  if (!isA && !(line.includes('"type":"user"') && line.includes('"userType":"external"'))) return null;
  let o: any;
  try { o = JSON.parse(line); } catch { return null; }
  const ts = Date.parse(o?.timestamp);
  const sid = typeof o?.sessionId === "string" ? o.sessionId : "";
  if (!Number.isFinite(ts)) return null;
  if (o.type === "assistant") {
    const u = o.message?.usage;
    const model = o.message?.model;
    if (!u || typeof u !== "object" || model === "<synthetic>") return null;
    const r = num(u.output_tokens_details?.thinking_tokens);
    return {
      ts, agent: "claude", sessionId: sid, kind: "assistant",
      id: o.message?.id && o.requestId ? `cc:${o.message.id}:${o.requestId}` : `cc:${sid}:${o.timestamp}`,
      model: typeof model === "string" ? model : undefined,
      tokens: {
        i: num(u.input_tokens), o: Math.max(0, num(u.output_tokens) - r),
        cw: num(u.cache_creation_input_tokens), cr: num(u.cache_read_input_tokens), ...(r ? { r } : {}),
      },
    };
  }
  if (o.type !== "user" || o.userType !== "external" || o.isMeta || o.isSidechain || o.isCompactSummary) return null;
  const c = o.message?.content;
  let text: string | undefined;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c) && !c.some((x: any) => x?.type === "tool_result")) text = c.find((x: any) => x?.type === "text")?.text;
  if (typeof text !== "string" || NON_PROMPT.some((p) => text!.startsWith(p))) return null;
  return { ts, agent: "claude", sessionId: sid, kind: "turn", id: `cc:u:${o.uuid ?? `${sid}:${o.timestamp}`}` };
}

/** Per-rollout parse state, persisted in the cursor so an incremental read mid-file still knows the
 *  thread's model and whether it is a subagent (whose "turns" are not the person's). */
export interface CodexFileState { sid: string; m?: string; sub?: 1; parent?: string }

export function parseCodexLine(line: string, st: CodexFileState): ActivityEvent | null {
  if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"task_started"') && !line.includes('"token_count"')) return null;
  let o: any;
  try { o = JSON.parse(line); } catch { return null; }
  const p = o?.payload;
  if (!p || typeof p !== "object") return null;
  if (o.type === "session_meta") {
    const src = p.source;
    if (src && typeof src === "object" && src.subagent) {
      st.sub = 1;
      const parent = src.subagent?.thread_spawn?.parent_thread_id;
      if (typeof parent === "string") st.parent = parent;
    }
    return null;
  }
  if (o.type === "turn_context") { if (typeof p.model === "string") st.m = p.model; return null; }
  if (o.type !== "event_msg") return null;
  const ts = Date.parse(o.timestamp);
  if (!Number.isFinite(ts)) return null;
  const sessionId = st.sub ? (st.parent ?? "") : st.sid;
  if (p.type === "task_started" && !st.sub) {
    return { ts, agent: "codex", sessionId, kind: "turn", id: `cx:t:${p.turn_id ?? `${st.sid}:${o.timestamp}`}` };
  }
  if (p.type === "token_count") {
    const last = p.info?.last_token_usage;
    const total = p.info?.total_token_usage?.total_tokens;
    if (!last || typeof total !== "number") return null;
    const cached = num(last.cached_input_tokens);
    const r = num(last.reasoning_output_tokens);
    return {
      ts, agent: "codex", sessionId, kind: "assistant", id: `cx:u:${st.sid}:${total}`, model: st.m,
      tokens: {
        i: Math.max(0, num(last.input_tokens) - cached), o: Math.max(0, num(last.output_tokens) - r),
        cw: num(last.cache_write_input_tokens), cr: cached, ...(r ? { r } : {}),
      },
    };
  }
  return null;
}

// --- incremental file scanning -----------------------------------------------------------------

export interface CursorEntry { ino: number; offset: number; cx?: CodexFileState }
export type Cursor = Record<string, CursorEntry>;

const breathe = () => new Promise((r) => setTimeout(r, 5)); // low priority: let the 5 s poll run
const hasZstd = typeof (zlib as any).zstdDecompressSync === "function";

/** Read the unread tail of one JSONL (or a whole .jsonl.zst) and feed complete lines to `onLine`.
 *  Re-reads from 0 when the inode changed or the file shrank. Returns bytes read. */
export async function scanFile(path: string, cursor: Cursor, onLine: (line: string, e: CursorEntry) => void): Promise<number> {
  const st = await stat(path);
  const prev = cursor[path];
  const same = prev && prev.ino === st.ino && st.size >= prev.offset;
  const entry: CursorEntry = same ? prev : { ino: st.ino, offset: 0, ...(prev?.cx ? { cx: { sid: prev.cx.sid } } : {}) };
  if (path.endsWith(".zst")) {
    if (same && prev.offset === st.size) return 0;
    const text = (zlib as any).zstdDecompressSync(await readFile(path)).toString("utf8") as string;
    entry.offset = 0;
    for (const line of text.split("\n")) if (line) onLine(line, entry);
    entry.offset = st.size;
    cursor[path] = entry;
    return st.size;
  }
  if (entry.offset >= st.size) { cursor[path] = entry; return 0; }
  let carry: Buffer = Buffer.alloc(0);
  let consumed = entry.offset;
  const stream = createReadStream(path, { start: entry.offset, end: st.size - 1, highWaterMark: CHUNK });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const buf: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const nl = buf.lastIndexOf(10);
    if (nl < 0) { carry = buf; continue; }
    for (const line of buf.subarray(0, nl).toString("utf8").split("\n")) if (line) onLine(line, entry);
    consumed += nl + 1;
    carry = buf.subarray(nl + 1);
    await breathe();
  }
  entry.offset = consumed; // a trailing partial line waits for the next scan
  cursor[path] = entry;
  return st.size - (prev && same ? prev.offset : 0);
}

async function listFiles(dir: string, match: (name: string) => boolean): Promise<string[]> {
  try {
    const names = (await readdir(dir, { recursive: true })) as string[];
    return names.filter(match).map((n) => `${dir}/${n}`);
  } catch { return []; }
}

// --- read-only SQLite (bun:sqlite or node:sqlite, whichever runtime we are) ----------------------

interface RoDb { all(sql: string, ...params: unknown[]): any[]; close(): void }

export async function openReadOnly(path: string): Promise<RoDb | null> {
  if (!existsSync(path)) return null;
  const isBun = typeof (globalThis as any).Bun !== "undefined";
  const spec = isBun ? "bun:sqlite" : "node:sqlite"; // computed: keep the bundler from resolving it
  let mod: any;
  try { mod = await import(spec); } catch { return null; }
  for (const opt of ["mode=ro", "immutable=1"]) {
    try {
      const db = isBun
        ? new mod.Database(`file:${path}?${opt}`, { readonly: true })
        : new mod.DatabaseSync(new URL(`file://${path}?${opt}`), { readOnly: true });
      db.prepare("select 1").all();
      return { all: (sql, ...params) => db.prepare(sql).all(...params), close: () => db.close() };
    } catch { /* try the next open mode */ }
  }
  return null;
}

// --- per-agent readers -------------------------------------------------------------------------

export interface Roots { claude: string; codex: string; opencode: string }
export const defaultRoots = (): Roots => ({
  claude: `${process.env.HOME}/.claude/projects`,
  codex: codexHome(),
  opencode: `${process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`}/opencode/opencode.db`,
});

type Sink = (ev: ActivityEvent) => void;
type Progress = (bytes: number) => Promise<void>;

async function readClaude(root: string, cursor: Cursor, sink: Sink, progress: Progress, seen: Set<string>): Promise<void> {
  for (const f of await listFiles(root, (n) => n.endsWith(".jsonl"))) {
    seen.add(f);
    try {
      await progress(await scanFile(f, cursor, (line) => { const ev = parseClaudeLine(line); if (ev) sink(ev); }));
    } catch { /* unreadable file: skip */ }
  }
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/;

async function readCodex(home: string, cursor: Cursor, sink: Sink, progress: Progress, seen: Set<string>, sinceMs: number): Promise<void> {
  const readable = (n: string) => /rollout-.*\.jsonl$/.test(n) || (hasZstd && /rollout-.*\.jsonl\.zst$/.test(n));
  const files = [...await listFiles(`${home}/sessions`, readable), ...await listFiles(`${home}/archived_sessions`, readable)];
  for (const f of files) {
    seen.add(f);
    const sid = f.match(UUID_RE)?.[1] ?? f;
    try {
      await progress(await scanFile(f, cursor, (line, e) => {
        e.cx ??= { sid };
        const ev = parseCodexLine(line, e.cx);
        if (ev) sink(ev);
      }));
    } catch { /* skip */ }
  }
  // BACKFILL for threads whose rollout we cannot read (deleted, or .zst on a runtime without zstd):
  // one token event per thread (tokens_used is a lifetime total, filed under input — the only split
  // the table keeps) plus its turns. Rollout-backed threads never come through here, so no overlap.
  const state = await openReadOnly(`${home}/state_5.sqlite`);
  if (!state) return;
  try {
    const orphans = new Map<string, any>();
    for (const t of state.all("select id, rollout_path, created_at, tokens_used, model, source from threads where created_at >= ?", Math.floor(sinceMs / 1000))) {
      const p = String(t.rollout_path ?? "");
      const base = p.replace(/\.zst$/, "");
      if ((existsSync(base)) || (hasZstd && existsSync(`${base}.zst`))) continue;
      orphans.set(t.id, t);
      const sub = String(t.source ?? "").includes("subagent");
      sink({
        ts: Number(t.created_at) * 1000, agent: "codex", sessionId: sub ? "" : t.id, kind: "assistant", id: `cx:th:${t.id}`,
        model: t.model ?? undefined, tokens: { i: num(t.tokens_used), o: 0, cw: 0, cr: 0 },
      });
    }
    if (orphans.size === 0) return;
    const hist = await openReadOnly(`${home}/thread_history_1.sqlite`);
    if (!hist) return;
    try {
      for (const r of hist.all("select thread_id, turn_id, started_at from thread_turns where started_at >= ?", Math.floor(sinceMs / 1000))) {
        const t = orphans.get(r.thread_id);
        if (!t || String(t.source ?? "").includes("subagent")) continue;
        sink({ ts: Number(r.started_at) * 1000, agent: "codex", sessionId: t.id, kind: "turn", id: `cx:t:${r.turn_id}` });
      }
    } finally { hist.close(); }
  } finally { state.close(); }
}

// ponytail: OpenCode's pre-SQLite storage/message/*.json history is skipped (migrated into the db).
async function readOpenCode(dbPath: string, sink: Sink, sinceMs: number): Promise<void> {
  const db = await openReadOnly(dbPath);
  if (!db) return;
  try {
    const rows = db.all(
      "select m.id, m.session_id, m.time_created, m.data, s.parent_id from message m left join session s on s.id = m.session_id where m.time_created >= ?",
      sinceMs,
    );
    for (const r of rows) {
      let o: any;
      try { o = JSON.parse(r.data); } catch { continue; }
      const sessionId = r.parent_id ?? r.session_id;
      const ts = Number(r.time_created);
      if (o?.role === "user" && !r.parent_id) sink({ ts, agent: "opencode", sessionId, kind: "turn", id: `oc:${r.id}` });
      else if (o?.role === "assistant" && o.time?.completed && o.tokens) {
        const k = o.tokens;
        sink({
          ts, agent: "opencode", sessionId, kind: "assistant", id: `oc:${r.id}`,
          model: typeof o.modelID === "string" ? o.modelID : undefined,
          tokens: { i: num(k.input), o: num(k.output), cw: num(k.cache?.write), cr: num(k.cache?.read), ...(num(k.reasoning) ? { r: num(k.reasoning) } : {}) },
        });
      }
    }
  } finally { db.close(); }
}

/** Scan every agent into `state`, updating `cursor`. `checkpoint` is awaited every SAVE_EVERY_BYTES so
 *  a long first backfill keeps its progress if the watchdog exits mid-way. */
export async function scanAll(state: State, cursor: Cursor, roots: Roots, now: number, checkpoint: () => Promise<void> = async () => {}): Promise<void> {
  const sink: Sink = (ev) => { addEvent(state, ev); };
  let sinceSave = 0;
  const progress: Progress = async (n) => {
    sinceSave += n;
    if (sinceSave >= SAVE_EVERY_BYTES) { sinceSave = 0; await checkpoint(); }
  };
  // SQLite readers re-query only the hot window once an agent has rows (frozen days ignore events anyway).
  const since = (a: ActivityAgent) => ([...state.rows.values()].some((r) => r.a === a) ? now - HOT_DAYS * 86_400_000 : 0);
  const seen = new Set<string>();
  try { await readClaude(roots.claude, cursor, sink, progress, seen); } catch { /* skip agent */ }
  try { await readCodex(roots.codex, cursor, sink, progress, seen, since("codex")); } catch { /* skip agent */ }
  try { await readOpenCode(roots.opencode, sink, since("opencode")); } catch { /* skip agent */ }
  for (const p of Object.keys(cursor)) if (!seen.has(p)) delete cursor[p];
}

// --- cycle + upload ----------------------------------------------------------------------------

export function payloadHash(payload: ReturnType<typeof buildPayload>): string {
  return createHash("sha1").update(JSON.stringify(payload.days)).digest("hex");
}

/** Seal + POST the payload when rows changed and the last upload is ≥6 h old — or right away when the
 *  last upload went to a different pairing (a re-pair: the new pairing has no blob yet). Never throws. */
export async function maybeUpload(state: State, config: Config, now: number, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const newPairing = config.pairingId !== state.lastPairing;
  if (state.rows.size === 0 || (!newPairing && now - state.lastUpload < UPLOAD_EVERY_MS)) return false;
  const payload = buildPayload(state, now);
  const hash = payloadHash(payload);
  if (!newPairing && hash === state.lastHash) return false;
  try {
    const blob = await encryptBlob(config.e2eKey, payload);
    const res = await fetchFn(`${config.url}/v1/cc/full`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-pairing": config.pairingId, "x-cc-auth": config.pcSecret, "x-cc-version": PLUGIN_VERSION,
      },
      body: JSON.stringify({ v: 2, sessionId: "activity", what: "activity", blob }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    state.lastUpload = now;
    state.lastHash = hash;
    state.lastPairing = config.pairingId;
    return true;
  } catch { return false; }
}

export interface CycleDeps {
  config?: Config | null; roots?: Roots; daysPath?: string; cursorPath?: string; now?: () => number; fetchFn?: typeof fetch;
  /** false = upload the rows already on disk, no history scan (the re-pair fast path). */
  scan?: boolean;
}

export async function runActivityCycle(deps: CycleDeps = {}): Promise<void> {
  const config = deps.config !== undefined ? deps.config : await loadConfig();
  if (!config) return; // only when paired
  const daysPath = deps.daysPath ?? ACTIVITY_DAYS_PATH;
  const cursorPath = deps.cursorPath ?? ACTIVITY_CURSOR_PATH;
  const now = deps.now ?? Date.now;
  const state = parseState(await readFile(daysPath, "utf8").catch(() => ""));
  let cursor: Cursor = {};
  try { cursor = JSON.parse(await readFile(cursorPath, "utf8")) ?? {}; } catch { /* fresh */ }
  // Rows BEFORE cursor: a crash between the two leaves the cursor behind, and dedupe absorbs the re-read.
  const save = async () => {
    await atomicWrite(daysPath, serializeState(state), 0o600);
    await atomicWrite(cursorPath, JSON.stringify(cursor), 0o600);
  };
  const scan = deps.scan !== false;
  if (scan) {
    await scanAll(state, cursor, deps.roots ?? defaultRoots(), now(), save);
    freeze(state, now());
  }
  const sent = await maybeUpload(state, config, now(), deps.fetchFn);
  if (scan || sent) await save();
}

/** Watchdog hook: run now, then hourly; overlapping runs are skipped. A once-a-minute tick reads only
 *  config.json and, when the pairing changed since the last run (a re-pair under a live watchdog —
 *  `pair` does not restart a same-build daemon), uploads the rows already on disk without rescanning.
 *  Returns the stopper. */
export function startActivityLoop(): () => void {
  let busy = false;
  let seen: string | undefined; // pairingId the last run saw ("" = unpaired); undefined until the first run
  const run = (deps: CycleDeps) => {
    if (busy) return;
    busy = true;
    void runActivityCycle(deps).then(() => { seen = deps.config?.pairingId ?? ""; }).catch(() => {}).finally(() => { busy = false; });
  };
  const kick = async () => { if (!busy) run({ config: await loadConfig() }); };
  const tick = async () => {
    if (busy || seen === undefined) return;
    const config = await loadConfig();
    // First pairing (seen "") needs the scan anyway; a re-pair just re-sends the rows on disk.
    if (config && config.pairingId !== seen) run({ config, scan: seen !== "" });
  };
  const timers = [setInterval(() => void kick(), HOUR_MS), setInterval(() => void tick(), 60_000)];
  for (const t of timers) (t as unknown as { unref?: () => void }).unref?.();
  void kick();
  return () => timers.forEach(clearInterval);
}
