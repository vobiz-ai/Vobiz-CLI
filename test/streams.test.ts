import { afterEach, describe, expect, it } from "vitest";
import { startServer, type LocalServer } from "../src/agent/http.js";
import { FrameParser, OPCODE, acceptKey, acceptUpgrade, encodeFrame, type ServerWebSocket } from "../src/agent/websocket.js";
import { checkAppMessage, startForwarder } from "../src/commands/streams.js";
import { makeCtx, runCli } from "./helpers.js";

type Msg = Record<string, any>;
interface Agent {
  url: string;
  port: number;
  received: Msg[];
  closes: number[];
  close(): Promise<void>;
}

const servers: LocalServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** A local stream server: `onMessage` reacts to each JSON frame Vobiz (the CLI) sends. */
async function agent(onMessage: (ws: ServerWebSocket, msg: Msg) => void = () => {}): Promise<Agent> {
  const received: Msg[] = [];
  const closes: number[] = [];
  const sockets: import("node:stream").Duplex[] = [];
  const server = await startServer((_q, res) => void res.end("no"), { port: 0, host: "127.0.0.1" });
  server.server.on("upgrade", (req, socket, head) => {
    sockets.push(socket);
    const ws = acceptUpgrade(req, socket, head);
    if (!ws) return;
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString("utf8"));
      received.push(msg);
      onMessage(ws, msg);
    });
    ws.on("close", (code: number) => closes.push(code));
  });
  const close = async () => {
    for (const s of sockets) s.destroy();
    await server.close();
  };
  servers.push({ ...server, close });
  return { url: `ws://127.0.0.1:${server.port}/media`, port: server.port, received, closes, close };
}

const MULAW_20MS = Buffer.alloc(160, 0xff).toString("base64");
const test = (url: string, ...extra: string[]) =>
  runCli(["streams", "test", url, "--allow-insecure-url", "--seconds", "0.1", "--linger", "0.3", "--stream-id", "S1", "--call-id", "C1", "--json", ...extra]);

describe("RFC 6455 codec", () => {
  it("computes the handshake accept key (RFC 6455 example)", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("round-trips masked and unmasked frames of every length class, split across chunks", () => {
    for (const len of [0, 5, 125, 126, 300, 65535, 70000]) {
      const payload = Buffer.alloc(len, 7);
      for (const mask of [false, true]) {
        const bytes = encodeFrame(OPCODE.binary, payload, { mask });
        const p = new FrameParser();
        const mid = Math.floor(bytes.length / 2);
        const frames = [...p.push(bytes.subarray(0, mid)), ...p.push(bytes.subarray(mid))];
        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({ fin: true, opcode: OPCODE.binary });
        expect(frames[0].payload.equals(payload)).toBe(true);
      }
    }
  });

  it("rejects unmasked client frames and oversized control frames", () => {
    expect(() => new FrameParser({ requireMask: true }).push(encodeFrame(OPCODE.text, "x"))).toThrow(/not masked/);
    expect(() => new FrameParser().push(encodeFrame(OPCODE.ping, Buffer.alloc(126)))).toThrow(/control/);
  });
});

describe("checkAppMessage", () => {
  it("accepts the documented commands", () => {
    for (const m of [
      { event: "playAudio", streamId: "S1", media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: MULAW_20MS } },
      { event: "playAudio", streamId: "S1", media: { contentType: "audio/x-l16", sampleRate: 24000, payload: Buffer.alloc(960).toString("base64") } },
      { event: "checkpoint", streamId: "S1", name: "greet" },
      { event: "clearAudio", streamId: "S1" },
      { event: "stop", streamId: "S1" },
    ])
      expect(checkAppMessage(JSON.stringify(m), "S1"), m.event).toMatchObject({ errors: [], warnings: [] });
  });

  it("reports wrong shapes, formats and containers", () => {
    expect(checkAppMessage("hello", "S1").errors[0]).toContain("not JSON");
    expect(checkAppMessage('{"event":"hello"}', "S1").errors[0]).toContain('unknown event "hello"');
    expect(checkAppMessage('{"event":"clearAudio","streamId":"S2"}', "S1").errors[0]).toContain("does not match");
    expect(checkAppMessage('{"event":"checkpoint","streamId":"S1"}', "S1").errors[0]).toContain('"name" is required');
    const mulaw16k = checkAppMessage(JSON.stringify({ event: "playAudio", streamId: "S1", media: { contentType: "audio/x-mulaw", sampleRate: 16000, payload: MULAW_20MS } }), "S1");
    expect(mulaw16k.errors[0]).toContain("sampleRate 16000 is not supported for audio/x-mulaw");
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(44)]).toString("base64");
    expect(checkAppMessage(JSON.stringify({ event: "playAudio", streamId: "S1", media: { contentType: "audio/x-l16", sampleRate: 8000, payload: wav } }), "S1").warnings[0]).toContain("WAV header");
    expect(checkAppMessage(JSON.stringify({ event: "playAudio", streamId: "S1", media: { contentType: "audio/x-l16", sampleRate: 8000, payload: "@@" } }), "S1").errors[0]).toContain("base64");
  });
});

