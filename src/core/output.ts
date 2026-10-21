/**
 * Everything the CLI prints goes through a Printer so stdout stays data-only and secrets never reach a terminal.
 *
 *   table  aligned columns, truncated to the terminal width (default on a TTY)
 *   json   pretty JSON (default when stdout is piped)
 *   yaml   YAML
 *   tsv    header row then tab-separated rows, nested values as compact JSON
 *   plain  rows without header or truncation; one `key: value` per line for single objects
 *
 * `--fields a,b.c` projects dot paths, `--quiet` prints the primary id of each row, status lines and warnings
 * go to stderr. Every printed value passes through `redact` unless `--debug --show-secrets`.
 */
import pc from "picocolors";
import YAML from "yaml";
import { VobizError, isRetryable, type ErrorKind } from "./errors.js";
import { redact } from "./redact.js";
import { renderTable } from "./table.js";

export const OUTPUT_MODES = ["table", "json", "yaml", "tsv", "plain"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

export interface Stream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

/** What a Printer needs from the context (kept narrow so it is easy to construct in tests). */
export interface PrinterHost {
  flags: { output?: OutputMode; json?: boolean; fields?: string[]; quiet?: boolean; debug?: boolean; showSecrets?: boolean; color?: boolean };
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
  outcome_unknown: "Do not retry blindly: check the current state (for example `vobiz calls list`) before trying again.",
  confirmation_required: "Re-run with --yes to confirm, or --dry-run to preview.",
  invalid_input: "Run the command with --help for usage.",
  internal_error: "Run again with --verbose for details, and report it at https://github.com/vobiz-ai/Vobiz-CLI/issues.",
};

export const hintFor = (kind: ErrorKind): string | undefined => HINTS[kind];

/** Reads a dot path (`a.b.0.c`) out of a value. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
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
    for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}

/** Flattens nested objects to dot keys; arrays of scalars join with ", ", other arrays become compact JSON. */
export function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    out[prefix || "value"] = obj;
    return out;
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  if (!entries.length && prefix) out[prefix] = {};
  for (const [k, v] of entries) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
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
    return !!f.json || f.output === "json" || (!f.output && this.host.env.VOBIZ_OUTPUT === "json");
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
    const isList = Array.isArray(value);

    if (this.host.flags.quiet) {
      const rows = isList ? (value as unknown[]) : [value];
      for (const r of rows) {
        const id = r && typeof r === "object" ? this.primary(r as Record<string, unknown>, opts.idKey) : r;
        if (id !== undefined && id !== null && id !== "") out.write(cell(id) + "\n");
      }
      return;
    }

    if (fields) value = isList ? (value as unknown[]).map((r) => project(r, fields)) : project(value, fields);
    const mode = this.mode;
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
        if (mode === "tsv" && (fields ?? opts.columns)) out.write((fields ?? opts.columns)!.join("\t") + "\n");
        return;
      }
      if (rows.every((r) => r === null || typeof r !== "object")) {
        for (const r of rows) out.write(cell(r) + "\n");
        return;
      }
      const flat = rows.map((r) => flatten(r));
      const columns = fields ?? opts.columns ?? unionKeys(flat);
      const grid = flat.map((r, i) => columns.map((c) => cell(c in r ? r[c] : getPath(rows[i], c))));
      if (mode === "tsv") {
        out.write([columns, ...grid].map((r) => r.map(tsvEscape).join("\t")).join("\n") + "\n");
      } else if (mode === "plain") {
        out.write(grid.map((r) => r.join("  ").trimEnd()).join("\n") + "\n");
      } else {
        const c = this.colorsFor(out);
        out.write(
          renderTable(columns.map((h) => h.toUpperCase()), grid, { width: out.isTTY ? out.columns ?? 120 : undefined, header: c.bold }),
        );
      }
      return;
    }

    if (value === null || value === undefined || typeof value !== "object") {
      out.write(cell(value) + "\n");
      return;
    }
    const flat = flatten(value);
    const keys = Object.keys(flat);
    if (mode === "tsv") {
      out.write(keys.map(tsvEscape).join("\t") + "\n" + keys.map((k) => tsvEscape(cell(flat[k]))).join("\t") + "\n");
    } else if (mode === "plain") {
      out.write(keys.map((k) => `${k}: ${cell(flat[k])}`).join("\n") + "\n");
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
    this.host.stderr.write(message + "\n");
  }

  warn(message: string): void {
    this.host.stderr.write(`${this.colors.yellow("warning:")} ${message}\n`);
  }

  /**
   * Result of an action. Machine modes (json, yaml, tsv) print `data` to stdout; human modes print `message`
   * to stderr, so scripts always get structured data and people get a sentence.
   */
  success(message: string, data?: unknown): void {
    const mode = this.mode;
    if (data !== undefined && (mode === "json" || mode === "yaml" || mode === "tsv" || this.host.flags.quiet)) this.print(data);
    else this.status(`${this.colors.green("✓")} ${message}`);
  }

  /** Prints an error to stderr as `vobiz: <kind>: <message>` plus a hint, or as JSON when --output json. */
  printError(err: unknown): void {
    const e = toVobizError(err);
    if (this.explicitJson) {
      const body = { error: e.kind, message: e.message, status: e.status ?? null, retryable: isRetryable(e.kind), hint: hintFor(e.kind) ?? null };
      this.host.stderr.write(JSON.stringify(this.safe(body)) + "\n");
      return;
    }
    const c = this.colors;
    this.host.stderr.write(`${c.red("vobiz:")} ${e.kind}: ${e.message}\n`);
    const hint = hintFor(e.kind);
    if (hint && !e.message.includes(hint)) this.host.stderr.write(`${c.dim(hint)}\n`);
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

const tsvEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r?\n/g, "\\n");
