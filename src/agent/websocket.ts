/**
 * Minimal RFC 6455 implementation for `vobiz streams forward|test` and the streams tests: the server-side HTTP
 * Upgrade handshake, a client handshake over node:http(s), a frame codec (text, binary, continuation, close, ping,
 * pong; 7/16/64-bit lengths; masking) and a connection object used by both ends. No extensions (permessage-deflate is
 * declined by not echoing it) and no subprotocols.
 *
 * Hardening: a total message cap across fragments, linear buffering, UTF-8 validation of text frames and close
 * reasons, close-code validation, write backpressure (reading pauses while the peer is not reading, pongs are dropped
 * and a ping flood closes the socket), an idle timeout, a close-handshake timeout, handshake header checks, an Origin
 * check and a per-server connection cap.
 */
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;
/** Default cap on one message, across all its fragments (Vobiz media frames are a few KB). */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Default cap on simultaneous WebSocket connections per server. */
export const MAX_WS_CONNECTIONS = 32;
/** Default idle timeout (no bytes either way) for a WebSocket connection. */
export const WS_IDLE_TIMEOUT_MS = 120_000;
/** Reading pauses while this many bytes are queued for a peer that is not reading. */
export const WRITE_HIGH_WATER = 1024 * 1024;
/** A peer that lets this many bytes queue up is closed with 1008. */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_DROPPED_PONGS = 1000;
const CLOSE_TIMEOUT_MS = 5000;

export const acceptKey = (key: string): string => createHash("sha1").update(key + GUID).digest("base64");

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** A protocol violation, with the close code to answer it with. */
export class WebSocketProtocolError extends Error {
  constructor(
    message: string,
    readonly code = 1002,
  ) {
    super(message);
  }
}

/** Encodes one frame. Clients must mask (`mask: true`); servers must not. */
export function encodeFrame(opcode: number, payload: Buffer | string = Buffer.alloc(0), o: { mask?: boolean; fin?: boolean } = {}): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = data.length;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + ext + (o.mask ? 4 : 0));
  head[0] = ((o.fin ?? true) ? 0x80 : 0) | (opcode & 0x0f);
  head[1] = (o.mask ? 0x80 : 0) | (ext === 0 ? len : ext === 2 ? 126 : 127);
  if (ext === 2) head.writeUInt16BE(len, 2);
  if (ext === 8) head.writeBigUInt64BE(BigInt(len), 2);
  if (!o.mask) return Buffer.concat([head, data]);
  const key = randomBytes(4);
  key.copy(head, 2 + ext);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([head, masked]);
}

/**
 * Incremental decoder: push bytes, get complete frames (unmasked). Throws `WebSocketProtocolError` on a violation.
 * Chunks are kept in a list and copied once, when a frame is complete, so a frame trickled in small pieces costs
 * linear time.
 */
