// Tests for the Devin approval hold (core/devin-approval.ts): the stdin it builds, the decision
// translation, and runs through the REAL shared relay (runPermissionHook) with a scripted worker.
// Nothing here touches the network or the real Nomo state dir.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { decryptBlob, encryptBlob } from "./crypto";
import {
  DEVIN_ANSWER_REASON_MAX, DEVIN_APPROVAL_TIMEOUT_S, DEVIN_ENTRY_CAP_MS, DEVIN_HOLD_DEADLINE_MS, devinDecision, devinGrantFor, devinGrantText,
  devinGrantMatches, devinPermissionStdin, isDevinSkillCommand, isNomoLifecycleCommand, runDevinApproval,
} from "./devin-approval";
import { runDevinHook } from "./devin";
import { devinGrantsPath, forgetDevinGrants, type Config } from "./shared";

const KEY = new Uint8Array(32).fill(7);
const CONFIG: Config = { url: "https://relay.invalid", pairingId: "pairing-1", pcSecret: "secret", e2eKey: KEY };
const ENV = { DEVIN_PROJECT_DIR: "/w/api" };
/** Every run gets a private sessions dir: grants must never touch the real Nomo state dir. */
const TMP = mkdtempSync(join(tmpdir(), "nomo-devin-approval-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let dirN = 0;
const freshDir = () => join(TMP, `s${dirN++}`);
const payload = (tool_name: string, tool_input: Record<string, unknown>) =>
  ({ hook_event_name: "PermissionRequest", session_id: "brawny-shirt", prompt_id: "p1", tool_use_id: "t1", tool_name, tool_input });
const EXEC = payload("exec", { command: "rm -rf build" });

describe("devinDecision", () => {
  const hso = (decision: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  test("phone allow (any variant) → approve; deny → block with the note or the default", () => {
    expect(devinDecision(hso({ behavior: "allow" }))).toBe('{"decision":"approve"}');
    expect(devinDecision(hso({ behavior: "allow", updatedPermissions: [{ type: "addRules" }] }))).toBe('{"decision":"approve"}'); // allow_always on an old phone
    expect(devinDecision(hso({ behavior: "deny", message: "use bun" }))).toBe('{"decision":"block","reason":"use bun"}');
    expect(devinDecision(hso({ behavior: "deny" }))).toBe('{"decision":"block","reason":"Denied from phone"}');
    expect(devinDecision(undefined)).toBe("");
    expect(devinDecision("garbage")).toBe("");
    expect(devinDecision(hso({ behavior: "ask" }))).toBe("");
  });
});

describe("devinPermissionStdin", () => {
  test("Claude-shaped, with mapped tool names and Devin's tool_input passed through", () => {
    const s = JSON.parse(devinPermissionStdin(EXEC, "/w/api")!);
    expect(s).toEqual({ session_id: "brawny-shirt", cwd: "/w/api", hook_event_name: "PermissionRequest", tool_name: "shell", tool_input: { command: "rm -rf build" } });
    expect(s.permission_mode).toBeUndefined();
    expect(s.agent_id).toBeUndefined();
    const name = (tool: string, input: Record<string, unknown> = { file_path: "/w/a.ts" }) => JSON.parse(devinPermissionStdin(payload(tool, input))!).tool_name;
    expect(name("write")).toBe("Write");
    expect(name("edit")).toBe("Edit");
    expect(name("read")).toBe("Read");
    expect(name("webfetch", { url: "https://x" })).toBe("WebFetch");
    expect(name("mcp__github__create_issue", {})).toBe("mcp__github__create_issue");
    expect(JSON.parse(devinPermissionStdin(payload("write", { file_path: "/w/a.ts", content: "hi" }))!).tool_input.file_path).toBe("/w/a.ts");
  });
  test("ask_user_question holds only from PreToolUse; no other PreToolUse holds; unsafe ids never hold", () => {
    expect(devinPermissionStdin({ session_id: "s", hook_event_name: "PermissionRequest", tool_name: "ask_user_question", tool_input: {} })).toBeUndefined();
    expect(devinPermissionStdin({ session_id: "s", hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { command: "ls" } })).toBeUndefined();
    expect(devinPermissionStdin({ session_id: "../x", tool_name: "exec", tool_input: {} })).toBeUndefined();
    expect(devinPermissionStdin({ tool_name: "exec", tool_input: {} })).toBeUndefined();
    expect(devinPermissionStdin({ session_id: "s", tool_input: {} })).toBeUndefined();
  });
});

describe("runDevinApproval — seams", () => {
  test("passes agent 'devin', a deadline, and returns the translated line", async () => {
    let seen: { agent?: string; deadlineAt?: number; stdin?: string } = {};
    const out = await runDevinApproval(JSON.stringify(EXEC), {
      env: ENV, sessionsDir: freshDir(), hold: { now: () => 5_000 },
      run: (async (deps: { deadlineAt?: number; readInput?: () => Promise<string>; emit?: (l: string) => void }, agent: string) => {
        seen = { agent, deadlineAt: deps.deadlineAt, stdin: await deps.readInput!() };
        deps.emit!(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }));
      }) as never,
    });
    expect(out).toBe('{"decision":"approve"}');
    expect(seen.agent).toBe("devin");
    expect(seen.deadlineAt).toBe(5_000 + DEVIN_HOLD_DEADLINE_MS);
    expect(JSON.parse(seen.stdin!)).toMatchObject({ tool_name: "shell", cwd: "/w/api" });
  });

  test("paused approvals delegate to the producer and print nothing", async () => {
    let delegated = 0;
    const out = await runDevinApproval(JSON.stringify(EXEC), {
      env: ENV, sessionsDir: freshDir(), delegate: async () => { delegated++; },
      run: (async (deps: { delegate?: () => Promise<void> }) => { await deps.delegate!(); }) as never,
    });
    expect(delegated).toBe(1);
    expect(out).toBe("");
  });

  test("abandoned hold prints nothing", async () => {
    const out = await runDevinApproval(JSON.stringify(EXEC), {
      env: ENV, sessionsDir: freshDir(), abandoned: () => true,
      run: (async (deps: { abandoned?: () => boolean; emit?: (l: string) => void }) => {
        if (!deps.abandoned!()) deps.emit!("{}");
      }) as never,
    });
    expect(out).toBe("");
  });

  test("outside Devin (no DEVIN_PROJECT_DIR) → no hold at all; junk / a throwing relay → no opinion", async () => {
    let started = false;
    const run = (async () => { started = true; }) as never;
    expect(await runDevinApproval(JSON.stringify(EXEC), { env: {}, run, sessionsDir: TMP })).toBe("");
    expect(started).toBe(false);
    for (const raw of ["", "garbage", "[]", "null"]) expect(await runDevinApproval(raw, { env: ENV, run, sessionsDir: TMP })).toBe("");
    expect(started).toBe(false);
    expect(await runDevinApproval(JSON.stringify(EXEC), { env: ENV, sessionsDir: TMP, run: (async () => { throw new Error("boom"); }) as never })).toBe("");
  });

  test("timeouts nest strictly inside the hook timeout", () => {
    expect(DEVIN_HOLD_DEADLINE_MS).toBeLessThan(DEVIN_ENTRY_CAP_MS);
    expect(DEVIN_ENTRY_CAP_MS).toBeLessThan(DEVIN_APPROVAL_TIMEOUT_S * 1000);
  });
});

/** A scripted worker: the decision POST grants `hold` (and its sealed card is kept), each GET returns
 *  the next scripted body. */
function worker(hold: boolean, gets: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  const cards: string[] = [];
  let g = 0;
  const fn = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url.replace(CONFIG.url, "")}`);
    if (url.endsWith("/v1/cc/full")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.endsWith("/v1/cc/decision")) {
      cards.push((JSON.parse(init?.body ?? "{}") as { blob?: string }).blob ?? "");
      return new Response(JSON.stringify({ hold }), { status: 200 });
    }
    return new Response(JSON.stringify(gets[Math.min(g++, gets.length - 1)] ?? {}), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls, cards };
}

describe("runDevinApproval — through the shared relay", () => {
  let clock = 1_000;
  const hold = (over: Record<string, unknown>) => ({
    loadConfigFn: async () => CONFIG, readRecordFn: async () => null, sleep: async () => { clock += 3_000; },
    now: () => clock, randomUUID: () => "req-devin", jitter: () => 0, noHoldPath: "/does/not/exist/no-hold",
    trace: () => {}, ...over,
  });
  const answered = async (answer: object) => ({ status: "answered", answerBlob: await encryptBlob(KEY, { requestId: "req-devin", ...answer }) });
  const run = (deps: Record<string, unknown>, input: object = EXEC, extra: Record<string, unknown> = {}) =>
    runDevinApproval(JSON.stringify(input), { env: ENV, abandoned: () => false, hold: hold(deps) as never, sessionsDir: freshDir(), ...extra });

  test("phone Allow → approve; the card is a sealed agent:devin decisionPending shell card", async () => {
    const w = worker(true, [{ status: "pending" }, await answered({ decision: "allow" })]);
    expect(await run({ fetchFn: w.fn })).toBe('{"decision":"approve"}');
    expect(w.calls).toContain("POST /v1/cc/decision");
    const card = await decryptBlob(KEY, w.cards[0]!) as Record<string, unknown>;
    expect(card).toMatchObject({ agent: "devin", status: "decisionPending", permissionToolName: "shell", permissionDetail: "rm -rf build", permissionRequestId: "req-devin" });
  });

  test("phone Deny with a note → block + the note; bare Deny → the default reason", async () => {
    expect(await run({ fetchFn: worker(true, [await answered({ decision: "deny", message: "use bun" })]).fn }))
      .toBe('{"decision":"block","reason":"use bun"}');
    expect(await run({ fetchFn: worker(true, [await answered({ decision: "deny" })]).fn }))
      .toBe('{"decision":"block","reason":"Denied from phone"}');
  });

  test("allow_always and allow_mode lines translate to approve (old phone, new plugin)", async () => {
    expect(await run({ fetchFn: worker(true, [await answered({ decision: "allow_always" })]).fn })).toBe('{"decision":"approve"}');
    expect(await run({ fetchFn: worker(true, [await answered({ decision: "allow_mode", mode: "acceptEdits" })]).fn })).toBe('{"decision":"approve"}');
  });

  test("unpaired → nothing, zero network; not on the phone / expired / network down → nothing", async () => {
    const w = worker(true, []);
    expect(await run({ loadConfigFn: async () => null, fetchFn: w.fn })).toBe("");
    expect(w.calls).toEqual([]);
    expect(await run({ fetchFn: worker(false, []).fn, readRecordFn: async () => ({ ts: -10_000_000 }) })).toBe("");
    expect(await run({ fetchFn: worker(true, [{ status: "expired" }]).fn })).toBe("");
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await run({ fetchFn: down })).toBe("");
  });

  test("a hold the phone never answers ends at the deadline → nothing", async () => {
    expect(await run({ fetchFn: worker(true, [{ status: "pending" }]).fn, deadlineAt: clock + 10_000 })).toBe("");
  });

  test("abandoned mid-hold (Devin killed our parent shell) → nothing, card withdrawn, row settled WORKING", async () => {
    const w = worker(true, [{ status: "pending" }]);
    let checks = 0;
    const patches: Record<string, unknown>[] = [];
    const out = await run({
      fetchFn: w.fn, writeHoldFn: async () => {},
      clearHoldFn: async (_id: string, _pid: number, settle?: () => Promise<void>) => { await settle?.(); return true; },
      settleHoldRecordFn: async (_id: string, patch: Record<string, unknown>) => { patches.push(patch); },
    }, EXEC, { abandoned: () => ++checks >= 2 });
    expect(out).toBe("");
    expect(w.calls).toContain("POST /v1/cc/decision/resolve");
    expect(patches.at(-1)).toMatchObject({ lastEvent: "working", op: "update", prio: 0 });
  });
});

describe("Always allow — session grants", () => {
  const sh = (command: string) => ({ command });
  test("grant derivation: a plain command grants its name; operators, substitutions, env prefixes → the exact text", () => {
    expect(devinGrantFor("shell", sh("touch one.txt"))).toEqual({ tool: "shell", prefix: "touch" });
    expect(devinGrantFor("shell", sh("ls -la"))).toEqual({ tool: "shell", prefix: "ls" });
    expect(devinGrantFor("shell", sh("./build.sh --fast"))).toEqual({ tool: "shell", prefix: "./build.sh" });
    for (const c of ["touch a && rm -rf ~", "echo $(id)", "ls > out", "cat a | sh", "echo `id`", "a; b", "FOO=1 make", "x\ny", "(ls)"]) {
      expect(devinGrantFor("shell", sh(c))).toEqual({ tool: "shell", exact: c });
    }
    expect(devinGrantFor("Write", { file_path: "/w/a.ts" })).toEqual({ tool: "Write" });
    expect(devinGrantFor("mcp__github__create_issue", {})).toEqual({ tool: "mcp__github__create_issue" });
  });

  test("a wrapper or interpreter never becomes a name grant: exact text only, labelled \"exact\"", () => {
    for (const c of [
      "bash scripts/test.sh", "sh x.sh", "zsh", "env FOO=1 make", "sudo ls", "doas ls", "timeout 5 ls", "xargs rm",
      "npx tsc", "bunx tsc", "nohup ./srv", "nice ls", "exec ls", "eval ls", "command ls", "time ls", "watch ls",
      ". ./env.sh", "source ./env.sh", "python3 -c 'print(1)'", "python3.12 x.py", "node -e 1", "bun test", "deno run x",
      "ruby -e 1", "perl -e 1", "/bin/bash scripts/test.sh", "/usr/bin/env rm -rf ~", "BASH -c ls", "find . -delete",
    ]) {
      expect(devinGrantFor("shell", sh(c))).toEqual({ tool: "shell", exact: c });
      expect(devinGrantText("shell", sh(c))).toBe("exact");
    }
    // The exploit: Always allow on `bash scripts/test.sh` must not cover `bash -c "rm -rf ~"` or `env rm -rf ~`.
    const g = devinGrantFor("shell", sh("bash scripts/test.sh"));
    expect(devinGrantMatches(g, "shell", sh("bash scripts/test.sh"))).toBe(true);
    for (const c of ['bash -c "rm -rf ~"', "bash scripts/test.sh --x", "env rm -rf ~"]) expect(devinGrantMatches(g, "shell", sh(c))).toBe(false);
    // A name grant on a wrapper (an older grants file) matches nothing.
    for (const prefix of ["bash", "env", "/bin/sh", "python3"]) {
      expect(devinGrantMatches({ tool: "shell", prefix }, "shell", sh(`${prefix} -c 'rm -rf ~'`))).toBe(false);
    }
  });

  // 2026-11-14 audit L3: these run arbitrary code from their ARGUMENTS (`git -c core.fsmonitor=…`, `make -f`,
  // GNU `sed '1e …'`, `tar --to-command=…`, `rsync -e …`, `npm exec …`, `vim -c '!…'`, build scripts), so
  // "Always allow" on one is that exact command line, never the tool's name.
  test("an argument-driven executor never becomes a name grant: git status covers git status, not git -c …", () => {
    for (const c of [
      "git status", "git diff", "make", "make test", "gmake", "sed -n 1p a.txt", "gsed s/a/b/ x", "tar xf a.tar", "rsync -a a b",
      "npm test", "pnpm i", "yarn build", "cargo build", "go test ./...", "swift build", "uv run x", "pip3 install x",
      "vim a", "vi a", "nvim a", "emacs a", "less a", "more a", "man ls", "xcodebuild -scheme X", "gradle build",
      "mvn test", "docker ps", "kubectl get pods", "brew install x", "zip -r a.zip .", "scp a b:", "sqlite3 db",
      "gdb ./a", "lldb ./a", "tmux", "open .", "/usr/bin/git status", "GIT status", "nomo status", "nomo-ai status",
    ]) {
      expect([c, devinGrantFor("shell", sh(c))]).toEqual([c, { tool: "shell", exact: c }]);
      expect(devinGrantText("shell", sh(c))).toBe("exact");
    }
    const g = devinGrantFor("shell", sh("git status"));
    expect(devinGrantMatches(g, "shell", sh("git status"))).toBe(true);
    for (const c of ["git -c core.fsmonitor='touch /tmp/pwned' status", "git -c core.sshCommand=x fetch", "git status --porcelain"]) {
      expect([c, devinGrantMatches(g, "shell", sh(c))]).toEqual([c, false]);
    }
    // A name grant from an older grants file matches nothing for these.
    for (const prefix of ["git", "make", "sed", "tar", "rsync", "npm", "cargo", "vim", "less", "xcodebuild", "nomo"]) {
      expect([prefix, devinGrantMatches({ tool: "shell", prefix }, "shell", sh(`${prefix} -c x`))]).toEqual([prefix, false]);
    }
    // Plain commands keep the name grant.
    for (const [c, name] of [["touch b.txt", "touch"], ["ls -la", "ls"], ["cat a", "cat"], ["mkdir -p x", "mkdir"], ["grep -rn a .", "grep"]]) {
      expect(devinGrantFor("shell", sh(c))).toEqual({ tool: "shell", prefix: name });
    }
  });

  test("grant text (the card's permissionGrant) says what the grant above covers, and rides to the hold", async () => {
    expect(devinGrantText("shell", sh("touch one.txt"))).toBe("cmd:touch");
    expect(devinGrantText("shell", sh("touch a && rm b"))).toBe("exact");
    expect(devinGrantText("Write", { file_path: "/w/a.ts" })).toBe("tool:Write");
    expect(devinGrantText("mcp__github__create_issue", {})).toBe("tool:mcp__github__create_issue");
    let grant: string | undefined;
    await runDevinApproval(JSON.stringify(payload("exec", { command: "touch one.txt" })), {
      env: ENV, sessionsDir: freshDir(), run: (async (deps: { grant?: string }) => { grant = deps.grant; }) as never,
    });
    expect(grant).toBe("cmd:touch");
  });

  test("matching: word-complete name prefix, plain commands only; exact grants; whole-tool grants", () => {
    const touch = { tool: "shell", prefix: "touch" };
    expect(devinGrantMatches(touch, "shell", sh("touch two.txt"))).toBe(true);
    expect(devinGrantMatches(touch, "shell", sh("touch"))).toBe(true);
    expect(devinGrantMatches(touch, "shell", sh("touchy x"))).toBe(false);
    expect(devinGrantMatches(touch, "shell", sh("touch x && echo y"))).toBe(false);
    expect(devinGrantMatches(touch, "shell", sh("touch $(rm -rf ~)"))).toBe(false);
    expect(devinGrantMatches(touch, "Write", { file_path: "/x" })).toBe(false);
    const exact = { tool: "shell", exact: "ls | wc -l" };
    expect(devinGrantMatches(exact, "shell", sh("ls | wc -l"))).toBe(true);
    expect(devinGrantMatches(exact, "shell", sh("ls | wc -c"))).toBe(false);
    expect(devinGrantMatches({ tool: "Write" }, "Write", { file_path: "/anything" })).toBe(true);
    expect(devinGrantMatches({ tool: "shell" }, "shell", sh("ls"))).toBe(false); // a malformed grant matches nothing
  });

  const hso = (decision: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  const ALWAYS = hso({ behavior: "allow", updatedPermissions: [{ type: "addRules", rules: [{ toolName: "shell" }], behavior: "allow", destination: "session" }] });
  const scripted = (line: string | undefined, calls: { n: number }) => (async (deps: { emit?: (l: string) => void }) => {
    calls.n++;
    if (line !== undefined) deps.emit!(line);
  }) as never;
  const req = (command: string) => JSON.stringify(payload("exec", { command }));
  const PAIRED = { loadConfigFn: async () => CONFIG } as never;

  test("allow_always stores the grant (0600) and approves; the next matching request short-circuits without the relay", async () => {
    const dir = freshDir();
    const calls = { n: 0 };
    expect(await runDevinApproval(req("touch one.txt"), { env: ENV, hold: PAIRED, sessionsDir: dir, run: scripted(ALWAYS, calls) })).toBe('{"decision":"approve"}');
    const path = devinGrantsPath(dir, "brawny-shirt");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual([{ tool: "shell", prefix: "touch" }]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await runDevinApproval(req("touch two.txt"), { env: ENV, hold: PAIRED, sessionsDir: dir, run: scripted(undefined, calls) })).toBe('{"decision":"approve"}');
    expect(calls.n).toBe(1); // no hold, no card, not even the pause gate
    // a chained command still goes to the phone (and no answer → no opinion)
    expect(await runDevinApproval(req("touch x && echo y"), { env: ENV, hold: PAIRED, sessionsDir: dir, run: scripted(undefined, calls) })).toBe("");
    expect(calls.n).toBe(2);
    // another session never inherits it
    const other = JSON.stringify({ ...payload("exec", { command: "touch z" }), session_id: "other-slug" });
    expect(await runDevinApproval(other, { env: ENV, hold: PAIRED, sessionsDir: dir, run: scripted(undefined, calls) })).toBe("");
    expect(calls.n).toBe(3);
  });

  test("unpaired: a saved grant approves nothing (Devin's own prompt decides)", async () => {
    const dir = freshDir();
    const calls = { n: 0 };
    await runDevinApproval(req("touch one.txt"), { env: ENV, hold: PAIRED, sessionsDir: dir, run: scripted(ALWAYS, calls) });
    expect(await stat(devinGrantsPath(dir, "brawny-shirt")).then(() => true, () => false)).toBe(true);
    const unpaired = { loadConfigFn: async () => null } as never;
    expect(await runDevinApproval(req("touch two.txt"), { env: ENV, hold: unpaired, sessionsDir: dir, run: scripted(undefined, calls) })).toBe("");
    expect(calls.n).toBe(2); // went to the hold (which, unpaired, prints nothing) — no short-circuit approve
  });

  test("plain allow, allow_mode and deny store nothing", async () => {
    const dir = freshDir();
    const calls = { n: 0 };
    for (const line of [hso({ behavior: "allow" }), hso({ behavior: "deny", message: "no" }), undefined]) {
      await runDevinApproval(req("touch one.txt"), { env: ENV, hold: PAIRED, sessionsDir: dir, run: scripted(line, calls) });
    }
    expect(await stat(devinGrantsPath(dir, "brawny-shirt")).then(() => true, () => false)).toBe(false);
  });

  test("SessionEnd and the watchdog's record retirement delete the grant file", async () => {
    const dir = freshDir();
    await runDevinApproval(req("touch one.txt"), { env: ENV, hold: PAIRED, sessionsDir: dir, run: scripted(ALWAYS, { n: 0 }) });
    const path = devinGrantsPath(dir, "brawny-shirt");
    const exists = () => stat(path).then(() => true, () => false);
    expect(await exists()).toBe(true);
    await runDevinHook(JSON.stringify({ hook_event_name: "SessionEnd", session_id: "brawny-shirt" }), {
      env: ENV, sessionsDir: dir, config: null, stampPath: join(dir, "stamp"),
    });
    expect(await exists()).toBe(false);
    await runDevinApproval(req("touch one.txt"), { env: ENV, hold: PAIRED, sessionsDir: dir, run: scripted(ALWAYS, { n: 0 }) });
    await forgetDevinGrants(join(dir, "brawny-shirt.json"));
    expect(await exists()).toBe(false);
  });

  test("through the relay: a phone Always allow on a Write grants Write for the session", async () => {
    let clock = 1_000;
    const dir = freshDir();
    const answered = { status: "answered", answerBlob: await encryptBlob(KEY, { requestId: "req-devin", decision: "allow_always" }) };
    const w = worker(true, [answered]);
    const write = JSON.stringify(payload("write", { file_path: "/w/a.ts", content: "x" }));
    const out = await runDevinApproval(write, {
      env: ENV, abandoned: () => false, sessionsDir: dir,
      hold: {
        loadConfigFn: async () => CONFIG, readRecordFn: async () => null, sleep: async () => { clock += 3_000; },
        now: () => clock, randomUUID: () => "req-devin", jitter: () => 0, noHoldPath: "/does/not/exist/no-hold",
        trace: () => {}, fetchFn: w.fn,
      } as never,
    });
    expect(out).toBe('{"decision":"approve"}');
    expect(JSON.parse(await readFile(devinGrantsPath(dir, "brawny-shirt"), "utf8"))).toEqual([{ tool: "Write" }]);
  });
});

// ── questions (ask_user_question → AskUserQuestion; the answer goes back as a block reason) ─────────

const ASK = {
  hook_event_name: "PreToolUse", session_id: "brawny-shirt", prompt_id: "p1", tool_name: "ask_user_question",
  tool_input: { questions: [
    { question: "Which color do you prefer?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue" }] },
    { question: "Which sizes?", options: [{ label: "S" }, { label: "M" }, { label: "L" }], multi_select: true },
  ] },
};

describe("questions", () => {
  test("stdin: AskUserQuestion, Claude's shape — multiSelect, missing descriptions omitted", () => {
    const s = JSON.parse(devinPermissionStdin(ASK, "/w/api")!);
    expect(s).toEqual({
      session_id: "brawny-shirt", cwd: "/w/api", hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion",
      tool_input: { questions: [
        { question: "Which color do you prefer?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue" }], multiSelect: false },
        { question: "Which sizes?", options: [{ label: "S" }, { label: "M" }, { label: "L" }], multiSelect: true },
      ] },
    });
    expect(JSON.parse(devinPermissionStdin({ ...ASK, tool_input: { questions: "x" } })!).tool_input).toEqual({ questions: [] });
  });

  const hso = (decision: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  const answered = (answers: Record<string, string>, annotations?: object) =>
    hso({ behavior: "allow", updatedInput: { questions: [], answers, ...(annotations ? { annotations } : {}) } });
  const reason = (out: string) => (JSON.parse(out) as { decision: string; reason: string });

  test("an answer line → block with the answers as the reason (multi-select, typed Other, notes)", () => {
    const out = devinDecision(answered({ "Which color do you prefer?": "Blue", "Which sizes?": "S, L" }), true);
    expect(reason(out)).toEqual({
      decision: "block",
      reason: 'The user answered from their phone (Nomo): "Which color do you prefer?" → Blue; "Which sizes?" → S, L. Use these answers and continue; do not ask the same question again.',
    });
    expect(reason(devinDecision(answered({ "Which color do you prefer?": "teal, please" }, { "Which color do you prefer?": { notes: "for the logo" } }), true)).reason)
      .toBe('The user answered from their phone (Nomo): "Which color do you prefer?" → teal, please (note: for the logo). Use these answers and continue; do not ask the same question again.');
  });

  test("deny → block (the note, or 'chose not to answer'); bare allow / no answers / over-long → no opinion", () => {
    expect(reason(devinDecision(hso({ behavior: "deny", message: "skip colors" }), true)).reason).toBe("skip colors");
    expect(reason(devinDecision(hso({ behavior: "deny", message: "Denied from phone" }), true)).reason).toContain("chose not to answer");
    expect(devinDecision(hso({ behavior: "allow" }), true)).toBe("");
    expect(devinDecision(answered({}), true)).toBe("");
    expect(devinDecision(answered({ "Which color do you prefer?": "x".repeat(DEVIN_ANSWER_REASON_MAX) }), true)).toBe("");
    expect(devinDecision(undefined, true)).toBe("");
  });

  test("through the relay: a sealed AskUserQuestion card; the phone's answer → block with the answer", async () => {
    let clock = 1_000;
    const hold = (fetchFn: typeof fetch) => ({
      loadConfigFn: async () => CONFIG, readRecordFn: async () => null, sleep: async () => { clock += 3_000; },
      now: () => clock, randomUUID: () => "req-devin", jitter: () => 0, noHoldPath: "/does/not/exist/no-hold",
      trace: () => {}, fetchFn,
    }) as never;
    const ask = (fetchFn: typeof fetch) => runDevinApproval(JSON.stringify(ASK), { env: ENV, abandoned: () => false, sessionsDir: freshDir(), hold: hold(fetchFn) });
    const answer = async (a: object) => ({ status: "answered", answerBlob: await encryptBlob(KEY, { requestId: "req-devin", ...a }) });

    const w = worker(true, [{ status: "pending" }, await answer({ decision: "answer", answers: ["Blue", "S, L"] })]);
    expect(reason(await ask(w.fn))).toEqual({
      decision: "block",
      reason: 'The user answered from their phone (Nomo): "Which color do you prefer?" → Blue; "Which sizes?" → S, L. Use these answers and continue; do not ask the same question again.',
    });
    const card = await decryptBlob(KEY, w.cards[0]!) as Record<string, unknown>;
    expect(card).toMatchObject({ agent: "devin", status: "decisionPending", permissionToolName: "AskUserQuestion" });
    expect(Array.isArray(card.permissionQuestions)).toBe(true);

    // typed Other + a note (answerExtras: true)
    const extras = await ask(worker(true, [await answer({ decision: "answer", answers: ["", "M"], other: ["Green", ""], notes: ["", "for kids"] })]).fn);
    expect(reason(extras).reason).toBe('The user answered from their phone (Nomo): "Which color do you prefer?" → Green; "Which sizes?" → M (note: for kids). Use these answers and continue; do not ask the same question again.');

    // a bare allow / always allow on a question is released → nothing (Devin shows its own question)
    expect(await ask(worker(true, [await answer({ decision: "allow" })]).fn)).toBe("");
    expect(await ask(worker(true, [await answer({ decision: "allow_always" })]).fn)).toBe("");
    // an answer that matches no option → released
    expect(await ask(worker(true, [await answer({ decision: "answer", answers: ["Purple", "S"] })]).fn)).toBe("");
    // deny
    expect(reason(await ask(worker(true, [await answer({ decision: "deny" })]).fn)).reason).toContain("chose not to answer");
  });

  test("paused approvals: the question is delegated to the producer (the yellow heads-up) and nothing printed", async () => {
    let delegated = 0;
    const out = await runDevinApproval(JSON.stringify(ASK), {
      env: ENV, sessionsDir: freshDir(), delegate: async () => { delegated++; },
      run: (async (deps: { delegate?: () => Promise<void> }) => { await deps.delegate!(); }) as never,
    });
    expect([delegated, out]).toEqual([1, ""]);
  });
});

const installerPath = join(import.meta.dir, "../../plugin/scripts/devin-install.mjs");
const { userSkill } = await import(installerPath) as { userSkill: (text: string, root: string) => string };

describe("Nomo's own /nomo-* commands never become phone cards", () => {
  const ROOT = "/Users/me/.nomo/plugin";
  const SKILLS = join(import.meta.dir, "../../plugin/devin-skills");
  /** Every fenced command in every plugin skill, as written (plugin) and as the installer writes it. */
  const commands = (installer: boolean): string[] => readdirSync(SKILLS).flatMap((name) => {
    const text = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
    return [...(installer ? userSkill(text, ROOT) : text).matchAll(/```\n(.+)\n```/g)].map((m) => m[1]!);
  });
  const SAFE = /dist\/(status-cmd\.mjs" devin|cc-permission\.mjs" (on|status))/;

  test("exactly the safe skill commands match, in both the plugin and the installer form", () => {
    for (const installer of [false, true]) {
      const all = commands(installer);
      expect(all.length).toBe(9); // status, approvals ×3, pair ×3, reset, unpair (a new command must be classified here)
      for (const c of all) expect([c.slice(0, 80), isDevinSkillCommand(c, ROOT)]).toEqual([c.slice(0, 80), SAFE.test(c)]);
      expect(all.filter((c) => isDevinSkillCommand(c, ROOT)).length).toBe(3);
      // one trailing newline is forgiven
      expect(isDevinSkillCommand(`${all.find((c) => SAFE.test(c))!}\n`, ROOT)).toBe(true);
    }
  });

  test("lookalikes are not ours", () => {
    const status = commands(false).find((c) => c.includes("status-cmd.mjs"))!;
    const mine = commands(true).find((c) => c.includes("status-cmd.mjs"))!;
    for (const c of [
      `${status} && rm -rf ~`, `${status}; rm -rf ~`, `${status} | sh`, `${status} > /tmp/x`, `${status}\nrm -rf ~`,
      `cd /tmp && ${status}`, ` ${status}`, `${status} `, `${status}\r`, status.replace("status-cmd", "evil"),
      status.replace(" devin;", " devin --plain;"), status.replace("exit 1'", "exit 1'; rm -rf ~"),
      mine.replace(ROOT, "/tmp/evil"), // the installer form under another checkout
      "~/.nomo/plugin/scripts/run.sh ~/.nomo/plugin/dist/status-cmd.mjs devin",
    ]) expect([c, isDevinSkillCommand(c, ROOT)]).toEqual([c, false]);
  });

  const run = (command: string, opts: { config?: Config | null; input?: Record<string, unknown> } = {}) => {
    const calls = { n: 0 };
    const out = runDevinApproval(JSON.stringify(payload("exec", { command, ...opts.input })), {
      env: ENV, sessionsDir: freshDir(), pluginRoot: ROOT,
      hold: { loadConfigFn: async () => (opts.config === undefined ? CONFIG : opts.config) },
      run: (async () => { calls.n++; }) as never,
    });
    return out.then((o) => ({ out: o, held: calls.n }));
  };

  test("paired: a skill command is approved at once (Desktop's workdir too); lookalikes go to the hold", async () => {
    const [plugin, installer] = [commands(false), commands(true)];
    for (const c of [...plugin, ...installer].filter((x) => SAFE.test(x))) expect(await run(c)).toEqual({ out: '{"decision":"approve"}', held: 0 });
    const status = plugin.find((c) => c.includes("status-cmd.mjs"))!;
    expect(await run(status, { input: { workdir: "/w/api" } })).toEqual({ out: '{"decision":"approve"}', held: 0 });
    // pausing approvals, pairing, pair wait, reset, unpairing and the typed code still ask the phone
    const asks = [...plugin, ...installer].filter((x) => !SAFE.test(x));
    expect(asks.length).toBe(12);
    for (const c of asks) expect([c.slice(-60), await run(c)]).toEqual([c.slice(-60), { out: "", held: 1 }]);
    expect(await run(`${status} && rm -rf ~`)).toEqual({ out: "", held: 1 });
    expect(await run(status, { input: { env: { HOME: "/tmp/evil" } } })).toEqual({ out: "", held: 1 }); // an unknown key
  });

  test("unpaired: no auto-approve (Devin's own prompt decides)", async () => {
    expect(await run(commands(false).find((c) => c.includes("status-cmd.mjs"))!, { config: null })).toEqual({ out: "", held: 1 });
  });

  // 2026-11-14 audit L2: on a paired computer `pair` revokes the current pairing first, so a prompt-injected
  // agent could silently cut the phone off. Nothing that pairs, unpairs, resets or uninstalls Nomo is ever
  // auto-approved — not as an own command and not through an Always-allow grant.
  const LIFECYCLE = [
    "nomo pair", "nomo-ai pair", "bunx nomo-ai pair", "bunx nomo-ai@latest pair", "npx nomo-ai unpair", "nomo unpair",
    "nomo reset", "nomo-ai reset", "nomo uninstall --devin", "nomo-ai --uninstall --devin", "nomo pair wait --timeout 60",
    "node ~/.nomo/plugin/scripts/devin-install.mjs --uninstall", "claude plugin uninstall nomo-cc@nomo",
    "devin plugins uninstall KarrixLee/nomo", "npm uninstall -g nomo-ai", "~/.config/cc-status/hook-shim.sh pair",
    "/x/plugin/scripts/run.sh /x/plugin/dist/unpair.mjs", "'/x/scripts/run.sh' '/x/dist/reset.mjs'",
  ];
  test("isNomoLifecycleCommand: pair / unpair / reset / uninstall in every form; status and approvals are not", () => {
    for (const c of [...LIFECYCLE, ...commands(false).filter((x) => /(pair|reset)\.mjs/.test(x))]) {
      expect([c.slice(-70), isNomoLifecycleCommand(c)]).toEqual([c.slice(-70), true]);
    }
    for (const c of ["nomo status", "nomo approvals on", "git repair", "ls pair.txt", "echo pairing", "nomogram pair", ...commands(false).filter((x) => SAFE.test(x))]) {
      expect([c.slice(-70), isNomoLifecycleCommand(c)]).toEqual([c.slice(-70), false]);
    }
  });

  test("a grant never auto-approves a lifecycle command (exact or name); it goes to the hold", async () => {
    const dir = freshDir();
    const path = devinGrantsPath(dir, "brawny-shirt");
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify([
      ...LIFECYCLE.map((exact) => ({ tool: "shell", exact })), { tool: "shell", prefix: "nomo" }, { tool: "shell", prefix: "nomo-ai" },
      { tool: "shell", prefix: "claude" }, { tool: "shell", prefix: "devin" }, { tool: "shell", prefix: "~/.config/cc-status/hook-shim.sh" },
      { tool: "shell", prefix: "/x/plugin/scripts/run.sh" },
    ]));
    for (const c of LIFECYCLE) {
      const calls = { n: 0 };
      const out = await runDevinApproval(JSON.stringify(payload("exec", { command: c })), {
        env: ENV, sessionsDir: dir, pluginRoot: ROOT, hold: { loadConfigFn: async () => CONFIG },
        run: (async () => { calls.n++; }) as never,
      });
      expect([c, out, calls.n]).toEqual([c, "", 1]);
    }
  });
});
