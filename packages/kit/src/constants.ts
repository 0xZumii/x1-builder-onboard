/**
 * X1 network constants.
 *
 * Sources:
 *  - https://docs.x1.xyz/build-on-x1/resources
 *  - https://docs.x1.xyz/build-on-x1/rpc-rate-limits
 */

export type ClusterName = "mainnet" | "testnet" | "localnet";

/**
 * Per-IP limits enforced by the public X1 RPC endpoints.
 *
 * The docs publish one set of numbers, but the endpoints do not actually agree
 * with each other or always with the docs. Measured directly:
 *
 *   mainnet  300 req/5s, 40 heavy/5s, 150k/hour, 30 connections
 *   testnet  400 req/5s, 40 heavy/5s, no hourly cap, 15 connections
 *
 * The `X-RateLimit-*` and `X-Conn-*` headers are authoritative. These values
 * exist so the first burst is safe before any response has been seen.
 */
export interface Limits {
  shortWindowMs: number;
  shortCap: number;
  longWindowMs: number;
  longCap: number;
  heavyWindowMs: number;
  heavyCap: number;
  maxConcurrent: number;
}

export const PUBLIC_LIMITS: Limits = {
  shortWindowMs: 5_000,
  shortCap: 300,
  longWindowMs: 60 * 60 * 1_000,
  longCap: 150_000,
  heavyWindowMs: 5_000,
  heavyCap: 40,
  // 80% of the advertised 30. See CONNECTION_HEADROOM.
  maxConcurrent: 24,
};

/**
 * Testnet is more generous on requests per second but much tighter on
 * connections, and it does not publish an hourly cap at all.
 */
export const TESTNET_LIMITS: Limits = {
  shortWindowMs: 5_000,
  shortCap: 400,
  longWindowMs: 60 * 60 * 1_000,
  longCap: 1_000_000_000,
  heavyWindowMs: 5_000,
  heavyCap: 40,
  // 80% of the advertised 15. See CONNECTION_HEADROOM.
  maxConcurrent: 12,
};

/**
 * Fraction of the advertised connection cap we are willing to use.
 *
 * Measured against testnet (`x-conn-limit: 15`): 60 requests at concurrency
 * 12 complete cleanly in ~1.2s, while concurrency 15 returns 429 for 31 of
 * them. The advertised number counts TCP connections, and TLS setup plus
 * socket churn means N concurrent requests can briefly be N+ sockets. Staying
 * 20% under the cap is the difference between a fast client and a throttled one.
 */
export const CONNECTION_HEADROOM = 0.8;

/** Advertised connection cap -> the concurrency we will actually use. */
export function effectiveConcurrency(advertised: number | undefined): number | undefined {
  if (advertised === undefined || !Number.isFinite(advertised) || advertised <= 0) return undefined;
  return Math.max(1, Math.floor(advertised * CONNECTION_HEADROOM));
}

/** A local validator is yours; do not throttle it. */
export const LOCAL_LIMITS: Limits = {
  shortWindowMs: 5_000,
  shortCap: 1_000_000_000,
  longWindowMs: 60 * 60 * 1_000,
  longCap: 1_000_000_000,
  heavyWindowMs: 5_000,
  heavyCap: 1_000_000_000,
  maxConcurrent: 1_000_000_000,
};

export interface ClusterInfo {
  name: ClusterName | string;
  rpcUrl: string;
  explorerUrl: string;
  /** Public faucet, if the cluster has one. Mainnet has none. */
  faucetUrl: string | null;
  /** Bootstrap limits; replaced by whatever the endpoint advertises. */
  limits: Limits;
}

export const CLUSTERS: Record<ClusterName, ClusterInfo> = {
  mainnet: {
    name: "mainnet",
    rpcUrl: "https://rpc.mainnet.x1.xyz",
    explorerUrl: "https://explorer.mainnet.x1.xyz",
    faucetUrl: null,
    limits: PUBLIC_LIMITS,
  },
  testnet: {
    name: "testnet",
    rpcUrl: "https://rpc.testnet.x1.xyz",
    explorerUrl: "https://explorer.x1.xyz",
    faucetUrl: "https://faucet.testnet.x1.xyz",
    limits: TESTNET_LIMITS,
  },
  localnet: {
    name: "localnet",
    rpcUrl: "http://127.0.0.1:8899",
    explorerUrl: "https://explorer.x1.xyz",
    faucetUrl: null,
    limits: LOCAL_LIMITS,
  },
};

/** Building against testnet is the default. Nobody should touch mainnet by accident. */
export const DEFAULT_CLUSTER: ClusterName = "testnet";

/**
 * Per-IP limits enforced by the public X1 RPC endpoints.
 *
 * These are the documented values, and they can change. Always trust the
 * `X-RateLimit-*` response headers over these numbers.
 */

/** Methods with a much tighter cap, because they are expensive to process. */
export const HEAVY_METHODS = new Set(["sendTransaction", "simulateTransaction"]);

export const NATIVE_SYMBOL = "XNT";
export const DECIMALS = 9;
export const LAMPORTS_PER_XNT = 1_000_000_000;

export type ClusterInput =
  | ClusterName
  | string
  | { rpcUrl: string; explorerUrl?: string; faucetUrl?: string | null; name?: string };

/**
 * Accepts a cluster name, an explicit RPC URL, or a full descriptor.
 */
export function resolveCluster(input?: ClusterInput): ClusterInfo {
  if (!input) return CLUSTERS[DEFAULT_CLUSTER];

  if (typeof input === "string") {
    if (input === "mainnet" || input === "testnet" || input === "localnet") {
      return CLUSTERS[input];
    }
    if (/^https?:\/\//i.test(input)) {
      return {
        name: "custom",
        rpcUrl: input,
        explorerUrl: CLUSTERS[DEFAULT_CLUSTER].explorerUrl,
        faucetUrl: null,
        limits: PUBLIC_LIMITS,
      };
    }
    throw new Error(
      `Unknown cluster "${input}". Use "mainnet", "testnet", "localnet", or a full RPC URL.`,
    );
  }

  return {
    name: input.name ?? "custom",
    rpcUrl: input.rpcUrl,
    explorerUrl: input.explorerUrl ?? CLUSTERS[DEFAULT_CLUSTER].explorerUrl,
    faucetUrl: input.faucetUrl ?? null,
    limits: PUBLIC_LIMITS,
  };
}

/** Explorer link helpers, so apps stop hand-building these strings. */
export function explorerTxUrl(cluster: ClusterInfo, signature: string): string {
  return `${cluster.explorerUrl.replace(/\/$/, "")}/tx/${signature}`;
}

export function explorerAddressUrl(cluster: ClusterInfo, address: string): string {
  return `${cluster.explorerUrl.replace(/\/$/, "")}/address/${address}`;
}
