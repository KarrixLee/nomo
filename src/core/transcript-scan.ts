// transcript-scan — NOM-103: a deterministic, pattern-based look for key-shaped strings in what a handoff
// uploads from ~/.claude/projects/<dir>/ (handoff.ts build(): `<uuid>.jsonl`, the `<uuid>/` subagent dir,
// `memory/`). If a session read a `.env` or printed a key, the value is in the transcript, and we never edit
// transcripts, so the only choice is to warn (terminal) or refuse (phone).
//
// It reports KINDS, COUNTS and LINE NUMBERS only. A matched value never leaves scanLines (only a sha256 of
// it, in memory, to count distinct ones), so nothing it returns, logs or prints can leak it.

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type SecretKind = "openai" | "anthropic" | "github" | "aws" | "slack" | "google" | "stripe" | "privateKey" | "jwt" | "assignment";

export const KIND_LABEL: Record<SecretKind, string> = {
  openai: "OpenAI key", anthropic: "Anthropic key", github: "GitHub token", aws: "AWS key", slack: "Slack token",
  google: "Google API key", stripe: "Stripe key", privateKey: "private key", jwt: "JWT", assignment: "KEY=/TOKEN= value",
};

export interface SecretScan {
  /** Distinct values per kind (the same key printed five times counts once). */
  counts: Partial<Record<SecretKind, number>>;
  /** Where they were: file relative to the scanned dir, 1-based line. At most MAX_PLACES. */
  places: { file: string; line: number }[];
}

