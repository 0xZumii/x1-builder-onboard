# X1 developer findings

Things measured against the live network while building this kit. Every claim
here has a script in `scripts/` that reproduces it.

Reproduce with `node scripts/verify.mjs`, `node scripts/probe.mjs`,
`node scripts/debug-capacity.mjs`.

---

## 1. The published rate limits are not the real ones

`https://docs.x1.xyz/build-on-x1/rpc-rate-limits` publishes a single set of
numbers. The two public endpoints disagree with them, and with each other.

| | Docs | mainnet | testnet |
| --- | --- | --- | --- |
| Requests / 5s | 300 | 300 | **400** |
| Heavy methods / 5s | 40 | 40 | 40 |
| Hourly cap | 150,000 | 150,000 | **header absent** |
| Concurrent connections | 30 | 30 | **15** |

`x-ratelimit-limit-short`, `x-conn-limit` and friends are the source of truth.
The docs themselves say the values "are subject to change" and that the headers
"are always reflected" — but they are wrong at any given moment, per cluster.

Testnet also does not send `x-ratelimit-limit-long` at all, so a client that
assumes an hourly budget will mis-read its own headroom.

## 2. The connection cap binds long before the rate cap

The advertised connection limit is not the usable one. Sustained load, 60
requests per run, no other traffic:

| Concurrency | Result |
| --- | --- |
| 3 | 60/60 · 3114ms |
| 5 | 60/60 · 1962ms |
| 8 | 60/60 · 1465ms |
| 10 | 60/60 · 1377ms |
| **12** | **60/60 · 1158ms** |
| 15 (advertised) | **29/60 · 1138ms** |

At exactly the advertised 15, half the requests get `429`. At 30, exactly half
do. The 429 body is an HTML page from the load balancer, not a JSON-RPC error:

```html
<h1>429 Too Many Requests</h1>
You have sent too many requests in a given amount of time.
```

The likely cause: the limit counts TCP connections, and TLS setup plus socket
churn means N concurrent requests can briefly be N+ sockets. 20% headroom is
the difference between a fast client and a throttled one.

**Practical guidance:** target ~80% of the advertised connection cap. 12 for
testnet, 24 for mainnet.

## 3. `@solana/web3.js` retries 429s on its own

By default `Connection` retries rate-limited requests internally, logging
`Server responded with 429 Too Many Requests. Retrying after Xms delay...`. This
fights any client-side throttling, multiplies request volume, and hides the
failure from the caller.

Set `disableRetryOnRateLimit: true` and own the retry policy yourself.

## 4. `requestAirdrop` is disabled; the faucet is browser-only

```json
{"jsonrpc":"2.0","id":1,"method":"requestAirdrop","params":["<addr>",1000000000]}
```

returns `airdrop to <addr> failed: Invalid request`.

The web faucet posts to `https://api.xen.network/v1/x1/faucet` with a body of
`{address, recaptchaResponse}`, so it cannot be automated without solving a
CAPTCHA. Treat funding as a manual browser step; do not attempt to bypass it.

Also note `https://api.xen.network/v1/health/faucet` returned `404` at the time
of writing, even though the faucet frontend still calls it.

## 5. Rent-exempt deposit is the real cost of a first deploy

Deploying an Anchor program is not just fees — the program account must be
rent-exempt. The formula is `(bytes + 128) * 6960` lamports.

Measured, not estimated: a stock `anchor init` counter program builds to
**174,112 bytes**, which requires **1,212,710,400 lamports ≈ 1.2127 XNT**
locked up, before any priority fee.

Budget for that before your first deploy, and check `solana balance` rather
than assuming a small faucet drip is enough. A 250KB program needs ~1.74 XNT.

## 7. Building on a current Solana client needs `--arch v0`

`solana-cli 4.3.2` (the stable channel) fails on a completely fresh Anchor
project:

```
ERROR cargo_build_sbf::toolchain] Platform tools v1.52 is incompatible with SBPFv3.
Refer to https://github.com/anza-xyz/cargo-build-sbf#sbfpv3-migration
Run `cargo-build-sbf --arch v0` if you wish to use this platform tools version.
```

The CLI defaults to the SBPFv3 target and then rejects it with its own bundled
platform-tools. Nothing is wrong with your project. Do what the message says:

