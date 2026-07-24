import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { localApprovalsState, PLUGIN_VERSION } from "./shared";

// PLUGIN_VERSION is injected by build.ts as a compile-time `__NOMO_VERSION__` define ONLY in the
// bundled dist/*.mjs. Tests import the raw .ts with no define, so the typeof guard must degrade to
// the dev sentinel rather than throw a ReferenceError.
describe("PLUGIN_VERSION", () => {
  test("falls back to the dev sentinel when __NOMO_VERSION__ is not defined (unbundled/tests)", () => {
    expect(PLUGIN_VERSION).toBe("0.0.0-dev");
  });
});

// localApprovalsState is the ONE place that turns the local `no-hold` pause flag into the wire value
// carried by every /cc/event POST. The worker literal-matches "on"/"off" and silently ignores every
// other string, so these assert the EXACT bytes — no case folding, no substring.
describe("localApprovalsState (the x-cc-approvals wire value)", () => {
  test("flag file present → exactly \"off\"", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-nohold-"));
    try {
      const flag = join(dir, "no-hold");
      await writeFile(flag, ""); // `permission off` writes a zero-byte file
      expect(await localApprovalsState(flag)).toBe("off");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("flag file absent → exactly \"on\"", async () => {
    expect(await localApprovalsState("/does/not/exist/no-hold")).toBe("on");
  });
});
