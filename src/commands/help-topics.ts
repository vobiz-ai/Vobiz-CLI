/**
 * `vobiz help [command…|topic]`. Replaces commander's built-in help command so it can also serve the extra
 * topics scripts and agents need: exit-codes, env and output.
 */
import type { Command } from "commander";
import { findCommand } from "../cli.js";
import type { Ctx } from "../core/context.js";
import { EXIT, VobizError, type ErrorKind } from "../core/errors.js";
import { EXIT_CODE_DOCS } from "../core/exit-codes.js";

/** `vobiz help exit-codes`: the shared table (src/core/exit-codes.ts), then the error kinds behind each code. */
function exitCodesText(): string {
  const pad = (n: number) => String(n).padStart(3);
  const kinds = new Map<number, string[]>();
  for (const [kind, code] of Object.entries(EXIT)) {
    if (kind === "ok" || kind === "usage") continue;
    kinds.set(code, [...(kinds.get(code) ?? []), kind as ErrorKind]);
  }
  return [
    "Exit codes (stable; scripts may branch on them)",
    "",
    ...EXIT_CODE_DOCS.map((e) => `${pad(e.code)}  ${e.meaning}`),
    "",
    'Error kinds by exit code (the "error" field of the JSON error line):',
    "",
    ...[...kinds].sort(([a], [b]) => a - b).map(([code, list]) => `${pad(code)}  ${list.join(", ")}`),
    "",
    `After exit 7: ${EXIT_CODE_DOCS.find((e) => e.code === 7)?.agent ?? ""}`,
    "",
    "With --output json, jsonl or yaml, or whenever stdout is not a terminal, errors are printed to stderr as one JSON line:",
    '  {"error":"<kind>","message":"…","status":<http status or null>,"retryable":<bool>,"hint":"…"}',
    "",
  ].join("\n");
}

export const HELP_TOPICS: Record<string, { summary: string; text: string }> = {
  "exit-codes": {
    summary: "stable exit codes for scripts",
    text: exitCodesText(),
  },
  env: {
    summary: "environment variables",
    text: `Environment variables

  VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN   credentials (CI); take precedence over saved profiles, not over flags
  VOBIZ_PROFILE                     saved profile to use (like --profile)
  VOBIZ_OUTPUT                      table | json | yaml | tsv | plain | jsonl (like --output)
  VOBIZ_YES                         1 or true: skip confirmation prompts (like --yes)
  VOBIZ_BASE_URL                    voice API base URL (default https://api.vobiz.ai)
  VOBIZ_SMS_BASE_URL                Messaging API base URL (default https://api.vobiz.ai/api/v1/sms)
  VOBIZ_ALLOW_INSECURE_BASE_URL=1   allow http base URLs on localhost only (base URLs must otherwise be https)
  VOBIZ_ALLOW_ANY_BASE_URL=1        allow base URLs outside *.vobiz.ai; your token goes there (warns on every run)
  VOBIZ_TIMEOUT                     per-request timeout in seconds (default 30)
  VOBIZ_LOG=debug                   like --debug (request and response bodies, secrets redacted)
  VOBIZ_WEBHOOK_SECRET              signing secret for webhooks verify|listen (like --secret)
  VOBIZ_NO_BROWSER                  never open a browser (feedback, docs open, login --browser); print the URL
                                    instead (also when CI is set or not a TTY)
  VOBIZ_CONFIG_DIR                  config directory (default $XDG_CONFIG_HOME/vobiz or ~/.config/vobiz)
  VOBIZ_CACHE_DIR                   cache directory (standalone binaries unpack the bundled skills here)
  VOBIZ_NO_UPDATE_CHECK, CI         disable the daily version check
  NO_COLOR, FORCE_COLOR             standard color control
  HTTPS_PROXY, NO_PROXY             used by Node's fetch only when NODE_USE_ENV_PROXY=1 (Node 22.21+ or 24+)

Credential order: --auth-id/--auth-token flags, then VOBIZ_AUTH_ID/VOBIZ_AUTH_TOKEN, then the profile chosen by
--profile, VOBIZ_PROFILE, the configured default, or "default".
`,
  },
  output: {
    summary: "output formats, --fields, --query and --quiet",
    text: `Output

stdout carries data only; progress, prompts, warnings and errors go to stderr, so pipes stay clean.

  --output table   aligned columns truncated to the terminal width (default on a terminal)
  --output json    pretty JSON (default when stdout is piped); --json is a shorthand
  --output yaml    YAML
  --output tsv     a header row, then tab-separated rows; nested values as compact JSON
  --output plain   rows without header or truncation; "key: value" lines for a single record
  --output jsonl   one compact JSON value per line: every row of a list, or the single record

  --fields id,meta.total   keep only these dot paths (columns in table/tsv, nested keys in json/yaml)
  --query items[*].e164    then print only this path: dot keys plus [n], [-1] (last) and [*] (every element);
                           it reads the data as that mode prints it (see the shape with --json)
  --quiet, -q              print only the id of each row, one per line (for xargs)
  --dry-run                print the request that would be sent (token and secrets redacted) and exit 0

Text meant for people (table, plain, tsv, --quiet, messages) has terminal escape sequences and control
characters removed, so API data cannot clear the screen or rewrite the clipboard; json and yaml are verbatim.
In tsv, a cell starting with = + - or @ (other than a plain number) gets a leading ' so a spreadsheet does not
run it as a formula. CSV files from the API (cdr export, sms broadcasts export) are saved byte for byte; open
them with formulas disabled, or import them as text.

Secret fields (auth_token, auth_secret, password, secret, token, client_secret, private_key) are always shown
as [redacted]. Only --debug --show-secrets prints them.

A change command (create, update, delete, buy, send) prints a sentence to stderr in table/plain mode and the
API response to stdout in json/jsonl/yaml/tsv mode.
`,
  },
};

export function register(program: Command, ctx: Ctx): void {
  program
    .command("help")
    .description(`Show help for a command, or a topic: ${Object.keys(HELP_TOPICS).join(", ")}`)
    .argument("[words...]", "command words (e.g. profiles use) or a topic")
    .action((words: string[] = []) => {
      if (!words.length) {
        program.outputHelp();
        ctx.stdout.write(`\nHelp topics:\n${Object.entries(HELP_TOPICS).map(([k, v]) => `  vobiz help ${k.padEnd(11)} ${v.summary}`).join("\n")}\n`);
        return;
      }
      const topic = HELP_TOPICS[words.join(" ")];
      if (topic) {
        ctx.stdout.write(topic.text);
        return;
      }
      const cmd = findCommand(program, words);
      if (!cmd) throw new VobizError("invalid_input", `No command or help topic "${words.join(" ")}". Topics: ${Object.keys(HELP_TOPICS).join(", ")}.`);
      cmd.outputHelp();
    });
}
