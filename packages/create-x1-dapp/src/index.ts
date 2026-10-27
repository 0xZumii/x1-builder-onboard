#!/usr/bin/env node
/**
 * create-x1-dapp
 *
 * Generates an Anchor program plus the glue that X1 actually needs:
 * a config file, a working deploy script, and build commands that survive
 * solana-cli 4.x. Every footgun documented in docs/findings.md is pre-handled.
 */
import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@solana/web3.js";

const isTty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (isTty ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const cyan = paint("36");

const CLUSTERS: Record<string, string> = {
  localnet: "http://127.0.0.1:8899",
  testnet: "https://rpc.testnet.x1.xyz",
  mainnet: "https://rpc.mainnet.x1.xyz",
};

interface Options {
  target: string;
  cluster: string;
  template: "web" | "basic";
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
  let template: "web" | "basic" = "web";
  let kitPath: string | undefined;
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "--cluster") {
      cluster = argv[++i] ?? cluster;
    } else if (arg.startsWith("--cluster=")) {
      cluster = arg.slice("--cluster=".length);
    } else if (arg === "--template") {
      template = (argv[++i] ?? template) as "web" | "basic";
    } else if (arg.startsWith("--template=")) {
      template = arg.slice("--template=".length) as "web" | "basic";
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

  if (template !== "web" && template !== "basic") {
    fail(`unknown template "${template}". Use web or basic.`);
  }

  return { target: positional[0], cluster, template, kitPath, force };
}

function usage(): void {
  console.log(`
${bold("create-x1-dapp")} — scaffold an X1 program with a working deploy path

${bold("USAGE")}
  create-x1-dapp <dir> [options]

${bold("OPTIONS")}
  --template <name>   web (default) | basic
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

const packageJson = (pkg: string, kitDep: string, template: "web" | "basic"): string => {
  const scripts: Record<string, string> = {
    // --arch v0: solana-cli 4.x defaults to SBPFv3 and then rejects it with
    // its own platform-tools. --no-idl: anchor otherwise forwards --arch
    // into its IDL step, where cargo test rejects it.
    build: "anchor build --no-idl -- --arch v0",
    idl: "node scripts/idl.mjs",
    deploy: "node scripts/deploy.mjs",
    doctor: "x1 doctor",
    funds: "x1 funds",
    status: "x1 status",
  };
  const dependencies: Record<string, string> = { "@x1/kit": kitDep };
  const devDependencies: Record<string, string> = {};

  if (template === "web") {
    scripts.dev = "vite";
    scripts["build:web"] = "vite build";
    scripts.preview = "vite preview";
    // Pinned to the 1.x line to match @x1/kit; 3.x changed the API.
    dependencies["@solana/web3.js"] = "^1.98.0";
    devDependencies.vite = "^8.0.0";
    devDependencies["vite-plugin-node-polyfills"] = "^0.28.0";
  }

  const manifest = {
    name: pkg,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts,
    dependencies,
    ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {}),
  };

  return JSON.stringify(manifest, null, 2) + "\n";
};

const x1Config = (program: string, cluster: string): string =>
  [
    'import { defineConfig } from "@x1/kit";',
    "",
    "export default defineConfig({",
    `  cluster: "${cluster}",`,
    '  wallet: "~/.config/solana/id.json",',
    "  program: {",
    `    name: "${program}",`,
    `    keypair: "target/deploy/${program}-keypair.json",`,
    "  },",
    "});",
    "",
  ].join("\n");

const deployScript = (program: string): string =>  [
    "// Deploys the program to X1. Handles build flags, rent estimation and the",
    "// `account data too small` repair automatically.",
    'import { createX1Connection, deployProgram, loadX1Config } from "@x1/kit";',
    "",
    "// Usage: npm run deploy [-- --cluster mainnet] [-- --dry-run] [-- --build]",
    "const flag = (name) => {",
    "  const index = process.argv.indexOf(name);",
    "  return index === -1 ? undefined : process.argv[index + 1];",
    "};",
    "",
    "const cluster = flag('--cluster');",
    "const config = await loadX1Config({ config: cluster ? { cluster } : {} });",
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

/**
 * `anchor idl build --out` fails silently (exit 0, "No such file or directory")
 * when target/idl does not exist. Create it first.
 */
const idlScript = (program: string): string =>
  [
    "// Generates target/idl/<program>.json.",
    'import { mkdirSync } from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    'import path from "node:path";',
    "",
    `const program = "${program}";`,
    'const out = path.join("target", "idl", `${program}.json`);',
    "",
    "mkdirSync(path.dirname(out), { recursive: true });",
    "",
    'const result = spawnSync("anchor", ["idl", "build", "--out", out], { stdio: "inherit" });',
    "if (result.status !== 0) process.exit(result.status ?? 1);",
    "",
    "console.log(`\\n  idl written to ${out}\\n`);",
    "",
  ].join("\n");

const gitignore = (): string =>  ["node_modules/", "target/", ".anchor/", "dist/", "test-ledger/", ".env", ""].join("\n");

const readme = (title: string, program: string, cluster: string, template: "web" | "basic"): string =>
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
    `Fund it at https://faucet.testnet.x1.xyz (testnet). On mainnet the route is`,
    "USDC → https://app.bridge.x1.xyz/ → USDC.X → https://app.xdex.xyz/swap → XNT;",
    "SOL cannot be bridged directly.",
    "",
    "`npm run funds` shows your balance, what this deploy needs, and how much you",
    "are short. A first deploy of a program this size needs roughly **1.2 XNT** in",
    "rent-exempt deposit, not just fees.",
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
    ...(template === "web"
      ? [
          "## Web UI",
          "",
          "```sh",
          "npm run dev",
          "```",
          "",
          "Connects a wallet and calls the program from the browser. It expects a",
          "local validator: run `x1 localnet` in another terminal. Airdrops work",
          "locally, so the testnet faucet being down does not block you.",
          "",
          "Point it elsewhere with:",
          "",
          "```sh",
          "VITE_X1_RPC=https://rpc.testnet.x1.xyz npm run dev",
          "```",
          "",
          "The UI talks to the wallet through `window.x1`, `window.backpack` or",
          "`window.solana`, whichever the extension injects.",
          "",
        ]
      : []),
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

const TEMPLATES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full, base)));
    else files.push(path.relative(base, full));
  }
  return files;
}

