#!/usr/bin/env bash
# End-to-end test of create-x1-dapp: generate -> install -> build -> dry-run deploy.
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

ROOT="$HOME/x1-gen"
APP="demo-app"

rm -rf "$ROOT"
mkdir -p "$ROOT"
cd "$ROOT" || exit 1

echo "=== generate ==="
node "$HOME/devkit/packages/create-x1-dapp/dist/index.js" "$APP" --kit-path "$HOME/devkit" || exit 1

cd "$APP" || exit 1

echo
echo "=== files ==="
find . -type f -not -path "./node_modules/*" -not -path "./target/*" | sort

echo
echo "=== npm install ==="
npm install --no-audit --no-fund 2>&1 | tail -3

echo
echo "=== npm run doctor ==="
npm run doctor 2>&1 | tail -16

echo
echo "=== npm run build ==="
npm run build 2>&1 | tail -4

echo
echo "=== artifact ==="
ls -lh target/deploy/*.so 2>/dev/null || echo "(no .so)"

echo
echo "=== npm run deploy -- --dry-run ==="
npm run deploy -- --dry-run 2>&1 | tail -12
