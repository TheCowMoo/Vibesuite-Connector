import type { FastifyInstance } from 'fastify';
import { createList, listLists, getList, saveListResult, deleteList } from '../../domain/listStore';
import { getAiSettings } from '../../domain/aiSettings';
import { getAllKnowledge } from '../../domain/knowledgeStore';
import { retrieveContext } from '../../domain/retrieval';
import { generateJson } from '../../lib/ai';

export async function listRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/lists', async () => {
    return { lists: await listLists() };
  });

  app.post('/api/lists', async (req, reply) => {
    const b = req.body as { name?: string; content?: string; criteria?: string };
    if (!b.content) {
      reply.code(400).send({ error: 'content is required' });
      return;
    }
    const rec = await createList(b.name || 'Untitled list', b.content, b.criteria || '');
    return { list: rec };
  });

  app.get('/api/lists/:id', async (req, reply) => {
    const rec = await getList((req.params as { id: string }).id);
    if (!rec) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    return { list: rec };
  });

  app.post('/api/lists/:id/segment', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = await getList(id);
    if (!rec) {
      reply.code(404).send({ error: 'not found' });
      return;
    }

    const settings = await getAiSettings();
    if (!settings || !settings.apiKey) {
      reply.code(400).send({ error: 'AI not configured. Set it in Settings → AI.' });
      return;
    }

    const kb = await getAllKnowledge();
    const context = retrieveContext(kb, `${rec.criteria} ${rec.name}`);

    const system =
      'You are a lead list segmentation engine. Segment the provided list into distinct, well-named groups. Return ONLY JSON in this shape: {"segments":[{"name":"...","reason":"...","rows":[...]}]}. Every row must appear in exactly one segment.';
    const prompt = `Knowledge base context:\n${context || '(none)'}\n\nSegmentation criteria: ${rec.criteria || '(no criteria — use your best judgment)'}\n\nList data:\n${rec.content}`;

    try {
      const result = await generateJson(settings, system, prompt);
      await saveListResult(id, result);
      return { ok: true, result };
    } catch (err) {
      reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/lists/:id', async (req) => {
    await deleteList((req.params as { id: string }).id);
    return { ok: true };
  });
}
