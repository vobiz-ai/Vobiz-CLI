/**
 * Gate for every write (POST/PUT/PATCH/DELETE, purchases, calls, messages):
 *   --dry-run   print the summary to stderr and return; the next ctx.client.call then prints the request and
 *               exits 0 without sending (commands that do work outside the client must check ctx.flags.dryRun).
 *   --yes       print the summary and continue (also VOBIZ_YES=1, which prints a one-line notice every time).
 *   no TTY      refuse with confirmation_required (exit 6): scripts must opt in with --yes.
 *   TTY         show the summary and ask; "no" exits 6 and nothing is sent.
 *
 * The summary always starts with the account the write goes to, and every detail value is rendered on one line:
 * line breaks and control characters become visible markers and long values are capped, so a value that came
 * from the API (a broadcast or trunk name) cannot forge a "cost:" or "recipients:" line.
 */
import { cleanMessage } from "./sanitize.js";
import type { Ctx } from "./context.js";
import { VobizError } from "./errors.js";

/** A detail with options; a plain string is `{ value }`. */
export interface ConfirmDetail {
  value: string;
  /** The value came from the API or a third party: it is rendered in quotes so it cannot pass for a CLI line. */
  fromApi?: boolean;
  /** Maximum characters shown (default 200); longer values end with "…". */
  max?: number;
}

export interface ConfirmSummary {
  /** One line, imperative: "Release +14155550100", "Place a call to +91…". */
  action: string;
  /** Shown as `key: value` lines (destination, caller ID, URL host…). */
  details?: Record<string, string | ConfirmDetail>;
  /** Estimated cost when the API provides one, e.g. "USD 1.00 now, then USD 1.00/month". */
  cost?: string;
  /** false: leave out the `account:` line (credential management, where the active account is not the target). */
  account?: false;
}

export const DETAIL_MAX = 200;

/**
 * One visible line: CR/LF become "␤", every other C0/C1 control, DEL and the bidi override/isolate code points
 * become "·", and the result is capped at `max` characters with "…".
 */
export function oneLine(value: string, max = DETAIL_MAX): string {
  const s = value
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, "\u2424")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "\u00b7");
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}

function renderDetail(d: string | ConfirmDetail): string {
  const o = typeof d === "string" ? { value: d } : d;
  const v = oneLine(o.value, o.max ?? DETAIL_MAX);
  return o.fromApi ? `"${v.replace(/"/g, '\\"')}"` : v;
}

export function formatSummary(s: ConfirmSummary): string {
  const lines = [oneLine(s.action, 500)];
  for (const [k, v] of Object.entries(s.details ?? {})) lines.push(`  ${oneLine(k, 60)}: ${renderDetail(v)}`);
  if (s.cost) lines.push(`  cost: ${oneLine(s.cost)}`);
  return cleanMessage(lines.join("\n"));
}

/** `MA_XXXXXXXX (profile "default")`, `(env)` or `(flags)`; undefined when no credentials resolve. */
export function accountLabel(ctx: Ctx): string | undefined {
  try {
    const c = ctx.creds;
    return `${c.authId} (${c.source === "profile" ? `profile "${c.profile ?? "default"}"` : c.source})`;
  } catch {
    return undefined;
  }
}

/** Puts `account: <auth id> (<source>)` first, dropping a caller's own `account` detail when it is just the Auth ID. */
function withAccount(ctx: Ctx, s: ConfirmSummary): ConfirmSummary {
  const account = s.account === false ? undefined : accountLabel(ctx);
  if (!account) return s;
  const rest = { ...(s.details ?? {}) };
  const own = rest.account;
  const authId = account.split(" ")[0];
  if (own !== undefined && (typeof own === "string" ? own : own.value) === authId) delete rest.account;
  return { ...s, details: { account, ...(rest.account !== undefined ? { "account (target)": rest.account } : {}), ...omit(rest, "account") } };
}

function omit<T extends Record<string, unknown>>(o: T, key: string): T {
  const { [key]: _drop, ...rest } = o;
  return rest as T;
}

/** True when --yes was passed. */
export function yesFlag(ctx: Ctx): boolean {
  return !!ctx.flags.yes || yesFromEnv(ctx);
}

function yesFromEnv(ctx: Ctx): boolean {
  const env = ctx.env.VOBIZ_YES;
  return env === "1" || env === "true";
}

export async function requireConfirmation(ctx: Ctx, summary: ConfirmSummary): Promise<void> {
  const text = formatSummary(withAccount(ctx, summary));
  if (ctx.flags.dryRun) {
    ctx.stderr.write(`[dry-run] ${text}\n`);
    return;
  }
  if (yesFlag(ctx)) {
    ctx.out.status(text);
    // An inherited VOBIZ_YES silently approving writes is easy to miss; say so even under --quiet.
    if (!ctx.flags.yes) ctx.stderr.write(`confirmation skipped: VOBIZ_YES is set in the environment (${oneLine(summary.action, 120)})\n`);
    return;
  }
  if (!ctx.isTTY.stdin) {
    throw new VobizError("confirmation_required", `${oneLine(summary.action, 200)}: confirmation required. Re-run with --yes (stdin is not a terminal).`);
  }
  ctx.stderr.write(text + "\n");
  const ok = await ctx.prompts.confirm("Continue?", false);
  if (!ok) throw new VobizError("confirmation_required", "Cancelled. Nothing was sent.");
}
