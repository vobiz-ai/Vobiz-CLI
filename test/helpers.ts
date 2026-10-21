/**
 * Shared test helpers for every command group (W1–W5). Nothing here touches the network or your real config.
 *
 *   import { fakeFetch, reply, makeCtx, runCli, TEST_AUTH_ID } from "./helpers.js";
 *
 *   // 1. Fake the API. Keys are "METHOD /path" (the path without the base URL; `%2B`-encoded and decoded
 *   //    forms both match). A value is the JSON body of a 200, `reply(status, body)` for anything else, a
 *   //    function of the recorded request, `networkError()` or `hang()` (never answers; use with --timeout).
 *   const api = fakeFetch({
 *     "GET /api/v1/auth/me": { name: "Test Account", auth_id: TEST_AUTH_ID },
 *     [`POST /api/v1/Account/${TEST_AUTH_ID}/Call/`]: reply(201, { request_uuid: "abc" }),
 *     "GET /messages": (req) => ({ items: [], echo: req.query }),
 *   });
 *
 *   // 2. Run the CLI like a user would (stdin is not a TTY, so writes need --yes).
 *   const r = await runCli(["api", "GET", "/api/v1/auth/me", "--json"], { fetch: api.fetch });
 *   expect(r.code).toBe(0);
 *   expect(r.json()).toMatchObject({ name: "Test Account" });
 *   expect(api.calls[0]).toMatchObject({ method: "GET", path: "/api/v1/auth/me", api: "voice" });
 *   expect(api.last().headers["x-auth-id"]).toBe(TEST_AUTH_ID);
 *
 *   // 3. Or build a Ctx directly to unit-test a helper: makeCtx({ env, stdinTTY, prompts, flags, ... }).
 *
 * By default the ctx has env credentials MA_XXXXXXXX / YOUR_AUTH_TOKEN (placeholders, never real), CI=1 (no
 * update check), a fresh temporary VOBIZ config dir, non-TTY streams and prompts that fail if called.
 * Pass `loggedOut: true` for no credentials.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";
import { ConfigStore } from "../src/core/config.js";
import { Ctx, type GlobalFlags, type Prompts } from "../src/core/context.js";

export const TEST_AUTH_ID = "MA_XXXXXXXX";
export const TEST_AUTH_TOKEN = "YOUR_AUTH_TOKEN";
export const VOICE_BASE = "https://api.vobiz.ai";
export const SMS_BASE = "https://api.vobiz.ai/api/v1/sms";

export interface RecordedRequest {
  method: string;
  url: string;
  /** "voice" when the URL is under the voice base, "sms" when under /api/v1/sms. */
  api: "voice" | "sms";
  /** Path relative to the API base, as sent (still percent-encoded, e.g. %2B). */
  path: string;
  query: Record<string, string | string[]>;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Parsed JSON body, the raw string when it is not JSON, a FormData, or undefined. */
  body: unknown;
}

const REPLY = Symbol("reply");
export interface FakeReply {
  [REPLY]: true;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw text body instead of JSON. */
  text?: string;
}
/** A non-200 (or non-JSON) answer. */
export const reply = (status: number, body?: unknown, headers?: Record<string, string>): FakeReply => ({ [REPLY]: true, status, body, headers });
export const textReply = (status: number, text: string, headers?: Record<string, string>): FakeReply => ({ [REPLY]: true, status, text, headers });

const NETWORK = Symbol("network");
const HANG = Symbol("hang");
/** The connection fails (fetch rejects). */
export const networkError = () => NETWORK;
/** fetch never answers until aborted (exercise --timeout). */
export const hang = () => HANG;

type RouteValue = unknown | FakeReply | typeof NETWORK | typeof HANG | ((req: RecordedRequest) => unknown);

export interface FakeApi {
  fetch: typeof fetch;
  calls: RecordedRequest[];
  last(): RecordedRequest;
}

function relPath(url: URL): { api: "voice" | "sms"; path: string } {
  const p = url.pathname;
  if (p.startsWith("/api/v1/sms/") || p === "/api/v1/sms") return { api: "sms", path: p.slice("/api/v1/sms".length) || "/" };
  return { api: "voice", path: p };
}

