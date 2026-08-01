import { mkdir, mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildPermissionSummary, buildPermissionDetail, buildPermissionQuestions, fitPermissionDetail,
  sealedBlobChars, BLOB_FIT_CHARS, runPermissionHook, approvalsCommand, NO_HOLD_PATH, TRACE_PATH,
  codexRolloutSessionId, codexTurnPolicyFromRollout, loadCodexTurnPolicy,
} from "./permission";
import { encryptBlob, decryptBlob } from "./crypto";
import { createLanAnswerStore, createLanListener } from "./lan-listener";
import type { LanAnswerStore, LanListener } from "./lan-listener";
import type { Config } from "./shared";

// ---- summary builder (pure) ---------------------------------------------------------------

describe("buildPermissionSummary", () => {
  test("Bash → first line of the command", () => {
    expect(buildPermissionSummary("Bash", { command: "rm -rf build\necho done" })).toBe("rm -rf build");
  });
  test("Bash → truncated to <=80 chars with an ellipsis", () => {
    const long = "echo " + "x".repeat(200);
    const out = buildPermissionSummary("Bash", { command: long });
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });
  test("Edit/Write/Read/NotebookEdit → basename of file_path", () => {
    for (const t of ["Edit", "Write", "Read", "NotebookEdit"]) {
      expect(buildPermissionSummary(t, { file_path: "/Users/x/proj/src/main.ts" })).toBe("main.ts");
    }
  });
  test("WebFetch → URL host", () => {
    expect(buildPermissionSummary("WebFetch", { url: "https://example.com/a/b?q=1" })).toBe("example.com");
  });
  test("WebSearch → query, truncated", () => {
    expect(buildPermissionSummary("WebSearch", { query: "how to nomo" })).toBe("how to nomo");
  });
  test("mcp__ tool → last __-segment", () => {
    expect(buildPermissionSummary("mcp__linear__create_issue", {})).toBe("create_issue");
  });
  test("ExitPlanMode → fixed 'Approve Claude's plan' (the plan itself rides in the detail)", () => {
    expect(buildPermissionSummary("ExitPlanMode", {})).toBe("Approve Claude's plan");
    expect(buildPermissionSummary("ExitPlanMode", { plan: "# do a bunch of stuff" })).toBe("Approve Claude's plan");
  });
  test("unknown tool → tool_name verbatim", () => {
    expect(buildPermissionSummary("SomethingElse", {})).toBe("SomethingElse");
  });
  test("missing input fields → falls back to tool_name", () => {
    expect(buildPermissionSummary("Bash", {})).toBe("Bash");
    expect(buildPermissionSummary("Edit", {})).toBe("Edit");
  });
});

describe("Codex turn approval policy", () => {
  const row = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload });

  test("takes the last matching turn_context and ignores a newer unrelated turn", () => {
    const rollout = [
      row("turn_context", { turn_id: "wanted", approval_policy: "on-request", approvals_reviewer: "user" }),
      row("turn_context", { turn_id: "wanted", approval_policy: "on-request", approvals_reviewer: "auto_review" }),
      row("turn_context", { turn_id: "other", approval_policy: "on-request", approvals_reviewer: "user" }),
    ].join("\n");
    expect(codexTurnPolicyFromRollout(rollout, "wanted")).toMatchObject({
      approvalPolicy: "on-request", approvalsReviewer: "auto_review",
    });
  });

  test("skips malformed rows and extracts Full Access signals", () => {
    const rollout = [
      "{sliced",
      row("turn_context", {
        turn_id: "full", approval_policy: "never", sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
      }),
    ].join("\n");
    expect(codexTurnPolicyFromRollout(rollout, "full")).toEqual({
      approvalPolicy: "never", approvalsReviewer: undefined,
      sandboxType: "danger-full-access", permissionProfileType: "disabled",
    });
    expect(codexTurnPolicyFromRollout(rollout, "missing")).toBeNull();
  });

  test("session_meta parser accepts only the session row id", () => {
    expect(codexRolloutSessionId([
      row("event_msg", { id: "wrong" }),
      row("session_meta", { id: "sess-right" }),
    ].join("\n"))).toBe("sess-right");
  });

  test("loader accepts the matching rollout under CODEX_HOME and rejects session/path mismatches", async () => {
    const home = await mkdtemp(join(tmpdir(), "nomo-codex-policy-"));
    const day = join(home, "sessions", "2026", "07", "27");
    await mkdir(day, { recursive: true });
    const rollout = join(day, "rollout-test.jsonl");
    await writeFile(rollout, [
      row("session_meta", { id: "sess-1", base_instructions: "x".repeat(70 * 1024) }),
      row("turn_context", { turn_id: "turn-1", approval_policy: "on-request", approvals_reviewer: "auto_review" }),
    ].join("\n"));
    await expect(loadCodexTurnPolicy(rollout, "turn-1", "sess-1", home)).resolves.toMatchObject({
      approvalPolicy: "on-request", approvalsReviewer: "auto_review",
    });
    await expect(loadCodexTurnPolicy(rollout, "turn-1", "another-session", home)).resolves.toBeNull();
    const outside = join(home, "rollout-outside.jsonl");
    await writeFile(outside, [
      row("session_meta", { id: "sess-1" }),
      row("turn_context", { turn_id: "turn-1", approval_policy: "on-request", approvals_reviewer: "auto_review" }),
    ].join("\n"));
    await expect(loadCodexTurnPolicy(outside, "turn-1", "sess-1", home)).resolves.toBeNull();
    const escapedLink = join(day, "rollout-escaped-link.jsonl");
    await symlink(outside, escapedLink);
    await expect(loadCodexTurnPolicy(escapedLink, "turn-1", "sess-1", home)).resolves.toBeNull();
    await rm(home, { recursive: true, force: true });
  });
});

// ---- summary builder — codex tool names (shell / local_shell / apply_patch) ----------------
//
// Codex fires PermissionRequest with its own snake_case tool names; the summary switch keys purely on
// tool_name (no agent branch — Codex + Claude names don't collide), so these are additive cases.

describe("buildPermissionSummary — codex tools", () => {
  test("shell → first line of the command", () => {
    expect(buildPermissionSummary("shell", { command: "ls -la" })).toBe("ls -la");
    expect(buildPermissionSummary("shell", { command: "git status\necho done" })).toBe("git status");
  });
  test("local_shell → first line of the command", () => {
    expect(buildPermissionSummary("local_shell", { command: "bun test\necho ok" })).toBe("bun test");
  });
  test("shell → truncated to <=80 chars with an ellipsis", () => {
    const out = buildPermissionSummary("shell", { command: "echo " + "x".repeat(200) });
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });
  test("apply_patch → the description, truncated to <=80", () => {
    expect(buildPermissionSummary("apply_patch", { description: "edit main.ts" })).toBe("edit main.ts");
    const out = buildPermissionSummary("apply_patch", { description: "y".repeat(200) });
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });
  test("codex tools with missing fields → fall back to tool_name", () => {
    expect(buildPermissionSummary("shell", {})).toBe("shell");
    expect(buildPermissionSummary("local_shell", {})).toBe("local_shell");
    expect(buildPermissionSummary("apply_patch", {})).toBe("apply_patch");
  });
});

// ---- detail builder (pure) — fuller context for the phone card, UNCAPPED (the sealed-frame fit
// below is the only ceiling; NOM-38 removed the flat 400-char cap that amputated plans) ----------

describe("buildPermissionDetail", () => {
  test("Bash → the FULL command, all lines (summary is only the first line)", () => {
    expect(buildPermissionDetail("Bash", { command: "cd proj\nbun test\necho done" })).toBe("cd proj\nbun test\necho done");
  });
  test("Bash → NOT capped here — the whole command rides to the fit (NOM-38)", () => {
    const out = buildPermissionDetail("Bash", { command: "x".repeat(1000) });
    expect(out.length).toBe(1000);
    expect(out.endsWith("…")).toBe(false);
  });
  test("Edit/Write/Read/NotebookEdit → the FULL file_path (not just the basename)", () => {
    for (const t of ["Edit", "Write", "Read", "NotebookEdit"]) {
      expect(buildPermissionDetail(t, { file_path: "/Users/x/proj/src/main.ts" })).toBe("/Users/x/proj/src/main.ts");
    }
  });
  test("WebFetch → full url; WebSearch → full query", () => {
    expect(buildPermissionDetail("WebFetch", { url: "https://example.com/a/b?q=1" })).toBe("https://example.com/a/b?q=1");
    expect(buildPermissionDetail("WebSearch", { query: "how to nomo" })).toBe("how to nomo");
  });
  test("ExitPlanMode → the WHOLE plan markdown, uncapped (NOM-38)", () => {
    expect(buildPermissionDetail("ExitPlanMode", { plan: "## Plan\n- step one\n- step two" })).toBe("## Plan\n- step one\n- step two");
    const long = buildPermissionDetail("ExitPlanMode", { plan: "p".repeat(900) });
    expect(long.length).toBe(900);
  });
  test("unknown tool / missing fields → empty string (omitted from the blob)", () => {
    expect(buildPermissionDetail("SomethingElse", { command: "x" })).toBe("");
    expect(buildPermissionDetail("Bash", {})).toBe("");
    expect(buildPermissionDetail("Edit", {})).toBe("");
  });
});

describe("buildPermissionDetail — codex tools", () => {
  test("shell/local_shell → the FULL multi-line command", () => {
    expect(buildPermissionDetail("shell", { command: "cd proj\nbun test\necho done" })).toBe("cd proj\nbun test\necho done");
    expect(buildPermissionDetail("local_shell", { command: "git add -p\ngit commit" })).toBe("git add -p\ngit commit");
  });
  test("shell → NOT capped here — the whole command rides to the fit (NOM-38)", () => {
    const out = buildPermissionDetail("shell", { command: "x".repeat(1000) });
    expect(out.length).toBe(1000);
  });
  test("apply_patch → the full description, uncapped (NOM-38)", () => {
    expect(buildPermissionDetail("apply_patch", { description: "patch main.ts" })).toBe("patch main.ts");
    const long = buildPermissionDetail("apply_patch", { description: "z".repeat(900) });
    expect(long.length).toBe(900);
  });
  test("codex tools with missing fields → empty string (omitted from the blob)", () => {
    expect(buildPermissionDetail("shell", {})).toBe("");
    expect(buildPermissionDetail("apply_patch", {})).toBe("");
  });
});

// ---- question builder (pure) — the option list that rides the blob so the phone can ANSWER -------
//
// AskUserQuestion is held like every other tool now (the old question-passthrough gate is gone): the
// choices travel INSIDE the sealed blob under compact keys (q/h/m/o/d) to spend as little of the
// 3072-char ceiling as possible. Descriptions ride positionally with labels when useful and are shed
// before the actionable picker if the frame is under budget pressure.

const CC_QUESTIONS = [
  {
    question: "Which testing approach should I use for the new parser?",
    header: "Testing",
    multiSelect: false,
    options: [
      { label: "Unit tests only", description: "Fast and isolated; misses wiring bugs." },
      { label: "Integration tests", description: "Slower but exercises the real pipeline." },
    ],
  },
];

