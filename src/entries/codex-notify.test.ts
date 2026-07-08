import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { b64url, decryptBlob } from "../core/crypto";
import { notifyFallbackTitle, synthStopInput } from "./codex-notify";

// Codex runs the `notify` program with ONE trailing JSON arg on turn completion. The verified payload
// (codex-cli 0.142.5 binary strings, legacy_notify path) is:
//   {"type":"agent-turn-complete","thread-id":…,"turn-id":…,"cwd":…,"client":…,
//    "input-messages":[…],"last-assistant-message":…}
// synthStopInput maps that hyphenated shape onto the runHook/planOp Stop-hook input shape.
describe("synthStopInput (notify payload → synthesized Stop hook input)", () => {
  const payload = (over: Record<string, unknown> = {}) => JSON.stringify({
    type: "agent-turn-complete", "thread-id": "th-1", "turn-id": "tu-1", cwd: "/x/api-status",
    "input-messages": ["fix the bug"], "last-assistant-message": "done", ...over,
  });

  test("maps thread-id → session_id and synthesizes a Stop hook", () => {
    expect(synthStopInput(payload())).toMatchObject({
      session_id: "th-1", hook_event_name: "Stop", cwd: "/x/api-status",
      turn_id: "tu-1", last_assistant_message: "done",
    });
    expect(synthStopInput(payload())?.["input-messages"]).toEqual(["fix the bug"]);
  });
  test("ignores non agent-turn-complete payloads", () => {
    expect(synthStopInput(payload({ type: "agent-turn-start" }))).toBeNull();
    expect(synthStopInput(payload({ type: undefined }))).toBeNull();
  });
  test("null on a missing/empty thread-id or bad JSON", () => {
    expect(synthStopInput(payload({ "thread-id": "" }))).toBeNull();
    expect(synthStopInput(payload({ "thread-id": undefined }))).toBeNull();
    expect(synthStopInput("not json")).toBeNull();
    expect(synthStopInput("")).toBeNull();
  });
});

describe("notifyFallbackTitle (first user input-message, cleaned)", () => {
  test("takes the first usable string, cleaning markdown", () => {
    expect(notifyFallbackTitle(["**refactor** the parser"])).toBe("refactor the parser");
  });
  test("skips command-UI (<…>) and skill/plugin ([$…/[@…) artifacts", () => {
    expect(notifyFallbackTitle(["<local-command>", "[@nomo-cc](x) pair", "real ask"])).toBe("real ask");
  });
  test("undefined when nothing usable / not an array", () => {
    expect(notifyFallbackTitle([])).toBeUndefined();
    expect(notifyFallbackTitle(["<cmd>"])).toBeUndefined();
    expect(notifyFallbackTitle(undefined)).toBeUndefined();
    expect(notifyFallbackTitle([{ role: "user" }])).toBeUndefined();
  });
});

