import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelPending, claimPending, GONE_MSG, handoffArgv, laterStatus, needsPairing, type Pending, readPending, resolveSession, waitThenHandoff, type WaitDeps,
} from "./handoff-later";

const A = "0a1b2c3d-1111-4222-8333-444455556666";
const B = "9f8e7d6c-1111-4222-8333-444455556666";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "nomo-later-")); dirs.push(d); return d; };
const pending = (o: Partial<Pending> = {}): Pending => ({ helperPid: 500, session: A, claudePid: 400, state: "waiting", startedAt: 1, ...o });

describe("resolveSession", () => {
  test("the ${CLAUDE_SESSION_ID} substitution wins; the pid must be an ancestor", () => {
    expect(resolveSession({ substituted: A, env: { CLAUDE_CODE_SESSION_ID: B, CLAUDE_PID: "400" }, ancestors: [300, 400], records: [] }))
      .toEqual({ session: A, claudePid: 400 });
    expect(resolveSession({ substituted: A, env: { CLAUDE_PID: "999" }, ancestors: [300, 400], records: [] }).claudePid).toBeUndefined();
  });

  test("an unsubstituted/empty id falls back to CLAUDE_CODE_SESSION_ID", () => {
    expect(resolveSession({ substituted: "", env: { CLAUDE_CODE_SESSION_ID: B, CLAUDE_PID: "400" }, ancestors: [400], records: [] }).session).toBe(B);
    expect(resolveSession({ substituted: "${CLAUDE_SESSION_ID}", env: { CLAUDE_CODE_SESSION_ID: B }, ancestors: [], records: [] }).session).toBe(B);
  });

  test("no id at all: the Nomo record whose claude pid is an ancestor, and its pid", () => {
    const records = [{ id: B, pid: 777 }, { id: A, pid: 400 }];
    expect(resolveSession({ env: {}, ancestors: [300, 400, 1], records })).toEqual({ session: A, claudePid: 400 });
    expect(resolveSession({ env: {}, ancestors: [300], records })).toEqual({ session: undefined, claudePid: undefined });
  });
});

test("needsPairing: only a box recorded as paired to THIS worker passes", () => {
  expect(needsPairing({}, "https://w")).toBe(true);
  expect(needsPairing({ sandboxId: "sb1" }, "https://w")).toBe(true);
  expect(needsPairing({ sandboxId: "sb1", pairedTo: "sb1 https://other" }, "https://w")).toBe(true);
  expect(needsPairing({ sandboxId: "sb2", pairedTo: "sb1 https://w" }, "https://w")).toBe(true); // a new box
  expect(needsPairing({ sandboxId: "sb1", pairedTo: "sb1 https://w" }, "https://w")).toBe(false);
});

describe("single-flight", () => {
  test("a live helper blocks a second claim; a dead one's file is reclaimed", () => {
    const path = join(tmp(), "p.json");
    let live = true;
    const d = { path, isHelper: () => live };
    expect(claimPending(d, pending())).toBe(true);
    expect(claimPending(d, pending({ session: B }))).toBe(false);
    expect(readPending(path)?.session).toBe(A);
    live = false;
    expect(claimPending(d, pending({ session: B }))).toBe(true);
    expect(readPending(path)?.session).toBe(B);
  });
});

describe("cancel", () => {
  test("kills a waiting helper and clears the file", () => {
    const dir = tmp(), path = join(dir, "p.json"), log = join(dir, "h.log");
    writeFileSync(path, JSON.stringify(pending()));
    const killed: number[] = [];
    expect(cancelPending({ path, isHelper: () => true, kill: (p) => killed.push(p), log })).toContain("Cancelled");
    expect(killed).toEqual([500]);
    expect(existsSync(path)).toBe(false);
    expect(laterStatus({ path, isHelper: () => true, log })).toContain("CANCELLED");
  });

  test("never kills one that is already handing off; nothing pending is fine", () => {
    const path = join(tmp(), "p.json");
    writeFileSync(path, JSON.stringify(pending({ state: "handing-off" })));
    const killed: number[] = [];
    expect(cancelPending({ path, isHelper: () => true, kill: (p) => killed.push(p) })).toContain("Too late");
    expect(killed).toEqual([]);
    rmSync(path);
    expect(cancelPending({ path, isHelper: () => true, kill: (p) => killed.push(p) })).toContain("Nothing to cancel");
  });
});

