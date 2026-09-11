import { buildContainer } from './container.js';
import { createServer } from './web/server.js';

const port = Number(process.env['PORT'] ?? 3000);
const app = buildContainer();
const server = createServer(app);

server.listen(port, () => {
  const mode =
    app.llmClientId === 'anthropic'
      ? 'live Claude (ANTHROPIC_API_KEY detected)'
      : app.llmClientId === 'gemini'
        ? `live Gemini, ${process.env['LLM_MODEL'] ?? 'gemini-3.6-flash'} (GEMINI_API_KEY detected)`
        : app.llmClientId === 'openai-compatible'
          ? `live ${process.env['LLM_MODEL']} via ${process.env['LLM_BASE_URL']}`
          : `offline stub (LLM_FAILURE_MODE=${process.env['LLM_FAILURE_MODE'] ?? 'off'})`;

  const storage =
    app.storageId === 'redis'
      ? 'Redis — attempt history survives a restart.'
      : 'in-memory — attempt history resets when this process stops.';

  console.log(`LLD Practice Platform  ->  http://localhost:${port}`);
  console.log(`AI evaluator: ${mode}`);
  console.log(`Storage: ${storage}`);
});
