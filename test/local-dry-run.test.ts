import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { TEST_AUTH_ID, TEST_AUTH_TOKEN, fakeFetch, makeCtx } from "./helpers.js";
import { run } from "../src/cli.js";

/** --dry-run on commands that write local files: a `[dry-run]` marker, the change on stdout, nothing written. */
function setup() {
  const t = makeCtx({ loggedOut: true, fetch: fakeFetch({}).fetch });
  t.store.setProfile("main", { authId: "MA_MAIN0000", authToken: "MAIN_TOKEN" });
  t.store.setProfile("staging", { authId: "MA_STAG0000", authToken: "STAG_TOKEN" });
  t.store.patchSettings({ defaultProfile: "main" });
  const snapshot = () => [t.store.settingsPath, t.store.credentialsPath].map((p) => (existsSync(p) ? readFileSync(p, "utf8") : ""));
  return { t, before: snapshot(), snapshot };
}

describe("--dry-run on local writes", () => {
  const cases: [string, string[], RegExp][] = [
    ["config set", ["config", "set", "telemetry", "true"], /\[dry-run\] would set telemetry = true/],
    ["config unset", ["config", "unset", "color"], /\[dry-run\] would reset color/],
    ["profiles use", ["profiles", "use", "staging"], /\[dry-run\] would make "staging" the default profile/],
    ["profiles rename", ["profiles", "rename", "staging", "stage2"], /\[dry-run\] would rename the profile "staging" to "stage2"/],
    ["profiles remove", ["profiles", "remove", "staging"], /\[dry-run\] Remove the saved profile "staging"/],
    ["logout", ["logout", "--profile", "staging"], /\[dry-run\] would remove "staging"/],
    ["logout --all", ["logout", "--all"], /\[dry-run\] Remove every saved profile/],
  ];
  for (const [name, argv, marker] of cases) {
    it(`${name} prints the marker and changes nothing`, async () => {
      const { t, before, snapshot } = setup();
      const code = await run([...argv, "--dry-run", "--json"], t.ctx);
      expect(code, t.stderr.text).toBe(0);
      expect(t.stderr.text).toMatch(marker);
      expect(snapshot()).toEqual(before);
    });
  }

  it("config set reports the change on stdout as dry_run", async () => {
    const { t } = setup();
    expect(await run(["config", "set", "telemetry", "true", "--dry-run", "--json"], t.ctx)).toBe(0);
    expect(JSON.parse(t.stdout.text)).toMatchObject({ dry_run: true, key: "telemetry", value: true });
    expect(t.store.settings().telemetry).toBeUndefined();
  });

  it("login --dry-run shows the verification request and saves nothing", async () => {
    const api = fakeFetch({ "GET /api/v1/auth/me": { name: "x" } });
    const t = makeCtx({ loggedOut: true, fetch: api.fetch, stdin: `${TEST_AUTH_ID}:${TEST_AUTH_TOKEN}` });
    expect(await run(["login", "--with-token", "--dry-run", "--json"], t.ctx)).toBe(0);
    expect(api.calls).toHaveLength(0);
    expect(t.stderr.text).toContain("[dry-run] would verify these credentials");
    expect(JSON.parse(t.stdout.text)).toMatchObject({ dry_run: true, method: "GET" });
    expect(t.stdout.text + t.stderr.text).not.toContain(TEST_AUTH_TOKEN);
    expect(t.store.profiles()).toEqual({});
  });
});
