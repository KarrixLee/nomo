// codex-proxy-transport — Node-compatible websocket-over-stdio transport for Codex app-server.
//
// `codex app-server proxy` does not speak JSONL. It exposes one raw connection to the app-server's
// Unix control socket on stdin/stdout, including the HTTP Upgrade and websocket framing. Keeping the
// implementation here avoids a runtime dependency in the self-contained Nomo plugin bundle.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { CodexRpcTransport, CodexRpcTransportHandlers } from "./codex-app-server-client";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_BUFFER_BYTES = 1 << 20; // JSON-RPC messages should be far smaller than 1 MiB.
const DEFAULT_MAX_HANDSHAKE_BYTES = 16 << 10;
/** Largest unmasked server frame header: 2 bytes + an 8-byte extended length. */
const MAX_FRAME_HEADER_BYTES = 10;

/** The transport failure that means THE SHARED DAEMON IS GONE, rather than "this connection had a bad
 *  day": `codex app-server proxy` closed its stdout without the transport asking it to. proxy does one
 *  thing — relay the app-server's control socket — so its stream ending unbidden means it could not
 *  reach (or lost) that socket. Named and exported because the watchdog's bridge supervisor matches on
 *  it to conclude "daemon down" and arm the cooldown-gated restart: in the 2026-08-09 outage this exact
 *  error arrived 240 times in five hours and nothing anywhere drew that conclusion.
 *
 *  Kept as a whole-message constant so the match is a substring test against the string that is
 *  actually thrown, not a regex re-guessing the wording. */
export const CODEX_PROXY_STDOUT_ENDED = "Codex app-server proxy stdout ended";

export interface CodexProxyReadable {
  on(event: "data", listener: (chunk: Buffer | Uint8Array | string) => void): this;
  on(event: "end" | "error", listener: (error?: unknown) => void): this;
  /** `any[]` mirrors node's own EventEmitter.removeListener. It was `never[]`, which nothing that
   *  actually extends EventEmitter — node's real streams included — can implement, so the only
   *  structural check on these shapes (the test double's `implements`) could not pass and every
   *  call site needed a cast back to `never[]`. */
  removeListener(event: "data" | "end" | "error", listener: (...args: any[]) => void): this;
}

export interface CodexProxyWritable {
  write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean;
  end(): void;
  on(event: "error", listener: (error: unknown) => void): this;
  /** `any[]` per node's EventEmitter — see CodexProxyReadable.removeListener. */
  removeListener(event: "error", listener: (...args: any[]) => void): this;
}

export interface CodexProxyChild {
  stdin: CodexProxyWritable;
  stdout: CodexProxyReadable;
  stderr?: CodexProxyReadable;
  on(event: "error", listener: (error: unknown) => void): this;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  /** `any[]` per node's EventEmitter — see CodexProxyReadable.removeListener. */
  removeListener(event: "error" | "exit", listener: (...args: any[]) => void): this;
  kill(signal?: string): boolean;
}

export type CodexProxySpawner = (command: string, args: readonly string[]) => CodexProxyChild;

export interface CodexProxyTransportOptions {
  codexPath?: string;
  socketPath?: string;
  maxBufferBytes?: number;
  maxHandshakeBytes?: number;
  spawnProxy?: CodexProxySpawner;
  randomBytes?: (size: number) => Uint8Array;
}

function defaultSpawnProxy(command: string, args: readonly string[]): CodexProxyChild {
  return spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] }) as unknown as CodexProxyChild;
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(value === undefined ? fallback : String(value));
}

function websocketAccept(key: string): string {
  return createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
}

function parseUpgradeResponse(raw: Buffer, key: string): void {
  const text = raw.toString("latin1");
  const lines = text.split("\r\n");
  if (!/^HTTP\/1\.[01] 101(?:\s|$)/i.test(lines[0] ?? "")) {
    throw new Error(`Codex app-server websocket upgrade failed: ${lines[0] || "empty response"}`);
  }
  const headers = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const values = headers.get(name) ?? [];
    values.push(value);
    headers.set(name, values);
  }
  const tokens = (name: string): string[] => (headers.get(name) ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase());
  if (!tokens("upgrade").includes("websocket") || !tokens("connection").includes("upgrade")) {
    throw new Error("Codex app-server returned an invalid websocket upgrade response");
  }
  if ((headers.get("sec-websocket-accept") ?? [])[0] !== websocketAccept(key)) {
    throw new Error("Codex app-server returned an invalid Sec-WebSocket-Accept header");
  }
}

