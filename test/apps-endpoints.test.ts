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
    expect(r.json<{ app_id: string }[]>().map((x) => x.app_id)).toEqual(["123", "456"]);
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
    expect((await runCli(["apps", "delete", "123"], { fetch: api.fetch })).code).toBe(6);
    expect((await runCli(["apps", "delete", "123", "--yes"], { fetch: api.fetch })).code).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", path: `${A}/Application/123/` });
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

  it("create sends the body, prompts for nothing with --password, reveals a returned password once", async () => {
    const api = fakeFetch({ [`POST ${A}/Endpoint/`]: reply(201, { alias: "Desk", endpoint_id: "e-1", username: "desk_01", password: "Pw-123456!" }) });
    const r = await runCli(["endpoints", "create", "--username", "desk_01", "--password", "Pw-123456!", "--alias", "Desk", "--application", "42", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().body).toEqual({ username: "desk_01", password: "Pw-123456!", alias: "Desk", application: 42 });
    expect(r.out).not.toContain("Pw-123456!");
    expect(r.err).toContain("SIP password (shown ONCE");
  });

  it("create without --password and without a terminal is a usage error", async () => {
    const api = fakeFetch({});
    const r = await runCli(["endpoints", "create", "--username", "u", "--alias", "a", "--application", "1", "--yes"], { fetch: api.fetch });
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
