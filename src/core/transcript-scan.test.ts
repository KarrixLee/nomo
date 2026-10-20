import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptSecretWarning } from "./handoff-later";
import { entropy, handoffTranscriptFiles, scanFiles, scanHandoff, secretSummary, type SecretKind } from "./transcript-scan";

// Every fixture key is assembled at runtime from parts and a seeded generator: no key-shaped literal in
// this file (GitHub secret scanning), and none of them is real.
const U = "0a1b2c3d-1111-4222-8333-444455556666";
let seed = 7;
const rnd = (n: number, abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"): string => {
  let s = "";
  for (let i = 0; i < n; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; s += abc[(seed >>> 16) % abc.length]; }
  return s;
};
const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const KEYS: Record<SecretKind, string> = {
  openai: ["sk", "proj", rnd(48)].join("-"),
  openrouter: ["sk", "or", "v1", rnd(64, "0123456789abcdef")].join("-"),
  anthropic: ["sk", "ant", "api03", rnd(90)].join("-"),
  github: ["gh", "p_", rnd(36)].join(""),
  aws: ["AK", "IA", rnd(16, UPPER)].join(""),
  slack: ["xo", "xb-", rnd(12, "0123456789"), "-", rnd(24)].join(""),
  google: ["AI", "za", rnd(35)].join(""),
  stripe: ["sk", "_live_", rnd(28)].join(""),
  privateKey: ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" "),
  jwt: [b64u({ alg: "HS256", typ: "JWT" }), b64u({ sub: rnd(8), iat: 1 }), rnd(43)].join("."),
  assignment: rnd(40),
};
const LINE: Record<SecretKind, string> = {
  openai: `OPENAI_API_KEY=${KEYS.openai}`,
  openrouter: `or key ${KEYS.openrouter}`,
  anthropic: `export ANTHROPIC_API_KEY="${KEYS.anthropic}"`,
  github: `token: ${KEYS.github}`,
  aws: `AWS_ACCESS_KEY_ID=${KEYS.aws}`,
  slack: `SLACK=${KEYS.slack}`,
  google: `key=${KEYS.google}&q=1`,
  stripe: `stripe ${KEYS.stripe}`,
  privateKey: `${KEYS.privateKey}\n${rnd(64)}`,
  jwt: `Authorization: Bearer ${KEYS.jwt}`,
  assignment: `DB_PASSWORD='${KEYS.assignment}'`,
};
/** A transcript line as Claude Code writes it: the text JSON-escaped inside a tool result. */
const row = (text: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: `     1\t${text}\n` }] } });

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "nomo-scan-")); dirs.push(d); return d; };
const scanText = (text: string) => { const d = tmp(), f = join(d, `${U}.jsonl`); writeFileSync(f, text); return scanFiles([f], d); };

