// tests/cysicClient.test.ts
// Unit tests for the Cysic client. We mock the underlying HTTP layer to
// avoid network calls and assert:
//   - exact POST shape (URL, headers, body) — required by the spec
//   - reads response.data.choices[0].message.content
//   - retries on 429/5xx with exponential backoff
//   - surfaces clean typed errors (auth / rate_limit / server / network)
//   - NEVER logs or returns the API key

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios, { type AxiosInstance } from 'axios';
import { CysicClient, CysicError } from '../src/cysicClient.js';
import type { AppConfig } from '../src/config.js';

const TEST_KEY = 'sk-test-verylong-key-1234567890';

function testConfig(): AppConfig {
  return {
    apiKey: TEST_KEY,
    baseUrl: 'https://token-ai.cysic.xyz/v1',
    model: 'minimax-m3',
    timeoutMs: 5000,
    maxRetries: 3,
    backoffMs: 1, // backoff is fast in tests
    // The CysicClient constructor only uses timeoutMs / model / apiKey / baseUrl
    // / maxRetries / backoffMs, but the AppConfig type is wider; ts-ignore the
    // unused fields here so we can focus the test on the request shape.
  } as AppConfig;
}

function makeMockAxios(responses: Array<{ status: number; data?: unknown; throw?: unknown }>) {
  let i = 0;
  const post = vi.fn(async () => {
    const r = responses[i++] ?? { status: 500, data: {} };
    if (r.throw) throw r.throw;
    return { status: r.status, data: r.data };
  });
  const instance = { post } as unknown as AxiosInstance;
  return { instance, post };
}

describe('cysicClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSTs to /chat/completions with Bearer auth and minimax-m3 model', async () => {
    const { instance, post } = makeMockAxios([
      { status: 200, data: { choices: [{ message: { content: 'hi' } }] } },
    ]);
    const sleeps: number[] = [];
    const c = new CysicClient({
      config: testConfig(),
      http: instance,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const out = await c.chat({
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(out).toBe('hi');
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, opts] = post.mock.calls[0]!;
    expect(url).toBe('https://token-ai.cysic.xyz/v1/chat/completions');
    expect(body).toMatchObject({ model: 'minimax-m3', messages: [{ role: 'user', content: 'hello' }] });
    expect(opts).toMatchObject({
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_KEY}`,
      },
    });
    expect(sleeps).toEqual([]);
  });

  it('reads response.data.choices[0].message.content (exact shape)', async () => {
    const { instance } = makeMockAxios([
      {
        status: 200,
        data: {
          choices: [
            { message: { content: 'first' }, finish_reason: 'stop' },
            { message: { content: 'ignored' } },
          ],
        },
      },
    ]);
    const c = new CysicClient({ config: testConfig(), http: instance, sleep: async () => {} });
    const out = await c.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(out).toBe('first');
  });

  it('retries on 429 then succeeds', async () => {
    const { instance, post } = makeMockAxios([
      { status: 429, data: { error: 'rate limited' } },
      { status: 429, data: { error: 'rate limited' } },
      { status: 200, data: { choices: [{ message: { content: 'OK' } }] } },
    ]);
    const sleeps: number[] = [];
    const c = new CysicClient({
      config: testConfig(),
      http: instance,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const out = await c.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(out).toBe('OK');
    expect(post).toHaveBeenCalledTimes(3);
    expect(sleeps.length).toBe(2);
    // Backoff should be increasing.
    expect(sleeps[1]).toBeGreaterThanOrEqual(sleeps[0]);
  });

  it('retries on 500 then succeeds', async () => {
    const { instance, post } = makeMockAxios([
      { status: 503, data: { error: 'unavail' } },
      { status: 200, data: { choices: [{ message: { content: 'OK' } }] } },
    ]);
    const c = new CysicClient({ config: testConfig(), http: instance, sleep: async () => {} });
    const out = await c.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(out).toBe('OK');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('surfaces 4xx as auth/client error without retrying', async () => {
    const { instance, post } = makeMockAxios([
      { status: 401, data: { error: 'unauthorized' } },
    ]);
    const c = new CysicClient({ config: testConfig(), http: instance, sleep: async () => {} });
    await expect(
      c.chat({ messages: [{ role: 'user', content: 'q' }] }),
    ).rejects.toMatchObject({ code: 'auth', status: 401 });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('surfaces 400 as client error without retrying', async () => {
    const { instance, post } = makeMockAxios([
      { status: 400, data: { error: 'bad' } },
    ]);
    const c = new CysicClient({ config: testConfig(), http: instance, sleep: async () => {} });
    await expect(
      c.chat({ messages: [{ role: 'user', content: 'q' }] }),
    ).rejects.toBeInstanceOf(CysicError);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('throws bad_response when payload has no content', async () => {
    const { instance } = makeMockAxios([{ status: 200, data: { choices: [] } }]);
    const c = new CysicClient({ config: testConfig(), http: instance, sleep: async () => {} });
    await expect(
      c.chat({ messages: [{ role: 'user', content: 'q' }] }),
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('exhausts retries and throws server error', async () => {
    const { instance, post } = makeMockAxios([
      { status: 500, data: { error: 'a' } },
      { status: 500, data: { error: 'b' } },
      { status: 500, data: { error: 'c' } },
      { status: 500, data: { error: 'd' } },
    ]);
    const c = new CysicClient({ config: testConfig(), http: instance, sleep: async () => {} });
    await expect(
      c.chat({ messages: [{ role: 'user', content: 'q' }] }),
    ).rejects.toMatchObject({ code: 'server' });
    expect(post).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('never includes the API key in error messages or upstream', async () => {
    const { instance } = makeMockAxios([
      { status: 500, data: { error: 'oops' } },
      { status: 500, data: { error: 'oops' } },
      { status: 500, data: { error: 'oops' } },
      { status: 500, data: { error: 'oops' } },
    ]);
    const c = new CysicClient({ config: testConfig(), http: instance, sleep: async () => {} });
    try {
      await c.chat({ messages: [{ role: 'user', content: 'q' }] });
      throw new Error('should have thrown');
    } catch (err) {
      const s = JSON.stringify(err);
      expect(s).not.toContain(TEST_KEY);
      expect((err as CysicError).message).not.toContain(TEST_KEY);
    }
  });

  it('onRetry is called for each retry', async () => {
    const { instance } = makeMockAxios([
      { status: 429, data: { error: 'rl' } },
      { status: 200, data: { choices: [{ message: { content: 'OK' } }] } },
    ]);
    const calls: number[] = [];
    const c = new CysicClient({
      config: testConfig(),
      http: instance,
      sleep: async () => {},
      onRetry: (info) => calls.push(info.attempt),
    });
    const out = await c.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(out).toBe('OK');
    expect(calls).toEqual([1]);
  });

  it('uses real axios when no http is injected (compile-time wiring)', () => {
    // Smoke test: ensure the no-injection path doesn't blow up.
    const c = new CysicClient({ config: testConfig() });
    expect(c).toBeInstanceOf(CysicClient);
  });

  it('does not maintain its own cache (caching is the caller's responsibility)', () => {
    // This is a structural test: the client does not maintain a cache.
    const c = new CysicClient({ config: testConfig() });
    expect((c as unknown as { _cache?: unknown })._cache).toBeUndefined();
  });
});

describe('axios module — sanity', () => {
  it('imports without crashing', () => {
    expect(typeof axios.post).toBe('function');
  });
});
