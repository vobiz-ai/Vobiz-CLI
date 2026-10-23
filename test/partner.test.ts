import { describe, expect, it } from "vitest";
import { fakeFetch, reply, runCli } from "./helpers.js";

const P = "/api/v1/partner";
const NOW = () => new Date(2026, 9, 22, 12, 0, 0);

describe("partner", () => {
  it("me and dashboard", async () => {
    const api = fakeFetch({ [`GET ${P}/me`]: { auth_id: "PA_XXXXXXXX", balance: 100 }, [`GET ${P}/dashboard`]: { total_customers: 3 } });
    expect((await runCli(["partner", "me", "--json"], { fetch: api.fetch })).json()).toMatchObject({ auth_id: "PA_XXXXXXXX" });
    expect((await runCli(["partner", "dashboard", "--json"], { fetch: api.fetch })).json()).toMatchObject({ total_customers: 3 });
  });

  it("accounts list paginates and searches", async () => {
    const api = fakeFetch({ [`GET ${P}/accounts`]: { accounts: [{ auth_id: "MA_XXXXXXXX", name: "Acme", auth_token: "tok-should-hide" }], total: 1 } });
    const r = await runCli(["partner", "accounts", "list", "--search", "acme", "--limit", "10", "-o", "table"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().query).toEqual({ search: "acme", page: "1", per_page: "10" });
    expect(r.out).toContain("MA_XXXXXXXX");
    expect(r.out).not.toContain("tok-should-hide");
  });

  it("accounts create shows the customer Auth Token only with --reveal-secret", async () => {
    const api = fakeFetch({ [`POST ${P}/accounts`]: reply(201, { auth_id: "MA_NEWNEWNE", auth_token: "cust-secret-token", name: "Jane" }) });
    const args = ["partner", "accounts", "create", "--name", "Jane", "--email", "j@example.com", "--phone", "+919876543210", "--password", "Pa55word!", "--country", "IN"];
    expect((await runCli(args, { fetch: api.fetch })).code).toBe(6);
    const r = await runCli([...args, "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().body).toEqual({ name: "Jane", email: "j@example.com", phone: "+919876543210", password: "Pa55word!", country: "IN" });
    expect(r.out).not.toContain("cust-secret-token");
    expect(r.err).not.toContain("cust-secret-token");
    const shown = await runCli([...args, "--reveal-secret", "--yes"], { fetch: api.fetch });
    expect(shown.err.match(/cust-secret-token/g)).toHaveLength(1);
    expect(shown.out + shown.err).not.toContain("Pa55word!");
  });

  it("transfer-balance confirms with the amount and refuses non-TTY without --yes", async () => {
    const api = fakeFetch({ [`POST ${P}/accounts/MA_XXXXXXXX/transfer-balance`]: { transaction_id: "txn_1", status: "completed" } });
    const args = ["partner", "accounts", "transfer-balance", "MA_XXXXXXXX", "--amount", "500", "--currency", "INR", "--description", "April"];
    const no = await runCli(args, { fetch: api.fetch });
    expect(no.code).toBe(6);
    expect(api.calls).toHaveLength(0);
    const dry = await runCli([...args, "--dry-run", "--json"], { fetch: api.fetch });
    expect(dry.code).toBe(0);
    expect(api.calls).toHaveLength(0);
    expect(dry.err).toContain("INR 500 debited from your partner balance");
    const r = await runCli([...args, "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().body).toEqual({ amount: 500, currency: "INR", description: "April" });
    expect((await runCli(["partner", "accounts", "transfer-balance", "MA_XXXXXXXX", "--amount", "-5", "--currency", "INR", "--yes"], { fetch: api.fetch })).code).toBe(2);
    expect((await runCli(["partner", "accounts", "transfer-balance", "MA_XXXXXXXX", "--amount", "abc", "--currency", "INR", "--yes"], { fetch: api.fetch })).code).toBe(2);
  });

  it("transactions, cdrs and numbers pass filters; dates accept relative values", async () => {
    const api = fakeFetch({
      [`GET ${P}/accounts/MA_XXXXXXXX/transactions`]: { transactions: [{ id: "t1", amount: 5 }] },
      [`GET ${P}/accounts/MA_XXXXXXXX/cdrs`]: { success: true, data: [{ call_direction: "outbound" }] },
      [`GET ${P}/accounts/MA_XXXXXXXX/numbers`]: { items: [{ e164: "+918012345678" }], total: 1 },
    });
    const t = await runCli(["partner", "accounts", "transactions", "MA_XXXXXXXX", "--from-date", "7d", "--to-date", "2026-10-22", "--transaction-type", "transfer", "--json"], { fetch: api.fetch, now: NOW });
    expect(t.code).toBe(0);
    expect(api.last().query).toMatchObject({ from_date: "2026-10-15", to_date: "2026-10-22", transaction_type: "transfer", page: "1" });
    const c = await runCli(["partner", "accounts", "cdrs", "MA_XXXXXXXX", "--call-direction", "outbound", "--min-duration", "5", "--json"], { fetch: api.fetch });
    expect(c.code).toBe(0);
    expect(api.last().query).toMatchObject({ call_direction: "outbound", min_duration: "5" });
    expect((await runCli(["partner", "accounts", "cdrs", "MA_XXXXXXXX", "--status", "weird"], { fetch: api.fetch })).code).toBe(2);
    // --from/--to, the CLI-wide date-window names, set the spec's own date params.
    expect((await runCli(["partner", "accounts", "cdrs", "MA_XXXXXXXX", "--from", "7d", "--to", "2026-10-22", "--json"], { fetch: api.fetch, now: NOW })).code).toBe(0);
    expect(api.last().query).toMatchObject({ start_date: "2026-10-15", end_date: "2026-10-22" });
    expect((await runCli(["partner", "accounts", "transactions", "MA_XXXXXXXX", "--from", "7d", "--json"], { fetch: api.fetch, now: NOW })).code).toBe(0);
    expect(api.last().query).toMatchObject({ from_date: "2026-10-15" });
    expect((await runCli(["partner", "accounts", "cdrs", "MA_XXXXXXXX", "--from", "7d", "--start-date", "1d"], { fetch: api.fetch })).code).toBe(2);
    const n = await runCli(["partner", "accounts", "numbers", "MA_XXXXXXXX", "--search", "+9180", "-q"], { fetch: api.fetch });
    expect(n.out).toBe("+918012345678\n");
  });

  it("kyc-sessions list / get / create / revoke / resend", async () => {
    const api = fakeFetch({
      [`GET ${P}/kyc-sessions`]: { sessions: [{ id: "kycs_1", status: "opened" }] },
      [`GET ${P}/kyc-sessions/kycs_1`]: { id: "kycs_1" },
      [`POST ${P}/kyc-sessions`]: reply(201, { session_id: "kycs_2", status: "email_sent" }),
      [`DELETE ${P}/kyc-sessions/kycs_1`]: { message: "Session revoked" },
      [`POST ${P}/kyc-sessions/kycs_1/resend`]: { message: "sent" },
    });
    const l = await runCli(["partner", "kyc-sessions", "list", "--status", "opened", "--limit", "5", "--json"], { fetch: api.fetch });
    expect(l.code).toBe(0);
    expect(api.last().query).toMatchObject({ status: "opened", page: "1", size: "5" });
    expect((await runCli(["partner", "kyc-sessions", "get", "kycs_1", "--json"], { fetch: api.fetch })).json()).toMatchObject({ id: "kycs_1" });
    const c = await runCli(
      ["partner", "kyc-sessions", "create", "--account-auth-id", "MA_XXXXXXXX", "--flow-type", "redirect", "--redirect-url", "https://example.com/done", "--metadata", '{"crm":"42"}', "--reminder-schedule", '[{"days_before_expiry":2}]', "--yes", "--json"],
      { fetch: api.fetch },
    );
    expect(c.code).toBe(0);
    expect(api.last().body).toEqual({ account_auth_id: "MA_XXXXXXXX", flow_type: "redirect", redirect_url: "https://example.com/done", metadata: { crm: "42" }, reminder_schedule: [{ days_before_expiry: 2 }] });
    expect(c.err).toContain("redirect_host: example.com");
    expect((await runCli(["partner", "kyc-sessions", "create", "--account-auth-id", "MA_X", "--metadata", "{bad", "--yes"], { fetch: api.fetch })).code).toBe(2);
    expect((await runCli(["partner", "kyc-sessions", "revoke", "kycs_1"], { fetch: api.fetch })).code).toBe(6);
    expect((await runCli(["partner", "kyc-sessions", "revoke", "kycs_1", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", path: `${P}/kyc-sessions/kycs_1` });
    expect(api.last().body).toBeUndefined();
    const why = await runCli(["partner", "kyc-sessions", "revoke", "kycs_1", "--reason", "sent to the wrong email", "--yes"], { fetch: api.fetch });
    expect(why.code).toBe(0);
    expect(why.err).toContain("reason: sent to the wrong email");
    expect(api.last()).toMatchObject({ method: "DELETE", body: { reason: "sent to the wrong email" } });
    expect(api.last().headers["content-type"]).toBe("application/json");
    expect((await runCli(["partner", "kyc-sessions", "resend", "kycs_1", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "POST", path: `${P}/kyc-sessions/kycs_1/resend` });
  });
});

describe("--secret-file is created before the request", async () => {
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const args = ["partner", "accounts", "create", "--name", "Jane", "--email", "jane@example.com", "--phone", "+919876543210", "--country", "IN", "--password", "Passw0rd!x", "--yes"];

  it("a missing folder fails before any request", async () => {
    const api = fakeFetch({ [`POST ${P}/accounts`]: reply(201, { auth_id: "MA_NEWNEWNE", auth_token: "cust-secret-token" }) });
    const r = await runCli([...args, "--secret-file", "/nonexistent-dir-vobiz/secret.txt"], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(api.calls).toHaveLength(0);
  });

  it("writes the secret into the pre-created 0600 file, and removes it when the request fails", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "vobiz-secret-"));
    const ok = fakeFetch({ [`POST ${P}/accounts`]: reply(201, { auth_id: "MA_NEWNEWNE", auth_token: "cust-secret-token" }) });
    const file = path.join(dir, "token.txt");
    const r = await runCli([...args, "--secret-file", file], { fetch: ok.fetch });
    expect(r.code, r.err).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("cust-secret-token\n");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const bad = fakeFetch({ [`POST ${P}/accounts`]: reply(400, { message: "email taken" }) });
    const failed = path.join(dir, "failed.txt");
    expect((await runCli([...args, "--secret-file", failed], { fetch: bad.fetch })).code).toBe(2);
    expect(fs.existsSync(failed)).toBe(false);
  });
});
