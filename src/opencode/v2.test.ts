import { describe, expect, test } from "bun:test";
import { ocDecisionRequest, ocReplyFor, ocResolvedRequestId } from "./approvals";
import plugin from "./plugin";
import { newOcState, ocPromptAsked, ocPromptsEndedBy, reduceOcEvent } from "./state";
import type { OcFrame, OcState } from "./state";
import { OC_V2_EVENT_TYPES, ocClientCount, ocV1Backfill, ocV1Events, ocV2Client, ocV2Scope, ocErrorReason, ocWatchClients, ocWatchdogServesUs, resolveRuntime } from "./v2";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -------------------------------------------------------------------------------------------------
// THE FIXTURES ARE REAL. Each `data` below is a capture from a live OpenCode 2.4.1 TUI (`--standalone`,
// sandboxed HOME) via a project-local `setup` plugin logging `ctx.event.subscribe` — trimmed to the
// fields that matter, ids and shapes unchanged. Note which events carry NO `location`.
// -------------------------------------------------------------------------------------------------

const DIR = "/tmp/probe/proj";
const S = "ses_df5285d5affeJqf1AKvKrMyzw7";
const CHILD = "ses_child0000000000000000000";
const MSG = "msg_20ad7a2e800191XkSazn12JeAg";
const CALL = "call_813edebf6f8b43d9b567a4cc";
const loc = { directory: DIR };
const model = { id: "tidepool-alpha-free", providerID: "opencode", variant: "default" };

const ev = (type: string, data: Record<string, unknown>, location: unknown = loc, created = 1_795_478_135_943) =>
  ({ id: "evt_x", created, type, ...(location ? { location } : {}), data });

const created = (sessionID = S, extra: Record<string, unknown> = {}) => ev("session.created", {
  sessionID, projectID: "global", location: loc, subpath: "", slug: "cosmic-falcon", agent: "build", model, version: "2.4.1", ...extra,
});
const started = (sessionID = S) => ev("session.execution.started", { sessionID }, null);
const step = (sessionID = S, agent = "build") => ev("session.step.started", {
  sessionID, assistantMessageID: MSG, agent, model, started: 1_795_478_136_012,
});
const succeeded = (sessionID = S) => ev("session.execution.succeeded", { sessionID }, null);
const renamed = (title: string) => ev("session.renamed", { sessionID: S, title });
const toolDone = (type: "session.tool.success" | "session.tool.failed", metadata?: unknown) => ev(type, {
  sessionID: S, assistantMessageID: MSG, id: CALL, content: [{ type: "text", text: "ok" }], executed: false,
  ...(metadata ? { metadata } : {}),
});
const permissionAsked = (action = "shell", resources = ["echo one > a.txt"]) => ev("permission.asked", {
  id: "per_20ad7aeb1001If9ENbil44MBWU", sessionID: S, action, resources, save: ["echo *"],
  source: { type: "tool", messageID: MSG, id: CALL },
});
const permissionReplied = ev("permission.replied", {
  sessionID: S, requestID: "per_20ad7aeb1001If9ENbil44MBWU", reply: "once",
}, null);
const formCreated = ev("form.created", {
  form: {
    id: "frm_20ad7c103001cxI4msbDqYy2b0", sessionID: S, title: "Questions",
    metadata: { kind: "question", tool: { messageID: "msg_q", id: "call_q" } },
    fields: [{
      key: "q0", title: "Color", description: "Do you prefer Red or Blue?", type: "string", custom: true,
      options: [{ value: "Red", label: "Red", description: "Red is your preference." }, { value: "Blue", label: "Blue" }],
    }],
  },
});

/** Fold 2.x events through the translator into the 1.x reducer — what the plugin does per event. */
function fold(state: OcState, ...events: unknown[]): OcFrame[] {
  const frames: OcFrame[] = [];
  for (const e of events) for (const v1 of ocV1Events(e)) {
    const frame = reduceOcEvent(state, v1, 1_795_478_140_000);
    if (frame) frames.push(frame);
  }
  return frames;
}
const brief = (f: OcFrame) => `${f.op} ${f.status}${f.detail ? ` ${f.detail}` : ""}`;

