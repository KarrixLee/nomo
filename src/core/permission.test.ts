import { mkdir, mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildPermissionSummary, buildPermissionDetail, buildPermissionQuestions, fitPermissionDetail,
  sealedBlobChars, BLOB_FIT_CHARS, runPermissionHook, approvalsCommand, NO_HOLD_PATH, TRACE_PATH,
  codexRolloutSessionId, codexTurnPolicyFromRollout, loadCodexTurnPolicy,
  POST_FIRST_CONTACT_TIMEOUT_MS, OPENCODE_QUESTION_TOOL, localAnswerProbe,
} from "./permission";
import {
  createPollBudget, MAX_CONSECUTIVE_MISSES, POLL_FIRST_CONTACT_TIMEOUT_MS,
  POLL_TIMEOUT_CEILING_MS, POLL_TIMEOUT_MS,
} from "./decision-poll";
import { encryptBlob, decryptBlob } from "./crypto";
import { createLanAnswerStore, createLanListener } from "./lan-listener";
import type { LanAnswerStore, LanListener } from "./lan-listener";
import type { Config } from "./shared";
import { folderIdentity, PLUGIN_VERSION, RECORD_FULL_TEXT_MAX_CHARS, RECORD_FULL_TEXT_TRUNCATION_MARKER } from "./shared";
import { startCodexRemoteInput } from "./codex-remote-input";

// ---- summary builder (pure) ---------------------------------------------------------------

