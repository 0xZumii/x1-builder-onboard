import { readFile } from "node:fs/promises";

import { Keypair } from "@solana/web3.js";

import { resolveCluster, type ClusterInput } from "./constants.js";
import { createX1Connection, formatXnt } from "./connection.js";
import { toolVersion } from "./exec.js";
import type { RateLimitInfo } from "./fetch.js";
import { parseRateLimitHeaders } from "./fetch.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
  hint?: string;
}

export interface DoctorOptions {
  cluster?: ClusterInput;
  walletPath?: string;
  /** Skip the network checks (useful offline / in CI). */
  offline?: boolean;
}

export interface DoctorReport {
  checks: Check[];
  ok: boolean;
  summary: { pass: number; warn: number; fail: number; skip: number };
}

async function nodeCheck(): Promise<Check> {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    id: "node",
    label: "Node.js",
    status: major >= 20 ? "pass" : "fail",
    detail: `v${process.versions.node}`,
    hint: major >= 20 ? undefined : "Upgrade to Node 20 or newer.",
  };
}

async function platformCheck(): Promise<Check> {
  if (process.platform !== "win32") {
    return { id: "platform", label: "Platform", status: "pass", detail: process.platform };
  }
  return {
    id: "platform",
    label: "Platform",
    status: "warn",
    detail: "win32 — the Solana/Anchor toolchain does not run natively here",
    hint: "Install WSL2 (wsl --install) and work inside Ubuntu. TypeScript tooling runs fine on Windows.",
  };
}

async function cliCheck(
  id: string,
  label: string,
  command: string,
  args?: string[],
  required = true,
): Promise<Check> {
  const version = await toolVersion(command, args);
  if (!version) {
    return {
      id,
      label,
      status: required ? "fail" : "warn",
      detail: "not found on PATH",
      hint: `Install ${command} — see https://docs.x1.xyz/build-on-x1/create-programs-on-x1`,
    };
  }
  return { id, label, status: "pass", detail: version };
}

interface RpcProbe {
  check: Check;
  rateLimit?: RateLimitInfo;
}

async function rpcProbe(rpcUrl: string): Promise<RpcProbe> {
  const startedAt = Date.now();
  let captured: RateLimitInfo | undefined;

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(10_000),
    });

    const rateLimit = parseRateLimitHeaders(response.status, response.headers);
    captured = rateLimit;

    const body = (await response.json().catch(() => null)) as
      | { result?: string; error?: { message?: string } }
      | null;

    if (!response.ok) {
      return {
        check: {
          id: "rpc",
          label: "RPC endpoint",
          status: "fail",
          detail: `HTTP ${response.status}`,
          hint: `Check ${rpcUrl} or pass --cluster testnet.`,
        },
        rateLimit,
      };
    }

    const latency = Date.now() - startedAt;
    return {
      check: {
        id: "rpc",
        label: "RPC endpoint",
        status: "pass",
        detail: `${rpcUrl} · ${latency}ms${body?.result ? ` · ${body.result}` : ""}`,
      },
      rateLimit,
    };
  } catch (error) {
    return {
      check: {
        id: "rpc",
        label: "RPC endpoint",
        status: "fail",
        detail: `${rpcUrl} unreachable (${(error as Error).message})`,
        hint: "Check your connection, or try --cluster testnet.",
      },
    };
  }
}

function rateLimitCheck(info?: RateLimitInfo): Check {
  if (!info || info.shortLimit === undefined) {
    return {
      id: "limits",
      label: "Rate limit headers",
      status: "skip",
      detail: "endpoint did not return X-RateLimit-* headers",
    };
  }

  const short = `${info.short ?? "?"}/${info.shortLimit} per ${(info.shortWindowMs ?? 5_000) / 1_000}s`;
  const connections =
    info.connectionLimit !== undefined ? ` · ${info.connections ?? "?"}/${info.connectionLimit} conn` : "";

  return {
    id: "limits",
    label: "Rate limit headers",
    status: "pass",
    detail: short + connections,
  };
}

function limitBudgetCheck(info?: RateLimitInfo): Check {
  if (!info) {
    return { id: "budget", label: "Hourly request budget", status: "skip", detail: "unknown" };
  }
  if (!info.longLimit) {
    // testnet does not publish an hourly cap. That is not a problem.
    return {
      id: "budget",
      label: "Hourly request budget",
      status: "skip",
      detail: "no hourly cap advertised by this endpoint",
    };
  }
  const used = info.long ?? 0;
  const ratio = used / info.longLimit;
  const status: CheckStatus = ratio > 0.9 ? "fail" : ratio > 0.7 ? "warn" : "pass";
  return {
    id: "budget",
    label: "Hourly request budget",
    status,
    detail: `${used.toLocaleString()} / ${info.longLimit.toLocaleString()} used`,
    hint: status === "pass" ? undefined : "You are close to the 1h cap. Batch requests or use a private RPC.",
  };
}