describe("the default export loads on both majors", () => {
  test("1.x shape: an object with id + server() (1.x's readV1Plugin ignores the extra setup)", () => {
    expect(typeof plugin.id).toBe("string");
    expect(typeof plugin.server).toBe("function");
  });
  test("2.x shape: id + setup() — what PluginModule's schema demands (`effect` or `setup`)", () => {
    expect(plugin.id).toBe("nomo");
    expect(typeof plugin.setup).toBe("function");
  });
  test("unpaired, setup() subscribes to nothing and returns no cleanup", async () => {
    let subscribed = false;
    const cleanup = await plugin.setup({
      location: { directory: DIR },
      event: { subscribe: () => { subscribed = true; return (async function* () {})(); } },
      permission: { reply: async () => undefined },
    });
    expect(cleanup).toBeUndefined();
    expect(subscribed).toBe(false);
  });
  test("a context without the 2.x event domain is a silent no-op", async () => {
    expect(await plugin.setup({} as never)).toBeUndefined();
    expect(await plugin.setup(undefined as never)).toBeUndefined();
  });
});

describe("sessions", () => {
  test("created seeds start time (the event's epoch-ms `created`), agent and model — no frame", () => {
    const state = newOcState();
    expect(fold(state, created())).toEqual([]);
    const entry = state.sessions.get(S)!;
    expect(entry.startedAt).toBe(1_795_478_135_943);
    expect(entry.agent).toBe("build");
    expect(entry.model).toBe("tidepool-alpha-free"); // bare id, provider dropped, as on 1.x
    expect(entry.announced).toBe(false);
  });

  test("a child session (parentID) is learned and its lifecycle dropped", () => {
    const state = newOcState();
    fold(state, created());
    expect(fold(state, created(CHILD, { parentID: S }), started(CHILD), step(CHILD), succeeded(CHILD))).toEqual([]);
    expect(state.children.get(CHILD)).toBe(S);
  });

  test("renamed becomes the title the next frame carries; OpenCode's default title is still ignored", () => {
    const state = newOcState();
    fold(state, created(), started());
    fold(state, renamed("New session - 2026-11-24T00:00:00.000Z"));
    expect(state.sessions.get(S)!.title).toBeUndefined();
    fold(state, renamed("Write a.txt, ask Red or Blue"));
    const [frame] = fold(state, step());
    expect(frame.title).toBe("Write a.txt, ask Red or Blue");
  });

  test("agent.selected seeds the agent: plan shows the `planning` detail", () => {
    const state = newOcState();
    fold(state, created(S, { agent: undefined }));
    fold(state, ev("session.agent.selected", { sessionID: S, agent: "plan", previous: "build" }));
    const [frame] = fold(state, started());
    expect(frame.detail).toBe("planning");
  });

  test("step.started carries the per-step model and agent (it latches, like 1.x's assistant message)", () => {
    const state = newOcState();
    fold(state, created(S, { model: undefined }), started());
    const frames = fold(state, step(S, "plan"));
    expect(frames.map(brief)).toEqual(["update working planning"]);
    expect(frames[0].model).toBe("tidepool-alpha-free");
    // A later session-level seed does not override what a step said.
    fold(state, ev("session.agent.selected", { sessionID: S, agent: "build" }));
    expect(state.sessions.get(S)!.agent).toBe("plan");
  });

  test("deleted ends an announced row", () => {
    const state = newOcState();
    fold(state, created(), started());
    expect(fold(state, ev("session.deleted", { sessionID: S })).map(brief)).toEqual(["end done"]);
  });
});

describe("turns", () => {
  test("execution.started opens the row, step.started repeats are skip-keyed, succeeded is done", () => {
    const state = newOcState();
    const frames = fold(state, created(), started(), step(), step(), succeeded());
    expect(frames.map(brief)).toEqual(["start working", "done done"]);
    expect(frames[0].model).toBe("tidepool-alpha-free");
  });

  test("failed and interrupted end the turn too, once", () => {
    for (const type of ["session.execution.failed", "session.execution.interrupted"]) {
      const state = newOcState();
      const frames = fold(state, created(), started(), ev(type, { sessionID: S, reason: "user" }, null), succeeded());
      expect(frames.map(brief)).toEqual(["start working", "done done"]);
    }
  });

  test("retry.scheduled shows Reconnecting… (`retrying`) until the retried step starts", () => {
    const state = newOcState();
    const frames = fold(state, created(), started(),
      ev("session.retry.scheduled", { sessionID: S, assistantMessageID: MSG, attempt: 1, at: 0, error: {} }), step());
    expect(frames.map(brief)).toEqual(["start working", "update working retrying", "update working"]);
  });

  test("a turn for a session first seen mid-flight is adopted as an update, like 1.x", () => {
    const state = newOcState();
    expect(fold(state, step()).map(brief)).toEqual(["update working"]);
  });
});

