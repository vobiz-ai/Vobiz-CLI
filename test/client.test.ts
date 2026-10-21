import { describe, expect, it } from "vitest";
import { DryRunSignal, VobizClient } from "../src/core/client.js";
import type { ResolvedCredentials } from "../src/core/credentials.js";
import { VobizError } from "../src/core/errors.js";
import { op } from "../src/core/ops.js";
import { SMS_BASE, TEST_AUTH_ID, TEST_AUTH_TOKEN, VOICE_BASE, fakeFetch, hang, networkError, reply, textReply } from "./helpers.js";

const creds: ResolvedCredentials = { authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN, voiceBaseUrl: VOICE_BASE, smsBaseUrl: SMS_BASE, source: "env" };
const client = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof VobizClient>[0]> = {}) => new VobizClient({ creds, fetch: f, ...extra });

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof VobizError ? e.kind : `other: ${String(e)}`;
  }
}

describe("VobizClient", () => {
  it("fills auth_id from credentials and encodes other path params (+ -> %2B)", async () => {
    const api = fakeFetch({ [`POST /api/v1/account/${TEST_AUTH_ID}/numbers/%2B14155550100/cancel-release`]: { ok: true } });
    await client(api.fetch).call(op("cancel-number-release"), { path: { e164: "+14155550100" }, sideEffect: true });
    expect(api.last().url).toBe(`${VOICE_BASE}/api/v1/account/${TEST_AUTH_ID}/numbers/%2B14155550100/cancel-release`);
  });

  it("never takes auth_id from the caller", async () => {
    const api = fakeFetch();
    await client(api.fetch).call(op("get-concurrency"), { path: { auth_id: "MA_SOMEONE_ELSE" } }).catch(() => undefined);
    expect(api.last().path).toBe(`/api/v1/Account/${TEST_AUTH_ID}/concurrency`);
  });

  it("rejects a missing path parameter before sending", async () => {
    const api = fakeFetch();
    expect(await kindOf(client(api.fetch).call(op("cancel-number-release"), {}))).toBe("invalid_input");
    expect(api.calls).toHaveLength(0);
  });

  it("uses the Messaging API base for sms operations", async () => {
    const api = fakeFetch({ "GET /messages": { items: [] } });
    const smsList = op("sms:list-messages");
    await client(api.fetch).call(smsList, { query: { limit: 5 } });
    expect(api.last().url.startsWith(`${SMS_BASE}/messages`)).toBe(true);
    expect(api.last().api).toBe("sms");
  });

  it("sends auth headers, Accept and User-Agent; JSON Content-Type on POST even without a body", async () => {
    const api = fakeFetch({ "GET /api/v1/auth/me": {}, "POST /x": {} });
    const c = client(api.fetch);
    await c.call(op("retrieve-account"));
    let h = api.last().headers;
    expect(h["x-auth-id"]).toBe(TEST_AUTH_ID);
    expect(h["x-auth-token"]).toBe(TEST_AUTH_TOKEN);
    expect(h.accept).toBe("application/json");
    expect(h["user-agent"]).toMatch(/^vobiz-cli\//);
    expect(h["content-type"]).toBeUndefined();
    await c.raw("POST", "/x");
    h = api.last().headers;
    expect(h["content-type"]).toBe("application/json");
    expect(api.last().body).toEqual({});
  });

  it("drops empty query values and repeats arrays", async () => {
    const api = fakeFetch({ "GET /q": {} });
    await client(api.fetch).raw("GET", "/q?x=1", { query: { a: "1", b: undefined, c: "", d: ["x", "y"], e: false } });
    expect(api.last().query).toEqual({ x: "1", a: "1", d: ["x", "y"], e: "false" });
  });

  it("checks required query params", async () => {
    const api = fakeFetch();
    expect(await kindOf(client(api.fetch).call(op("preview-channel-pricing"), { query: { quantity: 1 } }))).toBe("invalid_input");
    expect(api.calls).toHaveLength(0);
  });

  it("dry-run returns the prepared request without sending or exposing the token", async () => {
    const api = fakeFetch();
    const c = client(api.fetch, { dryRun: true });
    try {
      await c.raw("POST", "/api/v1/Account/{auth_id}/Call/", { body: { to: "+911234567890", password: "hunter2" } });
      throw new Error("expected DryRunSignal");
    } catch (e) {
      expect(e).toBeInstanceOf(DryRunSignal);
      const req = (e as DryRunSignal).request;
      expect(req).toMatchObject({ dry_run: true, method: "POST", url: `${VOICE_BASE}/api/v1/Account/${TEST_AUTH_ID}/Call/` });
      expect(req.body).toEqual({ to: "+911234567890", password: "[redacted]" });
      expect(JSON.stringify(req)).not.toContain(TEST_AUTH_TOKEN);
    }
    expect(api.calls).toHaveLength(0);
    // a per-call override lets a command read before a dry-run write
    const api2 = fakeFetch({ "GET /api/v1/auth/me": { name: "x" } });
    await expect(client(api2.fetch, { dryRun: true }).call(op("retrieve-account"), { dryRun: false })).resolves.toEqual({ name: "x" });
  });

  it("times out with kind timeout, or outcome_unknown for side effects", async () => {
    const api = fakeFetch({ "GET /slow": hang(), "POST /slow": hang() });
    const c = client(api.fetch, { timeoutMs: 20 });
    expect(await kindOf(c.raw("GET", "/slow"))).toBe("timeout");
    expect(await kindOf(c.raw("POST", "/slow", { sideEffect: true }))).toBe("outcome_unknown");
  });

  it("maps a transport failure to network_error, or outcome_unknown for side effects", async () => {
    const api = fakeFetch({ "GET /down": networkError(), "POST /down": networkError() });
    const c = client(api.fetch);
    expect(await kindOf(c.raw("GET", "/down"))).toBe("network_error");
    expect(await kindOf(c.raw("POST", "/down", { sideEffect: true }))).toBe("outcome_unknown");
  });

  it("maps HTTP errors and keeps the backend message and status", async () => {
    const api = fakeFetch({ "GET /e": reply(422, { error: "to is invalid", auth_token: "leak" }) });
    try {
      await client(api.fetch).raw("GET", "/e");
    } catch (e) {
      const err = e as VobizError;
      expect(err.kind).toBe("invalid_input");
      expect(err.status).toBe(422);
      expect(err.message).toBe("to is invalid");
      expect(JSON.stringify(err.details)).not.toContain("leak");
    }
  });

  it("rejects non-JSON success, redirects, and full URLs", async () => {
    const api = fakeFetch({ "GET /html": textReply(200, "<html>"), "GET /r": reply(302, undefined, { location: "https://evil.example" }) });
    const c = client(api.fetch);
    expect(await kindOf(c.raw("GET", "/html"))).toBe("unexpected_response");
    expect(await kindOf(c.raw("GET", "/r"))).toBe("unexpected_response");
    expect(await kindOf(c.raw("GET", "https://evil.example/x"))).toBe("invalid_input");
    expect(await kindOf(c.raw("GET", "//evil.example/x"))).toBe("invalid_input");
    await expect(c.raw("GET", "/html", { responseType: "text" })).resolves.toBe("<html>");
  });

  it("returns bytes and the filename for downloads; undefined for empty bodies", async () => {
    const api = fakeFetch({
      "GET /f": textReply(200, "RIFF", { "content-type": "audio/wav", "content-disposition": 'attachment; filename="rec.wav"' }),
      "DELETE /d": reply(204),
    });
    const c = client(api.fetch);
    const r = await c.raw<{ bytes: Uint8Array; filename?: string; contentType?: string }>("GET", "/f", { responseType: "bytes" });
    expect(new TextDecoder().decode(r.bytes)).toBe("RIFF");
    expect(r).toMatchObject({ filename: "rec.wav", contentType: "audio/wav" });
    await expect(c.raw("DELETE", "/d")).resolves.toBeUndefined();
  });

  it("reports missing credentials before any I/O", async () => {
    const api = fakeFetch();
    const c = new VobizClient({
      creds: () => {
        throw new VobizError("missing_credentials", "none");
      },
      fetch: api.fetch,
    });
    expect(await kindOf(c.raw("GET", "/x"))).toBe("missing_credentials");
    expect(api.calls).toHaveLength(0);
  });

  it("logs the route template, never the token", async () => {
    const logs: string[] = [];
    const api = fakeFetch({ [`GET /api/v1/Account/${TEST_AUTH_ID}/concurrency`]: { ok: 1 } });
    await client(api.fetch, { log: (_l, m) => logs.push(m) }).call(op("get-concurrency"));
    expect(logs.join("\n")).toContain("GET /api/v1/Account/{auth_id}/concurrency -> 200");
    expect(logs.join("\n")).not.toContain(TEST_AUTH_TOKEN);
  });
});

describe("DELETE bodies and extra redaction keys", () => {
  it("sends a JSON body on DELETE only when one is given", async () => {
    const api = fakeFetch({ "DELETE /10dlc/campaigns/c1/numbers": { ok: true }, "DELETE /opt-outs/%2B15550100": { ok: true } });
    const c = client(api.fetch);
    await c.call(op("remove-campaign-numbers"), { path: { id: "c1" }, body: { phoneNumbers: ["+15550100"] } });
    expect(api.last().method).toBe("DELETE");
    expect(api.last().headers["content-type"]).toBe("application/json");
    expect(api.last().body).toEqual({ phoneNumbers: ["+15550100"] });
    await c.call(op("delete-opt-out"), { path: { phoneNumber: "+15550100" } });
    expect(api.last().headers["content-type"]).toBeUndefined();
    expect(api.last().body).toBeUndefined();
  });
  it("redacts access, refresh and api keys", async () => {
    const { redact } = await import("../src/core/redact.js");
    expect(redact({ tokens: { access_token: "a", refresh_token: "b" }, api_key: "k", ok: 1 })).toEqual({
      tokens: { access_token: "[redacted]", refresh_token: "[redacted]" }, api_key: "[redacted]", ok: 1,
    });
  });
});
