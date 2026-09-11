import type { LlmClient, LlmRequest, LlmResponse } from './LlmClient.js';
import { LlmUnavailableError } from './LlmClient.js';

/**
 * Real Claude adapter.
 *
 * Written against the Messages HTTP API with `fetch` rather than the SDK: the
 * call is one POST with three fields, and taking a dependency (plus its
 * transitive tree) to save fifteen lines would be a poor trade in a prototype
 * whose reviewers have to read every file.
 *
 * Selection between this and `StubLlmClient` happens once, in the composition
 * root (`src/main.ts` / `buildContainer`), based on whether `ANTHROPIC_API_KEY`
 * is present. Nothing in the evaluation layer knows which one it has.
 */
export class AnthropicClient implements LlmClient {
  readonly id = 'anthropic';

  private static readonly ENDPOINT = 'https://api.anthropic.com/v1/messages';
  private static readonly API_VERSION = '2023-06-01';

  constructor(
    private readonly apiKey: string,
    private readonly model = 'claude-sonnet-5',
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    let response: Response;
    try {
      response = await fetch(AnthropicClient.ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': AnthropicClient.API_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (cause) {
      // Network-level failure. Surfaced as LlmUnavailableError so the
      // orchestrator treats it as a retryable outage rather than a bad
      // submission — the learner's work is never at fault here.
      throw new LlmUnavailableError('Could not reach the Anthropic API.', cause);
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new LlmUnavailableError(
        `Anthropic API returned ${response.status}: ${body.slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as AnthropicMessageResponse;
    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim();

    if (text.length === 0) {
      throw new LlmUnavailableError('Anthropic API returned an empty completion.');
    }

    return {
      text,
      model: payload.model ?? this.model,
      ...(payload.usage
        ? { inputTokens: payload.usage.input_tokens, outputTokens: payload.usage.output_tokens }
        : {}),
    };
  }
}

interface AnthropicMessageResponse {
  readonly model?: string;
  readonly content?: readonly { type: string; text?: string }[];
  readonly usage?: { input_tokens: number; output_tokens: number };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable response body>';
  }
}
