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
