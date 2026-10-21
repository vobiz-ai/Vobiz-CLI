/**
 * `vobiz sms 10dlc brands|campaigns|documents …`: US 10DLC and toll-free registration. Common fields have flags;
 * anything else (nested objects, rarely used fields) goes in `--body` as JSON and flags override it.
 * Brand and campaign updates are full replacements on the API side, so the confirmation says so.
 */
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { Option, type Command } from "commander";
import type { BytesResponse } from "../../core/client.js";
import { requireConfirmation } from "../../core/confirm.js";
import type { Ctx } from "../../core/context.js";
import { usage } from "../../core/errors.js";
import { op } from "../../core/ops.js";
import {
  addFields,
  bodyWithFlags,
  collect,
  deleteWithBody,
  fieldValues,
  fileForm,
  humanSize,
  intArg,
  listCommand,
  printResult,
  requireKeys,
  simpleList,
  type Field,
  type ListFlags,
  type Rec,
} from "./shared.js";

const B = {
  list: op("list-brands"),
  create: op("create-brand"),
  get: op("get-brand"),
  update: op("update-brand"),
  delete: op("delete-brand"),
  register: op("register-brand"),
  statuses: op("brand-registrar-statuses"),
  authVerify: op("brand-auth-verification"),
  resend2fa: op("resend-2fa"),
  vet: op("vet-brand"),
  vets: op("list-brand-vets"),
};
const C = {
  list: op("list-campaigns"),
  create: op("create-campaign"),
  tollFree: op("create-toll-free-campaign"),
  priorities: op("campaign-priorities"),
  get: op("get-campaign"),
  update: op("update-campaign"),
  delete: op("delete-campaign"),
  register: op("register-campaign"),
  deregister: op("deregister-campaign"),
  appeal: op("appeal-campaign"),
  updateRegistration: op("update-campaign-registration"),
  networkStatuses: op("campaign-network-statuses"),
  numbers: op("list-campaign-numbers"),
  addNumbers: op("add-campaign-numbers"),
  removeNumbers: op("remove-campaign-numbers"),
};
const D = { upload: op("upload-document"), get: op("get-document") };

const enumOf = (o: typeof B.create, key: string) => o.body.props.find((p) => p.name === key)?.enum?.map(String);
const ENTITY_TYPES = ["PRIVATE_COMPANY", "PUBLIC_COMPANY", "NON_PROFIT", "GOVERNMENT", "SOLE_PROPRIETOR"];
const REG_TYPES = ["VAT", "CBN", "PROVINCIAL_NUMBER", "ABN", "SIREN", "NZBN", "CIF", "CNPJ", "OTHER"];

const BRAND_FIELDS: Field[] = [
  { flag: "--name <name>", key: "name", desc: "display name customers know you by (required)" },
  { flag: "--brand-type <type>", key: "brandType", desc: "kind of business (required)", choices: enumOf(B.create, "brandType") },
  { flag: "--legal-name <name>", key: "legalName", desc: "registered legal name, as on tax records" },
  { flag: "--website <url>", key: "website", desc: "live business website" },
  { flag: "--support-email <email>", key: "supportEmail", desc: "support email address" },
  { flag: "--support-phone <e164>", key: "supportPhone", desc: "support phone number", kind: "e164" },
  { flag: "--vertical <industry>", key: "vertical", desc: "industry, e.g. TECHNOLOGY, HEALTHCARE, RETAIL" },
  { flag: "--tax-id <id>", key: "taxId", desc: "tax identifier, e.g. the US EIN" },
  { flag: "--tax-id-country <code>", key: "taxIdIssuingCountry", desc: "ISO country that issued the tax id" },
  { flag: "--country <code>", key: "countryCode", desc: "ISO country where the business is registered" },
  { flag: "--address <address>", key: "address", desc: "postal address as on registration records" },
  { flag: "--contact-first-name <name>", key: "businessContactFirstName", desc: "business contact first name" },
  { flag: "--contact-last-name <name>", key: "businessContactLastName", desc: "business contact last name" },
  { flag: "--contact-email <email>", key: "businessContactEmail", desc: "business contact email (receives 2FA for public companies)" },
  { flag: "--dba <name>", key: "businessDba", desc: "doing-business-as name" },
  { flag: "--entity-type <type>", key: "legalEntityType", desc: "legal form of the business", choices: ENTITY_TYPES },
  { flag: "--registration-type <type>", key: "businessRegistrationType", desc: "registration number type for non-US businesses", choices: REG_TYPES },
  { flag: "--tax-exempt-status <status>", key: "taxExemptStatus", desc: "tax-exempt status (non-profits)" },
  { flag: "--stock-exchange <exchange>", key: "stockExchange", desc: "listing exchange (public companies), e.g. NASDAQ" },
  { flag: "--stock-symbol <symbol>", key: "stockSymbol", desc: "ticker symbol (public companies)" },
  { flag: "--alternate-business-id <json>", key: "alternateBusinessId", desc: "alternate business id object as JSON (only when the registry asks)", kind: "json" },
];
const REFERENCE: Field = { flag: "--reference-id <ref>", key: "referenceId", desc: "your idempotency reference: repeating a create with it returns the same record" };

