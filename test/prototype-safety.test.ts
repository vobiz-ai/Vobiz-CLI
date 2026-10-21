import { describe, expect, it } from "vitest";
import { applyAttr } from "../src/agent/xml.js";
import { parseQueryPairs } from "../src/commands/api.js";
import { getPath, project, queryPath } from "../src/core/output.js";
import { fakeFetch, runCli } from "./helpers.js";

describe("prototype safety (S3 #6, #11)", () => {
  it("--fields with __proto__ never pollutes Object.prototype", async () => {
    const api = fakeFetch({ "GET /api/v1/x": JSON.parse('{"meta":{"__proto__":{"isAdmin":true}}}') });
    const r = await runCli(["api", "GET", "/api/v1/x", "--fields", "meta.__proto__.isAdmin", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    const q = await runCli(["api", "GET", "/api/v1/x", "--query", "meta.__proto__", "--json"], { fetch: api.fetch });
    expect(q.code).toBe(0);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("path walking reads own properties only", () => {
    expect(getPath({ a: {} }, "a.constructor")).toBeUndefined();
    expect(getPath({ a: {} }, "a.toString")).toBeUndefined();
    expect(queryPath({ a: {} }, "a.constructor")).toBeUndefined();
    const p = project(JSON.parse('{"x":{"__proto__":{"y":1}}}'), ["x.__proto__.y", "toString"]) as Record<string, unknown>;
    expect(p).toEqual({});
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
  });

  it("--param and --attr reject prototype names; inherited names are not special", () => {
    for (const k of ["__proto__", "constructor", "prototype"]) {
      expect(() => parseQueryPairs([`${k}=1`])).toThrow(/cannot use/);
      expect(() => applyAttr({ type: "speak" } as never, `${k}=1`)).toThrow(/cannot use/);
    }
    expect(parseQueryPairs(["toString=1", "toString=2"])).toEqual({ toString: ["1", "2"] });
    expect(() => applyAttr({ type: "speak" } as never, "toString=1")).toThrow(/no attribute/);
  });

  it("--profile, profiles remove and config set handle prototype names", async () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      expect((await runCli(["--profile", name, "whoami"], { loggedOut: true })).code).toBe(2);
      expect((await runCli(["profiles", "remove", name, "--yes"], { loggedOut: true })).code).toBe(2);
    }
    const r = await runCli(["profiles", "remove", "toString", "--yes"], { loggedOut: true });
    expect(r.code).toBe(4);
    const c = await runCli(["config", "set", "toString", "x"]);
    expect(c.code).toBe(2);
    expect(c.err).toContain('Unknown setting "toString"');
  });
});
