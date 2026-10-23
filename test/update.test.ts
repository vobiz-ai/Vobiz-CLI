import { describe, expect, it } from "vitest";
import { checkForUpdate, compareVersions } from "../src/core/update.js";
import { CLI_VERSION } from "../src/core/version.js";
import { fakeFetch, makeCtx } from "./helpers.js";

const registry = (latest: string) => fakeFetch({ "GET /-/package/@vobiz%2fcli/dist-tags": { latest } });

describe("update notifier", () => {
  it("compares versions", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("v1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  it("is off in CI, with --no-update-check, VOBIZ_NO_UPDATE_CHECK, or off a TTY", async () => {
    const api = registry("99.0.0");
    expect(await checkForUpdate(makeCtx({ fetch: api.fetch, stderrTTY: true }).ctx)).toBeUndefined(); // CI=1 by default
    expect(await checkForUpdate(makeCtx({ fetch: api.fetch, stderrTTY: true, env: { CI: "" }, flags: { updateCheck: false } }).ctx)).toBeUndefined();
    expect(await checkForUpdate(makeCtx({ fetch: api.fetch, stderrTTY: true, env: { CI: "", VOBIZ_NO_UPDATE_CHECK: "1" } }).ctx)).toBeUndefined();
    expect(await checkForUpdate(makeCtx({ fetch: api.fetch, stderrTTY: false, env: { CI: "" } }).ctx)).toBeUndefined();
    expect(api.calls).toHaveLength(0);
  });

  it("checks once a day and caches the answer", async () => {
    const api = registry("99.0.0");
    const t = makeCtx({ fetch: api.fetch, stderrTTY: true, env: { CI: "" } });
    expect(await checkForUpdate(t.ctx)).toContain(`${CLI_VERSION} -> 99.0.0`);
    expect(await checkForUpdate(t.ctx)).toContain("99.0.0");
    expect(api.calls).toHaveLength(1);
    expect(t.store.settings().latestKnownVersion).toBe("99.0.0");
  });

  it("says nothing when up to date", async () => {
    const t = makeCtx({ fetch: registry(CLI_VERSION).fetch, stderrTTY: true, env: { CI: "" } });
    expect(await checkForUpdate(t.ctx)).toBeUndefined();
  });
});
