#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { Keypair, PublicKey } from "@solana/web3.js";

import { CLUSTERS, LOCALNET_PROGRAMS, NATIVE_SYMBOL, resolveCluster, type ClusterInput } from "./constants.js";
import { createX1Connection, formatXnt, getX1Status } from "./connection.js";
import { expandHome, loadX1Config } from "./config.js";
import {
  deployProgram,
  estimateDeployCost,
  findProgramKeypair,
  findProgramSo,
  programIdFromKeypair,
} from "./deploy.js";
import { runDoctor, type Check } from "./doctor.js";
import { checkFaucetStatus, fundFromFaucet } from "./faucet.js";

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
  localnet            Run a local validator with X1's programs cloned in
  faucet              Request testnet ${NATIVE_SYMBOL}
  funds               XNT balance, what a deploy needs, and how to top up
  balance             Show the balance of a wallet
  help                Show this message

${bold("OPTIONS")}
  --cluster <name>    mainnet | testnet | localnet | <rpc url>   (default: testnet)
  --keypair <path>    Wallet keypair (default: ~/.config/solana/id.json)
  --status            faucet: check whether the faucet is up, without funding
  --offline           doctor/status: skip network calls

${bold("DEPLOY")}
  --build / --no-build   Run anchor build first (default: on when Anchor.toml exists)
  --program-id <id>      Program id (otherwise derived from the keypair)
  --program-keypair <p>  Path to the program keypair
  --so <path>            Path to the built .so
  --name <name>          Program name, used to find target/deploy/<name>.so
  --extend-by <bytes>    Growth per repair attempt (default: 15000)
  --headroom <bytes>     Pre-allocate this much extra on first deploy (--max-len)
  --priority-fee <n>     Compute unit price in microlamports
  --dry-run              Print the deploy command without sending it

${bold("EXAMPLES")}
  ${dim("$")} x1 doctor
  ${dim("$")} x1 localnet --reset
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
    headroom: typeof flags.headroom === "string" ? Number(flags.headroom) : undefined,
    priorityFee:
      typeof flags["priority-fee"] === "string" ? Number(flags["priority-fee"]) : undefined,
    dryRun: flags["dry-run"] === true,
    onLog: (line) => console.log(dim(`  ${line}`)),
  });

  if (flags["dry-run"] === true) {
    console.log(`\n  ${cyan("dry run")} — nothing was sent\n`);
    return 0;
  }

  console.log(`\n  ${green("✓")} program   ${result.programId}`);
  if (result.signature) console.log(`  ${green("✓")} signature ${result.signature}`);
  if (result.extendAttempts > 0) {
    console.log(`  ${yellow("!")} extended  +${result.extendedBytes} bytes over ${result.extendAttempts} attempt(s)`);
  }
  console.log(`\n  ${dim(cluster.explorerUrl.replace(/\/$/, ""))}/address/${result.programId}\n`);
  return 0;}

