// Tests for the Devin approval hold (core/devin-approval.ts): the stdin it builds, the decision
// translation, and runs through the REAL shared relay (runPermissionHook) with a scripted worker.
// Nothing here touches the network or the real Nomo state dir.

import { describe, expect, test } from "bun:test";
import { decryptBlob, encryptBlob } from "./crypto";
import {
  DEVIN_APPROVAL_TIMEOUT_S, DEVIN_ENTRY_CAP_MS, DEVIN_HOLD_DEADLINE_MS, devinDecision, devinPermissionStdin, runDevinApproval,
} from "./devin-approval";
import type { Config } from "./shared";

const KEY = new Uint8Array(32).fill(7);
const CONFIG: Config = { url: "https://relay.invalid", pairingId: "pairing-1", pcSecret: "secret", e2eKey: KEY };
const ENV = { DEVIN_PROJECT_DIR: "/w/api" };
const payload = (tool_name: string, tool_input: Record<string, unknown>) =>
  ({ hook_event_name: "PermissionRequest", session_id: "brawny-shirt", prompt_id: "p1", tool_use_id: "t1", tool_name, tool_input });
const EXEC = payload("exec", { command: "rm -rf build" });

describe("devinDecision", () => {
  const hso = (decision: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  test("phone allow (any variant) → approve; deny → block with the note or the default", () => {
    expect(devinDecision(hso({ behavior: "allow" }))).toBe('{"decision":"approve"}');
    expect(devinDecision(hso({ behavior: "allow", updatedPermissions: [{ type: "addRules" }] }))).toBe('{"decision":"approve"}'); // allow_always on an old phone
    expect(devinDecision(hso({ behavior: "deny", message: "use bun" }))).toBe('{"decision":"block","reason":"use bun"}');
    expect(devinDecision(hso({ behavior: "deny" }))).toBe('{"decision":"block","reason":"Denied from phone"}');
    expect(devinDecision(undefined)).toBe("");
    expect(devinDecision("garbage")).toBe("");
    expect(devinDecision(hso({ behavior: "ask" }))).toBe("");
  });
});

describe("devinPermissionStdin", () => {
  test("Claude-shaped, with mapped tool names and Devin's tool_input passed through", () => {
    const s = JSON.parse(devinPermissionStdin(EXEC, "/w/api")!);
    expect(s).toEqual({ session_id: "brawny-shirt", cwd: "/w/api", hook_event_name: "PermissionRequest", tool_name: "shell", tool_input: { command: "rm -rf build" } });
    expect(s.permission_mode).toBeUndefined();
    expect(s.agent_id).toBeUndefined();
    const name = (tool: string, input: Record<string, unknown> = { file_path: "/w/a.ts" }) => JSON.parse(devinPermissionStdin(payload(tool, input))!).tool_name;
    expect(name("write")).toBe("Write");
    expect(name("edit")).toBe("Edit");
    expect(name("read")).toBe("Read");
    expect(name("webfetch", { url: "https://x" })).toBe("WebFetch");
    expect(name("mcp__github__create_issue", {})).toBe("mcp__github__create_issue");
    expect(JSON.parse(devinPermissionStdin(payload("write", { file_path: "/w/a.ts", content: "hi" }))!).tool_input.file_path).toBe("/w/a.ts");
  });
  test("ask_user_question and unsafe ids never hold", () => {
    expect(devinPermissionStdin({ session_id: "s", tool_name: "ask_user_question", tool_input: {} })).toBeUndefined();
    expect(devinPermissionStdin({ session_id: "../x", tool_name: "exec", tool_input: {} })).toBeUndefined();
    expect(devinPermissionStdin({ tool_name: "exec", tool_input: {} })).toBeUndefined();
    expect(devinPermissionStdin({ session_id: "s", tool_input: {} })).toBeUndefined();
  });
});

describe("runDevinApproval — seams", () => {
  test("passes agent 'devin', a deadline, and returns the translated line", async () => {
    let seen: { agent?: string; deadlineAt?: number; stdin?: string } = {};
    const out = await runDevinApproval(JSON.stringify(EXEC), {
      env: ENV, hold: { now: () => 5_000 },
      run: (async (deps: { deadlineAt?: number; readInput?: () => Promise<string>; emit?: (l: string) => void }, agent: string) => {
        seen = { agent, deadlineAt: deps.deadlineAt, stdin: await deps.readInput!() };
        deps.emit!(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }));
      }) as never,
    });
    expect(out).toBe('{"decision":"approve"}');
    expect(seen.agent).toBe("devin");
    expect(seen.deadlineAt).toBe(5_000 + DEVIN_HOLD_DEADLINE_MS);
    expect(JSON.parse(seen.stdin!)).toMatchObject({ tool_name: "shell", cwd: "/w/api" });
  });

  test("paused approvals delegate to the producer and print nothing", async () => {
    let delegated = 0;
    const out = await runDevinApproval(JSON.stringify(EXEC), {
      env: ENV, delegate: async () => { delegated++; },
      run: (async (deps: { delegate?: () => Promise<void> }) => { await deps.delegate!(); }) as never,
    });
    expect(delegated).toBe(1);
    expect(out).toBe("");
  });

  test("abandoned hold prints nothing", async () => {
    const out = await runDevinApproval(JSON.stringify(EXEC), {
      env: ENV, abandoned: () => true,
      run: (async (deps: { abandoned?: () => boolean; emit?: (l: string) => void }) => {
        if (!deps.abandoned!()) deps.emit!("{}");
      }) as never,
    });
    expect(out).toBe("");
  });

  test("outside Devin (no DEVIN_PROJECT_DIR) → no hold at all; junk / a throwing relay → no opinion", async () => {
    let started = false;
    const run = (async () => { started = true; }) as never;
    expect(await runDevinApproval(JSON.stringify(EXEC), { env: {}, run })).toBe("");
    expect(started).toBe(false);
    for (const raw of ["", "garbage", "[]", "null"]) expect(await runDevinApproval(raw, { env: ENV, run })).toBe("");
    expect(started).toBe(false);
    expect(await runDevinApproval(JSON.stringify(EXEC), { env: ENV, run: (async () => { throw new Error("boom"); }) as never })).toBe("");
  });

  test("timeouts nest strictly inside the hook timeout", () => {
    expect(DEVIN_HOLD_DEADLINE_MS).toBeLessThan(DEVIN_ENTRY_CAP_MS);
    expect(DEVIN_ENTRY_CAP_MS).toBeLessThan(DEVIN_APPROVAL_TIMEOUT_S * 1000);
  });
});

