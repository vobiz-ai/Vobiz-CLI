# Contributing to the Vobiz CLI

Thanks for helping make the Vobiz CLI better. Bug reports, fixes, new commands and documentation are all welcome.

## Ground rules

- **Spec first.** Every HTTP call comes from an operation in the vendored OpenAPI documents in `spec/` (`ctx.client.call(op("<operationId>"), …)`). Don't invent fields or paths. If the API does something the spec does not describe, add an entry to [`docs/SPEC-GAPS.md`](docs/SPEC-GAPS.md) instead. `npm run spec:sync` refreshes `spec/` from the published Vobiz docs.
- **Safe by default.** Any command that spends money, contacts a real person, or changes or deletes something must:
  - go through `requireConfirmation` (prompt on a terminal, exit code 6 without `--yes` otherwise)
  - support `--dry-run`
  - print the destination, caller ID and URL host for calls and messages
  - never retry on its own
- **No secrets in output or logs.** Never print a token. `--verbose` logs route templates, not concrete paths; `--debug` redacts `authToken`, `password`, `secret` and `token`.
- **Your account only.** Build account paths from the resolved Auth ID. Never accept an account ID as an argument. Keep the API's path casing exactly.
- **Clean stdout.** Data goes to stdout; progress, hints and warnings go to stderr.
- **Naming.** Plural nouns, standard verbs (`list get create update delete`), sentence-case help text, and **Vobiz** for the product name.
- **Dependencies.** Prefer Node.js built-ins and the dependencies already in `package.json`; justify any new one in the PR.

## Development setup

Requirements: Node.js 22.12+ and npm.

```bash
git clone https://github.com/vobiz-ai/Vobiz-CLI.git
cd Vobiz-CLI
npm ci
npm run check          # lint (tsc --noUnusedLocals), build, all tests
npm run dev -- --help  # build and run
```

Live smoke tests use your own account and are read-only. They never place calls, send messages or buy numbers:

```bash
cp .env.example .env   # add VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN
npm run test:live
```

## Adding a command

1. Add or extend `src/commands/<group>.ts` (`export function register(program, ctx)`), registered in `COMMAND_GROUPS` in `src/commands/index.ts`.
2. Resolve the operation by its `operationId` with `op("…")`; a renamed operation then fails the build, not a user.
3. Throw `VobizError` with an existing error kind and an actionable message; the entry point maps it to the exit code.
4. Add tests in `test/` with the fake API (`test/helpers.ts`): assert method, path, query and body, and the JSON output. Tests must never reach the network.
5. Update the help snapshots (`npx vitest run -u`) and review the diff.
6. Regenerate the command reference: `npm run build && npm run docs:commands`. CI fails when `docs/COMMANDS.md` is stale.
7. Add a line under `## [Unreleased]` in `CHANGELOG.md`.

Shell completions (`npm run completions:gen`) and the man page (`npm run man:gen`) are generated from the same command tree at build time; don't edit `completions/` or `man/` by hand.

## Pull requests

- Keep each PR focused on one change. Describe it, how you tested it, and any API behaviour you relied on.
- CI must pass: lint, build and tests on Node.js 22 and 24, the spec and docs drift checks, `npm audit`, the package dry run, the Docker build and the standalone binary build.
- By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

## Reporting security issues

Please do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
