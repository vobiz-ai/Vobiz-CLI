# Vobiz CLI: notes for coding agents

This repository is the `vobiz` command-line interface (`@vobiz/cli`). [CONTRIBUTING.md](CONTRIBUTING.md) has the ground rules and how to add a command; read it before changing code.

- TypeScript, ESM, Node.js 22.12+. `npm run check` (lint, build, tests) must pass before you finish.
- Every API call comes from `spec/` through `op("<operationId>")`. Never invent endpoints or fields; record gaps in `docs/SPEC-GAPS.md`.
- Writes go through `requireConfirmation` and support `--dry-run`. Never print or log a token. Stdout is data only.
- Tests use the fake API in `test/helpers.ts` and never reach the network. Never place calls, send messages or buy numbers while testing.
- Generated files: `src/generated/operations.ts` (`npm run gen`), `docs/COMMANDS.md` (`npm run docs:commands`), `completions/` and `man/` (`npm run build:assets`). Regenerate instead of editing.
- Use `MA_XXXXXXXX` and `YOUR_AUTH_TOKEN` in examples. Link to https://www.vobiz.ai/docs/concepts/ip-whitelisting instead of listing IP addresses.
- Write **Vobiz** for the product, active voice, sentence-case headings.
