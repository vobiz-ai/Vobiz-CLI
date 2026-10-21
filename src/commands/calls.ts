/**
 * `vobiz calls`: place outbound calls, list and inspect live/queued calls, hang up, and control a call in
 * progress (record, play, speak, DTMF, audio streams). `calls watch` and `calls create --wait` poll a call until
 * it ends and print its call record.
 *
 * `create --say/--play/--xml-file` need the VobizXML hosted somewhere Vobiz can fetch it. The CLI never hosts it
 * publicly: `--xml-only` prints the document so you can host it, and `--serve --public-url` serves it from a local
 * HTTP server that you expose with a tunnel (cloudflared, ngrok…) for the length of the call.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { Option, type Command } from "commander";
import { requireConfirmation } from "../core/confirm.js";
import type { Ctx } from "../core/context.js";
import { VobizError, usage } from "../core/errors.js";
import { op } from "../core/ops.js";
import { toE164 } from "../core/phone.js";
import { checkUrl, hostOf, intArg, isRec, normalizeDestinations, secondsArg, watchCall, type Rec } from "./voice-shared.js";

const MAKE_CALL = op("make-call");
const LIST_LIVE = op("list-live-calls");
const LIST_QUEUED = op("list-queued-calls");
const GET_LIVE = op("get-live-call");
const GET_QUEUED = op("get-queued-call");
const HANGUP = op("hangup-call");
const START_RECORDING = op("start-recording");
const STOP_RECORDING = op("stop-recording");
const PLAY = op("play-audio-call");
const STOP_PLAY = op("stop-audio-call");
const SPEAK = op("speak-text-call");
const STOP_SPEAK = op("stop-speak-call");
const DTMF = op("send-dtmf");
const START_STREAM = op("start-stream");
const LIST_STREAMS = op("list-streams");
const GET_STREAM = op("get-stream");
const STOP_STREAM = op("stop-stream");

const LEGS = ["aleg", "bleg", "both"];
const legsOption = (flag = "--legs") => new Option(`${flag} <leg>`, "which side hears it: aleg (caller), bleg (callee) or both").choices(LEGS);
const insecureOption = () => new Option("--allow-insecure-url", "allow http:// (or ws://) URLs on localhost, for local testing");
const waitOptions = (cmd: Command) =>
  cmd
    .option("--interval <seconds>", "seconds between status checks (default: 2)", secondsArg(60))
    .option("--max-wait <seconds>", "give up waiting after this many seconds (default: 600)", secondsArg(86_400));

// ── VobizXML for --say / --play ──

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function sayXml(text: string, voice?: string, language?: string): string {
  const attrs = `${voice ? ` voice="${escapeXml(voice)}"` : ""}${language ? ` language="${escapeXml(language)}"` : ""}`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Speak${attrs}>${escapeXml(text)}</Speak>\n</Response>\n`;
}

export function playXml(url: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Play>${escapeXml(url)}</Play>\n</Response>\n`;
}

interface CreateOpts {
  to?: string;
  from?: string;
  answerUrl?: string;
  answerMethod: string;
  xmlFile?: string;
  say?: string;
  voice?: string;
  language?: string;
  play?: string;
  xmlOnly?: boolean;
  serve?: boolean;
  port?: number;
  publicUrl?: string;
  allowInsecureUrl?: boolean;
  interval?: number;
  maxWait?: number;
}

/** Builds the XML document for --say/--play/--xml-file, or undefined when --answer-url is used. */
function answerXml(o: CreateOpts): string | undefined {
  if (o.say !== undefined) {
    if (!o.say.trim()) throw usage("--say needs some text.");
    return sayXml(o.say, o.voice, o.language);
  }
  if (o.play !== undefined) return playXml(checkUrl(o.play, "--play", { allowInsecure: o.allowInsecureUrl }));
  if (o.xmlFile !== undefined) {
    let xml: string;
    try {
      xml = readFileSync(o.xmlFile, "utf8");
    } catch (e) {
      throw usage(`Cannot read --xml-file ${o.xmlFile}: ${(e as Error).message}`);
    }
    if (!/<Response[\s>]/.test(xml)) throw usage(`${o.xmlFile} does not look like VobizXML: it has no <Response> element.`);
    return xml;
  }
  return undefined;
}

