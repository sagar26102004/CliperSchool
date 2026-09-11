import { Redis } from '@upstash/redis';
import { Attempt, type AttemptRepository } from '../../domain/attempt/Attempt.js';
import { Evaluation, type EvaluationRepository } from '../../domain/evaluation/Evaluation.js';
import { Submission, type SubmissionRepository } from '../../domain/submission/Submission.js';
import type { CriterionResult } from '../../domain/evaluation/CriterionResult.js';
import type { SubmissionContent } from '../../domain/submission/SubmissionContent.js';
import type {
  AttemptId,
  EvaluationId,
  LearnerId,
  ProblemId,
  SubmissionId,
} from '../../domain/ids.js';

/**
 * Redis-backed persistence, for serverless deployment.
 *
 * This exists because Vercel runs each request in a potentially different
 * instance, so the in-memory repositories — fine for a single long-lived local
 * process — would lose a learner's submission between the POST that creates it
 * and the GET that renders the feedback.
 *
 * Note what did *not* have to change to support this: not one domain type, not
 * a service, not a route. The repository interfaces live in `src/domain`, so a
 * new storage backend is a new file plus a branch in the composition root. That
 * is the claim the design note makes about persistence being swappable, and
 * this file is it being cashed in rather than asserted.
 *
 * The Upstash REST client is used deliberately over a TCP Redis client: HTTP
 * has no connection to pool, which is exactly what a serverless function that
 * may be frozen between invocations needs.
 *
 * Problems and rubrics stay in memory — they are immutable seed data shipped
 * with the build, so storing them would add a round trip and buy nothing.
 */

const KEY = {
  attempt: (id: string) => `att:${id}`,
  attemptsByLearner: (learnerId: string) => `att:by-learner:${learnerId}`,
  attemptsByLearnerProblem: (learnerId: string, problemId: string) =>
    `att:by-learner-problem:${learnerId}:${problemId}`,
  submission: (id: string) => `sub:${id}`,
  submissionByAttempt: (attemptId: string) => `sub:by-attempt:${attemptId}`,
  submissionByHash: (attemptId: string, hash: string) => `sub:by-hash:${attemptId}:${hash}`,
  evaluation: (id: string) => `eval:${id}`,
  evaluationBySubmission: (submissionId: string) => `eval:by-submission:${submissionId}`,
} as const;

/**
 * Resolves Upstash credentials from the environment.
 *
 * Two naming schemes are accepted because Vercel's Marketplace integration and
 * Upstash's own integration have historically injected different variable
 * names, and projects migrated from the retired Vercel KV carry the `KV_`
 * prefix. Guessing one and failing silently at runtime would be the worst
 * outcome, so an unresolvable config throws immediately and names every
 * variable it looked for.
 */
export function resolveRedisConfig(
  env: NodeJS.ProcessEnv = process.env,
): { url: string; token: string } | null {
  const pairs: readonly (readonly [string, string])[] = [
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['REDIS_REST_URL', 'REDIS_REST_TOKEN'],
  ];

  for (const [urlKey, tokenKey] of pairs) {
    const url = env[urlKey];
    const token = env[tokenKey];
    if (url && token) return { url, token };
  }
  return null;
}

export function createRedisClient(env: NodeJS.ProcessEnv = process.env): Redis {
  const config = resolveRedisConfig(env);
  if (!config) {
    throw new Error(
      'Redis storage was requested but no credentials were found. Expected one of these ' +
        'pairs in the environment: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, ' +
        'KV_REST_API_URL + KV_REST_API_TOKEN, or REDIS_REST_URL + REDIS_REST_TOKEN. ' +
        'Creating a Redis store from the Vercel Marketplace injects these automatically; ' +
        'run `vercel env pull .env.local` to use them locally.',
    );
  }
  return new Redis(config);
}

/**
 * The narrow slice of Redis this module uses.
 *
 * Declared as an interface rather than depending on the concrete client so the
 * repositories can be tested against an in-process fake — otherwise the
 * serialisation round trip, which is where storage bugs actually live, would be
 * untested code that only ever runs in production.
 */
