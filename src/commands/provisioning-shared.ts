/**
 * Helpers shared by the provisioning groups (numbers, trunks, apps, endpoints, sub-accounts, partner).
 *
 * - Body flags are generated from the spec: every property of `op(id).body.props` becomes a kebab-case flag
 *   (`trunk_direction` -> `--trunk-direction`), with enum choices, number parsing and `--no-<flag>` for booleans.
 *   `--body '{json}' | @file.json | @-` passes an arbitrary body; explicit flags are merged on top of it.
 *   Without `--body`, required properties are enforced (a missing required `password` is prompted for, hidden,
 *   when stdin is a terminal). With `--body`, the body is sent as given.
 * - Query flags are generated the same way from `op.queryParams` (pagination params excluded; `--limit/--all`
 *   cover those). Date params (`*_date`) accept `today`, `7d`, `2026-10-01`, ISO timestamps.
 * - `runList` prints a default table, or with --output json/yaml the response body with every page's items merged.
 */
import { existsSync, writeFileSync } from "node:fs";
import { Option, type Command } from "commander";
import type { Ctx } from "../core/context.js";
import { requireConfirmation, type ConfirmSummary } from "../core/confirm.js";
import { usage } from "../core/errors.js";
import { readSecretArg } from "../core/secrets.js";
import { getPath, type PrintOptions } from "../core/output.js";
import { listBody, paginate } from "../core/pagination.js";
import { parseTime, toYmd } from "../core/time.js";
import type { CallArgs } from "../core/client.js";
import type { Operation, Param } from "../generated/operations.js";
import { readBody } from "./api.js";
import { checkUrl } from "./voice-shared.js";

/** "a trunk", "an application", "an IP ACL entry". */
function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

type Opts = Record<string, unknown>;

/** Global flag names a command option must never reuse (PLAN §3). */
const GLOBAL_FLAGS = new Set([
  "profile", "auth-id", "auth-token", "output", "json", "fields", "quiet", "yes", "dry-run", "wait",
  "base-url", "sms-base-url", "timeout", "color", "verbose", "debug", "show-secrets", "update-check", "body", "limit", "all",
]);

const PAGINATION_PARAMS = new Set(["page", "per_page", "limit", "offset", "size"]);

export const kebab = (name: string): string => name.replace(/_+/g, "-").toLowerCase();
const camel = (flag: string): string => flag.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** First sentence of a spec description, without markdown emphasis, short enough for --help. */
function shortDescription(p: Param): string {
  const text = p.description.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  let first = text.split(/(?<=[.!?])\s/)[0] ?? "";
  if (first.length > 110) first = first.slice(0, 107).trimEnd() + "…";
  return first || p.name.replace(/_+/g, " ");
}

export interface FieldSpec {
  name: string;
  flag: string;
  attr: string;
  param: Param;
}

function parseNumber(flag: string, integer: boolean) {
  return (v: string): number => {
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n) || (integer && !Number.isInteger(n))) throw usage(`--${flag} must be ${integer ? "an integer" : "a number"} (got "${v}").`);
    return n;
  };
}

function parseJson(flag: string) {
  return (v: string): unknown => {
    try {
      return JSON.parse(v);
    } catch {
      throw usage(`--${flag} must be JSON (got ${v.slice(0, 40)}).`);
    }
  };
}

