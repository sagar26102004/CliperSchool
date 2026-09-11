/**
 * Server-rendered views.
 *
 * Plain template functions returning HTML strings, with no client build step and
 * no framework. The assignment weights domain design far above UI, and a React
 * toolchain would have consumed hours that the evaluation model needed more.
 * What the UI does have to do is make the design decisions visible: every
 * criterion shows its source, its evidence and its confidence, because a score
 * the learner cannot interrogate is the exact failure mode this product exists
 * to avoid.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Preserves author line breaks in learner-written prose. */
export function paragraphs(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replaceAll('\n', '<br>')}</p>`)
    .join('');
}

export function layout(params: {
  title: string;
  body: string;
  active?: string;
  head?: string;
}): string {
  const nav = [
    { href: '/problems', label: 'Problems' },
    { href: '/history', label: 'My progress' },
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(params.title)} · LLD Practice</title>
<style>${STYLES}</style>
${params.head ?? ''}
</head>
<body>
<header class="site">
  <a class="brand" href="/problems">LLD<span>Practice</span></a>
  <nav>
    ${nav
      .map(
        (item) =>
          `<a href="${item.href}"${params.active === item.href ? ' class="on"' : ''}>${escapeHtml(item.label)}</a>`,
      )
      .join('')}
  </nav>
</header>
<main>${params.body}</main>
</body>
</html>`;
}

const STYLES = `
:root {
  --bg: #fbfaf8;
  --panel: #ffffff;
  --ink: #1c1d22;
  --muted: #64656e;
  --line: #e3e1dc;
  --accent: #3a5f9e;
  --good: #2f6f4f;
  --warn: #8a5a1a;
  --bad: #9a3b3b;
  --radius: 10px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
header.site {
  display: flex; align-items: center; gap: 24px;
  padding: 14px 28px; background: var(--panel); border-bottom: 1px solid var(--line);
}
.brand { font-weight: 700; text-decoration: none; color: var(--ink); letter-spacing: -0.02em; }
.brand span { color: var(--accent); margin-left: 3px; }
header nav { display: flex; gap: 18px; }
header nav a { color: var(--muted); text-decoration: none; font-size: 14px; }
header nav a.on, header nav a:hover { color: var(--ink); }
main { max-width: 940px; margin: 0 auto; padding: 28px 20px 72px; }
h1 { font-size: 26px; letter-spacing: -0.02em; margin: 0 0 6px; }
h2 { font-size: 18px; margin: 32px 0 12px; }
h3 { font-size: 15px; margin: 0 0 6px; }
p { margin: 0 0 10px; }
a { color: var(--accent); }
.lede { color: var(--muted); margin-bottom: 24px; }
.card {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 18px 20px; margin-bottom: 14px;
}
.card.tight { padding: 14px 16px; }
.grid { display: grid; gap: 14px; }
@media (min-width: 720px) { .grid.two { grid-template-columns: 1fr 1fr; } }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
ul.plain { margin: 0 0 10px; padding-left: 18px; }
ul.plain li { margin-bottom: 4px; }
.tag {
  display: inline-block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
  padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted);
  background: #f6f5f2;
}
.tag.good { color: var(--good); border-color: #cfe3d7; background: #f1f8f4; }
.tag.warn { color: var(--warn); border-color: #ecdcc2; background: #fdf7ee; }
.tag.bad { color: var(--bad); border-color: #eccfcf; background: #fdf2f2; }
.btn {
  display: inline-block; background: var(--accent); color: #fff; border: 0;
  padding: 9px 16px; border-radius: 8px; font-size: 14px; text-decoration: none; cursor: pointer;
}
.btn.ghost { background: transparent; color: var(--accent); border: 1px solid var(--line); }
.btn:disabled { opacity: 0.5; cursor: default; }
label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.hint { color: var(--muted); font-size: 12.5px; font-weight: 400; margin-bottom: 6px; }
input[type=text], textarea, select {
  width: 100%; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 7px; font: inherit; background: #fff; color: var(--ink);
}
textarea { resize: vertical; min-height: 68px; }
fieldset { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; margin: 0 0 14px; }
legend { font-weight: 600; font-size: 13px; padding: 0 6px; }
.typerow, .relrow { display: grid; gap: 8px; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px dashed var(--line); }
@media (min-width: 720px) {
  .typerow { grid-template-columns: 1.1fr 0.8fr 2fr; align-items: start; }
  .relrow { grid-template-columns: 1fr 0.7fr 1fr; align-items: start; }
}
.score { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
.bar { height: 6px; background: #eeece7; border-radius: 999px; overflow: hidden; margin: 6px 0 2px; }
.bar > i { display: block; height: 100%; background: var(--accent); }
.bar.good > i { background: var(--good); }
.bar.bad > i { background: var(--bad); }
blockquote {
  margin: 8px 0; padding: 7px 12px; border-left: 3px solid var(--line);
  background: #faf9f7; color: #3a3b42; font-size: 13.5px; border-radius: 0 6px 6px 0;
}
.banner { border-radius: var(--radius); padding: 12px 16px; margin-bottom: 16px; font-size: 14px; }
.banner.info { background: #eef3fb; border: 1px solid #d3e0f2; }
.banner.warn { background: #fdf7ee; border: 1px solid #ecdcc2; }
.banner.bad { background: #fdf2f2; border: 1px solid #eccfcf; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.spark { display: inline-flex; align-items: flex-end; gap: 2px; height: 22px; }
.spark i { width: 7px; background: var(--accent); border-radius: 2px 2px 0 0; display: block; }
.delta.up { color: var(--good); }
.delta.down { color: var(--bad); }
`;
