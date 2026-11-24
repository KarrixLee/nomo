import { describe, expect, test } from "bun:test";
import { ocDecisionRequest, ocResolvedRequestId } from "./approvals";
import plugin from "./plugin";
import { newOcState, ocPromptAsked, ocPromptsEndedBy, reduceOcEvent } from "./state";
import type { OcFrame, OcState } from "./state";
import { OC_V2_EVENT_TYPES, ocClientCount, ocV1Backfill, ocV1Events, ocV2Client, ocV2Scope, ocWatchClients } from "./v2";

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

  test("2.x offers NO Always allow: `always` persists to disk now, the phone's label says until restart", () => {
    expect(ocDecisionRequest(ocV1Events(permissionAsked())[0])!.grant).toBe("");
    expect(ocDecisionRequest(ocV1Events(permissionAsked("edit", ["src/a.ts"]))[0])!.grant).toBe("");
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
  test("`always` is sent as `once` — 2.x would save it to the project forever", async () => {
    calls.length = 0;
    await client._client.post({ url: "/permission/per_1/reply", body: { reply: "always" } });
    expect(calls).toEqual([{ sessionID: S, requestID: "per_1", decision: "once" }]);
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
