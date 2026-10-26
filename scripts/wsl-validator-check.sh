#!/usr/bin/env bash
# Phase 3 spike: what would a local X1-compatible validator need?
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

echo "=== solana-test-validator present? ==="
command -v solana-test-validator || echo "NOT FOUND"
solana-test-validator --version 2>&1 | head -2

echo
echo "=== clone-related flags ==="
solana-test-validator --help 2>&1 | grep -iE "clone|url|reset|limit" | head -20

echo
echo "=== ledger dir writable ==="
df -h "$HOME" | tail -1
