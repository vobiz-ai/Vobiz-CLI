/**
 * `vobiz api`: the escape hatch. Sends any request to the Vobiz API with your credentials, and lists or describes
 * every operation in the vendored spec. Paths are relative to the API base URL; `{auth_id}` is filled for you.
 * Non-GET requests go through the usual confirmation (--yes / --dry-run).
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { requireConfirmation, type ConfirmDetail } from "../core/confirm.js";
import type { Ctx } from "../core/context.js";
import { VobizError } from "../core/errors.js";
import { isUnsafeKey } from "../core/keys.js";
import { findOp } from "../core/ops.js";
import { redact } from "../core/redact.js";
import { OPERATIONS, type HttpMethod, type Operation } from "../generated/operations.js";
import { API_MAX_FANOUT, capFanout } from "./calls.js";
import { intArg } from "./voice-shared.js";

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** `k=v` pairs into a query object; a repeated key becomes an array. */
export function parseQueryPairs(pairs: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0) throw new VobizError("invalid_input", `--param expects key=value (got "${p}").`);
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    if (isUnsafeKey(k)) throw new VobizError("invalid_input", `--param cannot use the name "${k}".`);
    const prev = Object.hasOwn(out, k) ? out[k] : undefined;
    out[k] = prev === undefined ? v : ([] as string[]).concat(prev, v);
  }
  return out;
}

/** `--body` value: inline JSON, `@file.json`, or `@-` for stdin. */
export async function readBody(ctx: Ctx, value: string): Promise<unknown> {
  let text = value;
  if (value === "@-" || value === "-") text = await ctx.stdin.read();
  else if (value.startsWith("@")) {
    try {
      text = readFileSync(value.slice(1), "utf8");
    } catch {
      throw new VobizError("invalid_input", `Cannot read ${value.slice(1)}.`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new VobizError("invalid_input", "--body is not valid JSON.");
  }
}

/** Keys whose values are URLs Vobiz will fetch or post to: `answer_url`, `hangupUrl`, `mediaUrls`… */
const URL_KEY = /urls?$/i;
const BODY_PREVIEW = 600;

/** Every string under a URL-named key anywhere in the body, with its dot path. */
export function bodyUrls(body: unknown, path = ""): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = [];
  const visit = (v: unknown, p: string, urlKey: boolean) => {
    if (typeof v === "string") {
      if (urlKey) out.push({ path: p, value: v });
    } else if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${p}[${i}]`, urlKey));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, p ? `${p}.${k}` : k, URL_KEY.test(k));
  };
  visit(body, path, false);
  return out;
}

/** Non-GET bodies: every URL-named value must be https (wss for streams) so Vobiz never fetches call XML in clear text. */
function checkUrls(urls: { path: string; value: string }[]): string[] {
  const hosts = new Set<string>();
  for (const u of urls) {
    if (!u.value) continue;
    let parsed: URL;
    try {
      parsed = new URL(u.value);
    } catch {
      throw new VobizError("invalid_input", `--body ${u.path} is not a valid URL.`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "wss:")
      throw new VobizError("invalid_input", `--body ${u.path} must use https:// (or wss:// for streams); got ${parsed.protocol.slice(0, -1)}://.`);
    hosts.add(parsed.host);
  }
  return [...hosts];
}

/** Destinations in `to` fields (a `<`-joined string or an array), anywhere at the top level of the body. */
function bodyDestinations(body: unknown): string[] | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const to = (body as Record<string, unknown>).to;
  if (typeof to === "string") return to.split("<").map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(to)) return to.filter((x): x is string => typeof x === "string");
  return undefined;
}

/** The confirmation for a raw write: method, path, URL hosts, destinations and a redacted body preview. */
function rawWriteDetails(body: unknown, maxFanout: number | undefined): Record<string, string | ConfirmDetail> {
  const details: Record<string, string | ConfirmDetail> = {};
  if (body === undefined) return details;
  const hosts = checkUrls(bodyUrls(body));
  const dests = bodyDestinations(body);
  if (dests?.length) {
    const unique = capFanout(dests, maxFanout, "--body to");
    details.to = unique.length > 3 ? `${unique.slice(0, 3).join(", ")} and ${unique.length - 3} more (${unique.length} destinations)` : unique.join(", ");
  }
  if (hosts.length) details["URL hosts in body"] = hosts.join(", ");
  const text = JSON.stringify(redact(body));
  details.body = { value: text.length > BODY_PREVIEW ? `${text.slice(0, BODY_PREVIEW)}… (${text.length} characters)` : text, max: BODY_PREVIEW + 40 };
  return details;
}

function describe(o: Operation): Record<string, unknown> {
  return {
    id: o.id,
    api: o.api,
    method: o.method,
    path: o.path,
    base_url: o.baseUrl,
    tag: o.tag,
    summary: o.summary,
    description: o.description,
    path_params: o.pathParams.map((p) => ({ name: p.name, required: p.required, type: p.type, filled_by_cli: p.name === "auth_id" || p.name === "account_id" })),
    query_params: o.queryParams.map((p) => ({ name: p.name, required: p.required, type: p.type, ...(p.enum ? { enum: p.enum } : {}), description: p.description })),
    body: o.body.props.length
      ? { content_type: o.body.contentType, required: o.body.required, fields: o.body.props.map((p) => ({ name: p.name, required: p.required, type: p.type, ...(p.enum ? { enum: p.enum } : {}), description: p.description })) }
      : null,
  };
}

