import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connect } from "node:net";
import { NonceCache, baseUrlOf, signV2, signV3, verifyRequest } from "../src/agent/webhooks.js";
import { startWebhookListener } from "../src/commands/webhooks.js";
import { fakeFetch, hang, makeCtx, reply, runCli, textReply } from "./helpers.js";

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

  it("--secret takes @file and @- like every other secret flag, never the literal \"@-\"", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-secret-"));
    writeFileSync(join(dir, "secret"), `${SECRET}\n`);
    const base = ["webhooks", "verify", "--url", URL_, "--nonce", NONCE, "--signature", V3, "--json"];
    const fromFile = await runCli([...base, "--secret", `@${join(dir, "secret")}`]);
    expect(fromFile.code, fromFile.err).toBe(0);
    expect(fromFile.err).not.toContain("shell history");
    const fromStdin = await runCli([...base, "--secret", "@-"], { stdin: SECRET });
    expect(fromStdin.code, fromStdin.err).toBe(0);
    expect(fromStdin.json()).toMatchObject({ valid: true });
    const both = await runCli(["webhooks", "verify", "--signature", BODY_SIG, "--body", "@-", "--secret", "@-", "--json"], { stdin: BODY });
    expect(both.code).toBe(2);
    expect(both.err).toContain("both read stdin");
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
      // no --secret: the payload is marked as unchecked, third-party data (S6 hand-off #4)
      const event = JSON.parse(t.stdout.text);
      expect(event.signature).toBe("not_checked");
      expect(event._untrusted_fields).toEqual(expect.arrayContaining(["query", "headers", "body"]));
    } finally {
      await server.close();
    }
  });

  it("rejects a bad --forward URL", async () => {
    const r = await runCli(["webhooks", "listen", "--forward", "ftp://x"]);
    expect(r.code).toBe(2);
  });
});

