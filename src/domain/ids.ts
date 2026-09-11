/**
 * Branded id types.
 *
 * Ids are plain strings at runtime, but branding them stops the very ordinary
 * mistake of passing an AttemptId where a SubmissionId is expected — the kind of
 * bug that is invisible in a codebase where every id is `string`.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type LearnerId = Brand<string, 'LearnerId'>;
export type ProblemId = Brand<string, 'ProblemId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type SubmissionId = Brand<string, 'SubmissionId'>;
export type EvaluationId = Brand<string, 'EvaluationId'>;
export type RubricId = Brand<string, 'RubricId'>;
export type CriterionId = Brand<string, 'CriterionId'>;
export type ScenarioId = Brand<string, 'ScenarioId'>;

export const asLearnerId = (v: string): LearnerId => v as LearnerId;
export const asProblemId = (v: string): ProblemId => v as ProblemId;
export const asAttemptId = (v: string): AttemptId => v as AttemptId;
export const asSubmissionId = (v: string): SubmissionId => v as SubmissionId;
export const asEvaluationId = (v: string): EvaluationId => v as EvaluationId;
export const asRubricId = (v: string): RubricId => v as RubricId;
export const asCriterionId = (v: string): CriterionId => v as CriterionId;
export const asScenarioId = (v: string): ScenarioId => v as ScenarioId;
