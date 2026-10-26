#!/usr/bin/env bash
# Provisions an X1 development environment on Linux or macOS.
# Idempotent: safe to re-run.
set -euo pipefail

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m[ok]\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m[!!]\033[0m %s\n' "$1"; }

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '    would: %s\n' "$*"
  else
    printf '    \033[90m$ %s\033[0m\n' "$*"
    "$@"
  fi
}

step "Platform"
case "$(uname -s)" in
  Linux)  PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) warn "Unsupported platform: $(uname -s). X1 tooling needs Linux or macOS."; exit 1 ;;
esac
ok "$PLATFORM $(uname -m)"

if [[ $PLATFORM == "linux" ]]; then
  step "System packages"
  if command -v apt-get >/dev/null 2>&1; then
    run sudo apt-get update -qq
    run sudo apt-get install -y -qq build-essential pkg-config libudev-dev libssl-dev \
      libclang-dev clang cmake curl git unzip
  else
    warn "Not an apt system. Install build-essential, libudev, libssl and clang manually."
  fi
fi

step "Rust"
if command -v rustc >/dev/null 2>&1; then
  ok "$(rustc --version)"
else
  run bash -c 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
[[ $DRY_RUN -eq 0 ]] && rustup component add rustfmt >/dev/null 2>&1 || true

step "Solana CLI"
if command -v solana >/dev/null 2>&1; then
  ok "$(solana --version)"
else
  run bash -c 'sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"'
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
fi

step "Anchor"
if command -v anchor >/dev/null 2>&1; then
  ok "$(anchor --version)"
else
  warn "Anchor compiles from source; this can take several minutes."
  run cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
  run avm install latest
  run avm use latest
fi

step "Node.js"
if command -v node >/dev/null 2>&1; then
  ok "node $(node --version)"
else
  warn "Install Node 20+ from https://nodejs.org or your package manager."
fi

step "X1 testnet"
if command -v solana >/dev/null 2>&1; then
  run solana config set -u https://rpc.testnet.x1.xyz
  [[ $DRY_RUN -eq 0 ]] && solana config get || true
fi

step "Next"
printf '    Fund a wallet: https://faucet.testnet.x1.xyz\n'
printf '    Verify:        npx x1 doctor\n\n'
