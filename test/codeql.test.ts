/**
 * Regressions for the CodeQL alerts fixed before the public release: inputs that made a backtracking regex
 * polynomial now take one linear pass, and file uploads read size and bytes from one open descriptor.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VobizClient } from "../src/core/client.js";
import { isEmail } from "../src/commands/recordings.js";
import { fileForm } from "../src/commands/sms/shared.js";
import { SMS_BASE, TEST_AUTH_ID, TEST_AUTH_TOKEN, VOICE_BASE, fakeFetch } from "./helpers.js";

const client = () => new VobizClient({ creds: { authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN, voiceBaseUrl: VOICE_BASE, smsBaseUrl: SMS_BASE, source: "env" }, fetch: fakeFetch().fetch });

describe("path templates (js/polynomial-redos)", () => {
  it("fills placeholders exactly as before", () => {
    const c = client();
    expect(c.fillPath("/Account/{auth_id}/Call/{call_uuid}/", { call_uuid: "a/b" })).toBe(`/Account/${TEST_AUTH_ID}/Call/a%2Fb/`);
    expect(c.fillPath("/x/{}/{id}", { id: "1" })).toBe("/x/{}/1");
    expect(c.fillPath("/x/{id", { id: "1" })).toBe("/x/{id");
    expect(c.fillPath("/x/{{id}", { "{id": "1" })).toBe("/x/1");
    expect(() => c.fillPath("/x/{id}", {})).toThrow(/Missing required path parameter "id"/);
  });

  it("stays linear on many repetitions of '{{|' with no closing brace", () => {
    const start = performance.now();
    expect(client().fillPath("{{|".repeat(50_000))).toBe("{{|".repeat(50_000));
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("recordings export --email (js/polynomial-redos)", () => {
  it("accepts and rejects the same addresses as before", () => {
    for (const ok of ["ops@example.com", "a.b+c@sub.example.co.in"]) expect(isEmail(ok)).toBe(true);
    for (const bad of ["ops", "ops@example", "@example.com", "ops@.com", "ops@example.", "a@b@c.com", "o ps@example.com"]) expect(isEmail(bad)).toBe(false);
  });

  it("stays linear on many repetitions of '!@!.'", () => {
    const start = performance.now();
    expect(isEmail("!@!.".repeat(50_000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("upload files (js/file-system-race)", () => {
  it("reads the size and the bytes of one file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-upload-"));
    const file = join(dir, "brand.pdf");
    writeFileSync(file, "12345");
    const { name, size } = fileForm("document", file, { kind: "x" });
    expect(name).toBe("brand.pdf");
    expect(size).toBe(5);
  });

  it("refuses a missing file or a folder with a usage error", () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-upload-"));
    expect(() => fileForm("document", join(dir, "missing.pdf"))).toThrow(/Cannot read/);
    expect(() => fileForm("document", dir)).toThrow(/Cannot read/);
  });
});
