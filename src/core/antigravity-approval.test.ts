// Tests for the Antigravity phone-approval hook (core/antigravity-approval.ts) and the
// antigravity-approve.sh wrapper. No network (scripted fetch), no real ~/.gemini or ~/.config: every
// spawned process gets a temp HOME.

import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  ANTIGRAVITY_STOP_DENY, ANTIGRAVITY_APPROVAL_MATCHER, ANTIGRAVITY_APPROVAL_TIMEOUT_S, ANTIGRAVITY_ENTRY_CAP_MS, ANTIGRAVITY_FALLBACK,
  ANTIGRAVITY_HOLD_DEADLINE_MS, ANTIGRAVITY_RETRY_PASS_MS, antigravityApprovalRequest, antigravityDecision, runAntigravityApproval,
} from "./antigravity-approval";
import { encryptBlob } from "./crypto";
import { SAFE_SKILL_COMMANDS, skillCommand } from "../../plugin/scripts/antigravity-skill-command.mjs";
import type { Config } from "./shared";
import { createProcessHygiene, isolatedTestEnv } from "../test/process-hygiene";

const { spawnTestProcess } = createProcessHygiene();
const PLUGIN = join(import.meta.dir, "../../plugin");
const KEY = new Uint8Array(32).fill(7);
const CONFIG: Config = { url: "https://example.invalid", pairingId: "pairing-1", pcSecret: "secret", e2eKey: KEY };
const CONV = "c0ffee00-0000-4000-8000-000000000001";
const WS = "/Users/x/proj";
const NO_RULES = { allow: [], ask: [], deny: [] };

const tmps: string[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), "nomo-agy-approve-")));
  tmps.push(d);
  return d;
}

/** A PreToolUse payload as agy 1.4.8 sends it. */
const payload = (name: string, args: Record<string, unknown>) => ({
  conversationId: CONV, workspacePaths: [WS], modelName: "gemini-3.8-flash-high", stepIdx: 2,
  transcriptPath: "/nowhere/transcript_full.jsonl", toolCall: { name, args },
});
const RUN = payload("run_command", { CommandLine: "rm -rf build", WaitMsBeforeAsync: 5000, toolSummary: "Clean the build dir" });

