import { describe, expect, it } from "vitest";
import { fakeFetch, runCli } from "./helpers.js";

describe("vobiz feedback", () => {
  it("prints a prefilled issue URL without any request when stdout is not a terminal", async () => {
    const api = fakeFetch();
    const r = await runCli(["feedback", "-m", "calls watch should show the hangup cause"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    const url = new URL(r.json().url);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/vobiz-ai/Vobiz-CLI/issues/new");
    expect(url.searchParams.get("title")).toBe("calls watch should show the hangup cause");
    expect(url.searchParams.get("body")).toContain("calls watch should show the hangup cause");
    expect(url.searchParams.get("body")).toContain("vobiz CLI ");
    expect(url.searchParams.get("body")).not.toContain("MA_XXXXXXXX");
    expect(url.searchParams.get("body")).not.toContain("YOUR_AUTH_TOKEN");
    expect(r.opened).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });

  it("opens the browser on a terminal, unless --print", async () => {
    let r = await runCli(["feedback", "--title", "Bug"], { stdoutTTY: true });
    expect(r.opened).toHaveLength(1);
    expect(new URL(r.opened[0]).searchParams.get("title")).toBe("Bug");
    r = await runCli(["feedback", "--print", "--output", "plain"], { stdoutTTY: true });
    expect(r.opened).toEqual([]);
    expect(r.out).toContain("issues/new?");
  });

  it("gives {url, opened} with --json and rejects an empty message", async () => {
    let r = await runCli(["feedback", "--json"]);
    expect(r.json()).toMatchObject({ opened: false });
    expect(r.json().url).toContain("labels=feedback");
    r = await runCli(["feedback", "-m", "  "]);
    expect(r.code).toBe(2);
  });
});
