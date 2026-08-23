import { describe, expect, test } from "bun:test";
import { PLAN_BLOB_TEXT_MAX_CHARS } from "../core/shared";
import {
  isDefaultOcTitle, newOcState, ocAttentionFrame, ocEndFrames, ocForgetStatusFrame, ocModelFromMessage,
  ocTodoMarkdown, reduceOcEvent,
} from "./state";
import type { OcState } from "./state";

// -------------------------------------------------------------------------------------------------
// THE FIXTURES ARE REAL. Every payload below was captured off a live `opencode serve` 1.18.15 SSE
// stream (see the live-probe report: `oc-probe/events.md`, `sse3.log`/`sse4.log`), because the
// published `Event` TypeScript union is STALE — it still describes v1 while the runtime delivers v2
// names. A test written against the type would pass and the plugin would still see nothing.
// -------------------------------------------------------------------------------------------------

const ROOT = "ses_fe9c7c13fffeLuB2yMpkVjwaMo";
const CHILD = "ses_child00000000000000000000";

const created = (sessionID: string, title: string, extra: Record<string, unknown> = {}) => ({
  id: "evt_016383ec0002BwfhZXX3JAjVZF",
  type: "session.created",
  properties: {
    sessionID,
    info: {
      id: sessionID, slug: "hidden-knight", version: "1.18.15", projectID: "global",
      directory: "/tmp/oc-probe", path: "", title, cost: 0,
      time: { created: 1787079179968, updated: 1787079179968 },
      ...extra,
    },
  },
});

const status = (sessionID: string, value: unknown) => ({
  id: "evt_0163741fd001Rp8FShe71BoEc2",
  type: "session.status",
  properties: { sessionID, status: value },
});

const idle = (sessionID: string) => ({
  id: "evt_01637443d002IQkZqRfyEtUMWq",
  type: "session.idle",
  properties: { sessionID },
});

const assistantMessage = (sessionID: string, providerID: string, modelID: string, agent = "build") => ({
  id: "evt_0163aa0d0001gFT58uSRiSm2cH",
  type: "message.updated",
  properties: {
    sessionID,
    info: {
      id: "msg_0163aa0d0001A0sadEqzAdxowG", parentID: "msg_0163a9f06001IRc8Y1JU3LerD2",
      role: "assistant", mode: agent, agent, cost: 0,
      modelID, providerID, time: { created: 1787079336144 }, sessionID,
    },
  },
});

/** A started, working root session — the state every turn-level test wants as its precondition. */
function startedRoot(): OcState {
  const state = newOcState();
  expect(reduceOcEvent(state, created(ROOT, "Explore codebase structure"), 1_000)).not.toBeNull();
  return state;
}

