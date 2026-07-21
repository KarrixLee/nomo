import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildPermissionSummary, buildPermissionDetail, runPermissionHook, approvalsCommand, NO_HOLD_PATH, TRACE_PATH,
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
  test("ExitPlanMode → fixed 'Approve Claude's plan' (the plan itself rides in the detail)", () => {
    expect(buildPermissionSummary("ExitPlanMode", {})).toBe("Approve Claude's plan");
    expect(buildPermissionSummary("ExitPlanMode", { plan: "# do a bunch of stuff" })).toBe("Approve Claude's plan");
  });
  test("unknown tool → tool_name verbatim", () => {
    expect(buildPermissionSummary("SomethingElse", {})).toBe("SomethingElse");
  });
  test("missing input fields → falls back to tool_name", () => {
    expect(buildPermissionSummary("Bash", {})).toBe("Bash");
    expect(buildPermissionSummary("Edit", {})).toBe("Edit");
  });
});

// ---- detail builder (pure) — fuller context for the phone card, hard 400-char cap ----------

describe("buildPermissionDetail", () => {
  test("Bash → the FULL command, all lines (summary is only the first line)", () => {
    expect(buildPermissionDetail("Bash", { command: "cd proj\nbun test\necho done" })).toBe("cd proj\nbun test\necho done");
  });
  test("Bash → capped at 400 chars with an ellipsis", () => {
    const out = buildPermissionDetail("Bash", { command: "x".repeat(1000) });
    expect(out.length).toBe(400);
    expect(out.endsWith("…")).toBe(true);
  });
  test("Edit/Write/Read/NotebookEdit → the FULL file_path (not just the basename)", () => {
    for (const t of ["Edit", "Write", "Read", "NotebookEdit"]) {
      expect(buildPermissionDetail(t, { file_path: "/Users/x/proj/src/main.ts" })).toBe("/Users/x/proj/src/main.ts");
    }
  });
  test("WebFetch → full url; WebSearch → full query", () => {
    expect(buildPermissionDetail("WebFetch", { url: "https://example.com/a/b?q=1" })).toBe("https://example.com/a/b?q=1");
    expect(buildPermissionDetail("WebSearch", { query: "how to nomo" })).toBe("how to nomo");
  });
  test("ExitPlanMode → the plan markdown, capped at 400", () => {
    expect(buildPermissionDetail("ExitPlanMode", { plan: "## Plan\n- step one\n- step two" })).toBe("## Plan\n- step one\n- step two");
    const long = buildPermissionDetail("ExitPlanMode", { plan: "p".repeat(900) });
    expect(long.length).toBe(400);
    expect(long.endsWith("…")).toBe(true);
  });
  test("unknown tool / missing fields → empty string (omitted from the blob)", () => {
    expect(buildPermissionDetail("SomethingElse", { command: "x" })).toBe("");
    expect(buildPermissionDetail("Bash", {})).toBe("");
    expect(buildPermissionDetail("Edit", {})).toBe("");
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

/** A scripted fetch: `hold` decides the POST reply — a single boolean applies to every POST, or an
 *  array supplies a per-POST-call sequence (repeating the last entry) so the hold-retry re-POST can
 *  answer differently from the first. `gets` is the sequence of GET reply bodies. */
function scriptFetch(hold: boolean | boolean[], gets: Array<Record<string, unknown> | "throw">) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let g = 0;
  let p = 0;
  const holdFor = () => (Array.isArray(hold) ? hold[Math.min(p++, hold.length - 1)] : hold);
  const fn = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url.endsWith("/v1/cc/decision")) return new Response(JSON.stringify({ hold: holdFor() }), { status: 200 });
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
  test("hold=false twice (first ask + post-race re-ask) → silent, exactly 2 POSTs, no polling", async () => {
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(calls.filter((c) => c.method === "POST").length).toBe(2); // initial + one re-ask after the wait
    expect(calls.filter((c) => c.method === "GET").length).toBe(0);
    expect(emitted).toEqual([]);
  });

  test("hold=false + ESTABLISHED session (record ts 10 min old) → exactly 1 POST, immediate silent exit", async () => {
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(false, []);
    const record = { pid: 1, machine: "m", label: "l", ts: 1_000_000 - 10 * 60_000 }; // well past FRESH_SESSION_MS
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      now: () => 1_000_000, readRecordFn: async () => record,
    }) as never);
    expect(calls.filter((c) => c.method === "POST").length).toBe(1); // NO re-ask — established session falls open at once
    expect(calls.filter((c) => c.method === "GET").length).toBe(0);
    expect(emitted).toEqual([]);
  });

  test("hold=false + FRESH session (record ts 5 s old) → re-asks (2 POSTs)", async () => {
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(false, []);
    const record = { pid: 1, machine: "m", label: "l", ts: 1_000_000 - 5_000 }; // inside FRESH_SESSION_MS
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      now: () => 1_000_000, readRecordFn: async () => record,
    }) as never);
    expect(calls.filter((c) => c.method === "POST").length).toBe(2); // young session still races the auto-add → re-ask
    expect(emitted).toEqual([]);
  });

  test("hold=false then hold=true on the re-ask → holds and answers normally", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    // first POST loses the island-auto-add race (hold:false), the 4s-later re-POST wins it (hold:true)
    const { fn, calls } = scriptFetch([false, true], [{ status: "pending" }, { status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);
    expect(calls.filter((c) => c.method === "POST").length).toBe(2);
    expect(calls.filter((c) => c.method === "GET").length).toBe(2);
  });

  test("hold=true on the first ask → NO re-ask (single POST)", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);
    expect(calls.filter((c) => c.method === "POST").length).toBe(1);
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
    expect(blob.permissionToolName).toBe("Bash");
    expect(blob.permissionDetail).toBe("rm -rf build"); // full command (single-line here)
    // appended LAST inside the sealed JSON (append-last discipline for the iOS decoder):
    // permissionSummary, permissionRequestId, permissionToolName, then permissionDetail (Bash → present).
    expect(Object.keys(blob).slice(-4)).toEqual(
      ["permissionSummary", "permissionRequestId", "permissionToolName", "permissionDetail"]);
    const fb = (await decryptBlob(KEY, body.fallbackBlob)) as Record<string, unknown>;
    expect(fb.status).toBe("needsAttention");
    expect("permissionSummary" in fb).toBe(false);
    expect("permissionRequestId" in fb).toBe(false);
    expect("permissionToolName" in fb).toBe(false);
    expect("permissionDetail" in fb).toBe(false);
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

// ---- pass-through gates (subagent / permission_mode) --------------------------------------
//
// The hold must never block a non-interactive/auto flow: an `agent_id` (subagent sidechain) or a
// non-interactive permission_mode ("auto"/"dontAsk"/"bypassPermissions"/unknown) exits 0 with zero
// output and — crucially — zero network, BEFORE any POST.

/** INPUT with extra top-level fields merged in (agent_id, permission_mode, …). */
const inputWith = (extra: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(INPUT), ...extra });

