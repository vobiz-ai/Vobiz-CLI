/**
 * Helpers shared by the voice command groups (account, calls, conferences, recordings, cdr). They sit next to
 * the commands rather than in core because only these groups use them: argument parsers, call-control URL
 * checks, list printing that keeps the raw response shape for JSON, call status polling, and a streaming GET
 * for CSV exports and recording downloads (the core client buffers bodies and always asks for JSON).
 */
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { InvalidArgumentError, type Command } from "commander";
import { DryRunSignal } from "../core/client.js";
import type { Ctx } from "../core/context.js";
import { VobizError, extractBackendMessage, kindForStatus, usage } from "../core/errors.js";
import { writeStreamAtomicExclusive } from "../core/fsafe.js";
import { op, type Operation } from "../core/ops.js";
import { tryParseIntStrict } from "../core/parse.js";
import type { PageResult } from "../core/pagination.js";
import { toE164 } from "../core/phone.js";
import { cleanMessage } from "../core/sanitize.js";
import { USER_AGENT } from "../core/version.js";

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** Commander parser for whole numbers in [min, max]. */
export function intArg(min = 1, max = Number.MAX_SAFE_INTEGER) {
  return (value: string): number => {
    const n = tryParseIntStrict(value, { min, max }) ?? NaN;
    if (Number.isNaN(n))
      throw new InvalidArgumentError(`expected a whole number between ${min} and ${max}.`);
    return n;
  };
}

/** Commander parser for a positive number of seconds (fractions allowed). */
export function secondsArg(max = 86_400) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > max) throw new InvalidArgumentError(`expected a number of seconds between 0 and ${max}.`);
    return n;
  };
}

/** Commander collector for repeatable options. */
export const collect = (value: string, prev: string[] = []): string[] => [...prev, value];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Validates a URL that Vobiz will fetch or connect to during a call. https (or wss for audio streams) is
 * required; plain http/ws is accepted only for localhost and only with --allow-insecure-url.
 */
export function checkUrl(raw: string, flag: string, opts: { allowInsecure?: boolean; websocket?: boolean } = {}): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw usage(`${flag} is not a valid URL: "${raw}".`);
  }
  const [secure, insecure] = opts.websocket ? ["wss:", "ws:"] : ["https:", "http:"];
  if (u.protocol === secure) return raw;
  if (u.protocol === insecure) {
    if (opts.allowInsecure && LOCAL_HOSTS.has(u.hostname)) return raw;
    throw usage(
      `${flag} must use ${secure.slice(0, -1)}:// (${insecure.slice(0, -1)}:// is allowed only for localhost together with --allow-insecure-url).`,
    );
  }
  throw usage(`${flag} must be a ${secure.slice(0, -1)}:// URL (got ${u.protocol.slice(0, -1)}://).`);
}

/**
 * True for a hostname that names this machine or a private network: localhost names, loopback, unspecified,
 * link-local (including cloud metadata at 169.254.169.254), RFC 1918, CGNAT, and IPv6 ULA/link-local/mapped forms.
 * Literal addresses and well-known names only; names are not resolved.
 */
export function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") || h === "metadata.google.internal") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h.replace(/^::ffff:/, ""));
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) {
    if (h === "::" || h === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h)) return true; // IPv4-mapped in hex form: treat as internal
  }
  return false;
}

/** True for localhost names and loopback addresses (`127.0.0.0/8`, `[::1]`). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Validates a URL the CLI itself sends live data to (`streams forward --to`, `webhooks listen --forward`):
 * wss:// / https:// anywhere, plain ws:// / http:// only on a loopback host unless `allowInsecure` is set,
 * because call audio and webhook bodies (phone numbers) would otherwise cross the network in cleartext.
 */