describe("transcript-scan (NOM-103)", () => {
  for (const kind of Object.keys(KEYS) as SecretKind[]) {
    test(`detects ${kind}`, () => {
      const s = scanText([row("hello"), row(LINE[kind]), row("bye")].join("\n") + "\n");
      expect(s.counts).toEqual({ [kind]: 1 });
      expect(s.places).toEqual([{ file: `${U}.jsonl`, line: 2 }]);
    });
  }

  test("a key right after a JSON escape (a .env line in a tool result) is found", () => {
    expect(scanText(row(`A=1\n${KEYS.aws}\n${KEYS.github}`)).counts).toEqual({ aws: 1, github: 1 });
  });

  test("the same key repeated counts once; every line is listed", () => {
    const s = scanText([row(LINE.aws), "{}", row(`again ${KEYS.aws}`)].join("\n"));
    expect(s.counts).toEqual({ aws: 1 });
    expect(s.places.map((p) => p.line)).toEqual([1, 3]);
  });

  test("placeholders, references, low entropy, Nomo blobs and non-JWT eyJ are not findings", () => {
    const blob = Buffer.from(rnd(300)).toString("base64"); // a sealed-blob-shaped base64 run
    const embedded = `${rnd(20)}+${KEYS.aws}/${rnd(20)}=`;  // a key-shaped run INSIDE base64
    const clean = [
      "OPENAI_API_KEY=sk-your-key-here", `OPENAI_API_KEY=${["sk", "x".repeat(40)].join("-")}`, "API_KEY=<your api key>",
      "GITHUB_TOKEN=${GITHUB_TOKEN}", "TOKEN=process.env.GITHUB_TOKEN_VALUE", "SECRET=aaaaaaaaaaaaaaaa1111",
      "PASSWORD=hunter2", `MAX_TOKENS=${rnd(30)}`, `API_KEY=${["AK", "IA", "EXAMPLE", "X".repeat(9)].join("")}`,
      `{"enc":"${blob}","pairingId":"${rnd(16)}"}`, `{"blob":"${embedded}"}`,
      [b64u({ foo: 1 }), b64u({ sub: "x" }), rnd(43)].join("."), "the task-list and risk-free desk-lamp",
    ];
    const s = scanText(clean.map(row).join("\n"));
    expect(s).toEqual({ counts: {}, places: [] });
  });

  test("no value, nor any 8-char slice of one, ever appears in what it returns or prints", () => {
    const s = scanText((Object.values(LINE)).map(row).join("\n"));
    expect(Object.keys(s.counts).length).toBe(11);
    const out = JSON.stringify(s) + secretSummary(s, U)! + transcriptSecretWarning(secretSummary(s, U)!, false) + transcriptSecretWarning(secretSummary(s, U)!, true);
    for (const v of Object.values(KEYS)) {
      const body = v.replace(/^-----BEGIN [A-Z ]+-----$/, ""); // the PEM header is a label, not the secret
      for (let i = 0; i + 8 <= body.length; i += 4) expect(out).not.toContain(body.slice(i, i + 8));
    }
  });

  test("summary and warnings", () => {
    const s = scanText([row(LINE.openai), row(LINE.aws)].join("\n"));
    const sum = secretSummary(s, U)!;
    expect(sum).toBe("2 secrets (OpenAI key ×1, AWS key ×1; transcript line 1, transcript line 2)");
    expect(transcriptSecretWarning(sum, false)).toMatch(/^Cloud check: The conversation contains what look like 2 secrets .*would travel to the cloud box with the transcript\.\nNothing was started\. .*\/nomo-cc:handoff anyway/);
    expect(transcriptSecretWarning(sum, true)).toMatch(/Moving anyway, as you confirmed\.$/);
    expect(secretSummary(scanText(row("nothing")), U)).toBeUndefined();
  });

  test("scans exactly what handoff packs: transcript, its subagent dir, memory; nothing else", () => {
    const p = tmp();
    mkdirSync(join(p, U, "subagents"), { recursive: true });
    mkdirSync(join(p, "memory"));
    writeFileSync(join(p, `${U}.jsonl`), row("clean") + "\n");
    writeFileSync(join(p, U, "subagents", "agent-a.jsonl"), row("x") + "\n" + row(LINE.github) + "\n");
    writeFileSync(join(p, "memory", "MEMORY.md"), `notes\n${LINE.stripe}\n`);
    writeFileSync(join(p, "other-session.jsonl"), row(LINE.openai)); // another session: not uploaded
    expect(handoffTranscriptFiles(p, U).map((f) => f.slice(p.length + 1)).sort()).toEqual([`${U}.jsonl`, `${U}/subagents/agent-a.jsonl`, "memory/MEMORY.md"]);
    const s = scanHandoff(p, U);
    expect(s.counts).toEqual({ github: 1, stripe: 1 });
    expect(s.places).toEqual([{ file: `${U}/subagents/agent-a.jsonl`, line: 2 }, { file: "memory/MEMORY.md", line: 2 }]);
  });

  test("a vendor key that happens to contain a placeholder word is still found", () => {
    const k1 = ["gh", "p_", rnd(10), "here", rnd(22)].join(""), k2 = ["sk", "proj", rnd(20) + "xxx" + rnd(25)].join("-");
    expect(scanText([row(k1), row(k2)].join("\n")).counts).toEqual({ github: 1, openai: 1 });
  });

  test("no quadratic blow-up: 1 MB runs of one character scan in well under a second", () => {
    for (const c of ["A", "A_", "KEY", "sk-", "eyJ", "\\n"]) {
      const t = performance.now();
      scanText(c.repeat(Math.ceil((1 << 20) / c.length)));
      expect(performance.now() - t).toBeLessThan(1000);
    }
  });

  test("entropy", () => {
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("abcd")).toBe(2);
  });

  test("a 50 MB transcript scans fast, with line numbers right across chunk boundaries", () => {
    const filler = row(`some ordinary tool output ${"lorem ipsum dolor sit amet ".repeat(30)}`);
    const n = Math.ceil((50 << 20) / (filler.length + 1));
    const lines = Array.from({ length: n }, () => filler);
    lines[n - 1] = row(LINE.aws);
    lines[Math.floor(n / 2)] = row(LINE.openai);
    const d = tmp(), f = join(d, `${U}.jsonl`);
    writeFileSync(f, lines.join("\n") + "\n");
    const t = performance.now();
    const s = scanFiles([f], d);
    const ms = performance.now() - t;
    expect(s.counts).toEqual({ aws: 1, openai: 1 });
    expect(s.places.map((p) => p.line)).toEqual([Math.floor(n / 2) + 1, n]);
    expect(ms).toBeLessThan(5000);
    console.log(`scanned ${n} lines (50 MB) in ${Math.round(ms)} ms`);
  });
});
