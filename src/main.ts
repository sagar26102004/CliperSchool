import { buildContainer } from './container.js';
import { createServer } from './web/server.js';

const port = Number(process.env['PORT'] ?? 3000);
const app = buildContainer();
const server = createServer(app);

server.listen(port, () => {
  const mode =
    app.llmClientId === 'anthropic'
      ? 'live Claude (ANTHROPIC_API_KEY detected)'
      : `offline stub (LLM_FAILURE_MODE=${process.env['LLM_FAILURE_MODE'] ?? 'off'})`;

  console.log(`LLD Practice Platform  ->  http://localhost:${port}`);
  console.log(`AI evaluator: ${mode}`);
  console.log('Storage: in-memory — attempt history resets when this process stops.');
});
