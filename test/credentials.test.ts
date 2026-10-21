import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/core/config.js";
import { assertSecureBaseUrl, resolveCredentials, profileName } from "../src/core/credentials.js";
import { runCli } from "./helpers.js";
import { writeFileSync } from "node:fs";
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
    s.setProfile("default", { ...profile("MA_P"), voiceBaseUrl: "https://profile.vobiz.ai" });
    expect(resolveCredentials({}, s, {}).voiceBaseUrl).toBe("https://profile.vobiz.ai");
    expect(resolveCredentials({}, s, { VOBIZ_BASE_URL: "https://env.vobiz.ai" }).voiceBaseUrl).toBe("https://env.vobiz.ai");
    expect(resolveCredentials({ baseUrl: "https://flag.vobiz.ai" }, s, { VOBIZ_BASE_URL: "https://env.vobiz.ai" }).voiceBaseUrl).toBe(
      "https://flag.vobiz.ai",
    );
  });

  it("requires https base URLs from flags, env and the profile; http only for localhost with the opt-in", async () => {
    const s = store();
    expect(() => resolveCredentials({}, s, { VOBIZ_AUTH_ID: "MA_E", VOBIZ_AUTH_TOKEN: "ENV_TOKEN_1", VOBIZ_BASE_URL: "http://evil.example" })).toThrow(/VOBIZ_BASE_URL must use https/);
    expect(() => resolveCredentials({}, s, { VOBIZ_AUTH_ID: "MA_E", VOBIZ_AUTH_TOKEN: "ENV_TOKEN_1", VOBIZ_SMS_BASE_URL: "http://evil.example/sms" })).toThrow(/VOBIZ_SMS_BASE_URL/);
    expect(() => assertSecureBaseUrl("http://localhost:8080", "--base-url", {})).toThrow(/VOBIZ_ALLOW_INSECURE_BASE_URL=1/);
    expect(assertSecureBaseUrl("http://127.0.0.1:8080", "--base-url", { VOBIZ_ALLOW_INSECURE_BASE_URL: "1" })).toBe("http://127.0.0.1:8080");
    expect(() => assertSecureBaseUrl("http://evil.example", "--base-url", { VOBIZ_ALLOW_INSECURE_BASE_URL: "1" })).toThrow(/must use https/);
    expect(() => assertSecureBaseUrl("ftp://x", "--base-url", {})).toThrow(VobizError);

    // A localhost profile URL is a valid file shape but still needs the opt-in to be used.
    s.setProfile("default", { ...profile("MA_P"), voiceBaseUrl: "http://localhost:9000" });
    expect(() => resolveCredentials({}, s, {})).toThrow(/voiceBaseUrl uses http/);
    expect(resolveCredentials({}, s, { VOBIZ_ALLOW_INSECURE_BASE_URL: "1" }).voiceBaseUrl).toBe("http://localhost:9000");

    // A non-local http URL in credentials.json is rejected by the schema.
    writeFileSync(s.credentialsPath, JSON.stringify({ version: 1, profiles: { default: { ...profile("MA_P"), smsBaseUrl: "http://evil.example" } } }));
    expect(() => s.profiles()).toThrow(/smsBaseUrl must use https/);
  });

  it("the CLI exits 2 for an http base URL from the env and login does not save one", async () => {
    const r = await runCli(["account", "show"], { env: { VOBIZ_BASE_URL: "http://evil.example" } });
    expect(r.code).toBe(2);
    expect(r.err).toContain("VOBIZ_BASE_URL must use https");
    const flag = await runCli(["account", "show", "--sms-base-url", "http://localhost:1"], {});
    expect(flag.code).toBe(2);
    const login = await runCli(["login", "--with-token"], { loggedOut: true, stdin: "MA_XXXXXXXX:YOUR_AUTH_TOKEN", env: { VOBIZ_BASE_URL: "http://evil.example" } });
    expect(login.code).toBe(2);
    expect(login.store.getProfile("default")).toBeUndefined();
  });
});
