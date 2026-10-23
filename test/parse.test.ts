import { describe, expect, it } from "vitest";
import { parsePort } from "../src/agent/http.js";
import { parseIntStrict, tryParseIntStrict } from "../src/core/parse.js";
import { runCli } from "./helpers.js";

describe("strict integer parsing", () => {
  it("accepts plain decimal digits within bounds only", () => {
    expect(tryParseIntStrict("42")).toBe(42);
    for (const bad of ["0x50", "0b11", "1e3", " 7 ", "", "7.0", "+7", "-1", "99999999999999999"]) expect(tryParseIntStrict(bad), bad).toBeUndefined();
    expect(tryParseIntStrict("-3", { min: -5 })).toBe(-3);
    expect(() => parseIntStrict("51", "--limit", { min: 1, max: 50 })).toThrow(/from 1 to 50/);
    expect(() => parsePort("0x50", 0)).toThrow();
    expect(parsePort("8080", 0)).toBe(8080);
  });
  it("numeric flags reject hex and exponent forms", async () => {
    expect((await runCli(["docs", "search", "gather", "--limit", "0x5"])).code).toBe(2);
    expect((await runCli(["trunks", "list", "--limit", "1e3"])).code).toBe(2);
    expect((await runCli(["trunks", "list", "--limit", "10000001"])).code).toBe(2);
    expect((await runCli(["numbers", "health", "+919876543210", "--days", "0x1e"])).code).toBe(2);
  });
});
