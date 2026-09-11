import { describe, expect, it } from 'vitest';
import { buildContainer, type Container } from '../../src/container.js';
import { asLearnerId, asProblemId } from '../../src/domain/ids.js';
import { FixedClock, SequentialIdGenerator } from '../../src/infra/clock.js';
import { StubLlmClient } from '../../src/infra/llm/StubLlmClient.js';
import { ValidationError } from '../../src/domain/errors.js';
import { FeedbackReport } from '../../src/domain/feedback/FeedbackReport.js';
import { CORE_RUBRIC } from '../../src/seed/rubric.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../../src/infra/llm/LlmClient.js';
import { LlmUnavailableError } from '../../src/infra/llm/LlmClient.js';
import { strongDesign, weakDesign } from '../fixtures.js';

const LEARNER = asLearnerId('learner_1');
const PARKING_LOT = asProblemId('parking-lot');

function makeContainer(overrides: Parameters<typeof buildContainer>[0] = {}): Container {
  return buildContainer({
    clock: new FixedClock(),
    ids: new SequentialIdGenerator(),
    llmClient: new StubLlmClient(),
    // No real backoff waiting in tests; the retry *count* is what matters.
    queueOptions: { baseRetryDelayMs: 0, sleep: async () => {} },
    ...overrides,
  });
}

