import { Keypair } from "@solana/web3.js";
import { createX1Connection, fundFromFaucet, formatXnt } from "../packages/kit/dist/index.js";

const keypair = Keypair.generate();
const connection = createX1Connection({ cluster: "testnet" });

console.log("address:", keypair.publicKey.toBase58());
console.log("balance before:", formatXnt(await connection.getBalance(keypair.publicKey)));

const result = await fundFromFaucet(connection, keypair.publicKey, { amountXnt: 2 });
console.log("\nairdrop ok:", result.ok);
console.log("signature:", result.signature ?? "-");
console.log("message:", result.message);

if (result.ok) {
  console.log("balance after:", formatXnt(await connection.getBalance(keypair.publicKey)));
}