describe("webhooks listen hardening", () => {
  const PUBLIC = "https://abc.trycloudflare.com";
  const signed = (path: string, nonce: string) => ({ "x-vobiz-signature-v3": signV3(SECRET, `${PUBLIC}${path}`, nonce), "x-vobiz-signature-v3-nonce": nonce });
  /** Sends a raw HTTP/1.1 request (for request-targets fetch cannot produce) and returns the status code. */
  const rawStatus = (port: number, line: string) =>
    new Promise<number>((resolve) => {
      const s = connect(port, "127.0.0.1");
      let buf = "";
      s.on("data", (c) => (buf += c.toString("latin1")));
      s.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0)));
      s.on("error", () => resolve(0));
      s.end(`${line}\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });

  it("forwards only verified, fresh requests, with an allow-list of headers", async () => {
    const app = fakeFetch({ "POST /hooks": () => textReply(200, "<Response/>", { "content-type": "application/xml" }) });
    const t = makeCtx({ fetch: app.fetch });
    const server = await startWebhookListener(t.ctx, { port: 0, host: "127.0.0.1", forward: "http://localhost:8080/hooks", secret: SECRET, publicUrl: PUBLIC });
    const post = (headers: Record<string, string>) =>
      fetch(`${server.url}/vobiz/answer?x=1`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: "CallUUID=abc" });
    try {
      // unsigned and forged requests are refused and never reach the app
      expect((await post({ cookie: "sid=1" })).status).toBe(401);
      expect((await post(signed("/other/path", "11111111111111111111"))).status).toBe(401);
      expect(app.calls).toHaveLength(0);
      // a valid one is forwarded without Cookie/Authorization/X-Forwarded-For, keeping the Host as X-Forwarded-Host
      const ok = await post({ ...signed("/vobiz/answer", "22222222222222222222"), cookie: "sid=1", authorization: "Bearer x", "x-forwarded-for": "10.0.0.1" });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("<Response/>");
      const h = app.last().headers;
      expect(h.cookie).toBeUndefined();
      expect(h.authorization).toBeUndefined();
      expect(h["x-forwarded-for"]).toBeUndefined();
      expect(h["x-forwarded-host"]).toBe(`127.0.0.1:${server.port}`);
      expect(h["x-forwarded-proto"]).toBe("https");
      expect(h["x-vobiz-signature-v3-nonce"]).toBe("22222222222222222222");
      // the same nonce again is a replay
      const replay = await post(signed("/vobiz/answer", "22222222222222222222"));
      expect(replay.status).toBe(401);
      expect(app.calls).toHaveLength(1);
      expect(t.stdout.text).toContain("nonce already used");
      // only GET/POST, only origin-form targets, only the tunnel or loopback Host
      expect((await fetch(`${server.url}/vobiz/answer`, { method: "DELETE" })).status).toBe(405);
      expect(await rawStatus(server.port, "POST https://other-app.example.com/answer HTTP/1.1")).toBe(400);
      expect(await rawStatus(server.port, "POST //other-app.example.com/answer HTTP/1.1")).toBe(400);
      const misdirected = await new Promise<number>((resolve) => {
        const s = connect(server.port, "127.0.0.1");
        let buf = "";
        s.on("data", (c) => (buf += c.toString("latin1")));
        s.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0)));
        s.end("POST /vobiz/answer HTTP/1.1\r\nHost: rebind.evil.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      });
      expect(misdirected).toBe(421);
      expect(app.calls).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("keeps the app's error pages local and times out a hung app", async () => {
    let hung = false;
    const app = fakeFetch({ "POST /hooks": () => (hung ? hang() : textReply(500, "<pre>Error: DB password=hunter2 \u001b]0;x\u0007</pre>")) });
    const t = makeCtx({ fetch: app.fetch });
    const server = await startWebhookListener(t.ctx, { port: 0, host: "127.0.0.1", forward: "http://localhost:8080/hooks", forwardTimeoutMs: 100 });
    try {
      const res = await fetch(`${server.url}/x`, { method: "POST", body: "a=1" });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("upstream answered 500\n");
      expect(t.stderr.text).toContain("hunter2");
      expect(t.stderr.text).not.toContain("\u001b");
      hung = true;
      const slow = await fetch(`${server.url}/x`, { method: "POST", body: "a=1" });
      expect(slow.status).toBe(504);
    } finally {
      await server.close();
    }
  });

  it("refuses V2 when V3 headers are present, malformed nonces, and V2 under --scheme v3", () => {
    const body = Buffer.alloc(0);
    const v2 = { "x-vobiz-signature-v2": V2, "x-vobiz-signature-v2-nonce": NONCE };
    expect(verifyRequest(v2, URL_, body, SECRET)).toMatchObject({ valid: true, version: "v2" });
    expect(verifyRequest({ ...v2, "x-vobiz-signature-v3": "garbage" }, URL_, body, SECRET)).toMatchObject({ valid: false, version: "v3" });
    expect(verifyRequest(v2, URL_, body, SECRET, { scheme: "v3" })).toMatchObject({ valid: false, reason: expect.stringContaining("--scheme v3") });
    // the V2 boundary shift: a signature for /hook1 + nonce "234…" must not verify /hook12 + "34…"
    const shifted = { "x-vobiz-signature-v2": signV2(SECRET, "https://example.com/hook1", "2345678901234567890"), "x-vobiz-signature-v2-nonce": "345678901234567890" };
    expect(verifyRequest(shifted, "https://example.com/hook12", body, SECRET)).toMatchObject({ valid: false, reason: expect.stringContaining("20 digits") });
    expect(verifyRequest({ "x-vobiz-signature-v3": V3, "x-vobiz-signature-v3-nonce": NONCE }, undefined, body, SECRET)).toMatchObject({ valid: false, reason: expect.stringContaining("--public-url") });
  });

  it("bounds the nonce cache and expires entries", () => {
    let now = 0;
    const c = new NonceCache(3, 1000, () => now);
    for (const k of ["a", "b", "c", "d"]) expect(c.seenBefore(k)).toBe(false);
    expect(c.size).toBe(3);
    expect(c.seenBefore("d")).toBe(true);
    expect(c.seenBefore("a")).toBe(false); // evicted
    now = 5000;
    expect(c.seenBefore("d")).toBe(false); // expired
  });

  it("needs --allow-lan for a non-loopback --host and --allow-insecure-url for a remote http:// --forward", async () => {
    let r = await runCli(["webhooks", "listen", "--host", "0.0.0.0", "--port", "0"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--allow-lan");
    r = await runCli(["webhooks", "listen", "--forward", "http://app.internal:8080/x", "--port", "0"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--allow-insecure-url");
  });
});
