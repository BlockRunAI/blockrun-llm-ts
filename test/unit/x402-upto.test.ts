import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hashTypedData, maxUint256, verifyTypedData } from "viem";
import {
  EIP2612_PERMIT_TYPES,
  PERMIT2_ADDRESS,
  UPTO_PERMIT2_WITNESS_TYPES,
  X402_UPTO_PERMIT2_PROXY_ADDRESS,
  bookedCost,
  createEvmPayment,
  createPermit2Nonce,
  assertPermitMatchesPermitted,
  createUptoPaymentPayload,
  findUptoRequirement,
  planUpto,
  signEip2612GasSponsoringPermit,
  parseSettledAmount,
  resolvePaymentScheme,
  type UptoRequirement,
} from "../../src/x402-upto";
import { EVM_NETWORKS, USDC_BASE, USDC_ARC, extractPaymentDetails } from "../../src/x402";
import { evmRpcUrls } from "../../src/evm-rpc";
import type { PaymentRequired } from "../../src/types";
import { TEST_PRIVATE_KEY, TEST_ACCOUNT, TEST_RECIPIENT } from "../helpers/testHelpers";

/**
 * Vectors computed with the OFFICIAL client, @x402/evm 2.28.0
 * (`new UptoEvmScheme(signer).createPaymentPayload(2, requirements, ctx)`),
 * with Date.now() pinned to 1_790_000_000_000, crypto.getRandomValues filling
 * 0x11, the Hardhat #0 key, and a signer whose readContract answers
 * allowance=0 / nonces=7 with ctx.extensions = { eip2612GasSponsoring: {} }
 * (default approvalAmount: the permit value is the ceiling, as the proxy
 * requires — see assertPermitMatchesPermitted).
 * If this SDK's typed data drifts from the reference by one field, one type
 * name or one address, the signatures below stop matching.
 */
const FACILITATOR = "0x97AcCe27D5069544480BDe0F04D9F47d7422a016";
const REF_NOW_SECONDS = 1_790_000_000;
const REF_NONCE = "7719472615821079694904732333912527190217998977709370935963838933860875309329";
const REF = {
  payload: {
    signature:
      "0xfcbe7f693d1ca66012986d2a1aa2b8f75cd62f4e847af54ab6e421e99a1c352a33b3db7fbb03717edbb6fe541f6c49320e60c8656b417013f7acc6b678670dad1c",
    permit2Authorization: {
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      permitted: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "12345" },
      spender: "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002",
      nonce: REF_NONCE,
      deadline: "1790000300",
      witness: {
        to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        facilitator: FACILITATOR,
        validAfter: "0",
      },
    },
  },
  eip2612GasSponsoring: {
    info: {
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      amount: "12345",
      nonce: "7",
      deadline: "1790000300",
      signature:
        "0x9a0ca3482539196127ebe253192efcc05e9548a5ab8df649a84f21b4a40f4d413e9e15ab5f16a8958122b829cbfe4044e2cda16d88f23932d0af9c3cfcf248af1c",
      version: "1",
    },
  },
  digest: "0xdd2a026392d1b847625a1d56cb946fff1e1e2ee8307557d06ee1ece992363397",
  permitDigest: "0xd9a7d20da6657721c11f4eabfe34e5d54c4083550394b346cca69c63209c9881",
};

const BASE = "eip155:8453";
const RPC = "https://rpc.test";

function uptoOption(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "upto",
    network: BASE,
    amount: "12345",
    asset: USDC_BASE,
    payTo: TEST_RECIPIENT,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2", facilitatorAddress: FACILITATOR },
    ...overrides,
  };
}

function exactOption(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: BASE,
    amount: "5000",
    asset: USDC_BASE,
    payTo: TEST_RECIPIENT,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
    ...overrides,
  };
}

