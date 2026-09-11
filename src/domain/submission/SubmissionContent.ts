import type { ScenarioId } from '../ids.js';

/**
 * Submission formats.
 *
 * Change test A from the brief ("today text, later a class diagram — how much of
 * the domain model changes?") is answered here. `SubmissionContent` is a
 * discriminated union tagged by `format`. Attempt, Submission, Evaluation and
 * the whole practice flow are written against the union, never against
 * `DesignSpecContent` directly, so adding a diagram format means:
 *
 *   1. add a `ClassDiagramContent` interface and one arm to the union,
 *   2. add a `SubmissionContentAdapter` that projects it to `DesignGraph`,
 *   3. register an evaluator that declares `supports('class-diagram')`.
 *
 * Nothing in Attempt, the orchestrator, the repositories or the history view
 * changes, because none of them look inside the content.
 */
export type SubmissionFormat = 'design-spec' | 'class-diagram' | 'code';

export interface ClassMember {
  readonly name: string;
  readonly note?: string;
}

/** A class or interface the learner declares, with the responsibility they claim for it. */
export interface DeclaredType {
  readonly name: string;
  /**
   * One sentence. Deliberately one sentence: if a learner cannot describe a
   * class's job without "and", that is itself the signal the god-class rule
   * looks for.
   */
  readonly responsibility: string;
  readonly kind: 'class' | 'interface' | 'enum' | 'abstract-class';
  readonly attributes: readonly ClassMember[];
  readonly methods: readonly ClassMember[];
}

export type RelationshipType = 'owns' | 'uses' | 'extends' | 'implements' | 'creates';

export interface Relationship {
  readonly from: string;
  readonly to: string;
  readonly type: RelationshipType;
  readonly note?: string;
}

export interface ChangeScenarioAnswer {
  readonly scenarioId: ScenarioId;
  readonly text: string;
}

/**
 * The MVP submission format: a structured design spec.
 *
 * Chosen over free-form markdown because structure is what makes the two halves
 * of evaluation work. Deterministic rules need addressable fields to check a
 * relationship graph or scenario engagement; the LLM produces markedly more
 * consistent per-criterion judgements when handed labelled sections instead of
 * prose it must first parse. Chosen over code because code proves
 * implementation, not design intent — and running untrusted code needs a
 * sandbox, which is a day of work that buys nothing for the learner loop.
 */
export interface DesignSpecContent {
  readonly format: 'design-spec';
  readonly assumptions: readonly string[];
  readonly types: readonly DeclaredType[];
  readonly relationships: readonly Relationship[];
  readonly tradeoffs: string;
  /**
   * The highest-signal field in the whole submission. Any competent learner can
   * list nouns; the answer to "requirements just changed — what do you touch?"
   * is what separates a design that merely names classes from one that placed
   * its seams deliberately.
   */
  readonly changeScenarioAnswers: readonly ChangeScenarioAnswer[];
}

/** Placeholder arms proving the union is the extension point, not a rewrite. */
export interface ClassDiagramContent {
  readonly format: 'class-diagram';
  readonly notation: 'mermaid' | 'plantuml';
  readonly source: string;
  readonly changeScenarioAnswers: readonly ChangeScenarioAnswer[];
}

export interface CodeContent {
  readonly format: 'code';
  readonly language: string;
  readonly files: readonly { path: string; source: string }[];
  readonly changeScenarioAnswers: readonly ChangeScenarioAnswer[];
}

export type SubmissionContent = DesignSpecContent | ClassDiagramContent | CodeContent;
