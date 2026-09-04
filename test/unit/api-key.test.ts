import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMClient } from '../../src/client';
import { SolanaLLMClient } from '../../src/solana-client';
import { ImageClient } from '../../src/image';
import { VideoClient } from '../../src/video';
import { MusicClient } from '../../src/music';
import { SpeechClient } from '../../src/speech';
import { VoiceClient } from '../../src/voice';
import { PhoneClient } from '../../src/phone';
import { PortraitClient } from '../../src/portrait';
import { PriceClient } from '../../src/price';
import { SearchClient } from '../../src/search';
import { SurfClient } from '../../src/surf';
import { RpcClient } from '../../src/rpc';
import { BlockrunClient } from '../../src/blockrun';
import { OpenAI } from '../../src/openai-compat';
import { AnthropicClient } from '../../src/anthropic-compat';
import { resolveApiKeyAuth } from '../../src/api-key';
import { TEST_PRIVATE_KEY } from '../helpers/testHelpers';

const key = 'brk_live_test_account';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chat = { id: 'chat-1', model: 'openai/gpt-5.2', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
const clients = [LLMClient, SolanaLLMClient, ImageClient, VideoClient, MusicClient, SpeechClient, VoiceClient, PhoneClient, PortraitClient, PriceClient, SearchClient, SurfClient, RpcClient, BlockrunClient, OpenAI, AnthropicClient];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv('BLOCKRUN_API_KEY', key);
  vi.stubEnv('BLOCKRUN_API_BASE_URL', 'https://api.blockrun.ai');
  fetchMock = vi.fn().mockImplementation(async () => json(chat));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('account mode across SDK entrypoints', () => {
  it.each(clients)('%s starts without reading or generating a wallet', Client => {
    expect(new Client().authMode).toBe('api-key');
  });
  it.each([
    ['search', () => new SearchClient().search('latest news')],
    ['price', () => new PriceClient().price('crypto', 'BTC')],
    ['RPC', () => new RpcClient().call('solana', 'getSlot')],
    ['Surf', () => new SurfClient().get('/trending')],
    ['speech', () => new SpeechClient().listVoices()],
    ['voice', () => new VoiceClient().getStatus('call-1')],
    ['phone', () => new PhoneClient().listNumbers()],
    ['portrait', () => new PortraitClient().enroll({ name: 'actor', imageUrl: 'https://cdn.example/actor.png' })],
  ] as const)('%s sends account credentials on its service request', async (_name, call) => {
    fetchMock.mockResolvedValueOnce(json({ data: [], voices: [], result: 1, price: 100 }));
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/api\.blockrun\.ai\/v1\//);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${key}`);
    expect(new Headers(init.headers).has('payment-signature')).toBe(false);
  });
  it('supports a chain-named client without loading a Solana signer', async () => {
    expect(await new SolanaLLMClient().chat('openai/gpt-5.2', 'hi')).toBe('ok');
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('authorization')).toBe(`Bearer ${key}`);
  });
  it('keeps explicit wallet selection and rejects ambiguous credentials', () => {
    expect(new LLMClient({ privateKey: TEST_PRIVATE_KEY }).authMode).toBe('wallet');
    expect(() => new LLMClient({ apiKey: key, privateKey: TEST_PRIVATE_KEY })).toThrow('either');
    expect(() => new LLMClient({ apiKey: '' })).toThrow('Invalid BlockRun API key');
    expect(() => new LLMClient().getWalletAddress()).toThrow('requires a wallet');
    expect(() => new LLMClient().getSpending()).toThrow('x402 settlements only');
  });
  it('normalizes the OpenAI base and authenticates catalog and tool calls', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [] })).mockResolvedValueOnce(json({ result: 'ok' }));
    await new LLMClient({ apiUrl: 'https://api.blockrun.ai/v1/' }).listModels();
    await new BlockrunClient().post('/v1/responses', { model: 'openai/gpt-5.2', input: 'hi' });
    expect(fetchMock.mock.calls.map(c => String(c[0]))).toEqual(['https://api.blockrun.ai/v1/models', 'https://api.blockrun.ai/v1/responses']);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${key}`);
      expect(new Headers(init.headers).has('payment-signature')).toBe(false);
      expect(init.redirect).toBe('error');
    }
  });
  it('streams without an x402 challenge', async () => {
    fetchMock.mockResolvedValueOnce(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const res = await new LLMClient().chatCompletionStream('openai/gpt-5.2', [{ role: 'user', content: 'hi' }]);
    expect(await res.text()).toContain('[DONE]');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('forwards OpenAI-compatible calls', async () => {
    const out = await new OpenAI({ baseURL: 'https://api.blockrun.ai/v1' }).chat.completions.create({ model: 'openai/gpt-5.2', messages: [{ role: 'user', content: 'hi' }] });
    expect(out.choices[0].message.content).toBe('ok');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.blockrun.ai/v1/chat/completions');
  });
  it('forwards Anthropic calls with the account credential', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'anthropic/claude-sonnet-4.6', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    await new AnthropicClient().messages.create({ model: 'anthropic/claude-sonnet-4.6', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.blockrun.ai/v1/messages');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${key}`);
    expect(new Headers(init.headers).has('x-api-key')).toBe(false);
  });
});

