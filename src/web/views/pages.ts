import { escapeHtml, layout, paragraphs } from './layout.js';
import type { Problem } from '../../domain/problem/Problem.js';
import type { Attempt } from '../../domain/attempt/Attempt.js';
import type { Evaluation } from '../../domain/evaluation/Evaluation.js';
import type { Rubric } from '../../domain/rubric/Rubric.js';
import type {
  DesignSpecContent,
  SubmissionContent,
} from '../../domain/submission/SubmissionContent.js';
import type { FeedbackReport } from '../../domain/feedback/FeedbackReport.js';
import type {
  AttemptHistoryEntry,
  LearnerProgress,
} from '../../application/ProgressService.js';

const DIFFICULTY_TAG: Record<Problem['difficulty'], string> = {
  starter: 'tag good',
  core: 'tag',
  advanced: 'tag warn',
};

export function problemListPage(params: {
  problems: readonly Problem[];
  progress: LearnerProgress;
}): string {
  const attemptsByProblem = new Map(
    params.progress.perProblem.map((p) => [String(p.problem.id), p]),
  );

  const cards = params.problems
    .map((problem) => {
      const stats = attemptsByProblem.get(String(problem.id));
      const badge = stats
        ? `<span class="tag">${stats.attemptCount} attempt${stats.attemptCount === 1 ? '' : 's'}${
            stats.bestScore !== null ? ` · best ${stats.bestScore}%` : ''
          }</span>`
        : '<span class="tag muted">not attempted</span>';

      return `<article class="card">
  <div class="row">
    <h3>${escapeHtml(problem.title)}</h3>
    <span class="${DIFFICULTY_TAG[problem.difficulty]}">${escapeHtml(problem.difficulty)}</span>
  </div>
  <p class="muted small">${escapeHtml(problem.summary)}</p>
  <div class="row">
    <div>${badge} <span class="small muted">~${problem.estimatedMinutes} min</span></div>
    <a class="btn" href="/problems/${escapeHtml(problem.slug)}">Open</a>
  </div>
</article>`;
    })
    .join('');

  const recurring = renderRecurringBanner(params.progress);

  return layout({
    title: 'Problems',
    active: '/problems',
    body: `<h1>Practice low-level design</h1>
<p class="lede">Pick a problem, write the design as a structured spec, and get feedback scored against a fixed rubric — with the evidence it was based on.</p>
${recurring}
<div class="grid two">${cards}</div>`,
  });
}