const CAMPAIGN_FIELDS: Field[] = [
  { flag: "--name <name>", key: "name", desc: "campaign name (required)" },
  { flag: "--program-summary <text>", key: "programSummary", desc: "what you send, to whom, how often and how people opt in" },
  { flag: "--confirmation-message <text>", key: "confirmationMessage", desc: "message sent when someone opts in" },
  { flag: "--help-message <text>", key: "helpMessage", desc: "reply to HELP" },
  { flag: "--stop-message <text>", key: "stopMessage", desc: "reply to STOP" },
  { flag: "--care-phone <e164>", key: "customerCarePhone", desc: "customer care phone", kind: "e164" },
  { flag: "--care-email <email>", key: "customerCareEmail", desc: "customer care email" },
  { flag: "--terms-url <url>", key: "termsAndConditionsUrl", desc: "terms and conditions URL" },
  { flag: "--privacy-url <url>", key: "privacyPolicyUrl", desc: "privacy policy URL" },
  { flag: "--example <text>", key: "exampleMessages", desc: "sample message exactly as sent (repeatable)", kind: "list" },
  { flag: "--use-case <code>", key: "useCases", desc: "use-case code, e.g. TWO_FACTOR_AUTH, ALERTS (repeatable)", kind: "csv" },
  { flag: "--message-type <type>", key: "messageTypes", desc: "SMS and/or MMS (repeatable)", kind: "csv" },
  { flag: "--opt-ins <json>", key: "optIns", desc: "opt-in flows as a JSON object, @file or @-", kind: "json" },
  { flag: "--low-volume", key: "lowVolume", desc: "declare the campaign low volume", kind: "bool" },
  { flag: "--age-gated", key: "ageGated", desc: "content is restricted to adults", kind: "bool" },
  { flag: "--direct-lending", key: "directLending", desc: "content relates to direct lending", kind: "bool" },
  { flag: "--embedded-link", key: "embeddedLink", desc: "messages contain URLs", kind: "bool" },
  { flag: "--embedded-phone", key: "embeddedPhone", desc: "messages contain phone numbers", kind: "bool" },
  { flag: "--number <e164>", key: "numbers", desc: "number on your account to attach (repeatable)", kind: "digits" },
  { flag: "--document <id>", key: "supportingDocuments", desc: "documentId from `10dlc documents upload` (repeatable)", kind: "csv" },
  { flag: "--mms-sample <id>", key: "mmsSampleFiles", desc: "documentId of an MMS sample file (repeatable)", kind: "csv" },
];
const CAMPAIGN_CREATE_ONLY: Field[] = [
  { flag: "--brand <id>", key: "brandId", desc: "brand id that runs this campaign (required)" },
  { flag: "--type <type>", key: "campaignType", desc: "campaign type (default TEN_DIGIT_LONG_CODE)", choices: enumOf(C.create, "campaignType") },
  REFERENCE,
];

