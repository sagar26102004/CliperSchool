import type { CriterionId } from '../../domain/ids.js';
import type { CriterionResult } from '../../domain/evaluation/CriterionResult.js';
import type { EvaluationContext } from '../Evaluator.js';

/**
 * One mechanical check against one criterion.
 *
 * Rules are separate small classes rather than branches inside a single big
 * evaluator for three concrete reasons: each is unit-testable in isolation,
 * each can be enabled or reweighted independently, and a new deterministic
 * check is a new file rather than an edit to a function everything depends on.
 */
export interface Rule {
  readonly id: string;
  readonly criterionId: CriterionId;
  apply(context: EvaluationContext): RuleFinding;
}

/**
 * A rule's raw output.
 *
 * Rules report a normalised 0..1 `ratio` rather than a raw score, so they stay
 * ignorant of the rubric's `maxScore` — retuning the rubric never means editing
 * a rule. `DeterministicEvaluator` scales and assembles the final results.
 */
export interface RuleFinding {
  readonly ratio: number;
  readonly evidence: readonly string[];
  readonly concern: string;
  readonly suggestion: string;
  readonly confidence: number;
  /**
   * False when the rule had nothing to examine — no inheritance edges to check
   * for cycles, no abstractions to check for implementers.
   *
   * Inapplicable findings are excluded from the average rather than scored,
   * because a check that could not run must never award marks. Without this an
   * empty submission passes structural integrity by vacuous truth: no declared
   * relationships means no dangling ones, and the learner is congratulated on a
   * design they did not write.
   */
  readonly applicable?: boolean;
}

/** A rule declaring it had nothing to look at. */
export function notApplicable(reason: string): RuleFinding {
  return {
    ratio: 0,
    evidence: [],
    concern: reason,
    suggestion: '',
    confidence: 0,
    applicable: false,
  };
}

/** Truncates a quoted fragment so evidence stays readable in the UI. */
export function quote(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function combineResults(
  criterionId: CriterionId,
  maxScore: number,
  findings: readonly RuleFinding[],
): CriterionResult {
  const applicable = findings.filter((f) => f.applicable !== false);

  if (applicable.length === 0) {
    // Either no rules ran, or every rule found nothing to examine. Both mean
    // the same thing to the learner and both must score zero: a criterion that
    // could not be assessed is not a criterion that was passed.
    const reasons = findings.map((f) => f.concern).filter((c) => c.length > 0);
    return {
      criterionId,
      score: 0,
      maxScore,
      evidence: [],
      concern:
        reasons.length > 0
          ? reasons.join(' ')
          : 'There was nothing in this submission to assess against this criterion.',
      suggestion:
        'Add the missing parts of the design — this criterion cannot be scored until there is something to look at.',
      confidence: 0,
      source: 'deterministic',
    };
  }

  const ratio = applicable.reduce((sum, f) => sum + f.ratio, 0) / applicable.length;
  const concerns = applicable.map((f) => f.concern).filter((c) => c.length > 0);
  const suggestions = applicable
    .filter((f) => f.ratio < 1 && f.suggestion.length > 0)
    .map((f) => f.suggestion);
  const confidence =
    applicable.reduce((sum, f) => sum + f.confidence, 0) / applicable.length;

  return {
    criterionId,
    score: Math.round(ratio * maxScore * 100) / 100,
    maxScore,
    evidence: applicable.flatMap((f) => f.evidence).slice(0, 6),
    concern: concerns.length > 0 ? concerns.join(' ') : 'No structural problems found.',
    suggestion:
      suggestions.length > 0
        ? suggestions.join(' ')
        : 'Structurally sound — the judgement criteria below are where the remaining points are.',
    confidence: Math.round(confidence * 100) / 100,
    source: 'deterministic',
  };
}
