import { privateKeyToAccount } from 'viem/accounts';
import type { Account } from 'viem/accounts';
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from './x402.js';
import { getOrCreateWallet } from './wallet.js';
import { validatePrivateKey, validateApiUrl, validateResourceUrl } from './validation.js';

// ======================================================================
// Types
// ======================================================================

export interface BlockRunAnthropicOptions {
  privateKey?: `0x${string}` | string;
  apiUrl?: string;
  timeout?: number;
}

// ======================================================================
// AnthropicClient
// ======================================================================

export class AnthropicClient {
  private _client: import('@anthropic-ai/sdk').default | null = null;
  private _clientPromise: Promise<import('@anthropic-ai/sdk').default> | null =
    null;
  private _privateKey: `0x${string}`;
  private _account: Account;
  private _apiUrl: string;
  private _timeout: number;

  constructor(options: BlockRunAnthropicOptions = {}) {
    const wallet = getOrCreateWallet();
    const key = options.privateKey ?? wallet.privateKey;
    validatePrivateKey(key);
    this._privateKey = key as `0x${string}`;
    this._account = privateKeyToAccount(this._privateKey);

    const apiUrl = options.apiUrl ?? 'https://blockrun.ai/api';
    validateApiUrl(apiUrl);
    this._apiUrl = apiUrl.replace(/\/$/, '');
    this._timeout = options.timeout ?? 60000;
  }

  private async _getClient(): Promise<import('@anthropic-ai/sdk').default> {
    if (this._client) return this._client;
    if (this._clientPromise) return this._clientPromise;

    this._clientPromise = (async () => {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this._client = new Anthropic({
        baseURL: `${this._apiUrl}/v1`,
        apiKey: 'blockrun',
        fetch: this._x402Fetch.bind(this),
      });
      return this._client;
    })();

    return this._clientPromise;
  }

  private async _x402Fetch(
    input: string | Request | URL,
    init?: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._timeout);

    try {
      const mergedInit = { ...init, signal: controller.signal };
      let response = await globalThis.fetch(input, mergedInit);

      if (response.status === 402) {
        let paymentHeader = response.headers.get('payment-required');

        if (!paymentHeader) {
          try {
            const respBody = (await response.json()) as Record<
              string,
              unknown
            >;
            if (respBody.x402 || respBody.accepts) {
              paymentHeader = btoa(JSON.stringify(respBody));
            }
          } catch {
            // ignore parse errors
          }
        }

        if (!paymentHeader) {
          throw new Error('402 response but no payment requirements found');
        }

        const paymentRequired = parsePaymentRequired(paymentHeader);
        const details = extractPaymentDetails(paymentRequired);

        const extensions = (
          paymentRequired as unknown as Record<string, unknown>
        ).extensions as Record<string, unknown> | undefined;

        const paymentPayload = await createPaymentPayload(
          this._privateKey,
          this._account.address,
          details.recipient,
          details.amount,
          details.network || 'eip155:8453',
          {
            resourceUrl: validateResourceUrl(
              details.resource?.url ||
                `${this._apiUrl}/v1/messages`,
              this._apiUrl
            ),
            resourceDescription:
              details.resource?.description || 'BlockRun AI API call',
            maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
            extra: details.extra,
            extensions,
          }
        );

        const newHeaders = new Headers(init?.headers);
        newHeaders.set('PAYMENT-SIGNATURE', paymentPayload);

        response = await globalThis.fetch(input, {
          ...init,
          headers: newHeaders,
          signal: controller.signal,
        });

        if (response.status === 402) {
          throw new Error(
            'Payment was rejected. Check your wallet balance.'
          );
        }
      }

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  get messages(): import('@anthropic-ai/sdk').default['messages'] {
    const handler: ProxyHandler<object> = {
      get: (_target, prop) => {
        return async (...args: unknown[]) => {
          const client = await this._getClient();
          const messages = client.messages as unknown as Record<
            string,
            (...a: unknown[]) => unknown
          >;
          return messages[prop as string](...args);
        };
      },
    };
    return new Proxy({}, handler) as import('@anthropic-ai/sdk').default['messages'];
  }

  getWalletAddress(): string {
    return this._account.address;
  }
}

export default AnthropicClient;