function required(
  accepts: Array<Record<string, unknown>>,
  extensions?: Record<string, unknown>,
): PaymentRequired {
  return {
    x402Version: 2,
    accepts: accepts as unknown as PaymentRequired["accepts"],
    resource: { url: "https://blockrun.ai/api/v1/chat/completions", description: "chat" },
    ...(extensions ? { extensions } : {}),
  };
}

const GAS = { eip2612GasSponsoring: { info: { description: "server declaration" }, schema: {} } };

function word(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

/**
 * A JSON-RPC batch endpoint answering balanceOf / allowance / nonces by
 * selector, recording each batch it saw.
 */
function mockRpc(state: { balance?: bigint; allowance?: bigint; nonce?: bigint }) {
  const batches: Array<Array<{ id: number; params: [{ to: string; data: string }, string] }>> = [];
  const spy = vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const batch = JSON.parse(String(init?.body));
    batches.push(batch);
    const out = batch.map((call: { id: number; params: [{ data: string }] }) => {
      const selector = call.params[0].data.slice(0, 10);
      const value =
        selector === "0x70a08231" ? state.balance ?? 10n ** 12n
        : selector === "0xdd62ed3e" ? state.allowance ?? 0n
        : selector === "0x7ecebe00" ? state.nonce ?? 0n
        : undefined;
      return value === undefined
        ? { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "unknown" } }
        : { jsonrpc: "2.0", id: call.id, result: word(value) };
    });
    return new Response(JSON.stringify(out), { status: 200 });
  });
  return { spy, batches };
}

function decode(b64: string) {
  return JSON.parse(atob(b64));
}

async function pay(pr: PaymentRequired, opts: { paymentScheme?: "exact" | "auto"; rpcUrls?: string[] } = {}) {
  return createEvmPayment(TEST_PRIVATE_KEY, TEST_ACCOUNT.address, pr, {
    resourceUrl: "https://blockrun.ai/api/v1/chat/completions",
    resourceDescription: "chat",
    paymentScheme: opts.paymentScheme,
    rpcUrls: opts.rpcUrls ?? [RPC],
  });
}

const baseUpto = (): UptoRequirement => findUptoRequirement(required([uptoOption()]), BASE)!;

