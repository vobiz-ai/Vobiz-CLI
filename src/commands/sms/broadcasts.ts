/**
 * `vobiz sms broadcasts …`: bulk SMS. Create a draft, upload recipients (CSV/XLSX with template variables, or a
 * plain list of numbers), preview, then launch. Launch sends real, billed messages to every pending recipient,
 * so it shows the recipient count and estimated segments first.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Option, type Command } from "commander";
import { requireConfirmation } from "../../core/confirm.js";
import type { Ctx } from "../../core/context.js";
import { usage } from "../../core/errors.js";
import { op } from "../../core/ops.js";
import { toE164 } from "../../core/phone.js";
import {
  collect,
  compact,
  fileForm,
  humanSize,
  intArg,
  isRec,
  listCommand,
  pagingOptions,
  printList,
  printResult,
  scheduleAt,
  textPreview,
  type ListFlags,
  type Rec,
} from "./shared.js";

const LIST = op("list-broadcasts");
const CREATE = op("create-broadcast");
const GET = op("get-broadcast");
const UPDATE = op("update-broadcast");
const DELETE = op("delete-broadcast");
const RECIPIENTS = op("list-recipients");
const UPLOAD = op("upload-recipients");
const PREVIEW = op("preview-broadcast");
const EXPORT = op("export-broadcast");
const LAUNCH = op("launch-broadcast");
const PAUSE = op("pause-broadcast");
const RESUME = op("resume-broadcast");
const CANCEL = op("cancel-broadcast");

const COUNTRIES = UPLOAD.body.props.find((p) => p.name === "defaultCountry")?.enum?.map(String) ?? [];

interface FieldOpts {
  name?: string;
  from?: string;
  template?: string;
  templateFile?: string;
  scheduleAt?: string;
  clearSchedule?: boolean;
  rate?: number;
  tag?: string;
  dltEntityId?: string;
  dltHeaderId?: string;
  dltTemplateId?: string;
}

function fieldOptions(cmd: Command, create: boolean): Command {
  return cmd
    .option("--name <name>", create ? "label for the broadcast (required)" : "new label")
    .option("--from <sender>", create ? "sender: an SMS number on your account (E.164), short code or alphanumeric ID (required)" : "new sender")
    .option("--template <text>", "message body with {{variable}} placeholders filled from upload columns")
    .option("--template-file <path>", "read the template from a file")
    .option("--schedule-at <time>", "start sending at this time after launch: RFC 3339 or +30m, +2h, +1d")
    .addOption(new Option("--rate <n>", "messages per second, 1-50 (default 5)").argParser(intArg("--rate", 1, 50)))
    .option("--tag <label>", "tag copied onto every message")
    .option("--dlt-entity-id <id>", "India (TRAI DLT): Principal Entity ID")
    .option("--dlt-header-id <id>", "India (TRAI DLT): sender header ID")
    .option("--dlt-template-id <id>", "India (TRAI DLT): content template ID");
}

function fieldsBody(ctx: Ctx, o: FieldOpts): Rec {
  if (o.template !== undefined && o.templateFile !== undefined) throw usage("Pass --template or --template-file, not both.");
  let template = o.template;
  if (o.templateFile !== undefined) {
    try {
      template = readFileSync(o.templateFile, "utf8").replace(/\r?\n$/, "");
    } catch {
      throw usage(`Cannot read ${o.templateFile}.`);
    }
  }
  const from = o.from && /^\+?[\d\s()-]{7,}$/.test(o.from) && o.from.replace(/\D/g, "").length > 8 ? toE164(o.from) : o.from;
  const body: Rec = compact({
    name: o.name,
    from,
    template,
    scheduledAt: o.scheduleAt ? scheduleAt(o.scheduleAt, ctx.now()) : undefined,
    ratePerSecond: o.rate,
    tag: o.tag,
    dltEntityId: o.dltEntityId,
    dltHeaderId: o.dltHeaderId,
    dltTemplateId: o.dltTemplateId,
  });
  if (o.clearSchedule) {
    if (o.scheduleAt) throw usage("Pass --schedule-at or --clear-schedule, not both.");
    body.scheduledAt = null;
  }
  return body;
}

function summary(body: Rec): Record<string, string> {
  const d: Record<string, string> = {};
  if (body.name) d.name = String(body.name);
  if (body.from) d.from = String(body.from);
  if (typeof body.template === "string") d.template = textPreview(body.template);
  if (body.scheduledAt !== undefined) d["scheduled at"] = body.scheduledAt === null ? "cleared" : String(body.scheduledAt);
  if (body.ratePerSecond) d.rate = `${body.ratePerSecond}/s`;
  return d;
}

const COLUMNS = ["id", "name", "status", "stats.total", "stats.sent", "stats.delivered", "stats.failed"];

function registerRecipients(b: Command, ctx: Ctx): void {
  const rec = b.command("recipients").description("Upload and list a broadcast's recipients");

  rec
    .command("upload")
    .description("Replace a draft broadcast's recipient list from a CSV/XLSX file or a list of numbers")
    .argument("<id>", "broadcast id")
    .option("--file <path>", "a .csv or .xlsx file (10 MB, 10,000 rows); extra columns fill {{variables}}")
    .option("--number <e164>", "a recipient number instead of a file (repeatable or comma-separated)", collect)
    .addOption(new Option("--default-country <code>", "country for numbers without a country code (default US)").choices(COUNTRIES))
    .addHelpText("after", "\nExamples:\n  vobiz sms broadcasts recipients upload bc_123 --file customers.csv --default-country GB\n  vobiz sms broadcasts recipients upload bc_123 --number +14155550123,+14155550124")
    .action(async (id: string, o: { file?: string; number?: string[]; defaultCountry?: string }) => {
      if (!!o.file === !!o.number?.length) throw usage("Pass either --file or --number.");
      if (o.file) {
        const { form, name, size } = fileForm("file", o.file, { defaultCountry: o.defaultCountry });
        await requireConfirmation(ctx, { action: `Replace the recipients of broadcast ${id}`, details: { file: `${name} (${humanSize(size)})`, ...(o.defaultCountry ? { "default country": o.defaultCountry } : {}) } });
        printResult(ctx, `Uploaded ${name}.`, await ctx.client.call(UPLOAD, { path: { id }, body: form, sideEffect: true }));
        return;
      }
      const numbers = [...new Set(o.number!)];
      await requireConfirmation(ctx, { action: `Replace the recipients of broadcast ${id}`, details: { recipients: String(numbers.length) } });
      printResult(ctx, `Uploaded ${numbers.length} recipients.`, await ctx.client.call(UPLOAD, { path: { id }, body: compact({ numbers, defaultCountry: o.defaultCountry }), sideEffect: true }));
    });

  pagingOptions(
    rec
      .command("list")
      .alias("ls")
      .description("List recipients with their send state")
      .argument("<id>", "broadcast id")
      .addOption(new Option("--status <status>", "only recipients in this state").choices(["pending", "sending", "sent", "delivered", "failed", "opted_out", "skipped"])),
    50,
  ).action(async (id: string, o: ListFlags & { status?: string }) => {
    await listCommand(ctx, RECIPIENTS, { path: { id }, query: { status: o.status } }, o, 50, 100, "recipients", {
      columns: ["row", "to", "status", "messageId", "errorCode", "sentAt"],
      idKey: "to",
      empty: "No recipients.",
    });
  });
}

export function registerBroadcasts(sms: Command, ctx: Ctx): void {
  const b = sms.command("broadcasts").description("Bulk SMS: create, upload recipients, preview, launch and follow progress");

  pagingOptions(b.command("list").alias("ls").description("List broadcasts with their stats, newest first"), 50).action(async (o: ListFlags) => {
    await listCommand(ctx, LIST, {}, o, 50, 100, "broadcasts", { columns: COLUMNS, idKey: "id", empty: "No broadcasts." });
  });

  b.command("get")
    .description("Show one broadcast with fresh stats")
    .argument("<id>", "broadcast id")
    .action(async (id: string) => {
      ctx.out.print(await ctx.client.call(GET, { path: { id } }));
    });

  fieldOptions(b.command("create").description("Create a draft broadcast (nothing is sent until launch)"), true)
    .addHelpText(
      "after",
      '\nNext: `recipients upload`, `preview`, then `launch`.\n\nExample:\n  vobiz sms broadcasts create --name "October notice" --from +14155550100 --template "Hi {{name}}, your plan renews on {{date}}."',
    )
    .action(async (o: FieldOpts) => {
      const body = fieldsBody(ctx, o);
      if (!body.name || !body.from) throw usage("--name and --from are required.");
      await requireConfirmation(ctx, { action: "Create a draft broadcast", details: summary(body) });
      printResult(ctx, "Created the broadcast (draft).", await ctx.client.call(CREATE, { body, sideEffect: true }));
    });

  fieldOptions(b.command("update").description("Change a draft broadcast").argument("<id>", "broadcast id"), false)
    .option("--clear-schedule", "remove a scheduled start")
    .action(async (id: string, o: FieldOpts) => {
      const body = fieldsBody(ctx, o);
      if (!Object.keys(body).length) throw usage("Nothing to change. Pass at least one option.");
      await requireConfirmation(ctx, { action: `Update broadcast ${id}`, details: summary(body) });
      printResult(ctx, `Updated broadcast ${id}.`, await ctx.client.call(UPDATE, { path: { id }, body, sideEffect: true }));
    });

  b.command("delete")
    .alias("rm")
    .description("Delete a broadcast")
    .argument("<id>", "broadcast id")
    .action(async (id: string) => {
      await requireConfirmation(ctx, { action: `Delete broadcast ${id}` });
      printResult(ctx, `Deleted broadcast ${id}.`, await ctx.client.call(DELETE, { path: { id }, sideEffect: true }));
    });

  registerRecipients(b, ctx);

  b.command("preview")
    .description("Render the template for the first pending recipients (sends nothing)")
    .argument("<id>", "broadcast id")
    .addOption(new Option("--limit <n>", "samples to render, 1-50 (default 5)").argParser(intArg("--limit", 1, 50)))
    .action(async (id: string, o: { limit?: number }) => {
      const body = await ctx.client.call<Rec>(PREVIEW, { path: { id }, query: { limit: o.limit } });
      const samples = isRec(body) && Array.isArray(body.samples) ? body.samples : [];
      printList(ctx, body, samples, "samples", { columns: ["to", "segments", "encoding", "text"], idKey: "to", empty: "No pending recipients to preview." });
      if (isRec(body) && ctx.out.mode !== "json" && ctx.out.mode !== "yaml") {
        if (typeof body.estimatedSegments === "number") ctx.out.status(`Estimated segments for every pending recipient: ${body.estimatedSegments}`);
        if (Array.isArray(body.missingVariables) && body.missingVariables.length)
          ctx.out.warn(`Placeholders without an upload column (they render empty): ${body.missingVariables.join(", ")}`);
      }
    });

  b.command("export")
    .description("Download per-recipient results as CSV")
    .argument("<id>", "broadcast id")
    .option("--out <file>", "write to this file instead of stdout")
    .option("--force", "overwrite --out if it exists")
    .action(async (id: string, o: { out?: string; force?: boolean }) => {
      if (o.out && existsSync(o.out) && !o.force) throw usage(`${o.out} exists. Pass --force to overwrite it.`);
      const csv = await ctx.client.call<string>(EXPORT, { path: { id }, responseType: "text" });
      if (o.out) {
        writeFileSync(o.out, csv);
        ctx.out.status(`Wrote ${o.out}.`);
      } else ctx.stdout.write(csv.endsWith("\n") || !csv ? csv : csv + "\n");
    });

  b.command("launch")
    .description("Start sending real, billed SMS to every pending recipient")
    .argument("<id>", "broadcast id")
    .addHelpText("after", "\nRun `vobiz sms broadcasts preview <id>` first. Example:\n  vobiz sms broadcasts launch bc_123")
    .action(async (id: string) => {
      const bc = await ctx.client.call<Rec>(GET, { path: { id }, dryRun: false });
      let preview: Rec | undefined;
      try {
        preview = await ctx.client.call<Rec>(PREVIEW, { path: { id }, query: { limit: 1 }, dryRun: false });
      } catch {
        preview = undefined;
      }
      const stats = isRec(bc?.stats) ? bc.stats : {};
      const details: Record<string, string> = {
        name: String(bc?.name ?? id),
        from: String(bc?.from ?? "?"),
        recipients: `${stats.pending ?? "?"} pending of ${stats.total ?? "?"}`,
      };
      if (typeof preview?.estimatedSegments === "number") details["estimated segments"] = String(preview.estimatedSegments);
      if (Array.isArray(preview?.missingVariables) && preview.missingVariables.length) details["missing variables"] = preview.missingVariables.join(", ");
      if (bc?.scheduledAt) details["scheduled at"] = String(bc.scheduledAt);
      await requireConfirmation(ctx, { action: `Launch broadcast ${id}: send real SMS to ${stats.pending ?? "every pending"} recipients`, details, cost: "billed per segment for every recipient" });
      printResult(ctx, `Launched broadcast ${id}. Follow it with \`vobiz sms broadcasts get ${id}\`.`, await ctx.client.call(LAUNCH, { path: { id }, sideEffect: true }));
    });

  for (const [name, operation, verb, done, desc] of [
    ["pause", PAUSE, "Pause", "Paused", "Pause a running broadcast"],
    ["resume", RESUME, "Resume", "Resumed", "Resume a paused broadcast (sending restarts)"],
    ["cancel", CANCEL, "Cancel", "Cancelled", "Cancel a broadcast; pending recipients are skipped"],
  ] as const) {
    b.command(name)
      .description(desc)
      .argument("<id>", "broadcast id")
      .action(async (id: string) => {
        await requireConfirmation(ctx, { action: `${verb} broadcast ${id}` });
        printResult(ctx, `${done} broadcast ${id}.`, await ctx.client.call(operation, { path: { id }, sideEffect: true }));
      });
  }
}
