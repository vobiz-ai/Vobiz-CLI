# Vobiz CLI

The official command-line interface for [Vobiz](https://www.vobiz.ai). Run everything you do with a Vobiz account from your terminal, scripts and CI:

- place and control voice calls, run conferences, record calls and stream call audio
- read call records (CDRs) and recordings
- search, buy and assign phone numbers
- manage SIP trunks, credentials, IP access lists, origination URIs, applications and SIP endpoints
- manage sub-accounts and their KYC, and the partner API
- check balance, concurrency and transactions
- send SMS, MMS and RCS, and manage conversations, opt-outs, webhooks, broadcasts, senders and 10DLC
- build and validate VobizXML, verify webhook signatures, and set up the Vobiz MCP server and Agent Skills for AI agents

[![CI](https://github.com/vobiz-ai/Vobiz-CLI/actions/workflows/ci.yml/badge.svg)](https://github.com/vobiz-ai/Vobiz-CLI/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@vobiz/cli)](https://www.npmjs.com/package/@vobiz/cli)
[![Release](https://img.shields.io/github/v/release/vobiz-ai/Vobiz-CLI)](https://github.com/vobiz-ai/Vobiz-CLI/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

| | |
|---|---|
| **Binary** | `vobiz` (npm package `@vobiz/cli`, image `ghcr.io/vobiz-ai/vobiz-cli`) |
| **Coverage** | Every operation in the Vobiz Voice and Messaging OpenAPI documents, plus `vobiz api` for raw requests |
| **Output** | `table` on a terminal, `json` when piped, plus `yaml`, `tsv` and `plain`; `--fields` and `--quiet` for scripts |
| **Safety** | Calls, messages, purchases and deletions ask first; `--dry-run` everywhere; tokens are never printed |
| **Docs** | <https://www.vobiz.ai/docs/resources/cli> and the generated [command reference](docs/COMMANDS.md) |

## Contents

- [Install](#install)
- [Log in](#log-in)
- [Examples](#examples)
- [Use it from AI agents](#use-it-from-ai-agents)
- [Scripts and CI](#scripts-and-ci)
- [Safety model](#safety-model)
- [Exit codes](#exit-codes)
- [Configuration](#configuration)
- [Development](#development)

## Install

| Channel | Command |
|---|---|
| npm (Node.js 22.12+) | `npm install --global @vobiz/cli` |
| npx (no install) | `npx @vobiz/cli --help` |
| Homebrew (macOS, Linux) | `brew install vobiz-ai/tap/vobiz` |
| Install script (macOS, Linux) | `curl -fsSL https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/install.sh \| sh` |
| Install script (Windows) | `irm https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/install.ps1 \| iex` |
| Scoop (Windows) | `scoop install https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/packaging/scoop/vobiz.json` |
| Docker | `docker run --rm ghcr.io/vobiz-ai/vobiz-cli --help` |
| Standalone binary | Download `vobiz-<version>-<os>-<arch>` from [GitHub Releases](https://github.com/vobiz-ai/Vobiz-CLI/releases) |

The standalone binaries bundle Node.js, so they need nothing else installed. Every release archive is listed in `SHA256SUMS` and carries a signed build-provenance attestation. The install scripts verify the checksum before they install anything. [docs/INSTALL.md](docs/INSTALL.md) covers each channel, shell completion, the man page, verification, updates and uninstalling.

## Log in

Get your **Auth ID** and **Auth Token** from the [Vobiz console](https://console.vobiz.ai), then:

```console
$ vobiz login
? Auth ID: MA_XXXXXXXX
? Auth Token: ********************************
✓ Logged in to Acme Corp (MA_XXXXXXXX) as profile "default"
  Saved to ~/.config/vobiz/credentials.json (mode 0600)

$ vobiz whoami
```

`vobiz login` checks the credentials with Vobiz before it saves them. Use `--profile <name>` to keep several accounts, and `vobiz profiles use <name>` to switch. In CI, skip `login` and set `VOBIZ_AUTH_ID` and `VOBIZ_AUTH_TOKEN` instead (see [Scripts and CI](#scripts-and-ci)).

## Examples

The outputs below are trimmed examples with placeholder values.

**1. Check your balance**

```console
$ vobiz account balance
CURRENCY  BALANCE   AVAILABLE_BALANCE  CREDIT_LIMIT  STATUS
INR       23906.83  23906.83           1000          active
```

**2. Find a phone number to buy**

```console
$ vobiz numbers search --country IN --limit 3
E164            COUNTRY  REGION  SETUP_FEE  MONTHLY_FEE  CURRENCY
+918012345678   IN       KA      0          1            INR
+918012345679   IN       KA      0          1            INR
+918012345680   IN       KA      0          1            INR
```

Buying is a separate, confirmed step: `vobiz numbers buy +918012345678` shows the price and asks before it spends anything.

**3. Place a call that speaks a message**

```console
$ vobiz calls create --from +918012345678 --to +919876543210 --say "Your order has shipped." --wait
About to place a call
  from  +918012345678
  to    +919876543210
  say   "Your order has shipped."
? Place this call? (y/N) y
REQUEST_UUID                          MESSAGE     IDEMPOTENCY_KEY
5a9fd4a0-3d4c-11ef-bef9-0242ac110005  Call fired  cli-3f1c…
Waiting for the call to finish… completed (47 s, NORMAL_CLEARING)
```

A call reaches a real person and is billed, so the CLI always asks first. In scripts, pass `--yes`.

**4. Read today's call records as JSON**

```console
$ vobiz cdr recent --output json --fields destination_number,duration,hangup_cause_name
[
  { "destination_number": "+919876543210", "duration": 47, "hangup_cause_name": "Normal Hangup" }
]
```

**5. Build VobizXML for an answer URL**

```console
$ vobiz xml build --say "Thanks for calling Acme. Please hold."
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Thanks for calling Acme. Please hold.</Speak>
</Response>
```

Every command is listed, with its flags, in [docs/COMMANDS.md](docs/COMMANDS.md) and in `vobiz <command> --help`. Anything the dedicated commands do not cover is one `vobiz api` call away: `vobiz api --list` shows every operation, and `vobiz api GET /api/v1/Account/{auth_id}/numbers` sends a raw request with your credentials.

## Use it from AI agents

The CLI is built to be driven by Claude Code, Codex, Cursor and other coding agents, and it sets them up for Vobiz:

```bash
vobiz mcp install claude-code      # add the Vobiz MCP server to an agent (claude, claude-code, cursor, codex, windsurf, vscode, gemini, zed)
vobiz mcp config                   # print the JSON snippet instead of writing it
vobiz skills install               # copy the Vobiz Agent Skills into .claude/skills (or --dir .agents/skills)
vobiz docs search "gather speech"  # search the Vobiz docs through the Docs MCP server
```

Agents should:

- pass `--output json` and read data from stdout; progress and hints go to stderr
- branch on the [exit code](#exit-codes) and the JSON error `{"error","message","status","retryable"}`
- never retry exit code `7` (outcome unknown) blindly: check `vobiz calls list` or `vobiz sms messages list` first
- ask the user before any command that would prompt for confirmation, then re-run it with `--yes`

[docs/AGENTS.md](docs/AGENTS.md) has the full contract and copy-paste instructions for `CLAUDE.md` and `AGENTS.md` files.

## Scripts and CI

```bash
export VOBIZ_AUTH_ID=MA_XXXXXXXX            # from your CI secret store
export VOBIZ_AUTH_TOKEN=YOUR_AUTH_TOKEN
vobiz numbers list --output json --quiet    # one E.164 number per line
vobiz trunks create --name prod --yes --output json
```

When stdin is not a terminal, a write fails with exit code `6` unless you pass `--yes` (or set `VOBIZ_YES=1`). The daily update check is off when `CI` is set. [docs/CI.md](docs/CI.md) has GitHub Actions, GitLab CI and Jenkins examples.

## Safety model

- **Ask before acting.** Calls, messages, purchases, releases, transfers and deletions print a one-line summary (destination, caller ID, the host of any answer or callback URL, and the price when Vobiz returns one) and ask. Without a terminal they need `--yes`.
- **Dry runs.** `--dry-run` prints the request (method, path, body with secrets redacted) and sends nothing.
- **No silent retries.** The CLI never retries a request that has side effects. `calls create` and `sms send` print an idempotency key; reuse it with `--idempotency-key`.
- **Secrets stay secret.** Tokens are never printed or logged. `--verbose` shows the method, route template, status and duration; `--debug` adds bodies with `authToken`, `password`, `secret` and `token` redacted. The credentials file is mode 0600 in a 0700 directory, and `vobiz doctor` warns when it is not.
- **Your account only.** Every path is built from the Auth ID you logged in with; no command takes an account ID.
- **HTTPS call-control URLs.** Answer, callback and stream URLs must be `https://` or `wss://` (plain http only for localhost with `--allow-insecure-url`).
- **No telemetry** unless you turn it on with `vobiz config set telemetry true`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Server error or unknown failure |
| 2 | Usage error or invalid input |
| 3 | Authentication failed, credentials missing, or access forbidden |
| 4 | Not found |
| 5 | Rate limited or insufficient balance |
| 6 | Confirmation required (pass `--yes`) or the action is not allowed |
| 7 | Outcome unknown: a side-effecting request timed out; check the state before retrying |
| 8 | Timeout or network error |

`vobiz help exit-codes` prints the same table.

## Configuration

| Flag | Environment | Meaning |
|---|---|---|
| `--profile <name>` | `VOBIZ_PROFILE` | Saved login to use |
| `--auth-id`, `--auth-token` | `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN` | One-off credentials (flags > environment > saved profile) |
| `--output <format>`, `--json` | `VOBIZ_OUTPUT` | `table`, `json`, `yaml`, `tsv` or `plain` |
| `--fields a,b.c` | | Pick columns or keys (dot paths) |
| `--quiet`, `-q` | | Print only IDs or primary values |
| `--yes`, `-y` | `VOBIZ_YES` | Skip confirmation prompts |
| `--dry-run` | | Show the request without sending it |
| `--timeout <sec>` | `VOBIZ_TIMEOUT` | Per-request timeout (default 30) |
| `--base-url`, `--sms-base-url` | `VOBIZ_BASE_URL`, `VOBIZ_SMS_BASE_URL` | Gateway overrides; only `https://*.vobiz.ai` (or localhost) unless `VOBIZ_ALLOW_ANY_BASE_URL=1`, which warns on every run |
| `--no-color` | `NO_COLOR`, `FORCE_COLOR` | Color handling |
| `--verbose`, `--debug` | `VOBIZ_LOG=debug` | Request logging to stderr (redacted) |
| `--no-update-check` | `VOBIZ_NO_UPDATE_CHECK`, `CI` | Skip the daily version check |

Profiles and settings live in `$VOBIZ_CONFIG_DIR`, else `$XDG_CONFIG_HOME/vobiz`, else `~/.config/vobiz` (`%APPDATA%\vobiz` on Windows). `vobiz config path` prints the location.

If your account restricts API access by IP address, allow the addresses your scripts and CI runners use; see [IP whitelisting](https://www.vobiz.ai/docs/concepts/ip-whitelisting).

## Development

```bash
git clone https://github.com/vobiz-ai/Vobiz-CLI.git
cd Vobiz-CLI
npm ci
npm run check        # lint, build, all tests
npm run dev -- --help
```

[docs/PLAN.md](docs/PLAN.md) is the architecture contract, [CONTRIBUTING.md](CONTRIBUTING.md) explains how to add a command, and [docs/RELEASING.md](docs/RELEASING.md) describes the release pipeline.

## Built by Team Vobiz

[Vobiz](https://www.vobiz.ai) is a global programmable telephony platform: SIP trunking, voice APIs, SMS, WhatsApp and AI voice agent integrations in 130+ countries.

**Support:** support@vobiz.ai · [Documentation](https://www.vobiz.ai/docs/resources/cli) · [Issues](https://github.com/vobiz-ai/Vobiz-CLI/issues) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[MIT](./LICENSE) © Vobiz
