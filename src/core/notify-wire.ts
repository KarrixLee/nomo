// notify-wire — IDEMPOTENT wiring of Codex's `notify` backstop into $CODEX_HOME/config.toml.
//
// The pair flow points Codex's `notify` at nomo's chain wrapper, which fires dist/codex-notify.mjs
// and preserves any pre-existing notify program after a literal "--" separator.
// Historically the SKILL asked the agent to hand-edit config.toml; re-pairing then RE-WRAPPED an
// already-wrapped value, and third-party installers (the computer-use SkyComputerUseClient re-embeds
// the previous notify as `--previous-notify "<json>"`) compounded it into a triple-nested chain that
// double-fired every turn (observed 2026-07-10). This module makes the wrap deterministic and
// idempotent: it UNWRAPS every nomo layer (including nomo chains re-embedded via --previous-notify)
// down to the innermost original non-nomo notify, then wraps that exactly once.
//
// THE STABLE-PATH FIX (2026-08-06, v1.7.9). Up to v1.7.8 the wrapped value was two absolute paths
// INSIDE the installed plugin root — `<root>/scripts/notify-chain.sh` and `<root>/dist/codex-notify.mjs`.
// For a marketplace install that root is a VERSION-PINNED cache directory that the host deletes on
// update, and config.toml is never rewritten afterwards — so the notify backstop broke PERMANENTLY at
// the user's first version bump. (It looked fine on the dev machine only because that one is wired to
// a source checkout, which never moves.) The value now names the version-stable hook shim instead —
// `~/.config/cc-status/hook-shim.sh codex-notify [-- <original…>]` — which resolves the newest
// installed nomo at run time and performs the same fan-out. See plugin/scripts/hook-shim.sh.
//
// Everything here is pure except repairNotifyWiring at the bottom, which owns the self-repair file IO
// for users who never re-pair. PORTABILITY: bun AND node >= 18 — no Bun.* APIs.

import { readFile } from "node:fs/promises";
import { atomicWrite, codexHome } from "./shared";

/** The shim sub-command that runs the notify backstop. Matches the entry whitelist in hook-shim.sh
 *  and the bundle name in plugin/dist/. */
export const NOMO_NOTIFY_ENTRY = "codex-notify";

/** The version-STABLE notify program for a given $HOME: the hook shim, which lives outside every
 *  version-pinned plugin directory and resolves the newest installed nomo itself. Absolute, because
 *  Codex exec's the notify array directly — there is no shell to expand `$HOME` or `~`. */
export function nomoNotifyProgram(home: string): string {
  return `${home}/.config/cc-status/hook-shim.sh`;
}

/** Whether a notify array is (an instance of) nomo's chain wrapper. TWO forms are nomo's:
 *  - LEGACY (≤1.7.8): the versioned `notify-chain.sh` as the program;
 *  - STABLE (≥1.7.9): the hook shim as the program, with `codex-notify` as its first argument.
 *  Both must be recognised, or unwrapping stops being idempotent and a repair would nest the new
 *  wrapper inside the old one. */
export function isNomoNotifyChain(arr: readonly string[]): boolean {
  const prog = arr[0] ?? "";
  if (/(^|\/)notify-chain\.sh$/.test(prog)) return true;
  return /(^|\/)hook-shim\.sh$/.test(prog) && arr[1] === NOMO_NOTIFY_ENTRY;
}

/** Does this ONE string reference a nomo notify wrapper? Used on the JSON blob a third-party host
 *  re-embeds under `--previous-notify` (where the whole nomo argv is squashed into a single string),
 *  so it has to spot both wrapper forms inside a flat string rather than as argv positions. */
export function referencesNomoNotify(text: string): boolean {
  if (text.includes("notify-chain.sh")) return true;
  return text.includes("hook-shim.sh") && text.includes(NOMO_NOTIFY_ENTRY);
}

/** Is this notify array nomo's work at all? The self-repair MUST NOT rewrite a notify nomo never
 *  wrote — repair is repair, not wiring; wiring only ever happens during pairing. */
export function arrayReferencesNomoNotify(arr: readonly string[]): boolean {
  return isNomoNotifyChain(arr) || arr.some((s) => referencesNomoNotify(s));
}

