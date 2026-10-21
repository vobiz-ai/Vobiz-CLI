/**
 * `vobiz setup voice-agent` and `vobiz setup sms`: guided composites over the existing commands. Each one gathers
 * every choice first (interactively on a terminal, or entirely from flags for scripts and agents), shows ONE
 * confirmation summary covering every write, runs the writes in order, and prints a test plan.
 *
 * voice-agent  a number (one you have, or one to buy) routed to a SIP trunk, which is how AI voice platforms
 *              (LiveKit, Pipecat, Vapi, Retell…) take calls. Linking a number to an Application (answer URL or
 *              <Stream> URL) needs an endpoint the API spec does not define yet (docs/SPEC-GAPS.md), so
 *              --answer-url/--stream-url/--app stop with an explanation instead of half-configuring anything.
 * sms          a messaging number (one you have, or one to buy) plus a webhook for inbound messages and delivery
 *              reports (an existing one with the same URL is reused).
 *
 * --dry-run prints every request the setup would send; the reads it needs to build them still run.
 */
import type { Command } from "commander";
import type { CallArgs } from "../core/client.js";
import { requireConfirmation, type ConfirmSummary } from "../core/confirm.js";
import type { Ctx } from "../core/context.js";
import { VobizError, usage } from "../core/errors.js";
import { op, type Operation } from "../core/ops.js";
import { extractItems } from "../core/pagination.js";
import { toE164 } from "../core/phone.js";
import { findInventoryNumber, findOwnNumber, type NumberRecord } from "./numbers.js";
import { findSmsOffer } from "./sms/numbers.js";
import { compact, httpsUrl, urlHost } from "./sms/shared.js";
import { collect, isRec, type Rec } from "./voice-shared.js";

const VOICE_NUMBERS = op("voice:list-numbers");
const INVENTORY = op("list-inventory-numbers");
const PURCHASE = op("purchase-from-inventory");
const ASSIGN_TRUNK = op("assign-number-to-trunk");
const LIST_TRUNKS = op("list-trunks");
const GET_TRUNK = op("retrieve-trunk");
const SMS_NUMBERS = op("sms:list-numbers");
const SMS_SEARCH = op("search-available-numbers");
const SMS_PURCHASE = op("purchase-number");
const WEBHOOKS = op("list-webhooks");
const GET_WEBHOOK = op("get-webhook");
const CREATE_WEBHOOK = op("create-webhook");

interface Step {
  label: string;
  operation: Operation;
  args: CallArgs;
  /** Command that redoes this step by hand if it fails after an earlier step succeeded. */
  retry: string;
}

/** One confirmation for every step, then the steps in order. Returns undefined for --dry-run (plan printed). */
async function runPlan(ctx: Ctx, summary: ConfirmSummary, steps: Step[]): Promise<unknown[] | undefined> {
  await requireConfirmation(ctx, summary);
  if (ctx.flags.dryRun) {
    const client = ctx.client;
    ctx.out.print({
      dry_run: true,
      steps: steps.map((s) => ({ step: s.label, ...client.prepare(s.operation.api, s.operation.method, client.fillPath(s.operation.path, s.args.path), s.args, s.operation.id) })),
    });
    return undefined;
  }
  const results: unknown[] = [];
  for (const [i, s] of steps.entries()) {
    try {
      ctx.out.status(`${i + 1}/${steps.length} ${s.label}…`);
      results.push(await ctx.client.call(s.operation, { ...s.args, sideEffect: true }));
    } catch (err) {
      if (i > 0) {
        ctx.out.warn(`Done: ${steps.slice(0, i).map((x) => x.label).join("; ")}. Failed: ${s.label}. Finish by hand with \`${s.retry}\`${steps.length > i + 1 ? " and the remaining steps" : ""}.`);
      }
      throw err;
    }
  }
  return results;
}

/** Shows numbered choices on stderr and asks for one; accepts the number or the value itself. */
async function choose<T>(ctx: Ctx, title: string, items: T[], label: (t: T) => string, value: (t: T) => string): Promise<T | string> {
  ctx.stderr.write(`${title}\n${items.map((t, i) => `  ${i + 1}. ${label(t)}`).join("\n")}\n`);
  for (;;) {
    const answer = (await ctx.prompts.input(`Choose 1-${items.length} (or type a value):`)).trim();
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
    const hit = items.find((t) => value(t) === answer);
    if (hit) return hit;
    if (answer) return answer;
  }
}

