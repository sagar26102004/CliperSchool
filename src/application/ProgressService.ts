import type { LearnerId, ProblemId } from '../domain/ids.js';
import type { Attempt, AttemptRepository } from '../domain/attempt/Attempt.js';
import type { Evaluation, EvaluationRepository } from '../domain/evaluation/Evaluation.js';
import type { Problem, ProblemRepository } from '../domain/problem/Problem.js';
import type { Rubric, RubricRepository } from '../domain/rubric/Rubric.js';
import type { SubmissionRepository } from '../domain/submission/Submission.js';
import {
  FeedbackReport,
  type RecurringWeakness,
} from '../domain/feedback/FeedbackReport.js';

export interface AttemptHistoryEntry {
  readonly attempt: Attempt;
  readonly problem: Problem;
  readonly evaluation: Evaluation | null;
  readonly score: number | null;
  /** Change in score against the learner's previous attempt at the same problem. */
  readonly delta: number | null;
}

export interface ProblemProgress {
  readonly problem: Problem;
  readonly attemptCount: number;
  readonly bestScore: number | null;
  readonly latestScore: number | null;
  readonly trend: readonly number[];
}

export interface LearnerProgress {
  readonly history: readonly AttemptHistoryEntry[];
  readonly perProblem: readonly ProblemProgress[];
  readonly recurringWeaknesses: readonly RecurringWeakness[];
  readonly completedCount: number;
}

/**
 * Turns a pile of attempts into the thing that makes this a practice product
 * rather than a scoring endpoint.
 *
 * The research finding this exists to address: platforms happily tell a learner
 * their design was weak on responsibilities — once per attempt, in isolation —
 * and never join those up. A learner who has been told the same thing four
 * times has usually not noticed it was the same thing. Surfacing the pattern is
 * cheap here because every criterion is scored under a versioned rubric, so the
 * same dimension really is comparable across attempts.
 *
 * This is a read-side service. It creates nothing and mutates nothing, so it
 * could be moved behind a cache or a read replica later without touching the
 * practice flow.
 */
export class ProgressService {
  constructor(
    private readonly deps: {
      attempts: AttemptRepository;
      submissions: SubmissionRepository;
      evaluations: EvaluationRepository;
      problems: ProblemRepository;
      rubrics: RubricRepository;
    },
  ) {}

  async forLearner(learnerId: LearnerId): Promise<LearnerProgress> {
    const attempts = await this.deps.attempts.findByLearner(learnerId);
    const entries = await this.buildEntries(attempts);

    const perProblem = this.summariseByProblem(entries);
    const rubric = await this.primaryRubric();
    const completedEvaluations = entries
      .map((e) => e.evaluation)
      .filter((e): e is Evaluation => e !== null && e.status === 'Completed');

    return {
      history: entries,
      perProblem,
      recurringWeaknesses: rubric
        ? FeedbackReport.recurringWeaknesses(completedEvaluations, rubric)
        : [],
      completedCount: completedEvaluations.length,
    };
  }

  async forLearnerAndProblem(
    learnerId: LearnerId,
    problemId: ProblemId,
  ): Promise<readonly AttemptHistoryEntry[]> {
    const attempts = await this.deps.attempts.findByLearnerAndProblem(learnerId, problemId);
    return this.buildEntries(attempts);
  }

  /**
   * Loads the most recent completed submission so a repeat attempt can start
   * pre-filled.
   *
   * Small feature, disproportionate effect on the product. Retyping an entire
   * design to change two responsibilities is enough friction to stop most
   * learners iterating at all — and iteration is the whole loop.
   */
  async lastSubmittedContentFor(learnerId: LearnerId, problemId: ProblemId) {
    const attempts = await this.deps.attempts.findByLearnerAndProblem(learnerId, problemId);
    for (const attempt of [...attempts].reverse()) {
      if (!attempt.submissionId) continue;
      const submission = await this.deps.submissions.findById(attempt.submissionId);
      if (submission) return submission.content;
    }
    return null;
  }

