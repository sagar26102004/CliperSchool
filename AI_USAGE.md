# AI usage

I used Claude (in Claude Code) throughout: for the competitor scan, as a design sounding board, and to
write code. What follows is the honest version — including the places I overrode it and the places it
caught something I had got wrong.

## 1. Submission format: rejected "support text, code, and diagrams"

**Suggested.** When I described the product, the first proposal was to accept all three submission
formats, with a plug-in parser per format, so the platform could "meet learners where they are."

**Rejected, mostly.** Three formats in two days would have meant three shallow evaluators and no time
for the thing that actually distinguishes the product. Code in particular is a trap: running it needs
a sandbox, and it proves *implementation*, not design intent — most LLD interview failure happens
before any code exists.

**What I kept.** The *extensibility* half of the idea, without the cost. `SubmissionContent` is a
union tagged by `format`, but the real move is that no rule reads it — rules read a `DesignGraph`
projection. So adding diagrams later means writing one adapter, and every existing rule works on
diagrams unchanged. I got the change-test answer without building two formats I could not have done
well. That is change test A in `DESIGN.md`.

## 2. Rubric ownership: took the split, rewrote the boundary

**Suggested.** A sensible-looking first rubric where the LLM scored everything and deterministic
checks acted as a pre-flight gate ("is this submission complete enough to send?").

**Changed.** That makes the deterministic half a bouncer rather than an evaluator, and it wastes its
real advantage. So I inverted it: every criterion declares an `owner`, both evaluators emit the *same*
`CriterionResult` shape, and `OwnerWinsMergePolicy` resolves per criterion.

**The reasoning that settled it** — and I think this is the strongest single argument in the design:
an LLM asked "does this relationship point at a declared type?" will usually say yes, because it
infers what the learner meant. Inference is exactly wrong for a check whose entire value is catching
what the learner *forgot to write down*. Structure goes to code; judgement goes to the model.

I also rejected an early suggestion to **average** the two evaluators' scores per criterion. Blending
a definite structural finding with a soft opinion produces a number true of neither, and throws away
the reproducibility that makes the deterministic half worth having.

## 3. The stub LLM: rejected a fake evaluator, insisted on a fake model

**Suggested.** With no API key in the environment, the proposal was a `StubEvaluator` implementing
`Evaluator` and returning canned `CriterionResult`s directly. Simple, and it would have made the demo
work.

**Rejected.** It would have tested nothing. The parsing, the schema validation, the repair retry and
the degrade-to-deterministic fallback — every failure path — would have been code that had never once
run. Those paths are a third of the reliability story.

**What I built instead.** `StubLlmClient` fakes the *model*: it receives the same prompt, and returns
a string that still has to survive `extractJson` → zod → criterion filtering → score clamping. So the
whole `LlmEvaluator` path is exercised on every offline test run, and `LLM_FAILURE_MODE` injects
`throw` / `malformed` / `slow` / `empty` to drive each failure branch deliberately. The malformed-JSON
and timeout tests are real tests because of this decision.

## 4. AI caught two bugs I had shipped into the tests

Both surfaced from tests I had asked for, and both were real defects rather than bad assertions:

**The scenario-engagement rule scored a two-word answer *better* than a long generic one.** A
too-short answer hit a `continue` that skipped the "does it name your own types?" check, so it took
one penalty instead of two. Penalties now accumulate.

**Rules awarded marks for checks they could not run.** An empty submission passed structural integrity
by vacuous truth — no declared relationships means no dangling ones, so the learner was congratulated
on a design they had not written. Fixed by adding `applicable: false` to `RuleFinding`; inapplicable
findings are excluded from the average instead of scoring full marks, and a criterion where nothing was
assessable now scores zero and says so.

A third came out of the integration tests: `Evaluation` forbade `Running → Running`, so every
queue-level retry died on an `InvalidStateTransitionError` instead of retrying. The transition table
now allows the self-transition, with a comment explaining exactly why it is not an oversight.

## 5. Where my own judgement overrode the code: the provisional score

AI wrote the partial-evaluation banner to spec and it was correct. But when I actually looked at the
rendered page with the model leg failing, the screen read **98.3%** in 30px type above a small
explanatory paragraph. Technically accurate, genuinely misleading: only the three easy structural
criteria had run, and a learner scanning that page would conclude their design was excellent.

That was not a bug any test would have caught — it needed someone to look at the screen. I added
`assessedWeightShare` to `FeedbackReport`, tagged the number **provisional**, and made
`ProgressService` skip partial evaluations when computing score deltas, since comparing a partial
score to a complete one measures the outage rather than the learner.

## How I worked

I made the product and design decisions — submission format, the rubric and its ownership split,
evidence-anchored feedback, deriving `FeedbackReport` rather than storing it, what to cut. AI was
fastest at competitor research, at writing the volume of tests these design claims needed to be
credible rather than rhetorical, and at implementing decisions once made. It was least reliable when
asked what to *build*, where it consistently proposed more surface area than a two-day prototype can
carry well — the rejections above are all variations on that.

The verification is where I trusted it least by policy: every claim in `README.md` about behaviour is
backed by a test or by a screen I looked at, including the three evaluation outcomes (complete,
partial, failed) which I drove in a real browser rather than inferring from green tests.
