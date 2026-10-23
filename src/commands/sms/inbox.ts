/**
 * Two-way messaging: `vobiz sms conversations …`, `sms opt-outs …` and `sms webhooks …`.
 */
import { Option, type Command } from "commander";
import { requireConfirmation } from "../../core/confirm.js";
import type { Ctx } from "../../core/context.js";
import { usage } from "../../core/errors.js";
import { op } from "../../core/ops.js";
import { toE164 } from "../../core/phone.js";
import { MESSAGE_COLUMNS } from "./messages.js";
import { collect, compact, httpsUrl, listCommand, pagingOptions, printResult, simpleList, urlHost, type ListFlags, type Rec } from "./shared.js";
import { readSecretArg } from "../../core/secrets.js";

const CONV_LIST = op("list-conversations");
const CONV_GET = op("get-conversation");
const CONV_MESSAGES = op("list-conversation-messages");
const CONV_READ = op("mark-conversation-read");
const UNREAD = op("unread-count");

const OPT_LIST = op("list-opt-outs");
const OPT_CREATE = op("create-opt-out");
const OPT_CHECK = op("check-opt-out");
const OPT_DELETE = op("delete-opt-out");

const WH_LIST = op("list-webhooks");
const WH_CREATE = op("create-webhook");
const WH_GET = op("get-webhook");
const WH_UPDATE = op("update-webhook");
const WH_DELETE = op("delete-webhook");

const CHANNELS = ["sms", "mms", "rcs"];

function registerConversations(sms: Command, ctx: Ctx): void {
  const conv = sms.command("conversations").description("Two-way threads between your numbers and your contacts");

  pagingOptions(conv.command("list").alias("ls").description("List conversations, most recently active first"), 20).action(async (o: ListFlags) => {
    await listCommand(ctx, CONV_LIST, {}, o, 20, 100, undefined, {
      columns: ["id", "participantA", "participantB", "channel", "messageCount", "unreadCount", "lastMessageAt"],
      idKey: "id",
      empty: "No conversations yet.",
    });
  });

  conv
    .command("get")
    .description("Show one conversation")
    .argument("<id>", "conversation id")
    .action(async (id: string) => {
      ctx.out.print(await ctx.client.call(CONV_GET, { path: { id } }));
    });

  pagingOptions(conv.command("messages").description("List the messages of one conversation, newest first").argument("<id>", "conversation id"), 50).action(
    async (id: string, o: ListFlags) => {
      await listCommand(ctx, CONV_MESSAGES, { path: { id } }, o, 50, 100, undefined, { columns: [...MESSAGE_COLUMNS.slice(0, 5), "text", "createdAt"], idKey: "id" });
    },
  );

  conv
    .command("read")
    .description("Mark a conversation as read (sets its unread count to 0)")
    .argument("<id>", "conversation id")
    .action(async (id: string) => {
      await requireConfirmation(ctx, { action: `Mark conversation ${id} as read` });
      printResult(ctx, `Marked conversation ${id} as read.`, await ctx.client.call(CONV_READ, { path: { id }, sideEffect: true }));
    });

  conv
    .command("unread-count")
    .description("Show the total number of unread messages")
    .action(async () => {
      ctx.out.print(await ctx.client.call(UNREAD));
    });
}

function registerOptOuts(sms: Command, ctx: Ctx): void {
  const opt = sms.command("opt-outs").description("Numbers that must not receive messages from you (STOP replies and manual blocks)");
  const channelOption = () => new Option("--channel <channel>", "sms (default; also blocks mms), mms or rcs").choices(CHANNELS);

  pagingOptions(opt.command("list").alias("ls").description("List opt-outs, newest first"), 20).action(async (o: ListFlags) => {
    await listCommand(ctx, OPT_LIST, {}, o, 20, 100, undefined, { columns: ["phoneNumber", "channel", "reason", "source", "createdAt"], idKey: "phoneNumber", empty: "No opt-outs." });
  });

  opt
    .command("add")
    .description("Block a number so Vobiz refuses messages to it on a channel")
    .argument("<e164>", "the number to block")
    .addOption(channelOption())
    .option("--reason <text>", "note stored on the record (default: manual)")
    .addHelpText("after", '\nExample:\n  vobiz sms opt-outs add +14155550123 --reason "asked on a call"')
    .action(async (num: string, o: { channel?: string; reason?: string }) => {
      const phoneNumber = toE164(num);
      const channel = o.channel ?? "sms";
      await requireConfirmation(ctx, { action: `Block ${phoneNumber} from ${channel} messages`, details: { recipients: "1", ...(o.reason ? { reason: o.reason } : {}) } });
      const res = await ctx.client.call(OPT_CREATE, { body: compact({ phoneNumber, channel, reason: o.reason }), sideEffect: true });
      printResult(ctx, `${phoneNumber} is opted out of ${channel}.`, res);
    });

  opt
    .command("check")
    .description("Check whether a number is opted out on a channel")
    .argument("<e164>", "the number to check")
    .addOption(channelOption())
    .action(async (num: string, o: { channel?: string }) => {
      const phoneNumber = toE164(num);
      const channel = o.channel ?? "sms";
      const res = await ctx.client.call<Rec>(OPT_CHECK, { path: { phoneNumber }, query: { channel } });
      ctx.out.print({ phoneNumber, channel, optedOut: res?.optedOut === true });
    });

  opt
    .command("remove")
    .description("Unblock a number; only after the person opted back in (e.g. replied START)")
    .argument("<e164>", "the number to unblock")
    .addOption(channelOption())
    .action(async (num: string, o: { channel?: string }) => {
      const phoneNumber = toE164(num);
      const channel = o.channel ?? "sms";
      await requireConfirmation(ctx, { action: `Delete the ${channel} opt-out of ${phoneNumber}`, details: { consent: "only if the person opted back in" } });
      const res = await ctx.client.call(OPT_DELETE, { path: { phoneNumber }, query: { channel }, sideEffect: true });
      printResult(ctx, `${phoneNumber} can receive ${channel} messages again.`, res);
    });
}

