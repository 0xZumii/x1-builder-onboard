#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Keypair, PublicKey } from "@solana/web3.js";

import { NATIVE_SYMBOL, resolveCluster, type ClusterInput } from "./constants.js";
import { createX1Connection, formatXnt, getX1Status } from "./connection.js";
import { expandHome, loadX1Config } from "./config.js";
import { deployProgram } from "./deploy.js";
import { runDoctor, type Check } from "./doctor.js";
import { fundFromFaucet } from "./faucet.js";

const isTty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (isTty ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const cyan = paint("36");

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const withoutDashes = token.slice(2);
    const equalsAt = withoutDashes.indexOf("=");
    if (equalsAt !== -1) {
      flags[withoutDashes.slice(0, equalsAt)] = withoutDashes.slice(equalsAt + 1);
      continue;
    }

    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[withoutDashes] = next;
      index += 1;
    } else {
      flags[withoutDashes] = true;
    }
  }

  return { command, flags, positional };
}

function clusterFromFlags(flags: Record<string, string | boolean>): ClusterInput {
  const cluster = flags.cluster;
  if (typeof cluster === "string") return cluster;
  return undefined as unknown as ClusterInput;
}

async function walletFromFlags(flags: Record<string, string | boolean>): Promise<string | undefined> {
  if (typeof flags.keypair === "string") return path.resolve(expandHome(flags.keypair));
  if (typeof flags.wallet === "string") return path.resolve(expandHome(flags.wallet));

  try {
    const config = await loadX1Config();
    return config.walletPath;
  } catch {
    return undefined;
  }
}

