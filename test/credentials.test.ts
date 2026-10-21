import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/core/config.js";
import { resolveCredentials, profileName } from "../src/core/credentials.js";
import { VobizError } from "../src/core/errors.js";

const store = () => new ConfigStore(mkdtempSync(join(tmpdir(), "vobiz-cred-")));
const profile = (id: string) => ({ authId: id, authToken: "PROFILE_TOKEN" });

describe("resolveCredentials", () => {
  it("prefers flags over env over profile", () => {
    const s = store();
    s.setProfile("default", profile("MA_PROFILE"));
    const env = { VOBIZ_AUTH_ID: "MA_ENV", VOBIZ_AUTH_TOKEN: "ENV_TOKEN_1" };
    expect(resolveCredentials({ authId: "MA_FLAG", authToken: "FLAG_TOKEN" }, s, env)).toMatchObject({ authId: "MA_FLAG", source: "flags" });
    expect(resolveCredentials({}, s, env)).toMatchObject({ authId: "MA_ENV", source: "env" });
    expect(resolveCredentials({}, s, {})).toMatchObject({ authId: "MA_PROFILE", source: "profile", profile: "default" });
  });

  it("picks the profile from --profile, then VOBIZ_PROFILE, then the configured default", () => {
    const s = store();
    s.setProfile("a", profile("MA_A"));
    s.setProfile("b", profile("MA_B"));
    s.setProfile("c", profile("MA_C"));
    s.patchSettings({ defaultProfile: "c" });
    expect(profileName({ profile: "a" }, s, { VOBIZ_PROFILE: "b" })).toBe("a");
    expect(profileName({}, s, { VOBIZ_PROFILE: "b" })).toBe("b");
    expect(profileName({}, s, {})).toBe("c");
    expect(resolveCredentials({}, s, {}).authId).toBe("MA_C");
  });

  it("rejects half-set flags or env", () => {
    const s = store();
    expect(() => resolveCredentials({ authId: "MA_X" }, s, {})).toThrow(VobizError);
    expect(() => resolveCredentials({}, s, { VOBIZ_AUTH_ID: "MA_X" })).toThrow(/both/);
  });

  it("reports missing credentials with a login hint", () => {
    try {
      resolveCredentials({ profile: "ci" }, store(), {});
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as VobizError).kind).toBe("missing_credentials");
      expect((e as VobizError).message).toContain("vobiz login --profile ci");
    }
  });

  it("applies base URL overrides from flags, env, then the profile", () => {
    const s = store();
    s.setProfile("default", { ...profile("MA_P"), voiceBaseUrl: "https://profile.example.com" });
    expect(resolveCredentials({}, s, {}).voiceBaseUrl).toBe("https://profile.example.com");
    expect(resolveCredentials({}, s, { VOBIZ_BASE_URL: "https://env.example.com" }).voiceBaseUrl).toBe("https://env.example.com");
    expect(resolveCredentials({ baseUrl: "https://flag.example.com" }, s, { VOBIZ_BASE_URL: "https://env.example.com" }).voiceBaseUrl).toBe(
      "https://flag.example.com",
    );
  });
});