async function commandFaucet(flags: Record<string, string | boolean>): Promise<number> {
  if (flags.status === true) {
    const status = await checkFaucetStatus();
    const pretty = (detail: string): string => {
      try {
        const parsed = JSON.parse(detail) as { message?: string };
        if (parsed.message) return parsed.message;
      } catch {
        // not JSON, fall through
      }
      return detail.slice(0, 60);
    };

    const show = (result: { ok: boolean; status: number | null; detail: string }) => {
      if (result.status === null) return `unreachable (${result.detail})`;
      if (result.ok) return `${result.status}`;
      const body = result.detail ? ` · ${pretty(result.detail)}` : "";
      return `${result.status}${body}`;
    };

    const healthUrl = "https://api.xen.network/v1/health/faucet";
    console.log(`\n${bold("X1 testnet faucet")}\n`);
    console.log(`  verdict   ${status.verdict === "up" ? green("UP") : red("DOWN")}`);
    console.log(`  page      ${status.faucetUrl.padEnd(44)} ${show(status.page)}`);
    console.log(`  health    ${healthUrl.padEnd(44)} ${show(status.health)}`);

    if (status.verdict === "down") {
      console.log(
        `\n  ${yellow("The faucet backend is not serving the route its own frontend requires,")}\n` +
          `  ${yellow("so the page cannot submit. This is not your wallet or your setup.")}\n`,
      );
      console.log(`  Work locally instead:\n`);
      console.log(`    ${bold("x1 localnet --reset")}                    ${dim("# terminal 1")}`);
      console.log(`    ${bold("solana -u http://127.0.0.1:8899 airdrop 5")}  ${dim("# terminal 2")}\n`);
      console.log(`  ${dim("Local clones SPL Token, Token Metadata, Core, Squads v4 and more from mainnet.")}\n`);
      return 1;
    }

    console.log(`\n  Faucet looks healthy. Paste your address at ${cyan(status.faucetUrl)}\n`);
    return 0;
  }

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

async function commandFunds(flags: Record<string, string | boolean>): Promise<number> {
  const cluster = resolveCluster(clusterFromFlags(flags));
  const walletPath = await walletFromFlags(flags);
  const address =
    typeof flags.address === "string" ? flags.address : await addressFromWallet(walletPath);

  if (!address) {
    console.error(red("No address. Pass --address or --keypair."));
    return 1;
  }

  const connection = createX1Connection({ cluster });
  const lamports = await connection.getBalance(new PublicKey(address));

  console.log(`\n${bold("X1 funds")} ${dim(cluster.name)}\n`);
  console.log(`  wallet   ${address}`);
  console.log(`  XNT      ${bold(formatXnt(lamports))}`);

  // If run inside a project with a built program, price the deploy it would do.
  let required: number | null = null;
  let label = "";

  try {
    const config = await loadX1Config();
    const soPath = await findProgramSo(config.targetDir, config.program.name);

    if (soPath) {
      const bytes = (await stat(soPath)).size;
      const name = config.program.name ?? path.basename(soPath, ".so");
      const keypairPath =
        config.program.keypairPath ?? (await findProgramKeypair(config.targetDir, name)) ?? undefined;

      const programId =
        config.program.programId ??
        (keypairPath ? await programIdFromKeypair(keypairPath) : undefined);

      if (programId) {
        const estimate = await estimateDeployCost(connection, programId, bytes);
        required = estimate.requiredLamports;
        label = `${estimate.isUpgrade ? "upgrade" : "deploy"} · ${bytes} bytes`;
      }
    }
  } catch {
    // Not in a project, or the RPC is unreachable. The generic advice still helps.
  }

  if (required !== null) {
    console.log(`  ${label}`);
    console.log(`  needs    ${formatXnt(required)}`);
    const shortfall = required - lamports;
    console.log(
      shortfall > 0
        ? `  ${yellow("short")}    ${formatXnt(shortfall)}`
        : `  ${green("ok")}       enough for this deploy`,
    );
  } else {
    console.log(`  ${dim("a ~180KB program needs ~1.2 XNT of rent to deploy")}`);
  }

  console.log(`\n  ${dim("Top up XNT:")}`);
  console.log(`    bridge   ${cyan("https://app.bridge.x1.xyz/")}   ${dim("USDC on Solana → USDC.X")}`);
  console.log(`    swap     ${cyan("https://app.xdex.xyz/swap")}    ${dim("USDC.X → XNT")}`);
  console.log(`    wallet   ${cyan("https://wallet.x1.xyz")}        ${dim("bridge and swap in one app")}`);
  console.log(`\n  ${dim("SOL cannot be bridged directly — convert it to USDC first.")}\n`);

  return 0;
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

async function commandLocalnet(flags: Record<string, string | boolean>): Promise<number> {
  const port = typeof flags.port === "string" ? flags.port : "8899";
  const source = typeof flags.url === "string" ? flags.url : CLUSTERS.mainnet.rpcUrl;
  const ledger = typeof flags.ledger === "string" ? flags.ledger : path.join(os.homedir(), ".x1-localnet");

  const args = ["--url", source, "--ledger", ledger, "--rpc-port", port, "--quiet"];
  if (flags.reset === true) args.push("--reset");

  const clone = flags["no-clone"] !== true;
  if (clone) {
    // Copy the source cluster's feature set as well as its programs. Without
    // this the local genesis may not enable the SBPF version a program was
    // built for, and deploying fails with:
    //   "Detected sbpf_version required by the executable which are not enabled"
    args.push("--clone-feature-set");
    for (const program of LOCALNET_PROGRAMS.upgradeable) {
      args.push("--clone-upgradeable-program", program.address);
    }
    for (const program of LOCALNET_PROGRAMS.plain) {
      args.push("--clone", program.address);
    }
  }

  console.log(`\n${bold("X1 localnet")}\n`);
  console.log(`  rpc      ${cyan(`http://127.0.0.1:${port}`)}`);
  console.log(`  ledger   ${ledger}`);
  console.log(`  clones   ${clone ? `${LOCALNET_PROGRAMS.upgradeable.length + LOCALNET_PROGRAMS.plain.length} programs from ${source}` : "disabled"}`);
  console.log(`\n  ${dim("Ctrl-C to stop")}\n`);

  const child = spawn("solana-test-validator", args, { stdio: "inherit" });

  child.on("error", (error) => {
    console.error(red(`Could not start solana-test-validator: ${error.message}`));
    console.error(dim("Install the Solana CLI, or run with --no-clone."));
    process.exit(1);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }

  return await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
  });
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
      case "funds":
        return await commandFunds(flags);
      case "balance":
        return await commandBalance(flags);
      case "localnet":
        return await commandLocalnet(flags);
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
