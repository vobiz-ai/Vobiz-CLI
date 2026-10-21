/**
 * `vobiz streams test|forward`: develop and debug the WebSocket server behind a VobizXML `<Stream>` (or
 * `vobiz calls stream start`) without placing a call.
 *
 *   test     plays the Vobiz side against your server: the documented `start` frame, then 20 ms `media` frames of
 *            silence, then closes the socket the way Vobiz does when a call ends (Vobiz sends no inbound `stop`).
 *            It answers `checkpoint` with `playedStream` and `clearAudio` with `clearedAudio`, validates every
 *            command your server sends (playAudio, checkpoint, clearAudio, stop) against the documented shapes,
 *            and exits 1 on any protocol error.
 *   forward  a local proxy: Vobiz (through your tunnel) connects to it and it relays both ways to your server,
 *            logging a one-line summary of each frame to stderr (never audio bytes).
 *
 * Frame shapes: https://www.vobiz.ai/docs/xml/stream/stream-events and /xml/stream/audio-formats.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Option, type Command } from "commander";
import type { Ctx } from "../core/context.js";
import { VobizError, usage } from "../core/errors.js";
import { parsePort, startServer, untilInterrupted, type LocalServer } from "../agent/http.js";
import { acceptUpgrade } from "../agent/websocket.js";
import { checkUrl, isRec, secondsArg, sleep, type Rec } from "./voice-shared.js";

export const STREAM_DOCS = "https://www.vobiz.ai/docs/xml/stream/stream-events";
const ENCODINGS = { mulaw: "audio/x-mulaw", l16: "audio/x-l16" } as const;
type Codec = keyof typeof ENCODINGS;
/** Outbound (playAudio) formats the docs accept. Inbound is narrower: L16 8k/16k and μ-law 8k. */
const PLAY_RATES: Record<string, number[]> = { "audio/x-l16": [8000, 16000, 24000], "audio/x-mulaw": [8000] };
const APP_EVENTS = new Set(["playAudio", "checkpoint", "clearAudio", "stop"]);

// ── Frame builders (Vobiz → app) ──

export function startFrame(o: { callId: string; streamId: string; accountId: string; codec: Codec; sampleRate: number }): Rec {
  return {
    sequenceNumber: 0,
    event: "start",
    start: {
      callId: o.callId,
      streamId: o.streamId,
      accountId: o.accountId,
      tracks: ["inbound"],
      mediaFormat: { encoding: ENCODINGS[o.codec], sampleRate: o.sampleRate },
    },
    extra_headers: "{}",
  };
}

/** Bytes of raw audio in one 20 ms frame (μ-law 1 byte/sample, L16 2 bytes/sample). */
export const frameBytes = (codec: Codec, sampleRate: number): number => (sampleRate / 50) * (codec === "l16" ? 2 : 1);

/** 20 ms of silence: 0xFF in μ-law, zero samples in L16. */
export function silence(codec: Codec, sampleRate: number): string {
  return Buffer.alloc(frameBytes(codec, sampleRate), codec === "mulaw" ? 0xff : 0).toString("base64");
}

export function mediaFrame(o: { streamId: string; sequenceNumber: number; chunk: number; timestamp: number; payload: string }): Rec {
  return {
    sequenceNumber: o.sequenceNumber,
    streamId: o.streamId,
    event: "media",
    media: { track: "inbound", timestamp: String(o.timestamp), chunk: o.chunk, payload: o.payload },
    extra_headers: "{}",
  };
}

// ── Validation of what the app sends ──

