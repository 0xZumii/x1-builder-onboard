import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { run, toolVersion, type RunResult } from "./exec.js";

export interface DeployOptions {
  connection: Connection;
  rpcUrl: string;
  walletPath: string;
  /** Program id (base58). Derived from the program keypair when omitted. */
  programId?: string;
  /** Path to the program's keypair JSON. */
  programKeypairPath?: string;
  /** Path to the built program (.so). */
  soPath?: string;
  /** Used to locate target/deploy/<name>.so. */
  programName?: string;
  /** Run `anchor build` first. Defaults to true when Anchor.toml is present. */
  build?: boolean;
  /** Bytes to grow the program account by when it is too small. Default 15000. */
  extendBy?: number;
  maxExtendAttempts?: number;
  priorityFee?: number | "auto";
  /**
   * Extra bytes to allocate on the *first* deploy, via `--max-len`.
   *
   * This is prevention instead of repair: the program is born with room to
   * grow, so later redeploys fit and never hit "account data too small".
   * Costs the extra rent up front (≈0.104 XNT per 15KB). Ignored on upgrades.
   */
  headroom?: number;
  /** Skip the pre-flight balance check (not recommended). */
  skipBalanceCheck?: boolean;
  cwd?: string;
  dryRun?: boolean;
  onLog?: (line: string) => void;
}

export interface DeployResult {
  programId: string;
  soPath: string;
  signature?: string;
  /** Bytes added via `solana program extend`, 0 when no extend was needed. */
  extendedBytes: number;
  extendAttempts: number;
  built: boolean;
}

/** Errors that mean "the on-chain account is smaller than the new binary". */
const NEEDS_EXTEND = [
  /account data too small/i,
  /account data size/i,
  /insufficient.*(space|storage)/i,
  /failed to write file.*(overflow|too (small|large))/i,
  /account.*too small/i,
];

function needsExtend(output: string): boolean {
  return NEEDS_EXTEND.some((pattern) => pattern.test(output));
}

export function extractSignature(output: string): string | undefined {
  return output.match(/Signature:\s*([1-9A-HJ-NP-Za-km-z]{32,88})/)?.[1];
}

