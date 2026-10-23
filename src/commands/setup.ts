/**
 * `vobiz setup voice-agent` and `vobiz setup sms`: guided composites over the existing commands. Each one gathers
 * every choice first (interactively on a terminal, or entirely from flags for scripts and agents), shows ONE
 * confirmation summary covering every write, runs the writes in order, and prints a test plan.
 *
 * voice-agent  a number (one you have, or one to buy) routed either to a SIP trunk, which is how AI voice platforms
 *              (LiveKit, Pipecat, Vapi, Retell…) take calls, or to an Application: an existing one (--app) or a new
 *              one created with --answer-url (whose VobizXML may <Stream> to --stream-url). A number is on a trunk
 *              or an application, not both, so linking an application first removes the number from its trunk.
 * sms          a messaging number (one you have, or one to buy) plus a webhook for inbound messages and delivery
 *              reports (an existing one with the same URL is reused).
 *
 * --dry-run prints every request the setup would send; the reads it needs to build them still run.
 */
import { Option, type Command } from "commander";
import type { Ctx } from "../core/context.js";
import { VobizError, usage } from "../core/errors.js";
import { op } from "../core/ops.js";
import { readSecretArg } from "../core/secrets.js";
import { extractItems } from "../core/pagination.js";
import { toE164 } from "../core/phone.js";
import { findInventoryNumber, findOwnNumber, routingSteps, type NumberRecord } from "./numbers.js";
import { runPlan, type Step } from "./provisioning-shared.js";
import { findSmsOffer } from "./sms/numbers.js";
import { compact, httpsUrl, urlHost } from "./sms/shared.js";
import { collect, isRec, type Rec } from "./voice-shared.js";

const VOICE_NUMBERS = op("voice:list-numbers");
const INVENTORY = op("list-inventory-numbers");
const PURCHASE = op("purchase-from-inventory");
const ASSIGN_TRUNK = op("assign-number-to-trunk");
const LIST_TRUNKS = op("list-trunks");
const GET_TRUNK = op("retrieve-trunk");
const GET_APP = op("retrieve-application");
const CREATE_APP = op("create-application");
const SMS_NUMBERS = op("sms:list-numbers");
const SMS_SEARCH = op("search-available-numbers");
const SMS_PURCHASE = op("purchase-number");
const WEBHOOKS = op("list-webhooks");
const GET_WEBHOOK = op("get-webhook");
const CREATE_WEBHOOK = op("create-webhook");

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
  appName?: string;
  answerMethod?: string;
}

/** The application side of `setup voice-agent`: an existing app, or one to create. */
interface AppChoice {
  existing?: Rec;
  create?: Rec;
}

/** The answer URL must return VobizXML; for a stream, that XML is a <Stream> pointing at the stream server. */
const streamXml = (wss: string) =>
  `<Response>\n  <Stream bidirectional="true" keepCallAlive="true">${wss}</Stream>\n</Response>`;

/** Flag conflicts, checked before any request. */
function checkAppFlags(o: VoiceOpts): void {
  const modes = [o.trunk && "--trunk", o.app && "--app", o.answerUrl && "--answer-url"].filter(Boolean);
  if (modes.length > 1) throw usage(`A number is linked to a SIP trunk or an application, not both: pass one of ${modes.join(", ")}.`);
  if (o.streamUrl) {
    if (!/^wss:\/\//i.test(o.streamUrl)) throw usage(`--stream-url must be a wss:// URL (got "${o.streamUrl}").`);
    if (!o.answerUrl)
      throw usage(
        "--stream-url needs --answer-url: Vobiz fetches VobizXML from the answer URL, so host this document there (for example with " +
          "`vobiz xml serve stream.xml` behind a tunnel) and pass its https URL:\n" + streamXml(o.streamUrl),
      );
  }
  if (o.answerUrl) httpsUrl("--answer-url")(o.answerUrl);
  if ((o.appName || o.answerMethod) && !o.answerUrl) throw usage("--app-name and --answer-method go with --answer-url (they describe the application to create).");
}

async function pickApp(ctx: Ctx, o: VoiceOpts, e164: string): Promise<AppChoice | undefined> {
  if (o.app) {
    const a = await ctx.client.call<Rec>(GET_APP, { path: { app_id: o.app }, dryRun: false });
    return { existing: isRec(a) ? { app_id: o.app, ...a } : { app_id: o.app } };
  }
  if (o.answerUrl) {
    return { create: { app_name: o.appName ?? `Voice agent ${e164}`, answer_url: o.answerUrl, answer_method: o.answerMethod ?? "POST" } };
  }
  return undefined;
}

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
  if (!interactive(ctx))
    throw usage("Pass --trunk <trunk-id> (see `vobiz trunks list`) to route the number's inbound calls to a SIP trunk, or --app <app-id> / --answer-url <https-url> to link it to an application.");
  const body = await ctx.client.call(LIST_TRUNKS);
  const trunks = (extractItems(body) ?? []).filter(isRec);
  if (!trunks.length) throw new VobizError("not_found", "There are no SIP trunks on this account. Create one with `vobiz trunks create --name …` (or in your voice-agent platform's Vobiz guide) and run setup again.");
  const pick = await choose(ctx, "SIP trunks:", trunks, (t) => `${String(t.name ?? "")} ${String(t.trunk_id ?? "")} ${t.trunk_direction ? `(${String(t.trunk_direction)})` : ""}`.trim(), (t) => String(t.trunk_id));
  return typeof pick === "string" ? pickTrunk(ctx, { trunk: pick }) : pick;
}

