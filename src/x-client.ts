/**
 * BlockRun X (Twitter) Client - AttentionVC-partnered X/Twitter API via x402.
 *
 * Wraps the /api/v1/x/* endpoint family. Every call is gated by an x402
 * payment; the client handles the 402 → sign → retry dance automatically.
 *
 * Usage:
 *   import { XClient } from "@blockrun/llm";
 *
 *   const x = new XClient({ privateKey: "0x..." });
 *   const info = await x.userInfo("elonmusk");
 *   const followers = await x.followers("paulg");
 *   const results = await x.search("x402 micropayments", { queryType: "Latest" });
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type XClientOptions,
  type XUserLookupResponse,
  type XUserInfoResponse,
  type XFollowersResponse,
  type XFollowingsResponse,
  type XVerifiedFollowersResponse,
  type XTweetsResponse,
  type XMentionsResponse,
  type XTweetLookupResponse,
  type XTweetRepliesResponse,
  type XTweetThreadResponse,
  type XSearchResponse,
  type XTrendingResponse,
  type XArticlesRisingResponse,
  APIError,
  PaymentError,
} from "./types";
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from "./x402";
import {
  validatePrivateKey,
  validateApiUrl,
  sanitizeErrorResponse,
} from "./validation";

const DEFAULT_API_URL = "https://blockrun.ai/api";
const DEFAULT_TIMEOUT = 60_000;

export interface XUserTweetsOptions {
  username?: string;
  userId?: string;
  cursor?: string;
  includeReplies?: boolean;
}

export interface XMentionsOptions {
  sinceTime?: string;
  untilTime?: string;
  cursor?: string;
}

export interface XTweetRepliesOptions {
  cursor?: string;
  queryType?: "Latest" | "Default";
}

export interface XSearchOptions {
  queryType?: "Latest" | "Top" | "Default";
  cursor?: string;
}

export class XClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;

  constructor(options: XClientOptions = {}) {
    const envKey =
      typeof process !== "undefined" && process.env
        ? process.env.BLOCKRUN_WALLET_KEY || process.env.BASE_CHAIN_WALLET_KEY
        : undefined;
    const privateKey = options.privateKey || envKey;

    if (!privateKey) {
      throw new Error(
        "Private key required. Pass privateKey in options or set BLOCKRUN_WALLET_KEY environment variable."
      );
    }

    validatePrivateKey(privateKey);
    this.privateKey = privateKey as `0x${string}`;
    this.account = privateKeyToAccount(privateKey as `0x${string}`);

    const apiUrl = options.apiUrl || DEFAULT_API_URL;
    validateApiUrl(apiUrl);
    this.apiUrl = apiUrl.replace(/\/$/, "");

    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  // ───────── User endpoints ─────────

  userLookup(usernames: string | string[]): Promise<XUserLookupResponse> {
    return this.post("/v1/x/users/lookup", { usernames }) as Promise<XUserLookupResponse>;
  }

  userInfo(username: string): Promise<XUserInfoResponse> {
    return this.post("/v1/x/users/info", { username }) as Promise<XUserInfoResponse>;
  }

  followers(username: string, cursor?: string): Promise<XFollowersResponse> {
    const body: Record<string, unknown> = { username };
    if (cursor) body.cursor = cursor;
    return this.post("/v1/x/users/followers", body) as Promise<XFollowersResponse>;
  }

  /** `/v1/x/users/following` (singular path variant). */
  following(username: string, cursor?: string): Promise<XFollowingsResponse> {
    const body: Record<string, unknown> = { username };
    if (cursor) body.cursor = cursor;
    return this.post("/v1/x/users/following", body) as Promise<XFollowingsResponse>;
  }

  /** `/v1/x/users/followings` (plural path variant). */
  followings(username: string, cursor?: string): Promise<XFollowingsResponse> {
    const body: Record<string, unknown> = { username };
    if (cursor) body.cursor = cursor;
    return this.post("/v1/x/users/followings", body) as Promise<XFollowingsResponse>;
  }

  verifiedFollowers(userId: string, cursor?: string): Promise<XVerifiedFollowersResponse> {
    const body: Record<string, unknown> = { userId };
    if (cursor) body.cursor = cursor;
    return this.post(
      "/v1/x/users/verified-followers",
      body
    ) as Promise<XVerifiedFollowersResponse>;
  }

  userTweets(options: XUserTweetsOptions): Promise<XTweetsResponse> {
    if (!options.username && !options.userId) {
      throw new Error("Either username or userId is required");
    }
    const body: Record<string, unknown> = {};
    if (options.username) body.username = options.username;
    if (options.userId) body.userId = options.userId;
    if (options.cursor) body.cursor = options.cursor;
    if (options.includeReplies !== undefined) body.includeReplies = options.includeReplies;
    return this.post("/v1/x/users/tweets", body) as Promise<XTweetsResponse>;
  }

  mentions(username: string, options?: XMentionsOptions): Promise<XMentionsResponse> {
    const body: Record<string, unknown> = { username };
    if (options?.sinceTime) body.sinceTime = options.sinceTime;
    if (options?.untilTime) body.untilTime = options.untilTime;
    if (options?.cursor) body.cursor = options.cursor;
    return this.post("/v1/x/users/mentions", body) as Promise<XMentionsResponse>;
  }

  // ───────── Tweet endpoints ─────────

  tweetLookup(tweetIds: string | string[]): Promise<XTweetLookupResponse> {
    return this.post("/v1/x/tweets/lookup", {
      tweet_ids: tweetIds,
    }) as Promise<XTweetLookupResponse>;
  }

  tweetReplies(tweetId: string, options?: XTweetRepliesOptions): Promise<XTweetRepliesResponse> {
    const body: Record<string, unknown> = { tweetId };
    if (options?.cursor) body.cursor = options.cursor;
    if (options?.queryType) body.queryType = options.queryType;
    return this.post("/v1/x/tweets/replies", body) as Promise<XTweetRepliesResponse>;
  }

  tweetThread(tweetId: string, cursor?: string): Promise<XTweetThreadResponse> {
    const body: Record<string, unknown> = { tweetId };
    if (cursor) body.cursor = cursor;
    return this.post("/v1/x/tweets/thread", body) as Promise<XTweetThreadResponse>;
  }

  // ───────── Search & discovery ─────────

  search(query: string, options?: XSearchOptions): Promise<XSearchResponse> {
    const body: Record<string, unknown> = { query };
    if (options?.queryType) body.queryType = options.queryType;
    if (options?.cursor) body.cursor = options.cursor;
    return this.post("/v1/x/search", body) as Promise<XSearchResponse>;
  }

  trending(): Promise<XTrendingResponse> {
    return this.post("/v1/x/trending", {}) as Promise<XTrendingResponse>;
  }

  articlesRising(): Promise<XArticlesRisingResponse> {
    return this.post("/v1/x/articles/rising", {}) as Promise<XArticlesRisingResponse>;
  }

  // ───────── Internals ─────────

  private async post(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${this.apiUrl}${endpoint}`;
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.status === 402) {
      return this.payAndRetry(url, body, response);
    }
    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = { error: "Request failed" };
      }
      throw new APIError(
        `API error: ${response.status}`,
        response.status,
        sanitizeErrorResponse(errorBody)
      );
    }
    return response.json();
  }

  private async payAndRetry(
    url: string,
    body: Record<string, unknown>,
    response: Response
  ): Promise<unknown> {
    let paymentHeader = response.headers.get("payment-required");
    if (!paymentHeader) {
      try {
        const respBody = (await response.json()) as Record<string, unknown>;
        if (respBody.x402 || respBody.accepts) {
          paymentHeader = btoa(JSON.stringify(respBody));
        }
      } catch {
        /* ignore */
      }
    }
    if (!paymentHeader) {
      throw new PaymentError("402 response but no payment requirements found");
    }

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired);

    const paymentPayload = await createPaymentPayload(
      this.privateKey,
      this.account.address,
      details.recipient,
      details.amount,
      details.network || "eip155:8453",
      {
        resourceUrl: details.resource?.url || url,
        resourceDescription: details.resource?.description || "BlockRun X API",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
      }
    );

    const retry = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": paymentPayload,
      },
      body: JSON.stringify(body),
    });

    if (retry.status === 402) {
      throw new PaymentError("Payment was rejected. Check your wallet balance.");
    }
    if (!retry.ok) {
      let errorBody: unknown;
      try {
        errorBody = await retry.json();
      } catch {
        errorBody = { error: "Request failed" };
      }
      throw new APIError(
        `API error after payment: ${retry.status}`,
        retry.status,
        sanitizeErrorResponse(errorBody)
      );
    }
    return retry.json();
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  getWalletAddress(): string {
    return this.account.address;
  }
}

export default XClient;
