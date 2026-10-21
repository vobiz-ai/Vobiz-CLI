import { describe, expect, it } from "vitest";
import { fakeFetch, reply, runCli, TEST_AUTH_ID } from "./helpers.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const NUM = "+918065550100";
const TRUNK = "e3e55a78-1234-5678-90ab-cdef12345678";
const routes = {
  [`GET ${A}/numbers`]: { items: [{ e164: NUM, country: "IN", region: "Bangalore", status: "active", trunk_group_id: null }, { e164: "+918065550101", country: "IN" }], total: 2 },
  [`GET ${A}/trunks/${TRUNK}`]: { trunk_id: TRUNK, name: "LiveKit", trunk_domain: `${TRUNK}.sip.vobiz.ai`, trunk_direction: "inbound" },
  [`GET ${A}/trunks`]: { objects: [{ trunk_id: TRUNK, name: "LiveKit", trunk_direction: "inbound" }], meta: { total: 1 } },
  [`GET ${A}/inventory/numbers`]: { items: [{ e164: "+918065550199", country: "IN", region: "Mumbai", setup_fee: 100, monthly_fee: 500, currency: "INR" }] },
  [`POST ${A}/numbers/purchase-from-inventory`]: { number: { e164: "+918065550199" } },
  [`POST ${A}/numbers/${NUM}/assign`]: { message: "assigned" },
  [`POST ${A}/numbers/+918065550199/assign`]: { message: "assigned" },
};
const writes = (calls: { method: string }[]) => calls.filter((c) => c.method !== "GET");
const APP = "12345678901234567";
const appRoutes = {
  ...routes,
  [`GET ${A}/Application/${APP}/`]: { app_id: APP, app_name: "Agent", answer_url: "https://agent.example.com/answer" },
  [`POST ${A}/Application/`]: { api_id: "x", app_id: APP, message: "created" },
  [`POST ${A}/numbers/${NUM}/application`]: { message: "linked" },
  [`POST ${A}/numbers/+918065550199/application`]: { message: "linked" },
  [`DELETE ${A}/numbers/${NUM}/assign`]: reply(204),
};

