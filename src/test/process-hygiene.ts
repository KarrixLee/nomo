import { afterAll, afterEach } from "bun:test";
import { join } from "node:path";

type TestProcess = {
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
};

/** One process registry per importing test file. A shared global registry could let one file's
 *  afterEach kill another concurrently-running file's child, so callers instantiate their own. */
export function createProcessHygiene(): {
  // Mirrors Bun.spawn's OPTIONS-OBJECT overload explicitly. `Parameters<typeof Bun.spawn>[0]` resolves
  // to the LAST overload's first parameter (`cmd: string[]`), so every `{cmd, env, stdout}` call site
  // was being checked against a string array, and the returned Subprocess lost its stdio generics —
  // `proc.stderr` typed itself off the "inherit" default no matter what the caller asked for.
  spawnTestProcess<
    const In extends Bun.SpawnOptions.Writable = "ignore",
    const Out extends Bun.SpawnOptions.Readable = "pipe",
    const Err extends Bun.SpawnOptions.Readable = "inherit",
  >(options: Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { cmd: string[] }): Bun.Subprocess<In, Out, Err>;
} {
  const live = new Set<TestProcess>();

  /** Track before any later helper step can throw; normal completion removes the child immediately. */
  const trackTestProcess = <T extends TestProcess>(proc: T): T => {
    live.add(proc);
    void proc.exited.finally(() => { live.delete(proc); });
    return proc;
  };

  const spawnTestProcess = <
    const In extends Bun.SpawnOptions.Writable = "ignore",
    const Out extends Bun.SpawnOptions.Readable = "pipe",
    const Err extends Bun.SpawnOptions.Readable = "inherit",
  >(
    options: Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { cmd: string[] },
  ): Bun.Subprocess<In, Out, Err> => trackTestProcess(Bun.spawn(options));

  const stopTrackedProcesses = async (): Promise<void> => {
    const pending = [...live];
    for (const proc of pending) {
      try { proc.kill("SIGTERM"); } catch { /* already exited */ }
    }
    await Promise.all(pending.map(async (proc) => {
      await Promise.race([
        proc.exited.catch(() => 0),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
      if (live.has(proc)) {
        try { proc.kill("SIGKILL"); } catch { /* already exited */ }
        await proc.exited.catch(() => 0);
      }
    }));
  };

  afterEach(stopTrackedProcesses);
  afterAll(stopTrackedProcesses);
  return { spawnTestProcess };
}

/** Every real-entry E2E gets its own config root and Codex home, even when the parent shell exports
 *  CODEX_HOME/XDG_CONFIG_HOME. The explicit watchdog opt-out prevents an unjoinable detached daemon;
 *  ownership behavior has dedicated tests in cc-watchdog.test.ts. */
export function isolatedTestEnv(
  home: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CODEX_HOME: join(home, ".codex"),
    NOMO_SKIP_WATCHDOG: "1",
    // Pinned, not inherited: the Claude adapter classifies a desktop invocation from this var, so a
    // suite run FROM the desktop app would otherwise make every spawned claude hook a desktop one and
    // defer the rows the tests assert on. Desktop cases opt in through `overrides`.
    CLAUDE_CODE_ENTRYPOINT: "cli",
    ...overrides,
  };
}
