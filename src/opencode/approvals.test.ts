import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptBlob } from "../core/crypto";
import type { Config } from "../core/shared";
import {
  buildPermissionDetail, buildPermissionQuestions, buildPermissionSummary, isQuestionTool,
  OPENCODE_QUESTION_TOOL,
} from "../core/permission";
import type { PermissionHookDeps } from "../core/permission";
import {
  ocAnswers, ocDecisionRequest, ocReplyFor, ocResolvedRequestId, ocResolveOnRelay, runOcApproval,
} from "./approvals";
import type { OcDecisionRequest } from "./approvals";

// -------------------------------------------------------------------------------------------------
// THE FIXTURES ARE REAL. Every payload below is an unmodified capture from a live `opencode serve`
// 1.18.15 SSE stream / plugin `event` hook (the permission probe and the questions+todos probe).
// -------------------------------------------------------------------------------------------------

const SESSION = "ses_fe9c7c13fffeLuB2yMpkVjwaMo";

const permissionAsked = {
  id: "evt_01638472f002haIrGvstkxdhA8",
  type: "permission.asked",
  properties: {
    id: "per_01638472f0016YZI7giyZgEWE6",
    sessionID: SESSION,
    permission: "bash",
    patterns: ["echo hello"],
    metadata: { command: "echo hello" },
    always: ["echo *"],
    tool: { messageID: "msg_016383f33001Wbg3U2QpZebfF0", callID: "call-511c7357" },
  },
};

const questionAsked = {
  id: "evt_016b7c88e001xNAJMNxOuVAOmk",
  type: "question.asked",
  properties: {
    id: "que_016b7c88d001ZIN6ErBshl1OuW",
    sessionID: SESSION,
    questions: [{
      question: "Pick a color",
      header: "Color",
      options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }],
      multiple: false,
    }],
    tool: { messageID: "msg_016b7a3950017CpMb9O7Ly5RzG", callID: "call-a41e68b2" },
  },
};

/** One decision line as `runPermissionHook` emits it for the claude/opencode envelope (no `continue`
 *  wrapper — that is Codex's shape only). */
const line = (decision: object): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });

const PERMISSION: OcDecisionRequest = ocDecisionRequest(permissionAsked)!;
const QUESTION: OcDecisionRequest = ocDecisionRequest(questionAsked)!;

describe("ocDecisionRequest", () => {
  test("permission.asked maps onto the card the phone already knows how to draw", () => {
    expect(PERMISSION).toEqual({
      kind: "permission",
      id: "per_01638472f0016YZI7giyZgEWE6",
      sessionID: SESSION,
      // `shell` is the tool name buildPermissionSummary/buildPermissionDetail read `command` from.
      toolName: "shell",
      toolInput: { command: "echo hello" },
    });
  });

  test("the mapped permissions carry their own useful field, and the rest keep their own name", () => {
    const ask = (permission: string, patterns: string[], metadata: object) => ocDecisionRequest({
      type: "permission.asked",
      properties: { id: "per_x", sessionID: SESSION, permission, patterns, metadata },
    });
    expect(ask("edit", ["src/a.ts"], { filepath: "src/a.ts" }))
      .toMatchObject({ toolName: "Edit", toolInput: { file_path: "src/a.ts" } });
    expect(ask("webfetch", ["https://x.test/a"], { url: "https://x.test/a" }))
      .toMatchObject({ toolName: "WebFetch", toolInput: { url: "https://x.test/a" } });
    expect(ask("websearch", ["bun test"], { query: "bun test" }))
      .toMatchObject({ toolName: "WebSearch", toolInput: { query: "bun test" } });
    // Metadata missing → `patterns` is the fallback, because it is the one field every ask carries.
    expect(ask("bash", ["rm -rf /tmp/x"], {}))
      .toMatchObject({ toolName: "shell", toolInput: { command: "rm -rf /tmp/x" } });
    // KNOWN GAP (documented on PERMISSION_TOOL): an unmapped permission keeps its own name and gets
    // no detail line.
    expect(ask("grep", ["TODO"], { pattern: "TODO" }))
      .toMatchObject({ toolName: "grep", toolInput: {} });
  });

  test("question.asked becomes an AskUserQuestion-shaped card, questions verbatim", () => {
    expect(QUESTION.kind).toBe("question");
    expect(QUESTION.id).toBe("que_016b7c88d001ZIN6ErBshl1OuW");
    // PINNED CROSS-REPO CONTRACT: the literal string `question`, matched verbatim by iOS's
    // CCEnvelopeCrypto.opencodeToolName. One character off and the phone shows Allow/Deny with no
    // options and no Dismiss warning.
    expect(QUESTION.toolName).toBe("question");
    // The shape is field-for-field what usableQuestions/answerLine parse — no translation at all.
    expect(QUESTION.toolInput).toEqual({ questions: questionAsked.properties.questions });
  });

  test("nothing else is a decision", () => {
    // v2 is DISPROVED for 1.18.15's SSE surface — the live server emits v1. Consuming both would
    // double-hold every prompt the day a build starts emitting the durable form.
    expect(ocDecisionRequest({ type: "question.v2.asked", properties: { id: "que_x", sessionID: SESSION, questions: [{}] } })).toBeNull();
    expect(ocDecisionRequest({ type: "permission.replied", properties: { requestID: "per_x", sessionID: SESSION } })).toBeNull();
    expect(ocDecisionRequest({ type: "session.idle", properties: { sessionID: SESSION } })).toBeNull();
    expect(ocDecisionRequest({ type: "question.asked", properties: { id: "que_x", sessionID: SESSION, questions: [] } })).toBeNull();
    expect(ocDecisionRequest(null)).toBeNull();
  });
});

