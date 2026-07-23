/**
 * GET /api/provider — the latest dual-provider evaluation (#dual-provider).
 *
 * Returns which marketplace the controller would rent from this tick, both
 * effective (submitted) prices, both fee-adjusted costs, NiceHash's %
 * advantage, and the switch reason. `null` when dual-provider evaluation is
 * disabled or no tick has evaluated yet. Read-only; reflects the DRY-RUN
 * observation only.
 */

import type { FastifyInstance } from 'fastify';

import type { HttpServerDeps } from '../server.js';

export async function registerProviderRoute(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  app.get('/api/provider', async () => {
    return deps.controller.getProviderEvaluation();
  });
}
