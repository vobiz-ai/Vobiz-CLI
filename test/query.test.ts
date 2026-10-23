import { describe, expect, it } from "vitest";
import { fakeFetch, runCli, TEST_AUTH_ID } from "./helpers.js";

const NUMBERS = `GET /api/v1/Account/${TEST_AUTH_ID}/numbers`;
const page = { items: [{ e164: "+919876543210", country: "IN" }, { e164: "+918065550100", country: "IN" }], total: 2, page: 1, per_page: 20 };

describe("global --output jsonl and --query", () => {
  it("prints one row per line for a list command", async () => {
    const api = fakeFetch({ [NUMBERS]: page });
    const r = await runCli(["numbers", "list", "--output", "jsonl"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").map((l) => JSON.parse(l).e164)).toEqual(["+919876543210", "+918065550100"]);
  });

  it("--query selects a path of the printed JSON (before or after the subcommand)", async () => {
    const api = fakeFetch({ [NUMBERS]: page });
    let r = await runCli(["numbers", "list", "--json", "--query", "items[*].e164"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.json()).toEqual(["+919876543210", "+918065550100"]);
    // Human modes print the rows, so the path reads the row list there.
    r = await runCli(["--query", "[0].e164", "--output", "plain", "numbers", "list"], { fetch: api.fetch });
    expect(r.out).toBe("+919876543210\n");
  });

  it("rejects a malformed or repeated --query with exit 2 before any request", async () => {
    const api = fakeFetch({ [NUMBERS]: page });
    let r = await runCli(["numbers", "list", "--query", "items[x]"], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--query");
    r = await runCli(["numbers", "list", "--query", "a", "--query", "b"], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(api.calls).toHaveLength(0);
  });

  it("sends `vobiz api --param k=v` as query-string parameters and applies the global --query to the result", async () => {
    const api = fakeFetch({ [`GET /api/v1/Account/${TEST_AUTH_ID}/Call/`]: (req) => ({ echo: req.query }) });
    const r = await runCli(["api", "GET", "/api/v1/Account/{auth_id}/Call/", "--param", "status=live", "--param", "limit=2", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().query).toEqual({ status: "live", limit: "2" });
    expect(r.json()).toEqual({ echo: { status: "live", limit: "2" } });
    const filtered = await runCli(["api", "GET", "/api/v1/Account/{auth_id}/Call/", "--param", "status=live", "--json", "--query", "echo.status"], { fetch: api.fetch });
    expect(filtered.code).toBe(0);
    expect(filtered.json()).toEqual("live");
  });
});
