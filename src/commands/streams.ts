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
 *            logging a one-line summary of each frame to stderr (never audio bytes, DTMF digits or phone numbers
 *            unless --log-sensitive). Only connections on the random path token are accepted, with a connection cap,
 *            an idle timeout, an upstream handshake timeout and bounded queues.
 *
 * Frame shapes: https://www.vobiz.ai/docs/xml/stream/stream-events and /xml/stream/audio-formats.
 */
import { randomUUID } from "node:crypto";
import { Option, type Command } from "commander";
import type { Ctx } from "../core/context.js";
import { VobizError, usage } from "../core/errors.js";
import { checkBindHost, checkToken, isLoopback, newToken, parsePort, pathHasToken, requestPath, safeLogText, startServer, untilInterrupted, type LocalServer } from "../agent/http.js";
import {
  MAX_MESSAGE_BYTES,
  WS_IDLE_TIMEOUT_MS,
  WebSocketConnectError,
  WebSocketProtocolError,
  connectWebSocket,
  isValidCloseCode,
  serveWebSockets,
  type WebSocketConnection,
} from "../agent/websocket.js";
import { checkUrl, collect, intArg, isRec, secondsArg, sleep, type Rec } from "./voice-shared.js";

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
  /** The parsed message, when it is a JSON object. */
  message?: Rec;
  /** Decoded playAudio payload size. */
  bytes?: number;
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
  if (event === "media" || event === "start") return { event, errors, warnings, message: msg };
  if (!APP_EVENTS.has(event)) return { event, errors: [`unknown event "${safeLogText(event, 40)}" (Vobiz accepts playAudio, checkpoint, clearAudio and stop)`], warnings, message: msg };
  let bytes: number | undefined;
  if (typeof msg.streamId !== "string" || !msg.streamId) errors.push(`${event}: "streamId" is required (use start.streamId)`);
  else if (msg.streamId !== streamId) errors.push(`${event}: streamId ${safeLogText(msg.streamId, 60)} does not match the stream's ${streamId}`);
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
        bytes = raw.length;
        const magic = raw.subarray(0, 4).toString("latin1");
        if (magic === "RIFF") warnings.push("playAudio: payload starts with a WAV header; send raw audio without the file container");
        else if (magic.startsWith("ID3") || (raw[0] === 0xff && (raw[1] & 0xe0) === 0xe0 && ct === "audio/x-l16"))
          warnings.push("playAudio: payload looks like MP3; send raw L16 or μ-law audio");
        if (ct === "audio/x-l16" && raw.length % 2 === 1) warnings.push("playAudio: L16 payload has an odd byte count (samples are 16-bit)");
      }
    }
  }
  return { event, errors, warnings, message: msg, bytes };
}

// ── streams test ──

/** Largest message `streams test` accepts from the server under test (a playAudio of a few seconds is ~100 KB). */
export const MAX_TEST_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Distinct errors (and warnings, and event names) a report keeps. */
const MAX_REPORT_ITEMS = 50;