describe("reduceOcEvent lifecycle", () => {
  test("session.created for a root session opens with start/working", () => {
    const state = newOcState();
    const frame = reduceOcEvent(state, created(ROOT, "Explore codebase structure"), 1_000);
    expect(frame).toEqual({
      sessionId: ROOT,
      op: "start",
      prio: 0,
      status: "working",
      title: "Explore codebase structure",
      // From `info.time.created`, NOT the reducer's clock — the session's real start.
      startedAt: 1787079179968,
    });
  });

  test("session.status {busy} is an update/working carrying the accumulated title", () => {
    const state = startedRoot();
    const frame = reduceOcEvent(state, status(ROOT, { type: "busy" }), 60_000);
    expect(frame).toMatchObject({ sessionId: ROOT, op: "update", prio: 0, status: "working" });
    // The turn anchor is stamped on the edge INTO working, in epoch SECONDS (the blob's unit, which
    // is NOT the envelope's ms).
    expect(frame?.turnStartedAt).toBe(60);
  });

  test("session.status {retry} carries the FIXED `retrying` key, never the provider's message", () => {
    const state = startedRoot();
    // A real free-tier-exhaustion payload. `detail` is a closed key set on the phone — free text
    // renders nothing in the widget and raw English in the app row — so the message never rides it.
    const frame = reduceOcEvent(state, status(ROOT, {
      type: "retry", attempt: 2, message: "Free usage exceeded, subscribe to Go", next: 1787097600565,
    }), 2_000);
    expect(frame).toMatchObject({ op: "update", status: "working", detail: "retrying" });
  });

  test("session.status {idle} sends nothing — session.idle is the authoritative done", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, status(ROOT, { type: "idle" }), 2_000)).toBeNull();
  });

  test("a legacy bare-string status is still understood", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, status(ROOT, "busy"), 2_000)).toMatchObject({ status: "working" });
  });

  test("session.idle closes the turn with done, and re-arms for the next one", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_000)).not.toBeNull();
    const done = reduceOcEvent(state, idle(ROOT), 3_000);
    expect(done).toMatchObject({ sessionId: ROOT, op: "done", status: "done" });
    // The done frame KEEPS the turn's anchor: the phone renders "done in X" as the turn's end minus
    // this. Without it the anchor falls back to the SESSION start, which the phone only trusts inside
    // a 30-minute window, so the timer vanished on anything older. It is cleared only AFTER the frame
    // is built, so the next turn still anchors fresh — and the next busy is never swallowed by dedupe.
    expect(done?.turnStartedAt).toBe(2);
    const next = reduceOcEvent(state, status(ROOT, { type: "busy" }), 90_000);
    expect(next).toMatchObject({ op: "update", status: "working", turnStartedAt: 90 });
  });

  test("session.deleted ends the session and forgets it", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, { type: "session.deleted", properties: { sessionID: ROOT } }, 4_000))
      .toMatchObject({ sessionId: ROOT, op: "end" });
    expect(state.sessions.size).toBe(0);
    // A stray later event for a dead session sends nothing.
    expect(reduceOcEvent(state, idle(ROOT), 5_000)).toBeNull();
  });

  test("dispose ends every live session exactly once", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, created("ses_second0000000000000000000", "Second"), 1_000)).not.toBeNull();
    const frames = ocEndFrames(state, 6_000);
    expect(frames.map((f) => f.op)).toEqual(["end", "end"]);
    expect(ocEndFrames(state, 6_000)).toEqual([]);
  });

  test("an unknown event type is inert", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, { type: "server.heartbeat", properties: {} }, 7_000)).toBeNull();
    expect(reduceOcEvent(state, { type: "file.edited", properties: { file: "x" } }, 7_000)).toBeNull();
    expect(reduceOcEvent(state, null, 7_000)).toBeNull();
    expect(reduceOcEvent(state, { properties: {} }, 7_000)).toBeNull();
  });
});

describe("title", () => {
  test("OpenCode's default title is never shown", () => {
    expect(isDefaultOcTitle("New session - 2026-08-19T03:12:11.101Z")).toBe(true);
    expect(isDefaultOcTitle("Child session - 2026-08-19T03:12:11.101Z")).toBe(true);
    expect(isDefaultOcTitle("Explore codebase structure")).toBe(false);
    // A fork keeps the real title plus a suffix — that must still be a title.
    expect(isDefaultOcTitle("Explore codebase structure (fork #2)")).toBe(false);

    const state = newOcState();
    const frame = reduceOcEvent(state, created(ROOT, "New session - 2026-08-19T03:12:11.101Z"), 1_000);
    expect(frame?.title).toBeUndefined();
  });

  test("session.updated upgrades the title without sending a frame of its own", () => {
    const state = newOcState();
    reduceOcEvent(state, created(ROOT, "New session - 2026-08-19T03:12:11.101Z"), 1_000);
    const noFrame = reduceOcEvent(state, {
      type: "session.updated",
      properties: { sessionID: ROOT, info: { id: ROOT, title: "Comment input UI design" } },
    }, 2_000);
    expect(noFrame).toBeNull();
    // …but the very next frame carries it.
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 3_000)?.title)
      .toBe("Comment input UI design");
  });
});

