import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { adapterFor, allAdapters, claudeAdapter, codexAdapter } from "./adapter";

// The adapter surface is the per-agent half of the hook pipeline. These cover the two branches that
// actually diverge (title resolution + interrupt detection) plus the static config each adapter
// carries; the deep title/interrupt parser coverage lives in cc-status.test.ts / cc-watchdog.test.ts
// (which import those parsers through the ./cc-status and ./cc-watchdog re-exports).

describe("adapterFor", () => {
  test("selects by kind, defaulting to claude", () => {
    expect(adapterFor("codex")).toBe(codexAdapter);
    expect(adapterFor("claude")).toBe(claudeAdapter);
  });

  test("kinds match the on-disk literals", () => {
    expect(claudeAdapter.kind).toBe("claude");
    expect(codexAdapter.kind).toBe("codex");
  });
});

describe("static config", () => {
  test("session matchers", () => {
    expect(claudeAdapter.sessionMatch("abc.jsonl")).toBe(true);
    expect(claudeAdapter.sessionMatch("rollout-1.jsonl")).toBe(true);
    expect(claudeAdapter.sessionMatch("abc.json")).toBe(false);
    expect(codexAdapter.sessionMatch("rollout-2026-07-08.jsonl")).toBe(true);
    expect(codexAdapter.sessionMatch("abc.jsonl")).toBe(false); // codex requires the rollout- prefix
  });

  test("hook-stamp paths + tool-detail halves", () => {
    expect(claudeAdapter.hookStampPath().endsWith("last-hook-claude")).toBe(true);
    expect(codexAdapter.hookStampPath().endsWith("last-hook-codex")).toBe(true);
    expect(claudeAdapter.toolDetail.Bash).toBe("running");
    expect(codexAdapter.toolDetail.apply_patch).toBe("editing");
    expect(claudeAdapter.toolDetail.apply_patch).toBeUndefined(); // halves stay separate
  });
});

describe("discovery seam (blobAgentFields + allAdapters + discoverLive capability)", () => {
  test("blobAgentFields: claude omits the agent key, codex yields agent:'codex'", () => {
    expect(claudeAdapter.blobAgentFields).toEqual({});
    expect(codexAdapter.blobAgentFields).toEqual({ agent: "codex" });
  });

  test("allAdapters is exactly the two concrete adapters (so the daemon can drive per-agent steps)", () => {
    expect(allAdapters).toEqual([claudeAdapter, codexAdapter]);
  });

  test("claude implements NO discoverLive (its SessionStart fires at true open)", () => {
    expect(claudeAdapter.discoverLive).toBeUndefined();
  });

  test("codex implements discoverLive; the seam commit's stub returns no discoveries", async () => {
    expect(typeof codexAdapter.discoverLive).toBe("function");
    expect(await codexAdapter.discoverLive!([])).toEqual([]);
  });
});

describe("claude title", () => {
  test("prefers ai-title, falls back to first user prompt, else undefined", async () => {
    const aiTitle = await claudeAdapter.title({
      sessionId: randomUUID(), input: {},
      prefix: `{"type":"ai-title","aiTitle":"Refactor the adapter"}`,
    });
    expect(aiTitle).toBe("Refactor the adapter");

    const userTitle = await claudeAdapter.title({
      sessionId: randomUUID(), input: {},
      prefix: `{"type":"user","message":{"content":"Fix the flaky test"}}`,
    });
    expect(userTitle).toBe("Fix the flaky test");

    expect(await claudeAdapter.title({ sessionId: randomUUID(), input: {}, prefix: "" })).toBeUndefined();
  });
});

describe("codex title", () => {
  test("uses the UserPromptSubmit prompt when index + rollout give nothing", async () => {
    // A random sessionId can't match anything in a real session_index.jsonl, so the index lookup
    // yields undefined and we fall through to the raw prompt.
    const title = await codexAdapter.title({
      sessionId: randomUUID(), prefix: "",
      input: { hook_event_name: "UserPromptSubmit", prompt: "**Add** the `codex` adapter" },
    });
    expect(title).toBe("Add the codex adapter");
  });

  test("no prompt fallback outside UserPromptSubmit", async () => {
    const title = await codexAdapter.title({
      sessionId: randomUUID(), prefix: "",
      input: { hook_event_name: "Stop", prompt: "ignored" },
    });
    expect(title).toBeUndefined();
  });
});

describe("detectInterrupt", () => {
  test("claude keys on the interrupt marker in the last turn line", () => {
    expect(claudeAdapter.detectInterrupt(`{"type":"assistant","message":"[Request interrupted by user]"}`)).toBe(true);
    expect(claudeAdapter.detectInterrupt(`{"type":"assistant","message":"all done"}`)).toBe(false);
    expect(claudeAdapter.detectInterrupt("")).toBe(false);
  });

  test("codex keys on the last turn-lifecycle event being turn_aborted", () => {
    expect(codexAdapter.detectInterrupt(`{"type":"event_msg","payload":{"type":"turn_aborted"}}`)).toBe(true);
    expect(codexAdapter.detectInterrupt(`{"type":"event_msg","payload":{"type":"task_complete"}}`)).toBe(false);
    // a later task_started boundary after an abort means the turn resumed → not interrupted
    expect(codexAdapter.detectInterrupt(
      `{"type":"event_msg","payload":{"type":"turn_aborted"}}\n{"type":"event_msg","payload":{"type":"task_started"}}`,
    )).toBe(false);
  });
});
