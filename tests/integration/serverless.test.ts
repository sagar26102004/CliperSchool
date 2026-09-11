import { describe, expect, it } from 'vitest';
import { buildContainer, type Container } from '../../src/container.js';
import { ServerlessJobQueue } from '../../src/application/JobQueue.js';
import {
  RedisAttemptRepository,
  RedisEvaluationRepository,
  RedisSubmissionRepository,
  type RedisLike,
} from '../../src/infra/persistence/RedisRepositories.js';
import { asLearnerId, asProblemId } from '../../src/domain/ids.js';
import { FixedClock, SequentialIdGenerator } from '../../src/infra/clock.js';
import { StubLlmClient } from '../../src/infra/llm/StubLlmClient.js';
import { LlmUnavailableError } from '../../src/infra/llm/LlmClient.js';
import { CORE_RUBRIC } from '../../src/seed/rubric.js';
import { strongDesign } from '../fixtures.js';

const LEARNER = asLearnerId('learner_1');
const PARKING_LOT = asProblemId('parking-lot');

class FakeRedis implements RedisLike {
  private store = new Map<string, string>();
  private sets = new Map<string, Set<string>>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown): Promise<unknown> {
    this.store.set(key, JSON.stringify(value));
    return 'OK';
  }
  async sadd(key: string, ...members: string[]): Promise<unknown> {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const m of members) set.add(m);
    this.sets.set(key, set);
    return members.length;
  }
  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }
}

/**
 * Builds the app the way it runs on Vercel: Redis-backed storage and a queue
 * that hands work to the platform instead of relying on the process staying
 * alive.
 */
function makeServerlessContainer(options: { clock?: FixedClock } = {}): {
  app: Container;
  scheduled: Promise<unknown>[];
} {
  const redis = new FakeRedis();
  const scheduled: Promise<unknown>[] = [];
  const clock = options.clock ?? new FixedClock();

  const app = buildContainer({
    clock,
    ids: new SequentialIdGenerator(),
    llmClient: new StubLlmClient(),
    storage: {
      attempts: new RedisAttemptRepository(redis),
      submissions: new RedisSubmissionRepository(redis),
      evaluations: new RedisEvaluationRepository(redis),
      storageId: 'redis',
    },
    queue: (onFailure) =>
      new ServerlessJobQueue({
        // Stands in for waitUntil: records what the platform was asked to keep
        // alive, so the test can assert the work was actually handed over.
        scheduler: (work) => scheduled.push(work),
        onFailure,
      }),
  });

  return { app, scheduled };
}

describe('running on a serverless host', () => {
  it('completes the whole practice loop with Redis-backed storage', async () => {
    const { app } = makeServerlessContainer();

    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    const submitted = await app.attemptService.submit({
      attemptId: attempt.id,
      content: strongDesign,
    });
    await app.queue.drain();

    const evaluation = await app.attemptService.getEvaluation(attempt.id);
    expect(evaluation!.status).toBe('Completed');
    expect(evaluation!.overallScore(CORE_RUBRIC)).toBeGreaterThan(0);

    // The submission survived a full JSON round trip through the store.
    const stored = await app.submissions.findById(submitted.submission.id);
    expect(stored!.contentHash).toBe(submitted.submission.contentHash);

    const history = await app.progressService.forLearnerAndProblem(LEARNER, PARKING_LOT);
    expect(history).toHaveLength(1);
    expect(history[0]!.score).toBeGreaterThan(0);
  });

  it('hands background work to the platform instead of assuming the process survives', async () => {
    const { app, scheduled } = makeServerlessContainer();

    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    await app.attemptService.submit({ attemptId: attempt.id, content: strongDesign });

    // This is the property that makes the deployment work: the evaluation was
    // registered with the platform before the request finished, so the function
    // is kept alive rather than frozen the moment the redirect is flushed.
    expect(scheduled.length).toBe(1);

    await app.queue.drain();
    expect((await app.attemptService.getEvaluation(attempt.id))!.status).toBe('Completed');
  });

  it('still deduplicates a repeated submit across instances', async () => {
    const { app } = makeServerlessContainer();

    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    const first = await app.attemptService.submit({
      attemptId: attempt.id,
      content: strongDesign,
    });
    const second = await app.attemptService.submit({
      attemptId: attempt.id,
      content: strongDesign,
    });

    expect(second.deduplicated).toBe(true);
    expect(second.evaluation.id).toBe(first.evaluation.id);
    await app.queue.drain();
  });

  it('reports a failure through the platform queue rather than hanging', async () => {
    const { app } = makeServerlessContainer();
    const failing = buildContainerWithFailingEvaluator(app);

    const attempt = await failing.attemptService.startAttempt(LEARNER, PARKING_LOT);
    await failing.attemptService.submit({ attemptId: attempt.id, content: strongDesign });
    await failing.queue.drain();

    const evaluation = await failing.attemptService.getEvaluation(attempt.id);
    expect(evaluation!.status).toBe('Failed');
    expect(evaluation!.failureReason).toContain('provider down');
  });
});