describe("buildPermissionQuestions", () => {
  test("a real CC payload → compact {q,h,m,o,d} entries with descriptions aligned", () => {
    expect(buildPermissionQuestions({ questions: CC_QUESTIONS })).toEqual([
      {
        q: "Which testing approach should I use for the new parser?",
        h: "Testing",
        o: ["Unit tests only", "Integration tests"],
        d: ["Fast and isolated; misses wiring bugs.", "Slower but exercises the real pipeline."],
      },
    ]);
  });

  test("descriptions stay label-aligned, cap at 160 code points, and are omitted when all empty", () => {
    const [described] = buildPermissionQuestions({
      questions: [{
        question: "Pick one",
        options: [
          { label: "A" },
          { label: "discard me", description: "wrong row" },
          { label: "", description: "must not shift" },
          { label: "B", description: "😀".repeat(200) },
        ],
      }],
    });
    expect(described.o).toEqual(["A", "discard me", "B"]);
    expect(described.d?.[0]).toBe("");
    expect(described.d?.[1]).toBe("wrong row");
    expect(described.d?.[2]).toBe(`${"😀".repeat(159)}…`);
    expect([...(described.d?.[2] ?? "")]).toHaveLength(160);

    expect(buildPermissionQuestions({
      questions: [{ question: "No descriptions", options: [{ label: "A" }, { label: "B", description: "" }] }],
    })).toEqual([{ q: "No descriptions", o: ["A", "B"] }]);
  });

  test("multiSelect true → m:true (absent when false, per the omit-empty discipline)", () => {
    const [one] = buildPermissionQuestions({
      questions: [{ question: "Pick some", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(one).toEqual({ q: "Pick some", m: true, o: ["A", "B"] });
    const [two] = buildPermissionQuestions({
      questions: [{ question: "Pick one", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }],
    });
    expect("m" in two).toBe(false);
  });

  test("question text capped at 240 chars, each label at 60", () => {
    const [q] = buildPermissionQuestions({
      questions: [{ question: "z".repeat(600), options: [{ label: "L".repeat(300) }, { label: "ok" }] }],
    });
    expect(q.q.length).toBe(240);
    expect(q.o[0].length).toBe(60);
    expect(q.o[1]).toBe("ok");
  });

  test("a non-question tool (no questions array) → []", () => {
    expect(buildPermissionQuestions({ command: "rm -rf build" })).toEqual([]);
    expect(buildPermissionQuestions({})).toEqual([]);
    expect(buildPermissionQuestions({ questions: "nope" })).toEqual([]);
  });

  test("malformed entries are skipped, never thrown on", () => {
    expect(buildPermissionQuestions({
      questions: [null, { options: [{ label: "A" }] }, { question: "Real?", options: [{ label: "A" }, "junk"] }],
    })).toEqual([{ q: "Real?", o: ["A"] }]);
  });

  test("a question with ZERO usable option labels is DROPPED (never rides as {q, o: []})", () => {
    // An option-less question is unanswerable, so the phone would filter the row out of its card — and
    // its positional `answers` array would then shift onto the wrong question. Both ends skip it here.
    expect(buildPermissionQuestions({
      questions: [
        { question: "No options at all?" },
        { question: "Empty options?", options: [] },
        { question: "Only junk options?", options: [{ label: "" }, { nope: 1 }, "x"] },
        { question: "Real?", options: [{ label: "A" }] },
      ],
    })).toEqual([{ q: "Real?", o: ["A"] }]);
  });
});

describe("buildPermissionSummary / buildPermissionDetail — AskUserQuestion", () => {
  test("summary → the first question's text, truncated to <=80", () => {
    expect(buildPermissionSummary("AskUserQuestion", { questions: CC_QUESTIONS }))
      .toBe("Which testing approach should I use for the new parser?");
    const out = buildPermissionSummary("AskUserQuestion", {
      questions: [{ question: "q".repeat(200), options: [{ label: "A" }] }],
    });
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });

  test("detail → ALWAYS empty for a question: the text already rides twice, and a third copy competed for the blob budget", () => {
    // Contract the phone must honor: a question card's prompt comes from `permissionQuestions`, never
    // from `permissionDetail` (which is absent for AskUserQuestion).
    expect(buildPermissionDetail("AskUserQuestion", { questions: CC_QUESTIONS })).toBe("");
    expect(buildPermissionDetail("AskUserQuestion", {
      questions: [{ question: "q".repeat(900), options: [{ label: "A" }] }],
    })).toBe("");
  });

  test("no questions → summary falls back to the tool name, detail is empty", () => {
    expect(buildPermissionSummary("AskUserQuestion", {})).toBe("AskUserQuestion");
    expect(buildPermissionDetail("AskUserQuestion", {})).toBe("");
  });

  test("a question with NO usable option is not showable either → summary falls back to the tool name", () => {
    // usableQuestions requires >= 1 answerable option; an option-less question can't be answered, so it
    // must not become the card's headline any more than it may ride the blob.
    expect(buildPermissionSummary("AskUserQuestion", { questions: [{ question: "Unanswerable?", options: [] }] }))
      .toBe("AskUserQuestion");
  });
});

// ---- sealed-frame fit (pure) — the ONLY detail ceiling, and an honest omitted count (NOM-38) ------

describe("sealedBlobChars", () => {
  test("matches the real sealed length of encryptBlob (exact, not an estimate)", async () => {
    for (const payload of [{ a: 1 }, { plan: "x".repeat(500) }, { plan: "日".repeat(300) }]) {
      const real = (await encryptBlob(KEY, payload)).length;
      expect(sealedBlobChars(new TextEncoder().encode(JSON.stringify(payload)).length)).toBe(real);
    }
  });
});

describe("fitPermissionDetail", () => {
  const base = {
    status: "decisionPending", title: "y".repeat(120), machine: "studio", label: "api-status",
    model: "claude-opus-5", permissionSummary: "Approve Claude's plan",
    permissionRequestId: "b3f1c2d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d", permissionToolName: "ExitPlanMode",
  };
  const frameChars = (d: string, omitted: number) =>
    sealedBlobChars(new TextEncoder().encode(JSON.stringify({
      ...base,
      ...(d.length > 0 ? { permissionDetail: d } : {}),
      ...(omitted > 0 ? { permissionDetailOmitted: omitted } : {}),
    })).length);

  test("a detail that fits rides WHOLE, with nothing omitted", () => {
    const plan = "# Plan\n- step one\n- step two";
    expect(fitPermissionDetail(base, plan)).toEqual({ detail: plan, omitted: 0 });
  });

  test("empty detail → empty, nothing omitted", () => {
    expect(fitPermissionDetail(base, "")).toEqual({ detail: "", omitted: 0 });
  });

  test("question budget ladder keeps d, then sheds d, then drops the whole picker", () => {
    const questions = buildPermissionQuestions({
      questions: [{
        question: "Choose",
        options: [
          { label: "Fast", description: "Smallest safe change" },
          { label: "Thorough", description: "Include hardening" },
        ],
      }],
    });
    const bare = questions.map(({ d: _descriptions, ...question }) => question);
    const questionFrameChars = (qs: typeof questions) => sealedBlobChars(new TextEncoder().encode(JSON.stringify({
      ...base, permissionQuestions: qs,
    })).length);
    const fullBudget = questionFrameChars(questions);
    const bareBudget = questionFrameChars(bare);

    expect(fitPermissionDetail(base, "", fullBudget, questions).questions).toEqual(questions);
    expect(fitPermissionDetail(base, "", bareBudget, questions).questions).toEqual(bare);
    expect(fitPermissionDetail(base, "", bareBudget - 4, questions)).toEqual({ detail: "", omitted: 0 });
  });

  test("a long plan keeps FAR more than the old 400-char cap and still fits the blob ceiling", () => {
    const plan = "p".repeat(6000);
    const { detail, omitted } = fitPermissionDetail(base, plan);
    expect(detail.length).toBeGreaterThan(1200);       // was a flat 400 before NOM-38
    expect(frameChars(detail, omitted)).toBeLessThanOrEqual(BLOB_FIT_CHARS);
    // Honest: kept characters + omitted characters = the whole plan (the "…" is the extra char).
    expect(detail.endsWith("…")).toBe(true);
    expect(detail.length - 1 + omitted).toBe(plan.length);
  });

  test("never splits a multi-byte character in half", () => {
    const plan = "日本語のプラン".repeat(500);
    const { detail, omitted } = fitPermissionDetail(base, plan);
    expect(frameChars(detail, omitted)).toBeLessThanOrEqual(BLOB_FIT_CHARS);
    expect(detail.endsWith("…")).toBe(true);
    expect([...detail].length - 1 + omitted).toBe([...plan].length);
  });

  test("an absurdly long detail is bounded, and the pre-slice loss is still COUNTED", () => {
    const plan = "q".repeat(60_000);
    const { detail, omitted } = fitPermissionDetail(base, plan);
    expect(frameChars(detail, omitted)).toBeLessThanOrEqual(BLOB_FIT_CHARS);
    expect(detail.length - 1 + omitted).toBe(plan.length);
  });
});

// ---- hold state machine -------------------------------------------------------------------

const KEY = new Uint8Array(32).fill(7);
const CONFIG: Config = { url: "https://w.example", pairingId: "p1", pcSecret: "s1", e2eKey: KEY };
const INPUT = JSON.stringify({
  session_id: "sess-1", hook_event_name: "PermissionRequest",
  tool_name: "Bash", tool_input: { command: "rm -rf build" },
  cwd: "/Users/x/proj", transcript_path: "/tmp/t.jsonl",
});
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from phone"}}}';

/** A scripted fetch: `hold` decides the POST reply — a single boolean applies to every POST, or an
 *  array supplies a per-POST-call sequence (repeating the last entry) so the hold-retry re-POST can
 *  answer differently from the first. `gets` is the sequence of GET replies: an object is a 200 body,
 *  "throw" is a transport failure, and a NUMBER is a non-2xx HTTP status with an empty body (used to
 *  drive the definitive-status release). */
function scriptFetch(hold: boolean | boolean[], gets: Array<Record<string, unknown> | "throw" | number>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let g = 0;
  let p = 0;
  const holdFor = () => (Array.isArray(hold) ? hold[Math.min(p++, hold.length - 1)] : hold);
  const fn = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url.endsWith("/v1/cc/decision")) return new Response(JSON.stringify({ hold: holdFor() }), { status: 200 });
    // GET /v1/cc/decision/<id>
    const next = gets[Math.min(g++, gets.length - 1)];
    if (next === "throw") throw new Error("network");
    if (typeof next === "number") return new Response("", { status: next });
    return new Response(JSON.stringify(next), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const baseDeps = (over: Record<string, unknown>) => ({
  readInput: async () => INPUT,
  loadConfigFn: async () => CONFIG,
  readRecordFn: async () => null,
  loadCodexTurnPolicyFn: async () => ({ approvalPolicy: "on-request", approvalsReviewer: "user" }),
  sleep: async () => {},
  now: () => 1000,
  randomUUID: () => "req-fixed",
  jitter: () => 0,
  noHoldPath: "/does/not/exist/no-hold",
  delegate: async () => { throw new Error("delegate must not run"); },
  trace: () => {}, // noop by default — tests must not touch the real trace file or install signal handlers
  ...over,
});

describe("runPermissionHook — hold state machine", () => {
  test("hold=false twice (first ask + post-race re-ask) → silent, exactly 2 POSTs, no polling", async () => {
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(calls.filter((c) => c.method === "POST").length).toBe(2); // initial + one re-ask after the wait
    expect(calls.filter((c) => c.method === "GET").length).toBe(0);
    expect(emitted).toEqual([]);
  });

  test("hold=false + ESTABLISHED session (record ts 10 min old) → exactly 1 POST, immediate silent exit", async () => {
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(false, []);
    const record = { pid: 1, machine: "m", label: "l", ts: 1_000_000 - 10 * 60_000 }; // well past FRESH_SESSION_MS
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      now: () => 1_000_000, readRecordFn: async () => record,
    }) as never);
    expect(calls.filter((c) => c.method === "POST").length).toBe(1); // NO re-ask — established session falls open at once
    expect(calls.filter((c) => c.method === "GET").length).toBe(0);
    expect(emitted).toEqual([]);
  });

  test("hold=false + FRESH session (record ts 5 s old) → re-asks (2 POSTs)", async () => {
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(false, []);
    const record = { pid: 1, machine: "m", label: "l", ts: 1_000_000 - 5_000 }; // inside FRESH_SESSION_MS
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      now: () => 1_000_000, readRecordFn: async () => record,
    }) as never);
    expect(calls.filter((c) => c.method === "POST").length).toBe(2); // young session still races the auto-add → re-ask
    expect(emitted).toEqual([]);
  });

  test("hold=false then hold=true on the re-ask → holds and answers normally", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    // first POST loses the island-auto-add race (hold:false), the 4s-later re-POST wins it (hold:true)
    const { fn, calls } = scriptFetch([false, true], [{ status: "pending" }, { status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);
    expect(calls.filter((c) => c.method === "POST").length).toBe(2);
    expect(calls.filter((c) => c.method === "GET").length).toBe(2);
  });

  // FRESH `ts` PER POST. The first (hold:false) POST is not a server-side no-op: the worker stores/pushes
  // the fallback frame, stamping the session row's lastTs with the ts we sent. Re-POSTing that SAME ts hits
  // the worker's ordering guard (env.ts <= lastTs → drop "stale" → hold:false "stale-session"), so the
  // re-ask could NEVER win the island auto-add race it exists for. Every POST must be strictly newer.
  test("the hold re-ask POSTs a STRICTLY NEWER ts (fake clock advanced by the injected sleep)", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    let clock = 1_000_000;
    const { fn, calls } = scriptFetch([false, true], [{ status: "answered", answerBlob }]);
    const emitted: string[] = [];
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },            // the 4s hold-retry wait really elapses
    }) as never);
    const posts = calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body!).ts as number);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toBeGreaterThan(posts[0]);
    expect(posts[1] - posts[0]).toBe(4_000);                    // HOLD_RETRY_DELAY_MS of real elapsed time
    expect(emitted).toEqual([ALLOW]);                           // …and the re-ask's hold:true is honored
  });

  test("even a FROZEN clock yields a strictly newer ts on the re-ask (coarse-clock guard)", async () => {
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: () => {} }) as never); // now: () => 1000, sleep: noop
    const posts = calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body!).ts as number);
    expect(posts).toEqual([1000, 1001]);
  });

  // The worker names the FIRST failing gate in `reason` (stale-session / toggle-off / no-activity). Without
  // it in the trace, a prompt that fell open is unfalsifiable in the field: a re-ask killed by the staleness
  // guard looks exactly like the user having remote approvals switched off.
  test("the worker's hold:false `reason` is recorded in the trace (posted + hold lines)", async () => {
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    let post = 0;
    const fn = (async (url: string) => {
      post += 1;
      if (!url.endsWith("/v1/cc/decision")) throw new Error("no polling expected");
      return new Response(
        JSON.stringify({ hold: false, reason: post === 1 ? "no-activity" : "stale-session" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {}, trace: (e: { event: string }) => events.push(e as { event: string }),
    }) as never);
    expect(events.filter((e) => e.event === "posted").map((e) => e.reason)).toEqual(["no-activity", "stale-session"]);
    expect(events.filter((e) => e.event === "hold").map((e) => e.reason)).toEqual(["no-activity", "stale-session"]);
  });

  test("hold=true on the first ask → NO re-ask (single POST)", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);
    expect(calls.filter((c) => c.method === "POST").length).toBe(1);
  });

  test("POST body is the frozen wire shape: decisionPending blob + needsAttention fallbackBlob", async () => {
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: () => {} }) as never);
    const post = calls.find((c) => c.method === "POST")!;
    const body = JSON.parse(post.body!);
    expect(body).toMatchObject({ v: 2, sessionId: "sess-1", requestId: "req-fixed", op: "update", prio: 1, ts: 1000 });
    expect(typeof body.blob).toBe("string");
    expect(typeof body.fallbackBlob).toBe("string");
    const blob = (await decryptBlob(KEY, body.blob)) as Record<string, unknown>;
    expect(blob.status).toBe("decisionPending");
    expect(blob.permissionSummary).toBe("rm -rf build");
    expect(blob.permissionRequestId).toBe("req-fixed");
    expect(blob.permissionToolName).toBe("Bash");
    expect(blob.permissionDetail).toBe("rm -rf build"); // full command (single-line here)
    // appended LAST inside the sealed JSON (append-last discipline for the iOS decoder):
    // permissionSummary, permissionRequestId, permissionToolName, then permissionDetail (Bash → present).
    expect(Object.keys(blob).slice(-4)).toEqual(
      ["permissionSummary", "permissionRequestId", "permissionToolName", "permissionDetail"]);
    const fb = (await decryptBlob(KEY, body.fallbackBlob)) as Record<string, unknown>;
    expect(fb.status).toBe("needsAttention");
    expect("permissionSummary" in fb).toBe(false);
    expect("permissionRequestId" in fb).toBe(false);
    expect("permissionToolName" in fb).toBe(false);
    expect("permissionDetail" in fb).toBe(false);
  });

  // `at` — the sort/age key every OTHER frame has carried since v1.1.6 (epoch SECONDS, not the envelope's
  // ms `ts`). buildBlob takes it as its 9th argument; the held frames were calling it with 8, so a
  // decisionPending row reached the phone with no honest event time at all — and the codex E2E vector
  // (cc-e2e-test-vectors.json: status decisionPending, "at": 1784937605) described a frame the plugin
  // never actually emitted. Both sealed variants carry it, since both derive from the same base blob.
  test("the held frame carries `at` (epoch SECONDS of the event) in BOTH the blob and the fallbackBlob", async () => {
    const nowMs = 1_784_937_605_400;                                  // the vector's epoch second, plus 400 ms
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: () => {}, now: () => nowMs }) as never);
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    const blob = (await decryptBlob(KEY, body.blob)) as Record<string, unknown>;
    const fb = (await decryptBlob(KEY, body.fallbackBlob)) as Record<string, unknown>;
    expect(blob.at).toBe(1_784_937_605);                              // FLOORED seconds, the vector's shape
    expect(fb.at).toBe(1_784_937_605);
    expect(body.ts).toBe(nowMs);                                      // the envelope stays in MILLIseconds
    // Appended LAST in the base blob — i.e. immediately BEFORE the permission tail, so the frozen
    // append-only order of the permission keys is untouched.
    const keys = Object.keys(blob);
    expect(keys[keys.indexOf("permissionSummary") - 1]).toBe("at");
    expect(Object.keys(fb).at(-1)).toBe("at");
  });

  test("hold=true, answered allow → emits exactly the allow line", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [{ status: "pending" }, { status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);
    expect(calls.filter((c) => c.method === "GET").length).toBe(2);
  });

  test("answered deny → emits the deny line", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "deny", ts: 5 });
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([DENY]);
  });

  test("requestId mismatch inside the sealed answer → silent (replay guard)", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "someone-else", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([]);
  });

  test("status=expired → stops, silent", async () => {
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, [{ status: "pending" }, { status: "expired" }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([]);
  });

  test("transient GET failure is tolerated — keeps polling", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, ["throw", { status: "pending" }, { status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);
  });

  test("gives up silently after sustained poll failures (fail open)", async () => {
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, ["throw"]); // every GET fails forever (script repeats last entry)
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([]);
    expect(calls.filter((c) => c.method === "GET").length).toBe(100); // MAX_CONSECUTIVE_MISSES
  });

  // DEFINITIVE poll statuses. 401/403/404/410 mean this pairing can never read this record (unauthorized /
  // revoked / GC'd), so waiting out the ~5.4 min transient cap blocks the terminal for an outcome already
  // known. Two consecutive strikes (one can be a racing delete/deploy) release at once — the same
  // gone-strike shape runHook uses.
  for (const status of [401, 403, 404, 410]) {
    test(`poll HTTP ${status} twice → releases immediately (2 GETs, not the 100-miss cap)`, async () => {
      const emitted: string[] = [];
      const events: Array<{ event: string; [k: string]: unknown }> = [];
      const { fn, calls } = scriptFetch(true, [status]);
      await runPermissionHook(baseDeps({
        fetchFn: fn, emit: (l: string) => emitted.push(l),
        trace: (e: { event: string }) => events.push(e as { event: string }),
      }) as never);
      expect(emitted).toEqual([]);
      expect(calls.filter((c) => c.method === "GET").length).toBe(2); // MAX_DEFINITIVE_POLL_FAILURES
      expect(events.find((e) => e.event === "giveup")).toMatchObject({ reason: "definitive", status, strikes: 2 });
      expect(events.at(-1)).toMatchObject({ event: "exit", reason: "definitive" });
    });
  }

  test("a SINGLE definitive status is tolerated — a racing delete/deploy must not kill a live hold", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [404, { status: "pending" }, 404, { status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);                                  // the strike streak is broken by the 200
    expect(calls.filter((c) => c.method === "GET").length).toBe(4);
  });

  test("429/5xx stay TRANSIENT — they ride the miss cap, never the definitive release", async () => {
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [429, 500]);                // 500 repeats forever after the 429
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([]);
    expect(calls.filter((c) => c.method === "GET").length).toBe(100);   // MAX_CONSECUTIVE_MISSES, unchanged
  });

  test("unparseable stdin → silent fail-open, and the trace records the CLASS only (never the payload)", async () => {
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    const emitted: string[] = [];
    const secret = "curl -H 'authorization: Bearer sk-super-secret-token' https://x";
    const fn = (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      readInput: async () => `{"tool_input":{"command":"${secret}"}`,   // truncated JSON — a real hook payload
      trace: (e: { event: string }) => events.push(e as { event: string }),
    }) as never);
    expect(emitted).toEqual([]);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "bad-stdin", error: "SyntaxError" });
    // The whole point: nothing the parser quoted back at us reaches the on-disk trace.
    expect(JSON.stringify(events)).not.toContain("sk-super-secret-token");
    expect(JSON.stringify(events)).not.toContain("curl");
  });

  test("network error on the POST → fail open, silent, no throw", async () => {
    const emitted: string[] = [];
    const fn = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([]);
  });

  test("POST fails FAST once then the retry succeeds → holds and answers normally", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const gets: Array<Record<string, unknown>> = [{ status: "pending" }, { status: "answered", answerBlob }];
    const emitted: string[] = [];
    const events: Array<{ event: string; attempt?: number }> = [];
    let postCount = 0;
    let g = 0;
    const fn = (async (url: string) => {
      if (url.endsWith("/v1/cc/decision")) {
        postCount += 1;
        // A FAST failure (connection refused): retrying costs ~nothing, so the retry survives.
        if (postCount === 1) { const e = new Error("refused") as Error & { code?: string }; e.code = "ECONNREFUSED"; throw e; }
        return new Response(JSON.stringify({ hold: true }), { status: 200 });
      }
      return new Response(JSON.stringify(gets[Math.min(g++, gets.length - 1)]), { status: 200 });
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      trace: (e: { event: string; attempt?: number }) => events.push(e),
    }) as never);
    expect(postCount).toBe(2);              // first attempt threw fast, second succeeded
    expect(emitted).toEqual([ALLOW]);       // proceeded to poll + answer normally
    expect(events.filter((e) => e.event === "posted").map((e) => e.attempt)).toEqual([1, 2]);
  });

  test("both FAST-failing POST attempts fail → fail open silent, trace shows two posted attempts", async () => {
    const emitted: string[] = [];
    const events: Array<{ event: string; attempt?: number; reason?: string }> = [];
    let postCount = 0;
    let probeCount = 0;
    const fn = (async (url: string) => {
      if (url.endsWith("/v1/cc/decision")) postCount += 1; else probeCount += 1;
      const e = new Error("refused") as Error & { code?: string }; e.code = "ECONNREFUSED"; throw e;
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      trace: (e: { event: string; attempt?: number; reason?: string }) => events.push(e),
    }) as never);
    expect(postCount).toBe(2);
    expect(probeCount).toBe(1);            // ONE did-it-land probe, which also failed → the old fail-open
    expect(emitted).toEqual([]);
    expect(events.filter((e) => e.event === "posted").map((e) => e.attempt)).toEqual([1, 2]);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "post-error" });
  });

  // STALLED NETWORK (captive portal / hung proxy / half-open TCP). The dialog must not wait behind a
  // SECOND long ceiling for an answer the first stall already gave: one first-contact POST, one cheap
  // probe, out. The whole pre-dialog block is POST_FIRST_CONTACT_TIMEOUT_MS + POLL_TIMEOUT_MS ≈ 6s,
  // not the ~33s two 15s POSTs used to cost.
  test("POST TIMES OUT → exactly one POST attempt (no long-ceiling retry) + one probe, then fail open", async () => {
    const emitted: string[] = [];
    const events: Array<{ event: string; attempt?: number; reason?: string }> = [];
    const waits: number[] = [];
    let postCount = 0;
    let probeCount = 0;
    const fn = (async (url: string) => {
      if (url.endsWith("/v1/cc/decision")) postCount += 1; else probeCount += 1;
      const e = new Error("timeout"); e.name = "TimeoutError"; throw e;
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      sleep: async (ms: number) => { waits.push(ms); },
      trace: (e: { event: string; attempt?: number; reason?: string }) => events.push(e),
    }) as never);
    expect(postCount).toBe(1);             // the stall IS the answer — no second 4s ceiling
    expect(probeCount).toBe(1);            // the did-it-land probe still runs (2s)
    expect(waits).toEqual([]);             // not even the 1s retry pause is paid
    expect(emitted).toEqual([]);
    expect(events.filter((e) => e.event === "posted").map((e) => e.attempt)).toEqual([1]);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "post-error" });
  });

  // A POST timing out CLIENT-side says nothing about whether it LANDED. If it did, the worker is holding
  // a real record and the phone is showing the card — exiting fail-open there makes the phone lie (a tap
  // is applied to nothing). One cheap GET distinguishes the two worlds.
  test("the POST times out but the request LANDED → the probe finds it and the hold is honored", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const gets: Array<Record<string, unknown>> = [{ status: "pending" }, { status: "answered", answerBlob }];
    const emitted: string[] = [];
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    let postCount = 0;
    let g = 0;
    const fn = (async (url: string) => {
      if (url.endsWith("/v1/cc/decision")) {
        postCount += 1;                                       // the worker RECEIVED it, the client gave up
        const e = new Error("timeout"); e.name = "TimeoutError"; throw e;
      }
      return new Response(JSON.stringify(gets[Math.min(g++, gets.length - 1)]), { status: 200 });
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      trace: (e: { event: string }) => events.push(e as { event: string }),
    }) as never);
    expect(postCount).toBe(1);
    expect(emitted).toEqual([ALLOW]);                          // the phone's Allow was honored, not dropped
    expect(events.find((e) => e.event === "post-timeout-landed")).toMatchObject({ status: "pending" });
  });

  test("the POST times out and NOTHING landed (no record) → fail open, exactly one probe", async () => {
    const emitted: string[] = [];
    const events: Array<{ event: string; reason?: string }> = [];
    let getCount = 0;
    const fn = (async (url: string) => {
      if (url.endsWith("/v1/cc/decision")) { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; }
      getCount += 1;
      return new Response("", { status: 404 });               // no such record — the POSTs really never landed
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      trace: (e: { event: string; reason?: string }) => events.push(e),
    }) as never);
    expect(emitted).toEqual([]);
    expect(getCount).toBe(1);                                  // bounded: one request, then out
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "post-error" });
  });

  test("both POSTs time out and the landed record is already terminal → fail open (no hold on a dead record)", async () => {
    const emitted: string[] = [];
    let getCount = 0;
    const fn = (async (url: string) => {
      if (url.endsWith("/v1/cc/decision")) { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; }
      getCount += 1;
      return new Response(JSON.stringify({ status: "expired" }), { status: 200 });
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([]);
    expect(getCount).toBe(1);
  });

  test("unpaired (no config) → no output, no network at all", async () => {
    let fetched = false;
    const fn = (async () => { fetched = true; return new Response("{}"); }) as unknown as typeof fetch;
    const emitted: string[] = [];
    await runPermissionHook(baseDeps({ fetchFn: fn, loadConfigFn: async () => null, emit: (l: string) => emitted.push(l) }) as never);
    expect(fetched).toBe(false);
    expect(emitted).toEqual([]);
  });

  test("trace seam captures the hold lifecycle (collector injected)", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    const { fn } = scriptFetch(true, [{ status: "pending" }, { status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {},
      trace: (e: { event: string }) => events.push(e as { event: string }),
    }) as never);
    const names = events.map((e) => e.event);
    // lifecycle in order: stdin → start → POST → hold → poll pairs → answer/emit → exit
    expect(names).toEqual([
      "stdin-read", "start", "posted", "hold",
      "poll-begin", "poll-end", "poll-begin", "poll-end",
      "emit", "answered", "exit",
    ]);
    expect(events.find((e) => e.event === "emit")).toMatchObject({ decision: "allow" });
    expect(events.find((e) => e.event === "answered")).toMatchObject({ match: true });
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "answered" });
    // every poll-begin has a matching poll-end (a lone begin would mean death mid-fetch)
    expect(names.filter((n) => n === "poll-begin").length).toBe(names.filter((n) => n === "poll-end").length);
  });

  test("giveup path traces a giveup + exit event", async () => {
    const events: Array<{ event: string }> = [];
    const { fn } = scriptFetch(true, ["throw"]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {},
      trace: (e: { event: string }) => events.push(e as { event: string }),
    }) as never);
    expect(events.some((e) => e.event === "giveup")).toBe(true);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "giveup" });
  });

  test("no-hold flag present → delegates, never POSTs a decision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-nohold-"));
    const flag = join(dir, "no-hold");
    await writeFile(flag, "");
    let delegated = false;
    let fetched = false;
    const fn = (async () => { fetched = true; return new Response("{}"); }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, noHoldPath: flag, emit: () => {},
      delegate: async () => { delegated = true; },
    }) as never);
    expect(delegated).toBe(true);
    expect(fetched).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