describe("buildPermissionSummary", () => {
  test("Bash → first line of the command", () => {
    expect(buildPermissionSummary("Bash", { command: "rm -rf build\necho done" })).toBe("rm -rf build");
  });
  test("Bash → description wins over the command when Claude sends one", () => {
    expect(buildPermissionSummary("Bash", {
      command: 'NOMOR="/Users/k/Library/Application Support/Claude/…"; exec "$NOMOR/scripts/run.sh"',
      description: "Run nomo-cc reset to clear stale sessions and stop watchdog",
    })).toBe("Run nomo-cc reset to clear stale sessions and stop watchdog");
  });
  test("Bash → blank description falls back to the command", () => {
    expect(buildPermissionSummary("Bash", { command: "rm -rf build", description: "" })).toBe("rm -rf build");
  });
  test("Codex shell/local_shell → command, they send no description", () => {
    for (const t of ["shell", "local_shell"]) {
      expect(buildPermissionSummary(t, { command: "ls -la\necho hi" })).toBe("ls -la");
    }
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
  test("Codex request_user_input → first question text", () => {
    expect(buildPermissionSummary("request_user_input", {
      questions: [{ id: "choice", header: "Pick", question: "Which deployment should I use?", options: [{ label: "Blue" }] }],
    })).toBe("Which deployment should I use?");
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

  test("descriptions stay label-aligned, cap at 600 code points, and are omitted when all empty", () => {
    const [described] = buildPermissionQuestions({
      questions: [{
        question: "Pick one",
        options: [
          { label: "A" },
          { label: "discard me", description: "wrong row" },
          { label: "", description: "must not shift" },
          { label: "B", description: "😀".repeat(700) },
        ],
      }],
    });
    expect(described.o).toEqual(["A", "discard me", "B"]);
    expect(described.d?.[0]).toBe("");
    expect(described.d?.[1]).toBe("wrong row");
    expect(described.d?.[2]).toBe(`${"😀".repeat(599)}…`);
    expect([...(described.d?.[2] ?? "")]).toHaveLength(600);

    // A description that used to be amputated at 160 now rides WHOLE — the phone opens the selected row
    // to full height, so anything the ceiling cut was simply unreadable.
    const realistic = "Rewrites the parser to a recursive-descent design. Slower to land than patching the "
      + "existing regex path, but it fixes the whole class of nesting bugs instead of the one reported, "
      + "and it gives the error messages a place to point at.";
    expect(realistic.length).toBeGreaterThan(160);
    expect(buildPermissionQuestions({
      questions: [{ question: "Pick one", options: [{ label: "Rewrite", description: realistic }] }],
    })[0].d?.[0]).toBe(realistic);

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

  test("a description too long for the budget is SHORTENED, not thrown away with every other one", () => {
    // The all-or-nothing shed meant one fat description sank the short ones beside it. With the ladder,
    // the budget between "everything fits" and "nothing fits" buys capped descriptions instead of none.
    const questions = buildPermissionQuestions({
      questions: [{
        question: "Choose",
        options: [
          { label: "Fast", description: "Smallest safe change" },
          { label: "Thorough", description: "H".repeat(600) },
        ],
      }],
    });
    const bare = questions.map(({ d: _descriptions, ...question }) => question);
    const frameChars = (qs: typeof questions) => sealedBlobChars(new TextEncoder().encode(JSON.stringify({
      ...base, permissionQuestions: qs,
    })).length);

    // One char under "the whole thing fits": the widest rung that fits rides, and BOTH descriptions
    // survive — the short one whole, the long one ellipsis-capped.
    const kept = fitPermissionDetail(base, "", frameChars(questions) - 1, questions).questions;
    expect(kept).not.toEqual(bare);
    expect(kept?.[0].d?.[0]).toBe("Smallest safe change");
    expect(kept?.[0].d?.[1].endsWith("…")).toBe(true);
    expect([...(kept?.[0].d?.[1] ?? "")].length).toBeLessThan(600);
    expect(frameChars(kept ?? [])).toBeLessThanOrEqual(frameChars(questions) - 1);
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
 *  drive the definitive-status release). `full` scripts the POST /v1/cc/full reply (200 by default;
 *  a number is a non-2xx, "throw" a transport failure) so a test can prove the upload is soft. */
function scriptFetch(
  hold: boolean | boolean[], gets: Array<Record<string, unknown> | "throw" | number>,
  full: number | "throw" = 200,
) {
  const calls: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }> = [];
  let g = 0;
  let p = 0;
  const holdFor = () => (Array.isArray(hold) ? hold[Math.min(p++, hold.length - 1)] : hold);
  const fn = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body, headers: init?.headers });
    if (url.endsWith("/v1/cc/full")) {
      if (full === "throw") throw new Error("network");
      return new Response(JSON.stringify({ ok: full === 200 }), { status: full });
    }
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

  // ---- the initial POST's TIMEOUT retry, scoped by what the hold BLOCKS (HOLD_BLOCKS_DIALOG) --------
  //
  // Field trace 2026-08-19, ses_fe0d…: ONE `TimeoutError` on round 1 attempt 1 (the fourth in that log's
  // entire history — a blip, not a break) cost an OpenCode session its whole remote-approval path, and
  // the user tapped an answer into a void. Claude/Codex must keep ending the round on a timeout — their
  // hook IS the terminal dialog's gate — but OpenCode's hold is started detached beside a prompt
  // OpenCode already rendered itself, so the retry is free there and the hold is what is at stake.

  /** A decision POST that TIMES OUT on its first `timeouts` attempts, then answers `{hold}`. */
  const flakyPost = (timeouts: number, hold: boolean, gets: Array<Record<string, unknown>> = []) => {
    const posts: Array<{ ts: number }> = [];
    let g = 0;
    const fn = (async (url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith("/v1/cc/full")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/v1/cc/decision")) {
        posts.push(JSON.parse(init!.body!) as { ts: number });
        if (posts.length <= timeouts) { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; }
        return new Response(JSON.stringify({ hold }), { status: 200 });
      }
      return new Response(JSON.stringify(gets[Math.min(g++, gets.length - 1)] ?? {}), { status: 200 });
    }) as unknown as typeof fetch;
    return { fn, posts };
  };
  const quietHoldDeps = { writeHoldFn: async () => {}, clearHoldFn: async () => {}, settleHoldRecordFn: async () => {} };

  test("NON-BLOCKING hold (opencode): a timeout on attempt 1 is RETRIED, and the retry gets the hold", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const { fn, posts } = flakyPost(1, true, [{ status: "answered", answerBlob }]);
    const emitted: string[] = [];
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), ...quietHoldDeps,
    }) as never, "opencode");
    expect(posts).toHaveLength(2);      // attempt 1 timed out; attempt 2 ran instead of giving up
    expect(emitted).toEqual([ALLOW]);   // …and the phone's answer reached OpenCode
  });

  test("NON-BLOCKING hold: the retry POST carries a STRICTLY NEWER ts even on a frozen clock", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const { fn, posts } = flakyPost(1, true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: () => {}, ...quietHoldDeps }) as never, "opencode");
    // now: () => 1000 throughout — a re-POST at the SAME ts trips the worker's ordering guard and is
    // dropped as stale, so the retry would silently never establish anything.
    expect(posts.map((p) => p.ts)).toEqual([1000, 1001]);
  });

  for (const agent of ["claude", "codex"] as const) {
    test(`BLOCKING hold (${agent}): a timeout ends the round at once — exactly 1 POST`, async () => {
      const { fn, posts } = flakyPost(1, true); // attempt 2 WOULD have succeeded, if it ran
      const events: Array<{ event: string; [k: string]: unknown }> = [];
      await runPermissionHook(baseDeps({
        fetchFn: fn, emit: () => {}, ...quietHoldDeps,
        trace: (e: { event: string }) => events.push(e as { event: string }),
      }) as never, agent);
      expect(posts).toHaveLength(1);    // the terminal dialog is frozen behind us — never double the freeze
      expect(events.at(-1)).toMatchObject({ event: "exit", reason: "post-error" });
    });
  }

  test("a non-ok HTTP status is NEVER retried, not even on the non-blocking path", async () => {
    const posts: string[] = [];
    const fn = (async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/v1/cc/full")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/v1/cc/decision")) { posts.push(init!.body!); return new Response("", { status: 503 }); }
      throw new Error("no GET expected");
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {}, ...quietHoldDeps,
      // ESTABLISHED session, so the hold:false fresh-session re-ask (a second ROUND, not a retry) is out
      // of the picture and the count below is unambiguous.
      now: () => 1_000_000, readRecordFn: async () => ({ pid: 1, machine: "m", label: "l", ts: 1_000_000 - 10 * 60_000 }),
    }) as never, "opencode");
    expect(posts).toHaveLength(1); // a real HTTP response is a real answer, whatever it says
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

  // THE LAN CHANNEL'S HALF OF THE WORKER'S DECISION-PENDING GUARD (field report, session bed2e681,
  // 2026-08-02). The worker STORES this POST's decisionPending blob and defends it — it drops the plain
  // prio:1 needsAttention CC's `Notification` (permission_prompt) hook fires seconds later. The LAN
  // frames feed rebuilds its frames from the SESSION RECORD, which carried neither, so it shipped that
  // needsAttention at a NEWER stamp and the phone's build-10 snapshot merge then held the worker's older
  // decisionPending brief back for good: a yellow "needs help" row with no Allow/Deny, unanswerable from
  // the app. The hook must therefore leave the same sealed card on disk for as long as it holds.
  test("a granted hold stamps the sealed card on disk, and every exit retires it", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const { fn, calls } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    const writes: { sessionId: string; hold: { blob: string; at: number; pid: number } }[] = [];
    const clears: { sessionId: string; pid: number }[] = [];
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {}, holdPid: 9_001,
      writeHoldFn: async (sessionId: string, hold: { blob: string; at: number; pid: number }) => { writes.push({ sessionId, hold }); },
      clearHoldFn: async (sessionId: string, pid: number) => { clears.push({ sessionId, pid }); },
    }) as never);
    expect(writes).toHaveLength(1);
    expect(writes[0].sessionId).toBe("sess-1");
    // The marker carries the SAME card that was POSTed — one frame, two channels — plus the `dbg`
    // breadcrumb that names the channel. Everything the phone RENDERS must be identical; the tail is
    // the only difference, and it is the whole point (see formatDecisionHoldDebug).
    const posted = (await decryptBlob(KEY, JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/cc/decision"))!.body!).blob)) as Record<string, unknown>;
    const held = (await decryptBlob(KEY, writes[0].hold.blob)) as Record<string, unknown>;
    expect({ ...held, dbg: undefined }).toEqual({ ...posted, dbg: undefined });
    expect("dbg" in posted).toBe(false);
    // PORTED IN v2 PHASE 3: the `hold@<at>` tail is gone (spec, "The diagnostics line under v2"). It
    // reported an ordering fact from the era when `ts` was an ordering contract; the state feed now names
    // the deciding input on the wire (`why:"hold"`). `ev:hold` still answers the only question the line
    // ever existed for — WHICH channel painted this card — so the assertion survives, one token shorter.
    expect(held.dbg).toBe(`${PLUGIN_VERSION} ev:hold req:req-fixe pid:9001`);
    expect(Object.keys(held).at(-1)).toBe("dbg");   // append-LAST, like every other blob tail
    expect(writes[0].hold.at).toBe(1000);
    expect(writes[0].hold.pid).toBe(9_001);   // the HOLDING process, so the feed can probe its liveness
    // Answered → retired, keyed by the same owner pid (compare-and-clear: a parallel tool's LATER hold
    // for this session must survive our exit).
    expect(clears).toEqual([{ sessionId: "sess-1", pid: 9_001 }]);
  });

  test("a hold that was never granted stamps NOTHING (nothing to defend, nothing to leave behind)", async () => {
    const { fn } = scriptFetch(false, []);
    const writes: unknown[] = [];
    const clears: unknown[] = [];
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {},
      writeHoldFn: async () => { writes.push(1); },
      clearHoldFn: async () => { clears.push(1); },
    }) as never);
    expect(writes).toEqual([]);
    expect(clears).toEqual([]);
  });

  // THE RECORD'S OWN EXIT FROM THE HOLD (field reports R2/R3, session a51208e8, 2026-08-02). The hook
  // never wrote the SessionRecord, so retiring the marker handed the row back to the state CC's
  // `Notification` hook left there: op:update / prio:1 / needsAttention at a FROZEN ts. The LAN feed's
  // monotonic stamp then ships that stale yellow at prevTs+1, where the phone ACCEPTS it — a brief flash
  // when a later hook advances the record (answered), and a PERMANENT wedge when none ever will
  // (superseded/expired/giveup/exception: nothing is emitted, no tool runs, no hook follows, and the
  // watchdog's idle reap deliberately skips needsAttention). The process that owns the hold must own the
  // record's exit from it.

  /** The hold-settle deps, wired the way production is: the injected clear runs `beforeUnlink` (the
   *  settle) and only THEN retires the marker, so `order` proves the record is written first. */
  function settleProbe(over: { cleared?: boolean } = {}) {
    const order: string[] = [];
    const patches: Array<Record<string, unknown>> = [];
    return {
      order,
      patches,
      deps: {
        settleHoldRecordFn: async (_sessionId: string, patch: Record<string, unknown>) => {
          order.push("settle");
          patches.push(patch);
        },
        clearHoldFn: async (_sessionId: string, _pid: number, beforeUnlink?: () => Promise<void>) => {
          if (over.cleared === false) return false;             // a newer hold owns it → never settle
          await beforeUnlink?.();
          order.push("clear");
          return true;
        },
        writeHoldFn: async () => {},
      },
    };
  }

  /** The record CC's `Notification` hook left behind: the frozen prio:1 yellow the hold overlays. */
  const HELD_RECORD = {
    pid: 1, machine: "m", label: "l", ts: 900, op: "update", prio: 1,
    lastEvent: "needsAttention", attentionKind: "userInput", sentDone: true, blob: "stale-attention-blob",
  };

  test("an ANSWERED hold settles the record to prio:0 working before the marker is retired", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    const probe = settleProbe();
    const emitted: string[] = [];
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), holdPid: 9_001,
      readRecordFn: async () => HELD_RECORD,
      ...probe.deps,
    }) as never);
    expect(emitted).toEqual([ALLOW]);
    expect(probe.patches).toHaveLength(1);
    // What the real writer commits: the patch folded onto the record it read (see settleDecisionHoldRecordAt).
    const settled = { ...HELD_RECORD, ...probe.patches[0] } as Record<string, unknown>;
    expect(settled).toMatchObject({ op: "update", prio: 0, lastEvent: "working", sentDone: false });
    expect(settled.attentionKind).toBeUndefined();              // the question/approval episode is over
    expect(settled.ts as number).toBeGreaterThan(HELD_RECORD.ts); // …and it is no longer frozen
    expect(await decryptBlob(KEY, settled.blob as string)).toMatchObject({ status: "working" });
    // ORDERING IS LOAD-BEARING: a reconcile pass must never see "marker gone + record stale".
    expect(probe.order).toEqual(["settle", "clear"]);
  });

  test("a SUPERSEDED hold re-stamps needsAttention with the fallback blob instead of freezing the record", async () => {
    const { fn } = scriptFetch(true, [{ status: "superseded" }]);
    const probe = settleProbe();
    const emitted: string[] = [];
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), holdPid: 9_001,
      readRecordFn: async () => HELD_RECORD,
      ...probe.deps,
    }) as never);
    // The user is still blocked — just at the Mac. Same yellow, honestly re-stamped; never "working".
    expect(emitted).toEqual([]);
    expect(probe.patches).toHaveLength(1);
    const settled = { ...HELD_RECORD, ...probe.patches[0] } as Record<string, unknown>;
    expect(settled).toMatchObject({ op: "update", prio: 1, lastEvent: "needsAttention" });
    expect(settled.ts as number).toBeGreaterThan(HELD_RECORD.ts);
    expect(await decryptBlob(KEY, settled.blob as string)).toMatchObject({ status: "needsAttention" });
    expect(probe.order).toEqual(["settle", "clear"]);
  });

  test("the record settle is skipped when the compare-and-clear declines (a newer hold owns the session)", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    const probe = settleProbe({ cleared: false });
    const emitted: string[] = [];
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), holdPid: 9_001,
      readRecordFn: async () => HELD_RECORD,
      ...probe.deps,
    }) as never);
    expect(emitted).toEqual([ALLOW]);                           // the answer still lands, always
    expect(probe.patches).toEqual([]);                          // …but tool B's live card is untouched
    expect(probe.order).toEqual([]);
  });

  test("a hold that was never granted settles NOTHING (the record was never ours to move)", async () => {
    const { fn } = scriptFetch(false, []);
    const probe = settleProbe();
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {},
      readRecordFn: async () => HELD_RECORD,
      ...probe.deps,
    }) as never);
    expect(probe.patches).toEqual([]);
    expect(probe.order).toEqual([]);
  });

  // ---- NOM-45 · THE HONEST TRANSIENT STATE ------------------------------------------------------
  // Field report 2026-08-03 (pids 49753/49836): a Codex TUI question held fine, then every poll timed
  // out through a stalled tunnel and the retry hook's POST timed out too. The user was never blocked at
  // the Mac (fail-open works), but the PHONE kept a yellow needsAttention hand for a hold that no longer
  // existed — indistinguishable from a genuine dead end. These pin the difference on the wire.

  /** `undefined` for a patch that never stamped the stall — a `null`/0 here would be a fabricated one. */
  const stallOf = async (patch: Record<string, unknown> | undefined) => {
    if (!patch) return undefined;
    const blob = patch.blob === undefined
      ? undefined
      : await decryptBlob(KEY, patch.blob as string) as Record<string, unknown>;
    return { at: patch.attentionStalledAt, reconnecting: blob?.reconnecting, status: blob?.status };
  };

  test("a hold that GAVE UP because the worker was unreachable settles RECONNECTING, not a dead yellow hand", async () => {
    const emitted: string[] = [];
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    const { fn, calls } = scriptFetch(true, ["throw"]);           // every poll fails at the transport
    const probe = settleProbe();
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), holdPid: 9_001, now: () => 5_000,
      readRecordFn: async () => HELD_RECORD,
      trace: (e: { event: string }) => events.push(e as { event: string }),
      ...probe.deps,
    }) as never);
    // FAIL-OPEN IS UNCHANGED — the ceiling still hands the user their terminal dialog.
    expect(emitted).toEqual([]);
    expect(calls.filter((c) => c.method === "GET").length).toBe(MAX_CONSECUTIVE_MISSES);
    expect(events.find((e) => e.event === "giveup")).toMatchObject({ stalled: true });
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "giveup" });
    // …AND THE GIVE-UP CLOCK IS UNCHANGED BY THE ADAPTIVE BUDGET. A poll that THROWS measures nothing, so
    // it never feeds the estimator: a network that produces no completed round trip cannot inflate its
    // own ceiling, and the fail-open stays ~100 × (2 s + 3 s) rather than stretching to ~100 × (8 s + 3 s).
    expect(events.filter((e) => e.event === "poll-begin").map((e) => e.budgetMs))
      .toEqual([POLL_FIRST_CONTACT_TIMEOUT_MS,
        ...Array<number>(MAX_CONSECUTIVE_MISSES - 1).fill(POLL_TIMEOUT_MS)]);
    // …and the row the phone keeps is now legible as auto-retrying rather than answerable.
    expect(probe.patches).toHaveLength(1);
    expect(await stallOf(probe.patches[0]))
      .toEqual({ at: 5_000, reconnecting: 5, status: "needsAttention" });
    // Still the same rung — the user really is blocked, just at the Mac. Never "working", never done.
    const settled = { ...HELD_RECORD, ...probe.patches[0] } as Record<string, unknown>;
    expect(settled).toMatchObject({ op: "update", prio: 1, lastEvent: "needsAttention" });
    // ORDERING, unchanged: the record is written before the marker is retired.
    expect(probe.order).toEqual(["settle", "clear"]);
  });

  test("ONLY the unreachable exits stamp it — answered / superseded / expired / definitive do NOT", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const cases: Array<[string, Array<Record<string, unknown> | "throw" | number>]> = [
      ["answered", [{ status: "answered", answerBlob }]],
      ["superseded", [{ status: "superseded" }]],
      ["expired", [{ status: "expired" }]],
      ["definitive", [403]],                                     // 2 strikes → release, worker SPOKE
    ];
    for (const [name, gets] of cases) {
      const { fn } = scriptFetch(true, gets);
      const probe = settleProbe();
      await runPermissionHook(baseDeps({
        fetchFn: fn, emit: () => {}, holdPid: 9_001, now: () => 5_000,
        readRecordFn: async () => HELD_RECORD,
        ...probe.deps,
      }) as never);
      expect(probe.patches).toHaveLength(1);
      const settled = { ...HELD_RECORD, ...probe.patches[0] } as Record<string, unknown>;
      // The patch must CLEAR any marker, not merely omit it: the watchdog rebuilds records by spreading
      // `...record`, so an omitted key would let a previous stall ride forward onto a recovered row.
      expect("attentionStalledAt" in (probe.patches[0] as object)).toBe(true);
      expect(settled.attentionStalledAt, name).toBeUndefined();
      const blob = await decryptBlob(KEY, settled.blob as string) as Record<string, unknown>;
      expect("reconnecting" in blob, name).toBe(false);
    }
  });

  test("post-error whose PROBE never reached the worker stamps the stall (the field case, pid 49836)", async () => {
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    const probe = settleProbe();
    const fn = (async () => { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {}, now: () => 5_000,
      readRecordFn: async () => HELD_RECORD,
      trace: (e: { event: string }) => events.push(e as { event: string }),
      ...probe.deps,
    }) as never);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "post-error", stalled: true });
    // No hold was ever granted, so the settle is written DIRECTLY (the clear never runs).
    expect(probe.patches).toHaveLength(1);
    expect(await stallOf(probe.patches[0]))
      .toEqual({ at: 5_000, reconnecting: 5, status: "needsAttention" });
    expect(probe.order).toEqual(["settle"]);
  });

  test("post-error where the WORKER SPOKE (404 probe) stamps nothing — that row is not lying", async () => {
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    const probe = settleProbe();
    const fn = (async (url: string) => {
      if (url.endsWith("/v1/cc/decision")) { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; }
      return new Response("", { status: 404 });                  // nothing was ever held
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {},
      readRecordFn: async () => HELD_RECORD,
      trace: (e: { event: string }) => events.push(e as { event: string }),
      ...probe.deps,
    }) as never);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "post-error" });
    expect(events.at(-1)!.stalled).toBeUndefined();
    expect(probe.patches).toEqual([]);
  });

  test("a fresh-session RE-ASK that dies at the transport stamps the stall (round 1 already painted the row)", async () => {
    const probe = settleProbe();
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    let posts = 0;
    const fn = (async (url: string) => {
      if (!url.endsWith("/v1/cc/decision")) throw new Error("no GET expected");
      posts += 1;
      if (posts === 1) return new Response(JSON.stringify({ hold: false }), { status: 200 });
      const e = new Error("timeout"); e.name = "TimeoutError"; throw e; // the network died under the re-ask
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {}, now: () => 5_000,
      readRecordFn: async () => null,                            // brand-new session → the re-ask runs
      trace: (e: { event: string }) => events.push(e as { event: string }),
      ...probe.deps,
    }) as never);
    expect(posts).toBe(2);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "hold-false", stalled: true });
    expect(await stallOf(probe.patches[0])).toMatchObject({ at: 5_000, reconnecting: 5 });
  });

  test("a plain hold:false (the worker SAID no) stamps nothing", async () => {
    const probe = settleProbe();
    const { fn } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {}, readRecordFn: async () => null, ...probe.deps,
    }) as never);
    expect(probe.patches).toEqual([]);
  });

  test("POST body is the frozen wire shape: decisionPending blob + needsAttention fallbackBlob", async () => {
    const { fn, calls } = scriptFetch(false, []);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: () => {} }) as never);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/cc/decision"))!;
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
    const body = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/cc/decision"))!.body!);
    const blob = (await decryptBlob(KEY, body.blob)) as Record<string, unknown>;
    const fb = (await decryptBlob(KEY, body.fallbackBlob)) as Record<string, unknown>;
    expect(blob.at).toBe(1_784_937_605);                              // FLOORED seconds, the vector's shape
    expect(fb.at).toBe(1_784_937_605);
    expect(body.ts).toBe(nowMs);                                      // the envelope stays in MILLIseconds
    // Appended in the base blob — i.e. BEFORE the permission tail, so the frozen append-only order of
    // the permission keys is untouched. `folderKey` (the phone's folder-grouping identity) closes the
    // base after `at`, the same slot every other producer of this shape puts it in.
    const keys = Object.keys(blob);
    expect(keys.slice(keys.indexOf("permissionSummary") - 2, keys.indexOf("permissionSummary")))
      .toEqual(["at", "folderKey"]);
    expect(Object.keys(fb).slice(-2)).toEqual(["at", "folderKey"]);
  });

  // The held frames get `branch` for free: runPermissionHook hands buildBlob the WHOLE record, so the
  // session's pinned folder paths come with it and the live HEAD is read from them. This asserts that
  // it lands in the one slot every other producer uses — after `folderKey`, before the permission tail.
  test("the held frames carry the folder's live `branch` right after folderKey, in BOTH sealed variants", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nomo-perm-branch-"));
    try {
      await mkdir(join(repo, ".git"), { recursive: true });
      await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/hybrid-lan\n");
      // A session pinned to that folder — exactly what the hook's first event wrote.
      const record = { pid: 1, machine: "Mac", ...folderIdentity(repo), ts: 0 };
      const { fn, calls } = scriptFetch(false, []);
      await runPermissionHook(baseDeps({ fetchFn: fn, emit: () => {}, readRecordFn: async () => record }) as never);
      const body = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/cc/decision"))!.body!);
      const blob = (await decryptBlob(KEY, body.blob)) as Record<string, unknown>;
      const fb = (await decryptBlob(KEY, body.fallbackBlob)) as Record<string, unknown>;
      expect(blob.branch).toBe("feat/hybrid-lan");
      expect(fb.branch).toBe("feat/hybrid-lan");
      const keys = Object.keys(blob);
      expect(keys.slice(keys.indexOf("permissionSummary") - 3, keys.indexOf("permissionSummary")))
        .toEqual(["at", "folderKey", "branch"]);
      expect(Object.keys(fb).slice(-3)).toEqual(["at", "folderKey", "branch"]);
      // The absolute path itself never crosses the wire — only the digest and the branch name.
      expect(JSON.stringify(blob)).not.toContain(repo);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
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

  // ---- NOM-45 · TUNNEL TOLERANCE ---------------------------------------------------------------
  // The user's Mac resolves api.nomo.gg through a proxy that hands back a fake IP: a HEALTHY request is
  // ~590 ms, but the FIRST connection of a short-lived hook pays that proxy's DNS + connect + TLS setup,
  // and at 2 s/4 s the whole first-contact leg timed out on a hold the phone was already showing.
  test("FIRST CONTACT gets a bigger budget than the steady-state poll — and steady state is untouched", () => {
    expect(POLL_TIMEOUT_MS).toBe(2_000);                          // the "every poll is bounded" contract
    expect(POLL_FIRST_CONTACT_TIMEOUT_MS).toBe(4_000);
    expect(POST_FIRST_CONTACT_TIMEOUT_MS).toBe(6_000);
    expect(POLL_FIRST_CONTACT_TIMEOUT_MS).toBeGreaterThan(POLL_TIMEOUT_MS);
    // WORST-CASE PRE-DIALOG BLOCK on a fully stalled network, and the bar it must stay under: one POST
    // (never retried after a timeout) + one did-it-land probe.
    expect(POST_FIRST_CONTACT_TIMEOUT_MS + POLL_FIRST_CONTACT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  test("the budget is spent on the first GETs only — seq 0/1 first-contact, seq 2+ steady state", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const events: Array<{ event: string; seq?: number; budgetMs?: number }> = [];
    const { fn } = scriptFetch(true, [{ status: "pending" }, { status: "pending" }, { status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {},
      trace: (e: { event: string; seq?: number; budgetMs?: number }) => events.push(e),
    }) as never);
    const budgets = events.filter((e) => e.event === "poll-begin").map((e) => [e.seq, e.budgetMs]);
    expect(budgets).toEqual([
      [1, POLL_FIRST_CONTACT_TIMEOUT_MS],                         // the freshly granted hold's first GET
      [2, POLL_TIMEOUT_MS],                                       // instant round trips → the snappy floor
      [3, POLL_TIMEOUT_MS],
    ]);
  });

  // The v1.6.6 premise — "in steady state the connection is already established, so 2 s is generous" —
  // is false through the user's tunnel. Field trace 2026-08-04: seq 1 SUCCEEDED in 3306 ms on the new 4 s
  // first-contact budget, then seq 2/3/4/5 all timed out on the 2 s steady-state one. The hold died
  // before the user could answer. The first contact that succeeded IS the measurement that should have
  // sized the ones after it.
  test("a SLOW measured round trip sizes every LATER poll — the field trace's 3306 ms is the probe", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const events: Array<{ event: string; seq?: number; budgetMs?: number; ms?: number }> = [];
    const emitted: string[] = [];
    let clock = 1_000;
    let gets = 0;
    const fn = (async (url: string) => {
      if (url.endsWith("/v1/cc/decision")) return new Response(JSON.stringify({ hold: true }), { status: 200 });
      gets += 1;
      clock += 3_306;                                             // the tunnel's real cost, per GET
      return new Response(JSON.stringify(
        gets >= 3 ? { status: "answered", answerBlob } : { status: "pending" }), { status: 200 });
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), now: () => clock,
      trace: (e: { event: string; seq?: number; budgetMs?: number; ms?: number }) => events.push(e),
    }) as never);

    expect(emitted).toEqual([ALLOW]);                             // the answer LANDS instead of timing out
    expect(events.filter((e) => e.event === "poll-begin").map((e) => [e.seq, e.budgetMs])).toEqual([
      [1, POLL_FIRST_CONTACT_TIMEOUT_MS],                         // nothing measured yet
      [2, POLL_TIMEOUT_CEILING_MS],                               // 3 × 3306 ms, clamped at the ceiling
      [3, POLL_TIMEOUT_CEILING_MS],
    ]);
    // …and the measurement itself is on the record, so a field trace shows what bought the budget.
    expect(events.filter((e) => e.event === "poll-end").map((e) => e.ms)).toEqual([3_306, 3_306, 3_306]);
  });

  test("a single slow poll does not pin the ceiling — a recovered network drops back to 2 s", async () => {
    // Drive the estimator through the same seam the hook does, with the hook's own seq numbering.
    const budget = createPollBudget();
    expect(budget.next(1)).toBe(POLL_FIRST_CONTACT_TIMEOUT_MS);
    for (let i = 0; i < 5; i += 1) budget.observe(90);            // a healthy warm round trip
    expect(budget.next(2)).toBe(POLL_TIMEOUT_MS);
    budget.observe(9_000);                                        // ONE hiccup
    expect(budget.next(2)).toBe(POLL_TIMEOUT_MS);
  });

  test("the did-it-land probe (seq 0) is first contact too — it IS this process's first GET", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const events: Array<{ event: string; seq?: number; budgetMs?: number }> = [];
    let gets = 0;
    const fn = (async (url: string) => {
      if (url.endsWith("/v1/cc/decision")) { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; }
      gets += 1;                                                  // seq 0 finds it pending, seq 1 answers
      return new Response(JSON.stringify(
        gets === 1 ? { status: "pending" } : { status: "answered", answerBlob }), { status: 200 });
    }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {},
      trace: (e: { event: string; seq?: number; budgetMs?: number }) => events.push(e),
    }) as never);
    expect(events.find((e) => e.event === "poll-begin" && e.seq === 0)?.budgetMs)
      .toBe(POLL_FIRST_CONTACT_TIMEOUT_MS);
  });

  test("a SHORT tunnel stall is survived, not released — the hold resumes polling and still answers", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    const probe = settleProbe();
    // Thirty consecutive TimeoutErrors — five times the field report's six — then the tunnel recovers.
    const gets: Array<Record<string, unknown> | "throw"> = [
      ...Array<"throw">(30).fill("throw"), { status: "answered", answerBlob },
    ];
    const { fn, calls } = scriptFetch(true, gets);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), holdPid: 9_001,
      readRecordFn: async () => HELD_RECORD,
      ...probe.deps,
    }) as never);
    expect(emitted).toEqual([ALLOW]);                             // the phone's answer still lands
    expect(calls.filter((c) => c.method === "GET").length).toBe(31);
    // …and nothing was ever painted as reconnecting: the hold never gave up.
    const settled = { ...HELD_RECORD, ...probe.patches[0] } as Record<string, unknown>;
    expect(settled).toMatchObject({ prio: 0, lastEvent: "working" });
    expect(settled.attentionStalledAt).toBeUndefined();
  });

  test("…but PAST the ceiling it still fails open — a bounded tolerance, never an indefinite block", async () => {
    const emitted: string[] = [];
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    const { fn, calls } = scriptFetch(true, ["throw"]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      trace: (e: { event: string }) => events.push(e as { event: string }),
    }) as never);
    expect(emitted).toEqual([]);                                  // fail-open: CC shows its own dialog
    expect(calls.filter((c) => c.method === "GET").length).toBe(MAX_CONSECUTIVE_MISSES);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "giveup" });
  });

  test("a transport throw is never a DEFINITIVE strike — timeouts must not release like a 403", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const emitted: string[] = [];
    // Two consecutive 403s WOULD release in 2; two consecutive throws must not.
    const { fn, calls } = scriptFetch(true, ["throw", "throw", { status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({ fetchFn: fn, emit: (l: string) => emitted.push(l) }) as never);
    expect(emitted).toEqual([ALLOW]);
    expect(calls.filter((c) => c.method === "GET").length).toBe(3);
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

// ---- the mode gate EXEMPTS genuine questions -------------------------------------------------
//
// FIELD BUG (traced live 2026-08-04): {"event":"start","tool_name":"AskUserQuestion",
// "permission_mode":"auto"} was immediately followed by {"event":"exit","reason":"mode","mode":"auto"},
// so a real QUESTION never held and degraded to a plain yellow needsAttention row on the phone. A
// permission MODE auto-approves permission PROMPTS; it can never auto-ANSWER a question. Verified in the
// shipped CC bundle (2.1.222): the permission evaluator returns {behavior:"ask", reason:
// "requiresUserInteraction"} for AskUserQuestion BEFORE the bypassPermissions/dontAsk early-allow and
// before any allow-rule — i.e. the hook fires and its decision is consumed identically in every mode.
//
// The gate stays exactly as it was for every other tool, and the SUBAGENT gate, the no-hold flag, and
// the Codex reviewer/dialog gates still win over the exemption.

describe("runPermissionHook — the mode gate exempts genuine questions", () => {
  /** A PermissionRequest for a question tool, with extra top-level fields merged in. */
  const questionAsk = (extra: Record<string, unknown> = {}, toolName = "AskUserQuestion") => JSON.stringify({
    session_id: "sess-1", hook_event_name: "PermissionRequest",
    tool_name: toolName, tool_input: { questions: CC_QUESTIONS },
    cwd: "/Users/x/proj", transcript_path: "/tmp/t.jsonl", ...extra,
  });

  // Every mode the gate used to swallow: the two auto-approving ones, the never-prompt one, and an
  // unknown future value (the fail-open branch must exempt questions too).
  for (const mode of ["auto", "dontAsk", "bypassPermissions", "someFutureMode"]) {
    test(`a QUESTION in permission_mode="${mode}" HOLDS (POSTs) and traces the bypass`, async () => {
      const spy = spyFetch();
      const events: Array<{ event: string; reason?: string; mode?: unknown; tool_name?: unknown }> = [];
      await runPermissionHook(baseDeps({
        readInput: async () => questionAsk({ permission_mode: mode }),
        fetchFn: spy.fn, emit: () => {},
        trace: (e: { event: string }) => events.push(e),
      }) as never);
      expect(spy.called()).toBe(true);
      expect(events).toContainEqual({
        event: "mode-gate-bypass", reason: "question", mode, tool_name: "AskUserQuestion",
      });
      expect(events.some((e) => e.event === "exit" && e.reason === "mode")).toBe(false);
    });

    test(`a NON-question in permission_mode="${mode}" still exits with reason "mode"`, async () => {
      const spy = spyFetch();
      const events: Array<{ event: string; reason?: string; mode?: unknown }> = [];
      await runPermissionHook(baseDeps({
        readInput: async () => inputWith({ permission_mode: mode }), // Bash
        fetchFn: spy.fn, emit: () => {},
        trace: (e: { event: string }) => events.push(e),
      }) as never);
      expect(spy.called()).toBe(false);
      expect(events.at(-1)).toMatchObject({ event: "exit", reason: "mode", mode });
      expect(events.some((e) => e.event === "mode-gate-bypass")).toBe(false);
    });
  }

  test("a question in an auto mode is ANSWERABLE — the same updatedInput line default mode emits", async () => {
    // The answer path is mode-independent: CC consumes `decision.updatedInput` in the one shared
    // runHooks() implementation, whichever permission mode the session is in.
    const answerBlob = await encryptBlob(KEY, {
      requestId: "req-fixed", ts: 5, decision: "answer", answers: ["Unit tests only"],
    });
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),
      readInput: async () => questionAsk({ permission_mode: "auto" }),
    }) as never);
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
  });

  // Claude's already-interactive modes: a question held there BEFORE this change and still does, by the
  // ordinary interactive-mode branch — so no bypass is traced (the exemption is not silently widening).
  for (const mode of ["default", "acceptEdits", "plan"]) {
    test(`permission_mode="${mode}" is UNCHANGED for a question — holds, no bypass trace`, async () => {
      const spy = spyFetch();
      const events: Array<{ event: string }> = [];
      await runPermissionHook(baseDeps({
        readInput: async () => questionAsk({ permission_mode: mode }),
        fetchFn: spy.fn, emit: () => {},
        trace: (e: { event: string }) => events.push(e),
      }) as never);
      expect(spy.called()).toBe(true);
      expect(events.some((e) => e.event === "mode-gate-bypass")).toBe(false);
    });
  }

  // ---- the gates that must still win over the exemption ----

  test("SUBAGENT + question + auto mode → still exits 'subagent', zero network", async () => {
    const spy = spyFetch();
    const events: Array<{ event: string; reason?: string }> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => questionAsk({ permission_mode: "auto", agent_id: "agent-abc", agent_type: "Explore" }),
      fetchFn: spy.fn, emit: () => {},
      trace: (e: { event: string }) => events.push(e),
    }) as never);
    expect(spy.called()).toBe(false);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "subagent" });
  });

  test("no-hold flag + question + auto mode → still delegates, never POSTs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-nohold-q-"));
    const flag = join(dir, "no-hold");
    await writeFile(flag, "");
    let delegated = false;
    let fetched = false;
    const fn = (async () => { fetched = true; return new Response("{}"); }) as unknown as typeof fetch;
    await runPermissionHook(baseDeps({
      fetchFn: fn, noHoldPath: flag, emit: () => {},
      readInput: async () => questionAsk({ permission_mode: "auto" }),
      delegate: async () => { delegated = true; },
    }) as never);
    expect(delegated).toBe(true);
    expect(fetched).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("CODEX dialog mode (acceptEdits) + question → still skipped, tagged codex_dialog_mode", async () => {
    // The `agent === "claude"` narrowing on acceptEdits/plan is deliberate; the exemption must not open a
    // hold for a Codex producer that reports a claude-style dialog mode.
    const spy = spyFetch();
    const events: Array<{ event: string; reason?: string; codex_dialog_mode?: unknown }> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => questionAsk({ permission_mode: "acceptEdits" }, "request_user_input"),
      loadCodexTurnPolicyFn: async () => { throw new Error("must not inspect a rollout for a skipped dialog mode"); },
      fetchFn: spy.fn, emit: () => {},
      trace: (e: { event: string }) => events.push(e),
    }) as never, "codex");
    expect(spy.called()).toBe(false);
    expect(events.at(-1)).toMatchObject({
      event: "exit", reason: "mode", mode: "acceptEdits", codex_dialog_mode: true,
    });
  });

  test("CODEX auto-review reviewer + question → still exits 'codex-auto-review' (gate 3 still runs)", async () => {
    const spy = spyFetch();
    const events: Array<{ event: string; reason?: string }> = [];
    await runPermissionHook(baseDeps({
      readInput: async () => questionAsk({ permission_mode: "bypassPermissions", turn_id: "t1" }, "request_user_input"),
      loadCodexTurnPolicyFn: async () => ({
        approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxType: "workspace-write",
      }),
      fetchFn: spy.fn, emit: () => {},
      trace: (e: { event: string }) => events.push(e),
    }) as never, "codex");
    expect(spy.called()).toBe(false);
    expect(events.at(-1)).toMatchObject({ event: "exit", reason: "codex-auto-review" });
  });

  test("CODEX manual reviewer + question in Full Access → holds (Full Access cannot answer a question)", async () => {
    const spy = spyFetch();
    await runPermissionHook(baseDeps({
      readInput: async () => questionAsk({ permission_mode: "bypassPermissions", turn_id: "t1" }, "request_user_input"),
      loadCodexTurnPolicyFn: async () => ({ approvalPolicy: "on-request", approvalsReviewer: "user" }),
      fetchFn: spy.fn, emit: () => {},
    }) as never, "codex");
    expect(spy.called()).toBe(true);
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
    // The DECISION POST specifically: a detail long enough to be cut ALSO fires the /v1/cc/full upload,
    // which is a POST to another route carrying a different (and much larger) sealed body.
    const body = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/cc/decision"))!.body!);
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
    const body = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/cc/decision"))!.body!);
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
    const body = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/cc/decision"))!.body!);
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
    const body = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/cc/decision"))!.body!);
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
    const posted = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/cc/decision"))!.body!);
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

  // WAS "the mode gate still fires FIRST" until 2026-08-04, which is the field bug: a question is the ONE
  // thing a permission mode can never auto-answer, so it must hold in auto mode too. Full coverage lives
  // in "the mode gate exempts genuine questions" above; this asserts the ANSWER still lands from here.
  test("AskUserQuestion in an AUTO mode → HOLDS and is answered like any other question", async () => {
    const { emitted } = await answerQuestion(
      { decision: "answer", answers: ["Integration tests"] },
      { readInput: async () => JSON.stringify({ ...JSON.parse(questionInput()), permission_mode: "auto" }) },
    );
    const updatedInput = JSON.parse(emitted[0]).hookSpecificOutput.decision.updatedInput;
    expect(updatedInput.answers).toEqual({
      "Which testing approach should I use for the new parser?": "Integration tests",
    });
  });

  // THE ANSWER TOOL IS (name, agent), never a name alone. `question` is an ordinary lowercase word: it
  // names OpenCode's question CHANNEL and, for any other agent, whatever tool an MCP server happens to
  // have called that. Ungated, the release rule swallowed such a tool's Allow — the user taps Allow on
  // the phone and the Mac just sits there. iOS reads the pair together
  // (CCPermissionQuestion.isOwnQuestionChannel); this is the plugin-side twin of that reading.
  const namedQuestion = JSON.stringify({
    session_id: "sess-1", hook_event_name: "PermissionRequest",
    tool_name: OPENCODE_QUESTION_TOOL, tool_input: { questions: CC_QUESTIONS },
    cwd: "/Users/x/proj", transcript_path: "/tmp/t.jsonl",
  });

  test("a CLAUDE tool literally named `question` is an ORDINARY tool — its allow is EMITTED, not released", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, decision: "allow" });
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), readInput: async () => namedQuestion,
    }) as never);
    expect(emitted).toEqual([ALLOW]);
  });

  test("…while under OPENCODE that same name IS the answer channel: a bare allow is RELEASED", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", ts: 5, decision: "allow" });
    const emitted: string[] = [];
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), readInput: async () => namedQuestion,
      writeHoldFn: async () => {}, clearHoldFn: async () => {}, settleHoldRecordFn: async () => {},
    }) as never, "opencode");
    expect(emitted).toEqual([]);
  });

  // Claude's own AskUserQuestion carries a name nothing else ships, so the gate above must NOT have
  // narrowed it by agent — codex keeps releasing a bare allow on it exactly as before.
  test("AskUserQuestion still releases a bare allow under codex", async () => {
    const { emitted } = await answerQuestion({ decision: "allow" }, {}, "codex");
    expect(emitted).toEqual([]);
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
    const body = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/cc/decision"))!.body!);
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
    const body = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/cc/decision"))!.body!);
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

  // NOM-47 / field report R3 (session a51208e8, 2026-08-02). The split-brain backstop makes a worker
  // `superseded` the NORMAL consequence of a LAN answer landing: the listener stores the phone's blob
  // synchronously, then the watchdog's answer sink echoes /v1/cc/decision/resolve, which retires the
  // worker's pending record as "superseded". So the very event that DELIVERS the answer also poisons
  // the status the worker poll is about to return — and the terminal branch used to `return` before the
  // loop ever reached `loopback.wait`, discarding an answer that was already in hand.
  //
  // Field timeline: answer op landed on LAN at 18:16:58.061, the loopback tick read it at 18:16:58.274,
  // and the worker poll (in flight since 18:16:57.930) returned `superseded` at 18:16:58.534 — the hook
  // exited silently and the user's Deny was thrown away ("answer submitted" never appeared).
  test("a terminal worker status does NOT discard a LAN answer that already landed (NOM-47 R3)", async () => {
    const store = createLanAnswerStore();
    const statePath = await listenerFor(store);
    // The phone's Deny is already in the LAN store — exactly as it is the instant the resolve echo fires.
    store.put("req-fixed", await encryptBlob(KEY, { requestId: "req-fixed", decision: "deny" }), Date.now());
    const emitted: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    // The worker's very next poll reports the record the echo just retired.
    const { fn } = scriptFetch(true, [{ status: "superseded" }]);
    await runPermissionHook(baseDeps({
      fetchFn: fn,
      emit: (l: string) => emitted.push(l),
      trace: (e: object) => events.push(e as Record<string, unknown>),
      now: () => Date.now(),
      lanStatePath: statePath,
      lanFetchFn: fetch,
      lanSleep: (ms: number) => new Promise<void>((r) => { setTimeout(r, Math.min(ms, 2)); }),
      lanIntervalMs: 2,
    }) as never);

    // The answer the user actually gave must win over the status their own answer caused.
    expect(emitted).toEqual([DENY]);
    expect(events.some((e) => e.event === "answered" && e.src === "lan")).toBe(true);
    expect(events.some((e) => e.event === "exit" && e.reason === "superseded")).toBe(false);
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

// ---- NOM-44 phase 5: the REMOTE half of the same pull -------------------------------------------
//
// The disk tee above only reaches a phone on this network. This POSTs the same sealed text to the blind
// worker so a phone anywhere can pull it. Same gate (fullTextForRecord), same fallbacks on failure.

describe("runPermissionHook — the remote full-text upload", () => {
  const record = () => ({ pid: 1, machine: "m", label: "l", ts: 1000 });
  const uploads = (calls: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }>) =>
    calls.filter((c) => c.url.endsWith("/v1/cc/full"));

  const run = async (over: Record<string, unknown>, full: number | "throw" = 200) => {
    const { fn, calls } = scriptFetch(false, [], full);
    const seen: Array<string | undefined> = [];
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: () => {}, readRecordFn: async () => record(),
      stampDetailFullFn: async (_s: string, d: string | undefined) => { seen.push(d); },
      ...over,
    }) as never);
    return { calls, seen };
  };

  test("a TRUNCATED detail is uploaded once, sealed, with sessionId + what + requestId + complete inside", async () => {
    const command = `${"x".repeat(20_000)}END`;
    const { calls } = await run({ readInput: async () => inputWith({ tool_input: { command } }) });
    const posts = uploads(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0].method).toBe("POST");
    const body = JSON.parse(posts[0].body!) as { v: number; sessionId: string; what: string; blob: string };
    expect(body.v).toBe(2);
    expect(body.sessionId).toBe("sess-1");
    expect(body.what).toBe("permission-detail");
    // The Mac auth headers the sibling POSTs carry — the worker authenticates the writer, then stays blind.
    expect(posts[0].headers?.["x-cc-pairing"]).toBe("p1");
    expect(posts[0].headers?.["x-cc-auth"]).toBe("s1");
    // The clear body is EXACTLY what the (blind) worker keys on and nothing more — the request id is not
    // in it, and must never be: the worker's slot stays `<pid>:full:<sid>:<what>` and it stays blind.
    expect(Object.keys(body).sort()).toEqual(["blob", "sessionId", "v", "what"]);
    // THE ANTI-SUBSTITUTION CHECK: sessionId, what AND the hold's requestId live INSIDE the seal too, so
    // a body that is not this pull's — another session's, another `what`'s, or the PREVIOUS hold's still
    // parked under this very key — hands the phone self-contradicting plaintext instead of a command it
    // would render above an Allow button bound to a different request.
    expect(await decryptBlob(KEY, body.blob)).toEqual({
      sessionId: "sess-1", what: "permission-detail", requestId: "req-fixed",
      content: command, complete: true,
    });
  });

  // THE FAILURE THIS CLOSES. Hold #1 parks its detail. Hold #2 arrives in the same session and its own
  // park 429s, times out (FULL_TEXT_POST_TIMEOUT_MS), or is simply still in flight — and nothing retries.
  // The worker's slot is per (session, what) and lives 24 h, so the phone's pull for hold #2 is answered
  // with hold #1's body: same sessionId, same what, both re-assertions pass, the sheet swaps it in and a
  // `complete:true` retires the truncation note. The id is the ONE field that differs, so it is what the
  // phone rejects on.
  test("a SUCCESSOR hold seals a DIFFERENT request id under the same session + what", async () => {
    const sealedFor = async (requestId: string) => {
      const { calls } = await run({
        randomUUID: () => requestId,
        readInput: async () => inputWith({ tool_input: { command: `${"x".repeat(20_000)}${requestId}` } }),
      });
      return await decryptBlob(KEY, (JSON.parse(uploads(calls)[0].body!) as { blob: string }).blob) as
        { sessionId: string; what: string; requestId: string; content: string };
    };
    const first = await sealedFor("hold-1");
    const second = await sealedFor("hold-2");

    expect([first.sessionId, first.what]).toEqual([second.sessionId, second.what]); // indistinguishable…
    expect(first.content).not.toBe(second.content);                                 // …yet different text
    expect([first.requestId, second.requestId]).toEqual(["hold-1", "hold-2"]);      // …told apart by this
  });

  test("text past RECORD_FULL_TEXT_MAX_CHARS seals complete:false rather than lying", async () => {
    const command = "z".repeat(300_000);
    const { calls } = await run({ readInput: async () => inputWith({ tool_input: { command } }) });
    const sealed = await decryptBlob(KEY, (JSON.parse(uploads(calls)[0].body!) as { blob: string }).blob) as
      { content: string; complete: boolean };
    expect(sealed.complete).toBe(false);
    expect(sealed.content.endsWith(RECORD_FULL_TEXT_TRUNCATION_MARKER)).toBe(true);
    expect(Array.from(sealed.content)).toHaveLength(RECORD_FULL_TEXT_MAX_CHARS);
  });

  test("a detail that rides WHOLE uploads NOTHING — no KV write for the common prompt", async () => {
    const { calls } = await run({ readInput: async () => inputWith({ tool_input: { command: "ls -la" } }) });
    expect(uploads(calls)).toHaveLength(0);
  });

  test("the upload is STARTED before the decision POST (the card can never precede its content)", async () => {
    const { calls } = await run({
      readInput: async () => inputWith({ tool_name: "ExitPlanMode", tool_input: { plan: "p".repeat(20_000) } }),
    });
    expect(calls[0].url.endsWith("/v1/cc/full")).toBe(true);
    expect(calls[1].url.endsWith("/v1/cc/decision")).toBe(true);
  });

  test("a FAILING upload breaks neither the decision POST nor the record tee", async () => {
    const command = `${"x".repeat(20_000)}END`;
    for (const full of [500, "throw"] as const) {
      const { calls, seen } = await run({ readInput: async () => inputWith({ tool_input: { command } }) }, full);
      expect(uploads(calls)).toHaveLength(1);                                   // tried once, never retried
      expect(calls.filter((c) => c.url.endsWith("/v1/cc/decision")).length).toBe(2); // initial + re-ask, untouched
      expect(seen).toEqual([command]);                                          // the LAN tee still landed
    }
  });
});

