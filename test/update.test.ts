import { describe, expect, it } from "vitest";
import { checkForUpdate, compareVersions } from "../src/core/update.js";
import { CLI_VERSION } from "../src/core/version.js";
import { fakeFetch, makeCtx } from "./helpers.js";

const registry = (latest: string) => fakeFetch({ "GET /-/package/%40vobiz%2Fcli/dist-tags": { latest } });

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

describe("detectInstallMethod", async () => {
  const { detectInstallMethod } = await import("../src/commands/update.js");
  const none = () => false;
  it("reports source for a git checkout, npm for node_modules, homebrew, npx and docker by path or env", () => {
    const checkout = (p: string) => p === "/work/Vobiz-CLI/.git" || p === "/work/Vobiz-CLI/package.json";
    expect(detectInstallMethod("/work/Vobiz-CLI/dist/index.js", {}, checkout)).toBe("source");
    expect(detectInstallMethod("/usr/lib/node_modules/@vobiz/cli/dist/index.js", {}, checkout)).toBe("npm");
    expect(detectInstallMethod("/opt/homebrew/Cellar/vobiz/0.1.1/libexec/dist/index.js", {}, none)).toBe("homebrew");
    expect(detectInstallMethod("/home/u/.npm/_npx/abc/node_modules/@vobiz/cli/dist/index.js", {}, none)).toBe("npx");
    expect(detectInstallMethod("/anything", { VOBIZ_DOCKER: "1" }, checkout)).toBe("docker");
    expect(detectInstallMethod("/work/unpacked/dist/index.js", {}, none)).not.toBe("source");
  });
});
