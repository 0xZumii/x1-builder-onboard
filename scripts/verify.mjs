/**
 * Verification for @x1/kit.
 *
 * Unit checks run offline; the live checks hit the public X1 testnet RPC.
 * Run with: node scripts/verify.mjs
 */
import { Throttle, createX1Connection, batchRpc, parseRateLimitHeaders } from "../packages/kit/dist/index.js";

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
}

console.log("\nOffline: sliding window");

{
  // 5 requests per 1s. 12 requests must take at least two extra windows.
  const throttle = new Throttle({
    shortWindowMs: 1000,
    shortCap: 5,
    longWindowMs: 3_600_000,
    longCap: 1_000_000,
    heavyWindowMs: 1000,
    heavyCap: 5,
    maxConcurrent: 100,
  });

  const startedAt = Date.now();
  for (let i = 0; i < 12; i += 1) {
    const release = await throttle.acquire(false);
    release();
  }
  const elapsed = Date.now() - startedAt;
  check("cap of 5/1s is enforced", elapsed >= 1900, `${elapsed}ms for 12 requests`);
  check("throttle does not overshoot the window", elapsed < 4000, `${elapsed}ms`);
}

{
  // Adaptive adoption should not accept junk values.
  const throttle = new Throttle();
  const before = throttle.stats().limits.shortCap;
  throttle.adopt({ shortCap: 0, longCap: Number.NaN, maxConcurrent: -3 });
  check("adopt rejects non-positive limits", throttle.stats().limits.shortCap === before);

  throttle.adopt({ shortCap: 400, maxConcurrent: 15 });
  const after = throttle.stats().limits;
  check("adopt applies real limits", after.shortCap === 400 && after.maxConcurrent === 15);
}

{
  // Concurrency cap: 8 slots, 20 tasks, each holding for 50ms.
  const throttle = new Throttle({
    shortWindowMs: 1000,
    shortCap: 10_000,
    longWindowMs: 3_600_000,
    longCap: 1_000_000,
    heavyWindowMs: 1000,
    heavyCap: 10_000,
    maxConcurrent: 8,
  });

  let peak = 0;
  let active = 0;
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      const release = await throttle.acquire(false);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 50));
      active -= 1;
      release();
    }),
  );
  check("concurrency cap holds", peak <= 8, `peak ${peak} of 8`);

  // Regression guard: the counter used to drift up on every slot handoff,
  // which silently throttled the client to a crawl.
  const after = throttle.stats();
  check("slots are fully released", after.inFlight === 0 && after.queued === 0, `inFlight ${after.inFlight}`);
}

console.log("\nLive: X1 testnet");

{
  const connection = createX1Connection({ cluster: "testnet" });
  const startedAt = Date.now();
  const count = 60;

  const results = await Promise.allSettled(
    Array.from({ length: count }, () => connection.getSlot()),
  );

  const rejected = results.filter((result) => result.status === "rejected");
  const elapsed = Date.now() - startedAt;
  const stats = connection.x1.stats();

  check(
    `${count} concurrent getSlot calls all succeed`,
    rejected.length === 0,
    `${elapsed}ms, ${rejected.length} failed`,
  );
  check(
    "client learned the endpoint limits from headers",
    stats.limits.shortCap === 400 && stats.limits.maxConcurrent === 12,
    `${stats.limits.shortCap}/5s, ${stats.limits.maxConcurrent} conn`,
  );
  check("nothing is still queued", stats.queued === 0 && stats.inFlight === 0);
}

{
  const connection = createX1Connection({ cluster: "testnet" });
  const entries = await batchRpc(connection.rpcEndpoint, [
    { method: "getSlot" },
    { method: "getBlockHeight" },
    { method: "getVersion" },
    { method: "getHealth" },
  ]);

  check("batchRpc returns one entry per call", entries.length === 4);
  check("batchRpc entries are successful", entries.every((entry) => entry.error === undefined));
  check("batchRpc results are populated", entries[0]?.result > 0, `slot ${entries[0]?.result}`);
}

{
  // An explicit concurrency choice must survive header adoption.
  const connection = createX1Connection({ cluster: "testnet", limits: { maxConcurrent: 3 } });
  await connection.getSlot();
  const stats = connection.x1.stats();
  check("explicit concurrency is pinned", stats.limits.maxConcurrent === 3, `${stats.limits.maxConcurrent}`);
}

{
  // Header parsing, straight from a synthetic Headers object.
  const headers = new Headers({
    "x-ratelimit-rate-short": "12",
    "x-ratelimit-limit-short": "300",
    "x-ratelimit-reset-short": "5s",
    "x-ratelimit-limit-long": "150000",
    "x-ratelimit-reset-long": "1h",
    "x-conn-limit": "30",
  });
  const info = parseRateLimitHeaders(200, headers);
  check("parses short window", info.shortLimit === 300 && info.shortWindowMs === 5000);
  check("parses hour window", info.longWindowMs === 3_600_000);
  check("leaves absent headers undefined", info.heavyLimit === undefined);
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
