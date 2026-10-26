# create-x1-dapp

Scaffold an X1 program with a deploy path that has been verified end to end.

```sh
npx create-x1-dapp my-app
cd my-app && npm install
npm run doctor
npm run build
npm run deploy
```

## What you get

```
my-app/
  Anchor.toml                 program id already wired up
  Cargo.toml                  workspace + release profile
  package.json                build / deploy / doctor scripts
  x1.config.ts                cluster, wallet, program settings
  programs/my_app/src/lib.rs  a counter, ready to change
  scripts/deploy.mjs          deploy entry point
  target/deploy/…-keypair.json  the program keypair (upgrade authority)
```

The program id is generated at scaffold time and written into both
`declare_id!` and the keypair file, so the project is deployable without any
manual wiring.

## What it pre-solves

Each of these is a real failure documented in
[`docs/findings.md`](../../docs/findings.md), and none of them is discoverable
from the official docs:

| Problem | Handled by |
| --- | --- |
| `Platform tools v1.52 is incompatible with SBPFv3` | `npm run build` uses `--arch v0` |
| Anchor exits non-zero after a successful build | `--no-idl` on the build, separate `npm run idl` |
| `account data too small` on redeploy | `headroom: 15_000` pre-allocates via `--max-len`, with extend-and-retry as backup |
| Cryptic rent failures | deploy estimates cost and refuses before sending |
| Redeploy needs 2x rent (buffer account) | pre-flight reports it in XNT, not lamports |

## Options

```
--cluster <name>    testnet (default) | mainnet | <rpc url>
--kit-path <path>   Use a local @x1/kit checkout (monorepo root or the package)
--force, -f         Write into a non-empty directory
```

`--kit-path` exists because `@x1/kit` is not published to npm yet. Point it at
this repository and the generated project links against the local build:

```sh
node packages/create-x1-dapp/dist/index.js demo --kit-path .
```

## Requirements

- Node 20+
- The Solana/Anchor toolchain (`solana`, `anchor`, Rust). On Windows that means
  WSL2 — see `scripts/setup.ps1` in the repository root.
- A funded wallet for the first deploy: roughly **1.2 XNT** of rent for a
  program this size, not just transaction fees.