describe('account errors and credential boundaries', () => {
  it.each([401, 402, 429])('preserves %s without signing or replaying', async status => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'account_error', message: `rejected ${key}`, type: 'billing_error' } }), { status, headers: { 'retry-after': '12', 'payment-required': 'never-sign-this' } }));
    const error = await new LLMClient().chat('openai/gpt-5.2', 'hi').catch(e => e);
    expect(error.statusCode).toBe(status);
    expect(error.response.code).toBe('account_error');
    expect(error.retryAfter).toBe('12');
    expect(JSON.stringify(error)).not.toContain(key);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('removes caller credentials and x402 headers', async () => {
    const auth = resolveApiKeyAuth({ apiKey: key })!;
    await auth.fetch(new Request('https://api.blockrun.ai/v1/models', { headers: { authorization: 'placeholder', 'x-api-key': 'other', 'x-payment': 'proof', 'payment-signature': 'proof2' } }));
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('authorization')).toBe(`Bearer ${key}`);
    expect([...headers.keys()]).not.toContain('x-payment');
    expect(headers.has('x-api-key')).toBe(false);
  });
  it('rejects foreign poll URLs, ports, credentials and plaintext transport before fetch', async () => {
    for (const url of ['https://evil.example/v1/job', 'https://api.blockrun.ai:444/v1/job', 'https://user:pass@api.blockrun.ai/v1/job', 'http://api.blockrun.ai/v1/job']) {
      await expect(resolveApiKeyAuth({ apiKey: key })!.fetch(url)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('account asynchronous jobs', () => {
  it.each(['image', 'video', 'music', 'generic'])('%s polls the first accepted response, without another POST', async kind => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json({ id: 'job-1', status: 'queued', poll_url: '/api/v1/videos/generations/job-1' }, 202))
      .mockResolvedValueOnce(json({ id: 'job-1', status: 'completed', data: [{ url: 'https://cdn.example/result' }] }));
    const promise = kind === 'image' ? new ImageClient().generate('cat')
      : kind === 'video' ? new VideoClient().generate('cat')
      : kind === 'music' ? new MusicClient().generate('jazz')
      : new BlockrunClient().poll('/v1/responses', { input: 'hi' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await promise).toMatchObject({ status: 'completed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.blockrun.ai/v1/videos/generations/job-1');
    for (const [, init] of fetchMock.mock.calls) expect(new Headers(init.headers).has('payment-signature')).toBe(false);
  });
  it('rejects an async response without a poll URL', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'job-1', status: 'queued' }, 202));
    await expect(new VideoClient().generate('cat')).rejects.toThrow('missing poll_url');
  });
});


it('preserves native Anthropic quota errors without replaying the request', async () => {
  vi.stubEnv('BLOCKRUN_API_KEY', 'brk_live_unit_test');
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { type: 'insufficient_credits', message: 'Top up' } }), { status: 402, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(new AnthropicClient().messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ status: 402 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