describe("upto Permit2 signing matches @x402/evm 2.28.0", () => {
  it("constants match the reference", () => {
    expect(PERMIT2_ADDRESS).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    expect(X402_UPTO_PERMIT2_PROXY_ADDRESS).toBe("0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002");
  });

  it("createPermit2Nonce is the random 32 bytes as a decimal uint256", () => {
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(arr: T) => {
      (arr as unknown as Uint8Array).fill(0x11);
      return arr;
    });
    expect(createPermit2Nonce()).toBe(REF_NONCE);
  });

  it("the permit2Authorization and its signature are byte-identical to the reference", async () => {
    const decoded = decode(
      await createUptoPaymentPayload(TEST_PRIVATE_KEY, TEST_ACCOUNT.address, baseUpto(), {
        permit2Nonce: REF_NONCE,
        nowSeconds: REF_NOW_SECONDS,
      }),
    );
    expect(decoded.payload).toEqual(REF.payload);
  });

  it("the typed-data digest equals the reference digest and recovers the payer", async () => {
    const decoded = decode(
      await createUptoPaymentPayload(TEST_PRIVATE_KEY, TEST_ACCOUNT.address, baseUpto(), {
        permit2Nonce: REF_NONCE,
        nowSeconds: REF_NOW_SECONDS,
      }),
    );
    const a = decoded.payload.permit2Authorization;
    const typed = {
      domain: { name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS },
      types: UPTO_PERMIT2_WITNESS_TYPES,
      primaryType: "PermitWitnessTransferFrom" as const,
      message: {
        permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) },
        spender: a.spender,
        nonce: BigInt(a.nonce),
        deadline: BigInt(a.deadline),
        witness: { to: a.witness.to, facilitator: a.witness.facilitator, validAfter: BigInt(a.witness.validAfter) },
      },
    };
    expect(hashTypedData(typed)).toBe(REF.digest);
    expect(
      await verifyTypedData({ address: TEST_ACCOUNT.address, ...typed, signature: decoded.payload.signature }),
    ).toBe(true);
  });

  it("the EIP-2612 gas-sponsoring permit is byte-identical to the reference", async () => {
    const decoded = decode(
      await createUptoPaymentPayload(TEST_PRIVATE_KEY, TEST_ACCOUNT.address, baseUpto(), {
        permit2Nonce: REF_NONCE,
        nowSeconds: REF_NOW_SECONDS,
        gasSponsoringTokenNonce: 7n,
      }),
    );
    expect(decoded.extensions.eip2612GasSponsoring).toEqual(REF.eip2612GasSponsoring);
    const g = decoded.extensions.eip2612GasSponsoring.info;
    expect(
      hashTypedData({
        domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: g.asset },
        types: EIP2612_PERMIT_TYPES,
        primaryType: "Permit",
        message: { owner: g.from, spender: g.spender, value: BigInt(g.amount), nonce: BigInt(g.nonce), deadline: BigInt(g.deadline) },
      }),
    ).toBe(REF.permitDigest);
  });

  it("the envelope mirrors exact's, with scheme upto and the facilitator in accepted.extra", async () => {
    const decoded = decode(
      await createUptoPaymentPayload(TEST_PRIVATE_KEY, TEST_ACCOUNT.address, baseUpto(), {
        resourceUrl: "https://blockrun.ai/api/v1/chat/completions",
        resourceDescription: "chat",
        extensions: { bazaar: { x: 1 }, ...GAS },
      }),
    );
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource).toEqual({
      url: "https://blockrun.ai/api/v1/chat/completions",
      description: "chat",
      mimeType: "application/json",
    });
    expect(decoded.accepted).toEqual({
      scheme: "upto",
      network: BASE,
      amount: "12345",
      asset: USDC_BASE,
      payTo: TEST_RECIPIENT,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2", facilitatorAddress: FACILITATOR },
    });
    // Server extensions echo like exact's, builder code is added, and the
    // server's gas-sponsoring DECLARATION is not echoed back as if it were a permit.
    expect(decoded.extensions.bazaar).toEqual({ x: 1 });
    expect(decoded.extensions["builder-code"].info.s).toEqual(["blockrun"]);
    expect(decoded.extensions.eip2612GasSponsoring).toBeUndefined();
  });

  it("deadline = now + maxTimeoutSeconds, validAfter = 0", async () => {
    const upto = findUptoRequirement(required([uptoOption({ maxTimeoutSeconds: 90 })]), BASE)!;
    const decoded = decode(
      await createUptoPaymentPayload(TEST_PRIVATE_KEY, TEST_ACCOUNT.address, upto, { nowSeconds: 1000 }),
    );
    expect(decoded.payload.permit2Authorization.deadline).toBe("1090");
    expect(decoded.payload.permit2Authorization.witness.validAfter).toBe("0");
  });
});

describe("findUptoRequirement", () => {
  it("accepts a well-formed option (v2 amount or v1 maxAmountRequired)", () => {
    expect(findUptoRequirement(required([exactOption(), uptoOption()]), BASE)?.amount).toBe("12345");
    const v1 = uptoOption({ amount: undefined, maxAmountRequired: "777" });
    expect(findUptoRequirement(required([v1]), BASE)?.amount).toBe("777");
  });

  it.each([
    ["no extra.facilitatorAddress", uptoOption({ extra: { name: "USD Coin", version: "2" } })],
    ["a non-address facilitator", uptoOption({ extra: { facilitatorAddress: "nope" } })],
    ["another network than exact's", uptoOption({ network: "eip155:84532" })],
    ["an asset that is not the network's USDC", uptoOption({ asset: "0x0000000000000000000000000000000000000001" })],
    ["a zero amount", uptoOption({ amount: "0" })],
    ["a non-integer amount", uptoOption({ amount: "1.5" })],
    ["a non-address payTo", uptoOption({ payTo: "bob" })],
  ])("rejects %s", (_label, opt) => {
    expect(findUptoRequirement(required([exactOption(), opt]), BASE)).toBeNull();
  });

  it("rejects networks the SDK has no domain for", () => {
    expect(findUptoRequirement(required([uptoOption({ network: "eip155:1" })]), "eip155:1")).toBeNull();
  });
});

