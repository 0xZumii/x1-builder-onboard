#!/usr/bin/env bash
#
# One-command demo: local validator, a scaffolded program deployed to it, and a
# web UI you can click through with a real wallet.
#
#   bash scripts/demo.sh
#
# Ctrl-C stops everything.
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true

REPO="$HOME/devkit"
APP="$HOME/x1-demo"
RPC="http://127.0.0.1:8899"

# Not 5173: that is Vite's default and the first thing another project grabs.
PORT="${X1_DEMO_PORT:-5199}"
for _ in $(seq 1 20); do
  if ! (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then break; fi
  PORT=$((PORT + 1))
done

LOCALNET_PID=""
VITE_PID=""

cleanup() {
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null
  [ -n "$LOCALNET_PID" ] && kill "$LOCALNET_PID" 2>/dev/null
  pkill -f solana-test-validator 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

rpc() { curl -s -m 3 -X POST -H 'content-type: application/json' -d "$1" "$RPC"; }

wait_for() {
  local url="$1" tries="${2:-60}" i
  for ((i = 1; i <= tries; i += 1)); do
    if curl -s -m 2 -o /dev/null "$url"; then return 0; fi
    sleep 1
  done
  return 1
}

echo
echo "X1 demo — this takes about four minutes, most of it compiling Rust."
echo

# ---------------------------------------------------------------- localnet
echo "==> starting a local validator (X1's programs cloned from mainnet)"
pkill -f solana-test-validator 2>/dev/null
sleep 1
node "$REPO/packages/kit/dist/cli.js" localnet --reset >"$HOME/x1-demo-localnet.log" 2>&1 &
LOCALNET_PID=$!

if ! wait_for "$RPC" 90; then
  echo "    validator did not come up; see ~/x1-demo-localnet.log"
  tail -20 "$HOME/x1-demo-localnet.log"
  exit 1
fi
echo "    ready"

# The deployer wallet needs rent. Local faucet, no CAPTCHA.
echo "==> funding the CLI wallet"
solana -u "$RPC" airdrop 10 >/dev/null 2>&1 || true
echo "    $(solana -u "$RPC" balance 2>/dev/null | head -1)"

# ---------------------------------------------------------------- generate
echo "==> scaffolding a project"
rm -rf "$APP"
cd "$HOME" || exit 1
node "$REPO/packages/create-x1-dapp/dist/index.js" x1-demo --cluster localnet >/dev/null
cd "$APP" || exit 1
npm install --no-audit --no-fund >/dev/null 2>&1
echo "    done"

echo "==> building the program (about three minutes, no output until it ends)"
if ! npm run build >"$HOME/x1-demo-build.log" 2>&1; then
  echo "    build failed:"
  tail -25 "$HOME/x1-demo-build.log"
  exit 1
fi
echo "    $(ls -lh target/deploy/*.so | awk '{print $5, $9}')"

# ---------------------------------------------------------------- deploy
echo "==> deploying to the local validator"
if ! npm run deploy >"$HOME/x1-demo-deploy.log" 2>&1; then
  echo "    deploy failed:"
  tail -20 "$HOME/x1-demo-deploy.log"
  exit 1
fi
tail -5 "$HOME/x1-demo-deploy.log"

# ---------------------------------------------------------------- web
echo "==> starting the web UI on port $PORT"
cd "$APP" || exit 1
npm run dev -- --port "$PORT" --strictPort >"$HOME/x1-demo-vite.log" 2>&1 &
VITE_PID=$!

if ! wait_for "http://127.0.0.1:$PORT" 60; then
  echo "    vite did not start; see ~/x1-demo-vite.log"
  tail -20 "$HOME/x1-demo-vite.log"
  exit 1
fi

# Make sure we are looking at our page and not something else on that port.
if ! curl -s "http://127.0.0.1:$PORT" | grep -q "x1-demo"; then
  echo "    port $PORT is serving something else; try X1_DEMO_PORT=5300 bash scripts/demo.sh"
  exit 1
fi

WALLET="$(solana address 2>/dev/null)"

cat <<EOF

────────────────────────────────────────────────────────────────────
  Open:  http://localhost:$PORT
────────────────────────────────────────────────────────────────────

  In X1 Wallet (browser extension):

    1. Settings → RPC → add a custom endpoint:  $RPC
       then switch to it.
    2. Click "Connect wallet" on the page, approve in the wallet.
    3. Copy the address the page shows.

  Then airdrop to that address — this terminal is busy running the demo, so
  open a second one:

       wsl -d Ubuntu-24.04 -u dev
       source ~/.profile
       solana -u $RPC airdrop 5 <PASTE-ADDRESS-HERE>

  Back on the page:

    4. Click Initialize    (creates the counter account, ~0.002 XNT)
    5. Click Increment     (the number goes up)
    6. Click Increment again — state is read from the chain, so it persists.

  The deployer wallet, for reference: $WALLET

  Ctrl-C here stops the validator and the web server.
────────────────────────────────────────────────────────────────────

EOF

if [ "${DEMO_EXIT_AFTER_SETUP:-0}" = "1" ]; then
  echo "DEMO_EXIT_AFTER_SETUP=1 — setup verified, exiting."
  exit 0
fi

wait "$VITE_PID"