// --- runNotify E2E (spawn the real entry with the payload as its LAST argv, isolated HOME) --------
//
// Faithful exercise of the argv-not-stdin contract + the dedupe rule + the record/blob write. Mirrors
// cc-status.test.ts's runClaudeEntry harness, but the payload rides in argv (as codex's notify does),
// not on stdin.
describe("runNotify E2E (argv payload, dedupe against a sent Stop)", () => {
  const rawKey = new Uint8Array(32).fill(9);
  const entry = join(import.meta.dir, "codex-notify.ts");

  async function runNotifyEntry(payloadJson: string, opts: {
    seedRecord?: Record<string, unknown>; sessionIndex?: string; codexHome?: string;
    // Deferral window (ms) the spawned entry honors via NOMO_NOTIFY_DEFER_MS. Default "0" so the
    // common cases don't pay the real 3-second wait; the deferral-race test sets a positive window.
    deferMs?: string;
    // Runs concurrently WHILE the entry is deferring: gets the session-record path so a test can
    // simulate the Stop hook winning the race (writing sentDone:true mid-wait).
    duringWait?: (recordPath: string) => Promise<void>;
  } = {}): Promise<{ record?: Record<string, unknown>; blob?: Record<string, unknown>; sent: boolean }> {
    const home = await mkdtemp(join(tmpdir(), "codex-notify-"));
    try {
      const ccDir = join(home, ".config", "cc-status");
      await mkdir(join(ccDir, "sessions"), { recursive: true });
      await writeFile(join(ccDir, "config.json"), JSON.stringify({
        url: "http://127.0.0.1:9", pairingId: "p", pcSecret: "s", e2eKeyB64: b64url(rawKey),
      }));
      // Pre-seed a LIVE watchdog pidfile (this test process) so ensureWatchdog() no-ops.
      await writeFile(join(ccDir, "watchdog.pid"), String(process.pid));

      const sid = (JSON.parse(payloadJson) as Record<string, unknown>)["thread-id"] as string;
      const recordPath = join(ccDir, "sessions", `${sid}.json`);
      if (opts.seedRecord) {
        await writeFile(recordPath, JSON.stringify(opts.seedRecord));
      }
      const env: Record<string, string> = { ...process.env, HOME: home, NOMO_NOTIFY_DEFER_MS: opts.deferMs ?? "0" };
      if (opts.codexHome) {
        await mkdir(opts.codexHome, { recursive: true });
        if (opts.sessionIndex) await writeFile(join(opts.codexHome, "session_index.jsonl"), opts.sessionIndex);
        env.CODEX_HOME = opts.codexHome;
      }

      const proc = Bun.spawn({
        cmd: ["bun", entry, payloadJson], // payload as the LAST argv — codex's notify contract
        env, stdout: "ignore", stderr: "ignore",
      });
      if (opts.duringWait) await opts.duringWait(recordPath);
      await proc.exited;

      let record: Record<string, unknown> | undefined;
      try { record = JSON.parse(await readFile(join(ccDir, "sessions", `${sid}.json`), "utf8")); } catch { /* none */ }
      let blob: Record<string, unknown> | undefined;
      if (record?.blob) {
        try { blob = (await decryptBlob(rawKey, record.blob as string)) as Record<string, unknown>; } catch { /* a seeded non-blob (dedupe test) */ }
      }
      let sent = false;
      try { await readFile(join(ccDir, "last-send"), "utf8"); sent = true; } catch { /* POST fails on discard port */ }
      return { record, blob, sent };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  const payload = JSON.stringify({
    type: "agent-turn-complete", "thread-id": "th-e2e", "turn-id": "tu-1", cwd: "/x/api-status",
    "input-messages": ["make the widget faster"], "last-assistant-message": "done",
  });

  test("no record (hooks never fired) → best-effort done written, agent codex, title from input-messages", async () => {
    const { record, blob } = await runNotifyEntry(payload);
    expect(record?.sentDone).toBe(true);
    expect(record?.op).toBe("done");
    expect(record?.agent).toBe("codex");
    expect(blob).toMatchObject({ status: "done", agent: "codex", title: "make the widget faster" });
  }, 20000);

  test("dedupe: a record already showing a sent Stop is left untouched (no double-send)", async () => {
    const seed = {
      pid: process.ppid, machine: "mac", label: "SENTINEL", ts: 111, transcript: "",
      lastEvent: "done", sentDone: true, op: "done", prio: 0, blob: "PRESEEDED", agent: "codex",
    };
    const { record } = await runNotifyEntry(payload, { seedRecord: seed });
    // Untouched: the backstop returned before trackSession rewrote anything.
    expect(record?.label).toBe("SENTINEL");
    expect(record?.blob).toBe("PRESEEDED");
    expect(record?.ts).toBe(111);
  }, 20000);

  test("a record mid-work (Stop hook failed, sentDone false) → corrective done IS sent", async () => {
    const seed = {
      pid: process.ppid, machine: "mac", label: "proj", ts: 111, transcript: "",
      lastEvent: "working", sentDone: false, op: "update", prio: 0, blob: "OLD", agent: "codex",
      turnStartedAt: 1_751_900_000,
    };
    const { record, blob } = await runNotifyEntry(payload, { seedRecord: seed });
    expect(record?.sentDone).toBe(true);
    expect(record?.op).toBe("done");
    // The cached turn anchor is threaded through so the island's "done in Xm" stays per-turn.
    expect(blob).toMatchObject({ status: "done", agent: "codex", turnStartedAt: 1_751_900_000 });
  }, 20000);

  test("session_index thread_name is the PRIMARY title (beats input-messages)", async () => {
    const cHome = await mkdtemp(join(tmpdir(), "codex-home-notify-"));
    try {
      const { blob } = await runNotifyEntry(payload, {
        codexHome: cHome,
        sessionIndex: JSON.stringify({ id: "th-e2e", thread_name: "Widget perf work", updated_at: "2026-07-08T00:00:00Z" }),
      });
      expect(blob).toMatchObject({ title: "Widget perf work" });
    } finally {
      await rm(cHome, { recursive: true, force: true });
    }
  }, 20000);

  // --- Fix A: stale-turn guard + deferral backstop -----------------------------------------------

  test("stale-turn: a notify whose turn-id differs from the record's turnId bails (no clobber)", async () => {
    // The record is bound to a NEWER turn (the next UserPromptSubmit re-stamped turnId + reset sentDone).
    // A delayed notify from the OLD turn (payload turn-id tu-1) must not overwrite it with a wrong done.
    const seed = {
      pid: process.ppid, machine: "mac", label: "SENTINEL", ts: 111, transcript: "",
      lastEvent: "working", sentDone: false, op: "update", prio: 0, blob: "NEWTURN", agent: "codex",
      turnId: "tu-999",
    };
    const { record } = await runNotifyEntry(payload, { seedRecord: seed });
    expect(record?.label).toBe("SENTINEL"); // untouched — the backstop bailed before trackSession
    expect(record?.blob).toBe("NEWTURN");
    expect(record?.sentDone).toBe(false);
    expect(record?.turnId).toBe("tu-999");
  }, 20000);

  test("deferral: a Stop-hook write landing DURING the wait makes notify bail (hook won the race)", async () => {
    // Seed a same-turn mid-work record (sentDone:false), open a real deferral window, and simulate the
    // Stop hook winning it: write sentDone:true partway through. On re-read notify must bail, untouched.
    const seed = {
      pid: process.ppid, machine: "mac", label: "PREHOOK", ts: 111, transcript: "",
      lastEvent: "working", sentDone: false, op: "update", prio: 0, blob: "OLD", agent: "codex", turnId: "tu-1",
    };
    const { record } = await runNotifyEntry(payload, {
      seedRecord: seed, deferMs: "2500",
      duringWait: async (recordPath) => {
        await new Promise((r) => setTimeout(r, 700)); // let the entry read (sentDone:false) + start waiting
        await writeFile(recordPath, JSON.stringify({ ...seed, label: "STOPHOOK", sentDone: true, op: "done", blob: "HOOKDONE" }));
      },
    });
    // The entry re-read after its wait, saw sentDone:true, and returned without a second trackSession.
    expect(record?.label).toBe("STOPHOOK");
    expect(record?.blob).toBe("HOOKDONE");
  }, 20000);

  test("deferral: record stays sentDone:false / same turn through the wait → notify DOES send (turnId persisted)", async () => {
    const seed = {
      pid: process.ppid, machine: "mac", label: "proj", ts: 111, transcript: "",
      lastEvent: "working", sentDone: false, op: "update", prio: 0, blob: "OLD", agent: "codex", turnId: "tu-1",
    };
    const { record, blob } = await runNotifyEntry(payload, { seedRecord: seed, deferMs: "150" });
    expect(record?.sentDone).toBe(true);
    expect(record?.op).toBe("done");
    expect(record?.turnId).toBe("tu-1"); // the backstop's done carries the turn it belongs to
    expect(blob).toMatchObject({ status: "done", agent: "codex" });
  }, 20000);

  test("no record survives the wait (hooks truly dead) → best-effort done still sent", async () => {
    const { record } = await runNotifyEntry(payload, { deferMs: "150" });
    expect(record?.sentDone).toBe(true);
    expect(record?.op).toBe("done");
    expect(record?.turnId).toBe("tu-1");
  }, 20000);
});