export interface Check {
  event?: string;
  errors: string[];
  warnings: string[];
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Checks one message from the app against the documented command shapes. */
export function checkAppMessage(text: string, streamId: string): Check {
  const errors: string[] = [];
  const warnings: string[] = [];
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return { errors: [`not JSON: ${JSON.stringify(text.slice(0, 60))}`], warnings };
  }
  if (!isRec(msg) || typeof msg.event !== "string") return { errors: ['a JSON object with an "event" string is required'], warnings };
  const event = msg.event;
  if (event === "media" || event === "start") return { event, errors, warnings };
  if (!APP_EVENTS.has(event)) return { event, errors: [`unknown event "${event}" (Vobiz accepts playAudio, checkpoint, clearAudio and stop)`], warnings };
  if (typeof msg.streamId !== "string" || !msg.streamId) errors.push(`${event}: "streamId" is required (use start.streamId)`);
  else if (msg.streamId !== streamId) errors.push(`${event}: streamId ${msg.streamId} does not match the stream's ${streamId}`);
  if (event === "checkpoint" && (typeof msg.name !== "string" || !msg.name)) errors.push('checkpoint: "name" is required');
  if (event === "playAudio") {
    const media = msg.media;
    if (!isRec(media)) errors.push('playAudio: "media" object is required');
    else {
      const ct = media.contentType;
      const rate = media.sampleRate;
      if (typeof ct !== "string" || !PLAY_RATES[ct]) errors.push(`playAudio: media.contentType must be audio/x-l16 or audio/x-mulaw (got ${JSON.stringify(ct)})`);
      else if (typeof rate !== "number" || !PLAY_RATES[ct].includes(rate))
        errors.push(`playAudio: media.sampleRate ${JSON.stringify(rate)} is not supported for ${ct} (use ${PLAY_RATES[ct].join(", ")})`);
      const payload = media.payload;
      if (typeof payload !== "string" || !payload) errors.push("playAudio: media.payload must be a non-empty base64 string");
      else if (payload.length % 4 !== 0 || !BASE64.test(payload)) errors.push("playAudio: media.payload is not valid base64");
      else {
        const raw = Buffer.from(payload, "base64");
        const magic = raw.subarray(0, 4).toString("latin1");
        if (magic === "RIFF") warnings.push("playAudio: payload starts with a WAV header; send raw audio without the file container");
        else if (magic.startsWith("ID3") || (raw[0] === 0xff && (raw[1] & 0xe0) === 0xe0 && ct === "audio/x-l16"))
          warnings.push("playAudio: payload looks like MP3; send raw L16 or μ-law audio");
        if (ct === "audio/x-l16" && raw.length % 2 === 1) warnings.push("playAudio: L16 payload has an odd byte count (samples are 16-bit)");
      }
    }
  }
  return { event, errors, warnings };
}

// ── streams test ──

export interface TestOptions {
  codec: Codec;
  sampleRate: number;
  seconds: number;
  linger: number;
  callId: string;
  streamId: string;
  accountId: string;
}

export interface TestReport {
  ok: boolean;
  target: string;
  media_format: string;
  handshake_ms: number;
  sent: { start: number; media: number; playedStream: number; clearedAudio: number };
  received: number;
  events: Record<string, number>;
  echoed_frames: number;
  play_audio_bytes: number;
  stop_received: boolean;
  closed_by: "cli" | "server";
  close_code?: number;
  close_reason?: string;
  errors: string[];
  warnings: string[];
}

