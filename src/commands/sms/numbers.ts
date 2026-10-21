/**
 * `vobiz sms numbers list|countries|search|buy|purchases|release` and `sms coverage list|get`.
 * `buy` and `release` spend or end a monthly rental, so they always show the price and ask first.
 */
import { Option, type Command } from "commander";
import { requireConfirmation } from "../../core/confirm.js";
import type { Ctx } from "../../core/context.js";
import { usage } from "../../core/errors.js";
import { op } from "../../core/ops.js";
import { digitsOnly, toE164 } from "../../core/phone.js";
import { intArg, isRec, printResult, simpleList, type Rec } from "./shared.js";

const LIST = op("sms:list-numbers");
const COUNTRIES = op("list-countries");
const SEARCH = op("search-available-numbers");
const PURCHASE = op("purchase-number");
const PURCHASES = op("list-purchases");
const RELEASE = op("release-number");
const COVERAGE = op("list-coverage");
const COVERAGE_GET = op("get-coverage");

const country = (v: string): string => {
  if (!/^[A-Za-z]{2}$/.test(v.trim())) throw usage(`Use a two-letter ISO country code such as US, CA or GB (got "${v}").`);
  return v.trim().toUpperCase();
};

/**
 * The purchasable offer (price, numberKey) for one number, from a fresh search by country (and area code for US/CA).
 * A read the purchase depends on, so it runs even with --dry-run; undefined when the number is not found.
 */
export async function findSmsOffer(ctx: Ctx, e164: string, country: string): Promise<Rec | undefined> {
  try {
    const areaCode = (country === "US" || country === "CA") && digitsOnly(e164).startsWith("1") ? digitsOnly(e164).slice(1, 4) : undefined;
    const found = await ctx.client.call<Rec>(SEARCH, { query: { country, areaCode, limit: 100 }, dryRun: false });
    const list = isRec(found) && Array.isArray(found.numbers) ? (found.numbers as Rec[]) : [];
    return list.find((n) => typeof n.e164 === "string" && digitsOnly(n.e164) === digitsOnly(e164));
  } catch {
    return undefined;
  }
}

