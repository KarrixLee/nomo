// devin-e2e — a local smoke test against the REAL Devin CLI with a fake worker (NOM-158). Run by hand,
// never by `bun test` (not a *.test.ts):
//
//   bun run build && bun src/test/devin-e2e.ts allow     # a real `devin -p` run; the phone allows
//   bun src/test/devin-e2e.ts deny                       # …the phone denies with a note
//   bun src/test/devin-e2e.ts abandon                    # NO Devin: replays Devin's give-up (a SIGKILL
//                                                        # of the hook's direct child) on the real bundle
//   bun src/test/devin-e2e.ts interrupt                  # a real `devin -p` run: the phone answers Always
//                                                        # allow on the first `touch`, the second runs with
//                                                        # no card, then a phone Interrupt ends the turn
//   bun src/test/devin-e2e.ts question                   # `devin acp` (Devin Desktop's transport) with a
//                                                        # tiny stdio client: the phone answers Devin's
//                                                        # ask_user_question and the model uses it
//
// Every Devin session a run creates is deleted afterwards (`devin rm --force <id>`).
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
if (mode !== "allow" && mode !== "deny" && mode !== "abandon" && mode !== "interrupt" && mode !== "question") {
  console.error("usage: bun src/test/devin-e2e.ts allow|deny|abandon|interrupt|question");
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
let cardTool = "";
const sessionIds = new Set<string>();
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as Record<string, unknown>;
    const open = async (blob: unknown) => (typeof blob === "string" ? await decryptBlob(key, blob) as Record<string, unknown> : {});
    if (path === "/v1/cc/event") {
      if (typeof body.sessionId === "string") sessionIds.add(body.sessionId);
      const b = await open(body.blob);
      say(`event ${String(body.op)} ${b.status ?? "-"} ${b.agent ?? "claude"} ${JSON.stringify(b.title ?? "")} ${b.model ?? ""}`.trimEnd());
      if (DUMP) console.log(`  plaintext ${JSON.stringify(b)}`);
    } else if (path === "/v1/cc/decision") {
      const b = await open(body.blob);
      requestId = String(body.requestId ?? b.permissionRequestId ?? "");
      cardTool = String(b.permissionToolName ?? "");
      polls = 0;
      say(`decision ${b.status ?? "-"} ${b.agent ?? "claude"} ${b.permissionToolName ?? "-"} ${JSON.stringify(b.permissionDetail ?? "")}`);
      if (DUMP) console.log(`  plaintext ${JSON.stringify(b)}`);
      for (const line of approveAncestry()) say(`ancestry ${line}`);
      return Response.json({ hold: true });
    } else if (path === "/v1/cc/decision/resolve") {
      say(`resolve ${String(body.requestId) === requestId ? "same-request" : "other"}`);
    } else if (path.startsWith("/v1/cc/decision/")) {
      if (mode === "abandon" || ++polls < 2) return Response.json({ status: "pending" });
      const decision = mode === "allow" ? { decision: "allow" }
        : mode === "interrupt" ? { decision: "allow_always" }
        : mode === "question" ? (cardTool === "AskUserQuestion" ? { decision: "answer", answers: ["Blue"] } : { decision: "allow" })
        : { decision: "deny", message: "nomo e2e deny" };
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
} else if (mode === "interrupt") {
  // The watchdog's half of a phone Interrupt, replayed: stamp the flag once the second `touch` has run
  // (that one must have been approved by the stored grant, with no card).
  let stamped = false;
  const watch = setInterval(() => {
    const sid = [...sessionIds][0];
    if (stamped || !sid || !existsSync(join(proj, "a2.txt"))) return;
    writeFileSync(join(cc, "sessions", `${sid}.interrupt`), JSON.stringify({ at: Date.now() }), { mode: 0o600 });
    stamped = true;
    say("flag stamped after a2.txt");
  }, 10);
  const prompt = "Run these three shell commands one at a time, each as its own separate tool call, waiting for each to finish before the next: `touch a1.txt`, then `touch a2.txt`, then `touch a3.txt`. Then reply done.";
  const { code, out } = await runDevin(prompt);
  clearInterval(watch);
  await Bun.sleep(1500); // SessionEnd's POST
  const decisions = log.filter((l) => l.startsWith("decision"));
  if (decisions.length !== 1 || !decisions[0]!.includes('shell "touch a1.txt"')) failures.push(`expected ONE card (touch a1.txt), got: ${JSON.stringify(decisions)}`);
  expectLog("answer allow_always");
  if (!existsSync(join(proj, "a1.txt")) || !existsSync(join(proj, "a2.txt"))) failures.push("a1.txt / a2.txt not both created");
  say(`a3.txt ${existsSync(join(proj, "a3.txt")) ? "EXISTS (the stop landed one tool later)" : "absent"}`);
  if (!out.includes("Hook stop: Interrupted from Nomo")) failures.push("devin did not report the hook stop");
  if (out.trim().endsWith("done")) failures.push("the turn finished instead of stopping");
  let at = log.findIndex((l) => l.startsWith("flag stamped"));
  for (const needle of ["event done done devin", "event end"]) {
    const i = log.findIndex((l, k) => k > at && l.startsWith(needle));
    if (i === -1) failures.push(`missing after the stamp (in order): ${needle}`); else at = i;
  }
  const sid = [...sessionIds][0] ?? "none";
  for (const leftover of [`${sid}.interrupt`, `${sid}.devin-allow`]) {
    if (existsSync(join(cc, "sessions", leftover))) failures.push(`left behind after SessionEnd: ${leftover}`);
  }
  say(`devin exit ${code} (a hook stop exits 1 in -p)`);
} else if (mode === "question") {
  await askOverAcp();
} else {
  const prompt = "Create a file named nomo-e2e.txt containing hi, then reply done.";
  const { code } = await runDevin(prompt);
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

// Leave no Devin session behind.
for (const id of sessionIds) {
  try {
    execFileSync(process.env.DEVIN_BIN ?? "devin", ["rm", "--force", id], { cwd: proj, stdio: "ignore", timeout: 30_000 });
    say(`devin rm ${id}`);
  } catch {
    failures.push(`could not delete Devin session ${id} — run: devin rm --force ${id}`);
  }
}

server.stop(true);
if (process.env.NOMO_E2E_KEEP !== "1") rmSync(T, { recursive: true, force: true });
if (failures.length > 0) {
  console.log(`FAIL (${mode})\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`PASS (${mode})`);
process.exit(0);

/** One `devin -p` run in the project; resolves with its exit code and combined output. */
function runDevin(prompt: string): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const p = spawn(process.env.DEVIN_BIN ?? "devin", ["--respect-workspace-trust=false", "-p", prompt], { cwd: proj, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => p.kill("SIGINT"), 300_000);
    p.on("exit", (c) => { clearTimeout(timer); say(`devin exit ${c} ${JSON.stringify(out.trim().slice(-300))}`); done({ code: c ?? 1, out }); });
  });
}

/** Devin Desktop's transport: `devin acp` over stdio (JSON-RPC, one message per line), driven by a
 *  minimal client that advertises form elicitation like Desktop. Devin's own question card would
 *  arrive as `elicitation/create`; with the phone's answer it must never come. */
async function askOverAcp(): Promise<void> {
  const p = spawn(process.env.DEVIN_BIN ?? "devin", ["--respect-workspace-trust=false", "acp"], { cwd: proj, env, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (msg: Record<string, unknown>) => void>();
  let text = "";
  let buf = "";
  const send = (msg: object) => p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  let exited = false;
  const call = (id: number, method: string, params: object) => new Promise<Record<string, unknown>>((resolve) => {
    if (exited) return resolve({ error: "devin acp exited" });
    waiting.set(id, resolve);
    send({ id, method, params });
  });
  p.on("exit", (c) => {
    exited = true;
    say(`acp exit ${c}`);
    for (const resolve of waiting.values()) resolve({ error: "devin acp exited" });
    waiting.clear();
  });
  let stderr = "";
  p.stderr.on("data", (d) => { stderr += String(d); });
  p.stdout.on("data", (d) => {
    buf += String(d);
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { continue; }
      const params = (msg.params ?? {}) as Record<string, unknown>;
      if (typeof msg.id === "number" && !msg.method) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); continue; }
      if (msg.method === "session/update") {
        const u = params.update as { sessionUpdate?: string; content?: { text?: string }; title?: string; status?: string } | undefined;
        if (u?.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") text += u.content.text;
        if (u?.sessionUpdate === "tool_call") say(`acp tool_call ${JSON.stringify(u.title ?? "")} ${u.status ?? ""}`.trimEnd());
      } else if (msg.method === "elicitation/create") {
        say("acp elicitation/create (Devin's own question card)");
        send({ id: msg.id, result: { action: "cancel" } });
      } else if (msg.method === "session/request_permission") {
        say("acp session/request_permission");
        send({ id: msg.id, result: { outcome: { outcome: "cancelled" } } });
      } else if (msg.id !== undefined) {
        send({ id: msg.id, error: { code: -32601, message: "not supported by the e2e client" } });
      }
    }
  });
  const timer = setTimeout(() => p.kill("SIGTERM"), 300_000);
  const init = await call(1, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } } });
  if (init.error) failures.push(`initialize: ${JSON.stringify(init.error)} ${stderr.slice(-300)}`);
  const created = await call(2, "session/new", { cwd: proj, mcpServers: [] });
  const sessionId = String((created.result as { sessionId?: unknown } | undefined)?.sessionId ?? "");
  if (sessionId) sessionIds.add(sessionId);
  say(`acp session ${sessionId || JSON.stringify(created.error)}`);
  const prompt = "Use the ask_user_question tool to ask me which color I prefer, with exactly two options: Red and Blue. After I answer, reply with only the color I chose, as one word. Do not run any other tool.";
  const done = await call(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
  clearTimeout(timer);
  say(`acp stop ${JSON.stringify((done.result as { stopReason?: unknown } | undefined)?.stopReason ?? done.error)} reply ${JSON.stringify(text.trim().slice(-200))}`);
  p.stdin.end();
  await new Promise((r) => { if (exited) r(null); p.on("exit", r); setTimeout(() => { p.kill("SIGTERM"); r(null); }, 5_000); });
  await Bun.sleep(1500); // SessionEnd's POST, if any
  expectLog("decision decisionPending devin AskUserQuestion");
  expectLog("answer answer");
  if (log.some((l) => l.startsWith("acp elicitation/create"))) failures.push("Devin still showed its own question card");
  if (!/\bblue\b/i.test(text)) failures.push("the model did not use the phone's answer (Blue)");
}
