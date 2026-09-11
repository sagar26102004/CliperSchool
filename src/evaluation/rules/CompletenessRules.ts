import { asCriterionId } from '../../domain/ids.js';
import type { EvaluationContext } from '../Evaluator.js';
import { notApplicable, quote, type Rule, type RuleFinding } from './Rule.js';

const SPEC_COMPLETENESS = asCriterionId('spec-completeness');

/**
 * Is there enough here to constitute a design at all?
 *
 * Deliberately generous thresholds. The job of this rule is to separate "you
 * submitted three sentences" from "you submitted a design I disagree with" —
 * the latter is the LLM's business, not a word count's.
 */
export class MinimumViableSpecRule implements Rule {
  readonly id = 'minimum-viable-spec';
  readonly criterionId = SPEC_COMPLETENESS;

  private static readonly MIN_TYPES = 3;
  private static readonly MIN_RELATIONSHIPS = 2;

  apply(context: EvaluationContext): RuleFinding {
    const { graph } = context;
    const problems: string[] = [];
    const evidence: string[] = [];
    let score = 1;

    if (graph.types.length === 0) {
      return {
        ratio: 0,
        evidence: [],
        concern: 'No types were declared, so there is no design to review.',
        suggestion:
          'List the classes and interfaces your solution needs, each with a one-sentence responsibility.',
        confidence: 1,
      };
    }

    evidence.push(`Declared ${graph.types.length} type(s): ${graph.typeNames.join(', ')}`);

    if (graph.types.length < MinimumViableSpecRule.MIN_TYPES) {
      score -= 0.35;
      problems.push(
        `Only ${graph.types.length} type(s) declared, which is thin for a problem of this size.`,
      );
    }
    if (graph.relationships.length < MinimumViableSpecRule.MIN_RELATIONSHIPS) {
      score -= 0.25;
      problems.push(
        `Only ${graph.relationships.length} relationship(s) declared, so how the pieces fit together is largely unstated.`,
      );
    }
    if (graph.assumptions.length === 0) {
      score -= 0.2;
      problems.push('No assumptions were recorded.');
    } else {
      evidence.push(quote(`Assumption: ${graph.assumptions[0]}`));
    }
    if (graph.tradeoffs.trim().length < 40) {
      score -= 0.2;
      problems.push('The trade-offs section is empty or too brief to review.');
    } else {
      evidence.push(quote(`Trade-offs: ${graph.tradeoffs}`));
    }

    return {
      ratio: Math.max(0, score),
      evidence,
      concern: problems.join(' '),
      suggestion:
        problems.length > 0
          ? 'Fill in the thin sections — assumptions and trade-offs are where reviewers look for judgement, and an unstated assumption reads as an unnoticed one.'
          : '',
      confidence: 1,
    };
  }
}

/**
 * Does every declared type say what it is for?
 *
 * A type with no responsibility is not a small omission — it is the single most
 * common way a design hides the fact that nobody decided what the class does.
 */
export class ResponsibilityStatedRule implements Rule {
  readonly id = 'responsibility-stated';
  readonly criterionId = SPEC_COMPLETENESS;

  private static readonly MIN_RESPONSIBILITY_CHARS = 15;

  apply(context: EvaluationContext): RuleFinding {
    const { graph } = context;
    if (graph.types.length === 0) {
      return {
        ratio: 0,
        evidence: [],
        concern: 'No types to check.',
        suggestion: 'Declare the types in your design.',
        confidence: 1,
      };
    }

    const missing = graph.types.filter(
      (t) => t.responsibility.trim().length < ResponsibilityStatedRule.MIN_RESPONSIBILITY_CHARS,
    );
    const ratio = 1 - missing.length / graph.types.length;

    if (missing.length === 0) {
      const sample = graph.types[0];
      return {
        ratio: 1,
        evidence: sample ? [quote(`${sample.name}: ${sample.responsibility}`)] : [],
        concern: '',
        suggestion: '',
        confidence: 1,
      };
    }

    return {
      ratio,
      evidence: missing.slice(0, 4).map((t) => `${t.name}: "${t.responsibility.trim()}"`),
      concern: `${missing.length} of ${graph.types.length} type(s) have no meaningful responsibility statement: ${missing
        .map((t) => t.name)
        .join(', ')}.`,
      suggestion:
        'Give every type one sentence describing the single thing it is responsible for. If that sentence needs an "and", the type probably needs splitting.',
      confidence: 1,
    };
  }
}

/**
 * Does the design mention the concepts the problem is actually about?
 *
 * This is the rule most at risk of turning into reference-solution matching, so
 * it is deliberately declawed: it caps its own penalty, reports low confidence,
 * and phrases misses as questions. A learner who solves the parking lot with an
 * unusual but coherent model should lose very little here — the concern text
 * asks whether the omission was deliberate rather than asserting it was wrong.
 */
export class ConceptCoverageRule implements Rule {
  readonly id = 'concept-coverage';
  readonly criterionId = SPEC_COMPLETENESS;

  apply(context: EvaluationContext): RuleFinding {
    const { graph, problem } = context;
    if (graph.types.length === 0) {
      return notApplicable('No design content to search for the concepts this problem needs.');
    }
    const haystack = graph.fullText.toLowerCase();

    const covered: string[] = [];
    const missing: string[] = [];
    for (const concept of problem.expectedConcepts) {
      if (matchesConcept(haystack, concept)) covered.push(concept);
      else missing.push(concept);
    }

    if (problem.expectedConcepts.length === 0) {
      return notApplicable('This problem declares no expected concepts.');
    }

    const coverage = covered.length / problem.expectedConcepts.length;
    // Floor of 0.6: a coherent design expressed in different vocabulary must not
    // be dragged below a pass by this rule alone.
    const ratio = 0.6 + 0.4 * coverage;

    return {
      ratio,
      evidence:
        covered.length > 0 ? [`Concepts addressed: ${covered.join(', ')}`] : [],
      concern:
        missing.length > 0
          ? `Nothing in the design obviously addresses: ${missing.join(', ')}.`
          : '',
      suggestion:
        missing.length > 0
          ? 'If you handled these under different names, say so in your assumptions. If you left them out on purpose, say that too — an unexplained gap reads as an oversight.'
          : '',
      // Low by design: keyword presence is weak evidence, and the UI shows the
      // learner that this row is a prompt to check, not a verdict.
      confidence: 0.45,
    };
  }
}

function matchesConcept(haystack: string, concept: string): boolean {
  const words = concept
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  if (words.length === 0) return haystack.includes(concept.toLowerCase());
  return words.some((w) => haystack.includes(w));
}

const STOP_WORDS = new Set(['with', 'from', 'that', 'this', 'into', 'over', 'each']);
