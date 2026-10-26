#!/usr/bin/env bash
# Puts the toolchain on PATH for BOTH interactive and non-interactive login
# shells. Ubuntu's .bashrc returns early when the shell is not interactive,
# so anything appended there is invisible to `bash -lc` and to scripts.
set -euo pipefail

MARKER="# x1-devkit toolchain"
ENV_FILE="$HOME/devkit/scripts/wsl-env.sh"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }

for f in "$HOME/.profile" "$HOME/.bashrc"; do
  touch "$f"
  if grep -q "$MARKER" "$f"; then
    echo "[ok] $f already has the block"
  else
    {
      echo
      echo "$MARKER"
      cat "$ENV_FILE"
    } >> "$f"
    echo "[ok] appended to $f"
  fi
done

echo
echo "login shell check:"
bash -lc 'echo "  node:   $(node --version 2>/dev/null || echo MISSING)"
echo "  solana: $(solana --version 2>/dev/null || echo MISSING)"
echo "  anchor: $(anchor --version 2>/dev/null || echo MISSING)"'
