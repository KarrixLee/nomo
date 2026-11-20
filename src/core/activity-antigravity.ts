// activity-antigravity — Google Antigravity (desktop app + `agy` CLI) history for the NOM-142 activity
// summary. Each conversation is a SQLite db `~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/
// conversations/<uuid>.db` holding protobuf blobs (Windsurf `exa.*` protos). `.pb` conversations need
// the live language server and are skipped.
//
// TOKENS: gen_metadata.data → 1 (chat_model) → 4 (ModelUsageStats): 1 = model enum, 2 = input
// (uncached), 3 = output total (= 9 + 10), 4 = cache write, 5 = cache read, 9 = thinking, 10 = visible
// output; zeros are omitted. chat_model 17 (retry_infos) and steps.metadata 9 REPEAT that usage, so
// gen_metadata's primary usage is the only source. TIME: chat_model 9.4 (created_at) when present, else
// the earliest steps.metadata 1 of the generation's step indices (root field 2, packed), else
// trajectory_metadata_blob 2. TURNS: steps with step_type 14 (USER_INPUT), timed by metadata 1.
//
// IDS: `ag:<uuid>:<gen idx>` / `ag:t:<uuid>:<step idx>` — stable, so a conversation present in two
// roots, or re-read after it grew, never counts twice (hot-row dedupe in addEvent). A db is re-opened
// only when its .db or -wal size/mtime changed. Any decode error skips that row, never the scan.

import { readdir, stat } from "node:fs/promises";
import type { ActivityEvent, Cursor, CursorEntry } from "./activity";

// --- minimal protobuf reader -------------------------------------------------------------------
// Decodes ONE message level; nested messages are decoded explicitly at known paths (max depth 4), so
// there is no recursion to bound. Throws on a truncated value, field 0 or a group/unknown wire type.

type Field = [n: number, v: number | Uint8Array];

function varint(b: Uint8Array, p: number): [number, number] {
  let v = 0;
  let m = 1;
  for (let i = 0; i < 10; i++) {
    if (p >= b.length) throw new Error("truncated varint");
    const x = b[p++];
    v += (x & 0x7f) * m; // float math: exact below 2^53, plenty for token counts
    if (!(x & 0x80)) return [v, p];
    m *= 128;
  }
  throw new Error("varint too long");
}

export function decode(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let p = 0;
  while (p < b.length) {
    let tag: number;
    [tag, p] = varint(b, p);
    const n = Math.floor(tag / 8);
    const w = tag % 8;
    if (n === 0) throw new Error("field 0");
    if (w === 0) { let v: number; [v, p] = varint(b, p); out.push([n, v]); }
    else if (w === 2) {
      let len: number;
      [len, p] = varint(b, p);
      if (p + len > b.length) throw new Error("truncated bytes");
      out.push([n, b.subarray(p, p + len)]);
      p += len;
    } else if (w === 1 || w === 5) {
      p += w === 1 ? 8 : 4;
      if (p > b.length) throw new Error("truncated fixed");
    } else throw new Error(`wire type ${w}`);
  }
  return out;
}

const bytes = (f: Field[], n: number) => f.find((x) => x[0] === n && x[1] instanceof Uint8Array)?.[1] as Uint8Array | undefined;
/** Last occurrence wins (protobuf scalar rule); absent = 0. */
const int = (f: Field[], n: number) => { for (let i = f.length - 1; i >= 0; i--) if (f[i][0] === n && typeof f[i][1] === "number") return f[i][1] as number; return 0; };
const text = (f: Field[], n: number) => { const b = bytes(f, n); return b ? new TextDecoder().decode(b).trim() || undefined : undefined; };
const asBytes = (x: unknown) => (x instanceof Uint8Array ? x : x ? new Uint8Array(x as ArrayBuffer) : undefined);

/** google.protobuf.Timestamp-shaped {1: seconds, 2: nanos} → ms, or undefined. */
function tsMs(b: Uint8Array | undefined): number | undefined {
  if (!b) return undefined;
  const f = decode(b);
  const s = int(f, 1);
  return s > 0 ? s * 1000 + Math.floor(Math.min(int(f, 2), 999_999_999) / 1e6) : undefined;
}

// --- model names -------------------------------------------------------------------------------

/** Placeholder enums seen without a label, from ccusage's antigravity adapter (normalize_antigravity_model). */
const PLACEHOLDERS: Record<number, string> = {
  318: "gemini-3.8-flash-high", 319: "gemini-3.8-flash-medium", 320: "gemini-3.8-flash-low",
  298: "gemini-3.7-flash-high", 299: "gemini-3.7-flash-medium", 300: "gemini-3.7-flash-low",
  71: "gemini-3.6-flash-high", 72: "gemini-3.6-flash-medium", 73: "gemini-3.6-flash-low",
  16: "gemini-3.1-pro", 36: "gemini-3.1-pro", 37: "gemini-3.1-pro", 35: "claude-sonnet-4-6", 26: "claude-opus-4-6",
};

