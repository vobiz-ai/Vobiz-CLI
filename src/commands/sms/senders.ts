/**
 * `vobiz sms senders …`: RCS senders (agents) and their message templates. Wide profile fields have flags; list
 * fields (phones, emails, websites) and anything else go in `--body` as JSON.
 */
import type { Command } from "commander";
import { requireConfirmation } from "../../core/confirm.js";
import type { Ctx } from "../../core/context.js";
import { usage } from "../../core/errors.js";
import { op } from "../../core/ops.js";
import {
  addFields,
  bodyWithFlags,
  fieldValues,
  jsonArg,
  listCommand,
  pagingOptions,
  printResult,
  requireKeys,
  type Field,
  type ListFlags,
  type Rec,
} from "./shared.js";

const LIST = op("list-senders");
const CREATE = op("create-sender");
const GET = op("get-sender");
const UPDATE = op("update-sender");
const STATUS = op("get-sender-status");
const T_LIST = op("list-templates");
const T_CREATE = op("create-template");
const T_GET = op("get-template");
const T_DELETE = op("delete-template");
const T_STATUS = op("get-template-status");

const PROFILE: Field[] = [
  { flag: "--display-name <name>", key: "displayName", desc: "brand name recipients see" },
  { flag: "--description <text>", key: "description", desc: "short description shown on the sender's info page" },
  { flag: "--billing-category <cat>", key: "billingCategory", desc: "e.g. CONVERSATIONAL or NON_CONVERSATIONAL" },
  { flag: "--use-case <case>", key: "useCase", desc: "e.g. OTP, TRANSACTIONAL, PROMOTIONAL, MULTI_USE" },
  { flag: "--brand <name>", key: "brand", desc: "the brand the sender represents" },
  { flag: "--color <hex>", key: "color", desc: "accent colour, e.g. #1A73E8" },
  { flag: "--phones <json>", key: "phones", desc: "contact phones as a JSON array, @file or @-", kind: "json" },
  { flag: "--emails <json>", key: "emails", desc: "contact emails as a JSON array, @file or @-", kind: "json" },
  { flag: "--websites <json>", key: "websites", desc: "websites as a JSON array, @file or @-", kind: "json" },
  { flag: "--banner-url <url>", key: "bannerUrl", desc: "https URL of the banner image" },
  { flag: "--logo-url <url>", key: "logoUrl", desc: "https URL of the logo" },
  { flag: "--privacy <url>", key: "privacy", desc: "link to your privacy policy" },
  { flag: "--terms-of-service <url>", key: "termsOfService", desc: "link to your terms of service" },
  { flag: "--platform <ids>", key: "platform", desc: "identifiers the RCS platform already assigned to your agent" },
];
const CREATE_ONLY: Field[] = [
  { flag: "--provider <id>", key: "provider", desc: "routing identifier your account was provisioned with for RCS (required)" },
  { flag: "--sender-name <name>", key: "senderName", desc: "unique technical name, used as --from when sending RCS (required, permanent)" },
  { flag: "--hosting-region <region>", key: "hostingRegion", desc: "e.g. NORTH_AMERICA, EUROPE, ASIA_PACIFIC (permanent)" },
];

const SENDER_COLUMNS = ["id", "senderName", "displayName", "status", "useCase", "hostingRegion"];

