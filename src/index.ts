import { buildContainer } from './container.js';
import { createServer } from './web/server.js';

/**
 * Vercel entry point.
 *
 * Vercel discovers an Express app by looking for `app`, `index` or `server` at
 * the project root or under `src/`, and expects the app itself as the default
 * export rather than a started listener. So this file builds the container once
 * per instance and exports the app; `src/main.ts` remains the local entry that
 * calls `listen()`.
 *
 * Building the container at module scope is deliberate: on a warm instance the
 * seeded problems and the rubric are constructed once and reused across
 * requests. Nothing mutable lives here — with Redis configured, all learner
 * state is in the store, so it makes no difference which instance serves a
 * request.
 */
const app = buildContainer();

export default createServer(app);
