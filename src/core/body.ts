/**
 * Bounded response-body reads. A misconfigured base URL or a misbehaving server must not be able to stream
 * gigabytes into memory: the body is read chunk by chunk and abandoned past the limit.
 */
import { VobizError } from "./errors.js";

/** Default cap for JSON/text API responses (50 MB, far above any real page). */
export const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/** Reads `res.body` into memory, failing with unexpected_response once more than `maxBytes` arrive. */
export async function readBodyCapped(res: Response, maxBytes: number = MAX_RESPONSE_BYTES, what = "The response"): Promise<Uint8Array> {
  const tooBig = () => new VobizError("unexpected_response", `${what} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB; stopped reading it.`, res.status);
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
