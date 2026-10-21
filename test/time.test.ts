import { describe, expect, it } from "vitest";
import { parseRange, parseTime, toYmd } from "../src/core/time.js";
import { digitsOnly, toE164 } from "../src/core/phone.js";

const now = new Date(2026, 9, 22, 15, 30, 0); // 2026-10-22 15:30 local

describe("parseTime", () => {
  it("understands keywords", () => {
    expect(toYmd(parseTime("today", now))).toBe("2026-10-22");
    expect(parseTime("today", now).getHours()).toBe(0);
    expect(toYmd(parseTime("yesterday", now))).toBe("2026-10-21");
    expect(parseTime("now", now).getTime()).toBe(now.getTime());
  });
  it("understands relative durations", () => {
    expect(toYmd(parseTime("7d", now))).toBe("2026-10-15");
    expect(now.getTime() - parseTime("24h", now).getTime()).toBe(86_400_000);
    expect(now.getTime() - parseTime("30m", now).getTime()).toBe(1_800_000);
    expect(toYmd(parseTime("2w", now))).toBe("2026-10-08");
  });
  it("understands dates and ISO timestamps", () => {
    expect(toYmd(parseTime("2026-10-01", now))).toBe("2026-10-01");
    expect(parseTime("2026-10-01T10:00:00Z", now).toISOString()).toBe("2026-10-01T10:00:00.000Z");
  });
  it("rejects nonsense and impossible dates", () => {
    expect(() => parseTime("last tuesday", now)).toThrow(/Cannot read/);
    expect(() => parseTime("2026-02-30", now)).toThrow(/real calendar date/);
  });
  it("checks range order", () => {
    expect(() => parseRange("today", "7d", now)).toThrow(/after/);
    expect(parseRange("7d", "today", now).from).toBeInstanceOf(Date);
  });
});

describe("phone", () => {
  it("normalises to E.164", () => {
    expect(toE164("+91 98765-43210")).toBe("+919876543210");
    expect(toE164("0014155550100")).toBe("+14155550100");
    expect(digitsOnly("(415) 555-0100")).toBe("4155550100");
    expect(() => toE164("abc")).toThrow();
    expect(() => toE164("+0123")).toThrow();
  });
  it("+ travels as %2B in path segments", () => {
    expect(encodeURIComponent("+14155550100")).toBe("%2B14155550100");
  });
});

describe("toE164 strictness (S3 #8)", () => {
  it("rejects characters it would otherwise drop", () => {
    for (const bad of ["+1 415 555 0100 #2", "+1 415 555 0100 / 7", "+44 20 7946 0958 (×3)", "+91９876543210", "+91​98765٣ 43210", "+91+9876543210", "91 98765 43210+", "+1\t4155550100"])
      expect(() => toE164(bad), JSON.stringify(bad)).toThrow(/ASCII digits/);
  });
  it("still accepts the usual punctuation", () => {
    expect(toE164(" +1 (415) 555-0100 ")).toBe("+14155550100");
    expect(toE164("+91.98765.43210")).toBe("+919876543210");
  });
});

describe("time parsing bounds (S3 #13)", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  it("rejects absurd relative offsets instead of sending NaN", () => {
    expect(() => parseTime("99999999999999d", now)).toThrow(/too far/);
    expect(() => parseTime("36501d", now)).toThrow(/too far/);
    expect(parseTime("36500d", now).getTime()).toBe(now.getTime() - 36_500 * 86_400_000);
  });
  it("rejects ISO timestamps on days that do not exist", () => {
    expect(() => parseTime("2026-02-31T00:00:00Z", now)).toThrow(/real calendar date/);
    expect(() => parseTime("2026-13-01T00:00:00Z", now)).toThrow(/real calendar date/);
    expect(parseTime("2028-02-29T00:00:00Z", now).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
  it("--schedule-at gets the same checks", async () => {
    const { scheduleAt } = await import("../src/commands/sms/shared.js");
    expect(() => scheduleAt("+99999999999d", now)).toThrow(/too far/);
    expect(() => scheduleAt("2026-02-31T09:00:00Z", now)).toThrow(/real calendar date/);
    expect(scheduleAt("+1d", now)).toBe("2026-10-23T12:00:00.000Z");
  });
  it("cdr list --from 99999999999999d is a usage error, not a request", async () => {
    const { runCli, fakeFetch } = await import("./helpers.js");
    const api = fakeFetch();
    const r = await runCli(["cdr", "list", "--from", "99999999999999d"], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(api.calls).toHaveLength(0);
  });
});
