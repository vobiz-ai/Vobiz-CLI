/**
 * `vobiz sms send`, `sms messages list|get`, `sms cost` and `sms rcs-reachability`.
 *
 * `send` posts one request per recipient so every message id and status comes back (the API answers a
 * multi-recipient request with the first recipient's message only). Each request carries an idempotency key:
 * the one you pass, or a generated one that is printed so a retry can reuse it (`<key>:<n>` per recipient when
 * there are several). A send is never retried automatically.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Option, type Command } from "commander";
import { requireConfirmation } from "../../core/confirm.js";
import type { Ctx } from "../../core/context.js";
import { EXIT, VobizError, usage } from "../../core/errors.js";
import { op } from "../../core/ops.js";
import { toE164 } from "../../core/phone.js";
import { parseRange } from "../../core/time.js";
import {
  collect,
  httpsUrl,
  isRec,
  jsonArg,
  listCommand,
  listPreview,
  pagingOptions,
  scheduleAt,
  textPreview,
  type ListFlags,
  type Rec,
} from "./shared.js";

const SEND = op("send-message");
const LIST = op("list-messages");
const GET = op("get-message");
const COST = op("preview-message-cost");
const RCS_REACH = op("check-rcs-reachability");

export const MESSAGE_COLUMNS = ["id", "direction", "from", "to", "status", "createdAt"];
const CHANNELS = ["sms", "mms", "rcs"];
/** Statuses after which a message does not change any more. */
export const TERMINAL_STATUSES = new Set(["delivered", "failed", "received"]);
/** Poll interval for --wait (tests lower it). */
export const pollSettings = { intervalMs: 2000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readText(ctx: Ctx, opts: { text?: string; textFile?: string }): Promise<string | undefined> | string | undefined {
  if (opts.text !== undefined && opts.textFile !== undefined) throw usage("Pass --text or --text-file, not both.");
  if (opts.textFile === undefined) return opts.text;
  if (opts.textFile === "-") return ctx.stdin.read().then((t) => t.replace(/\r?\n$/, ""));
  try {
    return readFileSync(opts.textFile, "utf8").replace(/\r?\n$/, "");
  } catch {
    throw usage(`Cannot read ${opts.textFile}.`);
  }
}

const money = (n: number) => String(Number(n.toFixed(4)));

/** Cost estimate for a send from cost-preview (a read, so it also runs under --dry-run). Undefined when unknown. */
async function estimateCost(ctx: Ctx, from: string, to: string[], text: string | undefined, channel: string): Promise<string | undefined> {
  if (channel === "rcs") return undefined;
  const sample = to.slice(0, 10);
  let total = 0;
  let currency: string | undefined;
  const segments = new Set<number>();
  try {
    for (const r of sample) {
      const p = await ctx.client.call<Rec>(COST, { query: { from, to: r, text, channel }, dryRun: false });
      if (typeof p?.totalCost !== "number") return undefined;
      total += p.totalCost;
      currency ??= typeof p.currency === "string" ? p.currency : undefined;
      if (typeof p.segmentCount === "number") segments.add(p.segmentCount);
    }
  } catch (err) {
    ctx.out.warn(`Could not preview the cost (${err instanceof Error ? err.message : String(err)}).`);
    return undefined;
  }
  const estimated = to.length > sample.length;
  const sum = estimated ? (total / sample.length) * to.length : total;
  const seg = segments.size === 1 ? `${[...segments][0]} segment${[...segments][0] === 1 ? "" : "s"} each` : "segments vary";
  return `${estimated ? "about " : ""}${currency ?? ""} ${money(sum)} for ${to.length} recipient${to.length === 1 ? "" : "s"} (${seg})${estimated ? `, estimated from the first ${sample.length}` : ""}`.trim();
}

interface SendOpts {
  from: string;
  to: string[];
  text?: string;
  textFile?: string;
  mediaUrl?: string[];
  type?: string;
  title?: string;
  tag?: string;
  scheduleAt?: string;
  idempotencyKey?: string;
  failoverToSms?: boolean;
  rcsSuggestions?: string;
  dltEntityId?: string;
  dltHeaderId?: string;
  dltTemplateId?: string;
}

async function waitForFinal(ctx: Ctx, messages: Rec[]): Promise<boolean> {
  const deadline = Date.now() + ctx.flags.timeout * 1000;
  const pending = () => messages.filter((m) => typeof m.id === "string" && m.id && !TERMINAL_STATUSES.has(String(m.status)) && m.status !== "scheduled" && m.status !== "not_sent");
  if (messages.some((m) => m.status === "scheduled")) ctx.out.warn("Scheduled messages are not waited for; follow them with `vobiz sms messages get <id>`.");
  let lastLine = "";
  while (pending().length) {
    if (Date.now() >= deadline) return false;
    // One status line per change, not per poll: agents and humans both read stderr.
    const line = `Waiting for ${pending().length} message${pending().length === 1 ? "" : "s"} to reach a final status (${[...new Set(pending().map((m) => String(m.status)))].join(", ")})…`;
    if (line !== lastLine) ctx.out.status(line);
    lastLine = line;
    await sleep(Math.min(pollSettings.intervalMs, Math.max(0, deadline - Date.now())));
    for (const m of pending()) {
      const fresh = await ctx.client.call<Rec>(GET, { path: { id: String(m.id) } });
      if (isRec(fresh)) Object.assign(m, fresh);
    }
  }
  return true;
}

function registerSend(sms: Command, ctx: Ctx): void {
  sms
    .command("send")
    .description("Send a real, billed SMS, MMS or RCS message to one or more recipients")
    .requiredOption("--from <sender>", "your Vobiz messaging number in E.164, or your RCS sender name for --type rcs")
    .requiredOption("--to <e164>", "recipient in E.164 (repeatable or comma-separated)", collect)
    .option("--text <text>", "message body (required for sms and rcs)")
    .option("--text-file <path>", "read the message body from a file, or - for stdin")
    .option("--media-url <url>", "https URL of media to attach (repeatable; MMS up to 10, RCS sends the first)", collect)
    .addOption(new Option("--type <channel>", "channel: sms (default), mms or rcs").choices(CHANNELS))
    .option("--title <subject>", "MMS subject line")
    .option("--tag <label>", "your label, stored on every message; filter `sms messages list --tag` by it")
    .option("--schedule-at <time>", "hold until this time: RFC 3339 (2026-11-01T09:00:00Z) or +30m, +2h, +1d")
    .option("--idempotency-key <key>", "reuse a key from an earlier attempt so a retry never sends twice (default: generated and printed)")
    .option("--failover-to-sms", "RCS only: send the text as SMS when RCS cannot be delivered")
    .option("--rcs-suggestions <json>", "RCS only: suggestion buttons as a JSON array, @file.json or @-")
    .option("--dlt-entity-id <id>", "India (TRAI DLT): Principal Entity ID")
    .option("--dlt-header-id <id>", "India (TRAI DLT): sender header ID")
    .option("--dlt-template-id <id>", "India (TRAI DLT): content template ID; the text must match it")
    .addHelpText(
      "after",
      `
Every recipient gets its own message and is billed per segment. The cost is previewed and you are asked to
confirm (pass --yes in scripts). Add --wait to poll until each message is delivered or failed (bounded by --timeout).

Examples:
  vobiz sms send --from +14155550100 --to +14155550123 --text "Your code is 123456"
  vobiz sms send --from +14155550100 --to +14155550123,+14155550124 --text-file notice.txt --tag october-notice
  vobiz sms send --from +14155550100 --to +14155550123 --type mms --media-url https://example.com/receipt.png
  vobiz sms send --from MyBrandAgent --to +14155550123 --type rcs --text "Your order shipped" --failover-to-sms
  vobiz sms send --from +919876543210 --to +919812345678 --text "..." --dlt-entity-id 1101... --dlt-template-id 1107...`,
    )
    .action(async (opts: SendOpts) => {
      const text = await readText(ctx, opts);
      const channel = opts.type ?? "sms";
      const media = opts.mediaUrl ?? [];
      media.forEach(httpsUrl("--media-url"));
      if (media.length > 10) throw usage("--media-url accepts at most 10 URLs.");
      if ((channel === "sms" || channel === "rcs") && !text)
        throw usage(`--text is required for ${channel} messages${channel === "sms" && media.length ? " (use --type mms to send media without text)" : ""}.`);
      if (channel === "mms" && !text && !media.length) throw usage("An MMS needs --text, --media-url or both.");
      if (channel !== "rcs" && (opts.failoverToSms || opts.rcsSuggestions)) throw usage("--failover-to-sms and --rcs-suggestions apply only to --type rcs.");
      const to = [...new Set(opts.to.map(toE164))];
      if (!to.length) throw usage("Pass at least one --to recipient.");
      const from = channel === "rcs" ? opts.from.trim() : toE164(opts.from);
      let suggestions: unknown;
      if (opts.rcsSuggestions !== undefined) {
        suggestions = await jsonArg(ctx, "--rcs-suggestions", opts.rcsSuggestions);
        if (!Array.isArray(suggestions)) throw usage("--rcs-suggestions must be a JSON array.");
      }
      const scheduled = opts.scheduleAt ? scheduleAt(opts.scheduleAt, ctx.now()) : undefined;
      const key = opts.idempotencyKey?.trim() || `cli-${randomUUID()}`;
      if (key.length > 200) throw usage("--idempotency-key is too long (200 characters maximum).");

      const base: Rec = { from, channel, text, mediaUrls: media.length ? media : undefined, title: opts.title, tag: opts.tag, scheduledAt: scheduled };
      if (opts.failoverToSms) base.failoverToSms = true;
      if (suggestions) base.rcsSuggestions = suggestions;
      if (opts.dltEntityId) base.dltEntityId = opts.dltEntityId;
      if (opts.dltHeaderId) base.dltHeaderId = opts.dltHeaderId;
      if (opts.dltTemplateId) base.dltTemplateId = opts.dltTemplateId;
      for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];

      const cost = await estimateCost(ctx, from, to, text, channel);
      const details: Record<string, string> = { from, to: listPreview(to) };
      if (text) details.text = textPreview(text);
      if (media.length) details.media = listPreview(media.map((u) => new URL(u).host), 3);
      if (scheduled) details["scheduled for"] = scheduled;
      details["idempotency key"] = key;
      await requireConfirmation(ctx, {
        action: `Send a real, billed ${channel.toUpperCase()} to ${to.length} recipient${to.length === 1 ? "" : "s"}`,
        details,
        cost: cost ?? (channel === "rcs" ? "RCS cannot be previewed; billed per message" : undefined),
      });
      if (!ctx.flags.dryRun) ctx.out.status(`Idempotency key: ${key} (pass --idempotency-key ${key} to retry without sending twice)`);

      const messages: Rec[] = [];
      let unknownOutcome = false;
      for (const [i, recipient] of to.entries()) {
        const body = { ...base, to: [recipient], idempotencyKey: to.length === 1 ? key : `${key}:${i + 1}` };
        try {
          const res = await ctx.client.call<Rec>(SEND, { body, sideEffect: true });
          messages.push(isRec(res) ? res : { to: recipient, status: "unknown" });
        } catch (err) {
          if (to.length === 1) throw err;
          if (err instanceof VobizError && err.status === 422) {
            messages.push({ to: recipient, status: "not_sent", errorCode: rejectionCode(err), errorMessage: err.message });
            continue;
          }
          if (!(err instanceof VobizError)) throw err;
          const unknown = err.kind === "outcome_unknown";
          unknownOutcome ||= unknown;
          messages.push({ to: recipient, status: unknown ? "unknown" : "not_sent", errorCode: err.kind, errorMessage: err.message });
          if (unknown || !messages.some((m) => typeof m.id === "string")) {
            // Stop at an unknown outcome (the network may be down) or when nothing has gone out yet.
            for (const rest of to.slice(i + 1)) messages.push({ to: rest, status: "not_sent", errorCode: "skipped", errorMessage: "Not attempted after the previous error." });
            break;
          }
        }
      }

      let finished = true;
      if (ctx.flags.wait) finished = await waitForFinal(ctx, messages);

      const failed = messages.filter((m) => ["failed", "not_sent"].includes(String(m.status)));
      const mode = ctx.out.mode;
      if ((mode === "json" || mode === "yaml") && !ctx.flags.quiet && !ctx.flags.fields?.length) ctx.out.print({ idempotencyKey: key, messages });
      else ctx.out.print(messages, { columns: ["id", "to", "status", "errorCode", "errorMessage"], idKey: "id" });

      const sent = messages.length - failed.length;
      if (!ctx.flags.wait) ctx.out.status(`${sent} of ${messages.length} accepted. "sent" means handed to the network; check delivery with \`vobiz sms messages get <id>\` or --wait.`);
      if (unknownOutcome) ctx.exitCode = EXIT.outcome_unknown;
      else if (!finished) {
        ctx.out.warn(`Not every message reached a final status within ${ctx.flags.timeout}s.`);
        ctx.exitCode = EXIT.timeout;
      } else if (failed.length) ctx.exitCode = 1;
    });
}