// ---- pass-through gates (subagent / permission_mode) --------------------------------------
//
// The hold must never block a non-interactive/auto flow: an `agent_id` (subagent sidechain) or a
// non-interactive permission_mode ("auto"/"dontAsk"/"bypassPermissions"/unknown) exits 0 with zero
// output and — crucially — zero network, BEFORE any POST.

/** INPUT with extra top-level fields merged in (agent_id, permission_mode, …). */
const inputWith = (extra: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(INPUT), ...extra });

/** A fetch that records whether it was ever called — the gate must reach NONE of these. */
function spyFetch() {
  let called = false;
  const fn = (async () => { called = true; return new Response(JSON.stringify({ hold: false }), { status: 200 }); }) as unknown as typeof fetch;
  return { fn, called: () => called };
}

describe("runPermissionHook — pass-through gates", () => {
  test("agent_id present (subagent) → pass-through BEFORE any fetch, silent", async () => {
    const spy = spyFetch();
    const emitted: string[] = [];
    const events: Array<{ event: string; reason?: string; agent_type?: unknown }> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ agent_id: "agent-abc", agent_type: "Explore" }),
      fetchFn: spy.fn, emit: (l: string) => emitted.push(l),
      trace: (e: { event: string; reason?: string }) => events.push(e),
    }) as never);
    expect(spy.called()).toBe(false); // zero network — gate fired before the POST
    expect(emitted).toEqual([]);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "subagent", agent_type: "Explore" });
  });

  test("empty-string agent_id is NOT a subagent → proceeds to the POST path", async () => {
    const spy = spyFetch();
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ agent_id: "" }),
      fetchFn: spy.fn, emit: () => {},
    }) as never);
    expect(spy.called()).toBe(true); // empty agent_id ⇒ main thread ⇒ hold path runs
  });

  for (const mode of ["auto", "dontAsk", "bypassPermissions"]) {
    test(`permission_mode="${mode}" → pass-through BEFORE any fetch, silent`, async () => {
      const spy = spyFetch();
      const emitted: string[] = [];
      const events: Array<{ event: string; reason?: string; mode?: unknown }> = [];
      await runPermissionHook(baseDeps({
        readInput: async () => inputWith({ permission_mode: mode }),
        fetchFn: spy.fn, emit: (l: string) => emitted.push(l),
        trace: (e: { event: string; reason?: string }) => events.push(e),
      }) as never);
      expect(spy.called()).toBe(false);
      expect(emitted).toEqual([]);
      expect(events.at(-1)).toMatchObject({ event: "exit", reason: "mode", mode });
    });
  }

  test("unrecognized future permission_mode → pass-through (fail-open bias)", async () => {
    const spy = spyFetch();
    const events: Array<{ event: string; reason?: string; mode?: unknown }> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ permission_mode: "someFutureMode" }),
      fetchFn: spy.fn, emit: () => {},
      trace: (e: { event: string; reason?: string }) => events.push(e),
    }) as never);
    expect(spy.called()).toBe(false);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "mode", mode: "someFutureMode" });
  });

  for (const mode of ["default", "acceptEdits", "plan"]) {
    test(`permission_mode="${mode}" → PROCEEDS to the POST path (holdable dialog mode)`, async () => {
      const spy = spyFetch();
      await runPermissionHook(baseDeps({
        readInput: async () => inputWith({ permission_mode: mode }),
        fetchFn: spy.fn, emit: () => {},
      }) as never);
      expect(spy.called()).toBe(true);
    });
  }

  test("MISSING permission_mode (older CC) → PROCEEDS to the POST path (prior behavior)", async () => {
    const spy = spyFetch();
    await runPermissionHook(baseDeps({
      readInput: async () => INPUT, // no permission_mode, no agent_id
      fetchFn: spy.fn, emit: () => {},
    }) as never);
    expect(spy.called()).toBe(true);
  });

  test("start trace carries permission_mode and the agent boolean", async () => {
    const spy = spyFetch();
    const events: Array<{ event: string; permission_mode?: unknown; agent?: unknown }> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ permission_mode: "default" }),
      fetchFn: spy.fn, emit: () => {},
      trace: (e: { event: string }) => events.push(e),
    }) as never);
    expect(events.find((e) => e.event === "start")).toMatchObject({ permission_mode: "default", agent: false });
  });
});

