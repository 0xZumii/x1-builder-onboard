#!/usr/bin/env bash
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true
cd "$HOME/x1-deploy-test/counter" || exit 1

echo "=== solana rustup toolchain ==="
rustup run solana cargo --version 2>&1 || echo "(cannot run)"
rustup run solana rustc --version 2>&1 || echo "(cannot run)"

echo
echo "=== build with RUSTUP_TOOLCHAIN=solana ==="
rm -f Cargo.lock
RUSTUP_TOOLCHAIN=solana anchor build 2>&1
status=$?
echo "exit: $status"

echo
echo "=== lockfile version after build ==="
head -4 Cargo.lock 2>/dev/null || echo "(no lockfile)"
echo
echo "=== artifacts ==="
ls -lh target/deploy/ 2>/dev/null || echo "(none)"