/** Origin plus a masked path: stream URLs often carry a secret in the path. */
export function maskUrl(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname !== "/" || u.search ? "/…" : "/"}`;
}

export async function runStreamTest(ctx: Ctx, url: string, o: TestOptions): Promise<TestReport> {
  const report: TestReport = {
    ok: false,
    target: maskUrl(url),
    media_format: `${ENCODINGS[o.codec]};rate=${o.sampleRate}`,
    handshake_ms: 0,
    sent: { start: 0, media: 0, playedStream: 0, clearedAudio: 0 },
    received: 0,
    events: {},
    echoed_frames: 0,
    play_audio_bytes: 0,
    stop_received: false,
    closed_by: "cli",
    errors: [],
    warnings: [],
  };
  const started = Date.now();
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let closed = false;
  let resolveClosed!: () => void;
  const closedP = new Promise<void>((r) => (resolveClosed = r));

  const opened = await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* not open */
      }
      reject(new VobizError("timeout", `No WebSocket handshake from ${new URL(url).host} within ${ctx.flags.timeout}s.`));
    }, ctx.flags.timeout * 1000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(true);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (!opened) throw new VobizError("network_error", `Could not open a WebSocket to ${new URL(url).host} (connection refused, TLS error or a non-101 answer to the upgrade).`);
  report.handshake_ms = Date.now() - started;
  ctx.log("verbose", `stream test: connected to ${report.target} in ${report.handshake_ms}ms`);

  let seq = 0;
  const send = (frame: Rec) => {
    if (!closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };

  ws.addEventListener("message", (ev: MessageEvent) => {
    report.received++;
    if (typeof ev.data !== "string") {
      report.events.binary = (report.events.binary ?? 0) + 1;
      report.errors.push(`binary frame of ${(ev.data as ArrayBuffer).byteLength} bytes: Vobiz expects JSON text frames`);
      return;
    }
    const check = checkAppMessage(ev.data, o.streamId);
    const name = check.event ?? "invalid";
    report.events[name] = (report.events[name] ?? 0) + 1;
    report.errors.push(...check.errors);
    report.warnings.push(...check.warnings);
    if (name === "media" || name === "start") {
      report.echoed_frames++;
      return;
    }
    if (check.errors.length) return;
    const msg = JSON.parse(ev.data) as Rec;
    if (name === "playAudio" && isRec(msg.media) && typeof msg.media.payload === "string") report.play_audio_bytes += Buffer.from(msg.media.payload, "base64").length;
    if (name === "checkpoint") {
      // Vobiz acks after the queued audio has played; the test acks at once.
      send({ event: "playedStream", name: msg.name });
      report.sent.playedStream++;
    }
    if (name === "clearAudio") {
      send({ event: "clearedAudio", streamId: o.streamId });
      report.sent.clearedAudio++;
    }
    if (name === "stop") {
      report.stop_received = true;
      // Vobiz stops the stream at once and closes the socket.
      closed = true;
      ws.close(1000, "stop received");
    }
  });
  ws.addEventListener("close", (ev: CloseEvent) => {
    if (!closed) report.closed_by = "server";
    closed = true;
    report.close_code = ev.code;
    if (ev.reason) report.close_reason = ev.reason;
    resolveClosed();
  });

  send(startFrame(o));
  report.sent.start = 1;
  seq = 1;
  const frames = Math.max(1, Math.round(o.seconds * 50));
  const payload = silence(o.codec, o.sampleRate);
  const t0 = Date.now();
  for (let chunk = 1; chunk <= frames && !closed; chunk++) {
    send(mediaFrame({ streamId: o.streamId, sequenceNumber: seq++, chunk, timestamp: t0 + (chunk - 1) * 20, payload }));
    report.sent.media++;
    const due = t0 + chunk * 20 - Date.now();
    if (due > 0) await sleep(due);
  }
  if (!closed) await Promise.race([closedP, sleep(o.linger * 1000)]);
  if (!closed) {
    // A call ending: Vobiz closes the socket after the last media frame (there is no inbound stop event).
    closed = true;
    ws.close(1000, "call ended");
  }
  await Promise.race([closedP, sleep(1000)]);

  if (report.closed_by === "server" && !report.stop_received) {
    const code = report.close_code ?? 1006;
    const msg = `the server closed the socket after ${report.sent.media} of ${frames} media frames (code ${code}${report.close_reason ? `, ${report.close_reason}` : ""}) without sending stop`;
    if (code === 1000 || code === 1001) report.warnings.push(msg);
    else report.errors.push(msg);
  }
  if (report.echoed_frames) report.warnings.push(`${report.echoed_frames} frame(s) came back as start/media: an echo server, not a Vobiz stream handler`);
  report.errors = [...new Set(report.errors)];
  report.warnings = [...new Set(report.warnings)];
  report.ok = report.errors.length === 0;
  return report;
}

// ── streams forward ──

interface Tally {
  count: number;
  bytes: number;
}

/** One-line summary of a frame, without audio. `media` frames are reported separately (aggregated). */
export function summarize(data: string | Buffer, isBinary: boolean): { line: string; mediaBytes?: number; track?: string } {
  if (isBinary || typeof data !== "string") return { line: `binary ${(data as Buffer).length}B` };
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return { line: `text ${data.length} chars (not JSON)` };
  }
  if (!isRec(msg)) return { line: "JSON without an event" };
  const ev = String(msg.event ?? "?");
  const media = isRec(msg.media) ? msg.media : undefined;
  const bytes = media && typeof media.payload === "string" ? Buffer.from(media.payload, "base64").length : 0;
  switch (ev) {
    case "start": {
      const s = isRec(msg.start) ? msg.start : {};
      const f = isRec(s.mediaFormat) ? s.mediaFormat : {};
      return { line: `start callId=${String(s.callId ?? "?")} streamId=${String(s.streamId ?? "?")} tracks=${Array.isArray(s.tracks) ? s.tracks.join(",") : "?"} format=${String(f.encoding ?? "?")}@${String(f.sampleRate ?? "?")}` };
    }
    case "media":
      return { line: `media seq=${String(msg.sequenceNumber ?? "?")} chunk=${String(media?.chunk ?? "?")} track=${String(media?.track ?? "?")} ${bytes}B`, mediaBytes: bytes, track: String(media?.track ?? "") };
    case "playAudio":
      return { line: `playAudio ${String(media?.contentType ?? "?")}@${String(media?.sampleRate ?? "?")} ${bytes}B` };
    case "checkpoint":
    case "playedStream":
      return { line: `${ev} name=${String(msg.name ?? "?")}` };
    default:
      return { line: `${ev}${msg.streamId ? ` streamId=${String(msg.streamId)}` : ""}` };
  }
}

export interface ForwardOptions {
  to: string;
  port: number;
  host: string;
  everyMedia?: boolean;
}

export async function startForwarder(ctx: Ctx, o: ForwardOptions): Promise<LocalServer> {
  const sockets = new Set<Duplex>();
  const flushers = new Set<() => void>();
  let next = 0;
  const log = (conn: number, dir: string, line: string) => {
    const t = ctx.now().toISOString().slice(11, 23);
    ctx.stderr.write(`${t} [${conn}] ${dir} ${line}\n`);
  };

  const server = await startServer(
    (_req, res) => {
      res.writeHead(426, { "content-type": "text/plain", upgrade: "websocket" });
      res.end("This is a WebSocket proxy for Vobiz audio streams; connect with ws:// or wss://.\n");
    },
    { port: o.port, host: o.host },
  );

  server.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const down = acceptUpgrade(req, socket, head);
    if (!down) return;
    const conn = ++next;
    log(conn, "**", `connection from ${req.socket.remoteAddress ?? "?"}; opening ${maskUrl(o.to)}`);
    const up = new WebSocket(o.to);
    up.binaryType = "arraybuffer";
    const pending: (string | Buffer)[] = [];
    const tallies: Record<string, Tally> = {};
    const flush = () => {
      for (const [key, t] of Object.entries(tallies)) {
        if (t.count) log(conn, key.slice(0, 1) === ">" ? "→ app" : "← app", `media ×${t.count} ${key.slice(1)} ${t.bytes}B`);
        delete tallies[key];
      }
    };
    const timer = setInterval(flush, 1000);
    flushers.add(flush);
    const record = (dir: ">" | "<", data: string | Buffer, isBinary: boolean) => {
      const s = summarize(data, isBinary);
      if (s.mediaBytes !== undefined && !o.everyMedia) {
        const key = `${dir}${s.track || "media"}`;
        const t = (tallies[key] ??= { count: 0, bytes: 0 });
        t.count++;
        t.bytes += s.mediaBytes;
        return;
      }
      log(conn, dir === ">" ? "→ app" : "← app", s.line);
    };
    const end = () => {
      clearInterval(timer);
      flush();
      flushers.delete(flush);
    };

    down.on("message", (data: Buffer, isBinary: boolean) => {
      const payload = isBinary ? data : data.toString("utf8");
      record(">", payload, isBinary);
      if (up.readyState === WebSocket.OPEN) up.send(typeof payload === "string" ? payload : new Uint8Array(payload));
      else if (up.readyState === WebSocket.CONNECTING) pending.push(payload);
    });
    down.on("close", (code: number, reason: string) => {
      end();
      log(conn, "**", `Vobiz side closed (${code}${reason ? ` ${reason}` : ""})`);
      if (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING) up.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason.slice(0, 120));
    });
    down.on("error", (err: Error) => log(conn, "!!", `Vobiz side: ${err.message}`));

    up.addEventListener("open", () => {
      log(conn, "**", "connected to your server");
      for (const p of pending.splice(0)) up.send(typeof p === "string" ? p : new Uint8Array(p));
    });
    up.addEventListener("message", (ev: MessageEvent) => {
      const isBinary = typeof ev.data !== "string";
      const payload = isBinary ? Buffer.from(ev.data as ArrayBuffer) : (ev.data as string);
      record("<", payload, isBinary);
      down.send(payload);
    });
    up.addEventListener("error", () => log(conn, "!!", `could not reach or lost ${maskUrl(o.to)}`));
    up.addEventListener("close", (ev: CloseEvent) => {
      log(conn, "**", `your server closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`);
      end();
      down.close(ev.code, ev.reason);
    });
  });

  return {
    ...server,
    url: server.url.replace(/^http/, "ws"),
    close: async () => {
      for (const f of [...flushers]) f();
      for (const s of sockets) s.destroy();
      await server.close();
    },
  };
}

// ── Commands ──

const toWs = (raw: string): string => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw usage(`--to is not a valid URL: "${raw}".`);
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") throw usage("--to must be a ws:// or wss:// URL, e.g. ws://localhost:8080/media.");
  return raw;
};

export function register(program: Command, ctx: Ctx): void {
  const streams = program
    .command("streams")
    .description("Test and debug the WebSocket server behind <Stream> audio streams, without placing a call");

  streams
    .command("test")
    .argument("<wss-url>", "your stream server's URL (wss://; ws:// on localhost with --allow-insecure-url)")
    .description("Act as Vobiz against your stream server: send start and media frames, check what it sends back")
    .addOption(new Option("--codec <codec>", "inbound audio encoding").choices(["mulaw", "l16"]).default("mulaw"))
    .addOption(new Option("--sample-rate <hz>", "inbound sample rate (μ-law: 8000; L16: 8000 or 16000)").choices(["8000", "16000"]).default("8000"))
    .option("--seconds <n>", "how much audio to send, in 20 ms frames of silence (default: 3)", secondsArg(300))
    .option("--linger <n>", "seconds to keep listening after the last media frame (default: 1)", secondsArg(60))
    .option("--stream-id <id>", "streamId to put in the start frame (default: a random UUID)")
    .option("--call-id <id>", "callId to put in the start frame (default: a random UUID)")
    .option("--allow-insecure-url", "allow ws:// on localhost")
    .addHelpText(
      "after",
      `
