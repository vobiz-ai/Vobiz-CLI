/**
 * Error paths end to end: every ErrorKind's exit code, how API failures surface (kind, message, JSON shape),
 * transport failures (network, timeout) and when they become outcome_unknown, input validation, and the
 * confirmation gate for one write per command group.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT, VobizError, isRetryable, type ErrorKind } from "../src/core/errors.js";
import { hintFor } from "../src/core/output.js";
import { TEST_AUTH_ID, TEST_AUTH_TOKEN, fakeFetch, hang, networkError, reply, runCli, textReply } from "./helpers.js";
import { specFake } from "./spec-fake.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;

const DOCUMENTED: Record<ErrorKind, number> = {
  internal_error: 1,
  backend_error: 1,
  unexpected_response: 1,
  service_unavailable: 1,
  invalid_input: 2,
  unsupported: 2,
  missing_credentials: 3,
  auth_failed: 3,
  forbidden: 3,
  account_suspended: 3,
  not_found: 4,
  rate_limited: 5,
  insufficient_balance: 5,
  confirmation_required: 6,
  not_allowed: 6,
  outcome_unknown: 7,
  timeout: 8,
  network_error: 8,
};
const KINDS = Object.keys(DOCUMENTED) as ErrorKind[];

describe("every ErrorKind has its documented exit code", () => {
  for (const kind of KINDS) {
    it(`${kind} -> ${DOCUMENTED[kind]}`, () => {
      expect(EXIT[kind]).toBe(DOCUMENTED[kind]);
      const e = new VobizError(kind, "m", 418);
      expect(e.exitCode).toBe(DOCUMENTED[kind]);
      expect(e.toJSON()).toEqual({ error: kind, message: "m", status: 418, retryable: isRetryable(kind) });
    });
  }

  it("only transient kinds are retryable", () => {
    expect(KINDS.filter(isRetryable).sort()).toEqual(["backend_error", "network_error", "rate_limited", "service_unavailable", "timeout"]);
    expect(isRetryable("outcome_unknown")).toBe(false);
  });

  it("`vobiz help exit-codes` documents every code 0-8 and every kind", async () => {
    const r = await runCli(["help", "exit-codes"]);
    for (let code = 0; code <= 8; code++) expect(r.out).toMatch(new RegExp(`^\\s*${code}\\s`, "m"));
    for (const kind of KINDS) expect(r.out, kind).toContain(kind);
  });

  it("hints exist for the kinds a user can act on", () => {
    for (const kind of ["auth_failed", "rate_limited", "insufficient_balance", "timeout", "network_error", "outcome_unknown", "confirmation_required"] as ErrorKind[])
      expect(hintFor(kind), kind).toBeTruthy();
  });
});

describe("API errors become the right kind, message and JSON shape", () => {
  const statuses: [number, ErrorKind, number][] = [
    [400, "invalid_input", 2],
    [401, "auth_failed", 3],
    [402, "insufficient_balance", 5],
    [403, "forbidden", 3],
    [404, "not_found", 4],
    [409, "unexpected_response", 1],
    [422, "invalid_input", 2],
    [423, "account_suspended", 3],
    [429, "rate_limited", 5],
    [500, "backend_error", 1],
    [502, "service_unavailable", 1],
    [503, "service_unavailable", 1],
    [504, "service_unavailable", 1],
  ];
  // Commands that read through different code paths: raw api, voice list, voice get, sms list, account.
  const commands: { argv: string[]; route: string }[] = [
    { argv: ["api", "GET", "/api/v1/auth/me"], route: "GET /api/v1/auth/me" },
    { argv: ["numbers", "list"], route: `GET ${A}/numbers` },
    { argv: ["trunks", "get", "t1"], route: "GET /api/v1/account/MA_XXXXXXXX/trunks/t1" },
    { argv: ["sms", "messages", "list"], route: "GET /messages" },
    { argv: ["account", "show"], route: "GET /api/v1/auth/me" },
    { argv: ["cdr", "recent"], route: `GET ${A}/cdr/recent` },
  ];

  for (const [status, kind, code] of statuses) {
    for (const c of commands) {
      it(`${status} on \`${c.argv.join(" ")}\` -> ${kind} (exit ${code})`, async () => {
        const body = { message: `backend says ${status}` };
        const fetch = specFake({ answer: () => reply(status, body) }).fetch;
        const text = await runCli(c.argv, { fetch });
        expect(text.code).toBe(code);
        expect(text.out).toBe("");
        expect(text.err).toContain(`vobiz: ${kind}: backend says ${status}`);
        const json = await runCli([...c.argv, "--output", "json"], { fetch });
        expect(json.code).toBe(code);
        const err = JSON.parse(json.err.trim().split("\n").pop()!);
        expect(err).toEqual({ error: kind, message: `backend says ${status}`, status, retryable: isRetryable(kind), hint: hintFor(kind) ?? null });
      });
    }
  }

  const bodies: [string, unknown, string][] = [
    ["message", { message: "m1" }, "m1"],
    ["error string", { error: "m2" }, "m2"],
    ["detail", { detail: "m3" }, "m3"],
    ["error_description", { error_description: "m4" }, "m4"],
    ["nested error.message", { error: { message: "m5" } }, "m5"],
    ["errors[] with field", { errors: [{ field: "to", message: "invalid" }] }, "to: invalid"],
    ["errors[] of strings", { errors: ["first problem", "second"] }, "first problem"],
    ["empty body", undefined, "HTTP 422"],
  ];
  for (const [name, body, message] of bodies) {
    it(`extracts the message from ${name}`, async () => {
      const r = await runCli(["api", "GET", "/api/v1/auth/me", "--json"], { fetch: fakeFetch({ "GET /api/v1/auth/me": reply(422, body) }).fetch });
      expect(r.code).toBe(2);
      expect(JSON.parse(r.err).message).toBe(message);
    });
  }

  it("a plain-text error body becomes the message, truncated", async () => {
    const r = await runCli(["api", "GET", "/api/v1/auth/me", "--json"], { fetch: fakeFetch({ "GET /api/v1/auth/me": textReply(500, "x".repeat(2000)) }).fetch });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).message).toHaveLength(300);
  });

  it("a redirect is unexpected_response and is not followed", async () => {
    const api = fakeFetch({ "GET /api/v1/auth/me": reply(302, undefined, { location: "https://evil.example.com/" }) });
    const r = await runCli(["api", "GET", "/api/v1/auth/me"], { fetch: api.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("unexpected_response");
    expect(api.calls).toHaveLength(1);
  });

  it("a non-JSON 200 is unexpected_response", async () => {
    const r = await runCli(["numbers", "list"], { fetch: fakeFetch({ [`GET ${A}/numbers`]: textReply(200, "<html>proxy</html>") }).fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("unexpected_response");
  });

  it("error details never echo secrets from the body", async () => {
    const r = await runCli(["api", "GET", "/api/v1/auth/me", "--json", "--verbose"], {
      fetch: fakeFetch({ "GET /api/v1/auth/me": reply(500, { message: "boom", auth_token: "LEAKED-TOKEN", password: "LEAKED-PW" }) }).fetch,
    });
    expect(r.out + r.err).not.toContain("LEAKED");
  });
});

describe("transport failures", () => {
  afterEach(() => void vi.useRealTimers());

  const reads: string[][] = [
    ["api", "GET", "/api/v1/auth/me"],
    ["numbers", "list"],
    ["calls", "list"],
    ["sms", "messages", "list"],
    ["account", "balance"],
    ["recordings", "list"],
    ["cdr", "list"],
    ["trunks", "list"],
    ["sub-accounts", "list"],
    ["partner", "me"],
  ];
  for (const argv of reads) {
    it(`network error on read \`${argv.join(" ")}\` -> network_error (8), never outcome_unknown`, async () => {
      const r = await runCli([...argv, "--json"], { fetch: specFake({ answer: () => networkError() }).fetch });
      expect(r.code).toBe(8);
      expect(JSON.parse(r.err.trim().split("\n").pop()!)).toMatchObject({ error: "network_error", retryable: true, status: null });
    });
  }

  it("a hung read times out after --timeout with exit 8 (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = runCli(["numbers", "list", "--timeout", "5", "--json"], { fetch: specFake({ answer: () => hang() }).fetch });
    await vi.advanceTimersByTimeAsync(5_001);
    const r = await p;
    expect(r.code).toBe(8);
    expect(JSON.parse(r.err)).toMatchObject({ error: "timeout", retryable: true });
    expect(JSON.parse(r.err).message).toContain("5s");
  });

  it("VOBIZ_TIMEOUT sets the timeout too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = runCli(["account", "balance", "--json"], { fetch: specFake({ answer: () => hang() }).fetch, env: { VOBIZ_TIMEOUT: "2" } });
    await vi.advanceTimersByTimeAsync(2_001);
    expect((await p).code).toBe(8);
  });

  const writes: { argv: string[]; env?: NodeJS.ProcessEnv }[] = [
    { argv: ["calls", "create", "--to", "+919876543210", "--from", "+918012345678", "--answer-url", "https://e.com/a"] },
    { argv: ["calls", "hangup", "c1"] },
    { argv: ["calls", "dtmf", "c1", "--digits", "12"] },
    { argv: ["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hi"] },
    { argv: ["numbers", "release", "+919876543210"] },
    { argv: ["recordings", "delete", "r1"] },
    { argv: ["trunks", "delete", "t1"] },
    { argv: ["apps", "delete", "a1"] },
    { argv: ["conferences", "end-all"] },
    { argv: ["api", "POST", "/api/v1/x", "--body", "{}"] },
    { argv: ["api", "DELETE", "/api/v1/x"] },
  ];
  for (const w of writes) {
    it(`network error on write \`${w.argv.slice(0, 3).join(" ")}\` -> outcome_unknown (7)`, async () => {
      const api = specFake({ answer: (op) => (op.method === "GET" ? undefined : networkError()) });
      const raw = fakeFetch({ "POST /api/v1/x": networkError(), "DELETE /api/v1/x": networkError() });
      const fetch = w.argv[0] === "api" ? raw.fetch : api.fetch;
      const r = await runCli([...w.argv, "--yes", "--json"], { fetch, env: w.env });
      expect(r.code, r.err).toBe(7);
      const err = JSON.parse(r.err.trim().split("\n").pop()!);
      expect(err).toMatchObject({ error: "outcome_unknown", retryable: false });
      expect(err.hint).toContain("Do not retry blindly");
    });
  }

  it("a hung side-effecting write times out as outcome_unknown, not timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = specFake({ answer: (op) => (op.method === "GET" ? undefined : hang()) });
    const p = runCli(["calls", "hangup", "c1", "--yes", "--timeout", "3", "--json"], { fetch: api.fetch });
    await vi.advanceTimersByTimeAsync(3_001);
    const r = await p;
    expect(r.code).toBe(7);
    expect(JSON.parse(r.err.trim().split("\n").pop()!).error).toBe("outcome_unknown");
  });
});

describe("input validation (exit 2, nothing sent)", () => {
  const cases: [string, string[]][] = [
    ["invalid E.164 (numbers get)", ["numbers", "get", "hello"]],
    ["invalid E.164 (numbers release)", ["numbers", "release", "12ab"]],
    ["invalid E.164 (calls create --to)", ["calls", "create", "--to", "12", "--from", "+918012345678", "--answer-url", "https://e.com/a"]],
    ["invalid E.164 (sms send --to)", ["sms", "send", "--from", "+14155550100", "--to", "not-a-number", "--text", "Hi"]],
    ["invalid E.164 (sms opt-outs add)", ["sms", "opt-outs", "add", "abc"]],
    ["http answer URL", ["calls", "create", "--to", "+919876543210", "--from", "+918012345678", "--answer-url", "http://e.com/a"]],
    ["http callback URL", ["calls", "record", "start", "c1", "--callback-url", "http://e.com/cb"]],
    ["ws:// stream URL", ["calls", "stream", "start", "c1", "--url", "ws://e.com/ws"]],
    ["http play URL", ["conferences", "members", "play", "room", "1", "--url", "http://e.com/a.mp3"]],
    ["http --base-url", ["--base-url", "http://api.example.com", "numbers", "list"]],
    ["garbage --base-url", ["--base-url", "not a url", "numbers", "list"]],
    ["unknown enum --direction", ["cdr", "list", "--direction", "sideways"]],
    ["unknown enum --output", ["numbers", "list", "--output", "xml"]],
    ["unknown enum --format", ["calls", "record", "start", "c1", "--format", "ogg"]],
    ["unknown enum --trunk-direction", ["trunks", "create", "--name", "x", "--trunk-direction", "both"]],
    ["unknown enum --kyc-mode", ["sub-accounts", "create", "--name", "x", "--kyc-mode", "nope"]],
    ["unknown enum sms --type", ["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hi", "--type", "fax"]],
    ["missing --trunk", ["numbers", "assign", "+919876543210"]],
    ["missing --email", ["recordings", "export"]],
    ["missing --signature", ["webhooks", "verify", "--body", "x"]],
    ["missing --digits", ["calls", "dtmf", "c1"]],
    ["missing --to", ["calls", "create", "--from", "+918012345678", "--answer-url", "https://e.com/a"]],
    ["missing argument", ["trunks", "get"]],
    ["too many arguments", ["trunks", "get", "a", "b"]],
    ["unknown command", ["trunks", "explode"]],
    ["unknown option", ["numbers", "list", "--colour"]],
    ["conflict --answer-url and --say", ["calls", "create", "--to", "+919876543210", "--from", "+918012345678", "--answer-url", "https://e.com/a", "--say", "hi"]],
    ["conflict --hosted and --local", ["mcp", "config", "cursor", "--hosted", "--local"]],
    ["conflict --from and --age-days", ["recordings", "export", "--email", "a@example.com", "--from", "7d", "--age-days", "3"]],
    ["conflict --url and --body", ["webhooks", "verify", "--signature", "x", "--url", "https://e.com", "--nonce", "1", "--body", "x"]],
    ["--to without --from (cdr)", ["cdr", "list", "--to", "today"]],
    ["bad --timeout", ["--timeout", "0", "numbers", "list"]],
    ["huge --timeout", ["--timeout", "99999", "numbers", "list"]],
    ["bad email", ["recordings", "export", "--email", "nope"]],
    ["bad member id", ["conferences", "members", "mute", "room", "1;2"]],
    ["bad dtmf digits", ["calls", "dtmf", "c1", "--digits", "12x"]],
    ["bad --limit", ["recordings", "list", "--limit", "0"]],
    ["bad --name for mcp", ["mcp", "config", "cursor", "--name", "bad name!"]],
    ["unknown mcp client", ["mcp", "config", "notepad"]],
    ["unknown skill", ["skills", "install", "--only", "no-such-skill", "--dir", "/nonexistent-vobiz-test"]],
    ["xml build with nothing", ["xml", "build"]],
    ["api with a full URL", ["api", "GET", "https://evil.example.com/x"]],
    ["api with //host", ["api", "GET", "//evil.example.com/x"]],
    ["api body on GET", ["api", "GET", "/x", "--body", "{}"]],
  ];
  for (const [name, argv] of cases) {
    it(name, async () => {
      const api = specFake();
      const r = await runCli([...argv, "--yes"], { fetch: api.fetch, env: { HOME: mkdtempSync(join(tmpdir(), "vobiz-home-")) } });
      expect(r.code, r.err).toBe(2);
      expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/vobiz: (usage|invalid_input)/);
    });
  }

  it("invalid input prints JSON errors with --json", async () => {
    const r = await runCli(["numbers", "get", "hello", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.err)).toMatchObject({ error: "invalid_input", retryable: false, status: null });
  });
});

describe("writes refuse without --yes when stdin is not a terminal (exit 6, nothing sent)", () => {
  const writes: string[][] = [
    ["account", "channel-subscriptions", "create", "--type", "cps", "--quantity", "1"],
    ["calls", "create", "--to", "+919876543210", "--from", "+918012345678", "--answer-url", "https://e.com/a"],
    ["calls", "hangup", "c1"],
    ["calls", "record", "start", "c1"],
    ["calls", "speak", "c1", "--text", "Hi"],
    ["calls", "play", "c1", "--url", "https://e.com/a.mp3"],
    ["calls", "stream", "start", "c1", "--url", "wss://e.com/ws"],
    ["conferences", "end", "room"],
    ["conferences", "end-all"],
    ["conferences", "members", "mute", "room", "all"],
    ["conferences", "record", "start", "room"],
    ["recordings", "delete", "r1"],
    ["recordings", "export", "--email", "ops@example.com"],
    ["numbers", "buy", "+14155550101"],
    ["numbers", "release", "+919876543210"],
    ["numbers", "cancel-release", "+919876543210"],
    ["numbers", "assign", "+919876543210", "--trunk", "t1"],
    ["numbers", "unassign", "+919876543210"],
    ["numbers", "assign-subaccount", "+919876543210", "--sub-account", "SA_XXXXXXXX"],
    ["trunks", "create", "--name", "pbx", "--trunk-direction", "outbound"],
    ["trunks", "update", "t1", "--name", "pbx2"],
    ["trunks", "delete", "t1"],
    ["trunks", "credentials", "create", "--username", "u1", "--password", "P4ssw0rd!x"],
    ["trunks", "ip-acl", "create", "--name", "office", "--ip-address", "203.0.113.10"],
    ["trunks", "origination-uris", "delete", "u1"],
    ["apps", "create", "--app-name", "ivr", "--answer-url", "https://e.com/a", "--answer-method", "POST"],
    ["apps", "delete", "a1"],
    ["endpoints", "create", "--username", "alice", "--password", "P4ssw0rd!x", "--alias", "Alice", "--application", "12345"],
    ["endpoints", "delete", "e1"],
    ["sub-accounts", "create", "--name", "Acme"],
    ["sub-accounts", "delete", "SA_XXXXXXXX"],
    ["sub-accounts", "kyc", "verify-pan", "SA_XXXXXXXX", "--pan", "ABCDE1234F"],
    ["partner", "kyc-sessions", "revoke", "s1"],
    ["partner", "accounts", "transfer-balance", "MA_CUSTOMER1", "--amount", "10", "--currency", "INR"],
    ["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hi"],
    ["sms", "opt-outs", "add", "+14155550123"],
    ["sms", "webhooks", "delete", "w1"],
    ["sms", "broadcasts", "delete", "b1"],
    ["sms", "numbers", "release", "+14155550100"],
    ["sms", "10dlc", "brands", "delete", "br1"],
    ["sms", "10dlc", "campaigns", "delete", "cp1"],
    ["api", "POST", "/api/v1/x", "--body", "{}"],
    ["api", "DELETE", "/api/v1/x"],
  ];
  for (const argv of writes) {
    it(argv.slice(0, 3).join(" "), async () => {
      const api = specFake();
      const r = await runCli(argv, { fetch: api.fetch });
      expect(r.code, r.err).toBe(6);
      expect(r.err).toContain("confirmation_required");
      expect(api.calls.filter((c) => c.method !== "GET"), "only reads before the gate").toHaveLength(0);
      const tty = await runCli(argv, { fetch: api.fetch, stdinTTY: true, prompts: { confirm: false } });
      expect(tty.code, "declined prompt").toBe(6);
      expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    });
  }

  it("VOBIZ_YES=1 counts as --yes", async () => {
    const api = specFake();
    const r = await runCli(["calls", "hangup", "c1", "--json"], { fetch: api.fetch, env: { VOBIZ_YES: "1" } });
    expect(r.code, r.err).toBe(0);
    expect(api.last().method).toBe("DELETE");
  });

  it("missing credentials beat the confirmation gate only when a request is needed", async () => {
    const r = await runCli(["calls", "hangup", "c1", "--yes"], { loggedOut: true });
    expect(r.code).toBe(3);
    expect(r.err).toContain("missing_credentials");
    expect(r.err).not.toContain(TEST_AUTH_TOKEN);
  });
});
