import type { FastifyInstance } from 'fastify';
import { renderMetrics } from '../../lib/metrics';

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(renderMetrics());
  });
}