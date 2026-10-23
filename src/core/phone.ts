/**
 * Phone number helpers. The API takes E.164 (`+919876543210`); users paste numbers with spaces, dashes and
 * brackets. Path segments are always `encodeURIComponent`-ed by the client, so `+` travels as `%2B`.
 */
import { usage } from "./errors.js";

export function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Normalises to `+<digits>` and rejects anything that cannot be an E.164 number (7 to 15 digits, no leading 0).
 * Only ASCII digits, one leading `+` (or `00`), spaces, dashes, dots and parentheses are accepted: any other
 * character (`#`, `/`, letters, extension markers, non-ASCII digits) is an error, never silently dropped, because
 * dropping it can turn the input into a different real number that then gets called or texted.
 */
export function toE164(phone: string): string {
  const trimmed = phone.trim();
  if (!/^\+?[0-9 ().-]+$/.test(trimmed))
    throw usage(`"${phone}" is not a phone number. Use E.164 with ASCII digits only, e.g. +919876543210 (spaces, dashes, dots and brackets are fine).`);
  const digits = digitsOnly(trimmed.replace(/^00/, ""));
  if (!/^[1-9]\d{6,14}$/.test(digits)) throw usage(`"${phone}" is not an E.164 phone number. Use the country code and digits, e.g. +919876543210.`);
  return `+${digits}`;
}

/** Encodes one path segment (`+` becomes `%2B`). */
export const encodeSegment = (s: string): string => encodeURIComponent(s);
