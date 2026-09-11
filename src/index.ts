import express from 'express';
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
 *
 * The mount below is the part that looks redundant and is not. Vercel's
 * detection reads *this file* for an `express` import; re-exporting an app from
 * a module that imports express fails the build with "No entrypoint found which
 * imports express". Mounting the real app under a bare instance satisfies that
 * by actually using express here, rather than leaving a decorative import that
 * a later tidy-up would delete and break the deploy. One router dispatch is the
 * whole cost.
 *
 * Routes are unaffected: the app mounts at the root and every redirect it issues
 * is an absolute path.
 */
const app = buildContainer();

const server = express();
server.use(createServer(app));

export default server;
