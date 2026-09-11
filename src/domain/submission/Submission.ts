import { createHash } from 'node:crypto';
import type { AttemptId, SubmissionId } from '../ids.js';
import type { SubmissionContent, SubmissionFormat } from './SubmissionContent.js';

/**
 * An immutable record of what the learner submitted, exactly as they wrote it.
 *
 * Two properties matter and are load-bearing elsewhere:
 *
 *  1. **Immutability.** Feedback quotes the submission as evidence. If the
 *     submission could be edited after evaluation, that evidence would rot and
 *     the whole "point at what you actually wrote" promise breaks.
 *  2. **It is persisted before evaluation begins.** An evaluator crash, an LLM
 *     timeout or a process restart can cost a score but must never cost the
 *     learner their work. Everything downstream is recomputable from this row.
 */
export class Submission {
  readonly id: SubmissionId;
  readonly attemptId: AttemptId;
  readonly content: SubmissionContent;
  readonly submittedAt: Date;
  readonly contentHash: string;

  constructor(params: {
    id: SubmissionId;
    attemptId: AttemptId;
    content: SubmissionContent;
    submittedAt: Date;
  }) {
    this.id = params.id;
    this.attemptId = params.attemptId;
    this.content = params.content;
    this.submittedAt = params.submittedAt;
    this.contentHash = Submission.hash(params.content);
    Object.freeze(this);
  }

  get format(): SubmissionFormat {
    return this.content.format;
  }

  /**
   * Stable fingerprint of the submitted content, used as the idempotency key.
   *
   * A double-clicked submit button, a retried request or a refreshed tab all
   * produce identical content; hashing it lets `AttemptService` return the
   * existing evaluation instead of paying for a second LLM call and confusing
   * the learner with two different scores for the same design.
   *
   * Keys are sorted during serialisation so that a semantically identical
   * payload hashes identically regardless of field order in the request body.
   */
  static hash(content: SubmissionContent): string {
    return createHash('sha256').update(stableStringify(content)).digest('hex').slice(0, 32);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export interface SubmissionRepository {
  save(submission: Submission): Promise<void>;
  findById(id: SubmissionId): Promise<Submission | null>;
  findByAttemptId(attemptId: AttemptId): Promise<Submission | null>;
  /** Idempotency lookup: has this exact content already been submitted here? */
  findByAttemptAndHash(attemptId: AttemptId, contentHash: string): Promise<Submission | null>;
}
