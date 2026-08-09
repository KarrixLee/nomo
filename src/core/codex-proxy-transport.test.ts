import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  CODEX_PROXY_STDOUT_ENDED,
  CodexProxyChild,
  CodexProxyTransport,
  CodexProxyWritable,
} from "./codex-proxy-transport";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class FakeReadable extends EventEmitter {
  push(chunk: Buffer | string): void { this.emit("data", chunk); }
  finish(): void { this.emit("end"); }
}

class FakeWritable extends EventEmitter implements CodexProxyWritable {
  writes: Buffer[] = [];
  ended = false;
  writeError: Error | undefined;

  write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean {
    if (this.writeError) callback?.(this.writeError);
    else {
      this.writes.push(Buffer.from(chunk));
      callback?.();
    }
    return true;
  }
  end(): void { this.ended = true; }
}

class FakeChild extends EventEmitter {
  stdin = new FakeWritable();
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
}

function acceptForRequest(request: Buffer): string {
  const match = request.toString("latin1").match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i);
  if (!match) throw new Error("missing websocket key");
  return createHash("sha1").update(match[1].trim() + GUID).digest("base64");
}

function upgrade(child: FakeChild, extra = Buffer.alloc(0), splitAt?: number): void {
  const accept = acceptForRequest(child.stdin.writes[0]);
  const response = Buffer.concat([Buffer.from([
    "HTTP/1.1 101 Switching Protocols",
    "upgrade: WebSocket",
    "connection: keep-alive, Upgrade",
    `sec-websocket-accept: ${accept}`,
    "",
    "",
  ].join("\r\n"), "latin1"), extra]);
  if (splitAt === undefined) child.stdout.push(response);
  else {
    child.stdout.push(response.subarray(0, splitAt));
    child.stdout.push(response.subarray(splitAt));
  }
}

function serverFrame(opcode: number, payload: Buffer | string, fin = true): Buffer {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const extended = bytes.byteLength < 126 ? 0 : bytes.byteLength <= 0xffff ? 2 : 8;
  const frame = Buffer.alloc(2 + extended + bytes.byteLength);
  frame[0] = (fin ? 0x80 : 0) | opcode;
  if (extended === 0) frame[1] = bytes.byteLength;
  else if (extended === 2) {
    frame[1] = 126;
    frame.writeUInt16BE(bytes.byteLength, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(bytes.byteLength), 2);
  }
  bytes.copy(frame, 2 + extended);
  return frame;
}

function decodeClientFrame(frame: Buffer): { opcode: number; payload: Buffer } {
  expect(frame[0] & 0x80).toBe(0x80);
  expect(frame[1] & 0x80).toBe(0x80);
  let offset = 2;
  let length = frame[1] & 0x7f;
  if (length === 126) {
    length = frame.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    length = Number(frame.readBigUInt64BE(offset));
    offset += 8;
  }
  const mask = frame.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.alloc(length);
  for (let index = 0; index < length; index++) payload[index] = frame[offset + index] ^ mask[index % 4];
  return { opcode: frame[0] & 0x0f, payload };
}

function harness(options: ConstructorParameters<typeof CodexProxyTransport>[0] = {}) {
  const child = new FakeChild();
  let spawned: { command: string; args: readonly string[] } | undefined;
  const messages: unknown[] = [];
  const closes: unknown[] = [];
  const transport = new CodexProxyTransport({
    randomBytes: (size) => new Uint8Array(size).fill(size),
    ...options,
    spawnProxy: (command, args) => {
      spawned = { command, args };
      return child as unknown as CodexProxyChild;
    },
  });
  const opening = transport.open({
    onMessage: (message) => messages.push(message),
    onClose: (error) => closes.push(error),
  });
  return { child, transport, opening, messages, closes, spawned: () => spawned };
}

