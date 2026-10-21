import { describe, expect, it } from "vitest";
import { EXIT, VobizError, extractBackendMessage, kindForStatus } from "../src/core/errors.js";
import { TEST_AUTH_ID, fakeFetch, networkError, reply, runCli } from "./helpers.js";

describe("error mapping", () => {
  it("maps HTTP statuses to kinds", () => {
    const table: [number, string][] = [
      [400, "invalid_input"],
      [401, "auth_failed"],
      [402, "insufficient_balance"],
      [403, "forbidden"],
      [404, "not_found"],
      [422, "invalid_input"],
      [423, "account_suspended"],
      [429, "rate_limited"],
      [500, "backend_error"],
      [502, "service_unavailable"],
      [503, "service_unavailable"],
      [504, "service_unavailable"],
      [418, "unexpected_response"],
    ];
    for (const [status, kind] of table) expect(kindForStatus(status), String(status)).toBe(kind);
  });

  it("has stable exit codes", () => {
    expect(EXIT).toMatchObject({
      ok: 0,
      backend_error: 1,
      usage: 2,
      invalid_input: 2,
      missing_credentials: 3,
      auth_failed: 3,
      not_found: 4,
      rate_limited: 5,
      insufficient_balance: 5,
      confirmation_required: 6,
      outcome_unknown: 7,
      timeout: 8,
      network_error: 8,
    });
    expect(new VobizError("not_found", "x").exitCode).toBe(4);
  });

  it("extracts a short backend message", () => {
    expect(extractBackendMessage({ error: "bad number" })).toBe("bad number");
    expect(extractBackendMessage({ errors: [{ field: "to", message: "required" }] })).toBe("to: required");
    expect(extractBackendMessage("x".repeat(1000))?.length).toBe(300);
    expect(extractBackendMessage(undefined)).toBeUndefined();
  });
});

describe("exit codes from run()", () => {
  const me = "GET /api/v1/auth/me";
  const cases: [string, unknown, number, string][] = [
    ["401", reply(401, { error: "invalid credentials" }), 3, "auth_failed"],
    ["404", reply(404, { message: "nope" }), 4, "not_found"],
    ["429", reply(429, {}), 5, "rate_limited"],
    ["402", reply(402, { error: "low balance" }), 5, "insufficient_balance"],
    ["500", reply(500, {}), 1, "backend_error"],
    ["network", networkError(), 8, "network_error"],
  ];
  for (const [name, value, code, kind] of cases) {
    it(`${name} -> exit ${code}`, async () => {
      const r = await runCli(["api", "GET", "/api/v1/auth/me"], { fetch: fakeFetch({ [me]: value }).fetch });
      expect(r.code).toBe(code);
      expect(r.err).toContain(`vobiz: ${kind}:`);
      expect(r.out).toBe("");
    });
  }

  it("prints errors as JSON with --output json", async () => {
    const r = await runCli(["api", "GET", "/api/v1/auth/me", "--output", "json"], { fetch: fakeFetch({ [me]: reply(404, { error: "gone" }) }).fetch });
    expect(r.code).toBe(4);
    expect(JSON.parse(r.err.trim())).toMatchObject({ error: "not_found", message: "gone", status: 404, retryable: false });
  });

  it("usage errors exit 2", async () => {
    expect((await runCli(["no-such-command"])).code).toBe(2);
    expect((await runCli(["whoami", "--no-such-flag"])).code).toBe(2);
    expect((await runCli(["--output", "xml", "whoami"])).code).toBe(2);
    expect((await runCli(["--timeout", "abc", "whoami"])).code).toBe(2);
  });

  it("missing credentials exit 3 with a hint", async () => {
    const r = await runCli(["whoami"], { loggedOut: true });
    expect(r.code).toBe(3);
    expect(r.err).toContain("vobiz login");
  });

  it("help and version exit 0", async () => {
    expect((await runCli(["--help"])).code).toBe(0);
    const v = await runCli(["--version"]);
    expect(v.code).toBe(0);
    expect(v.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("whoami works offline from env credentials", async () => {
    const api = fakeFetch();
    const r = await runCli(["whoami", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ auth_id: TEST_AUTH_ID, source: "env", account_type: "main account" });
    expect(api.calls).toHaveLength(0);
  });
});