/** Same wiring, but every evaluation attempt throws. */
function buildContainerWithFailingEvaluator(_reference: Container): Container {
  const redis = new FakeRedis();
  return buildContainer({
    clock: new FixedClock(),
    ids: new SequentialIdGenerator(),
    storage: {
      attempts: new RedisAttemptRepository(redis),
      submissions: new RedisSubmissionRepository(redis),
      evaluations: new RedisEvaluationRepository(redis),
      storageId: 'redis',
    },
    evaluator: {
      id: 'always-fails',
      supports: () => true,
      evaluate: async () => {
        throw new LlmUnavailableError('provider down');
      },
    },
    queue: (onFailure) => new ServerlessJobQueue({ scheduler: () => {}, onFailure }),
  });
}

describe('recovering an evaluation the platform killed mid-run', () => {
  /**
   * Simulates the specific serverless failure this recovery exists for: the
   * function is stopped after the evaluation is marked Running but before it
   * can complete, leaving a row that nothing alive will ever finish.
   */
  async function stallAnEvaluation() {
    const clock = new FixedClock();
    const redis = new FakeRedis();
    const evaluations = new RedisEvaluationRepository(redis);

    const app = buildContainer({
      clock,
      ids: new SequentialIdGenerator(),
      storage: {
        attempts: new RedisAttemptRepository(redis),
        submissions: new RedisSubmissionRepository(redis),
        evaluations,
        storageId: 'redis',
      },
      llmClient: new StubLlmClient(),
      // A queue that accepts jobs and never runs them: the work is handed over
      // and then the instance disappears.
      queue: () => ({
        enqueue: () => {},
        drain: async () => {},
        pending: 0,
      }),
    });

    const attempt = await app.attemptService.startAttempt(LEARNER, PARKING_LOT);
    const submitted = await app.attemptService.submit({
      attemptId: attempt.id,
      content: strongDesign,
    });

    // Move it to Running, then abandon it.
    const evaluation = (await evaluations.findById(submitted.evaluation.id))!;
    evaluation.start(clock.now());
    await evaluations.save(evaluation);

    return { app, clock, evaluations, evaluationId: submitted.evaluation.id };
  }

  it('leaves a recently started evaluation alone', async () => {
    const { app, clock, evaluationId } = await stallAnEvaluation();

    clock.advance(5_000);
    expect(await app.orchestrator.recoverIfStalled(evaluationId)).toBe(false);
  });

  it('re-queues an evaluation that has been Running implausibly long', async () => {
    const { app, clock, evaluationId } = await stallAnEvaluation();

    clock.advance(300_000);
    expect(await app.orchestrator.recoverIfStalled(evaluationId)).toBe(true);
  });

  it('gives up and fails cleanly rather than looping forever', async () => {
    const { app, clock, evaluations, evaluationId } = await stallAnEvaluation();

    // Three runs have already been cut off; a fourth is not going to help.
    const evaluation = (await evaluations.findById(evaluationId))!;
    evaluation.start(clock.now());
    evaluation.start(clock.now());
    await evaluations.save(evaluation);

    clock.advance(300_000);
    expect(await app.orchestrator.recoverIfStalled(evaluationId)).toBe(false);

    const failed = await evaluations.findById(evaluationId);
    expect(failed!.status).toBe('Failed');
    expect(failed!.failureReason).toContain('interrupted repeatedly');
    // The learner is told their work is safe, because it is.
    expect(failed!.failureReason).toContain('submission is safe');
  });

  it('does nothing to an evaluation that already completed', async () => {
    const { app, clock, evaluations, evaluationId } = await stallAnEvaluation();

    const evaluation = (await evaluations.findById(evaluationId))!;
    evaluation.complete({ results: [], summary: 'done', at: clock.now() });
    await evaluations.save(evaluation);

    clock.advance(300_000);
    expect(await app.orchestrator.recoverIfStalled(evaluationId)).toBe(false);
    expect((await evaluations.findById(evaluationId))!.status).toBe('Completed');
  });
});
