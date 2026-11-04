process.env.TZ = "Asia/Tokyo"; // before any Date use: day bucketing is local-time

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addEvent, buildPayload, Cursor, emptyState, freeze, localDate, maybeUpload, parseClaudeLine, parseCodexLine,
  parseState, runActivityCycle, scanAll, serializeState, State,
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

describe("upload", () => {
  test("sends exact v1 envelope once, then waits 6 h and for a change", async () => {
    const st = emptyState();
    addEvent(st, { ts: NOW, agent: "claude", sessionId: "s", kind: "turn", id: "a" });
    const calls: any[] = [];
    const fetchFn = (async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body), h: init.headers }); return new Response("{}"); }) as any;
    const config = { url: "https://w", pairingId: "pid", pcSecret: "sec", e2eKey: new Uint8Array(32) } as any;
    expect(await maybeUpload(st, config, NOW, fetchFn)).toBe(true);
    expect(calls[0].url).toBe("https://w/v1/cc/full");
    expect(calls[0].body).toMatchObject({ v: 2, sessionId: "activity", what: "activity" });
    expect(calls[0].h["x-cc-pairing"]).toBe("pid");
    const { decryptBlob } = await import("./crypto");
    const plain: any = await decryptBlob(config.e2eKey, calls[0].body.blob);
    expect(Object.keys(plain)).toEqual(["v", "gen", "tz", "days"]);
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
