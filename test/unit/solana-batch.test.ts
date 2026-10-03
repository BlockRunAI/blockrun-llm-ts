// Solana x402 batch-settlement (metered billing), opt-in on SolanaLLMClient.
//
// These drive the REAL @x402/svm batch client: the deposit, the per-call
// authorization and the operator voucher in the receipt are built and checked
// by the official scheme. Only the network is faked — the gateway, and the
// Solana RPC the scheme reads the mint, blockhash and slot from.
import { generateKeyPairSync } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { signBatchVoucher } from "@x402/svm/batch-settlement/client";
import { SolanaLLMClient } from "../../src/solana-client";
import {
  __resetBatchWalletsForTests,
  __setBatchSleepForTests,
  BatchPaymentUnresolvedError,
  FileIntentJournal,
  ChannelResyncRequiredError,
  decodeChannelAccount,
  dropOrphanedPending,
  FileChannelStorage,
  lockChannelFile,
  parseRetryAfter,
  type SolanaBatchEvent,
} from "../../src/solana-batch";
import { APIError, retryDisposition } from "../../src/types";

/**
 * Stands in a peer `@x402/svm` whose channel account layout moved: with
 * `shifted`, its exported CHANNEL_ACCOUNT_SIZE no longer matches the SDK's
 * decoder. The batch scheme itself (a separate entry point) is untouched.
 */
const svmLayout = vi.hoisted(() => ({ shifted: false }));
vi.mock("@x402/svm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@x402/svm")>();
  return {
    ...actual,
    get CHANNEL_ACCOUNT_SIZE() {
      return svmLayout.shifted ? actual.CHANNEL_ACCOUNT_SIZE + 8n : actual.CHANNEL_ACCOUNT_SIZE;
    },
  };
});

/** A real ed25519 keypair (seed || public key), the way Solana wallets store it. */
function walletKey(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return bs58.encode(Buffer.concat([seed, pub]));
}
const TEST_BS58_KEY = walletKey();
const API = "https://sol.blockrun.ai/api";
const CHAT_URL = `${API}/v1/chat/completions`;
const RPC_URL = "https://rpc.test/solana";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const RECEIVER = "AQqnMFBwGZEoti85aTVRy8XYpKrho7GaMDx9ZB3CEeKA";
const FEE_PAYER = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const RECEIVER_AUTHORIZER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const CHAT_OK = { id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "gm" } }] };

/** A USDC mint account as getAccountInfo returns it (SPL Mint, 82 bytes, 6 decimals). */
function mintAccount() {
  const data = new Uint8Array(82);
  data[44] = 6; // decimals
  data[45] = 1; // is_initialized
  return {
    data: [Buffer.from(data).toString("base64"), "base64"],
    executable: false,
    lamports: 1_461_600,
    owner: TOKEN_PROGRAM,
    rentEpoch: 0,
    space: 82,
  };
}

const CHANNELS_PROGRAM = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX";
const OPEN_SLOT = 400_000_000n;

/**
 * A payment-channel account as getAccountInfo / getProgramAccounts return it:
 * 256 bytes in the @x402/svm layout. The scheme's own on-chain discovery
 * decodes and PDA-checks these, which pins this encoder (and so the SDK's
 * decoder) to the upstream layout.
 */
function channelAccount(fields: {
  payer: string;
  operator: string;
  deposit: bigint;
  settled?: bigint;
  status?: number;
  closureStartedAt?: bigint;
}) {
  const data = new Uint8Array(256);
  const view = new DataView(data.buffer);
  data[0] = 1; // discriminator: Channel
  data[1] = 1; // version
  data[3] = fields.status ?? 0; // Open
  view.setBigUint64(4, 0n, true); // salt
  view.setBigUint64(12, fields.deposit, true);
  view.setBigUint64(20, fields.settled ?? 0n, true);
  view.setBigInt64(36, fields.closureStartedAt ?? 0n, true);
  view.setUint32(52, 86_400, true); // gracePeriod = withdrawDelay
  data.set(bs58.decode(fields.payer), 88);
  data.set(bs58.decode(FEE_PAYER), 120); // payee
  data.set(bs58.decode(fields.operator), 152); // authorizedSigner
  data.set(bs58.decode(USDC), 184); // mint
  data.set(bs58.decode(FEE_PAYER), 216); // rentPayer
  view.setBigUint64(248, OPEN_SLOT, true);
  return {
    data: [Buffer.from(data).toString("base64"), "base64"],
    executable: false,
    lamports: 3_000_000,
    owner: CHANNELS_PROGRAM,
    rentEpoch: 0,
    space: 256,
  };
}

/** The Solana JSON-RPC the scheme talks to. Returns null for an unknown method. */
function rpcResult(
  method: string,
  params: unknown[] = [],
  chain: Map<string, ReturnType<typeof channelAccount>> = new Map(),
  scannable = false,
  clock: { blockHeight: number; blockhashValid: boolean } = { blockHeight: 400_000_000, blockhashValid: true }
): unknown {
  const context = { slot: 400_000_000 };
  switch (method) {
    case "getBlockHeight":
      return clock.blockHeight;
    case "getEpochInfo":
      // The fake chain finalizes everything at once: one height for every commitment.
      return { absoluteSlot: clock.blockHeight + 1_000, blockHeight: clock.blockHeight, epoch: 900, slotIndex: 0, slotsInEpoch: 432_000 };
    case "isBlockhashValid":
      return { context, value: clock.blockhashValid };
    case "getAccountInfo": {
      const address = params[0] as string;
      if (address === USDC) return { context, value: mintAccount() };
      return { context, value: chain.get(address) ?? null };
    }
    case "getLatestBlockhash":
      return {
        context,
        value: { blockhash: "9T1tBhLxWWKf1XhD9deySUK2tNcmGQhBsR2tMKFLgFUL", lastValidBlockHeight: 430_673_687 },
      };
    case "getSlot":
      return 400_000_000;
    case "getProgramAccounts":
      return scannable ? [...chain].map(([pubkey, account]) => ({ pubkey, account })) : [];
    default:
      return null;
  }
}

function exactAccept(amount = "5000") {
  return {
    scheme: "exact",
    network: NETWORK,
    amount,
    asset: USDC,
    payTo: RECEIVER,
    maxTimeoutSeconds: 300,
    extra: { feePayer: FEE_PAYER },
  };
}

function batchAccept(operator: string, amount = "5000") {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount,
    asset: USDC,
    payTo: RECEIVER,
    maxTimeoutSeconds: 3600,
    extra: {
      feePayer: FEE_PAYER,
      withdrawDelay: 86_400,
      tokenProgram: TOKEN_PROGRAM,
      receiverAuthorizer: RECEIVER_AUTHORIZER,
      voucherSigner: "server",
      operator,
    },
  };
}

/** The gateway's 402: exact first, batch second — the order blockrun-sol ships. */
function quote402(accepts: unknown[]): Response {
  const body = JSON.stringify({ x402Version: 2, resource: { url: CHAT_URL, description: "chat" }, accepts });
  return new Response(body, {
    status: 402,
    headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(body).toString("base64") },
  });
}

function decodePayment(init: RequestInit | undefined): Record<string, any> {
  const header = (init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"];
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

/**
 * A served batch call: 200 with the operator-signed voucher for the channel's
 * new cumulative total, the receipt the official server scheme returns. As on
 * sol.blockrun.ai, the per-call charge is `extra.chargedAmount`; the
 * top-level `amount` is empty.
 */
async function servedWithVoucher(
  operator: KeyPairSigner,
  channelId: string,
  cumulative: bigint,
  charged: bigint
): Promise<Response> {
  const voucher = await signBatchVoucher(operator, { channelId, maxClaimableAmount: cumulative, expiresAt: 0 });
  const receipt = {
    success: true,
    transaction: "",
    network: NETWORK,
    amount: "",
    extra: {
      voucher,
      chargedAmount: charged.toString(),
      commitmentId: `commit-${cumulative}`,
      channelState: { channelId, chargedCumulativeAmount: cumulative.toString() },
    },
  };
  return new Response(JSON.stringify(CHAT_OK), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(receipt)).toString("base64"),
    },
  });
}

function channelIdOf(payment: Record<string, any>): string {
  return payment.payload.authorization.channelId;
}