describe("waitThenHandoff", () => {
  function deps(path: string, aliveFor: number, code = 0): WaitDeps & { lines: string[]; notes: string[]; runs: number; t: number } {
    const d = {
      lines: [] as string[], notes: [] as string[], runs: 0, t: 0,
      pending: path, selfPid: 500, capMs: 60_000,
      alive: () => d.t < aliveFor,
      now: () => d.t,
      sleep: async (ms: number) => { d.t += ms; },
      runHandoff: async () => { d.runs++; expect(readPending(path)?.state).toBe("handing-off"); return code; },
      log: (l: string) => d.lines.push(l),
      notify: (n: string) => d.notes.push(n),
    };
    return d;
  }

  test("waits for claude to exit, then hands off once and releases the lock", async () => {
    const path = join(tmp(), "p.json");
    writeFileSync(path, JSON.stringify(pending()));
    const d = deps(path, 10_000);
    expect(await waitThenHandoff(pending(), d)).toBe(0);
    expect(d.runs).toBe(1);
    expect(d.t).toBeGreaterThanOrEqual(10_000);
    expect(d.lines.at(-1)).toStartWith("DONE:");
    expect(d.notes).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
    expect(laterStatus({ path, isHelper: () => false, log: "/nope" })).toBe("No handoff waiting.");
  });

  test("a failed handoff logs FAILED and notifies", async () => {
    const path = join(tmp(), "p.json");
    const d = deps(path, 0, 1);
    expect(await waitThenHandoff(pending(), d)).toBe(1);
    expect(d.lines.at(-1)).toStartWith("FAILED:");
    expect(d.notes[0]).toContain("still on this Mac");
  });

  test("a plugin removed during the wait: shim fallback, else a clear FAILED", async () => {
    const o = { runtime: "/bin/bun", self: "/old/dist/handoff.mjs", shim: "/cc/hook-shim.sh", args: ["--session", A] };
    expect(handoffArgv({ ...o, exists: () => true })).toEqual(["/bin/bun", o.self, "--session", A]);
    expect(handoffArgv({ ...o, exists: (p) => p === o.shim })).toEqual([o.shim, "handoff", "--session", A]);
    expect(handoffArgv({ ...o, exists: () => false })).toBeUndefined();

    const path = join(tmp(), "p.json");
    writeFileSync(path, JSON.stringify(pending()));
    const d = deps(path, 0);
    d.runHandoff = async () => { const argv = handoffArgv({ ...o, exists: () => false }); if (!argv) throw new Error(GONE_MSG); return 0; };
    expect(await waitThenHandoff(pending(), d)).toBe(1);
    expect(d.lines.at(-1)).toBe(`FAILED: ${GONE_MSG}. Your session is still on this Mac.`);
    expect(existsSync(path)).toBe(false);
  });

  test("gives up at the cap without handing off", async () => {
    const path = join(tmp(), "p.json");
    writeFileSync(path, JSON.stringify(pending()));
    const d = deps(path, Infinity);
    expect(await waitThenHandoff(pending(), d)).toBe(1);
    expect(d.runs).toBe(0);
    expect(d.t).toBe(60_000);
    expect(d.lines.at(-1)).toStartWith("FAILED:");
    expect(existsSync(path)).toBe(false);
  });

  test("status shows the waiting helper, then the log's last line once it is gone", () => {
    const dir = tmp(), path = join(dir, "p.json"), log = join(dir, "h.log");
    writeFileSync(path, JSON.stringify(pending()));
    expect(laterStatus({ path, isHelper: () => true, log })).toContain(`Waiting for Claude Code (pid 400) to quit, then moving session ${A}`);
    writeFileSync(log, "x\n[t] DONE: session moved\n");
    expect(laterStatus({ path, isHelper: () => false, log })).toContain("Last: [t] DONE: session moved");
  });
});