// ---- always-allow / deny-with-message / unknown-decision / richer context / question gate ---
//
// These drive the REAL hold loop through the harness (scripted fetch + injected answer blob), never a
// mock of the module under test: a hold that reaches "answered" with each decision kind, plus the
// question pass-through that never holds at all.

describe("runPermissionHook — always-allow / deny-message / unknown decision", () => {
  /** Hold, then answer with the given decrypted answer object; returns the emitted stdout lines. */
  const answerWith = async (answer: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, ...answer });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l), ...over }) as never);
    return { emitted, calls };
  };

  test("allow_always WITH permission_suggestions → behavior allow + updatedPermissions === the suggestions VERBATIM", async () => {
    const SUGG = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }], behavior: "allow", destination: "session" }];
    const { emitted } = await answerWith(
      { decision: "allow_always" },
      { readInput: async () => inputWith({ permission_suggestions: SUGG }) },
    );
    expect(emitted.length).toBe(1);
    const decision = JSON.parse(emitted[0]).hookSpecificOutput.decision;
    expect(decision.behavior).toBe("allow");
    expect(decision.updatedPermissions).toEqual(SUGG); // passed through byte-for-byte
  });

  test("allow_always with NO suggestions → a whole-tool, session-scoped addRules for the tool_name", async () => {
    const { emitted } = await answerWith({ decision: "allow_always" }); // INPUT = Bash, no permission_suggestions
    const decision = JSON.parse(emitted[0]).hookSpecificOutput.decision;
    expect(decision.behavior).toBe("allow");
    expect(decision.updatedPermissions).toEqual([
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
    ]);
  });

  test("allow_always with an EMPTY suggestions array → still the whole-tool session rule", async () => {
    const { emitted } = await answerWith(
      { decision: "allow_always" },
      { readInput: async () => inputWith({ permission_suggestions: [] }) },
    );
    expect(JSON.parse(emitted[0]).hookSpecificOutput.decision.updatedPermissions).toEqual([
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
    ]);
  });

  test("deny WITH a custom message → behavior deny + the phone's message", async () => {
    const { emitted } = await answerWith({ decision: "deny", message: "use bun instead" });
    expect(JSON.parse(emitted[0]).hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "use bun instead" });
  });

  test("deny with a 600-char message → truncated to 500", async () => {
    const { emitted } = await answerWith({ decision: "deny", message: "x".repeat(600) });
    const msg = JSON.parse(emitted[0]).hookSpecificOutput.decision.message;
    expect(msg.length).toBe(500);
    expect(msg).toBe("x".repeat(500));
  });

  test("deny WITHOUT a message → byte-identical to the frozen DENY line", async () => {
    const { emitted } = await answerWith({ decision: "deny" });
    expect(emitted).toEqual([DENY]);
  });

  test("deny with a whitespace-only message → also the frozen DENY line", async () => {
    const { emitted } = await answerWith({ decision: "deny", message: "   " });
    expect(emitted).toEqual([DENY]);
  });

  test("plain allow still emits the frozen ALLOW line byte-identical", async () => {
    const { emitted } = await answerWith({ decision: "allow" });
    expect(emitted).toEqual([ALLOW]);
  });

  // UNKNOWN VERB — bounded, because an `answered` record is TERMINAL. The worker 409s any re-answer and
  // serves the SAME answerBlob for the record's whole 24h TTL, so a verb this plugin cannot understand can
  // never turn into one it can: the old unbounded "keep-polling" froze the terminal for the hook's full
  // 86400 s timeout (~26k doomed GETs) while the phone showed "answered".
  //
  // (The previous version of this test scripted a DIFFERENT answerBlob on the second GET of the same
  // requestId — a response the real worker cannot produce — so it certified a scenario that does not exist
  // and hid exactly this bug. The reality is the SAME blob, forever.)
  test("UNKNOWN decision on a TERMINAL record → nothing emitted and the hold RELEASES after a small bound", async () => {
    const unknownBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "some_future_verb", ts: 5 });
    const emitted: string[] = [];
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    // The worker serves this identical terminal record on EVERY poll (scriptFetch repeats the last entry).
    const { fn, calls } = scriptFetch(true, [{ status: "answered", answerBlob: unknownBlob }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      trace: (e: { event: string }) => events.push(e as { event: string }),
    }) as never);
    expect(emitted).toEqual([]);                                         // never guessed a line for the unknown verb
    expect(calls.filter((c) => c.method === "GET").length).toBe(3);      // MAX_UNKNOWN_ANSWER_READS — then it lets go
    expect(events.find((e) => e.event === "release")).toMatchObject({ reason: "unknown-decision-terminal", reads: 3 });
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "unknown-decision" });
  });

  test("forward-compat polling SURVIVES: pending polls don't spend the bound, and a KNOWN verb still lands", async () => {
    const unknownBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "some_future_verb", ts: 5 });
    const allowBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 6 });
    const emitted: string[] = [];
    // Two pending polls, then ONE unknown read, then the record is superseded by a NEW answer the plugin
    // does understand (a different answerBlob → the bound resets). All still inside MAX_UNKNOWN_ANSWER_READS.
    const { fn, calls } = scriptFetch(true, [
      { status: "pending" },
      { status: "pending" },
      { status: "answered", answerBlob: unknownBlob },
      { status: "answered", answerBlob: allowBlob },
    ]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);
    expect(calls.filter((c) => c.method === "GET").length).toBe(4);
  });
});

// ---- ExitPlanMode allow needs updatedInput (NOM-36) ---------------------------------------
//
// CC ignores a BARE {behavior:"allow"} for ExitPlanMode: deny works (the plan is rejected), but a
// bare allow is a NO-OP — the plan is never approved and the session stays in plan mode. The fix
// echoes the tool_input back via `updatedInput` (the open-vibe-island reference does this for EVERY
// allow — BridgeServer's `updatedInput ?? payload.toolInput`). We scope the echo to ExitPlanMode so
// every OTHER tool's allow stays byte-identical to the frozen ALLOW line.

