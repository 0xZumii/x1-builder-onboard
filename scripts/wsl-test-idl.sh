#!/usr/bin/env bash
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true
cd "$HOME/x1-gen/web2" || exit 1

echo "=== npm run idl ==="
npm run idl 2>&1 | tail -6

echo
echo "=== target/idl ==="
ls -l target/idl/ 2>&1

echo
echo "=== instructions in idl ==="
node -e 'const fs=require("fs");const i=JSON.parse(fs.readFileSync("target/idl/web2.json","utf8"));console.log((i.instructions||[]).map(x=>x.name).join(", "))' 2>&1

echo
echo "=== vite build ==="
npm run build:web 2>&1 | tail -5
