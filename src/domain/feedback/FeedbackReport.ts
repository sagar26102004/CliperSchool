import type { CriterionResult } from '../evaluation/CriterionResult.js';
import type { Evaluation } from '../evaluation/Evaluation.js';
import type { Rubric, RubricCriterion } from '../rubric/Rubric.js';

export interface ScoredCriterion {
  readonly criterion: RubricCriterion;
  readonly result: CriterionResult;
  readonly ratio: number;
}

export interface RecurringWeakness {
  readonly criterion: RubricCriterion;
  /** How many of the learner's recent evaluations scored this criterion weakly. */
  readonly weakCount: number;
  readonly consideredCount: number;
  readonly latestSuggestion: string;
}

/**
 * How an evaluation is communicated to a learner.
 *
 * Deliberately *derived*, never stored. `Evaluation` owns scoring — versioned,
 * auditable, and never rewritten. This owns presentation: which three things to
 * focus on, what is genuinely going well, and what keeps coming back attempt
 * after attempt. Keeping them apart means the wording and prioritisation of
 * feedback can be improved at any time without invalidating a single historical
 * score, and a stored copy could never disagree with the evaluation it came from.
 *
 * The prioritisation rule is worth stating: focus areas are ranked by
 * *weighted points lost*, not by lowest score. A learner scraping a pass on the
 * heaviest criterion has more to gain there than by fixing a light criterion
 * they failed outright, and telling them otherwise wastes their next attempt.
 */
export class FeedbackReport {
  private constructor(
    readonly overallScore: number,
    readonly summary: string,
    readonly scored: readonly ScoredCriterion[],
    readonly strengths: readonly ScoredCriterion[],
    readonly focusAreas: readonly ScoredCriterion[],
    readonly unscored: readonly RubricCriterion[],
    readonly partial: boolean,
    readonly degradedReasons: readonly string[],
    readonly lowConfidence: readonly ScoredCriterion[],
    /**
     * Share of the rubric's total weight that was actually assessed, 0..100.
     *
     * The score alone is dangerously misleading on a partial evaluation: when
     * only the structural criteria ran, a thin design can post a near-perfect
     * percentage because the criteria it would have failed were never asked.
     * Publishing coverage alongside the score is what keeps the number honest,
     * and the UI marks anything under full coverage as provisional.
     */
    readonly assessedWeightShare: number,
  ) {}

  private static readonly STRENGTH_RATIO = 0.75;
  private static readonly FOCUS_RATIO = 0.7;
  private static readonly LOW_CONFIDENCE = 0.5;
  private static readonly MAX_FOCUS_AREAS = 3;

  static from(evaluation: Evaluation, rubric: Rubric): FeedbackReport {
    const scored: ScoredCriterion[] = [];

    for (const result of evaluation.results) {
      if (!rubric.has(result.criterionId)) continue;
      const criterion = rubric.criterion(result.criterionId);
      scored.push({
        criterion,
        result,
        ratio: result.maxScore === 0 ? 0 : result.score / result.maxScore,
      });
    }

    const scoredIds = new Set(scored.map((s) => String(s.criterion.id)));
    const unscored = rubric.criteria.filter((c) => !scoredIds.has(String(c.id)));

    const strengths = scored
      .filter((s) => s.ratio >= FeedbackReport.STRENGTH_RATIO)
      .sort((a, b) => b.ratio - a.ratio);

    // Ranked by weighted points lost, so the advice points at where the next
    // attempt actually gains the most.
    const focusAreas = scored
      .filter((s) => s.ratio < FeedbackReport.FOCUS_RATIO)
      .sort((a, b) => (1 - b.ratio) * b.criterion.weight - (1 - a.ratio) * a.criterion.weight)
      .slice(0, FeedbackReport.MAX_FOCUS_AREAS);

    const lowConfidence = scored.filter(
      (s) => s.result.confidence < FeedbackReport.LOW_CONFIDENCE,
    );

    const assessedWeight = scored.reduce((sum, s) => sum + s.criterion.weight, 0);
    const assessedWeightShare =
      rubric.totalWeight === 0
        ? 0
        : Math.round((assessedWeight / rubric.totalWeight) * 1000) / 10;

    return new FeedbackReport(
      evaluation.overallScore(rubric),
      evaluation.summary,
      scored,
      strengths,
      focusAreas,
      unscored,
      evaluation.partial,
      evaluation.degradedReasons,
      lowConfidence,
      assessedWeightShare,
    );
  }

  /** True when the score covers the whole rubric and can be compared directly. */
  get isComplete(): boolean {
    return this.unscored.length === 0;
  }

  /**
   * Cross-attempt weakness detection.
   *
   * This is the feature the research suggested was missing everywhere else: a
   * learner can be told their design was weak on encapsulation three times and
   * never notice it is the same note. A criterion counts as recurring only when
   * it was scored weakly in at least half of the recent evaluations *and* at
   * least twice — one bad attempt is noise, and a criterion that was only
   * assessed once cannot be a pattern.
   */
  static recurringWeaknesses(
    evaluations: readonly Evaluation[],
    rubric: Rubric,
    options: { window?: number; weakRatio?: number } = {},
  ): readonly RecurringWeakness[] {
    const window = options.window ?? 5;
    const weakRatio = options.weakRatio ?? FeedbackReport.FOCUS_RATIO;

    const recent = [...evaluations]
      .filter((e) => e.status === 'Completed')
      .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
      .slice(0, window);

    if (recent.length < 2) return [];

    const weakCounts = new Map<string, { weak: number; considered: number; suggestion: string }>();

    for (const evaluation of recent) {
      for (const result of evaluation.results) {
        const key = String(result.criterionId);
        if (!rubric.has(result.criterionId)) continue;
        const entry = weakCounts.get(key) ?? { weak: 0, considered: 0, suggestion: '' };
        entry.considered += 1;
        const ratio = result.maxScore === 0 ? 0 : result.score / result.maxScore;
        if (ratio < weakRatio) {
          entry.weak += 1;
          if (!entry.suggestion) entry.suggestion = result.suggestion;
        }
        weakCounts.set(key, entry);
      }
    }

    const recurring: RecurringWeakness[] = [];
    for (const [criterionId, entry] of weakCounts) {
      if (entry.weak < 2) continue;
      if (entry.weak / entry.considered < 0.5) continue;
      recurring.push({
        criterion: rubric.criterion(criterionId as never),
        weakCount: entry.weak,
        consideredCount: entry.considered,
        latestSuggestion: entry.suggestion,
      });
    }

    return recurring.sort((a, b) => b.weakCount - a.weakCount);
  }
}