describe("runPermissionHook — ExitPlanMode allow carries updatedInput (NOM-36)", () => {
  const PLAN = "## Plan\n- create hello.txt\n- verify";
  const exitPlanInput = JSON.stringify({
    session_id: "sess-1", hook_event_name: "PermissionRequest",
    tool_name: "ExitPlanMode", tool_input: { plan: PLAN },
    cwd: "/Users/x/proj", transcript_path: "/tmp/t.jsonl",
  });
  const answerExitPlan = async (answer: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, ...answer });
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), readInput: async () => exitPlanInput, ...over,
    }) as never);
    return emitted;
  };

  test("plain allow → behavior allow + updatedInput === the original tool_input (the plan)", async () => {
    const emitted = await answerExitPlan({ decision: "allow" });
    expect(emitted.length).toBe(1);
    const decision = JSON.parse(emitted[0]).hookSpecificOutput.decision;
    expect(decision).toEqual({ behavior: "allow", updatedInput: { plan: PLAN } });
  });

  test("allow_always → behavior allow + updatedInput + a session-scoped ExitPlanMode rule", async () => {
    const emitted = await answerExitPlan({ decision: "allow_always" });
    const decision = JSON.parse(emitted[0]).hookSpecificOutput.decision;
    expect(decision.behavior).toBe("allow");
    expect(decision.updatedInput).toEqual({ plan: PLAN });
    expect(decision.updatedPermissions).toEqual([
      { type: "addRules", rules: [{ toolName: "ExitPlanMode" }], behavior: "allow", destination: "session" },
    ]);
  });

  test("allow_always WITH permission_suggestions → suggestions VERBATIM + updatedInput still echoed", async () => {
    const SUGG = [{ type: "addRules", rules: [{ toolName: "ExitPlanMode" }], behavior: "allow", destination: "session" }];
    const emitted = await answerExitPlan(
      { decision: "allow_always" },
      { readInput: async () => JSON.stringify({ ...JSON.parse(exitPlanInput), permission_suggestions: SUGG }) },
    );
    const decision = JSON.parse(emitted[0]).hookSpecificOutput.decision;
    expect(decision.updatedInput).toEqual({ plan: PLAN });
    expect(decision.updatedPermissions).toEqual(SUGG);
  });

  test("codex agent seam still wraps the ExitPlanMode allow in continue:true", async () => {
    // ExitPlanMode never fires for a real Codex session, but the decision seam is agent-agnostic —
    // the updatedInput echo must survive the continue:true envelope untouched.
    const emitted = await answerExitPlan({ decision: "allow" }, {});
    // (claude default above) — now the codex variant:
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, decision: "allow" });
    const codexEmitted: string[] = [];
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => codexEmitted.push(l), readInput: async () => exitPlanInput,
    }) as never, "codex");
    const parsed = JSON.parse(codexEmitted[0]);
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput.decision).toEqual({ behavior: "allow", updatedInput: { plan: PLAN } });
    expect(emitted.length).toBe(1); // (claude path sanity)
  });

  test("a NON-ExitPlanMode allow stays the frozen bare allow (no updatedInput)", async () => {
    // INPUT default = Bash → must stay byte-identical to the pre-fix wire.
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, decision: "allow" });
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);
    expect(JSON.parse(emitted[0]).hookSpecificOutput.decision).toEqual({ behavior: "allow" });
  });
});

// ---- richer context: the decision blob's permissionToolName / permissionDetail ----------------

describe("runPermissionHook — decision blob detail fields", () => {
  const postedBlob = async (over: Record<string, unknown>) => {
    const { fn, calls } = scriptFetch(false, []); // hold:false is fine — the POST body is built regardless
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: () => {}, ...over }) as never);
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    return { body, blob: (await decryptBlob(KEY, body.blob)) as Record<string, unknown> };
  };

  test("Bash → permissionToolName 'Bash' + permissionDetail is the FULL multi-line command", async () => {
    const cmd = "cd /Users/x/proj\nbun test\necho done";
    const { blob } = await postedBlob({ readInput: async () => inputWith({ tool_input: { command: cmd } }) });
    expect(blob.permissionToolName).toBe("Bash");
    expect(blob.permissionDetail).toBe(cmd); // all lines — the summary took only the first
    expect(blob).not.toHaveProperty("permissionDetailOmitted");
  });

  test("Edit → permissionDetail is the FULL file_path (summary is just the basename)", async () => {
    const { blob } = await postedBlob({
      readInput: async () => inputWith({ tool_name: "Edit", tool_input: { file_path: "/Users/x/proj/src/main.ts" } }),
    });
    expect(blob.permissionToolName).toBe("Edit");
    expect(blob.permissionDetail).toBe("/Users/x/proj/src/main.ts");
  });

  test("empty detail (unknown tool) → permissionDetail key OMITTED, permissionToolName still present", async () => {
    const { blob } = await postedBlob({
      readInput: async () => inputWith({ tool_name: "SomethingElse", tool_input: {} }),
    });
    expect(blob.permissionToolName).toBe("SomethingElse");
    expect("permissionDetail" in blob).toBe(false);
    expect("permissionDetailOmitted" in blob).toBe(false);
  });

  // Step 3: the worker rejects a decision POST whose `blob` exceeds MAX_BLOB_CHARS (3072 base64 chars —
  // enforced server-side, NOT in this plugin; encryptBlob never hard-fails on size). The detail is no
  // longer flat-capped (NOM-38): `fitPermissionDetail` sizes the real frame, so even an enormous plan
  // lands under the ceiling — while delivering vastly more than the old 400 chars.
  test("a huge detail + the fattest fields still keeps the sealed blob under the worker's 3072-char cap", async () => {
    const record = { pid: 1, machine: "m", label: "l", title: "y".repeat(120), ts: 1000 };
    const { body, blob } = await postedBlob({
      readRecordFn: async () => record,
      readInput: async () => inputWith({ tool_input: { command: "x".repeat(20_000) } }),
    });
    expect(body.blob.length).toBeLessThanOrEqual(3072);
    expect((blob.permissionDetail as string).length).toBeGreaterThan(1200); // was 400 pre-NOM-38
    expect(blob.permissionDetailOmitted as number).toBeGreaterThan(0);
  });

  // A SWEEP, not a fixture — and deliberately so. The fit's binary search bottoms out at a one-character
  // "…" prefix, which is NOT free: it drags in the whole `permissionDetail` key plus
  // `permissionDetailOmitted` (~76 base64 chars sealed, MORE than BLOB_FIT_MARGIN). So for a narrow band
  // of base sizes the fit used to emit 3076–3084-char blobs — over the worker's hard 3072 cap, 400'd, and
  // the hold falls open with the phone never seeing the card. Any single fixture sails straight past that
  // band; only sweeping the base size lands inside it. Every step must stay under the cap.
  test("SWEEP: across a range of base sizes the emitted blob is ALWAYS <= the worker's 3072-char cap", async () => {
    let sawDroppedDetail = false;
    let sawKeptDetail = false;
    for (let n = 1500; n <= 1980; n += 1) {
      const { body, blob } = await postedBlob({
        readRecordFn: async () => ({ pid: 1, machine: "m", label: "api-status", title: "y".repeat(n), ts: 1000, model: "claude-opus-5" }),
        readInput: async () => inputWith({ tool_input: { command: "c".repeat(8000) } }),
      });
      if (body.blob.length > 3072) throw new Error(`base title=${n} emitted a ${body.blob.length}-char blob (cap 3072)`);
      if ("permissionDetail" in blob) sawKeptDetail = true; else sawDroppedDetail = true;
    }
    // The sweep genuinely straddles the floor: some sizes still carry a detail, the fattest shed it whole.
    expect(sawKeptDetail).toBe(true);
    expect(sawDroppedDetail).toBe(true);
  }, 30_000);

  test("ExitPlanMode → the plan rides as permissionDetail; a short plan omits the truncation count", async () => {
    const plan = "# Plan\n\n1. Do the thing\n2. Do the other thing\n\n**Risk:** low";
    const { blob } = await postedBlob({
      readInput: async () => inputWith({ tool_name: "ExitPlanMode", tool_input: { plan } }),
    });
    expect(blob.permissionToolName).toBe("ExitPlanMode");
    expect(blob.permissionDetail).toBe(plan);                 // WHOLE plan, not a 400-char stub
    expect("permissionDetailOmitted" in blob).toBe(false);    // nothing dropped ⇒ key absent
  });

  test("a truncated detail appends permissionDetailOmitted LAST (append-only wire discipline)", async () => {
    const { blob } = await postedBlob({
      readInput: async () => inputWith({ tool_name: "ExitPlanMode", tool_input: { plan: "p".repeat(9000) } }),
    });
    expect(Object.keys(blob).slice(-5)).toEqual([
      "permissionSummary", "permissionRequestId", "permissionToolName",
      "permissionDetail", "permissionDetailOmitted",
    ]);
  });
});

// ---- AskUserQuestion HOLDS and is answered from the phone -----------------------------------
//
// The old question-passthrough gate (a buzz on the phone, answer at the Mac) is GONE: a question now
// holds like every other tool, its options ride the sealed blob, and the phone's `answer` verb injects
// the selection through `updatedInput`. The injection contract was verified against the shipped CC
// bundle (v2.1.219): `updatedInput` is what makes CC skip its own interactive ask for the three tools
// that declare requiresUserInteraction() — AskUserQuestion, ExitPlanMode and the Cowork role picker —
// the input is a strictObject (only questions/answers/annotations/metadata, questions required), and
// `answers` is keyed by QUESTION TEXT valued by an option LABEL. A multi-select answer is the labels
// pre-joined as "A, B" (CC's schema pre-processes that form).
//
// SAFETY: on CC's HEADLESS path a bare {behavior:"allow"} on AskUserQuestion converts to a hard DENY.
// So an `answer` that cannot be turned into a valid answers map must emit NOTHING and keep polling —
// never a bare allow.

