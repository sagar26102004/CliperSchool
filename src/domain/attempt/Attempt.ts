import { InvalidStateTransitionError } from '../errors.js';
import type { AttemptId, EvaluationId, LearnerId, ProblemId, SubmissionId } from '../ids.js';

/**
 * Lifecycle of a single practice attempt.
 *
 *   Draft ──submit──▶ Submitted ──beginEvaluation──▶ Evaluating ──▶ Completed
 *                                       ▲                    └────▶ Failed
 *                                       └──── retry ─────────────────┘
 *
 * `Submitted` is deliberately distinct from `Evaluating`. The gap between them
 * is exactly the window where the submission is safely persisted but no
 * evaluator has touched it yet — which is what makes "the learner never loses
 * work when the LLM falls over" true rather than aspirational. It also gives the
 * UI something honest to display while a job waits in the queue.
 *
 * "Try again" is not a transition. A completed attempt stays completed forever
 * and a fresh Attempt is created with `attemptNumber + 1`, because the whole
 * point of the product is comparing attempt N against attempt N-1.
 */
export type AttemptStatus = 'Draft' | 'Submitted' | 'Evaluating' | 'Completed' | 'Failed';

const ALLOWED_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  Draft: ['Submitted'],
  Submitted: ['Evaluating'],
  Evaluating: ['Completed', 'Failed'],
  Completed: [],
  Failed: ['Evaluating'],
};

export class Attempt {
  readonly id: AttemptId;
  readonly learnerId: LearnerId;
  readonly problemId: ProblemId;
  /** 1-based, per (learner, problem). Drives the "attempt #3" framing. */
  readonly attemptNumber: number;
  readonly startedAt: Date;

  private _status: AttemptStatus;
  private _submissionId: SubmissionId | null;
  private _evaluationId: EvaluationId | null;
  private _submittedAt: Date | null;
  private _completedAt: Date | null;
  private _failureReason: string | null;

  constructor(params: {
    id: AttemptId;
    learnerId: LearnerId;
    problemId: ProblemId;
    attemptNumber: number;
    startedAt: Date;
    status?: AttemptStatus;
    submissionId?: SubmissionId | null;
    evaluationId?: EvaluationId | null;
    submittedAt?: Date | null;
    completedAt?: Date | null;
    failureReason?: string | null;
  }) {
    this.id = params.id;
    this.learnerId = params.learnerId;
    this.problemId = params.problemId;
    this.attemptNumber = params.attemptNumber;
    this.startedAt = params.startedAt;
    this._status = params.status ?? 'Draft';
    this._submissionId = params.submissionId ?? null;
    this._evaluationId = params.evaluationId ?? null;
    this._submittedAt = params.submittedAt ?? null;
    this._completedAt = params.completedAt ?? null;
    this._failureReason = params.failureReason ?? null;
  }

  get status(): AttemptStatus {
    return this._status;
  }
  get submissionId(): SubmissionId | null {
    return this._submissionId;
  }
  get evaluationId(): EvaluationId | null {
    return this._evaluationId;
  }
  get submittedAt(): Date | null {
    return this._submittedAt;
  }
  get completedAt(): Date | null {
    return this._completedAt;
  }
  get failureReason(): string | null {
    return this._failureReason;
  }

  /** True while the learner should be shown a progress indicator, not a result. */
  get isInFlight(): boolean {
    return this._status === 'Submitted' || this._status === 'Evaluating';
  }

  get isTerminal(): boolean {
    return this._status === 'Completed' || this._status === 'Failed';
  }

  /** True when the learner may still edit and submit. */
  get isEditable(): boolean {
    return this._status === 'Draft';
  }

  submit(submissionId: SubmissionId, at: Date): void {
    this.transitionTo('Submitted');
    this._submissionId = submissionId;
    this._submittedAt = at;
    this._failureReason = null;
  }

  beginEvaluation(evaluationId: EvaluationId): void {
    this.transitionTo('Evaluating');
    this._evaluationId = evaluationId;
    this._failureReason = null;
  }

  complete(evaluationId: EvaluationId, at: Date): void {
    this.transitionTo('Completed');
    this._evaluationId = evaluationId;
    this._completedAt = at;
    this._failureReason = null;
  }

  /**
   * Terminal-for-now, not terminal-forever: `Failed → Evaluating` is legal so a
   * transient LLM outage costs the learner a click, not their attempt.
   */
  fail(reason: string, at: Date): void {
    this.transitionTo('Failed');
    this._failureReason = reason;
    this._completedAt = at;
  }

  private transitionTo(next: AttemptStatus): void {
    const allowed = ALLOWED_TRANSITIONS[this._status];
    if (!allowed.includes(next)) {
      throw new InvalidStateTransitionError('Attempt', this._status, next);
    }
    this._status = next;
  }

  static canTransition(from: AttemptStatus, to: AttemptStatus): boolean {
    return ALLOWED_TRANSITIONS[from].includes(to);
  }
}

export interface AttemptRepository {
  save(attempt: Attempt): Promise<void>;
  findById(id: AttemptId): Promise<Attempt | null>;
  findByLearner(learnerId: LearnerId): Promise<readonly Attempt[]>;
  findByLearnerAndProblem(
    learnerId: LearnerId,
    problemId: ProblemId,
  ): Promise<readonly Attempt[]>;
  countByLearnerAndProblem(learnerId: LearnerId, problemId: ProblemId): Promise<number>;
}
