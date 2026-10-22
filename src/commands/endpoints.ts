/**
 * `vobiz endpoints`: SIP endpoints, the registered soft-phone/WebRTC/desk-phone clients (not trunks). Each endpoint
 * has a SIP username and password and is attached to an Application.
 */
import type { Command } from "commander";
import type { Ctx } from "../core/context.js";
import { op } from "../core/ops.js";
import { crud, examples } from "./provisioning-shared.js";

export function register(program: Command, ctx: Ctx): void {
  const endpoints = program
    .command("endpoints")
    .description("SIP endpoints: registered soft-phone, WebRTC and desk-phone clients")
    .addHelpText(
      "after",
      examples(
        "vobiz endpoints list --username-contains sales",
        "vobiz endpoints create --username desk_01 --alias 'Front desk' --application <app-id>   # prompts for the password",
        "vobiz endpoints delete <endpoint-id>",
      ),
    );
  crud(endpoints, ctx, {
    noun: "endpoint",
    idArg: "endpoint-id",
    idKey: "endpoint_id",
    idParam: "endpoint_id",
    columns: ["endpoint_id", "username", "alias", "sip_registered", "sip_uri", "application"],
    list: op("list-endpoints"),
    get: op("retrieve-endpoint"),
    create: op("create-endpoint"),
    update: op("update-endpoint"),
    delete: op("delete-endpoint"),
    summaryKeys: ["username", "alias", "application"],
    secretPaths: ["password"],
    secretLabel: "SIP password",
    listFilters: true,
    // Application ids have 17 digits; the live API links the endpoint through `app_id` (a string), see SPEC-GAPS.
    createExamples: [`vobiz endpoints create --username desk_01 --alias 'Front desk' --body '{"app_id":"12345678901234567"}'`],
  });
}