// ---- the local-answer watch (field trace 2026-08-25) ---------------------------------------------
//
// CC renders the AskUserQuestion / ExitPlanMode picker ITSELF while this hook polls, so the user can
// answer at the Mac; CC then continues the turn WITHOUT signalling the hook. Before this watch, the
// orphan held the phone's Allow/Deny card alive until the worker's expiry — 3 m 40 s in the trace.

/** A transcript tail with a user-blocking tool_use pending (no tool_result yet). */
const TAIL_PENDING = [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "AskUserQuestion" }] } }),
].join("\n");

/** …and the same tail once the user answered it at the Mac. */
const TAIL_ANSWERED = [
  TAIL_PENDING,
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] } }),
].join("\n");

describe("localAnswerProbe", () => {
  const probeOver = (tails: string[], tool = "AskUserQuestion", path = "/tmp/t.jsonl") => {
    let i = 0;
    return localAnswerProbe("claude", tool, path, async () => tails[Math.min(i++, tails.length - 1)]);
  };

  test("pending → answered flips true (the whole point)", async () => {
    const probe = probeOver([TAIL_PENDING, TAIL_ANSWERED]);
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(true);
  });

  test("LATCH: a first read that is already not-pending never releases", async () => {
    // A transcript handed to us late/truncated must not read as an answer — that would steal a live
    // card out from under the phone mid-question.
    const probe = probeOver([TAIL_ANSWERED, TAIL_ANSWERED]);
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(false);
  });

  test("an unreadable transcript is not evidence of an answer", async () => {
    const probe = localAnswerProbe("claude", "AskUserQuestion", "/tmp/t.jsonl", async () => {
      throw new Error("ENOENT");
    });
    expect(await probe()).toBe(false);
  });

  test("still false after a throw that follows a pending read (never a one-way latch into true)", async () => {
    let n = 0;
    const probe = localAnswerProbe("claude", "AskUserQuestion", "/tmp/t.jsonl", async () => {
      if (n++ === 0) return TAIL_PENDING;
      throw new Error("ENOENT");
    });
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(false);
  });

  test("ExitPlanMode is watched too; an ordinary permission prompt is NOT", async () => {
    // claudeTailPendingApproval only reports on the two user-blocking tools, so a Bash hold consulting
    // it would read "not pending" on poll 1 and release instantly. The name gate is what prevents that.
    expect(await probeOver([TAIL_PENDING, TAIL_ANSWERED], "ExitPlanMode")()).toBe(false);
    const bash = probeOver([TAIL_PENDING, TAIL_ANSWERED], "Bash");
    expect(await bash()).toBe(false);
    expect(await bash()).toBe(false);
  });

  test("disabled with no transcript path, and for codex (no such racing picker)", async () => {
    expect(await probeOver([TAIL_PENDING, TAIL_ANSWERED], "AskUserQuestion", "")()).toBe(false);
    const codex = localAnswerProbe("codex", "AskUserQuestion", "/tmp/t.jsonl", async () => TAIL_ANSWERED);
    expect(await codex()).toBe(false);
  });
});

