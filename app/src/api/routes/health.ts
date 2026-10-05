import type { FastifyInstance } from 'fastify';
import { redis } from '../../queue/connection';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await redis.ping();
      reply.send({ status: 'ready' });
    } catch {
      reply.code(503).send({ status: 'not_ready', error: 'redis unavailable' });
    }
  });
}