describe("antigravityApprovalRequest — what reaches the phone", () => {
  test("run_command → the phone's shell card (command + the model's summary)", () => {
    expect(antigravityApprovalRequest(RUN)).toMatchObject({
      sessionId: CONV, cwd: WS, agyTool: "run_command", toolName: "shell",
      toolInput: { command: "rm -rf build", description: "Clean the build dir" },
    });
  });

  test("file writes/edits → Write/Edit with the path, inside the workspace too", () => {
    expect(antigravityApprovalRequest(payload("write_file", { Path: `${WS}/a.txt`, Content: "hi" })))
      .toMatchObject({ toolName: "Write", toolInput: { file_path: `${WS}/a.txt` } });
    expect(antigravityApprovalRequest(payload("replace_file_content", { TargetFile: "/etc/hosts" })))
      .toMatchObject({ toolName: "Edit", toolInput: { file_path: "/etc/hosts" } });
  });

  test("harmless / unknown tools, no id, no command → never held", () => {
    for (const t of ["read_file", "view_file", "list_dir", "grep_search", "search_web", "ask_question"]) {
      expect(antigravityApprovalRequest(payload(t, { Path: "/x" }))).toBeNull();
    }
    expect(antigravityApprovalRequest({ ...RUN, conversationId: "../../etc" })).toBeNull();
    expect(antigravityApprovalRequest(payload("run_command", {}))).toBeNull();
  });

  test("the user's own allow rules let a call through; ask/deny and compound lines still go to the phone", () => {
    const r = (allow: string[], ask: string[] = [], deny: string[] = []) => ({ allow, ask, deny });
    const cmd = (c: string) => payload("run_command", { CommandLine: c });
    expect(antigravityApprovalRequest(cmd("git status -s"), r(["command(git status)"]))).toBeNull();
    expect(antigravityApprovalRequest(cmd("anything"), r(["command(*)"]))).toBeNull();
    expect(antigravityApprovalRequest(cmd("gitx status"), r(["command(git)"]))).not.toBeNull();
    expect(antigravityApprovalRequest(cmd("git status && rm -rf /"), r(["command(git)"]))).not.toBeNull();
    expect(antigravityApprovalRequest(cmd("git push"), r(["command(git)"], ["command(git push)"]))).not.toBeNull();
    // Deny > Ask > Allow: anything a deny rule may match is never routed (Antigravity denies it itself).
    expect(antigravityApprovalRequest(cmd("git push"), r(["command(git)"], [], ["command(regex:.*)"]))).toBeNull();
    expect(antigravityApprovalRequest(cmd("git push"), r(["command(regex:git.*)"]))).not.toBeNull();
    const w = (p: string) => payload("write_file", { Path: p });
    expect(antigravityApprovalRequest(w(`${WS}/src/a.ts`), r(["write_file(src/)"]))).toBeNull();
    expect(antigravityApprovalRequest(w(`${WS}/srcx/a.ts`), r(["write_file(src/)"]))).not.toBeNull();
  });

  test("a local deny rule is never routed to the phone — even with a matching allow or ask", () => {
    const r = (allow: string[], ask: string[] = [], deny: string[] = []) => ({ allow, ask, deny });
    const cmd = (c: string) => payload("run_command", { CommandLine: c });
    expect(antigravityApprovalRequest(cmd("rm -rf build"), r([], [], ["command(rm)"]))).toBeNull();
    expect(antigravityApprovalRequest(cmd("rm -rf build"), r(["command(rm)"], ["command(rm)"], ["command(rm)"]))).toBeNull();
    expect(antigravityApprovalRequest(cmd("ls && rm -rf build"), r([], [], ["command(rm)"]))).toBeNull(); // compound: may contain it
    expect(antigravityApprovalRequest(payload("write_file", { Path: `${WS}/secrets/k` }), r([], [], ["write_file(secrets/)"]))).toBeNull();
    expect(antigravityApprovalRequest(cmd("ls -la"), r([], [], ["command(rm)"]))).not.toBeNull(); // unrelated → phone
    expect(antigravityApprovalRequest(cmd("git push"), r(["command(git)"], ["command(git push)"]))).not.toBeNull(); // ask → phone
  });

  test("deny/ask is LOOSE: every evasion of `command(rm)` stays local, never reaches the phone", () => {
    const deny = { allow: [], ask: [], deny: ["command(rm)"] };
    const cmd = (c: string) => payload("run_command", { CommandLine: c });
    for (const c of [
      "rm -rf x", "FOO=1 rm -rf x", "sudo rm x", "sudo -u root rm x", "doas rm x", "env rm x", "env A=1 rm x",
      "command rm x", "exec rm x", "nice -n 5 rm x", "time rm x", "nohup rm x &", "find . | xargs rm", "builtin rm x",
      "/bin/rm x", "\\rm x", "'rm' x", "\"rm\" x", "ls && rm x", "ls || rm x", "ls; rm x", "ls | rm", "ls & rm x",
      "ls\nrm x", "echo $(rm x)", "echo `rm x`", "(rm x)", "{ rm x; }",
    ]) expect([c, antigravityApprovalRequest(cmd(c), deny)]).toEqual([c, null]);
    // ask behaves the same way (routes to the phone, which is where ask belongs — never a passthrough)
    expect(antigravityApprovalRequest(cmd("sudo rm x"), { allow: ["command(sudo)"], ask: ["command(rm)"], deny: [] })).not.toBeNull();
    // unrelated commands still reach the phone
    for (const c of ["ls -la", "git rm-cache", "echo removing"]) expect(antigravityApprovalRequest(cmd(c), deny)).not.toBeNull();
  });

  test("allow is STRICT: a plain prefix only — no separators, subshells, quotes, escapes or line breaks", () => {
    const allow = { allow: ["command(git status)"], ask: [], deny: [] };
    const cmd = (c: string) => payload("run_command", { CommandLine: c });
    expect(antigravityApprovalRequest(cmd("git status -s"), allow)).toBeNull();
    for (const c of ["git status; rm x", "git status && rm x", "git status | sh", "git status $(rm x)", "git status `x`",
      "git status\nrm x", "git status\rrm", "git status 'x'", "git status \\x", "FOO=1 git status", "sudo git status"]) {
      expect([c, antigravityApprovalRequest(cmd(c), allow)]).not.toEqual([c, null]);
    }
  });

  test("regex: rules are compiled — only what they match is deferred; an uncompilable one matches everything", () => {
    const cmd = (c: string) => payload("run_command", { CommandLine: c });
    const r = (deny: string[]) => ({ allow: [], ask: [], deny });
    expect(antigravityApprovalRequest(cmd("rm -rf x"), r(["command(regex:^rm\\b)"]))).toBeNull();
    expect(antigravityApprovalRequest(cmd("ls"), r(["command(regex:^rm\\b)"]))).not.toBeNull(); // one regex no longer disables the phone
    expect(antigravityApprovalRequest(cmd("ls"), r(["command(regex:([)"]))).toBeNull(); // bad regex → safe reading
    expect(antigravityApprovalRequest(payload("write_file", { Path: `${WS}/.env` }), r(["write_file(regex:\\.env$)"]))).toBeNull();
    expect(antigravityApprovalRequest(payload("write_file", { Path: `${WS}/a.ts` }), r(["write_file(regex:\\.env$)"]))).not.toBeNull();
    // a regex ALLOW rule never passes anything through (the phone still asks)
    expect(antigravityApprovalRequest(cmd("git status"), { allow: ["command(regex:.*)"], ask: [], deny: [] })).not.toBeNull();
  });

  test("writes into Nomo's own code or state always reach the phone, even under an allow rule", () => {
    const allowAll = { allow: ["write_file(*)", "write_file(/)"], ask: [], deny: [] };
    const dirs = ["/opt/nomo/plugin", "/Users/x/.config/cc-status"];
    const w = (p: string) => antigravityApprovalRequest(payload("write_file", { Path: p }), allowAll, dirs);
    expect(w("/opt/nomo/plugin/scripts/run.sh")).not.toBeNull();
    expect(w("/opt/nomo/plugin/../plugin/dist/x.mjs")).not.toBeNull();
    expect(w("/Users/x/.config/cc-status/config.json")).not.toBeNull();
    expect(w(`${WS}/src/a.ts`)).toBeNull(); // ordinary allowed write: untouched
    // a deny still wins over the protection (no opinion → Antigravity denies)
    expect(antigravityApprovalRequest(payload("write_file", { Path: "/opt/nomo/plugin/x" }), { allow: [], ask: [], deny: ["write_file(/opt)"] }, dirs)).toBeNull();
  });

  test("end to end: a denied call answers the fallback (no opinion) and never starts the relay", async () => {
    let started = false;
    const out = await runAntigravityApproval(JSON.stringify(RUN), {
      rules: () => ({ allow: [], ask: [], deny: ["command(rm)"] }), run: (async () => { started = true; }) as never,
      stopRequested: async () => false,
    });
    expect(out).toBe(ANTIGRAVITY_FALLBACK);
    expect(started).toBe(false);
  });

  test("the installer's matcher is exactly the routed tool set", async () => {
    const re = new RegExp(ANTIGRAVITY_APPROVAL_MATCHER);
    for (const t of ["run_command", "write_file", "replace_file_content"]) expect(re.test(t)).toBe(true);
    for (const t of ["read_file", "run_command_x", "xwrite_file"]) expect(re.test(t)).toBe(false);
    const installer = await readFile(join(PLUGIN, "scripts", "antigravity-install.mjs"), "utf8");
    expect(installer).toContain(`const APPROVAL_MATCHER = "${ANTIGRAVITY_APPROVAL_MATCHER}";`);
    expect(installer).toContain(`const APPROVAL_TIMEOUT = ${ANTIGRAVITY_APPROVAL_TIMEOUT_S};`);
    const wrapper = await readFile(join(PLUGIN, "scripts", "antigravity-approve.sh"), "utf8");
    const guardS = Number(/GUARD_S=\$\{NOMO_AGY_GUARD_S:-(\d+)\}/.exec(wrapper)?.[1]);
    // hold deadline < entry cap < shell guard < hook timeout
    expect(ANTIGRAVITY_HOLD_DEADLINE_MS).toBeLessThan(ANTIGRAVITY_ENTRY_CAP_MS);
    expect(ANTIGRAVITY_ENTRY_CAP_MS).toBeLessThan(guardS * 1000);
    expect(guardS).toBeLessThan(ANTIGRAVITY_APPROVAL_TIMEOUT_S);
  });
});

