// notify-wire — IDEMPOTENT wiring of Codex's `notify` backstop into $CODEX_HOME/config.toml.
//
// The pair flow points Codex's `notify` at nomo's chain wrapper (plugin/scripts/notify-chain.sh →
// dist/codex-notify.mjs), preserving any pre-existing notify program after a literal "--" separator.
// Historically the SKILL asked the agent to hand-edit config.toml; re-pairing then RE-WRAPPED an
// already-wrapped value, and third-party installers (the computer-use SkyComputerUseClient re-embeds
// the previous notify as `--previous-notify "<json>"`) compounded it into a triple-nested chain that
// double-fired every turn (observed 2026-07-10). This module makes the wrap deterministic and
// idempotent: it UNWRAPS every nomo layer (including nomo chains re-embedded via --previous-notify)
// down to the innermost original non-nomo notify, then wraps that exactly once with the CURRENT
// plugin root's chain.
//
// Everything here is pure except the callers' file IO (pair.ts owns that). PORTABILITY: bun AND
// node >= 18 — no Bun.* APIs.

/** Whether a notify array is (an instance of) nomo's chain wrapper: its program is notify-chain.sh. */
export function isNomoNotifyChain(arr: readonly string[]): boolean {
  return arr.length > 0 && /(^|\/)notify-chain\.sh$/.test(arr[0] ?? "");
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
  if (i !== -1 && i + 1 < arr.length && (arr[i + 1] ?? "").includes("notify-chain.sh")) {
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

/** The DESIRED notify value for a given plugin root: nomo's chain wrapping the innermost original
 *  non-nomo notify (if any). IDEMPOTENT: feeding this function its own output yields the same value,
 *  and re-pairing with a different root simply refreshes the chain paths in place. */
export function wireNotifyArray(existing: readonly string[] | undefined, root: string): string[] {
  const chain = `${root}/scripts/notify-chain.sh`;
  const mjs = `${root}/dist/codex-notify.mjs`;
  const orig = existing && existing.length > 0 ? unwrapNotify(existing) : null;
  return orig && orig.length > 0 ? [chain, mjs, "--", ...orig] : [chain, mjs];
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
