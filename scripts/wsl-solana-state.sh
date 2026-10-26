#!/usr/bin/env bash
# Reports the installed Solana toolchain and the available install commands.
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

echo "=== current solana ==="
solana --version 2>/dev/null || echo "(none)"
echo
echo "=== installer binaries ==="
for cmd in agave-install solana-install; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd -> $(command -v "$cmd")"
  else
    echo "$cmd -> (absent)"
  fi
done
echo
echo "=== installed releases ==="
ls -1 "$HOME/.local/share/solana/install/releases" 2>/dev/null || echo "(none)"
echo
echo "=== platform tools ==="
ls -1 "$HOME/.cache/solana" 2>/dev/null || echo "(none)"