describe("extractPaymentDetails prefers the exact option", () => {
  it("picks exact even when upto is listed first", () => {
    const d = extractPaymentDetails(required([uptoOption(), exactOption()]));
    expect(d.scheme).toBe("exact");
    expect(d.amount).toBe("5000");
  });

  it("is unchanged for an exact-only 402 and for a network preference", () => {
    expect(extractPaymentDetails(required([exactOption()])).amount).toBe("5000");
    const sol = exactOption({ network: "solana:x", amount: "9" });
    expect(extractPaymentDetails(required([exactOption(), uptoOption(), sol]), "solana:x").amount).toBe("9");
  });

  it("falls back to the first option when none says exact (as before)", () => {
    expect(extractPaymentDetails(required([uptoOption()])).scheme).toBe("upto");
  });
});

describe("createEvmPayment selection policy", () => {
  afterEach(() => {
    delete process.env.BLOCKRUN_PAYMENT_SCHEME;
  });

  it("paymentScheme 'exact' signs exact and never touches the RPC", async () => {
    const { spy } = mockRpc({ allowance: 10n ** 12n });
    const signed = await pay(required([exactOption(), uptoOption()], GAS), { paymentScheme: "exact" });
    expect(signed.scheme).toBe("exact");
    expect(signed.amount).toBe("5000");
    expect(decode(signed.paymentPayload).accepted.scheme).toBe("exact");
    expect(spy).not.toHaveBeenCalled();
  });

  it("no upto offered → exact, no RPC", async () => {
    const { spy } = mockRpc({});
    const signed = await pay(required([exactOption()], GAS));
    expect(signed.scheme).toBe("exact");
    expect(spy).not.toHaveBeenCalled();
  });

  it("upto without extra.facilitatorAddress → exact, no RPC", async () => {
    const { spy } = mockRpc({});
    const signed = await pay(required([exactOption(), uptoOption({ extra: { name: "USD Coin", version: "2" } })], GAS));
    expect(signed.scheme).toBe("exact");
    expect(spy).not.toHaveBeenCalled();
  });

  it("allowance already covers the ceiling → upto without a permit, one 2-call batch", async () => {
    const { batches } = mockRpc({ allowance: 12345n });
    const signed = await pay(required([exactOption(), uptoOption()]));
    expect(signed).toMatchObject({ scheme: "upto", amount: "12345", network: BASE, gasSponsored: false });
    const d = decode(signed.paymentPayload);
    expect(d.accepted.scheme).toBe("upto");
    expect(d.extensions.eip2612GasSponsoring).toBeUndefined();
    expect(batches).toHaveLength(1);
    expect(batches[0].map((c) => c.params[0].data.slice(0, 10))).toEqual(["0x70a08231", "0xdd62ed3e"]);
    expect(batches[0].every((c) => c.params[0].to === USDC_BASE)).toBe(true);
  });

  it("allowance covers it AND gas sponsoring declared → upto, still no permit", async () => {
    mockRpc({ allowance: 10n ** 9n, nonce: 3n });
    const signed = await pay(required([exactOption(), uptoOption()], GAS));
    expect(signed.scheme).toBe("upto");
    expect(signed.gasSponsored).toBe(false);
    expect(decode(signed.paymentPayload).extensions.eip2612GasSponsoring).toBeUndefined();
  });

  it("allowance short + gas sponsoring declared → upto with an EIP-2612 permit at the token nonce", async () => {
    const { batches } = mockRpc({ allowance: 100n, nonce: 42n });
    const signed = await pay(required([exactOption(), uptoOption()], GAS));
    expect(signed.scheme).toBe("upto");
    expect(signed.gasSponsored).toBe(true);
    const d = decode(signed.paymentPayload);
    const info = d.extensions.eip2612GasSponsoring.info;
    expect(info).toMatchObject({
      from: TEST_ACCOUNT.address,
      asset: USDC_BASE,
      spender: PERMIT2_ADDRESS,
      amount: "12345",
      nonce: "42",
      deadline: d.payload.permit2Authorization.deadline,
      version: "1",
    });
    expect(
      await verifyTypedData({
        address: TEST_ACCOUNT.address,
        domain: EVM_NETWORKS[BASE].domain,
        types: EIP2612_PERMIT_TYPES,
        primaryType: "Permit",
        message: {
          owner: info.from,
          spender: info.spender,
          value: BigInt(info.amount),
          nonce: 42n,
          deadline: BigInt(info.deadline),
        },
        signature: info.signature,
      }),
    ).toBe(true);
    expect(batches[0].map((c) => c.params[0].data.slice(0, 10))).toEqual(["0x70a08231", "0xdd62ed3e", "0x7ecebe00"]);
  });

  it("the permit value must equal the permitted amount — a MaxUint256 permit is refused by our own code path", async () => {
    // x402BasePermit2Proxy.sol _executePermit:
    //   if (permit2612.value != permittedAmount) revert Permit2612AmountMismatch();
    const upto = baseUpto();
    const info = await signEip2612GasSponsoringPermit(
      TEST_PRIVATE_KEY, TEST_ACCOUNT.address, upto.net, maxUint256.toString(), 0n, "1790000300",
    );
    expect(() => assertPermitMatchesPermitted(info, { permitted: { token: USDC_BASE, amount: "12345" } })).toThrow(
      /Permit2612AmountMismatch/,
    );
    expect(() => assertPermitMatchesPermitted({ amount: "12345" }, { permitted: { token: USDC_BASE, amount: "12345" } })).not.toThrow();
    // And what createUptoPaymentPayload emits always passes it.
    const d = decode(
      await createUptoPaymentPayload(TEST_PRIVATE_KEY, TEST_ACCOUNT.address, upto, { gasSponsoringTokenNonce: 3n }),
    );
    expect(d.extensions.eip2612GasSponsoring.info.amount).toBe(d.payload.permit2Authorization.permitted.amount);
  });

  describe("pending-permit nonce guard", () => {
    const NOW = 1_790_000_000;
    const plan = (pending: { tokenNonce: bigint; deadline: number } | undefined, now = NOW) =>
      planUpto(TEST_ACCOUNT.address, baseUpto(), true, [RPC], pending, now);

    it("on-chain nonce <= pending nonce and before its deadline → no (exact), pending kept", async () => {
      mockRpc({ allowance: 0n, nonce: 4n });
      expect(await plan({ tokenNonce: 4n, deadline: NOW + 300 })).toMatchObject({ use: false, reason: expect.stringMatching(/pending/) });
      mockRpc({ allowance: 0n, nonce: 3n });
      const p = await plan({ tokenNonce: 4n, deadline: NOW + 300 });
      expect(p.use).toBe(false);
      expect(p.pendingResolved).toBeFalsy();
    });

    it("on-chain nonce moved past the pending nonce → consumed: resolved, new permit at the on-chain nonce", async () => {
      mockRpc({ allowance: 0n, nonce: 5n });
      expect(await plan({ tokenNonce: 4n, deadline: NOW + 300 })).toEqual({
        use: true,
        gasSponsoringTokenNonce: 5n,
        pendingResolved: true,
      });
    });

    it("past the pending permit's deadline → it can never execute: resolved, new permit", async () => {
      mockRpc({ allowance: 0n, nonce: 4n });
      expect(await plan({ tokenNonce: 4n, deadline: NOW + 300 }, NOW + 300)).toEqual({
        use: true,
        gasSponsoringTokenNonce: 4n,
        pendingResolved: true,
      });
    });

    it("allowance >= ceiling → upto without a permit, whatever is pending", async () => {
      mockRpc({ allowance: 12345n, nonce: 4n });
      expect(await plan({ tokenNonce: 4n, deadline: NOW + 300 })).toEqual({ use: true, pendingResolved: false });
    });

    it("no pending permit → a permit at the on-chain nonce", async () => {
      mockRpc({ allowance: 0n, nonce: 9n });
      expect(await plan(undefined)).toEqual({ use: true, gasSponsoringTokenNonce: 9n, pendingResolved: false });
    });

    it("createEvmPayment reports the permit it attached, and signs exact while one is pending", async () => {
      mockRpc({ allowance: 0n, nonce: 4n });
      const opts = { resourceUrl: "https://blockrun.ai/api/v1/chat/completions", resourceDescription: "chat", rpcUrls: [RPC] };
      const first = await createEvmPayment(TEST_PRIVATE_KEY, TEST_ACCOUNT.address, required([exactOption(), uptoOption()], GAS), opts);
      expect(first.permit?.tokenNonce).toBe(4n);
      expect(first.permit?.deadline).toBe(Number(decode(first.paymentPayload).payload.permit2Authorization.deadline));
      const second = await createEvmPayment(TEST_PRIVATE_KEY, TEST_ACCOUNT.address, required([exactOption(), uptoOption()], GAS), {
        ...opts,
        pendingPermit: first.permit,
      });
      expect(second.scheme).toBe("exact");
    });
  });

  it("allowance short and NO gas sponsoring → exact", async () => {
    mockRpc({ allowance: 0n });
    const signed = await pay(required([exactOption(), uptoOption()]));
    expect(signed.scheme).toBe("exact");
    expect(signed.amount).toBe("5000");
  });

  it("balance covers exact but not the upto ceiling → exact", async () => {
    mockRpc({ balance: 6000n, allowance: 10n ** 12n });
    const signed = await pay(required([exactOption(), uptoOption()], GAS));
    expect(signed.scheme).toBe("exact");
  });

  it.each([
    ["the RPC rejects", () => vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNRESET"))],
    ["the RPC answers 500", () => vi.spyOn(global, "fetch").mockResolvedValue(new Response("x", { status: 500 }))],
    [
      "the RPC does not support batches",
      () => vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, result: "0x" }))),
    ],
    [
      "one call in the batch errors",
      () =>
        vi.spyOn(global, "fetch").mockResolvedValue(
          new Response(JSON.stringify([
            { jsonrpc: "2.0", id: 0, result: word(10n ** 12n) },
            { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } },
          ])),
        ),
    ],
    [
      "the nonce read returns undecodable data",
      () =>
        vi.spyOn(global, "fetch").mockResolvedValue(
          new Response(JSON.stringify([
            { jsonrpc: "2.0", id: 0, result: word(10n ** 12n) },
            { jsonrpc: "2.0", id: 1, result: word(0n) },
            { jsonrpc: "2.0", id: 2, result: "0x01" },
          ])),
        ),
    ],
  ])("any preflight failure → exact (%s)", async (_label, arrange) => {
    arrange();
    const signed = await pay(required([exactOption(), uptoOption()], GAS));
    expect(signed.scheme).toBe("exact");
    expect(decode(signed.paymentPayload).payload.authorization.value).toBe("5000");
  });

  it("fails over to the next RPC endpoint", async () => {
    const urls: string[] = [];
    vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      urls.push(String(url));
      if (String(url) === "https://dead.test") return new Response("down", { status: 503 });
      const batch = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(batch.map((c: { id: number }) => ({ jsonrpc: "2.0", id: c.id, result: word(10n ** 12n) }))));
    });
    const signed = await pay(required([exactOption(), uptoOption()]), { rpcUrls: ["https://dead.test", RPC] });
    expect(signed.scheme).toBe("upto");
    expect(urls).toEqual(["https://dead.test", RPC]);
  });

  it("a network with no RPC (Arc) → exact, no fetch", async () => {
    const { spy } = mockRpc({ allowance: 10n ** 12n });
    const arc = "eip155:5042";
    expect(evmRpcUrls(arc)).toEqual([]);
    const signed = await createEvmPayment(
      TEST_PRIVATE_KEY,
      TEST_ACCOUNT.address,
      required(
        [
          exactOption({ network: arc, asset: USDC_ARC, extra: { name: "USDC", version: "2" } }),
          uptoOption({ network: arc, asset: USDC_ARC }),
        ],
        GAS,
      ),
      { resourceUrl: "https://arc.blockrun.ai/api/v1/chat/completions", resourceDescription: "chat" },
    );
    expect(signed.scheme).toBe("exact");
    expect(spy).not.toHaveBeenCalled();
  });

  it("errors from the exact signer itself still throw (not swallowed by the fallback)", async () => {
    mockRpc({});
    await expect(
      pay(required([exactOption({ asset: "0x0000000000000000000000000000000000000001" })])),
    ).rejects.toThrow(/asset mismatch/);
  });

  it("BLOCKRUN_PAYMENT_SCHEME=exact opts out; an explicit option wins; bad options throw", () => {
    expect(resolvePaymentScheme()).toBe("auto");
    process.env.BLOCKRUN_PAYMENT_SCHEME = "exact";
    expect(resolvePaymentScheme()).toBe("exact");
    expect(resolvePaymentScheme("auto")).toBe("auto");
    process.env.BLOCKRUN_PAYMENT_SCHEME = "garbage";
    expect(resolvePaymentScheme()).toBe("auto");
    expect(() => resolvePaymentScheme("upto")).toThrow(/exact" or "auto/);
  });
});

