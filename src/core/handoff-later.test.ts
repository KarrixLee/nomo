import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { trackedSecretFiles } from "./readiness";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelPending, claimPending, contextTokens, contextTokensOf, DEFAULT_THEN, GONE_MSG, parseLaterArg, sizeWarning, handoffArgv, handoffLanded, laterStatus, NOTHING_RAN_MSG, needsPairing, type Pending, readPending, resolveSession, waitThenHandoff, type WaitDeps,
  BOX_MAX_SESSIONS, boxPaired, phoneMoveCheck, type PhoneMoveFacts, settleThenStamp,
} from "./handoff-later";
import { parkHook, readPark, writePark } from "./park";

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

test("boxPaired (NOM-95): cloud.json paired to the worker; missing or other worker fails closed", () => {
  const f = join(tmp(), "cloud.json");
  expect(boxPaired(f, "https://w")).toBe(false);
  writeFileSync(f, JSON.stringify({ sandboxId: "sb", pairedTo: "sb https://w" }));
  expect(boxPaired(f, "https://w")).toBe(true);
  expect(boxPaired(f, "https://other")).toBe(false);
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

  test("clearing a dead helper's file never removes a claim that replaced it meanwhile", () => {
    const path = join(tmp(), "p.json");
    writeFileSync(path, JSON.stringify(pending({ helperPid: 1 })));
    // A concurrent claim lands between our read of the dead file and the unlink.
    const d = { path, isHelper: (pid: number) => { if (pid === 1) writeFileSync(path, JSON.stringify(pending({ helperPid: 2 }))); return pid === 2; } };
    expect(claimPending(d, pending({ helperPid: 3, session: B }))).toBe(false);
    expect(readPending(path)?.helperPid).toBe(2);
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
  function deps(path: string, aliveFor: number, code = 0): WaitDeps & { lines: string[]; notes: string[]; runs: number; t: number; cloud: { current?: string; sessions?: Record<string, unknown> } } {
    const d = {
      lines: [] as string[], notes: [] as string[], runs: 0, t: 0,
      cloud: {} as { current?: string; sessions?: Record<string, unknown> },
      pending: path, selfPid: 500, capMs: 60_000,
      readCloud: () => d.cloud,
      alive: () => d.t < aliveFor,
      now: () => d.t,
      sleep: async (ms: number) => { d.t += ms; },
      runHandoff: async () => {
        d.runs++;
        expect(readPending(path)?.state).toBe("handing-off");
        if (code === 0) d.cloud = { current: A, sessions: { [A]: { sha: `run${d.runs}` } } }; // what a real handoff saves
        return code;
      },
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
    expect(d.notes[0]).toContain("Mac copy is untouched");
  });

  test("exit 0 with nothing done (shim/run.sh found no plugin or runtime) is FAILED, not DONE", async () => {
    const path = join(tmp(), "p.json");
    const d = deps(path, 0);
    d.cloud = { current: A, sessions: { [A]: { sha: "old" } } }; // an earlier handoff of this same session
    d.runHandoff = async () => 0;
    expect(await waitThenHandoff(pending(), d)).toBe(1);
    expect(d.lines.at(-1)).toBe(`FAILED: ${NOTHING_RAN_MSG}. Your Mac copy is untouched.`);
  });

  test("handoffLanded: current is this session and its snapshot changed", () => {
    expect(handoffLanded({}, { current: A, sessions: { [A]: 1 } }, A)).toBe(true);
    expect(handoffLanded({ sessions: { [A]: 1 } }, { current: A, sessions: { [A]: 2 } }, A)).toBe(true);
    expect(handoffLanded({ sessions: { [A]: 1 } }, { current: A, sessions: { [A]: 1 } }, A)).toBe(false);
    expect(handoffLanded({}, { current: B, sessions: { [A]: 1 } }, A)).toBe(false);
    // 2.3.29: several sessions in `active`, A among them
    expect(handoffLanded({ sessions: { [A]: 1 } }, { active: [B, A], sessions: { [A]: 2 } }, A)).toBe(true);
    expect(handoffLanded({}, { active: [B], sessions: { [A]: 1 } }, A)).toBe(false);
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
    expect(d.lines.at(-1)).toBe(`FAILED: ${GONE_MSG}. Your Mac copy is untouched.`);
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
    expect(laterStatus({ path, isHelper: () => true, log })).toContain(`Waiting for this turn to end, then moving session ${A}`);
    writeFileSync(log, "x\n[t] DONE: session moved\n");
    expect(laterStatus({ path, isHelper: () => false, log })).toContain("Last: [t] DONE: session moved");
  });
});

describe("context size", () => {
  const asst = (u: object, extra: object = {}) => JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", usage: u }, ...extra });
  const user = JSON.stringify({ type: "user", message: { content: "hi" } });

  test("the last real assistant turn's input + cache read + cache creation", () => {
    const jsonl = [
      asst({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 50 }),
      user,
      asst({ input_tokens: 3, cache_read_input_tokens: 800_000, cache_creation_input_tokens: 20_000, output_tokens: 900 }),
      asst({ input_tokens: 0, output_tokens: 0 }, { message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } }),
      asst({ input_tokens: 999_999 }, { isSidechain: true }),
      user,
      '{"type":"assistant","message":{"usage":{"input_tok', // torn last line
    ].join("\n");
    expect(contextTokens(jsonl, 1e9)).toBe(820_003);
  });

  test("a /compact after the last turn: its postTokens, else the bytes after it / 4", () => {
    const big = asst({ input_tokens: 2, cache_read_input_tokens: 900_000 });
    const boundary = (meta: object) => JSON.stringify({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: meta });
    const summary = JSON.stringify({ type: "user", isCompactSummary: true, message: { content: "s".repeat(4000) } });
    expect(contextTokens([big, boundary({ trigger: "manual", preTokens: 900_002, postTokens: 31_000 }), summary].join("\n"), 1e9)).toBe(31_000);
    expect(contextTokens([big, boundary({ trigger: "manual" }), summary].join("\n"), 1e9)).toBeGreaterThan(1000);
    expect(contextTokens([big, boundary({ trigger: "manual" }), summary].join("\n"), 1e9)).toBeLessThan(2000);
    // A turn after the compact is the live size again.
    expect(contextTokens([big, boundary({ postTokens: 31_000 }), summary, asst({ input_tokens: 5, cache_read_input_tokens: 40_000 })].join("\n"), 1e9)).toBe(40_005);
  });

  test("no usage at all: file bytes / 4", () => {
    expect(contextTokens([user, user].join("\n"), 4_000_000)).toBe(1_000_000);
  });

  test("reads only the file's tail", () => {
    const path = join(tmp(), "t.jsonl");
    writeFileSync(path, "x".repeat(5 * 1024 * 1024) + "\n" + asst({ input_tokens: 1, cache_read_input_tokens: 250_000 }) + "\n");
    expect(contextTokensOf(path)).toBe(250_001);
  });

  test("heads-up: none small, cost over 200k, context window over 900k; never a price", () => {
    expect(sizeWarning(150_000)).toBeUndefined();
    expect(sizeWarning(820_003)).toBe("Heads-up: this session is large (~820k tokens). The first cloud turn resends all of it at API price (no cache on the box yet). Run /compact first to make it cheaper.");
    expect(sizeWarning(950_000)).toContain("context window");
    expect(sizeWarning(950_000)).toContain("/compact");
    expect(sizeWarning(950_000)).not.toMatch(/\$/);
  });
});

describe("/nomo-cc:handoff grammar", () => {
  test("empty → default message; then <text> → text; quiet → none; anything else → usage", () => {
    expect(parseLaterArg("")).toEqual({ message: DEFAULT_THEN });
    expect(parseLaterArg("  \n")).toEqual({ message: DEFAULT_THEN });
    expect(parseLaterArg("then run the tests")).toEqual({ message: "run the tests" });
    expect(parseLaterArg("Then  it's \"$HOME\" `id`\r\nline 2\n")).toEqual({ message: "it's \"$HOME\" `id`\nline 2" });
    expect(parseLaterArg("quiet")).toEqual({});
    expect(parseLaterArg("QUIET\n")).toEqual({});
    for (const bad of ["then", "then   ", "thenx", "quiet please", "cancle", "status", "cancel", "go"]) expect(parseLaterArg(bad)).toBeUndefined();
  });

  test("the message lives in the 0600 pending record", () => {
    const f = join(tmp(), "p.json");
    expect(claimPending({ path: f, isHelper: () => false }, pending({ message: "go on" }))).toBe(true);
    expect(readPending(f)?.message).toBe("go on");
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe("park marker lifecycle (NOM-90)", () => {
  function deps(path: string, parkDir: string, code = 0) {
    const d = {
      runs: 0, t: 0, lines: [] as string[],
      cloud: {} as { current?: string; sessions?: Record<string, unknown> },
      pending: path, selfPid: 500, capMs: 60_000, parkDir,
      readCloud: () => d.cloud,
      alive: () => true, // the window stays open: only the turn end can trigger
      now: () => d.t,
      sleep: async (ms: number) => {
        d.t += ms;
        if (d.t === 6000) parkHook({ session_id: A, hook_event_name: "Stop" }, parkDir); // the turn ends
      },
      runHandoff: async () => {
        d.runs++;
        expect(readPark(A, parkDir)?.state).toBe("moving");
        if (code === 0) d.cloud = { current: A, sessions: { [A]: { sha: "x" } } };
        return code;
      },
      log: (l: string) => d.lines.push(l),
      notify: () => {},
    };
    return d;
  }

  test("armed (moving) → the turn ends → handed off → cloud", async () => {
    const dir = tmp(), path = join(dir, "p.json"), parkDir = join(dir, "parked");
    writePark(A, { state: "moving" }, parkDir);
    const d = deps(path, parkDir);
    expect(await waitThenHandoff(pending(), d)).toBe(0);
    expect(d.runs).toBe(1);
    expect(d.t).toBeLessThan(60_000);
    expect(d.lines).toContain(`The turn ended. Handing off session ${A}…`);
    expect(readPark(A, parkDir)).toMatchObject({ state: "cloud", pid: 400 });
  });

  test("a failed move removes the marker", async () => {
    const dir = tmp(), parkDir = join(dir, "parked");
    writePark(A, { state: "moving" }, parkDir);
    expect(await waitThenHandoff(pending(), deps(join(dir, "p.json"), parkDir, 1))).toBe(1);
    expect(readPark(A, parkDir)).toBeUndefined();
  });

  test("giving up at the cap removes the marker", async () => {
    const dir = tmp(), parkDir = join(dir, "parked");
    writePark(A, { state: "moving" }, parkDir);
    const d = deps(join(dir, "p.json"), parkDir);
    d.sleep = async (ms: number) => { d.t += ms; }; // the turn never ends
    expect(await waitThenHandoff(pending(), d)).toBe(1);
    expect(d.runs).toBe(0);
    expect(readPark(A, parkDir)).toBeUndefined();
  });

  test("cancel with nothing waiting unparks this window (box gone, back failing)", () => {
    const dir = tmp(), path = join(dir, "p.json"), parkDir = join(dir, "parked");
    writePark(A, { state: "cloud" }, parkDir);
    expect(cancelPending({ path, isHelper: () => false, kill: () => {}, parkDir, session: A })).toBe("Unparked; the box copy is untouched. This window is yours again (a later /nomo-cc:back keeps both copies).");
    expect(readPark(A, parkDir)).toBeUndefined();
    expect(cancelPending({ path, isHelper: () => false, kill: () => {}, parkDir, session: A })).toContain("Nothing to cancel");
  });

  test("cancel removes the marker", () => {
    const dir = tmp(), path = join(dir, "p.json"), parkDir = join(dir, "parked");
    writeFileSync(path, JSON.stringify(pending()));
    writePark(A, { state: "moving" }, parkDir);
    expect(cancelPending({ path, isHelper: () => true, kill: () => {}, parkDir })).toContain("Cancelled");
    expect(readPark(A, parkDir)).toBeUndefined();
  });
});

describe("phone move-to-cloud (NOM-94)", () => {
  const CLAUDE = "/usr/local/bin/claude --resume x";
  const facts = (o: Partial<PhoneMoveFacts> = {}): PhoneMoveFacts => ({
    record: { pid: 400, cwd: "/p/app" },
    command: (pid) => (pid === 400 ? CLAUDE : pid === 300 ? "-zsh" : undefined),
    ancestorsOf: () => [300],
    parked: false, active: false, needsPairing: false, cloudCount: 0,
    transcriptExists: () => true,
    trackedSecrets: () => [],
    ...o,
  });
  const refuse = (o: Partial<PhoneMoveFacts>): string => {
    const r = phoneMoveCheck(facts(o));
    expect("refuse" in r).toBe(true);
    return (r as { refuse: string }).refuse;
  };

  test("a live, idle-or-busy Claude Code session passes with the record's pid and cwd", () => {
    expect(phoneMoveCheck(facts())).toEqual({ claudePid: 400, cwd: "/p/app" });
  });

  test("every gate refuses", () => {
    expect(refuse({ record: null })).toMatch(/no Nomo record/);
    expect(refuse({ record: { pid: 400, cwd: "/p", agent: "codex" } })).toMatch(/only a Claude Code/);
    expect(refuse({ record: { pid: 400, cwd: "/p", agent: "opencode" } })).toMatch(/only a Claude Code/);
    expect(refuse({ record: { pid: 400, cwd: "/p", provisional: true } })).toMatch(/only a Claude Code/);
    expect(refuse({ command: () => undefined })).toMatch(/not running/);                // dead pid
    expect(refuse({ command: () => "/bin/zsh -l" })).toMatch(/not running/);            // a reused pid
    expect(refuse({ record: { cwd: "/p" } })).toMatch(/not running/);
    expect(refuse({ command: (p) => (p === 400 ? "claude -p hi --output-format stream-json" : undefined) })).toMatch(/headless or desktop/);
    expect(refuse({
      command: (p) => (p === 400 ? "/Users/u/Library/Application Support/Claude/claude-code/2.1.0/claude.app/Contents/MacOS/claude --resume x" : "/Applications/Claude.app/Contents/Helpers/disclaimer"),
    })).toMatch(/headless or desktop/);
    expect(refuse({ parked: true })).toMatch(/already moving/);
    expect(refuse({ active: true })).toMatch(/already running in the cloud/);
    expect(refuse({ needsPairing: true })).toMatch(/pairing/);
    expect(refuse({ cloudCount: BOX_MAX_SESSIONS })).toMatch(/cap is 4/);
    const why = (o: Partial<PhoneMoveFacts>) => (phoneMoveCheck(facts(o)) as { why: string }).why;
    expect(why({ cloudCount: BOX_MAX_SESSIONS })).toBe("cap");
    expect(why({ needsPairing: true })).toBe("notPaired");
    expect(why({ trackedSecrets: () => [".env"] })).toBe("secret");
    expect(why({ parked: true })).toBe("other");
    expect(phoneMoveCheck(facts({ cloudCount: BOX_MAX_SESSIONS - 1 }))).toEqual({ claudePid: 400, cwd: "/p/app" });
    expect(refuse({ transcriptExists: () => false })).toMatch(/transcript/);
    expect(refuse({ record: { pid: 400 } })).toMatch(/transcript/);
  });

  test("a git-tracked secret refuses; a git error refuses; none (or no git) passes", () => {
    expect(refuse({ trackedSecrets: () => [".vscode/.env"] })).toMatch(/\.vscode\/\.env looks like a secret/);
    expect(refuse({ trackedSecrets: () => undefined })).toMatch(/git could not list/);
    expect(phoneMoveCheck(facts({ trackedSecrets: () => [] }))).toEqual({ claudePid: 400, cwd: "/p/app" });
  });

  test("trackedSecretFiles: real git, dot-dirs included; non-git = none; a git error = undefined", () => {
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: "ignore" });
    const repo = tmp();
    git(repo, "init", "-q");
    for (const [f, body] of [[".secrets/credentials.json", "{}"], [".vscode/.env", "K=1"], ["src/a.ts", ""], [".env.example", ""], ["untracked/.env", "K=2"]]) {
      mkdirSync(join(repo, f, ".."), { recursive: true });
      writeFileSync(join(repo, f), body);
    }
    git(repo, "add", ".secrets/credentials.json", ".vscode/.env", "src/a.ts", ".env.example");
    expect(trackedSecretFiles(join(repo, "src"))?.sort()).toEqual([".secrets/credentials.json", ".vscode/.env"]);
    expect(trackedSecretFiles(tmp())).toEqual([]); // no repo: nothing is tracked
    writeFileSync(join(repo, ".git", "index"), "garbage"); // a corrupt index: ls-files fails
    expect(trackedSecretFiles(repo)).toBeUndefined();
  });

  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };

  test("idle at both settle reads → turnEndedAt is stamped (the helper moves now)", async () => {
    for (const rec of [{ op: "done" }, { lastEvent: "done" }, { lastEvent: "sessionStart", awaitingPrompt: true }]) {
      const dir = tmp();
      writePark(A, { state: "moving", pid: 400 }, dir);
      sleeps.length = 0;
      expect(await settleThenStamp(A, { readRecord: async () => rec, sleep, parkDir: dir })).toBe(true);
      expect(sleeps).toEqual([2000, 2000]);
      expect(readPark(A, dir)?.turnEndedAt).toBeGreaterThan(0);
      expect(readPark(A, dir)?.state).toBe("moving");
    }
  });

  test("working or needs-attention → not stamped (that turn's Stop does it)", async () => {
    for (const rec of [{ op: "update", lastEvent: "working" }, { op: "update", lastEvent: "needsAttention" }, null]) {
      const dir = tmp();
      writePark(A, { state: "moving", pid: 400 }, dir);
      expect(await settleThenStamp(A, { readRecord: async () => rec, sleep, parkDir: dir, settleMs: 0 })).toBe(false);
      expect(readPark(A, dir)?.turnEndedAt).toBeUndefined();
    }
  });

  test("idle at 2 s but working at 4 s → not stamped", async () => {
    const dir = tmp();
    writePark(A, { state: "moving", pid: 400 }, dir);
    const reads = [{ op: "done" }, { op: "update", lastEvent: "working" }];
    expect(await settleThenStamp(A, { readRecord: async () => reads.shift()!, sleep, parkDir: dir, settleMs: 0 })).toBe(false);
    expect(readPark(A, dir)?.turnEndedAt).toBeUndefined();
  });

  test("a Stop that already stamped is kept; a marker gone meanwhile is not recreated", async () => {
    const dir = tmp();
    writePark(A, { state: "moving", pid: 400, turnEndedAt: 7 }, dir);
    await settleThenStamp(A, { readRecord: async () => ({ op: "done" }), sleep, parkDir: dir });
    expect(readPark(A, dir)?.turnEndedAt).toBe(7);
    const gone = tmp();
    expect(await settleThenStamp(A, { readRecord: async () => ({ op: "done" }), sleep, parkDir: gone })).toBe(false);
    expect(readPark(A, gone)).toBeUndefined();
  });
});

test("the helper reports this session's outcome: moved or failed", async () => {
  const run = async (o: { code: number }) => {
    const out: boolean[] = [];
    const dir = tmp();
    writePark(A, { state: "moving", pid: 400, turnEndedAt: 1 }, dir);
    let t = 0, reads = 0;
    await waitThenHandoff(pending(), {
      pending: join(dir, "p.json"), parkDir: dir, alive: () => true, now: () => (t += 1000), sleep: async () => {},
      runHandoff: async () => o.code, readCloud: () => ({ active: [A], sessions: { [A]: { n: ++reads } } }), log: () => {}, notify: () => {},
      result: (ok) => out.push(ok),
    });
    return out;
  };
  expect(await run({ code: 0 })).toEqual([true]);
  expect(await run({ code: 1 })).toEqual([false]);
});
