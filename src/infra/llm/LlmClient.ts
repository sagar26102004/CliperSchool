/**
 * The boundary between the platform and any language model.
 *
 * Kept deliberately narrow — one method, plain strings in and out. A wider
 * interface (streaming, tool calls, message history) would leak provider
 * concepts into the evaluation layer and make the offline stub hard to write
 * honestly. Everything the evaluator needs is "here is a prompt, give me text".
 */
export interface LlmClient {
  readonly id: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export interface LlmRequest {
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
  /** Evaluation wants reproducibility, so callers pass 0. */
  readonly temperature: number;
  readonly signal?: AbortSignal;
}

export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}
