#!/usr/bin/env bash
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

echo "==> switching back to stable (4.x) client"
agave-install init stable 2>&1 | tail -2
solana --version

cd "$HOME/x1-deploy-test/counter" || exit 1

echo
echo "==> build with --arch v0"
rm -f Cargo.lock
anchor build -- --arch v0 2>&1
status=$?
echo "exit: $status"

echo
echo "=== lockfile version ==="
head -4 Cargo.lock 2>/dev/null || echo "(none)"

echo
echo "=== artifacts ==="
ls -lh target/deploy/ 2>/dev/null || echo "(none)"
