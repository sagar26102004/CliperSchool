import type { ProblemId, RubricId, ScenarioId } from '../ids.js';

export type Difficulty = 'starter' | 'core' | 'advanced';

/**
 * A "requirements just changed" twist, revealed with the problem statement.
 *
 * These are the sharpest instrument in the product. Two learners can produce
 * class lists that look equally reasonable, and the difference between a design
 * with deliberate seams and one that merely names nouns only shows up when
 * something has to change. Asking the question up front also teaches the right
 * habit: design for the change you were told about.
 */
export interface ChangeScenario {
  readonly id: ScenarioId;
  readonly prompt: string;
  /**
   * Concepts a strong answer tends to touch. Used only to *raise* confidence in
   * the deterministic engagement check — never to mark an answer wrong for
   * choosing a different route to the same extensibility.
   */
  readonly hints: readonly string[];
}

/**
 * An LLD practice problem.
 *
 * Problems are seed data, not code (`src/seed/problems/`). Adding a fifth
 * problem is a data file; it touches no class, no route and no evaluator.
 */
export class Problem {
  readonly id: ProblemId;
  readonly slug: string;
  readonly title: string;
  readonly difficulty: Difficulty;
  readonly summary: string;
  readonly statement: string;
  readonly functionalRequirements: readonly string[];
  readonly constraints: readonly string[];
  readonly outOfScope: readonly string[];
  /**
   * A *soft* checklist of concepts that commonly appear in good solutions.
   *
   * Explicitly not a reference solution, and the distinction is the product's
   * main bet. Missing concepts lower the confidence of the coverage criterion
   * and generate a question ("nothing here addresses pricing — deliberate?"),
   * they never subtract points for solving the problem a different way.
   */
  readonly expectedConcepts: readonly string[];
  readonly changeScenarios: readonly ChangeScenario[];
  readonly rubricId: RubricId;
  readonly estimatedMinutes: number;

  constructor(params: {
    id: ProblemId;
    slug: string;
    title: string;
    difficulty: Difficulty;
    summary: string;
    statement: string;
    functionalRequirements: readonly string[];
    constraints: readonly string[];
    outOfScope: readonly string[];
    expectedConcepts: readonly string[];
    changeScenarios: readonly ChangeScenario[];
    rubricId: RubricId;
    estimatedMinutes: number;
  }) {
    this.id = params.id;
    this.slug = params.slug;
    this.title = params.title;
    this.difficulty = params.difficulty;
    this.summary = params.summary;
    this.statement = params.statement;
    this.functionalRequirements = params.functionalRequirements;
    this.constraints = params.constraints;
    this.outOfScope = params.outOfScope;
    this.expectedConcepts = params.expectedConcepts;
    this.changeScenarios = params.changeScenarios;
    this.rubricId = params.rubricId;
    this.estimatedMinutes = params.estimatedMinutes;
  }

  scenario(id: ScenarioId): ChangeScenario | undefined {
    return this.changeScenarios.find((s) => s.id === id);
  }
}

export interface ProblemRepository {
  findById(id: ProblemId): Promise<Problem | null>;
  findBySlug(slug: string): Promise<Problem | null>;
  listAll(): Promise<readonly Problem[]>;
}
