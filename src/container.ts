import { waitUntil } from '@vercel/functions';
import { AttemptService } from './application/AttemptService.js';
import {
  EvaluationOrchestrator,
  evaluationIdFromJobId,
} from './application/EvaluationOrchestrator.js';
import {
  InProcessJobQueue,
  ServerlessJobQueue,
  type JobQueue,
} from './application/JobQueue.js';
import { ProgressService } from './application/ProgressService.js';
import { CompositeEvaluator } from './evaluation/CompositeEvaluator.js';
import { DeterministicEvaluator } from './evaluation/DeterministicEvaluator.js';
import { LlmEvaluator } from './evaluation/LlmEvaluator.js';
import { OwnerWinsMergePolicy } from './evaluation/ScoreMergePolicy.js';
import type { Evaluator } from './evaluation/Evaluator.js';
import { defaultAdapterRegistry } from './domain/submission/DesignGraph.js';
import type { AttemptRepository } from './domain/attempt/Attempt.js';
import type { EvaluationRepository } from './domain/evaluation/Evaluation.js';
import type { ProblemRepository } from './domain/problem/Problem.js';
import type { RubricRepository } from './domain/rubric/Rubric.js';
import type { SubmissionRepository } from './domain/submission/Submission.js';
import {
  InMemoryAttemptRepository,
  InMemoryEvaluationRepository,
  InMemoryProblemRepository,
  InMemoryRubricRepository,
  InMemorySubmissionRepository,
} from './infra/persistence/InMemoryRepositories.js';
import {
  createRedisClient,
  resolveRedisConfig,
  RedisAttemptRepository,
  RedisEvaluationRepository,
  RedisSubmissionRepository,
} from './infra/persistence/RedisRepositories.js';
import { AnthropicClient } from './infra/llm/AnthropicClient.js';
import { OpenAiCompatibleClient } from './infra/llm/OpenAiCompatibleClient.js';
import { StubLlmClient, type StubFailureMode } from './infra/llm/StubLlmClient.js';
import type { LlmClient } from './infra/llm/LlmClient.js';
import { systemClock, uuidIdGenerator, type Clock, type IdGenerator } from './infra/clock.js';
import { CORE_RUBRIC } from './seed/rubric.js';
import { SEED_PROBLEMS } from './seed/problems/index.js';

export interface Container {
  readonly attemptService: AttemptService;
  readonly progressService: ProgressService;
  readonly orchestrator: EvaluationOrchestrator;
  // Declared as the domain interfaces, not concrete classes, so the storage
  // backend can change without any consumer noticing.
  readonly problems: ProblemRepository;
  readonly rubrics: RubricRepository;
  readonly attempts: AttemptRepository;
  readonly submissions: SubmissionRepository;
  readonly evaluations: EvaluationRepository;
  readonly queue: JobQueue;
  readonly llmClientId: string;
  /** Named for the startup banner and the deploy docs: 'memory' or 'redis'. */
  readonly storageId: string;
}

export type JobFailureHandler = (
  jobId: string,
  error: unknown,
  attemptsMade: number,
) => Promise<void>;

/** The three mutable repositories, chosen together so they cannot be mismatched. */
export interface StorageBundle {
  readonly attempts: AttemptRepository;
  readonly submissions: SubmissionRepository;
  readonly evaluations: EvaluationRepository;
  readonly storageId: string;
}

export interface ContainerOptions {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly llmClient?: LlmClient;
  /**
   * A factory rather than an instance, because a queue is useless without the
   * failure callback that records what went wrong — and that callback needs the
   * orchestrator, which does not exist until after the queue is built. Handing
   * the callback to the factory makes it impossible to inject a queue that
   * silently drops failures.
   */
  readonly queue?: (onFailure: JobFailureHandler) => JobQueue;
  readonly storage?: StorageBundle;
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

  // Problems and rubrics are immutable seed data shipped with the build, so
  // they stay in memory regardless of backend — storing them would add a round
  // trip and buy nothing.
  const problems = new InMemoryProblemRepository(SEED_PROBLEMS);
  const rubrics = new InMemoryRubricRepository([CORE_RUBRIC]);

  const storage = options.storage ?? resolveStorage();
  const { attempts, submissions, evaluations, storageId } = storage;

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

  // Returns the promise rather than firing and forgetting, so the queue waits
  // for the Failed state to be persisted before it treats the job as settled.
  const onJobFailure = async (jobId: string, error: unknown): Promise<void> => {
    const evaluationId = evaluationIdFromJobId(jobId);
    if (evaluationId) await orchestrator.markFailed(evaluationId, error);
  };

  const queue = options.queue
    ? options.queue(onJobFailure)
    : (isServerless()
      ? // On a serverless host the process stops once the response is flushed,
        // so background work has to be handed to the platform to be kept alive.
        new ServerlessJobQueue({
          scheduler: scheduleAfterResponse,
          jobTimeoutMs: options.queueOptions?.jobTimeoutMs ?? JOB_TIMEOUT_MS,
          onFailure: onJobFailure,
        })
      : new InProcessJobQueue({
          maxAttempts: options.queueOptions?.maxAttempts ?? 3,
          baseRetryDelayMs: options.queueOptions?.baseRetryDelayMs ?? 200,
          jobTimeoutMs: options.queueOptions?.jobTimeoutMs ?? JOB_TIMEOUT_MS,
          ...(options.queueOptions?.sleep ? { sleep: options.queueOptions.sleep } : {}),
          onFailure: onJobFailure,
        }));

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
    storageId,
  };
}

