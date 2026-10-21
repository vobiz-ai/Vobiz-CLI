/**
 * `vobiz mcp install|config`: connect an AI client (Claude, Claude Code, Cursor, Codex, Windsurf, VS Code, Gemini
 * CLI, Zed) to the Vobiz MCP server by writing or printing the client's config entry. The default is the hosted
 * connector (OAuth, no secret in any file); --local runs `npx -y @vobiz/mcp` with credentials from the environment.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Option, type Command } from "commander";
import {
  CLIENTS,
  HOSTED_URL,
  LOCAL_PACKAGE,
  clientSpec,
  fragment,
  mergeJson,
  mergeToml,
  tomlTable,
  type ClientSpec,
  type Credentials,
  type MergeResult,
  type Mode,
} from "../agent/mcp-clients.js";
import { requireConfirmation } from "../core/confirm.js";
import type { Ctx } from "../core/context.js";
import { VobizError } from "../core/errors.js";
import { REDACTED } from "../core/redact.js";
import { assertInsideDir, assertNotSymlink, backupFile, sameContent, writeFileAtomicExclusive } from "../core/fsafe.js";
import { isUnsafeKey } from "../core/keys.js";

interface ModeOpts {
  hosted?: boolean;
  local?: boolean;
  project?: boolean;
  dir?: string;
  name: string;
}

const modeOf = (o: ModeOpts): Mode => (o.local ? "local" : "hosted");

function validName(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || isUnsafeKey(name)) throw new VobizError("invalid_input", "--name may contain only letters, digits, - and _.");
  return name;
}

function targetPath(ctx: Ctx, spec: ClientSpec, mode: Mode, o: ModeOpts): string | undefined {
  if (o.project && !spec.project) throw new VobizError("invalid_input", `${spec.title} has no project-level config; drop --project.`);
  return spec.path({ env: ctx.env, platform: process.platform, cwd: resolve(o.dir ?? process.cwd()), project: !!o.project, mode });
}

/**
 * The snippet as the client's file format, for printing. The Auth Token is always the YOUR_AUTH_TOKEN placeholder:
 * only the 0600 config file written by `install --with-credentials` ever holds the real token.
 */
function snippet(spec: ClientSpec, mode: Mode, name: string, creds?: Credentials): string {
  const frag = fragment(spec, mode, name, creds ? { authId: creds.authId, authToken: "YOUR_AUTH_TOKEN" } : undefined);
  if (spec.format === "toml") return tomlTable(spec.container, name, (frag[spec.container] as Record<string, Record<string, unknown>>)[name]);
  return JSON.stringify(frag, null, 2) + "\n";
}

function credentialNote(spec: ClientSpec, mode: Mode, creds?: Credentials): string {
  if (mode === "hosted") return "none in the file (you sign in with OAuth)";
  if (creds) return `Auth ID ${creds.authId} and your Auth Token, in plain text in this file`;
  return spec.envAware ? "read from VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN (not stored in the file)" : "placeholders MA_XXXXXXXX / YOUR_AUTH_TOKEN for you to replace";
}

/** Writes atomically, keeping the original file's permissions (0600 when the file holds a token). */
function writeConfig(file: string, text: string, hasSecret: boolean): string | undefined {
  mkdirSync(dirname(file), { recursive: true });
  let backup: string | undefined;
  let mode = hasSecret ? 0o600 : 0o644;
  if (existsSync(file)) {
    backup = `${file}.bak`;
    backupFile(file, backup);
    mode = hasSecret ? 0o600 : statSync(file).mode & 0o777;
  }
  writeFileAtomicExclusive(file, text, { mode, overwrite: true });
  return backup;
}

