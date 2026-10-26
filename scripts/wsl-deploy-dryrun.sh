#!/usr/bin/env bash
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true
cd "$HOME/x1-deploy-test/counter" || exit 1

CLI="$HOME/devkit/packages/kit/dist/cli.js"

echo "=== artifacts ==="
SO="$(ls target/deploy/*.so 2>/dev/null | head -1)"
SIZE="$(stat -c%s "$SO" 2>/dev/null || echo 0)"
echo "so: $SO"
echo "size: $SIZE bytes"
RENT=$(( (SIZE + 128) * 6960 ))
awk -v r="$RENT" 'BEGIN { printf "rent-exempt: %d lamports (~%.4f XNT)\n", r, r/1000000000 }'

echo
echo "=== wallet ==="
solana address
solana balance

echo
echo "=== x1 deploy --dry-run ==="
node "$CLI" deploy --no-build --name counter --dry-run 2>&1
