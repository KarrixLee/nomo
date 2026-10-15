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

import { mkdir, writeFile } from "node:fs/promises";
import { Bytes, decryptBlob } from "../core/crypto";
import plugin from "../opencode/plugin";

type Step = { ev: unknown } | { waitFor: string; count: number } | { release: true };
const scenario = JSON.parse(process.argv[2] ?? "{}") as { hold?: boolean; gateFirstEvent?: boolean; steps: Step[] };

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
      const blob = typeof body.blob === "string" ? await decryptBlob(key, body.blob) as { status?: string } : {};
      log.push(`event ${String(body.op)} ${blob.status ?? "-"}`);
      const parked = gate;
      gate = undefined;
      await parked;
    } else if (path === "/v1/cc/decision") {
      log.push("decision");
      return Response.json({ hold: scenario.hold === true });
    } else if (path === "/v1/cc/decision/resolve") {
      resolved.add(String(body.requestId));
      log.push("resolve");
    } else if (path.startsWith("/v1/cc/decision/")) {
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

const hooks = await plugin.server({ directory: "/tmp/oc-driver", serverUrl: `${url}/` });
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

for (const step of scenario.steps) {
  if ("ev" in step) {
    void hooks.event?.({ event: step.ev }); // OpenCode does not await its `event` hook either
    await settle(20);
  } else if ("release" in step) {
    release();
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
console.log(JSON.stringify(log));
process.exit(0);
