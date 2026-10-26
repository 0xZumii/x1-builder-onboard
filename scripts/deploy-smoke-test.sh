#!/usr/bin/env bash
#
# End-to-end deploy test for @x1/kit against X1 testnet.
#
#   bash scripts/deploy-smoke-test.sh [--deploy-only] [/path/to/x1-devkit] [workdir]
#
# Creates a throwaway Anchor project, builds it, works out the rent-exempt
# requirement, then deploys through `x1 deploy` (which auto-extends on the
# classic "account data too small" failure).
set -euo pipefail

DEPLOY_ONLY=0
if [ "${1:-}" = "--deploy-only" ]; then
  DEPLOY_ONLY=1
  shift
fi

REPO="${1:-/mnt/c/Users/admin/Documents/Default Project/x1-devkit}"
WORK="${2:-$HOME/x1-deploy-test}"
CLI="$REPO/packages/kit/dist/cli.js"

# Scripts run non-interactively, so Ubuntu never sources .bashrc here.
# Pull in the same environment the login shell uses.
if [ -f "$HOME/devkit/scripts/wsl-env.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/devkit/scripts/wsl-env.sh"
else
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
fi

log() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
ok()  { printf '    \033[32m[ok]\033[0m %s\n' "$*"; }

[ -f "$CLI" ] || { echo "Build the kit first: cd \"$REPO\" && npm run build"; exit 1; }

if [ "$DEPLOY_ONLY" -eq 0 ]; then
  log "Workspace"
  rm -rf "$WORK"
  mkdir -p "$WORK"
  cd "$WORK"
  ok "$WORK"

  log "anchor init"
  anchor init counter >/dev/null
  cd counter
  # `anchor init` runs `cargo metadata` with the host toolchain, which writes a
  # v4 Cargo.lock. The SBF toolchain bundles an older cargo that cannot read v4
  # ("requires -Znext-lockfile-bump"), so let it generate its own.
  rm -f Cargo.lock
  ok "created $(pwd)"

  log "anchor build"
  # solana 4.x needs --arch v0 (SBPFv3 + platform-tools mismatch), and --no-idl
  # because anchor forwards the cargo args into its IDL step too.
  anchor build --no-idl -- --arch v0
else
  log "Reusing existing build"
  cd "$WORK/counter"
  ok "$(pwd)"
fi

SO="$(ls target/deploy/*.so | head -1)"
SIZE="$(stat -c%s "$SO")"
ok "$SO (${SIZE} bytes)"

# Rent-exempt minimum: (128-byte overhead + data size) * 6960 lamports/byte.
RENT=$(( (SIZE + 128) * 6960 ))
RENT_XNT="$(awk -v r="$RENT" 'BEGIN { printf "%.4f", r / 1000000000 }')"
printf '\n    rent-exempt requirement: %s lamports (~%s XNT)\n' "$RENT" "$RENT_XNT"

log "Wallet"
ADDRESS="$(solana address)"
printf '    address: %s\n' "$ADDRESS"
BALANCE="$(solana balance --lamports 2>/dev/null | awk '{print $1}')"
printf '    balance: %s lamports\n' "${BALANCE:-0}"

if [ "${BALANCE:-0}" -lt "$RENT" ]; then
  printf '\n\033[33m    Not enough XNT for rent yet.\033[0m\n'
  printf '    Fund this address at https://faucet.testnet.x1.xyz :\n'
  printf '      %s\n' "$ADDRESS"
  printf '    Then re-run:\n'
  printf '      bash %s --deploy-only %s %s\n\n' "$0" "$REPO" "$WORK"
  exit 2
fi

log "x1 deploy"
node "$CLI" deploy --no-build --name counter
ok "deploy finished"