export interface RedisLike {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Serialisation
//
// Dates do not survive a JSON round trip, so every entity has an explicit DTO
// and an explicit revival step. Doing this by hand rather than with a reviver
// keeps it obvious which fields are temporal, and means a new field cannot be
// silently dropped — TypeScript fails the build instead.
// ---------------------------------------------------------------------------

interface AttemptDto {
  id: string;
  learnerId: string;
  problemId: string;
  attemptNumber: number;
  startedAt: string;
  status: Attempt['status'];
  submissionId: string | null;
  evaluationId: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
}

function toAttemptDto(attempt: Attempt): AttemptDto {
  return {
    id: attempt.id,
    learnerId: attempt.learnerId,
    problemId: attempt.problemId,
    attemptNumber: attempt.attemptNumber,
    startedAt: attempt.startedAt.toISOString(),
    status: attempt.status,
    submissionId: attempt.submissionId,
    evaluationId: attempt.evaluationId,
    submittedAt: attempt.submittedAt?.toISOString() ?? null,
    completedAt: attempt.completedAt?.toISOString() ?? null,
    failureReason: attempt.failureReason,
  };
}

function fromAttemptDto(dto: AttemptDto): Attempt {
  return new Attempt({
    id: dto.id as AttemptId,
    learnerId: dto.learnerId as LearnerId,
    problemId: dto.problemId as ProblemId,
    attemptNumber: dto.attemptNumber,
    startedAt: new Date(dto.startedAt),
    status: dto.status,
    submissionId: (dto.submissionId as SubmissionId | null) ?? null,
    evaluationId: (dto.evaluationId as EvaluationId | null) ?? null,
    submittedAt: dto.submittedAt ? new Date(dto.submittedAt) : null,
    completedAt: dto.completedAt ? new Date(dto.completedAt) : null,
    failureReason: dto.failureReason,
  });
}

interface SubmissionDto {
  id: string;
  attemptId: string;
  content: SubmissionContent;
  submittedAt: string;
}

interface EvaluationDto {
  id: string;
  submissionId: string;
  rubricVersionTag: string;
  queuedAt: string;
  status: Evaluation['status'];
  results: CriterionResult[];
  summary: string;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  partial: boolean;
  degradedReasons: string[];
  attemptsMade: number;
}

function toEvaluationDto(evaluation: Evaluation): EvaluationDto {
  return {
    id: evaluation.id,
    submissionId: evaluation.submissionId,
    rubricVersionTag: evaluation.rubricVersionTag,
    queuedAt: evaluation.queuedAt.toISOString(),
    status: evaluation.status,
    results: [...evaluation.results],
    summary: evaluation.summary,
    startedAt: evaluation.startedAt?.toISOString() ?? null,
    completedAt: evaluation.completedAt?.toISOString() ?? null,
    failureReason: evaluation.failureReason,
    partial: evaluation.partial,
    degradedReasons: [...evaluation.degradedReasons],
    attemptsMade: evaluation.attemptsMade,
  };
}

function fromEvaluationDto(dto: EvaluationDto): Evaluation {
  return new Evaluation({
    id: dto.id as EvaluationId,
    submissionId: dto.submissionId as SubmissionId,
    rubricVersionTag: dto.rubricVersionTag,
    queuedAt: new Date(dto.queuedAt),
    status: dto.status,
    results: dto.results,
    summary: dto.summary,
    startedAt: dto.startedAt ? new Date(dto.startedAt) : null,
    completedAt: dto.completedAt ? new Date(dto.completedAt) : null,
    failureReason: dto.failureReason,
    partial: dto.partial,
    degradedReasons: dto.degradedReasons,
    attemptsMade: dto.attemptsMade,
  });
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export class RedisAttemptRepository implements AttemptRepository {
  constructor(private readonly redis: RedisLike) {}

  async save(attempt: Attempt): Promise<void> {
    await this.redis.set(KEY.attempt(attempt.id), toAttemptDto(attempt));
    // Index sets are written on every save rather than only on create. `sadd`
    // is idempotent, and this keeps a repeat save self-healing if an earlier
    // invocation was killed between writing the entity and its index — a real
    // possibility on a platform that can stop a function mid-flight.
    await this.redis.sadd(KEY.attemptsByLearner(attempt.learnerId), attempt.id);
    await this.redis.sadd(
      KEY.attemptsByLearnerProblem(attempt.learnerId, attempt.problemId),
      attempt.id,
    );
  }

  async findById(id: AttemptId): Promise<Attempt | null> {
    const dto = await this.redis.get<AttemptDto>(KEY.attempt(id));
    return dto ? fromAttemptDto(dto) : null;
  }

  async findByLearner(learnerId: LearnerId): Promise<readonly Attempt[]> {
    const ids = await this.redis.smembers(KEY.attemptsByLearner(learnerId));
    const attempts = await this.loadMany(ids);
    return attempts.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  async findByLearnerAndProblem(
    learnerId: LearnerId,
    problemId: ProblemId,
  ): Promise<readonly Attempt[]> {
    const ids = await this.redis.smembers(KEY.attemptsByLearnerProblem(learnerId, problemId));
    const attempts = await this.loadMany(ids);
    return attempts.sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  async countByLearnerAndProblem(
    learnerId: LearnerId,
    problemId: ProblemId,
  ): Promise<number> {
    const ids = await this.redis.smembers(KEY.attemptsByLearnerProblem(learnerId, problemId));
    return ids.length;
  }

  private async loadMany(ids: readonly string[]): Promise<Attempt[]> {
    if (ids.length === 0) return [];
    const dtos = await Promise.all(
      ids.map((id) => this.redis.get<AttemptDto>(KEY.attempt(id))),
    );
    return dtos.filter((d): d is AttemptDto => d !== null).map(fromAttemptDto);
  }
}

export class RedisSubmissionRepository implements SubmissionRepository {
  constructor(private readonly redis: RedisLike) {}

  async save(submission: Submission): Promise<void> {
    const dto: SubmissionDto = {
      id: submission.id,
      attemptId: submission.attemptId,
      content: submission.content,
      submittedAt: submission.submittedAt.toISOString(),
    };
    await this.redis.set(KEY.submission(submission.id), dto);
    await this.redis.set(KEY.submissionByAttempt(submission.attemptId), submission.id);
    // The idempotency index. Written alongside the submission so a retried
    // request finds the original rather than paying for a second evaluation.
    await this.redis.set(
      KEY.submissionByHash(submission.attemptId, submission.contentHash),
      submission.id,
    );
  }

  async findById(id: SubmissionId): Promise<Submission | null> {
    const dto = await this.redis.get<SubmissionDto>(KEY.submission(id));
    if (!dto) return null;
    return new Submission({
      id: dto.id as SubmissionId,
      attemptId: dto.attemptId as AttemptId,
      content: dto.content,
      submittedAt: new Date(dto.submittedAt),
    });
  }

  async findByAttemptId(attemptId: AttemptId): Promise<Submission | null> {
    const id = await this.redis.get<string>(KEY.submissionByAttempt(attemptId));
    return id ? this.findById(id as SubmissionId) : null;
  }

  async findByAttemptAndHash(
    attemptId: AttemptId,
    contentHash: string,
  ): Promise<Submission | null> {
    const id = await this.redis.get<string>(KEY.submissionByHash(attemptId, contentHash));
    return id ? this.findById(id as SubmissionId) : null;
  }
}

export class RedisEvaluationRepository implements EvaluationRepository {
  constructor(private readonly redis: RedisLike) {}

  async save(evaluation: Evaluation): Promise<void> {
    await this.redis.set(KEY.evaluation(evaluation.id), toEvaluationDto(evaluation));
    await this.redis.set(
      KEY.evaluationBySubmission(evaluation.submissionId),
      evaluation.id,
    );
  }

  async findById(id: EvaluationId): Promise<Evaluation | null> {
    const dto = await this.redis.get<EvaluationDto>(KEY.evaluation(id));
    return dto ? fromEvaluationDto(dto) : null;
  }

  async findBySubmissionId(submissionId: SubmissionId): Promise<Evaluation | null> {
    const id = await this.redis.get<string>(KEY.evaluationBySubmission(submissionId));
    return id ? this.findById(id as EvaluationId) : null;
  }

  async findBySubmissionIds(ids: readonly SubmissionId[]): Promise<readonly Evaluation[]> {
    if (ids.length === 0) return [];
    const evaluations = await Promise.all(ids.map((id) => this.findBySubmissionId(id)));
    return evaluations.filter((e): e is Evaluation => e !== null);
  }
}