const interactive = (ctx: Ctx) => ctx.isTTY.stdin && !ctx.flags.dryRun;
const money = (currency: unknown, amount: unknown) => `${currency ?? ""} ${amount ?? "?"}`.trim();

/** Prints the outcome: the record plus a numbered test plan (structured in machine modes). */
function printOutcome(ctx: Ctx, result: Rec, plan: string[], notes: string[]): void {
  const mode = ctx.out.mode;
  if (mode === "json" || mode === "jsonl" || mode === "yaml" || mode === "tsv" || ctx.flags.fields?.length || ctx.flags.query || ctx.flags.quiet) {
    ctx.out.print({ ...result, notes, test_plan: plan });
    return;
  }
  ctx.out.print(result);
  const lines = [""];
  if (notes.length) lines.push("Notes:", ...notes.map((n) => `  - ${n}`), "");
  lines.push("Test plan:", ...plan.map((p, i) => `  ${i + 1}. ${p}`));
  ctx.stdout.write(lines.join("\n") + "\n");
}

// ── setup voice-agent ──

interface VoiceOpts {
  number?: string;
  buy?: string;
  country?: string;
  contains?: string;
  currency?: string;
  trunk?: string;
  answerUrl?: string;
  streamUrl?: string;
  app?: string;
}

export const APP_LINK_GAP =
  "Linking a number to an Application (answer URL or <Stream> URL) is not in the Vobiz API spec yet " +
  "(docs/SPEC-GAPS.md: link-number-to-application), so the CLI cannot do it safely. Either route the number to a " +
  "SIP trunk with --trunk (how LiveKit, Pipecat, Vapi and similar platforms take calls), or create the application " +
  "with `vobiz apps create --app-name … --answer-url … --answer-method POST` and link the number to it in the Vobiz Console.";

async function pickVoiceNumber(ctx: Ctx, o: VoiceOpts): Promise<{ e164: string; own?: NumberRecord; offer?: NumberRecord }> {
  if (o.number && o.buy) throw usage("Pass either --number (a number you have) or --buy (a number to buy), not both.");
  if (o.buy) {
    const e164 = toE164(o.buy);
    return { e164, offer: await findInventoryNumber(ctx, e164) };
  }
  if (o.number) {
    const e164 = toE164(o.number);
    return { e164, own: await findOwnNumber(ctx, e164, { dryRun: false }) };
  }
  if (!interactive(ctx))
    throw usage("Pass --number <e164> (a number on your account) or --buy <e164> (one from `vobiz numbers search --country IN`).");
  const useOwn = !o.country && (await ctx.prompts.confirm("Use a phone number you already have?", true));
  if (useOwn) {
    const body = await ctx.client.call(VOICE_NUMBERS, { query: { per_page: 20 } });
    const mine = (extractItems(body) ?? []).filter(isRec) as NumberRecord[];
    if (!mine.length) throw new VobizError("not_found", "There are no numbers on this account yet. Run again and choose to buy one, or pass --buy.");
    const pick = await choose(ctx, "Your numbers:", mine, (n) => `${n.e164} ${[n.region, n.country].filter(Boolean).join(", ")}${n.trunk_group_id ? ` (trunk ${String(n.trunk_group_id)})` : ""}`, (n) => String(n.e164));
    const e164 = toE164(typeof pick === "string" ? pick : String(pick.e164));
    return { e164, own: typeof pick === "string" ? await findOwnNumber(ctx, e164) : pick };
  }
  const country = (o.country ?? (await ctx.prompts.input("Country to buy a number in (ISO code, e.g. IN or US):"))).trim().toUpperCase();
  const body = await ctx.client.call(INVENTORY, { query: { country, search: o.contains, per_page: 10 } });
  const offers = (extractItems(body) ?? []).filter(isRec) as NumberRecord[];
  if (!offers.length) throw new VobizError("not_found", `No inventory numbers in ${country}${o.contains ? ` containing ${o.contains}` : ""}. Try another country or --contains.`);
  const pick = await choose(ctx, `Numbers you can buy in ${country}:`, offers, (n) => `${n.e164} ${n.region ?? ""} ${money(n.currency, n.setup_fee)} setup + ${money(n.currency, n.monthly_fee)}/month`, (n) => String(n.e164));
  const e164 = toE164(typeof pick === "string" ? pick : String(pick.e164));
  return { e164, offer: typeof pick === "string" ? await findInventoryNumber(ctx, e164) : pick };
}

