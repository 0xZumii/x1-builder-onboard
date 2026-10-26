import { PublicKey } from "@solana/web3.js";
import { createX1Connection, formatXnt } from "../packages/kit/dist/index.js";

const BUFFER = "FwHVQBm1juti6Wur53BRLKD18ZwuhS5wzH487MwWr4v2";
const connection = createX1Connection({ cluster: "mainnet" });

const info = await connection.getAccountInfo(new PublicKey(BUFFER));
if (!info) {
  console.log(`buffer ${BUFFER}: does not exist (nothing to reclaim)`);
} else {
  console.log(`buffer ${BUFFER}:`);
  console.log(`  balance: ${formatXnt(info.lamports)}`);
  console.log(`  owner:   ${info.owner.toBase58()}`);
  console.log(`  data:    ${info.data.length} bytes`);
}
