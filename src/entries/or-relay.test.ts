import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rewriteBody, startRelay, stripToolAdditions } from "./or-relay";

describe("or-relay strip", () => {
  test("drops tool_addition blocks, drops a message they emptied, keeps everything else", () => {
    const body = {
      model: "anthropic/claude-haiku-5.5", stream: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: [{ type: "tool_addition", tools: [] }] },
        { role: "user", content: [{ type: "tool_addition" }, { type: "text", text: "keep" }] },
        { role: "assistant", content: "plain string content" },
      ],
    };
    expect(stripToolAdditions(body)).toEqual({
      model: "anthropic/claude-haiku-5.5", stream: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "user", content: [{ type: "text", text: "keep" }] },
        { role: "assistant", content: "plain string content" },
      ],
    });
  });

  test("nothing to strip → same object; only the Messages paths, only valid JSON, are rewritten", () => {
    const clean = { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] };
    expect(stripToolAdditions(clean)).toBe(clean);
    const dirty = Buffer.from(JSON.stringify({ messages: [{ role: "system", content: [{ type: "tool_addition" }] }] }));
    expect(JSON.parse(rewriteBody("POST", "/v1/messages?beta=true", dirty).toString())).toEqual({ messages: [] });
    expect(JSON.parse(rewriteBody("POST", "/v1/messages/count_tokens", dirty).toString())).toEqual({ messages: [] });
    expect(rewriteBody("POST", "/v1/models", dirty)).toBe(dirty);
    const notJson = Buffer.from("{nope");
    expect(rewriteBody("POST", "/v1/messages", notJson)).toBe(notJson);
  });
});

describe("or-relay end to end", () => {
  let seen: { path?: string; auth?: string; body?: any } = {};
  const stub: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: a\ndata: 1\n\n");
      res.end("event: b\ndata: 2\n\n");
    });
  }).listen(0, "127.0.0.1");
  let relay: Server;
  afterAll(() => { stub.close(); relay?.close(); });

  test("strips, keeps path/query/auth, streams the SSE body back", async () => {
    if (!stub.listening) await new Promise((r) => stub.once("listening", r));
    relay = startRelay(0, `http://127.0.0.1:${(stub.address() as AddressInfo).port}/api`);
    await new Promise((r) => relay.once("listening", r));
    const res = await fetch(`http://127.0.0.1:${(relay.address() as AddressInfo).port}/v1/messages?beta=true`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "q" }] }, { role: "system", content: [{ type: "tool_addition" }] }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
    expect(seen.path).toBe("/api/v1/messages?beta=true");
    expect(seen.auth).toBe("Bearer test-token");
    expect(seen.body).toEqual({ messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] });
  });
});
