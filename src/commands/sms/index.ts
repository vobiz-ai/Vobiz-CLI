/**
 * `vobiz sms`: everything on the Vobiz Messaging API (SMS, MMS, RCS, broadcasts, US 10DLC).
 * The API has its own base URL (https://api.vobiz.ai/api/v1/sms) and camelCase JSON; the client picks the base
 * URL from each operation, and `--sms-base-url` / VOBIZ_SMS_BASE_URL override it.
 */
import type { Command } from "commander";
import type { Ctx } from "../../core/context.js";
import { registerBroadcasts } from "./broadcasts.js";
import { registerInbox } from "./inbox.js";
import { registerMessaging } from "./messages.js";
import { registerNumbersAndCoverage } from "./numbers.js";
import { registerSenders } from "./senders.js";
import { registerTenDlc } from "./tendlc.js";

export function register(program: Command, ctx: Ctx): void {
  const sms = program
    .command("sms")
    .description("SMS, MMS and RCS: send, follow delivery, conversations, opt-outs, broadcasts, RCS senders, US 10DLC")
    .addHelpText(
      "after",
      `
Examples:
  vobiz sms numbers list
  vobiz sms cost --from +14155550100 --to +14155550123 --text "Hello"
  vobiz sms send --from +14155550100 --to +14155550123 --text "Hello" --wait
  vobiz sms messages list --direction in --since 24h
  vobiz sms broadcasts create --name Launch --from +14155550100 --template "Hi {{name}}"`,
    );
  registerMessaging(sms, ctx);
  registerNumbersAndCoverage(sms, ctx);
  registerInbox(sms, ctx);
  registerBroadcasts(sms, ctx);
  registerSenders(sms, ctx);
  registerTenDlc(sms, ctx);
}
