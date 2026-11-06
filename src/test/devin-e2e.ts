// devin-e2e — a local smoke test against the REAL Devin CLI with a fake worker (NOM-158). Run by hand,
// never by `bun test` (not a *.test.ts):
//
//   bun run build && bun src/test/devin-e2e.ts allow     # a real `devin -p` run; the phone allows
//   bun src/test/devin-e2e.ts deny                       # …the phone denies with a note
//   bun src/test/devin-e2e.ts abandon                    # NO Devin: replays Devin's give-up (a SIGKILL
//                                                        # of the hook's direct child) on the real bundle
//
// Everything lives in a throwaway dir: Nomo's state (NOMO_CC_DIR), the pairing (pointing at the fake
// worker on 127.0.0.1), the project with its .devin/hooks.v1.json. Nothing reaches a real relay or
// phone. A Devin run uses the signed-in account's quota (one short prompt). Set NOMO_E2E_DUMP=1 to print
// each decrypted frame's plaintext JSON.
//
// The project also registers Nomo's CLAUDE entries (cc-status / cc-permission) as Devin hooks — the
// same payloads and env Devin hands a ~/.claude hook — to prove they stand down inside Devin: no record
// without "agent":"devin" may appear in the sessions dir.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decryptBlob, encryptBlob } from "../core/crypto";

const mode = process.argv[2];
if (mode !== "allow" && mode !== "deny" && mode !== "abandon") {
  console.error("usage: bun src/test/devin-e2e.ts allow|deny|abandon");
  process.exit(2);
}
const PLUGIN = resolve(import.meta.dir, "../../plugin");
const DUMP = process.env.NOMO_E2E_DUMP === "1";
const key = new Uint8Array(32).fill(7);
const log: string[] = [];
const say = (line: string) => { log.push(line); console.log(line); };

/** The process chain above every live devin-approve bundle: "pid comm" lines, nearest first. */
function approveAncestry(): string[] {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! }));
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  // The bundle itself, not the shell running the hook command (`bash -c '…devin-approve.mjs'; exit 0`).
  return rows.filter((r) => r.cmd.includes("devin-approve.mjs") && !/^\S*\b(ba|z|da)?sh -c /.test(r.cmd))
    .map((r) => {
      const chain: string[] = [];
      for (let p = byPid.get(r.ppid), i = 0; p && i < 3; p = byPid.get(p.ppid), i++) chain.push(p.cmd.slice(0, 60));
      return `${r.pid} <- ${chain.join(" <- ")}`;
    });
}

let polls = 0;
let requestId = "";
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as Record<string, unknown>;
    const open = async (blob: unknown) => (typeof blob === "string" ? await decryptBlob(key, blob) as Record<string, unknown> : {});
    if (path === "/v1/cc/event") {
      const b = await open(body.blob);
      say(`event ${String(body.op)} ${b.status ?? "-"} ${b.agent ?? "claude"} ${JSON.stringify(b.title ?? "")} ${b.model ?? ""}`.trimEnd());
      if (DUMP) console.log(`  plaintext ${JSON.stringify(b)}`);
    } else if (path === "/v1/cc/decision") {
      const b = await open(body.blob);
      requestId = String(body.requestId ?? b.permissionRequestId ?? "");
      say(`decision ${b.status ?? "-"} ${b.agent ?? "claude"} ${b.permissionToolName ?? "-"} ${JSON.stringify(b.permissionDetail ?? "")}`);
      if (DUMP) console.log(`  plaintext ${JSON.stringify(b)}`);
      for (const line of approveAncestry()) say(`ancestry ${line}`);
      return Response.json({ hold: true });
    } else if (path === "/v1/cc/decision/resolve") {
      say(`resolve ${String(body.requestId) === requestId ? "same-request" : "other"}`);
    } else if (path.startsWith("/v1/cc/decision/")) {
      if (mode === "abandon" || ++polls < 2) return Response.json({ status: "pending" });
      const decision = mode === "allow" ? { decision: "allow" } : { decision: "deny", message: "nomo e2e deny" };
      say(`answer ${decision.decision}`);
      return Response.json({ status: "answered", answerBlob: await encryptBlob(key, { requestId: path.slice("/v1/cc/decision/".length), ...decision, ts: Date.now() }) });
    }
    return Response.json({});
  },
});

const T = mkdtempSync(join(process.env.NOMO_E2E_DIR ?? tmpdir(), "nomo-devin-e2e-"));
const cc = join(T, "cc");
const proj = join(T, "proj");
mkdirSync(join(cc, "sessions"), { recursive: true, mode: 0o700 });
mkdirSync(join(proj, ".devin"), { recursive: true });
writeFileSync(join(cc, "config.json"), JSON.stringify({
  url: `http://127.0.0.1:${server.port}`, pairingId: "p", pcSecret: "s", e2eKeyB64: Buffer.from(key).toString("base64url"),
}), { mode: 0o600 });

