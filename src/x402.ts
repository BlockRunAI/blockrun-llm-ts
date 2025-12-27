/**
 * x402 Payment Protocol v2 Implementation for BlockRun.
 *
 * This module handles creating signed payment payloads for the x402 v2 protocol.
 * The private key is used ONLY for local signing and NEVER leaves the client.
 */

import { signTypedData } from "viem/accounts";
import type { PaymentRequired, ResourceInfo } from "./types";

// Chain and token constants
export const BASE_CHAIN_ID = 8453;
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

// EIP-712 domain for Base USDC
const USDC_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: BASE_CHAIN_ID,
  verifyingContract: USDC_BASE,
} as const;

// EIP-712 types for TransferWithAuthorization
const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Generate a random bytes32 nonce.
 */
function createNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
}

export interface CreatePaymentOptions {
  resourceUrl?: string;
  resourceDescription?: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
  extensions?: Record<string, unknown>;
}

/**
 * Create a signed x402 v2 payment payload.
 *
 * @param privateKey - Hex-encoded private key
 * @param fromAddress - Sender wallet address
 * @param recipient - Payment recipient address
 * @param amount - Amount in micro USDC (6 decimals)
 * @param network - Network identifier (default: eip155:8453)
 * @param options - Additional options for resource info
 * @returns Base64-encoded signed payment payload
 */
export async function createPaymentPayload(
  privateKey: `0x${string}`,
  fromAddress: string,
  recipient: string,
  amount: string,
  network: string = "eip155:8453",
  options: CreatePaymentOptions = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 600; // 10 minutes before (allows for clock skew)
  const validBefore = now + (options.maxTimeoutSeconds || 300);
  const nonce = createNonce();

  // USDC domain is fixed - NEVER use extra values from payment requirements
  // The USDC contract on Base uses exactly "USD Coin" version "2"
  const domain = USDC_DOMAIN;

  // Sign using EIP-712 (private key used locally, never transmitted)
  const signature = await signTypedData({
    privateKey,
    domain,
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: fromAddress as `0x${string}`,
      to: recipient as `0x${string}`,
      value: BigInt(amount),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  // Create x402 v2 payment payload
  const paymentData = {
    x402Version: 2,
    resource: {
      url: options.resourceUrl || "https://blockrun.ai/api/v1/chat/completions",
      description: options.resourceDescription || "BlockRun AI API call",
      mimeType: "application/json",
    },
    accepted: {
      scheme: "exact",
      network,
      amount,
      asset: USDC_BASE,
      payTo: recipient,
      maxTimeoutSeconds: options.maxTimeoutSeconds || 300,
      extra: { name: "USD Coin", version: "2" },
    },
    payload: {
      signature,
      authorization: {
        from: fromAddress,
        to: recipient,
        value: amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
    extensions: options.extensions || {},
  };

  // Encode as base64
  return btoa(JSON.stringify(paymentData));
}

/**
 * Parse the X-Payment-Required header from a 402 response.
 *
 * @param headerValue - Base64-encoded payment required header
 * @returns Parsed payment required object
 * @throws {Error} If the header cannot be parsed or has invalid structure
 */
export function parsePaymentRequired(headerValue: string): PaymentRequired {
  try {
    // Decode base64
    const decoded = atob(headerValue);
    const parsed = JSON.parse(decoded);

    // Validate structure
    if (!parsed.accepts || !Array.isArray(parsed.accepts)) {
      throw new Error("Invalid payment required structure: missing or invalid 'accepts' field");
    }

    return parsed as PaymentRequired;
  } catch (error) {
    if (error instanceof Error) {
      // Re-throw validation errors as-is
      if (error.message.includes("Invalid payment required structure")) {
        throw error;
      }
      // Sanitize parsing errors
      throw new Error("Failed to parse payment required header: invalid format");
    }
    throw new Error("Failed to parse payment required header");
  }
}

/**
 * Extract payment details from parsed payment required response.
 * Supports both v1 and v2 formats.
 */
export function extractPaymentDetails(paymentRequired: PaymentRequired): {
  amount: string;
  recipient: string;
  network: string;
  asset: string;
  scheme: string;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string };
  resource?: ResourceInfo;
} {
  const accepts = paymentRequired.accepts || [];
  if (accepts.length === 0) {
    throw new Error("No payment options in payment required response");
  }

  const option = accepts[0];

  // Handle both v1 (maxAmountRequired) and v2 (amount) formats
  const amount = option.amount || option.maxAmountRequired;
  if (!amount) {
    throw new Error("No amount found in payment requirements");
  }

  return {
    amount,
    recipient: option.payTo,
    network: option.network,
    asset: option.asset,
    scheme: option.scheme,
    maxTimeoutSeconds: option.maxTimeoutSeconds || 300,
    extra: option.extra,
    resource: paymentRequired.resource,
  };
}
