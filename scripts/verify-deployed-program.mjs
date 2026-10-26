import { PublicKey } from "@solana/web3.js";
import { createX1Connection, explorerAddressUrl, formatXnt, getProgramAllocation, resolveCluster } from "../packages/kit/dist/index.js";

const PROGRAM = process.argv[2] ?? "89bFvUeVuk9sCGZJeDAtZFh6pYYS24UbZKRpY7863PiS";
const cluster = resolveCluster(process.argv[3] ?? "mainnet");
const connection = createX1Connection({ cluster });

console.log(`cluster:  ${cluster.name} (${cluster.rpcUrl})`);
console.log(`program:  ${PROGRAM}`);

const info = await connection.getAccountInfo(new PublicKey(PROGRAM));
if (!info) {
  console.log("account:  NOT FOUND");
  process.exit(1);
}

console.log(`owned by: ${info.owner.toBase58()}`);
console.log(`executable: ${info.executable}`);
console.log(`account data: ${info.data.length} bytes`);
console.log(`lamports: ${formatXnt(info.lamports)}`);

const allocation = await getProgramAllocation(connection, PROGRAM);
console.log(`programdata allocation: ${allocation} bytes`);

// The upgrade authority is stored in the ProgramData account header.
const programDataAddress = new PublicKey(info.data.subarray(4, 36));
const programData = await connection.getAccountInfo(programDataAddress);
const hasAuthority = programData ? programData.data[12] === 1 : false;
console.log(`upgrade authority set: ${hasAuthority}`);

console.log(`explorer: ${explorerAddressUrl(cluster, PROGRAM)}`);
console.log(`\nall checks passed`);
