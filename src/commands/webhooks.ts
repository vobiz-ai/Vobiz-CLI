/**
 * `vobiz webhooks verify|listen`: check Vobiz webhook (callback) signatures and receive webhooks locally while
 * developing. Needs no credentials: the signing secret comes from --secret or VOBIZ_WEBHOOK_SECRET.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Option, type Command } from "commander";
import {
  checkBindHost,
  decodeBody,
  isLoopback,
  parsePort,
  readBody,
  rejectMethod,
  requestPath,
  startServer,
  tunnelHint,
  untilInterrupted,
  type LocalServer,
} from "../agent/http.js";
import { NonceCache, isBodySignature, verifyBody, verifyCallback, verifyRequest, type CallbackVersion, type VerifyResult } from "../agent/webhooks.js";
import type { Ctx } from "../core/context.js";
import { cleanLogText } from "../core/sanitize.js";
import { VobizError } from "../core/errors.js";
import { rememberSecret } from "../core/redact.js";
import { readSecretArg } from "../core/secrets.js";
import { WEBHOOK_KEYS, markUntrusted } from "../core/untrusted.js";
import { checkForwardUrl } from "./voice-shared.js";

/** The signing secret: --secret (literal, @file or @- for stdin, like every other secret flag) or VOBIZ_WEBHOOK_SECRET. */
async function secretFrom(ctx: Ctx, flag: string | undefined, required: boolean): Promise<string | undefined> {
  if (flag) return readSecretArg(ctx, flag, "--secret");
  const env = ctx.env.VOBIZ_WEBHOOK_SECRET;
  if (env) {
    rememberSecret(env);
    return env;
  }
  if (required) throw new VobizError("invalid_input", "Give the signing secret with VOBIZ_WEBHOOK_SECRET or --secret (for voice callbacks it is your Auth Token).");
  return undefined;
}

/** `--body` value: literal text, @file (raw bytes) or @- (stdin). */
async function bodyFrom(ctx: Ctx, value: string): Promise<Buffer> {
  if (value === "@-") return Buffer.from(await ctx.stdin.read(), "utf8");
  if (value.startsWith("@")) {
    try {
      return readFileSync(value.slice(1));
    } catch (e) {
      throw new VobizError("not_found", `Cannot read ${value.slice(1)}: ${(e as Error).message}`);
    }
  }
  return Buffer.from(value, "utf8");
}

/** Headers worth showing for a webhook: content type, user agent and every Vobiz/webhook header. */
function interestingHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (k === "content-type" || k === "user-agent" || k.startsWith("x-vobiz-") || k.startsWith("x-webhook-")) out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/** Request headers relayed to --forward: only what a Vobiz webhook carries. Everything else (Cookie, Authorization, X-Forwarded-*, …) is dropped. */
function forwardHeaders(req: IncomingMessage, publicUrl: URL | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (k === "content-type" || k === "user-agent" || k === "accept" || k.startsWith("x-vobiz-") || k.startsWith("x-webhook-")) out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  const host = req.headers.host;
  if (host && /^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host)) out["x-forwarded-host"] = host;
  out["x-forwarded-proto"] = publicUrl ? publicUrl.protocol.slice(0, -1) : "http";
  return out;
}

/** Forward timeout: Vobiz gives up on a callback well before this. */
export const FORWARD_TIMEOUT_MS = 15_000;
/** Largest app response relayed back to the caller. */
export const MAX_RELAY_BYTES = 1024 * 1024;

