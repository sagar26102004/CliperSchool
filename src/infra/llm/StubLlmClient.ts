import type { LlmClient, LlmRequest, LlmResponse } from './LlmClient.js';
import { LlmUnavailableError } from './LlmClient.js';

/**
 * Fault-injection switch, driven by `LLM_FAILURE_MODE`.
 *
 * The brief asks what happens when evaluation is slow or fails. Rather than
 * describing the answer in a document, this makes every failure path
 * demonstrable on a running system and assertable in tests.
 */
export type StubFailureMode = 'off' | 'throw' | 'malformed' | 'slow' | 'empty';

/**
 * An offline stand-in for a language model.
 *
 * The important design decision: this fakes the *model*, not the evaluator. It
 * receives the same prompt a real model would and returns a string that still
 * has to survive `extractJson`, the zod schema, criterion filtering and score
 * clamping. So the entire `LlmEvaluator` path — including the repair retry and
 * the degrade-to-deterministic fallback — is exercised on every offline test
 * run. A stub that returned `CriterionResult[]` directly would have tested none
 * of that, and the failure handling would be the part nobody had ever run.
 *
 * Its judgements are crude heuristics over the submission embedded in the
 * prompt, but they do move with design quality, which keeps the offline demo
 * honest: a thin design scores visibly worse than a considered one, so the
 * score trend and recurring-weakness features show something real rather than
 * noise. It is a demo and test device, never a substitute for the real model —
 * set `ANTHROPIC_API_KEY` and `AnthropicClient` takes over with no code change.
 */
export class StubLlmClient implements LlmClient {
  readonly id = 'stub-llm';

  constructor(
    private readonly failureMode: StubFailureMode = 'off',
    private readonly slowDelayMs = 1_200,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    switch (this.failureMode) {
      case 'throw':
        throw new LlmUnavailableError('Injected failure: model provider unreachable.');
      case 'malformed':
        // Reproduces the most common real-world misbehaviour: prose wrapped
        // around JSON that is itself truncated.
        return this.reply('Sure! Here is my evaluation:\n```json\n{ "results": [ { "criterionId"');
      case 'empty':
        return this.reply('');
      case 'slow':
        await delay(this.slowDelayMs, request.signal);
        break;
      case 'off':
        break;
    }

    const submission = parseSubmission(request.user);
    const criteria = parseCriteria(request.user);
    if (criteria.length === 0) {
      return this.reply(JSON.stringify({ summary: '', results: [] }));
    }

    const results = criteria.map((criterion) => judge(criterion, submission));
    const mean =
      results.reduce((sum, r) => sum + r.score / (r.maxScore || 1), 0) / results.length;

    return this.reply(
      JSON.stringify(
        {
          summary: summarise(mean, submission),
          results: results.map(({ maxScore: _maxScore, ...rest }) => rest),
        },
        null,
        2,
      ),
    );
  }

  private reply(text: string): LlmResponse {
    return { text, model: 'stub-llm-heuristic-v1' };
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmUnavailableError('Aborted before the model replied.'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new LlmUnavailableError('Model call aborted by timeout.'));
      },
      { once: true },
    );
  });
}

interface StubSubmission {
  readonly assumptions: string[];
  readonly types: { name: string; kind: string; responsibility: string; methods: string[] }[];
  readonly relationships: string[];
  readonly tradeoffs: string;
  readonly scenarioAnswer: string;
}

function parseSubmission(userPrompt: string): StubSubmission {
  const block = between(userPrompt, '<submission>', '</submission>');
  const scenario = between(userPrompt, '<change_scenario>', '</change_scenario>');
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(block) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return {
    assumptions: asStringArray(parsed['assumptions']),
    types: Array.isArray(parsed['types'])
      ? (parsed['types'] as StubSubmission['types'])
      : [],
    relationships: asStringArray(parsed['relationships']),
    tradeoffs: typeof parsed['tradeoffs'] === 'string' ? parsed['tradeoffs'] : '',
    scenarioAnswer: scenario,
  };
}

interface StubCriterion {
  readonly id: string;
  readonly maxScore: number;
}

function parseCriteria(userPrompt: string): StubCriterion[] {
  const block = between(userPrompt, '<rubric>', '</rubric>');
  const criteria: StubCriterion[] = [];
  const lines = block.split('\n');
  let currentId: string | null = null;
  for (const line of lines) {
    const idMatch = /^-\s*id:\s*(.+)$/.exec(line.trim());
    if (idMatch?.[1]) {
      currentId = idMatch[1].trim();
      continue;
    }
    const maxMatch = /^maxScore:\s*(\d+(?:\.\d+)?)$/.exec(line.trim());
    if (maxMatch?.[1] && currentId) {
      criteria.push({ id: currentId, maxScore: Number(maxMatch[1]) });
      currentId = null;
    }
  }
  return criteria;
}