describe("CodexProxyTransport", () => {
  test("spawns app-server proxy and completes a split HTTP websocket upgrade", async () => {
    const h = harness({ codexPath: "/opt/codex", socketPath: "/tmp/codex.sock" });
    expect(h.spawned()).toEqual({
      command: "/opt/codex",
      args: ["app-server", "proxy", "--sock", "/tmp/codex.sock"],
    });
    expect(h.child.stdin.writes[0].toString()).toContain("GET / HTTP/1.1\r\n");
    expect(h.child.stdin.writes[0].toString()).toContain("Sec-WebSocket-Version: 13\r\n");
    upgrade(h.child, Buffer.alloc(0), 17);
    await expect(h.opening).resolves.toBeUndefined();
  });

  test("parses split and coalesced text frames left over after the handshake", async () => {
    const h = harness();
    const first = serverFrame(0x1, JSON.stringify({ method: "one" }));
    const second = serverFrame(0x1, JSON.stringify({ method: "two" }));
    upgrade(h.child, first.subarray(0, 4));
    await h.opening;
    h.child.stdout.push(Buffer.concat([first.subarray(4), second]));
    expect(h.messages).toEqual([{ method: "one" }, { method: "two" }]);
  });

  test("reassembles fragmented text with an interleaved ping and sends a masked pong", async () => {
    const h = harness();
    upgrade(h.child);
    await h.opening;
    h.child.stdout.push(Buffer.concat([
      serverFrame(0x1, '{"value":', false),
      serverFrame(0x9, "hi"),
      serverFrame(0x0, "42}"),
    ]));
    expect(h.messages).toEqual([{ value: 42 }]);
    const pong = decodeClientFrame(h.child.stdin.writes[1]);
    expect(pong.opcode).toBe(0xa);
    expect(pong.payload.toString()).toBe("hi");
  });

  test("sends JSON as a masked client text frame, including extended lengths", async () => {
    const h = harness();
    upgrade(h.child);
    await h.opening;
    const message = { method: "thread/resume", params: { padding: "x".repeat(180) } };
    await h.transport.send(message);
    const decoded = decodeClientFrame(h.child.stdin.writes[1]);
    expect(decoded.opcode).toBe(0x1);
    expect(JSON.parse(decoded.payload.toString())).toEqual(message);
    expect(h.child.stdin.writes[1][1] & 0x7f).toBe(126);
  });

  test("answers close once, tears down the child, and reports a normal close", async () => {
    const h = harness();
    upgrade(h.child);
    await h.opening;
    h.child.stdout.push(serverFrame(0x8, Buffer.from([0x03, 0xe8])));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(decodeClientFrame(h.child.stdin.writes[1]).opcode).toBe(0x8);
    expect(h.child.killed).toBe(true);
    expect(h.child.stdin.ended).toBe(true);
    expect(h.closes).toEqual([undefined]);
    h.child.emit("exit", 0, null);
    expect(h.closes).toHaveLength(1);
  });

  test("rejects an invalid handshake without calling the connected close handler", async () => {
    const h = harness();
    h.child.stdout.push("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    await expect(h.opening).rejects.toThrow("403 Forbidden");
    expect(h.closes).toEqual([]);
    expect(h.child.killed).toBe(true);
  });

  test("fails open on malformed or oversized server frames and invokes onClose once", async () => {
    const h = harness({ maxBufferBytes: 32 });
    upgrade(h.child);
    await h.opening;
    // A 126-byte declared payload exceeds the configured cap before its body is buffered.
    h.child.stdout.push(Buffer.from([0x81, 126, 0, 126]));
    expect(h.closes).toHaveLength(1);
    expect(h.closes[0]).toBeInstanceOf(Error);
    expect((h.closes[0] as Error).message).toContain("exceeds transport limit");
    expect(h.child.killed).toBe(true);
  });

  test("accepts an inbound message whose payload is exactly the send limit", async () => {
    const h = harness({ maxBufferBytes: 64 });
    upgrade(h.child);
    await h.opening;
    const text = JSON.stringify({ m: "x".repeat(64 - 8) });
    expect(Buffer.byteLength(text)).toBe(64);
    // The frame header must not be charged against the payload budget: this message is exactly the
    // size we would happily have sent ourselves.
    await h.transport.send(JSON.parse(text));
    h.child.stdout.push(serverFrame(0x1, text));
    expect(h.messages).toEqual([JSON.parse(text)]);
    expect(h.closes).toEqual([]);

    // One byte over is still a hard failure.
    h.child.stdout.push(serverFrame(0x1, JSON.stringify({ m: "x".repeat(64 - 7) })));
    expect(h.closes).toHaveLength(1);
    expect((h.closes[0] as Error).message).toContain("exceeds transport limit");
  });

  test("rejects reopening a finished transport instead of spawning a second child", async () => {
    let spawns = 0;
    const child = new FakeChild();
    const transport = new CodexProxyTransport({
      randomBytes: (size) => new Uint8Array(size).fill(size),
      spawnProxy: () => { spawns += 1; return child as unknown as CodexProxyChild; },
    });
    const opening = transport.open({ onMessage: () => {}, onClose: () => {} });
    upgrade(child);
    await opening;
    await transport.close();
    expect(spawns).toBe(1);

    await expect(transport.open({ onMessage: () => {}, onClose: () => {} }))
      .rejects.toThrow("already been opened");
    expect(spawns).toBe(1);
  });

  // The watchdog's bridge supervisor concludes "the shared daemon is dead" from this exact message and
  // arms its (cooldown-gated) `codex app-server daemon start` on it, so the wording is a contract between
  // the two modules — not a log string. Pin it here rather than in a regex over there.
  test("proxy stdout ending unbidden reports CODEX_PROXY_STDOUT_ENDED verbatim", async () => {
    const h = harness();
    upgrade(h.child, Buffer.alloc(0), 17);
    await h.opening;
    h.child.stdout.finish();
    expect(h.closes).toHaveLength(1);
    expect((h.closes[0] as Error).message).toBe(CODEX_PROXY_STDOUT_ENDED);
  });

  test("subprocess exit includes bounded stderr context", async () => {
    const h = harness();
    h.child.stderr.push("socket not found");
    h.child.emit("exit", 1, null);
    await expect(h.opening).rejects.toThrow("code 1: socket not found");
    expect(h.closes).toEqual([]);
  });
});
