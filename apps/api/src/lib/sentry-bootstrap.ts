/**
 * Side-effect-only module: imported as the VERY FIRST line of apps/api/src/
 * index.ts so that `./sentry.js` top-level `initSentry()` runs before any
 * other module pulls in `node:http` / Hono / @hono/node-server. Sentry's
 * httpIntegration patches the global http module on import; if anything else
 * loads first, its handlers don't get auto-instrumented.
 *
 * Keep this file empty other than the import — the whole point is the side
 * effect ordering. Adding logic here defeats it.
 */

import './sentry.js';
