import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endMovingTurn, readMoveResult, writeMoveResult } from "./park";
import { backLockHolder, clearPark, cloudActive, cloudState, MOVING_STALE_MS, parkHook, parkWantsCommands, readPark, releaseBackLock, stageLanding, takeBackLock, withParked, writePark } from "./park";

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

  test("a phone-started back (-1): an idle window installs now, even with no turn stamped (handoff-later's marker)", () => {
    const { dir, target, l } = setup();
    writePark(A, { state: "cloud", pid: process.pid }, dir); // no turnEndedAt/turnStartedAt at all
    expect(stageLanding(A, l, -1, dir, () => true)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("box\n");
    expect(reason(parkHook(prompt("hi"), dir))?.reason).toBe(`Back. Type /resume ${A} to continue here.`);
  });

  test("a phone-started back (-1) defers while a /nomo-cc: turn is open, then lands at its Stop", async () => {
    const { dir, target, l } = setup();
    parkHook({ session_id: A, hook_event_name: "Stop" }, dir);
    await wait();
    parkHook(prompt("/nomo-cc:status"), dir); // open turn
    expect(stageLanding(A, l, -1, dir, () => true)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("mac\n");
    parkHook({ session_id: A, hook_event_name: "Stop" }, dir);
    expect(readPark(A, dir)?.state).toBe("back");
    expect(readFileSync(target, "utf8")).toBe("box\n");
  });

  test("the window is gone: installed now", () => {
    const { dir, target, l } = setup();
    expect(stageLanding(A, l, Date.now(), dir, () => false)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("box\n");
  });
});

describe("bring back state (NOM-93)", () => {
  test("cloudState covers every marker and back outcome", () => {
    expect(cloudState(undefined)).toBeUndefined();
    expect(cloudState({ state: "moving", since: 0 })).toBe("moving");
    expect(cloudState({ state: "cloud", since: 0 })).toBe("cloud");
    expect(cloudState({ state: "cloud", since: 0 }, { running: true })).toBe("returning");
    expect(cloudState({ state: "cloud", since: 0 }, { running: false, code: 1 })).toBe("failed");
    expect(cloudState({ state: "cloud", since: 0 }, { running: false, code: null })).toBe("failed");
    expect(cloudState({ state: "cloud", since: 0 }, { running: false, code: 0 })).toBe("cloud");
    expect(cloudState({ state: "landing", since: 0 })).toBe("returning");
    expect(cloudState({ state: "back", since: 0 })).toBe("back");
    expect(cloudState({ state: "elsewhere", since: 0 })).toBeUndefined();
  });

  test("the long-poll stays up for moving/cloud/landing only", () => {
    expect(["moving", "cloud", "landing", "back", "elsewhere"].map((state) => parkWantsCommands({ state, since: 0 } as any)))
      .toEqual([true, true, true, false, false]);
    expect(parkWantsCommands(undefined)).toBe(false);
  });

  test("cloudActive reads active, and a legacy current", () => {
    const f = join(tmp(), "cloud.json");
    expect(cloudActive(A, f)).toBe(false);
    writeFileSync(f, JSON.stringify({ active: [A] }));
    expect(cloudActive(A, f)).toBe(true);
    writeFileSync(f, JSON.stringify({ current: A }));
    expect(cloudActive(A, f)).toBe(true);
    writeFileSync(f, JSON.stringify({ active: [] }));
    expect(cloudActive(A, f)).toBe(false);
  });
});

describe("one back at a time + the parked flag (NOM-93)", () => {
  test("a held lock blocks a second back; a dead holder's lock is taken over; release frees it", () => {
    const dir = tmp();
    expect(takeBackLock(A, dir, () => true)).toBe(true);
    expect(backLockHolder(A, dir, () => true)).toBe(process.pid);
    expect(takeBackLock(A, dir, () => true)).toBe(false); // concurrent back refused
    expect(cloudState({ state: "cloud", since: 0 }, undefined, true)).toBe("returning");
    expect(takeBackLock(A, dir, () => false)).toBe(true); // holder dead → taken over
    releaseBackLock(A, dir);
    expect(backLockHolder(A, dir, () => true)).toBeUndefined();
    writeFileSync(join(dir, `${A.slice(0, 12)}.lock`), "999999");
    releaseBackLock(A, dir); // never releases someone else's
    expect(backLockHolder(A, dir, () => true)).toBe(999999);
  });

  test("`parked` is on the body iff a cloud/landing/back marker exists (never moving)", () => {
    const dir = tmp();
    const body = { v: 2, sessionId: A, op: "done" };
    expect(withParked(body, dir)).toEqual(body);
    writePark(A, { state: "moving" }, dir);
    expect(withParked(body, dir)).toEqual(body); // the last turn is still running on the Mac
    for (const state of ["cloud", "landing", "back"] as const) {
      writePark(A, { state }, dir);
      expect(withParked(body, dir)).toEqual({ ...body, parked: true });
    }
    writePark(A, { state: "elsewhere" }, dir);
    expect(withParked(body, dir)).toEqual(body);
    clearPark(A, dir);
    expect(withParked(body, dir)).toEqual(body);
    expect(withParked({ v: 2, sessionId: "codex-pid-1" }, dir)).toEqual({ v: 2, sessionId: "codex-pid-1" });
  });
});

describe("move-failed (NOM-94)", () => {
  test("only with no marker; any marker wins; never sets `parked`", () => {
    expect(cloudState(undefined, undefined, false, true)).toBe("move-failed");
    expect(cloudState(undefined, undefined, false, false)).toBeUndefined();
    expect(cloudState({ state: "moving", since: 0 }, undefined, false, true)).toBe("moving");
    expect(cloudState({ state: "cloud", since: 0 }, undefined, false, true)).toBe("cloud");
    const dir = tmp();
    const body = { v: 2, sessionId: A, op: "done" };
    expect(withParked(body, dir)).toEqual(body); // a failed move leaves no marker → no parked flag
  });
});

describe("turn end without a Stop + per-session move outcome (NOM-94)", () => {
  test("endMovingTurn stamps only a moving marker, once", () => {
    const dir = tmp();
    endMovingTurn(A, dir);
    expect(readPark(A, dir)).toBeUndefined(); // never creates one
    writePark(A, { state: "cloud" }, dir);
    endMovingTurn(A, dir);
    expect(readPark(A, dir)?.turnEndedAt).toBeUndefined();
    writePark(A, { state: "moving", turnEndedAt: 5 }, dir);
    endMovingTurn(A, dir);
    expect(readPark(A, dir)?.turnEndedAt).toBe(5);
    writePark(A, { state: "moving" }, dir);
    endMovingTurn(A, dir);
    expect(readPark(A, dir)?.turnEndedAt).toBeGreaterThan(5);
  });

  test("a move outcome counts only for its session and only if written since the run started", () => {
    const dir = tmp();
    expect(readMoveResult(A, 0, dir)).toBeUndefined();
    writeMoveResult(A, false, dir);
    expect(readMoveResult(A, 0, dir)).toBe("failed");
    expect(readMoveResult("9f8e7d6c-1111-4222-8333-444455556666", 0, dir)).toBeUndefined();
    expect(readMoveResult(A, Date.now() + 60_000, dir)).toBeUndefined(); // an older run's
    writeMoveResult(A, true, dir);
    expect(readMoveResult(A, 0, dir)).toBe("done");
  });
});

import { cloudAge, CLOUD_EXPIRING_MS, readBackResult, readMoveWhy, writeBackResult } from "./park";

describe("NOM-99 result files and states", () => {
  const A = "0a1b2c3d-1111-4222-8333-444455556666";
  const dir = () => mkdtempSync(join(tmpdir(), "nomo-res-"));

  test(".back: persisted, and an older run's file never counts", () => {
    const d = dir();
    expect(readBackResult(A, 0, d)).toBeUndefined();
    writeBackResult(A, "failed", d);
    expect(readBackResult(A, 0, d)).toBe("failed");
    expect(readBackResult(A, Date.now() + 60_000, d)).toBeUndefined();
    writeBackResult(A, "gone", d);
    expect(readBackResult(A, 0, d)).toBe("gone");
  });

  test(".move carries a reason code; DONE or a stale file has none", () => {
    const d = dir();
    writeMoveResult(A, false, d, "secret");
    expect(readMoveResult(A, 0, d)).toBe("failed");
    expect(readMoveWhy(A, 0, d)).toBe("secret");
    writeMoveResult(A, false, d, "transcriptSecret"); // NOM-103: its own code, round-trips
    expect(readMoveWhy(A, 0, d)).toBe("transcriptSecret");
    expect(readMoveWhy(A, Date.now() + 60_000, d)).toBeUndefined();
    writeMoveResult(A, false, d);
    expect(readMoveWhy(A, 0, d)).toBe("other");
    writeMoveResult(A, true, d);
    expect(readMoveWhy(A, 0, d)).toBeUndefined();
  });

  test("cloudState: a persisted failed back reads failed while parked; gone reads box-gone unparked", () => {
    expect(cloudState({ state: "cloud", since: 0 }, undefined, false, false, "failed")).toBe("failed");
    expect(cloudState({ state: "cloud", since: 0 }, { running: true }, false, false, "failed")).toBe("returning");
    expect(cloudState(undefined, undefined, false, false, "gone")).toBe("box-gone");
    expect(cloudState(undefined, undefined, false, true, "gone")).toBe("move-failed");
    expect(cloudState(undefined, undefined, false, false, "done")).toBeUndefined();
  });

  test("cloudAge: expiring from 13 days in the cloud, only for a cloud marker", () => {
    const now = 100 * CLOUD_EXPIRING_MS;
    expect(cloudAge({ state: "cloud", since: now - CLOUD_EXPIRING_MS }, now)).toBe("expiring");
    expect(cloudAge({ state: "cloud", since: now - CLOUD_EXPIRING_MS + 1 }, now)).toBeUndefined();
    expect(cloudAge({ state: "moving", since: 0 }, now)).toBeUndefined();
    expect(cloudAge(undefined, now)).toBeUndefined();
  });
});
