import { describe, expect, it } from 'vitest';
import { LlmEvaluator } from '../../src/evaluation/LlmEvaluator.js';
import type { EvaluationContext } from '../../src/evaluation/Evaluator.js';
import { defaultAdapterRegistry } from '../../src/domain/submission/DesignGraph.js';
import { Submission } from '../../src/domain/submission/Submission.js';
import { asAttemptId, asSubmissionId } from '../../src/domain/ids.js';
import { StubLlmClient } from '../../src/infra/llm/StubLlmClient.js';
import {
  LlmUnavailableError,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from '../../src/infra/llm/LlmClient.js';
import { CORE_RUBRIC } from '../../src/seed/rubric.js';
import { SEED_PROBLEMS } from '../../src/seed/problems/index.js';
import { strongDesign } from '../fixtures.js';

const adapters = defaultAdapterRegistry();
const problem = SEED_PROBLEMS.find((p) => p.slug === 'parking-lot')!;

function context(): EvaluationContext {
  return {
    submission: new Submission({
      id: asSubmissionId('sub_1'),
      attemptId: asAttemptId('att_1'),
      content: strongDesign,
      submittedAt: new Date('2026-01-01T00:00:00Z'),
    }),
    graph: adapters.toGraph(strongDesign),
    problem,
    rubric: CORE_RUBRIC,
  };
}

/** A scripted client, so each reply the evaluator must survive is explicit. */
class ScriptedLlmClient implements LlmClient {
  readonly id = 'scripted';
  readonly requests: LlmRequest[] = [];

  constructor(private readonly replies: (string | Error)[]) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const next = this.replies.shift();
    if (next === undefined) throw new Error('ScriptedLlmClient ran out of replies.');
    if (next instanceof Error) throw next;
    return { text: next, model: 'scripted' };
  }
}

const LLM_CRITERIA = CORE_RUBRIC.criteriaOwnedBy('llm');

function validPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: 'A considered design with clear seams.',
    results: LLM_CRITERIA.map((c) => ({
      criterionId: String(c.id),
      score: 4,
      evidence: ['ParkingLot: Admits and releases vehicles'],
      concern: 'Some behaviour is implied rather than stated.',
      suggestion: 'State it explicitly.',
      confidence: 0.8,
      ...overrides,
    })),
  });
}

