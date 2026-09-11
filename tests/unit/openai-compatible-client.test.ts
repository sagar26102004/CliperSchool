import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleClient } from '../../src/infra/llm/OpenAiCompatibleClient.js';
import { LlmUnavailableError } from '../../src/infra/llm/LlmClient.js';

/**
 * These tests exist because this adapter is the one piece of the model path
 * that only ever runs against someone else's server. Everything it can get
 * wrong — the system prompt going to the wrong place, a 429 read as a bad
 * submission, a reasoning model spending its whole budget on thinking and
 * returning nothing — is invisible locally until a learner hits it.
 */

function respondWith(body: unknown, init: { status?: number } = {}): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

const REQUEST = {
  system: 'You grade designs.',
  user: 'Here is my design.',
  maxTokens: 3000,
  temperature: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAiCompatibleClient', () => {
  it('sends the system prompt as a message, not a top-level field', async () => {
    const fetchMock = respondWith({
      model: 'gemini-3.6-flash',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAiCompatibleClient('k', 'https://example.test/v1', 'gemini-3.6-flash');
    await client.complete(REQUEST);

    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]!;
    expect(url).toBe('https://example.test/v1/chat/completions');

    const body = JSON.parse(String(init.body));
    expect(body.system).toBeUndefined();
    expect(body.messages).toEqual([
      { role: 'system', content: 'You grade designs.' },
      { role: 'user', content: 'Here is my design.' },
    ]);
    // Reproducibility is the whole reason the evaluator passes 0.
    expect(body.temperature).toBe(0);
  });

  it('tolerates a base URL with a trailing slash', async () => {
    const fetchMock = respondWith({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAiCompatibleClient('k', 'https://example.test/v1/', 'm').complete(REQUEST);

    const [url] = (fetchMock as unknown as { mock: { calls: [string][] } }).mock.calls[0]!;
    expect(url).toBe('https://example.test/v1/chat/completions');
  });

  it('reports usage and the model the provider actually used', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith({
        model: 'gemini-3.6-flash-002',
        choices: [{ message: { content: '  spaced  ' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 189, completion_tokens: 649 },
      }),
    );

    const result = await new OpenAiCompatibleClient(
      'k',
      'https://example.test/v1',
      'gemini-3.6-flash',
    ).complete(REQUEST);

    expect(result.text).toBe('spaced');
    // The provider may resolve an alias to a pinned build; record what ran.
    expect(result.model).toBe('gemini-3.6-flash-002');
    expect(result.inputTokens).toBe(189);
    expect(result.outputTokens).toBe(649);
  });

  it('treats a non-2xx response as an outage, not a bad submission', async () => {
    vi.stubGlobal('fetch', respondWith({ error: { message: 'rate limited' } }, { status: 429 }));

    const client = new OpenAiCompatibleClient('k', 'https://example.test/v1', 'm');
    await expect(client.complete(REQUEST)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('treats a transport failure as an outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    );

    const client = new OpenAiCompatibleClient('k', 'https://example.test/v1', 'm');
    await expect(client.complete(REQUEST)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('treats an empty completion as an outage and names the finish reason', async () => {
    // What a reasoning model returns when thinking consumed the whole budget:
    // HTTP 200, finish_reason "length", nothing to parse.
    vi.stubGlobal(
      'fetch',
      respondWith({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    );

    const client = new OpenAiCompatibleClient('k', 'https://example.test/v1', 'm');
    await expect(client.complete(REQUEST)).rejects.toThrow(/length/);
  });

  it('reports the provider id so the banner can name what graded the attempt', () => {
    expect(new OpenAiCompatibleClient('k', 'u', 'm', 'gemini').id).toBe('gemini');
    expect(new OpenAiCompatibleClient('k', 'u', 'm').id).toBe('openai-compatible');
  });
});
