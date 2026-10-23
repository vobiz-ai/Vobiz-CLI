#!/usr/bin/env node
/**
 * `vobiz` bin entry. All behaviour lives in cli.ts `run()`; this file only wires the real process (argv,
 * streams, exit code) and turns Ctrl-C into exit 130.
 */
import { run } from "./cli.js";
import { Ctx } from "./core/context.js";

process.on("SIGINT", () => {
  process.stderr.write("\n");
  process.exit(130);
});
// A closed pipe (`vobiz api --list | head`) is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const ctx = new Ctx();
run(process.argv.slice(2), ctx).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`vobiz: internal_error: ${err instanceof Error ? err.message : String(err)}\nRun again with --verbose for details.\n`);
    process.exitCode = 1;
  },
);
