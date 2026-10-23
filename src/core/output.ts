/**
 * Everything the CLI prints goes through a Printer so stdout stays data-only and secrets never reach a terminal.
 *
 *   table  aligned columns, truncated to the terminal width (default on a TTY)
 *   json   pretty JSON (default when stdout is piped)
 *   yaml   YAML
 *   tsv    header row then tab-separated rows, nested values as compact JSON
 *   plain  rows without header or truncation; one `key: value` per line for single objects
 *   jsonl  one compact JSON value per line: each row of a list, or the single record (for streaming into jq, agents)
 *
 * `--fields a,b.c` projects dot paths, `--query items[*].e164` then selects a path out of what would be printed
 * (dot paths with `[n]`, `[-1]` and `[*]` for arrays), `--quiet` prints the primary id of each row, status lines and
 * warnings go to stderr. Every printed value passes through `redact` unless `--debug --show-secrets`.
 */
import pc from "picocolors";
import YAML from "yaml";
import { CHECK_STATE_HINT, VobizError, isRetryable, type ErrorKind } from "./errors.js";
import { isUnsafeKey } from "./keys.js";
import { redact, scrubSecrets } from "./redact.js";
import { cleanCell, cleanMessage, tsvCell } from "./sanitize.js";
import { renderTable } from "./table.js";

export const OUTPUT_MODES = ["table", "json", "yaml", "tsv", "plain", "jsonl"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

export interface Stream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

/** What a Printer needs from the context (kept narrow so it is easy to construct in tests). */
export interface PrinterHost {
  flags: { output?: OutputMode; json?: boolean; fields?: string[]; query?: string; quiet?: boolean; debug?: boolean; showSecrets?: boolean; color?: boolean };
  env: NodeJS.ProcessEnv;
  stdout: Stream;
  stderr: Stream;
  /** settings.output from config.json, used only when stdout is a TTY. */
  defaultOutput?: OutputMode;
}

export interface PrintOptions {
  /** Default columns (dot paths) for table/tsv/plain when --fields is not given. */
  columns?: string[];
  /** Key printed by --quiet; otherwise the first of PRIMARY_KEYS present. */
  idKey?: string;
  /** stderr note in human modes when a list is empty. */
  empty?: string;
}

const PRIMARY_KEYS = ["id", "uuid", "call_uuid", "request_uuid", "message_uuid", "auth_id", "e164", "number", "phone_number", "name"];

const HINTS: Partial<Record<ErrorKind, string>> = {
  auth_failed: "Check your Auth ID and Auth Token with `vobiz whoami --check`, or run `vobiz login` again.",
  forbidden: "These credentials cannot access this resource. Check the account (main account vs sub-account).",
  account_suspended: "The account is suspended. Contact support@vobiz.ai.",
  insufficient_balance: "Top up the account at https://console.vobiz.ai.",
  rate_limited: "Wait a moment and try again.",
  service_unavailable: "Vobiz is temporarily unavailable. Try again shortly.",
  timeout: "Raise --timeout, or run `vobiz doctor` to check connectivity.",
  network_error: "Run `vobiz doctor` to check connectivity and proxy settings.",
  outcome_unknown: CHECK_STATE_HINT,
  confirmation_required: "Re-run with --yes to confirm, or --dry-run to preview.",
  invalid_input: "Run the command with --help for usage.",
  internal_error: "Run again with --verbose for details, and report it at https://github.com/vobiz-ai/Vobiz-CLI/issues.",
};

export const hintFor = (kind: ErrorKind): string | undefined => HINTS[kind];

/** Own property `key` of `obj`, never an inherited one; `__proto__`, `constructor` and `prototype` read as missing. */
function ownValue(obj: unknown, key: string): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object" || isUnsafeKey(key)) return undefined;
  return Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

/** Sets `key` as an own data property, even for "__proto__" (plain assignment would change the prototype). */
function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Reads a dot path (`a.b.0.c`) out of a value (own properties only). */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = ownValue(cur, part);
  }
  return cur;
}

