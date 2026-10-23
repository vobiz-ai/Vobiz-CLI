import { describe, expect, it } from "vitest";
import { TEST_AUTH_ID, TEST_AUTH_TOKEN, fakeFetch, reply, runCli } from "./helpers.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const ACC = `/api/v1/accounts/${TEST_AUTH_ID}`;
const NOW = () => new Date(2026, 9, 22, 12, 0, 0);

describe("vobiz account", () => {
  it("show reads /auth/me", async () => {
    const api = fakeFetch({ "GET /api/v1/auth/me": { name: "Test Account", auth_id: TEST_AUTH_ID } });
    const r = await runCli(["account", "show", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ name: "Test Account" });
    expect(api.last()).toMatchObject({ method: "GET", path: "/api/v1/auth/me" });
  });

  it("balance uses the pricing tier currency, or --currency", async () => {
    const api = fakeFetch({
      "GET /api/v1/auth/me": { pricing_tier: { currency: "usd" } },
      [`GET ${A}/balance/USD`]: { currency: "USD", balance: 12.5 },
      [`GET ${A}/balance/INR`]: { currency: "INR", balance: 100 },
    });
    let r = await runCli(["account", "balance", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ currency: "USD", balance: 12.5 });
    expect(api.calls.map((c) => c.path)).toEqual(["/api/v1/auth/me", `${A}/balance/USD`]);

    api.calls.length = 0;
    r = await runCli(["account", "balance", "--currency", "inr", "--json"], { fetch: api.fetch });
    expect(r.json()).toMatchObject({ currency: "INR" });
    expect(api.calls).toHaveLength(1);
    expect((await runCli(["account", "balance", "--currency", "rupees"], { fetch: api.fetch })).code).toBe(2);
  });

  it("concurrency", async () => {
    const api = fakeFetch({ [`GET ${A}/concurrency`]: { concurrent_calls: 1, max_concurrent: 46 } });
    const r = await runCli(["account", "concurrency", "--json"], { fetch: api.fetch });
    expect(r.json()).toMatchObject({ max_concurrent: 46 });
  });

  it("transactions list maps filters and keeps the response shape", async () => {
    const api = fakeFetch({
      [`GET ${A}/transactions`]: (req) => ({
        transactions: [{ id: "t1", type: "debit", amount: 0.08 }],
        summary: { total_transactions: 1 },
        total: 1,
        page: Number(req.query.page),
        per_page: 20,
        total_pages: 1,
      }),
    });
    const r = await runCli(
      ["account", "transactions", "list", "--from", "7d", "--to", "today", "--type", "debit", "--status", "completed", "--reference-type", "cdr", "--json"],
      { fetch: api.fetch, now: NOW },
    );
    expect(r.code).toBe(0);
    expect(api.last().query).toEqual({
      from_date: "2026-10-15",
      to_date: "2026-10-22",
      type: "debit",
      status: "completed",
      reference_type: "cdr",
      page: "1",
      per_page: "20",
    });
    expect(r.json()).toMatchObject({ transactions: [{ id: "t1" }], summary: { total_transactions: 1 }, total: 1 });
    expect((await runCli(["account", "transactions", "list", "--status", "weird"], { fetch: api.fetch })).code).toBe(2);
  });

  it("transactions list --all follows pages", async () => {
    const api = fakeFetch({
      [`GET ${A}/transactions`]: (req) => ({ transactions: [{ id: `t${req.query.page}` }], total: 3 }),
    });
    const r = await runCli(["account", "transactions", "list", "--all", "--output", "plain", "--fields", "id"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual(["t1", "t2", "t3"]);
    expect(api.calls).toHaveLength(3);
  });

  it("transactions types", async () => {
    const api = fakeFetch({ [`GET ${A}/transactions/reference-types`]: { reference_types: ["cdr", "did_rental"] } });
    const r = await runCli(["account", "transactions", "types", "--output", "plain"], { fetch: api.fetch });
    expect(r.out).toBe("cdr\ndid_rental\n");
  });

  it("channel-pricing previews without charging", async () => {
    const api = fakeFetch({ [`GET ${ACC}/channel-pricing-preview`]: { monthly_cost: "10470.00", currency: "INR" } });
    const r = await runCli(["account", "channel-pricing", "--type", "concurrent_calls", "--quantity", "30", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().query).toEqual({ resource_type: "concurrent_calls", quantity: "30" });
    expect((await runCli(["account", "channel-pricing", "--type", "x", "--quantity", "3"], { fetch: api.fetch })).code).toBe(2);
    expect((await runCli(["account", "channel-pricing", "--type", "cps", "--quantity", "0"], { fetch: api.fetch })).code).toBe(2);
  });

  describe("channel-subscriptions create", () => {
    const routes = {
      [`GET ${ACC}/channel-pricing-preview`]: { monthly_cost: "500.00", currency: "INR" },
      [`POST ${ACC}/channel-subscriptions`]: reply(201, { id: "sub1", status: "active" }),
    };

    it("shows the price and refuses without --yes when stdin is not a TTY", async () => {
      const api = fakeFetch(routes);
      const r = await runCli(["account", "channel-subscriptions", "create", "--type", "cps", "--quantity", "5"], { fetch: api.fetch });
      expect(r.code).toBe(6);
      expect(api.calls.map((c) => c.method)).toEqual(["GET"]);
    });

    it("purchases with --yes", async () => {
      const api = fakeFetch(routes);
      const r = await runCli(["account", "channel-subscriptions", "create", "--type", "cps", "--quantity", "5", "--yes", "--json"], { fetch: api.fetch });
      expect(r.code).toBe(0);
      expect(r.err).toContain("INR 500.00");
      expect(api.last()).toMatchObject({ method: "POST", path: `${ACC}/channel-subscriptions`, body: { resource_type: "cps", quantity: 5 } });
      expect(r.json()).toMatchObject({ id: "sub1" });
    });

    it("asks on a TTY and stops on no", async () => {
      const api = fakeFetch(routes);
      const r = await runCli(["account", "channel-subscriptions", "create", "--type", "cps", "--quantity", "5"], { fetch: api.fetch, stdinTTY: true, prompts: { confirm: false } });
      expect(r.code).toBe(6);
      expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });

    it("--dry-run previews the price but sends no purchase", async () => {
      const api = fakeFetch(routes);
      const r = await runCli(["account", "channel-subscriptions", "create", "--type", "cps", "--quantity", "5", "--dry-run", "--json"], { fetch: api.fetch });
      expect(r.code).toBe(0);
      expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
      expect(r.json()).toMatchObject({ dry_run: true, method: "POST", body: { resource_type: "cps", quantity: 5 } });
      expect(r.out + r.err).not.toContain(TEST_AUTH_TOKEN);
    });
  });
});
