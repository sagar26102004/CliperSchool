# LLD Practice Platform

A focused practice loop for Low-Level Design: **choose a problem → design → submit → get feedback you
can interrogate → review → try again.**

The bet: LLD feedback is only useful if it is *trustworthy* and *cumulative*. So every score is
anchored to a fixed rubric and quoted evidence from your own submission — there is no reference
solution anywhere in the system — and history names the weakness that keeps coming back.

- [`RESEARCH.md`](RESEARCH.md) — the learner problem, what exists today, and the gap
- [`DESIGN.md`](DESIGN.md) — MVP, classes, evaluation approach, both change tests, trade-offs
- [`AI_USAGE.md`](AI_USAGE.md) — where AI helped, and what I rejected

## Run it

Requires **Node 22.5+** (developed on Node 24).

```bash
npm install
npm test        # 67 tests, all offline
npm run dev     # http://localhost:3000
```

It runs **fully offline by default** — no API key needed. The AI evaluator falls back to a
deterministic stub so the whole loop is demonstrable on a clone.

> If port 3000 is taken, use `PORT=3100 npm run dev`.

### Using real Claude

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run dev     # optionally ANTHROPIC_MODEL=claude-sonnet-5
```

No code change. `buildContainer` picks `AnthropicClient` over `StubLlmClient` when the key is present;
nothing in the evaluation layer knows which one it has.

### Demonstrating the failure paths

The reliability behaviour is switchable, so you can watch it rather than take my word for it:

```bash
LLM_FAILURE_MODE=throw npm run dev                     # partial evaluation + provisional score
LLM_FAILURE_MODE=malformed npm run dev                 # bad JSON → repair retry → degrade
LLM_FAILURE_MODE=slow npm run dev                      # watch Submitted → Evaluating → Completed
LLM_FAILURE_MODE=throw LLM_REQUIRED=true npm run dev   # hard Failed state + working Retry button
```

## A five-minute tour

1. **`/problems`** — four problems, with your attempt count and best score on each.
2. **Open Parking Lot.** Requirements, constraints, out-of-scope, **and the full rubric before you
   start** — including which criteria are judged by AI and which by automated checks. Pick a change
   scenario.
3. **Write the design.** Assumptions, types with one responsibility each, relationships, trade-offs,
   and your answer to the change scenario.
4. **Submit.** The request returns immediately; the page shows `Submitted → Evaluating` and polls.
5. **Read the feedback.** A weighted score with its coverage, three ranked focus areas, then every
   criterion with the **evidence quoted from your submission**, one concern, one suggestion, its
   confidence, and which evaluator produced it.
6. **Try again.** The form is pre-filled with your previous spec — change what the feedback pointed at.
7. **`/history`** — every attempt, per-problem trend, score deltas, and *"this keeps coming back"*.

## How evaluation works

Two evaluators run concurrently and write into the **same** record shape
(`criterion → score → evidence → concern → suggestion → confidence`):

- **Deterministic rules** own structure — required fields, responsibilities stated, dangling
  relationships, orphan types, inheritance cycles, unimplemented abstractions, concept coverage,
  and whether the change-scenario answer names types that actually exist in the design. Free, instant,
  identical every run, incapable of inventing a quote.
- **The LLM** owns judgement — responsibility cohesion, coupling, whether abstractions earn their
  cost, quality of reasoning, and extensibility. Constrained by a fixed rubric, strict JSON schema,
  `temperature: 0`, and a requirement that evidence be quoted verbatim.

`OwnerWinsMergePolicy` resolves each criterion to the source the rubric declares owns it — never an
average, because averaging a definite structural finding with a soft opinion produces a number true of
neither.

Full reasoning in [`DESIGN.md`](DESIGN.md).

## Project layout

```
src/
  domain/         pure — no I/O, no framework imports
    attempt/      Attempt (guarded state machine)
    submission/   Submission (immutable) · SubmissionContent (union) · DesignGraph (projection)
    evaluation/   Evaluation (lifecycle + scoring) · CriterionResult
    rubric/       Rubric · RubricCriterion (declares its owner)
    problem/      Problem · ChangeScenario
    feedback/     FeedbackReport (derived, never stored)
  evaluation/     Evaluator interface · Deterministic · Llm · Composite · MergePolicy · rules/ · prompts/
  application/    AttemptService · EvaluationOrchestrator · JobQueue · ProgressService
  infra/          repositories · LlmClient (Anthropic | Stub) · clock/ids (injected)
  web/            Express routes + server-rendered views
  seed/           4 problems + the rubric, as data
  container.ts    the composition root — every implementation choice lives here
tests/            67 unit + integration tests
```

## Tests

```bash
npm test
```

67 tests. Beyond the happy path they cover the failure and edge cases specifically:

- illegal `Attempt` transitions (double submit, complete-before-submit, reopen a completed attempt)
- duplicate submit → same evaluation, queue not re-entered; order-independent content hashing
- malformed model JSON → repair retry → degrade to deterministic-only, evaluation still completes
- transport failure → no wasted repair attempt; queue retries transparently; exhausted retries →
  `Failed` with the submission intact → retry succeeds
- the model inventing a criterion, inflating a score past `maxScore`, or returning impossible confidence
- empty and structurally broken designs (dangling edges, orphans, inheritance cycles) — no crashes
- **two different but valid designs score comparably** — the guard against reference-solution bias
- merge policy: deterministic wins structural criteria, LLM wins judgement criteria, human overrides
- partial evaluations report their rubric coverage and never anchor a score trend

## Known limitations

Stated plainly rather than buried:

- **Storage is in-memory.** Restarting the process loses attempt history. The repository interfaces
  live in the domain, so SQLite is a composition-root swap — it just was not where the time was best
  spent. This is the first thing I would fix.
- **No authentication.** One fixed learner id. Every service already takes a `LearnerId` and would
  work unchanged behind a real session.
- **The offline stub is a demo device, not a reviewer.** Its judgements are heuristics over the
  submission. They move with design quality enough to make the loop meaningful offline, but real
  feedback needs a real key.
- **The rubric is uncalibrated** — weights and thresholds are reasoned, not measured against real
  learner submissions.
- **Concept coverage is keyword-based.** Softened with a score floor and low confidence so an unusual
  vocabulary is not punished, but not eliminated.
- **One submission format.** Diagrams and code are designed for (see change test A in `DESIGN.md`)
  but not implemented.
- **No learner has used this.** The central bet is untested.

## Scaling, briefly

The first component to split out is the **evaluation worker** — the slow, bursty, failure-prone part.
It already talks to the rest of the system only through the repository interfaces and the `JobQueue`
interface, so moving it out is a composition-root change plus a durable queue and a real database. No
domain type moves. Second would be caching evaluations by `contentHash` across learners, since
identical designs are common on a small problem set and each cache hit is a saved model call.