/** Keeps only `paths`, rebuilding the nesting (`{a:{b:1}}` for `a.b`). Missing paths are left out. */
export function project(obj: unknown, paths: string[]): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const v = getPath(obj, path);
    if (v === undefined) continue;
    const parts = path.split(".");
    let cur = out;
    for (const p of parts.slice(0, -1)) {
      if (!Object.hasOwn(cur, p) || !cur[p] || typeof cur[p] !== "object") setOwn(cur, p, {});
      cur = cur[p] as Record<string, unknown>;
    }
    setOwn(cur, parts[parts.length - 1], v);
  }
  return out;
}

type QueryStep = { kind: "key"; key: string } | { kind: "index"; index: number } | { kind: "all" };

/**
 * Parses a `--query` path: dot-separated keys, each optionally followed by `[n]` (negative counts from the end) or
 * `[*]` (every element). A path may start with a bracket (`[0].id`, `[*].e164`). Throws on anything else.
 */
export function parseQuery(path: string): QueryStep[] {
  const steps: QueryStep[] = [];
  const src = path.trim();
  if (!src) throw new VobizError("invalid_input", "--query needs a path, e.g. data[0].uuid or items[*].e164.");
  let i = 0;
  let expectKey = !src.startsWith("[");
  while (i < src.length) {
    const ch = src[i];
    if (ch === "[") {
      const end = src.indexOf("]", i);
      const inner = end < 0 ? "" : src.slice(i + 1, end);
      if (inner === "*") steps.push({ kind: "all" });
      else if (/^-?\d+$/.test(inner)) steps.push({ kind: "index", index: Number(inner) });
      else throw new VobizError("invalid_input", `--query: expected [n] or [*] at position ${i + 1} of "${path}".`);
      i = end + 1;
      expectKey = false;
      continue;
    }
    if (ch === ".") {
      if (expectKey) throw new VobizError("invalid_input", `--query: unexpected "." at position ${i + 1} of "${path}".`);
      expectKey = true;
      i++;
      continue;
    }
    if (!expectKey) throw new VobizError("invalid_input", `--query: expected ".", "[n]" or "[*]" at position ${i + 1} of "${path}".`);
    let j = i;
    while (j < src.length && src[j] !== "." && src[j] !== "[" && src[j] !== "]") j++;
    if (j === i) throw new VobizError("invalid_input", `--query: unexpected "${src[i]}" at position ${i + 1} of "${path}".`);
    steps.push({ kind: "key", key: src.slice(i, j) });
    i = j;
    expectKey = false;
  }
  if (expectKey) throw new VobizError("invalid_input", `--query: "${path}" ends with ".".`);
  return steps;
}

function runQuery(value: unknown, steps: QueryStep[], at: number): unknown {
  if (at === steps.length) return value;
  const step = steps[at];
  if (step.kind === "all") {
    const items = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : undefined;
    if (!items) return undefined;
    const nested = steps.slice(at + 1).some((s) => s.kind === "all");
    const out: unknown[] = [];
    for (const item of items) {
      const r = runQuery(item, steps, at + 1);
      if (r === undefined) continue;
      if (nested && Array.isArray(r)) out.push(...r);
      else out.push(r);
    }
    return out;
  }
  if (step.kind === "index") {
    if (!Array.isArray(value)) return undefined;
    const i = step.index < 0 ? value.length + step.index : step.index;
    return runQuery(value[i], steps, at + 1);
  }
  if (value === null || value === undefined || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return /^\d+$/.test(step.key) ? runQuery(value[Number(step.key)], steps, at + 1) : undefined;
  return runQuery(ownValue(value, step.key), steps, at + 1);
}

/** Evaluates a `--query` path (see parseQuery). Missing paths give undefined; `[*]` drops elements without a match. */
export function queryPath(value: unknown, path: string | QueryStep[]): unknown {
  return runQuery(value, typeof path === "string" ? parseQuery(path) : path, 0);
}

/** Flattens nested objects to dot keys; arrays of scalars join with ", ", other arrays become compact JSON. */
export function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    out[prefix || "value"] = obj;
    return out;
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  if (!entries.length && prefix) setOwn(out, prefix, {});
  for (const [k, v] of entries) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else setOwn(out, key, v);
  }
  return out;
}