/** A fetch that records whether it was ever called — the gate must reach NONE of these. */
function spyFetch() {
  let called = false;
  const fn = (async () => { called = true; return new Response(JSON.stringify({ hold: false }), { status: 200 }); }) as unknown as typeof fetch;
  return { fn, called: () => called };
}

describe("runPermissionHook — pass-through gates", () => {
  test("agent_id present (subagent) → pass-through BEFORE any fetch, silent", async () => {
    const spy = spyFetch();
    const emitted: string[] = [];
    const events: Array<{ event: string; reason?: string; agent_type?: unknown }> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ agent_id: "agent-abc", agent_type: "Explore" }),
      fetchFn: spy.fn, emit: (l: string) => emitted.push(l),
      trace: (e: { event: string; reason?: string }) => events.push(e),
    }) as never);
    expect(spy.called()).toBe(false); // zero network — gate fired before the POST
    expect(emitted).toEqual([]);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "subagent", agent_type: "Explore" });
  });

  test("empty-string agent_id is NOT a subagent → proceeds to the POST path", async () => {
    const spy = spyFetch();
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ agent_id: "" }),
      fetchFn: spy.fn, emit: () => {},
    }) as never);
    expect(spy.called()).toBe(true); // empty agent_id ⇒ main thread ⇒ hold path runs
  });

  for (const mode of ["auto", "dontAsk", "bypassPermissions"]) {
    test(`permission_mode="${mode}" → pass-through BEFORE any fetch, silent`, async () => {
      const spy = spyFetch();
      const emitted: string[] = [];
      const events: Array<{ event: string; reason?: string; mode?: unknown }> = [];
      await runPermissionHook(baseDeps({
        readInput: async () => inputWith({ permission_mode: mode }),
        fetchFn: spy.fn, emit: (l: string) => emitted.push(l),
        trace: (e: { event: string; reason?: string }) => events.push(e),
      }) as never);
      expect(spy.called()).toBe(false);
      expect(emitted).toEqual([]);
      expect(events.at(-1)).toMatchObject({ event: "exit", reason: "mode", mode });
    });
  }

  test("unrecognized future permission_mode → pass-through (fail-open bias)", async () => {
    const spy = spyFetch();
    const events: Array<{ event: string; reason?: string; mode?: unknown }> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ permission_mode: "someFutureMode" }),
      fetchFn: spy.fn, emit: () => {},
      trace: (e: { event: string; reason?: string }) => events.push(e),
    }) as never);
    expect(spy.called()).toBe(false);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "mode", mode: "someFutureMode" });
  });

  for (const mode of ["default", "acceptEdits", "plan"]) {
    test(`permission_mode="${mode}" → PROCEEDS to the POST path (holdable dialog mode)`, async () => {
      const spy = spyFetch();
      await runPermissionHook(baseDeps({
        readInput: async () => inputWith({ permission_mode: mode }),
        fetchFn: spy.fn, emit: () => {},
      }) as never);
      expect(spy.called()).toBe(true);
    });
  }

  test("MISSING permission_mode (older CC) → PROCEEDS to the POST path (prior behavior)", async () => {
    const spy = spyFetch();
    await runPermissionHook(baseDeps({
      readInput: async () => INPUT, // no permission_mode, no agent_id
      fetchFn: spy.fn, emit: () => {},
    }) as never);
    expect(spy.called()).toBe(true);
  });

  test("start trace carries permission_mode and the agent boolean", async () => {
    const spy = spyFetch();
    const events: Array<{ event: string; permission_mode?: unknown; agent?: unknown }> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ permission_mode: "default" }),
      fetchFn: spy.fn, emit: () => {},
      trace: (e: { event: string }) => events.push(e),
    }) as never);
    expect(events.find((e) => e.event === "start")).toMatchObject({ permission_mode: "default", agent: false });
  });
});