  private async buildEntries(
    attempts: readonly Attempt[],
  ): Promise<readonly AttemptHistoryEntry[]> {
    const rubric = await this.primaryRubric();
    const entries: AttemptHistoryEntry[] = [];

    for (const attempt of attempts) {
      const problem = await this.deps.problems.findById(attempt.problemId);
      if (!problem) continue;

      let evaluation: Evaluation | null = null;
      if (attempt.submissionId) {
        evaluation = await this.deps.evaluations.findBySubmissionId(attempt.submissionId);
      }

      const score =
        evaluation && evaluation.status === 'Completed' && rubric
          ? evaluation.overallScore(rubric)
          : null;

      entries.push({ attempt, problem, evaluation, score, delta: null });
    }

    return this.withDeltas(entries);
  }

  /**
   * Fills in the per-problem score delta.
   *
   * Two rules keep the number meaningful.
   *
   * Deltas are computed against the previous attempt *at the same problem*,
   * never against the learner's previous attempt overall — moving from an
   * advanced problem to a starter one is not improvement, and reporting it as
   * such would make the number worthless.
   *
   * Partial evaluations are skipped entirely: they neither receive a delta nor
   * become the baseline for the next one. A partial score is calculated over
   * whichever criteria happened to run, so comparing it against a complete
   * score measures the outage rather than the learner.
   */
  private withDeltas(entries: readonly AttemptHistoryEntry[]): readonly AttemptHistoryEntry[] {
    const chronological = [...entries].sort(
      (a, b) => a.attempt.startedAt.getTime() - b.attempt.startedAt.getTime(),
    );
    const lastScoreByProblem = new Map<string, number>();
    const withDelta = new Map<string, number | null>();

    for (const entry of chronological) {
      const key = String(entry.attempt.problemId);
      if (entry.score === null || entry.evaluation?.partial) {
        withDelta.set(String(entry.attempt.id), null);
        continue;
      }
      const previous = lastScoreByProblem.get(key);
      withDelta.set(
        String(entry.attempt.id),
        previous === undefined ? null : Math.round((entry.score - previous) * 10) / 10,
      );
      lastScoreByProblem.set(key, entry.score);
    }

    return entries.map((entry) => ({
      ...entry,
      delta: withDelta.get(String(entry.attempt.id)) ?? null,
    }));
  }

  private summariseByProblem(
    entries: readonly AttemptHistoryEntry[],
  ): readonly ProblemProgress[] {
    const grouped = new Map<string, AttemptHistoryEntry[]>();
    for (const entry of entries) {
      const key = String(entry.attempt.problemId);
      const list = grouped.get(key);
      if (list) list.push(entry);
      else grouped.set(key, [entry]);
    }

    const summaries: ProblemProgress[] = [];
    for (const list of grouped.values()) {
      const chronological = [...list].sort(
        (a, b) => a.attempt.attemptNumber - b.attempt.attemptNumber,
      );
      const scores = chronological
        .map((e) => e.score)
        .filter((s): s is number => s !== null);
      const problem = chronological[0]?.problem;
      if (!problem) continue;

      summaries.push({
        problem,
        attemptCount: chronological.length,
        bestScore: scores.length > 0 ? Math.max(...scores) : null,
        latestScore: scores.length > 0 ? (scores[scores.length - 1] ?? null) : null,
        trend: scores,
      });
    }

    return summaries.sort((a, b) => b.attemptCount - a.attemptCount);
  }

  /**
   * The MVP runs one rubric, so history is directly comparable across problems.
   *
   * If a second rubric is ever introduced, this is the point that must start
   * refusing to compare scores across incompatible versions rather than drawing
   * a trend line through two different scales — which is precisely why every
   * Evaluation carries its `rubricVersionTag`.
   */
  private async primaryRubric(): Promise<Rubric | null> {
    const rubrics = await this.deps.rubrics.listAll();
    return rubrics[0] ?? null;
  }
}
