/**
 * Vobiz webhook (callback) signatures, as documented in concepts/validating-callbacks and the messaging,
 * campaign, KYC and NDNC webhook pages. Ported from the Vobiz MCP server's src/webhooks.ts.
 *
 * Voice callbacks (answer/hangup/action URLs) sign the URL, never the body:
 *   X-Vobiz-Signature-V3 = base64(HMAC-SHA256(auth_token, baseURL + "." + X-Vobiz-Signature-V3-Nonce))
 *   X-Vobiz-Signature-V2 = base64(HMAC-SHA256(auth_token, baseURL + X-Vobiz-Signature-V2-Nonce))
 *   baseURL = scheme://host/path of the callback URL (query string removed). -MA- variants use the parent
 *   account's token. The nonce is random (no timestamp), so replay protection means remembering nonces.
 *
 * Messaging, campaign, KYC and NDNC webhooks sign the raw body instead:
 *   X-Webhook-Signature / X-Vobiz-Signature = hex(HMAC-SHA256(secret, raw body)), optionally "sha256=<hex>".
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type CallbackVersion = "v3" | "v2";

export interface VerifyResult {
  valid: boolean;
  scheme: "callback-url" | "body-hmac" | "none";
  version?: CallbackVersion;
  /** Which header carried the signature that was checked. */
  header?: string;
  base_url?: string;
  reason?: string;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signV3(token: string, baseUrl: string, nonce: string): string {
  return createHmac("sha256", token).update(`${baseUrl}.${nonce}`).digest("base64");
}
export function signV2(token: string, baseUrl: string, nonce: string): string {
  return createHmac("sha256", token).update(`${baseUrl}${nonce}`).digest("base64");
}
export function signBody(secret: string, body: Buffer | string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** The URL as Vobiz signs it: scheme://host/path, without query string or fragment. */
export function baseUrlOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

/** Checks a voice-callback signature. With no `version`, V3 is tried first, then V2. */
export function verifyCallback(o: { url: string; nonce: string; signature: string; secret: string; version?: CallbackVersion }): VerifyResult {
  const base = baseUrlOf(o.url);
  for (const version of o.version ? [o.version] : (["v3", "v2"] as const)) {
    const expected = version === "v3" ? signV3(o.secret, base, o.nonce) : signV2(o.secret, base, o.nonce);
    if (safeEqual(o.signature.trim(), expected)) return { valid: true, scheme: "callback-url", version, base_url: base };
  }
  return { valid: false, scheme: "callback-url", version: o.version, base_url: base, reason: "signature does not match this URL, nonce and secret" };
}

/** True for a body-HMAC signature value (`sha256=<hex>` or 64 hex chars), as opposed to the legacy V1 base64. */
export const isBodySignature = (sig: string) => /^(sha256=)?[0-9a-fA-F]{64}$/.test(sig.trim());

/** Checks a body HMAC (messaging X-Webhook-Signature, campaign/KYC/NDNC X-Vobiz-Signature). */
export function verifyBody(o: { body: Buffer | string; signature: string; secret: string }): VerifyResult {
  const given = o.signature.trim().replace(/^sha256=/i, "").toLowerCase();
  const ok = safeEqual(given, signBody(o.secret, o.body));
  return ok ? { valid: true, scheme: "body-hmac" } : { valid: false, scheme: "body-hmac", reason: "signature does not match this body and secret" };
}

type Headers = Record<string, string | string[] | undefined>;
const h = (headers: Headers, name: string) => {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** Vobiz voice-callback nonces are 20 random digits (concepts/validating-callbacks). */
export const NONCE_RE = /^\d{20}$/;

/**
 * Remembers verified nonces (and body signatures) so a captured request cannot be replayed: a bounded map in
 * insertion order, entries expire after `ttlMs` (default 24 h), the oldest are evicted past `max` (default 10,000).
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly max = 10_000,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records `key`; true when it was already seen within the TTL (a replay). */
  seenBefore(key: string): boolean {
    const t = this.now();
    const prev = this.seen.get(key);
    if (prev !== undefined && t - prev < this.ttlMs) return true;
    this.seen.delete(key);
    this.seen.set(key, t);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string);
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface RequestVerifyOptions {
  /** "v3" refuses V2 voice-callback signatures entirely. */
  scheme?: CallbackVersion;
  /** Replay protection: a nonce or body signature that verified before is refused. */
  nonces?: NonceCache;
}

const present = (headers: Headers, version: CallbackVersion) =>
  [`x-vobiz-signature-${version}`, `x-vobiz-signature-${version}-nonce`, `x-vobiz-signature-ma-${version}`].some((n) => h(headers, n) !== undefined);

/**
 * Verifies an inbound request with whatever signature headers it carries: V3 (V2 headers are then ignored), else V2
 * (unless `scheme: "v3"`), each with their -MA- variants signed with the parent account's token, else a body HMAC.
 * `url` is the public URL Vobiz called; without it voice-callback signatures cannot be checked. Nonces must be 20
 * digits, and with `o.nonces` a nonce or body signature is accepted only once.
 */
export function verifyRequest(headers: Headers, url: string | undefined, body: Buffer, secret: string, o: RequestVerifyOptions = {}): VerifyResult {
  const version: CallbackVersion | undefined = present(headers, "v3") ? "v3" : present(headers, "v2") ? "v2" : undefined;
  if (version) {
    if (version === "v2" && o.scheme === "v3") return { valid: false, scheme: "callback-url", version, reason: "V2 signatures are refused (--scheme v3)" };
    const nonce = h(headers, `x-vobiz-signature-${version}-nonce`) ?? "";
    if (!NONCE_RE.test(nonce)) return { valid: false, scheme: "callback-url", version, reason: `the ${version.toUpperCase()} nonce is missing or not 20 digits` };
    if (!url) return { valid: false, scheme: "callback-url", version, reason: "the public URL is unknown (pass --public-url to check voice-callback signatures)" };
    let result: VerifyResult | undefined;
    for (const header of [`x-vobiz-signature-${version}`, `x-vobiz-signature-ma-${version}`]) {
      const sig = h(headers, header);
      if (!sig) continue;
      const r = verifyCallback({ url, nonce, signature: sig, secret, version });
      if (r.valid) {
        result = { ...r, header };
        break;
      }
    }
    result ??= { ...verifyCallback({ url, nonce, signature: h(headers, `x-vobiz-signature-${version}`) ?? "", secret, version }), header: `x-vobiz-signature-${version}` };
    if (result.valid && o.nonces?.seenBefore(`${version}:${nonce}`)) return { ...result, valid: false, reason: "nonce already used (a replayed request)" };
    return result;
  }
  for (const header of ["x-webhook-signature", "x-vobiz-signature"]) {
    const sig = h(headers, header);
    if (sig && isBodySignature(sig)) {
      const r: VerifyResult = { ...verifyBody({ body, signature: sig, secret }), header };
      if (r.valid && o.nonces?.seenBefore(`body:${sig.trim().replace(/^sha256=/i, "").toLowerCase()}`)) return { ...r, valid: false, reason: "signature already used (a replayed request)" };
      return r;
    }
  }
  return { valid: false, scheme: "none", reason: "no Vobiz signature headers (voice callbacks are signed only when the URL has credentials configured)" };
}