export function checkForwardUrl(raw: string, flag: string, opts: { websocket?: boolean; allowInsecure?: boolean } = {}): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw usage(`${flag} is not a valid URL: "${raw}".`);
  }
  const [secure, insecure] = opts.websocket ? ["wss:", "ws:"] : ["https:", "http:"];
  if (u.protocol === secure) return raw;
  if (u.protocol !== insecure) throw usage(`${flag} must be a ${secure.slice(0, -1)}:// or ${insecure.slice(0, -1)}:// URL (got ${u.protocol.slice(0, -1)}://).`);
  if (isLoopbackHost(u.hostname) || opts.allowInsecure) return raw;
  throw usage(
    `${flag} uses ${insecure.slice(0, -1)}:// to ${u.hostname}, which would send the data unencrypted. Use ${secure.slice(0, -1)}://, a localhost URL, or pass --allow-insecure-url.`,
  );
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A call destination: E.164 numbers are normalised, SIP URIs pass through. */
export function normalizeDestination(value: string): string {
  const v = value.trim();
  if (/^sips?:/i.test(v)) return v;
  return toE164(v);
}

/** `--to` may fan out to several destinations joined with `<` (the API's separator, max 1000). */
export function normalizeDestinations(value: string): string[] {
  const parts = value.split("<").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw usage("--to is empty.");
  if (parts.length > 1000) throw usage(`--to has ${parts.length} destinations; the API accepts at most 1000 per request.`);
  return parts.map(normalizeDestination);
}

export interface ListFlags {
  limit?: number;
  all?: boolean;
}

/** Adds --limit/--all to a list command. */
export function addListFlags(cmd: Command, defaultLimit: number): Command {
  return cmd
    .option("--limit <n>", `maximum number of rows to fetch (default: ${defaultLimit})`, intArg(1, 100_000))
    .option("--all", "fetch every page");
}

export interface ListPrint {
  /** Where the rows live in the raw body, for rebuilding it in JSON mode. */
  itemsKey: string;
  columns: string[];
  idKey?: string;
  empty?: string;
}

/**
 * Prints a paginated result. JSON and YAML keep the API's own response shape (the last page with every
 * fetched row in `itemsKey`) so scripts see the documented body; other modes print the rows as a table.
 */
export function printPage(ctx: Ctx, page: PageResult<unknown>, p: ListPrint): void {
  const mode = ctx.out.mode;
  if ((mode === "json" || mode === "yaml") && !ctx.flags.fields?.length && !ctx.flags.quiet && isRec(page.last)) {
    const body = setPath(page.last, p.itemsKey, page.items);
    // `count` describes the rows in this body; keep it true after merging pages.
    if (page.pages > 1 && typeof body.count === "number") body.count = page.items.length;
    ctx.out.print(body);
    return;
  }
  ctx.out.print(page.items, { columns: p.columns, idKey: p.idKey, empty: p.empty });
  if (page.hasMore && mode !== "json" && mode !== "yaml") {
    const of = page.total !== undefined ? ` of ${page.total}` : "";
    ctx.out.status(`Showing ${page.items.length}${of}. Use --limit <n> or --all for more.`);
  }
}