describe("SolanaLLMClient batch-settlement", () => {
  let operator: KeyPairSigner;
  let gateway: Array<(url: string, init?: RequestInit) => Promise<Response> | Response>;
  let gatewayCalls: Array<{ url: string; init?: RequestInit }>;
  let tmp: string;
  let rpcMethods: string[];
  let rpcCalls: Array<{ method: string; params: unknown[]; init?: RequestInit }>;
  /** Channel accounts on the fake chain, by address. */
  let chain: Map<string, ReturnType<typeof channelAccount>>;
  /** Whether getProgramAccounts (the scheme's discovery scan) sees them. Many RPCs refuse that call. */
  let scannable: boolean;
  /** RPC methods that answer HTTP 500. */
  let rpcDown: Set<string>;
  /** The chain's block height, and whether the RPC calls a blockhash still valid. */
  let rpcClock: { blockHeight: number; blockhashValid: boolean };

  beforeEach(async () => {
    __resetBatchWalletsForTests();
    operator = await generateKeyPairSigner();
    rpcMethods = [];
    rpcCalls = [];
    chain = new Map();
    scannable = false;
    rpcDown = new Set();
    rpcClock = { blockHeight: 400_000_000, blockhashValid: true };
    gateway = [];
    gatewayCalls = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "br-batch-"));
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(RPC_URL)) {
        const { id, method, params } = JSON.parse(String(init?.body));
        rpcMethods.push(method);
        rpcCalls.push({ method, params, init });
        if (rpcDown.has(method)) return new Response("upstream down", { status: 500 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: rpcResult(method, params, chain, scannable, rpcClock) }), {
          headers: { "content-type": "application/json" },
        });
      }
      gatewayCalls.push({ url, init });
      const next = gateway.shift();
      if (!next) throw new Error(`unexpected gateway call ${url}`);
      return next(url, init);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    svmLayout.shifted = false;
    __resetBatchWalletsForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function client(batch?: Partial<NonNullable<ConstructorParameters<typeof SolanaLLMClient>[0]>["batch"]>) {
    return new SolanaLLMClient({
      privateKey: TEST_BS58_KEY,
      rpcUrl: RPC_URL,
      ...(batch ? { batch: { operators: [operator.address], channelStore: path.join(tmp, "channels.json"), ...batch } } : {}),
    });
  }

  /** Stub the exact signer: these tests are about which scheme pays, not SPL bytes. */
  function stubExact(c: SolanaLLMClient) {
    return vi
      .spyOn(c as unknown as { signExactPayment: () => unknown }, "signExactPayment")
      .mockResolvedValue({ paymentPayload: "exact-payload", costUsd: 0.005 });
  }

  it("opens a channel on the first call, then pays each call with an authorization", async () => {
    const c = client({ maxDeposit: "$1" });
    const exact = stubExact(c);
    let channelId = "";

    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      async (_url, init) => {
        const payment = decodePayment(init);
        expect(payment.accepted.scheme).toBe("batch-settlement");
        expect(payment.payload.type).toBe("deposit");
        expect(payment.payload.channelConfig.voucherSigner).toBe("server");
        expect(payment.payload.channelConfig.payerAuthorizer).toBe(operator.address);
        // Escrow is the scheme's default (5 x the ceiling), inside the $1 cap.
        expect(payment.payload.deposit.amount).toBe("25000");
        channelId = channelIdOf(payment);
        return servedWithVoucher(operator, channelId, 1200n, 1200n);
      },
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      async (_url, init) => {
        const payment = decodePayment(init);
        // No second deposit: the open channel still covers the ceiling.
        expect(payment.payload.type).toBe("authorization");
        expect(channelIdOf(payment)).toBe(channelId);
        return servedWithVoucher(operator, channelId, 2000n, 800n);
      }
    );

    await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
    await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

    expect(exact).not.toHaveBeenCalled();
    // Charged what the calls cost (1200 + 800 micro-USDC), not 2 x the 5000 ceiling.
    expect(c.getSpending()).toEqual({ totalUsd: 0.002, calls: 2 });
    // The confirmed channel survives the process.
    const stored = JSON.parse(fs.readFileSync(path.join(tmp, "channels.json"), "utf8"));
    const [record] = Object.values(stored) as Array<Record<string, unknown>>;
    expect(record).toMatchObject({ channelId, chargedCumulativeAmount: "2000", deposit: "25000" });
    expect(record.pending).toBeUndefined();
  });

  it("never signs a transfer against a batch accept, even listed first, without the option", async () => {
    const c = client();
    const exact = stubExact(c);
    gateway.push(
      () => quote402([batchAccept(operator.address), exactAccept()]),
      () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
    );

    await c.chat("openai/gpt-4o-mini", "gm");

    expect(exact).toHaveBeenCalledTimes(1);
    const [, paymentRequired] = exact.mock.calls[0] as unknown as [string, { accepts: Array<{ scheme: string }> }];
    expect(paymentRequired.accepts.map((a) => a.scheme)).toEqual(["batch-settlement", "exact"]);
    expect((gatewayCalls[1].init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"]).toBe("exact-payload");
  });

  it("pays exact when the 402 names an operator the caller does not trust", async () => {
    const c = client({});
    const exact = stubExact(c);
    const stranger = await generateKeyPairSigner();
    vi.spyOn(console, "error").mockImplementation(() => {});
    gateway.push(
      () => quote402([exactAccept(), batchAccept(stranger.address)]),
      () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
    );

    await c.chat("openai/gpt-4o-mini", "gm");

    expect(exact).toHaveBeenCalledTimes(1);
    expect(gatewayCalls).toHaveLength(2);
    expect(c.getSpending()).toEqual({ totalUsd: 0.005, calls: 1 });
  });

  it("pays exact when the ceiling needs more escrow than maxDeposit allows", async () => {
    const c = client({ maxDeposit: "$0.001" });
    const exact = stubExact(c);
    vi.spyOn(console, "error").mockImplementation(() => {});
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
    );

    await c.chat("openai/gpt-4o-mini", "gm");

    expect(exact).toHaveBeenCalledTimes(1);
    expect(gatewayCalls).toHaveLength(2);
  });

  it.each([
    [403, { error: "batch_payer_not_allowed" }],
    [503, { error: "batch_admission_paused" }],
    [400, { error: "batch_server_signed_only" }],
    [503, { error: "Payment verification temporarily unavailable", code: "PAYMENT_VERIFICATION_UNAVAILABLE" }],
  ])("falls back to exact when the gateway refuses batch (%i %j)", async (status, error) => {
    const c = client({});
    const exact = stubExact(c);
    vi.spyOn(console, "error").mockImplementation(() => {});
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => new Response(JSON.stringify(error), { status }),
      () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
    );

    await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

    expect(exact).toHaveBeenCalledTimes(1);
    expect((gatewayCalls[2].init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"]).toBe("exact-payload");
    // Only the exact payment is booked: the refused batch attempt charged nothing.
    expect(c.getSpending()).toEqual({ totalUsd: 0.005, calls: 1 });
  });

  it("books the charge of a receipt the gateway rebuilt after confirming its commit", async () => {
    const c = client({});
    const exact = stubExact(c);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // No voucher, no extra: the scheme cannot reconcile it, but the call was charged.
    const receipt = { success: true, transaction: "", network: NETWORK, amount: "700" };
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () =>
        new Response(JSON.stringify(CHAT_OK), {
          status: 200,
          headers: { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(receipt)).toString("base64") },
        })
    );

    await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

    expect(exact).not.toHaveBeenCalled();
    expect(c.getSpending()).toEqual({ totalUsd: 0.0007, calls: 1 });
  });

  it("never books the ceiling when a receipt states no charge", async () => {
    const c = client({});
    stubExact(c);
    vi.spyOn(console, "error").mockImplementation(() => {});
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
    );

    await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

    expect(c.getSpending()).toEqual({ totalUsd: 0, calls: 1 });
  });

  it("raises payment_outcome_unknown as unresolved instead of paying again with exact", async () => {
    const c = client({});
    const exact = stubExact(c);
    vi.spyOn(console, "error").mockImplementation(() => {});
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => new Response(JSON.stringify({ error: "payment_outcome_unknown" }), { status: 409 })
    );

    const raised = await c.chat("openai/gpt-4o-mini", "gm").catch((err: unknown) => err);
    expect(raised).toMatchObject({ name: "BatchPaymentUnresolvedError", reason: "outcome_unknown", status: 409, payloadKind: "open" });
    // The gateway's answer stays readable as the cause.
    expect((raised as Error).cause).toBeInstanceOf(APIError);
    expect(((raised as Error).cause as APIError).response).toMatchObject({ message: "payment_outcome_unknown" });
    expect(exact).not.toHaveBeenCalled();
    expect(gatewayCalls).toHaveLength(2);
  });

  it("surfaces a model error after a batch payment instead of paying again", async () => {
    const c = client({});
    const exact = stubExact(c);
    vi.spyOn(console, "error").mockImplementation(() => {});
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => new Response(JSON.stringify({ error: "upstream_timeout" }), { status: 504 })
    );

    const raised = await c.chat("openai/gpt-4o-mini", "gm").catch((err: unknown) => err);
    expect(raised).toMatchObject({ name: "BatchPaymentUnresolvedError", reason: "outcome_unknown", status: 504 });
    expect(((raised as Error).cause as APIError).statusCode).toBe(504);
    expect(exact).not.toHaveBeenCalled();
    expect(c.getSpending()).toEqual({ totalUsd: 0, calls: 0 });
  });

  it("pays a concurrent call with exact while the channel has a request in flight", async () => {
    const c = client({});
    const exact = stubExact(c);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      async (_url, init) => {
        const channelId = channelIdOf(decodePayment(init));
        await held;
        return servedWithVoucher(operator, channelId, 1000n, 1000n);
      },
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => {
        release();
        return new Response(JSON.stringify(CHAT_OK), { status: 200 });
      }
    );

    const first = c.chat("openai/gpt-4o-mini", "one");
    await vi.waitFor(() => expect(gatewayCalls).toHaveLength(2));
    const second = c.chat("openai/gpt-4o-mini", "two");
    await Promise.all([first, second]);

    expect(exact).toHaveBeenCalledTimes(1);
    expect(c.getSpending().calls).toBe(2);
  });

  it("releases the channel when an authorization gets no answer", async () => {
    const c = client({});
    stubExact(c);
    vi.spyOn(console, "error").mockImplementation(() => {});
    let channelId = "";
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      async (_url, init) => {
        channelId = channelIdOf(decodePayment(init));
        return servedWithVoucher(operator, channelId, 1000n, 1000n);
      },
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => { throw new TypeError("fetch failed"); },
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      async (_url, init) => {
        const payment = decodePayment(init);
        // The next call uses batch again rather than tripping over a stale pending slot.
        expect(payment.payload.type).toBe("authorization");
        return servedWithVoucher(operator, channelIdOf(payment), 2000n, 1000n);
      }
    );

    await c.chat("openai/gpt-4o-mini", "gm");
    // Unanswered: it may have been charged, so it is raised, never paid again.
    await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toMatchObject({
      name: "BatchPaymentUnresolvedError",
      reason: "no_response",
      payloadKind: "authorization",
      depositInDoubt: false,
    });
    await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
    // An unanswered authorization does not touch the chain.
    expect(rpcCalls.filter((r) => r.method === "getAccountInfo" && r.params[0] === channelId)).toHaveLength(0);
  });

  it("keeps streaming on exact", async () => {
    const c = client({});
    const exact = vi
      .spyOn(c as unknown as { signPaymentFrom402: () => unknown }, "signPaymentFrom402")
      .mockResolvedValue({ paymentPayload: "exact-payload", costUsd: 0.005 });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"ok":1}\n\ndata: [DONE]\n'));
        controller.close();
      },
    });
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    );

    const frames: unknown[] = [];
    for await (const frame of c.stream("/v1/chat/completions", { stream: true })) frames.push(frame);

    expect(frames).toEqual([{ ok: 1 }]);
    expect(exact).toHaveBeenCalledTimes(1);
  });

  it("shares one channel between clients of the same wallet", async () => {
    const a = client({});
    const b = client({});
    const exactB = stubExact(b);
    stubExact(a);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      async (_url, init) => {
        const payment = decodePayment(init);
        expect(payment.payload.type).toBe("deposit");
        await held;
        return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
      },
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => {
        release();
        return new Response(JSON.stringify(CHAT_OK), { status: 200 });
      }
    );

    const first = a.chat("openai/gpt-4o-mini", "one");
    await vi.waitFor(() => expect(gatewayCalls).toHaveLength(2));
    // b must not open a second channel while a's open is in flight.
    const second = b.chat("openai/gpt-4o-mini", "two");
    await Promise.all([first, second]);

    expect(exactB).toHaveBeenCalledTimes(1);
  });

  it("refuses batch for a second client of the wallet with different trust options", async () => {
    const other = client({ maxDeposit: "$50" });
    const exact = stubExact(other);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The first client claims the wallet on its first batch attempt.
    const first = client({});
    stubExact(first);
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n),
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
    );

    await first.chat("openai/gpt-4o-mini", "one");
    await other.chat("openai/gpt-4o-mini", "two");

    expect(exact).toHaveBeenCalledTimes(1);
  });

  it("stays on exact while another live process owns the channel file", async () => {
    const store = path.join(tmp, "channels.json");
    fs.writeFileSync(`${store}.lock`, String(process.ppid));
    const c = client({});
    const exact = stubExact(c);
    vi.spyOn(console, "error").mockImplementation(() => {});
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
    );

    await c.chat("openai/gpt-4o-mini", "gm");

    expect(exact).toHaveBeenCalledTimes(1);
    expect(gatewayCalls).toHaveLength(2);
  });

  describe("channel retention", () => {
    let events: SolanaBatchEvent[];

    beforeEach(() => {
      events = [];
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    function kept(batch: Parameters<typeof client>[0] = {}) {
      return client({ onEvent: (event) => events.push(event), ...batch });
    }

    function storedRecord(): Record<string, any> {
      const stored = JSON.parse(fs.readFileSync(path.join(tmp, "channels.json"), "utf8"));
      const records = Object.values(stored) as Array<Record<string, any>>;
      expect(records).toHaveLength(1);
      return records[0];
    }

    /** Open a channel (deposit 25000) and serve a first charge of 1000. */
    async function openChannel(c: SolanaLLMClient): Promise<string> {
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          return servedWithVoucher(operator, channelId, 1000n, 1000n);
        }
      );
      await c.chat("openai/gpt-4o-mini", "gm");
      return channelId;
    }

    it("keeps a healthy channel when its top-up is refused", async () => {
      const c = kept({ maxDeposit: "$1" });
      const exact = stubExact(c);
      const channelId = await openChannel(c);
      gateway.push(
        // A larger ceiling than the channel can cover: this call needs a top-up.
        () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
        (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("deposit");
          expect(channelIdOf(payment)).toBe(channelId);
          return new Response(JSON.stringify({ error: "batch_admission_paused" }), { status: 503 });
        },
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 }),
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          const payment = decodePayment(init);
          // Same channel, plain authorization: nothing was forgotten or re-opened.
          expect(payment.payload.type).toBe("authorization");
          expect(channelIdOf(payment)).toBe(channelId);
          return servedWithVoucher(operator, channelId, 2000n, 1000n);
        }
      );
      const scans = rpcMethods.filter((m) => m === "getProgramAccounts").length;

      await c.chat("openai/gpt-4o-mini", "gm");
      expect(exact).toHaveBeenCalledTimes(1);
      expect(storedRecord()).toMatchObject({ channelId, deposit: "25000", chargedCumulativeAmount: "1000" });
      expect(storedRecord().pending).toBeUndefined();

      await c.chat("openai/gpt-4o-mini", "gm");
      expect(rpcMethods.filter((m) => m === "getProgramAccounts").length).toBe(scans);
      expect(c.getBatchStats().resyncs).toBe(0);
    });

    it("keeps the channel through a rate-limited top-up and tops up the same channel on retry", async () => {
      __setBatchSleepForTests(async () => {});
      const c = kept({ maxDeposit: "$1" });
      const exact = stubExact(c);
      const channelId = await openChannel(c);
      gateway.push(
        () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
        () =>
          new Response(JSON.stringify({ errorReason: "batch_deposit_rate_limited" }), {
            status: 429,
            headers: {
              "Retry-After": "30",
              "PAYMENT-RESPONSE": Buffer.from(
                JSON.stringify({ success: false, errorReason: "batch_deposit_rate_limited", transaction: "", network: NETWORK })
              ).toString("base64"),
            },
          }),
        () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("deposit");
          expect(channelIdOf(payment)).toBe(channelId);
          return servedWithVoucher(operator, channelId, 31000n, 30000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).not.toHaveBeenCalled();
      const record = storedRecord();
      expect(record.channelId).toBe(channelId);
      expect(BigInt(record.deposit)).toBeGreaterThan(25000n);
      expect(record.chargedCumulativeAmount).toBe("31000");
    });

    it("re-reads the channel from the chain after a rebuilt receipt, instead of opening a new one", async () => {
      const c = kept();
      const exact = stubExact(c);
      let channelId = "";
      // The gateway confirmed the commit but answered with a rebuilt receipt:
      // no voucher, so the scheme cannot reconcile it and drops its record.
      const rebuilt = { success: true, transaction: "", network: NETWORK, amount: "700" };
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          return new Response(JSON.stringify(CHAT_OK), {
            status: 200,
            headers: { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(rebuilt)).toString("base64") },
          });
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          const payment = decodePayment(init);
          // The funded channel, re-read from the chain: an authorization, not a second open.
          expect(payment.payload.type).toBe("authorization");
          expect(channelIdOf(payment)).toBe(channelId);
          return servedWithVoucher(operator, channelId, 1500n, 800n);
        }
      );

      await c.chat("openai/gpt-4o-mini", "gm");
      chain.set(channelId, channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 25000n }));
      await c.chat("openai/gpt-4o-mini", "gm");

      expect(exact).not.toHaveBeenCalled();
      // Discovery was never needed (this RPC cannot scan): the channel was read by its id.
      expect(rpcCalls.some((r) => r.method === "getAccountInfo" && r.params[0] === channelId)).toBe(true);
      expect(events).toEqual([expect.objectContaining({ type: "resync", reason: "receipt_unreconciled" })]);
      expect(events[0].detail).toContain("deposit=25000");
      expect(events[0].detail).toContain("cumulative=700");
      expect(storedRecord()).toMatchObject({ channelId, deposit: "25000", chargedCumulativeAmount: "1500" });
      expect(c.getBatchStats().resyncs).toBe(1);
      expect(c.getSpending()).toEqual({ totalUsd: 0.0015, calls: 2 });
    });

    it("counts a charge once when saving its reconciled receipt fails", async () => {
      const c = kept();
      const exact = stubExact(c);
      const channelId = await openChannel(c);
      chain.set(channelId, channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 25000n }));
      // The disk fills up just as the scheme saves the next call's reconciled
      // state (cumulative 2000); every other write goes through.
      const save = FileChannelStorage.prototype.set;
      let failed = false;
      vi.spyOn(FileChannelStorage.prototype, "set").mockImplementation(async function (this: FileChannelStorage, key, record) {
        if (!failed && record.pending === undefined && record.chargedCumulativeAmount === "2000") {
          failed = true;
          throw new Error("ENOSPC: no space left on device");
        }
        return save.call(this, key, record);
      });
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async () => servedWithVoucher(operator, channelId, 2000n, 1000n),
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          expect(decodePayment(init).payload.type).toBe("authorization");
          return servedWithVoucher(operator, channelId, 3000n, 1000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(failed).toBe(true);
      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).not.toHaveBeenCalled();
      // Re-read with the 1000 confirmed plus that call's 1000, not 2000 plus 1000 again.
      expect(events).toEqual([expect.objectContaining({ type: "resync", reason: "receipt_unreconciled" })]);
      expect(events[0].detail).toContain("cumulative=2000");
      expect(storedRecord()).toMatchObject({ channelId, chargedCumulativeAmount: "3000" });
    });

    it("does the same with channelStore: false", async () => {
      const c = kept({ channelStore: false });
      stubExact(c);
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          return new Response(JSON.stringify(CHAT_OK), { status: 200 }); // no receipt at all
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          expect(decodePayment(init).payload.type).toBe("authorization");
          return servedWithVoucher(operator, channelId, 2000n, 1000n);
        }
      );

      await c.chat("openai/gpt-4o-mini", "gm");
      chain.set(channelId, channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 25000n, settled: 1000n }));
      await c.chat("openai/gpt-4o-mini", "gm");

      expect(events).toEqual([expect.objectContaining({ type: "resync", reason: "receipt_missing" })]);
      // Nothing receipted, so the cumulative comes from the chain's settled amount.
      expect(events[0].detail).toContain("cumulative=1000");
      expect(fs.existsSync(path.join(tmp, "channels.json"))).toBe(false);
    });

    it("re-reads a channel whose deposit got no answer, and keeps paying into it", async () => {
      const c = kept();
      const exact = stubExact(c);
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          throw new TypeError("fetch failed");
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("authorization");
          expect(channelIdOf(payment)).toBe(channelId);
          return servedWithVoucher(operator, channelId, 1000n, 1000n);
        }
      );

      const raised = await c.chat("openai/gpt-4o-mini", "gm").catch((err: unknown) => err);
      expect(raised).toMatchObject({ name: "BatchPaymentUnresolvedError", reason: "no_response", channelId, payloadKind: "open", depositInDoubt: true });
      expect((raised as Error).cause).toBeInstanceOf(TypeError);
      // The open landed after all.
      chain.set(channelId, channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 25000n }));
      await c.chat("openai/gpt-4o-mini", "gm");

      expect(exact).not.toHaveBeenCalled();
      expect(events).toEqual([
        expect.objectContaining({ type: "unresolved", reason: "no_response" }),
        expect.objectContaining({ type: "resync", reason: "deposit_unanswered" }),
      ]);
      expect(storedRecord()).toMatchObject({ channelId, deposit: "25000", chargedCumulativeAmount: "1000" });
    });

    /** The channel-account reads the SDK made for one channel: their commitment and minContextSlot. */
    const channelReads = (channelId: string) =>
      rpcCalls
        .filter((r) => r.method === "getAccountInfo" && r.params[0] === channelId)
        .map((r) => r.params[1] as { commitment?: string; minContextSlot?: number });

    it("pays exact while an unanswered open may still land, then opens afresh once finality is past it", async () => {
      const c = kept();
      const exact = stubExact(c);
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          throw new TypeError("fetch failed");
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 }),
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 }),
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("deposit");
          return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toBeInstanceOf(BatchPaymentUnresolvedError);
      // Hours of wall-clock time are not proof: only block heights are.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
      await c.chat("openai/gpt-4o-mini", "gm");
      expect(exact).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: "fallback", reason: "channel_resync_pending" });

      // Finalized exactly 300 blocks past the anchor: the open could still be in an unfinalized block.
      rpcClock.blockHeight += 300;
      await c.chat("openai/gpt-4o-mini", "gm");
      expect(exact).toHaveBeenCalledTimes(2);
      expect(events.at(-1)).toMatchObject({ type: "fallback", reason: "channel_resync_pending" });

      rpcClock.blockHeight += 1;
      await c.chat("openai/gpt-4o-mini", "gm");
      expect(exact).toHaveBeenCalledTimes(2);
      expect(events.at(-1)).toMatchObject({ type: "resync", reason: "deposit_unanswered" });
      expect(events.at(-1)?.detail).toContain("record dropped");
      // Every read was finalized, and the deciding one no older than the finality that proved expiry.
      const reads = channelReads(channelId);
      expect(reads.every((r) => r.commitment === "finalized")).toBe(true);
      expect(reads.at(-1)?.minContextSlot).toBe(rpcClock.blockHeight + 1_000);
      // The anchor is the SDK's own block height read, once.
      expect(rpcCalls.filter((r) => r.method === "getBlockHeight")).toHaveLength(1);
    });

    it("never signs another deposit while a top-up is in doubt, and resumes once it landed", async () => {
      const c = kept({ maxDeposit: "$1" });
      const exact = stubExact(c);
      const channelId = await openChannel(c);
      const payer = await c.getWalletAddress();
      chain.set(channelId, channelAccount({ payer, operator: operator.address, deposit: 25000n }));
      const signed: Array<Record<string, any>> = [];
      const batch = (respond: (payment: Record<string, any>) => Response | Promise<Response>) => (_url: string, init?: RequestInit) => {
        const payment = decodePayment(init);
        signed.push(payment);
        return respond(payment);
      };
      gateway.push(
        // A 30000 ceiling needs a top-up; it times out.
        () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
        batch(() => { throw new DOMException("The operation was aborted.", "AbortError"); }),
        // A small call would fit the confirmed deposit, but the wallet signs no batch payment while the top-up is in doubt.
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 }),
        // Another call that needs a top-up: exact again, no second top-up.
        () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      const raised = await c.chat("openai/gpt-4o-mini", "gm").catch((err: unknown) => err);
      expect(raised).toMatchObject({ reason: "no_response", payloadKind: "top-up", depositInDoubt: true, channelId });
      await c.chat("openai/gpt-4o-mini", "gm");
      await c.chat("openai/gpt-4o-mini", "gm");

      expect(signed).toHaveLength(1);
      expect(signed[0].payload.type).toBe("deposit");
      expect(exact).toHaveBeenCalledTimes(2);
      expect(events.slice(-2).map((e) => [e.type, e.reason])).toEqual([
        ["fallback", "channel_resync_pending"],
        ["fallback", "channel_resync_pending"],
      ]);

      // The top-up landed: the finalized channel shows it, the record adopts it, batch resumes.
      const toppedUp = 25000n + BigInt(signed[0].payload.deposit.amount);
      chain.set(channelId, channelAccount({ payer, operator: operator.address, deposit: toppedUp }));
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        batch((payment) => {
          expect(payment.payload.type).toBe("authorization");
          return servedWithVoucher(operator, channelId, 2000n, 1000n);
        })
      );
      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(storedRecord()).toMatchObject({ channelId, deposit: toppedUp.toString() });
      expect(exact).toHaveBeenCalledTimes(2);
    });

    it("does not let a finalized read that lags a confirmed top-up shrink the record", async () => {
      const c = kept({ maxDeposit: "$1" });
      const exact = stubExact(c);
      const channelId = await openChannel(c);
      const payer = await c.getWalletAddress();
      gateway.push(
        // A confirmed top-up: the gateway's voucher reconciles, the record holds 25000 + the top-up.
        () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
        async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 31000n, 30000n),
        // The next call is served without a receipt: the record is re-read before the one after.
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 }),
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );
      await c.chat("openai/gpt-4o-mini", "gm");
      const confirmed = BigInt(storedRecord().deposit);
      expect(confirmed).toBeGreaterThan(25000n);
      await c.chat("openai/gpt-4o-mini", "gm");
      // Finalized still shows only the open: the top-up is not finalized yet.
      chain.set(channelId, channelAccount({ payer, operator: operator.address, deposit: 25000n }));
      await c.chat("openai/gpt-4o-mini", "gm");

      expect(exact).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: "fallback", reason: "channel_resync_pending" });
      expect(BigInt(storedRecord().deposit)).toBe(confirmed);
    });

    it("pays exact and re-reads the channel when the chain holds more than the record before a top-up", async () => {
      const c = kept({ maxDeposit: "$1" });
      const exact = stubExact(c);
      const channelId = await openChannel(c);
      const payer = await c.getWalletAddress();
      // A deposit the record never heard about landed (say, before a crash).
      chain.set(channelId, channelAccount({ payer, operator: operator.address, deposit: 60000n }));
      gateway.push(
        () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 }),
        () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
        async (_url, init) => {
          const payment = decodePayment(init);
          // Sized from the chain's 60000, which already covers the call: no top-up.
          expect(payment.payload.type).toBe("authorization");
          return servedWithVoucher(operator, channelId, 31000n, 30000n);
        }
      );

      await c.chat("openai/gpt-4o-mini", "gm");
      expect(exact).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: "fallback", reason: "channel_resync_pending" });

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(events.at(-1)).toMatchObject({ type: "resync", reason: "deposit_unrecorded" });
      expect(storedRecord()).toMatchObject({ channelId, deposit: "60000" });
    });

    it.each([
      ["owned by another program", (acct: ReturnType<typeof channelAccount>) => ({ ...acct, owner: TOKEN_PROGRAM })],
      ["too short for a channel", (acct: ReturnType<typeof channelAccount>) => ({ ...acct, data: [Buffer.alloc(40).toString("base64"), "base64"] })],
      ["in an unsupported encoding", (acct: ReturnType<typeof channelAccount>) => ({ ...acct, data: ["3Bxs4h24hBtQy9rw", "base58"] })],
    ])("fails closed on an account %s, even once its deposit can no longer land", async (_label, corrupt) => {
      const c = kept();
      const exact = stubExact(c);
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          throw new TypeError("fetch failed");
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toBeInstanceOf(BatchPaymentUnresolvedError);
      const account = channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 25000n });
      chain.set(channelId, corrupt(account) as ReturnType<typeof channelAccount>);
      rpcClock.blockHeight += 10_000;
      await c.chat("openai/gpt-4o-mini", "gm");

      expect(exact).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        expect.objectContaining({ type: "unresolved", reason: "no_response" }),
        expect.objectContaining({ type: "fallback", reason: "channel_unreadable" }),
      ]);
      expect(c.getBatchStats().fallbacksByReason).toEqual({ channel_unreadable: 1 });
      // Only the original open was ever signed and sent.
      expect(gatewayCalls.filter((call) => {
        const header = (call.init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
        return header && header !== "exact-payload";
      })).toHaveLength(1);
    });

    it("keeps an orphaned record whose channel account is another payer's, and pays exact", async () => {
      const first = kept();
      stubExact(first);
      const channelId = await openChannel(first);
      const record = storedRecord();
      const file = path.join(tmp, "channels.json");
      const [key] = Object.keys(JSON.parse(fs.readFileSync(file, "utf8")));
      const orphaned = {
        ...record,
        hasConfirmedState: true,
        pending: [{ amount: "30000", chargedCumulativeAmount: "31000", deposit: "55000", operationKey: key, payment: { x402Version: 2, payload: { type: "deposit" } } }],
      };
      fs.writeFileSync(file, JSON.stringify({ [key]: orphaned }));
      const old = new Date(Date.now() - 600_000);
      fs.utimesSync(file, old, old);
      const stranger = (await generateKeyPairSigner()).address;
      chain.set(channelId, channelAccount({ payer: stranger, operator: operator.address, deposit: 55000n }));
      __resetBatchWalletsForTests();

      const second = kept();
      const exact = stubExact(second);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await second.chat("openai/gpt-4o-mini", "gm");

      expect(exact).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: "fallback", reason: "channel_unreadable" });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ [key]: orphaned });
    });

    it("pays exact, and opens nothing, when the chain cannot be read", async () => {
      const c = kept();
      const exact = stubExact(c);
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          return new Response(JSON.stringify({ error: "upstream_timeout" }), { status: 504 });
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toMatchObject({ reason: "outcome_unknown", status: 504 });
      rpcDown.add("getAccountInfo");
      await c.chat("openai/gpt-4o-mini", "gm");

      expect(exact).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        expect.objectContaining({ type: "unresolved", reason: "outcome_unknown", status: 504 }),
        expect.objectContaining({ type: "fallback", reason: "channel_resync_failed", detail: expect.stringContaining(channelId) }),
      ]);
      // Only the original open was ever sent.
      expect(gatewayCalls.filter((call) => {
        const header = (call.init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
        return header && header !== "exact-payload";
      })).toHaveLength(1);
    });

    it("decodes nothing, keeping the record and paying exact, while @x402/svm's channel layout does not match", async () => {
      const c = kept();
      const exact = stubExact(c);
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          throw new TypeError("fetch failed");
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 }),
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          expect(decodePayment(init).payload.type).toBe("authorization");
          return servedWithVoucher(operator, channelId, 1000n, 1000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toBeInstanceOf(BatchPaymentUnresolvedError);
      chain.set(channelId, channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 25000n }));
      svmLayout.shifted = true;
      await c.chat("openai/gpt-4o-mini", "gm");

      expect(exact).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: "fallback", reason: "channel_unreadable", detail: expect.stringContaining("layout") });
      expect(rpcCalls.some((r) => r.method === "getAccountInfo" && r.params[0] === channelId)).toBe(false);

      // A failed check is not cached: with a matching layout the re-read goes through.
      svmLayout.shifted = false;
      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(exact).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: "resync", reason: "deposit_unanswered" });
    });

    it.each([
      ["a 502", 502, "outcome_unknown"],
      ["a 429", 429, "ambiguous_rate_limit"],
    ])("counts a deposit whose success receipt came with %s once, and adopts it once the chain shows it", async (_label, status, reason) => {
      const c = kept();
      const exact = stubExact(c);
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          // A valid success receipt (the scheme commits the open), on an error status.
          const served = await servedWithVoucher(operator, channelId, 1000n, 1000n);
          return new Response(JSON.stringify({ error: "upstream_error" }), { status, headers: served.headers });
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          expect(decodePayment(init).payload.type).toBe("authorization");
          return servedWithVoucher(operator, channelId, 2000n, 1000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toMatchObject({ name: "BatchPaymentUnresolvedError", reason, payloadKind: "open" });
      // The open landed, with the 25000 it carried: once, not twice.
      chain.set(channelId, channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 25000n }));
      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).not.toHaveBeenCalled();
      expect(events.map((e) => [e.type, e.reason])).toEqual([["unresolved", reason], ["resync", "deposit_failed"]]);
      expect(storedRecord()).toMatchObject({ channelId, deposit: "25000", chargedCumulativeAmount: "2000" });
    });

    it("drops a stored channel the chain shows closed, signs no top-up into it, and opens afresh", async () => {
      const c = kept({ maxDeposit: "$1" });
      const exact = stubExact(c);
      const channelId = await openChannel(c);
      // The channel was closed (say, a payer-forced close from another device).
      chain.set(channelId, channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 25000n, status: 1, closureStartedAt: 1_759_000_000n }));
      let journaled: Record<string, any> = {};
      gateway.push(
        // A ceiling the stored record cannot cover: it would be a top-up.
        () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("deposit");
          [journaled] = Object.values(JSON.parse(fs.readFileSync(path.join(tmp, "channels.json.deposit-intents"), "utf8")).intents) as Array<Record<string, any>>;
          return servedWithVoucher(operator, channelIdOf(payment), 30000n, 30000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      // A fresh open, never a top-up of the closed channel.
      expect(journaled).toMatchObject({ kind: "open", cumulative: "0" });
      expect(journaled.knownDeposit).toBeUndefined();
      expect(exact).not.toHaveBeenCalled();
      expect(events).toEqual([
        expect.objectContaining({ type: "resync", reason: "channel_unusable", detail: expect.stringContaining("closing or closed; record dropped") }),
      ]);
      expect(storedRecord()).toMatchObject({ chargedCumulativeAmount: "30000", deposit: journaled.expectDeposit });
    });

    it.each([
      ["owned by another program", (acct: ReturnType<typeof channelAccount>) => ({ ...acct, owner: TOKEN_PROGRAM })],
      ["too short for a channel", (acct: ReturnType<typeof channelAccount>) => ({ ...acct, data: [Buffer.alloc(40).toString("base64"), "base64"] })],
      ["in an unsupported encoding", (acct: ReturnType<typeof channelAccount>) => ({ ...acct, data: ["3Bxs4h24hBtQy9rw", "base58"] })],
    ])("signs no top-up when the stored channel's account is %s, and keeps its record", async (_label, corrupt) => {
      const c = kept({ maxDeposit: "$1" });
      const exact = stubExact(c);
      const channelId = await openChannel(c);
      const saved = fs.readFileSync(path.join(tmp, "channels.json"), "utf8");
      const account = channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 25000n });
      chain.set(channelId, corrupt(account) as ReturnType<typeof channelAccount>);
      gateway.push(
        // A ceiling the stored record cannot cover: it would be a top-up.
        () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).toHaveBeenCalledTimes(1);
      expect((gatewayCalls.at(-1)?.init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"]).toBe("exact-payload");
      expect(events).toEqual([
        expect.objectContaining({ type: "fallback", reason: "channel_unreadable", detail: expect.stringContaining(channelId) }),
      ]);
      expect(fs.readFileSync(path.join(tmp, "channels.json"), "utf8")).toBe(saved);
    });

    it("signs no top-up into a stored channel the chain shows is another payer's, and keeps its record", async () => {
      const c = kept({ maxDeposit: "$1" });
      const exact = stubExact(c);
      const channelId = await openChannel(c);
      const saved = fs.readFileSync(path.join(tmp, "channels.json"), "utf8");
      const stranger = (await generateKeyPairSigner()).address;
      chain.set(channelId, channelAccount({ payer: stranger, operator: operator.address, deposit: 25000n }));
      gateway.push(
        () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).toHaveBeenCalledTimes(1);
      expect((gatewayCalls.at(-1)?.init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"]).toBe("exact-payload");
      expect(events).toEqual([expect.objectContaining({ type: "fallback", reason: "channel_unreadable" })]);
      expect(fs.readFileSync(path.join(tmp, "channels.json"), "utf8")).toBe(saved);
    });

    it("re-verifies a pending top-up left by a dead process instead of deleting the channel", async () => {
      const first = kept();
      stubExact(first);
      const channelId = await openChannel(first);
      // The process died while a top-up was in flight. The top-up landed.
      const record = storedRecord();
      const [key] = Object.keys(JSON.parse(fs.readFileSync(path.join(tmp, "channels.json"), "utf8")));
      fs.writeFileSync(
        path.join(tmp, "channels.json"),
        JSON.stringify({
          [key]: {
            ...record,
            hasConfirmedState: true,
            pending: [{ amount: "30000", chargedCumulativeAmount: "31000", deposit: "55000", operationKey: key, payment: { x402Version: 2, payload: { type: "deposit" } } }],
          },
        })
      );
      chain.set(channelId, channelAccount({ payer: await first.getWalletAddress(), operator: operator.address, deposit: 55000n, settled: 1000n }));
      __resetBatchWalletsForTests();

      const second = kept();
      const exact = stubExact(second);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("authorization");
          expect(channelIdOf(payment)).toBe(channelId);
          return servedWithVoucher(operator, channelId, 2000n, 1000n);
        }
      );

      await expect(second.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({ type: "resync", reason: "orphaned_deposit" });
      // The real deposit, read from the chain, not the stale confirmed figure.
      expect(storedRecord()).toMatchObject({ channelId, deposit: "55000", chargedCumulativeAmount: "2000" });
    });

    it("drops an orphaned open that never landed, once finality is past it", async () => {
      const first = kept();
      stubExact(first);
      const channelId = await openChannel(first);
      const record = storedRecord();
      const file = path.join(tmp, "channels.json");
      const [key] = Object.keys(JSON.parse(fs.readFileSync(file, "utf8")));
      // A never-confirmed open left by a process that died, with nothing on chain.
      fs.writeFileSync(file, JSON.stringify({ [key]: { ...record, pending: [{ amount: "5000", chargedCumulativeAmount: "5000", deposit: "25000", operationKey: key, payment: { x402Version: 2, payload: { type: "deposit" } } }] } }));
      // An old file says nothing about when the deposit can no longer land.
      const old = new Date(Date.now() - 600_000);
      fs.utimesSync(file, old, old);
      __resetBatchWalletsForTests();

      const second = kept();
      const exact = stubExact(second);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 }),
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("deposit");
          return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
        }
      );

      await expect(second.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(exact).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: "fallback", reason: "channel_resync_pending" });

      rpcClock.blockHeight += 301;
      await expect(second.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(exact).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: "resync", reason: "orphaned_deposit", detail: expect.stringContaining(`channel ${channelId}: no such channel`) });
    });

    describe("deposit intents", () => {
      const storeFile = () => path.join(tmp, "channels.json");
      const intentsFile = () => path.join(tmp, "channels.json.deposit-intents");
      const signatureOf = (init: RequestInit | undefined) => (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];

      it("journals a deposit's intent before sending it, and clears it once its receipt reconciles", async () => {
        const c = kept();
        stubExact(c);
        let journaled: any;
        let mode = 0;
        let payment: Record<string, any> = {};
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async (_url, init) => {
            payment = decodePayment(init);
            // On disk before the open reached the gateway.
            journaled = JSON.parse(fs.readFileSync(intentsFile(), "utf8"));
            mode = fs.statSync(intentsFile()).mode & 0o777;
            return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
          }
        );

        await c.chat("openai/gpt-4o-mini", "gm");

        expect(journaled.version).toBe(1);
        expect(Object.values(journaled.intents)).toEqual([
          expect.objectContaining({
            channelId: channelIdOf(payment),
            requestId: payment.payload.authorization.requestId,
            kind: "open",
            cumulative: "0",
            expectDeposit: "25000",
          }),
        ]);
        // It holds nothing that could be re-sent.
        expect(JSON.stringify(journaled)).not.toContain(payment.payload.deposit.transaction);
        if (process.platform !== "win32") expect(mode).toBe(0o600);
        expect(fs.existsSync(intentsFile())).toBe(false);
      });

      it("after a crash with a top-up in flight, signs no deposit and re-sends nothing until the chain settles it", async () => {
        const first = kept({ maxDeposit: "$1" });
        stubExact(first);
        const channelId = await openChannel(first);
        const payer = await first.getWalletAddress();
        let leftOnDisk: { store: string; intents: string } | undefined;
        let crashedTopUp = "";
        let topUp = 0n;
        gateway.push(
          () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
          async (_url, init) => {
            // The process dies right here, after sending the top-up. This is what it leaves on disk.
            leftOnDisk = { store: fs.readFileSync(storeFile(), "utf8"), intents: fs.readFileSync(intentsFile(), "utf8") };
            crashedTopUp = signatureOf(init)!;
            topUp = BigInt(decodePayment(init).payload.deposit.amount);
            return servedWithVoucher(operator, channelId, 31000n, 30000n);
          }
        );
        await first.chat("openai/gpt-4o-mini", "gm");
        fs.writeFileSync(storeFile(), leftOnDisk!.store);
        fs.writeFileSync(intentsFile(), leftOnDisk!.intents);
        __resetBatchWalletsForTests();
        const sentBefore = gatewayCalls.length;

        // A new process. The chain shows the channel, but not the top-up yet.
        const second = kept({ maxDeposit: "$1" });
        const exact = stubExact(second);
        chain.set(channelId, channelAccount({ payer, operator: operator.address, deposit: 25000n }));
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
        );
        await second.chat("openai/gpt-4o-mini", "gm");
        expect(exact).toHaveBeenCalledTimes(1);
        expect(events.at(-1)).toMatchObject({ type: "fallback", reason: "channel_resync_pending" });

        // The top-up landed: adopted from the finalized chain, and batch resumes.
        chain.set(channelId, channelAccount({ payer, operator: operator.address, deposit: 25000n + topUp }));
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async (_url, init) => {
            expect(decodePayment(init).payload.type).toBe("authorization");
            return servedWithVoucher(operator, channelId, 32000n, 1000n);
          }
        );
        await expect(second.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
        expect(events.find((e) => e.type === "resync")).toMatchObject({ reason: "orphaned_deposit" });
        expect(storedRecord()).toMatchObject({ channelId, deposit: (25000n + topUp).toString() });
        expect(fs.existsSync(intentsFile())).toBe(false);
        // The crashed process's top-up was never sent again.
        expect(gatewayCalls.slice(sentBefore).map((call) => signatureOf(call.init))).not.toContain(crashedTopUp);
      });

      it("never moves the stored cumulative backwards when an intent outlives its reconciled top-up", async () => {
        const first = kept({ maxDeposit: "$1" });
        stubExact(first);
        const channelId = await openChannel(first);
        const payer = await first.getWalletAddress();
        let topUp = 0n;
        // The top-up's receipt reconciles and the scheme saves the new state,
        // but its intent cannot be cleared (as if the process died first).
        vi.spyOn(FileIntentJournal.prototype, "remove").mockImplementationOnce(() => {
          throw new Error("EIO: i/o error");
        });
        gateway.push(
          () => quote402([exactAccept("30000"), batchAccept(operator.address, "30000")]),
          async (_url, init) => {
            topUp = BigInt(decodePayment(init).payload.deposit.amount);
            return servedWithVoucher(operator, channelId, 31000n, 30000n);
          }
        );
        await first.chat("openai/gpt-4o-mini", "gm");
        const toppedUp = (25000n + topUp).toString();
        expect(storedRecord()).toMatchObject({ channelId, chargedCumulativeAmount: "31000", deposit: toppedUp });
        // The leftover intent still holds the cumulative from before the top-up.
        expect(Object.values(JSON.parse(fs.readFileSync(intentsFile(), "utf8")).intents)).toEqual([
          expect.objectContaining({ kind: "top-up", cumulative: "1000", expectDeposit: toppedUp }),
        ]);
        __resetBatchWalletsForTests();

        // A new process. The top-up is finalized; the gateway has redeemed only
        // the first voucher so far, so settled lags the confirmed cumulative too.
        chain.set(channelId, channelAccount({ payer, operator: operator.address, deposit: 25000n + topUp, settled: 1000n }));
        const second = kept({ maxDeposit: "$1" });
        const exact = stubExact(second);
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async (_url, init) => {
            expect(decodePayment(init).payload.type).toBe("authorization");
            return servedWithVoucher(operator, channelId, 32000n, 1000n);
          }
        );
        await expect(second.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

        expect(exact).not.toHaveBeenCalled();
        expect(events.filter((e) => e.type === "resync")).toEqual([
          expect.objectContaining({ reason: "orphaned_deposit", detail: expect.stringContaining("cumulative=31000") }),
        ]);
        // The next voucher reconciled on top of the kept cumulative.
        expect(storedRecord()).toMatchObject({ channelId, chargedCumulativeAmount: "32000", deposit: toppedUp });
        expect(fs.existsSync(intentsFile())).toBe(false);
      });

      it("moves this wallet's intents from the journal path earlier builds used, leaving another wallet's", async () => {
        const first = kept({ maxDeposit: "$1" });
        stubExact(first);
        const channelId = await openChannel(first);
        const payer = await first.getWalletAddress();
        const [[key, record]] = Object.entries(JSON.parse(fs.readFileSync(storeFile(), "utf8")) as Record<string, Record<string, any>>);
        // An earlier build crashed with a top-up in flight, journaling it at
        // the old path, which another store (`channels`, another wallet) shares.
        const legacy = path.join(tmp, "channels.deposit-intents.json");
        const mine = { key, channelId, channelConfig: record.channelConfig, kind: "top-up", cumulative: "1000", expectDeposit: "55000", knownDeposit: "25000", at: 1 };
        const stranger = (await generateKeyPairSigner()).address;
        const theirs = { ...mine, key: "their-key", channelId: stranger, channelConfig: { ...record.channelConfig, payer: stranger } };
        fs.writeFileSync(legacy, JSON.stringify({ version: 1, intents: { [key]: mine, "their-key": theirs } }));
        __resetBatchWalletsForTests();

        // The top-up has not landed yet: the moved intent keeps the wallet from signing another deposit.
        chain.set(channelId, channelAccount({ payer, operator: operator.address, deposit: 25000n }));
        const second = kept({ maxDeposit: "$1" });
        const exact = stubExact(second);
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
        );
        await second.chat("openai/gpt-4o-mini", "gm");

        expect(exact).toHaveBeenCalledTimes(1);
        expect(events.at(-1)).toMatchObject({ type: "fallback", reason: "channel_resync_pending" });
        // (The re-read has since saved its anchor height into it.)
        expect(JSON.parse(fs.readFileSync(intentsFile(), "utf8")).intents).toEqual({ [key]: { ...mine, anchorHeight: expect.any(Number) } });
        expect(JSON.parse(fs.readFileSync(legacy, "utf8")).intents).toEqual({ "their-key": theirs });
      });

      it("keeps batch off when the journal at the old path cannot be read, moving nothing", async () => {
        const legacy = path.join(tmp, "channels.deposit-intents.json");
        fs.writeFileSync(legacy, JSON.stringify({ version: 1 }));
        const c = kept();
        const exact = stubExact(c);
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
        );

        await c.chat("openai/gpt-4o-mini", "gm");

        expect(exact).toHaveBeenCalledTimes(1);
        expect(events).toEqual([expect.objectContaining({ type: "fallback", reason: "deposit_journal_unreadable", detail: expect.stringContaining(legacy) })]);
        expect(fs.readFileSync(legacy, "utf8")).toBe(JSON.stringify({ version: 1 }));
        expect(fs.existsSync(intentsFile())).toBe(false);
      });

      it("sends no deposit it could not journal, and pays exact", async () => {
        const c = kept();
        const exact = stubExact(c);
        vi.spyOn(FileIntentJournal.prototype, "put").mockImplementation(() => {
          throw new Error("ENOSPC: no space left on device");
        });
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
        );

        await c.chat("openai/gpt-4o-mini", "gm");

        expect(exact).toHaveBeenCalledTimes(1);
        expect(gatewayCalls.map((call) => signatureOf(call.init))).toEqual([undefined, "exact-payload"]);
        expect(events).toEqual([expect.objectContaining({ type: "fallback", reason: "deposit_journal_failed", detail: expect.stringContaining("ENOSPC") })]);
        // The scheme's hold on the unsent open is released, not left wedged.
        expect(fs.existsSync(storeFile()) ? Object.keys(JSON.parse(fs.readFileSync(storeFile(), "utf8"))) : []).toEqual([]);
      });

      it("keeps batch off, paying exact, while the intent journal cannot be read", async () => {
        fs.mkdirSync(intentsFile()); // a directory where the journal file belongs
        const c = kept();
        const exact = stubExact(c);
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
        );

        await c.chat("openai/gpt-4o-mini", "gm");

        expect(exact).toHaveBeenCalledTimes(1);
        expect(gatewayCalls.map((call) => signatureOf(call.init))).toEqual([undefined, "exact-payload"]);
        expect(events).toEqual([expect.objectContaining({ type: "fallback", reason: "deposit_journal_unreadable" })]);
      });

      const wellFormed = {
        key: "k",
        channelId: "c",
        channelConfig: { payerAuthorizer: "op", token: USDC },
        kind: "open",
        cumulative: "0",
        expectDeposit: "25000",
        at: 1,
      };
      it.each([
        ["valid JSON without intents", { version: 1 }],
        ["no version", { intents: {} }],
        ["an unknown version", { version: 2, intents: {} }],
        ["intents as an array", { version: 1, intents: [] }],
        ["an intent without its expected deposit", { version: 1, intents: { k: { ...wellFormed, expectDeposit: undefined } } }],
        ["an intent with a numeric amount", { version: 1, intents: { k: { ...wellFormed, cumulative: 0 } } }],
        ["an intent of an unknown kind", { version: 1, intents: { k: { ...wellFormed, kind: "withdraw" } } }],
        ["an intent filed under another key", { version: 1, intents: { other: wellFormed } }],
        ["a JSON array", []],
        ["null", null],
      ])("keeps batch off, paying exact, for a journal with %s, never reading it as empty", async (_label, content) => {
        const written = JSON.stringify(content);
        fs.writeFileSync(intentsFile(), written);
        const c = kept();
        const exact = stubExact(c);
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
        );

        await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

        expect(exact).toHaveBeenCalledTimes(1);
        expect(gatewayCalls.map((call) => signatureOf(call.init))).toEqual([undefined, "exact-payload"]);
        expect(events).toEqual([
          expect.objectContaining({ type: "fallback", reason: "deposit_journal_unreadable", detail: expect.stringContaining("not valid") }),
        ]);
        // Left exactly as found.
        expect(fs.readFileSync(intentsFile(), "utf8")).toBe(written);
      });

      it("pays exact, sending nothing, when the wallet's batch state cannot be set up", async () => {
        fs.writeFileSync(path.join(tmp, "not-a-dir"), "");
        const c = kept({ channelStore: path.join(tmp, "not-a-dir", "channels.json") });
        const exact = stubExact(c);
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
        );

        await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

        expect(exact).toHaveBeenCalledTimes(1);
        expect(events).toEqual([expect.objectContaining({ type: "fallback", reason: "payment_creation_failed" })]);
      });

      it("keeps intents in memory only with channelStore: false (no crash recovery there)", async () => {
        const c = kept({ channelStore: false });
        stubExact(c);
        let files: string[] = [];
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async (_url, init) => {
            files = fs.readdirSync(tmp);
            return servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n);
          }
        );

        await c.chat("openai/gpt-4o-mini", "gm");

        expect(files).toEqual([]);
      });
    });

    it("decodes the channel accounts the upstream scheme itself adopts on-chain", async () => {
      // A wallet with no local record finds its channel through the scheme's
      // own scan, which decodes and PDA-checks the account. That pins the
      // test encoder (and the SDK's decoder) to the upstream layout.
      const opener = kept();
      stubExact(opener);
      const channelId = await openChannel(opener);
      const payer = await opener.getWalletAddress();
      fs.rmSync(path.join(tmp, "channels.json"));
      __resetBatchWalletsForTests();
      chain.set(channelId, channelAccount({ payer, operator: operator.address, deposit: 40000n, settled: 3000n }));
      scannable = true;

      const c = kept();
      stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("authorization");
          expect(channelIdOf(payment)).toBe(channelId);
          return servedWithVoucher(operator, channelId, 4000n, 1000n);
        }
      );
      await c.chat("openai/gpt-4o-mini", "gm");
      expect(storedRecord()).toMatchObject({ channelId, deposit: "40000", chargedCumulativeAmount: "4000" });

      const account = chain.get(channelId)!;
      expect(decodeChannelAccount(account.owner, Buffer.from(account.data[0], "base64"))).toEqual({
        deposit: 40000n,
        settled: 3000n,
        open: true,
        payer,
        authorizedSigner: operator.address,
        mint: USDC,
      });
    });
  });

  describe("maxDeposit caps the escrow at stake", () => {
    let events: SolanaBatchEvent[];

    beforeEach(() => {
      events = [];
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    /**
     * maxDeposit $0.05 = 50000. Open with 25000 (5 x the 5000 ceiling), then a
     * 25000-ceiling call tops up by the 25000 room left: lifetime deposits are
     * now 50000, the whole cap. Returns the channel id.
     */
    async function fillLifetimeCap(c: SolanaLLMClient): Promise<string> {
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.deposit.amount).toBe("25000");
          channelId = channelIdOf(payment);
          return servedWithVoucher(operator, channelId, 5000n, 5000n);
        },
        () => quote402([exactAccept("25000"), batchAccept(operator.address, "25000")]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("deposit");
          expect(payment.payload.deposit.amount).toBe("25000");
          return servedWithVoucher(operator, channelId, 30000n, 25000n);
        }
      );
      await c.chat("openai/gpt-4o-mini", "gm");
      await c.chat("openai/gpt-4o-mini", "gm");
      const [record] = Object.values(JSON.parse(fs.readFileSync(path.join(tmp, "channels.json"), "utf8"))) as Array<Record<string, string>>;
      expect(record).toMatchObject({ deposit: "50000", chargedCumulativeAmount: "30000" });
      return channelId;
    }

    it("keeps topping up past lifetime deposits >= maxDeposit while (deposit - settled) + topUp <= maxDeposit", async () => {
      const c = client({ maxDeposit: "$0.05", onEvent: (e) => events.push(e) });
      const exact = stubExact(c);
      const channelId = await fillLifetimeCap(c);
      // The gateway has settled 30000 of the 50000 on-chain: 20000 is at stake.
      chain.set(channelId, channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 50000n, settled: 30000n }));
      gateway.push(
        () => quote402([exactAccept("25000"), batchAccept(operator.address, "25000")]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("deposit");
          expect(channelIdOf(payment)).toBe(channelId);
          // The room is 50000 - (50000 - 30000) = 30000, all of it used (5 x 25000 is more).
          expect(payment.payload.deposit.amount).toBe("30000");
          return servedWithVoucher(operator, channelId, 55000n, 25000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      const [record] = Object.values(JSON.parse(fs.readFileSync(path.join(tmp, "channels.json"), "utf8"))) as Array<Record<string, string>>;
      expect(record).toMatchObject({ deposit: "80000", chargedCumulativeAmount: "55000" });
      // At stake after the top-up: 80000 - 30000 settled = 50000, exactly maxDeposit.
      expect(BigInt(record.deposit) - 30000n).toBe(50000n);
    });

    it("widens the cap only with the settled amount of the exact channel being topped up", async () => {
      const c = client({ maxDeposit: "$0.05", onEvent: (e) => events.push(e) });
      const exact = stubExact(c);
      const channelId = await fillLifetimeCap(c);
      const file = path.join(tmp, "channels.json");
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
      const [[key, record]] = Object.entries(stored);
      // Another channel to the same receiver, operator and asset, through a
      // different fee payer, with the same deposit, listed first in the store.
      const otherFeePayer = (await generateKeyPairSigner()).address;
      const otherChannel = (await generateKeyPairSigner()).address;
      const otherKey = key.replace(`:${FEE_PAYER}:`, `:${otherFeePayer}:`);
      expect(otherKey).not.toBe(key);
      fs.writeFileSync(file, JSON.stringify({ [otherKey]: { ...record, channelId: otherChannel }, [key]: record }));
      const payer = await c.getWalletAddress();
      // The other channel is mostly settled; this one has settled nothing.
      chain.set(otherChannel, channelAccount({ payer, operator: operator.address, deposit: 50000n, settled: 40000n }));
      chain.set(channelId, channelAccount({ payer, operator: operator.address, deposit: 50000n, settled: 0n }));
      gateway.push(
        () => quote402([exactAccept("25000"), batchAccept(operator.address, "25000")]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await c.chat("openai/gpt-4o-mini", "gm");

      // All 50000 of this channel is still at stake: no top-up fits, so exact.
      expect(exact).toHaveBeenCalledTimes(1);
      expect(events.map((e) => e.reason)).toEqual(["deposit_over_cap"]);
      expect(rpcCalls.some((r) => r.method === "getAccountInfo" && r.params[0] === otherChannel)).toBe(false);
    });

    it("drops an orphaned pending authorization before sizing a top-up after a restart", async () => {
      const first = client({ maxDeposit: "$0.05" });
      stubExact(first);
      const channelId = await fillLifetimeCap(first);
      const payer = await first.getWalletAddress();
      const file = path.join(tmp, "channels.json");
      const [[key, record]] = Object.entries(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>);
      // The process died with an authorization in flight (not a deposit).
      fs.writeFileSync(file, JSON.stringify({
        [key]: {
          ...record,
          hasConfirmedState: true,
          pending: [{ amount: "5000", chargedCumulativeAmount: "35000", deposit: "50000", operationKey: `${key}\u0000req`, payment: { x402Version: 2, payload: { type: "authorization" } } }],
        },
      }));
      chain.set(channelId, channelAccount({ payer, operator: operator.address, deposit: 50000n, settled: 30000n }));
      __resetBatchWalletsForTests();

      const c = client({ maxDeposit: "$0.05", onEvent: (e) => events.push(e) });
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept("25000"), batchAccept(operator.address, "25000")]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("deposit");
          expect(payment.payload.deposit.amount).toBe("30000");
          return servedWithVoucher(operator, channelId, 55000n, 25000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(exact).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    });

    it("pays exact, depositing nothing, when @x402/svm's channel layout is not the one the SDK decodes", async () => {
      const first = client({ maxDeposit: "$0.05" });
      stubExact(first);
      const channelId = await fillLifetimeCap(first);
      const file = path.join(tmp, "channels.json");
      const saved = fs.readFileSync(file, "utf8");
      // 30000 settled: a decode the SDK trusted would allow a 30000 top-up (see above).
      chain.set(channelId, channelAccount({ payer: await first.getWalletAddress(), operator: operator.address, deposit: 50000n, settled: 30000n }));
      // A restart with a peer @x402/svm whose channel account layout moved.
      svmLayout.shifted = true;
      __resetBatchWalletsForTests();
      rpcCalls.length = 0;

      const c = client({ maxDeposit: "$0.05", onEvent: (e) => events.push(e) });
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept("25000"), batchAccept(operator.address, "25000")]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).toHaveBeenCalledTimes(1);
      expect((gatewayCalls.at(-1)?.init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"]).toBe("exact-payload");
      expect(events).toEqual([
        expect.objectContaining({ type: "fallback", reason: "channel_unreadable", detail: expect.stringContaining("layout") }),
      ]);
      // The channel account was never decoded, and the record is kept as it was.
      expect(rpcCalls.some((r) => r.method === "getAccountInfo" && r.params[0] === channelId)).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toBe(saved);
    });

    it("sizes the top-up to the room left, never past the cap", async () => {
      const c = client({ maxDeposit: "$0.05" });
      stubExact(c);
      const channelId = await fillLifetimeCap(c);
      chain.set(channelId, channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 50000n, settled: 10000n }));
      gateway.push(
        () => quote402([exactAccept("25000"), batchAccept(operator.address, "25000")]),
        async (_url, init) => {
          const payment = decodePayment(init);
          // 50000 - (50000 - 10000) = 10000: enough for the 5000 shortfall, and no more.
          expect(payment.payload.deposit.amount).toBe("10000");
          return servedWithVoucher(operator, channelId, 55000n, 25000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
    });

    it("pays exact when even the unsettled room cannot cover the top-up, or settled is unknown", async () => {
      const c = client({ maxDeposit: "$0.05", onEvent: (e) => events.push(e) });
      const exact = stubExact(c);
      const channelId = await fillLifetimeCap(c);
      // Nothing settled yet: all 50000 is at stake, so no top-up fits.
      chain.set(channelId, channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 50000n, settled: 0n }));
      gateway.push(
        () => quote402([exactAccept("25000"), batchAccept(operator.address, "25000")]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );
      await c.chat("openai/gpt-4o-mini", "gm");
      // The chain cannot show the channel: nothing is assumed settled.
      chain.delete(channelId);
      gateway.push(
        () => quote402([exactAccept("25000"), batchAccept(operator.address, "25000")]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );
      await c.chat("openai/gpt-4o-mini", "gm");

      expect(exact).toHaveBeenCalledTimes(2);
      expect(events.map((e) => e.reason)).toEqual(["deposit_over_cap", "deposit_over_cap"]);
    });

    it.each([
      ["the 402's extra.minDeposit first", "15000", "$1", "15000"],
      ["5 x the ceiling when the 402 names none", undefined, "$1", "25000"],
      ["capped by the room maxDeposit leaves", "2000000", "$0.02", "20000"],
    ])("sizes an open from %s", async (_label, minDeposit, maxDeposit, expected) => {
      const c = client({ maxDeposit });
      stubExact(c);
      const accept = batchAccept(operator.address);
      if (minDeposit) (accept.extra as Record<string, unknown>).minDeposit = minDeposit;
      gateway.push(
        () => quote402([exactAccept(), accept]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.deposit.amount).toBe(expected);
          return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
    });

    it("reads the chain only when a call needs a top-up", async () => {
      const c = client({ maxDeposit: "$1" });
      stubExact(c);
      const channelId = await (async () => {
        let id = "";
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async (_url, init) => {
            id = channelIdOf(decodePayment(init));
            return servedWithVoucher(operator, id, 1000n, 1000n);
          },
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async () => servedWithVoucher(operator, id, 2000n, 1000n)
        );
        await c.chat("openai/gpt-4o-mini", "gm");
        await c.chat("openai/gpt-4o-mini", "gm");
        return id;
      })();

      expect(rpcCalls.filter((r) => r.method === "getAccountInfo" && r.params[0] === channelId)).toHaveLength(0);
    });
  });

  describe("rpcHeaders", () => {
    function withHeaders(rpcHeaders: Record<string, string> | undefined, batch: Parameters<typeof client>[0] = {}) {
      return new SolanaLLMClient({
        privateKey: TEST_BS58_KEY,
        rpcUrl: RPC_URL,
        ...(rpcHeaders ? { rpcHeaders } : {}),
        batch: { operators: [operator.address], channelStore: path.join(tmp, "channels.json"), ...batch },
      });
    }

    const headerOf = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);

    it("sends rpcHeaders on every RPC request the batch scheme makes, and nowhere else", async () => {
      const c = withHeaders({ "x-api-key": "rpc-secret" });
      stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n)
      );

      await c.chat("openai/gpt-4o-mini", "gm");

      // The open reads the mint, a blockhash, the slot, and scans for an existing channel.
      expect(rpcCalls.map((r) => r.method)).toEqual(expect.arrayContaining(["getAccountInfo", "getLatestBlockhash", "getSlot", "getProgramAccounts"]));
      for (const call of rpcCalls) {
        expect(headerOf(call.init, "x-api-key")).toBe("rpc-secret");
        // @solana/kit's own headers still win.
        expect(headerOf(call.init, "content-type")).toContain("application/json");
      }
      for (const call of gatewayCalls) expect(headerOf(call.init, "x-api-key")).toBeNull();

      // Outside a batch scheme call, the same URL is left alone.
      await fetch(RPC_URL, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "getSlot" }) });
      expect(headerOf(rpcCalls.at(-1)!.init, "x-api-key")).toBeNull();
    });

    it("sends them on the SDK's own channel re-read too", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const c = withHeaders({ Authorization: "Bearer rpc-token" });
      stubExact(c);
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          return new Response(JSON.stringify(CHAT_OK), { status: 200 }); // no receipt: re-read next time
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 2000n, 1000n)
      );

      await c.chat("openai/gpt-4o-mini", "gm");
      chain.set(channelId, channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 25000n }));
      await c.chat("openai/gpt-4o-mini", "gm");

      const reread = rpcCalls.find((r) => r.method === "getAccountInfo" && r.params[0] === channelId);
      expect(reread).toBeDefined();
      expect(headerOf(reread!.init, "authorization")).toBe("Bearer rpc-token");
    });

    it("honours SOLANA_RPC_API_KEY like the exact path does", async () => {
      vi.stubEnv("SOLANA_RPC_API_KEY", "env-key");
      try {
        const c = withHeaders(undefined);
        stubExact(c);
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n)
        );

        await c.chat("openai/gpt-4o-mini", "gm");

        expect(rpcCalls.length).toBeGreaterThan(0);
        for (const call of rpcCalls) expect(headerOf(call.init, "x-api-key")).toBe("env-key");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("still sends each client's headers when two copies of the SDK are loaded", async () => {
      // Two module instances, as with the CJS and ESM builds side by side, or
      // two installs of the package: each has its own module state.
      vi.resetModules();
      const copyA = await import("../../src/solana-client");
      vi.resetModules();
      const copyB = await import("../../src/solana-client");
      expect(copyA.SolanaLLMClient).not.toBe(copyB.SolanaLLMClient);
      const make = (Client: typeof SolanaLLMClient, key: string) =>
        new Client({
          privateKey: walletKey(),
          rpcUrl: RPC_URL,
          rpcHeaders: { "x-api-key": key },
          batch: { operators: [operator.address], channelStore: false },
        });
      const a = make(copyA.SolanaLLMClient, "copy-a");
      const b = make(copyB.SolanaLLMClient, "copy-b");
      stubExact(a);
      stubExact(b);
      for (let i = 0; i < 2; i += 1) {
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n)
        );
      }

      await a.chat("openai/gpt-4o-mini", "gm");
      const split = rpcCalls.length;
      await b.chat("openai/gpt-4o-mini", "gm");

      expect(split).toBeGreaterThan(0);
      expect(rpcCalls.length).toBeGreaterThan(split);
      for (const call of rpcCalls.slice(0, split)) expect(headerOf(call.init, "x-api-key")).toBe("copy-a");
      for (const call of rpcCalls.slice(split)) expect(headerOf(call.init, "x-api-key")).toBe("copy-b");
    });

    it("treats different rpcHeaders for one wallet as different batch options", async () => {
      const events: SolanaBatchEvent[] = [];
      vi.spyOn(console, "error").mockImplementation(() => {});
      const a = withHeaders({ "x-api-key": "one" });
      const b = withHeaders({ "x-api-key": "two" }, { onEvent: (e) => events.push(e) });
      stubExact(a);
      const exactB = stubExact(b);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n),
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await a.chat("openai/gpt-4o-mini", "gm");
      await b.chat("openai/gpt-4o-mini", "gm");

      expect(exactB).toHaveBeenCalledTimes(1);
      expect(events).toEqual([expect.objectContaining({ type: "fallback", reason: "wallet_config_conflict" })]);
    });
  });

  describe("two copies of the SDK in one process", () => {
    // Two module instances, as with the CJS and ESM builds side by side, or
    // two installs of the package. They share a pid, so per-copy state let
    // the second copy take the first copy's live lock for a stale one.
    async function twoCopies(batch: Parameters<typeof client>[0] = {}) {
      vi.resetModules();
      const copyA = await import("../../src/solana-client");
      vi.resetModules();
      const copyB = await import("../../src/solana-client");
      expect(copyA.SolanaLLMClient).not.toBe(copyB.SolanaLLMClient);
      const events: SolanaBatchEvent[] = [];
      const make = (Client: typeof SolanaLLMClient) =>
        new Client({
          privateKey: TEST_BS58_KEY,
          rpcUrl: RPC_URL,
          batch: { operators: [operator.address], channelStore: path.join(tmp, "channels.json"), onEvent: (e) => events.push(e), ...batch },
        });
      return { a: make(copyA.SolanaLLMClient), b: make(copyB.SolanaLLMClient), events };
    }

    it("sends one deposit when both copies pay concurrently, and keeps the lock", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { a, b, events } = await twoCopies();
      const exactA = stubExact(a);
      const exactB = stubExact(b);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const deposits: string[] = [];
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("deposit");
          deposits.push(channelIdOf(payment));
          await held;
          return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => {
          release();
          return new Response(JSON.stringify(CHAT_OK), { status: 200 });
        }
      );

      const first = a.chat("openai/gpt-4o-mini", "one");
      await vi.waitFor(() => expect(gatewayCalls).toHaveLength(2));
      const lock = fs.readFileSync(path.join(tmp, "channels.json.lock"), "utf8");
      const second = b.chat("openai/gpt-4o-mini", "two");
      await expect(Promise.all([first, second])).resolves.toEqual(["gm", "gm"]);

      expect(deposits).toHaveLength(1);
      expect(exactA).not.toHaveBeenCalled();
      expect(exactB).toHaveBeenCalledTimes(1);
      // The second copy saw the first copy's call in flight; it did not steal the lock.
      expect(events.map((e) => [e.type, e.reason])).toEqual([["fallback", "channel_busy"]]);
      expect(fs.readFileSync(path.join(tmp, "channels.json.lock"), "utf8")).toBe(lock);
    });

    it("holds both copies to one combined maxDeposit", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      // maxDeposit 50000: open 25000, then the room left is 25000 in total.
      const { a, b, events } = await twoCopies({ maxDeposit: "$0.05" });
      const exactA = stubExact(a);
      const exactB = stubExact(b);
      const deposits: bigint[] = [];
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          const payment = decodePayment(init);
          channelId = channelIdOf(payment);
          deposits.push(BigInt(payment.payload.deposit.amount));
          return servedWithVoucher(operator, channelId, 1000n, 1000n);
        },
        () => quote402([exactAccept("25000"), batchAccept(operator.address, "25000")]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("deposit");
          expect(channelIdOf(payment)).toBe(channelId);
          deposits.push(BigInt(payment.payload.deposit.amount));
          return servedWithVoucher(operator, channelId, 26000n, 25000n);
        },
        // Copy A now needs another top-up: copy B's top-up used the whole room.
        () => quote402([exactAccept("25000"), batchAccept(operator.address, "25000")]),
        (_url, init) => {
          const header = (init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"];
          // A copy with its own stale view of the channel would sign another top-up here.
          if (header !== "exact-payload") deposits.push(BigInt(decodePayment(init).payload.deposit?.amount ?? 0));
          return new Response(JSON.stringify(CHAT_OK), { status: 200 });
        }
      );

      await a.chat("openai/gpt-4o-mini", "open");
      await b.chat("openai/gpt-4o-mini", "top up");
      await a.chat("openai/gpt-4o-mini", "over the cap");

      expect(deposits).toEqual([25000n, 25000n]);
      expect(deposits.reduce((sum, d) => sum + d, 0n)).toBeLessThanOrEqual(50000n);
      expect(exactB).not.toHaveBeenCalled();
      expect(exactA).toHaveBeenCalledTimes(1);
      expect(events.map((e) => e.reason)).toEqual(["deposit_over_cap"]);
    });
  });

  it("forgets the channel after closing it", async () => {
    const c = client({});
    stubExact(c);
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n),
      // closeBatchChannel: the refund probe, then the refund itself.
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      (_url, init) => {
        expect(decodePayment(init).payload.type).toBe("refund");
        const receipt = { success: true, transaction: "close-tx", network: NETWORK };
        return new Response("{}", {
          status: 200,
          headers: { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(receipt)).toString("base64") },
        });
      },
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      async (_url, init) => {
        // A fresh channel, not an authorization against the closed one.
        expect(decodePayment(init).payload.type).toBe("deposit");
        return servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n);
      }
    );

    await c.chat("openai/gpt-4o-mini", "gm");
    await expect(c.closeBatchChannel()).resolves.toMatchObject({ success: true });
    expect(fs.existsSync(path.join(tmp, "channels.json"))).toBe(false);
    await c.chat("openai/gpt-4o-mini", "gm");
  });

  describe("429 backoff and fallback visibility", () => {
    let sleeps: number[];
    let events: SolanaBatchEvent[];
    let logs: string[];

    beforeEach(() => {
      sleeps = [];
      events = [];
      logs = [];
      __setBatchSleepForTests(async (ms) => { sleeps.push(ms); });
      vi.spyOn(console, "error").mockImplementation((line: unknown) => { logs.push(String(line)); });
    });

    function observed(batch: Parameters<typeof client>[0] = {}) {
      return client({ onEvent: (event) => events.push(event), ...batch });
    }

    /** A rate-limited answer to a batch payment. */
    function tooMany(headers: Record<string, string> = {}, body?: unknown): Response {
      return new Response(body === undefined ? "" : JSON.stringify(body), { status: 429, headers });
    }

    /** A failed receipt proving the deposit went nowhere: the facilitator's capacity / rate limit. */
    function preBroadcast(errorReason = "batch_deposit_rate_limited"): Record<string, string> {
      return receipt({ success: false, errorReason, transaction: "" });
    }

    it("waits out Retry-After (seconds), then retries the open and is paid with batch", async () => {
      const c = observed();
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        (_url, init) => {
          expect(decodePayment(init).payload.type).toBe("deposit");
          return tooMany(
            { "Retry-After": "30", ...preBroadcast("batch_account_channel_capacity_exhausted") },
            { errorReason: "batch_account_channel_capacity_exhausted" }
          );
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]), // fresh challenge after the wait
        async (_url, init) => {
          const payment = decodePayment(init);
          // The refused open landed nothing, so the retry is an open again.
          expect(payment.payload.type).toBe("deposit");
          return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).not.toHaveBeenCalled();
      expect(sleeps).toEqual([30_000]);
      expect(events.map((e) => [e.type, e.reason])).toEqual([["backoff", "rate_limited"], ["recovered", "rate_limited"]]);
      expect(events[0]).toMatchObject({
        status: 429,
        errorReason: "batch_account_channel_capacity_exhausted",
        retryAfterMs: 30_000,
        attempt: 1,
        wallet: await c.getWalletAddress(),
      });
      expect(typeof events[0].at).toBe("number");
      expect(events[1]).toMatchObject({ attempt: 2 });
      expect(c.getBatchStats()).toEqual({
        fallbacks: 0,
        fallbacksByReason: {},
        backoffs: 1,
        retries: 1,
        recoveries: 1,
        resyncs: 0,
        unresolved: 0,
        unresolvedByReason: {},
      });
      expect(c.getSpending()).toEqual({ totalUsd: 0.001, calls: 1 });
      expect(logs.some((l) => /event=backoff reason=rate_limited status=429 errorReason=batch_account_channel_capacity_exhausted retryAfterMs=30000 attempt=1 wallet=\S+ next=retry/.test(l))).toBe(true);
    });

    it("fetches a fresh 402 after the wait and builds the retried open from it", async () => {
      const c = observed();
      stubExact(c);
      const blockhash = () => bs58.encode(generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32));
      const withBlockhash = (hash: string) => {
        const accept = batchAccept(operator.address);
        Object.assign(accept.extra, { recentBlockhash: hash, lastValidBlockHeight: 430_673_687 });
        return accept;
      };
      const original = blockhash();
      const fresh = blockhash();
      gateway.push(
        () => quote402([exactAccept(), withBlockhash(original)]),
        (_url, init) => {
          expect(decodePayment(init).accepted.extra.recentBlockhash).toBe(original);
          return tooMany({ "Retry-After": "30", ...preBroadcast() });
        },
        (_url, init) => {
          // The unpaid challenge: no payment on it.
          expect((init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"]).toBeUndefined();
          return quote402([exactAccept(), withBlockhash(fresh)]);
        },
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("deposit");
          // Rebuilt against the fresh challenge, not the stale one.
          expect(payment.accepted.extra.recentBlockhash).toBe(fresh);
          return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(gatewayCalls).toHaveLength(4);
    });

    /** Whether each gateway call carried a payment (an unpaid request carries none). */
    const paidCalls = () => gatewayCalls.map((call) => Boolean((call.init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"]));

    it("returns a 2xx answer to the fresh challenge as the call's result, paying nothing more", async () => {
      const c = observed();
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => tooMany({ "Retry-After": "1", ...preBroadcast() }),
        // The fresh challenge: the gateway served the request without a payment.
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).not.toHaveBeenCalled();
      // The unpaid request, the batch payment the 429 proved uncharged, the unpaid challenge: nothing after it.
      expect(paidCalls()).toEqual([false, true, false]);
      expect(events.map((e) => [e.type, e.reason])).toEqual([
        ["backoff", "rate_limited"],
        ["recovered", "served_unpaid_on_rechallenge"],
      ]);
      expect(events[1]).toMatchObject({ status: 200, attempt: 2 });
      expect(c.getBatchStats()).toMatchObject({ fallbacks: 0, backoffs: 1, recoveries: 1 });
      expect(c.getSpending()).toEqual({ totalUsd: 0, calls: 0 });
    });

    it.each([
      ["a 503", () => new Response(JSON.stringify({ error: "overloaded" }), { status: 503 })],
      ["no answer", () => { throw new TypeError("fetch failed"); }],
    ])("raises an unpaid error, never exact against the stale challenge, when the fresh challenge gets %s", async (_label, answer) => {
      const c = observed();
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => tooMany({ "Retry-After": "1", ...preBroadcast() }),
        answer
      );

      const raised = await c.chat("openai/gpt-4o-mini", "gm").catch((err: unknown) => err);

      expect(raised).toBeInstanceOf(Error);
      expect(retryDisposition(raised)).toBe("unpaid");
      expect(exact).not.toHaveBeenCalled();
      expect(paidCalls()).toEqual([false, true, false]);
      expect(events.map((e) => [e.type, e.reason])).toEqual([["backoff", "rate_limited"]]);
      expect(c.getBatchStats()).toMatchObject({ fallbacks: 0, unresolved: 0 });
    });

    it("lets chatCompletion() move on to fallbackModels when the fresh challenge gets a 503", async () => {
      const c = observed();
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => tooMany({ "Retry-After": "1", ...preBroadcast() }),
        () => new Response(JSON.stringify({ error: "overloaded" }), { status: 503 }),
        // The fallback model's first request, served without a payment.
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      const result = await c.chatCompletion("openai/gpt-4o-mini", [{ role: "user", content: "gm" }], {
        fallbackModels: ["anthropic/claude-sonnet-4.6"],
      });

      expect(result.choices[0].message.content).toBe("gm");
      expect(gatewayCalls.map((call) => JSON.parse(String(call.init?.body)).model)).toEqual([
        "openai/gpt-4o-mini",
        "openai/gpt-4o-mini",
        "openai/gpt-4o-mini",
        "anthropic/claude-sonnet-4.6",
      ]);
      expect(paidCalls()).toEqual([false, true, false, false]);
      expect(exact).not.toHaveBeenCalled();
    });

    it("reads Retry-After as an HTTP date", async () => {
      const now = Date.parse("2026-10-03T00:00:00Z");
      vi.spyOn(Date, "now").mockReturnValue(now);
      const c = observed();
      stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => tooMany({ "Retry-After": new Date(now + 5_000).toUTCString(), ...preBroadcast() }),
        () => quote402([exactAccept(), batchAccept(operator.address)]), // fresh challenge after the wait
        async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n)
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(sleeps).toEqual([5_000]);
      expect(events[0]).toMatchObject({ type: "backoff", retryAfterMs: 5_000 });
    });

    it("parses Retry-After seconds and dates, and ignores junk", () => {
      const now = Date.parse("2026-10-03T00:00:00Z");
      expect(parseRetryAfter("30", now)).toBe(30_000);
      expect(parseRetryAfter(" 0 ", now)).toBe(0);
      expect(parseRetryAfter("Sat, 03 Oct 2026 00:00:12 GMT", now)).toBe(12_000);
      expect(parseRetryAfter("Fri, 02 Oct 2026 23:59:00 GMT", now)).toBe(0);
      expect(parseRetryAfter("soon", now)).toBeUndefined();
      expect(parseRetryAfter(null, now)).toBeUndefined();
    });

    it("ignores a Retry-After that is not finite or is absurdly long", () => {
      const now = Date.parse("2026-10-03T00:00:00Z");
      // Number("9" x 400) * 1000 is Infinity.
      expect(parseRetryAfter("9".repeat(400), now)).toBeUndefined();
      expect(parseRetryAfter("99999999999", now)).toBeUndefined();
      expect(parseRetryAfter("Fri, 31 Dec 9999 23:59:59 GMT", now)).toBeUndefined();
      // Up to a day is still a delay.
      expect(parseRetryAfter("86400", now)).toBe(86_400_000);
      expect(parseRetryAfter("86401", now)).toBeUndefined();
    });

    it("backs off by default on a Retry-After too large to be a delay, and never parks the wallet", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter midpoint: exactly 1s
      const c = observed();
      const exact = stubExact(c);
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => tooMany({ "Retry-After": "9".repeat(400), ...preBroadcast() }),
        () => quote402([exactAccept(), batchAccept(operator.address)]), // fresh challenge after the wait
        async (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          return servedWithVoucher(operator, channelId, 1000n, 1000n);
        },
        // Once the default backoff is over, the next call goes straight to batch.
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          expect(decodePayment(init).payload.type).toBe("authorization");
          return servedWithVoucher(operator, channelId, 2000n, 1000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      // The test's sleep returns at once: let the 1 s backoff pass for real.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_001);
      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).not.toHaveBeenCalled();
      expect(sleeps).toEqual([1_000]);
      expect(events.map((e) => [e.type, e.reason, e.retryAfterMs])).toEqual([
        ["backoff", "rate_limited", 1_000],
        ["recovered", "rate_limited", undefined],
      ]);
    });

    it("caps the wallet's cooldown at maxWaitMs, so one long Retry-After cannot keep later calls off batch", async () => {
      const c = observed({ rateLimit: { maxWaitMs: 10_000 } });
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => tooMany({ "Retry-After": "3600", ...preBroadcast() }),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 }),
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => quote402([exactAccept(), batchAccept(operator.address)]), // fresh challenge after the wait
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("deposit");
          return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
        }
      );

      // An hour does not fit in this call's 10 s budget: it pays exact at once.
      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(exact).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
      expect(events).toEqual([expect.objectContaining({ type: "fallback", reason: "rate_limited", retryAfterMs: 3_600_000 })]);

      // The next call waits out at most maxWaitMs of the shared cooldown, then pays batch.
      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(exact).toHaveBeenCalledTimes(1);
      expect(sleeps).toHaveLength(1);
      expect(sleeps[0]).toBeGreaterThan(0);
      expect(sleeps[0]).toBeLessThanOrEqual(10_000);
      expect(events.slice(1).map((e) => [e.type, e.reason])).toEqual([["backoff", "cooldown"], ["recovered", "cooldown"]]);
    });

    it("backs off with jitter, and replays a receipt-less 429 on an authorization once", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter midpoint: exactly 1s
      const c = observed();
      const exact = stubExact(c);
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          return servedWithVoucher(operator, channelId, 1000n, 1000n);
        }
      );
      await c.chat("openai/gpt-4o-mini", "gm");
      // A bare 429 on an authorization: the same authorization is replayed.
      const requestIds: string[] = [];
      const authorization = (respond: () => Response | Promise<Response>) => (_url: string, init?: RequestInit) => {
        const payment = decodePayment(init);
        expect(payment.payload.type).toBe("authorization");
        requestIds.push(payment.payload.authorization.requestId);
        return respond();
      };
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        authorization(() => tooMany()),
        authorization(() => servedWithVoucher(operator, channelId, 2000n, 1000n))
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(requestIds).toHaveLength(2);
      expect(new Set(requestIds).size).toBe(1);

      expect(exact).not.toHaveBeenCalled();
      expect(sleeps).toEqual([1_000]);
      expect(events.map((e) => e.type)).toEqual(["backoff", "recovered"]);
      expect(events[0].errorReason).toBeUndefined();
      expect(c.getBatchStats()).toMatchObject({ backoffs: 1, retries: 1, recoveries: 1, fallbacks: 0 });
    });

    it("pays exact once the retries are exhausted, and says so", async () => {
      const c = observed();
      const exact = stubExact(c);
      const limited = () =>
        tooMany({ "Retry-After": "1", ...preBroadcast() }, { error: "rate_limited", errorReason: "batch_deposit_rate_limited" });
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        limited,
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        limited,
        () => quote402([exactAccept("6000"), batchAccept(operator.address, "6000")]),
        limited,
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).toHaveBeenCalledTimes(1);
      expect((gatewayCalls[6].init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"]).toBe("exact-payload");
      // Exact is signed against the freshest challenge, not the first one.
      const [, signedAgainst] = exact.mock.calls[0] as unknown as [string, { accepts: Array<{ amount: string }> }];
      expect(signedAgainst.accepts[0].amount).toBe("6000");
      expect(sleeps).toEqual([1_000, 1_000]);
      expect(events.map((e) => e.type)).toEqual(["backoff", "backoff", "fallback"]);
      expect(events[2]).toMatchObject({
        type: "fallback",
        reason: "rate_limited",
        status: 429,
        errorReason: "batch_deposit_rate_limited",
        attempt: 3,
      });
      expect(c.getBatchStats()).toEqual({
        fallbacks: 1,
        fallbacksByReason: { rate_limited: 1 },
        backoffs: 2,
        retries: 2,
        recoveries: 0,
        resyncs: 0,
        unresolved: 0,
        unresolvedByReason: {},
      });
      // Only the exact payment is booked.
      expect(c.getSpending()).toEqual({ totalUsd: 0.005, calls: 1 });
      expect(logs.filter((l) => l.includes("event=fallback reason=rate_limited status=429"))).toHaveLength(1);
      expect(logs.find((l) => l.includes("event=fallback"))).toMatch(/next=exact/);
    });

    it("does not wait longer than rateLimit.maxWaitMs: pays exact straight away instead", async () => {
      const c = observed({ rateLimit: { maxWaitMs: 10_000 } });
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => tooMany({ "Retry-After": "30", ...preBroadcast() }),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await c.chat("openai/gpt-4o-mini", "gm");

      expect(sleeps).toEqual([]);
      expect(exact).toHaveBeenCalledTimes(1);
      expect(events).toEqual([expect.objectContaining({ type: "fallback", reason: "rate_limited", retryAfterMs: 30_000, attempt: 1 })]);
    });

    it("keeps other calls for the wallet from sending opens during a 429 cooldown", async () => {
      const releases: Array<() => void> = [];
      __setBatchSleepForTests((ms) => {
        sleeps.push(ms);
        return new Promise<void>((resolve) => releases.push(resolve));
      });
      const c = observed();
      const exact = stubExact(c);
      const deposits: string[] = [];
      let limitedOnce = false;
      // Requests may arrive in either order once both calls wake, so route by content.
      const route = async (_url: string, init?: RequestInit): Promise<Response> => {
        const header = (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
        if (!header) return quote402([exactAccept(), batchAccept(operator.address)]);
        if (header === "exact-payload") return new Response(JSON.stringify(CHAT_OK), { status: 200 });
        const payment = decodePayment(init);
        expect(payment.payload.type).toBe("deposit");
        deposits.push(channelIdOf(payment));
        if (!limitedOnce) {
          limitedOnce = true;
          return tooMany({ "Retry-After": "2", ...preBroadcast() });
        }
        return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
      };
      for (let i = 0; i < 10; i += 1) gateway.push(route);

      const first = c.chat("openai/gpt-4o-mini", "one");
      await vi.waitFor(() => expect(sleeps).toHaveLength(1));
      const second = c.chat("openai/gpt-4o-mini", "two");
      await vi.waitFor(() => expect(sleeps).toHaveLength(2));

      // The second call is waiting on the first call's cooldown: it sent its
      // unpaid request and nothing else, in particular no channel open.
      expect(gatewayCalls).toHaveLength(3);
      expect(deposits).toHaveLength(1);
      expect(events.map((e) => [e.type, e.reason])).toEqual([["backoff", "rate_limited"], ["backoff", "cooldown"]]);
      expect(sleeps[1]).toBeGreaterThan(0);
      expect(sleeps[1]).toBeLessThanOrEqual(2_000);

      for (const release of releases) release();
      await expect(Promise.all([first, second])).resolves.toEqual(["gm", "gm"]);

      // One retried open; the other call paid exact rather than open a second channel.
      expect(deposits).toHaveLength(2);
      expect(deposits[1]).toBe(deposits[0]);
      expect(exact).toHaveBeenCalledTimes(1);
      expect(c.getBatchStats()).toMatchObject({ backoffs: 2, retries: 1, recoveries: 1, fallbacksByReason: { channel_busy: 1 } });
    });

    it("counts a retry only when the retried payment is actually sent", async () => {
      const releases: Array<() => void> = [];
      __setBatchSleepForTests((ms) => {
        sleeps.push(ms);
        return new Promise<void>((resolve) => releases.push(resolve));
      });
      const c = observed();
      const exact = stubExact(c);
      const deposits: string[] = [];
      let serveSecond!: () => void;
      const secondHeld = new Promise<void>((resolve) => { serveSecond = resolve; });
      const route = async (_url: string, init?: RequestInit): Promise<Response> => {
        const header = (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
        if (!header) return quote402([exactAccept(), batchAccept(operator.address)]);
        if (header === "exact-payload") return new Response(JSON.stringify(CHAT_OK), { status: 200 });
        const payment = decodePayment(init);
        deposits.push(channelIdOf(payment));
        if (deposits.length === 1) return tooMany({ "Retry-After": "2", ...preBroadcast() });
        await secondHeld;
        return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
      };
      for (let i = 0; i < 10; i += 1) gateway.push(route);

      const first = c.chat("openai/gpt-4o-mini", "one");
      await vi.waitFor(() => expect(sleeps).toHaveLength(1));
      const second = c.chat("openai/gpt-4o-mini", "two");
      await vi.waitFor(() => expect(sleeps).toHaveLength(2));

      // The waiting call wakes first and takes the channel...
      releases[1]();
      await vi.waitFor(() => expect(deposits).toHaveLength(2));
      // ...so the rate-limited call finds it busy and pays exact, sending no retry.
      releases[0]();
      await expect(first).resolves.toBe("gm");
      expect(exact).toHaveBeenCalledTimes(1);
      expect(c.getBatchStats()).toMatchObject({ retries: 0, fallbacksByReason: { channel_busy: 1 } });

      serveSecond();
      await expect(second).resolves.toBe("gm");
      expect(c.getBatchStats()).toMatchObject({ retries: 0, backoffs: 2, recoveries: 1 });
    });

    it("falls back immediately on a non-429 refusal, and reports it", async () => {
      const c = observed();
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        () => new Response(JSON.stringify({ error: "batch_admission_paused" }), { status: 503 }),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await c.chat("openai/gpt-4o-mini", "gm");

      expect(sleeps).toEqual([]);
      expect(exact).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        expect.objectContaining({ type: "fallback", reason: "batch_admission_paused", status: 503, errorReason: "batch_admission_paused", attempt: 1 }),
      ]);
      expect(c.getBatchStats().fallbacksByReason).toEqual({ batch_admission_paused: 1 });
    });

    it("never re-sends a batch payment the 429 says was charged", async () => {
      const c = observed();
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          const served = await servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n);
          // Charged (a valid receipt), then the model was rate limited.
          return new Response(JSON.stringify({ error: "upstream_rate_limited" }), { status: 429, headers: served.headers });
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toMatchObject({
        name: "BatchPaymentUnresolvedError",
        reason: "ambiguous_rate_limit",
        status: 429,
      });

      expect(exact).not.toHaveBeenCalled();
      expect(sleeps).toEqual([]);
      expect(gatewayCalls).toHaveLength(2);
      expect(events).toEqual([
        expect.objectContaining({ type: "unresolved", reason: "ambiguous_rate_limit", status: 429, errorReason: "upstream_rate_limited" }),
      ]);
    });

    function receipt(fields: Record<string, unknown>): Record<string, string> {
      return { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ network: NETWORK, ...fields })).toString("base64") };
    }

    it("never retries a 429 whose receipt says a deposit may have been broadcast, and re-reads the channel", async () => {
      const c = observed();
      const exact = stubExact(c);
      let channelId = "";
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        (_url, init) => {
          channelId = channelIdOf(decodePayment(init));
          return tooMany(
            { "Retry-After": "1", ...receipt({ success: false, errorReason: "settlement_pending", transaction: "5vRtx" }) },
            { errorReason: "settlement_pending" }
          );
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => {
          const payment = decodePayment(init);
          // The open landed: the next call pays into it, it does not open again.
          expect(payment.payload.type).toBe("authorization");
          expect(channelIdOf(payment)).toBe(channelId);
          return servedWithVoucher(operator, channelId, 1000n, 1000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toBeInstanceOf(BatchPaymentUnresolvedError);
      expect(sleeps).toEqual([]);
      expect(exact).not.toHaveBeenCalled();
      expect(gatewayCalls).toHaveLength(2);

      chain.set(channelId, channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 25000n }));
      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(events).toEqual([
        expect.objectContaining({ type: "unresolved", reason: "ambiguous_rate_limit", errorReason: "settlement_pending" }),
        expect.objectContaining({ type: "resync", reason: "deposit_failed" }),
      ]);
    });

    describe("a payment that may have been charged is never paid again by a fallback model", () => {
      const timedOut = () => { throw new DOMException("The operation was aborted.", "AbortError"); };
      /**
       * How the gateway answers each send of the payment in doubt (the first
       * send, then its replay, if any), the unresolved reason, and the status
       * of the last answer.
       */
      const inDoubt: Array<[string, string, number | undefined, Array<(payment: Record<string, any>) => Response | Promise<Response>>]> = [
        ["a receipt-less 429 whose one replay is answered 429 again", "replay_unresolved", 429, [() => tooMany({ "Retry-After": "1" }), () => tooMany({ "Retry-After": "1" })]],
        // On a replay, a 402 or duplicate_settlement means the original reached the gateway.
        ["a receipt-less 429 whose replay is answered 402", "replay_unresolved", 402, [() => tooMany({ "Retry-After": "1" }), () => quote402([exactAccept(), batchAccept(operator.address)])]],
        [
          "a receipt-less 429 whose replay is answered duplicate_settlement",
          "replay_unresolved",
          402,
          [() => tooMany({ "Retry-After": "1" }), () => new Response(JSON.stringify({ x402Version: 2, error: "duplicate_settlement", accepts: [] }), { status: 402 })],
        ],
        [
          "a receipt-less 429 whose replay gets a receipt proving the replay was not broadcast",
          "replay_unresolved",
          429,
          [() => tooMany({ "Retry-After": "1" }), () => tooMany({ "Retry-After": "1", ...preBroadcast() })],
        ],
        ["a receipt-less 429 whose replay is answered 503", "replay_unresolved", 503, [() => tooMany({ "Retry-After": "1" }), () => new Response("{}", { status: 503 })]],
        ["a receipt-less 429 whose replay times out", "replay_unresolved", undefined, [() => tooMany({ "Retry-After": "1" }), timedOut]],
        // Only a definitive success receipt ends the doubt on a replay.
        [
          "a receipt-less 429 whose replay is served without a receipt",
          "replay_unresolved",
          200,
          [() => tooMany({ "Retry-After": "1" }), () => new Response(JSON.stringify(CHAT_OK), { status: 200 })],
        ],
        [
          "a 429 whose receipt says it was charged",
          "ambiguous_rate_limit",
          429,
          [
            async (payment) => {
              const served = await servedWithVoucher(operator, channelIdOf(payment), 2000n, 1000n);
              return new Response(JSON.stringify({ error: "upstream_rate_limited" }), { status: 429, headers: served.headers });
            },
          ],
        ],
        [
          "a 429 whose receipt names a transaction",
          "ambiguous_rate_limit",
          429,
          [
            () =>
              tooMany(
                { "Retry-After": "1", ...receipt({ success: false, errorReason: "settlement_pending", transaction: "5vRtx" }) },
                { errorReason: "settlement_pending" }
              ),
          ],
        ],
        ["a timeout on the first send", "no_response", undefined, [timedOut]],
        ["a network error on the first send", "no_response", undefined, [() => { throw new TypeError("fetch failed"); }]],
        ["a bare 503 on the first send", "outcome_unknown", 503, [() => new Response(JSON.stringify({ error: "upstream_unavailable" }), { status: 503 })]],
        ["a 503 naming an unrecognised batch_* code", "outcome_unknown", 503, [() => new Response(JSON.stringify({ error: "batch_something_new" }), { status: 503 })]],
        [
          "a 402 whose receipt names a transaction",
          "outcome_unknown",
          402,
          [() => new Response("{}", { status: 402, headers: receipt({ success: false, errorReason: "settlement_failed", transaction: "5vRtx" }) })],
        ],
        ["a 500 with a success receipt", "outcome_unknown", 500, [() => new Response("{}", { status: 500, headers: receipt({ success: true, transaction: "" }) })]],
      ];
      let requestIds: string[];

      /**
       * Open a channel, then queue the next call's 402 and `answer` for each
       * of its `sends` authorizations, followed by what a fallback model
       * would be offered: an exact-only 402 and an answer.
       */
      async function inDoubtThenFallback(
        c: SolanaLLMClient,
        answers: Array<(payment: Record<string, any>) => Response | Promise<Response>>
      ): Promise<void> {
        requestIds = [];
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n)
        );
        await c.chat("openai/gpt-4o-mini", "gm");
        gatewayCalls.length = 0;
        const authorization = (answer: (payment: Record<string, any>) => Response | Promise<Response>) => (_url: string, init?: RequestInit) => {
          const payment = decodePayment(init);
          expect(payment.payload.type).toBe("authorization");
          requestIds.push(payment.payload.authorization.requestId);
          return answer(payment);
        };
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          ...answers.map(authorization),
          () => quote402([exactAccept()]),
          () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
        );
      }

      async function expectRaisedWithoutFallback(
        c: SolanaLLMClient,
        raised: unknown,
        model: string,
        reason: string,
        status: number | undefined,
        sends: number
      ): Promise<void> {
        expect(raised).toBeInstanceOf(BatchPaymentUnresolvedError);
        expect(raised).toMatchObject({ reason, wallet: await c.getWalletAddress(), requestId: requestIds[0], payloadKind: "authorization" });
        expect((raised as BatchPaymentUnresolvedError).status).toBe(status);
        expect((raised as BatchPaymentUnresolvedError).channelId).toBeTruthy();
        expect(retryDisposition(raised)).toBe("paid-or-in-doubt");
        // Only the first model was requested: one challenge, then one authorization (replayed, if at all).
        expect(gatewayCalls.map((call) => JSON.parse(String(call.init?.body)).model)).toEqual(Array(1 + sends).fill(model));
        const signed = gatewayCalls.flatMap((call) => (call.init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"] ?? []);
        expect(signed).toHaveLength(sends);
        expect(new Set(signed).size).toBe(1);
        expect(new Set(requestIds).size).toBe(1);
        expect(gateway).toHaveLength(2); // the fallback model's challenge was never fetched
        expect(events.at(-1)).toMatchObject({ type: "unresolved", reason, status });
        expect(c.getBatchStats()).toMatchObject({ unresolved: 1, unresolvedByReason: { [reason]: 1 }, fallbacks: 0 });
        expect(c.getSpending()).toEqual({ totalUsd: 0.001, calls: 1 }); // the channel's first call only
      }

      it.each(inDoubt)("smartChat() raises after %s instead of moving on to its routed fallbacks", async (_label, reason, status, answers) => {
        const c = observed();
        const exact = stubExact(c);
        vi.spyOn(c as never, "getModelPricing" as never).mockResolvedValue(
          new Map([
            ["openai/gpt-5-mini", { inputPrice: 0.25, outputPrice: 2 }],
            ["google/gemini-3.5-flash", { inputPrice: 0.5, outputPrice: 3 }],
            ["deepseek/deepseek-chat", { inputPrice: 0.2, outputPrice: 0.4 }],
            ["anthropic/claude-sonnet-5", { inputPrice: 3, outputPrice: 15 }],
          ]) as never
        );
        const decision = await c.route("gm");
        expect(decision.fallbacks?.length).toBeGreaterThan(0);
        await inDoubtThenFallback(c, answers);

        const raised = await c.smartChat("gm").catch((err: unknown) => err);

        await expectRaisedWithoutFallback(c, raised, decision.model, reason, status, answers.length);
        expect(exact).not.toHaveBeenCalled();
      });

      it.each(inDoubt)("chatCompletion() raises after %s instead of moving on to explicit fallbackModels", async (_label, reason, status, answers) => {
        const c = observed();
        const exact = stubExact(c);
        await inDoubtThenFallback(c, answers);

        const raised = await c
          .chatCompletion("openai/gpt-4o-mini", [{ role: "user", content: "gm" }], {
            fallbackModels: ["anthropic/claude-sonnet-4.6"],
          })
          .catch((err: unknown) => err);

        await expectRaisedWithoutFallback(c, raised, "openai/gpt-4o-mini", reason, status, answers.length);
        expect(exact).not.toHaveBeenCalled();
      });
    });

    it.each([
      ["a bare 503", () => new Response(JSON.stringify({ error: "upstream_unavailable" }), { status: 503 })],
      ["a timeout", () => { throw new DOMException("The operation was aborted.", "AbortError"); }],
    ])("chatCompletion() never moves on to fallbackModels after %s on a batch payment", async (_label, answer) => {
      const c = observed();
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        answer,
        () => quote402([exactAccept()]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      const raised = await c
        .chatCompletion("openai/gpt-4o-mini", [{ role: "user", content: "gm" }], { fallbackModels: ["anthropic/claude-sonnet-4.6"] })
        .catch((err: unknown) => err);

      expect(retryDisposition(raised)).toBe("paid-or-in-doubt");
      expect(gatewayCalls.map((call) => JSON.parse(String(call.init?.body)).model)).toEqual(["openai/gpt-4o-mini", "openai/gpt-4o-mini"]);
      expect(gateway).toHaveLength(2);
      expect(exact).not.toHaveBeenCalled();
    });

    describe("a 429 with no receipt is replayed, never replaced", () => {
      const paymentHeader = (init: RequestInit | undefined) =>
        (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
      const batchSends = () =>
        gatewayCalls.map((call) => paymentHeader(call.init)).filter((h): h is string => !!h && h !== "exact-payload");
      const unpaid = () => gatewayCalls.filter((call) => !paymentHeader(call.init)).length;

      it("replays the identical open, byte for byte, and books its success once", async () => {
        const c = observed();
        const exact = stubExact(c);
        let first: Record<string, any> = {};
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          (_url, init) => {
            first = decodePayment(init);
            expect(first.payload.type).toBe("deposit");
            return tooMany({ "Retry-After": "30" });
          },
          async (_url, init) => {
            const replay = decodePayment(init);
            // Same request id, same signed authorization, same signed deposit transaction.
            expect(replay.payload.authorization.requestId).toBe(first.payload.authorization.requestId);
            expect(replay.payload.deposit.transaction).toBe(first.payload.deposit.transaction);
            return servedWithVoucher(operator, channelIdOf(replay), 1000n, 1000n);
          }
        );

        await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

        const sends = batchSends();
        expect(sends).toHaveLength(2);
        expect(sends[1]).toBe(sends[0]);
        expect(unpaid()).toBe(1); // no fresh challenge: nothing new was built
        expect(exact).not.toHaveBeenCalled();
        expect(c.getSpending()).toEqual({ totalUsd: 0.001, calls: 1 });
        expect(c.getBatchStats()).toMatchObject({ retries: 1, backoffs: 1, recoveries: 1, unresolved: 0 });
        const [record] = Object.values(JSON.parse(fs.readFileSync(path.join(tmp, "channels.json"), "utf8"))) as Array<Record<string, unknown>>;
        expect(record).toMatchObject({ chargedCumulativeAmount: "1000", deposit: "25000" });
      });

      it("raises replay_unresolved after its one replay, signing nothing new and never paying exact", async () => {
        const c = observed();
        const exact = stubExact(c);
        let channelId = "";
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async (_url, init) => {
            channelId = channelIdOf(decodePayment(init));
            return servedWithVoucher(operator, channelId, 1000n, 1000n);
          }
        );
        await c.chat("openai/gpt-4o-mini", "gm");
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          () => tooMany({ "Retry-After": "1" }),
          () => tooMany({ "Retry-After": "1" })
        );
        const before = batchSends().length;

        await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toMatchObject({
          name: "BatchPaymentUnresolvedError",
          reason: "replay_unresolved",
          status: 429,
        });

        const sends = batchSends().slice(before);
        expect(sends).toHaveLength(2);
        expect(new Set(sends).size).toBe(1); // one authorization, replayed once
        expect(exact).not.toHaveBeenCalled();
        expect(events.map((e) => [e.type, e.reason])).toEqual([
          ["backoff", "rate_limited"],
          ["unresolved", "replay_unresolved"],
        ]);
        expect(c.getBatchStats()).toMatchObject({ unresolved: 1, unresolvedByReason: { replay_unresolved: 1 }, fallbacks: 0, retries: 1 });
        expect(logs.some((l) => /event=unresolved reason=replay_unresolved status=429 .*next=raise/.test(l))).toBe(true);

        // The channel was released: the next call builds its own payment
        // (after waiting out the wallet's cooldown, from a fresh challenge).
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async (_url, init) => {
            expect(decodePayment(init).payload.type).toBe("authorization");
            return servedWithVoucher(operator, channelId, 2000n, 1000n);
          }
        );
        await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      });

      it("never replaces an authorization, even once it has expired: replays it, then raises", async () => {
        const c = observed({ rateLimit: { maxWaitMs: 10_000_000 } });
        const exact = stubExact(c);
        let channelId = "";
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async (_url, init) => {
            channelId = channelIdOf(decodePayment(init));
            return servedWithVoucher(operator, channelId, 1000n, 1000n);
          }
        );
        await c.chat("openai/gpt-4o-mini", "gm");
        const t0 = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
        // Each wait outlasts the authorization (valid for maxTimeoutSeconds, 3600s).
        __setBatchSleepForTests(async (ms) => {
          sleeps.push(ms);
          clock.mockReturnValue(Date.now() + ms + 1);
        });
        const requestIds: string[] = [];
        const limited = (_url: string, init?: RequestInit) => {
          requestIds.push(decodePayment(init).payload.authorization.requestId);
          return tooMany({ "Retry-After": "3700" });
        };
        gateway.push(() => quote402([exactAccept(), batchAccept(operator.address)]), limited, limited);

        await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toBeInstanceOf(BatchPaymentUnresolvedError);

        // Expiry is not proof it was never committed: the same authorization, replayed once.
        expect(requestIds).toHaveLength(2);
        expect(new Set(requestIds).size).toBe(1);
        expect(exact).not.toHaveBeenCalled();
        expect(events.at(-1)).toMatchObject({ type: "unresolved", reason: "replay_unresolved" });
      });

      it("never replaces a top-up, even when its blockhash expired and it did not land", async () => {
        const c = observed();
        const exact = stubExact(c);
        const payer = await c.getWalletAddress();
        let channelId = "";
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          async (_url, init) => {
            channelId = channelIdOf(decodePayment(init));
            return servedWithVoucher(operator, channelId, 1000n, 1000n);
          }
        );
        await c.chat("openai/gpt-4o-mini", "gm");
        const topUpAccept = batchAccept(operator.address, "30000");
        Object.assign(topUpAccept.extra, { recentBlockhash: "9T1tBhLxWWKf1XhD9deySUK2tNcmGQhBsR2tMKFLgFUL", lastValidBlockHeight: 1_000 });
        const sends: string[] = [];
        gateway.push(
          () => quote402([exactAccept("30000"), topUpAccept]),
          (_url, init) => {
            expect(decodePayment(init).payload.type).toBe("deposit");
            sends.push((init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"]);
            // Expired, and the chain still shows only the original deposit.
            rpcClock.blockHeight = 2_000;
            chain.set(channelId, channelAccount({ payer, operator: operator.address, deposit: 25000n }));
            return tooMany({ "Retry-After": "30" });
          },
          async (_url, init) => {
            sends.push((init?.headers as Record<string, string>)["PAYMENT-SIGNATURE"]);
            // Its authorization could be charged against the existing escrow: replayed, not replaced.
            return servedWithVoucher(operator, channelId, 31000n, 30000n);
          }
        );

        await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

        expect(sends).toHaveLength(2);
        expect(sends[1]).toBe(sends[0]);
        expect(exact).not.toHaveBeenCalled();
      });

      it("raises, rather than pay exact, when the gateway refuses the replay", async () => {
        const c = observed();
        const exact = stubExact(c);
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          () => tooMany({ "Retry-After": "1" }),
          () => new Response(JSON.stringify({ error: "batch_admission_paused" }), { status: 503 })
        );

        await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toMatchObject({
          name: "BatchPaymentUnresolvedError",
          status: 503,
        });
        expect(exact).not.toHaveBeenCalled();
        expect(events.at(-1)).toMatchObject({ type: "unresolved", reason: "replay_unresolved", status: 503 });
      });

      /** A batch accept that names its blockhash and its last valid block height, as a gateway may. */
      function withLifetime(lastValidBlockHeight: number) {
        const accept = batchAccept(operator.address);
        Object.assign(accept.extra, {
          recentBlockhash: "9T1tBhLxWWKf1XhD9deySUK2tNcmGQhBsR2tMKFLgFUL",
          lastValidBlockHeight,
        });
        return accept;
      }

      it("never replaces an open on chain evidence: a 402's lastValidBlockHeight, even forged, changes nothing", async () => {
        const c = observed();
        const exact = stubExact(c);
        const requestIds: string[] = [];
        const limited = (_url: string, init?: RequestInit) => {
          requestIds.push(decodePayment(init).payload.authorization.requestId);
          // The chain is far past the 402's claimed block 0, and no channel exists.
          rpcClock.blockHeight = 2_000;
          rpcClock.blockhashValid = false;
          return tooMany({ "Retry-After": "30" });
        };
        gateway.push(() => quote402([exactAccept(), withLifetime(0)]), limited, limited);

        await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toMatchObject({
          name: "BatchPaymentUnresolvedError",
          reason: "replay_unresolved",
          payloadKind: "open",
          depositInDoubt: true,
        });

        // The same open, replayed once: no fresh challenge, no new request id, no exact.
        expect(requestIds).toHaveLength(2);
        expect(new Set(requestIds).size).toBe(1);
        expect(unpaid()).toBe(1);
        expect(exact).not.toHaveBeenCalled();
        // Blockhash expiry is never consulted.
        expect(rpcCalls.some((r) => r.method === "getBlockHeight" || r.method === "isBlockhashValid")).toBe(false);
      });

      it("replays an open once whatever the chain shows, and books its success", async () => {
        const c = observed();
        stubExact(c);
        gateway.push(
          () => quote402([exactAccept(), withLifetime(1_000)]),
          async (_url, init) => {
            rpcClock.blockHeight = 2_000;
            // It landed; only the receipt was lost.
            chain.set(channelIdOf(decodePayment(init)), channelAccount({ payer: await c.getWalletAddress(), operator: operator.address, deposit: 25000n }));
            return tooMany({ "Retry-After": "30" });
          },
          async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n)
        );

        await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

        const sends = batchSends();
        expect(sends).toHaveLength(2);
        expect(sends[1]).toBe(sends[0]);
        expect(unpaid()).toBe(1);
      });

      it("replays without reading blockhash validity from the RPC", async () => {
        const c = observed();
        stubExact(c);
        gateway.push(
          () => quote402([exactAccept(), batchAccept(operator.address)]),
          () => tooMany({ "Retry-After": "30" }),
          async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n)
        );

        await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

        expect(rpcCalls.some((r) => r.method === "isBlockhashValid" || r.method === "getBlockHeight")).toBe(false);
        const sends = batchSends();
        expect(sends[1]).toBe(sends[0]);
      });
    });

    it("raises, never pays exact, when classifying an answer to a sent payment throws", async () => {
      const c = observed();
      const exact = stubExact(c);
      const payer = (c as unknown as { batchPayer: object }).batchPayer;
      vi.spyOn(payer as { classify: () => unknown }, "classify").mockRejectedValueOnce(new Error("classifier bug"));
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n)
      );

      const raised = await c.chat("openai/gpt-4o-mini", "gm").catch((err: unknown) => err);

      expect(raised).toMatchObject({ name: "BatchPaymentUnresolvedError", reason: "outcome_unknown", status: 200 });
      expect(exact).not.toHaveBeenCalled();
      expect(gatewayCalls).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({ type: "unresolved", reason: "outcome_unknown" });
    });

    it("builds a fresh payment after a 429 whose failed receipt proves nothing was broadcast", async () => {
      const c = observed();
      const exact = stubExact(c);
      const requestIds: string[] = [];
      gateway.push(
        () => quote402([exactAccept(), batchAccept(operator.address)]),
        (_url, init) => {
          requestIds.push(decodePayment(init).payload.authorization.requestId);
          return tooMany({ "Retry-After": "1", ...receipt({ success: false, errorReason: "batch_deposit_rate_limited", transaction: "" }) });
        },
        () => quote402([exactAccept(), batchAccept(operator.address)]), // fresh challenge after the wait
        async (_url, init) => {
          requestIds.push(decodePayment(init).payload.authorization.requestId);
          return servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      // Nothing was sent, so a new payment (new request id) is fine.
      expect(requestIds).toHaveLength(2);
      expect(requestIds[1]).not.toBe(requestIds[0]);
      expect(exact).not.toHaveBeenCalled();
      expect(sleeps).toEqual([1_000]);
      expect(events[0]).toMatchObject({ type: "backoff", errorReason: "batch_deposit_rate_limited" });
    });

    it("logs every fallback, not just the first one for a reason", async () => {
      const c = observed();
      stubExact(c);
      for (let i = 0; i < 2; i += 1) {
        gateway.push(
          () => quote402([exactAccept()]),
          () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
        );
      }

      await c.chat("openai/gpt-4o-mini", "gm");
      await c.chat("openai/gpt-4o-mini", "gm");

      const lines = logs.filter((l) => l.includes("event=fallback reason=not_offered"));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\[@blockrun\/llm\] batch-settlement event=fallback reason=not_offered wallet=\S+ next=exact$/);
      expect(c.getBatchStats()).toMatchObject({ fallbacks: 2, fallbacksByReason: { not_offered: 2 } });
    });

    it("classifies an untrusted operator and keeps the log on one line", async () => {
      const c = observed();
      stubExact(c);
      const stranger = await generateKeyPairSigner();
      gateway.push(
        () => quote402([exactAccept(), batchAccept(stranger.address)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await c.chat("openai/gpt-4o-mini", "gm");

      expect(events).toEqual([expect.objectContaining({ type: "fallback", reason: "untrusted_operator" })]);
      expect(events[0].detail).toContain(stranger.address);
      const line = logs.find((l) => l.includes("event=fallback"))!;
      expect(line).toContain("reason=untrusted_operator");
      expect(line.split("\n")).toHaveLength(1);
    });

    /** The same route offered client-signed: no operator, `voucherSigner` omitted or `"client"`. */
    function clientSignedAccept(voucherSigner?: "client") {
      const { voucherSigner: _server, operator: _operator, ...extra } = batchAccept(operator.address).extra;
      return { ...batchAccept(operator.address), extra: { ...extra, ...(voucherSigner ? { voucherSigner } : {}) } };
    }

    /** What each gateway call carried: undefined for the unpaid request, else the payment header. */
    const signatures = () => gatewayCalls.map((call) => (call.init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"]);

    it.each([
      ["omits voucherSigner", undefined],
      ['says voucherSigner "client"', "client" as const],
    ])("pays exact, sending no batch payment, when the only batch accept %s", async (_label, voucherSigner) => {
      const c = observed();
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), clientSignedAccept(voucherSigner)]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).toHaveBeenCalledTimes(1);
      expect(signatures()).toEqual([undefined, "exact-payload"]);
      expect(events).toEqual([expect.objectContaining({ type: "fallback", reason: "client_signed_not_supported" })]);
      expect(c.getBatchStats().fallbacksByReason).toEqual({ client_signed_not_supported: 1 });
      expect(logs.some((l) => l.includes("event=fallback reason=client_signed_not_supported") && l.includes("next=exact"))).toBe(true);
      // No channel was opened, so there is nothing a close could not refund.
      expect(fs.existsSync(path.join(tmp, "channels.json"))).toBe(false);
    });

    it("never falls back to a client-signed twin of an untrusted operator's accept", async () => {
      const c = observed();
      const exact = stubExact(c);
      const stranger = await generateKeyPairSigner();
      gateway.push(
        () => quote402([exactAccept(), batchAccept(stranger.address), clientSignedAccept()]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).toHaveBeenCalledTimes(1);
      expect(signatures()).toEqual([undefined, "exact-payload"]);
      expect(events).toEqual([expect.objectContaining({ type: "fallback", reason: "untrusted_operator" })]);
    });

    it("pays the trusted server-signed accept when a client-signed one is listed before it", async () => {
      const c = observed();
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept(), clientSignedAccept("client"), batchAccept(operator.address)]),
        async (_url, init) => {
          const payment = decodePayment(init);
          expect(payment.accepted.extra.voucherSigner).toBe("server");
          expect(payment.payload.channelConfig.voucherSigner).toBe("server");
          return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
        }
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");

      expect(exact).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    });

    it("ignores an onEvent callback that throws", async () => {
      const c = client({ onEvent: () => { throw new Error("boom"); } });
      const exact = stubExact(c);
      gateway.push(
        () => quote402([exactAccept()]),
        () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
      );

      await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
      expect(exact).toHaveBeenCalledTimes(1);
      expect(logs.some((l) => l.includes("onEvent callback threw"))).toBe(true);
    });

    it("handles an async onEvent callback that rejects, without an unhandled rejection", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const c = client({ onEvent: async () => { throw new Error("async boom"); } });
        const exact = stubExact(c);
        gateway.push(
          () => quote402([exactAccept()]),
          () => new Response(JSON.stringify(CHAT_OK), { status: 200 })
        );

        await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(exact).toHaveBeenCalledTimes(1);
        expect(logs.some((l) => l.includes("onEvent callback threw") && l.includes("async boom"))).toBe(true);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("validates the rateLimit options", () => {
      expect(() => client({ rateLimit: { maxAttempts: 0 } })).toThrow("maxAttempts");
      expect(() => client({ rateLimit: { maxWaitMs: -1 } })).toThrow("maxWaitMs");
    });
  });

  it("ignores the batch option in API-key mode", async () => {
    const c = new SolanaLLMClient({ apiKey: "brk_test_key", batch: { operators: [operator.address] } });
    await expect(c.closeBatchChannel()).rejects.toThrow("requires the `batch` option");
    expect(() => c.getBatchStats()).toThrow("requires the `batch` option");
  });

  it("requires at least one trusted operator", () => {
    expect(() => new SolanaLLMClient({ privateKey: TEST_BS58_KEY, batch: { operators: [] } })).toThrow(
      "batch.operators"
    );
  });
});

