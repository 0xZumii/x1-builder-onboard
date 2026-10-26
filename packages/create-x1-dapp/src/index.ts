#!/usr/bin/env node
/**
 * create-x1-dapp
 *
 * Generates an Anchor program plus the glue that X1 actually needs:
 * a config file, a working deploy script, and build commands that survive
 * solana-cli 4.x. Every footgun documented in docs/findings.md is pre-handled.
 */
import { existsSync } from "node:fs";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Keypair } from "@solana/web3.js";

const isTty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (isTty ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const cyan = paint("36");

const CLUSTERS: Record<string, string> = {
  testnet: "https://rpc.testnet.x1.xyz",
  mainnet: "https://rpc.mainnet.x1.xyz",
};

interface Options {
  target: string;
  cluster: string;
  kitPath?: string;
  force: boolean;
}

function fail(message: string): never {
  console.error(`\n${red("error:")} ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  let cluster = "testnet";
  let kitPath: string | undefined;
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "--cluster") {
      cluster = argv[++i] ?? cluster;
    } else if (arg.startsWith("--cluster=")) {
      cluster = arg.slice("--cluster=".length);
    } else if (arg === "--kit-path") {
      kitPath = argv[++i];
      if (!kitPath) fail("--kit-path needs a value");
    } else if (arg.startsWith("--kit-path=")) {
      kitPath = arg.slice("--kit-path=".length);
    } else if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (!positional[0]) {
    usage();
    process.exit(1);
  }

  if (!CLUSTERS[cluster] && !/^https?:\/\//.test(cluster)) {
    fail(`unknown cluster "${cluster}". Use testnet, mainnet, or an RPC URL.`);
  }

  return { target: positional[0], cluster, kitPath, force };
}

function usage(): void {
  console.log(`
${bold("create-x1-dapp")} — scaffold an X1 program with a working deploy path

${bold("USAGE")}
  create-x1-dapp <dir> [options]

${bold("OPTIONS")}
  --cluster <name>    testnet (default) | mainnet | <rpc url>
  --kit-path <path>   Use a local @x1/kit checkout instead of the npm version
  --force, -f         Write into a non-empty directory
  -h, --help          Show this message

${bold("EXAMPLE")}
  ${dim("$")} npx create-x1-dapp my-app
  ${dim("$")} cd my-app && npm install
  ${dim("$")} npm run doctor
  ${dim("$")} npm run build
  ${dim("$")} npm run deploy
`);
}

/** Package name: lowercase, dashes. */
function packageName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/** Rust crate / module name: snake_case, cannot start with a digit. */
function programName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const named = cleaned.length > 0 ? cleaned : "program";
  return /^[0-9]/.test(named) ? `p_${named}` : named;
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    await access(dir);
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch {
    return true;
  }
}

/**
 * Accepts either the monorepo root or the @x1/kit package directory, so
 * `--kit-path ../x1-devkit` and `--kit-path ../x1-devkit/packages/kit` both work.
 */
function resolveKitPath(input: string): string {
  const abs = path.resolve(input);
  const nested = path.join(abs, "packages", "kit");
  if (existsSync(path.join(nested, "package.json"))) return nested;
  if (existsSync(path.join(abs, "package.json"))) return abs;
  fail(`--kit-path ${input} does not look like @x1/kit or a monorepo root`);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const anchorToml = (program: string, id: string, rpc: string): string =>
  [
    "[features]",
    "resolution = true",
    "skip-lint = false",
    "",
    "[programs.localnet]",
    `${program} = "${id}"`,
    "",
    "[provider]",
    `cluster = "${rpc}"`,
    'wallet = "~/.config/solana/id.json"',
    "",
  ].join("\n");

const workspaceCargo = (): string =>
  [
    "[workspace]",
    'members = ["programs/*"]',
    'resolver = "2"',
    "",
    "[profile.release]",
    "overflow-checks = true",
    'lto = "fat"',
    "codegen-units = 1",
    "",
    "[profile.release.build-override]",
    "opt-level = 3",
    "incremental = false",
    "codegen-units = 1",
    "",
  ].join("\n");

const programCargo = (program: string): string =>
  [
    "[package]",
    `name = "${program}"`,
    'version = "0.1.0"',
    'description = "Created with create-x1-dapp"',
    'edition = "2021"',
    "",
    "[lib]",
    'crate-type = ["cdylib", "lib"]',
    `name = "${program}"`,
    "",
    "[features]",
    "default = []",
    'cpi = ["no-entrypoint"]',
    "no-entrypoint = []",
    "no-idl = []",
    "no-log-ix-name = []",
    'idl-build = ["anchor-lang/idl-build"]',
    "",
    "[dependencies]",
    'anchor-lang = "0.31.1"',
    "",
  ].join("\n");

const programSource = (program: string, id: string): string =>
  [
    "use anchor_lang::prelude::*;",
    "",
    `declare_id!("${id}");`,
    "",
    "#[program]",
    `pub mod ${program} {`,
    "    use super::*;",
    "",
    "    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {",
    "        let counter = &mut ctx.accounts.counter;",
    "        counter.authority = ctx.accounts.authority.key();",
    "        counter.count = 0;",
    "        Ok(())",
    "    }",
    "",
    "    pub fn increment(ctx: Context<Increment>) -> Result<()> {",
    "        let counter = &mut ctx.accounts.counter;",
    "        counter.count = counter.count.checked_add(1).unwrap();",
    '        msg!("count: {}", counter.count);',
    "        Ok(())",
    "    }",
    "}",
    "",
    "#[account]",
    "pub struct Counter {",
    "    pub authority: Pubkey,",
    "    pub count: u64,",
    "}",
    "",
    "#[derive(Accounts)]",
    "pub struct Initialize<'info> {",
    "    #[account(init, payer = authority, space = 8 + 32 + 8)]",
    "    pub counter: Account<'info, Counter>,",
    "    #[account(mut)]",
    "    pub authority: Signer<'info>,",
    "    pub system_program: Program<'info, System>,",
    "}",
    "",
    "#[derive(Accounts)]",
    "pub struct Increment<'info> {",
    "    #[account(mut, has_one = authority)]",
    "    pub counter: Account<'info, Counter>,",
    "    pub authority: Signer<'info>,",
    "}",
    "",
  ].join("\n");

const packageJson = (pkg: string, kitDep: string): string =>
  JSON.stringify(
    {
      name: pkg,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        // --arch v0: solana-cli 4.x defaults to SBPFv3 and then rejects it with
        // its own platform-tools. --no-idl: anchor otherwise forwards --arch
        // into its IDL step, where cargo test rejects it.
        build: "anchor build --no-idl -- --arch v0",
        idl: "anchor idl build",
        deploy: "node scripts/deploy.mjs",
        doctor: "x1 doctor",
        status: "x1 status",
      },
      dependencies: { "@x1/kit": kitDep },
    },
    null,
    2,
  ) + "\n";

const x1Config = (program: string): string =>
  [
    'import { defineConfig } from "@x1/kit";',
    "",
    "export default defineConfig({",
    '  cluster: "testnet",',
    '  wallet: "~/.config/solana/id.json",',
    "  program: {",
    `    name: "${program}",`,
    `    keypair: "target/deploy/${program}-keypair.json",`,
    "  },",
    "});",
    "",
  ].join("\n");

const deployScript = (program: string): string =>
  [
    "// Deploys the program to X1. Handles build flags, rent estimation and the",
    "// `account data too small` repair automatically.",
    'import { createX1Connection, deployProgram, loadX1Config } from "@x1/kit";',
    "",
    "const config = await loadX1Config();",
    "const connection = createX1Connection({ cluster: config.cluster });",
    "",
    "const result = await deployProgram({",
    "  connection,",
    "  rpcUrl: config.cluster.rpcUrl,",
    "  walletPath: config.walletPath,",
    `  programName: "${program}",`,
    "  // Born with 15KB of room to grow, so redeploys never hit",
    "  // \"account data too small\". Costs ~0.104 XNT of extra rent now; drop",
    "  // this line if you would rather pay only when you need it.",
    "  headroom: 15_000,",
    "  build: process.argv.includes('--build'),",
    "  dryRun: process.argv.includes('--dry-run'),",
    "  onLog: (line) => console.log(`  ${line}`),",
    "});",
    "",
    "if (process.argv.includes('--dry-run')) {",
    "  console.log('\\n  dry run — nothing was sent\\n');",
    "} else {",
    "  console.log(`\\n  deployed ${result.programId}`);",
    "  console.log(`  ${config.cluster.explorerUrl}/address/${result.programId}\\n`);",
    "}",
    "",
  ].join("\n");

const gitignore = (): string =>
  ["node_modules/", "target/", ".anchor/", "dist/", "test-ledger/", ".env", ""].join("\n");

const readme = (title: string, program: string, cluster: string): string =>
  [
    `# ${title}`,
    "",
    `An X1 program scaffolded with \`create-x1-dapp\`, targeting **${cluster}**.`,
    "",
    "## 1. Check your environment",
    "",
    "```sh",
    "npm install",
    "npm run doctor",
    "```",
    "",
    "`x1 doctor` verifies the toolchain, the RPC, your rate-limit budget and your",
    "wallet. Fix anything it flags before going further.",
    "",
    "## 2. Build",
    "",
    "```sh",
    "npm run build",
    "```",
    "",
    "This runs `anchor build --no-idl -- --arch v0`. Both flags matter: on",
    "solana-cli 4.x the default target is SBPFv3, which the bundled",
    "platform-tools reject, and without `--no-idl` anchor forwards `--arch` into",
    "its IDL step and fails after building the binary. `npm run idl` regenerates",
    "the IDL separately.",
    "",
    "## 3. Fund a wallet",
    "",
    "```sh",
    "solana address",
    "npm run doctor     # shows the address and current balance",
    "```",
    "",
    `Fund it at https://faucet.testnet.x1.xyz (testnet) or by transfer. A first`,
    "deploy of a program this size needs roughly **1.2 XNT** in rent-exempt",
    "deposit, not just fees.",
    "",
    "## 4. Deploy",
    "",
    "```sh",
    "npm run deploy          # build separately, then deploy",
    "npm run deploy -- --build   # rebuild first",
    "```",
    "",
    "The deploy script estimates the cost before sending anything and refuses",
    "with exact numbers if the wallet is short. It also repairs the",
    "`account data too small` failure on redeploys by calling",
    "`solana program extend` and retrying.",
    "",
    "> Upgrading an already-deployed program needs **~2x rent** available:",
    "> the CLI stages the new binary in a buffer account, which is refunded on",
    "> success. A first deploy only needs 1x.",
    "",
    "## Layout",
    "",
    "```",
    `programs/${program}/src/lib.rs   the program`,
    "x1.config.ts                   cluster, wallet and program settings",
    "scripts/deploy.mjs             deploy entry point",
    "```",
    "",
    "## Notes",
    "",
    `- Program id \`${program}\`'s keypair is at \`target/deploy/${program}-keypair.json\`. Keep it; it is the upgrade authority.`,
    "- `x1.config.ts` defaults to testnet. Change `cluster` to `mainnet` when ready.",
    "- See https://docs.x1.xyz for the platform docs.",
    "",
  ].join("\n");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const target = path.resolve(options.target);
  const dirName = path.basename(target);
  const pkg = packageName(dirName);
  const program = programName(dirName);

  if (!(await isEmptyDir(target)) && !options.force) {
    fail(`${options.target} is not empty. Pass --force to write into it anyway.`);
  }

  const keypair = Keypair.generate();
  const programId = keypair.publicKey.toBase58();
  const rpc = CLUSTERS[options.cluster] ?? options.cluster;
  const clusterLabel = Object.entries(CLUSTERS).find(([, url]) => url === rpc)?.[0] ?? rpc;
  const kitDep = options.kitPath ? `file:${resolveKitPath(options.kitPath)}` : "^0.1.0";

  const files: Record<string, string> = {
    "Anchor.toml": anchorToml(program, programId, rpc),
    "Cargo.toml": workspaceCargo(),
    "package.json": packageJson(pkg, kitDep),
    "x1.config.ts": x1Config(program),
    "README.md": readme(pkg, program, clusterLabel),
    ".gitignore": gitignore(),
    "scripts/deploy.mjs": deployScript(program),
    [`programs/${program}/Cargo.toml`]: programCargo(program),
    [`programs/${program}/src/lib.rs`]: programSource(program, programId),
    [`target/deploy/${program}-keypair.json`]: JSON.stringify(Array.from(keypair.secretKey)),
  };

  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(target, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, "utf8");
  }

  console.log(`
${green("✓")} Created ${bold(pkg)} in ${dim(target)}

  program id   ${cyan(programId)}
  module       ${program}
  cluster      ${clusterLabel} ${dim(rpc)}

${bold("Next")}
  ${dim("$")} cd ${options.target}
  ${dim("$")} npm install
  ${dim("$")} npm run doctor
  ${dim("$")} npm run build
  ${dim("$")} npm run deploy

  ${dim(`Program keypair: target/deploy/${program}-keypair.json (keep it — it is the upgrade authority)`)}
`);
}

main().catch((error: unknown) => {
  console.error(`\n${red("error:")} ${(error as Error).message}\n`);
  process.exit(1);
});
