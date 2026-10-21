/**
 * `vobiz numbers`: voice phone numbers (DIDs) on the account: list, look up, search the inventory, buy, release,
 * cancel a release, health, and routing to a SIP trunk or a sub-account. (SMS numbers live under `vobiz sms numbers`.)
 *
 * Purchases and releases spend money: `buy` looks the number up in the inventory first and shows its setup and
 * monthly fee before asking; `release` explains the release fee and the 24-hour cancellable cooldown.
 */
import type { Command } from "commander";
import { Option } from "commander";
import type { Ctx } from "../core/context.js";
import { VobizError, usage } from "../core/errors.js";
import { op } from "../core/ops.js";
import { digitsOnly, toE164 } from "../core/phone.js";
import { addListOptions, confirmedCall, examples, runList } from "./provisioning-shared.js";

const LIST = op("voice:list-numbers");
const RELEASE = op("unrent-number");
const CANCEL_RELEASE = op("cancel-number-release");
const HEALTH = op("get-number-health");
const INVENTORY = op("list-inventory-numbers");
const PURCHASE = op("purchase-from-inventory");
const ASSIGN_TRUNK = op("assign-number-to-trunk");
const UNASSIGN_TRUNK = op("unassign-number-from-trunk");
const ASSIGN_SUB = op("assign-did-to-subaccount");
const UNASSIGN_SUB = op("unassign-did-from-subaccount");

const NUMBER_COLUMNS = ["e164", "country", "region", "status", "monthly_fee", "currency", "trunk_group_id", "application_id"];
const INVENTORY_COLUMNS = ["e164", "country", "region", "setup_fee", "monthly_fee", "currency"];

interface NumberRecord {
  e164?: string;
  country?: string;
  region?: string;
  setup_fee?: number;
  monthly_fee?: number;
  currency?: string;
  [k: string]: unknown;
}

const items = (body: unknown): NumberRecord[] => {
  const v = body && typeof body === "object" ? (body as { items?: unknown }).items : undefined;
  return Array.isArray(v) ? (v as NumberRecord[]) : [];
};

/** One number on the account. There is no single-number endpoint: this is list-numbers filtered to an exact match. */
async function findOwnNumber(ctx: Ctx, e164: string): Promise<NumberRecord> {
  const body = await ctx.client.call(LIST, { query: { search: e164, per_page: 100 } });
  const hit = items(body).find((n) => n.e164 === e164);
  if (!hit) throw new VobizError("not_found", `${e164} is not a number on this account. Run \`vobiz numbers list\`.`);
  return hit;
}

/** One number in the purchasable inventory (a read the purchase depends on, so it runs even with --dry-run). */
async function findInventoryNumber(ctx: Ctx, e164: string): Promise<NumberRecord> {
  const body = await ctx.client.call(INVENTORY, { query: { search: digitsOnly(e164), per_page: 100 }, dryRun: false });
  const hit = items(body).find((n) => n.e164 === e164);
  if (!hit) throw new VobizError("not_found", `${e164} is not available in the inventory. Run \`vobiz numbers search\` to find one.`);
  return hit;
}

const money = (currency: string | undefined, amount: unknown) => `${currency ?? ""} ${amount ?? "?"}`.trim();