describe("tools", () => {
  test("success/failed end the prompt blocking that exact call", () => {
    for (const type of ["session.tool.success", "session.tool.failed"] as const) {
      const state = newOcState();
      fold(state, created(), started());
      const [asked] = ocV1Events(permissionAsked());
      ocPromptAsked(state, asked);
      const [part] = ocV1Events(toolDone(type));
      expect(ocPromptsEndedBy(state, part)).toEqual([{ id: "per_20ad7aeb1001If9ENbil44MBWU", byTool: true }]);
    }
  });

  test("todowrite's list rides its success metadata into the plan", () => {
    const state = newOcState();
    fold(state, created(), started());
    const frames = fold(state, toolDone("session.tool.success", { todos: [{ content: "step one", status: "in_progress" }] }));
    expect(frames.map((f) => f.plan)).toEqual(["- [ ] **step one**"]);
    expect(ocV1Events(toolDone("session.tool.failed", { todos: [] })).map((e) => (e as { type: string }).type))
      .toEqual(["message.part.updated"]);
  });
});

describe("permissions", () => {
  test("shell is normalised back to bash: the phone gets the same `shell` card with the command", () => {
    const request = ocDecisionRequest(ocV1Events(permissionAsked())[0])!;
    expect(request).toMatchObject({
      kind: "permission", id: "per_20ad7aeb1001If9ENbil44MBWU", sessionID: S,
      toolName: "shell", toolInput: { command: "echo one > a.txt" },
    });
  });

  test("2.x keeps `permissionGrant` empty (an older app hides Always) and states the PROJECT grant separately", () => {
    const shell = ocDecisionRequest(ocV1Events(permissionAsked())[0])!;
    expect(shell).toMatchObject({ grant: "", projectGrant: "cmd:echo", v2: true });
    const edit = ocDecisionRequest(ocV1Events(ev("permission.asked", {
      id: "per_e", sessionID: S, action: "edit", resources: ["src/a.ts"], save: ["*"],
    }))[0])!;
    expect(edit).toMatchObject({ grant: "", projectGrant: "edits" });
  });

  test("a 2.x request that saves nothing has an empty project grant (Always stays hidden)", () => {
    const req = ocDecisionRequest(ocV1Events(ev("permission.asked", { id: "per_n", sessionID: S, action: "shell", resources: ["x"] }))[0])!;
    expect(req).toMatchObject({ grant: "", projectGrant: "", v2: true });
  });

  test("a 1.x request has no project grant and no v2 mark", () => {
    const req = ocDecisionRequest({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: S, permission: "bash", patterns: ["ls"], always: ["ls *"], metadata: {} },
    })!;
    expect(req.grant).toBe("cmd:ls");
    expect(req.projectGrant).toBeUndefined();
    expect(req.v2).toBeUndefined();
  });

  test("deny with note: a 2.x reject carries the note; the plain-Deny placeholder and 1.x never do", () => {
    const v2req = ocDecisionRequest(ocV1Events(permissionAsked())[0])!;
    const line = (decision: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
    expect(ocReplyFor(v2req, line({ behavior: "deny", message: "  use bun instead  " }))!.body)
      .toEqual({ reply: "reject", message: "use bun instead" });
    expect(ocReplyFor(v2req, line({ behavior: "deny", message: "Denied from phone" }))!.body).toEqual({ reply: "reject" });
    const v1req = { ...v2req, v2: undefined };
    expect(ocReplyFor(v1req, line({ behavior: "deny", message: "use bun instead" }))!.body).toEqual({ reply: "reject" });
  });

  test("the other mapped permissions keep their 1.x cards; unmapped ones keep their name + detail", () => {
    expect(ocDecisionRequest(ocV1Events(permissionAsked("edit", ["src/a.ts"]))[0])).toMatchObject({
      toolName: "Edit", toolInput: { file_path: "src/a.ts" },
    });
    expect(ocDecisionRequest(ocV1Events(permissionAsked("webfetch", ["https://example.com"]))[0])).toMatchObject({
      toolName: "WebFetch", toolInput: { url: "https://example.com" },
    });
    expect(ocDecisionRequest(ocV1Events(permissionAsked("external_directory", ["/etc/*"]))[0])).toMatchObject({
      toolName: "external_directory", detail: "/etc/*",
    });
  });

  test("the question tool's own permission never wears the pinned `question` name", () => {
    expect(ocDecisionRequest(ocV1Events(permissionAsked("question", ["*"]))[0])!.toolName).toBe("question_permission");
  });

  test("the asked event keeps the blocked call, replied keeps its requestID", () => {
    const [asked] = ocV1Events(permissionAsked()) as { properties: Record<string, unknown> }[];
    expect(asked.properties.tool).toEqual({ messageID: MSG, callID: CALL });
    expect(ocResolvedRequestId(ocV1Events(permissionReplied)[0])).toBe("per_20ad7aeb1001If9ENbil44MBWU");
  });
});