async function pickTrunk(ctx: Ctx, o: VoiceOpts): Promise<Rec> {
  if (o.trunk) {
    const t = await ctx.client.call<Rec>(GET_TRUNK, { path: { trunk_id: o.trunk }, dryRun: false });
    return isRec(t?.data) ? (t.data as Rec) : { trunk_id: o.trunk, ...(isRec(t) ? t : {}) };
  }
  if (!interactive(ctx)) throw usage("Pass --trunk <trunk-id> (see `vobiz trunks list`): the number's inbound calls are routed to that SIP trunk.");
  const body = await ctx.client.call(LIST_TRUNKS);
  const trunks = (extractItems(body) ?? []).filter(isRec);
  if (!trunks.length) throw new VobizError("not_found", "There are no SIP trunks on this account. Create one with `vobiz trunks create --name …` (or in your voice-agent platform's Vobiz guide) and run setup again.");
  const pick = await choose(ctx, "SIP trunks:", trunks, (t) => `${String(t.name ?? "")} ${String(t.trunk_id ?? "")} ${t.trunk_direction ? `(${String(t.trunk_direction)})` : ""}`.trim(), (t) => String(t.trunk_id));
  return typeof pick === "string" ? pickTrunk(ctx, { trunk: pick }) : pick;
}

function registerVoiceAgent(setup: Command, ctx: Ctx) {
  setup
    .command("voice-agent")
    .description("Route a phone number (yours, or one to buy) to the SIP trunk of your AI voice agent, then print a test plan")
    .option("--number <e164>", "a number already on your account, e.g. +918065550100")
    .option("--buy <e164>", "buy this inventory number first (see `vobiz numbers search`); shows the price before asking")
    .option("--country <code>", "interactive: search the inventory in this country (e.g. IN) instead of asking")
    .option("--contains <digits>", "interactive: only offer inventory numbers containing these digits")
    .option("--currency <code>", "with --buy: currency to bill in")
    .option("--trunk <trunk-id>", "SIP trunk that receives the number's calls (see `vobiz trunks list`)")
    .option("--answer-url <url>", "link the number to an application with this answer URL (not available yet; see below)")
    .option("--stream-url <wss-url>", "link the number to a <Stream> application (not available yet; see below)")
    .option("--app <app-id>", "link the number to this application (not available yet; see below)")
    .addHelpText(
      "after",
      `
Every write (the purchase, the routing) is listed in one confirmation before anything is sent.

Examples:
  vobiz setup voice-agent
  vobiz setup voice-agent --number +918065550100 --trunk e3e55a78-1234-5678-90ab-cdef12345678 --yes
  vobiz setup voice-agent --buy +918065550199 --trunk <trunk-id> --dry-run

Application links (--answer-url, --stream-url, --app) need an API endpoint that is not in the spec yet; until it
is, route the number to a trunk or link it in the Vobiz Console. Test a <Stream> server with \`vobiz streams test\`.`,
    )
    .action(async (o: VoiceOpts) => {
      if (o.answerUrl || o.streamUrl || o.app) throw new VobizError("unsupported", APP_LINK_GAP);
      const { e164, own, offer } = await pickVoiceNumber(ctx, o);
      const trunk = await pickTrunk(ctx, o);
      const trunkId = String(trunk.trunk_id ?? o.trunk ?? "");
      const trunkLabel = `${trunk.name ? `${String(trunk.name)} ` : ""}(${trunkId})`;
      const plan = [
        `Call ${e164} from your phone; it should reach your agent through trunk ${trunkLabel}.`,
        "See the call record: `vobiz cdr recent --limit 1`.",
        "If it did not connect: `vobiz diagnose call <call-uuid>`.",
        `Watch the number's answer rate over time: \`vobiz numbers health ${e164}\`.`,
      ];
      const notes: string[] = [];
      if (trunk.trunk_direction === "outbound") notes.push(`Trunk ${trunkId} is configured with trunk_direction "outbound"; check that it accepts inbound calls for this number.`);

      if (own && own.trunk_group_id === trunkId && !offer) {
        ctx.out.status(`${e164} is already routed to trunk ${trunkLabel}. Nothing to change.`);
        printOutcome(ctx, { number: e164, trunk_id: trunkId, trunk_name: trunk.name ?? null, bought: false, routed: true, changed: false }, plan, notes);
        return;
      }

      const details: Record<string, string> = { number: e164, account: ctx.client.authId, trunk: trunkLabel };
      if (trunk.trunk_domain) details["trunk domain"] = String(trunk.trunk_domain);
      if (trunk.trunk_direction) details["trunk direction"] = String(trunk.trunk_direction);
      if (own?.trunk_group_id) details["currently routed to"] = `trunk ${String(own.trunk_group_id)} (replaced)`;
      if (own?.application_id) details["current application"] = String(own.application_id);
      const steps: Step[] = [];
      let cost: string | undefined;
      if (offer) {
        details.location = [offer.region, offer.country].filter(Boolean).join(", ") || "unknown";
        if (ctx.client.authId.startsWith("SA_")) details.billed_to = "the parent main account";
        cost = `${money(offer.currency, offer.setup_fee)} setup now, then ${money(offer.currency, offer.monthly_fee)}/month`;
        steps.push({
          label: `Buy ${e164}`,
          operation: PURCHASE,
          args: { body: { e164, ...(o.currency ? { currency: o.currency.toUpperCase() } : {}) } },
          retry: `vobiz numbers buy ${e164}`,
        });
      }
      steps.push({ label: `Route ${e164} to trunk ${trunkId}`, operation: ASSIGN_TRUNK, args: { path: { phone_number: e164 }, body: { trunk_group_id: trunkId } }, retry: `vobiz numbers assign ${e164} --trunk ${trunkId}` });

      const done = await runPlan(ctx, { action: `Set up ${e164} for your voice agent (${steps.length} step${steps.length > 1 ? "s" : ""}: ${steps.map((s) => s.label).join(", then ")})`, details, cost }, steps);
      if (!done) return;
      ctx.out.status(`${offer ? `Bought ${e164} and routed` : `Routed ${e164}`} to trunk ${trunkLabel}.`);
      printOutcome(ctx, { number: e164, trunk_id: trunkId, trunk_name: trunk.name ?? null, bought: !!offer, routed: true, changed: true }, plan, notes);
    });
}

