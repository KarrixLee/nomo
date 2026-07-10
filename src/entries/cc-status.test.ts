import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { b64url, decryptBlob } from "../core/crypto";
import { parseConfig, PendingEventStash, readRecord, SessionRecord, SESSIONS_DIR } from "../core/shared";
import {
  aiTitle, buildBlob, buildEnvelope, buildPendingStash, cleanPromptTitle, codexIndexTitle, codexSessionTitle,
  codexThreadName, detailForHook, firstUserPrompt, isPermissionNotification, planOp, sessionTitle,
  stashPendingEvent, trackSession, transcriptStartMs,
} from "./cc-status";
import { provisionalsCoveredByReal, reconcileProvisionalsSweep } from "./cc-watchdog";
import { hooksAppearStale, parseCodexPluginState, statusCmd } from "./status-cmd";

// A fixed 32-byte test key; the real one is HKDF-derived, but any 32 bytes exercise the round-trip.
const KEY = new Uint8Array(32).fill(7);

describe("planOp (op mapping table)", () => {
  const i = (over: Record<string, unknown> = {}) => ({ session_id: "s", cwd: "/x", ...over });

  test("SessionStart → start / prio 0 / working (fresh session)", () => {
    expect(planOp("SessionStart", i(), false)).toEqual({ op: "start", prio: 0, status: "working" });
  });
  test("UserPromptSubmit / PreToolUse / PostToolUse → update / prio 0 / working", () => {
    for (const h of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
      expect(planOp(h, i(), false)).toEqual({ op: "update", prio: 0, status: "working" });
    }
  });
  test("PermissionRequest → update / prio 1 / needsAttention", () => {
    expect(planOp("PermissionRequest", i(), false)).toEqual({ op: "update", prio: 1, status: "needsAttention" });
  });
  test("a permission Notification → update / prio 1 / needsAttention; the idle nudge is dropped", () => {
    expect(planOp("Notification", i({ notification_type: "permission_prompt" }), false))
      .toEqual({ op: "update", prio: 1, status: "needsAttention" });
    expect(planOp("Notification", i({ message: "Claude is waiting for your input" }), false)).toBeNull();
  });
  test("Stop → done / prio 0 / done", () => {
    expect(planOp("Stop", i(), false)).toEqual({ op: "done", prio: 0, status: "done" });
  });
  test("SessionEnd → end / prio 0", () => {
    expect(planOp("SessionEnd", i(), false)).toMatchObject({ op: "end", prio: 0 });
  });
  test("unknown hooks are ignored", () => {
    expect(planOp("PreCompact", i(), false)).toBeNull();
    expect(planOp("", i(), false)).toBeNull();
  });

  // --- re-arm-after-done ---------------------------------------------------------------------
  test("a SessionStart AFTER a done re-arms as a fresh working update (not a start)", () => {
    expect(planOp("SessionStart", i(), true)).toEqual({ op: "update", prio: 0, status: "working" });
  });
  test("update-mapped hooks after a done are already `update` (they clear sentDone regardless)", () => {
    expect(planOp("UserPromptSubmit", i(), true)).toEqual({ op: "update", prio: 0, status: "working" });
    expect(planOp("PreToolUse", i(), true)).toEqual({ op: "update", prio: 0, status: "working" });
  });
  test("a Stop after a done stays done", () => {
    expect(planOp("Stop", i(), true)).toEqual({ op: "done", prio: 0, status: "done" });
  });
});

// --- Codex CLI parity -------------------------------------------------------------------------
//
// Codex sends the SAME hook_event_name strings and field names (session_id/cwd/tool_name/…) as
// Claude Code, plus extras (turn_id/model/permission_mode). planOp/detail must keep working; the
// only new behavior is the `agent:"codex"` key threaded into the blob and the codex title scanner.
describe("planOp / detail — codex payloads (extra turn_id/model/permission_mode must not break)", () => {
  const ci = (over: Record<string, unknown> = {}) =>
    ({ session_id: "s", cwd: "/x", turn_id: "t1", model: "gpt-5-codex", permission_mode: "default", ...over });

  test("PermissionRequest (codex, no tool_use_id) → update / prio 1 / needsAttention", () => {
    expect(planOp("PermissionRequest", ci({ hook_event_name: "PermissionRequest", tool_name: "apply_patch" }), false))
      .toEqual({ op: "update", prio: 1, status: "needsAttention" });
  });
  test("Stop (codex, carries turn_id/last_assistant_message) → done / prio 0 / done", () => {
    expect(planOp("Stop", ci({ hook_event_name: "Stop", turn_id: "t9", last_assistant_message: "done" }), false))
      .toEqual({ op: "done", prio: 0, status: "done" });
  });
  test("UserPromptSubmit (codex, carries prompt/turn_id) → update / prio 0 / working", () => {
    expect(planOp("UserPromptSubmit", ci({ hook_event_name: "UserPromptSubmit", prompt: "hi", turn_id: "t1" }), false))
      .toEqual({ op: "update", prio: 0, status: "working" });
  });
  test("codex native tool_name values map to the shared detail keys (merged map covers both agents)", () => {
    // Verified canonical codex hook tool_names (codex-rs/core/src/tools/hook_names.rs + registry.rs).
    expect(detailForHook("PreToolUse", "apply_patch")).toBe("editing");
    expect(detailForHook("PreToolUse", "update_plan")).toBe("planning");
    expect(detailForHook("PreToolUse", "view_image")).toBe("reading");
    expect(detailForHook("PreToolUse", "web_search")).toBe("web");
    expect(detailForHook("PreToolUse", "spawn_agent")).toBe("delegating");
    expect(detailForHook("PreToolUse", "shell")).toBe("running");
    expect(detailForHook("PreToolUse", "local_shell")).toBe("running");
    // Codex actually serializes its shell tool as the Claude-style "Bash" (HookToolName::bash()).
    expect(detailForHook("PreToolUse", "Bash")).toBe("running");
    // MCP tools serialize as mcp__server__tool on both agents → no detail.
    expect(detailForHook("PreToolUse", "mcp__memory__create_entities")).toBeUndefined();
  });
});

describe("agent key threading (codex present as the literal string; claude OMITS it)", () => {
  test("buildBlob stamps agent:'codex' for a codex hook, and has NO agent key for claude", () => {
    const plan = planOp("PreToolUse", { session_id: "s", cwd: "/x" }, false)!;
    expect(buildBlob({ session_id: "s", cwd: "/Users/x/api-status", hook_event_name: "PreToolUse", tool_name: "apply_patch" }, "Mac", "t", plan, "codex"))
      .toEqual({ status: "working", detail: "editing", title: "t", machine: "Mac", label: "api-status", agent: "codex" });
    expect(buildBlob({ session_id: "s", cwd: "/x", hook_event_name: "PreToolUse", tool_name: "Edit" }, "Mac", "t", plan))
      .not.toHaveProperty("agent");
  });
  test("buildEnvelope's codex blob decrypts with agent:'codex'; the claude blob has no agent key", async () => {
    const codexEnv = (await buildEnvelope({ session_id: "a", hook_event_name: "PreToolUse", tool_name: "apply_patch", cwd: "/x/api-status" }, "Mac", 1, "t", KEY, false, "codex"))!;
    expect(await decryptBlob(KEY, (codexEnv as { blob: string }).blob)).toMatchObject({ status: "working", detail: "editing", agent: "codex" });
    const claudeEnv = (await buildEnvelope({ session_id: "a", hook_event_name: "PreToolUse", tool_name: "Edit", cwd: "/x/api-status" }, "Mac", 1, "t", KEY, false))!;
    expect(await decryptBlob(KEY, (claudeEnv as { blob: string }).blob)).not.toHaveProperty("agent");
  });
  test("buildPendingStash carries agent:'codex' inside the stashed plaintext blob (flows through flush)", () => {
    const input = { session_id: "s2", hook_event_name: "PreToolUse", tool_name: "apply_patch", cwd: "/x" };
    expect(buildPendingStash(input, "Mac", "t", 9, 77, "codex")).toMatchObject({
      sessionId: "s2", op: "update", pid: 77, blob: { status: "working", detail: "editing", agent: "codex" },
    });
    // Claude stash still omits the agent key.
    expect(buildPendingStash(input, "Mac", "t", 9, 77)!.blob).not.toHaveProperty("agent");
  });
});

describe("codexSessionTitle (codex rollout: first event_msg user_message, with claude-style cleaning)", () => {
  const cl = (o: unknown) => JSON.stringify(o);
  const meta = cl({ timestamp: "t", type: "session_meta", payload: { session_id: "s", cwd: "." } });
  const turnCtx = cl({ timestamp: "t", type: "turn_context", payload: { cwd: ".", model: "gpt-5-codex" } });
  const respItem = cl({ timestamp: "t", type: "response_item", payload: { type: "message", role: "assistant", content: [] } });
  const userMsg = (message: string) => cl({ timestamp: "t", type: "event_msg", payload: { type: "user_message", message, kind: "plain" } });

  test("takes the FIRST user_message, skipping session_meta / turn_context / response_item noise", () => {
    const t = [meta, turnCtx, userMsg("Fix the flaky test   in\nCI"), respItem, userMsg("a later prompt")].join("\n");
    expect(codexSessionTitle(t)).toBe("Fix the flaky test in CI");
  });
  test("skips empty and <-wrapped command/context artifacts, lands on the real first ask", () => {
    const t = [meta, userMsg(""), userMsg("<environment_context>cwd=/x</environment_context>"), userMsg("the real ask")].join("\n");
    expect(codexSessionTitle(t)).toBe("the real ask");
  });
  test("skips [$…] and [@…] skill/plugin invocation artifacts, lands on the real first ask", () => {
    // These slip through codex's plain event_msg pipe and would otherwise become hideous titles.
    const t = [
      meta,
      userMsg("[$nomo:nomo-pair](/Users/x/.codex/plugins/nomo/skills/SKILL.md)"),
      userMsg("[@nomo-cc](plugin://nomo-cc@nomo) pair"),
      userMsg("the real ask"),
    ].join("\n");
    expect(codexSessionTitle(t)).toBe("the real ask");
  });
  test("cleans Markdown exactly like the Claude first-prompt fallback", () => {
    expect(codexSessionTitle(userMsg("**Fix** the `parseConfig` bug in _cc-shared_")))
      .toBe("Fix the parseConfig bug in cc-shared");
  });
  test("undefined for an empty prefix (empty/absent transcript), no user_message, or bad json", () => {
    expect(codexSessionTitle("")).toBeUndefined();                          // empty-file behavior
    expect(codexSessionTitle([meta, turnCtx, respItem].join("\n"))).toBeUndefined();
    expect(codexSessionTitle("not json\n{bad")).toBeUndefined();
  });
  test("ignores a Claude-style {type:'user'} turn — codex needs the event_msg framing", () => {
    expect(codexSessionTitle(cl({ type: "user", message: { role: "user", content: "claude style" } }))).toBeUndefined();
  });
  test("UserPromptSubmit prompt fallback building blocks: undefined title + cleanPromptTitle(prompt)", () => {
    // On codex's very first prompt the rollout may not have flushed the user_message line yet, so
    // runHook falls back to cleanPromptTitle(input.prompt). These are the two composed pieces.
    expect(codexSessionTitle("")).toBeUndefined();
    expect(cleanPromptTitle("**Add** codex support to the bridge")).toBe("Add codex support to the bridge");
  });
});

describe("codexThreadName (session_index.jsonl parser — the PRIMARY codex title)", () => {
  const idA = "019dd560-59b9-7f21-992b-3530ffdb3f7e";
  const idB = "019e1400-0775-7912-9ad3-752ac27c545a";
  const row = (id: string, thread_name: string, updated_at = "2026-04-28T18:36:05Z") =>
    JSON.stringify({ id, thread_name, updated_at });

  test("resolves a session_id to its thread_name", () => {
    const idx = [row(idA, "Add Vite Tailwind admin console"), row(idB, "Play focus playlist")].join("\n");
    expect(codexThreadName(idx, idA)).toBe("Add Vite Tailwind admin console");
    expect(codexThreadName(idx, idB)).toBe("Play focus playlist");
  });
  test("on duplicate ids the LAST matching line wins (freshest)", () => {
    const idx = [row(idA, "old title"), row(idB, "other"), row(idA, "fresh title")].join("\n");
    expect(codexThreadName(idx, idA)).toBe("fresh title");
  });
  test("undefined when the id is absent", () => {
    expect(codexThreadName(row(idB, "other"), idA)).toBeUndefined();
    expect(codexThreadName("", idA)).toBeUndefined();
  });
  test("tolerates malformed lines around a good match", () => {
    const idx = ["not json", `{bad ${idA}`, "", row(idA, "the good one"), "{trailing"].join("\n");
    expect(codexThreadName(idx, idA)).toBe("the good one");
  });
  test("skips a matching id whose thread_name is missing / non-string / empty", () => {
    const noName = JSON.stringify({ id: idA, updated_at: "t" });
    const nonString = JSON.stringify({ id: idA, thread_name: 42, updated_at: "t" });
    const empty = JSON.stringify({ id: idA, thread_name: "   ", updated_at: "t" });
    expect(codexThreadName([noName, nonString, empty].join("\n"), idA)).toBeUndefined();
    // …but a later well-formed line still wins.
    expect(codexThreadName([noName, row(idA, "recovered")].join("\n"), idA)).toBe("recovered");
  });
  test("caps a long thread_name on a word boundary (truncateOnWord)", () => {
    const long = "Refactor the entire authentication subsystem into a reusable module across every service";
    const out = codexThreadName(row(idA, long), idA)!;
    expect(out.length).toBeLessThanOrEqual(81);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("  ");
  });
});

