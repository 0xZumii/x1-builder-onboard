#!/usr/bin/env bash
# Verifies the web template: generate -> install -> vite build.
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

ROOT="$HOME/x1-gen"
APP="web-demo"

rm -rf "$ROOT/$APP"
mkdir -p "$ROOT"
cd "$ROOT" || exit 1

echo "=== generate (web) ==="
node "$HOME/devkit/packages/create-x1-dapp/dist/index.js" "$APP" --template web --kit-path "$HOME/devkit" || exit 1

cd "$APP" || exit 1

echo
echo "=== files ==="
find . -type f -not -path "./node_modules/*" -not -path "./target/*" | sort

echo
echo "=== program id substituted? ==="
grep -o "new PublicKey(\"[^\"]*\")" web/main.js || echo "MISSING"

echo
echo "=== scripts ==="
node -e 'const p=require("./package.json"); console.log(JSON.stringify(p.scripts,null,2)); console.log("deps:", Object.keys(p.dependencies||{}).join(", ")); console.log("dev:", Object.keys(p.devDependencies||{}).join(", "))'

echo
echo "=== npm install ==="
npm install --no-audit --no-fund 2>&1 | tail -3

echo
echo "=== vite build ==="
npm run build:web 2>&1 | tail -15

echo
echo "=== output ==="
ls -lh web/dist 2>/dev/null || echo "(no dist)"