/** Serves `xml` for every request until closed. Logs each fetch to stderr. */
async function serveXml(ctx: Ctx, xml: string, port: number): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    ctx.out.status(`answer server: ${req.method} ${req.url} from ${req.socket.remoteAddress ?? "?"}`);
    req.resume();
    res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" });
    res.end(xml);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      reject(new VobizError("invalid_input", e.code === "EADDRINUSE" ? `Port ${port} is in use; pick another with --port.` : e.message)),
    );
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  return { server, port: typeof addr === "object" && addr ? addr.port : port };
}

function registerCreate(calls: Command, ctx: Ctx) {
  const cmd = calls
    .command("create")
    .description("Place an outbound call (billed; asks for confirmation)")
    .option("--to <dest>", "destination: E.164 number or SIP URI; join several with < to fan out (max 1000)")
    .option("--from <number>", "caller ID: a Vobiz number on this account, E.164")
    .option("--answer-url <url>", "https URL that returns VobizXML when the call is answered")
    .addOption(new Option("--answer-method <method>", "HTTP method Vobiz uses for the answer URL").choices(["GET", "POST"]).default("POST"))
    .option("--xml-file <path>", "answer with this VobizXML file (needs --serve or --xml-only)")
    .option("--say <text>", "answer by speaking this text (needs --serve or --xml-only)")
    .option("--voice <voice>", "with --say: voice, e.g. WOMAN or MAN")
    .option("--language <code>", "with --say: language, e.g. en-US")
    .option("--play <url>", "answer by playing this audio URL (needs --serve or --xml-only)")
    .option("--xml-only", "print the VobizXML for --say/--play/--xml-file and exit without calling")
    .option("--serve", "serve the XML from a local server for the call; requires --public-url (implies --wait)")
    .option("--port <port>", "with --serve: local port (default: 8787)", intArg(0, 65_535))
    .option("--public-url <url>", "with --serve: the https URL your tunnel exposes for the local server")
    .addOption(insecureOption());
  waitOptions(cmd)
    .addHelpText(
      "after",
      `
Exactly one of --answer-url, --xml-file, --say or --play is required.
Global --wait polls the call until it ends and prints its call record.

Examples:
  vobiz calls create --to +919876543210 --from +918012345678 --answer-url https://example.com/answer
  vobiz calls create --to +919876543210 --from +918012345678 --answer-url https://example.com/answer --wait --yes
  vobiz calls create --say "Your OTP is 4 2 7 1" --xml-only > answer.xml
  cloudflared tunnel --url http://localhost:8787   # in another terminal
  vobiz calls create --to +919876543210 --from +918012345678 --say "Hello from Vobiz" \\
      --serve --public-url https://<your-tunnel>.trycloudflare.com/answer`,
    )
    .action(async (o: CreateOpts) => {
      const sources = [o.answerUrl, o.xmlFile, o.say, o.play].filter((v) => v !== undefined).length;
      if (sources !== 1) throw usage("Pass exactly one of --answer-url, --xml-file, --say or --play.");
      if ((o.voice || o.language) && o.say === undefined) throw usage("--voice and --language apply only to --say.");
      const xml = answerXml(o);

      if (o.xmlOnly) {
        if (!xml) throw usage("--xml-only needs --say, --play or --xml-file.");
        ctx.stdout.write(xml);
        return;
      }
      if (xml && !o.serve)
        throw usage(
          "Vobiz must fetch the answer XML over the internet. Either print it with --xml-only, host it and pass --answer-url, or serve it for this call with --serve --public-url https://<tunnel>.",
        );
      if (o.serve && !xml) throw usage("--serve needs --say, --play or --xml-file.");
      if (o.serve && !o.publicUrl) throw usage("--serve needs --public-url: the https address of a tunnel (cloudflared, ngrok…) to the local port.");
      if (!o.serve && (o.publicUrl || o.port !== undefined)) throw usage("--public-url and --port apply only to --serve.");
      if (!o.to || !o.from) throw usage("--to and --from are required.");

      const destinations = normalizeDestinations(o.to);
      const from = toE164(o.from);
      const answerUrl = checkUrl((o.serve ? o.publicUrl : o.answerUrl)!, o.serve ? "--public-url" : "--answer-url", { allowInsecure: o.allowInsecureUrl });
      const body = { from, to: destinations.join("<"), answer_url: answerUrl, answer_method: o.answerMethod };
      const wait = !!ctx.flags.wait || !!o.serve;

      await requireConfirmation(ctx, {
        action: destinations.length > 1 ? `Place ${destinations.length} calls (billed)` : `Place a call to ${destinations[0]} (billed)`,
        details: {
          to: destinations.length > 3 ? `${destinations.slice(0, 3).join(", ")} and ${destinations.length - 3} more` : destinations.join(", "),
          "caller ID": from,
          "answer URL host": hostOf(answerUrl) + (o.serve ? ` (tunnel to local port ${o.port ?? 8787})` : ""),
          ...(o.say !== undefined ? { says: o.say.length > 60 ? `${o.say.slice(0, 57)}…` : o.say } : {}),
          ...(o.play !== undefined ? { plays: o.play } : {}),
        },
      });

      let served: { server: Server; port: number } | undefined;
      if (o.serve && !ctx.flags.dryRun) {
        served = await serveXml(ctx, xml!, o.port ?? 8787);
        ctx.out.status(
          `Serving the answer XML on http://127.0.0.1:${served.port}/ . Vobiz will fetch ${answerUrl}, which must reach this port (keep the tunnel running).`,
        );
      }
      try {
        const res = await ctx.client.call<Rec>(MAKE_CALL, { body, sideEffect: true });
        const uuid = isRec(res) ? String(res.request_uuid ?? res.call_uuid ?? "") : "";
        if (!wait || !uuid || destinations.length > 1) {
          if (wait && destinations.length > 1) ctx.out.warn("--wait follows a single call; it is skipped for fan-out calls.");
          ctx.out.success(`Call queued to ${destinations.join(", ")} (request ${uuid || "unknown"}).`, res);
          if (ctx.out.mode === "table" || ctx.out.mode === "plain") ctx.stdout.write(`${uuid}\n`);
          return;
        }
        ctx.out.status(`Call queued (request ${uuid}). Waiting for it to finish…`);
        const result = await watchCall(ctx, uuid, { interval: o.interval ?? 2, maxWait: o.maxWait ?? 600 });
        ctx.out.print({ ...res, ...result });
      } finally {
        if (served) await new Promise<void>((r) => served!.server.close(() => r()));
      }
    });
}