describe("ocResolvedRequestId", () => {
  test("reads requestID — NOT id — on all three resolution events", () => {
    expect(ocResolvedRequestId({ type: "permission.replied", properties: { sessionID: SESSION, requestID: "per_a", reply: "reject" } })).toBe("per_a");
    expect(ocResolvedRequestId({ type: "question.replied", properties: { sessionID: SESSION, requestID: "que_a", answers: [["Red"]] } })).toBe("que_a");
    expect(ocResolvedRequestId({ type: "question.rejected", properties: { sessionID: SESSION, requestID: "que_b" } })).toBe("que_b");
  });

  test("an asked event's `id` is never mistaken for a resolution", () => {
    expect(ocResolvedRequestId(permissionAsked)).toBeNull();
    expect(ocResolvedRequestId(questionAsked)).toBeNull();
  });
});

describe("ocReplyFor — permissions", () => {
  test("deny → reject", () => {
    expect(ocReplyFor(PERMISSION, line({ behavior: "deny", message: "Denied from phone" })))
      .toEqual({ path: "permission/per_01638472f0016YZI7giyZgEWE6/reply", body: { reply: "reject" } });
  });

  test("bare allow → once", () => {
    expect(ocReplyFor(PERMISSION, line({ behavior: "allow" })))
      .toEqual({ path: "permission/per_01638472f0016YZI7giyZgEWE6/reply", body: { reply: "once" } });
  });

  test("allow + updatedPermissions → always", () => {
    const decision = {
      behavior: "allow",
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "shell" }], behavior: "allow", destination: "session" }],
    };
    expect(ocReplyFor(PERMISSION, line(decision)))
      .toEqual({ path: "permission/per_01638472f0016YZI7giyZgEWE6/reply", body: { reply: "always" } });
  });

  test("no line — released, expired, gave up, fail-open — sends NOTHING", () => {
    expect(ocReplyFor(PERMISSION, undefined)).toBeNull();
    expect(ocReplyFor(PERMISSION, "not json")).toBeNull();
    expect(ocReplyFor(PERMISSION, JSON.stringify({ hookSpecificOutput: {} }))).toBeNull();
  });
});

describe("ocReplyFor — questions", () => {
  test("deny → the dedicated /reject route, NEVER /session/{id}/abort", () => {
    const reply = ocReplyFor(QUESTION, line({ behavior: "deny", message: "Denied from phone" }));
    expect(reply).toEqual({ path: "question/que_016b7c88d001ZIN6ErBshl1OuW/reject" });
    expect(reply?.body).toBeUndefined(); // the reject route takes no body
  });

  test("an answer → {answers:[[label]]}, the LABEL verbatim, not an index", () => {
    const decision = { behavior: "allow", updatedInput: { questions: questionAsked.properties.questions, answers: { "Pick a color": "Red" } } };
    expect(ocReplyFor(QUESTION, line(decision)))
      .toEqual({ path: "question/que_016b7c88d001ZIN6ErBshl1OuW/reply", body: { answers: [["Red"]] } });
  });

  test("a bare allow on a question is not answerable and sends nothing", () => {
    expect(ocReplyFor(QUESTION, line({ behavior: "allow" }))).toBeNull();
  });
});

