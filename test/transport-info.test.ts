import { describe, expect, it } from "vitest";
import { fetchLatestVersion, isPlainVersion } from "../src/core/update.js";
import { fakeFetch, runCli } from "./helpers.js";

describe("transport input checks", () => {
  it("CR/LF or spaces in credentials are invalid_input, not network_error, and nothing is sent", async () => {
    const api = fakeFetch({ "GET /api/v1/auth/me": { name: "x" } });
    for (const env of [{ VOBIZ_AUTH_TOKEN: "x\r\nX-Injected: 1" }, { VOBIZ_AUTH_ID: "MA_X\nY" }, { VOBIZ_AUTH_TOKEN: "with space" }]) {
      const r = await runCli(["api", "GET", "/api/v1/auth/me"], { fetch: api.fetch, env });
      expect(r.code).toBe(2);
      expect(r.err).toContain("invalid_input");
    }
    expect(api.calls).toHaveLength(0);
  });

  it("the update notice only accepts a plain version from the registry", async () => {
    expect(isPlainVersion("1.2.3")).toBe(true);
    expect(isPlainVersion("1.2.3-beta.1")).toBe(true);
    expect(isPlainVersion("9.9.9\x1b]0;pwned\x07")).toBe(false);
    const evil = fakeFetch({ "GET /-/package/%40vobiz%2Fcli/dist-tags": { latest: "9.9.9\x1b[2J" }, "GET /-/package/@vobiz/cli/dist-tags": { latest: "9.9.9\x1b[2J" } });
    expect(await fetchLatestVersion(evil.fetch)).toBeUndefined();
    const good = fakeFetch({ "GET /-/package/%40vobiz%2Fcli/dist-tags": { latest: "9.9.9" }, "GET /-/package/@vobiz/cli/dist-tags": { latest: "9.9.9" } });
    expect(await fetchLatestVersion(good.fetch)).toBe("9.9.9");
  });

  it("doctor warns about NODE_TLS_REJECT_UNAUTHORIZED=0", async () => {
    const r = await runCli(["doctor", "--offline", "--json"], { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
    const checks = r.json<{ checks?: { check: string; status: string }[] } | { check: string; status: string }[]>();
    const list = Array.isArray(checks) ? checks : (checks.checks ?? []);
    expect(list.find((c) => c.check === "tls")).toMatchObject({ status: "warn" });
  });
});

describe("docs URL handling", async () => {
  const { docsUrl } = await import("../src/agent/docs-mcp.js");
  it("docs open upgrades an http docs URL to https", () => {
    expect(docsUrl("http://www.vobiz.ai/docs/xml/gather")).toBe("https://www.vobiz.ai/docs/xml/gather");
  });
});