describe("codexIndexTitle (reads $CODEX_HOME/session_index.jsonl; missing → undefined)", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "codex-home-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  test("reads the index file and resolves the thread_name", async () => {
    const id = randomUUID();
    await writeFile(join(home, "session_index.jsonl"),
      [JSON.stringify({ id: "other", thread_name: "nope" }), JSON.stringify({ id, thread_name: "Build stock monitor" })].join("\n"));
    expect(await codexIndexTitle(id, home)).toBe("Build stock monitor");
  });
  test("missing index file → undefined (silent fall-through, no throw)", async () => {
    expect(await codexIndexTitle(randomUUID(), home)).toBeUndefined();
  });
  test("index present but id absent → undefined (fall through to the rollout scan)", async () => {
    await writeFile(join(home, "session_index.jsonl"), JSON.stringify({ id: "other", thread_name: "x" }));
    expect(await codexIndexTitle(randomUUID(), home)).toBeUndefined();
  });
});

describe("codex title resolution — index (primary) over rollout (fallback) + upgrade", () => {
  const cl = (o: unknown) => JSON.stringify(o);
  const userMsg = (message: string) => cl({ timestamp: "t", type: "event_msg", payload: { type: "user_message", message, kind: "plain" } });
  let home: string;
  const id = "019e1d05-4cf4-7751-8c59-b9573047900e";
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "codex-home-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  // The readTitle chain in runHook is `(await codexIndexTitle(id)) ?? codexSessionTitle(prefix)`.
  // Modeling it here proves the ordering AND the upgrade (same rollout, title flips once the index
  // gains the entry) without spinning up the full hook.
  const resolve = async (rollout: string) => (await codexIndexTitle(id, home)) ?? codexSessionTitle(rollout);

  test("before the index has the entry, the rollout first user_message names the session", async () => {
    const rollout = userMsg("Wire up the stock monitor");
    expect(await resolve(rollout)).toBe("Wire up the stock monitor");
  });
  test("once codex writes the thread_name (~30s in), it UPGRADES the rollout title", async () => {
    const rollout = userMsg("Wire up the stock monitor");
    await writeFile(join(home, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Stock monitor automation" }));
    expect(await resolve(rollout)).toBe("Stock monitor automation");
  });
});

describe("detailForHook (unchanged)", () => {
  test("PreToolUse maps known tools to a semantic key, unknown tools to no detail", () => {
    expect(detailForHook("PreToolUse", "Edit")).toBe("editing");
    expect(detailForHook("PreToolUse", "Bash")).toBe("running");
    expect(detailForHook("PreToolUse", "Grep")).toBe("searching");
    expect(detailForHook("PreToolUse", "mcp__whatever")).toBeUndefined();
    expect(detailForHook("PreToolUse", undefined)).toBeUndefined();
  });
  test("PostToolUse is always 'thinking'; other hooks have no detail", () => {
    expect(detailForHook("PostToolUse", "Edit")).toBe("thinking");
    expect(detailForHook("Stop")).toBeUndefined();
    expect(detailForHook("UserPromptSubmit")).toBeUndefined();
  });
});

describe("isPermissionNotification (unchanged)", () => {
  test("true for a permission_prompt type or a permission-ish message", () => {
    expect(isPermissionNotification({ notification_type: "permission_prompt" })).toBe(true);
    expect(isPermissionNotification({ message: "Claude needs your permission to use Bash" })).toBe(true);
    expect(isPermissionNotification({ message: "Allow edits to this file?" })).toBe(true);
  });
  test("false for the idle 'waiting for your input' nudge", () => {
    expect(isPermissionNotification({ message: "Claude is waiting for your input" })).toBe(false);
    expect(isPermissionNotification({})).toBe(false);
  });
});

describe("buildBlob (plaintext content of the encrypted blob)", () => {
  test("carries status/title/machine/label and the tool detail", () => {
    const plan = planOp("PreToolUse", { session_id: "s", cwd: "/Users/x/api-status" }, false)!;
    expect(buildBlob({ session_id: "s", cwd: "/Users/x/api-status", hook_event_name: "PreToolUse", tool_name: "Edit" }, "Mac", "add font", plan))
      .toEqual({ status: "working", detail: "editing", title: "add font", machine: "Mac", label: "api-status" });
  });
  test("no detail field for a hook with no detail; label falls back to 'session'", () => {
    const plan = planOp("Stop", { session_id: "s" }, false)!;
    const blob = buildBlob({ session_id: "s", hook_event_name: "Stop" }, "Mac", undefined, plan);
    expect(blob).toEqual({ status: "done", title: "", machine: "Mac", label: "session" });
    expect(blob).not.toHaveProperty("detail");
  });
  test("needsAttention status rides through for a permission event", () => {
    const plan = planOp("PermissionRequest", { session_id: "s", cwd: "/x" }, false)!;
    expect(buildBlob({ session_id: "s", cwd: "/x", hook_event_name: "PermissionRequest" }, "Mac", "t", plan))
      .toMatchObject({ status: "needsAttention" });
  });
});

describe("label pinning (first-seen cwd wins — a mid-session `cd` must not rename the session)", () => {
  const plan = planOp("PreToolUse", { session_id: "s" }, false)!;

  test("the label stays the FIRST-SEEN one across a cwd-changing event sequence", () => {
    // Event 1: no record yet → the label derives from cwd, exactly as before.
    const first = buildBlob({ session_id: "s", cwd: "/Users/x/api-status", hook_event_name: "PreToolUse", tool_name: "Edit" }, "Mac", "t", plan);
    expect(first.label).toBe("api-status");
    // The session's shell then `cd server`s: later hooks carry the NEW cwd, but the record's cached
    // label (what runHook threads as pinnedLabel) must win — the observed "api-status" → "server"
    // silent rename is exactly what this pin prevents.
    const second = buildBlob({ session_id: "s", cwd: "/Users/x/api-status/server", hook_event_name: "PreToolUse", tool_name: "Edit" }, "Mac", "t", plan, "claude", undefined, first.label);
    expect(second.label).toBe("api-status");
    const third = buildBlob({ session_id: "s", cwd: "/somewhere/else", hook_event_name: "Stop" }, "Mac", "t", planOp("Stop", {}, false)!, "claude", undefined, second.label);
    expect(third.label).toBe("api-status");
  });

  test("an empty pinnedLabel falls back to the cwd derivation (a corrupt record can't blank the label)", () => {
    expect(buildBlob({ session_id: "s", cwd: "/x/proj", hook_event_name: "PreToolUse", tool_name: "Edit" }, "Mac", "t", plan, "claude", undefined, "").label).toBe("proj");
  });

  test("buildEnvelope threads the pinned label into the encrypted blob", async () => {
    const env = (await buildEnvelope(
      { session_id: "abc", hook_event_name: "PreToolUse", tool_name: "Edit", cwd: "/Users/x/api-status/server" },
      "Mac", 5, "t", KEY, false, "claude", undefined, undefined, "api-status",
    ))!;
    expect(await decryptBlob(KEY, (env as { blob: string }).blob)).toMatchObject({ label: "api-status" });
  });
});

describe("buildEnvelope (v2 envelope + encrypted blob)", () => {
  const input = { session_id: "abc", hook_event_name: "PreToolUse", tool_name: "Edit", cwd: "/Users/karrix/api-status" };

  test("builds a v2 envelope whose blob decrypts back to the plaintext", async () => {
    const env = (await buildEnvelope(input, "Karrix's MacBook", 1234, "add font and timer", KEY, false))!;
    expect(env).toMatchObject({ v: 2, sessionId: "abc", op: "update", prio: 0, ts: 1234 });
    expect(typeof (env as { blob: string }).blob).toBe("string");
    expect(await decryptBlob(KEY, (env as { blob: string }).blob)).toEqual({
      status: "working", detail: "editing", title: "add font and timer", machine: "Karrix's MacBook", label: "api-status",
    });
  });

  test("a Stop → op done, status done in the blob", async () => {
    const env = (await buildEnvelope({ session_id: "abc", hook_event_name: "Stop", cwd: "/x" }, "m", 5, undefined, KEY, false))!;
    expect(env).toMatchObject({ op: "done", prio: 0 });
    expect(await decryptBlob(KEY, (env as { blob: string }).blob)).toMatchObject({ status: "done", title: "", label: "x" });
  });

  test("a permission Notification → op update prio 1, needsAttention blob", async () => {
    const env = (await buildEnvelope({ session_id: "abc", hook_event_name: "Notification", notification_type: "permission_prompt", cwd: "/x" }, "m", 5, "t", KEY, false))!;
    expect(env).toMatchObject({ op: "update", prio: 1 });
    expect(await decryptBlob(KEY, (env as { blob: string }).blob)).toMatchObject({ status: "needsAttention" });
  });

  test("SessionEnd → op end with NO blob", async () => {
    const env = (await buildEnvelope({ session_id: "abc", hook_event_name: "SessionEnd", cwd: "/x" }, "m", 5, "t", KEY, false))!;
    expect(env).toEqual({ v: 2, sessionId: "abc", op: "end", prio: 0, ts: 5 });
    expect(env).not.toHaveProperty("blob");
  });

  test("re-arm: a SessionStart after done builds op update, not start", async () => {
    const env = (await buildEnvelope({ session_id: "abc", hook_event_name: "SessionStart", cwd: "/x" }, "m", 5, "t", KEY, true))!;
    expect(env).toMatchObject({ op: "update" });
  });

  test("null for unknown hooks, dropped idle nudge, or missing session id", async () => {
    expect(await buildEnvelope({ session_id: "abc", hook_event_name: "PreCompact" }, "m", 1, "t", KEY, false)).toBeNull();
    expect(await buildEnvelope({ session_id: "abc", hook_event_name: "Notification", message: "waiting for your input" }, "m", 1, "t", KEY, false)).toBeNull();
    expect(await buildEnvelope({ hook_event_name: "Stop" }, "m", 1, "t", KEY, false)).toBeNull();
    expect(await buildEnvelope(null, "m", 1, "t", KEY, false)).toBeNull();
  });

  test("threads a known startedAt onto the envelope; OMITS it when unknown (byte-compat)", async () => {
    const withStart = (await buildEnvelope(input, "m", 1234, "t", KEY, false, "claude", 999))!;
    expect(withStart).toMatchObject({ startedAt: 999 });
    const without = (await buildEnvelope(input, "m", 1234, "t", KEY, false))!;
    expect(without).not.toHaveProperty("startedAt");
  });

  test("startedAt rides even on an op:end envelope (the worker times its final frame too)", async () => {
    const env = (await buildEnvelope({ session_id: "abc", hook_event_name: "SessionEnd", cwd: "/x" }, "m", 5, "t", KEY, false, "claude", 42))!;
    expect(env).toEqual({ v: 2, sessionId: "abc", op: "end", prio: 0, ts: 5, startedAt: 42 });
  });

  test("a non-finite startedAt is dropped from the envelope", async () => {
    const env = (await buildEnvelope(input, "m", 1, "t", KEY, false, "claude", Infinity))!;
    expect(env).not.toHaveProperty("startedAt");
  });
});

// --- turnStartedAt (the per-turn island-timer anchor, epoch SECONDS, blob-only) ----------------
//
// Stamped by UserPromptSubmit, cached in the session record, threaded into the ENCRYPTED blob by
// every later hook of the turn. The clear wire envelope must NOT gain the field (zero server
// changes); an unknown anchor is OMITTED from the blob (old-blob byte-compat, like `agent`).
describe("turnStartedAt threading (blob-only; omitted when unknown)", () => {
  const input = { session_id: "abc", hook_event_name: "PreToolUse", tool_name: "Edit", cwd: "/x/api-status" };

  test("buildBlob includes a known turnStartedAt; OMITS the key when undefined or non-finite", () => {
    const plan = planOp("PreToolUse", input, false)!;
    expect(buildBlob(input, "Mac", "t", plan, "claude", 1_751_900_000))
      .toEqual({ status: "working", detail: "editing", title: "t", machine: "Mac", label: "api-status", turnStartedAt: 1_751_900_000 });
    expect(buildBlob(input, "Mac", "t", plan)).not.toHaveProperty("turnStartedAt");
    expect(buildBlob(input, "Mac", "t", plan, "claude", Infinity)).not.toHaveProperty("turnStartedAt");
  });

  test("buildEnvelope carries it INSIDE the encrypted blob — the clear envelope shape is unchanged", async () => {
    const env = (await buildEnvelope(input, "m", 1234, "t", KEY, false, "claude", 999, 1_751_900_000))!;
    expect(env).not.toHaveProperty("turnStartedAt"); // never on the wire — the worker stays blind
    expect(Object.keys(env).sort()).toEqual(["blob", "op", "prio", "sessionId", "startedAt", "ts", "v"]);
    expect(await decryptBlob(KEY, (env as { blob: string }).blob)).toMatchObject({ turnStartedAt: 1_751_900_000 });
  });

  test("without a turn anchor the decrypted blob omits the key (pre-0.3.5 byte-compat)", async () => {
    const env = (await buildEnvelope(input, "m", 1234, "t", KEY, false, "claude", 999))!;
    expect(await decryptBlob(KEY, (env as { blob: string }).blob)).not.toHaveProperty("turnStartedAt");
  });
});

// --- model (the blob's OPTIONAL raw model id, v0.8.5) ------------------------------------------
//
// Wire contract with the app (build 54): JSON key `model`, a raw model id string (e.g.
// "claude-fable-5", "gpt-5-codex"), OMITTED entirely when unknown — never required, never "". Rides
// ONLY inside the encrypted blob (like turnStartedAt): the clear envelope / worker stay blind.
describe("model threading (blob-only, optional; omitted when unknown — never an empty string)", () => {
  const input = { session_id: "abc", hook_event_name: "PreToolUse", tool_name: "Edit", cwd: "/x/api-status" };
  const plan = planOp("PreToolUse", input, false)!;

  test("buildBlob includes a known model; OMITS the key when undefined or empty", () => {
    expect(buildBlob(input, "Mac", "t", plan, "claude", undefined, undefined, "claude-fable-5"))
      .toEqual({ status: "working", detail: "editing", title: "t", machine: "Mac", label: "api-status", model: "claude-fable-5" });
    expect(buildBlob(input, "Mac", "t", plan)).not.toHaveProperty("model");
    expect(buildBlob(input, "Mac", "t", plan, "claude", undefined, undefined, "")).not.toHaveProperty("model");
  });

  test("buildEnvelope carries it INSIDE the encrypted blob — the clear envelope shape is unchanged", async () => {
    const env = (await buildEnvelope(input, "m", 1234, "t", KEY, false, "codex", 999, undefined, undefined, "gpt-5-codex"))!;
    expect(env).not.toHaveProperty("model"); // never on the wire — the worker stays blind
    expect(Object.keys(env).sort()).toEqual(["blob", "op", "prio", "sessionId", "startedAt", "ts", "v"]);
    expect(await decryptBlob(KEY, (env as { blob: string }).blob)).toMatchObject({ agent: "codex", model: "gpt-5-codex" });
    const without = (await buildEnvelope(input, "m", 1234, "t", KEY, false))!;
    expect(await decryptBlob(KEY, (without as { blob: string }).blob)).not.toHaveProperty("model");
  });

  test("a mid-pairing stash carries the model inside its plaintext blob (the first pairing frame)", () => {
    const stop = { session_id: "s1", hook_event_name: "Stop", cwd: "/x" };
    expect(buildPendingStash(stop, "Mac", "t", 1, 7, "claude", "claude-fable-5")!.blob)
      .toMatchObject({ model: "claude-fable-5" });
    expect(buildPendingStash(stop, "Mac", "t", 1, 7)!.blob).not.toHaveProperty("model");
  });
});

// --- pending-pairing stash (a hook that fires WHILE pairing is still pending) -----------------
//
// Mid-pairing the hook has no e2eKey, so instead of POSTing it stashes the PLAINTEXT event; the
// pairing completer (completePendingPairing, tested in pair.test.ts) encrypts + flushes it. These
// cover the STASH side: what gets written, and what is (correctly) NOT stashed.
describe("buildPendingStash (plaintext event stashed while pairing is pending)", () => {
  test("a Stop mid-pairing stashes an op:done event with the plaintext blob, a timestamp, and the session pid", () => {
    const input = { session_id: "s1", hook_event_name: "Stop", cwd: "/Users/x/api-status" };
    expect(buildPendingStash(input, "Mac", "add font", 1234, 4242)).toEqual({
      sessionId: "s1", op: "done", prio: 0, stashedAt: 1234, pid: 4242,
      blob: { status: "done", title: "add font", machine: "Mac", label: "api-status" },
    });
  });
  test("records process.ppid as the session pid by default (the `claude` process, per trackSession)", () => {
    const input = { session_id: "s1", hook_event_name: "Stop", cwd: "/x" };
    expect(buildPendingStash(input, "Mac", "t", 1)!.pid).toBe(process.ppid);
  });
  test("a PreToolUse mid-pairing stashes an op:update working event with the tool detail and pid", () => {
    const input = { session_id: "s2", hook_event_name: "PreToolUse", tool_name: "Edit", cwd: "/x" };
    expect(buildPendingStash(input, "Mac", "t", 9, 77)).toMatchObject({
      sessionId: "s2", op: "update", prio: 0, pid: 77, blob: { status: "working", detail: "editing" },
    });
  });
  test("returns null for a hook with nothing to post: unknown hook, dropped idle nudge, no session id", () => {
    expect(buildPendingStash({ session_id: "s", hook_event_name: "PreCompact" }, "m", "t", 1)).toBeNull();
    expect(buildPendingStash({ session_id: "s", hook_event_name: "Notification", message: "waiting for your input" }, "m", "t", 1)).toBeNull();
    expect(buildPendingStash({ hook_event_name: "Stop" }, "m", "t", 1)).toBeNull();
  });
  test("returns null for an op:end (SessionEnd) — no blob for a session the worker has never seen", () => {
    expect(buildPendingStash({ session_id: "s", hook_event_name: "SessionEnd", cwd: "/x" }, "m", "t", 1)).toBeNull();
  });
  test("a UserPromptSubmit stash stamps turnStartedAt (floor(now/1000)); any other hook omits it", () => {
    // Mid-pairing there is no session record to read a cached anchor from, so ONLY the turn opener
    // itself can stamp one — a stashed PreToolUse/Stop genuinely doesn't know the turn start.
    const prompt = { session_id: "s3", hook_event_name: "UserPromptSubmit", cwd: "/x" };
    expect(buildPendingStash(prompt, "Mac", "t", 1_751_900_123_456, 77)!.blob)
      .toMatchObject({ turnStartedAt: 1_751_900_123 });
    const tool = { session_id: "s3", hook_event_name: "PreToolUse", tool_name: "Edit", cwd: "/x" };
    expect(buildPendingStash(tool, "Mac", "t", 1_751_900_123_456, 77)!.blob).not.toHaveProperty("turnStartedAt");
  });
});

describe("stashPendingEvent (owner-only write; no-op when nothing to stash)", () => {
  let dir: string;
  let stashPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cc-stash-test-"));
    stashPath = join(dir, "pending-event.json");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("writes the stash 0600 with the built event and the session pid", async () => {
    await stashPendingEvent({ session_id: "s1", hook_event_name: "Stop", cwd: "/x" }, "Mac", "t", 42, stashPath, 9191);
    const written = JSON.parse(await readFile(stashPath, "utf8")) as PendingEventStash;
    expect(written).toMatchObject({ sessionId: "s1", op: "done", stashedAt: 42, pid: 9191, blob: { status: "done", machine: "Mac" } });
    expect((await stat(stashPath)).mode & 0o777).toBe(0o600);
  });
  test("writes NOTHING when there is nothing to stash (a dropped hook)", async () => {
    await stashPendingEvent({ session_id: "s", hook_event_name: "PreCompact" }, "Mac", "t", 1, stashPath);
    await expect(stat(stashPath)).rejects.toBeDefined();
  });
});

describe("firstUserPrompt (title logic untouched)", () => {
  const line = (o: unknown) => JSON.stringify(o);
  test("returns the first user message text, whitespace-collapsed", () => {
    const t = [
      line({ type: "user", message: { role: "user", content: "add font   and\ntimer" } }),
      line({ type: "user", message: { role: "user", content: "second prompt" } }),
    ].join("\n");
    expect(firstUserPrompt(t)).toBe("add font and timer");
  });
  test("skips command/UI artifacts wrapped in <tags>", () => {
    const t = [
      line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
      line({ type: "user", message: { role: "user", content: "the real ask" } }),
    ].join("\n");
    expect(firstUserPrompt(t)).toBe("the real ask");
  });
  test("reads text parts out of a content array", () => {
    const t = line({ type: "user", message: { role: "user", content: [{ type: "text", text: "array prompt" }] } });
    expect(firstUserPrompt(t)).toBe("array prompt");
  });
  test("a single long word with no spaces hard-cuts at the cap and appends an ellipsis (≤ 81)", () => {
    const long = "x".repeat(200);
    const out = firstUserPrompt(line({ type: "user", message: { role: "user", content: long } }))!;
    expect(out.length).toBeLessThanOrEqual(81);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("x".repeat(80))).toBe(true);
  });
  test("truncates a long prompt on a WORD boundary with an ellipsis (no mid-word cut)", () => {
    const words = `${"alpha ".repeat(30)}omega`; // well over the 80-char cap, all whole words
    const out = firstUserPrompt(line({ type: "user", message: { role: "user", content: words } }))!;
    expect(out.endsWith("…")).toBe(true);
    // The char before the ellipsis is a word char (a whole word survived), never a space.
    expect(out.slice(0, -1)).toMatch(/\w$/);
    // Every retained token is a complete "alpha" — no "alph"/"alp" fragment from a hard cut.
    for (const tok of out.slice(0, -1).trim().split(" ")) expect(tok).toBe("alpha");
  });
  test("strips Markdown emphasis/backticks/heading markers from the fallback title", () => {
    const md = "**Fix** the `parseConfig` bug in _cc-shared_";
    expect(firstUserPrompt(line({ type: "user", message: { role: "user", content: md } })))
      .toBe("Fix the parseConfig bug in cc-shared");
    const heading = "# Refactor the watchdog loop";
    expect(firstUserPrompt(line({ type: "user", message: { role: "user", content: heading } })))
      .toBe("Refactor the watchdog loop");
  });
  test("the exact field-reported stashed pairing prompt: no raw ** and a clean word-boundary ellipsis", () => {
    const field = "Pairing is two quick steps: **show the QR fast**, then **wait for the phone to scan**, and you're all done pairing this computer with the app.";
    const out = firstUserPrompt(line({ type: "user", message: { role: "user", content: field } }))!;
    expect(out).not.toContain("*");        // literal markdown asterisks are gone
    expect(out.endsWith("…")).toBe(true);  // truncated with an ellipsis, not a hard mid-word cut
    expect(out).toBe("Pairing is two quick steps: show the QR fast, then wait for the phone to scan…");
  });
  test("undefined when no user prompt is present", () => {
    expect(firstUserPrompt(line({ type: "assistant", message: { content: "hi" } }))).toBeUndefined();
    expect(firstUserPrompt("")).toBeUndefined();
    expect(firstUserPrompt("not json\n{bad")).toBeUndefined();
  });
});

describe("aiTitle (title logic untouched)", () => {
  const line = (o: unknown) => JSON.stringify(o);
  test("returns the aiTitle CC wrote, whitespace-collapsed", () => {
    const t = line({ type: "ai-title", aiTitle: "Investigate title\n display" });
    expect(aiTitle(t)).toBe("Investigate title display");
  });
  test("prefers the last ai-title when CC re-emits it (freshest wins)", () => {
    const t = [
      line({ type: "ai-title", aiTitle: "early title" }),
      line({ type: "user", message: { role: "user", content: "some prompt" } }),
      line({ type: "ai-title", aiTitle: "later title" }),
    ].join("\n");
    expect(aiTitle(t)).toBe("later title");
  });
  test("truncates to 80 chars", () => {
    expect(aiTitle(line({ type: "ai-title", aiTitle: "x".repeat(200) }))!.length).toBe(80);
  });
  test("undefined when no ai-title / empty / bad json", () => {
    expect(aiTitle(line({ type: "user", message: { content: "hi" } }))).toBeUndefined();
    expect(aiTitle(line({ type: "ai-title", aiTitle: "" }))).toBeUndefined();
    expect(aiTitle("")).toBeUndefined();
    expect(aiTitle("not json\n{bad")).toBeUndefined();
  });
});

describe("sessionTitle (title logic untouched)", () => {
  const line = (o: unknown) => JSON.stringify(o);
  test("prefers CC's ai-title over the first user prompt", () => {
    const t = [
      line({ type: "user", message: { role: "user", content: "the raw first ask" } }),
      line({ type: "ai-title", aiTitle: "Clean CC title" }),
    ].join("\n");
    expect(sessionTitle(t)).toBe("Clean CC title");
  });
  test("falls back to the first user prompt when no ai-title exists yet", () => {
    const t = line({ type: "user", message: { role: "user", content: "the raw first ask" } });
    expect(sessionTitle(t)).toBe("the raw first ask");
  });
  test("undefined when neither is present", () => {
    expect(sessionTitle("")).toBeUndefined();
  });
});

// The session's TRUE start, read from the transcript head — one scan covers both agents (first
// parseable line with a top-level string ISO `timestamp`). Verified against live transcripts: Claude
// opens with timestamp-less meta rows then a SessionStart entry; Codex's first line is session_meta.
describe("transcriptStartMs (session true-start from the transcript head)", () => {
  const line = (o: unknown) => JSON.stringify(o);
  test("claude: skips the timestamp-less meta rows, takes the first real entry's ISO timestamp", () => {
    const t = [
      line({ type: "last-prompt", leafUuid: "x", sessionId: "s" }),
      line({ type: "mode", mode: "normal", sessionId: "s" }),
      line({ type: "attachment", timestamp: "2026-07-07T16:14:10.165Z", sessionId: "s" }),
      line({ type: "user", timestamp: "2026-07-07T16:15:00.000Z" }),
    ].join("\n");
    expect(transcriptStartMs(t)).toBe(Date.parse("2026-07-07T16:14:10.165Z"));
  });
  test("codex: the session_meta first line's TOP-LEVEL timestamp (not payload.timestamp)", () => {
    const t = line({
      timestamp: "2026-06-02T23:34:34.587Z", type: "session_meta",
      payload: { id: "019e8ab0", timestamp: "2026-06-02T23:34:34.452Z" },
    });
    expect(transcriptStartMs(t)).toBe(Date.parse("2026-06-02T23:34:34.587Z"));
  });
  test("a malformed / byte-sliced first line is skipped; the next valid timestamp wins", () => {
    const t = `{"type":"attachment","timestamp":"2026-07-07T16:14:10.1` + "\n" +
      line({ type: "user", timestamp: "2026-07-07T16:20:00.000Z" });
    expect(transcriptStartMs(t)).toBe(Date.parse("2026-07-07T16:20:00.000Z"));
  });
  test("no timestamp anywhere / empty → undefined", () => {
    expect(transcriptStartMs(line({ type: "mode" }))).toBeUndefined();
    expect(transcriptStartMs("")).toBeUndefined();
  });
  test("a non-string or unparseable timestamp value is ignored", () => {
    const t = [line({ timestamp: 12345 }), line({ timestamp: "not-a-date" })].join("\n");
    expect(transcriptStartMs(t)).toBeUndefined();
  });
});

describe("parseConfig (config v2 validation)", () => {
  const e2eKeyB64 = b64url(new Uint8Array(32).fill(3));
  const valid = { url: "https://x.dev/", pairingId: "pair-1", pcSecret: "secret-1", e2eKeyB64 };

  test("accepts a full v2 config, strips a trailing slash, decodes the 32-byte key", () => {
    const c = parseConfig(JSON.stringify(valid))!;
    expect(c.url).toBe("https://x.dev");
    expect(c.pairingId).toBe("pair-1");
    expect(c.pcSecret).toBe("secret-1");
    expect(c.e2eKey).toBeInstanceOf(Uint8Array);
    expect(c.e2eKey.length).toBe(32);
  });
  test("carries an optional machineName when present", () => {
    expect(parseConfig(JSON.stringify({ ...valid, machineName: "Studio" }))!.machineName).toBe("Studio");
    expect(parseConfig(JSON.stringify(valid))!.machineName).toBeUndefined();
  });
  test("rejects an OLD {url,key} config (forces re-pair, no silent migration)", () => {
    expect(parseConfig(JSON.stringify({ url: "https://x.dev", key: "legacy" }))).toBeNull();
  });
  test("rejects a config missing any required field", () => {
    expect(parseConfig(JSON.stringify({ ...valid, pairingId: undefined }))).toBeNull();
    expect(parseConfig(JSON.stringify({ ...valid, pcSecret: undefined }))).toBeNull();
    expect(parseConfig(JSON.stringify({ ...valid, e2eKeyB64: undefined }))).toBeNull();
    expect(parseConfig(JSON.stringify({ ...valid, url: undefined }))).toBeNull();
  });
  test("rejects a key that doesn't decode to 32 bytes", () => {
    expect(parseConfig(JSON.stringify({ ...valid, e2eKeyB64: b64url(new Uint8Array(16)) }))).toBeNull();
  });
  test("rejects non-JSON / non-object", () => {
    expect(parseConfig("not json")).toBeNull();
    expect(parseConfig("42")).toBeNull();
  });
});

// --- trackSession → readRecord file glue (cross-invocation sentDone re-arm) -------------------
//
// The re-arm ITSELF (planOp(sentDone)) is unit-tested above with sentDone passed in-memory, but a
// real re-arm crosses a process boundary: the Stop hook's trackSession() writes sentDone:true to
// disk and exits, then the NEXT hook invocation (a fresh process) calls readRecord() to read it back
// before calling planOp(). This exercises that real write→exit→fresh-read→plan path end to end,
// using a uniquely-named session file under the real SESSIONS_DIR (cleaned up after) since
// shared's paths are fixed at module load from process.env.HOME.
describe("trackSession + readRecord file glue (sentDone survives a fresh disk read)", () => {
  test("a Stop (done) write's sentDone is readable by a separate readRecord call, and re-arms the NEXT SessionStart to `update`", async () => {
    const sessionId = `test-glue-${randomUUID()}`;
    try {
      // The Stop hook's write path: exactly what main() does on a Stop event.
      await trackSession(sessionId, "done", 0, "done", "ENCRYPTEDBLOB", "mac", "proj", "/tmp/t.jsonl");

      // A NEW read, as a separate later process/hook invocation would do — not the in-memory value.
      const record = await readRecord(sessionId);
      expect(record?.sentDone).toBe(true);
      expect(record?.op).toBe("done");
      expect(record?.blob).toBe("ENCRYPTEDBLOB");

      // Feed the freshly-read sentDone into planOp: the re-arm case is a SessionStart, which maps to
      // `update` (not a fresh `start`) only when sentDone is true — proving the disk round-trip, not
      // just the in-memory boolean, drives the re-arm.
      expect(planOp("SessionStart", { session_id: sessionId, cwd: "/x" }, record?.sentDone === true))
        .toEqual({ op: "update", prio: 0, status: "working" });

      // The already-`update`-mapped hooks (e.g. PostToolUse) stay `update` regardless, so the very
      // next hook after a done never regresses to a dropped/unknown state.
      expect(planOp("PostToolUse", { session_id: sessionId, cwd: "/x" }, record?.sentDone === true))
        .toEqual({ op: "update", prio: 0, status: "working" });
    } finally {
      await unlink(`${SESSIONS_DIR}/${sessionId}.json`).catch(() => {});
    }
  });

  test("op:end deletes the record instead of writing sentDone (nothing left to re-read)", async () => {
    const sessionId = `test-glue-${randomUUID()}`;
    try {
      await trackSession(sessionId, "start", 0, "working", "B", "mac", "proj", "/tmp/t.jsonl");
      expect(await readRecord(sessionId)).not.toBeNull();
      await trackSession(sessionId, "end", 0, "done", undefined, "mac", "proj", "/tmp/t.jsonl");
      expect(await readRecord(sessionId)).toBeNull();
    } finally {
      await unlink(`${SESSIONS_DIR}/${sessionId}.json`).catch(() => {});
    }
  });

  test("sessionStartedAt round-trips through the record; omitted when unknown (backward-compat)", async () => {
    const sessionId = `test-start-${randomUUID()}`;
    try {
      // A known start is cached in the record so the next hook / the watchdog re-send it without re-parsing.
      await trackSession(sessionId, "update", 0, "working", "B", "mac", "proj", "/tmp/t.jsonl", "claude", 1_699_999_999_000);
      expect((await readRecord(sessionId))?.sessionStartedAt).toBe(1_699_999_999_000);
      // Unknown start → the field is simply absent (an old record without it must still load).
      await trackSession(sessionId, "update", 0, "working", "B", "mac", "proj", "/tmp/t.jsonl");
      const rec = await readRecord(sessionId);
      expect(rec).not.toBeNull();
      expect(rec?.sessionStartedAt).toBeUndefined();
    } finally {
      await unlink(`${SESSIONS_DIR}/${sessionId}.json`).catch(() => {});
    }
  });

  test("turnStartedAt round-trips through the record; omitted when unknown (pre-0.3.5 compat)", async () => {
    const sessionId = `test-turn-${randomUUID()}`;
    try {
      // A UserPromptSubmit's stamp is cached (epoch seconds) so the turn's later hooks re-send it.
      await trackSession(sessionId, "update", 0, "working", "B", "mac", "proj", "/tmp/t.jsonl", "claude", 1_699_999_999_000, 1_751_900_000);
      expect((await readRecord(sessionId))?.turnStartedAt).toBe(1_751_900_000);
      // No anchor known → the field is simply absent (an old record without it must still load).
      await trackSession(sessionId, "update", 0, "working", "B", "mac", "proj", "/tmp/t.jsonl");
      const rec = await readRecord(sessionId);
      expect(rec).not.toBeNull();
      expect(rec?.turnStartedAt).toBeUndefined();
    } finally {
      await unlink(`${SESSIONS_DIR}/${sessionId}.json`).catch(() => {});
    }
  });

  test("model round-trips through the record (cached like title for the watchdog's rebuilt blobs); omitted when unknown", async () => {
    const sessionId = `test-model-${randomUUID()}`;
    try {
      // A hook that resolved the model caches it so the watchdog's corrective done/needsAttention
      // envelopes (which rebuild their blobs from the record) keep the phone's model badge.
      await trackSession(sessionId, "update", 0, "working", "B", "mac", "proj", "/tmp/t.jsonl", "claude",
        undefined, undefined, undefined, "add font", undefined, "claude-fable-5");
      expect((await readRecord(sessionId))?.model).toBe("claude-fable-5");
      // Unknown model → the field is simply absent (an old record without it must still load), and an
      // empty string is never persisted.
      await trackSession(sessionId, "update", 0, "working", "B", "mac", "proj", "/tmp/t.jsonl", "claude",
        undefined, undefined, undefined, undefined, undefined, "");
      const rec = await readRecord(sessionId);
      expect(rec).not.toBeNull();
      expect(rec?.model).toBeUndefined();
    } finally {
      await unlink(`${SESSIONS_DIR}/${sessionId}.json`).catch(() => {});
    }
  });

  test("turnId round-trips through the record; omitted when unknown; preserved across a watchdog-style spread", async () => {
    const sessionId = `test-turnid-${randomUUID()}`;
    try {
      // A Codex hook binds the record to its turn_id so the notify backstop's stale-turn guard works.
      await trackSession(sessionId, "update", 0, "working", "B", "mac", "proj", "/tmp/t.jsonl", "codex", 1_699_999_999_000, 1_751_900_000, "tu-42");
      const rec = await readRecord(sessionId);
      expect(rec?.turnId).toBe("tu-42");
      // The watchdog's corrective-done re-write is `{ ...record, lastEvent, sentDone, op }` — the spread
      // carries turnId through verbatim, exactly like turnStartedAt.
      const rewritten = { ...rec!, lastEvent: "done", sentDone: true, op: "done" as const };
      expect(rewritten.turnId).toBe("tu-42");
      // A claude hook (no turn_id / empty) omits the field — an old record without it must still load.
      await trackSession(sessionId, "update", 0, "working", "B", "mac", "proj", "/tmp/t.jsonl");
      expect((await readRecord(sessionId))?.turnId).toBeUndefined();
    } finally {
      await unlink(`${SESSIONS_DIR}/${sessionId}.json`).catch(() => {});
    }
  });
});

// --- native Codex plugin detection (D6/D7.1) --------------------------------------------------
//
// status-cmd learns to read the native plugin's state from <CODEX_HOME>/config.toml (naive line-scan,
// no TOML dep) and to warn when the legacy hooks.json path overlaps it (double-fire). These cover the
// pure parser and the end-to-end `Codex plugin:` status line across every detection state.
describe("parseCodexPluginState (naive config.toml line-scan)", () => {
  test("empty / unrelated config → not installed, default-enabled, 0 trusted, 0 ccTrusted", () => {
    expect(parseCodexPluginState("")).toEqual({ installed: false, enabled: true, trusted: 0, ccTrusted: 0 });
    expect(parseCodexPluginState("[other.section]\nkey = 1\n")).toEqual({ installed: false, enabled: true, trusted: 0, ccTrusted: 0 });
  });
  test("a [plugins.\"nomo@…\"] section marks installed; no `enabled` key is enabled by default", () => {
    expect(parseCodexPluginState(`[plugins."nomo@nomo"]\n`)).toMatchObject({ installed: true, enabled: true });
  });
  test("`enabled = false` inside the nomo section marks it disabled; a later section ends the scan", () => {
    const toml = `[plugins."nomo@nomo"]\nenabled = false\n\n[plugins."other@x"]\nenabled = true\n`;
    expect(parseCodexPluginState(toml)).toMatchObject({ installed: true, enabled: false });
  });
  test("counts one trusted hook per [hooks.state.\"nomo@…\"] section header", () => {
    const trust = Array.from({ length: 4 }, (_, i) =>
      `[hooks.state."nomo@nomo:hooks/codex-hooks.json#${i}"]\ntrusted_hash = "h${i}"`).join("\n\n");
    expect(parseCodexPluginState(`[plugins."nomo@nomo"]\nenabled = true\n\n${trust}\n`))
      .toEqual({ installed: true, enabled: true, trusted: 4, ccTrusted: 0 });
  });
  test("counts nomo-cc (Claude plugin) hooks trusted in Codex separately from the native nomo count", () => {
    const nomo = `[hooks.state."nomo@nomo:hooks/codex-hooks.json#0"]\ntrusted_hash = "a"`;
    const cc = Array.from({ length: 3 }, (_, i) =>
      `[hooks.state."nomo-cc@nomo:hooks/hooks.json#${i}"]\ntrusted_hash = "c${i}"`).join("\n\n");
    // nomo-cc@ must NOT be miscounted as the native nomo@ (prefix stops at the `-`).
    expect(parseCodexPluginState(`[plugins."nomo@nomo"]\n\n${nomo}\n\n${cc}\n`))
      .toEqual({ installed: true, enabled: true, trusted: 1, ccTrusted: 3 });
  });
  test("`enabled` of an UNRELATED plugin section does not flip nomo's state", () => {
    const toml = `[plugins."other@x"]\nenabled = false\n\n[plugins."nomo@nomo"]\n`;
    expect(parseCodexPluginState(toml)).toMatchObject({ installed: true, enabled: true });
  });
});

describe("statusCmd — Codex plugin detection states", () => {
  // A config.toml with (optionally) the nomo plugin section + N trusted-hook sections.
  const cfgToml = (o: { installed?: boolean; enabled?: boolean; trusted?: number; ccTrusted?: number } = {}): string => {
    const parts: string[] = [];
    if (o.installed !== false) {
      parts.push(`[plugins."nomo@nomo"]`);
      if (o.enabled !== undefined) parts.push(`enabled = ${o.enabled}`);
      parts.push("");
    }
    for (let i = 0; i < (o.trusted ?? 0); i++) {
      parts.push(`[hooks.state."nomo@nomo:hooks/codex-hooks.json#h${i}"]`);
      parts.push(`trusted_hash = "deadbeef${i}"`);
      parts.push("");
    }
    // The CLAUDE plugin's hooks trusted INSIDE Codex's config.toml (auto-discovery double-fire).
    for (let i = 0; i < (o.ccTrusted ?? 0); i++) {
      parts.push(`[hooks.state."nomo-cc@nomo:hooks/hooks.json#h${i}"]`);
      parts.push(`trusted_hash = "cafebabe${i}"`);
      parts.push("");
    }
    return parts.join("\n");
  };
  // A legacy hooks.json registering OUR command (codex-status.mjs) under N events.
  const legacyHooks = (n: number): string => JSON.stringify({
    hooks: Object.fromEntries(
      ["SessionStart", "Stop", "PreToolUse", "PostToolUse", "UserPromptSubmit", "PermissionRequest"]
        .slice(0, n)
        .map((e) => [e, [{ hooks: [{ command: "node ~/.codex/plugins/nomo/dist/codex-status.mjs" }] }]]),
    ),
  });

  async function runStatus(opts: { configToml?: string; hooksJson?: string }): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), "cc-status-detect-"));
    try {
      const codexConfigPath = join(dir, "config.toml");
      const codexHooksPath = join(dir, "hooks.json");
      if (opts.configToml !== undefined) await writeFile(codexConfigPath, opts.configToml);
      if (opts.hooksJson !== undefined) await writeFile(codexHooksPath, opts.hooksJson);
      const lines: string[] = [];
      await statusCmd({
        print: (l) => lines.push(l),
        configPath: join(dir, "config.json"),      // absent → the pairing lines are irrelevant here
        lastSendPath: join(dir, "last-send"),
        sessionsDir: join(dir, "sessions"),
        watchdogPidPath: join(dir, "watchdog.pid"),
        codexConfigPath,
        codexHooksPath,
        isAlive: () => false,
        now: () => 0,
      });
      return lines;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const pluginLine = (lines: string[]): string => lines.find((l) => l.startsWith("Codex plugin:"))!;

  test("statusCmd always returns exit code 0 (not-paired/absent is information, not an error)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-status-exit-"));
    const code = await statusCmd({ print: () => {}, configPath: join(dir, "config.json"),
      codexConfigPath: join(dir, "config.toml"), codexHooksPath: join(dir, "hooks.json") });
    await rm(dir, { recursive: true, force: true });
    expect(code).toBe(0);
  });

  test("nothing installed → `not installed`", async () => {
    expect(pluginLine(await runStatus({}))).toBe("Codex plugin: not installed");
  });

  test("installed + all 6 hooks trusted → `installed, trusted (6/6)`", async () => {
    expect(pluginLine(await runStatus({ configToml: cfgToml({ enabled: true, trusted: 6 }) })))
      .toBe("Codex plugin: installed, trusted (6/6)");
  });

  test("installed + a partial N trusted → `installed, trusted (N/6)`", async () => {
    expect(pluginLine(await runStatus({ configToml: cfgToml({ trusted: 3 }) })))
      .toBe("Codex plugin: installed, trusted (3/6)");
  });

  test("installed but no hooks trusted yet → `installed, hooks NOT trusted (run /hooks in Codex)`", async () => {
    expect(pluginLine(await runStatus({ configToml: cfgToml({ enabled: true, trusted: 0 }) })))
      .toBe("Codex plugin: installed, hooks NOT trusted (run /hooks in Codex)");
  });

  test("installed but explicitly disabled → `installed, disabled`", async () => {
    expect(pluginLine(await runStatus({ configToml: cfgToml({ enabled: false, trusted: 6 }) })))
      .toBe("Codex plugin: installed, disabled");
  });

  test("legacy hooks.json only (no native plugin) → `legacy hooks.json (N events)` + migrate hint", async () => {
    const lines = await runStatus({ hooksJson: legacyHooks(6) });
    expect(pluginLine(lines)).toBe("Codex plugin: legacy hooks.json (6 events)");
    expect(lines.some((l) => l.includes("migrating to the native"))).toBe(true);
  });

  test("overlap (native enabled+trusted AND legacy) → trusted line + a double-fire WARNING naming codex-status.mjs", async () => {
    const lines = await runStatus({ configToml: cfgToml({ enabled: true, trusted: 6 }), hooksJson: legacyHooks(6) });
    expect(pluginLine(lines)).toBe("Codex plugin: installed, trusted (6/6)");
    const warn = lines.find((l) => l.includes("double-fire"));
    expect(warn).toContain("6 legacy Nomo event");
    expect(lines.some((l) => l.includes("codex-status.mjs"))).toBe(true);
    // No spurious "migrate" hint when the native plugin is present.
    expect(lines.some((l) => l.includes("migrating to the native"))).toBe(false);
  });

  // Auto-discovery double-fire (D7.2): Codex auto-discovers the CLAUDE plugin (nomo-cc) and, when its
  // hooks.json hooks are ALSO trusted in Codex's config.toml, runs BOTH plugins on every Codex event.
  const ccWarn = (lines: string[]): string | undefined =>
    lines.find((l) => l.includes("WARNING") && l.includes("auto-discovered the Claude plugin"));

  test("both nomo AND nomo-cc trusted in Codex → auto-discovery double-fire WARNING + untrust hint", async () => {
    const lines = await runStatus({ configToml: cfgToml({ enabled: true, trusted: 6, ccTrusted: 6 }) });
    const warn = ccWarn(lines);
    expect(warn).toBeDefined();
    expect(warn).toContain("redundant double-fire");
    // Two-space indent + an indented hint line naming the nomo-cc entries to remove.
    expect(warn!.startsWith("  WARNING:")).toBe(true);
    const hint = lines.find((l) => l.includes("`nomo-cc@nomo`") && l.includes("/hooks"));
    expect(hint).toBeDefined();
    expect(hint!.startsWith("  ")).toBe(true);
  });

  test("only the native nomo trusted (no nomo-cc) → NO auto-discovery warning", async () => {
    const lines = await runStatus({ configToml: cfgToml({ enabled: true, trusted: 6 }) });
    expect(ccWarn(lines)).toBeUndefined();
  });

  test("only nomo-cc trusted in Codex (no native nomo entries) → NO auto-discovery warning", async () => {
    const lines = await runStatus({ configToml: cfgToml({ installed: false, ccTrusted: 6 }) });
    expect(ccWarn(lines)).toBeUndefined();
  });
});