export function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) return v.map((x) => String(x ?? "")).join(", ");
  return JSON.stringify(v);
}

export class Printer {
  constructor(private readonly host: PrinterHost) {}

  get mode(): OutputMode {
    const f = this.host.flags;
    if (f.json) return "json";
    if (f.output) return f.output;
    const envMode = this.host.env.VOBIZ_OUTPUT as OutputMode | undefined;
    if (envMode && OUTPUT_MODES.includes(envMode)) return envMode;
    if (this.host.stdout.isTTY) return this.host.defaultOutput ?? "table";
    return "json";
  }

  /** True when the user explicitly asked for JSON (errors then print as JSON too). */
  get explicitJson(): boolean {
    const f = this.host.flags;
    const env = this.host.env.VOBIZ_OUTPUT;
    return !!f.json || f.output === "json" || f.output === "jsonl" || (!f.output && (env === "json" || env === "jsonl"));
  }

  /**
   * Errors are printed as one JSON line when a program reads the output: a machine mode (json, jsonl, yaml, which
   * includes the json default off a TTY) or stdout that is not a terminal.
   */
  get jsonErrors(): boolean {
    const m = this.mode;
    return m === "json" || m === "jsonl" || m === "yaml" || !this.host.stdout.isTTY;
  }

  /** Colors for one stream: off with --no-color or NO_COLOR, forced by FORCE_COLOR, otherwise only on a TTY. */
  private colorsFor(stream: Stream) {
    const env = this.host.env;
    const on =
      this.host.flags.color !== false && !env.NO_COLOR && (env.FORCE_COLOR ? env.FORCE_COLOR !== "0" : !!stream.isTTY);
    return pc.createColors(on);
  }

  private get colors() {
    return this.colorsFor(this.host.stderr);
  }

  private safe<T>(data: T): T {
    const f = this.host.flags;
    return f.debug && f.showSecrets ? data : redact(data);
  }

