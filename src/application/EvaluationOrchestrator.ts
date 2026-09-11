import { NotFoundError } from '../domain/errors.js';
import type { EvaluationId, SubmissionId } from '../domain/ids.js';
import { Evaluation, type EvaluationRepository } from '../domain/evaluation/Evaluation.js';
import type { AttemptRepository } from '../domain/attempt/Attempt.js';
import type { ProblemRepository } from '../domain/problem/Problem.js';
import type { RubricRepository } from '../domain/rubric/Rubric.js';
import type { SubmissionRepository } from '../domain/submission/Submission.js';
import type { AdapterRegistry } from '../domain/submission/DesignGraph.js';
import type { Clock, IdGenerator } from '../infra/clock.js';
import type { Evaluator } from '../evaluation/Evaluator.js';
import type { JobQueue } from './JobQueue.js';

/**
 * Owns the lifecycle of an evaluation: queue it, run it, record what happened.
 *
 * This is the only place that knows how a submission becomes a score, and it
 * knows almost nothing about *how* the scoring is done — it holds a single
 * `Evaluator` and calls it. That is what makes the second change test from the
 * brief (add a rule-based evaluator or human review without rewriting the
 * practice flow) true: swapping the injected evaluator for a differently
 * composed one changes nothing in this file.
 *
 * The ordering below is the important part, and it is deliberate:
 *
 *   1. the Submission is already persisted before we are called;
 *   2. an Evaluation row is written in `Queued` *before* any work starts;
 *   3. only then is a job enqueued.
 *
 * So there is no window in which a learner has submitted but the system has no
 * record of it, and a process that dies mid-run leaves a `Running` row that is
 * visibly stuck rather than an attempt that silently vanished.
 */
export class EvaluationOrchestrator {
  constructor(
    private readonly deps: {
      evaluations: EvaluationRepository;
      submissions: SubmissionRepository;
      attempts: AttemptRepository;
      problems: ProblemRepository;
      rubrics: RubricRepository;
      adapters: AdapterRegistry;
      evaluator: Evaluator;
      queue: JobQueue;
      clock: Clock;
      ids: IdGenerator;
    },
  ) {}

  /**
   * Creates the Evaluation record and schedules the work.
   *
   * Returns as soon as the record is durable — the caller (a web request) never
   * waits on the model. The UI polls for the status transition instead.
   */
  async scheduleEvaluation(submissionId: SubmissionId): Promise<Evaluation> {
    const submission = await this.deps.submissions.findById(submissionId);
    if (!submission) throw new NotFoundError('Submission', submissionId);

    const attempt = await this.deps.attempts.findById(submission.attemptId);
    if (!attempt) throw new NotFoundError('Attempt', submission.attemptId);

    const problem = await this.deps.problems.findById(attempt.problemId);
    if (!problem) throw new NotFoundError('Problem', attempt.problemId);

    const rubric = await this.deps.rubrics.findById(problem.rubricId);
    if (!rubric) throw new NotFoundError('Rubric', problem.rubricId);

    const evaluation = new Evaluation({
      id: this.deps.ids.next('eval') as EvaluationId,
      submissionId: submission.id,
      rubricVersionTag: rubric.versionTag,
      queuedAt: this.deps.clock.now(),
    });
    await this.deps.evaluations.save(evaluation);

    attempt.beginEvaluation(evaluation.id);
    await this.deps.attempts.save(attempt);

    this.deps.queue.enqueue({
      id: `evaluate:${evaluation.id}`,
      run: (signal) => this.runEvaluation(evaluation.id, signal),
    });

    return evaluation;
  }

  /**
   * Re-runs a failed evaluation.
   *
   * Exposed as an explicit learner action rather than an automatic retry loop.
   * The queue already retries transient failures; if it exhausted those, the
   * honest thing is to tell the learner and let them decide, not to keep
   * spending calls on a provider that is down.
   */
  async retryEvaluation(evaluationId: EvaluationId): Promise<Evaluation> {
    const evaluation = await this.deps.evaluations.findById(evaluationId);
    if (!evaluation) throw new NotFoundError('Evaluation', evaluationId);

    const submission = await this.deps.submissions.findById(evaluation.submissionId);
    if (!submission) throw new NotFoundError('Submission', evaluation.submissionId);

    const attempt = await this.deps.attempts.findById(submission.attemptId);
    if (attempt && attempt.status === 'Failed') {
      attempt.beginEvaluation(evaluation.id);
      await this.deps.attempts.save(attempt);
    }

    this.deps.queue.enqueue({
      id: `evaluate:${evaluation.id}:retry`,
      run: (signal) => this.runEvaluation(evaluation.id, signal),
    });

    return evaluation;
  }

