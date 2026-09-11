import express, { type NextFunction, type Request, type Response } from 'express';
import type { Container } from '../container.js';
import {
  DomainError,
  NotFoundError,
  ValidationError,
} from '../domain/errors.js';
import {
  asAttemptId,
  asEvaluationId,
  asLearnerId,
  asProblemId,
  asScenarioId,
} from '../domain/ids.js';
import { FeedbackReport } from '../domain/feedback/FeedbackReport.js';
import type {
  DeclaredType,
  DesignSpecContent,
  Relationship,
  RelationshipType,
} from '../domain/submission/SubmissionContent.js';
import {
  attemptFormPage,
  attemptStatusPage,
  historyPage,
  problemDetailPage,
  problemListPage,
} from './views/pages.js';
import { escapeHtml, layout } from './views/layout.js';

/**
 * There is no sign-in in the prototype.
 *
 * Authentication is orthogonal to everything the assignment is about, and a
 * login form would have added a page of code that demonstrates nothing. A fixed
 * learner id keeps every service honest — they all take a `LearnerId` and would
 * work unchanged behind a real session — while costing nothing to read.
 */
const DEMO_LEARNER = asLearnerId('learner_demo');

export function createServer(app: Container) {
  const server = express();
  server.use(express.urlencoded({ extended: true }));

  server.get('/', (_req, res) => res.redirect('/problems'));

  server.get(
    '/problems',
    wrap(async (_req, res) => {
      const [problems, progress] = await Promise.all([
        app.problems.listAll(),
        app.progressService.forLearner(DEMO_LEARNER),
      ]);
      res.send(problemListPage({ problems, progress }));
    }),
  );

  server.get(
    '/problems/:slug',
    wrap(async (req, res) => {
      const problem = await app.problems.findBySlug(String(req.params.slug));
      if (!problem) throw new NotFoundError('Problem', String(req.params.slug));

      const rubric = await app.rubrics.findById(problem.rubricId);
      if (!rubric) throw new NotFoundError('Rubric', problem.rubricId);

      const history = await app.progressService.forLearnerAndProblem(
        DEMO_LEARNER,
        problem.id,
      );
      res.send(problemDetailPage({ problem, rubric, history }));
    }),
  );

  /** Starts an attempt, then redirects to its form. */
  server.post(
    '/attempts',
    wrap(async (req, res) => {
      const problemId = asProblemId(String(req.body.problemId ?? ''));
      const scenarioId = String(req.body.scenarioId ?? '');
      const attempt = await app.attemptService.startAttempt(DEMO_LEARNER, problemId);
      res.redirect(`/attempts/${attempt.id}/edit?scenarioId=${encodeURIComponent(scenarioId)}`);
    }),
  );

  server.get(
    '/attempts/:id/edit',
    wrap(async (req, res) => {
      const attempt = await app.attemptService.getAttempt(asAttemptId(String(req.params.id)));
      const problem = await app.problems.findById(attempt.problemId);
      if (!problem) throw new NotFoundError('Problem', attempt.problemId);

      if (!attempt.isEditable) return res.redirect(`/attempts/${attempt.id}`);

      const scenarioId =
        String(req.query.scenarioId ?? '') || String(problem.changeScenarios[0]?.id ?? '');

      // Pre-filling from the last submission is what makes iterating cheap:
      // changing two responsibilities should not mean retyping a whole design.
      const prefill = await app.progressService.lastSubmittedContentFor(
        DEMO_LEARNER,
        problem.id,
      );

      res.send(attemptFormPage({ problem, attempt, scenarioId, prefill }));
    }),
  );

  server.post(
    '/attempts/:id/submit',
    wrap(async (req, res) => {
      const attemptId = asAttemptId(String(req.params.id));
      const attempt = await app.attemptService.getAttempt(attemptId);
      const problem = await app.problems.findById(attempt.problemId);
      if (!problem) throw new NotFoundError('Problem', attempt.problemId);

      const scenarioId = String(req.body.scenarioId ?? problem.changeScenarios[0]?.id ?? '');
      const content = parseDesignSpec(req.body, scenarioId);

      try {
        await app.attemptService.submit({ attemptId, content });
      } catch (error) {
        // Validation failures re-render the form with what they typed intact.
        // Losing a half-written design to a missing field would be its own
        // argument against ever attempting a second time.
        if (error instanceof ValidationError) {
          return res.status(400).send(
            attemptFormPage({
              problem,
              attempt,
              scenarioId,
              prefill: content,
              errors: error.issues.length > 0 ? error.issues : [error.message],
            }),
          );
        }
        throw error;
      }

      res.redirect(`/attempts/${attemptId}`);
    }),
  );

  server.get(
    '/attempts/:id',
    wrap(async (req, res) => {
      const attemptId = asAttemptId(String(req.params.id));
      const attempt = await app.attemptService.getAttempt(attemptId);
      const problem = await app.problems.findById(attempt.problemId);
      if (!problem) throw new NotFoundError('Problem', attempt.problemId);

      const evaluation = await app.attemptService.getEvaluation(attemptId);
      const rubric = evaluation
        ? await app.rubrics.findByVersionTag(evaluation.rubricVersionTag)
        : await app.rubrics.findById(problem.rubricId);
      if (!rubric) throw new NotFoundError('Rubric', problem.rubricId);

      const report =
        evaluation && evaluation.status === 'Completed'
          ? FeedbackReport.from(evaluation, rubric)
          : null;

      res.send(attemptStatusPage({ problem, attempt, evaluation, report, rubric }));
    }),
  );

  /**
   * Status endpoint for polling.
   *
   * The page itself uses a meta refresh so the prototype needs no client-side
   * JavaScript, but this exists because it is the shape a real client would
   * poll, and it keeps the async design visible to a reviewer.
   */
  server.get(
    '/api/attempts/:id/status',
    wrap(async (req, res) => {
      const attemptId = asAttemptId(String(req.params.id));
      const attempt = await app.attemptService.getAttempt(attemptId);
      const evaluation = await app.attemptService.getEvaluation(attemptId);

      res.json({
        attemptId: attempt.id,
        attemptStatus: attempt.status,
        evaluationStatus: evaluation?.status ?? null,
        partial: evaluation?.partial ?? false,
        failureReason: evaluation?.failureReason ?? attempt.failureReason,
        done: attempt.isTerminal,
      });
    }),
  );

  server.post(
    '/evaluations/:id/retry',
    wrap(async (req, res) => {
      const evaluationId = asEvaluationId(String(req.params.id));
      const evaluation = await app.orchestrator.retryEvaluation(evaluationId);
      const submission = await app.submissions.findById(evaluation.submissionId);
      res.redirect(submission ? `/attempts/${submission.attemptId}` : '/history');
    }),
  );

  server.get(
    '/history',
    wrap(async (_req, res) => {
      res.send(historyPage(await app.progressService.forLearner(DEMO_LEARNER)));
    }),
  );

  server.use(errorHandler);
  return server;
}