function registerTemplates(senders: Command, ctx: Ctx): void {
  const t = senders.command("templates").description("RCS message templates of a sender");
  const columns = ["templateName", "type", "status", "createdAt"];

  pagingOptions(t.command("list").alias("ls").description("List a sender's templates").argument("<sender-id>", "sender id"), 20).action(async (senderId: string, o: ListFlags) => {
    await listCommand(ctx, T_LIST, { path: { senderId } }, o, 20, 100, undefined, { columns, idKey: "templateName", empty: "No templates." });
  });

  t.command("get")
    .description("Show one template")
    .argument("<sender-id>", "sender id")
    .argument("<name>", "template name")
    .action(async (senderId: string, templateName: string) => {
      ctx.out.print(await ctx.client.call(T_GET, { path: { senderId, templateName } }));
    });

  t.command("create")
    .description("Register a template with the RCS platform (starts as pending)")
    .argument("<sender-id>", "sender id")
    .requiredOption("--name <name>", "unique template name on this sender")
    .requiredOption("--type <type>", "template type as the RCS platform defines it")
    .requiredOption("--content <json>", "template content as JSON, @file.json or @-")
    .addHelpText("after", "\nExample:\n  vobiz sms senders templates create snd_123 --name order_shipped --type RICH_CARD --content @card.json")
    .action(async (senderId: string, o: { name: string; type: string; content: string }) => {
      const content = await jsonArg(ctx, "--content", o.content);
      if (!content || typeof content !== "object" || Array.isArray(content)) throw usage("--content must be a JSON object.");
      await requireConfirmation(ctx, { action: `Register RCS template ${o.name} on sender ${senderId}`, details: { type: o.type } });
      printResult(ctx, `Submitted template ${o.name}.`, await ctx.client.call(T_CREATE, { path: { senderId }, body: { templateName: o.name, type: o.type, content }, sideEffect: true }));
    });

  t.command("delete")
    .alias("rm")
    .description("Delete a template")
    .argument("<sender-id>", "sender id")
    .argument("<name>", "template name")
    .action(async (senderId: string, templateName: string) => {
      await requireConfirmation(ctx, { action: `Delete RCS template ${templateName} on sender ${senderId}` });
      printResult(ctx, `Deleted template ${templateName}.`, await ctx.client.call(T_DELETE, { path: { senderId, templateName }, sideEffect: true }));
    });

  t.command("status")
    .description("Refresh a template's approval status from the RCS platform")
    .argument("<sender-id>", "sender id")
    .argument("<name>", "template name")
    .action(async (senderId: string, templateName: string) => {
      ctx.out.print(await ctx.client.call(T_STATUS, { path: { senderId, templateName } }));
    });
}

export function registerSenders(sms: Command, ctx: Ctx): void {
  const senders = sms.command("senders").description("RCS senders (agents) and their templates");

  pagingOptions(senders.command("list").alias("ls").description("List RCS senders"), 20).action(async (o: ListFlags) => {
    await listCommand(ctx, LIST, {}, o, 20, 100, undefined, { columns: SENDER_COLUMNS, idKey: "id", empty: "No RCS senders." });
  });

  senders
    .command("get")
    .description("Show one RCS sender")
    .argument("<id>", "sender id")
    .action(async (id: string) => {
      ctx.out.print(await ctx.client.call(GET, { path: { id } }));
    });

  addFields(senders.command("create").description("Register a new RCS sender with the RCS platform (starts as pending)"), [...CREATE_ONLY, ...PROFILE])
    .option("--body <json>", "full or partial request body as JSON, @file.json or @-; flags override it")
    .addHelpText(
      "after",
      '\nExample:\n  vobiz sms senders create --provider YOUR_PROVIDER --sender-name acme_alerts --display-name "Acme" \\\n    --use-case TRANSACTIONAL --phones \'[{"phoneNumber":"+14155550100","label":"Support"}]\'',
    )
    .action(async (o: Rec & { body?: string }) => {
      const body = await bodyWithFlags(ctx, o.body, await fieldValues(ctx, o, [...CREATE_ONLY, ...PROFILE]));
      requireKeys(body, [["provider", "--provider"], ["senderName", "--sender-name"]]);
      await requireConfirmation(ctx, { action: `Register RCS sender ${body.senderName}`, details: { provider: String(body.provider), ...(body.displayName ? { "display name": String(body.displayName) } : {}) } });
      printResult(ctx, `Submitted RCS sender ${body.senderName}.`, await ctx.client.call(CREATE, { body, sideEffect: true }));
    });

  addFields(senders.command("update").description("Change an RCS sender's profile").argument("<id>", "sender id"), PROFILE)
    .option("--body <json>", "request body as JSON, @file.json or @-; flags override it")
    .action(async (id: string, o: Rec & { body?: string }) => {
      const body = await bodyWithFlags(ctx, o.body, await fieldValues(ctx, o, PROFILE));
      if (!Object.keys(body).length) throw usage("Nothing to change. Pass at least one option or --body.");
      await requireConfirmation(ctx, { action: `Update RCS sender ${id}`, details: { fields: Object.keys(body).join(", ") } });
      printResult(ctx, `Updated RCS sender ${id}.`, await ctx.client.call(UPDATE, { path: { id }, body, sideEffect: true }));
    });

  senders
    .command("status")
    .description("Refresh a sender's launch status from the RCS platform")
    .argument("<id>", "sender id")
    .action(async (id: string) => {
      ctx.out.print(await ctx.client.call(STATUS, { path: { id } }));
    });

  registerTemplates(senders, ctx);
}
