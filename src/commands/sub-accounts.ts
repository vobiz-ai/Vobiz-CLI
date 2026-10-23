/**
 * `vobiz sub-accounts`: sub-accounts (SA_…) under the main account, and their KYC.
 *
 * KYC commands call the live verification endpoints by default. `--test` (on `kyc`, accepted anywhere after it)
 * switches to the Test Mode endpoints (`/sub-accounts/test/…`), which return mock results and never contact a
 * verification provider; `finalize-pending` exists only in Test Mode.
 */
import type { Command } from "commander";
import type { Ctx } from "../core/context.js";
import { REDACTED } from "../core/redact.js";
import { VobizError } from "../core/errors.js";
import { op } from "../core/ops.js";
import type { Operation } from "../generated/operations.js";
import { addBodyOptions, buildBody, confirmedCall, crud, detailsFrom, examples, urlHosts } from "./provisioning-shared.js";

type Opts = Record<string, unknown>;

/** create-subaccount also returns login session tokens; the CLI never prints them. */
function dropSessionTokens(data: Record<string, unknown>): unknown {
  const tokens = data.tokens;
  if (!tokens || typeof tokens !== "object") return data;
  const masked: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tokens as Record<string, unknown>)) masked[k] = /token$/i.test(k) && v ? REDACTED : v;
  return { ...data, tokens: masked };
}

interface KycLeaf {
  name: string;
  description: string;
  live?: Operation;
  test?: Operation;
  /** Confirmation line, e.g. "Verify the PAN of". */
  action: string;
  summaryKeys: string[];
  example?: string;
  /** Fills body fields from the sub-account id when not given. */
  defaults?: (sa: string) => Opts;
}

function kycLeaf(parent: Command, ctx: Ctx, leaf: KycLeaf): void {
  const ops = [leaf.live, leaf.test].filter((o): o is Operation => !!o);
  const cmd = parent.command(leaf.name).argument("<sub-auth-id>", "sub-account Auth ID, e.g. SA_XXXXXXXX").description(leaf.description);
  const spec = addBodyOptions(cmd, ops);
  if (leaf.example) cmd.addHelpText("after", examples(leaf.example));
  cmd.action(async (sa: string, opts: Opts, self: Command) => {
    const test = !!self.optsWithGlobals().test;
    const chosen = test ? leaf.test : leaf.live;
    if (!chosen)
      throw new VobizError(
        "invalid_input",
        test ? `\`kyc ${leaf.name}\` has no Test Mode variant; run it without --test.` : `\`kyc ${leaf.name}\` exists only in Test Mode; add --test.`,
      );
    const withDefaults = opts.body === undefined && leaf.defaults ? { ...opts, ...Object.fromEntries(Object.entries(leaf.defaults(sa)).filter(([k]) => opts[k] === undefined)) } : opts;
    const body = await buildBody(ctx, withDefaults, spec, chosen);
    const data = await confirmedCall(
      ctx,
      {
        action: `${leaf.action} sub-account ${sa}${test ? " (TEST MODE)" : ""}`,
        details: {
          mode: test ? "Test Mode: mock result, no verification provider is contacted" : "live verification",
          ...detailsFrom(body, leaf.summaryKeys),
          ...urlHosts(body),
        },
      },
      chosen,
      { path: { sub_auth_id: sa }, body },
    );
    ctx.out.print(data ?? { sub_auth_id: sa, ok: true });
  });
}

