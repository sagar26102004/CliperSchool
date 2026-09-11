import type { CriterionResult } from '../domain/evaluation/CriterionResult.js';
import type { SubmissionFormat } from '../domain/submission/SubmissionContent.js';
import type { Evaluator, EvaluationContext, EvaluatorOutcome } from './Evaluator.js';
import type { ScoreMergePolicy } from './ScoreMergePolicy.js';

export interface CompositeMember {
  readonly evaluator: Evaluator;
  /**
   * When true, this evaluator failing fails the whole evaluation. When false,
   * its failure degrades the result instead.
   *
   * The deterministic evaluator is required — if structural checks cannot run,
   * something is broken in the platform itself. The LLM evaluator is optional,
   * which is the entire reason an API outage costs a learner some depth of
   * feedback rather than their attempt.
   */
  readonly required: boolean;
}

/**
 * Runs several evaluators over one submission and merges their verdicts.
 *
 * It is itself an `Evaluator`, so the orchestrator handles one object whether
 * the platform is running one evaluator or four, and a composite can nest
 * inside another composite without special-casing.
 *
 * Members run concurrently: the deterministic pass takes microseconds and the
 * model call takes seconds, so running them in sequence would add nothing but
 * latency.
 */
export class CompositeEvaluator implements Evaluator {
  readonly id = 'composite-v1';

  constructor(
    private readonly members: readonly CompositeMember[],
    private readonly mergePolicy: ScoreMergePolicy,
  ) {}

  supports(format: SubmissionFormat): boolean {
    return this.members.some((m) => m.evaluator.supports(format));
  }

  async evaluate(context: EvaluationContext): Promise<EvaluatorOutcome> {
    const applicable = this.members.filter((m) =>
      m.evaluator.supports(context.submission.format),
    );

    const settled = await Promise.allSettled(
      applicable.map((m) => m.evaluator.evaluate(context)),
    );

    const resultsByEvaluator = new Map<string, readonly CriterionResult[]>();
    const degraded: string[] = [];
    const summaries: string[] = [];

    for (const [index, outcome] of settled.entries()) {
      const member = applicable[index];
      if (!member) continue;

      if (outcome.status === 'fulfilled') {
        resultsByEvaluator.set(member.evaluator.id, outcome.value.results);
        if (outcome.value.degradedReason) degraded.push(outcome.value.degradedReason);
        if (outcome.value.summary) summaries.push(outcome.value.summary);
        continue;
      }

      if (member.required) {
        // Rethrowing preserves the original error so the orchestrator can tell
        // an outage from a bug when it decides whether a retry is worth it.
        throw outcome.reason;
      }

      degraded.push(
        `${member.evaluator.id} could not contribute: ${reasonText(outcome.reason)}`,
      );
    }

    return {
      evaluatorId: this.id,
      results: this.mergePolicy.merge({ rubric: context.rubric, resultsByEvaluator }),
      ...(summaries.length > 0 ? { summary: summaries.join(' ') } : {}),
      ...(degraded.length > 0 ? { degradedReason: degraded.join(' ') } : {}),
    };
  }
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
