#!/bin/sh
# Vobiz CLI installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/install.sh | sh
#
# Downloads the release archive for this OS and CPU from GitHub Releases, verifies its SHA256 against the
# release's SHA256SUMS, and installs the `vobiz` binary.
#
# Environment overrides:
#   VOBIZ_VERSION      version to install, e.g. 0.1.0 or v0.1.0 (default: the latest release)
#   VOBIZ_INSTALL_DIR  target directory (default: /usr/local/bin as root, otherwise ~/.local/bin)
#   VOBIZ_REPO         GitHub repository to download from (default: vobiz-ai/Vobiz-CLI)
set -eu

REPO="${VOBIZ_REPO:-vobiz-ai/Vobiz-CLI}"
BASE="https://github.com/${REPO}"

say() { printf '%s\n' "vobiz-install: $*" >&2; }
die() { printf '%s\n' "vobiz-install: error: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

if have curl; then
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }
  final_url() { curl -fsSLI --proto '=https' --tlsv1.2 -o /dev/null -w '%{url_effective}' "$1"; }
elif have wget; then
  fetch() { wget -q --https-only -O "$2" "$1"; }
  final_url() { wget -q --https-only -S --spider "$1" 2>&1 | sed -n 's/^ *[Ll]ocation: *//p' | tail -n 1 | tr -d '\r'; }
else
  die "curl or wget is required"
fi

if have sha256sum; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif have shasum; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  die "sha256sum or shasum is required to verify the download"
fi

have tar || die "tar is required"

# Detect OS and CPU.
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) die "on Windows, use install.ps1: irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex" ;;
  *) die "unsupported OS $(uname -s); install with npm instead: npm i -g @vobiz/cli" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "unsupported CPU $(uname -m); install with npm instead: npm i -g @vobiz/cli" ;;
esac
# Rosetta 2: prefer the native arm64 build on Apple Silicon.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
# The Linux binaries link against glibc. On musl (Alpine), use npm or the Docker image.
if [ "$os" = linux ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then
  die "musl libc detected; use npm (npm i -g @vobiz/cli) or Docker (ghcr.io/vobiz-ai/vobiz-cli)"
fi

# Resolve the version.
version="${VOBIZ_VERSION:-}"
if [ -z "$version" ]; then
  latest="$(final_url "${BASE}/releases/latest" || true)"
  version="${latest##*/tag/}"
  case "$version" in
    v[0-9]*) ;;
    *) die "could not determine the latest release; set VOBIZ_VERSION" ;;
  esac
fi
version="${version#v}"
case "$version" in
  *[!0-9A-Za-z.+-]*) die "invalid VOBIZ_VERSION: $version" ;;
esac

name="vobiz-${version}-${os}-${arch}"
asset="${name}.tar.gz"
url="${BASE}/releases/download/v${version}"

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t vobiz)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading ${asset}"
fetch "${url}/${asset}" "${tmp}/${asset}" || die "download failed: ${url}/${asset}"
fetch "${url}/SHA256SUMS" "${tmp}/SHA256SUMS" || die "download failed: ${url}/SHA256SUMS"

expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "${tmp}/SHA256SUMS")"
[ -n "$expected" ] || die "${asset} is not listed in SHA256SUMS"
actual="$(sha256 "${tmp}/${asset}")"
[ "$expected" = "$actual" ] || die "checksum mismatch for ${asset} (expected ${expected}, got ${actual})"
say "checksum verified"

tar -xzf "${tmp}/${asset}" -C "$tmp"
[ -f "${tmp}/${name}/vobiz" ] || die "the archive does not contain ${name}/vobiz"

# Choose the install directory.
dir="${VOBIZ_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ "$(id -u)" = 0 ]; then dir=/usr/local/bin; else dir="${HOME}/.local/bin"; fi
fi
mkdir -p "$dir" || die "cannot create ${dir}; set VOBIZ_INSTALL_DIR to a writable directory"
[ -w "$dir" ] || die "${dir} is not writable; re-run with VOBIZ_INSTALL_DIR=\$HOME/.local/bin or with sudo"

# Install atomically: copy beside the target, then rename over it.
cp "${tmp}/${name}/vobiz" "${dir}/.vobiz.tmp.$$"
chmod 755 "${dir}/.vobiz.tmp.$$"
mv -f "${dir}/.vobiz.tmp.$$" "${dir}/vobiz"
say "installed vobiz ${version} to ${dir}/vobiz"

case ":${PATH}:" in
  *":${dir}:"*) ;;
  *)
    say "${dir} is not on your PATH. Add it to your shell profile:"
    # shellcheck disable=SC2016 # $PATH is meant literally in the printed hint
    printf '\n    export PATH="%s:$PATH"\n\n' "$dir" >&2
    ;;
esac

say "next: run \`vobiz login\`, then \`vobiz --help\`. Shell completion: \`vobiz completion --help\`."
