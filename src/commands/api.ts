/**
 * `vobiz api`: the escape hatch. Sends any request to the Vobiz API with your credentials, and lists or describes
 * every operation in the vendored spec. Paths are relative to the API base URL; `{auth_id}` is filled for you.
 * Non-GET requests go through the usual confirmation (--yes / --dry-run).
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { requireConfirmation } from "../core/confirm.js";
import type { Ctx } from "../core/context.js";
import { VobizError } from "../core/errors.js";
import { findOp } from "../core/ops.js";
import { OPERATIONS, type HttpMethod, type Operation } from "../generated/operations.js";

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** `k=v` pairs into a query object; a repeated key becomes an array. */
export function parseQueryPairs(pairs: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0) throw new VobizError("invalid_input", `--query expects key=value (got "${p}").`);
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    const prev = out[k];
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
    .option("--query <key=value>", "query parameter (repeatable)", (v: string, prev: string[] = []) => [...prev, v])
    .option("--body <json>", "JSON body, @file.json, or @- for stdin")
    .option("--sms", "send to the Messaging API (base https://api.vobiz.ai/api/v1/sms)")
    .option("--list", "list every operation in the spec")
    .option("--tag <tag>", "with --list: only operations with this tag (case-insensitive)")
    .option("--describe <operationId>", "show the parameters and body of one operation (sms:<id> or voice:<id> when ambiguous)")
    .addHelpText(
      "after",
      "\nExamples:\n  vobiz api --list --tag Trunks\n  vobiz api --describe make-call\n  vobiz api GET /api/v1/auth/me\n  vobiz api GET '/api/v1/Account/{auth_id}/Call/' --query status=live\n  vobiz api GET /messages --sms --query limit=5",
    )
    .action(async (method: string | undefined, path: string | undefined, opts: { query?: string[]; body?: string; sms?: boolean; list?: boolean; tag?: string; describe?: string }) => {
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
      if (!method || !path) throw new VobizError("invalid_input", "Usage: vobiz api <METHOD> <path> [--query k=v] [--body json|@file] [--sms], or vobiz api --list.");
      const m = method.toUpperCase() as HttpMethod;
      if (!METHODS.includes(m)) throw new VobizError("invalid_input", `Unsupported method "${method}". Use ${METHODS.join(", ")}.`);
      if (opts.body !== undefined && m === "GET") throw new VobizError("invalid_input", `--body is sent with POST, PUT, PATCH or DELETE, not GET.`);
      const body = opts.body !== undefined ? await readBody(ctx, opts.body) : undefined;
      const query = parseQueryPairs(opts.query ?? []);
      const api = opts.sms ? "sms" : "voice";
      if (m !== "GET") {
        await requireConfirmation(ctx, {
          action: `${m} ${path}`,
          details: { api: `${api} (${new URL(api === "sms" ? ctx.creds.smsBaseUrl : ctx.creds.voiceBaseUrl).host})`, account: ctx.creds.authId },
        });
      }
      const data = await ctx.client.raw(m, path, { api, query, body, sideEffect: m !== "GET" });
      if (data === undefined) ctx.out.success("Done (empty response).", {});
      else ctx.out.print(data);
    });
}