describe("runPermissionHook — AskUserQuestion holds", () => {
  const questionInput = (questions: unknown = CC_QUESTIONS) => JSON.stringify({
    session_id: "sess-1", hook_event_name: "PermissionRequest",
    tool_name: "AskUserQuestion", tool_input: { questions },
    cwd: "/Users/x/proj", transcript_path: "/tmp/t.jsonl",
  });

  /** Hold a question, then answer it; returns the emitted stdout lines + the fetch calls. */
  const answerQuestion = async (answer: Record<string, unknown>, over: Record<string, unknown> = {}, agent?: "codex") => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, ...answer });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    const deps = baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), readInput: async () => questionInput(), ...over,
    }) as never;
    await (agent ? runPermissionHook(deps, agent) : runPermissionHook(deps));
    return { emitted, calls };
  };

  test("tool_name AskUserQuestion → HOLDS (POSTs a decision, never delegates)", async () => {
    const { fn, calls } = scriptFetch(false, []);
    const emitted: string[] = [];
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), readInput: async () => questionInput(),
      delegate: async () => { throw new Error("delegate must not run for a question"); },
    }) as never);
    expect(calls.filter((c) => c.method === "POST").length).toBeGreaterThan(0);
    expect(emitted).toEqual([]);
  });

  test("the blob carries permissionQuestions LAST, options intact", async () => {
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: () => {}, readInput: async () => questionInput() }) as never);
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    const blob = (await decryptBlob(KEY, body.blob)) as Record<string, unknown>;
    expect(blob.permissionToolName).toBe("AskUserQuestion");
    expect(blob.permissionSummary).toBe("Which testing approach should I use for the new parser?");
    expect(blob.permissionQuestions).toEqual([
      {
        q: "Which testing approach should I use for the new parser?",
        h: "Testing",
        o: ["Unit tests only", "Integration tests"],
        d: ["Fast and isolated; misses wiring bugs.", "Slower but exercises the real pipeline."],
      },
    ]);
    expect(Object.keys(blob).at(-1)).toBe("permissionQuestions"); // append-last wire discipline
    expect(body.blob.length).toBeLessThanOrEqual(3072);
  });

  test("a huge question text → permissionDetail is ABSENT and permissionQuestions is still LAST", async () => {
    // The question text is NOT duplicated into permissionDetail (it already rides as permissionSummary
    // and permissionQuestions[0].q) — a third copy competed for the same 3072-char ceiling.
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {},
      readInput: async () => questionInput([{ question: "q".repeat(9000), options: [{ label: "A" }, { label: "B" }] }]),
    }) as never);
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    const blob = (await decryptBlob(KEY, body.blob)) as Record<string, unknown>;
    expect("permissionDetail" in blob).toBe(false);
    expect("permissionDetailOmitted" in blob).toBe(false);
    expect(Object.keys(blob).slice(-4)).toEqual([
      "permissionSummary", "permissionRequestId", "permissionToolName", "permissionQuestions",
    ]);
    expect(body.blob.length).toBeLessThanOrEqual(3072);
  });

  /** `count` questions × 4 options, every string at its cap — CC's own worst case, scaled. */
  const fatQuestions = (count: number) => Array.from({ length: count }, (_, i) => ({
    question: `${i}` + "Q".repeat(400),
    header: "Header12chr",
    multiSelect: true,
    options: Array.from({ length: 4 }, (_, j) => ({ label: `${j}` + "L".repeat(200), description: "d".repeat(300) })),
  }));

  const postQuestions = async (questions: unknown) => {
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {},
      readRecordFn: async () => ({ pid: 1, machine: "m", label: "api-status", title: "y".repeat(120), ts: 1000 }),
      readInput: async () => questionInput(questions),
    }) as never);
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    return { body, blob: (await decryptBlob(KEY, body.blob)) as Record<string, unknown> };
  };

  // BRACKETED on purpose: asserting only that the fat payload's field is ABSENT would still pass with the
  // whole feature reverted, so the one-notch-smaller payload must be asserted PRESENT in the same breath.
  test("questions too fat for the frame → permissionQuestions OMITTED entirely, the hold still posts", async () => {
    // The whole field is dropped (never a partial list — a half-shown option list would be a lie) and the
    // phone shows the read-only prompt.
    const { body, blob } = await postQuestions(fatQuestions(4));
    expect("permissionQuestions" in blob).toBe(false);
    expect(blob.permissionToolName).toBe("AskUserQuestion"); // the hold itself is unaffected
    expect(body.blob.length).toBeLessThanOrEqual(3072);
  });

  test("…but ONE NOTCH SMALLER still rides — the drop is a real budget boundary, not a dead branch", async () => {
    const { body, blob } = await postQuestions(fatQuestions(3));
    expect(Array.isArray(blob.permissionQuestions)).toBe(true);
    expect((blob.permissionQuestions as unknown[]).length).toBe(3);
    expect((blob.permissionQuestions as Array<Record<string, unknown>>).every((question) => !("d" in question))).toBe(true);
    expect(body.blob.length).toBeLessThanOrEqual(3072);
  });

  test("answer → allow + updatedInput echoing questions VERBATIM plus an answers map (the exact wire)", async () => {
    const { emitted } = await answerQuestion({ decision: "answer", answers: ["Unit tests only"] });
    expect(emitted).toEqual([JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: {
            questions: CC_QUESTIONS,
            answers: { "Which testing approach should I use for the new parser?": "Unit tests only" },
          },
        },
      },
    })]);
    const updatedInput = JSON.parse(emitted[0]).hookSpecificOutput.decision.updatedInput;
    expect(updatedInput.questions).toEqual(CC_QUESTIONS);                  // byte-for-byte echo
    expect(Object.keys(updatedInput).sort()).toEqual(["answers", "questions"]); // strictObject trap
  });

  test("the echo preserves OTHER allowed keys (metadata) and OVERWRITES a pre-existing answers — no illegal key ever appears", async () => {
    // The strictObject trap has two halves: nothing CC disallows may be ADDED, and nothing CC sent may be
    // LOST. A questions-only fixture exercises neither, so drive the spread with metadata present and a
    // stale `answers` already in the tool_input.
    const metadata = { source: "cli", nested: { k: 1 } };
    const withExtras = JSON.stringify({
      session_id: "sess-1", hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion",
      tool_input: { questions: CC_QUESTIONS, answers: { stale: "value" }, metadata },
      cwd: "/Users/x/proj", transcript_path: "/tmp/t.jsonl",
    });
    const { emitted } = await answerQuestion(
      { decision: "answer", answers: ["Integration tests"] },
      { readInput: async () => withExtras },
    );
    const updatedInput = JSON.parse(emitted[0]).hookSpecificOutput.decision.updatedInput;
    expect(updatedInput.questions).toEqual(CC_QUESTIONS);
    expect(updatedInput.metadata).toEqual(metadata);                        // preserved, not dropped
    expect(updatedInput.answers).toEqual({                                  // the stale map is REPLACED
      "Which testing approach should I use for the new parser?": "Integration tests",
    });
    // Only keys AskUserQuestion's strictObject allows (questions/answers/annotations/metadata).
    expect(Object.keys(updatedInput).sort()).toEqual(["answers", "metadata", "questions"]);
  });

  test("multi-select → the pre-joined 'A, B' string rides through verbatim", async () => {
    const { emitted } = await answerQuestion({ decision: "answer", answers: ["Unit tests only, Integration tests"] });
    const updatedInput = JSON.parse(emitted[0]).hookSpecificOutput.decision.updatedInput;
    expect(updatedInput.answers).toEqual({
      "Which testing approach should I use for the new parser?": "Unit tests only, Integration tests",
    });
  });

  test("multi-question → answers zip BY INDEX, in the original question order", async () => {
    const qs = [
      { question: "First?", options: [{ label: "A" }, { label: "B" }] },
      { question: "Second?", options: [{ label: "C" }, { label: "D" }] },
    ];
    const { emitted } = await answerQuestion(
      { decision: "answer", answers: ["B", "C"] },
      { readInput: async () => questionInput(qs) },
    );
    const updatedInput = JSON.parse(emitted[0]).hookSpecificOutput.decision.updatedInput;
    expect(updatedInput.questions).toEqual(qs);
    expect(updatedInput.answers).toEqual({ "First?": "B", "Second?": "C" });
  });

  // POLICY CHANGE (review fix): a PARTIAL answers map is no longer emitted. This used to send
  // {"First?":"B"} for a two-question payload and leave the second key absent — but CC's behavior on a
  // partial map is unverified (the tool body is a pass-through, so a missing key may read as an empty
  // pick), and telling the session something the user never said is exactly what the release rule exists
  // to prevent. A gap in the answers ⇒ release to the terminal picker, like every other unrepresentable
  // answer. Each RELEASE case asserts nothing on stdout AND that the hold let go (one GET only).
  for (const [name, answers] of [
    ["an empty-string answer for the 2nd question", ["B", ""]],
    ["a whitespace-only answer for the 2nd question", ["B", "   "]],
    ["a SHORT answers array (2nd question missing entirely)", ["B"]],
    ["a non-string entry for the 2nd question", ["B", null]],
  ] as Array<[string, unknown[]]>) {
    test(`RELEASE: ${name} → NO partial map is ever emitted`, async () => {
      const qs = [
        { question: "First?", options: [{ label: "A" }, { label: "B" }] },
        { question: "Second?", options: [{ label: "C" }, { label: "D" }] },
      ];
      const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, decision: "answer", answers });
      const laterBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 6, decision: "deny" });
      const emitted: string[] = [];
      const { fn, calls } = scriptFetch(true, [
        { status: "answered", answerBlob },
        { status: "answered", answerBlob: laterBlob }, // must never be reached — the hold is already gone
      ]);
      await runPermissionHook(baseDeps({
        fetchFn: fn, emit: (l: string) => emitted.push(l), readInput: async () => questionInput(qs),
      }) as never);
      expect(emitted).toEqual([]);
      expect(calls.filter((c) => c.method === "GET").length).toBe(1);
    });
  }

  // DUPLICATE QUESTION TEXT: `answers` is keyed by question text, so two identical questions collapse onto
  // ONE key — the second answer overwrites the first and one question ends up answered with the other's
  // pick. Nothing on the wire can disambiguate them, so the payload is unanswerable: same policy as an
  // ambiguous option label.
  test("RELEASE: two questions with the IDENTICAL text → the collapsing map is never emitted", async () => {
    const qs = [
      { question: "Which one?", options: [{ label: "A" }, { label: "B" }] },
      { question: "Which one?", options: [{ label: "C" }, { label: "D" }] },
    ];
    const answerBlob = await encryptBlob(KEY, {
      requestId: "req-fixed", ts: 5, decision: "answer", answers: ["A", "D"],
    });
    const laterBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 6, decision: "deny" });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [
      { status: "answered", answerBlob },
      { status: "answered", answerBlob: laterBlob },
    ]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), readInput: async () => questionInput(qs),
    }) as never);
    expect(emitted).toEqual([]);                                     // never {"Which one?":"D"} for BOTH
    expect(calls.filter((c) => c.method === "GET").length).toBe(1);  // hold released
  });

  test("a SKIPPED malformed question can't shift the mapping — answers zip against what the phone was shown", async () => {
    // buildPermissionQuestions and answerLine derive from the same usable-question filter, so the
    // phone's answers[0] belongs to the first question it actually SAW, not to the dropped entry.
    const qs = [{ options: [{ label: "X" }] }, { question: "Real?", options: [{ label: "A" }, { label: "B" }] }];
    const { emitted } = await answerQuestion(
      { decision: "answer", answers: ["A"] },
      { readInput: async () => questionInput(qs) },
    );
    const updatedInput = JSON.parse(emitted[0]).hookSpecificOutput.decision.updatedInput;
    expect(updatedInput.questions).toEqual(qs);       // still echoed verbatim, malformed entry and all
    expect(updatedInput.answers).toEqual({ "Real?": "A" });
  });

  test("a MIDDLE question with zero options is dropped on BOTH ends — the answers don't shift onto the wrong question", async () => {
    // The shifted-pair case: the phone renders 2 rows (1st and 3rd) because the option-less middle
    // question is unanswerable, so its answers array is ["A","C"]. If only the blob builder skipped it,
    // "C" would land on the UNANSWERABLE question and the 3rd would go unanswered.
    const qs = [
      { question: "First?", options: [{ label: "A" }, { label: "B" }] },
      { question: "Middle, unanswerable?", options: [] },
      { question: "Third?", options: [{ label: "C" }, { label: "D" }] },
    ];
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {}, readInput: async () => questionInput(qs),
    }) as never);
    const posted = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    const blob = (await decryptBlob(KEY, posted.blob)) as Record<string, unknown>;
    expect(blob.permissionQuestions).toEqual([                       // the phone is SHOWN exactly two rows
      { q: "First?", o: ["A", "B"] },
      { q: "Third?", o: ["C", "D"] },
    ]);

    const { emitted } = await answerQuestion(
      { decision: "answer", answers: ["A", "C"] },
      { readInput: async () => questionInput(qs) },
    );
    const updatedInput = JSON.parse(emitted[0]).hookSpecificOutput.decision.updatedInput;
    expect(updatedInput.questions).toEqual(qs);                       // echoed verbatim, dropped row and all
    expect(updatedInput.answers).toEqual({ "First?": "A", "Third?": "C" });
  });

  test("a >60-char label ROUND-TRIPS: the phone echoes the capped form, CC gets the ORIGINAL", async () => {
    // A label is an IDENTIFIER to CC (`answers` is validated against the tool's own options), not prose.
    // Sending back the ellipsised 60-char form could never equal a real option, so the phone's echo is
    // re-mapped onto the full original before it goes on the wire.
    const long = `Use the ${"very ".repeat(20)}long option`;   // 108 chars
    expect(long.length).toBeGreaterThan(60);
    const qs = [{ question: "Which?", options: [{ label: long }, { label: "Short one" }] }];
    const capped = `${long.slice(0, 59)}…`;                     // exactly what buildPermissionQuestions ships
    expect(buildPermissionQuestions({ questions: qs })[0].o[0]).toBe(capped);

    const { emitted } = await answerQuestion(
      { decision: "answer", answers: [capped] },
      { readInput: async () => questionInput(qs) },
    );
    const updatedInput = JSON.parse(emitted[0]).hookSpecificOutput.decision.updatedInput;
    expect(updatedInput.answers).toEqual({ "Which?": long });   // the ORIGINAL, untruncated label
  });

  test("a multi-select of two >60-char labels round-trips BOTH originals, re-joined 'A, B'", async () => {
    const a = `Alpha ${"a".repeat(80)}`;
    const b = `Bravo ${"b".repeat(80)}`;
    const qs = [{ question: "Which?", multiSelect: true, options: [{ label: a }, { label: b }] }];
    const [ca, cb] = buildPermissionQuestions({ questions: qs })[0].o;
    const { emitted } = await answerQuestion(
      { decision: "answer", answers: [`${ca}, ${cb}`] },
      { readInput: async () => questionInput(qs) },
    );
    const updatedInput = JSON.parse(emitted[0]).hookSpecificOutput.decision.updatedInput;
    expect(updatedInput.answers).toEqual({ "Which?": `${a}, ${b}` });
  });

  test("a label that CONTAINS a comma still round-trips (the whole string is tried before splitting)", async () => {
    const qs = [{ question: "Which?", options: [{ label: "Yes, do it" }, { label: "No" }] }];
    const { emitted } = await answerQuestion(
      { decision: "answer", answers: ["Yes, do it"] },
      { readInput: async () => questionInput(qs) },
    );
    const updatedInput = JSON.parse(emitted[0]).hookSpecificOutput.decision.updatedInput;
    expect(updatedInput.answers).toEqual({ "Which?": "Yes, do it" });
  });

  test("codex agent → the same line, wrapped in continue:true", async () => {
    const { emitted } = await answerQuestion({ decision: "answer", answers: ["Unit tests only"] }, {}, "codex");
    const parsed = JSON.parse(emitted[0]);
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput.decision).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: CC_QUESTIONS,
        answers: { "Which testing approach should I use for the new parser?": "Unit tests only" },
      },
    });
  });

  // THE RELEASE RULE (all the cases below). A verb we understand but CANNOT honor for this tool exits
  // SILENTLY and stops polling: with no hook output CC just runs its own flow and shows the terminal
  // picker — the "answer at your Mac" outcome — and silence can never be converted into a deny on any
  // path, unlike a bare {behavior:"allow"} (a headless hard DENY on AskUserQuestion). Keeping the hold
  // open instead would be worse: the phone's decision record is terminal, so the hook would re-read the
  // same unusable answer forever while the phone showed "answered". The `emitted`+`GET === 1` pair is the
  // whole assertion: nothing on stdout AND the hold released.
  for (const [name, answer] of [
    ["an EMPTY answers array", { decision: "answer", answers: [] }],
    ["answers that map to nothing", { decision: "answer", answers: ["", "   "] }],
    ["a missing answers key", { decision: "answer" }],
    ["a non-array answers value", { decision: "answer", answers: "Unit tests only" }],
    ["non-string answer elements", { decision: "answer", answers: [{ label: "Unit tests only" }] }],
    ["an answer matching NO option label", { decision: "answer", answers: ["Something I was never offered"] }],
    ["a multi-select whose SECOND piece is garbage", { decision: "answer", answers: ["Unit tests only, nonsense"] }],
    ["a runaway 600-char answer string (past the 500-char bound ⇒ REFUSED, not sliced)", { decision: "answer", answers: ["z".repeat(600)] }],
  ] as Array<[string, Record<string, unknown>]>) {
    test(`RELEASE: ${name} → emits NOTHING and stops polling (never a bare allow, never an infinite hold)`, async () => {
      const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, ...answer });
      const laterBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 6, decision: "deny" });
      const emitted: string[] = [];
      const { fn, calls } = scriptFetch(true, [
        { status: "answered", answerBlob },
        { status: "answered", answerBlob: laterBlob }, // must never be reached — the hold is already gone
      ]);
      await runPermissionHook(baseDeps({
        fetchFn: fn, emit: (l: string) => emitted.push(l), readInput: async () => questionInput(),
      }) as never);
      expect(emitted).toEqual([]);                                    // nothing on stdout
      expect(calls.filter((c) => c.method === "GET").length).toBe(1);  // hold RELEASED — no second poll
    });
  }

  // The over-length answer must be REFUSED, never SLICED. Slicing at the 500-char bound can land
  // exactly on a multi-select ", " boundary such that what SURVIVES is itself a valid — but SHORTER —
  // real selection, so the truncation would silently change what the user picked and CC would be told
  // they chose it. This is that exact demonstrated case: a 495-char label + ", Yes and more" slices to
  // "<L>, Yes", which resolves cleanly onto the real labels [<L>, "Yes"]. An answer we cannot
  // represent EXACTLY is unrepresentable, so the hold releases to the terminal picker instead.
  test("RELEASE: an over-length multi-select must NOT be sliced into a shorter REAL selection", async () => {
    const long = "L".repeat(495);
    const qs = [{
      question: "Which?", multiSelect: true,
      options: [{ label: long }, { label: "Yes" }, { label: "Yes and more" }],
    }];
    const answer = `${long}, Yes and more`;
    expect(answer.length).toBeGreaterThan(500);                     // past ANSWER_MAX
    expect(answer.slice(0, 500)).toBe(`${long}, Yes`);              // …and the slice IS a valid selection
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, decision: "answer", answers: [answer] });
    const laterBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 6, decision: "deny" });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [
      { status: "answered", answerBlob },
      { status: "answered", answerBlob: laterBlob },
    ]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), readInput: async () => questionInput(qs),
    }) as never);
    expect(emitted).toEqual([]);                                    // NOT the wrong `<L>, Yes` answer
    expect(calls.filter((c) => c.method === "GET").length).toBe(1);  // hold released
  });

  test("RELEASE: `answer` on a NON-question tool → emits NOTHING and stops polling", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, decision: "answer", answers: ["yes"] });
    const denyBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 6, decision: "deny" });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [
      { status: "answered", answerBlob },
      { status: "answered", answerBlob: denyBlob },
    ]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never); // INPUT = Bash
    expect(emitted).toEqual([]);
    expect(calls.filter((c) => c.method === "GET").length).toBe(1);
  });

  for (const verb of ["allow", "allow_always"]) {
    test(`RELEASE: a bare \`${verb}\` on a QUESTION emits NOTHING and stops polling (a bare allow is a headless hard DENY)`, async () => {
      const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, decision: verb });
      const laterBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 6, decision: "deny" });
      const emitted: string[] = [];
      const { fn, calls } = scriptFetch(true, [
        { status: "answered", answerBlob },
        { status: "answered", answerBlob: laterBlob },
      ]);
      await runPermissionHook(baseDeps({
        fetchFn: fn, emit: (l: string) => emitted.push(l), readInput: async () => questionInput(),
      }) as never);
      expect(emitted).toEqual([]);
      expect(calls.filter((c) => c.method === "GET").length).toBe(1);
    });
  }

  test("a `deny` on a question is STILL honored — the release rule is scoped to verbs that can't be honored", async () => {
    const { emitted } = await answerQuestion({ decision: "deny" });
    expect(emitted).toEqual([DENY]);
  });

  test("the release path traces WHY it let go, and exits 'answered' (no giveup, no dangling poll)", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, decision: "allow" });
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {}, readInput: async () => questionInput(),
      trace: (e: { event: string }) => events.push(e as { event: string }),
    }) as never);
    expect(events.map((e) => e.event)).toEqual([
      "stdin-read", "start", "posted", "hold", "poll-begin", "poll-end", "release", "answered", "exit",
    ]);
    expect(events.find((e) => e.event === "release")).toMatchObject({ reason: "bare-allow-on-question" });
    expect(events.find((e) => e.event === "answered")).toMatchObject({ match: true, outcome: "released" });
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "answered" });
  });

  test("AskUserQuestion in an AUTO mode → the mode gate still fires FIRST (no POST at all)", async () => {
    const spy = spyFetch();
    await runPermissionHook(baseDeps({
      readInput: async () => JSON.stringify({ ...JSON.parse(questionInput()), permission_mode: "auto" }),
      fetchFn: spy.fn, emit: () => {},
    }) as never);
    expect(spy.called()).toBe(false);
  });
});

