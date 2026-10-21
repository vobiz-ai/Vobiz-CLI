import { describe, expect, it } from "vitest";
import { browserAllowed } from "../src/core/context.js";
import { runCli } from "./helpers.js";

describe("browser launching", () => {
  it("is refused in tests, CI, pipes and with VOBIZ_NO_BROWSER", () => {
    expect(browserAllowed({}, false)).toBe(false);
    expect(browserAllowed({ CI: "1" }, true)).toBe(false);
    expect(browserAllowed({ VOBIZ_NO_BROWSER: "1" }, true)).toBe(false);
    expect(browserAllowed({ VITEST: "true" }, true)).toBe(false);
    expect(browserAllowed({}, true)).toBe(true);
  });
  it("docs open prints the URL and never spawns a browser when not interactive", async () => {
    const r = await runCli(["docs", "open", "xml/gather"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("https://www.vobiz.ai/docs/xml/gather");
  });
});
