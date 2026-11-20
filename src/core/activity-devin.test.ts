process.env.TZ = "Asia/Tokyo"; // before any Date use: day bucketing is local-time

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPayload, emptyState, openReadOnly, scanAll, type Roots } from "./activity";

let dir: string;
let roots: Roots;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nomo-activity-devin-"));
  roots = { claude: join(dir, "none"), codex: join(dir, "none"), opencode: join(dir, "none.db"), devin: join(dir, "sessions.db") };
});
afterEach(() => { try { chmodSync(join(dir, "ro"), 0o755); } catch {} rmSync(dir, { recursive: true, force: true }); });

const NOW = Date.parse("2026-11-20T00:00:00Z");
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function fixture(path: string): Database {
  const db = new Database(path);
  db.exec(`create table sessions (id text primary key, working_directory text not null, backend_type text not null, model text not null,
      agent_mode text not null, created_at integer not null, last_activity_at integer not null, title text, hidden integer not null default 0, metadata text);
    create table message_nodes (row_id integer primary key autoincrement, session_id text not null, node_id integer not null,
      parent_node_id integer, chat_message text not null, created_at integer not null, metadata text, unique(session_id, node_id));`);
  return db;
}
let node = 0;
const session = (db: Database, id: string, model: string, hidden = 0) =>
  db.run("insert into sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, hidden) values (?, '/x', 'b', ?, 'm', 1, 1, ?)", [id, model, hidden]);
const msg = (db: Database, sid: string, createdIso: string, chat: object) =>
  db.run("insert into message_nodes (session_id, node_id, chat_message, created_at, metadata) values (?, ?, ?, ?, null)", [sid, ++node, JSON.stringify(chat), sec(createdIso)]);
const user = (mid: string, isInput: boolean, created: string) =>
  ({ role: "user", message_id: mid, content: "secret prompt", metadata: { is_user_input: isInput ? true : null, created_at: created, request_id: null } });
const asst = (req: string, started: string, i: number, o: number, cr: number, gm?: string) => ({
  role: "assistant", message_id: `m-${req}`, content: "secret reply",
  metadata: { request_id: req, started_generation_at: started, created_at: started, ...(gm ? { generation_model: gm } : {}),
    metrics: { input_tokens: i, output_tokens: o, cache_read_tokens: cr, cache_creation_tokens: null } },
});

function seed(path: string) {
  const db = fixture(path);
  session(db, "brave-otter", "adaptive");
  session(db, "calm-fox", "swe-2-flash-medium");
  session(db, "hidden-one", "swe-2-flash-medium", 1);
  // brave-otter (adaptive): 2 real prompts (one replayed), one non-input user row, a retried request
  msg(db, "brave-otter", "2026-11-19T01:00:00Z", user("u1", true, "2026-11-19T01:00:00Z"));
  msg(db, "brave-otter", "2026-11-19T01:00:01Z", asst("r1", "2026-11-19T01:00:01Z", 100, 10, 1000, "gpt-5-3-codex"));
  msg(db, "brave-otter", "2026-11-19T01:00:30Z", asst("r1", "2026-11-19T01:00:01Z", 100, 10, 1000, "gpt-5-3-codex")); // retry/replay sibling
  msg(db, "brave-otter", "2026-11-19T01:01:00Z", user("sys", false, "2026-11-19T01:01:00Z")); // not an input
  msg(db, "brave-otter", "2026-11-19T01:02:00Z", asst("r2", "2026-11-19T01:02:00Z", 50, 5, 0)); // no generation_model + adaptive → unknown
  msg(db, "brave-otter", "2026-11-19T01:10:00Z", user("u2", true, "2026-11-19T01:10:00Z"));
  msg(db, "brave-otter", "2026-11-19T01:10:02Z", user("u2", true, "2026-11-19T01:10:00Z")); // replayed prompt copy
  msg(db, "brave-otter", "2026-11-19T01:11:00Z", { role: "assistant", metadata: { request_id: "pending" } }); // no metrics yet
  // calm-fox: falls back to sessions.model; next local day (JST)
  msg(db, "calm-fox", "2026-11-19T16:00:00Z", user("u3", true, "2026-11-19T16:00:00Z"));
  msg(db, "calm-fox", "2026-11-19T16:00:05Z", asst("r3", "2026-11-19T16:00:05Z", 7, 3, 20));
  msg(db, "calm-fox", "2026-11-19T16:00:06Z", { role: "system", content: "x", metadata: {} });
  msg(db, "calm-fox", "2026-11-19T16:00:07Z", "not json at all" as unknown as object);
  db.run("update message_nodes set chat_message = '{broken' where row_id = (select max(row_id) from message_nodes)");
  // hidden session: ignored entirely
  msg(db, "hidden-one", "2026-11-19T02:00:00Z", user("u9", true, "2026-11-19T02:00:00Z"));
  msg(db, "hidden-one", "2026-11-19T02:00:01Z", asst("r9", "2026-11-19T02:00:01Z", 999, 999, 999, "gpt-5-3-codex"));
  return db;
}

