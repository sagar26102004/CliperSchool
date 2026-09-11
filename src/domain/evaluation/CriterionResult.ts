import type { CriterionId } from '../ids.js';

export type EvaluationSource = 'deterministic' | 'llm' | 'human';

/**
 * One criterion's verdict — the atom of all feedback in the product.
 *
 * The shape is the answer to "what makes feedback useful when more than one
 * design is valid?". A bare number tells a learner nothing they can act on, and
 * comparing against a reference solution punishes designs that are different
 * rather than worse. So every result must carry, in order:
 *
 *   score      — where they landed on this dimension
 *   evidence   — quoted from *their* submission, so the judgement is checkable
 *   concern    — the specific weakness, not a genre of weakness
 *   suggestion — one concrete thing to change on the next attempt
 *   confidence — how much to trust this row, surfaced honestly in the UI
 *
 * Deterministic rules and the LLM both emit exactly this record. That is what
 * lets them be merged, compared, and rendered by one template — and what lets a
 * future human reviewer join in without a new feedback pipeline.
 */
export interface CriterionResult {
  readonly criterionId: CriterionId;
  readonly score: number;
  readonly maxScore: number;
  /**
   * Verbatim fragments from the submission that justify the score. Required to
   * be non-empty in spirit; an empty array is allowed only when the concern is
   * precisely that something is *absent*, and the UI says so explicitly.
   */
  readonly evidence: readonly string[];
  readonly concern: string;
  readonly suggestion: string;
  /** 0..1. Low confidence is displayed, never silently hidden. */
  readonly confidence: number;
  readonly source: EvaluationSource;
}

export function clampScore(score: number, maxScore: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(maxScore, Math.round(score * 100) / 100));
}

export function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
}

export function makeCriterionResult(params: {
  criterionId: CriterionId;
  score: number;
  maxScore: number;
  evidence?: readonly string[];
  concern: string;
  suggestion: string;
  confidence: number;
  source: EvaluationSource;
}): CriterionResult {
  return {
    criterionId: params.criterionId,
    score: clampScore(params.score, params.maxScore),
    maxScore: params.maxScore,
    evidence: params.evidence ?? [],
    concern: params.concern,
    suggestion: params.suggestion,
    confidence: clampConfidence(params.confidence),
    source: params.source,
  };
}
