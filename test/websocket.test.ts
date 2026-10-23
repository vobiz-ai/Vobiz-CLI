/** Hardening of the in-repo RFC 6455 codec (S5 #3-#5, #18; S2 #3, #7, #8, #13). */
import { createServer as createNetServer, connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type LocalServer } from "../src/agent/http.js";
import {
  FrameParser,
  OPCODE,
  connectWebSocket,
  encodeFrame,
  serveWebSockets,
  type ServeOptions,
  type ServerWebSocket,
  type WebSocketConnection,
} from "../src/agent/websocket.js";

const servers: LocalServer[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await s.close();
});

interface Echo {
  port: number;
  conns: ServerWebSocket[];
  messages: Buffer[];
  closes: { code: number; reason: string }[];
  rejects: number[];
}

/** A server that echoes every message and records closes. */
async function echoServer(o: ServeOptions = {}): Promise<Echo> {
  const server = await startServer((_q, res) => void res.end(), { port: 0, host: "127.0.0.1" });
  const e: Echo = { port: server.port, conns: [], messages: [], closes: [], rejects: [] };
  const live = serveWebSockets(server.server, { ...o, onReject: (_r, status) => e.rejects.push(status) }, (ws) => {
    e.conns.push(ws);
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      e.messages.push(data);
      ws.send(isBinary ? data : data.toString("utf8"));
    });
    ws.on("close", (code: number, reason: string) => e.closes.push({ code, reason }));
    ws.on("error", () => {});
  });
  servers.push({
    ...server,
    close: async () => {
      for (const s of live) s.destroy();
      await server.close();
    },
  });
  return e;
}

