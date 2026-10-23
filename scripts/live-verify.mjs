#!/usr/bin/env node
// Scripted, repeatable live review of the CLI against the REAL account in VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN
// (a maintainer test account).
//
//   node scripts/live-verify.mjs --dry-run                 # print the plan, send nothing
//   node scripts/live-verify.mjs --only apps,trunks        # some groups
//   node scripts/live-verify.mjs --report report.json --summary summary.md
//
// What it does, per group: sweep (delete `cli-verify-*` leftovers of an earlier run), every read command, then
// reversible writes on resources named `cli-verify-*`. Every write registers its undo before or when it succeeds; a
// cleanup phase runs those undos even when a step fails or the run crashes, and whatever it cannot undo is listed as
// a leftover. Billable or outward-facing commands are refused in code (FORBIDDEN below), whatever the plan says.
//
// Exit codes (the nightly workflow branches on them):
//   0  every step works or was skipped, nothing left over
//   1  a CLI step failed (wrong exit with no API answer, bad output, a refused command, a secret in the output),
//      or cleanup left something behind: "we broke it"
//   2  only API differences: Vobiz answered differently from the recorded expectation: "Vobiz changed"
//   3  did not run: bad arguments or no credentials
//
// Secrets: the Auth Token, any secret-named field of /auth/me and every password this run generates are checked
// against each step's output (a hit fails the step) and against the written report and summary (a hit deletes them
// and exits 1). Raw command output is never printed or stored, only verdicts and short notes.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "cli-verify";
const EX = "https://example.com/cli-verify";

// ---------------------------------------------------------------------------------------------------------------
// Hard exclusions. Checked on every step before it runs (sweep and cleanup included), on the command path (the
// words before the first flag) and on every non-flag word, so a flag between the words does not hide a verb.
export const FORBIDDEN = [
  { re: /^calls (?!list\b|get\b)/, why: "places or controls a real call" },
  { re: /^conferences (?!list\b|get\b)/, why: "acts on a live conference" },
  { re: /^sms send\b/, why: "sends a real message" },
  { re: /^(sms )?numbers (buy|release|cancel-release)\b/, why: "buys or releases a phone number" },
  { re: /^partner (\S+ )*transfer-balance\b/, why: "moves money between accounts" },
  { re: /^sms broadcasts launch\b/, why: "sends a broadcast to every recipient" },
  { re: /^sms 10dlc (\S+ )*register\b/, why: "registers with The Campaign Registry (billable)" },
  { re: /^sub-accounts kyc (\S+ )*session create\b/, why: "creates a KYC session (sends email or SMS)" },
  { re: /^partner kyc-sessions create\b/, why: "creates a KYC session (sends email or SMS)" },
  { re: /^account channel-subscriptions create\b/, why: "buys capacity (billable)" },
];

