/**
 * `vobiz endpoints`: SIP endpoints, the registered soft-phone/WebRTC/desk-phone clients (not trunks). Each endpoint
 * has a SIP username and password and is attached to an Application.
 */
import type { Command } from "commander";
import type { Ctx } from "../core/context.js";
import { op } from "../core/ops.js";
import { usage } from "../core/errors.js";
import { crud, examples, type FlagAlias } from "./provisioning-shared.js";

/** Application ids have 17 digits (beyond 2^53), so they travel as strings; checked, never converted to a number. */
const appId = (v: string): string => {
  if (!/^\d{1,30}$/.test(v)) throw usage(`--app-id must be an application id made of digits (got "${v}").`);
  return v;
};

/** The live API links an endpoint to an application through `app_id` (string); `application` is ignored. */
const ENDPOINT_ALIASES: FlagAlias[] = [
  { flag: "app-id", to: "app_id", description: "ID of the application that handles this endpoint's calls (sent as a string).", parse: appId },
  { flag: "application", to: "app_id", deprecated: true, description: "ID of the application (sent as app_id).", parse: appId },
];

export function register(program: Command, ctx: Ctx): void {
  const endpoints = program
    .command("endpoints")
    .description("SIP endpoints: registered soft-phone, WebRTC and desk-phone clients")
    .addHelpText(
      "after",
      examples(
        "vobiz endpoints list --username-contains sales",
        "vobiz endpoints create --username desk_01 --alias 'Front desk' --app-id <app-id>   # prompts for the password",
        "vobiz endpoints update <endpoint-id> --alias 'Front desk' --password @desk.pass --app-id <app-id>",
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
    summaryKeys: ["username", "alias", "app_id"],
    aliases: ENDPOINT_ALIASES,
    secretPaths: ["password"],
    secretLabel: "SIP password",
    listFilters: true,
    // The API appends digits to the requested username; SIP clients must use the username in the response.
    createExamples: [
      "vobiz endpoints create --username desk_01 --alias 'Front desk' --app-id 12345678901234567",
      "# the API appends digits to the username: configure the SIP client with the username it returns",
    ],
  });
}
