import { describe, expect, it } from "vitest";
import { forgetSecrets, isSecretKey, redact, redactForLog, redactUrl, rememberSecret, scrubSecrets } from "../src/core/redact.js";

describe("isSecretKey (normalised suffix and segment)", () => {
  it.each([
    "sip_password", "sipPassword", "webhook_secret", "signing_secret", "secret_key", "passwd", "credentials", "auth-token",
    "authorization", "Authorization", "pin", "sip_pin", "voicemailPin", "otp", "campaignVerifyToken", "x-auth-token", "AuthToken",
    "auth_token", "auth_secret", "access_token", "refresh_token", "api_key", "apiKey", "private_key", "client_secret", "token", "Secret",
  ])("%s is secret", (k) => expect(isSecretKey(k)).toBe(true));

  it.each([
    "idempotency_key", "IdempotencyKey", "idempotencyKey", "numberKey", "numberKeys", "dlt_template_id", "credential_uuid", "credential_id",
    "token_type", "access_token_expire_time", "auth_id", "auth_url", "tokens", "mapping", "spin", "public_key", "next_page_token", "pageToken",
    "username", "expires_in",
  ])("%s is not secret", (k) => expect(isSecretKey(k)).toBe(false));
});

describe("redact", () => {
  it("hides every variant, inside nested arrays too", () => {
    const body = {
      items: [[{ sip_password: "p1", sipPassword: "p2", webhook_secret: "w1", authorization: "Bearer b1", pin: 1234, campaignVerifyToken: "cvt" }]],
      credentials: "c1",
      keep: "x",
    };
    const text = JSON.stringify(redact(body));
    for (const v of ['"p1"', '"p2"', '"w1"', "Bearer b1", "1234", '"cvt"', '"c1"']) expect(text).not.toContain(v);
    expect(text).toContain('"keep":"x"');
  });

  it("walks credential containers so the public auth_id stays visible", () => {
    expect(redact({ auth_credentials: { auth_id: "SA_XXXXXXXX", auth_token: "t" }, credentials: [{ username: "u", password: "p" }] })).toEqual({
      auth_credentials: { auth_id: "SA_XXXXXXXX", auth_token: "[redacted]" },
      credentials: [{ username: "u", password: "[redacted]" }],
    });
  });

  it("keeps booleans and non-secret look-alikes", () => {
    expect(redact({ has_password: true, idempotency_key: "k", dlt_template_id: "d", token_type: "bearer" })).toEqual({
      has_password: true, idempotency_key: "k", dlt_template_id: "d", token_type: "bearer",
    });
  });
});

describe("redactUrl and redactForLog", () => {
  it("hides secret-named query values only", () => {
    expect(redactUrl("https://kyc.vobiz.ai/verify?token=kst_abc&lang=en")).toBe("https://kyc.vobiz.ai/verify?token=[redacted]&lang=en");
    expect(redactUrl("https://x/y?a=1")).toBe("https://x/y?a=1");
    expect(redactUrl("not a url ?token=1")).toBe("not a url ?token=1");
  });
  it("redacts URL strings inside logged bodies", () => {
    const out = JSON.stringify(redactForLog({ widget_url: "https://kyc.vobiz.ai/verify?token=kst_SESSION", auth_token: "t" }));
    expect(out).not.toContain("kst_SESSION");
    expect(out).not.toContain('"t"');
  });
});

describe("scrubSecrets", () => {
  it("replaces remembered values (and their URL-encoded form) in free text", () => {
    forgetSecrets();
    rememberSecret("s3cr3t/val+ue");
    rememberSecret("ab"); // too short to scrub safely
    expect(scrubSecrets("bad token s3cr3t/val+ue and s3cr3t%2Fval%2Bue; ab")).toBe("bad token [redacted] and [redacted]; ab");
    forgetSecrets();
    expect(scrubSecrets("s3cr3t/val+ue")).toBe("s3cr3t/val+ue");
  });
});
