// Tests for the Antigravity producer (core/antigravity.ts), its entry, the `{}`-printing wrapper and
// the hooks.json installer. Nothing here touches the network, the real ~/.gemini or ~/.config/cc-status:
// every spawned process gets a temp HOME.

import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { adapterFor, antigravityAdapter } from "./adapter";
import {
  ANTIGRAVITY_EVENTS, ANTIGRAVITY_KEEPALIVE_MS, antigravityCwd, antigravityEventKind, antigravityOwnerPid,
  planAntigravity, runAntigravityHook,
} from "./antigravity";
import { decryptBlob } from "./crypto";
import { Config, readRecord, SessionRecord } from "./shared";
import { isClaudeIdleReapEligible } from "../entries/cc-watchdog";
import { createProcessHygiene, isolatedTestEnv } from "../test/process-hygiene";

const { spawnTestProcess } = createProcessHygiene();
const PLUGIN = join(import.meta.dir, "../../plugin");
const KEY = new Uint8Array(32).fill(7);
const CONFIG: Config = { url: "https://example.invalid", pairingId: "pairing-1", pcSecret: "secret", e2eKey: KEY };
const CONV = "c0ffee00-0000-4000-8000-000000000001";
const NOW = 1_800_000_000_000;

const tmps: string[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), "nomo-antigravity-")));
  tmps.push(d);
  return d;
}

const rec = (over: Partial<SessionRecord>): SessionRecord =>
  ({ op: "update", lastEvent: "working", ts: NOW - 60_000, agent: "antigravity", ...over }) as SessionRecord;

describe("event → state mapping", () => {
  test("only PreInvocation creates a row", () => {
    expect(planAntigravity("turn", null, NOW)).toMatchObject({ op: "start", status: "working" });
    for (const k of ["start", "beat", "stop"] as const) expect(planAntigravity(k, null, NOW)).toBeNull();
  });
  test("PreInvocation on a done row opens a new turn", () => {
    const p = planAntigravity("turn", rec({ op: "done", lastEvent: "done", turnStartedAt: 1 }), NOW);
    expect(p).toMatchObject({ op: "update", status: "working", turnStartedAt: Math.floor(NOW / 1000) });
  });
  test("PostInvocation / PostToolUse keep a working row alive, throttled; never revive a done one", () => {
    expect(planAntigravity("beat", rec({ turnStartedAt: 5 }), NOW)).toMatchObject({ op: "update", status: "working", turnStartedAt: 5 });
    expect(planAntigravity("beat", rec({ ts: NOW - ANTIGRAVITY_KEEPALIVE_MS + 1 }), NOW)).toBeNull();
    expect(planAntigravity("turn", rec({ ts: NOW - 1 }), NOW)).toBeNull();
    expect(planAntigravity("beat", rec({ op: "done", lastEvent: "done" }), NOW)).toBeNull();
  });
  test("Stop → done; a second Stop on a delivered done adds nothing", () => {
    expect(planAntigravity("stop", rec({}), NOW)).toMatchObject({ op: "done", status: "done" });
    expect(planAntigravity("stop", rec({ op: "done", lastEvent: "done" }), NOW)).toBeNull();
    expect(planAntigravity("stop", rec({ op: "done", lastEvent: "done", donePending: true }), NOW)).toMatchObject({ op: "done" });
  });
  test("event names come from argv; payload shape is only a non-creating fallback", () => {
    expect(antigravityEventKind("PreInvocation", {})).toBe("turn");
    expect(antigravityEventKind("PostInvocation", {})).toBe("beat");
    expect(antigravityEventKind("PreToolUse", {})).toBeUndefined();
    expect(antigravityEventKind(undefined, { invocationNum: 0 })).toBe("beat");
    expect(antigravityEventKind(undefined, { fullyIdle: true })).toBe("stop");
    expect(antigravityEventKind(undefined, {})).toBeUndefined();
  });
  test("registered events never include PreToolUse", () => {
    expect(ANTIGRAVITY_EVENTS.sort()).toEqual(["PostInvocation", "PostToolUse", "PreInvocation", "SessionStart", "Stop"]);
  });
  test("workspace: path or file:// URI, nothing else", () => {
    expect(antigravityCwd({ workspacePaths: ["/a/b"] })).toBe("/a/b");
    expect(antigravityCwd({ workspacePaths: ["file:///a/my%20b"] })).toBe("/a/my b");
    expect(antigravityCwd({ workspacePaths: ["relative"] })).toBeUndefined();
    expect(antigravityCwd({})).toBeUndefined();
  });
  test("owner: nearest agy, else outermost app main executable", () => {
    const app = "/Applications/Antigravity.app/Contents/MacOS/Antigravity --x";
    expect(antigravityOwnerPid([{ pid: 9, command: "sh" }, { pid: 8, command: "/usr/local/bin/agy" }, { pid: 1, command: app }])).toBe(8);
    expect(antigravityOwnerPid([{ pid: 9, command: "sh" }, { pid: 3, command: app }, { pid: 2, command: app }])).toBe(2);
    expect(antigravityOwnerPid([{ pid: 9, command: "vim /Applications/Antigravity.app/Contents/MacOS/Antigravity" }])).toBeUndefined();
  });
  test("adapter wiring: agent literal rides the blob; the idle reap settles a silent working row", () => {
    expect(adapterFor("antigravity")).toBe(antigravityAdapter);
    expect(antigravityAdapter.blobAgentFields).toEqual({ agent: "antigravity" });
    expect(isClaudeIdleReapEligible(rec({ ts: NOW - 31 * 60_000 }), NOW, () => undefined)).toBe(true);
    expect(isClaudeIdleReapEligible(rec({ ts: NOW - 31 * 60_000, transcript: "/t" }), NOW, () => NOW - 1000)).toBe(false);
  });
});

