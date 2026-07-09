import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { classifyResetSession, isWatchdogCommand, reset } from "./reset";
import type { Config, SessionRecord } from "../core/shared";

// reset is the user-facing panic button: stop the watchdog, clear dead/phantom rows, KEEP the pairing.

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  pid: 4242, machine: "Mac", label: "proj", ts: Date.now(), ...over,
});

describe("classifyResetSession (the dead-pid / provisional sweep decision)", () => {
  test("live real session → keep (reset must never touch a running session)", () => {
    expect(classifyResetSession(rec(), () => true)).toBe("keep");
  });

  test("dead pid → clear", () => {
    expect(classifyResetSession(rec(), () => false)).toBe("clear");
  });

  test("provisional records are cleared even when their pid is alive (the phantom-row case)", () => {
    expect(classifyResetSession(rec({ provisional: true }), () => true)).toBe("clear");
  });

  test("corrupt / pid-less records are cleared (nothing can ever reap them)", () => {
    expect(classifyResetSession(null, () => true)).toBe("clear");
    expect(classifyResetSession(rec({ pid: Number.NaN }), () => true)).toBe("clear");
    expect(classifyResetSession({ machine: "m" } as unknown as SessionRecord, () => true)).toBe("clear");
  });
});

describe("isWatchdogCommand (never kill a recycled pid)", () => {
  test("matches the daemon's runtime + script forms", () => {
    expect(isWatchdogCommand("/Users/k/.bun/bin/bun /path/plugin/dist/cc-watchdog.mjs")).toBe(true);
    expect(isWatchdogCommand("node /x/cc-watchdog.mjs")).toBe(true);
    expect(isWatchdogCommand("bun /repo/src/entries/cc-watchdog.ts")).toBe(true);
  });

  test("rejects unrelated processes that recycled the pid", () => {
    expect(isWatchdogCommand("/Applications/Safari.app/Contents/MacOS/Safari")).toBe(false);
    expect(isWatchdogCommand("")).toBe(false);
  });
});

describe("reset (end-to-end with injected seams)", () => {
  const CONFIG: Config = {
    url: "https://worker.example", pairingId: "p-1", pcSecret: "s-1", e2eKey: new Uint8Array(32),
  };

  test("kills a verified watchdog, ends+clears dead/provisional rows, keeps live ones, keeps pairing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-reset-"));
    const sessions = join(dir, "sessions");
    await writeFile(join(dir, "watchdog.pid"), "555");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "dead.json"), JSON.stringify(rec({ pid: 111 })));
    await writeFile(join(sessions, "live.json"), JSON.stringify(rec({ pid: 222 })));
    await writeFile(join(sessions, "prov.json"), JSON.stringify(rec({ pid: 222, provisional: true })));
    await writeFile(join(sessions, "corrupt.json"), "{nope");

    const killed: number[] = [];
    const posts: { sessionId: string }[] = [];
    const lines: string[] = [];
    const fetchFn = (async (_url: unknown, init?: { body?: string }) => {
      posts.push(JSON.parse(init?.body ?? "{}") as { sessionId: string });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const code = await reset({
      print: (l) => lines.push(l),
      fetchFn,
      loadConfigFn: async () => CONFIG,
      sessionsDir: sessions,
      watchdogPidPath: join(dir, "watchdog.pid"),
      isAlive: (pid) => pid === 222,
      commandOf: (pid) => (pid === 555 ? "bun /x/dist/cc-watchdog.mjs" : undefined),
      killPid: (pid) => { killed.push(pid); },
    });

    expect(code).toBe(0);
    expect(killed).toEqual([555]);
    // pidfile removed
    await expect(readFile(join(dir, "watchdog.pid"), "utf8")).rejects.toThrow();
    // dead + provisional + corrupt cleared; live kept
    expect((await readdir(sessions)).sort()).toEqual(["live.json"]);
    // ends POSTed for every cleared record, under the current pairing
    expect(posts.map((p) => p.sessionId).sort()).toEqual(["corrupt", "dead", "prov"]);
    // summary mentions the kill, the clears, the kept session, and the pairing guarantee
    const all = lines.join("\n");
    expect(all).toContain("Stopped the watchdog");
    expect(all).toContain("Cleared 3 stale session records (3 end signals delivered to your phone).");
    expect(all).toContain("Left 1 live session untouched.");
    expect(all).toContain("Pairing and keys were not touched");
  });

  test("a recycled pid is NOT killed; unpaired sweep still clears locally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-reset-"));
    const sessions = join(dir, "sessions");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(dir, "watchdog.pid"), "777");
    await writeFile(join(sessions, "dead.json"), JSON.stringify(rec({ pid: 111 })));

    const killed: number[] = [];
    const lines: string[] = [];
    const code = await reset({
      print: (l) => lines.push(l),
      fetchFn: (async () => { throw new Error("must not POST while unpaired"); }) as unknown as typeof fetch,
      loadConfigFn: async () => null,
      sessionsDir: sessions,
      watchdogPidPath: join(dir, "watchdog.pid"),
      isAlive: () => false,
      commandOf: () => "/Applications/Safari.app/Contents/MacOS/Safari", // recycled pid
      killPid: (pid) => { killed.push(pid); },
    });

    expect(code).toBe(0);
    expect(killed).toEqual([]); // verified NOT the watchdog → untouched
    expect(await readdir(sessions)).toEqual([]); // still cleared locally
    const all = lines.join("\n");
    expect(all).toContain("stale watchdog pidfile");
    expect(all).toContain("not paired — cleared locally only");
  });

  test("nothing to do is a clean success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-reset-"));
    const lines: string[] = [];
    const code = await reset({
      print: (l) => lines.push(l),
      loadConfigFn: async () => null,
      sessionsDir: join(dir, "sessions"), // doesn't exist
      watchdogPidPath: join(dir, "watchdog.pid"), // doesn't exist
    });
    expect(code).toBe(0);
    const all = lines.join("\n");
    expect(all).toContain("No watchdog running.");
    expect(all).toContain("No stale sessions to clear.");
  });
});
