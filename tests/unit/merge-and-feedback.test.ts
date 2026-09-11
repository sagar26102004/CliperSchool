import { describe, expect, it } from 'vitest';
import { OwnerWinsMergePolicy } from '../../src/evaluation/ScoreMergePolicy.js';
import { CompositeEvaluator } from '../../src/evaluation/CompositeEvaluator.js';
import type { Evaluator, EvaluationContext } from '../../src/evaluation/Evaluator.js';
import {
  makeCriterionResult,
  type CriterionResult,
  type EvaluationSource,
} from '../../src/domain/evaluation/CriterionResult.js';
import { Evaluation } from '../../src/domain/evaluation/Evaluation.js';
import { FeedbackReport } from '../../src/domain/feedback/FeedbackReport.js';
import {
  asCriterionId,
  asEvaluationId,
  asSubmissionId,
} from '../../src/domain/ids.js';
import { defaultAdapterRegistry } from '../../src/domain/submission/DesignGraph.js';
import { Submission } from '../../src/domain/submission/Submission.js';
import { asAttemptId } from '../../src/domain/ids.js';
import { LlmUnavailableError } from '../../src/infra/llm/LlmClient.js';
import { CORE_RUBRIC } from '../../src/seed/rubric.js';
import { SEED_PROBLEMS } from '../../src/seed/problems/index.js';
import { strongDesign } from '../fixtures.js';

const adapters = defaultAdapterRegistry();
const problem = SEED_PROBLEMS.find((p) => p.slug === 'parking-lot')!;

function context(): EvaluationContext {
  return {
    submission: new Submission({
      id: asSubmissionId('sub_1'),
      attemptId: asAttemptId('att_1'),
      content: strongDesign,
      submittedAt: new Date('2026-01-01T00:00:00Z'),
    }),
    graph: adapters.toGraph(strongDesign),
    problem,
    rubric: CORE_RUBRIC,
  };
}

function result(
  criterionId: string,
  score: number,
  source: EvaluationSource,
  extras: { concern?: string; confidence?: number } = {},
): CriterionResult {
  return makeCriterionResult({
    criterionId: asCriterionId(criterionId),
    score,
    maxScore: 5,
    evidence: [`evidence from ${source}`],
    concern: extras.concern ?? `${source} concern`,
    suggestion: `${source} suggestion`,
    confidence: extras.confidence ?? 0.8,
    source,
  });
}

class FixedEvaluator implements Evaluator {
  constructor(
    readonly id: string,
    private readonly results: readonly CriterionResult[],
  ) {}
  supports(): boolean {
    return true;
  }
  async evaluate() {
    return { evaluatorId: this.id, results: this.results };
  }
}

class ExplodingEvaluator implements Evaluator {
  constructor(readonly id: string) {}
  supports(): boolean {
    return true;
  }
  async evaluate(): Promise<never> {
    throw new LlmUnavailableError('provider down');
  }
}