function registerReads(calls: Command, ctx: Ctx) {
  calls
    .command("list")
    .alias("ls")
    .description("List live calls (or queued calls with --queued)")
    .option("--queued", "list queued calls (placed, not yet connected; max 20) instead of live ones")
    .option("--details", "fetch each call's details (one request per call)")
    .addHelpText("after", "\nExamples:\n  vobiz calls list\n  vobiz calls list --queued --details")
    .action(async (o: { queued?: boolean; details?: boolean }) => {
      const status = o.queued ? "queued" : "live";
      const body = await ctx.client.call<Rec>(o.queued ? LIST_QUEUED : LIST_LIVE, { query: { status } });
      const uuids = Array.isArray(body?.calls) ? (body.calls as unknown[]).map(String) : [];
      if (!o.details) {
        const mode = ctx.out.mode;
        if ((mode === "json" || mode === "yaml") && !ctx.flags.fields?.length && !ctx.flags.quiet) ctx.out.print(body);
        else ctx.out.print(uuids.map((call_uuid) => ({ call_uuid })), { columns: ["call_uuid"], empty: `No ${status} calls.` });
        return;
      }
      const rows: Rec[] = [];
      for (const call_uuid of uuids) {
        try {
          rows.push(await ctx.client.call<Rec>(o.queued ? GET_QUEUED : GET_LIVE, { path: { call_uuid }, query: { status } }));
        } catch (e) {
          if (!(e instanceof VobizError && e.kind === "not_found")) throw e;
        }
      }
      ctx.out.print(rows, { columns: ["call_uuid", "call_status", "direction", "from", "to", "session_start"], idKey: "call_uuid", empty: `No ${status} calls.` });
    });

  calls
    .command("get")
    .argument("<uuid>", "call UUID (the request_uuid from calls create)")
    .description("Show a live call (or a queued one with --queued)")
    .option("--queued", "look the call up among queued calls")
    .action(async (uuid: string, o: { queued?: boolean }) => {
      const res = await ctx.client.call(o.queued ? GET_QUEUED : GET_LIVE, { path: { call_uuid: uuid }, query: { status: o.queued ? "queued" : "live" } });
      ctx.out.print(res);
    });

  waitOptions(
    calls
      .command("watch")
      .argument("<uuid>", "call UUID")
      .description("Follow a call until it ends (status on stderr), then print its call record"),
  )
    .addHelpText("after", "\nExample:\n  vobiz calls watch 2ded13fe-4f9b-4958-9bfb-093ea2f29f91 --interval 1")
    .action(async (uuid: string, o: { interval?: number; maxWait?: number }) => {
      ctx.out.print(await watchCall(ctx, uuid, { interval: o.interval ?? 2, maxWait: o.maxWait ?? 600 }));
    });

  calls
    .command("hangup")
    .argument("<uuid>", "call UUID")
    .description("Hang up a live call, or cancel a queued one")
    .action(async (uuid: string) => {
      await requireConfirmation(ctx, { action: `Hang up call ${uuid}` });
      await ctx.client.call(HANGUP, { path: { call_uuid: uuid }, sideEffect: true });
      ctx.out.success(`Hung up ${uuid}.`, { call_uuid: uuid, hung_up: true });
    });
}

