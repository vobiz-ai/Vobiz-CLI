/**
 * S6 agent-safety regressions (docs/internal/security/S6-authorization-and-agents.md, docs/internal/security/FIXES-S6.md).
 * Placeholder credentials only; every request goes to a fake fetch.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/core/config.js";
import { assertSecureBaseUrl, resolveCredentials } from "../src/core/credentials.js";
import { VobizClient } from "../src/core/client.js";
import { kindForResponse } from "../src/core/errors.js";
import { op } from "../src/core/ops.js";
import { TEST_AUTH_ID, TEST_AUTH_TOKEN, VOICE_BASE, SMS_BASE, fakeFetch, hang, reply } from "./helpers.js";
import { runCli } from "./helpers.js";

const CALL = `/api/v1/Account/${TEST_AUTH_ID}/Call/`;
const PREVIEW = { channel: "sms", segmentCount: 1, unitCost: 0.0079, totalCost: 0.0079, currency: "USD", country: "US" };

describe("#1 5xx on a write is outcome_unknown", () => {
  it("maps 5xx/408 on side-effecting requests only", () => {
    for (const s of [500, 502, 503, 504, 408]) {
      expect(kindForResponse(s, true), String(s)).toBe("outcome_unknown");
      expect(kindForResponse(s, false), String(s)).not.toBe("outcome_unknown");
    }
    expect(kindForResponse(400, true)).toBe("invalid_input");
    expect(kindForResponse(429, true)).toBe("rate_limited");
  });

  const writes: { name: string; argv: string[]; route: string }[] = [
    { name: "calls create", argv: ["calls", "create", "--to", "+919876543210", "--from", "+918012345678", "--answer-url", "https://example.com/a"], route: `POST ${CALL}` },
    { name: "transfer-balance", argv: ["partner", "accounts", "transfer-balance", "MA_YYYYYYYY", "--amount", "500", "--currency", "INR"], route: "POST /api/v1/partner/accounts/MA_YYYYYYYY/transfer-balance" },
    { name: "vobiz api POST", argv: ["api", "POST", "/api/v1/Account/{auth_id}/Number/+14155550100/", "--body", "{}"], route: `POST /api/v1/Account/${TEST_AUTH_ID}/Number/+14155550100/` },
  ];
  for (const w of writes)
    for (const status of [500, 502, 504]) {
      it(`${w.name} -> ${status} exits 7, retryable false`, async () => {
        const api = fakeFetch({ [w.route]: reply(status, { message: "Gateway Timeout" }) });
        const r = await runCli([...w.argv, "--yes", "--json"], { fetch: api.fetch });
        expect(r.code, r.err).toBe(7);
        const e = JSON.parse(r.err.trim().split("\n").pop()!);
        expect(e).toMatchObject({ error: "outcome_unknown", status, retryable: false });
        expect(e.message).toMatch(/vobiz cdr recent/);
        expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(1);
      });
    }

  it("sms send -> 502 exits 7", async () => {
    const api = fakeFetch({ "GET /messages/cost-preview": PREVIEW, "POST /messages": reply(502, { message: "Bad Gateway" }) });
    const r = await runCli(["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hi", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(7);
  });

  it("reads keep the retryable mapping", async () => {
    const api = fakeFetch({ "GET /api/v1/auth/me": reply(503, { message: "down" }) });
    const r = await runCli(["api", "GET", "/api/v1/auth/me", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err.trim())).toMatchObject({ error: "service_unavailable", retryable: true });
  });

  it("a timed-out write is outcome_unknown with the check-state hint", async () => {
    const client = new VobizClient({
      creds: { authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN, voiceBaseUrl: VOICE_BASE, smsBaseUrl: SMS_BASE, source: "env" },
      fetch: fakeFetch({ [`POST ${CALL}`]: hang() }).fetch,
      timeoutMs: 20,
    });
    await expect(client.call(op("make-call"), { body: {}, sideEffect: true })).rejects.toMatchObject({ kind: "outcome_unknown", message: expect.stringMatching(/account transactions/) });
  });
});

describe("#2 base-URL host allow-list", () => {
  const ENV_CREDS = { VOBIZ_AUTH_ID: "MA_E", VOBIZ_AUTH_TOKEN: "ENV_TOKEN_1" };
  const profileStore = (voiceBaseUrl: string) => {
    const s = new ConfigStore(mkdtempSync(join(tmpdir(), "vobiz-s6-")));
    s.setProfile("default", { authId: "MA_P", authToken: "PROFILE_TOKEN", voiceBaseUrl });
    return s;
  };

  it("accepts *.vobiz.ai and loopback, rejects look-alikes", () => {
    for (const ok of ["https://api.vobiz.ai", "https://vobiz.ai", "https://staging.api.vobiz.ai/x", "https://localhost:8443"]) expect(assertSecureBaseUrl(ok, "--base-url", {})).toBe(ok);
    for (const bad of ["https://attacker.example", "https://vobiz.ai.attacker.example", "https://api-vobiz.ai", "https://api.vobiz.ai@attacker.example"])
      expect(() => assertSecureBaseUrl(bad, "--base-url", {}), bad).toThrow(/not a Vobiz host/);
    expect(assertSecureBaseUrl("https://attacker.example", "--base-url", { VOBIZ_ALLOW_ANY_BASE_URL: "1" })).toBe("https://attacker.example");
  });

  it("checks the flag, env and profile paths", () => {
    const s = profileStore("https://api.vobiz.ai");
    expect(() => resolveCredentials({ baseUrl: "https://attacker.example" }, s, {})).toThrow(/--base-url points at attacker.example/);
    expect(() => resolveCredentials({}, s, { ...ENV_CREDS, VOBIZ_BASE_URL: "https://attacker.example" })).toThrow(/VOBIZ_BASE_URL/);
    expect(() => resolveCredentials({}, s, { ...ENV_CREDS, VOBIZ_SMS_BASE_URL: "https://attacker.example/sms" })).toThrow(/VOBIZ_SMS_BASE_URL/);
    expect(() => resolveCredentials({}, profileStore("https://attacker.example"), {})).toThrow(/profile's voiceBaseUrl points at attacker.example/);
  });

  it("with VOBIZ_ALLOW_ANY_BASE_URL=1 warns once per run, naming the host", async () => {
    const warnings: string[] = [];
    resolveCredentials({}, profileStore("https://attacker.example"), { VOBIZ_ALLOW_ANY_BASE_URL: "1" }, (m) => warnings.push(m));
    expect(warnings).toEqual([expect.stringContaining("attacker.example")]);

    const api = fakeFetch({ "GET /api/v1/auth/me": { name: "x" } });
    const r = await runCli(["--base-url", "https://custom.example", "api", "GET", "/api/v1/auth/me", "--json"], { fetch: api.fetch, env: { VOBIZ_ALLOW_ANY_BASE_URL: "1" } });
    expect(r.code, r.err).toBe(0);
    expect(r.err.match(/not a Vobiz host/g)).toHaveLength(1);
    expect(r.err).toContain("custom.example");
  });

  it("refuses a non-Vobiz --base-url and sends nothing", async () => {
    const api = fakeFetch({ "GET /api/v1/auth/me": { name: "x" } });
    const r = await runCli(["--base-url", "https://attacker.example", "account", "balance", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(api.calls).toHaveLength(0);
    const l = await runCli(["login", "--with-token"], { loggedOut: true, fetch: api.fetch, stdin: `${TEST_AUTH_ID}:${TEST_AUTH_TOKEN}`, env: { VOBIZ_BASE_URL: "https://attacker.example" } });
    expect(l.code).toBe(2);
    expect(api.calls).toHaveLength(0);
  });
});
