// The resident plugin's WIRING — the send chain, the hold registry and the repaint edges — which the
// pure reducer/approval suites cannot see. Each case replays a scripted OpenCode event stream through
// the real plugin in a child process (HOME isolated; see src/test/opencode-plugin-driver.ts) against a
// fake worker, and asserts on the order the worker saw things in.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessHygiene, isolatedTestEnv } from "../test/process-hygiene";

const { spawnTestProcess } = createProcessHygiene();
const driver = join(import.meta.dir, "../test/opencode-plugin-driver.ts");

async function replay(scenario: {
  hold: boolean; gateFirstEvent?: boolean; steps: unknown[]; v2?: boolean; answer?: string; answerMessage?: string;
  sessions?: Record<string, unknown>; logKeys?: boolean;
}): Promise<string[]> {
  const home = await mkdtemp(join(tmpdir(), "oc-plugin-"));
  try {
    const proc = spawnTestProcess({
      cmd: ["bun", driver, JSON.stringify(scenario)], env: isolatedTestEnv(home), stdout: "pipe", stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return JSON.parse(out.trim().split("\n").pop() ?? "[]") as string[];
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const S = "ses_root";
const created = { ev: { type: "session.created", properties: { info: { id: S, time: { created: 1_700_000_000_000 } } } } };
const busy = { ev: { type: "session.status", properties: { sessionID: S, status: { type: "busy" } } } };
const todos = { ev: { type: "todo.updated", properties: { sessionID: S, todos: [{ content: "step one", status: "in_progress" }] } } };
const asked = (id: string) => ({
  ev: { type: "permission.asked", properties: { id, sessionID: S, permission: "bash", patterns: ["ls -la"], metadata: {} } },
});
const replied = (id: string) => ({
  ev: { type: "permission.replied", properties: { sessionID: S, requestID: id, reply: "once" } },
});
const waitFor = (prefix: string, count = 1) => ({ waitFor: prefix, count });

describe("a queued working frame never lands on a newer prompt's card", () => {
  // The send chain is backed up behind one slow POST. per_1 is answered at the Mac (→ "repaint working")
  // and per_2 is asked and HELD before the chain drains. A frame decided when it was ENQUEUED would be
  // that stale working, sent after per_2's card went up — and a prio:0 frame takes the card down.
  test("repaint decides its frame when it is SENT, not when it is queued", async () => {
    const log = await replay({
      hold: true, gateFirstEvent: true,
      steps: [
        created, busy, waitFor("event start"),
        asked("per_1"), waitFor("decision", 1),
        replied("per_1"),
        asked("per_2"), waitFor("decision", 2),
        { release: true },
      ],
    });
    expect(log.filter((entry) => entry.startsWith("TIMEOUT"))).toEqual([]);
    expect(log.slice(0, 2)).toEqual(["event start working", "decision"]);
    expect(log.filter((entry) => entry === "decision")).toHaveLength(2);
    expect(log).not.toContain("event update working");
  }, 30000);

  // The same hazard for a frame the REDUCER planned (a todo tick) while no prompt was up yet.
  test("a reducer-planned working update is dropped at send time when a prompt is held on its row", async () => {
    const log = await replay({
      hold: true, gateFirstEvent: true,
      steps: [created, busy, waitFor("event start"), todos, asked("per_1"), waitFor("decision"), { release: true }],
    });
    expect(log.filter((entry) => entry.startsWith("TIMEOUT"))).toEqual([]);
    expect(log.slice(0, 2)).toEqual(["event start working", "decision"]);
    expect(log).not.toContain("event update working");
  }, 30000);

  // CONTROL for both: with nothing held, the very same queued frames are sent.
  test("with no prompt held the queued working update goes out as before", async () => {
    const log = await replay({
      hold: true, gateFirstEvent: true,
      steps: [created, busy, waitFor("event start"), todos, { release: true }, waitFor("event update")],
    });
    expect(log.slice(0, 2)).toEqual(["event start working", "event update working"]);
  }, 30000);
});

describe("a hold the worker never granted", () => {
  // No card, no marker, so no settle ever writes the row — and the registry mutes every busy while the
  // prompt is pending. Unless the plugin paints it, the row reads working while OpenCode waits on a human.
  test("falls back to the plain needsAttention row", async () => {
    const log = await replay({
      hold: false,
      steps: [created, busy, waitFor("event start"), asked("per_1"), waitFor("event update needsAttention")],
    });
    expect(log.filter((entry) => entry.startsWith("TIMEOUT"))).toEqual([]);
    expect(log).toContain("event update needsAttention");
    expect(log.indexOf("event update needsAttention")).toBeGreaterThan(log.indexOf("decision"));
  }, 30000);
});

// OpenCode 2.x: the same plugin through its `setup` entry — a scripted `ctx.event.subscribe` stream in
// the live-captured 2.4.1 shapes (execution.* and permission.replied carry no location), replies through
// `ctx.permission.reply`.
describe("OpenCode 2.x through setup()", () => {
  const D = "/tmp/oc-driver";
  const v2 = (type: string, data: Record<string, unknown>, located = true) =>
    ({ ev: { id: "evt_x", created: 1_795_478_135_943, type, ...(located ? { location: { directory: D } } : {}), data } });
  const created2 = v2("session.created", { sessionID: S, agent: "build", model: { id: "m", providerID: "p" } });
  const started2 = v2("session.execution.started", { sessionID: S }, false);
  const succeeded2 = v2("session.execution.succeeded", { sessionID: S }, false);
  const asked2 = v2("permission.asked", {
    id: "per_2", sessionID: S, action: "shell", resources: ["ls -la"], save: ["ls *"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  });

  test("a turn opens and closes the row; a foreign directory's events are dropped", async () => {
    const log = await replay({
      v2: true, hold: true,
      steps: [
        { ev: { id: "evt_y", created: 1, type: "session.created", location: { directory: "/elsewhere" }, data: { sessionID: "ses_far" } } },
        { ev: { id: "evt_z", created: 1, type: "session.execution.started", data: { sessionID: "ses_far" } } },
        created2, started2, waitFor("event start"), succeeded2, waitFor("event done"),
      ],
    });
    expect(log.filter((entry) => entry.startsWith("TIMEOUT"))).toEqual([]);
    expect(log.slice(0, 2)).toEqual(["event start working", "event done done"]);
  }, 30000);

  test("frames carry `controls`; the card carries controls + the PROJECT grant while permissionGrant stays \"\"", async () => {
    const log = await replay({
      v2: true, hold: true, answer: "allow_always", logKeys: true,
      steps: [created2, started2, waitFor("event start"), asked2, waitFor("reply")],
    });
    expect(log.filter((entry) => entry.startsWith("TIMEOUT"))).toEqual([]);
    expect(log).toContain('keys start {"controls":["reply","interrupt","denyNote"]}');
    expect(log).toContain('card shell grant=""');
    expect(log).toContain('cardkeys {"permissionProjectGrant":"cmd:ls","controls":["reply","interrupt","denyNote"]}');
    // Always allow from a 2.5.3 app is a real `always` now: OpenCode saves `ls *` for the project.
    expect(log).toContain(`reply ${S} per_2 always`);
  }, 30000);

  test("Deny with note reaches ctx.permission.reply as `message`", async () => {
    const log = await replay({
      v2: true, hold: true, answer: "deny", answerMessage: "use bun test instead",
      steps: [created2, started2, waitFor("event start"), asked2, waitFor("reply")],
    });
    expect(log).toContain(`reply ${S} per_2 reject use bun test instead`);
  }, 30000);

  test("a failed turn ends with outcome:failed on its done frame", async () => {
    const log = await replay({
      v2: true, hold: true, logKeys: true,
      steps: [
        created2, started2, waitFor("event start"),
        v2("session.execution.failed", { sessionID: S, error: { type: "APIError", message: "bad key" } }, false),
        waitFor("event done"),
      ],
    });
    expect(log).toContain('keys done {"controls":["reply","interrupt","denyNote"],"outcome":"failed"}');
  }, 30000);

  test("a phone reply left by the watchdog is prompted into the session (steer, idempotent id) and receipted", async () => {
    const log = await replay({
      v2: true, hold: true, logKeys: true,
      steps: [
        created2, started2, waitFor("event start"),
        { write: { name: `${S}.abcd1234.agy-reply`, content: "q" } },
        { write: { name: `${S}.abcd1234.agy-inbox`, content: JSON.stringify({ mid: "abcd1234", text: "also run lint", ts: 1 }) } },
        waitFor("prompt"),
        waitFor("keys update"),
      ],
    });
    expect(log.filter((entry) => entry.startsWith("TIMEOUT"))).toEqual([]);
    expect(log).toContain(`prompt ${S} also run lint steer msg_nomo_abcd1234`);
    expect(log.find((entry) => entry.startsWith("keys update"))).toContain('"replies":{"abcd1234":"d"}');
  }, 30000);

  test("an interrupt flag is consumed once and calls ctx.session.interrupt; a stale one is dropped unread", async () => {
    const log = await replay({
      v2: true, hold: true,
      steps: [
        created2, started2, waitFor("event start"),
        { write: { name: `${S}.oc-interrupt`, content: JSON.stringify({ at: Date.now() }) } },
        waitFor("interrupt"),
        { write: { name: `${S}.oc-interrupt`, content: JSON.stringify({ at: Date.now() - 10 * 60_000 }) } },
        { sleep: 2500 },
      ],
    });
    expect(log.filter((entry) => entry.startsWith("interrupt"))).toEqual([`interrupt ${S}`]);
  }, 30000);

  test("another folder's session is never prompted or interrupted from here", async () => {
    const log = await replay({
      v2: true, hold: true,
      sessions: { ses_far: { id: "ses_far", location: { directory: "/elsewhere" }, time: { created: 1 } } },
      steps: [
        created2, started2, waitFor("event start"),
        { write: { name: "ses_far.oc-interrupt", content: JSON.stringify({ at: Date.now() }) } },
        { write: { name: "ses_far.abcd1234.agy-inbox", content: JSON.stringify({ mid: "abcd1234", text: "hi", ts: 1 }) } },
        { sleep: 2500 },
      ],
    });
    expect(log.some((entry) => entry.startsWith("interrupt") || entry.startsWith("prompt"))).toBe(false);
  }, 30000);

  test("a phone Allow answers through ctx.permission.reply on a shell card with no Always allow", async () => {
    const log = await replay({
      v2: true, hold: true, answer: "allow",
      steps: [created2, started2, waitFor("event start"), asked2, waitFor("reply")],
    });
    expect(log.filter((entry) => entry.startsWith("TIMEOUT"))).toEqual([]);
    expect(log).toContain('card shell grant=""');
    expect(log).toContain(`reply ${S} per_2 once`);
  }, 30000);

  test("a phone Deny is a reject", async () => {
    const log = await replay({
      v2: true, hold: true, answer: "deny",
      steps: [created2, started2, waitFor("event start"), asked2, waitFor("reply")],
    });
    expect(log).toContain(`reply ${S} per_2 reject`);
  }, 30000);

  test("a question form is never held: the row asks to answer at the Mac, then goes back to working", async () => {
    const log = await replay({
      v2: true, hold: true,
      steps: [
        created2, started2, waitFor("event start"),
        v2("form.created", { form: { id: "frm_1", sessionID: S, title: "Questions", fields: [{ key: "q0", type: "string" }] } }),
        waitFor("event update needsAttention"),
        v2("form.replied", { id: "frm_1", sessionID: S, answer: { q0: "Red" } }),
        waitFor("event update working"),
      ],
    });
    expect(log.filter((entry) => entry.startsWith("TIMEOUT"))).toEqual([]);
    expect(log).not.toContain("decision");
    expect(log.indexOf("event update working")).toBeGreaterThan(log.indexOf("event update needsAttention"));
  }, 30000);

  test("a session first met mid-flight is looked up: ours opens a row, a subagent or another folder does not", async () => {
    const log = await replay({
      v2: true, hold: true,
      sessions: {
        [S]: { id: S, title: "Old work", location: { directory: D }, time: { created: 1_700_000_000_000 } },
        ses_sub: { id: "ses_sub", parentID: S, location: { directory: D }, time: { created: 1 } },
        ses_far: { id: "ses_far", location: { directory: "/elsewhere" }, time: { created: 1 } },
      },
      steps: [
        v2("session.execution.started", { sessionID: "ses_far" }, false),
        v2("session.execution.started", { sessionID: "ses_sub" }, false),
        v2("session.execution.started", { sessionID: "ses_gone" }, false), // lookup throws: dropped
        started2, waitFor("event start"), succeeded2, waitFor("event done"),
      ],
    });
    expect(log.filter((entry) => entry.startsWith("TIMEOUT"))).toEqual([]);
    expect(log.slice(0, 2)).toEqual(["event start working", "event done done"]);
  }, 30000);
});
