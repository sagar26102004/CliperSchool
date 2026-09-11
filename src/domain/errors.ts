/**
 * Domain-level errors.
 *
 * These are thrown by entities and services in `src/domain` and `src/application`.
 * They deliberately carry no HTTP knowledge; the web layer maps them to statuses
 * in `src/web/errorMapper.ts`. That keeps the domain framework-free and means the
 * same rules apply if the platform is ever driven by a CLI or a queue consumer
 * instead of Express.
 */

export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Raised when a caller asks an entity to move to a state its lifecycle forbids,
 * e.g. completing an Attempt that was never submitted. The illegal transition is
 * named in the message so the failure is debuggable from a log line alone.
 */
export class InvalidStateTransitionError extends DomainError {
  readonly code = 'INVALID_STATE_TRANSITION';

  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${entity} cannot move from "${from}" to "${to}".`);
  }
}

/** Raised when an entity is asked for by id and does not exist. */
export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';

  constructor(entity: string, id: string) {
    super(`${entity} "${id}" was not found.`);
  }
}

/**
 * Raised when input fails domain rules (as opposed to transport-level schema
 * validation, which zod handles at the edge in `src/web`).
 */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';

  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
  }
}

/** Raised when an evaluator cannot produce a usable result at all. */
export class EvaluationFailedError extends DomainError {
  readonly code = 'EVALUATION_FAILED';

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
