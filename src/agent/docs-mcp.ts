/**
 * A minimal MCP client (Streamable HTTP, JSON-RPC 2.0, no SDK) for the public Vobiz Docs MCP server at
 * https://www.vobiz.ai/docs/mcp. It does exactly what `vobiz docs search` needs: initialize, tools/list,
 * tools/call. Responses may be plain JSON or a text/event-stream of `data:` lines; both are handled.
 */
import { readBodyCapped } from "../core/body.js";
import { VobizError } from "../core/errors.js";

/** Largest docs-server answer read (search results are a few hundred KB at most). */
const MAX_DOCS_RESPONSE_BYTES = 10 * 1024 * 1024;
import { CLI_VERSION, USER_AGENT } from "../core/version.js";

export const DOCS_MCP_URL = "https://www.vobiz.ai/docs/mcp";
export const DOCS_BASE_URL = "https://www.vobiz.ai/docs";
export const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

export interface DocsResult {
  title: string;
  url: string;
  page: string;
  content: string;
}

/** Picks the JSON-RPC message with `id` out of a JSON or SSE body. */
export function parseRpcBody(text: string, contentType: string, id: number): JsonRpcResponse | undefined {
  const messages: JsonRpcResponse[] = [];
  const push = (raw: string) => {
    if (!raw.trim()) return;
    try {
      const v = JSON.parse(raw);
      for (const m of Array.isArray(v) ? v : [v]) messages.push(m);
    } catch {
      // ignore non-JSON events
    }
  };
  if (contentType.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      push(data);
    }
  } else push(text);
  return messages.find((m) => m.id === id);
}

export class DocsMcpClient {
  private nextId = 1;
  private sessionId?: string;
  private protocol = PROTOCOL_VERSION;

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly url = DOCS_MCP_URL,
    private readonly timeoutMs = 30_000,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": USER_AGENT,
      "MCP-Protocol-Version": this.protocol,
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  /** POSTs one JSON-RPC message and reads the whole answer; the timeout covers the body too, and it is size-capped. */
  private async post(body: unknown): Promise<{ res: Response; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const timedOut = () => new VobizError("timeout", `The Vobiz docs server did not answer within ${Math.round(this.timeoutMs / 1000)}s.`);
    try {
      let res: Response;
      try {
        res = await this.fetchFn(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: controller.signal });
      } catch (e) {
        if (controller.signal.aborted) throw timedOut();
        throw new VobizError("network_error", `Cannot reach ${new URL(this.url).host}: ${(e as Error).message}`);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBodyCapped(res, MAX_DOCS_RESPONSE_BYTES, "The docs server's answer");
      } catch (e) {
        if (e instanceof VobizError) throw e;
        if (controller.signal.aborted) throw timedOut();
        throw new VobizError("network_error", `The docs server's answer was cut off: ${(e as Error).message}`);
      }
      return { res, text: new TextDecoder().decode(bytes) };
    } finally {
      clearTimeout(timer);
    }
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const { res, text } = await this.post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!res.ok) {
      const kind = res.status === 429 ? "rate_limited" : res.status >= 500 ? "service_unavailable" : "unexpected_response";
      throw new VobizError(kind, `The Vobiz docs server answered HTTP ${res.status} to ${method}.`, res.status);
    }
    const msg = parseRpcBody(text, res.headers.get("content-type") ?? "", id);
    if (!msg) throw new VobizError("unexpected_response", `The Vobiz docs server sent no answer to ${method}.`);
    if (msg.error) throw new VobizError("backend_error", `Docs server error (${msg.error.code}): ${msg.error.message}`);
    return msg.result as T;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async initialize(): Promise<void> {
    const r = await this.request<{ protocolVersion?: string }>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "vobiz-cli", version: CLI_VERSION },
    });
    if (r?.protocolVersion) this.protocol = r.protocolVersion;
    await this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpTool[]> {
    return (await this.request<{ tools?: McpTool[] }>("tools/list"))?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content?: { type: string; text?: string }[]; isError?: boolean }> {
    return this.request("tools/call", { name, arguments: args });
  }

  /** initialize → tools/list → the search tool → results. */
  async search(query: string): Promise<DocsResult[]> {
    await this.initialize();
    const tools = await this.listTools();
    const tool = tools.find((t) => /^search/i.test(t.name)) ?? tools.find((t) => /search/i.test(t.name));
    if (!tool) throw new VobizError("unexpected_response", "The Vobiz docs server offers no search tool.");
    const argName = tool.inputSchema?.required?.[0] ?? "query";
    const result = await this.callTool(tool.name, { [argName]: query });
    const texts = (result?.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text as string);
    if (result?.isError) throw new VobizError("backend_error", `Docs search failed: ${texts.join(" ").slice(0, 300) || "unknown error"}`);
    return texts.map(parseResult);
  }
}

/** Parses one search hit ("Title: …\nLink: …\nPage: …\nContent: …"); unknown shapes keep the text as content. */
export function parseResult(text: string): DocsResult {
  const field = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  const contentAt = /^Content:[ \t]*/m.exec(text);
  const content = contentAt ? text.slice(contentAt.index + contentAt[0].length).trim() : text.trim();
  const url = field("Link") || field("URL");
  const page = field("Page") || (url.startsWith(DOCS_BASE_URL + "/") ? url.slice(DOCS_BASE_URL.length + 1).split("#")[0] : "");
  return { title: field("Title"), url, page, content };
}

/** One-line plain-text excerpt of a Markdown chunk. */
export function snippet(markdown: string, max = 160): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/(?<!\\)[*_`>|]/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

/** https://www.vobiz.ai/docs/<path> for a docs path, page id or full docs URL. */
export function docsUrl(path: string | undefined): string {
  if (!path) return DOCS_BASE_URL;
  if (/^https?:\/\//.test(path)) {
    const u = new URL(path);
    if (u.host !== "www.vobiz.ai" && u.host !== "vobiz.ai" && u.host !== "docs.vobiz.ai") throw new VobizError("invalid_input", `Not a Vobiz docs URL: ${path}`);
    return u.toString();
  }
  const clean = path.replace(/^\/+/, "").replace(/^docs\//, "").replace(/\.mdx?$/, "");
  if (!/^[A-Za-z0-9_\-/.#]*$/.test(clean) || clean.includes("..")) throw new VobizError("invalid_input", `Not a docs path: ${path}`);
  return clean ? `${DOCS_BASE_URL}/${clean}` : DOCS_BASE_URL;
}