const MAX_PLACES = 20;
// Not after/before a base64 or base64url char: a match inside a long encoded run (a Nomo sealed blob, an
// image, a hash) is not a key. Std base64 also has no `-`/`_`, so `sk-…`/`ghp_…` can't hide in one. A
// JSON escape right before (`\n`, `\t`: a .env line inside a tool result) still counts as a boundary.
const B = "(?:(?<=\\\\[nrt])|(?<![A-Za-z0-9+/_-]))";
const E = "(?![A-Za-z0-9+/_-])";
const VENDOR: [SecretKind, RegExp][] = [
  ["stripe", new RegExp(`${B}[rs]k_live_[A-Za-z0-9]{20,}${E}`, "g")],
  ["anthropic", new RegExp(`${B}sk-ant-[A-Za-z0-9_-]{32,}${E}`, "g")],
  ["openai", new RegExp(`${B}sk-(?!ant-)[A-Za-z0-9_-]{32,}${E}`, "g")],
  ["github", new RegExp(`${B}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})${E}`, "g")],
  ["aws", new RegExp(`${B}(?:AKIA|ASIA)[0-9A-Z]{16}${E}`, "g")],
  ["slack", new RegExp(`${B}xox[bpas]-[A-Za-z0-9-]{10,}${E}`, "g")],
  ["google", new RegExp(`${B}AIza[0-9A-Za-z_-]{35}${E}`, "g")],
  ["jwt", new RegExp(`${B}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{16,}${E}`, "g")],
];
const PEM = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
// An env-style NAME (upper case, ends in KEY/SECRET/TOKEN/PASSWORD) `=` a value, optionally quoted (and
// JSON-escaped: \"…\"). The value stops at whitespace, quotes, `\` (an escaped newline), `$`, `<`…
const ASSIGN = /[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)\s*=\s*(?:\\?["'])?([A-Za-z0-9+/=_.~-]+)/g;
const MIN_ASSIGN_LEN = 16;
const MIN_ENTROPY = 3.5; // bits/char: random alnum of 16+ chars sits ~3.7-4, words and repeats well below
const PLACEHOLDER = /x{3,}|your[-_]?|here|example|placeholder|changeme|redacted|dummy|sample|test[-_]?key|\*{3}|\.{3}|0{8}|1234567/i;

export function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}

function isJwt(v: string): boolean {
  try { return typeof JSON.parse(Buffer.from(v.split(".")[0], "base64url").toString("utf8"))?.alg === "string"; } catch { return false; }
}

/** Every key-shaped value in `text`, as (kind, offset, value). Internal: the value stays in this module. */
function* matches(text: string): Generator<[SecretKind, number, string]> {
  for (const [kind, re] of VENDOR) {
    for (const m of text.matchAll(re)) {
      const v = m[0];
      if (PLACEHOLDER.test(v) || (kind === "jwt" ? !isJwt(v) : entropy(v) < 3)) continue;
      yield [kind, m.index!, v];
    }
  }
  for (const m of text.matchAll(PEM)) yield ["privateKey", m.index!, m[0]];
  for (const m of text.matchAll(ASSIGN)) {
    const v = m[1];
    // Needs letters AND digits (rules out `process.env.FOO_TOKEN`-style references), no placeholder, real
    // entropy, and not already one of the vendor kinds above (counted there).
    if (v.length < MIN_ASSIGN_LEN || !/[0-9]/.test(v) || !/[A-Za-z]/.test(v) || PLACEHOLDER.test(v) || entropy(v) < MIN_ENTROPY) continue;
    if (VENDOR.some(([, re]) => { re.lastIndex = 0; return re.test(v); })) continue;
    yield ["assignment", m.index! + m[0].length - v.length, v];
  }
  for (const [, re] of VENDOR) re.lastIndex = 0;
}

/** Scan files (streamed in 1 MB chunks, split on whole lines). `root` makes the reported paths relative. */
export function scanFiles(files: string[], root: string): SecretScan {
  const seen = new Map<SecretKind, Set<string>>();
  const places: SecretScan["places"] = [];
  const buf = Buffer.alloc(1 << 20);
  for (const file of files) {
    let fd: number;
    try { fd = openSync(file, "r"); } catch { continue; }
    try {
      let carry = Buffer.alloc(0), line = 1, n: number;
      const block = (b: Buffer) => {
        const text = b.toString("utf8");
        let nl: number[] | undefined;
        for (const [kind, at, v] of matches(text)) {
          const set = seen.get(kind) ?? new Set<string>();
          seen.set(kind, set);
          set.add(createHash("sha256").update(v).digest("hex"));
          if (places.length >= MAX_PLACES) continue;
          nl ??= [...text.matchAll(/\n/g)].map((x) => x.index!);
          let lo = 0, hi = nl.length; // newlines before `at`
          while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < at) lo = mid + 1; else hi = mid; }
          places.push({ file: relative(root, file), line: line + lo });
        }
        for (let i = 0; i < b.length; i++) if (b[i] === 10) line++;
      };
      while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
        const chunk = Buffer.concat([carry, buf.subarray(0, n)]);
        const cut = chunk.lastIndexOf(10) + 1; // a newline byte never sits inside a UTF-8 sequence
        if (cut === 0) { carry = chunk; continue; }
        block(chunk.subarray(0, cut));
        carry = Buffer.from(chunk.subarray(cut));
      }
      if (carry.length) block(carry);
    } finally { closeSync(fd); }
  }
  places.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { counts: Object.fromEntries([...seen].map(([k, s]) => [k, s.size])), places };
}

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      return e.isDirectory() ? filesUnder(p) : e.isFile() ? [p] : [];
    });
  } catch { return []; }
}

/** Exactly what handoff.ts build() packs from the project dir: the transcript, its subagent dir, memory. */
export function handoffTranscriptFiles(projDir: string, uuid: string): string[] {
  const main = join(projDir, `${uuid}.jsonl`);
  return [...(existsSync(main) && statSync(main).isFile() ? [main] : []), ...filesUnder(join(projDir, uuid)), ...filesUnder(join(projDir, "memory"))];
}

export function scanHandoff(projDir: string, uuid: string): SecretScan {
  return scanFiles(handoffTranscriptFiles(projDir, uuid), projDir);
}

export function secretTotal(s: SecretScan): number {
  return Object.values(s.counts).reduce((a, b) => a + (b ?? 0), 0);
}

/** "2 secrets (OpenAI key ×1, AWS key ×1; transcript lines 12, 40)", or undefined when clean. */
export function secretSummary(s: SecretScan, uuid: string): string | undefined {
  const total = secretTotal(s);
  if (!total) return undefined;
  const kinds = (Object.entries(s.counts) as [SecretKind, number][]).map(([k, n]) => `${KIND_LABEL[k]} ×${n}`).join(", ");
  const where = s.places.slice(0, 5).map((p) => p.file === `${uuid}.jsonl` ? `transcript line ${p.line}` : `${p.file} line ${p.line}`).join(", ");
  return `${total} secret${total > 1 ? "s" : ""} (${kinds}; ${where}${s.places.length > 5 ? ", …" : ""})`;
}
