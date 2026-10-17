import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64url, generateEphemeralKeyPair } from "../core/crypto";
import { buildPairURL } from "../core/pair-url";
import {
  BOX_MACHINE_NAME, bakeScript, PAIR_FN, targetWorker, boxPairPayload, createBody, lastModel, latestSession, paneScript, projectDirName,
  pubRawFromPkcs8, q, RELAY_PORT, resultPage, takePairUrl, toOpenRouterModel, withReload,
} from "./handoff";
import { RELAY_PORT as RELAY_LISTEN_PORT } from "./or-relay";

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
    const stg = "https://api-status-push-staging.karrixlee1231.workers.dev";
    expect(runPair({ url: "https://api.nomo.gg", e2eKeyB64: "k" })).toBe("NOMO_PAIRED\n");
    expect(runPair({ url: stg, e2eKeyB64: "k" }, stg)).toBe("NOMO_PAIRED\n");
    const re = runPair({ url: "https://api.nomo.gg", e2eKeyB64: "k" }, stg);
    expect(re).toContain("NOMO_REPAIR: https://api.nomo.gg");
    expect(re).toContain(`dist/pair.mjs W=${stg}`);
    expect(runPair(null)).toContain("dist/pair.mjs W=https://api.nomo.gg");
  });
});
