#!/usr/bin/env bash
echo "=== .profile (tail) ==="
tail -20 "$HOME/.profile" 2>/dev/null || echo "(missing)"
echo
echo "=== .bashrc (tail) ==="
tail -20 "$HOME/.bashrc" 2>/dev/null || echo "(missing)"
echo
echo "=== toolchain binaries ==="
ls -1 "$HOME/.nvm/versions/node/" 2>/dev/null || echo "no nvm node"
ls -1 "$HOME/.local/share/solana/install/active_release/bin/solana" 2>/dev/null || echo "no solana"
ls -1 /usr/local/bin/anchor 2>/dev/null || echo "no anchor"