// ---- codex agent seam (continue:true decision wrapper + agent:"codex" blob tag) ---------------
//
// The SAME hold engine, driven with agent "codex" (2nd positional arg). Decision lines use Codex's
// leading `continue:true` wrapper and the sealed blob carries `agent:"codex"` so the phone tabs it
// correctly. Codex does NOT support PermissionRequest `updatedPermissions`, so a stale phone's
// allow_always answer safely degrades to the same plain-allow line. Claude's lines stay byte-identical
// (locked by the untouched claude tests above). Every case below runs the REAL hold loop through the
// scripted-fetch harness, never a mock of the SUT.

describe("runPermissionHook — codex agent", () => {
  // Codex-wrapped variants of the frozen lines (leading "continue":true, then the identical object).
  const CODEX_ALLOW = '{"continue":true,"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
  const CODEX_DENY = '{"continue":true,"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from phone"}}}';

  /** Hold as codex, then answer with the given decrypted answer object; returns emitted stdout + calls. */
  const answerCodex = async (answer: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, ...answer });
    const emitted: string[] = [];
    const { fn, calls } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l), ...over }) as never, "codex");
    return { emitted, calls };
  };

  test("Approve for me → bypasses Nomo before any phone POST and leaves remote approvals enabled", async () => {
    const spy = spyFetch();
    const emitted: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    let loadedWith: string[] = [];
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({
        permission_mode: "default", turn_id: "turn-auto", transcript_path: "/codex/rollout.jsonl",
      }),
      loadCodexTurnPolicyFn: async (path: string, turnId: string, sessionId: string) => {
        loadedWith = [path, turnId, sessionId];
        return { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxType: "workspace-write" };
      },
      fetchFn: spy.fn,
      emit: (line: string) => emitted.push(line),
      trace: (event: Record<string, unknown>) => events.push(event),
    }) as never, "codex");
    expect(loadedWith).toEqual(["/codex/rollout.jsonl", "turn-auto", "sess-1"]);
    expect(spy.called()).toBe(false);
    expect(emitted).toEqual([]);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "codex-auto-review" });
  });

  test("Full Access → bypasses before rollout lookup or phone POST", async () => {
    const spy = spyFetch();
    const events: Array<Record<string, unknown>> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ permission_mode: "bypassPermissions" }),
      loadCodexTurnPolicyFn: async () => { throw new Error("must not inspect rollout in Full Access"); },
      fetchFn: spy.fn,
      emit: () => {},
      trace: (event: Record<string, unknown>) => events.push(event),
    }) as never, "codex");
    expect(spy.called()).toBe(false);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "mode", mode: "bypassPermissions" });
  });

  test("manual reviewer remains phone-holdable", async () => {
    const { emitted, calls } = await answerCodex({ decision: "allow" }, {
      readInput: async () => inputWith({ permission_mode: "default", turn_id: "turn-user" }),
      loadCodexTurnPolicyFn: async () => ({ approvalPolicy: "on-request", approvalsReviewer: "user" }),
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(emitted).toEqual([CODEX_ALLOW]);
  });

  test("missing or unreadable turn context fails open to native Codex, never the phone", async () => {
    const spy = spyFetch();
    const events: Array<Record<string, unknown>> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ permission_mode: "default", turn_id: "turn-missing" }),
      loadCodexTurnPolicyFn: async () => null,
      fetchFn: spy.fn,
      emit: () => {},
      trace: (event: Record<string, unknown>) => events.push(event),
    }) as never, "codex");
    expect(spy.called()).toBe(false);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "codex-context-unknown" });
  });

  test("auto reviewer with untrusted policy remains phone-holdable (Codex does not run guardian there)", async () => {
    const { emitted, calls } = await answerCodex({ decision: "allow" }, {
      readInput: async () => inputWith({ permission_mode: "default", turn_id: "turn-untrusted" }),
      loadCodexTurnPolicyFn: async () => ({ approvalPolicy: "untrusted", approvalsReviewer: "auto_review" }),
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(emitted).toEqual([CODEX_ALLOW]);
  });

  test("danger-full-access alone does not bypass a manual approval policy", async () => {
    const { emitted, calls } = await answerCodex({ decision: "allow" }, {
      readInput: async () => inputWith({ permission_mode: "default", turn_id: "turn-untrusted" }),
      loadCodexTurnPolicyFn: async () => ({
        approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxType: "danger-full-access",
        permissionProfileType: "disabled",
      }),
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(emitted).toEqual([CODEX_ALLOW]);
  });

  test("MCP tools do not use the thread-global reviewer because apps can override it", async () => {
    const spy = spyFetch();
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({
        permission_mode: "default", tool_name: "mcp__example__write", turn_id: "turn-mcp",
      }),
      loadCodexTurnPolicyFn: async () => { throw new Error("thread reviewer is not authoritative for MCP"); },
      fetchFn: spy.fn,
      emit: () => {},
    }) as never, "codex");
    expect(spy.called()).toBe(true);
  });

  test("rollout approval_policy=never bypasses even if a producer reports default", async () => {
    const spy = spyFetch();
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ permission_mode: "default", turn_id: "turn-full" }),
      loadCodexTurnPolicyFn: async () => ({
        approvalPolicy: "never", approvalsReviewer: "user", sandboxType: "workspace-write",
        permissionProfileType: "managed",
      }),
      fetchFn: spy.fn,
      emit: () => {},
    }) as never, "codex");
    expect(spy.called()).toBe(false);
  });

  test("Claude never consults the Codex reviewer gate", async () => {
    const spy = spyFetch();
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ permission_mode: "default" }),
      loadCodexTurnPolicyFn: async () => { throw new Error("Claude must not inspect a Codex rollout"); },
      fetchFn: spy.fn,
      emit: () => {},
    }) as never, "claude");
    expect(spy.called()).toBe(true);
  });

  test("allow → the continue:true-wrapped allow line", async () => {
    const { emitted } = await answerCodex({ decision: "allow" });
    expect(emitted).toEqual([CODEX_ALLOW]);
  });

  test("deny (no message) → continue:true-wrapped frozen deny line", async () => {
    const { emitted } = await answerCodex({ decision: "deny" });
    expect(emitted).toEqual([CODEX_DENY]);
  });

  test("deny WITH a custom message → continue:true wrapper + the phone's message", async () => {
    const { emitted } = await answerCodex({ decision: "deny", message: "use bun instead" });
    const parsed = JSON.parse(emitted[0]);
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "use bun instead" });
  });

  test("allow_always safely degrades to Codex's supported plain allow (no updatedPermissions)", async () => {
    const events: Array<Record<string, unknown>> = [];
    const { emitted } = await answerCodex(
      { decision: "allow_always" },
      { trace: (event: Record<string, unknown>) => events.push(event) },
    );
    expect(emitted).toEqual([CODEX_ALLOW]);
    expect(JSON.parse(emitted[0]).hookSpecificOutput.decision).not.toHaveProperty("updatedPermissions");
    expect(events).toContainEqual({ event: "emit", decision: "allow_always_degraded_to_allow" });
  });

  test("permission_mode=plan is not treated as Codex Plan mode (fail-open, no phone hold)", async () => {
    const spy = spyFetch();
    const emitted: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => inputWith({ permission_mode: "plan" }),
      fetchFn: spy.fn,
      emit: (line: string) => emitted.push(line),
      trace: (event: Record<string, unknown>) => events.push(event),
    }) as never, "codex");
    expect(spy.called()).toBe(false);
    expect(emitted).toEqual([]);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "mode", mode: "plan" });
  });

  test("the posted blob + fallbackBlob both carry agent:'codex'", async () => {
    const { calls } = await answerCodex({ decision: "allow" });
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    const blob = (await decryptBlob(KEY, body.blob)) as Record<string, unknown>;
    const fb = (await decryptBlob(KEY, body.fallbackBlob)) as Record<string, unknown>;
    expect(blob.status).toBe("decisionPending");
    expect(blob.agent).toBe("codex");
    expect(fb.status).toBe("needsAttention");
    expect(fb.agent).toBe("codex");
  });

  test("codex shell PermissionRequest → summary/detail come from tool_input.command", async () => {
    const codexInput = JSON.stringify({
      session_id: "sess-1", hook_event_name: "PermissionRequest",
      tool_name: "shell", tool_input: { command: "rm -rf build\necho done" },
      cwd: "/Users/x/proj",
    });
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: () => {}, readInput: async () => codexInput }) as never, "codex");
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    const blob = (await decryptBlob(KEY, body.blob)) as Record<string, unknown>;
    expect(blob.permissionToolName).toBe("shell");
    expect(blob.permissionSummary).toBe("rm -rf build");           // first line only
    expect(blob.permissionDetail).toBe("rm -rf build\necho done");  // full command
    expect(blob.agent).toBe("codex");
  });

  test("no-hold flag present → delegates (codex needs-attention), never POSTs a decision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-codex-nohold-"));
    const flag = join(dir, "no-hold");
    await writeFile(flag, "");
    let delegated = false;
    let fetched = false;
    const fn = (async () => { fetched = true; return new Response("{}"); }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, noHoldPath: flag, emit: () => {},
      delegate: async () => { delegated = true; },
    }) as never, "codex");
    expect(delegated).toBe(true);
    expect(fetched).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

