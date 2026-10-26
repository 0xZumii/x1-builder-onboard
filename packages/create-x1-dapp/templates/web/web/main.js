import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

// Points at `x1 localnet` by default, where airdrops work. Switch to
// https://rpc.testnet.x1.xyz with VITE_X1_RPC when the testnet faucet is back.
const RPC = import.meta.env.VITE_X1_RPC ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("__PROGRAM_ID__");

// 8-byte discriminator + pubkey authority + u64 count
const COUNT_OFFSET = 8 + 32;
const COUNTER_SIZE = 8 + 32 + 8;
const STORAGE_KEY = "x1-counter:__PROGRAM__";

const connection = new Connection(RPC, "confirmed");
const $ = (id) => document.getElementById(id);

let provider = null;
let wallet = null;
let counter = null;

const stored = localStorage.getItem(STORAGE_KEY);
if (stored) counter = new PublicKey(stored);

// X1 Wallet, Backpack and Phantom each expose a different global.
function findProvider() {
  return window.x1 ?? window.backpack ?? window.phantom?.solana ?? window.solana ?? null;
}

function log(message, kind = "") {
  const line = document.createElement("div");
  if (kind) line.className = kind;
  line.textContent = message;
  $("log").prepend(line);
}

function shorten(value) {
  const text = value.toString();
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

async function discriminator(name) {
  const bytes = new TextEncoder().encode(`global:${name}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash).slice(0, 8);
}

async function send(instructions, extraSigners = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(...instructions);
  tx.feePayer = wallet;
  tx.recentBlockhash = blockhash;

  for (const signer of extraSigners) tx.partialSign(signer);

  const signed = await provider.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

function render() {
  const connected = Boolean(wallet);
  $("connect").textContent = connected ? `Connected ${shorten(wallet)}` : "Connect wallet";
  $("wallet").textContent = connected ? wallet.toBase58() : "not connected";
  $("account").textContent = counter ? counter.toBase58() : "not created";
  $("refresh").disabled = !connected;
  $("initialize").disabled = !connected;
  $("increment").disabled = !connected || !counter;
}

async function refreshCount() {
  if (!counter) {
    $("count").textContent = "—";
    return;
  }

  const info = await connection.getAccountInfo(counter);
  if (!info) {
    $("count").textContent = "—";
    log("counter account not found on this cluster yet", "bad");
    return;
  }
  if (!info.owner.equals(PROGRAM_ID)) {
    $("count").textContent = "—";
    log(`account is owned by ${info.owner.toBase58()}, not this program`, "bad");
    return;
  }

  const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  $("count").textContent = view.getBigUint64(COUNT_OFFSET, true).toString();
}

$("connect").addEventListener("click", async () => {
  try {
    provider = findProvider();
    if (!provider) {
      log("No wallet found. Install X1 Wallet, Backpack or Phantom.", "bad");
      return;
    }
    const result = await provider.connect();
    wallet = new PublicKey(result.publicKey ?? provider.publicKey);
    log(`connected ${shorten(wallet)}`);
    render();
    await refreshCount();
  } catch (error) {
    log(`connect failed: ${error.message}`, "bad");
  }
});

$("refresh").addEventListener("click", () => {
  refreshCount().catch((error) => log(`refresh failed: ${error.message}`, "bad"));
});

$("initialize").addEventListener("click", async () => {
  try {
    const counterKeypair = Keypair.generate();
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      data: await discriminator("initialize"),
      keys: [
        { pubkey: counterKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });

    log("initializing…");
    const signature = await send([instruction], [counterKeypair]);

    counter = counterKeypair.publicKey;
    localStorage.setItem(STORAGE_KEY, counter.toBase58());
    log(`initialized · ${signature}`, "ok");
    render();
    await refreshCount();
  } catch (error) {
    log(`initialize failed: ${error.message}`, "bad");
  }
});

$("increment").addEventListener("click", async () => {
  try {
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      data: await discriminator("increment"),
      keys: [
        { pubkey: counter, isSigner: false, isWritable: true },
        { pubkey: wallet, isSigner: true, isWritable: false },
      ],
    });

    log("incrementing…");
    const signature = await send([instruction]);
    log(`incremented · ${signature}`, "ok");
    await refreshCount();
  } catch (error) {
    log(`increment failed: ${error.message}`, "bad");
  }
});

$("rpc").textContent = RPC;
render();
log(`program ${PROGRAM_ID.toBase58()}`);
log(`rpc ${RPC}`);
