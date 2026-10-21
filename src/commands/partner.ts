/**
 * `vobiz partner`: the Partner API for resellers. Run it with partner credentials. Covers the partner profile and
 * dashboard, customer accounts (create, balance transfers, transactions, CDRs, numbers) and hosted KYC sessions.
 *
 * `accounts transfer-balance` moves real money from the partner balance to a customer, so it always confirms.
 */
import type { Command } from "commander";
import type { Ctx } from "../core/context.js";
import { usage } from "../core/errors.js";
import { op } from "../core/ops.js";
import {
  addBodyOptions,
  addListOptions,
  addQueryOptions,
  buildBody,
  buildQuery,
  confirmedCall,
  detailsFrom,
  examples,
  revealOnce,
  addSecretOptions,
  checkSecretFile,
  runList,
  urlHosts,
} from "./provisioning-shared.js";

type Opts = Record<string, unknown>;

const ME = op("get-partner-profile");
const DASHBOARD = op("get-partner-dashboard");
const ACCOUNTS = op("list-customer-accounts");
const CREATE_ACCOUNT = op("create-customer-account");
const TRANSFER = op("partner-transfer-balance");
const TRANSACTIONS = op("list-customer-transactions");
const CDRS = op("list-customer-cdrs");
const NUMBERS = op("list-customer-numbers");
const SESSIONS = op("list-kyc-sessions");
const CREATE_SESSION = op("create-kyc-session");
const GET_SESSION = op("get-kyc-session");
const REVOKE_SESSION = op("revoke-kyc-session");
const RESEND_SESSION = op("resend-kyc-session");

const CUSTOMER_ARG = ["<customer-auth-id>", "customer account Auth ID, e.g. MA_XXXXXXXX"] as const;

function registerAccounts(partner: Command, ctx: Ctx): void {
  const accounts = partner.command("accounts").description("Customer accounts under your partner account");

  const list = addListOptions(accounts.command("list").alias("ls").description("List your customer accounts"));
  const listQ = addQueryOptions(list, ACCOUNTS);
  list.action(async (opts: Opts) => {
    await runList(ctx, ACCOUNTS, { query: buildQuery(ctx, opts, listQ) }, opts, {
      columns: ["auth_id", "name", "email", "company", "country", "cash_credits", "billing_mode"],
      idKey: "auth_id",
      itemsKey: "accounts",
      empty: "No customer accounts.",
    });
  });

  const create = accounts.command("create").description("Create a customer account (Vobiz emails the customer)");
  const createSpec = addBodyOptions(create, CREATE_ACCOUNT);
  addSecretOptions(create, "customer Auth Token");
  create.addHelpText("after", examples("vobiz partner accounts create --name 'Jane Doe' --email jane@example.com --phone +919876543210 --country IN   # prompts for the password"));
  create.action(async (opts: Opts) => {
    checkSecretFile(opts);
    const body = await buildBody(ctx, opts, createSpec, CREATE_ACCOUNT);
    const data = await confirmedCall<Record<string, unknown>>(
      ctx,
      { action: "Create a customer account", details: detailsFrom(body, ["name", "email", "phone", "company", "country"]) },
      CREATE_ACCOUNT,
      { body },
    );
    revealOnce(ctx, data, ["auth_token"], "customer Auth Token", opts, body);
    ctx.out.status(`Created customer account${data?.auth_id ? ` ${String(data.auth_id)}` : ""}.`);
    ctx.out.print(data ?? {});
  });

  const transfer = accounts
    .command("transfer-balance")
    .argument(...CUSTOMER_ARG)
    .description("Move balance from your partner account to a customer account (debits you immediately)");
  const transferSpec = addBodyOptions(transfer, TRANSFER);
  transfer.addHelpText("after", examples("vobiz partner accounts transfer-balance MA_XXXXXXXX --amount 500 --currency INR --description 'April recharge'"));
  transfer.action(async (customer: string, opts: Opts) => {
    const body = await buildBody(ctx, opts, transferSpec, TRANSFER);
    if (typeof body.amount === "number" && !(body.amount > 0)) throw usage("--amount must be greater than 0.");
    const data = await confirmedCall(
      ctx,
      {
        action: `Transfer ${String(body.currency ?? "")} ${String(body.amount ?? "?")} to ${customer}`.replace(/\s+/g, " "),
        details: { from: `your partner balance (${ctx.client.authId})`, to: customer, ...detailsFrom(body, ["description"]) },
        cost: `${String(body.currency ?? "")} ${String(body.amount ?? "?")} debited from your partner balance now`.trim(),
      },
      TRANSFER,
      { path: { customer_auth_id: customer }, body },
    );
    ctx.out.status(`Transferred to ${customer}.`);
    ctx.out.print(data ?? { to_account: customer, ...body });
  });

  const tx = addListOptions(accounts.command("transactions").argument(...CUSTOMER_ARG).description("List a customer's transaction ledger"));
  const txQ = addQueryOptions(tx, TRANSACTIONS);
  tx.addHelpText("after", examples("vobiz partner accounts transactions MA_XXXXXXXX --from-date 30d --transaction-type transfer"));
  tx.action(async (customer: string, opts: Opts) => {
    await runList(ctx, TRANSACTIONS, { path: { customer_auth_id: customer }, query: buildQuery(ctx, opts, txQ) }, opts, {
      columns: ["created_at", "type", "amount", "currency", "status", "description"],
      itemsKey: "transactions",
      empty: "No transactions.",
    });
  });

  const cdrs = addListOptions(accounts.command("cdrs").argument(...CUSTOMER_ARG).description("List a customer's call detail records"));
  const cdrQ = addQueryOptions(cdrs, CDRS);
  cdrs.addHelpText("after", examples("vobiz partner accounts cdrs MA_XXXXXXXX --start-date yesterday --call-direction outbound"));
  cdrs.action(async (customer: string, opts: Opts) => {
    await runList(ctx, CDRS, { path: { customer_auth_id: customer }, query: buildQuery(ctx, opts, cdrQ) }, opts, {
      columns: ["created_at", "call_direction", "caller_id_number", "destination_number", "duration", "hangup_cause", "cost"],
      itemsKey: "data",
      empty: "No call records.",
    });
  });

  const nums = addListOptions(accounts.command("numbers").argument(...CUSTOMER_ARG).description("List a customer's phone numbers"));
  const numQ = addQueryOptions(nums, NUMBERS);
  nums.action(async (customer: string, opts: Opts) => {
    await runList(ctx, NUMBERS, { path: { customer_auth_id: customer }, query: buildQuery(ctx, opts, numQ) }, opts, {
      columns: ["e164", "country", "region", "status", "monthly_fee", "currency"],
      idKey: "e164",
      itemsKey: "items",
      empty: "No numbers.",
    });
  });
}

