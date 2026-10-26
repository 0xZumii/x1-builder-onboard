#!/usr/bin/env bash
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

SOLANA_VERSION="${SOLANA_VERSION:-v2.0.26}"

echo "==> agave-install init $SOLANA_VERSION"
if agave-install init "$SOLANA_VERSION"; then
  echo "[ok] installed"
else
  echo "[!!] failed; available releases:"
  agave-install list 2>/dev/null | head -25 || true
  exit 1
fi

echo
solana --version