/**
 * Catches the SBPFv3 trap before it costs an afternoon.
 *
 * solana-cli 4.x defaults `cargo-build-sbf` to the SBPFv3 target and then
 * rejects it with its own bundled platform-tools:
 *   "Platform tools v1.52 is incompatible with SBPFv3"
 * A fresh Anchor project cannot build at all. The 2.0.x line emits the older
 * target that X1 accepts.
 */
async function sbpfCheck(): Promise<Check> {
  const version = await toolVersion("solana", ["--version"]);
  if (!version) {
    return { id: "sbpf", label: "SBPF target", status: "skip", detail: "Solana CLI missing" };
  }

  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return { id: "sbpf", label: "SBPF target", status: "skip", detail: "unrecognised version string" };
  }

  const major = Number(match[1]);
  const pretty = `${match[1]}.${match[2]}.${match[3]}`;

  if (major >= 4) {
    // Usable, but only because the kit passes --arch v0 explicitly.
    return {
      id: "sbpf",
      label: "SBPF target",
      status: "pass",
      detail: `${pretty} · SBPFv0 via --arch v0`,
      hint: "Bare `anchor build` fails on 4.x; use `x1 deploy` or `anchor build --no-idl -- --arch v0`.",
    };
  }

  if (major === 2) {
    return {
      id: "sbpf",
      label: "SBPF target",
      status: "warn",
      detail: `${pretty} · bundled cargo 1.75 cannot read modern crates (edition2024)`,
      hint: "Newer crates.io packages break 2.x builds. Prefer a 4.x client with --arch v0.",
    };
  }

  return {
    id: "sbpf",
    label: "SBPF target",
    status: "warn",
    detail: `${pretty} · compatibility with X1 not verified`,
    hint: "If builds fail with an SBPF/platform-tools error, try --arch v0.",
  };
}

async function walletCheck(walletPath?: string, connection?: ReturnType<typeof createX1Connection>): Promise<Check> {
  if (!walletPath) {
    return { id: "wallet", label: "Wallet", status: "skip", detail: "no keypair path given" };
  }

  let address: string;
  try {
    const secret = JSON.parse(await readFile(walletPath, "utf8")) as number[];
    address = Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey.toBase58();
  } catch {
    return {
      id: "wallet",
      label: "Wallet",
      status: "fail",
      detail: `cannot read ${walletPath}`,
      hint: "Create one with: solana-keygen new -o ~/.config/solana/id.json",
    };
  }

  if (!connection) {
    return { id: "wallet", label: "Wallet", status: "pass", detail: address };
  }

  try {
    const lamports = await connection.getBalance(new (await import("@solana/web3.js")).PublicKey(address));
    return {
      id: "wallet",
      label: "Wallet",
      status: lamports === 0 ? "warn" : "pass",
      detail: `${address} · ${formatXnt(lamports)}`,
      hint: lamports === 0 ? "Fund it at https://faucet.testnet.x1.xyz" : undefined,
    };
  } catch {
    return { id: "wallet", label: "Wallet", status: "pass", detail: address };
  }
}

/**
 * Everything a new X1 developer needs verified before their first deploy.
 * Designed to be the first command anyone runs.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cluster = resolveCluster(options.cluster);
  const checks: Check[] = [];

  checks.push(await nodeCheck());
  checks.push(await platformCheck());
  checks.push(await cliCheck("solana", "Solana CLI", "solana", ["--version"]));
  checks.push(await sbpfCheck());
  checks.push(await cliCheck("anchor", "Anchor CLI", "anchor", ["--version"]));
  checks.push(await cliCheck("rustc", "Rust", "rustc", ["--version"]));

  let connection: ReturnType<typeof createX1Connection> | undefined;

  if (options.offline) {
    checks.push({ id: "rpc", label: "RPC endpoint", status: "skip", detail: "offline mode" });
  } else {
    const probe = await rpcProbe(cluster.rpcUrl);
    checks.push(probe.check);
    checks.push(rateLimitCheck(probe.rateLimit));
    checks.push(limitBudgetCheck(probe.rateLimit));

    connection = createX1Connection({ cluster });
    try {
      const [slot, blockHeight] = await Promise.all([
        connection.getSlot(),
        connection.getBlockHeight(),
      ]);
      checks.push({
        id: "chain",
        label: "Chain is producing",
        status: blockHeight > 0 ? "pass" : "warn",
        detail: `slot ${slot.toLocaleString()} · block ${blockHeight.toLocaleString()}`,
      });
    } catch (error) {
      checks.push({
        id: "chain",
        label: "Chain is producing",
        status: "fail",
        detail: (error as Error).message,
      });
    }
    checks.push(await walletCheck(options.walletPath, connection));
  }

  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) summary[check.status] += 1;

  return { checks, ok: summary.fail === 0, summary };
}
