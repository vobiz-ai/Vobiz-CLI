/**
 * `vobiz docs search|open`: search the Vobiz documentation through the public Docs MCP server
 * (https://www.vobiz.ai/docs/mcp) and open pages in the browser. Needs no credentials.
 */
import type { Command } from "commander";
import { DOCS_MCP_URL, DocsMcpClient, docsUrl, snippet } from "../agent/docs-mcp.js";
import type { Ctx } from "../core/context.js";
import { VobizError } from "../core/errors.js";

export function register(program: Command, ctx: Ctx): void {
  const docs = program.command("docs").description("Search the Vobiz documentation and open pages in your browser");

  docs
    .command("search")
    .description("Search the Vobiz docs (via the Vobiz Docs MCP server) and list matching pages")
    .argument("<query...>", "what to look for, e.g. \"gather speech input\"")
    .option("--limit <n>", "show at most this many results", "10")
    .addHelpText(
      "after",
      `
Examples:
  vobiz docs search "validate callback signature"
  vobiz docs search gather speech --json | jq -r '.[0].url'

Table output shows title, URL and a snippet; --json gives the full text of each match.`,
    )
    .action(async (words: string[], opts: { limit: string }) => {
      const query = words.join(" ").trim();
      if (!query) throw new VobizError("invalid_input", "Give a search query.");
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new VobizError("invalid_input", "--limit must be a whole number from 1 to 50.");
      if (ctx.flags.dryRun) {
        // The search is a JSON-RPC exchange (initialize, tools/list, tools/call); show it and send nothing.
        ctx.out.print({
          dry_run: true,
          operation: "docs-search",
          method: "POST",
          url: DOCS_MCP_URL,
          steps: ["initialize", "notifications/initialized", "tools/list", "tools/call"],
          body: { jsonrpc: "2.0", method: "tools/call", params: { name: "<the server's search tool>", arguments: { query } } },
          limit,
        });
        return;
      }
      ctx.log("verbose", `docs search via ${DOCS_MCP_URL}`);
      const client = new DocsMcpClient(ctx.fetch, DOCS_MCP_URL, ctx.flags.timeout * 1000);
      const results = (await client.search(query)).slice(0, limit);
      const mode = ctx.out.mode;
      if (mode === "json" || mode === "yaml") ctx.out.print(results);
      else ctx.out.print(results.map((r) => ({ title: r.title, url: r.url, snippet: snippet(r.content) })), { columns: ["title", "url", "snippet"], idKey: "url", empty: `No docs matched "${query}".` });
    });

  docs
    .command("open")
    .description("Open a Vobiz docs page in your browser")
    .argument("[path]", "page path such as xml/gather or concepts/validating-callbacks (default: the docs home)")
    .addHelpText("after", "\nExamples:\n  vobiz docs open\n  vobiz docs open xml/gather\n  vobiz docs open \"$(vobiz docs search gather --json | jq -r '.[0].url')\"")
    .action(async (path: string | undefined) => {
      const url = docsUrl(path);
      ctx.stdout.write(url + "\n");
      await ctx.openUrl(url);
    });
}