/** Adds one option per param. Returns the mapping used at action time. */
function addParamOptions(cmd: Command, params: Param[], extraDescription?: (p: Param) => string): FieldSpec[] {
  const fields: FieldSpec[] = [];
  for (const p of params) {
    const flag = kebab(p.name);
    if (GLOBAL_FLAGS.has(flag)) throw new Error(`${cmd.name()}: spec field "${p.name}" collides with a reserved flag --${flag}.`);
    if (fields.some((f) => f.flag === flag)) continue;
    const attr = camel(flag);
    let desc = shortDescription(p);
    if (SECRET_FIELDS.has(p.name)) desc += " (@file or @- for stdin keeps it out of shell history)";
    if (p.required) desc += " (required)";
    if (extraDescription) desc += extraDescription(p);
    if (p.default !== undefined && p.type !== "boolean") desc += ` (default: ${String(p.default)})`;
    let opt: Option;
    if (p.type === "boolean") {
      opt = new Option(`--${flag}`, `${desc} (--no-${flag} to set false)`);
      cmd.addOption(opt);
      cmd.addOption(new Option(`--no-${flag}`, `set ${p.name} to false`).hideHelp());
    } else {
      opt = new Option(`--${flag} <${p.type === "integer" || p.type === "number" ? "n" : p.type === "object" || (p.type === "array" && p.items === "object") ? "json" : "value"}>`, desc);
      if (p.enum?.length) opt.choices(p.enum.map(String));
      if (p.type === "integer" || p.type === "number") opt.argParser(parseNumber(flag, p.type === "integer"));
      else if (p.type === "object" || (p.type === "array" && p.items === "object")) opt.argParser(parseJson(flag));
      else if (p.type === "array") {
        opt.description += " (repeatable or comma-separated)";
        opt.argParser((v: string, prev: unknown) => [...((prev as string[] | undefined) ?? []), ...v.split(",").map((s) => s.trim()).filter(Boolean)]);
      }
      cmd.addOption(opt);
    }
    fields.push({ name: p.name, flag, attr, param: p });
  }
  return fields;
}

/** Body fields whose flag takes a secret: `@file` / `@-` are read, and a literal value warns about shell history. */
const SECRET_FIELDS = new Set(["password", "secret"]);

export interface BodySpec {
  fields: FieldSpec[];
}

/**
 * Adds a flag for every body property of `ops` (the union, so a command that switches between a live and a test
 * operation offers both sets) plus `--body`.
 */
export function addBodyOptions(cmd: Command, ops: Operation | Operation[], skip: string[] = []): BodySpec {
  const list = Array.isArray(ops) ? ops : [ops];
  const props = list.flatMap((o) => o.body.props).filter((p) => !skip.includes(p.name));
  const fields = addParamOptions(cmd, props);
  cmd.option("--body <json>", "full JSON body: '{…}', @file.json or @- (stdin); flags are merged on top, and unlisted keys are allowed");
  return { fields };
}

/**
 * The request body for `op` from the parsed options. Flags for properties `op` does not accept are rejected.
 * Without --body, every required property must be present (a required password is prompted for on a TTY).
 */