export class FrameParser {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly o: { requireMask?: boolean; forbidMask?: boolean; maxPayload?: number } = {}) {}

  /** Bytes buffered but not yet returned as frames. */
  get buffered(): number {
    return this.size;
  }

  /** The first `n` buffered bytes (copies only what is needed). */
  private peek(n: number): Buffer {
    if (this.chunks[0].length >= n) return this.chunks[0];
    const parts: Buffer[] = [];
    let got = 0;
    for (const c of this.chunks) {
      parts.push(c);
      got += c.length;
      if (got >= n) break;
    }
    return Buffer.concat(parts, got);
  }

  /** Removes and returns the first `n` buffered bytes. */
  private take(n: number): Buffer {
    const out = this.chunks[0].length >= n ? this.chunks[0].subarray(0, n) : Buffer.allocUnsafe(n);
    if (this.chunks[0].length >= n) {
      const rest = this.chunks[0].subarray(n);
      if (rest.length) this.chunks[0] = rest;
      else this.chunks.shift();
    } else {
      let off = 0;
      while (off < n) {
        const c = this.chunks[0];
        const k = Math.min(c.length, n - off);
        c.copy(out, off, 0, k);
        off += k;
        if (k === c.length) this.chunks.shift();
        else this.chunks[0] = c.subarray(k);
      }
    }
    this.size -= n;
    return out;
  }

  push(chunk: Buffer): Frame[] {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
    const max = this.o.maxPayload ?? MAX_MESSAGE_BYTES;
    const frames: Frame[] = [];
    for (;;) {
      if (this.size < 2) break;
      let head = this.peek(Math.min(this.size, 14));
      const b0 = head[0];
      const b1 = head[1];
      if (b0 & 0x70) throw new WebSocketProtocolError("reserved bits set (no extension was negotiated)");
      const opcode = b0 & 0x0f;
      const fin = !!(b0 & 0x80);
      if ((opcode > 0x2 && opcode < 0x8) || opcode > 0xa) throw new WebSocketProtocolError(`unknown opcode ${opcode}`);
      const masked = !!(b1 & 0x80);
      if (this.o.requireMask && !masked) throw new WebSocketProtocolError("client frame is not masked");
      if (this.o.forbidMask && masked) throw new WebSocketProtocolError("server frame is masked");
      let len = b1 & 0x7f;
      let off = 2;
      if (opcode >= 0x8 && (!fin || len > 125)) throw new WebSocketProtocolError("invalid control frame");
      if (len === 126) {
        if (this.size < 4) break;
        head = this.peek(4);
        len = head.readUInt16BE(2);
        if (len < 126) throw new WebSocketProtocolError("non-minimal length encoding");
        off = 4;
      } else if (len === 127) {
        if (this.size < 10) break;
        head = this.peek(10);
        const big = head.readBigUInt64BE(2);
        if (big >> 63n) throw new WebSocketProtocolError("invalid 64-bit length");
        if (big > BigInt(max)) throw new WebSocketProtocolError("message too large", 1009);
        len = Number(big);
        if (len < 65536) throw new WebSocketProtocolError("non-minimal length encoding");
        off = 10;
      }
      if (len > max) throw new WebSocketProtocolError("message too large", 1009);
      const total = off + (masked ? 4 : 0) + len;
      if (this.size < total) break;
      const raw = this.take(total);
      let payload: Buffer;
      if (masked) {
        const key = raw.subarray(off, off + 4);
        payload = Buffer.allocUnsafe(len);
        const src = raw.subarray(off + 4);
        for (let i = 0; i < len; i++) payload[i] = src[i] ^ key[i & 3];
      } else payload = Buffer.from(raw.subarray(off));
      frames.push({ fin, opcode, payload });
    }
    return frames;
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
/** Decodes UTF-8 strictly; throws a 1007 protocol error on invalid bytes. */
function decodeUtf8(b: Buffer): string {
  try {
    return utf8.decode(b);
  } catch {
    throw new WebSocketProtocolError("invalid UTF-8", 1007);
  }
}

/** Close codes a peer may send on the wire (RFC 6455 §7.4, IANA registry). */
export const isValidCloseCode = (c: number): boolean => (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999);

/** Truncates a close reason to 123 UTF-8 bytes without splitting a character. */
function closeReasonBytes(reason: string): Buffer {
  let b = Buffer.from(reason, "utf8");
  if (b.length <= 123) return b;
  b = b.subarray(0, 123);
  let end = 123;
  while (end > 0 && (b[end - 1] & 0xc0) === 0x80) end--;
  if (end > 0 && b[end - 1] >= 0xc0) end--; // drop a lead byte whose continuation was cut
  return b.subarray(0, end);
}

export interface ConnectionOptions {
  /** Largest message accepted, across fragments (default 16 MiB); larger closes with 1009. */
  maxMessageBytes?: number;
  /** Close with 1001 after this long without traffic (default 120 s; 0 disables). */
  idleTimeoutMs?: number;
  /** Pause reading while more than this many bytes are queued for the peer (default 1 MiB). */
  highWaterMark?: number;
  /** Close with 1008 when more than this many bytes are queued for the peer (default 8 MiB). */
  maxBufferedBytes?: number;
  /** Destroy the socket this long after sending a close frame if the peer never completes the handshake (default 5 s). */
  closeTimeoutMs?: number;
}

/**
 * One end of a WebSocket connection (server or client role).
 *   events: "message" (data: Buffer, isBinary: boolean), "close" (code: number, reason: string), "error" (Error)
 * The "close" code is the peer's (1005 when its close frame had no code), else the local one, else 1006.
 */
export class WebSocketConnection extends EventEmitter {
  private readonly parser: FrameParser;
  private readonly max: number;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = 0;
  private closed = false;
  private closeSent = false;
  private local?: { code: number; reason: string };
  private droppedPongs = 0;
  private paused = false;
  private closeTimer?: NodeJS.Timeout;

  /**
   * `head` holds bytes that arrived with the handshake. Reading starts once a "message" listener is attached (in a
   * microtask), so frames that arrive with or right after the handshake are never emitted before anyone listens.
   */
  constructor(
    private readonly socket: Duplex,
    private readonly role: "server" | "client",
    private readonly o: ConnectionOptions = {},
    head: Buffer = Buffer.alloc(0),
  ) {
    super();
    this.max = o.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.parser = new FrameParser(role === "server" ? { requireMask: true, maxPayload: this.max } : { forbidMask: true, maxPayload: this.max });
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      this.onData(head);
      socket.on("data", (chunk: Buffer) => this.onData(chunk));
    };
    this.on("newListener", (event: string) => {
      if (event === "message") queueMicrotask(start);
    });
    socket.on("error", (err) => this.emit("error", err));
    socket.on("close", () => this.finish(1006, ""));
    // http.Server sockets allow half-open connections; a peer that sends FIN is done with us.
    socket.on("end", () => socket.destroy());
    socket.on("drain", () => this.resume());
    const idle = o.idleTimeoutMs ?? WS_IDLE_TIMEOUT_MS;
    const s = socket as Partial<Socket>;
    if (typeof s.setNoDelay === "function") s.setNoDelay(true);
    if (idle > 0 && typeof s.setTimeout === "function")
      s.setTimeout(idle, () => {
        this.emit("error", new Error("idle timeout"));
        if (this.closeSent) socket.destroy();
        else this.close(1001, "idle timeout");
      });
  }

  get isOpen(): boolean {
    return !this.closed && !this.closeSent;
  }

  /** Bytes queued for the peer and not yet written to the network. */
  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  private write(opcode: number, payload: Buffer | string): void {
    this.socket.write(encodeFrame(opcode, payload, { mask: this.role === "client" }));
  }

  /** Sends a message. A peer that leaves more than `maxBufferedBytes` unread is closed with 1008 instead. */
  send(data: string | Uint8Array): boolean {
    if (!this.isOpen) return false;
    if (this.socket.writableLength > (this.o.maxBufferedBytes ?? MAX_BUFFERED_BYTES)) {
      this.emit("error", new Error("peer is not reading; closing"));
      this.close(1008, "peer is not reading");
      return false;
    }
    const isText = typeof data === "string";
    this.write(isText ? OPCODE.text : OPCODE.binary, isText ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    return true;
  }

  /** Sends a close frame (codes 1005/1006/1015 and invalid codes go out as 1000) and waits briefly for the peer's. */
  close(code = 1000, reason = ""): void {
    if (this.closed || this.closeSent) return;
    this.closeSent = true;
    this.local = { code, reason };
    const wire = isValidCloseCode(code) ? code : 1000;
    const r = closeReasonBytes(reason);
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(wire, 0);
    r.copy(body, 2);
    this.write(OPCODE.close, body);
    if (this.role === "server") this.socket.end();
    this.closeTimer = setTimeout(() => this.terminate(), this.o.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
    this.closeTimer.unref?.();
  }

  /** Drops the connection without a close frame. */
  terminate(): void {
    this.socket.destroy();
    this.finish(1006, "");
  }

  private finish(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (code === 1006 && this.local) ({ code, reason } = this.local);
    this.emit("close", code, reason);
  }

  private resume() {
    if (!this.paused) return;
    this.paused = false;
    this.socket.resume();
  }

  private fail(err: WebSocketProtocolError) {
    this.emit("error", err);
    if (this.closeSent) this.terminate();
    else this.close(err.code, err.message);
  }

  private onData(chunk: Buffer) {
    if (this.closed) return;
    let frames: Frame[];
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      return this.fail(err instanceof WebSocketProtocolError ? err : new WebSocketProtocolError(String(err)));
    }
    try {
      for (const f of frames) {
        if (this.closed) return;
        this.onFrame(f);
      }
    } catch (err) {
      if (err instanceof WebSocketProtocolError) return this.fail(err);
      throw err;
    }
    if (!this.paused && !this.closed && this.socket.writableLength > (this.o.highWaterMark ?? WRITE_HIGH_WATER)) {
      this.paused = true;
      this.socket.pause();
    }
  }

  private onFrame(f: Frame) {
    switch (f.opcode) {
      case OPCODE.ping:
        if (!this.isOpen) return;
        if (this.socket.writableLength > (this.o.highWaterMark ?? WRITE_HIGH_WATER)) {
          if (++this.droppedPongs > MAX_DROPPED_PONGS) throw new WebSocketProtocolError("ping flood", 1008);
          return;
        }
        this.write(OPCODE.pong, f.payload);
        return;
      case OPCODE.pong:
        return;
      case OPCODE.close: {
        const p = f.payload;
        if (p.length === 1) throw new WebSocketProtocolError("close frame with a 1-byte payload");
        let code = 1005;
        let reason = "";
        if (p.length >= 2) {
          code = p.readUInt16BE(0);
          if (!isValidCloseCode(code)) throw new WebSocketProtocolError(`invalid close code ${code}`);
          reason = decodeUtf8(p.subarray(2));
        }
        if (!this.closeSent) {
          this.closeSent = true;
          const echo = Buffer.alloc(p.length >= 2 ? 2 : 0);
          if (echo.length) echo.writeUInt16BE(1000, 0);
          this.write(OPCODE.close, echo);
        }
        if (this.role === "server") this.socket.end();
        // A client waits for the server to close TCP first, but not forever.
        else setTimeout(() => this.socket.destroy(), 1000).unref?.();
        this.local = undefined;
        this.finish(code, reason);
        return;
      }
      case OPCODE.continuation:
        if (!this.fragmentOpcode) throw new WebSocketProtocolError("unexpected continuation frame");
        this.addFragment(f.payload);
        if (f.fin) this.deliver(this.fragmentOpcode, Buffer.concat(this.fragments, this.fragmentBytes));
        return;
      case OPCODE.text:
      case OPCODE.binary:
        if (this.fragmentOpcode) throw new WebSocketProtocolError("new message before the previous one finished");
        if (f.fin) return this.deliver(f.opcode, f.payload);
        this.fragmentOpcode = f.opcode;
        this.fragments = [];
        this.fragmentBytes = 0;
        this.addFragment(f.payload);
        return;
      default:
        throw new WebSocketProtocolError(`unknown opcode ${f.opcode}`);
    }
  }

  private addFragment(b: Buffer) {
    this.fragmentBytes += b.length;
    if (this.fragmentBytes > this.max) throw new WebSocketProtocolError("message too large", 1009);
    this.fragments.push(b);
  }

  private deliver(opcode: number, data: Buffer) {
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    if (opcode === OPCODE.text) decodeUtf8(data);
    this.emit("message", data, opcode === OPCODE.binary);
  }
}

/** The server end of one WebSocket connection. */
export class ServerWebSocket extends WebSocketConnection {
  constructor(socket: Duplex, o: ConnectionOptions = {}, head?: Buffer) {
    super(socket, "server", o, head);
  }
}

export interface UpgradeOptions extends ConnectionOptions {
  /** Origins allowed to connect. A request with any other `Origin` header (i.e. from a browser page) gets 403. */
  allowOrigins?: string[];
}

const KEY_RE = /^[A-Za-z0-9+/]{21}[AQgw]==$/;
const hasToken = (header: string | string[] | undefined, token: string) =>
  String(header ?? "")
    .toLowerCase()
    .split(",")
    .some((t) => t.trim() === token);

/** Writes a plain HTTP error on a socket that was going to be upgraded, then closes it. */
export function rejectUpgrade(socket: Duplex, status: number, text: string, extra: string[] = []): void {
  socket.end([`HTTP/1.1 ${status} ${text}`, "Connection: close", "Content-Type: text/plain", ...extra, "", `${text}\n`].join("\r\n"));
}

/**
 * Completes the server handshake for an HTTP `upgrade` event, after checking the method, HTTP version, `Upgrade`,
 * `Connection`, `Sec-WebSocket-Version: 13`, the key format and the Origin. Answers 400/403/426 and returns
 * undefined for a request that does not pass.
 */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, o: UpgradeOptions = {}): ServerWebSocket | undefined {
  const key = req.headers["sec-websocket-key"];
  const ok =
    req.method === "GET" &&
    req.httpVersion === "1.1" &&
    hasToken(req.headers.upgrade, "websocket") &&
    hasToken(req.headers.connection, "upgrade") &&
    typeof key === "string" &&
    KEY_RE.test(key);
  if (!ok) {
    rejectUpgrade(socket, 400, "Bad Request");
    return undefined;
  }
  if (req.headers["sec-websocket-version"] !== "13") {
    rejectUpgrade(socket, 426, "Upgrade Required", ["Sec-WebSocket-Version: 13"]);
    return undefined;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !(o.allowOrigins ?? []).includes(origin)) {
    rejectUpgrade(socket, 403, "Forbidden");
    return undefined;
  }
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${acceptKey(key as string)}`, "", ""].join("\r\n"));
  return new ServerWebSocket(socket, o, head);
}

export interface ServeOptions extends UpgradeOptions {
  /** Simultaneous WebSocket connections (default 32); more get 503. */
  maxConnections?: number;
  /** Return false to answer 404 (e.g. a wrong path token). */
  authorize?: (req: IncomingMessage) => boolean;
  /** Called for each rejected upgrade with the HTTP status sent. */
  onReject?: (req: IncomingMessage, status: number) => void;
}

/**
 * Accepts WebSocket upgrades on `server` with a connection cap, an optional authorization check and the Origin
 * check, calling `onConnection` for each accepted socket. Returns the live sockets so the caller can destroy them on
 * shutdown.
 */
export function serveWebSockets(server: Server, o: ServeOptions, onConnection: (ws: ServerWebSocket, req: IncomingMessage) => void): Set<Duplex> {
  const sockets = new Set<Duplex>();
  let active = 0;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    if (o.authorize && !o.authorize(req)) {
      o.onReject?.(req, 404);
      return rejectUpgrade(socket, 404, "Not Found");
    }
    if (active >= (o.maxConnections ?? MAX_WS_CONNECTIONS)) {
      o.onReject?.(req, 503);
      return rejectUpgrade(socket, 503, "Service Unavailable");
    }
    const ws = acceptUpgrade(req, socket, head, o);
    if (!ws) return o.onReject?.(req, 400);
    active++;
    ws.once("close", () => active--);
    onConnection(ws, req);
  });
  return sockets;
}

export interface ConnectOptions extends ConnectionOptions {
  /** Handshake timeout in ms. */
  timeoutMs: number;
}

/** Why a client connection failed: nothing answered in time, a network error, or a non-WebSocket answer. */
export class WebSocketConnectError extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "network" | "handshake",
  ) {
    super(message);
  }
}

/**
 * Opens a client WebSocket (`ws://` or `wss://`) with a handshake timeout and the same limits as the server side
 * (message cap before buffering, backpressure, idle and close timeouts).
 */
export function connectWebSocket(url: string, o: ConnectOptions): Promise<WebSocketConnection> {
  const u = new URL(url);
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return Promise.reject(new WebSocketConnectError(`not a ws:// or wss:// URL`, "handshake"));
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  const key = randomBytes(16).toString("base64");
  const request = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error, ws?: WebSocketConnection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(ws!);
    };
    const req = request(u, {
      method: "GET",
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" },
    });
    const timer = setTimeout(() => {
      done(new WebSocketConnectError(`no WebSocket handshake within ${Math.round(o.timeoutMs / 1000)}s`, "timeout"));
      req.destroy();
    }, o.timeoutMs);
    req.on("error", (e) => done(new WebSocketConnectError(e.message, "network")));
    req.on("response", (res) => {
      res.resume();
      done(new WebSocketConnectError(`the server answered HTTP ${res.statusCode} instead of switching protocols`, "handshake"));
      req.destroy();
    });
    req.on("upgrade", (res, socket, head) => {
      const accept = res.headers["sec-websocket-accept"];
      if (!hasToken(res.headers.upgrade, "websocket") || accept !== acceptKey(key) || res.headers["sec-websocket-extensions"]) {
        socket.destroy();
        return done(new WebSocketConnectError("invalid WebSocket handshake answer", "handshake"));
      }
      done(undefined, new WebSocketConnection(socket, "client", o, head));
    });
    req.end();
  });
}
