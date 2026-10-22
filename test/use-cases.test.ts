/**
 * End-to-end workflows, each named after what a developer is trying to do. Every scenario runs the real command
 * tree in-process against a fake API (no network, no real credentials) and checks the requests that would be sent.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { pollSettings } from "../src/commands/sms/messages.js";
import { bundledSkills } from "../src/commands/skills.js";
import { baseUrlOf, signBody, signV2, signV3 } from "../src/agent/webhooks.js";
import { TEST_AUTH_ID, TEST_AUTH_TOKEN, fakeFetch, makeCtx, reply, runCli, textReply, type RecordedRequest } from "./helpers.js";
import { specFake } from "./spec-fake.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const ME = { name: "Acme Telecom", auth_id: TEST_AUTH_ID, email: "ops@example.com" };
const UUID = "2ded13fe-4f9b-4958-9bfb-093ea2f29f91";

/** Runs several commands against one ctx (one config dir), returning each command's output. */
async function session(t: ReturnType<typeof makeCtx>, argv: string[]) {
  t.stdout.text = "";
  t.stderr.text = "";
  const code = await run(argv, t.ctx);
  return { code, out: t.stdout.text, err: t.stderr.text, json: () => JSON.parse(t.stdout.text) };
}

describe("getting started", () => {
  it("first run: login with a token from a secrets manager, then whoami --check", async () => {
    const api = fakeFetch({ "GET /api/v1/auth/me": ME });
    const t = makeCtx({ loggedOut: true, fetch: api.fetch, stdin: `${TEST_AUTH_ID}:${TEST_AUTH_TOKEN}\n` });
    const before = await session(t, ["whoami"]);
    expect(before.code).toBe(3);
    expect(before.err).toContain("vobiz login");

    const login = await session(t, ["login", "--with-token", "--json"]);
    expect(login.code, login.err).toBe(0);
    expect(login.json()).toMatchObject({ profile: "default", auth_id: TEST_AUTH_ID, account_name: "Acme Telecom", default: true });

    const who = await session(t, ["whoami", "--json"]);
    expect(who.json()).toMatchObject({ auth_id: TEST_AUTH_ID, source: "profile", profile: "default" });
    expect(api.calls).toHaveLength(1); // whoami without --check is offline

    const check = await session(t, ["whoami", "--check", "--json"]);
    expect(check.json()).toMatchObject({ verified: true });
    expect(api.calls).toHaveLength(2);
    expect(api.last().headers["x-auth-id"]).toBe(TEST_AUTH_ID);
  });

  it("first run on a laptop: interactive login prompts for the Auth ID and a hidden token", async () => {
    const r = await runCli(["login"], { loggedOut: true, stdinTTY: true, fetch: fakeFetch({ "GET /api/v1/auth/me": ME }).fetch, prompts: { input: [TEST_AUTH_ID], password: [TEST_AUTH_TOKEN] } });
    expect(r.code, r.err).toBe(0);
    expect(r.store.getProfile("default")).toMatchObject({ authId: TEST_AUTH_ID, accountName: "Acme Telecom" });
  });

  it("CI: env credentials, --yes and --output json, no prompts, no update check, data-only stdout", async () => {
    const api = specFake();
    const env = { VOBIZ_AUTH_ID: TEST_AUTH_ID, VOBIZ_AUTH_TOKEN: TEST_AUTH_TOKEN, CI: "true" };
    const list = await runCli(["numbers", "list", "--output", "json"], { fetch: api.fetch, env });
    expect(list.code).toBe(0);
    expect(() => JSON.parse(list.out)).not.toThrow();
    const hang = await runCli(["calls", "hangup", UUID, "--yes", "--output", "json"], { fetch: api.fetch, env });
    expect(hang.code, hang.err).toBe(0);
    expect(hang.json()).toEqual({ call_uuid: UUID, hung_up: true });
    expect(api.calls.every((c) => new URL(c.url).host === "api.vobiz.ai")).toBe(true);
    expect(api.ops()).toEqual(["list-numbers", "hangup-call"]);
  });

  it("CI: VOBIZ_YES and VOBIZ_OUTPUT replace the flags", async () => {
    const api = specFake();
    const r = await runCli(["recordings", "delete", "r1"], { fetch: api.fetch, env: { VOBIZ_YES: "1", VOBIZ_OUTPUT: "json" } });
    expect(r.code, r.err).toBe(0);
    expect(r.json()).toEqual({ recording_id: "r1", deleted: true });
  });

  it("switching profiles: --profile, VOBIZ_PROFILE and `profiles use` each pick the account", async () => {
    const api = specFake();
    const t = makeCtx({ loggedOut: true, fetch: api.fetch });
    t.store.setProfile("prod", { authId: "MA_PROD0001", authToken: "TOKEN_PROD" });
    t.store.setProfile("staging", { authId: "MA_STAG0001", authToken: "TOKEN_STAG" });
    t.store.patchSettings({ defaultProfile: "prod" });

    await session(t, ["account", "concurrency", "--json"]);
    expect(api.last().path).toBe("/api/v1/Account/MA_PROD0001/concurrency");
    await session(t, ["account", "concurrency", "--profile", "staging", "--json"]);
    expect(api.last().path).toBe("/api/v1/Account/MA_STAG0001/concurrency");
    expect(api.last().headers["x-auth-token"]).toBe("TOKEN_STAG");

    expect((await session(t, ["profiles", "use", "staging"])).code).toBe(0);
    await session(t, ["account", "concurrency", "--json"]);
    expect(api.last().path).toBe("/api/v1/Account/MA_STAG0001/concurrency");

    const list = await session(t, ["profiles", "list", "--json"]);
    expect(list.json().map((p: { name: string }) => p.name)).toEqual(["prod", "staging"]);
    expect((await session(t, ["profiles", "use", "nope"])).code).toBe(4);
  });

  it("switching profiles: env credentials beat the saved default", async () => {
    const api = specFake();
    const t = makeCtx({ fetch: api.fetch });
    t.store.setProfile("default", { authId: "MA_SAVED001", authToken: "TOKEN_SAVED" });
    await session(t, ["account", "concurrency", "--json"]);
    expect(api.last().path).toBe(`${A}/concurrency`);
  });

  it("doctor --offline before anything else works without credentials", async () => {
    const r = await runCli(["doctor", "--offline", "--json"], { loggedOut: true });
    expect(r.json<{ check: string }[]>().map((c) => c.check)).toContain("credentials");
  });
});

