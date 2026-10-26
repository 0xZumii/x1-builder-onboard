import { createX1Connection } from "../packages/kit/dist/index.js";

const retries = [];
const rateLimits = [];

const connection = createX1Connection({
  cluster: "testnet",
  onRetry: (info) => retries.push(info),
  onRateLimit: (info) => rateLimits.push(info),
});

const started = Date.now();
await Promise.all(Array.from({ length: 60 }, () => connection.getSlot()));

console.log(`total ${Date.now() - started}ms`);
console.log(`\nRPC calls observed: ${rateLimits.length}`);
console.log(`429s: ${rateLimits.filter((r) => r.status === 429).length}`);
console.log(`retries: ${retries.length}`);
for (const r of retries.slice(0, 10)) {
  console.log(`  #${r.attempt} ${r.method} ${r.reason} delay=${r.delayMs}ms`);
}
console.log("\nfinal:", JSON.stringify(connection.x1.stats().limits));
