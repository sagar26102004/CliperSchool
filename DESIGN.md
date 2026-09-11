# Design note

## The MVP in one paragraph

A learner picks one of four LLD problems, reads the requirements and the rubric they will be judged
against, picks a change scenario, and writes their design as a **structured spec** — assumptions,
named types each with one responsibility, relationships, trade-offs, and an answer to the change
scenario. Submitting saves the spec immediately and queues an evaluation. Two evaluators run: a set
of **deterministic rules** that check structure, and an **LLM evaluator** that judges the things
structure cannot reveal. Both emit the same per-criterion record, which are merged by an explicit
policy into one `Evaluation`. The learner sees a score they can interrogate — every criterion shows
the evidence quoted from their own submission, the concern, one suggestion, and how confident that row
is. History keeps every attempt, shows the per-problem score trend, and names the criterion that
keeps scoring weakly across attempts.

## User flow

```
/problems                 pick a problem  (shows attempts + best score per problem)
   ↓
/problems/:slug           requirements, constraints, out-of-scope, THE RUBRIC, pick a change scenario
   ↓  POST /attempts      → creates Attempt #N  (Draft)
/attempts/:id/edit        structured design form (pre-filled from your last submission)
   ↓  POST .../submit     → Submission persisted → Attempt (Submitted) → Evaluation (Queued) → job enqueued
/attempts/:id             Submitted → Evaluating (page polls) → Completed | Failed
   ↓
                          feedback: score + coverage, 3 focus areas, criterion-by-criterion evidence
   ↓  "Try again"         → Attempt #N+1, form pre-filled with the previous spec
/history                  every attempt, per-problem trend, "this keeps coming back"
```

The submit request never waits on the model. It returns as soon as the submission is durable.

## Domain model

```
Problem ──has──▶ ChangeScenario                     Rubric ──has──▶ RubricCriterion
   │                                                   │                  │ owner: deterministic | llm
   │ rubricId ─────────────────────────────────────────┘                  │
   ▼
Attempt (state machine)  ──1:1──▶ Submission (immutable)  ──1:1──▶ Evaluation
   Draft→Submitted→Evaluating→Completed|Failed   contentHash        rubricVersionTag
   attemptNumber                                 SubmissionContent  CriterionResult[]
                                                       │                  │
                                                       ▼                  ▼
                                                  DesignGraph      FeedbackReport (derived)
```

### The classes that carry weight, and why

**`Attempt`** — owns the lifecycle and refuses illegal transitions with `InvalidStateTransitionError`.
`Submitted` is deliberately a separate state from `Evaluating`: the gap between them is exactly the
window where the learner's work is safe but no evaluator has touched it, which is what makes "you
never lose work when the model falls over" true rather than aspirational. `Completed` is terminal —
"try again" creates a *new* Attempt with `attemptNumber + 1`, because comparing attempt N to N−1 is
the product. `Failed → Evaluating` is legal, so an outage costs a click.

**`Submission`** — immutable, frozen at construction, persisted *before* evaluation begins. Immutable
because feedback quotes it as evidence, and evidence that can be edited afterwards is not evidence.
Carries a `contentHash` over an order-independent serialisation, which is the idempotency key.

**`SubmissionContent`** — a discriminated union tagged by `format`. This is the seam for change
test A (below).

**`DesignGraph`** — a format-neutral projection of "the design being proposed": types, edges,
assumptions, trade-offs, scenario answers, plus graph queries (`danglingRelationships`,
`orphanTypes`, `findInheritanceCycles`, `unimplementedAbstractions`). **Rules read this, never the
raw content.** It is the single most load-bearing abstraction in the codebase.

**`Rubric` / `RubricCriterion`** — versioned, and each criterion declares an `owner`. The owner field
is the whole evaluation design in one line: it says, per dimension, whether this is answerable
mechanically or genuinely needs judgement.

**`Evaluation`** — owns *scoring*: versioned, auditable, never rewritten. Records
`rubricVersionTag`, so feedback from three weeks ago stays explainable after the rubric is retuned.
Computes the weighted score over the criteria that were **actually assessed**, skipping unscored ones
rather than treating them as zeros.

**`CriterionResult`** — the atom of all feedback:
`criterionId → score → evidence[] → concern → suggestion → confidence → source`. Deterministic rules,
the LLM, and a hypothetical human reviewer all emit exactly this. That shared shape is what makes
them mergeable, comparable, and renderable by one template.