/**
 * Parses the flat form body into a `DesignSpecContent`.
 *
 * Kept in the web layer on purpose: the shape of an HTML form is a transport
 * detail, and the domain should never learn that `type_name_3` was ever a
 * thing. A future JSON API or a diagram upload builds the same domain object a
 * different way, and nothing below this line changes.
 */
function parseDesignSpec(body: Record<string, unknown>, scenarioId: string): DesignSpecContent {
  const types: DeclaredType[] = [];
  const relationships: Relationship[] = [];

  for (let i = 0; i < 40; i += 1) {
    const name = str(body[`type_name_${i}`]);
    if (!name) continue;
    types.push({
      name,
      kind: (str(body[`type_kind_${i}`]) || 'class') as DeclaredType['kind'],
      responsibility: str(body[`type_resp_${i}`]),
      attributes: [],
      methods: [],
    });
  }

  for (let i = 0; i < 40; i += 1) {
    const from = str(body[`rel_from_${i}`]);
    const to = str(body[`rel_to_${i}`]);
    if (!from || !to) continue;
    relationships.push({
      from,
      to,
      type: (str(body[`rel_type_${i}`]) || 'uses') as RelationshipType,
    });
  }

  const scenarioAnswer = str(body['scenarioAnswer']);

  return {
    format: 'design-spec',
    assumptions: str(body['assumptions'])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    types,
    relationships,
    tradeoffs: str(body['tradeoffs']),
    changeScenarioAnswers: scenarioAnswer
      ? [{ scenarioId: asScenarioId(scenarioId), text: scenarioAnswer }]
      : [],
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

type Handler = (req: Request, res: Response) => Promise<unknown>;

/** Forwards async rejections to the error handler instead of hanging the request. */
function wrap(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

/**
 * Maps domain errors to HTTP.
 *
 * This is the only place in the codebase that knows what a status code is,
 * which is what lets the domain stay framework-free.
 */
function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status =
    error instanceof NotFoundError
      ? 404
      : error instanceof ValidationError
        ? 400
        : error instanceof DomainError
          ? 409
          : 500;

  if (status === 500) console.error(error);

  const message = error instanceof Error ? error.message : 'Unexpected error.';
  res.status(status).send(
    layout({
      title: 'Something went wrong',
      body: `<h1>${status}</h1>
<div class="banner bad"><strong>${escapeHtml(message)}</strong></div>
<a class="btn" href="/problems">Back to problems</a>`,
    }),
  );
}
