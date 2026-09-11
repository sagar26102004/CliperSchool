import { describe, expect, it } from 'vitest';
import { Attempt } from '../../src/domain/attempt/Attempt.js';
import { InvalidStateTransitionError } from '../../src/domain/errors.js';
import {
  asAttemptId,
  asEvaluationId,
  asLearnerId,
  asProblemId,
  asSubmissionId,
} from '../../src/domain/ids.js';

const AT = new Date('2026-01-01T10:00:00Z');

function newAttempt(): Attempt {
  return new Attempt({
    id: asAttemptId('att_1'),
    learnerId: asLearnerId('learner_1'),
    problemId: asProblemId('parking-lot'),
    attemptNumber: 1,
    startedAt: AT,
  });
}

const SUB = asSubmissionId('sub_1');
const EVAL = asEvaluationId('eval_1');

describe('Attempt lifecycle', () => {
  it('walks the happy path from Draft to Completed', () => {
    const attempt = newAttempt();
    expect(attempt.status).toBe('Draft');
    expect(attempt.isEditable).toBe(true);

    attempt.submit(SUB, AT);
    expect(attempt.status).toBe('Submitted');
    expect(attempt.submissionId).toBe(SUB);
    expect(attempt.isInFlight).toBe(true);

    attempt.beginEvaluation(EVAL);
    expect(attempt.status).toBe('Evaluating');

    attempt.complete(EVAL, AT);
    expect(attempt.status).toBe('Completed');
    expect(attempt.isTerminal).toBe(true);
    expect(attempt.isInFlight).toBe(false);
  });

  it('refuses a second submit on an already-submitted attempt', () => {
    const attempt = newAttempt();
    attempt.submit(SUB, AT);

    expect(() => attempt.submit(SUB, AT)).toThrow(InvalidStateTransitionError);
    // The first submission must survive the rejected transition.
    expect(attempt.status).toBe('Submitted');
    expect(attempt.submissionId).toBe(SUB);
  });

  it('refuses to complete an attempt that was never submitted', () => {
    const attempt = newAttempt();
    expect(() => attempt.complete(EVAL, AT)).toThrow(InvalidStateTransitionError);
    expect(attempt.status).toBe('Draft');
  });

  it('refuses to begin evaluation straight from Draft', () => {
    const attempt = newAttempt();
    expect(() => attempt.beginEvaluation(EVAL)).toThrow(InvalidStateTransitionError);
  });

  it('names the illegal transition in the error, so a log line is enough to debug it', () => {
    const attempt = newAttempt();
    attempt.submit(SUB, AT);
    attempt.beginEvaluation(EVAL);
    attempt.complete(EVAL, AT);

    try {
      attempt.submit(SUB, AT);
      expect.unreachable('expected the transition to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateTransitionError);
      const typed = error as InvalidStateTransitionError;
      expect(typed.from).toBe('Completed');
      expect(typed.to).toBe('Submitted');
      expect(typed.message).toContain('Completed');
    }
  });

  it('allows a failed attempt to be retried, because an outage is not the fault of the learner', () => {
    const attempt = newAttempt();
    attempt.submit(SUB, AT);
    attempt.beginEvaluation(EVAL);
    attempt.fail('Model provider unreachable.', AT);

    expect(attempt.status).toBe('Failed');
    expect(attempt.failureReason).toBe('Model provider unreachable.');

    attempt.beginEvaluation(EVAL);
    expect(attempt.status).toBe('Evaluating');
    // Retrying must clear the stale reason so the UI cannot show a failure
    // banner over an in-flight evaluation.
    expect(attempt.failureReason).toBeNull();

    attempt.complete(EVAL, AT);
    expect(attempt.status).toBe('Completed');
  });

  it('treats Completed as final — a repeat attempt is a new Attempt, not a reopened one', () => {
    const attempt = newAttempt();
    attempt.submit(SUB, AT);
    attempt.beginEvaluation(EVAL);
    attempt.complete(EVAL, AT);

    expect(() => attempt.beginEvaluation(EVAL)).toThrow(InvalidStateTransitionError);
    expect(() => attempt.fail('late failure', AT)).toThrow(InvalidStateTransitionError);
    expect(attempt.status).toBe('Completed');
  });

  it('exposes its transition table for callers that need to check before acting', () => {
    expect(Attempt.canTransition('Draft', 'Submitted')).toBe(true);
    expect(Attempt.canTransition('Draft', 'Evaluating')).toBe(false);
    expect(Attempt.canTransition('Failed', 'Evaluating')).toBe(true);
    expect(Attempt.canTransition('Completed', 'Evaluating')).toBe(false);
  });
});