describe("antigravityDecision — the emitted line → Antigravity's wire", () => {
  const line = (decision: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  test("allow (and any allow variant) → auto_approve; deny → deny + reason; nothing → fallback", () => {
    expect(antigravityDecision(line({ behavior: "allow" }))).toBe('{"decision":"auto_approve"}');
    expect(antigravityDecision(line({ behavior: "allow", updatedPermissions: [{}] }))).toBe('{"decision":"auto_approve"}');
    expect(antigravityDecision(line({ behavior: "deny", message: 'use "bun"' })))
      .toBe('{"decision":"deny","reason":"use \\"bun\\""}');
    expect(antigravityDecision(line({ behavior: "deny" }))).toBe('{"decision":"deny","reason":"Denied from phone"}');
    expect(antigravityDecision(undefined)).toBe(ANTIGRAVITY_FALLBACK);
    expect(antigravityDecision("{oops")).toBe(ANTIGRAVITY_FALLBACK);
  });
});

/** A scripted worker: the decision POST grants `hold`, each GET returns the next scripted body. */
function worker(hold: boolean, gets: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  let g = 0;
  const fn = (async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url.replace(CONFIG.url, "")}`);
    if (url.endsWith("/v1/cc/full")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.endsWith("/v1/cc/decision")) return new Response(JSON.stringify({ hold }), { status: 200 });
    return new Response(JSON.stringify(gets[Math.min(g++, gets.length - 1)]), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("runAntigravityApproval — through the shared relay", () => {
  let clock = 1_000;
  const hold = (over: Record<string, unknown>) => ({
    loadConfigFn: async () => CONFIG, readRecordFn: async () => null, sleep: async () => { clock += 3_000; },
    now: () => clock, randomUUID: () => "req-agy", jitter: () => 0, noHoldPath: "/does/not/exist/no-hold",
    trace: () => {}, ...over,
  });
  const answered = async (answer: object) => ({ status: "answered", answerBlob: await encryptBlob(KEY, { requestId: "req-agy", ...answer }) });
  let retryDir = "";
  beforeEach(async () => { retryDir = await tmp(); });
  const run = (deps: Record<string, unknown>, input: object = RUN, stopRequested = async () => false) =>
    runAntigravityApproval(JSON.stringify(input), { rules: () => NO_RULES, hold: hold(deps) as never, stopRequested, retryDir });

  describe("exact-retry pass-through (desktop sandbox retry)", () => {
    const RETRY = payload("run_command", { CommandLine: "rm -rf build", BypassSandbox: true, toolSummary: "Retry" });
    const allow = async () => worker(true, [await answered({ decision: "allow" })]);
    const AUTO = '{"decision":"auto_approve"}';

    test("allow → the identical retry within 90 s passes ONCE; the next needs a card; ticket file is 0600", async () => {
      expect(await run({ fetchFn: (await allow()).fn })).toBe(AUTO);
      const [name] = await readdir(retryDir);
      expect((await stat(join(retryDir, name!))).mode & 0o777).toBe(0o600);
      clock += ANTIGRAVITY_RETRY_PASS_MS - 10_000;
      const none = worker(true, []);
      expect(await run({ fetchFn: none.fn }, RETRY)).toBe(AUTO);
      expect(none.calls).toEqual([]); // no card
      const again = await allow();
      expect(await run({ fetchFn: again.fn }, RETRY)).toBe(AUTO);
      expect(again.calls).toContain("POST /v1/cc/decision"); // a fresh card
    });

    test("a deny leaves no pass", async () => {
      expect(await run({ fetchFn: worker(true, [await answered({ decision: "deny" })]).fn })).toContain('"deny"');
      const w = worker(true, [await answered({ decision: "deny" })]);
      expect(await run({ fetchFn: w.fn }, RETRY)).toContain('"deny"');
      expect(w.calls).toContain("POST /v1/cc/decision");
    });

    test("a different command, a different conversation, or an expired entry → a card", async () => {
      const cases: Array<[object, number]> = [
        [payload("run_command", { CommandLine: "rm -rf build2", BypassSandbox: true }), 0],
        [{ ...RETRY, conversationId: "c0ffee00-0000-4000-8000-000000000002" }, 0],
        [RETRY, ANTIGRAVITY_RETRY_PASS_MS + 1],
      ];
      for (const [input, wait] of cases) {
        await rm(retryDir, { recursive: true, force: true });
        expect(await run({ fetchFn: (await allow()).fn })).toBe(AUTO);
        clock += wait;
        const w = worker(true, [await answered({ decision: "deny" })]);
        expect(await run({ fetchFn: w.fn }, input)).toContain('"deny"');
        expect(w.calls).toContain("POST /v1/cc/decision");
      }
    });
  });

  test("phone Stop already pressed → deny 'Stopped from phone' at once, zero network", async () => {
    const { fn, calls } = worker(true, []);
    expect(await run({ fetchFn: fn }, RUN, async () => true)).toBe(ANTIGRAVITY_STOP_DENY);
    expect(ANTIGRAVITY_STOP_DENY).toBe('{"decision":"deny","reason":"Stopped from phone"}');
    expect(calls).toEqual([]);
  });

  test("phone Stop while the card is HELD → deny, and the worker's card is resolved", async () => {
    const { fn, calls } = worker(true, [{ status: "pending" }, { status: "pending" }, { status: "pending" }]);
    let checks = 0;
    const out = await run({ fetchFn: fn }, RUN, async () => ++checks >= 3); // pressed during the hold
    expect(out).toBe(ANTIGRAVITY_STOP_DENY);
    expect(calls).toContain("POST /v1/cc/decision");
    expect(calls).toContain("POST /v1/cc/decision/resolve");
  });

  test("unpaired → allow, zero network", async () => {
    const { fn, calls } = worker(true, []);
    expect(await run({ loadConfigFn: async () => null, fetchFn: fn })).toBe(ANTIGRAVITY_FALLBACK);
    expect(calls).toEqual([]);
  });

  test("phone Allow → auto_approve, and the card POSTed as a held decision", async () => {
    const { fn, calls } = worker(true, [{ status: "pending" }, await answered({ decision: "allow" })]);
    expect(await run({ fetchFn: fn })).toBe('{"decision":"auto_approve"}');
    expect(calls).toContain("POST /v1/cc/decision");
    expect(calls).toContain("GET /v1/cc/decision/req-agy");
  });

  test("phone Deny with a note → deny + the note as the reason; bare Deny → the default reason", async () => {
    let w = worker(true, [await answered({ decision: "deny", message: "Use bun, not npm" })]);
    expect(await run({ fetchFn: w.fn })).toBe('{"decision":"deny","reason":"Use bun, not npm"}');
    w = worker(true, [await answered({ decision: "deny" })]);
    expect(await run({ fetchFn: w.fn })).toBe('{"decision":"deny","reason":"Denied from phone"}');
  });

  test("a stale phone's Always allow degrades to a plain auto_approve", async () => {
    const { fn } = worker(true, [await answered({ decision: "allow_always" })]);
    expect(await run({ fetchFn: fn })).toBe('{"decision":"auto_approve"}');
  });

  test("session not on the phone (hold:false), expired, network down → allow", async () => {
    // an established session (record older than the fresh-session window) → no re-ask
    const rec = async () => ({ ts: -10_000_000 });
    expect(await run({ fetchFn: worker(false, []).fn, readRecordFn: rec })).toBe(ANTIGRAVITY_FALLBACK);
    expect(await run({ fetchFn: worker(true, [{ status: "expired" }]).fn })).toBe(ANTIGRAVITY_FALLBACK);
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await run({ fetchFn: down })).toBe(ANTIGRAVITY_FALLBACK);
  });

  test("approvals paused (the shared no-hold flag) → allow, zero network", async () => {
    const flag = join(await tmp(), "no-hold");
    await writeFile(flag, "");
    const { fn, calls } = worker(true, []);
    expect(await run({ fetchFn: fn, noHoldPath: flag })).toBe(ANTIGRAVITY_FALLBACK);
    expect(calls).toEqual([]);
  });

  test("a hold the phone never answers ends at the deadline → allow", async () => {
    const { fn } = worker(true, [{ status: "pending" }]);
    expect(await run({ fetchFn: fn, deadlineAt: clock + 10_000 })).toBe(ANTIGRAVITY_FALLBACK);
  });

  test("harmless tools never wait: the relay is not even started", async () => {
    let started = false;
    const out = await runAntigravityApproval(JSON.stringify(payload("read_file", { Path: "/x" })), {
      rules: () => NO_RULES, run: (async () => { started = true; }) as never,
    });
    expect(out).toBe(ANTIGRAVITY_FALLBACK);
    expect(started).toBe(false);
  });

  test("abandoned mid-hold (the agent killed our wrapper) → no decision, card withdrawn, row settled WORKING", async () => {
    const { fn, calls } = worker(true, [{ status: "pending" }]);
    let checks = 0;
    const patches: Record<string, unknown>[] = [];
    const out = await runAntigravityApproval(JSON.stringify(RUN), {
      rules: () => NO_RULES, stopRequested: async () => false, abandoned: () => ++checks >= 2,
      hold: hold({
        fetchFn: fn, writeHoldFn: async () => {},
        clearHoldFn: async (_id: string, _pid: number, settle?: () => Promise<void>) => { await settle?.(); },
        settleHoldRecordFn: async (_id: string, patch: Record<string, unknown>) => { patches.push(patch); },
      }) as never,
    });
    expect(out).toBe(ANTIGRAVITY_FALLBACK); // printed to nobody; the wrapper is gone
    expect(calls).toContain("POST /v1/cc/decision/resolve");
    expect(patches.at(-1)).toMatchObject({ lastEvent: "working", op: "update", prio: 0 }); // not done: the turn may go on
  });

  test("malformed input / a throwing relay → allow", async () => {
    for (const raw of ["", "garbage", "[]", "null"]) expect(await runAntigravityApproval(raw)).toBe(ANTIGRAVITY_FALLBACK);
    const out = await runAntigravityApproval(JSON.stringify(RUN), {
      rules: () => NO_RULES, run: (async () => { throw new Error("boom"); }) as never,
    });
    expect(out).toBe(ANTIGRAVITY_FALLBACK);
  });
});

describe("Nomo's own /nomo-* commands never become phone cards", () => {
  const ROOT = "/opt/nomo/plugin";
  const shell = (c: string) => JSON.stringify(payload("run_command", { CommandLine: c }));
  const run = (c: string, paired = true) => {
    let held = false;
    return runAntigravityApproval(shell(c), {
      rules: () => NO_RULES, stopRequested: async () => false, pluginRoot: ROOT,
      hold: { loadConfigFn: async () => (paired ? CONFIG : null) } as never,
      run: (async () => { held = true; }) as never,
    }).then((out) => ({ out, held }));
  };

  test("the safe set auto-approves byte for byte (one trailing newline forgiven), only when paired", async () => {
    for (const key of SAFE_SKILL_COMMANDS) {
      const c = skillCommand(ROOT, key);
      expect([key, await run(c)]).toEqual([key, { out: '{"decision":"auto_approve"}', held: false }]);
      expect((await run(`${c}\n`)).out).toBe('{"decision":"auto_approve"}');
      expect((await run(c, false)).out).toBe(ANTIGRAVITY_FALLBACK); // unpaired: Antigravity's own prompt
    }
    expect([...SAFE_SKILL_COMMANDS].sort()).toEqual(["approvals-on", "approvals-status", "pair", "pair-wait", "reset", "status", "status-verbose"]);
  });

  test("pausing approvals, unpairing and the typed pairing code still ask the phone", async () => {
    for (const key of ["approvals-off", "unpair", "pair-code"]) expect([key, (await run(skillCommand(ROOT, key))).held]).toEqual([key, true]);
  });

  test("near misses go to the phone", async () => {
    const c = skillCommand(ROOT, "status");
    for (const bad of [
      ` ${c}`, `${c} `, `${c}  `, c.replace(" ", "  "), `${c} && rm -rf ~`, `${c}; rm x`, `cd /tmp && ${c}`,
      c.replaceAll("'", '"'), c.replaceAll("'", ""), `${c}\n\n`, `${c}\r\n`, `${c}\nrm x`, `${c} --verbose`,
      skillCommand("/opt/nomo/plugin2", "status"), skillCommand("/opt/nomo", "status"),
    ]) expect([bad, (await run(bad)).held]).toEqual([bad, true]);
  });

  test("a local deny rule still wins over a Nomo command", async () => {
    const out = await runAntigravityApproval(shell(skillCommand(ROOT, "status")), {
      rules: () => ({ allow: [], ask: [], deny: ["command(regex:.*)"] }), stopRequested: async () => false, pluginRoot: ROOT,
      hold: { loadConfigFn: async () => CONFIG } as never,
    });
    expect(out).toBe(ANTIGRAVITY_FALLBACK);
  });
});

describe("antigravity-approve.sh — always exactly one valid decision, exit 0", () => {
  /** A throwaway plugin root: the real wrapper, and a run.sh stub whose body is `script`. */
  async function wrapperWith(script: string, env: Record<string, string> = {}) {
    const t = await tmp();
    const root = join(t, "plugin");
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await cp(join(PLUGIN, "scripts", "antigravity-approve.sh"), join(root, "scripts", "antigravity-approve.sh"));
    await writeFile(join(root, "scripts", "run.sh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const started = Date.now();
    const proc = spawnTestProcess({
      cmd: [join(root, "scripts", "antigravity-approve.sh")],
      env: { ...isolatedTestEnv(join(t, "home")), ...env }, stdin: new Blob([JSON.stringify(RUN)]), stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out, ms: Date.now() - started };
  }

  test("crash / empty / garbage / `{}` / two lines / unknown decision → the fallback", async () => {
    for (const script of [
      "echo noise; echo err >&2; exit 3",
      "exit 0",
      "echo garbage",
      "echo '{}'",
      `echo '{"decision":"auto_approve"}'; echo '{"decision":"auto_approve"}'`,
      `echo '{"decision":"force_ask"}'`,
      `echo '{"decision":"auto_approve","overwrite":{}}'`,
    ]) {
      const r = await wrapperWith(script);
      expect(r.code).toBe(0);
      expect(r.out).toBe(`${ANTIGRAVITY_FALLBACK}\n`);
    }
  });

  test("the three shapes Nomo sends pass through unchanged, and stdin reaches the bundle", async () => {
    for (const line of ['{"decision":"auto_approve"}', '{"decision":"deny","reason":"no \\"thanks\\""}', ANTIGRAVITY_FALLBACK]) {
      const r = await wrapperWith(`cat >/dev/null; printf '%s\\n' '${line}'`);
      expect(r.out).toBe(`${line}\n`);
    }
    const r = await wrapperWith(`grep -q run_command && echo '{"decision":"auto_approve"}'`);
    expect(r.out).toBe('{"decision":"auto_approve"}\n');
  });

  test("a bundle that hangs is killed by the guard → the fallback, well inside the hook timeout", async () => {
    const r = await wrapperWith(`sleep 30; echo '{"decision":"auto_approve"}'`, { NOMO_AGY_GUARD_S: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${ANTIGRAVITY_FALLBACK}\n`);
    expect(r.ms).toBeLessThan(10_000);
  });

  test("TERM/INT/HUP from Antigravity: one fallback line, exit 0, bundle and guard both gone", async () => {
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      const t = await tmp();
      const root = join(t, "plugin");
      await mkdir(join(root, "scripts"), { recursive: true });
      await cp(join(PLUGIN, "scripts", "antigravity-approve.sh"), join(root, "scripts", "antigravity-approve.sh"));
      await writeFile(join(root, "scripts", "run.sh"), `#!/bin/sh\necho $$ > '${t}/bundle.pid'\nexec sleep 30\n`, { mode: 0o755 });
      const proc = spawnTestProcess({
        cmd: [join(root, "scripts", "antigravity-approve.sh")],
        env: isolatedTestEnv(join(t, "home")), stdin: new Blob([JSON.stringify(RUN)]), stdout: "pipe", stderr: "pipe",
      });
      let bundle = 0;
      for (let i = 0; i < 50 && !bundle; i++) {
        await Bun.sleep(50);
        bundle = Number(await readFile(join(t, "bundle.pid"), "utf8").catch(() => "0"));
      }
      const children = execFileSync("pgrep", ["-P", String(proc.pid)], { encoding: "utf8" }).trim().split("\n").map(Number);
      expect(children).toContain(bundle);
      process.kill(proc.pid, sig);
      expect(await new Response(proc.stdout).text()).toBe(`${ANTIGRAVITY_FALLBACK}\n`);
      expect(await proc.exited).toBe(0);
      await Bun.sleep(300);
      for (const pid of children) expect(() => process.kill(pid, 0)).toThrow(); // no orphans
    }
  });

  test("the wrapper SIGKILLed mid-hold (real bundle): the bundle withdraws the card, settles the row working, exits within one poll", async () => {
    const t = await tmp();
    const home = join(t, "home");
    const events: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/v1/cc/event") {
        const b = await req.json() as { op?: string };
        events.push(`event:${b.op}`);
        return Response.json({ ok: true });
      }
      events.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/v1/cc/decision") return Response.json({ hold: true });
      if (u.pathname.startsWith("/v1/cc/decision/") && req.method === "GET") return Response.json({ status: "pending" });
      return Response.json({ ok: true });
    } });
    try {
      const cc = join(home, ".config", "cc-status");
      await mkdir(join(cc, "sessions"), { recursive: true });
      await writeFile(join(cc, "config.json"), JSON.stringify({
        url: `http://127.0.0.1:${server.port}`, pairingId: "p", pcSecret: "s", e2eKeyB64: Buffer.from(KEY).toString("base64url"),
      }), { mode: 0o600 });
      await writeFile(join(cc, "sessions", `${CONV}.json`), JSON.stringify({
        op: "update", prio: 0, lastEvent: "working", ts: Date.now(), agent: "antigravity", pid: 1, sentDone: false,
      }), { mode: 0o600 });
      const proc = spawnTestProcess({
        cmd: [join(PLUGIN, "scripts", "antigravity-approve.sh")],
        env: isolatedTestEnv(home), stdin: new Blob([JSON.stringify(RUN)]), stdout: "pipe", stderr: "pipe",
      });
      for (let i = 0; i < 200 && !events.some((e) => e.startsWith("GET /v1/cc/decision/")); i++) await Bun.sleep(50);
      expect(events).toContain("POST /v1/cc/decision"); // the card is up and polling
      const kids = execFileSync("pgrep", ["-P", String(proc.pid)], { encoding: "utf8" }).trim().split("\n").map(Number);
      process.kill(proc.pid, "SIGKILL"); // no trap runs
      const killedAt = Date.now();
      for (let i = 0; i < 160 && !events.includes("POST /v1/cc/decision/resolve"); i++) await Bun.sleep(50);
      expect(events).toContain("POST /v1/cc/decision/resolve");
      expect(events).not.toContain("event:done"); // a cancelled tool is not a finished turn
      for (let i = 0; i < 40; i++) {
        const r = JSON.parse(await readFile(join(cc, "sessions", `${CONV}.json`), "utf8"));
        if (r.lastEvent === "working" && r.prio === 0) break;
        await Bun.sleep(50);
      }
      expect(JSON.parse(await readFile(join(cc, "sessions", `${CONV}.json`), "utf8"))).toMatchObject({ lastEvent: "working", prio: 0 });
      for (let i = 0; i < 40 && kids.some((k) => { try { process.kill(k, 0); return true; } catch { return false; } }); i++) await Bun.sleep(100);
      for (const k of kids) expect(() => process.kill(k, 0)).toThrow(); // bundle exited, guard too
      expect(Date.now() - killedAt).toBeLessThan(8_000); // one ~3 s poll + the withdraw + the done POST
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("the real bundle, unpaired (temp HOME) → the fallback", async () => {
    const t = await tmp();
    const proc = spawnTestProcess({
      cmd: [join(PLUGIN, "scripts", "antigravity-approve.sh")],
      env: isolatedTestEnv(join(t, "home")), stdin: new Blob([JSON.stringify(RUN)]), stdout: "pipe", stderr: "pipe",
    });
    expect(await new Response(proc.stdout).text()).toBe(`${ANTIGRAVITY_FALLBACK}\n`);
    expect(await proc.exited).toBe(0);
  });
});
