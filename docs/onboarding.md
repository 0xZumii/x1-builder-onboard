# Zero to your first X1 program

This is the shortest path from nothing to a program running on X1. Every
command here has been run on a clean machine; the expected output is included so
you can tell when something is wrong.

Two of the steps exist because of traps that are not documented anywhere else
(see [`findings.md`](findings.md)): the Anchor build needs an extra flag on
current Solana clients, and the testnet faucet is currently down.

---

## 0. Prerequisites

| | |
| --- | --- |
| **Windows** | WSL2. There is no native Windows build of Solana or Anchor. |
| **Linux / macOS** | Nothing beyond a shell. |
| Node | 20 or newer |

### Windows

Open PowerShell **as Administrator**:

```powershell
wsl --install -d Ubuntu-24.04
```

Reboot if it asks, then provision the toolchain:

```powershell
.\scripts\setup.ps1 -Apply
```

That creates a `dev` user (not root), installs Rust, the Solana CLI, Anchor and
Node, generates a wallet, and points the CLI at X1 testnet.

> Work inside the Linux filesystem, not `/mnt/c`. Cargo and the SBF compiler are
> dramatically slower over the Windows mount. The provisioner creates
> `~/devkit` pointing at the repo for convenience.

### Linux / macOS

```sh
bash scripts/setup.sh
```

---

## 1. Get the repo and build it

```sh
git clone https://github.com/0xZumii/x1-builder-onboard.git
cd x1-builder-onboard
npm install
npm run build
```

The packages are not on npm yet, so this is the install. `npm run build`
compiles `@x1/kit` and the scaffolder.

---

## 2. Check your environment

```sh
node packages/kit/dist/cli.js doctor
```

Expect something like:

```
✓ Node.js                v24.10.0
✓ Platform               linux
✓ Solana CLI             solana-cli 4.3.2
✓ SBPF target            4.3.2 · SBPFv0 via --arch v0
✓ Anchor CLI             anchor-cli 0.31.1
✓ Rust                   rustc 1.99.1
✓ RPC endpoint           https://rpc.testnet.x1.xyz · 536ms · ok
✓ Rate limit headers     1/400 per 5s · 1/15 conn
✓ Chain is producing     slot 198,330,166
! Wallet                 2F2gu… · 0.0000 XNT
! Testnet faucet         down · 404 · Cannot GET /v1/health/faucet
```

The wallet being empty is expected. The faucet line tells you whether funding is
possible right now — see step 4.

If `SBPF target` shows a **failure**, your Solana client is a version whose
default build target its own tooling rejects. `x1 deploy` handles it, but a bare
`anchor build` will not; see [`findings.md`](findings.md) #7.

---

## 3. Run a local validator

Skip the public cluster entirely while you build. This clones X1's real programs
from mainnet and boots in a few seconds:

```sh
node packages/kit/dist/cli.js localnet --reset
```

In a **second terminal**, fund a wallet — no faucet, no CAPTCHA:

```sh
solana -u http://127.0.0.1:8899 airdrop 5
```

```
X1 localnet

  rpc      http://127.0.0.1:8899
  ledger   /home/dev/.x1-localnet
  clones   7 programs from https://rpc.mainnet.x1.xyz
```

You now have SPL Token, Token-2022, Token Metadata, Metaplex Core, Squads v4,
Associated Token and Memo, as X1's actual bytecode.

---

## 4. Scaffold a project

In a third terminal:

```sh
npm run create -- my-app
cd my-app
npm install
```

```
✓ Created my-app in /home/dev/my-app

  program id   9Mixq95Z9VhaKPfMFah2kHzdf9vwqrzEgyP6d1am3DPz
  module       my_app
  template     web
  cluster      testnet https://rpc.testnet.x1.xyz
```

The program id is generated now and wired into both `declare_id!` and the
keypair, so there is nothing to configure by hand.

---

## 5. Build it

```sh
npm run build
```

This runs `anchor build --no-idl -- --arch v0`. A first build takes two to three
minutes while it compiles dependencies.

```
Finished `release` profile [optimized] target(s) in 2m 38s
```

You should now have `target/deploy/my_app.so`, around 180KB.

---

## 6. See it work in a browser

With the local validator still running from step 3:

```sh
npm run dev
```

Open the printed URL, click **Connect wallet**, then **Initialize**, then
**Increment**. The counter is real program state on your local validator.

The page talks to `http://127.0.0.1:8899` by default. If you do not have a
browser wallet extension, skip this step — nothing downstream depends on it.

---

## 7. Deploy

Cost first, transaction second:

```sh
npm run deploy -- --dry-run
```

```
first deploy · 184272 bytes · rent 1.3878 XNT (+15000 headroom)
[dry-run] solana program deploy … --max-len 199272
[dry-run] required balance: 1.3878 XNT
dry run — nothing was sent
```

**Deploying is not free, and it is not about fees.** The program account must be
rent-exempt: roughly 1.2 XNT per 180KB, locked up, not spent. `--max-len`
pre-allocates 15KB of growth room so later redeploys fit.

Then:

```sh
npm run deploy
```

### Funding

- **Local** — already funded in step 3. `npm run deploy -- --cluster localnet`
  if you want to deploy locally first.
- **Testnet** — `x1 faucet --status` first. If it says `DOWN`, it is an upstream
  outage, not you; keep working locally.
- **Mainnet** — real XNT. Note that *redeploying* an already-deployed program
  needs about **twice** the rent available, because the CLI stages the new
  binary in a buffer account that is refunded on success.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Platform tools v1.52 is incompatible with SBPFv3` | Solana 4.x defaults to an unsupported target | `anchor build --no-idl -- --arch v0` |
| Anchor exits non-zero *after* printing `Finished` | `--arch` forwarded into the IDL step | add `--no-idl` |
| `account data too small` on redeploy | program account was sized to the old binary | `npm run deploy` repairs it, or use `headroom` |
| `insufficient funds for spend (1.19 SOL)` on redeploy | buffer account needs its own rent | have ~2x rent available |
| `429` with an HTML body | more than ~12 concurrent requests | stay under the connection cap |
| Faucet page shows `Cannot GET /v1/health/faucet` | faucet backend is down | `x1 localnet`, airdrop locally |
| `Cannot find module '@x1/kit'` | repo not built, or project not linked | `npm run build` in the repo, then reinstall |

---

## Where to go next

- [`findings.md`](findings.md) — every measured quirk, with reproduction scripts
- `packages/kit/README.md` — the library API
- `packages/create-x1-dapp/README.md` — what the scaffolder gives you
- `x1 doctor` after any change; it catches most of the above before you do

The program in `programs/my_app/src/lib.rs` is a counter with two instructions.
Replace it with something you care about — nothing else in the project needs to
change.
