/**
 * `vobiz account`: profile details, balance, concurrency, the transaction ledger, and CPS/concurrency capacity
 * (preview the monthly price, then purchase a subscription after confirming the price).
 */
import { Option, type Command } from "commander";
import { requireConfirmation } from "../core/confirm.js";
import type { Ctx } from "../core/context.js";
import { usage } from "../core/errors.js";
import { op } from "../core/ops.js";
import { paginate } from "../core/pagination.js";
import { parseRange, toYmd } from "../core/time.js";
import { addListFlags, intArg, isRec, printPage, type ListFlags, type Rec } from "./voice-shared.js";

const RETRIEVE_ACCOUNT = op("retrieve-account");
const GET_BALANCE = op("get-balance");
const GET_CONCURRENCY = op("get-concurrency");
const LIST_TRANSACTIONS = op("list-transactions");
const LIST_REFERENCE_TYPES = op("list-transaction-reference-types");
const PREVIEW_PRICING = op("preview-channel-pricing");
const CREATE_SUBSCRIPTION = op("create-channel-subscription");

const RESOURCE_TYPES = ["concurrent_calls", "cps"];

const resourceOption = () =>
  new Option("--type <resource>", "capacity to price: concurrent_calls or cps").choices(RESOURCE_TYPES).makeOptionMandatory();
const quantityOption = () => new Option("--quantity <n>", "capacity quantity (1-10000)").argParser(intArg(1, 10_000)).makeOptionMandatory();

function describePrice(p: Rec | undefined): string | undefined {
  if (!isRec(p) || p.monthly_cost === undefined) return undefined;
  return `${p.currency ?? ""} ${p.monthly_cost} now, then every 30 days`.trim();
}

interface TxOpts extends ListFlags {
  from?: string;
  to?: string;
  type?: string;
  status?: string;
  currency?: string;
  referenceType?: string;
  description?: string;
  reference?: string;
  transactionId?: string;
}

export function register(program: Command, ctx: Ctx): void {
  const account = program.command("account").description("Account details, balance, concurrency, transactions and capacity");

  account
    .command("show")
    .description("Show the account profile (name, limits, pricing tier)")
    .action(async () => {
      ctx.out.print(await ctx.client.call(RETRIEVE_ACCOUNT));
    });

  account
    .command("balance")
    .description("Show the account balance (in the pricing tier's currency unless --currency is given)")
    .option("--currency <code>", "currency code, e.g. INR or USD")
    .addHelpText("after", "\nExamples:\n  vobiz account balance\n  vobiz account balance --currency USD --json")
    .action(async (opts: { currency?: string }) => {
      let currency = opts.currency?.trim().toUpperCase();
      if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw usage(`--currency must be a 3-letter code such as INR (got "${opts.currency}").`);
      if (!currency) {
        const me = await ctx.client.call<Rec>(RETRIEVE_ACCOUNT, { dryRun: false });
        const tier = isRec(me?.pricing_tier) ? me.pricing_tier : undefined;
        currency = typeof tier?.currency === "string" && tier.currency ? tier.currency.toUpperCase() : "INR";
      }
      const bal = await ctx.client.call<Rec>(GET_BALANCE, { path: { currency } });
      ctx.out.print(bal);
    });

  account
    .command("concurrency")
    .description("Show concurrent calls in use and the account limit")
    .action(async () => {
      ctx.out.print(await ctx.client.call(GET_CONCURRENCY));
    });

  const tx = account.command("transactions").description("The account ledger: debits, credits and their reference types");

  addListFlags(
    tx
      .command("list")
      .alias("ls")
      .description("List transactions, newest first")
      .option("--from <when>", "start of the window (today, yesterday, 7d, 2026-10-01 or ISO)")
      .option("--to <when>", "end of the window, inclusive")
      .option("--type <type>", "credit, debit, or an exact transaction type")
      .addOption(new Option("--status <status>", "transaction status").choices(["completed", "pending", "failed", "cancelled"]))
      .option("--currency <code>", "currency code")
      .option("--reference-type <type>", "reference type (see `vobiz account transactions types`)")
      .option("--description <text>", "match on the description")
      .option("--reference <ref>", "match on the reference, e.g. cdr:<uuid>")
      .option("--transaction-id <id>", "one transaction by id"),
    20,
  )
    .addHelpText("after", "\nExamples:\n  vobiz account transactions list --from 7d\n  vobiz account transactions list --type debit --reference-type cdr --all --output tsv")
    .action(async (o: TxOpts) => {
      const range = parseRange(o.from, o.to, ctx.now());
      const query = {
        from_date: range.from ? toYmd(range.from) : undefined,
        to_date: range.to ? toYmd(range.to) : undefined,
        type: o.type,
        status: o.status,
        currency: o.currency?.toUpperCase(),
        reference_type: o.referenceType,
        description: o.description,
        reference: o.reference,
        transaction_id: o.transactionId,
      };
      const page = await paginate(ctx.client, LIST_TRANSACTIONS, { query }, { limit: o.limit ?? 20, all: o.all, itemsKey: "transactions" });
      printPage(ctx, page, {
        itemsKey: "transactions",
        columns: ["created_at", "type", "amount", "currency", "status", "reference_type", "description"],
        idKey: "id",
        empty: "No transactions in this window.",
      });
    });

  tx.command("types")
    .description("List the reference types present on the ledger (values for --reference-type)")
    .action(async () => {
      const body = await ctx.client.call<Rec>(LIST_REFERENCE_TYPES);
      const mode = ctx.out.mode;
      if (mode === "json" || mode === "yaml") ctx.out.print(body);
      else ctx.out.print(Array.isArray(body?.reference_types) ? body.reference_types : [], { empty: "No reference types." });
    });

  account
    .command("channel-pricing")
    .description("Preview the monthly price of CPS or concurrent-call capacity (nothing is charged)")
    .addOption(resourceOption())
    .addOption(quantityOption())
    .addHelpText("after", "\nExample:\n  vobiz account channel-pricing --type concurrent_calls --quantity 30")
    .action(async (o: { type: string; quantity: number }) => {
      ctx.out.print(await ctx.client.call(PREVIEW_PRICING, { query: { resource_type: o.type, quantity: o.quantity } }));
    });

  const subs = account.command("channel-subscriptions").description("Recurring CPS or concurrent-call capacity");
  subs
    .command("create")
    .description("Purchase CPS or concurrency capacity (debits the first month now, renews every 30 days)")
    .addOption(resourceOption())
    .addOption(quantityOption())
    .addHelpText("after", "\nExample:\n  vobiz account channel-subscriptions create --type cps --quantity 5 --yes")
    .action(async (o: { type: string; quantity: number }) => {
      const preview = await ctx.client.call<Rec>(PREVIEW_PRICING, { query: { resource_type: o.type, quantity: o.quantity }, dryRun: false });
      await requireConfirmation(ctx, {
        action: `Purchase ${o.quantity} ${o.type === "cps" ? "CPS" : "concurrent calls"} of capacity for ${ctx.creds.authId}`,
        details: { resource_type: o.type, quantity: String(o.quantity), renews: "every 30 days until cancelled" },
        cost: describePrice(preview) ?? "price not returned by the preview",
      });
      const sub = await ctx.client.call<Rec>(CREATE_SUBSCRIPTION, { body: { resource_type: o.type, quantity: o.quantity }, sideEffect: true });
      ctx.out.success(`Purchased ${o.quantity} ${o.type}${isRec(sub) && sub.id ? ` (subscription ${sub.id})` : ""}.`, sub);
    });
}
