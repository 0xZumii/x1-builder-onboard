import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_CLUSTER,
  resolveCluster,
  type ClusterInfo,
  type ClusterInput,
  type Limits,
} from "./constants.js";

/**
 * Shape of `x1.config.ts`. Everything except `cluster` is optional.
 */
export interface X1Config {
  /** "testnet" by default. Never default to mainnet. */
  cluster?: ClusterInput;
  /** Path to the deployer keypair. Defaults to the Solana CLI keypair. */
  wallet?: string;
  program?: {
    name?: string;
    programId?: string;
    /** Path to the program's keypair JSON. */
    keypair?: string;
    /** Path to the built .so, if you do not use the default target/deploy path. */
    soPath?: string;
  };
  limits?: Partial<Limits> | false;
  /** Priority fee in microlamports, or "auto" to let the CLI decide. */
  priorityFee?: number | "auto";
  /** Relative directories to include when scaffolding/running scripts. */
  paths?: {
    programs?: string;
    target?: string;
  };
}

export interface ResolvedX1Config extends Required<Pick<X1Config, "cluster">> {
  configPath: string | null;
  rootDir: string;
  cluster: ClusterInfo;
  walletPath: string;
  program: {
    name?: string;
    programId?: string;
    keypairPath?: string;
    soPath?: string;
  };
  limits: Partial<Limits> | false;
  priorityFee: number | "auto" | undefined;
  programsDir: string;
  targetDir: string;
}

/** Identity helper so editors autocomplete the config file. */
export function defineConfig(config: X1Config): X1Config {
  return config;
}

const CONFIG_FILENAMES = [
  "x1.config.ts",
  "x1.config.mts",
  "x1.config.js",
  "x1.config.mjs",
  "x1.config.json",
];

/** `import()` that works even when this package is compiled to CommonJS. */
const dynamicImport = new Function("url", "return import(url)") as (
  url: string,
) => Promise<any>;

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function findConfigFile(from = process.cwd()): Promise<string | null> {
  let dir = path.resolve(from);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readConfigFile(file: string): Promise<X1Config> {
  if (file.endsWith(".json")) {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(file, "utf8")) as X1Config;
  }

  try {
    const mod = await dynamicImport(pathToFileURL(file).href);
    return (mod.default ?? mod) as X1Config;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ERR_UNKNOWN_FILE_EXTENSION") {
      throw new Error(
        `Cannot load ${path.basename(file)} on Node ${process.version}.\n` +
          `Either upgrade to Node 22.6+ (type stripping) or use x1.config.json / x1.config.mjs.`,
      );
    }
    throw error;
  }
}

/**
 * Expands a leading `~` to the home directory.
 *
 * `path.resolve` does not understand `~`, so `wallet: "~/.config/solana/id.json"`
 * would silently become `<project>/~/.config/...` — which then fails with a
 * confusing "cannot read" error.
 */
export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function defaultSolanaKeypair(): string {
  return path.join(os.homedir(), ".config", "solana", "id.json");
}

/**
 * Finds the nearest `x1.config.*`, walking up from `from`, and fills in defaults.
 */
export async function loadX1Config(options: { from?: string; config?: X1Config; configPath?: string } = {}): Promise<ResolvedX1Config> {
  const configPath = options.configPath ?? (await findConfigFile(options.from));
  const fileConfig = configPath ? await readConfigFile(configPath) : {};
  const merged: X1Config = { ...fileConfig, ...options.config };
  const rootDir = configPath ? path.dirname(configPath) : path.resolve(options.from ?? process.cwd());

  const cluster = resolveCluster(merged.cluster ?? DEFAULT_CLUSTER);

  const resolvePath = (value: string | undefined, fallback: string): string =>
    value ? path.resolve(rootDir, expandHome(value)) : fallback;

  return {
    configPath,
    rootDir,
    cluster,
    walletPath: resolvePath(merged.wallet, defaultSolanaKeypair()),
    program: {
      name: merged.program?.name,
      programId: merged.program?.programId,
      keypairPath: merged.program?.keypair ? path.resolve(rootDir, expandHome(merged.program.keypair)) : undefined,
      soPath: merged.program?.soPath ? path.resolve(rootDir, expandHome(merged.program.soPath)) : undefined,
    },
    limits: merged.limits ?? {},
    priorityFee: merged.priorityFee,
    programsDir: resolvePath(merged.paths?.programs, path.join(rootDir, "programs")),
    targetDir: resolvePath(merged.paths?.target, path.join(rootDir, "target")),
  };
}
