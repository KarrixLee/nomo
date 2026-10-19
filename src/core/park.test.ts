import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPark, MOVING_STALE_MS, parkHook, readPark, stageLanding, writePark } from "./park";

const A = "0a1b2c3d-1111-4222-8333-444455556666";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "nomo-park-")); dirs.push(d); return d; };
const prompt = (text: string) => ({ session_id: A, hook_event_name: "UserPromptSubmit", prompt: text });
const reason = (line: string | undefined) => (line ? JSON.parse(line) : undefined);

describe("park gate", () => {
  test("no marker: nothing blocked", () => {
    expect(parkHook(prompt("hello"), tmp())).toBeUndefined();
  });

  test("moving and cloud block plain prompts with their reason", () => {
    const dir = tmp();
    writePark(A, { state: "moving" }, dir);
    expect(reason(parkHook(prompt("hello"), dir))).toEqual({ decision: "block", reason: "Moving to the cloud after this turn…" });
    writePark(A, { state: "cloud" }, dir);
    expect(reason(parkHook(prompt("hello"), dir))?.reason).toContain("/nomo-cc:handoff cancel to unpark here");
    expect(statSync(join(dir, A)).mode & 0o777).toBe(0o600);
  });

  test("only Nomo's own commands pass; other slash commands, skills and path prompts are blocked", () => {
    const dir = tmp();
    writePark(A, { state: "cloud" }, dir);
    expect(parkHook(prompt("/nomo-cc:back"), dir)).toBeUndefined();
    expect(parkHook(prompt("  /nomo-cc:handoff cancel"), dir)).toBeUndefined();
    expect(reason(parkHook(prompt("/my-skill do things"), dir))?.decision).toBe("block");
    expect(reason(parkHook(prompt("/Users/x/a.ts is broken"), dir))?.decision).toBe("block");
    expect(reason(parkHook(prompt("/nomo-ccx"), dir))?.decision).toBe("block");
  });

  test("fails open: a torn marker, a bad id, a missing prompt", () => {
    const dir = tmp();
    writeFileSync(join(dir, A), "{not json");
    expect(parkHook(prompt("hello"), dir)).toBeUndefined();
    expect(parkHook({ session_id: "../etc", hook_event_name: "UserPromptSubmit", prompt: "x" }, dir)).toBeUndefined();
    expect(parkHook({ hook_event_name: "UserPromptSubmit" }, dir)).toBeUndefined();
    expect(parkHook(prompt("hello"), join(dir, "nope", "deeper"))).toBeUndefined();
  });

  test("a moving marker its helper never cleared expires instead of blocking forever", () => {
    const dir = tmp();
    writePark(A, { state: "moving", since: Date.now() - MOVING_STALE_MS - 1 }, dir);
    expect(parkHook(prompt("hello"), dir)).toBeUndefined();
    expect(existsSync(join(dir, A))).toBe(false);
  });

  test("Stop stamps the turn end on a moving marker (the helper's trigger), once", () => {
    const dir = tmp();
    writePark(A, { state: "moving" }, dir);
    parkHook({ session_id: A, hook_event_name: "PreToolUse" }, dir);
    expect(readPark(A, dir)?.turnEndedAt).toBeUndefined();
    parkHook({ session_id: A, hook_event_name: "Stop" }, dir);
    const t = readPark(A, dir)?.turnEndedAt;
    expect(t).toBeNumber();
    parkHook({ session_id: A, hook_event_name: "Stop" }, dir);
    expect(readPark(A, dir)?.turnEndedAt).toBe(t);
    expect(readPark(A, dir)?.state).toBe("moving");
  });

  test("landing installs the staged box copy at turn end; Back blocks until /resume", () => {
    const dir = tmp(), proj = tmp(), target = join(proj, `${A}.jsonl`), staged = `${target}.nomo-back`;
    writeFileSync(target, "mac\n");
    writeFileSync(staged, "box\n");
    writePark(A, { state: "landing", staged, target, resume: A }, dir);
    parkHook({ session_id: A, hook_event_name: "PostToolUse" }, dir);
    parkHook({ session_id: A, hook_event_name: "SessionStart", source: "resume" }, dir);
    expect(readFileSync(target, "utf8")).toBe("mac\n"); // never mid-turn, never under a (re)starting session
    parkHook({ session_id: A, hook_event_name: "Stop" }, dir);
    expect(readFileSync(target, "utf8")).toBe("box\n");
    expect(existsSync(staged)).toBe(false);
    expect(readPark(A, dir)?.state).toBe("back");
    expect(reason(parkHook(prompt("hi"), dir))?.reason).toBe(`Back. Type /resume ${A} to continue here.`);
    expect(reason(parkHook(prompt("hi"), dir))?.decision).toBe("block");
    parkHook({ session_id: A, hook_event_name: "SessionStart", source: "resume" }, dir);
    expect(parkHook(prompt("hi"), dir)).toBeUndefined();
  });

  test("/resume clears the back reminder; a failed install unparks", () => {
    const dir = tmp();
    writePark(A, { state: "back" }, dir);
    parkHook({ session_id: A, hook_event_name: "SessionStart", source: "resume" }, dir);
    expect(readPark(A, dir)).toBeUndefined();
    writePark(A, { state: "back" }, dir);
    parkHook({ session_id: A, hook_event_name: "SessionEnd" }, dir);
    expect(readPark(A, dir)).toBeUndefined();
    writePark(A, { state: "back", pid: 2 ** 22 + 12345 }, dir); // its window died
    expect(parkHook(prompt("hi"), dir)).toBeUndefined();
    expect(readPark(A, dir)).toBeUndefined();
    writePark(A, { state: "landing", staged: join(dir, "gone"), target: join(dir, "t") }, dir);
    parkHook({ session_id: A, hook_event_name: "Stop" }, dir);
    expect(readPark(A, dir)).toBeUndefined();
    clearPark(A, dir); // idempotent
  });
});