/** A set of distinct strings capped at `MAX_REPORT_ITEMS`, counting what was dropped. */
class Capped {
  readonly items = new Set<string>();
  dropped = 0;
  add(s: string) {
    if (this.items.has(s)) return;
    if (this.items.size >= MAX_REPORT_ITEMS) this.dropped++;
    else this.items.add(s);
  }
  list(what: string): string[] {
    return [...this.items, ...(this.dropped ? [`…and ${this.dropped} more distinct ${what}`] : [])];
  }
}

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
  const host = new URL(url).host;
  const started = Date.now();
  let ws: WebSocketConnection;
  try {
    ws = await connectWebSocket(url, { timeoutMs: ctx.flags.timeout * 1000, maxMessageBytes: MAX_TEST_MESSAGE_BYTES, idleTimeoutMs: 0, closeTimeoutMs: 2000 });
  } catch (e) {
    if (e instanceof WebSocketConnectError && e.reason === "timeout") throw new VobizError("timeout", `No WebSocket handshake from ${host} within ${ctx.flags.timeout}s.`);
    throw new VobizError("network_error", `Could not open a WebSocket to ${host} (connection refused, TLS error or a non-101 answer to the upgrade).`);
  }
  report.handshake_ms = Date.now() - started;
  ctx.log("verbose", `stream test: connected to ${report.target} in ${report.handshake_ms}ms`);

  const errors = new Capped();
  const warnings = new Capped();
  let closed = false;
  let resolveClosed!: () => void;
  const closedP = new Promise<void>((r) => (resolveClosed = r));
  const count = (name: string) => {
    let key = safeLogText(name, 40);
    if (!(key in report.events) && Object.keys(report.events).length >= MAX_REPORT_ITEMS) key = "(other)";
    report.events[key] = (report.events[key] ?? 0) + 1;
  };

  let seq = 0;
  const send = (frame: Rec) => {
    if (!closed && ws.isOpen) ws.send(JSON.stringify(frame));
  };

  ws.on("error", (err: Error) => {
    if (err instanceof WebSocketProtocolError) closed = true; // the CLI closes the socket on a protocol error
    if (err instanceof WebSocketProtocolError)
      errors.add(err.code === 1009 ? `the server sent a message larger than ${MAX_TEST_MESSAGE_BYTES} bytes` : `the server broke the WebSocket protocol: ${err.message}`);
  });
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    report.received++;
    if (isBinary) {
      count("binary");
      errors.add(`binary frame of ${data.length} bytes: Vobiz expects JSON text frames`);
      return;
    }
    const check = checkAppMessage(data.toString("utf8"), o.streamId);
    const name = check.event ?? "invalid";
    count(name);
    for (const e of check.errors) errors.add(e);
    for (const w of check.warnings) warnings.add(w);
    if (name === "media" || name === "start") {
      report.echoed_frames++;
      return;
    }
    if (check.errors.length || !check.message) return;
    const msg = check.message;
    if (name === "playAudio") report.play_audio_bytes += check.bytes ?? 0;
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
  ws.on("close", (code: number, reason: string) => {
    if (!closed) report.closed_by = "server";
    closed = true;
    report.close_code = code;
    if (reason) report.close_reason = safeLogText(reason, 123);
    resolveClosed();
  });

  // A hard limit on the whole exchange, so a server that floods or stalls can never hang CI.
  const frames = Math.max(1, Math.round(o.seconds * 50));
  const budgetMs = (o.seconds + o.linger + 10) * 1000;
  const deadline = setTimeout(() => {
    errors.add(`the test did not finish within ${Math.round(budgetMs / 1000)}s; the connection was dropped`);
    closed = true;
    ws.terminate();
  }, budgetMs);
  deadline.unref?.();

  try {
    send(startFrame(o));
    report.sent.start = 1;
    seq = 1;
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
    // The close handshake gets 2 s (closeTimeoutMs); after that the socket is dropped.
    await Promise.race([closedP, sleep(3000)]);
    ws.terminate();
  } finally {
    clearTimeout(deadline);
  }

  if (report.closed_by === "server" && !report.stop_received) {
    const code = report.close_code ?? 1006;
    const msg = `the server closed the socket after ${report.sent.media} of ${frames} media frames (code ${code}${report.close_reason ? `, ${report.close_reason}` : ""}) without sending stop`;
    if (code === 1000 || code === 1001) warnings.add(msg);
    else errors.add(msg);
  }
  if (report.echoed_frames) warnings.add(`${report.echoed_frames} frame(s) came back as start/media: an echo server, not a Vobiz stream handler`);
  report.errors = errors.list("errors");
  report.warnings = warnings.list("warnings");
  report.ok = report.errors.length === 0;
  return report;
}

// ── streams forward ──

interface Tally {
  count: number;
  bytes: number;
}

/**
 * One-line summary of a frame, without audio. `media` frames are reported separately (aggregated). DTMF digits are
 * masked unless `logSensitive`. The caller makes the line terminal-safe.
 */
