import type { CriterionId, RubricId } from '../ids.js';
import { ValidationError } from '../errors.js';

/**
 * Who is authoritative for a criterion.
 *
 * This is the single most important knob in the evaluation design. Rather than
 * asking an LLM "is this a good design?" and hoping, each criterion declares up
 * front whether it can be judged mechanically or genuinely needs reasoning.
 * `ScoreMergePolicy` reads this field to decide which evaluator wins when both
 * produce a result for the same criterion.
 *
 *  - `deterministic`: answerable from the structure of the submission alone
 *    (fields present, graph well-formed, scenario actually engaged with).
 *    Stable, free, instant, and identical on every run.
 *  - `llm`: requires judgement about meaning (is this responsibility cohesive?
 *    is this abstraction earning its place?). Cannot be faked with string
 *    matching, and is where multiple valid designs must be tolerated.
 */
export type CriterionOwner = 'deterministic' | 'llm';

/**
 * One scored dimension of design quality.
 *
 * Criteria are data, not code. Adding "Concurrency safety" to the rubric is a
 * seed-file edit plus (for a deterministic criterion) one rule class — never a
 * change to the practice flow, the orchestrator, or the UI.
 */
export interface RubricCriterion {
  readonly id: CriterionId;
  readonly name: string;
  /** Shown to the learner before they submit, so the target is never a secret. */
  readonly description: string;
  /** Relative importance when computing the weighted overall score. */
  readonly weight: number;
  readonly maxScore: number;
  readonly owner: CriterionOwner;
  /**
   * Guidance handed to the evaluator that owns this criterion. For LLM-owned
   * criteria it goes into the prompt; for deterministic ones it documents what
   * the corresponding rule is meant to be checking.
   */
  readonly evaluatorHint: string;
}

/**
 * A versioned set of criteria.
 *
 * Versioning matters more than it first appears: an Evaluation records the
 * rubric version it was scored under, so feedback a learner received three
 * weeks ago stays explainable after the rubric is retuned, and score trends can
 * refuse to compare across incompatible versions instead of drawing a
 * misleading line.
 */
export class Rubric {
  readonly id: RubricId;
  readonly version: number;
  readonly name: string;
  readonly criteria: readonly RubricCriterion[];

  constructor(params: {
    id: RubricId;
    version: number;
    name: string;
    criteria: readonly RubricCriterion[];
  }) {
    if (params.criteria.length === 0) {
      throw new ValidationError('A rubric must define at least one criterion.');
    }
    const ids = new Set(params.criteria.map((c) => c.id));
    if (ids.size !== params.criteria.length) {
      throw new ValidationError('Rubric criterion ids must be unique.');
    }
    for (const c of params.criteria) {
      if (c.weight <= 0) {
        throw new ValidationError(`Criterion "${c.id}" must have a positive weight.`);
      }
      if (c.maxScore <= 0) {
        throw new ValidationError(`Criterion "${c.id}" must have a positive maxScore.`);
      }
    }
    this.id = params.id;
    this.version = params.version;
    this.name = params.name;
    this.criteria = params.criteria;
  }

  /** Stable identifier stored on every Evaluation, e.g. `lld-core-v1`. */
  get versionTag(): string {
    return `${this.id}-v${this.version}`;
  }

  criterion(id: CriterionId): RubricCriterion {
    const found = this.criteria.find((c) => c.id === id);
    if (!found) {
      throw new ValidationError(`Unknown criterion "${id}" for rubric ${this.versionTag}.`);
    }
    return found;
  }

  has(id: CriterionId): boolean {
    return this.criteria.some((c) => c.id === id);
  }

  criteriaOwnedBy(owner: CriterionOwner): readonly RubricCriterion[] {
    return this.criteria.filter((c) => c.owner === owner);
  }

  get totalWeight(): number {
    return this.criteria.reduce((sum, c) => sum + c.weight, 0);
  }
}

export interface RubricRepository {
  findById(id: RubricId): Promise<Rubric | null>;
  /** Resolves the exact version an old Evaluation was scored under. */
  findByVersionTag(versionTag: string): Promise<Rubric | null>;
  listAll(): Promise<readonly Rubric[]>;
}