const devinRow = (st: ReturnType<typeof emptyState>, d: string) => buildPayload(st, NOW).days.find((x) => x.d === d && x.a === "devin");

describe("devin reader", () => {
  test("dedupes retries + replayed prompts, skips hidden/non-input/pending, maps tokens and models; second run adds nothing", async () => {
    seed(roots.devin!).close();
    const st = emptyState();
    await scanAll(st, {}, roots, NOW);
    expect(devinRow(st, "2026-11-19")).toMatchObject({
      s: 1, t: 2,
      u: [{ m: "gpt-5-3-codex", i: 100, o: 10, cw: 0, cr: 1000 }, { m: "unknown", i: 50, o: 5, cw: 0, cr: 0 }],
    });
    expect(devinRow(st, "2026-11-20")).toMatchObject({ s: 1, t: 1, u: [{ m: "swe-2-flash-medium", i: 7, o: 3, cw: 0, cr: 20 }] });
    // 10:00 JST → slot 120, 10:10 → slot 122: seconds were read as seconds (a ms misread lands in 1970)
    expect(Buffer.from(devinRow(st, "2026-11-19")!.b, "base64")[15]).toBe(0b10100000);
    const before = JSON.stringify(buildPayload(st, NOW).days);
    await scanAll(st, {}, roots, NOW);
    expect(JSON.stringify(buildPayload(st, NOW).days)).toBe(before);
    expect(before).not.toContain("secret");
  });

  test("missing db, wrong schema or no devin root: no rows, no throw, other agents unaffected", async () => {
    const st = emptyState();
    await scanAll(st, {}, roots, NOW); // missing
    writeFileSync(roots.devin!, "not a sqlite file");
    await scanAll(st, {}, roots, NOW);
    rmSync(roots.devin!);
    const bad = new Database(roots.devin!);
    bad.exec("create table sessions (id text)");
    bad.close();
    await scanAll(st, {}, roots, NOW);
    await scanAll(st, {}, { ...roots, devin: undefined }, NOW);
    expect(st.rows.size).toBe(0);
  });
});

describe("openReadOnly + WAL", () => {
  const roCopies = () => readdirSync(tmpdir()).filter((n) => n.startsWith("nomo-ro-")).length;
  const count = async (path: string) => {
    const db = await openReadOnly(path);
    if (!db) return null;
    try { return db.all("select count(*) n from t")[0].n; } finally { db.close(); }
  };

  test("WAL rows are read live, from a -wal without -shm, and from a read-only dir; never a stale immutable read", async () => {
    const p = join(dir, "w.db");
    const w = new Database(p);
    w.exec("pragma journal_mode=wal; pragma wal_autocheckpoint=0; create table t(x); pragma wal_checkpoint(truncate);");
    w.exec("insert into t values (1),(2),(3)"); // only in w.db-wal
    expect(await count(p)).toBe(3); // live writer: plain ro
    // a -wal with NO -shm (how Antigravity leaves its dbs). Where ro cannot build the -shm (read-only dir,
    // CANTOPEN) it must read a temp copy: immutable would open and read 0 rows
    for (const sub of ["noshm", "ro"]) {
      mkdirSync(join(dir, sub));
      copyFileSync(p, join(dir, sub, "w.db")); copyFileSync(`${p}-wal`, join(dir, sub, "w.db-wal"));
    }
    w.close();
    const before = roCopies();
    expect(await count(join(dir, "noshm", "w.db"))).toBe(3);
    if (process.getuid?.() !== 0) { // root ignores the read-only dir
      chmodSync(join(dir, "ro"), 0o555);
      expect(await count(join(dir, "ro", "w.db"))).toBe(3);
      // no -wal: the immutable fallback still opens a WAL-mode db in a read-only dir
      chmodSync(join(dir, "ro"), 0o755);
      rmSync(join(dir, "ro", "w.db-wal"));
      chmodSync(join(dir, "ro"), 0o555);
      expect(await count(join(dir, "ro", "w.db"))).toBe(0);
    }
    expect(roCopies()).toBe(before); // temp copies deleted on close
  });
});
