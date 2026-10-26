#!/usr/bin/env bash
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true
cd "$HOME/x1-deploy-test/counter" || exit 1

echo "=== anchor build --help ==="
anchor build --help 2>&1 | head -40

echo
echo "=== cargo-build-sbf --help (head) ==="
cargo-build-sbf --help 2>&1 | head -30
