// Tests for the bin/nomo-ai.mjs plan preview — specifically the CODEX GATE.
//
// THE REGRESSION THIS GUARDS. There is no `codex plugin update` verb at all, so what "update" means
// depends entirely on how the marketplace was added, which `~/.codex/config.toml` records as
// `source_type`. A "local" marketplace is read LIVE from its path — no snapshot, nothing for the user
// to run — and every marketplace Codex ships with is local, so an unconditional
// `codex plugin marketplace upgrade` line is wrong more often than it is right. A printed no-op costs
// somebody an afternoon; the line has to be gated.
//
// Driven as a SUBPROCESS against a throwaway HOME, because nomo-ai.mjs is a zero-dependency script
// with no exports (it runs main() on import) — the same reason hook-shim.test.ts drives the real shell
// scripts rather than reimplementing them. `--dry-run` guarantees nothing is installed or written.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createProcessHygiene, isolatedTestEnv } from "../test/process-hygiene";

const { spawnTestProcess } = createProcessHygiene();
const NOMO_AI = join(import.meta.dir, "../../bin/nomo-ai.mjs");

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

/** A machine with Nomo already installed for Codex, whose marketplace has this `source_type`.
 *  `undefined` writes no config.toml at all — the unreadable case. */
async function machine(sourceType: string | undefined): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "nomo-ai-"));
  homes.push(home);
  // The host's own plugin cache is how nomo-ai answers "already installed", and the directory under
  // cache/ is the MARKETPLACE NAME the update command has to quote.
  await mkdir(join(home, ".codex", "plugins", "cache", "acme-mp", "nomo"), { recursive: true });
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  if (sourceType !== undefined) {
    // A decoy section FIRST: the scan must not leak a neighbouring marketplace's source_type.
    await writeFile(
      join(home, ".codex", "config.toml"),
      `[marketplaces.openai-bundled]\nsource_type = "git"\nsource = "/x"\n\n` +
        `[marketplaces.acme-mp]\nlast_updated = "2026-08-17T12:55:41Z"\nsource_type = "${sourceType}"\nsource = "/somewhere"\n`,
    );
  }
  return home;
}

async function plan(home: string): Promise<string> {
  const proc = spawnTestProcess({
    cmd: ["node", NOMO_AI, "--dry-run", "--codex"],
    cwd: home,
    env: isolatedTestEnv(home, { NO_COLOR: "1" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return `${out}${err}`;
}

describe("the Codex row is gated on the marketplace's source_type", () => {
  test("git: the marketplace-upgrade command is printed, quoting the real marketplace name", async () => {
    const out = await plan(await machine("git"));
    expect(out).toContain("codex plugin marketplace upgrade acme-mp");
    // Not the install path — an installed agent must never be re-`marketplace add`ed, which would
    // repoint a source the user aimed somewhere else.
    expect(out).not.toContain("codex plugin marketplace add");
  });

  test("local: NO command at all — Codex reads it live, so anything printed would be a no-op", async () => {
    const out = await plan(await machine("local"));
    expect(out).toContain("already installed");
    expect(out).toContain("live from a local marketplace");
    expect(out).not.toContain("codex plugin marketplace upgrade");
    expect(out).not.toContain("codex plugin marketplace add");
  });

  test("no config.toml: says only what it knows, and borrows neither explanation", async () => {
    const out = await plan(await machine(undefined));
    expect(out).toContain("already installed");
    expect(out).not.toContain("codex plugin marketplace upgrade");
    expect(out).not.toContain("local marketplace");
  });

  test("not installed at all: the install commands are unchanged", async () => {
    const home = await mkdtemp(join(tmpdir(), "nomo-ai-"));
    homes.push(home);
    await mkdir(join(home, ".codex"), { recursive: true });
    const out = await plan(home);
    expect(out).toContain("codex plugin marketplace add KarrixLee/nomo");
    expect(out).toContain("codex plugin add nomo@nomo");
    expect(out).not.toContain("already installed");
  });
});