  /**
   * Re-queues an evaluation that has been `Running` implausibly long.
   *
   * In a single long-lived process this would be near-impossible. On a
   * serverless host it is routine: the platform can stop a function the moment
   * its time budget expires, leaving an evaluation permanently `Running` with
   * nothing left alive to finish it. Without this, the learner watches a
   * spinner forever — the exact outcome the whole failure design exists to
   * prevent.
   *
   * Called from the read paths (the status poll and the attempt page), so
   * recovery happens naturally while a learner is waiting rather than needing a
   * scheduler. Safe to call repeatedly: `runEvaluation` returns immediately if
   * the evaluation has since completed.
   *
   * Returns true when a recovery was triggered.
   */
  async recoverIfStalled(evaluationId: EvaluationId, staleAfterMs = STALE_AFTER_MS): Promise<boolean> {
    const evaluation = await this.deps.evaluations.findById(evaluationId);
    if (!evaluation || evaluation.status !== 'Running') return false;

    const startedAt = evaluation.startedAt;
    if (!startedAt) return false;
    if (this.deps.clock.now().getTime() - startedAt.getTime() < staleAfterMs) return false;

    // Give up rather than loop forever if repeated runs keep being cut off.
    if (evaluation.attemptsMade >= 3) {
      await this.markFailed(
        evaluationId,
        new Error(
          'Evaluation was interrupted repeatedly before it could finish. Your submission is safe — try again.',
        ),
      );
      return false;
    }

    this.deps.queue.enqueue({
      id: `evaluate:${evaluation.id}:recover`,
      run: (signal) => this.runEvaluation(evaluation.id, signal),
    });
    return true;
  }

  /**
   * The unit of work the queue executes.
   *
   * Throwing from here is meaningful: it tells the queue to retry. Only after
   * the queue gives up does `markFailed` run, so a single flaky model call does
   * not surface to the learner as a failure at all.
   */
  private async runEvaluation(evaluationId: EvaluationId, signal: AbortSignal): Promise<void> {
    const evaluation = await this.deps.evaluations.findById(evaluationId);
    if (!evaluation) throw new NotFoundError('Evaluation', evaluationId);

    // Already finished — a duplicate job, or a retry that raced a success.
    // Returning quietly keeps the operation idempotent at the job level.
    if (evaluation.status === 'Completed') return;

    const submission = await this.deps.submissions.findById(evaluation.submissionId);
    if (!submission) throw new NotFoundError('Submission', evaluation.submissionId);

    const attempt = await this.deps.attempts.findById(submission.attemptId);
    if (!attempt) throw new NotFoundError('Attempt', submission.attemptId);

    const problem = await this.deps.problems.findById(attempt.problemId);
    if (!problem) throw new NotFoundError('Problem', attempt.problemId);

    const rubric = await this.deps.rubrics.findByVersionTag(evaluation.rubricVersionTag);
    if (!rubric) throw new NotFoundError('Rubric', evaluation.rubricVersionTag);

    evaluation.start(this.deps.clock.now());
    await this.deps.evaluations.save(evaluation);

    const outcome = await this.deps.evaluator.evaluate({
      submission,
      graph: this.deps.adapters.toGraph(submission.content),
      problem,
      rubric,
      signal,
    });

    const scoredCriterionIds = new Set(outcome.results.map((r) => String(r.criterionId)));
    const unscored = rubric.criteria.filter((c) => !scoredCriterionIds.has(String(c.id)));
    const degradedReasons = [
      ...(outcome.degradedReason ? [outcome.degradedReason] : []),
      ...(unscored.length > 0
        ? [`Not scored this run: ${unscored.map((c) => c.name).join(', ')}.`]
        : []),
    ];

    evaluation.complete({
      results: outcome.results,
      summary: outcome.summary ?? composeFallbackSummary(outcome.results.length),
      at: this.deps.clock.now(),
      partial: degradedReasons.length > 0,
      degradedReasons,
    });
    await this.deps.evaluations.save(evaluation);

    attempt.complete(evaluation.id, this.deps.clock.now());
    await this.deps.attempts.save(attempt);
  }

  /**
   * Terminal failure handling, wired to the queue's onFailure callback.
   *
   * Both the Evaluation and the Attempt are moved to `Failed` with the reason
   * attached, because a learner staring at a spinner that never resolves is the
   * worst possible outcome — worse than being told the evaluator broke.
   */
  async markFailed(evaluationId: EvaluationId, error: unknown): Promise<void> {
    const evaluation = await this.deps.evaluations.findById(evaluationId);
    if (!evaluation || evaluation.status === 'Completed') return;

    const reason = error instanceof Error ? error.message : String(error);
    const now = this.deps.clock.now();

    evaluation.fail(reason, now);
    await this.deps.evaluations.save(evaluation);

    const submission = await this.deps.submissions.findById(evaluation.submissionId);
    if (!submission) return;
    const attempt = await this.deps.attempts.findById(submission.attemptId);
    if (!attempt || attempt.isTerminal) return;

    attempt.fail(reason, now);
    await this.deps.attempts.save(attempt);
  }
}

function composeFallbackSummary(resultCount: number): string {
  return resultCount > 0
    ? 'Structural checks completed. Review each criterion below for the specific evidence and suggestion.'
    : 'No criteria could be scored for this submission.';
}

/** Recovers the evaluation id from the queue job id the orchestrator created. */
/**
 * How long `Running` must persist before an evaluation is presumed abandoned.
 *
 * This has to exceed the longest a job can legitimately still be working, or
 * recovery races the very job it is trying to rescue and pays for the same
 * evaluation twice. The serverless queue allows two attempts at the 90s job
 * timeout, so anything under 180s would re-queue live work; 240s leaves margin
 * without making a genuinely frozen evaluation feel abandoned — and the learner
 * is looking at an honest "Evaluating" state the whole time, not a blank page.
 */
const STALE_AFTER_MS = 240_000;

export function evaluationIdFromJobId(jobId: string): EvaluationId | null {
  const parts = jobId.split(':');
  return parts[0] === 'evaluate' && parts[1] ? (parts[1] as EvaluationId) : null;
}
