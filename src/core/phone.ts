/**
 * Phone number helpers. The API takes E.164 (`+919876543210`); users paste numbers with spaces, dashes and
 * brackets. Path segments are always `encodeURIComponent`-ed by the client, so `+` travels as `%2B`.
 */
import { usage } from "./errors.js";

export function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Normalises to `+<digits>` and rejects anything that cannot be an E.164 number (7 to 15 digits, no leading 0). */
export function toE164(phone: string): string {
  const trimmed = phone.trim();
  if (/[A-Za-z]/.test(trimmed)) throw usage(`"${phone}" is not a phone number. Use E.164, e.g. +919876543210.`);
  const digits = digitsOnly(trimmed.replace(/^00/, ""));
  if (!/^[1-9]\d{6,14}$/.test(digits)) throw usage(`"${phone}" is not an E.164 phone number. Use the country code and digits, e.g. +919876543210.`);
  return `+${digits}`;
}

/** Encodes one path segment (`+` becomes `%2B`). */
export const encodeSegment = (s: string): string => encodeURIComponent(s);