/** A scripted worker: the decision POST grants `hold` (and its sealed card is kept), each GET returns
 *  the next scripted body. */
function worker(hold: boolean, gets: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  const cards: string[] = [];
  let g = 0;
  const fn = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url.replace(CONFIG.url, "")}`);
    if (url.endsWith("/v1/cc/full")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.endsWith("/v1/cc/decision")) {
      cards.push((JSON.parse(init?.body ?? "{}") as { blob?: string }).blob ?? "");
      return new Response(JSON.stringify({ hold }), { status: 200 });
    }
    return new Response(JSON.stringify(gets[Math.min(g++, gets.length - 1)] ?? {}), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls, cards };
}

describe("runDevinApproval — through the shared relay", () => {
  let clock = 1_000;
  const hold = (over: Record<string, unknown>) => ({
    loadConfigFn: async () => CONFIG, readRecordFn: async () => null, sleep: async () => { clock += 3_000; },
    now: () => clock, randomUUID: () => "req-devin", jitter: () => 0, noHoldPath: "/does/not/exist/no-hold",
    trace: () => {}, ...over,
  });
  const answered = async (answer: object) => ({ status: "answered", answerBlob: await encryptBlob(KEY, { requestId: "req-devin", ...answer }) });
  const run = (deps: Record<string, unknown>, input: object = EXEC, extra: Record<string, unknown> = {}) =>
    runDevinApproval(JSON.stringify(input), { env: ENV, abandoned: () => false, hold: hold(deps) as never, ...extra });

  test("phone Allow → approve; the card is a sealed agent:devin decisionPending shell card", async () => {
    const w = worker(true, [{ status: "pending" }, await answered({ decision: "allow" })]);
    expect(await run({ fetchFn: w.fn })).toBe('{"decision":"approve"}');
    expect(w.calls).toContain("POST /v1/cc/decision");
    const card = await decryptBlob(KEY, w.cards[0]!) as Record<string, unknown>;
    expect(card).toMatchObject({ agent: "devin", status: "decisionPending", permissionToolName: "shell", permissionDetail: "rm -rf build", permissionRequestId: "req-devin" });
  });

  test("phone Deny with a note → block + the note; bare Deny → the default reason", async () => {
    expect(await run({ fetchFn: worker(true, [await answered({ decision: "deny", message: "use bun" })]).fn }))
      .toBe('{"decision":"block","reason":"use bun"}');
    expect(await run({ fetchFn: worker(true, [await answered({ decision: "deny" })]).fn }))
      .toBe('{"decision":"block","reason":"Denied from phone"}');
  });

  test("allow_always and allow_mode lines translate to approve (old phone, new plugin)", async () => {
    expect(await run({ fetchFn: worker(true, [await answered({ decision: "allow_always" })]).fn })).toBe('{"decision":"approve"}');
    expect(await run({ fetchFn: worker(true, [await answered({ decision: "allow_mode", mode: "acceptEdits" })]).fn })).toBe('{"decision":"approve"}');
  });

  test("unpaired → nothing, zero network; not on the phone / expired / network down → nothing", async () => {
    const w = worker(true, []);
    expect(await run({ loadConfigFn: async () => null, fetchFn: w.fn })).toBe("");
    expect(w.calls).toEqual([]);
    expect(await run({ fetchFn: worker(false, []).fn, readRecordFn: async () => ({ ts: -10_000_000 }) })).toBe("");
    expect(await run({ fetchFn: worker(true, [{ status: "expired" }]).fn })).toBe("");
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await run({ fetchFn: down })).toBe("");
  });

  test("a hold the phone never answers ends at the deadline → nothing", async () => {
    expect(await run({ fetchFn: worker(true, [{ status: "pending" }]).fn, deadlineAt: clock + 10_000 })).toBe("");
  });

  test("abandoned mid-hold (Devin killed our parent shell) → nothing, card withdrawn, row settled WORKING", async () => {
    const w = worker(true, [{ status: "pending" }]);
    let checks = 0;
    const patches: Record<string, unknown>[] = [];
    const out = await run({
      fetchFn: w.fn, writeHoldFn: async () => {},
      clearHoldFn: async (_id: string, _pid: number, settle?: () => Promise<void>) => { await settle?.(); return true; },
      settleHoldRecordFn: async (_id: string, patch: Record<string, unknown>) => { patches.push(patch); },
    }, EXEC, { abandoned: () => ++checks >= 2 });
    expect(out).toBe("");
    expect(w.calls).toContain("POST /v1/cc/decision/resolve");
    expect(patches.at(-1)).toMatchObject({ lastEvent: "working", op: "update", prio: 0 });
  });
});
