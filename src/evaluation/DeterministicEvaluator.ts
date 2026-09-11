import type { CriterionId } from '../domain/ids.js';
import type { SubmissionFormat } from '../domain/submission/SubmissionContent.js';
import type { Evaluator, EvaluationContext, EvaluatorOutcome } from './Evaluator.js';
import { combineResults, type Rule, type RuleFinding } from './rules/Rule.js';
import {
  ConceptCoverageRule,
  MinimumViableSpecRule,
  ResponsibilityStatedRule,
} from './rules/CompletenessRules.js';
import {
  DanglingRelationshipRule,
  InheritanceCycleRule,
  OrphanTypeRule,
  UnimplementedAbstractionRule,
} from './rules/StructuralRules.js';
import { ScenarioEngagementRule } from './rules/ScenarioEngagementRule.js';

/**
 * Scores every criterion the rubric marks `deterministic`.
 *
 * Everything this evaluator does is free, instant, identical on every run and
 * incapable of inventing evidence. That is why the structural criteria were
 * given to it rather than to the model: an LLM asked whether a relationship
 * points at a declared type will usually say yes, because it can infer what was
 * meant. Inference is the wrong behaviour for a check whose entire value is
 * catching the thing the learner forgot to write down.
 *
 * It also means every submission gets *some* real feedback even when the model
 * is unreachable — the basis of the degraded-but-useful path in the orchestrator.
 */
export class DeterministicEvaluator implements Evaluator {
  readonly id = 'deterministic-v1';

  private readonly rules: readonly Rule[];

  constructor(rules?: readonly Rule[]) {
    this.rules = rules ?? DeterministicEvaluator.defaultRules();
  }

  static defaultRules(): readonly Rule[] {
    return [
      new MinimumViableSpecRule(),
      new ResponsibilityStatedRule(),
      new ConceptCoverageRule(),
      new DanglingRelationshipRule(),
      new OrphanTypeRule(),
      new InheritanceCycleRule(),
      new UnimplementedAbstractionRule(),
      new ScenarioEngagementRule(),
    ];
  }

  /**
   * Any format the adapter registry can project into a `DesignGraph` works
   * here, because the rules were written against the graph rather than against
   * the design-spec shape. That is change test A paying off in practice.
   */
  supports(format: SubmissionFormat): boolean {
    return format === 'design-spec' || format === 'class-diagram';
  }

  async evaluate(context: EvaluationContext): Promise<EvaluatorOutcome> {
    const byCriterion = new Map<CriterionId, RuleFinding[]>();
    const skipped: string[] = [];

    for (const rule of this.rules) {
      // A rule whose criterion this rubric version does not contain is skipped
      // rather than treated as an error, so rubric v2 can drop a criterion
      // without breaking evaluations already in flight.
      if (!context.rubric.has(rule.criterionId)) {
        skipped.push(rule.id);
        continue;
      }
      const finding = rule.apply(context);
      const existing = byCriterion.get(rule.criterionId);
      if (existing) existing.push(finding);
      else byCriterion.set(rule.criterionId, [finding]);
    }

    const results = [...byCriterion.entries()].map(([criterionId, findings]) =>
      combineResults(criterionId, context.rubric.criterion(criterionId).maxScore, findings),
    );

    return {
      evaluatorId: this.id,
      results,
      ...(skipped.length > 0
        ? { degradedReason: `Rules skipped (criterion not in rubric): ${skipped.join(', ')}` }
        : {}),
    };
  }
}