describe("booking an upto payment", () => {
  const settledHeader = (amount: unknown) =>
    new Headers({ "PAYMENT-RESPONSE": btoa(JSON.stringify({ success: true, transaction: "0xabc", network: BASE, amount })) });

  it("reads the settled amount from PAYMENT-RESPONSE (and X-PAYMENT-RESPONSE)", () => {
    expect(parseSettledAmount({ headers: settledHeader("2100") })).toBe("2100");
    expect(parseSettledAmount({ headers: new Headers({ "X-PAYMENT-RESPONSE": btoa(JSON.stringify({ amount: "7" })) }) })).toBe("7");
    expect(parseSettledAmount({ headers: settledHeader(undefined) })).toBeNull();
    expect(parseSettledAmount({ headers: new Headers({ "PAYMENT-RESPONSE": "%%%" }) })).toBeNull();
    expect(parseSettledAmount({})).toBeNull();
  });

  it("books the settled amount when reported, the labelled ceiling when not, capped at the ceiling", () => {
    const upto = { scheme: "upto" as const, amount: "12345" };
    expect(bookedCost(upto, { headers: settledHeader("2100") })).toEqual({ costUsd: 0.0021, basis: "settled" });
    expect(bookedCost(upto, { headers: new Headers() })).toEqual({ costUsd: 0.012345, basis: "ceiling" });
    expect(bookedCost(upto, { headers: settledHeader("99999999") })).toEqual({ costUsd: 0.012345, basis: "settled" });
    expect(bookedCost({ scheme: "exact", amount: "5000" }, { headers: settledHeader("1") })).toEqual({
      costUsd: 0.005,
      basis: "exact",
    });
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