describe("voice", () => {
  it("make a call and wait until it ends: queued -> live -> CDR", async () => {
    let n = 0;
    const api = fakeFetch({
      [`POST ${A}/Call/`]: reply(201, { api_id: "a1", message: "call fired", request_uuid: UUID }),
      [`GET ${A}/Call/${UUID}/`]: () => (n < 2 ? { call_status: "queued" } : reply(404, {})),
      [`GET ${A}/Call/${UUID}`]: () => (++n < 2 ? reply(404, {}) : n < 4 ? { call_uuid: UUID, call_status: "in-progress" } : reply(404, {})),
      [`GET ${A}/cdr/${UUID}`]: () => (n < 5 ? reply(404, {}) : { data: { uuid: UUID, duration: 42, billsec: 40, hangup_cause: "NORMAL_CLEARING" } }),
    });
    const r = await runCli(
      ["calls", "create", "--to", "+919876543210", "--from", "+918012345678", "--answer-url", "https://app.example.com/answer", "--wait", "--interval", "0.01", "--yes", "--json"],
      { fetch: api.fetch },
    );
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/queued[\s\S]*in-progress[\s\S]*ended/);
    expect(r.json()).toMatchObject({ request_uuid: UUID, status: "ended", cdr: { duration: 42, hangup_cause: "NORMAL_CLEARING" } });
    expect(api.calls[0]).toMatchObject({ method: "POST", body: { to: "+919876543210", from: "+918012345678", answer_url: "https://app.example.com/answer" } });
  });

  it("place a call that speaks a message, previewing the XML first", async () => {
    const xml = await runCli(["calls", "create", "--say", "Your OTP is 1 2 3 4", "--xml-only"]);
    expect(xml.out).toContain("<Speak");
    expect(xml.out).toContain("Your OTP is 1 2 3 4");
  });

  it("list live calls and hang every one up", async () => {
    const api = fakeFetch({ [`GET ${A}/Call`]: { calls: ["c1", "c2", "c3"] }, [`DELETE ${A}/Call/c1`]: reply(204), [`DELETE ${A}/Call/c2`]: reply(204), [`DELETE ${A}/Call/c3`]: reply(204) });
    const ids = (await runCli(["calls", "list", "--quiet"], { fetch: api.fetch })).out.trim().split("\n");
    expect(ids).toEqual(["c1", "c2", "c3"]);
    for (const id of ids) expect((await runCli(["calls", "hangup", id, "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(ids.map((id) => `${A}/Call/${id}`));
  });

  it("record a live call, then stop the recording", async () => {
    const api = specFake();
    expect((await runCli(["calls", "record", "start", UUID, "--format", "mp3", "--time-limit", "300", "--yes", "--json"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last().body).toMatchObject({ file_format: "mp3", time_limit: 300 });
    expect((await runCli(["calls", "record", "stop", UUID, "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.ops()).toEqual(["start-recording", "stop-recording"]);
  });

  it("send DTMF to navigate a remote IVR", async () => {
    const api = specFake();
    const r = await runCli(["calls", "dtmf", UUID, "--digits", "1w2w#", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.last()).toMatchObject({ method: "POST", path: `${A}/Call/${UUID}/DTMF/`, body: { digits: "1w2w#" } });
  });

  it("stream call audio to a WebSocket URL for an AI agent", async () => {
    const api = specFake({ answer: (op) => (op.id === "start-stream" ? { stream_id: "str_1", message: "streaming" } : undefined) });
    const r = await runCli(["calls", "stream", "start", UUID, "--url", "wss://agent.example.com/media", "--bidirectional", "--track", "both", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.last()).toMatchObject({ method: "POST", path: `${A}/Call/${UUID}/Stream/`, body: { service_url: "wss://agent.example.com/media", bidirectional: true, audio_track: "both" } });
    expect(r.json()).toMatchObject({ stream_id: "str_1" });
    expect(r.err).toContain("agent.example.com");
    const stop = await runCli(["calls", "stream", "stop", UUID, "str_1", "--yes"], { fetch: api.fetch });
    expect(stop.code).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", path: `${A}/Call/${UUID}/Stream/str_1/` });
  });

  it("mute everyone in a conference, then unmute one speaker", async () => {
    const api = specFake();
    const R = `${A}/Conference/All%20Hands`;
    const mute = await runCli(["conferences", "members", "mute", "All Hands", "all", "--yes", "--json"], { fetch: api.fetch });
    expect(mute.code, mute.err).toBe(0);
    expect(api.last()).toMatchObject({ method: "POST", path: `${R}/Member/all/Mute/` });
    expect((await runCli(["conferences", "members", "unmute", "All Hands", "17", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", path: `${R}/Member/17/Mute/` });
  });

  it("record a conference and end it", async () => {
    const api = specFake();
    expect((await runCli(["conferences", "record", "start", "Standup", "--format", "wav", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect((await runCli(["conferences", "end", "Standup", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.ops()).toEqual(["start-conference-recording", "delete-conference"]);
  });

  it("export CDRs for last week to CSV", async () => {
    const csv = "uuid,start_time,duration\nc1,2026-10-16 10:00:00,30\nc2,2026-10-20 11:00:00,12\n";
    const api = specFake({ answer: (op) => (op.id === "export-cdrs" ? textReply(200, csv, { "content-type": "text/csv" }) : undefined) });
    const out = join(tmp("vobiz-cdr-"), "last-week.csv");
    const now = () => new Date(2026, 9, 22, 12, 0, 0);
    const r = await runCli(["cdr", "export", "--from", "7d", "--direction", "outbound", "--out", out, "--json"], { fetch: api.fetch, now });
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(csv);
    expect(api.last().query).toMatchObject({ start_date: "2026-10-15", end_date: "2026-10-22", call_direction: "outbound" });
    expect(api.last().headers.accept).toBe("text/csv");
    expect(r.json()).toEqual({ file: out, bytes: csv.length });
    const stdout = await runCli(["cdr", "export", "--from", "yesterday", "--to", "today"], { fetch: api.fetch, now });
    expect(stdout.out).toBe(csv);
  });

  it("find yesterday's unanswered calls in the CDRs", async () => {
    const api = specFake({ answer: (op) => (op.id === "list-cdrs" ? { data: [{ uuid: "c9", hangup_cause: "NO_ANSWER" }], pagination: { has_next: false, total: 1 } } : undefined) });
    const r = await runCli(["cdr", "list", "--from", "yesterday", "--to", "yesterday", "--hangup-cause", "NO_ANSWER", "-q"], { fetch: api.fetch, now: () => new Date(2026, 9, 22, 9) });
    expect(r.out).toBe("c9\n");
    expect(api.last().query).toMatchObject({ start_date: "2026-10-21", end_date: "2026-10-21", hangup_cause: "NO_ANSWER" });
  });

  it("download a recording to a file and to stdout", async () => {
    const bytes = new Uint8Array([73, 68, 51, 4, 0, 0]);
    const api = specFake({ answer: (op) => (op.id === "get-recording" ? { recording_id: "r1", recording_format: "mp3", recording_url: "https://media.vobiz.ai/rec/r1.mp3" } : undefined) });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://media.vobiz.ai/")) return new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg" } });
      return api.fetch(input, init);
    };
    const out = join(tmp("vobiz-rec-"), "call.mp3");
    const r = await runCli(["recordings", "download", "r1", "--out", out, "--json"], { fetch });
    expect(r.code, r.err).toBe(0);
    expect(new Uint8Array(readFileSync(out))).toEqual(bytes);
    expect(r.json()).toEqual({ recording_id: "r1", file: out, bytes: bytes.length });
    const again = await runCli(["recordings", "download", "r1", "--out", out], { fetch });
    expect(again.code).toBe(2);
    expect((await runCli(["recordings", "download", "r1", "--out", out, "--force"], { fetch })).code).toBe(0);
    const piped = await runCli(["recordings", "download", "r1", "--out", "-"], { fetch });
    expect(piped.code).toBe(0);
    expect(piped.out.length).toBeGreaterThan(0);
  });

  it("queue a bulk recording export emailed to the ops team", async () => {
    const api = specFake();
    const r = await runCli(["recordings", "export", "--email", "ops@example.com", "--email", "qa@example.com", "--min-age-days", "1", "--max-age-days", "7", "--format", "wav", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.last().body).toMatchObject({ recipient: { customer_account: ["ops@example.com", "qa@example.com"] }, recording_storage_duration__gte: "1", recording_storage_duration__lte: "7", recording_format: "wav" });
  });

  it("check balance and concurrency before a campaign", async () => {
    const api = specFake({ answer: (op) => (op.id === "get-concurrency" ? { concurrent_calls_limit: 10, active_calls: 2 } : undefined) });
    expect((await runCli(["account", "balance", "--json"], { fetch: api.fetch })).code).toBe(0);
    const c = await runCli(["account", "concurrency", "--json"], { fetch: api.fetch });
    expect(c.json()).toMatchObject({ concurrent_calls_limit: 10 });
  });
});

describe("numbers and SIP trunking", () => {
  const E = "+918065550100";
  const inventory = { items: [{ id: "i1", e164: E, country: "IN", region: "Bengaluru", setup_fee: 100, monthly_fee: 300, currency: "INR" }], page: 1, per_page: 100, total: 1 };

  it("search for a number, buy it, then assign it to a trunk", async () => {
    const api = specFake({
      answer: (op) =>
        op.id === "list-inventory-numbers" ? inventory : op.id === "purchase-from-inventory" ? { message: "Number purchased", number: { ...inventory.items[0], account_id: TEST_AUTH_ID } } : undefined,
    });
    const found = await runCli(["numbers", "search", "--country", "IN", "--contains", "80", "--json"], { fetch: api.fetch });
    expect(found.code, found.err).toBe(0);
    const e164 = (await runCli(["numbers", "search", "--country", "IN", "-q", "--fields", "e164"], { fetch: api.fetch })).out.trim();
    expect(e164).toBe(E);

    const buy = await runCli(["numbers", "buy", e164, "--yes", "--json"], { fetch: api.fetch });
    expect(buy.code, buy.err).toBe(0);
    expect(buy.err).toContain("INR 100 setup now, then INR 300/month");

    const assign = await runCli(["numbers", "assign", e164, "--trunk", "trunk-123", "--yes"], { fetch: api.fetch });
    expect(assign.code, assign.err).toBe(0);
    expect(api.last()).toMatchObject({ method: "POST", path: `${A}/numbers/%2B918065550100/assign`, body: { trunk_group_id: "trunk-123" } });
    expect(api.ops().filter((o) => o !== "list-inventory-numbers")).toEqual(["purchase-from-inventory", "assign-number-to-trunk"]);
  });

  it("release a number by mistake, then cancel the release within the cooldown", async () => {
    const api = specFake({ answer: (op) => (op.id === "unrent-number" ? { status: "pending_release", cancel_url: "x", cooldown_ends_at: "2026-10-23T10:00:00Z" } : undefined) });
    expect((await runCli(["numbers", "release", E, "--yes", "--json"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last().query.immediate).toBeUndefined();
    expect((await runCli(["numbers", "cancel-release", E, "--yes", "--json"], { fetch: api.fetch })).code).toBe(0);
    expect(api.ops()).toEqual(["unrent-number", "cancel-number-release"]);
  });

  it("create a trunk that authenticates with a SIP credential and an IP ACL", async () => {
    const api = specFake({
      answer: (op) =>
        op.id === "create-credential"
          ? { id: "cred-1", username: "pbx_01", password: "<redacted>" }
          : op.id === "create-ip-acl"
            ? { id: "acl-1", ip_address: "203.0.113.10" }
            : op.id === "create-trunk"
              ? { trunk_id: "trunk-1", name: "Office PBX" }
              : undefined,
    });
    const cred = await runCli(["trunks", "credentials", "create", "--username", "pbx_01", "--password", "Str0ng-Passw0rd!", "--yes", "--json"], { fetch: api.fetch });
    expect(cred.code, cred.err).toBe(0);
    expect(api.last().body).toEqual({ username: "pbx_01", password: "Str0ng-Passw0rd!" });
    const credId = cred.json().id;

    const acl = await runCli(["trunks", "ip-acl", "create", "--name", "office", "--ip-address", "203.0.113.10", "--yes", "-q"], { fetch: api.fetch });
    expect(acl.out.trim()).toBe("acl-1");

    const trunk = await runCli(
      ["trunks", "create", "--name", "Office PBX", "--trunk-direction", "outbound", "--credential-uuid", credId, "--ipacl-uuid", "acl-1", "--transport", "tls", "--yes", "--json"],
      { fetch: api.fetch },
    );
    expect(trunk.code, trunk.err).toBe(0);
    expect(api.last().body).toMatchObject({ name: "Office PBX", trunk_direction: "outbound", credential_uuid: "cred-1", ipacl_uuid: "acl-1", transport: "tls" });
    expect(trunk.err).toContain("Created trunk trunk-1");
    expect(api.ops()).toEqual(["create-credential", "create-ip-acl", "create-trunk"]);
  });

  it("rotate a SIP credential's password", async () => {
    const api = specFake();
    const r = await runCli(["trunks", "credentials", "update", "cred-1", "--password", "N3w-Passw0rd!", "--yes"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("password: (changed)");
    expect(r.err).not.toContain("N3w-Passw0rd!");
    expect(api.last()).toMatchObject({ method: "PUT", body: { password: "N3w-Passw0rd!" } });
  });

  it("point inbound calls at a PBX with an origination URI", async () => {
    const api = specFake();
    const r = await runCli(["trunks", "origination-uris", "create", "--uri", "sip:pbx.example.com:5060", "--description", "primary", "--priority", "1", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.last().body).toEqual({ uri: "sip:pbx.example.com:5060", description: "primary", priority: 1 });
  });

  it("create a trunk from a JSON file and override one field", async () => {
    const dir = tmp("vobiz-body-");
    writeFileSync(join(dir, "trunk.json"), JSON.stringify({ name: "From file", trunk_direction: "inbound", description: "x" }));
    const api = specFake();
    const r = await runCli(["trunks", "create", "--body", `@${join(dir, "trunk.json")}`, "--name", "Overridden", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.last().body).toEqual({ name: "Overridden", trunk_direction: "inbound", description: "x" });
  });

  it("a WebRTC softphone: create an application, then an endpoint on it", async () => {
    const api = specFake({ answer: (op) => (op.id === "create-application" ? { app_id: "12345", app_name: "softphone" } : undefined) });
    const app = await runCli(["apps", "create", "--app-name", "softphone", "--answer-url", "https://app.example.com/answer", "--answer-method", "POST", "--yes", "--json"], { fetch: api.fetch });
    expect(app.code, app.err).toBe(0);
    const ep = await runCli(["endpoints", "create", "--username", "desk_01", "--password", "Desk-Passw0rd!", "--alias", "Front desk", "--app-id", "12345", "--yes", "--json"], { fetch: api.fetch });
    expect(ep.code, ep.err).toBe(0);
    expect(api.last().body).toMatchObject({ username: "desk_01", alias: "Front desk", app_id: "12345" });
  });
});

describe("sub-accounts and partners", () => {
  it("set up a sub-account and run KYC in Test Mode", async () => {
    const api = specFake({
      answer: (op) =>
        op.id === "create-subaccount"
          ? { sub_account: { auth_id: "SA_ACME0001", name: "Acme" }, auth_credentials: { auth_id: "SA_ACME0001", auth_token: "sub-token-xyz" } }
          : op.id.startsWith("mock-")
            ? { status: "verified", mock: true }
            : op.id === "get-subaccount-kyc-status"
              ? { kyc_status: "verified" }
              : undefined,
    });
    const created = await runCli(["sub-accounts", "create", "--name", "Acme", "--kyc-mode", "customer_use", "--yes", "--json"], { fetch: api.fetch });
    expect(created.code, created.err).toBe(0);
    expect(created.out).not.toContain("sub-token-xyz");
    const sa = created.json().sub_account.auth_id;

    const pan = await runCli(["sub-accounts", "kyc", "--test", "verify-pan", sa, "--pan", "ABCDE1234F", "--yes", "--json"], { fetch: api.fetch });
    expect(pan.code, pan.err).toBe(0);
    expect(pan.err).toContain("TEST MODE");
    expect(api.last().path).toBe(`/api/v1/sub-accounts/test/${sa}/kyc/verify-pan`);

    const fin = await runCli(["sub-accounts", "kyc", "--test", "finalize-pending", sa, "--verification-type", "pan", "--outcome", "verified", "--yes", "--json"], { fetch: api.fetch });
    expect(fin.code, fin.err).toBe(0);
    expect(api.last().body).toMatchObject({ verification_type: "pan", outcome: "verified" });

    const status = await runCli(["sub-accounts", "kyc", "status", sa, "--json"], { fetch: api.fetch });
    expect(status.json()).toEqual({ kyc_status: "verified" });
    expect(api.ops()).toEqual(["create-subaccount", "mock-verify-subaccount-pan", "mock-finalize-pending-kyc", "get-subaccount-kyc-status"]);

    // Test-only and live-only commands refuse the wrong mode.
    expect((await runCli(["sub-accounts", "kyc", "finalize-pending", sa, "--verification-type", "pan", "--outcome", "verified", "--yes"], { fetch: api.fetch })).code).toBe(2);
    expect((await runCli(["sub-accounts", "kyc", "--test", "status", sa], { fetch: api.fetch })).code).toBe(2);
  });

  it("send a sub-account owner a hosted KYC link", async () => {
    const api = specFake();
    const r = await runCli(["sub-accounts", "kyc", "session", "create", "SA_ACME0001", "--flow-type", "email", "--customer-email", "owner@example.com", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.last().body).toMatchObject({ account_auth_id: "SA_ACME0001", flow_type: "email", customer_email: "owner@example.com" });
  });

  it("give a sub-account its own number", async () => {
    const api = specFake();
    const r = await runCli(["numbers", "assign-subaccount", "+919876543210", "--sub-account", "SA_ACME0001", "--yes"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.ops()).toEqual(["assign-did-to-subaccount"]);
  });

  it("a partner tops up a customer's balance and checks their calls", async () => {
    const api = specFake();
    const t = await runCli(["partner", "accounts", "transfer-balance", "MA_CUST0001", "--amount", "500", "--currency", "INR", "--yes", "--json"], { fetch: api.fetch });
    expect(t.code, t.err).toBe(0);
    expect(api.last().body).toMatchObject({ amount: 500, currency: "INR" });
    const cdrs = await runCli(["partner", "accounts", "cdrs", "MA_CUST0001", "--call-direction", "outbound", "--limit", "5", "--json"], { fetch: api.fetch });
    expect(cdrs.code, cdrs.err).toBe(0);
    expect(api.last().query).toMatchObject({ call_direction: "outbound" });
  });
});

describe("messaging", () => {
  beforeEach(() => void (pollSettings.intervalMs = 1));
  afterEach(() => void (pollSettings.intervalMs = 2000));

  it("send an SMS to three recipients and wait for delivery", async () => {
    const statuses: Record<string, number> = {};
    let n = 0;
    const api = fakeFetch({
      "GET /messages/cost-preview": { channel: "sms", segmentCount: 1, unitCost: 0.01, totalCost: 0.01, currency: "USD" },
      "POST /messages": (req: RecordedRequest) => reply(201, { id: `msg_${++n}`, to: (req.body as { to: string[] }).to[0], status: "queued" }),
      ...Object.fromEntries(
        [1, 2, 3].map((i) => [`GET /messages/msg_${i}`, () => ({ id: `msg_${i}`, status: (statuses[i] = (statuses[i] ?? 0) + 1) < 2 ? "sent" : "delivered" })]),
      ),
    });
    const r = await runCli(["sms", "send", "--from", "+14155550100", "--to", "+14155550123,+14155550124", "--to", "+14155550125", "--text", "Your order shipped", "--wait", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts.map((p) => (p.body as { to: string[] }).to[0])).toEqual(["+14155550123", "+14155550124", "+14155550125"]);
    expect(new Set(posts.map((p) => (p.body as { idempotencyKey: string }).idempotencyKey)).size).toBe(3);
    const out = r.json();
    expect(out.messages.map((m: { status: string }) => m.status)).toEqual(["delivered", "delivered", "delivered"]);
    expect(r.err).toContain("USD 0.03 for 3 recipients");
  });

  it("preview the cost of a message before sending", async () => {
    const api = specFake({ answer: (op) => (op.id === "preview-message-cost" ? { totalCost: 0.0079, currency: "USD", segmentCount: 1 } : undefined) });
    const r = await runCli(["sms", "cost", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hello", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(r.json()).toMatchObject({ totalCost: 0.0079 });
  });

  it("honour a STOP: add an opt-out, check it, remove it", async () => {
    const api = specFake();
    for (const argv of [["add", "+14155550123", "--reason", "STOP"], ["check", "+14155550123"], ["remove", "+14155550123"]]) {
      const r = await runCli(["sms", "opt-outs", ...argv, "--yes", "--json"], { fetch: api.fetch });
      expect(r.code, `${argv[0]}: ${r.err}`).toBe(0);
    }
    expect(api.ops()).toEqual(["create-opt-out", "check-opt-out", "delete-opt-out"]);
  });

  it("subscribe a webhook to delivery events and verify one delivery", async () => {
    const api = specFake();
    const secret = "whsec_test_123";
    const sub = await runCli(["sms", "webhooks", "create", "--url", "https://app.example.com/hooks/sms", "--secret", secret, "--event", "message.delivered", "--yes", "--json"], { fetch: api.fetch });
    expect(sub.code, sub.err).toBe(0);
    expect(sub.out).not.toContain(secret);
    const body = JSON.stringify({ event: "message.delivered", data: { id: "msg_1" } });
    const ok = await runCli(["webhooks", "verify", "--body", body, "--signature", `sha256=${signBody(secret, body)}`, "--json"], { env: { VOBIZ_WEBHOOK_SECRET: secret } });
    expect(ok.code).toBe(0);
    expect(ok.json()).toMatchObject({ valid: true, scheme: "body-hmac" });
  });
});

describe("agent tooling", () => {
  it("install the Vobiz skills into a project, then update them", async () => {
    const proj = tmp("vobiz-proj-");
    const dir = join(proj, ".claude", "skills");
    const all = bundledSkills();
    const r = await runCli(["skills", "install", "--dir", dir, "--yes", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(r.json<{ status: string }[]>().every((x) => x.status === "installed")).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(all.map((s) => s.name).sort());
    for (const s of all) expect(existsSync(join(dir, s.name, "SKILL.md")), s.name).toBe(true);

    const listed = await runCli(["skills", "list", "--dir", dir, "--json"]);
    expect(listed.json<{ installed: string }[]>().every((x) => x.installed === "yes")).toBe(true);

    const again = await runCli(["skills", "install", "--dir", dir, "--json"]);
    expect(again.code).toBe(0); // nothing to do, so no confirmation needed
    expect(again.err).toContain("Nothing to do");

    writeFileSync(join(dir, all[0].name, "SKILL.md"), "local edit");
    expect((await runCli(["skills", "list", "--dir", dir, "--json"])).json<{ name: string; installed: string }[]>().find((x) => x.name === all[0].name)!.installed).toBe("outdated");
    const upd = await runCli(["skills", "update", "--dir", dir, "--yes", "--json"]);
    expect(upd.code, upd.err).toBe(0);
    expect(upd.json<{ skill: string; status: string }[]>().filter((x) => x.status === "updated").map((x) => x.skill)).toEqual([all[0].name]);
    expect(readFileSync(join(dir, all[0].name, "SKILL.md"), "utf8")).not.toBe("local edit");
  });

  it("install only the voice skills for Codex", async () => {
    const dir = join(tmp("vobiz-proj-"), ".agents", "skills");
    const r = await runCli(["skills", "install", "--dir", dir, "--only", "vobiz-voice-xml,vobiz-voice-calls", "--yes"]);
    expect(r.code, r.err).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(["vobiz-voice-calls", "vobiz-voice-xml"]);
  });

  it("configure the MCP server for Cursor (user and project scope)", async () => {
    const HOME = tmp("vobiz-home-");
    const user = await runCli(["mcp", "install", "cursor", "--yes", "--json"], { env: { HOME } });
    expect(user.code, user.err).toBe(0);
    expect(JSON.parse(readFileSync(join(HOME, ".cursor", "mcp.json"), "utf8"))).toEqual({ mcpServers: { vobiz: { url: "https://mcp.vobiz.ai/mcp" } } });

    const proj = tmp("vobiz-proj-");
    const local = await runCli(["mcp", "install", "cursor", "--project", "--dir", proj, "--local", "--yes", "--json"], { env: { HOME, VOBIZ_AUTH_TOKEN: "tok_live_1a2b3c" } });
    expect(local.code, local.err).toBe(0);
    const cfg = JSON.parse(readFileSync(join(proj, ".cursor", "mcp.json"), "utf8"));
    expect(cfg.mcpServers.vobiz.command).toBe("npx");
    expect(JSON.stringify(cfg)).not.toContain("tok_live_1a2b3c"); // the env token is referenced, never copied

    const snippet = await runCli(["mcp", "config", "cursor"], { env: { HOME } });
    expect(JSON.parse(snippet.out)).toEqual({ mcpServers: { vobiz: { url: "https://mcp.vobiz.ai/mcp" } } });
  });

  it("build an IVR menu as VobizXML, save it, and validate it", async () => {
    const built = await runCli([
      "xml", "build",
      "--gather", "https://app.example.com/menu", "--attr", "numDigits=1", "--attr", "executionTimeout=10",
      "--prompt", "Press 1 for sales, 2 for support",
      "--say", "We did not get your choice. Goodbye.",
      "--hangup",
    ]);
    expect(built.code, built.err).toBe(0);
    expect(built.out).toMatch(/^<\?xml|^<Response/);
    expect(built.out).toContain('<Gather action="https://app.example.com/menu"');
    expect(built.out).toContain('numDigits="1"');
    expect(built.out.indexOf("<Gather")).toBeLessThan(built.out.indexOf("Goodbye"));
    const file = join(tmp("vobiz-xml-"), "menu.xml");
    writeFileSync(file, built.out);
    const v = await runCli(["xml", "validate", file, "--json"]);
    expect(v.code, v.out).toBe(0);
    expect(v.json()).toMatchObject({ valid: true, errors: 0 });
    const strict = await runCli(["xml", "validate", file, "--strict"]);
    expect(strict.code).toBe(0);

    writeFileSync(file, "<Response><Gather><Dial/></Gather><Bogus/></Response>");
    const bad = await runCli(["xml", "validate", file, "--json"]);
    expect(bad.code).toBe(2);
    expect(bad.json().valid).toBe(false);
  });

  it("verify a voice callback signature (V3, then V2) and reject a tampered one", async () => {
    const url = "https://app.example.com/answer?CallUUID=abc";
    const nonce = "12345678901234567890";
    const env = { VOBIZ_WEBHOOK_SECRET: TEST_AUTH_TOKEN };
    const v3 = signV3(TEST_AUTH_TOKEN, baseUrlOf(url), nonce);
    const ok = await runCli(["webhooks", "verify", "--url", url, "--nonce", nonce, "--signature", v3, "--json"], { env, loggedOut: true });
    expect(ok.code).toBe(0);
    expect(ok.json()).toMatchObject({ valid: true, version: "v3" });
    const v2 = signV2(TEST_AUTH_TOKEN, baseUrlOf(url), nonce);
    expect((await runCli(["webhooks", "verify", "--url", url, "--nonce", nonce, "--signature", v2, "--json"], { env })).json()).toMatchObject({ valid: true, version: "v2" });
    const bad = await runCli(["webhooks", "verify", "--url", url, "--nonce", "999", "--signature", v3, "-o", "table"], { env });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("NOT valid");
  });

  it("vobiz api: raw GET with a query, and POST with --body @file", async () => {
    const api = fakeFetch({
      [`GET ${A}/Call/`]: (req: RecordedRequest) => ({ objects: [], echo: req.query }),
      [`POST ${A}/Call/`]: (req: RecordedRequest) => reply(201, { request_uuid: UUID, echo: req.body }),
    });
    const get = await runCli(["api", "GET", "/api/v1/Account/{auth_id}/Call/", "--param", "status=queued", "--param", "limit=5", "--json"], { fetch: api.fetch });
    expect(get.json()).toMatchObject({ echo: { status: "queued", limit: "5" } });
    const file = join(tmp("vobiz-body-"), "call.json");
    writeFileSync(file, JSON.stringify({ from: "+918012345678", to: "+919876543210", answer_url: "https://e.com/a", answer_method: "POST" }));
    const post = await runCli(["api", "POST", "/api/v1/Account/{auth_id}/Call/", "--body", `@${file}`, "--yes", "--json"], { fetch: api.fetch });
    expect(post.code, post.err).toBe(0);
    expect(post.json()).toMatchObject({ request_uuid: UUID, echo: { to: "+919876543210" } });
    expect(api.last().headers["content-type"]).toBe("application/json");
  });

  it("vobiz api --describe, then call the operation it documents", async () => {
    const d = await runCli(["api", "--describe", "get-concurrency", "--json"]);
    const path = d.json().path as string;
    const api = specFake();
    expect((await runCli(["api", "GET", path, "--json"], { fetch: api.fetch })).code).toBe(0);
    expect(api.ops()).toEqual(["get-concurrency"]);
  });
});

describe("--dry-run on every write group sends nothing", () => {
  const writes: string[][] = [
    ["account", "channel-subscriptions", "create", "--type", "cps", "--quantity", "2"],
    ["calls", "create", "--to", "+919876543210", "--from", "+918012345678", "--answer-url", "https://e.com/a"],
    ["calls", "hangup", UUID],
    ["calls", "record", "start", UUID],
    ["calls", "speak", UUID, "--text", "Hello"],
    ["calls", "play", UUID, "--url", "https://e.com/a.mp3"],
    ["calls", "dtmf", UUID, "--digits", "1"],
    ["calls", "stream", "start", UUID, "--url", "wss://e.com/ws"],
    ["conferences", "end-all"],
    ["conferences", "members", "kick", "room", "1"],
    ["conferences", "record", "stop", "room"],
    ["recordings", "delete", "r1"],
    ["recordings", "export", "--email", "ops@example.com"],
    ["numbers", "release", "+919876543210", "--immediate"],
    ["numbers", "assign", "+919876543210", "--trunk", "t1"],
    ["numbers", "unassign-subaccount", "+919876543210", "--force"],
    ["trunks", "create", "--name", "pbx", "--trunk-direction", "outbound"],
    ["trunks", "update", "t1", "--trunk-status", "disabled"],
    ["trunks", "delete", "t1"],
    ["trunks", "credentials", "delete", "c1"],
    ["trunks", "ip-acl", "update", "a1", "--name", "x", "--ip-address", "203.0.113.5"],
    ["trunks", "origination-uris", "create", "--uri", "sip:pbx.example.com", "--description", "p", "--priority", "1"],
    ["apps", "update", "a1", "--app-name", "x", "--default-number-app"],
    ["apps", "delete", "a1"],
    ["endpoints", "delete", "e1"],
    ["sub-accounts", "update", "SA_X", "--name", "x"],
    ["sub-accounts", "delete", "SA_X"],
    ["sub-accounts", "kyc", "verify-gst", "SA_X", "--gstin", "22AAAAA0000A1Z5"],
    ["partner", "kyc-sessions", "create", "--account-auth-id", "MA_C", "--flow-type", "email", "--customer-email", "a@example.com"],
    ["partner", "kyc-sessions", "resend", "s1"],
    ["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hi"],
    ["sms", "opt-outs", "remove", "+14155550123"],
    ["sms", "webhooks", "update", "w1", "--url", "https://e.com/h"],
    ["sms", "conversations", "read", "c1"],
    ["sms", "broadcasts", "pause", "b1"],
    ["sms", "senders", "templates", "delete", "s1", "t1"],
    ["sms", "10dlc", "campaigns", "deregister", "cp1"],
    ["sms", "numbers", "release", "+14155550100"],
    ["api", "PUT", "/api/v1/x", "--body", '{"a":1}'],
  ];
  for (const argv of writes) {
    it(argv.slice(0, 3).join(" "), async () => {
      const api = specFake();
      const r = await runCli([...argv, "--dry-run", "--json"], { fetch: api.fetch });
      expect(r.code, r.err).toBe(0);
      expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
      const dry = r.json();
      expect(dry).toMatchObject({ dry_run: true });
      expect(["POST", "PUT", "PATCH", "DELETE"]).toContain(dry.method);
      expect(new URL(dry.url).host).toBe("api.vobiz.ai");
      expect(r.err).toContain("[dry-run]");
    });
  }

  it("skills install and mcp install --dry-run write no files", async () => {
    const dir = join(tmp("vobiz-proj-"), "skills");
    expect((await runCli(["skills", "install", "--dir", dir, "--dry-run"])).code).toBe(0);
    expect(existsSync(dir)).toBe(false);
    const HOME = tmp("vobiz-home-");
    expect((await runCli(["mcp", "install", "cursor", "--dry-run"], { env: { HOME } })).code).toBe(0);
    expect(readdirSync(HOME)).toEqual([]);
  });
});

describe("shaping list output for scripts", () => {
  const owned = {
    items: [
      { id: "n1", e164: "+919876543210", country: "IN", region: "Karnataka", status: "active", monthly_fee: 300, currency: "INR", trunk: { id: "t1" } },
      { id: "n2", e164: "+918012345678", country: "IN", region: "Mumbai\tWest", status: "active", monthly_fee: 200, currency: "INR", trunk: null },
    ],
    page: 1,
    per_page: 25,
    total: 2,
  };
  const fetch = () => specFake({ answer: (op) => (op.id === "list-numbers" && op.api === "voice" ? owned : undefined) }).fetch;

  it("--fields with dot paths in json, tsv and yaml", async () => {
    const j = await runCli(["numbers", "list", "--fields", "e164,trunk.id", "--json"], { fetch: fetch() });
    expect(j.json()).toEqual([{ e164: "+919876543210", trunk: { id: "t1" } }, { e164: "+918012345678" }]);
    const t = await runCli(["numbers", "list", "--fields", "e164,trunk.id", "-o", "tsv"], { fetch: fetch() });
    expect(t.out).toBe("e164\ttrunk.id\n+919876543210\tt1\n+918012345678\t\n");
    const y = await runCli(["numbers", "list", "--fields", "e164,monthly_fee", "-o", "yaml"], { fetch: fetch() });
    expect(YAML.parse(y.out)).toEqual([{ e164: "+919876543210", monthly_fee: 300 }, { e164: "+918012345678", monthly_fee: 200 }]);
  });

  it("--quiet prints one e164 per line for xargs", async () => {
    expect((await runCli(["numbers", "list", "--quiet"], { fetch: fetch() })).out).toBe("+919876543210\n+918012345678\n");
  });

  it("tsv escapes embedded tabs; plain has no header", async () => {
    const t = await runCli(["numbers", "list", "-o", "tsv"], { fetch: fetch() });
    expect(t.out.split("\n")[0].split("\t")[0]).toBe("e164");
    expect(t.out).toContain("Mumbai\\tWest");
    expect(t.out.trimEnd().split("\n")).toHaveLength(3);
    const p = await runCli(["numbers", "list", "-o", "plain"], { fetch: fetch() });
    expect(p.out.split("\n")[0]).toMatch(/^\+919876543210\s+IN/);
  });

  it("yaml keeps the raw response", async () => {
    expect(YAML.parse((await runCli(["numbers", "list", "-o", "yaml"], { fetch: fetch() })).out)).toEqual(owned);
  });
});
