/**
 * `vobiz cdr`: call detail records. `list` and `search` share every filter (search also returns the applied
 * filters and a summary), `recent` needs no date range, `get` reads one record and `export` streams the CSV to a
 * file or stdout.
 */
import { Option, type Command } from "commander";
import type { Ctx } from "../core/context.js";
import { usage } from "../core/errors.js";
import { assertWritableTarget } from "../core/fsafe.js";
import { op } from "../core/ops.js";
import { paginate } from "../core/pagination.js";
import { parseRange, toYmd } from "../core/time.js";
import { addListFlags, intArg, isRec, printPage, streamOperation, type ListFlags, type Rec } from "./voice-shared.js";

const LIST = op("list-cdrs");
const SEARCH = op("search-cdrs");
const RECENT = op("list-recent-cdrs");
const EXPORT = op("export-cdrs");
const GET = op("get-cdr");

const COLUMNS = ["uuid", "start_time", "call_direction", "caller_id_number", "destination_number", "duration", "hangup_cause", "total_cost"];

interface FilterOpts {
  from?: string;
  to?: string;
  direction?: string;
  fromNumber?: string;
  toNumber?: string;
  minDuration?: number;
  sipCallId?: string;
  bridgeUuid?: string;
  hangupCause?: string;
  disposition?: string;
  context?: string;
  campaignId?: string;
  search?: string;
}

function addFilters(cmd: Command): Command {
  return cmd
    .option("--from <when>", "start date (today, yesterday, 7d, 2026-10-01 or ISO)")
    .option("--to <when>", "end date, inclusive (default: today when --from is given)")
    .addOption(new Option("--direction <dir>", "call direction").choices(["inbound", "outbound"]))
    .option("--from-number <number>", "caller number")
    .option("--to-number <number>", "destination number")
    .option("--min-duration <seconds>", "only calls at least this long", intArg(0, 86_400))
    .option("--sip-call-id <id>", "SIP Call-ID")
    .option("--bridge-uuid <uuid>", "UUID of the bridged leg")
    .option("--hangup-cause <cause>", "hangup cause, e.g. NORMAL_CLEARING or NO_ANSWER")
    .option("--disposition <value>", "hangup disposition, e.g. send_refuse")
    .option("--context <context>", "call context, e.g. voice-api or sip-trunking")
    .option("--campaign-id <id>", "campaign id")
    .option("--search <text>", "free-text search across numbers and ids");
}

/** CDR query parameters. The API wants start_date and end_date together, as YYYY-MM-DD. */
export function cdrQuery(o: FilterOpts, now: Date): Rec {
  if (o.to && !o.from) throw usage("--to needs --from (the API filters by a start and end date together).");
  const r = parseRange(o.from, o.to ?? (o.from ? "now" : undefined), now);
  return {
    start_date: r.from ? toYmd(r.from) : undefined,
    end_date: r.to ? toYmd(r.to) : undefined,
    call_direction: o.direction,
    from_number: o.fromNumber,
    to_number: o.toNumber,
    min_duration: o.minDuration,
    sip_call_id: o.sipCallId,
    bridge_uuid: o.bridgeUuid,
    hangup_cause: o.hangupCause,
    hangup_disposition: o.disposition,
    context: o.context,
    campaign_id: o.campaignId,
    search: o.search,
  };
}

function printSummary(ctx: Ctx, last: unknown) {
  const s = isRec(last) && isRec(last.summary) ? last.summary : undefined;
  if (!s || ctx.out.mode === "json" || ctx.out.mode === "yaml") return;
  const parts = [
    s.totalCalls !== undefined ? `${s.totalCalls} calls` : "",
    s.answeredCalls !== undefined ? `${s.answeredCalls} answered` : "",
    s.total_billable_seconds !== undefined ? `${s.total_billable_seconds}s billable` : "",
    s.total_cost !== undefined ? `cost ${s.total_cost}` : "",
  ].filter(Boolean);
  if (parts.length) ctx.out.status(`Summary: ${parts.join(", ")}`);
}

export function register(program: Command, ctx: Ctx): void {
  const cdr = program.command("cdr").description("Call detail records: list, search, recent, get and CSV export");

  for (const [name, operation, desc] of [
    ["list", LIST, "List call records, newest first"],
    ["search", SEARCH, "Search call records; also returns the applied filters and totals"],
  ] as const) {
    const cmd = addListFlags(addFilters(cdr.command(name).description(desc)), 20);
    if (name === "list") cmd.alias("ls");
    cmd
      .addHelpText(
        "after",
        `\nExamples:\n  vobiz cdr ${name} --from 7d --direction outbound\n  vobiz cdr ${name} --from 2026-10-01 --to 2026-10-07 --hangup-cause NO_ANSWER --all --output tsv`,
      )
      .action(async (o: FilterOpts & ListFlags) => {
        const page = await paginate(ctx.client, operation, { query: cdrQuery(o, ctx.now()) }, { limit: o.limit ?? 20, all: o.all, itemsKey: "data" });
        printPage(ctx, page, { itemsKey: "data", columns: COLUMNS, idKey: "uuid", empty: "No call records match." });
        printSummary(ctx, page.last);
      });
  }

  cdr
    .command("recent")
    .description("Show the most recent call records (no date range needed)")
    .option("--limit <n>", "how many records (default: 20)", intArg(1, 1000))
    .action(async (o: { limit?: number }) => {
      const body = await ctx.client.call<Rec>(RECENT, { query: { limit: o.limit ?? 20 } });
      const mode = ctx.out.mode;
      if ((mode === "json" || mode === "yaml") && !ctx.flags.fields?.length && !ctx.flags.quiet) {
        ctx.out.print(body);
        return;
      }
      const rows = isRec(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
      ctx.out.print(rows, { columns: COLUMNS, idKey: "uuid", empty: "No call records yet." });
    });

  cdr
    .command("get")
    .argument("<call-id>", "call UUID of a completed call")
    .description("Show the call record of one completed call")
    .action(async (id: string) => {
      const body = await ctx.client.call<Rec>(GET, { path: { call_id: id } });
      const mode = ctx.out.mode;
      ctx.out.print((mode === "json" || mode === "yaml") && !ctx.flags.fields?.length ? body : isRec(body?.data) ? body.data : body, { idKey: "uuid" });
    });

  addFilters(cdr.command("export").description("Export call records as CSV to a file (or stdout)"))
    .option("--out <file>", "write the CSV here instead of stdout")
    .option("--force", "overwrite an existing file")
    .addHelpText("after", "\nExamples:\n  vobiz cdr export --from 2026-10-01 --to 2026-10-31 --out october.csv\n  vobiz cdr export --from 7d --direction inbound | head")
    .action(async (o: FilterOpts & { out?: string; force?: boolean }) => {
      if (o.out) assertWritableTarget(o.out, !!o.force);
      const bytes = await streamOperation(ctx, EXPORT, cdrQuery(o, ctx.now()), "text/csv", { out: o.out, force: o.force });
      if (o.out) ctx.out.success(`Saved ${o.out} (${bytes} bytes).`, { file: o.out, bytes });
    });
}
