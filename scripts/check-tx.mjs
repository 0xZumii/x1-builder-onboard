import { createX1Connection } from "../packages/kit/dist/index.js";

const SIG = "3ZtZ7J6fzmf94KH9A57wmnD6xoK1G3R8o2me9BwdktWkiMDwpzN4DQEHvfPz9PnojMhPQMjtkz9AEevZE3FZHoB9";
const DEV = "2F2guVPYyZeqpq7uXqrMD8SiJF7VFhFts2MAJhRC9rah";
const OTHER = "2PKcvvPX8WZUBKgPswjKK8qpJ3seNGeZVdT7ra6rWvBF";

const mainnet = createX1Connection({ cluster: "mainnet" });
const testnet = createX1Connection({ cluster: "testnet" });

console.log("=== mainnet transaction ===");
const tx = await mainnet.getTransaction(SIG, { maxSupportedTransactionVersion: 0 });
if (!tx) {
  console.log("not found on mainnet");
} else {
  const keys = tx.transaction.message.staticAccountKeys.map((k) => k.toBase58());
  console.log("slot:", tx.slot);
  console.log("error:", tx.meta?.err ?? "none");
  console.log("accounts:");
  keys.forEach((k, i) => {
    const pre = tx.meta?.preBalances[i] ?? 0;
    const post = tx.meta?.postBalances[i] ?? 0;
    const delta = post - pre;
    console.log(`  ${i}: ${k}  delta=${delta / 1e9} XNT`);
  });
  console.log("fee:", (tx.meta?.fee ?? 0) / 1e9, "XNT");
  console.log("memo/logs:", (tx.meta?.logMessages ?? []).slice(0, 5).join(" | ").slice(0, 400));
}

console.log("\n=== balances ===");
for (const [label, address] of [["dev wallet", DEV], ["other address", OTHER]]) {
  const [m, t] = await Promise.all([
    mainnet.getBalance(new (await import("@solana/web3.js")).PublicKey(address)),
    testnet.getBalance(new (await import("@solana/web3.js")).PublicKey(address)),
  ]);
  console.log(`${label.padEnd(14)} ${address}`);
  console.log(`  mainnet: ${m / 1e9} XNT`);
  console.log(`  testnet: ${t / 1e9} XNT`);
}