describe("forms (questions)", () => {
  test("created is a question request on the asking session, with its blocked call", () => {
    const [v1] = ocV1Events(formCreated);
    expect(ocDecisionRequest(v1)).toMatchObject({ kind: "question", id: "frm_20ad7c103001cxI4msbDqYy2b0", sessionID: S, toolName: "question" });
    expect((v1 as { properties: { tool: unknown } }).properties.tool).toEqual({ messageID: "msg_q", callID: "call_q" });
  });
  test("replied and cancelled resolve it", () => {
    expect(ocResolvedRequestId(ocV1Events(ev("form.replied", { id: "frm_1", sessionID: S, answer: { q0: "Red" } }))[0])).toBe("frm_1");
    expect(ocResolvedRequestId(ocV1Events(ev("form.cancelled", { id: "frm_1", sessionID: S }))[0])).toBe("frm_1");
  });
  test("a form with no fields or no session is nothing", () => {
    expect(ocV1Events(ev("form.created", { form: { id: "frm_1", sessionID: S, title: "x", fields: [] } }))).toEqual([]);
    expect(ocV1Events(ev("form.created", { form: { id: "frm_1", title: "x", fields: [{}] } }))).toEqual([]);
  });
});

describe("ocV2Scope — the server-wide stream, one directory's instance", () => {
  test("another directory is theirs, and stays theirs even on its location-less events", () => {
    const known = new Set<string>(); const foreign = new Set<string>();
    expect(ocV2Scope(created(), "/elsewhere", known, foreign)).toBe("theirs");
    expect(ocV2Scope(started(), "/elsewhere", known, foreign)).toBe("theirs");
  });
  test("born here is ours; then its location-less events (execution.*, permission.replied, forms) are too", () => {
    const known = new Set<string>(); const foreign = new Set<string>();
    expect(ocV2Scope(created(), DIR, known, foreign)).toBe("ours");
    expect(ocV2Scope(started(), DIR, known, foreign)).toBe("ours");
    expect(ocV2Scope(permissionReplied, DIR, known, foreign)).toBe("ours");
    expect(ocV2Scope(formCreated, DIR, known, foreign)).toBe("ours");
  });
  test("a session never seen must be looked up — located or not (a continued session, a subagent)", () => {
    expect(ocV2Scope(started(), DIR, new Set(), new Set())).toBe("ask");
    expect(ocV2Scope(step(), DIR, new Set(), new Set())).toBe("ask");
  });
  test("a located deleted forgets the session", () => {
    const known = new Set([S]);
    expect(ocV2Scope(ev("session.deleted", { sessionID: S }), DIR, known, new Set())).toBe("ours");
    expect(known.has(S)).toBe(false);
  });
  test("the subscription asks for every type the translator maps", () => {
    expect(OC_V2_EVENT_TYPES).toContain("session.execution.succeeded");
    expect(OC_V2_EVENT_TYPES).toContain("form.created");
  });
});

describe("ocV1Backfill — a session first met mid-flight", () => {
  test("a subagent that predates the plugin is learned as a child, so it never gets a row", () => {
    const state = newOcState();
    fold(state, created());
    for (const e of ocV1Backfill(CHILD, { id: CHILD, parentID: S, location: loc, time: { created: 1 } })) reduceOcEvent(state, e);
    expect(state.children.get(CHILD)).toBe(S);
    expect(fold(state, started(CHILD), step(CHILD))).toEqual([]);
  });
  test("a continued session gets its title, agent and real start before its first busy", () => {
    const state = newOcState();
    for (const e of ocV1Backfill(S, { id: S, title: "Old work", agent: "plan", model, location: loc, time: { created: 1_700_000_000_000 } })) {
      reduceOcEvent(state, e);
    }
    const [frame] = fold(state, started());
    expect(frame).toMatchObject({
      op: "start", status: "working", title: "Old work", detail: "planning", model: "tidepool-alpha-free", startedAt: 1_700_000_000_000,
    });
  });
});

