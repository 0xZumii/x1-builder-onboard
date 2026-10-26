# Getting XNT onto X1

XNT is X1's native token. You need it for two different things:

- **Fees** — tiny. A deploy costs a few thousandths of an XNT.
- **Rent** — not tiny. A deployed program's account must hold a rent-exempt
  deposit, and that deposit is **locked, not spent**. Get it back by closing the
  program.

Measured on mainnet: a 174KB Anchor program needs **1.2127 XNT** of rent. A
184KB one with 15KB of headroom needs **1.3878 XNT**. Upgrading an
already-deployed program needs about **twice** its rent available temporarily
(the CLI stages the new binary in a buffer account, refunded on success).

Check where you stand at any time:

```sh
x1 funds
```

Inside a project it prices the deploy you are about to do:

```
X1 funds mainnet

  wallet   2F2guVPYyZeqpq7uXqrMD8SiJF7VFhFts2MAJhRC9rah
  XNT      0.1104 XNT
  upgrade · 171256 bytes
  needs    2.3857 XNT
  short    2.2753 XNT
```

---

## The route

**There is no direct SOL → XNT bridge.** The Warp Bridge moves a fixed set of
assets between Solana and X1 — currently USDC (as USDC.X), DGN and XENCAT. SOL
is not one of them.

So the working path is:

```
SOL on Solana
   ↓  swap on any Solana DEX (Jupiter, Raydium, …)
USDC on Solana
   ↓  Warp Bridge  →  https://app.bridge.x1.xyz/
USDC.X on X1
   ↓  swap  →  https://app.xdex.xyz/swap
XNT
```

Each step is its own transaction, so keep SOL for Solana fees and XNT for X1
fees at every stage.

### Step by step

1. **Hold USDC on Solana.** If you only have SOL, swap it first — the bridge
   does not accept SOL.
2. **Bridge.** Open <https://app.bridge.x1.xyz/>, connect a wallet that holds
   the Solana-side USDC, and deposit. USDC.X is minted 1:1; it is backed by USDC
   locked on Solana, not by a custodian.
3. **Swap to XNT.** Open <https://app.xdex.xyz/swap>, connect the same wallet on
   X1, and swap USDC.X → XNT.
4. **Verify.** `x1 funds` should now show a balance, and `x1 deploy` will stop
   complaining about rent.

<https://wallet.x1.xyz> bundles bridging and swapping in one app if you would
rather not hop between tabs. The route is the same.

### Bringing assets back

The bridge works both ways, 1:1, at any time. Swap XNT → USDC.X first if you
want to exit to Solana.

---

## Before you move real money

- **Start with a small amount.** Do one full round trip — bridge, swap, and
  bridge back — before moving anything you would miss.
- **Bridge minimums and fees apply on both sides.** Bridging dust usually costs
  more than it moves.
- **Keep a little XNT spare.** Rent is a deposit, but fees are spent. A wallet at
  exactly the rent amount cannot pay to deploy.
- **Rent scales with program size.** `x1 funds` in your project gives the real
  number rather than the estimate above.
- **Closing a program refunds the rent** to the upgrade authority:
  `solana program close <PROGRAM_ID>`.
- X1's bridge and DEX are third-party interfaces to on-chain programs. Verify
  the URL you are on before signing anything.

---

## On testnet

Do not buy anything to test. Testnet has its own XNT:

```sh
x1 faucet --status     # check whether the public faucet is up
x1 localnet --reset    # or skip the public cluster entirely
```

`x1 localnet` runs a validator with X1's programs cloned in, and a faucet that
always works:

```sh
solana -u http://127.0.0.1:8899 airdrop 5
```