interface WebhookOpts {
  url?: string;
  secret?: string;
  event?: string[];
  active?: boolean;
}

function registerWebhooks(sms: Command, ctx: Ctx): void {
  const wh = sms.command("webhooks").description("Messaging webhooks: signed POSTs for received, delivered and failed messages");
  const columns = ["id", "url", "events", "active", "createdAt"];

  wh.command("list")
    .alias("ls")
    .description("List messaging webhooks")
    .action(async () => {
      await simpleList(ctx, WH_LIST, {}, undefined, { columns, idKey: "id", empty: "No messaging webhooks." });
    });

  wh.command("get")
    .description("Show one webhook (the secret is redacted)")
    .argument("<id>", "webhook id")
    .action(async (id: string) => {
      ctx.out.print(await ctx.client.call(WH_GET, { path: { id } }));
    });

  wh.command("create")
    .description("Subscribe an https URL to messaging events")
    .requiredOption("--url <url>", "https URL that receives the POSTs", httpsUrl("--url"))
    .option("--secret <secret>", "shared secret for the X-Webhook-Signature HMAC (@file or @- for stdin keeps it out of shell history)")
    .option("--event <name>", "event to deliver (repeatable; default: message.received, message.delivered, message.failed)", collect)
    .addHelpText("after", '\nExample:\n  vobiz sms webhooks create --url https://example.com/vobiz/sms --secret @webhook.secret')
    .action(async (o: WebhookOpts) => {
      if (o.secret !== undefined) o.secret = await readSecretArg(ctx, o.secret, "--secret");
      if (!o.secret) ctx.out.warn("No --secret: deliveries will be signed with an empty secret, so you cannot verify them.");
      await requireConfirmation(ctx, { action: "Create a messaging webhook", details: { "URL host": urlHost(o.url!), events: o.event?.join(", ") ?? "default" } });
      const res = await ctx.client.call(WH_CREATE, { body: compact({ url: o.url, secret: o.secret, events: o.event }), sideEffect: true });
      printResult(ctx, "Created the webhook.", res);
    });

  wh.command("update")
    .description("Change a webhook's URL, secret, events or active state")
    .argument("<id>", "webhook id")
    .option("--url <url>", "new https URL", httpsUrl("--url"))
    .option("--secret <secret>", "new signing secret (@file or @- for stdin keeps it out of shell history)")
    .option("--event <name>", "replace the event list (repeatable)", collect)
    .option("--active", "resume deliveries")
    .option("--no-active", "pause deliveries and keep the subscription")
    .action(async (id: string, o: WebhookOpts) => {
      if (o.secret !== undefined) o.secret = await readSecretArg(ctx, o.secret, "--secret");
      const body = compact({ url: o.url, secret: o.secret, events: o.event, active: o.active });
      if (!Object.keys(body).length) throw usage("Nothing to change. Pass --url, --secret, --event, --active or --no-active.");
      const details: Record<string, string> = {};
      if (o.url) details["URL host"] = urlHost(o.url);
      if (o.event) details.events = o.event.join(", ");
      if (o.secret) details.secret = "changed";
      if (o.active !== undefined) details.active = String(o.active);
      await requireConfirmation(ctx, { action: `Update messaging webhook ${id}`, details });
      printResult(ctx, `Updated webhook ${id}.`, await ctx.client.call(WH_UPDATE, { path: { id }, body, sideEffect: true }));
    });

  wh.command("delete")
    .alias("rm")
    .description("Delete a webhook")
    .argument("<id>", "webhook id")
    .action(async (id: string) => {
      await requireConfirmation(ctx, { action: `Delete messaging webhook ${id}` });
      printResult(ctx, `Deleted webhook ${id}.`, await ctx.client.call(WH_DELETE, { path: { id }, sideEffect: true }));
    });
}

export function registerInbox(sms: Command, ctx: Ctx): void {
  registerConversations(sms, ctx);
  registerOptOuts(sms, ctx);
  registerWebhooks(sms, ctx);
}
