#!/usr/bin/env bash
# Reproduces the demo's deploy failure and captures the real error.
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

RPC="http://127.0.0.1:8899"
pkill -f solana-test-validator 2>/dev/null
sleep 1

echo "=== start validator ==="
node "$HOME/devkit/packages/kit/dist/cli.js" localnet --reset >"$HOME/diag-localnet.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; pkill -f solana-test-validator 2>/dev/null' EXIT

for i in $(seq 1 60); do
  curl -s -m 2 -X POST -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$RPC" | grep -q result && break
  sleep 1
done

echo
echo "=== airdrop 10 ==="
solana -u "$RPC" airdrop 10 2>&1 | tail -2

echo
echo "=== balance, three ways ==="
solana -u "$RPC" balance 2>&1
solana -u "$RPC" balance --lamports 2>&1
curl -s -X POST -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$(solana address)\"]}" "$RPC"

echo
echo
echo "=== deploy (full output) ==="
cd "$HOME/x1-demo" || exit 1
node scripts/deploy.mjs 2>&1 | head -40