describe("model", () => {
  test("model comes from the newest ASSISTANT message.updated, as the BARE model id", () => {
    // The `providerID/` prefix is dropped: the phone's badge table is keyed on bare ids, and an
    // unrecognised key is prettified verbatim ("Anthropic/claude Opus 4.6").
    expect(ocModelFromMessage({ role: "assistant", providerID: "anthropic", modelID: "claude-opus-4-6" }))
      .toBe("claude-opus-4-6");
    // A user message.updated ALSO carries a model (nested under `model`) — it is not ours to read.
    expect(ocModelFromMessage({ role: "user", model: { providerID: "opencode", modelID: "x" } }))
      .toBeUndefined();
    expect(ocModelFromMessage({ role: "assistant", providerID: "anthropic" })).toBeUndefined();
  });

  test("the model reaches the next frame, and a mid-session switch replaces it", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, assistantMessage(ROOT, "opencode", "nemotron-3.5-lightning-free"), 2_000))
      .toBeNull();
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 3_000)?.model)
      .toBe("nemotron-3.5-lightning-free");
    reduceOcEvent(state, assistantMessage(ROOT, "anthropic", "claude-opus-4-6"), 4_000);
    expect(reduceOcEvent(state, idle(ROOT), 5_000)?.model).toBe("claude-opus-4-6");
  });
});

describe("dedupe", () => {
  test("an identical session.status is not re-sent", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_000)).not.toBeNull();
    // `busy` fires several times per turn with a byte-identical payload.
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_100)).toBeNull();
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_200)).toBeNull();
  });

  // The skip key means "the phone already shows this", which a FAILED POST makes false — and
  // postOcEvent reports failure by returning false rather than throwing. The sender retracts the key
  // for any frame it could not deliver; without that, one dropped POST silenced every byte-identical
  // busy for the rest of the turn (~5 minutes of frozen island).
  test("a retracted key re-sends the very next identical busy", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_000)).not.toBeNull();
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_100)).toBeNull();
    ocForgetStatusFrame(state, ROOT); // ← the send failed
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_200)).not.toBeNull();
    // …and the skip is back in force once one lands.
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_300)).toBeNull();
    ocForgetStatusFrame(state, "ses_never_seen_by_this_plugin"); // an untracked session is a no-op
  });

  test("a changed title or model breaks the dedupe", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_000)).not.toBeNull();
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_100)).toBeNull();
    reduceOcEvent(state, {
      type: "session.updated",
      properties: { sessionID: ROOT, info: { id: ROOT, title: "Clarifying what happened" } },
    }, 2_200);
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_300)?.title)
      .toBe("Clarifying what happened");
    reduceOcEvent(state, assistantMessage(ROOT, "opencode", "nemotron-3.5-lightning-free"), 2_400);
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_500)?.model)
      .toBe("nemotron-3.5-lightning-free");
  });

  test("a retry storm sends ONE frame — the key is fixed — and the busy that follows breaks it", () => {
    const state = startedRoot();
    const first = reduceOcEvent(state, status(ROOT, { type: "retry", attempt: 1, message: "429" }), 2_000);
    expect(first?.detail).toBe("retrying");
    expect(reduceOcEvent(state, status(ROOT, { type: "retry", attempt: 2, message: "429" }), 2_100)).toBeNull();
    // A DIFFERENT message is the same rendered frame now, so it is deduped too — the provider's text
    // was never something the phone could show (see the `retrying` key).
    expect(reduceOcEvent(state, status(ROOT, { type: "retry", attempt: 3, message: "Free usage exceeded" }), 2_200))
      .toBeNull();
    // Recovery is a real change of rendered state and always gets through.
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_300)?.detail).toBeUndefined();
  });
});