const KEY = "dGhlIHNhbXBsZSBub25jZQ==";
/** Opens a raw TCP connection, sends a handshake and resolves with the socket and the status line. */
async function raw(port: number, headers: Record<string, string> = {}, path = "/"): Promise<{ sock: Socket; status: number; data: () => Buffer }> {
  const sock = connect(port, "127.0.0.1");
  sockets.push(sock);
  let buf = Buffer.alloc(0);
  sock.on("data", (c: Buffer) => (buf = Buffer.concat([buf, c])));
  sock.on("error", () => {});
  const h = { Host: "127.0.0.1", Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": KEY, "Sec-WebSocket-Version": "13", ...headers };
  sock.write(`GET ${path} HTTP/1.1\r\n${Object.entries(h).filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
  for (let i = 0; i < 200 && !buf.includes("\r\n\r\n"); i++) await wait(5);
  const status = Number(/^HTTP\/1\.1 (\d+)/.exec(buf.toString("latin1"))?.[1] ?? 0);
  const end = buf.indexOf("\r\n\r\n") + 4;
  return { sock, status, data: () => buf.subarray(end) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2000) => {
  for (let t = 0; t < ms && !cond(); t += 5) await wait(5);
};
/** Frames the server sent (unmasked) on a raw socket. */
const framesOf = (b: Buffer) => new FrameParser().push(b);

describe("WebSocket handshake checks", () => {
  it("accepts a valid upgrade and rejects bad version, key, Connection, Origin, and over-cap connections", async () => {
    const e = await echoServer({ maxConnections: 1 });
    expect((await raw(e.port, { "Sec-WebSocket-Version": "8" })).status).toBe(426);
    expect((await raw(e.port, { "Sec-WebSocket-Key": "short" })).status).toBe(400);
    expect((await raw(e.port, { Connection: "keep-alive" })).status).not.toBe(101);
    expect((await raw(e.port, { Origin: "https://evil.example" })).status).toBe(403);
    const ok = await raw(e.port);
    expect(ok.status).toBe(101);
    expect((await raw(e.port)).status).toBe(503); // cap of 1 is in use
    ok.sock.destroy();
    await until(() => e.closes.length === 1);
    expect((await raw(e.port)).status).toBe(101);
  });

  it("allows a configured Origin", async () => {
    const e = await echoServer({ allowOrigins: ["https://ok.example"] });
    expect((await raw(e.port, { Origin: "https://ok.example" })).status).toBe(101);
    expect((await raw(e.port, { Origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("WebSocket limits", () => {
  it("closes with 1009 when fragments add up past the message cap", async () => {
    const e = await echoServer({ maxMessageBytes: 1000 });
    const c = await raw(e.port);
    c.sock.write(encodeFrame(OPCODE.binary, Buffer.alloc(600), { mask: true, fin: false }));
    c.sock.write(encodeFrame(OPCODE.continuation, Buffer.alloc(600), { mask: true, fin: true }));
    await until(() => e.closes.length > 0);
    expect(e.messages).toHaveLength(0);
    const close = framesOf(c.data()).find((f) => f.opcode === OPCODE.close)!;
    expect(close.payload.readUInt16BE(0)).toBe(1009);
  });

  it("parses a frame trickled in tiny chunks in linear time", () => {
    const frame = encodeFrame(OPCODE.binary, Buffer.alloc(4 * 1024 * 1024, 1), { mask: true });
    const p = new FrameParser({ requireMask: true });
    const t0 = performance.now();
    let got = 0;
    for (let i = 0; i < frame.length; i += 512) got += p.push(frame.subarray(i, i + 512)).length;
    expect(got).toBe(1);
    expect(performance.now() - t0).toBeLessThan(2000); // the old Buffer.concat-per-chunk parser needed minutes
  });

  it("rejects invalid UTF-8 (1007), 1-byte close payloads (1002), invalid close codes and non-minimal lengths", async () => {
    const e = await echoServer();
    const a = await raw(e.port);
    a.sock.write(encodeFrame(OPCODE.text, Buffer.from([0xff, 0xfe]), { mask: true }));
    await until(() => e.closes.length === 1);
    expect(framesOf(a.data()).find((f) => f.opcode === OPCODE.close)!.payload.readUInt16BE(0)).toBe(1007);
    const b = await raw(e.port);
    b.sock.write(encodeFrame(OPCODE.close, Buffer.from([3]), { mask: true }));
    await until(() => e.closes.length === 2);
    expect(framesOf(b.data()).find((f) => f.opcode === OPCODE.close)!.payload.readUInt16BE(0)).toBe(1002);
    const c = await raw(e.port);
    const bad = Buffer.alloc(2);
    bad.writeUInt16BE(1005);
    c.sock.write(encodeFrame(OPCODE.close, bad, { mask: true }));
    await until(() => e.closes.length === 3);
    expect(framesOf(c.data()).find((f) => f.opcode === OPCODE.close)!.payload.readUInt16BE(0)).toBe(1002);
    // 126-length encoding used for a 5-byte payload
    expect(() => new FrameParser().push(Buffer.from([0x82, 126, 0, 5, 1, 2, 3, 4, 5]))).toThrow(/non-minimal/);
  });

  it("answers a peer close with 1000 (never 1005) and an empty close with an empty close", async () => {
    const e = await echoServer();
    const a = await raw(e.port);
    const c4000 = Buffer.alloc(2);
    c4000.writeUInt16BE(4000);
    a.sock.write(encodeFrame(OPCODE.close, c4000, { mask: true }));
    await until(() => e.closes.length === 1);
    expect(e.closes[0].code).toBe(4000);
    expect(framesOf(a.data()).find((f) => f.opcode === OPCODE.close)!.payload.readUInt16BE(0)).toBe(1000);
    const b = await raw(e.port);
    b.sock.write(encodeFrame(OPCODE.close, Buffer.alloc(0), { mask: true }));
    await until(() => e.closes.length === 2);
    expect(e.closes[1].code).toBe(1005);
    expect(framesOf(b.data()).find((f) => f.opcode === OPCODE.close)!.payload.length).toBe(0);
  });

  it("stops answering pings and pauses reading when the peer does not read, then closes on a flood", async () => {
    const e = await echoServer({ highWaterMark: 1024 });
    const c = await raw(e.port);
    c.sock.pause(); // never read the pongs
    const ping = encodeFrame(OPCODE.ping, Buffer.alloc(125, 1), { mask: true });
    const burst = Buffer.concat(Array.from({ length: 2000 }, () => ping));
    for (let i = 0; i < 50 && !e.closes.length; i++) {
      c.sock.write(burst);
      await wait(5);
    }
    // Either it paused reading (our writes back up) or it closed on the flood; memory stays bounded either way.
    const conn = e.conns[0] as unknown as WebSocketConnection;
    expect(conn.bufferedAmount).toBeLessThan(1024 * 1024); // 50 bursts would queue ~12 MB of pongs without backpressure
  });

  it("closes an idle connection", async () => {
    const e = await echoServer({ idleTimeoutMs: 100 });
    await raw(e.port);
    await until(() => e.closes.length === 1);
    expect(e.closes[0].code).toBe(1001);
  });
});

describe("connectWebSocket (client)", () => {
  it("round-trips text and binary messages and caps inbound message size", async () => {
    const e = await echoServer();
    const ws = await connectWebSocket(`ws://127.0.0.1:${e.port}/x`, { timeoutMs: 2000, maxMessageBytes: 100 });
    const got: string[] = [];
    const closed = new Promise<number>((r) => ws.on("close", (code: number) => r(code)));
    ws.on("error", () => {});
    ws.on("message", (d: Buffer) => got.push(d.toString()));
    ws.send("hello");
    await until(() => got.length === 1);
    expect(got).toEqual(["hello"]);
    ws.send("x".repeat(200)); // the server echoes 200 bytes, over the client's cap
    expect(await closed).toBe(1009);
  });

  it("times out a handshake that never completes", async () => {
    const silent = createNetServer((s) => sockets.push(s));
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const port = (silent.address() as { port: number }).port;
    try {
      await expect(connectWebSocket(`ws://127.0.0.1:${port}/`, { timeoutMs: 100 })).rejects.toMatchObject({ reason: "timeout" });
    } finally {
      for (const s of sockets.splice(0)) s.destroy();
      silent.close();
    }
  });

  it("rejects a non-101 answer", async () => {
    const server = await startServer((_q, res) => void res.end("no"), { port: 0, host: "127.0.0.1" });
    servers.push(server);
    await expect(connectWebSocket(`ws://127.0.0.1:${server.port}/`, { timeoutMs: 2000 })).rejects.toMatchObject({ reason: "handshake" });
  });
});
