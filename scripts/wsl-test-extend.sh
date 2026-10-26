#!/usr/bin/env bash
# Answers one question cheaply: does X1's loader support ExtendProgram?
#
# Extends the live program by 10,240 bytes (~0.071 XNT of extra rent) and shows
# the allocation before/after. If this fails, the kit's recovery strategy needs
# to change (allocate headroom up front with --max-len instead).
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

RPC=https://rpc.mainnet.x1.xyz
PROGRAM=89bFvUeVuk9sCGZJeDAtZFh6pYYS24UbZKRpY7863PiS
BYTES="${1:-10240}"

echo "=== before ==="
solana program show "$PROGRAM" --url "$RPC" 2>&1 | grep -E "Program Id|Owner|Authority|Data Length|Last Deployed"
solana balance --url "$RPC"

echo
echo "=== solana program extend $PROGRAM $BYTES ==="
solana program extend "$PROGRAM" "$BYTES" --url "$RPC" --keypair "$HOME/.config/solana/id.json" 2>&1
status=$?

echo
echo "=== after (exit $status) ==="
solana program show "$PROGRAM" --url "$RPC" 2>&1 | grep -E "Data Length|Last Deployed"
solana balance --url "$RPC"
