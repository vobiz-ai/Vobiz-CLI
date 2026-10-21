/**
 * `vobiz trunks`: SIP trunks and the resources a trunk points at: SIP credentials (digest auth), IP access-control
 * entries (IP auth) and origination URIs (where inbound calls are sent). Create and update flags are generated from
 * the spec, so every body field has a flag; `--body` passes anything else.
 */
import type { Command } from "commander";
import type { Ctx } from "../core/context.js";
import { op } from "../core/ops.js";
import { crud, examples } from "./provisioning-shared.js";

export function register(program: Command, ctx: Ctx): void {
  const trunks = program.command("trunks").description("SIP trunks, their credentials, IP access-control lists and origination URIs");
  trunks.addHelpText(
    "after",
    examples(
      "vobiz trunks list",
      "vobiz trunks credentials create --username pbx_01 --password @pbx_01.pass   # or --password @- to read stdin",
      "vobiz trunks create --name 'Office PBX' --trunk-direction outbound --credential-uuid <credential-id>",
      "vobiz trunks origination-uris create --name primary --sip-uri sip:pbx.example.com --priority 1",
    ),
  );

  crud(trunks, ctx, {
    noun: "trunk",
    idArg: "trunk-id",
    idKey: "trunk_id",
    idParam: "trunk_id",
    columns: ["trunk_id", "name", "trunk_direction", "trunk_status", "transport", "trunk_domain", "concurrent_calls_limit"],
    list: op("list-trunks"),
    get: op("retrieve-trunk"),
    create: op("create-trunk"),
    update: op("update-trunk"),
    delete: op("delete-trunk"),
    summaryKeys: ["name", "trunk_direction", "trunk_status", "transport", "trunk_domain", "inbound_destination", "credential_uuid", "ipacl_uuid", "primary_uri_uuid"],
    createExamples: [
      "vobiz trunks create --name 'Office PBX' --trunk-direction outbound --credential-uuid <credential-id>",
      "vobiz trunks create --name inbound --trunk-direction inbound --primary-uri-uuid <uri-id> --recording",
    ],
  });

  const credentials = trunks.command("credentials").description("SIP digest credentials (username/password) that trunks authenticate with");
  crud(credentials, ctx, {
    noun: "SIP credential",
    idArg: "credential-id",
    idKey: "id",
    idParam: "credential_id",
    columns: ["id", "username", "realm", "enabled", "created_at"],
    list: op("list-credentials"),
    create: op("create-credential"),
    update: op("update-credential"),
    delete: op("delete-credential"),
    summaryKeys: ["username"],
    secretPaths: ["password"],
    secretLabel: "SIP password",
    createExamples: ["vobiz trunks credentials create --username pbx_01   # prompts for the password on a terminal"],
  });

  const acl = trunks.command("ip-acl").description("IP access-control entries for IP-authenticated trunks");
  crud(acl, ctx, {
    noun: "IP ACL entry",
    plural: "IP ACL entries",
    idArg: "ip-acl-id",
    idKey: "id",
    idParam: "ip_acl_id",
    columns: ["id", "ip_address", "description", "enabled", "created_at"],
    list: op("list-ip-acls"),
    create: op("create-ip-acl"),
    update: op("update-ip-acl"),
    delete: op("delete-ip-acl"),
    summaryKeys: ["name", "ip_address"],
    createExamples: ["vobiz trunks ip-acl create --name office --ip-address 203.0.113.0/24"],
  });

  const uris = trunks.command("origination-uris").description("Origination URIs: the SIP destinations inbound trunk calls are sent to");
  crud(uris, ctx, {
    noun: "origination URI",
    idArg: "uri-id",
    idKey: "id",
    idParam: "uri_id",
    columns: ["id", "uri", "priority", "weight", "transport", "enabled", "description"],
    list: op("list-origination-uris"),
    create: op("create-origination-uri"),
    update: op("update-origination-uri"),
    delete: op("delete-origination-uri"),
    summaryKeys: ["name", "sip_uri", "priority"],
    createExamples: ["vobiz trunks origination-uris create --name primary --sip-uri sip:pbx.example.com:5060 --priority 1"],
  });
}
