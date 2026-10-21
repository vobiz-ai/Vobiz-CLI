/**
 * Secret redaction for everything the CLI prints or logs. `GET /api/v1/auth/me` really returns `auth_secret`
 * in plain text, and several resources carry SIP passwords, so printed data is always passed through here.
 * Only `--debug --show-secrets` bypasses it.
 *
 * Three layers:
 * - by key: `redact()` replaces the value of every secret-NAMED key (see `isSecretKey`), at any depth;
 * - by value: `scrubSecrets()` replaces every known secret VALUE (the active Auth Token, `--password`/`--secret`
 *   values given this run) inside free text such as backend error messages and log lines;
 * - in URLs: `redactUrl()` hides the values of secret-named query parameters (`?token=…`, `?password=…`), used for
 *   `--dry-run`/`--debug` request URLs and URL strings inside logged bodies (e.g. the KYC `widget_url`).
 */
export const REDACTED = "[redacted]";

/**
 * A key is secret when its normalised form (lower case, `_`/`-`/`.`/spaces removed) ends with one of these. This
 * catches variants the API may return without documenting them: `sip_password`, `sipPassword`, `webhook_secret`,
 * `signing_secret`, `auth-token`, `campaignVerifyToken`, `x-auth-token`, `private_key`, `secret_key`, `passwd`.
 */
const SECRET_SUFFIXES = ["token", "secret", "password", "passwd", "passphrase", "authorization", "credential", "credentials", "apikey", "privatekey", "secretkey", "signingkey"];

/** Secret only as a whole word (last segment): a bare `pin` or `otp`, `sip_pin`, `voicemailPin`; never `mapping` or `spin`. */
const SECRET_LAST_SEGMENTS = new Set(["pin", "otp"]);

/**
 * Names that end in a secret suffix but are not secrets. Checked against the specs (spec/openapi-voice.yaml and
 * spec/openapi-sms.yaml): every field there whose normalised name ends in token/secret/password/credential(s)/key
 * is a real secret (`auth_token`, `AuthToken`, `auth_secret`, `secret`, `Secret`, `password`, `access_token`,
 * `refresh_token`, `campaignVerifyToken`) except the container `auth_credentials`, which holds the sub-account's
 * public `auth_id` next to its `auth_token`; containers are walked rather than hidden (see `redact`). The other
 * spec names close to these words, `idempotency_key`/`IdempotencyKey`/`idempotencyKey`, `numberKey(s)`,
 * `dlt_template_id`, `credential_uuid`/`credential_id`, `token_type` and `*_token_expire_time`, do not match the
 * suffix rule at all. Paging cursors are listed here so a future `next_page_token` stays visible.
 */
const NOT_SECRET = new Set(["pagetoken", "nextpagetoken", "prevpagetoken", "previouspagetoken", "continuationtoken", "nexttoken", "cursortoken"]);

const normalise = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");
const lastSegment = (key: string): string =>
  (key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .pop() ?? "").toLowerCase();

export function isSecretKey(key: string): boolean {
  const n = normalise(key);
  if (!n || NOT_SECRET.has(n)) return false;
  return SECRET_SUFFIXES.some((s) => n.endsWith(s)) || SECRET_LAST_SEGMENTS.has(lastSegment(key));
}

/** Keys whose objects are walked (their secret children redacted) rather than replaced, so public ids stay visible. */
const isContainerKey = (key: string): boolean => /credentials?$/.test(normalise(key));

/** Deep copy of `value` with every secret-named key replaced by "[redacted]" (empty, null and boolean values are kept). */
export function redact<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        // Booleans (`has_password`, `require_pin`) say nothing secret and stay visible.
        if (val === null || val === undefined || val === "" || typeof val === "boolean" || !isSecretKey(k)) out[k] = walk(val);
        else if (isContainerKey(k) && typeof val === "object") out[k] = walk(val);
        else out[k] = REDACTED;
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** `url` with the value of every secret-named query parameter replaced; anything that is not a URL is returned as is. */
export function redactUrl(url: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  const q = url.indexOf("?");
  if (q < 0) return url;
  const hash = url.indexOf("#", q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  let changed = false;
  const parts = query.split("&").map((part) => {
    const eq = part.indexOf("=");
    if (eq < 0) return part;
    let name: string;
    try {
      name = decodeURIComponent(part.slice(0, eq).replace(/\+/g, " "));
    } catch {
      name = part.slice(0, eq);
    }
    if (!isSecretKey(name) || part.length === eq + 1) return part;
    changed = true;
    return `${part.slice(0, eq)}=${REDACTED}`;
  });
  return changed ? url.slice(0, q + 1) + parts.join("&") + (hash < 0 ? "" : url.slice(hash)) : url;
}

/** `redact()` plus `redactUrl()` on every string value: for `--debug` logs and `--dry-run`, never for printed results. */
export function redactForLog<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactUrl(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && !(v instanceof Date)) return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(redact(value)) as T;
}

/** Secret values known to this process (the active Auth Token, secret flag values). Short values are ignored. */
const knownSecrets = new Set<string>();
const MIN_SECRET_LENGTH = 4;

/** Remembers a secret value so `scrubSecrets()` removes it from any text printed later in this process. */
export function rememberSecret(value: string | undefined | null): void {
  if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) knownSecrets.add(value);
}

/** Remembers the value of every secret-named key in a request body (e.g. a `--body` with a `password`). */
export function rememberSecretsIn(value: unknown): void {
  if (Array.isArray(value)) value.forEach(rememberSecretsIn);
  else if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof FormData)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k) && (typeof v === "string" || typeof v === "number")) rememberSecret(String(v));
      else rememberSecretsIn(v);
    }
  }
}

/** `text` with every known secret value (and its URL-encoded form) replaced by "[redacted]". */
export function scrubSecrets(text: string): string {
  if (!text || knownSecrets.size === 0) return text;
  let out = text;
  // Longest first, so a secret that contains another is replaced whole.
  for (const s of [...knownSecrets].sort((a, b) => b.length - a.length)) {
    for (const form of new Set([s, encodeURIComponent(s)])) if (out.includes(form)) out = out.split(form).join(REDACTED);
  }
  return out;
}

/** For tests: forget every remembered secret. */
export function forgetSecrets(): void {
  knownSecrets.clear();
}
