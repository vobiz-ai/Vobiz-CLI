/**
 * `vobiz feedback`: opens a prefilled GitHub issue for the CLI in the browser (or prints its URL). Nothing is sent
 * anywhere by the CLI itself: the issue is only filed if you submit the form on GitHub. The prefilled body carries
 * the CLI version, Node version and platform, never credentials, account IDs or command output.
 */
import type { Command } from "commander";
import type { Ctx } from "../core/context.js";
import { usage } from "../core/errors.js";
import { CLI_VERSION } from "../core/version.js";

export const ISSUES_URL = "https://github.com/vobiz-ai/Vobiz-CLI/issues/new";

/** GitHub's new-issue URL with title and body prefilled (kept well under browser URL limits). */
export function feedbackUrl(o: { title?: string; message?: string }): string {
  const message = (o.message ?? "").trim().slice(0, 4000);
  const body = [
    "### What happened",
    message || "<!-- Describe what you ran, what you expected and what you saw. Do not paste Auth Tokens. -->",
    "",
    "### Environment",
    `- vobiz CLI ${CLI_VERSION}`,
    `- Node ${process.versions.node}`,
    `- ${process.platform} ${process.arch}`,
  ].join("\n");
  const title = (o.title ?? (message ? message.split("\n")[0].slice(0, 80) : "")).trim();
  const params = new URLSearchParams({ ...(title ? { title } : {}), body, labels: "feedback" });
  return `${ISSUES_URL}?${params.toString()}`;
}

export function register(program: Command, ctx: Ctx): void {
  program
    .command("feedback")
    .description("Open a prefilled GitHub issue for the Vobiz CLI (or print its URL); nothing is sent until you submit it")
    .option("-m, --message <text>", "what happened or what you would like; becomes the issue body")
    .option("--title <text>", "issue title (default: the first line of --message)")
    .option("--print", "only print the URL; do not open a browser")
    .addHelpText(
      "after",
      `
Examples:
  vobiz feedback
  vobiz feedback -m "calls watch should show the hangup cause"
  vobiz feedback --print --title "sms send --wait timeout" | pbcopy

The issue body includes the CLI version, Node version and platform. Never paste an Auth Token into it.`,
    )
    .action(async (o: { message?: string; title?: string; print?: boolean }) => {
      if (o.message !== undefined && !o.message.trim()) throw usage("--message is empty.");
      const url = feedbackUrl(o);
      const open = !o.print && ctx.isTTY.stdout;
      const mode = ctx.out.mode;
      if (mode === "json" || mode === "jsonl" || mode === "yaml") ctx.out.print({ url, opened: open });
      else ctx.stdout.write(url + "\n");
      if (open) {
        await ctx.openUrl(url);
        ctx.out.status("Opened a new GitHub issue in your browser. It is filed only when you submit it.");
      }
    });
}