describe('OwnerWinsMergePolicy', () => {
  const policy = new OwnerWinsMergePolicy();

  it('lets the deterministic result win a structural criterion', () => {
    // 'structural-integrity' is owned by the deterministic evaluator: a
    // definite structural finding must not be diluted by a model's softer read.
    const merged = policy.merge({
      rubric: CORE_RUBRIC,
      resultsByEvaluator: new Map([
        ['det', [result('structural-integrity', 1, 'deterministic')]],
        ['llm', [result('structural-integrity', 5, 'llm')]],
      ]),
    });

    const structural = merged.find((r) => String(r.criterionId) === 'structural-integrity')!;
    expect(structural.score).toBe(1);
    expect(structural.source).toBe('deterministic');
  });

  it('lets the model win a judgement criterion', () => {
    const merged = policy.merge({
      rubric: CORE_RUBRIC,
      resultsByEvaluator: new Map([
        ['det', [result('class-responsibilities', 5, 'deterministic')]],
        ['llm', [result('class-responsibilities', 2, 'llm')]],
      ]),
    });

    const responsibilities = merged.find(
      (r) => String(r.criterionId) === 'class-responsibilities',
    )!;
    expect(responsibilities.score).toBe(2);
    expect(responsibilities.source).toBe('llm');
  });

  it('never averages the two, which would produce a number true of neither', () => {
    const merged = policy.merge({
      rubric: CORE_RUBRIC,
      resultsByEvaluator: new Map([
        ['det', [result('structural-integrity', 0, 'deterministic')]],
        ['llm', [result('structural-integrity', 4, 'llm')]],
      ]),
    });

    expect(merged[0]!.score).toBe(0);
    expect(merged[0]!.score).not.toBe(2);
  });

  it('keeps the losing evaluator concern as a second opinion rather than discarding it', () => {
    const merged = policy.merge({
      rubric: CORE_RUBRIC,
      resultsByEvaluator: new Map([
        [
          'det',
          [result('structural-integrity', 3, 'deterministic', { concern: 'orphan type Auditor' })],
        ],
        ['llm', [result('structural-integrity', 4, 'llm', { concern: 'the graph looks thin' })]],
      ]),
    });

    expect(merged[0]!.concern).toContain('orphan type Auditor');
    expect(merged[0]!.concern).toContain('[llm] the graph looks thin');
  });

  it('falls back to whatever source is available when the owner produced nothing', () => {
    const merged = policy.merge({
      rubric: CORE_RUBRIC,
      resultsByEvaluator: new Map([
        ['det', [result('class-responsibilities', 3, 'deterministic')]],
      ]),
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe('deterministic');
  });

  it('lets a human reviewer override both machines', () => {
    const merged = policy.merge({
      rubric: CORE_RUBRIC,
      resultsByEvaluator: new Map([
        ['det', [result('structural-integrity', 1, 'deterministic')]],
        ['human', [result('structural-integrity', 5, 'human')]],
      ]),
    });

    // Deterministic owns this criterion, so it still wins — human precedence
    // only applies where the declared owner is silent.
    expect(merged[0]!.source).toBe('deterministic');

    const judgement = policy.merge({
      rubric: CORE_RUBRIC,
      resultsByEvaluator: new Map([
        ['det', [result('class-responsibilities', 1, 'deterministic')]],
        ['human', [result('class-responsibilities', 5, 'human')]],
      ]),
    });
    expect(judgement[0]!.source).toBe('human');
  });

  it('drops results for criteria the rubric version does not contain', () => {
    const merged = policy.merge({
      rubric: CORE_RUBRIC,
      resultsByEvaluator: new Map([['llm', [result('invented-criterion', 5, 'llm')]]]),
    });

    expect(merged).toHaveLength(0);
  });
});

describe('CompositeEvaluator', () => {
  it('degrades instead of failing when an optional evaluator falls over', async () => {
    const composite = new CompositeEvaluator(
      [
        {
          evaluator: new FixedEvaluator('det', [result('structural-integrity', 4, 'deterministic')]),
          required: true,
        },
        { evaluator: new ExplodingEvaluator('llm'), required: false },
      ],
      new OwnerWinsMergePolicy(),
    );

    const outcome = await composite.evaluate(context());

    // The learner still gets real feedback from the half that worked.
    expect(outcome.results).toHaveLength(1);
    expect(outcome.degradedReason).toContain('provider down');
  });

  it('fails outright when a required evaluator falls over, because that is a platform bug', async () => {
    const composite = new CompositeEvaluator(
      [
        { evaluator: new ExplodingEvaluator('det'), required: true },
        {
          evaluator: new FixedEvaluator('llm', [result('class-responsibilities', 4, 'llm')]),
          required: false,
        },
      ],
      new OwnerWinsMergePolicy(),
    );

    await expect(composite.evaluate(context())).rejects.toThrow(LlmUnavailableError);
  });
});

describe('FeedbackReport', () => {
  function evaluationWith(results: readonly CriterionResult[], id = 'eval_1'): Evaluation {
    const evaluation = new Evaluation({
      id: asEvaluationId(id),
      submissionId: asSubmissionId('sub_1'),
      rubricVersionTag: CORE_RUBRIC.versionTag,
      queuedAt: new Date('2026-01-01T00:00:00Z'),
    });
    evaluation.start(new Date('2026-01-01T00:00:01Z'));
    evaluation.complete({
      results,
      summary: 'summary',
      at: new Date('2026-01-01T00:00:05Z'),
    });
    return evaluation;
  }

  it('ranks focus areas by weighted points lost, not by lowest raw score', () => {
    // extensibility carries weight 16; scenario-engagement only 6. A near-miss
    // on the heavy criterion is worth more to the learner than a total miss on
    // the light one, so it must be listed first.
    const evaluation = evaluationWith([
      result('extensibility', 2.5, 'llm'),
      result('scenario-engagement', 0, 'deterministic'),
    ]);

    const report = FeedbackReport.from(evaluation, CORE_RUBRIC);

    expect(String(report.focusAreas[0]!.criterion.id)).toBe('extensibility');
  });

  it('caps focus areas at three, so the next attempt has a reachable target', () => {
    const evaluation = evaluationWith(
      CORE_RUBRIC.criteria.map((c) => result(String(c.id), 1, c.owner)),
    );

    const report = FeedbackReport.from(evaluation, CORE_RUBRIC);
    expect(report.focusAreas.length).toBe(3);
  });

  it('separates strengths from focus areas', () => {
    const evaluation = evaluationWith([
      result('structural-integrity', 5, 'deterministic'),
      result('class-responsibilities', 1, 'llm'),
    ]);

    const report = FeedbackReport.from(evaluation, CORE_RUBRIC);

    expect(report.strengths.map((s) => String(s.criterion.id))).toEqual([
      'structural-integrity',
    ]);
    expect(report.focusAreas.map((s) => String(s.criterion.id))).toEqual([
      'class-responsibilities',
    ]);
  });

  it('surfaces low-confidence rows so the learner knows which are prompts, not verdicts', () => {
    const evaluation = evaluationWith([
      result('spec-completeness', 3, 'deterministic', { confidence: 0.3 }),
      result('class-responsibilities', 3, 'llm', { confidence: 0.9 }),
    ]);

    const report = FeedbackReport.from(evaluation, CORE_RUBRIC);

    expect(report.lowConfidence.map((s) => String(s.criterion.id))).toEqual([
      'spec-completeness',
    ]);
  });

  it('scores an evaluation over what was actually assessed, not over the whole rubric', () => {
    // A partial evaluation must not report a misleadingly low score just
    // because the model leg never ran.
    const evaluation = evaluationWith([result('structural-integrity', 5, 'deterministic')]);

    const report = FeedbackReport.from(evaluation, CORE_RUBRIC);

    expect(report.overallScore).toBe(100);
    expect(report.unscored.length).toBe(CORE_RUBRIC.criteria.length - 1);
  });

  describe('recurring weaknesses', () => {
    it('needs at least two attempts before calling anything a pattern', () => {
      const one = evaluationWith([result('class-responsibilities', 1, 'llm')]);
      expect(FeedbackReport.recurringWeaknesses([one], CORE_RUBRIC)).toHaveLength(0);
    });

    it('reports a criterion that keeps scoring weakly across attempts', () => {
      const evaluations = [
        evaluationWith([result('class-responsibilities', 1, 'llm')], 'eval_1'),
        evaluationWith([result('class-responsibilities', 2, 'llm')], 'eval_2'),
        evaluationWith([result('class-responsibilities', 1.5, 'llm')], 'eval_3'),
      ];

      const recurring = FeedbackReport.recurringWeaknesses(evaluations, CORE_RUBRIC);

      expect(recurring).toHaveLength(1);
      expect(String(recurring[0]!.criterion.id)).toBe('class-responsibilities');
      expect(recurring[0]!.weakCount).toBe(3);
      expect(recurring[0]!.consideredCount).toBe(3);
    });

    it('does not call a single bad attempt a recurring weakness', () => {
      const evaluations = [
        evaluationWith([result('class-responsibilities', 1, 'llm')], 'eval_1'),
        evaluationWith([result('class-responsibilities', 5, 'llm')], 'eval_2'),
        evaluationWith([result('class-responsibilities', 5, 'llm')], 'eval_3'),
      ];

      expect(FeedbackReport.recurringWeaknesses(evaluations, CORE_RUBRIC)).toHaveLength(0);
    });

    it('ignores evaluations that never completed', () => {
      const failed = new Evaluation({
        id: asEvaluationId('eval_failed'),
        submissionId: asSubmissionId('sub_2'),
        rubricVersionTag: CORE_RUBRIC.versionTag,
        queuedAt: new Date('2026-01-01T00:00:00Z'),
      });
      failed.start(new Date('2026-01-01T00:00:01Z'));
      failed.fail('provider down', new Date('2026-01-01T00:00:02Z'));

      const evaluations = [
        evaluationWith([result('class-responsibilities', 1, 'llm')], 'eval_1'),
        failed,
      ];

      expect(FeedbackReport.recurringWeaknesses(evaluations, CORE_RUBRIC)).toHaveLength(0);
    });
  });
});

describe('partial evaluations are reported honestly', () => {
  function partialEvaluation(): Evaluation {
    const evaluation = new Evaluation({
      id: asEvaluationId('eval_partial'),
      submissionId: asSubmissionId('sub_1'),
      rubricVersionTag: CORE_RUBRIC.versionTag,
      queuedAt: new Date('2026-01-01T00:00:00Z'),
    });
    evaluation.start(new Date('2026-01-01T00:00:01Z'));
    // Only the deterministic criteria ran, and they all scored near-perfectly.
    evaluation.complete({
      results: CORE_RUBRIC.criteriaOwnedBy('deterministic').map((c) =>
        result(String(c.id), 5, 'deterministic'),
      ),
      summary: 'Structural checks completed.',
      at: new Date('2026-01-01T00:00:05Z'),
      partial: true,
      degradedReasons: ['llm-v1 could not contribute: provider down'],
    });
    return evaluation;
  }

  it('publishes how much of the rubric was actually assessed', () => {
    const report = FeedbackReport.from(partialEvaluation(), CORE_RUBRIC);

    // A near-perfect percentage over a quarter of the rubric must not be
    // presentable as if it were a full score.
    expect(report.overallScore).toBe(100);
    expect(report.isComplete).toBe(false);
    expect(report.assessedWeightShare).toBeLessThan(30);
    expect(report.assessedWeightShare).toBeGreaterThan(0);
  });

  it('reports full coverage when every criterion was scored', () => {
    const evaluation = new Evaluation({
      id: asEvaluationId('eval_full'),
      submissionId: asSubmissionId('sub_1'),
      rubricVersionTag: CORE_RUBRIC.versionTag,
      queuedAt: new Date('2026-01-01T00:00:00Z'),
    });
    evaluation.start(new Date('2026-01-01T00:00:01Z'));
    evaluation.complete({
      results: CORE_RUBRIC.criteria.map((c) => result(String(c.id), 4, c.owner)),
      summary: 'ok',
      at: new Date('2026-01-01T00:00:05Z'),
    });

    const report = FeedbackReport.from(evaluation, CORE_RUBRIC);
    expect(report.isComplete).toBe(true);
    expect(report.assessedWeightShare).toBe(100);
  });
});
