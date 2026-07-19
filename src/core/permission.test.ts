import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildPermissionSummary, runPermissionHook, approvalsCommand, NO_HOLD_PATH, TRACE_PATH,
} from "./permission";
import { encryptBlob, decryptBlob } from "./crypto";
import type { Config } from "./shared";

// ---- summary builder (pure) ---------------------------------------------------------------

describe("buildPermissionSummary", () => {
  test("Bash → first line of the command", () => {
    expect(buildPermissionSummary("Bash", { command: "rm -rf build\necho done" })).toBe("rm -rf build");
  });
  test("Bash → truncated to <=80 chars with an ellipsis", () => {
    const long = "echo " + "x".repeat(200);
    const out = buildPermissionSummary("Bash", { command: long });
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });
  test("Edit/Write/Read/NotebookEdit → basename of file_path", () => {
    for (const t of ["Edit", "Write", "Read", "NotebookEdit"]) {
      expect(buildPermissionSummary(t, { file_path: "/Users/x/proj/src/main.ts" })).toBe("main.ts");
    }
  });
  test("WebFetch → URL host", () => {
    expect(buildPermissionSummary("WebFetch", { url: "https://example.com/a/b?q=1" })).toBe("example.com");
  });
  test("WebSearch → query, truncated", () => {
    expect(buildPermissionSummary("WebSearch", { query: "how to nomo" })).toBe("how to nomo");
  });
  test("mcp__ tool → last __-segment", () => {
    expect(buildPermissionSummary("mcp__linear__create_issue", {})).toBe("create_issue");
  });
  test("unknown tool → tool_name verbatim", () => {
    expect(buildPermissionSummary("SomethingElse", {})).toBe("SomethingElse");
  });
  test("missing input fields → falls back to tool_name", () => {
    expect(buildPermissionSummary("Bash", {})).toBe("Bash");
    expect(buildPermissionSummary("Edit", {})).toBe("Edit");
  });
});

// ---- hold state machine -------------------------------------------------------------------

const KEY = new Uint8Array(32).fill(7);
const CONFIG: Config = { url: "https://w.example", pairingId: "p1", pcSecret: "s1", e2eKey: KEY };
const INPUT = JSON.stringify({
  session_id: "sess-1", hook_event_name: "PermissionRequest",
  tool_name: "Bash", tool_input: { command: "rm -rf build" },
  cwd: "/Users/x/proj", transcript_path: "/tmp/t.jsonl",
});
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from phone"}}}';

