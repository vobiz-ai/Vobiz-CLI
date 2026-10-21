/**
 * Small helpers for the local development servers (`xml serve`, `webhooks listen`): start a node:http server,
 * read request bodies, decode form/JSON payloads, and wait for Ctrl-C.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { VobizError } from "../core/errors.js";
import { tryParseIntStrict } from "../core/parse.js";

export interface LocalServer {
  server: Server;
  /** http://host:port with the actual port (useful with --port 0). */
  url: string;
  port: number;
  close(): Promise<void>;
}

export const MAX_BODY_BYTES = 1_000_000;

export function parsePort(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const n = tryParseIntStrict(text, { min: 0, max: 65535 });
  if (n === undefined) throw new VobizError("invalid_input", `--port must be a number from 0 to 65535 (got "${text}").`);
  return n;
}

export async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  opts: { port: number; host: string },
): Promise<LocalServer> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(`error: ${(err as Error)?.message ?? err}\n`);
    });
  });
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
  const port = (server.address() as AddressInfo).port;
  const host = opts.host === "0.0.0.0" || opts.host === "::" ? "localhost" : opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return {
    server,
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = typeof c === "string" ? Buffer.from(c) : (c as Buffer);
    size += b.length;
    if (size > limit) throw new VobizError("invalid_input", `request body is larger than ${limit} bytes`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
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
