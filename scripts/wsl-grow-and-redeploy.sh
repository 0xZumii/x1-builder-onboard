#!/usr/bin/env bash
# Grows the counter program and redeploys, to exercise the auto-extend path.
#
# The first deploy allocated exactly the size of the original .so. Adding a
# static blob makes the next deploy exceed that allocation, which is the
# "account data too small" failure @x1/kit repairs automatically.
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true
cd "$HOME/x1-deploy-test/counter" || exit 1

RPC=https://rpc.mainnet.x1.xyz
CLI="$HOME/devkit/packages/kit/dist/cli.js"
SRC=programs/counter/src/lib.rs

OLD_SIZE="$(stat -c%s target/deploy/counter.so)"
echo "=== current .so: $OLD_SIZE bytes ==="
solana balance --url "$RPC"

ID="$(grep -oP 'declare_id!\("\K[^"]+' "$SRC")"
[ -n "$ID" ] || { echo "cannot read declare_id"; exit 1; }

echo
echo "=== adding padding (8 KiB static + runtime-dependent loop) ==="
cat > "$SRC" <<EOF
use anchor_lang::prelude::*;

declare_id!("$ID");

#[program]
pub mod counter {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    /// Exists only to make the binary bigger, so a redeploy overflows the
    /// account allocated by the previous deploy.
    pub fn pad(_ctx: Context<Initialize>) -> Result<()> {
        // Seed from a runtime value so the compiler cannot fold the loop.
        let seed = Clock::get()?.unix_timestamp as u64;
        let mut sum = seed;
        for byte in PADDING.iter() {
            sum = sum.wrapping_add(*byte as u64);
        }
        msg!("pad {}", sum);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}

static PADDING: [u8; 8192] = [7u8; 8192];
EOF

echo
echo "=== rebuild ==="
anchor build --no-idl -- --arch v0 2>&1 | tail -5

NEW_SIZE="$(stat -c%s target/deploy/counter.so)"
echo
echo "new .so: $NEW_SIZE bytes (+$((NEW_SIZE - OLD_SIZE)))"

echo
echo "=== redeploy (expect auto-extend) ==="
node "$CLI" deploy --cluster mainnet --no-build --name counter 2>&1
status=$?

echo
echo "=== after (exit $status) ==="
solana balance --url "$RPC"
