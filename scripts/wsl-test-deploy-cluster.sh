#!/usr/bin/env bash
# Verifies the generated deploy script honours --cluster.
# A dry run only needs a .so and a program keypair, so borrow them from the
# already-built counter project instead of waiting for a fresh Rust build.
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

SRC="$HOME/x1-deploy-test/counter"
[ -f "$SRC/target/deploy/counter.so" ] || { echo "no built counter at $SRC"; exit 1; }

cd "$HOME/x1-gen" || exit 1
rm -rf cli-flag
node "$HOME/devkit/packages/create-x1-dapp/dist/index.js" cli-flag --template basic >/dev/null 2>&1 || exit 1

cd cli-flag || exit 1
npm install --no-audit --no-fund >/dev/null 2>&1

mkdir -p target/deploy
cp "$SRC/target/deploy/counter.so" target/deploy/cli_flag.so
cp "$SRC/target/deploy/counter-keypair.json" target/deploy/cli_flag-keypair.json

echo "=== default from x1.config.ts ==="
node scripts/deploy.mjs --dry-run 2>&1 | sed -n '1,4p'

echo
echo "=== --cluster localnet ==="
node scripts/deploy.mjs --cluster localnet --dry-run 2>&1 | sed -n '1,4p'

echo
echo "=== --cluster mainnet ==="
node scripts/deploy.mjs --cluster mainnet --dry-run 2>&1 | sed -n '1,5p'