// ---- always-allow / deny-with-message / unknown-decision / richer context / question gate ---
//
// These drive the REAL hold loop through the harness (scripted fetch + injected answer blob), never a
// mock of the module under test: a hold that reaches "answered" with each decision kind, plus the
// question pass-through that never holds at all.

describe("runPermissionHook — always-allow / deny-message / unknown decision", () => {
  /** Hold, then answer with the given decrypted answer object; returns the emitted stdout lines. */
  const answerWith = async (answer: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, ...answer });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l), ...over }) as never);
    return { emitted, calls };
  };

  test("allow_always WITH permission_suggestions → behavior allow + updatedPermissions === the suggestions VERBATIM", async () => {
    const SUGG = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }], behavior: "allow", destination: "session" }];
    const { emitted } = await answerWith(
      { decision: "allow_always" },
      { readInput: async () => inputWith({ permission_suggestions: SUGG }) },
    );
    expect(emitted.length).toBe(1);
    const decision = JSON.parse(emitted[0]).hookSpecificOutput.decision;
    expect(decision.behavior).toBe("allow");
    expect(decision.updatedPermissions).toEqual(SUGG); // passed through byte-for-byte
  });

  test("allow_always with NO suggestions → a whole-tool, session-scoped addRules for the tool_name", async () => {
    const { emitted } = await answerWith({ decision: "allow_always" }); // INPUT = Bash, no permission_suggestions
    const decision = JSON.parse(emitted[0]).hookSpecificOutput.decision;
    expect(decision.behavior).toBe("allow");
    expect(decision.updatedPermissions).toEqual([
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
    ]);
  });

  test("allow_always with an EMPTY suggestions array → still the whole-tool session rule", async () => {
    const { emitted } = await answerWith(
      { decision: "allow_always" },
      { readInput: async () => inputWith({ permission_suggestions: [] }) },
    );
    expect(JSON.parse(emitted[0]).hookSpecificOutput.decision.updatedPermissions).toEqual([
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
    ]);
  });

  test("deny WITH a custom message → behavior deny + the phone's message", async () => {
    const { emitted } = await answerWith({ decision: "deny", message: "use bun instead" });
    expect(JSON.parse(emitted[0]).hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "use bun instead" });
  });

  test("deny with a 600-char message → truncated to 500", async () => {
    const { emitted } = await answerWith({ decision: "deny", message: "x".repeat(600) });
    const msg = JSON.parse(emitted[0]).hookSpecificOutput.decision.message;
    expect(msg.length).toBe(500);
    expect(msg).toBe("x".repeat(500));
  });

  test("deny WITHOUT a message → byte-identical to the frozen DENY line", async () => {
    const { emitted } = await answerWith({ decision: "deny" });
    expect(emitted).toEqual([DENY]);
  });

  test("deny with a whitespace-only message → also the frozen DENY line", async () => {
    const { emitted } = await answerWith({ decision: "deny", message: "   " });
    expect(emitted).toEqual([DENY]);
  });

  test("plain allow still emits the frozen ALLOW line byte-identical", async () => {
    const { emitted } = await answerWith({ decision: "allow" });
    expect(emitted).toEqual([ALLOW]);
  });

  test("UNKNOWN decision → nothing emitted, keeps polling; a later allow answers normally", async () => {
    const unknownBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "some_future_verb", ts: 5 });
    const allowBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 6 });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [
      { status: "answered", answerBlob: unknownBlob },
      { status: "answered", answerBlob: allowBlob },
    ]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);                                    // never guessed a line for the unknown verb
    expect(calls.filter((c) => c.method === "GET").length).toBe(2);      // kept polling PAST the unknown answer
  });
});