describe("park gate in the real hook entry", () => {
  const run = (home: string, input: object) => spawnSync(process.execPath, [join(import.meta.dir, "../entries/cc-status.ts")], {
    input: JSON.stringify(input), env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20_000,
  });

  test("blocks a plain prompt via stdout JSON (exit 0), passes a slash command, silent without a marker", () => {
    const home = tmp();
    expect(run(home, prompt("hello")).stdout).toBe("");
    mkdirSync(join(home, ".config", "cc-status", "parked"), { recursive: true });
    writeFileSync(join(home, ".config", "cc-status", "parked", A), JSON.stringify({ state: "cloud", since: Date.now() }));
    const r = run(home, prompt("hello"));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ decision: "block", reason: "This session is in the cloud — /nomo-cc:back to bring it home, or /nomo-cc:handoff cancel to unpark here" });
    expect(run(home, prompt("/nomo-cc:back")).stdout).toBe("");
  });
});

describe("interrupted back and the other window", () => {
  test("landing at a prompt (the back turn was interrupted): blocked, nothing installed", () => {
    const dir = tmp(), target = join(dir, "t.jsonl"), staged = `${target}.nomo-back`;
    writeFileSync(target, "mac\n");
    writeFileSync(staged, "box\n");
    writePark(A, { state: "landing", staged, target, resume: A }, dir);
    expect(reason(parkHook(prompt("hi"), dir))?.reason).toBe("Bringing back was interrupted — run /nomo-cc:back again");
    expect(parkHook(prompt("/nomo-cc:back"), dir)).toBeUndefined();
    expect(readFileSync(target, "utf8")).toBe("mac\n");
    expect(readPark(A, dir)?.state).toBe("landing");
  });

  test("elsewhere blocks only the window it names, and unparks once that window is gone", () => {
    const dir = tmp();
    writePark(A, { state: "elsewhere", pid: process.ppid }, dir); // this test runs under that pid
    expect(reason(parkHook(prompt("hi"), dir))?.reason).toBe("This session was brought back in another window — close this one (/exit)");
    writePark(A, { state: "elsewhere", pid: process.pid }, dir); // alive, but not an ancestor: the new window
    expect(parkHook(prompt("hi"), dir)).toBeUndefined();
    expect(readPark(A, dir)?.state).toBe("elsewhere");
    writePark(A, { state: "elsewhere", pid: 2 ** 22 + 12345 }, dir); // dead
    expect(parkHook(prompt("hi"), dir)).toBeUndefined();
    expect(readPark(A, dir)).toBeUndefined();
    writePark(A, { state: "elsewhere", pid: process.ppid }, dir);
    parkHook({ session_id: A, hook_event_name: "SessionEnd" }, dir);
    expect(readPark(A, dir)).toBeUndefined();
  });
});

