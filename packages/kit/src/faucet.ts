import type { Commitment, Connection, PublicKey } from "@solana/web3.js";
import { PublicKey as PublicKeyClass } from "@solana/web3.js";

import { CLUSTERS } from "./constants.js";

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
            `  If the faucet shows "Cannot GET /v1/health/faucet", the faucet service\n` +
            `  itself is down (its frontend checks that route before submitting).\n` +
            `  Report it in https://t.me/x1_builders rather than retrying.`
          : `No public faucet is configured for this cluster.`),
    };
  }
}
