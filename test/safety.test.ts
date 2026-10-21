/**
 * Safety properties: tokens and secrets never reach stdout/stderr (login, whoami, doctor, --debug logs, --dry-run,
 * errors, mcp install), the credentials file is 0600 and rewritten atomically, user-supplied ids and paths cannot
 * escape where they belong, and local development servers bind to 127.0.0.1 unless told otherwise.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildProgram, findCommand, run } from "../src/cli.js";
import { VobizClient } from "../src/core/client.js";
import { defaultFileName } from "../src/commands/recordings.js";
import { startXmlServer } from "../src/commands/xml.js";
import { startWebhookListener } from "../src/commands/webhooks.js";
import { SMS_BASE, TEST_AUTH_ID, TEST_AUTH_TOKEN, VOICE_BASE, fakeFetch, makeCtx, reply, runCli, textReply } from "./helpers.js";
import { specFake } from "./spec-fake.js";

const posix = process.platform !== "win32";
const SECRET_PW = "Sup3r-S3cret-PW";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const ME = { name: "Test Account", auth_id: TEST_AUTH_ID, auth_token: "SERVER-ECHOED-TOKEN", auth_secret: "SERVER-SECRET" };
const leaks = (text: string) => [TEST_AUTH_TOKEN, SECRET_PW, "SERVER-ECHOED-TOKEN", "SERVER-SECRET"].filter((s) => text.includes(s));

describe("no token or secret in output", () => {
  it("login --with-token (plain, --verbose and --debug)", async () => {
    for (const extra of [[], ["--verbose"], ["--debug"], ["--json"], ["--debug", "--json"]]) {
      const r = await runCli(["login", "--with-token", ...extra], { loggedOut: true, fetch: fakeFetch({ "GET /api/v1/auth/me": ME }).fetch, stdin: `${TEST_AUTH_ID}:${TEST_AUTH_TOKEN}` });
      expect(r.code, r.err).toBe(0);
      expect(leaks(r.out + r.err), extra.join(" ")).toEqual([]);
    }
  });

  it("interactive login never echoes the hidden token", async () => {
    const r = await runCli(["login", "--debug"], {
      loggedOut: true,
      fetch: fakeFetch({ "GET /api/v1/auth/me": ME }).fetch,
      stdinTTY: true,
      prompts: { input: [TEST_AUTH_ID], password: [TEST_AUTH_TOKEN] },
    });
    expect(r.code, r.err).toBe(0);
    expect(leaks(r.out + r.err)).toEqual([]);
  });

  it("whoami, whoami --check, in every output mode", async () => {
    for (const mode of ["json", "yaml", "table", "tsv", "plain"]) {
      for (const check of [[], ["--check"]]) {
        const r = await runCli(["whoami", ...check, "--output", mode, "--debug"], { fetch: fakeFetch({ "GET /api/v1/auth/me": ME }).fetch });
        expect(r.code, r.err).toBe(0);
        expect(leaks(r.out + r.err), `${mode} ${check}`).toEqual([]);
      }
    }
  });

  it("whoami with --auth-token on the command line warns but never prints it", async () => {
    const r = await runCli(["whoami", "--auth-id", TEST_AUTH_ID, "--auth-token", TEST_AUTH_TOKEN, "--json"], { loggedOut: true });
    expect(r.code).toBe(0);
    expect(r.err).toContain("shell history");
    expect(leaks(r.out + r.err)).toEqual([]);
  });

  it("doctor (offline and online, profile and env credentials)", async () => {
    const api = fakeFetch({ "GET /": reply(404, {}), "GET /api/v1/sms/": reply(404, {}), "GET /api/v1/auth/me": ME });
    for (const argv of [["doctor", "--offline"], ["doctor"], ["doctor", "--json", "--debug"], ["doctor", "--output", "table", "--verbose"]]) {
      const r = await runCli(argv, { fetch: api.fetch });
      expect(leaks(r.out + r.err), argv.join(" ")).toEqual([]);
    }
    const t = makeCtx({ loggedOut: true, fetch: api.fetch });
    t.store.setProfile("default", { authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN });
    await run(["doctor", "--json", "--debug"], t.ctx);
    expect(leaks(t.stdout.text + t.stderr.text)).toEqual([]);
  });

  it("profiles list and config list never show tokens", async () => {
    const t = makeCtx({ loggedOut: true });
    t.store.setProfile("default", { authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN });
    for (const argv of [["profiles", "list", "--json"], ["profiles", "list", "--output", "table"], ["config", "list", "--json"], ["config", "path", "--credentials"]]) {
      await run(argv, t.ctx);
    }
    expect(leaks(t.stdout.text + t.stderr.text)).toEqual([]);
  });

  it("--debug logs redact request and response secrets", async () => {
    const api = specFake({ answer: () => ({ id: "c1", password: SECRET_PW, auth_token: "SERVER-ECHOED-TOKEN", nested: { secret: "SERVER-SECRET" } }) });
    const cases = [
      ["trunks", "credentials", "create", "--username", "pbx", "--password", SECRET_PW],
      ["endpoints", "create", "--username", "alice", "--password", SECRET_PW, "--alias", "A", "--application", "1"],
      ["sub-accounts", "create", "--name", "Acme", "--password", SECRET_PW],
      ["trunks", "credentials", "update", "c1", "--password", SECRET_PW],
      ["api", "POST", "/api/v1/x", "--body", JSON.stringify({ password: SECRET_PW, authToken: TEST_AUTH_TOKEN })],
      ["numbers", "list"],
    ];
    for (const argv of cases) {
      const fetch = argv[0] === "api" ? fakeFetch({ "POST /api/v1/x": { auth_token: "SERVER-ECHOED-TOKEN" } }).fetch : api.fetch;
      const r = await runCli([...argv, "--yes", "--debug", "--json"], { fetch });
      expect(r.code, `${argv.join(" ")}: ${r.err}`).toBe(0);
      expect(r.err, argv.join(" ")).toContain("[debug]");
      // A create may reveal a one-time secret the API returned, once, on stderr: never the token or the password we sent.
      expect(leaks(r.out), argv.join(" ")).toEqual([]);
      const errLeaks = leaks(r.err).filter((s) => s !== SECRET_PW || !r.err.includes("shown ONCE"));
      expect(errLeaks, argv.join(" ")).toEqual([]);
      expect(r.err).not.toContain(TEST_AUTH_TOKEN);
    }
  });

  it("--debug --show-secrets is the only way to see response secrets", async () => {
    const api = specFake({ answer: () => ({ objects: [{ id: "x", auth_token: "SERVER-ECHOED-TOKEN" }] }) });
    expect((await runCli(["sub-accounts", "list", "--json"], { fetch: api.fetch })).out).not.toContain("SERVER-ECHOED-TOKEN");
    expect((await runCli(["sub-accounts", "list", "--json", "--show-secrets"], { fetch: api.fetch })).out).not.toContain("SERVER-ECHOED-TOKEN");
    expect((await runCli(["sub-accounts", "list", "--json", "--debug", "--show-secrets"], { fetch: api.fetch })).out).toContain("SERVER-ECHOED-TOKEN");
  });

  const dryRuns: string[][] = [
    ["calls", "create", "--to", "+919876543210", "--from", "+918012345678", "--answer-url", "https://e.com/a"],
    ["calls", "hangup", "c1"],
    ["calls", "stream", "start", "c1", "--url", "wss://e.com/ws"],
    ["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hi"],
    ["sms", "webhooks", "create", "--url", "https://e.com/hook", "--secret", SECRET_PW, "--event", "message.delivered"],
    ["trunks", "credentials", "create", "--username", "pbx", "--password", SECRET_PW],
    ["trunks", "create", "--name", "pbx", "--trunk-direction", "outbound", "--username", "u", "--password", SECRET_PW],
    ["endpoints", "create", "--username", "alice", "--password", SECRET_PW, "--alias", "A", "--application", "1"],
    ["endpoints", "update", "e1", "--password", SECRET_PW, "--alias", "A"],
    ["sub-accounts", "create", "--name", "Acme", "--password", SECRET_PW],
    ["partner", "accounts", "create", "--name", "Acme", "--email", "a@example.com", "--password", SECRET_PW, "--body", '{"phone":"+919876543210"}'],
    ["numbers", "release", "+919876543210"],
    ["recordings", "delete", "r1"],
    ["api", "POST", "/api/v1/x", "--body", JSON.stringify({ password: SECRET_PW, token: TEST_AUTH_TOKEN })],
  ];
  for (const argv of dryRuns) {
    it(`--dry-run shows no token or password: ${argv.slice(0, 3).join(" ")}`, async () => {
      const api = specFake();
      const r = await runCli([...argv, "--dry-run", "--json"], { fetch: api.fetch, env: { VOBIZ_WEBHOOK_SECRET: "" } });
      expect(r.code, r.err).toBe(0);
      expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
      expect(leaks(r.out + r.err)).toEqual([]);
      const dry = r.json();
      expect(dry.dry_run).toBe(true);
      expect(dry.headers["X-Auth-Token"]).toBe("[redacted]");
      expect(dry.headers["X-Auth-ID"]).toBe(TEST_AUTH_ID);
    });
  }

  it("errors never contain the token, even when the API echoes it", async () => {
    const api = fakeFetch({ "GET /api/v1/auth/me": reply(401, { error: "invalid credentials", auth_token: TEST_AUTH_TOKEN }) });
    for (const extra of [[], ["--json"], ["--verbose"], ["--debug"]]) {
      const r = await runCli(["whoami", "--check", ...extra], { fetch: api.fetch });
      expect(r.code).toBe(3);
      expect(r.out + r.err, extra.join(" ")).not.toContain(TEST_AUTH_TOKEN);
    }
  });

  // The test token equals the documented placeholder, so these use a distinct one.
  const LIVE_TOKEN = "tok_live_9f8e7d6c5b4a";

  it("mcp install --local --with-credentials --dry-run prints the snippet without the token", async () => {
    const HOME = tmp("vobiz-home-");
    for (const client of ["claude", "cursor", "codex", "claude-code", "zed"]) {
      const r = await runCli(["mcp", "install", client, "--local", "--with-credentials", "--dry-run"], {
        env: { HOME, XDG_CONFIG_HOME: join(HOME, ".config"), APPDATA: join(HOME, "AppData"), VOBIZ_AUTH_TOKEN: LIVE_TOKEN },
      });
      expect(r.code, `${client}: ${r.err}`).toBe(0);
      expect(r.out + r.err, client).not.toContain(LIVE_TOKEN);
      expect(r.out, client).toContain(TEST_AUTH_ID);
    }
    expect(readdirSync(HOME)).toEqual([]);
  });

  it("mcp config never includes credentials", async () => {
    for (const client of ["claude", "claude-code", "cursor", "codex", "windsurf", "vscode", "gemini", "zed"]) {
      for (const mode of ["--hosted", "--local"]) {
        const r = await runCli(["mcp", "config", client, mode], { env: { HOME: tmp("vobiz-home-"), VOBIZ_AUTH_TOKEN: LIVE_TOKEN } });
        expect(r.code, `${client} ${mode}: ${r.err}`).toBe(0);
        expect(r.out + r.err).not.toContain(LIVE_TOKEN);
      }
    }
  });

  it("the token is sent only to the configured API host, in the X-Auth-Token header", async () => {
    const api = specFake();
    await runCli(["numbers", "list", "--json"], { fetch: api.fetch });
    await runCli(["sms", "messages", "list", "--json"], { fetch: api.fetch });
    for (const c of api.calls) {
      expect(new URL(c.url).host).toBe("api.vobiz.ai");
      expect(c.headers["x-auth-token"]).toBe(TEST_AUTH_TOKEN);
      expect(c.url).not.toContain(TEST_AUTH_TOKEN);
    }
  });

  it("recordings download sends credentials to the API host only, never to a storage host", async () => {
    const dir = tmp("vobiz-rec-");
    const out = join(dir, "a.mp3");
    const api = fakeFetch({
      [`GET /api/v1/Account/${TEST_AUTH_ID}/Recording/r1/`]: { recording_id: "r1", recording_url: "https://storage.example.net/r1.mp3" },
    });
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      calls.push({ url, headers });
      if (url.startsWith("https://storage.example.net/")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
      return api.fetch(input, init);
    };
    const r = await runCli(["recordings", "download", "r1", "--out", out, "--json"], { fetch });
    expect(r.code, r.err).toBe(0);
    const storage = calls.find((c) => c.url.startsWith("https://storage.example.net/"))!;
    expect(storage.headers["x-auth-token"]).toBeUndefined();
    expect(storage.headers["x-auth-id"]).toBeUndefined();
    expect(readFileSync(out)).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe("credentials file", () => {
  it("is 0600 in a 0700 directory after login", async () => {
    const r = await runCli(["login", "--with-token"], { loggedOut: true, fetch: fakeFetch({ "GET /api/v1/auth/me": ME }).fetch, stdin: `${TEST_AUTH_ID}:${TEST_AUTH_TOKEN}` });
    expect(r.code).toBe(0);
    if (posix) {
      expect(statSync(r.store.credentialsPath).mode & 0o777).toBe(0o600);
      expect(statSync(r.configDir).mode & 0o077).toBe(0);
    }
  });

  it("a rewrite restores 0600 on a loosened file and replaces it atomically (new inode, no temp left)", () => {
    const t = makeCtx({ loggedOut: true });
    t.store.setProfile("a", { authId: "MA_A", authToken: "TOKEN_AAAA" });
    if (posix) chmodSync(t.store.credentialsPath, 0o644);
    const before = statSync(t.store.credentialsPath).ino;
    t.store.setProfile("b", { authId: "MA_B", authToken: "TOKEN_BBBB" });
    if (posix) {
      expect(statSync(t.store.credentialsPath).mode & 0o777).toBe(0o600);
      expect(statSync(t.store.credentialsPath).ino).not.toBe(before);
    }
    expect(readdirSync(t.configDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(Object.keys(t.store.profiles())).toEqual(["a", "b"]);
  });

  it("stays 0600 through profiles rename, use, remove and logout", async () => {
    const t = makeCtx({ loggedOut: true });
    t.store.setProfile("one", { authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN });
    t.store.setProfile("two", { authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN });
    for (const argv of [["profiles", "rename", "one", "uno"], ["profiles", "use", "uno"], ["profiles", "remove", "two", "--yes"], ["logout"]]) {
      expect(await run(argv, t.ctx), argv.join(" ")).toBe(0);
      if (posix && existsSync(t.store.credentialsPath)) expect(statSync(t.store.credentialsPath).mode & 0o777, argv.join(" ")).toBe(0o600);
    }
    expect(readFileSync(t.store.settingsPath, "utf8")).not.toContain(TEST_AUTH_TOKEN);
  });

  it("settings (config.json) never hold credentials", async () => {
    const t = makeCtx({ loggedOut: true, fetch: fakeFetch({ "GET /api/v1/auth/me": ME }).fetch, stdin: `${TEST_AUTH_ID}:${TEST_AUTH_TOKEN}` });
    expect(await run(["login", "--with-token"], t.ctx)).toBe(0);
    expect(await run(["config", "set", "output", "json"], t.ctx)).toBe(0);
    expect(readFileSync(t.store.settingsPath, "utf8")).not.toContain(TEST_AUTH_TOKEN);
  });
});

describe("ids and paths cannot escape", () => {
  const client = () => new VobizClient({ creds: { authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN, voiceBaseUrl: VOICE_BASE, smsBaseUrl: SMS_BASE, source: "env" }, fetch: fakeFetch().fetch });

  it("path params are percent-encoded: / ? # and + cannot change the route", () => {
    const c = client();
    expect(c.fillPath("/x/{id}/y", { id: "a/b?c#d+e" })).toBe("/x/a%2Fb%3Fc%23d%2Be/y");
    expect(c.fillPath("/x/{id}", { id: "..%2F" })).toBe("/x/..%252F");
    expect(c.fillPath("/Account/{auth_id}/x", {})).toBe(`/Account/${TEST_AUTH_ID}/x`);
  });

  for (const id of [".", ".."]) {
    it(`a path param of "${id}" is rejected instead of being collapsed by URL normalisation`, () => {
      expect(() => client().fillPath("/api/v1/Account/{auth_id}/Call/{call_uuid}", { call_uuid: id })).toThrow(/path parameter/);
    });
  }

  const dotWrites: string[][] = [
    ["calls", "hangup", ".."],
    ["calls", "get", ".."],
    ["trunks", "delete", ".."],
    ["apps", "delete", ".."],
    ["endpoints", "delete", "."],
    ["recordings", "delete", ".."],
    ["conferences", "end", ".."],
    ["sub-accounts", "delete", ".."],
    ["sms", "webhooks", "delete", ".."],
    ["sms", "broadcasts", "delete", ".."],
  ];
  for (const argv of dotWrites) {
    it(`\`${argv.join(" ")}\` sends nothing`, async () => {
      const api = specFake();
      const r = await runCli([...argv, "--yes"], { fetch: api.fetch });
      expect(r.code, r.err).toBe(2);
      expect(api.calls).toHaveLength(0);
    });
  }

  it("ids with slashes stay inside their path segment", async () => {
    const api = specFake();
    const r = await runCli(["trunks", "delete", "../../Account/x", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(api.last().path).toMatch(new RegExp(`^/api/v1/account/${TEST_AUTH_ID}/trunks/\\.\\.%2F\\.\\.%2FAccount%2Fx$`, "i"));
    expect(api.ops()).toEqual(["delete-trunk"]);
  });

  it("recordings download: the default file name is sanitised to one file in the current folder", () => {
    const u = new URL("https://s.example.com/x.wav");
    for (const id of ["../../etc/passwd", "..\\..\\win", "/abs/path", "a/b", "..", "rec 1"]) {
      const name = defaultFileName(id, {}, u);
      expect(name, id).not.toMatch(/[/\\]/);
      expect(resolve(name).startsWith(process.cwd() + sep), id).toBe(true);
    }
    expect(defaultFileName("../../etc/passwd", { recording_format: "../sh" }, u)).toBe(".._.._etc_passwd.wav");
  });

  it("recordings download --out refuses to overwrite an existing file", async () => {
    const dir = tmp("vobiz-rec-");
    const out = join(dir, "keep.mp3");
    writeFileSync(out, "precious");
    const api = specFake({ answer: () => ({ recording_id: "r1", recording_url: "https://media.vobiz.ai/r1.mp3" }) });
    const r = await runCli(["recordings", "download", "r1", "--out", out], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(readFileSync(out, "utf8")).toBe("precious");
  });

  it("cdr export --out writes exactly the given file and refuses to overwrite", async () => {
    const dir = tmp("vobiz-cdr-");
    const out = join(dir, "sub", "..", "cdrs.csv");
    const csv = "uuid,duration\nc1,10\n";
    const fetch = fakeFetch({ [`GET /api/v1/Account/${TEST_AUTH_ID}/cdr/export`]: textReply(200, csv, { "content-type": "text/csv" }) });
    mkdirSync(join(dir, "sub"));
    const r = await runCli(["cdr", "export", "--from", "7d", "--out", out, "--json"], { fetch: fetch.fetch });
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(dir, "cdrs.csv"), "utf8")).toBe(csv);
    expect(readdirSync(dir).sort()).toEqual(["cdrs.csv", "sub"]);
    const again = await runCli(["cdr", "export", "--from", "7d", "--out", out], { fetch: fetch.fetch });
    expect(again.code).toBe(2);
  });

  it("skills install --only cannot name a path, and --dir writes only inside that folder", async () => {
    const root = tmp("vobiz-skills-");
    const dir = join(root, "proj", ".claude", "skills");
    for (const only of ["../evil", "../../etc", "/abs", "vobiz-api/../../x"]) {
      const r = await runCli(["skills", "install", "--dir", dir, "--only", only, "--yes"]);
      expect(r.code, only).toBe(2);
    }
    expect(existsSync(dir)).toBe(false);
    const r = await runCli(["skills", "install", "--dir", join(root, "proj", "x", "..", ".claude", "skills"), "--only", "vobiz-api", "--yes", "--json"]);
    expect(r.code, r.err).toBe(0);
    for (const row of r.json<{ path: string }[]>()) expect(row.path.startsWith(dir + sep)).toBe(true);
    expect(readdirSync(join(root, "proj"))).toEqual([".claude"]);
    expect(readdirSync(dir)).toEqual(["vobiz-api"]);
  });

  it("`vobiz api` only accepts a path, so the token never goes to another host", async () => {
    for (const p of ["https://evil.example.com/x", "//evil.example.com/x", "evil.example.com/x", "@evil.example.com/x"]) {
      const api = fakeFetch();
      const r = await runCli(["api", "GET", p], { fetch: api.fetch });
      expect(r.code, p).toBe(2);
      expect(api.calls).toHaveLength(0);
    }
  });

  it("--base-url must be https unless it is localhost", async () => {
    const api = specFake();
    expect((await runCli(["--base-url", "http://api.example.com", "numbers", "list"], { fetch: api.fetch })).code).toBe(2);
    expect((await runCli(["--sms-base-url", "http://api.example.com", "sms", "messages", "list"], { fetch: api.fetch })).code).toBe(2);
    expect(api.calls).toHaveLength(0);
    const ok = await runCli(["--base-url", "http://localhost:9999", "numbers", "list", "--dry-run", "--json"], { fetch: api.fetch });
    expect(ok.code).toBe(0);
  });
});

describe("local servers bind to 127.0.0.1 by default", () => {
  const program = buildProgram(makeCtx().ctx);
  for (const words of [["xml", "serve"], ["webhooks", "listen"]]) {
    it(`${words.join(" ")} --host defaults to 127.0.0.1`, () => {
      const host = findCommand(program, words)!.options.find((o) => o.long === "--host")!;
      expect(host.defaultValue).toBe("127.0.0.1");
    });
  }

  it("xml serve's server listens on loopback only", async () => {
    const dir = tmp("vobiz-xml-");
    const file = join(dir, "a.xml");
    writeFileSync(file, "<Response><Hangup/></Response>");
    const t = makeCtx();
    const s = await startXmlServer(t.ctx, file, { port: 0, host: "127.0.0.1" });
    try {
      expect((s.server.address() as AddressInfo).address).toBe("127.0.0.1");
      expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
    } finally {
      await s.close();
    }
  });

  it("webhooks listen's server listens on loopback only", async () => {
    const t = makeCtx();
    const s = await startWebhookListener(t.ctx, { port: 0, host: "127.0.0.1" });
    try {
      expect((s.server.address() as AddressInfo).address).toBe("127.0.0.1");
    } finally {
      await s.close();
    }
  });

  it("calls create --serve binds the answer server to 127.0.0.1", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "commands", "calls.ts"), "utf8");
    expect(src).toMatch(/server\.listen\(port, "127\.0\.0\.1"/);
    expect(src).not.toMatch(/listen\([^)]*0\.0\.0\.0/);
  });
});
