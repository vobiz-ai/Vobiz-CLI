import { describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { TEST_AUTH_ID, TEST_AUTH_TOKEN, fakeFetch, makeCtx, reply, runCli } from "./helpers.js";
import { run } from "../src/cli.js";
import { parseTokenInput } from "../src/commands/auth.js";

const ME = { name: "Test Account", auth_id: TEST_AUTH_ID, auth_secret: "should-never-print" };
const okApi = () => fakeFetch({ "GET /api/v1/auth/me": ME });

describe("login", () => {
  it("--with-token verifies, saves 0600, and makes the first profile the default", async () => {
    const api = okApi();
    const r = await runCli(["login", "--with-token", "--json"], { loggedOut: true, fetch: api.fetch, stdin: `${TEST_AUTH_ID}:${TEST_AUTH_TOKEN}\n` });
    expect(r.code, r.err).toBe(0);
    expect(api.last().headers["x-auth-token"]).toBe(TEST_AUTH_TOKEN);
    expect(r.json()).toMatchObject({ profile: "default", auth_id: TEST_AUTH_ID, account_name: "Test Account", default: true });
    expect(r.store.getProfile("default")).toMatchObject({ authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN, accountName: "Test Account" });
    expect(r.store.settings().defaultProfile).toBe("default");
    if (process.platform !== "win32") expect(statSync(r.store.credentialsPath).mode & 0o777).toBe(0o600);
    expect(r.out + r.err).not.toContain(TEST_AUTH_TOKEN);
    expect(r.out + r.err).not.toContain("should-never-print");
  });

  it("accepts JSON on stdin and a named profile; does not steal the default", async () => {
    const t = makeCtx({ loggedOut: true, fetch: okApi().fetch, stdin: JSON.stringify({ authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN }) });
    t.store.setProfile("main", { authId: "MA_MAIN0000", authToken: "MAIN_TOKEN" });
    t.store.patchSettings({ defaultProfile: "main" });
    expect(await run(["login", "--with-token", "--profile", "staging"], t.ctx)).toBe(0);
    expect(t.store.getProfile("staging")?.authId).toBe(TEST_AUTH_ID);
    expect(t.store.settings().defaultProfile).toBe("main");
    expect(JSON.parse(t.stdout.text)).toMatchObject({ profile: "staging", default: false });
  });

  it("does not save credentials Vobiz rejects", async () => {
    const api = fakeFetch({ "GET /api/v1/auth/me": reply(401, { error: "invalid" }) });
    const r = await runCli(["login", "--with-token"], { loggedOut: true, fetch: api.fetch, stdin: `${TEST_AUTH_ID}:${TEST_AUTH_TOKEN}` });
    expect(r.code).toBe(3);
    expect(r.store.profiles()).toEqual({});
  });

  it("prompts interactively on a TTY (token via hidden prompt) and --browser opens the console", async () => {
    const r = await runCli(["login", "--browser"], {
      loggedOut: true,
      fetch: okApi().fetch,
      stdinTTY: true,
      prompts: { input: [TEST_AUTH_ID], password: [TEST_AUTH_TOKEN] },
    });
    expect(r.code, r.err).toBe(0);
    expect(r.opened).toEqual(["https://console.vobiz.ai"]);
    expect(r.err).not.toContain(TEST_AUTH_TOKEN);
    expect(r.store.getProfile("default")?.authId).toBe(TEST_AUTH_ID);
  });

  it("refuses to prompt when stdin is not a TTY", async () => {
    const r = await runCli(["login"], { loggedOut: true, fetch: okApi().fetch });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--with-token");
  });

  it("accepts --auth-id/--auth-token and warns about shell history", async () => {
    const r = await runCli(["login", "--auth-id", TEST_AUTH_ID, "--auth-token", TEST_AUTH_TOKEN], { loggedOut: true, fetch: okApi().fetch });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("shell history");
  });

  it("parses token input", () => {
    expect(parseTokenInput("MA_A:tok12345")).toEqual({ authId: "MA_A", authToken: "tok12345" });
    expect(parseTokenInput('{"auth_id":"MA_A","auth_token":"tok12345"}')).toEqual({ authId: "MA_A", authToken: "tok12345" });
    expect(() => parseTokenInput("nonsense")).toThrow();
  });
});

describe("whoami, logout, profiles, config", () => {
  function loggedIn() {
    const t = makeCtx({ loggedOut: true, fetch: okApi().fetch });
    t.store.setProfile("default", { authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN, accountName: "Test Account" });
    t.store.setProfile("other", { authId: "SA_XXXXXXXX", authToken: TEST_AUTH_TOKEN });
    t.store.patchSettings({ defaultProfile: "default" });
    return t;
  }

  it("whoami reads the profile offline and --check verifies (redacted)", async () => {
    let t = loggedIn();
    expect(await run(["whoami", "--json"], t.ctx)).toBe(0);
    expect(JSON.parse(t.stdout.text)).toMatchObject({ auth_id: TEST_AUTH_ID, account_name: "Test Account", source: "profile", profile: "default" });
    t = loggedIn();
    expect(await run(["whoami", "--check", "--json", "--profile", "other"], t.ctx)).toBe(0);
    const out = JSON.parse(t.stdout.text);
    expect(out).toMatchObject({ auth_id: "SA_XXXXXXXX", account_type: "sub-account", verified: true });
    expect(out.account.auth_secret).toBe("[redacted]");
  });

  it("profiles list/use/rename/remove", async () => {
    const t = loggedIn();
    expect(await run(["profiles", "list", "--json"], t.ctx)).toBe(0);
    const rows = JSON.parse(t.stdout.text);
    expect(rows.map((r: { name: string }) => r.name)).toEqual(["default", "other"]);
    expect(JSON.stringify(rows)).not.toContain(TEST_AUTH_TOKEN);
    expect(await run(["profiles", "use", "other"], t.ctx)).toBe(0);
    expect(t.store.settings().defaultProfile).toBe("other");
    expect(await run(["profiles", "rename", "other", "sub"], t.ctx)).toBe(0);
    expect(t.store.settings().defaultProfile).toBe("sub");
    expect(await run(["profiles", "remove", "sub"], t.ctx)).toBe(6); // needs --yes off a TTY
    expect(await run(["profiles", "remove", "sub", "--yes"], t.ctx)).toBe(0);
    expect(Object.keys(t.store.profiles())).toEqual(["default"]);
    expect(await run(["profiles", "use", "ghost"], t.ctx)).toBe(4);
  });

  it("logout removes one profile or --all", async () => {
    let t = loggedIn();
    expect(await run(["logout"], t.ctx)).toBe(0);
    expect(Object.keys(t.store.profiles())).toEqual(["other"]);
    t = loggedIn();
    expect(await run(["logout", "--all"], t.ctx)).toBe(6); // confirms
    expect(Object.keys(t.store.profiles()).length).toBe(2);
    expect(await run(["logout", "--all", "--yes"], t.ctx)).toBe(0);
    expect(t.store.profiles()).toEqual({});
    expect(t.store.settings().defaultProfile).toBeUndefined();
  });

  it("config set/get/unset/list/path", async () => {
    const t = makeCtx();
    expect(await run(["config", "set", "output", "yaml"], t.ctx)).toBe(0);
    expect(t.store.settings().output).toBe("yaml");
    expect(await run(["config", "set", "updateCheck", "off"], t.ctx)).toBe(0);
    expect(t.store.settings().updateCheck).toBe(false);
    expect(await run(["config", "set", "output", "xml"], t.ctx)).toBe(2);
    expect(await run(["config", "set", "nope", "1"], t.ctx)).toBe(2);
    expect(await run(["config", "set", "credentialStore", "keychain"], t.ctx)).toBe(2);
    t.stdout.text = "";
    expect(await run(["config", "get", "output", "--json"], t.ctx)).toBe(0);
    expect(JSON.parse(t.stdout.text)).toBe("yaml");
    expect(await run(["config", "unset", "output"], t.ctx)).toBe(0);
    expect(t.store.settings().output).toBeUndefined();
    t.stdout.text = "";
    expect(await run(["config", "path", "--output", "plain"], t.ctx)).toBe(0);
    expect(t.stdout.text.trim()).toBe(t.configDir);
  });

  it("config list shows only user-visible settings; a stored telemetry value still loads", async () => {
    const t = makeCtx();
    t.store.patchSettings({ telemetry: true });
    expect(await run(["config", "list", "--json"], t.ctx)).toBe(0);
    expect(JSON.parse(t.stdout.text).map((r: { key: string }) => r.key)).toEqual(["output", "color", "updateCheck", "defaultProfile"]);
    expect(await run(["config", "set", "telemetry", "true"], t.ctx)).toBe(2);
    expect(t.stderr.text).not.toContain("telemetry,");
    expect(t.store.settings().telemetry).toBe(true);
  });
});