// --- "hooks not firing" detector (Codex #16430/#30835) -----------------------------------------
//
// A paired machine with RECENT session activity but a last-hook stamp that's absent or badly lagging
// the newest session means the agent's plugin-bundled hooks are silently not firing. hooksAppearStale
// is the pure decision rule; the statusCmd cases exercise the end-to-end warning render + the gates.
describe("hooksAppearStale (pure decision rule)", () => {
  const NOW = 1_000_000_000_000;
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;

  test("no session activity (mtime 0) → never warn", () => {
    expect(hooksAppearStale(NOW, 0, 0)).toBe(false);
    expect(hooksAppearStale(NOW, 0, NOW - DAY)).toBe(false);
  });
  test("recent activity but NO stamp → warn", () => {
    expect(hooksAppearStale(NOW, NOW - 5 * MIN, 0)).toBe(true);
  });
  test("stamp newer than (or equal to) the newest session → healthy", () => {
    expect(hooksAppearStale(NOW, NOW - 30 * MIN, NOW - MIN)).toBe(false);
    expect(hooksAppearStale(NOW, NOW - 30 * MIN, NOW - 30 * MIN)).toBe(false);
  });
  test("stamp within the 10-min grace of the newest session → healthy", () => {
    expect(hooksAppearStale(NOW, NOW - 2 * MIN, NOW - 11 * MIN)).toBe(false); // 9 min behind
  });
  test("stamp lagging the newest session by MORE than 10 min → warn", () => {
    expect(hooksAppearStale(NOW, NOW - 2 * MIN, NOW - 20 * MIN)).toBe(true); // 18 min behind
  });
  test("activity older than 7 days → too stale to judge, never warn", () => {
    expect(hooksAppearStale(NOW, NOW - 8 * DAY, 0)).toBe(false);
    expect(hooksAppearStale(NOW, NOW - 8 * DAY, NOW - 30 * DAY)).toBe(false);
  });
});

