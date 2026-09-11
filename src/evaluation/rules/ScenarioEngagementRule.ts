import { asCriterionId } from '../../domain/ids.js';
import type { EvaluationContext } from '../Evaluator.js';
import { quote, type Rule, type RuleFinding } from './Rule.js';

const SCENARIO_ENGAGEMENT = asCriterionId('scenario-engagement');

/**
 * Did the learner answer the change scenario in terms of their own design?
 *
 * The mechanical half of the extensibility question. Whether the answer is
 * *good* is a judgement call and belongs to the LLM; whether it exists, has
 * substance, and names types the learner actually declared is checkable without
 * any model at all — and catches the most common failure mode, which is a
 * confident generic answer ("I would just add a new class and a new strategy")
 * that could have been written without reading the design.
 */
export class ScenarioEngagementRule implements Rule {
  readonly id = 'scenario-engagement';
  readonly criterionId = SCENARIO_ENGAGEMENT;

  private static readonly MIN_ANSWER_CHARS = 80;

  apply(context: EvaluationContext): RuleFinding {
    const { graph, problem } = context;
    const answers = graph.changeScenarioAnswers.filter((a) => a.text.trim().length > 0);

    if (answers.length === 0) {
      return {
        ratio: 0,
        evidence: [],
        concern: 'The change scenario was not answered.',
        suggestion:
          'Answer it — it is the highest-signal part of the submission. Two designs can look identical until something has to change.',
        confidence: 1,
      };
    }

    const evidence: string[] = [];
    const concerns: string[] = [];
    let ratio = 1;

    for (const answer of answers) {
      const scenario = problem.scenario(answer.scenarioId);
      const label = scenario ? quote(scenario.prompt, 60) : String(answer.scenarioId);
      const text = answer.text.trim();

      // Penalties accumulate rather than short-circuit. Returning early on a
      // short answer would have scored a two-word answer *better* than a long
      // generic one, because the short answer would skip the check below.
      if (text.length < ScenarioEngagementRule.MIN_ANSWER_CHARS) {
        ratio -= 0.4;
        concerns.push(`The answer to "${label}" is too short to show reasoning.`);
      }

      const namedTypes = graph.typeNames.filter((name) =>
        // String.raw so the backslashes reach RegExp as word boundaries rather
        // than being consumed as string escapes.
        new RegExp(String.raw`\b${escapeRegex(name)}\b`, 'i').test(text),
      );

      if (namedTypes.length === 0) {
        ratio -= 0.45;
        concerns.push(
          `The answer to "${label}" never names a type from your own design, so it reads as a generic answer rather than an analysis of what you built.`,
        );
        evidence.push(quote(text));
      } else {
        evidence.push(
          `References own types (${namedTypes.slice(0, 4).join(', ')}): ${quote(text, 120)}`,
        );
      }
    }

    return {
      ratio: Math.max(0, ratio),
      evidence,
      concern: concerns.join(' '),
      suggestion:
        concerns.length > 0
          ? 'Name the specific types you would add or modify, and say explicitly which parts of the design stay untouched — that second half is what demonstrates the seams were deliberate.'
          : '',
      confidence: 0.9,
    };
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
