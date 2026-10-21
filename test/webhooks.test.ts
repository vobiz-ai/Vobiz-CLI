import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baseUrlOf, verifyRequest } from "../src/agent/webhooks.js";
import { startWebhookListener } from "../src/commands/webhooks.js";
import { fakeFetch, makeCtx, reply, runCli } from "./helpers.js";

// Vectors computed independently with Python's hmac module, following concepts/validating-callbacks.
const SECRET = "YOUR_AUTH_TOKEN";
const URL_ = "https://example.com/vobiz/answer";
const NONCE = "12345678901234567890";
const V3 = "dE8juavuheuGSCtN5ts7pgQSwAFhQg7vLhddMFsuAjQ=";
const V2 = "sf8Zt9J6hCsjjUpqTkRAdWeD6dRmdU/zuEIZa9/R6UU=";
const BODY = '{"event":"message.delivered","timestamp":"2026-10-12T10:31:04.512Z","data":{}}';
const BODY_SECRET = "whsec_test";
const BODY_SIG = "8f823d412e8005d7f665d3340233771529f644b70b020892926c994092857c11";

const env = { VOBIZ_WEBHOOK_SECRET: SECRET };

describe("webhooks verify", () => {
  it("accepts a V3 signature and ignores the query string", async () => {
    const r = await runCli(["webhooks", "verify", "--url", `${URL_}?CallUUID=abc`, "--nonce", NONCE, "--signature", V3, "--json"], { env });
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ valid: true, scheme: "callback-url", version: "v3", base_url: URL_ });
  });

  it("falls back to V2, and --scheme pins the version", async () => {
    expect((await runCli(["webhooks", "verify", "--url", URL_, "--nonce", NONCE, "--signature", V2, "--json"], { env })).json()).toMatchObject({ valid: true, version: "v2" });
    const pinned = await runCli(["webhooks", "verify", "--url", URL_, "--nonce", NONCE, "--signature", V2, "--scheme", "v3", "--json"], { env });
    expect(pinned.code).toBe(1);
    expect(pinned.json()).toMatchObject({ valid: false, version: "v3" });
  });

  it("rejects a wrong secret, nonce or URL with exit 1", async () => {
    for (const [url, nonce, secret] of [
      [URL_, NONCE, "OTHER_TOKEN"],
      [URL_, "00000000000000000000", SECRET],
      ["https://example.com/vobiz/hangup", NONCE, SECRET],
    ]) {
      const r = await runCli(["webhooks", "verify", "--url", url, "--nonce", nonce, "--signature", V3, "-o", "table"], { env: { VOBIZ_WEBHOOK_SECRET: secret } });
      expect(r.code).toBe(1);
      expect(r.err).toContain("NOT valid");
    }
  });

  it("checks body HMACs from text, @file and @-, with or without sha256=", async () => {
    const e = { VOBIZ_WEBHOOK_SECRET: BODY_SECRET };
    expect((await runCli(["webhooks", "verify", "--body", BODY, "--signature", BODY_SIG, "--json"], { env: e })).json()).toEqual({ valid: true, scheme: "body-hmac" });
    const dir = mkdtempSync(join(tmpdir(), "vobiz-wh-"));
    writeFileSync(join(dir, "body.json"), BODY);
    expect((await runCli(["webhooks", "verify", "--body", `@${join(dir, "body.json")}`, "--signature", `sha256=${BODY_SIG.toUpperCase()}`], { env: e })).code).toBe(0);
    expect((await runCli(["webhooks", "verify", "--body", "@-", "--signature", BODY_SIG], { env: e, stdin: BODY })).code).toBe(0);
    expect((await runCli(["webhooks", "verify", "--body", BODY + " ", "--signature", BODY_SIG], { env: e })).code).toBe(1);
  });

  it("takes --secret but warns about shell history; works logged out", async () => {
    const r = await runCli(["webhooks", "verify", "--url", URL_, "--nonce", NONCE, "--signature", V3, "--secret", SECRET], { loggedOut: true });
    expect(r.code).toBe(0);
    expect(r.err).toContain("shell history");
  });

  it.each([
    [["--signature", V3, "--url", URL_, "--nonce", NONCE], "VOBIZ_WEBHOOK_SECRET", {}],
    [["--signature", V3], "--url and --nonce", env],
    [["--signature", V3, "--url", URL_], "both --url and --nonce", env],
    [["--signature", V3, "--url", URL_, "--nonce", NONCE, "--body", "x"], "not both", env],
    [["--signature", V3, "--body", "x"], "64 hex", env],
    [["--signature", V3, "--url", "not a url", "--nonce", NONCE], "not a valid URL", env],
    [["--signature", V3, "--url", URL_, "--nonce", NONCE, "--scheme", "v1"], "v3 or v2", env],
  ])("usage error for %j", async (args, message, e) => {
    const r = await runCli(["webhooks", "verify", ...args], { env: e });
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
  });
});

