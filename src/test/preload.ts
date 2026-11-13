// bun test preload (bunfig.toml): give the run its own CC dir BEFORE any module computes CC_DIR, so a
// default-path call (FREE_MODE_PATH, NO_HOLD_PATH, SESSIONS_DIR, …) never touches the developer's real
// ~/.config/cc-status. Spawned hooks drop it again (isolatedTestEnv) and use their temp HOME instead.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "nomo-test-cc-"));
process.env.NOMO_CC_DIR = dir;
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