/** --app / --answer-url: buy (optional), create the application (optional), then link the number to it. */
async function setupApplication(ctx: Ctx, o: VoiceOpts, e164: string, app: AppChoice, own: NumberRecord | undefined, offer: NumberRecord | undefined): Promise<void> {
  const appId = app.existing ? String(app.existing.app_id) : undefined;
  const answerUrl = String((app.existing ?? app.create)?.answer_url ?? "");
  const appLabel = app.existing ? `${app.existing.app_name ? `${String(app.existing.app_name)} ` : ""}(${appId})` : `new application "${String(app.create?.app_name)}"`;
  const plan = [
    `Call ${e164} from your phone; Vobiz fetches VobizXML from ${answerUrl ? urlHost(answerUrl) : "the application's answer URL"} and your agent should answer.`,
    ...(o.streamUrl ? [`Check the stream server before calling: \`vobiz streams test ${o.streamUrl}\`.`] : []),
    "See the call record: `vobiz cdr recent --limit 1`.",
    "If it did not connect: `vobiz diagnose call <call-uuid>`.",
    `Watch the number's answer rate over time: \`vobiz numbers health ${e164}\`.`,
  ];
  const notes: string[] = [];
  if (o.streamUrl) notes.push(`${urlHost(answerUrl)} must return VobizXML that streams to ${urlHost(o.streamUrl)}, e.g. ${streamXml(o.streamUrl).replace(/\n\s*/g, "")}`);
  const result: Rec = { number: e164, application_id: appId ?? null, application_created: !!app.create, answer_url_host: answerUrl ? urlHost(answerUrl) : null, trunk_id: null, bought: !!offer, routed: true };

  if (appId && own && String(own.application_id ?? "") === appId && !own.trunk_group_id && !offer) {
    ctx.out.status(`${e164} is already linked to application ${appLabel}. Nothing to change.`);
    printOutcome(ctx, { ...result, changed: false }, plan, notes);
    return;
  }

  const details: Record<string, string> = { number: e164, account: ctx.client.authId, application: appLabel };
  if (answerUrl) details["answer URL host"] = urlHost(answerUrl);
  if (o.streamUrl) details["stream host"] = urlHost(o.streamUrl);
  if (own?.trunk_group_id) details["currently routed to"] = `trunk ${String(own.trunk_group_id)} (removed)`;
  if (own?.application_id) details["current application"] = `${String(own.application_id)} (replaced)`;
  const steps: Step[] = [];
  let cost: string | undefined;
  if (offer) {
    details.location = [offer.region, offer.country].filter(Boolean).join(", ") || "unknown";
    if (ctx.client.authId.startsWith("SA_")) details.billed_to = "the parent main account";
    cost = `${money(offer.currency, offer.setup_fee)} setup now, then ${money(offer.currency, offer.monthly_fee)}/month`;
    steps.push({ label: `Buy ${e164}`, operation: PURCHASE, args: { body: { e164, ...(o.currency ? { currency: o.currency.toUpperCase() } : {}) } }, retry: `vobiz numbers buy ${e164}` });
  }
  let createIndex = -1;
  if (app.create) {
    const c = app.create;
    createIndex = steps.length;
    steps.push({
      label: `Create application "${String(c.app_name)}"`,
      operation: CREATE_APP,
      args: { body: c },
      retry: `vobiz apps create --app-name '${String(c.app_name)}' --answer-url ${String(c.answer_url)} --answer-method ${String(c.answer_method)}`,
    });
  }
  const placeholder = appId ?? `<app_id from step ${createIndex + 1}>`;
  const newAppId = (results: unknown[]): string => {
    const r = results[createIndex];
    const id = isRec(r) ? (r.app_id ?? (isRec(r.data) ? r.data.app_id : undefined)) : undefined;
    if (!id) throw new VobizError("unexpected_response", "Vobiz created the application but returned no app_id; find it with `vobiz apps list` and run `vobiz numbers update` with --app.");
    return String(id);
  };
  for (const step of routingSteps(e164, offer ? {} : (own ?? {}), { app: placeholder })) {
    if (step.operation.id === "link-number-to-application" && createIndex >= 0) {
      step.resolve = (results) => ({ ...step.args, body: { application_id: newAppId(results) } });
      step.label = `Link ${e164} to the new application`;
      step.retry = `vobiz numbers update ${e164} --app <app_id>`;
    }
    steps.push(step);
  }

  const done = await runPlan(ctx, { action: `Set up ${e164} for your voice agent (${steps.length} step${steps.length > 1 ? "s" : ""}: ${steps.map((s) => s.label).join(", then ")})`, details, cost }, steps);
  if (!done) return;
  if (createIndex >= 0) result.application_id = newAppId(done);
  ctx.out.status(`${offer ? `Bought ${e164} and linked it` : `Linked ${e164}`} to application ${String(result.application_id)}.`);
  printOutcome(ctx, { ...result, changed: true }, plan, notes);
}

