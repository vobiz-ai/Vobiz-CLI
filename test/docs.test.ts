import { describe, expect, it } from "vitest";
import { docsUrl, parseRpcBody, snippet } from "../src/agent/docs-mcp.js";
import { fakeFetch, reply, runCli, textReply, type RecordedRequest } from "./helpers.js";

const HIT_1 = "Title: Gather XML Element\nLink: https://www.vobiz.ai/docs/xml/gather\nPage: xml/gather\nContent: You can use the **Gather** XML element to collect [DTMF](/xml/dtmf) input.";
const HIT_2 = "Title: Detecting speech inputs\nLink: https://www.vobiz.ai/docs/xml/gather/detecting-speech-inputs#ai\nPage: xml/gather/detecting-speech-inputs\nContent: ### Speech\n\nReal-time transcription.";

const sse = (body: unknown) => textReply(200, `event: message\ndata: ${JSON.stringify(body)}\n\n`, { "content-type": "text/event-stream" });

function docsServer(over: Partial<Record<string, (req: RecordedRequest) => unknown>> = {}) {
  return fakeFetch({
    "POST /docs/mcp": (req) => {
      const msg = req.body as { id?: number; method: string; params?: Record<string, unknown> };
      const handler = over[msg.method];
      if (handler) return handler(req);
      switch (msg.method) {
        case "initialize":
          return reply(200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Vobiz" } } }, { "mcp-session-id": "sess-1" });
        case "notifications/initialized":
          return textReply(202, "");
        case "tools/list":
          return sse({
            jsonrpc: "2.0",
            id: msg.id,
            result: { tools: [{ name: "query_docs_filesystem_vobiz" }, { name: "search_vobiz", inputSchema: { properties: { query: { type: "string" } }, required: ["query"] } }] },
          });
        case "tools/call":
          return sse({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: HIT_1 }, { type: "text", text: HIT_2 }] } });
      }
      return reply(400, {});
    },
  });
}

describe("docs search", () => {
  it("runs initialize, tools/list and tools/call over Streamable HTTP", async () => {
    const api = docsServer();
    const r = await runCli(["docs", "search", "gather", "speech", "--json"], { fetch: api.fetch, loggedOut: true });
    expect(r.code).toBe(0);
    expect(api.calls.map((c) => (c.body as { method: string }).method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(api.calls[0].url).toBe("https://www.vobiz.ai/docs/mcp");
    expect(api.calls[0].headers.accept).toBe("application/json, text/event-stream");
    expect(api.calls[0].headers["mcp-session-id"]).toBeUndefined();
    expect(api.calls[2].headers["mcp-session-id"]).toBe("sess-1");
    expect(api.calls[2].headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(api.calls[0].headers["x-auth-token"]).toBeUndefined();
    expect(api.calls[3].body).toMatchObject({ params: { name: "search_vobiz", arguments: { query: "gather speech" } } });
    expect(r.json()).toEqual([
      { title: "Gather XML Element", url: "https://www.vobiz.ai/docs/xml/gather", page: "xml/gather", content: "You can use the **Gather** XML element to collect [DTMF](/xml/dtmf) input." },
      { title: "Detecting speech inputs", url: "https://www.vobiz.ai/docs/xml/gather/detecting-speech-inputs#ai", page: "xml/gather/detecting-speech-inputs", content: "### Speech\n\nReal-time transcription." },
    ]);
  });

  it("prints a title/url/snippet table and honours --limit", async () => {
    const r = await runCli(["docs", "search", "gather", "--limit", "1", "-o", "tsv"], { fetch: docsServer().fetch });
    expect(r.out).toBe("title\turl\tsnippet\nGather XML Element\thttps://www.vobiz.ai/docs/xml/gather\tYou can use the Gather XML element to collect DTMF input.\n");
  });

  it("maps JSON-RPC errors, tool errors and HTTP failures", async () => {
    const rpcErr = docsServer({ "tools/call": (req) => reply(200, { jsonrpc: "2.0", id: (req.body as { id: number }).id, error: { code: -32602, message: "bad query" } }) });
    const a = await runCli(["docs", "search", "x"], { fetch: rpcErr.fetch });
    expect(a.code).toBe(1);
    expect(a.err).toContain("bad query");

    const toolErr = docsServer({ "tools/call": (req) => sse({ jsonrpc: "2.0", id: (req.body as { id: number }).id, result: { isError: true, content: [{ type: "text", text: "index offline" }] } }) });
    expect((await runCli(["docs", "search", "x"], { fetch: toolErr.fetch })).err).toContain("index offline");

    const down = docsServer({ initialize: () => reply(503, {}) });
    const c = await runCli(["docs", "search", "x"], { fetch: down.fetch });
    expect(c.code).toBe(1);
    expect(c.err).toContain("service_unavailable");

    const noTool = docsServer({ "tools/list": (req) => reply(200, { jsonrpc: "2.0", id: (req.body as { id: number }).id, result: { tools: [] } }) });
    expect((await runCli(["docs", "search", "x"], { fetch: noTool.fetch })).err).toContain("no search tool");
  });

  it("validates --limit", async () => {
    expect((await runCli(["docs", "search", "x", "--limit", "0"])).code).toBe(2);
  });
});

describe("docs helpers", () => {
  it("parses SSE and JSON bodies", () => {
    expect(parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":1}\n\n', "text/event-stream", 7)?.result).toBe(1);
    expect(parseRpcBody('{"jsonrpc":"2.0","id":3,"result":2}', "application/json", 3)?.result).toBe(2);
    expect(parseRpcBody('{"jsonrpc":"2.0","id":3,"result":2}', "application/json", 4)).toBeUndefined();
  });
  it("makes snippets and docs URLs", () => {
    expect(snippet("## Title\n\nUse `<Gather>` with [hints](/x) \\* care", 100)).toBe("Title Use with hints * care");
    expect(snippet("a".repeat(200), 10)).toBe("aaaaaaaaa…");
    expect(docsUrl(undefined)).toBe("https://www.vobiz.ai/docs");
    expect(docsUrl("/xml/gather.mdx")).toBe("https://www.vobiz.ai/docs/xml/gather");
    expect(docsUrl("docs/concepts/validating-callbacks")).toBe("https://www.vobiz.ai/docs/concepts/validating-callbacks");
    expect(docsUrl("https://www.vobiz.ai/docs/xml/gather#attributes")).toBe("https://www.vobiz.ai/docs/xml/gather#attributes");
    expect(() => docsUrl("https://evil.example.com/x")).toThrow(/Not a Vobiz docs URL/);
    expect(() => docsUrl("../etc/passwd")).toThrow(/Not a docs path/);
  });
});

describe("docs open", () => {
  it("opens the page in the browser and prints the URL", async () => {
    const r = await runCli(["docs", "open", "xml/gather"], { loggedOut: true });
    expect(r.code).toBe(0);
    expect(r.out).toBe("https://www.vobiz.ai/docs/xml/gather\n");
    expect(r.opened).toEqual(["https://www.vobiz.ai/docs/xml/gather"]);
  });
});
