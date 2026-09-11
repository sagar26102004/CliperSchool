import type { Problem } from '../domain/problem/Problem.js';
import type { Rubric } from '../domain/rubric/Rubric.js';
import type { Submission } from '../domain/submission/Submission.js';
import type { DesignGraph } from '../domain/submission/DesignGraph.js';
import type { SubmissionFormat } from '../domain/submission/SubmissionContent.js';
import type { CriterionResult } from '../domain/evaluation/CriterionResult.js';

/**
 * Everything an evaluator is allowed to see.
 *
 * Passing a context object rather than a long parameter list is what keeps
 * change test B cheap: adding, say, the learner's previous evaluations for a
 * "have they fixed last time's problem?" evaluator means one optional field
 * here, not a signature change rippling through every implementation.
 */
export interface EvaluationContext {
  readonly submission: Submission;
  /** Format-neutral projection — rules read this, never the raw content. */
  readonly graph: DesignGraph;
  readonly problem: Problem;
  readonly rubric: Rubric;
  /** Cooperative cancellation, honoured by the orchestrator's per-job timeout. */
  readonly signal?: AbortSignal;
}

export interface EvaluatorOutcome {
  readonly evaluatorId: string;
  readonly results: readonly CriterionResult[];
  /**
   * Optional prose addressed to the learner. Only evaluators that can write
   * naturally set this; deterministic rules leave it out and the orchestrator
   * composes a summary from the results instead.
   */
  readonly summary?: string;
  /**
   * Set when this evaluator could not do its whole job but did not fail
   * outright. The orchestrator surfaces these to the learner instead of
   * silently presenting a thinner evaluation as a complete one.
   */
  readonly degradedReason?: string;
}

/**
 * The extension point of the whole platform.
 *
 * Change test B from the brief ("later you add a rule-based evaluator or human
 * review — can you add it without rewriting the practice flow?") is answered
 * here. `EvaluationOrchestrator` knows only this interface and the registry; it
 * has no idea whether a result came from a regex, a language model or a senior
 * engineer with an opinion. Adding `HumanReviewEvaluator` is a new class plus a
 * `register()` call.
 *
 * The contract each implementation must honour:
 *  - only score criteria that exist in `context.rubric`;
 *  - never exceed a criterion's `maxScore`;
 *  - throw only for genuine failure — return a low-confidence result when
 *    uncertain, so one shaky judgement cannot sink an entire evaluation.
 */
export interface Evaluator {
  readonly id: string;
  /** Declared support, so an unsupported format is a clear error, not a crash. */
  supports(format: SubmissionFormat): boolean;
  evaluate(context: EvaluationContext): Promise<EvaluatorOutcome>;
}
