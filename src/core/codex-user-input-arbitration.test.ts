import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CODEX_INPUT_BRIDGE_WAIT_MS,
  CODEX_INPUT_FALLBACK_TTL_MS,
  clearCodexInputFallback,
  codexInputBridgeCanServe,
  codexInputFallbackOwnsRequest,
  markCodexInputBridgeReady,
  markCodexInputFallback,
} from "./codex-user-input-arbitration";
import type { CodexUserInputRequest } from "./codex-app-server-client";

const toolInput = {
  questions: [{
    id: "deploy", header: "Deploy", question: "Which deployment?",
    options: [{ label: "Blue", description: "Use blue" }, { label: "Green", description: "Use green" }],
  }],
};

function request(over: Partial<CodexUserInputRequest> = {}): CodexUserInputRequest {
  return {
    identity: {
      connectionEpoch: 1, requestId: 7, threadId: "thread-1", turnId: "turn-1", itemId: "item-1",
    },
    questions: [{
      ...toolInput.questions[0], isOther: false, isSecret: false,
    }],
    autoResolutionMs: null,
    receivedAtMs: 1_000,
    ...over,
  };
}

describe("Codex request_user_input arbitration markers", () => {
  test("a live subscribed bridge lease serves an answerable shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-input-arb-"));
    try {
      await markCodexInputBridgeReady("thread-1", { sessionsDir: dir, now: () => 10_000, pid: 44 });
      expect(await codexInputBridgeCanServe("thread-1", "turn-1", toolInput, {
        sessionsDir: dir, now: () => 10_100, isPidAlive: (pid) => pid === 44,
        sleep: async () => { throw new Error("a live lease must not wait"); },
      })).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an absent bridge fails to fallback after one bounded wait", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-input-arb-"));
    let waited = 0;
    try {
      expect(await codexInputBridgeCanServe("thread-1", "turn-1", toolInput, {
        sessionsDir: dir, now: () => 10_000, isPidAlive: () => false,
        sleep: async (ms) => { waited += ms; },
      })).toBe(false);
      expect(waited).toBe(CODEX_INPUT_BRIDGE_WAIT_MS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a bridge-rejected secret or >3-question shape falls back without waiting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-input-arb-"));
    let sleeps = 0;
    try {
      await markCodexInputBridgeReady("thread-1", { sessionsDir: dir, now: () => 10_000, pid: 44 });
      const secret = { questions: [{ ...toolInput.questions[0], isSecret: true }] };
      const tooMany = { questions: Array.from({ length: 4 }, () => toolInput.questions[0]) };
      for (const input of [secret, tooMany]) {
        expect(await codexInputBridgeCanServe("thread-1", "turn-1", input, {
          sessionsDir: dir, now: () => 10_000, isPidAlive: () => true,
          sleep: async () => { sleeps += 1; },
        })).toBe(false);
      }
      expect(sleeps).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a fallback claim suppresses exactly one matching late bridge request and shares the hold TTL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-input-arb-"));
    try {
      await markCodexInputFallback("thread-1", "turn-1", toolInput, true, {
        sessionsDir: dir, now: () => 20_000, pid: 55,
      });
      expect(await codexInputFallbackOwnsRequest(request(), {
        sessionsDir: dir, now: () => 20_001,
      })).toBe(true);
      expect(await codexInputFallbackOwnsRequest(request(), {
        sessionsDir: dir, now: () => 20_002,
      })).toBe(false);

      await markCodexInputFallback("thread-1", "turn-1", toolInput, false, {
        sessionsDir: dir, now: () => 25_000, pid: 55,
      });
      expect(await codexInputFallbackOwnsRequest(request(), {
        sessionsDir: dir, now: () => 25_001,
      })).toBe(false); // an attempted hold:false is a handoff, not ownership
      await clearCodexInputFallback("thread-1", "turn-1", toolInput, { sessionsDir: dir });

      await markCodexInputFallback("thread-1", "turn-1", toolInput, true, {
        sessionsDir: dir, now: () => 30_000, pid: 55,
      });
      expect(await codexInputFallbackOwnsRequest(request(), {
        sessionsDir: dir, now: () => 30_000 + CODEX_INPUT_FALLBACK_TTL_MS + 1,
      })).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
