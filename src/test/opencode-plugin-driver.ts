// A scripted OpenCode server for plugin.test.ts — run as its OWN process, never imported.
//
// The resident plugin reads its pairing from `$HOME/.config/cc-status` at call time and POSTs to the
// worker it finds there, so it can only be exercised with HOME pointed at a temp dir: i.e. in a child
// process (`isolatedTestEnv`). This file is that child. It stands up a fake worker, writes a pairing
// that points at it, loads the real plugin, replays a scripted event stream the way OpenCode does
// (fire-and-forget), and prints the worker's request log as one JSON line.
//
// argv[2] is the scenario: { hold, gateFirstEvent, steps }.
//   - hold            what POST /v1/cc/decision answers (`{hold}`) — is the card granted?
//   - gateFirstEvent  park the FIRST /v1/cc/event response until a `release` step: a backed-up send chain
//   - steps           { ev } fire one event · { waitFor, count } block until the log has that many
//                     entries starting with the string · { release } open the gate
//   - v2              drive the OpenCode 2.x entry (`setup` + a scripted `ctx.event.subscribe` stream);
//                     each `ctx.permission.reply` is logged as `reply <sessionID> <requestID> <decision>`
//   - sessions        v2: what `ctx.session.get` returns per sessionID (the bare Info, as 2.4.1 does);
//                     absent ids throw NotFound
//   - answer          the phone's decision verb, served on the hold's first poll (default: none, pending)
//   - answerMessage   the deny note sealed with `answer`
//   - logKeys         also log `keys <op> <json>` per event: the 2.x append-last blob keys it carried
//   v2 steps also take { write: {name, content} } (a file in the sessions dir, as the watchdog leaves
//   it) and { sleep: ms }; `ctx.session.prompt` / `.interrupt` are logged as `prompt <sid> <text>
//   <delivery> <id>` / `interrupt <sid>`.

import { mkdir, writeFile } from "node:fs/promises";
import { Bytes, decryptBlob, encryptBlob } from "../core/crypto";
import plugin from "../opencode/plugin";

type Step = { ev: unknown } | { waitFor: string; count: number } | { release: true }
  | { write: { name: string; content: string } } | { sleep: number };
const scenario = JSON.parse(process.argv[2] ?? "{}") as {
  hold?: boolean; gateFirstEvent?: boolean; steps: Step[]; v2?: boolean; answer?: string; answerMessage?: string;
  sessions?: Record<string, unknown>; logKeys?: boolean;
};
const EXTRA_KEYS = ["controls", "phase", "retryAt", "retryReason", "outcome", "bgAgents", "replies"];

const key = new Uint8Array(32).fill(7) as Bytes;
const log: string[] = [];
const resolved = new Set<string>();
let release = (): void => {};
let gate: Promise<void> | undefined = scenario.gateFirstEvent
  ? new Promise<void>((resolve) => { release = resolve; })
  : undefined;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as Record<string, unknown>;
    if (path === "/v1/cc/event") {
      const blob = typeof body.blob === "string" ? await decryptBlob(key, body.blob) as Record<string, unknown> : {};
      log.push(`event ${String(body.op)} ${String(blob.status ?? "-")}`);
      if (scenario.logKeys) {
        log.push(`keys ${String(body.op)} ${JSON.stringify(Object.fromEntries(EXTRA_KEYS.filter((k) => k in blob).map((k) => [k, blob[k]])))}`);
      }
      const parked = gate;
      gate = undefined;
      await parked;
    } else if (path === "/v1/cc/decision") {
      log.push("decision");
      if (scenario.v2 && typeof body.blob === "string") {
        const card = await decryptBlob(key, body.blob) as Record<string, unknown>;
        log.push(`card ${String(card.permissionToolName)} grant=${JSON.stringify(card.permissionGrant)}`);
        if (scenario.logKeys) {
          log.push(`cardkeys ${JSON.stringify({ permissionProjectGrant: card.permissionProjectGrant, controls: card.controls })}`);
        }
      }
      return Response.json({ hold: scenario.hold === true });
    } else if (path === "/v1/cc/decision/resolve") {
      resolved.add(String(body.requestId));
      log.push("resolve");
    } else if (path.startsWith("/v1/cc/decision/")) {
      const requestId = path.slice("/v1/cc/decision/".length);
      if (scenario.answer && !resolved.has(requestId)) {
        return Response.json({ status: "answered", answerBlob: await encryptBlob(key, {
          requestId, decision: scenario.answer, ...(scenario.answerMessage ? { message: scenario.answerMessage } : {}),
        }) });
      }
      return Response.json({ status: resolved.has(path.slice("/v1/cc/decision/".length)) ? "superseded" : "pending" });
    }
    return Response.json({});
  },
});
const url = `http://127.0.0.1:${server.port}`;

const ccDir = `${process.env.HOME}/.config/cc-status`;
await mkdir(`${ccDir}/sessions`, { recursive: true });
await writeFile(`${ccDir}/config.json`, JSON.stringify({
  url, pairingId: "p", pcSecret: "s", e2eKeyB64: Buffer.from(key).toString("base64url"),
}));

// The 2.x stream: a queue the steps push into, read by the plugin's own `for await`.
const queue: unknown[] = [];
let wake = (): void => {};
async function* stream(signal: AbortSignal): AsyncGenerator<unknown> {
  while (!signal.aborted) {
    while (queue.length > 0) yield queue.shift();
    await new Promise<void>((resolve) => { wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
  }
}
const v2Cleanup = scenario.v2 ? await plugin.setup({
  location: { directory: "/tmp/oc-driver" },
  event: { subscribe: ({ signal }) => stream(signal) },
  session: {
    get: async ({ sessionID }) => {
      const data = scenario.sessions?.[sessionID];
      if (data === undefined) throw new Error("Session.NotFoundError");
      return data;
    },
    prompt: async (input) => { log.push(`prompt ${input.sessionID} ${input.text} ${input.delivery} ${input.id}`); return {}; },
    interrupt: async (input) => { log.push(`interrupt ${input.sessionID}`); return { interrupted: true }; },
  },
  permission: {
    reply: async (input) => {
      log.push(`reply ${input.sessionID} ${input.requestID} ${input.decision}${input.message ? ` ${input.message}` : ""}`);
    },
  },
}) : undefined;
const hooks = scenario.v2 ? {} : await plugin.server({ directory: "/tmp/oc-driver", serverUrl: `${url}/` });
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

for (const step of scenario.steps) {
  if ("ev" in step) {
    if (scenario.v2) { queue.push(step.ev); wake(); }
    else void hooks.event?.({ event: step.ev }); // OpenCode does not await its `event` hook either
    await settle(20);
  } else if ("release" in step) {
    release();
  } else if ("write" in step) {
    await writeFile(`${ccDir}/sessions/${step.write.name}`, step.write.content);
  } else if ("sleep" in step) {
    await settle(step.sleep);
  } else {
    const deadline = Date.now() + 15_000;
    while (log.filter((entry) => entry.startsWith(step.waitFor)).length < step.count) {
      if (Date.now() > deadline) { log.push(`TIMEOUT ${step.waitFor}`); break; }
      await settle(20);
    }
  }
}
release();
await hooks.dispose?.(); // rides the send chain's tail, so everything queued has been sent by now
await v2Cleanup?.();
console.log(JSON.stringify(log));
process.exit(0);
