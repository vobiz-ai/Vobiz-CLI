import { describe, expect, it } from "vitest";
import { TEST_AUTH_ID, fakeFetch, reply, runCli } from "./helpers.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const app = { app_id: "123", app_name: "IVR", answer_url: "https://example.com/answer", answer_method: "POST", default_app: true, enabled: true };

describe("apps", () => {
  it("list paginates with limit/offset", async () => {
    const api = fakeFetch({
      [`GET ${A}/Application/`]: (req) =>
        req.query.offset === "0"
          ? { meta: { limit: 1, offset: 0, total_count: 2, next: "/next" }, objects: [app] }
          : { meta: { limit: 1, offset: 1, total_count: 2, next: null }, objects: [{ ...app, app_id: "456" }] },
    });
    const r = await runCli(["apps", "list", "--all", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.calls.map((c) => c.query.offset)).toEqual(["0", "1"]);
    // The JSON keeps the API's wrapper whatever the page count; every page's items are merged under `objects`.
    expect(r.json<{ objects: { app_id: string }[] }>().objects.map((x) => x.app_id)).toEqual(["123", "456"]);
    expect(r.json()).toMatchObject({ meta: { total_count: 2 } });
    const page = await runCli(["apps", "list", "--limit", "1", "--json"], { fetch: api.fetch });
    expect(page.json()).toMatchObject({ meta: { total_count: 2 }, objects: [{ app_id: "123" }] });
    const one = await runCli(["apps", "list", "--limit", "1", "-q"], { fetch: api.fetch });
    expect(one.out).toBe("123\n");
    expect(api.last().query).toMatchObject({ limit: "1", offset: "0" });
  });

  it("get / create / update (POST) / delete", async () => {
    const api = fakeFetch({
      [`GET ${A}/Application/123/`]: app,
      [`POST ${A}/Application/`]: reply(201, { api_id: "x", app_id: "789", message: "created" }),
      [`POST ${A}/Application/123/`]: { message: "changed" },
      [`DELETE ${A}/Application/123/`]: reply(204),
    });
    expect((await runCli(["apps", "get", "123", "--json"], { fetch: api.fetch })).json()).toMatchObject({ app_id: "123" });
    const c = await runCli(["apps", "create", "--app-name", "IVR", "--answer-url", "https://example.com/answer", "--answer-method", "POST", "--yes", "--json"], { fetch: api.fetch });
    expect(c.code).toBe(0);
    expect(api.last().body).toEqual({ app_name: "IVR", answer_url: "https://example.com/answer", answer_method: "POST" });
    expect(c.err).toContain("answer_host: example.com");
    expect(c.json()).toMatchObject({ app_id: "789" });
    expect((await runCli(["apps", "create", "--app-name", "IVR", "--yes"], { fetch: api.fetch })).code).toBe(2);
    const u = await runCli(["apps", "update", "123", "--app-name", "IVR2", "--no-default-number-app", "--yes"], { fetch: api.fetch });
    expect(u.code).toBe(0);
    expect(api.last()).toMatchObject({ method: "POST", path: `${A}/Application/123/`, body: { app_name: "IVR2", default_number_app: false } });
    // Partial update (live 2026-10-22): one field is enough, nothing else is required or sent.
    const partial = await runCli(["apps", "update", "123", "--answer-url", "https://example.com/v2", "--yes"], { fetch: api.fetch });
    expect(partial.code, partial.err).toBe(0);
    expect(api.last().body).toEqual({ answer_url: "https://example.com/v2" });
    expect((await runCli(["apps", "update", "123", "--yes"], { fetch: api.fetch })).code).toBe(2); // nothing to change
    expect((await runCli(["apps", "delete", "123"], { fetch: api.fetch })).code).toBe(6);
    expect((await runCli(["apps", "delete", "123", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", path: `${A}/Application/123/` });
  });

  it("refuses non-https URL fields from flags and --body", async () => {
    const api = fakeFetch({ [`POST ${A}/Application/`]: reply(201, { app_id: "789" }), [`POST ${A}/Application/123/`]: { message: "changed" } });
    const flag = await runCli(["apps", "create", "--app-name", "IVR", "--answer-url", "http://evil.example/x", "--yes"], { fetch: api.fetch });
    expect(flag.code).toBe(2);
    expect(flag.err).toContain("--answer-url must use https://");
    const body = await runCli(["apps", "update", "123", "--body", '{"hangup_url":"http://localhost:3000/h"}', "--yes"], { fetch: api.fetch });
    expect(body.code).toBe(2);
    expect(body.err).toContain("--body hangup_url must use https://");
    const scheme = await runCli(["apps", "update", "123", "--body", '{"fallbackUrl":"javascript:alert(1)"}', "--yes"], { fetch: api.fetch });
    expect(scheme.code).toBe(2);
    expect(api.calls).toHaveLength(0);
    const ok = await runCli(["apps", "update", "123", "--body", '{"hangup_url":"https://example.com/h","message_url":""}', "--yes"], { fetch: api.fetch });
    expect(ok.code).toBe(0);
  });

  it("create and update send the answer and hangup URL fields, and the confirmation shows their hosts", async () => {
    const api = fakeFetch({
      [`POST ${A}/Application/`]: reply(201, { api_id: "x", app_id: "789", message: "created" }),
      [`POST ${A}/Application/123/`]: { api_id: "y", message: "changed" },
    });
    const c = await runCli(
      ["apps", "create", "--app-name", "IVR", "--answer-url", "https://example.com/answer", "--answer-method", "POST", "--hangup-url", "https://hooks.example.com/hangup", "--hangup-method", "GET", "--yes"],
      { fetch: api.fetch },
    );
    expect(c.code, c.err).toBe(0);
    expect(api.last().body).toEqual({ app_name: "IVR", answer_url: "https://example.com/answer", answer_method: "POST", hangup_url: "https://hooks.example.com/hangup", hangup_method: "GET" });
    expect(c.err).toContain("hangup_host: hooks.example.com");
    const u = await runCli(
      ["apps", "update", "123", "--app-name", "IVR", "--default-number-app", "--answer-url", "https://new.example.com/answer", "--answer-method", "GET", "--hangup-url", "https://new.example.com/hangup", "--hangup-method", "POST", "--yes", "--json"],
      { fetch: api.fetch },
    );
    expect(u.code, u.err).toBe(0);
    expect(api.last()).toMatchObject({
      method: "POST",
      path: `${A}/Application/123/`,
      body: { app_name: "IVR", default_number_app: true, answer_url: "https://new.example.com/answer", answer_method: "GET", hangup_url: "https://new.example.com/hangup", hangup_method: "POST" },
    });
    expect(u.err).toContain("answer_host: new.example.com");
    expect(u.json()).toMatchObject({ message: "changed" });
  });

  it("--dry-run create sends nothing", async () => {
    const api = fakeFetch({});
    const r = await runCli(["apps", "create", "--app-name", "a", "--answer-url", "https://e.com", "--answer-method", "GET", "--dry-run", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.calls).toHaveLength(0);
    expect(r.json()).toMatchObject({ method: "POST", body: { app_name: "a" } });
  });
});

describe("endpoints", () => {
  it("list passes generated filter flags", async () => {
    const api = fakeFetch({ [`GET ${A}/Endpoint/`]: { meta: { total_count: 0, next: null }, objects: [] } });
    const r = await runCli(["endpoints", "list", "--username-contains", "sales", "--application-id-exact", "42", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().query).toMatchObject({ username__contains: "sales", application_id__exact: "42" });
  });

  it("create sends the body, prompts for nothing with --password, never echoes the password the user typed", async () => {
    const api = fakeFetch({ [`POST ${A}/Endpoint/`]: reply(201, { alias: "Desk", endpoint_id: "e-1", username: "desk_01", password: "Pw-123456!" }) });
    const r = await runCli(["endpoints", "create", "--username", "desk_01", "--password", "Pw-123456!", "--alias", "Desk", "--app-id", "42", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().body).toEqual({ username: "desk_01", password: "Pw-123456!", alias: "Desk", app_id: "42" });
    expect(r.out + r.err).not.toContain("Pw-123456!"); // the password the user typed is never echoed back
    expect(r.err).not.toContain("shown ONCE");
  });

  it("a 17-digit --app-id is sent as an exact string (live: the API links endpoints through app_id)", async () => {
    const api = fakeFetch({ [`POST ${A}/Endpoint/`]: reply(201, { endpoint_id: "e-1" }) });
    const r = await runCli(["endpoints", "create", "--username", "u", "--password", "Pw-123456!", "--alias", "a", "--app-id", "18902825214371853", "--yes"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.last().body).toMatchObject({ app_id: "18902825214371853" });
    expect(api.last().body).not.toHaveProperty("application");
  });

  it("--application is a deprecated alias for --app-id: same string, a warning, never both", async () => {
    const api = fakeFetch({ [`POST ${A}/Endpoint/e-1/`]: reply(202, "") });
    const r = await runCli(["endpoints", "update", "e-1", "--alias", "a", "--password", "Pw-123456!", "--application", "18902825214371853", "--yes"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.last().body).toEqual({ alias: "a", password: "Pw-123456!", app_id: "18902825214371853" });
    expect(r.err).toContain("--application is deprecated; use --app-id");
    const both = await runCli(["endpoints", "update", "e-1", "--alias", "a", "--password", "Pw-123456!", "--application", "1", "--app-id", "2", "--yes"], { fetch: api.fetch });
    expect(both.code).toBe(2);
    expect(both.err).toContain("both set app_id");
    const bad = await runCli(["endpoints", "create", "--username", "u", "--password", "Pw-123456!", "--alias", "a", "--app-id", "12a", "--yes"], { fetch: api.fetch });
    expect(bad.code).toBe(2);
    expect(api.calls).toHaveLength(1);
  });

  it("create without --password and without a terminal is a usage error", async () => {
    const api = fakeFetch({});
    const r = await runCli(["endpoints", "create", "--username", "u", "--alias", "a", "--app-id", "1", "--yes"], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--password");
  });

  it("get / update / delete", async () => {
    const api = fakeFetch({
      [`GET ${A}/Endpoint/e-1/`]: { endpoint_id: "e-1" },
      [`POST ${A}/Endpoint/e-1/`]: { message: "changed" },
      [`DELETE ${A}/Endpoint/e-1/`]: reply(204),
    });
    expect((await runCli(["endpoints", "get", "e-1", "--json"], { fetch: api.fetch })).code).toBe(0);
    expect((await runCli(["endpoints", "update", "e-1", "--alias", "x", "--password", "Np-123456!", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "POST", body: { alias: "x", password: "Np-123456!" } });
    expect((await runCli(["endpoints", "delete", "e-1", "--dry-run"], { fetch: api.fetch })).code).toBe(0);
    expect(api.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect((await runCli(["endpoints", "delete", "e-1", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last().method).toBe("DELETE");
  });
});
