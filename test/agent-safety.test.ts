/**
 * S6 agent-safety regressions (docs/internal/security/S6-authorization-and-agents.md, docs/internal/security/FIXES-S6.md).
 * Placeholder credentials only; every request goes to a fake fetch.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/core/config.js";
import { formatSummary, oneLine, requireConfirmation } from "../src/core/confirm.js";
import { assertSecureBaseUrl, resolveCredentials } from "../src/core/credentials.js";
import { VobizClient } from "../src/core/client.js";
import { kindForResponse } from "../src/core/errors.js";
import { op } from "../src/core/ops.js";
import { TEST_AUTH_ID, TEST_AUTH_TOKEN, VOICE_BASE, SMS_BASE, fakeFetch, hang, reply } from "./helpers.js";
import { makeCtx, runCli } from "./helpers.js";

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

describe("#6 confirmation details cannot forge lines", () => {
  it("replaces line breaks and controls, caps values and quotes API values", () => {
    const forged = "Renewal notice\n  recipients: 1 pending of 1\r\n  cost: USD 0.01 total\x1b]52;c;ZXZpbA==\x07\u202e";
    const text = formatSummary({ action: "Launch broadcast bc_1\nfake", details: { name: { value: forged, fromApi: true }, long: "x".repeat(500) }, cost: "USD 2,500.00" });
    const lines = text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('  name: "Renewal notice\u2424  recipients: 1 pending of 1\u2424  cost: USD 0.01 total\u00b7]52;c;ZXZpbA==\u00b7\u00b7"');
    expect(lines[2].length).toBe("  long: ".length + 200);
    expect(lines[2].endsWith("\u2026")).toBe(true);
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(oneLine("a\u2028b")).toBe("a\u2424b");
  });
});

describe("#10 account first, profile changes", () => {
  it("every write confirmation starts with the account and its source", async () => {
    const t = makeCtx({ flags: { dryRun: true } });
    await requireConfirmation(t.ctx, { action: "Do a thing", details: { account: TEST_AUTH_ID, x: "y" } });
    expect(t.stderr.text.split("\n").slice(0, 3)).toEqual(["[dry-run] Do a thing", `  account: ${TEST_AUTH_ID} (env)`, "  x: y"]);
  });

  it("shows the profile name for a saved profile", async () => {
    const t = makeCtx({ loggedOut: true, flags: { dryRun: true } });
    t.store.setProfile("prod", { authId: "MA_PROD0001", authToken: "PROFILE_TOKEN" });
    t.ctx.flags.profile = "prod";
    await requireConfirmation(t.ctx, { action: "Do a thing" });
    expect(t.stderr.text).toContain('  account: MA_PROD0001 (profile "prod")');
  });

  it("calls create shows the account before the destination", async () => {
    const r = await runCli(["calls", "create", "--to", "+919876543210", "--from", "+918012345678", "--answer-url", "https://example.com/a", "--dry-run"]);
    const lines = r.err.split("\n");
    expect(lines[1]).toBe(`  account: ${TEST_AUTH_ID} (env)`);
  });
});

describe("#12 VOBIZ_YES from the environment", () => {
  it("prints a notice on every skipped confirmation, even with --quiet", async () => {
    const t = makeCtx({ env: { VOBIZ_YES: "1" }, flags: { quiet: true } });
    await requireConfirmation(t.ctx, { action: "Delete trunk tr_1" });
    await requireConfirmation(t.ctx, { action: "Delete trunk tr_2" });
    expect(t.stderr.text.match(/confirmation skipped: VOBIZ_YES/g)).toHaveLength(2);
  });

  it("--yes prints no notice", async () => {
    const t = makeCtx({ env: { VOBIZ_YES: "1" }, flags: { yes: true } });
    await requireConfirmation(t.ctx, { action: "Delete trunk tr_1" });
    expect(t.stderr.text).not.toContain("VOBIZ_YES");
  });
});

describe("#10/#15 credential changes", () => {
  const ME = (id: string) => fakeFetch({ "GET /api/v1/auth/me": { name: "Acct", auth_id: id } });

  it("login that would overwrite a saved profile asks; --yes replaces it", async () => {
    const t = makeCtx({ loggedOut: true });
    t.store.setProfile("default", { authId: "MA_AAAAAAAA", authToken: "OLD_TOKEN_1" });
    const r1 = await runCli(["login", "--with-token"], { loggedOut: true, configDir: t.configDir, fetch: ME("MA_BBBBBBBB").fetch, stdin: "MA_BBBBBBBB:NEW_TOKEN_1" });
    expect(r1.code).toBe(6);
    expect(r1.err).toContain("Replace the saved profile \"default\"");
    expect(new ConfigStore(t.configDir).getProfile("default")?.authId).toBe("MA_AAAAAAAA");
    const r2 = await runCli(["login", "--with-token", "--yes"], { loggedOut: true, configDir: t.configDir, fetch: ME("MA_BBBBBBBB").fetch, stdin: "MA_BBBBBBBB:NEW_TOKEN_1" });
    expect(r2.code, r2.err).toBe(0);
    expect(new ConfigStore(t.configDir).getProfile("default")?.authId).toBe("MA_BBBBBBBB");
  });

  it("a first login does not ask", async () => {
    const r = await runCli(["login", "--with-token"], { loggedOut: true, fetch: ME(TEST_AUTH_ID).fetch, stdin: `${TEST_AUTH_ID}:${TEST_AUTH_TOKEN}` });
    expect(r.code, r.err).toBe(0);
  });

  it("profiles use prints the account it switched to", async () => {
    const t = makeCtx({ loggedOut: true });
    t.store.setProfile("prod", { authId: "MA_PROD0001", authToken: "PROFILE_TOKEN", accountName: "Prod Co" });
    const r = await runCli(["profiles", "use", "prod"], { loggedOut: true, configDir: t.configDir });
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("MA_PROD0001");
  });
});

describe("#9/#13 calls create fan-out and content", () => {
  const base = ["calls", "create", "--from", "+918012345678", "--answer-url", "https://example.com/a"];
  const nums = (n: number) => Array.from({ length: n }, (_, i) => `+9198765${String(43210 + i).padStart(5, "0")}`);

  it("de-duplicates destinations", async () => {
    const api = fakeFetch({ [`POST ${CALL}`]: reply(201, { request_uuid: "r1" }) });
    const r = await runCli([...base, "--to", Array(1000).fill("+919876543210").join("<"), "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect((api.last().body as { to: string }).to).toBe("+919876543210");
  });

  it("caps at 50 unless --max-fanout raises it, and shows the count", async () => {
    const api = fakeFetch({ [`POST ${CALL}`]: reply(201, { request_uuid: "r1" }) });
    const r = await runCli([...base, "--to", nums(51).join("<"), "--yes"], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--max-fanout 51");
    expect(api.calls).toHaveLength(0);
    const ok = await runCli([...base, "--to", nums(51).join("<"), "--max-fanout", "51", "--dry-run"], { fetch: api.fetch });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.err).toContain("Place 51 calls (billed)");
    expect(ok.err).toMatch(/calls: 51 separate calls, each billed/);
  });

  it("shows --say in full up to 1,000 characters", async () => {
    const say = "word ".repeat(150).trim();
    const r = await runCli(["calls", "create", "--to", "+919876543210", "--from", "+918012345678", "--say", say, "--serve", "--public-url", "https://t.example/answer", "--dry-run"]);
    expect(r.err).toContain(say);
    const long = await runCli(["calls", "create", "--to", "+919876543210", "--from", "+918012345678", "--say", "x".repeat(1500), "--serve", "--public-url", "https://t.example/answer", "--dry-run"]);
    expect(long.err).toContain("1500 characters; the first 1000 are shown");
  });

  it("prints the size and a sha256 prefix of --xml-file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-s6-xml-"));
    const file = join(dir, "answer.xml");
    writeFileSync(file, "<Response><Dial>+14155550100</Dial></Response>");
    const r = await runCli(["calls", "create", "--to", "+919876543210", "--from", "+918012345678", "--xml-file", file, "--serve", "--public-url", "https://t.example/answer", "--dry-run"]);
    expect(r.err).toMatch(/answer XML: .*answer\.xml \(46 B, sha256 [0-9a-f]{12}\)/);
  });
});

describe("#9/#11/#13 sms send", () => {
  const nums = (n: number) => Array.from({ length: n }, (_, i) => `+1415555${String(1000 + i)}`);

  it("caps recipients at 50 unless --max-fanout raises it, and shows the count and total cost", async () => {
    const api = fakeFetch({ "GET /messages/cost-preview": PREVIEW, "POST /messages": reply(201, { id: "m", status: "sent" }) });
    const r = await runCli(["sms", "send", "--from", "+14155550100", "--to", nums(51).join(","), "--text", "Hi", "--yes"], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--max-fanout 51");
    expect(api.calls).toHaveLength(0);
    const ok = await runCli(["sms", "send", "--from", "+14155550100", "--to", nums(51).join(","), "--text", "Hi", "--max-fanout", "51", "--dry-run"], { fetch: api.fetch });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.err).toContain("  recipients: 51");
    expect(ok.err).toMatch(/cost: about USD 0\.4029 for 51 recipients/);
  });

  it("derives per-recipient keys from the number, so a reordered retry keeps them", async () => {
    const keys = async (to: string[]) => {
      const api = fakeFetch({ "GET /messages/cost-preview": PREVIEW, "POST /messages": (req: { body: unknown }) => reply(201, { id: "m", status: "sent", to: (req.body as { to: string[] }).to[0] }) });
      await runCli(["sms", "send", "--from", "+14155550100", "--to", to.join(","), "--text", "Hi", "--idempotency-key", "k1", "--yes", "--json"], { fetch: api.fetch });
      return Object.fromEntries(api.calls.filter((c) => c.method === "POST").map((c) => [(c.body as { to: string[] }).to[0], (c.body as { idempotencyKey: string }).idempotencyKey]));
    };
    const a = await keys(["+14155550123", "+14155550124"]);
    const b = await keys(["+14155550125", "+14155550124", "+14155550123"]);
    expect(a["+14155550123"]).toBe("k1:14155550123");
    expect(b["+14155550123"]).toBe(a["+14155550123"]);
    expect(b["+14155550124"]).toBe(a["+14155550124"]);
  });

  it("shows message text up to 500 characters", async () => {
    const text = `Your code is 123456. ${"a".repeat(80)} https://evil.example/login`;
    const api = fakeFetch({ "GET /messages/cost-preview": PREVIEW });
    const r = await runCli(["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", text, "--dry-run"], { fetch: api.fetch });
    expect(r.err).toContain("https://evil.example/login");
  });
});
