/**
 * Time and id generation are injected rather than called directly from entities.
 *
 * Two reasons: tests become deterministic (no sleeping, no snapshot churn), and
 * the domain stays free of ambient global dependencies, which is the same
 * argument that keeps repositories behind interfaces.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Advances only when told to, so tests can assert on durations and ordering. */
export class FixedClock implements Clock {
  constructor(private current: Date = new Date('2026-01-01T00:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface IdGenerator {
  next(prefix: string): string;
}

export const uuidIdGenerator: IdGenerator = {
  next: (prefix) => `${prefix}_${crypto.randomUUID()}`,
};

/** Monotonic, readable ids so failing test output points at the right entity. */
export class SequentialIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, '0')}`;
  }
}