function registerVoiceAgent(setup: Command, ctx: Ctx) {
  setup
    .command("voice-agent")
    .description("Route a phone number (yours, or one to buy) to your AI voice agent's SIP trunk or application, then print a test plan")
    .option("--number <e164>", "a number already on your account, e.g. +918065550100")
    .option("--buy <e164>", "buy this inventory number first (see `vobiz numbers search`); shows the price before asking")
    .option("--country <code>", "interactive: search the inventory in this country (e.g. IN) instead of asking")
    .option("--contains <digits>", "interactive: only offer inventory numbers containing these digits")
    .option("--currency <code>", "with --buy: currency to bill in")
    .option("--trunk <trunk-id>", "SIP trunk that receives the number's calls (see `vobiz trunks list`)")
    .option("--app <app-id>", "link the number to this existing application (see `vobiz apps list`)")
    .option("--answer-url <url>", "create an application with this https answer URL and link the number to it")
    .option("--app-name <name>", "with --answer-url: name of the new application (default: Voice agent <number>)")
    .addOption(new Option("--answer-method <method>", "with --answer-url: HTTP method Vobiz uses for the answer URL (default: POST)").choices(["GET", "POST"]))
    .option("--stream-url <wss-url>", "with --answer-url: the stream server the answer URL's <Stream> points at (added to the test plan)")
    .addHelpText(
      "after",
      `
Every write (the purchase, the new application, the routing) is listed in one confirmation before anything is sent.
A number is linked to a SIP trunk or an application, not both: linking an application removes it from its trunk.

Examples:
  vobiz setup voice-agent
  vobiz setup voice-agent --number +918065550100 --trunk e3e55a78-1234-5678-90ab-cdef12345678 --yes
  vobiz setup voice-agent --buy +918065550199 --trunk <trunk-id> --dry-run
  vobiz setup voice-agent --number +918065550100 --app 12345678901234567
  vobiz setup voice-agent --number +918065550100 --answer-url https://agent.example.com/answer --stream-url wss://agent.example.com/media

With --stream-url, the answer URL must return VobizXML such as
  <Response><Stream bidirectional="true" keepCallAlive="true">wss://agent.example.com/media</Stream></Response>
Test the stream server with \`vobiz streams test <wss-url>\`.`,
    )
    .action(async (o: VoiceOpts) => {
      checkAppFlags(o);
      const { e164, own, offer } = await pickVoiceNumber(ctx, o);
      const app = await pickApp(ctx, o, e164);
      if (app) return setupApplication(ctx, o, e164, app, own, offer);
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
    .option("--secret <secret>", "with --webhook-url: signing secret for X-Webhook-Signature (@file or @- for stdin keeps it out of shell history)")
    .option("--event <name>", "with --webhook-url: event to deliver (repeatable; default: the three message events)", collect)
    .option("--no-webhook", "skip the webhook (you will poll message status instead)")
    .addHelpText(
      "after",
      `
Every write (the purchase, the webhook) is listed in one confirmation before anything is sent. Webhooks are
account-wide: one subscription receives events for all your messaging numbers.

Examples:
  vobiz setup sms
  vobiz setup sms --number +14155550100 --webhook-url https://example.com/vobiz/sms --secret @webhook-secret.txt --yes
  vobiz setup sms --buy +14155550123 --country US --no-webhook --dry-run`,
    )
    .action(async (o: Omit<SmsOpts, "webhook"> & { webhook?: string | boolean }) => {
      const opts: SmsOpts = { ...o, webhook: typeof o.webhook === "string" ? o.webhook : undefined, noWebhook: o.webhook === false };
      if (opts.secret !== undefined) opts.secret = await readSecretArg(ctx, opts.secret, "--secret");
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
