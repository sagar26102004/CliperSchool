import { z } from 'zod';
import type { EvaluationContext } from '../Evaluator.js';
import type { RubricCriterion } from '../../domain/rubric/Rubric.js';

/**
 * Schema the model's reply must satisfy.
 *
 * The brief warns against an unconstrained "is this a good design?" prompt, and
 * this schema is the main defence. The model is not asked for an opinion and a
 * number; it is asked to fill in a fixed record per criterion, where `evidence`
 * must be quoted from the submission. Requiring evidence is what makes a
 * hallucinated critique expensive to produce and easy to spot — a concern with
 * no supporting quote is visibly unsupported in the UI.
 *
 * Validation happens here at the boundary. Anything that fails is either
 * repaired once or discarded in favour of deterministic-only feedback; a
 * malformed model reply must never reach the domain.
 */
export const LlmCriterionResultSchema = z.object({
  criterionId: z.string().min(1),
  score: z.number(),
  evidence: z.array(z.string()).default([]),
  concern: z.string().default(''),
  suggestion: z.string().default(''),
  confidence: z.number().min(0).max(1),
});

export const LlmEvaluationSchema = z.object({
  summary: z.string().default(''),
  results: z.array(LlmCriterionResultSchema).min(1),
});

export type LlmEvaluationPayload = z.infer<typeof LlmEvaluationSchema>;

const SYSTEM_PROMPT = [
  'You are an experienced software engineer reviewing a low-level design that a learner produced while practising for design interviews.',
  '',
  'The single most important rule: there is no reference solution, and more than one design can be correct. Judge the design the learner actually proposed, on its own terms. Never mark a design down for differing from how you would have done it. Mark it down only for internal inconsistency, unclear or badly placed responsibilities, coupling that will hurt, missing abstraction where the problem states variation exists, or reasoning that does not hold up.',
  '',
  'Rules for your output:',
  '- Score only the criteria you are given. Use the whole range; a competent-but-unremarkable design should land mid-range, not high.',
  '- Every "evidence" entry must be a short verbatim quote from the submission. Never invent a quote. If a criterion is about something absent, return an empty evidence array and say so in the concern.',
  '- "concern" names one specific weakness in this submission. Not a general lecture about design principles.',
  '- "suggestion" is one concrete change the learner could make on their next attempt.',
  '- "confidence" is your own certainty for that row, 0 to 1. Use a low value when the submission is too sparse to judge rather than guessing confidently.',
  '- Reply with a single JSON object and nothing else. No markdown fences, no commentary before or after.',
].join('\n');

export interface BuiltPrompt {
  readonly system: string;
  readonly user: string;
}

/**
 * Builds the rubric-constrained prompt.
 *
 * Only LLM-owned criteria are sent. Asking the model to also score the
 * structural criteria would waste tokens, invite it to contradict a check that
 * is definitionally correct, and blur which half of the system is accountable
 * for a given number.
 */
export function buildEvaluationPrompt(context: EvaluationContext): BuiltPrompt {
  const criteria = context.rubric.criteriaOwnedBy('llm');
  const { problem, graph } = context;

  const scenarioBlock = graph.changeScenarioAnswers
    .map((answer) => {
      const scenario = problem.scenario(answer.scenarioId);
      return [
        `Scenario: ${scenario?.prompt ?? answer.scenarioId}`,
        `Learner's answer: ${answer.text || '(left blank)'}`,
      ].join('\n');
    })
    .join('\n\n');

  const user = [
    '<problem>',
    `Title: ${problem.title}`,
    `Statement: ${problem.statement}`,
    'Functional requirements:',
    ...problem.functionalRequirements.map((r) => `- ${r}`),
    'Constraints:',
    ...problem.constraints.map((c) => `- ${c}`),
    'Explicitly out of scope (do not penalise its absence):',
    ...problem.outOfScope.map((o) => `- ${o}`),
    '</problem>',
    '',
    '<submission>',
    JSON.stringify(submissionView(context), null, 2),
    '</submission>',
    '',
    '<change_scenario>',
    scenarioBlock || '(no scenario answer provided)',
    '</change_scenario>',
    '',
    '<rubric>',
    ...criteria.map((c) => formatCriterion(c)),
    '</rubric>',
    '',
    '<output_format>',
    'Return JSON exactly of this shape:',
    JSON.stringify(
      {
        summary: 'two or three sentences addressed to the learner',
        results: criteria.map((c) => ({
          criterionId: c.id,
          score: `number between 0 and ${c.maxScore}`,
          evidence: ['verbatim quote from the submission'],
          concern: 'one specific weakness',
          suggestion: 'one concrete change for the next attempt',
          confidence: 'number between 0 and 1',
        })),
      },
      null,
      2,
    ),
    '</output_format>',
  ].join('\n');

  return { system: SYSTEM_PROMPT, user };
}

function formatCriterion(criterion: RubricCriterion): string {
  return [
    `- id: ${criterion.id}`,
    `  name: ${criterion.name}`,
    `  maxScore: ${criterion.maxScore}`,
    `  what it measures: ${criterion.description}`,
    `  how to judge it: ${criterion.evaluatorHint}`,
  ].join('\n');
}

/**
 * The projection of the submission the model sees.
 *
 * Built from the format-neutral `DesignGraph` rather than the raw content, so a
 * future diagram submission reaches the model in the same shape and the prompt
 * needs no rewrite.
 */
function submissionView(context: EvaluationContext): unknown {
  const { graph } = context;
  return {
    assumptions: graph.assumptions,
    types: graph.types.map((t) => ({
      name: t.name,
      kind: t.kind,
      responsibility: t.responsibility,
      attributes: t.attributes.map((a) => a.name),
      methods: t.methods.map((m) => m.name),
    })),
    relationships: graph.relationships.map((r) => `${r.from} --${r.type}--> ${r.to}`),
    tradeoffs: graph.tradeoffs,
  };
}

/**
 * Pulls a JSON object out of a model reply.
 *
 * Models wrap JSON in prose or markdown fences often enough that treating the
 * whole reply as JSON would throw away otherwise-valid evaluations. This strips
 * fences and falls back to the outermost balanced braces. It is a tolerance
 * layer, not a parser — anything it recovers still has to pass the zod schema.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // fall through to brace matching
  }

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }

  throw new SyntaxError('No JSON object found in model reply.');
}