describe("verifyRequest", () => {
  it("prefers V3, accepts -MA- variants and body signatures", () => {
    expect(baseUrlOf("https://example.com/a/b?x=1#f")).toBe("https://example.com/a/b");
    const body = Buffer.from(BODY);
    expect(verifyRequest({ "x-vobiz-signature-v3": V3, "x-vobiz-signature-v3-nonce": NONCE }, URL_, body, SECRET)).toMatchObject({ valid: true, version: "v3" });
    expect(verifyRequest({ "x-vobiz-signature-ma-v2": V2, "x-vobiz-signature-v2": "bad", "x-vobiz-signature-v2-nonce": NONCE }, URL_, body, SECRET)).toMatchObject({
      valid: true,
      header: "x-vobiz-signature-ma-v2",
    });
    expect(verifyRequest({ "x-webhook-signature": BODY_SIG }, URL_, body, BODY_SECRET)).toMatchObject({ valid: true, scheme: "body-hmac" });
    expect(verifyRequest({ "x-vobiz-signature": `sha256=${BODY_SIG}` }, URL_, body, BODY_SECRET)).toMatchObject({ valid: true });
    // A legacy V1 (base64 HMAC-SHA1) X-Vobiz-Signature alone is not checked.
    expect(verifyRequest({ "x-vobiz-signature": "abc=" }, URL_, body, SECRET)).toMatchObject({ valid: false, scheme: "none" });
  });
});

describe("webhooks listen", () => {
  it("prints each request as JSON with its signature result", async () => {
    const t = makeCtx({ now: () => new Date("2026-10-22T10:00:00Z") });
    const server = await startWebhookListener(t.ctx, { port: 0, host: "127.0.0.1", secret: SECRET, publicUrl: "https://example.com" });
    try {
      const res = await fetch(`${server.url}/vobiz/answer?x=1`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-vobiz-signature-v3": V3, "x-vobiz-signature-v3-nonce": NONCE, cookie: "secret" },
        body: "CallUUID=abc&CallStatus=completed",
      });
      expect(res.status).toBe(200);
      const event = JSON.parse(t.stdout.text);
      expect(event).toMatchObject({
        received_at: "2026-10-22T10:00:00.000Z",
        method: "POST",
        path: "/vobiz/answer",
        query: { x: "1" },
        body: { CallUUID: "abc", CallStatus: "completed" },
        signature: { valid: true, version: "v3", base_url: URL_ },
      });
      expect(event.headers["x-vobiz-signature-v3-nonce"]).toBe(NONCE);
      expect(event.headers.cookie).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("--forward relays the request and the app's response", async () => {
    const app = fakeFetch({ "POST /hooks": (req) => reply(201, { q: req.query }) });
    const t = makeCtx({ fetch: app.fetch });
    const server = await startWebhookListener(t.ctx, { port: 0, host: "127.0.0.1", forward: "http://localhost:8080/hooks" });
    try {
      const res = await fetch(`${server.url}/anything?a=1`, { method: "POST", headers: { "content-type": "application/json" }, body: BODY });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ q: { a: "1" } });
      expect(Buffer.from(app.last().body as Uint8Array).toString("utf8")).toBe(BODY);
      expect(app.last()).toMatchObject({ method: "POST", url: "http://localhost:8080/hooks?a=1" });
      expect(app.last().headers.host).toBeUndefined();
      expect(JSON.parse(t.stdout.text).forwarded).toEqual({ url: "http://localhost:8080/hooks?a=1", status: 201 });
    } finally {
      await server.close();
    }
  });

  it("rejects a bad --forward URL", async () => {
    const r = await runCli(["webhooks", "listen", "--forward", "ftp://x"]);
    expect(r.code).toBe(2);
  });
});