describe("ocAnswers", () => {
  const questions = [
    { question: "Color?", options: [{ label: "Red" }, { label: "Blue" }] },
    { question: "Size?", options: [{ label: "Small, medium" }, { label: "Large" }] },
  ];

  test("one inner array per question, IN ORDER", () => {
    expect(ocAnswers(questions, { "Color?": "Blue", "Size?": "Large" })).toEqual([["Blue"], ["Large"]]);
  });

  test("a multi-select splits, and an unanswered question is a legal empty array", () => {
    expect(ocAnswers(questions, { "Color?": "Red, Blue" })).toEqual([["Red", "Blue"], []]);
  });

  test("a label that itself contains ', ' is tried WHOLE first and never split", () => {
    expect(ocAnswers(questions, { "Size?": "Small, medium" })).toEqual([[], ["Small, medium"]]);
  });

  test("a question the shared filter skipped cannot shift the positions", () => {
    // usableQuestions drops an entry with no usable option, so the map has no key for it — the inner
    // array is empty and every later question stays at its own index.
    const withGap = [{ question: "no options", options: [] }, ...questions];
    expect(ocAnswers(withGap, { "Color?": "Red" })).toEqual([[], ["Red"], []]);
  });
});

// -------------------------------------------------------------------------------------------------
// THE LANDMINE. permission.ts's defaultTrace installs process-wide SIGTERM/SIGINT/SIGHUP/
// uncaughtException/unhandledRejection handlers that call process.exit(0). We run inside OPENCODE'S
// SERVER PROCESS, so letting that install would hijack the user's Ctrl-C and kill their editor on any
// unhandled rejection anywhere in OpenCode. These two tests are the guarantee that it never does.
// -------------------------------------------------------------------------------------------------

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP", "uncaughtException", "unhandledRejection", "exit"] as const;
const listenerCounts = (): number[] => SIGNALS.map((s) => process.listenerCount(s));

const config: Config = {
  url: "https://w.test",
  pairingId: "pair-1",
  pcSecret: "secret-1",
  e2eKey: new Uint8Array(32).fill(7),
  machineName: "oc-test",
};

describe("no process handlers are ever installed", () => {
  test("every process-global seam of runPermissionHook is injected", async () => {
    let seen: PermissionHookDeps | undefined;
    let agent: string | undefined;
    await runOcApproval(PERMISSION, {
      config,
      serverUrl: "http://127.0.0.1:4396/",
      requestId: "req-1",
      delegate: async () => {},
      runHold: async (deps, a) => { seen = deps; agent = a; },
    });
    expect(agent).toBe("opencode");
    // trace → the signal handlers; readInput → the server's stdin; emit → its stdout; delegate →
    // runHook, which reads stdin. Any one of these left to its default is a hang or a hijack.
    expect(seen?.trace).toBeDefined();
    expect(seen?.readInput).toBeDefined();
    expect(seen?.emit).toBeDefined();
    expect(seen?.delegate).toBeDefined();
  });

  test("a REAL end-to-end hold answers OpenCode and adds no listener to `process`", async () => {
    const before = listenerCounts();
    const calls: string[] = [];
    const answerBlob = await encryptBlob(config.e2eKey, { requestId: "req-2", decision: "allow_always" });
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`.trim());
      if (url.endsWith("/v1/cc/decision")) return Response.json({ hold: true });
      if (url.includes("/v1/cc/decision/")) return Response.json({ status: "answered", answerBlob });
      return new Response("true", { status: 200 });
    }) as unknown as typeof fetch;

    await runOcApproval(PERMISSION, {
      config,
      serverUrl: "http://127.0.0.1:4396/",
      cwd: "/tmp/oc-probe",
      requestId: "req-2",
      delegate: async () => { throw new Error("the no-hold path must not be taken here"); },
      noHoldPath: join(tmpdir(), `nomo-oc-no-such-flag-${process.pid}`),
      fetchFn,
      trace: () => {},
    });

    expect(listenerCounts()).toEqual(before);
    // "Always allow" on the phone is `always` on the wire, on the verified reply route.
    expect(calls).toContain('POST http://127.0.0.1:4396/permission/per_01638472f0016YZI7giyZgEWE6/reply {"reply":"always"}');
  });
});

describe("ocResolveOnRelay", () => {
  test("is the blob-free, PC-authenticated resolve that retires a cascaded sibling's card", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    await ocResolveOnRelay(config, "req-3", fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://w.test/v1/cc/decision/resolve");
    expect(calls[0].init?.body).toBe(JSON.stringify({ requestId: "req-3" }));
    expect((calls[0].init?.headers as Record<string, string>)["x-cc-pairing"]).toBe("pair-1");
  });

  test("never throws — a dead worker just leaves the card to the liveness sweep", async () => {
    const fetchFn = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(ocResolveOnRelay(config, "req-4", fetchFn)).resolves.toBeUndefined();
  });
});

describe("the question channel end to end", () => {
  /** Run a REAL hold whose phone answer is `answer`, and return every request it made. */
  const holdWith = async (request: OcDecisionRequest, phone: object): Promise<string[]> => {
    const calls: string[] = [];
    const answerBlob = await encryptBlob(config.e2eKey, { requestId: "req-q", ...phone });
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`.trim());
      if (url.endsWith("/v1/cc/decision")) return Response.json({ hold: true });
      if (url.includes("/v1/cc/decision/")) return Response.json({ status: "answered", answerBlob });
      return new Response("true", { status: 200 });
    }) as unknown as typeof fetch;
    await runOcApproval(request, {
      config,
      serverUrl: "http://127.0.0.1:4396/",
      requestId: "req-q",
      delegate: async () => { throw new Error("the no-hold path must not be taken here"); },
      noHoldPath: join(tmpdir(), `nomo-oc-no-such-flag-${process.pid}`),
      fetchFn,
      trace: () => {},
    });
    return calls;
  };

  test("the phone's pick round-trips to /question/{id}/reply as the option LABEL", async () => {
    const calls = await holdWith(QUESTION, { decision: "answer", answers: ["Red"] });
    expect(calls).toContain('POST http://127.0.0.1:4396/question/que_016b7c88d001ZIN6ErBshl1OuW/reply {"answers":[["Red"]]}');
  });

  test("a deny dismisses the question — and it is turn-ending, so it is the only thing we send", async () => {
    const calls = await holdWith(QUESTION, { decision: "deny" });
    const toOpenCode = calls.filter((c) => c.includes("127.0.0.1:4396"));
    expect(toOpenCode).toEqual(["POST http://127.0.0.1:4396/question/que_016b7c88d001ZIN6ErBshl1OuW/reject"]);
    // NEVER an abort: /reject returns 200 immediately and OpenCode goes idle on its own.
    expect(calls.some((c) => c.includes("/abort"))).toBe(false);
  });

  test("a bare allow on a question is released — the user answers at the Mac, we send nothing", async () => {
    const calls = await holdWith(QUESTION, { decision: "allow" });
    expect(calls.some((c) => c.includes("127.0.0.1:4396"))).toBe(false);
  });
});

