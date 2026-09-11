# Research note

## The learner problem

LLD practice is easy to start and very hard to finish well. A learner can sit down with "design a
parking lot", produce eight classes in half an hour, and have no reliable way to answer the only
question that matters: *is this good?*

That difficulty is structural, not a lack of effort:

- **There is no single correct answer.** Two competent designs for the same problem can share almost
  no class names. So a learner cannot self-check by comparison the way they can with an algorithm
  problem that either returns the right array or does not.
- **The failure modes are invisible from the inside.** A god class does not announce itself. Neither
  does a missing seam — the design looks fine right up until requirements change, which never happens
  during practice.
- **Feedback, when it exists, arrives once and is not connected to anything.** A learner told their
  responsibilities were unclear in January and again in March has usually not noticed it was the same
  sentence.
- **The quality of a design lives in reasoning that is never written down.** Why *this* abstraction,
  what it cost, what was rejected. A class list captures none of it, and a reviewer cannot evaluate
  a decision they cannot see.

The consequence is that most LLD practice is unverified repetition. The learner gets more fluent at
producing class diagrams without getting better at design.

## What exists today

I looked at the tools a learner actually lands on when they search for LLD practice.

| Tool | How practice works | What feedback looks like | Gap |
|---|---|---|---|
| [Hello Interview](https://www.hellointerview.com/practice/low-level-design) | Guided walkthrough of common problems | Guided prompts and personalised feedback within a structured lesson | Strong as instruction; the learner is following a path rather than being assessed on a design they own |
| [LLD Problems](https://www.lldproblems.com/) | Curated problems with solutions, class diagrams, an AI "Solution Architect" sketch mode, and chat-based mock interviews | Reference solutions and code; conversational interview simulation | Two opposite failure modes: a reference solution implies one right answer, and a free-form chat produces feedback that is inconsistent between runs and cannot be cited or compared |
| [Low Level Design Mastery](https://www.lowleveldesignmastery.com/) | Playground with solutions in six languages | AI-powered *code* review | Only works once you have written code. Reviews the implementation, not the design intent — and most LLD interview failure happens before any code exists |
| [CodeZym](https://codezym.com/) | Machine-coding practice of LLD problems using design patterns | Correctness of the coded solution against tests | Measures whether the program works, which is close to orthogonal to whether the design is good |
| [awesome-low-level-design](https://github.com/ashishps1/awesome-low-level-design) (and similar repos) | A curated problem list with worked solutions | None — it is reading material | Zero feedback loop; the learner grades themselves, which is the original problem |

### What the survey actually shows

Three patterns, each with the same underlying flaw.

1. **Reference-solution tools** answer "is this good?" with "is this the same?". That penalises
   originality and teaches learners to reproduce a remembered answer — the exact habit that fails in
   a real interview when the interviewer changes a requirement.
2. **Chat-simulation tools** give feedback that is fluent, unrepeatable and unciteable. Ask twice,
   get two different verdicts, neither anchored to anything the learner can point at.
3. **Code-review tools** evaluate the artefact that is cheapest to check rather than the one that
   carries the skill. Coupling and responsibility placement are decided before the first line of code.

And across all of them, one absence: **nothing treats a sequence of attempts as connected.** Every
tool grades attempt N in isolation. None can say "this is the third time your abstractions were
hard-wired at the point the problem told you would vary."

## Where that leaves the product

The gap worth building into is not more problems, better UI, or a smarter model. It is making
feedback **trustworthy and cumulative**. Concretely, four decisions follow from the research:

**1. Take the submission as structure, not prose.**
Free-form text cannot be checked mechanically and makes model judgements noticeably less consistent.
A structured design spec — assumptions, named types each with one responsibility, relationships,
trade-offs — gives both halves of evaluation something to grip. It also does quiet pedagogical work:
a form with one responsibility field per class makes an overloaded class uncomfortable to write down.

**2. Ask a change question at submission time.**
This is the highest-signal field in the product. Any learner can list nouns; the difference between
a design with deliberate seams and one that merely names things only appears when something has to
change. So every problem ships with change scenarios, and answering one is part of submitting.

**3. Score dimensions with evidence, never similarity to an answer key.**
Feedback is a fixed rubric of eight criteria, and every criterion returns
`score → evidence → concern → suggestion → confidence`, where evidence is quoted from the learner's
own submission. A learner can disagree with a score and see exactly what it was based on. There is no
reference solution anywhere in the system.

**4. Split the work by what each half is actually good at.**
Structure, graph integrity, and whether the change scenario was engaged with are checkable
mechanically — free, instant, identical every run, and impossible to hallucinate. Cohesion,
abstraction appropriateness and the quality of reasoning genuinely need judgement. Giving the model
only the second set is what makes its output consistent enough to compare across attempts, which is
what makes the recurring-weakness feature possible at all.

**5. Make history the point, not a log.**
The product's distinguishing feature is the sentence no surveyed tool can produce: *"Class
Responsibilities scored weakly in 3 of your last 4 evaluations."* Because every attempt is scored on
the same versioned rubric, that comparison is meaningful rather than impressionistic. And "try again"
pre-fills the previous submission, because retyping a whole design to change two responsibilities is
enough friction to stop a learner iterating — and iteration is the entire loop.

## Honest limitations of this research

Roughly three hours of desk research on public marketing pages and free tiers. I did not pay for the
paid tiers of any of these products, so my read on their feedback quality comes from their own
descriptions and free surfaces, not from submitting real designs to each. And I have not put this
platform's feedback in front of actual learners — the claim that evidence-anchored rubric feedback
beats a conversational verdict is a well-motivated bet, not a measured result. The first thing I would
want after this prototype is five learners doing three attempts each, and a check on whether the
recurring-weakness callout changes what they do on attempt three.