describe("subagent filter", () => {
  test("a child session's whole lifecycle is dropped", () => {
    const state = startedRoot();
    // The `task` tool creates a child session; its `info` carries a parentID.
    expect(reduceOcEvent(state, created(CHILD, "Child session - 2026-08-19T03:12:11.101Z", { parentID: ROOT }), 2_000))
      .toBeNull();
    expect(state.children.has(CHILD)).toBe(true);
    // Without this, ONE task fan-out paints N island rows.
    expect(reduceOcEvent(state, status(CHILD, { type: "busy" }), 2_100)).toBeNull();
    expect(reduceOcEvent(state, idle(CHILD), 2_200)).toBeNull();
    expect(reduceOcEvent(state, { type: "session.deleted", properties: { sessionID: CHILD } }, 2_300)).toBeNull();
    expect(state.sessions.has(CHILD)).toBe(false);
    // The root is untouched by any of it.
    expect(reduceOcEvent(state, idle(ROOT), 2_400)).toMatchObject({ sessionId: ROOT, op: "done" });
  });

  test("a child learned from session.updated is dropped from then on", () => {
    const state = startedRoot();
    reduceOcEvent(state, {
      type: "session.updated",
      properties: { sessionID: CHILD, info: { id: CHILD, parentID: ROOT, title: "Explore (@explore subagent)" } },
    }, 2_000);
    expect(state.children.has(CHILD)).toBe(true);
    expect(reduceOcEvent(state, status(CHILD, { type: "busy" }), 2_100)).toBeNull();
  });

  test("an assistant message's parentID is a MESSAGE id and must not poison the child set", () => {
    const state = startedRoot();
    reduceOcEvent(state, assistantMessage(ROOT, "opencode", "nemotron-3.5-lightning-free"), 2_000);
    expect(state.children.size).toBe(0);
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_100)).not.toBeNull();
  });
});