export function extractProgramId(output: string): string | undefined {
  return output.match(/Program Id:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1];
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** X1/Solana rent: (bytes + 128) * 6960 lamports. */
export const RENT_PER_BYTE = 6960;
export const ACCOUNT_OVERHEAD = 128;

export function rentExemptLamports(bytes: number): number {
  return (bytes + ACCOUNT_OVERHEAD) * RENT_PER_BYTE;
}

export interface DeployCostEstimate {
  soBytes: number;
  /** Current on-chain allocation, or null if the program is not deployed. */
  existingAllocation: number | null;
  isUpgrade: boolean;
  /** Rent for the program account itself. */
  rentLamports: number;
  /**
   * Rent for the temporary buffer account. Only needed on an upgrade: the
   * first deploy writes directly into the program account, but a redeploy
   * stages the binary in a buffer first. Refunded on success.
   */
  bufferLamports: number;
  requiredLamports: number;
}

/**
 * Works out what a deploy will actually cost, so the failure happens before
 * any transaction rather than after a partial write.
 */
export async function estimateDeployCost(
  connection: Connection,
  programId: string,
  soBytes: number,
): Promise<DeployCostEstimate> {
  const existingAllocation = await getProgramAllocation(connection, programId).catch(() => null);
  const rentLamports = rentExemptLamports(soBytes);
  const isUpgrade = existingAllocation !== null;
  const bufferLamports = isUpgrade ? rentLamports : 0;

  return {
    soBytes,
    existingAllocation,
    isUpgrade,
    rentLamports,
    bufferLamports,
    requiredLamports: rentLamports + bufferLamports,
  };
}

function xnt(lamports: number): string {
  return `${(lamports / 1_000_000_000).toFixed(4)} XNT`;
}

export async function addressFromKeypair(keypairPath: string): Promise<string> {
  const secret = JSON.parse(await readFile(keypairPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey.toBase58();
}

export async function programIdFromKeypair(keypairPath: string): Promise<string> {
  return addressFromKeypair(keypairPath);
}

/**
 * Bytes currently allocated to an upgradeable program, or null if the program
 * is not deployed yet.
 *
 * Reads the ProgramData account instead of guessing, so `extend` is sized
 * from the real shortfall.
 */
export async function getProgramAllocation(connection: Connection, programId: string): Promise<number | null> {
  const info = await connection.getAccountInfo(new PublicKey(programId));
  if (!info) return null;

  // Upgradeable loader: [4-byte tag][32-byte ProgramData address]
  if (info.data.length >= 36) {
    try {
      const programDataAddress = new PublicKey(info.data.subarray(4, 36));
      const programData = await connection.getAccountInfo(programDataAddress);
      if (programData) return programData.data.length;
    } catch {
      // Not an upgradeable program (or a loader we do not understand).
    }
  }

  return info.data.length;
}

/** Finds the most recently built .so for a program, if one exists. */
export async function findProgramSo(targetDir: string, programName?: string): Promise<string | null> {
  const deployDir = path.join(targetDir, "deploy");
  if (programName) {
    const candidate = path.join(deployDir, `${programName}.so`);
    if (await fileExists(candidate)) return candidate;
  }

  try {
    const entries = await readdir(deployDir);
    const candidates = entries.filter((entry) => entry.endsWith(".so"));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return path.join(deployDir, candidates[0]!);

    // Multiple programs: pick the newest build.
    let newest: { file: string; mtime: number } | null = null;
    for (const entry of candidates) {
      const file = path.join(deployDir, entry);
      const info = await stat(file);
      if (!newest || info.mtimeMs > newest.mtime) newest = { file, mtime: info.mtimeMs };
    }
    return newest?.file ?? null;
  } catch {
    return null;
  }
}

/** Anchor writes the program keypair next to the binary. */
export async function findProgramKeypair(targetDir: string, programName?: string): Promise<string | null> {
  const deployDir = path.join(targetDir, "deploy");

  if (programName) {
    const candidate = path.join(deployDir, `${programName}-keypair.json`);
    if (await fileExists(candidate)) return candidate;
  }

  try {
    const entries = await readdir(deployDir);
    const keypairs = entries.filter((entry) => entry.endsWith("-keypair.json"));
    if (keypairs.length === 1) return path.join(deployDir, keypairs[0]!);
    return null;
  } catch {
    return null;
  }
}

function deployArgs(
  options: DeployOptions,
  soPath: string,
  programId: string,
  programKeypairPath?: string,
  maxLen?: number,
): string[] {
  const args = [
    "program",
    "deploy",
    soPath,
    "--url",
    options.rpcUrl,
    "--keypair",
    options.walletPath,
    // Prefer the keypair (it can create the account); a bare public key only
    // works for a program that is already deployed.
    "--program-id",
    programKeypairPath ?? programId,
  ];

  if (maxLen && maxLen > 0) {
    args.push("--max-len", String(maxLen));
  }

  if (typeof options.priorityFee === "number" && options.priorityFee > 0) {
    args.push("--with-compute-unit-price", String(Math.floor(options.priorityFee)));
  }

  return args;
}

/**
 * Deploys a program to X1 and recovers from the classic SVM redeploy failure.
 *
 * The first deploy of a program allocates exactly the binary's size. Ship one
 * more instruction and the next deploy dies with "account data too small".
 * X1's docs tell you to run `solana program extend` by hand; this does it
 * automatically, then retries.
 */
export async function deployProgram(options: DeployOptions): Promise<DeployResult> {
  const log = options.onLog ?? (() => {});
  const cwd = options.cwd ?? process.cwd();
  const extendBy = options.extendBy ?? 15_000;
  const maxExtendAttempts = options.maxExtendAttempts ?? 3;

  const shouldBuild = options.build ?? (await fileExists(path.join(cwd, "Anchor.toml")));
  let built = false;

  if (shouldBuild) {
    const solanaVersion = await toolVersion("solana");
    const major = Number(solanaVersion?.match(/(\d+)\./)?.[1] ?? 0);

    // solana-cli 4.x defaults `cargo build-sbf` to the SBPFv3 target and then
    // rejects it with its own bundled platform-tools:
    //   "Platform tools v1.52 is incompatible with SBPFv3"
    // `--arch v0` emits the older target, which X1 accepts.
    //
    // `--no-idl` is required because anchor forwards the extra cargo args into
    // its IDL step as well, where `cargo test` rejects `--arch`. The IDL is
    // regenerated separately below.
    const buildArgs = major >= 4
      ? ["build", "--no-idl", "--", "--arch", "v0"]
      : ["build"];

    log(`$ anchor ${buildArgs.join(" ")}`);
    const build = await run("anchor", buildArgs, { cwd });
    if (!build.ok) {
      throw new Error(`anchor ${buildArgs.join(" ")} failed:\n${(build.stderr || build.stdout).trim()}`);
    }

    if (major >= 4) {
      // Best effort: the IDL is a build convenience, not a deploy requirement.
      const idl = await run("anchor", ["idl", "build"], { cwd });
      if (!idl.ok) log("note: IDL generation failed (the program itself built fine)");
    }

    built = true;
  }

  const soPath =
    options.soPath ??
    (await findProgramSo(path.join(cwd, "target"), options.programName)) ??
    undefined;

  if (!soPath || !(await fileExists(soPath))) {
    throw new Error(
      `No built program found${options.programName ? ` for "${options.programName}"` : ""}. ` +
        `Run \`anchor build\` or pass soPath explicitly.`,
    );
  }

  // Anchor writes <program>-keypair.json next to the .so. Find it so callers
  // do not have to thread the program id through by hand.
  let programKeypairPath = options.programKeypairPath;
  if (!programKeypairPath && !options.programId) {
    programKeypairPath = await findProgramKeypair(
      path.join(cwd, "target"),
      options.programName ?? path.basename(soPath, ".so"),
    ) ?? undefined;
  }

  const programId =
    options.programId ??
    (programKeypairPath ? await programIdFromKeypair(programKeypairPath) : undefined);

  if (!programId) {
    throw new Error(
      "Cannot determine the program id. Pass programId or programKeypairPath, " +
        "or make sure target/deploy/<program>-keypair.json exists.",
    );
  }

  const soBytes = (await stat(soPath)).size;
  const headroom = Math.max(0, options.headroom ?? 0);
  let estimate = await estimateDeployCost(options.connection, programId, soBytes);

  // `--max-len` only sizes a newly created account, so headroom is meaningless
  // on an upgrade (the account already exists). Charge the extra rent to the
  // estimate so the pre-flight check stays honest.
  const maxLen = !estimate.isUpgrade && headroom > 0 ? soBytes + headroom : undefined;
  if (maxLen) {
    const bytes = maxLen;
    const rent = rentExemptLamports(bytes);
    estimate = { ...estimate, soBytes: bytes, rentLamports: rent, requiredLamports: rent };
  }

  log(
    `${estimate.isUpgrade ? "upgrade" : "first deploy"} · ${soBytes} bytes · ` +
      `rent ${xnt(estimate.rentLamports)}` +
      (maxLen ? ` (+${headroom} headroom)` : "") +
      (estimate.isUpgrade ? ` + buffer ${xnt(estimate.bufferLamports)} (refunded)` : ""),
  );

  if (options.dryRun) {
    log(`[dry-run] solana ${deployArgs(options, soPath, programId, programKeypairPath, maxLen).join(" ")}`);
    log(`[dry-run] required balance: ${xnt(estimate.requiredLamports)}`);
    return { programId, soPath, extendedBytes: 0, extendAttempts: 0, built };
  }

  if (!options.skipBalanceCheck) {
    const walletAddress = await addressFromKeypair(options.walletPath).catch(() => null);
    const balance = walletAddress
      ? await options.connection.getBalance(new PublicKey(walletAddress)).catch(() => null)
      : null;

    if (walletAddress && balance !== null && balance < estimate.requiredLamports) {
      throw new Error(
        `Not enough XNT to ${estimate.isUpgrade ? "upgrade" : "deploy"}.\n` +
          `  wallet:   ${walletAddress} (${xnt(balance)})\n` +
          `  required: ${xnt(estimate.requiredLamports)} = ${xnt(estimate.rentLamports)} rent` +
          (estimate.isUpgrade ? ` + ${xnt(estimate.bufferLamports)} buffer (refunded on success)` : "") +
          "\n" +
          (estimate.isUpgrade
            ? "  An upgrade stages the binary in a buffer account, so it needs ~2x the program's rent.\n"
            : ""),
      );
    }
  }

  let extendedBytes = 0;
  let extendAttempts = 0;
  let lastResult: RunResult | null = null;
  let allowMaxLen = maxLen !== undefined;

  while (extendAttempts <= maxExtendAttempts) {
    const args = deployArgs(
      options,
      soPath,
      programId,
      programKeypairPath,
      allowMaxLen ? maxLen : undefined,
    );
    log(`$ solana ${args.join(" ")}`);

    const result = await run("solana", args, { cwd });
    lastResult = result;

    const output = `${result.stdout}\n${result.stderr}`;
    if (result.ok) {
      const signature = extractSignature(output);
      log(`Deployed ${programId}${signature ? ` (${signature})` : ""}`);
      return { programId, soPath, signature, extendedBytes, extendAttempts, built };
    }

    // Not every CLI accepts --max-len. Drop it and try again before treating
    // this as a real failure; costs one extra attempt at most.
    if (allowMaxLen && /(unknown|unexpected|unrecognized).*argument|invalid value/i.test(output)) {
      log("--max-len was rejected by this CLI; retrying without pre-allocation");
      allowMaxLen = false;
      continue;
    }

    if (!needsExtend(output) || extendAttempts >= maxExtendAttempts) break;

    extendAttempts += 1;

    // Size the extend from the actual allocation when the RPC will tell us,
    // otherwise fall back to the documented default.
    let growBy = extendBy;
    const allocation = await getProgramAllocation(options.connection, programId).catch(() => null);
    if (allocation !== null) {
      const binarySize = (await stat(soPath)).size;
      const shortfall = binarySize - allocation;
      if (shortfall > 0) growBy = Math.max(extendBy, Math.ceil(shortfall / 1024) * 1024 + 4_096);
    }

    log(
      `Program account is too small (attempt ${extendAttempts}/${maxExtendAttempts}). ` +
        `Extending by ${growBy} bytes and retrying.`,
    );

    const extend = await run(
      "solana",
      [
        "program",
        "extend",
        programId,
        String(growBy),
        "--url",
        options.rpcUrl,
        "--keypair",
        options.walletPath,
      ],
      { cwd },
    );

    if (!extend.ok) {
      throw new Error(
        `solana program extend failed:\n${(extend.stderr || extend.stdout).trim()}\n\n` +
          `Original deploy error:\n${output.trim()}`,
      );
    }

    extendedBytes += growBy;
  }

  throw new Error(
    `Deploy failed after ${extendAttempts} extend attempt(s):\n${(lastResult?.stderr || lastResult?.stdout || "unknown error").trim()}`,
  );
}