  /** Prints command data to stdout in the selected mode. Arrays are rows, objects are one record. */
  print(data: unknown, opts: PrintOptions = {}): void {
    const out = this.host.stdout;
    const fields = this.host.flags.fields?.length ? this.host.flags.fields : undefined;
    let value = this.safe(data);
    let isList = Array.isArray(value);

    if (this.host.flags.quiet) {
      const rows = isList ? (value as unknown[]) : [value];
      for (const r of rows) {
        const id = r && typeof r === "object" ? this.primary(r as Record<string, unknown>, opts.idKey) : r;
        if (id !== undefined && id !== null && id !== "") out.write(cleanCell(cell(id)) + "\n");
      }
      return;
    }

    if (fields) value = isList ? (value as unknown[]).map((r) => project(r, fields)) : project(value, fields);
    if (this.host.flags.query) {
      value = queryPath(value, this.host.flags.query);
      isList = Array.isArray(value);
    }
    const mode = this.mode;
    if (mode === "jsonl") {
      for (const row of isList ? (value as unknown[]) : [value]) out.write(JSON.stringify(row ?? null) + "\n");
      return;
    }
    if (mode === "json") {
      out.write(JSON.stringify(value ?? null, null, 2) + "\n");
      return;
    }
    if (mode === "yaml") {
      out.write(YAML.stringify(value ?? null));
      return;
    }

    if (isList) {
      const rows = value as unknown[];
      if (!rows.length) {
        if (mode === "table" || mode === "plain") this.status(opts.empty ?? "No results.");
        if (mode === "tsv" && (fields ?? opts.columns)) out.write((fields ?? opts.columns)!.map(tsvCell).join("\t") + "\n");
        return;
      }
      if (rows.every((r) => r === null || typeof r !== "object")) {
        for (const r of rows) out.write((mode === "tsv" ? tsvCell(cell(r)) : cleanCell(cell(r))) + "\n");
        return;
      }
      const flat = rows.map((r) => flatten(r));
      const columns = fields ?? opts.columns ?? unionKeys(flat);
      const grid = flat.map((r, i) => columns.map((c) => cell(Object.hasOwn(r, c) ? r[c] : getPath(rows[i], c))));
      if (mode === "tsv") {
        out.write([columns, ...grid].map((r) => r.map(tsvCell).join("\t")).join("\n") + "\n");
      } else if (mode === "plain") {
        out.write(grid.map((r) => r.map(cleanCell).join("  ").trimEnd()).join("\n") + "\n");
      } else {
        const c = this.colorsFor(out);
        out.write(
          renderTable(columns.map((h) => h.toUpperCase()), grid, { width: out.isTTY ? out.columns ?? 120 : undefined, header: c.bold }),
        );
      }
      return;
    }

    if (value === null || value === undefined || typeof value !== "object") {
      out.write((mode === "tsv" ? tsvCell(cell(value)) : cleanMessage(cell(value))) + "\n");
      return;
    }
    const flat = flatten(value);
    const keys = Object.keys(flat);
    if (mode === "tsv") {
      out.write(keys.map(tsvCell).join("\t") + "\n" + keys.map((k) => tsvCell(cell(flat[k]))).join("\t") + "\n");
    } else if (mode === "plain") {
      out.write(keys.map((k) => `${cleanCell(k)}: ${cleanCell(cell(flat[k]))}`).join("\n") + "\n");
    } else {
      const c = this.colorsFor(out);
      out.write(
        renderTable(
          ["FIELD", "VALUE"],
          keys.map((k) => [k, cell(flat[k])]),
          { width: out.isTTY ? out.columns ?? 120 : undefined, header: c.bold, maxColumn: 100 },
        ),
      );
    }
  }

  private primary(row: Record<string, unknown>, idKey?: string): unknown {
    if (idKey) return getPath(row, idKey);
    for (const k of PRIMARY_KEYS) if (row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
    return undefined;
  }

  /** Progress or confirmation line on stderr (never stdout). Suppressed by --quiet. */
  status(message: string): void {
    if (this.host.flags.quiet) return;
    this.host.stderr.write(cleanMessage(message) + "\n");
  }

  warn(message: string): void {
    this.host.stderr.write(`${this.colors.yellow("warning:")} ${cleanMessage(message)}\n`);
  }

  /**
   * Result of an action. Machine modes (json, yaml, tsv) print `data` to stdout; human modes print `message`
   * to stderr, so scripts always get structured data and people get a sentence.
   */
  success(message: string, data?: unknown): void {
    const mode = this.mode;
    if (data !== undefined && (mode === "json" || mode === "jsonl" || mode === "yaml" || mode === "tsv" || this.host.flags.quiet)) this.print(data);
    else if (!this.host.flags.quiet) this.host.stderr.write(`${this.colors.green("✓")} ${cleanMessage(message)}\n`);
  }

  /** Prints an error to stderr as `vobiz: <kind>: <message>` plus a hint, or as one JSON line (see jsonErrors). */
  printError(err: unknown): void {
    const e = toVobizError(err);
    const message = scrubSecrets(e.message);
    if (this.jsonErrors) {
      const body = { error: e.kind, message, status: e.status ?? null, retryable: isRetryable(e.kind), hint: hintFor(e.kind) ?? null };
      this.host.stderr.write(JSON.stringify(this.safe(body)) + "\n");
      return;
    }
    const c = this.colors;
    this.host.stderr.write(`${c.red("vobiz:")} ${e.kind}: ${cleanMessage(message)}\n`);
    const hint = hintFor(e.kind);
    if (hint && !message.includes(hint)) this.host.stderr.write(`${c.dim(hint)}\n`);
  }
}

export function toVobizError(err: unknown): VobizError {
  if (err instanceof VobizError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new VobizError("internal_error", msg || "Unexpected error.");
}

function unionKeys(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