/** A write against a live call: confirm, send, report. */
async function callAction(ctx: Ctx, opts: { action: string; details?: Record<string, string>; run: () => Promise<unknown>; done: string; uuid: string }) {
  await requireConfirmation(ctx, { action: opts.action, details: opts.details });
  const res = await opts.run();
  ctx.out.success(opts.done, isRec(res) ? res : { call_uuid: opts.uuid, ok: true });
}

function registerControl(calls: Command, ctx: Ctx) {
  // record start|stop
  const record = calls.command("record").description("Record a live call");
  record
    .command("start")
    .argument("<uuid>", "call UUID")
    .description("Start recording a live call")
    .option("--time-limit <seconds>", "maximum recording length in seconds (API default: 60)", intArg(1, 86_400))
    .addOption(new Option("--format <format>", "file format").choices(["mp3", "wav"]))
    .addOption(new Option("--channels <type>", "mono, or stereo with one leg per channel").choices(["mono", "stereo"]))
    .option("--transcribe", "request automatic transcription")
    .option("--callback-url <url>", "https URL notified when the recording is ready")
    .addOption(insecureOption())
    .addHelpText("after", "\nExample:\n  vobiz calls record start <uuid> --time-limit 600 --format wav --channels stereo")
    .action(async (uuid: string, o: { timeLimit?: number; format?: string; channels?: string; transcribe?: boolean; callbackUrl?: string; allowInsecureUrl?: boolean }) => {
      const body: Rec = {};
      if (o.timeLimit !== undefined) body.time_limit = o.timeLimit;
      if (o.format) body.file_format = o.format;
      if (o.channels) body.record_channel_type = o.channels;
      if (o.transcribe) body.transcription_type = "auto";
      if (o.callbackUrl) body.callback_url = checkUrl(o.callbackUrl, "--callback-url", { allowInsecure: o.allowInsecureUrl });
      await callAction(ctx, {
        uuid,
        action: `Start recording call ${uuid}`,
        details: o.callbackUrl ? { "callback host": hostOf(o.callbackUrl) } : undefined,
        run: () => ctx.client.call(START_RECORDING, { path: { call_uuid: uuid }, body, sideEffect: true }),
        done: `Recording started on ${uuid}.`,
      });
    });
  record
    .command("stop")
    .argument("<uuid>", "call UUID")
    .description("Stop recording a live call")
    .action(async (uuid: string) => {
      await callAction(ctx, {
        uuid,
        action: `Stop recording call ${uuid}`,
        run: () => ctx.client.call(STOP_RECORDING, { path: { call_uuid: uuid }, sideEffect: true }),
        done: `Recording stopped on ${uuid}.`,
      });
    });

  // play <uuid> --url | play stop <uuid>
  const play = calls
    .command("play")
    .argument("<uuid>", "call UUID")
    .description("Play an audio file into a live call (`calls play stop <uuid>` stops it)")
    .option("--url <url>", "https URL of the audio file (mp3 or wav); required")
    .addOption(legsOption())
    .option("--loop", "repeat until stopped")
    .addOption(insecureOption())
    .addHelpText("after", "\nExamples:\n  vobiz calls play <uuid> --url https://example.com/hold.mp3 --loop\n  vobiz calls play stop <uuid>")
    .action(async (uuid: string, o: { url?: string; legs?: string; loop?: boolean; allowInsecureUrl?: boolean }) => {
      if (!o.url) throw usage("--url is required (or use `vobiz calls play stop <uuid>`).");
      const url = checkUrl(o.url, "--url", { allowInsecure: o.allowInsecureUrl });
      const body: Rec = { urls: url };
      if (o.legs) body.legs = o.legs;
      if (o.loop) body.loop = true;
      await callAction(ctx, {
        uuid,
        action: `Play audio into call ${uuid}`,
        details: { "audio host": hostOf(url), legs: o.legs ?? "aleg" },
        run: () => ctx.client.call(PLAY, { path: { call_uuid: uuid }, body, sideEffect: true }),
        done: `Playing ${url} on ${uuid}.`,
      });
    });
  play
    .command("stop")
    .argument("<uuid>", "call UUID")
    .description("Stop audio playing on a live call")
    .action(async (uuid: string) => {
      await callAction(ctx, {
        uuid,
        action: `Stop audio on call ${uuid}`,
        run: () => ctx.client.call(STOP_PLAY, { path: { call_uuid: uuid }, sideEffect: true }),
        done: `Stopped audio on ${uuid}.`,
      });
    });

  // speak <uuid> --text | speak stop <uuid>
  const speak = calls
    .command("speak")
    .argument("<uuid>", "call UUID")
    .description("Speak text into a live call (`calls speak stop <uuid>` stops it)")
    .option("--text <text>", "what to say; required")
    .option("--voice <voice>", "voice, e.g. WOMAN or MAN (API default: WOMAN)")
    .option("--language <code>", "language, e.g. en-US (API default) or hi-IN")
    .addOption(legsOption())
    .addHelpText("after", '\nExample:\n  vobiz calls speak <uuid> --text "Please hold, connecting you now." --legs both')
    .action(async (uuid: string, o: { text?: string; voice?: string; language?: string; legs?: string }) => {
      if (!o.text?.trim()) throw usage("--text is required and cannot be empty (or use `vobiz calls speak stop <uuid>`).");
      const body: Rec = { text: o.text };
      if (o.voice) body.voice = o.voice;
      if (o.language) body.language = o.language;
      if (o.legs) body.legs = o.legs;
      await callAction(ctx, {
        uuid,
        action: `Speak into call ${uuid}`,
        details: { text: o.text.length > 60 ? `${o.text.slice(0, 57)}…` : o.text, legs: o.legs ?? "aleg" },
        run: () => ctx.client.call(SPEAK, { path: { call_uuid: uuid }, body, sideEffect: true }),
        done: `Speaking on ${uuid}.`,
      });
    });
  speak
    .command("stop")
    .argument("<uuid>", "call UUID")
    .description("Stop text-to-speech on a live call")
    .action(async (uuid: string) => {
      await callAction(ctx, {
        uuid,
        action: `Stop speech on call ${uuid}`,
        run: () => ctx.client.call(STOP_SPEAK, { path: { call_uuid: uuid }, sideEffect: true }),
        done: `Stopped speech on ${uuid}.`,
      });
    });

  calls
    .command("dtmf")
    .argument("<uuid>", "call UUID")
    .description("Send DTMF (keypad) tones on a live call")
    .requiredOption("--digits <digits>", "digits 0-9, *, #, A-D; w pauses 0.5s and W pauses 1s")
    .addOption(legsOption("--leg"))
    .addHelpText("after", "\nExample:\n  vobiz calls dtmf <uuid> --digits 1w2W3#")
    .action(async (uuid: string, o: { digits: string; leg?: string }) => {
      if (!/^[0-9*#A-DwW]+$/.test(o.digits)) throw usage("--digits may contain only 0-9, *, #, A-D, w and W.");
      const body: Rec = { digits: o.digits };
      if (o.leg) body.leg = o.leg;
      await callAction(ctx, {
        uuid,
        action: `Send DTMF ${o.digits} on call ${uuid}`,
        details: { leg: o.leg ?? "aleg" },
        run: () => ctx.client.call(DTMF, { path: { call_uuid: uuid }, body, sideEffect: true }),
        done: `Sent ${o.digits} on ${uuid}.`,
      });
    });

  // stream start|list|get|stop
  const stream = calls.command("stream").description("Stream a live call's audio to a WebSocket");
  stream
    .command("start")
    .argument("<uuid>", "call UUID")
    .description("Start streaming the call's audio to a wss:// URL")
    .requiredOption("--url <wss-url>", "WebSocket URL that receives the audio (wss://)")
    .option("--bidirectional", "let the WebSocket send audio back into the call")
    .addOption(new Option("--track <track>", "which audio to send").choices(["inbound", "outbound", "both"]))
    .addOption(new Option("--format <format>", "audio encoding").choices(["pcm", "mulaw"]))
    .addOption(insecureOption())
    .addHelpText("after", "\nExample:\n  vobiz calls stream start <uuid> --url wss://agent.example.com/media --bidirectional --track inbound")
    .action(async (uuid: string, o: { url: string; bidirectional?: boolean; track?: string; format?: string; allowInsecureUrl?: boolean }) => {
      const url = checkUrl(o.url, "--url", { allowInsecure: o.allowInsecureUrl, websocket: true });
      const body: Rec = { service_url: url };
      if (o.bidirectional) body.bidirectional = true;
      if (o.track) body.audio_track = o.track;
      if (o.format) body.audio_format = o.format;
      await callAction(ctx, {
        uuid,
        action: `Stream the audio of call ${uuid} (billed per minute)`,
        details: { "stream host": hostOf(url), bidirectional: String(!!o.bidirectional) },
        run: () => ctx.client.call(START_STREAM, { path: { call_uuid: uuid }, body, sideEffect: true }),
        done: `Streaming ${uuid} to ${hostOf(url)}.`,
      });
    });
  stream
    .command("list")
    .alias("ls")
    .argument("<uuid>", "call UUID")
    .description("List the audio streams on a live call")
    .action(async (uuid: string) => {
      ctx.out.print(await ctx.client.call(LIST_STREAMS, { path: { call_uuid: uuid } }), { idKey: "stream_id" });
    });
  stream
    .command("get")
    .argument("<uuid>", "call UUID")
    .argument("<stream-id>", "stream id from `stream start` or `stream list`")
    .description("Show one audio stream")
    .action(async (uuid: string, streamId: string) => {
      ctx.out.print(await ctx.client.call(GET_STREAM, { path: { call_uuid: uuid, stream_id: streamId } }));
    });
  stream
    .command("stop")
    .argument("<uuid>", "call UUID")
    .argument("<stream-id>", "stream id")
    .description("Stop one audio stream")
    .action(async (uuid: string, streamId: string) => {
      await callAction(ctx, {
        uuid,
        action: `Stop stream ${streamId} on call ${uuid}`,
        run: () => ctx.client.call(STOP_STREAM, { path: { call_uuid: uuid, stream_id: streamId }, sideEffect: true }),
        done: `Stopped stream ${streamId}.`,
      });
    });
}

export function register(program: Command, ctx: Ctx): void {
  const calls = program.command("calls").description("Place, list, watch, hang up and control voice calls");
  registerCreate(calls, ctx);
  registerReads(calls, ctx);
  registerControl(calls, ctx);
}
