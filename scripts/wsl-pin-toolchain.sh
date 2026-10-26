#!/usr/bin/env bash
#
# Pins the toolchain to versions that produce deployable X1 artifacts.
#
# Why not "latest":
#   solana-cli 4.3.2 defaults to SBPFv3 and its bundled platform-tools (v1.52)
#   rejects that target: "Platform tools v1.52 is incompatible with SBPFv3".
#   X1's own docs pin solana-cli 2.0.26, whose cargo-build-sbf emits the older,
#   universally accepted SBPF target. Anchor 0.31.1 is the nearest release with
#   a prebuilt Linux binary (0.30.1, the version in X1's docs, has none).
#
# Override with SOLANA_VERSION / ANCHOR_VERSION if you know better.
set -euo pipefail

SOLANA_VERSION="${SOLANA_VERSION:-v2.0.24}"
ANCHOR_VERSION="${ANCHOR_VERSION:-0.31.1}"

# shellcheck disable=SC1091
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

echo "==> solana $SOLANA_VERSION"
agave-install init "$SOLANA_VERSION"
solana --version

echo
echo "==> anchor $ANCHOR_VERSION (prebuilt)"
tmp="$(mktemp -d)"
url="https://github.com/coral-xyz/anchor/releases/download/v${ANCHOR_VERSION}/anchor-${ANCHOR_VERSION}-x86_64-unknown-linux-gnu"
curl -sSfL "$url" -o "$tmp/anchor"
chmod +x "$tmp/anchor"
sudo mv "$tmp/anchor" /usr/local/bin/anchor
sudo chmod 755 /usr/local/bin/anchor
rm -rf "$tmp"
anchor --version

echo
echo "==> versions"
rustc --version
solana --version
anchor --version
node --version