export function register(program: Command, ctx: Ctx): void {
  const numbers = program
    .command("numbers")
    .description("Voice phone numbers: list, search the inventory, buy, release, route to a trunk or sub-account");

  addListOptions(
    numbers
      .command("list")
      .alias("ls")
      .description("List the phone numbers on your account")
      .option("--search <digits>", "only numbers containing these digits (E.164, e.g. +9180)"),
  )
    .addHelpText("after", examples("vobiz numbers list", "vobiz numbers list --search +9180 --all", "vobiz numbers list --json"))
    .action(async (opts: { search?: string; limit?: number; all?: boolean }) => {
      await runList(ctx, LIST, { query: { search: opts.search } }, opts, { columns: NUMBER_COLUMNS, idKey: "e164", empty: "No numbers on this account. Run `vobiz numbers search`." });
    });

  numbers
    .command("get")
    .argument("<e164>", "phone number in E.164, e.g. +919876543210")
    .description("Show one number on your account (looks it up in `numbers list`; there is no single-number endpoint)")
    .action(async (number: string) => {
      ctx.out.print(await findOwnNumber(ctx, toE164(number)));
    });

  addListOptions(
    numbers
      .command("search")
      .description("Search the inventory for numbers you can buy, with their setup and monthly fees")
      .option("--country <code>", "ISO country code, e.g. IN or US")
      .option("--contains <digits>", "digits the number must contain, e.g. 80 (matches +918065…)")
      .option("--exclude <prefixes>", "E.164 prefixes to leave out, comma-separated (e.g. 9180,9192)"),
  )
    .addHelpText("after", examples("vobiz numbers search --country IN --contains 80", "vobiz numbers search --country US --exclude 1415 --limit 10"))
    .action(async (opts: { country?: string; contains?: string; exclude?: string; limit?: number; all?: boolean }) => {
      const query = { country: opts.country?.toUpperCase(), search: opts.contains, exclude: opts.exclude };
      await runList(ctx, INVENTORY, { query }, opts, { columns: INVENTORY_COLUMNS, idKey: "e164", empty: "No inventory numbers match." });
    });

  numbers
    .command("buy")
    .argument("<e164>", "inventory number to buy, in E.164")
    .description("Buy a number from the inventory (shows the setup and monthly fee, then asks)")
    .option("--currency <code>", "currency to bill in (default: the number's currency)")
    .option("--trunk <trunk-id>", "assign the number to this SIP trunk after the purchase")
    .addHelpText(
      "after",
      examples("vobiz numbers search --country IN", "vobiz numbers buy +918065550100", "vobiz numbers buy +918065550100 --trunk <trunk-id> --yes") +
        "\n\nSub-accounts (SA_…) are billed to the parent main account.",
    )
    .action(async (number: string, opts: { currency?: string; trunk?: string }) => {
      const e164 = toE164(number);
      const n = await findInventoryNumber(ctx, e164);
      const currency = opts.currency?.toUpperCase() ?? n.currency;
      const details: Record<string, string> = { number: e164, location: [n.region, n.country].filter(Boolean).join(", ") || "unknown", account: ctx.client.authId };
      if (ctx.client.authId.startsWith("SA_")) details.billed_to = "the parent main account";
      if (opts.trunk) details.trunk = opts.trunk;
      if (opts.currency && n.currency && opts.currency.toUpperCase() !== n.currency) details.note = `listed in ${n.currency}; billed in ${currency}`;
      const data = await confirmedCall<{ number?: NumberRecord; message?: string }>(
        ctx,
        { action: `Buy ${e164}`, details, cost: `${money(n.currency, n.setup_fee)} setup now, then ${money(n.currency, n.monthly_fee)}/month` },
        PURCHASE,
        { body: { e164, ...(opts.currency ? { currency: currency } : {}) } },
      );
      if (opts.trunk) {
        try {
          await ctx.client.call(ASSIGN_TRUNK, { path: { phone_number: e164 }, body: { trunk_group_id: opts.trunk }, sideEffect: true });
        } catch (err) {
          ctx.out.warn(`Bought ${e164}, but assigning it to trunk ${opts.trunk} failed. Retry with \`vobiz numbers assign ${e164} --trunk ${opts.trunk}\`.`);
          throw err;
        }
      }
      ctx.out.status(`Bought ${e164}${opts.trunk ? ` and assigned it to trunk ${opts.trunk}` : ""}.`);
      ctx.out.print(data?.number ?? data ?? { e164 });
    });

  numbers
    .command("release")
    .argument("<e164>", "number to release, in E.164")
    .description("Release a number (charges the release fee; cancellable for 24 hours unless --immediate)")
    .option("--immediate", "skip the 24-hour cooldown; the release can then NOT be cancelled")
    .addHelpText("after", examples("vobiz numbers release +919876543210", "vobiz numbers cancel-release +919876543210"))
    .action(async (number: string, opts: { immediate?: boolean }) => {
      const e164 = toE164(number);
      const data = await confirmedCall<{ status?: string; cooldown_ends_at?: string; release_fee?: number }>(
        ctx,
        {
          action: `Release ${e164}${opts.immediate ? " IMMEDIATELY" : ""}`,
          details: {
            account: ctx.client.authId,
            mode: opts.immediate
              ? "immediate: cannot be cancelled; any trunk or application on it is detached"
              : "24-hour cooldown: cancel with `vobiz numbers cancel-release` for a full refund of the fee",
          },
          cost: "the release fee configured for your account (the amount is returned in the response)",
        },
        RELEASE,
        { path: { e164 }, query: opts.immediate ? { immediate: true } : {} },
      );
      ctx.out.success(
        `Release of ${e164} started${data?.status ? ` (${data.status}` + (data.cooldown_ends_at ? ` until ${data.cooldown_ends_at}` : "") + ")" : ""}${data?.release_fee !== undefined ? `; release fee ${data.release_fee}` : ""}.`,
        data ?? { e164, released: true },
      );
    });

  numbers
    .command("cancel-release")
    .argument("<e164>", "number in its 24-hour release cooldown, in E.164")
    .description("Cancel a pending release: the number returns to active and the release fee is refunded")
    .action(async (number: string) => {
      const e164 = toE164(number);
      const data = await confirmedCall<{ refund_amount?: number; currency?: string }>(
        ctx,
        { action: `Cancel the release of ${e164}`, details: { account: ctx.client.authId, note: "trunks or applications detached by the release are not re-attached" } },
        CANCEL_RELEASE,
        { path: { e164 } },
      );
      ctx.out.success(`${e164} is active again${data?.refund_amount !== undefined ? `; refunded ${money(data.currency, data.refund_amount)}` : ""}.`, data ?? { e164, status: "active" });
    });

  numbers
    .command("health")
    .argument("<e164>", "number on your account, in E.164")
    .description("Show the health dashboard of a number: status, spam flag, answer rate and call volume")
    .addOption(new Option("--granularity <unit>", "snapshot granularity").choices(["daily", "hourly"]))
    .option("--days <n>", "window size in days (default: 30)", (v: string) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw usage(`--days must be a positive integer (got "${v}").`);
      return n;
    })
    .action(async (number: string, opts: { granularity?: string; days?: number }) => {
      const e164 = toE164(number);
      const data = await ctx.client.call(HEALTH, { path: { e164 }, query: { granularity: opts.granularity, days: opts.days } });
      ctx.out.print(data);
    });

  numbers
    .command("assign")
    .argument("<e164>", "number on your account, in E.164")
    .description("Route a number's inbound calls to a SIP trunk")
    .requiredOption("--trunk <trunk-id>", "trunk ID (see `vobiz trunks list`)")
    .addHelpText("after", examples("vobiz numbers assign +919876543210 --trunk e3e55a78-1234-5678-90ab-cdef12345678"))
    .action(async (number: string, opts: { trunk: string }) => {
      const e164 = toE164(number);
      await confirmedCall(ctx, { action: `Route inbound calls for ${e164} to trunk ${opts.trunk}` }, ASSIGN_TRUNK, {
        path: { phone_number: e164 },
        body: { trunk_group_id: opts.trunk },
      });
      ctx.out.success(`${e164} is assigned to trunk ${opts.trunk}.`, { e164, trunk_group_id: opts.trunk, assigned: true });
    });

  numbers
    .command("unassign")
    .argument("<e164>", "number on your account, in E.164")
    .description("Remove a number from its SIP trunk (the number stays on your account)")
    .action(async (number: string) => {
      const e164 = toE164(number);
      await confirmedCall(ctx, { action: `Remove ${e164} from its SIP trunk`, details: { effect: "inbound calls stop routing through the trunk" } }, UNASSIGN_TRUNK, {
        path: { phone_number: e164 },
      });
      ctx.out.success(`${e164} is no longer assigned to a trunk.`, { e164, assigned: false });
    });

  numbers
    .command("assign-subaccount")
    .argument("<e164>", "number in the main account's pool, in E.164")
    .description("Give a number from the main account's pool to a sub-account")
    .requiredOption("--sub-account <SA_id>", "sub-account Auth ID, e.g. SA_XXXXXXXX")
    .action(async (number: string, opts: { subAccount: string }) => {
      const e164 = toE164(number);
      await confirmedCall(ctx, { action: `Assign ${e164} to sub-account ${opts.subAccount}` }, ASSIGN_SUB, {
        path: { e164 },
        body: { sub_account_id: opts.subAccount },
      });
      ctx.out.success(`${e164} is assigned to ${opts.subAccount}.`, { e164, sub_account_id: opts.subAccount, assigned: true });
    });

  numbers
    .command("unassign-subaccount")
    .argument("<e164>", "number assigned to a sub-account, in E.164")
    .description("Return a number to the main account's pool (refused during the 15-day cool-off after its last call)")
    .option("--force", "admin accounts only: bypass the 15-day cool-off (audited)")
    .action(async (number: string, opts: { force?: boolean }) => {
      const e164 = toE164(number);
      await confirmedCall(
        ctx,
        { action: `Return ${e164} to the main account's pool`, details: opts.force ? { force: "bypass the 15-day cool-off (admin only, audited)" } : undefined },
        UNASSIGN_SUB,
        { path: { e164 }, query: opts.force ? { force: true } : {} },
      );
      ctx.out.success(`${e164} is back in the main account's pool.`, { e164, assigned: false });
    });
}
