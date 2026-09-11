import { NotFoundError, ValidationError } from '../domain/errors.js';
import type {
  AttemptId,
  LearnerId,
  ProblemId,
  SubmissionId,
} from '../domain/ids.js';
import { Attempt, type AttemptRepository } from '../domain/attempt/Attempt.js';
import { Submission, type SubmissionRepository } from '../domain/submission/Submission.js';
import type { Evaluation, EvaluationRepository } from '../domain/evaluation/Evaluation.js';
import type { Problem, ProblemRepository } from '../domain/problem/Problem.js';
import type { SubmissionContent } from '../domain/submission/SubmissionContent.js';
import type { AdapterRegistry } from '../domain/submission/DesignGraph.js';
import type { Clock, IdGenerator } from '../infra/clock.js';
import type { EvaluationOrchestrator } from './EvaluationOrchestrator.js';

export interface SubmitResult {
  readonly attempt: Attempt;
  readonly submission: Submission;
  readonly evaluation: Evaluation;
  /**
   * True when this call matched an existing submission by content hash and no
   * new evaluation was started. The web layer uses it to redirect rather than
   * re-render, and tests assert on it directly.
   */
  readonly deduplicated: boolean;
}

/**
 * The learner-facing use cases of the practice loop.
 *
 * Everything a learner can do to an attempt goes through here, which keeps the
 * lifecycle rules in one readable place instead of spread across route
 * handlers. The service coordinates; it does not decide — the state machine
 * lives in `Attempt`, scoring lives behind `Evaluator`, and this class is the
 * seam that wires them to a request.
 */
export class AttemptService {
  constructor(
    private readonly deps: {
      attempts: AttemptRepository;
      submissions: SubmissionRepository;
      evaluations: EvaluationRepository;
      problems: ProblemRepository;
      adapters: AdapterRegistry;
      orchestrator: EvaluationOrchestrator;
      clock: Clock;
      ids: IdGenerator;
    },
  ) {}

  /**
   * Begins attempt N+1 for this learner on this problem.
   *
   * The attempt number is derived from history rather than passed in, so
   * "attempt 3 of Parking Lot" is a fact about the data and cannot drift.
   */
  async startAttempt(learnerId: LearnerId, problemId: ProblemId): Promise<Attempt> {
    const problem = await this.deps.problems.findById(problemId);
    if (!problem) throw new NotFoundError('Problem', problemId);

    const previous = await this.deps.attempts.countByLearnerAndProblem(learnerId, problemId);
    const attempt = new Attempt({
      id: this.deps.ids.next('att') as AttemptId,
      learnerId,
      problemId,
      attemptNumber: previous + 1,
      startedAt: this.deps.clock.now(),
    });

    await this.deps.attempts.save(attempt);
    return attempt;
  }

  /**
   * Submits a design and schedules its evaluation.
   *
   * Two properties are load-bearing here.
   *
   * **The submission is saved before anything else can fail.** Persisting it
   * first means an evaluator outage, a crash, or a provider timeout costs a
   * score, never the learner's work — they can retry the evaluation against the
   * submission that is already safely stored.
   *
   * **Submitting the same content twice is a no-op.** A double-clicked button, a
   * refreshed tab or a retried request produces an identical content hash, and
   * returning the existing evaluation is both cheaper and far less confusing
   * than showing the same design two different scores.
   */
  async submit(params: {
    attemptId: AttemptId;
    content: SubmissionContent;
  }): Promise<SubmitResult> {
    const attempt = await this.deps.attempts.findById(params.attemptId);
    if (!attempt) throw new NotFoundError('Attempt', params.attemptId);

    const problem = await this.deps.problems.findById(attempt.problemId);
    if (!problem) throw new NotFoundError('Problem', attempt.problemId);

    if (!this.deps.adapters.supports(params.content.format)) {
      throw new ValidationError(
        `Submission format "${params.content.format}" is not supported yet.`,
      );
    }
    this.validate(params.content, problem);

    // Idempotency check runs before the state guard, so a duplicate submit on an
    // already-submitted attempt returns the original result instead of throwing
    // an InvalidStateTransitionError at a learner who merely double-clicked.
    const contentHash = Submission.hash(params.content);
    const existing = await this.deps.submissions.findByAttemptAndHash(attempt.id, contentHash);
    if (existing) {
      const evaluation = await this.deps.evaluations.findBySubmissionId(existing.id);
      if (evaluation) {
        return { attempt, submission: existing, evaluation, deduplicated: true };
      }
    }

    const submission = new Submission({
      id: this.deps.ids.next('sub') as SubmissionId,
      attemptId: attempt.id,
      content: params.content,
      submittedAt: this.deps.clock.now(),
    });
    await this.deps.submissions.save(submission);

    // Only now does the attempt change state. If this throws because the
    // attempt was not in Draft, the submission is still safely stored.
    attempt.submit(submission.id, this.deps.clock.now());
    await this.deps.attempts.save(attempt);

    const evaluation = await this.deps.orchestrator.scheduleEvaluation(submission.id);
    return { attempt, submission, evaluation, deduplicated: false };
  }

  async getAttempt(attemptId: AttemptId): Promise<Attempt> {
    const attempt = await this.deps.attempts.findById(attemptId);
    if (!attempt) throw new NotFoundError('Attempt', attemptId);
    return attempt;
  }

  async getSubmission(attemptId: AttemptId): Promise<Submission | null> {
    return this.deps.submissions.findByAttemptId(attemptId);
  }

  async getEvaluation(attemptId: AttemptId): Promise<Evaluation | null> {
    const submission = await this.deps.submissions.findByAttemptId(attemptId);
    if (!submission) return null;
    return this.deps.evaluations.findBySubmissionId(submission.id);
  }

  /**
   * Domain-level validation, distinct from the transport schema check in the
   * web layer.
   *
   * The bar is deliberately low: reject what cannot be evaluated at all, and let
   * the rubric handle everything else. Rejecting a thin design here would rob
   * the learner of the feedback that tells them *why* it is thin — which is the
   * single most useful thing the platform can say to a beginner.
   */
  private validate(content: SubmissionContent, problem: Problem): void {
    const issues: string[] = [];
    const graph = this.deps.adapters.toGraph(content);

    if (graph.types.length === 0) {
      issues.push('Add at least one class or interface before submitting.');
    }

    const answered = graph.changeScenarioAnswers.filter((a) => a.text.trim().length > 0);
    if (answered.length === 0) {
      issues.push('Answer the change scenario — it is the part that shows your design has seams.');
    }

    const knownScenarioIds = new Set(problem.changeScenarios.map((s) => String(s.id)));
    for (const answer of graph.changeScenarioAnswers) {
      if (!knownScenarioIds.has(String(answer.scenarioId))) {
        issues.push(`Unknown change scenario "${answer.scenarioId}" for this problem.`);
      }
    }

    if (issues.length > 0) {
      throw new ValidationError('This submission cannot be evaluated yet.', issues);
    }
  }
}