interface ListOpts extends ListFlags {
  status?: string;
  channel?: string;
  direction?: string;
  to?: string;
  from?: string;
  tag?: string;
  since?: string;
  until?: string;
}

function registerMessages(sms: Command, ctx: Ctx): void {
  const messages = sms.command("messages").description("List and inspect SMS, MMS and RCS messages, sent and received");

  pagingOptions(
    messages
      .command("list")
      .alias("ls")
      .description("List messages, newest first")
      .addOption(new Option("--status <status>", "only messages with this status").choices(["scheduled", "sent", "delivered", "failed", "received", "unknown"]))
      .addOption(new Option("--channel <channel>", "only this channel").choices(CHANNELS))
      .addOption(new Option("--direction <dir>", "out (sent) or in (received)").choices(["out", "in"]))
      .option("--to <e164>", "only messages to this number")
      .option("--from <sender>", "only messages from this number or RCS sender name")
      .option("--tag <label>", "only messages with this tag")
      .option("--since <time>", "created at or after: today, yesterday, 7d, 2026-10-01 or an ISO timestamp")
      .option("--until <time>", "created before: same formats as --since"),
    20,
  )
    .addHelpText("after", "\nExamples:\n  vobiz sms messages list --direction in --since 7d\n  vobiz sms messages list --tag october-notice --all --output json")
    .action(async (o: ListOpts) => {
      const range = parseRange(o.since, o.until, ctx.now());
      const from = o.from && /^[+\d\s()-]+$/.test(o.from) ? toE164(o.from) : o.from;
      const query = {
        status: o.status,
        channel: o.channel,
        direction: o.direction,
        to: o.to ? toE164(o.to) : undefined,
        from,
        tag: o.tag,
        startDate: range.from?.toISOString(),
        endDate: range.to?.toISOString(),
      };
      await listCommand(ctx, LIST, { query }, o, 20, 100, "messages", { columns: MESSAGE_COLUMNS, idKey: "id", empty: "No messages match." });
    });

  messages
    .command("get")
    .description("Show one message with its status history")
    .argument("<id>", "message id")
    .action(async (id: string) => {
      ctx.out.print(await ctx.client.call(GET, { path: { id } }));
    });
}

