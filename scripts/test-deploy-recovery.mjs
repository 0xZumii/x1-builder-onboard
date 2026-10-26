/**
 * Tests the "account data too small" recovery path without touching the chain.
 *
 * Puts a fake `solana` binary on PATH that fails the first deploy with the
 * exact error X1/Solana produces, accepts `program extend`, then succeeds.
 * That exercises deployProgram's error detection, extend sizing, and retry.
 *
 * Run inside Linux (WSL): node scripts/test-deploy-recovery.mjs
 */
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Keypair } from "@solana/web3.js";
import { deployProgram } from "../packages/kit/dist/index.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
};

const dir = await mkdtemp(path.join(tmpdir(), "x1-fake-solana-"));
const logFile = path.join(dir, "calls.log");
const marker = path.join(dir, "extended");
const bin = path.join(dir, "solana");

const FAKE = `#!/usr/bin/env bash
echo "$@" >> "${logFile}"
if [ "$1" = "program" ] && [ "$2" = "deploy" ]; then
  if [ ! -f "${marker}" ]; then
    echo "Error: instruction 0: account data too small for instruction" >&2
    exit 1
  fi
  echo "Program Id: 89bFvUeVuk9sCGZJeDAtZFh6pYYS24UbZKRpY7863PiS"
  echo "Signature: FWeuJ86Y7eVjGyH6iwhacPhjfxKqKWBk1Wu1b2xeofjicpQeTYqVfUz3rf4TGKaUqfcPGWUPuePoNrP7ywXxzpg"
  exit 0
fi
if [ "$1" = "program" ] && [ "$2" = "extend" ]; then
  touch "${marker}"
  exit 0
fi
exit 0
`;

await writeFile(bin, FAKE);
await chmod(bin, 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;

// Real keypair + dummy program binary.
const keypair = Keypair.generate();
const keypairPath = path.join(dir, "program-keypair.json");
await writeFile(keypairPath, JSON.stringify(Array.from(keypair.secretKey)));

const soPath = path.join(dir, "program.so");
await writeFile(soPath, Buffer.alloc(64 * 1024));

const logs = [];
const result = await deployProgram({
  // Never called: the balance check is skipped and account lookups fail closed.
  connection: {
    getAccountInfo: async () => null,
    getBalance: async () => 0,
  },
  rpcUrl: "http://127.0.0.1:8899",
  walletPath: keypairPath,
  soPath,
  programKeypairPath: keypairPath,
  build: false,
  skipBalanceCheck: true,
  extendBy: 15_000,
  onLog: (line) => logs.push(line),
});

const calls = (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean);

check("deploy was retried after the extend", result.extendAttempts === 1, `${result.extendAttempts} extend(s)`);
check("extend used the configured size", result.extendedBytes === 15_000, `${result.extendedBytes} bytes`);
check("signature was parsed from the successful retry", Boolean(result.signature), result.signature?.slice(0, 12));
check("program id derived from the keypair", result.programId === keypair.publicKey.toBase58());
check("two deploy attempts were made", calls.filter((c) => c.startsWith("program deploy")).length === 2);
check("one extend call was made", calls.filter((c) => c.startsWith("program extend")).length === 1);
check(
  "log explains the repair",
  logs.some((l) => l.includes("too small")) && logs.some((l) => l.includes("Extending by")),
);

console.log(failures === 0 ? "\nRecovery path verified.\n" : `\n${failures} check(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
