process.env.TZ = "Asia/Tokyo";

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPayload, Cursor, emptyState, scanAll, State } from "./activity";
import { agModel, decode } from "./activity-antigravity";

// --- tiny protobuf encoder (fixtures only) ---
type V = number | Uint8Array | V[];
const vint = (n: number): number[] => { const o: number[] = []; while (n >= 128) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
/** msg([[field, value], ...]): number = varint, Uint8Array = bytes, string = utf8, array = nested message. */
function msg(fields: [number, V | string][]): Uint8Array {
  const out: number[] = [];
  for (const [n, v] of fields) {
    if (typeof v === "number") out.push(...vint(n * 8), ...vint(v));
    else {
      const b = typeof v === "string" ? new TextEncoder().encode(v) : v instanceof Uint8Array ? v : msg(v as [number, V][]);
      out.push(...vint(n * 8 + 2), ...vint(b.length), ...b);
    }
  }
  return new Uint8Array(out);
}
const packed = (xs: number[]) => new Uint8Array(xs.flatMap(vint));
const ts = (iso: string): [number, V][] => [[1, Date.parse(iso) / 1000], [2, 500_000_000]];
const usage = (u: Record<number, number>) => Object.entries(u).map(([k, v]) => [Number(k), v] as [number, V]);
/** A gen_metadata.data blob: chat_model{4: usage, 17: retry mirror, 21: label} + packed step indices. */
const gen = (u: Record<number, number>, steps: number[], label?: string, extra: [number, V | string][] = []) =>
  msg([[1, [[4, usage(u)], [17, [[2, usage(u)]]], ...(label ? [[21, label] as [number, V | string]] : []), ...extra] as any], ...(steps.length ? [[2, packed(steps)] as [number, V]] : [])]);
const step = (iso: string) => msg([[1, ts(iso)]]);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "nomo-agy-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeDb(app: string, uuid: string, steps: [number, number, Uint8Array | null][], gens: [number, Uint8Array][], traj?: Uint8Array) {
  const d = join(dir, app, "conversations");
  mkdirSync(d, { recursive: true });
  const db = new Database(join(d, `${uuid}.db`));
  db.run("create table steps (idx integer primary key, step_type integer not null default 0, metadata blob)");
  db.run("create table gen_metadata (idx integer primary key, data blob, size integer not null default 0)");
  db.run("create table trajectory_metadata_blob (id text primary key default 'main', data blob)");
  for (const s of steps) db.run("insert into steps (idx, step_type, metadata) values (?, ?, ?)", s);
  for (const g of gens) db.run("insert into gen_metadata (idx, data) values (?, ?)", g);
  if (traj) db.run("insert into trajectory_metadata_blob (data) values (?)", [traj]);
  db.close();
}

const U1 = "11111111-1111-4111-8111-111111111111";
const roots = () => ({ claude: join(dir, "none"), codex: join(dir, "none"), opencode: join(dir, "none.db"), antigravity: dir });
const NOW = Date.parse("2026-11-20T00:00:00Z");
const day = (st: State, d: string) => buildPayload(st, NOW).days.find((x) => x.d === d && x.a === "antigravity");

