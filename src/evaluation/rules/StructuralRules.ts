import { asCriterionId } from '../../domain/ids.js';
import type { EvaluationContext } from '../Evaluator.js';
import { notApplicable, quote, type Rule, type RuleFinding } from './Rule.js';

const STRUCTURAL_INTEGRITY = asCriterionId('structural-integrity');

/**
 * Do relationships connect types that actually exist?
 *
 * A dangling edge usually means the learner had a type in mind and never wrote
 * it down — a real gap in the design, and one an LLM tends to politely paper
 * over by inferring what was meant. Exactly the kind of check worth spending
 * deterministic code on.
 */
export class DanglingRelationshipRule implements Rule {
  readonly id = 'dangling-relationships';
  readonly criterionId = STRUCTURAL_INTEGRITY;

  apply(context: EvaluationContext): RuleFinding {
    const { graph } = context;
    if (graph.types.length === 0) {
      return notApplicable('No types were declared, so there is no structure to check.');
    }
    if (graph.relationships.length === 0) {
      // Applicable, and a real gap rather than an unrunnable check: declaring
      // types with no relationships between them leaves the shape of the design
      // entirely unstated.
      return {
        ratio: 0.4,
        evidence: [],
        concern: 'No relationships were declared, so how the types fit together is unstated.',
        suggestion:
          'Add the relationships between your types — which owns which, which depends on which.',
        confidence: 1,
      };
    }

    const dangling = graph.danglingRelationships;
    if (dangling.length === 0) {
      return {
        ratio: 1,
        evidence: [`All ${graph.relationships.length} relationship(s) reference declared types.`],
        concern: '',
        suggestion: '',
        confidence: 1,
      };
    }

    const ratio = Math.max(0, 1 - dangling.length / graph.relationships.length);
    return {
      ratio,
      evidence: dangling.slice(0, 4).map((r) => `${r.from} --${r.type}--> ${r.to}`),
      concern: `${dangling.length} relationship(s) reference a type that was never declared.`,
      suggestion:
        'Either declare the missing type with its responsibility, or fix the name if it was a typo. A relationship to a type that does not exist is a hole in the design, not a formatting slip.',
      confidence: 1,
    };
  }
}

/** Types nothing connects to — usually a leftover noun rather than a design element. */
export class OrphanTypeRule implements Rule {
  readonly id = 'orphan-types';
  readonly criterionId = STRUCTURAL_INTEGRITY;

  apply(context: EvaluationContext): RuleFinding {
    const { graph } = context;
    if (graph.types.length <= 1) {
      return notApplicable(
        'Fewer than two types were declared, so there is nothing that could be orphaned.',
      );
    }

    const orphans = graph.orphanTypes;
    if (orphans.length === 0) {
      return {
        ratio: 1,
        evidence: ['Every declared type participates in at least one relationship.'],
        concern: '',
        suggestion: '',
        confidence: 1,
      };
    }

    const ratio = Math.max(0.3, 1 - orphans.length / graph.types.length);
    return {
      ratio,
      evidence: orphans.slice(0, 4).map((t) => quote(`${t.name}: ${t.responsibility}`)),
      concern: `${orphans.length} type(s) take part in no relationship: ${orphans
        .map((t) => t.name)
        .join(', ')}.`,
      suggestion:
        'Show how these connect to the rest of the design, or drop them. A type nothing collaborates with is either unused or its collaborations are the part you have not thought through yet.',
      // Not certain: enums and pure value objects legitimately sit outside the
      // relationship graph, so this is a prompt rather than a verdict.
      confidence: 0.7,
    };
  }
}

/** Inheritance loops — not a smell but an impossibility. */
export class InheritanceCycleRule implements Rule {
  readonly id = 'inheritance-cycles';
  readonly criterionId = STRUCTURAL_INTEGRITY;

  apply(context: EvaluationContext): RuleFinding {
    const hasInheritance = context.graph.relationships.some(
      (r) => r.type === 'extends' || r.type === 'implements',
    );
    if (!hasInheritance) {
      return notApplicable('No inheritance relationships were declared.');
    }

    const cycles = context.graph.findInheritanceCycles();
    if (cycles.length === 0) {
      return { ratio: 1, evidence: [], concern: '', suggestion: '', confidence: 1 };
    }
    return {
      ratio: 0,
      evidence: cycles.slice(0, 3).map((c) => c.join(' -> ')),
      concern: `Inheritance forms ${cycles.length} cycle(s), which cannot exist in a real type system.`,
      suggestion:
        'Break the cycle — usually one of these relationships is composition ("owns"/"uses") rather than inheritance.',
      confidence: 1,
    };
  }
}

/**
 * Interfaces nothing implements.
 *
 * Weighted gently. A one-implementation interface can be entirely correct when
 * it marks a seam the problem told you was coming — which is why the suggestion
 * asks the learner to justify it rather than telling them to delete it.
 */
export class UnimplementedAbstractionRule implements Rule {
  readonly id = 'unimplemented-abstractions';
  readonly criterionId = STRUCTURAL_INTEGRITY;

  apply(context: EvaluationContext): RuleFinding {
    const { graph } = context;
    if (graph.types.length === 0) {
      return notApplicable('No types were declared, so abstraction use cannot be assessed.');
    }
    if (graph.abstractions.length === 0) {
      return {
        ratio: 0.8,
        evidence: [],
        concern: 'No interfaces or abstract classes were declared.',
        suggestion:
          'Consider whether any part of this problem has more than one way of being done — that is where an interface earns its keep.',
        confidence: 0.6,
      };
    }

    const unimplemented = graph.unimplementedAbstractions;
    if (unimplemented.length === 0) {
      return {
        ratio: 1,
        evidence: graph.abstractions.slice(0, 3).map((a) => `${a.kind} ${a.name}`),
        concern: '',
        suggestion: '',
        confidence: 1,
      };
    }

    const ratio = Math.max(0.4, 1 - unimplemented.length / graph.abstractions.length);
    return {
      ratio,
      evidence: unimplemented.slice(0, 4).map((a) => `${a.kind} ${a.name}`),
      concern: `${unimplemented.length} abstraction(s) have no declared implementer: ${unimplemented
        .map((a) => a.name)
        .join(', ')}.`,
      suggestion:
        'Declare the concrete types that implement these, or explain in your trade-offs why the seam exists ahead of a second implementation.',
      confidence: 0.85,
    };
  }
}