export function summarize(data: string | Buffer, isBinary: boolean, o: { logSensitive?: boolean } = {}): { line: string; mediaBytes?: number; track?: string } {
  if (isBinary || typeof data !== "string") return { line: `binary ${(data as Buffer).length}B` };
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return { line: `text ${data.length} chars (not JSON)` };
  }
  if (!isRec(msg)) return { line: "JSON without an event" };
  const ev = safeLogText(msg.event ?? "?", 40);
  const media = isRec(msg.media) ? msg.media : undefined;
  const payload = media && typeof media.payload === "string" ? media.payload : "";
  // Decoded size without decoding: 3 bytes per 4 base64 characters, minus padding.
  const bytes = payload ? Math.max(0, Math.floor((payload.length * 3) / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0)) : 0;
  const str = (v: unknown, max = 60) => safeLogText(v ?? "?", max);
  switch (ev) {
    case "start": {
      const s = isRec(msg.start) ? msg.start : {};
      const f = isRec(s.mediaFormat) ? s.mediaFormat : {};
      return { line: `start callId=${str(s.callId)} streamId=${str(s.streamId)} tracks=${Array.isArray(s.tracks) ? str(s.tracks.join(",")) : "?"} format=${str(f.encoding)}@${str(f.sampleRate, 10)}` };
    }
    case "media":
      return { line: `media seq=${str(msg.sequenceNumber, 12)} chunk=${str(media?.chunk, 12)} track=${str(media?.track, 20)} ${bytes}B`, mediaBytes: bytes, track: str(media?.track ?? "", 20) };
    case "playAudio":
      return { line: `playAudio ${str(media?.contentType, 30)}@${str(media?.sampleRate, 10)} ${bytes}B` };
    case "checkpoint":
    case "playedStream":
      return { line: `${ev} name=${str(msg.name)}` };
    case "dtmf": {
      const d = isRec(msg.dtmf) ? msg.dtmf : msg;
      const digit = d.digit ?? d.digits;
      return { line: `dtmf ${o.logSensitive ? `digit=${str(digit, 20)}` : "digit=* (--log-sensitive shows it)"}` };
    }
    default:
      return { line: `${ev}${msg.streamId ? ` streamId=${str(msg.streamId)}` : ""}` };
  }
}

export interface ForwardOptions {
  to: string;
  port: number;
  host: string;
  everyMedia?: boolean;
  /** Accept only `/<token>` and `/<token>/…` (other paths get 404). */
  token?: string;
  /** Simultaneous connections from the Vobiz side (default 10). */
  maxConnections?: number;
  /** Close a connection after this long with no traffic (default 120 s). */
  idleTimeoutMs?: number;
  /** Largest message relayed in either direction (default 16 MiB). */
  maxMessageBytes?: number;
  /** Browser origins allowed to connect (none by default). */
  allowOrigins?: string[];
  /** Upstream handshake timeout (default 10 s). */
  connectTimeoutMs?: number;
  /** Log DTMF digits in clear. */
  logSensitive?: boolean;
}

/** Bytes queued for the upstream while it is still connecting; more closes the Vobiz side with 1013. */
export const MAX_PENDING_BYTES = 1024 * 1024;