describe("BLOCKRUN_SOL_OPERATOR", () => {
  it("is a 32-byte base58 Solana public key, exported from the package root", async () => {
    const { BLOCKRUN_SOL_OPERATOR } = await import("../../src/index");
    expect(BLOCKRUN_SOL_OPERATOR).toBe("5YKPQUFjw5WQqhSUkEGKNNfYYVqnRRNbpYyL71qQ1vm3");
    expect(bs58.decode(BLOCKRUN_SOL_OPERATOR)).toHaveLength(32);
  });
});

describe("batch channel storage", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "br-batch-store-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const confirmed = {
    channelConfig: { voucherSigner: "server" },
    channelId: "chan",
    chargedCumulativeAmount: "1000",
    deposit: "25000",
  };

  it("writes a private file and round-trips records", async () => {
    const file = path.join(tmp, "nested", "wallet.json");
    const store = new FileChannelStorage(file);
    await store.set("k", confirmed);
    expect(await store.get("k")).toEqual(confirmed);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    await store.delete("k");
    expect(await store.get("k")).toBeUndefined();
  });

  it("drops a pending request left by a dead process, keeping the confirmed channel", async () => {
    const store = new FileChannelStorage(path.join(tmp, "w.json"));
    await store.set("k", { ...confirmed, hasConfirmedState: true, pending: [{ amount: "5000" }] });

    expect(await dropOrphanedPending(store).get("k")).toEqual(confirmed);
    expect(await store.get("k")).toEqual(confirmed);
  });

  it("keeps a never-confirmed channel on disk and asks for a chain re-read instead of using it", async () => {
    const store = new FileChannelStorage(path.join(tmp, "w.json"));
    const record = { ...confirmed, pending: [{ amount: "5000" }] };
    await store.set("k", record);
    const targets: unknown[] = [];

    await expect(dropOrphanedPending(store, (t) => targets.push(t)).get("k")).rejects.toBeInstanceOf(ChannelResyncRequiredError);
    expect(await store.get("k")).toEqual(record);
    expect(targets).toEqual([expect.objectContaining({ key: "k", channelId: "chan", cumulative: 0n, reason: "orphaned_deposit" })]);
  });

  it("keeps a channel whose last request was a deposit and asks for its real balance to be re-read", async () => {
    const store = new FileChannelStorage(path.join(tmp, "w.json"));
    const record = {
      ...confirmed,
      hasConfirmedState: true,
      pending: [{ amount: "5000", payment: { payload: { type: "deposit" } } }],
    };
    await store.set("k", record);
    const targets: unknown[] = [];

    await expect(dropOrphanedPending(store, (t) => targets.push(t)).get("k")).rejects.toBeInstanceOf(ChannelResyncRequiredError);
    expect(await store.get("k")).toEqual(record);
    // The confirmed cumulative is kept as the floor for the re-read.
    expect(targets).toEqual([expect.objectContaining({ cumulative: 1000n })]);
  });

  it("locks a channel file to one live process", () => {
    const file = path.join(tmp, "locked.json");
    fs.writeFileSync(`${file}.lock`, String(process.ppid));
    expect(lockChannelFile(file)).toBe(process.ppid);

    // A lock left by a process that is gone is taken over.
    fs.writeFileSync(`${file}.lock`, "999999999");
    expect(lockChannelFile(file)).toBeUndefined();
    // The lock holds the bare pid; the ownership token is in its sidecar.
    expect(fs.readFileSync(`${file}.lock`, "utf8")).toBe(String(process.pid));
    const owner = JSON.parse(fs.readFileSync(`${file}.lock.owner`, "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(owner.token).toMatch(/^[0-9a-f-]{36}$/);
    if (process.platform !== "win32") expect(fs.statSync(`${file}.lock.owner`).mode & 0o777).toBe(0o600);
    // Held: asking again is a no-op.
    expect(lockChannelFile(file)).toBeUndefined();
    __resetBatchWalletsForTests();
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(fs.existsSync(`${file}.lock.owner`)).toBe(false);
  });

  it("writes a lock that released versions (3.19.x) read as live", () => {
    /** 3.19.x's check, verbatim: a lock is live when it names a live process other than the reader's own. */
    const releasedSeesLive = (raw: string, readerPid: number) => {
      const owner = Number(raw.trim());
      let alive = false;
      try { process.kill(owner, 0); alive = true; } catch (err) { alive = (err as NodeJS.ErrnoException).code === "EPERM"; }
      return Number.isInteger(owner) && owner > 0 && owner !== readerPid && alive;
    };
    const file = path.join(tmp, "rolling-upgrade.json");
    expect(lockChannelFile(file)).toBeUndefined();

    // A 3.19.x process (another pid) sharing the channel store leaves it alone.
    expect(releasedSeesLive(fs.readFileSync(`${file}.lock`, "utf8"), process.ppid)).toBe(true);
    __resetBatchWalletsForTests();
  });

  it("never releases a lock naming this pid whose sidecar holds another owner's token", () => {
    const file = path.join(tmp, "retaken.json");
    expect(lockChannelFile(file)).toBeUndefined();
    // Another SDK copy in this process took the file over since (same pid, its own token).
    const sidecar = JSON.stringify({ pid: process.pid, token: "another-sdk-copy" });
    fs.writeFileSync(`${file}.lock.owner`, sidecar);

    __resetBatchWalletsForTests();

    expect(fs.readFileSync(`${file}.lock`, "utf8")).toBe(String(process.pid));
    expect(fs.readFileSync(`${file}.lock.owner`, "utf8")).toBe(sidecar);
  });

  it.each([
    ["a token this process's registry does not hold", () => JSON.stringify({ pid: process.pid, token: "another-sdk-copy" })],
    ["the bare pid an older SDK wrote", () => String(process.pid)],
  ])("never takes a lock naming this process with %s for a stale one", (_label, content) => {
    const file = path.join(tmp, "same-pid.json");
    const lock = content();
    fs.writeFileSync(`${file}.lock`, lock);

    expect(lockChannelFile(file)).toBe(process.pid);
    expect(lockChannelFile(file)).toBe(process.pid);
    // Left exactly as it was: another copy of the SDK in this process owns it.
    expect(fs.readFileSync(`${file}.lock`, "utf8")).toBe(lock);
    __resetBatchWalletsForTests();
    expect(fs.readFileSync(`${file}.lock`, "utf8")).toBe(lock);
  });

  it("removes only its own lock on reset or exit, never one another owner wrote since", () => {
    const file = path.join(tmp, "replaced.json");
    expect(lockChannelFile(file)).toBeUndefined();
    const foreign = JSON.stringify({ pid: process.ppid, token: "someone-else" });
    fs.writeFileSync(`${file}.lock`, foreign);
    __resetBatchWalletsForTests();
    expect(fs.readFileSync(`${file}.lock`, "utf8")).toBe(foreign);
  });

  it("leaves client-signed channels alone", async () => {
    const store = new FileChannelStorage(path.join(tmp, "w.json"));
    const record = { ...confirmed, channelConfig: {}, pending: [{ amount: "5000" }] };
    await store.set("k", record);

    expect(await dropOrphanedPending(store).get("k")).toEqual(record);
  });
});