function registerKycSessions(partner: Command, ctx: Ctx): void {
  const sessions = partner.command("kyc-sessions").description("Hosted KYC sessions for your customers");

  const list = addListOptions(sessions.command("list").alias("ls").description("List KYC sessions"));
  const listQ = addQueryOptions(list, SESSIONS);
  list.action(async (opts: Opts) => {
    await runList(ctx, SESSIONS, { query: buildQuery(ctx, opts, listQ) }, opts, {
      columns: ["id", "account_auth_id", "status", "customer_email", "expires_at", "created_at"],
      itemsKey: "sessions",
      empty: "No KYC sessions.",
    });
  });

  sessions
    .command("get")
    .argument("<session-id>", "KYC session ID")
    .description("Show one KYC session")
    .action(async (id: string) => {
      ctx.out.print(await ctx.client.call(GET_SESSION, { path: { session_id: id } }));
    });

  const create = sessions.command("create").description("Start a KYC session: email the customer a link, or get a widget URL (--flow-type redirect)");
  const createSpec = addBodyOptions(create, CREATE_SESSION);
  create.addHelpText(
    "after",
    examples(
      "vobiz partner kyc-sessions create --account-auth-id MA_XXXXXXXX --customer-email jane@example.com",
      "vobiz partner kyc-sessions create --account-auth-id MA_XXXXXXXX --flow-type redirect --redirect-url https://example.com/kyc-done",
    ),
  );
  create.action(async (opts: Opts) => {
    const body = await buildBody(ctx, opts, createSpec, CREATE_SESSION);
    const data = await confirmedCall(
      ctx,
      {
        action: `Start a KYC session for ${String(body.account_auth_id ?? "a customer")}`,
        details: { ...detailsFrom(body, ["flow_type", "customer_email", "expires_in_days"]), ...urlHosts(body) },
      },
      CREATE_SESSION,
      { body },
    );
    ctx.out.print(data ?? {});
  });

  sessions
    .command("revoke")
    .argument("<session-id>", "KYC session ID")
    .description("Revoke a KYC session so its link stops working")
    .option("--reason <text>", "why the session is revoked (sent as the optional DELETE body)")
    .action(async (id: string, o: { reason?: string }) => {
      const details: Record<string, string> = { effect: "the customer can no longer use the link" };
      if (o.reason) details.reason = o.reason;
      const data = await confirmedCall(ctx, { action: `Revoke KYC session ${id}`, details }, REVOKE_SESSION, {
        path: { session_id: id },
        ...(o.reason ? { body: { reason: o.reason } } : {}),
      });
      ctx.out.success(`Revoked KYC session ${id}.`, data ?? { session_id: id, revoked: true });
    });

  sessions
    .command("resend")
    .argument("<session-id>", "KYC session ID")
    .description("Email the KYC link to the customer again")
    .action(async (id: string) => {
      const data = await confirmedCall(ctx, { action: `Resend the KYC email for session ${id}` }, RESEND_SESSION, { path: { session_id: id } });
      ctx.out.success(`Resent the KYC email for session ${id}.`, data ?? { session_id: id, resent: true });
    });
}

export function register(program: Command, ctx: Ctx): void {
  const partner = program
    .command("partner")
    .description("Partner API (resellers): profile, dashboard, customer accounts and KYC sessions")
    .addHelpText("after", examples("vobiz partner me", "vobiz partner accounts list --search acme", "vobiz partner kyc-sessions list --status in_progress"));

  partner
    .command("me")
    .description("Show your partner profile and balance")
    .action(async () => {
      ctx.out.print(await ctx.client.call(ME));
    });

  partner
    .command("dashboard")
    .description("Show partner totals: customers, pending KYC, balance held and month-to-date revenue")
    .action(async () => {
      ctx.out.print(await ctx.client.call(DASHBOARD));
    });

  registerAccounts(partner, ctx);
  registerKycSessions(partner, ctx);
}
