#!/usr/bin/env bash
# Vesk installer. Short on purpose: read it before you run it.
#   curl -fsSL https://veskagent.com/install.sh | bash
# What it does:
#   1. checks you have Node.js 22+ and npm
#   2. runs `npm install -g vesk-agent` (a pinned version if VESK_VERSION is set)
#      or, with VESK_FROM_SOURCE=1, clones the repo, builds it with pnpm and links `vesk`
#   3. prints the next steps and runs `vesk doctor`
#
#   VESK_VERSION=0.1.0 bash install.sh                 pin a version from npm
#   VESK_FROM_SOURCE=1 bash install.sh                 build from GitHub (main, or VESK_REF)
#   VESK_FROM_SOURCE=1 VESK_SRC=~/code/vesk bash install.sh   build a checkout you already have
# What it does NOT do: use sudo, change your shell profile, send telemetry, or touch any wallet.
set -euo pipefail

VERSION="${VESK_VERSION:-latest}"
bold() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\033[31merror\033[0m  %s\n' "$1" >&2; exit 1; }

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) fail "Vesk's installer supports macOS and Linux (use WSL on Windows). Or run: npm i -g vesk-agent" ;;
esac

command -v node >/dev/null 2>&1 || fail "Node.js 22+ is required. Install it from https://nodejs.org or with nvm, then run this again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22+ is required (you have $(node -v))."
command -v npm >/dev/null 2>&1 || fail "npm was not found."

PREFIX="$(npm config get prefix)"
if [ ! -w "$PREFIX/lib" ] && [ ! -w "$PREFIX" ]; then
  fail "npm's global folder ($PREFIX) isn't writable without sudo. Run: npm config set prefix \"\$HOME/.npm-global\" and add \$HOME/.npm-global/bin to your PATH, then try again."
fi

if [ "${VESK_FROM_SOURCE:-0}" = "1" ]; then
  command -v git >/dev/null 2>&1 || fail "git is needed to build from source."
  SRC="${VESK_SRC:-$HOME/.vesk-src}"
  REF="${VESK_REF:-main}"
  if [ ! -d "$SRC/.git" ] && [ ! -f "$SRC/pnpm-workspace.yaml" ]; then
    bold "Cloning vesk ($REF) into $SRC"
    git clone --depth 1 --branch "$REF" https://github.com/vesk-agent/vesk.git "$SRC"
  fi
  cd "$SRC"
  if ! command -v pnpm >/dev/null 2>&1; then
    command -v corepack >/dev/null 2>&1 || fail "pnpm (or corepack, which ships with Node) is needed."
    corepack enable --install-directory "$PREFIX/bin" pnpm
  fi
  bold "Building from source"
  pnpm install --frozen-lockfile=false
  pnpm build
  chmod +x packages/cli/dist/index.js
  ln -sf "$SRC/packages/cli/dist/index.js" "$PREFIX/bin/vesk"
else
  bold "Installing vesk-agent@$VERSION"
  npm install -g "vesk-agent@$VERSION" --no-fund --no-audit
fi

command -v vesk >/dev/null 2>&1 || fail "Installed, but 'vesk' isn't on your PATH. Add $PREFIX/bin to PATH."

echo
bold "Vesk is installed."
echo "  vesk init            set up an encrypted wallet, RPC and model"
echo "  vesk summon          paper by default: real signals, nothing signed"
echo "  vesk doctor          check node, RPC latency, keystore, model key, X source"
echo "  vesk help            all commands"
echo
echo "Memecoins are extremely risky. Use a fresh wallet and only what you can afford to lose."
