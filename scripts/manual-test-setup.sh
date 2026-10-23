#!/usr/bin/env sh
# Prepares an isolated manual-test environment for the Vobiz CLI on macOS or Linux.
#   sh scripts/manual-test-setup.sh --published  # use the published CLI on PATH (npm install --global @vobiz/cli)
#   sh scripts/manual-test-setup.sh              # build this checkout instead (when you are changing code)
# Set VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN in the environment (or point VOBIZ_ENV_FILE at a file that sets them)
# before running. Use a test account.
# Nothing here touches ~/.config/vobiz: the scratch config lives under ./.manual-test/ (gitignored).
set -eu
cd "$(dirname "$0")/.."
published=false
case "${1:-}" in
  --published) published=true ;;
  "") ;;
  *) echo "usage: sh scripts/manual-test-setup.sh [--published]" >&2; exit 2 ;;
esac
export VOBIZ_CONFIG_DIR="$PWD/.manual-test/config"
mkdir -p "$VOBIZ_CONFIG_DIR" && chmod 700 "$VOBIZ_CONFIG_DIR"
if $published; then
  command -v vobiz >/dev/null 2>&1 || { echo "vobiz is not on PATH. Install the published CLI first: npm install --global @vobiz/cli" >&2; exit 1; }
  run() { vobiz "$@"; }
  how='(the published vobiz on your PATH; no alias needed)'
else
  [ -d node_modules ] || npm ci --ignore-scripts
  npm run build >/dev/null
  run() { node dist/index.js "$@"; }
  how="alias vobiz=\"node $PWD/dist/index.js\""
fi
if [ -z "${VOBIZ_AUTH_ID:-}" ] && [ -n "${VOBIZ_ENV_FILE:-}" ]; then set -a; . "$VOBIZ_ENV_FILE"; set +a; fi
: "${VOBIZ_AUTH_ID:?set VOBIZ_AUTH_ID (test account)}"; : "${VOBIZ_AUTH_TOKEN:?set VOBIZ_AUTH_TOKEN}"
printf '%s:%s' "$VOBIZ_AUTH_ID" "$VOBIZ_AUTH_TOKEN" | run login --with-token --profile manual >/dev/null
unset VOBIZ_AUTH_ID VOBIZ_AUTH_TOKEN
version=$(run --version)
cat <<MSG

Ready: vobiz $version. In THIS shell, run:
  export VOBIZ_CONFIG_DIR="$VOBIZ_CONFIG_DIR"
  $how
Then try the commands in README.md and docs/COMMANDS.md. Profile "manual" is signed in; your real ~/.config/vobiz was not touched.
When done: rm -rf "$PWD/.manual-test"
MSG
