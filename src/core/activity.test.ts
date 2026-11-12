process.env.TZ = "Asia/Tokyo"; // before any Date use: day bucketing is local-time

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { PLUGIN_VERSION } from "./shared";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addEvent, buildPayload, Cursor, emptyState, freeze, loadMachineId, localDate, maybeUpload, parseClaudeLine, parseCodexLine,
  parseState, runActivityCycle, scanAll, serializeState, startActivityLoop, State,
} from "./activity";

const asst = (id: string, req: string, ts: string, out = 10, sid = "s1") => JSON.stringify({
  type: "assistant", timestamp: ts, sessionId: sid, requestId: req, userType: "external",
  message: { id, model: "claude-x", usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } },
});
const user = (uuid: string, ts: string, content: unknown = "hi", extra = {}) => JSON.stringify({
  type: "user", userType: "external", timestamp: ts, sessionId: "s1", uuid, message: { role: "user", content }, ...extra,
});

let dir: string;
let roots: { claude: string; codex: string; opencode: string };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nomo-activity-"));
  roots = { claude: join(dir, "projects"), codex: join(dir, "codex"), opencode: join(dir, "none.db") };
  mkdirSync(join(roots.claude, "p"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const NOW = Date.parse("2026-11-04T00:00:00Z");
const row = (st: State, d: string, a = "claude") => buildPayload(st, NOW).days.find((x) => x.d === d && x.a === a);

describe("claude dedupe + turns", () => {
  test("duplicate message.id+requestId lines count once", async () => {
    const f = join(roots.claude, "p", "a.jsonl");
    writeFileSync(f, [asst("m1", "r1", "2026-11-03T01:00:00Z"), asst("m1", "r1", "2026-11-03T01:00:00Z"), asst("m2", "r2", "2026-11-03T01:01:00Z"), ""].join("\n"));
    const st = emptyState();
    await scanAll(st, {}, roots, NOW);
    expect(row(st, "2026-11-03")!.u).toEqual([{ m: "claude-x", i: 2, o: 20, cw: 4, cr: 6 }]);
  });

  test("one line per content block: the message keeps its LARGEST output, across scans and re-reads", async () => {
    const f = join(roots.claude, "p", "a.jsonl");
    const ts = "2026-11-03T01:00:00Z";
    writeFileSync(f, [asst("m1", "r1", ts, 5), asst("m1", "r1", ts, 5), ""].join("\n"));
    const cur: Cursor = {};
    let st = emptyState();
    await scanAll(st, cur, roots, NOW);
    expect(row(st, "2026-11-03")!.u).toEqual([{ m: "claude-x", i: 1, o: 5, cw: 2, cr: 3 }]);
    appendFileSync(f, asst("m1", "r1", ts, 364) + "\n"); // the bigger line lands in the NEXT scan
    st = parseState(serializeState(st)); // and survives a save/load
    await scanAll(st, cur, roots, NOW);
    expect(row(st, "2026-11-03")!.u).toEqual([{ m: "claude-x", i: 1, o: 364, cw: 2, cr: 3 }]);
    writeFileSync(f, [asst("m1", "r1", ts, 5), asst("m1", "r1", ts, 364), asst("m1", "r1", ts, 300), ""].join("\n")); // full re-read
    await scanAll(st, cur, roots, NOW);
    expect(row(st, "2026-11-03")!.u).toEqual([{ m: "claude-x", i: 1, o: 364, cw: 2, cr: 3 }]);
  });

  test("turns: real prompts only", () => {
    expect(parseClaudeLine(user("u1", "2026-11-03T01:00:00Z"))?.kind).toBe("turn");
    expect(parseClaudeLine(user("u2", "2026-11-03T01:00:00Z", [{ type: "tool_result", content: "x" }]))).toBeNull();
    expect(parseClaudeLine(user("u3", "2026-11-03T01:00:00Z", "x", { isMeta: true }))).toBeNull();
    expect(parseClaudeLine(user("u4", "2026-11-03T01:00:00Z", "<task-notification>x"))).toBeNull();
    expect(parseClaudeLine(user("u5", "2026-11-03T01:00:00Z", "x", { isSidechain: true }))).toBeNull();
  });

  test("corrupt lines and unknown schemas are skipped", async () => {
    const f = join(roots.claude, "p", "a.jsonl");
    writeFileSync(f, ['{"type":"assistant", broken', '{"type":"assistant","timestamp":"nope"}', '{"type":"assistant","timestamp":"2026-11-03T01:00:00Z"}',
      JSON.stringify({ type: "weird", payload: 1 }), user("u1", "2026-11-03T01:00:00Z"), ""].join("\n"));
    const st = emptyState();
    await scanAll(st, {}, roots, NOW);
    expect(row(st, "2026-11-03")).toMatchObject({ s: 1, t: 1, u: [] });
    expect(parseCodexLine('{"type":"event_msg","payload":{"type":"token_count","info":null}}', { sid: "x" })).toBeNull();
  });
});

describe("bitmap + day bucketing", () => {
  test("slot bitmap is 48 b64 chars and ORs across events", () => {
    const st = emptyState();
    // 00:00 and 00:07 JST → slots 0 and 1; 23:59 JST → slot 287
    addEvent(st, { ts: Date.parse("2026-11-02T15:00:00Z"), agent: "claude", sessionId: "s", kind: "turn", id: "a" });
    addEvent(st, { ts: Date.parse("2026-11-02T15:07:00Z"), agent: "claude", sessionId: "s", kind: "turn", id: "b" });
    addEvent(st, { ts: Date.parse("2026-11-03T14:59:00Z"), agent: "claude", sessionId: "s", kind: "turn", id: "c" });
    const b = Buffer.from(row(st, "2026-11-03")!.b, "base64");
    expect(row(st, "2026-11-03")!.b.length).toBe(48);
    expect(b[0]).toBe(0b11000000);
    expect(b[35]).toBe(0b00000001);
    expect(b.subarray(1, 35).every((x) => x === 0)).toBe(true);
    // OR merge survives a save/load round trip
    const st2 = parseState(serializeState(st));
    addEvent(st2, { ts: Date.parse("2026-11-02T15:12:00Z"), agent: "claude", sessionId: "s", kind: "turn", id: "d" });
    expect(Buffer.from(row(st2, "2026-11-03")!.b, "base64")[0]).toBe(0b11100000);
    expect(row(st2, "2026-11-03")!.t).toBe(4);
  });

  test("midnight is local (JST), not UTC", () => {
    const st = emptyState();
    addEvent(st, { ts: Date.parse("2026-11-02T14:59:00Z"), agent: "codex", sessionId: "s", kind: "turn", id: "a" }); // 23:59 JST 11-02
    addEvent(st, { ts: Date.parse("2026-11-02T15:01:00Z"), agent: "codex", sessionId: "s", kind: "turn", id: "b" }); // 00:01 JST 11-03
    expect(row(st, "2026-11-02", "codex")!.t).toBe(1);
    expect(row(st, "2026-11-03", "codex")!.t).toBe(1);
    expect(localDate(Date.parse("2026-11-02T15:01:00Z"))).toBe("2026-11-03");
  });

  test("frozen days accept nothing; old days are pruned", () => {
    const st = emptyState();
    const old = NOW - 50 * 86_400_000;
    addEvent(st, { ts: old, agent: "claude", sessionId: "s", kind: "turn", id: "a" });
    freeze(st, NOW);
    expect(addEvent(st, { ts: old, agent: "claude", sessionId: "s", kind: "turn", id: "b" })).toBe(false);
    freeze(st, NOW + 400 * 86_400_000);
    expect(st.rows.size).toBe(0);
  });
});

describe("incremental cursor", () => {
  test("append counts only new lines; shrink re-reads without double count", async () => {
    const f = join(roots.claude, "p", "a.jsonl");
    writeFileSync(f, [user("u1", "2026-11-03T01:00:00Z"), user("u2", "2026-11-03T01:05:00Z"), ""].join("\n"));
    const st = emptyState();
    const cur: Cursor = {};
    await scanAll(st, cur, roots, NOW);
    expect(row(st, "2026-11-03")!.t).toBe(2);
    const off = cur[f].offset;

    appendFileSync(f, user("u3", "2026-11-03T01:10:00Z") + "\n" + '{"type":"user","userType":"external","partial');
    await scanAll(st, cur, roots, NOW);
    expect(row(st, "2026-11-03")!.t).toBe(3);
    expect(cur[f].offset).toBeGreaterThan(off); // stops before the partial line

    // rewrite smaller (shrink) with one old + one new line → full re-read, old one deduped
    writeFileSync(f, [user("u1", "2026-11-03T01:00:00Z"), user("u9", "2026-11-03T02:00:00Z"), ""].join("\n"));
    await scanAll(st, cur, roots, NOW);
    expect(row(st, "2026-11-03")!.t).toBe(4);
  });

  test("codex rollout: model carried across incremental reads, duplicate token_count deduped", async () => {
    const day = join(roots.codex, "sessions", "2026", "11", "03");
    mkdirSync(day, { recursive: true });
    const f = join(day, "rollout-2026-11-03T01-00-00-01a1a296-89bc-7640-a7a1-2e55d66cf5ac.jsonl");
    const tc = (total: number) => JSON.stringify({ timestamp: "2026-11-03T01:00:05Z", type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5 } } } });
    writeFileSync(f, [
      JSON.stringify({ timestamp: "2026-11-03T01:00:00Z", type: "session_meta", payload: { id: "x", source: "cli" } }),
      JSON.stringify({ timestamp: "2026-11-03T01:00:00Z", type: "turn_context", payload: { model: "gpt-x" } }),
      JSON.stringify({ timestamp: "2026-11-03T01:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      tc(120), tc(120), ""].join("\n"));
    const st = emptyState();
    const cur: Cursor = {};
    await scanAll(st, cur, roots, NOW);
    appendFileSync(f, tc(240) + "\n");
    await scanAll(st, cur, roots, NOW);
    expect(row(st, "2026-11-03", "codex")).toMatchObject({ s: 1, t: 1, u: [{ m: "gpt-x", i: 80, o: 30, cw: 0, cr: 120, r: 10 }] });
  });
});

describe("codex sqlite backfill", () => {
  test("a rollout read earlier, now unreadable (zst/moved/deleted), is not re-added; a never-read thread is", async () => {
    const { Database } = await import("bun:sqlite");
    const day = join(roots.codex, "sessions", "2026", "11", "03");
    mkdirSync(day, { recursive: true });
    const READ = "01a1a296-89bc-7640-a7a1-2e55d66cf5ac", NEVER = "01a19138-a0e1-72a2-9bce-4cdeaf8d4444";
    const f = join(day, `rollout-2026-11-03T01-00-00-${READ}.jsonl`);
    writeFileSync(f, [
      JSON.stringify({ timestamp: "2026-11-03T01:00:00Z", type: "turn_context", payload: { model: "gpt-x" } }),
      JSON.stringify({ timestamp: "2026-11-03T01:00:05Z", type: "event_msg", payload: { type: "token_count", info: {
        total_token_usage: { total_tokens: 120 }, last_token_usage: { input_tokens: 100, output_tokens: 20 } } } }), ""].join("\n"));
    const db = new Database(join(roots.codex, "state_5.sqlite"));
    db.run("create table threads (id text, rollout_path text, created_at integer, tokens_used integer, model text, source text)");
    const created = Date.parse("2026-11-03T01:00:00Z") / 1000;
    db.run("insert into threads values (?, ?, ?, 120, 'gpt-x', 'cli')", [READ, f, created]);
    db.close();
    const st = emptyState();
    const cur: Cursor = {};
    await scanAll(st, cur, roots, NOW);
    expect(row(st, "2026-11-03", "codex")!.u).toEqual([{ m: "gpt-x", i: 100, o: 20, cw: 0, cr: 0 }]);
    rmSync(f); // Codex compressed it (runtime without zstd), moved it, or it was deleted
    const db2 = new Database(join(roots.codex, "state_5.sqlite"));
    db2.run("insert into threads values (?, ?, ?, 50, 'gpt-x', 'cli')", [NEVER, join(day, `rollout-x-${NEVER}.jsonl`), created]);
    db2.close();
    await scanAll(st, cur, roots, NOW);
    expect(row(st, "2026-11-03", "codex")!.u).toEqual([{ m: "gpt-x", i: 150, o: 20, cw: 0, cr: 0 }]); // +50 from NEVER only
  });
});

describe("addEvent", () => {
  test("a finite ts past Date's range is refused (never a NaN day)", () => {
    const st = emptyState();
    expect(addEvent(st, { ts: 1e20, agent: "claude", sessionId: "s", kind: "turn", id: "x" })).toBe(false);
    expect(st.rows.size).toBe(0);
  });
});

describe("upload", () => {
  test("sends exact v1 envelope once, then waits 6 h and for a change", async () => {
    const st = emptyState();
    addEvent(st, { ts: NOW, agent: "claude", sessionId: "s", kind: "turn", id: "a" });
    const calls: any[] = [];
    const fetchFn = (async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body), h: init.headers }); return new Response("{}"); }) as any;
    const config = { url: "https://w", pairingId: "pid", pcSecret: "sec", e2eKey: new Uint8Array(32) } as any;
    expect(await maybeUpload(st, config, NOW, fetchFn, "11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(calls[0].url).toBe("https://w/v1/cc/full");
    expect(calls[0].body).toMatchObject({ v: 2, sessionId: "activity", what: "activity" });
    expect(calls[0].h["x-cc-pairing"]).toBe("pid");
    const { decryptBlob } = await import("./crypto");
    const plain: any = await decryptBlob(config.e2eKey, calls[0].body.blob);
    expect(Object.keys(plain)).toEqual(["v", "gen", "tz", "days", "mid"]);
    expect(plain.v).toBe(1);
    expect(plain.mid).toBe("11111111-1111-4111-8111-111111111111");
    expect(plain.tz).toBe("Asia/Tokyo");
    expect(Object.keys(plain.days[0])).toEqual(["d", "a", "s", "t", "b", "u"]);
    expect(await maybeUpload(st, config, NOW + 7 * 3_600_000, fetchFn)).toBe(false); // unchanged
    addEvent(st, { ts: NOW, agent: "claude", sessionId: "s", kind: "turn", id: "b" });
    expect(await maybeUpload(st, config, NOW + 3_600_000, fetchFn)).toBe(false); // < 6 h
    expect(await maybeUpload(st, config, NOW + 7 * 3_600_000, fetchFn)).toBe(true);
  });

  const okFetch = (calls: any[]) => (async (_u: string, init: any) => { calls.push(init.headers["x-cc-pairing"]); return new Response("{}"); }) as any;
  const cfg = (pairingId: string) => ({ url: "https://w", pairingId, pcSecret: "sec", e2eKey: new Uint8Array(32) }) as any;

  test("a new pairing uploads right away despite a recent upload and the same rows", async () => {
    const st = emptyState();
    addEvent(st, { ts: NOW, agent: "claude", sessionId: "s", kind: "turn", id: "a" });
    const calls: string[] = [];
    expect(await maybeUpload(st, cfg("old"), NOW, okFetch(calls))).toBe(true);
    expect(st.lastPairing).toBe("old");
    expect(await maybeUpload(st, cfg("new"), NOW + 4 * 60_000, okFetch(calls))).toBe(true);
    expect(calls).toEqual(["old", "new"]);
    expect(st.lastPairing).toBe("new");
    expect(await maybeUpload(st, cfg("new"), NOW + 5 * 60_000, okFetch(calls))).toBe(false); // now throttled again
  });

  test("the same pairing stays throttled; a failed upload keeps the old pairing", async () => {
    const st = emptyState();
    addEvent(st, { ts: NOW, agent: "claude", sessionId: "s", kind: "turn", id: "a" });
    const calls: string[] = [];
    expect(await maybeUpload(st, cfg("p"), NOW, okFetch(calls))).toBe(true);
    addEvent(st, { ts: NOW, agent: "claude", sessionId: "s", kind: "turn", id: "b" });
    expect(await maybeUpload(st, cfg("p"), NOW + 60_000, okFetch(calls))).toBe(false);
    const fail = (async () => new Response("", { status: 500 })) as any;
    expect(await maybeUpload(st, cfg("q"), NOW + 60_000, fail)).toBe(false);
    expect(st.lastPairing).toBe("p");
    expect(calls).toEqual(["p"]);
  });

  test("unchanged rows are re-sent after 7 days so the relay's 35-day copy never expires", async () => {
    const st = emptyState();
    addEvent(st, { ts: NOW, agent: "claude", sessionId: "s", kind: "turn", id: "a" });
    const calls: string[] = [];
    expect(await maybeUpload(st, cfg("p"), NOW, okFetch(calls))).toBe(true);
    expect(await maybeUpload(st, cfg("p"), NOW + 6 * 86_400_000, okFetch(calls))).toBe(false);
    expect(await maybeUpload(st, cfg("p"), NOW + 7 * 86_400_000, okFetch(calls))).toBe(true);
    expect(await maybeUpload(st, cfg("p"), NOW + 8 * 86_400_000, okFetch(calls))).toBe(false); // clock restarted
    expect(calls).toEqual(["p", "p"]);
  });

  test("lastPairing round-trips; an old file without it loads and uploads to the current pairing", async () => {
    const st = emptyState();
    addEvent(st, { ts: NOW, agent: "claude", sessionId: "s", kind: "turn", id: "a" });
    st.lastPairing = "p";
    expect(parseState(serializeState(st)).lastPairing).toBe("p");
    const old = JSON.parse(serializeState(st));
    delete old.lastPairing;
    old.lastUpload = NOW; old.lastHash = "x";
    const st2 = parseState(JSON.stringify(old));
    expect(st2.lastPairing).toBe("");
    expect(st2.rows.size).toBe(1);
    expect(st2.lastUpload).toBe(NOW);
    const calls: string[] = [];
    expect(await maybeUpload(st2, cfg("p"), NOW + 60_000, okFetch(calls))).toBe(true); // unknown → re-send once
  });

  test("scan:false re-sends the rows on disk to a new pairing without reading history", async () => {
    const st = emptyState();
    addEvent(st, { ts: NOW, agent: "claude", sessionId: "s", kind: "turn", id: "a" });
    st.lastUpload = NOW; st.lastPairing = "old"; st.lastHash = "h";
    const daysPath = join(dir, "days.json");
    writeFileSync(daysPath, serializeState(st));
    const calls: string[] = [];
    const missing = { claude: join(dir, "nope"), codex: join(dir, "nope"), opencode: join(dir, "nope.db") };
    await runActivityCycle({ config: cfg("new"), daysPath, cursorPath: join(dir, "cur.json"), roots: missing, now: () => NOW + 60_000, fetchFn: okFetch(calls), scan: false });
    expect(calls).toEqual(["new"]);
    expect(parseState(await Bun.file(daysPath).text()).lastPairing).toBe("new");
  });
});

describe("plugin update (lastVersion)", () => {
  const config = { url: "https://w", pairingId: "p", pcSecret: "s", e2eKey: new Uint8Array(32) } as any;
  const ok = (calls: string[]) => (async (url: string) => { calls.push(url); return new Response("{}"); }) as unknown as typeof fetch;
  const turn = (st: State, id: string) => addEvent(st, { ts: NOW - 3_600_000, agent: "claude", sessionId: "b", kind: "turn", id });

  test("a different last-upload version skips the 6 h wait once; then the gate applies again", async () => {
    const calls: string[] = [];
    const st = emptyState();
    turn(st, "e1");
    expect(await maybeUpload(st, config, NOW, ok(calls))).toBe(true);
    expect(st.lastVersion).toBe(PLUGIN_VERSION);
    turn(st, "e2"); // new rows, < 6 h later, same version: gated
    expect(await maybeUpload(st, config, NOW + 60_000, ok(calls))).toBe(false);
    st.lastVersion = "2.4.1"; // the previous version made the last upload
    expect(await maybeUpload(st, config, NOW + 120_000, ok(calls))).toBe(true);
    turn(st, "e3");
    expect(await maybeUpload(st, config, NOW + 180_000, ok(calls))).toBe(false); // gated again
    expect(calls).toHaveLength(2);
  });

  test("a version change alone does not re-send unchanged rows", async () => {
    const calls: string[] = [];
    const st = emptyState();
    turn(st, "e1");
    expect(await maybeUpload(st, config, NOW, ok(calls))).toBe(true);
    st.lastVersion = "2.4.1";
    expect(await maybeUpload(st, config, NOW + 60_000, ok(calls))).toBe(false);
  });

  test("a state file from before lastVersion parses, and its first changed cycle uploads", async () => {
    const st = emptyState();
    turn(st, "e1");
    const old = JSON.parse(serializeState(st));
    Object.assign(old, { lastUpload: NOW, lastHash: "stale", lastPairing: "p" });
    delete old.lastVersion;
    const parsed = parseState(JSON.stringify(old));
    expect(parsed.lastVersion).toBe("");
    expect(parsed.rows.size).toBe(1);
    expect(await maybeUpload(parsed, config, NOW + 60_000, ok([]))).toBe(true);
  });
});

describe("forced upload (reset)", () => {
  test("force bypasses the 6 h gate and the unchanged-hash skip; the normal gates are untouched", async () => {
    const st = emptyState();
    addEvent(st, { ts: NOW - 3_600_000, agent: "claude", sessionId: "b", kind: "turn", id: "e1" });
    const calls: string[] = [];
    const ok = (async (url: string) => { calls.push(url); return new Response("{}"); }) as unknown as typeof fetch;
    const config = { url: "https://w", pairingId: "p", pcSecret: "s", e2eKey: new Uint8Array(32) } as any;
    expect(await maybeUpload(st, config, NOW, ok)).toBe(true);
    expect(await maybeUpload(st, config, NOW + 60_000, ok)).toBe(false); // < 6 h, unchanged: gated
    expect(await maybeUpload(st, config, NOW + 60_000, ok, undefined, true)).toBe(true); // forced
    expect(st.lastUpload).toBe(NOW + 60_000);
    expect(await maybeUpload(st, config, NOW + 120_000, ok)).toBe(false); // the next normal cycle is gated off the forced send
    expect(calls).toHaveLength(2);
    expect(await maybeUpload(emptyState(), config, NOW, ok, undefined, true)).toBe(false); // no rows: nothing to force
  });

  test("runActivityCycle reports sent / empty / not-sent / unpaired", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-act-force-"));
    try {
      const daysPath = join(dir, "days.json");
      const base = { daysPath, cursorPath: join(dir, "cur.json"), roots: { claude: join(dir, "x"), codex: join(dir, "x"), opencode: join(dir, "x") } as any, now: () => NOW, scan: false };
      const config = { url: "https://w", pairingId: "p", pcSecret: "s", e2eKey: new Uint8Array(32) } as any;
      const ok = (async () => new Response("{}")) as unknown as typeof fetch;
      const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
      expect(await runActivityCycle({ ...base, config: null })).toBe("unpaired");
      expect(await runActivityCycle({ ...base, config, fetchFn: ok, force: true })).toBe("empty");
      const st = emptyState();
      addEvent(st, { ts: NOW - 3_600_000, agent: "claude", sessionId: "b", kind: "turn", id: "e1" });
      await writeFile(daysPath, serializeState(st));
      expect(await runActivityCycle({ ...base, config, fetchFn: down, force: true })).toBe("not-sent");
      expect(await runActivityCycle({ ...base, config, fetchFn: ok, force: true })).toBe("sent");
      // the saved lastUpload/hash keep a respawned watchdog from re-sending the same rows
      expect(await runActivityCycle({ ...base, config, fetchFn: ok, now: () => NOW + 60_000 })).toBe("not-sent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("machine id (mid)", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test("random v4 UUID, 0600, stable across runs, regenerated when deleted or garbage", async () => {
    const p = join(dir, "machine-id");
    const a = await loadMachineId(p);
    expect(a).toMatch(UUID);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(await loadMachineId(p)).toBe(a);
    rmSync(p);
    const b = await loadMachineId(p);
    expect(b).toMatch(UUID);
    expect(b).not.toBe(a);
    writeFileSync(p, "not-a-uuid");
    expect(await loadMachineId(p)).toMatch(UUID);
  });

  test("the cycle seals the same mid into every pairing's payload; no mid when not passed", async () => {
    const st = emptyState();
    addEvent(st, { ts: NOW, agent: "claude", sessionId: "s", kind: "turn", id: "a" });
    expect("mid" in buildPayload(st, NOW)).toBe(false);
    const daysPath = join(dir, "days.json");
    writeFileSync(daysPath, serializeState(st));
    const key = new Uint8Array(32);
    const blobs: string[] = [];
    const fetchFn = (async (_u: string, init: any) => { blobs.push(JSON.parse(init.body).blob); return new Response("{}"); }) as any;
    const missing = { claude: join(dir, "nope"), codex: join(dir, "nope"), opencode: join(dir, "nope.db") };
    for (const pid of ["one", "two"]) {
      await runActivityCycle({ config: { url: "https://w", pairingId: pid, pcSecret: "s", e2eKey: key } as any, daysPath, cursorPath: join(dir, "cur.json"), roots: missing, now: () => NOW, fetchFn, scan: false });
    }
    const { decryptBlob } = await import("./crypto");
    const mids = await Promise.all(blobs.map(async (b) => ((await decryptBlob(key, b)) as any).mid));
    expect(mids).toHaveLength(2);
    expect(mids[0]).toMatch(UUID);
    expect(mids[1]).toBe(mids[0]);
    expect(await Bun.file(join(dir, "machine-id")).text()).toBe(mids[0]);
  });
});

describe("activity loop", () => {
  const cfg = (pairingId: string) => ({ url: "https://w", pairingId, pcSecret: "sec", e2eKey: new Uint8Array(32) }) as any;
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  test("first pairing scans, a re-pair re-sends without scanning, and a failed first run keeps the tick armed", async () => {
    jest.useFakeTimers();
    let config: any = null;
    let fail = false;
    const runs: any[] = [];
    const stop = startActivityLoop(async () => config, async (d) => { runs.push({ pid: d?.config?.pairingId ?? null, scan: d?.scan }); if (fail) throw new Error("disk full"); });
    try {
      await flush(); // start-up kick while unpaired
      expect(runs).toEqual([{ pid: null, scan: undefined }]);
      config = cfg("A"); fail = true;
      jest.advanceTimersByTime(60_000); await flush();
      expect(runs[1]).toEqual({ pid: "A", scan: true }); // first pairing: full scan (it fails)
      config = cfg("B");
      jest.advanceTimersByTime(60_000); await flush();
      expect(runs[2]).toEqual({ pid: "B", scan: false }); // re-pair after a FAILED run: still the cheap resend
      jest.advanceTimersByTime(5 * 60_000); await flush();
      expect(runs).toHaveLength(3); // the failed resend is not retried every minute
    } finally { stop(); jest.useRealTimers(); }
  });
});