export async function buildBody(ctx: Ctx, opts: Opts, spec: BodySpec, op: Operation, o: { requireSomething?: boolean } = {}): Promise<Record<string, unknown>> {
  const allowed = new Map(op.body.props.map((p) => [p.name, p]));
  const fromFlags: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const v = opts[f.attr];
    if (v === undefined) continue;
    if (!allowed.has(f.name)) throw usage(`--${f.flag} is not accepted here (${op.id} takes: ${[...allowed.keys()].join(", ") || "no body"}).`);
    fromFlags[f.name] = SECRET_FIELDS.has(f.name) && typeof v === "string" ? await readSecretArg(ctx, v, `--${f.flag}`) : v;
  }
  let body: Record<string, unknown> = {};
  const usingBody = opts.body !== undefined;
  if (usingBody) {
    const parsed = await readBody(ctx, String(opts.body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw usage("--body must be a JSON object.");
    body = parsed as Record<string, unknown>;
  }
  body = { ...body, ...fromFlags };
  checkBodyUrls(body, fromFlags, opts);
  if (!usingBody) {
    const missing: Param[] = [];
    for (const p of op.body.props) {
      if (!p.required || body[p.name] !== undefined) continue;
      if (p.name === "password" && ctx.isTTY.stdin && !ctx.flags.dryRun) body.password = await ctx.prompts.password("Password:");
      else missing.push(p);
    }
    if (missing.length) throw usage(`Missing required ${missing.map((p) => `--${kebab(p.name)}`).join(", ")} (or pass --body).`);
  }
  if (o.requireSomething && !Object.keys(body).length) throw usage(`Nothing to change. Pass at least one of ${[...allowed.keys()].map((k) => `--${kebab(k)}`).join(", ")}.`);
  return body;
}

const URL_KEY = /(_url|Url)$/;

/**
 * Every URL-valued body property (`*_url`, `*Url`, from a flag or from --body) must be https, since Vobiz calls
 * it with call or account data. http is accepted only for localhost, and only where the command offers
 * --allow-insecure-url. An empty string (clearing the field) is left alone.
 */
function checkBodyUrls(body: Record<string, unknown>, fromFlags: Record<string, unknown>, opts: Opts): void {
  for (const [key, value] of Object.entries(body)) {
    if (!URL_KEY.test(key) || value === "" || value === null || value === undefined) continue;
    const label = key in fromFlags ? `--${kebab(key)}` : `--body ${key}`;
    if (typeof value !== "string") throw usage(`${label} must be a URL string.`);
    if (opts.allowInsecureUrl === true) checkUrl(value, label, { allowInsecure: true });
    else if (!/^https:\/\//i.test(value)) {
      checkUrl(value, label); // invalid URL or another scheme: its message
      throw usage(`${label} must use https:// (got "${value}").`);
    }
  }
}

export interface QuerySpec {
  fields: FieldSpec[];
}

/** Flags for the filter query params of `op` (pagination params are handled by --limit/--all). */
export function addQueryOptions(cmd: Command, op: Operation, skip: string[] = []): QuerySpec {
  const params = op.queryParams.filter((p) => !PAGINATION_PARAMS.has(p.name) && !skip.includes(p.name));
  return { fields: addParamOptions(cmd, params, (p) => (/_date$/.test(p.name) ? " (today, 7d, 2026-10-01)" : "")) };
}

export function buildQuery(ctx: Ctx, opts: Opts, spec: QuerySpec): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  for (const f of spec.fields) {
    let v = opts[f.attr];
    if (v === undefined) continue;
    if (/_date$/.test(f.name) && typeof v === "string") v = toYmd(parseTime(v, ctx.now()));
    q[f.name] = Array.isArray(v) ? v.join(",") : v;
  }
  return q;
}

const positiveInt = (flag: string) => (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw usage(`--${flag} must be a positive integer (got "${v}").`);
  return n;
};

export function addListOptions(cmd: Command): Command {
  return cmd.option("--limit <n>", "return at most this many items", positiveInt("limit")).option("--all", "fetch every page");
}

export interface ListPrint extends PrintOptions {
  itemsKey?: string;
}

/**
 * Lists through the pagination helper. Table/tsv/plain print `columns`; json/yaml print the response body with the
 * collected items (every page, cut to --limit) under its list key, so the shape never depends on the page count.
 */
export async function runList(ctx: Ctx, op: Operation, args: CallArgs, opts: Opts, print: ListPrint): Promise<void> {
  const limit = opts.limit as number | undefined;
  const all = !!opts.all;
  const r = await paginate(ctx.client, op, args, { limit, all, itemsKey: print.itemsKey });
  const mode = ctx.out.mode;
  if ((mode === "json" || mode === "yaml") && !ctx.flags.fields && !ctx.flags.quiet) {
    ctx.out.print(listBody(r.last, r.items, print.itemsKey));
    return;
  }
  ctx.out.print(r.items, print);
  if (r.hasMore && !all && mode !== "json" && mode !== "yaml")
    ctx.out.status(`Showing ${r.items.length}${r.total !== undefined ? ` of ${r.total}` : ""}. Use --all or --limit <n> for more.`);
}

