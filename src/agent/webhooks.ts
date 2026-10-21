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

/**
 * Verifies an inbound request with whatever signature headers it carries: V3, then V2 (and their -MA- variants,
 * signed with the parent account's token), then a body HMAC. `url` is the public URL Vobiz called.
 */
export function verifyRequest(headers: Headers, url: string, body: Buffer, secret: string): VerifyResult {
  for (const version of ["v3", "v2"] as const) {
    const nonce = h(headers, `x-vobiz-signature-${version}-nonce`);
    if (!nonce) continue;
    for (const header of [`x-vobiz-signature-${version}`, `x-vobiz-signature-ma-${version}`]) {
      const sig = h(headers, header);
      if (!sig) continue;
      const r = verifyCallback({ url, nonce, signature: sig, secret, version });
      if (r.valid) return { ...r, header };
    }
    return { ...verifyCallback({ url, nonce, signature: h(headers, `x-vobiz-signature-${version}`) ?? "", secret, version }), header: `x-vobiz-signature-${version}` };
  }
  for (const header of ["x-webhook-signature", "x-vobiz-signature"]) {
    const sig = h(headers, header);
    if (sig && isBodySignature(sig)) return { ...verifyBody({ body, signature: sig, secret }), header };
  }
  return { valid: false, scheme: "none", reason: "no Vobiz signature headers (voice callbacks are signed only when the URL has credentials configured)" };
}