/**
 * How long one evaluation job may run before it is aborted.
 *
 * Sized from what the model actually does, not from what feels tidy. A
 * reasoning model's latency is dominated by thinking and varies widely —
 * Gemini 3.6 Flash answers this prompt in anywhere from 10 to 34 seconds — and
 * `LlmEvaluator` may spend a second call repairing malformed JSON within the
 * same deadline. The earlier 30s ceiling aborted healthy requests mid-flight,
 * which surfaced as an unreachable-provider error and degraded the evaluation
 * for no reason.
 *
 * Comfortably inside Vercel's 300s default function duration even after the
 * serverless queue's second attempt.
 */
const JOB_TIMEOUT_MS = 90_000;

/** True when running inside a Vercel function rather than a long-lived server. */
function isServerless(): boolean {
  return process.env['VERCEL'] === '1' || process.env['VERCEL_ENV'] !== undefined;
}

/**
 * Asks the platform to keep the function alive until `work` settles.
 *
 * Wrapped in a guard because `waitUntil` throws when there is no active request
 * context. The work has already been started by the caller, so a failure here
 * must not stop it — the worst case is that the platform may freeze the
 * function early, which `recoverIfStalled` is there to pick up.
 */
function scheduleAfterResponse(work: Promise<unknown>): void {
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/**
 * Picks the storage backend from the environment.
 *
 * In-memory is right for local development and tests: fast, zero setup, and
 * the process lives long enough for it to be correct. It is *wrong* on a
 * serverless host, where consecutive requests may land on different instances
 * and a learner's submission would vanish between the POST that saves it and
 * the GET that renders the feedback — so Redis is selected automatically
 * whenever its credentials are present.
 */
function resolveStorage(): StorageBundle {
  if (resolveRedisConfig() === null) {
    // Worth shouting about. On a serverless host this configuration does not
    // fail — it works right up until two requests land on different instances,
    // and then a learner's submission is simply gone. A loud line in the
    // function log is the difference between a five-minute fix and an
    // afternoon spent debugging a "random" 404.
    if (isServerless()) {
      console.warn(
        '[storage] No Redis credentials found — falling back to in-memory storage. ' +
          'On a serverless host attempts WILL be lost between requests. ' +
          'Attach a Redis store (Vercel dashboard -> Storage -> Marketplace -> Upstash) ' +
          'or set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, then redeploy.',
      );
    }
    return {
      attempts: new InMemoryAttemptRepository(),
      submissions: new InMemorySubmissionRepository(),
      evaluations: new InMemoryEvaluationRepository(),
      storageId: 'memory',
    };
  }

  const redis = createRedisClient();
  return {
    attempts: new RedisAttemptRepository(redis),
    submissions: new RedisSubmissionRepository(redis),
    evaluations: new RedisEvaluationRepository(redis),
    storageId: 'redis',
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
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey && anthropicKey.trim().length > 0) {
    return new AnthropicClient(anthropicKey, process.env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-5');
  }

  // Second choice: any provider speaking the OpenAI chat-completions shape.
  // Ordered after Anthropic so setting both keys is unambiguous rather than a
  // coin toss, and present at all because Anthropic has no free tier — this is
  // the path that lets the AI evaluator run for real on a free Gemini, Groq or
  // Mistral key instead of falling back to the stub.
  const compatible = resolveOpenAiCompatibleConfig();
  if (compatible) {
    return new OpenAiCompatibleClient(
      compatible.apiKey,
      compatible.baseUrl,
      compatible.model,
      compatible.providerId,
    );
  }

  const failureMode = (process.env['LLM_FAILURE_MODE'] ?? 'off') as StubFailureMode;
  return new StubLlmClient(failureMode);
}

/**
 * Resolves an OpenAI-compatible provider from the environment.
 *
 * `GEMINI_API_KEY` is special-cased purely as sugar: Google AI Studio is the
 * free tier worth recommending, and making it work from one variable removes
 * the two most likely ways to misconfigure it — a mistyped base URL, and
 * `gemini-2.5-flash`, which is still advertised by the models endpoint but
 * returns 404 for keys issued after its retirement.
 *
 * Everything else is reached through the generic trio, which is why no other
 * provider needs code here.
 */
function resolveOpenAiCompatibleConfig(
  env: NodeJS.ProcessEnv = process.env,
): { apiKey: string; baseUrl: string; model: string; providerId: string } | null {
  const geminiKey = env['GEMINI_API_KEY'];
  if (geminiKey && geminiKey.trim().length > 0) {
    return {
      apiKey: geminiKey,
      baseUrl: env['LLM_BASE_URL'] ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: env['LLM_MODEL'] ?? 'gemini-3.6-flash',
      providerId: 'gemini',
    };
  }

  const apiKey = env['LLM_API_KEY'];
  const baseUrl = env['LLM_BASE_URL'];
  const model = env['LLM_MODEL'];
  if (apiKey && apiKey.trim().length > 0 && baseUrl && model) {
    return { apiKey, baseUrl, model, providerId: 'openai-compatible' };
  }

  return null;
}