export function problemDetailPage(params: {
  problem: Problem;
  rubric: Rubric;
  history: readonly AttemptHistoryEntry[];
}): string {
  const { problem, rubric } = params;

  const attempts = params.history.length
    ? `<div class="card tight"><div class="row"><span class="small muted">You have ${params.history.length} attempt(s) at this problem.</span><a class="small" href="/history">See history</a></div></div>`
    : '';

  const scenarioOptions = problem.changeScenarios
    .map(
      (scenario, index) =>
        `<label class="small" style="font-weight:400;margin-bottom:8px">
  <input type="radio" name="scenarioId" value="${escapeHtml(scenario.id)}"${index === 0 ? ' checked' : ''}>
  ${escapeHtml(scenario.prompt)}
</label>`,
    )
    .join('');

  return layout({
    title: problem.title,
    active: '/problems',
    body: `<h1>${escapeHtml(problem.title)}</h1>
<p class="lede">${escapeHtml(problem.summary)}</p>
${attempts}

<div class="card">
  ${paragraphs(problem.statement)}
</div>

<div class="grid two">
  <div class="card">
    <h3>Functional requirements</h3>
    <ul class="plain small">${problem.functionalRequirements.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
  </div>
  <div class="card">
    <h3>Constraints</h3>
    <ul class="plain small">${problem.constraints.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
    <h3 style="margin-top:12px">Out of scope</h3>
    <ul class="plain small muted">${problem.outOfScope.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>
  </div>
</div>

<h2>How this will be scored</h2>
<p class="small muted">The rubric is shown before you start on purpose. There is no reference solution to match — these are the dimensions your design is judged on, and each one comes back with the evidence behind its score.</p>
<div class="card">
  <table>
    <thead><tr><th>Criterion</th><th>Weight</th><th>Judged by</th></tr></thead>
    <tbody>
      ${rubric.criteria
        .map(
          (c) => `<tr>
        <td><strong>${escapeHtml(c.name)}</strong><br><span class="small muted">${escapeHtml(c.description)}</span></td>
        <td>${c.weight}</td>
        <td><span class="tag">${c.owner === 'llm' ? 'AI review' : 'automated check'}</span></td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>
</div>

<h2>Pick your change scenario</h2>
<p class="small muted">You will answer this as part of the submission. It is the part that separates a design with deliberate seams from a list of nouns.</p>
<form class="card" method="post" action="/attempts">
  <input type="hidden" name="problemId" value="${escapeHtml(problem.id)}">
  ${scenarioOptions}
  <button class="btn" type="submit">Start an attempt</button>
</form>`,
  });
}

export function attemptFormPage(params: {
  problem: Problem;
  attempt: Attempt;
  scenarioId: string;
  prefill: SubmissionContent | null;
  errors?: readonly string[];
}): string {
  const { problem, attempt } = params;
  const scenario = problem.changeScenarios.find((s) => String(s.id) === params.scenarioId);
  const prefill =
    params.prefill && params.prefill.format === 'design-spec' ? params.prefill : null;

  const typeRows = padRows(prefill?.types ?? [], 6)
    .map((t, i) => typeRow(i, t))
    .join('');
  const relRows = padRows(prefill?.relationships ?? [], 6)
    .map((r, i) => relationshipRow(i, r))
    .join('');

  const errors = params.errors?.length
    ? `<div class="banner bad"><strong>This cannot be evaluated yet.</strong><ul class="plain small" style="margin-top:6px">${params.errors
        .map((e) => `<li>${escapeHtml(e)}</li>`)
        .join('')}</ul></div>`
    : '';

  const prefillNote = prefill
    ? '<div class="banner info">Pre-filled with your previous submission for this problem. Change what the feedback pointed at rather than starting from scratch.</div>'
    : '';

  return layout({
    title: `Attempt ${attempt.attemptNumber} · ${problem.title}`,
    active: '/problems',
    body: `<h1>${escapeHtml(problem.title)}</h1>
<p class="lede">Attempt ${attempt.attemptNumber} · <a href="/problems/${escapeHtml(problem.slug)}">re-read the problem</a></p>
${errors}
${prefillNote}

<form method="post" action="/attempts/${escapeHtml(attempt.id)}/submit">
  <input type="hidden" name="scenarioId" value="${escapeHtml(params.scenarioId)}">

  <fieldset>
    <legend>Assumptions</legend>
    <div class="hint">The ambiguities you noticed and how you resolved them. One per line. An unstated assumption reads as an unnoticed one.</div>
    <textarea name="assumptions" rows="4" placeholder="A vehicle occupies exactly one spot.">${escapeHtml(
      (prefill?.assumptions ?? []).join('\n'),
    )}</textarea>
  </fieldset>

  <fieldset>
    <legend>Classes and interfaces</legend>
    <div class="hint">One sentence of responsibility each. If the sentence needs an &quot;and&quot;, the type probably needs splitting.</div>
    ${typeRows}
  </fieldset>

  <fieldset>
    <legend>Relationships</legend>
    <div class="hint">How the types connect. Names must match the types above.</div>
    ${relRows}
  </fieldset>

  <fieldset>
    <legend>Trade-offs</legend>
    <div class="hint">What each significant choice costs, and the alternative you rejected.</div>
    <textarea name="tradeoffs" rows="4">${escapeHtml(prefill?.tradeoffs ?? '')}</textarea>
  </fieldset>

  <fieldset>
    <legend>Change scenario</legend>
    <div class="hint">${escapeHtml(scenario?.prompt ?? '')}</div>
    <textarea name="scenarioAnswer" rows="6" placeholder="I would add ... . Untouched: ...">${escapeHtml(
      prefill?.changeScenarioAnswers.find((a) => String(a.scenarioId) === params.scenarioId)
        ?.text ?? '',
    )}</textarea>
  </fieldset>

  <button class="btn" type="submit">Submit for evaluation</button>
</form>`,
  });
}

function padRows<T>(rows: readonly T[], min: number): (T | null)[] {
  const out: (T | null)[] = [...rows];
  while (out.length < min) out.push(null);
  return out;
}

function typeRow(index: number, value: DesignSpecContent['types'][number] | null): string {
  const kinds = ['class', 'interface', 'abstract-class', 'enum'];
  return `<div class="typerow">
  <input type="text" name="type_name_${index}" placeholder="ParkingLot" value="${escapeHtml(value?.name ?? '')}">
  <select name="type_kind_${index}">
    ${kinds
      .map(
        (k) =>
          `<option value="${k}"${(value?.kind ?? 'class') === k ? ' selected' : ''}>${k}</option>`,
      )
      .join('')}
  </select>
  <input type="text" name="type_resp_${index}" placeholder="Responsibility, in one sentence" value="${escapeHtml(
    value?.responsibility ?? '',
  )}">
</div>`;
}

function relationshipRow(
  index: number,
  value: DesignSpecContent['relationships'][number] | null,
): string {
  const types = ['owns', 'uses', 'extends', 'implements', 'creates'];
  return `<div class="relrow">
  <input type="text" name="rel_from_${index}" placeholder="ParkingLot" value="${escapeHtml(value?.from ?? '')}">
  <select name="rel_type_${index}">
    ${types
      .map(
        (t) =>
          `<option value="${t}"${(value?.type ?? 'owns') === t ? ' selected' : ''}>${t}</option>`,
      )
      .join('')}
  </select>
  <input type="text" name="rel_to_${index}" placeholder="Floor" value="${escapeHtml(value?.to ?? '')}">
</div>`;
}

export function attemptStatusPage(params: {
  problem: Problem;
  attempt: Attempt;
  evaluation: Evaluation | null;
  report: FeedbackReport | null;
  rubric: Rubric;
}): string {
  const { attempt, problem, evaluation, report } = params;

  if (attempt.isInFlight) {
    return layout({
      title: 'Evaluating',
      active: '/problems',
      // Polls rather than blocking the submit request, so a slow model never
      // holds an HTTP connection open.
      head: '<meta http-equiv="refresh" content="2">',
      body: `<h1>${escapeHtml(problem.title)}</h1>
<p class="lede">Attempt ${attempt.attemptNumber}</p>
<div class="banner info">
  <strong>${attempt.status === 'Submitted' ? 'Submitted — waiting for an evaluator.' : 'Evaluating your design…'}</strong>
  <p class="small" style="margin:6px 0 0">Your submission is already saved. If evaluation fails you can retry it without retyping anything.</p>
</div>
<p class="small muted">This page refreshes itself every two seconds.</p>`,
    });
  }

  if (attempt.status === 'Failed' || (evaluation && evaluation.status === 'Failed')) {
    return layout({
      title: 'Evaluation failed',
      active: '/problems',
      body: `<h1>${escapeHtml(problem.title)}</h1>
<p class="lede">Attempt ${attempt.attemptNumber}</p>
<div class="banner bad">
  <strong>The evaluator could not finish.</strong>
  <p class="small" style="margin:6px 0 0">${escapeHtml(
    evaluation?.failureReason ?? attempt.failureReason ?? 'Unknown error.',
  )}</p>
  <p class="small" style="margin:6px 0 0">Your submission was saved before evaluation started, so nothing is lost.</p>
</div>
${
  evaluation
    ? `<form method="post" action="/evaluations/${escapeHtml(evaluation.id)}/retry">
  <button class="btn" type="submit">Retry evaluation</button>
</form>`
    : ''
}`,
    });
  }

  if (!evaluation || !report) {
    return layout({
      title: 'Attempt',
      active: '/problems',
      body: `<h1>${escapeHtml(problem.title)}</h1><p class="lede">Nothing submitted yet.</p>`,
    });
  }

  return layout({
    title: `Feedback · ${problem.title}`,
    active: '/problems',
    body: renderFeedback({ problem, attempt, evaluation, report }),
  });
}

function renderFeedback(params: {
  problem: Problem;
  attempt: Attempt;
  evaluation: Evaluation;
  report: FeedbackReport;
}): string {
  const { problem, attempt, evaluation, report } = params;

  const partialBanner = report.partial
    ? `<div class="banner warn">
  <strong>Partial evaluation — treat the score as provisional.</strong>
  <p class="small" style="margin:6px 0 0">${report.degradedReasons.map(escapeHtml).join(' ')}</p>
  <p class="small" style="margin:6px 0 0">Only ${report.assessedWeightShare}% of the rubric&#39;s weight was assessed, and the criteria that did not run are usually the harder ones. A high score here is not comparable with a complete evaluation.</p>
</div>`
    : '';

  const focus = report.focusAreas.length
    ? `<div class="card">
  <h3>Focus your next attempt here</h3>
  <p class="small muted">Ranked by how many weighted points are available, not by lowest score.</p>
  <ol class="plain small">${report.focusAreas
    .map(
      (f) =>
        `<li><strong>${escapeHtml(f.criterion.name)}</strong> — ${escapeHtml(f.result.suggestion)}</li>`,
    )
    .join('')}</ol>
</div>`
    : '';

  const strengths = report.strengths.length
    ? `<div class="card">
  <h3>Holding up well</h3>
  <ul class="plain small">${report.strengths
    .map((s) => `<li>${escapeHtml(s.criterion.name)}</li>`)
    .join('')}</ul>
</div>`
    : '';

  return `<h1>${escapeHtml(problem.title)}</h1>
<p class="lede">Attempt ${attempt.attemptNumber} · scored against <code>${escapeHtml(evaluation.rubricVersionTag)}</code></p>
${partialBanner}

<div class="card">
  <div class="row">
    <div>
      <div class="score">${report.overallScore}%${
        report.isComplete ? '' : ' <span class="tag warn">provisional</span>'
      }</div>
      <div class="small muted">weighted across ${report.scored.length} of ${
        report.scored.length + report.unscored.length
      } criteria · ${report.assessedWeightShare}% of the rubric assessed</div>
    </div>
    <div style="display:flex;gap:8px">
      <a class="btn ghost" href="/history">History</a>
      <a class="btn" href="/problems/${escapeHtml(problem.slug)}">Try again</a>
    </div>
  </div>
  <p style="margin-top:12px">${escapeHtml(report.summary)}</p>
</div>

<div class="grid two">${focus}${strengths}</div>

<h2>Criterion by criterion</h2>
${report.scored.map(renderCriterion).join('')}
${
  report.unscored.length
    ? `<div class="card tight"><p class="small muted">Not assessed this run: ${report.unscored
        .map((c) => escapeHtml(c.name))
        .join(', ')}.</p></div>`
    : ''
}`;
}

function renderCriterion(scored: FeedbackReport['scored'][number]): string {
  const pct = Math.round(scored.ratio * 100);
  const barClass = scored.ratio >= 0.75 ? 'bar good' : scored.ratio < 0.5 ? 'bar bad' : 'bar';
  const sourceLabel =
    scored.result.source === 'llm'
      ? 'AI review'
      : scored.result.source === 'human'
        ? 'human review'
        : 'automated check';

  const lowConfidence =
    scored.result.confidence < 0.5
      ? `<span class="tag warn">low confidence · treat as a prompt</span>`
      : '';

  const evidence = scored.result.evidence.length
    ? scored.result.evidence.map((e) => `<blockquote>${escapeHtml(e)}</blockquote>`).join('')
    : `<p class="small muted">No quote — this criterion is about something absent from the submission.</p>`;

  return `<article class="card">
  <div class="row">
    <h3>${escapeHtml(scored.criterion.name)}</h3>
    <div>
      <span class="tag">${sourceLabel}</span>
      ${lowConfidence}
      <strong>${scored.result.score}/${scored.result.maxScore}</strong>
    </div>
  </div>
  <div class="${barClass}"><i style="width:${pct}%"></i></div>
  <div class="small muted" style="margin-bottom:8px">weight ${scored.criterion.weight} · confidence ${scored.result.confidence}</div>

  <div class="small"><strong>Evidence from your submission</strong></div>
  ${evidence}

  ${
    scored.result.concern
      ? `<div class="small" style="margin-top:8px"><strong>Concern</strong><br>${escapeHtml(scored.result.concern)}</div>`
      : ''
  }
  ${
    scored.result.suggestion
      ? `<div class="small" style="margin-top:8px"><strong>Next attempt</strong><br>${escapeHtml(scored.result.suggestion)}</div>`
      : ''
  }
</article>`;
}

export function historyPage(progress: LearnerProgress): string {
  if (progress.history.length === 0) {
    return layout({
      title: 'My progress',
      active: '/history',
      body: `<h1>My progress</h1>
<p class="lede">No attempts yet.</p>
<a class="btn" href="/problems">Pick a problem</a>`,
    });
  }

  const rows = progress.history
    .map((entry) => {
      const status = statusTag(entry);
      const delta =
        entry.delta === null
          ? '<span class="small muted">—</span>'
          : `<span class="small delta ${entry.delta >= 0 ? 'up' : 'down'}">${entry.delta >= 0 ? '+' : ''}${entry.delta}</span>`;

      return `<tr>
  <td><a href="/attempts/${escapeHtml(entry.attempt.id)}">${escapeHtml(entry.problem.title)}</a><br><span class="small muted">attempt ${entry.attempt.attemptNumber}</span></td>
  <td>${status}</td>
  <td>${entry.score === null ? '<span class="muted">—</span>' : `<strong>${entry.score}%</strong>`}</td>
  <td>${delta}</td>
  <td class="small muted">${escapeHtml(entry.attempt.startedAt.toISOString().slice(0, 16).replace('T', ' '))}</td>
</tr>`;
    })
    .join('');

  const perProblem = progress.perProblem
    .map(
      (p) => `<article class="card tight">
  <div class="row">
    <div>
      <strong>${escapeHtml(p.problem.title)}</strong>
      <div class="small muted">${p.attemptCount} attempt(s)${p.bestScore !== null ? ` · best ${p.bestScore}%` : ''}</div>
    </div>
    <div class="spark">${p.trend
      .map((s) => `<i style="height:${Math.max(3, Math.round((s / 100) * 22))}px" title="${s}%"></i>`)
      .join('')}</div>
  </div>
</article>`,
    )
    .join('');

  return layout({
    title: 'My progress',
    active: '/history',
    body: `<h1>My progress</h1>
<p class="lede">Attempts are kept so improvement is visible — the point is the second attempt, not the first.</p>
${renderRecurringBanner(progress)}

<h2>Per problem</h2>
<div class="grid two">${perProblem}</div>

<h2>All attempts</h2>
<div class="card">
  <table>
    <thead><tr><th>Problem</th><th>Status</th><th>Score</th><th>Change</th><th>Started</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`,
  });
}

function statusTag(entry: AttemptHistoryEntry): string {
  switch (entry.attempt.status) {
    case 'Completed':
      return entry.evaluation?.partial
        ? '<span class="tag warn">partial</span>'
        : '<span class="tag good">completed</span>';
    case 'Failed':
      return '<span class="tag bad">failed</span>';
    case 'Draft':
      return '<span class="tag">draft</span>';
    default:
      return '<span class="tag">evaluating</span>';
  }
}

/**
 * The cross-attempt weakness callout.
 *
 * This is the piece the research said was missing elsewhere: a learner told the
 * same thing four times has usually not noticed it was the same thing.
 */
function renderRecurringBanner(progress: LearnerProgress): string {
  if (progress.recurringWeaknesses.length === 0) return '';
  const items = progress.recurringWeaknesses
    .map(
      (w) =>
        `<li><strong>${escapeHtml(w.criterion.name)}</strong> — weak in ${w.weakCount} of your last ${w.consideredCount} evaluations. ${escapeHtml(
          w.latestSuggestion,
        )}</li>`,
    )
    .join('');

  return `<div class="banner warn">
  <strong>This keeps coming back</strong>
  <ul class="plain small" style="margin:6px 0 0">${items}</ul>
</div>`;
}
