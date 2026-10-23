# Install the Vobiz CLI

Pick the channel that fits your machine. Every channel installs the same `vobiz` command. After installing, run `vobiz login` (or set `VOBIZ_AUTH_ID` and `VOBIZ_AUTH_TOKEN`) and `vobiz doctor`.

| Channel | Best for | Needs |
|---|---|---|
| [npm](#npm) | Developers who already have Node.js | Node.js 22.12+ |
| [Homebrew](#homebrew) | macOS and Linux | Homebrew |
| [Install script](#install-script) | Servers, containers, quick setup | `curl` or `wget`, `tar`, `sha256sum` or `shasum` |
| [Scoop](#scoop) and [PowerShell script](#windows-powershell-script) | Windows | PowerShell 5.1+ |
| [Docker](#docker) | Isolated or ephemeral runs | Docker |
| [Standalone binary](#standalone-binary) | Air-gapped or pinned installs | Nothing |

## npm

```bash
npm install --global @vobiz/cli
vobiz --version
```

Or run it without installing: `npx @vobiz/cli@latest whoami`. Every npm release is published from GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so `npm audit signatures` can verify it. Prereleases use the `next` dist-tag (`npm i -g @vobiz/cli@next`).

The npm package also installs the man page (`man vobiz`) on systems where npm links man pages.

## Homebrew

```bash
brew install vobiz-ai/tap/vobiz
```

The formula installs the standalone binary for your platform, shell completions for bash, zsh and fish, and the man page. Update with `brew upgrade vobiz`.

## Install script

macOS and Linux (x64 and arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/install.sh | sh
```

The script downloads the release archive for your OS and CPU from GitHub Releases, checks its SHA256 against the release's `SHA256SUMS`, and installs `vobiz` to `/usr/local/bin` when run as root, otherwise to `~/.local/bin`. It prints a hint when that directory is not on your `PATH`.

| Variable | Default | Meaning |
|---|---|---|
| `VOBIZ_VERSION` | latest release | Version to install, e.g. `0.1.2` |
| `VOBIZ_INSTALL_DIR` | `/usr/local/bin` (root) or `~/.local/bin` | Where to put the binary |

The examples on this page pin `0.1.2`; replace it with the version you want (`npm view @vobiz/cli version` prints the latest).

```bash
curl -fsSL https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/install.sh | VOBIZ_VERSION=0.1.2 VOBIZ_INSTALL_DIR=/opt/bin sh
```

Prefer to read a script before you run it? Download it first: `curl -fsSLO https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/install.sh`, inspect it, then `sh install.sh`.

The Linux binaries need glibc. On Alpine and other musl-based systems, use npm or Docker.

## Windows PowerShell script

```powershell
irm https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/install.ps1 | iex
```

It verifies the SHA256, installs `vobiz.exe` to `%LOCALAPPDATA%\Programs\vobiz` and adds that folder to your user `PATH`. `VOBIZ_VERSION` and `VOBIZ_INSTALL_DIR` work as above. Windows on Arm runs the x64 build.

## Scoop

```powershell
scoop install https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/packaging/scoop/vobiz.json
```

The release pipeline updates the manifest for every stable release; `scoop update vobiz` picks it up.

## Docker

```bash
# One-off credentials
docker run --rm -e VOBIZ_AUTH_ID -e VOBIZ_AUTH_TOKEN ghcr.io/vobiz-ai/vobiz-cli account balance

# Your saved login (read-only)
docker run --rm -v ~/.config/vobiz:/home/node/.config/vobiz:ro ghcr.io/vobiz-ai/vobiz-cli numbers list

# Pipe JSON to jq
docker run --rm -e VOBIZ_AUTH_ID -e VOBIZ_AUTH_TOKEN ghcr.io/vobiz-ai/vobiz-cli cdr recent --output json | jq .
```

The image is multi-arch (`linux/amd64`, `linux/arm64`), runs as the non-root `node` user, and ships without npm. Tags: `<version>`, `v<version>`, and `latest` (the highest stable release only). Pin a version in production. Interactive commands such as `vobiz login` need `-it`.

## Standalone binary

Download the archive for your platform from [GitHub Releases](https://github.com/vobiz-ai/Vobiz-CLI/releases):

| Platform | Archive |
|---|---|
| macOS, Apple silicon | `vobiz-<version>-darwin-arm64.tar.gz` |
| macOS, Intel | `vobiz-<version>-darwin-x64.tar.gz` |
| Linux x64 (glibc) | `vobiz-<version>-linux-x64.tar.gz` |
| Linux arm64 (glibc) | `vobiz-<version>-linux-arm64.tar.gz` |
| Windows x64 | `vobiz-<version>-win-x64.zip` |

Each archive holds `vobiz` (or `vobiz.exe`), `LICENSE`, `README.md`, `completions/` and `man/`. The binary is a Node.js [single executable application](https://nodejs.org/api/single-executable-applications.html), so it needs nothing else installed.

### Verify a download

```bash
V=0.1.2
curl -fsSLO https://github.com/vobiz-ai/Vobiz-CLI/releases/download/v$V/vobiz-$V-linux-x64.tar.gz
curl -fsSLO https://github.com/vobiz-ai/Vobiz-CLI/releases/download/v$V/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS          # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
gh attestation verify vobiz-$V-linux-x64.tar.gz --repo vobiz-ai/Vobiz-CLI \
  --signer-workflow vobiz-ai/Vobiz-CLI/.github/workflows/release.yml \
  --source-ref refs/tags/v$V --deny-self-hosted-runners
```

With `--signer-workflow` and `--source-ref`, the attestation proves the archive was built by this repository's release workflow from the `v$V` tag on a GitHub-hosted runner (`--repo` alone accepts any workflow on any branch). The install scripts run the same check automatically when `gh` is installed and signed in; set `VOBIZ_REQUIRE_ATTESTATION=1` to make it mandatory.

The macOS binaries are signed ad hoc, not notarized. Archives fetched with `curl`, the install script or Homebrew run directly. If you download one with a browser and macOS blocks it, remove the quarantine flag: `xattr -d com.apple.quarantine ./vobiz`.

## Shell completion

```bash
vobiz completion bash > ~/.local/share/bash-completion/completions/vobiz
vobiz completion zsh  > "${fpath[1]}/_vobiz"
vobiz completion fish > ~/.config/fish/completions/vobiz.fish
vobiz completion powershell | Out-String | Invoke-Expression   # add to $PROFILE to keep it
```

Homebrew installs bash, zsh and fish completions for you. The release archives and the npm package also carry the generated files in `completions/`.

## Man page

`man vobiz` works after a Homebrew or npm install. From an archive, copy `man/vobiz.1` to a directory on your `MANPATH`, for example `/usr/local/share/man/man1/`.

## Update

`vobiz update` tells you the right command for how you installed it:

| Channel | Update |
|---|---|
| npm | `npm install --global @vobiz/cli@latest` |
| Homebrew | `brew upgrade vobiz` |
| Install script | re-run the script |
| Scoop | `scoop update vobiz` |
| Docker | `docker pull ghcr.io/vobiz-ai/vobiz-cli:<version>` |

## Uninstall

| Channel | Uninstall |
|---|---|
| npm | `npm uninstall --global @vobiz/cli` |
| Homebrew | `brew uninstall vobiz` |
| Install script | `rm "$(command -v vobiz)"` |
| PowerShell script | delete `%LOCALAPPDATA%\Programs\vobiz` and remove it from your user `PATH` |
| Scoop | `scoop uninstall vobiz` |

Your saved logins stay in the config directory (`vobiz config path`). Run `vobiz logout --all` first, or delete that directory, to remove them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `vobiz: command not found` | Add the install directory to `PATH` (the installer prints the line to add). |
| npm warns `EBADENGINE`, or `vobiz` fails to start after an npm install | Node.js is older than 22.12: upgrade it, or use Homebrew, the install script or Docker. `vobiz doctor` reports the Node.js version. |
| Requests fail with `network_error` behind a proxy | Set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` (Node.js 22.21+ or 24+); `vobiz doctor` shows which proxy variables it sees. |
| Requests are refused from CI or a server | If your account restricts API access by IP, allow that machine's address. See [IP whitelisting](https://www.vobiz.ai/docs/concepts/ip-whitelisting). |
| `checksum mismatch` from the installer | Retry; if it persists, report it as described in [SECURITY.md](../SECURITY.md). |