function registerNumbers(sms: Command, ctx: Ctx): void {
  const numbers = sms.command("numbers").description("Messaging numbers: list yours, search and buy new ones, release");

  numbers
    .command("list")
    .alias("ls")
    .description("List the numbers on your account that are routed for SMS/MMS")
    .action(async () => {
      await simpleList(ctx, LIST, {}, "numbers", {
        columns: ["e164", "countryCode", "type", "capabilities", "registration.status", "sendable.usDomestic"],
        idKey: "e164",
        empty: "No messaging numbers on this account. Find one with `vobiz sms numbers search --country US`.",
      });
    });

  numbers
    .command("countries")
    .description("List the countries with messaging numbers in stock")
    .action(async () => {
      await simpleList(ctx, COUNTRIES, {}, "countries", { columns: ["country", "name", "types", "capabilities"], idKey: "country" });
    });

  numbers
    .command("search")
    .description("Search numbers you can buy in one country, with setup and monthly prices")
    .requiredOption("--country <code>", "ISO country code, e.g. US, CA, GB", country)
    .addOption(new Option("--capabilities <list>", "required capabilities").choices(["SMS", "MMS", "SMS,MMS"]))
    .option("--area-code <code>", "three-digit area code (US and CA only)")
    .addOption(new Option("--limit <n>", "maximum results (the API returns at most 10)").argParser(intArg("--limit", 1, 100)))
    .addHelpText("after", "\nExamples:\n  vobiz sms numbers search --country US --area-code 415\n  vobiz sms numbers search --country GB --capabilities SMS,MMS")
    .action(async (o: { country: string; capabilities?: string; areaCode?: string; limit?: number }) => {
      if (o.areaCode && !/^\d{3}$/.test(o.areaCode)) throw usage("--area-code must be three digits, e.g. 415.");
      const body = await ctx.client.call<Rec>(SEARCH, { query: { country: o.country, capabilities: o.capabilities, areaCode: o.areaCode, limit: o.limit } });
      const items = isRec(body) && Array.isArray(body.numbers) ? body.numbers : [];
      const mode = ctx.out.mode;
      if ((mode === "json" || mode === "yaml") && !ctx.flags.fields?.length && !ctx.flags.quiet) ctx.out.print(body);
      else ctx.out.print(items, { columns: ["e164", "type", "capabilities", "setupPrice", "monthlyPrice", "currency", "numberKey"], idKey: "e164", empty: "No numbers available." });
      if (isRec(body) && typeof body.hint === "string" && body.hint) ctx.out.status(body.hint);
    });

  numbers
    .command("buy")
    .description("Buy a number from `sms numbers search` (debits the setup fee and first month now)")
    .argument("<e164>", "the number to buy, as listed by search")
    .requiredOption("--country <code>", "ISO country code of the number, e.g. US", country)
    .option("--number-key <key>", "numberKey from search (required for CA and GB; looked up when omitted)")
    .addHelpText(
      "after",
      "\nThe price is looked up with a fresh search and shown before you confirm. The rental renews monthly until you\nrelease the number.\n\nExample:\n  vobiz sms numbers buy +14155550100 --country US",
    )
    .action(async (num: string, o: { country: string; numberKey?: string }) => {
      const e164 = toE164(num);
      const price = await findSmsOffer(ctx, e164, o.country);
      const numberKey = o.numberKey ?? (typeof price?.numberKey === "string" && price.numberKey ? price.numberKey : undefined);
      const cost = price
        ? `${price.currency ?? ""} ${price.setupPrice ?? "?"} setup + ${price.monthlyPrice ?? "?"}/month, debited now; renews monthly until released`.trim()
        : "setup fee + first month's rental, debited now (price not found in a fresh search; check `vobiz sms numbers search`)";
      await requireConfirmation(ctx, { action: `Buy messaging number ${e164}`, details: { country: o.country, ...(numberKey ? { "number key": numberKey } : {}) }, cost });
      const res = await ctx.client.call(PURCHASE, { body: { e164, country: o.country, ...(numberKey ? { numberKey } : {}) }, sideEffect: true });
      printResult(ctx, `Bought ${e164}.`, res);
    });

  numbers
    .command("purchases")
    .description("List your number purchases with their charges")
    .action(async () => {
      await simpleList(ctx, PURCHASES, {}, "purchases", {
        columns: ["id", "e164", "status", "setupAmount", "monthlyAmount", "currency", "nextBillingAt"],
        idKey: "id",
      });
    });

  numbers
    .command("release")
    .description("Release a number you bought; it stops sending and receiving immediately")
    .argument("<e164>", "the number to release")
    .addHelpText("after", "\nThe setup fee and the current month are not refunded, and a released number cannot be restored.\n\nExample:\n  vobiz sms numbers release +14155550100")
    .action(async (num: string) => {
      const e164 = toE164(num);
      await requireConfirmation(ctx, {
        action: `Release messaging number ${e164}`,
        details: { effect: "stops sending and receiving now; monthly rental stops", refund: "none for the setup fee or current month", undo: "not possible" },
      });
      const res = await ctx.client.call(RELEASE, { path: { e164 }, sideEffect: true });
      printResult(ctx, `Released ${e164}.`, res);
    });
}

function registerCoverage(sms: Command, ctx: Ctx): void {
  const coverage = sms.command("coverage").description("Per-country messaging coverage: sender types, registration rules, two-way support");

  coverage
    .command("list")
    .alias("ls")
    .description("List destination countries and their sending rules")
    .option("--search <text>", "country name, ISO code or dial code")
    .option("--region <name>", "exact region name, e.g. \"Western Europe\"")
    .option("--two-way", "only countries where recipients can reply")
    .option("--no-two-way", "only countries without (known) two-way support")
    .option("--registration-required", "only countries that require sender registration")
    .option("--no-registration-required", "only countries that require no registration")
    .addHelpText("after", "\nExamples:\n  vobiz sms coverage list --search united\n  vobiz sms coverage list --region \"Western Europe\" --two-way")
    .action(async (o: { search?: string; region?: string; twoWay?: boolean; registrationRequired?: boolean }) => {
      await simpleList(ctx, COVERAGE, { query: { q: o.search, region: o.region, twoWay: o.twoWay, registrationRequired: o.registrationRequired } }, "countries", {
        columns: ["country", "name", "region", "dialCode", "twoWay", "optOutMandatory", "hasSendWindow"],
        idKey: "country",
      });
    });

  coverage
    .command("get")
    .description("Show the full coverage record of one country")
    .argument("<country>", "ISO country code, e.g. GB")
    .action(async (c: string) => {
      ctx.out.print(await ctx.client.call(COVERAGE_GET, { path: { country: country(c) } }));
    });
}

export function registerNumbersAndCoverage(sms: Command, ctx: Ctx): void {
  registerNumbers(sms, ctx);
  registerCoverage(sms, ctx);
}
