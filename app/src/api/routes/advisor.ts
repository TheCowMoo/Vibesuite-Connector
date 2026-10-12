import type { FastifyInstance } from 'fastify';
import {
  analyzeAdvisor,
  applyRecommendation,
  askAdvisor,
  dismissRecommendation,
  getAdvisorState,
} from '../../domain/advisor';
import { getAuthUser, requireRole } from '../middleware/requireAuth';

function actorOf(req: unknown): string | undefined {
  const user = getAuthUser(req as never) as { email?: string } | undefined;
  return user?.email;
}

export async function advisorRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: requireRole('owner', 'admin') };

  app.get('/api/advisor', async () => getAdvisorState());

  app.post('/api/advisor/analyze', guard, async (_req, reply) => {
    try {
      return { ok: true, analysis: await analyzeAdvisor() };
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
      return;
    }
  });

  app.post('/api/advisor/recommendations/:id/apply', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await applyRecommendation(id, actorOf(req));
    if (!res.ok) {
      reply.code(400).send({ error: res.error });
      return;
    }
    return { ...res, state: await getAdvisorState() };
  });

  app.post('/api/advisor/recommendations/:id/dismiss', guard, async (req, reply) => {
    const res = await dismissRecommendation((req.params as { id: string }).id);
    if (!res.ok) {
      reply.code(400).send({ error: res.error });
      return;
    }
    return res;
  });

  /** Grounded, ephemeral — grounded on the stored snapshot, never persisted. */
  app.post('/api/advisor/ask', guard, async (req, reply) => {
    const body = (req.body || {}) as { question?: string };
    try {
      return { ok: true, ...(await askAdvisor(String(body.question ?? ''))) };
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
      return;
    }
  });
}
