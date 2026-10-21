/**
 * Helpers shared by the voice command groups (account, calls, conferences, recordings, cdr). They sit next to
 * the commands rather than in core because only these groups use them: argument parsers, call-control URL
 * checks, list printing that keeps the raw response shape for JSON, call status polling, and a streaming GET
 * for CSV exports and recording downloads (the core client buffers bodies and always asks for JSON).
 */
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { InvalidArgumentError, type Command } from "commander";
import { DryRunSignal } from "../core/client.js";
import type { Ctx } from "../core/context.js";
import { VobizError, extractBackendMessage, kindForStatus, usage } from "../core/errors.js";
import { op, type Operation } from "../core/ops.js";
import type { PageResult } from "../core/pagination.js";
import { toE164 } from "../core/phone.js";
import { USER_AGENT } from "../core/version.js";

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** Commander parser for whole numbers in [min, max]. */
export function intArg(min = 1, max = Number.MAX_SAFE_INTEGER) {
  return (value: string): number => {
    const n = Number(value);
    if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n < min || n > max)
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
  /** File to write; stdout when undefined. Written to `<file>.part` and renamed when complete. */
  out?: string;
}

/**
 * Streams an operation's response (CDR CSV export) to a file or stdout. Uses the client for the URL and dry-run
 * output, then fetches itself so the body is not buffered and `Accept` is the CSV type the endpoint expects.
 */
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
  if (!res.body) {
    if (target.out) await pipeline(Readable.from([]), createWriteStream(target.out, { mode: 0o600 }));
    return 0;
  }
  const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  let bytes = 0;
  if (!target.out) {
    const decoder = new TextDecoder();
    for await (const chunk of body) {
      bytes += (chunk as Uint8Array).length;
      ctx.stdout.write(decoder.decode(chunk as Uint8Array, { stream: true }));
    }
    ctx.stdout.write(decoder.decode());
    return bytes;
  }
  const part = `${target.out}.part`;
  const count = async function* (src: AsyncIterable<Uint8Array>) {
    for await (const chunk of src) {
      bytes += chunk.length;
      yield chunk;
    }
  };
  try {
    await pipeline(body, count, createWriteStream(part, { mode: 0o600 }));
    await rename(part, target.out);
  } catch (err) {
    await rm(part, { force: true });
    throw new VobizError("network_error", `The download was interrupted: ${(err as Error).message}`);
  }
  return bytes;
}