/** Reads at most `limit` bytes of a fetch body (undefined when it is larger). */
async function readCapped(res: Response, limit: number): Promise<Buffer | undefined> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > limit) {
      await res.body.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

export interface ListenOptions {
  port: number;
  host: string;
  forward?: string;
  secret?: string;
  /** Public URL that Vobiz calls (the tunnel); its scheme and host are used to check URL-based signatures. */
  publicUrl?: string;
  /** "v3" refuses V2 voice-callback signatures. */
  scheme?: CallbackVersion;
  /** Skip the Host check (for a --allow-lan bind reached by LAN address). */
  anyHost?: boolean;
  /** Forward timeout in ms (default 15 s). */
  forwardTimeoutMs?: number;
}

/**
 * Starts the `webhooks listen` receiver; each request is printed to stdout as pretty JSON. With a secret, only
 * requests whose signature verifies (and whose nonce is new) are forwarded; the rest get 401.
 */
export async function startWebhookListener(ctx: Ctx, o: ListenOptions): Promise<LocalServer> {
  const publicUrl = o.publicUrl ? new URL(o.publicUrl) : undefined;
  const nonces = new NonceCache();
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    // Only origin-form targets ("/path?query"): absolute-form and "//host" would let a caller pick the signed URL.
    const path = requestPath(req.url);
    if (!path) {
      req.resume();
      res.writeHead(400, { "content-type": "text/plain", connection: "close" });
      res.end("bad request target\n");
      ctx.out.warn(`refused a request with request-target ${cleanLogText(req.url, 80)}`);
      return;
    }
    if (rejectMethod(req, res)) {
      ctx.out.warn(`refused a ${cleanLogText(req.method, 10)} request (only GET and POST are accepted)`);
      return;
    }
    // DNS-rebinding guard: with --public-url, the Host must be the tunnel's or a loopback name.
    const hostHeader = String(req.headers.host ?? "");
    const hostName = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (publicUrl && !o.anyHost && hostName.toLowerCase() !== publicUrl.hostname.toLowerCase() && !isLoopback(hostName)) {
      req.resume();
      res.writeHead(421, { "content-type": "text/plain", connection: "close" });
      res.end("misdirected request\n");
      ctx.out.warn(`refused a request for host ${cleanLogText(hostHeader, 80)}`);
      return;
    }
    const raw = await readBody(req);
    const u = new URL(req.url ?? "/", "http://localhost");
    const event: Record<string, unknown> = {
      received_at: ctx.now().toISOString(),
      method: req.method,
      path,
      query: Object.fromEntries(u.searchParams),
      headers: interestingHeaders(req),
      body: decodeBody(raw, req.headers["content-type"]) ?? null,
    };
    let verified = true;
    if (o.secret) {
      // The signed URL is the configured public origin plus the request's path, never anything the caller chose.
      const signedUrl = publicUrl ? `${publicUrl.origin}${path}` : undefined;
      const sig = verifyRequest(req.headers, signedUrl, raw, o.secret, { scheme: o.scheme, nonces });
      event.signature = sig;
      verified = sig.valid;
    } else event.signature = "not_checked"; // no --secret: anyone who knows the URL could have sent this
    let status = 200;
    let reply: Buffer | string = "";
    let replyType = "text/plain";
    if (!verified) {
      status = 401;
      reply = "invalid signature\n";
      if (o.forward) event.forwarded = { skipped: "signature not valid" };
      ctx.out.warn(`refused ${req.method} ${cleanLogText(path, 80)}: ${cleanLogText((event.signature as VerifyResult).reason ?? "invalid signature")}`);
    } else if (o.forward) {
      const target = new URL(o.forward);
      u.searchParams.forEach((v, k) => target.searchParams.append(k, v));
      try {
        const fwd = await ctx.fetch(target.toString(), {
          method: req.method,
          headers: forwardHeaders(req, publicUrl),
          body: req.method === "GET" ? undefined : new Uint8Array(raw),
          redirect: "manual",
          signal: AbortSignal.timeout(o.forwardTimeoutMs ?? FORWARD_TIMEOUT_MS),
        });
        status = fwd.status;
        event.forwarded = { url: target.toString(), status };
        const body = await readCapped(fwd, MAX_RELAY_BYTES);
        if (status >= 200 && status < 300 && body !== undefined) {
          replyType = fwd.headers.get("content-type") ?? "text/plain";
          reply = body;
        } else {
          // Error pages and redirects stay local: the caller gets the status and a generic body.
          reply = `upstream answered ${status}\n`;
          const text = body === undefined ? `(more than ${MAX_RELAY_BYTES} bytes)` : body.toString("utf8");
          ctx.out.warn(`your app answered ${status}${text ? `: ${cleanLogText(text, 500)}` : ""}`);
        }
      } catch (e) {
        const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
        status = timedOut ? 504 : 502;
        reply = timedOut ? "forward timed out\n" : "forward failed\n";
        event.forwarded = { url: target.toString(), error: timedOut ? `no answer within ${(o.forwardTimeoutMs ?? FORWARD_TIMEOUT_MS) / 1000}s` : (e as Error).message };
        ctx.out.warn(`could not forward to ${target.origin}: ${cleanLogText(timedOut ? "timed out" : (e as Error).message)}`);
      }
    }
    // Everything in the request came from the network: name those keys so an agent reading stdout treats them as data.
    ctx.stdout.write(JSON.stringify(markUntrusted(event, WEBHOOK_KEYS), null, 2) + "\n");
    res.writeHead(status, { "content-type": replyType, "x-content-type-options": "nosniff" });
    res.end(reply);
  };
  return startServer(handler, { port: o.port, host: o.host, onError: (e) => ctx.out.warn(`webhooks listen: ${cleanLogText((e as Error)?.message ?? e)}`) });
}