```sh
anchor build --no-idl -- --arch v0
```

`--no-idl` is essential. Without it, anchor forwards the extra cargo args into
its IDL step too, where `cargo test` rejects `--arch` — and the build exits
non-zero *after* successfully producing the `.so`. `x1 deploy` handles both
details automatically.

### Do not "fix" this by pinning the old client

X1's docs pin `solana-cli 2.0.26`, which:
- **was never published** — it 404s at `release.anza.xyz` (`v2.0.24` exists),
- and `v2.0.24` **cannot build a modern project anyway**. Its bundled cargo is
  1.75, and 2026's crates.io serves manifests using `edition2024`:

```
error: failed to parse manifest at .../constant_time_eq-0.4.2/Cargo.toml
Caused by:
  feature `edition2024` is required ... not stabilized in this version of Cargo (1.75.0)
```

So the working combination is **current stable client + `--arch v0`**, not the
toolchain in the docs.

Anchor `0.30.1` (also in the docs) has no prebuilt Linux binary; `0.31.1` does
and works fine.

## 8. A v4 Cargo.lock only breaks *old* clients

If you do pin an old client, `anchor init`'s `cargo metadata` writes a v4
`Cargo.lock` that the SBF toolchain's older cargo cannot read:

```
error: failed to parse lock file at: .../Cargo.lock
Caused by:
  lock file version 4 requires `-Znext-lockfile-bump`
```

Deleting `Cargo.lock` lets the SBF toolchain write a v3 one. Current clients do
not need this.

## 10. Redeploys need ~2x rent (buffer account)

A *first* deploy writes straight into the program account and costs one lot of
rent. A **redeploy** does not: `solana program deploy` writes the new binary to
a temporary **buffer account** first, then upgrades from it. The buffer needs
its own rent-exempt deposit for the full binary size.

So with 0.18 XNT left after a deploy, upgrading a 174KB program fails:

```
Error: Account <wallet> has insufficient funds for spend (1.19314584 SOL) + fee (0.0040779 SOL)
```

You need roughly **2x the program's rent available** to upgrade it, even though
the buffer is refunded on success. Budget ~2.4 XNT of headroom to iterate on a
174KB program, not 1.2.

The failed attempt also prints a recovery seed and a
`solana program close <buffer>` hint. Check whether the buffer exists before
worrying: in our run the transaction failed before funding it, so nothing was
lost.

`x1 deploy` now pre-flights this and refuses with the exact numbers:

```
upgrade · 171256 bytes · rent 1.1928 XNT + buffer 1.1928 XNT (refunded)
Error: Not enough XNT to upgrade.
  wallet:   2F2gu… (0.1817 XNT)
  required: 2.3857 XNT = 1.1928 XNT rent + 1.1928 XNT buffer (refunded on success)
```

The extend/retry recovery itself is covered by
`scripts/test-deploy-recovery.mjs`, which drives a fake `solana` binary through
the failure rather than spending real rent.

## Verified end to end

Against X1 mainnet, October 2026:

| Step | Result |
| --- | --- |
| `anchor init` + `anchor build --no-idl -- --arch v0` | 2m28s → 174,112-byte `.so` |
| `x1 deploy --cluster mainnet` | program `89bFvUeVuk9sCGZJeDAtZFh6pYYS24UbZKRpY7863PiS` |
| Rent charged | 1.2127 XNT (1.4 → 0.1817, incl. fees) |
| On-chain verification | executable, authority set, 174,157-byte allocation |
| Redeploy | refused by pre-flight: needs buffer rent, see #10 |
| Extend/retry recovery | verified against a fake `solana` binary, no chain spend |

## 11. WSL2 gotchas (Windows)

Two things cost real time and are easy to avoid:

1. **Ubuntu's `.bashrc` returns early for non-interactive shells.** Anything
   appended there is invisible to `bash -lc`, to npm scripts, and to CI. Put
   PATH exports in `~/.profile` as well.
2. **Paths with spaces break through PowerShell into `wsl.exe`.** A quoted
   `bash -lc 'cd "/mnt/c/Some Path" && ...'` gets truncated at the space. Use
   `wsl --cd <dir>`, or call a script file.

Also: keep Anchor projects on the Linux filesystem (`~/project`), not
`/mnt/c/...`. Cargo and the SBF compiler are drastically slower over 9p.
