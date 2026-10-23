import { describe, expect, it } from "vitest";
import { DocsMcpClient } from "../src/agent/docs-mcp.js";
import { readBodyCapped } from "../src/core/body.js";
import { runCli } from "./helpers.js";

const streamOf = (chunks: number, size: number, delayMs = 0) =>
  new ReadableStream<Uint8Array>({
    async pull(c) {
      if (chunks-- <= 0) return c.close();
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      c.enqueue(new Uint8Array(size));
    },
  });

describe("response size caps", () => {
  it("readBodyCapped stops past the limit and trusts a large Content-Length up front", async () => {
    await expect(readBodyCapped(new Response(streamOf(10, 1000)), 5000)).rejects.toMatchObject({ kind: "unexpected_response" });
    expect((await readBodyCapped(new Response(streamOf(4, 1000)), 5000)).length).toBe(4000);
    await expect(readBodyCapped(new Response("x", { headers: { "content-length": "999999" } }), 10)).rejects.toMatchObject({ kind: "unexpected_response" });
  });

  it("the API client refuses an oversized JSON body", async () => {
    const fetchFn = (async () => new Response(null, { status: 200, headers: { "content-type": "application/json", "content-length": String(60 * 1024 * 1024) } })) as unknown as typeof fetch;
    const r = await runCli(["api", "GET", "/api/v1/auth/me"], { fetch: fetchFn });
    expect(r.code).toBe(1);
    expect(r.err).toContain("larger than 50 MB");
  });

  it("the docs MCP timeout also covers reading the body", async () => {
    const fetchFn = (async (_u: unknown, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: "));
          init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const client = new DocsMcpClient(fetchFn, "https://www.vobiz.ai/docs/mcp", 100);
    const t = Date.now();
    await expect(client.request("tools/list")).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
