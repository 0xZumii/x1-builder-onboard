#!/usr/bin/env bash
# Checks the demo picks a distinct port and serves our page (not another app).
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

cd "$HOME/x1-demo" || exit 1
PORT=5199

echo "=== occupying $PORT with a fake app ==="
node -e "require('http').createServer((_,r)=>r.end('<title>nft marketplace</title>')).listen($PORT)" &
FAKE=$!
sleep 1

echo "=== demo port scan should skip it ==="
P="$PORT"
for _ in $(seq 1 20); do
  if ! (echo >"/dev/tcp/127.0.0.1/$P") 2>/dev/null; then break; fi
  P=$((P + 1))
done
echo "    chose $P"

echo
echo "=== starting vite on $P with --strictPort ==="
npm run dev -- --port "$P" --strictPort >"$HOME/port-test-vite.log" 2>&1 &
VITE=$!

for i in $(seq 1 40); do
  curl -s -m 2 -o /dev/null "http://127.0.0.1:$P" && break
  sleep 1
done

echo "=== title check ==="
TITLE="$(curl -s "http://127.0.0.1:$P" | grep -o '<title>[^<]*</title>')"
echo "    $TITLE"
if echo "$TITLE" | grep -q "x1-demo"; then
  echo "    PASS serves our page, not the marketplace"
else
  echo "    FAIL wrong page"
fi

kill "$VITE" 2>/dev/null
kill "$FAKE" 2>/dev/null
pkill -f "vite" 2>/dev/null
