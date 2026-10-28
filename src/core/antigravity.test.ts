// Tests for the Antigravity producer (core/antigravity.ts), its entry, the `{}`-printing wrapper and
// the hooks.json installer. Nothing here touches the network, the real ~/.gemini or ~/.config/cc-status:
// every spawned process gets a temp HOME.

import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  adapterFor, antigravityAdapter, antigravityChatTitle, antigravityDataDirFor, antigravityFirstPrompt, antigravityRunStatus,
} from "./adapter";
import {
  ANTIGRAVITY_EVENTS, ANTIGRAVITY_INTERRUPT_MAX_AGE_MS, ANTIGRAVITY_INTERRUPT_SUFFIX, pruneStaleAntigravityStops, ANTIGRAVITY_KEEPALIVE_MS, ANTIGRAVITY_TERMINATE, antigravityCwd, antigravityEventKind, antigravityHookParent, antigravityOwnerPid,
  planAntigravity, runAntigravityHook,
} from "./antigravity";
import { decryptBlob } from "./crypto";
import { Config, interruptFlagFileName, readRecord, SessionRecord, writeInterruptFlagAt } from "./shared";
import {
  ANTIGRAVITY_SETTLE_GRACE_MS, antigravityRunSettled, antigravitySettleTick, antigravityTurnContinuing, classifySession,
  correctIdleClaude, isClaudeIdleReapEligible,
} from "../entries/cc-watchdog";
import { markNudged, writeReceipt } from "./antigravity-inbox";
import { createProcessHygiene, isolatedTestEnv } from "../test/process-hygiene";
import { plainAge, statusCmd } from "../entries/status-cmd";

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
    const printed: string[] = [];
    let clock = NOW;
    const deps = {
      config: CONFIG, sessionsDir, stampPath: join(dir, "stamp"), now: () => clock,
      ownerPid: () => undefined, chatTitle: () => "Refactor parser", ensureWatchdog: () => {}, trace: () => {},
      post: async (_c: Config, e: Record<string, unknown>) => { posts.push(e); return true; },
      emit: async (line: string) => { printed.push(line); },
    };
    const fire = (event: string, extra: Record<string, unknown> = {}) =>
      runAntigravityHook(JSON.stringify({ conversationId: CONV, workspacePaths: ["/w/proj"], modelName: "gemini-3-pro", ...extra }), event, deps);
    const flagged = () => readFile(join(sessionsDir, interruptFlagFileName(CONV, ANTIGRAVITY_INTERRUPT_SUFFIX)), "utf8").then(() => true, () => false);
    return { dir, sessionsDir, posts, printed, deps, fire, flagged, now: () => clock, tick: (ms: number) => { clock += ms; } };
  }

  test("phone Stop: the next PostInvocation prints terminate ONCE, consumes the flag, and the row goes done", async () => {
    const h = await harness();
    await h.fire("PreInvocation", { invocationNum: 0 });
    await h.fire("PostInvocation", { invocationNum: 0 });
    expect(h.printed).toEqual([]); // no flag → nothing printed (the wrapper prints {})
    await writeInterruptFlagAt(h.sessionsDir, CONV, h.now(), ANTIGRAVITY_INTERRUPT_SUFFIX);
    await h.fire("PreInvocation", { invocationNum: 1 }); // PreInvocation never terminates
    expect(h.printed).toEqual([]);
    await h.fire("PostInvocation", { invocationNum: 1 });
    expect(h.printed).toEqual([ANTIGRAVITY_TERMINATE]);
    expect(await h.flagged()).toBe(false);
    expect(await decryptBlob(KEY, h.posts.at(-1)!.blob as string)).toMatchObject({ status: "done" });
    const n = h.posts.length;
    await h.fire("PostInvocation", { invocationNum: 2 });
    await h.fire("Stop", { terminationReason: "terminated" }); // Antigravity's own Stop: a no-op now
    expect(h.printed).toEqual([ANTIGRAVITY_TERMINATE]);
    expect(h.posts).toHaveLength(n);
  });

  test("a stale flag, or one left by a finished turn, never stops a later turn", async () => {
    const h = await harness();
    await h.fire("PreInvocation", { invocationNum: 0 });
    await writeInterruptFlagAt(h.sessionsDir, CONV, h.now(), ANTIGRAVITY_INTERRUPT_SUFFIX);
    h.tick(ANTIGRAVITY_INTERRUPT_MAX_AGE_MS + 1);
    await h.fire("PostInvocation");
    expect(h.printed).toEqual([]); // expired
    await writeInterruptFlagAt(h.sessionsDir, CONV, h.now(), ANTIGRAVITY_INTERRUPT_SUFFIX);
    await h.fire("Stop");           // the turn ended on its own → flag cleared
    expect(await h.flagged()).toBe(false);
    await writeInterruptFlagAt(h.sessionsDir, CONV, h.now(), ANTIGRAVITY_INTERRUPT_SUFFIX);
    await h.fire("PreInvocation");  // new turn over a done row → flag cleared
    expect(await h.flagged()).toBe(false);
    await h.fire("PostInvocation");
    expect(h.printed).toEqual([]);
  });

  test("Antigravity's own flag name (never Claude Code's), an hour of life, and stale ones pruned on the slow path", async () => {
    expect(ANTIGRAVITY_INTERRUPT_SUFFIX).toBe(".agy-interrupt");
    expect(antigravityAdapter.interruptFlagSuffix).toBe(ANTIGRAVITY_INTERRUPT_SUFFIX);
    expect(ANTIGRAVITY_INTERRUPT_MAX_AGE_MS).toBe(60 * 60_000);
    const h = await harness();
    await h.fire("PreInvocation", { invocationNum: 0 });
    await writeInterruptFlagAt(h.sessionsDir, CONV, h.now()); // a CLAUDE flag for the same id: not ours
    await h.fire("PostInvocation");
    expect(h.printed).toEqual([]);
    // stale flags of any conversation are deleted; fresh ones are kept
    await writeInterruptFlagAt(h.sessionsDir, "old-one", h.now() - ANTIGRAVITY_INTERRUPT_MAX_AGE_MS - 1, ANTIGRAVITY_INTERRUPT_SUFFIX);
    await writeInterruptFlagAt(h.sessionsDir, "fresh-one", h.now(), ANTIGRAVITY_INTERRUPT_SUFFIX);
    await pruneStaleAntigravityStops(h.sessionsDir, h.now());
    const left = (await readdir(h.sessionsDir)).filter((n) => n.includes("interrupt")).sort();
    expect(left).toEqual([`${CONV}.interrupt`, "fresh-one.agy-interrupt"]);
  });

  test("an emit that throws never escapes the hook", async () => {
    const h = await harness();
    await writeInterruptFlagAt(h.sessionsDir, CONV, h.now(), ANTIGRAVITY_INTERRUPT_SUFFIX);
    await runAntigravityHook(JSON.stringify({ conversationId: CONV }), "PostInvocation", {
      ...h.deps, emit: async () => { throw new Error("EPIPE"); },
    });
    expect(h.printed).toEqual([]);
  });

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

  test("title fallback: chat title > first prompt > workspace folder name (file:// decoded)", async () => {
    const h = await harness();
    let prompt: string | undefined;
    const deps = { ...h.deps, chatTitle: () => undefined, firstPrompt: async () => prompt };
    const fire = (event: string) => runAntigravityHook(JSON.stringify({
      conversationId: CONV, workspacePaths: ["file:///Users/x/My%20Proj"], invocationNum: 0,
    }), event, deps);
    await fire("PreInvocation");
    expect(await decryptBlob(KEY, h.posts.at(-1)!.blob as string)).toMatchObject({ title: "My Proj" });
    prompt = "Sum the parts";
    h.tick(ANTIGRAVITY_KEEPALIVE_MS + 1);
    await fire("PostInvocation");
    expect(await decryptBlob(KEY, h.posts.at(-1)!.blob as string)).toMatchObject({ title: "Sum the parts" });
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

  test("PostInvocation: passes ONLY the exact terminate line through; anything else → {}", async () => {
    const home = await tmp();
    const cases: [string, string][] = [
      [`printf '%s\\n' '${ANTIGRAVITY_TERMINATE}'`, `${ANTIGRAVITY_TERMINATE}\n`],
      ["", "{}\n"],
      ["echo garbage", "{}\n"],
      [`printf '%s\\n%s\\n' noise '${ANTIGRAVITY_TERMINATE}'`, "{}\n"],
      ["echo '{\"terminationBehavior\":\"terminate\"}'; exit 3", `${ANTIGRAVITY_TERMINATE}\n`],
      ["kill -9 $$", "{}\n"],
    ];
    await mkdir(join(home, ".config", "cc-status", "sessions"), { recursive: true });
    await writeFile(join(home, ".config", "cc-status", "sessions", `${CONV}.agy-interrupt`), "{}");
    for (const [script, want] of cases) {
      const root = join(await tmp(), "plugin");
      await mkdir(join(root, "scripts"), { recursive: true });
      await cp(join(PLUGIN, "scripts", "antigravity-hook.sh"), join(root, "scripts", "antigravity-hook.sh"));
      await writeFile(join(root, "scripts", "run.sh"), `#!/bin/sh\ncat >/dev/null\n${script}\n`, { mode: 0o755 });
      const proc = spawnTestProcess({
        cmd: [join(root, "scripts", "antigravity-hook.sh"), "PostInvocation"],
        env: isolatedTestEnv(home), stdin: new Blob([`{"conversationId":"${CONV}"}`]), stdout: "pipe", stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).toBe(want);
    }
  });

  test("the real bundle: PostInvocation with a phone flag terminates; without one prints {}", async () => {
    const home = await tmp();
    const sessions = join(home, ".config", "cc-status", "sessions");
    await mkdir(sessions, { recursive: true });
    const run = async () => {
      const proc = spawnTestProcess({
        cmd: [join(PLUGIN, "scripts", "antigravity-hook.sh"), "PostInvocation"],
        env: isolatedTestEnv(home), stdin: new Blob([JSON.stringify({ conversationId: CONV, invocationNum: 1 })]), stdout: "pipe", stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      return out;
    };
    expect(await run()).toBe("{}\n");
    await writeInterruptFlagAt(sessions, CONV, Date.now(), ANTIGRAVITY_INTERRUPT_SUFFIX);
    expect(await run()).toBe(`${ANTIGRAVITY_TERMINATE}\n`);
    expect(await run()).toBe("{}\n"); // consumed
    // a DETACHED run (no stop pending when its wrapper looked) never consumes a flag
    await writeInterruptFlagAt(sessions, CONV, Date.now(), ANTIGRAVITY_INTERRUPT_SUFFIX);
    await runAntigravityHook(JSON.stringify({ conversationId: CONV }), "PostInvocation", {
      config: null, sessionsDir: sessions, stampPath: join(home, "stamp"), canTerminate: false, emit: async () => { throw new Error("must not print"); },
    });
    expect(await readFile(join(sessions, interruptFlagFileName(CONV, ANTIGRAVITY_INTERRUPT_SUFFIX)), "utf8")).toContain("at");
  });

  test("non-blocking: with no stop pending the wrapper answers and exits before the bundle finishes", async () => {
    const home = await tmp();
    // Claude Code's own `.interrupt` flags must not drag Antigravity's PostInvocation onto the slow path
    await mkdir(join(home, ".config", "cc-status", "sessions"), { recursive: true });
    await writeFile(join(home, ".config", "cc-status", "sessions", "claude-sess.interrupt"), "{}");
    // …nor may ANOTHER Antigravity conversation's pending Stop (only the flagged conversation goes sync)
    await writeFile(join(home, ".config", "cc-status", "sessions", "c0ffee00-0000-4000-8000-0000000000ff.agy-interrupt"), "{}");
    const root = join(await tmp(), "plugin");
    const got = join(root, "got");
    await mkdir(join(root, "scripts"), { recursive: true });
    await cp(join(PLUGIN, "scripts", "antigravity-hook.sh"), join(root, "scripts", "antigravity-hook.sh"));
    await writeFile(join(root, "scripts", "run.sh"), `#!/bin/sh\nsleep 2\ncat > '${got}'\n`, { mode: 0o755 });
    for (const event of ["PreInvocation", "PostInvocation", "PostToolUse", "Stop"]) {
      const started = Date.now();
      const proc = spawnTestProcess({
        cmd: [join(root, "scripts", "antigravity-hook.sh"), event], env: isolatedTestEnv(home),
        stdin: new Blob([`{"conversationId":"${CONV}"}`]), stdout: "pipe", stderr: "pipe",
      });
      expect(await new Response(proc.stdout).text()).toBe("{}\n");
      expect(await proc.exited).toBe(0);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
    for (let i = 0; i < 80 && !(await readFile(got, "utf8").catch(() => "")); i++) await Bun.sleep(50);
    expect(await readFile(got, "utf8")).toBe(`{"conversationId":"${CONV}"}`); // the payload still reached the bundle
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
    for (const f of ["antigravity-install.mjs", "antigravity-hook.sh", "antigravity-approve.sh", "antigravity-skill-command.mjs"]) await cp(join(PLUGIN, "scripts", f), join(root, "scripts", f));
    for (const f of ["antigravity-status.mjs", "antigravity-approve.mjs"]) await writeFile(join(root, "dist", f), "// stub\n");
    await cp(join(PLUGIN, "antigravity-plugin"), join(root, "antigravity-plugin"), { recursive: true });
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

  test("creates the file, writes one flat/matcher-correct 'nomo' block; PreToolUse only for the approval tools", async () => {
    const b = await box();
    expect((await b.run()).code).toBe(0);
    const doc = await b.read();
    expect(Object.keys(doc)).toEqual(["nomo"]);
    const hook = join(b.root, "scripts", "antigravity-hook.sh");
    const cmd = (e: string) => `[ -x '${hook}' ] && exec '${hook}' ${e} || printf '%s\\n' '{}'`;
    const approve = join(b.root, "scripts", "antigravity-approve.sh");
    expect(doc.nomo).toEqual({
      enabled: true,
      SessionStart: [{ type: "command", command: cmd("SessionStart"), timeout: 10 }],
      PreInvocation: [{ type: "command", command: cmd("PreInvocation"), timeout: 10 }],
      PostInvocation: [{ type: "command", command: cmd("PostInvocation"), timeout: 10 }],
      Stop: [{ type: "command", command: cmd("Stop"), timeout: 10 }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmd("PostToolUse"), timeout: 10 }] }],
      PreToolUse: [{
        matcher: "^(run_command|write_file|write_to_file|edit_file|replace_file_content|multi_replace_file_content)$",
        hooks: [{ type: "command", command: `[ -x '${approve}' ] && exec '${approve}' || printf '%s\\n' '{"decision":"allow"}'`, timeout: 86400 }],
      }],
    });
    for (const e of ["SessionStart", "PreInvocation", "PostInvocation", "Stop"]) {
      expect(doc.nomo[e][0]).not.toHaveProperty("matcher");
      expect(doc.nomo[e][0]).not.toHaveProperty("hooks");
    }
  });

  test("a plugin dir deleted without --uninstall: every registered command still answers, exit 0", async () => {
    const b = await box();
    await b.run();
    const doc = await b.read();
    const sh = async (command: string) => {
      const proc = spawnTestProcess({ cmd: ["sh", "-c", command], env: isolatedTestEnv(b.home), stdin: new Blob(["{}"]), stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      return { code: await proc.exited, out };
    };
    // installed: the real wrapper runs (the stub bundle prints nothing → the wrapper's own reply)
    expect(await sh(doc.nomo.Stop[0].command)).toEqual({ code: 0, out: "{}\n" });
    await rm(join(b.root, "scripts"), { recursive: true, force: true });
    for (const e of ["SessionStart", "PreInvocation", "PostInvocation", "Stop"]) {
      expect(await sh(doc.nomo[e][0].command)).toEqual({ code: 0, out: "{}\n" });
    }
    expect(await sh(doc.nomo.PostToolUse[0].hooks[0].command)).toEqual({ code: 0, out: "{}\n" });
    expect(await sh(doc.nomo.PreToolUse[0].hooks[0].command)).toEqual({ code: 0, out: '{"decision":"allow"}\n' });
  });

  test("installs the /nomo-* plugin (checkout path filled in), says so in plain words, and removes only it", async () => {
    const b = await box();
    const plugins = join(b.home, ".gemini", "config", "plugins");
    await mkdir(join(plugins, "someone-else"), { recursive: true });
    await writeFile(join(plugins, "someone-else", "plugin.json"), '{"name":"someone-else"}');
    const r = await b.run();
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("✅ Antigravity is connected to Nomo. Restart Antigravity, then type /nomo-pair.");
    const dest = join(plugins, "nomo");
    expect(JSON.parse(await readFile(join(dest, "plugin.json"), "utf8")).name).toBe("nomo");
    const skills = (await readdir(join(dest, "skills"))).sort();
    expect(skills).toEqual(["nomo-approvals", "nomo-pair", "nomo-reset", "nomo-status", "nomo-unpair"]);
    for (const name of skills) {
      const body = await readFile(join(dest, "skills", name, "SKILL.md"), "utf8");
      expect(body).not.toContain("{{nomo-command");
      expect(body).toContain(`'${b.root}/scripts/run.sh' '${b.root}/dist/`);
    }
    // paired → points at /nomo-status instead; a second install is a no-op refresh
    await mkdir(join(b.home, ".config", "cc-status"), { recursive: true });
    await writeFile(join(b.home, ".config", "cc-status", "config.json"), '{"e2eKeyB64":"x"}');
    const before = await readFile(join(dest, "skills", "nomo-pair", "SKILL.md"), "utf8");
    expect((await b.run()).out.trim()).toBe("✅ Antigravity is connected to Nomo. Restart Antigravity, then type /nomo-status to check.");
    expect(await readFile(join(dest, "skills", "nomo-pair", "SKILL.md"), "utf8")).toBe(before);
    // --verbose adds the technical lines
    expect((await b.run("--verbose")).out).toContain("antigravity-install: plugin ->");
    const u = await b.run("--uninstall");
    expect(u.out.trim()).toBe("✅ Nomo is removed from Antigravity. Restart Antigravity to finish. Your phone stays connected for your other coding apps.");
    expect(await readdir(plugins)).toEqual(["someone-else"]);
  });

  test("a 'nomo' plugin folder Nomo did not write → refuses and writes nothing", async () => {
    const b = await box();
    const dest = join(b.home, ".gemini", "config", "plugins", "nomo");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "plugin.json"), '{"name":"nomo"}');
    const r = await b.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("was not installed by Nomo");
    expect(await readdir(dest)).toEqual(["plugin.json"]);
    expect(await readFile(b.hooks, "utf8").catch(() => "absent")).toBe("absent");
    expect((await b.run("--uninstall")).code).toBe(0);
    expect(await readdir(dest)).toEqual(["plugin.json"]); // never removed either
  });

  test("an imported Claude Code plugin (nomo-cc) → a plain warning to remove it; never deleted", async () => {
    for (const [dir, manifest] of [
      [join(".gemini", "antigravity-cli", "plugins", "nomo-cc"), null],
      [join(".gemini", "config", "plugins", "imported-x"), join(".claude-plugin", "plugin.json")],
      [join(".gemini", "antigravity-cli", "plugins", "y"), "plugin.json"],
    ] as const) {
      const b = await box();
      const at = join(b.home, dir);
      await mkdir(join(at, ".claude-plugin"), { recursive: true });
      if (manifest) await writeFile(join(at, manifest), '{"name":"nomo-cc"}');
      const r = await b.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain("agy plugin uninstall nomo-cc");
      expect(existsSync(at)).toBe(true);
    }
    const clean = await box();
    expect((await clean.run()).out).not.toContain("nomo-cc");
  });

  test("a checkout path with a line break is refused, nothing written", async () => {
    const b = await box();
    const odd = join(dirname(dirname(b.root)), "odd\nname", "plugin");
    await mkdir(dirname(odd), { recursive: true });
    await cp(b.root, odd, { recursive: true });
    const proc = spawnTestProcess({ cmd: ["node", join(odd, "scripts", "antigravity-install.mjs")], env: isolatedTestEnv(b.home), stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    expect(await proc.exited).toBe(1);
    expect(out).toContain("line break");
    expect(existsSync(b.hooks)).toBe(false);
  });

  test("idempotent: a second install does not rewrite the file", async () => {
    const b = await box();
    await b.run();
    const first = await readFile(b.hooks, "utf8");
    const r = await b.run("--verbose");
    expect(r.out).toContain("already up to date");
    expect(await readFile(b.hooks, "utf8")).toBe(first);
  });

  test("preserves foreign blocks; rewrites a stale nomo block wholesale; uninstall removes only nomo", async () => {
    const b = await box();
    await writeFile(b.hooks, JSON.stringify({ ...FOREIGN, nomo: { PreToolUse: [{ matcher: "*", hooks: [] }], Bogus: [] } }));
    await b.run();
    const doc = await b.read();
    expect(doc.herdr).toEqual(FOREIGN.herdr);
    expect(doc.other).toEqual(FOREIGN.other);
    expect(doc.nomo.Bogus).toBeUndefined();
    expect(doc.nomo.PreToolUse[0].matcher).not.toBe("*");
    expect((await b.run("--uninstall")).code).toBe(0);
    expect(await b.read()).toEqual(FOREIGN);
    expect((await b.run("--uninstall")).out).toContain("nothing to remove");
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
    expect(r.out).toContain("open it once");
  });
});


// ── spike follow-ups (2026-10, app 2.25 / agy 1.4.8) ─────────────────────────────────────────────

/** Run `fn` with HOME pointed at a temp dir (the adapter derives every Antigravity path from it). */
async function withHome<T>(home: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); } finally { process.env.HOME = prev; }
}

/** A conversation_summaries.db in `<home>/.gemini/<dir>` with the columns the lookups read. */
function summariesDb(home: string, dir: string, rows: { id: string; title: string; status: string; mod: string }[]): void {
  const path = join(home, ".gemini", dir);
  execFileSync("mkdir", ["-p", path]);
  const sql = ["create table conversation_summaries (conversation_id text primary key, title text not null default '', status text not null default '', last_modified_time datetime not null);",
    ...rows.map((r) => `insert into conversation_summaries values ('${r.id}','${r.title}','${r.status}','${r.mod}');`)].join("\n");
  execFileSync("sqlite3", [join(path, "conversation_summaries.db"), sql]);
}

describe("FIX 1 — a turn that ends with no event is settled", () => {
  const working = (over: Partial<SessionRecord> = {}) => rec({ ts: NOW - ANTIGRAVITY_SETTLE_GRACE_MS, ...over });
  const idleAt = (ms: number) => () => ({ readAt: NOW, status: "CASCADE_RUN_STATUS_IDLE", lastModifiedMs: ms });

  test("IDLE written after the row's last event settles it", () => {
    expect(antigravityRunSettled(CONV, working(), NOW, idleAt(NOW - 5_000))).toBe(true);
  });
  test("a Stop's IDLE (last_modified_time NOT bumped, before the row's stamp) settles via THIS turn's prompt time (NOM-96)", () => {
    // Field case 01e48c30: prompt written 594 ms before PreInvocation stamped the row; app Stop then
    // flipped the status to IDLE and left last_modified_time = last_user_input_time = the prompt.
    const turn = working({ turnStartedAt: Math.floor((NOW - ANTIGRAVITY_SETTLE_GRACE_MS) / 1000) });
    const input = turn.ts - 594;
    expect(antigravityRunSettled(CONV, turn, NOW, () => ({ readAt: NOW, status: "CASCADE_RUN_STATUS_IDLE", lastModifiedMs: input, lastUserInputMs: input }))).toBe(true);
    // …but the PREVIOUS turn's prompt never does, and RUNNING never does.
    expect(antigravityRunSettled(CONV, turn, NOW, () => ({ readAt: NOW, status: "CASCADE_RUN_STATUS_IDLE", lastModifiedMs: input, lastUserInputMs: input - 60_000 }))).toBe(false);
    expect(antigravityRunSettled(CONV, turn, NOW, () => ({ readAt: NOW, status: "CASCADE_RUN_STATUS_RUNNING", lastModifiedMs: input, lastUserInputMs: input }))).toBe(false);
  });
  test("…but not inside the grace, not RUNNING, not a previous turn's IDLE, not an unparseable time, not another agent", () => {
    expect(antigravityRunSettled(CONV, working({ ts: NOW - 1_000 }), NOW, idleAt(NOW))).toBe(false);
    expect(antigravityRunSettled(CONV, working(), NOW, () => ({ readAt: NOW, status: "CASCADE_RUN_STATUS_RUNNING", lastModifiedMs: NOW }))).toBe(false);
    expect(antigravityRunSettled(CONV, working(), NOW, idleAt(NOW - ANTIGRAVITY_SETTLE_GRACE_MS - 1))).toBe(false);
    expect(antigravityRunSettled(CONV, working(), NOW, () => ({ readAt: NOW, status: "CASCADE_RUN_STATUS_IDLE" }))).toBe(false);
    expect(antigravityRunSettled(CONV, working(), NOW, () => undefined)).toBe(false);
    expect(antigravityRunSettled(CONV, working({ agent: "cursor" }), NOW, idleAt(NOW))).toBe(false);
    expect(antigravityRunSettled(CONV, working({ op: "done", lastEvent: "done" }), NOW, idleAt(NOW))).toBe(false);
  });
  test("the watchdog's reap posts done for it within seconds (the 30-min clock is not needed)", async () => {
    const dir = await tmp();
    const path = join(dir, `${CONV}.json`);
    const r = working();
    await writeFile(path, JSON.stringify(r));
    const posts: object[] = [];
    const out = await correctIdleClaude(CONFIG, path, CONV, r, NOW, {
      post: async (b) => { posts.push(b); return "delivered"; }, antigravityRunStatus: idleAt(NOW - 1_000),
    });
    expect(out).toBe("corrected");
    expect(posts[0]).toMatchObject({ op: "done" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ op: "done", lastEvent: "done" });
    expect(await correctIdleClaude(CONFIG, path, CONV, working(), NOW, {
      post: async () => "delivered", antigravityRunStatus: () => ({ readAt: NOW, status: "CASCADE_RUN_STATUS_RUNNING", lastModifiedMs: NOW }),
    })).toBe("uncorrected");
  });
  test("a dead owner ends the row on the next sweep", () => {
    expect(classifySession(rec({ pid: 4242, ts: NOW }), NOW, () => false)).toBe("end");
    expect(classifySession(rec({ pid: 4242, ts: NOW }), NOW, () => true)).toBe("keep");
  });
  test("antigravityRunStatus parses status + last_modified_time from a real database", async () => {
    const home = await tmp();
    summariesDb(home, "antigravity-cli", [{ id: CONV, title: "", status: "CASCADE_RUN_STATUS_IDLE", mod: "2026-10-27 14:22:27.14367+00:00" }]);
    const run = await withHome(home, () => antigravityRunStatus(CONV));
    expect(run?.status).toBe("CASCADE_RUN_STATUS_IDLE");
    expect(Math.abs(run!.lastModifiedMs! - Date.parse("2026-10-27T14:22:27.143Z"))).toBeLessThan(5); // julianday float rounding
  });
  test("antigravityRunStatus sees a status that lives only in the WAL (desktop app holds the DB open; NOM-96)", async () => {
    // The app's Stop writes IDLE into -wal; the main file still says RUNNING. Without a -shm a read-only
    // open fails, and the old `immutable=1` fallback read the main file only — the row never settled.
    const { Database } = await import("bun:sqlite");
    const src = await tmp();
    const w = new Database(join(src, "s.db"));
    w.exec("pragma journal_mode=wal; pragma wal_autocheckpoint=0;");
    w.exec("create table conversation_summaries (conversation_id text primary key, title text not null default '', status text not null default '', last_modified_time datetime not null)");
    w.exec(`insert into conversation_summaries values ('${CONV}','','CASCADE_RUN_STATUS_RUNNING','2026-10-27 14:22:27+00:00')`);
    w.exec("pragma wal_checkpoint(truncate)");
    w.exec(`update conversation_summaries set status='CASCADE_RUN_STATUS_IDLE' where conversation_id='${CONV}'`);
    const home = await tmp();
    const dir = join(home, ".gemini", "antigravity");
    await mkdir(dir, { recursive: true });
    await cp(join(src, "s.db"), join(dir, "conversation_summaries.db"));
    await cp(join(src, "s.db-wal"), join(dir, "conversation_summaries.db-wal")); // no -shm
    w.close();
    const before = await readFile(join(dir, "conversation_summaries.db-wal"));
    await chmod(dir, 0o555); // the direct read-only open now fails, as it does on the live app's DB
    try {
      expect((await withHome(home, () => antigravityRunStatus(CONV)))?.status).toBe("CASCADE_RUN_STATUS_IDLE");
    } finally {
      await chmod(dir, 0o755);
    }
    expect(await readFile(join(dir, "conversation_summaries.db-wal"))).toEqual(before); // never written
    expect(existsSync(join(dir, "conversation_summaries.db-shm"))).toBe(false);
  });
});

describe("the 10 s settle tick never overrides a newer or real status (NOM-96)", () => {
  const TURN = Math.floor((NOW - 30_000) / 1000);
  const working = (over: Partial<SessionRecord> = {}) => rec({ ts: NOW - 30_000, turnStartedAt: TURN, ...over });
  const idle = (over: object = {}) => () => ({
    readAt: NOW, status: "CASCADE_RUN_STATUS_IDLE", lastModifiedMs: NOW - 30_500, lastUserInputMs: NOW - 30_500, notFullyIdle: false, ...over,
  });
  const quiet = async () => false;
  async function reap(r: SessionRecord, deps: Parameters<typeof correctIdleClaude>[5] = {}) {
    const dir = await tmp();
    const path = join(dir, `${CONV}.json`);
    await writeFile(path, JSON.stringify(r));
    const posts: object[] = [];
    const out = await correctIdleClaude(CONFIG, path, CONV, r, NOW, {
      post: async (b) => { posts.push(b); return "delivered"; }, antigravityRunStatus: idle(), antigravityTurnContinuing: quiet,
      readDecisionHoldFn: async () => null, ...deps,
    });
    return { out, posts, after: JSON.parse(await readFile(path, "utf8")) as SessionRecord };
  }

  test("baseline: a Stop's IDLE settles the row", async () => {
    expect((await reap(working())).out).toBe("corrected");
  });
  test("guard 1 — a new turn that starts mid-tick is never overwritten (re-read before POST/write)", async () => {
    const newer = working({ ts: NOW - 100, turnStartedAt: Math.floor((NOW - 100) / 1000) });
    const r = await reap(working(), { readRecord: async () => newer });
    expect(r.out).toBe("uncorrected");
    expect(r.posts).toEqual([]);
    expect(r.after.lastEvent).toBe("working");
    // …and the DB's prompt must be THIS turn's: the previous turn's IDLE never settles.
    expect(antigravityRunSettled(CONV, working(), NOW, idle({ lastUserInputMs: NOW - 120_000 }))).toBe(false);
  });
  test("guard 2 — a live phone hold (purple hand) is never settled", async () => {
    const r = await reap(working(), {
      readDecisionHoldFn: async () => ({ blob: "card", at: NOW - 5_000, pid: 4242 }), holdPidAliveFn: () => true,
    });
    expect(r.out).toBe("uncorrected");
    expect(r.posts).toEqual([]);
  });
  test("guard 3 — a Stop-continue nudge or a waking resume keeps the row working", async () => {
    const dir = await tmp();
    expect(await antigravityTurnContinuing(CONV, NOW, dir)).toBe(false);
    await markNudged(dir, CONV, NOW - 5_000);
    expect(await antigravityTurnContinuing(CONV, NOW, dir)).toBe(true);
    const dir2 = await tmp();
    await writeReceipt(dir2, CONV, "mid-wake0001", "w");
    expect(await antigravityTurnContinuing(CONV, NOW, dir2)).toBe(true);
    expect((await reap(working(), { antigravityTurnContinuing: async () => true })).out).toBe("uncorrected");
  });
  test("guard 4 — a pending phone Stop flag leaves the settle to the interrupt path", async () => {
    const dir = await tmp();
    await writeInterruptFlagAt(dir, CONV, NOW - 1_000, ANTIGRAVITY_INTERRUPT_SUFFIX);
    expect(await antigravityTurnContinuing(CONV, NOW, dir)).toBe(true);
  });
  test("guard 5 — a DB copy not confirmed after the row's stamp never settles it", () => {
    expect(antigravityRunSettled(CONV, working(), NOW, idle({ readAt: NOW - 30_000 }))).toBe(false);
    expect(antigravityRunSettled(CONV, working(), NOW, idle({ readAt: NOW - 29_999 }))).toBe(true);
  });
  test("guard 6 — Antigravity waiting on its OWN permission prompt (RUNNING + not_fully_idle) is never idle", () => {
    // Real agy 1.4.9, prompt open: CASCADE_RUN_STATUS_RUNNING | not_fully_idle=1.
    expect(antigravityRunSettled(CONV, working(), NOW, idle({ status: "CASCADE_RUN_STATUS_RUNNING", notFullyIdle: true }))).toBe(false);
    expect(antigravityRunSettled(CONV, working(), NOW, idle({ notFullyIdle: true }))).toBe(false);
  });
  test("the tick reaps only working Antigravity rows, and does nothing with none", async () => {
    const dir = await tmp();
    const seen: string[] = [];
    const reapSpy = (async (_c: Config, _p: string, id: string) => { seen.push(id); return "uncorrected"; }) as unknown as typeof correctIdleClaude;
    expect(await antigravitySettleTick(CONFIG, { dir, reap: reapSpy })).toBe(0);
    await writeFile(join(dir, "a.json"), JSON.stringify(working()));
    await writeFile(join(dir, "b.json"), JSON.stringify(working({ op: "done", lastEvent: "done" })));
    await writeFile(join(dir, "c.json"), JSON.stringify(working({ agent: "codex" })));
    expect(await antigravitySettleTick(CONFIG, { dir, reap: reapSpy })).toBe(1);
    expect(seen).toEqual(["a"]);
  });
  test("the run-status read skips the copy while the db and wal are unchanged", async () => {
    const home = await tmp();
    summariesDb(home, "antigravity-cli", [{ id: CONV, title: "", status: "CASCADE_RUN_STATUS_RUNNING", mod: "2026-10-27 14:22:27+00:00" }]);
    const db = join(home, ".gemini", "antigravity-cli", "conversation_summaries.db");
    expect((await withHome(home, () => antigravityRunStatus(CONV, undefined, 1)))?.status).toBe("CASCADE_RUN_STATUS_RUNNING");
    // Unreadable but UNCHANGED: a re-copy would fail, so only the cache can still answer.
    await chmod(db, 0o000);
    try {
      expect(await withHome(home, () => antigravityRunStatus(CONV, undefined, 2))).toMatchObject({ status: "CASCADE_RUN_STATUS_RUNNING", readAt: 2 });
    } finally {
      await chmod(db, 0o644);
    }
    execFileSync("sqlite3", [db, `update conversation_summaries set status='CASCADE_RUN_STATUS_IDLE' where conversation_id='${CONV}'`]);
    expect((await withHome(home, () => antigravityRunStatus(CONV, undefined, 3)))?.status).toBe("CASCADE_RUN_STATUS_IDLE");
  });
});

describe("the Antigravity plugin (plugin/antigravity-plugin)", () => {
  const SRC = join(PLUGIN, "antigravity-plugin");
  test("plugin.json + one SKILL.md per /nomo-* command, frontmatter name = folder, no model auto-run", async () => {
    const manifest = JSON.parse(await readFile(join(SRC, "plugin.json"), "utf8"));
    expect(manifest.name).toBe("nomo");
    expect(manifest.name).toMatch(/^[a-zA-Z0-9-_]+$/);
    expect(manifest.$schema).toBe("https://antigravity.google/schemas/v1/plugin.json");
    const names = (await readdir(join(SRC, "skills"))).sort();
    expect(names).toEqual(["nomo-approvals", "nomo-pair", "nomo-reset", "nomo-status", "nomo-unpair"]);
    for (const name of names) {
      const body = await readFile(join(SRC, "skills", name, "SKILL.md"), "utf8");
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(body)?.[1] ?? "";
      expect(fm).toContain(`name: ${name}\n`);
      expect(fm).toMatch(/\ndescription: .*Run ONLY when the user types \/nomo-/);
      expect(body).toContain("{{nomo-command ");
      expect(body).not.toContain("hook-shim"); // no fallback a reviewer can't see from the template
      expect(body).toContain("please choose Allow");
      // no Claude Code / Codex command names leak into Antigravity's skills
      expect(body).not.toMatch(/nomo-cc:|\$nomo-|codex plugin list/);
    }
  });

  test("agy's own validator accepts the installed plugin with no findings (skipped without agy)", async () => {
    const agy = join(process.env.HOME ?? "", ".local", "bin", "agy");
    if (!existsSync(agy)) return;
    const home = await tmp();
    const dest = join(await tmp(), "nomo");
    await cp(join(SRC), dest, { recursive: true });
    const out = execFileSync(agy, ["plugin", "validate", dest, "--strict", "--json"], { env: isolatedTestEnv(home), encoding: "utf8", timeout: 30_000 });
    const report = JSON.parse(out);
    expect(report.name).toBe("nomo");
    expect(report.components.skills).toBe(5);
    // agy 1.4.9 added an advisory "no logo" NOTE; notes are not findings against the plugin's validity.
    expect(report.findings.filter((f: { severity?: string }) => f.severity !== "note")).toEqual([]);
  }, 40_000);
});

describe("/nomo-status --plain (Antigravity's beginner readout)", () => {
  async function plain(opts: { paired?: boolean; pending?: boolean; installed?: boolean; paused?: boolean; stampAgeMs?: number; machine?: string }) {
    const dir = await tmp();
    const NOW = Date.now();
    const configPath = join(dir, "config.json");
    if (opts.paired) await writeFile(configPath, JSON.stringify({ url: "https://example.invalid", pairingId: "a".repeat(32), pcSecret: "s", e2eKeyB64: Buffer.from(KEY).toString("base64url"), ...(opts.machine ? { machineName: opts.machine } : {}) }));
    if (opts.pending) await writeFile(configPath, JSON.stringify({ url: "https://example.invalid", pairingId: "a".repeat(32), pcSecret: "s", qrSecretB64: Buffer.alloc(16).toString("base64url") }));
    const agHooks = join(dir, "ag-hooks.json");
    if (opts.installed) await writeFile(agHooks, JSON.stringify({ nomo: { Stop: [{ command: "x/antigravity-hook.sh Stop" }] } }));
    if (opts.paused) await writeFile(join(dir, "no-hold"), "");
    if (opts.stampAgeMs !== undefined) await writeFile(join(dir, "lh-ag"), String(NOW - opts.stampAgeMs));
    const lines: string[] = [];
    await statusCmd({
      plain: true, audience: "antigravity", print: (l) => lines.push(l), configPath,
      lastSendPath: join(dir, "last-send"), sessionsDir: join(dir, "sessions"), watchdogPidPath: join(dir, "wd.pid"),
      sessionTracePath: join(dir, "trace.log"), codexConfigPath: join(dir, "c.toml"), codexHooksPath: join(dir, "c.json"),
      codexSessionsDir: join(dir, "cs"), claudeProjectsDir: join(dir, "cp"), lastHookCodexPath: join(dir, "lh1"),
      lastHookClaudePath: join(dir, "lh2"), lastHookOpencodePath: join(dir, "lh3"), opencodeStubPaths: [join(dir, "no.js")],
      cursorHooksPath: join(dir, "cu.json"), cursorProjectsDir: join(dir, "cup"), lastHookCursorPath: join(dir, "lh4"),
      antigravityHooksPath: agHooks, lastHookAntigravityPath: join(dir, "lh-ag"), noHoldPath: join(dir, "no-hold"),
      codexAppServerAvailable: async () => false, isAlive: () => false, now: () => NOW,
    });
    return lines;
  }

  test("every state reads in plain words, one fix per problem, nothing technical", async () => {
    expect(await plain({ installed: true })).toEqual(["❌ This computer isn't connected to your phone yet. Type /nomo-pair to connect it."]);
    expect(await plain({ installed: true, pending: true })).toEqual(["⏳ Pairing was started, but your phone hasn't scanned the code yet. Type /nomo-pair to try again."]);
    expect(await plain({ installed: true, paired: true, machine: "Karrix's MacBook", stampAgeMs: 2 * 60_000 }))
      .toEqual(["✅ Connected to your phone as “Karrix's MacBook” · Phone approvals: on · Last activity: 2 min ago"]);
    expect(await plain({ paired: true, paused: true })).toEqual([
      "✅ Connected to your phone · Phone approvals: paused · Last activity: none yet",
      "⚠️ Antigravity isn't set up to send sessions to Nomo yet. Run the Nomo installer (bunx nomo-ai --antigravity), then restart Antigravity.",
      "⏸️ Phone approvals are paused. Type /nomo-approvals on to turn them back on.",
    ]);
    for (const l of [...await plain({}), ...await plain({ paired: true, paused: true })]) {
      expect(l).not.toMatch(/hook|watchdog|pid|json|config|https?:/i);
    }
  });

  test("plainAge words", () => {
    expect([0, 59_000, 120_000, 3_600_000, 7_200_000, 86_400_000 * 3].map(plainAge))
      .toEqual(["just now", "just now", "2 min ago", "1 hour ago", "2 hours ago", "3 days ago"]);
  });
});

describe("WAL summaries DB with no -shm (the CLI's between sessions)", () => {
  test("status and title are still read (immutable retry), from a path with a space", async () => {
    const home = join(await tmp(), "a home");
    summariesDb(home, "antigravity-cli", [{ id: CONV, title: "Sum the parts", status: "CASCADE_RUN_STATUS_IDLE", mod: "2026-10-27 14:22:27+00:00" }]);
    const db = join(home, ".gemini", "antigravity-cli", "conversation_summaries.db");
    execFileSync("sqlite3", [db, "pragma journal_mode=wal;"]);
    await rm(`${db}-shm`, { force: true });
    await rm(`${db}-wal`, { force: true });
    // the precondition the fix exists for: a plain read-only open fails
    expect(() => execFileSync("/usr/bin/sqlite3", ["-readonly", db, "select 1"], { stdio: "pipe" })).toThrow();
    expect(await withHome(home, () => antigravityRunStatus(CONV))).toMatchObject({ status: "CASCADE_RUN_STATUS_IDLE" });
    expect(await withHome(home, () => antigravityChatTitle(CONV))).toBe("Sum the parts");
  });
});

describe("FIX 2 — the owner is the process that ran the hook", () => {
  test("NOMO_HOOK_PPID: alive pid > 1 only", () => {
    expect(antigravityHookParent({ NOMO_HOOK_PPID: "62636" }, () => true)).toBe(62636);
    expect(antigravityHookParent({ NOMO_HOOK_PPID: "62636" }, () => false)).toBeUndefined();
    for (const v of [undefined, "", "1", "0", "12x", "-5"]) expect(antigravityHookParent({ NOMO_HOOK_PPID: v }, () => true)).toBeUndefined();
  });
  test("the wrapper hands its own parent pid to the bundle, before run.sh adds layers", async () => {
    const root = join(await tmp(), "plugin");
    const seen = join(root, "seen");
    await mkdir(join(root, "scripts"), { recursive: true });
    await cp(join(PLUGIN, "scripts", "antigravity-hook.sh"), join(root, "scripts", "antigravity-hook.sh"));
    await writeFile(join(root, "scripts", "run.sh"), `#!/bin/sh\nprintf '%s' "$NOMO_HOOK_PPID" > '${seen}'\n`, { mode: 0o755 });
    const proc = spawnTestProcess({ cmd: [join(root, "scripts", "antigravity-hook.sh"), "Stop"], env: isolatedTestEnv(await tmp()), stdin: new Blob(["{}"]), stdout: "pipe" });
    expect(await new Response(proc.stdout).text()).toBe("{}\n");
    await proc.exited;
    for (let i = 0; i < 40 && !(await readFile(seen, "utf8").catch(() => "")); i++) await Bun.sleep(50); // detached
    expect(Number(await readFile(seen, "utf8"))).toBe(process.pid); // this test process spawned the wrapper
  });
  test("the hook records that parent as the row's pid", async () => {
    const dir = await tmp();
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await runAntigravityHook(JSON.stringify({ conversationId: CONV }), "PreInvocation", {
      config: CONFIG, sessionsDir, stampPath: join(dir, "s"), now: () => NOW, ownerPid: () => process.pid,
      chatTitle: () => undefined, firstPrompt: async () => undefined, ensureWatchdog: () => {}, trace: () => {}, post: async () => true,
    });
    expect((await readRecord(CONV, sessionsDir))?.pid).toBe(process.pid);
  });
});

describe("FIX 3 — CLI rows use the CLI's own data dir", () => {
  test("data dir from transcriptPath, only for the two known dirs", async () => {
    await withHome("/h", () => {
      expect(antigravityDataDirFor(`/h/.gemini/antigravity-cli/brain/${CONV}/.system_generated/logs/transcript_full.jsonl`)).toBe("/h/.gemini/antigravity-cli");
      expect(antigravityDataDirFor(`/h/.gemini/antigravity/brain/${CONV}/x.jsonl`)).toBe("/h/.gemini/antigravity");
      expect(antigravityDataDirFor("/tmp/evil/brain/x")).toBeUndefined();
      expect(antigravityDataDirFor(undefined)).toBeUndefined();
      // `..` traversal out of a known dir, and relative paths, are rejected
      expect(antigravityDataDirFor("/h/.gemini/antigravity-cli/brain/../../../etc/passwd")).toBeUndefined();
      expect(antigravityDataDirFor("/tmp/evil/../../h/.gemini/antigravity/brain/x")).toBe("/h/.gemini/antigravity");
      expect(antigravityDataDirFor("/h/.gemini/antigravity-cli/../antigravity-x/brain/x")).toBeUndefined();
      expect(antigravityDataDirFor(".gemini/antigravity/brain/x")).toBeUndefined();
    });
  });
  test("title from the CLI database via the transcript, or by trying both", async () => {
    const home = await tmp();
    summariesDb(home, "antigravity", [{ id: "d-1", title: "Create Hello.txt File", status: "CASCADE_RUN_STATUS_IDLE", mod: "2026-10-27 14:16:20+00:00" }]);
    summariesDb(home, "antigravity-cli", [{ id: CONV, title: "Fix the CLI", status: "CASCADE_RUN_STATUS_IDLE", mod: "2026-10-27 14:16:20+00:00" }]);
    await withHome(home, () => {
      const cliTranscript = join(home, ".gemini", "antigravity-cli", "brain", CONV, "t.jsonl");
      expect(antigravityChatTitle(CONV, cliTranscript)).toBe("Fix the CLI");
      expect(antigravityChatTitle(CONV)).toBe("Fix the CLI");
      expect(antigravityChatTitle("d-1")).toBe("Create Hello.txt File");
      // The transcript pins ONE database: the desktop id is not in the CLI's.
      expect(antigravityChatTitle("d-1", cliTranscript)).toBeUndefined();
    });
  });
  test("ids that are not UUID-shaped never reach the SQL", async () => {
    const home = await tmp();
    summariesDb(home, "antigravity", [{ id: "a", title: "T", status: "CASCADE_RUN_STATUS_IDLE", mod: "2026-10-27 14:16:20+00:00" }]);
    await withHome(home, () => {
      for (const id of ["a' or '1'='1", "a;drop", "a.b", "a_b", ""]) {
        expect(antigravityChatTitle(id)).toBeUndefined();
        expect(antigravityRunStatus(id)).toBeUndefined();
      }
    });
  });
  test("first-prompt fallback from transcript_full.jsonl's USER_INPUT line", async () => {
    const home = await tmp();
    const dir = join(home, ".gemini", "antigravity-cli", "brain", CONV, ".system_generated", "logs");
    await mkdir(dir, { recursive: true });
    const t = join(dir, "transcript_full.jsonl");
    await writeFile(t, `${JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST>\nRename the parser module\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>" })}\n{"type":"PLANNER_RESPONSE"}\n`);
    await withHome(home, async () => {
      expect(await antigravityFirstPrompt(t)).toBe("Rename the parser module");
      expect(await antigravityFirstPrompt("/tmp/elsewhere/brain/x.jsonl")).toBeUndefined();
      // The adapter's title seam: no database title yet → the first prompt.
      expect(await antigravityAdapter.title({ sessionId: CONV, prefix: "", input: {}, transcriptPath: t })).toBe("Rename the parser module");
    });
  });
});