function encodeClientFrame(opcode: number, payload: Uint8Array, random: (size: number) => Uint8Array): Buffer {
  if (payload.byteLength > Number.MAX_SAFE_INTEGER) throw new Error("Websocket payload is too large");
  const extended = payload.byteLength < 126 ? 0 : payload.byteLength <= 0xffff ? 2 : 8;
  const frame = Buffer.allocUnsafe(2 + extended + 4 + payload.byteLength);
  frame[0] = 0x80 | opcode;
  if (extended === 0) frame[1] = 0x80 | payload.byteLength;
  else if (extended === 2) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.byteLength, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }
  const maskOffset = 2 + extended;
  const mask = Buffer.from(random(4));
  if (mask.byteLength !== 4) throw new Error("randomBytes must return the requested byte count");
  mask.copy(frame, maskOffset);
  const payloadOffset = maskOffset + 4;
  for (let index = 0; index < payload.byteLength; index++) {
    frame[payloadOffset + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

/** A single subprocess-backed CodexRpcTransport. Create a new instance for every reconnect. */
export class CodexProxyTransport implements CodexRpcTransport {
  private readonly options: Required<Pick<CodexProxyTransportOptions,
    "codexPath" | "maxBufferBytes" | "maxHandshakeBytes" | "spawnProxy" | "randomBytes">> &
    Pick<CodexProxyTransportOptions, "socketPath">;
  private child: CodexProxyChild | undefined;
  private handlers: CodexRpcTransportHandlers | undefined;
  private buffer = Buffer.alloc(0);
  private handshakeKey = "";
  private upgraded = false;
  private closing = false;
  private ended = false;
  private fragmented: Buffer[] | undefined;
  private fragmentedBytes = 0;
  private openResolve: (() => void) | undefined;
  private openReject: ((error: Error) => void) | undefined;
  private stderrTail = "";

  constructor(options: CodexProxyTransportOptions = {}) {
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    const maxHandshakeBytes = options.maxHandshakeBytes ?? DEFAULT_MAX_HANDSHAKE_BYTES;
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1) throw new Error("maxBufferBytes must be positive");
    if (!Number.isSafeInteger(maxHandshakeBytes) || maxHandshakeBytes < 1) throw new Error("maxHandshakeBytes must be positive");
    this.options = {
      codexPath: options.codexPath ?? "codex",
      socketPath: options.socketPath,
      maxBufferBytes,
      maxHandshakeBytes,
      spawnProxy: options.spawnProxy ?? defaultSpawnProxy,
      randomBytes: options.randomBytes ?? randomBytes,
    };
  }

  open(handlers: CodexRpcTransportHandlers): Promise<void> {
    // One instance per connect: an ended instance must reject instead of spawning a second child whose
    // open() promise could never settle (finish() already consumed the resolve/reject pair).
    if (this.child || this.openResolve || this.upgraded || this.ended) {
      return Promise.reject(new Error("Codex proxy transport has already been opened"));
    }
    this.handlers = handlers;
    const args = ["app-server", "proxy"];
    if (this.options.socketPath) args.push("--sock", this.options.socketPath);
    try {
      this.child = this.options.spawnProxy(this.options.codexPath, args);
    } catch (error) {
      return Promise.reject(asError(error, "Failed to spawn Codex app-server proxy"));
    }

    const child = this.child;
    child.stdout.on("data", this.onStdoutData);
    child.stdout.on("end", this.onStdoutEnd);
    child.stdout.on("error", this.onStreamError);
    child.stdin.on("error", this.onStreamError);
    child.stderr?.on("data", this.onStderrData);
    child.stderr?.on("error", this.onStderrError);
    child.on("error", this.onChildError);
    child.on("exit", this.onChildExit);

    let keyBytes: Uint8Array;
    try {
      keyBytes = this.options.randomBytes(16);
      if (keyBytes.byteLength !== 16) throw new Error("randomBytes must return the requested byte count");
    } catch (error) {
      this.finish(asError(error, "Could not create websocket key"));
      return Promise.reject(asError(error, "Could not create websocket key"));
    }
    this.handshakeKey = Buffer.from(keyBytes).toString("base64");
    const request = [
      "GET / HTTP/1.1",
      "Host: localhost",
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${this.handshakeKey}`,
      "",
      "",
    ].join("\r\n");

    return new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
      this.writeRaw(request).catch((error) => this.finish(error));
    });
  }

  async send(message: object): Promise<void> {
    if (!this.upgraded || this.closing || this.ended) throw new Error("Codex proxy transport is not open");
    let encoded: Buffer;
    try {
      encoded = Buffer.from(JSON.stringify(message), "utf8");
    } catch (error) {
      throw asError(error, "Could not encode Codex RPC message");
    }
    if (encoded.byteLength > this.options.maxBufferBytes) throw new Error("Codex RPC message exceeds transport limit");
    await this.writeFrame(0x1, encoded);
  }

  async close(): Promise<void> {
    if (this.ended || this.closing) return;
    this.closing = true;
    if (this.upgraded) {
      try { await this.writeFrame(0x8, Buffer.alloc(0)); } catch { /* subprocess may already be gone */ }
    }
    this.finish();
  }

  private readonly onStdoutData = (chunk: Buffer | Uint8Array | string): void => {
    if (this.ended || this.closing) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // Keep the inbound limit symmetric with send(), which bounds the PAYLOAD at maxBufferBytes: a legal
    // maximum-size message also carries its frame header, and counting that against the same number
    // would tear down the connection on a message we would happily have sent ourselves.
    const receiveLimit = this.upgraded
      ? this.options.maxBufferBytes + MAX_FRAME_HEADER_BYTES
      : this.options.maxHandshakeBytes + this.options.maxBufferBytes + MAX_FRAME_HEADER_BYTES;
    if (this.buffer.byteLength + incoming.byteLength > receiveLimit) {
      this.finish(new Error("Codex proxy transport receive buffer exceeded its limit"));
      return;
    }
    this.buffer = this.buffer.byteLength === 0 ? Buffer.from(incoming) : Buffer.concat([this.buffer, incoming]);
    try {
      if (!this.upgraded && !this.consumeHandshake()) return;
      this.consumeFrames();
    } catch (error) {
      this.finish(asError(error, "Invalid Codex app-server websocket data"));
    }
  };

  private readonly onStdoutEnd = (): void => this.finish(new Error(CODEX_PROXY_STDOUT_ENDED));
  private readonly onStreamError = (error?: unknown): void => this.finish(asError(error, "Codex app-server proxy stream failed"));
  private readonly onStderrError = (): void => { /* stderr is diagnostic-only */ };
  private readonly onStderrData = (chunk: Buffer | Uint8Array | string): void => {
    this.stderrTail = (this.stderrTail + Buffer.from(chunk).toString("utf8")).slice(-4096);
  };
  private readonly onChildError = (error: unknown): void => this.finish(asError(error, "Codex app-server proxy failed"));
  private readonly onChildExit = (code: number | null, signal: string | null): void => {
    const suffix = this.stderrTail.trim();
    const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    this.finish(new Error(`Codex app-server proxy exited with ${detail}${suffix ? `: ${suffix}` : ""}`));
  };

  private consumeHandshake(): boolean {
    const boundary = this.buffer.indexOf("\r\n\r\n");
    if (boundary < 0) {
      if (this.buffer.byteLength > this.options.maxHandshakeBytes) throw new Error("Codex websocket handshake exceeded its limit");
      return false;
    }
    const end = boundary + 4;
    if (end > this.options.maxHandshakeBytes) throw new Error("Codex websocket handshake exceeded its limit");
    parseUpgradeResponse(this.buffer.subarray(0, end), this.handshakeKey);
    this.buffer = this.buffer.subarray(end);
    this.upgraded = true;
    const resolve = this.openResolve;
    this.openResolve = undefined;
    this.openReject = undefined;
    resolve?.();
    return true;
  }

  private consumeFrames(): void {
    while (this.buffer.byteLength >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0) throw new Error("Unsupported websocket extension bits");
      if ((second & 0x80) !== 0) throw new Error("Codex app-server sent a masked websocket frame");

      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.byteLength < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.byteLength < 10) return;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(this.options.maxBufferBytes)) throw new Error("Websocket frame exceeds transport limit");
        length = Number(longLength);
        offset = 10;
      }
      if (length > this.options.maxBufferBytes) throw new Error("Websocket frame exceeds transport limit");
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) throw new Error("Invalid websocket control frame");
      if (this.buffer.byteLength < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      this.onFrame(fin, opcode, payload);
      if (this.ended) return;
    }
  }

  private onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case 0x0:
        if (!this.fragmented) throw new Error("Unexpected websocket continuation frame");
        this.appendFragment(payload);
        if (fin) this.finishTextMessage();
        return;
      case 0x1:
        if (this.fragmented) throw new Error("New websocket data frame before fragmented message finished");
        if (fin) this.deliverText(payload);
        else {
          this.fragmented = [];
          this.fragmentedBytes = 0;
          this.appendFragment(payload);
        }
        return;
      case 0x2:
        throw new Error("Codex app-server sent an unsupported binary websocket frame");
      case 0x8:
        if (payload.byteLength === 1) throw new Error("Invalid websocket close payload");
        this.closing = true;
        // Terminal catch: .finally() forwards a throwing finish() into a new rejected promise, which
        // would be an unhandled rejection (fatal under Node >= 15).
        void this.writeFrame(0x8, payload)
          .catch(() => undefined)
          .finally(() => this.finish())
          .catch(() => undefined);
        return;
      case 0x9:
        void this.writeFrame(0xa, payload)
          .catch((error) => this.finish(error))
          .catch(() => undefined);
        return;
      case 0xa:
        return;
      default:
        throw new Error(`Unsupported websocket opcode ${opcode}`);
    }
  }

  private appendFragment(payload: Buffer): void {
    this.fragmentedBytes += payload.byteLength;
    if (this.fragmentedBytes > this.options.maxBufferBytes) throw new Error("Websocket message exceeds transport limit");
    this.fragmented!.push(payload);
  }

  private finishTextMessage(): void {
    const payload = Buffer.concat(this.fragmented ?? [], this.fragmentedBytes);
    this.fragmented = undefined;
    this.fragmentedBytes = 0;
    this.deliverText(payload);
  }

  private deliverText(payload: Buffer): void {
    if (payload.byteLength > this.options.maxBufferBytes) throw new Error("Websocket message exceeds transport limit");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    } catch {
      throw new Error("Codex app-server sent invalid UTF-8");
    }
    let message: unknown;
    try { message = JSON.parse(text); } catch { throw new Error("Codex app-server sent invalid JSON"); }
    this.handlers?.onMessage(message);
  }

  private writeFrame(opcode: number, payload: Uint8Array): Promise<void> {
    return this.writeRaw(encodeClientFrame(opcode, payload, this.options.randomBytes));
  }

  private writeRaw(chunk: Uint8Array | string): Promise<void> {
    const child = this.child;
    if (!child || this.ended) return Promise.reject(new Error("Codex proxy transport is closed"));
    return new Promise((resolve, reject) => {
      try {
        child.stdin.write(chunk, (error) => error ? reject(error) : resolve());
      } catch (error) {
        reject(asError(error, "Could not write to Codex app-server proxy"));
      }
    });
  }

  private finish(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.closing = false;
    const child = this.child;
    this.child = undefined;
    if (child) {
      child.stdout.removeListener("data", this.onStdoutData);
      child.stdout.removeListener("end", this.onStdoutEnd);
      child.stdout.removeListener("error", this.onStreamError);
      child.stdin.removeListener("error", this.onStreamError);
      child.stderr?.removeListener("data", this.onStderrData);
      child.stderr?.removeListener("error", this.onStderrError);
      child.removeListener("error", this.onChildError);
      child.removeListener("exit", this.onChildExit);
      try { child.stdin.end(); } catch { /* process already gone */ }
      try { child.kill(); } catch { /* process already gone */ }
    }
    const reject = this.openReject;
    const wasOpening = reject !== undefined;
    this.openResolve = undefined;
    this.openReject = undefined;
    if (wasOpening) reject(error ?? new Error("Codex proxy transport closed during websocket upgrade"));
    else if (this.upgraded) this.handlers?.onClose(error);
    this.upgraded = false;
    this.buffer = Buffer.alloc(0);
    this.fragmented = undefined;
    this.fragmentedBytes = 0;
  }
}