const TOLL_FREE_FIELDS: Field[] = [
  { flag: "--name <name>", key: "name", desc: "campaign name (required)" },
  REFERENCE,
  { flag: "--number <e164>", key: "numbers", desc: "toll-free number to verify (repeatable)", kind: "e164s" },
  { flag: "--number-key <key>", key: "numberKeys", desc: "registry number key, instead of --number (repeatable)", kind: "csv" },
  { flag: "--message-volume <volume>", key: "messageVolume", desc: "monthly volume, e.g. HUNDRED, TEN_THOUSAND, FIVE_MILLION" },
  { flag: "--use-case <code>", key: "useCase", desc: "main use case, e.g. TWO_FACTOR_AUTH, NOTIFICATIONS" },
  { flag: "--program-summary <text>", key: "programSummary", desc: "what you send, to whom and how people opt in" },
  { flag: "--example-message <text>", key: "exampleMessage", desc: "sample message exactly as sent" },
  { flag: "--opt-ins <json>", key: "optIns", desc: "opt-in flows as a JSON object, @file or @-", kind: "json" },
  { flag: "--opt-in-image <url>", key: "optInImageURLs", desc: "URL of an opt-in screenshot (repeatable)", kind: "list" },
  { flag: "--additional-info <text>", key: "additionalInformation", desc: "anything else the reviewer should know" },
  { flag: "--privacy-url <url>", key: "privacyPolicyUrl", desc: "privacy policy URL" },
  { flag: "--terms-url <url>", key: "termsAndConditionsUrl", desc: "terms and conditions URL" },
  { flag: "--legal-name <name>", key: "legalName", desc: "registered legal name" },
  { flag: "--business-name <name>", key: "businessName", desc: "name customers know you by" },
  { flag: "--dba <name>", key: "businessDBA", desc: "doing-business-as name" },
  { flag: "--website <url>", key: "businessWebsite", desc: "live business website" },
  { flag: "--country <code>", key: "countryCode", desc: "ISO country where the business is registered" },
  { flag: "--address <address>", key: "address", desc: "postal address" },
  { flag: "--support-phone <e164>", key: "supportPhone", desc: "support phone", kind: "e164" },
  { flag: "--support-email <email>", key: "supportEmail", desc: "support email" },
  { flag: "--care-email <email>", key: "customerCareEmail", desc: "customer care email" },
  { flag: "--contact-first-name <name>", key: "businessContactFirstName", desc: "business contact first name" },
  { flag: "--contact-last-name <name>", key: "businessContactLastName", desc: "business contact last name" },
  { flag: "--tax-id <id>", key: "taxId", desc: "tax identifier, e.g. the US EIN" },
  { flag: "--tax-id-country <code>", key: "taxIdIssuingCountry", desc: "ISO country that issued the tax id" },
  { flag: "--entity-type <type>", key: "legalEntityType", desc: "legal form of the business", choices: ENTITY_TYPES },
  { flag: "--registration-type <type>", key: "businessRegistrationType", desc: "registration number type for non-US businesses", choices: REG_TYPES },
  { flag: "--campaign-verify-token <token>", key: "campaignVerifyToken", desc: "Campaign Verify token (US political programs only)" },
  { flag: "--priority <id>", key: "priorityId", desc: "priority id from `10dlc campaigns priorities`" },
];

const BRAND_COLUMNS = ["id", "name", "brandType", "stage", "registrationStatus", "createdAt"];
const CAMPAIGN_COLUMNS = ["id", "name", "brandId", "campaignType", "stage", "createdAt"];
const BODY_HELP = "request body as JSON, @file.json or @-; flags override it";

function numbersBody(o: { number?: string[]; numberKey?: string[] }): Rec {
  const numbers = o.number?.map((n) => n.replace(/\D/g, ""));
  if (numbers?.some((n) => !/^[1-9]\d{6,14}$/.test(n))) throw usage("--number must be a phone number with country code, e.g. +14155550100.");
  if (!numbers?.length && !o.numberKey?.length) throw usage("Pass --number or --number-key (repeatable).");
  return { ...(numbers?.length ? { numbers } : {}), ...(o.numberKey?.length ? { numberKeys: o.numberKey } : {}) };
}

function numberOptions(cmd: Command): Command {
  return cmd
    .option("--number <e164>", "phone number on your account (repeatable or comma-separated)", collect)
    .option("--number-key <key>", "registry number key (repeatable)", collect);
}

