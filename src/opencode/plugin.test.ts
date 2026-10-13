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

async function replay(scenario: { hold: boolean; gateFirstEvent?: boolean; steps: unknown[] }): Promise<string[]> {
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
