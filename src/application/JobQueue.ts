/**
 * A single-process background queue.
 *
 * The brief explicitly warns against turning this into a distributed-systems
 * exercise, so this is the smallest thing that delivers the properties that
 * actually matter to the learner experience:
 *
 *  - submitting returns immediately, so a slow model never blocks the request;
 *  - work is retried a bounded number of times with backoff;
 *  - a job that hangs is aborted rather than occupying the worker forever;
 *  - failures are reported, not swallowed.
 *
 * The interface is what matters more than the implementation. `enqueue` is the
 * only thing `AttemptService` knows about, so replacing this with BullMQ, SQS or
 * a database-backed outbox is a composition-root swap. That is also the honest
 * answer to "what would you split out first if this grew" — see the README.
 */
export interface JobQueue {
  enqueue(job: Job): void;
  /** Test/shutdown hook: resolves once nothing is queued or running. */
  drain(): Promise<void>;
  readonly pending: number;
}

export interface Job {
  readonly id: string;
  run(signal: AbortSignal): Promise<void>;
}

export interface QueueOptions {
  /** Total attempts, not retries: 3 means one try plus two retries. */
  readonly maxAttempts?: number;
  readonly baseRetryDelayMs?: number;
  readonly jobTimeoutMs?: number;
  readonly concurrency?: number;
  readonly onFailure?: (jobId: string, error: unknown, attemptsMade: number) => void;
  /** Injected so tests need not actually wait out the backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class InProcessJobQueue implements JobQueue {
  private readonly queue: Job[] = [];
  private running = 0;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly jobTimeoutMs: number;
  private readonly concurrency: number;
  private readonly onFailure: (jobId: string, error: unknown, attemptsMade: number) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private idleWaiters: (() => void)[] = [];

  constructor(options: QueueOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 250;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 30_000;
    this.concurrency = options.concurrency ?? 2;
    this.onFailure = options.onFailure ?? (() => {});
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get pending(): number {
    return this.queue.length + this.running;
  }

  enqueue(job: Job): void {
    this.queue.push(job);
    queueMicrotask(() => void this.pump());
  }

  async drain(): Promise<void> {
    if (this.pending === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async pump(): Promise<void> {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      this.running += 1;
      void this.execute(job).finally(() => {
        this.running -= 1;
        if (this.pending === 0) this.releaseIdleWaiters();
        else void this.pump();
      });
    }
    if (this.pending === 0) this.releaseIdleWaiters();
  }

  /**
   * Runs one job with a timeout, retrying transient failures.
   *
   * Note that the queue does not decide *what* a failure means to a learner —
   * it hands the final error to `onFailure` and the orchestrator translates it
   * into an Evaluation state. Keeping that split means the queue stays a piece
   * of plumbing with no opinion about evaluation.
   */
  private async execute(job: Job): Promise<void> {
    let attemptsMade = 0;
    let lastError: unknown;

    while (attemptsMade < this.maxAttempts) {
      attemptsMade += 1;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`Job timed out after ${this.jobTimeoutMs}ms.`)),
        this.jobTimeoutMs,
      );
      try {
        await job.run(controller.signal);
        clearTimeout(timer);
        return;
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        if (attemptsMade < this.maxAttempts) {
          // Exponential backoff. Modest, because the learner is watching a
          // spinner and a long wait is worse than an honest failure.
          await this.sleep(this.baseRetryDelayMs * 2 ** (attemptsMade - 1));
        }
      }
    }

    this.onFailure(job.id, lastError, attemptsMade);
  }

  private releaseIdleWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) waiter();
  }
}