function registerBrands(tendlc: Command, ctx: Ctx): void {
  const brands = tendlc.command("brands").description("10DLC brands: the businesses behind your US campaigns");

  brands
    .command("list")
    .alias("ls")
    .description("List brands")
    .action(async () => {
      await simpleList(ctx, B.list, {}, undefined, { columns: BRAND_COLUMNS, idKey: "id", empty: "No brands." });
    });

  brands
    .command("get")
    .description("Show one brand with its latest registry state")
    .argument("<id>", "brand id")
    .action(async (id: string) => {
      ctx.out.print(await ctx.client.call(B.get, { path: { id } }));
    });

  addFields(brands.command("create").description("Create a brand in draft (register it separately)"), [...BRAND_FIELDS, REFERENCE])
    .option("--body <json>", BODY_HELP)
    .addHelpText(
      "after",
      '\nExample:\n  vobiz sms 10dlc brands create --name Acme --brand-type TENDLC_PRIVATE_COMPANY --legal-name "Acme Inc" \\\n    --website https://acme.example --tax-id 123456789 --country US --vertical TECHNOLOGY --reference-id acme-1',
    )
    .action(async (o: Rec & { body?: string }) => {
      const body = await bodyWithFlags(ctx, o.body, await fieldValues(ctx, o, [...BRAND_FIELDS, REFERENCE]));
      requireKeys(body, [["name", "--name"], ["brandType", "--brand-type"]]);
      await requireConfirmation(ctx, { action: `Create 10DLC brand ${body.name}`, details: { type: String(body.brandType) } });
      printResult(ctx, `Created brand ${body.name}.`, await ctx.client.call(B.create, { body, sideEffect: true }));
    });

  addFields(brands.command("update").description("Replace a brand (full replacement: fields you leave out are cleared)").argument("<id>", "brand id"), BRAND_FIELDS)
    .option("--body <json>", BODY_HELP)
    .addHelpText("after", "\nSend the whole brand: export it with `brands get <id> --output json`, edit, then pass it with --body @brand.json.")
    .action(async (id: string, o: Rec & { body?: string }) => {
      const body = await bodyWithFlags(ctx, o.body, await fieldValues(ctx, o, BRAND_FIELDS));
      requireKeys(body, [["name", "--name"], ["brandType", "--brand-type"]]);
      await requireConfirmation(ctx, { action: `Replace 10DLC brand ${id} and push it to the registry`, details: { fields: Object.keys(body).join(", "), note: "fields not sent are cleared" } });
      printResult(ctx, `Updated brand ${id}.`, await ctx.client.call(B.update, { path: { id }, body, sideEffect: true }));
    });

  brands
    .command("delete")
    .alias("rm")
    .description("Delete a brand from your account and the registry (delete its campaigns first)")
    .argument("<id>", "brand id")
    .action(async (id: string) => {
      await requireConfirmation(ctx, { action: `Delete 10DLC brand ${id}`, details: { undo: "not possible; a new brand needs a new registration" } });
      printResult(ctx, `Deleted brand ${id}.`, await ctx.client.call(B.delete, { path: { id }, sideEffect: true }));
    });

  brands
    .command("register")
    .description("Submit a brand to the US 10DLC registry for identity verification")
    .argument("<id>", "brand id")
    .action(async (id: string) => {
      await requireConfirmation(ctx, { action: `Submit 10DLC brand ${id} to the registry`, details: { note: "submit only when the brand details are final" } });
      printResult(ctx, `Submitted brand ${id}.`, await ctx.client.call(B.register, { path: { id }, sideEffect: true }));
    });

  brands
    .command("statuses")
    .description("Show the brand's status at each registrar")
    .argument("<id>", "brand id")
    .action(async (id: string) => {
      await simpleList(ctx, B.statuses, { path: { id } }, undefined, { columns: ["registrar", "state", "brandIdentityStatus", "brandAuthenticationStatus", "rejectionReason"], idKey: "registrar" });
    });

  brands
    .command("verify")
    .description("Start brand authentication (2FA email) for a TENDLC_PUBLIC_COMPANY brand")
    .argument("<id>", "brand id")
    .action(async (id: string) => {
      await requireConfirmation(ctx, { action: `Request brand authentication for ${id}`, details: { effect: "the registry emails the business contact" } });
      printResult(ctx, `Requested brand authentication for ${id}.`, await ctx.client.call(B.authVerify, { path: { id }, sideEffect: true }));
    });

  brands
    .command("resend-2fa")
    .description("Send the brand-authentication email again")
    .argument("<id>", "brand id")
    .action(async (id: string) => {
      await requireConfirmation(ctx, { action: `Resend the brand-authentication email for ${id}` });
      printResult(ctx, `Requested a new verification email for ${id}.`, await ctx.client.call(B.resend2fa, { path: { id }, sideEffect: true }));
    });

  brands
    .command("vet")
    .description("Request an external vet of a registered brand (files a new request every time)")
    .argument("<id>", "brand id")
    .addOption(new Option("--type <type>", "kind of vet (default STANDARD)").choices(["STANDARD", "ENHANCED", "POLITICAL"]))
    .action(async (id: string, o: { type?: string }) => {
      await requireConfirmation(ctx, { action: `Request a ${o.type ?? "STANDARD"} vet of brand ${id}`, details: { note: "every call files a new vetting request" } });
      printResult(ctx, `Requested a vet of brand ${id}.`, await ctx.client.call(B.vet, { path: { id }, body: o.type ? { type: o.type } : {}, sideEffect: true }));
    });

  brands
    .command("vets")
    .description("List the brand's vetting records")
    .argument("<id>", "brand id")
    .addOption(new Option("--limit <n>", "maximum number of records (default 20)").argParser(intArg("--limit", 1, 1_000_000)))
    .option("--all", "fetch every page")
    .action(async (id: string, o: ListFlags) => {
      await listCommand(ctx, B.vets, { path: { id } }, o, 20, 100, "results", {});
    });
}