// ── setup sms ──

interface SmsOpts {
  number?: string;
  buy?: string;
  country?: string;
  numberKey?: string;
  webhook?: string;
  webhookUrl?: string;
  secret?: string;
  event?: string[];
  noWebhook?: boolean;
}

const smsItems = (body: unknown, key: string): Rec[] => (isRec(body) && Array.isArray(body[key]) ? (body[key] as unknown[]).filter(isRec) : []);
const country2 = (v: string) => {
  const c = v.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) throw usage(`Use a two-letter ISO country code such as US, CA or GB (got "${v}").`);
  return c;
};

async function pickSmsNumber(ctx: Ctx, o: SmsOpts): Promise<{ e164: string; country?: string; offer?: Rec; buy: boolean; numberKey?: string }> {
  if (o.number && o.buy) throw usage("Pass either --number (a messaging number you have) or --buy (a number to buy), not both.");
  if (o.number) {
    const e164 = toE164(o.number);
    const mine = smsItems(await ctx.client.call(SMS_NUMBERS, { dryRun: false }), "numbers");
    const hit = mine.find((n) => n.e164 === e164);
    if (!hit) throw new VobizError("not_found", `${e164} is not a messaging number on this account. See \`vobiz sms numbers list\`, or buy one with --buy.`);
    return { e164, country: typeof hit.countryCode === "string" ? hit.countryCode : undefined, buy: false };
  }
  if (o.buy) {
    const e164 = toE164(o.buy);
    if (!o.country) throw usage("--buy needs --country (the number's ISO country code, e.g. US).");
    const country = country2(o.country);
    const offer = await findSmsOffer(ctx, e164, country);
    return { e164, country, offer, buy: true, numberKey: o.numberKey ?? (typeof offer?.numberKey === "string" && offer.numberKey ? offer.numberKey : undefined) };
  }
  if (!interactive(ctx)) throw usage("Pass --number <e164> (a messaging number you have) or --buy <e164> --country <CC> (from `vobiz sms numbers search`).");
  if (!o.country && (await ctx.prompts.confirm("Use a messaging number you already have?", true))) {
    const mine = smsItems(await ctx.client.call(SMS_NUMBERS), "numbers");
    if (!mine.length) throw new VobizError("not_found", "There are no messaging numbers on this account yet. Run again and choose to buy one.");
    const pick = await choose(ctx, "Your messaging numbers:", mine, (n) => `${String(n.e164)} ${String(n.countryCode ?? "")} ${Array.isArray(n.capabilities) ? n.capabilities.join(",") : ""}`, (n) => String(n.e164));
    return pickSmsNumber(ctx, { number: typeof pick === "string" ? pick : String(pick.e164) });
  }
  const country = country2(o.country ?? (await ctx.prompts.input("Country to buy a messaging number in (ISO code, e.g. US):")));
  const offers = smsItems(await ctx.client.call(SMS_SEARCH, { query: { country, limit: 10 } }), "numbers");
  if (!offers.length) throw new VobizError("not_found", `No messaging numbers available in ${country}. See \`vobiz sms numbers countries\`.`);
  const pick = await choose(ctx, `Messaging numbers you can buy in ${country}:`, offers, (n) => `${String(n.e164)} ${money(n.currency, n.setupPrice)} setup + ${money(n.currency, n.monthlyPrice)}/month`, (n) => String(n.e164));
  if (typeof pick === "string") return pickSmsNumber(ctx, { buy: pick, country });
  const e164 = toE164(String(pick.e164));
  return { e164, country, offer: pick, buy: true, numberKey: typeof pick.numberKey === "string" && pick.numberKey ? pick.numberKey : undefined };
}

