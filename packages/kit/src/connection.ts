import { Connection } from "@solana/web3.js";
import type { Commitment } from "@solana/web3.js";

import {
  CLUSTERS,
  DEFAULT_CLUSTER,
  NATIVE_SYMBOL,
  resolveCluster,
  type ClusterInfo,
  type ClusterInput,
  type Limits,
} from "./constants.js";
import { createX1Fetch, type RateLimitInfo, type RetryInfo, type X1Fetch } from "./fetch.js";
import { Throttle, type ThrottleStats } from "./rate-limit.js";

export interface X1ConnectionOptions {
  /** "mainnet" | "testnet" | "localnet" | RPC URL. Defaults to testnet. */
  cluster?: ClusterInput;
  commitment?: Commitment;
  /**
   * Client-side limits. Pass `false` when you are on a private/dedicated RPC
   * that is not rate limited.
   */
  limits?: Partial<Limits> | false;
  maxRetries?: number;
  onRateLimit?: (info: RateLimitInfo) => void;
  onRetry?: (info: RetryInfo) => void;
  /** Extra Connection config, merged after ours. */
  connectionConfig?: Record<string, unknown>;
}

export interface X1ClientContext {
  cluster: ClusterInfo;
  fetch: X1Fetch;
  throttle: Throttle;
  stats(): ThrottleStats;
}

export type X1Connection = Connection & { readonly x1: X1ClientContext };

/**
 * `new Connection(...)` with the X1 specific parts already handled:
 * cluster resolution, retry/backoff, and respect for the public rate limits.
 *
 * Drop in where you would normally use `Connection` — everything else is identical.
 */
export function createX1Connection(options: X1ConnectionOptions = {}): X1Connection {
  const cluster = resolveCluster(options.cluster);

  // Bootstrap from the per-cluster limits rather than the documented global
  // ones: testnet allows fewer connections than mainnet, and the very first
  // burst happens before any response header has been read.
  const throttle =
    options.limits === false
      ? Object.assign(new Throttle(cluster.limits), { disabled: true })
      : new Throttle({ ...cluster.limits, ...options.limits });

  // If the caller named a concurrency, do not let header adoption overwrite it.
  if (options.limits && options.limits.maxConcurrent !== undefined) {
    throttle.pinnedConcurrency = true;
  }

  const x1Fetch = createX1Fetch({
    throttle,
    maxRetries: options.maxRetries,
    onRateLimit: options.onRateLimit,
    onRetry: options.onRetry,
  });

  const connection = new Connection(cluster.rpcUrl, {
    commitment: options.commitment ?? "confirmed",
    fetch: x1Fetch as any,
    // We own the retry policy. Left on, @solana/web3.js retries 429s on its
    // own, which fights this throttle and hides the failure from callers.
    disableRetryOnRateLimit: true,
    ...options.connectionConfig,
  });

  Object.defineProperty(connection, "x1", {
    value: {
      cluster,
      fetch: x1Fetch,
      throttle,
      stats: () => throttle.stats(),
    } satisfies X1ClientContext,
    enumerable: false,
    writable: false,
  });

  return connection as X1Connection;
}

export interface X1Status {
  rpcUrl: string;
  cluster: string;
  version: string | null;
  slot: number | null;
  blockHeight: number | null;
  health: string | null;
  latencyMs: number;
  explorerUrl: string;
}

/**
 * Minimal JSON-RPC call for methods @solana/web3.js does not expose
 * (notably `getHealth`).
 */
async function simpleRpc<T>(endpoint: string, method: string, params: unknown[] = []): Promise<T | null> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: T };
    return body.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Cheap "is this endpoint alive and what is it running" probe.
 * Safe to call on every app start; it is four requests.
 */
export async function getX1Status(connection: Connection): Promise<X1Status> {
  const startedAt = Date.now();

  const [version, slot, blockHeight, health] = await Promise.all([
    connection.getVersion().catch(() => null),
    connection.getSlot().catch(() => null),
    connection.getBlockHeight().catch(() => null),
    simpleRpc<string>(connection.rpcEndpoint, "getHealth"),
  ]);

  const cluster = (connection as Partial<X1Connection>).x1?.cluster;
  const rpcUrl = connection.rpcEndpoint;

  return {
    rpcUrl,
    cluster: cluster?.name ?? (rpcUrl.includes("testnet") ? "testnet" : rpcUrl.includes("x1.xyz") ? "mainnet" : "custom"),
    version: version ? `${version["solana-core"] ?? "unknown"}` : null,
    slot,
    blockHeight,
    health,
    latencyMs: Date.now() - startedAt,
    explorerUrl: cluster?.explorerUrl ?? CLUSTERS[DEFAULT_CLUSTER].explorerUrl,
  };
}

/** Format lamports as XNT without pulling in a dependency. */
export function formatXnt(lamports: number, decimals = 4): string {
  const whole = lamports / 1_000_000_000;
  return `${whole.toFixed(decimals)} ${NATIVE_SYMBOL}`;
}
