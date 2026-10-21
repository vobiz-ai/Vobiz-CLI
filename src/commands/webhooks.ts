/**
 * `vobiz webhooks verify|listen`: check Vobiz webhook (callback) signatures and receive webhooks locally while
 * developing. Needs no credentials: the signing secret comes from --secret or VOBIZ_WEBHOOK_SECRET.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Command } from "commander";
import { decodeBody, parsePort, readBody, startServer, tunnelHint, untilInterrupted, type LocalServer } from "../agent/http.js";
import { isBodySignature, verifyBody, verifyCallback, verifyRequest, type CallbackVersion, type VerifyResult } from "../agent/webhooks.js";
import type { Ctx } from "../core/context.js";
import { VobizError } from "../core/errors.js";
import { checkForwardUrl } from "./voice-shared.js";

function secretFrom(ctx: Ctx, flag: string | undefined, required: boolean): string | undefined {
  if (flag) {
    ctx.out.warn("--secret is saved in your shell history. Prefer VOBIZ_WEBHOOK_SECRET.");
    return flag;
  }
  const env = ctx.env.VOBIZ_WEBHOOK_SECRET;
  if (env) return env;
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

const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "proxy-connection"]);

export interface ListenOptions {
  port: number;
  host: string;
  forward?: string;
  secret?: string;
  /** Public URL that Vobiz calls (the tunnel), used to check URL-based signatures. */
  publicUrl?: string;
}

/** Starts the `webhooks listen` receiver; each request is printed to stdout as pretty JSON. */
export async function startWebhookListener(ctx: Ctx, o: ListenOptions): Promise<LocalServer> {
  let base = "";
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await readBody(req);
    const u = new URL(req.url ?? "/", "http://localhost");
    const event: Record<string, unknown> = {
      received_at: ctx.now().toISOString(),
      method: req.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: interestingHeaders(req),
      body: decodeBody(raw, req.headers["content-type"]) ?? null,
    };
    if (o.secret) {
      const signedUrl = new URL(req.url ?? "/", o.publicUrl ?? base).toString();
      event.signature = verifyRequest(req.headers, signedUrl, raw, o.secret);
    }
    let status = 200;
    let reply: Buffer | string = "";
    let replyType = "text/plain";
    if (o.forward) {
      const target = new URL(o.forward);
      u.searchParams.forEach((v, k) => target.searchParams.append(k, v));
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      try {
        const fwd = await ctx.fetch(target.toString(), {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(raw),
          redirect: "manual",
        });
        status = fwd.status;
        replyType = fwd.headers.get("content-type") ?? "text/plain";
        reply = Buffer.from(await fwd.arrayBuffer());
        event.forwarded = { url: target.toString(), status };
      } catch (e) {
        status = 502;
        reply = "forward failed\n";
        event.forwarded = { url: target.toString(), error: (e as Error).message };
        ctx.out.warn(`could not forward to ${target.origin}: ${(e as Error).message}`);
      }
    }
    ctx.stdout.write(JSON.stringify(event, null, 2) + "\n");
    res.writeHead(status, { "content-type": replyType });
    res.end(reply);
  };
  const server = await startServer(handler, { port: o.port, host: o.host });
  base = server.url;
  return server;
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
    .option("--secret <secret>", "signing secret: your Auth Token for voice callbacks (parent account's for -MA- headers), the subscription secret for messaging (env: VOBIZ_WEBHOOK_SECRET)")
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
      const secret = secretFrom(ctx, opts.secret, true)!;
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
    .option("--host <address>", "address to bind; use 0.0.0.0 to accept connections from other machines", "127.0.0.1")
    .option("--forward <url>", "also send each request to this URL (e.g. your app) and relay its response back to Vobiz")
    .option("--secret <secret>", "check each request's signature with this secret (env: VOBIZ_WEBHOOK_SECRET)")
    .option("--public-url <url>", "the https URL Vobiz calls (your tunnel), needed to check voice-callback signatures")
    .option("--allow-insecure-url", "allow a plain http:// --forward to a host other than localhost (bodies are sent unencrypted)")
    .addHelpText(
      "after",
      `
Each request is printed to stdout as pretty JSON (method, path, query, Vobiz headers, decoded body and, with a
secret, the signature result). Without --forward it answers 200 with an empty body. Stop with Ctrl-C.

Examples:
  vobiz webhooks listen --port 4000
  vobiz webhooks listen --forward http://localhost:8080/vobiz/hangup --public-url https://abc.trycloudflare.com`,
    )
    .action(async (opts: { port?: string; host: string; forward?: string; secret?: string; publicUrl?: string; allowInsecureUrl?: boolean }) => {
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
      const secret = secretFrom(ctx, opts.secret, false);
      const server = await startWebhookListener(ctx, { port: parsePort(opts.port, 4000), host: opts.host, forward: opts.forward, secret, publicUrl: opts.publicUrl });
      ctx.out.status(`Listening for webhooks at ${server.url}${opts.forward ? `, forwarding to ${opts.forward}` : ""} (Ctrl-C to stop).`);
      ctx.out.status(tunnelHint(server.port));
      if (secret && !opts.publicUrl) ctx.out.status("Voice-callback signatures cover the public URL; pass --public-url with your tunnel URL to check them.");
      await untilInterrupted();
      await server.close();
    });
}
