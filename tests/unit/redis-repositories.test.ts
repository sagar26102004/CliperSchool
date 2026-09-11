import { describe, expect, it, beforeEach } from 'vitest';
import {
  RedisAttemptRepository,
  RedisEvaluationRepository,
  RedisSubmissionRepository,
  resolveRedisConfig,
  type RedisLike,
} from '../../src/infra/persistence/RedisRepositories.js';
import { Attempt } from '../../src/domain/attempt/Attempt.js';
import { Evaluation } from '../../src/domain/evaluation/Evaluation.js';
import { Submission } from '../../src/domain/submission/Submission.js';
import { makeCriterionResult } from '../../src/domain/evaluation/CriterionResult.js';
import {
  asAttemptId,
  asCriterionId,
  asEvaluationId,
  asLearnerId,
  asProblemId,
  asSubmissionId,
} from '../../src/domain/ids.js';
import { strongDesign } from '../fixtures.js';

/**
 * An in-process stand-in for Upstash.
 *
 * It round-trips values through JSON exactly as the real client does, which is
 * the whole point: the bug this suite is guarding against is a `Date` arriving
 * back as a string and blowing up somewhere far away. A fake that returned the
 * same object reference would have tested nothing.
 */
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

const LEARNER = asLearnerId('learner_1');
const PROBLEM = asProblemId('parking-lot');
const T0 = new Date('2026-03-01T09:00:00.000Z');
const T1 = new Date('2026-03-01T09:05:00.000Z');

let redis: FakeRedis;
beforeEach(() => {
  redis = new FakeRedis();
});

