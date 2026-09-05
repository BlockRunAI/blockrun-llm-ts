import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicClient } from '../../src/anthropic-compat';
import { ApiKeyAuth } from '../../src/api-key';

const key = 'brk_live_recovery_fixture';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([429, 500, 502])('does not let the Anthropic SDK replay a billed POST on %i', async status => {
  const fetch = vi.fn(async () => Response.json({ error: { type: 'api_error', message: 'uncertain completion' } }, { status }));
  vi.stubGlobal('fetch', fetch);
  const client = new AnthropicClient({ apiKey: key });
  await expect(client.messages.create({ model: 'anthropic/claude-haiku-4.5', max_tokens: 8, messages: [{ role: 'user', content: 'Hi' }] })).rejects.toMatchObject({ status });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('releases an unsuccessful GET body and aborts its retry delay promptly', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const pending = new ApiKeyAuth(key, 'https://api.blockrun.ai').fetch('/v1/models', { signal: controller.signal }).catch(e => e);
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledOnce();
  controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toMatchObject({ name: 'AbortError' });
  expect(fetch).toHaveBeenCalledOnce();
});

it('lets an Anthropic caller cancel an in-flight account request', async () => {
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const fetch = vi.fn(async (_input, init?: RequestInit) => {
    markStarted();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const client = new AnthropicClient({ apiKey: key });
  const pending = client.messages.create({ model: 'anthropic/claude-haiku-4.5', max_tokens: 8, messages: [{ role: 'user', content: 'Hi' }] }, { signal: controller.signal }).catch(e => e);
  await started;
  controller.abort();
  expect(await pending).toMatchObject({ name: 'Error', message: 'Request was aborted.' });
  expect(fetch).toHaveBeenCalledOnce();
});
