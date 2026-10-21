/**
 * Thin client for the Vobiz REST APIs (voice gateway `https://api.vobiz.ai` and the Messaging API under
 * `https://api.vobiz.ai/api/v1/sms`). Every request is described by an Operation from the vendored spec, so
 * paths and casing (`/Account/`, `/account/`, `/accounts/`) are exactly what the API expects.
 *
 * - `{auth_id}` and `{account_id}` are always filled from the resolved credentials, never from user input:
 *   the gateway rejects account paths that are not the caller's, and the CLI never lets a positional pick one.
 * - Other path params are `encodeURIComponent`-ed (a `+` in an E.164 number becomes `%2B`).
 * - No automatic retries. A transport failure on a side-effecting request (calls, messages, purchases) becomes
 *   `outcome_unknown`, because the request may have reached Vobiz.
 * - The token travels only in the `X-Auth-Token` header; logs and dry-run output never contain it.
 */
import type { ResolvedCredentials } from "./credentials.js";
import { VobizError, extractBackendMessage, kindForStatus } from "./errors.js";
import type { Api, HttpMethod, Operation } from "../generated/operations.js";
import { REDACTED, redact } from "./redact.js";
import { USER_AGENT } from "./version.js";

export type LogLevel = "warn" | "info" | "verbose" | "debug";
export type Logger = (level: LogLevel, message: string) => void;

export interface ClientOptions {
  /** Credentials, or a thunk so they are resolved (and missing ones reported) only when a request is made. */
  creds: ResolvedCredentials | (() => ResolvedCredentials);
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: Logger;
  /** Global --dry-run; a per-call `dryRun` overrides it. */
  dryRun?: boolean | (() => boolean);
}

export interface CallArgs {
  /** Path params other than auth_id/account_id (those come from the credentials). */
  path?: Record<string, string | number>;
  /** Query params; undefined, null and "" are dropped, arrays repeat the key. */
  query?: Record<string, unknown>;
  /** JSON body (or a FormData for multipart operations). POST/PUT/PATCH send `{}` when omitted. */
  body?: unknown;
  /** Set for requests whose effect must never be repeated by accident (calls, messages, purchases, deletes). */
  sideEffect?: boolean;
  /** Overrides the global --dry-run for this request (e.g. a read needed to build a later write). */
  dryRun?: boolean;
  /** "json" (default), "text", or "bytes" for downloads (recordings, 10DLC documents). */
  responseType?: "json" | "text" | "bytes";
}

export interface RawArgs extends Omit<CallArgs, "path"> {
  api?: Api;
}

/** What `--dry-run` shows. Never contains the token. */
export interface PreparedRequest {
  dry_run: true;
  operation?: string;
  api: Api;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface BytesResponse {
  bytes: Uint8Array;
  contentType?: string;
  filename?: string;
}

/**
 * Thrown instead of sending when dry-run is on. `run()` in cli.ts prints `request` as the command's output and
 * exits 0, so every command supports --dry-run without special handling.
 */
export class DryRunSignal extends Error {
  constructor(readonly request: PreparedRequest) {
    super("dry run");
    this.name = "DryRunSignal";
  }
}

export const DEFAULT_TIMEOUT_MS = 30_000;
const BODY_METHODS = new Set<HttpMethod>(["POST", "PUT", "PATCH"]);

/** POST/PUT/PATCH always carry a body (the gateway wants a JSON Content-Type even when empty); DELETE only when the caller gives one (e.g. remove-campaign-numbers, kyc-session revoke reason). */
function sendsBody(method: HttpMethod, body: unknown): boolean {
  return BODY_METHODS.has(method) || (method === "DELETE" && body !== undefined);
}
const ACCOUNT_PARAMS = new Set(["auth_id", "account_id"]);

export class VobizClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  get creds(): ResolvedCredentials {
    return typeof this.opts.creds === "function" ? this.opts.creds() : this.opts.creds;
  }

  get authId(): string {
    return this.creds.authId;
  }

  baseUrl(api: Api): string {
    const c = this.creds;
    return (api === "sms" ? c.smsBaseUrl : c.voiceBaseUrl).replace(/\/+$/, "");
  }