describe("vobiz streams test", () => {
  it("sends the documented start and media frames, acks checkpoints, and passes a well-behaved server", async () => {
    const a = await agent((ws, msg) => {
      if (msg.event === "start") {
        ws.send(JSON.stringify({ event: "playAudio", streamId: msg.start.streamId, media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: MULAW_20MS } }));
        ws.send(JSON.stringify({ event: "checkpoint", streamId: msg.start.streamId, name: "greet" }));
      }
    });
    const r = await test(a.url);
    expect(r.code, r.err).toBe(0);
    const report = r.json();
    expect(report).toMatchObject({
      ok: true,
      target: `ws://127.0.0.1:${a.port}/…`,
      media_format: "audio/x-mulaw;rate=8000",
      sent: { start: 1, media: 5, playedStream: 1, clearedAudio: 0 },
      events: { playAudio: 1, checkpoint: 1 },
      play_audio_bytes: 160,
      closed_by: "cli",
      errors: [],
    });
    expect(a.received[0]).toEqual({
      sequenceNumber: 0,
      event: "start",
      start: { callId: "C1", streamId: "S1", accountId: "0", tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000 } },
      extra_headers: "{}",
    });
    const media = a.received.filter((m) => m.event === "media");
    expect(media.map((m) => m.sequenceNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(media.map((m) => m.media.chunk)).toEqual([1, 2, 3, 4, 5]);
    expect(media[0]).toMatchObject({ streamId: "S1", media: { track: "inbound", payload: MULAW_20MS }, extra_headers: "{}" });
    expect(typeof media[0].media.timestamp).toBe("string");
    expect(a.received).toContainEqual({ event: "playedStream", name: "greet" });
    expect(a.received.some((m) => m.event === "stop")).toBe(false);
    await new Promise((res) => setTimeout(res, 50));
    expect(a.closes).toEqual([1000]);
  });

  it("sends L16 16 kHz frames of 640 bytes and acks clearAudio", async () => {
    const a = await agent((ws, msg) => {
      if (msg.event === "start") ws.send(JSON.stringify({ event: "clearAudio", streamId: "S1" }));
    });
    const r = await test(a.url, "--codec", "l16", "--sample-rate", "16000");
    expect(r.code).toBe(0);
    const media = a.received.find((m) => m.event === "media");
    expect(Buffer.from(media.media.payload, "base64")).toEqual(Buffer.alloc(640));
    expect(a.received).toContainEqual({ event: "clearedAudio", streamId: "S1" });
    expect(r.json().sent.clearedAudio).toBe(1);
  });

  it("fails with exit 1 on protocol errors", async () => {
    const a = await agent((ws, msg) => {
      if (msg.event === "start") {
        ws.send(JSON.stringify({ event: "playAudio", media: { contentType: "audio/wav", sampleRate: 44100, payload: MULAW_20MS } }));
        ws.send(JSON.stringify({ event: "hello" }));
        ws.send("not json");
      }
    });
    const r = await test(a.url);
    expect(r.code).toBe(1);
    const report = r.json();
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('playAudio: "streamId" is required'),
        expect.stringContaining("media.contentType must be audio/x-l16 or audio/x-mulaw"),
        expect.stringContaining('unknown event "hello"'),
        expect.stringContaining("not JSON"),
      ]),
    );
    expect(r.err).toContain("FAIL");
  });

  it("handles a server-initiated stop like Vobiz (closes at once)", async () => {
    const a = await agent((ws, msg) => {
      if (msg.event === "media" && msg.sequenceNumber === 2) ws.send(JSON.stringify({ event: "stop", streamId: "S1" }));
    });
    const r = await test(a.url, "--seconds", "1");
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ ok: true, stop_received: true, closed_by: "cli" });
    expect(r.json().sent.media).toBeLessThan(50);
  });

  it("flags an echo server and an early abnormal close", async () => {
    let a = await agent((ws, msg) => ws.send(JSON.stringify(msg)));
    let r = await test(a.url);
    expect(r.code).toBe(0);
    expect(r.json().echoed_frames).toBeGreaterThan(0);
    expect(r.json().warnings.join()).toContain("echo server");

    a = await agent((ws, msg) => {
      if (msg.event === "start") ws.close(1011, "boom");
    });
    r = await test(a.url, "--seconds", "1");
    expect(r.code).toBe(1);
    expect(r.json()).toMatchObject({ closed_by: "server", close_code: 1011 });
    expect(r.json().errors[0]).toContain("without sending stop");
  });

  it("exits 8 when nothing listens, 2 on bad input, and --dry-run connects nowhere", async () => {
    const a = await agent();
    const url = a.url;
    await a.close();
    servers.length = 0;
    let r = await test(url);
    expect(r.code).toBe(8);

    expect((await runCli(["streams", "test", "ws://127.0.0.1:1/x"])).code).toBe(2);
    expect((await runCli(["streams", "test", "https://example.com"])).code).toBe(2);
    expect((await runCli(["streams", "test", "wss://example.com/m", "--sample-rate", "16000"])).code).toBe(2);

    r = await runCli(["streams", "test", "wss://agent.example.com/secret-path", "--dry-run", "--json", "--stream-id", "S1", "--seconds", "2"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ dry_run: true, target: "wss://agent.example.com/…", media_frames: 100, start: { event: "start", start: { streamId: "S1" } } });
    expect(r.out).not.toContain("secret-path");
  });
});

