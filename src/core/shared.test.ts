import { describe, expect, test } from "bun:test";
import { PLUGIN_VERSION } from "./shared";

// PLUGIN_VERSION is injected by build.ts as a compile-time `__NOMO_VERSION__` define ONLY in the
// bundled dist/*.mjs. Tests import the raw .ts with no define, so the typeof guard must degrade to
// the dev sentinel rather than throw a ReferenceError.
describe("PLUGIN_VERSION", () => {
  test("falls back to the dev sentinel when __NOMO_VERSION__ is not defined (unbundled/tests)", () => {
    expect(PLUGIN_VERSION).toBe("0.0.0-dev");
  });
});
