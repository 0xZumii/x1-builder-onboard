const URL = "https://rpc.testnet.x1.xyz";
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] });

async function one() {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  await res.text();
  return res.status;
}

// N workers, each pulling from a shared queue of `total` requests.
async function run(total, concurrency) {
  let next = 0;
  const statuses = [];

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= total) return;
      statuses.push(await one());
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = Date.now() - started;
  const ok = statuses.filter((s) => s === 200).length;
  return { ok, total: statuses.length, elapsed, concurrency };
}

const results = [];
for (const concurrency of [3, 5, 8, 10, 12, 15]) {
  const result = await run(60, concurrency);
  results.push(result);
  console.log(
    `concurrency ${String(concurrency).padStart(2)}: ${result.ok}/${result.total} ok in ${result.elapsed}ms`,
  );
  await new Promise((r) => setTimeout(r, 6000));
}

console.log("\nbest clean concurrency:", Math.max(...results.filter((r) => r.ok === r.total).map((r) => r.concurrency)));