describe("mid-flight adoption", () => {
  test("a session first seen at session.status is adopted as an update, never a start", () => {
    const state = newOcState();
    const frame = reduceOcEvent(state, status(ROOT, { type: "busy" }), 5_000);
    expect(frame).toMatchObject({ sessionId: ROOT, op: "update", status: "working", startedAt: 5_000 });
  });

  test("an idle for a session we never saw sends nothing", () => {
    const state = newOcState();
    expect(reduceOcEvent(state, idle(ROOT), 5_000)).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------
// Todos (phase 4). The fixtures are the LIVE `todo.updated` payloads from the questions/todos probe.
// -------------------------------------------------------------------------------------------------

const todos = (sessionID: string, list: unknown[]) => ({
  id: "evt_016b5d99e001NyLbt3FJNHAXjn",
  type: "todo.updated",
  properties: { sessionID, todos: list },
});

const THREE = [
  { content: "Create a.txt with one letter", status: "pending", priority: "high" },
  { content: "Create b.txt with one letter", status: "pending", priority: "high" },
  { content: "Create c.txt with one letter", status: "pending", priority: "high" },
];

describe("todos", () => {
  test("todo.updated is an ambient working update whose list rides the blob's plan key", () => {
    const state = startedRoot();
    const frame = reduceOcEvent(state, todos(ROOT, THREE), 10_000);
    expect(frame).toMatchObject({ sessionId: ROOT, op: "update", prio: 0, status: "working" });
    // AMBIENT, NOT A PROMPT: never needsAttention, never prio 1.
    expect(frame?.status).not.toBe("needsAttention");
    expect(frame?.plan).toBe(
      "- [ ] Create a.txt with one letter\n- [ ] Create b.txt with one letter\n- [ ] Create c.txt with one letter",
    );
  });

  test("every status maps to its own mark, in the model's authored order", () => {
    expect(ocTodoMarkdown([
      { content: "done", status: "completed", priority: "high" },
      { content: "now", status: "in_progress", priority: "medium" },
      { content: "later", status: "pending", priority: "low" },
      { content: "dropped", status: "cancelled", priority: "low" },
      { content: "future", status: "some_new_status", priority: "low" },
    ])).toBe("- [x] done\n- [ ] **now**\n- [ ] later\n- [ ] ~~dropped~~\n- [ ] future");
  });

  test("an empty or contentless list produces no plan at all", () => {
    expect(ocTodoMarkdown([])).toBeUndefined();
    expect(ocTodoMarkdown(undefined)).toBeUndefined();
    expect(ocTodoMarkdown([{ status: "pending" }])).toBeUndefined();
  });

  test("one pathological item cannot eat the whole plan budget", () => {
    const line = ocTodoMarkdown([{ content: "x".repeat(5_000), status: "pending", priority: "low" }]);
    expect(line).toHaveLength("- [ ] ".length + 120);
  });

  test("the list is REPLACED wholesale — todo.updated is never a delta", () => {
    const state = startedRoot();
    reduceOcEvent(state, todos(ROOT, THREE), 10_000);
    const frame = reduceOcEvent(state, todos(ROOT, [
      { content: "Create a.txt with one letter", status: "completed", priority: "high" },
    ]), 11_000);
    expect(frame?.plan).toBe("- [x] Create a.txt with one letter");
  });

  test("an identical list is not re-sent, and the list survives onto later frames", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, todos(ROOT, THREE), 10_000)).not.toBeNull();
    expect(reduceOcEvent(state, todos(ROOT, THREE), 11_000)).toBeNull();
    // …and the next lifecycle frame still carries it (the phone's plan reader must not blink).
    expect(reduceOcEvent(state, idle(ROOT), 12_000)?.plan).toContain("- [ ] Create a.txt");
  });

  test("a changed list breaks the session.status dedupe", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 10_000)).not.toBeNull();
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 10_100)).toBeNull();
    reduceOcEvent(state, todos(ROOT, THREE), 10_200);
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 10_300)).not.toBeNull();
  });

  test("a SUBAGENT's todos never clobber the root row", () => {
    const state = startedRoot();
    reduceOcEvent(state, created(CHILD, "Child session - x", { parentID: ROOT }), 1_000);
    reduceOcEvent(state, todos(ROOT, THREE), 10_000);
    expect(reduceOcEvent(state, todos(CHILD, [
      { content: "subagent work", status: "in_progress", priority: "high" },
    ]), 10_100)).toBeNull();
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 10_200)?.plan)
      .toContain("Create a.txt");
  });

  test("todos for a session we never saw start are dropped", () => {
    expect(reduceOcEvent(newOcState(), todos(ROOT, THREE), 10_000)).toBeNull();
  });

  test("a realistic list fits the 1800-char plan budget with room to spare", () => {
    // The p90 real list: 6 items at the p90 content length.
    const plan = ocTodoMarkdown(Array.from({ length: 6 }, (_, i) => ({
      content: `Step ${i + 1}: ${"refactor the session state reducer ".repeat(2)}`,
      status: i === 0 ? "completed" : i === 1 ? "in_progress" : "pending",
      priority: "medium",
    })))!;
    expect(plan.length).toBeLessThan(PLAN_BLOB_TEXT_MAX_CHARS);
  });
});

