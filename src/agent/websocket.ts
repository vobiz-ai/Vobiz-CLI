/**
 * Minimal RFC 6455 server side for `vobiz streams forward` and the streams tests: the HTTP Upgrade handshake, a
 * frame codec (text, binary, continuation, close, ping, pong; 7/16/64-bit lengths; masking) and a small connection
 * object. The client side uses Node's built-in `WebSocket`. No extensions (permessage-deflate is declined by not
 * echoing it), no subprotocol negotiation beyond echoing nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;
/** Largest message the server side accepts (Vobiz media frames are a few KB). */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export const acceptKey = (key: string): string => createHash("sha1").update(key + GUID).digest("base64");

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
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

/** Incremental decoder: push bytes, get complete frames (unmasked). Throws on a protocol violation. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly o: { requireMask?: boolean; maxPayload?: number } = {}) {}

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Frame[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      if (b0 & 0x70) throw new Error("reserved bits set (no extension was negotiated)");
      const masked = !!(b1 & 0x80);
      if (this.o.requireMask && !masked) throw new Error("client frame is not masked");
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.o.maxPayload ?? MAX_MESSAGE_BYTES)) throw new Error("frame too large");
        len = Number(big);
        off = 10;
      }
      if (len > (this.o.maxPayload ?? MAX_MESSAGE_BYTES)) throw new Error("frame too large");
      const keyOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) break;
      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        const key = this.buf.subarray(keyOff, keyOff + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
        payload = out;
      } else payload = Buffer.from(payload);
      const opcode = b0 & 0x0f;
      const fin = !!(b0 & 0x80);
      if (opcode >= 0x8 && (!fin || len > 125)) throw new Error("invalid control frame");
      frames.push({ fin, opcode, payload });
      this.buf = this.buf.subarray(off + len);
    }
    return frames;
  }
}

/**
 * The server end of one WebSocket connection.
 *   events: "message" (data: Buffer, isBinary: boolean), "close" (code: number, reason: string), "error" (Error)
 */
export class ServerWebSocket extends EventEmitter {
  private readonly parser = new FrameParser({ requireMask: true });
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closed = false;
  private closeSent = false;

  constructor(private readonly socket: Duplex) {
    super();
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err) => this.emit("error", err));
    socket.on("close", () => this.finish(1006, ""));
  }

  get isOpen(): boolean {
    return !this.closed && !this.closeSent;
  }

  send(data: string | Uint8Array): void {
    if (!this.isOpen) return;
    const isText = typeof data === "string";
    this.socket.write(encodeFrame(isText ? OPCODE.text : OPCODE.binary, isText ? data : Buffer.from(data)));
  }

  /** Sends a close frame (codes 1005/1006/1015 are never sent on the wire) and ends the socket. */
  close(code = 1000, reason = ""): void {
    if (this.closed || this.closeSent) return;
    this.closeSent = true;
    const wire = code === 1005 || code === 1006 || code === 1015 || code < 1000 || code > 4999 ? 1000 : code;
    const r = Buffer.from(reason.slice(0, 120), "utf8");
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(wire, 0);
    r.copy(body, 2);
    this.socket.write(encodeFrame(OPCODE.close, body));
    this.socket.end();
    this.finish(code, reason);
  }

  /** Drops the connection without a close frame. */
  terminate(): void {
    this.socket.destroy();
    this.finish(1006, "");
  }

  private finish(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, reason);
  }

  private onData(chunk: Buffer) {
    let frames: Frame[];
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      this.emit("error", err as Error);
      this.close(1002, (err as Error).message);
      return;
    }
    for (const f of frames) {
      if (f.opcode === OPCODE.ping) {
        if (this.isOpen) this.socket.write(encodeFrame(OPCODE.pong, f.payload));
      } else if (f.opcode === OPCODE.pong) {
        // ignore
      } else if (f.opcode === OPCODE.close) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        const reason = f.payload.length > 2 ? f.payload.subarray(2).toString("utf8") : "";
        if (!this.closeSent) {
          this.closeSent = true;
          const echo = Buffer.alloc(f.payload.length >= 2 ? 2 : 0);
          if (echo.length) echo.writeUInt16BE(code, 0);
          this.socket.write(encodeFrame(OPCODE.close, echo));
          this.socket.end();
        }
        this.finish(code, reason);
        return;
      } else if (f.opcode === OPCODE.continuation) {
        if (!this.fragmentOpcode) return this.protocolError("unexpected continuation frame");
        this.fragments.push(f.payload);
        if (f.fin) this.deliver(this.fragmentOpcode, Buffer.concat(this.fragments));
      } else if (f.opcode === OPCODE.text || f.opcode === OPCODE.binary) {
        if (this.fragmentOpcode) return this.protocolError("new message before the previous one finished");
        if (f.fin) this.deliver(f.opcode, f.payload);
        else {
          this.fragmentOpcode = f.opcode;
          this.fragments = [f.payload];
        }
      } else return this.protocolError(`unknown opcode ${f.opcode}`);
    }
  }

  private deliver(opcode: number, data: Buffer) {
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.emit("message", data, opcode === OPCODE.binary);
  }

  private protocolError(message: string) {
    this.emit("error", new Error(message));
    this.close(1002, message);
  }
}

/**
 * Completes the server handshake for an HTTP `upgrade` event. Answers 400 and returns undefined for a request that
 * is not a valid WebSocket upgrade.
 */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): ServerWebSocket | undefined {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  if (req.method !== "GET" || upgrade !== "websocket" || typeof key !== "string" || Buffer.from(key, "base64").length !== 16) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nExpected a WebSocket upgrade.\n");
    return undefined;
  }
  socket.write(
    ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${acceptKey(key)}`, "", ""].join("\r\n"),
  );
  if (head.length) socket.unshift(head);
  return new ServerWebSocket(socket);
}