describe("runAntigravityHook", () => {
  async function harness() {
    const dir = await tmp();
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const posts: Record<string, unknown>[] = [];
    let clock = NOW;
    const deps = {
      config: CONFIG, sessionsDir, stampPath: join(dir, "stamp"), now: () => clock,
      ownerPid: () => undefined, chatTitle: () => "Refactor parser", ensureWatchdog: () => {}, trace: () => {},
      post: async (_c: Config, e: Record<string, unknown>) => { posts.push(e); return true; },
    };
    const fire = (event: string, extra: Record<string, unknown> = {}) =>
      runAntigravityHook(JSON.stringify({ conversationId: CONV, workspacePaths: ["/w/proj"], modelName: "gemini-3-pro", ...extra }), event, deps);
    return { dir, sessionsDir, posts, deps, fire, tick: (ms: number) => { clock += ms; } };
  }

  test("a turn: PreInvocation creates working, Stop sends done — agent/title/model in the blob", async () => {
    const h = await harness();
    await h.fire("SessionStart");
    expect(h.posts).toHaveLength(0); // stamp only
    await h.fire("PreInvocation", { invocationNum: 0 });
    expect(h.posts).toHaveLength(1);
    expect(await decryptBlob(KEY, h.posts[0]!.blob as string)).toMatchObject({
      status: "working", agent: "antigravity", title: "Refactor parser", model: "gemini-3-pro",
    });
    await h.fire("Stop", { terminationReason: "model_stop", fullyIdle: true });
    expect(h.posts).toHaveLength(2);
    expect(await decryptBlob(KEY, h.posts[1]!.blob as string)).toMatchObject({ status: "done", agent: "antigravity" });
    expect((await readRecord(CONV, h.sessionsDir))?.agent).toBe("antigravity");
  });

  test("not paired / malformed / no id / another agent's row → no POST, never throws", async () => {
    const h = await harness();
    await runAntigravityHook(JSON.stringify({ conversationId: CONV }), "PreInvocation", { ...h.deps, config: null });
    for (const raw of ["", "not json", "[]", "null", JSON.stringify({ conversationId: "../x" })]) {
      await runAntigravityHook(raw, "PreInvocation", h.deps);
    }
    await writeFile(join(h.sessionsDir, `${CONV}.json`), JSON.stringify({ agent: "claude", op: "update", lastEvent: "working", ts: NOW }));
    await h.fire("Stop");
    expect(h.posts).toHaveLength(0);
  });
});

