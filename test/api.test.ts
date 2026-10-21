import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATIONS, SPEC_OPERATION_COUNT } from "../src/generated/operations.js";
import { op } from "../src/core/ops.js";
import { TEST_AUTH_ID, TEST_AUTH_TOKEN, fakeFetch, runCli } from "./helpers.js";

describe("vobiz api --list / --describe", () => {
  it("lists all 195 operations", async () => {
    const r = await runCli(["api", "--list", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toHaveLength(195);
    expect(SPEC_OPERATION_COUNT).toBe(195);
    expect(OPERATIONS).toHaveLength(195);
  });

  it("filters by tag", async () => {
    const r = await runCli(["api", "--list", "--tag", "trunks", "--json"]);
    const rows = r.json<{ tag: string }[]>();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.tag === "Trunks")).toBe(true);
    expect((await runCli(["api", "--list", "--tag", "nope"])).code).toBe(2);
  });

  it("describes one operation", async () => {
    const r = await runCli(["api", "--describe", "get-concurrency", "--json"]);
    expect(r.json()).toMatchObject({ id: "get-concurrency", method: "GET", path: "/api/v1/Account/{auth_id}/concurrency" });
    const text = await runCli(["api", "--describe", "get-concurrency", "--output", "table"]);
    expect(text.out).toContain("GET /api/v1/Account/{auth_id}/concurrency");
    expect((await runCli(["api", "--describe", "no-such-op"])).code).toBe(4);
  });

  it("describes both operations when an id is ambiguous", async () => {
    const r = await runCli(["api", "--describe", "list-numbers", "--json"]);
    expect(r.json<unknown[]>()).toHaveLength(2);
    expect(() => op("list-numbers")).toThrow(/ambiguous/);
    expect(op("sms:list-numbers").api).toBe("sms");
  });
});

describe("vobiz api <METHOD> <path>", () => {
  it("GETs with the auth_id filled and prints the redacted response", async () => {
    const api = fakeFetch({ [`GET /api/v1/Account/${TEST_AUTH_ID}/Call/`]: { objects: [{ call_uuid: "c1" }], auth_secret: "zzz-secret" } });
    const r = await runCli(["api", "get", "/api/v1/Account/{auth_id}/Call/", "--query", "status=live", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().query).toEqual({ status: "live" });
    expect(r.json()).toMatchObject({ auth_secret: "[redacted]" });
    expect(r.out).not.toContain("zzz-secret");
  });

  it("sends to the Messaging API with --sms", async () => {
    const api = fakeFetch({ "GET /messages": { items: [] } });
    const r = await runCli(["api", "GET", "/messages", "--sms", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().api).toBe("sms");
  });

  it("refuses a write without --yes when stdin is not a TTY", async () => {
    const api = fakeFetch();
    const r = await runCli(["api", "POST", "/api/v1/x", "--body", "{}"], { fetch: api.fetch });
    expect(r.code).toBe(6);
    expect(api.calls).toHaveLength(0);
  });

  it("sends a write with --yes (body inline or from a file)", async () => {
    const api = fakeFetch({ "POST /api/v1/x": { ok: true } });
    let r = await runCli(["api", "POST", "/api/v1/x", "--body", '{"a":1}', "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().body).toEqual({ a: 1 });
    const file = join(mkdtempSync(join(tmpdir(), "vobiz-body-")), "b.json");
    writeFileSync(file, '{"b":2}');
    r = await runCli(["api", "POST", "/api/v1/x", "--body", `@${file}`, "-y", "--json"], { fetch: api.fetch });
    expect(api.last().body).toEqual({ b: 2 });
    r = await runCli(["api", "POST", "/api/v1/x", "--body", "@-", "-y", "--json"], { fetch: api.fetch, stdin: '{"c":3}' });
    expect(api.last().body).toEqual({ c: 3 });
  });

  it("--dry-run prints the request and sends nothing", async () => {
    const api = fakeFetch();
    const r = await runCli(["api", "DELETE", "/api/v1/Account/{auth_id}/Call/abc/", "--dry-run", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.calls).toHaveLength(0);
    expect(r.json()).toMatchObject({ dry_run: true, method: "DELETE", url: `https://api.vobiz.ai/api/v1/Account/${TEST_AUTH_ID}/Call/abc/` });
    expect(r.out + r.err).not.toContain(TEST_AUTH_TOKEN);
  });

  it("DELETE accepts --body and sends it as JSON", async () => {
    const api = fakeFetch({ "DELETE /api/v1/partner/kyc-sessions/k1": { message: "revoked" } });
    const r = await runCli(["api", "DELETE", "/api/v1/partner/kyc-sessions/k1", "--body", '{"reason":"dup"}', "-y"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", body: { reason: "dup" } });
  });

  it("validates method, body and query syntax", async () => {
    expect((await runCli(["api", "TRACE", "/x"])).code).toBe(2);
    expect((await runCli(["api", "GET", "/x", "--body", "{}"])).code).toBe(2);
    expect((await runCli(["api", "GET", "/x", "--query", "novalue"])).code).toBe(2);
    expect((await runCli(["api", "POST", "/x", "--body", "{bad", "-y"])).code).toBe(2);
    expect((await runCli(["api"])).code).toBe(2);
  });
});
