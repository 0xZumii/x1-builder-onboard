#!/usr/bin/env bash
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

echo "=== outside a project ==="
cd "$HOME/devkit" || exit 1
NO_COLOR=1 node packages/kit/dist/cli.js funds --cluster mainnet 2>&1

echo
echo "=== inside the built counter project ==="
cd "$HOME/x1-deploy-test/counter" || exit 1
NO_COLOR=1 node "$HOME/devkit/packages/kit/dist/cli.js" funds --cluster mainnet 2>&1
