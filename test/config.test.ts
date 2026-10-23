import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, configDir } from "../src/core/config.js";

const posix = process.platform !== "win32";

describe("ConfigStore", () => {
  it("writes credentials with mode 0600 inside a 0700 directory", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "vobiz-cfg-")), "nested");
    const s = new ConfigStore(dir);
    s.setProfile("default", { authId: "MA_XXXXXXXX", authToken: "YOUR_AUTH_TOKEN" });
    if (posix) {
      expect(statSync(s.credentialsPath).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(s.getProfile("default")?.authId).toBe("MA_XXXXXXXX");
  });

  it("writes atomically (no temp files left, previous content replaced whole)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-cfg-"));
    const s = new ConfigStore(dir);
    s.setProfile("a", { authId: "MA_A", authToken: "TOKEN_AAAA" });
    s.setProfile("b", { authId: "MA_B", authToken: "TOKEN_BBBB" });
    s.patchSettings({ defaultProfile: "a" });
    expect(readdirSync(dir).sort()).toEqual(["config.json", "credentials.json"]);
    expect(Object.keys(s.profiles())).toEqual(["a", "b"]);
    if (posix) expect(statSync(s.credentialsPath).mode & 0o777).toBe(0o600);
  });

  it("clears the default when that profile is removed", () => {
    const s = new ConfigStore(mkdtempSync(join(tmpdir(), "vobiz-cfg-")));
    s.setProfile("a", { authId: "MA_A", authToken: "TOKEN_AAAA" });
    s.patchSettings({ defaultProfile: "a" });
    expect(s.removeProfile("a")).toBe(true);
    expect(s.settings().defaultProfile).toBeUndefined();
    expect(s.removeProfile("a")).toBe(false);
  });

  it("reports a corrupt file instead of silently ignoring it", () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-cfg-"));
    writeFileSync(join(dir, "credentials.json"), "{nope");
    expect(() => new ConfigStore(dir).profiles()).toThrow(/not valid JSON/);
  });

  it("honours VOBIZ_CONFIG_DIR and XDG_CONFIG_HOME", () => {
    expect(configDir({ VOBIZ_CONFIG_DIR: "/x/vobiz" })).toBe("/x/vobiz");
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "vobiz"));
  });
});