  /** Fills a path template. auth_id/account_id come from the credentials; the rest from `params`, encoded. */
  fillPath(template: string, params: Record<string, string | number> = {}): string {
    return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
      if (ACCOUNT_PARAMS.has(name)) return encodeURIComponent(this.authId);
      const v = params[name];
      if (v === undefined || v === null || v === "") throw new VobizError("invalid_input", `Missing required path parameter "${name}".`);
      return encodeURIComponent(String(v));
    });
  }

  buildUrl(api: Api, path: string, query: Record<string, unknown> = {}): URL {
    const url = new URL(this.baseUrl(api) + path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      for (const item of Array.isArray(v) ? v : [v]) {
        if (item === undefined || item === null || item === "") continue;
        url.searchParams.append(k, item instanceof Date ? item.toISOString() : typeof item === "object" ? JSON.stringify(item) : String(item));
      }
    }
    return url;
  }

  /** Calls a spec operation. Resolves with the parsed JSON body (undefined for an empty 2xx). */
  async call<T = unknown>(op: Operation, args: CallArgs = {}): Promise<T> {
    for (const p of op.queryParams) {
      if (p.required && (args.query?.[p.name] === undefined || args.query?.[p.name] === ""))
        throw new VobizError("invalid_input", `Missing required query parameter "${p.name}" for ${op.id}.`);
    }
    const path = this.fillPath(op.path, args.path);
    return this.send<T>(op.api, op.method, path, op.path, args, op.id);
  }

  /**
   * Sends an arbitrary request (for `vobiz api`). `path` is relative to the API base URL and must start with
   * "/" so the token can never be sent to another host. `{auth_id}`/`{account_id}` are filled.
   */
  async raw<T = unknown>(method: HttpMethod, path: string, args: RawArgs = {}): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new VobizError("invalid_input", `The path must start with "/" (got "${path}"). Full URLs are not accepted.`);
    const [pathname, search] = path.split("?", 2);
    const filled = this.fillPath(pathname);
    const query: Record<string, unknown> = {};
    if (search) for (const [k, v] of new URLSearchParams(search)) query[k] = query[k] === undefined ? v : ([] as unknown[]).concat(query[k], v);
    return this.send<T>(args.api ?? "voice", method, filled, pathname, { ...args, query: { ...query, ...args.query } });
  }

  /** The request `--dry-run` would show, without sending it. */
  prepare(api: Api, method: HttpMethod, path: string, args: CallArgs, operation?: string): PreparedRequest {
    const url = this.buildUrl(api, path, args.query);
    const headers = this.headers(method, args.body);
    return {
      dry_run: true,
      ...(operation ? { operation } : {}),
      api,
      method,
      url: url.toString(),
      headers: { ...headers, "X-Auth-Token": REDACTED },
      ...(sendsBody(method, args.body) ? { body: args.body instanceof FormData ? "[multipart form data]" : redact(args.body ?? {}) } : {}),
    };
  }

  private headers(method: HttpMethod, body: unknown): Record<string, string> {
    const c = this.creds; // throws missing_credentials before any I/O
    const h: Record<string, string> = {
      "X-Auth-ID": c.authId,
      "X-Auth-Token": c.authToken,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    // The gateway rejects POSTs without a JSON Content-Type, even when the body is empty.
    if (sendsBody(method, body) && !(body instanceof FormData)) h["Content-Type"] = "application/json";
    return h;
  }

  private isDryRun(args: CallArgs): boolean {
    if (args.dryRun !== undefined) return args.dryRun;
    const d = this.opts.dryRun;
    return typeof d === "function" ? d() : !!d;
  }

  private log(level: LogLevel, msg: string) {
    this.opts.log?.(level, msg);
  }

  private async send<T>(api: Api, method: HttpMethod, path: string, route: string, args: CallArgs, operation?: string): Promise<T> {
    if (this.isDryRun(args)) throw new DryRunSignal(this.prepare(api, method, path, args, operation));
    const url = this.buildUrl(api, path, args.query);
    const headers = this.headers(method, args.body);
    const body = sendsBody(method, args.body) ? (args.body instanceof FormData ? args.body : JSON.stringify(args.body ?? {})) : undefined;
    if (body !== undefined) this.log("debug", `request body: ${args.body instanceof FormData ? "[multipart form data]" : JSON.stringify(redact(args.body ?? {}))}`);

    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    const label = `${method} ${route}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: controller.signal, redirect: "manual" });
    } catch {
      const timedOut = controller.signal.aborted;
      clearTimeout(timer);
      this.log("verbose", `${label} -> ${timedOut ? "timeout" : "network error"} (${Date.now() - started}ms)`);
      if (args.sideEffect)
        throw new VobizError(
          "outcome_unknown",
          `${timedOut ? "The request timed out" : "The connection failed"} before Vobiz answered, so it is unknown whether the request took effect. Do NOT retry blindly; check the current state first.`,
        );
      throw timedOut
        ? new VobizError("timeout", `Vobiz did not respond within ${Math.round(timeoutMs / 1000)}s.`)
        : new VobizError("network_error", `Could not reach ${url.host}. Check your network, proxy and --base-url.`);
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      bytes = new Uint8Array();
      if (controller.signal.aborted && res.ok) {
        clearTimeout(timer);
        throw new VobizError(args.sideEffect ? "outcome_unknown" : "timeout", "The response was cut off by the timeout.");
      }
    } finally {
      clearTimeout(timer);
    }
    this.log("verbose", `${label} -> ${res.status} (${Date.now() - started}ms)`);

    const contentType = res.headers.get("content-type") ?? undefined;
    if (res.status >= 200 && res.status < 300 && args.responseType === "bytes") {
      const disp = res.headers.get("content-disposition") ?? "";
      const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp)?.[1];
      return { bytes, contentType, filename: filename ? decodeURIComponent(filename) : undefined } as T;
    }
    const text = new TextDecoder().decode(bytes);
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (data !== undefined) this.log("debug", `response body: ${JSON.stringify(redact(data)).slice(0, 4000)}`);

    if (res.status >= 200 && res.status < 300) {
      if (args.responseType === "text") return text as T;
      if (text && data === undefined) throw new VobizError("unexpected_response", "Vobiz returned a non-JSON success response.", res.status);
      return data as T;
    }
    if (res.status >= 300 && res.status < 400)
      throw new VobizError("unexpected_response", `Vobiz answered with an unexpected redirect (${res.status}).`, res.status);

    const message = extractBackendMessage(data ?? text) ?? `HTTP ${res.status}`;
    throw new VobizError(kindForStatus(res.status), message, res.status, data === undefined ? undefined : redact(data));
  }
}