export function fakeFetch(routes: Record<string, RouteValue> = {}): FakeApi {
  const calls: RecordedRequest[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const query: Record<string, string | string[]> = {};
    url.searchParams.forEach((v, k) => {
      const prev = query[k];
      query[k] = prev === undefined ? v : ([] as string[]).concat(prev, v);
    });
    let body: unknown = init.body;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const { api, path } = relPath(url);
    const req: RecordedRequest = { method, url: url.toString(), api, path, query, headers, body };
    calls.push(req);

    const candidates = [`${method} ${path}`, `${method} ${decodeURIComponent(path)}`, `${method} ${url.pathname}`, `${method} ${decodeURIComponent(url.pathname)}`];
    const key = candidates.find((k) => k in routes);
    let value: unknown = key === undefined ? reply(404, { error: `no fake route for ${method} ${path}` }) : routes[key];
    if (typeof value === "function") value = await (value as (r: RecordedRequest) => unknown)(req);
    if (value === NETWORK) throw new TypeError("fetch failed");
    if (value === HANG)
      return new Promise<Response>((_, reject) => {
        const signal = init.signal;
        if (signal?.aborted) reject(new DOMException("aborted", "AbortError"));
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const r: FakeReply = value && typeof value === "object" && REPLY in (value as object) ? (value as FakeReply) : reply(200, value);
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    const h = new Headers({ ...(r.text === undefined && text ? { "content-type": "application/json" } : {}), ...r.headers });
    return new Response(r.status === 204 || r.status === 304 ? null : text, { status: r.status, headers: h });
  };
  return {
    fetch: impl as typeof fetch,
    calls,
    last() {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("no request was made");
      return c;
    },
  };
}

export interface Capture {
  write(s: string): boolean;
  isTTY: boolean;
  columns?: number;
  text: string;
}
export const capture = (isTTY = false, columns?: number): Capture => {
  const c: Capture = {
    isTTY,
    columns,
    text: "",
    write(s: string) {
      c.text += s;
      return true;
    },
  };
  return c;
};

export interface ScriptedPrompts {
  /** Answers for confirm(), in order (a single boolean answers every call). */
  confirm?: boolean | boolean[];
  input?: string[];
  password?: string[];
}

function scripted(p: ScriptedPrompts | Prompts | undefined): Prompts {
  if (p && typeof (p as Prompts).confirm === "function") return p as Prompts;
  const s = (p ?? {}) as ScriptedPrompts;
  const take = (list: unknown[] | undefined, what: string) => {
    if (!list?.length) throw new Error(`unexpected ${what} prompt`);
    return list.shift();
  };
  return {
    async confirm() {
      if (typeof s.confirm === "boolean") return s.confirm;
      return take(s.confirm, "confirm") as boolean;
    },
    async input() {
      return take(s.input, "input") as string;
    },
    async password() {
      return take(s.password, "password") as string;
    },
  };
}

export interface MakeCtxOptions {
  env?: NodeJS.ProcessEnv;
  /** No credentials in env (and none saved). */
  loggedOut?: boolean;
  fetch?: typeof fetch;
  configDir?: string;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  stderrTTY?: boolean;
  columns?: number;
  /** stdin contents for --with-token / --body @-. */
  stdin?: string;
  prompts?: ScriptedPrompts | Prompts;
  flags?: Partial<GlobalFlags>;
  now?: () => Date;
  openUrl?: (url: string) => Promise<void>;
}

export interface TestCtx {
  ctx: Ctx;
  store: ConfigStore;
  configDir: string;
  stdout: Capture;
  stderr: Capture;
  opened: string[];
}

export function makeCtx(o: MakeCtxOptions = {}): TestCtx {
  const configDir = o.configDir ?? mkdtempSync(join(tmpdir(), "vobiz-test-"));
  const env: NodeJS.ProcessEnv = {
    CI: "1",
    VOBIZ_NO_BROWSER: "1",
    VOBIZ_CONFIG_DIR: configDir,
    ...(o.loggedOut ? {} : { VOBIZ_AUTH_ID: TEST_AUTH_ID, VOBIZ_AUTH_TOKEN: TEST_AUTH_TOKEN }),
    ...o.env,
  };
  const store = new ConfigStore(configDir);
  const stdout = capture(!!o.stdoutTTY, o.columns);
  const stderr = capture(!!o.stderrTTY, o.columns);
  const opened: string[] = [];
  const ctx = new Ctx({
    env,
    store,
    stdout,
    stderr,
    stdin: { isTTY: !!o.stdinTTY, read: async () => o.stdin ?? "" },
    fetch: o.fetch ?? fakeFetch().fetch,
    prompts: scripted(o.prompts),
    now: o.now,
    openUrl:
      o.openUrl ??
      (async (u) => {
        opened.push(u);
      }),
    flags: o.flags,
  });
  return { ctx, store, configDir, stdout, stderr, opened };
}

export interface CliResult extends TestCtx {
  code: number;
  /** stdout parsed as JSON (throws with the raw text when it is not JSON). */
  json<T = any>(): T;
  out: string;
  err: string;
}

/** Runs `vobiz <argv>` in-process against a fresh test ctx. */
export async function runCli(argv: string[], o: MakeCtxOptions = {}): Promise<CliResult> {
  const t = makeCtx(o);
  const code = await run(argv, t.ctx);
  return {
    ...t,
    code,
    out: t.stdout.text,
    err: t.stderr.text,
    json<T>() {
      try {
        return JSON.parse(t.stdout.text) as T;
      } catch {
        throw new Error(`stdout is not JSON:\n${t.stdout.text}\nstderr:\n${t.stderr.text}`);
      }
    },
  };
}
