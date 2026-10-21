# Changelog

All notable changes to the Vobiz CLI are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (`0.x` minors may include breaking changes).

## [Unreleased]

### Added

- `vobiz` command covering the Vobiz Voice and Messaging APIs: login and profiles, account, calls and in-call control,
  conferences, recordings, call records, phone numbers, SIP trunks, applications, SIP endpoints, sub-accounts and KYC,
  the partner API, SMS/MMS/RCS, VobizXML, webhook verification, `vobiz api` for raw requests, and the agent commands
  (`vobiz mcp`, `vobiz skills`, `vobiz docs`).
- Distribution: npm (`@vobiz/cli`, trusted publishing with provenance), standalone binaries for macOS, Linux and
  Windows with `SHA256SUMS` and build-provenance attestations, `install.sh` and `install.ps1`, a Homebrew formula,
  a Scoop manifest and a multi-arch Docker image (`ghcr.io/vobiz-ai/vobiz-cli`).
- Shell completions for bash, zsh, fish and PowerShell, a man page and `docs/COMMANDS.md`, all generated from the
  command tree.
- CI on Node.js 22 and 24 (lint, build, tests, spec and docs drift, package and Docker smoke tests, a standalone
  binary build), CodeQL, OpenSSF Scorecard and Dependabot.

[Unreleased]: https://github.com/vobiz-ai/Vobiz-CLI/commits/main
