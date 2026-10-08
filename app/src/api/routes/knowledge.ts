import type { FastifyInstance } from 'fastify';
import { addKnowledge, listKnowledge, deleteKnowledge } from '../../domain/knowledgeStore';

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/knowledge', async () => {
    return { docs: await listKnowledge() };
  });

  app.post('/api/knowledge', async (req, reply) => {
    const b = req.body as { name?: string; content?: string };
    if (!b.content) {
      reply.code(400).send({ error: 'content is required' });
      return;
    }
    const doc = await addKnowledge(b.name || 'Untitled document', b.content);
    return { ok: true, id: doc.id };
  });

  app.delete('/api/knowledge/:id', async (req) => {
    await deleteKnowledge((req.params as { id: string }).id);
    return { ok: true };
  });
}
