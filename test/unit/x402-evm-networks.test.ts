import { describe, it, expect } from "vitest";
import { verifyTypedData } from "viem";
import { createPaymentPayload, EVM_NETWORKS, evmNetwork } from "../../src/x402";
import { TEST_PRIVATE_KEY, TEST_ACCOUNT, TEST_RECIPIENT } from "../helpers/testHelpers";

/**
 * The EIP-712 domain a payment is signed against follows the 402's `network`.
 *
 * Until 3.16.0 the domain was one constant — Base's USDC ("USD Coin" v2,
 * chainId 8453, 0x8335…) — whatever the 402 said, and `accepted.asset` was
 * always Base's USDC. Against arc.blockrun.ai (eip155:5042, USDC at 0x3600…,
 * domain name "USDC") every payment was a signature over the wrong domain:
 * the facilitator recovers a different signer and answers 401, after the SDK
 * has told the caller it paid. Same for testnet.blockrun.ai (Base Sepolia).
 *
 * The 402 still may not supply the domain: `extra` from a server is never
 * trusted (a hostile 402 could otherwise steer a signature onto another
 * contract). It selects a network from this allowlist, and the SDK's own
 * values for that network are signed. An unknown network is refused; a 402
 * whose `asset` is not that network's USDC is refused.
 */
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

async function signAndDecode(network: string, options = {}) {
  const payload = await createPaymentPayload(
    TEST_PRIVATE_KEY,
    TEST_ACCOUNT.address,
    TEST_RECIPIENT,
    "2000",
    network,
    options,
  );
  return JSON.parse(atob(payload));
}

async function verifiesAgainst(decoded: any, domain: (typeof EVM_NETWORKS)[string]["domain"]) {
  const a = decoded.payload.authorization;
  return verifyTypedData({
    address: TEST_ACCOUNT.address,
    domain,
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
    signature: decoded.payload.signature,
  });
}

describe("the signed domain follows the 402's network", () => {
  it("knows Arc, Base and Base Sepolia, each with its own USDC and domain name", () => {
    expect(evmNetwork("eip155:5042")).toMatchObject({
      chainId: 5042,
      usdc: "0x3600000000000000000000000000000000000000",
      domain: { name: "USDC", version: "2", chainId: 5042 },
    });
    expect(evmNetwork("eip155:8453")).toMatchObject({
      chainId: 8453,
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      domain: { name: "USD Coin", version: "2", chainId: 8453 },
    });
    expect(evmNetwork("eip155:84532")).toMatchObject({ chainId: 84532, domain: { name: "USDC" } });
  });

  it("signs an Arc payment against Arc's USDC domain — and NOT Base's", async () => {
    const decoded = await signAndDecode("eip155:5042");
    expect(await verifiesAgainst(decoded, EVM_NETWORKS["eip155:5042"].domain)).toBe(true);
    expect(await verifiesAgainst(decoded, EVM_NETWORKS["eip155:8453"].domain)).toBe(false);
    expect(decoded.accepted.network).toBe("eip155:5042");
    expect(decoded.accepted.asset).toBe("0x3600000000000000000000000000000000000000");
    expect(decoded.accepted.extra).toEqual({ name: "USDC", version: "2" });
  });

  it("still signs a Base payment exactly as before", async () => {
    const decoded = await signAndDecode("eip155:8453");
    expect(await verifiesAgainst(decoded, EVM_NETWORKS["eip155:8453"].domain)).toBe(true);
    expect(decoded.accepted.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(decoded.accepted.extra).toEqual({ name: "USD Coin", version: "2" });
  });

  it("refuses a network it does not know rather than signing Base's domain for it", async () => {
    await expect(signAndDecode("eip155:1")).rejects.toThrow(/eip155:1/);
    await expect(signAndDecode("eip155:1")).rejects.toThrow(/eip155:5042/); // names what it does know
  });

  it("refuses a 402 whose asset is not that network's USDC", async () => {
    await expect(
      signAndDecode("eip155:5042", { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }),
    ).rejects.toThrow(/asset/i);
    // Case-insensitive on the address; the gateway checksums, wallets often do not.
    const ok = await signAndDecode("eip155:5042", { asset: "0x3600000000000000000000000000000000000000".toLowerCase() });
    expect(ok.accepted.asset).toBe("0x3600000000000000000000000000000000000000");
  });

  it("ignores a 402's extra for the domain — the allowlist's values are signed", async () => {
    const decoded = await signAndDecode("eip155:5042", { extra: { name: "USD Coin", version: "9" } });
    expect(await verifiesAgainst(decoded, EVM_NETWORKS["eip155:5042"].domain)).toBe(true);
    expect(decoded.accepted.extra).toEqual({ name: "USDC", version: "2" });
  });
});
