import { describe, expect, it } from "vitest";
import { chmodSync } from "node:fs";
import { nodeCheck } from "../src/commands/doctor.js";
import { TEST_AUTH_ID, TEST_AUTH_TOKEN, fakeFetch, reply, runCli } from "./helpers.js";

describe("doctor", () => {
  it("checks the Node.js version", () => {
    expect(nodeCheck("22.12.0").status).toBe("ok");
    expect(nodeCheck("24.1.0").status).toBe("ok");
    expect(nodeCheck("22.11.1").status).toBe("fail");
    expect(nodeCheck("20.18.0").status).toBe("fail");
  });

  it("--offline makes no requests", async () => {
    const api = fakeFetch();
    const r = await runCli(["doctor", "--offline", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.calls).toHaveLength(0);
    expect(r.json<{ check: string }[]>().map((c) => c.check)).toContain("network");
  });

  it("checks reachability, clock skew and auth online", async () => {
    const date = new Date(Date.now() - 5 * 60_000).toUTCString();
    const api = fakeFetch({
      "GET /": reply(404, {}, { date }),
      "GET /api/v1/sms/": reply(404, {}, { date }),
      "GET /api/v1/auth/me": { name: "Test Account" },
    });
    const r = await runCli(["doctor", "--json"], { fetch: api.fetch });
    const checks = r.json<{ check: string; status: string }[]>();
    const by = Object.fromEntries(checks.map((c) => [c.check, c.status]));
    expect(by).toMatchObject({ "voice API": "ok", "messaging API": "ok", clock: "warn", auth: "ok" });
    expect(r.code).toBe(0);
  });

  it("fails on a credentials file readable by others, and on rejected credentials", async () => {
    const api = fakeFetch({ "GET /api/v1/auth/me": reply(401, { error: "bad" }) });
    const first = await runCli(["doctor", "--offline"], { loggedOut: true });
    first.store.setProfile("default", { authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN });
    if (process.platform !== "win32") {
      chmodSync(first.store.credentialsPath, 0o644);
      const r = await runCli(["doctor", "--offline", "--json"], { loggedOut: true, configDir: first.configDir });
      expect(r.code).toBe(1);
      expect(r.json<{ check: string; status: string }[]>().find((c) => c.check === "credentials file")?.status).toBe("fail");
    }
    const r2 = await runCli(["doctor", "--json"], { fetch: api.fetch });
    expect(r2.code).toBe(1);
  });
});
