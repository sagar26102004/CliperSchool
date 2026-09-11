import { AttemptService } from './application/AttemptService.js';
import {
  EvaluationOrchestrator,
  evaluationIdFromJobId,
} from './application/EvaluationOrchestrator.js';
import { InProcessJobQueue, type JobQueue } from './application/JobQueue.js';
import { ProgressService } from './application/ProgressService.js';
import { CompositeEvaluator } from './evaluation/CompositeEvaluator.js';
import { DeterministicEvaluator } from './evaluation/DeterministicEvaluator.js';
import { LlmEvaluator } from './evaluation/LlmEvaluator.js';
import { OwnerWinsMergePolicy } from './evaluation/ScoreMergePolicy.js';
import type { Evaluator } from './evaluation/Evaluator.js';
import { defaultAdapterRegistry } from './domain/submission/DesignGraph.js';
import {
  InMemoryAttemptRepository,
  InMemoryEvaluationRepository,
  InMemoryProblemRepository,
  InMemoryRubricRepository,
  InMemorySubmissionRepository,
} from './infra/persistence/InMemoryRepositories.js';
import { AnthropicClient } from './infra/llm/AnthropicClient.js';
import { StubLlmClient, type StubFailureMode } from './infra/llm/StubLlmClient.js';
import type { LlmClient } from './infra/llm/LlmClient.js';
import { systemClock, uuidIdGenerator, type Clock, type IdGenerator } from './infra/clock.js';
import { CORE_RUBRIC } from './seed/rubric.js';
import { SEED_PROBLEMS } from './seed/problems/index.js';

export interface Container {
  readonly attemptService: AttemptService;
  readonly progressService: ProgressService;
  readonly orchestrator: EvaluationOrchestrator;
  readonly problems: InMemoryProblemRepository;
  readonly rubrics: InMemoryRubricRepository;
  readonly attempts: InMemoryAttemptRepository;
  readonly submissions: InMemorySubmissionRepository;
  readonly evaluations: InMemoryEvaluationRepository;
  readonly queue: JobQueue;
  readonly llmClientId: string;
}

export interface ContainerOptions {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly llmClient?: LlmClient;
  readonly queue?: JobQueue;
  /** Lets tests and the reliability demo compose a different evaluator stack. */
  readonly evaluator?: Evaluator;
  readonly queueOptions?: {
    maxAttempts?: number;
    baseRetryDelayMs?: number;
    jobTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
}

/**
 * The composition root.
 *
 * Every decision about *which* implementation to use is made here and nowhere
 * else. That is what makes the extensibility claims in the design note checkable
 * rather than rhetorical: the choice between a real model and the offline stub,
 * between one evaluator and three, between in-memory and a future SQLite store,
 * is a few lines in this file — no domain type, service or route knows which
 * way any of them went.
 */
export function buildContainer(options: ContainerOptions = {}): Container {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? uuidIdGenerator;
  const adapters = defaultAdapterRegistry();

  const problems = new InMemoryProblemRepository(SEED_PROBLEMS);
  const rubrics = new InMemoryRubricRepository([CORE_RUBRIC]);
  const attempts = new InMemoryAttemptRepository();
  const submissions = new InMemorySubmissionRepository();
  const evaluations = new InMemoryEvaluationRepository();

  const llmClient = options.llmClient ?? resolveLlmClient();

  const evaluator =
    options.evaluator ??
    new CompositeEvaluator(
      [
        // Required: if structural checks cannot run, the platform is broken,
        // and pretending otherwise would hide a real bug behind a soft score.
        { evaluator: new DeterministicEvaluator(), required: true },
        // Optional by default: a model outage should cost depth of feedback,
        // never the attempt. This single flag is the whole graceful-degradation
        // story — flipping it to `required` turns the same outage into a Failed
        // evaluation with a retry button, which is the right choice for a
        // deployment that would rather show nothing than show half a score.
        { evaluator: new LlmEvaluator(llmClient), required: llmIsRequired() },
      ],
      new OwnerWinsMergePolicy(),
    );

  // Declared before the queue so the failure callback can close over it, and
  // assigned immediately after — the queue never runs a job before this returns.
  let orchestrator: EvaluationOrchestrator;

  const queue =
    options.queue ??
    new InProcessJobQueue({
      maxAttempts: options.queueOptions?.maxAttempts ?? 3,
      baseRetryDelayMs: options.queueOptions?.baseRetryDelayMs ?? 200,
      jobTimeoutMs: options.queueOptions?.jobTimeoutMs ?? 30_000,
      ...(options.queueOptions?.sleep ? { sleep: options.queueOptions.sleep } : {}),
      onFailure: (jobId, error) => {
        const evaluationId = evaluationIdFromJobId(jobId);
        if (evaluationId) void orchestrator.markFailed(evaluationId, error);
      },
    });

  orchestrator = new EvaluationOrchestrator({
    evaluations,
    submissions,
    attempts,
    problems,
    rubrics,
    adapters,
    evaluator,
    queue,
    clock,
    ids,
  });

  const attemptService = new AttemptService({
    attempts,
    submissions,
    evaluations,
    problems,
    adapters,
    orchestrator,
    clock,
    ids,
  });

  const progressService = new ProgressService({
    attempts,
    submissions,
    evaluations,
    problems,
    rubrics,
  });

  return {
    attemptService,
    progressService,
    orchestrator,
    problems,
    rubrics,
    attempts,
    submissions,
    evaluations,
    queue,
    llmClientId: llmClient.id,
  };
}

/**
 * Picks the model client from the environment.
 *
 * The prototype runs fully offline by default, on purpose: a reviewer should be
 * able to clone, install and see the whole loop work without holding an API
 * key. Setting `ANTHROPIC_API_KEY` swaps in real Claude with no code change,
 * which is the same substitution the design note claims is possible for any
 * evaluator.
 */
/**
 * Whether a model outage should degrade the evaluation or fail it.
 *
 * Off by default. Set `LLM_REQUIRED=true` to make the hard-failure path
 * reachable from the running app — combined with `LLM_FAILURE_MODE=throw` it
 * demonstrates the Failed state and the retry action end to end, rather than
 * leaving that path visible only in the test suite.
 */
function llmIsRequired(): boolean {
  return process.env['LLM_REQUIRED'] === 'true';
}

function resolveLlmClient(): LlmClient {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey && apiKey.trim().length > 0) {
    return new AnthropicClient(apiKey, process.env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-5');
  }
  const failureMode = (process.env['LLM_FAILURE_MODE'] ?? 'off') as StubFailureMode;
  return new StubLlmClient(failureMode);
}