function registerCampaigns(tendlc: Command, ctx: Ctx): void {
  const campaigns = tendlc.command("campaigns").description("10DLC and toll-free campaigns: the messaging programs you register");

  campaigns
    .command("list")
    .alias("ls")
    .description("List campaigns")
    .action(async () => {
      await simpleList(ctx, C.list, {}, undefined, { columns: CAMPAIGN_COLUMNS, idKey: "id", empty: "No campaigns." });
    });

  campaigns
    .command("get")
    .description("Show one campaign with refreshed stage and review feedback")
    .argument("<id>", "campaign id")
    .action(async (id: string) => {
      ctx.out.print(await ctx.client.call(C.get, { path: { id } }));
    });

  addFields(campaigns.command("create").description("Create a 10DLC campaign under a brand (draft; register it separately)"), [...CAMPAIGN_CREATE_ONLY, ...CAMPAIGN_FIELDS])
    .option("--body <json>", BODY_HELP)
    .addHelpText(
      "after",
      '\nExample:\n  vobiz sms 10dlc campaigns create --brand BRAND_ID --name "Order alerts" --use-case ALERTS \\\n    --example "Acme: your order shipped. Reply STOP to opt out." --opt-ins @optins.json --reference-id alerts-1',
    )
    .action(async (o: Rec & { body?: string }) => {
      const body = await bodyWithFlags(ctx, o.body, await fieldValues(ctx, o, [...CAMPAIGN_CREATE_ONLY, ...CAMPAIGN_FIELDS]));
      requireKeys(body, [["name", "--name"], ["brandId", "--brand"]]);
      await requireConfirmation(ctx, { action: `Create 10DLC campaign ${body.name}`, details: { brand: String(body.brandId), ...(body.campaignType ? { type: String(body.campaignType) } : {}) } });
      printResult(ctx, `Created campaign ${body.name}.`, await ctx.client.call(C.create, { body, sideEffect: true }));
    });

  addFields(campaigns.command("create-toll-free").description("Start toll-free verification for toll-free numbers (no brand needed)"), TOLL_FREE_FIELDS)
    .option("--body <json>", BODY_HELP)
    .addHelpText("after", '\nExample:\n  vobiz sms 10dlc campaigns create-toll-free --name "Acme TF" --number +18885550100 --use-case NOTIFICATIONS --reference-id tf-1')
    .action(async (o: Rec & { body?: string }) => {
      const body = await bodyWithFlags(ctx, o.body, await fieldValues(ctx, o, TOLL_FREE_FIELDS));
      requireKeys(body, [["name", "--name"]]);
      const nums = Array.isArray(body.numbers) ? (body.numbers as string[]) : [];
      await requireConfirmation(ctx, { action: `Create toll-free campaign ${body.name}`, details: nums.length ? { numbers: nums.join(", ") } : {} });
      printResult(ctx, `Created toll-free campaign ${body.name}.`, await ctx.client.call(C.tollFree, { body, sideEffect: true }));
    });

  campaigns
    .command("priorities")
    .description("List the priority options for toll-free campaigns")
    .action(async () => {
      await simpleList(ctx, C.priorities, {}, undefined, { idKey: "id", empty: "No priority options." });
    });

  addFields(campaigns.command("update").description("Replace a campaign's editable fields (full replacement)").argument("<id>", "campaign id"), CAMPAIGN_FIELDS)
    .option("--body <json>", BODY_HELP)
    .addHelpText("after", "\nAccepted while the campaign is DRAFT or REJECTED. Fields you leave out are cleared, so send the whole campaign.")
    .action(async (id: string, o: Rec & { body?: string }) => {
      const body = await bodyWithFlags(ctx, o.body, await fieldValues(ctx, o, CAMPAIGN_FIELDS));
      requireKeys(body, [["name", "--name"]]);
      await requireConfirmation(ctx, { action: `Replace campaign ${id} and push it to the registry`, details: { fields: Object.keys(body).join(", "), note: "fields not sent are cleared" } });
      printResult(ctx, `Updated campaign ${id}.`, await ctx.client.call(C.update, { path: { id }, body, sideEffect: true }));
    });

  campaigns
    .command("delete")
    .alias("rm")
    .description("Delete a campaign (DRAFT, DEREGISTERED or REJECTED only)")
    .argument("<id>", "campaign id")
    .action(async (id: string) => {
      await requireConfirmation(ctx, { action: `Delete campaign ${id} from your account and the registry` });
      printResult(ctx, `Deleted campaign ${id}.`, await ctx.client.call(C.delete, { path: { id }, sideEffect: true }));
    });

  campaigns
    .command("register")
    .description("Submit a campaign to the registry for review")
    .argument("<id>", "campaign id")
    .option("--priority <id>", "priority id from `campaigns priorities` (toll-free campaigns)")
    .action(async (id: string, o: { priority?: string }) => {
      await requireConfirmation(ctx, { action: `Submit campaign ${id} to the registry`, details: { note: "submit only when the details are final", ...(o.priority ? { priority: o.priority } : {}) } });
      printResult(ctx, `Submitted campaign ${id}.`, await ctx.client.call(C.register, { path: { id }, body: o.priority ? { priorityId: o.priority } : {}, sideEffect: true }));
    });

  campaigns
    .command("deregister")
    .description("Withdraw a registered campaign; its numbers stop being covered")
    .argument("<id>", "campaign id")
    .action(async (id: string) => {
      await requireConfirmation(ctx, { action: `Deregister campaign ${id}`, details: { effect: "traffic on its numbers is no longer covered by this registration" } });
      printResult(ctx, `Deregistered campaign ${id}.`, await ctx.client.call(C.deregister, { path: { id }, sideEffect: true }));
    });

  campaigns
    .command("appeal")
    .description("Ask the registry to reconsider a rejected campaign")
    .argument("<id>", "campaign id")
    .requiredOption("--reason <text>", "what you changed since the rejection")
    .action(async (id: string, o: { reason: string }) => {
      await requireConfirmation(ctx, { action: `Appeal the rejection of campaign ${id}` });
      printResult(ctx, `Filed an appeal for campaign ${id}.`, await ctx.client.call(C.appeal, { path: { id }, body: { reason: o.reason }, sideEffect: true }));
    });

  numberOptions(campaigns.command("update-registration").description("Update the set of numbers a registered campaign covers").argument("<id>", "campaign id")).action(
    async (id: string, o: { number?: string[]; numberKey?: string[] }) => {
      const body = numbersBody(o);
      await requireConfirmation(ctx, { action: `Update the registered numbers of campaign ${id}`, details: { numbers: [...((body.numbers as string[]) ?? []), ...((body.numberKeys as string[]) ?? [])].join(", ") } });
      printResult(ctx, `Requested the registration update for ${id}.`, await ctx.client.call(C.updateRegistration, { path: { id }, body, sideEffect: true }));
    },
  );

  campaigns
    .command("statuses")
    .description("Show the campaign's state at each carrier network")
    .argument("<id>", "campaign id")
    .action(async (id: string) => {
      await simpleList(ctx, C.networkStatuses, { path: { id } }, undefined, { columns: ["network", "state", "messageClass", "throughput", "brandTier"], idKey: "network" });
    });

  const nums = campaigns.command("numbers").description("Numbers attached to a campaign");
  nums
    .command("list")
    .alias("ls")
    .description("List the numbers attached to a campaign")
    .argument("<id>", "campaign id")
    .action(async (id: string) => {
      await simpleList(ctx, C.numbers, { path: { id } }, "numberPreviews", { columns: ["number", "numberKey", "countryCode"], idKey: "number", empty: "No numbers attached." });
    });

  numberOptions(nums.command("add").description("Attach numbers to a campaign at the registry").argument("<id>", "campaign id")).action(
    async (id: string, o: { number?: string[]; numberKey?: string[] }) => {
      const body = numbersBody(o);
      const count = ((body.numbers as string[]) ?? []).length + ((body.numberKeys as string[]) ?? []).length;
      await requireConfirmation(ctx, { action: `Attach ${count} number${count === 1 ? "" : "s"} to campaign ${id}` });
      printResult(ctx, `Attached ${count} number${count === 1 ? "" : "s"} to ${id}.`, await ctx.client.call(C.addNumbers, { path: { id }, body, sideEffect: true }));
    },
  );

  numberOptions(nums.command("remove").description("Detach numbers from a campaign at the registry").argument("<id>", "campaign id")).action(
    async (id: string, o: { number?: string[]; numberKey?: string[] }) => {
      const body = numbersBody(o);
      const count = ((body.numbers as string[]) ?? []).length + ((body.numberKeys as string[]) ?? []).length;
      await requireConfirmation(ctx, { action: `Detach ${count} number${count === 1 ? "" : "s"} from campaign ${id}`, details: { effect: "their messages are no longer covered by this campaign" } });
      printResult(ctx, `Detached ${count} number${count === 1 ? "" : "s"} from ${id}.`, await deleteWithBody(ctx, C.removeNumbers, { id }, body));
    },
  );
}

