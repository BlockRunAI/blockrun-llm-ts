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
  dropOrphanedPending,
  FileChannelStorage,
  lockChannelFile,
} from "../../src/solana-batch";
import { APIError } from "../../src/types";

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

/** The Solana JSON-RPC the scheme talks to. Returns null for an unknown method. */
function rpcResult(method: string): unknown {
  const context = { slot: 400_000_000 };
  switch (method) {
    case "getAccountInfo":
      return { context, value: mintAccount() };
    case "getLatestBlockhash":
      return {
        context,
        value: { blockhash: "9T1tBhLxWWKf1XhD9deySUK2tNcmGQhBsR2tMKFLgFUL", lastValidBlockHeight: 430_673_687 },
      };
    case "getSlot":
      return 400_000_000;
    case "getProgramAccounts":
      return [];
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
 * new cumulative total, the receipt the official server scheme returns.
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
    amount: charged.toString(),
    extra: {
      voucher,
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

  beforeEach(async () => {
    __resetBatchWalletsForTests();
    operator = await generateKeyPairSigner();
    rpcMethods = [];
    gateway = [];
    gatewayCalls = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "br-batch-"));
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(RPC_URL)) {
        const { id, method } = JSON.parse(String(init?.body));
        rpcMethods.push(method);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: rpcResult(method) }), {
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

  it("surfaces a model error after a batch payment instead of paying again", async () => {
    const c = client({});
    const exact = stubExact(c);
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => new Response(JSON.stringify({ error: "upstream_timeout" }), { status: 504 })
    );

    await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toBeInstanceOf(APIError);
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

  it("releases the channel when the batch request gets no answer", async () => {
    const c = client({});
    stubExact(c);
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => { throw new TypeError("fetch failed"); },
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      async (_url, init) => {
        const payment = decodePayment(init);
        // The next call uses batch again rather than tripping over a stale pending slot.
        expect(payment.accepted.scheme).toBe("batch-settlement");
        return servedWithVoucher(operator, channelIdOf(payment), 1000n, 1000n);
      }
    );

    await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toThrow("fetch failed");
    await expect(c.chat("openai/gpt-4o-mini", "gm")).resolves.toBe("gm");
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

  it("re-reads the channel from the chain when a deposit gets no answer", async () => {
    const c = client({});
    stubExact(c);
    gateway.push(
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      () => { throw new TypeError("fetch failed"); },
      () => quote402([exactAccept(), batchAccept(operator.address)]),
      async (_url, init) => servedWithVoucher(operator, channelIdOf(decodePayment(init)), 1000n, 1000n)
    );

    await expect(c.chat("openai/gpt-4o-mini", "gm")).rejects.toThrow("fetch failed");
    // The deposit may have landed: nothing stale is kept to top up from.
    expect(fs.existsSync(path.join(tmp, "channels.json"))).toBe(false);
    const scans = rpcMethods.filter((m) => m === "getProgramAccounts").length;

    await c.chat("openai/gpt-4o-mini", "gm");
    expect(rpcMethods.filter((m) => m === "getProgramAccounts").length).toBeGreaterThan(scans);
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

  it("ignores the batch option in API-key mode", async () => {
    const c = new SolanaLLMClient({ apiKey: "brk_test_key", batch: { operators: [operator.address] } });
    await expect(c.closeBatchChannel()).rejects.toThrow("requires the `batch` option");
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

  it("forgets a never-confirmed channel so the scheme rediscovers it on-chain", async () => {
    const store = new FileChannelStorage(path.join(tmp, "w.json"));
    await store.set("k", { ...confirmed, pending: [{ amount: "5000" }] });

    expect(await dropOrphanedPending(store).get("k")).toBeUndefined();
    expect(await store.get("k")).toBeUndefined();
  });

  it("forgets a channel whose last request was a deposit, so its real balance is re-read", async () => {
    const store = new FileChannelStorage(path.join(tmp, "w.json"));
    await store.set("k", {
      ...confirmed,
      hasConfirmedState: true,
      pending: [{ amount: "5000", payment: { payload: { type: "deposit" } } }],
    });

    expect(await dropOrphanedPending(store).get("k")).toBeUndefined();
    expect(await store.get("k")).toBeUndefined();
  });

  it("locks a channel file to one live process", () => {
    const file = path.join(tmp, "locked.json");
    fs.writeFileSync(`${file}.lock`, String(process.ppid));
    expect(lockChannelFile(file)).toBe(process.ppid);

    // A lock left by a process that is gone is taken over.
    fs.writeFileSync(`${file}.lock`, "999999999");
    expect(lockChannelFile(file)).toBeUndefined();
    expect(fs.readFileSync(`${file}.lock`, "utf8")).toBe(String(process.pid));
    __resetBatchWalletsForTests();
  });

  it("leaves client-signed channels alone", async () => {
    const store = new FileChannelStorage(path.join(tmp, "w.json"));
    const record = { ...confirmed, channelConfig: {}, pending: [{ amount: "5000" }] };
    await store.set("k", record);

    expect(await dropOrphanedPending(store).get("k")).toEqual(record);
  });
});
