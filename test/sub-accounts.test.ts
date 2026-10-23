import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_AUTH_ID, fakeFetch, reply, runCli } from "./helpers.js";

const S = `/api/v1/accounts/${TEST_AUTH_ID}/sub-accounts`;
const sub = { auth_id: "SA_XXXXXXXX", name: "Acme", email: null, enabled: true, is_active: true, auth_token: "real-sub-token-123", created_at: "2026-03-25" };

describe("sub-accounts", () => {
  it("list reads sub_accounts and redacts tokens", async () => {
    const api = fakeFetch({ [`GET ${S}/`]: { sub_accounts: [sub] } });
    const r = await runCli(["sub-accounts", "list", "-o", "table"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SA_XXXXXXXX");
    expect(r.out).not.toContain("real-sub-token-123");
    const j = await runCli(["sub-accounts", "list", "--json"], { fetch: api.fetch });
    expect(j.out).not.toContain("real-sub-token-123");
  });

  it("create reveals the Auth Token once, hides session tokens, prints the record", async () => {
    const api = fakeFetch({
      [`POST ${S}/`]: reply(201, {
        message: "created",
        sub_account: sub,
        auth_credentials: { auth_id: "SA_XXXXXXXX", auth_token: "real-sub-token-123" },
        tokens: { access_token: "jwt-access-abc", refresh_token: "jwt-refresh-def", token_type: "bearer", expires_in: 3600 },
      }),
    });
    const r = await runCli(["sub-accounts", "create", "--name", "Acme", "--kyc-mode", "customer_use", "--email", "o@example.com", "--business-type", "llp", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().body).toEqual({ name: "Acme", kyc_mode: "customer_use", email: "o@example.com", business_type: "llp" });
    expect(r.out).not.toContain("real-sub-token-123");
    expect(r.out).not.toContain("jwt-access-abc");
    expect(r.out).not.toContain("jwt-refresh-def");
    expect(r.json()).toMatchObject({ tokens: { token_type: "bearer" } });
    expect(r.err).not.toContain("real-sub-token-123");
    expect(r.err).toContain("A sub-account Auth Token was returned but not shown. Pass --reveal-secret or --secret-file");
    expect(r.err).toContain("Created sub-account SA_XXXXXXXX.");

    const shown = await runCli(["sub-accounts", "create", "--name", "Acme", "--kyc-mode", "personal_use", "--reveal-secret", "--yes"], { fetch: api.fetch });
    expect(shown.out).not.toContain("real-sub-token-123");
    expect(shown.err.match(/real-sub-token-123/g)).toHaveLength(1);

    const dir = mkdtempSync(join(tmpdir(), "vobiz-secret-"));
    const file = join(dir, "token");
    const saved = await runCli(["sub-accounts", "create", "--name", "Acme", "--kyc-mode", "personal_use", "--secret-file", file, "--yes"], { fetch: api.fetch });
    expect(saved.code).toBe(0);
    expect(saved.out + saved.err).not.toContain("real-sub-token-123");
    expect(readFileSync(file, "utf8")).toBe("real-sub-token-123\n");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const calls = api.calls.length;
    const again = await runCli(["sub-accounts", "create", "--name", "Acme", "--kyc-mode", "personal_use", "--secret-file", file, "--yes"], { fetch: api.fetch });
    expect(again.code).toBe(2);
    expect(api.calls).toHaveLength(calls);
  });

  it("create validates enums; update/delete/get paths", async () => {
    const api = fakeFetch({
      [`GET ${S}/SA_XXXXXXXX`]: sub,
      [`PUT ${S}/SA_XXXXXXXX`]: sub,
      [`DELETE ${S}/SA_XXXXXXXX`]: reply(204),
    });
    expect((await runCli(["sub-accounts", "create", "--name", "x", "--kyc-mode", "other", "--yes"], { fetch: api.fetch })).code).toBe(2);
    expect((await runCli(["sub-accounts", "get", "SA_XXXXXXXX", "--json"], { fetch: api.fetch })).code).toBe(0);
    expect((await runCli(["sub-accounts", "update", "SA_XXXXXXXX", "--name", "Acme 2", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "PUT", body: { name: "Acme 2" } });
    expect((await runCli(["sub-accounts", "delete", "SA_XXXXXXXX"], { fetch: api.fetch })).code).toBe(6);
    expect((await runCli(["sub-accounts", "delete", "SA_XXXXXXXX", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", path: `${S}/SA_XXXXXXXX` });
  });
});

describe("sub-accounts update --active (live: the API honours is_active, ignores enabled)", () => {
  it("--no-active sends is_active false and the confirmation warns it cannot be undone through the API", async () => {
    const api = fakeFetch({ [`PUT ${S}/SA_XXXXXXXX`]: sub });
    const dry = await runCli(["sub-accounts", "update", "SA_XXXXXXXX", "--no-active", "--dry-run", "--yes"], { fetch: api.fetch });
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out + dry.err).toContain("cannot be reactivated through the API");
    expect(api.calls).toHaveLength(0);
    expect((await runCli(["sub-accounts", "update", "SA_XXXXXXXX", "--no-active"], { fetch: api.fetch })).code).toBe(6);
    expect((await runCli(["sub-accounts", "update", "SA_XXXXXXXX", "--no-active", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "PUT", body: { is_active: false } });
    expect((await runCli(["sub-accounts", "update", "SA_XXXXXXXX", "--active", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last().body).toEqual({ is_active: true });
  });

  it("--enabled/--no-enabled is a deprecated alias that sets is_active, never enabled", async () => {
    const api = fakeFetch({ [`PUT ${S}/SA_XXXXXXXX`]: sub });
    const r = await runCli(["sub-accounts", "update", "SA_XXXXXXXX", "--no-enabled", "--yes"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.last().body).toEqual({ is_active: false });
    expect(r.err).toContain("--enabled is deprecated; use --active");
    expect((await runCli(["sub-accounts", "update", "SA_XXXXXXXX", "--no-enabled", "--active", "--yes"], { fetch: api.fetch })).code).toBe(2);
  });
});

describe("sub-accounts kyc", () => {
  const K = "/api/v1/sub-accounts/SA_XXXXXXXX/kyc";
  const T = "/api/v1/sub-accounts/test/SA_XXXXXXXX/kyc";

  it("status", async () => {
    const api = fakeFetch({ [`GET ${K}/status`]: { sub_account_id: "SA_XXXXXXXX", overall_status: "pending" } });
    const r = await runCli(["sub-accounts", "kyc", "status", "SA_XXXXXXXX", "--json"], { fetch: api.fetch });
    expect(r.json()).toMatchObject({ overall_status: "pending" });
    expect((await runCli(["sub-accounts", "kyc", "--test", "status", "SA_XXXXXXXX"], { fetch: api.fetch })).code).toBe(2);
  });

  it("live and --test variants of every verification", async () => {
    const api = fakeFetch(
      Object.fromEntries(
        ["verify-pan", "verify-gst", "cin/search", "cin/confirm", "digilocker/initiate", "digilocker/verify", "finalize-pending"].flatMap((p) => [
          [`POST ${K}/${p}`, { ok: "live" }],
          [`POST ${T}/${p}`, { ok: "test" }],
        ]),
      ),
    );
    const cases: [string[], string, Record<string, unknown>][] = [
      [["verify-pan", "SA_XXXXXXXX", "--pan", "ABCDE1234F"], "verify-pan", { pan: "ABCDE1234F" }],
      [["verify-gst", "SA_XXXXXXXX", "--gstin", "29ABCDE1234F1Z5"], "verify-gst", { gstin: "29ABCDE1234F1Z5" }],
      [["cin", "search", "SA_XXXXXXXX", "--company-name", "Acme"], "cin/search", { company_name: "Acme" }],
      [["cin", "confirm", "SA_XXXXXXXX", "--company-name", "Acme", "--selected-cin", "U1"], "cin/confirm", { company_name: "Acme", selected_cin: "U1" }],
      [["digilocker", "initiate", "SA_XXXXXXXX", "--redirect-url", "https://example.com/done"], "digilocker/initiate", { redirect_url: "https://example.com/done" }],
      [["digilocker", "verify", "SA_XXXXXXXX", "--access-request-id", "MOCK_AR_SUCCESS"], "digilocker/verify", { access_request_id: "MOCK_AR_SUCCESS" }],
    ];
    for (const [args, path, body] of cases) {
      const live = await runCli(["sub-accounts", "kyc", ...args, "--yes", "--json"], { fetch: api.fetch });
      expect(live.code, args.join(" ")).toBe(0);
      expect(api.last()).toMatchObject({ method: "POST", path: `${K}/${path}`, body });
      const test = await runCli(["sub-accounts", "kyc", ...args, "--test", "--yes", "--json"], { fetch: api.fetch });
      expect(test.code, args.join(" ")).toBe(0);
      expect(api.last()).toMatchObject({ method: "POST", path: `${T}/${path}`, body });
      expect(test.err).toContain("TEST MODE");
    }
  });

  it("rejects flags the Test Mode operation does not take", async () => {
    const api = fakeFetch({});
    const r = await runCli(["sub-accounts", "kyc", "--test", "digilocker", "initiate", "SA_XXXXXXXX", "--redirect-url", "https://e.com", "--oauth-state", "s", "--yes"], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--oauth-state");
    expect(api.calls).toHaveLength(0);
  });

  it("--help leaves out --test and finalize-pending, which stay callable", async () => {
    const r = await runCli(["sub-accounts", "kyc", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("verify-pan");
    expect(r.out).not.toContain("--test");
    expect(r.out).not.toContain("finalize-pending");
  });

  it("finalize-pending is Test Mode only", async () => {
    const api = fakeFetch({ [`POST ${T}/finalize-pending`]: { status: "verified" } });
    expect((await runCli(["sub-accounts", "kyc", "finalize-pending", "SA_XXXXXXXX", "--verification-type", "pan", "--outcome", "verified", "--yes"], { fetch: api.fetch })).code).toBe(2);
    const r = await runCli(["sub-accounts", "kyc", "--test", "finalize-pending", "SA_XXXXXXXX", "--verification-type", "pan", "--outcome", "verified", "--yes"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().body).toEqual({ verification_type: "pan", outcome: "verified" });
  });

  it("session create defaults account_auth_id to the sub-account; confirmation needed", async () => {
    const api = fakeFetch({ ["POST /api/v1/sub-accounts/SA_XXXXXXXX/kyc-sessions"]: reply(201, { session_id: "s-1", status: "email_sent" }) });
    expect((await runCli(["sub-accounts", "kyc", "session", "create", "SA_XXXXXXXX", "--flow-type", "email", "--customer-email", "c@example.com"], { fetch: api.fetch })).code).toBe(6);
    const r = await runCli(["sub-accounts", "kyc", "session", "create", "SA_XXXXXXXX", "--flow-type", "email", "--customer-email", "c@example.com", "--expires-in-days", "3", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().body).toEqual({ account_auth_id: "SA_XXXXXXXX", flow_type: "email", customer_email: "c@example.com", expires_in_days: 3 });
    expect((await runCli(["sub-accounts", "kyc", "--test", "session", "create", "SA_XXXXXXXX", "--flow-type", "email", "--yes"], { fetch: api.fetch })).code).toBe(2);
  });

  it("--dry-run sends nothing", async () => {
    const api = fakeFetch({});
    const r = await runCli(["sub-accounts", "kyc", "verify-pan", "SA_XXXXXXXX", "--pan", "ABCDE1234F", "--dry-run", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.calls).toHaveLength(0);
    expect(r.json()).toMatchObject({ operation: "verify-subaccount-pan" });
  });
});
