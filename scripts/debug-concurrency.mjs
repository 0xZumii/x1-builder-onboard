import { createX1Connection } from "../packages/kit/dist/index.js";

const connection = createX1Connection({ cluster: "testnet" });
const total = 60;
let done = 0;

console.log("limits:", JSON.stringify(connection.x1.stats().limits));

const started = Date.now();
const timings = [];

await Promise.all(
  Array.from({ length: total }, async (_, i) => {
    const t = Date.now();
    await connection.getSlot();
    timings.push(Date.now() - t);
    done += 1;
    if (done % 15 === 0) {
      const s = connection.x1.stats();
      console.log(
        `  ${String(done).padStart(2)} done @ ${Date.now() - started}ms  ` +
          `inFlight=${s.inFlight} queued=${s.queued} short=${s.short} paused=${s.pausedForMs}`,
      );
    }
  }),
);

timings.sort((a, b) => a - b);
console.log(`\ntotal ${Date.now() - started}ms`);
console.log(`latency p50=${timings[Math.floor(total * 0.5)]}ms p95=${timings[Math.floor(total * 0.95)]}ms max=${timings[total - 1]}ms`);
console.log("final stats:", JSON.stringify(connection.x1.stats()));
