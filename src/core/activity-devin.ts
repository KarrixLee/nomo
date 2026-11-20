// activity-devin — Devin CLI reader for the NOM-142 activity summary (see activity.ts for the rules).
// Source: Devin's own SQLite store, `~/.local/share/devin/cli/sessions.db`, read-only. Only ids, times,
// model ids and token counts are selected (json_extract in SQL), never message text.
//
// - Tokens: assistant rows, `chat_message.$.metadata.metrics` (NOT the `metadata` column). Devin's
//   input_tokens already excludes cache reads, so i/cr/cw/o map 1:1; there is no reasoning split.
// - Devin stores retries, replays and compaction copies as sibling rows with the same request_id and
//   identical metrics + original timestamps, so an assistant event is `dv:<request_id>`. User prompts are
//   copied the same way (same message_id), so a turn is `dv:u:<message_id>`. Rows are read oldest first
//   (row_id) and only the first copy is emitted, so each run picks the same copy: idempotent.
// - Model: `$.metadata.generation_model`, else `sessions.model` unless it is the "adaptive" routing mode.
// - Time: assistant = `$.metadata.started_generation_at` (ISO), else `$.metadata.created_at`; a turn =
//   `message_nodes.created_at`. Unix times in this db are SECONDS. Hidden sessions are skipped.
// - transcripts/*.json are ignored: they cover only some sessions and their prompt_tokens include cache.

import type { ActivityEvent } from "./activity";
import { openReadOnly } from "./activity";

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
const j = (path: string) => `json_extract(n.chat_message, '$.${path}')`;

const SQL = `select n.row_id, n.session_id, n.created_at, s.model as sm,
  ${j("role")} as role, ${j("message_id")} as mid, ${j("metadata.is_user_input")} as inp,
  ${j("metadata.request_id")} as req, ${j("metadata.generation_model")} as gm,
  ${j("metadata.started_generation_at")} as sg, ${j("metadata.created_at")} as ca,
  ${j("metadata.metrics.input_tokens")} as i, ${j("metadata.metrics.output_tokens")} as o,
  ${j("metadata.metrics.cache_read_tokens")} as cr, ${j("metadata.metrics.cache_creation_tokens")} as cw
from message_nodes n join sessions s on s.id = n.session_id
where s.hidden = 0 and n.created_at >= ?
  and (case when json_valid(n.chat_message) then ${j("role")} end) in ('user', 'assistant')
order by n.row_id`;

/** Feed Devin turns + per-request token events to `sink`. A missing/locked db or a changed schema emits
 *  nothing and never throws. `sinceMs` bounds by row insert time (a replayed copy is newer, never older). */
export async function readDevin(dbPath: string, sink: (ev: ActivityEvent) => void, sinceMs: number): Promise<void> {
  const db = await openReadOnly(dbPath);
  if (!db) return;
  let rows: any[];
  try { rows = db.all(SQL, Math.floor(sinceMs / 1000)); } catch { return; } finally { db.close(); }
  const seen = new Set<string>();
  for (const r of rows) {
    const sessionId = String(r.session_id);
    if (r.role === "user") {
      if (r.inp !== 1) continue;
      const id = `dv:u:${r.mid ?? `${sessionId}:${r.row_id}`}`;
      if (seen.has(id)) continue;
      seen.add(id);
      sink({ ts: Number(r.created_at) * 1000, agent: "devin", sessionId, kind: "turn", id });
      continue;
    }
    if (typeof r.req !== "string" || !r.req || (r.i == null && r.o == null)) continue; // pending: no metrics yet
    const id = `dv:${r.req}`;
    if (seen.has(id)) continue;
    const ts = Date.parse(r.sg ?? "") || Date.parse(r.ca ?? "");
    if (!Number.isFinite(ts)) continue;
    seen.add(id);
    const model = typeof r.gm === "string" && r.gm ? r.gm : typeof r.sm === "string" && r.sm && r.sm !== "adaptive" ? r.sm : undefined;
    sink({
      ts, agent: "devin", sessionId, kind: "assistant", id, model,
      tokens: { i: num(r.i), o: num(r.o), cw: num(r.cw), cr: num(r.cr) },
    });
  }
}