function registerCost(sms: Command, ctx: Ctx): void {
  sms
    .command("cost")
    .description("Preview the price and segment count of a message without sending it")
    .requiredOption("--from <e164>", "your Vobiz messaging number")
    .requiredOption("--to <e164>", "recipient; its country decides the price")
    .option("--text <text>", "message body; its length and characters decide the segments")
    .option("--text-file <path>", "read the body from a file, or - for stdin")
    .addOption(new Option("--type <channel>", "sms (default) or mms").choices(["sms", "mms"]))
    .addHelpText("after", '\nExample:\n  vobiz sms cost --from +14155550100 --to +447700900123 --text "Hello from Vobiz"')
    .action(async (o: { from: string; to: string; text?: string; textFile?: string; type?: string }) => {
      const text = await readText(ctx, o);
      ctx.out.print(await ctx.client.call(COST, { query: { from: toE164(o.from), to: toE164(o.to), text, channel: o.type ?? "sms" } }));
    });
}

function registerRcsReachability(sms: Command, ctx: Ctx): void {
  sms
    .command("rcs-reachability")
    .description("Check whether a number can receive RCS from your RCS sender (sends nothing)")
    .argument("<to>", "recipient number in E.164")
    .requiredOption("--from <sender>", "the senderName of your RCS sender")
    .addHelpText("after", "\nExample:\n  vobiz sms rcs-reachability +14155550123 --from MyBrandAgent")
    .action(async (to: string, o: { from: string }) => {
      ctx.out.print(await ctx.client.call(RCS_REACH, { query: { from: o.from, to: toE164(to) } }));
    });
}

/**
 * The per-recipient code for a 422 from send-message. The spec documents 422 as "recipient has opted out", but a
 * backend code or message saying otherwise wins; only an opt-out (or a bare 422) is labelled `opted_out`.
 */
export function rejectionCode(err: VobizError): string {
  const d = isRec(err.details) ? err.details : {};
  const code = [d.code, d.errorCode, d.error_code].find((c): c is string => typeof c === "string" && !!c.trim());
  if (code) return code.trim();
  if (/opt(ed)?[\s_-]?out/i.test(err.message)) return "opted_out";
  return err.message && !/^HTTP 422$/.test(err.message) ? "rejected" : "opted_out";
}

export function registerMessaging(sms: Command, ctx: Ctx): void {
  registerSend(sms, ctx);
  registerMessages(sms, ctx);
  registerCost(sms, ctx);
  registerRcsReachability(sms, ctx);
}
