// Shared loader for the generators (completions, man page, docs/COMMANDS.md).
//
// It imports the BUILT CLI (dist/cli.js, from `npm run build`) and reads the real command tree, so the generated files
// can never drift from the code. Interface used (src/cli.ts):
//   buildProgram(ctxFactory?)  -> commander Command (or a Promise of one); preferred, walked directly
//   listCommandTree(program?)  -> fallback when buildProgram is not exported; nodes { name|path, description, children }
// Set VOBIZ_CLI_MODULE to another module path to run the generators against a fixture.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The documented, stable exit codes; keep in step with `vobiz help exit-codes` (src/commands/help-topics.ts). */
export const EXIT_CODES = [
  [0, "Success."],
  [1, "Server error or unknown failure."],
  [2, "Usage error or invalid input."],
  [3, "Authentication failed, credentials missing, or access forbidden."],
  [4, "Not found."],
  [5, "Rate limited or insufficient balance."],
  [6, "Confirmation required (pass --yes) or the action is not allowed."],
  [7, "Outcome unknown: a side-effecting request timed out, lost its connection or got a 5xx. Check the state before retrying."],
  [8, "Timeout or network error on a read (nothing was changed; safe to retry)."],
  [130, "Interrupted (Ctrl-C)."],
];

/**
 * @typedef {{ flags: string, long?: string, short?: string, description: string, takesValue: boolean, choices?: string[] }} OptionNode
 * @typedef {{ name: string, required: boolean, variadic: boolean, description: string }} ArgNode
 * @typedef {{ name: string, path: string[], description: string, aliases: string[], options: OptionNode[], args: ArgNode[], children: CommandNode[] }} CommandNode
 */

/** @returns {Promise<CommandNode>} */
export async function loadCommandTree() {
  const modulePath = resolve(root, process.env.VOBIZ_CLI_MODULE || "dist/cli.js");
  if (!existsSync(modulePath)) {
    process.stderr.write(`error: ${modulePath} is missing: run \`npm run build\` first\n`);
    process.exit(1);
  }
  // Importing the CLI must never touch the network or the user's config.
  process.env.VOBIZ_NO_UPDATE_CHECK = "1";
  process.env.NO_COLOR = "1";
  // Generated docs, completions and the man page always describe the public CLI, even from an internal build.
  process.env.VOBIZ_INTERNAL = "0";
  const mod = await import(pathToFileURL(modulePath).href);
  if (typeof mod.buildProgram === "function") {
    const program = await mod.buildProgram();
    return fromCommander(program, []);
  }
  if (typeof mod.listCommandTree === "function") {
    return fromPlainTree(await mod.listCommandTree(), []);
  }
  process.stderr.write(`error: ${modulePath} exports neither buildProgram nor listCommandTree\n`);
  process.exit(1);
}

function fromCommander(cmd, path) {
  const options = cmd.options
    .filter((o) => !o.hidden)
    .map((o) => ({
      flags: o.flags,
      long: o.long,
      short: o.short,
      description: o.description || "",
      takesValue: Boolean(o.required || o.optional),
      choices: o.argChoices ? [...o.argChoices] : undefined,
    }));
  if (!options.some((o) => o.long === "--help")) {
    options.push({ flags: "-h, --help", long: "--help", short: "-h", description: "Display help for the command", takesValue: false });
  }
  const args = (cmd.registeredArguments ?? cmd._args ?? []).map((a) => ({
    name: a.name(),
    required: Boolean(a.required),
    variadic: Boolean(a.variadic),
    description: a.description || "",
  }));
  const children = cmd.commands
    .filter((c) => !c._hidden && c.name() !== "help")
    .map((c) => fromCommander(c, [...path, c.name()]))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { name: cmd.name(), path, description: cmd.description() || "", aliases: cmd.aliases?.() ?? [], options, args, children };
}

function fromPlainTree(node, path) {
  const name = node.name ?? node.path?.at?.(-1) ?? "vobiz";
  const here = node.path ?? (path.length || name !== "vobiz" ? path : []);
  return {
    name,
    path: here,
    description: node.description ?? node.summary ?? "",
    aliases: node.aliases ?? [],
    options: (node.options ?? []).map((o) => ({
      flags: o.flags ?? o.long ?? "",
      long: o.long ?? /--[\w-]+/.exec(o.flags ?? "")?.[0],
      short: o.short ?? /(^|[ ,])(-\w)\b/.exec(o.flags ?? "")?.[2],
      description: o.description ?? "",
      takesValue: o.takesValue ?? /[<[]/.test(o.flags ?? ""),
      choices: o.choices,
    })),
    args: (node.args ?? node.arguments ?? []).map((a) => ({
      name: a.name,
      required: Boolean(a.required),
      variadic: Boolean(a.variadic),
      description: a.description ?? "",
    })),
    children: (node.children ?? node.commands ?? [])
      .filter((c) => !c.hidden)
      .map((c) => fromPlainTree(c, [...here, c.name ?? c.path?.at?.(-1)])),
  };
}

/** Depth-first list of every command node, root first. */
export function flatten(node) {
  return [node, ...node.children.flatMap(flatten)];
}

/** "vobiz calls create <uuid> [options]" */
export function usageLine(node) {
  const parts = ["vobiz", ...node.path];
  for (const a of node.args) parts.push(a.required ? `<${a.name}${a.variadic ? "..." : ""}>` : `[${a.name}${a.variadic ? "..." : ""}]`);
  if (node.children.length) parts.push("<command>");
  if (node.options.length) parts.push("[options]");
  return parts.join(" ");
}

export async function readVersion() {
  const { readFileSync } = await import("node:fs");
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
}
