/**
 * `vobiz update [--check]`: tells you how to upgrade for the way the CLI was installed. It never replaces the
 * binary itself (package managers own that), so it is safe to run anywhere.
 */
import { existsSync } from "node:fs";
import { posix } from "node:path";
import type { Command } from "commander";
import type { Ctx } from "../core/context.js";
import { VobizError } from "../core/errors.js";
import { compareVersions, fetchLatestVersion } from "../core/update.js";
import { CLI_VERSION } from "../core/version.js";

export type InstallMethod = "homebrew" | "docker" | "binary" | "npx" | "npm" | "source";

/**
 * Best guess from the executable path; used only to choose which upgrade command to print. `exists` is injectable
 * for tests. A `dist/index.js` whose package root also holds `.git` is a source checkout (`npm run dev`, `npm link`).
 */
export function detectInstallMethod(execPath = process.argv[1] ?? "", env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): InstallMethod {
  const p = execPath.replace(/\\/g, "/");
  if (env.VOBIZ_DOCKER === "1") return "docker";
  if (/\/(Cellar|homebrew|linuxbrew)\//i.test(p)) return "homebrew";
  if (/\/_npx\//.test(p)) return "npx";
  if (/node_modules\//.test(p)) return "npm";
  if (p) {
    // Forward slashes on every platform: Node's fs accepts them on Windows too, and the result is testable.
    const pkgRoot = posix.dirname(posix.dirname(p));
    if (exists(posix.join(pkgRoot, ".git")) && exists(posix.join(pkgRoot, "package.json"))) return "source";
  }
  if (process.execPath && !/\bnode(\.exe)?$/i.test(process.execPath)) return "binary";
  return "npm";
}

const HOW: Record<InstallMethod, string> = {
  npm: "npm install -g @vobiz/cli@latest",
  npx: "npx @vobiz/cli@latest (npx always runs the version you name)",
  homebrew: "brew upgrade vobiz-ai/tap/vobiz",
  docker: "docker pull ghcr.io/vobiz-ai/vobiz-cli:latest",
  source: "git pull && npm ci && npm run build (in your checkout)",
  binary: "curl -fsSL https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/install.sh | sh",
};

export function register(program: Command, ctx: Ctx): void {
  program
    .command("update")
    .description("Check for a newer CLI version and show how to upgrade")
    .option("--check", "only report whether an update exists (exit 0 either way)")
    .action(async (opts: { check?: boolean }) => {
      const latest = await fetchLatestVersion(ctx.fetch, Math.min(ctx.flags.timeout * 1000, 10_000));
      if (!latest) throw new VobizError("network_error", "Could not read the latest version from the npm registry.");
      ctx.store.patchSettings({ lastUpdateCheck: ctx.now().toISOString(), latestKnownVersion: latest });
      const method = detectInstallMethod(undefined, ctx.env);
      const available = compareVersions(latest, CLI_VERSION) > 0;
      const data = { current: CLI_VERSION, latest, update_available: available, install_method: method, upgrade_command: available ? HOW[method] : null };
      if (ctx.out.mode === "table" || ctx.out.mode === "plain") {
        ctx.stdout.write(
          available
            ? `vobiz ${CLI_VERSION} -> ${latest} is available.${opts.check ? "" : `\nUpgrade with:\n  ${HOW[method]}`}\n`
            : `vobiz ${CLI_VERSION} is the latest version.\n`,
        );
      } else ctx.out.print(data);
    });
}
