import { Rubric, type RubricCriterion } from '../domain/rubric/Rubric.js';
import { asCriterionId, asRubricId } from '../domain/ids.js';

/**
 * The core LLD rubric, v1.
 *
 * Eight dimensions, each owned by exactly one evaluator. The `owner` split is
 * the heart of the evaluation design: anything answerable from structure is
 * deterministic (free, instant, identical every run, impossible to hallucinate),
 * and only genuine judgement calls are spent on the LLM.
 *
 * Weights add to 100 for readability, though `Rubric` only ever uses them as
 * relative proportions. The two heaviest criteria are Class Responsibilities and
 * Extensibility — the two things that actually distinguish LLD skill, and the
 * two a learner is least able to self-assess.
 */
const CRITERIA: readonly RubricCriterion[] = [
  {
    id: asCriterionId('requirement-understanding'),
    name: 'Requirement Understanding',
    description:
      'Does the design engage with the stated requirements and make its assumptions explicit rather than silently guessing?',
    weight: 12,
    maxScore: 5,
    owner: 'llm',
    evaluatorHint:
      'Check whether the assumptions and types address the functional requirements as written. Reward explicit, sensible assumptions about ambiguity. Do not penalise scope the problem marked out of scope. Penalise designs that solve a different problem than the one stated.',
  },
  {
    id: asCriterionId('spec-completeness'),
    name: 'Specification Completeness',
    description:
      'Is there enough concrete detail — named types, responsibilities, relationships, trade-offs — to review this as a design?',
    weight: 10,
    maxScore: 5,
    owner: 'deterministic',
    evaluatorHint:
      'Structural completeness only: required sections present, every declared type carries a responsibility, enough types and relationships to constitute a design.',
  },
  {
    id: asCriterionId('class-responsibilities'),
    name: 'Class Responsibilities',
    description:
      'Does each class own one clear job, and is that job the right job for that class to own?',
    weight: 18,
    maxScore: 5,
    owner: 'llm',
    evaluatorHint:
      'Judge cohesion of each stated responsibility. Flag classes doing several unrelated things, manager/handler classes with vague remits, and anaemic data holders whose behaviour has leaked elsewhere. Quote the specific responsibility text you are judging.',
  },
  {
    id: asCriterionId('coupling-cohesion'),
    name: 'Coupling & Cohesion',
    description:
      'Are the relationships between types deliberate and minimal, or does everything know about everything?',
    weight: 14,
    maxScore: 5,
    owner: 'llm',
    evaluatorHint:
      'Assess the relationship graph as a design, not as syntax. Look for hub types everything depends on, bidirectional coupling, and dependencies pointing at concretions where an abstraction exists. Reward dependencies that point toward stable abstractions.',
  },
  {
    id: asCriterionId('structural-integrity'),
    name: 'Structural Integrity',
    description:
      'Is the design internally consistent — do relationships connect real types, are abstractions actually implemented, is inheritance acyclic?',
    weight: 10,
    maxScore: 5,
    owner: 'deterministic',
    evaluatorHint:
      'Graph checks: dangling relationship endpoints, orphaned types, inheritance cycles, interfaces nothing implements.',
  },
  {
    id: asCriterionId('abstraction-and-patterns'),
    name: 'Abstraction & Patterns',
    description:
      'Are interfaces and patterns used where variation genuinely exists — and absent where they would only add ceremony?',
    weight: 14,
    maxScore: 5,
    owner: 'llm',
    evaluatorHint:
      'Reward abstractions introduced at real variation points and named patterns whose use is justified. Penalise pattern-dropping with no stated reason, and equally penalise a missing seam where the problem statement clearly signals variation. An interface with exactly one implementation and no anticipated second one is a cost, not a virtue.',
  },
  {
    id: asCriterionId('extensibility'),
    name: 'Extensibility',
    description:
      'When the stated change arrives, is the blast radius small and is the learner able to say precisely what they would touch?',
    weight: 16,
    maxScore: 5,
    owner: 'llm',
    evaluatorHint:
      'Evaluate the change-scenario answer against the design actually submitted. A strong answer names specific types it would add or modify and explains why the rest is unaffected. A weak answer is generic ("I would just add a new class") or describes changes to types that do not exist in the design.',
  },
  {
    id: asCriterionId('scenario-engagement'),
    name: 'Change-Scenario Engagement',
    description:
      'Did the learner actually answer the change scenario in terms of their own design?',
    weight: 6,
    maxScore: 5,
    owner: 'deterministic',
    evaluatorHint:
      'Mechanical check only: an answer exists, has substance, and references type names that appear in the submitted design.',
  },
];

export const CORE_RUBRIC = new Rubric({
  id: asRubricId('lld-core'),
  version: 1,
  name: 'Core LLD Rubric',
  criteria: CRITERIA,
});

export const CORE_RUBRIC_ID = CORE_RUBRIC.id;