describe("ocV2Client — the 2.x reply seam behind the 1.x client shape", () => {
  const calls: unknown[] = [];
  const client = ocV2Client(async (input) => { calls.push(input); }, (id) => (id === "per_1" ? S : undefined));

  test("a permission reply becomes ctx.permission.reply with its session", async () => {
    calls.length = 0;
    expect(await client._client.post({ url: "/permission/per_1/reply", body: { reply: "reject" } })).toEqual({ response: { status: 204 } });
    expect(calls).toEqual([{ sessionID: S, requestID: "per_1", decision: "reject" }]);
  });
  test("`always` goes through as `always` (2.5.3: only a 'saved for this project' card offers it)", async () => {
    calls.length = 0;
    await client._client.post({ url: "/permission/per_1/reply", body: { reply: "always" } });
    expect(calls).toEqual([{ sessionID: S, requestID: "per_1", decision: "always" }]);
  });
  test("a reject's note is passed on as `message`; a note on anything else is not", async () => {
    calls.length = 0;
    await client._client.post({ url: "/permission/per_1/reply", body: { reply: "reject", message: "use bun" } });
    await client._client.post({ url: "/permission/per_1/reply", body: { reply: "once", message: "stray" } });
    expect(calls).toEqual([
      { sessionID: S, requestID: "per_1", decision: "reject", message: "use bun" },
      { sessionID: S, requestID: "per_1", decision: "once" },
    ]);
  });
  test("an unknown request or a question route is a 404, never a call", async () => {
    calls.length = 0;
    expect((await client._client.post({ url: "/permission/per_9/reply", body: { reply: "once" } })).response.status).toBe(404);
    expect((await client._client.post({ url: "/question/frm_1/reply", body: { answers: [] } })).response.status).toBe(404);
    expect(calls).toEqual([]);
  });
  test("a failing reply throws, so the hold traces it as lost", async () => {
    const failing = ocV2Client(async () => { throw new Error("NotFound"); }, () => S);
    await expect(failing._client.post({ url: "/permission/per_1/reply", body: { reply: "once" } })).rejects.toThrow("NotFound");
  });
});

// NOM-214. `lsof -nP -a -p <server pid> -iTCP -FnT`, captured off a live `opencode serve --service`
// (2.4.0): the listener, outbound provider connections on :443, and — once a TUI attaches — its
// connection INTO the listener. Only the last kind is a window.
const LSOF_NO_WINDOW = [
  "p42681", "f7", "n127.0.0.1:49374", "TST=LISTEN", "TQR=0", "TQS=0",
  "f13", "n[fdfe:dcba:9876::1]:56043->[2001:2::df]:443", "TST=ESTABLISHED", "TQR=0", "TQS=0",
  "f19", "n198.18.0.1:55093->198.18.1.141:443", "TST=ESTABLISHED", "TQR=0", "TQS=0",
].join("\n");
const lsofWindows = (...ports: number[]) => LSOF_NO_WINDOW + ports.map((port, i) =>
  `\nf${30 + i}\nn127.0.0.1:49374->127.0.0.1:${port}\nTST=ESTABLISHED\nTQR=0\nTQS=0`).join("");

describe("ocClientCount — how many OpenCode windows are attached to this server", () => {
  test("connections INTO the listener are windows; outbound ones are not", () => {
    expect(ocClientCount(LSOF_NO_WINDOW)).toBe(0);
    expect(ocClientCount(lsofWindows(61234))).toBe(1);
    expect(ocClientCount(lsofWindows(61234, 61240))).toBe(2);
  });
  test("IPv6 listeners count the same way", () => {
    expect(ocClientCount("p1\nf7\nn[::1]:4096\nTST=LISTEN\nf8\nn[::1]:4096->[::1]:5000\nTST=ESTABLISHED")).toBe(1);
  });
  test("no listener (or no output: lsof missing, failed) is unknown, never zero", () => {
    expect(ocClientCount("")).toBeUndefined();
    expect(ocClientCount("p1\nf13\nn10.0.0.2:5000->1.1.1.1:443\nTST=ESTABLISHED")).toBeUndefined();
  });
});

