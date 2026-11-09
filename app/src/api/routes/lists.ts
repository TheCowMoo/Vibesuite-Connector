import type { FastifyInstance } from 'fastify';
import { createList, listLists, getList, saveListResult, deleteList } from '../../domain/listStore';
import { getAiSettings } from '../../domain/aiSettings';
import { getAllKnowledge } from '../../domain/knowledgeStore';
import { retrieveContext } from '../../domain/retrieval';
import {
  assertSegmentable,
  buildSegmentPrompt,
  listDataRows,
  mergeIndexedSegments,
  SegmentationFormatError,
  SegmentationInputError,
  SEGMENT_SYSTEM_PROMPT,
} from '../../domain/listSegment';
import { AiJsonError, generateJson } from '../../lib/ai';
import { logger } from '../../lib/logger';

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

    const rows = listDataRows(rec.content);
    try {
      assertSegmentable(rows, rec.content.length);
    } catch (err) {
      if (err instanceof SegmentationInputError) {
        reply.code(400).send({ error: err.message });
        return;
      }
      throw err;
    }

    const settings = await getAiSettings();
    if (!settings || !settings.apiKey) {
      reply.code(400).send({ error: 'AI not configured. Set it in Settings → AI.' });
      return;
    }

    const kb = await getAllKnowledge();
    const context = retrieveContext(kb, `${rec.criteria} ${rec.name}`);
    const prompt = buildSegmentPrompt({ rows, criteria: rec.criteria, context });

    try {
      const raw = await generateJson<unknown>(settings, SEGMENT_SYSTEM_PROMPT, prompt, {
        maxTokens: 8192,
        jsonMode: true,
      });
      const result = mergeIndexedSegments(raw, rows);
      await saveListResult(id, result);
      return { ok: true, result };
    } catch (err) {
      if (err instanceof AiJsonError || err instanceof SegmentationFormatError) {
        logger.warn({ err, listId: id }, 'list segmentation returned an unusable AI response');
        reply.code(502).send({
          error:
            'The AI returned an incomplete segmentation. Try again, choose a model with a larger output limit, or split the list into smaller lists.',
        });
        return;
      }
      logger.error({ err, listId: id }, 'list segmentation failed');
      const detail = ((err as Error).message || 'unknown error').replace(/([?&](?:key|api_key)=)[^&\s]+/gi, '$1***');
      reply.code(502).send({ error: `The AI could not sort this list: ${detail}` });
    }
  });

  app.delete('/api/lists/:id', async (req) => {
    await deleteList((req.params as { id: string }).id);
    return { ok: true };
  });
}