describe("runPermissionHook — answered at the Mac", () => {
  const questionInput = JSON.stringify({
    session_id: "sess-1", hook_event_name: "PermissionRequest",
    tool_name: "AskUserQuestion", tool_input: { questions: CC_QUESTIONS },
    cwd: "/Users/x/proj", transcript_path: "/tmp/t.jsonl",
  });

  test("a local answer ends the hold: no stdout, polling stops, record settles as WORKING", async () => {
    // The worker stays `pending` forever — exactly the field case, where only its expiry ever freed the
    // card. The transcript flips on the second round, and that alone must end the hold.
    const { fn, calls } = scriptFetch(true, [{ status: "pending" }]);
    const emitted: string[] = [];
    const traced: Array<Record<string, unknown>> = [];
    const patches: Array<Record<string, unknown>> = [];
    let reads = 0;
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), readInput: async () => questionInput,
      trace: (e: Record<string, unknown>) => traced.push(e),
      settleHoldRecordFn: async (_id: string, patch: Record<string, unknown>) => { patches.push(patch); },
      readTailFn: async () => (reads++ === 0 ? TAIL_PENDING : TAIL_ANSWERED),
    }) as never);

    expect(emitted).toEqual([]);                                   // CC already took the local answer
    expect(traced.some((e) => e.event === "local-answer")).toBe(true);
    expect(traced.find((e) => e.event === "exit")?.reason).toBe("local-answer");
    expect(calls.filter((c) => c.method === "GET").length).toBe(1); // one poll, then out — not ~90
    // WORKING is what clears the worker's decision overlay and retires the phone's Allow/Deny card.
    expect(patches).toHaveLength(1);
    expect(patches[0]!.lastEvent).toBe("working");
    expect(patches[0]!.prio).toBe(0);
    expect(patches[0]!.attentionKind).toBeUndefined();
  });

  test("an UNANSWERED question is untouched — the phone still gets its answer", async () => {
    // A bare allow is a deliberate RELEASE for a question (CC drops it), so the phone's real verb here
    // is `answer` — the one that injects the selection through updatedInput.
    const answerBlob = await encryptBlob(KEY, {
      requestId: "req-fixed", decision: "answer", answers: ["Unit tests only"], ts: 5,
    });
    const { fn } = scriptFetch(true, [{ status: "pending" }, { status: "answered", answerBlob }]);
    const emitted: string[] = [];
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l), readInput: async () => questionInput,
      readTailFn: async () => TAIL_PENDING,                        // still parked on the user
    }) as never);
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0]!).hookSpecificOutput.decision.updatedInput.answers).toEqual({
      "Which testing approach should I use for the new parser?": "Unit tests only",
    });
  });

  test("a Bash hold is unaffected by the transcript (name gate)", async () => {
    const answerBlob = await encryptBlob(KEY, { requestId: "req-fixed", decision: "allow", ts: 5 });
    const { fn } = scriptFetch(true, [{ status: "answered", answerBlob }]);
    const emitted: string[] = [];
    await runPermissionHook(baseDeps({
      fetchFn: fn, emit: (l: string) => emitted.push(l),           // default INPUT = Bash
      readTailFn: async () => { throw new Error("must not be consulted"); },
    }) as never);
    expect(emitted).toEqual([ALLOW]);
  });
});
