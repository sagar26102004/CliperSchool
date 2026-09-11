import { asCriterionId } from '../domain/ids.js';
import { makeCriterionResult, type CriterionResult } from '../domain/evaluation/CriterionResult.js';
import type { SubmissionFormat } from '../domain/submission/SubmissionContent.js';
import type { LlmClient } from '../infra/llm/LlmClient.js';
import { LlmUnavailableError } from '../infra/llm/LlmClient.js';
import type { Evaluator, EvaluationContext, EvaluatorOutcome } from './Evaluator.js';
import {
  buildEvaluationPrompt,
  extractJson,
  LlmEvaluationSchema,
  type LlmEvaluationPayload,
} from './prompts/EvaluationPrompt.js';

/**
 * Scores the judgement criteria by asking a language model, then refusing to
 * trust it unconditionally.
 *
 * The design principle here is that the model is an untrusted source of
 * structured data, not an oracle. Everything it returns passes through:
 *
 *   extract JSON → validate against schema → one repair attempt if invalid
 *   → drop criteria that are not in this rubric → drop criteria this evaluator
 *   does not own → clamp scores into range → clamp confidence
 *
 * A model that hallucinates a criterion, invents a tenth point on a five-point
 * scale, or wraps its answer in an apology cannot corrupt an Evaluation. The
 * worst it can do is contribute nothing, which downgrades the evaluation to
 * `partial` and still leaves the learner with real deterministic feedback.
 */
export class LlmEvaluator implements Evaluator {
  readonly id = 'llm-v1';

  private static readonly MAX_TOKENS = 3_000;

  constructor(
    private readonly client: LlmClient,
    /** One retry only. A model that fails a schema twice is having a bad day,
     *  and a third paid call would spend the learner's patience, not fix it. */
    private readonly repairAttempts = 1,
  ) {}

  supports(format: SubmissionFormat): boolean {
    return format === 'design-spec' || format === 'class-diagram';
  }

  async evaluate(context: EvaluationContext): Promise<EvaluatorOutcome> {
    const owned = context.rubric.criteriaOwnedBy('llm');
    if (owned.length === 0) {
      return { evaluatorId: this.id, results: [] };
    }

    const prompt = buildEvaluationPrompt(context);
    const maxScoreById = new Map(owned.map((c) => [String(c.id), c.maxScore]));

    let lastError: unknown;
    let raw = '';

    for (let attempt = 0; attempt <= this.repairAttempts; attempt += 1) {
      const user =
        attempt === 0
          ? prompt.user
          : [
              prompt.user,
              '',
              '<correction>',
              'Your previous reply could not be parsed as the required JSON object.',
              `The parser reported: ${errorMessage(lastError)}`,
              'Reply again with the JSON object only — no prose, no markdown fences, no trailing commentary.',
              '</correction>',
            ].join('\n');

      let payload: LlmEvaluationPayload;
      try {
        const response = await this.client.complete({
          system: prompt.system,
          user,
          maxTokens: LlmEvaluator.MAX_TOKENS,
          // Zero temperature: two learners submitting the same design should
          // not receive different scores, and a learner re-running a failed
          // evaluation should not see their score move for no reason.
          temperature: 0,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        raw = response.text;
        payload = LlmEvaluationSchema.parse(extractJson(raw));
      } catch (error) {
        lastError = error;
        // A transport failure will not be fixed by rephrasing the prompt, so
        // it aborts immediately rather than burning the repair attempt.
        if (error instanceof LlmUnavailableError) break;
        continue;
      }

      const results = this.toCriterionResults(payload, maxScoreById);
      if (results.length === 0) {
        lastError = new Error('Model returned no results for any known criterion.');
        continue;
      }

      const missing = owned.filter((c) => !results.some((r) => r.criterionId === c.id));
      return {
        evaluatorId: this.id,
        results,
        summary: payload.summary.trim(),
        ...(missing.length > 0
          ? {
              degradedReason: `The model did not score: ${missing.map((c) => c.name).join(', ')}.`,
            }
          : {}),
      };
    }

    // Every attempt failed. Throwing (rather than returning empty results) lets
    // the orchestrator distinguish "the model had nothing to add" from "the
    // model leg is down", which are different messages for the learner.
    throw new LlmUnavailableError(
      `LLM evaluation failed after ${this.repairAttempts + 1} attempt(s): ${errorMessage(lastError)}`,
      lastError,
    );
  }

  /**
   * Converts a validated payload into domain results, discarding anything the
   * rubric does not recognise. Silent discarding is correct here: a criterion
   * the model invented has no weight, no description and no place in the UI, so
   * there is nothing useful to show a learner about it.
   */
  private toCriterionResults(
    payload: LlmEvaluationPayload,
    maxScoreById: ReadonlyMap<string, number>,
  ): readonly CriterionResult[] {
    const seen = new Set<string>();
    const results: CriterionResult[] = [];

    for (const row of payload.results) {
      const maxScore = maxScoreById.get(row.criterionId);
      if (maxScore === undefined) continue;
      if (seen.has(row.criterionId)) continue;
      seen.add(row.criterionId);

      results.push(
        makeCriterionResult({
          criterionId: asCriterionId(row.criterionId),
          score: row.score,
          maxScore,
          evidence: row.evidence.filter((e) => e.trim().length > 0).slice(0, 4),
          concern: row.concern.trim(),
          suggestion: row.suggestion.trim(),
          confidence: row.confidence,
          source: 'llm',
        }),
      );
    }

    return results;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
