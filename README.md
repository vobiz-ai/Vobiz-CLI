# Vobiz CLI

**Your whole Vobiz account from the terminal, your scripts, your CI, and your AI agents.**

`vobiz` is the official command-line interface for [Vobiz](https://www.vobiz.ai), the programmable telephony platform: voice calls, SIP trunking, phone numbers, SMS/MMS/RCS and AI voice agents in 130+ countries. One binary, 277 commands and command groups, every operation in the Vobiz Voice and Messaging OpenAPI documents, with the guard rails a tool that places calls and spends money needs.

[![CI](https://github.com/vobiz-ai/Vobiz-CLI/actions/workflows/ci.yml/badge.svg)](https://github.com/vobiz-ai/Vobiz-CLI/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@vobiz/cli)](https://www.npmjs.com/package/@vobiz/cli)
[![Release](https://img.shields.io/github/v/release/vobiz-ai/Vobiz-CLI)](https://github.com/vobiz-ai/Vobiz-CLI/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

```console
$ npm install --global @vobiz/cli
$ vobiz login
Find your Auth ID and Auth Token in the Vobiz console: https://console.vobiz.ai
? Auth ID: MA_XXXXXXXX
? Auth Token: ••••••••••••••••
✓ Logged in to Acme Corp (MA_XXXXXXXX, main account). Saved profile "default" (default) to ~/.config/vobiz/credentials.json.

$ vobiz account balance
FIELD              VALUE
currency           INR
balance            23906.83
available_balance  23906.83
status             active
…

$ vobiz calls create --from +918012345678 --to +919876543210 --answer-url https://example.com/answer --wait
Place a call to +919876543210 (billed)
  account: MA_XXXXXXXX (profile "default")
  to: +919876543210
  caller ID: +918012345678
  answer URL host: example.com
? Continue? (y/N) y
call 4f5abfa8-…: queued
call 4f5abfa8-…: in-progress
call 4f5abfa8-…: ended
FIELD      VALUE
call_uuid  4f5abfa8-…
status     ended
…
```

## Why this CLI

| | |
|---|---|
| **Complete** | Every operation in the Vobiz OpenAPI documents has a command, generated from the spec so nothing drifts. Anything new is one `vobiz api` call away. |
| **Safe by default** | Calls, messages, purchases, releases, transfers and deletions show what they will do and ask. `--dry-run` everywhere. A failed write is never retried blindly. Tokens never reach your screen, logs or files. |
| **Built for scripts** | `table` on a terminal, `json` when piped, plus `jsonl`, `yaml`, `tsv`, `plain`; `--fields`, `--query`, `--quiet`; stable exit codes. |
| **Built for agents** | Claude Code, Codex and Cursor can drive it: machine-readable errors, third-party text marked as untrusted, one command to connect the Vobiz MCP server and install the Vobiz Agent Skills. |
| **Everywhere** | npm, Homebrew, Docker, Scoop, install scripts, standalone binaries for macOS, Linux and Windows with checksums and build attestations. |

## Install

| Channel | Command |
|---|---|
| npm (Node.js 22.12+) | `npm install --global @vobiz/cli` |
| No install | `npx @vobiz/cli --help` |
| Homebrew (macOS, Linux) | `brew install vobiz-ai/tap/vobiz` |
| Install script (macOS, Linux) | `curl -fsSL https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/install.sh \| sh` |
| Install script (Windows) | `irm https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/install.ps1 \| iex` |
| Scoop (Windows) | `scoop install https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/packaging/scoop/vobiz.json` |
| Docker | `docker run --rm -e VOBIZ_AUTH_ID -e VOBIZ_AUTH_TOKEN ghcr.io/vobiz-ai/vobiz-cli numbers list` |
| Binary | `vobiz-<version>-<os>-<arch>` from [GitHub Releases](https://github.com/vobiz-ai/Vobiz-CLI/releases) (bundles Node.js; nothing else needed) |

Run `vobiz update` to check for a newer version and see how to upgrade.

Release archives are listed in `SHA256SUMS` and carry a signed build-provenance attestation; the install scripts verify the checksum before installing. [docs/INSTALL.md](docs/INSTALL.md) covers each channel, shell completion (`vobiz completion zsh|bash|fish|powershell`), the man page, verification, updates and uninstalling.

## Sign in

Copy your **Auth ID** and **Auth Token** from the [Vobiz console](https://console.vobiz.ai), then run `vobiz login`. The CLI verifies them with Vobiz and stores them with mode 0600. Keep several accounts with `--profile <name>` and switch with `vobiz profiles use <name>`. Then run `vobiz doctor` to check the setup: Node.js, config file permissions, connectivity, credentials, clock skew and proxy settings. In CI, skip `login` and set `VOBIZ_AUTH_ID` and `VOBIZ_AUTH_TOKEN` from your secret store.

```console
$ vobiz whoami
FIELD           VALUE
auth_id         MA_XXXXXXXX
account_type    main account
account_name    Acme Corp
source          profile
profile         default
…
```

## What you can do

| Group | Commands | Examples |
|---|---|---|
| `account` | profile, balance, concurrency, transactions, CPS and concurrency capacity | `vobiz account transactions list --from 7d` |
| `calls` | create, list, get, watch, hang up, record, play, speak, DTMF, audio streams | `vobiz calls watch <uuid>` |
| `conferences` | list, get, end, mute/deafen/kick members, record | `vobiz conferences members mute standup all` |
| `recordings` | list, get, download, delete, bulk export | `vobiz recordings download <id> --out call.wav` |
| `cdr` | list, search, recent, get, CSV export | `vobiz cdr export --from yesterday --out cdr.csv` |
| `numbers` | list, search inventory, buy, release, route to a trunk, app or sub-account | `vobiz numbers update +91… --app <id>` |
| `trunks` | SIP trunks, credentials, IP access lists, origination URIs | `vobiz trunks credentials create --username pbx --password @-` |
| `apps`, `endpoints` | voice applications (answer URLs) and SIP endpoints | `vobiz apps create --app-name ivr --answer-url https://… --answer-method POST` |
| `sub-accounts`, `partner` | sub-accounts and KYC; the reseller partner API | `vobiz sub-accounts create --name "Mumbai team"` |
| `sms` | send, delivery, conversations, opt-outs, webhooks (callbacks), broadcasts, RCS senders, US 10DLC | `vobiz sms send --from +1… --to +1… --text "Hi" --wait` |
| `xml` | build, validate and locally serve VobizXML | `vobiz xml build --say "Hello" --gather https://…/next` |
| `webhooks` | verify Vobiz webhook signatures, receive webhooks locally | `vobiz webhooks listen --forward http://localhost:3000/hook --secret @-` |
| `diagnose` | explain why a call or message ended the way it did | `vobiz diagnose call <uuid>` |
| `streams` | test and proxy the WebSocket server behind `<Stream>` | `vobiz streams test wss://agent.example.com/audio` |
| `setup` | guided: a number for your AI voice agent, or a number plus webhook for SMS | `vobiz setup voice-agent --number +91… --trunk <id>` |
| `mcp`, `skills`, `docs` | connect AI clients to the Vobiz MCP server, install the Agent Skills, search the docs | `vobiz mcp install cursor` |
| `api` | raw requests against any operation in the spec | `vobiz api GET /api/v1/auth/me` |

Every command and flag is in [docs/COMMANDS.md](docs/COMMANDS.md) and in `vobiz <group> --help`; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the conventions, safety model, output modes and exit codes.

## Examples

**Find and buy a number, then point it at your voice agent**

```console
$ vobiz numbers search --country IN --limit 3
E164           COUNTRY  REGION  SETUP_FEE  MONTHLY_FEE  CURRENCY
+918012345678  IN       KA      0          1            INR
…
$ vobiz numbers buy +918012345678
Buy +918012345678
  account: MA_XXXXXXXX (profile "default")
  number: +918012345678
  location: KA, IN
  cost: INR 0 setup now, then INR 1/month
? Continue? (y/N) y
$ vobiz setup voice-agent --number +918012345678 --answer-url https://agent.example.com/answer
```

**Export last week's call records as CSV, and explain one that failed**

```console
$ vobiz cdr export --from 7d --out cdr.csv
$ vobiz diagnose call 968fe850-fc3d-43e9-bafe-52caca895a83
…
What happened:
  - The call was not answered (no answer time, 0 billable seconds).
  - Hangup code 3010, "Busy Line" (call rejection): Destination is busy.
  - hangup_cause USER_BUSY: The called party is busy (already on another call or declined).
  - Ended by: Callee.

What to check next:
  1. Retry later or implement voicemail fallback.
```

**Send a message and follow it to delivery**

```console
$ vobiz sms send --from +12628044436 --to +16478723288 --text "Your table is ready" --wait
Send a real, billed SMS to 1 recipient
  account: MA_XXXXXXXX (profile "default")
  from: +12628044436
  to: +16478723288
  recipients: 1
  text: "Your table is ready" (19 characters)
  idempotency key: cli-88023521-…
  cost: USD 0.0079 for 1 recipient (1 segment each)
? Continue? (y/N) y
Idempotency key: cli-88023521-… (pass --idempotency-key cli-88023521-… to retry without sending twice)
Waiting for 1 message to reach a final status (queued)…
ID         TO            STATUS     ERRORCODE  ERRORMESSAGE
msg_01JB2  +16478723288  delivered
```

**Pipe anything**

```console
$ vobiz numbers list --quiet
+918012345678
+918012345679
$ vobiz numbers list --json --query 'objects[*].e164'
[
  "+918012345678",
  "+918012345679"
]
$ vobiz cdr recent --output tsv > calls.tsv
```

## For AI agents

```bash
vobiz mcp install claude-code       # connect the Vobiz MCP server (claude, claude-code, cursor, codex, windsurf, vscode, gemini, zed)
vobiz skills install                # copy the 15 Vobiz Agent Skills into .claude/skills (or --dir .agents/skills)
vobiz docs search "gather speech"   # search the Vobiz docs through the Docs MCP server, no credentials needed
```

The contract agents rely on: data on stdout, everything else on stderr; `--output json` everywhere; errors as one JSON line `{"error","message","status","retryable","hint"}`; exit code `7` means "outcome unknown, check state before retrying"; third-party text (message bodies, caller names, webhook payloads) is marked with `_untrusted_fields`. [docs/AGENTS.md](docs/AGENTS.md) has copy-paste instructions for `CLAUDE.md` and `AGENTS.md` files.

## Safety model

- **Ask before acting.** Every billable or destructive command prints the account, destination, caller ID, URL host and price, then asks. Without a terminal it needs `--yes` (exit code `6` otherwise).
- **Dry runs.** `--dry-run` prints the exact request, secrets redacted, and sends nothing.
- **No blind retries.** Side-effecting requests are never retried. A timeout, lost connection, or 5xx/408 answer on a write exits `7`; `sms send` prints an idempotency key you can reuse; `calls create` has none, so check `vobiz calls list --queued` and `vobiz cdr recent` first.
- **Bounded fan-out.** At most 50 distinct destinations per `calls create` or `sms send` unless you raise `--max-fanout`.
- **Credentials stay home.** Sent only to `https://*.vobiz.ai`; never printed, logged or written into project files; stored 0600. `vobiz doctor` checks all of it.
- **HTTPS only** for answer, callback and stream URLs. **No telemetry:** the CLI connects only to the Vobiz API, the Vobiz Docs MCP server (`docs search`), the npm registry (a daily version check, off in CI or with `--no-update-check`) and URLs you pass it.

## Exit codes

<!-- BEGIN GENERATED exit-codes -->
| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | Server error or unknown failure. A 5xx on a read is retryable; a 5xx on a write is exit 7. |
| 2 | Usage error or invalid input. |
| 3 | Authentication failed, credentials missing, access forbidden or account suspended. |
| 4 | Not found. |
| 5 | Rate limited or insufficient balance. |
| 6 | Confirmation required (pass --yes) or the action is not allowed. |
| 7 | Outcome unknown: a side-effecting request (call, message, purchase, transfer) timed out, lost its connection, or got a 5xx or 408 answer on a write. It may have taken effect, so it is not retryable; check the state first. The CLI never retries on its own. |
| 8 | Timeout or network error on a read (nothing was changed; safe to retry). |
| 130 | Interrupted (Ctrl-C). |
<!-- END GENERATED exit-codes -->

## Configuration

| Flag | Environment | Meaning |
|---|---|---|
| `--profile <name>` | `VOBIZ_PROFILE` | Saved login to use |
| `--auth-id`, `--auth-token` | `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN` | One-off credentials (flags > environment > profile) |
| `--output`, `--json` | `VOBIZ_OUTPUT` | `table`, `json`, `jsonl`, `yaml`, `tsv`, `plain` |
| `--fields a,b.c`, `--query <path>`, `--quiet` | | Shape the output |
| `--yes`, `--dry-run` | `VOBIZ_YES` | Confirmations |
| `--timeout <sec>` | `VOBIZ_TIMEOUT` | Per-request timeout (default 30) |
| `--base-url`, `--sms-base-url` | `VOBIZ_BASE_URL`, `VOBIZ_SMS_BASE_URL` | Gateway overrides, `https://*.vobiz.ai` only |
| `--verbose`, `--debug`, `--no-color` | `VOBIZ_LOG`, `NO_COLOR` | Logging and color |

Profiles and settings live in `~/.config/vobiz` (`%APPDATA%\vobiz` on Windows, or `$VOBIZ_CONFIG_DIR`); `vobiz config path` prints the location. Run `vobiz help env` for every environment variable, including proxy settings (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`). If your account restricts API access by IP, allow the addresses your scripts use: see [IP whitelisting](https://www.vobiz.ai/docs/concepts/ip-whitelisting).

## Development

```bash
git clone https://github.com/vobiz-ai/Vobiz-CLI.git && cd Vobiz-CLI
npm ci --ignore-scripts
npm run check          # lint, build, 1,900+ tests
npm run dev -- --help
```

Commands are generated from the OpenAPI documents in `spec/`; [CONTRIBUTING.md](CONTRIBUTING.md) explains how to add one, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) the conventions, and [docs/RELEASING.md](docs/RELEASING.md) the release pipeline.

## Built by Team Vobiz

[Vobiz](https://www.vobiz.ai) is a global programmable telephony platform: SIP trunking, voice APIs, SMS, WhatsApp and AI voice agent integrations in 130+ countries. The [Vobiz MCP server](https://github.com/vobiz-ai/Vobiz-MCP-Server) is the CLI's sibling for chat-based agents.

**Support:** support@vobiz.ai · `vobiz feedback` (opens a prefilled GitHub issue) · [Documentation](https://www.vobiz.ai/docs/resources/cli) · [Issues](https://github.com/vobiz-ai/Vobiz-CLI/issues) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[MIT](./LICENSE) © Vobiz