/**
 * Copies a template directory into the target, replacing __TOKENS__.
 * Paths are mirrored exactly, so `templates/web/web/index.html` lands at
 * `<project>/web/index.html`.
 */
async function copyTemplate(
  template: string,
  target: string,
  replacements: Record<string, string>,
): Promise<void> {
  const root = path.join(TEMPLATES_ROOT, template);
  if (!existsSync(root)) return;

  for (const relative of await listFiles(root)) {
    let contents = await readFile(path.join(root, relative), "utf8");
    for (const [token, value] of Object.entries(replacements)) {
      contents = contents.split(token).join(value);
    }
    const file = path.join(target, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, "utf8");
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // When run from the monorepo, link the local package instead of asking npm
  // for a version that has not been published. Keeps `npm run create` working
  // without an npm account.
  if (!options.kitPath) {
    const localKit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "kit");
    if (existsSync(path.join(localKit, "package.json"))) {
      options.kitPath = localKit;
    }
  }

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
    "package.json": packageJson(pkg, kitDep, options.template),
    "x1.config.ts": x1Config(program, clusterLabel),
    "README.md": readme(pkg, program, clusterLabel, options.template),
    ".gitignore": gitignore(),
    "scripts/deploy.mjs": deployScript(program),
    "scripts/idl.mjs": idlScript(program),
    [`programs/${program}/Cargo.toml`]: programCargo(program),
    [`programs/${program}/src/lib.rs`]: programSource(program, programId),
    [`target/deploy/${program}-keypair.json`]: JSON.stringify(Array.from(keypair.secretKey)),
  };

  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(target, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, "utf8");
  }

  if (options.template === "web") {
    await copyTemplate("web", target, {
      __PROGRAM_ID__: programId,
      __PROGRAM__: program,
      __PACKAGE__: pkg,
    });
  }

  console.log(`
${green("✓")} Created ${bold(pkg)} in ${dim(target)}

  program id   ${cyan(programId)}
  module       ${program}
  template     ${options.template}
  cluster      ${clusterLabel} ${dim(rpc)}

${bold("Next")}
  ${dim("$")} cd ${options.target}
  ${dim("$")} npm install
  ${dim("$")} npm run doctor
  ${dim("$")} npm run build${
    options.template === "web"
      ? `\n  ${dim("$")} npm run dev          ${dim("# web UI against http://127.0.0.1:8899")}`
      : ""
  }
  ${dim("$")} npm run deploy

  ${dim(`Program keypair: target/deploy/${program}-keypair.json (keep it — it is the upgrade authority)`)}
  ${
    options.template === "web"
      ? dim("Web UI expects a local validator: run `x1 localnet` in another terminal.\n")
      : ""
  }`);
}

main().catch((error: unknown) => {
  console.error(`\n${red("error:")} ${(error as Error).message}\n`);
  process.exit(1);
});
