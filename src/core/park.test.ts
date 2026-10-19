import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPark, MOVING_STALE_MS, parkHook, readPark, writePark } from "./park";

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
    expect(reason(parkHook(prompt("hello"), dir))).toEqual({ decision: "block", reason: "Moving to the cloud after this turn… (/nomo-cc:handoff cancel to stop)" });
    writePark(A, { state: "cloud" }, dir);
    expect(reason(parkHook(prompt("hello"), dir))).toEqual({ decision: "block", reason: "This session is in the cloud — /nomo-cc:back to bring it home" });
    expect(statSync(join(dir, A)).mode & 0o777).toBe(0o600);
  });

  test("slash commands pass through", () => {
    const dir = tmp();
    writePark(A, { state: "cloud" }, dir);
    expect(parkHook(prompt("/nomo-cc:back"), dir)).toBeUndefined();
    expect(parkHook(prompt("  /nomo-cc:handoff cancel"), dir)).toBeUndefined();
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

  test("landing installs the staged box copy at turn end; one reminder, then the window is free", () => {
    const dir = tmp(), proj = tmp(), target = join(proj, `${A}.jsonl`), staged = `${target}.nomo-back`;
    writeFileSync(target, "mac\n");
    writeFileSync(staged, "box\n");
    writePark(A, { state: "landing", staged, target, resume: A }, dir);
    expect(reason(parkHook(prompt("hi"), dir))?.reason).toContain(`/resume ${A}`);
    expect(readFileSync(target, "utf8")).toBe("mac\n"); // never mid-turn
    parkHook({ session_id: A, hook_event_name: "Stop" }, dir);
    expect(readFileSync(target, "utf8")).toBe("box\n");
    expect(existsSync(staged)).toBe(false);
    expect(readPark(A, dir)?.state).toBe("back");
    expect(reason(parkHook(prompt("hi"), dir))?.reason).toBe(`Back. Type /resume ${A} to continue here.`);
    expect(parkHook(prompt("hi"), dir)).toBeUndefined();
  });

  test("/resume clears the back reminder; a failed install unparks", () => {
    const dir = tmp();
    writePark(A, { state: "back" }, dir);
    parkHook({ session_id: A, hook_event_name: "SessionStart", source: "resume" }, dir);
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
    expect(JSON.parse(r.stdout.trim())).toEqual({ decision: "block", reason: "This session is in the cloud — /nomo-cc:back to bring it home" });
    expect(run(home, prompt("/nomo-cc:back")).stdout).toBe("");
  });
});