describe("plan mode rides the detail seam", () => {
  const sessionUpdated = (sessionID: string, agent: string | null) => ({
    id: "evt_0163741fd009Rp8FShe71BoEc2",
    type: "session.updated",
    properties: { sessionID, info: { id: sessionID, title: "Explore codebase structure", agent } },
  });

  test("an assistant message in the plan agent puts \"Planning\" on the next working frame", () => {
    const state = startedRoot();
    expect(reduceOcEvent(state, assistantMessage(ROOT, "opencode", "nemotron-3.5-lightning-free", "plan"), 2_000))
      .toBeNull(); // agent only, no frame of its own
    const frame = reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_100)!;
    expect(frame.detail).toBe("planning");
    // Ambient, exactly like todos: no attention, no status change.
    expect(frame.status).toBe("working");
    expect(frame.prio).toBe(0);
  });

  test("the TUI's create-time agent stamp lands on the very first frame", () => {
    const state = newOcState();
    expect(reduceOcEvent(state, created(ROOT, "Explore codebase structure", { agent: "plan" }), 1_000)?.detail)
      .toBe("planning");
  });

  test("going back to build clears the detail", () => {
    const state = startedRoot();
    reduceOcEvent(state, assistantMessage(ROOT, "opencode", "nemotron-3.5-lightning-free", "plan"), 2_000);
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 2_100)?.detail).toBe("planning");
    reduceOcEvent(state, assistantMessage(ROOT, "opencode", "nemotron-3.5-lightning-free", "build"), 3_000);
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 3_100)?.detail).toBeUndefined();
  });

  // The plan_exit trap: plan_exit bypasses setAgentModel, so session.updated keeps saying "plan"
  // after the assistant has already flipped to build. The assistant message must win.
  test("a stale session.updated saying plan does not override a newer assistant build message", () => {
    const state = startedRoot();
    reduceOcEvent(state, assistantMessage(ROOT, "opencode", "nemotron-3.5-lightning-free", "plan"), 2_000);
    reduceOcEvent(state, assistantMessage(ROOT, "opencode", "nemotron-3.5-lightning-free", "build"), 3_000);
    reduceOcEvent(state, sessionUpdated(ROOT, "plan"), 3_100); // STALE
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 3_200)?.detail).toBeUndefined();
    reduceOcEvent(state, idle(ROOT), 3_300);
    reduceOcEvent(state, sessionUpdated(ROOT, "plan"), 3_400); // still stale at end of turn
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 3_500)?.detail).toBeUndefined();
  });

  test("session.updated seeds the agent before any assistant message has spoken", () => {
    const state = startedRoot();
    reduceOcEvent(state, sessionUpdated(ROOT, "plan"), 1_500);
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 1_600)?.detail).toBe("planning");
  });

  test("a null or absent agent leaves what we already know alone", () => {
    const state = newOcState();
    // HTTP `POST /session` creates with agent: null.
    expect(reduceOcEvent(state, created(ROOT, "Explore codebase structure", { agent: null }), 1_000)?.detail)
      .toBeUndefined();
    reduceOcEvent(state, sessionUpdated(ROOT, "plan"), 1_500);
    reduceOcEvent(state, sessionUpdated(ROOT, null), 1_600);
    expect(reduceOcEvent(state, status(ROOT, { type: "busy" }), 1_700)?.detail).toBe("planning");
  });

  test("a retry message still wins over Planning, and Planning is not on the done frame", () => {
    const state = startedRoot();
    reduceOcEvent(state, assistantMessage(ROOT, "opencode", "nemotron-3.5-lightning-free", "plan"), 2_000);
    expect(reduceOcEvent(state, status(ROOT, { type: "retry", message: "overloaded, retrying" }), 2_100)?.detail)
      .toBe("retrying");
    expect(reduceOcEvent(state, idle(ROOT), 2_200)?.detail).toBeUndefined();
  });
});

describe("the no-hold attention frame", () => {
  test("is the hooks' own update/prio-1/needsAttention shape", () => {
    const state = startedRoot();
    expect(ocAttentionFrame(state, ROOT, undefined, 20_000)).toMatchObject({
      sessionId: ROOT, op: "update", prio: 1, status: "needsAttention",
    });
  });

  test("is null for an unknown or child session", () => {
    const state = startedRoot();
    reduceOcEvent(state, created(CHILD, "Child session - x", { parentID: ROOT }), 1_000);
    expect(ocAttentionFrame(state, CHILD, undefined, 20_000)).toBeNull();
    expect(ocAttentionFrame(state, "ses_nope", undefined, 20_000)).toBeNull();
  });
});