describe("antigravity-hook.sh (what hooks.json runs)", () => {
  async function runWrapper(stdin: string, home: string, root = join(PLUGIN, "scripts")) {
    const proc = spawnTestProcess({
      cmd: [join(root, "antigravity-hook.sh"), "PreInvocation"],
      env: isolatedTestEnv(home), stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out };
  }

  test("prints {} and exits 0 on malformed stdin and with no pairing (temp HOME)", async () => {
    const home = await tmp();
    for (const input of ["", "garbage", JSON.stringify({ conversationId: CONV, workspacePaths: ["/w"] })]) {
      const r = await runWrapper(input, home);
      expect(r.code).toBe(0);
      expect(r.out).toBe("{}\n");
    }
  });

  test("prints {} and exits 0 even when the bundle crashes", async () => {
    const home = await tmp();
    const root = join(await tmp(), "plugin");
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await cp(join(PLUGIN, "scripts", "antigravity-hook.sh"), join(root, "scripts", "antigravity-hook.sh"));
    await writeFile(join(root, "scripts", "run.sh"), "#!/bin/sh\necho noise; echo err >&2; exit 3\n", { mode: 0o755 });
    const r = await runWrapper("{}", home, join(root, "scripts"));
    expect(r.code).toBe(0);
    expect(r.out).toBe("{}\n");
  });
});

describe("antigravity-install.mjs", () => {
  /** A throwaway plugin root with the real installer + wrapper and a stub bundle, and a temp HOME. */
  async function box() {
    const t = await tmp();
    const root = join(t, "nomo", "plugin");
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    for (const f of ["antigravity-install.mjs", "antigravity-hook.sh"]) await cp(join(PLUGIN, "scripts", f), join(root, "scripts", f));
    await writeFile(join(root, "dist", "antigravity-status.mjs"), "// stub\n");
    const home = join(t, "home");
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    const hooks = join(home, ".gemini", "config", "hooks.json");
    const run = async (...args: string[]) => {
      const proc = spawnTestProcess({
        cmd: ["node", join(root, "scripts", "antigravity-install.mjs"), ...args],
        env: isolatedTestEnv(home), stdout: "pipe", stderr: "pipe",
      });
      const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, out: o + e };
    };
    return { root, home, hooks, run, read: async () => JSON.parse(await readFile(hooks, "utf8")) };
  }
  const FOREIGN = { herdr: { PreInvocation: [{ type: "command", command: "bash '/x/herdr.sh' session", timeout: 10 }] }, other: { enabled: false } };

  test("creates the file, writes one flat/matcher-correct 'nomo' block, never PreToolUse", async () => {
    const b = await box();
    expect((await b.run()).code).toBe(0);
    const doc = await b.read();
    expect(Object.keys(doc)).toEqual(["nomo"]);
    const cmd = (e: string) => `'${join(b.root, "scripts", "antigravity-hook.sh")}' ${e}`;
    expect(doc.nomo).toEqual({
      enabled: true,
      SessionStart: [{ type: "command", command: cmd("SessionStart"), timeout: 10 }],
      PreInvocation: [{ type: "command", command: cmd("PreInvocation"), timeout: 10 }],
      PostInvocation: [{ type: "command", command: cmd("PostInvocation"), timeout: 10 }],
      Stop: [{ type: "command", command: cmd("Stop"), timeout: 10 }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmd("PostToolUse"), timeout: 10 }] }],
    });
    expect(JSON.stringify(doc)).not.toContain("PreToolUse");
    for (const e of ["SessionStart", "PreInvocation", "PostInvocation", "Stop"]) {
      expect(doc.nomo[e][0]).not.toHaveProperty("matcher");
      expect(doc.nomo[e][0]).not.toHaveProperty("hooks");
    }
  });

  test("idempotent: a second install does not rewrite the file", async () => {
    const b = await box();
    await b.run();
    const first = await readFile(b.hooks, "utf8");
    const r = await b.run();
    expect(r.out).toContain("already up to date");
    expect(await readFile(b.hooks, "utf8")).toBe(first);
  });

  test("preserves foreign blocks; rewrites a stale nomo block wholesale; uninstall removes only nomo", async () => {
    const b = await box();
    await writeFile(b.hooks, JSON.stringify({ ...FOREIGN, nomo: { PreToolUse: [{ matcher: "*", hooks: [] }] } }));
    await b.run();
    const doc = await b.read();
    expect(doc.herdr).toEqual(FOREIGN.herdr);
    expect(doc.other).toEqual(FOREIGN.other);
    expect(doc.nomo.PreToolUse).toBeUndefined();
    expect((await b.run("--uninstall")).code).toBe(0);
    expect(await b.read()).toEqual(FOREIGN);
    expect((await b.run("--uninstall")).out).toContain("no Nomo block found");
  });

  test("refuses invalid JSON / non-object and writes nothing; writes through a symlink", async () => {
    const b = await box();
    for (const bad of ["{oops", "[1]"]) {
      await writeFile(b.hooks, bad);
      const r = await b.run();
      expect(r.code).toBe(1);
      expect(await readFile(b.hooks, "utf8")).toBe(bad);
    }
    const real = join(b.home, "dotfiles-hooks.json");
    await writeFile(real, JSON.stringify(FOREIGN));
    await rm(b.hooks);
    await symlink(real, b.hooks);
    await b.run();
    expect(JSON.parse(await readFile(real, "utf8")).nomo).toBeDefined();
  });

  test("no ~/.gemini/config → refuses (Antigravity not installed)", async () => {
    const b = await box();
    await rm(join(b.home, ".gemini"), { recursive: true });
    const r = await b.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("open Antigravity once first");
  });
});

