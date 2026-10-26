#!/usr/bin/env bash
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true
cd "$HOME/x1-gen/web2" || exit 1

echo "=== node/npm ==="
node --version
npm --version

echo
echo "=== npm install (verbose tail) ==="
npm install --no-audit --no-fund --loglevel=http 2>&1 | tail -25
echo "exit: $?"

echo
echo "=== node_modules count ==="
ls node_modules 2>/dev/null | wc -l
