// Self-contained E2E probe for POST /v1/polymarket/fund.
//
//   GATEWAY=https://canary---blockrun-web-XXXX.run.app AMOUNT_USD=0.10 \
//     node scripts/probe-polymarket-fund.mjs
//
// Exercises the ENTIRE gateway path (402 fee dance, amount-binding, bridge
// validation, deposit settle with on-chain confirmation, fee settle, recon)
// with a tiny amount. The gateway is sig-type-agnostic — it only checks that
// `recipient` is the Polymarket bridge address for `depositWallet` — so we use
// the funded EOA itself as the deposit wallet (no relayer creds / no `setup`).
// Non-custodial: the USDC settles Base→bridge for this wallet's own vault.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { BlockrunClient, createPaymentPayload } from "@blockrun/llm";

const GATEWAY = process.env.GATEWAY || "https://blockrun.ai";
const AMOUNT_USD = Number(process.env.AMOUNT_USD || "0.10");
const BRIDGE_HOST = process.env.POLYMARKET_BRIDGE_HOST || "https://bridge.polymarket.com";
const USDC_DECIMALS = 6;
const BASE_CHAIN_ID = 8453;

const key = readFileSync(join(homedir(), ".blockrun", ".session"), "utf8").trim();
const account = privateKeyToAccount(key);
const agent = account.address;
const depositWallet = agent; // EOA = its own deposit wallet for this probe

async function bridgeAddressFor(addr) {
  const res = await fetch(`${BRIDGE_HOST}/deposit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: addr }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`bridge /deposit ${res.status}`);
  const data = await res.json();
  const evm = data?.address?.evm;
  if (!evm) throw new Error(`bridge returned no evm address: ${JSON.stringify(data)}`);
  return evm;
}

async function main() {
  console.log(`\n=== Polymarket fund probe → ${GATEWAY} — $${AMOUNT_USD.toFixed(2)} ===\n`);
  console.log(`agent / depositWallet: ${agent}`);

  const bridge = await bridgeAddressFor(depositWallet);
  console.log(`bridge recipient:      ${bridge}`);

  const amountMicro = String(Math.floor(AMOUNT_USD * 10 ** USDC_DECIMALS));
  const depositAuthorization = await createPaymentPayload(
    key,
    agent,
    bridge,
    amountMicro,
    `eip155:${BASE_CHAIN_ID}`
  );
  console.log(`signed deposit auth (amountMicro=${amountMicro})`);

  const client = new BlockrunClient({ privateKey: key, apiUrl: `${GATEWAY}/api` });
  console.log(`\nPOST ${GATEWAY}/api/v1/polymarket/fund …`);
  const t0 = Date.now();
  let result;
  try {
    result = await client.post("/v1/polymarket/fund", {
      depositWallet,
      recipient: bridge,
      amountMicro,
      depositAuthorization,
    });
  } catch (e) {
    console.error(`\n❌ ${e?.status ?? ""} ${e?.message ?? e}`);
    if (e?.body) console.error(typeof e.body === "string" ? e.body : JSON.stringify(e.body, null, 2));
    process.exit(1);
  }
  console.log(`\n← ${Date.now() - t0}ms`);
  console.log(JSON.stringify(result, null, 2));

  if (!result?.success) {
    console.error(`\n❌ FUND FAILED: ${result?.error ?? "no success flag"}`);
    process.exit(1);
  }
  console.log(`\n✅ deposit tx: https://basescan.org/tx/${result.deposit?.txHash}`);
  console.log(`   fee tx:     https://basescan.org/tx/${result.fee?.txHash}`);
}

main();
