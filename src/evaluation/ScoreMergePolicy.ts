import type {
  CriterionResult,
  EvaluationSource,
} from '../domain/evaluation/CriterionResult.js';
import type { Rubric } from '../domain/rubric/Rubric.js';

/**
 * Decides what happens when two evaluators score the same criterion.
 *
 * Extracted as its own strategy rather than buried in the composite because it
 * encodes a genuine product judgement that will be argued about and retuned,
 * and because a future human-review evaluator needs to override both machines
 * without that rule being tangled into the fan-out logic.
 */
export interface ScoreMergePolicy {
  readonly id: string;
  merge(params: {
    rubric: Rubric;
    resultsByEvaluator: ReadonlyMap<string, readonly CriterionResult[]>;
  }): readonly CriterionResult[];
}

/**
 * The default: each criterion is decided by the source the rubric says owns it.
 *
 * The alternative — averaging every evaluator's score — was rejected
 * deliberately. Averaging a definite structural finding ("this relationship
 * points at a type you never declared") with a model's softer read of the same
 * criterion produces a number that is true of neither, and destroys the
 * property that makes the deterministic half worth having: that its verdicts
 * are checkable and reproducible.
 *
 * Precedence when the owning source is missing (a criterion's owner failed, or
 * a human weighed in) falls back through `SOURCE_PRECEDENCE`, so a partial
 * evaluation degrades to the best available opinion rather than to silence.
 */
export class OwnerWinsMergePolicy implements ScoreMergePolicy {
  readonly id = 'owner-wins-v1';

  merge(params: {
    rubric: Rubric;
    resultsByEvaluator: ReadonlyMap<string, readonly CriterionResult[]>;
  }): readonly CriterionResult[] {
    const all = [...params.resultsByEvaluator.values()].flat();
    const merged: CriterionResult[] = [];

    for (const criterion of params.rubric.criteria) {
      const candidates = all.filter((r) => r.criterionId === criterion.id);
      if (candidates.length === 0) continue;

      const owned = candidates.filter((r) => r.source === criterion.owner);
      const chosen = owned.length > 0 ? pickBest(owned) : pickByPrecedence(candidates);
      if (!chosen) continue;

      // When a non-owning source also had something to say, its concern is kept
      // as an appended note rather than discarded. The learner loses nothing,
      // and it stays obvious which source the score itself came from.
      const others = candidates.filter((r) => r !== chosen && r.concern.trim().length > 0);
      merged.push(others.length === 0 ? chosen : withSecondOpinion(chosen, others));
    }

    return merged;
  }
}

/**
 * Fallback order when the criterion's declared owner produced nothing.
 * Human review outranks both machines wherever it exists.
 */
const SOURCE_PRECEDENCE: readonly EvaluationSource[] = ['human', 'deterministic', 'llm'];

/** Highest-confidence result wins among equals from the same source. */
function pickBest(results: readonly CriterionResult[]): CriterionResult | undefined {
  return [...results].sort((a, b) => b.confidence - a.confidence)[0];
}

function pickByPrecedence(results: readonly CriterionResult[]): CriterionResult | undefined {
  for (const source of SOURCE_PRECEDENCE) {
    const match = results.filter((r) => r.source === source);
    if (match.length > 0) return pickBest(match);
  }
  return pickBest(results);
}

function withSecondOpinion(
  chosen: CriterionResult,
  others: readonly CriterionResult[],
): CriterionResult {
  const notes = others.map((o) => `[${o.source}] ${o.concern}`).join(' ');
  return {
    ...chosen,
    concern: chosen.concern ? `${chosen.concern} ${notes}` : notes,
    evidence: [...chosen.evidence, ...others.flatMap((o) => o.evidence)].slice(0, 6),
  };
}