export async function startForwarder(ctx: Ctx, o: ForwardOptions): Promise<LocalServer & { token?: string }> {
  const flushers = new Set<() => void>();
  let next = 0;
  const log = (conn: number, dir: string, line: string) => {
    const t = ctx.now().toISOString().slice(11, 23);
    ctx.stderr.write(`${t} [${conn}] ${dir} ${safeLogText(line, 300)}\n`);
  };
  const maxMessageBytes = o.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const idleTimeoutMs = o.idleTimeoutMs ?? WS_IDLE_TIMEOUT_MS;

  const server = await startServer(
    (_req, res) => {
      res.writeHead(426, { "content-type": "text/plain", upgrade: "websocket" });
      res.end("This is a WebSocket proxy for Vobiz audio streams; connect with ws:// or wss://.\n");
    },
    { port: o.port, host: o.host },
  );

  const reasons: Record<number, string> = { 404: "wrong or missing path token", 503: "connection limit reached", 400: "not a valid WebSocket upgrade, or a browser Origin" };
  const sockets = serveWebSockets(
    server.server,
    {
      maxConnections: o.maxConnections ?? 10,
      idleTimeoutMs,
      maxMessageBytes,
      allowOrigins: o.allowOrigins,
      authorize: (req) => !o.token || pathHasToken(requestPath(req.url), o.token),
      onReject: (req, status) => log(0, "!!", `rejected a connection from ${req.socket.remoteAddress ?? "?"}: ${reasons[status] ?? status}`),
    },
    (down, req) => {
      const conn = ++next;
      log(conn, "**", `connection from ${req.socket.remoteAddress ?? "?"}; opening ${maskUrl(o.to)}`);
      let up: WebSocketConnection | undefined;
      let pending: (string | Buffer)[] = [];
      let pendingBytes = 0;
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
        const s = summarize(data, isBinary, { logSensitive: o.logSensitive });
        if (s.mediaBytes !== undefined && !o.everyMedia) {
          const key = `${dir}${s.track || "media"}`;
          const t = (tallies[key] ??= { count: 0, bytes: 0 });
          t.count++;
          t.bytes += s.mediaBytes;
          return;
        }
        log(conn, dir === ">" ? "→ app" : "← app", s.line);
      };
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        clearInterval(timer);
        flush();
        flushers.delete(flush);
      };
      const wireCode = (code: number) => (isValidCloseCode(code) ? code : 1000);

      down.on("message", (data: Buffer, isBinary: boolean) => {
        const payload = isBinary ? data : data.toString("utf8");
        record(">", payload, isBinary);
        if (up) {
          up.send(payload);
          return;
        }
        pendingBytes += data.length;
        if (pendingBytes > MAX_PENDING_BYTES) {
          log(conn, "!!", `your server has not accepted the connection yet and ${MAX_PENDING_BYTES} bytes are queued; closing`);
          pending = [];
          down.close(1013, "upstream not ready");
          return;
        }
        pending.push(payload);
      });
      down.on("close", (code: number, reason: string) => {
        end();
        log(conn, "**", `Vobiz side closed (${code}${reason ? ` ${reason}` : ""})`);
        up?.close(wireCode(code), reason);
      });
      down.on("error", (err: Error) => log(conn, "!!", `Vobiz side: ${err.message}`));

      connectWebSocket(o.to, { timeoutMs: o.connectTimeoutMs ?? 10_000, maxMessageBytes, idleTimeoutMs }).then(
        (ws) => {
          if (!down.isOpen) {
            ws.close(1000, "");
            return;
          }
          up = ws;
          log(conn, "**", "connected to your server");
          for (const p of pending.splice(0)) ws.send(p);
          pendingBytes = 0;
          ws.on("message", (data: Buffer, isBinary: boolean) => {
            const payload = isBinary ? data : data.toString("utf8");
            record("<", payload, isBinary);
            down.send(payload);
          });
          ws.on("error", (err: Error) => log(conn, "!!", `your server: ${err.message}`));
          ws.on("close", (code: number, reason: string) => {
            log(conn, "**", `your server closed (${code}${reason ? ` ${reason}` : ""})`);
            end();
            down.close(wireCode(code), reason);
          });
        },
        (err: Error) => {
          log(conn, "!!", `could not reach ${maskUrl(o.to)}: ${err.message}`);
          end();
          down.close(1011, "upstream unavailable");
        },
      );
    },
  );

  return {
    ...server,
    token: o.token,
    url: server.url.replace(/^http/, "ws") + (o.token ? `/${o.token}` : ""),
    close: async () => {
      for (const f of [...flushers]) f();
      for (const s of sockets) s.destroy();
      await server.close();
    },
  };
}

// ── Commands ──