// ---- escape-hatch command -----------------------------------------------------------------

describe("approvalsCommand (on/off/status)", () => {
  test("off creates the flag, on removes it, status reports each state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-appr-"));
    const flag = join(dir, "no-hold");
    const lines: string[] = [];
    const deps = { noHoldPath: flag, print: (l: string) => lines.push(l) };

    expect(await approvalsCommand("off", deps)).toBe(0);
    await expect(readFile(flag, "utf8")).resolves.toBe(""); // flag now exists

    lines.length = 0;
    expect(await approvalsCommand("status", deps)).toBe(0);
    expect(lines.join("\n").toLowerCase()).toContain("off");

    expect(await approvalsCommand("on", deps)).toBe(0);
    await expect(readFile(flag, "utf8")).rejects.toThrow(); // flag removed

    lines.length = 0;
    expect(await approvalsCommand("status", deps)).toBe(0);
    expect(lines.join("\n").toLowerCase()).toContain("on");
    await rm(dir, { recursive: true, force: true });
  });
});

// ---- LAN loopback answer poll (NOM-44 phase 2) ---------------------------------------------
//
// The hook is a SEPARATE process from the watchdog that owns the LAN answer store, so it reads that
// store over loopback HTTP. These tests drive a REAL listener on 127.0.0.1 (the wire, not a mock) while
// the worker leg stays scripted — because the whole point is that the two channels are independent and
// the worker's 3 s cadence is untouched by anything the LAN leg does.
describe("runPermissionHook — LAN loopback answer poll", () => {
  const live: LanListener[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    while (live.length > 0) {
      try { live.pop()?.stop(); } catch { /* already stopped */ }
    }
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  /** A real listener bound to loopback, plus the lan.json path the hook will discover it through. */
  async function listenerFor(store: LanAnswerStore): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "nomo-perm-lan-"));
    dirs.push(dir);
    const statePath = join(dir, "lan.json");
    const listener = createLanListener({
      host: "127.0.0.1", statePath, answers: store, trace: () => { /* never the user's session trace */ },
    });
    live.push(listener);
    await listener.ready;
    listener.sync(CONFIG);
    return statePath;
  }

  /** A worker sleep that really elapses (so the LAN leg can win the race) and records its arguments —
   *  the cadence proof: every wait the hold loop asks for must still be `interval + jitter`. */
  const pacedSleep = (ms: number, sleeps: number[]) => (requested: number): Promise<void> => {
    sleeps.push(requested);
    return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
  };

  test("a LAN-delivered answer emits the SAME line as a worker-delivered one, without a second worker poll", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });

    // 1. The worker delivers it (the pre-phase-2 path, unchanged).
    const viaWorker: string[] = [];
    const worker = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: worker.fn, emit: (l: string) => viaWorker.push(l) }) as never);

    // 2. The LAN listener delivers the IDENTICAL ciphertext while the worker only ever says "pending".
    const store = createLanAnswerStore();
    const statePath = await listenerFor(store);
    store.put("req-fixed", answerBlob, Date.now());
    const viaLan: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const sleeps: number[] = [];
    const lan = scriptFetch(true, [{ status: "pending" }]);
    let lanCalls = 0;
    await runPermissionHook(baseDeps({
      fetchFn: lan.fn,
      emit: (l: string) => viaLan.push(l),
      sleep: pacedSleep(60, sleeps),
      trace: (e: object) => events.push(e as Record<string, unknown>),
      now: () => Date.now(),          // the sealed loopback envelope carries a REAL ts (the listener
      lanStatePath: statePath,        // enforces the same 120 s freshness window the phone's leg does)
      lanFetchFn: ((url: string, init: RequestInit) => { lanCalls += 1; return fetch(url, init); }) as unknown as typeof fetch,
      lanSleep: (ms: number) => new Promise<void>((r) => { setTimeout(r, Math.min(ms, 2)); }),
      lanIntervalMs: 2,
    }) as never);

    expect(viaLan).toEqual(viaWorker);            // one shared answered-branch → one identical line
    expect(viaLan).toEqual([ALLOW]);
    expect(lan.calls.filter((c) => c.method === "GET").length).toBe(1); // the 3 s tick never came round
    expect(lanCalls).toBe(1);                     // …and the poller retires after ONE delivery
    expect(events.some((e) => e.event === "answered" && e.src === "lan")).toBe(true);
    expect(sleeps.every((ms) => ms === 3_000)).toBe(true); // the worker cadence itself is untouched
  });

  test("a LAN answer whose inner requestId does not match releases silently, exactly like the worker path", async () => {
    const store = createLanAnswerStore();
    const statePath = await listenerFor(store);
    // A stale/replayed answer: stored under the id we poll for, but sealed for a DIFFERENT request.
    store.put("req-fixed", await encryptBlob(KEY, { requestId: "req-other", decision: "allow" }), Date.now());
    const emitted: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const { fn } = scriptFetch(true, [{ status: "pending" }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn,
      emit: (l: string) => emitted.push(l),
      sleep: pacedSleep(60, []),
      trace: (e: object) => events.push(e as Record<string, unknown>),
      now: () => Date.now(),          // the sealed loopback envelope carries a REAL ts (the listener
      lanStatePath: statePath,        // enforces the same 120 s freshness window the phone's leg does)
      lanFetchFn: fetch,
      lanSleep: (ms: number) => new Promise<void>((r) => { setTimeout(r, Math.min(ms, 2)); }),
      lanIntervalMs: 2,
    }) as never);
    expect(emitted).toEqual([]);                  // nothing on stdout — fail open to the terminal dialog
    expect(events.some((e) => e.event === "answered" && e.match === false && e.src === "lan")).toBe(true);
  });

  test("an UNRECOGNIZED verb over LAN retires the LAN leg (no hot loop) and the worker still answers", async () => {
    const store = createLanAnswerStore();
    const statePath = await listenerFor(store);
    store.put("req-fixed", await encryptBlob(KEY, { requestId: "req-fixed", decision: "teleport" }), Date.now());
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow" });
    const emitted: string[] = [];
    let lanCalls = 0;
    const { fn, calls } = scriptFetch(true, [{ status: "pending" }, { status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn,
      emit: (l: string) => emitted.push(l),
      sleep: pacedSleep(20, []),
      now: () => Date.now(),
      lanStatePath: statePath,
      lanFetchFn: ((url: string, init: RequestInit) => { lanCalls += 1; return fetch(url, init); }) as unknown as typeof fetch,
      lanSleep: (ms: number) => new Promise<void>((r) => { setTimeout(r, Math.min(ms, 2)); }),
      lanIntervalMs: 2,
    }) as never);
    expect(emitted).toEqual([ALLOW]);             // the worker's own answer finished the hold
    expect(lanCalls).toBe(1);                     // the LAN leg delivered once and stopped — never a spin
    expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(2);
  });

  test("loopback failures are silent, bounded at 5 consecutive strikes, and never touch the worker path", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow" });
    const emitted: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const sleeps: number[] = [];
    let lanCalls = 0;
    // Three "pending" worker polls (~180 ms of wall clock at 60 ms a tick) give the 2 ms LAN ticker far
    // more than five chances — so a count of exactly 5 IS the give-up bound, not a race.
    const { fn, calls } = scriptFetch(true, [
      { status: "pending" }, { status: "pending" }, { status: "pending" }, { status: "answered", answerBlob },
    ]);
    await runPermissionHook(baseDeps({
      fetchFn: fn,
      emit: (l: string) => emitted.push(l),
      sleep: pacedSleep(60, sleeps),
      trace: (e: object) => events.push(e as Record<string, unknown>),
      lanStatePath: "/does/not/exist/lan.json", // discovery fails → but the fetch below is what we count
      lanFetchFn: (async () => { lanCalls += 1; throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      lanSleep: (ms: number) => new Promise<void>((r) => { setTimeout(r, Math.min(ms, 2)); }),
      lanIntervalMs: 2,
    }) as never);

    expect(emitted).toEqual([ALLOW]);                       // the worker leg carried the hold, untouched
    expect(calls.filter((c) => c.method === "GET").length).toBe(4);
    expect(sleeps).toEqual([3_000, 3_000, 3_000]);          // cadence: one full interval per pending poll
    expect(lanCalls).toBe(0);                               // no lan.json → not a single loopback request
    // Nothing about a dead LAN leg may reach the trace more than once per hold.
    expect(events.filter((e) => e.event === "lan-poll").length).toBeLessThanOrEqual(1);
  });

  test("with a live lan.json but a refused socket, the poller gives up after 5 strikes and traces once", async () => {
    const store = createLanAnswerStore();
    const statePath = await listenerFor(store);
    live.pop()?.stop();                                     // the port in lan.json is now dead
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow" });
    const emitted: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    let lanCalls = 0;
    const { fn } = scriptFetch(true, [
      { status: "pending" }, { status: "pending" }, { status: "pending" }, { status: "answered", answerBlob },
    ]);
    await runPermissionHook(baseDeps({
      fetchFn: fn,
      emit: (l: string) => emitted.push(l),
      sleep: pacedSleep(60, []),
      trace: (e: object) => events.push(e as Record<string, unknown>),
      now: () => Date.now(),          // the sealed loopback envelope carries a REAL ts (the listener
      lanStatePath: statePath,        // enforces the same 120 s freshness window the phone's leg does)
      lanFetchFn: (async (url: string, init: RequestInit) => { lanCalls += 1; return await fetch(url, init); }) as unknown as typeof fetch,
      lanSleep: (ms: number) => new Promise<void>((r) => { setTimeout(r, Math.min(ms, 2)); }),
      lanIntervalMs: 2,
    }) as never);

    expect(emitted).toEqual([ALLOW]);
    expect(lanCalls).toBe(5);                               // LOOPBACK_MAX_CONSECUTIVE_ERRORS, then silence
    expect(events.filter((e) => e.event === "lan-poll")).toEqual([{ event: "lan-poll", result: "give-up" }]);
  });
});

test("NO_HOLD_PATH sits under the cc-status config dir", () => {
  expect(NO_HOLD_PATH.endsWith("/.config/cc-status/no-hold")).toBe(true);
});

test("TRACE_PATH sits under the cc-status config dir", () => {
  expect(TRACE_PATH.endsWith("/.config/cc-status/permission-trace.log")).toBe(true);
});

// ---- NOM-44 phase 4: the unabridged permission detail teed onto the session record --------------
//
// The blob the worker carries is still fitted to 3072 chars; this tee is what lets a phone on the same
// network pull the WHOLE plan/command over LAN instead of living with the prefix.

describe("runPermissionHook — the unabridged-detail record tee", () => {
  const teed = async (over: Record<string, unknown>): Promise<Array<string | undefined>> => {
    const seen: Array<string | undefined> = [];
    const { fn } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {},
      stampDetailFullFn: async (_sessionId: string, detailFull: string | undefined) => { seen.push(detailFull); },
      ...over,
    }) as never);
    return seen;
  };

  const record = (over: Record<string, unknown> = {}) => ({ pid: 1, machine: "m", label: "l", ts: 1000, ...over });

  test("a TRUNCATED detail is stored whole, so the LAN read can serve the real command", async () => {
    const command = `${"x".repeat(20_000)}END`;
    expect(await teed({
      readRecordFn: async () => record(),
      readInput: async () => inputWith({ tool_input: { command } }),
    })).toEqual([command]);
  });

  test("a detail that rides WHOLE stores nothing — and clears a previous prompt's stale copy", async () => {
    const short = "ls -la";
    // Nothing stale on the record ⇒ nothing would change ⇒ the record is never touched at all.
    expect(await teed({
      readRecordFn: async () => record(),
      readInput: async () => inputWith({ tool_input: { command: short } }),
    })).toEqual([]);
    // A copy left by an earlier prompt in this session IS cleared (undefined drops the key).
    expect(await teed({
      readRecordFn: async () => record({ permissionDetailFull: "the previous prompt's plan" }),
      readInput: async () => inputWith({ tool_input: { command: short } }),
    })).toEqual([undefined]);
  });

  test("no session record (reaped / first hook not landed yet) → no write is even attempted", async () => {
    expect(await teed({
      readRecordFn: async () => null,
      readInput: async () => inputWith({ tool_input: { command: "y".repeat(20_000) } }),
    })).toEqual([]);
  });

  test("an ExitPlanMode plan too long for the frame is kept whole for the pull", async () => {
    const plan = `# Plan\n${"- a step that is quite wordy indeed\n".repeat(400)}`;
    expect(await teed({
      readRecordFn: async () => record(),
      readInput: async () => inputWith({ tool_name: "ExitPlanMode", tool_input: { plan } }),
    })).toEqual([plan]);
  });
});
