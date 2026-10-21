import { describe, expect, it } from "vitest";
import { TEST_AUTH_ID, fakeFetch, reply, runCli } from "./helpers.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const a = `/api/v1/account/${TEST_AUTH_ID}`;
const NUM = "+919876543210";
const ENC = "%2B919876543210";

const owned = {
  items: [
    { id: "n1", e164: NUM, country: "IN", region: "Karnataka", status: "active", setup_fee: 100, monthly_fee: 300, currency: "INR", application_id: "2057" },
    { id: "n2", e164: "+9198765432101", country: "IN", region: "Mumbai", status: "active", setup_fee: 100, monthly_fee: 200, currency: "INR" },
  ],
  page: 1,
  per_page: 25,
  total: 2,
};
const inventory = { items: [{ id: "i1", e164: "+918065550100", country: "IN", region: "Bengaluru", status: "active", setup_fee: 100, monthly_fee: 300, currency: "INR" }], page: 1, per_page: 100, total: 1 };

describe("numbers list/get/search/health", () => {
  it("lists numbers with a search filter and prints the raw body as json", async () => {
    const api = fakeFetch({ [`GET ${A}/numbers`]: owned });
    const r = await runCli(["numbers", "list", "--search", "+9198", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last()).toMatchObject({ method: "GET", path: `${A}/numbers`, query: { search: "+9198", page: "1" } });
    expect(api.last().url).toContain("search=%2B9198");
    expect(r.json()).toMatchSnapshot();
  });

  it("table output shows the default columns; --limit sets per_page", async () => {
    const api = fakeFetch({ [`GET ${A}/numbers`]: owned });
    const r = await runCli(["numbers", "list", "--limit", "5", "-o", "table"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().query).toMatchObject({ per_page: "5", page: "1" });
    expect(r.out.split("\n")[0]).toMatch(/E164\s+COUNTRY\s+REGION\s+STATUS\s+MONTHLY_FEE/);
  });

  it("--all walks pages", async () => {
    const api = fakeFetch({
      [`GET ${A}/numbers`]: (req) => (req.query.page === "1" ? { ...owned, items: [owned.items[0]], total: 2, per_page: 1 } : { ...owned, items: [owned.items[1]], page: 2, total: 2 }),
    });
    const r = await runCli(["numbers", "list", "--all", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.calls).toHaveLength(2);
    expect(r.json().items).toHaveLength(2); // the same wrapper as a single page, every page's items merged
    expect(r.json()).toMatchObject({ total: 2 });
  });

  it("get filters list-numbers to an exact match", async () => {
    const api = fakeFetch({ [`GET ${A}/numbers`]: owned });
    const r = await runCli(["numbers", "get", "+91 98765 43210", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().query.search).toBe(NUM);
    expect(r.json()).toMatchObject({ id: "n1", e164: NUM });
    const miss = await runCli(["numbers", "get", "+14155550100"], { fetch: api.fetch });
    expect(miss.code).toBe(4);
  });

  it("rejects a non-E.164 number", async () => {
    expect((await runCli(["numbers", "get", "hello"])).code).toBe(2);
  });

  it("search maps flags to the inventory query", async () => {
    const api = fakeFetch({ [`GET ${A}/inventory/numbers`]: inventory });
    const r = await runCli(["numbers", "search", "--country", "in", "--contains", "80", "--exclude", "9192", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().query).toMatchObject({ country: "IN", search: "80", exclude: "9192" });
  });

  it("health passes granularity and days", async () => {
    const api = fakeFetch({ [`GET ${a}/numbers/${ENC}/health`]: { e164: NUM, status: "active", is_spam: false } });
    const r = await runCli(["numbers", "health", NUM, "--granularity", "hourly", "--days", "7", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().path).toBe(`${a}/numbers/${ENC}/health`);
    expect(api.last().query).toEqual({ granularity: "hourly", days: "7" });
    expect((await runCli(["numbers", "health", NUM, "--granularity", "weekly"])).code).toBe(2);
  });
});

describe("numbers buy", () => {
  const routes = () =>
    fakeFetch({
      [`GET ${A}/inventory/numbers`]: inventory,
      [`POST ${A}/numbers/purchase-from-inventory`]: { message: "Number purchased successfully", number: { ...inventory.items[0], account_id: TEST_AUTH_ID } },
      [`POST ${A}/numbers/%2B918065550100/assign`]: reply(204),
    });

  it("looks up the price, confirms, purchases and assigns the trunk", async () => {
    const api = routes();
    const r = await runCli(["numbers", "buy", "+918065550100", "--trunk", "t-1", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${A}/inventory/numbers`,
      `POST ${A}/numbers/purchase-from-inventory`,
      `POST ${A}/numbers/%2B918065550100/assign`,
    ]);
    expect(api.calls[0].query.search).toBe("918065550100");
    expect(api.calls[1].body).toEqual({ e164: "+918065550100" });
    expect(api.calls[2].body).toEqual({ trunk_group_id: "t-1" });
    expect(r.err).toContain("INR 100 setup now, then INR 300/month");
    expect(r.json()).toMatchObject({ e164: "+918065550100" });
  });

  it("refuses without --yes when stdin is not a terminal, after showing nothing was bought", async () => {
    const api = routes();
    const r = await runCli(["numbers", "buy", "+918065550100"], { fetch: api.fetch });
    expect(r.code).toBe(6);
    expect(api.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("asks on a TTY and stops on no", async () => {
    const api = routes();
    const r = await runCli(["numbers", "buy", "+918065550100"], { fetch: api.fetch, stdinTTY: true, prompts: { confirm: false } });
    expect(r.code).toBe(6);
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("--dry-run reads the inventory but sends no purchase", async () => {
    const api = routes();
    const r = await runCli(["numbers", "buy", "+918065550100", "--currency", "usd", "--dry-run", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(r.json()).toMatchObject({ dry_run: true, method: "POST", body: { e164: "+918065550100", currency: "USD" } });
  });

  it("fails with not_found when the number is not in the inventory", async () => {
    const api = fakeFetch({ [`GET ${A}/inventory/numbers`]: { items: [], page: 1, per_page: 100, total: 0 } });
    const r = await runCli(["numbers", "buy", "+918065550199", "--yes"], { fetch: api.fetch });
    expect(r.code).toBe(4);
    expect(api.calls).toHaveLength(1);
  });
});

describe("numbers release/cancel-release/assign", () => {
  it("release sends DELETE with %2B and immediate=true", async () => {
    const api = fakeFetch({ [`DELETE ${A}/numbers/${ENC}`]: { status: "released", release_fee: 700, message: "ok", cancel_url: "", cooldown_ends_at: "" } });
    const r = await runCli(["numbers", "release", NUM, "--immediate", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", path: `${A}/numbers/${ENC}`, query: { immediate: "true" } });
    expect(r.json()).toMatchObject({ release_fee: 700 });
  });

  it("release needs confirmation and --dry-run sends nothing", async () => {
    const api = fakeFetch({});
    expect((await runCli(["numbers", "release", NUM], { fetch: api.fetch })).code).toBe(6);
    const d = await runCli(["numbers", "release", NUM, "--dry-run", "--json"], { fetch: api.fetch });
    expect(d.code).toBe(0);
    expect(d.json()).toMatchObject({ method: "DELETE", url: `https://api.vobiz.ai${A}/numbers/${ENC}` });
    expect(api.calls).toHaveLength(0);
  });

  it("cancel-release uses the lowercase account path", async () => {
    const api = fakeFetch({ [`POST ${a}/numbers/${ENC}/cancel-release`]: { status: "active", refund_amount: 700, currency: "INR" } });
    const r = await runCli(["numbers", "cancel-release", NUM, "--yes"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last()).toMatchObject({ method: "POST", path: `${a}/numbers/${ENC}/cancel-release` });
  });

  it("assign / unassign trunk", async () => {
    const api = fakeFetch({ [`POST ${A}/numbers/${ENC}/assign`]: reply(204), [`DELETE ${A}/numbers/${ENC}/assign`]: reply(204) });
    expect((await runCli(["numbers", "assign", NUM, "--trunk", "t-9", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "POST", body: { trunk_group_id: "t-9" } });
    expect((await runCli(["numbers", "unassign", NUM, "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", path: `${A}/numbers/${ENC}/assign` });
    expect((await runCli(["numbers", "assign", NUM], { fetch: api.fetch })).code).toBe(2); // --trunk missing
    expect((await runCli(["numbers", "unassign", NUM], { fetch: api.fetch })).code).toBe(6);
  });

  it("assign-subaccount / unassign-subaccount --force", async () => {
    const api = fakeFetch({ [`POST ${a}/numbers/${ENC}/assign-subaccount`]: reply(204), [`DELETE ${a}/numbers/${ENC}/assign-subaccount`]: reply(204) });
    expect((await runCli(["numbers", "assign-subaccount", NUM, "--sub-account", "SA_XXXXXXXX", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last().body).toEqual({ sub_account_id: "SA_XXXXXXXX" });
    expect((await runCli(["numbers", "unassign-subaccount", NUM, "--force", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", query: { force: "true" } });
  });
});

describe("numbers update (application / trunk links)", () => {
  const TRUNK = "e3e55a78-1234-5678-90ab-cdef12345678";
  const onTrunk = { items: [{ e164: NUM, trunk_group_id: TRUNK, application_id: null }] };
  const onApp = { items: [{ e164: NUM, trunk_group_id: null, application_id: "2057" }] };
  const writeRoutes = {
    [`POST ${A}/numbers/${NUM}/application`]: { message: "linked" },
    [`DELETE ${A}/numbers/${NUM}/application`]: { message: "unlinked" },
    [`POST ${A}/numbers/${NUM}/assign`]: reply(204),
    [`DELETE ${A}/numbers/${NUM}/assign`]: reply(204),
  };
  const writes = (calls: { method: string; path: string; body?: unknown }[]) => calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body]);

  it("--app links the number, removing it from its trunk first", async () => {
    const api = fakeFetch({ [`GET ${A}/numbers`]: onTrunk, ...writeRoutes });
    const r = await runCli(["numbers", "update", NUM, "--app", "12345678901234567", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.calls[0]).toMatchObject({ method: "GET", path: `${A}/numbers`, query: { search: NUM } });
    expect(writes(api.calls)).toEqual([
      ["DELETE", `${A}/numbers/${ENC}/assign`, undefined],
      ["POST", `${A}/numbers/${ENC}/application`, { application_id: "12345678901234567" }],
    ]);
    expect(r.err).toContain(`Remove ${NUM} from trunk ${TRUNK}, then Link ${NUM} to application 12345678901234567`);
    expect(r.err).toContain(`current trunk: ${TRUNK}`);
    expect(r.json()).toMatchObject({ e164: NUM, application_id: "12345678901234567", trunk_group_id: null });
  });

  it("--app on a number without a trunk sends only the link", async () => {
    const api = fakeFetch({ [`GET ${A}/numbers`]: owned, ...writeRoutes });
    const r = await runCli(["numbers", "update", NUM, "--app", "99", "--yes"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(writes(api.calls)).toEqual([["POST", `${A}/numbers/${ENC}/application`, { application_id: "99" }]]);
  });

  it("--unlink-app --trunk switches from an application to a trunk (unlink first)", async () => {
    const api = fakeFetch({ [`GET ${A}/numbers`]: onApp, ...writeRoutes });
    const r = await runCli(["numbers", "update", NUM, "--unlink-app", "--trunk", TRUNK, "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(writes(api.calls)).toEqual([
      ["DELETE", `${A}/numbers/${ENC}/application`, undefined],
      ["POST", `${A}/numbers/${ENC}/assign`, { trunk_group_id: TRUNK }],
    ]);
    expect(r.json()).toMatchObject({ application_id: null, trunk_group_id: TRUNK });
  });

  it("--unlink-trunk and --unlink-app each send one DELETE", async () => {
    let api = fakeFetch({ [`GET ${A}/numbers`]: onTrunk, ...writeRoutes });
    expect((await runCli(["numbers", "update", NUM, "--unlink-trunk", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(writes(api.calls)).toEqual([["DELETE", `${A}/numbers/${ENC}/assign`, undefined]]);
    api = fakeFetch({ [`GET ${A}/numbers`]: onApp, ...writeRoutes });
    expect((await runCli(["numbers", "update", NUM, "--unlink-app", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(writes(api.calls)).toEqual([["DELETE", `${A}/numbers/${ENC}/application`, undefined]]);
  });

  it("refuses conflicting or missing flags before any request", async () => {
    const api = fakeFetch({ [`GET ${A}/numbers`]: owned, ...writeRoutes });
    for (const args of [["--app", "1", "--trunk", TRUNK], ["--app", "1", "--unlink-app"], ["--trunk", TRUNK, "--unlink-trunk"], []]) {
      const r = await runCli(["numbers", "update", NUM, ...args, "--yes"], { fetch: api.fetch });
      expect(r.code, args.join(" ")).toBe(2);
    }
    expect(api.calls).toHaveLength(0);
  });

  it("needs --yes off a terminal, --dry-run sends no writes, an unknown number is not found", async () => {
    const api = fakeFetch({ [`GET ${A}/numbers`]: onTrunk, ...writeRoutes });
    expect((await runCli(["numbers", "update", NUM, "--app", "1"], { fetch: api.fetch })).code).toBe(6);
    const d = await runCli(["numbers", "update", NUM, "--app", "1", "--dry-run", "--json"], { fetch: api.fetch });
    expect(d.code, d.err).toBe(0);
    expect(d.json().steps.map((s: any) => [s.method, s.operation])).toEqual([
      ["DELETE", "unassign-number-from-trunk"],
      ["POST", "link-number-to-application"],
    ]);
    expect(writes(api.calls)).toHaveLength(0);
    expect((await runCli(["numbers", "update", "+14155550100", "--app", "1", "--yes"], { fetch: api.fetch })).code).toBe(4);
  });

  it("a failed link after the trunk was removed says how to finish", async () => {
    const api = fakeFetch({ [`GET ${A}/numbers`]: onTrunk, ...writeRoutes, [`POST ${A}/numbers/${NUM}/application`]: reply(404, { error: "application not found" }) });
    const r = await runCli(["numbers", "update", NUM, "--app", "1", "--yes"], { fetch: api.fetch });
    expect(r.code).toBe(4);
    expect(r.err).toContain(`Done: Remove ${NUM} from trunk ${TRUNK}. Failed: Link ${NUM} to application 1`);
    expect(r.err).toContain(`vobiz numbers update ${NUM} --app 1`);
  });
});