**`FeedbackReport`** — **derived on read, never stored.** `Evaluation` owns scoring; this owns
*communication* — top focus areas, strengths, low-confidence rows, coverage, and the cross-attempt
recurring weakness. Storing it would duplicate truth and freeze the wording. Because it is derived,
the phrasing and prioritisation of feedback can be improved at any time without invalidating a single
historical score.

## Evaluation approach

### The deterministic / LLM split

The rubric assigns every criterion an owner. This is the answer to "which parts should be
deterministic, and which benefit from an LLM":

| Criterion | Weight | Owner | Why that owner |
|---|---|---|---|
| Requirement Understanding | 12 | LLM | Requires reading intent, not matching strings |
| Specification Completeness | 10 | deterministic | Fields present, responsibilities stated, concepts covered |
| Class Responsibilities | 18 | LLM | Cohesion is a judgement; no regex detects a vague remit |
| Coupling & Cohesion | 14 | LLM | Requires reasoning about *why* a dependency exists |
| Structural Integrity | 10 | deterministic | Graph properties are definitionally checkable |
| Abstraction & Patterns | 14 | LLM | Whether a seam earns its cost is a judgement call |
| Extensibility | 16 | LLM | Requires evaluating an argument against a design |
| Change-Scenario Engagement | 6 | deterministic | "Does the answer exist, have substance, and name real types" |

The two heaviest criteria are **Class Responsibilities** and **Extensibility** — the two things that
actually distinguish LLD skill, and the two a learner is least able to self-assess.

Why give structure to code rather than the model: **an LLM asked whether a relationship points at a
declared type will usually say yes, because it infers what was meant.** Inference is precisely the
wrong behaviour for a check whose entire value is catching what the learner forgot to write down.
Deterministic rules are also free, instant, identical on every run, and incapable of inventing a
quote.

### Making the model's output usable

The brief warns against asking "is this a good design?" and taking a number. The defences, in order:

1. **Only LLM-owned criteria are sent.** The model is never asked to adjudicate a mechanical check.
2. **A fixed schema is demanded** — one record per criterion, validated with zod at the boundary.
3. **Evidence must be quoted from the submission.** A hallucinated critique becomes expensive to
   produce and visible when it lands with no supporting quote.
4. **`temperature: 0`**, so the same design cannot receive two different scores.
5. **The system prompt forbids reference-solution comparison explicitly** and names the problem's
   out-of-scope items so the model does not deduct for them.
6. **Everything is re-validated after parsing**: invented criteria are discarded, scores clamped to
   the criterion's `maxScore`, confidence clamped to 0..1.
7. **One bounded repair retry** on malformed JSON, then degrade. A model that fails a schema twice is
   not going to be fixed by a third paid call.

### Merging: `OwnerWinsMergePolicy`

Each criterion is decided by the source the rubric says owns it. Averaging was rejected deliberately:
blending a definite structural finding ("this relationship points at a type you never declared") with
the model's softer read of the same criterion produces a number true of neither and destroys the one
property that makes the deterministic half worth having. The losing evaluator's concern is kept as an
appended second opinion rather than discarded, so the learner loses nothing.

Fallback order when the owner is silent: `human → deterministic → llm`.

## The two change tests

### A. Today text, later a class diagram

`SubmissionContent` is a union tagged by `format`, and — more importantly — **no rule reads it.**
Rules read `DesignGraph`. Supporting diagrams is:

1. add a `ClassDiagramContent` arm to the union,
2. write a `ClassDiagramAdapter` that parses mermaid into `DesignGraph`,
3. `register()` it on the `AdapterRegistry`.

Every existing deterministic rule then works on diagrams **without one of them being edited**, because
they were written against the projection rather than the format. `Attempt`, `Submission`,
`Evaluation`, the orchestrator, the repositories and the history view never look inside the content,
so none of them change. The prompt builder also builds from `DesignGraph`, so the model sees diagrams
in the same shape it already understands.

### B. Later you add a rule-based evaluator or human review

`EvaluationOrchestrator` holds one `Evaluator` and calls `evaluate(context)`. It has no idea whether
a result came from a regex, a language model, or a senior engineer with an opinion. Adding human
review is:

1. `class HumanReviewEvaluator implements Evaluator` emitting `CriterionResult`s with `source: 'human'`,
2. add it to the `CompositeEvaluator` member list in `container.ts`.