export function register(program: Command, ctx: Ctx): void {
  const webhooks = program.command("webhooks").description("Verify Vobiz webhook signatures and receive webhooks locally");

  webhooks
    .command("verify")
    .description("Check a Vobiz webhook signature (voice callback V3/V2, or a body HMAC for messaging, campaign, KYC and NDNC webhooks)")
    .requiredOption("--signature <value>", "the signature header value (X-Vobiz-Signature-V3, -V2, X-Webhook-Signature or X-Vobiz-Signature)")
    .option("--url <callback-url>", "voice callbacks: the full URL Vobiz called (the query string is ignored)")
    .option("--nonce <nonce>", "voice callbacks: the X-Vobiz-Signature-V3-Nonce (or -V2-Nonce) header value")
    .option("--scheme <v3|v2>", "voice callbacks: which signature version to check (default: try V3, then V2)")
    .option("--body <text|@file|@->", "body-signed webhooks: the raw request body, @file for a file, @- for stdin")
    .option("--secret <secret>", "signing secret: your Auth Token for voice callbacks (parent account's for -MA- headers), the subscription secret for messaging; @file or @- for stdin keeps it out of shell history (env: VOBIZ_WEBHOOK_SECRET)")
    .addHelpText(
      "after",
      `
Voice callbacks sign the URL plus a random nonce, never the body. Messaging, campaign, KYC and NDNC webhooks sign
the raw body (hex HMAC-SHA256, optionally prefixed "sha256="). Exit code 0 when the signature is valid, 1 when not.

Examples:
  export VOBIZ_WEBHOOK_SECRET=YOUR_AUTH_TOKEN
  vobiz webhooks verify --url https://example.com/answer --nonce 12345678901234567890 --signature 'q1w2…='
  vobiz webhooks verify --body @payload.json --signature sha256=5d41…

Docs: https://www.vobiz.ai/docs/concepts/validating-callbacks`,
    )
    .action(async (opts: { signature: string; url?: string; nonce?: string; scheme?: string; body?: string; secret?: string }) => {
      const urlMode = opts.url !== undefined || opts.nonce !== undefined;
      if (urlMode && opts.body !== undefined) throw new VobizError("invalid_input", "Use either --url with --nonce (voice callbacks) or --body (body-signed webhooks), not both.");
      if (!urlMode && opts.body === undefined) throw new VobizError("invalid_input", "Give --url and --nonce for a voice callback, or --body for a body-signed webhook.");
      let version: CallbackVersion | undefined;
      if (opts.scheme !== undefined) {
        const v = opts.scheme.toLowerCase();
        if (v !== "v3" && v !== "v2") throw new VobizError("invalid_input", "--scheme must be v3 or v2.");
        version = v;
      }
      if (opts.secret === "@-" && opts.body === "@-") throw new VobizError("invalid_input", "--secret @- and --body @- both read stdin; pass one of them as @file.");
      const secret = (await secretFrom(ctx, opts.secret, true))!;
      let result: VerifyResult;
      if (urlMode) {
        if (!opts.url || !opts.nonce) throw new VobizError("invalid_input", "Voice callbacks need both --url and --nonce.");
        try {
          new URL(opts.url);
        } catch {
          throw new VobizError("invalid_input", `--url is not a valid URL: ${opts.url}`);
        }
        result = verifyCallback({ url: opts.url, nonce: opts.nonce, signature: opts.signature, secret, version });
      } else {
        if (!isBodySignature(opts.signature)) throw new VobizError("invalid_input", 'Body signatures are 64 hex characters, optionally prefixed "sha256=". For voice callbacks use --url and --nonce.');
        result = verifyBody({ body: await bodyFrom(ctx, opts.body!), signature: opts.signature, secret });
      }
      if (ctx.out.mode === "table" || ctx.out.mode === "plain") {
        if (result.valid) ctx.out.success(`Signature is valid (${result.scheme === "callback-url" ? `voice callback ${result.version?.toUpperCase()}` : "body HMAC-SHA256"}).`);
        else ctx.out.status(`✗ Signature is NOT valid: ${result.reason}.`);
      } else ctx.out.print(result);
      if (!result.valid) ctx.exitCode = 1;
    });

  webhooks
    .command("listen")
    .description("Run a local webhook receiver that prints every request as JSON (and optionally forwards it)")
    .option("--port <port>", "port to listen on (0 picks a free one)", "4000")
    .option("--host <address>", "address to bind (default 127.0.0.1); anything else also needs --allow-lan", "127.0.0.1")
    .option("--allow-lan", "allow a non-loopback --host such as 0.0.0.0 (the receiver is then reachable from your network)")
    .option("--forward <url>", "also send each request to this URL (e.g. your app) and relay its 2xx response back to Vobiz")
    .option("--secret <secret>", "check each request's signature with this secret and refuse (401) any that fail; @file or @- for stdin keeps it out of shell history (env: VOBIZ_WEBHOOK_SECRET)")
    .option("--public-url <url>", "the https URL Vobiz calls (your tunnel); required to check voice-callback signatures")
    .addOption(new Option("--scheme <v3>", "refuse V2 voice-callback signatures (accept V3 only)").choices(["v3"]))
    .option("--allow-insecure-url", "allow a plain http:// --forward to a host other than localhost (bodies are sent unencrypted)")
    .addHelpText(
      "after",
      `
Each request is printed to stdout as pretty JSON (method, path, query, Vobiz headers, the full decoded body and,
with a secret, the signature result); bodies include phone numbers and message text. Without --forward it answers
200 with an empty body. Only GET and POST with a plain path are accepted. Stop with Ctrl-C.

With --secret, a request whose signature does not verify, or whose nonce was already used, gets 401 and is not
forwarded. Without --secret, --forward relays every request to your app, from anyone who knows the URL. Only
Content-Type, User-Agent, Accept and X-Vobiz-*/X-Webhook-* headers are forwarded, plus X-Forwarded-Host/-Proto;
your app's non-2xx answers are printed here and the caller only gets the status.

Examples:
  vobiz webhooks listen --port 4000
  vobiz webhooks listen --forward http://localhost:8080/vobiz/hangup --public-url https://abc.trycloudflare.com`,
    )
    .action(
      async (opts: { port?: string; host: string; allowLan?: boolean; forward?: string; secret?: string; publicUrl?: string; scheme?: "v3"; allowInsecureUrl?: boolean }) => {
        if (opts.forward !== undefined) checkForwardUrl(opts.forward, "--forward", { allowInsecure: opts.allowInsecureUrl });
        for (const [flag, value] of [["--forward", opts.forward], ["--public-url", opts.publicUrl]] as const) {
          if (value === undefined) continue;
          try {
            const u = new URL(value);
            if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
          } catch {
            throw new VobizError("invalid_input", `${flag} must be an http(s) URL.`);
          }
        }
        checkBindHost(ctx, opts.host, opts.allowLan);
        const secret = await secretFrom(ctx, opts.secret, false);
        const server = await startWebhookListener(ctx, {
          port: parsePort(opts.port, 4000),
          host: opts.host,
          forward: opts.forward,
          secret,
          publicUrl: opts.publicUrl,
          scheme: opts.scheme,
          anyHost: !!opts.allowLan,
        });
        ctx.out.status(`Listening for webhooks at ${server.url} (bound to ${server.bind})${opts.forward ? `, forwarding to ${opts.forward}` : ""} (Ctrl-C to stop).`);
        ctx.out.status(tunnelHint(server.port));
        if (secret && !opts.publicUrl)
          ctx.out.warn("Voice-callback signatures cover the public URL: without --public-url (your tunnel URL) they cannot be checked and those requests get 401.");
        if (opts.forward && !secret) ctx.out.warn("--forward without --secret relays every request to your app, from anyone who knows this URL.");
        await untilInterrupted();
        await server.close();
      },
    );
}
