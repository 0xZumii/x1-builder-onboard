#!/usr/bin/env bash
# Phase 3 spike: can a local Solana validator run X1's programs?
#
# Boots solana-test-validator with the standard programs cloned from X1
# mainnet, waits for its RPC, then checks the clones are actually usable.
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

LEDGER="$HOME/.x1-localnet"
LOG="$HOME/x1-localnet.log"
RPC="http://127.0.0.1:8899"

# Owned by the upgradeable loader on X1, so their code lives in ProgramData.
UPGRADEABLE=(
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA   # SPL Token
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb   # Token-2022
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s   # Token Metadata
  CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d   # Metaplex Core
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf   # Squads v4
)

# Non-upgradeable: a plain account clone is enough.
PLAIN=(
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL   # Associated Token
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr   # Memo
)

rm -rf "$LEDGER" "$LOG"

args=(--url https://rpc.mainnet.x1.xyz --ledger "$LEDGER" --reset --quiet --rpc-port 8899)
for program in "${UPGRADEABLE[@]}"; do args+=(--clone-upgradeable-program "$program"); done
for program in "${PLAIN[@]}"; do args+=(--clone "$program"); done

echo "=== starting validator ==="
solana-test-validator "${args[@]}" >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null' EXIT

rpc() { curl -s -m 5 -X POST -H 'content-type: application/json' -d "$1" "$RPC"; }

UP=0
for i in $(seq 1 90); do
  if rpc '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"result"'; then
    echo "RPC responding after ${i}s"
    UP=1
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "validator exited before its RPC came up"
    break
  fi
  sleep 1
done

if [ "$UP" -eq 0 ]; then
  echo
  echo "=== log tail ==="
  tail -40 "$LOG"
  exit 1
fi

echo
echo "=== getVersion ==="
rpc '{"jsonrpc":"2.0","id":1,"method":"getVersion"}'
echo
echo "=== getHealth ==="
rpc '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
echo

echo
echo "=== cloned programs usable? ==="
for program in "${UPGRADEABLE[@]}" "${PLAIN[@]}"; do
  payload="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$program\",{\"encoding\":\"base64\",\"dataSlice\":{\"offset\":0,\"length\":1}}]}"
  response="$(rpc "$payload")"
  if echo "$response" | grep -q '"value":{'; then
    echo "  YES  ${program}"
  else
    echo "  no   ${program}  -> $(echo "$response" | head -c 100)"
  fi
done

echo
echo "=== log tail ==="
tail -15 "$LOG"
