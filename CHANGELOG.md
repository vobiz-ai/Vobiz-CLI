# Changelog

All notable changes to the Vobiz CLI are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (`0.x` minors may include breaking changes).

## [Unreleased]

## [0.1.2] - 2026-10-23

### Fixed

- The release workflow publishes the packed tarball by an explicit `./pack/...` path. npm read the bare `pack/vobiz-cli-<version>.tgz` as a GitHub `owner/repo` shorthand and tried to clone it, so 0.1.1 never reached npm. 0.1.2 is the first version on npm; it is otherwise identical to 0.1.1.

## [0.1.1] - 2026-10-23

### Added

- `sms send --max-wait <seconds>` bounds `--wait` (default: `--timeout`), like `calls create --max-wait`.
- Aliases for the standard verbs: `skills ls`, `profiles delete`, `account get`.

### Changed

- Usage errors from argument parsing (unknown option or command, missing argument) print the same one-line JSON
  error as every other failure (`invalid_input`, exit 2) when output is JSON (piped stdout, `--json`,
  `-o json|jsonl|yaml`); text mode is unchanged.
- `webhooks verify`, `webhooks listen` and `setup sms` read `--secret @file` and `--secret @-` (stdin) like every
  other secret flag; before, the value was used literally.
- `streams test` accepts `ws://` on localhost without `--allow-insecure-url`, and `--allow-insecure-url` now allows
  a remote `ws://` server, the same rule as `streams forward`.
- `partner accounts cdrs` and `partner accounts transactions` accept `--from`/`--to` for their date window, like
  `cdr`, `account transactions` and `recordings export`.
- The Docker image sets `VOBIZ_DOCKER=1`, so `vobiz update` suggests `docker pull`.
- Help text: flag descriptions taken from the spec use the CLI's help voice and flag names, and deprecated aliases
  read the same everywhere.
- `calls list` accepts `--limit` and `--all` like every other list; the live and queued call endpoints return one
  page, so `--limit` trims it in the CLI.
- `vobiz update` reports `install_method: "source"` (and suggests `git pull && npm ci && npm run build`) when it runs
  from a git checkout.
- New `docs/ARCHITECTURE.md` (command tree conventions, safety model, output modes, exit codes), linked from the
  README, CONTRIBUTING and CLAUDE.md.
- `scripts/pack-guard.mjs` fails the pack when README, CHANGELOG or LICENSE would be missing from the package.

### Fixed

- `--dry-run` is honoured by local writes: `config set`/`unset`, `profiles use`/`rename`, `login` and `logout` print
  a `[dry-run]` line and the change, and write nothing (`profiles remove`, `skills install`/`update` and
  `mcp install` already did).
- `vobiz completion bash` scoped value completion per command: a flag shared by several commands (`--status`,
  `--type`, `--format`, `--direction`) offered the first command's values everywhere.
- The "come from third parties" note on stderr names only fields that are printed: `cdr` with `--fields` or `--query`
  that leave `caller_id_name` out, and tables whose columns leave the field out, no longer print it.
- Comment cleanup in tests, scripts and sources.

### Security

- `scripts/sync-skills.mjs` and `scripts/sync-spec.mjs` check status, content type and size of downloads, verify
  the tag's commit, vet archive members before extracting and write only inside `skills/` or `spec/`; the path
  template filler and the `recordings export --email` check run in linear time.

## [0.1.0] - 2026-10-23

### Added

- `vobiz` command tree (278 commands) covering every operation in the Vobiz Voice and Messaging OpenAPI documents:
  `login`/`logout`/`whoami`/`profiles`/`config`/`doctor`, `account`, `calls` (create with `--wait`, in-call control,
  audio streams, `watch`), `conferences`, `recordings`, `cdr`, `numbers`, `trunks` (credentials, IP ACLs, origination
  URIs), `apps`, `endpoints`, `sub-accounts` (KYC, test mode), `partner`, the full `sms` tree (send with cost preview
  and idempotency, conversations, opt-outs, webhooks, broadcasts, RCS senders, 10DLC), `xml build|validate|serve`,
  `webhooks verify|listen`, `vobiz api` for raw requests with `--list`/`--describe`, and `completion`.
- Agent tooling: `mcp install|config` for Claude, Claude Code, Cursor, Codex, Windsurf, VS Code, Gemini and Zed;
  `skills list|install|update` shipping the 15 Vobiz Agent Skills; `docs search|open` over the Vobiz Docs MCP server;
  `diagnose call|message` with plain-language explanations from the documented hangup-cause and status tables;
  `streams test|forward` for voice-agent WebSocket endpoints; `setup voice-agent|sms` composites; `feedback`.
- Safety model: every write asks for confirmation, refuses without `--yes` when stdin is not a terminal, supports
  `--dry-run`, and is marked side-effecting so a transport failure exits 7 (outcome unknown) instead of retrying.
  Secrets (`auth_secret`, tokens, passwords, webhook secrets) are redacted everywhere; credentials are stored 0600.
- Output modes `table`, `json`, `jsonl`, `yaml`, `tsv`, `plain`, with `--fields`, `--query`, `--quiet`, and stable
  exit codes (`vobiz help exit-codes`).
- Distribution: npm (`@vobiz/cli`, trusted publishing with provenance), standalone binaries for macOS, Linux and
  Windows with `SHA256SUMS` and build-provenance attestations, `install.sh` and `install.ps1`, a Homebrew formula,
  a Scoop manifest and a multi-arch Docker image (`ghcr.io/vobiz-ai/vobiz-cli`).
- Shell completions for bash, zsh, fish and PowerShell, a man page and `docs/COMMANDS.md`, all generated from the
  command tree.
- CI on Node.js 22 and 24 (lint, build, tests, spec and docs drift, package and Docker smoke tests, a standalone
  binary build), CodeQL, OpenSSF Scorecard and Dependabot.

[Unreleased]: https://github.com/vobiz-ai/Vobiz-CLI/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/vobiz-ai/Vobiz-CLI/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/vobiz-ai/Vobiz-CLI/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/vobiz-ai/Vobiz-CLI/releases/tag/v0.1.0
