import { InvalidStateTransitionError } from '../errors.js';
import type { EvaluationId, SubmissionId } from '../ids.js';
import type { Rubric } from '../rubric/Rubric.js';
import type { CriterionResult } from './CriterionResult.js';

/**
 * Evaluation lifecycle, mirroring the states the brief asks for:
 *
 *   Queued ──▶ Running ──▶ Completed
 *                     └──▶ Failed ──retry──▶ Running
 *
 * `Queued` exists as its own state (rather than starting at `Running`) so the
 * record is durable the moment the submission lands, before any evaluator work
 * begins. If the process dies mid-evaluation, a `Running` row with no
 * `completedAt` is a recoverable orphan rather than a mystery.
 */
export type EvaluationStatus = 'Queued' | 'Running' | 'Completed' | 'Failed';

const ALLOWED: Readonly<Record<EvaluationStatus, readonly EvaluationStatus[]>> = {
  Queued: ['Running', 'Failed'],
  // `Running -> Running` is deliberate, not an oversight. When the queue retries
  // a job whose previous run threw, a fresh run begins while the record is still
  // Running — it never passed through a terminal state. Forbidding the
  // self-transition would make every queue-level retry die on an
  // InvalidStateTransitionError instead of actually retrying, which is exactly
  // the bug this table once had. `attemptsMade` is what distinguishes the runs.
  Running: ['Completed', 'Failed', 'Running'],
  Completed: [],
  Failed: ['Running'],
};

/**
 * The scored verdict on one submission.
 *
 * Note the split of responsibilities: `Evaluation` owns *scoring* — stable,
 * versioned, auditable, and never rewritten for presentation. How that score is
 * explained to a learner (which three things to focus on, what keeps recurring
 * across attempts) belongs to `FeedbackReport`, which is derived on read.
 * Keeping them apart means the wording of feedback can be improved without
 * invalidating historical scores.
 */
export class Evaluation {
  readonly id: EvaluationId;
  readonly submissionId: SubmissionId;
  /** e.g. `lld-core-v1` — pins the exact criteria this score means. */
  readonly rubricVersionTag: string;
  readonly queuedAt: Date;

  private _status: EvaluationStatus;
  private _results: readonly CriterionResult[];
  private _summary: string;
  private _startedAt: Date | null;
  private _completedAt: Date | null;
  private _failureReason: string | null;
  private _partial: boolean;
  private _degradedReasons: readonly string[];
  private _attemptsMade: number;

  constructor(params: {
    id: EvaluationId;
    submissionId: SubmissionId;
    rubricVersionTag: string;
    queuedAt: Date;
    status?: EvaluationStatus;
    results?: readonly CriterionResult[];
    summary?: string;
    startedAt?: Date | null;
    completedAt?: Date | null;
    failureReason?: string | null;
    partial?: boolean;
    degradedReasons?: readonly string[];
    attemptsMade?: number;
  }) {
    this.id = params.id;
    this.submissionId = params.submissionId;
    this.rubricVersionTag = params.rubricVersionTag;
    this.queuedAt = params.queuedAt;
    this._status = params.status ?? 'Queued';
    this._results = params.results ?? [];
    this._summary = params.summary ?? '';
    this._startedAt = params.startedAt ?? null;
    this._completedAt = params.completedAt ?? null;
    this._failureReason = params.failureReason ?? null;
    this._partial = params.partial ?? false;
    this._degradedReasons = params.degradedReasons ?? [];
    this._attemptsMade = params.attemptsMade ?? 0;
  }

  get status(): EvaluationStatus {
    return this._status;
  }
  get results(): readonly CriterionResult[] {
    return this._results;
  }
  get summary(): string {
    return this._summary;
  }
  get startedAt(): Date | null {
    return this._startedAt;
  }
  get completedAt(): Date | null {
    return this._completedAt;
  }
  get failureReason(): string | null {
    return this._failureReason;
  }
  /**
   * True when some evaluator could not contribute — typically the LLM leg
   * failing while deterministic rules succeeded. The learner still gets real
   * feedback; the UI just says plainly which part is missing rather than
   * pretending the score is complete.
   */
  get partial(): boolean {
    return this._partial;
  }
  get degradedReasons(): readonly string[] {
    return this._degradedReasons;
  }
  get attemptsMade(): number {
    return this._attemptsMade;
  }

  get durationMs(): number | null {
    if (!this._startedAt || !this._completedAt) return null;
    return this._completedAt.getTime() - this._startedAt.getTime();
  }

  start(at: Date): void {
    this.transitionTo('Running');
    this._startedAt = at;
    this._attemptsMade += 1;
    this._failureReason = null;
  }

  complete(params: {
    results: readonly CriterionResult[];
    summary: string;
    at: Date;
    partial?: boolean;
    degradedReasons?: readonly string[];
  }): void {
    this.transitionTo('Completed');
    this._results = params.results;
    this._summary = params.summary;
    this._completedAt = params.at;
    this._partial = params.partial ?? false;
    this._degradedReasons = params.degradedReasons ?? [];
  }

  fail(reason: string, at: Date): void {
    this.transitionTo('Failed');
    this._failureReason = reason;
    this._completedAt = at;
  }

  private transitionTo(next: EvaluationStatus): void {
    if (!ALLOWED[this._status].includes(next)) {
      throw new InvalidStateTransitionError('Evaluation', this._status, next);
    }
    this._status = next;
  }

  /**
   * Weighted percentage across the rubric.
   *
   * Weighting lives here rather than in the evaluators so that no evaluator can
   * quietly inflate its own importance — an evaluator reports a raw score
   * against a criterion's `maxScore`, and the rubric alone decides what that
   * criterion is worth. Criteria with no result are skipped rather than scored
   * zero, so a partial evaluation reports an honest score over what was
   * actually assessed instead of a misleadingly low one.
   */
  overallScore(rubric: Rubric): number {
    let weighted = 0;
    let totalWeight = 0;
    for (const result of this._results) {
      if (!rubric.has(result.criterionId)) continue;
      const criterion = rubric.criterion(result.criterionId);
      const ratio = result.maxScore === 0 ? 0 : result.score / result.maxScore;
      weighted += ratio * criterion.weight;
      totalWeight += criterion.weight;
    }
    if (totalWeight === 0) return 0;
    return Math.round((weighted / totalWeight) * 1000) / 10;
  }

  resultFor(criterionId: string): CriterionResult | undefined {
    return this._results.find((r) => r.criterionId === criterionId);
  }
}

export interface EvaluationRepository {
  save(evaluation: Evaluation): Promise<void>;
  findById(id: EvaluationId): Promise<Evaluation | null>;
  findBySubmissionId(submissionId: SubmissionId): Promise<Evaluation | null>;
  findBySubmissionIds(ids: readonly SubmissionId[]): Promise<readonly Evaluation[]>;
}