// ---- richer context: the decision blob's permissionToolName / permissionDetail ----------------

describe("runPermissionHook — decision blob detail fields", () => {
  const postedBlob = async (over: Record<string, unknown>) => {
    const { fn, calls } = scriptFetch(false, []); // hold:false is fine — the POST body is built regardless
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: () => {}, ...over }) as never);
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    return { body, blob: (await decryptBlob(KEY, body.blob)) as Record<string, unknown> };
  };

  test("Bash → permissionToolName 'Bash' + permissionDetail is the FULL multi-line command", async () => {
    const cmd = "cd /Users/x/proj\nbun test\necho done";
    const { blob } = await postedBlob({ readInput: async () => inputWith({ tool_input: { command: cmd } }) });
    expect(blob.permissionToolName).toBe("Bash");
    expect(blob.permissionDetail).toBe(cmd); // all lines — the summary took only the first
  });

  test("Edit → permissionDetail is the FULL file_path (summary is just the basename)", async () => {
    const { blob } = await postedBlob({
      readInput: async () => inputWith({ tool_name: "Edit", tool_input: { file_path: "/Users/x/proj/src/main.ts" } }),
    });
    expect(blob.permissionToolName).toBe("Edit");
    expect(blob.permissionDetail).toBe("/Users/x/proj/src/main.ts");
  });

  test("empty detail (unknown tool) → permissionDetail key OMITTED, permissionToolName still present", async () => {
    const { blob } = await postedBlob({
      readInput: async () => inputWith({ tool_name: "SomethingElse", tool_input: {} }),
    });
    expect(blob.permissionToolName).toBe("SomethingElse");
    expect("permissionDetail" in blob).toBe(false);
  });

  // Step 3: the worker rejects a decision POST whose `blob` exceeds MAX_BLOB_CHARS (3072 base64 chars —
  // enforced server-side, NOT in this plugin; encryptBlob never hard-fails on size). A 400-char detail
  // plus the fattest realistic fields (80-char summary, a 120-char title) stays far under that ceiling.
  test("a 400-char detail + typical fields keeps the sealed blob under the worker's 3072-char cap", async () => {
    const record = { pid: 1, machine: "m", label: "l", title: "y".repeat(120), ts: 1000 };
    const { body } = await postedBlob({
      readRecordFn: async () => record,
      readInput: async () => inputWith({ tool_input: { command: "x".repeat(1000) } }), // detail caps to 400
    });
    expect(body.blob.length).toBeLessThanOrEqual(3072);
  });
});

// ---- AskUserQuestion pass-through (a bare Allow/Deny card is the wrong surface for a question) -----

describe("runPermissionHook — AskUserQuestion pass-through", () => {
  test("tool_name AskUserQuestion → delegates (fire-and-forget attention), NO POST, nothing on stdout", async () => {
    const spy = spyFetch();
    const emitted: string[] = [];
    let delegated = false;
    const events: Array<{ event: string; reason?: string }> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ tool_name: "AskUserQuestion" }),
      fetchFn: spy.fn, emit: (l: string) => emitted.push(l),
      delegate: async () => { delegated = true; },
      trace: (e: { event: string; reason?: string }) => events.push(e),
    }) as never);
    expect(delegated).toBe(true);          // reused the exact no-hold delegate
    expect(spy.called()).toBe(false);      // never POSTed a decision — questions are not held
    expect(emitted).toEqual([]);           // no stdout
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "question-passthrough" });
  });

  test("AskUserQuestion in an AUTO mode → the mode gate fires FIRST (no delegate, no POST)", async () => {
    const spy = spyFetch();
    let delegated = false;
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ tool_name: "AskUserQuestion", permission_mode: "auto" }),
      fetchFn: spy.fn, emit: () => {},
      delegate: async () => { delegated = true; },
    }) as never);
    expect(delegated).toBe(false);         // mode gate returns before the question gate is reached
    expect(spy.called()).toBe(false);
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