describe('LlmEvaluator', () => {
  it('scores only the criteria the rubric marks as LLM-owned', async () => {
    const client = new ScriptedLlmClient([validPayload()]);
    const outcome = await new LlmEvaluator(client).evaluate(context());

    const scored = outcome.results.map((r) => String(r.criterionId)).sort();
    expect(scored).toEqual(LLM_CRITERIA.map((c) => String(c.id)).sort());
    expect(scored).not.toContain('structural-integrity');
    expect(outcome.results.every((r) => r.source === 'llm')).toBe(true);
  });

  it('sends temperature 0, so the same design cannot get two different scores', async () => {
    const client = new ScriptedLlmClient([validPayload()]);
    await new LlmEvaluator(client).evaluate(context());

    expect(client.requests[0]!.temperature).toBe(0);
  });

  it('embeds the rubric and forbids reference-solution comparison in the prompt', async () => {
    const client = new ScriptedLlmClient([validPayload()]);
    await new LlmEvaluator(client).evaluate(context());

    const request = client.requests[0]!;
    expect(request.system).toContain('no reference solution');
    expect(request.user).toContain('class-responsibilities');
    // Out-of-scope items must be named so the model does not deduct for them.
    expect(request.user).toContain('out of scope');
  });

  it('recovers JSON that the model wrapped in prose and markdown fences', async () => {
    const wrapped = `Certainly! Here is my assessment:\n\n\`\`\`json\n${validPayload()}\n\`\`\`\n\nHope that helps.`;
    const client = new ScriptedLlmClient([wrapped]);

    const outcome = await new LlmEvaluator(client).evaluate(context());
    expect(outcome.results.length).toBe(LLM_CRITERIA.length);
  });

  it('retries once with a correction when the first reply is malformed', async () => {
    const client = new ScriptedLlmClient(['{ "results": [ {"criterionId"', validPayload()]);

    const outcome = await new LlmEvaluator(client).evaluate(context());

    expect(client.requests.length).toBe(2);
    expect(client.requests[1]!.user).toContain('<correction>');
    expect(outcome.results.length).toBe(LLM_CRITERIA.length);
  });

  it('gives up after the bounded repair attempt rather than looping', async () => {
    const client = new ScriptedLlmClient(['not json at all', 'still not json']);

    await expect(new LlmEvaluator(client).evaluate(context())).rejects.toThrow(
      LlmUnavailableError,
    );
    // One initial call plus exactly one repair. A third paid call would not fix
    // a model that has failed the schema twice.
    expect(client.requests.length).toBe(2);
  });

  it('does not waste the repair attempt on a transport failure', async () => {
    const client = new ScriptedLlmClient([new LlmUnavailableError('connection reset')]);

    await expect(new LlmEvaluator(client).evaluate(context())).rejects.toThrow(
      LlmUnavailableError,
    );
    // Rephrasing the prompt cannot fix a network outage, so it aborts at once.
    expect(client.requests.length).toBe(1);
  });

  it('discards criteria the model invented', async () => {
    const payload = JSON.stringify({
      summary: 'ok',
      results: [
        {
          criterionId: 'elegance-of-naming',
          score: 5,
          evidence: [],
          concern: '',
          suggestion: '',
          confidence: 1,
        },
        {
          criterionId: 'class-responsibilities',
          score: 3,
          evidence: ['ParkingLot'],
          concern: 'ok',
          suggestion: 'ok',
          confidence: 0.7,
        },
      ],
    });
    const client = new ScriptedLlmClient([payload]);

    const outcome = await new LlmEvaluator(client).evaluate(context());

    expect(outcome.results.map((r) => String(r.criterionId))).toEqual([
      'class-responsibilities',
    ]);
    // The criteria it declined to score are reported, not silently dropped.
    expect(outcome.degradedReason).toContain('Extensibility');
  });

  it('clamps a score the model inflated beyond the criterion maximum', async () => {
    const client = new ScriptedLlmClient([validPayload({ score: 97 })]);

    const outcome = await new LlmEvaluator(client).evaluate(context());

    for (const result of outcome.results) {
      expect(result.score).toBeLessThanOrEqual(result.maxScore);
    }
  });

  it('clamps an out-of-range confidence rather than trusting it', async () => {
    // zod rejects confidence outside 0..1, which forces the repair path; the
    // point is that an impossible value can never reach the domain.
    const client = new ScriptedLlmClient([validPayload({ confidence: 4 }), validPayload()]);

    const outcome = await new LlmEvaluator(client).evaluate(context());

    expect(client.requests.length).toBe(2);
    for (const result of outcome.results) {
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('StubLlmClient', () => {
  it('produces schema-valid output for every LLM-owned criterion', async () => {
    const outcome = await new LlmEvaluator(new StubLlmClient()).evaluate(context());

    expect(outcome.results.length).toBe(LLM_CRITERIA.length);
    expect(outcome.summary).toBeTruthy();
    for (const result of outcome.results) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(result.maxScore);
      expect(result.concern.length).toBeGreaterThan(0);
      expect(result.suggestion.length).toBeGreaterThan(0);
    }
  });

  it('honours the injected failure modes used by the reliability demo', async () => {
    await expect(
      new LlmEvaluator(new StubLlmClient('throw')).evaluate(context()),
    ).rejects.toThrow(LlmUnavailableError);

    await expect(
      new LlmEvaluator(new StubLlmClient('malformed')).evaluate(context()),
    ).rejects.toThrow(LlmUnavailableError);
  });

  it('aborts a slow call when the signal fires, so a hung model cannot pin a worker', async () => {
    const controller = new AbortController();
    const evaluator = new LlmEvaluator(new StubLlmClient('slow', 5_000));
    const promise = evaluator.evaluate({ ...context(), signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toThrow(LlmUnavailableError);
  });
});