describe("vobiz setup voice-agent", () => {
  it("routes an existing number to a trunk after one confirmation and prints a test plan", async () => {
    const api = fakeFetch(routes);
    const r = await runCli(["setup", "voice-agent", "--number", NUM, "--trunk", TRUNK, "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.calls[0]).toMatchObject({ method: "GET", path: `${A}/numbers`, query: { search: NUM, per_page: "100" } });
    expect(api.calls[1]).toMatchObject({ method: "GET", path: `${A}/trunks/${TRUNK}` });
    expect(writes(api.calls)).toHaveLength(1);
    expect(api.last()).toMatchObject({ method: "POST", path: `${A}/numbers/%2B918065550100/assign`, body: { trunk_group_id: TRUNK } });
    expect(r.err).toContain(`Set up ${NUM} for your voice agent (1 step: Route ${NUM} to trunk ${TRUNK})`);
    expect(r.err).toContain("trunk: LiveKit (" + TRUNK + ")");
    expect(r.json()).toMatchObject({ number: NUM, trunk_id: TRUNK, trunk_name: "LiveKit", bought: false, routed: true, changed: true });
    expect(r.json().test_plan[0]).toContain(`Call ${NUM}`);
    expect(r.json().test_plan.join("\n")).toContain("vobiz diagnose call");
  });

  it("refuses without --yes when stdin is not a terminal, and sends nothing", async () => {
    const api = fakeFetch(routes);
    const r = await runCli(["setup", "voice-agent", "--number", NUM, "--trunk", TRUNK], { fetch: api.fetch });
    expect(r.code).toBe(6);
    expect(writes(api.calls)).toHaveLength(0);
  });

  it("--dry-run with --buy shows the price and both requests without sending them", async () => {
    const api = fakeFetch(routes);
    const r = await runCli(["setup", "voice-agent", "--buy", "+918065550199", "--trunk", TRUNK, "--dry-run", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(writes(api.calls)).toHaveLength(0);
    expect(r.err).toContain("cost: INR 100 setup now, then INR 500/month");
    const plan = r.json();
    expect(plan.dry_run).toBe(true);
    expect(plan.steps.map((s: any) => [s.step, s.method, s.operation])).toEqual([
      ["Buy +918065550199", "POST", "purchase-from-inventory"],
      [`Route +918065550199 to trunk ${TRUNK}`, "POST", "assign-number-to-trunk"],
    ]);
    expect(plan.steps[0].body).toEqual({ e164: "+918065550199" });
    expect(plan.steps[1].url).toContain("%2B918065550199/assign");
    expect(JSON.stringify(plan)).not.toContain("YOUR_AUTH_TOKEN");
  });

  it("buys then routes; a failed routing after the purchase says how to finish", async () => {
    let api = fakeFetch(routes);
    let r = await runCli(["setup", "voice-agent", "--buy", "+918065550199", "--trunk", TRUNK, "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(writes(api.calls).map((c) => c.path)).toEqual([`${A}/numbers/purchase-from-inventory`, `${A}/numbers/%2B918065550199/assign`]);
    expect(r.json()).toMatchObject({ bought: true, routed: true });

    api = fakeFetch({ ...routes, [`POST ${A}/numbers/+918065550199/assign`]: reply(400, { error: "trunk not inbound" }) });
    r = await runCli(["setup", "voice-agent", "--buy", "+918065550199", "--trunk", TRUNK, "--yes"], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Done: Buy +918065550199. Failed: Route +918065550199");
    expect(r.err).toContain(`vobiz numbers assign +918065550199 --trunk ${TRUNK}`);
  });

  it("does nothing when the number is already on that trunk", async () => {
    const api = fakeFetch({ ...routes, [`GET ${A}/numbers`]: { items: [{ e164: NUM, trunk_group_id: TRUNK }] } });
    const r = await runCli(["setup", "voice-agent", "--number", NUM, "--trunk", TRUNK, "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ changed: false });
    expect(writes(api.calls)).toHaveLength(0);
  });

  it("refuses conflicting or incomplete flags before any request", async () => {
    const api = fakeFetch(routes);
    for (const flags of [
      ["--trunk", TRUNK, "--app", "app-1"],
      ["--trunk", TRUNK, "--answer-url", "https://example.com/answer"],
      ["--app", "app-1", "--answer-url", "https://example.com/answer"],
      ["--answer-url", "http://example.com/answer"],
      ["--stream-url", "https://agent.example.com/media", "--answer-url", "https://example.com/answer"],
      ["--app", "app-1", "--app-name", "x"],
    ]) {
      const r = await runCli(["setup", "voice-agent", "--number", NUM, ...flags, "--yes"], { fetch: api.fetch });
      expect(r.code, flags.join(" ")).toBe(2);
    }
    const s = await runCli(["setup", "voice-agent", "--number", NUM, "--stream-url", "wss://agent.example.com/media", "--yes"], { fetch: api.fetch });
    expect(s.code).toBe(2);
    expect(s.err).toContain("--stream-url needs --answer-url");
    expect(s.err).toContain('<Stream bidirectional="true" keepCallAlive="true">wss://agent.example.com/media</Stream>');
    expect(api.calls).toHaveLength(0);
    let r = await runCli(["setup", "voice-agent", "--trunk", TRUNK], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--number");
    r = await runCli(["setup", "voice-agent", "--number", NUM], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--trunk");
    expect(r.err).toContain("--answer-url");
  });

  it("asks for the number and trunk on a terminal", async () => {
    const api = fakeFetch(routes);
    const r = await runCli(["setup", "voice-agent", "--output", "table"], { fetch: api.fetch, stdinTTY: true, prompts: { confirm: [true, true], input: ["1", "1"] } });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("Your numbers:\n  1. +918065550100 Bangalore, IN");
    expect(r.err).toContain("SIP trunks:\n  1. LiveKit " + TRUNK + " (inbound)");
    expect(api.last()).toMatchObject({ method: "POST", path: `${A}/numbers/%2B918065550100/assign` });
    expect(r.out).toContain("Test plan:\n  1. Call +918065550100");
  });

  it("offers inventory numbers on a terminal when buying", async () => {
    const api = fakeFetch(routes);
    const r = await runCli(["setup", "voice-agent", "--country", "in", "--trunk", TRUNK, "--json"], { fetch: api.fetch, stdinTTY: true, prompts: { confirm: [true], input: ["1"] } });
    expect(r.code, r.err).toBe(0);
    expect(api.calls.find((c) => c.path === `${A}/inventory/numbers`)?.query).toMatchObject({ country: "IN", per_page: "10" });
    expect(writes(api.calls).map((c) => c.path)).toEqual([`${A}/numbers/purchase-from-inventory`, `${A}/numbers/%2B918065550199/assign`]);
  });
});

const SMS_NUM = "+14155550100";
const sms = {
  "GET /numbers": { numbers: [{ e164: SMS_NUM, countryCode: "US", capabilities: ["SMS", "MMS"] }] },
  "GET /numbers/available": { numbers: [{ e164: "+14155550123", setupPrice: 1, monthlyPrice: 1.5, currency: "USD", numberKey: "nk-1" }] },
  "POST /numbers/purchase": { e164: "+14155550123", status: "active" },
  "GET /webhooks": [],
  "POST /webhooks": { id: "wh-1", url: "https://example.com/vobiz/sms", events: ["message.received", "message.delivered", "message.failed"] },
  "GET /webhooks/wh-9": { id: "wh-9", url: "https://hooks.example.com/sms" },
};

describe("vobiz setup sms", () => {
  it("creates a webhook for an existing number after one confirmation", async () => {
    const api = fakeFetch(sms);
    const r = await runCli(["setup", "sms", "--number", SMS_NUM, "--webhook-url", "https://example.com/vobiz/sms", "--secret", "s3cr3t", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.calls.map((c) => `${c.api} ${c.method} ${c.path}`)).toEqual(["sms GET /numbers", "sms GET /webhooks", "sms POST /webhooks"]);
    expect(api.last().body).toEqual({ url: "https://example.com/vobiz/sms", secret: "s3cr3t" });
    expect(r.err).toContain("webhook host: example.com");
    expect(r.err).not.toContain("s3cr3t");
    expect(r.json()).toMatchObject({ number: SMS_NUM, country: "US", bought: false, webhook_id: "wh-1", changed: true });
    expect(r.json().notes[0]).toContain("10DLC");
    expect(r.json().test_plan.join("\n")).toContain(`vobiz sms send --from ${SMS_NUM}`);
  });

  it("reuses a webhook with the same URL and changes nothing", async () => {
    const api = fakeFetch({ ...sms, "GET /webhooks": [{ id: "wh-7", url: "https://example.com/vobiz/sms" }] });
    const r = await runCli(["setup", "sms", "--number", SMS_NUM, "--webhook-url", "https://example.com/vobiz/sms", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(writes(api.calls)).toHaveLength(0);
    expect(r.json()).toMatchObject({ webhook_id: "wh-7", changed: false });
  });

  it("--dry-run --buy shows the purchase with its price and numberKey, sending nothing", async () => {
    const api = fakeFetch(sms);
    const r = await runCli(["setup", "sms", "--buy", "+14155550123", "--country", "us", "--webhook", "wh-9", "--dry-run", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(writes(api.calls)).toHaveLength(0);
    expect(api.calls.find((c) => c.path === "/numbers/available")?.query).toMatchObject({ country: "US", areaCode: "415" });
    expect(r.err).toContain("cost: USD 1 setup + 1.5/month");
    expect(r.err).toContain("webhook: existing wh-9 (hooks.example.com), unchanged");
    expect(r.json().steps).toHaveLength(1);
    expect(r.json().steps[0]).toMatchObject({ step: "Buy messaging number +14155550123", method: "POST", body: { e164: "+14155550123", country: "US", numberKey: "nk-1" } });
  });

  it("validates its inputs", async () => {
    const api = fakeFetch(sms);
    expect((await runCli(["setup", "sms", "--buy", "+14155550123"], { fetch: api.fetch })).code).toBe(2);
    expect((await runCli(["setup", "sms", "--number", SMS_NUM, "--webhook-url", "http://example.com"], { fetch: api.fetch })).code).toBe(2);
    expect((await runCli(["setup", "sms"], { fetch: api.fetch })).code).toBe(2);
    const r = await runCli(["setup", "sms", "--number", "+14155550999", "--no-webhook"], { fetch: api.fetch });
    expect(r.code).toBe(4);
    expect(r.err).toContain("not a messaging number");
    const refused = await runCli(["setup", "sms", "--buy", "+14155550123", "--country", "US", "--no-webhook"], { fetch: api.fetch });
    expect(refused.code).toBe(6);
    expect(writes(api.calls)).toHaveLength(0);
  });
});

describe("vobiz setup voice-agent with an application", () => {
  it("--app links the number to an existing application", async () => {
    const api = fakeFetch(appRoutes);
    const r = await runCli(["setup", "voice-agent", "--number", NUM, "--app", APP, "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.calls.find((c) => c.path === `${A}/Application/${APP}/`)?.method).toBe("GET");
    expect(writes(api.calls).map((c: any) => [c.method, c.path, c.body])).toEqual([["POST", `${A}/numbers/%2B918065550100/application`, { application_id: APP }]]);
    expect(r.err).toContain(`application: Agent (${APP})`);
    expect(r.err).toContain("answer URL host: agent.example.com");
    expect(r.json()).toMatchObject({ number: NUM, application_id: APP, application_created: false, trunk_id: null, routed: true, changed: true });
  });

  it("--app on a number that is on a trunk removes it from the trunk first", async () => {
    const api = fakeFetch({ ...appRoutes, [`GET ${A}/numbers`]: { items: [{ e164: NUM, trunk_group_id: TRUNK }] } });
    const r = await runCli(["setup", "voice-agent", "--number", NUM, "--app", APP, "--yes"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(writes(api.calls).map((c: any) => `${c.method} ${c.path}`)).toEqual([`DELETE ${A}/numbers/%2B918065550100/assign`, `POST ${A}/numbers/%2B918065550100/application`]);
    expect(r.err).toContain(`currently routed to: trunk ${TRUNK} (removed)`);
  });

  it("does nothing when the number is already linked to that application", async () => {
    const api = fakeFetch({ ...appRoutes, [`GET ${A}/numbers`]: { items: [{ e164: NUM, application_id: APP, trunk_group_id: null }] } });
    const r = await runCli(["setup", "voice-agent", "--number", NUM, "--app", APP, "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(r.json()).toMatchObject({ changed: false });
    expect(writes(api.calls)).toHaveLength(0);
  });

  it("--answer-url creates an application and links the number to its new app_id", async () => {
    const api = fakeFetch(appRoutes);
    const r = await runCli(
      ["setup", "voice-agent", "--number", NUM, "--answer-url", "https://agent.example.com/answer", "--stream-url", "wss://agent.example.com/media", "--yes", "--json"],
      { fetch: api.fetch },
    );
    expect(r.code, r.err).toBe(0);
    expect(writes(api.calls).map((c: any) => [c.method, c.path, c.body])).toEqual([
      ["POST", `${A}/Application/`, { app_name: `Voice agent ${NUM}`, answer_url: "https://agent.example.com/answer", answer_method: "POST" }],
      ["POST", `${A}/numbers/%2B918065550100/application`, { application_id: APP }],
    ]);
    expect(r.err).toContain("stream host: agent.example.com");
    expect(r.json()).toMatchObject({ application_id: APP, application_created: true, answer_url_host: "agent.example.com", changed: true });
    expect(r.json().test_plan.join("\n")).toContain("vobiz streams test wss://agent.example.com/media");
    expect(r.json().notes[0]).toContain("<Stream");
  });

  it("--dry-run with --buy --answer-url shows buy, create and link (with a placeholder app_id) and sends nothing", async () => {
    const api = fakeFetch(appRoutes);
    const r = await runCli(
      ["setup", "voice-agent", "--buy", "+918065550199", "--answer-url", "https://agent.example.com/answer", "--app-name", "Bot", "--answer-method", "GET", "--dry-run", "--json"],
      { fetch: api.fetch },
    );
    expect(r.code, r.err).toBe(0);
    expect(writes(api.calls)).toHaveLength(0);
    const plan = r.json();
    expect(plan.steps.map((s: any) => s.operation)).toEqual(["purchase-from-inventory", "create-application", "link-number-to-application"]);
    expect(plan.steps[1].body).toEqual({ app_name: "Bot", answer_url: "https://agent.example.com/answer", answer_method: "GET" });
    expect(plan.steps[2].body).toEqual({ application_id: "<app_id from step 2>" });
  });

  it("a failed link after the application was created says how to finish", async () => {
    const api = fakeFetch({ ...appRoutes, [`POST ${A}/numbers/${NUM}/application`]: reply(409, { error: "number is on a trunk" }) });
    const r = await runCli(["setup", "voice-agent", "--number", NUM, "--answer-url", "https://agent.example.com/answer", "--yes"], { fetch: api.fetch });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`Done: Create application "Voice agent ${NUM}". Failed: Link ${NUM} to the new application`);
    expect(r.err).toContain(`vobiz numbers update ${NUM} --app <app_id>`);
  });

  it("refuses without --yes off a terminal", async () => {
    const api = fakeFetch(appRoutes);
    const r = await runCli(["setup", "voice-agent", "--number", NUM, "--answer-url", "https://agent.example.com/answer"], { fetch: api.fetch });
    expect(r.code).toBe(6);
    expect(writes(api.calls)).toHaveLength(0);
  });
});