describe("statusCmd — hooks-not-firing warning", () => {
  const NOW = 1_700_000_000_000;
  const MIN = 60_000;

  // Build the temp scaffold: a paired config (unless paired:false), a codex sessions tree with one
  // nested rollout file, a claude projects tree with one nested transcript, and optional per-agent
  // stamp files — each aged relative to NOW. Returns the printed lines.
  async function run(opts: {
    paired?: boolean;
    // Whether the native Codex plugin is installed+trusted in config.toml. Default true so the Codex
    // detector is eligible (its `enabled` gate keys off plugin.installed); set false to exercise the
    // "other agent's CLI, no Nomo plugin" false-positive-suppression case.
    codexInstalled?: boolean;
    codexSessionAgeMs?: number; claudeSessionAgeMs?: number;
    codexStampAgeMs?: number; claudeStampAgeMs?: number;
  }): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), "cc-hooksniff-"));
    try {
      const configPath = join(dir, "config.json");
      if (opts.paired !== false) {
        await writeFile(configPath, JSON.stringify({
          url: "https://w.example", pairingId: "pair1234", pcSecret: "s", e2eKeyB64: b64url(new Uint8Array(32).fill(3)),
        }));
      }
      const codexConfigPath = join(dir, "config.toml");
      if (opts.codexInstalled !== false) {
        // A native nomo plugin section + one trusted hook → parseCodexPluginState reports installed.
        await writeFile(codexConfigPath, `[plugins."nomo@nomo"]\n\n[hooks.state."nomo@nomo:hooks/codex-hooks.json#h0"]\ntrusted_hash = "d0"\n`);
      }
      const codexSessionsDir = join(dir, "codex", "sessions");
      const claudeProjectsDir = join(dir, "claude", "projects");
      const lastHookCodexPath = join(dir, "last-hook-codex");
      const lastHookClaudePath = join(dir, "last-hook-claude");

      if (opts.codexSessionAgeMs !== undefined) {
        const p = join(codexSessionsDir, "2026", "07", "08", "rollout-2026-07-08T00-00-00-abc.jsonl");
        await mkdir(join(codexSessionsDir, "2026", "07", "08"), { recursive: true });
        await writeFile(p, "{}\n");
        const t = (NOW - opts.codexSessionAgeMs) / 1000;
        await utimes(p, t, t);
      }
      if (opts.claudeSessionAgeMs !== undefined) {
        const p = join(claudeProjectsDir, "-x-proj", "sess.jsonl");
        await mkdir(join(claudeProjectsDir, "-x-proj"), { recursive: true });
        await writeFile(p, "{}\n");
        const t = (NOW - opts.claudeSessionAgeMs) / 1000;
        await utimes(p, t, t);
      }
      if (opts.codexStampAgeMs !== undefined) await writeFile(lastHookCodexPath, String(NOW - opts.codexStampAgeMs));
      if (opts.claudeStampAgeMs !== undefined) await writeFile(lastHookClaudePath, String(NOW - opts.claudeStampAgeMs));

      const lines: string[] = [];
      await statusCmd({
        print: (l) => lines.push(l),
        configPath,
        lastSendPath: join(dir, "last-send"),
        sessionsDir: join(dir, "sessions"),
        watchdogPidPath: join(dir, "watchdog.pid"),
        codexConfigPath,
        codexHooksPath: join(dir, "hooks.json"),
        codexSessionsDir, claudeProjectsDir, lastHookCodexPath, lastHookClaudePath,
        isAlive: () => false,
        now: () => NOW,
      });
      return lines;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const warnedFor = (lines: string[], agent: string): boolean =>
    lines.some((l) => l.includes("WARNING") && l.includes(agent) && l.toLowerCase().includes("hooks appear"));

  test("recent codex rollout + NO stamp → codex hooks-not-firing warning with the #16430/#30835 hint", async () => {
    const lines = await run({ codexSessionAgeMs: 3 * MIN });
    expect(warnedFor(lines, "Codex")).toBe(true);
    expect(lines.some((l) => l.includes("#16430") && l.includes("#30835"))).toBe(true);
    expect(lines.some((l) => l.includes("/hooks"))).toBe(true);
  });

  test("recent codex rollout + FRESH stamp → no warning (healthy)", async () => {
    const lines = await run({ codexSessionAgeMs: 3 * MIN, codexStampAgeMs: 2 * MIN });
    expect(warnedFor(lines, "Codex")).toBe(false);
  });

  test("codex rollout is old (>7d) → no warning even with no stamp", async () => {
    const lines = await run({ codexSessionAgeMs: 8 * 24 * 60 * MIN });
    expect(warnedFor(lines, "Codex")).toBe(false);
  });

  test("not paired → no warning even with recent activity and no stamp", async () => {
    const lines = await run({ paired: false, codexSessionAgeMs: 3 * MIN });
    expect(warnedFor(lines, "Codex")).toBe(false);
  });

  test("no sessions dir at all → no warning", async () => {
    const lines = await run({});
    expect(warnedFor(lines, "Codex")).toBe(false);
    expect(warnedFor(lines, "Claude")).toBe(false);
  });

  test("recent claude transcript + stamp lagging by >10min → claude warning with the /plugin hint", async () => {
    const lines = await run({ claudeSessionAgeMs: 2 * MIN, claudeStampAgeMs: 20 * MIN });
    expect(warnedFor(lines, "Claude")).toBe(true);
    expect(lines.some((l) => l.includes("/plugin"))).toBe(true);
  });

  test("stamp within 10-min grace of the newest transcript → healthy", async () => {
    const lines = await run({ claudeSessionAgeMs: 2 * MIN, claudeStampAgeMs: 9 * MIN });
    expect(warnedFor(lines, "Claude")).toBe(false);
  });

  // --- Fix B: false-positive suppression when the OTHER agent's CLI runs without the Nomo plugin ---

  test("codex NOT installed + recent rollouts, no stamp → NO warning (plain-Codex user)", async () => {
    // A paired user running plain Codex (no native plugin) leaves fresh rollouts but no stamp — the old
    // detector cried wolf; now the Codex check is gated on plugin.installed, so it stays quiet.
    const lines = await run({ codexInstalled: false, codexSessionAgeMs: 3 * MIN });
    expect(warnedFor(lines, "Codex")).toBe(false);
  });

  test("codex installed+trusted + recent rollouts, no stamp → STILL warns (#16430 silent-hooks case)", async () => {
    // The whole point of the detector: an installed-but-silent plugin (no stamp despite activity).
    const lines = await run({ codexInstalled: true, codexSessionAgeMs: 3 * MIN });
    expect(warnedFor(lines, "Codex")).toBe(true);
  });

  test("claude recent transcripts + NO stamp ever → NO warning (indistinguishable from not-installed)", async () => {
    // No claude stamp is indistinguishable from "the Nomo plugin isn't installed in Claude Code", so
    // the Claude check only warns when a stamp EXISTS but lags — never on a never-written stamp.
    const lines = await run({ claudeSessionAgeMs: 3 * MIN });
    expect(warnedFor(lines, "Claude")).toBe(false);
  });

  test("claude stamp EXISTS but lags the newest transcript by >10min → STILL warns (preserved true-positive)", async () => {
    const lines = await run({ claudeSessionAgeMs: 2 * MIN, claudeStampAgeMs: 20 * MIN });
    expect(warnedFor(lines, "Claude")).toBe(true);
  });
});

