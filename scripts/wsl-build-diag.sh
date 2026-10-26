#!/usr/bin/env bash
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true
cd "$HOME/x1-deploy-test/counter" || { echo "no project"; exit 1; }

echo "=== rust-toolchain.toml ==="
cat rust-toolchain.toml 2>/dev/null || echo "(none)"

echo
echo "=== Cargo.toml ==="
cat Cargo.toml 2>/dev/null || echo "(none)"

echo
echo "=== Cargo.lock ==="
if [ -f Cargo.lock ]; then
  head -5 Cargo.lock
else
  echo "(absent)"
fi

echo
echo "=== cargo / rustc ==="
cargo --version
rustc --version
rustup toolchain list 2>/dev/null || true

echo
echo "=== sbf toolchain ==="
ls -1 "$HOME/.cache/solana" 2>/dev/null || echo "(no cache dir)"
find "$HOME/.cache/solana" -maxdepth 3 -name "cargo" -o -maxdepth 3 -name "rustc" 2>/dev/null | head -5