const { devinHooks } = await import(join(PLUGIN, "scripts", "devin-install.mjs") as string) as { devinHooks(root: string): Record<string, unknown[]> };
const hooks = devinHooks(PLUGIN);
const claude = (bundle: string, timeout: number) => ({ hooks: [{ type: "command", command: `'${PLUGIN}/scripts/run.sh' '${PLUGIN}/dist/${bundle}'`, timeout }] });
for (const ev of ["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) (hooks[ev] ??= []).push(claude("cc-status.mjs", 10));
hooks.PermissionRequest!.push(claude("cc-permission.mjs", 60));
writeFileSync(join(proj, ".devin", "hooks.v1.json"), JSON.stringify(hooks, null, 1));
// No ~/.claude hook runs in this project: the user's own hooks must not fire for a test.
writeFileSync(join(proj, ".devin", "config.json"), JSON.stringify({ read_config_from: { claude: false } }));

const env = { ...process.env, NOMO_CC_DIR: cc, NOMO_SKIP_WATCHDOG: "1" };
const failures: string[] = [];
const expectLog = (needle: string) => { if (!log.some((l) => l.startsWith(needle))) failures.push(`missing log line: ${needle}`); };

if (mode === "abandon") {
  // Devin's give-up, replayed: it SIGKILLs the hook's direct child (the shell running our command).
  const payload = { hook_event_name: "PermissionRequest", session_id: "e2e-abandon", prompt_id: "p1", tool_use_id: "t1", tool_name: "exec", tool_input: { command: "touch nomo-e2e-abandon" } };
  const command = (hooks.PermissionRequest![0] as { hooks: Array<{ command: string }> }).hooks[0]!.command;
  const sh = spawn("/bin/sh", ["-c", command], { cwd: proj, env: { ...env, DEVIN_PROJECT_DIR: proj }, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  sh.stdout.on("data", (d) => { out += String(d); });
  sh.stdin.end(JSON.stringify(payload));
  for (let i = 0; i < 100 && !log.some((l) => l.startsWith("decision")); i++) await Bun.sleep(100);
  sh.kill("SIGKILL");
  for (let i = 0; i < 100 && !log.some((l) => l.startsWith("resolve")); i++) await Bun.sleep(100);
  await Bun.sleep(500);
  expectLog("decision decisionPending devin shell");
  expectLog("ancestry");
  expectLog("resolve same-request");
  if (out.trim() !== "") failures.push(`printed to a dead pipe: ${out.trim()}`);
  if (approveAncestry().length > 0) failures.push("the bundle is still running after its card was withdrawn");
} else {
  const prompt = "Create a file named nomo-e2e.txt containing hi, then reply done.";
  const code = await new Promise<number>((done) => {
    const p = spawn(process.env.DEVIN_BIN ?? "devin", ["--respect-workspace-trust=false", "-p", prompt], { cwd: proj, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => p.kill("SIGINT"), 300_000);
    p.on("exit", (c) => { clearTimeout(timer); say(`devin exit ${c} ${JSON.stringify(out.trim().slice(0, 300))}`); done(c ?? 1); });
  });
  await Bun.sleep(1500); // SessionEnd's POST
  const order = ["event start working devin", "decision decisionPending devin Write", `answer ${mode}`];
  if (mode === "allow") order.push("event done done devin");
  order.push("event end");
  let at = 0;
  for (const needle of order) {
    const i = log.findIndex((l, k) => k >= at && l.startsWith(needle));
    if (i === -1) failures.push(`missing (in order): ${needle}`); else at = i + 1;
  }
  expectLog("ancestry");
  const made = existsSync(join(proj, "nomo-e2e.txt"));
  if (mode === "allow" && !made) failures.push("allow: nomo-e2e.txt was not created");
  if (mode === "deny" && made) failures.push("deny: nomo-e2e.txt exists");
  if (code !== 0) failures.push(`devin exited ${code}`);
}

// Review Focus 4: nothing but Devin rows, ever (the Claude entries ran too and must have stood down).
for (const name of readdirSync(join(cc, "sessions"))) {
  if (!name.endsWith(".json")) continue;
  const text = readFileSync(join(cc, "sessions", name), "utf8");
  if (!text.includes('"agent":"devin"')) failures.push(`a non-Devin record appeared: ${name}`);
}
if (existsSync(join(cc, "last-hook-claude"))) failures.push("a Claude entry did not stand down (last-hook-claude written)");

server.stop(true);
if (process.env.NOMO_E2E_KEEP !== "1") rmSync(T, { recursive: true, force: true });
if (failures.length > 0) {
  console.log(`FAIL (${mode})\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`PASS (${mode})`);
process.exit(0);