describe('the practice loop, end to end', () => {
  it('carries a learner from problem selection to explainable feedback', async () => {
    const app = makeContainer();

    // 1. Choose a problem.
    const problem = await app.problems.findBySlug('parking-lot');
    expect(problem).not.toBeNull();

    // 2. Start an attempt.
    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.status).toBe('Draft');

    // 3. Submit. The call returns without waiting on the evaluator.
    const submitted = await app.attemptService.submit({
      attemptId: attempt.id,
      content: strongDesign,
    });
    expect(submitted.deduplicated).toBe(false);
    expect(['Queued', 'Running']).toContain(submitted.evaluation.status);

    // The submission is durable before any evaluation work begins.
    const stored = await app.submissions.findById(submitted.submission.id);
    expect(stored).not.toBeNull();

    // 4. Evaluation completes in the background.
    await app.queue.drain();

    const evaluation = await app.attemptService.getEvaluation(attempt.id);
    expect(evaluation!.status).toBe('Completed');
    expect((await app.attemptService.getAttempt(attempt.id)).status).toBe('Completed');

    // 5. Feedback is rubric-anchored and cites the learner's own words.
    const report = FeedbackReport.from(evaluation!, CORE_RUBRIC);
    expect(report.overallScore).toBeGreaterThan(0);
    expect(report.scored.length).toBe(CORE_RUBRIC.criteria.length);

    for (const scored of report.scored) {
      expect(scored.result.concern.length).toBeGreaterThan(0);
      expect(scored.result.suggestion.length).toBeGreaterThan(0);
    }

    const quoted = report.scored.flatMap((s) => s.result.evidence).join(' ');
    expect(quoted).toContain('ParkingLot');

    // Both halves of the evaluation contributed.
    const sources = new Set(report.scored.map((s) => s.result.source));
    expect(sources).toEqual(new Set(['deterministic', 'llm']));
  });

  it('scores a considered design above a thin one', async () => {
    const app = makeContainer();

    const good = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    await app.attemptService.submit({ attemptId: good.id, content: strongDesign });

    const other = asLearnerId('learner_2');
    const bad = await app.attemptService.startAttempt(other, PARKING_LOT);
    await app.attemptService.submit({ attemptId: bad.id, content: weakDesign });

    await app.queue.drain();

    const goodEval = await app.attemptService.getEvaluation(good.id);
    const badEval = await app.attemptService.getEvaluation(bad.id);

    expect(goodEval!.overallScore(CORE_RUBRIC)).toBeGreaterThan(
      badEval!.overallScore(CORE_RUBRIC) + 15,
    );
  });

  it('treats a duplicate submit as the same submission, not a second evaluation', async () => {
    const app = makeContainer();
    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);

    const first = await app.attemptService.submit({
      attemptId: attempt.id,
      content: strongDesign,
    });
    // The double-click.
    const second = await app.attemptService.submit({
      attemptId: attempt.id,
      content: strongDesign,
    });

    expect(second.deduplicated).toBe(true);
    expect(second.submission.id).toBe(first.submission.id);
    expect(second.evaluation.id).toBe(first.evaluation.id);

    await app.queue.drain();
    // One evaluation, so the learner never sees two scores for one design.
    expect(await app.evaluations.findBySubmissionId(first.submission.id)).not.toBeNull();
  });

  it('hashes content order-independently, so a reordered payload still deduplicates', async () => {
    const app = makeContainer();
    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);

    const first = await app.attemptService.submit({
      attemptId: attempt.id,
      content: strongDesign,
    });

    // Same content, keys in a different order — as a re-serialised form post
    // would arrive.
    const reordered = {
      changeScenarioAnswers: strongDesign.changeScenarioAnswers,
      tradeoffs: strongDesign.tradeoffs,
      relationships: strongDesign.relationships,
      types: strongDesign.types,
      assumptions: strongDesign.assumptions,
      format: 'design-spec' as const,
    };
    const second = await app.attemptService.submit({
      attemptId: attempt.id,
      content: reordered,
    });

    expect(second.deduplicated).toBe(true);
    expect(second.submission.id).toBe(first.submission.id);
  });

  it('rejects a submission that cannot be evaluated, and says exactly why', async () => {
    const app = makeContainer();
    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);

    const promise = app.attemptService.submit({
      attemptId: attempt.id,
      content: { ...strongDesign, types: [], changeScenarioAnswers: [] },
    });

    await expect(promise).rejects.toThrow(ValidationError);
    try {
      await promise;
    } catch (error) {
      expect((error as ValidationError).issues.length).toBe(2);
    }
    // A rejected submission must leave the attempt editable.
    expect((await app.attemptService.getAttempt(attempt.id)).status).toBe('Draft');
  });

  it('rejects an answer to a change scenario that belongs to a different problem', async () => {
    const app = makeContainer();
    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);

    await expect(
      app.attemptService.submit({
        attemptId: attempt.id,
        content: {
          ...strongDesign,
          changeScenarioAnswers: [
            {
              scenarioId: strongDesign.changeScenarioAnswers[0]!.scenarioId,
              text: strongDesign.changeScenarioAnswers[0]!.text,
            },
            { scenarioId: 'elevator-express' as never, text: 'wrong problem entirely' },
          ],
        },
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('when evaluation degrades or fails', () => {
  it('still gives the learner real feedback when only the model leg fails', async () => {
    const app = makeContainer({ llmClient: new StubLlmClient('throw') });

    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    await app.attemptService.submit({ attemptId: attempt.id, content: strongDesign });
    await app.queue.drain();

    const evaluation = await app.attemptService.getEvaluation(attempt.id);

    // Completed, not Failed — the deterministic half is genuinely useful.
    expect(evaluation!.status).toBe('Completed');
    expect(evaluation!.partial).toBe(true);
    expect(evaluation!.degradedReasons.join(' ')).toContain('llm-v1 could not contribute');
    expect(evaluation!.results.length).toBeGreaterThan(0);
    expect(evaluation!.results.every((r) => r.source === 'deterministic')).toBe(true);

    // And the learner is told which criteria were not assessed.
    const report = FeedbackReport.from(evaluation!, CORE_RUBRIC);
    expect(report.unscored.length).toBe(CORE_RUBRIC.criteriaOwnedBy('llm').length);
  });

  it('recovers from a malformed model reply through the repair path', async () => {
    // The stub returns truncated JSON on every call, so both the initial call
    // and the repair fail; the evaluation still completes on deterministic
    // results rather than failing outright.
    const app = makeContainer({ llmClient: new StubLlmClient('malformed') });

    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    await app.attemptService.submit({ attemptId: attempt.id, content: strongDesign });
    await app.queue.drain();

    const evaluation = await app.attemptService.getEvaluation(attempt.id);
    expect(evaluation!.status).toBe('Completed');
    expect(evaluation!.partial).toBe(true);
  });

  it('fails the evaluation, keeps the submission, and allows a retry that succeeds', async () => {
    // A client that fails until told to behave — the shape of a real outage
    // that resolves before the learner clicks retry.
    class FlakyClient implements LlmClient {
      readonly id = 'flaky';
      healthy = false;
      private readonly good = new StubLlmClient();

      async complete(request: LlmRequest): Promise<LlmResponse> {
        if (!this.healthy) throw new LlmUnavailableError('provider down');
        return this.good.complete(request);
      }
    }

    const flaky = new FlakyClient();
    const app = makeContainer({
      llmClient: flaky,
      // Make the deterministic leg required *and* failing is not what we want;
      // instead force the whole evaluator to depend on the model, so a model
      // outage is a genuine evaluation failure rather than a degradation.
      evaluator: {
        id: 'llm-only',
        supports: () => true,
        evaluate: async (ctx) => {
          const { LlmEvaluator } = await import('../../src/evaluation/LlmEvaluator.js');
          return new LlmEvaluator(flaky).evaluate(ctx);
        },
      },
    });

    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    const submitted = await app.attemptService.submit({
      attemptId: attempt.id,
      content: strongDesign,
    });
    await app.queue.drain();

    const failed = await app.attemptService.getEvaluation(attempt.id);
    expect(failed!.status).toBe('Failed');
    expect(failed!.failureReason).toContain('provider down');
    expect((await app.attemptService.getAttempt(attempt.id)).status).toBe('Failed');

    // The learner's work survived the failure intact.
    const stored = await app.submissions.findById(submitted.submission.id);
    expect(stored).not.toBeNull();
    expect(stored!.contentHash).toBe(submitted.submission.contentHash);

    // The provider recovers and the learner retries.
    flaky.healthy = true;
    await app.orchestrator.retryEvaluation(failed!.id);
    await app.queue.drain();

    const retried = await app.attemptService.getEvaluation(attempt.id);
    expect(retried!.status).toBe('Completed');
    expect((await app.attemptService.getAttempt(attempt.id)).status).toBe('Completed');
  });

  it('retries transient failures inside the queue without ever telling the learner', async () => {
    let calls = 0;
    class TwiceFlakyClient implements LlmClient {
      readonly id = 'twice-flaky';
      private readonly good = new StubLlmClient();
      async complete(request: LlmRequest): Promise<LlmResponse> {
        calls += 1;
        if (calls <= 2) throw new LlmUnavailableError('transient blip');
        return this.good.complete(request);
      }
    }

    const client = new TwiceFlakyClient();
    const app = makeContainer({
      llmClient: client,
      evaluator: {
        id: 'llm-only',
        supports: () => true,
        evaluate: async (ctx) => {
          const { LlmEvaluator } = await import('../../src/evaluation/LlmEvaluator.js');
          // No repair attempts, so each queue attempt is exactly one call.
          return new LlmEvaluator(client, 0).evaluate(ctx);
        },
      },
      queueOptions: { maxAttempts: 3, baseRetryDelayMs: 0, sleep: async () => {} },
    });

    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    await app.attemptService.submit({ attemptId: attempt.id, content: strongDesign });
    await app.queue.drain();

    const evaluation = await app.attemptService.getEvaluation(attempt.id);
    expect(calls).toBe(3);
    expect(evaluation!.status).toBe('Completed');
  });
});

describe('history and improvement', () => {
  it('numbers repeat attempts and reports the score delta per problem', async () => {
    const app = makeContainer();

    const first = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    await app.attemptService.submit({ attemptId: first.id, content: weakDesign });
    await app.queue.drain();

    const second = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    expect(second.attemptNumber).toBe(2);
    await app.attemptService.submit({ attemptId: second.id, content: strongDesign });
    await app.queue.drain();

    const history = await app.progressService.forLearnerAndProblem(LEARNER, PARKING_LOT);
    expect(history).toHaveLength(2);

    const improved = history.find((h) => h.attempt.attemptNumber === 2)!;
    expect(improved.delta).not.toBeNull();
    expect(improved.delta!).toBeGreaterThan(0);

    // The first attempt has nothing to compare against.
    expect(history.find((h) => h.attempt.attemptNumber === 1)!.delta).toBeNull();
  });

  it('names the weakness that keeps recurring across attempts', async () => {
    const app = makeContainer();

    for (let i = 0; i < 3; i += 1) {
      const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
      await app.attemptService.submit({
        attemptId: attempt.id,
        // Vary the text slightly so each submission hashes differently and is
        // genuinely a new attempt rather than a deduplicated one.
        content: {
          ...weakDesign,
          tradeoffs: `${weakDesign.tradeoffs} Attempt ${i + 1}.`,
        },
      });
      await app.queue.drain();
    }

    const progress = await app.progressService.forLearner(LEARNER);

    expect(progress.completedCount).toBe(3);
    expect(progress.recurringWeaknesses.length).toBeGreaterThan(0);

    const weakness = progress.recurringWeaknesses[0]!;
    expect(weakness.weakCount).toBeGreaterThanOrEqual(2);
    expect(weakness.latestSuggestion.length).toBeGreaterThan(0);
  });

  it('offers the previous submission so a repeat attempt starts pre-filled', async () => {
    const app = makeContainer();

    const first = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    await app.attemptService.submit({ attemptId: first.id, content: strongDesign });
    await app.queue.drain();

    const previous = await app.progressService.lastSubmittedContentFor(LEARNER, PARKING_LOT);

    expect(previous).not.toBeNull();
    expect(previous!.format).toBe('design-spec');
  });

  it('computes deltas per problem, never across different problems', async () => {
    const app = makeContainer();

    const parking = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    await app.attemptService.submit({ attemptId: parking.id, content: strongDesign });
    await app.queue.drain();

    const elevator = await app.attemptService.startAttempt(
      LEARNER,
      asProblemId('elevator-system'),
    );
    await app.attemptService.submit({
      attemptId: elevator.id,
      content: {
        ...weakDesign,
        changeScenarioAnswers: [
          { scenarioId: 'elevator-express' as never, text: 'I would add a class.' },
        ],
      },
    });
    await app.queue.drain();

    const progress = await app.progressService.forLearner(LEARNER);
    const elevatorEntry = progress.history.find(
      (h) => String(h.attempt.problemId) === 'elevator-system',
    )!;

    // First attempt at a different problem: no delta, despite an earlier
    // higher-scoring attempt at the parking lot.
    expect(elevatorEntry.delta).toBeNull();
    expect(progress.perProblem).toHaveLength(2);
  });
});
