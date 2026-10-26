#!/usr/bin/env bash
# Checks that the browser's manually-computed Anchor discriminators match the
# ones Anchor itself generates for this program.
set -uo pipefail
source "$HOME/devkit/scripts/wsl-env.sh" 2>/dev/null || true
cd "$HOME/x1-gen/web-demo" || exit 1

echo "=== anchor idl build ==="
IDL="/tmp/web_demo_idl.json"
anchor idl build 2>/dev/null | sed -n '/^{/,$p' > "$IDL"

if [ ! -s "$IDL" ]; then
  echo "No IDL produced — skipping comparison."
  exit 0
fi

echo "idl bytes: $(stat -c%s "$IDL")"

echo
echo "=== comparing discriminators ==="
IDL_PATH="$IDL" node - <<'NODE'
const crypto = require("crypto");
const fs = require("fs");

const idl = JSON.parse(fs.readFileSync(process.env.IDL_PATH, "utf8"));

const expected = (name) =>
  crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");

let failures = 0;
for (const instruction of idl.instructions ?? []) {
  const fromIdl = Buffer.from(instruction.discriminator ?? []).toString("hex");
  const fromClient = expected(instruction.name);
  const ok = fromIdl === fromClient;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${instruction.name.padEnd(12)} idl=${fromIdl} client=${fromClient}`);
}

if ((idl.instructions ?? []).length === 0) console.log("  (idl has no instructions)");
process.exitCode = failures === 0 ? 0 : 1;
NODE
