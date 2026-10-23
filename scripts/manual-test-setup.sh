#!/usr/bin/env sh
# Prepares an isolated manual-test environment for the Vobiz CLI on macOS or Linux.
#   sh scripts/manual-test-setup.sh            # build, create a scratch config dir, sign in with a test account
# Set VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN in the environment (or in .env.live2 next to this repo) before running.
# Nothing here touches ~/.config/vobiz: the scratch config lives under ./.manual-test/ (gitignored).
set -eu
cd "$(dirname "$0")/.."
export VOBIZ_CONFIG_DIR="$PWD/.manual-test/config"
mkdir -p "$VOBIZ_CONFIG_DIR" && chmod 700 "$VOBIZ_CONFIG_DIR"
[ -d node_modules ] || npm ci --ignore-scripts
npm run build >/dev/null
if [ -z "${VOBIZ_AUTH_ID:-}" ] && [ -f .env.live2 ]; then set -a; . ./.env.live2; set +a; fi
: "${VOBIZ_AUTH_ID:?set VOBIZ_AUTH_ID (test account)}"; : "${VOBIZ_AUTH_TOKEN:?set VOBIZ_AUTH_TOKEN}"
printf '%s:%s' "$VOBIZ_AUTH_ID" "$VOBIZ_AUTH_TOKEN" | node dist/index.js login --with-token --profile manual >/dev/null
unset VOBIZ_AUTH_ID VOBIZ_AUTH_TOKEN
cat <<MSG

Ready. In THIS shell, run:
  export VOBIZ_CONFIG_DIR="$VOBIZ_CONFIG_DIR"
  alias vobiz="node $PWD/dist/index.js"
Then try the commands in README.md and docs/COMMANDS.md. Profile "manual" is signed in; your real ~/.config/vobiz was not touched.
When done: rm -rf "$PWD/.manual-test"
MSG
