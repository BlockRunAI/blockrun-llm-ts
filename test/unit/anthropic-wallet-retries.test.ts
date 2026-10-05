// The Anthropic SDK retries 408/409/429/5xx and connection errors on its own
// (maxRetries defaults to 2), by calling our fetch again. In wallet mode that
// fetch runs the whole x402 flow — unpaid probe, 402, sign, send — so every
// SDK retry signed and sent a NEW payment: one messages.create, three charges.
// Only `fetch` is faked; signing is the real EVM signer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicClient } from '../../src/anthropic-compat';
import { TEST_PRIVATE_KEY, buildPaymentRequiredResponse } from '../helpers/testHelpers';

let sent: Array<string | undefined>;
let paidAnswer: () => Response | Promise<Response>;
const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'anthropic/claude-sonnet-4.6', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };

beforeEach(() => {
  vi.stubEnv('BLOCKRUN_API_KEY', '');
  sent = [];
  paidAnswer = () => Response.json(message);
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    const signature = new Headers(init?.headers).get('PAYMENT-SIGNATURE') ?? undefined;
    sent.push(signature);
    if (!signature) return new Response('{}', { status: 402, headers: { 'payment-required': buildPaymentRequiredResponse() } });
    return paidAnswer();
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const create = (client: AnthropicClient) =>
  client.messages.create({ model: 'anthropic/claude-sonnet-4.6', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
const signatures = () => sent.filter((s): s is string => s !== undefined);

describe('AnthropicClient (wallet): one call, at most one payment', () => {
  it('control: a paid 200 sends one signed request', async () => {
    const client = new AnthropicClient({ privateKey: TEST_PRIVATE_KEY });
    await expect(create(client)).resolves.toMatchObject({ id: 'msg_1' });
    expect(signatures()).toHaveLength(1);
  });

  it.each([500, 502, 503, 529, 429, 408])('a %i after the payment raises; the SDK never re-runs the flow and pays again', async status => {
    const client = new AnthropicClient({ privateKey: TEST_PRIVATE_KEY });
    paidAnswer = () => Response.json({ type: 'error', error: { type: 'api_error', message: `status ${status}` } }, { status });
    await expect(create(client)).rejects.toMatchObject({ status });
    expect(signatures()).toHaveLength(1);
  });

  it('a connection error after the payment raises; no second payment', async () => {
    const client = new AnthropicClient({ privateKey: TEST_PRIVATE_KEY });
    paidAnswer = () => { throw new TypeError('fetch failed'); };
    await expect(create(client)).rejects.toThrow();
    expect(signatures()).toHaveLength(1);
  });
});
