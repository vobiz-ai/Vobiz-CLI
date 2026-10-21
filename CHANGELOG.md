# Changelog

All notable changes to the Vobiz CLI are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (`0.x` minors may include breaking changes).

## [Unreleased]

### Added

- `vobiz` command tree (277 commands) covering every operation in the Vobiz Voice and Messaging OpenAPI documents:
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

[Unreleased]: https://github.com/vobiz-ai/Vobiz-CLI/commits/main