describe("vobiz streams forward", () => {
  it("relays both ways and logs frame summaries without audio bytes", async () => {
    const a = await agent((ws, msg) => {
      if (msg.event === "start") ws.send(JSON.stringify({ event: "playAudio", streamId: msg.start.streamId, media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: MULAW_20MS } }));
    });
    const t = makeCtx();
    const fwd = await startForwarder(t.ctx, { to: a.url, port: 0, host: "127.0.0.1" });
    servers.push(fwd);
    const client = new WebSocket(`${fwd.url}/from-vobiz`);
    const got: Msg[] = [];
    await new Promise<void>((res, rej) => {
      client.addEventListener("open", () => res());
      client.addEventListener("error", () => rej(new Error("no connect")));
    });
    const playAudio = new Promise<void>((res) =>
      client.addEventListener("message", (ev) => {
        got.push(JSON.parse(String(ev.data)));
        res();
      }),
    );
    client.send(JSON.stringify({ sequenceNumber: 0, event: "start", start: { callId: "C1", streamId: "S1", tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000 } }, extra_headers: "{}" }));
    for (let i = 1; i <= 3; i++) client.send(JSON.stringify({ sequenceNumber: i, streamId: "S1", event: "media", media: { track: "inbound", timestamp: "0", chunk: i, payload: MULAW_20MS } }));
    await playAudio;
    expect(got[0]).toMatchObject({ event: "playAudio", streamId: "S1" });
    client.close(1000);
    await new Promise((res) => setTimeout(res, 150));
    expect(a.received.map((m) => m.event)).toEqual(["start", "media", "media", "media"]);
    expect(a.closes).toEqual([1000]);
    const log = t.stderr.text;
    expect(log).toContain("→ app start callId=C1 streamId=S1 tracks=inbound format=audio/x-mulaw@8000");
    expect(log).toContain("← app playAudio audio/x-mulaw@8000 160B");
    expect(log).toContain("→ app media ×3 inbound 480B");
    expect(log).toContain("Vobiz side closed (1000)");
    expect(log).not.toContain(MULAW_20MS);
  });

  it("validates --to and supports --dry-run", async () => {
    expect((await runCli(["streams", "forward", "--to", "http://localhost:1"])).code).toBe(2);
    const r = await runCli(["streams", "forward", "--to", "ws://localhost:8080/media", "--port", "0", "--dry-run", "--json"]);
    expect(r.json()).toEqual({ dry_run: true, listen: "ws://127.0.0.1:0", forward_to: "ws://localhost:8080/…" });
  });
});