function setPath(body: Rec, path: string, value: unknown): Rec {
  const [head, ...rest] = path.split(".");
  if (!rest.length) return { ...body, [head]: value };
  const inner = isRec(body[head]) ? (body[head] as Rec) : {};
  return { ...body, [head]: setPath(inner, rest.join("."), value) };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `YYYY-MM-DD HH:MM:SS` in local time (the recording export format). */
export function toYmdHms(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Writes a confirmation-free "nothing to do" for --dry-run on work that does not go through the client. */
export function dryRunNote(ctx: Ctx, what: string): boolean {
  if (!ctx.flags.dryRun) return false;
  ctx.stderr.write(`[dry-run] ${what}\n`);
  return true;
}

// ── Call status polling (calls create --wait, calls watch) ──

const GET_LIVE_CALL = op("get-live-call");
const GET_QUEUED_CALL = op("get-queued-call");
const GET_CDR = op("get-cdr");

const TERMINAL = new Set(["completed", "failed", "busy", "no-answer", "canceled", "cancelled", "timeout", "rejected", "hangup", "ended"]);

export interface WatchOptions {
  /** Seconds between polls. */
  interval: number;
  /** Give up after this many seconds. */
  maxWait: number;
}

export interface WatchResult {
  call_uuid: string;
  /** Last status seen: queued, ringing, in-progress, …, or "ended" once the CDR is in. */
  status: string;
  /** The finalized call record, when it was found. */
  cdr?: Rec;
  /** The last live/queued call object seen. */
  call?: Rec;
}

const isNotFound = (e: unknown) => e instanceof VobizError && e.kind === "not_found";

/**
 * Polls a call until it ends: the live record while it is up (queued record before it connects), then the CDR
 * once it is gone. Status changes are printed to stderr. Throws `timeout` (exit 8) after maxWait seconds.
 */
export async function watchCall(ctx: Ctx, uuid: string, o: WatchOptions): Promise<WatchResult> {
  const started = ctx.now().getTime();
  let last: string | undefined;
  let call: Rec | undefined;
  const report = (s: string) => {
    if (s !== last) ctx.out.status(`call ${uuid}: ${s}`);
    last = s;
  };
  for (;;) {
    let gone = false;
    try {
      const live = await ctx.client.call<Rec>(GET_LIVE_CALL, { path: { call_uuid: uuid }, query: { status: "live" }, dryRun: false });
      call = isRec(live) ? live : call;
      const s = String(call?.call_status ?? "in-progress");
      report(s);
      if (TERMINAL.has(s.toLowerCase())) gone = true;
    } catch (e) {
      if (!isNotFound(e)) throw e;
      try {
        const q = await ctx.client.call<Rec>(GET_QUEUED_CALL, { path: { call_uuid: uuid }, query: { status: "queued" }, dryRun: false });
        call = isRec(q) ? q : call;
        report(String(call?.call_status ?? "queued"));
      } catch (e2) {
        if (!isNotFound(e2)) throw e2;
        gone = true;
      }
    }
    if (gone) {
      try {
        const body = await ctx.client.call<Rec>(GET_CDR, { path: { call_id: uuid }, dryRun: false });
        const cdr = isRec(body?.data) ? (body.data as Rec) : body;
        report("ended");
        return { call_uuid: uuid, status: "ended", cdr, ...(call ? { call } : {}) };
      } catch (e) {
        if (!isNotFound(e)) throw e;
        report(last && last !== "in-progress" && last !== "queued" ? last : "ended, waiting for the call record");
      }
    }
    if ((ctx.now().getTime() - started) / 1000 + o.interval > o.maxWait)
      throw new VobizError("timeout", `Call ${uuid} did not reach a final state within ${o.maxWait}s (last status: ${last ?? "unknown"}). Check it with \`vobiz calls watch ${uuid}\`.`);
    await sleep(o.interval * 1000);
  }
}

// ── Streaming GET (CSV export, recording download) ──

export interface StreamTarget {
  /** File to write; stdout when undefined. Written to a random exclusive `<file>.<hex>.part` and moved into place when complete. */
  out?: string;
  /** Replace an existing regular file at `out` (symlinks are always refused). */
  force?: boolean;
  /** Stop with an error past this many bytes (default MAX_DOWNLOAD_BYTES). */
  maxBytes?: number;
}

/** Largest body a download or export may stream (2 GiB): a hostile or broken server cannot fill the disk. */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 ** 3;

/**
 * Re-yields `src`, failing when no chunk arrives for `idleMs` or the total passes `maxBytes`. `onChunk` sees
 * every chunk (for counting).
 */
export function guardStream(label: string, idleMs: number, maxBytes: number, onChunk: (n: number) => void) {
  return async function* (src: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    const it = src[Symbol.asyncIterator]();
    let total = 0;
    try {
      for (;;) {
        let timer: NodeJS.Timeout | undefined;
        const idle = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new VobizError("timeout", `${label}: no data for ${Math.round(idleMs / 1000)}s; the download stalled.`)), idleMs);
        });
        let r: IteratorResult<Uint8Array>;
        try {
          r = await Promise.race([it.next(), idle]);
        } finally {
          clearTimeout(timer);
        }
        if (r.done) return;
        total += r.value.length;
        if (total > maxBytes) throw new VobizError("unexpected_response", `${label}: the response is larger than ${maxBytes} bytes; stopped.`);
        onChunk(r.value.length);
        yield r.value;
      }
    } finally {
      await it.return?.().catch(() => undefined);
    }
  };
}

