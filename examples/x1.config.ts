import { defineConfig } from "@x1/kit";

/**
 * Example configuration. Copy to your project root as `x1.config.ts`
 * (or `x1.config.json` if you are on Node < 22.6).
 */
export default defineConfig({
  cluster: "testnet",
  wallet: "~/.config/solana/id.json",
  program: {
    name: "my_program",
    keypair: "target/deploy/my_program-keypair.json",
  },
  // Leave room for other services sharing the same IP.
  // limits: { maxConcurrent: 5 },
  priorityFee: "auto",
});