async function pickWebhook(ctx: Ctx, o: SmsOpts): Promise<{ existing?: Rec; create?: Rec } | undefined> {
  if (o.webhook && o.webhookUrl) throw usage("Pass either --webhook <id> (an existing webhook) or --webhook-url <https-url> (create one), not both.");
  if (o.webhook) {
    const w = await ctx.client.call<Rec>(GET_WEBHOOK, { path: { id: o.webhook }, dryRun: false });
    return { existing: isRec(w) ? w : { id: o.webhook } };
  }
  let url = o.webhookUrl;
  if (!url && !o.noWebhook && interactive(ctx) && (await ctx.prompts.confirm("Send inbound messages and delivery reports to a webhook?", true)))
    url = httpsUrl("--webhook-url")(await ctx.prompts.input("Webhook URL (https):"));
  if (!url) return undefined;
  const list = await ctx.client.call(WEBHOOKS, { dryRun: false });
  const same = (extractItems(list) ?? []).filter(isRec).find((w) => w.url === url);
  if (same) return { existing: same };
  return { create: compact({ url, secret: o.secret, events: o.event }) };
}

function smsCompliance(e164: string, country: string | undefined): string[] {
  if (country === "US" || (!country && e164.startsWith("+1")))
    return ["US long codes need a registered 10DLC brand and campaign with the number attached (`vobiz sms 10dlc …`); US toll-free numbers need a toll-free campaign."];
  if (country === "IN" || e164.startsWith("+91")) return ["India traffic needs TRAI DLT IDs (dltEntityId, dltHeaderId, dltTemplateId) on every message, and text that matches the registered template."];
  return [];
}