/** Confirms, then sends a side-effecting request. */
export async function confirmedCall<T = unknown>(ctx: Ctx, summary: ConfirmSummary, op: Operation, args: CallArgs = {}): Promise<T> {
  await requireConfirmation(ctx, summary);
  return ctx.client.call<T>(op, { ...args, sideEffect: true });
}

const LOOKS_REDACTED = /^(<?redacted>?|\[redacted\]|\*+|x+)$/i;

/** Adds --reveal-secret and --secret-file to a create command whose response carries a secret shown only once. */
export function addSecretOptions(cmd: Command, label: string): Command {
  return cmd
    .option("--reveal-secret", `print the returned ${label} once on stderr (off by default)`)
    .option("--secret-file <path>", `write the returned ${label} to this new file (mode 0600), for CI`);
}

/** Fails before the request when --secret-file already exists, so the one-time secret is never lost after it. */
export function checkSecretFile(opts: Opts): void {
  const file = opts.secretFile as string | undefined;
  if (file !== undefined && existsSync(file)) throw usage(`--secret-file ${file} already exists; pick a new path.`);
}

/**
 * Handles a secret the API returns exactly once (a new SIP password or Auth Token). The printed record stays
 * redacted (only `--debug --show-secrets` lifts that). The value is written to --secret-file (0600) and shown on
 * stderr only with --reveal-secret; a value equal to one the user typed (e.g. their own --password) is never echoed.
 */
export function revealOnce(ctx: Ctx, data: unknown, paths: string[], label: string, opts: Opts = {}, typed: Record<string, unknown> = {}): void {
  if (ctx.flags.debug && ctx.flags.showSecrets) return; // already visible in the record
  for (const path of paths) {
    const v = getPath(data, path);
    if (typeof v !== "string" || !v || LOOKS_REDACTED.test(v)) continue;
    if (Object.values(typed).includes(v)) return; // the user already knows it
    const file = opts.secretFile as string | undefined;
    if (file) {
      writeFileSync(file, v + "\n", { mode: 0o600, flag: "wx" });
      ctx.out.status(`Saved the ${label} to ${file} (mode 0600).`);
    }
    if (opts.revealSecret) ctx.out.warn(`${label} (shown ONCE, store it now; it is redacted everywhere else): ${v}`);
    else if (!file) ctx.out.warn(`A ${label} was returned but not shown. Pass --reveal-secret or --secret-file <path> to capture it, or read it from the Vobiz console.`);
    return;
  }
}

/** The URL host of an optional URL value, for confirmation summaries. */
export function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `<name>_host: host` for every `<name>_url` in a body, so a confirmation shows where callbacks will go. */
export function urlHosts(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    const host = /_url$/.test(k) ? hostOf(v) : undefined;
    if (host) out[`${k.replace(/_url$/, "")}_host`] = host;
  }
  return out;
}

