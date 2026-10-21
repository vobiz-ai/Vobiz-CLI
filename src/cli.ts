/**
 * Builds the `vobiz` command tree and runs it. Command groups live in src/commands/<group>.ts and each exports
 * `register(program, ctx)`; src/commands/index.ts lists them, so adding a group is one import and one array entry.
 *
 * `run(argv, ctx)` is the whole CLI as a function: it never calls process.exit, which is what lets command tests
 * drive it with a fake fetch and captured streams (see test/helpers.ts `runCli`).
 */
import { Command, CommanderError, Option } from "commander";
import { COMMAND_GROUPS } from "./commands/index.js";
import { DryRunSignal } from "./core/client.js";
import type { Ctx, GlobalFlags } from "./core/context.js";
import { EXIT, VobizError } from "./core/errors.js";
import { assertSecureBaseUrl } from "./core/credentials.js";
import { OUTPUT_MODES, toVobizError, type OutputMode } from "./core/output.js";
import { startUpdateCheck } from "./core/update.js";
import { CLI_VERSION } from "./core/version.js";

export type { Ctx };
export type RegisterFn = (program: Command, ctx: Ctx) => void;

/** Raw global option values as commander parses them (before env defaults and validation). */
interface RawGlobals {
  profile?: string;
  authId?: string;
  authToken?: string;
  output?: OutputMode;
  json?: boolean;
  fields?: string;
  quiet?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  wait?: boolean;
  baseUrl?: string;
  smsBaseUrl?: string;
  timeout?: string;
  color?: boolean;
  verbose?: boolean;
  debug?: boolean;
  showSecrets?: boolean;
  updateCheck?: boolean;
}

/** Global flags, PLAN §3. Every one is accepted before or after the subcommand. */
function addGlobalOptions(program: Command): void {
  program
    .option("--profile <name>", "saved login to use (env: VOBIZ_PROFILE)")
    .option("--auth-id <id>", "one-off Auth ID (env: VOBIZ_AUTH_ID)")
    .option("--auth-token <token>", "one-off Auth Token; lands in shell history (env: VOBIZ_AUTH_TOKEN)")
    .addOption(new Option("-o, --output <format>", "output format (env: VOBIZ_OUTPUT; default: table on a terminal, json when piped)").choices(OUTPUT_MODES))
    .option("--json", "shorthand for --output json")
    .option("--fields <paths>", "comma-separated fields to show (dot paths, e.g. id,meta.total)")
    .option("-q, --quiet", "print only ids, one per line")
    .option("-y, --yes", "skip confirmation prompts; required for writes when stdin is not a terminal (env: VOBIZ_YES)")
    .option("--dry-run", "show the request (secrets redacted) and exit without sending")
    .option("--wait", "for calls and messages: wait until a final status")
    .option("--base-url <url>", "voice API base URL (env: VOBIZ_BASE_URL)")
    .option("--sms-base-url <url>", "Messaging API base URL (env: VOBIZ_SMS_BASE_URL)")
    .option("--timeout <seconds>", "per-request timeout in seconds (env: VOBIZ_TIMEOUT; default: 30)")
    .option("--no-color", "disable colors (env: NO_COLOR)")
    .option("--verbose", "log requests (method, route, status, duration) to stderr")
    .option("--debug", "also log request and response bodies, secrets redacted (env: VOBIZ_LOG=debug)")
    .addOption(new Option("--show-secrets", "with --debug, print secret fields unredacted").hideHelp())
    .option("--no-update-check", "skip the daily version check (env: VOBIZ_NO_UPDATE_CHECK, CI)");
}

/** Turns commander's values plus env defaults into ctx.flags. Throws invalid_input for bad values. */
export function resolveGlobalFlags(raw: RawGlobals, env: NodeJS.ProcessEnv): GlobalFlags {
  const timeoutText = raw.timeout ?? env.VOBIZ_TIMEOUT;
  const timeout = timeoutText === undefined ? 30 : Number(timeoutText);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600) throw new VobizError("invalid_input", `--timeout must be a number of seconds between 1 and 3600 (got "${timeoutText}").`);
  if (raw.baseUrl !== undefined) assertSecureBaseUrl(raw.baseUrl, "--base-url", env);
  if (raw.smsBaseUrl !== undefined) assertSecureBaseUrl(raw.smsBaseUrl, "--sms-base-url", env);
  return {
    profile: raw.profile,
    authId: raw.authId,
    authToken: raw.authToken,
    output: raw.output,
    json: raw.json,
    fields: raw.fields ? raw.fields.split(",").map((f) => f.trim()).filter(Boolean) : undefined,
    quiet: raw.quiet,
    yes: raw.yes,
    dryRun: raw.dryRun,
    wait: raw.wait,
    baseUrl: raw.baseUrl,
    smsBaseUrl: raw.smsBaseUrl,
    timeout,
    color: raw.color !== false && !env.NO_COLOR,
    verbose: raw.verbose,
    debug: raw.debug || env.VOBIZ_LOG === "debug",
    showSecrets: raw.showSecrets,
    updateCheck: raw.updateCheck !== false,
  };
}