`OwnerWinsMergePolicy` already ranks `human` above both machines in its precedence list, and a test
already asserts that. Nothing in the practice flow, the routes, the state machines or the UI changes.
`EvaluationContext` is a parameter object precisely so a future evaluator needing extra input (say,
the learner's previous evaluations) adds an optional field rather than breaking every signature.

## Reliability: slow and failing evaluation

Deliberately kept to what a single process needs — no queues-as-a-service, no workers, no retry
storms.

- **Submit never blocks on the model.** The submission is persisted, an `Evaluation` row is written in
  `Queued`, a job is enqueued, and the request returns. The page polls.
- **Order matters and is enforced:** submission durable → evaluation record durable → job enqueued.
  There is no window where a learner has submitted and the system has no record.
- **Idempotency:** submitting identical content to the same attempt returns the existing evaluation.
  A double-click, a refresh, or a retried request cannot produce two scores for one design. The hash
  is order-independent, so a re-serialised form body still deduplicates.
- **Bounded retry with backoff** inside `InProcessJobQueue`, plus a per-job `AbortSignal` timeout that
  the LLM client honours, so a hung model cannot pin a worker.
- **Graceful degradation.** Composite members are marked `required` or not. The deterministic
  evaluator is required — if structural checks cannot run, the platform is broken. The LLM evaluator
  is optional, so an outage produces a **partial** evaluation: real deterministic feedback, an honest
  banner naming what did not run, and the score marked *provisional* with the share of rubric weight
  actually assessed. (Set `LLM_REQUIRED=true` to prefer hard failure instead.)
- **Failure is visible and recoverable.** Exhausted retries move both Evaluation and Attempt to
  `Failed` with the reason attached, and a **Retry evaluation** button re-queues against the
  already-saved submission. A learner staring at a spinner forever is the worst outcome available.

**Partial scores never anchor a trend.** `ProgressService` skips partial evaluations when computing
deltas — they get no delta and do not become the baseline — because comparing a partial score against
a complete one measures the outage, not the learner.

## Key trade-offs

| Decision | Chose | Cost accepted | Why |
|---|---|---|---|
| Submission format | Structured spec | No code execution, no diagrams | Structure is what makes deterministic checks real and LLM output consistent; code proves implementation, not design intent, and needs a sandbox |
| Persistence | In-memory behind repository interfaces | History resets on restart | Repository interfaces are in the domain, so SQLite is a composition-root swap; the hours went to evaluation instead. Stated plainly, not hidden |
| Merge policy | Owner wins | A criterion is decided by one source | Averaging produces a number true of neither and destroys reproducibility |
| Concept coverage | Soft, capped, low confidence | Can miss a genuinely absent concept | Hard-scoring it would recreate reference-solution grading, the exact flaw the product exists to avoid |
| UI | Server-rendered, no build step | Plain-looking, meta-refresh polling | The rubric weights domain design at 25% and implementation at 10% |
| Auth | None; one fixed learner id | Not multi-user | Orthogonal to everything being assessed; services all take a `LearnerId` and would work unchanged behind a session |
| Queue | In-process | Dies with the process | The brief explicitly warns against a distributed-systems detour |

## If it grew

The first thing to split out is the **evaluation worker**. It is the slow, bursty, failure-prone,
cost-incurring part, and it is already isolated: it talks to the rest of the system only through the
repository interfaces and the `JobQueue` interface. Replacing `InProcessJobQueue` with a durable queue
and running `EvaluationOrchestrator.runEvaluation` in a separate process is a composition-root change
plus a real database — no domain type moves. Everything else (problems, attempts, history) is cheap
reads that a single process handles for a long time.

The second would be caching evaluations by `contentHash` **across** attempts and learners, since
identical designs are common on a small problem set and each avoided evaluation is a saved model call.

## What I would fix first

- **In-memory persistence** is the honest top of the list. The interfaces exist; the implementation
  is an afternoon.
- **The stub's judgements are crude.** They move with design quality enough to make the demo
  meaningful, but they are heuristics, not review. With a real key the `AnthropicClient` path takes
  over unchanged.
- **The rubric is uncalibrated.** Weights and thresholds are reasoned, not measured against real
  learner submissions.
- **Concept coverage still leans on keywords.** A design using entirely different vocabulary loses a
  little unfairly; the floor and low confidence limit the damage but do not eliminate it.
- **No learner has used it.** The core bet — that evidence-anchored rubric feedback beats a
  conversational verdict — is well-motivated and untested.
