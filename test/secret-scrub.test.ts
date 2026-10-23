/** Secret VALUES never reach error text, dry-run URLs or debug logs. */
import { afterEach, describe, expect, it } from "vitest";
import { forgetSecrets } from "../src/core/redact.js";
import { fakeFetch, reply, runCli, textReply } from "./helpers.js";

const TOKEN = "tok_LIVE_LOOKING_TOKEN_9f8e7d";
const PW = "Pw-SENTINEL-4242";
const env = { VOBIZ_AUTH_TOKEN: TOKEN };

afterEach(() => forgetSecrets());

describe("backend error text is scrubbed", () => {
  it("never echoes the token from an HTML proxy page, and caps it to the status", async () => {
    const html = `<html><body><h1>502</h1><pre>X-Auth-Token: ${TOKEN}</pre>${"x".repeat(5000)}</body></html>`;
    const api = fakeFetch({ "GET /api/v1/auth/me": textReply(500, html, { "content-type": "text/html" }) });
    for (const extra of [[], ["--json"], ["--verbose"], ["--debug"]]) {
      const r = await runCli(["api", "GET", "/api/v1/auth/me", ...extra], { fetch: api.fetch, env });
      expect(r.code).not.toBe(0);
      expect(r.out + r.err, extra.join(" ")).not.toContain(TOKEN);
      expect(r.err).not.toContain("<html>");
      expect(r.err).toContain("HTTP 500");
    }
  });

  it("scrubs the token and a --password value echoed in JSON messages", async () => {
    const api = fakeFetch({
      "GET /api/v1/auth/me": reply(400, { message: `bad token ${TOKEN}` }),
      [`POST /api/v1/Account/MA_XXXXXXXX/credentials`]: reply(400, { errors: [{ field: "password", message: `'${PW}' is too short` }] }),
    });
    const a = await runCli(["api", "GET", "/api/v1/auth/me"], { fetch: api.fetch, env });
    expect(a.err).toContain("bad token [redacted]");
    expect(a.err).not.toContain(TOKEN);
    const b = await runCli(["trunks", "credentials", "create", "--username", "u1", "--password", PW, "--yes", "--json"], { fetch: api.fetch, env });
    expect(b.code).toBe(2);
    expect(b.out + b.err).not.toContain(PW);
    expect(b.err).toContain("[redacted]");
  });

  it("scrubs a secret given in a raw --body", async () => {
    const api = fakeFetch({ "POST /api/v1/x": reply(422, { detail: `secret ${PW} rejected` }) });
    const r = await runCli(["api", "POST", "/api/v1/x", "--body", JSON.stringify({ webhook_secret: PW }), "--yes"], { fetch: api.fetch, env });
    expect(r.err).toContain("secret [redacted] rejected");
  });
});

describe("dry-run and debug URLs", () => {
  it("hides secret-named query parameters in the --dry-run URL", async () => {
    for (const argv of [["api", "GET", `/api/v1/x?password=${PW}&limit=5`], ["api", "GET", "/api/v1/x", "--param", `auth_token=${PW}`]]) {
      const r = await runCli([...argv, "--dry-run", "--json"], { env });
      expect(r.code, r.err).toBe(0);
      expect(r.out).not.toContain(PW);
      expect(r.json().url).toContain("[redacted]");
    }
    const keep = await runCli(["api", "GET", "/api/v1/x?limit=5", "--dry-run", "--json"], { env });
    expect(keep.json().url).toBe("https://api.vobiz.ai/api/v1/x?limit=5");
  });

  it("keeps the KYC widget_url in the result but hides its session token in --debug logs", async () => {
    const widget = "https://kyc.vobiz.ai/verify?token=kst_SESSION_SENTINEL";
    const api = fakeFetch({ "POST /api/v1/sub-accounts/SA_XXXXXXXX/kyc-sessions": reply(201, { session_id: "s1", widget_url: widget }) });
    const r = await runCli(
      ["sub-accounts", "kyc", "session", "create", "SA_XXXXXXXX", "--flow-type", "redirect", "--redirect-url", "https://example.com/done", "--yes", "--json", "--debug"],
      { fetch: api.fetch, env },
    );
    expect(r.code, r.err).toBe(0);
    expect(r.json().widget_url).toBe(widget);
    expect(r.err).toContain("[debug]");
    expect(r.err).not.toContain("kst_SESSION_SENTINEL");
  });
});

describe("campaignVerifyToken", () => {
  it("is redacted in the --dry-run body and the --debug request log", async () => {
    const argv = ["sms", "10dlc", "campaigns", "create-toll-free", "--name", "Acme TF", "--number", "+18885550100", "--use-case", "NOTIFICATIONS", "--reference-id", "tf-1", "--campaign-verify-token", "CVT_SENTINEL_1", "--yes", "--json"];
    const dry = await runCli([...argv, "--dry-run"], { env });
    expect(dry.code, dry.err).toBe(0);
    expect(dry.json().body.campaignVerifyToken).toBe("[redacted]");
    const api = fakeFetch({ "POST /10dlc/campaigns/toll-free": reply(201, { id: "b1" }) });
    const dbg = await runCli([...argv, "--debug"], { fetch: api.fetch, env });
    expect(dbg.code, dbg.err).toBe(0);
    expect(api.last().body).toMatchObject({ campaignVerifyToken: "CVT_SENTINEL_1" });
    expect(dbg.out + dbg.err).not.toContain("CVT_SENTINEL_1");
  });
});
