#!/usr/bin/env bash
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true
cd "$HOME/x1-deploy-test/counter" || exit 1

RPC=https://rpc.mainnet.x1.xyz
CLI="$HOME/devkit/packages/kit/dist/cli.js"

echo "=== before ==="
solana address
solana balance --url "$RPC"
echo "so: $(ls -l target/deploy/counter.so | awk '{print $5}') bytes"

echo
echo "=== x1 deploy (mainnet) ==="
node "$CLI" deploy --cluster mainnet --no-build --name counter 2>&1
status=$?

echo
echo "=== after (exit $status) ==="
solana balance --url "$RPC"
