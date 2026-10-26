import type { FetchLike, RateLimitInfo } from "./fetch.js";

export interface RpcCall {
  method: string;
  params?: unknown[];
}

export interface RpcBatchEntry<T> {
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface BatchOptions {
  fetch?: FetchLike;
  /** Passed through to the `onRateLimit` observer, if you have one. */
  onRateLimit?: (info: RateLimitInfo) => void;
}

/**
 * Sends many JSON-RPC calls in one HTTP request.
 *
 * The docs recommend batching to stay inside the 300 req / 5s window, and
 * batching also cuts connection churn on a 30-connection cap.
 */
export async function batchRpc<T = unknown>(
  rpcUrl: string,
  calls: RpcCall[],
  options: BatchOptions = {},
): Promise<RpcBatchEntry<T>[]> {
  if (calls.length === 0) return [];

  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const payload = calls.map((call, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: call.method,
    params: call.params ?? [],
  }));

  const response = await doFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`RPC batch failed with HTTP ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as unknown;

  // Some endpoints only support batching behind a flag and answer a single error.
  if (Array.isArray(body)) return body as RpcBatchEntry<T>[];

  const single = body as { error?: { code: number; message: string; data?: unknown } };
  throw new Error(
    `RPC endpoint did not accept a batch request${single.error ? `: ${single.error.message}` : ""}. ` +
      `Send the calls individually instead.`,
  );
}
