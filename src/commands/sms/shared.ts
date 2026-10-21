/**
 * Helpers shared by the `vobiz sms` command modules. The Messaging API (base https://api.vobiz.ai/api/v1/sms)
 * uses camelCase JSON; every request still goes through `ctx.client` with an operation from the vendored spec.
 *
 * Also here: list printing that keeps the raw response shape in json/yaml modes even across `--all` pages.
 * (DELETE requests with a JSON body, such as `remove-campaign-numbers`, go through `ctx.client.call` like any other.)
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Option, type Command } from "commander";
import type { CallArgs } from "../../core/client.js";
import type { Ctx } from "../../core/context.js";
import { VobizError, usage } from "../../core/errors.js";
import type { Operation } from "../../core/ops.js";
import { toE164 } from "../../core/phone.js";
import { paginate, type PaginateOptions } from "../../core/pagination.js";
import type { PrintOptions } from "../../core/output.js";
import { readBody } from "../api.js";

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** Commander collector for repeatable options; also splits comma-separated values. */
export const collect = (v: string, prev: string[] = []): string[] => [...prev, ...v.split(",").map((s) => s.trim()).filter(Boolean)];
/** Repeatable option kept whole (values may contain commas, e.g. example messages). */
export const collectRaw = (v: string, prev: string[] = []): string[] => [...prev, v];

export function intArg(name: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw usage(`${name} must be a whole number between ${min} and ${max} (got "${v}").`);
    return n;
  };
}

/** Drops undefined values (and empty arrays) so the body carries only what the user set. */
export function compact<T extends Rec>(obj: T): Partial<T> {
  const out: Rec = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/** Host of a URL for confirmation summaries. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Accepts only https URLs (media, webhooks, profile links). */
export function httpsUrl(flag: string) {
  return (v: string): string => {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw usage(`${flag} is not a valid URL: "${v}".`);
    }
    if (u.protocol !== "https:") throw usage(`${flag} must be an https URL (got "${v}").`);
    return v;
  };
}

/** Parses a JSON option value: inline JSON, @file.json or @- for stdin. */
export async function jsonArg(ctx: Ctx, flag: string, value: string): Promise<unknown> {
  try {
    return await readBody(ctx, value);
  } catch (err) {
    if (err instanceof VobizError) throw usage(err.message.replace("--body", flag));
    throw err;
  }
}

/** `--body` (JSON object) merged under the values from individual flags. */
export async function bodyWithFlags(ctx: Ctx, body: string | undefined, flags: Rec): Promise<Rec> {
  let base: Rec = {};
  if (body !== undefined) {
    const parsed = await jsonArg(ctx, "--body", body);
    if (!isRec(parsed)) throw usage("--body must be a JSON object.");
    base = parsed;
  }
  return { ...base, ...compact(flags) };
}

export function requireKeys(body: Rec, keys: [key: string, flag: string][]): void {
  const missing = keys.filter(([k]) => body[k] === undefined || body[k] === null || body[k] === "");
  if (missing.length) throw usage(`Missing ${missing.map(([k, f]) => `${f} (${k})`).join(", ")}. Pass the flag or include the field in --body.`);
}

/**
 * Future time for `--schedule-at`: an ISO 8601 / RFC 3339 timestamp, or `+30m`, `+2h`, `+1d` from now.
 * Returned as an ISO string in UTC.
 */
export function scheduleAt(value: string, now: Date): string {
  const v = value.trim();
  const rel = /^\+(\d+)\s*([mhd])$/i.exec(v);
  if (rel) {
    const ms = Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2].toLowerCase() as "m" | "h" | "d"];
    return new Date(now.getTime() + ms).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(v))
    throw usage(`--schedule-at must be an RFC 3339 timestamp with a timezone (e.g. 2026-11-01T09:00:00Z) or +30m, +2h, +1d (got "${value}").`);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw usage(`--schedule-at is not a valid time: "${value}".`);
  return new Date(t).toISOString();
}