/** "Gemini 3.8 Flash (High)" → "gemini-3.8-flash-high"; no label → the usage's model enum (1000 + Mxxx). */
export function agModel(label: string | undefined, enumId: number): string | undefined {
  if (label) return label.toLowerCase().replace(/[()]/g, " ").trim().split(/\s+/).join("-");
  if (enumId >= 1000) return PLACEHOLDERS[enumId - 1000] ?? `model_placeholder_m${enumId - 1000}`;
  return enumId > 0 ? `antigravity-model-${enumId}` : undefined;
}

// --- one conversation db -----------------------------------------------------------------------

export interface AgDb { all(sql: string, ...params: unknown[]): any[]; close(): void }

/** Every event in one conversation db. Bad rows are skipped; a missing table throws (caller skips the db). */
export function readAntigravityDb(db: AgDb, uuid: string, sink: (ev: ActivityEvent) => void): void {
  const stepTs = new Map<number, number>();
  for (const r of db.all("select idx, step_type, metadata from steps")) {
    try {
      const t = tsMs(bytes(decode(asBytes(r.metadata) ?? new Uint8Array()), 1));
      if (t === undefined) continue;
      stepTs.set(Number(r.idx), t);
      if (Number(r.step_type) === 14) sink({ ts: t, agent: "antigravity", sessionId: uuid, kind: "turn", id: `ag:t:${uuid}:${r.idx}` });
    } catch { /* bad step: skip */ }
  }
  let trajTs: number | undefined;
  try {
    for (const r of db.all("select data from trajectory_metadata_blob")) { trajTs ??= tsMs(bytes(decode(asBytes(r.data)!), 2)); }
  } catch { /* no fallback time */ }
  for (const r of db.all("select idx, data from gen_metadata")) {
    try {
      const root = decode(asBytes(r.data)!);
      const cm = decode(bytes(root, 1)!);
      const usage = bytes(cm, 4);
      if (!usage) continue;
      const u = decode(usage);
      const r9 = int(u, 9);
      const has10 = u.some((x) => x[0] === 10);
      const tokens = { i: int(u, 2), o: has10 ? int(u, 10) : Math.max(0, int(u, 3) - r9), cw: int(u, 4), cr: int(u, 5), ...(r9 ? { r: r9 } : {}) };
      if (!tokens.i && !tokens.o && !tokens.cw && !tokens.cr && !r9) continue; // model-only row
      let ts: number | undefined;
      const gi = bytes(cm, 9);
      if (gi) ts = tsMs(bytes(decode(gi), 4));
      if (ts === undefined) {
        for (const [n, v] of root) {
          if (n !== 2) continue;
          const idxs: number[] = [];
          if (typeof v === "number") idxs.push(v);
          else for (let p = 0, x: number; p < v.length;) { [x, p] = varint(v, p); idxs.push(x); }
          for (const i of idxs) { const t = stepTs.get(i); if (t !== undefined && (ts === undefined || t < ts)) ts = t; }
        }
      }
      ts ??= trajTs;
      if (ts === undefined) continue;
      sink({ ts, agent: "antigravity", sessionId: uuid, kind: "assistant", id: `ag:${uuid}:${r.idx}`, model: agModel(text(cm, 21), int(u, 1)), tokens });
    } catch { /* bad generation row: skip */ }
  }
}

// --- all conversations -------------------------------------------------------------------------

export const AG_APPS = ["antigravity", "antigravity-cli", "antigravity-ide"];
const UUID_DB = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/;

/** `gemini` = ~/.gemini. `open` is activity.ts's openReadOnly (passed in: no import cycle). */
export async function readAntigravity(
  gemini: string, cursor: Cursor, sink: (ev: ActivityEvent) => void, seen: Set<string>,
  open: (path: string) => Promise<AgDb | null>,
): Promise<void> {
  for (const app of AG_APPS) {
    const dir = `${gemini}/${app}/conversations`;
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const uuid = name.match(UUID_DB)?.[1];
      if (!uuid) continue;
      const path = `${dir}/${name}`;
      seen.add(path);
      try {
        const st = await stat(path);
        const wal = await stat(`${path}-wal`).catch(() => null);
        const fp = `${st.size}:${st.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
        const prev = cursor[path] as (CursorEntry & { fp?: string }) | undefined;
        if (prev?.fp === fp) continue;
        const db = await open(path);
        if (!db) continue; // retried next scan
        try { readAntigravityDb(db, uuid, sink); } finally { db.close(); }
        cursor[path] = { ino: st.ino, offset: 0, fp } as CursorEntry;
      } catch { /* unreadable db: skip, retried next scan */ }
    }
  }
}