function describeText(o: Operation): string {
  const lines = [`${o.method} ${o.path}   (${o.api} API, ${o.id})`, `${o.summary}`, o.description ? `${o.description}` : ""];
  const section = (title: string, params: { name: string; required: boolean; type: string; description: string }[]) => {
    if (!params.length) return;
    lines.push("", `${title}:`);
    for (const p of params) lines.push(`  ${p.name}${p.required ? " (required)" : ""}  ${p.type}${p.description ? `  ${p.description.split("\n")[0]}` : ""}`);
  };
  section("Path parameters (auth_id/account_id are filled from your login)", o.pathParams);
  section("Query parameters", o.queryParams);
  section(`Body (${o.body.contentType ?? "application/json"})`, o.body.props);
  const flag = o.api === "sms" ? " --sms" : "";
  lines.push("", `Try: vobiz api ${o.method} ${o.path}${flag}${o.method === "GET" ? "" : " --body '{…}' --dry-run"}`);
  return lines.filter((l, i) => l !== "" || i > 0).join("\n") + "\n";
}

export function register(program: Command, ctx: Ctx): void {
  program
    .command("api")
    .description("Send a raw request to the Vobiz API, or list and describe every operation in the spec")
    .argument("[method]", "HTTP method: GET, POST, PUT, PATCH or DELETE")
    .argument("[path]", "path relative to the API base, e.g. /api/v1/Account/{auth_id}/Call/ or /messages with --sms")
    .option("--param <key=value>", "query-string parameter (repeatable)", (v: string, prev: string[] = []) => [...prev, v])
    .option("--body <json>", "JSON body, @file.json, or @- for stdin")
    .option("--sms", "send to the Messaging API (base https://api.vobiz.ai/api/v1/sms)")
    .option("--list", "list every operation in the spec")
    .option("--tag <tag>", "with --list: only operations with this tag (case-insensitive)")
    .option("--describe <operationId>", "show the parameters and body of one operation (sms:<id> or voice:<id> when ambiguous)")
    .option("--max-fanout <n>", `allow more than 50 destinations in a body "to" field (API maximum ${API_MAX_FANOUT})`, intArg(1, API_MAX_FANOUT))
    .addHelpText(
      "after",
      "\nExamples:\n  vobiz api --list --tag Trunks\n  vobiz api --describe make-call\n  vobiz api GET /api/v1/auth/me\n  vobiz api GET '/api/v1/Account/{auth_id}/Call/' --param status=live\n  vobiz api GET /messages --sms --param limit=5",
    )
    .action(async (method: string | undefined, path: string | undefined, opts: { param?: string[]; body?: string; sms?: boolean; list?: boolean; tag?: string; describe?: string; maxFanout?: number }) => {
      if (opts.list) {
        const tag = opts.tag?.toLowerCase();
        const rows = OPERATIONS.filter((o) => !tag || o.tag.toLowerCase() === tag).map((o) => ({
          id: o.id,
          api: o.api,
          method: o.method,
          path: o.path,
          tag: o.tag,
          summary: o.summary,
        }));
        if (tag && !rows.length) throw new VobizError("invalid_input", `No operations tagged "${opts.tag}". Tags: ${[...new Set(OPERATIONS.map((o) => o.tag))].join(", ")}.`);
        ctx.out.print(rows, { columns: ["id", "api", "method", "path", "summary"], idKey: "id" });
        return;
      }
      if (opts.describe) {
        const found = findOp(opts.describe);
        if (!found.length) throw new VobizError("not_found", `No operation "${opts.describe}". Run \`vobiz api --list\`.`);
        if (ctx.out.mode === "table" || ctx.out.mode === "plain") ctx.stdout.write(found.map(describeText).join("\n"));
        else ctx.out.print(found.length === 1 ? describe(found[0]) : found.map(describe));
        return;
      }
      if (!method || !path) throw new VobizError("invalid_input", "Usage: vobiz api <METHOD> <path> [--param k=v] [--body json|@file] [--sms], or vobiz api --list.");
      const m = method.toUpperCase() as HttpMethod;
      if (!METHODS.includes(m)) throw new VobizError("invalid_input", `Unsupported method "${method}". Use ${METHODS.join(", ")}.`);
      if (opts.body !== undefined && m === "GET") throw new VobizError("invalid_input", `--body is sent with POST, PUT, PATCH or DELETE, not GET.`);
      const body = opts.body !== undefined ? await readBody(ctx, opts.body) : undefined;
      const query = parseQueryPairs(opts.param ?? []);
      const api = opts.sms ? "sms" : "voice";
      if (m !== "GET") {
        await requireConfirmation(ctx, {
          action: `${m} ${path}`,
          details: {
            api: `${api} (${new URL(api === "sms" ? ctx.creds.smsBaseUrl : ctx.creds.voiceBaseUrl).host})`,
            ...rawWriteDetails(body, opts.maxFanout),
          },
        });
      }
      const data = await ctx.client.raw(m, path, { api, query, body, sideEffect: m !== "GET" });
      if (data === undefined) ctx.out.success("Done (empty response).", {});
      else ctx.out.print(data);
    });
}