describe("ocWatchClients — close what only a window could answer, once no window is left", () => {
  const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
  function watch(counts: (number | undefined)[], pending = () => true) {
    const closed: number[] = [];
    let polls = 0;
    const stop = ocWatchClients({
      count: async () => counts[Math.min(polls++, counts.length - 1)],
      pending,
      close: () => { closed.push(polls); },
      intervalMs: 5,
    });
    return { closed, stop, polls: () => polls };
  }

  test("two windowless polls in a row close it; a window coming back resets the count", async () => {
    const w = watch([1, 0, 1, 0, 0, 1]);
    await tick(80);
    w.stop();
    expect(w.closed).toEqual([5]); // polls 2 and 4 were single blips (a TUI reconnecting)
  });
  test("unknown (no listener, lsof failed) never closes anything", async () => {
    const w = watch([undefined]);
    await tick();
    w.stop();
    expect(w.closed).toEqual([]);
  });
  test("with nothing parked it never even looks", async () => {
    const w = watch([0], () => false);
    await tick();
    w.stop();
    expect(w.polls()).toBe(0);
    expect(w.closed).toEqual([]);
  });
  test("stop() ends it", async () => {
    const w = watch([0]);
    w.stop();
    await tick();
    expect(w.polls()).toBe(0);
  });
});

describe("honest states (2.x only)", () => {
  test("retrying carries the next attempt (epoch seconds) and the rate-limit reason", () => {
    const state = newOcState(true);
    fold(state, created(), started());
    const [frame] = fold(state, ev("session.retry.scheduled", {
      sessionID: S, assistantMessageID: MSG, attempt: 2, at: 1_795_478_200_400,
      error: { type: "APIError", message: "Too many requests", status: 429 },
    }, null));
    expect(frame).toMatchObject({ op: "update", status: "working", detail: "retrying", retryAt: 1_795_478_201, retryReason: "rateLimited" });
  });

  test("a non-rate-limit retry has no reason; each new attempt time is a new frame", () => {
    const state = newOcState(true);
    fold(state, created(), started());
    const retry = (at: number) => ev("session.retry.scheduled", {
      sessionID: S, assistantMessageID: MSG, attempt: 1, at, error: { type: "APIError", message: "overloaded", status: 529 },
    }, null);
    const frames = fold(state, retry(1_795_478_200_000), retry(1_795_478_200_000), retry(1_795_478_210_000));
    expect(frames.map((f) => [f.retryAt, f.retryReason])).toEqual([[1_795_478_200, undefined], [1_795_478_210, undefined]]);
  });

  test("compacting rides a working frame and clears at the next step", () => {
    const state = newOcState(true);
    fold(state, created(), started(), step());
    const frames = fold(state, ev("session.compaction.started", { sessionID: S, reason: "auto" }), step());
    expect(frames.map((f) => [brief(f), f.phase])).toEqual([["update working", "compacting"], ["update working", undefined]]);
  });

  test("a failed or interrupted turn says so on its done frame; a succeeded one does not", () => {
    for (const [type, outcome] of [
      ["session.execution.failed", "failed"], ["session.execution.interrupted", "interrupted"], ["session.execution.succeeded", undefined],
    ] as const) {
      const state = newOcState(true);
      fold(state, created(), started());
      const [done] = fold(state, ev(type, { sessionID: S, error: { type: "X", message: "boom" }, reason: "user" }, null));
      expect(done.op).toBe("done");
      expect(done.outcome).toBe(outcome);
    }
  });

  test("idle with background subagents still running counts them on the done frame", () => {
    const state = newOcState(true);
    fold(state, created(), started());
    fold(state, created(CHILD, { parentID: S }), started(CHILD), created("ses_child2", { parentID: S }), started("ses_child2"));
    fold(state, succeeded("ses_child2"));
    const [done] = fold(state, succeeded());
    expect(done).toMatchObject({ op: "done", bgAgents: 1 });
  });

  test("1.x (state not v2): the same events carry none of the keys", () => {
    const state = newOcState();
    fold(state, created(), started(), created(CHILD, { parentID: S }), started(CHILD));
    const frames = fold(state,
      ev("session.retry.scheduled", { sessionID: S, at: 1_795_478_200_400, error: { type: "X", message: "m", status: 429 } }, null),
      ev("session.compaction.started", { sessionID: S, reason: "auto" }),
      ev("session.execution.failed", { sessionID: S, error: { type: "X", message: "m" } }, null));
    for (const f of frames) {
      expect(f.retryAt ?? f.retryReason ?? f.phase ?? f.outcome ?? f.bgAgents).toBeUndefined();
    }
  });
});

