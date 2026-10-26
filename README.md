# x1-devkit

Developer toolkit for the [X1](https://x1.xyz) SVM blockchain.

**New here?** [`docs/onboarding.md`](docs/onboarding.md) goes from nothing to a
deployed program in seven steps — including what to do while the testnet faucet
is down.

X1 is fully Solana-VM compatible, so `@solana/web3.js`, Anchor and Metaplex all
work unchanged. What is *not* unchanged is the network's behaviour under load —
and that is what this kit handles.

```ts
import { createX1Connection } from "@x1/kit";

const connection = createX1Connection({ cluster: "testnet" });

const slot = await connection.getSlot();
```

## Why this exists

Every X1 developer hits the same five walls in the same order. This package
removes four of them and reports the fifth clearly.

| Wall | What this does |
| --- | --- |
| Public RPC rate limits, and a **connection limit that binds before the rate limit** | Admission control, adaptive limits, 429 backoff |
| `account data too small` on every redeploy | `deployProgram()` extends and retries automatically |
| `Anchor.toml` + `solana config set` hand-editing | One `x1.config.ts`, resolved for you |
| No single "is my machine ready" check | `x1 doctor` |
| Faucet is a web page, not a documented RPC method | `x1 faucet`, with a fallback that tells you the truth |

## Measured, not assumed

The [published docs](https://docs.x1.xyz/build-on-x1/rpc-rate-limits) list one
set of limits. The two public endpoints do not agree with them, or with each
other:

| | Docs | mainnet | testnet |
| --- | --- | --- | --- |
| Requests / 5s | 300 | 300 | **400** |
| Heavy methods / 5s | 40 | 40 | 40 |
| Hourly cap | 150,000 | 150,000 | **no header** |
| Concurrent connections | 30 | 30 | **15** |

The connection figure is the one that matters, and even it is optimistic. At 30
concurrent requests, testnet returns `429` for **exactly half** of them. A
sustained load test against testnet shows where the real ceiling sits:

| Concurrency | 60 requests |
| --- | --- |
| 8 | 60/60 · 1465ms |
| 10 | 60/60 · 1377ms |
| **12** | **60/60 · 1158ms** |
| 15 (advertised) | **29/60 · 1138ms** |

The advertised number counts TCP connections, and TLS setup plus socket churn
means N concurrent requests can briefly be N+ sockets. So the kit applies 20%
headroom (`CONNECTION_HEADROOM`) and uses 12 of testnet's 15, 24 of mainnet's
30.

So the kit:

1. bootstraps from per-cluster limits, so the very first burst is already safe;
2. adopts whatever the `X-RateLimit-*` / `X-Conn-*` headers advertise, because
   those are authoritative — then backs off 20% for socket churn;
3. halves the connection pool on a `429` and honours `Retry-After` across every
   in-flight caller, instead of retrying and making it worse.

Measured result: 60 concurrent `getSlot` calls complete in ~1.1s with zero
`429`s. Without the throttle, the same load fails half the calls.

`@solana/web3.js` also retries `429`s on its own by default, which fights any
client-side throttling and hides the failure. This kit disables that
(`disableRetryOnRateLimit: true`) so there is exactly one retry policy.

## Install

These packages are **not on npm yet**, so install from the repository:

```sh
git clone https://github.com/0xZumii/x1-builder-onboard.git
cd x1-builder-onboard
npm install
npm run build
```

Then either use the CLI directly or scaffold a project:

```sh
node packages/kit/dist/cli.js doctor
npm run create -- my-app
```

Requires Node 20+. The Rust/Anchor toolchain is only needed for builds and
deploys. They will be published as `@x1/kit` and `create-x1-dapp` once those
names are claimed on npm.

## Windows / WSL2

There is no supported native Windows build of the Solana CLI or Anchor — the
official installer is Linux/macOS only, and X1's docs assume Linux. The correct
path is WSL2:

```powershell
cd x1-devkit
.\scripts\setup.ps1           # plan only, changes nothing
.\scripts\setup.ps1 -Apply    # install (elevated shell; may need a reboot)
```

That creates a `dev` user (not root), installs Ubuntu 24.04, then delegates to
`scripts/wsl-provision.sh`:

| Component | Version | How |
| --- | --- | --- |
| Rust | stable (1.99.x) | rustup, minimal profile |
| Solana CLI | **stable (4.3.x)** | `agave-install` — built with `--arch v0`, which the kit passes for you |
| Anchor CLI | **0.31.1** | prebuilt binary — 0.30.1 (in X1's docs) has no Linux build |
| Node | 24.10.0 | nvm |

Two WSL gotchas the provisioner handles, both of which cost real time:

- Ubuntu's `.bashrc` returns early for non-interactive shells, so anything
  appended there is invisible to `bash -lc` and to scripts. The PATH block goes
  into `~/.profile` **and** `~/.bashrc`.
- Paths containing spaces break when passed through PowerShell into `wsl.exe`.
  Use `wsl --cd <dir>` rather than embedding a `cd` in a quoted command string.

Working copy inside WSL (the provisioner creates this symlink):

```sh
ln -sfn "/mnt/c/Users/<you>/.../x1-devkit" ~/devkit
cd ~/devkit && node packages/kit/dist/cli.js doctor
```

Keep *Anchor projects* on the Linux filesystem (`~/x1-deploy-test`, not
`/mnt/c`). Cargo and the SBF compiler are far slower and flakier over the 9p
mount.

## Commands

```
x1 doctor              Verify toolchain, RPC, rate limits and wallet
x1 status              Chain info, latency, live rate-limit budget
x1 deploy              Build, deploy, auto-extend
x1 localnet            Local validator with X1's programs cloned in
x1 faucet              Request testnet XNT
x1 faucet --status     Check whether the faucet is up, without funding
x1 balance             Show a wallet balance
```

```sh
npx x1 doctor
npx x1 deploy --name my_program
```

## Local development

```sh
x1 localnet --reset
```

Boots `solana-test-validator` with X1's standard programs cloned from mainnet —
SPL Token, Token-2022, Token Metadata, Metaplex Core, Squads v4, Associated
Token and Memo. Verified: RPC ready in ~5s, all seven present and executable.

Because the clone source is the real cluster, those are X1's actual bytecode
rather than Solana's. Point a project at it with `cluster: "localnet"` in
`x1.config.ts`.

It also sidesteps the testnet faucet outage — the local validator runs its own
faucet:

```sh
solana -u http://127.0.0.1:8899 airdrop 5
```

No Docker required. `--no-clone` gives a bare validator; `--port` and `--ledger`
allow parallel stacks.

## Is the faucet down?

```sh
x1 faucet --status
```

This checks the faucet page *and* the health route its own frontend calls before
it will submit. When it reports `DOWN`, the problem is upstream — which is worth
knowing before you go looking for a bug in your wallet or your code.

```
X1 testnet faucet

  verdict   DOWN
  page      https://faucet.testnet.x1.xyz                200
  health    https://api.xen.network/v1/health/faucet     404 · Cannot GET /v1/health/faucet
```

Exit code is 1 when the faucet is down, so it is usable in scripts.

## Scaffolding a project

```sh
npm run create -- my-app     # in this repo, until the packages are published
cd my-app && npm install
npm run doctor
npm run build
npm run dev        # web UI, against a local validator
npm run deploy
```

That generates an Anchor program with a program id already derived, an
`x1.config.ts`, a Vite web app, and a deploy script that:

- builds with `--arch v0 --no-idl` (required on solana-cli 4.x),
- estimates rent and refuses *before* sending anything if the wallet is short,
- repairs `account data too small` on redeploys by extending and retrying.

Nothing in the template is aspirational — each command is one this repo has run
against X1.

## Status

| Phase | What | State |
| --- | --- | --- |
| 1 | `@x1/kit` — connection, throttle, deploy, doctor | working, verified on Windows and Linux against live X1 |
| 2 | `create-x1-dapp` scaffolder | working, tested end to end in WSL |
| 3 | Local validator with X1 programs cloned | **working** — `x1 localnet`, ~5s boot, 7 programs |
| 4 | Explorer plugin / docs PR | planned |

Build and deploy verified end to end on **X1 mainnet**:

- program [`89bFvUeVuk9sCGZJeDAtZFh6pYYS24UbZKRpY7863PiS`](https://explorer.mainnet.x1.xyz/address/89bFvUeVuk9sCGZJeDAtZFh6pYYS24UbZKRpY7863PiS)
- 174,112-byte Anchor program, 1.2127 XNT rent, deploy confirmed on-chain
- `anchor build --no-idl -- --arch v0` is required on current Solana clients
  (see `docs/findings.md` #7); the kit passes it automatically

Not yet exercised: a real on-chain **upgrade**, because a redeploy needs ~2x
rent for the buffer account (`docs/findings.md` #10). `ExtendProgram` itself is
confirmed working on X1 mainnet (174,112 → 184,352 bytes for 0.0713 XNT), and
the extend/retry orchestration is covered by `scripts/test-deploy-recovery.mjs`.

## Layout

```
packages/kit/        @x1/kit and the x1 CLI
packages/create-x1-dapp/   the scaffolder
docker/              (phase 3)
docs/findings.md     measured network behaviour, with repro scripts
docs/onboarding.md   zero to first deploy, with expected output at each step
scripts/             setup, provisioning, verification
  setup.ps1          Windows: WSL2 + distro, then delegates
  wsl-provision.sh   Linux toolchain (rust, solana, anchor, node)
  deploy-smoke-test.sh  init -> build -> rent check -> deploy
  verify.mjs         offline unit checks + live testnet checks
  probe.mjs          raw rate-limit / concurrency probing
```

`node scripts/verify.mjs` runs the offline unit checks plus live checks against
the X1 testnet.

## License

MIT — see [LICENSE](LICENSE).
