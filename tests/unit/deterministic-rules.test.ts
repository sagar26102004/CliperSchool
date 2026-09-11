import { describe, expect, it } from 'vitest';
import { DeterministicEvaluator } from '../../src/evaluation/DeterministicEvaluator.js';
import type { EvaluationContext } from '../../src/evaluation/Evaluator.js';
import { defaultAdapterRegistry } from '../../src/domain/submission/DesignGraph.js';
import { Submission } from '../../src/domain/submission/Submission.js';
import { asAttemptId, asSubmissionId } from '../../src/domain/ids.js';
import type { DesignSpecContent } from '../../src/domain/submission/SubmissionContent.js';
import { CORE_RUBRIC } from '../../src/seed/rubric.js';
import { SEED_PROBLEMS } from '../../src/seed/problems/index.js';
import {
  alternativeStrongDesign,
  brokenDesign,
  strongDesign,
  weakDesign,
} from '../fixtures.js';

const adapters = defaultAdapterRegistry();
const parkingLot = SEED_PROBLEMS.find((p) => p.slug === 'parking-lot');
if (!parkingLot) throw new Error('parking-lot problem missing from seed data');

function contextFor(content: DesignSpecContent): EvaluationContext {
  const submission = new Submission({
    id: asSubmissionId('sub_test'),
    attemptId: asAttemptId('att_test'),
    content,
    submittedAt: new Date('2026-01-01T00:00:00Z'),
  });
  return {
    submission,
    graph: adapters.toGraph(content),
    problem: parkingLot!,
    rubric: CORE_RUBRIC,
  };
}

async function scoresFor(content: DesignSpecContent): Promise<Map<string, number>> {
  const outcome = await new DeterministicEvaluator().evaluate(contextFor(content));
  return new Map(
    outcome.results.map((r) => [
      String(r.criterionId),
      r.maxScore === 0 ? 0 : r.score / r.maxScore,
    ]),
  );
}

