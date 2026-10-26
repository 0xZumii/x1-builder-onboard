const URL = process.argv[2] ?? "https://rpc.testnet.x1.xyz";
const body = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "getSlot", params: [] });

async function one(id) {
  const started = Date.now();
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(id),
  });
  const text = await res.text();
  return {
    status: res.status,
    ms: Date.now() - started,
    retryAfter: res.headers.get("retry-after"),
    rate: res.headers.get("x-ratelimit-rate-short"),
    limit: res.headers.get("x-ratelimit-limit-short"),
    conn: res.headers.get("x-conn-current"),
    connLimit: res.headers.get("x-conn-limit"),
    text: text.slice(0, 160),
  };
}

const summarize = (label, results) => {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  console.log(`${label}: ${JSON.stringify(counts)}`);
  const bad = results.find((r) => r.status !== 200);
  if (bad) console.log(`   first failure: ${JSON.stringify(bad)}`);
  const last = results[results.length - 1];
  if (last) console.log(`   last: rate=${last.rate}/${last.limit} conn=${last.conn}/${last.connLimit}`);
};

console.log(`\n${URL}\n`);

summarize("1 request        ", [await one(1)]);

const sequential = [];
for (let i = 0; i < 10; i += 1) {
  sequential.push(await one(i));
  await new Promise((r) => setTimeout(r, 100));
}
summarize("10 sequential @10/s", sequential);

for (const concurrency of [5, 15, 30]) {
  const results = await Promise.all(Array.from({ length: concurrency }, (_, i) => one(i)));
  summarize(`${String(concurrency).padStart(2)} concurrent     `, results);
  await new Promise((r) => setTimeout(r, 1500));
}