// --- runHook writes the per-agent hook-liveness stamp ------------------------------------------
//
// The stamp is what the detector above reads. runHook must rewrite <CC_DIR>/last-hook-<agent> on
// every invocation, BEFORE the pairing gate — so it lands even for a run whose POST fails. Spawns the
// REAL claude entry with a temp HOME (the faithful way to exercise the stdin-driven hook) and asserts
// the stamp exists with a fresh epoch-ms value, for both a claude and a turn_id-restamped-codex run.
describe("runHook per-agent hook-liveness stamp", () => {
  const rawKey = new Uint8Array(32).fill(9);
  const entry = join(import.meta.dir, "cc-status.ts");

  async function runAndReadStamp(payload: Record<string, unknown>): Promise<{ claude?: number; codex?: number }> {
    const home = await mkdtemp(join(tmpdir(), "cc-hook-stamp-"));
    try {
      const ccDir = join(home, ".config", "cc-status");
      await mkdir(join(ccDir, "sessions"), { recursive: true });
      await writeFile(join(ccDir, "config.json"), JSON.stringify({
        url: "http://127.0.0.1:9", pairingId: "p", pcSecret: "s", e2eKeyB64: b64url(rawKey),
      }));
      await writeFile(join(ccDir, "watchdog.pid"), String(process.pid));
      const proc = Bun.spawn({
        cmd: ["bun", entry],
        env: { ...process.env, HOME: home },
        stdin: Buffer.from(JSON.stringify(payload)),
        stdout: "ignore", stderr: "ignore",
      });
      await proc.exited;
      const read = async (agent: string): Promise<number | undefined> => {
        try { return Number.parseInt((await readFile(join(ccDir, `last-hook-${agent}`), "utf8")).trim(), 10); }
        catch { return undefined; }
      };
      return { claude: await read("claude"), codex: await read("codex") };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  test("a claude run stamps last-hook-claude (and not last-hook-codex)", async () => {
    const before = Date.now();
    const { claude, codex } = await runAndReadStamp({
      session_id: "stamp-claude", hook_event_name: "PreToolUse", tool_name: "Edit",
      cwd: "/x/api-status", transcript_path: "",
    });
    expect(claude).toBeGreaterThanOrEqual(before);
    expect(codex).toBeUndefined();
  }, 20000);

  test("a turn_id (codex) run stamps last-hook-codex (agent resolved from the payload)", async () => {
    const before = Date.now();
    const { claude, codex } = await runAndReadStamp({
      session_id: "stamp-codex", hook_event_name: "PreToolUse", tool_name: "apply_patch",
      cwd: "/x/api-status", turn_id: "t1", transcript_path: "",
    });
    expect(codex).toBeGreaterThanOrEqual(before);
    expect(claude).toBeUndefined();
  }, 20000);
});

// --- runHook turn_id sniff (D7.2 Codex compat-layer misfire guard) -----------------------------
//
// Codex ≥0.142 auto-discovers installed Claude Code plugins and can run cc-status.mjs (the CLAUDE
// entry, runHook("claude")) inside a Codex session. runHook must notice the Codex-only `turn_id` on
// stdin and restamp the session as codex. This spawns the REAL claude entry with an isolated temp
// HOME, pipes a hook payload on stdin, and reads back the written session record (+ decrypts its
// blob) to confirm the agent stamp — the only faithful way to exercise the stdin-parse guard.
describe("runHook turn_id sniff (claude entry invoked inside a Codex session)", () => {
  const rawKey = new Uint8Array(32).fill(9);
  const entry = join(import.meta.dir, "cc-status.ts");

  async function runClaudeEntry(payload: Record<string, unknown>, extraEnv: Record<string, string> = {}): Promise<{ agent?: string; blobAgent?: string; blobTitle?: string }> {
    const home = await mkdtemp(join(tmpdir(), "cc-hook-sniff-"));
    try {
      const ccDir = join(home, ".config", "cc-status");
      await mkdir(join(ccDir, "sessions"), { recursive: true });
      // A valid v2 config so the hook is live; url points at the discard port so the POST fails fast
      // (the session record is written BEFORE the fetch either way).
      await writeFile(join(ccDir, "config.json"), JSON.stringify({
        url: "http://127.0.0.1:9", pairingId: "p", pcSecret: "s", e2eKeyB64: b64url(rawKey),
      }));
      // Pre-seed a LIVE watchdog pidfile (this very test process) so the entry's ensureWatchdog()
      // no-ops instead of spawning a detached poller that would outlive the test.
      await writeFile(join(ccDir, "watchdog.pid"), String(process.pid));
      // Rollout EVIDENCE for the payload's session id: since the internal-job ghost guard, a codex-
      // restamped run with a never-tracked id and no transcript content is only mirrored when its
      // rollout exists under $CODEX_HOME/sessions — so these synthetic sessions get an (empty)
      // rollout file whose FILENAME carries the id, under the temp HOME's ~/.codex tree.
      const day = join(home, ".codex", "sessions", "2026", "07", "09");
      await mkdir(day, { recursive: true });
      await writeFile(join(day, `rollout-2026-07-09T12-00-00-${String(payload.session_id)}.jsonl`), "");

      const proc = Bun.spawn({
        cmd: ["bun", entry],
        env: { ...process.env, HOME: home, ...extraEnv },
        stdin: Buffer.from(JSON.stringify(payload)),
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;

      const rec = JSON.parse(await readFile(join(ccDir, "sessions", `${payload.session_id}.json`), "utf8")) as { agent?: string; blob?: string };
      const blob = rec.blob ? ((await decryptBlob(rawKey, rec.blob)) as { agent?: string; title?: string }) : undefined;
      return { agent: rec.agent, blobAgent: blob?.agent, blobTitle: blob?.title };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  test("stdin carrying a non-empty turn_id restamps the run agent codex (session record + blob)", async () => {
    const { agent, blobAgent } = await runClaudeEntry({
      session_id: "sniff-codex", hook_event_name: "PreToolUse", tool_name: "apply_patch",
      cwd: "/x/api-status", turn_id: "t1", transcript_path: "",
    });
    expect(agent).toBe("codex");
    expect(blobAgent).toBe("codex");
  }, 20000);

  test("stdin with NO turn_id stays claude (no agent key on the record or blob)", async () => {
    const { agent, blobAgent } = await runClaudeEntry({
      session_id: "sniff-claude", hook_event_name: "PreToolUse", tool_name: "Edit",
      cwd: "/x/api-status", transcript_path: "",
    });
    expect(agent).toBeUndefined();
    expect(blobAgent).toBeUndefined();
  }, 20000);

  // A CODEX-SHAPED payload (apply_patch tool + model/permission_mode extras) that arrives via the
  // claude entry WITHOUT a turn_id AND WITHOUT a codex transcript path (transcript_path: "") is NOT
  // restamped — NEITHER restamp signal fires, so it stays claude. This pins the conservative floor of
  // the guard: absent both a non-empty turn_id (Codex's per-turn events) and a "/.codex/" transcript
  // path (the session-scoped backstop exercised below), a run is never wrongly flipped to codex.
  test("a codex-shaped payload with NO turn_id and NO codex transcript path stays claude", async () => {
    const { agent, blobAgent } = await runClaudeEntry({
      session_id: "sniff-no-turnid", hook_event_name: "PreToolUse", tool_name: "apply_patch",
      cwd: "/x/api-status", model: "gpt-5-codex", permission_mode: "default", transcript_path: "",
    });
    expect(agent).toBeUndefined();
    expect(blobAgent).toBeUndefined();
  }, 20000);

  // The transcript-path backstop: session-scoped Codex events carry NO turn_id (observed in the wild
  // 2026-07-09 — such events flipped Codex sessions onto the Claude tab on the phone), but their
  // transcript_path still points under ~/.codex/sessions/. A claude-entry run whose payload has no
  // turn_id but a "/.codex/" transcript path IS restamped to codex (record + blob).
  test("no turn_id but a /.codex/ transcript path restamps the run agent codex", async () => {
    const { agent, blobAgent } = await runClaudeEntry({
      session_id: "sniff-codex-transcript", hook_event_name: "PreToolUse", tool_name: "apply_patch",
      cwd: "/x/api-status",
      transcript_path: "/Users/x/.codex/sessions/2026/07/09/rollout-2026-07-09T12-00-00-abcdef.jsonl",
    });
    expect(agent).toBe("codex");
    expect(blobAgent).toBe("codex");
  }, 20000);

  // The complement: a NORMAL Claude payload (no turn_id, transcript under ~/.claude/projects/) is
  // never restamped — the "/.claude/" path must not trip the "/.codex/" backstop.
  test("a normal Claude transcript path (~/.claude/projects) is never restamped", async () => {
    const { agent, blobAgent } = await runClaudeEntry({
      session_id: "sniff-claude-transcript", hook_event_name: "PreToolUse", tool_name: "Edit",
      cwd: "/x/api-status",
      transcript_path: "/Users/x/.claude/projects/-x-api-status/1234.jsonl",
    });
    expect(agent).toBeUndefined();
    expect(blobAgent).toBeUndefined();
  }, 20000);

  test("codex run picks up the session_index thread_name (PRIMARY title) end-to-end", async () => {
    // No transcript, but $CODEX_HOME/session_index.jsonl carries the clean thread_name — the whole
    // resolution chain runs in the spawned entry and the decrypted blob title is the index title.
    const codexHome = await mkdtemp(join(tmpdir(), "codex-home-e2e-"));
    try {
      const sid = "019e1d05-4cf4-7751-8c59-b9573047900e";
      await writeFile(join(codexHome, "session_index.jsonl"),
        JSON.stringify({ id: sid, thread_name: "Stock monitor automation", updated_at: "2026-05-12T16:29:14Z" }));
      // CODEX_HOME overrides the helper's ~/.codex rollout fixture, so this home needs its own
      // rollout evidence or the internal-job ghost guard would (correctly) defer the session.
      const day = join(codexHome, "sessions", "2026", "05", "12");
      await mkdir(day, { recursive: true });
      await writeFile(join(day, `rollout-2026-05-12T16-29-14-${sid}.jsonl`), "");
      const { blobAgent, blobTitle } = await runClaudeEntry({
        session_id: sid, hook_event_name: "PreToolUse", tool_name: "apply_patch",
        cwd: "/x/api-status", turn_id: "t1", transcript_path: "",
      }, { CODEX_HOME: codexHome });
      expect(blobAgent).toBe("codex");
      expect(blobTitle).toBe("Stock monitor automation");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  }, 20000);
});

// --- runHook provisional reconcile (a real codex hook ends the watchdog's discovered provisional) --
//
// Codex fires no hook at session OPEN (openai/codex#15269), so the watchdog surfaces a live Codex TUI
// as a PROVISIONAL session keyed on the TUI pid. When the REAL codex hook finally fires, runHook must
// end + delete that provisional (matched by pid — the hook's process.ppid IS the TUI). This spawns the
// REAL codex entry with a temp HOME: the spawned bun's process.ppid is THIS test runner's pid, so a
// provisional keyed on `process.pid` is the reconcile's equality match. Deletion is GATED on a
// delivered (2xx) op:end POST: a scripted local server exercises the success path, and the discard
// port exercises the failure path — the file must SURVIVE a failed POST (it's the only retry handle;
// unconditional deletion orphaned a worker ghost row for hours, the codex-pid-40738 incident) while
// the real record, written BEFORE the reconcile, marks the survivor for the sweep backstop.
describe("runHook provisional reconcile (codex entry retires a matching provisional)", () => {
  const rawKey = new Uint8Array(32).fill(9);
  const entry = join(import.meta.dir, "codex-status.ts");

  async function fileExists(p: string): Promise<boolean> {
    return readFile(p, "utf8").then(() => true, () => false);
  }

  /** A local server that 200s every POST, so the reconcile's op:end counts as delivered. */
  function startOkServer(): { url: string; close: () => void } {
    const server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 200 }) });
    return { url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
  }

  async function runReconcile(provPid: number, url: string): Promise<{ provGone: boolean; realAgent?: string; home: string; ccDir: string; sessionsDir: string }> {
    const home = await mkdtemp(join(tmpdir(), "cc-reconcile-"));
    const ccDir = join(home, ".config", "cc-status");
    const sessionsDir = join(ccDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(ccDir, "config.json"), JSON.stringify({
      url, pairingId: "p", pcSecret: "s", e2eKeyB64: b64url(rawKey),
    }));
    await writeFile(join(ccDir, "watchdog.pid"), String(process.pid)); // no detached poller
    const provFile = join(sessionsDir, `codex-pid-${provPid}.json`);
    await writeFile(provFile, JSON.stringify({
      pid: provPid, machine: "mac", label: "proj", ts: Date.now(),
      lastEvent: "sessionStart", op: "start", prio: 0, blob: "X", provisional: true, agent: "codex",
    }));
    // Rollout evidence for the real session (see the sniff helper's note): without it the internal-
    // job ghost guard would defer the never-tracked id before the provisional reconcile runs.
    const day = join(home, ".codex", "sessions", "2026", "07", "09");
    await mkdir(day, { recursive: true });
    await writeFile(join(day, "rollout-2026-07-09T12-00-00-real-codex-sess.jsonl"), "");
    const proc = Bun.spawn({
      cmd: ["bun", entry],
      env: { ...process.env, HOME: home },
      stdin: Buffer.from(JSON.stringify({
        session_id: "real-codex-sess", hook_event_name: "PreToolUse", tool_name: "apply_patch",
        cwd: "/x/api-status", turn_id: "t1", transcript_path: "",
      })),
      stdout: "ignore", stderr: "ignore",
    });
    await proc.exited;
    const provGone = !(await fileExists(provFile));
    let realAgent: string | undefined;
    try {
      realAgent = (JSON.parse(await readFile(join(sessionsDir, "real-codex-sess.json"), "utf8")) as { agent?: string }).agent;
    } catch { /* no real record */ }
    return { provGone, realAgent, home, ccDir, sessionsDir };
  }

  test("a matching provisional is ended + deleted on a DELIVERED (2xx) op:end; the real session is tracked", async () => {
    // The spawned entry's process.ppid is this runner's pid, so a provisional keyed on it matches.
    const srv = startOkServer();
    const { provGone, realAgent, home } = await runReconcile(process.pid, srv.url);
    try {
      expect(provGone).toBe(true);
      expect(realAgent).toBe("codex");
    } finally {
      srv.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 20000);

  test("a FAILED op:end POST leaves the provisional file (the retry handle) and the sweep backstop can retire it", async () => {
    // The discard port fails every POST fast. The provisional must SURVIVE — deleting it would strand
    // the worker's ghost row with nothing left to retry from (the codex-pid-40738 incident) — and the
    // real record (written BEFORE the reconcile runs) must already exist, so the surviving provisional
    // is exactly what reconcileProvisionalsSweep's covered-by-real matcher retries within a sweep.
    const { provGone, realAgent, home, ccDir, sessionsDir } = await runReconcile(process.pid, "http://127.0.0.1:9");
    try {
      expect(provGone).toBe(false); // the retry handle survives the failed POST
      expect(realAgent).toBe("codex"); // reordering kept the normal path: the real session is tracked
      // The survivor is "covered by real" → the watchdog sweep matches it…
      const entries: { sessionId: string; rec: SessionRecord }[] = [];
      for (const f of await readdir(sessionsDir)) {
        if (f.endsWith(".json")) entries.push({ sessionId: basename(f, ".json"), rec: JSON.parse(await readFile(join(sessionsDir, f), "utf8")) as SessionRecord });
      }
      expect(provisionalsCoveredByReal(entries)).toEqual([`codex-pid-${process.pid}`]);
      // …and a delivered retry retires it: end POSTed, file deleted.
      const config = parseConfig(await readFile(join(ccDir, "config.json"), "utf8"))!;
      const posted: string[] = [];
      await reconcileProvisionalsSweep(config, {
        post: async (body: object) => { posted.push((body as { sessionId: string }).sessionId); return "delivered"; },
        readEntries: async () => entries,
        deleteRecord: (sessionId: string) => unlink(join(sessionsDir, `${sessionId}.json`)),
      });
      expect(posted).toEqual([`codex-pid-${process.pid}`]);
      expect(await fileExists(join(sessionsDir, `codex-pid-${process.pid}.json`))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 20000);

  test("a NON-matching provisional (unrelated pid) is left untouched", async () => {
    // 999_999 is neither the child's ppid nor any of its ancestors → no reconcile.
    const srv = startOkServer();
    const provFileName = `codex-pid-999999.json`;
    const { home, sessionsDir } = await runReconcile(999_999, srv.url);
    try {
      expect(await fileExists(join(sessionsDir, provFileName))).toBe(true);
    } finally {
      srv.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 20000);
});

// --- runHook startedAt precedence (hook.ts: `cachedStart ?? transcriptStartMs`) -------------
//
// The envelope's startedAt — and the sessionStartedAt written back into the record — resolves as
// `cachedStart ?? transcriptStartMs(head)`: a record that ALREADY cached a start wins over the
// transcript head (so the start survives the transcript later vanishing and is never re-parsed), and
// with no cache the transcript head's first timestamp is used. This spawns the REAL claude entry and
// reads back the written record's sessionStartedAt — the faithful way to exercise runHook's resolution
// (the blob doesn't carry startedAt, but trackSession persists the resolved value into the record).
describe("runHook startedAt precedence (cached record start wins over the transcript head)", () => {
  const rawKey = new Uint8Array(32).fill(9);
  const entry = join(import.meta.dir, "cc-status.ts");
  const transcriptHeadTs = Date.parse("2026-07-07T16:15:00.000Z"); // the transcript's head timestamp

  async function runWithStart(opts: { cachedStart?: number }): Promise<number | undefined> {
    const home = await mkdtemp(join(tmpdir(), "cc-hook-start-"));
    try {
      const ccDir = join(home, ".config", "cc-status");
      await mkdir(join(ccDir, "sessions"), { recursive: true });
      // A live v2 config so the hook runs; the POST fails fast against the discard port (127.0.0.1:9),
      // but the record — carrying the resolved sessionStartedAt — is written BEFORE the fetch.
      await writeFile(join(ccDir, "config.json"), JSON.stringify({
        url: "http://127.0.0.1:9", pairingId: "p", pcSecret: "s", e2eKeyB64: b64url(rawKey),
      }));
      await writeFile(join(ccDir, "watchdog.pid"), String(process.pid)); // pre-seeded live → no detached spawn

      const sid = "start-precedence";
      // A transcript whose head timestamp DIFFERS from any cached start, so the winner is unambiguous.
      const transcriptPath = join(home, "transcript.jsonl");
      await writeFile(transcriptPath, JSON.stringify({ type: "user", timestamp: "2026-07-07T16:15:00.000Z" }));
      // Optionally pre-seed a record carrying a cached sessionStartedAt (as an earlier hook would have).
      if (opts.cachedStart !== undefined) {
        await writeFile(join(ccDir, "sessions", `${sid}.json`), JSON.stringify({
          pid: process.ppid, machine: "m", label: "l", ts: Date.now(), sessionStartedAt: opts.cachedStart,
        }));
      }

      const proc = Bun.spawn({
        cmd: ["bun", entry],
        env: { ...process.env, HOME: home },
        stdin: Buffer.from(JSON.stringify({
          session_id: sid, hook_event_name: "PreToolUse", tool_name: "Edit",
          cwd: "/x/api-status", transcript_path: transcriptPath,
        })),
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;

      const rec = JSON.parse(await readFile(join(ccDir, "sessions", `${sid}.json`), "utf8")) as { sessionStartedAt?: number };
      return rec.sessionStartedAt;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  test("a cached sessionStartedAt on the record WINS over the transcript head timestamp", async () => {
    // cachedStart differs from the transcript head, so a cached-wins result is unambiguous.
    expect(await runWithStart({ cachedStart: 111_000 })).toBe(111_000);
  }, 20000);

  test("with no cached start, it falls back to the transcript head's first timestamp", async () => {
    expect(await runWithStart({})).toBe(transcriptHeadTs);
  }, 20000);
});

// --- runHook label pinning (first-seen cwd wins over the event's live cwd) --------------------
//
// hook.ts resolves `label = existingRecord.label ?? basename(input.cwd)`: once a session record holds
// a label, every later hook reuses it verbatim — a mid-session `cd` must not silently rename the phone
// row / island folder chip (observed live: "api-status" → "server"). This spawns the REAL claude entry
// and reads back the record the run rewrote, the same faithful harness as the startedAt suite above.
describe("runHook label pinning (a mid-session cd must not rename the session)", () => {
  const rawKey = new Uint8Array(32).fill(9);
  const entry = join(import.meta.dir, "cc-status.ts");

  async function runWithCwd(opts: { seededLabel?: string; cwd: string }): Promise<string | undefined> {
    const home = await mkdtemp(join(tmpdir(), "cc-hook-label-"));
    try {
      const ccDir = join(home, ".config", "cc-status");
      await mkdir(join(ccDir, "sessions"), { recursive: true });
      await writeFile(join(ccDir, "config.json"), JSON.stringify({
        url: "http://127.0.0.1:9", pairingId: "p", pcSecret: "s", e2eKeyB64: b64url(rawKey),
      }));
      await writeFile(join(ccDir, "watchdog.pid"), String(process.pid)); // pre-seeded live → no detached spawn
      const sid = "label-pinning";
      // Optionally pre-seed a record carrying the FIRST-SEEN label, as the session's first hook would have.
      if (opts.seededLabel !== undefined) {
        await writeFile(join(ccDir, "sessions", `${sid}.json`), JSON.stringify({
          pid: process.ppid, machine: "m", label: opts.seededLabel, ts: Date.now(),
        }));
      }
      const proc = Bun.spawn({
        cmd: ["bun", entry],
        env: { ...process.env, HOME: home },
        stdin: Buffer.from(JSON.stringify({
          session_id: sid, hook_event_name: "PreToolUse", tool_name: "Edit",
          cwd: opts.cwd, transcript_path: "",
        })),
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
      return (JSON.parse(await readFile(join(ccDir, "sessions", `${sid}.json`), "utf8")) as { label?: string }).label;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  test("a record's existing label WINS over a later event's changed cwd (the `cd server` repro)", async () => {
    expect(await runWithCwd({ seededLabel: "api-status", cwd: "/Users/x/api-status/server" })).toBe("api-status");
  }, 20000);

  test("with no record yet, the first event stamps the label from its cwd (unchanged first-event behavior)", async () => {
    expect(await runWithCwd({ cwd: "/Users/x/api-status/server" })).toBe("server");
  }, 20000);
});

// --- runHook gone-strike teardown (a revoked pairing must stop POSTing forever) -----------------
//
// The hook's POST path counts CONSECUTIVE "gone" responses (404 = pairing deleted, 410 = dormant-GC'd)
// in a `gone-strikes` marker next to last-send; at GONE_STRIKE_LIMIT (2) it tears the local pairing
// down exactly like the watchdog (removeRevokedConfig: config.json + last-send + gone-strikes). Any
// success or non-gone status resets the streak; 401/403/5xx never tear down. This spawns the REAL
// claude entry against a tiny local server whose per-request status is scripted, then inspects the
// on-disk config/marker — the faithful way to exercise the whole POST-response branch.
describe("runHook gone-strike teardown (revoked pairing stops POSTing forever)", () => {
  const rawKey = new Uint8Array(32).fill(9);
  const entry = join(import.meta.dir, "cc-status.ts");

  // A server whose response status is driven by a scripted list: request i returns statuses[i],
  // clamping to the last entry once the list drains (so [404] answers every request 404, while
  // [404, 200] answers the 2nd+ requests 200). port:0 → an ephemeral port read back off `.port`.
  function startServer(statuses: number[]): { url: string; close: () => void } {
    let i = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        const s = statuses[Math.min(i, statuses.length - 1)];
        i++;
        return new Response(s === 200 ? "{}" : "gone", { status: s });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
  }

  async function setupHome(url: string): Promise<{ home: string; ccDir: string }> {
    const home = await mkdtemp(join(tmpdir(), "cc-hook-gone-"));
    const ccDir = join(home, ".config", "cc-status");
    await mkdir(join(ccDir, "sessions"), { recursive: true });
    // A live v2 config pointed at the scripted server. Pre-seed a live watchdog pidfile (this test
    // process) so the entry's ensureWatchdog() no-ops instead of spawning a detached poller.
    await writeFile(join(ccDir, "config.json"), JSON.stringify({
      url, pairingId: "p", pcSecret: "s", e2eKeyB64: b64url(rawKey),
    }));
    await writeFile(join(ccDir, "watchdog.pid"), String(process.pid));
    return { home, ccDir };
  }

  async function runOnce(home: string, sid: string): Promise<void> {
    const proc = Bun.spawn({
      cmd: ["bun", entry],
      env: { ...process.env, HOME: home },
      stdin: Buffer.from(JSON.stringify({
        session_id: sid, hook_event_name: "PreToolUse", tool_name: "Edit",
        cwd: "/x/api-status", transcript_path: "",
      })),
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  }

  async function fileExists(p: string): Promise<boolean> {
    try { await stat(p); return true; } catch { return false; }
  }

  test("two consecutive 404s tear the pairing down and clean the strikes marker", async () => {
    const srv = startServer([404]);
    const { home, ccDir } = await setupHome(srv.url);
    try {
      await runOnce(home, "gone-a");
      // First 404 = one strike: config kept, marker at 1.
      expect(await fileExists(join(ccDir, "config.json"))).toBe(true);
      expect((await readFile(join(ccDir, "gone-strikes"), "utf8")).trim()).toBe("1");

      await runOnce(home, "gone-b");
      // Second consecutive 404 hits the limit: config removed, strikes marker cleaned up.
      expect(await fileExists(join(ccDir, "config.json"))).toBe(false);
      expect(await fileExists(join(ccDir, "gone-strikes"))).toBe(false);
    } finally {
      srv.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 20000);

  test("a 404 then a 200 keeps the pairing and resets the strike counter", async () => {
    const srv = startServer([404, 200]);
    const { home, ccDir } = await setupHome(srv.url);
    try {
      await runOnce(home, "reset-a"); // 404 → one strike
      expect((await readFile(join(ccDir, "gone-strikes"), "utf8")).trim()).toBe("1");
      await runOnce(home, "reset-b"); // 200 → streak broken
      expect(await fileExists(join(ccDir, "config.json"))).toBe(true);
      expect(await fileExists(join(ccDir, "gone-strikes"))).toBe(false);
    } finally {
      srv.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 20000);

  test("two consecutive 410s tear the pairing down (the dormant-GC path, same as 404×2)", async () => {
    const srv = startServer([410]);
    const { home, ccDir } = await setupHome(srv.url);
    try {
      await runOnce(home, "gone410-a"); // first 410 = one strike
      expect(await fileExists(join(ccDir, "config.json"))).toBe(true);
      expect((await readFile(join(ccDir, "gone-strikes"), "utf8")).trim()).toBe("1");

      await runOnce(home, "gone410-b"); // second consecutive 410 hits the limit
      expect(await fileExists(join(ccDir, "config.json"))).toBe(false);
      expect(await fileExists(join(ccDir, "gone-strikes"))).toBe(false);
    } finally {
      srv.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 20000);

  test("a 5xx between two 404s resets the streak → no teardown", async () => {
    // 404 (strike 1) → 500 (transient: streak cleared) → 404 (strike 1 again, not 2) → pairing survives.
    const srv = startServer([404, 500, 404]);
    const { home, ccDir } = await setupHome(srv.url);
    try {
      await runOnce(home, "reset5xx-a"); // 404 → strike 1
      expect((await readFile(join(ccDir, "gone-strikes"), "utf8")).trim()).toBe("1");
      await runOnce(home, "reset5xx-b"); // 500 → streak broken, marker cleared
      expect(await fileExists(join(ccDir, "gone-strikes"))).toBe(false);
      await runOnce(home, "reset5xx-c"); // 404 → strike 1 again (NOT 2 → no teardown)
      expect(await fileExists(join(ccDir, "config.json"))).toBe(true);
      expect((await readFile(join(ccDir, "gone-strikes"), "utf8")).trim()).toBe("1");
    } finally {
      srv.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 20000);

  test("a single 410 counts one strike and keeps the pairing", async () => {
    const srv = startServer([410]);
    const { home, ccDir } = await setupHome(srv.url);
    try {
      await runOnce(home, "gone410");
      expect(await fileExists(join(ccDir, "config.json"))).toBe(true);
      expect((await readFile(join(ccDir, "gone-strikes"), "utf8")).trim()).toBe("1");
    } finally {
      srv.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 20000);

  test("401 never tears down, even repeated, and writes no strike marker", async () => {
    const srv = startServer([401]);
    const { home, ccDir } = await setupHome(srv.url);
    try {
      await runOnce(home, "auth-a");
      await runOnce(home, "auth-b");
      expect(await fileExists(join(ccDir, "config.json"))).toBe(true);
      expect(await fileExists(join(ccDir, "gone-strikes"))).toBe(false);
    } finally {
      srv.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 20000);
});

// --- runHook turnStartedAt stamp-and-cache (hook.ts: fresh on UserPromptSubmit, cached after) --
//
// The per-turn anchor's lifecycle crosses hook invocations: UserPromptSubmit stamps a FRESH epoch-
// seconds value and trackSession caches it in the record; the turn's later hooks (PreToolUse/…) read
// the cache and thread the SAME value into their blobs; with no cache and no prompt the blob simply
// omits it. Spawning the REAL claude entry and reading back the record + decrypted blob is the
// faithful way to exercise that write→exit→fresh-read chain (same harness as the tests above).
describe("runHook turnStartedAt (UserPromptSubmit stamps + caches; later hooks re-use; unknown omits)", () => {
  const rawKey = new Uint8Array(32).fill(9);
  const entry = join(import.meta.dir, "cc-status.ts");

  async function runTurnHook(
    payload: Record<string, unknown>, opts: { cachedTurn?: number } = {},
  ): Promise<{ recordTurn?: number; blobTurn?: number }> {
    const home = await mkdtemp(join(tmpdir(), "cc-hook-turn-"));
    try {
      const ccDir = join(home, ".config", "cc-status");
      await mkdir(join(ccDir, "sessions"), { recursive: true });
      // A live v2 config so the hook runs; the POST fails fast against the discard port (127.0.0.1:9),
      // but the record — carrying the resolved turnStartedAt — is written BEFORE the fetch.
      await writeFile(join(ccDir, "config.json"), JSON.stringify({
        url: "http://127.0.0.1:9", pairingId: "p", pcSecret: "s", e2eKeyB64: b64url(rawKey),
      }));
      await writeFile(join(ccDir, "watchdog.pid"), String(process.pid)); // pre-seeded live → no detached spawn
      // Optionally pre-seed a record carrying a cached turnStartedAt (as the turn's prompt hook would have).
      if (opts.cachedTurn !== undefined) {
        await writeFile(join(ccDir, "sessions", `${payload.session_id}.json`), JSON.stringify({
          pid: process.ppid, machine: "m", label: "l", ts: Date.now(), turnStartedAt: opts.cachedTurn,
        }));
      }

      const proc = Bun.spawn({
        cmd: ["bun", entry],
        env: { ...process.env, HOME: home },
        stdin: Buffer.from(JSON.stringify(payload)),
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;

      const rec = JSON.parse(await readFile(join(ccDir, "sessions", `${payload.session_id}.json`), "utf8")) as { turnStartedAt?: number; blob?: string };
      const blob = rec.blob ? ((await decryptBlob(rawKey, rec.blob)) as { turnStartedAt?: number }) : undefined;
      return { recordTurn: rec.turnStartedAt, blobTurn: blob?.turnStartedAt };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  test("UserPromptSubmit stamps a FRESH epoch-seconds anchor and caches it (record + blob agree)", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { recordTurn, blobTurn } = await runTurnHook({
      session_id: "turn-prompt", hook_event_name: "UserPromptSubmit", cwd: "/x/api-status", transcript_path: "",
    });
    const after = Math.ceil(Date.now() / 1000);
    // Epoch SECONDS (an integer inside the run window), not the ms the rest of the plugin uses.
    expect(Number.isInteger(recordTurn)).toBe(true);
    expect(recordTurn!).toBeGreaterThanOrEqual(before);
    expect(recordTurn!).toBeLessThanOrEqual(after);
    expect(blobTurn).toBe(recordTurn!);
  }, 20000);

  test("a later PreToolUse re-uses the CACHED anchor (threaded into its blob, re-cached verbatim)", async () => {
    const { recordTurn, blobTurn } = await runTurnHook({
      session_id: "turn-tool", hook_event_name: "PreToolUse", tool_name: "Edit", cwd: "/x/api-status", transcript_path: "",
    }, { cachedTurn: 1_751_900_000 });
    expect(recordTurn).toBe(1_751_900_000);
    expect(blobTurn).toBe(1_751_900_000);
  }, 20000);

  test("no cache and no prompt yet → the record and blob both omit the anchor (widget falls back)", async () => {
    const { recordTurn, blobTurn } = await runTurnHook({
      session_id: "turn-unknown", hook_event_name: "PreToolUse", tool_name: "Edit", cwd: "/x/api-status", transcript_path: "",
    });
    expect(recordTurn).toBeUndefined();
    expect(blobTurn).toBeUndefined();
  }, 20000);

  test("a UserPromptSubmit RESTAMPS over a stale cached anchor (a new turn resets the timer)", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { recordTurn } = await runTurnHook({
      session_id: "turn-restamp", hook_event_name: "UserPromptSubmit", cwd: "/x/api-status", transcript_path: "",
    }, { cachedTurn: 1_000_000 }); // an hour-old anchor from the previous turn
    expect(recordTurn!).toBeGreaterThanOrEqual(before); // fresh, not the stale 1_000_000
  }, 20000);
});

// --- runHook title resolution (tail ai-title reaches the blob; found titles never regress) -------
//
// The long-transcript title fix, end to end: on a 3.7 MB transcript the freshest ai-title lives near
// EOF — outside the 128 KB head window — so the claude adapter now also scans a bounded transcript
// TAIL (hook.ts threads transcriptPath into adapter.title). And `title` resolves as
// `readTitle() ?? existingRecord.title`, so a hook whose bounded reads find nothing must not regress
// an already-found title to "" in the LIVE blob (previously only the record cache was protected).
// Spawning the REAL claude entry and reading back the record + decrypted blob is the faithful way to
// exercise the whole chain (same harness as the turnStartedAt suite above).
describe("runHook title (tail ai-title reaches the blob; a found title never regresses to empty)", () => {
  const rawKey = new Uint8Array(32).fill(9);
  const entry = join(import.meta.dir, "cc-status.ts");

  async function runTitleHook(
    opts: { transcript?: string; cachedTitle?: string },
  ): Promise<{ recordTitle?: string; blobTitle?: string }> {
    const home = await mkdtemp(join(tmpdir(), "cc-hook-title-"));
    try {
      const ccDir = join(home, ".config", "cc-status");
      await mkdir(join(ccDir, "sessions"), { recursive: true });
      // A live v2 config so the hook runs; the POST fails fast against the discard port (127.0.0.1:9),
      // but the record — carrying the resolved title + blob — is written BEFORE the fetch.
      await writeFile(join(ccDir, "config.json"), JSON.stringify({
        url: "http://127.0.0.1:9", pairingId: "p", pcSecret: "s", e2eKeyB64: b64url(rawKey),
      }));
      await writeFile(join(ccDir, "watchdog.pid"), String(process.pid)); // pre-seeded live → no detached spawn
      const sid = "title-resolution";
      let transcriptPath = "";
      if (opts.transcript !== undefined) {
        transcriptPath = join(home, "transcript.jsonl");
        await writeFile(transcriptPath, opts.transcript);
      }
      // Optionally pre-seed a record carrying a cached title, as an earlier hook that found one would.
      if (opts.cachedTitle !== undefined) {
        await writeFile(join(ccDir, "sessions", `${sid}.json`), JSON.stringify({
          pid: process.ppid, machine: "m", label: "l", ts: Date.now(), title: opts.cachedTitle,
        }));
      }
      const proc = Bun.spawn({
        cmd: ["bun", entry],
        env: { ...process.env, HOME: home },
        stdin: Buffer.from(JSON.stringify({
          session_id: sid, hook_event_name: "PreToolUse", tool_name: "Edit",
          cwd: "/x/api-status", transcript_path: transcriptPath,
        })),
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
      const rec = JSON.parse(await readFile(join(ccDir, "sessions", `${sid}.json`), "utf8")) as { title?: string; blob?: string };
      const blob = rec.blob ? ((await decryptBlob(rawKey, rec.blob)) as { title?: string }) : undefined;
      return { recordTitle: rec.title, blobTitle: blob?.title };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  test("an ai-title BEYOND the 128 KB head window still reaches the record and the live blob (the 3.7 MB repro)", async () => {
    // The real-world shape, shrunk: the first user line alone overflows the head window (readPrefix
    // slices it mid-JSON → unparseable → the head yields NOTHING), and the only ai-title sits after
    // it — head-only resolution stayed empty forever; the tail read must find it.
    const giantFirstLine = JSON.stringify({ type: "user", message: { content: "z".repeat(140 * 1024) } });
    const transcript = [giantFirstLine, `{"type":"ai-title","aiTitle":"Ship the tail scan"}`].join("\n");
    const { recordTitle, blobTitle } = await runTitleHook({ transcript });
    expect(recordTitle).toBe("Ship the tail scan");
    expect(blobTitle).toBe("Ship the tail scan");
  }, 20000);

  test("a hook that resolves NO title keeps the record's cached title in the live blob (no regress to empty)", async () => {
    const { recordTitle, blobTitle } = await runTitleHook({ cachedTitle: "Cached title" }); // no transcript at all
    expect(recordTitle).toBe("Cached title");
    expect(blobTitle).toBe("Cached title"); // previously the live blob regressed to title:""
  }, 20000);

  test("a freshly resolved title still UPGRADES a stale cached one (the backstop is a fallback, not a pin)", async () => {
    const { recordTitle, blobTitle } = await runTitleHook({
      transcript: `{"type":"ai-title","aiTitle":"Fresh topic"}`, cachedTitle: "Old topic",
    });
    expect(recordTitle).toBe("Fresh topic");
    expect(blobTitle).toBe("Fresh topic");
  }, 20000);

  test("no transcript and no cache → title stays empty in the blob (unchanged no-title behavior)", async () => {
    const { recordTitle, blobTitle } = await runTitleHook({});
    expect(recordTitle).toBeUndefined(); // trackSession omits an empty title
    expect(blobTitle).toBe(""); // buildBlob's `title ?? ""` — the phone falls back to the label
  }, 20000);
});
