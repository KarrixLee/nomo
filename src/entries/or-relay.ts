// or-relay — NOM-82: a loopback relay between Claude Code on the cloud box and OpenRouter.
//
//   bun plugin/dist/or-relay.mjs            (listens on 127.0.0.1:RELAY_PORT; handoff starts it in tmux `nomo-relay`)
//
// WHY: a session born on Anthropic first-party carries `tool_addition` content blocks inside a mid-
// conversation role:"system" message (CC 2.1.302). Resumed against OpenRouter, CC resends them and
// OpenRouter's validator rejects the WHOLE request (400 Invalid Anthropic Messages API request) before
// any provider sees it. The transcript is never edited (that is the user's record, and rewriting it reads
// as tampering) — the blocks are dropped from each outgoing request instead, and nothing else changes.
//
// KEYS: the relay never reads, stores or logs one. CC's Authorization header (ANTHROPIC_AUTH_TOKEN) is
// passed through untouched like every other header; nothing request-specific is ever logged.
//
// PORTABILITY: node:http/https only, so it runs under bun or node (Node 22 is on every omg image).

import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { PLUGIN_VERSION } from "../core/shared";

export const RELAY_PORT = 47181;
export const OPENROUTER_UPSTREAM = "https://openrouter.ai/api";

/** Drop every `tool_addition` block from messages[].content; a message left with no content is dropped
 *  too. Returns the SAME object when nothing matched, so the caller can forward the original bytes. */
export function stripToolAdditions(body: any): any {
  if (!Array.isArray(body?.messages)) return body;
  let changed = false;
  const messages = body.messages.flatMap((m: any) => {
    if (!Array.isArray(m?.content)) return [m];
    const content = m.content.filter((b: any) => b?.type !== "tool_addition");
    if (content.length === m.content.length) return [m];
    changed = true;
    return content.length ? [{ ...m, content }] : [];
  });
  return changed ? { ...body, messages } : body;
}

/** The body to forward: stripped JSON for the two Messages paths, the original bytes otherwise. */
export function rewriteBody(method: string, path: string, raw: Buffer): Buffer {
  if (method !== "POST" || !/\/v1\/messages(\/count_tokens)?$/.test(path.split("?")[0])) return raw;
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    const out = stripToolAdditions(parsed);
    return out === parsed ? raw : Buffer.from(JSON.stringify(out));
  } catch {
    return raw; // not JSON — not ours to judge
  }
}

/** Start the relay. `upstream` is overridable for tests (a local stub); default OpenRouter. */
export function startRelay(port = RELAY_PORT, upstream = OPENROUTER_UPSTREAM): Server {
  const up = new URL(upstream);
  const send = up.protocol === "https:" ? httpsRequest : httpRequest;
  const base = up.pathname.replace(/\/$/, "");
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = rewriteBody(req.method ?? "GET", req.url ?? "/", Buffer.concat(chunks));
      const headers: IncomingHttpHeaders = { ...req.headers, host: up.host };
      delete headers.connection;
      if (body.length || req.headers["content-length"] !== undefined) headers["content-length"] = String(body.length);
      delete headers["transfer-encoding"];
      const out = send({
        protocol: up.protocol, hostname: up.hostname, port: up.port || undefined,
        method: req.method, path: base + (req.url ?? "/"), headers,
      }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res); // SSE passes through chunk by chunk
      });
      out.on("error", (e) => {
        console.error(`or-relay: upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "nomo relay: upstream unreachable" } }));
      });
      out.end(body);
    });
  }).listen(port, "127.0.0.1");
}

if (import.meta.main) {
  const port = Number(process.env.NOMO_RELAY_PORT) || RELAY_PORT;
  startRelay(port, process.env.NOMO_RELAY_UPSTREAM || OPENROUTER_UPSTREAM)
    .on("listening", () => console.log(`or-relay ${PLUGIN_VERSION}: 127.0.0.1:${port} -> ${process.env.NOMO_RELAY_UPSTREAM || OPENROUTER_UPSTREAM}`))
    .on("error", (e) => { console.error(`or-relay: ${e.message}`); process.exit(1); });
}