/** Two argv arrays, element-for-element equal. */
function sameCommand(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The innermost ORIGINAL (non-nomo) notify command inside `arr`, or null when nothing non-nomo
 *  remains. Handles both nesting forms seen in the wild:
 *    - nomo's own chain: [notify-chain.sh, codex-notify.mjs, ("--", <orig…>)?] → recurse past "--"
 *      (a nomo-only chain with no "--" wraps nothing → null);
 *    - a third-party host that re-embeds a previous notify as `--previous-notify "<json array>"`
 *      (the computer-use SkyComputerUseClient pattern): when that embedded array references nomo's
 *      chain, unwrap IT too — if it reduces to the host command itself (the usual mutual re-wrap
 *      cycle) or to nothing, drop the `--previous-notify` pair entirely; if it reduces to some OTHER
 *      command, keep the pair but re-embed only that unwrapped inner command. An unparseable
 *      nomo-referencing embed is dropped rather than kept as a broken re-entry into nomo. */
export function unwrapNotify(arr: readonly string[]): string[] | null {
  if (arr.length === 0) return null;
  if (isNomoNotifyChain(arr)) {
    const sep = arr.indexOf("--");
    if (sep === -1) return null; // nomo-only chain — wraps nothing
    return unwrapNotify(arr.slice(sep + 1));
  }
  const i = arr.indexOf("--previous-notify");
  if (i !== -1 && i + 1 < arr.length && referencesNomoNotify(arr[i + 1] ?? "")) {
    const host = [...arr.slice(0, i), ...arr.slice(i + 2)];
    let embedded: unknown = null;
    try { embedded = JSON.parse(arr[i + 1]); } catch { /* unparseable → drop the pair */ }
    if (Array.isArray(embedded) && embedded.every((x): x is string => typeof x === "string")) {
      const inner = unwrapNotify(embedded);
      if (inner !== null && inner.length > 0 && !sameCommand(inner, host)) {
        return [...arr.slice(0, i), "--previous-notify", JSON.stringify(inner), ...arr.slice(i + 2)];
      }
    }
    return host;
  }
  return [...arr];
}

/** The DESIRED notify value: nomo's chain wrapping the innermost original non-nomo notify (if any).
 *  `program` is the STABLE shim path from nomoNotifyProgram() — never a path inside the version-pinned
 *  plugin root, which is the whole point (see the header). IDEMPOTENT: feeding this function its own
 *  output yields the same value, and a legacy versioned wrapping is collapsed and re-pointed in place
 *  rather than nested. */
export function wireNotifyArray(existing: readonly string[] | undefined, program: string): string[] {
  const orig = existing && existing.length > 0 ? unwrapNotify(existing) : null;
  return orig && orig.length > 0
    ? [program, NOMO_NOTIFY_ENTRY, "--", ...orig]
    : [program, NOMO_NOTIFY_ENTRY];
}

/** The parse of config.toml's TOP-LEVEL `notify` assignment:
 *  - { present: false }                 → no top-level notify line;
 *  - { present: true, value }           → a single-line string-array assignment we can safely rewrite;
 *  - { present: true, value: null }     → a notify assignment EXISTS but isn't a shape we can parse
 *                                         (multi-line array, non-string elements…) — callers must NOT
 *                                         rewrite it blindly.
 *  TOML's basic-string escapes on one line are a JSON-compatible subset for the arrays Codex writes,
 *  so the array text after `=` is parsed with JSON.parse. Only the top-level section (before the
 *  first `[table]` header) is scanned — `notify` is a root key in Codex's config. */
export function parseNotifyFromToml(toml: string): { present: boolean; value: string[] | null } {
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) break; // first table header → past the top-level section
    const m = line.match(/^\s*notify\s*=\s*(.*)$/);
    if (!m) continue;
    try {
      const parsed = JSON.parse(m[1]) as unknown;
      if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === "string")) {
        return { present: true, value: parsed };
      }
    } catch { /* fall through — present but unparseable */ }
    return { present: true, value: null };
  }
  return { present: false, value: null };
}

/** config.toml with its top-level `notify` line REPLACED by (or, when absent, gaining) the given
 *  array. JSON.stringify output is valid TOML for an array of basic strings. A new key is inserted
 *  ahead of the first `[table]` header (root keys must precede tables in TOML), else appended. */
export function replaceNotifyInToml(toml: string, arr: readonly string[]): string {
  const line = `notify = ${JSON.stringify(arr)}`;
  const lines = toml.split("\n");
  let firstTable = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { firstTable = i; break; }
    if (/^\s*notify\s*=/.test(lines[i])) {
      lines[i] = line;
      return lines.join("\n");
    }
  }
  if (firstTable === -1) {
    const sep = toml.length === 0 || toml.endsWith("\n") ? "" : "\n";
    return `${toml}${sep}${line}\n`;
  }
  lines.splice(firstTable, 0, line, "");
  return lines.join("\n");
}

