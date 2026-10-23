# Vobiz CLI architecture

How the `vobiz` command tree is organised and the rules every command follows. [COMMANDS.md](COMMANDS.md) lists
every command and flag; [CONTRIBUTING.md](../CONTRIBUTING.md) explains how to add one.

## Layout

```
src/index.ts             bin entry: builds the program, runs it, maps errors to exit codes
src/cli.ts               buildProgram(): global flags and every command group
src/commands/<group>.ts  one module per group, exporting register(program, ctx)
src/commands/index.ts    the list of groups, in help order
src/core/                client, config and profiles, credentials, confirmation, output, pagination, errors
src/agent/               VobizXML builder, webhook signatures, WebSocket codec, MCP client configs, docs search
src/generated/           operations.ts, generated from spec/ by `npm run gen`
spec/                    the vendored Vobiz Voice and Messaging OpenAPI documents
```

## Command tree conventions

- **Spec-driven.** Every HTTP call resolves an operation by id: `ctx.client.call(op("make-call"), { path, query, body })`.
  `op()` fails at startup if the id is missing, so a spec rename breaks the build, not a user. Behaviour the spec does
  not describe goes to [SPEC-GAPS.md](SPEC-GAPS.md), not into code.
- **Nouns and verbs.** `vobiz <noun> <verb>`: plural nouns (`numbers`, `trunks`), standard verbs
  (`list get create update delete`) plus domain verbs (`calls hangup`, `numbers buy`). Ids are positional, flags are
  kebab-case, phone numbers are E.164.
- **Your account only.** Account paths come from the resolved Auth ID; no command accepts an account id.
- **Lists.** `--limit` caps the number of records, `--all` follows pagination; single-page endpoints apply `--limit`
  on the client.

## Safety model

- Every billable, destructive or account-changing command goes through `requireConfirmation`: it prints the account,
  destination, caller ID, URL host and price when known, then asks. Without a terminal it needs `--yes` (exit `6`).
- `--dry-run` prints the exact request, secrets redacted, and sends nothing.
- Side-effecting requests are never retried. A timeout or 5xx on a write exits `7` (outcome unknown).
- Credentials resolve as flags > environment > profile, are sent only to `https://*.vobiz.ai`, are stored with mode
  0600 and are never printed or logged. `--debug` redacts secrets in bodies.
- Answer, callback and stream URLs must be HTTPS (plain HTTP only for localhost or with `--allow-insecure-url`).

## Output modes

- `--output table|json|jsonl|yaml|tsv|plain` (`--json` is short for `--output json`). Default: `table` on a terminal,
  `json` when stdout is piped.
- `--fields a,b.c` projects keys, `--query <path>` prints one path of the result, `--quiet` prints one id per line.
- Stdout carries data only. Progress, hints, warnings and errors go to stderr.
- Third-party text (message bodies, caller names, webhook payloads) is listed in `_untrusted_fields`.

## Errors and exit codes

In JSON mode a failure writes one line to stderr: `{"error","message","status","retryable","hint"}`. The exit codes
are stable (`vobiz help exit-codes`):

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Server error or unknown failure |
| 2 | Usage error or invalid input |
| 3 | Authentication failed, credentials missing, or forbidden |
| 4 | Not found |
| 5 | Rate limited or insufficient balance |
| 6 | Confirmation required (pass `--yes`) or not allowed |
| 7 | Outcome unknown: a side-effecting request timed out, lost its connection or got a 5xx; check state first |
| 8 | Timeout or network error on a read (nothing was changed; safe to retry) |
| 130 | Interrupted (Ctrl-C) |

## Generated files

`src/generated/operations.ts` (`npm run gen`), `docs/COMMANDS.md` (`npm run docs:commands`), `completions/` and
`man/` (`npm run build:assets`) are generated from the spec and the built command tree. Regenerate them; never edit
them by hand.