export function register(program: Command, ctx: Ctx): void {
  const mcp = program.command("mcp").description("Connect Claude, Cursor, Codex, VS Code and other AI clients to the Vobiz MCP server");
  const clientList = CLIENTS.join(" | ");

  const addModeOptions = (cmd: Command) =>
    cmd
      .argument("<client>", clientList)
      .addOption(new Option("--hosted", `use the hosted connector ${HOSTED_URL} with OAuth sign-in (default)`).conflicts("local"))
      .addOption(new Option("--local", `run \`npx -y ${LOCAL_PACKAGE}\` on this machine with your Auth ID and Auth Token`).conflicts("hosted"))
      .option("--project", "use the project config in the current directory (claude-code, cursor, vscode, gemini)")
      .option("--dir <path>", "project directory for --project (default: the current directory)")
      .option("--name <name>", "server name in the client config", "vobiz");

  addModeOptions(
    mcp
      .command("install")
      .description("Add the Vobiz MCP server to an AI client's config file (merged; other servers are kept)"),
  )
    .option("--with-credentials", "with --local: copy the current profile's Auth ID and Auth Token into the file (the file will then contain your token)")
    .addHelpText(
      "after",
      `
Files written (user scope unless --project):
  claude       Claude Desktop claude_desktop_config.json (--local only; --hosted prints the Connectors steps)
  claude-code  ~/.claude.json, or .mcp.json with --project
  cursor       ~/.cursor/mcp.json, or .cursor/mcp.json
  codex        ~/.codex/config.toml ($CODEX_HOME)
  windsurf     ~/.config/devin/mcp_config.json
  vscode       VS Code user mcp.json, or .vscode/mcp.json
  gemini       ~/.gemini/settings.json, or .gemini/settings.json
  zed          ~/.config/zed/settings.json

The hosted connector signs in with OAuth, so no secret is written. --local reads VOBIZ_AUTH_ID/VOBIZ_AUTH_TOKEN
from your environment where the client supports it (Claude Desktop and Zed get placeholders to replace, or use
--with-credentials). An existing file is backed up to <file>.bak before it changes.

Examples:
  vobiz mcp install cursor
  vobiz mcp install claude-code --project
  vobiz mcp install claude --local --with-credentials
  vobiz mcp install codex --local --dry-run`,
    )
    .action(async (client: string, opts: ModeOpts & { withCredentials?: boolean }) => {
      const spec = clientSpec(client);
      const mode = modeOf(opts);
      const name = validName(opts.name);
      if (opts.withCredentials && mode !== "local") throw new VobizError("invalid_input", "--with-credentials needs --local (the hosted connector signs in with OAuth).");
      const file = targetPath(ctx, spec, mode, opts);
      if (!file) {
        ctx.out.status(`${spec.title} adds the hosted Vobiz connector in its settings, not in a file:`);
        ctx.out.status(spec.next(mode));
        ctx.out.status(`For a local server instead, run: vobiz mcp install ${spec.id} --local`);
        if (ctx.out.explicitJson) ctx.out.print({ client: spec.id, mode, url: HOSTED_URL, file: null, steps: spec.next(mode) });
        return;
      }
      const creds: Credentials | undefined = opts.withCredentials ? { authId: ctx.creds.authId, authToken: ctx.creds.authToken } : undefined;

      assertNotSymlink(file, "the client config");
      assertNotSymlink(`${file}.bak`, "the backup");
      if (opts.project) assertInsideDir(file, resolve(opts.dir ?? process.cwd()));
      const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
      let merged: MergeResult;
      try {
        if (spec.format === "toml") {
          const frag = fragment(spec, mode, name, creds);
          merged = mergeToml(existing, spec.container, name, (frag[spec.container] as Record<string, Record<string, unknown>>)[name]);
        } else merged = mergeJson(existing, fragment(spec, mode, name, creds), file);
      } catch (e) {
        if (e instanceof VobizError) ctx.stdout.write(snippet(spec, mode, name, creds));
        throw e;
      }

      if (merged.status === "unchanged") {
        ctx.out.success(`${spec.title} already has this Vobiz MCP server in ${file}.`, { client: spec.id, mode, file, status: "unchanged" });
        return;
      }
      await requireConfirmation(ctx, {
        action: `${merged.status === "replaced" ? "Update" : "Add"} the Vobiz MCP server "${name}" in ${spec.title}`,
        details: {
          file,
          server: mode === "hosted" ? HOSTED_URL : `npx -y ${LOCAL_PACKAGE} (stdio)`,
          credentials: credentialNote(spec, mode, creds),
          ...(existing !== undefined ? { backup: `${file}.bak` } : {}),
        },
      });
      if (ctx.flags.dryRun) {
        // Dry-run output must never contain the token; show where it would go instead.
        ctx.stdout.write(snippet(spec, mode, name, creds ? { ...creds, authToken: REDACTED } : undefined));
        return;
      }
      // The file may have changed while the prompt waited (Claude Code rewrites ~/.claude.json constantly).
      if (!sameContent(file, existing)) throw new VobizError("invalid_input", `${file} changed while waiting for confirmation, so it was not written. Run the command again.`);
      const backup = writeConfig(file, merged.text, !!creds);
      ctx.out.success(`${merged.status === "replaced" ? "Updated" : "Added"} the Vobiz MCP server in ${file}${backup ? ` (backup: ${backup})` : ""}.`, {
        client: spec.id,
        mode,
        file,
        status: merged.status,
        backup: backup ?? null,
      });
      if (mode === "local" && !creds && !spec.envAware) ctx.out.warn(`Replace MA_XXXXXXXX and YOUR_AUTH_TOKEN in ${file} with your Auth ID and Auth Token, or re-run with --with-credentials.`);
      ctx.out.status(`Next: ${spec.next(mode)}`);
    });

  addModeOptions(mcp.command("config").description("Print the config snippet for an AI client without writing anything"))
    .addHelpText(
      "after",
      `
Prints the JSON (TOML for Codex) entry to paste into the client's config; the target file is shown on stderr.
Credentials are never included: the local snippet reads VOBIZ_AUTH_ID/VOBIZ_AUTH_TOKEN or uses placeholders.

Examples:
  vobiz mcp config cursor
  vobiz mcp config vscode --local > .vscode/mcp.json`,
    )
    .action((client: string, opts: ModeOpts) => {
      const spec = clientSpec(client);
      const mode = modeOf(opts);
      const name = validName(opts.name);
      const file = targetPath(ctx, spec, mode, opts);
      if (!file) {
        ctx.out.status(spec.next(mode));
        ctx.stdout.write(HOSTED_URL + "\n");
        return;
      }
      ctx.out.status(`# ${spec.title}: merge into ${file}`);
      ctx.stdout.write(snippet(spec, mode, name));
      ctx.out.status(`# Then: ${spec.next(mode)}`);
    });
}