// --- SELF-REPAIR ---------------------------------------------------------------------------------
//
// Every user wired before v1.7.9 has a version-pinned notify baked into config.toml, and config.toml
// is only ever rewritten by pairing — so a user who never re-pairs would stay broken forever. This is
// the one piece of nomo that edits a user file WITHOUT being asked to, which is why it is fenced in:
// it runs on Codex SessionStart only (see runHook in core/hook.ts), never touches a notify nomo did
// not author, backs the file up before the first change, writes atomically, and no-ops in silence on
// anything it does not fully understand.

/** THE CHEAP GATE — three substring scans over a file that is typically < 4 KB, run once per Codex
 *  session. It exists so the common case (already stable, or nomo was never wired) costs no TOML
 *  parse, no allocation of consequence and above all no write.
 *
 *  BACKSLASHES ARE STRIPPED before the comparison. A third-party host that re-embeds our value under
 *  `--previous-notify` writes it as a JSON string inside a TOML basic string, so the path arrives
 *  doubly escaped — the raw bytes on the dev machine read `\\/Users\\/karrix\\/…`. Without the strip,
 *  an ALREADY-STABLE nomo sitting inside such an embed would read as "not the current program" and
 *  every single SessionStart would hoist it back out: an endless rewrite war with the other installer
 *  over the user's config file. Stripping is safe here because this is a heuristic gate, not a parse —
 *  everything past it re-reads the value properly. */
export function tomlMayNeedNotifyRepair(toml: string, program: string): boolean {
  const flat = toml.includes("\\") ? toml.split("\\").join("") : toml;
  if (flat.includes("notify-chain.sh")) return true;   // legacy versioned wrapper — always stale
  if (!flat.includes("hook-shim.sh")) return false;    // nomo never wired this notify — not ours
  return !flat.includes(program);                      // stable wrapper, but for a different HOME
}

export type NotifyRepairOutcome =
  /** Nothing to do: no config.toml, or nomo's notify is already in its stable form. */
  | "unchanged"
  /** config.toml was rewritten to the stable form (backup taken on the first change). */
  | "repaired"
  /** Something we refuse to touch: an unparseable notify, or a notify nomo did not author. */
  | "refused";

export interface RepairNotifyDeps {
  /** Codex's config file; defaults to $CODEX_HOME/config.toml. Tests point at a temp file. */
  tomlPath?: string;
  /** The home whose stable shim path the value should name; defaults to $HOME. */
  home?: string;
}

/** Re-point a stale nomo `notify` at the version-stable shim. IDEMPOTENT and FAIL-OPEN: every error
 *  is swallowed, because this runs inside a hook and a broken repair must never wedge a turn. */
export async function repairNotifyWiring(deps: RepairNotifyDeps = {}): Promise<NotifyRepairOutcome> {
  try {
    const home = deps.home ?? process.env.HOME ?? "";
    if (home.length === 0) return "unchanged";
    const program = nomoNotifyProgram(home);
    const tomlPath = deps.tomlPath ?? `${codexHome()}/config.toml`;

    let toml: string;
    try { toml = await readFile(tomlPath, "utf8"); } catch { return "unchanged"; }
    if (!tomlMayNeedNotifyRepair(toml, program)) return "unchanged";

    const parsed = parseNotifyFromToml(toml);
    // present:false means the marker lives somewhere that is not the top-level notify (a comment, a
    // table); value:null means a shape we cannot rewrite without risking the user's config. Both are
    // hands-off — the same refusal wireNotify makes, minus the ability to tell the user about it.
    if (!parsed.present || parsed.value === null) return "refused";
    if (!arrayReferencesNomoNotify(parsed.value)) return "refused";

    const next = wireNotifyArray(parsed.value, program);
    if (sameCommand(next, parsed.value)) return "unchanged";

    // One-time backup of the pre-change file, under the SAME name the pair flow uses, and likewise
    // never overwritten — the first version nomo ever changed is the one worth keeping.
    const bak = `${tomlPath}.bak-nomo`;
    try { await readFile(bak); } catch { await atomicWrite(bak, toml); }
    // replaceNotifyInToml rewrites exactly the top-level `notify` line; every other key, comment and
    // table in the file is carried through byte-for-byte.
    await atomicWrite(tomlPath, replaceNotifyInToml(toml, next));
    return "repaired";
  } catch {
    return "refused";
  }
}