describe("background --back finishing in the parked window", () => {
  const setup = () => {
    const dir = tmp(), target = join(dir, "t.jsonl"), staged = `${target}.nomo-back`;
    writeFileSync(target, "mac\n");
    writeFileSync(staged, "box\n");
    writePark(A, { state: "cloud", pid: process.pid }, dir);
    return { dir, target, staged, l: { staged, target, resume: A } };
  };
  const wait = () => Bun.sleep(3);

  test("its turn already ended (background Bash): installed now, and the re-entry sees Back", async () => {
    const { dir, target, l } = setup();
    parkHook(prompt("/nomo-cc:back"), dir);
    await wait();
    const runStartedAt = Date.now();
    await wait();
    parkHook({ session_id: A, hook_event_name: "Stop" }, dir); // seconds after launch
    expect(stageLanding(A, l, runStartedAt, dir, () => true)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("box\n");
    expect(readPark(A, dir)?.state).toBe("back");
    expect(reason(parkHook(prompt("<task-notification>done</task-notification>"), dir))?.reason).toBe(`Back. Type /resume ${A} to continue here.`);
    expect(reason(parkHook(prompt("fix the bug"), dir))?.decision).toBe("block"); // the re-entry did not use it up
    expect(readPark(A, dir)).toMatchObject({ state: "back", pid: process.pid });
  });

  test("a hook stamp never downgrades a state written meanwhile", () => {
    const { dir, l } = setup();
    stageLanding(A, l, Date.now() + 60_000, dir, () => true); // not idle: stays landing
    parkHook(prompt("/nomo-cc:status"), dir);
    expect(readPark(A, dir)?.state).toBe("landing");
    expect(readPark(A, dir)?.turnStartedAt).toBeNumber();
  });

  test("a turn still running (foreground, or a later /nomo-cc: command): deferred to its Stop", async () => {
    const { dir, target, l } = setup();
    parkHook({ session_id: A, hook_event_name: "Stop" }, dir); // an older turn
    await wait();
    const runStartedAt = Date.now();
    expect(stageLanding(A, l, runStartedAt, dir, () => true)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("mac\n");
    expect(readPark(A, dir)?.state).toBe("landing");
    parkHook({ session_id: A, hook_event_name: "Stop" }, dir);
    expect(readFileSync(target, "utf8")).toBe("box\n");
    expect(readPark(A, dir)?.state).toBe("back");

    const b = setup();
    const t0 = Date.now();
    await wait();
    parkHook({ session_id: A, hook_event_name: "Stop" }, b.dir);
    await wait();
    parkHook(prompt("/nomo-cc:status"), b.dir); // a newer turn is open
    expect(stageLanding(A, b.l, t0, b.dir, () => true)).toBe(false);
  });

  test("the window is gone: installed now", () => {
    const { dir, target, l } = setup();
    expect(stageLanding(A, l, Date.now(), dir, () => false)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("box\n");
  });
});
