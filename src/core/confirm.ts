/**
 * Gate for every write (POST/PUT/PATCH/DELETE, purchases, calls, messages):
 *   --dry-run   print the summary to stderr and return; the next ctx.client.call then prints the request and
 *               exits 0 without sending (commands that do work outside the client must check ctx.flags.dryRun).
 *   --yes       print the summary and continue (also VOBIZ_YES=1).
 *   no TTY      refuse with confirmation_required (exit 6): scripts must opt in with --yes.
 *   TTY         show the summary and ask; "no" exits 6 and nothing is sent.
 */
import type { Ctx } from "./context.js";
import { VobizError } from "./errors.js";

export interface ConfirmSummary {
  /** One line, imperative: "Release +14155550100", "Place a call to +91…". */
  action: string;
  /** Shown as `key: value` lines (destination, caller ID, URL host…). */
  details?: Record<string, string>;
  /** Estimated cost when the API provides one, e.g. "USD 1.00 now, then USD 1.00/month". */
  cost?: string;
}

export function formatSummary(s: ConfirmSummary): string {
  const lines = [s.action];
  for (const [k, v] of Object.entries(s.details ?? {})) lines.push(`  ${k}: ${v}`);
  if (s.cost) lines.push(`  cost: ${s.cost}`);
  return lines.join("\n");
}

export function yesFlag(ctx: Ctx): boolean {
  const env = ctx.env.VOBIZ_YES;
  return !!ctx.flags.yes || env === "1" || env === "true";
}

export async function requireConfirmation(ctx: Ctx, summary: ConfirmSummary): Promise<void> {
  const text = formatSummary(summary);
  if (ctx.flags.dryRun) {
    ctx.stderr.write(`[dry-run] ${text}\n`);
    return;
  }
  if (yesFlag(ctx)) {
    ctx.out.status(text);
    return;
  }
  if (!ctx.isTTY.stdin) {
    throw new VobizError("confirmation_required", `${summary.action}: confirmation required. Re-run with --yes (stdin is not a terminal).`);
  }
  ctx.stderr.write(text + "\n");
  const ok = await ctx.prompts.confirm("Continue?", false);
  if (!ok) throw new VobizError("confirmation_required", "Cancelled. Nothing was sent.");
}