/** A scripted fetch: `hold` decides the POST reply; `gets` is the sequence of GET reply bodies. */
function scriptFetch(hold: boolean, gets: Array<Record<string, unknown> | "throw">) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let g = 0;
  const fn = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url.endsWith("/v1/cc/decision")) return new Response(JSON.stringify({ hold }), { status: 200 });
    // GET /v1/cc/decision/<id>
    const next = gets[Math.min(g++, gets.length - 1)];
    if (next === "throw") throw new Error("network");
    return new Response(JSON.stringify(next), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const baseDeps = (over: Record<string, unknown>) => ({
  readInput: async () => INPUT,
  loadConfigFn: async () => CONFIG,
  readRecordFn: async () => null,
  sleep: async () => {},
  now: () => 1000,
  randomUUID: () => "req-fixed",
  jitter: () => 0,
  noHoldPath: "/does/not/exist/no-hold",
  delegate: async () => { throw new Error("delegate must not run"); },
  trace: () => {}, // noop by default — tests must not touch the real trace file or install signal handlers
  ...over,
});

describe("runPermissionHook — hold state machine", () => {
  test("hold=false → POST only, no polling, no stdout", async () => {
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(calls.filter((c) => c.method === "POST").length).toBe(1);
    expect(calls.filter((c) => c.method === "GET").length).toBe(0);
    expect(emitted).toEqual([]);
  });

  test("POST body is the frozen wire shape: decisionPending blob + needsAttention fallbackBlob", async () => {
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: () => {} }) as never);
    const post = calls.find((c) => c.method === "POST")!;
    const body = JSON.parse(post.body!);
    expect(body).toMatchObject({ v: 2, sessionId: "sess-1", requestId: "req-fixed", op: "update", prio: 1, ts: 1000 });
    expect(typeof body.blob).toBe("string");
    expect(typeof body.fallbackBlob).toBe("string");
    const blob = (await decryptBlob(KEY, body.blob)) as Record<string, unknown>;
    expect(blob.status).toBe("decisionPending");
    expect(blob.permissionSummary).toBe("rm -rf build");
    expect(blob.permissionRequestId).toBe("req-fixed");
    // appended LAST inside the sealed JSON (append-last discipline for the iOS decoder)
    expect(Object.keys(blob).slice(-2)).toEqual(["permissionSummary", "permissionRequestId"]);
    const fb = (await decryptBlob(KEY, body.fallbackBlob)) as Record<string, unknown>;
    expect(fb.status).toBe("needsAttention");
    expect("permissionSummary" in fb).toBe(false);
    expect("permissionRequestId" in fb).toBe(false);
  });

  test("hold=true, answered allow → emits exactly the allow line", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [{ status: "pending" }, { status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);
    expect(calls.filter((c) => c.method === "GET").length).toBe(2);
  });

  test("answered deny → emits the deny line", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "deny", ts: 5 });
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([DENY]);
  });

  test("requestId mismatch inside the sealed answer → silent (replay guard)", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "someone-else", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([]);
  });

  test("status=expired → stops, silent", async () => {
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, [{ status: "pending" }, { status: "expired" }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([]);
  });

  test("transient GET failure is tolerated — keeps polling", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, ["throw", { status: "pending" }, { status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);
  });

  test("gives up silently after sustained poll failures (fail open)", async () => {
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, ["throw"]); // every GET fails forever (script repeats last entry)
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([]);
    expect(calls.filter((c) => c.method === "GET").length).toBe(100); // MAX_CONSECUTIVE_MISSES
  });

  test("network error on the POST → fail open, silent, no throw", async () => {
    const emitted: string[] = [];
    const fn = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([]);
  });

  test("POST times out once then the retry succeeds → holds and answers normally", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const gets: Array<Record<string, unknown>> = [{ status: "pending" }, { status: "answered", answerBlob }];
    const emitted: string[] = [];
    const events: Array<{ event: string; attempt?: number }> = [];
    let postCount = 0;
    let g = 0;
    const fn = (async (url: string) => {
      if (url.endsWith("/v1/cc/decision")) {
        postCount += 1;
        if (postCount === 1) { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; }
        return new Response(JSON.stringify({ hold: true }), { status: 200 });
      }
      return new Response(JSON.stringify(gets[Math.min(g++, gets.length - 1)]), { status: 200 });
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      trace: (e: { event: string; attempt?: number }) => events.push(e),
    }) as never);
    expect(postCount).toBe(2);              // first attempt threw, second succeeded
    expect(emitted).toEqual([ALLOW]);       // proceeded to poll + answer normally
    expect(events.filter((e) => e.event === "posted").map((e) => e.attempt)).toEqual([1, 2]);
  });

  test("both POST attempts fail → fail open silent, trace shows two posted attempts", async () => {
    const emitted: string[] = [];
    const events: Array<{ event: string; attempt?: number; reason?: string }> = [];
    let postCount = 0;
    const fn = (async () => { postCount += 1; const e = new Error("timeout"); e.name = "TimeoutError"; throw e; }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      trace: (e: { event: string; attempt?: number; reason?: string }) => events.push(e),
    }) as never);
    expect(postCount).toBe(2);
    expect(emitted).toEqual([]);
    expect(events.filter((e) => e.event === "posted").map((e) => e.attempt)).toEqual([1, 2]);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "post-error" });
  });

  test("unpaired (no config) → no output, no network at all", async () => {
    let fetched = false;
    const fn = (async () => { fetched = true; return new Response("{}"); }) as unknown as typeof fetch;
    const emitted: string[] = [];
    await runPermissionHook(baseDeps({ fetchFn: fn, loadConfigFn: async () => null, emit: (l: string) => emitted.push(l) }) as never);
    expect(fetched).toBe(false);
    expect(emitted).toEqual([]);
  });

  test("trace seam captures the hold lifecycle (collector injected)", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    const { fn } = scriptFetch(true, [{ status: "pending" }, { status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {},
      trace: (e: { event: string }) => events.push(e as { event: string }),
    }) as never);
    const names = events.map((e) => e.event);
    // lifecycle in order: stdin → start → POST → hold → poll pairs → answer/emit → exit
    expect(names).toEqual([
      "stdin-read", "start", "posted", "hold",
      "poll-begin", "poll-end", "poll-begin", "poll-end",
      "emit", "answered", "exit",
    ]);
    expect(events.find((e) => e.event === "emit")).toMatchObject({ decision: "allow" });
    expect(events.find((e) => e.event === "answered")).toMatchObject({ match: true });
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "answered" });
    // every poll-begin has a matching poll-end (a lone begin would mean death mid-fetch)
    expect(names.filter((n) => n === "poll-begin").length).toBe(names.filter((n) => n === "poll-end").length);
  });

  test("giveup path traces a giveup + exit event", async () => {
    const events: Array<{ event: string }> = [];
    const { fn } = scriptFetch(true, ["throw"]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {},
      trace: (e: { event: string }) => events.push(e as { event: string }),
    }) as never);
    expect(events.some((e) => e.event === "giveup")).toBe(true);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "giveup" });
  });

  test("no-hold flag present → delegates, never POSTs a decision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-nohold-"));
    const flag = join(dir, "no-hold");
    await writeFile(flag, "");
    let delegated = false;
    let fetched = false;
    const fn = (async () => { fetched = true; return new Response("{}"); }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, noHoldPath: flag, emit: () => {},
      delegate: async () => { delegated = true; },
    }) as never);
    expect(delegated).toBe(true);
    expect(fetched).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

// ---- escape-hatch command -----------------------------------------------------------------

describe("approvalsCommand (on/off/status)", () => {
  test("off creates the flag, on removes it, status reports each state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-appr-"));
    const flag = join(dir, "no-hold");
    const lines: string[] = [];
    const deps = { noHoldPath: flag, print: (l: string) => lines.push(l) };

    expect(await approvalsCommand("off", deps)).toBe(0);
    await expect(readFile(flag, "utf8")).resolves.toBe(""); // flag now exists

    lines.length = 0;
    expect(await approvalsCommand("status", deps)).toBe(0);
    expect(lines.join("\n").toLowerCase()).toContain("off");

    expect(await approvalsCommand("on", deps)).toBe(0);
    await expect(readFile(flag, "utf8")).rejects.toThrow(); // flag removed

    lines.length = 0;
    expect(await approvalsCommand("status", deps)).toBe(0);
    expect(lines.join("\n").toLowerCase()).toContain("on");
    await rm(dir, { recursive: true, force: true });
  });
});

test("NO_HOLD_PATH sits under the cc-status config dir", () => {
  expect(NO_HOLD_PATH.endsWith("/.config/cc-status/no-hold")).toBe(true);
});

test("TRACE_PATH sits under the cc-status config dir", () => {
  expect(TRACE_PATH.endsWith("/.config/cc-status/permission-trace.log")).toBe(true);
});