function between(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  if (start < 0 || end < 0 || end <= start) return '';
  return text.slice(start + open.length, end).trim();
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Heuristic judgement per criterion.
 *
 * Each branch keys off a different observable property of the submission so
 * that criteria do not all move together — otherwise every attempt would show
 * one flat score and the recurring-weakness feature would have nothing to find.
 */
function judge(
  criterion: StubCriterion,
  submission: StubSubmission,
): {
  criterionId: string;
  score: number;
  maxScore: number;
  evidence: string[];
  concern: string;
  suggestion: string;
  confidence: number;
} {
  const { types, relationships, tradeoffs, assumptions, scenarioAnswer } = submission;
  const max = criterion.maxScore;
  const abstractions = types.filter(
    (t) => t.kind === 'interface' || t.kind === 'abstract-class',
  );
  const compoundResponsibilities = types.filter((t) =>
    /\b(and|also|as well as)\b/i.test(t.responsibility),
  );
  const firstType = types[0];

  const build = (
    ratio: number,
    evidence: string[],
    concern: string,
    suggestion: string,
    confidence: number,
  ) => ({
    criterionId: criterion.id,
    score: Math.round(Math.max(0, Math.min(1, ratio)) * max * 10) / 10,
    maxScore: max,
    evidence,
    concern,
    suggestion,
    confidence,
  });

  switch (criterion.id) {
    case 'requirement-understanding': {
      const ratio = 0.35 + Math.min(0.45, assumptions.length * 0.12) + (types.length >= 5 ? 0.2 : 0);
      return build(
        ratio,
        assumptions.slice(0, 2),
        assumptions.length === 0
          ? 'No assumptions are recorded, so it is unclear which ambiguities you noticed and decided.'
          : 'Some requirements are addressed only implicitly by type names rather than stated behaviour.',
        'State the ambiguities you resolved and how, so a reviewer can tell a decision from an oversight.',
        assumptions.length > 0 ? 0.7 : 0.55,
      );
    }

    case 'class-responsibilities': {
      const penalty = types.length === 0 ? 1 : compoundResponsibilities.length / types.length;
      const ratio = 0.85 - penalty * 0.55;
      return build(
        ratio,
        compoundResponsibilities
          .slice(0, 2)
          .map((t) => `${t.name}: ${t.responsibility}`)
          .concat(firstType && compoundResponsibilities.length === 0 ? [`${firstType.name}: ${firstType.responsibility}`] : []),
        compoundResponsibilities.length > 0
          ? `${compoundResponsibilities.length} type(s) describe their job with "and", which usually means more than one reason to change.`
          : 'Responsibilities read as single-purpose, though some behaviour is implied by method names rather than stated.',
        compoundResponsibilities.length > 0
          ? `Split ${compoundResponsibilities[0]?.name ?? 'the compound type'} so each half has one reason to change.`
          : 'Push behaviour that currently lives in method names into the stated responsibility.',
        0.65,
      );
    }

    case 'coupling-cohesion': {
      const density = types.length === 0 ? 0 : relationships.length / types.length;
      // Both extremes are bad: nothing connected, or everything connected.
      const ratio = density === 0 ? 0.3 : density > 3 ? 0.45 : 0.55 + Math.min(0.3, density * 0.12);
      return build(
        ratio,
        relationships.slice(0, 3),
        density > 3
          ? 'The relationship count is high relative to the number of types, which suggests several types know more about each other than they need to.'
          : density === 0
            ? 'No relationships are declared, so coupling cannot be assessed from the design as written.'
            : 'A couple of concrete types are depended on directly where an abstraction would decouple them.',
        'Point dependencies at the abstractions you already declared rather than at their implementations.',
        relationships.length > 0 ? 0.6 : 0.4,
      );
    }

    case 'abstraction-and-patterns': {
      const ratio =
        abstractions.length === 0 ? 0.3 : 0.55 + Math.min(0.35, abstractions.length * 0.12);
      return build(
        ratio,
        abstractions.slice(0, 3).map((a) => `${a.kind} ${a.name}: ${a.responsibility}`),
        abstractions.length === 0
          ? 'The design declares no interfaces or abstract types, so every variation point in this problem is currently hard-wired.'
          : 'The abstractions present are reasonable, but their justification is not stated, so it is unclear which are load-bearing.',
        abstractions.length === 0
          ? 'Identify the one place this problem most obviously varies and introduce a seam there.'
          : 'In your trade-offs, name the second implementation each interface exists for.',
        0.6,
      );
    }

    case 'extensibility': {
      const namesOwnTypes = types.some((t) =>
        new RegExp(String.raw`\b${escapeRegex(t.name)}\b`, 'i').test(scenarioAnswer),
      );
      const substantial = scenarioAnswer.trim().length > 160;
      const ratio = (namesOwnTypes ? 0.5 : 0.2) + (substantial ? 0.3 : 0) + (abstractions.length > 0 ? 0.15 : 0);
      return build(
        ratio,
        scenarioAnswer ? [truncate(scenarioAnswer, 200)] : [],
        namesOwnTypes
          ? 'The answer identifies what would change but says less about what stays untouched, which is the part that demonstrates the seam was deliberate.'
          : 'The answer to the change scenario does not tie back to specific types in your design, so it reads as generic.',
        'Name the exact types you would add or modify, then state which existing types you would not need to open at all.',
        scenarioAnswer ? 0.7 : 0.3,
      );
    }

    default: {
      const ratio = tradeoffs.length > 80 ? 0.7 : 0.45;
      return build(
        ratio,
        tradeoffs ? [truncate(tradeoffs, 160)] : [],
        tradeoffs.length > 80
          ? 'The reasoning is present but stops short of naming what each choice costs.'
          : 'There is little explanation of why this design was chosen over the alternatives.',
        'For each significant choice, state the alternative you rejected and the price you are paying for the one you kept.',
        0.5,
      );
    }
  }
}

function summarise(mean: number, submission: StubSubmission): string {
  const shape = `${submission.types.length} type(s) and ${submission.relationships.length} relationship(s)`;
  if (mean >= 0.75) {
    return `A solid design: ${shape}, with responsibilities that mostly hold up and seams in sensible places. The remaining gains are in justifying your choices rather than restructuring them.`;
  }
  if (mean >= 0.5) {
    return `A workable design with ${shape}. The structure is reasonable; the weaknesses are concentrated in how responsibilities are described and how well the design absorbs the change scenario.`;
  }
  return `This submission has ${shape}, which is not yet enough to review as a design. Focus the next attempt on giving each type one clear job and on connecting them explicitly.`;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
