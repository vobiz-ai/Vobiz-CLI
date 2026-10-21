/**
 * Small helpers for the local development servers (`xml serve`, `webhooks listen`, `streams forward`,
 * `calls create --serve`): start a node:http server with connection caps and timeouts, read request bodies, decode
 * form/JSON payloads, guard the bind address and URL path tokens, sanitise remote text before it reaches a terminal,
 * and wait for Ctrl-C.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Ctx } from "../core/context.js";
import { VobizError, usage } from "../core/errors.js";
import { tryParseIntStrict } from "../core/parse.js";

export interface LocalServer {
  server: Server;
  /** A URL a local client can open, with the actual port (useful with --port 0); wildcard binds show `localhost`. */
  url: string;
  port: number;
  /** The real bind address and port (`0.0.0.0:3000`, `[::]:3000`, `127.0.0.1:3000`), for banners. */
  bind: string;
  close(): Promise<void>;
}

/** Vobiz callbacks are a few KB; 256 KiB leaves room for large messaging payloads. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Default cap on simultaneous connections per local server. */
export const MAX_CONNECTIONS = 64;
/** Default idle timeout for a local server's sockets. */
export const IDLE_TIMEOUT_MS = 30_000;

/**
 * Makes remote-originated text safe to print to a terminal: removes ANSI/OSC escape sequences, replaces every other
 * C0/C1 control character and DEL with `?`, and caps the length. Use it for anything a caller sent (paths, form
 * fields, event names, close reasons) before it goes to stderr or a table.
 */
export function safeLogText(value: unknown, max = 200): string {
  let s = String(value ?? "");
  s = s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "") // OSC … BEL / ST
    .replace(/\x1b[P^_][^\x1b]*(?:\x1b\\)?/g, "") // DCS, PM, APC … ST
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, "") // CSI
    .replace(/\x9b[0-?]*[ -/]*[@-~]?/g, "") // 8-bit CSI
    .replace(/\x1b[ -/]*[0-~]?/g, "") // other ESC sequences
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

const LOOPBACK_NAMES = new Set(["localhost", "::1", "[::1]", "ip6-localhost"]);
/** True for a loopback bind address or Host name (127.0.0.0/8, ::1, localhost). */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase();
  return LOOPBACK_NAMES.has(h) || /^127(?:\.\d{1,3}){3}$/.test(h) || h === "::ffff:127.0.0.1";
}

/**
 * Refuses a non-loopback `--host` unless `--allow-lan` was given, and prints a loud warning when it was: the
 * server then answers anyone on the network.
 */
export function checkBindHost(ctx: Ctx, host: string, allowLan: boolean | undefined): void {
  if (isLoopback(host)) return;
  if (!allowLan)
    throw usage(`--host ${host} makes this server reachable from other machines. Pass --allow-lan as well if that is what you want, or keep the default 127.0.0.1.`);
  ctx.out.warn(`WARNING: listening on ${host} exposes this server to your network (anyone who can reach this machine can use it).`);
}

/** A random URL path token: 128 bits, URL-safe. */
export const newToken = (): string => randomBytes(16).toString("base64url");

/** Valid shape for a user-supplied path token. */
export function checkToken(token: string, flag = "--token"): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw usage(`${flag} must be 16-128 characters of A-Z, a-z, 0-9, "-" and "_".`);
  return token;
}

/** Path of a request-target (`/a/b?x=1` → `/a/b`); undefined for absolute-form, `//host` or other non-path targets. */
export function requestPath(target: string | undefined): string | undefined {
  if (!target || target[0] !== "/" || target.startsWith("//")) return undefined;
  try {
    return new URL(target, "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

/** True when `path` is `/<token>` or `/<token>/…` (compared in constant time). */
export function pathHasToken(path: string | undefined, token: string): boolean {
  if (!path) return false;
  const first = path.slice(1).split("/")[0];
  const a = Buffer.from(first);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A request-target for logs: the path token replaced by `…` and the result made terminal-safe. */
export function logPath(target: string | undefined, token?: string): string {
  let t = target ?? "";
  if (token) t = t.split(token).join("…");
  return safeLogText(t, 120);
}

/** Masks a value from a caller (DTMF digits, speech, phone numbers) for logs, keeping only a hint of its shape. */
export function maskSensitive(key: string, value: unknown): string {
  const v = String(value ?? "");
  if (/^(from|to|caller|callee|forwardedfrom|number)$/i.test(key)) return v.length > 4 ? `${"*".repeat(Math.min(v.length - 4, 12))}${safeLogText(v.slice(-4), 4)}` : "****";
  return `<${v.length} chars hidden>`;
}

export function parsePort(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const n = tryParseIntStrict(text, { min: 0, max: 65535 });
  if (n === undefined) throw new VobizError("invalid_input", `--port must be a number from 0 to 65535 (got "${text}").`);
  return n;
}

export interface ServerOptions {
  port: number;
  host: string;
  /** Simultaneous connections; further ones are dropped (default 64). */
  maxConnections?: number;
  /** Idle socket timeout in ms (default 30 s). */
  idleTimeoutMs?: number;
  /** Called with the real error when a handler throws; the caller only sees a generic 500. */
  onError?: (err: unknown) => void;
}

export async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, opts: ServerOptions): Promise<LocalServer> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      const tooLarge = err instanceof BodyTooLarge;
      if (!tooLarge) opts.onError?.(err);
      if (!res.headersSent) res.writeHead(tooLarge ? 413 : 500, { "content-type": "text/plain", connection: "close" });
      res.end(tooLarge ? "request body too large\n" : "internal error\n");
    });
  });
  server.maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "EADDRINUSE"
          ? new VobizError("invalid_input", `Port ${opts.port} is already in use. Pick another with --port.`)
          : new VobizError("internal_error", `Cannot listen on ${opts.host}:${opts.port}: ${err.message}`),
      ),
    );
    server.listen(opts.port, opts.host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const bracket = (h: string) => (h.includes(":") ? `[${h}]` : h);
  const host = opts.host === "0.0.0.0" || opts.host === "::" ? "localhost" : bracket(opts.host);
  return {
    server,
    url: `http://${host}:${port}`,
    port,
    bind: `${bracket(addr.address)}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

class BodyTooLarge extends VobizError {
  constructor(limit: number) {
    super("invalid_input", `request body is larger than ${limit} bytes`);
  }
}

export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge(limit);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = typeof c === "string" ? Buffer.from(c) : (c as Buffer);
    size += b.length;
    if (size > limit) throw new BodyTooLarge(limit);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** Answers 405 unless the method is GET or POST (true when it did). */
export function rejectMethod(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "GET" || req.method === "POST") return false;
  req.resume();
  res.writeHead(405, { allow: "GET, POST", "content-type": "text/plain", connection: "close" });
  res.end("method not allowed\n");
  return true;
}

/** Answers 404 with a fixed body. */
export function notFound(req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  res.writeHead(404, { "content-type": "text/plain", connection: "close" });
  res.end("not found\n");
}

/** Decodes a body for display: urlencoded forms and JSON become objects, anything else stays text. */
export function decodeBody(raw: Buffer, contentType: string | undefined): unknown {
  if (!raw.length) return undefined;
  const text = raw.toString("utf8");
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  if (ct.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Resolves on Ctrl-C / SIGTERM (or when `signal` aborts), so a dev server runs until the user stops it. */
export function untilInterrupted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export const tunnelHint = (port: number) =>
  `To reach it from Vobiz, expose it over https, e.g. \`cloudflared tunnel --url http://localhost:${port}\` or \`ngrok http ${port}\`, and use the https URL it prints.`;