/** `--to`: ws:// or wss://; plain ws:// to a non-loopback host needs --allow-insecure-url (audio would cross the network in clear). */
function checkForwardTarget(raw: string, allowInsecure: boolean | undefined): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw usage(`--to is not a valid URL: "${raw}".`);
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") throw usage("--to must be a ws:// or wss:// URL, e.g. ws://localhost:8080/media.");
  if (u.protocol === "ws:" && !isLoopback(u.hostname) && !allowInsecure)
    throw usage("--to uses ws:// to another machine, so call audio would cross the network unencrypted. Use wss://, or pass --allow-insecure-url.");
  return raw;
}

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
    .requiredOption("--to <ws-url>", "your stream server, e.g. ws://localhost:8080/media")
    .option("--port <port>", "local port to listen on (0 picks a free one; default: 8765)")
    .option("--host <host>", "interface to listen on (default 127.0.0.1); anything else also needs --allow-lan", "127.0.0.1")
    .option("--allow-lan", "allow a non-loopback --host such as 0.0.0.0 (the proxy is then reachable from your network)")
    .option("--token <token>", "path token to require instead of a random one (16-128 characters of A-Z a-z 0-9 - _)")
    .option("--max-connections <n>", "simultaneous Vobiz-side connections (default: 10)", intArg(1, 1000))
    .option("--idle-timeout <seconds>", "close a connection after this long without traffic (default: 120)", secondsArg(86_400))
    .option("--max-message-bytes <n>", `largest message relayed either way (default: ${MAX_MESSAGE_BYTES})`, intArg(1024, 256 * 1024 * 1024))
    .option("--allow-origin <origin>", "accept browser connections from this Origin (repeatable; none by default)", collect)
    .option("--log-sensitive", "log DTMF digits in clear (masked by default)")
    .option("--every-media", "log each media frame instead of one summary line per second")
    .option("--allow-insecure-url", "allow a ws:// --to on another machine (audio crosses the network unencrypted)")
    .addHelpText(
      "after",
      `
Vobiz must reach the proxy over the internet: expose it with a tunnel and use the tunnel's wss:// URL plus the
path token printed at start (wss://<tunnel>/<token>) in <Stream> or \`vobiz calls stream start --url\`. Other paths
get 404, so only Vobiz, with your configured URL, can open sessions on your server. Frame summaries go to stderr;
audio payloads and DTMF digits are never printed (digits only with --log-sensitive).

Examples:
  vobiz streams forward --to ws://localhost:8080/media
  cloudflared tunnel --url http://localhost:8765     # then use wss://<name>.trycloudflare.com/<token>`,
    )
    .action(
      async (opts: {
        to: string;
        port?: string;
        host: string;
        allowLan?: boolean;
        token?: string;
        maxConnections?: number;
        idleTimeout?: number;
        maxMessageBytes?: number;
        allowOrigin?: string[];
        logSensitive?: boolean;
        everyMedia?: boolean;
        allowInsecureUrl?: boolean;
      }) => {
        const to = checkForwardTarget(opts.to, opts.allowInsecureUrl);
        const port = parsePort(opts.port, 8765);
        const token = opts.token !== undefined ? checkToken(opts.token) : newToken();
        if (ctx.flags.dryRun) {
          ctx.out.print({ dry_run: true, listen: `ws://${opts.host}:${port}`, forward_to: maskUrl(to) });
          return;
        }
        checkBindHost(ctx, opts.host, opts.allowLan);
        const fwd = await startForwarder(ctx, {
          to,
          port,
          host: opts.host,
          token,
          everyMedia: opts.everyMedia,
          maxConnections: opts.maxConnections,
          idleTimeoutMs: opts.idleTimeout !== undefined ? opts.idleTimeout * 1000 : undefined,
          maxMessageBytes: opts.maxMessageBytes,
          allowOrigins: opts.allowOrigin,
          connectTimeoutMs: ctx.flags.timeout * 1000,
          logSensitive: opts.logSensitive,
        });
        ctx.out.status(`Forwarding ${fwd.url} → ${maskUrl(to)} (listening on ${fwd.bind}; Ctrl-C to stop).`);
        ctx.out.status(
          `To reach it from Vobiz, expose it over https, e.g. \`cloudflared tunnel --url http://localhost:${fwd.port}\` or \`ngrok http ${fwd.port}\`, and use wss://<tunnel-host>/${token} as the stream URL; other paths are refused.`,
        );
        await untilInterrupted();
        await fwd.close();
      },
    );
}