describe("antigravity", () => {
  test("usage mapping, retry mirror not counted, model-only row skipped, step-join time, turns", async () => {
    makeDb("antigravity", U1,
      [[0, 14, step("2026-11-18T01:00:00Z")], [1, 15, step("2026-11-18T01:00:05Z")], [2, 14, step("2026-11-19T02:00:00Z")], [3, 15, step("2026-11-19T02:00:03Z")], [4, 14, null]],
      [
        [0, gen({ 1: 1318, 2: 100, 3: 30, 5: 7000, 9: 20, 10: 10 }, [3, 1], "Gemini 3.8 Flash (High)")], // 3 == 9 + 10; earliest step = 1
        [1, gen({ 1: 1318, 2: 50, 3: 40, 4: 9, 9: 15 }, [3])], // f10 absent → o = 3 − 9; no label → enum table
        [2, gen({ 1: 1318 }, [3], "Gemini 3.8 Flash (High)")], // model only
      ]);
    const st = emptyState();
    await scanAll(st, {}, roots(), NOW);
    expect(day(st, "2026-11-18")).toMatchObject({ s: 1, t: 1, u: [{ m: "gemini-3.8-flash-high", i: 100, o: 10, cw: 0, cr: 7000, r: 20 }] });
    expect(day(st, "2026-11-19")).toMatchObject({ s: 1, t: 1, u: [{ m: "gemini-3.8-flash-high", i: 50, o: 25, cw: 9, cr: 0, r: 15 }] });
    expect(buildPayload(st, NOW).days).toHaveLength(2); // step 4 (no time) counted nowhere
  });

  test("created_at (chat_model 9.4) wins; trajectory time is the last resort; no time = skipped", async () => {
    makeDb("antigravity-cli", U1, [], [
      [0, gen({ 2: 1 }, [], "X", [[9, [[4, ts("2026-11-10T00:00:00Z")]]]])],
      [1, gen({ 2: 2 }, [], "X")],
    ], msg([[2, ts("2026-11-12T00:00:00Z")]]));
    const U2 = "22222222-2222-4222-8222-222222222222";
    makeDb("antigravity-cli", U2, [], [[0, gen({ 2: 4 }, [9], "X")]]); // step 9 missing, no trajectory
    const st = emptyState();
    await scanAll(st, {}, roots(), NOW);
    expect(day(st, "2026-11-10")!.u[0].i).toBe(1);
    expect(day(st, "2026-11-12")!.u[0].i).toBe(2);
    expect(buildPayload(st, NOW).days.reduce((a, d) => a + d.u.reduce((b, u) => b + u.i, 0), 0)).toBe(3);
  });

  test("the same uuid in two roots counts once; a second run adds nothing; growth adds only the new row", async () => {
    const steps: [number, number, Uint8Array][] = [[0, 14, step("2026-11-18T01:00:00Z")], [1, 15, step("2026-11-18T01:00:05Z")]];
    makeDb("antigravity", U1, steps, [[0, gen({ 2: 100, 10: 5 }, [1], "M")]]);
    makeDb("antigravity-ide", U1, steps, [[0, gen({ 2: 100, 10: 5 }, [1], "M")]]);
    const st = emptyState();
    const cur: Cursor = {};
    await scanAll(st, cur, roots(), NOW);
    const first = JSON.stringify(buildPayload(st, NOW).days);
    expect(day(st, "2026-11-18")).toMatchObject({ s: 1, t: 1, u: [{ m: "m", i: 100, o: 5 }] });
    expect(Object.values(cur).filter((e: any) => e.fp)).toHaveLength(2);
    await scanAll(st, cur, roots(), NOW); // fingerprints unchanged: not even opened
    await scanAll(st, {}, roots(), NOW); // cursor lost: re-read, deduped by event id
    expect(JSON.stringify(buildPayload(st, NOW).days)).toBe(first);
    const db = new Database(join(dir, "antigravity", "conversations", `${U1}.db`));
    db.run("insert into gen_metadata (idx, data) values (?, ?)", [1, gen({ 2: 1, 10: 1 }, [1], "M")]);
    db.close();
    await scanAll(st, cur, roots(), NOW);
    expect(day(st, "2026-11-18")!.u).toEqual([{ m: "m", i: 101, o: 6, cw: 0, cr: 0 }]);
  });

  test("garbage blobs and a non-sqlite .db never throw; good rows still count; a missing ~/.gemini is quiet", async () => {
    makeDb("antigravity", U1, [[0, 14, new Uint8Array([0xff, 0xff, 0xff])], [1, 15, step("2026-11-18T01:00:05Z")]], [
      [0, new Uint8Array([0x0a, 0x7f, 1, 2])], // truncated length
      [1, new Uint8Array([0x0b, 0x00])], // group wire type
      [2, gen({ 2: 3 }, [1], "M")],
    ]);
    mkdirSync(join(dir, "antigravity-cli", "conversations"), { recursive: true });
    await Bun.write(join(dir, "antigravity-cli", "conversations", "33333333-3333-4333-8333-333333333333.db"), "not sqlite");
    const st = emptyState();
    await scanAll(st, {}, roots(), NOW);
    expect(day(st, "2026-11-18")).toMatchObject({ t: 0, u: [{ i: 3 }] });
    const empty = emptyState();
    await scanAll(empty, {}, { ...roots(), antigravity: join(dir, "nope") }, NOW);
    expect(empty.rows.size).toBe(0);
  });

  test("decoder bounds and model names", () => {
    expect(() => decode(new Uint8Array([0x08, 0x80]))).toThrow(); // truncated varint
    expect(() => decode(new Uint8Array([0x00, 0x01]))).toThrow(); // field 0
    expect(() => decode(new Uint8Array([0x0d, 1, 2]))).toThrow(); // truncated fixed32
    expect(decode(msg([[3, 2 ** 40]]))).toEqual([[3, 2 ** 40]]);
    expect(agModel("Gemini 3.8 Flash (Low)", 1320)).toBe("gemini-3.8-flash-low");
    expect(agModel(undefined, 1320)).toBe("gemini-3.8-flash-low");
    expect(agModel(undefined, 1999)).toBe("model_placeholder_m999");
    expect(agModel(undefined, 0)).toBeUndefined();
  });
});