/** Summary details from a body: the listed keys that are set, as strings (secrets never included). */
export function detailsFrom(body: Record<string, unknown>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = body[k];
    if (v === undefined || v === null || v === "") continue;
    out[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return out;
}

/** Text after the examples heading for --help. */
export const examples = (...lines: string[]): string => `\nExamples:\n${lines.map((l) => `  ${l}`).join("\n")}`;


export interface CrudSpec {
  /** Singular noun for messages ("trunk", "SIP credential"). */
  noun: string;
  /** Plural noun (default: noun + "s"). */
  plural?: string;
  idArg: string;
  idKey: string;
  columns: string[];
  list: Operation;
  get?: Operation;
  create: Operation;
  update: Operation;
  delete: Operation;
  /** Path param name of the id. */
  idParam: string;
  /** Body keys shown in the confirmation summary. */
  summaryKeys: string[];
  /** A create response may carry a secret to show once. */
  secretPaths?: string[];
  createExamples?: string[];
  /** Generate filter flags for the list operation's query params. */
  listFilters?: boolean;
  /** Label for the secret revealed once after create. */
  secretLabel?: string;
  /** Where the new id is in the create response (default: idKey). */
  createdIdPath?: string;
  /** Applied to a create response before it is printed (e.g. to drop session tokens). */
  sanitizeCreated?: (data: Record<string, unknown>) => unknown;
}

/** list / get / create / update / delete for one resource. */
export function crud(group: Command, ctx: Ctx, s: CrudSpec): void {
  const plural = s.plural ?? `${s.noun}s`;
  const list = addListOptions(group.command("list").alias("ls").description(`List ${plural}`));
  const filters = s.listFilters ? addQueryOptions(list, s.list) : { fields: [] };
  list.action(async (opts: Opts) => {
    await runList(ctx, s.list, { query: buildQuery(ctx, opts, filters) }, opts, { columns: s.columns, idKey: s.idKey, empty: `No ${plural}.` });
  });

  if (s.get) {
    const getOp = s.get;
    group
      .command("get")
      .argument(`<${s.idArg}>`, `${s.noun} ID`)
      .description(`Show one ${s.noun}`)
      .action(async (id: string) => {
        ctx.out.print(await ctx.client.call(getOp, { path: { [s.idParam]: id } }));
      });
  }

  const create = group.command("create").description(`Create ${withArticle(s.noun)}`);
  const createSpec = addBodyOptions(create, s.create);
  if (s.secretPaths) addSecretOptions(create, s.secretLabel ?? "password");
  if (s.createExamples) create.addHelpText("after", examples(...s.createExamples));
  create.action(async (opts: Opts) => {
    if (s.secretPaths) checkSecretFile(opts);
    const body = await buildBody(ctx, opts, createSpec, s.create);
    const details = detailsFrom(body, s.summaryKeys);
    Object.assign(details, urlHosts(body));
    const data = await confirmedCall<Record<string, unknown>>(ctx, { action: `Create ${withArticle(s.noun)}`, details: { account: ctx.client.authId, ...details } }, s.create, { body });
    if (s.secretPaths) revealOnce(ctx, data, s.secretPaths, s.secretLabel ?? "password", opts, body);
    const newId = data ? getPath(data, s.createdIdPath ?? s.idKey) : undefined;
    ctx.out.status(`Created ${s.noun}${newId ? ` ${String(newId)}` : ""}.`);
    ctx.out.print(data && s.sanitizeCreated ? s.sanitizeCreated(data) : (data ?? {}));
  });

  const update = group.command("update").argument(`<${s.idArg}>`, `${s.noun} ID`).description(`Update ${withArticle(s.noun)}`);
  const updateSpec = addBodyOptions(update, s.update);
  update.action(async (id: string, opts: Opts) => {
    const body = await buildBody(ctx, opts, updateSpec, s.update, { requireSomething: true });
    const details = detailsFrom(body, s.summaryKeys);
    Object.assign(details, urlHosts(body));
    if ("password" in body) details.password = "(changed)";
    const data = await confirmedCall(ctx, { action: `Update ${s.noun} ${id}`, details: { changes: Object.keys(body).join(", "), ...details } }, s.update, {
      path: { [s.idParam]: id },
      body,
    });
    ctx.out.status(`Updated ${s.noun} ${id}.`);
    ctx.out.print(data ?? { [s.idKey]: id, updated: true });
  });

  group
    .command("delete")
    .alias("rm")
    .argument(`<${s.idArg}>`, `${s.noun} ID`)
    .description(`Delete ${withArticle(s.noun)}`)
    .action(async (id: string) => {
      await confirmedCall(ctx, { action: `DELETE ${s.noun} ${id}`, details: { account: ctx.client.authId, note: "this cannot be undone" } }, s.delete, {
        path: { [s.idParam]: id },
      });
      ctx.out.success(`Deleted ${s.noun} ${id}.`, { [s.idKey]: id, deleted: true });
    });
}

