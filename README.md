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
npm test        # 98 tests, all offline
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

### Using a free model instead

Anthropic has no free tier. Any provider speaking the OpenAI chat-completions shape works through
`OpenAiCompatibleClient`, which is selected only when `ANTHROPIC_API_KEY` is absent — so setting
both is unambiguous rather than a coin toss.

```bash
GEMINI_API_KEY=... npm run dev                        # Google AI Studio, free, no card
LLM_API_KEY=... LLM_BASE_URL=https://api.groq.com/openai/v1 LLM_MODEL=llama-3.3-70b-versatile npm run dev
```

One adapter covers Gemini, Groq, Mistral, Cerebras, SambaNova and OpenRouter, because base URL and
model are constructor arguments. `GEMINI_API_KEY` alone is enough — it defaults the base URL and
pins `gemini-3.6-flash`, avoiding `gemini-2.5-flash`, which the models endpoint still advertises but
which 404s for keys issued after its retirement.

Worth knowing if you use one: a reasoning model's latency is dominated by thinking and varies a lot
(10-34s observed for this prompt), which is why the job timeout is 90s rather than something tidier.
Free tiers also generally train on what you send — fine for synthetic designs, not for real learner
work.

### Demonstrating the failure paths

The reliability behaviour is switchable, so you can watch it rather than take my word for it:

```bash
LLM_FAILURE_MODE=throw npm run dev                     # partial evaluation + provisional score
LLM_FAILURE_MODE=malformed npm run dev                 # bad JSON → repair retry → degrade
LLM_FAILURE_MODE=slow npm run dev                      # watch Submitted → Evaluating → Completed
LLM_FAILURE_MODE=throw LLM_REQUIRED=true npm run dev   # hard Failed state + working Retry button
```

## Deploy it (Vercel)

The repository is deployable as-is. `src/index.ts` exports the Express app rather than calling
`listen()`, which is exactly the entrypoint Vercel's zero-configuration Express support looks for,
and `vercel.json` pins that preset so the whole app becomes a single Vercel Function. There is no
build command and no output directory to configure.

```bash
npx vercel            # first run links or creates the project, deploys a preview
npx vercel --prod
```

Or import the repository at [vercel.com/new](https://vercel.com/new) and it will deploy on push.

### What you have to provide

**A Redis store — required in practice.** In the Vercel dashboard: **Storage → Marketplace →
Upstash (Redis) → connect to this project**. That injects `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` (or the `KV_REST_API_*` pair — both are accepted), and the composition
root switches to the Redis repositories on its own. A free tier is enough.

Two settings on that store are worth getting right. Keep **eviction off**: under memory pressure it
would silently drop keys, and here a dropped key is a learner's attempt. And put the store in the
**same region as the functions** — `vercel.json` pins those to `bom1`, so a store in `bom1` keeps
the several sequential round trips each request makes on the same continent. Change both together
or neither.

Skipping this does not break the build. It breaks the product, quietly: the in-memory repositories
are correct for one long-lived process, but a serverless host may route the POST that saves a
submission and the GET that renders its feedback to different instances, so a learner's attempt
vanishes between the two. The function log warns loudly when it comes up in that state.

**An Anthropic API key — optional.** Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`) in
**Settings → Environment Variables** to evaluate with real Claude. Without it the deployment runs
the deterministic stub, which is a complete, demonstrable experience — just not an AI-judged one.

Everything else is already handled. Nothing else is required from you.

### What changes on a serverless host

Three substitutions in `container.ts`, all selected from the environment, none of which any domain
type, service or route can observe:

| Concern | Long-lived process | Vercel |
| --- | --- | --- |
| Storage | in-memory repositories | `RedisAttemptRepository` & co. over the Upstash REST client |
| Background work | `InProcessJobQueue` | `ServerlessJobQueue`, handing each job to `waitUntil` |
| Stalled evaluations | cannot really happen | `recoverIfStalled`, re-queued from the read path |

The last one is the interesting one. A platform that can stop a function the moment its time budget
expires can leave an evaluation permanently `Running` with nothing alive to finish it, so the
attempt page and the status endpoint check for that and re-queue it — a waiting learner triggers
their own recovery, with no scheduler to operate. `tests/integration/serverless.test.ts` exercises
all three against an in-process Redis fake.

Local development is unaffected: with no Redis credentials and no `VERCEL` in the environment,
`npm run dev` behaves exactly as before.

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
  infra/          repositories (in-memory | Redis) · LlmClient (Anthropic | OpenAI-compatible | Stub) · clock/ids
  web/            Express routes + server-rendered views
  seed/           4 problems + the rubric, as data
  container.ts    the composition root — every implementation choice lives here
  main.ts         local entry — builds the container and listens on a port
  index.ts        serverless entry — builds the container and exports the app
tests/            98 unit + integration tests
```

## Tests

```bash
npm test
```

98 tests. Beyond the happy path they cover the failure and edge cases specifically:

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
