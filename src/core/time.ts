/**
 * Human date arguments for CDR and transaction filters: `today`, `yesterday`, `now`, relative durations
 * (`30m`, `24h`, `7d`, `2w`, meaning "that long ago"), calendar dates (`2026-10-01`, local midnight) and full
 * ISO timestamps. Everything is computed from an injectable `now` so tests are deterministic.
 */
import { usage } from "./errors.js";

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Largest relative offset accepted (`36500d`, about 100 years); beyond it Date arithmetic stops being meaningful. */
export const MAX_RELATIVE_MS = 36_500 * 86_400_000;

/** True when Y-M-D names a real calendar day (no Feb 31, no month 13). */
export function isRealYmd(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Throws invalid_input when an ISO timestamp's date part is not a real day: `Date.parse` silently rolls
 * `2026-02-31T00:00:00Z` over to March 3.
 */
export function assertRealIsoDate(input: string, label = "The date"): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.trim());
  if (m && !isRealYmd(Number(m[1]), Number(m[2]), Number(m[3]))) throw usage(`${label} "${input}" is not a real calendar date.`);
}

/** A relative offset in ms, bounded by MAX_RELATIVE_MS. */
export function relativeMs(amount: string, unitMs: number, input: string): number {
  const ms = Number(amount) * unitMs;
  if (!Number.isFinite(ms) || ms > MAX_RELATIVE_MS) throw usage(`"${input}" is too far away; relative times go up to 36500d (about 100 years).`);
  return ms;
}

const valid = (d: Date, input: string): Date => {
  if (!Number.isFinite(d.getTime())) throw usage(`"${input}" is outside the range of dates the CLI can use.`);
  return d;
};

export function parseTime(input: string, now: Date = new Date()): Date {
  const s = input.trim().toLowerCase();
  if (s === "now") return new Date(now);
  if (s === "today") return startOfDay(now);
  if (s === "yesterday") {
    const d = startOfDay(now);
    d.setDate(d.getDate() - 1);
    return d;
  }
  const rel = /^(\d+)\s*([smhdw])$/.exec(s);
  if (rel) return valid(new Date(now.getTime() - relativeMs(rel[1], UNIT_MS[rel[2]], input)), input);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    if (d.getFullYear() !== Number(ymd[1]) || d.getMonth() !== Number(ymd[2]) - 1 || d.getDate() !== Number(ymd[3]))
      throw usage(`"${input}" is not a real calendar date.`);
    return d;
  }
  if (/^\d{4}-\d{2}-\d{2}t/.test(s)) {
    assertRealIsoDate(input);
    const t = Date.parse(input.trim());
    if (!Number.isNaN(t)) return valid(new Date(t), input);
  }
  throw usage(`Cannot read the date "${input}". Use today, yesterday, 7d, 24h, 2026-10-01 or an ISO timestamp.`);
}

/** Local calendar date `YYYY-MM-DD` (the CDR and transaction APIs filter by date). */
export function toYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parses a --from/--to pair and checks the order. Either side may be omitted. */
export function parseRange(from: string | undefined, to: string | undefined, now: Date = new Date()): { from?: Date; to?: Date } {
  const f = from ? parseTime(from, now) : undefined;
  const t = to ? parseTime(to, now) : undefined;
  if (f && t && f.getTime() > t.getTime()) throw usage(`--from (${from}) is after --to (${to}).`);
  return { from: f, to: t };
}
