import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  root: "web",
  plugins: [
    // @solana/web3.js expects Node globals in the browser.
    nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
  ],
  server: { port: 5173 },
});