/** A file to upload as one multipart part. */
export function fileForm(field: string, path: string, extra: Record<string, string | undefined> = {}): { form: FormData; name: string; size: number } {
  let bytes: Buffer;
  let size: number;
  try {
    size = statSync(path).size;
    bytes = readFileSync(path);
  } catch {
    throw usage(`Cannot read ${path}.`);
  }
  const form = new FormData();
  const name = basename(path);
  form.append(field, new Blob([new Uint8Array(bytes)]), name);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") form.append(k, v);
  return { form, name, size };
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Shortens a list of values for a confirmation line. */
export function listPreview(values: string[], max = 5): string {
  return values.length <= max ? values.join(", ") : `${values.slice(0, max).join(", ")} and ${values.length - max} more`;
}

export function textPreview(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(one.length > max ? `${one.slice(0, max - 1)}…` : one);
}

// ── Lists ─────────────────────────────────────────────────────────

export interface ListFlags {
  limit?: number;
  all?: boolean;
}

/** Adds `--limit` and `--all` to a list command that pages. */
export function pagingOptions(cmd: Command, defaultLimit: number): Command {
  return cmd
    .addOption(new Option("--limit <n>", `maximum number of items to return (default ${defaultLimit})`).argParser(intArg("--limit", 1, 1_000_000)))
    .option("--all", "fetch every page");
}

/**
 * Prints a list. json/yaml without --fields/--quiet get the raw response body (with every page's items merged
 * under `itemsKey` for --all); other modes get rows with the default columns.
 */
export function printList(ctx: Ctx, body: unknown, items: unknown[], itemsKey: string | undefined, opts: PrintOptions): void {
  const mode = ctx.out.mode;
  const raw = (mode === "json" || mode === "yaml") && !ctx.flags.fields?.length && !ctx.flags.quiet;
  if (raw) {
    if (Array.isArray(body) || body === null || body === undefined) ctx.out.print(items);
    else if (itemsKey && isRec(body)) ctx.out.print({ ...body, [itemsKey]: items });
    else ctx.out.print(body);
    return;
  }
  ctx.out.print(items, opts);
}

/** Pages through a list endpoint with --limit/--all and prints it. */
export async function listCommand(
  ctx: Ctx,
  operation: Operation,
  args: CallArgs,
  flags: ListFlags,
  defaultLimit: number,
  maxPage: number,
  itemsKey: string | undefined,
  print: PrintOptions,
): Promise<void> {
  const limit = flags.all ? undefined : flags.limit ?? defaultLimit;
  const pageOpts: PaginateOptions = { all: flags.all, limit, pageSize: flags.all ? maxPage : Math.min(limit ?? maxPage, maxPage), itemsKey };
  const res = await paginate<Rec>(ctx.client, operation, args, pageOpts);
  printList(ctx, res.last, res.items, itemsKey, print);
  if (res.hasMore && !flags.all && (ctx.out.mode === "table" || ctx.out.mode === "plain"))
    ctx.out.status(`Showing ${res.items.length}${res.total !== undefined ? ` of ${res.total}` : ""}. Use --limit <n> or --all for more.`);
}

/** One request for a list endpoint that does not page; prints rows from `itemsKey` (or the bare array). */
export async function simpleList(ctx: Ctx, operation: Operation, args: CallArgs, itemsKey: string | undefined, print: PrintOptions): Promise<void> {
  const body = await ctx.client.call<unknown>(operation, args);
  let items: unknown[] = [];
  if (Array.isArray(body)) items = body;
  else if (itemsKey && isRec(body) && Array.isArray(body[itemsKey])) items = body[itemsKey] as unknown[];
  printList(ctx, body, items, itemsKey, print);
}

/** Prints the result of a write: the returned object, or a success line for `{status: "ok"}` / empty bodies. */
export function printResult(ctx: Ctx, message: string, data: unknown): void {
  if (data === undefined || data === null || (isRec(data) && Object.keys(data).length === 1 && typeof data.status === "string")) {
    ctx.out.success(message, data ?? { status: "ok" });
    return;
  }
  ctx.out.status(message);
  ctx.out.print(data);
}

// ── Flag tables for wide request bodies (RCS senders, 10DLC brands and campaigns) ──

export interface Field {
  /** Commander flag, e.g. "--legal-name <name>" or "--low-volume". */
  flag: string;
  /** Body key. */
  key: string;
  desc: string;
  /**
   * string (default) · bool · int · json (inline, @file or @-) · list (repeatable, kept whole) ·
   * csv (repeatable or comma-separated) · e164 · e164s (repeatable E.164) · digits (repeatable, sent as digits without +)
   */
  kind?: "string" | "bool" | "int" | "json" | "list" | "csv" | "e164" | "e164s" | "digits";
  choices?: readonly string[];
}

export function addFields(cmd: Command, fields: readonly Field[]): Command {
  for (const f of fields) {
    const o = new Option(f.flag, f.desc);
    if (f.choices) o.choices(f.choices);
    if (f.kind === "list") o.argParser(collectRaw);
    else if (f.kind === "csv" || f.kind === "e164s" || f.kind === "digits") o.argParser(collect);
    else if (f.kind === "int") o.argParser(intArg(f.flag.split(" ")[0]));
    cmd.addOption(o);
  }
  return cmd;
}

/** Reads the values of `fields` from parsed options into body keys (undefined when not given). */
export async function fieldValues(ctx: Ctx, opts: Rec, fields: readonly Field[]): Promise<Rec> {
  const out: Rec = {};
  for (const f of fields) {
    const v = opts[new Option(f.flag).attributeName()];
    if (v === undefined) continue;
    const flag = f.flag.split(" ")[0];
    switch (f.kind) {
      case "json":
        out[f.key] = await jsonArg(ctx, flag, String(v));
        break;
      case "e164":
        out[f.key] = toE164(String(v));
        break;
      case "e164s":
        out[f.key] = (v as string[]).map(toE164);
        break;
      case "digits":
        out[f.key] = (v as string[]).map((n) => toE164(n).slice(1));
        break;
      default:
        out[f.key] = v;
    }
  }
  return out;
}