/** Why this argv must never run in the live suite, or null when it may. */
export function forbiddenReason(args) {
  const words = args.map(String);
  const firstFlag = words.findIndex((w) => w.startsWith("-"));
  const path = (firstFlag < 0 ? words : words.slice(0, firstFlag)).join(" ");
  const loose = words.filter((w) => !w.startsWith("-")).join(" ");
  for (const f of FORBIDDEN) if (f.re.test(path) || f.re.test(loose)) return f.why;
  if (words[0] === "api" && words.some((w) => /^(POST|PUT|PATCH|DELETE)$/i.test(w))) return "a raw API write bypasses every check here";
  if (words[0] === "sub-accounts" && words.some((w) => w.includes("is_active"))) return "is_active:false hides a sub-account from the API for good";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// JSON helpers: response shapes vary between endpoints, so look in the usual places.
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export function rows(j) {
  if (Array.isArray(j)) return j;
  if (!isObj(j)) return [];
  for (const k of ["objects", "items", "data", "numbers", "sub_accounts", "results", "webhooks", "broadcasts", "optOuts", "opt_outs", "records"]) if (Array.isArray(j[k])) return j[k];
  const arr = Object.values(j).find(Array.isArray);
  return arr ?? [];
}
const getPath = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
/** First non-empty value at one of these dot paths (also tried under data/object/result). */
export function pick(j, ...paths) {
  for (const base of [j, j?.data, j?.object, j?.result]) {
    if (!isObj(base)) continue;
    for (const p of paths) {
      const v = getPath(base, p);
      if (v !== undefined && v !== null && v !== "") return String(v);
    }
  }
  return undefined;
}
const field = (j, ...paths) => {
  for (const base of [j, j?.data, j?.object, j?.result]) {
    if (!isObj(base)) continue;
    for (const p of paths) if (getPath(base, p) !== undefined) return getPath(base, p);
  }
  return undefined;
};
const starts = (v, p = PREFIX) => typeof v === "string" && v.startsWith(p);

// ---------------------------------------------------------------------------------------------------------------
// The plan. A step: { group, phase, cmd, args(s) → argv, needs?, expect?, raw?, check?(j,s) → note|undefined,
// capture?(j,s), undo?(s) → step (registered under undoKey when the step exits 0), before?(s,reg),
// resolves?: undoKey (dropped from the cleanup list when this step works), expand?(j,s) → steps, note? }.
// Writes carry --yes explicitly; the executor adds --output json --verbose --no-update-check.

export const GROUPS = ["identity", "account", "partner", "numbers", "apps", "trunks", "endpoints", "sub-accounts", "calls", "sms", "local"];

const R = (group, cmd, args, o = {}) => ({ group, phase: "read", cmd, args: typeof args === "function" ? args : () => args, ...o });
const W = (group, cmd, args, o = {}) => ({ group, phase: "write", cmd, args: (s) => [...(typeof args === "function" ? args(s) : args), "--yes"], ...o });
const SWEEP = (group, cmd, listArgs, del, match, idOf) =>
  R(group, cmd, listArgs, {
    phase: "sweep",
    note: `delete any ${PREFIX} leftovers`,
    expand: (j) =>
      rows(j)
        .filter(match)
        .map((x) => idOf(x))
        .filter(Boolean)
        .map((id) => ({ group, phase: "sweep", cmd: del.join(" "), args: () => [...del, id, "--yes"], expect: [0, 4], note: "leftover of an earlier run" })),
  });
const gone = (group, cmd, args, needs) => R(group, cmd, args, { needs, expect: 4, note: "after delete" });

/** files: { pw1, pw2, epPw, whSecret, dir } paths (placeholders in --dry-run). */
export function buildPlan({ only, files }) {
  const want = new Set(only?.length ? only : GROUPS);
  const f = files;
  const steps = [];
  const add = (...s) => steps.push(...s);

  if (want.has("identity")) {
    add(
      R("identity", "whoami --check", ["whoami", "--check"], { check: (j) => (j?.verified === true ? undefined : "verified is not true") }),
      R("identity", "doctor", ["doctor"], { check: (j) => (Array.isArray(j) && !j.some((c) => c.status === "fail") ? undefined : "a doctor check failed") }),
      R("identity", "config list", ["config", "list"]),
    );
  }

  if (want.has("account")) {
    add(
      R("account", "account show", ["account", "show"]),
      R("account", "account balance", ["account", "balance"]),
      R("account", "account concurrency", ["account", "concurrency"]),
      R("account", "account transactions list", ["account", "transactions", "list", "--limit", "3"]),
      R("account", "account transactions types", ["account", "transactions", "types"]),
      R("account", "account channel-pricing", ["account", "channel-pricing", "--type", "cps", "--quantity", "1"]),
    );
  }

  if (want.has("partner")) {
    // Recorded: a non-partner account gets 401 "Not authenticated" (same as bad credentials), so exit 3.
    add(
      R("partner", "partner me", ["partner", "me"], { expect: 3, note: "recorded: 401 on a non-partner account" }),
      R("partner", "partner dashboard", ["partner", "dashboard"], { expect: 3, note: "recorded: 401 on a non-partner account" }),
    );
  }

  if (want.has("numbers")) {
    add(
      R("numbers", "numbers list", ["numbers", "list", "--all"], {
        note: "picks a number that is already linked to an application",
        capture: (j, s) => {
          const n = rows(j).find((x) => x?.e164 && x?.application_id);
          if (n) {
            s.number = String(n.e164);
            s.numberApp = String(n.application_id);
          }
        },
      }),
      R("numbers", "numbers get", (s) => ["numbers", "get", s.number], { needs: ["number"] }),
      R("numbers", "numbers health", (s) => ["numbers", "health", s.number], { needs: ["number"] }),
      R("numbers", "numbers search", ["numbers", "search", "--country", "US", "--limit", "3"]),
      R("numbers", "numbers update", (s) => ["numbers", "update", s.number, "--unlink-app", "--dry-run"], { needs: ["number"], note: "dry run: shows the DELETE" }),
      W("numbers", "numbers update", (s) => ["numbers", "update", s.number, "--unlink-app"], {
        needs: ["number", "numberApp"],
        before: (s, reg) => reg("number-link", { group: "numbers", phase: "cleanup", cmd: "numbers update", args: () => ["numbers", "update", s.number, "--app", s.numberApp, "--yes"] }),
      }),
      R("numbers", "numbers get", (s) => ["numbers", "get", s.number], { needs: ["number"], check: (j) => (field(j, "application_id") ? "application_id still set after --unlink-app" : undefined) }),
      W("numbers", "numbers update", (s) => ["numbers", "update", s.number, "--app", s.numberApp], { needs: ["number", "numberApp"], resolves: "number-link" }),
      R("numbers", "numbers get", (s) => ["numbers", "get", s.number], {
        needs: ["number", "numberApp"],
        check: (j, s) => (String(field(j, "application_id")) === s.numberApp ? undefined : "application_id was not restored"),
      }),
    );
  }

  if (want.has("apps")) {
    add(
      SWEEP("apps", "apps list", ["apps", "list", "--all"], ["apps", "delete"], (x) => starts(x?.app_name), (x) => x?.app_id),
      R("apps", "apps list", ["apps", "list", "--limit", "5"], { capture: (j, s) => (s.existingApp = pick(rows(j)[0], "app_id")) }),
      R("apps", "apps get", (s) => ["apps", "get", s.existingApp], { needs: ["existingApp"] }),
      W("apps", "apps create", ["apps", "create", "--app-name", `${PREFIX}-app`, "--answer-url", `${EX}/answer`, "--answer-method", "POST", "--hangup-url", `${EX}/hangup`, "--hangup-method", "POST"], {
        capture: (j, s) => (s.app = pick(j, "app_id")),
        undo: (s) => ({ group: "apps", phase: "cleanup", cmd: "apps delete", args: () => ["apps", "delete", s.app, "--yes"] }),
        undoKey: "app",
      }),
      R("apps", "apps get", (s) => ["apps", "get", s.app], { needs: ["app"] }),
      W("apps", "apps update", (s) => ["apps", "update", s.app, "--app-name", `${PREFIX}-app-2`, "--no-default-number-app", "--answer-url", `${EX}/answer2`, "--answer-method", "GET", "--hangup-url", `${EX}/hangup2`, "--hangup-method", "GET"], { needs: ["app"] }),
      W("apps", "apps update", (s) => ["apps", "update", s.app, "--body", JSON.stringify({ answer_url: `${EX}/answer3` })], { needs: ["app"], note: "recorded: partial update accepted although the spec requires app_name" }),
      W("apps", "apps update", (s) => ["apps", "update", s.app, "--answer-url", `${EX}/answer4`], { needs: ["app"], note: "partial update with one flag (spec corrected 2026-10-22: no required fields)" }),
      W("apps", "apps delete", (s) => ["apps", "delete", s.app], { needs: ["app"], resolves: "app" }),
      gone("apps", "apps get", (s) => ["apps", "get", s.app], ["app"]),
    );
  }

  if (want.has("trunks")) {
    add(
      SWEEP("trunks", "trunks list", ["trunks", "list", "--all"], ["trunks", "delete"], (x) => starts(x?.name), (x) => x?.trunk_id),
      SWEEP("trunks", "trunks origination-uris list", ["trunks", "origination-uris", "list", "--all"], ["trunks", "origination-uris", "delete"], (x) => [x?.uri, x?.description, x?.name].some((v) => typeof v === "string" && v.includes(PREFIX)), (x) => x?.id),
      SWEEP("trunks", "trunks credentials list", ["trunks", "credentials", "list", "--all"], ["trunks", "credentials", "delete"], (x) => starts(x?.username, "cliverify"), (x) => x?.id),
      R("trunks", "trunks list", ["trunks", "list", "--limit", "5"], { capture: (j, s) => (s.existingTrunk = pick(rows(j)[0], "trunk_id")) }),
      R("trunks", "trunks get", (s) => ["trunks", "get", s.existingTrunk], { needs: ["existingTrunk"] }),
      R("trunks", "trunks credentials list", ["trunks", "credentials", "list"]),
      R("trunks", "trunks ip-acl list", ["trunks", "ip-acl", "list"]),
      R("trunks", "trunks origination-uris list", ["trunks", "origination-uris", "list"]),
      W("trunks", "trunks credentials create", ["trunks", "credentials", "create", "--username", "cliverify01", "--password", `@${f.pw1}`], {
        capture: (j, s) => (s.cred = pick(j, "id", "uuid", "credential_uuid")),
        undo: (s) => ({ group: "trunks", phase: "cleanup", cmd: "trunks credentials delete", args: () => ["trunks", "credentials", "delete", s.cred, "--yes"] }),
        undoKey: "cred",
      }),
      W("trunks", "trunks credentials update", (s) => ["trunks", "credentials", "update", s.cred, "--password", `@${f.pw2}`], { needs: ["cred"] }),
      W("trunks", "trunks create", (s) => ["trunks", "create", "--name", `${PREFIX}-trunk`, "--trunk-direction", "outbound", "--trunk-status", "enabled", "--transport", "udp", "--credential-uuid", s.cred], {
        needs: ["cred"],
        capture: (j, s) => (s.trunk = pick(j, "trunk_id", "id")),
        undo: (s) => ({ group: "trunks", phase: "cleanup", cmd: "trunks delete", args: () => ["trunks", "delete", s.trunk, "--yes"] }),
        undoKey: "trunk",
      }),
      W("trunks", "trunks update", (s) => ["trunks", "update", s.trunk, "--name", `${PREFIX}-trunk-2`, "--description", `${PREFIX}-2`, "--trunk-status", "disabled", "--cps-limit", "2"], { needs: ["trunk"] }),
      R("trunks", "trunks get", (s) => ["trunks", "get", s.trunk], {
        needs: ["trunk"],
        note: "recorded: request takes enabled/disabled, responses report active/suspended",
        check: (j) => {
          const st = field(j, "trunk_status");
          return st === undefined || st === "suspended" ? undefined : `trunk_status is ${JSON.stringify(st)}, recorded "suspended"`;
        },
      }),
      W("trunks", "trunks update", (s) => ["trunks", "update", s.trunk, "--body", JSON.stringify({ description: `${PREFIX}-3` })], { needs: ["trunk"] }),
      W("trunks", "trunks delete", (s) => ["trunks", "delete", s.trunk], { needs: ["trunk"], resolves: "trunk" }),
      gone("trunks", "trunks get", (s) => ["trunks", "get", s.trunk], ["trunk"]),
      W("trunks", "trunks credentials delete", (s) => ["trunks", "credentials", "delete", s.cred], { needs: ["cred"], resolves: "cred" }),
      W("trunks", "trunks ip-acl create", ["trunks", "ip-acl", "create", "--name", `${PREFIX}-acl`, "--ip-address", "203.0.113.10/32"], {
        expect: 2,
        note: "recorded: API refuses the documentation range 203.0.113.0/24 with 400",
        capture: (j, s) => (s.acl = pick(j, "id")),
        undo: (s) => ({ group: "trunks", phase: "cleanup", cmd: "trunks ip-acl delete", args: () => ["trunks", "ip-acl", "delete", s.acl, "--yes"] }),
        undoKey: "acl",
      }),
      W("trunks", "trunks origination-uris create", ["trunks", "origination-uris", "create", "--name", `${PREFIX}-uri`, "--sip-uri", "sip:cli-verify.example.com", "--priority", "1"], {
        note: "recorded: API ignores sip_uri/name and stores uri \"\"",
        capture: (j, s) => (s.uri = pick(j, "id", "uuid")),
        undo: (s) => ({ group: "trunks", phase: "cleanup", cmd: "trunks origination-uris delete", args: () => ["trunks", "origination-uris", "delete", s.uri, "--yes"] }),
        undoKey: "uri",
        check: (j) => {
          const u = field(j, "uri");
          return u === undefined || u === "" ? undefined : `uri is ${JSON.stringify(u)}: the API now stores sip_uri`;
        },
      }),
      W("trunks", "trunks origination-uris update", (s) => ["trunks", "origination-uris", "update", s.uri, "--name", `${PREFIX}-uri`, "--priority", "3", "--body", JSON.stringify({ uri: "sip:cli-verify.example.com", description: `${PREFIX}-uri` })], { needs: ["uri"] }),
      W("trunks", "trunks origination-uris delete", (s) => ["trunks", "origination-uris", "delete", s.uri], { needs: ["uri"], resolves: "uri" }),
    );
  }

  if (want.has("endpoints")) {
    add(
      SWEEP("endpoints", "endpoints list", ["endpoints", "list", "--all"], ["endpoints", "delete"], (x) => starts(x?.alias), (x) => x?.endpoint_id),
      SWEEP("endpoints", "apps list", ["apps", "list", "--all"], ["apps", "delete"], (x) => starts(x?.app_name, `${PREFIX}-ep-app`), (x) => x?.app_id),
      R("endpoints", "endpoints list", ["endpoints", "list", "--limit", "5"]),
      W("endpoints", "apps create", ["apps", "create", "--app-name", `${PREFIX}-ep-app`, "--answer-url", `${EX}/answer`, "--answer-method", "POST"], {
        note: "an application only for the endpoint",
        capture: (j, s) => (s.epApp = pick(j, "app_id")),
        undo: (s) => ({ group: "endpoints", phase: "cleanup", cmd: "apps delete", args: () => ["apps", "delete", s.epApp, "--yes"] }),
        undoKey: "epApp",
      }),
      W("endpoints", "endpoints create", (s) => ["endpoints", "create", "--username", "cliverifyep01", "--password", `@${f.epPw}`, "--alias", `${PREFIX}-endpoint`, "--body", JSON.stringify({ application: s.epApp })], {
        needs: ["epApp"],
        note: "recorded: application stays null, the API appends digits to the username",
        capture: (j, s) => (s.ep = pick(j, "endpoint_id", "id")),
        undo: (s) => ({ group: "endpoints", phase: "cleanup", cmd: "endpoints delete", args: () => ["endpoints", "delete", s.ep, "--yes"] }),
        undoKey: "ep",
        check: (j, s) => {
          const a = field(j, "application");
          return a === undefined || a === null || a === "" || String(a) !== s.epApp ? undefined : "application is now applied on create";
        },
      }),
      R("endpoints", "endpoints get", (s) => ["endpoints", "get", s.ep], { needs: ["ep"] }),
      W("endpoints", "endpoints update", (s) => ["endpoints", "update", s.ep, "--alias", `${PREFIX}-endpoint-2`, "--password", `@${f.epPw}`, "--body", JSON.stringify({ app_id: s.epApp })], { needs: ["ep", "epApp"], note: "recorded: app_id (string) links the app" }),
      W("endpoints", "endpoints delete", (s) => ["endpoints", "delete", s.ep], { needs: ["ep"], resolves: "ep" }),
      gone("endpoints", "endpoints get", (s) => ["endpoints", "get", s.ep], ["ep"]),
      W("endpoints", "apps delete", (s) => ["apps", "delete", s.epApp], { needs: ["epApp"], resolves: "epApp" }),
    );
  }

  if (want.has("sub-accounts")) {
    add(
      SWEEP("sub-accounts", "sub-accounts list", ["sub-accounts", "list", "--all"], ["sub-accounts", "delete"], (x) => starts(x?.name), (x) => x?.auth_id),
      R("sub-accounts", "sub-accounts list", ["sub-accounts", "list", "--limit", "5"], { capture: (j, s) => (s.existingSa = pick(rows(j).find((x) => !starts(x?.name)), "auth_id")) }),
      R("sub-accounts", "sub-accounts get", (s) => ["sub-accounts", "get", s.existingSa], { needs: ["existingSa"] }),
      W("sub-accounts", "sub-accounts create", ["sub-accounts", "create", "--name", `${PREFIX}-sub`, "--kyc-mode", "customer_use", "--email", "cli-verify@example.com", "--business-type", "private_limited"], {
        capture: (j, s) => (s.sa = pick(j, "sub_account.auth_id", "auth_credentials.auth_id", "auth_id")),
        undo: (s) => ({ group: "sub-accounts", phase: "cleanup", cmd: "sub-accounts delete", args: () => ["sub-accounts", "delete", s.sa, "--yes"] }),
        undoKey: "sa",
      }),
      W("sub-accounts", "sub-accounts update", (s) => ["sub-accounts", "update", s.sa, "--name", `${PREFIX}-sub-2`], { needs: ["sa"] }),
      // Never sent: if Vobiz starts honouring enabled:false it may hide the sub-account like is_active:false did.
      R("sub-accounts", "sub-accounts update", (s) => ["sub-accounts", "update", s.sa, "--no-enabled", "--dry-run"], {
        needs: ["sa"],
        note: "dry run only: the CLI sends enabled:false",
        check: (j) => (JSON.stringify(j ?? "").includes('"enabled":false') ? undefined : "the dry run does not show enabled:false"),
      }),
      R("sub-accounts", "sub-accounts kyc status", (s) => ["sub-accounts", "kyc", "status", s.sa], { needs: ["sa"] }),
      W("sub-accounts", "sub-accounts kyc --test verify-pan", (s) => ["sub-accounts", "kyc", "--test", "verify-pan", s.sa, "--pan", "TESTSUCCESS0001"], { needs: ["sa"], expect: 4, note: "recorded: every Test Mode KYC route answers 404" }),
      W("sub-accounts", "sub-accounts delete", (s) => ["sub-accounts", "delete", s.sa], { needs: ["sa"], resolves: "sa" }),
      gone("sub-accounts", "sub-accounts get", (s) => ["sub-accounts", "get", s.sa], ["sa"]),
    );
  }

  if (want.has("calls")) {
    add(
      R("calls", "calls list", ["calls", "list"]),
      R("calls", "calls list", ["calls", "list", "--queued"]),
      R("calls", "conferences list", ["conferences", "list"]),
      R("calls", "recordings list", ["recordings", "list", "--limit", "3"], { capture: (j, s) => (s.rec = pick(rows(j)[0], "recording_id")) }),
      R("calls", "recordings get", (s) => ["recordings", "get", s.rec], { needs: ["rec"] }),
      R("calls", "recordings download", (s) => ["recordings", "download", s.rec, "--out", `${f.dir}/r.wav`], { needs: ["rec"] }),
      R("calls", "cdr list", ["cdr", "list", "--limit", "2"], { capture: (j, s) => (s.cdr = pick(rows(j)[0], "uuid", "call_uuid")) }),
      R("calls", "cdr recent", ["cdr", "recent", "--limit", "2"]),
      R("calls", "cdr get", (s) => ["cdr", "get", s.cdr], { needs: ["cdr"] }),
      R("calls", "cdr search", ["cdr", "search", "--from", "7d", "--direction", "inbound", "--limit", "2"]),
      R("calls", "cdr export", ["cdr", "export", "--from", "yesterday", "--out", `${f.dir}/cdr.csv`], { raw: true }),
      R("calls", "diagnose call", (s) => ["diagnose", "call", s.cdr], { needs: ["cdr"] }),
    );
  }

  if (want.has("sms")) {
    add(
      SWEEP("sms", "sms webhooks list", ["sms", "webhooks", "list"], ["sms", "webhooks", "delete"], (x) => typeof x?.url === "string" && x.url.includes(`/${PREFIX}`), (x) => x?.id),
      SWEEP("sms", "sms broadcasts list", ["sms", "broadcasts", "list", "--all"], ["sms", "broadcasts", "delete"], (x) => starts(x?.name) && (x?.status === undefined || x.status === "draft"), (x) => x?.id),
      SWEEP("sms", "sms opt-outs list", ["sms", "opt-outs", "list", "--all"], ["sms", "opt-outs", "remove"], (x) => x?.reason === PREFIX, (x) => x?.phoneNumber),
      R("sms", "sms numbers list", ["sms", "numbers", "list"], { note: "picks an SMS number the account owns", capture: (j, s) => (s.smsNumber = pick(rows(j)[0], "e164", "phoneNumber", "number")) }),
      R("sms", "sms numbers countries", ["sms", "numbers", "countries"]),
      R("sms", "sms numbers search", ["sms", "numbers", "search", "--country", "US", "--limit", "2"]),
      R("sms", "sms coverage list", ["sms", "coverage", "list"]),
      R("sms", "sms coverage get", ["sms", "coverage", "get", "GB"]),
      R("sms", "sms messages list", ["sms", "messages", "list", "--limit", "2"], { capture: (j, s) => (s.msg = pick(rows(j)[0], "id")) }),
      R("sms", "sms messages get", (s) => ["sms", "messages", "get", s.msg], { needs: ["msg"] }),
      R("sms", "diagnose message", (s) => ["diagnose", "message", s.msg], { needs: ["msg"] }),
      R("sms", "sms conversations list", ["sms", "conversations", "list", "--limit", "2"]),
      R("sms", "sms conversations unread-count", ["sms", "conversations", "unread-count"]),
      R("sms", "sms opt-outs list", ["sms", "opt-outs", "list"]),
      R("sms", "sms opt-outs check", (s) => ["sms", "opt-outs", "check", s.smsNumber], { needs: ["smsNumber"], check: (j) => (field(j, "optedOut") === true ? "already opted out before the test" : undefined) }),
      W("sms", "sms opt-outs add", (s) => ["sms", "opt-outs", "add", s.smsNumber, "--reason", PREFIX], {
        needs: ["smsNumber"],
        undo: (s) => ({ group: "sms", phase: "cleanup", cmd: "sms opt-outs remove", args: () => ["sms", "opt-outs", "remove", s.smsNumber, "--yes"] }),
        undoKey: "optout",
      }),
      R("sms", "sms opt-outs check", (s) => ["sms", "opt-outs", "check", s.smsNumber], { needs: ["smsNumber"], check: (j) => (field(j, "optedOut") === true ? undefined : "not opted out after add") }),
      W("sms", "sms opt-outs remove", (s) => ["sms", "opt-outs", "remove", s.smsNumber], { needs: ["smsNumber"], resolves: "optout" }),
      R("sms", "sms opt-outs check", (s) => ["sms", "opt-outs", "check", s.smsNumber], { needs: ["smsNumber"], check: (j) => (field(j, "optedOut") === true ? "still opted out after remove" : undefined) }),
      R("sms", "sms webhooks list", ["sms", "webhooks", "list"]),
      W("sms", "sms webhooks create", ["sms", "webhooks", "create", "--url", `${EX}`, "--secret", `@${f.whSecret}`], {
        note: "recorded: the create response has createdAt 0001-01-01T00:00:00Z",
        capture: (j, s) => (s.wh = pick(j, "id")),
        undo: (s) => ({ group: "sms", phase: "cleanup", cmd: "sms webhooks delete", args: () => ["sms", "webhooks", "delete", s.wh, "--yes"] }),
        undoKey: "wh",
      }),
      W("sms", "sms webhooks update", (s) => ["sms", "webhooks", "update", s.wh, "--no-active", "--url", `${EX}/2`, "--event", "message.failed"], { needs: ["wh"] }),
      R("sms", "sms webhooks get", (s) => ["sms", "webhooks", "get", s.wh], { needs: ["wh"] }),
      W("sms", "sms webhooks delete", (s) => ["sms", "webhooks", "delete", s.wh], { needs: ["wh"], resolves: "wh" }),
      R("sms", "sms broadcasts list", ["sms", "broadcasts", "list", "--limit", "5"], { capture: (j, s) => (s.existingBc = pick(rows(j).find((x) => !starts(x?.name)), "id")) }),
      R("sms", "sms broadcasts get", (s) => ["sms", "broadcasts", "get", s.existingBc], { needs: ["existingBc"] }),
      W("sms", "sms broadcasts create", (s) => ["sms", "broadcasts", "create", "--name", `${PREFIX}-broadcast`, "--from", s.smsNumber, "--template", "cli-verify draft, never launched", "--rate", "1", "--tag", PREFIX], {
        needs: ["smsNumber"],
        note: "draft; never launched, no recipients",
        capture: (j, s) => (s.bc = pick(j, "id", "broadcast.id")),
        undo: (s) => ({ group: "sms", phase: "cleanup", cmd: "sms broadcasts delete", args: () => ["sms", "broadcasts", "delete", s.bc, "--yes"] }),
        undoKey: "bc",
      }),
      W("sms", "sms broadcasts update", (s) => ["sms", "broadcasts", "update", s.bc, "--name", `${PREFIX}-broadcast-2`, "--schedule-at", "+1d"], { needs: ["bc"] }),
      W("sms", "sms broadcasts update", (s) => ["sms", "broadcasts", "update", s.bc, "--clear-schedule"], { needs: ["bc"] }),
      R("sms", "sms broadcasts preview", (s) => ["sms", "broadcasts", "preview", s.bc], { needs: ["bc"] }),
      W("sms", "sms broadcasts delete", (s) => ["sms", "broadcasts", "delete", s.bc], { needs: ["bc"], resolves: "bc" }),
      gone("sms", "sms broadcasts get", (s) => ["sms", "broadcasts", "get", s.bc], ["bc"]),
      R("sms", "sms senders list", ["sms", "senders", "list"]),
      R("sms", "sms 10dlc brands list", ["sms", "10dlc", "brands", "list"]),
      R("sms", "sms 10dlc campaigns list", ["sms", "10dlc", "campaigns", "list"]),
      R("sms", "sms 10dlc campaigns priorities", ["sms", "10dlc", "campaigns", "priorities"]),
    );
  }

  if (want.has("local")) {
    add(
      R("local", "api", ["api", "--list", "--tag", "Trunks"]),
      R("local", "api", ["api", "--describe", "make-call"]),
      R("local", "api", ["api", "GET", "/api/v1/auth/me"], { check: (j) => (j?.auth_secret === undefined || j.auth_secret === "[redacted]" ? undefined : "auth_secret is not redacted") }),
      R("local", "xml build", ["xml", "build", "--say", "cli-verify", "--hangup"], { raw: true }),
      R("local", "completion", ["completion", "bash"], { raw: true }),
      R("local", "skills list", ["skills", "list"]),
      R("local", "docs search", ["docs", "search", "gather speech input", "--limit", "3"]),
      R("local", "mcp config", ["mcp", "config", "cursor"], { raw: true }),
    );
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------------------------
// Execution.

const PLACEHOLDER = { number: "<number>", numberApp: "<number-app>", existingApp: "<existing-app>", app: "<app>", existingTrunk: "<existing-trunk>", cred: "<cred>", trunk: "<trunk>", acl: "<acl>", uri: "<uri>", epApp: "<ep-app>", ep: "<ep>", existingSa: "<existing-sa>", sa: "<sa>", rec: "<rec>", cdr: "<cdr>", smsNumber: "<sms-number>", msg: "<msg>", wh: "<wh>", existingBc: "<existing-bc>", bc: "<bc>" };
const GLOBALS = ["--output", "json", "--verbose", "--no-update-check"];
const API_KINDS = new Set(["auth_failed", "forbidden", "not_found", "account_suspended", "rate_limited", "insufficient_balance", "service_unavailable", "backend_error", "timeout", "network_error", "outcome_unknown", "unexpected_response"]);

/** argv as shown in reports: ids replaced by <placeholders>, the temp dir by $TMP, the command words dropped. */
function display(step, argv, s, tmp) {
  const vals = Object.entries(s)
    .filter(([k, v]) => PLACEHOLDER[k] && typeof v === "string" && v.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  const rest = [...argv];
  for (const w of step.cmd.split(" ")) {
    const i = rest.indexOf(w);
    if (i >= 0) rest.splice(i, 1);
  }
  return rest
    .filter((a) => a !== "--yes")
    .map((a) => {
      let t = String(a);
      if (tmp) t = t.replaceAll(tmp, "$TMP");
      for (const [k, v] of vals) t = t.replaceAll(v, PLACEHOLDER[k]);
      return /[\s"'{}]/.test(t) ? `'${t}'` : t;
    })
    .join(" ");
}

function lastJsonError(stderr) {
  for (const line of stderr.split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      if (j && typeof j.error === "string") return j;
    } catch {}
  }
  return undefined;
}

/**
 * Verdict for one finished step. "works" | "api-differs" (Vobiz answered, but not as recorded) | "fail" (the CLI
 * did something wrong: no API answer behind a wrong exit, unusable output, or a secret in the output).
 */
export function classify(step, { code, stdout, stderr }, secrets, s) {
  const expected = [].concat(step.expect ?? 0);
  const http = [...new Set([...stderr.matchAll(/ -> (\d{3}) \(\d+ms\)/g)].map((m) => m[1]))];
  const err = lastJsonError(stderr);
  const out = { http: http.join(",") || "-", verdict: "works", notes: step.note ?? "" };
  const add = (n) => (out.notes = out.notes ? `${n}; ${out.notes}` : n);
  if (secrets.some((x) => x && (stdout.includes(x) || stderr.includes(x)))) {
    out.verdict = "fail";
    add("a secret appeared in the output");
    return out;
  }
  let json;
  if (code === 0 && !step.raw && stdout.trim()) {
    try {
      json = JSON.parse(stdout);
    } catch {
      out.verdict = "fail";
      add("stdout is not JSON");
      return out;
    }
  }
  out.json = json;
  if (expected.includes(code)) {
    const diff = code === 0 && step.check ? step.check(json, s) : undefined;
    if (diff) {
      out.verdict = "api-differs";
      add(diff);
    }
    return out;
  }
  const apiAnswered = http.length > 0 || (err && (err.status != null || API_KINDS.has(err.error)));
  out.verdict = apiAnswered ? "api-differs" : "fail";
  add(`expected exit ${expected.join("/")}, got ${code}${err ? ` (${err.error}${err.status ? ` ${err.status}` : ""})` : ""}`);
  return out;
}

/** Default runner: the built CLI in a child process. Resolves { code, stdout, stderr }. */
export function spawnRunner(bin = join(root, "dist", "index.js")) {
  return (argv, { env }) =>
    new Promise((resolveRun) => {
      const child = spawn(process.execPath, [bin, ...argv], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveRun({ code: code ?? 1, stdout, stderr });
      });
    });
}

/**
 * Runs the plan. Steps run in order; a step whose `needs` are missing is skipped. Every successful create
 * registers its undo; after the main phase (also when it throws) the cleanup phase runs every undo still
 * registered, newest first, and lists what it could not undo as leftovers.
 */
export async function execute(plan, { runner, secrets = [], env = process.env, tmp, log = () => {} }) {
  const s = {};
  const undo = new Map();
  const results = [];
  const reg = (key, step) => undo.set(key, step);
  const scrub = (t) => secrets.reduce((x, v) => (v ? x.replaceAll(v, "[redacted]") : x), t);
  const record = (step, argv, r, ms) => {
    const row = { group: step.group, phase: step.phase, command: step.cmd, arguments: display(step, argv, s, tmp), http: r.http, exit: r.exit, ms, verdict: r.verdict, notes: r.notes };
    results.push(row);
    log(`${row.verdict.padEnd(11)} ${row.group.padEnd(12)} ${row.command} ${row.arguments}`.trimEnd() + (row.notes ? `  (${row.notes})` : ""));
    return row;
  };
  const runOne = async (step) => {
    const missing = (step.needs ?? []).filter((k) => !s[k]);
    if (missing.length) {
      record(step, [], { http: "-", exit: "-", verdict: "skipped", notes: `needs ${missing.map((k) => PLACEHOLDER[k] ?? k).join(", ")} from an earlier step` }, 0);
      return undefined;
    }
    const argv = step.args(s);
    const why = forbiddenReason(argv);
    if (why) {
      record(step, argv, { http: "-", exit: "-", verdict: "fail", notes: `refused: ${why}` }, 0);
      return undefined;
    }
    step.before?.(s, reg);
    const started = Date.now();
    const r = await runner([...argv, ...GLOBALS], { env });
    const ms = Date.now() - started;
    const c = classify(step, r, secrets, s);
    record(step, argv, { http: c.http, exit: r.code, verdict: c.verdict, notes: c.notes }, ms);
    if (r.code === 0) {
      try {
        step.capture?.(c.json, s);
      } catch {}
      if (step.undo && step.undoKey && s[step.undoKey]) reg(step.undoKey, step.undo(s));
      if (step.resolves) undo.delete(step.resolves);
    }
    return { code: r.code, json: c.json };
  };

  let crashed;
  try {
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      const r = await runOne(step);
      if (r?.code === 0 && step.expand) plan.splice(i + 1, 0, ...step.expand(r.json, s));
    }
  } catch (e) {
    crashed = scrub(e instanceof Error ? e.message : String(e));
    results.push({ group: "-", phase: "run", command: "(runner)", arguments: "", http: "-", exit: "-", ms: 0, verdict: "fail", notes: `run aborted: ${crashed}` });
    log(`fail        run aborted: ${crashed}`);
  }
  // Cleanup, also after a crash: newest undo first; an undo that answers 404 counts as already clean.
  const leftovers = [];
  for (const [key, step] of [...undo.entries()].reverse()) {
    let row;
    try {
      await runOne({ ...step, expect: [0, 4] });
      row = results[results.length - 1];
    } catch (e) {
      row = { verdict: "fail", notes: scrub(e instanceof Error ? e.message : String(e)) };
      results.push({ group: step.group, phase: "cleanup", command: step.cmd, arguments: "", http: "-", exit: "-", ms: 0, verdict: "fail", notes: row.notes });
    }
    if (row.verdict !== "works") leftovers.push({ key, what: PLACEHOLDER[key] ?? key, command: `vobiz ${scrub(step.args(s).join(" "))}`, notes: row.notes });
  }
  return { steps: results, leftovers, crashed };
}

export function exitCodeFor({ steps, leftovers }) {
  if (leftovers.length || steps.some((r) => r.verdict === "fail")) return 1;
  if (steps.some((r) => r.verdict === "api-differs")) return 2;
  return 0;
}

const VERDICT_TEXT = { works: "works", "api-differs": "API differs from recording", fail: "FAIL", skipped: "skipped" };
const cell = (v) => String(v ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");

export function renderSummary(report) {
  const { steps, leftovers } = report;
  const n = (v) => steps.filter((r) => r.verdict === v).length;
  const lines = [
    `# Live verification ${report.date}`,
    "",
    `Exit ${report.exit} (${["all works", "CLI failure or leftovers", "API changed", "did not run"][report.exit]}). ${steps.length} steps: ${n("works")} works, ${n("api-differs")} API differs, ${n("fail")} fail, ${n("skipped")} skipped. Groups: ${report.groups.join(", ")}.`,
    "",
    "Verdicts: works / API differs from recording (exit 2: Vobiz changed) / FAIL (exit 1: we broke it) / skipped. HTTP `-` = no request.",
  ];
  const sections = [...new Set(steps.map((r) => (r.phase === "cleanup" ? "cleanup" : r.group)))];
  for (const g of sections) {
    lines.push("", `## ${g}`, "", "| command | arguments | HTTP | exit | ms | verdict | notes |", "|---|---|---|---|---|---|---|");
    for (const r of steps.filter((x) => (x.phase === "cleanup" ? "cleanup" : x.group) === g))
      lines.push(`| \`${cell(r.command)}\` | ${r.arguments ? `\`${cell(r.arguments)}\`` : ""} | ${r.http} | ${r.exit} | ${r.ms} | ${VERDICT_TEXT[r.verdict] ?? r.verdict} | ${cell(r.notes)} |`);
  }
  lines.push("", "## Leftovers", "");
  if (!leftovers.length) lines.push("None: every resource this run created was deleted and the number routing was restored.");
  else for (const l of leftovers) lines.push(`- ${l.what}: the undo did not work (${cell(l.notes)}). Check and remove by hand: \`${cell(l.command)}\``);
  return lines.join("\n") + "\n";
}

export function renderPlan(plan) {
  return plan
    .map((st) => {
      const argv = st.args(new Proxy({}, { get: (_t, k) => PLACEHOLDER[k] ?? `<${String(k)}>` }));
      const flags = [st.expect !== undefined ? `expect exit ${[].concat(st.expect).join("/")}` : "", st.undoKey ? `undo: ${st.undoKey}` : "", st.expand ? "then deletes matches" : ""].filter(Boolean).join(", ");
      const why = forbiddenReason(argv);
      return `${st.group.padEnd(12)} ${st.phase.padEnd(6)} vobiz ${argv.join(" ")}${flags ? `   [${flags}]` : ""}${why ? `   REFUSED: ${why}` : ""}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// CLI entry.

export function parseArgs(argv) {
  const o = { only: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--report") o.report = argv[++i];
    else if (a === "--summary") o.summary = argv[++i];
    else if (a === "--only") o.only.push(...String(argv[++i] ?? "").split(",").filter(Boolean));
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  const bad = o.only.filter((g) => !GROUPS.includes(g));
  if (bad.length) throw new Error(`unknown group ${bad.join(", ")}; groups: ${GROUPS.join(", ")}`);
  if ((o.report === undefined && argv.includes("--report")) || (o.summary === undefined && argv.includes("--summary"))) throw new Error("--report and --summary take a file path");
  return o;
}

async function authMeSecrets(token) {
  const out = [];
  try {
    const { isSecretKey } = await import(pathToFileURL(join(root, "dist", "core", "redact.js")).href);
    const base = (process.env.VOBIZ_BASE_URL ?? "https://api.vobiz.ai").replace(/\/+$/, "");
    const res = await fetch(`${base}/api/v1/auth/me`, { headers: { "X-Auth-ID": process.env.VOBIZ_AUTH_ID, "X-Auth-Token": token, Accept: "application/json" } });
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (isObj(v)) for (const [k, x] of Object.entries(v)) isSecretKey(k) && typeof x === "string" && x.length >= 4 ? out.push(x) : walk(x);
    };
    if (res.ok) walk(await res.json());
  } catch {}
  return out;
}

export async function main(argv = process.argv.slice(2), io = { log: (l) => console.log(l), error: (l) => console.error(l) }) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    io.error(`live-verify: ${e.message}`);
    return 3;
  }
  if (o.help) {
    io.log("usage: node scripts/live-verify.mjs [--dry-run] [--only <group,...>] [--report <file.json>] [--summary <file.md>]\ngroups: " + GROUPS.join(", "));
    return 0;
  }
  if (o.dryRun) {
    io.log(renderPlan(buildPlan({ only: o.only, files: { pw1: "$TMP/pw1", pw2: "$TMP/pw2", epPw: "$TMP/ep-pw", whSecret: "$TMP/wh-secret", dir: "$TMP" } })));
    return 0;
  }
  const token = process.env.VOBIZ_AUTH_TOKEN;
  if (!process.env.VOBIZ_AUTH_ID || !token || token === "YOUR_AUTH_TOKEN") {
    io.error("live-verify: set VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN (a test account, never a production one).");
    return 3;
  }
  const tmp = mkdtempSync(join(tmpdir(), "vobiz-verify-"));
  const gen = (n) => `Cv${randomBytes(n).toString("hex")}!9a`;
  const files = { pw1: join(tmp, "pw1"), pw2: join(tmp, "pw2"), epPw: join(tmp, "ep-pw"), whSecret: join(tmp, "wh-secret"), dir: tmp };
  const generated = [gen(8), gen(8), gen(8), gen(16)];
  [files.pw1, files.pw2, files.epPw, files.whSecret].forEach((p, i) => writeFileSync(p, generated[i], { mode: 0o600 }));
  const secrets = [token, ...(await authMeSecrets(token)), ...generated];
  const configDir = join(tmp, "config");
  const env = { ...process.env, VOBIZ_CONFIG_DIR: configDir, VOBIZ_NO_UPDATE_CHECK: "1", NO_COLOR: "1", VOBIZ_YES: "", VOBIZ_OUTPUT: "" };
  const groups = o.only.length ? o.only : GROUPS;
  const started = new Date();
  let res;
  try {
    res = await execute(buildPlan({ only: groups, files }), { runner: spawnRunner(), secrets, env, tmp, log: io.log });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const steps = res.steps.map(({ json: _j, ...r }) => r);
  const report = { date: started.toISOString().slice(0, 10), started: started.toISOString(), finished: new Date().toISOString(), groups, exit: 0, steps, leftovers: res.leftovers };
  report.exit = exitCodeFor(report);
  const outputs = [];
  if (o.report) outputs.push([resolve(o.report), JSON.stringify(report, null, 2) + "\n"]);
  if (o.summary) outputs.push([resolve(o.summary), renderSummary(report)]);
  for (const [p, text] of outputs) {
    if (secrets.some((x) => text.includes(x))) {
      io.error(`live-verify: a secret value would have been written to ${p}; nothing was written.`);
      return 1;
    }
    writeFileSync(p, text);
  }
  for (const [p] of outputs) {
    const back = readFileSync(p, "utf8");
    if (secrets.some((x) => back.includes(x))) {
      rmSync(p, { force: true });
      io.error(`live-verify: a secret value was found in ${p}; the file was deleted.`);
      return 1;
    }
  }
  const n = (v) => steps.filter((r) => r.verdict === v).length;
  io.log(`${steps.length} steps: ${n("works")} works, ${n("api-differs")} API differs, ${n("fail")} fail, ${n("skipped")} skipped; ${res.leftovers.length} leftover(s). Exit ${report.exit}.`);
  return report.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code));
}
