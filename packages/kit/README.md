# @x1/kit

Rate-limit-aware connection, deploy and diagnostics helpers for the
[X1](https://x1.xyz) SVM blockchain.

```sh
npm install @x1/kit
```

## Connection

Drop-in replacement for `@solana/web3.js` `Connection`. Everything you already
know still works.

```ts
import { createX1Connection } from "@x1/kit";

const connection = createX1Connection({
  cluster: "testnet",            // "mainnet" | "testnet" | "localnet" | "<rpc url>"
  commitment: "confirmed",
});

await connection.getSlot();
await connection.getBalance(pubkey);
```

Under the hood it:

- resolves the cluster and its per-cluster rate limits,
- wraps `fetch` with admission control, backoff and `Retry-After` handling,
- learns the real caps from the response headers,
- turns off `@solana/web3.js`'s own 429 retries so there is one policy.

```ts
connection.x1.cluster;   // resolved ClusterInfo
connection.x1.stats();   // { inFlight, queued, short, heavy, limits }
```

### Escape hatches

```ts
// Private RPC with no limits: skip admission control entirely.
createX1Connection({ cluster: "https://my-dedicated-rpc.example", limits: false });

// Tighter than the endpoint allows, e.g. to leave room for other services.
createX1Connection({ limits: { maxConcurrent: 5 } });
```

## Deploying

The first deploy allocates exactly the size of the binary. Ship one more
instruction and the next deploy fails with `account data too small`. X1's docs
tell you to run `solana program extend` by hand. This does it for you.

```ts
import { deployProgram } from "@x1/kit";

const result = await deployProgram({
  connection,
  rpcUrl: connection.rpcEndpoint,
  walletPath: "~/.config/solana/id.json",
  programName: "my_program",
  extendBy: 15_000,        // growth per repair attempt
  maxExtendAttempts: 3,
  onLog: console.log,
});

console.log(result.programId, result.extendAttempts);
```

It sizes the extend from the real `ProgramData` allocation when the RPC reports
one, so the repair is based on the actual shortfall rather than a guess.

It also finds `target/deploy/<program>.so` and `<program>-keypair.json` on its
own, so `programName` is usually the only thing you pass.

**Build flags are handled for you.** On `solana-cli` 4.x a bare `anchor build`
fails with `Platform tools v1.52 is incompatible with SBPFv3`. The kit builds
with `anchor build --no-idl -- --arch v0` and regenerates the IDL separately.
On older clients it uses a plain `anchor build`.

### Prefer headroom over repair

```ts
await deployProgram({ ..., headroom: 15_000 });
```

passes `--max-len`, so the program is created with room to grow and a later
redeploy never fails with `account data too small` in the first place. It costs
the extra rent up front (~0.104 XNT per 15KB) rather than at repair time, and is
ignored on upgrades since the account already exists.

The repair path still exists for programs deployed without headroom, and is
covered by `scripts/test-deploy-recovery.mjs`.

## Doctor

```ts
import { runDoctor } from "@x1/kit";

const report = await runDoctor({ cluster: "testnet" });
for (const check of report.checks) {
  console.log(check.status, check.label, check.detail ?? "");
}
report.ok; // false if anything failed
```

## Batching

The docs recommend batching to stay inside the request window. This sends one
HTTP request for many calls.

```ts
import { batchRpc } from "@x1/kit";

const entries = await batchRpc(connection.rpcEndpoint, [
  { method: "getSlot" },
  { method: "getBlockHeight" },
  { method: "getVersion" },
]);

entries[0].result; // slot
```

## Faucet

X1 disables `requestAirdrop` on testnet and funds wallets through a browser
faucet. This reports that accurately instead of pretending, and hands you the
address to paste.

```ts
import { fundFromFaucet } from "@x1/kit";

const result = await fundFromFaucet(connection, pubkey, { amountXnt: 2 });
if (!result.ok) console.log(result.message); // URL + address + confirm command
```

Check whether the faucet itself is up before assuming the problem is yours:

```ts
import { checkFaucetStatus } from "@x1/kit";

const status = await checkFaucetStatus();
status.verdict; // "up" | "down"
status.health;  // { ok, status, detail }
```

## Config

`x1.config.ts` in your project root. `loadX1Config()` walks up to find it.

```ts
import { defineConfig } from "@x1/kit";

export default defineConfig({
  cluster: "testnet",
  wallet: "~/.config/solana/id.json",
  program: {
    name: "my_program",
    keypair: "target/deploy/my_program-keypair.json",
  },
  priorityFee: "auto",
});
```

`x1.config.json` also works, and is the safer choice on Node < 22.6 (which
cannot import `.ts` files without a loader).

## Cluster constants

```ts
import { CLUSTERS, explorerTxUrl } from "@x1/kit";

CLUSTERS.mainnet.rpcUrl;  // https://rpc.mainnet.x1.xyz
CLUSTERS.testnet.faucetUrl; // https://faucet.testnet.x1.xyz

explorerTxUrl(CLUSTERS.mainnet, signature);
```

## Local validator

`x1 localnet` starts `solana-test-validator` with X1's programs cloned from
mainnet, so you can iterate without touching the public cluster:

```sh
x1 localnet --reset
solana -u http://127.0.0.1:8899 airdrop 5
```

`LOCALNET_PROGRAMS` exports the address list if you want to build your own
invocation.
