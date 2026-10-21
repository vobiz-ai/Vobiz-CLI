import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_AUTH_ID, fakeFetch, reply, runCli } from "./helpers.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const trunk = { trunk_id: "t-1", name: "Office PBX", trunk_direction: "outbound", trunk_status: "enabled", transport: "udp", trunk_domain: "t-1.sip.vobiz.ai" };
const credList = { meta: { limit: 20, offset: 0, total: 1 }, objects: [{ id: "c-1", username: "pbx_01", password: "<redacted>", realm: "MA.sip.vobiz.ai", enabled: true }] };

describe("trunks", () => {
  it("list / get", async () => {
    const api = fakeFetch({ [`GET ${A}/trunks`]: { meta: { limit: 20, offset: 0, total: 1 }, objects: [trunk] }, [`GET ${A}/trunks/t-1`]: trunk });
    const l = await runCli(["trunks", "list", "-o", "table"], { fetch: api.fetch });
    expect(l.code).toBe(0);
    expect(l.out).toContain("TRUNK_ID");
    expect(l.out).toContain("Office PBX");
    const g = await runCli(["trunks", "get", "t-1", "--json"], { fetch: api.fetch });
    expect(g.json()).toMatchObject({ trunk_id: "t-1" });
    expect(api.last()).toMatchObject({ method: "GET", path: `${A}/trunks/t-1` });
  });

  it("create maps kebab flags to the spec body, with numbers and booleans typed", async () => {
    const api = fakeFetch({ [`POST ${A}/trunks`]: reply(201, trunk) });
    const r = await runCli(
      ["trunks", "create", "--name", "Office PBX", "--trunk-direction", "outbound", "--concurrent-calls-limit", "10", "--recording", "--no-secure", "--webhook-url", "https://hooks.example.com/x", "--yes", "--json"],
      { fetch: api.fetch },
    );
    expect(r.code).toBe(0);
    expect(api.last()).toMatchObject({ method: "POST", path: `${A}/trunks` });
    expect(api.last().body).toEqual({ name: "Office PBX", trunk_direction: "outbound", concurrent_calls_limit: 10, recording: true, secure: false, webhook_url: "https://hooks.example.com/x" });
    expect(r.err).toContain("webhook_host: hooks.example.com");
  });

  it("create validates enums, numbers and required fields", async () => {
    const api = fakeFetch({});
    expect((await runCli(["trunks", "create", "--name", "x", "--trunk-direction", "both", "--yes"], { fetch: api.fetch })).code).toBe(2);
    expect((await runCli(["trunks", "create", "--name", "x", "--cps-limit", "1.5", "--yes"], { fetch: api.fetch })).code).toBe(2);
    const missing = await runCli(["trunks", "create", "--yes"], { fetch: api.fetch });
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("--name");
    expect((await runCli(["trunks", "create", "--name", "x", "--bogus", "1", "--yes"], { fetch: api.fetch })).code).toBe(2);
    expect(api.calls).toHaveLength(0);
  });

  it("--body passes arbitrary keys and flags override it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-trunk-"));
    const file = join(dir, "t.json");
    writeFileSync(file, JSON.stringify({ name: "from file", custom_key: 1 }));
    const api = fakeFetch({ [`POST ${A}/trunks`]: trunk });
    const r = await runCli(["trunks", "create", "--body", `@${file}`, "--transport", "tls", "--yes"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().body).toEqual({ name: "from file", custom_key: 1, transport: "tls" });
    const stdin = await runCli(["trunks", "create", "--body", "@-", "--yes"], { fetch: api.fetch, stdin: '{"name":"piped"}' });
    expect(stdin.code).toBe(0);
    expect(api.last().body).toEqual({ name: "piped" });
  });

  it("update requires a change and sends PUT", async () => {
    const api = fakeFetch({ [`PUT ${A}/trunks/t-1`]: trunk });
    expect((await runCli(["trunks", "update", "t-1", "--yes"], { fetch: api.fetch })).code).toBe(2);
    const r = await runCli(["trunks", "update", "t-1", "--trunk-status", "disabled", "--yes"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last()).toMatchObject({ method: "PUT", path: `${A}/trunks/t-1`, body: { trunk_status: "disabled" } });
  });

  it("delete confirms; non-TTY without --yes exits 6; --dry-run sends nothing", async () => {
    const api = fakeFetch({ [`DELETE ${A}/trunks/t-1`]: reply(204) });
    expect((await runCli(["trunks", "delete", "t-1"], { fetch: api.fetch })).code).toBe(6);
    const d = await runCli(["trunks", "delete", "t-1", "--dry-run", "--json"], { fetch: api.fetch });
    expect(d.code).toBe(0);
    expect(d.json()).toMatchObject({ dry_run: true, method: "DELETE" });
    expect(api.calls).toHaveLength(0);
    const r = await runCli(["trunks", "delete", "t-1", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ trunk_id: "t-1", deleted: true });
  });
});

