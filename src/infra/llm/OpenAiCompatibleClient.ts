import type { LlmClient, LlmRequest, LlmResponse } from './LlmClient.js';
import { LlmUnavailableError } from './LlmClient.js';

/**
 * Adapter for any provider that speaks the OpenAI `/chat/completions` shape.
 *
 * Written as one client rather than one per vendor because the shape is the
 * only thing that varies between them — Gemini, Groq, Mistral, Cerebras,
 * SambaNova and OpenRouter all accept the same request body and differ only in
 * base URL and model name. Both of those are constructor arguments, so
 * supporting a new provider is a line of configuration, not a new file.
 *
 * It exists mainly to make the free tiers reachable: Anthropic has no free
 * tier, and a reviewer who wants to see the AI path run for real without buying
 * credits can point this at Google AI Studio. `AnthropicClient` remains the
 * first choice whenever its key is present — see `resolveLlmClient`.
 *
 * The `id` reports the provider rather than a generic 'openai-compatible', so
 * the startup banner and `Container.llmClientId` stay diagnostic: "which model
 * actually graded this" is the first question asked when a score looks wrong.
 */
export class OpenAiCompatibleClient implements LlmClient {
  readonly id: string;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model: string,
    providerId = 'openai-compatible',
  ) {
    this.id = providerId;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    // Tolerates a base URL given with or without a trailing slash, because
    // getting that wrong produces a 404 that reads like an outage.
    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          // The system prompt travels as a message rather than a top-level
          // field here — the one structural difference from the Anthropic API,
          // and the reason this is an adapter rather than a base URL swap.
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (cause) {
      // Distinguishing these two matters more than it looks. A reasoning model
      // can spend 30s thinking, and when the job's deadline aborts the request
      // mid-flight `fetch` rejects exactly as it does for a dead host. Reported
      // as "could not reach", that sends you hunting for a network fault that
      // is not there — the real fix is the timeout.
      if (isAbort(cause, request.signal)) {
        throw new LlmUnavailableError(
          `Model provider did not answer before the evaluation deadline (${this.model}).`,
          cause,
        );
      }
      throw new LlmUnavailableError(`Could not reach the model provider at ${endpoint}.`, cause);
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new LlmUnavailableError(
        `Model provider returned ${response.status}: ${body.slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const text = (payload.choices?.[0]?.message?.content ?? '').trim();

    if (text.length === 0) {
      // A reasoning model that spends its whole output budget thinking returns
      // exactly this: a 200 with nothing in it. Treating it as an outage is
      // right — it is transient, it is not the learner's fault, and the queue's
      // retry is the correct response.
      throw new LlmUnavailableError(
        `Model provider returned an empty completion (finish_reason: ${
          payload.choices?.[0]?.finish_reason ?? 'unknown'
        }).`,
      );
    }

    return {
      text,
      model: payload.model ?? this.model,
      ...(payload.usage
        ? {
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
          }
        : {}),
    };
  }
}

interface ChatCompletionResponse {
  readonly model?: string;
  readonly choices?: readonly {
    readonly finish_reason?: string;
    readonly message?: { readonly content?: string | null };
  }[];
  readonly usage?: { prompt_tokens: number; completion_tokens: number };
}

/** True when a rejected `fetch` was our own deadline firing, not the network. */
function isAbort(cause: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return cause instanceof Error && cause.name === 'AbortError';
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable response body>';
  }
}