describe("the pinned cross-repo tool-name contract", () => {
  test("`question` reaches the shared question machinery, exactly as `AskUserQuestion` does", () => {
    // The phone's card summary is the FIRST question's text, not the bare tool name…
    expect(buildPermissionSummary(OPENCODE_QUESTION_TOOL, QUESTION.toolInput)).toBe("Pick a color");
    // …the option list rides in permissionQuestions with its labels intact…
    expect(buildPermissionQuestions(QUESTION.toolInput)[0]).toMatchObject({ q: "Pick a color", o: ["Red", "Blue"] });
    // …and permissionDetail stays deliberately empty so it cannot compete for the blob's budget.
    expect(buildPermissionDetail(OPENCODE_QUESTION_TOOL, QUESTION.toolInput)).toBe("");
    expect(isQuestionTool(OPENCODE_QUESTION_TOOL)).toBe(true);
  });

  test("a permission frame is unaffected — it still carries OpenCode's own permission name", () => {
    expect(PERMISSION.toolName).toBe("shell"); // `bash`, mapped onto the card that reads `command`
    expect(isQuestionTool(PERMISSION.toolName)).toBe(false);
  });
});

describe("the reject cascade", () => {
  /** OpenCode's `Permission.reply` publishes a `Replied` event for the primary AND, on `reject`, for
   *  EVERY other pending permission in that session (and on `always`, for every sibling the new rule now
   *  covers) — verified in the 1.18.15 bundle. So a cascaded sibling is retired by the ordinary
   *  replied-event path and needs no bespoke cascade bookkeeping. */
  test("each cascaded sibling arrives as its own permission.replied and is resolvable by id", () => {
    const cascade = ["per_primary", "per_sibling_a", "per_sibling_b"].map((requestID) => ({
      type: "permission.replied",
      properties: { sessionID: SESSION, requestID, reply: "reject" },
    }));
    expect(cascade.map(ocResolvedRequestId)).toEqual(["per_primary", "per_sibling_a", "per_sibling_b"]);
  });
});