describe('DeterministicEvaluator', () => {
  it('scores only the criteria the rubric marks deterministic', async () => {
    const outcome = await new DeterministicEvaluator().evaluate(contextFor(strongDesign));
    const scored = outcome.results.map((r) => String(r.criterionId)).sort();

    expect(scored).toEqual([
      'scenario-engagement',
      'spec-completeness',
      'structural-integrity',
    ]);
    // Judgement criteria are the model's job; claiming them here would let a
    // regex overrule a reasoned opinion.
    expect(scored).not.toContain('class-responsibilities');
    expect(scored).not.toContain('extensibility');
  });

  it('rates a considered design well above a thin one on every structural criterion', async () => {
    const strong = await scoresFor(strongDesign);
    const weak = await scoresFor(weakDesign);

    for (const criterionId of strong.keys()) {
      expect(
        weak.get(criterionId),
        `${criterionId} should separate a considered design from a thin one`,
      ).toBeLessThan(strong.get(criterionId)!);
    }
  });

  it('catches a dangling relationship endpoint and names it', async () => {
    const outcome = await new DeterministicEvaluator().evaluate(contextFor(brokenDesign));
    const structural = outcome.results.find(
      (r) => String(r.criterionId) === 'structural-integrity',
    );

    expect(structural).toBeDefined();
    expect(structural!.concern).toContain('never declared');
    expect(structural!.evidence.join(' ')).toContain('FeeCalculator');
    expect(structural!.score).toBeLessThan(structural!.maxScore * 0.6);
  });

  it('catches an inheritance cycle, which no LLM should be asked to adjudicate', async () => {
    const outcome = await new DeterministicEvaluator().evaluate(contextFor(brokenDesign));
    const structural = outcome.results.find(
      (r) => String(r.criterionId) === 'structural-integrity',
    );

    expect(structural!.concern).toContain('cycle');
    expect(structural!.evidence.some((e) => e.includes('->'))).toBe(true);
  });

  it('flags a type that participates in no relationship', async () => {
    const outcome = await new DeterministicEvaluator().evaluate(contextFor(brokenDesign));
    const structural = outcome.results.find(
      (r) => String(r.criterionId) === 'structural-integrity',
    );

    expect(structural!.concern).toContain('Auditor');
  });

  it('marks a generic change-scenario answer as unengaged with the design', async () => {
    const outcome = await new DeterministicEvaluator().evaluate(contextFor(weakDesign));
    const engagement = outcome.results.find(
      (r) => String(r.criterionId) === 'scenario-engagement',
    );

    expect(engagement!.score).toBeLessThan(engagement!.maxScore * 0.5);
    expect(engagement!.concern).toMatch(/too short|never names a type/);
  });

  it('credits a scenario answer that names types from the submitted design', async () => {
    const outcome = await new DeterministicEvaluator().evaluate(contextFor(strongDesign));
    const engagement = outcome.results.find(
      (r) => String(r.criterionId) === 'scenario-engagement',
    );

    expect(engagement!.score).toBeGreaterThan(engagement!.maxScore * 0.8);
    expect(engagement!.evidence.join(' ')).toContain('References own types');
  });

  it('never matches a type name as a substring of a longer word', async () => {
    // "Car" must not be considered referenced by the word "Cards" alone.
    const content: DesignSpecContent = {
      ...weakDesign,
      types: [
        {
          name: 'Car',
          responsibility: 'Represents a vehicle arriving at the gate for parking.',
          kind: 'class',
          attributes: [],
          methods: [],
        },
      ],
      changeScenarioAnswers: [
        {
          scenarioId: weakDesign.changeScenarioAnswers[0]!.scenarioId,
          text: 'Cards and Carpets would be affected by this change in a variety of ways that I will now describe at some length to clear the substance threshold.',
        },
      ],
    };

    const outcome = await new DeterministicEvaluator().evaluate(contextFor(content));
    const engagement = outcome.results.find(
      (r) => String(r.criterionId) === 'scenario-engagement',
    );

    expect(engagement!.concern).toContain('never names a type');
  });

  it('scores two different but valid designs comparably', async () => {
    // The central claim of the product: evaluation must reward design quality,
    // not resemblance to one reference answer.
    const first = await scoresFor(strongDesign);
    const second = await scoresFor(alternativeStrongDesign);

    for (const [criterionId, firstRatio] of first) {
      const secondRatio = second.get(criterionId)!;
      expect(secondRatio).toBeGreaterThan(0.7);
      expect(
        Math.abs(firstRatio - secondRatio),
        `${criterionId} should not favour one valid design over another`,
      ).toBeLessThan(0.25);
    }
  });

  it('reports low confidence on concept coverage, because keyword presence is weak evidence', async () => {
    const outcome = await new DeterministicEvaluator().evaluate(
      contextFor(alternativeStrongDesign),
    );
    const completeness = outcome.results.find(
      (r) => String(r.criterionId) === 'spec-completeness',
    );

    // The combined confidence is dragged down by the coverage rule on purpose,
    // so the UI can tell the learner which rows to treat as prompts.
    expect(completeness!.confidence).toBeLessThan(1);
    expect(completeness!.confidence).toBeGreaterThan(0);
  });

  it('survives an empty design without throwing, and says why it cannot score it', async () => {
    const empty: DesignSpecContent = {
      format: 'design-spec',
      assumptions: [],
      types: [],
      relationships: [],
      tradeoffs: '',
      changeScenarioAnswers: [],
    };

    const outcome = await new DeterministicEvaluator().evaluate(contextFor(empty));

    expect(outcome.results.length).toBeGreaterThan(0);
    for (const result of outcome.results) {
      expect(result.score).toBe(0);
      expect(result.concern.length).toBeGreaterThan(0);
      expect(result.suggestion.length).toBeGreaterThan(0);
    }
  });

  it('skips rules whose criterion is absent from the rubric rather than failing', async () => {
    const trimmedRubric = new (CORE_RUBRIC.constructor as typeof import('../../src/domain/rubric/Rubric.js').Rubric)(
      {
        id: CORE_RUBRIC.id,
        version: 2,
        name: 'Trimmed',
        criteria: CORE_RUBRIC.criteria.filter(
          (c) => String(c.id) !== 'structural-integrity',
        ),
      },
    );

    const context = { ...contextFor(strongDesign), rubric: trimmedRubric };
    const outcome = await new DeterministicEvaluator().evaluate(context);

    expect(outcome.results.map((r) => String(r.criterionId))).not.toContain(
      'structural-integrity',
    );
    expect(outcome.degradedReason).toContain('Rules skipped');
  });
});
