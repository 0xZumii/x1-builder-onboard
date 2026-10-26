#!/usr/bin/env bash
#
# Provisions the X1 / Solana toolchain inside WSL2.
#
# Run as root:  wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/.../scripts/wsl-provision.sh
#
# Phase 1 (root): create a normal user, install system packages.
# Phase 2 (user): rust, solana CLI, anchor, node, wallet, testnet config.
#
# Versions:
#   Solana CLI -> current stable. A pin is NOT needed: the kit builds with
#     `--arch v0`, which sidesteps "Platform tools v1.52 is incompatible with
#     SBPFv3" on 4.x clients. Pinning the 2.0.x line (as X1's docs suggest)
#     actually breaks: its bundled cargo 1.75 cannot parse modern crates.io
#     manifests (edition2024).
#   anchor 0.31.1 -> nearest release to the 0.30.1 in X1's docs that ships a
#     prebuilt Linux binary (0.30.1 does not), so no source build is needed.
#
# Idempotent: safe to re-run.
set -euo pipefail

ANCHOR_VERSION="${ANCHOR_VERSION:-0.31.1}"
NODE_VERSION="${NODE_VERSION:-24.10.0}"
DEV_USER="${DEV_USER:-dev}"

log() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
ok()  { printf '    \033[32m[ok]\033[0m %s\n' "$*"; }
warn(){ printf '    \033[33m[!!]\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Phase 1: root
# ---------------------------------------------------------------------------
if [ "$(id -u)" = "0" ]; then
  if ! id "$DEV_USER" >/dev/null 2>&1; then
    log "Creating user $DEV_USER"
    useradd -m -s /bin/bash -G sudo "$DEV_USER"
    echo "$DEV_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/$DEV_USER"
    chmod 440 "/etc/sudoers.d/$DEV_USER"
    ok "user $DEV_USER created with passwordless sudo"
  else
    ok "user $DEV_USER already exists"
  fi

  if ! grep -q "^default=$DEV_USER" /etc/wsl.conf 2>/dev/null; then
    log "Setting $DEV_USER as the default WSL user"
    printf '\n[user]\ndefault=%s\n' "$DEV_USER" >> /etc/wsl.conf
    ok "default user set (takes effect next WSL restart)"
  fi

  log "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq \
    build-essential pkg-config libudev-dev libssl-dev \
    libclang-dev llvm clang cmake curl git unzip jq protobuf-compiler \
    >/dev/null
  ok "build toolchain installed"

  # Re-exec as the unprivileged user. /mnt/c is slow and CRLF-prone, so the
  # script is copied into the Linux filesystem first.
  log "Switching to phase 2 as $DEV_USER"
  cp "$0" /tmp/wsl-provision.sh
  sed -i 's/\r$//' /tmp/wsl-provision.sh
  chmod 755 /tmp/wsl-provision.sh
  chown "$DEV_USER" /tmp/wsl-provision.sh
  exec su - "$DEV_USER" -c "bash /tmp/wsl-provision.sh"
fi

# ---------------------------------------------------------------------------
# Phase 2: unprivileged user
# ---------------------------------------------------------------------------
cd "$HOME"
ok "running as $(whoami) in $HOME"

log "Rust"
if command -v rustc >/dev/null 2>&1; then
  ok "$(rustc --version)"
else
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null
  ok "installed"
fi
# shellcheck disable=SC1091
. "$HOME/.cargo/env"
rustup component add rustfmt >/dev/null 2>&1 || true

log "Solana CLI"
if command -v solana >/dev/null 2>&1; then
  ok "$(solana --version)"
else
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)" >/dev/null
  ok "installed $(solana --version)"
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

log "Anchor CLI ${ANCHOR_VERSION} (prebuilt)"
if command -v anchor >/dev/null 2>&1; then
  ok "$(anchor --version)"
else
  tmp="$(mktemp -d)"
  url="https://github.com/coral-xyz/anchor/releases/download/v${ANCHOR_VERSION}/anchor-${ANCHOR_VERSION}-x86_64-unknown-linux-gnu"
  if curl -sSfL "$url" -o "$tmp/anchor"; then
    chmod +x "$tmp/anchor"
    sudo mv "$tmp/anchor" /usr/local/bin/anchor
    sudo chmod 755 /usr/local/bin/anchor
    ok "$(anchor --version)"
  else
    warn "prebuilt download failed; falling back to a source build (slow)"
    cargo install --git https://github.com/solana-foundation/anchor --tag "v${ANCHOR_VERSION}" avm
    avm install "$ANCHOR_VERSION"
    avm use "$ANCHOR_VERSION"
  fi
  rm -rf "$tmp"
fi

log "Node.js"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
if ! node --version 2>/dev/null | grep -q "v${NODE_VERSION}"; then
  nvm install "$NODE_VERSION" >/dev/null 2>&1
  nvm alias default "$NODE_VERSION" >/dev/null
fi
nvm use default >/dev/null 2>&1
ok "node $(node --version)"

log "Shell environment"
marker="# x1-devkit toolchain"
# Both files matter: .bashrc for interactive shells, .profile for
# `bash -lc` and scripts (Ubuntu's .bashrc early-returns when not interactive).
for rc in "$HOME/.profile" "$HOME/.bashrc"; do
  touch "$rc"
  if grep -q "$marker" "$rc" 2>/dev/null; then
    ok "$(basename "$rc") already configured"
  else
    cat >> "$rc" <<EOF

$marker
export PATH="\$HOME/.local/share/solana/install/active_release/bin:\$HOME/.cargo/bin:\$PATH"
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
EOF
    ok "added to $(basename "$rc")"
  fi
done

log "Yarn"
if command -v yarn >/dev/null 2>&1; then
  ok "yarn $(yarn --version)"
else
  npm install -g yarn >/dev/null 2>&1
  ok "yarn $(yarn --version)"
fi

log "X1 testnet"
solana config set -u https://rpc.testnet.x1.xyz >/dev/null
if [ ! -f "$HOME/.config/solana/id.json" ]; then
  solana-keygen new --no-bip39-passphrase -o "$HOME/.config/solana/id.json" >/dev/null 2>&1
  ok "generated a new wallet"
else
  ok "wallet already exists"
fi

log "Versions"
rustc --version
solana --version
anchor --version
node --version
printf '\n    address: %s\n' "$(solana address)"
printf '    cluster: %s\n' "$(solana config get | grep 'RPC URL' | awk '{print $3}')"
printf '\n    Fund it at https://faucet.testnet.x1.xyz (the faucet needs a browser)\n\n'