export async function streamOperation(ctx: Ctx, operation: Operation, query: Rec, accept: string, target: StreamTarget): Promise<number> {
  const client = ctx.client;
  const path = client.fillPath(operation.path);
  if (ctx.flags.dryRun) {
    const req = client.prepare(operation.api, operation.method, path, { query }, operation.id);
    req.headers.Accept = accept;
    throw new DryRunSignal(req);
  }
  const url = client.buildUrl(operation.api, path, query);
  const c = ctx.creds;
  const headers = { "X-Auth-ID": c.authId, "X-Auth-Token": c.authToken, Accept: accept, "User-Agent": USER_AGENT };
  return streamUrl(ctx, url, headers, `${operation.method} ${operation.path}`, target);
}

const MAX_REDIRECTS = 5;
const AUTH_HEADERS = new Set(["x-auth-id", "x-auth-token", "authorization"]);

/**
 * GETs `url` and streams the body to `target`. Only the headers wait for the --timeout. Redirects are followed
 * here (at most 5), never by fetch: a redirect must stay on https, and the auth headers are dropped as soon as
 * the origin differs from the original URL's (fetch would forward custom headers to any host).
 */
export async function streamUrl(ctx: Ctx, url: URL, headers: Record<string, string>, label: string, target: StreamTarget): Promise<number> {
  const controller = new AbortController();
  const timeoutMs = ctx.flags.timeout * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let res: Response;
  let current = url;
  let sent = headers;
  try {
    for (let hop = 0; ; hop++) {
      try {
        res = await ctx.fetch(current, { method: "GET", headers: sent, signal: controller.signal, redirect: "manual" });
      } catch {
        throw controller.signal.aborted
          ? new VobizError("timeout", `${current.host} did not respond within ${Math.round(timeoutMs / 1000)}s.`)
          : new VobizError("network_error", `Could not reach ${current.host}.`);
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      await res.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new VobizError("unexpected_response", `${label}: more than ${MAX_REDIRECTS} redirects.`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new VobizError("unexpected_response", `${label}: the server redirected to an invalid URL.`);
      }
      if (next.protocol !== "https:") throw new VobizError("unexpected_response", `${label}: refusing to follow a redirect to ${next.protocol} (expected https).`);
      if (next.origin !== url.origin) sent = Object.fromEntries(Object.entries(sent).filter(([k]) => !AUTH_HEADERS.has(k.toLowerCase())));
      ctx.log("verbose", `${label} -> ${res.status} redirect to ${next.host}`);
      current = next;
    }
  } finally {
    clearTimeout(timer);
  }
  ctx.log("verbose", `${label} -> ${res.status} (${Date.now() - started}ms)`);
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => "");
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    throw new VobizError(kindForStatus(res.status), extractBackendMessage(data) ?? `HTTP ${res.status}`, res.status);
  }
  const body: AsyncIterable<Uint8Array> = res.body ? Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>) : Readable.from([]);
  let bytes = 0;
  const guard = guardStream(label, timeoutMs, target.maxBytes ?? MAX_DOWNLOAD_BYTES, (n) => {
    bytes += n;
  });
  if (!target.out) {
    // A terminal gets the text with escape sequences removed; a pipe or file gets the bytes verbatim.
    const tty = !!ctx.stdout.isTTY;
    const decoder = new TextDecoder();
    const write = async (text: string) => {
      if (!text) return;
      const ok = ctx.stdout.write(tty ? cleanMessage(text) : text);
      const s = ctx.stdout as { once?: (ev: string, fn: () => void) => unknown };
      if (ok === false && typeof s.once === "function") await new Promise<void>((resolve) => s.once!("drain", resolve));
    };
    for await (const chunk of guard(body)) await write(decoder.decode(chunk, { stream: true }));
    await write(decoder.decode());
    return bytes;
  }
  try {
    await writeStreamAtomicExclusive(target.out, body, { overwrite: !!target.force, transforms: [guard] });
  } catch (err) {
    if (err instanceof VobizError) throw err;
    throw new VobizError("network_error", `The download was interrupted: ${(err as Error).message}`);
  }
  return bytes;
}
