import type { Commitment, Connection, PublicKey } from "@solana/web3.js";
import { PublicKey as PublicKeyClass } from "@solana/web3.js";

import { CLUSTERS } from "./constants.js";

/** The page users open. */
const FAUCET_PAGE = "https://faucet.testnet.x1.xyz";
/**
 * The endpoint the faucet frontend calls before it will submit. It is not
 * documented anywhere; it was read out of the page's bundle. That is exactly
 * why it is worth probing: when it 404s, the page is unusable.
 */
const FAUCET_HEALTH = "https://api.xen.network/v1/health/faucet";

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  detail: string;
}

export interface FaucetStatus {
  verdict: "up" | "down" | "unknown";
  page: ProbeResult;
  health: ProbeResult;
  faucetUrl: string;
  /** Human-readable reason it is down, e.g. "Cannot GET /v1/health/faucet". */
  reason: string;
}

/** Pulls the useful part out of an error body, which is usually JSON. */
export function summarizeProbe(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { message?: string };
    if (parsed?.message) return parsed.message;
  } catch {
    // not JSON
  }
  return detail.slice(0, 60);
}

async function probe(url: string): Promise<ProbeResult> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json, text/html;q=0.9" },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.text()).slice(0, 300).replace(/\s+/g, " ").trim();
    return { ok: response.ok, status: response.status, detail: body };
  } catch (error) {
    return { ok: false, status: null, detail: (error as Error).message };
  }
}

/**
 * Answers the only question a builder actually has: is this broken for
 * everyone, or am I doing it wrong?
 */
export async function checkFaucetStatus(): Promise<FaucetStatus> {
  const [page, health] = await Promise.all([probe(FAUCET_PAGE), probe(FAUCET_HEALTH)]);

  // The page will not submit unless health succeeds, so health decides.
  const verdict: FaucetStatus["verdict"] = health.ok ? "up" : "down";

  return {
    verdict,
    page,
    health,
    faucetUrl: FAUCET_PAGE,
    reason: health.ok ? "" : summarizeProbe(health.detail),
  };
}

export interface FundOptions {
  /** Amount in XNT. Default 2. */
  amountXnt?: number;
  commitment?: Commitment;
  /** Faucet to point at when the RPC refuses an airdrop. */
  faucetUrl?: string | null;
}

export interface FundResult {
  ok: boolean;
  signature?: string;
  lamports?: number;
  faucetUrl?: string | null;
  message: string;
}

/**
 * Tries a JSON-RPC airdrop, then explains what to do when the cluster
 * does not allow one.
 *
 * X1 disables `requestAirdrop` on testnet (it answers "Invalid request") and
 * funds wallets through a web faucet that is protected by reCAPTCHA. That is
 * not something a library should try to work around, so this reports the
 * situation accurately and hands over the address to paste into the browser.
 */
export async function fundFromFaucet(
  connection: Connection,
  address: PublicKey | string,
  options: FundOptions = {},
): Promise<FundResult> {
  const pubkey = typeof address === "string" ? new PublicKeyClass(address) : address;
  const amountXnt = options.amountXnt ?? 2;
  const lamports = Math.round(amountXnt * 1_000_000_000);

  const faucetUrl =
    options.faucetUrl !== undefined
      ? options.faucetUrl
      : connection.rpcEndpoint.includes("testnet")
        ? CLUSTERS.testnet.faucetUrl
        : null;

  try {
    const signature = await connection.requestAirdrop(pubkey, lamports);
    const latest = await connection.getLatestBlockhash(options.commitment ?? "confirmed");
    await connection.confirmTransaction({ signature, ...latest }, options.commitment ?? "confirmed");

    return {
      ok: true,
      signature,
      lamports,
      faucetUrl,
      message: `Airdropped ${amountXnt} XNT to ${pubkey.toBase58()}`,
    };
  } catch (error) {
    const reason = (error as Error)?.message?.split("\n")[0] ?? String(error);
    return {
      ok: false,
      faucetUrl,
      message:
        `The RPC does not allow programmatic airdrops (${reason}).\n` +
        (faucetUrl
          ? `X1 testnet funding requires the web faucet: ${faucetUrl}\n` +
            `  1. Paste this address: ${pubkey.toBase58()}\n` +
            `  2. Confirm with: x1 balance --address ${pubkey.toBase58()}\n\n` +
            `  Not sure whether it is you or the faucet? Run: x1 faucet --status\n` +
            `  If it is down, work locally: x1 localnet --reset, then airdrop there.`
          : `No public faucet is configured for this cluster.`),
    };
  }
}
