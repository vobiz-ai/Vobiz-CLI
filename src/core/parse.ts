/**
 * Strict number parsing for flags. `Number()` accepts `0x50`, `0b11`, `1e3`, `" 7 "` and `""` (as 0); a flag
 * value must instead be plain decimal digits within explicit bounds.
 */
import { VobizError } from "./errors.js";

export interface IntBounds {
  min?: number;
  max?: number;
}

/** Parses decimal digits (optionally a leading "-" when `min` < 0) into a safe integer in [min, max]; undefined otherwise. */
export function tryParseIntStrict(text: string, b: IntBounds = {}): number | undefined {
  const min = b.min ?? 0;
  const max = b.max ?? Number.MAX_SAFE_INTEGER;
  if (!(min < 0 ? /^-?\d{1,16}$/ : /^\d{1,16}$/).test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}

/** Like tryParseIntStrict, but throws invalid_input naming `label` and the accepted range. */
export function parseIntStrict(text: string, label: string, b: IntBounds = {}): number {
  const n = tryParseIntStrict(text, b);
  if (n === undefined) {
    const range = b.max === undefined || b.max === Number.MAX_SAFE_INTEGER ? `${b.min ?? 0} or more` : `from ${b.min ?? 0} to ${b.max}`;
    throw new VobizError("invalid_input", `${label} must be a whole number ${range} (got "${text}").`);
  }
  return n;
}