describe("ocWatchdogServesUs — the idle guard's cheap test (no ps, no hash)", () => {
  const alive = (pid: number) => pid === 42;
  test("a live daemon of this version, or a newer one, can serve our commands", () => {
    expect(ocWatchdogServesUs("42 2.5.3 abc", alive, "2.5.3")).toBe(true);
    expect(ocWatchdogServesUs("42 99.0.0 abc", alive, "2.5.3")).toBe(true);
  });
  test("an OLDER daemon (it drops OpenCode Reply/Interrupt), a dead one, none, or a pre-stamp one → full check", () => {
    expect(ocWatchdogServesUs("42 2.5.1 abc", alive, "2.5.3")).toBe(false);
    expect(ocWatchdogServesUs("7 2.5.3", alive, "2.5.3")).toBe(false);
    expect(ocWatchdogServesUs(undefined, alive, "2.5.3")).toBe(false);
    expect(ocWatchdogServesUs("42", alive, "2.5.3")).toBe(false);
    expect(ocWatchdogServesUs("junk", alive, "2.5.3")).toBe(false);
  });
});

describe("resolveRuntime — the resident plugin must be able to START the watchdog it evicts for", () => {
  const exe = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "#!/bin/sh\n"); chmodSync(path, 0o755); };
  test("no run.sh cache (its fast path never writes one): bun on PATH, then ~/.bun/bin", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-rt-"));
    const cc = join(root, "cc");
    exe(join(root, "pathbin", "bun"));
    expect(resolveRuntime({ PATH: `relative:${join(root, "pathbin")}`, HOME: root }, cc)).toBe(join(root, "pathbin", "bun"));
    exe(join(root, ".bun", "bin", "bun"));
    expect(resolveRuntime({ PATH: "relative/only", HOME: root }, cc)).toBe(join(root, ".bun", "bin", "bun"));
  });
  test("NOMO_RUNTIME, then a positive cache, win over the probe; a NONE sentinel is not a path", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-rt-"));
    const cc = join(root, "cc");
    mkdirSync(cc);
    exe(join(root, "forced"));
    exe(join(root, "cached"));
    writeFileSync(join(cc, "runtime"), join(root, "cached"));
    expect(resolveRuntime({ NOMO_RUNTIME: join(root, "forced"), PATH: "", HOME: root }, cc)).toBe(join(root, "forced"));
    expect(resolveRuntime({ PATH: "", HOME: root }, cc)).toBe(join(root, "cached"));
    writeFileSync(join(cc, "runtime"), "NONE:1");
    const fallback = resolveRuntime({ PATH: "", HOME: root }, cc);
    expect(fallback === undefined || fallback.startsWith("/")).toBe(true); // only system candidates remain
  });
});

describe("failed turns carry a short reason", () => {
  test("execution.failed → outcome failed + outcomeReason; an interrupt has no reason", () => {
    const state = newOcState(true);
    fold(state, created(), started(), step());
    const [failed] = fold(state, ev("session.execution.failed", { sessionID: S, error: { type: "ProviderAuthError", message: "Insufficient balance.\nSubscribe to OpenCode Go" } }, null));
    expect(failed).toMatchObject({ outcome: "failed", outcomeReason: "Insufficient balance. Subscribe to OpenCode Go" });
    fold(state, started(), step());
    const [interrupted] = fold(state, ev("session.execution.interrupted", { sessionID: S, reason: "user" }, null));
    expect(interrupted).toMatchObject({ outcome: "interrupted" });
    expect(interrupted.outcomeReason).toBeUndefined();
  });
  test("ocErrorReason: message else type, one line, capped", () => {
    expect(ocErrorReason({ type: "T", message: " a\n\tb " })).toBe("a b");
    expect(ocErrorReason({ type: "OnlyType" })).toBe("OnlyType");
    expect(ocErrorReason({})).toBeUndefined();
    expect(ocErrorReason({ message: "x".repeat(400) })!.length).toBe(160);
  });
});