describe("trunks credentials", () => {
  it("list uses /trunks/credentials and never shows passwords", async () => {
    const api = fakeFetch({ [`GET ${A}/trunks/credentials`]: { ...credList, objects: [{ ...credList.objects[0], password: "hunter2-real" }] } });
    const r = await runCli(["trunks", "credentials", "list", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("hunter2-real");
    expect(r.out).toContain("[redacted]");
  });

  it("create shows a server-generated password only with --reveal-secret, never the one typed", async () => {
    const api = fakeFetch({ [`POST ${A}/credentials`]: reply(201, { id: "c-2", username: "pbx_02", password: "S3cret!pass" }) });
    const r = await runCli(["trunks", "credentials", "create", "--username", "pbx_02", "--password", "S3cret!pass", "--reveal-secret", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().body).toEqual({ username: "pbx_02", password: "S3cret!pass" });
    expect(r.out + r.err).not.toContain("S3cret!pass");

    const gen = fakeFetch({ [`POST ${A}/credentials`]: reply(201, { id: "c-2", username: "pbx_02", password: "Gen-erated-9" }) });
    const hidden = await runCli(["trunks", "credentials", "create", "--username", "pbx_02", "--password", "mine-12345", "--yes", "--json"], { fetch: gen.fetch });
    expect(hidden.out + hidden.err).not.toContain("Gen-erated-9");
    expect(hidden.err).toContain("--reveal-secret");
    const shown = await runCli(["trunks", "credentials", "create", "--username", "pbx_02", "--password", "mine-12345", "--reveal-secret", "--yes", "--json"], { fetch: gen.fetch });
    expect(shown.out).not.toContain("Gen-erated-9");
    expect(shown.err.match(/Gen-erated-9/g)).toHaveLength(1);
    expect(shown.err).toContain("shown ONCE");
  });

  it("create does not echo a password the API already redacted", async () => {
    const api = fakeFetch({ [`POST ${A}/credentials`]: { id: "c-3", username: "u", password: "<redacted>" } });
    const r = await runCli(["trunks", "credentials", "create", "--username", "u", "--password", "p4ss-word!", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("shown ONCE");
    expect(r.err).not.toContain("p4ss-word!");
  });

  it("create prompts for a missing password on a terminal; dry-run redacts it", async () => {
    const api = fakeFetch({ [`POST ${A}/credentials`]: { id: "c-4", username: "u" } });
    const r = await runCli(["trunks", "credentials", "create", "--username", "u", "--yes"], { fetch: api.fetch, stdinTTY: true, prompts: { password: ["typed-pass1!"] } });
    expect(r.code).toBe(0);
    expect(api.last().body).toEqual({ username: "u", password: "typed-pass1!" });
    const d = await runCli(["trunks", "credentials", "create", "--username", "u", "--password", "zzz-secret", "--dry-run", "--json"], { fetch: api.fetch });
    expect(d.out).not.toContain("zzz-secret");
    expect(d.json()).toMatchObject({ body: { username: "u", password: "[redacted]" } });
  });

  it("update and delete use /credentials/{id}", async () => {
    const api = fakeFetch({ [`PUT ${A}/credentials/c-1`]: { id: "c-1" }, [`DELETE ${A}/credentials/c-1`]: reply(204) });
    expect((await runCli(["trunks", "credentials", "update", "c-1", "--password", "N3w!pass", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "PUT", body: { password: "N3w!pass" } });
    expect((await runCli(["trunks", "credentials", "delete", "c-1", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last().method).toBe("DELETE");
  });
});

describe("trunks ip-acl and origination-uris", () => {
  it("ip-acl CRUD", async () => {
    const api = fakeFetch({
      [`GET ${A}/trunks/ip-acl`]: { meta: { total: 0 }, objects: [] },
      [`POST ${A}/ip-acl`]: reply(201, { id: "acl-1", ip_address: "203.0.113.0/24" }),
      [`PUT ${A}/ip-acl/acl-1`]: { id: "acl-1" },
      [`DELETE ${A}/ip-acl/acl-1`]: reply(204),
    });
    const l = await runCli(["trunks", "ip-acl", "list", "-o", "table"], { fetch: api.fetch });
    expect(l.code).toBe(0);
    expect(l.err).toContain("No IP ACL entries.");
    expect((await runCli(["trunks", "ip-acl", "create", "--name", "office", "--ip-address", "203.0.113.0/24", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last().body).toEqual({ name: "office", ip_address: "203.0.113.0/24" });
    expect((await runCli(["trunks", "ip-acl", "update", "acl-1", "--name", "o2", "--ip-address", "203.0.113.1", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "PUT", path: `${A}/ip-acl/acl-1` });
    expect((await runCli(["trunks", "ip-acl", "update", "acl-1", "--name", "o2", "--yes"], { fetch: api.fetch })).code).toBe(2); // ip_address is required
    expect((await runCli(["trunks", "ip-acl", "delete", "acl-1", "--yes"], { fetch: api.fetch })).code).toBe(0);
  });

  it("origination-uris CRUD", async () => {
    const api = fakeFetch({
      [`GET ${A}/trunks/origination-uris`]: { meta: { total: 1 }, objects: [{ id: "u-1", uri: "sip:pbx.example.com", priority: 1 }] },
      [`POST ${A}/origination-uris`]: reply(201, { id: "u-2" }),
      [`PUT ${A}/origination-uris/u-1`]: { id: "u-1" },
      [`DELETE ${A}/origination-uris/u-1`]: reply(204),
    });
    expect((await runCli(["trunks", "origination-uris", "list", "--json"], { fetch: api.fetch })).json()).toMatchObject({ objects: [{ id: "u-1" }] });
    expect((await runCli(["trunks", "origination-uris", "create", "--name", "p", "--sip-uri", "sip:pbx.example.com", "--priority", "1", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last().body).toEqual({ name: "p", sip_uri: "sip:pbx.example.com", priority: 1 });
    expect((await runCli(["trunks", "origination-uris", "update", "u-1", "--name", "p", "--priority", "2", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "PUT", body: { name: "p", priority: 2 } });
    expect((await runCli(["trunks", "origination-uris", "delete", "u-1"], { fetch: api.fetch })).code).toBe(6);
    expect((await runCli(["trunks", "origination-uris", "delete", "u-1", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", path: `${A}/origination-uris/u-1` });
  });
});

describe("secret flags", () => {
  it("--password reads @file and @-, and a literal value warns about shell history", async () => {
    const A = `/api/v1/Account/${TEST_AUTH_ID}`;
    const api = fakeFetch({ [`POST ${A}/credentials`]: reply(201, { id: "c-9", username: "u" }) });
    const file = join(mkdtempSync(join(tmpdir(), "vobiz-pw-")), "pw");
    writeFileSync(file, "from-file-pass1\n");
    const f = await runCli(["trunks", "credentials", "create", "--username", "u", "--password", `@${file}`, "--yes"], { fetch: api.fetch });
    expect(f.code, f.err).toBe(0);
    expect(api.last().body).toEqual({ username: "u", password: "from-file-pass1" });
    expect(f.err).not.toContain("shell history");

    const s = await runCli(["trunks", "credentials", "create", "--username", "u", "--password", "@-", "--yes"], { fetch: api.fetch, stdin: "from-stdin-pass2\n" });
    expect(s.code, s.err).toBe(0);
    expect(api.last().body).toEqual({ username: "u", password: "from-stdin-pass2" });

    const lit = await runCli(["trunks", "credentials", "create", "--username", "u", "--password", "literal-pass3", "--yes"], { fetch: api.fetch });
    expect(lit.code).toBe(0);
    expect(lit.err).toContain("--password on the command line is saved in your shell history");
    expect(lit.err).not.toContain("literal-pass3");

    const missing = await runCli(["trunks", "credentials", "create", "--username", "u", "--password", "@/nonexistent/pw", "--yes"], { fetch: api.fetch });
    expect(missing.code).toBe(2);

    const sms = fakeFetch({ "POST /webhooks": reply(201, { id: "w1" }) });
    const wh = await runCli(["sms", "webhooks", "create", "--url", "https://example.com/h", "--secret", "@-", "--yes"], { fetch: sms.fetch, stdin: "whsec-from-stdin\n" });
    expect(wh.code, wh.err).toBe(0);
    expect(sms.last().body).toMatchObject({ secret: "whsec-from-stdin" });
    const whLit = await runCli(["sms", "webhooks", "update", "w1", "--secret", "whsec-literal", "--yes"], { fetch: fakeFetch({ "PATCH /webhooks/w1": { id: "w1" }, "PUT /webhooks/w1": { id: "w1" } }).fetch });
    expect(whLit.err).toContain("--secret on the command line is saved in your shell history");
  });
});
