/**
 * Secret redaction for everything the CLI prints or logs. `GET /api/v1/auth/me` really returns `auth_secret`
 * in plain text, and several resources carry SIP passwords, so printed data is always passed through here.
 * Only `--debug --show-secrets` bypasses it.
 */
export const REDACTED = "[redacted]";

const SECRET_KEYS = new Set(
  ["auth_token", "auth_secret", "authToken", "password", "secret", "token", "client_secret", "private_key", "x-auth-token"].map((k) =>
    k.toLowerCase(),
  ),
);

export const isSecretKey = (key: string): boolean => SECRET_KEYS.has(key.toLowerCase());

/** Deep copy of `value` with every secret-named key replaced by "[redacted]" (empty and null values are kept). */
export function redact<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = isSecretKey(k) && val !== null && val !== undefined && val !== "" ? REDACTED : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
