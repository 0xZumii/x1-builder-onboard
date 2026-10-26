/**
 * Phase 3 spike: which X1 programs could be cloned into a local validator?
 *
 * A local X1 environment only works if the standard programs developers rely on
 * actually exist on the cluster and can be cloned. This checks the usual set.
 */
import { PublicKey } from "@solana/web3.js";
import { createX1Connection } from "../packages/kit/dist/index.js";

const PROGRAMS = [
  { name: "SPL Token", address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", upgradeable: false },
  { name: "Token-2022", address: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", upgradeable: false },
  { name: "Associated Token", address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", upgradeable: false },
  { name: "Token Metadata", address: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", upgradeable: true },
  { name: "Metaplex Core", address: "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", upgradeable: true },
  { name: "Squads v4", address: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", upgradeable: true },
  { name: "Memo", address: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", upgradeable: false },
  { name: "Compute Budget", address: "ComputeBudget111111111111111111111111111111", upgradeable: false },
];

const connection = createX1Connection({ cluster: "mainnet" });
console.log(`cluster: ${connection.rpcEndpoint}\n`);

const results = await Promise.all(
  PROGRAMS.map(async (program) => {
    try {
      const info = await connection.getAccountInfo(new PublicKey(program.address));
      if (!info) return { ...program, exists: false, owner: null, bytes: 0, executable: false };
      return {
        ...program,
        exists: true,
        owner: info.owner.toBase58(),
        bytes: info.data.length,
        executable: info.executable,
      };
    } catch (error) {
      return { ...program, exists: false, owner: `error: ${error.message}`, bytes: 0, executable: false };
    }
  }),
);

let supported = 0;
for (const r of results) {
  const mark = r.exists && r.executable ? "YES" : "no ";
  if (mark === "YES") supported += 1;
  const kind = r.owner === "BPFLoaderUpgradeab1e11111111111111111111111" ? "upgradeable" : "native/bpf";
  console.log(`${mark}  ${r.name.padEnd(16)} ${r.address}  ${r.exists ? `${kind}, ${r.bytes} bytes` : "MISSING"}`);
}

console.log(`\n${supported}/${PROGRAMS.length} present and executable`);
console.log(
  supported === PROGRAMS.length
    ? "A local validator with cloned programs is plausible → build the stack."
    : "Missing programs would need local builds instead of clones.",
);