async function addressFromWallet(walletPath?: string): Promise<string | undefined> {
  if (!walletPath) return undefined;
  try {
    const secret = JSON.parse(await readFile(walletPath, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey.toBase58();
  } catch {
    return undefined;
  }
}

function symbolFor(status: Check["status"]): string {
  switch (status) {
    case "pass":
      return green("✓");
    case "warn":
      return yellow("!");
    case "fail":
      return red("✗");
    case "skip":
      return dim("-");
  }
}

function printHelp(): void {
  const help = `
${bold("x1")} — developer CLI for the X1 SVM blockchain

${bold("USAGE")}
  x1 <command> [options]

${bold("COMMANDS")}
  doctor              Verify your toolchain, RPC and wallet before deploying
  status              Print chain info, latency and your rate-limit budget
  deploy              Build, deploy, and auto-extend the program account
  faucet              Request testnet ${NATIVE_SYMBOL}
  balance             Show the balance of a wallet
  help                Show this message

${bold("OPTIONS")}
  --cluster <name>    mainnet | testnet | localnet | <rpc url>   (default: testnet)
  --keypair <path>    Wallet keypair (default: ~/.config/solana/id.json)
  --offline           doctor/status: skip network calls

${bold("DEPLOY")}
  --build / --no-build   Run anchor build first (default: on when Anchor.toml exists)
  --program-id <id>      Program id (otherwise derived from the keypair)
  --program-keypair <p>  Path to the program keypair
  --so <path>            Path to the built .so
  --name <name>          Program name, used to find target/deploy/<name>.so
  --extend-by <bytes>    Growth per repair attempt (default: 15000)
  --priority-fee <n>     Compute unit price in microlamports
  --dry-run              Print the deploy command without sending it

${bold("EXAMPLES")}
  ${dim("$")} x1 doctor
  ${dim("$")} x1 deploy --name my_program
  ${dim("$")} x1 faucet --amount 2
  ${dim("$")} x1 status --cluster mainnet
`;
  console.log(help);
}

async function commandDoctor(flags: Record<string, string | boolean>): Promise<number> {
  const walletPath = await walletFromFlags(flags);
  const report = await runDoctor({
    cluster: clusterFromFlags(flags),
    walletPath,
    offline: flags.offline === true,
  });

  console.log(`\n${bold("X1 doctor")} ${dim(`(${report.checks.length} checks)`)}\n`);

  for (const check of report.checks) {
    console.log(`  ${symbolFor(check.status)} ${check.label.padEnd(22)} ${dim(check.detail ?? "")}`);
    if (check.hint) console.log(`    ${dim("→")} ${check.hint}`);
  }

  const { pass, warn, fail, skip } = report.summary;
  console.log(
    `\n  ${green(`${pass} passed`)}` +
      (warn ? `, ${yellow(`${warn} warning${warn === 1 ? "" : "s"}`)}` : "") +
      (fail ? `, ${red(`${fail} failed`)}` : "") +
      (skip ? `, ${dim(`${skip} skipped`)}` : "") +
      "\n",
  );

  if (fail > 0) {
    console.log(`  ${yellow("Fix the failures above, then run")} ${bold("x1 doctor")} ${yellow("again.")}\n`);
  } else {
    console.log(`  ${green("Ready to build.")}\n`);
  }

  return fail > 0 ? 1 : 0;
}

async function commandStatus(flags: Record<string, string | boolean>): Promise<number> {
  const connection = createX1Connection({ cluster: clusterFromFlags(flags) });
  const status = await getX1Status(connection);
  const stats = connection.x1.stats();

  console.log(`\n${bold("X1 status")}\n`);
  console.log(`  cluster     ${status.cluster}`);
  console.log(`  rpc         ${status.rpcUrl}`);
  console.log(`  health      ${status.health ?? dim("unknown")}`);
  console.log(`  version     ${status.version ?? dim("unknown")}`);
  console.log(`  slot        ${status.slot?.toLocaleString() ?? dim("unknown")}`);
  console.log(`  block       ${status.blockHeight?.toLocaleString() ?? dim("unknown")}`);
  console.log(`  latency     ${status.latencyMs}ms`);

  if (stats.limits) {
    const { limits } = stats;
    console.log(
      `\n  ${dim("client budget")}  ${stats.short}/${limits.shortCap} per ${limits.shortWindowMs / 1000}s · ` +
        `${stats.heavy}/${limits.heavyCap} heavy · ${stats.inFlight}/${limits.maxConcurrent} concurrent`,
    );
  }

  console.log(`\n  explorer    ${cyan(status.explorerUrl)}\n`);
  return 0;
}

async function commandDeploy(flags: Record<string, string | boolean>): Promise<number> {
  const walletPath = await walletFromFlags(flags);
  if (!walletPath) {
    console.error(red("No wallet found. Pass --keypair or create one with solana-keygen new."));
    return 1;
  }

  const cluster = resolveCluster(clusterFromFlags(flags));
  const connection = createX1Connection({ cluster });

  console.log(`\n${bold("Deploying to X1")} ${dim(cluster.name)} ${dim(cluster.rpcUrl)}\n`);

  const result = await deployProgram({
    connection,
    rpcUrl: cluster.rpcUrl,
    walletPath,
    programId: typeof flags["program-id"] === "string" ? flags["program-id"] : undefined,
    programKeypairPath:
      typeof flags["program-keypair"] === "string"
        ? path.resolve(expandHome(flags["program-keypair"]))
        : undefined,
    soPath: typeof flags.so === "string" ? path.resolve(expandHome(flags.so)) : undefined,
    programName: typeof flags.name === "string" ? flags.name : undefined,
    build: flags["no-build"] === true ? false : flags.build === true ? true : undefined,
    extendBy: typeof flags["extend-by"] === "string" ? Number(flags["extend-by"]) : undefined,
    priorityFee:
      typeof flags["priority-fee"] === "string" ? Number(flags["priority-fee"]) : undefined,
    dryRun: flags["dry-run"] === true,
    onLog: (line) => console.log(dim(`  ${line}`)),
  });

  console.log(`\n  ${green("✓")} program   ${result.programId}`);
  if (result.signature) console.log(`  ${green("✓")} signature ${result.signature}`);
  if (result.extendAttempts > 0) {
    console.log(`  ${yellow("!")} extended  +${result.extendedBytes} bytes over ${result.extendAttempts} attempt(s)`);
  }
  console.log(`\n  ${dim(cluster.explorerUrl.replace(/\/$/, ""))}/address/${result.programId}\n`);
  return 0;}

async function commandFaucet(flags: Record<string, string | boolean>): Promise<number> {
  const walletPath = await walletFromFlags(flags);
  const address =
    typeof flags.address === "string" ? flags.address : await addressFromWallet(walletPath);

  if (!address) {
    console.error(red("No address. Pass --address or --keypair."));
    return 1;
  }

  const cluster = resolveCluster(clusterFromFlags(flags));
  if (cluster.name === "mainnet") {
    console.log(yellow("There is no faucet on X1 mainnet."));
    return 1;
  }

  const connection = createX1Connection({ cluster });
  const amount = typeof flags.amount === "string" ? Number(flags.amount) : 2;
  const result = await fundFromFaucet(connection, address, {
    amountXnt: Number.isFinite(amount) ? amount : 2,
    faucetUrl: cluster.faucetUrl,
  });

  console.log(result.ok ? green(`✓ ${result.message}`) : yellow(result.message));
  return result.ok ? 0 : 1;
}

async function commandBalance(flags: Record<string, string | boolean>): Promise<number> {
  const walletPath = await walletFromFlags(flags);
  const address =
    typeof flags.address === "string" ? flags.address : await addressFromWallet(walletPath);

  if (!address) {
    console.error(red("No address. Pass --address or --keypair."));
    return 1;
  }

  const cluster = resolveCluster(clusterFromFlags(flags));
  const connection = createX1Connection({ cluster });
  const lamports = await connection.getBalance(new PublicKey(address));

  console.log(`${address}\n  ${bold(formatXnt(lamports))} ${dim(`(${lamports} lamports)`)} ${dim(cluster.name)}`);
  return 0;
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  try {
    switch (command) {
      case "doctor":
        return await commandDoctor(flags);
      case "status":
        return await commandStatus(flags);
      case "deploy":
        return await commandDeploy(flags);
      case "faucet":
        return await commandFaucet(flags);
      case "balance":
        return await commandBalance(flags);
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return 0;
      default:
        console.error(red(`Unknown command: ${command}`));
        printHelp();
        return 1;
    }
  } catch (error) {
    console.error(`\n${red("Error:")} ${(error as Error).message}\n`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
