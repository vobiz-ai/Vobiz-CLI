/**
 * Secret-valued flags (`--password`, `--secret`). A literal value works but lands in shell history, so it warns
 * like `--auth-token` does; `@path` reads the value from a file and `@-` from stdin (one trailing newline is
 * dropped). A literal secret that starts with "@" must therefore come from a file.
 */
import { readFileSync } from "node:fs";
import type { Ctx } from "./context.js";
import { VobizError } from "./errors.js";
import { rememberSecret } from "./redact.js";

const chomp = (s: string): string => s.replace(/\r?\n$/, "");

export async function readSecretArg(ctx: Ctx, value: string, flag: string): Promise<string> {
  let secret: string;
  if (value === "@-") secret = chomp(await ctx.stdin.read());
  else if (value.startsWith("@")) {
    try {
      secret = chomp(readFileSync(value.slice(1), "utf8"));
    } catch {
      throw new VobizError("invalid_input", `${flag}: cannot read ${value.slice(1)}.`);
    }
  } else {
    ctx.log("warn", `${flag} on the command line is saved in your shell history. Prefer ${flag} @file or ${flag} @- (stdin).`);
    rememberSecret(value);
    return value;
  }
  if (!secret) throw new VobizError("invalid_input", `${flag}: ${value === "@-" ? "stdin" : value.slice(1)} is empty.`);
  rememberSecret(secret);
  return secret;
}
