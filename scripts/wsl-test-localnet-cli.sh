#!/usr/bin/env bash
# Verifies `x1 localnet` boots a validator with the cloned programs.
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

LOG="$HOME/x1-localnet-cli.log"
RPC="http://127.0.0.1:8899"
CLI="$HOME/devkit/packages/kit/dist/cli.js"

pkill -f solana-test-validator 2>/dev/null
sleep 1
rm -f "$LOG"

NO_COLOR=1 node "$CLI" localnet --reset >"$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null; pkill -f solana-test-validator 2>/dev/null; }
trap cleanup EXIT

rpc() { curl -s -m 5 -X POST -H 'content-type: application/json' -d "$1" "$RPC"; }

UP=0
for i in $(seq 1 60); do
  if rpc '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"result"'; then
    echo "RPC up after ${i}s"
    UP=1
    break
  fi
  sleep 1
done

if [ "$UP" -eq 0 ]; then
  echo "validator did not come up"
  tail -30 "$LOG"
  exit 1
fi

echo
echo "=== cli banner ==="
head -8 "$LOG"

echo
echo "=== cloned program check ==="
for program in metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf; do
  payload="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$program\",{\"encoding\":\"base64\",\"dataSlice\":{\"offset\":0,\"length\":1}}]}"
  if rpc "$payload" | grep -q '"value":{'; then
    echo "  YES  $program"
  else
    echo "  no   $program"
  fi
done

echo
echo "=== airdrop works locally (no faucet needed) ==="
solana -u "$RPC" airdrop 5 2>&1 | head -2
solana -u "$RPC" balance 2>&1 | head -1

echo
echo "done"