The test sends what Vobiz sends: one "start" frame (callId, streamId, tracks, mediaFormat), then "media" frames
every 20 ms, then closes the socket (Vobiz sends no inbound "stop"; the close is the end-of-stream signal). It answers
"checkpoint" with "playedStream" and "clearAudio" with "clearedAudio", and checks every playAudio, checkpoint,
clearAudio and stop your server sends. Exit code 1 when your server breaks the protocol, 8 when it cannot connect.

Examples:
  vobiz streams test wss://agent.example.com/media
  vobiz streams test ws://localhost:8080/media --allow-insecure-url --codec l16 --sample-rate 16000 --seconds 5
  vobiz streams test wss://agent.example.com/media --json | jq .errors

Frame reference: ${STREAM_DOCS}`,
    )
    .action(async (raw: string, opts: { codec: Codec; sampleRate: string; seconds?: number; linger?: number; streamId?: string; callId?: string; allowInsecureUrl?: boolean }) => {
      const url = checkUrl(raw, "<wss-url>", { websocket: true, allowInsecure: opts.allowInsecureUrl });
      const sampleRate = Number(opts.sampleRate);
      if (opts.codec === "mulaw" && sampleRate !== 8000) throw usage("μ-law streams are 8000 Hz only; use --codec l16 for 16000.");
      const o: TestOptions = {
        codec: opts.codec,
        sampleRate,
        seconds: opts.seconds ?? 3,
        linger: opts.linger ?? 1,
        streamId: opts.streamId ?? randomUUID(),
        callId: opts.callId ?? randomUUID(),
        accountId: "0",
      };
      if (ctx.flags.dryRun) {
        ctx.out.print({
          dry_run: true,
          target: maskUrl(url),
          start: startFrame(o),
          media_example: mediaFrame({ streamId: o.streamId, sequenceNumber: 1, chunk: 1, timestamp: 0, payload: silence(o.codec, sampleRate) }),
          media_frames: Math.max(1, Math.round(o.seconds * 50)),
        });
        return;
      }
      ctx.out.status(`Testing ${maskUrl(url)}: start + ${Math.max(1, Math.round(o.seconds * 50))} media frames (${ENCODINGS[o.codec]};rate=${sampleRate})…`);
      const report = await runStreamTest(ctx, url, o);
      ctx.out.print(report);
      if (report.ok) ctx.out.status(`PASS: ${report.received} frame(s) received, no protocol errors.`);
      else {
        ctx.out.status(`FAIL: ${report.errors.length} protocol error(s). See ${STREAM_DOCS}`);
        ctx.exitCode = 1;
      }
    });

  streams
    .command("forward")
    .description("Run a local WebSocket proxy that relays a Vobiz stream to your server and logs every frame")
    .requiredOption("--to <ws-url>", "your stream server, e.g. ws://localhost:8080/media", toWs)
    .option("--port <port>", "local port to listen on (0 picks a free one; default: 8765)")
    .option("--host <host>", "interface to listen on", "127.0.0.1")
    .option("--every-media", "log each media frame instead of one summary line per second")
    .addHelpText(
      "after",
      `