export function buildProgram(ctx: Ctx): Command {
  const program = new Command("vobiz");
  program
    .description("Vobiz CLI: voice calls, conferences, SMS/MMS/RCS, phone numbers, SIP trunks, VobizXML and the Vobiz agent tools.")
    .version(CLI_VERSION, "-V, --version", "print the CLI version")
    .helpCommand(false)
    .showHelpAfterError("(run with --help for usage)")
    .configureHelp({ showGlobalOptions: false, sortSubcommands: false })
    .configureOutput({
      writeOut: (s) => void ctx.stdout.write(s),
      writeErr: (s) => void ctx.stderr.write(s),
      outputError: (s, write) => write(`vobiz: usage: ${s.replace(/^error: /, "")}`),
      getOutHelpWidth: () => ctx.stdout.columns ?? 80,
      getErrHelpWidth: () => ctx.stderr.columns ?? 80,
    })
    .exitOverride();
  addGlobalOptions(program);
  program.addHelpText(
    "after",
    "\nRun `vobiz help exit-codes`, `vobiz help env` or `vobiz help output` for scripting details.\nDocs: https://www.vobiz.ai/docs",
  );

  program.hook("preAction", () => {
    ctx.flags = resolveGlobalFlags(program.opts<RawGlobals>(), ctx.env);
    ctx.resetAuth();
    if (ctx.flags.authToken) ctx.log("warn", "--auth-token is saved in your shell history. Prefer `vobiz login` or VOBIZ_AUTH_TOKEN.");
    if (ctx.flags.showSecrets && !ctx.flags.debug) ctx.log("warn", "--show-secrets has no effect without --debug.");
  });

  for (const register of COMMAND_GROUPS) register(program, ctx);
  return program;
}

/** One node per command, for completion scripts and generated docs. Hidden commands are left out. */
export interface CommandNode {
  name: string;
  /** Words after `vobiz`, e.g. ["profiles", "use"]. */
  path: string[];
  description: string;
  aliases: string[];
  args: { name: string; required: boolean; variadic: boolean }[];
  options: { flags: string; long?: string; short?: string; description: string; choices?: string[]; takesValue: boolean }[];
  subcommands: CommandNode[];
}

export function listCommandTree(cmd: Command, parentPath: string[] = []): CommandNode {
  const isRoot = !cmd.parent;
  const path = isRoot ? [] : [...parentPath, cmd.name()];
  return {
    name: cmd.name(),
    path,
    description: cmd.description(),
    aliases: cmd.aliases(),
    args: cmd.registeredArguments.map((a) => ({ name: a.name(), required: a.required, variadic: a.variadic })),
    options: cmd.options
      .filter((o) => !(o as Option & { hidden?: boolean }).hidden)
      .map((o) => ({
        flags: o.flags,
        long: o.long,
        short: o.short,
        description: o.description,
        choices: o.argChoices,
        takesValue: o.required || o.optional,
      })),
    subcommands: cmd.commands.filter((c) => !(c as Command & { _hidden?: boolean })._hidden).map((c) => listCommandTree(c, path)),
  };
}

/** Finds a command by its words (["profiles", "use"]); undefined when there is none. */
export function findCommand(program: Command, words: string[]): Command | undefined {
  let cur: Command | undefined = program;
  for (const w of words) {
    cur = cur.commands.find((c: Command) => c.name() === w || c.aliases().includes(w));
    if (!cur) return undefined;
  }
  return cur;
}

const isPromptExit = (err: unknown) => err instanceof Error && (err.name === "ExitPromptError" || err.name === "AbortPromptError");

/** Runs the CLI with `argv` (the words after `vobiz`) and resolves with the exit code. Never exits the process. */
export async function run(argv: string[], ctx: Ctx): Promise<number> {
  let program: Command;
  try {
    program = buildProgram(ctx);
  } catch (err) {
    ctx.out.printError(err);
    return EXIT.internal_error;
  }
  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }
  let update: { finish(): Promise<void> } | undefined;
  program.hook("preAction", () => {
    update ??= startUpdateCheck(ctx);
  });
  try {
    await program.parseAsync(argv, { from: "user" });
    return ctx.exitCode;
  } catch (err) {
    if (err instanceof DryRunSignal) {
      ctx.out.print(err.request);
      return 0;
    }
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version" || err.exitCode === 0) return 0;
      return EXIT.usage;
    }
    if (isPromptExit(err)) {
      ctx.stderr.write("\nCancelled.\n");
      return 130;
    }
    ctx.out.printError(err);
    if (!(err instanceof VobizError)) {
      if (ctx.flags.verbose || ctx.flags.debug) ctx.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
      else ctx.stderr.write("Run again with --verbose for details.\n");
    }
    return toVobizError(err).exitCode;
  } finally {
    await update?.finish();
  }
}