function registerKyc(subAccounts: Command, ctx: Ctx): void {
  const kyc = subAccounts
    .command("kyc")
    .description("Sub-account KYC: status, PAN/GST/CIN/DigiLocker verification and hosted KYC sessions")
    .option("--test", "use the Test Mode endpoints (mock results; nothing is sent to a verification provider)")
    .addHelpText(
      "after",
      examples(
        "vobiz sub-accounts kyc status SA_XXXXXXXX",
        "vobiz sub-accounts kyc verify-pan SA_XXXXXXXX --pan ABCDE1234F",
        "vobiz sub-accounts kyc --test verify-pan SA_XXXXXXXX --pan ABCDE1234F",
        "vobiz sub-accounts kyc --test finalize-pending SA_XXXXXXXX --verification-type pan --outcome verified",
        "vobiz sub-accounts kyc session create SA_XXXXXXXX --flow-type email --customer-email owner@example.com",
      ),
    );

  const STATUS = op("get-subaccount-kyc-status");
  kyc
    .command("status")
    .argument("<sub-auth-id>", "sub-account Auth ID, e.g. SA_XXXXXXXX")
    .description("Show the KYC status of a sub-account (overall and per verification)")
    .action(async (sa: string, _opts: Opts, self: Command) => {
      if (self.optsWithGlobals().test) throw new VobizError("invalid_input", "`kyc status` has no Test Mode variant; run it without --test.");
      ctx.out.print(await ctx.client.call(STATUS, { path: { sub_auth_id: sa } }));
    });

  kycLeaf(kyc, ctx, {
    name: "verify-pan",
    description: "Verify a PAN for a sub-account",
    live: op("verify-subaccount-pan"),
    test: op("mock-verify-subaccount-pan"),
    action: "Verify the PAN of",
    summaryKeys: ["pan"],
    example: "vobiz sub-accounts kyc verify-pan SA_XXXXXXXX --pan ABCDE1234F",
  });
  kycLeaf(kyc, ctx, {
    name: "verify-gst",
    description: "Verify a GSTIN for a sub-account",
    live: op("verify-subaccount-gst"),
    test: op("mock-verify-subaccount-gst"),
    action: "Verify the GSTIN of",
    summaryKeys: ["gstin"],
  });

  const cin = kyc.command("cin").description("Company (CIN) verification: search by name, then confirm a match");
  kycLeaf(cin, ctx, {
    name: "search",
    description: "Search company registrations by name",
    live: op("search-subaccount-cin"),
    test: op("mock-search-subaccount-cin"),
    action: "Search CINs for",
    summaryKeys: ["company_name"],
    example: "vobiz sub-accounts kyc cin search SA_XXXXXXXX --company-name 'Acme Private Limited'",
  });
  kycLeaf(cin, ctx, {
    name: "confirm",
    description: "Confirm the company (CIN) chosen from `cin search`",
    live: op("confirm-subaccount-cin"),
    test: op("mock-confirm-subaccount-cin"),
    action: "Confirm the CIN of",
    summaryKeys: ["company_name", "selected_cin"],
  });

  const digilocker = kyc.command("digilocker").description("Aadhaar verification through DigiLocker: initiate, then verify");
  kycLeaf(digilocker, ctx, {
    name: "initiate",
    description: "Start a DigiLocker consent flow and get the URL to send the customer to",
    live: op("subaccount-digilocker-initiate"),
    test: op("mock-subaccount-digilocker-initiate"),
    action: "Start DigiLocker verification for",
    summaryKeys: ["redirect_url"],
  });
  kycLeaf(digilocker, ctx, {
    name: "verify",
    description: "Complete DigiLocker verification with the access request ID (Test Mode: MOCK_AR_SUCCESS or MOCK_AR_FAIL)",
    live: op("subaccount-digilocker-verify"),
    test: op("mock-subaccount-digilocker-verify"),
    action: "Complete DigiLocker verification for",
    summaryKeys: ["access_request_id"],
  });

  kycLeaf(kyc, ctx, {
    name: "finalize-pending",
    description: "Test Mode only: resolve a pending verification as verified or failed",
    test: op("mock-finalize-pending-kyc"),
    action: "Finalize a pending verification of",
    summaryKeys: ["verification_type", "outcome"],
  });

  const session = kyc.command("session").description("Vobiz-hosted KYC sessions for a sub-account");
  kycLeaf(session, ctx, {
    name: "create",
    description: "Create a hosted KYC session (emails the customer a link, or returns a widget URL with --flow-type redirect)",
    live: op("create-subaccount-kyc-session"),
    action: "Create a hosted KYC session for",
    summaryKeys: ["account_auth_id", "flow_type", "customer_email", "expires_in_days"],
    defaults: (sa) => ({ accountAuthId: sa }),
    example: "vobiz sub-accounts kyc session create SA_XXXXXXXX --flow-type redirect --redirect-url https://example.com/kyc-done",
  });
}

export function register(program: Command, ctx: Ctx): void {
  const subAccounts = program
    .command("sub-accounts")
    .description("Sub-accounts (SA_…) under your main account, and their KYC")
    .addHelpText(
      "after",
      examples(
        "vobiz sub-accounts list",
        "vobiz sub-accounts create --name 'Acme Corp' --kyc-mode customer_use --email owner@example.com",
        "vobiz sub-accounts update SA_XXXXXXXX --name 'Acme Ltd'",
        "vobiz sub-accounts kyc status SA_XXXXXXXX",
      ),
    );

  crud(subAccounts, ctx, {
    noun: "sub-account",
    idArg: "sub-auth-id",
    idKey: "auth_id",
    idParam: "sub_auth_id",
    columns: ["auth_id", "name", "email", "enabled", "is_active", "created_at"],
    list: op("list-subaccounts"),
    get: op("retrieve-subaccount"),
    create: op("create-subaccount"),
    update: op("update-subaccount"),
    delete: op("delete-subaccount"),
    summaryKeys: ["name", "email", "kyc_mode", "business_type", "is_active"],
    // The API ignores `enabled`; `is_active` is the field it honours (live 2026-10-22).
    aliases: [
      { flag: "active", to: "is_active", boolean: true, description: "activate or deactivate the sub-account" },
      { flag: "enabled", to: "is_active", boolean: true, deprecated: true, use: "active", description: "the API ignores enabled, so this sets is_active" },
    ],
    updateWarning: (body) =>
      body.is_active === false
        ? "a deactivated sub-account disappears from list, get, update and delete (they answer 404), so it cannot be reactivated through the API"
        : undefined,
    secretPaths: ["auth_credentials.auth_token", "sub_account.auth_token"],
    secretLabel: "sub-account Auth Token",
    createdIdPath: "sub_account.auth_id",
    sanitizeCreated: dropSessionTokens,
    createExamples: ["vobiz sub-accounts create --name 'Acme Corp' --kyc-mode personal_use"],
  });

  registerKyc(subAccounts, ctx);
}