Vobiz must reach the proxy over the internet: expose it with a tunnel and use the tunnel's wss:// URL in
<Stream> or \`vobiz calls stream start --url\`. Frame summaries go to stderr; audio payloads are never printed.

Examples:
  vobiz streams forward --to ws://localhost:8080/media
  cloudflared tunnel --url http://localhost:8765     # then use wss://<name>.trycloudflare.com/<path>`,
    )
    .action(async (opts: { to: string; port?: string; host: string; everyMedia?: boolean }) => {
      const port = parsePort(opts.port, 8765);
      if (ctx.flags.dryRun) {
        ctx.out.print({ dry_run: true, listen: `ws://${opts.host}:${port}`, forward_to: maskUrl(opts.to) });
        return;
      }
      const fwd = await startForwarder(ctx, { to: opts.to, port, host: opts.host, everyMedia: opts.everyMedia });
      ctx.out.status(`Forwarding ${fwd.url} → ${maskUrl(opts.to)} (Ctrl-C to stop).`);
      ctx.out.status(
        `To reach it from Vobiz, expose it over https, e.g. \`cloudflared tunnel --url http://localhost:${fwd.port}\` or \`ngrok http ${fwd.port}\`, and use the wss:// form of the URL it prints (a connection on any path goes to --to).`,
      );
      await untilInterrupted();
      await fwd.close();
    });
}