describe('resolveRedisConfig', () => {
  it('accepts the Upstash variable names', () => {
    expect(
      resolveRedisConfig({
        UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'tok',
      } as NodeJS.ProcessEnv),
    ).toEqual({ url: 'https://x.upstash.io', token: 'tok' });
  });

  it('accepts the KV_ names carried over from the retired Vercel KV', () => {
    expect(
      resolveRedisConfig({
        KV_REST_API_URL: 'https://y.upstash.io',
        KV_REST_API_TOKEN: 'tok2',
      } as NodeJS.ProcessEnv),
    ).toEqual({ url: 'https://y.upstash.io', token: 'tok2' });
  });

  it('returns null rather than half a config when only one half is present', () => {
    expect(
      resolveRedisConfig({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(resolveRedisConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('RedisAttemptRepository', () => {
  function anAttempt(id: string, attemptNumber: number): Attempt {
    return new Attempt({
      id: asAttemptId(id),
      learnerId: LEARNER,
      problemId: PROBLEM,
      attemptNumber,
      startedAt: new Date(T0.getTime() + attemptNumber * 1000),
    });
  }

  it('round-trips an attempt through JSON with its dates intact', async () => {
    const repo = new RedisAttemptRepository(redis);
    const attempt = anAttempt('att_1', 1);
    attempt.submit(asSubmissionId('sub_1'), T1);
    await repo.save(attempt);

    const loaded = await repo.findById(asAttemptId('att_1'));

    expect(loaded).not.toBeNull();
    // The real trap: these must be Date instances, not ISO strings.
    expect(loaded!.startedAt).toBeInstanceOf(Date);
    expect(loaded!.submittedAt).toBeInstanceOf(Date);
    expect(loaded!.submittedAt!.toISOString()).toBe(T1.toISOString());
    expect(loaded!.status).toBe('Submitted');
    expect(loaded!.submissionId).toBe('sub_1');
  });

  it('returns a working entity, not just matching data', async () => {
    const repo = new RedisAttemptRepository(redis);
    const attempt = anAttempt('att_1', 1);
    attempt.submit(asSubmissionId('sub_1'), T1);
    await repo.save(attempt);

    const loaded = await repo.findById(asAttemptId('att_1'));
    // A rehydrated Attempt must still enforce its state machine — otherwise
    // persistence would quietly become a way to bypass the domain rules.
    loaded!.beginEvaluation(asEvaluationId('eval_1'));
    expect(loaded!.status).toBe('Evaluating');
    expect(() => loaded!.submit(asSubmissionId('sub_2'), T1)).toThrow();
  });

  it('returns null for an unknown id', async () => {
    const repo = new RedisAttemptRepository(redis);
    expect(await repo.findById(asAttemptId('nope'))).toBeNull();
  });

  it('indexes by learner and orders newest first', async () => {
    const repo = new RedisAttemptRepository(redis);
    await repo.save(anAttempt('att_1', 1));
    await repo.save(anAttempt('att_2', 2));
    await repo.save(anAttempt('att_3', 3));

    const found = await repo.findByLearner(LEARNER);
    expect(found.map((a) => a.attemptNumber)).toEqual([3, 2, 1]);
  });

  it('indexes by learner and problem, ordered by attempt number', async () => {
    const repo = new RedisAttemptRepository(redis);
    await repo.save(anAttempt('att_2', 2));
    await repo.save(anAttempt('att_1', 1));

    const found = await repo.findByLearnerAndProblem(LEARNER, PROBLEM);
    expect(found.map((a) => a.attemptNumber)).toEqual([1, 2]);
    expect(await repo.countByLearnerAndProblem(LEARNER, PROBLEM)).toBe(2);
  });

  it('does not duplicate index entries when an attempt is saved repeatedly', async () => {
    const repo = new RedisAttemptRepository(redis);
    const attempt = anAttempt('att_1', 1);

    // Every state transition saves again — the index must stay a set.
    await repo.save(attempt);
    attempt.submit(asSubmissionId('sub_1'), T1);
    await repo.save(attempt);
    attempt.beginEvaluation(asEvaluationId('eval_1'));
    await repo.save(attempt);

    expect(await repo.countByLearnerAndProblem(LEARNER, PROBLEM)).toBe(1);
    expect((await repo.findByLearner(LEARNER))[0]!.status).toBe('Evaluating');
  });

  it('keeps different learners isolated', async () => {
    const repo = new RedisAttemptRepository(redis);
    await repo.save(anAttempt('att_1', 1));
    await repo.save(
      new Attempt({
        id: asAttemptId('att_other'),
        learnerId: asLearnerId('learner_2'),
        problemId: PROBLEM,
        attemptNumber: 1,
        startedAt: T0,
      }),
    );

    expect(await repo.findByLearner(LEARNER)).toHaveLength(1);
    expect(await repo.findByLearner(asLearnerId('learner_2'))).toHaveLength(1);
  });
});

describe('RedisSubmissionRepository', () => {
  function aSubmission(id: string, attemptId: string): Submission {
    return new Submission({
      id: asSubmissionId(id),
      attemptId: asAttemptId(attemptId),
      content: strongDesign,
      submittedAt: T1,
    });
  }

  it('round-trips content and recomputes an identical hash', async () => {
    const repo = new RedisSubmissionRepository(redis);
    const submission = aSubmission('sub_1', 'att_1');
    await repo.save(submission);

    const loaded = await repo.findById(asSubmissionId('sub_1'));

    expect(loaded!.submittedAt).toBeInstanceOf(Date);
    expect(loaded!.content.format).toBe('design-spec');
    // The hash is derived, not stored. If the JSON round trip altered the
    // content in any way, idempotency would break silently — this catches it.
    expect(loaded!.contentHash).toBe(submission.contentHash);
  });

  it('finds a submission by its attempt', async () => {
    const repo = new RedisSubmissionRepository(redis);
    await repo.save(aSubmission('sub_1', 'att_1'));

    const found = await repo.findByAttemptId(asAttemptId('att_1'));
    expect(found!.id).toBe('sub_1');
  });

  it('supports the idempotency lookup by content hash', async () => {
    const repo = new RedisSubmissionRepository(redis);
    const submission = aSubmission('sub_1', 'att_1');
    await repo.save(submission);

    const found = await repo.findByAttemptAndHash(
      asAttemptId('att_1'),
      submission.contentHash,
    );
    expect(found!.id).toBe('sub_1');

    expect(
      await repo.findByAttemptAndHash(asAttemptId('att_1'), 'a-different-hash'),
    ).toBeNull();
    // The hash index must be scoped per attempt, or attempt 2 would be
    // deduplicated against attempt 1 and never get its own evaluation.
    expect(
      await repo.findByAttemptAndHash(asAttemptId('att_2'), submission.contentHash),
    ).toBeNull();
  });
});

describe('RedisEvaluationRepository', () => {
  function anEvaluation(id: string, submissionId: string): Evaluation {
    return new Evaluation({
      id: asEvaluationId(id),
      submissionId: asSubmissionId(submissionId),
      rubricVersionTag: 'lld-core-v1',
      queuedAt: T0,
    });
  }

  it('round-trips a completed evaluation including its criterion results', async () => {
    const repo = new RedisEvaluationRepository(redis);
    const evaluation = anEvaluation('eval_1', 'sub_1');
    evaluation.start(T0);
    evaluation.complete({
      results: [
        makeCriterionResult({
          criterionId: asCriterionId('class-responsibilities'),
          score: 3.5,
          maxScore: 5,
          evidence: ['ParkingLot: Admits and releases vehicles'],
          concern: 'Some behaviour is implied.',
          suggestion: 'State it.',
          confidence: 0.7,
          source: 'llm',
        }),
      ],
      summary: 'A workable design.',
      at: T1,
      partial: true,
      degradedReasons: ['llm-v1 could not contribute'],
    });
    await repo.save(evaluation);

    const loaded = await repo.findById(asEvaluationId('eval_1'));

    expect(loaded!.status).toBe('Completed');
    expect(loaded!.queuedAt).toBeInstanceOf(Date);
    expect(loaded!.completedAt).toBeInstanceOf(Date);
    expect(loaded!.durationMs).toBe(T1.getTime() - T0.getTime());
    expect(loaded!.partial).toBe(true);
    expect(loaded!.degradedReasons).toEqual(['llm-v1 could not contribute']);
    expect(loaded!.attemptsMade).toBe(1);

    const result = loaded!.results[0]!;
    expect(result.score).toBe(3.5);
    expect(result.evidence[0]).toContain('ParkingLot');
    expect(result.source).toBe('llm');
  });

  it('round-trips a failed evaluation with its reason', async () => {
    const repo = new RedisEvaluationRepository(redis);
    const evaluation = anEvaluation('eval_2', 'sub_2');
    evaluation.start(T0);
    evaluation.fail('provider down', T1);
    await repo.save(evaluation);

    const loaded = await repo.findById(asEvaluationId('eval_2'));
    expect(loaded!.status).toBe('Failed');
    expect(loaded!.failureReason).toBe('provider down');
    // A rehydrated failed evaluation must still be retryable.
    loaded!.start(T1);
    expect(loaded!.status).toBe('Running');
    expect(loaded!.attemptsMade).toBe(2);
  });

  it('finds an evaluation by submission, and handles batches', async () => {
    const repo = new RedisEvaluationRepository(redis);
    await repo.save(anEvaluation('eval_1', 'sub_1'));
    await repo.save(anEvaluation('eval_2', 'sub_2'));

    expect((await repo.findBySubmissionId(asSubmissionId('sub_2')))!.id).toBe('eval_2');
    expect(await repo.findBySubmissionId(asSubmissionId('sub_missing'))).toBeNull();

    const batch = await repo.findBySubmissionIds([
      asSubmissionId('sub_1'),
      asSubmissionId('sub_missing'),
      asSubmissionId('sub_2'),
    ]);
    expect(batch.map((e) => e.id).sort()).toEqual(['eval_1', 'eval_2']);
    expect(await repo.findBySubmissionIds([])).toEqual([]);
  });
});