function registerDocuments(tendlc: Command, ctx: Ctx): void {
  const docs = tendlc.command("documents").description("Supporting documents and MMS samples for campaign registration");

  docs
    .command("upload")
    .description("Upload a document (10 MB maximum); reference its documentId in a campaign")
    .requiredOption("--file <path>", "the file to upload")
    .addHelpText("after", "\nExample:\n  vobiz sms 10dlc documents upload --file optin-screenshot.png")
    .action(async (o: { file: string }) => {
      const { form, name, size } = fileForm("document", o.file);
      if (size > 10 * 1024 * 1024) throw usage(`${name} is ${humanSize(size)}; the limit is 10 MB.`);
      await requireConfirmation(ctx, { action: "Upload a document to the US 10DLC registry", details: { file: `${name} (${humanSize(size)})` } });
      printResult(ctx, `Uploaded ${name}.`, await ctx.client.call(D.upload, { body: form, sideEffect: true }));
    });

  docs
    .command("get")
    .description("Download a document by its documentId")
    .argument("<document-id>", "documentId from the upload")
    .option("--out <file>", "where to save it (default: the original filename; - for stdout)")
    .option("--force", "overwrite an existing file")
    .action(async (id: string, o: { out?: string; force?: boolean }) => {
      if (o.out && o.out !== "-" && existsSync(o.out) && !o.force) throw usage(`${o.out} exists. Pass --force to overwrite it.`);
      const res = await ctx.client.call<BytesResponse>(D.get, { path: { id }, responseType: "bytes" });
      if (o.out === "-") {
        (ctx.stdout as { write(b: Uint8Array | string): unknown }).write(res.bytes);
        return;
      }
      const file = o.out ?? (res.filename ? basename(res.filename) : id);
      if (!o.out && existsSync(file) && !o.force) throw usage(`${file} exists. Pass --out <file> or --force.`);
      writeFileSync(file, res.bytes, { mode: 0o600 }); // registration documents can hold business identity data
      chmodSync(file, 0o600); // also when --force replaced an existing file
      ctx.out.success(`Saved ${file} (${humanSize(res.bytes.length)}).`, { file, bytes: res.bytes.length, contentType: res.contentType ?? null });
    });
}

export function registerTenDlc(sms: Command, ctx: Ctx): void {
  const tendlc = sms.command("10dlc").description("US 10DLC and toll-free registration: brands, campaigns, documents");
  registerBrands(tendlc, ctx);
  registerCampaigns(tendlc, ctx);
  registerDocuments(tendlc, ctx);
}