function registerSms(setup: Command, ctx: Ctx) {
  setup
    .command("sms")
    .description("Get a messaging number (yours, or one to buy) and a webhook for replies and delivery reports, then print a test plan")
    .option("--number <e164>", "a messaging number already on your account")
    .option("--buy <e164>", "buy this number first (from `vobiz sms numbers search`); needs --country")
    .option("--country <code>", "ISO country code of the number to buy, e.g. US")
    .option("--number-key <key>", "with --buy: numberKey from search (looked up when omitted)")
    .option("--webhook-url <url>", "https URL for message.received, message.delivered and message.failed (reused if it exists)", httpsUrl("--webhook-url"))
    .option("--webhook <id>", "use this existing messaging webhook instead")
    .option("--secret <secret>", "with --webhook-url: signing secret for X-Webhook-Signature")
    .option("--event <name>", "with --webhook-url: event to deliver (repeatable; default: the three message events)", collect)
    .option("--no-webhook", "skip the webhook (you will poll message status instead)")
    .addHelpText(
      "after",
      `
Every write (the purchase, the webhook) is listed in one confirmation before anything is sent. Webhooks are
account-wide: one subscription receives events for all your messaging numbers.

Examples:
  vobiz setup sms
  vobiz setup sms --number +14155550100 --webhook-url https://example.com/vobiz/sms --secret "$WEBHOOK_SECRET" --yes
  vobiz setup sms --buy +14155550123 --country US --no-webhook --dry-run`,
    )
    .action(async (o: Omit<SmsOpts, "webhook"> & { webhook?: string | boolean }) => {
      const opts: SmsOpts = { ...o, webhook: typeof o.webhook === "string" ? o.webhook : undefined, noWebhook: o.webhook === false };
      const num = await pickSmsNumber(ctx, opts);
      const hook = await pickWebhook(ctx, opts);
      if (hook?.create && !opts.secret) ctx.out.warn("No --secret: deliveries will be signed with an empty secret, so you cannot verify them.");
      if (!hook && !opts.noWebhook) ctx.out.warn("No webhook: you will not be notified of replies or delivery reports; check them with `vobiz sms messages list`.");

      const steps: Step[] = [];
      const details: Record<string, string> = { number: num.e164 };
      if (num.country) details.country = num.country;
      let cost: string | undefined;
      if (num.buy) {
        if (num.numberKey) details["number key"] = num.numberKey;
        const p = num.offer;
        cost = p
          ? `${String(p.currency ?? "")} ${String(p.setupPrice ?? "?")} setup + ${String(p.monthlyPrice ?? "?")}/month, debited now; renews monthly until released`.trim()
          : "setup fee + first month's rental, debited now (price not found in a fresh search; check `vobiz sms numbers search`)";
        steps.push({
          label: `Buy messaging number ${num.e164}`,
          operation: SMS_PURCHASE,
          args: { body: { e164: num.e164, country: num.country, ...(num.numberKey ? { numberKey: num.numberKey } : {}) } },
          retry: `vobiz sms numbers buy ${num.e164} --country ${num.country}`,
        });
      }
      if (hook?.create) {
        details["webhook host"] = urlHost(String(hook.create.url));
        details.events = Array.isArray(hook.create.events) ? hook.create.events.join(", ") : "default (message.received, message.delivered, message.failed)";
        steps.push({ label: "Create a messaging webhook", operation: CREATE_WEBHOOK, args: { body: hook.create }, retry: `vobiz sms webhooks create --url ${String(hook.create.url)}` });
      } else if (hook?.existing) details.webhook = `existing ${String(hook.existing.id ?? "")} (${urlHost(String(hook.existing.url ?? ""))}), unchanged`;

      const you = "<your mobile, E.164>";
      const plan = [
        `Preview the price: \`vobiz sms cost --from ${num.e164} --to ${you} --text "Hello from Vobiz"\`.`,
        `Send yourself a message and wait for delivery: \`vobiz sms send --from ${num.e164} --to ${you} --text "Hello from Vobiz" --wait\`.`,
        "If it is not delivered: `vobiz diagnose message <message-id>`.",
        hook ? `Reply to ${num.e164} from your phone; your webhook should receive message.received.` : `Reply to ${num.e164} from your phone and read it with \`vobiz sms conversations list\`.`,
      ];
      const notes = smsCompliance(num.e164, num.country);
      const result: Rec = { number: num.e164, country: num.country ?? null, bought: num.buy, webhook_id: hook?.existing?.id ?? null, webhook_url_host: hook ? urlHost(String((hook.create ?? hook.existing)?.url ?? "")) : null };

      if (!steps.length) {
        ctx.out.status(`${num.e164} is ready${hook?.existing ? ` and webhook ${String(hook.existing.id ?? "")} already receives its events` : ""}. Nothing to change.`);
        printOutcome(ctx, { ...result, changed: false }, plan, notes);
        return;
      }
      const done = await runPlan(ctx, { action: `Set up messaging on ${num.e164} (${steps.map((s) => s.label).join(", then ")})`, details, cost }, steps);
      if (!done) return;
      const created = hook?.create ? done[done.length - 1] : undefined;
      if (isRec(created) && created.id) result.webhook_id = created.id;
      ctx.out.status(`Messaging is set up on ${num.e164}.`);
      printOutcome(ctx, { ...result, changed: true }, plan, notes);
    });
}

export function register(program: Command, ctx: Ctx): void {
  const setup = program.command("setup").description("Guided setups: a number for your AI voice agent, or a number and webhook for SMS");
  registerVoiceAgent(setup, ctx);
  registerSms(setup, ctx);
}
