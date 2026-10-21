/**
 * `vobiz apps`: Applications. An Application holds the answer URL (and method) Vobiz fetches VobizXML from when a
 * call reaches a number or endpoint attached to it.
 */
import type { Command } from "commander";
import type { Ctx } from "../core/context.js";
import { op } from "../core/ops.js";
import { crud, examples } from "./provisioning-shared.js";

export function register(program: Command, ctx: Ctx): void {
  const apps = program
    .command("apps")
    .description("Applications: the answer URL Vobiz fetches VobizXML from for numbers and endpoints")
    .addHelpText(
      "after",
      examples(
        "vobiz apps list",
        "vobiz apps create --app-name 'IVR' --answer-url https://example.com/answer --answer-method POST",
        "vobiz apps update <app-id> --app-name 'IVR v2' --no-default-number-app --answer-url https://example.com/v2/answer",
        "vobiz numbers update +919876543210 --app <app-id>",
      ),
    );
  crud(apps, ctx, {
    noun: "application",
    idArg: "app-id",
    idKey: "app_id",
    idParam: "app_id",
    columns: ["app_id", "app_name", "answer_url", "answer_method", "default_app", "enabled"],
    list: op("list-applications"),
    get: op("retrieve-application"),
    create: op("create-application"),
    update: op("update-application"),
    delete: op("delete-application"),
    summaryKeys: ["app_name", "answer_method", "default_number_app"],
    createExamples: [
      "vobiz apps create --app-name 'IVR' --answer-url https://example.com/answer --answer-method POST",
      "vobiz apps create --app-name 'IVR' --answer-url https://example.com/answer --answer-method POST --hangup-url https://example.com/hangup --hangup-method POST",
    ],
  });
}
